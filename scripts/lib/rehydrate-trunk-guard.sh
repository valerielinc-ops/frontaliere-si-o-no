#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/rehydrate-trunk-guard.sh — accounting for what a shard rehydrate
# DESTROYS, sourced by scripts/lib/rehydrate-section-shards.sh and
# scripts/lib/rehydrate-locale-shards.sh (issue #5327).
#
# THE DEFECT THIS CLOSES
# ──────────────────────
# Both rehydrate scripts reconstruct a shard's subtree into `dist/` with
#
#     rm -rf "dist/$sub" ; <extract tar | cp -r from cache | cp -r from clone>
#
# i.e. REPLACE, not merge. When the trunk artifact still holds files under that
# prefix — which is exactly what happens for a section with
# `<SECTION>_BUILD_EMIT_SKIP=true`, since deploy.yml then skips
# strip-section-subtree.sh for it — the `rm -rf` deletes them with no record
# anywhere, immediately before every dist-walking post-deploy audit runs.
# That is how #5290 presented: topicClusterHubsPlugin.ts had written
# `dist/articoli-frontaliere/argomenti/**`, the rehydrate erased it, and the
# only surviving symptom was `assert-dist-complete.mjs` reporting
# `sitemap-topics.xml: 40/40 sampled URLs missing (100%)` — a failure whose
# stated cause (the sitemap) was three steps away from the real one.
#
# WHY THE FIX IS "REPORT", NOT "MERGE"
# ────────────────────────────────────
# Merging (`cp -rn` / rsync without --delete) was the other option on the
# issue. It is WRONG here, and the routing table proves it:
# `infra/cloudflare-worker/locale-router.js:1249-1252` sends EVERY path under a
# section prefix to `SECTION_ORIGIN[section][locale]` — the shard — with no
# apex fallback on a plain origin 404. `push-section-shard.sh` force-pushes the
# complete staged subtree (`test -s "$stage/$sub/index.html"` then `git add -A`
# + force push), so the shard IS the whole truth for that prefix.
# `dist/$sub` after a rehydrate is therefore a MODEL of what the edge serves,
# and a trunk-only file merged into it is a file no user can fetch. Preserving
# it would have turned #5290 GREEN while 40 topic-hub URLs kept 404ing in
# production and kept being announced by an apex sitemap — the gate would have
# lost the only signal that caught this. Replace is the correct semantics; the
# bug is that the deletion was unaccounted, not that it happened.
#
# WHAT IS FATAL AND WHAT IS NOT
# ─────────────────────────────
# Not every destroyed file is a defect worth a red run. Two producers write
# under these prefixes today and they are not the same thing:
#   • legacyRedirectsPlugin.ts writes ~13 old-slug bridges under
#     /articoli-frontaliere/** and /articoli-svizzera/** on EVERY build,
#     unconditionally (its static `redirects` map has no BUILD_EMIT_SKIP
#     guard). Every bridge is emitted `noindex` — buildCanonicalBridgePage's
#     `robotsContent = noindex ? 'noindex,follow' : …` (build-plugins/
#     constants.ts:328) and the REDIRECT_STUB template at constants.ts:400.
#     An assert of "the trunk subtree must be empty" would therefore be red on
#     every single post-deploy run, which is how a gate gets disabled.
#   • the #5290 shape — a plugin emitting real, INDEXABLE content pages under a
#     prefix the build does not ship — is a guaranteed production 404 and, when
#     something lists those URLs, a sitemap full of them.
# So: indexable HTML lost to a rehydrate is FATAL; anything else is a loud,
# itemised warning. That line is the difference between the known-benign
# producer and the incident producer, not a threshold picked by feel.
#
# ESCAPE HATCH: set `REHYDRATE_TRUNK_ORPHANS_FATAL=false` in the calling step's
# `env:` to downgrade the fatal verdict to a warning without a code change.
# The annotations and the inventory are emitted either way.
#
# API (all functions are safe under both `set -uo pipefail` and `set -e`):
#   trunk_guard_init <namespace> [dist_dir]   once, before any rehydrate work
#   trunk_replace_begin <label> <relpath...>  snapshot + `rm -rf` those paths
#   trunk_replace_end <label>                 diff, classify, report, clear
#   trunk_guard_verdict <what>                rc 1 iff an indexable page was lost
#
# `trunk_replace_begin` is idempotent per label: the FIRST call snapshots, any
# later call for the same label only removes. That matters because one
# (section, locale) iteration can replace its subtree twice — tar extraction
# incomplete, then the git-clone fallback — and the snapshot must stay the
# pre-rehydrate trunk state, not the half-extracted tar's.
# ─────────────────────────────────────────────────────────────────────────────

# How many lost paths to name inline. The full inventory always goes to the log
# via the per-file listing below; these caps only bound the annotation text,
# which GitHub truncates anyway.
TRUNK_GUARD_SAMPLE_CAP="${TRUNK_GUARD_SAMPLE_CAP:-12}"

trunk_guard_init() {
  TRUNK_GUARD_NS="${1:-guard}"
  TRUNK_GUARD_DIST="${2:-dist}"
  TRUNK_GUARD_STATE="${RUNNER_TEMP:-/tmp}/trunk-guard-$TRUNK_GUARD_NS"
  rm -rf "$TRUNK_GUARD_STATE" 2>/dev/null || true
  mkdir -p "$TRUNK_GUARD_STATE/fatal" 2>/dev/null || true
  return 0
}

# Snapshot every file currently under the given dist-relative paths, classify
# the HTML among them as indexable/noindex WHILE IT STILL EXISTS (it is about
# to be deleted, so this cannot be deferred to trunk_replace_end), then remove
# the paths exactly as the original `rm -rf` did.
trunk_replace_begin() {
  local label="$1"; shift
  local dist="${TRUNK_GUARD_DIST:-dist}"
  local state="${TRUNK_GUARD_STATE:-${RUNNER_TEMP:-/tmp}/trunk-guard}"
  local all="$state/$label.all"
  local idx="$state/$label.idx"
  local p f
  mkdir -p "$state" 2>/dev/null || true
  if [ ! -f "$all" ]; then
    : > "$all"
    : > "$idx"
    for p in "$@"; do
      if [ ! -e "$dist/$p" ]; then continue; fi
      while IFS= read -r f; do
        if [ -n "$f" ]; then printf '%s\n' "${f#"$dist/"}" >> "$all"; fi
      done < <(find "$dist/$p" -type f 2>/dev/null)
      # -L lists the files WITHOUT a robots-noindex meta, i.e. the indexable
      # ones. Attribute order is not assumed: constants.ts emits
      # `name="robots" … content="noindex,follow"`, but a future emitter could
      # invert it, so both orders match. One recursive pass, not one grep per
      # file — the walk is bounded by the same subtree `find` already crosses.
      while IFS= read -r f; do
        if [ -n "$f" ]; then printf '%s\n' "${f#"$dist/"}" >> "$idx"; fi
      done < <(grep -rLiE --include='*.html' --include='*.htm' \
                 '<meta[^>]*(robots[^>]*noindex|noindex[^>]*robots)' \
                 "$dist/$p" 2>/dev/null)
    done
  fi
  for p in "$@"; do
    # `${dist:?}` so an unset/empty dist can never expand to `rm -rf /$p`,
    # mirroring strip-section-subtree.sh:78-79.
    rm -rf "${dist:?}/$p"
  done
  return 0
}

# Report what the replace actually destroyed: every snapshotted path that the
# shard content did NOT put back. Files the shard also carries are not losses —
# the shard simply won the collision, which is the intended semantics.
trunk_replace_end() {
  local label="$1"
  local dist="${TRUNK_GUARD_DIST:-dist}"
  local state="${TRUNK_GUARD_STATE:-${RUNNER_TEMP:-/tmp}/trunk-guard}"
  local all="$state/$label.all"
  local idx="$state/$label.idx"
  if [ ! -f "$all" ]; then return 0; fi

  local rel lost=0 fatal=0 benign=0
  local fatal_s="" benign_s=""
  while IFS= read -r rel; do
    if [ -z "$rel" ]; then continue; fi
    if [ -e "$dist/$rel" ]; then continue; fi
    lost=$((lost + 1))
    if grep -qxF -- "$rel" "$idx" 2>/dev/null; then
      fatal=$((fatal + 1))
      if [ "$fatal" -le "${TRUNK_GUARD_SAMPLE_CAP:-12}" ]; then
        fatal_s="$fatal_s $dist/$rel"
      fi
    else
      benign=$((benign + 1))
      if [ "$benign" -le "${TRUNK_GUARD_SAMPLE_CAP:-12}" ]; then
        benign_s="$benign_s $dist/$rel"
      fi
    fi
  done < "$all"
  rm -f "$all" "$idx" 2>/dev/null || true

  if [ "$lost" -eq 0 ]; then return 0; fi

  echo "[trunk-guard] $label: the shard rehydrate replaced this subtree and $lost trunk file(s) were NOT carried by the shard ($fatal indexable, $benign noindex/non-HTML)."
  echo "[trunk-guard] $label: these paths are routed to the shard origin by infra/cloudflare-worker/locale-router.js, so they answer 404 in production regardless of this dist/ — the rehydrate is not what makes them missing, it is what used to make them INVISIBLE (issue #5327)."
  if [ -n "$benign_s" ]; then
    echo "[trunk-guard] $label: noindex/non-HTML lost:$benign_s"
  fi
  if [ -n "$fatal_s" ]; then
    echo "[trunk-guard] $label: INDEXABLE lost:$fatal_s"
  fi

  if [ "$fatal" -gt 0 ]; then
    : > "$state/fatal/$label" 2>/dev/null || true
    echo "::error::[trunk-guard] $label: $fatal indexable page(s) were built under a prefix this build does not ship to the shard, and the rehydrate discarded them —$fatal_s. Either gate the emitter on <SECTION>_BUILD_EMIT_SKIP (as #5290 did for topicClusterHubsPlugin.ts) or ship the pages to the shard; they are 404 in production today."
  else
    echo "::warning::[trunk-guard] $label: $lost trunk file(s) discarded by the shard rehydrate, all noindex or non-HTML (bridge pages from legacyRedirectsPlugin.ts and friends) — no indexable content lost, not failing the step."
  fi
  return 0
}

# Non-zero iff at least one (section, locale) lost indexable content. Kept
# separate from trunk_replace_end because rehydrate-section-shards.sh runs one
# background subshell per section: a `return 1` in there is swallowed by its
# `wait "$pid" || true`, so the verdict has to be read back from the state dir
# in the parent after the join.
trunk_guard_verdict() {
  local what="${1:-rehydrate}"
  local state="${TRUNK_GUARD_STATE:-${RUNNER_TEMP:-/tmp}/trunk-guard}"
  local n=0
  if [ -d "$state/fatal" ]; then
    n="$(find "$state/fatal" -type f 2>/dev/null | wc -l | tr -d ' ')"
  fi
  case "${n:-0}" in ''|*[!0-9]*) n=0 ;; esac
  if [ "$n" -eq 0 ]; then return 0; fi
  echo "::error::[trunk-guard] $what: $n subtree(s) lost indexable pages to the shard replace — see the [trunk-guard] lines above for the exact files. This is the #5327 class: a build-time emitter writing under a prefix served by a shard that never receives it."
  if [ "${REHYDRATE_TRUNK_ORPHANS_FATAL:-true}" = "false" ]; then
    echo "[trunk-guard] REHYDRATE_TRUNK_ORPHANS_FATAL=false — downgraded to a warning, NOT failing this step."
    return 0
  fi
  return 1
}
