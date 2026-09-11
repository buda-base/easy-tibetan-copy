"""Regression guard for Quartz-style /ToUnicode CMaps (spaces inside the hex).

macOS Pages/Quartz writes multi-codepoint /ToUnicode destinations with the hex
words separated by spaces — ``<21><0f04 0f05>`` — which is valid PostScript
hex-string syntax. An older ``_hex_to_unicode`` counted those spaces, so even
codepoint counts parsed empty and a later CMap rewrite turned ``ཨོཾ`` into
``ཨo``. Upstream now strips whitespace inside ``<...>``.

``test_spaced_hex_destinations_are_parsed`` locks the parse in.
``test_repair_preserves_the_already_correct_text`` guards the user-visible
contract: repairing this file must never degrade the extracted text.

Upstream: https://github.com/OpenPecha/pdf-cmap-fix

Fixture: page 1 of a Pages/Quartz (macOS 10.11) export of a Tibetan sadhana,
metadata stripped.

Run (after `pip install web/wheels/*.whl pymupdf fonttools`):
    python -m pytest tests/test_quartz_spaced_cmap.py -q
"""

import os
import re

import pytest

HERE = os.path.dirname(__file__)
FIXTURE = os.path.join(HERE, "fixtures", "quartz-spaced-cmap-p1.pdf")

# `<0f04 0f05>` — two or more hex words inside one destination string.
_SPACED_HEX = re.compile(rb"<[0-9a-fA-F]{4}(?:\s+[0-9a-fA-F]{4})+>")

# Code 0x21 carries `<0f04 0f05>` — the ༄༅ head mark opening the page.
_HEAD_MARK_CODE = 0x21

pdf_cmap_fix = pytest.importorskip(
    "pdf_cmap_fix", reason="install the bundled wheel first: pip install web/wheels/*.whl"
)
import fitz  # noqa: E402  PyMuPDF — a wheel runtime dependency

from pdf_cmap_fix.content_streams import collect_referenced_gids  # noqa: E402


def _cmap_streams(doc):
    for xref in range(1, doc.xref_length()):
        try:
            stream = doc.xref_stream(xref)
        except Exception:  # not a stream object — nothing to inspect
            continue
        if stream and b"begincmap" in stream:
            yield stream


def _referenced_but_unmapped(doc):
    """Codes drawn on the page whose /ToUnicode entry parses as empty."""
    merges, _ = pdf_cmap_fix.collect_font_merges(doc)
    unmapped = {}
    for record in merges:
        xref = record["font_xref"]
        existing = record["existing"]
        used = collect_referenced_gids(doc, simple_xrefs={xref}).get(xref, set())
        empty = sorted(code for code in used if not existing.get(code))
        if empty:
            unmapped[record["pdf_font_name"]] = empty
    return unmapped


def test_fixture_still_uses_spaced_hex_destinations():
    # If a future re-export normalises the CMap, this file stops testing
    # anything and the guard below would pass for the wrong reason.
    doc = fitz.open(FIXTURE)
    spaced = sum(len(_SPACED_HEX.findall(stream)) for stream in _cmap_streams(doc))
    assert spaced > 0, "fixture no longer carries Quartz-style spaced hex destinations"


def test_repair_preserves_the_already_correct_text(tmp_path):
    # This PDF needs no repair — its /ToUnicode is complete. Running it through
    # the tool anyway must be a no-op on the text, never a downgrade.
    before = fitz.open(FIXTURE)[0].get_text()
    out = str(tmp_path / "repaired.pdf")
    pdf_cmap_fix.patch_pdf(FIXTURE, output_path=out, write_file=True)
    after = fitz.open(out)[0].get_text()

    assert after == before, (
        "repair changed the extracted text of an already-correct PDF — the "
        "spaced-hex /ToUnicode entries were most likely rewritten as empty"
    )


def test_spaced_hex_destinations_are_parsed():
    unmapped = _referenced_but_unmapped(fitz.open(FIXTURE))
    assert unmapped == {}, (
        f"codes drawn on the page parse to no Unicode: {unmapped} — "
        f"0x{_HEAD_MARK_CODE:02x} should decode <0f04 0f05> as ༄༅"
    )
