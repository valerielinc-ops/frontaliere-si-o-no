#!/usr/bin/env node
/**
 * Audit script: scan every per-crawler slice file's git history within a
 * sliding window and emit a list of jobs whose previousSlugs entries were
 * silently dropped between commits.
 *
 * Use this to:
 *   - Confirm the writer fix (commit 5865d8286f) is holding (loss count
 *     should not grow on new commits).
 *   - Feed the output JSON into scripts/backfill-prev-slugs-from-loss-events.mjs
 *     when a new wave of losses is detected.
 *
 * Methodology:
 *   For each slice file, walk every commit that touched it in the window.
 *   For each commit, parse the file at that commit and at its previous
 *   version. A "loss" = a slug that was in the prior version's
 *   {active, previousSlugs, previousSlugsByLocale} for a given job but is
 *   absent from the after version's {active, previousSlugs, previousSlugsByLocale}.
 *   Cross-reference with the current working-tree slice to compute
 *   "still recoverable" (i.e. losses not yet healed by later runs).
 *
 * Jobs are diffed by resolveJobDiffKey() (scripts/lib/job-match-key.mjs),
 * not bare `.id` — several dedicated crawlers commit slices where `.id` is
 * never stamped (see #3411), and a Map keyed on bare `.id` would collapse
 * every such job onto the same `undefined` key.
 *
 * Usage:
 *   node scripts/scan-prev-slug-losses.mjs [--since "60 days ago"] [--out /tmp/recoverable-slugs.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveJobDiffKey } from './lib/job-match-key.mjs';
import { denylistKey, loadRestoreDenylist } from './backfill-prev-slugs-from-loss-events.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIR = 'data/jobs/by-crawler';
const ABS_DIR = path.join(ROOT, DIR);

/**
 * Diff two versions of a slice file's `jobs` array and return, for every job
 * present in both, the slugs that were in `prevJobs`' before-state but are
 * absent from `curJobs`' after-state. Jobs are matched via
 * resolveJobDiffKey() so id-less jobs fall back to a stable URL/slug key
 * instead of colliding under `undefined`.
 *
 * Pure function — no I/O — so it's directly unit-testable.
 *
 * @param {Array<object>} prevJobs
 * @param {Array<object>} curJobs
 * @returns {Array<{ jobKey: string, lost: string[] }>}
 */
export function diffJobSlices(prevJobs, curJobs) {
  const results = [];
  if (!Array.isArray(prevJobs) || !Array.isArray(curJobs)) return results;

  const byKey = new Map();
  for (const j of prevJobs) {
    const key = resolveJobDiffKey(j);
    if (key) byKey.set(key, j);
  }

  for (const aj of curJobs) {
    const key = resolveJobDiffKey(aj);
    if (!key) continue;
    const bj = byKey.get(key);
    if (!bj) continue;

    const beforeAll = new Set();
    if (Array.isArray(bj.previousSlugs)) for (const s of bj.previousSlugs) if (s) beforeAll.add(s);
    if (bj.previousSlugsByLocale) for (const a of Object.values(bj.previousSlugsByLocale))
      for (const s of (a || [])) if (s) beforeAll.add(s);
    if (bj.slug) beforeAll.add(bj.slug);
    if (bj.slugByLocale) for (const s of Object.values(bj.slugByLocale)) if (s) beforeAll.add(s);

    const afterActive = new Set();
    if (aj.slug) afterActive.add(aj.slug);
    if (aj.slugByLocale) for (const s of Object.values(aj.slugByLocale)) if (s) afterActive.add(s);

    const afterPrev = new Set();
    if (Array.isArray(aj.previousSlugs)) for (const s of aj.previousSlugs) if (s) afterPrev.add(s);
    if (aj.previousSlugsByLocale) for (const a of Object.values(aj.previousSlugsByLocale))
      for (const s of (a || [])) if (s) afterPrev.add(s);

    const lost = [...beforeAll].filter(s => !afterActive.has(s) && !afterPrev.has(s));
    if (lost.length === 0) continue;
    results.push({ jobKey: key, lost });
  }

  return results;
}

function main() {
  const args = process.argv.slice(2);
  const sinceIdx = args.indexOf('--since');
  const SINCE = sinceIdx !== -1 ? args[sinceIdx + 1] : '60 days ago';
  const outIdx = args.indexOf('--out');
  const OUT = outIdx !== -1 ? args[outIdx + 1] : '/tmp/recoverable-slugs.json';
  const eventsIdx = args.indexOf('--events-out');
  const EVENTS_OUT = eventsIdx !== -1 ? args[eventsIdx + 1] : '/tmp/prev-slug-loss-events.jsonl';

  const slices = execSync(`ls ${ABS_DIR}/*.json`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  process.stderr.write(`Scanning ${slices.length} slice files since "${SINCE}"…\n`);

  const lossesByJob = new Map();
  const lossesByFile = new Map();
  const lossEvents = [];

  // Slugs REMOVED ON PURPOSE by decontamination passes (see
  // data/prev-slug-restore-denylist.json) must not count as losses: they
  // would trip the writer-regression wire on every decontamination commit
  // and feed the backfill the exact poison the decontamination deleted
  // (issue #4061 / recovery run 29106416912). The backfill has its own
  // guard too — this keeps the tripwire and the reports honest.
  const denylist = loadRestoreDenylist();
  let denylistedSkipped = 0;

  let fileIdx = 0;
  for (const file of slices) {
    fileIdx++;
    if (fileIdx % 25 === 0) process.stderr.write(`  ${fileIdx}/${slices.length}…\n`);
    const rel = path.relative(ROOT, file);
    let commits;
    try {
      commits = execSync(
        `git log --since="${SINCE}" --reverse --pretty=format:%H -- ${rel}`,
        { encoding: 'utf8', cwd: ROOT }
      ).trim().split('\n').filter(Boolean);
    } catch { continue; }
    if (commits.length === 0) continue;

    let prev = null;
    for (const commit of commits) {
      const res = spawnSync('git', ['show', `${commit}:${rel}`],
        { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, cwd: ROOT });
      if (res.status !== 0) continue;
      let cur;
      try { cur = JSON.parse(res.stdout); } catch { continue; }
      if (!cur?.jobs) continue;
      if (prev && Array.isArray(prev.jobs)) {
        const fileBase = file.replace(`${ABS_DIR}/`, '');
        for (const { jobKey, lost } of diffJobSlices(prev.jobs, cur.jobs)) {
          const kept = lost.filter((s) => !denylist.has(denylistKey(fileBase, s)));
          denylistedSkipped += lost.length - kept.length;
          if (kept.length === 0) continue;
          lossEvents.push({ commit: commit.slice(0, 10), file: fileBase, jobId: jobKey, lost: kept });
          lossesByFile.set(file, (lossesByFile.get(file) || 0) + kept.length);
          if (!lossesByJob.has(jobKey)) lossesByJob.set(jobKey, { slugs: new Set(), file });
          for (const s of kept) lossesByJob.get(jobKey).slugs.add(s);
        }
      }
      prev = cur;
    }
  }

  const totalLost = [...lossesByJob.values()].reduce((n, x) => n + x.slugs.size, 0);
  console.log(JSON.stringify({
    since: SINCE,
    totalLost,
    denylistedSkipped,
    filesAffected: lossesByFile.size,
    jobsAffected: lossesByJob.size,
    eventsCount: lossEvents.length,
  }, null, 2));
  if (denylistedSkipped > 0) {
    console.log(`\n⛔ skipped ${denylistedSkipped} denylisted (intentional decontamination)`);
  }

  console.log('\nTOP 30 FILES BY LOST SLUGS:');
  for (const [f, n] of [...lossesByFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`  ${n.toString().padStart(5)}  ${f.replace(`${ABS_DIR}/`, '')}`);
  }

  // Cross-reference with current state: emit "recoverable" list (entries still missing today).
  const recoverable = [];
  let alreadyPresent = 0, deletedJobs = 0;
  for (const [jobKey, { file, slugs }] of lossesByJob.entries()) {
    if (!fs.existsSync(file)) { deletedJobs++; continue; }
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const j = d.jobs?.find(x => resolveJobDiffKey(x) === jobKey);
    if (!j) { deletedJobs++; continue; }
    const known = new Set([
      ...(Array.isArray(j.previousSlugs) ? j.previousSlugs : []),
      ...Object.values(j.previousSlugsByLocale || {}).flatMap(a => Array.isArray(a) ? a : []),
      j.slug,
      ...Object.values(j.slugByLocale || {}),
    ].filter(Boolean));
    const toRestore = [...slugs].filter(s => !known.has(s));
    if (toRestore.length === 0) { alreadyPresent++; continue; }
    recoverable.push({ jobId: jobKey, file: file.replace(`${ABS_DIR}/`, ''), slugs: toRestore });
  }

  fs.writeFileSync(EVENTS_OUT, lossEvents.map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(OUT, JSON.stringify(recoverable, null, 2));

  console.log('\nRECOVERABILITY:');
  console.log(`  already healed:       ${alreadyPresent}`);
  console.log(`  jobs no longer exist: ${deletedJobs}`);
  console.log(`  recoverable jobs:     ${recoverable.length}`);
  console.log(`  recoverable slugs:    ${recoverable.reduce((n, r) => n + r.slugs.length, 0)}`);
  console.log(`\nWrote:`);
  console.log(`  ${EVENTS_OUT}  (${lossEvents.length} loss events)`);
  console.log(`  ${OUT}  (input for scripts/backfill-prev-slugs-from-loss-events.mjs)`);
}

const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`
      || import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main();
}
