#!/usr/bin/env bash
# Build the pure-python pdf-cmap-fix wheel into web/wheels/ so it can be served
# same-origin and installed in the browser via micropip. Run once locally; CI
# runs it before deploying to GitHub Pages.
set -euo pipefail
cd "$(dirname "$0")/.."

# Pinned, validated commit of pdf-cmap-fix (bundles the legacy tiblegenc tables).
# 103977e = merge of PR #14: synthesize ToUnicode for legacy fonts with none
# (Type1/CFF + symbolic subsets) — fixes "N fonts found, 0 fixed" PDFs.
PIN=103977ebc50626819df2c4b6e9df61af1f07fa60
OUT=web/wheels

mkdir -p "$OUT"
rm -f "$OUT"/pdf_cmap_fix-*.whl
python3 -m pip wheel "git+https://github.com/OpenPecha/pdf-cmap-fix.git@${PIN}" \
  --no-deps -w "$OUT"

echo "→ wheel built in $OUT:"
ls -1 "$OUT"
