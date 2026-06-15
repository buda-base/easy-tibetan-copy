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
    await py.loadPackage(['PyMuPDF', 'fonttools', 'micropip', 'lxml', 'typing-extensions']);
    post('progress', { phase: 'installing' });
    await py.runPythonAsync(`
import micropip
await micropip.install("${WHEEL}")
await micropip.install("python-docx", deps=False)
import pdf_cmap_fix
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
for p in range(d.page_count):
    for f in d.get_page_fonts(p):
        name = f[3]
        if name and name not in seen:
            seen.add(name); fonts.append(name)
json.dumps({"page_count": d.page_count, "fonts": fonts})
`);
  return JSON.parse(json);
}

async function fix() {
  post('progress', { phase: 'working' });
  const stats = await py.runPythonAsync(`
import json, pdf_cmap_fix
res = pdf_cmap_fix.patch_pdf("/in.pdf", output_path="/out.pdf", write_file=True)
json.dumps(res.get("stats", {}), default=str)
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
import json, pymupdf, pdf_cmap_fix
from docx import Document
from docx.shared import Pt
from docx.oxml.ns import qn

CS_FONT = "Jomolhari"   # Unicode Tibetan font for the .docx complex-script slot

def _attrs(span):
    flags = span.get("flags", 0) or 0
    name = (span.get("font") or "").lower()
    bold = bool(flags & 16) or "bold" in name
    italic = bool(flags & 2) or "italic" in name or "oblique" in name
    size = round(float(span.get("size") or 0), 1)
    return bold, italic, size

def _set_cs(run, name):
    # Word renders Tibetan via the complex-script (w:cs) font slot.
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn('w:rFonts'))
    if rfonts is None:
        from docx.oxml import OxmlElement
        rfonts = OxmlElement('w:rFonts'); rpr.append(rfonts)
    rfonts.set(qn('w:cs'), name)

pdf_cmap_fix.patch_pdf("/in.pdf", output_path="/patched.pdf", write_file=True)
d = pymupdf.open("/patched.pdf")
n = d.page_count
sel = list(range(n))
if _PAGES == 'odd':   sel = [i for i in sel if i % 2 == 0]   # 1-based odd  -> indices 0,2,4...
elif _PAGES == 'even': sel = [i for i in sel if i % 2 == 1]  # 1-based even -> indices 1,3,5...

doc = Document()
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
                t = span.get("text", "")
                if not t:
                    continue
                b, it, sz = _attrs(span)
                run_list.append({"t": t, "s": sz, "b": b, "i": it})
                r = para.add_run(t)
                r.bold = b; r.italic = it
                if sz: r.font.size = Pt(sz)
                _set_cs(r, CS_FONT)
                plain.append(t)
                non_empty = True
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
