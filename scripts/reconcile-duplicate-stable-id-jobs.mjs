#!/usr/bin/env node
/**
 * One-time reconciliation for jobs that share the same persisted `.id`
 * within a single crawler slice but were never collapsed into one record
 * (issue #4603).
 *
 * Root cause: a crawl-time merge legitimately collapses two URL-variant
 * postings of the same requisition into one job (extractStableJobId), but a
 * concurrently-running long-lived job (translate-pending's slug-regen
 * commit) can still hold the pre-collapse snapshot; its 3-way merge in
 * scripts/lib/git-commit-data.sh then resurrected the already-retired
 * variant. That merge bug is fixed separately (mergeArray now respects a
 * remote-side deletion instead of letting a stale local edit resurrect it);
 * this script cleans up duplicate groups that already made it onto disk
 * before that fix.
 *
 * For each `.id` group with >1 record in a slice:
 *   - keep the record with the latest `crawledAt` (freshest crawl wins)
 *   - capture every OTHER record's slug/slugByLocale into the survivor's
 *     previousSlugs so the retired URL still resolves via bridge/redirect
 *   - carry every OTHER record's `needsRetranslation` onto the survivor
 *     (#5645): the flag is monotone and the dropped record is the only place
 *     it may exist, so keeping one side whole would DELETE the mark — the same
 *     resolution this script already refuses for slugs, one field over
 *   - drop the other record(s)
 *
 * Only records with the same crawl-time identity (`mergeJobIdentity`) are
 * collapsed. Records that share an `.id` but are DISTINCT postings are never
 * dropped: the later-seen one is re-keyed instead (#9666, see
 * reconcileDuplicateIdJobs below).
 *
 * Idempotent: a re-run finds no groups. Dry-run by default; --apply writes.
 *
 * Usage:
 *   node scripts/reconcile-duplicate-stable-id-jobs.mjs            # dry-run
 *   node scripts/reconcile-duplicate-stable-id-jobs.mjs --apply    # write
 *   node scripts/reconcile-duplicate-stable-id-jobs.mjs --apply banca-cler.json
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addPreviousSlugForLocale, LOCALES, DEFAULT_PREV_SLUG_CAP } from './lib/dedicated-crawler-common.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { carryForwardMarks } from './lib/job-mark-persistence.mjs';
import { isSliceFile } from './lib/crawler-slice-files.mjs';
import { mergeJobIdentity } from './lib/job-match-key.mjs';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ONLY_FILES = new Set(args.filter((a) => a.endsWith('.json')));

function previousSlugCount(job) {
  if (!job.previousSlugsByLocale || typeof job.previousSlugsByLocale !== 'object') return 0;
  return Object.values(job.previousSlugsByLocale).reduce(
    (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
    0,
  );
}

// Exported for tests: `crawledAt` ties (same-timestamp duplicates) must resolve
// the same way on every run, not depend on Array.prototype.sort's input-order
// stability. Secondary key prefers the record with more accumulated
// previousSlugs (richer redirect/history data); a final `.url` compare
// guarantees a total order regardless of input order.
export function pickWinner(jobs) {
  return jobs.slice().sort((a, b) => {
    const ta = Date.parse(a.crawledAt || '') || 0;
    const tb = Date.parse(b.crawledAt || '') || 0;
    if (tb !== ta) return tb - ta;
    const countDiff = previousSlugCount(b) - previousSlugCount(a);
    if (countDiff !== 0) return countDiff;
    return String(a.url || '').localeCompare(String(b.url || ''));
  })[0];
}

/**
 * Stable-ID collision between DISTINCT postings (#9666).
 *
 * The collapse above is only correct when the records sharing an `.id` are
 * the same requisition (URL variants the crawl-time merge would match onto one
 * another). Measured on main 2026-09-24: puk-zuerich.json carried
 * `puk-zuerich-fadca51159cb` on BOTH refline posting 2117 (Unterassistenten,
 * which had inherited the id long ago) and posting 2644 (Advanced Practice
 * Nurse, whose own crawler id is sha1 of its URL = the same value). The two
 * records have different `mergeJobIdentity` keys, so every crawl re-emits
 * 2644 next to 2117, and every recover-prev-slugs run "reconciled" them by
 * DELETING the live APN vacancy (no expired archive) and pushing its active
 * slugs into the Unterassistenten record's previousSlugs: its indexed URLs
 * flipped between a live page and an alias of an unrelated job at every
 * cycle (commits 1be542ff664, 7ed26edfde5, 9395009f130, 7773ac73c32,
 * 40a060b953e). The SPA slug map also carries `_id` as the lazy-fetch meta
 * (services/router.ts getJobMetaForSlug), so a shared id is not cosmetic.
 *
 * Distinct identities are therefore never collapsed. The sub-group that held
 * the id first (earliest `firstSeenAt`, then lexicographic identity) keeps
 * it; every other sub-group gets a deterministic, collision-checked id
 * derived from its own identity. The crawl-time merge preserves `old.id` on a
 * URL-key match, so the next crawl keeps the new id instead of re-creating the
 * collision: the reconciliation is a fixed point, not a daily oscillation.
 */
export function identityOf(job) {
  return mergeJobIdentity(job) || '';
}

function firstSeenMs(job) {
  const t = Date.parse(job?.firstSeenAt || job?.firstSeen || '');
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

function subgroupFirstSeen(jobs) {
  return Math.min(...jobs.map(firstSeenMs));
}

export function rekeyedId(id, identity, takenIds) {
  const digest = createHash('sha1').update(identity).digest('hex');
  for (let len = 8; len <= digest.length; len += 4) {
    const candidate = `${id}-r${digest.slice(0, len)}`;
    if (!takenIds.has(candidate)) return candidate;
  }
  throw new Error(`reconcile-duplicate-stable-id: cannot derive a free id for ${id} / ${identity}`);
}

function collapseInto(winner, dropped) {
  const marks = carryForwardMarks(winner, dropped);
  for (const locale of LOCALES) {
    const slug = dropped.slugByLocale?.[locale];
    if (slug && slug !== winner.slugByLocale?.[locale]) {
      addPreviousSlugForLocale(winner, locale, slug, DEFAULT_PREV_SLUG_CAP, 'reconcile-duplicate-stable-id');
    }
  }
  if (dropped.slug && dropped.slug !== winner.slug) {
    addPreviousSlugForLocale(winner, 'it', dropped.slug, DEFAULT_PREV_SLUG_CAP, 'reconcile-duplicate-stable-id');
  }
  return marks;
}

/**
 * Reconcile one slice's jobs array in memory. Pure apart from mutating the
 * surviving job objects (previousSlugs / marks / re-keyed id), exactly like
 * the historic in-place loop.
 *
 * @param {object[]} jobs
 * @returns {{ jobs: object[], groups: number, collapsed: number, rekeyed: number,
 *   marksCarried: number, report: string[] }}
 */
export function reconcileDuplicateIdJobs(jobs) {
  const byId = new Map();
  jobs.forEach((job, index) => {
    if (!job?.id) return;
    if (!byId.has(job.id)) byId.set(job.id, []);
    byId.get(job.id).push(index);
  });
  const takenIds = new Set(byId.keys());

  const dropIndexes = new Set();
  const report = [];
  let groups = 0;
  let collapsed = 0;
  let rekeyed = 0;
  let marksCarried = 0;

  for (const [id, indexes] of byId) {
    if (indexes.length < 2) continue;
    groups += 1;

    // Split by crawl-time identity. Records with no resolvable identity keep
    // the historic behaviour (collapse with the id owner) because nothing
    // proves they are a different posting.
    const byIdentity = new Map();
    const anonymous = [];
    for (const index of indexes) {
      const key = identityOf(jobs[index]);
      if (!key) { anonymous.push(index); continue; }
      if (!byIdentity.has(key)) byIdentity.set(key, []);
      byIdentity.get(key).push(index);
    }
    const subgroups = [...byIdentity.entries()]
      .map(([identity, idx]) => ({ identity, indexes: idx }))
      .sort((a, b) => {
        const fa = subgroupFirstSeen(a.indexes.map((i) => jobs[i]));
        const fb = subgroupFirstSeen(b.indexes.map((i) => jobs[i]));
        if (fa !== fb) return fa - fb;
        return a.identity.localeCompare(b.identity);
      });
    if (subgroups.length === 0) subgroups.push({ identity: '', indexes: [] });
    subgroups[0].indexes.push(...anonymous);

    subgroups.forEach((sub, rank) => {
      const group = sub.indexes.map((i) => jobs[i]);
      const winner = pickWinner(group);
      for (const dropped of group) {
        if (dropped === winner) continue;
        marksCarried += collapseInto(winner, dropped);
      }
      for (const index of sub.indexes) {
        if (jobs[index] !== winner) dropIndexes.add(index);
      }
      collapsed += group.length - 1;
      if (rank === 0) {
        if (group.length > 1) {
          report.push(`id=${id} — kept ${winner.url} (crawledAt=${winner.crawledAt}), dropped ${group.length - 1}`);
        }
        return;
      }
      const nextId = rekeyedId(id, sub.identity, takenIds);
      takenIds.add(nextId);
      winner.id = nextId;
      rekeyed += 1;
      report.push(`id=${id} — distinct posting ${winner.url} re-keyed to ${nextId} (not collapsed)`
        + (group.length > 1 ? `, dropped ${group.length - 1} same-identity duplicate(s)` : ''));
    });
  }

  return {
    jobs: jobs.filter((_, index) => !dropIndexes.has(index)),
    groups,
    collapsed,
    rekeyed,
    marksCarried,
    report,
  };
}

/**
 * The summary line is parsed by .github/workflows/recover-prev-slugs.yml
 * (`N duplicate-id group(s), M record(s)…`): M gates the commit step, so a
 * re-key-only run must count too or the repaired id is never persisted.
 */
export function formatReconcileSummary({ apply, groups, collapsed, rekeyed, marksCarried }) {
  return `${apply ? 'Applied' : 'Dry-run'}: ${groups} duplicate-id group(s), `
    + `${collapsed + rekeyed} record(s) reconciled (${collapsed} collapsed, `
    + `${rekeyed} re-keyed distinct posting(s)), `
    + `${marksCarried} needsRetranslation mark(s) carried onto a survivor.`;
}

function main() {
  const files = fs.readdirSync(DIR)
    .filter(isSliceFile)
    .filter((f) => ONLY_FILES.size === 0 || ONLY_FILES.has(f));

  let totalGroups = 0;
  let totalDropped = 0;
  let totalRekeyed = 0;
  let marksCarried = 0;
  const report = [];

  for (const file of files) {
    const filePath = path.join(DIR, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    const jobs = Array.isArray(data) ? data : (Array.isArray(data?.jobs) ? data.jobs : null);
    if (!jobs || jobs.length === 0) continue;

    const result = reconcileDuplicateIdJobs(jobs);
    totalGroups += result.groups;
    totalDropped += result.collapsed;
    totalRekeyed += result.rekeyed;
    marksCarried += result.marksCarried;
    for (const line of result.report) report.push(`${file}: ${line}`);

    if (result.collapsed === 0 && result.rekeyed === 0) continue;

    console.log(`${file}: ${jobs.length} → ${result.jobs.length} jobs, ${result.rekeyed} re-keyed`);

    if (APPLY) {
      const out = Array.isArray(data) ? result.jobs : { ...data, jobs: result.jobs };
      writeJsonAtomic(filePath, out);
    }
  }

  console.log(`\n${formatReconcileSummary({
    apply: APPLY,
    groups: totalGroups,
    collapsed: totalDropped,
    rekeyed: totalRekeyed,
    marksCarried,
  })}`);
  for (const line of report) console.log(`  - ${line}`);
}

const invokedDirectly = (() => {
  // Entrypoint canonico, non suffisso del path (#7292): `endsWith` diceva true
  // per QUALUNQUE entrypoint il cui `argv[1]` finisse con questo nome di file;
  // `realpathSync` copre l'invocazione via symlink, dove `argv[1]` e' il link.
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
})();

if (invokedDirectly) {
  main();
}
