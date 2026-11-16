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
# THE UNIT OF LOSS IS A URL, NOT A PATH
# ─────────────────────────────────────
# `<p>/index.html` and `<p>.html` are two spellings of ONE url, `/<p>` — that is
# the static-host convention this whole site is built on, and
# `scripts/ci/assert-dist-complete.mjs:193` already resolves a sitemap url by
# trying exactly that pair. A snapshotted path is therefore only lost when its
# TWIN spelling is missing too; when the shard carries the other spelling the
# url still answers and nothing was lost, only re-spelled.
#
# Not hypothetical, and not a threshold being widened (AGENTS.md #1/#2 — the
# fatal rule is untouched, its INPUT is corrected): the apex build emits
# `dist/<loc>.html` for the en/de/fr homepage while push-locale-shard.sh copies
# it only `if [ -f "$dist_dir/$loc.html" ]`, which in the locale leg it is not —
# `valerielinc-ops/frontaliere-{en,de,fr}` hold `<loc>/` + `index.html` at their
# root and no `<loc>.html` at all. So `dist/<loc>.html` was snapshotted, the
# shard put back `dist/<loc>/index.html`, and a path-wise diff called the
# homepage an indexable loss on EVERY deploy from the moment this guard landed
# (run 31240103446). Measured against production at that time: `/en`, `/de`,
# `/fr` answer 200, `/en.html` answers 404, the `/en/` canonical is
# `https://frontaliereticino.ch/en/`, and no sitemap names `/en.html` — i.e. the
# url never moved and the twin is the spelling the edge actually serves.
#
# The #5290 shape is untouched by this: a topic hub emitted only as
# `.../argomenti/<topic>/index.html` and never shipped to the shard has NO twin
# in dist afterwards, so it stays fatal.
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

# The other spelling of the same url — `<p>/index.html` ⇄ `<p>.html` — or the
# empty string when the path names no url at all (a non-HTML asset). Same pair
# scripts/ci/assert-dist-complete.mjs:193 tries when it resolves a sitemap url
# to a file on disk; kept deliberately in lockstep with it, since disagreeing
# about which files answer a url is how the two gates would contradict.
trunk_url_twin() {
  case "$1" in
    */index.html) printf '%s.html' "${1%/index.html}" ;;
    index.html)   printf '' ;;   # the dist root itself has no `.html` spelling
    *.html)       printf '%s/index.html' "${1%.html}" ;;
    *)            printf '' ;;
  esac
}

trunk_guard_init() {
  TRUNK_GUARD_NS="${1:-guard}"
  TRUNK_GUARD_DIST="${2:-dist}"
  TRUNK_GUARD_STATE="${RUNNER_TEMP:-/tmp}/trunk-guard-$TRUNK_GUARD_NS"
  TRUNK_GUARD_FATAL_MARKER_WRITE_FAILED=0
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

# Report what the replace actually destroyed: every snapshotted path whose URL
# the shard content did NOT put back. Files the shard also carries are not
# losses — the shard simply won the collision, which is the intended semantics —
# and neither are files it put back under the OTHER spelling of the same url
# (see "THE UNIT OF LOSS IS A URL, NOT A PATH" in the header).
trunk_replace_end() {
  local label="$1"
  local dist="${TRUNK_GUARD_DIST:-dist}"
  local state="${TRUNK_GUARD_STATE:-${RUNNER_TEMP:-/tmp}/trunk-guard}"
  local all="$state/$label.all"
  local idx="$state/$label.idx"
  local lost_file="$state/$label.lost"
  local fatal_file="$state/$label.fatal"
  local benign_file="$state/$label.benign"
  if [ ! -f "$all" ]; then return 0; fi

  local rel twin lost=0 fatal=0 benign=0 respelled=0 classification_ok=1
  local fatal_s="" benign_s="" respelled_s=""
  # A lost path is counted before it is written so the final verdict can stay
  # fail-closed even when the inventory itself becomes unwritable (for
  # example, a full runner filesystem or a broken state path). Do not let that
  # write failure turn a real loss into an empty `comm` input.
  if ! : > "$lost_file"; then classification_ok=0; fi
  while IFS= read -r rel; do
    if [ -z "$rel" ]; then continue; fi
    if [ -e "$dist/$rel" ]; then continue; fi
    # Same url, other spelling. Counted and named — never silently dropped —
    # but it is not a loss: the url still answers from `$dist/$twin`. The
    # structural contract is that the shard can answer the same url from the
    # shard's other spelling, and that fact must remain visible to the guard.
    twin="$(trunk_url_twin "$rel")"
    if [ -n "$twin" ] && [ -e "$dist/$twin" ]; then
      respelled=$((respelled + 1))
      if [ "$respelled" -le "${TRUNK_GUARD_SAMPLE_CAP:-12}" ]; then
        # Braced and ASCII on purpose: `$rel=>` is one token, but `$rel→` is
        # parsed as the name `rel→` in a UTF-8 locale and dies under `set -u`
        # ("rel→: unbound variable") — which is a crash inside the very
        # accounting this file exists to make reliable.
        respelled_s="$respelled_s ${dist}/${rel}=>${dist}/${twin}"
      fi
      continue
    fi
    lost=$((lost + 1))
    if ! printf '%s\n' "$rel" >> "$lost_file"; then
      classification_ok=0
    fi
  done < "$all"

  # `$idx` contains every path whose HTML was classified as indexable while
  # it still existed. The old lookup ran `grep -qxF` once per lost path; on a
  # multi-million-file Ticino subtree that spawned millions of processes and
  # made the validator host-kill before it could report a verdict (#7421).
  # Sort once and classify the complete lost set with two linear `comm` passes:
  # same exact path semantics, one bounded set of external processes.
  if [ "$lost" -gt 0 ]; then
    if [ "$classification_ok" -eq 1 ] \
        && ! LC_ALL=C sort -u "$lost_file" -o "$lost_file"; then classification_ok=0; fi
    if [ "$classification_ok" -eq 1 ] \
        && ! LC_ALL=C sort -u "$idx" -o "$idx"; then classification_ok=0; fi
    if [ "$classification_ok" -eq 1 ] \
        && ! LC_ALL=C comm -12 "$lost_file" "$idx" > "$fatal_file"; then
      classification_ok=0
    fi
    if [ "$classification_ok" -eq 1 ] \
        && ! LC_ALL=C comm -23 "$lost_file" "$idx" > "$benign_file"; then
      classification_ok=0
    fi
    if [ "$classification_ok" -eq 0 ]; then
      # An unreadable classification is unsafe to treat as benign. Preserve
      # the guard's fail-closed correctness contract and name the paths as
      # indexable rather than letting an accounting failure hide a 404.
      echo "::error::[trunk-guard] $label: could not classify lost paths; treating all $lost as indexable"
      fatal_file="$lost_file"
      benign_file="$state/$label.benign-empty"
      : > "$benign_file" 2>/dev/null || true
      # `lost` is authoritative here: the inventory may be partial or
      # unreadable, so deriving `fatal` from `wc -l` could erase the only
      # evidence that a page was lost and suppress the final trunk-guard verdict.
      fatal="$lost"
      benign=0
    else
      lost="$(wc -l < "$lost_file" 2>/dev/null || printf '0')"
      fatal="$(wc -l < "$fatal_file" 2>/dev/null || printf '0')"
      benign="$(wc -l < "$benign_file" 2>/dev/null || printf '0')"
    fi
    while IFS= read -r rel; do
      if [ -n "$rel" ]; then fatal_s="$fatal_s $dist/$rel"; fi
    done < <(head -n "${TRUNK_GUARD_SAMPLE_CAP:-12}" "$fatal_file" 2>/dev/null)
    while IFS= read -r rel; do
      if [ -n "$rel" ]; then benign_s="$benign_s $dist/$rel"; fi
    done < <(head -n "${TRUNK_GUARD_SAMPLE_CAP:-12}" "$benign_file" 2>/dev/null)
  fi
  rm -f "$all" "$idx" "$lost_file" "$fatal_file" "$benign_file" "$state/$label.benign-empty" 2>/dev/null || true

  # Report the re-spellings even on an otherwise clean replace: they are the
  # evidence the url-level comparison is doing something, and the line a future
  # reader needs when this guard is quiet about a file that visibly disappeared.
  if [ "$respelled" -gt 0 ]; then
    echo "[trunk-guard] $label: $respelled replaced file(s) answer the same url from the shard's other spelling (…/index.html ⇄ ….html), not a loss:$respelled_s"
  fi

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
    # The per-label marker is the normal cross-process verdict channel. If
    # that path is unavailable after a fail-closed classification, preserve
    # the failure in a state-level sentinel so trunk_guard_verdict cannot
    # mistake a persistence error for a clean rehydrate.
    if ! : > "$state/fatal/$label" 2>/dev/null; then
      TRUNK_GUARD_FATAL_MARKER_WRITE_FAILED=1
      if ! : > "$state/.fatal-marker-write-failed" 2>/dev/null; then
        # Keep direct callers fail-closed even if the state directory itself
        # is unavailable. Background workers still report through the
        # state-level sentinel whenever that parent remains writable.
        TRUNK_GUARD_FATAL_MARKER_WRITE_FAILED=1
      fi
      echo "::error::[trunk-guard] $label: could not persist fatal verdict marker; preserving a fail-closed verdict"
    fi
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
  local marker_write_failed=0
  if [ -d "$state/fatal" ]; then
    n="$(find "$state/fatal" -type f 2>/dev/null | wc -l | tr -d ' ')"
  fi
  case "${n:-0}" in ''|*[!0-9]*) n=0 ;; esac
  if [ "${TRUNK_GUARD_FATAL_MARKER_WRITE_FAILED:-0}" = "1" ] \
    || [ -f "$state/.fatal-marker-write-failed" ]; then
    marker_write_failed=1
  fi
  if [ "$n" -eq 0 ] && [ "$marker_write_failed" -eq 0 ]; then return 0; fi
  if [ "$marker_write_failed" -eq 1 ]; then
    echo "::error::[trunk-guard] $what: a fatal verdict marker could not be persisted; failing closed because the rehydrate result is not trustworthy."
  fi
  if [ "$n" -gt 0 ]; then
    echo "::error::[trunk-guard] $what: $n subtree(s) lost indexable pages to the shard replace — see the [trunk-guard] lines above for the exact files. This is the #5327 class: a build-time emitter writing under a prefix served by a shard that never receives it."
  fi
  if [ "${REHYDRATE_TRUNK_ORPHANS_FATAL:-true}" = "false" ]; then
    echo "[trunk-guard] REHYDRATE_TRUNK_ORPHANS_FATAL=false — downgraded to a warning, NOT failing this step."
    return 0
  fi
  return 1
}
