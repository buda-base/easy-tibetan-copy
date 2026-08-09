"""Cross-checks web/worker.js's boot-time Python against tests/junk_metric.py.

web/worker.js ships its scoring Python as a JS template literal that only
Pyodide ever runs, in the browser -- nothing in this repository imports it.
Every other test in this suite exercises junk_metric.py, the mirror. Nothing
was exercising the worker itself, so a diverged copy or a backslash mistake
(single vs. doubled -- see the "ESCAPING TRAP" note in the plan) would fail
silently: the worker's _clean would degrade to a no-op that never matches,
users would see raw open-box glyphs in the R3 sample, and this suite would
stay green throughout.

This test extracts the exact boot-block source from web/worker.js, undoes
only what a JS template literal collapses at evaluation time -- a doubled
backslash becomes one, nothing else -- execs it in an isolated namespace, and
asserts its _is_hard_junk / _clean / _score_pdf / _junk_fonts agree with
junk_metric's versions, including on the real fixtures. If the extraction or
the un-escaping ever needs a broader heuristic than "undo the doubling", that
is a sign this test is no longer trustworthy and it should be made to fail
loudly rather than quietly stop checking.

Run (in a venv with the repository wheel):
    pip install web/wheels/*.whl pymupdf fonttools
    python -m pytest tests/test_worker_matches_junk_metric.py -q
"""

import os

import pytest

import junk_metric
from junk_metric import clean, is_hard_junk, junk_fonts, score_pdf

HERE = os.path.dirname(__file__)
WORKER_JS = os.path.join(HERE, "..", "web", "worker.js")
CLEAN_FIXTURE = os.path.join(HERE, "fixtures", "thrangu-p1.pdf")
ALREADY_FIXTURE = os.path.join(HERE, "fixtures", "quartz-spaced-cmap-p1.pdf")
BROKEN_FIXTURE = os.path.join(HERE, "fixtures", "issue16-p1.pdf")

pdf_cmap_fix = pytest.importorskip(
    "pdf_cmap_fix", reason="install the bundled wheel first: pip install web/wheels/*.whl"
)

_BOOT_START = "import os, re, shutil, pdf_cmap_fix, pymupdf"
_BOOT_END = "`);"


def _extract_boot_python():
    """Slice the boot-time Python out of the runPythonAsync template literal
    in web/worker.js and undo exactly what that template literal collapses at
    runtime: a doubled backslash becomes one. Nothing else is touched."""
    with open(WORKER_JS, encoding="utf-8") as f:
        src = f.read()
    start = src.index(_BOOT_START)
    end = src.index(_BOOT_END, start)
    block = src[start:end]
    assert "\\\\" in block, (
        "expected doubled backslashes in the boot block -- the extraction "
        "markers may be stale, or web/worker.js stopped double-escaping"
    )
    return block.replace("\\\\", "\\")


@pytest.fixture(scope="module")
def worker_ns():
    """Exec the extracted boot Python in its own namespace so its
    _is_hard_junk/_clean/_score_pdf/_junk_fonts can be called directly,
    without booting Pyodide."""
    ns = {}
    exec(compile(_extract_boot_python(), WORKER_JS, "exec"), ns)
    return ns


def test_worker_defines_the_scoring_functions(worker_ns):
    for name in ("_is_hard_junk", "_clean", "_score_pdf", "_junk_fonts"):
        assert name in worker_ns, f"web/worker.js boot block no longer defines {name}"


@pytest.mark.parametrize(
    "cp",
    [0x2400, 0x2422, 0x2424, 0x2423, 0xE000, 0xF8FF, 0x0E00, 0x0E7F, 0xFFFD, 0x41, 0x0F00],
)
def test_is_hard_junk_matches_the_mirror(worker_ns, cp):
    assert worker_ns["_is_hard_junk"](cp) == is_hard_junk(cp)


@pytest.mark.parametrize(
    "s",
    ["ཀ␣ཁ", "plain ascii text", "␀␁␂␤ trailing", ""],
)
def test_clean_matches_the_mirror(worker_ns, s):
    assert worker_ns["_clean"](s) == clean(s)


@pytest.mark.parametrize(
    "fixture", [CLEAN_FIXTURE, ALREADY_FIXTURE, BROKEN_FIXTURE], ids=os.path.basename
)
def test_score_pdf_matches_the_mirror(worker_ns, tmp_path, fixture):
    out = str(tmp_path / "out.pdf")
    pdf_cmap_fix.patch_pdf(fixture, output_path=out, write_file=True)
    assert worker_ns["_score_pdf"](out) == score_pdf(out)


def test_junk_fonts_matches_the_mirror(worker_ns, tmp_path):
    out = str(tmp_path / "gid.pdf")
    pdf_cmap_fix.patch_pdf(BROKEN_FIXTURE, output_path=out, write_file=True)
    assert worker_ns["_junk_fonts"](out) == junk_fonts(out)


def test_subset_prefix_matches_the_mirror(worker_ns):
    r"""_SUBSET_PREFIX carries the boot block's only escape that is neither a
    \uXXXX nor a \n -- the doubled \\+ in r"^[A-Z]{6}\\+". No font in the
    fixtures carries a subset prefix, so test_junk_fonts_matches_the_mirror
    passes whether or not that escape survived the template literal. Compare
    the pattern against the mirror directly, and check it actually strips one.
    """
    assert worker_ns["_SUBSET_PREFIX"].pattern == junk_metric._SUBSET_PREFIX.pattern
    assert worker_ns["_SUBSET_PREFIX"].sub("", "ABCDEF+Jomolhari") == "Jomolhari"
    # Six capitals with no "+" are part of the name, not a subset prefix.
    assert worker_ns["_SUBSET_PREFIX"].sub("", "ABCDEFJomolhari") == "ABCDEFJomolhari"


def test_subset_prefix_backslash_is_doubled_in_the_source():
    r"""The escaping half of the same gap, which worker_ns cannot see.

    _extract_boot_python un-doubles backslashes, so r"^[A-Z]{6}\\+" and
    r"^[A-Z]{6}\+" both reach exec as \+ and the test above passes either way.
    Only the raw source can tell them apart -- and the single-backslash form is
    the one that ships broken: the JS template literal turns \+ into a bare +,
    giving [A-Z]{6}+, a possessive quantifier on Python 3.11+. That compiles,
    so the worker boots, and silently stops stripping subset prefixes -- font
    names in the R3 report would come back as "ABCDEF+Jomolhari".
    """
    with open(WORKER_JS, encoding="utf-8") as f:
        line = next(l for l in f if "_SUBSET_PREFIX = re.compile" in l)
    assert r"\\+" in line, (
        "_SUBSET_PREFIX must double its backslash inside the JS template "
        f"literal: {line.strip()}"
    )
