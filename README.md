# Pecha · Tibetan PDF Fix

A lightweight, modern web app around OpenPecha's
[`pdf-cmap-fix`](https://github.com/OpenPecha/pdf-cmap-fix) CLI.

Many Tibetan PDFs render perfectly on screen but copy/paste and extract as gibberish,
because the embedded font's `/ToUnicode` character map is broken or missing. Pecha
repairs that map so the text comes out correct — and can also extract clean text for you.

## What it does

- **Fix the PDF** — repairs the `/ToUnicode` CMap (via `pdf-cmap-fix`) so copy-paste,
  search and extraction return correct Unicode. Download the fixed PDF. Pre-Unicode
  **legacy Tibetan fonts** (TibetanChogyal, Ededris/Dedris, …) are handled automatically
  by `pdf-cmap-fix` — no toggle, no extra step.
- **Extract text** — pulls clean, structured **Markdown** out of the PDF
  (via [PyMuPDF4LLM](https://pymupdf.readthedocs.io/en/latest/pymupdf4llm/)), with an
  option to take **only odd or only even pages** (handy for pecha-style books). The PDF is
  repaired first, so legacy fonts come out as correct Unicode. Download it as `.md`/`.txt`
  or as a formatting-preserving **Word `.docx`** (rendered with
  [pandoc](https://pandoc.org/) when installed, otherwise `python-docx`).

## Design constraints (built in)

- **5 MB** upload limit.
- **One PDF processed at a time**, with a **50-slot waiting queue**; when full, callers
  are asked to retry shortly.
- **Nothing kept on disk.** Uploads touch a temp file only during processing (the
  libraries open by path), which is deleted immediately afterwards. Results live in
  memory and the fixed PDF is **wiped the moment you download it**; anything not
  downloaded is swept after 15 minutes.

## Run it

```bash
./run.sh                 # creates .venv, installs deps, starts on http://127.0.0.1:8000
# or pick a port:
PORT=9000 ./run.sh
```

Manual equivalent:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Then open the printed URL.

## Architecture

```
app/
  main.py            FastAPI: API + serves the static SPA, 5 MB cap, two-phase flow
  queue_manager.py   single-worker asyncio queue (50 slots), in-memory jobs, TTL sweep
  processing.py      the heavy work: analyze / fix / extract  (runs in a thread pool)
  docx_export.py     render extracted text to .docx (pandoc, python-docx fallback)
web/
  index.html  styles.css  app.js   no build step — plain, fast, hand-crafted
```

**Request flow:** `POST /api/analyze` (inspect fonts, stage bytes, return a token) →
`POST /api/jobs` (`{token, mode, pages}`) → poll `GET /api/jobs/{id}` →
`GET /api/jobs/{id}/download` (streams the PDF — or `?format=docx` — then evicts it).

See [`DECISIONS.md`](DECISIONS.md) for the reasoning behind each choice.

## Status / caveats

- The **core fix and extraction paths are tested** end-to-end (API + browser).
- **Legacy Tibetan** is repaired by `pdf-cmap-fix` itself (it vendors the BDRC tiblegenc
  tables and identifies obfuscated fonts by glyph outline). Validated on a real
  `TibetanChogyal` PDF: copy-paste returns correct Unicode, clean across all pages.
  Coverage depends on the font being known to `pdf-cmap-fix`; report fonts that don't convert
  upstream at [OpenPecha/pdf-cmap-fix](https://github.com/OpenPecha/pdf-cmap-fix).
- The queue is in-process: state is per-instance and not shared across workers, so run a
  single Uvicorn worker (the default here).

## Licenses

This wrapper is under the repository's `LICENSE`. It depends on `pdf-cmap-fix` (MIT).
