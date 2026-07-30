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
#   1 — bad usage, a source relpath is missing on disk, the shard repo has no
#       commits on main yet (needs push-section-shard.sh to seed it first), or
#       the push failed after 3 retries
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

SHARD_OWNER="$(jq -r --arg s "$section" '.[$s] // "valerielinc-ops"' "$owners_json" 2>/dev/null || echo valerielinc-ops)"
if [ -z "$SHARD_OWNER" ] || [ "$SHARD_OWNER" = "null" ]; then SHARD_OWNER="valerielinc-ops"; fi
SHARD_REPO="git@github.com:$SHARD_OWNER/frontaliere-$section-$loc.git"

if [ -z "${RUNNER_TEMP:-}" ]; then
  RUNNER_TEMP="$(mktemp -d)"
  echo "ℹ️ RUNNER_TEMP unset — using temp dir $RUNNER_TEMP"
fi

keyfile="$RUNNER_TEMP/article-shard_${section}_${loc}_key"
printf '%s\n' "$key_val" > "$keyfile" && chmod 600 "$keyfile"
export GIT_SSH_COMMAND="ssh -i $keyfile -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

stage="$RUNNER_TEMP/article-shard-$section-$loc"
# Incident #4734 was an unfreed-staging-dir class (runner disk exhaustion) —
# a script-level EXIT trap covers every return path (success, retry-exhausted
# failure, bad usage exit above already returned before this point anyway),
# not just the happy path.
trap 'rm -rf "$stage" 2>/dev/null || true; rm -f "$keyfile" 2>/dev/null || true' EXIT

permanent_fail=0
# Set by _attempt once it has a commit to push; read by the PAT fallback after
# the retry loop. Declared here because `set -u` is on.
last_commit=''

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

  local rel src sha new_count=0
  for rel in "${relpaths[@]}"; do
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
  commit="$(git -C "$stage" commit-tree "$new_tree" -p HEAD -m "$section-$loc article fast-push (${GITHUB_SHA:-local}) — +$new_count new, ${#relpaths[@]} path(s) touched")" || return 1
  # Published for the PAT fallback below: it re-pushes THIS commit, so it must
  # outlive the function scope.
  last_commit="$commit"

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
delay=5
for try in 1 2 3; do
  if _attempt; then ok=1; break; fi
  if [ "$permanent_fail" = 1 ]; then break; fi
  if [ "$try" -lt 3 ]; then
    echo "::warning::$section-$loc article shard push attempt $try/3 failed — retrying in ${delay}s (re-clone to pick up any concurrent push)"
    sleep "$delay"
    delay=$((delay * 2))
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
    echo "::error::$section-$loc article shard push failed after 3 attempts (+ PAT fallback)" >&2
  fi
  exit 1
fi
exit 0
