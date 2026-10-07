#!/usr/bin/env bash
# Carry files from a pending refresh branch into a fresh main checkout.
#
# A refresh branch is not authoritative for deletions: it may have been based
# on an older main and therefore legitimately lack files added since that
# branch was created. Restoring a directory path directly would turn those
# absent branch entries into deletions in the fresh checkout. Enumerate the
# files that actually exist in the stable tree instead; the shared publisher
# reconciles those files while current-main-only files remain untouched.

set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <source-ref> <path> [...]" >&2
  exit 2
fi

SOURCE_REF="$1"
shift

git rev-parse --verify "${SOURCE_REF}^{tree}" >/dev/null

LISTING_FILE="$(mktemp)"
cleanup() {
  rm -f -- "$LISTING_FILE"
}
trap cleanup EXIT

RESTORE_PATHS=()
for requested_path in "$@"; do
  # `git ls-tree` fails loudly for an invalid ref; an empty listing is the
  # expected result for a valid branch that does not carry this path.
  git ls-tree -r --name-only -z "$SOURCE_REF" -- "$requested_path" > "$LISTING_FILE"
  while IFS= read -r -d '' stable_path; do
    RESTORE_PATHS+=("$stable_path")
  done < "$LISTING_FILE"
done

if [ "${#RESTORE_PATHS[@]}" -eq 0 ]; then
  echo "No pending stable refresh files to carry forward."
  exit 0
fi

echo "Carrying forward ${#RESTORE_PATHS[@]} stable refresh file(s); preserving current-main-only files."
git restore --source="$SOURCE_REF" -- "${RESTORE_PATHS[@]}"
