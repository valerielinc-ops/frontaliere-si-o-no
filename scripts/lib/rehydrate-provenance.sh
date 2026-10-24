#!/usr/bin/env bash
# Shared by rehydrate-locale-shards.sh and rehydrate-section-shards.sh.
#
# WHY. Both scripts are fail-soft: an artifact that is absent, expired or slow
# silently degrades to a `git clone` of the shard repo's main branch. Inside
# the publish run that is the same bytes (the shard was pushed minutes ago),
# but in a replay of an older build it is the shard of TODAY under the trunk,
# sitemaps and jobs dataset of THEN. Replays 39927368320/39952023039 audited
# exactly that mix — every en/de/fr subtree cloned because the shard artifacts
# live on the deploy-publish run, not the build run — and turned job pages
# that had simply expired since into "sitemap URL without HTML" failures.
#
# So every rehydrated subtree records where its bytes came from, and the
# caller decides whether a mixed tree may be audited at all
# (audit-dist-from-run.yml, step "Assert the rehydrated shards are coherent").
#
#   <subtree> \t <source> \t <ref>
#   source ∈ trunk | artifact | clone-cache | clone
#
# A no-op when REHYDRATE_PROVENANCE_FILE is unset.

rehydrate_provenance() {
  [ -n "${REHYDRATE_PROVENANCE_FILE:-}" ] || return 0
  # No fail-open: a row that cannot be written is a subtree whose origin the
  # coherence step would never see. Say it, and let the caller's contract
  # decide (the workflow fails on a missing or empty record).
  if ! printf '%s\t%s\t%s\n' "$1" "$2" "${3:-}" >> "$REHYDRATE_PROVENANCE_FILE"; then
    echo "::error::rehydrate provenance not recorded for $1 ($2) in $REHYDRATE_PROVENANCE_FILE"
    return 1
  fi
}

# Run that holds the en/de/fr shard artifacts. Locales can be published by
# different deploy-publish runs (publish receipts let a re-dispatch skip a
# locale that already went out), so a per-locale override wins over the
# shared SHARD_ARTIFACT_RUN_ID, which wins over the build run itself.
rehydrate_artifact_run_id() {
  local loc="$1" var
  var="SHARD_ARTIFACT_RUN_ID_$(printf '%s' "$loc" | tr '[:lower:]' '[:upper:]')"
  printf '%s\n' "${!var:-${SHARD_ARTIFACT_RUN_ID:-$DEPLOY_RUN_ID}}"
}
