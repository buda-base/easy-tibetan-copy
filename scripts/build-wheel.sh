#!/usr/bin/env bash
# Build the pure-python pdf-cmap-fix wheel into web/wheels/ so it can be served
# same-origin and installed in the browser via micropip. Run once locally; CI
# runs it before deploying to GitHub Pages.
set -euo pipefail
cd "$(dirname "$0")/.."

# Pinned, validated commit of pdf-cmap-fix.
# 5f0f484 = main with the cheap patched-PDF save (garbage=2). The previous pin
# used tobytes(garbage=4), which merges duplicate objects and hangs for minutes
# on large tagged PDFs (300+ pages, tens of thousands of xrefs) — including in
# the in-browser worker. It still includes the tier-1 GID corroboration guard
# and the two GID lookup trees the browser worker uses:
#   - font_lookup_byid          default tier-1 (gid) tree
#   - font_lookup_gid_pua_free  PUA-free variant — fixes issue #16, where mixed
#                               legacy fonts otherwise copy as Thai-block garbage
# (See web/worker.js: gid runs first, and we escalate to the PUA-free tree only
# when the gid output still extracts non-Tibetan junk.)
PIN=5f0f484b0c8d178c9d80644f1cc969798cd63f20
OUT=web/wheels

# Browser download budget: bundle ONLY those two GID trees (~25M + ~22M of JSON,
# ~13M compressed). The gname (28M) and gshape (139M) trees are deliberately
# excluded — gshape will be lazy-loaded on demand in a follow-up. Upstream fixed
# its package-data to ship font_lookup_byid at this pin, but still omits the
# PUA-free tree, so we inject the DATA list below to add it before building.
read -r -d '' DATA_BLOCK <<'TOML' || true
pdf_cmap_fix = [
    "data/font_lookup_byid/*.json",
    "data/font_lookup_gid_pua_free/*.json",
    "data/pytiblegenc/*.csv",
    "data/pytiblegenc/glyph_shape_db.npz",
    "data/pytiblegenc/glyph_shape_fonts.json",
]
TOML

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Partial + sparse clone: fetch blobs on demand and check out only the package
# source and the two data trees we ship — never the 139M gshape trees.
git clone --quiet --filter=blob:none --no-checkout \
  https://github.com/OpenPecha/pdf-cmap-fix.git "$work/src"
git -C "$work/src" sparse-checkout init --cone
git -C "$work/src" sparse-checkout set \
  pdf_cmap_fix/gid pdf_cmap_fix/gname pdf_cmap_fix/gshape \
  pdf_cmap_fix/data/font_lookup_byid \
  pdf_cmap_fix/data/font_lookup_gid_pua_free \
  pdf_cmap_fix/data/pytiblegenc
git -C "$work/src" checkout --quiet "$PIN"

# Swap the [tool.setuptools.package-data] array for our browser-scoped list.
DATA_BLOCK="$DATA_BLOCK" python3 - "$work/src/pyproject.toml" <<'PY'
import os, re, sys
path = sys.argv[1]
block = os.environ["DATA_BLOCK"].strip()
src = open(path).read()
new, n = re.subn(r"pdf_cmap_fix = \[.*?\]", block, src, count=1, flags=re.S)
if n != 1:
    sys.exit("could not find package-data array to replace in pyproject.toml")
open(path, "w").write(new)
PY

mkdir -p "$OUT"
rm -f "$OUT"/pdf_cmap_fix-*.whl
python3 -m pip wheel "$work/src" --no-deps -w "$OUT"

echo "→ wheel built in $OUT:"
ls -1sh "$OUT"
