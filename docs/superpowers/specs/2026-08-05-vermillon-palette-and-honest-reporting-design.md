# Vermillon palette & honest reporting — design

**Date:** 2026-08-05
**Branch:** `feat/vermillon-palette-and-honest-reporting`
**Status:** approved, ready for implementation planning

## Problem

Four issues, reported together after using the deployed tool.

1. **The palette reads flat.** Nothing in the interface carries energy.
2. **The result report is alarming when it should be reassuring.** A successfully
   repaired PDF is routinely labelled "Partially repaired" with an orange badge
   and a "Still garbled: N" counter.
3. **Page selection (All/Odd/Even) is asked for too early** — on the config
   screen, before the user knows what they are getting — and cannot be changed
   afterwards.
4. **The primary result button wraps onto two lines.**

### Root cause of (2) — measured, not assumed

`_score_pdf` in `web/worker.js:45-52` counts as "junk" **every** codepoint above
`0x7F` that is not in the Tibetan block. Measured against the repository's own
fixtures, using the bundled `pdf_cmap_fix-0.4.0` wheel:

| fixture | Tibetan recovered | "junk" reported | what it actually is |
|---|---|---|---|
| `thrangu-p1.pdf` (gid) | 1128 | **4** | 4 × `U+2423 OPEN BOX` — spaces |
| `issue16-p1.pdf` (gid) | 1501 | 64 | 39 genuine (Thai block) + 17 `°` + 4 `¶` |
| `issue16-p1.pdf` (pua-free) | 1575 | 0 | — |

`thrangu-p1.pdf` is repaired perfectly and is nonetheless reported as
`partial`. The irony is that `web/worker.js:147-153` already knows `U+2423` is a
space and converts it back — but only on the extraction path, never in the
scorer.

The false-positive class is much wider than `U+2423`: Sanskrit diacritics
(ā ī ū ṃ ḥ ś ṣ ṭ ḍ), curly quotes, em-dashes, accented Latin and CJK are all
counted as garbage. **Any Tibetan PDF containing English or Sanskrit will land in
`partial`.**

Two consequences, not one:

- A falsely alarming verdict (`web/app.js:366-370`).
- `_patch_best` re-patches the whole PDF whenever `junk > 0`, so a complete
  second pass is triggered by four spaces.

## Decisions

| # | Decision |
|---|---|
| D1 | Palette **Vermillon** (chosen from 7 mockups; user oscillated with "Safran en tête" and settled on Vermillon) |
| D2 | Report format **R3 — proof by example**: verdict, a live sample of the repaired Tibetan, one quiet line of figures. No stat cards. |
| D3 | Page filtering moves **out of config and into the extraction result**, applied client-side |
| D4 | "Junk" is narrowed to codepoints that can only come from a broken mapping |
| D5 | Token **names** are not renamed (`--maroon` keeps its name while holding a vermilion). Renaming is a separate concern. |

## 1 — Palette Vermillon

### Token values (`web/styles.css:9-41`)

| token | from | to |
|---|---|---|
| `--paper` | `#f6f1e7` | `#f7f2e8` |
| `--paper-deep` | `#efe7d7` | `#f0e7d6` |
| `--card` | `#fffdf8` | `#fffefb` |
| `--ink` | `#20140a` | `#1c1309` |
| `--ink-soft` | `#4f4334` | `#4b3f31` |
| `--ink-faint` | `#8a7c66` | `#877a64` |
| `--line` | `#e3d8c2` | `#e2d7c1` |
| `--line-strong` | `#d4c6aa` | `#d0c09f` |
| `--maroon` | `#8a2b22` | `#b5342a` |
| `--maroon-deep` | `#6e1f18` | `#8f2419` |
| `--saffron` | `#c8642a` | `#d97528` |
| `--saffron-soft` | `#e8a35a` | `#f0ad63` |
| `--gold` | `#b6892f` | `#c0912f` |
| `--warn` | `#b06a1f` | `#b8691c` |
| `--ok` | `#3f7a52` | unchanged |

### Hardcoded colours that must follow

`web/styles.css` carries **43 colour literals outside `:root`**. Leaving them
untouched produces an incoherent palette. They must be converted to tokens (or
`color-mix` on tokens) — not merely re-hardcoded to new values.

Highest-signal sites:

- `:64-66` — `body::before` atmosphere glows, keyed to the *old* maroon/saffron
  (`rgba(200,100,42,…)`, `rgba(138,43,34,…)`, `rgba(182,137,47,…)`)
- `:96`, `:104`, `:112`, `:210`, `:242`, `:323` — six `rgba(138,43,34,…)` (old maroon)
- `:147` `.drop.drag`, `:153` `.drop-ico`, `:169`/`:173` `.doc-ico`, `:264` `.mandala .dot`
- `:210` `.tile.on`, `:249-250` `.btn-accent` (`#f5e7ce` / `#efddbb`)
- `:277-280` `.badge-ok` / `.badge-warn`, `:315` `.err .x` (contains a literal `#8a2b22`)
- `:299`/`:305` `.textbox`, `:364` `.toast`

**Acceptance:** no colour literal outside `:root` refers to a hue that is no
longer in the palette. Verified by re-running the inventory
(`grep -Eo '#[0-9a-fA-F]{3,8}|rgba?\(…\)'` over the file past `:root`).

## 2 — Narrowed junk metric (`web/worker.js`)

### New definition

A character counts as junk only if it can **only** come from a broken legacy
mapping:

- Private Use Area `U+E000–U+F8FF`
- Thai block `U+0E00–U+0E7F` (the issue #16 signature)
- `U+FFFD` replacement character

Before counting, apply the normalisation the extraction path already performs:
`U+2423 → space`, and drop the other Control Pictures `U+2400–U+2422`, `U+2424`.

### Measured effect

| fixture | current | narrowed |
|---|---|---|
| `thrangu-p1.pdf` (gid) | 4 | **0** |
| `issue16-p1.pdf` (gid) | 64 | **39**, all in `Monlam Uni OuChan3` |
| `issue16-p1.pdf` (pua-free) | 0 | **0** |

So the false positive disappears **and** the issue #16 guard still fires.

### Font attribution — two-speed

Naming the offending font requires `get_text("dict")`, which is heavier than
`get_text()`. Therefore:

- **Fast path** (`get_text()`): count Tibetan and hard junk. This is the only
  pass that runs on a clean file.
- **Attribution pass** (`get_text("dict")`): runs **only when hard junk > 0**,
  to collect the set of fonts responsible.

No added cost on the normal case, including a 265-page book.

### Sample capture for R3

The R3 sample is collected **during the existing fast pass**, which already walks
every page's text. Cost: zero additional extraction.

Definition: the first 3 non-empty lines that contain at least one Tibetan
codepoint, joined with newlines, truncated to 200 characters. Empty string if
the document yields none — in which case R3 falls back to the figures line
alone.

### Escalation

`_patch_best` escalates to the PUA-free tree on **hard** junk only. Consequence:
`thrangu-p1.pdf` stops triggering a wasted second full patch.

### Stats contract

`fix` returns, in addition to today's keys:

- `junk_chars` — hard junk count (redefined)
- `junk_fonts` — array of font names, empty unless `junk_chars > 0`
- `sample` — short string of repaired Tibetan for R3
- `tibetan_chars`, `strategy` — unchanged

## 3 — Report format R3 (`web/app.js renderPdfResult`)

Stat cards are removed. Four phases:

| phase | condition | badge | content |
|---|---|---|---|
| `ok` | `junk_chars === 0 && patched > 0` | green | "Your PDF is fixed" / "Here's what copying from it gives you now." + sample + quiet figures line |
| `already` | `junk_chars === 0 && tibetan >= 8 && patched === 0` | green | "This PDF is already fine" + sample |
| `partial` | `junk_chars > 0 && tibetan >= 8` | orange | "Mostly fixed — one font we don't cover", **names the fonts from `junk_fonts`**, + "Send us this PDF" |
| `cant` | otherwise | orange | today's wording, but stat cards dropped like the others |

The quiet figures line replaces the cards: `3 fonts repaired · 12 pages ·
1 128 Tibetan characters`. On `cant` there is no sample and no figures line —
nothing usable came out, so there is nothing to show.

Orange badge and "Send us this PDF" appear **only** on `partial` / `cant`.

## 4 — Page filtering in the extraction result

### Today

Config screen asks All/Odd/Even up front; `extract` filters pages inside the
worker (`web/worker.js:184-185`); changing the selection means starting over,
and re-running `extract` re-runs `_patch_best` (`web/worker.js:180`).

### Target

- The `#extract-opts` block is **removed** from `renderConfig`. The config screen
  asks only "fix or extract".
- `extract` always processes **all** pages and tags every emitted block with its
  page index (`{page: n, lines: [...]}`).
- The extraction result renders a segmented All/Odd/Even control above the text.
  Switching filters the already-returned blocks **in the browser** — instant, no
  worker round-trip.
- Word count, the "X of Y pages" line, Copy and `.txt` all derive from the
  filtered set.

### Two consequences to absorb

- **`.docx`** cannot be filtered client-side (it is serialised in Python). It is
  regenerated by a worker call **on click only**, for the current selection.
- The worker must **cache `/patched.pdf`** across calls, keyed to the loaded
  file, so neither re-extraction nor `.docx` regeneration re-patches the PDF.
  Invalidated by `reset()` / a new file.

## 5 — Button wrap (`web/styles.css:255`)

`.btn-actions .btn-primary { width:auto; flex:1 }` resolves to `flex-basis: 0`,
so the primary is squeezed by its siblings and its label wraps.

```css
.btn-actions .btn-primary { flex: 0 0 auto; white-space: nowrap; }
```

## Testing

New test replacing the broad assertion, without weakening the issue #16 guard:

- `thrangu-p1.pdf` → narrowed junk `== 0` (guards the false positive; this is the
  regression that motivated the change)
- `issue16-p1.pdf` under gid → narrowed junk `> 0`, attributed to
  `Monlam Uni OuChan3`
- `issue16-p1.pdf` under PUA-free → narrowed junk `== 0`

The existing `tests/test_issue16_escalation.py` scoring helper mirrors the
worker and must be updated in lockstep, or the two definitions drift.

## Out of scope — flagged, not done

- **Local env:** the globally installed `pdf_cmap_fix` is not the repository's
  wheel, so all three `tests/test_issue16_escalation.py` tests fail locally while
  CI passes. Install `web/wheels/*.whl` into a venv to reproduce CI.
- **Token rename** `--maroon` → `--accent` (mechanical, ~60 rules, separate concern).
- **Saffron interactive role** from the "Safran en tête" mockup — the hierarchy
  flip the user hesitated over. Can be grafted onto Vermillon later.
