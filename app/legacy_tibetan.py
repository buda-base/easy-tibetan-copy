"""Legacy (pre-Unicode) Tibetan font handling.

Two capabilities, both EXPERIMENTAL (pytiblegenc is "work in progress"):

1. Detect whether a PDF uses a known legacy Tibetan font.
2. Convert it to Unicode, either as
     - extracted text (PyMuPDF spans -> pytiblegenc.convert_string), or
     - an in-place /ToUnicode CMap injection so the rendered PDF copy-pastes as Unicode.

We deliberately use PyMuPDF for all PDF I/O and only borrow pytiblegenc's stable
string-level core (`convert_string`, `normalize_font_name`) — avoiding its fragile
pdfminer/FontForge pipeline.
"""

from __future__ import annotations

import csv
import re
from functools import lru_cache
from typing import Optional

import fitz  # PyMuPDF

# pytiblegenc is optional at runtime — guard the import so the core app still works.
try:
    from pytiblegenc import convert_string, normalize_font_name

    _PYTIBLEGENC_AVAILABLE = True
except Exception:  # pragma: no cover - only if dependency missing/broken
    convert_string = None  # type: ignore
    normalize_font_name = None  # type: ignore
    _PYTIBLEGENC_AVAILABLE = False

# Subset prefixes look like "ABCDEF+RealFontName".
_SUBSET_PREFIX = re.compile(r"^[A-Z]{6}\+")


def is_available() -> bool:
    """Whether legacy-Tibetan conversion is usable in this install."""
    return _PYTIBLEGENC_AVAILABLE and bool(_load_tables())


@lru_cache(maxsize=1)
def _tiblegenc_csv_path() -> Optional[str]:
    """Locate the bundled tiblegenc.csv inside the installed pytiblegenc package."""
    if not _PYTIBLEGENC_AVAILABLE:
        return None
    import os

    import pytiblegenc

    path = os.path.join(
        os.path.dirname(pytiblegenc.__file__), "font-tables", "tiblegenc.csv"
    )
    return path if os.path.exists(path) else None


@lru_cache(maxsize=1)
def _load_tables() -> dict[str, dict[int, str]]:
    """font_id -> {byte_code(int 0-255) -> Unicode string}.

    Mirrors pytiblegenc's loader for the 8-bit range, which is what a simple-font
    /ToUnicode CMap needs (byte -> Unicode, possibly a multi-codepoint cluster).
    """
    path = _tiblegenc_csv_path()
    if not path:
        return {}
    tables: dict[str, dict[int, str]] = {}
    # Headerless CSV: font_id,code,unicode. The unicode field is CSV-quoted when it
    # contains a comma or a leading/trailing space (e.g. `TibetanChogyal,32," "`),
    # so it must be parsed with the csv module — a naive split keeps the quotes and
    # produces spurious " characters in the output.
    with open(path, encoding="utf-8", newline="") as fh:
        for row in csv.reader(fh):
            if len(row) < 2 or not row[0]:
                continue
            font_id = row[0]
            try:
                code = int(row[1])
            except ValueError:
                continue
            target = row[2] if len(row) > 2 else ""
            if 0 <= code < 256:
                tables.setdefault(font_id, {})[code] = target
    return tables


def normalize(font_name: str) -> Optional[str]:
    """Resolve a PDF font name to a tiblegenc font id, or None if not legacy."""
    if not font_name:
        return None
    name = _SUBSET_PREFIX.sub("", font_name)
    # Drop trailing style markers PyMuPDF sometimes appends.
    name = name.split(",")[0].strip()
    tables = _load_tables()
    if normalize_font_name is not None:
        for candidate in (name, font_name):
            try:
                norm = normalize_font_name(candidate)
            except Exception:
                norm = None
            if norm and norm in tables:
                return norm
    # Last resort: exact match against table ids.
    if name in tables:
        return name
    return None


def detect_legacy_fonts(doc: "fitz.Document") -> list[dict]:
    """Return detected legacy fonts: [{pdf_name, font_id}], de-duplicated."""
    seen: dict[str, dict] = {}
    for page in doc:
        for f in page.get_fonts(full=True):
            base_font = f[3] or ""
            font_id = normalize(base_font)
            if font_id and base_font not in seen:
                seen[base_font] = {"pdf_name": base_font, "font_id": font_id}
    return list(seen.values())


# --------------------------------------------------------------------------- #
# Text conversion (extraction path)
# --------------------------------------------------------------------------- #


def convert_pdf_to_unicode_text(doc: "fitz.Document", pages: Optional[list[int]] = None) -> str:
    """Extract text and convert legacy Tibetan spans to Unicode, page by page.

    Spans whose font is not a known legacy font are passed through unchanged.
    """
    if convert_string is None:
        raise RuntimeError("pytiblegenc is not available")

    stats = {"handled_fonts": {}, "unhandled_fonts": {}, "unknown_chars": {}}
    page_indices = pages if pages is not None else range(doc.page_count)
    out_pages: list[str] = []

    for pno in page_indices:
        if pno < 0 or pno >= doc.page_count:
            continue
        page = doc[pno]
        data = page.get_text("dict")
        lines_out: list[str] = []
        for block in data.get("blocks", []):
            for line in block.get("lines", []):
                pieces: list[str] = []
                for span in line.get("spans", []):
                    text = span.get("text", "")
                    if not text:
                        continue
                    font_id = normalize(span.get("font", ""))
                    if font_id:
                        converted = convert_string(text, font_id, stats)
                        pieces.append(converted if converted is not None else text)
                    else:
                        pieces.append(text)
                if pieces:
                    lines_out.append("".join(pieces))
        out_pages.append("\n".join(lines_out))

    return "\n\n".join(out_pages).strip()


# --------------------------------------------------------------------------- #
# /ToUnicode injection (download path)
# --------------------------------------------------------------------------- #


def _utf16be_hex(s: str) -> str:
    return s.encode("utf-16-be").hex().upper()


def _build_tounicode_simple(byte_map: dict[int, str]) -> bytes:
    """Build a simple-font (1-byte) /ToUnicode CMap from {byte -> Unicode str}."""
    entries = []
    for code, target in sorted(byte_map.items()):
        if not target:
            continue
        entries.append(f"<{code:02X}> <{_utf16be_hex(target)}>")
    if not entries:
        return b""
    # bfchar sections are capped at 100 entries each by the spec.
    chunks = []
    for i in range(0, len(entries), 100):
        block = entries[i : i + 100]
        chunks.append(f"{len(block)} beginbfchar\n" + "\n".join(block) + "\nendbfchar")
    body = "\n".join(chunks)
    cmap = (
        "/CIDInit /ProcSet findresource begin\n"
        "12 dict begin\n"
        "begincmap\n"
        "/CIDSystemInfo <</Registry (Adobe) /Ordering (UCS) /Supplement 0>> def\n"
        "/CMapName /Adobe-Identity-UCS def\n"
        "/CMapType 2 def\n"
        "1 begincodespacerange\n<00> <FF>\nendcodespacerange\n"
        f"{body}\n"
        "endcmap\n"
        "CMapName currentdict /CMap defineresource pop\n"
        "end\nend"
    )
    return cmap.encode("latin-1")


def inject_unicode_cmaps(doc: "fitz.Document") -> dict:
    """Inject /ToUnicode CMaps for every legacy-font in the doc.

    Renders identically; copy-paste yields Unicode. Returns stats.
    Mutates `doc` in place.
    """
    tables = _load_tables()
    stats = {"fonts_seen": 0, "fonts_converted": 0, "fonts_skipped": 0}

    # Collect font xrefs across all pages (a font can appear on many pages).
    font_xrefs: dict[int, str] = {}
    for page in doc:
        for f in page.get_fonts(full=True):
            xref = f[0]
            base_font = f[3] or ""
            if xref not in font_xrefs:
                font_xrefs[xref] = base_font

    for xref, base_font in font_xrefs.items():
        stats["fonts_seen"] += 1
        font_id = normalize(base_font)
        if not font_id or font_id not in tables:
            stats["fonts_skipped"] += 1
            continue
        cmap_bytes = _build_tounicode_simple(tables[font_id])
        if not cmap_bytes:
            stats["fonts_skipped"] += 1
            continue
        try:
            # Create a new stream object holding the CMap and point /ToUnicode at it.
            new_xref = doc.get_new_xref()
            doc.update_object(new_xref, "<<>>")
            doc.update_stream(new_xref, cmap_bytes)
            doc.xref_set_key(xref, "ToUnicode", f"{new_xref} 0 R")
            stats["fonts_converted"] += 1
        except Exception:
            stats["fonts_skipped"] += 1

    return stats
