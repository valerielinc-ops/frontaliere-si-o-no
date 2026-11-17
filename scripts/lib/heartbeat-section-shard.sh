#!/usr/bin/env bash
# Advance a section shard's generation marker without rebuilding its payload.
#
# The commit is always based on the current remote main and changes only
# .shard-source. The push is deliberately non-forced: a concurrent writer makes
# this helper rebuild from the new tip or fail closed; it can never replace the
# remote payload with an older snapshot.
set -euo pipefail

section="${1:-}"
loc="${2:-}"
if [ -z "$section" ] || [ -z "$loc" ]; then
  echo "Usage: heartbeat-section-shard.sh <section> <locale>" >&2
  exit 2
fi
case "$loc" in
  it|en|de|fr) ;;
  *) echo "::error::unsupported heartbeat locale '$loc'" >&2; exit 2 ;;
esac

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# Resolved from BASH_SOURCE at runtime.
# shellcheck disable=SC1091
source "$script_dir/shard-git-helpers.sh"

slugs_json="$script_dir/section-shard-slugs.json"
owners_json="$script_dir/section-shard-owners.json"
if ! jq -e --arg section "$section" --arg locale "$loc" \
    '.[$section][$locale] | type == "string" and length > 0' \
    "$slugs_json" >/dev/null 2>&1; then
  echo "::error::unsupported heartbeat section '$section' / locale '$loc'" >&2
  exit 2
fi
if ! shard_owner="$(jq -er --arg section "$section" \
    'if has($section) then .[$section] else "valerielinc-ops" end | select(type == "string" and length > 0)' \
    "$owners_json")"; then
  echo "::error::cannot resolve heartbeat owner for '$section'" >&2
  exit 1
fi

source_sha="${GITHUB_SHA:-}"
if ! [[ "$source_sha" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "::error::$section-$loc heartbeat requires GITHUB_SHA to be a full 40-character source SHA" >&2
  exit 1
fi

shard_repo="${SHARD_REPO_OVERRIDE:-git@github.com:$shard_owner/frontaliere-$section-$loc.git}"
label="$section-$loc heartbeat"
section_upper="$(printf '%s' "$section" | LC_ALL=C tr '[:lower:]' '[:upper:]')"
loc_upper="$(printf '%s' "$loc" | LC_ALL=C tr '[:lower:]' '[:upper:]')"
key_var="SHARD_${section_upper}_${loc_upper}_DEPLOY_KEY"
key_val="${!key_var:-}"

runner_temp="${RUNNER_TEMP:-}"
own_temp=0
if [ -z "$runner_temp" ]; then
  runner_temp="$(mktemp -d)"
  own_temp=1
fi
stage="$runner_temp/shard-heartbeat-$section-$loc"
keyfile="$runner_temp/shard_heartbeat_${section}_${loc}_key"
# Invoked indirectly by the EXIT trap.
# shellcheck disable=SC2329
cleanup() {
  rm -rf "$stage"
  rm -f "$keyfile"
  if [ "$own_temp" = 1 ]; then rm -rf "$runner_temp"; fi
}
trap cleanup EXIT

is_github_repo=0
case "$shard_repo" in
  git@github.com:*|ssh://git@github.com/*|https://github.com/*) is_github_repo=1 ;;
esac

read_repo="$shard_repo"
if [ -n "$key_val" ]; then
  printf '%s\n' "$key_val" > "$keyfile"
  chmod 600 "$keyfile"
  export GIT_SSH_COMMAND="ssh -i $keyfile -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o TCPKeepAlive=yes"
elif [ "$is_github_repo" = 1 ]; then
  read_repo="$(shard_https_push_url "$shard_repo")"
  unset GIT_SSH_COMMAND
else
  # Local remotes are used by the runtime regression test and need no secret.
  unset GIT_SSH_COMMAND
fi

push_marker_commit() {
  local refspec="$1:refs/heads/main" out rc=0 reason
  out="$(mktemp)"
  if [ -n "$key_val" ] || [ "$is_github_repo" = 0 ]; then
    git -C "$stage" push "$shard_repo" "$refspec" 2>"$out" || rc=$?
    cat "$out" >&2
    if [ "$rc" -eq 0 ]; then
      rm -f "$out"
      return 0
    fi
    reason="$(shard_push_failure_reason "$out")"
  else
    reason='deploy key unavailable'
    rc=1
  fi
  rm -f "$out"
  if [ "$is_github_repo" = 1 ]; then
    # force=0 is load-bearing: a stale heartbeat must never overwrite a newer
    # fast-publish/full-publish commit.
    shard_pat_push "$stage" "$shard_repo" "$refspec" "$label" 0 "$reason"
    return $?
  fi
  return "$rc"
}

attempt=1
max_attempts="${SHARD_HEARTBEAT_ATTEMPTS:-3}"
if ! [[ "$max_attempts" =~ ^[1-9][0-9]*$ ]] || [ "$max_attempts" -gt 5 ]; then
  echo "::error::SHARD_HEARTBEAT_ATTEMPTS must be an integer between 1 and 5" >&2
  exit 2
fi

while [ "$attempt" -le "$max_attempts" ]; do
  rm -rf "$stage"
  if ! git clone -q --depth 1 --filter=blob:none --no-checkout "$read_repo" "$stage"; then
    echo "::error::$label could not read the current remote main (attempt $attempt/$max_attempts)" >&2
  else
    git -C "$stage" config user.email "valerielinc@gmail.com"
    git -C "$stage" config user.name "Valerie Linc"
    base_commit="$(git -C "$stage" rev-parse --verify HEAD)"
    base_tree="$(git -C "$stage" rev-parse --verify 'HEAD^{tree}')"
    git -C "$stage" read-tree "$base_tree"
    marker_oid="$(printf '%s' "$source_sha" | git -C "$stage" hash-object -w --stdin)"
    git -C "$stage" update-index --add --cacheinfo 100644 "$marker_oid" .shard-source
    heartbeat_tree="$(git -C "$stage" write-tree --missing-ok)"

    if [ "$heartbeat_tree" = "$base_tree" ]; then
      echo "$label: .shard-source already records $source_sha; payload unchanged"
      exit 0
    fi

    changed_paths="$(git -C "$stage" diff-tree --no-commit-id --name-only -r "$base_tree" "$heartbeat_tree")"
    if [ "$changed_paths" != '.shard-source' ]; then
      echo "::error::$label refused: heartbeat tree changes paths other than .shard-source: ${changed_paths:-<none>}" >&2
      exit 1
    fi

    short_sha="${source_sha:0:8}"
    heartbeat_commit="$(printf '%s\n' "[deploy $short_sha] heartbeat $section-$loc shard" \
      | git -C "$stage" commit-tree "$heartbeat_tree" -p "$base_commit")"
    if push_marker_commit "$heartbeat_commit"; then
      remote_commit="$(git ls-remote "$read_repo" refs/heads/main | awk 'NR == 1 { print $1 }')"
      if [ "$remote_commit" = "$heartbeat_commit" ]; then
        echo "$label: advanced .shard-source to $source_sha without changing payload"
        exit 0
      fi
      echo "::error::$label push returned success but remote main does not name the heartbeat commit" >&2
      exit 1
    fi
    echo "::warning::$label push raced or failed (attempt $attempt/$max_attempts); rebuilding from remote main"
  fi

  attempt=$((attempt + 1))
  if [ "$attempt" -le "$max_attempts" ]; then
    sleep "${SHARD_HEARTBEAT_RETRY_DELAY:-2}"
  fi
done

echo "::error::$label could not publish .shard-source after $max_attempts attempt(s)" >&2
exit 1
