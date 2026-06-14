# Easy Tibetan Copy

*Copy, paste and search Tibetan PDFs — at last.*

A small, fast, **100% client-side** web app that repairs Tibetan PDFs so their text
copies, pastes and searches correctly. The whole fix runs in your browser via
[Pyodide](https://pyodide.org/) running OpenPecha's
[`pdf-cmap-fix`](https://github.com/OpenPecha/pdf-cmap-fix) — **your file is never
uploaded; it never leaves your device.** No server, hostable on GitHub Pages.

Many Tibetan PDFs render perfectly on screen but copy/paste and extract as gibberish,
because the embedded font's `/ToUnicode` character map is broken or missing. Easy
Tibetan Copy repairs that map so the text comes out as correct Unicode.

## What it does

- **Fix the PDF** — repairs the `/ToUnicode` CMap so copy-paste, search and
  extraction return correct Unicode. Download the fixed PDF. Pre-Unicode **legacy
  Tibetan fonts** (TibetanChogyal, Ededris/Dedris, …) are handled automatically by
  `pdf-cmap-fix` (it vendors the BDRC tiblegenc tables and identifies obfuscated fonts
  by glyph outline) — no toggle, no extra step.
- **Extract text** — pulls clean Unicode text out of the PDF, with an option to take
  **only odd or only even pages** (handy for pecha-style books printed two-up). The PDF
  is repaired first, so legacy fonts come out as correct Unicode. The on-screen preview and
  the **Word `.docx`** keep the original **font sizes, bold/italic and paragraph flow**;
  a plain **`.txt`** is also available.

## How it works

```
web/index.html        UI
web/app.js            state machine (upload → configure → process → result)
web/worker.js         Web Worker: Pyodide + pdf-cmap-fix + python-docx
web/sw.js             service worker — caches Pyodide + the wheel for fast repeat loads
web/wheels/           the pdf-cmap-fix wheel (built by scripts/build-wheel.sh; gitignored)
```

The UI thread hands the PDF bytes to a **Web Worker** running Pyodide 0.29.4 (which
bundles PyMuPDF 1.26.3 + fonttools); the worker `micropip`-installs the pure-python
`pdf-cmap-fix` wheel and `python-docx`, fixes/extracts in memory, and hands the result
bytes back for download. Nothing is sent over the network except the Pyodide runtime
and the wheel (both cached by the service worker after the first visit).

## Run it locally

```bash
./scripts/build-wheel.sh          # builds web/wheels/pdf_cmap_fix-...whl (needs python3 + pip + git)
cd web && python3 -m http.server  # then open http://localhost:8000
```

Any static file server works — there is no build step and no backend.

## Deployment (GitHub Pages)

Pushing to `main` triggers [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml),
which builds the wheel and deploys `web/` to GitHub Pages.

**One-time setup:** in the repo settings, enable **Pages** with the **“GitHub Actions”**
source.

## Notes & limits

- **Large files:** everything runs in your browser's memory. Files over ~20 MB trigger a
  warning (the tab can run out of memory and crash) but can be processed anyway — a
  desktop computer is recommended for big PDFs. Typical Tibetan text PDFs (a few MB) are
  comfortable, including on mobile.
- **Markdown export is not available** in the browser build: `pymupdf4llm` requires a
  newer PyMuPDF than Pyodide currently bundles. Instead, extraction repairs the PDF then
  reads PyMuPDF's structured text and preserves formatting (font size, bold/italic,
  paragraphs) into the `.docx` (plus a plain `.txt`).
- Coverage of legacy fonts depends on the font being known to `pdf-cmap-fix`; report
  fonts that don't convert upstream at
  [OpenPecha/pdf-cmap-fix](https://github.com/OpenPecha/pdf-cmap-fix).

## Credits & license

Wraps [OpenPecha/pdf-cmap-fix](https://github.com/OpenPecha/pdf-cmap-fix) (MIT). This
wrapper is under the repository's [`LICENSE`](LICENSE). The text preview and the exported
`.docx` use the **Jomolhari** Tibetan font (SIL Open Font License), bundled at
[`web/fonts/`](web/fonts/). See [`DECISIONS.md`](DECISIONS.md) and
[`docs/superpowers/specs/`](docs/superpowers/specs/) for the reasoning behind the design.
