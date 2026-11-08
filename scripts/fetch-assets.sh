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

# fetch <url> <sha256> <dest>
#   Downloads <url>, verifies its checksum and installs it at <dest>, relative
#   to the project root.
fetch() {
    url=$1
    sha=$2
    dest=$3
    name=$(printf '%s' "$url" | sha256sum | cut -c1-12)
    file="$TMP/$name"
    echo "==> $dest"
    curl -fsSL --retry 3 -o "$file" "$url"
    printf '%s  %s\n' "$sha" "$file" | sha256sum -c - >/dev/null
    mkdir -p "$ROOT/$(dirname -- "$dest")"
    cp "$file" "$ROOT/$dest"
}

# fetch_zip <url> <sha256>
#   Downloads and verifies a ZIP archive, printing the path to the local copy.
fetch_zip() {
    url=$1
    sha=$2
    name=$(printf '%s' "$url" | sha256sum | cut -c1-12)
    file="$TMP/$name.zip"
    curl -fsSL --retry 3 -o "$file" "$url"
    printf '%s  %s\n' "$sha" "$file" | sha256sum -c - >/dev/null
    printf '%s' "$file"
}

bootstrap() {
    fetch "https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css" \
        "d85327d99c7a3ee1f9b5d0500d1370acea3ad2db39c163c2f51f232baedbdede" \
        "css/bootstrap.min.css"
    fetch "https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/js/bootstrap.bundle.min.js" \
        "e4fd49181388c48ec5040bd3fe66f57c29c8e67fcd8502b3354b96ec7ab47cc7" \
        "js/bootstrap.bundle.min.js"
}

main() {
    bootstrap
    echo "All external assets downloaded successfully."
}

main "$@"
