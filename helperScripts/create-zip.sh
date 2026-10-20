#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ARCHIVE="$REPO_ROOT/salesforce-assist-buddy-sc.zip"
TEMP_ARCHIVE="$REPO_ROOT/.salesforce-assist-buddy-sc-$$-$RANDOM.tmp.zip"

if ! command -v zip >/dev/null 2>&1; then
    printf '%s\n' 'The zip command was not found. Install a zip utility and ensure it is on PATH.' >&2
    exit 1
fi

printf '%s\n' 'Note: zip -e uses traditional ZipCrypto encryption, not AES-256.'

cleanup() {
    rm -f "$TEMP_ARCHIVE"
}
trap cleanup EXIT

printf 'Creating "%s". zip will prompt for the ZIP password.\n' "$ARCHIVE"
cd "$REPO_ROOT"
zip -r -e "$TEMP_ARCHIVE" . \
    -x '*/.git' '*/.git/*' \
    '*/node_modules' '*/node_modules/*' \
    '*/out' '*/out/*' \
    '*.zip'
mv -f "$TEMP_ARCHIVE" "$ARCHIVE"
printf 'Created "%s".\n' "$ARCHIVE"