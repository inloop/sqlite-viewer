#!/bin/sh
#
# Build a zip of the deployable static site: the files needed to serve the
# viewer from a web server's document root. The pinned third-party assets are
# not committed, so run scripts/fetch-assets.sh first (or `make deps`).
#
# usage: scripts/build-release.sh [output.zip]
#
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT=${1:-"$ROOT/sqlite-viewer.zip"}

# Everything that goes into the archive, relative to the project root.
# (img/preview.png is intentionally left out: it is only used by the README.)
SITE="
index.html
.htaccess
LICENSE.md
css
js
img/icon.png
img/logo.svg
"

# Produced by scripts/fetch-assets.sh; if one is missing, deps weren't run.
ASSETS="
css/bootstrap.min.css
css/tom-select.bootstrap5.min.css
js/bootstrap.bundle.min.js
js/tom-select.min.js
js/prism.js
js/prism-sql.min.js
js/fflate.min.js
js/FileSaver.min.js
js/codejar.js
js/sqlite3.js
js/sqlite3.wasm
"

for f in $ASSETS; do
    if [ ! -f "$ROOT/$f" ]; then
        echo "error: missing $f - run ./scripts/fetch-assets.sh first" >&2
        exit 1
    fi
done

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT INT TERM

for f in $SITE; do
    dest="$STAGE/$(dirname -- "$f")"
    mkdir -p "$dest"
    cp -R "$ROOT/$f" "$dest/"
done

# Resolve OUT to an absolute path first: the zip command runs from inside the
# staging directory, so a relative path would land (and be deleted) there.
OUT=$(CDPATH= cd -- "$(dirname -- "$OUT")" && pwd)/$(basename -- "$OUT")
rm -f "$OUT"
if command -v zip >/dev/null 2>&1; then
    (cd "$STAGE" && zip -qr "$OUT" .)
else
    # Fall back to Python's zipfile when the `zip` command is unavailable.
    python3 - "$STAGE" "$OUT" <<'PY'
import os, sys, zipfile

stage, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _dirs, files in os.walk(stage):
        for name in files:
            path = os.path.join(root, name)
            z.write(path, os.path.relpath(path, stage))
PY
fi

echo "wrote $OUT ($(wc -c < "$OUT") bytes)"
