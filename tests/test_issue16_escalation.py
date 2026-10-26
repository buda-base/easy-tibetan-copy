"""Regression test for issue #16 — mixed legacy fonts that copied as garbage.

Older pdf-cmap-fix releases selected a richer but incompatible same-name font
release, mapping some runs into the Thai Unicode block. Compatibility-aware
candidate selection now repairs the fixture with the default GID tree.

The browser still bundles the PUA-free tree as a fallback for other PDFs. These
tests guard both the improved default and that fallback.

Run (after `pip install web/wheels/*.whl pymupdf fonttools`):
    python -m pytest tests/test_issue16_escalation.py -q
"""

import os

import pytest

from junk_metric import pua_free_dir, score_pdf

HERE = os.path.dirname(__file__)
FIXTURE = os.path.join(HERE, "fixtures", "issue16-p1.pdf")

# A line that used to be Thai-block garbage under the default GID tree.
EXPECTED_TIBETAN = "གང་ཐུགས་བདེ་ཆེན"

pdf_cmap_fix = pytest.importorskip(
    "pdf_cmap_fix", reason="install the bundled wheel first: pip install web/wheels/*.whl"
)
import fitz  # noqa: E402  PyMuPDF — a wheel runtime dependency


def test_wheel_bundles_pua_free_tree():
    # The escalation is dead weight if the wheel build dropped this tree.
    assert pua_free_dir().is_dir(), (
        "PUA-free tree missing from the wheel — check scripts/build-wheel.sh "
        "package-data still lists data/font_lookup_gid_pua_free"
    )


def test_default_gid_selects_the_compatible_font_release(tmp_path):
    out = str(tmp_path / "gid.pdf")
    pdf_cmap_fix.patch_pdf(FIXTURE, output_path=out, write_file=True)
    tib, junk, _ = score_pdf(out)
    assert junk == 0
    assert tib > 100
    assert EXPECTED_TIBETAN in fitz.open(out)[0].get_text()


def test_pua_free_clears_the_garbage(tmp_path):
    out = str(tmp_path / "pua.pdf")
    pdf_cmap_fix.patch_pdf(
        FIXTURE, output_path=out, write_file=True, font_lookup_dir=pua_free_dir()
    )
    tib, junk, _ = score_pdf(out)
    assert junk == 0, f"PUA-free tree should leave no garbage, got {junk} junk chars"
    assert tib > 100, f"expected real Tibetan after repair, got {tib} codepoints"
    assert EXPECTED_TIBETAN in fitz.open(out)[0].get_text()
