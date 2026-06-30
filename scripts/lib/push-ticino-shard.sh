#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/push-ticino-shard.sh — Build + force-push the Ticino-section shard
#
# Sibling of scripts/lib/push-locale-shard.sh (keep the two in lockstep). The
# Ticino job section is the single largest subtree in the build (~4.2 GB / ~222k
# pages in IT alone, because the cross-canton bridge mirrors essentially every
# active CH job under the legacy TI section). Carving it out to its OWN GitHub
# Pages repo (frontaliere-ticino, served from origin-ticino.frontaliereticino.ch
# behind the locale-router Worker) keeps the IT apex AND every en/de/fr locale
# shard under the 10 GB Pages deploy cap — the actions/deploy-pages hard limit
# ("total size is less than 10GB") that failed the 2026-06-30 IT deploy.
#
# Unlike the per-locale shards (one subtree, one repo, one runner), the Ticino
# shard aggregates all FOUR locales' Ticino subtrees into one repo:
#   <dist_dir>/cerca-lavoro-ticino/       (IT)
#   <dist_dir>/en/find-jobs-ticino/       (EN)
#   <dist_dir>/de/jobs-im-tessin/         (DE)
#   <dist_dir>/fr/trouver-emploi-tessin/  (FR)
# The deploy.yml post-matrix `push-ticino-shard` job assembles <dist_dir> from
# the four per-leg `ticino-shard-<loc>` artifacts (a single serialized writer →
# no concurrent-push race, which the per-leg model avoids by using one repo per
# locale). This script then force-pushes that assembled tree.
#
# Usage:
#   push-ticino-shard.sh <dist_dir>
#     <dist_dir>  staging dir holding the four Ticino subtrees at their canonical
#                 public paths (above), plus optionally a 404.html at its root.
#
# Required env:
#   SHARD_TICINO_DEPLOY_KEY  — SSH deploy key (write) for frontaliere-ticino.
#                              Missing → skip (exit 0), never an error. This is
#                              the master gate: until the owner provisions the
#                              repo + secret, the whole Ticino split is a no-op
#                              and the build behaves exactly as before.
# Optional env:
#   RUNNER_TEMP        — scratch dir + success-marker location (GH Actions sets it).
#   SHARD_HISTORY_CAP  — deploys between forced history flattens (default 50).
#   GITHUB_SHA / GITHUB_RUN_ID — embedded in the commit message (best-effort).
#
# On success writes the marker $RUNNER_TEMP/shard-ok-ticino and exits 0. On a
# SKIP (no deploy key, or no Ticino subtree present) exits 0 WITHOUT the marker.
# On a real push failure exits non-zero (the caller is continue-on-error, mirroring
# the locale shard step).
#
# Exit codes:
#   0  — pushed (marker written), or legitimately skipped (no marker)
#   1  — bad usage / real build or push failure
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

dist_dir="${1:-}"

if [ -z "$dist_dir" ]; then
  echo "Usage: push-ticino-shard.sh <dist_dir>" >&2
  exit 1
fi

# The four Ticino subtree paths (canonical public paths) this shard serves. Keep
# in lockstep with TICINO_ROUTES in infra/cloudflare-worker/locale-router.js.
TICINO_PATHS=(
  "cerca-lavoro-ticino"
  "en/find-jobs-ticino"
  "de/jobs-im-tessin"
  "fr/trouver-emploi-tessin"
)

ORIGIN_HOST="origin-ticino.frontaliereticino.ch"
SHARD_REPO="git@github.com:valerielinc-ops/frontaliere-ticino.git"

if [ -z "${RUNNER_TEMP:-}" ]; then
  RUNNER_TEMP="$(mktemp -d)"
  echo "ℹ️ RUNNER_TEMP unset — using temp dir $RUNNER_TEMP"
fi

push_ticino_shard() {
  local key_val stage keyfile src_n prev_n rc present
  key_val="${SHARD_TICINO_DEPLOY_KEY:-}"
  if [ -z "$key_val" ]; then
    echo "no SHARD_TICINO_DEPLOY_KEY secret — skipping Ticino shard push (split disabled)"; return 0
  fi

  # At least one Ticino subtree must be present and non-empty, else there is
  # nothing to publish (skip, no marker → strip steps leave Ticino in place).
  present=0
  for p in "${TICINO_PATHS[@]}"; do
    [ -d "$dist_dir/$p" ] && present=1
  done
  if [ "$present" -eq 0 ]; then
    echo "no Ticino subtree under $dist_dir — skipping Ticino shard push"; return 0
  fi

  stage="$RUNNER_TEMP/shard-ticino"
  keyfile="$RUNNER_TEMP/shard_ticino_key"
  printf '%s\n' "$key_val" > "$keyfile" && chmod 600 "$keyfile"
  export GIT_SSH_COMMAND="ssh -i $keyfile -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

  # Source-of-truth file count (sum across the present subtrees) + the shard's
  # last-published count from the tiny .shard-filecount marker (cheap raw fetch,
  # no multi-GB clone) — drives the same partial-copy / regression gate as the
  # locale shards.
  src_n=0
  for p in "${TICINO_PATHS[@]}"; do
    [ -d "$dist_dir/$p" ] && src_n=$(( src_n + $(find "$dist_dir/$p" -type f | wc -l) ))
  done
  prev_n="$(curl -fsS "https://raw.githubusercontent.com/valerielinc-ops/frontaliere-ticino/main/.shard-filecount" 2>/dev/null || echo 0)"
  [[ "$prev_n" =~ ^[0-9]+$ ]] || prev_n=0

  # Guarded build+push in ONE `set -e` subshell (see push-locale-shard.sh for the
  # full rationale: standalone subshell + captured $? so an inner `set -e` is not
  # neutered by a condition context; incremental blobless clone delta push with an
  # orphan force-push fail-safe; history cap to bound .git growth).
  (
    set -e
    rm -rf "$stage"; mkdir -p "$stage"
    SHARD_HISTORY_CAP="${SHARD_HISTORY_CAP:-50}"
    incremental=0
    dcount=0
    if git clone -q --depth 1 --filter=blob:none --no-checkout \
         "$SHARD_REPO" "$stage" 2>/dev/null \
       && [ -d "$stage/.git" ]; then
      [ -f "$stage/.shard-deploys" ] && dcount="$(cat "$stage/.shard-deploys" 2>/dev/null || echo 0)"
      [[ "$dcount" =~ ^[0-9]+$ ]] || dcount=0
      if [ "$dcount" -ge "$SHARD_HISTORY_CAP" ]; then
        echo "ticino shard: history cap $SHARD_HISTORY_CAP reached (dcount=$dcount) — flattening with orphan force-push"
        rm -rf "$stage"; mkdir -p "$stage"
        git -C "$stage" init -q
        git -C "$stage" checkout -q -b main
        dcount=0
      else
        find "$stage" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} + 2>/dev/null || true
        incremental=1
      fi
    else
      echo "ticino shard: no prior clone (first push / transient) — full orphan push"
      git -C "$stage" init -q
      git -C "$stage" checkout -q -b main
    fi

    : > "$stage/.nojekyll"                       # serve every path verbatim
    printf '%s' "$ORIGIN_HOST" > "$stage/CNAME"  # gray-cloud custom domain (Worker-only origin)
    # SPA fallback so a Worker-recovery miss still soft-recovers client-side,
    # exactly like the apex (deploy-it-pages-prep.sh copies index.html→404.html).
    if [ -f "$dist_dir/404.html" ]; then cp "$dist_dir/404.html" "$stage/404.html"; fi
    # Minimal root index so the bare origin host is never a blank 404 (the public
    # apex never routes "/" here — only the Ticino prefixes — so this is cosmetic).
    printf '<!doctype html><meta charset=utf-8><title>frontaliereticino.ch ticino shard</title>' > "$stage/index.html"

    # Copy each present Ticino subtree at its canonical path (hardlink when
    # same-filesystem to avoid duplicating GBs on a tight runner disk).
    for p in "${TICINO_PATHS[@]}"; do
      if [ -d "$dist_dir/$p" ]; then
        mkdir -p "$stage/$(dirname "$p")"
        cp -al "$dist_dir/$p" "$stage/$p" 2>/dev/null || cp -r "$dist_dir/$p" "$stage/$p"
      fi
    done

    n="$(find "$stage" -type f ! -path '*/.git/*' | wc -l)"
    # (a) copy integrity: at least as many files as the source subtrees.
    [ "$n" -ge "$src_n" ]
    # (b) regression guard: refuse a >50% shrink vs the last-published count.
    if [ "$prev_n" -gt 0 ] && [ "$((n * 2))" -lt "$prev_n" ]; then
      echo "::error::ticino shard would shrink $prev_n -> $n files (>50%) — refusing push (suspected build regression)"
      exit 1
    fi
    printf '%s' "$n" > "$stage/.shard-filecount"
    printf '%s' "$((dcount + 1))" > "$stage/.shard-deploys"
    echo "ticino shard: $(du -sh "$stage" 2>/dev/null | cut -f1), $n files (src $src_n, prev $prev_n, incremental=$incremental, deploys-since-flatten=$((dcount + 1)))"

    cd "$stage"
    git config user.email "valerielinc@gmail.com"
    git config user.name "Valerie Linc"
    git add -A
    if [ "$incremental" = 1 ] \
       && git diff --cached --quiet -- . ':!.shard-deploys' ':!.shard-filecount'; then
      echo "ticino shard: no content changes vs remote — skipping push (already current)"
    else
      _sha="${GITHUB_SHA:-local}"; _sha="${_sha:0:8}"
      git commit -qm "ticino shard ${_sha} (run ${GITHUB_RUN_ID:-local})"
      git push -f "$SHARD_REPO" main
    fi
  )
  rc=$?
  rm -f "$keyfile"
  if [ "$rc" -eq 0 ]; then
    touch "$RUNNER_TEMP/shard-ok-ticino"   # consumed by the strip steps
    echo "✅ pushed ticino shard"
  else
    echo "::warning::ticino shard build/push failed (rc=$rc) — Ticino will NOT be stripped from the apex/locale shards this run"
  fi
  return "$rc"
}

push_ticino_shard
