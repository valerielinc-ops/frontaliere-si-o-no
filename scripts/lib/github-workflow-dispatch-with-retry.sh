#!/usr/bin/env bash
# Dispatch a cross-repository workflow exactly once. A workflow_dispatch POST
# is a side effect, and GitHub gives the producer no idempotency key or accepted
# request receipt. A 5xx is therefore ambiguous: the receiver may have queued
# the run already. The source_key helper below can be passed to a receiver that
# owns a stable-URL guard, but it is not evidence that the guard exists, so this
# producer never repeats the POST.

workflow_dispatch_source_key() {
  if [ "$#" -ne 1 ] || [ -z "$1" ]; then
    echo "usage: workflow_dispatch_source_key <source-url>" >&2
    return 2
  fi

  local digest
  if ! digest="$(printf '%s' "$1" | sha256sum | cut -d ' ' -f 1)"; then
    echo "unable to hash workflow dispatch source URL" >&2
    return 1
  fi
  digest="${digest:0:32}"
  if [[ ! "$digest" =~ ^[a-f0-9]{32}$ ]]; then
    echo "workflow dispatch source URL hash is invalid" >&2
    return 1
  fi
  printf '%s\n' "$digest"
}

dispatch_workflow_once() {
  if [ "$#" -lt 2 ]; then
    echo "usage: dispatch_workflow_once <workflow-file> <owner/repo> [gh workflow run args...]" >&2
    return 2
  fi

  local workflow_file="$1"
  local repository="$2"
  shift 2

  local output status
  if output=$(GH_TOKEN="${GITHUB_PAT_NANAKO:-}" gh workflow run "$workflow_file" \
    --repo "$repository" "$@" 2>&1); then
    [ -z "$output" ] || printf '%s\n' "$output"
    return 0
  else
    status=$?
  fi

  if [[ "$output" =~ HTTP[[:space:]]+(500|502|503|504)([^0-9]|$) ]]; then
    echo "::warning::workflow dispatch returned an ambiguous HTTP 5xx response; not retrying a side-effectful POST." >&2
  fi
  [ -z "$output" ] || printf '%s\n' "$output" >&2
  return "$status"
}
