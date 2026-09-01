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
 *   absent from the after version's {active, previousSlugs, previousSlugsByLocale}
 *   AND not explained by the documented per-locale/legacy cap (see
 *   diffJobSlices()'s classifyCapTrim() — routine LRU eviction of the
 *   oldest entries once an array exceeds its cap is not a loss).
 *   A historical alias removed from the wrong claimant is reported
 *   separately as safe cross-job decontamination only when its positive
 *   hash-owner is unique and stable across the parent/post snapshots and
 *   the exact route is reachable from that owner after the commit. Active
 *   routes, owner swaps, collisions and missing routes remain losses.
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
 *     [--events-out /tmp/loss-events.jsonl] [--safe-events-out /tmp/safe-cross-job-events.jsonl]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveJobDiffKey } from './lib/job-match-key.mjs';
import { denylistKey, loadRestoreDenylist } from './backfill-prev-slugs-from-loss-events.mjs';
import { DEFAULT_PREV_SLUG_CAP, LOCALES, stableSlugHash } from './lib/dedicated-crawler-common.mjs';
import { createCatFileBatch } from './lib/git-cat-file-batch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIR = 'data/jobs/by-crawler';
const EXPIRED_DIR = 'data/jobs/expired/by-crawler';
const ABS_DIR = path.join(ROOT, DIR);
const HASH_TAIL_RE = /-([a-z0-9]{6})$/;

function jobActiveSlugs(job) {
  return new Set([
    job?.slug,
    ...Object.values(job?.slugByLocale || {}),
  ].filter(Boolean));
}

function jobHistoricalSlugs(job) {
  return new Set([
    ...(Array.isArray(job?.previousSlugs) ? job.previousSlugs : []),
    ...Object.values(job?.previousSlugsByLocale || {})
      .flatMap((slugs) => Array.isArray(slugs) ? slugs : []),
  ].filter(Boolean));
}

function jobRouteSlugs(job) {
  return new Set([...jobActiveSlugs(job), ...jobHistoricalSlugs(job)]);
}

/**
 * Given a locale (or the flat legacy) previousSlugs array as it stood
 * before a commit and after it, split the slugs that disappeared into
 * "cap-explained" (consistent with addPreviousSlugForLocale/capSlugArray's
 * documented LRU eviction — not a bug) vs "unexplained" (a genuine
 * candidate for the silent-bypass regression this scanner exists to catch).
 *
 * Root cause of issue #4368 (and its 5 duplicate predecessors, #4226/
 * #4243/#4249/#4289/#4326): this scanner used a plain before/after set
 * diff with no notion of the cap, so it flagged routine, already-journaled
 * cap-trim (dedicated-crawler-common.mjs's capSlugArray keeps the newest
 * `cap` entries and evicts the oldest once an array exceeds it — see
 * scripts/lib/slug-history-journal.mjs's `cap-trim` action) as if it were
 * a code regression. Empirically confirmed against coop-ticino.json
 * (91% of a 48h sample's losses): per-locale arrays sat healthy at/under
 * cap while the flat legacy `previousSlugs` array — populated before the
 * per-locale migration and never itself pruned until touched — carried
 * 100+ entries against an 80-slot cap and shed its oldest entries the
 * first time each job was re-processed.
 *
 * A loss is cap-explained only when the before-array was already at/over
 * cap AND the number of slugs it lost is no more than the number of slugs
 * newly captured in the same commit (each new capture, once at cap, costs
 * exactly one eviction of the single oldest entry — never more). Losses
 * beyond that count cannot be explained by the cap alone and stay flagged.
 *
 * @param {string[]} beforeArr
 * @param {string[]} afterArr
 * @param {number} cap
 * @returns {{ explained: Set<string>, unexplained: string[] }}
 */
function classifyCapTrim(beforeArr, afterArr, cap) {
  const before = Array.isArray(beforeArr) ? beforeArr : [];
  const afterSet = new Set(Array.isArray(afterArr) ? afterArr : []);
  const beforeSet = new Set(before);
  const removed = before.filter(s => s && !afterSet.has(s)); // before-order: oldest first
  if (removed.length === 0) return { explained: new Set(), unexplained: [] };
  const added = [...afterSet].filter(s => s && !beforeSet.has(s)).length;
  const explainedCount = before.length >= cap ? Math.min(removed.length, added) : 0;
  return {
    explained: new Set(removed.slice(0, explainedCount)),
    unexplained: removed.slice(explainedCount),
  };
}

/**
 * Diff two versions of a slice file's `jobs` array and return, for every job
 * present in both, the slugs that were in `prevJobs`' before-state but are
 * absent from `curJobs`' after-state — excluding slugs whose disappearance
 * is fully explained by the documented per-locale/legacy cap (see
 * classifyCapTrim() above). Jobs are matched via resolveJobDiffKey() so
 * id-less jobs fall back to a stable URL/slug key instead of colliding
 * under `undefined`.
 *
 * Pure function — no I/O — so it's directly unit-testable.
 *
 * @param {Array<object>} prevJobs
 * @param {Array<object>} curJobs
 * @param {{ perLocaleCap?: number, locales?: string[] }} [opts]
 * @returns {Array<{ jobKey: string, lost: string[] }>}
 */
export function classifyJobSliceRemovals(prevJobs, curJobs, opts = {}) {
  const results = [];
  if (!Array.isArray(prevJobs) || !Array.isArray(curJobs)) return results;
  const perLocaleCap = opts.perLocaleCap ?? DEFAULT_PREV_SLUG_CAP;
  const locales = opts.locales ?? LOCALES;
  const legacyCap = perLocaleCap * locales.length;

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

    const beforeActive = jobActiveSlugs(bj);
    const beforeHistory = jobHistoricalSlugs(bj);
    const beforeAll = new Set([...beforeActive, ...beforeHistory]);
    const afterActive = jobActiveSlugs(aj);
    const afterPrev = jobHistoricalSlugs(aj);

    // Cap-explained slugs, across the flat legacy array and every
    // per-locale array — any of these disappearing is routine LRU
    // eviction, not a candidate loss.
    const capExplained = new Set();
    for (const s of classifyCapTrim(bj.previousSlugs, aj.previousSlugs, legacyCap).explained) capExplained.add(s);
    if (bj.previousSlugsByLocale) {
      for (const locale of Object.keys(bj.previousSlugsByLocale)) {
        const { explained } = classifyCapTrim(
          bj.previousSlugsByLocale[locale],
          aj.previousSlugsByLocale?.[locale],
          perLocaleCap,
        );
        for (const s of explained) capExplained.add(s);
      }
    }

    const lost = [...beforeAll].filter(s => !afterActive.has(s) && !afterPrev.has(s) && !capExplained.has(s));
    if (lost.length === 0) continue;
    results.push({
      jobKey: key,
      lost,
      // An active route disappearing is never decontamination. Only a route
      // carried exclusively as claimant history may qualify for the stronger
      // cross-job proof below.
      historicalLost: lost.filter((slug) => beforeHistory.has(slug) && !beforeActive.has(slug)),
    });
  }

  return results;
}

export function diffJobSlices(prevJobs, curJobs, opts = {}) {
  return classifyJobSliceRemovals(prevJobs, curJobs, opts)
    .map(({ jobKey, lost }) => ({ jobKey, lost }));
}

function buildRouteOwners(jobs) {
  const owners = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const ownerKey = resolveJobDiffKey(job);
    if (!ownerKey) continue;
    for (const slug of jobRouteSlugs(job)) {
      if (!owners.has(slug)) owners.set(slug, new Set());
      owners.get(slug).add(ownerKey);
    }
  }
  return owners;
}

function buildCanonicalHashOwners(jobs) {
  const owners = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const ownerKey = resolveJobDiffKey(job);
    const hash = stableSlugHash(job);
    if (!ownerKey || !hash) continue;
    if (!owners.has(hash)) owners.set(hash, new Set());
    owners.get(hash).add(ownerKey);
  }
  return owners;
}

/**
 * Split candidate removals into genuine losses and proven cross-job
 * decontaminations. The exemption is intentionally narrow:
 *   - the claimant carried the route only as history (never as active slug);
 *   - its six-character disambiguator positively identified exactly one
 *     different stable owner before (the same ownership proof recovery uses);
 *   - exactly that canonical owner, and no claimant/collision, carries the
 *     exact route after.
 *
 * `beforeJobs`/`afterJobs` are the global active+expired universe for the
 * commit transition, not merely the claimant's crawler slice. This makes an
 * owner swap, an unreachable route, or an ambiguous collision fail closed.
 *
 * @param {{jobKey:string,lost:string[],historicalLost?:string[]}} removal
 * @param {Array<object>} beforeJobs
 * @param {Array<object>} afterJobs
 */
export function classifyCrossJobDecontamination(removal, beforeJobs, afterJobs) {
  const beforeOwners = buildRouteOwners(beforeJobs);
  const afterOwners = buildRouteOwners(afterJobs);
  const beforeCanonicalOwners = buildCanonicalHashOwners(beforeJobs);
  const afterCanonicalOwners = buildCanonicalHashOwners(afterJobs);
  const historical = new Set(removal?.historicalLost || []);
  const lost = [];
  const safeCrossJobDecontaminations = [];

  for (const slug of removal?.lost || []) {
    if (!historical.has(slug)) {
      lost.push(slug);
      continue;
    }
    const tail = HASH_TAIL_RE.exec(String(slug))?.[1];
    const prior = [...(beforeCanonicalOwners.get(tail) || [])].filter((key) => key !== removal.jobKey);
    const nextCanonical = [...(afterCanonicalOwners.get(tail) || [])].filter((key) => key !== removal.jobKey);
    const next = [...(afterOwners.get(slug) || [])].filter((key) => key !== removal.jobKey);
    const claimantOwnedBefore = beforeOwners.get(slug)?.has(removal.jobKey) || false;
    const claimantStillOwns = afterOwners.get(slug)?.has(removal.jobKey) || false;
    if (
      claimantOwnedBefore
      && prior.length === 1
      && nextCanonical.length === 1
      && next.length === 1
      && prior[0] === nextCanonical[0]
      && prior[0] === next[0]
      && !claimantStillOwns
    ) {
      safeCrossJobDecontaminations.push({ slug, ownerJobId: prior[0] });
    } else {
      lost.push(slug);
    }
  }

  return { lost, safeCrossJobDecontaminations };
}

export function formatJsonLines(events) {
  return Array.isArray(events) && events.length > 0
    ? `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
    : '';
}

/**
 * Build file → ordered commit list (oldest first, matching each file's own
 * `git log --reverse`) for every slice file touched in the window, via ONE
 * `git log --name-only` walk of the whole slice directory instead of one
 * `git log` subprocess per file. 569 slice files each paying their own
 * commit-graph walk was the dominant cost behind the scheduled job's
 * 25-minute timeout (issue #4654) — a single walk shares the graph
 * traversal across every file.
 *
 * @param {string} since
 * @param {string[]} [dirs]
 * @returns {Map<string, string[]>} absolute file path → commit SHAs
 */
function buildFileCommitsIndex(since, dirs = [DIR]) {
  const raw = execSync(
    `git log --since="${since}" --reverse --name-only --pretty=format:%x01%H -- ${dirs.join(' ')}`,
    { encoding: 'utf8', cwd: ROOT, maxBuffer: 200 * 1024 * 1024 },
  );
  const fileCommits = new Map();
  for (const chunk of raw.split('\x01')) {
    if (!chunk) continue;
    const lines = chunk.split('\n');
    const hash = lines[0]?.trim();
    if (!hash) continue;
    for (let i = 1; i < lines.length; i++) {
      const f = lines[i].trim();
      if (!f || !f.endsWith('.json')) continue;
      const abs = path.join(ROOT, f);
      let arr = fileCommits.get(abs);
      if (!arr) { arr = []; fileCommits.set(abs, arr); }
      arr.push(hash);
    }
  }
  return fileCommits;
}

function addCandidateOwnerFiles(jobs, rel, candidates, candidatesByHash, bySlug) {
  for (const job of Array.isArray(jobs) ? jobs : []) {
    for (const slug of jobRouteSlugs(job)) {
      if (!candidates.has(slug)) continue;
      bySlug.get(slug).add(rel);
    }
    const hash = stableSlugHash(job);
    for (const slug of candidatesByHash.get(hash) || []) bySlug.get(slug).add(rel);
  }
}

function candidateNeedlePattern(candidates) {
  // The exact route must occur in the claimant's parent and canonical
  // owner's post snapshot, so it is also the narrowest complete prefilter.
  // Searching bare six-character hash tails made ordinary content matches
  // explode the historical parse cost without strengthening the proof.
  const values = new Set([...candidates].map((slug) => JSON.stringify(slug)));
  const escaped = [...values].map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return escaped.length > 0 ? new RegExp(escaped.join('|')) : null;
}

async function buildCandidateOwnerFileIndex(candidates, historyIndex, catFile) {
  const bySlug = new Map([...candidates].map((slug) => [slug, new Set()]));
  const candidatesByHash = new Map();
  for (const slug of candidates) {
    const tail = HASH_TAIL_RE.exec(String(slug))?.[1];
    if (!tail) continue;
    if (!candidatesByHash.has(tail)) candidatesByHash.set(tail, []);
    candidatesByHash.get(tail).push(slug);
  }
  const needle = candidateNeedlePattern(candidates);
  if (!needle) return bySlug;

  const inspect = (content, rel) => {
    if (!content || !needle.test(content)) return;
    let payload;
    try { payload = JSON.parse(content); } catch { return; }
    addCandidateOwnerFiles(payload?.jobs, rel, candidates, candidatesByHash, bySlug);
  };

  // Baseline every tracked active/expired slice at the working tree. A file
  // that did not change in the scan window is otherwise absent from git log,
  // yet can be the stable owner that makes a claimant cleanup safe.
  const tracked = execSync(`git ls-files -- ${DIR} ${EXPIRED_DIR}`, {
    encoding: 'utf8', cwd: ROOT, maxBuffer: 50 * 1024 * 1024,
  }).trim().split('\n').filter((rel) => rel.endsWith('.json'));
  for (const rel of tracked) {
    const abs = path.join(ROOT, rel);
    const content = fs.existsSync(abs)
      ? fs.readFileSync(abs, 'utf8')
      : await catFile.get(`HEAD:${rel}`);
    inspect(content, rel);
  }

  // Complete the possible-owner file set with every historical version in
  // the window plus the parent of each file's first change. Therefore a route
  // that existed at an event commit cannot disappear from our proof merely
  // because its owner file changed (or moved to expired) later in the window.
  for (const [abs, commits] of historyIndex.entries()) {
    if (commits.length === 0) continue;
    const rel = path.relative(ROOT, abs);
    const refs = [`${commits[0]}^`, ...commits];
    for (const ref of refs) inspect(await catFile.get(`${ref}:${rel}`), rel);
  }

  return bySlug;
}

async function loadJobsAtRef(ref, files, catFile, cache) {
  const jobs = [];
  for (const rel of files) {
    const cacheKey = `${ref}:${rel}`;
    let payload = cache.get(cacheKey);
    if (payload === undefined) {
      const content = await catFile.get(cacheKey);
      if (content == null) {
        payload = null;
      } else {
        try { payload = JSON.parse(content); } catch { payload = null; }
      }
      cache.set(cacheKey, payload);
    }
    if (Array.isArray(payload?.jobs)) jobs.push(...payload.jobs);
  }
  return jobs;
}

async function main() {
  const args = process.argv.slice(2);
  const sinceIdx = args.indexOf('--since');
  const SINCE = sinceIdx !== -1 ? args[sinceIdx + 1] : '60 days ago';
  const outIdx = args.indexOf('--out');
  const OUT = outIdx !== -1 ? args[outIdx + 1] : '/tmp/recoverable-slugs.json';
  const eventsIdx = args.indexOf('--events-out');
  const EVENTS_OUT = eventsIdx !== -1 ? args[eventsIdx + 1] : '/tmp/prev-slug-loss-events.jsonl';
  const safeEventsIdx = args.indexOf('--safe-events-out');
  const SAFE_EVENTS_OUT = safeEventsIdx !== -1
    ? args[safeEventsIdx + 1]
    : '/tmp/prev-slug-safe-cross-job-decontaminations.jsonl';

  const slices = execSync(`ls ${ABS_DIR}/*.json`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  process.stderr.write(`Scanning ${slices.length} slice files since "${SINCE}"…\n`);

  const lossesByJob = new Map();
  const lossesByFile = new Map();
  const lossEvents = [];
  const candidateEvents = [];
  const safeEvents = [];

  // Slugs REMOVED ON PURPOSE by decontamination passes (see
  // data/prev-slug-restore-denylist.json) must not count as losses: they
  // would trip the writer-regression wire on every decontamination commit
  // and feed the backfill the exact poison the decontamination deleted
  // (issue #4061 / recovery run 29106416912). The backfill has its own
  // guard too — this keeps the tripwire and the reports honest.
  const denylist = loadRestoreDenylist();
  let denylistedSkipped = 0;

  process.stderr.write(`Building commit index for ${slices.length} slice files…\n`);
  const ownershipHistory = buildFileCommitsIndex(SINCE, [DIR, EXPIRED_DIR]);
  const fileCommits = new Map(
    [...ownershipHistory.entries()].filter(([file]) => file.startsWith(`${ABS_DIR}${path.sep}`)),
  );
  const catFile = createCatFileBatch(ROOT);

  let fileIdx = 0;
  for (const file of slices) {
    fileIdx++;
    if (fileIdx % 100 === 0) process.stderr.write(`  ${fileIdx}/${slices.length}…\n`);
    const commits = fileCommits.get(file);
    if (!commits || commits.length === 0) continue;
    const rel = path.relative(ROOT, file);

    let prev = null;
    for (const commit of commits) {
      const content = await catFile.get(`${commit}:${rel}`);
      if (content == null) continue;
      let cur;
      try { cur = JSON.parse(content); } catch { continue; }
      if (!cur?.jobs) continue;
      if (prev && Array.isArray(prev.jobs)) {
        const fileBase = file.replace(`${ABS_DIR}/`, '');
        for (const removal of classifyJobSliceRemovals(prev.jobs, cur.jobs)) {
          candidateEvents.push({ commit, file, fileBase, ...removal });
        }
      }
      prev = cur;
    }
  }
  const candidateSlugs = new Set(candidateEvents.flatMap((event) => event.lost));
  const possibleOwnerFiles = await buildCandidateOwnerFileIndex(candidateSlugs, ownershipHistory, catFile);
  const snapshotCache = new Map();

  for (const event of candidateEvents) {
    const proofFiles = new Set(event.lost.flatMap((slug) => [...(possibleOwnerFiles.get(slug) || [])]));
    const beforeJobs = await loadJobsAtRef(`${event.commit}^`, proofFiles, catFile, snapshotCache);
    const afterJobs = await loadJobsAtRef(event.commit, proofFiles, catFile, snapshotCache);
    const classified = classifyCrossJobDecontamination(event, beforeJobs, afterJobs);

    if (classified.safeCrossJobDecontaminations.length > 0) {
      safeEvents.push({
        commit: event.commit.slice(0, 10),
        file: event.fileBase,
        jobId: event.jobKey,
        safeCrossJobDecontaminations: classified.safeCrossJobDecontaminations,
      });
    }

    const kept = classified.lost.filter((slug) => !denylist.has(denylistKey(event.fileBase, slug)));
    denylistedSkipped += classified.lost.length - kept.length;
    if (kept.length === 0) continue;
    lossEvents.push({ commit: event.commit.slice(0, 10), file: event.fileBase, jobId: event.jobKey, lost: kept });
    lossesByFile.set(event.file, (lossesByFile.get(event.file) || 0) + kept.length);
    if (!lossesByJob.has(event.jobKey)) lossesByJob.set(event.jobKey, { slugs: new Set(), file: event.file });
    for (const slug of kept) lossesByJob.get(event.jobKey).slugs.add(slug);
  }
  catFile.close();

  const totalLost = [...lossesByJob.values()].reduce((n, x) => n + x.slugs.size, 0);
  const safeCrossJobDecontaminations = safeEvents.reduce(
    (count, event) => count + event.safeCrossJobDecontaminations.length,
    0,
  );
  console.log(JSON.stringify({
    since: SINCE,
    totalLost,
    safeCrossJobDecontaminations,
    denylistedSkipped,
    filesAffected: lossesByFile.size,
    jobsAffected: lossesByJob.size,
    eventsCount: lossEvents.length,
  }, null, 2));
  if (denylistedSkipped > 0) {
    console.log(`\n⛔ skipped ${denylistedSkipped} denylisted (intentional decontamination)`);
  }
  if (safeCrossJobDecontaminations > 0) {
    console.log(`\n✅ excluded ${safeCrossJobDecontaminations} proven safe cross-job decontaminations`);
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

  fs.writeFileSync(EVENTS_OUT, formatJsonLines(lossEvents));
  fs.writeFileSync(SAFE_EVENTS_OUT, formatJsonLines(safeEvents));
  fs.writeFileSync(OUT, JSON.stringify(recoverable, null, 2));

  console.log('\nRECOVERABILITY:');
  console.log(`  already healed:       ${alreadyPresent}`);
  console.log(`  jobs no longer exist: ${deletedJobs}`);
  console.log(`  recoverable jobs:     ${recoverable.length}`);
  console.log(`  recoverable slugs:    ${recoverable.reduce((n, r) => n + r.slugs.length, 0)}`);
  console.log(`\nWrote:`);
  console.log(`  ${EVENTS_OUT}  (${lossEvents.length} loss events)`);
  console.log(`  ${SAFE_EVENTS_OUT}  (${safeEvents.length} safe cross-job decontamination events)`);
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
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
