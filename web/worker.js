/* Easy Tibetan Copy — Pyodide engine (Web Worker)
   Runs the real upstream pdf-cmap-fix entirely in the browser. The PDF bytes
   are passed in from the UI thread; nothing ever touches the network here
   except loading the Pyodide runtime + the wheel (cached by the service worker). */

const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.29.4/full/';
const WHEEL = new URL('./wheels/pdf_cmap_fix-0.4.0-py3-none-any.whl', self.location).href;

let py = null;
let booting = null;

function post(type, extra = {}, transfer) {
  self.postMessage({ type, ...extra }, transfer || []);
}

async function boot() {
  if (py) return py;
  if (booting) return booting;
  booting = (async () => {
    post('progress', { phase: 'booting' });
    importScripts(PYODIDE + 'pyodide.js');
    py = await self.loadPyodide({ indexURL: PYODIDE });
    post('progress', { phase: 'loading-packages' });
    await py.loadPackage(['PyMuPDF', 'fonttools', 'numpy', 'micropip', 'lxml', 'typing-extensions']);
    post('progress', { phase: 'installing' });
    await py.runPythonAsync(`
import micropip
await micropip.install("${WHEEL}")
await micropip.install("python-docx", deps=False)
import os, shutil, pdf_cmap_fix, pymupdf

# Escalation over the two GID lookup trees bundled in the wheel. The default gid
# tree runs first; if its patched output still extracts non-Tibetan "junk"
# (legacy fonts that map glyphs into e.g. the Thai block — issue #16), retry with
# the PUA-free tree and keep whichever output has the least junk, then the most
# Tibetan. This mirrors the upstream auto-strategy picker, scoped to the two
# trees we can afford to ship to the browser.
_PUA_FREE = pdf_cmap_fix.FONT_LOOKUP_DIR.parent / "font_lookup_gid_pua_free"

def _score_pdf(path):
    # Count real Tibetan vs leftover non-Tibetan-non-ASCII characters in the
    # extracted text. junk == 0 means the file now copy-pastes cleanly.
    d = pymupdf.open(path)
    tib = junk = 0
    for p in range(d.page_count):
        for c in d[p].get_text():
            o = ord(c)
            if 0x0F00 <= o <= 0x0FFF:
                tib += 1
            elif o > 0x7F:
                junk += 1
    d.close()
    return tib, junk

def _patch_best(src, dst):
    res = pdf_cmap_fix.patch_pdf(src, output_path=dst, write_file=True)
    stats = dict(res.get("stats", {}))
    tib, junk = _score_pdf(dst)
    strategy = "gid"
    if junk > 0 and _PUA_FREE.is_dir():
        cand = "/_cand_pua.pdf"
        res2 = pdf_cmap_fix.patch_pdf(src, output_path=cand, write_file=True,
                                      font_lookup_dir=_PUA_FREE)
        tib2, junk2 = _score_pdf(cand)
        # Prefer the output with the least junk, breaking ties on most Tibetan.
        if (junk2, -tib2) < (junk, -tib):
            shutil.copyfile(cand, dst)
            stats = dict(res2.get("stats", {}))
            tib, junk, strategy = tib2, junk2, "gid-pua-free"
        try:
            os.unlink(cand)
        except OSError:
            pass
    stats["tibetan_chars"] = tib
    stats["junk_chars"] = junk
    stats["strategy"] = strategy
    return stats
`);
    post('progress', { phase: 'ready' });
    return py;
  })();
  return booting;
}

async function analyze(bytes) {
  await boot();
  py.FS.writeFile('/in.pdf', bytes);
  const json = await py.runPythonAsync(`
import json, pymupdf
d = pymupdf.open("/in.pdf")
fonts, seen = [], set()
chars, has_images = 0, False
for p in range(d.page_count):
    page = d[p]
    for f in d.get_page_fonts(p):
        name = f[3]
        if name and name not in seen:
            seen.add(name); fonts.append(name)
    # Cheap scan/image detection: count non-whitespace text (early-exit once we
    # have any) and note whether the page carries raster images.
    if chars < 16:
        chars += len("".join(page.get_text().split()))
    if not has_images and page.get_images():
        has_images = True
json.dumps({"page_count": d.page_count, "fonts": fonts,
            "has_text": chars > 0, "has_images": has_images})
`);
  return JSON.parse(json);
}

async function fix() {
  post('progress', { phase: 'working' });
  // _patch_best (defined at boot) runs gid, then escalates to the PUA-free tree
  // if the output still extracts junk; it returns stats plus tibetan_chars,
  // junk_chars, and the winning strategy. junk_chars drives the honest result
  // message: "fixed" (junk 0) vs "partially repaired" (junk left).
  const stats = await py.runPythonAsync(`
import json
_stats = _patch_best("/in.pdf", "/out.pdf")
json.dumps(_stats, default=str)
`);
  const out = py.FS.readFile('/out.pdf');
  py.FS.unlink('/out.pdf');
  return { stats: JSON.parse(stats), pdfBytes: out };
}

async function extract(pages) {
  post('progress', { phase: 'working' });
  py.globals.set('_PAGES', pages || 'all');
  // Patch (so legacy fonts come out as Unicode) then extract a formatting-aware
  // model: blocks (paragraphs) -> lines -> runs {t,s,b,i}. The same model drives
  // the on-screen preview and a formatted .docx (Tibetan rendered with Jomolhari).
  const metaJson = await py.runPythonAsync(`
import json, re, pymupdf, pdf_cmap_fix
from docx import Document
from docx.shared import Pt
from docx.oxml.ns import qn

TIB_FONT = "Jomolhari"        # Unicode Tibetan font for Tibetan runs
LATIN_FONT = "Times New Roman" # everything else

# Legacy Tibetan fonts pack glyphs across the full single-byte range, so PyMuPDF
# can hand back NUL/control chars that python-docx (lxml) refuses to serialize.
# Strip everything XML 1.0 forbids, keeping tab / newline / carriage-return.
_XML_BAD = re.compile('[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\ufffe\\uffff]')
# Legacy fonts map their space glyph to a Control-Pictures symbol (U+2423 open
# box "␣"), and the /ToUnicode carries it straight through. Turn the box
# back into a real space and drop the other control-picture stand-ins.
_CTRL_PICS = re.compile('[\\u2400-\\u2422\\u2424]')
def _xml_clean(s):
    s = _XML_BAD.sub('', s)
    s = s.replace('\\u2423', ' ')
    return _CTRL_PICS.sub('', s)

def _attrs(span):
    flags = span.get("flags", 0) or 0
    name = (span.get("font") or "").lower()
    bold = bool(flags & 16) or "bold" in name
    italic = bool(flags & 2) or "italic" in name or "oblique" in name
    size = round(float(span.get("size") or 0), 1)
    return bold, italic, size

def _is_tibetan(s):
    return any(0x0F00 <= ord(c) <= 0x0FFF for c in s)

def _set_font(run, name):
    # Set every font slot (ascii/hAnsi + complex-script cs) so Word uses this
    # font whichever way it classifies the characters.
    run.font.name = name
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn('w:rFonts'))
    if rfonts is None:
        from docx.oxml import OxmlElement
        rfonts = OxmlElement('w:rFonts'); rpr.append(rfonts)
    for a in ('w:ascii', 'w:hAnsi', 'w:cs'):
        rfonts.set(qn(a), name)

# Same gid -> PUA-free escalation as the fix path, so the extracted text/.docx
# use whichever lookup tree yields the least junk (issue #16).
_patch_best("/in.pdf", "/patched.pdf")
d = pymupdf.open("/patched.pdf")
n = d.page_count
sel = list(range(n))
if _PAGES == 'odd':   sel = [i for i in sel if i % 2 == 0]   # 1-based odd  -> indices 0,2,4...
elif _PAGES == 'even': sel = [i for i in sel if i % 2 == 1]  # 1-based even -> indices 1,3,5...

doc = Document()
doc.styles['Normal'].font.name = LATIN_FONT   # avoid the Cambria default
blocks_out = []
plain = []
for pi in sel:
    for blk in d[pi].get_text("dict").get("blocks", []):
        if blk.get("type", 0) != 0:
            continue  # skip image blocks
        lines = blk.get("lines", [])
        disp_lines = []
        para = doc.add_paragraph()
        non_empty = False
        for li, line in enumerate(lines):
            run_list = []
            for span in line.get("spans", []):
                t = _xml_clean(span.get("text", ""))
                if not t:
                    continue
                b, it, sz = _attrs(span)
                tib = _is_tibetan(t)
                # Coalesce adjacent spans that share a style into one run.
                # Legacy Tibetan lines come back as dozens of single-glyph
                # spans; one docx run (+ font element) per span is what makes a
                # 265-page book take minutes to serialise in the browser.
                if (run_list and run_list[-1]["b"] == b and run_list[-1]["i"] == it
                        and run_list[-1]["s"] == sz and run_list[-1]["tib"] == tib):
                    run_list[-1]["t"] += t
                else:
                    run_list.append({"t": t, "s": sz, "b": b, "i": it, "tib": tib})
                plain.append(t)
                non_empty = True
            for m in run_list:
                r = para.add_run(m["t"])
                r.bold = m["b"]; r.italic = m["i"]
                if m["s"]: r.font.size = Pt(m["s"])
                _set_font(r, TIB_FONT if m["tib"] else LATIN_FONT)
            if li < len(lines) - 1:
                para.add_run().add_break()
                plain.append("\\n")
            if run_list:
                disp_lines.append(run_list)
        plain.append("\\n")
        if disp_lines:
            blocks_out.append({"lines": disp_lines})
        if not non_empty:
            para._element.getparent().remove(para._element)

doc.save("/out.docx")
globals()['_TXT'] = "".join(plain)
json.dumps({"page_count": n, "pages_used": len(sel), "blocks": blocks_out})
`);
  const text = String(py.globals.get('_TXT'));
  const docxBytes = py.FS.readFile('/out.docx');
  py.FS.unlink('/out.docx');
  py.FS.unlink('/patched.pdf');
  return { ...JSON.parse(metaJson), text, docxBytes };
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'boot') { await boot(); return; }
    if (m.type === 'analyze') { return post('analyzed', await analyze(new Uint8Array(m.bytes))); }
    if (m.type === 'fix')     { const r = await fix();          return post('fixed', r, [r.pdfBytes.buffer]); }
    if (m.type === 'extract') { const r = await extract(m.pages); return post('extracted', r, [r.docxBytes.buffer]); }
  } catch (err) {
    post('error', { message: (err && err.message) ? err.message : String(err) });
  }
};
