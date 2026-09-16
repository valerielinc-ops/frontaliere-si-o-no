#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/shard-git-helpers.sh — shared git-plumbing helpers for the
# section/locale/article shard push scripts (push-section-shard.sh,
# push-locale-shard.sh, compact-article-shard-history.sh). SOURCED, not
# executed (the standard shared-shell-library `source` convention).
#
# Issue #4881 (shard safety rails). Extracted because push-section-shard.sh
# and push-locale-shard.sh had two independent, byte-for-byte-duplicated
# copies of every function below (AGENTS.md #6) — fixing the bugs in one
# copy without extracting would have left the sibling's copy silently
# unfixed (exactly the class of drift #6 exists to prevent).
#
# shard_read_counter fixes a real, previously-live bug: both scripts read
# their `.shard-deploys` / `.shard-filecount` bookkeeping counters via
# `[ -f "$stage/.shard-deploys" ] && cat "$stage/.shard-deploys"` against a
# `git clone --filter=blob:none --no-checkout` clone. `--no-checkout` means
# `git help clone`'s "No checkout of HEAD is performed after the clone is
# complete" applies literally and universally (every transport) — NO
# working-tree file is EVER materialized on that clone, so the `[ -f ... ]`
# check was ALWAYS false. Concretely: `dcount` was always read as 0, so
# SHARD_HISTORY_CAP's orphan-flatten (meant to bound `.git` growth) has
# never actually fired for any section/locale shard, and `prev_n` (fetched
# via raw.githubusercontent.com, not from this clone at all) was fragile
# for a different reason (unauthenticated 60/hr rate limit + CDN staleness).
# `git show HEAD:<path>` reads the blob straight from the object graph
# regardless of checkout state — the pattern already proven correct in
# scripts/lib/push-article-shard-incremental.sh:185.
# ─────────────────────────────────────────────────────────────────────────────

# shard_read_counter <clone_dir> <path-in-repo>
# Prints the numeric content of <path> at HEAD in <clone_dir>, or 0 if the
# path is absent, the clone has no commits yet, or the content isn't numeric.
shard_read_counter() {
  local dir="$1" path="$2" val
  val="$(git -C "$dir" show "HEAD:$path" 2>/dev/null || echo 0)"
  [[ "$val" =~ ^[0-9]+$ ]] || val=0
  printf '%s' "$val"
}

# shard_delta_manifest_sidecar <locale>
# The build manifest lives outside dist/. Delta mode carries a filtered,
# per-shard snapshot in the published tree so the next push has an atomic
# previous-manifest/base-tree pair. Full mode never creates this sidecar.
shard_delta_manifest_sidecar() {
  local locale="$1"
  printf '.deploy-manifest/v1/%s.jsonl' "$locale"
}

# shard_manifest_snapshot <current_manifest> <scope> <source_root> <tool> <out_dir>
# Validates the current build manifest and writes the filtered snapshot used by
# a full fallback as well as by a successful delta. The Node tool owns the
# JSONL contract; bash only decides whether the result is safe to publish.
shard_manifest_snapshot() {
  local current="$1" scope="$2" source_root="$3" tool="$4" out_dir="$5"
  mkdir -p "$out_dir"
  if node "$tool" \
      --current="$current" \
      --scope="$scope" \
      --source-root="$source_root" \
      --out="$out_dir" \
      --snapshot-only; then
    return 0
  fi
  SHARD_DELTA_REASON='current manifest invalid or payload missing'
  return 1
}

# shard_delta_clone_and_prepare <stage> <repo> <current_manifest>
#   <sidecar_path> <scope> <source_root> <tool> <out_dir> <history_cap> <label>
# Clone the remote without checking out blobs, validate both manifest sides,
# and seed the index from HEAD. Return 0 only when the caller may apply a delta.
# Normal fallback reasons return 1 and are exposed in SHARD_DELTA_REASON.
shard_delta_clone_and_prepare() {
  local stage="$1" repo="$2" current="$3" sidecar="$4" scope="$5"
  local source_root="$6" tool="$7" out_dir="$8" history_cap="$9" label="${10:-shard}"
  local clone_err previous_manifest
  SHARD_DELTA_REASON=''
  SHARD_DELTA_DCOUNT=0
  SHARD_DELTA_PREV_N=0

  rm -rf "$stage"
  mkdir -p "$stage" "$out_dir"
  clone_err="$(mktemp)"
  if ! git clone -q --depth 1 --filter=blob:none --no-checkout "$repo" "$stage" 2>"$clone_err"; then
    echo "::warning::$label delta clone failure: $(cat "$clone_err")" >&2
    rm -f "$clone_err"
    SHARD_DELTA_REASON='clone failure'
    return 1
  fi
  rm -f "$clone_err"

  if ! git -C "$stage" rev-parse -q --verify HEAD >/dev/null 2>&1; then
    echo "$label delta: remote is empty — full fallback" >&2
    SHARD_DELTA_REASON='first push / remote empty'
    return 1
  fi

  SHARD_DELTA_DCOUNT="$(shard_read_counter "$stage" .shard-deploys)"
  SHARD_DELTA_PREV_N="$(shard_read_counter "$stage" .shard-filecount)"
  if [ "$SHARD_DELTA_DCOUNT" -ge "$history_cap" ]; then
    SHARD_DELTA_REASON="history cap $history_cap reached"
    return 1
  fi
  if [ ! -s "$current" ]; then
    SHARD_DELTA_REASON='current manifest missing'
    return 1
  fi

  previous_manifest="$out_dir/previous.jsonl"
  if ! git -C "$stage" show "HEAD:$sidecar" > "$previous_manifest" 2>/dev/null; then
    SHARD_DELTA_REASON='previous manifest missing'
    return 1
  fi

  if ! node "$tool" \
      --current="$current" \
      --previous="$previous_manifest" \
      --scope="$scope" \
      --source-root="$source_root" \
      --out="$out_dir"; then
    SHARD_DELTA_REASON='current or previous manifest invalid'
    return 1
  fi

  if ! git -C "$stage" read-tree HEAD; then
    SHARD_DELTA_REASON='remote index initialization failed'
    return 1
  fi
  return 0
}

# shard_delta_add_file <stage> <source_file> <target_path>
# Compare against the remote-seeded index and update only when the source blob
# is new/different. This is the key distinction from `git add -A` on an empty
# no-checkout working tree.
shard_delta_add_file() {
  local stage="$1" source="$2" target="$3" old_oid new_oid blob_oid
  if [ "${source#/}" = "$source" ]; then source="$(pwd)/$source"; fi
  [ -f "$source" ] || return 1
  old_oid="$(git -C "$stage" ls-files --stage -- "$target" 2>/dev/null | awk 'NR == 1 { print $2 }')"
  new_oid="$(git -C "$stage" hash-object --path="$target" "$source")" || return 1
  if [ "$old_oid" = "$new_oid" ]; then
    SHARD_DELTA_REUSED_FILES=$((SHARD_DELTA_REUSED_FILES + 1))
    return 0
  fi
  blob_oid="$(git -C "$stage" hash-object -w --path="$target" "$source")" || return 1
  git -C "$stage" update-index --add --cacheinfo "100644,$blob_oid,$target" || return 1
  SHARD_DELTA_CHANGED_FILES=$((SHARD_DELTA_CHANGED_FILES + 1))
  SHARD_DELTA_CONTENT_CHANGES=$((SHARD_DELTA_CONTENT_CHANGES + 1))
  return 0
}

# shard_delta_add_text <stage> <target_path> <content> [count_as_content]
shard_delta_add_text() {
  local stage="$1" target="$2" content="$3" count_change="${4:-1}"
  local old_oid new_oid blob_oid
  old_oid="$(git -C "$stage" ls-files --stage -- "$target" 2>/dev/null | awk 'NR == 1 { print $2 }')"
  new_oid="$(printf '%s' "$content" | git -C "$stage" hash-object --stdin --path="$target")" || return 1
  if [ "$old_oid" = "$new_oid" ]; then return 0; fi
  blob_oid="$(printf '%s' "$content" | git -C "$stage" hash-object -w --stdin --path="$target")" || return 1
  git -C "$stage" update-index --add --cacheinfo "100644,$blob_oid,$target" || return 1
  if [ "$count_change" = 1 ]; then
    SHARD_DELTA_CONTENT_CHANGES=$((SHARD_DELTA_CONTENT_CHANGES + 1))
  fi
  return 0
}

# shard_delta_remove_stale_payload_paths <stage> <scope_prefix>
#   <payload_file_list> <removed_file>
# The seeded index is the previous inventory. Remove every tracked payload
# path under the scope that is absent from the current payload list, including
# unmanifested files and children of a still-live manifest page. Root service
# files are handled separately by the caller and are never part of this set.
# One awk pass emits all deletion records and cross-checks every manifest
# tombstone before one index-info update.
shard_delta_remove_stale_payload_paths() {
  local stage="$1" scope_prefix="$2" payload_file_list="$3" removed_file="$4"
  local work index_dump delete_info count_file missing_file removed_count
  [ -f "$payload_file_list" ] || return 1
  [ -f "$removed_file" ] || return 1
  work="$(mktemp -d)" || return 1
  index_dump="$work/index.dump"
  delete_info="$work/delete.info"
  count_file="$work/count"
  missing_file="$work/missing-tombstones"
  if [ -n "$scope_prefix" ]; then
    if ! git -C "$stage" ls-files --stage -- "$scope_prefix/" > "$index_dump"; then
      rm -rf "$work"
      return 1
    fi
  elif ! git -C "$stage" ls-files --stage > "$index_dump"; then
    rm -rf "$work"
    return 1
  fi
  if ! awk -F '\t' \
      -v scope_prefix="$scope_prefix" \
      -v payload_file_list="$payload_file_list" \
      -v removed_file="$removed_file" \
      -v delete_info="$delete_info" \
      -v count_file="$count_file" \
      -v missing_file="$missing_file" '
      function is_service_path(path) {
        return (path == ".nojekyll" || path == "CNAME" || path == "404.html" || path == "index.html" || path == ".shard-deploys" || path == ".shard-filecount" || index(path, ".deploy-manifest/") == 1 || (scope_prefix != "" && path == scope_prefix ".html"))
      }

      function mark_removed_candidates(path, candidate, slash) {
        candidate = path
        if (candidate in removed) found[candidate] = 1
        if (length(candidate) > 11 && substr(candidate, length(candidate) - 10) == "/index.html") {
          candidate = substr(candidate, 1, length(candidate) - 11)
          if (candidate in removed) found[candidate] = 1
        } else if (length(candidate) > 5 && substr(candidate, length(candidate) - 4) == ".html") {
          candidate = substr(candidate, 1, length(candidate) - 5)
          if (candidate in removed) found[candidate] = 1
        }
        while ((slash = match(candidate, /\/[^\/]*$/)) > 0) {
          candidate = substr(candidate, 1, slash - 1)
          if (candidate in removed) found[candidate] = 1
        }
      }

      BEGIN {
        prefix = scope_prefix == "" ? "" : scope_prefix "/"
        while ((getline line < payload_file_list) > 0) {
          if (line != "") live[prefix line] = 1
        }
        close(payload_file_list)
        while ((getline line < removed_file) > 0) {
          sub(/[\/]+$/, "", line)
          if (line != "") removed[line] = 1
        }
        close(removed_file)
      }
      {
        split($1, metadata, " ")
        target = $2
        if (is_service_path(target) || target in live) next
        print "0 0000000000000000000000000000000000000000\t" target > delete_info
        matched += 1
        mark_removed_candidates(target)
      }
      END {
        print matched + 0 > count_file
        for (removed_path in removed) if (!(removed_path in found)) print removed_path > missing_file
      }
    ' "$index_dump"; then
    rm -rf "$work"
    return 1
  fi
  if [ -s "$missing_file" ]; then
    SHARD_DELTA_REASON='manifest tombstone cross-check failed'
    rm -rf "$work"
    return 1
  fi
  removed_count="$(cat "$count_file")"
  if [ "$removed_count" -gt 0 ] && ! git -C "$stage" update-index --index-info < "$delete_info"; then
    rm -rf "$work"
    return 1
  fi
  SHARD_DELTA_REMOVED_FILES=$((SHARD_DELTA_REMOVED_FILES + removed_count))
  SHARD_DELTA_CONTENT_CHANGES=$((SHARD_DELTA_CONTENT_CHANGES + removed_count))
  rm -rf "$work"
  return 0
}

# shard_delta_remove_file <stage> <target_path>
shard_delta_remove_file() {
  local stage="$1" target="$2"
  if [ -n "$(git -C "$stage" ls-files --stage -- "$target" 2>/dev/null)" ]; then
    git -C "$stage" update-index --force-remove -- "$target" || return 1
    SHARD_DELTA_REMOVED_FILES=$((SHARD_DELTA_REMOVED_FILES + 1))
    SHARD_DELTA_CONTENT_CHANGES=$((SHARD_DELTA_CONTENT_CHANGES + 1))
  fi
  return 0
}

# shard_delta_apply_source_tree <stage> <source_root> <target_prefix>
#   <changed_file_list> <unmanifested_file_list> <payload_file_list>
# Manifest-covered paths arrive from shard-manifest-delta.mjs as a changed
# file list; all other payload paths arrive as a second list. Unchanged live
# paths stay as index entries pointing at the remote blobs and are never
# materialized. The two lists are joined, hashed in one batch, compared with
# one index dump, and applied with one index-info stream: there is no
# per-payload-file git process here.
shard_delta_apply_source_tree() {
  local stage="$1" source_root="$2" target_prefix="$3"
  local changed_file_list="$4" unmanifested_file_list="$5" payload_file_list="$6"
  local work candidate_list metadata index_dump hashes candidate_hashes
  local changed_sources index_info count_file source_count changed_count
  [ -d "$source_root" ] || return 1
  source_root="$(cd "$source_root" && pwd)" || return 1
  [ -f "$changed_file_list" ] || return 1
  [ -f "$unmanifested_file_list" ] || return 1
  [ -f "$payload_file_list" ] || return 1
  SHARD_DELTA_SOURCE_FILES=0
  SHARD_DELTA_CHANGED_FILES=0
  SHARD_DELTA_REUSED_FILES=0
  SHARD_DELTA_REMOVED_FILES=0
  SHARD_DELTA_CONTENT_CHANGES=0
  work="$(mktemp -d)" || return 1
  candidate_list="$work/candidates.txt"
  metadata="$work/metadata.tsv"
  index_dump="$work/index.dump"
  hashes="$work/hashes"
  candidate_hashes="$work/candidate-hashes.tsv"
  changed_sources="$work/changed-sources.txt"
  index_info="$work/index.info"
  count_file="$work/counts"

  if ! awk 'NF { print }' "$payload_file_list" > "$work/payload-nonempty.txt"; then
    rm -rf "$work"
    return 1
  fi
  source_count="$(wc -l < "$work/payload-nonempty.txt" | tr -d ' ')"
  SHARD_DELTA_SOURCE_FILES="${source_count:-0}"
  if ! sort -u "$changed_file_list" "$unmanifested_file_list" > "$candidate_list"; then
    rm -rf "$work"
    return 1
  fi

  if [ -s "$candidate_list" ]; then
    if ! awk -v root="$source_root" -v prefix="$target_prefix" 'NF {
        target = prefix == "" ? $1 : prefix "/" $1
        print $1 "\t" root "/" $1 "\t" target
      }' "$candidate_list" > "$metadata"; then
      rm -rf "$work"
      return 1
    fi
    if ! git -C "$stage" ls-files --stage > "$index_dump"; then
      rm -rf "$work"
      return 1
    fi
    if ! awk -F '\t' '{ print $2 }' "$metadata" | git -C "$stage" hash-object --stdin-paths > "$hashes"; then
      rm -rf "$work"
      return 1
    fi
    if ! paste "$metadata" "$hashes" > "$candidate_hashes"; then
      rm -rf "$work"
      return 1
    fi
    if ! awk -F '\t' \
        -v index_file="$index_dump" \
        -v changed_sources="$changed_sources" \
        -v index_info="$index_info" \
        -v count_file="$count_file" '
        BEGIN {
          while ((getline line < index_file) > 0) {
            split(line, fields, "\t")
            split(fields[1], metadata, " ")
            old_oid[fields[2]] = metadata[2]
          }
          close(index_file)
        }
        {
          target = $3
          new_oid = $4
          if (old_oid[target] == new_oid) {
            reused += 1
          } else {
            print $2 > changed_sources
            print "100644 " new_oid "\t" target > index_info
            changed += 1
          }
        }
        END {
          print changed + 0, reused + 0 > count_file
        }
      ' "$candidate_hashes"; then
      rm -rf "$work"
      return 1
    fi
    read -r changed_count source_count < "$count_file"
    if [ "$changed_count" -gt 0 ]; then
      if ! git -C "$stage" hash-object -w --stdin-paths < "$changed_sources" >/dev/null; then
        rm -rf "$work"
        return 1
      fi
      if ! git -C "$stage" update-index --index-info < "$index_info"; then
        rm -rf "$work"
        return 1
      fi
    fi
    SHARD_DELTA_CHANGED_FILES="$changed_count"
    SHARD_DELTA_CONTENT_CHANGES="$changed_count"
  fi
  SHARD_DELTA_REUSED_FILES=$((SHARD_DELTA_SOURCE_FILES - SHARD_DELTA_CHANGED_FILES))
  rm -rf "$work"
  return 0
}

# shard_delta_count_files <stage> <path-prefix>
shard_delta_count_files() {
  local stage="$1" prefix="$2"
  git -C "$stage" ls-files -- "$prefix" 2>/dev/null | awk 'NF { count += 1 } END { print count + 0 }'
}

# True when the final indexed tree loses more than <pct> percent of its files.
shard_delta_shrink_exceeded() {
  local previous="$1" current="$2" pct="$3"
  [ "$previous" -gt 0 ] \
    && [ "$((current * 100))" -lt "$((previous * (100 - pct)))" ]
}

# shard_orphan_init <dir>
# Resets <dir> to a fresh, history-less git repo on branch `main`. Caller is
# responsible for populating the working tree and committing.
shard_orphan_init() {
  local dir="$1"
  git -C "$dir" init -q
  git -C "$dir" checkout -q -b main
}

# Credential helper used by shard_pat_push. The token is read from
# $SHARD_PUSH_TOKEN *inside* the helper, so it never lands in the remote URL
# (git echoes URLs back in its own error messages), never in argv (`ps` is
# world-readable on a runner) and never in a `set -x` trace of the push.
_SHARD_CRED_HELPER='!f() { test "$1" = get && printf "username=x-access-token\npassword=%s\n" "$SHARD_PUSH_TOKEN"; }; f'

# shard_https_push_url <shard_repo>
# Maps a GitHub SSH remote to its HTTPS equivalent (git@github.com:o/r.git →
# https://github.com/o/r.git; the ssh:// spelling too). An https:// remote is
# passed through unchanged. Anything else (local path, other host) returns 1:
# a GitHub token push only makes sense against github.com.
shard_https_push_url() {
  local repo="$1"
  case "$repo" in
    git@github.com:*)       printf 'https://github.com/%s' "${repo#git@github.com:}" ;;
    ssh://git@github.com/*) printf 'https://github.com/%s' "${repo#ssh://git@github.com/}" ;;
    https://github.com/*)   printf '%s' "$repo" ;;
    *) return 1 ;;
  esac
}

# shard_push_error_is_auth <logfile>
# True when <logfile> holds a git-push failure that authentication/authorization
# caused — i.e. one that is NOT transient and that retrying the SAME credential
# can never fix. Incident 2026-07-30 (run 30522223432): `uri-it` burned 3
# retries + the orphan-flatten self-heal (6 pushes, 15s of sleeps) against
# "ERROR: Permission to nanakokyobashi-rgb/frontaliere-uri-it.git denied to
# deploy key" on EVERY deploy for 3 days. Retrying a read-only/wrong deploy key
# is pure waste; the useful move is to switch credential (shard_pat_push).
# Deliberately does NOT match git's generic "Please make sure you have the
# correct access rights and the repository exists." tail: git prints it for a
# plain unreachable/nonexistent remote too, so matching it would misclassify a
# transient outage as an auth failure and skip the retries that DO help there.
shard_push_error_is_auth() {
  grep -qEi 'denied to (deploy key|user)|permission denied \(publickey\)|permission to .+ denied|repository not found|403 forbidden' "$1"
}

# shard_push_failure_reason <logfile>
# Classifies the last SSH push failure for the PAT fallback's warning. Keep
# this deliberately narrower than shard_push_error_is_auth: a generic git
# access-rights tail is not proof of an auth failure, and a transport error
# must never be reported as a broken deploy key (incident 2026-09-14).
shard_push_failure_reason() {
  local logfile="$1"
  if shard_push_error_is_auth "$logfile"; then
    printf '%s' 'deploy-key authentication/authorization failure'
  elif grep -qEi 'closed by remote host|unexpected disconnect|remote end hung up|early EOF|connection (reset|timed out|refused)|failed to connect|could not resolve host|network is unreachable|sideband packet' "$logfile"; then
    printf '%s' 'transient SSH transport failure'
  else
    printf '%s' 'unclassified SSH push failure'
  fi
}

# shard_pat_push <push_dir> <shard_repo> <refspec> [label] [force] [reason]
# Last-resort force-push over HTTPS authenticated with a PAT
# ($SHARD_PUSH_PAT, else $GITHUB_PAT — the latter is hydrated from Firebase
# Remote Config by scripts/load-rc-env.mjs in every deploy job). Exists because
# a per-shard deploy key is a single point of failure with no operational
# safety net: there are 90+ of them, each one revocable/read-only/rotatable
# independently, and each one lives in a secret that can be silently shadowed
# (repo-level vs `shard-secrets-overflow` environment — see
# scripts/ci/check-shard-secret-shadowing.mjs). The PAT is account-wide and has
# write on every shard repo (both owners), so it recovers ALL of those failure
# modes without touching a single secret. Returns 0 on success, 1 otherwise.
# [force] defaults to 1 (force-push, what every full-replace shard push does).
# Pass 0 from a caller whose whole concurrency model depends on a non-fast-
# forward being an ERROR rather than something to overwrite — that is
# push-article-shard-incremental.sh, where a rejected push means a concurrent
# full deploy moved the tip and the content has to be rebuilt on the new base.
# [reason] is the classified SSH failure, used only to make the recovery
# warning actionable without claiming that every PAT fallback means a broken
# deploy key.
shard_pat_push() {
  local dir="$1" repo="$2" refspec="$3" label="${4:-shard}" force="${5:-1}" reason="${6:-unclassified SSH push failure}"
  # A plain string, not an array: `"${arr[@]}"` on an EMPTY array aborts under
  # `set -u` in bash 3.2 (still the default /bin/bash on macOS, where the test
  # suite runs). Unquoted expansion of a fixed, space-free flag is safe here.
  local url out rc force_flag=''
  if [ "$force" = 1 ]; then force_flag='-f'; fi
  SHARD_PUSH_TOKEN="${SHARD_PUSH_PAT:-${GITHUB_PAT:-}}"
  if [ -z "$SHARD_PUSH_TOKEN" ]; then
    echo "::warning::$label: no SHARD_PUSH_PAT/GITHUB_PAT in the environment — cannot fall back to an HTTPS token push"
    return 1
  fi
  if ! url="$(shard_https_push_url "$repo")"; then
    echo "::warning::$label: cannot derive an HTTPS URL from '$repo' — skipping the token-push fallback"
    return 1
  fi
  # Belt and braces: the RC-loaded PAT is NOT a GH Actions secret, so it is not
  # masked automatically. Register it, then scrub it from this push's output.
  echo "::add-mask::$SHARD_PUSH_TOKEN"
  export SHARD_PUSH_TOKEN
  echo "$label: retrying over HTTPS with a PAT after $reason"
  out="$(mktemp)"
  # stderr (where git writes the whole push transcript) is captured for
  # scrubbing, then re-emitted on stderr — NOT folded into stdout, so this
  # function does not change which stream a caller reads the transcript from.
  # `|| rc=$?` for the same errexit reason as in shard_push_with_retry: this
  # runs under `set -e` whenever the caller chain is bare.
  rc=0
  # shellcheck disable=SC2086  # deliberate: empty $force_flag must vanish
  git -C "$dir" -c credential.helper= -c "credential.helper=$_SHARD_CRED_HELPER" \
    push $force_flag "$url" "$refspec" 2>"$out" || rc=$?
  sed "s|$SHARD_PUSH_TOKEN|***|g" "$out" >&2
  rm -f "$out"
  unset SHARD_PUSH_TOKEN
  if [ "$rc" -eq 0 ]; then
    case "$reason" in
      deploy-key*)
        echo "::warning::$label: pushed via the PAT fallback after $reason — fix or rotate the deploy key; the fallback is a safety net, not the intended path."
        ;;
      transient*)
        echo "::warning::$label: pushed via the PAT fallback after $reason — the deploy key is not classified as broken; investigate recurring transport failures."
        ;;
      *)
        echo "::warning::$label: pushed via the PAT fallback after $reason — inspect the SSH failure above; the deploy key is not automatically classified as broken."
        ;;
    esac
    return 0
  fi
  echo "::warning::$label: PAT fallback push also failed (rc=$rc)"
  return 1
}

# shard_push_with_retry <push_dir> <shard_repo> <refspec> [label]
# Force-pushes <refspec> from <push_dir> to <shard_repo>, retrying up to 3
# attempts with exponential backoff (5s, 10s — $SHARD_PUSH_RETRY_DELAY seeds
# the first delay). An auth-class failure short-circuits the remaining SSH
# retries (see shard_push_error_is_auth). Either way the last resort is
# shard_pat_push. Returns 0 on success, 1 if every credential failed.
# [label] is cosmetic only (prefixes the ::warning:: lines).
shard_push_with_retry() {
  local dir="$1" repo="$2" refspec="$3" label="${4:-shard}"
  local delay="${SHARD_PUSH_RETRY_DELAY:-5}" try out rc fallback_reason='unclassified SSH push failure'
  out="$(mktemp)"
  for try in 1 2 3; do
    # Capture stderr to classify the failure, then put it back on stderr — see
    # the same note in shard_pat_push about not moving it to stdout.
    #
    # `|| rc=$?` is not decorative. The previous shape was `if git push; then`,
    # where the condition context suspended errexit for the push. A BARE failing
    # command does not get that, so under `set -e` it would abort the caller's
    # subshell on attempt 1 — no retries, no fallback, no return value to
    # inspect. Today every caller happens to be safe (the pushers call this from
    # an `if`; compact-article-shard-history.sh calls it bare but from a
    # `( set -e … ) || rc=$?` subshell, and a subshell inside an AND-OR list has
    # errexit suppressed throughout). That safety is one refactor away from
    # gone — dropping compact's `|| rc=$?` would give it push-section-shard.sh's
    # bare-subshell shape, where errexit IS live. The OR list makes this
    # call-context independent instead of accidentally fine.
    rc=0
    git -C "$dir" push -f "$repo" "$refspec" 2>"$out" || rc=$?
    cat "$out" >&2
    if [ "$rc" -eq 0 ]; then
      rm -f "$out"
      return 0
    fi
    fallback_reason="$(shard_push_failure_reason "$out")"
    if shard_push_error_is_auth "$out"; then
      echo "::warning::$label: deploy-key auth failure (not transient) — skipping the remaining SSH retries and falling back to a token push"
      break
    fi
    if [ "$try" -lt 3 ]; then
      echo "::warning::$label push attempt $try/3 failed — retrying in ${delay}s"
      sleep "$delay"; delay=$(( delay * 2 ))
    fi
  done
  rm -f "$out"
  shard_pat_push "$dir" "$repo" "$refspec" "$label" 1 "$fallback_reason"
}

# shard_orphan_flatten_and_push <stage_dir> <shard_repo> <commit_message> [label]
# Flattens <stage_dir> to a single fresh orphan commit and force-pushes it.
# ASSUMES <stage_dir>'s working tree ALREADY holds the exact desired final
# content — this function does not copy or build anything, it only resets
# `.git`, resets the `.shard-deploys` counter to 1 (a fresh flatten is
# deploy #1 since the last flatten), commits, and pushes with retry. Used
# both by push-section-shard.sh / push-locale-shard.sh's self-heal-flatten
# path (a failed incremental push retried as a full orphan push) and by
# compact-article-shard-history.sh's periodic history compaction — same
# mechanism, not a second implementation (AGENTS.md #6).
shard_orphan_flatten_and_push() {
  local dir="$1" repo="$2" msg="$3" label="${4:-shard}"
  rm -rf "${dir:?}/.git"
  shard_orphan_init "$dir"
  git -C "$dir" config user.email "valerielinc@gmail.com"
  git -C "$dir" config user.name "Valerie Linc"
  printf '%s' "1" > "$dir/.shard-deploys"
  git -C "$dir" add -A
  git -C "$dir" commit -qm "$msg"
  shard_push_with_retry "$dir" "$repo" "main" "$label"
}

# shard_history_needs_compaction <clone_dir> <cap>
# Issue #4881 defect B: push-section-shard.sh bounds `.git` growth via its
# `.shard-deploys` proxy counter, but push-article-shard-incremental.sh
# deliberately never increments it (see that script's header) — once a
# section's full-replace push stops running, the counter freezes and that
# cap check never fires again. This measures the ACTUAL commit count instead
# of relying on the frozen proxy: `git rev-list --count HEAD` is tree-graph
# only (same reasoning as shard_read_counter — never fetches blob content),
# so <clone_dir> only needs a `--filter=blob:none --no-checkout` clone.
#
# Prints the commit count at HEAD in <clone_dir> to stdout (or "0" if HEAD
# does not resolve). Return code:
#   0 — commit count >= <cap>: caller should flatten.
#   1 — commit count <  <cap>: below the threshold, no action needed.
#   2 — HEAD does not resolve (no commits yet on this clone/branch): nothing
#       to compact. Distinct from 1 so callers can treat an otherwise-live
#       shard with zero commits as the real error it is, not a quiet no-op.
#
# Caller note: `n=$(shard_history_needs_compaction ...)` under `set -e` MUST
# be guarded (e.g. `n="$(... )" || rc=$?`) — an unguarded plain assignment
# aborts the subshell on the very return codes (1, 2) this function uses to
# signal "no compaction needed" / "no commits yet", before the caller ever
# gets to inspect them. Exactly the same class of latent bug shard_read_counter
# and the shrink guard in push-section-shard.sh/push-locale-shard.sh fix
# elsewhere in this file — a plumbing helper whose non-zero return is a
# normal, expected outcome, not a hard failure.
shard_history_needs_compaction() {
  local dir="$1" cap="$2" n
  if ! git -C "$dir" rev-parse -q --verify HEAD >/dev/null 2>&1; then
    printf '%s' "0"
    return 2
  fi
  n="$(git -C "$dir" rev-list --count HEAD)"
  printf '%s' "$n"
  [ "$n" -ge "$cap" ]
}
