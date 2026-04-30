#!/usr/bin/env node
/**
 * In-place rebase resolver for `data/previous-slug-winners.json`.
 *
 * The Sync step in deploy.yml runs `git push origin HEAD:main`. If another
 * deploy committed a new winners file in between (concurrent dispatch +
 * `cancel-in-progress: false` queues both), the rebase inside
 * `scripts/lib/git-push-with-retry.sh` fails with a content conflict on this
 * file. Rebase has no idea how to merge a sorted JSON object, so without a
 * resolver we abort and fail the deploy (run 25159195858 was exactly this).
 *
 * Resolution semantics: union by key, OURS wins on collision. Reason: the
 * registry is purely derived state. Each build computes a winner per
 * `(locale, oldSlug)` from the current jobs.json + the prior file. Our
 * commit's entries reflect the freshest computation; their commit's entries
 * may include keys for jobs we don't have in our snapshot (e.g. crawler
 * cron pushed a new job after we read jobs.json) and we want to preserve
 * those rather than drop them.
 *
 * Same shape as `resolve-append-conflicts.sh` (the article generator's
 * resolver): runs INSIDE the rebase, leaves the file resolved + staged, then
 * `git rebase --continue` closes the cycle. No abort, no human intervention.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TARGET = 'data/previous-slug-winners.json';

function readStage(stage) {
  // `git show :<stage>:<path>` reads the indexed version. IMPORTANT: during
  // `git rebase` the meaning of stage 2/3 is INVERTED relative to merge:
  //   - stage 2 = "ours" = the rebase base (the upstream commit we replay onto)
  //   - stage 3 = "theirs" = the commit being applied (our local sync commit)
  // So in this resolver:
  //   - stage 2 → upstream `data/previous-slug-winners.json` (the file as it
  //     exists on origin/main after the other deploy's sync commit landed)
  //   - stage 3 → our build's freshly computed file (the commit we are about
  //     to push). We want this version's keys to win on collision.
  const out = execFileSync('git', ['show', `:${stage}:${TARGET}`], { encoding: 'utf-8' });
  return out;
}

function parseOrEmpty(label, raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    process.stderr.write(`[resolve-winners] ${label} version is not a JSON object; treating as empty\n`);
    return {};
  } catch (err) {
    process.stderr.write(`[resolve-winners] ${label} JSON parse failed: ${err.message}\n`);
    return {};
  }
}

const conflicted = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], { encoding: 'utf-8' })
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

if (!conflicted.includes(TARGET)) {
  // No conflict on our target — nothing to do. The git-push-with-retry
  // helper will continue with whatever other staged resolution exists.
  process.stdout.write(`[resolve-winners] no conflict on ${TARGET}\n`);
  process.exit(0);
}

if (conflicted.length > 1) {
  // Sync step only commits one file by design. Any other conflicted path
  // is unexpected — surface it instead of silently merging.
  process.stderr.write(
    `[resolve-winners] unexpected conflicted files: ${conflicted.filter((f) => f !== TARGET).join(', ')}\n`,
  );
  process.exit(1);
}

// During rebase: stage 2 = upstream (the file on origin/main), stage 3 =
// our local commit (the freshly computed file being replayed). See readStage.
const upstream = parseOrEmpty('upstream', readStage(2));
const local = parseOrEmpty('local', readStage(3));

// Union: start from upstream, overlay local (freshest compute wins on collision).
// Result is sorted on write to match `saveWinners()` in services/previousSlugWinners.ts.
const merged = { ...upstream };
let localOverlay = 0;
for (const [key, val] of Object.entries(local)) {
  if (!(key in merged)) merged[key] = val;
  else {
    merged[key] = val;
    localOverlay += 1;
  }
}

const sorted = {};
for (const k of Object.keys(merged).sort()) sorted[k] = merged[k];

const outPath = path.resolve(process.cwd(), TARGET);
fs.writeFileSync(outPath, JSON.stringify(sorted, null, 2) + '\n', 'utf-8');

process.stdout.write(
  `[resolve-winners] merged ${Object.keys(upstream).length} upstream + ${Object.keys(local).length} local → ${Object.keys(sorted).length} keys (${localOverlay} local-overlays win)\n`,
);

// Stage the resolved file. The caller still runs `git add -A` after this
// command per the helper's --in-place-resolver-cmd contract; staging here
// is belt-and-suspenders so a partial caller invocation still works.
execFileSync('git', ['add', TARGET]);
