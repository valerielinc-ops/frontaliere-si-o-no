#!/usr/bin/env bash
# Dispatch a cross-repository workflow, retrying only transient GitHub 5xx
# responses. The workflow dispatch POST is a side effect, so this helper keeps
# the retry budget small and never retries authentication, input, timeout, or
# otherwise unclassified failures.

dispatch_workflow_with_retry() {
  if [ "$#" -lt 2 ]; then
    echo "usage: dispatch_workflow_with_retry <workflow-file> <owner/repo> [gh workflow run args...]" >&2
    return 2
  fi

  local workflow_file="$1"
  local repository="$2"
  shift 2

  local attempt output status delay
  for attempt in 1 2 3; do
    if output=$(GH_TOKEN="${GITHUB_PAT_NANAKO:-}" gh workflow run "$workflow_file" \
      --repo "$repository" "$@" 2>&1); then
      [ -z "$output" ] || printf '%s\n' "$output"
      return 0
    else
      status=$?
    fi

    if [[ "$output" =~ HTTP[[:space:]]+(500|502|503|504)([^0-9]|$) ]] && [ "$attempt" -lt 3 ]; then
      case "$attempt" in
        1) delay=5 ;;
        2) delay=15 ;;
      esac
      echo "::warning::workflow dispatch returned a transient HTTP 5xx response (attempt $attempt/3); retrying in ${delay}s."
      sleep "$delay"
      continue
    fi

    [ -z "$output" ] || printf '%s\n' "$output" >&2
    return "$status"
  done

  return 1
}
