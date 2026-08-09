"""Regression test for issue #16 — mixed legacy fonts that copy as garbage.

Some Tibetan PDFs mix fonts: the default gid lookup tree repairs most of them,
but a few map glyphs into the Thai Unicode block (U+0E00–U+0E7F), so those runs
still copy-paste as garbage. The tool reported "fixed" anyway, because it only
counted recovered Tibetan and never the leftover junk.

The fix: bundle the PUA-free gid tree in the wheel and, when the gid output
still extracts non-Tibetan/non-ASCII "junk", escalate to it. This test guards
both halves — that the wheel ships the PUA-free tree, and that it clears the
junk where plain gid does not. Scoring lives in `tests/junk_metric.py`, which
mirrors `web/worker.js`.

Run (after `pip install web/wheels/*.whl pymupdf fonttools`):
    python -m pytest tests/test_issue16_escalation.py -q
"""

import os

import pytest

from junk_metric import pua_free_dir, score_pdf

HERE = os.path.dirname(__file__)
FIXTURE = os.path.join(HERE, "fixtures", "issue16-p1.pdf")

# A line that is Thai-block garbage under gid and correct Tibetan under PUA-free.
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


def test_default_gid_leaves_thai_block_garbage(tmp_path):
    out = str(tmp_path / "gid.pdf")
    pdf_cmap_fix.patch_pdf(FIXTURE, output_path=out, write_file=True)
    _, junk, _ = score_pdf(out)
    assert junk > 0, "fixture no longer reproduces issue #16 under the default gid tree"


def test_pua_free_clears_the_garbage(tmp_path):
    out = str(tmp_path / "pua.pdf")
    pdf_cmap_fix.patch_pdf(
        FIXTURE, output_path=out, write_file=True, font_lookup_dir=pua_free_dir()
    )
    tib, junk, _ = score_pdf(out)
    assert junk == 0, f"PUA-free tree should leave no garbage, got {junk} junk chars"
    assert tib > 100, f"expected real Tibetan after repair, got {tib} codepoints"
    assert EXPECTED_TIBETAN in fitz.open(out)[0].get_text()
