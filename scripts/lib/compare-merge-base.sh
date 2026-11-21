#!/usr/bin/env bash
# Resolve a GitHub compare merge base without mistaking an API error body for a
# revision. The local fallback is deliberately limited to GitHub's large-diff
# 422 response and downloads neither trees nor blobs.

COMPARE_MERGE_BASE_FETCH_TIMEOUT_SECONDS=60
COMPARE_MERGE_BASE_DEEPEN_STEPS=(64 256 1024)
COMPARE_MERGE_BASE_MAX_DEEPEN=1344
COMPARE_MERGE_BASE_LIB_DIR=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
COMPARE_MERGE_BASE_NO_LAZY_AVAILABLE=''

compare_merge_base_has_no_lazy_fetch() {
  if [ -z "$COMPARE_MERGE_BASE_NO_LAZY_AVAILABLE" ]; then
    if node "$COMPARE_MERGE_BASE_LIB_DIR/git-no-lazy.mjs" --supports >/dev/null 2>&1; then
      COMPARE_MERGE_BASE_NO_LAZY_AVAILABLE=true
    else
      COMPARE_MERGE_BASE_NO_LAZY_AVAILABLE=false
    fi
  fi
  [ "$COMPARE_MERGE_BASE_NO_LAZY_AVAILABLE" = true ]
}

compare_merge_base_is_sha1() {
  [[ "$1" =~ ^[0-9a-fA-F]{40}$ ]]
}

compare_merge_base_from_local_graph() {
  local remote_url="$1" left="$2" right="$3" label="$4" base deepen
  if ! compare_merge_base_has_no_lazy_fetch; then
    base=''
    echo "::error::No merge base found within the ${COMPARE_MERGE_BASE_MAX_DEEPEN}-commit history-depth cap for ${label} (local Git cannot disable lazy fetch)" >&2
    return 1
  fi
  base="$(GIT_NO_LAZY_FETCH=1 git --no-lazy-fetch merge-base "$left" "$right" 2>/dev/null || true)"
  if compare_merge_base_is_sha1 "$base"; then
    printf '%s\n' "$base"
    return 0
  fi

  for deepen in "${COMPARE_MERGE_BASE_DEEPEN_STEPS[@]}"; do
    echo "::notice::${label}: deepening commit graph by ${deepen} commits (cap ${COMPARE_MERGE_BASE_MAX_DEEPEN})" >&2
    # Merge-base walks commits only. A blobless fetch still downloads every
    # tree object in this repository; the treeless filter keeps the fallback
    # bounded when GitHub refuses to generate the compare diff.
    if ! run_bounded "$COMPARE_MERGE_BASE_FETCH_TIMEOUT_SECONDS" "git deepen ${label} merge base" \
      git fetch --no-tags --filter=tree:0 --deepen="$deepen" "$remote_url" \
      "+${left}:refs/compare-merge-base/left" "+${right}:refs/compare-merge-base/right"; then
      echo "::error::Could not deepen merge base graph for ${label}" >&2
      return 1
    fi
    base="$(GIT_NO_LAZY_FETCH=1 git --no-lazy-fetch merge-base "$left" "$right" 2>/dev/null || true)"
    if compare_merge_base_is_sha1 "$base"; then
      printf '%s\n' "$base"
      return 0
    fi
  done

  echo "::error::No merge base found within the ${COMPARE_MERGE_BASE_MAX_DEEPEN}-commit history-depth cap for ${label} (${left}...${right})" >&2
  return 1
}

compare_merge_base() {
  local repository="$1" left="$2" right="$3" remote_url="$4" api_timeout="$5" label="$6"
  local base compare_output compare_error compare_failure compare_status error_file
  error_file="$(mktemp "${TMPDIR:-/tmp}/compare-merge-base.XXXXXX")" || {
    echo "::error::Could not create a temporary file for ${label} compare diagnostics" >&2
    return 1
  }
  if compare_output="$(run_bounded "$api_timeout" "gh api ${label} merge base" \
    gh api "repos/${repository}/compare/${left}...${right}" --jq '.merge_base_commit.sha' 2>"$error_file")"; then
    compare_status=0
  else
    compare_status=$?
  fi
  compare_error="$(cat "$error_file" 2>/dev/null || true)"
  rm -f "$error_file"
  [ -z "$compare_error" ] || printf '%s\n' "$compare_error" >&2
  compare_failure="${compare_output}"$'\n'"${compare_error}"

  if [ "$compare_status" -ne 0 ]; then
    if [[ "$compare_failure" == *"422"* && "$compare_failure" == *"diff is taking too long"* ]]; then
      echo "::warning::${label}: GitHub compare diff is too large; using bounded commit-graph fallback" >&2
      base="$(compare_merge_base_from_local_graph "$remote_url" "$left" "$right" "$label")" || return 1
    else
      [ -z "$compare_output" ] || printf '%s\n' "$compare_output" >&2
      echo "::error::Could not resolve ${label} merge base from GitHub compare (status ${compare_status})" >&2
      return "$compare_status"
    fi
  else
    base="$compare_output"
  fi

  if ! compare_merge_base_is_sha1 "$base"; then
    echo "::error::Invalid ${label} merge base response; expected a SHA-40" >&2
    [ -z "$base" ] || printf '%s\n' "$base" >&2
    return 1
  fi
  printf '%s\n' "$base"
}
