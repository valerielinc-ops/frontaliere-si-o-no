#!/usr/bin/env bash
set -euo pipefail
git_command=''
args=("$@")
index=0
while [ "$index" -lt "$#" ]; do
  arg="${args[$index]}"
  case "$arg" in
    -C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env)
      index=$((index + 2))
      ;;
    --*|-*)
      index=$((index + 1))
      ;;
    *)
      git_command="$arg"
      break
      ;;
  esac
done
case "$git_command" in
  push|fetch|pull|ls-remote)
    exec "${CODEX_NODE_REAL:?Trusted Node runtime unavailable}" "${CODEX_GIT_CLIENT:?Codex Git bridge client unavailable}" "$@"
    ;;
  credential)
    echo 'git credential access is not permitted by the Codex fallback bridge' >&2
    exit 2
    ;;
  *)
    exec "${CODEX_GIT_REAL:?Codex Git CLI path unavailable}" "$@"
    ;;
esac
