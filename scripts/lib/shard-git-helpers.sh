#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/shard-git-helpers.sh — shared git-plumbing helpers for the
# section/locale/article shard push scripts (push-section-shard.sh,
# push-locale-shard.sh, compact-article-shard-history.sh). SOURCED, not
# executed (mirrors scripts/lib/github-api-version.sh's `source` convention).
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

# shard_orphan_init <dir>
# Resets <dir> to a fresh, history-less git repo on branch `main`. Caller is
# responsible for populating the working tree and committing.
shard_orphan_init() {
  local dir="$1"
  git -C "$dir" init -q
  git -C "$dir" checkout -q -b main
}

# shard_push_with_retry <push_dir> <shard_repo> <refspec> [label]
# Force-pushes <refspec> from <push_dir> to <shard_repo>, retrying up to 3
# attempts with exponential backoff (5s, 10s). Returns 0 on success, 1 if all
# attempts fail. [label] is cosmetic only (prefixes the ::warning:: lines).
shard_push_with_retry() {
  local dir="$1" repo="$2" refspec="$3" label="${4:-shard}"
  local delay=5 try
  for try in 1 2 3; do
    if git -C "$dir" push -f "$repo" "$refspec"; then
      return 0
    fi
    if [ "$try" -lt 3 ]; then
      echo "::warning::$label push attempt $try/3 failed — retrying in ${delay}s"
      sleep "$delay"; delay=$(( delay * 2 ))
    fi
  done
  return 1
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
