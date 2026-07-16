#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/push-ticino-shard.sh — Build + force-push ONE locale's Ticino shard
#
# Sibling of scripts/lib/push-locale-shard.sh (keep the two in lockstep). The
# Ticino job section is the single largest subtree in the build (~4.2 GB / ~222k
# pages in IT alone — the cross-canton bridge mirrors essentially every active CH
# job under the legacy TI section, and runs independently in every locale, so
# en/de/fr each carry a comparably large Ticino mirror). A SINGLE combined repo
# would be ~16 GB — over the 10 GB Pages cap itself — so each locale's Ticino
# subtree gets its OWN ~4 GB shard repo, frontaliere-ticino-<locale>, served from
# origin-ticino-<locale>.frontaliereticino.ch behind the locale-router Worker.
# This keeps the IT apex AND every en/de/fr locale shard under the 10 GB
# actions/deploy-pages cap that failed the 2026-06-30 IT deploy.
#
# Runs per build-locale matrix leg (one locale per invocation, its own repo → no
# concurrent-push race, exactly like push-locale-shard.sh). Stages the locale's
# Ticino subtree, runs the CDN offload on the STAGED copy (so the SPA fetches
# /data + /assets from the CDN, like the apex/locale shards — the shard hosts only
# HTML), then incrementally force-pushes it.
#
# Usage:
#   push-ticino-shard.sh <locale> <dist_dir>
#     <locale>    ∈ {it, en, de, fr}
#     <dist_dir>  build output dir (e.g. "dist")
#
# Required env (per-locale — GitHub rejects the same deploy key on >1 repo, so
# each frontaliere-ticino-<loc> has its OWN key, exactly like the locale shards):
#   SHARD_TICINO_<LOCALE>_DEPLOY_KEY  — e.g. SHARD_TICINO_IT_DEPLOY_KEY. The write
#                              deploy key for frontaliere-ticino-<loc>. Read via
#                              indirect expansion. Missing → skip (exit 0).
# Optional env:
#   RUNNER_TEMP / SHARD_HISTORY_CAP / GITHUB_SHA / GITHUB_RUN_ID — as the locale shard.
#
# On success writes $RUNNER_TEMP/shard-ok-ticino-<locale> (consumed by the strip
# step) and exits 0. SKIP (no key / subtree absent) exits 0 without the marker.
# Real failure exits non-zero (the caller is continue-on-error).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

loc="${1:-}"
dist_dir="${2:-}"
if [ -z "$loc" ] || [ -z "$dist_dir" ]; then
  echo "Usage: push-ticino-shard.sh <locale> <dist_dir>" >&2
  exit 1
fi

# Canonical Ticino path per locale. Keep in lockstep with TICINO_ROUTES in
# infra/cloudflare-worker/locale-router.js and carve-ticino-subtree.sh.
case "$loc" in
  it) sub="cerca-lavoro-ticino" ;;  # cathedral-allow: canonical TI legacy section path (bash, cannot import resolveCantonSection)
  en) sub="en/find-jobs-ticino" ;;
  de) sub="de/jobs-im-tessin" ;;
  fr) sub="fr/trouver-emploi-tessin" ;;
  *) echo "::error::unsupported locale '$loc' (expected it|de|en|fr)" >&2; exit 1 ;;
esac

ORIGIN_HOST="origin-ticino-$loc.frontaliereticino.ch"
SHARD_REPO="git@github.com:valerielinc-ops/frontaliere-ticino-$loc.git"
CDN_BASE_FIXED="https://cdn.frontaliereticino.ch"

repo_root="$(pwd)"  # captured before any cd — used to locate the offload script

if [ -z "${RUNNER_TEMP:-}" ]; then
  RUNNER_TEMP="$(mktemp -d)"
  echo "ℹ️ RUNNER_TEMP unset — using temp dir $RUNNER_TEMP"
fi

push_ticino_shard() {
  local key_var key_val stage stage_src keyfile src_n prev_n rc
  # Per-locale deploy key via indirect expansion (mirrors push-locale-shard.sh).
  key_var="SHARD_TICINO_$(echo "$loc" | tr a-z A-Z)_DEPLOY_KEY"
  key_val="${!key_var:-}"
  if [ -z "$key_val" ]; then
    echo "no $key_var secret — skipping $loc Ticino shard push (split disabled)"; return 0
  fi
  if [ ! -d "$dist_dir/$sub" ]; then
    echo "$dist_dir/$sub absent — skipping $loc Ticino shard push"; return 0
  fi

  # ── Stage the subtree + offload (CDN refs) on the STAGED copy ──────────────
  # Hardlink the RAW subtree into <stage_src>/<sub> (offload needs it under a dir
  # literally named "dist"), then run the canonical offload there with a fixed
  # CDN_BASE. Offloading a separate copy (not the in-dist one) means it is
  # offloaded EXACTLY ONCE — no double window.__CDN_DATA_BASE__ injection even
  # though the leg's own offload also runs over the real dist.
  stage_src="$RUNNER_TEMP/ticino-src-$loc"
  rm -rf "$stage_src"; mkdir -p "$stage_src/dist/$(dirname "$sub")"
  cp -al "$dist_dir/$sub" "$stage_src/dist/$sub" 2>/dev/null || cp -r "$dist_dir/$sub" "$stage_src/dist/$sub"
  if [ "$loc" = "it" ] && [ -f "$dist_dir/404.html" ]; then
    cp "$dist_dir/404.html" "$stage_src/dist/404.html"
  fi
  ( cd "$stage_src" && CDN_BASE="$CDN_BASE_FIXED" node "$repo_root/scripts/offload-generated-images-cdn.mjs" ) \
    || echo "::warning::offload on $loc Ticino subtree returned non-zero (offload is fail-safe/exit-0; continuing)"

  src_n="$(find "$stage_src/dist/$sub" -type f | wc -l)"
  prev_n="$(curl -fsS "https://raw.githubusercontent.com/valerielinc-ops/frontaliere-ticino-$loc/main/.shard-filecount" 2>/dev/null || echo 0)"
  [[ "$prev_n" =~ ^[0-9]+$ ]] || prev_n=0

  stage="$RUNNER_TEMP/shard-ticino-$loc"
  keyfile="$RUNNER_TEMP/shard_ticino_${loc}_key"
  printf '%s\n' "$key_val" > "$keyfile" && chmod 600 "$keyfile"
  export GIT_SSH_COMMAND="ssh -i $keyfile -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

  # Guarded build+push in ONE `set -e` subshell (see push-locale-shard.sh for the
  # full rationale: standalone subshell + captured $?; incremental blobless clone
  # delta push with an orphan force-push fail-safe; history cap to bound .git).
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
        echo "ticino-$loc shard: history cap $SHARD_HISTORY_CAP reached (dcount=$dcount) — flattening with orphan force-push"
        rm -rf "$stage"; mkdir -p "$stage"
        git -C "$stage" init -q
        git -C "$stage" checkout -q -b main
        dcount=0
      else
        find "$stage" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} + 2>/dev/null || true
        incremental=1
      fi
    else
      echo "ticino-$loc shard: no prior clone (first push / transient) — full orphan push"
      git -C "$stage" init -q
      git -C "$stage" checkout -q -b main
    fi

    : > "$stage/.nojekyll"
    printf '%s' "$ORIGIN_HOST" > "$stage/CNAME"
    if [ -f "$stage_src/dist/404.html" ]; then cp "$stage_src/dist/404.html" "$stage/404.html"; fi
    printf '<!doctype html><meta charset=utf-8><title>frontaliereticino.ch ticino-%s shard</title>' "$loc" > "$stage/index.html"
    # Copy the offloaded subtree at its canonical path (hardlink when same-fs).
    mkdir -p "$stage/$(dirname "$sub")"
    cp -al "$stage_src/dist/$sub" "$stage/$sub" 2>/dev/null || cp -r "$stage_src/dist/$sub" "$stage/$sub"

    n="$(find "$stage/$sub" -type f | wc -l)"
    test -s "$stage/$sub/index.html"
    [ "$n" -ge "$src_n" ]
    if [ "$prev_n" -gt 0 ] && [ "$((n * 2))" -lt "$prev_n" ]; then
      echo "::error::ticino-$loc shard would shrink $prev_n -> $n files (>50%) — refusing push (suspected build regression)"
      exit 1
    fi
    printf '%s' "$n" > "$stage/.shard-filecount"
    printf '%s' "$((dcount + 1))" > "$stage/.shard-deploys"
    echo "ticino-$loc shard: $(du -sh "$stage" 2>/dev/null | cut -f1), $n files (src $src_n, prev $prev_n, incremental=$incremental, deploys-since-flatten=$((dcount + 1)))"

    cd "$stage"
    git config user.email "valerielinc@gmail.com"
    git config user.name "Valerie Linc"
    git add -A
    if [ "$incremental" = 1 ] \
       && git diff --cached --quiet -- . ':!.shard-deploys' ':!.shard-filecount'; then
      echo "ticino-$loc shard: no content changes vs remote — skipping push (already current)"
    else
      _sha="${GITHUB_SHA:-local}"; _sha="${_sha:0:8}"
      git commit -qm "ticino-$loc shard ${_sha} (run ${GITHUB_RUN_ID:-local})"
      _push_delay=5; _push_ok=0
      for _try in 1 2 3; do
        if git push -f "$SHARD_REPO" main; then
          _push_ok=1; break
        fi
        if [ "$_try" -lt 3 ]; then
          echo "::warning::push attempt $_try/3 failed — retrying in ${_push_delay}s"
          sleep "$_push_delay"; _push_delay=$(( _push_delay * 2 ))
        fi
      done
      [ "$_push_ok" = 1 ] || { echo "::error::ticino-$loc shard push failed after 3 attempts"; exit 1; }
    fi
  )
  rc=$?
  rm -f "$keyfile"
  # NOTE: stage_src is intentionally NOT removed here. It holds the already
  # CDN-offloaded copy of this locale's Ticino subtree — byte-identical to
  # what was just force-pushed to the shard repo. The caller (deploy.yml,
  # "Pack Ticino shard dist" step) packs it into a same-run tar artifact for
  # post-deploy-validate-dist's rehydrate fast path (mirrors the locale-shard
  # tar artifact), then removes it. Runners are ephemeral — leaving it behind
  # when the caller doesn't consume it is a no-op cleanup-wise.
  if [ "$rc" -eq 0 ]; then
    touch "$RUNNER_TEMP/shard-ok-ticino-$loc"   # consumed by the strip step
    echo "✅ pushed ticino-$loc shard"
  else
    echo "::warning::ticino-$loc shard build/push failed (rc=$rc) — $loc Ticino will NOT be stripped this run"
  fi
  return "$rc"
}

push_ticino_shard
