# Decisions

## 2026-06-14 — Backend framework: FastAPI + Uvicorn
**Chosen:** FastAPI serving both the JSON API and the static frontend.
**Alternatives:** Flask, Django, a Node backend calling Python as a subprocess.
**Why:** All the heavy lifting (PyMuPDF, pdf-cmap-fix, pytiblegenc) is Python, so the
backend must be Python. FastAPI is async (needed for the queue), modern, minimal, and
can serve the static SPA directly — no second process. Blocking PDF work runs in a
thread pool (`run_in_executor`) so the event loop and queue stay responsive.
**Trade-offs:** Async adds a little conceptual overhead vs Flask.
**Revisit if:** We need multi-worker horizontal scaling (the in-process queue is per-process).

## 2026-06-14 — Call the libraries in-process, never shell out
**Chosen:** `from pdf_cmap_fix import patch_pdf`; `patch_pdf(path, write_file=False)`
returns `pdf_bytes` in memory. Extraction via `pymupdf4llm.to_markdown`. Legacy
conversion via `pytiblegenc.convert_string`.
**Alternatives:** Subprocess to the `pdf-cmap-fix` CLI.
**Why:** In-process is faster, gives structured stats, and `write_file=False` keeps the
patched PDF in memory — directly supports the "no PDF on disk after download" rule.
**Trade-offs:** A crash in a library can affect the worker; mitigated by try/except per job.

## 2026-06-14 — Single-worker async queue, 50 slots, in-memory results
**Chosen:** One `asyncio.Queue(maxsize=50)` + one worker coroutine processing one job at
a time. Job state + result bytes live in an in-memory dict with a TTL sweeper.
**Alternatives:** Celery/RQ + Redis, a thread pool with N>1 workers.
**Why:** Requirement is explicitly one-PDF-at-a-time, 50 queued, then "please wait".
A broker (Redis/Celery) is overkill for a light single-instance tool. In-memory results
let us serve the download then immediately evict — satisfying "nothing kept on disk".
**Trade-offs:** State is lost on restart and not shared across processes; memory bounded
by 50 jobs × ~10MB. A TTL sweep (default 15 min) and post-download eviction bound it.
**Revisit if:** The tool needs to survive restarts or run multi-instance.

## 2026-06-14 — Disk hygiene: temp file only during processing
**Chosen:** Uploaded bytes are written to a `NamedTemporaryFile` (the libs need a real
path), processed, and the temp file is deleted in a `finally` immediately after. Results
are held only in memory and evicted after download.
**Why:** pdf-cmap-fix / pymupdf4llm open by path. We minimise the on-disk window to the
processing step only and guarantee no residue after the user downloads.

## 2026-06-14 — Extraction engine: PyMuPDF4LLM (Markdown)
**Chosen:** `pymupdf4llm.to_markdown(path, pages=[...])` for the "extract data" feature.
**Alternatives:** Plain `page.get_text()` from PyMuPDF.
**Why:** PyMuPDF4LLM produces clean, structure-aware Markdown (headings, tables, reading
order) which is far more useful for copy-paste than a raw text dump, and it natively
supports a `pages` list — exactly what even/odd filtering needs.
**Trade-offs:** Slightly heavier than raw text; Markdown artifacts on some layouts.

## 2026-06-14 — Legacy Tibetan: PyMuPDF spans + pytiblegenc.convert_string
**Chosen:** Detect fonts with PyMuPDF. For conversion, extract text spans (text + font
name) with PyMuPDF and run each through `pytiblegenc.convert_string` after
`normalize_font_name`. Drop the pdfminer-based `DuffedTextConverter` path entirely.
**Alternatives:** Use pytiblegenc's `DuffedTextConverter` (pdfminer + optional FontForge).
**Why:** Keeps the whole pipeline on one PDF engine (PyMuPDF), removes the fragile
pdfminer/FontForge dependency surface, and `convert_string` is the stable, tested core of
pytiblegenc (verified: `convert_string('ACE','Esama') -> ཀགང`).
**Trade-offs:** We rely on PyMuPDF's span decoding matching the byte/cp1252 keys in the
mapping. pytiblegenc is "work in progress" — this feature is shipped as **experimental**.
**Revisit if:** Conversion quality on real legacy PDFs is poor; fall back to DuffedText.

## 2026-06-14 — Unicode PDF download: inject /ToUnicode CMaps
**Chosen:** For a legacy-font PDF, build a per-font `/ToUnicode` CMap (byte → UTF-16BE)
from the tiblegenc mapping and inject/replace it via PyMuPDF low-level xref writes, so the
rendered glyphs stay identical but copy-paste yields Unicode.
**Why:** Same philosophy as pdf-cmap-fix but for 8-bit legacy fonts. Avoids re-typesetting.
**Trade-offs:** Fonts with no existing ToUnicode need a new stream object created and
referenced; stacked-syllable clusters map one byte → multiple codepoints (handled by
UTF-16BE multi-unit values). Experimental.

## 2026-06-14 — Frontend: hand-crafted vanilla SPA, no build step
**Chosen:** Single static `web/` (HTML + CSS + JS), no framework, no bundler, served by
FastAPI.
**Alternatives:** React + Vite + Tailwind + Framer Motion.
**Why:** "Application web légère." A no-build static app is trivial to run and maintain,
loads instantly, and with a deliberate design system + CSS animations can fully achieve
the Apple/Notion aesthetic requested. No node toolchain to keep alive.
**Trade-offs:** No component ecosystem; richer interactivity is hand-written.
**Revisit if:** The UI grows enough to warrant a component framework.

## 2026-06-14 — Fix: parse tiblegenc.csv with the `csv` module
**Chosen:** Load `tiblegenc.csv` in `legacy_tibetan._load_tables` with `csv.reader`
(file opened `newline=""`), not a naive `line.split(",")`.
**Why:** The mapping file is real CSV: fields are quoted when they contain a comma or a
leading/trailing space — e.g. byte 32 maps to a single space, written `TibetanChogyal,32," "`.
A naive split kept the surrounding quotes, so byte 32 produced the literal 3-char string
`" "` instead of a space. On the user's real "Swift Path" PDF this surfaced as stray
`" "`/`" "" "` artifacts on copy-paste **and** a line of broken PUA glyphs (the mantra
`ན་མོ་གུ་རུ་ལོ་ཀེ་ཤྭ་རཱ་ཡ།`), because the mis-parsed targets corrupted the injected
`/ToUnicode` map. Proper CSV parsing fixed both (verified: 0 quotes, 0 PUA across all 168 pages).
**Trade-offs:** None — strictly more correct.

## 2026-06-14 — Extraction: also emit a .docx (pandoc, python-docx fallback)
**Chosen:** Every extraction builds a Word `.docx` alongside the preview text. Markdown
(PyMuPDF4LLM) is rendered with **pandoc** (`markdown+hard_line_breaks`) when it is on PATH,
falling back to a small `python-docx` renderer (headings / bold / italic / lists). The
plain-text legacy-Tibetan path always uses `python-docx`, one paragraph per line, so verse
structure is preserved. Served via `GET /api/jobs/{id}/download?format=docx`, then evicted
like the fixed PDF.
**Alternatives:** Client-side `.md`/`.txt` only (kept, instant); pandoc-only (not portable);
python-docx-only (loses table fidelity on Markdown).
**Why:** User asked for a `.docx` that preserves formatting. Pandoc gives the best Markdown
fidelity (headings, tables, lists) where available; python-docx guarantees the feature works
everywhere and handles the plain-text path cleanly.
**Trade-offs:** `python-docx` (+lxml) added as a dependency; pandoc is an optional system
binary. A `.docx` is built for every extraction (small cost on the single worker).

## 2026-06-14 — Delegate legacy Tibetan fully to upstream pdf-cmap-fix
**Chosen:** Upgrade to `pdf-cmap-fix` @ `007ef5b` and delete our entire legacy
implementation. `patch_pdf` now repairs legacy non-Unicode Tibetan fonts natively
(it vendors the tiblegenc tables and identifies obfuscated fonts by glyph outline),
so we removed `app/legacy_tibetan.py`, dropped the `pytiblegenc` dependency, and
removed the "Convert legacy Tibetan to Unicode" toggle — conversion is now automatic.
Extraction repairs the PDF first (`patch_pdf` in memory → temp file → PyMuPDF4LLM),
so legacy fonts come out as correct Unicode without a separate code path.
**Supersedes:** the three earlier legacy decisions — "PyMuPDF spans + pytiblegenc.convert_string",
"inject /ToUnicode CMaps", and "parse tiblegenc.csv with the csv module". Those were a
faithful reimplementation while upstream lacked the feature; the two fixes we found (CSV
quoting + building the map from the 1-byte code to cover malformed 2-byte/4-hex ToUnicode)
were reported upstream and are now fixed there. Kept in git history (commit `5374aad`) as a
reference for the upstream author.
**Why:** Avoid maintaining a parallel implementation. Upstream is the source of truth, is
maintained, and now has broader coverage (glyph-outline ID for obfuscated fonts) than our
name-based matching ever did.
**Trade-offs:** We now track an upstream commit pin; legacy coverage gaps must be fixed
upstream rather than locally. Verified zero regression on the real TibetanChogyal PDF
(0 quotes / 0 PUA across 168 pages; extraction returns correct Unicode).
**Revisit if:** We need a legacy font upstream doesn't yet handle and can't wait for a fix.

## 2026-06-14 — Go 100% client-side (server removed), drop Markdown
**Chosen:** Remove the FastAPI server entirely and run `pdf-cmap-fix` in the browser via
Pyodide 0.29.4 (bundles PyMuPDF 1.26.3 + fonttools) in a Web Worker; `micropip`-install the
pure-python `pdf-cmap-fix` wheel + `python-docx`. Static app deployed to GitHub Pages.
**Alternatives:** keep the server; reimplement the fix in JS on `mupdf.js` (WASM); hybrid
(browser for small files, server for big).
**Why:** Validated in a spike (`spike/browser-pyodide/`, see [[browser-only-pyodide-spike]]):
the real upstream code runs verbatim in-browser with quality identical to the server
(59,240 Tibetan codepoints, PUA=0 on the reference TibetanChogyal PDF). Eliminates the
server, queue, single-worker constraint and 5 MB cap; gives a real "file never leaves your
device" privacy story; free GitHub Pages hosting. Pyodide keeps upstream as the single source
of truth (no JS re-fork). Full design: `docs/superpowers/specs/2026-06-14-browser-only-port-design.md`.
**Trade-offs:** Tens of MB of WASM on first load (mitigated by a service worker cache);
**Markdown export dropped** — `pymupdf4llm` hard-requires PyMuPDF 1.27.2.3, newer than
Pyodide bundles, so text extraction uses `pdf-cmap-fix`'s own clean-Unicode extraction
(`.txt`/`.docx`); large files (>~20 MB) can OOM the tab (a 52 MB PDF peaked ~1.16 GB) so they
get a warning but are not blocked.
**Revisit if:** Pyodide bundles PyMuPDF 1.27.x (Markdown becomes portable again), or mobile
support for large files becomes a hard requirement (would need a server fallback).

## Uncertainties left for the user to confirm on return
- ~~Legacy Tibetan conversion is experimental~~ — resolved: handled automatically by
  upstream `pdf-cmap-fix`, validated on a real PDF (see the 2026-06-14 decision above).
- ~~Queue TTL (15 min) and memory ceiling assumptions.~~ — obsolete: the server (and its
  queue) was removed in the 2026-06-14 browser-only decision above. The browser memory ceiling
  is now handled by the >20 MB warning.
