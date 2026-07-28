#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/push-section-shard.sh — Build + force-push ONE locale's shard for
# ONE oversized job-board section (ticino, svizzera, zurigo, …).
#
# Generic successor to the Ticino-only push-ticino-shard.sh. The Ticino job
# section was the single largest subtree in the build (~4.2 GB / ~222k pages
# in IT alone — the cross-canton bridge mirrors essentially every active CH
# job under the legacy TI section, and runs independently in every locale, so
# en/de/fr each carried a comparably large Ticino mirror), which is why it was
# the first section carved into its own per-locale Pages repo. When the site
# grew past the 10 GB actions/deploy-pages cap a second time (svizzera/zurigo
# this time — see docs/TICINO-SHARD-RUNBOOK.md), the same mechanism was
# generalized instead of hand-copying the script per section (this repo's
# anti-duplication rule) — section → URL slug now comes from the single
# source of truth scripts/lib/section-shard-slugs.json (shared with
# strip-section-subtree.sh, deploy.yml, and post-deploy-validate-dist.yml).
#
# Sibling of scripts/lib/push-locale-shard.sh (keep the two in lockstep). Each
# (section, locale) subtree gets its OWN shard repo, frontaliere-<section>-<loc>,
# served from origin-<section>-<loc>.frontaliereticino.ch behind the
# locale-router Worker. A single combined repo per section would exceed the
# 10 GB Pages cap itself — this keeps the IT apex AND every en/de/fr locale
# shard under the cap.
#
# GitHub owner defaults to valerielinc-ops; scripts/lib/section-shard-owners.json
# can override per-section (used when a section's Pages https_certificate got
# permanently stuck on the default owner and was moved to a fallback account).
#
# Runs per build-locale matrix leg × section (one (section, locale) pair per
# invocation, its own repo → no concurrent-push race, exactly like
# push-locale-shard.sh). Stages the section's subtree for this locale, runs
# the CDN offload on the STAGED copy (so the SPA fetches /data + /assets from
# the CDN, like the apex/locale shards — the shard hosts only HTML), then
# incrementally force-pushes it.
#
# Usage:
#   push-section-shard.sh <section> <locale> <dist_dir>
#     <section>   any key present in scripts/lib/section-shard-slugs.json
#                 (currently: ticino, svizzera, zurigo)
#     <locale>    ∈ {it, en, de, fr}
#     <dist_dir>  build output dir (e.g. "dist")
#
# Required env (per-section-per-locale — GitHub rejects the same deploy key on
# >1 repo, so each frontaliere-<section>-<loc> has its OWN key, exactly like
# the locale shards):
#   SHARD_<SECTION>_<LOCALE>_DEPLOY_KEY  — e.g. SHARD_TICINO_IT_DEPLOY_KEY. The
#                              write deploy key for frontaliere-<section>-<loc>.
#                              Read via indirect expansion. Missing → skip (exit 0).
# Optional env:
#   RUNNER_TEMP / SHARD_HISTORY_CAP / GITHUB_SHA / GITHUB_RUN_ID — as the locale shard.
#
# On success writes $RUNNER_TEMP/shard-ok-<section>-<locale> (consumed by the
# strip step) and exits 0. SKIP (no key / subtree absent) exits 0 without the
# marker. Real failure exits non-zero (the caller is continue-on-error).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

section="${1:-}"
loc="${2:-}"
dist_dir="${3:-}"
if [ -z "$section" ] || [ -z "$loc" ] || [ -z "$dist_dir" ]; then
  echo "Usage: push-section-shard.sh <section> <locale> <dist_dir>" >&2
  exit 1
fi

repo_root="$(pwd)"  # captured before any cd — used to locate the offload script + slugs json
slugs_json="$repo_root/scripts/lib/section-shard-slugs.json"
# shard_read_counter / shard_orphan_init / shard_push_with_retry /
# shard_orphan_flatten_and_push — shared with push-locale-shard.sh and
# compact-article-shard-history.sh (issue #4881, AGENTS.md #6).
source "$(dirname "${BASH_SOURCE[0]}")/shard-git-helpers.sh"

# Canonical section path per locale, from the shared single source of truth.
# Keep in lockstep with SECTION_ROUTES in infra/cloudflare-worker/locale-router.js
# (the Worker cannot import this JSON — it must stay a self-contained paste-able
# script per its own header comment — so it mirrors these same literal values).
slug="$(jq -r --arg s "$section" --arg l "$loc" '.[$s][$l] // empty' "$slugs_json" 2>/dev/null)"
if [ -z "$slug" ]; then
  echo "::error::unsupported section '$section' / locale '$loc' (no entry in $slugs_json)" >&2
  exit 1
fi
case "$loc" in
  it) sub="$slug" ;;  # cathedral-allow: canonical legacy section path (bash, cannot import resolveCantonSection)
  en|de|fr) sub="$loc/$slug" ;;
  *) echo "::error::unsupported locale '$loc' (expected it|de|en|fr)" >&2; exit 1 ;;
esac

SECTION_UPPER="$(echo "$section" | tr a-z A-Z)"
ORIGIN_HOST="origin-$section-$loc.frontaliereticino.ch"
owners_json="$repo_root/scripts/lib/section-shard-owners.json"
SHARD_OWNER="$(jq -r --arg s "$section" '.[$s] // "valerielinc-ops"' "$owners_json" 2>/dev/null || echo valerielinc-ops)"
if [ -z "$SHARD_OWNER" ] || [ "$SHARD_OWNER" = "null" ]; then SHARD_OWNER="valerielinc-ops"; fi
SHARD_REPO="git@github.com:$SHARD_OWNER/frontaliere-$section-$loc.git"
CDN_BASE_FIXED="https://cdn.frontaliereticino.ch"

if [ -z "${RUNNER_TEMP:-}" ]; then
  RUNNER_TEMP="$(mktemp -d)"
  echo "ℹ️ RUNNER_TEMP unset — using temp dir $RUNNER_TEMP"
fi

push_section_shard() {
  local key_var key_val stage stage_src keyfile src_n prev_n rc
  LOC_UPPER="$(echo "$loc" | tr a-z A-Z)"
  # Per-section-per-locale deploy key via indirect expansion (mirrors push-locale-shard.sh).
  key_var="SHARD_${SECTION_UPPER}_${LOC_UPPER}_DEPLOY_KEY"
  key_val="${!key_var:-}"
  if [ -z "$key_val" ]; then
    echo "no $key_var secret — skipping $loc $section shard push (split disabled)"; return 0
  fi
  if [ ! -d "$dist_dir/$sub" ]; then
    echo "$dist_dir/$sub absent — skipping $loc $section shard push"; return 0
  fi

  # ── Stage subtree + offload (CDN refs) on the STAGED copy ────────────────
  # Hardlink the RAW subtree into <stage_src>/<sub> (offload needs it under a
  # dir literally named "dist"), then run the canonical offload with a FIXED
  # CDN_BASE. Offloading a separate copy (not the in-dist one) means it is
  # offloaded EXACTLY ONCE — no double window.__CDN_DATA_BASE__ injection even
  # though this leg's own offload also runs over the real dist.
  stage_src="$RUNNER_TEMP/${section}-src-$loc"
  rm -rf "$stage_src"; mkdir -p "$stage_src/dist/$(dirname "$sub")"
  cp -al "$dist_dir/$sub" "$stage_src/dist/$sub" 2>/dev/null || cp -r "$dist_dir/$sub" "$stage_src/dist/$sub"
  if [ "$loc" = "it" ] && [ -f "$dist_dir/404.html" ]; then
    cp "$dist_dir/404.html" "$stage_src/dist/404.html"
  fi
  ( cd "$stage_src" && CDN_BASE="$CDN_BASE_FIXED" node "$repo_root/scripts/offload-generated-images-cdn.mjs" ) \
    || echo "::warning::offload on $loc $section subtree returned non-zero (offload is fail-safe/exit-0; continuing)"

  src_n="$(find "$stage_src/dist/$sub" -type f | wc -l)"

  stage="$RUNNER_TEMP/shard-$section-$loc"
  keyfile="$RUNNER_TEMP/shard_${section}_${loc}_key"
  printf '%s\n' "$key_val" > "$keyfile" && chmod 600 "$keyfile"
  export GIT_SSH_COMMAND="ssh -i $keyfile -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

  # Guarded build+push in ONE `set -e` subshell (see push-locale-shard.sh for
  # the full rationale: standalone subshell + captured $?; incremental
  # blobless clone with a delta push and an orphan force-push fail-safe;
  # history cap to bound .git growth).
  (
    set -e
    rm -rf "$stage"; mkdir -p "$stage"
    SHARD_HISTORY_CAP="${SHARD_HISTORY_CAP:-50}"
    incremental=0
    dcount=0
    prev_n=0
    if git clone -q --depth 1 --filter=blob:none --no-checkout \
         "$SHARD_REPO" "$stage" 2>/dev/null \
       && [ -d "$stage/.git" ]; then
      # git-plumbing reads (git show HEAD:<path>), NOT working-tree file
      # checks — --no-checkout NEVER materializes a working-tree file, so a
      # `[ -f "$stage/.shard-deploys" ]` check here was always false (see
      # scripts/lib/shard-git-helpers.sh header for the full incident).
      dcount="$(shard_read_counter "$stage" .shard-deploys)"
      prev_n="$(shard_read_counter "$stage" .shard-filecount)"
      if [ "$dcount" -ge "$SHARD_HISTORY_CAP" ]; then
        echo "$section-$loc shard: history cap $SHARD_HISTORY_CAP reached (dcount=$dcount) — flattening with orphan force-push"
        rm -rf "$stage"; mkdir -p "$stage"
        shard_orphan_init "$stage"
        dcount=0
      else
        find "$stage" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} + 2>/dev/null || true
        incremental=1
      fi
    else
      echo "$section-$loc shard: no prior clone (first push / transient) — full orphan push"
      shard_orphan_init "$stage"
    fi

    : > "$stage/.nojekyll"
    printf '%s' "$ORIGIN_HOST" > "$stage/CNAME"
    if [ -f "$stage_src/dist/404.html" ]; then cp "$stage_src/dist/404.html" "$stage/404.html"; fi
    printf '<!doctype html><meta charset=utf-8><title>frontaliereticino.ch %s-%s shard</title>' "$section" "$loc" > "$stage/index.html"
    # Copy the offloaded subtree at its canonical path (hardlink when same-fs).
    mkdir -p "$stage/$(dirname "$sub")"
    cp -al "$stage_src/dist/$sub" "$stage/$sub" 2>/dev/null || cp -r "$stage_src/dist/$sub" "$stage/$sub"

    n="$(find "$stage/$sub" -type f | wc -l)"
    test -s "$stage/$sub/index.html"
    [ "$n" -ge "$src_n" ]
    # Shrink guard (defect A, issue #4881): refuse a push whose tree lost
    # more than SHARD_SHRINK_GUARD_PCT% of its previous file count — the
    # data-loss hazard this guards against is a future change that stops
    # emitting this section into dist/ while the section still exists on its
    # shard: this early-return ("$dist_dir/$sub absent") would otherwise let
    # a caller reach here with a near-empty tree and force-push it, wiping
    # the shard. Threshold is configurable (default 50, unchanged from the
    # previous hardcoded behaviour); SHARD_SHRINK_GUARD_OVERRIDE_<SECTION>_
    # <LOCALE>=true allows a verified INTENTIONAL shrink to proceed — still
    # logged loudly (never silent), per AGENTS.md Non-Negotiable #2 (never
    # downgrade a real regression to a silent pass).
    SHARD_SHRINK_GUARD_PCT="${SHARD_SHRINK_GUARD_PCT:-50}"
    shrink_override_var="SHARD_SHRINK_GUARD_OVERRIDE_${SECTION_UPPER}_${LOC_UPPER}"
    if [ "$prev_n" -gt 0 ] && [ "$(( n * 100 ))" -lt "$(( prev_n * (100 - SHARD_SHRINK_GUARD_PCT) ))" ]; then
      if [ "${!shrink_override_var:-}" = "true" ]; then
        echo "::warning::$section-$loc shard would shrink $prev_n -> $n files (>${SHARD_SHRINK_GUARD_PCT}%) — $shrink_override_var=true set, proceeding with an INTENTIONAL shrink push (verify this was expected)"
      else
        echo "::error::$section-$loc shard would shrink $prev_n -> $n files (>${SHARD_SHRINK_GUARD_PCT}%) — refusing push (suspected build regression). If this shrink is verified intentional, set $shrink_override_var=true"
        exit 1
      fi
    fi
    printf '%s' "$n" > "$stage/.shard-filecount"
    printf '%s' "$((dcount + 1))" > "$stage/.shard-deploys"
    echo "$section-$loc shard: $(du -sh "$stage" 2>/dev/null | cut -f1), $n files (src $src_n, prev $prev_n, incremental=$incremental, deploys-since-flatten=$((dcount + 1)))"

    cd "$stage"
    git config user.email "valerielinc@gmail.com"
    git config user.name "Valerie Linc"
    git add -A
    if [ "$incremental" = 1 ] \
       && git diff --cached --quiet -- . ':!.shard-deploys' ':!.shard-filecount'; then
      echo "$section-$loc shard: no content changes vs remote — skipping push (already current)"
    else
      _sha="${GITHUB_SHA:-local}"; _sha="${_sha:0:8}"
      git commit -qm "$section-$loc shard ${_sha} (run ${GITHUB_RUN_ID:-local})"
      _push_ok=0
      if shard_push_with_retry "$stage" "$SHARD_REPO" "main" "$section-$loc shard"; then
        _push_ok=1
      fi
      # Self-heal: 3 retries on the SAME incremental base never recover from a
      # corrupted/diverged remote-tracking clone (the "not our ref" / "bad tree
      # object" / "early EOF" failure mode — incident 2026-07-24, run
      # 30057726623: svizzera-it push failed 3x against a broken shallow clone,
      # leaving the whole section stuck in the apex until the NEXT deploy
      # happened to retry from a fresh clone). If this push built on a cloned
      # base (incremental=1, not already a fresh orphan), drop the corrupted
      # local history and retry as a brand-new orphan commit — a full pack that
      # doesn't negotiate against the broken remote graph — before giving up.
      if [ "$_push_ok" != 1 ] && [ "$incremental" = 1 ]; then
        echo "::warning::$section-$loc shard: 3 incremental push attempts failed — flattening to a fresh orphan commit and retrying"
        if shard_orphan_flatten_and_push "$stage" "$SHARD_REPO" "$section-$loc shard ${_sha} (run ${GITHUB_RUN_ID:-local}) [self-heal flatten]" "$section-$loc shard flatten"; then
          _push_ok=1
        fi
      fi
      [ "$_push_ok" = 1 ] || { echo "::error::$section-$loc shard push failed after 3 attempts (+ flatten self-heal retry)"; exit 1; }
    fi
  )
  rc=$?
  rm -f "$keyfile"
  # NOTE: stage_src is intentionally NOT removed here. It holds the already
  # CDN-offloaded copy of this (section, locale) subtree — byte-identical to
  # what was just force-pushed to the shard repo. The caller (deploy.yml,
  # "Pack section shard dist" step) packs it into a same-run tar artifact for
  # post-deploy-validate-dist's rehydrate fast path (mirrors the locale-shard
  # tar artifact), then removes it. Runners are ephemeral — leaving it behind
  # when the caller doesn't consume it is a no-op cleanup-wise.
  #
  # $stage (the git-clone-based push staging dir, up to ~5-6 GB for ticino)
  # is DIFFERENT from stage_src: nothing downstream ever reads it again, so
  # unlike stage_src it is pure leaked disk. Three sections × up to ~8 GB
  # combined accumulating unfreed within the SAME job — on top of stage_src
  # and the IT-only OG-image generation — exhausted runner disk on the IT
  # leg and crashed the job with "No space left on device" before it could
  # push its CDN build id, which is what made the downstream de/en/fr
  # locales' cross-shard ordering wait (#2569) time out (issue #4734).
  rm -rf "$stage"
  if [ "$rc" -eq 0 ]; then
    touch "$RUNNER_TEMP/shard-ok-$section-$loc"   # consumed by the strip step
    echo "✅ pushed $section-$loc shard"
  else
    echo "::warning::$section-$loc shard build/push failed (rc=$rc) — $loc $section will NOT be stripped this run"
  fi
  return "$rc"
}

push_section_shard
