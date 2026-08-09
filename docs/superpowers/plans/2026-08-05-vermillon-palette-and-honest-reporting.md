# Vermillon Palette & Honest Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop reporting successfully repaired Tibetan PDFs as "partially repaired", replace the stat-card report with a live sample of the repaired text, move page filtering into the extraction result, and repaint the interface in the Vermillon palette.

**Architecture:** `web/` is a dependency-free static site. `web/worker.js` embeds Python source as JS template strings and runs it in Pyodide; `web/app.js` is an IIFE state machine driving five views; `web/styles.css` is a single stylesheet with a CSS-custom-property palette in `:root`. Python tests under `tests/` mirror the worker's scoring logic against the bundled wheel. No build step, no framework.

**Tech Stack:** Vanilla JS (ES modules for the vendored converter only), Pyodide 0.29.4, PyMuPDF, `pdf_cmap_fix` 0.4.0 (bundled wheel), pytest.

## Global Constraints

- **Everything stays client-side.** No network call may be added beyond the Pyodide CDN and the bundled wheel already in `web/worker.js:6-7`.
- **No build step.** Do not introduce bundlers, preprocessors, or npm dependencies for `web/`.
- **Cache-busting:** any new asset referenced from `index.html` or `app.js` must carry `?v=__BUILD__`, matching `web/index.html:13,166`.
- **Junk definition (single source of truth):** a codepoint is junk **only** if it is in Private Use Area `U+E000–U+F8FF`, Thai block `U+0E00–U+0E7F`, or is `U+FFFD`.
- **Normalisation before scoring:** `U+2423` → space; `U+2400–U+2422` and `U+2424` → removed.
- **Escaping trap — read this before copying any Python.** The Python in `web/worker.js` lives inside a JS template literal, so every backslash must be **doubled** there (`"\\u2423"`, `"\\n"`) — this is the existing convention at `web/worker.js:145-149`. The Python in `tests/` is a real `.py` file and must use **single** backslashes (`"␣"`, `"\n"`). Getting this backwards is silent: `str.replace("\\u2423", " ")` in a real `.py` file matches the six literal characters `␣` and therefore does nothing, so the normalisation quietly stops working and the false positive comes back.
- **Token names are not renamed.** `--maroon` keeps its name while holding a vermilion value. Renaming is explicitly out of scope.
- **Test command:** `python3 -m pytest tests/ -q`. The globally installed `pdf_cmap_fix` is NOT the repository wheel — create a venv and `pip install web/wheels/*.whl pymupdf fonttools` first, or every test fails for the wrong reason.
- **Branch:** `feat/vermillon-palette-and-honest-reporting` (already created, spec already committed as `53b17ae`).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `tests/junk_metric.py` | Shared Python mirror of the worker's scoring helpers. Both test files import it, so the mirror exists in exactly one place. | **Create** |
| `tests/test_junk_metric.py` | Guards the narrowed definition and the false positive that motivated it. | **Create** |
| `tests/test_issue16_escalation.py` | Existing #16 guard; switches to the shared helper. | Modify |
| `web/worker.js` | Pyodide engine. Scoring, font attribution, sample capture, patched-PDF cache, on-demand `.docx`. | Modify |
| `web/app.js` | State machine. R3 report, page filtering in the result, config simplification. | Modify |
| `web/styles.css` | Vermillon tokens, de-hardcoding of colour literals, button wrap fix. | Modify |

Task order is dependency-driven: Task 1 defines the stats contract Task 2 renders; Task 3 changes the extract contract Task 4 consumes; Task 5 is independent and can run at any point.

---

## Task 1: Narrow the junk metric, attribute it to a font, capture a sample

**Files:**
- Create: `tests/junk_metric.py`
- Create: `tests/test_junk_metric.py`
- Modify: `web/worker.js:26-78` (the boot-time Python block)
- Modify: `tests/test_issue16_escalation.py:34-46`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Python in the worker: `_is_hard_junk(cp) -> bool`, `_clean(s) -> str`, `_score_pdf(path) -> (tib:int, junk:int, sample:str)`, `_junk_fonts(path) -> list[str]`, `_patch_best(src, dst) -> dict`.
  - `_patch_best` stats dict gains: `junk_chars:int` (redefined), `junk_fonts:list[str]` (empty unless `junk_chars > 0`), `sample:str` (may be `""`), alongside existing `tibetan_chars`, `strategy`, `fonts_seen`, `patched`, `no_match`, `no_change`, `upgrades`.
  - `tests/junk_metric.py` exports `is_hard_junk`, `clean`, `score_pdf`, `junk_fonts` with identical semantics.

- [ ] **Step 1: Create the shared test helper**

Create `tests/junk_metric.py`:

```python
"""Python mirror of the scoring helpers embedded in web/worker.js.

The worker ships its Python as a JS template string, so it cannot be imported.
Both test modules import THIS file instead of each carrying their own copy, so
the mirror lives in exactly one place. When web/worker.js changes its scoring,
change this file in the same commit.

Junk is deliberately narrow: only codepoints that cannot come from legitimate
text. Sanskrit diacritics, curly quotes, em-dashes, accented Latin and CJK are
all legitimate in a Tibetan Buddhist PDF and must NOT be counted.
"""

import re

_CTRL_PICS = re.compile("[\u2400-\u2422\u2424]")
_SUBSET_PREFIX = re.compile(r"^[A-Z]{6}\+")


def is_hard_junk(cp):
    """True only for codepoints that can only come from a broken legacy map."""
    return (
        0xE000 <= cp <= 0xF8FF      # Private Use Area
        or 0x0E00 <= cp <= 0x0E7F   # Thai block — the issue #16 signature
        or cp == 0xFFFD             # replacement character
    )


def clean(s):
    """Legacy fonts map their space glyph to U+2423 OPEN BOX; the /ToUnicode
    carries it straight through. Turn it back into a space before scoring."""
    return _CTRL_PICS.sub("", s.replace("\u2423", " "))


def score_pdf(path):
    """Return (tibetan_chars, junk_chars, sample)."""
    import fitz

    doc = fitz.open(path)
    tib = junk = 0
    sample = []
    for page in doc:
        for line in clean(page.get_text()).split("\n"):
            has_tib = False
            for ch in line:
                cp = ord(ch)
                if 0x0F00 <= cp <= 0x0FFF:
                    tib += 1
                    has_tib = True
                elif is_hard_junk(cp):
                    junk += 1
            if has_tib and len(sample) < 3 and line.strip():
                sample.append(line.strip())
    doc.close()
    return tib, junk, "\n".join(sample)[:200]


def junk_fonts(path):
    """Font names responsible for hard junk. Heavier than score_pdf (needs the
    dict extraction), so callers run it only when junk was actually found."""
    import fitz

    doc = fitz.open(path)
    names = set()
    for page in doc:
        for blk in page.get_text("dict").get("blocks", []):
            if blk.get("type", 0) != 0:
                continue
            for line in blk.get("lines", []):
                for span in line.get("spans", []):
                    if any(is_hard_junk(ord(c)) for c in clean(span.get("text", ""))):
                        names.add(_SUBSET_PREFIX.sub("", span.get("font") or "?"))
    doc.close()
    return sorted(names)
```

- [ ] **Step 2: Write the failing tests**

Create `tests/test_junk_metric.py`:

```python
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
```

- [ ] **Step 3: Make `tests/` importable, then run the tests to verify they fail**

`tests/test_junk_metric.py` imports `junk_metric` as a top-level module. pytest's `rootdir`-based `sys.path` insertion covers this only when `tests/` has no `__init__.py` — which is the case here. Confirm with:

Run: `python3 -m pytest tests/test_junk_metric.py -q`
Expected: FAIL. The `is_hard_junk` / `clean` parametrised tests PASS immediately (they only exercise the new helper). The four fixture tests FAIL only if the wheel is missing — if they already pass, the helper is correct and you may proceed; the real verification is Step 6, where the worker must match.

If you see `ModuleNotFoundError: No module named 'junk_metric'`, add `pythonpath = tests` under `[tool.pytest.ini_options]` in a new `pyproject.toml`, or `conftest.py` in the repo root with `sys.path.insert(0, "tests")`. Prefer the `conftest.py` route — this repo has no `pyproject.toml` and adding one implies packaging decisions that are out of scope.

- [ ] **Step 4: Point the existing #16 test at the shared helper**

In `tests/test_issue16_escalation.py`, delete the local `_score` function (lines 34-46) and its `import fitz` if it becomes unused elsewhere — it is still used by the final assertion in `test_pua_free_clears_the_garbage`, so keep the import. Replace the helper with an import at the top, next to the other imports:

```python
from junk_metric import junk_fonts, score_pdf
```

Then update the three call sites, which currently unpack two values and must now unpack three:

```python
def test_default_gid_leaves_thai_block_garbage(tmp_path):
    out = str(tmp_path / "gid.pdf")
    pdf_cmap_fix.patch_pdf(FIXTURE, output_path=out, write_file=True)
    _, junk, _ = score_pdf(out)
    assert junk > 0, "fixture no longer reproduces issue #16 under the default gid tree"


def test_pua_free_clears_the_garbage(tmp_path):
    out = str(tmp_path / "pua.pdf")
    pdf_cmap_fix.patch_pdf(
        FIXTURE, output_path=out, write_file=True, font_lookup_dir=_pua_free_dir()
    )
    tib, junk, _ = score_pdf(out)
    assert junk == 0, f"PUA-free tree should leave no garbage, got {junk} junk chars"
    assert tib > 100, f"expected real Tibetan after repair, got {tib}"
    assert EXPECTED_TIBETAN in fitz.open(out)[0].get_text()
```

Also update the module docstring: the sentence "It mirrors `_patch_best` in web/worker.js" should now read "Scoring lives in `tests/junk_metric.py`, which mirrors `web/worker.js`."

- [ ] **Step 5: Port the same logic into the worker**

In `web/worker.js`, inside the `py.runPythonAsync` block at boot (currently lines 26-78), replace `_score_pdf` and `_patch_best` entirely. The `import` line at the top of that block must gain `re`:

```python
import os, re, shutil, pdf_cmap_fix, pymupdf
```

Then:

```python
_PUA_FREE = pdf_cmap_fix.FONT_LOOKUP_DIR.parent / "font_lookup_gid_pua_free"
_CTRL_PICS = re.compile("[\\u2400-\\u2422\\u2424]")
_SUBSET_PREFIX = re.compile(r"^[A-Z]{6}\\+")

def _is_hard_junk(cp):
    # Junk is deliberately narrow: only codepoints that cannot come from
    # legitimate text. Counting every non-Tibetan codepoint above 0x7F made
    # every PDF mixing Tibetan with English or Sanskrit report as "partially
    # repaired" — Sanskrit diacritics, curly quotes and em-dashes are normal.
    return (0xE000 <= cp <= 0xF8FF     # Private Use Area
            or 0x0E00 <= cp <= 0x0E7F  # Thai block — the issue #16 signature
            or cp == 0xFFFD)

def _clean(s):
    # Legacy fonts map their space glyph to U+2423 OPEN BOX and the /ToUnicode
    # carries it through; the extraction path already undoes this.
    return _CTRL_PICS.sub("", s.replace("\\u2423", " "))

def _score_pdf(path):
    # Returns (tibetan, hard junk, sample). The sample is the first 3 lines
    # carrying Tibetan, capped at 200 chars — collected in this same pass, so
    # the R3 report costs no extra extraction.
    d = pymupdf.open(path)
    tib = junk = 0
    sample = []
    for p in range(d.page_count):
        for line in _clean(d[p].get_text()).split("\\n"):
            has_tib = False
            for c in line:
                o = ord(c)
                if 0x0F00 <= o <= 0x0FFF:
                    tib += 1; has_tib = True
                elif _is_hard_junk(o):
                    junk += 1
            if has_tib and len(sample) < 3 and line.strip():
                sample.append(line.strip())
    d.close()
    return tib, junk, "\\n".join(sample)[:200]

def _junk_fonts(path):
    # Needs the dict extraction, which is heavier than get_text(). Callers run
    # this only when junk was actually found, so a clean file never pays for it.
    d = pymupdf.open(path)
    names = set()
    for p in range(d.page_count):
        for blk in d[p].get_text("dict").get("blocks", []):
            if blk.get("type", 0) != 0:
                continue
            for line in blk.get("lines", []):
                for span in line.get("spans", []):
                    if any(_is_hard_junk(ord(c)) for c in _clean(span.get("text", ""))):
                        names.add(_SUBSET_PREFIX.sub("", span.get("font") or "?"))
    d.close()
    return sorted(names)

def _patch_best(src, dst):
    res = pdf_cmap_fix.patch_pdf(src, output_path=dst, write_file=True)
    stats = dict(res.get("stats", {}))
    tib, junk, sample = _score_pdf(dst)
    strategy = "gid"
    if junk > 0 and _PUA_FREE.is_dir():
        cand = "/_cand_pua.pdf"
        res2 = pdf_cmap_fix.patch_pdf(src, output_path=cand, write_file=True,
                                      font_lookup_dir=_PUA_FREE)
        tib2, junk2, sample2 = _score_pdf(cand)
        # Prefer the output with the least junk, breaking ties on most Tibetan.
        if (junk2, -tib2) < (junk, -tib):
            shutil.copyfile(cand, dst)
            stats = dict(res2.get("stats", {}))
            tib, junk, sample, strategy = tib2, junk2, sample2, "gid-pua-free"
        try:
            os.unlink(cand)
        except OSError:
            pass
    stats["tibetan_chars"] = tib
    stats["junk_chars"] = junk
    stats["sample"] = sample
    stats["junk_fonts"] = _junk_fonts(dst) if junk > 0 else []
    stats["strategy"] = strategy
    return stats
```

Note the doubled backslashes: this Python lives inside a JS template literal, so `␣` must be written `\\u2423` and `\n` as `\\n`. The existing code at `web/worker.js:145-149` already follows this convention — match it exactly.

- [ ] **Step 6: Run the full suite to verify it passes**

Run: `python3 -m pytest tests/ -q`
Expected: PASS, all tests. If `test_clean_repair_reports_no_junk` fails with a non-zero junk count, the `_clean` normalisation is not being applied before scoring.

- [ ] **Step 7: Commit**

```bash
git add tests/junk_metric.py tests/test_junk_metric.py tests/test_issue16_escalation.py web/worker.js
git commit -m "fix(worker): count only genuine mapping garbage as junk

_score_pdf counted every non-Tibetan codepoint above 0x7F, so thrangu-p1.pdf
— repaired perfectly — reported 4 junk chars that were all U+2423 OPEN BOX,
i.e. spaces, and landed in the 'partially repaired' branch. Any Tibetan PDF
containing English or Sanskrit hit the same wall.

Junk is now Private Use Area, Thai block, or U+FFFD only, with U+2423
normalised to a space first. thrangu drops to 0 (and stops triggering a
wasted second patch pass); issue16 keeps 39 under gid and 0 under PUA-free,
so the #16 guard survives. Junk is now attributed to the offending font, and
the R3 sample is captured in the same pass."
```

---

## Task 2: Render the R3 report

**Files:**
- Modify: `web/app.js:354-423` (`renderPdfResult`)

**Interfaces:**
- Consumes: the stats dict from Task 1 — `junk_chars`, `junk_fonts`, `sample`, `tibetan_chars`, `patched`, `fonts_seen`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Replace `renderPdfResult`**

Replace the whole function body. `esc`, `download`, `baseName`, `toast` and `showView` are already in scope in the IIFE.

```js
  function renderPdfResult(s, pdfBytes) {
    const seen    = s.fonts_seen || 0;
    const fixed   = s.patched || 0;
    const tibetan = s.tibetan_chars || 0;
    const junk    = s.junk_chars || 0;
    const junkFonts = s.junk_fonts || [];
    const sample  = s.sample || '';
    const pages   = (state.analysis && state.analysis.page_count) || 0;
    // junk is now narrow: PUA, Thai block or U+FFFD only. A file mixing Tibetan
    // with English or Sanskrit no longer trips it, so junk > 0 genuinely means
    // some runs still copy as garbage.
    const hasTibetan = tibetan >= 8;
    const phase =
      junk === 0 && fixed > 0  ? 'ok' :
      junk === 0 && hasTibetan ? 'already' :
      hasTibetan               ? 'partial' :
                                 'cant';

    const badgeOk = `<div class="badge-ok"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg></div>`;
    const badgeWarn = `<div class="badge-warn"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v6"/><path d="M12 17h.01"/></svg></div>`;

    const fontList = junkFonts.map((f) => `<span class="fontname">${esc(f)}</span>`).join(', ');
    const head =
      phase === 'ok' ? `${badgeOk}
          <div><h3>Your PDF is fixed</h3><p>Here's what copying from it gives you now.</p></div>`
    : phase === 'already' ? `${badgeOk}
          <div><h3>This PDF is already fine</h3><p>Its Tibetan already extracts as correct Unicode — no repair was needed. Here's what copying from it gives you.</p></div>`
    : phase === 'partial' ? `${badgeWarn}
          <div><h3>Mostly fixed — ${junkFonts.length === 1 ? 'one font' : 'some fonts'} we don't cover</h3><p>${tibetan.toLocaleString()} Tibetan characters came out correctly. The runs set in ${fontList || 'one legacy font'} still copy as garbage — ${junkFonts.length === 1 ? "that font isn't" : "those fonts aren't"} in our database yet. Sending us the file is how ${junkFonts.length === 1 ? 'it gets' : 'they get'} added.</p></div>`
    : `${badgeWarn}
          <div><h3>This PDF couldn't be repaired</h3><p>None of its ${seen} fonts are in our recognition database, so its Tibetan can't be turned into Unicode. This file uses legacy fonts we don't cover yet.</p></div>`;

    // The proof: show the repaired Tibetan rather than counting it. 'cant'
    // produced nothing usable, so it shows neither sample nor figures.
    const proof = (phase !== 'cant' && sample)
      ? `<div class="textbox proof">${esc(sample).split('\n').map((l) => `<span class="ln">${l}</span>`).join('')}</div>`
      : '';
    const figures = phase === 'cant' ? '' : `
        <div class="proofline">
          <span>${fixed} font${fixed === 1 ? '' : 's'} repaired</span><span class="dot"></span>
          <span>${pages} page${pages === 1 ? '' : 's'}</span><span class="dot"></span>
          <span>${tibetan.toLocaleString()} Tibetan characters</span>
        </div>`;

    const extractBtn = `<button class="btn btn-accent" id="to-extract"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M9 13h6M9 17h6"/></svg> Extract text</button>`;
    const dlBtn = `<button class="btn btn-primary" id="dl"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/></svg> Download fixed PDF</button>`;
    const sendBtn = `<a class="btn btn-accent" href="mailto:eroux@bdrc.io?subject=${encodeURIComponent('Unsupported Tibetan PDF')}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="m22 7-10 6L2 7"/></svg> Send us this PDF</a>`;
    const doAnother = `<button class="btn btn-quiet" onclick="App.reset()" style="margin-left:auto">Do another</button>`;

    const actions =
      phase === 'ok'      ? `${dlBtn} ${extractBtn} ${doAnother}` :
      phase === 'already' ? `${extractBtn} ${doAnother}` :
      phase === 'partial' ? `${dlBtn} ${extractBtn} ${sendBtn} ${doAnother}` :
                            `${sendBtn} <button class="btn btn-quiet" onclick="App.reset()" style="margin-left:auto">Try another</button>`;

    $('view-result').innerHTML = `
      <div class="panel swap-enter">
        <div class="result-head">${head}</div>
        ${proof}
        ${figures}
        <div class="btn-actions" style="flex-wrap:wrap">${actions}</div>
      </div>`;
    if ($('dl')) {
      $('dl').addEventListener('click', () => {
        download(pdfBytes, baseName() + '.fixed.pdf', 'application/pdf');
        toast('Downloaded.');
      });
    }
    const extract = $('to-extract');
    if (extract) extract.addEventListener('click', () => { state.mode = 'extract'; process(); });
    showView('result');
  }
```

- [ ] **Step 2: Add the styles the report needs**

**Delete** the now-dead `.stats`, `.stat`, `.stat b` and `.stat span` rules at `web/styles.css:285-288`, and put the new rules in their place. `renderPdfResult` was their only consumer and this task removes the stat cards, so nothing in `web/` emits those class names afterwards — verify with `grep -n 'class="stats"\|class="stat"' web/app.js`, which must return nothing.

```css
/* R3 report: the proof is a sample of the repaired text, not a stat card. */
.textbox.proof { max-height: 200px; margin-top: 18px; }
.proofline {
  font-size:.82rem; color: var(--ink-faint); margin-top: 12px;
  display:flex; align-items:center; gap:8px; flex-wrap:wrap;
}
.proofline .dot { width:4px; height:4px; border-radius:50%; background: var(--line-strong); }
.fontname {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.9em;
  background: var(--paper-deep); border:1px solid var(--line);
  border-radius:5px; padding:1px 6px;
}
```

- [ ] **Step 3: Verify by hand in a browser**

There is no JS test harness for `app.js` in this repository (`tests/test_rtf_convert.mjs` covers the vendored converter only). Verify manually:

```bash
python3 -m http.server 8000 --directory web
```

Open `http://localhost:8000`, drop `tests/fixtures/thrangu-p1.pdf`, choose "Fix the PDF".
Expected: green badge, "Your PDF is fixed", a box of readable Tibetan, and the line `N fonts repaired · 1 page · 1 128 Tibetan characters`. No orange badge, no "Send us this PDF", no stat cards.

Then drop `tests/fixtures/issue16-p1.pdf`.
Expected: green badge as well — the PUA-free escalation clears it to 0 junk.

- [ ] **Step 4: Commit**

```bash
git add web/app.js web/styles.css
git commit -m "feat(ui): report a repair by showing the repaired text

Replaces the stat cards with the R3 format: verdict, a live sample of the
Tibetan as it now copies, and one quiet line of figures. The orange badge and
'Send us this PDF' are reserved for genuine junk, and the message now names
the font responsible instead of saying 'some fonts'."
```

---

## Task 3: Cache the patched PDF and tag blocks with their page

**Files:**
- Modify: `web/worker.js:85-125` (`analyze`, `fix`), `web/worker.js:127-243` (`extract`), `web/worker.js:245-255` (`onmessage`)

**Interfaces:**
- Consumes: `_patch_best` from Task 1.
- Produces:
  - Python: `_ensure_patched() -> dict` — patches `/in.pdf` to `/patched.pdf` once and memoises the stats in `_PATCH_CACHE`.
  - Worker message `{type:'extract'}` (no `pages` argument) resolves to `{page_count, blocks, text}` where each block is `{page:int, lines:[[run,…],…]}` and `run` is `{t,s,b,i,tib}`. **`pages_used` is gone** — the UI computes it. **`docxBytes` is gone too** — `extract` no longer builds a `.docx` at all, so it walks each page once instead of twice.
  - New worker message `{type:'docx', pages:'all'|'odd'|'even'}` resolves to `{type:'docx-built', docxBytes:Uint8Array}`.

- [ ] **Step 1: Add the patch cache at boot**

At the end of the boot-time Python block in `web/worker.js` (after `_patch_best`), add:

```python
_PATCH_CACHE = {}

def _ensure_patched():
    # fix and extract are the same patch operation. Doing it once means
    # fix -> extract, and switching page filters, cost nothing extra.
    if not _PATCH_CACHE:
        _PATCH_CACHE.update(_patch_best("/in.pdf", "/patched.pdf"))
    return dict(_PATCH_CACHE)
```

- [ ] **Step 2: Invalidate the cache when a new file is loaded**

In `analyze` (`web/worker.js:85-109`), immediately after `py.FS.writeFile('/in.pdf', bytes);`, add:

```js
  // A new document invalidates the memoised patch from the previous one.
  await py.runPythonAsync(`
import os
_PATCH_CACHE.clear()
try:
    os.unlink("/patched.pdf")
except OSError:
    pass
`);
```

- [ ] **Step 3: Route `fix` through the cache**

Replace `fix` (`web/worker.js:111-125`) with:

```js
async function fix() {
  post('progress', { phase: 'working' });
  // _ensure_patched runs gid, then escalates to the PUA-free tree if the output
  // still extracts hard junk, and memoises the result. junk_chars drives the
  // honest verdict: 0 = clean, > 0 = some runs still copy as garbage.
  const stats = await py.runPythonAsync(`
import json
json.dumps(_ensure_patched(), default=str)
`);
  const out = py.FS.readFile('/patched.pdf');
  return { stats: JSON.parse(stats), pdfBytes: out };
}
```

Note `/patched.pdf` is deliberately **not** unlinked — that is the point of the cache.

- [ ] **Step 4: Make `extract` process all pages and tag blocks**

In `extract` (`web/worker.js:127-243`), make four edits to the embedded Python:

1. Delete the `py.globals.set('_PAGES', pages || 'all');` line and the `pages` parameter from the function signature: `async function extract() {`.
2. Replace `_patch_best("/in.pdf", "/patched.pdf")` with `_ensure_patched()`.
3. Replace the page-selection block:

```python
d = pymupdf.open("/patched.pdf")
n = d.page_count
sel = list(range(n))
```

   (delete the two `if _PAGES ==` lines at `web/worker.js:184-185` entirely — filtering now happens in the browser).

4. Tag each emitted block with its page index. Change:

```python
        if disp_lines:
            blocks_out.append({"lines": disp_lines})
```

   to:

```python
        if disp_lines:
            blocks_out.append({"page": pi, "lines": disp_lines})
```

5. Change the returned JSON at the end of the block from
   `json.dumps({"page_count": n, "pages_used": len(sel), "blocks": blocks_out})`
   to
   `json.dumps({"page_count": n, "blocks": blocks_out})`.

**Remove the `/out.docx` generation from `extract` entirely** — delete the `_build_docx(d, sel, "/out.docx")` call, the `docxBytes` read, and both `py.FS.unlink` lines at the end of the JS wrapper. Every `.docx` now comes from the on-demand `docx` message in Step 5.

Rationale, decided with the project owner: building the `.docx` eagerly made `extract` walk every page twice, and always over all pages. On a 265-page book in odd mode that is 530 page extractions where the pre-change code did 133. Since most users never download a `.docx`, the eager build charged everyone for a rare action. One pass now, and `extract` ends up faster than it was before this plan started.

- [ ] **Step 5: Add the on-demand `.docx` builder**

Add a new function after `extract` in `web/worker.js`:

```js
// The .docx is serialised in Python, so a page filter cannot be applied in the
// browser the way the on-screen text can. Rebuild it on demand — /patched.pdf
// is cached, so this re-serialises without re-repairing.
async function buildDocx(pages) {
  post('progress', { phase: 'working' });
  py.globals.set('_PAGES', pages || 'all');
  await py.runPythonAsync(`
d = pymupdf.open("/patched.pdf")
sel = list(range(d.page_count))
if _PAGES == 'odd':    sel = [i for i in sel if i % 2 == 0]   # 1-based odd  -> 0,2,4...
elif _PAGES == 'even': sel = [i for i in sel if i % 2 == 1]   # 1-based even -> 1,3,5...
_build_docx(d, sel, "/out.docx")
d.close()
`);
  const docxBytes = py.FS.readFile('/out.docx');
  py.FS.unlink('/out.docx');
  return { docxBytes };
}
```

This requires the docx-building loop inside `extract` to be extracted into a reusable `_build_docx(doc, sel, out_path)` function defined in the boot block, so both paths share it. Move the body — from `doc = Document()` through `doc.save("/out.docx")` — into:

```python
def _build_docx(d, sel, out_path):
    doc = Document()
    doc.styles['Normal'].font.name = LATIN_FONT
    for pi in sel:
        for blk in d[pi].get_text("dict").get("blocks", []):
            ...  # the existing loop body, writing paragraphs
    doc.save(out_path)
```

`extract` then calls `_build_docx(d, sel, "/out.docx")` while still building `blocks_out` and `plain` in its own loop. Keep the two loops separate rather than trying to share one — the display model and the docx model have diverged enough that merging them would be harder to follow than a second pass over the same pages.

`TIB_FONT`, `LATIN_FONT`, `_XML_BAD`, `_CTRL_PICS`, `_xml_clean`, `_attrs`, `_is_tibetan` and `_set_font` must move from the `extract` Python block into the **boot** block so `_build_docx` can see them. Note the boot block already defines a `_CTRL_PICS`; keep one definition and delete the duplicate.

- [ ] **Step 6: Wire the new message**

In `self.onmessage` (`web/worker.js:245-255`), change the extract line and add the docx line:

```js
    if (m.type === 'extract') { const r = await extract();          return post('extracted', r); }
    if (m.type === 'docx')    { const r = await buildDocx(m.pages); return post('docx-built', r, [r.docxBytes.buffer]); }
```

- [ ] **Step 7: Verify by hand**

Run `python3 -m http.server 8000 --directory web`, drop `tests/fixtures/thrangu-p1.pdf`, choose "Extract text".
Expected: text appears. Then click "Fix the PDF" from the result.
Expected: the fix returns **noticeably faster than the first extraction**, because `/patched.pdf` is reused. Check the browser console for errors — `_build_docx` referencing a name still scoped to the old `extract` block is the likely failure and shows up as a `NameError`.

- [ ] **Step 8: Commit**

```bash
git add web/worker.js
git commit -m "refactor(worker): patch once, tag blocks with their page

fix and extract perform the same repair, and every page-filter change re-ran
it. _ensure_patched memoises /patched.pdf for the loaded document and both
paths go through it; analyze invalidates it.

extract now always processes every page and tags each block with its page
index, so the UI can filter client-side. The .docx cannot be filtered in the
browser, so it gets a separate on-demand message reusing the cached patch."
```

---

## Task 4: Move page filtering into the extraction result

**Files:**
- Modify: `web/app.js:289-298` (remove `#extract-opts`), `web/app.js:313-323` (its handlers), `web/app.js:332-346` (`process`), `web/app.js:450-485` (`renderTextResult`)

**Interfaces:**
- Consumes: the `extract` payload from Task 3 — `{page_count, blocks:[{page, lines}], text, docxBytes}`, and the `docx` message.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Strip page selection from the config screen**

In `renderConfig`, delete the entire `<div id="extract-opts" …>` block (`web/app.js:289-298`) from the template, and delete the `pages-seg` handler block (`web/app.js:319-323`):

```js
    const seg = $('pages-seg');
    if (seg) seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { … }));
```

In the tile click handler just above it, delete the line `$('extract-opts').hidden = state.mode !== 'extract';` — the element no longer exists and leaving it throws.

In `handleFile` (`web/app.js:130`), drop `pages: 'all'` from the initial state object; page selection now belongs to the result view.

- [ ] **Step 2: Drop the `pages` argument from the extract call**

In `process` (`web/app.js:342`), change:

```js
        const r = await call('extract', { pages: state.pages || 'all' });
```

to:

```js
        const r = await call('extract');
```

- [ ] **Step 3: Rewrite `renderTextResult` with client-side filtering**

Replace the whole function:

```js
  function renderTextResult(r) {
    // Page filtering is just a filter over blocks the worker already returned —
    // no re-extraction, no worker round-trip. Each block carries its 0-based
    // page index; 1-based "odd" pages are the even indices.
    const all = r.blocks || [];
    let sel = 'all';

    const keep = (b) => sel === 'all'
      || (sel === 'odd' && b.page % 2 === 0)
      || (sel === 'even' && b.page % 2 === 1);

    const textOf = (blocks) => blocks
      .map((b) => (b.lines || []).map((ln) => ln.map((run) => run.t).join('')).join('\n'))
      .join('\n');

    $('view-result').innerHTML = `
      <div class="panel swap-enter">
        <div class="result-head">
          <div class="badge-ok"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg></div>
          <div><h3>Text extracted</h3><p>Formatting preserved · Jomolhari for Tibetan</p></div>
        </div>
        <div class="texttools">
          <div class="seg" id="pages-seg">
            <button data-pages="all" class="on">All pages</button>
            <button data-pages="odd">Odd</button>
            <button data-pages="even">Even</button>
          </div>
          <span class="fmt" id="text-meta"></span>
        </div>
        <div class="textbox rich" id="textbox"></div>
        <div class="btn-actions" style="flex-wrap:wrap">
          <button class="btn btn-primary" id="copy"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy</button>
          <button class="btn btn-ghost" id="save">.txt</button>
          <button class="btn btn-ghost" id="save-docx">.docx</button>
          <button class="btn btn-accent" id="to-fix"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 12 2 2 4-4"/><path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg> Fix the PDF</button>
          <button class="btn btn-quiet" onclick="App.reset()" style="margin-left:auto">Do another</button>
        </div>
      </div>`;

    function paint() {
      const blocks = all.filter(keep);
      const text = textOf(blocks);
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      const used = new Set(blocks.map((b) => b.page)).size;
      $('textbox').innerHTML = renderBlocks(blocks)
        || '<span style="color:var(--ink-faint)">No extractable text on the selected pages.</span>';
      $('text-meta').textContent =
        `${used} of ${r.page_count} page${r.page_count === 1 ? '' : 's'} · ${words.toLocaleString()} words`;
      return text;
    }
    let text = paint();

    const seg = $('pages-seg');
    seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      sel = b.dataset.pages;
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      text = paint();
    }));

    $('copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); toast('Copied to clipboard.'); }
      catch (_) { toast('Could not copy automatically — select the text.'); }
    });
    $('save').addEventListener('click', () => {
      download(text, baseName() + '.txt', 'text/plain;charset=utf-8');
    });
    $('save-docx').addEventListener('click', async () => {
      const btn = $('save-docx');
      // extract no longer builds a .docx — every selection, including "all", is
      // serialised on demand against the cached patched PDF.
      btn.disabled = true;
      const prev = btn.textContent;
      btn.textContent = 'Building…';
      try {
        const d = await call('docx', { pages: sel });
        // "all" keeps the plain name; a filtered download says which half it is.
        const suffix = sel === 'all' ? '' : '.' + sel;
        download(d.docxBytes, baseName() + suffix + '.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      } catch (err) {
        toast('Could not build the .docx.');
      } finally {
        btn.disabled = false; btn.textContent = prev;
      }
    });
    $('to-fix').addEventListener('click', () => { state.mode = 'fix'; process(); });
    showView('result');
  }
```

- [ ] **Step 4: Verify by hand**

Run `python3 -m http.server 8000 --directory web`, drop a multi-page Tibetan PDF, choose "Extract text".

Expected:
- The config screen no longer offers All/Odd/Even.
- The result shows the segmented control above the text.
- Clicking Odd then Even re-renders **instantly**, with no spinner and no worker traffic. Confirm in DevTools → Network that nothing fires.
- The `N of M pages · W words` line updates with each switch.
- Copy and `.txt` reflect the current selection.
- `.docx` with "All pages" downloads immediately; with Odd it shows "Building…" then downloads `<name>.odd.docx`.

- [ ] **Step 5: Commit**

```bash
git add web/app.js
git commit -m "feat(ui): choose pages from the result, not before extracting

Page selection was asked for on the config screen, before the user could see
what they were getting, and changing it meant starting over. It is a filter
over pages, not a different extraction, so it now lives above the extracted
text and filters blocks in the browser — switching is instant.

The .docx is serialised in Python and cannot be filtered client-side, so a
non-default selection rebuilds it on click against the cached patched PDF."
```

---

## Task 5: Vermillon palette and the button wrap

**Files:**
- Modify: `web/styles.css:9-41` (tokens), plus the 43 colour literals outside `:root`, plus `web/styles.css:255`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

This task is independent of Tasks 1-4 and can be done in any order relative to them.

- [ ] **Step 1: Replace the token values**

In `web/styles.css:9-41`:

```css
  /* paper & ink palette — "Vermillon" */
  --paper:        #f7f2e8;
  --paper-deep:   #f0e7d6;
  --card:         #fffefb;
  --ink:          #1c1309;
  --ink-soft:     #4b3f31;
  --ink-faint:    #877a64;
  --line:         #e2d7c1;
  --line-strong:  #d0c09f;

  /* monastic accent — vermilion rather than the former muted maroon.
     The token names are deliberately unchanged; renaming is a separate task. */
  --maroon:       #b5342a;
  --maroon-deep:  #8f2419;
  --saffron:      #d97528;
  --saffron-soft: #f0ad63;
  --gold:         #c0912f;

  --ok:           #3f7a52;
  --warn:         #b8691c;
```

- [ ] **Step 2: Take an inventory of what still needs changing**

Run:

```bash
awk 'NR>42' web/styles.css | grep -nEo '#[0-9a-fA-F]{3,8}|rgba?\([0-9., ]+\)' | sort | uniq -c | sort -rn
```

Expected before the work: 43 literals. Line numbers reported are offset by 42 — add 42 to get the real line.

- [ ] **Step 3: Convert every literal to a token**

Work through the list. Use `color-mix(in srgb, …)` where a tint of a token is wanted, so the value tracks the palette instead of being re-hardcoded. The sites, with real line numbers:

| Line | What | Replace with |
|---|---|---|
| 64-66 | `body::before` glows keyed to the OLD maroon/saffron | `rgba(217,117,40,.10)`, `rgba(181,52,42,.06)`, `rgba(192,145,47,.06)` |
| 96 | `.mark` drop-shadow `rgba(138,43,34,.18)` | `rgba(181,52,42,.18)` |
| 104 | `.byline a` border `rgba(138,43,34,.25)` | `rgba(181,52,42,.25)` |
| 112 | `.eyebrow` background `rgba(255,253,248,.6)` | `color-mix(in srgb, var(--card) 60%, transparent)` |
| 147 | `.drop.drag` gradient `#fffdf8, #fbf3e8` | `linear-gradient(180deg, var(--card), var(--paper-deep))` |
| 153 | `.drop-ico` radial `#fbeada, #f4e2c9` | `radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--saffron-soft) 26%, var(--card)), color-mix(in srgb, var(--saffron-soft) 42%, var(--card)))` |
| 169 | `.doc-ico` gradient `#fbeede, #f1dcc0` | `linear-gradient(160deg, color-mix(in srgb, var(--saffron-soft) 20%, var(--card)), color-mix(in srgb, var(--saffron-soft) 38%, var(--card)))` |
| 173 | `.doc-ico::after` `#e7d3b3` | `var(--line-strong)` |
| 210 | `.tile.on` gradient `#fffdf8, #fcf4ea` + ring `rgba(138,43,34,.10)` | `linear-gradient(180deg, var(--card), color-mix(in srgb, var(--saffron-soft) 12%, var(--card)))`, ring `color-mix(in srgb, var(--maroon) 12%, transparent)` |
| 212 | `.tile.on .ti` `#fff` | `#fff` — keep, it is text on `--maroon` |
| 237-245 | `.btn-primary` shadows `rgba(44,28,12,…)`, `rgba(138,43,34,.45)` | keep the neutral `rgba(44,28,12,…)` shadows; change `rgba(138,43,34,.45)` to `rgba(181,52,42,.45)` |
| 247 | `.btn-ghost:hover` `#fff` | `var(--card)` |
| 249-250 | `.btn-accent` `#f5e7ce` / `#efddbb`, shadow `rgba(200,100,42,.38)` | `color-mix(in srgb, var(--saffron-soft) 34%, var(--card))` / `color-mix(in srgb, var(--saffron-soft) 46%, var(--card))`, shadow `rgba(217,117,40,.38)` |
| 264 | `.mandala .dot` `#fbeada, #e9c79b` | `radial-gradient(circle, color-mix(in srgb, var(--saffron-soft) 26%, var(--card)), var(--saffron-soft))` |
| 277-278 | `.badge-ok` gradient `#4a8b60, #3f7a52` | `var(--ok)` flat (drop the gradient — the palette has no second green) |
| 279-280 | `.badge-warn` gradient `#e8a35a, #c8642a` | `linear-gradient(180deg, var(--saffron-soft), var(--saffron))` |
| 299 | `.textbox` `#fffefb` | `color-mix(in srgb, var(--card) 88%, var(--paper))` |
| 303 | `.textbox` inset shadow `rgba(44,28,12,.03)` | keep — neutral |
| 305 | scrollbar border `#fffefb` | `var(--card)` |
| 315 | `.err .x` gradient `#b5483c, #8a2b22` | `linear-gradient(180deg, var(--maroon), var(--maroon-deep))` |
| 323 | `footer .feedback a` `rgba(138,43,34,.25)` | `rgba(181,52,42,.25)` |
| 324 | `.credit` border fallback `rgba(0,0,0,.08)` | keep — it is a fallback |
| 364 | `.toast` colour `#fbf3e8` | `var(--paper-deep)` |

`#fff` used as foreground on a `--maroon` or `--ok` background stays `#fff` — those are contrast decisions, not palette values.

- [ ] **Step 4: Fix the button wrap**

At `web/styles.css:255`, replace:

```css
.btn-actions .btn-primary { width:auto; flex:1; }
```

with:

```css
/* flex:1 resolves to flex-basis:0, so the primary was squeezed by its siblings
   and "Download fixed PDF" wrapped onto two lines. */
.btn-actions .btn-primary { width:auto; flex:0 0 auto; white-space:nowrap; }
```

- [ ] **Step 5: Re-run the inventory to verify**

Run the Step 2 command again.
Expected: only neutral shadows (`rgba(44,28,12,…)`), `#fff` foregrounds, and the `rgba(0,0,0,.08)` fallback remain. No `rgba(138,43,34,…)`, no `rgba(200,100,42,…)`, no `#8a2b22`, no `#f5e7ce`.

Run: `grep -nE 'rgba\(138,43,34|rgba\(200,100,42|#8a2b22|#c8642a|#e8a35a|#f5e7ce|#fbeada' web/styles.css`
Expected: no output.

- [ ] **Step 6: Verify by hand**

Run `python3 -m http.server 8000 --directory web` and walk every screen: upload, config, processing, result (fix), result (extract), and the error view (drop a non-PDF to trigger it).
Expected: no residual muted-maroon element, the primary button label on one line, and the badge/spinner colours consistent with the vermilion accent.

- [ ] **Step 7: Commit**

```bash
git add web/styles.css
git commit -m "feat(ui): repaint in the Vermillon palette

The former palette sat in a narrow warm band: paper and card were ~4% of
luminance apart so panels never detached from the background, and the brown
ink cost text contrast. Vermillon deepens the ink, whitens the card and
replaces the muted maroon with a live vermilion.

Also converts the 43 colour literals outside :root to tokens or color-mix on
tokens — six of them still referenced the old maroon, which would have left
the palette incoherent — and fixes the primary result button, whose flex:1
basis of 0 wrapped 'Download fixed PDF' onto two lines."
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| 1 — Palette Vermillon (tokens) | Task 5 Step 1 |
| 1 — 43 hardcoded literals | Task 5 Steps 2-3, 5 |
| 2 — Narrowed junk definition | Task 1 Step 5 |
| 2 — Normalisation before scoring | Task 1 Step 5 (`_clean`) |
| 2 — Two-speed font attribution | Task 1 Step 5 (`_junk_fonts`, called only when `junk > 0`) |
| 2 — Sample capture, zero cost | Task 1 Step 5 (`_score_pdf`) |
| 2 — Escalation on hard junk only | Task 1 Step 5 (`_patch_best`) |
| 2 — Stats contract | Task 1 Interfaces |
| 3 — R3 report, four phases | Task 2 Step 1 |
| 3 — Names the offending fonts | Task 2 Step 1 (`fontList`) |
| 3 — `cant` shows no sample/figures | Task 2 Step 1 (`proof` / `figures` guards) |
| 4 — Remove `#extract-opts` | Task 4 Step 1 |
| 4 — Blocks tagged with page | Task 3 Step 4 |
| 4 — Client-side filter, instant | Task 4 Step 3 |
| 4 — `.docx` on demand | Task 3 Step 5, Task 4 Step 3 |
| 4 — `/patched.pdf` cache + invalidation | Task 3 Steps 1-3 |
| 5 — Button wrap | Task 5 Step 4 |
| Testing — three assertions | Task 1 Step 2 |

No gaps.

**Type consistency**

- `_score_pdf` returns a 3-tuple everywhere it is defined (worker) or mirrored (`tests/junk_metric.py:score_pdf`), and all four call sites unpack three values.
- `junk_fonts` / `_junk_fonts` return `list[str]`; consumed in Task 2 as `s.junk_fonts` with `.map`/`.length`.
- `blocks` gains `page:int` in Task 3 Step 4 and is read as `b.page` in Task 4 Step 3.
- `pages_used` is removed from the extract payload in Task 3 Step 4 and is not referenced in the Task 4 rewrite — it is recomputed as `used`.
- `renderBlocks` (`web/app.js:425-448`) is unchanged and ignores the new `page` key; it reads only `b.lines`.
- Worker message names: `extract` → `extracted`, `docx` → `docx-built`. `call()` (`web/app.js:63-68`) resolves on any non-progress, non-error message, so the response type string is not matched — no change needed there.

**Placeholder scan**

No "TBD", no "add error handling", no "similar to Task N". Every code step carries its actual content. The one judgement call left to the implementer is the exact `color-mix` percentages in Task 5 Step 3, which are given as concrete starting values.

**Known risk, accepted**

`tests/junk_metric.py` mirrors Python that lives inside a JS template literal in `web/worker.js`; nothing enforces that they stay identical. Extracting the worker's Python into a fetched `.py` file would fix this properly but changes asset loading and service-worker caching, which is outside the approved scope. The mirror is now in one file instead of two, and both Task 1 commit and the helper's docstring say to change them together.
