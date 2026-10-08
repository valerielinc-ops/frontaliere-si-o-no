#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/push-article-shard-incremental.sh — MERGE-aware single-article
# push into an existing (section, locale) article shard repo.
#
# Sibling of scripts/lib/push-section-shard.sh, NOT a modification of it.
# push-section-shard.sh is FULL-REPLACE by construction (even its "incremental"
# fast path wipes the ENTIRE staged working tree — see its `find ... -exec rm
# -rf {} +` at :156 — then repopulates solely from the caller's COMPLETE dist
# subtree; its only safety net is a >50% file-count shrink heuristic, a COUNT
# check, not a correctness check). Using it to publish ONE freshly-rendered
# article would delete the rest of the shard's content. This script has the
# OPPOSITE contract: touch ONLY the given relpaths, never delete or replace
# anything else — see issue #4837 (near-instant single-article publish) §2.
#
# Mechanism: git plumbing against a `--filter=blob:none --no-checkout` clone —
# no working-tree checkout, no bulk blob download. Verified end-to-end against
# a local bare repo (see the PR description for the transcript):
#   - `git read-tree HEAD`, `git ls-tree HEAD -- <path>` and
#     `git rev-parse HEAD^{tree}` need ONLY tree objects — never fetch a blob.
#   - Plain `git write-tree` is NOT blob-content-agnostic in practice: it
#     eagerly validates (and therefore lazily FETCHES) the blob referenced by
#     EVERY index entry, including paths we never touched — on an 86 MB shard
#     that means silently downloading the whole repo on every single-article
#     push, defeating the entire point of this script. Fix, confirmed to
#     produce the byte-identical tree SHA while fetching zero extra blobs:
#     `git write-tree --missing-ok`.
#   - `git commit-tree` and a non-force `git push` need no blob content either
#     — push only ever transfers objects the remote doesn't already have.
#   - Reading the previous `.shard-filecount` via `git show HEAD:.shard-filecount`
#     DOES lazily fetch that one small blob — acceptable (a few bytes), and
#     more robust than push-section-shard.sh's raw.githubusercontent.com route
#     (:126): no CDN caching/staleness and no unauthenticated 60/hr rate limit,
#     and the object graph we already cloned is authoritative for exactly the
#     HEAD we are about to build on top of.
#
# Merge semantics hold BY CONSTRUCTION: the base tree is the remote's current
# tree; only the caller's relpaths are added/replaced in the index before
# `write-tree` runs. No existing path can ever be dropped, so the 50%-shrink
# guard push-section-shard.sh needs does not apply here.
#
# `.shard-deploys` is intentionally NEVER incremented by this script. That
# counter drives push-section-shard.sh's 50-deploy flatten-to-orphan history
# cap (SHARD_HISTORY_CAP) — a fast single-article push runs far more often
# than a full deploy and must NOT accelerate that cycle. Do not "fix" this to
# look consistent with push-section-shard.sh; the omission is deliberate.
#
# Usage:
#   push-article-shard-incremental.sh <section> <locale> <scratch_dist_dir> <relpath1> [relpath2 ...]
#     <section>           any key in scripts/lib/section-shard-slugs.json
#                         (today: articolifrontaliere, articolisvizzera)
#     <locale>            ∈ {it, en, de, fr}
#     <scratch_dist_dir>  small scratch dir holding ONLY the file(s) being pushed
#     <relpathN>          path(s) relative to <scratch_dist_dir> that are ALSO
#                         (verified) the exact destination path inside the
#                         shard repo, e.g. articoli-frontaliere/some-slug/index.html
#
# Required env (identical convention to push-section-shard.sh):
#   SHARD_<SECTION_UPPER>_<LOCALE_UPPER>_DEPLOY_KEY — e.g.
#     SHARD_ARTICOLIFRONTALIERE_IT_DEPLOY_KEY. SSH-only write deploy key for
#     frontaliere-<section>-<locale>. Read via indirect expansion.
#     Missing → notice + exit 0 (silent no-op, matches the sibling).
# Optional env:
#   RUNNER_TEMP — scratch dir; falls back to a mktemp dir if unset (logged).
#
# Exit codes:
#   0 — pushed, or a clean no-op (identical content already live, or the
#       deploy-key secret is not provisioned for this section+locale yet)
#   1 — bad usage, a source relpath is missing on disk, a rendered page still
#       points at same-origin/missing/unverified CDN assets, the shard repo has
#       no commits on main yet (needs push-section-shard.sh to seed it first),
#       or the push failed after the bounded retry budget
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

# shard_pat_push — the shared token-push fallback for a refused deploy key.
source "$(dirname "${BASH_SOURCE[0]}")/shard-git-helpers.sh"

if [ "$#" -lt 4 ]; then
  echo "Usage: push-article-shard-incremental.sh <section> <locale> <scratch_dist_dir> <relpath1> [relpath2 ...]" >&2
  exit 1
fi
section="$1"
loc="$2"
scratch_dist_dir="$3"
shift 3
relpaths=("$@")

case "$loc" in
  it|en|de|fr) ;;
  *) echo "::error::unsupported locale '$loc' (expected it|de|en|fr)" >&2; exit 1 ;;
esac

repo_root="$(pwd)"
owners_json="$repo_root/scripts/lib/section-shard-owners.json"
cdn_asset_gate="$repo_root/scripts/ci/verify-cdn-asset-publish.mjs"
SECTION_UPPER="$(echo "$section" | tr a-z A-Z)"
LOC_UPPER="$(echo "$loc" | tr a-z A-Z)"

# Missing source files are a caller bug (stream C rendered/passed the wrong
# path) — fail loudly rather than silently skip, so the mistake surfaces
# immediately instead of quietly publishing nothing.
for rel in "${relpaths[@]}"; do
  if [ ! -f "$scratch_dist_dir/$rel" ]; then
    echo "::error::source file missing: $scratch_dist_dir/$rel" >&2
    exit 1
  fi
done

# Per-section-per-locale deploy key via indirect expansion (mirrors
# push-section-shard.sh). Missing → skip, exit 0 — the caller (the fast-path
# workflow) treats this the same as "fast path not provisioned yet" and lets
# the article ride the next full deploy instead.
key_var="SHARD_${SECTION_UPPER}_${LOC_UPPER}_DEPLOY_KEY"
key_val="${!key_var:-}"
if [ -z "$key_val" ]; then
  echo "no $key_var secret — skipping $loc $section article fast-path push (not provisioned)"
  exit 0
fi

# A fast publisher renders current-main HTML without publishing the full
# dist/assets producer set. Keep the old shard page live unless every asset
# ref in the exact replacement files is live on the CDN; an unknown response
# is a failure too, because publishing it would create a page that cannot
# boot until a later full deploy. This is the single mutation-point guard for
# publish-article-fast, rerender-article-hubs, and rerender-article-corpus.
cdn_gate_args=(--dist "$scratch_dist_dir")
for rel in "${relpaths[@]}"; do
  cdn_gate_args+=(--file "$rel")
done
if ! node "$cdn_asset_gate" "${cdn_gate_args[@]}"; then
  echo "::error::refusing $loc $section article shard publication: replacement HTML is not CDN-coherent" >&2
  exit 1
fi

SHARD_OWNER="$(jq -r --arg s "$section" '.[$s] // "valerielinc-ops"' "$owners_json" 2>/dev/null || echo valerielinc-ops)"
if [ -z "$SHARD_OWNER" ] || [ "$SHARD_OWNER" = "null" ]; then SHARD_OWNER="valerielinc-ops"; fi
SHARD_REPO="git@github.com:$SHARD_OWNER/frontaliere-$section-$loc.git"
if [ -n "${SHARD_REPO_OVERRIDE:-}" ]; then
  SHARD_REPO="$SHARD_REPO_OVERRIDE"
fi

if [ -z "${RUNNER_TEMP:-}" ]; then
  RUNNER_TEMP="$(mktemp -d)"
  echo "ℹ️ RUNNER_TEMP unset — using temp dir $RUNNER_TEMP"
fi
SHARD_PUSH_FAIL_REASON_FILE="${RUNNER_TEMP:-/tmp}/shard-fail-reason-$section-$loc"
: > "$SHARD_PUSH_FAIL_REASON_FILE" 2>/dev/null || true

keyfile="$RUNNER_TEMP/article-shard_${section}_${loc}_key"
printf '%s\n' "$key_val" > "$keyfile" && chmod 600 "$keyfile"
export GIT_SSH_COMMAND="ssh -i $keyfile -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o TCPKeepAlive=yes"

stage="$RUNNER_TEMP/article-shard-$section-$loc"
# A concurrent full deploy can keep moving the shard tip for longer than the
# original three-attempt window. Run 37533981133 observed exactly that shape:
# all three non-fast-forward retries saw a newer remote tip. Keep the retry
# budget bounded, but leave enough time for the competing publisher to finish.
retry_max_attempts="${SHARD_INCREMENTAL_PUSH_MAX_ATTEMPTS:-6}"
retry_delay="${SHARD_INCREMENTAL_PUSH_RETRY_DELAY:-5}"
if ! [[ "$retry_max_attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::SHARD_INCREMENTAL_PUSH_MAX_ATTEMPTS must be a positive integer" >&2
  exit 1
fi
if ! [[ "$retry_delay" =~ ^[0-9]+$ ]]; then
  echo "::error::SHARD_INCREMENTAL_PUSH_RETRY_DELAY must be a non-negative integer" >&2
  exit 1
fi
# Incident #4734 was an unfreed-staging-dir class (runner disk exhaustion) —
# a script-level EXIT trap covers every return path (success, retry-exhausted
# failure, bad usage exit above already returned before this point anyway),
# not just the happy path.
trap 'rm -rf "$stage" 2>/dev/null || true; rm -f "$keyfile" 2>/dev/null || true' EXIT

permanent_fail=0
# Set by _attempt once it has a commit to push; read by the PAT fallback after
# the retry loop. Declared here because `set -u` is on.
last_commit=''
last_skipped_newer_count=0
last_skipped_newer_names=''
last_history_warning_count=0

article_content_revision="${ARTICLE_CONTENT_REVISION:-}"
if [ -n "$article_content_revision" ] && ! [[ "$article_content_revision" =~ ^[0-9]+\.[0-9A-Fa-f]{7,40}$ ]]; then
  echo "::error::ARTICLE_CONTENT_REVISION must be <epoch>.<sha> (7–40 hexadecimal characters)" >&2
  exit 1
fi

remote_newer_paths=()

append_remote_newer_path() {
  local candidate="$1"
  local existing
  for existing in "${remote_newer_paths[@]}"; do
    [ "$existing" = "$candidate" ] && return 0
  done
  remote_newer_paths+=("$candidate")
}

# True when the page published from `remote` must be kept over one rendered
# from `own`: a later epoch, or the same second with a different commit. Two
# corpus commits of one second cannot be ordered from here, so the remote one
# is treated as newer. The same commit (one SHA a prefix of the other) is the
# same revision and stays replaceable: that is a re-render of the same content,
# for instance with a newer shell.
remote_revision_wins() {
  local remote="$1" own="$2"
  local remote_epoch="${remote%%.*}" own_epoch="${own%%.*}"
  local remote_sha own_sha
  remote_sha="$(printf '%s' "${remote#*.}" | tr 'A-F' 'a-f')"
  own_sha="$(printf '%s' "${own#*.}" | tr 'A-F' 'a-f')"
  if [ "$remote_epoch" -gt "$own_epoch" ]; then return 0; fi
  if [ "$remote_epoch" -lt "$own_epoch" ]; then return 1; fi
  case "$remote_sha" in "$own_sha"*) return 1 ;; esac
  case "$own_sha" in "$remote_sha"*) return 1 ;; esac
  return 0
}

# A history that cannot be read is not "nothing newer": it is exactly the case
# in which a newer page could be overwritten without anyone noticing. The
# attempt fails before any commit is built, the caller retries, and a history
# that stays unreadable fails the push.
history_unavailable() {
  echo "::warning::monotonic guard: $1; refusing to publish without the shard history" >&2
  last_history_warning_count=$((last_history_warning_count + 1))
  remote_newer_paths=()
  return 1
}

collect_remote_newer_paths() {
  local own_revision="$1"
  local own_epoch="${own_revision%%.*}"
  local head_epoch boundary commits commit trailer parent changed_path changed_paths shallow_file
  remote_newer_paths=()

  head_epoch="$(git -C "$stage" show -s --format=%ct HEAD 2>/dev/null)" || {
    history_unavailable "cannot read the shard HEAD timestamp"
    return 1
  }
  if ! [[ "$head_epoch" =~ ^[0-9]+$ ]]; then
    history_unavailable "the shard HEAD timestamp is unreadable"
    return 1
  fi
  # A commit is never older than the corpus revision it publishes: if the shard
  # head predates this revision, no commit can carry a newer or equal one, and
  # nothing else is read.
  if [ "$head_epoch" -lt "$own_epoch" ]; then return 0; fi

  boundary=$((own_epoch - 3600))
  if ! git -C "$stage" fetch --quiet --filter=blob:none --shallow-since="$boundary" origin main >/dev/null 2>&1; then
    history_unavailable "the shard history fetch failed"
    return 1
  fi
  # The oldest commit of that window comes without its parent, and on a quiet
  # shard that commit IS the newer publication (the one before it is hours
  # old): with nothing to diff it against, its paths would not be recognised
  # and the page would be overwritten. One more level puts the parent on disk.
  # Only while the clone is still shallow: on a history that the window made
  # complete, --deepen would cut it back to one commit.
  if [ "$(git -C "$stage" rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
    if ! git -C "$stage" fetch --quiet --filter=blob:none --deepen=1 origin main >/dev/null 2>&1; then
      history_unavailable "the shard history deepen failed"
      return 1
    fi
  fi
  shallow_file="$(git -C "$stage" rev-parse --absolute-git-dir 2>/dev/null)/shallow"
  commits="$(git -C "$stage" log --format=%H HEAD 2>/dev/null)" || {
    history_unavailable "the shard history is unreadable"
    return 1
  }
  while IFS= read -r commit; do
    [ -n "$commit" ] || continue
    trailer="$(git -C "$stage" show -s --format='%(trailers:key=Content-Rev,valueonly)' "$commit" 2>/dev/null)" || {
      history_unavailable "cannot inspect shard commit $commit"
      return 1
    }
    trailer="$(printf '%s' "$trailer" | sed -n '1p')"
    [[ "$trailer" =~ ^[0-9]+\.[0-9A-Fa-f]{7,40}$ ]] || continue
    remote_revision_wins "$trailer" "$own_revision" || continue
    # The paths of a winning publication are always listed: either its parent
    # is on disk, or it is a true root commit; anything else is an unreadable
    # history, never a silent skip.
    if parent="$(git -C "$stage" rev-parse --verify --quiet "$commit^" 2>/dev/null)"; then
      changed_paths="$(git -C "$stage" diff-tree --no-commit-id --name-only -r "$parent" "$commit" 2>/dev/null)" || changed_paths='__unreadable__'
    elif [ -f "$shallow_file" ] && grep -qx "$commit" "$shallow_file" 2>/dev/null; then
      changed_paths='__unreadable__'
    else
      changed_paths="$(git -C "$stage" diff-tree --root --no-commit-id --name-only -r "$commit" 2>/dev/null)" || changed_paths='__unreadable__'
    fi
    if [ "$changed_paths" = '__unreadable__' ]; then
      history_unavailable "cannot list the paths of shard commit $commit"
      return 1
    fi
    while IFS= read -r changed_path; do
      [ -n "$changed_path" ] || continue
      append_remote_newer_path "$changed_path"
    done <<< "$changed_paths"
  done <<< "$commits"
}

write_push_summary() {
  local summary_file="${ARTICLE_PUSH_SUMMARY_FILE:-}"
  [ -n "$summary_file" ] || return 0
  if ! mkdir -p "$(dirname "$summary_file")" 2>/dev/null; then
    echo "::warning::unable to create push summary directory for $summary_file" >&2
    return 0
  fi
  printf '%s\t%s\t%s\t%s\n' \
    "$section-$loc" \
    "$last_skipped_newer_count" \
    "$last_skipped_newer_names" \
    "$last_history_warning_count" > "$summary_file" || true
}

_attempt() {
  rm -rf "$stage"
  local clone_err
  clone_err="$(mktemp)"
  if ! git clone -q --depth 1 --filter=blob:none --no-checkout "$SHARD_REPO" "$stage" 2>"$clone_err"; then
    echo "::warning::clone of $SHARD_REPO failed: $(cat "$clone_err")"
    rm -f "$clone_err"
    return 1
  fi
  rm -f "$clone_err"

  if ! git -C "$stage" rev-parse -q --verify HEAD >/dev/null 2>&1; then
    echo "::error::$SHARD_REPO has no commits on main yet — run push-section-shard.sh (full push) first to seed CNAME/.nojekyll/base structure" >&2
    permanent_fail=1
    return 1
  fi

  # Canonical identity, mirroring push-section-shard.sh:193-194 and
  # push-locale-shard.sh:214-215. NOT optional: `git commit-tree` below fails
  # with `fatal: empty ident name ... not allowed` when no identity is
  # configured, and an Actions runner has none. Without this every fast-publish
  # would die at commit-tree on all three retries — the feature would be inert
  # on merge while the workflow's `|| fail=1` fault-tolerance kept CI from
  # failing loudly. Local runs hide it because developer machines have a global
  # git identity.
  git -C "$stage" config user.email "valerielinc@gmail.com" || return 1
  git -C "$stage" config user.name "Valerie Linc" || return 1

  git -C "$stage" read-tree HEAD || return 1

  local -a eligible_relpaths=()
  local -a skipped_newer_paths=()
  local rel src sha new_count=0
  last_skipped_newer_count=0
  last_skipped_newer_names=''
  last_history_warning_count=0

  if [ -n "$article_content_revision" ]; then
    collect_remote_newer_paths "$article_content_revision" || return 1
  fi
  for rel in "${relpaths[@]}"; do
    local is_newer=0
    if [ -n "$article_content_revision" ]; then
      local newer_path
      for newer_path in "${remote_newer_paths[@]}"; do
        if [ "$newer_path" = "$rel" ]; then is_newer=1; break; fi
      done
    fi
    if [ "$is_newer" = 1 ]; then
      skipped_newer_paths+=("$rel")
    else
      eligible_relpaths+=("$rel")
    fi
  done

  last_skipped_newer_count="${#skipped_newer_paths[@]}"
  if [ "$last_skipped_newer_count" -gt 0 ]; then
    local skipped_name shown_count=0
    for skipped_name in "${skipped_newer_paths[@]}"; do
      [ "$shown_count" -ge 5 ] && break
      if [ -n "$last_skipped_newer_names" ]; then
        last_skipped_newer_names="$last_skipped_newer_names,$skipped_name"
      else
        last_skipped_newer_names="$skipped_name"
      fi
      shown_count=$((shown_count + 1))
    done
    echo "monotonic guard: kept remote for $last_skipped_newer_count newer article path(s): $last_skipped_newer_names"
  fi

  for rel in "${eligible_relpaths[@]}"; do
    src="$scratch_dist_dir/$rel"
    # ls-tree only touches tree objects (never a blob fetch) — used purely to
    # classify rel as "new" vs "replaced" for the .shard-filecount delta below.
    if [ -z "$(git -C "$stage" ls-tree HEAD -- "$rel" 2>/dev/null)" ]; then
      new_count=$((new_count + 1))
    fi
    sha="$(git -C "$stage" hash-object -w --path="$rel" "$src")" || return 1
    git -C "$stage" update-index --add --cacheinfo 100644,"$sha","$rel" || return 1
  done

  # Previous file-count: read straight from the tree we just cloned (a single
  # small targeted blob fetch — see header comment for why this beats the
  # raw.githubusercontent.com route). Missing/non-numeric → 0, same posture as
  # push-section-shard.sh.
  local prev_n
  prev_n="$(git -C "$stage" show HEAD:.shard-filecount 2>/dev/null || echo 0)"
  [[ "$prev_n" =~ ^[0-9]+$ ]] || prev_n=0
  local new_total=$((prev_n + new_count))
  if [ "$new_count" -gt 0 ]; then
    local fc_sha
    fc_sha="$(printf '%s' "$new_total" | git -C "$stage" hash-object -w --stdin --path=.shard-filecount)" || return 1
    git -C "$stage" update-index --add --cacheinfo 100644,"$fc_sha",.shard-filecount || return 1
  fi

  local new_tree head_tree
  new_tree="$(git -C "$stage" write-tree --missing-ok)" || return 1
  # shellcheck disable=SC1083  # HEAD^{tree} is git rev-parse syntax, not a shell brace expansion
  head_tree="$(git -C "$stage" rev-parse HEAD^{tree})"
  if [ "$new_tree" = "$head_tree" ]; then
    echo "$section-$loc article shard: no content changes vs remote — clean no-op ($new_count new, prev_n=$prev_n)"
    return 0
  fi

  local commit
  if [ -n "$article_content_revision" ]; then
    commit="$(git -C "$stage" commit-tree "$new_tree" -p HEAD \
      -m "$section-$loc article fast-push (${GITHUB_SHA:-local}) — +$new_count new, ${#eligible_relpaths[@]} path(s) touched" \
      -m "Content-Rev: $article_content_revision")" || return 1
  else
    commit="$(git -C "$stage" commit-tree "$new_tree" -p HEAD \
      -m "$section-$loc article fast-push (${GITHUB_SHA:-local}) — +$new_count new, ${#eligible_relpaths[@]} path(s) touched")" || return 1
  fi
  # Published for the PAT fallback below: it re-pushes THIS commit, so it must
  # outlive the function scope.
  last_commit="$commit"

  local tree_check_rc=0
  shard_report_largest_tree "$stage" "$commit" "$section-$loc article shard" || tree_check_rc=$?
  if [ "$tree_check_rc" -ne 0 ]; then
    if [ "$tree_check_rc" -eq 3 ]; then permanent_fail=1; fi
    return "$tree_check_rc"
  fi

  # Never `push -f`: a non-fast-forward here means someone else (the periodic
  # full deploy's push-section-shard.sh, or another fast-path publish) pushed
  # in the meantime. Re-clone onto the new tip and rebuild, don't overwrite it.
  if git -C "$stage" push "$SHARD_REPO" "$commit":main; then
    echo "✅ $section-$loc article shard: pushed $commit ($new_count new file(s), filecount $prev_n -> $new_total)"
    return 0
  fi
  return 1
}

ok=0
for ((try = 1; try <= retry_max_attempts; try++)); do
  if _attempt; then ok=1; break; fi
  if [ "$permanent_fail" = 1 ]; then break; fi
  if [ "$try" -lt "$retry_max_attempts" ]; then
    echo "::warning::$section-$loc article shard push attempt $try/$retry_max_attempts failed — retrying in ${retry_delay}s (re-clone to pick up any concurrent push)"
    sleep "$retry_delay"
    retry_delay=$((retry_delay * 2))
  fi
done

if [ "$ok" != 1 ] && [ "$permanent_fail" != 1 ] && [ -n "$last_commit" ]; then
  # Last resort, same contract as shard_push_with_retry's: a deploy key that is
  # read-only/revoked/shadowed refuses every attempt identically, and an article
  # that misses the fast path waits for the next full deploy. force=0 — a
  # non-fast-forward here still has to FAIL (a concurrent full deploy moved the
  # tip; the tree must be rebuilt on it, never overwritten).
  if shard_pat_push "$stage" "$SHARD_REPO" "$last_commit":main "$section-$loc article shard" 0; then
    ok=1
  fi
fi

if [ "$ok" != 1 ]; then
  if [ "$permanent_fail" != 1 ]; then
    echo "::error::$section-$loc article shard push failed after $retry_max_attempts attempts (+ PAT fallback)" >&2
  fi
  write_push_summary
  exit 1
fi
write_push_summary
exit 0
