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
#   SHARD_PUSH_MODE — `full` (default, current byte-identical path) or `delta`.
#   SHARD_PUSH_VERIFY — `1` enables an advisory full-vs-delta tree comparison.
#   SHARD_INCREMENTAL_MANIFEST_DIR — current build manifest directory; defaults
#                                   to .cache/incremental-manifest.
#   SHARD_DELTA_CDN_REWRITE — unset/`off` (default, byte-identical path) or
#                  `changed`: in delta mode, CDN-rewrite only the files the
#                  delta reads (changed + unmanifested overlay + 404.html);
#                  the unchanged ones come from the shard HEAD, already
#                  rewritten. A delta fallback to full rewrites everything
#                  first, as today. The staged copy the pack step tars is
#                  completed in background — see scripts/lib/shard-cdn-rewrite.sh.
#
# On success writes $RUNNER_TEMP/shard-ok-<section>-<locale> (consumed by the
# strip step) and exits 0. SKIP (no key / subtree absent) exits 0 without the
# marker. Real failure exits non-zero (the caller is continue-on-error).
#
# Also writes $RUNNER_TEMP/shard-srcn-<section>-<locale> right after staging,
# holding the staged subtree's file count at THIS moment (issue #6283): the
# caller's "Pack section shard dist" step (deploy.yml) reads it back as an
# independent baseline to detect the staged tree shrinking between this push
# and that later pack step — a shrink that would otherwise be invisible to
# the pack step's own packed_n-vs-recount check, since both of those derive
# from the SAME already-reduced directory.
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
SHARD_PUSH_MODE="${SHARD_PUSH_MODE:-full}"
case "$SHARD_PUSH_MODE" in
  full|delta) ;;
  *) echo "::error::unsupported SHARD_PUSH_MODE '$SHARD_PUSH_MODE' (expected full|delta)" >&2; exit 1 ;;
esac
manifest_dir="${SHARD_INCREMENTAL_MANIFEST_DIR:-$repo_root/.cache/incremental-manifest}"
manifest_tool="$repo_root/scripts/ci/shard-manifest-delta.mjs"
verify_tool="$repo_root/scripts/ci/shard-push-verify.mjs"
# shard_read_counter / shard_orphan_init / shard_push_with_retry /
# shard_orphan_flatten_and_push — shared with push-locale-shard.sh and
# compact-article-shard-history.sh (issue #4881, AGENTS.md #6).
source "$(dirname "${BASH_SOURCE[0]}")/shard-git-helpers.sh"
source "$(dirname "${BASH_SOURCE[0]}")/shard-cdn-rewrite.sh"
offload_script="$repo_root/scripts/offload-generated-images-cdn.mjs"

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
SHARD_REPO="${SHARD_REPO_OVERRIDE:-git@github.com:$SHARD_OWNER/frontaliere-$section-$loc.git}"
CDN_BASE_FIXED="https://cdn.frontaliereticino.ch"

if [ -z "${RUNNER_TEMP:-}" ]; then
  RUNNER_TEMP="$(mktemp -d)"
  echo "ℹ️ RUNNER_TEMP unset — using temp dir $RUNNER_TEMP"
fi

# The historical full, non-fatal CDN rewrite of the whole staged copy.
offload_full_stage() {
  ( cd "$stage_src" && CDN_BASE="$CDN_BASE_FIXED" node "$offload_script" ) \
    || echo "::warning::offload on $loc $section subtree returned non-zero (offload is fail-safe/exit-0; continuing)"
}

# offload_delta_stage <delta_output> — rewrite only the files the delta push
# reads from the staged copy: changed + unmanifested overlay (NUL lists,
# relative to $sub) plus the root 404.html. Returns non-zero when the list
# cannot be built or the strict partial pass fails; the caller then runs the
# full pass (idempotent, so no byte differs from the historical output).
offload_delta_stage() {
  local out="$1" list="$1/cdn-rewrite-files.txt"
  perl -e '
    use strict; use warnings;
    my ($prefix, $dest, @lists) = @ARGV;
    open my $o, ">:raw", $dest or die "open $dest: $!";
    local $/ = "\0";
    for my $f (@lists) {
      open my $i, "<:raw", $f or die "open $f: $!";
      while (defined(my $r = <$i>)) { $r =~ s{\0\z}{}; next if $r eq q{}; print {$o} "$prefix/$r\0"; }
      close $i;
    }
    close $o or die "close $dest: $!";
  ' "$sub" "$list" "$out/changed-files.txt" "$out/unmanifested-files.txt" || return 1
  if [ -f "$stage_src/dist/404.html" ]; then printf '404.html\0' >> "$list" || return 1; fi
  ( cd "$stage_src" && CDN_BASE="$CDN_BASE_FIXED" node "$offload_script" --files-from "$list" )
}

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
  # SHARD_DELTA_CDN_REWRITE=changed (delta mode only): defer the rewrite until
  # the delta plan says which staged files the push will actually read.
  rm -f "$RUNNER_TEMP/shard-cdn-partial-$section-$loc" "$RUNNER_TEMP/shard-cdn-done-$section-$loc"
  cdn_rewrite_deferred=0
  if shard_cdn_rewrite_enabled "$SHARD_PUSH_MODE"; then
    cdn_rewrite_deferred=1
    echo "$section-$loc shard: SHARD_DELTA_CDN_REWRITE=changed — CDN rewrite deferred to the delta plan"
  else
    offload_full_stage
  fi

  src_n="$(shard_count_files "$stage_src/dist/$sub")"
  printf '%s' "$src_n" > "$RUNNER_TEMP/shard-srcn-$section-$loc"

  stage="$RUNNER_TEMP/shard-$section-$loc"
  keyfile="$RUNNER_TEMP/shard_${section}_${loc}_key"
  printf '%s\n' "$key_val" > "$keyfile" && chmod 600 "$keyfile"
  # Keep long section pushes alive while GitHub is processing multi-GB packs;
  # the PAT fallback still handles a remote that closes the transport.
  export GIT_SSH_COMMAND="ssh -i $keyfile -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o TCPKeepAlive=yes"

  # Guarded build+push in ONE `set -e` subshell (see push-locale-shard.sh for
  # the full rationale: standalone subshell + captured $?; explicit full/delta
  # modes with an orphan force-push fail-safe; history cap to bound .git
  # growth).
  (
    set -e
    rm -rf "$stage"; mkdir -p "$stage"
    SHARD_HISTORY_CAP="${SHARD_HISTORY_CAP:-50}"
    incremental=0
    dcount=0
    prev_n=0
    delta_applied=0
    delta_snapshot=''
    delta_fallback_reason=''
    delta_output="$RUNNER_TEMP/shard-delta-$section-$loc"
    verify_ready=0
    verify_snapshot=''
    verify_base_tree=''
    verify_plan_tree=''
    verify_plan_seconds=0
    verify_stage="$RUNNER_TEMP/shard-push-verify-stage-$section-$loc"
    verify_output="$RUNNER_TEMP/shard-push-verify-plan-$section-$loc"
    cdn_rewrite_partial=0

    # Full mode keeps the historical push as the source of truth. When the
    # canary is enabled, build the delta index beside it without pushing; the
    # comparison runs only after the full commit has landed.
    if [ "$SHARD_PUSH_MODE" = full ] && [ "${SHARD_PUSH_VERIFY:-}" = 1 ]; then
      delta_sidecar="$(shard_delta_manifest_sidecar "$loc")"
      verify_started="$SECONDS"
      if shard_delta_verify_prepare \
          "$verify_stage" "$SHARD_REPO" "$manifest_dir/$loc.jsonl" "$delta_sidecar" \
          "$sub" "$stage_src/dist" "$manifest_tool" "$verify_output" \
          "$SHARD_HISTORY_CAP" "$section-$loc shard" \
        && verify_snapshot="$SHARD_VERIFY_SNAPSHOT" \
        && shard_delta_verify_add_service_tree \
            "$verify_stage" "$ORIGIN_HOST" \
            "<!doctype html><meta charset=utf-8><title>frontaliereticino.ch $section-$loc shard</title>" \
            '' '' "$([ "$loc" = it ] && printf '%s' "$stage_src/dist/404.html" || true)" \
            "$verify_snapshot" "$delta_sidecar" \
        && verify_n="$(shard_count_files "$stage_src/dist/$sub")" \
        && verify_dcount="$SHARD_VERIFY_DCOUNT" \
        && shard_delta_add_text "$verify_stage" .shard-filecount "$verify_n" 0 \
        && shard_delta_add_text "$verify_stage" .shard-deploys "$((verify_dcount + 1))" 0 \
        && verify_base_tree="$SHARD_VERIFY_BASE_TREE" \
        && verify_plan_tree="$(git -C "$verify_stage" write-tree --missing-ok)"; then
        verify_plan_seconds="$((SECONDS - verify_started))"
        verify_ready=1
        delta_snapshot="$verify_snapshot"
      else
        echo "::warning::[shard-push-verify] $section-$loc plan unavailable: ${SHARD_VERIFY_REASON:-advisory preparation failure}"
      fi
    fi

    if [ "$SHARD_PUSH_MODE" = delta ]; then
      delta_sidecar="$(shard_delta_manifest_sidecar "$loc")"
      current_manifest="$manifest_dir/$loc.jsonl"
      if shard_manifest_snapshot "$current_manifest" "$sub" "$stage_src/dist" "$manifest_tool" "$delta_output"; then
        delta_snapshot="$delta_output/snapshot.jsonl"
        if shard_delta_clone_and_prepare \
            "$stage" "$SHARD_REPO" "$current_manifest" "$delta_sidecar" \
            "$sub" "$stage_src/dist" "$manifest_tool" "$delta_output" \
            "$SHARD_HISTORY_CAP" "$section-$loc shard"; then
          delta_apply_ok=1
          if [ "$cdn_rewrite_deferred" = 1 ]; then
            if offload_delta_stage "$delta_output"; then
              cdn_rewrite_partial=1
            else
              echo "::warning::$section-$loc shard: partial CDN rewrite failed — rewriting the whole staged copy"
              offload_full_stage
              cdn_rewrite_deferred=0
            fi
          fi
          if ! shard_delta_check_unchanged_payload_paths \
              "$stage" "$sub" "$delta_output/unchanged-files.txt"; then
            delta_apply_ok=0
            delta_fallback_reason="${SHARD_DELTA_REASON:-delta unchanged payload check failed}"
          fi
          if [ "$delta_apply_ok" = 1 ]; then
            if ! shard_delta_remove_stale_payload_paths \
                "$stage" "$sub" "$delta_output/payload-files.txt" "$delta_output/removed.txt" 1 \
                "$delta_output/manifest-covered-files.txt"; then
              delta_apply_ok=0
              delta_fallback_reason="${SHARD_DELTA_REASON:-delta tombstone application failed}"
            fi
          fi
          if [ "$delta_apply_ok" = 1 ] && ! shard_delta_apply_source_tree \
              "$stage" "$stage_src/dist/$sub" "$sub" \
              "$delta_output/changed-files.txt" \
              "$delta_output/unmanifested-files.txt" \
              "$delta_output/payload-files.txt"; then
            delta_apply_ok=0
            delta_fallback_reason='delta source application failed'
          fi
          if [ "$delta_apply_ok" = 1 ]; then
            if ! shard_delta_add_text "$stage" .nojekyll '' ; then delta_apply_ok=0; fi
            if ! shard_delta_add_text "$stage" CNAME "$ORIGIN_HOST"; then delta_apply_ok=0; fi
            if [ -f "$stage_src/dist/404.html" ]; then
              if ! shard_delta_add_file "$stage" "$stage_src/dist/404.html" 404.html; then delta_apply_ok=0; fi
            elif ! shard_delta_remove_file "$stage" 404.html; then
              delta_apply_ok=0
            fi
            if ! shard_delta_add_text "$stage" index.html "<!doctype html><meta charset=utf-8><title>frontaliereticino.ch $section-$loc shard</title>"; then delta_apply_ok=0; fi
            if ! shard_delta_add_file "$stage" "$delta_snapshot" "$delta_sidecar"; then delta_apply_ok=0; fi
          fi
          if [ "$delta_apply_ok" = 1 ]; then
            n="$(shard_delta_count_files "$stage" "$sub")"
            if [ ! -s "$stage_src/dist/$sub/index.html" ]; then
              delta_apply_ok=0
              delta_fallback_reason='delta source index is empty'
            elif [ "$n" -lt "$src_n" ]; then
              delta_apply_ok=0
              delta_fallback_reason="delta integrity check failed (indexed $n, source $src_n)"
            elif shard_delta_shrink_exceeded "$SHARD_DELTA_PREV_N" "$n" "${SHARD_SHRINK_GUARD_PCT:-50}"; then
              delta_apply_ok=0
              delta_fallback_reason="shrink guard would reject $SHARD_DELTA_PREV_N -> $n files (>${SHARD_SHRINK_GUARD_PCT:-50}%)"
            fi
          fi
          if [ "$delta_apply_ok" = 1 ]; then
            dcount="$SHARD_DELTA_DCOUNT"
            prev_n="$SHARD_DELTA_PREV_N"
            incremental=1
            if ! shard_delta_add_text "$stage" .shard-filecount "$n" 0; then delta_apply_ok=0; fi
            if ! shard_delta_add_text "$stage" .shard-deploys "$((dcount + 1))" 0; then delta_apply_ok=0; fi
          fi
          if [ "$delta_apply_ok" != 1 ] && [ -z "$delta_fallback_reason" ]; then
            delta_fallback_reason='delta index update failed'
          fi
          if [ "$delta_apply_ok" = 1 ]; then
            delta_applied=1
            echo "$section-$loc shard: delta indexed tree, $n files (src $src_n, prev $prev_n, changed=$SHARD_DELTA_CHANGED_FILES, unmanifested-overlay=$SHARD_DELTA_UNMANIFESTED_FILES, reused=$SHARD_DELTA_REUSED_FILES, removed=$SHARD_DELTA_REMOVED_FILES, deploys-since-flatten=$((dcount + 1)))"
          fi
        else
          delta_fallback_reason="${SHARD_DELTA_REASON:-remote delta preparation failed}"
        fi
      else
        delta_fallback_reason="${SHARD_DELTA_REASON:-current manifest missing or invalid}"
      fi
      if [ "$delta_applied" != 1 ]; then
        echo "::warning::$section-$loc shard: delta fallback: fallback reason=$delta_fallback_reason — using full overlay"
      fi
    fi

    if [ "$delta_applied" != 1 ]; then
      if [ "$SHARD_PUSH_MODE" = delta ]; then
        rm -rf "$stage"; mkdir -p "$stage"
      fi
      # Full fallback reads EVERY staged file: complete the deferred rewrite
      # first (idempotent over the files a partial pass already rewrote).
      if [ "$cdn_rewrite_deferred" = 1 ]; then
        echo "$section-$loc shard: delta fell back to full — rewriting the whole staged copy"
        offload_full_stage
        cdn_rewrite_deferred=0
        cdn_rewrite_partial=0
      fi
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
      if { [ "$SHARD_PUSH_MODE" = delta ] || [ "$verify_ready" = 1 ]; } \
         && [ -n "$delta_snapshot" ] && [ -s "$delta_snapshot" ]; then
        mkdir -p "$stage/$(dirname "$delta_sidecar")"
        cp "$delta_snapshot" "$stage/$delta_sidecar"
      fi

      n="$(shard_count_files "$stage/$sub")"
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
    # A refused shrink is self-perpetuating: the push never lands, so
    # .shard-filecount never advances and the NEXT deploy re-trips identically.
    # Only a human ends it — either with the env override below (break-glass,
    # unpinned) or with a pinned entry in section-shard-shrink-acks.json, which
    # matches one exact prev->new transition and goes inert once it lands
    # (issues #5220/#5221/#5222 — giura fr/en/de refused the same legitimate
    # 4948->1259 correction on every deploy while serving fabricated pages).
    SHARD_SHRINK_GUARD_PCT="${SHARD_SHRINK_GUARD_PCT:-50}"
    shrink_override_var="SHARD_SHRINK_GUARD_OVERRIDE_${SECTION_UPPER}_${LOC_UPPER}"
    if [ "$prev_n" -gt 0 ] && [ "$(( n * 100 ))" -lt "$(( prev_n * (100 - SHARD_SHRINK_GUARD_PCT) ))" ]; then
      shrink_acked=0; ack_msg="override not set; acks not consulted"
      if [ "${!shrink_override_var:-}" != "true" ]; then
        # Fails CLOSED: any non-zero exit (no entry, moved baseline, below the
        # floor, unreadable file) leaves shrink_acked=0 and the push is refused.
        if ack_msg="$(node "$repo_root/scripts/lib/shrink-ack-check.mjs" \
            --section "$section" --locale "$loc" --prev "$prev_n" --new "$n" 2>&1)"; then
          shrink_acked=1
        fi
      fi
      if [ "${!shrink_override_var:-}" = "true" ] || [ "$shrink_acked" = 1 ]; then
        echo "::warning::$section-$loc shard would shrink $prev_n -> $n files (>${SHARD_SHRINK_GUARD_PCT}%) — proceeding with an INTENTIONAL shrink push (verify this was expected): $ack_msg"
      else
        echo "::error::$section-$loc shard would shrink $prev_n -> $n files (>${SHARD_SHRINK_GUARD_PCT}%) — refusing push (suspected build regression). Not acknowledged: $ack_msg. If this shrink is verified intentional, add a pinned entry to scripts/lib/section-shard-shrink-acks.json (preferred) or set $shrink_override_var=true"
        # Hand the REAL cause to report-shard-push-failure.mjs so the filed issue
        # leads with it instead of a generic checklist that starts at auth.
        printf 'shrink guard refused: %s -> %s files (>%s%%)' "$prev_n" "$n" "$SHARD_SHRINK_GUARD_PCT" \
          > "${RUNNER_TEMP:-/tmp}/shard-fail-reason-$section-$loc" 2>/dev/null || true
        exit 1
      fi
    fi
    printf '%s' "$n" > "$stage/.shard-filecount"
    printf '%s' "$((dcount + 1))" > "$stage/.shard-deploys"
    echo "$section-$loc shard: $(du -sh "$stage" 2>/dev/null | cut -f1), $n files (src $src_n, prev $prev_n, incremental=$incremental, deploys-since-flatten=$((dcount + 1)))"
    fi

    if [ "$delta_applied" = 1 ] && [ "$cdn_rewrite_partial" = 1 ]; then
      # Records how to complete this staged copy, so the pack-step barrier can
      # re-run the full pass synchronously if the background one fails.
      printf '%s\n%s\n%s\n' "$stage_src" "$offload_script" "$CDN_BASE_FIXED" \
        > "$RUNNER_TEMP/shard-cdn-partial-$section-$loc"
    fi
    if [ "$delta_applied" = 1 ]; then
      cd "$stage"
      git config user.email "valerielinc@gmail.com"
      git config user.name "Valerie Linc"
      if [ "$SHARD_DELTA_CONTENT_CHANGES" -eq 0 ]; then
        echo "$section-$loc shard: no content changes vs remote — skipping push (already current)"
      else
        _sha="${GITHUB_SHA:-local}"; _sha="${_sha:0:8}"
        _delta_tree="$(git write-tree --missing-ok)"
        _delta_commit="$(git commit-tree "$_delta_tree" -p HEAD -m "$section-$loc shard ${_sha} (run ${GITHUB_RUN_ID:-local}) [delta]")"
        _push_ok=0
        if shard_push_with_retry "$stage" "$SHARD_REPO" "$_delta_commit:main" "$section-$loc shard"; then
          _push_ok=1
        fi
        if [ "$_push_ok" != 1 ] && [ "$incremental" = 1 ]; then
          echo "::warning::$section-$loc shard: delta self-heal required after 3 push attempts — flattening to a fresh orphan commit and retrying"
          if git -C "$stage" checkout-index -a; then
            if shard_orphan_flatten_and_push "$stage" "$SHARD_REPO" "$section-$loc shard ${_sha} (run ${GITHUB_RUN_ID:-local}) [self-heal flatten]" "$section-$loc shard flatten"; then
              _push_ok=1
            fi
          fi
        fi
        [ "$_push_ok" = 1 ] || { echo "::error::$section-$loc shard push failed after 3 attempts (+ flatten self-heal retry)"; exit 1; }
      fi
    else
      cd "$stage"
      git config user.email "valerielinc@gmail.com"
      git config user.name "Valerie Linc"
      git add -A
      _skip_content_push=0
      if [ "$incremental" = 1 ]; then
        _content_diff_status=0
        shard_index_has_content_changes "$stage" || _content_diff_status=$?
        if [ "$_content_diff_status" -eq 1 ]; then
          _skip_content_push=1
        elif [ "$_content_diff_status" -gt 1 ]; then
          echo "::warning::$section-$loc shard: staged content diff failed — publishing conservatively"
        fi
      fi
      if [ "$_skip_content_push" -eq 1 ]; then
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
      if [ "$verify_ready" = 1 ]; then
        if actual_tree="$(git -C "$stage" rev-parse 'HEAD^{tree}' 2>/dev/null)"; then
          shard_delta_verify_report \
            "$verify_stage" "$verify_base_tree" "$verify_plan_tree" \
            "$stage" "$actual_tree" "$verify_tool" "$SHARD_REPO" "$verify_plan_seconds"
        else
          echo "::warning::[shard-push-verify] $section-$loc actual pushed tree unavailable (advisory)"
        fi
      fi
      fi
    fi
    rm -rf "$verify_stage" "$verify_output"
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
  # Partial rewrite pushed: complete the staged copy for the pack step in
  # background (the pack steps wait for it — scripts/lib/shard-cdn-rewrite.sh).
  # On a failed push the pack skips this section anyway (no ok-marker), but the
  # staged files are hardlinked to dist/<sub>, which then stays in the apex:
  # complete it too, so no step after this one sees a half-rewritten subtree.
  if [ -e "$RUNNER_TEMP/shard-cdn-partial-$section-$loc" ]; then
    shard_cdn_rewrite_launch "$RUNNER_TEMP" "$section" "$loc" "$stage_src" "$offload_script" "$CDN_BASE_FIXED"
  fi
  if [ "$rc" -eq 0 ]; then
    touch "$RUNNER_TEMP/shard-ok-$section-$loc"   # consumed by the strip step
    echo "✅ pushed $section-$loc shard"
  else
    echo "::warning::$section-$loc shard build/push failed (rc=$rc) — $loc $section will NOT be stripped this run"
  fi
  return "$rc"
}

push_section_shard
