#!/usr/bin/env bash
set -uo pipefail

# revalidate-dist-locally.sh — run ONLY scripts/ci/assert-dist-complete.mjs
# against the artifacts of a past deploy run, on your own machine.
#
# The local twin of .github/workflows/revalidate-dist-from-run.yml. Same input
# (a deploy run id), same rehydrate sequence, same single gate, no audits. Use
# it when you want the verdict without spending a runner, or when you want to
# poke at the rehydrated dist/ afterwards.
#
#   bash scripts/ci/revalidate-dist-locally.sh <deploy_run_id> [--full|--sample=N]
#
# Output: a report directory holding the gate's JSON, its console diagnostic,
# the rehydrate logs, and `missing-urls.json` — EVERY URL with no page file
# behind it, not the 5-per-sitemap sample the console prints. On a sampled
# failure the exhaustive pass is re-run automatically against the dist already
# on disk, so one invocation yields the whole work list.
#
# ── READ THIS FIRST: disk ────────────────────────────────────────────────────
# A complete rehydrated dist/ is roughly 27 GB, plus a ~1.8 GB trunk tarball
# and its extraction, plus the per-shard tar downloads before they are
# unpacked. GitHub's own runners free ~25 GB of preinstalled SDKs before
# attempting it. This script therefore REFUSES to start unless the working
# filesystem has REVALIDATE_MIN_FREE_GB (default 40) available, because the
# failure mode of running anyway is not a clean error: it is a half-extracted
# tree that makes the gate report absent subtrees as a defect of the SITE —
# the exact wrong-root-cause the gate exists to prevent (issue #4857).
#
# On a machine that cannot spare 40 GB, use the workflow instead:
#   gh workflow run revalidate-dist-from-run.yml -f deploy_run_id=<id>
#
# ── Environment ──────────────────────────────────────────────────────────────
#   REVALIDATE_MIN_FREE_GB      GiB that must be free to proceed. Default 40.
#                               Lower it ONLY if you know the deploy you are
#                               replaying is smaller than the numbers above.
#   REVALIDATE_WORKDIR          Where dist/ and the downloads go.
#                               Default: $TMPDIR/revalidate-dist-<run id>.
#   REVALIDATE_REPO             owner/repo holding the run.
#                               Default: valerielinc-ops/frontaliere-si-o-no.
#   REVALIDATE_ALLOW_SHARD_CLONE
#                               1 = allow the rehydrate scripts to fall back to
#                               `git clone` of a shard repo when that run's
#                               shard artifacts have expired. Default 0, which
#                               makes this script refuse up front instead:
#                               those repos are 20-26 GB each and CLAUDE.md
#                               forbids cloning them on this machine.
#   REVALIDATE_KEEP             1 = keep the working dir on exit (default 0,
#                               it is deleted so 30 GB does not linger).
#
# Requires: gh (authenticated), git, jq, tar, node >= 20, unzip not needed.

die() { echo "ERROR: $*" >&2; exit 1; }
note() { echo "  $*"; }

# ── Arguments ────────────────────────────────────────────────────────────────
RUN_ID=""
SAMPLE=""
FULL=0
for arg in "$@"; do
  case "$arg" in
    --full) FULL=1 ;;
    --sample=*) SAMPLE="${arg#--sample=}" ;;
    -h|--help)
      sed -n '3,45p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*) die "unknown option: $arg" ;;
    *)
      [ -n "$RUN_ID" ] && die "unexpected extra argument: $arg"
      RUN_ID="$arg" ;;
  esac
done
[ -n "$RUN_ID" ] || die "usage: bash scripts/ci/revalidate-dist-locally.sh <deploy_run_id> [--full|--sample=N]"
case "$RUN_ID" in
  ''|*[!0-9]*) die "deploy_run_id must be numeric, got: $RUN_ID" ;;
esac
if [ -n "$SAMPLE" ]; then
  case "$SAMPLE" in
    ''|*[!0-9]*) die "--sample must be a positive integer, got: $SAMPLE" ;;
  esac
fi

REPO="${REVALIDATE_REPO:-valerielinc-ops/frontaliere-si-o-no}"
MIN_FREE_GB="${REVALIDATE_MIN_FREE_GB:-40}"
ALLOW_CLONE="${REVALIDATE_ALLOW_SHARD_CLONE:-0}"
KEEP="${REVALIDATE_KEEP:-0}"

# Repo root = two levels up from scripts/ci/. Resolved from the script's own
# location so the command works from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
[ -f "$REPO_ROOT/scripts/lib/rehydrate-locale-shards.sh" ] \
  || die "cannot locate the repo root from $SCRIPT_DIR (expected scripts/lib/rehydrate-locale-shards.sh under $REPO_ROOT)"

BASE_TMP="${TMPDIR:-/tmp}"
BASE_TMP="${BASE_TMP%/}"
WORKDIR="${REVALIDATE_WORKDIR:-$BASE_TMP/revalidate-dist-$RUN_ID}"

# ── Preflight: the working dir is safe to `rm -rf` ───────────────────────────
# It is wiped on entry and (by default) on exit, and it is user-supplied via
# REVALIDATE_WORKDIR. Checked here, before anything is downloaded, so a typo
# costs nothing. Refuse anything that is not clearly a scratch path: absolute,
# at least two levels deep, not an ancestor of the repo, and either absent,
# empty, or already one of ours.
case "$WORKDIR" in
  /*) ;;
  *) die "REVALIDATE_WORKDIR must be an absolute path, got: $WORKDIR" ;;
esac
[ "$(dirname "$WORKDIR")" != "/" ] || die "refusing to use a top-level directory as REVALIDATE_WORKDIR: $WORKDIR"
case "$REPO_ROOT/" in
  "$WORKDIR"/*) die "REVALIDATE_WORKDIR ($WORKDIR) contains the repo — refusing to delete it" ;;
esac
if [ -e "$WORKDIR" ]; then
  [ -d "$WORKDIR" ] || die "REVALIDATE_WORKDIR exists and is not a directory: $WORKDIR"
  if [ -n "$(ls -A "$WORKDIR" 2>/dev/null)" ] && [ ! -e "$WORKDIR/.revalidate-dist-workdir" ]; then
    die "REVALIDATE_WORKDIR ($WORKDIR) is not empty and was not created by this script — refusing to delete it. Point REVALIDATE_WORKDIR at a fresh path."
  fi
fi

# ── Preflight: tools ─────────────────────────────────────────────────────────
for tool in gh git jq tar node; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required but not on PATH"
done
gh auth status >/dev/null 2>&1 || die "gh is not authenticated — run: gh auth login"

# ── Preflight: disk, BEFORE anything is downloaded ───────────────────────────
# `df -Pk` is the POSIX form: 1K blocks, available in field 4. Portable across
# macOS and Linux, unlike `df -h` output parsing or GNU's --output=avail.
free_gb_of() {
  local probe="$1"
  # Probe the nearest existing ancestor — the workdir itself may not exist yet.
  while [ ! -d "$probe" ] && [ "$probe" != "/" ]; do probe="$(dirname "$probe")"; done
  local kb
  kb="$(df -Pk "$probe" 2>/dev/null | awk 'NR==2 {print $4}')"
  [ -n "$kb" ] || return 1
  echo $(( kb / 1024 / 1024 ))
}

FREE_GB="$(free_gb_of "$WORKDIR")" || die "could not read free space for $WORKDIR"
echo "Disk check"
note "working dir : $WORKDIR"
note "free        : ${FREE_GB} GiB"
note "required    : ${MIN_FREE_GB} GiB (REVALIDATE_MIN_FREE_GB)"
if [ "$FREE_GB" -lt "$MIN_FREE_GB" ]; then
  cat >&2 <<EOF

REFUSING TO RUN — not enough free disk space.

  free      : ${FREE_GB} GiB on the filesystem holding $WORKDIR
  required  : ${MIN_FREE_GB} GiB

A complete rehydrated dist/ is ~27 GB, on top of a ~1.8 GB trunk tarball, its
extraction, and the shard tars downloaded before they are unpacked. Running
under that budget does not fail cleanly: it leaves a partial tree, and every
dist-walking check then reports the missing subtrees as a defect of the SITE
instead of a hole in its own input.

What to do instead:
  • Run it on a runner, which frees ~25 GB before extracting:
      gh workflow run revalidate-dist-from-run.yml -R $REPO -f deploy_run_id=$RUN_ID
  • Or point the working dir at a volume that has room:
      REVALIDATE_WORKDIR=/Volumes/big/revalidate bash $0 $RUN_ID
  • Or, if you have measured this particular deploy and know it is smaller,
    lower the bar deliberately:
      REVALIDATE_MIN_FREE_GB=<n> bash $0 $RUN_ID
EOF
  exit 1
fi

# ── Preflight: are the artifacts still there? ────────────────────────────────
echo
echo "Checking artifacts on run $RUN_ID of $REPO"
ARTIFACTS="$(gh api "repos/$REPO/actions/runs/$RUN_ID/artifacts" --paginate --jq '.artifacts[] | select(.expired | not) | .name' 2>/dev/null)" \
  || die "cannot read artifacts for run $RUN_ID (wrong id, wrong repo, or no access)"
[ -n "$ARTIFACTS" ] || die "run $RUN_ID has no unexpired artifacts left — nothing to replay"

grep -qx 'github-pages' <<<"$ARTIFACTS" \
  || die "run $RUN_ID has no unexpired 'github-pages' artifact — it is not a deploy/build run, or its artifacts have expired"

# The rehydrate scripts silently fall back to `git clone` of the shard repo
# when a shard artifact is missing. On a runner that is merely slow; here it is
# a 20-26 GB clone that CLAUDE.md forbids. Detect it up front.
MISSING_SHARD_ARTIFACTS=""
for loc in en de fr; do
  grep -qx "locale-dist-$loc-$RUN_ID" <<<"$ARTIFACTS" \
    || MISSING_SHARD_ARTIFACTS="$MISSING_SHARD_ARTIFACTS locale-dist-$loc"
done
for batch in $(jq -r '[to_entries[] | select(.key | startswith("_") | not) | .value] | unique[]' \
                 "$REPO_ROOT/scripts/lib/section-shard-batches.json"); do
  for loc in it en de fr; do
    grep -qx "shard-batch-$batch-dist-$loc-$RUN_ID" <<<"$ARTIFACTS" \
      || MISSING_SHARD_ARTIFACTS="$MISSING_SHARD_ARTIFACTS shard-batch-$batch-dist-$loc"
  done
done

if [ -n "$MISSING_SHARD_ARTIFACTS" ]; then
  echo "  missing/expired shard artifacts:$MISSING_SHARD_ARTIFACTS" >&2
  if [ "$ALLOW_CLONE" != "1" ]; then
    cat >&2 <<EOF

REFUSING TO RUN — some shard artifacts of run $RUN_ID are gone.

Without them the rehydrate scripts fall back to \`git clone\` of the
frontaliere-<section>-<locale> shard repos. Those are 20-26 GB each and
CLAUDE.md forbids cloning them on this machine.

  • Replay a MORE RECENT deploy run whose artifacts have not expired, or
  • run it on a runner:
      gh workflow run revalidate-dist-from-run.yml -R $REPO -f deploy_run_id=$RUN_ID
  • or, if you really mean to clone (and have the disk):
      REVALIDATE_ALLOW_SHARD_CLONE=1 bash $0 $RUN_ID
EOF
    exit 1
  fi
  echo "  REVALIDATE_ALLOW_SHARD_CLONE=1 — proceeding, shard repos WILL be cloned" >&2
fi
note "artifacts present"

# ── Staging layout ───────────────────────────────────────────────────────────
# The rehydrate scripts address `dist/` and `scripts/lib/*.json` RELATIVE to
# cwd. Rather than write a 27 GB dist/ into the working copy, stage a directory
# that contains a real dist/ and a SYMLINK to the repo's scripts/. cwd there
# satisfies both lookups and the repo tree is never touched.
STAGE="$WORKDIR/stage"
cleanup() {
  if [ "$KEEP" = "1" ]; then
    echo
    echo "Kept working dir (REVALIDATE_KEEP=1): $WORKDIR"
    echo "  rehydrated dist/: $STAGE/dist"
  else
    rm -rf "$WORKDIR"
  fi
}
trap cleanup EXIT

rm -rf "$WORKDIR"
mkdir -p "$STAGE" "$WORKDIR/runner-temp" "$WORKDIR/report" "$WORKDIR/download"
touch "$WORKDIR/.revalidate-dist-workdir"
ln -s "$REPO_ROOT/scripts" "$STAGE/scripts"

# ── Trunk artifact ───────────────────────────────────────────────────────────
echo
echo "Downloading github-pages artifact (the trunk dist tarball)"
gh run download "$RUN_ID" -R "$REPO" --name github-pages --dir "$WORKDIR/download/pages" \
  || die "download of the github-pages artifact failed"
[ -f "$WORKDIR/download/pages/artifact.tar" ] \
  || die "expected $WORKDIR/download/pages/artifact.tar — saw: $(ls "$WORKDIR/download/pages")"

echo "Extracting dist/"
mkdir -p "$STAGE/dist"
tar -xf "$WORKDIR/download/pages/artifact.tar" -C "$STAGE/dist" \
  || die "extraction of artifact.tar failed"
rm -f "$WORKDIR/download/pages/artifact.tar"
note "trunk restored: $(find "$STAGE/dist" -type f | wc -l | tr -d ' ') files"

# ── Shard live flags ─────────────────────────────────────────────────────────
# Read the repo's own Actions variables so the local run rehydrates exactly the
# shards CI does. Reading them needs collaborator access; if it fails, fall
# back to "assume every section is live". That fallback is safe in the only
# direction that matters: rehydrate_section skips any subtree already present
# and complete in the trunk, so a section that is NOT live is a no-op rather
# than a wrong rehydrate.
echo
echo "Resolving *_SHARD_LIVE repo variables"
VARS_JSON="$(gh api "repos/$REPO/actions/variables" --paginate --jq '[.variables[] | select(.name | test("_SHARDS?_LIVE$")) | {(.name): .value}] | add' 2>/dev/null)"
if [ -z "$VARS_JSON" ] || [ "$VARS_JSON" = "null" ]; then
  echo "  could not read repo variables (needs collaborator access) — assuming every shard is live" >&2
  export LOCALE_SHARDS_LIVE=true
  for section in $(jq -r 'keys[] | select(startswith("_")|not)' "$REPO_ROOT/scripts/lib/section-shard-slugs.json"); do
    export "$(echo "$section" | tr 'a-z' 'A-Z')_SHARD_LIVE=true"
  done
else
  # `@sh` quotes each value, so a variable value can never be read as script.
  eval "$(jq -r 'to_entries[] | "export \(.key)=\(.value | @sh)"' <<<"$VARS_JSON")"
  note "$(jq -r 'to_entries | map(select(.value == "true")) | length' <<<"$VARS_JSON") of $(jq -r 'length' <<<"$VARS_JSON") shard variables are live"
  # Any section in the SSOT with no variable at all would silently not be
  # rehydrated — name it rather than let the gate blame the site for it.
  for section in $(jq -r 'keys[] | select(startswith("_")|not)' "$REPO_ROOT/scripts/lib/section-shard-slugs.json"); do
    live_var="$(echo "$section" | tr 'a-z' 'A-Z')_SHARD_LIVE"
    if [ -z "${!live_var+set}" ]; then
      echo "  note: no repo variable $live_var — section '$section' is treated as not live" >&2
    fi
  done
fi

# ── Rehydrate ────────────────────────────────────────────────────────────────
# Same order and same failure contract as post-deploy-validate-dist.yml: locale
# first and hard-fail, sections strictly after it and soft-fail. Sections must
# not run concurrently with the locale pass — rehydrate_section writes into
# dist/$loc/<section>, nested inside the subtree rehydrate_locale wipes.
echo
echo "Rehydrating locale then section shards into dist/"
export GH_TOKEN="${GH_TOKEN:-$(gh auth token 2>/dev/null || true)}"
export DEPLOY_RUN_ID="$RUN_ID"
export RUNNER_TEMP="$WORKDIR/runner-temp"
export SHARD_CLONE_CACHE_DIR="$WORKDIR/shard-clone-cache"
export GH_REPO="$REPO"   # so the scripts' bare `gh run download` targets this repo

LOCALE_RC=0
( cd "$STAGE" && bash "$REPO_ROOT/scripts/lib/rehydrate-locale-shards.sh" ) 2>&1 \
  | tee "$WORKDIR/report/rehydrate-locale.log"
LOCALE_RC=${PIPESTATUS[0]}

( cd "$STAGE" && bash "$REPO_ROOT/scripts/lib/rehydrate-section-shards.sh" ) 2>&1 \
  | tee "$WORKDIR/report/rehydrate-sections.log"

note "dist/ now holds $(find "$STAGE/dist" -type f | wc -l | tr -d ' ') files"

if [ "$LOCALE_RC" -ne 0 ]; then
  echo "ERROR: locale rehydrate failed (rc=$LOCALE_RC) — the gate below would be measuring its own hole, not the site." >&2
  exit "$LOCALE_RC"
fi

# ── The gate ─────────────────────────────────────────────────────────────────
# Two flags are passed for "check everything", on purpose: `--full` is the
# script's own, and `--sample=100000000` expresses the same thing through
# --sample (sampleEvenly() returns the whole list once the requested count
# reaches its length). Either alone is enough for the current script; both
# together also do the right thing against a checkout that predates `--full`,
# which would otherwise silently fall back to a 40-URL sample. Unknown flags
# are ignored by its arg parser. assert-dist-complete.mjs is not modified.
OUT="$WORKDIR/report/assert-dist-complete.json"
ERR="$WORKDIR/report/assert-dist-complete.txt"
REPORT="$WORKDIR/report/missing-urls.json"

ARGS=(--json "--dist=$STAGE/dist" "--report=$REPORT")
if [ "$FULL" = "1" ]; then
  echo
  echo "Running the completeness gate — FULL (every sitemap URL)"
  ARGS+=(--full --sample=100000000)
elif [ -n "$SAMPLE" ]; then
  echo
  echo "Running the completeness gate — sample $SAMPLE URLs per sitemap"
  ARGS+=("--sample=$SAMPLE")
else
  echo
  echo "Running the completeness gate — sample (script default, 40 per sitemap)"
fi

RC=0
NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}" \
  node "$REPO_ROOT/scripts/ci/assert-dist-complete.mjs" "${ARGS[@]}" > "$OUT" 2> "$ERR" || RC=$?
cat "$ERR"

# A sampled failure names at most 5 URLs per sitemap. dist/ is already
# rehydrated, so the exhaustive pass is just a second walk of a tree already
# paid for — do it here rather than make the caller spend another rehydrate.
if [ "$RC" -ne 0 ] && [ "$FULL" != "1" ]; then
  echo
  echo "Gate failed on a sample — re-running FULL against the same rehydrated dist/"
  echo "to produce the complete offender list (no re-download, no re-rehydrate)."
  NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}" \
    node "$REPO_ROOT/scripts/ci/assert-dist-complete.mjs" \
      --json --full --sample=100000000 "--dist=$STAGE/dist" "--report=$REPORT" \
      > "$WORKDIR/report/assert-dist-complete-full.json" \
      2> "$WORKDIR/report/assert-dist-complete-full.txt" || true
  tail -60 "$WORKDIR/report/assert-dist-complete-full.txt"
fi

echo
if [ -s "$OUT" ] && jq -e . "$OUT" >/dev/null 2>&1; then
  jq -r 'if .ok then "PASS — dist/ looks complete" else "INCONCLUSIVE — dist/ is not the complete logical site" end,
         "sampled \(.sampledTotal) sitemap URLs, \(.missingTotal) missing (\(.overallMissingPct)%)"' "$OUT"
  jq -r '.failures[]? | "  \(.name): \(.missing)/\(.sampled) missing (\(.missingPct)%)", (.examples[] | "      " + .)' "$OUT"
fi
if [ -s "$REPORT" ] && jq -e . "$REPORT" >/dev/null 2>&1; then
  echo
  jq -r '"Complete offender list (mode \(.mode)): \(.missingTotal) URL(s) with no page file."' "$REPORT"
  jq -r '.missingBySitemap // {} | to_entries[] | "  \(.key): \(.value.missing) of \(.value.total) missing"' "$REPORT"
elif [ "$RC" -ne 0 ]; then
  echo
  echo "NOTE: no missing-urls.json was produced — this checkout of"
  echo "assert-dist-complete.mjs predates its --report= flag, so the URL lists"
  echo "above are capped at 5 examples per sitemap."
fi
echo
echo "Report written to:"
echo "  $OUT"
echo "  $ERR"
[ -s "$REPORT" ] && echo "  $REPORT   <- every missing URL, in full"
echo "  $WORKDIR/report/rehydrate-*.log"
if [ "$KEEP" != "1" ]; then
  # The report is inside the dir the trap is about to delete — copy it out.
  KEEP_DIR="$BASE_TMP/revalidate-dist-report-$RUN_ID"
  rm -rf "$KEEP_DIR"
  mkdir -p "$KEEP_DIR"
  cp -R "$WORKDIR/report/." "$KEEP_DIR/" 2>/dev/null || true
  echo
  echo "Working dir will be deleted; the report was copied to:"
  echo "  $KEEP_DIR"
  echo "(set REVALIDATE_KEEP=1 to keep the rehydrated dist/ for inspection)"
fi

exit "$RC"
