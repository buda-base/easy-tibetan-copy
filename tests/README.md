# Tests

Regression guards for the two failures that once reached production, both built
from the same real document (BDRC `IE3JT13381`, *Thrangu Sungtsom Thorbu*):

| Test | Guards | Engine |
|------|--------|--------|
| `test_pdf_repair.py` | (1) "N fonts found, 0 fixed" — legacy Type1 Tibetan with no `/ToUnicode` must be repaired by synthesis (pdf-cmap-fix PR #14); catches a stale/wrong bundled-wheel pin. (2) The legacy space glyph extracting as U+2423 "␣"; the worker normalizes it back to a real space. | bundled wheel + PyMuPDF |
| `test_rtf_convert.mjs` | A stray `?` / U+FFFD between every Tibetan character, across **both** RTF parsers: `convertRtf` (download) and `rtfToBlocks` (preview). Includes the production scenario — re-uploading a converted `.rtf` whose `\uc1 \uNNNN?` escapes must have their `?` fallbacks skipped, not leaked. | vendored `tibetan-ansi-to-unicode` |

Fixtures live in `fixtures/` (page 1 of the PDF; first paragraph of the RTF).

## Run locally

```bash
# PDF (needs the bundled wheel + its runtime deps)
./scripts/build-wheel.sh
pip install web/wheels/*.whl pymupdf fonttools pytest
python -m pytest tests/test_pdf_repair.py -q

# RTF (no install needed)
node tests/test_rtf_convert.mjs
```

CI runs both on every push — see `.github/workflows/test.yml`.
