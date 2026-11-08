#!/bin/sh
#
# Assemble a clean, deployable copy of the site in dist/: the files a web
# server needs, with the pinned third-party assets included. Run
# scripts/fetch-assets.sh first (or `make deps`).
#
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DIST="$ROOT/dist"

# Everything that goes into the deployment, relative to the project root.
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
js/sqlite3-opfs-async-proxy.js
"

for f in $ASSETS; do
    if [ ! -f "$ROOT/$f" ]; then
        echo "error: missing $f - run ./scripts/fetch-assets.sh first" >&2
        exit 1
    fi
done

rm -rf "$DIST"
for f in $SITE; do
    dest="$DIST/$(dirname -- "$f")"
    mkdir -p "$dest"
    cp -R "$ROOT/$f" "$dest/"
done

echo "wrote $DIST"
