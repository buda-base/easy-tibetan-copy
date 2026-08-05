"""The narrowed junk metric.

Before this change, _score_pdf counted every non-Tibetan codepoint above 0x7F
as junk. thrangu-p1.pdf — repaired perfectly, 1128 Tibetan characters — reported
4 junk characters that were all U+2423 OPEN BOX, i.e. spaces. That pushed it
into the "partially repaired" branch with an orange badge. Any Tibetan PDF
containing English or Sanskrit hit the same wall.

These tests guard both directions: the false positive must stay dead, and the
genuine issue #16 garbage must still be caught.

Run (in a venv with the repository wheel):
    pip install web/wheels/*.whl pymupdf fonttools
    python -m pytest tests/test_junk_metric.py -q
"""

import os

import pytest

from junk_metric import clean, is_hard_junk, junk_fonts, score_pdf

HERE = os.path.dirname(__file__)
CLEAN_FIXTURE = os.path.join(HERE, "fixtures", "thrangu-p1.pdf")
BROKEN_FIXTURE = os.path.join(HERE, "fixtures", "issue16-p1.pdf")
ALREADY_FIXTURE = os.path.join(HERE, "fixtures", "quartz-spaced-cmap-p1.pdf")

pdf_cmap_fix = pytest.importorskip(
    "pdf_cmap_fix", reason="install the bundled wheel first: pip install web/wheels/*.whl"
)


def _pua_free_dir():
    return pdf_cmap_fix.FONT_LOOKUP_DIR.parent / "font_lookup_gid_pua_free"


@pytest.mark.parametrize(
    "ch",
    ["ā", "ī", "ū", "ṃ", "ḥ", "ś", "ṣ", "ṭ", "ḍ", "ñ", "é", "’", "—", "°", "¶", "中"],
)
def test_legitimate_characters_are_not_junk(ch):
    # Sanskrit diacritics, curly quotes, em-dashes and CJK all belong in a real
    # Tibetan Buddhist PDF. Counting them is what produced the false "partial".
    assert not is_hard_junk(ord(ch))


@pytest.mark.parametrize("cp", [0xE000, 0xF8FF, 0x0E00, 0x0E7F, 0xFFFD])
def test_broken_mapping_codepoints_are_junk(cp):
    assert is_hard_junk(cp)


def test_open_box_is_normalised_to_a_space():
    assert clean("\u0f40\u2423\u0f41") == "\u0f40 \u0f41"


def test_clean_repair_reports_no_junk(tmp_path):
    # The regression that motivated this change: this file is repaired
    # perfectly and used to report 4 junk characters (all U+2423).
    out = str(tmp_path / "clean.pdf")
    pdf_cmap_fix.patch_pdf(CLEAN_FIXTURE, output_path=out, write_file=True)
    tib, junk, sample = score_pdf(out)
    assert junk == 0, f"clean repair must report no junk, got {junk}"
    assert tib > 1000, f"expected the Tibetan to be recovered, got {tib}"
    assert sample, "a repaired file must yield a sample for the R3 report"


def test_already_correct_pdf_reports_no_junk(tmp_path):
    # A Pages/Quartz export whose Tibetan is already correct Unicode and whose
    # font has no lookup match, so nothing is repaired (patched == 0). Its 46
    # NO-BREAK SPACEs used to count as junk, which pushed a perfectly fine file
    # into "partially repaired" with an orange badge and a "send us this PDF"
    # button. It must reach the "already fine" branch instead.
    out = str(tmp_path / "quartz.pdf")
    pdf_cmap_fix.patch_pdf(ALREADY_FIXTURE, output_path=out, write_file=True)
    tib, junk, sample = score_pdf(out)
    assert junk == 0, f"an already-correct PDF must report no junk, got {junk}"
    assert tib > 1000, f"expected the existing Tibetan to be counted, got {tib}"
    assert any(0x0F00 <= ord(c) <= 0x0FFF for c in sample), "sample must carry Tibetan"


def test_sample_is_capped(tmp_path):
    out = str(tmp_path / "clean.pdf")
    pdf_cmap_fix.patch_pdf(CLEAN_FIXTURE, output_path=out, write_file=True)
    _, _, sample = score_pdf(out)
    assert len(sample) <= 200
    assert len(sample.split("\n")) <= 3


def test_thai_block_garbage_still_counts(tmp_path):
    # The issue #16 guard must survive the narrowing.
    out = str(tmp_path / "gid.pdf")
    pdf_cmap_fix.patch_pdf(BROKEN_FIXTURE, output_path=out, write_file=True)
    _, junk, _ = score_pdf(out)
    assert junk > 0, "fixture no longer reproduces issue #16 under the default gid tree"


def test_junk_is_attributed_to_the_offending_font(tmp_path):
    out = str(tmp_path / "gid.pdf")
    pdf_cmap_fix.patch_pdf(BROKEN_FIXTURE, output_path=out, write_file=True)
    assert "Monlam Uni OuChan3" in junk_fonts(out)


def test_pua_free_clears_the_garbage(tmp_path):
    out = str(tmp_path / "pua.pdf")
    pdf_cmap_fix.patch_pdf(
        BROKEN_FIXTURE, output_path=out, write_file=True, font_lookup_dir=_pua_free_dir()
    )
    tib, junk, _ = score_pdf(out)
    assert junk == 0
    assert tib > 100
    assert junk_fonts(out) == []
