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

jquery() {
    fetch "https://code.jquery.com/jquery-4.0.0.slim.min.js" \
        "f031a9bf5dc7226fb9883356c355eac60141e268fec8e28535bfad1c164ea307" \
        "js/jquery-4.0.0.slim.min.js"
}

select2() {
    fetch "https://cdn.jsdelivr.net/npm/select2@4.1.0/dist/css/select2.min.css" \
        "5d5e14d587308b5d1ad79f51e9aea2f8f469b0a02b335f559f5a4bb756b81737" \
        "css/select2.min.css"
    fetch "https://cdn.jsdelivr.net/npm/select2@4.1.0/dist/js/select2.min.js" \
        "15692c266649fbc8acb4ebfb345e7e9499486d9551148241a235c9d62eea2f55" \
        "js/select2.min.js"
}

select2_bootstrap_theme() {
    fetch "https://cdn.jsdelivr.net/npm/select2-bootstrap-5-theme@1.3.0/dist/select2-bootstrap-5-theme.min.css" \
        "5cb35411fccf18705e4ad112d836cb514459ddeefddc169b970cc99588fa5b64" \
        "css/select2-bootstrap-5-theme.min.css"
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

main() {
    bootstrap
    jquery
    select2
    select2_bootstrap_theme
    prism
    jszip
    echo "All external assets downloaded successfully."
}

main "$@"
