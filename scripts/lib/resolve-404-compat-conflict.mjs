#!/usr/bin/env node
/**
 * In-place rebase resolver for `data/seo-404-compat-paths.json`.
 *
 * Why this exists: discover-404s.yml is not the only workflow that writes
 * this file. sync-gsc-orphans.yml (and a few scripts: backfill-slug-aliases,
 * mine-all-job-slugs, enrich-compat-orphan-slugs) also append/remove paths.
 * When two workflows push back-to-back the rebase inside
 * `scripts/lib/git-push-with-retry.sh` hits a content conflict on the
 * `paths` array — run 25716042219 was exactly this. Git has no built-in way
 * to merge a JSON array, so the helper aborted with "no resolver provided".
 *
 * Resolution semantics: 3-way set merge on `paths`.
 *
 *   final = upstream ∪ (local − base) − (base − local)
 *
 *   - paths the local commit ADDED (in local but not in base) are added on
 *     top of upstream → preserves our newly-discovered 404s.
 *   - paths the local commit REMOVED (in base but not in local) are removed
 *     from upstream → preserves our "URL recovered, drop from compat".
 *   - paths upstream added since base are kept → preserves sync-gsc-orphans'
 *     additions that we did not see when we read the file.
 *
 * Metadata fields (generatedAt / lastUpdated / source): take local's values
 * (this commit is the freshest write).
 *
 * Runs INSIDE the rebase (--in-place-resolver-cmd contract), leaves the
 * file resolved + staged. `git rebase --continue` then closes the cycle.
 * No abort, no human intervention.
 *
 * `data/inspection-state.json` is exclusively owned by
 * discover-404s-via-inspection.mjs — if it ever shows up as conflicted,
 * surface the fact instead of merging silently.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TARGET = 'data/seo-404-compat-paths.json';
const STATE_FILE = 'data/inspection-state.json';

function readStage(stage, file) {
  // During `git rebase`, stage 1 = base, stage 2 = "ours" (the rebase base,
  // i.e. upstream we replay onto), stage 3 = "theirs" (our local commit
  // being applied). See scripts/lib/resolve-winners-conflict.mjs for the
  // same inverted-meaning explanation.
  try {
    return execFileSync('git', ['show', `:${stage}:${file}`], { encoding: 'utf-8' });
  } catch {
    return null;
  }
}

function parseCompat(label, raw) {
  if (raw == null) return { paths: [] };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (!Array.isArray(parsed.paths)) parsed.paths = [];
      return parsed;
    }
    process.stderr.write(`[resolve-404-compat] ${label} not a JSON object; treating as empty\n`);
    return { paths: [] };
  } catch (err) {
    process.stderr.write(`[resolve-404-compat] ${label} JSON parse failed: ${err.message}\n`);
    return { paths: [] };
  }
}

const conflicted = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], { encoding: 'utf-8' })
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

if (conflicted.includes(STATE_FILE)) {
  process.stderr.write(
    `[resolve-404-compat] unexpected conflict on ${STATE_FILE} — this file is single-writer; aborting\n`,
  );
  process.exit(1);
}

if (!conflicted.includes(TARGET)) {
  process.stdout.write(`[resolve-404-compat] no conflict on ${TARGET}\n`);
  process.exit(0);
}

const otherConflicts = conflicted.filter((f) => f !== TARGET);
if (otherConflicts.length > 0) {
  process.stderr.write(
    `[resolve-404-compat] unexpected conflicted files alongside ${TARGET}: ${otherConflicts.join(', ')}\n`,
  );
  process.exit(1);
}

const base = parseCompat('base', readStage(1, TARGET));
const upstream = parseCompat('upstream', readStage(2, TARGET));
const local = parseCompat('local', readStage(3, TARGET));

const baseSet = new Set(base.paths);
const upstreamSet = new Set(upstream.paths);
const localSet = new Set(local.paths);

const added = [...localSet].filter((p) => !baseSet.has(p));
const removed = [...baseSet].filter((p) => !localSet.has(p));

const finalSet = new Set(upstreamSet);
for (const p of added) finalSet.add(p);
for (const p of removed) finalSet.delete(p);

const merged = {
  ...upstream,
  ...local,
  paths: [...finalSet].sort(),
};
if (local.lastUpdated || upstream.lastUpdated) {
  merged.lastUpdated = local.lastUpdated || upstream.lastUpdated;
}
if (local.generatedAt) merged.generatedAt = local.generatedAt;

const outPath = path.resolve(process.cwd(), TARGET);
fs.writeFileSync(outPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');

process.stdout.write(
  `[resolve-404-compat] base=${baseSet.size} upstream=${upstreamSet.size} local=${localSet.size} ` +
    `→ +${added.length} added, -${removed.length} removed = ${finalSet.size} final\n`,
);

execFileSync('git', ['add', TARGET]);
