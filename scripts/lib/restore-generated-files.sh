#!/usr/bin/env bash
set -euo pipefail

COMMIT=''
CHECKOUT_PATHS=()
MERGE_ARRAY_PATHS=()
MERGE_ARRAY_FIELDS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit) COMMIT="$2"; shift 2 ;;
    --checkout) CHECKOUT_PATHS+=("$2"); shift 2 ;;
    --merge-array) MERGE_ARRAY_PATHS+=("$2"); shift 2 ;;
    --merge-array-field) MERGE_ARRAY_FIELDS+=("$2"); shift 2 ;;
    *) echo "::error::Unknown argument: $1"; exit 2 ;;
  esac
done

if [[ -z "$COMMIT" ]]; then
  echo '::error::--commit is required'
  exit 2
fi

checkout_with_retry() {
  local path="$1"
  local attempt output
  for attempt in 1 2 3 4; do
    if output="$(git checkout "$COMMIT" -- "$path" 2>&1)"; then
      [[ -n "$output" ]] && printf '%s\n' "$output"
      return 0
    fi
    if [[ "$output" != *index.lock* && "$output" != *'Another git process'* && "$output" != *'lock file'* ]]; then
      printf '%s\n' "$output" >&2
      return 1
    fi
    printf 'Transient git checkout lock for %s (attempt %s/4); retrying.\n' "$path" "$attempt" >&2
    sleep "$attempt"
  done
  printf '%s\n' "$output" >&2
  return 1
}

for path in "${CHECKOUT_PATHS[@]}"; do
  checkout_with_retry "$path"
done

for path in "${MERGE_ARRAY_PATHS[@]}"; do
  node scripts/lib/merge-generated-json.mjs --commit "$COMMIT" --path "$path" --array
done

for spec in "${MERGE_ARRAY_FIELDS[@]}"; do
  path="${spec%%:*}"
  field="${spec#*:}"
  if [[ "$path" == "$field" ]]; then
    echo "::error::--merge-array-field must be PATH:FIELD, got $spec"
    exit 2
  fi
  node scripts/lib/merge-generated-json.mjs --commit "$COMMIT" --path "$path" --array-field "$field"
done
