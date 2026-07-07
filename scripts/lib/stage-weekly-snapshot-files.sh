#!/usr/bin/env bash
# Shared staging logic for the "Snapshot Jobs Weekly (F5)" commit step
# (.github/workflows/snapshot-jobs-weekly.yml) — used identically by BOTH the
# main commit step and its git-push-with-retry.sh --regenerate-cmd rebase
# regeneration, so the two never drift out of sync (AGENTS.md sibling-pattern
# rule: one shared module instead of copy-pasted staging logic).
#
# Fixes issue #3663: the workflow used to run a SINGLE combined
# assert-file-size-ceiling.mjs check over BOTH related-search files, under
# `set -euo pipefail` with no `|| true`. When
# data/related-search-candidates.json organically outgrew its ceiling (canton-
# wide crawler expansion; pruning is explicitly owner-gated — see #1658), the
# ceiling check aborted the ENTIRE commit step, silently dropping the
# unrelated data/jobs-snapshots-history/, weekly-employers-delta.json, and
# weekly-employers-top-pairs.json commits too — a data-refresh workflow
# failing on a completely unrelated concern.
#
# This script decouples the two: the core weekly-snapshot files ALWAYS stage
# regardless of related-search file size; each related-search file is checked
# and staged INDIVIDUALLY, so an oversize related-search-candidates.json no
# longer blocks staging the (still ceiling-compliant) related-search-
# enriched.json, or the unrelated core files. Never exits non-zero — an
# oversize file is skipped (warned, not staged) rather than failing the step.
set -uo pipefail

# Core weekly-snapshot files — never gated on related-search file size.
git add data/jobs-snapshots-history/ data/weekly-employers-delta.json data/weekly-employers-top-pairs.json 2>/dev/null || true

# Related-search corpus files — gated on their OWN push-safety ceiling
# (#1576/#1658), checked one file at a time so one oversize file never blocks
# staging its sibling.
for f in data/related-search-enriched.json data/related-search-candidates.json; do
  [ -f "$f" ] || continue
  if node scripts/lib/assert-file-size-ceiling.mjs "$f"; then
    git add "$f" 2>/dev/null || true
  else
    echo "::warning::Skipping stage of $f this run — over its push-safety ceiling (#1658, owner-gated prune required). Core snapshot/delta/footer files still commit normally."
  fi
done
