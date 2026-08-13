#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/push-locale-shard.sh — Build + force-push ONE locale shard
#
# Extracted verbatim (behaviour-identical) from the deploy.yml step
# "Push locale shards (en/de/fr → frontaliere-{loc} / Pages)" so the matrix
# deploy (one runner per locale) can push a single locale without re-running the
# whole monolithic deploy. The production deploy.yml ran the three locales
# CONCURRENTLY inside a shared `push_shard()` function (background subshells +
# `wait`); here we push EXACTLY ONE locale per invocation — the matrix gives the
# concurrency by fanning out one runner per locale, so the in-script `&`/`wait`
# fan-out is intentionally removed (the only behavioural change). Every integrity
# gate is preserved byte-for-byte.
#
# Usage:
#   push-locale-shard.sh <locale> <dist_dir>
#     <locale>    ∈ {en, de, fr}; the shard subtree is <dist_dir>/<locale>
#     <dist_dir>  build output dir (e.g. "dist"); the original step used "dist"
#
# Required env (read exactly as the workflow does, via indirect expansion):
#   SHARD_<LOCALE>_DEPLOY_KEY  — per-locale SSH deploy key, e.g. SHARD_EN_DEPLOY_KEY.
#                                Missing → skip (exit 0), never an error.
# Optional env:
#   RUNNER_TEMP        — scratch dir + success-marker location (GitHub Actions sets
#                        it). Falls back to a mktemp dir if unset (logged).
#   SHARD_HISTORY_CAP  — deploys between forced history flattens (default 50).
#   GITHUB_SHA         — short SHA embedded in the commit message (best-effort).
#   GITHUB_RUN_ID      — run id embedded in the commit message (best-effort).
#
# On success writes the marker $RUNNER_TEMP/shard-ok-<locale> (consumed by the
# strip step) and exits 0. On a SKIP (no deploy key, or <dist_dir>/<locale>
# absent) exits 0 WITHOUT the marker. On a real build/push failure exits non-zero
# so the caller decides (the matrix step is `continue-on-error: true`, mirroring
# the original step).
#
# Exit codes:
#   0  — pushed (marker written), or legitimately skipped (no marker)
#   1  — bad usage / real build or push failure
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

# shard_read_counter / shard_orphan_init / shard_push_with_retry /
# shard_orphan_flatten_and_push — shared with push-section-shard.sh and
# compact-article-shard-history.sh (issue #4881, AGENTS.md #6).
source "$(dirname "${BASH_SOURCE[0]}")/shard-git-helpers.sh"

loc="${1:-}"
dist_dir="${2:-}"

if [ -z "$loc" ] || [ -z "$dist_dir" ]; then
  echo "Usage: push-locale-shard.sh <locale> <dist_dir>" >&2
  exit 1
fi
case "$loc" in
  en|de|fr) ;;
  *) echo "::error::unsupported locale '$loc' (expected en|de|fr)" >&2; exit 1 ;;
esac

# RUNNER_TEMP is set in GitHub Actions; outside it (local runs) fall back to a
# fresh temp dir so the stage dirs, keyfile and ok-marker have a home.
if [ -z "${RUNNER_TEMP:-}" ]; then
  RUNNER_TEMP="$(mktemp -d)"
  echo "ℹ️ RUNNER_TEMP unset — using temp dir $RUNNER_TEMP"
fi

# ── Push ONE locale shard ─────────────────────────────────────────────────────
# Mirrors the original push_shard() body. Returns 0 on push/skip, non-zero only
# on a real failure (the caller decides how to react).
push_shard() {
  local loc="$1"
  local key_var key_val stage keyfile src_n prev_n rc
  key_var="SHARD_$(echo "$loc" | tr a-z A-Z)_DEPLOY_KEY"
  key_val="${!key_var:-}"
  if [ -z "$key_val" ]; then
    echo "no $key_var secret — skipping $loc shard push"; return 0
  fi
  if [ ! -d "$dist_dir/$loc" ]; then
    echo "$dist_dir/$loc absent — skipping $loc shard push"; return 0
  fi
  stage="$RUNNER_TEMP/shard-$loc"
  keyfile="$RUNNER_TEMP/shard_${loc}_key"
  printf '%s\n' "$key_val" > "$keyfile" && chmod 600 "$keyfile"
  # GIT_SSH_COMMAND is exported for this locale's push. One locale per
  # invocation (the matrix runs each locale on its OWN runner), so the deploy
  # keys never clobber one another.
  export GIT_SSH_COMMAND="ssh -i $keyfile -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
  # Source-of-truth file count + the shard's last-published count, read
  # cheaply (no 2.5 GB clone) — a tiny .shard-filecount marker fetched
  # from raw.githubusercontent. Drive the gate off these so a PARTIAL
  # copy (n < source) or an upstream build regression that emits a much
  # smaller locale (n << last-good) is caught EXACTLY, not just the
  # near-empty case.
  src_n="$(find "$dist_dir/$loc" -type f | wc -l)"
  # prev_n is read from the blobless clone itself further below (via
  # shard_read_counter, git-plumbing HEAD:.shard-filecount) instead of a
  # separate raw.githubusercontent.com fetch — see shard-git-helpers.sh
  # header for why the old `[ -f ... ]`-style read was unreliable and why
  # git-plumbing is strictly more robust than the unauthenticated CDN route.
  # Files removed from THIS locale's dist subtree by the "Strip section
  # subtrees" step that ran BEFORE this push — section shards (svizzera /
  # zurigo / ticino) that are now LIVE in their own repos. strip-section-
  # subtree.sh gates the strip on the section shard's push ok-marker, so that
  # content is already verified-live elsewhere; the main shard shrinks by
  # exactly this many files as a PLANNED split, not a build regression. We add
  # it back below to reconstruct the BUILT (pre-strip) size for gate (b), so a
  # section going live no longer trips the >50% shrink guard (incident jul20).
  # Absent marker (local run / no strip) → 0 → identical to the old behaviour.
  stripped_n="$(cat "${RUNNER_TEMP}/shard-stripped-$loc" 2>/dev/null || echo 0)"
  [[ "$stripped_n" =~ ^[0-9]+$ ]] || stripped_n=0
  # EVERYTHING that builds the shard tree AND pushes runs inside one
  # `set -e` subshell with the integrity gates before the push. A failed
  # copy / truncated tree ABORTS before push: a monco tree is never
  # pushed over a good shard, the ok-marker is never written → the strip
  # step skips this locale (stays in main, no 404). The copy is
  # hardlinked when same-filesystem (cp -al) to avoid duplicating
  # ~2.5 GB per locale on a tight runner disk, falling back to cp -r.
  # NB: run the guarded build+push as a STANDALONE subshell and capture
  # its exit ($?), NOT as an `if (...)` condition — bash neuters an
  # inner `set -e` when the subshell runs in a condition/&&/|| context,
  # which would let a failed gate fall through to the push.
  # ── Incremental delta push (#2246 item 2) ────────────────────────
  # A blobless clone of the existing shard repo seeds $stage/.git with the
  # remote's commit+tree graph (NO blob download → cheap, ~no bytes for a
  # 2.5 GB tree). Overlaying the new build into that working tree and
  # committing ON TOP of the existing tip lets `git push` negotiate the
  # DELTA: only blobs the remote LACKS (new/changed job pages) go over the
  # wire — unchanged pages (the vast majority deploy-to-deploy) cost
  # nothing. Measured 25× less data vs the orphan `git init` force-push
  # that re-sent the WHOLE tree every deploy (the ~13 min shard-push
  # bottleneck). `git add -A` over the freshly-overlaid tree stages
  # adds+changes+DELETIONS, so the pushed tree still EXACTLY equals the
  # new build (removed job pages vanish) — identical end-state to the old
  # orphan push, just transferred incrementally.
  # FAIL-SAFE: any clone failure (first push / transient / corrupt remote)
  # falls back to the original orphan `git init` + force-push (full tree),
  # so this is NEVER weaker than before. Both paths run inside the SAME
  # `set -e` subshell AFTER the integrity gates, so a monco tree is never
  # pushed and the ok-marker is only written on a clean push.
  (
    set -e
    rm -rf "$stage"; mkdir -p "$stage"
    # Seed history from the remote (blobless = graph only, no blob bytes)
    # so the push below sends only the delta. depth:1 keeps the clone to a
    # single commit's trees. Non-fatal: on failure $incremental stays 0
    # and we orphan-init below (full push) exactly as before.
    # SHARD_HISTORY_CAP: deploys between forced history flattens. Each
    # incremental push appends one commit, so the remote .git accumulates
    # superseded-blob packs over time (the published SITE stays the same
    # size — only .git grows). Every Nth deploy we orphan-reset to flatten
    # history back to a single commit, bounding .git growth while keeping
    # the delta benefit on the other N-1 deploys. The counter lives in the
    # committed .shard-deploys marker (read from the cloned tip).
    SHARD_HISTORY_CAP="${SHARD_HISTORY_CAP:-50}"
    incremental=0
    dcount=0
    prev_n=0
    # --no-checkout is LOAD-BEARING: without it `git clone` materializes
    # HEAD's working tree, which under --filter=blob:none lazily fetches
    # ALL ~2.5 GB of blobs (defeating the bandwidth win — it would just
    # trade a 2.5 GB upload for a 2.5 GB download). With --no-checkout the
    # clone fetches only the commit+tree graph (~no blob bytes); the index
    # is still populated from HEAD, so the `git add -A` over the
    # re-materialized build below produces a DELTA (not a from-scratch
    # tree) and stages deletions of removed pages. The working tree starts
    # EMPTY, so the find-wipe below is a harmless no-op on this path. Note
    # --no-checkout ALSO means no working-tree file is ever materialized,
    # so bookkeeping counters (.shard-deploys / .shard-filecount) must be
    # read via git-plumbing (shard_read_counter), not `[ -f ... ]` — see
    # shard-git-helpers.sh header for the incident this fixes.
    if git clone -q --depth 1 --filter=blob:none --no-checkout \
         "git@github.com:valerielinc-ops/frontaliere-$loc.git" "$stage" 2>/dev/null \
       && [ -d "$stage/.git" ]; then
      dcount="$(shard_read_counter "$stage" .shard-deploys)"
      prev_n="$(shard_read_counter "$stage" .shard-filecount)"
      if [ "$dcount" -ge "$SHARD_HISTORY_CAP" ]; then
        # History cap reached → flatten: drop the cloned .git and start a
        # fresh orphan commit (full push), resetting the deploy counter.
        echo "$loc shard: history cap $SHARD_HISTORY_CAP reached (dcount=$dcount) — flattening with orphan force-push"
        rm -rf "$stage"; mkdir -p "$stage"
        shard_orphan_init "$stage"
        dcount=0
      else
        # Wipe the checked-out working tree (keep .git) — we re-materialize
        # the entire shard from the fresh build below, so `git add -A`
        # produces the exact new tree (and stages deletions of gone pages).
        find "$stage" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} + 2>/dev/null || true
        incremental=1
      fi
    else
      echo "$loc shard: no prior clone (first push / transient) — full orphan push"
      shard_orphan_init "$stage"
    fi
    : > "$stage/.nojekyll"                                  # serve every path verbatim
    printf 'origin-%s.frontaliereticino.ch' "$loc" > "$stage/CNAME"  # shard custom domain
    cp -al "$dist_dir/$loc" "$stage/$loc" 2>/dev/null || cp -r "$dist_dir/$loc" "$stage/$loc"
    if [ -f "$dist_dir/$loc.html" ]; then cp "$dist_dir/$loc.html" "$stage/$loc.html"; fi  # homepage at /{loc}
    # Shard-root SPA-fallback for hard 404s (#5709): GitHub Pages only honours
    # a repo-root 404.html, and prune-locale-shard.mjs now preserves it
    # through the per-locale build's prune step precisely so it survives to
    # here. Without it, any non-prerendered SPA route under /en|/de|/fr (e.g.
    # newsletter preferences) hit GitHub Pages' own generic 404 instead of
    # rebooting the app — the main (it) shard never had this gap because its
    # 404.html already lives at dist's root, which IS the shard root there.
    if [ -f "$dist_dir/404.html" ]; then cp "$dist_dir/404.html" "$stage/404.html"; fi
    printf '<!doctype html><meta charset=utf-8><title>frontaliereticino.ch %s shard</title>' "$loc" > "$stage/index.html"
    n="$(find "$stage/$loc" -type f | wc -l)"
    # BUILT size = the shard as EMITTED by the build, before the "Strip section
    # subtrees" step removed already-verified-live section subtrees. Gate (b)
    # reasons on THIS (not the smaller served $n) so a populate-then-strip
    # section split — which drops served files but not built files — reads flat
    # instead of as a >50% regression. stripped_n is 0 on a normal (no-strip)
    # run, so built_n == n and the behaviour is identical to before.
    built_n="$(( n + stripped_n ))"
    # (a) copy integrity: the staged subtree must have AT LEAST as many
    #     files as the source — a partial cp (disk-full) lands fewer → abort.
    test -s "$stage/$loc/index.html"
    [ "$n" -ge "$src_n" ]
    # (b) regression guard: refuse a push whose BUILT tree shrank >50% vs its
    #     last-published high-water (a genuine upstream partial-locale build).
    #     Compares built_n (served + section-stripped) so a planned section
    #     split passes while a real partial build is still caught. The recorded
    #     high-water below is likewise the BUILT size, keeping the comparison
    #     consistent across the seed → split transition. First seed → prev_n 0
    #     → skip.
    # Threshold configurable (default 50, unchanged from the previous
    # hardcoded behaviour) + a per-locale override for a VERIFIED intentional
    # shrink — still logged loudly, never silent (AGENTS.md Non-Negotiable
    # #2; mirrors push-section-shard.sh's identical guard, issue #4881).
    SHARD_SHRINK_GUARD_PCT="${SHARD_SHRINK_GUARD_PCT:-50}"
    shrink_override_var="SHARD_SHRINK_GUARD_OVERRIDE_$(echo "$loc" | tr a-z A-Z)"
    if [ "$prev_n" -gt 0 ] && [ "$(( built_n * 100 ))" -lt "$(( prev_n * (100 - SHARD_SHRINK_GUARD_PCT) ))" ]; then
      if [ "${!shrink_override_var:-}" = "true" ]; then
        echo "::warning::$loc shard would shrink $prev_n -> $built_n built files ($n served + $stripped_n section-stripped) (>${SHARD_SHRINK_GUARD_PCT}%) — $shrink_override_var=true set, proceeding with an INTENTIONAL shrink push (verify this was expected)"
      else
        echo "::error::$loc shard would shrink $prev_n -> $built_n built files ($n served + $stripped_n section-stripped) (>${SHARD_SHRINK_GUARD_PCT}%) — refusing push (suspected build regression). If this shrink is verified intentional, set $shrink_override_var=true"
        exit 1
      fi
    fi
    printf '%s' "$built_n" > "$stage/.shard-filecount"   # high-water-mark (BUILT size) for the next run's gate (b)
    printf '%s' "$((dcount + 1))" > "$stage/.shard-deploys"  # commits since last flatten (history-cap counter)
    echo "$loc shard: $(du -sh "$stage" 2>/dev/null | cut -f1), $n files served / $built_n built (src $src_n, section-stripped $stripped_n, prev $prev_n, incremental=$incremental, deploys-since-flatten=$((dcount + 1)))"
    cd "$stage"
    git config user.email "valerielinc@gmail.com"
    git config user.name "Valerie Linc"
    git add -A
    # Nothing changed since the last deploy → no commit, skip the push
    # entirely (idempotent; the remote already serves this exact tree).
    # The no-change check EXCLUDES the bookkeeping markers (.shard-deploys
    # bumps every run, .shard-filecount could too) — otherwise the counter
    # delta would always trip the diff and the skip would be dead code. We
    # only care whether the SERVED CONTENT changed; if it didn't, there is
    # nothing to publish and bumping the history counter is pointless.
    if [ "$incremental" = 1 ] \
       && git diff --cached --quiet -- . ':!.shard-deploys' ':!.shard-filecount'; then
      echo "$loc shard: no content changes vs remote — skipping push (already current)"
    else
      _sha="${GITHUB_SHA:-local}"; _sha="${_sha:0:8}"
      git commit -qm "locale shard $loc ${_sha} (run ${GITHUB_RUN_ID:-local})"
      # Incremental: fast-forward push on top of the cloned tip (delta only).
      # Orphan fallback: force-push the single fresh commit (full tree) as
      # before. `-f` is harmless on the incremental ff-path and required on
      # the orphan path, so use it for both.
      _push_ok=0
      if shard_push_with_retry "$stage" "git@github.com:valerielinc-ops/frontaliere-$loc.git" "main" "$loc shard"; then
        _push_ok=1
      fi
      # Self-heal: 3 retries on the SAME incremental base never recover from a
      # corrupted/diverged remote-tracking clone (the "not our ref" / "bad tree
      # object" / "early EOF" failure mode — see scripts/lib/push-section-shard.sh
      # for the incident this mirrors, 2026-07-24 run 30057726623). If this push
      # built on a cloned base (incremental=1, not already a fresh orphan), drop
      # the corrupted local history and retry as a brand-new orphan commit — a
      # full pack that doesn't negotiate against the broken remote graph —
      # before giving up.
      if [ "$_push_ok" != 1 ] && [ "$incremental" = 1 ]; then
        echo "::warning::$loc shard: 3 incremental push attempts failed — flattening to a fresh orphan commit and retrying"
        if shard_orphan_flatten_and_push "$stage" "git@github.com:valerielinc-ops/frontaliere-$loc.git" "locale shard $loc ${_sha} (run ${GITHUB_RUN_ID:-local}) [self-heal flatten]" "$loc shard flatten"; then
          _push_ok=1
        fi
      fi
      [ "$_push_ok" = 1 ] || { echo "::error::$loc shard push failed after 3 attempts (+ flatten self-heal retry)"; exit 1; }
    fi
  )
  rc=$?
  rm -f "$keyfile"
  # $stage (the git-clone-based push staging dir, up to several GB) is never
  # read again after this point — deploy.yml's tar-pack step reads dist_dir
  # directly, not $stage. Leaving it on disk let it accumulate alongside the
  # per-section shard stages within the SAME job, exhausting runner disk on
  # the (heaviest) IT leg and crashing the whole job mid-run with "No space
  # left on device" before it could push its CDN build id — which is what
  # made the downstream de/en/fr locales' cross-shard ordering wait (#2569)
  # time out and skip their own push (issue #4734).
  rm -rf "$stage"
  if [ "$rc" -eq 0 ]; then
    touch "$RUNNER_TEMP/shard-ok-$loc"   # consumed by the strip step
    echo "✅ pushed $loc shard"
  else
    echo "::warning::$loc shard build/push failed (rc=$rc) — $loc will NOT be stripped from main this run"
  fi
  return "$rc"
}

push_shard "$loc"
