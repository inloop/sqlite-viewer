#!/bin/sh
#
# Build a zip of the deployable static site (assembled by scripts/build-dist.sh)
# suitable for unpacking into a directory served by a web server. Run
# scripts/fetch-assets.sh first (or `make deps`).
#
# usage: scripts/build-release.sh [output.zip]
#
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT=${1:-"$ROOT/sqlite-viewer.zip"}
DIST="$ROOT/dist"

"$ROOT/scripts/build-dist.sh"

# Resolve OUT to an absolute path first: the zip command runs from inside the
# dist directory, so a relative path would land (and be deleted) there.
OUT=$(CDPATH= cd -- "$(dirname -- "$OUT")" && pwd)/$(basename -- "$OUT")
rm -f "$OUT"
if command -v zip >/dev/null 2>&1; then
    (cd "$DIST" && zip -qr "$OUT" .)
else
    # Fall back to Python's zipfile when the `zip` command is unavailable.
    python3 - "$DIST" "$OUT" <<'PY'
import os, sys, zipfile

dist, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _dirs, files in os.walk(dist):
        for name in files:
            path = os.path.join(root, name)
            z.write(path, os.path.relpath(path, dist))
PY
fi

echo "wrote $OUT ($(wc -c < "$OUT") bytes)"
