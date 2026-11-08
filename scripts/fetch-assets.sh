#!/bin/sh
#
# Downloads the third-party assets used by SQLite Viewer from their pinned
# upstream sources. These files are intentionally not committed to the
# repository; run this script before serving the site or building the image.
#
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

need() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "error: required command '$1' not found" >&2
        exit 1
    fi
}

need curl
need sha256sum

# Be resilient to flaky upstream mirrors (e.g. sqlite.org occasionally 504s).
CURL_OPTS="--fail --silent --show-error --location \
    --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 30"

# download <sha256> <url> [mirror-url ...]
#   Tries each URL in order until one downloads and matches <sha256>, printing
#   the path to the local copy (which keeps the upstream file name).
download() {
    sha=$1
    shift
    for url in "$@"; do
        name=$(printf '%s' "$url" | sha256sum | cut -c1-12)
        dir="$TMP/$name"
        file="$dir/$(basename -- "$url")"
        mkdir -p "$dir"
        if curl $CURL_OPTS -o "$file" "$url" &&
            printf '%s  %s\n' "$sha" "$file" | sha256sum -c - >/dev/null; then
            printf '%s' "$file"
            return 0
        fi
        rm -rf "$dir"
        echo "warning: failed to fetch $url, trying next source" >&2
    done
    echo "error: could not download any of: $*" >&2
    return 1
}

# fetch <url> <sha256> <dest>
#   Downloads <url>, verifies its checksum and installs it at <dest>, relative
#   to the project root.
fetch() {
    url=$1
    sha=$2
    dest=$3
    echo "==> $dest"
    file=$(download "$sha" "$url")
    mkdir -p "$ROOT/$(dirname -- "$dest")"
    cp "$file" "$ROOT/$dest"
}

bootstrap() {
    fetch "https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css" \
        "d85327d99c7a3ee1f9b5d0500d1370acea3ad2db39c163c2f51f232baedbdede" \
        "css/bootstrap.min.css"
    fetch "https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/js/bootstrap.bundle.min.js" \
        "e4fd49181388c48ec5040bd3fe66f57c29c8e67fcd8502b3354b96ec7ab47cc7" \
        "js/bootstrap.bundle.min.js"
}

tom_select() {
    fetch "https://cdn.jsdelivr.net/npm/tom-select@2.7.0/dist/js/tom-select.complete.min.js" \
        "5c1315fe8e62c7b9342cbf82c4d5454b83ab97d507a2e9803dbaef72433438bc" \
        "js/tom-select.min.js"
    fetch "https://cdn.jsdelivr.net/npm/tom-select@2.7.0/dist/css/tom-select.bootstrap5.min.css" \
        "4b819a8a46757f55122d93bd7aa2d2018dba6a83466734c5c32322a2b4270353" \
        "css/tom-select.bootstrap5.min.css"
}

prism() {
    # Prism core plus the SQL grammar it highlights.
    fetch "https://cdn.jsdelivr.net/npm/prismjs@1.30.0/components/prism-core.min.js" \
        "6caad316dd991f24f8004e0b9c19c055cb5829ff65e973fbee406f96d81b8e7e" \
        "js/prism.js"
    fetch "https://cdn.jsdelivr.net/npm/prismjs@1.30.0/components/prism-sql.min.js" \
        "3fc5f8ce69950ec73adc972f061df42aaea78faa4864709134ea2adc083f3a33" \
        "js/prism-sql.min.js"
}

jszip() {
    fetch "https://cdn.jsdelivr.net/npm/jszip@3.10.2/dist/jszip.min.js" \
        "7f839b2d4688b845c105ebf5d2f9803075f91ea0fe72bdaac176c3a04dd3d2c1" \
        "js/jszip.min.js"
}

filesaver() {
    fetch "https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js" \
        "c68874cbaa2fd1650b7d770b328680ea765fb3376023cc3608427fde4f0d0481" \
        "js/FileSaver.min.js"
}

codejar() {
    fetch "https://cdn.jsdelivr.net/npm/codejar@4.3.0/dist/codejar.js" \
        "faccc44189de38c2e36288749e2c4db73d7c3a4322ea3c42704388fccd82f96e" \
        "js/codejar.js"
    # codejar ships as an ES module; expose it as a global for classic scripts.
    sed 's/^export function CodeJar/function CodeJar/' "$ROOT/js/codejar.js" \
        > "$ROOT/js/codejar.js.tmp"
    printf 'window.CodeJar = CodeJar;\n' >> "$ROOT/js/codejar.js.tmp"
    mv "$ROOT/js/codejar.js.tmp" "$ROOT/js/codejar.js"
}

sqlite_wasm() {
    need unzip
    release=sqlite-wasm-3540100
    # sqlite.org is frequently overloaded; fall back to its official mirrors.
    zip=$(download "85ebce90b6d189442b29e11d193337b5e63203aae9b6590dbe89a601b9891da2" \
        "https://sqlite.org/2026/$release.zip" \
        "https://www2.sqlite.org/2026/$release.zip" \
        "https://www3.sqlite.org/2026/$release.zip")
    rm -rf "$TMP/$release"
    unzip -qo "$zip" -d "$TMP"
    mkdir -p "$ROOT/js"
    echo "==> js/sqlite3.js"
    cp "$TMP/$release/jswasm/sqlite3.js" "$ROOT/js/sqlite3.js"
    echo "==> js/sqlite3.wasm"
    cp "$TMP/$release/jswasm/sqlite3.wasm" "$ROOT/js/sqlite3.wasm"
}

main() {
    bootstrap
    tom_select
    prism
    jszip
    filesaver
    codejar
    sqlite_wasm
    echo "All external assets downloaded successfully."
}

main "$@"
