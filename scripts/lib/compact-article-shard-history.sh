#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/compact-article-shard-history.sh — periodic history flatten for
# a single (section, locale) shard repo, driven by real commit count instead
# of push-section-shard.sh's `.shard-deploys` proxy counter (issue #4881
# defect B).
#
# push-section-shard.sh bounds .git growth by incrementing `.shard-deploys`
# on every full-replace push and flattening to a single orphan commit once
# SHARD_HISTORY_CAP (default 50) is reached (shard_orphan_flatten_and_push,
# scripts/lib/shard-git-helpers.sh). push-article-shard-incremental.sh
# deliberately NEVER increments `.shard-deploys` — see its own header: a fast
# single-article publish runs far more often than a full deploy and must not
# accelerate that flatten cycle. That is correct in isolation, but once a
# section's full-replace push stops running entirely (articles served solely
# via the fast-publish path, issue #4837) `.shard-deploys` freezes at
# whatever value it last had and push-section-shard.sh's cap check never
# runs again for that shard — every subsequent fast-publish appends ONE more
# commit forever, unbounded `.git` growth.
#
# Fix: measure history directly. `git rev-list --count HEAD` against a
# `--filter=blob:none --no-checkout` clone is tree-graph-only (never fetches
# blob content, same reasoning as shard_read_counter in shard-git-helpers.sh)
# and is the actual thing being bounded, not a proxy for it. Deliberately
# does NOT touch push-article-shard-incremental.sh (no new counter, no side
# effect added to that latency-critical fast-publish hot path) and does NOT
# reuse SHARD_HISTORY_CAP=50 as-is: fast single-article pushes accumulate
# commits far faster than full deploys did, so a separate, higher, DOCUMENTED
# cap (ARTICLE_SHARD_HISTORY_CAP, default 500) avoids flattening on every run
# for a shard that is simply publishing normally.
#
# Meant to be invoked periodically by a scheduled workflow (NOT per-deploy —
# see .github/workflows/compact-article-shard-history.yml), one (section,
# locale) pair per invocation, same convention as push-section-shard.sh /
# push-article-shard-incremental.sh. Reuses shard_orphan_flatten_and_push
# rather than reimplementing orphan-flatten a third time (AGENTS.md #6).
#
# Runs safely against ANY section+locale shard, not just today's article
# sections (articolifrontaliere, articolisvizzera): a shard still on the
# full-replace path self-flattens via SHARD_HISTORY_CAP long before 500 real
# commits, so this is a cheap no-op for it — no workflow change needed the
# next time another section migrates to incremental-only publishing.
#
# Usage:
#   compact-article-shard-history.sh <section> <locale>
#     <section>  any key in scripts/lib/section-shard-slugs.json
#     <locale>   ∈ {it, en, de, fr}
#
# Required env (identical convention to push-section-shard.sh /
# push-article-shard-incremental.sh):
#   SHARD_<SECTION_UPPER>_<LOCALE_UPPER>_DEPLOY_KEY — SSH-only write deploy
#   key for frontaliere-<section>-<locale>. Missing -> notice + exit 0
#   (silent no-op, matches both siblings).
# Optional env:
#   ARTICLE_SHARD_HISTORY_CAP (default 500) — commit-count threshold at or
#     above which history is flattened to a single orphan commit.
#   RUNNER_TEMP — scratch dir; falls back to `mktemp -d` if unset (logged).
#
# Exit codes:
#   0 — below cap (no-op), flattened successfully, or no deploy key
#       provisioned for this section+locale yet.
#   1 — bad usage, clone failed, repo has no commits on main yet, or the
#       flatten push failed after retries.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/shard-git-helpers.sh"

section="${1:-}"
loc="${2:-}"
if [ -z "$section" ] || [ -z "$loc" ]; then
  echo "Usage: compact-article-shard-history.sh <section> <locale>" >&2
  exit 1
fi
case "$loc" in
  it|en|de|fr) ;;
  *) echo "::error::unsupported locale '$loc' (expected it|de|en|fr)" >&2; exit 1 ;;
esac

repo_root="$(pwd)"
owners_json="$repo_root/scripts/lib/section-shard-owners.json"
SECTION_UPPER="$(echo "$section" | tr a-z A-Z)"
LOC_UPPER="$(echo "$loc" | tr a-z A-Z)"

key_var="SHARD_${SECTION_UPPER}_${LOC_UPPER}_DEPLOY_KEY"
key_val="${!key_var:-}"
if [ -z "$key_val" ]; then
  echo "no $key_var secret — skipping $loc $section history compaction (not provisioned)"
  exit 0
fi

SHARD_OWNER="$(jq -r --arg s "$section" '.[$s] // "valerielinc-ops"' "$owners_json" 2>/dev/null || echo valerielinc-ops)"
if [ -z "$SHARD_OWNER" ] || [ "$SHARD_OWNER" = "null" ]; then SHARD_OWNER="valerielinc-ops"; fi
SHARD_REPO="git@github.com:$SHARD_OWNER/frontaliere-$section-$loc.git"

if [ -z "${RUNNER_TEMP:-}" ]; then
  RUNNER_TEMP="$(mktemp -d)"
  echo "ℹ️ RUNNER_TEMP unset — using temp dir $RUNNER_TEMP"
fi

ARTICLE_SHARD_HISTORY_CAP="${ARTICLE_SHARD_HISTORY_CAP:-500}"

keyfile="$RUNNER_TEMP/compact-shard_${section}_${loc}_key"
printf '%s\n' "$key_val" > "$keyfile" && chmod 600 "$keyfile"
export GIT_SSH_COMMAND="ssh -i $keyfile -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

stage="$RUNNER_TEMP/compact-shard-$section-$loc"
# Incident #4734 unfreed-staging-dir class (runner disk exhaustion) — cover
# every return path via EXIT trap, not just the happy path.
trap 'rm -rf "$stage" 2>/dev/null || true; rm -f "$keyfile" 2>/dev/null || true' EXIT

rc=0
(
  set -e
  rm -rf "$stage"
  # Blobless, no-checkout probe clone: rev-list --count is tree-graph-only,
  # never fetches blob content.
  git clone -q --filter=blob:none --no-checkout "$SHARD_REPO" "$stage"

  # Guarded assignment (`|| cap_rc=$?`), not a bare `n_commits=$(...)`: this
  # helper's normal, expected outcomes are non-zero returns (1 = below cap,
  # 2 = no commits yet) — an unguarded assignment would let `set -e` kill
  # this subshell right here before the case below ever runs. See
  # shard_history_needs_compaction's own header in shard-git-helpers.sh.
  cap_rc=0
  n_commits="$(shard_history_needs_compaction "$stage" "$ARTICLE_SHARD_HISTORY_CAP")" || cap_rc=$?

  case "$cap_rc" in
    2)
      echo "::error::$SHARD_REPO has no commits on main yet — nothing to compact" >&2
      exit 1
      ;;
    1)
      echo "$section-$loc shard: $n_commits commit(s) < cap $ARTICLE_SHARD_HISTORY_CAP — no compaction needed"
      exit 0
      ;;
  esac

  echo "$section-$loc shard: $n_commits commit(s) >= cap $ARTICLE_SHARD_HISTORY_CAP — flattening to a single orphan commit"
  # shard_orphan_flatten_and_push commits whatever is CURRENTLY on disk in
  # $stage — the blobless probe clone above has no working tree, so re-clone
  # WITH a full checkout here to materialize the real current content before
  # handing it off.
  rm -rf "$stage"; mkdir -p "$stage"
  git clone -q "$SHARD_REPO" "$stage"
  git -C "$stage" config user.email "valerielinc@gmail.com"
  git -C "$stage" config user.name "Valerie Linc"
  shard_orphan_flatten_and_push "$stage" "$SHARD_REPO" \
    "$section-$loc shard history compaction (run ${GITHUB_RUN_ID:-local}) [$n_commits -> 1 commit]" \
    "$section-$loc shard compaction"
) || rc=$?

if [ "$rc" -eq 0 ]; then
  echo "✅ $section-$loc shard history compaction check complete"
else
  echo "::error::$section-$loc shard history compaction failed (rc=$rc)"
fi
exit "$rc"
