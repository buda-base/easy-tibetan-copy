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
import os, re, shutil, pdf_cmap_fix, pymupdf

# Escalation over the two GID lookup trees bundled in the wheel. The default gid
# tree runs first; if its patched output still extracts non-Tibetan "junk"
# (legacy fonts that map glyphs into e.g. the Thai block — issue #16), retry with
# the PUA-free tree and keep whichever output has the least junk, then the most
# Tibetan. This mirrors the upstream auto-strategy picker, scoped to the two
# trees we can afford to ship to the browser.
_PUA_FREE = pdf_cmap_fix.FONT_LOOKUP_DIR.parent / "font_lookup_gid_pua_free"
_CTRL_PICS = re.compile("[\\u2400-\\u2422\\u2424]")
_SUBSET_PREFIX = re.compile(r"^[A-Z]{6}\\+")

def _is_hard_junk(cp):
    # Junk is deliberately narrow: only codepoints that cannot come from
    # legitimate text. Counting every non-Tibetan codepoint above 0x7F made
    # every PDF mixing Tibetan with English or Sanskrit report as "partially
    # repaired" — Sanskrit diacritics, curly quotes and em-dashes are normal.
    return (0xE000 <= cp <= 0xF8FF     # Private Use Area
            or 0x0E00 <= cp <= 0x0E7F  # Thai block — the issue #16 signature
            or cp == 0xFFFD)

def _clean(s):
    # Legacy fonts map their space glyph to U+2423 OPEN BOX and the /ToUnicode
    # carries it through; the extraction path already undoes this.
    return _CTRL_PICS.sub("", s.replace("\\u2423", " "))

def _score_pdf(path):
    # Returns (tibetan, hard junk, sample). The sample is the first 3 lines
    # carrying Tibetan, capped at 200 chars — collected in this same pass, so
    # the R3 report costs no extra extraction.
    d = pymupdf.open(path)
    tib = junk = 0
    sample = []
    for p in range(d.page_count):
        for line in _clean(d[p].get_text()).split("\\n"):
            has_tib = False
            for c in line:
                o = ord(c)
                if 0x0F00 <= o <= 0x0FFF:
                    tib += 1; has_tib = True
                elif _is_hard_junk(o):
                    junk += 1
            if has_tib and len(sample) < 3 and line.strip():
                sample.append(line.strip())
    d.close()
    return tib, junk, "\\n".join(sample)[:200]

def _junk_fonts(path):
    # Needs the dict extraction, which is heavier than get_text(). Callers run
    # this only when junk was actually found, so a clean file never pays for it.
    d = pymupdf.open(path)
    names = set()
    for p in range(d.page_count):
        for blk in d[p].get_text("dict").get("blocks", []):
            if blk.get("type", 0) != 0:
                continue
            for line in blk.get("lines", []):
                for span in line.get("spans", []):
                    if any(_is_hard_junk(ord(c)) for c in _clean(span.get("text", ""))):
                        names.add(_SUBSET_PREFIX.sub("", span.get("font") or "?"))
    d.close()
    return sorted(names)

def _patch_best(src, dst):
    res = pdf_cmap_fix.patch_pdf(src, output_path=dst, write_file=True)
    stats = dict(res.get("stats", {}))
    tib, junk, sample = _score_pdf(dst)
    strategy = "gid"
    if junk > 0 and _PUA_FREE.is_dir():
        cand = "/_cand_pua.pdf"
        res2 = pdf_cmap_fix.patch_pdf(src, output_path=cand, write_file=True,
                                      font_lookup_dir=_PUA_FREE)
        tib2, junk2, sample2 = _score_pdf(cand)
        # Prefer the output with the least junk, breaking ties on most Tibetan.
        if (junk2, -tib2) < (junk, -tib):
            shutil.copyfile(cand, dst)
            stats = dict(res2.get("stats", {}))
            tib, junk, sample, strategy = tib2, junk2, sample2, "gid-pua-free"
        try:
            os.unlink(cand)
        except OSError:
            pass
    stats["tibetan_chars"] = tib
    stats["junk_chars"] = junk
    stats["sample"] = sample
    stats["junk_fonts"] = _junk_fonts(dst) if junk > 0 else []
    stats["strategy"] = strategy
    return stats

_PATCH_CACHE = {}

def _ensure_patched():
    # fix and extract are the same patch operation. Doing it once means
    # fix -> extract, and switching page filters, cost nothing extra.
    if not _PATCH_CACHE:
        _PATCH_CACHE.update(_patch_best("/in.pdf", "/patched.pdf"))
    return dict(_PATCH_CACHE)

TIB_FONT = "Jomolhari"        # Unicode Tibetan font for Tibetan runs
LATIN_FONT = "Times New Roman" # everything else

# Legacy Tibetan fonts pack glyphs across the full single-byte range, so PyMuPDF
# can hand back NUL/control chars that python-docx (lxml) refuses to serialize.
# Strip everything XML 1.0 forbids, keeping tab / newline / carriage-return.
_XML_BAD = re.compile('[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\ufffe\\uffff]')

def _xml_clean(s):
    # _clean (defined above) already turns the Control-Pictures open-box
    # glyph back into a space and drops the other control-picture stand-ins.
    return _clean(_XML_BAD.sub('', s))

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
    # font whichever way it classifies the characters. python-docx is
    # deliberately not installed in the venv that execs this boot block in
    # tests/test_worker_matches_junk_metric.py, so the import stays local to
    # this function -- it only runs in the browser, after boot's micropip
    # install of python-docx above.
    from docx.oxml.ns import qn
    run.font.name = name
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn('w:rFonts'))
    if rfonts is None:
        from docx.oxml import OxmlElement
        rfonts = OxmlElement('w:rFonts'); rpr.append(rfonts)
    for a in ('w:ascii', 'w:hAnsi', 'w:cs'):
        rfonts.set(qn(a), name)

def _build_docx(d, sel, out_path):
    # Same reason as _set_font: keep python-docx out of the module-level
    # imports so this boot block still execs without it installed.
    from docx import Document
    from docx.shared import Pt
    doc = Document()
    doc.styles['Normal'].font.name = LATIN_FONT   # avoid the Cambria default
    for pi in sel:
        for blk in d[pi].get_text("dict").get("blocks", []):
            if blk.get("type", 0) != 0:
                continue  # skip image blocks
            lines = blk.get("lines", [])
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
                    # spans; one docx run (+ font element) per span is what
                    # makes a 265-page book take minutes to serialise.
                    if (run_list and run_list[-1]["b"] == b and run_list[-1]["i"] == it
                            and run_list[-1]["s"] == sz and run_list[-1]["tib"] == tib):
                        run_list[-1]["t"] += t
                    else:
                        run_list.append({"t": t, "s": sz, "b": b, "i": it, "tib": tib})
                    non_empty = True
                for m in run_list:
                    r = para.add_run(m["t"])
                    r.bold = m["b"]; r.italic = m["i"]
                    if m["s"]: r.font.size = Pt(m["s"])
                    _set_font(r, TIB_FONT if m["tib"] else LATIN_FONT)
                if li < len(lines) - 1:
                    para.add_run().add_break()
            if not non_empty:
                para._element.getparent().remove(para._element)
    doc.save(out_path)
`);
    post('progress', { phase: 'ready' });
    return py;
  })();
  return booting;
}

// analyze is the ONLY permitted writer of /in.pdf. _PATCH_CACHE is keyed on
// nothing but "a patch has been computed", so it is correct only while that
// holds: any other code path that writes /in.pdf must clear _PATCH_CACHE (and
// unlink /patched.pdf) the way this function does, or fix/extract/docx will
// keep serving the previous document's patch.
async function analyze(bytes) {
  await boot();
  py.FS.writeFile('/in.pdf', bytes);
  // A new document invalidates the memoised patch from the previous one.
  await py.runPythonAsync(`
import os
_PATCH_CACHE.clear()
try:
    os.unlink("/patched.pdf")
except OSError:
    pass
`);
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
  // _ensure_patched runs gid, then escalates to the PUA-free tree if the output
  // still extracts hard junk, and memoises the result. junk_chars drives the
  // honest verdict: 0 = clean, > 0 = some runs still copy as garbage.
  const stats = await py.runPythonAsync(`
import json
json.dumps(_ensure_patched(), default=str)
`);
  const out = py.FS.readFile('/patched.pdf');
  return { stats: JSON.parse(stats), pdfBytes: out };
}

async function extract() {
  post('progress', { phase: 'working' });
  // _ensure_patched (from the boot block) is shared with fix(), so switching
  // page filters or re-running extract after a fix costs nothing extra.
  // Extract a formatting-aware model: blocks (paragraphs) -> lines -> runs
  // {t,s,b,i,tib}, each block tagged with the page it came from so the UI
  // can filter client-side. No .docx here -- most users never download one,
  // so building it eagerly on every extract charged everyone for a rare
  // action. buildDocx() below builds it on demand instead.
  const metaJson = await py.runPythonAsync(`
import json, pymupdf

_ensure_patched()
d = pymupdf.open("/patched.pdf")
n = d.page_count
sel = list(range(n))

blocks_out = []
plain = []
for pi in sel:
    for blk in d[pi].get_text("dict").get("blocks", []):
        if blk.get("type", 0) != 0:
            continue  # skip image blocks
        lines = blk.get("lines", [])
        disp_lines = []
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
                # spans; one run per span made the on-screen model huge on a
                # 265-page book.
                if (run_list and run_list[-1]["b"] == b and run_list[-1]["i"] == it
                        and run_list[-1]["s"] == sz and run_list[-1]["tib"] == tib):
                    run_list[-1]["t"] += t
                else:
                    run_list.append({"t": t, "s": sz, "b": b, "i": it, "tib": tib})
                plain.append(t)
            if li < len(lines) - 1:
                plain.append("\\n")
            if run_list:
                disp_lines.append(run_list)
        plain.append("\\n")
        if disp_lines:
            blocks_out.append({"page": pi, "lines": disp_lines})

d.close()
globals()['_TXT'] = "".join(plain)
json.dumps({"page_count": n, "blocks": blocks_out})
`);
  const text = String(py.globals.get('_TXT'));
  return { ...JSON.parse(metaJson), text };
}

// The .docx is serialised in Python, so a page filter cannot be applied in the
// browser the way the on-screen text can. Build it on demand — the only path
// to a .docx now, per the owner: most users never download one, so extract()
// no longer builds one eagerly on every call. _ensure_patched() (rather than
// opening /patched.pdf directly) covers a docx request arriving before any
// extract/fix has run for the currently loaded document -- analyze() unlinks
// /patched.pdf on load, so without this call this would raise instead of
// producing the file.
async function buildDocx(pages) {
  post('progress', { phase: 'working' });
  py.globals.set('_PAGES', pages || 'all');
  await py.runPythonAsync(`
_ensure_patched()
d = pymupdf.open("/patched.pdf")
sel = list(range(d.page_count))
if _PAGES == 'odd':    sel = [i for i in sel if i % 2 == 0]   # 1-based odd  -> 0,2,4...
elif _PAGES == 'even': sel = [i for i in sel if i % 2 == 1]   # 1-based even -> 1,3,5...
_build_docx(d, sel, "/out.docx")
d.close()
`);
  const docxBytes = py.FS.readFile('/out.docx');
  py.FS.unlink('/out.docx');
  return { docxBytes };
}

// Every reply echoes the id of the request that produced it. The UI settles a
// promise only on a matching id, so a slow reply (a .docx build runs for minutes
// on a large book) can never resolve a request made after it.
self.onmessage = async (e) => {
  const m = e.data;
  const id = m.id;
  try {
    if (m.type === 'boot') { await boot(); return; }
    if (m.type === 'analyze') { return post('analyzed', { id, ...(await analyze(new Uint8Array(m.bytes))) }); }
    if (m.type === 'fix')     { const r = await fix();          return post('fixed', { id, ...r }, [r.pdfBytes.buffer]); }
    if (m.type === 'extract') { const r = await extract(); return post('extracted', { id, ...r }); }
    if (m.type === 'docx')    { const r = await buildDocx(m.pages); return post('docx-built', { id, ...r }, [r.docxBytes.buffer]); }
  } catch (err) {
    post('error', { id, message: (err && err.message) ? err.message : String(err) });
  }
};
