"""Heavy PDF work. All functions are synchronous/blocking and are meant to be
called from a thread pool by the queue worker. They take a real file path because
the underlying libraries (pdf-cmap-fix, pymupdf4llm) open by path.
"""

from __future__ import annotations

import os
import tempfile

import fitz  # PyMuPDF
import pymupdf4llm

from pdf_cmap_fix import patch_pdf

from . import docx_export


class ProcessingError(Exception):
    """Raised when a PDF cannot be processed (corrupt, encrypted, etc.)."""


def looks_like_pdf(data: bytes) -> bool:
    return data[:5] == b"%PDF-"


def _open(pdf_path: str) -> "fitz.Document":
    try:
        doc = fitz.open(pdf_path)
    except Exception as exc:  # corrupt / not a pdf
        raise ProcessingError(f"Could not open PDF: {exc}") from exc
    if doc.needs_pass:
        doc.close()
        raise ProcessingError("This PDF is password-protected and cannot be processed.")
    return doc


def _select_pages(page_count: int, mode: str) -> list[int]:
    """Map a page mode to 0-based indices. 'even'/'odd' refer to 1-based page numbers."""
    if mode == "even":
        return [i for i in range(page_count) if (i + 1) % 2 == 0]
    if mode == "odd":
        return [i for i in range(page_count) if (i + 1) % 2 == 1]
    return list(range(page_count))


def analyze_pdf(pdf_path: str) -> dict:
    """Inspect a PDF without modifying it: page count and fonts."""
    doc = _open(pdf_path)
    try:
        fonts: dict[str, dict] = {}
        for page in doc:
            for f in page.get_fonts(full=True):
                base_font = f[3] or "(unnamed)"
                ftype = f[1] or ""
                if base_font not in fonts:
                    fonts[base_font] = {"name": base_font, "type": ftype}
        return {
            "page_count": doc.page_count,
            "fonts": list(fonts.values()),
        }
    finally:
        doc.close()


def process_fix(pdf_path: str) -> dict:
    """Repair the /ToUnicode CMap so copy-paste works (legacy Tibetan fonts are
    handled automatically by pdf-cmap-fix). Returns patched PDF bytes + stats.
    """
    try:
        result = patch_pdf(pdf_path, write_file=False)
    except Exception as exc:
        raise ProcessingError(f"CMap repair failed: {exc}") from exc

    pdf_bytes = result["pdf_bytes"]
    stats = dict(result.get("stats", {}))

    return {
        "kind": "pdf",
        "pdf_bytes": pdf_bytes,
        "stats": stats,
        "size": len(pdf_bytes),
    }


def process_extract(pdf_path: str, pages_mode: str = "all") -> dict:
    """Extract Markdown text via PyMuPDF4LLM. The PDF is patched first so legacy
    Tibetan fonts extract as correct Unicode (handled by pdf-cmap-fix).
    """
    try:
        result = patch_pdf(pdf_path, write_file=False)
    except Exception as exc:
        raise ProcessingError(f"CMap repair failed: {exc}") from exc
    patched_bytes = result["pdf_bytes"]

    tmp_path = None
    doc = None
    try:
        fd, tmp_path = tempfile.mkstemp(suffix=".pdf")
        with os.fdopen(fd, "wb") as fh:
            fh.write(patched_bytes)

        doc = fitz.open(stream=patched_bytes, filetype="pdf")
        page_count = doc.page_count
        indices = _select_pages(page_count, pages_mode)
        if not indices:
            return {
                "kind": "text",
                "text": "",
                "format": "markdown",
                "page_count": page_count,
                "pages_used": 0,
            }

        text = pymupdf4llm.to_markdown(tmp_path, pages=indices, show_progress=False)
        fmt = "markdown"
        # Build a .docx alongside the preview text (preserves formatting).
        try:
            docx_bytes = docx_export.to_docx_bytes(text, is_markdown=True)
        except Exception:
            docx_bytes = b""  # never fail the extraction over the optional .docx
    except ProcessingError:
        raise
    except Exception as exc:
        raise ProcessingError(f"Extraction failed: {exc}") from exc
    finally:
        if doc is not None:
            doc.close()
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)

    return {
        "kind": "text",
        "text": text,
        "format": fmt,
        "page_count": page_count,
        "pages_used": len(indices),
        "pages_mode": pages_mode,
        "docx_bytes": docx_bytes,
        "docx_size": len(docx_bytes),
    }


def process(pdf_path: str, options: dict) -> dict:
    """Dispatch a job described by `options` to the right processor."""
    mode = options.get("mode", "fix")
    if mode == "extract":
        pages_mode = options.get("pages", "all")
        if pages_mode not in ("all", "even", "odd"):
            pages_mode = "all"
        return process_extract(pdf_path, pages_mode)
    return process_fix(pdf_path)
