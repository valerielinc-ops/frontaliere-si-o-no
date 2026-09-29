#!/usr/bin/env node
/**
 * One-shot, idempotent migration of the retired `im-bethesda-spital` slice
 * into the canonical `bethesda-spital` slice (issue 5253).
 *
 * `im-bethesda-spital` was a prospector spec over the public Bethesda jobs
 * page. Its records carry listing-page fragment URLs (`jobs.html#job-<hash>`),
 * but the page's JSON-LD `identifier.value` is the Umantis vacancy id of
 * tenant 2998 — the source the dedicated `bethesda-spital` crawler reads. The
 * table below is that mapping, read from the live page on 2026-09-29.
 *
 * Every retired record is rewritten to the id/url/applyUrl that
 * `createUmantisListingParser` emits for the same vacancy, then merged with
 * `mergeRetiredCrawlerJobs`: a vacancy the canonical slice already holds keeps
 * the canonical record and receives the retired slugs as previousSlugs; a
 * vacancy it does not hold is rehomed under `bethesda-spital`, so the next
 * crawl merges onto it by stable id. The run aborts if any locale route
 * either slice published would be lost, or if a retired record is unknown.
 *
 * Re-running after the retired slice is gone is a no-op, which is what makes
 * it safe to replay when the canonical slice conflicts with a crawler commit:
 * take `main`'s version of both slices and run it again.
 *
 * Usage (repo root):
 *   node scripts/migrate-retired-im-bethesda-spital.mjs          # dry-run
 *   node scripts/migrate-retired-im-bethesda-spital.mjs --apply  # write
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mergeRetiredCrawlerJobs, localeRouteKeys } from './reconcile-crawler-company-ownership.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const UMANTIS_BASE = 'https://recruitingapp-2998.umantis.com';
const CANONICAL_KEY = 'bethesda-spital';

/** Fragment of the retired record URL → Umantis vacancy id (JSON-LD identifier.value). */
export const RETIRED_FRAGMENT_TO_VACANCY = new Map([
  ['job-686f0be949cf', '323'],
  ['job-b68fafd8c3cf', '415'],
  ['job-da574726f840', '426'],
  ['job-7db730b42f17', '367'],
  ['job-6563b3622fc0', '377'],
  ['job-e2cf983347f5', '444'],
  ['job-62a12ed2768e', '343'],
  ['job-e5b73e8a6685', '453'],
  ['job-64626de7988e', '390'],
  ['job-cde11a6b4d57', '451'],
  ['job-e9c395b4aab0', '335'],
  ['job-b74dd5f7f818', '408'],
  ['job-2c4be85d5031', '454'],
  ['job-f8eccc37df02', '328'],
]);

/**
 * @param {object[]} canonicalJobs  jobs of data/jobs/by-crawler/bethesda-spital.json
 * @param {object[]} retiredJobs    jobs of data/jobs/by-crawler/im-bethesda-spital.json
 */
export function migrateRetiredImBethesdaJobs(canonicalJobs, retiredJobs) {
  const rewritten = retiredJobs.map((job) => {
    const fragment = String(job?.url || '').split('#')[1] || '';
    const vacancyId = RETIRED_FRAGMENT_TO_VACANCY.get(fragment);
    if (!vacancyId) throw new Error(`unknown retired record ${job?.url} ("${job?.title}")`);
    const url = `${UMANTIS_BASE}/Vacancies/${vacancyId}/Description/1`;
    return {
      ...job,
      id: `${CANONICAL_KEY}-${createHash('sha1').update(url).digest('hex').slice(0, 12)}`,
      url,
      applyUrl: `${UMANTIS_BASE}/Vacancies/${vacancyId}/Application/CheckLogin/1`,
    };
  });
  const result = mergeRetiredCrawlerJobs(canonicalJobs, rewritten, CANONICAL_KEY);
  const before = new Set([...canonicalJobs, ...retiredJobs].flatMap((job) => [...localeRouteKeys(job)]));
  const after = new Set(result.jobs.flatMap((job) => [...localeRouteKeys(job)]));
  const lost = [...before].filter((route) => !after.has(route));
  if (lost.length > 0) throw new Error(`${lost.length} locale routes lost (${lost.slice(0, 5).join(', ')})`);
  return { ...result, routesBefore: before.size, routesAfter: after.size };
}

function main() {
  const apply = process.argv.includes('--apply');
  const retiredFile = path.join(ROOT, 'data/jobs/by-crawler/im-bethesda-spital.json');
  const retiredSummary = path.join(ROOT, 'data/jobs-crawler-summaries/by-crawler/im-bethesda-spital.json');
  const canonicalFile = path.join(ROOT, 'data/jobs/by-crawler/bethesda-spital.json');
  if (!fs.existsSync(retiredFile)) {
    console.log('im-bethesda-spital slice already migrated: nothing to do');
    if (apply && fs.existsSync(retiredSummary)) fs.rmSync(retiredSummary);
    return;
  }
  const retired = JSON.parse(fs.readFileSync(retiredFile, 'utf8'));
  const canonical = JSON.parse(fs.readFileSync(canonicalFile, 'utf8'));
  const result = migrateRetiredImBethesdaJobs(canonical.jobs, retired.jobs);
  console.log(JSON.stringify({
    canonicalBefore: canonical.jobs.length,
    retired: retired.jobs.length,
    collapsed: result.collapsed,
    rehomed: result.rehomed,
    slugsTransferred: result.slugsTransferred,
    canonicalAfter: result.jobs.length,
    routesBefore: result.routesBefore,
    routesAfter: result.routesAfter,
  }));
  if (!apply) return;
  fs.writeFileSync(canonicalFile, `${JSON.stringify({ ...canonical, jobs: result.jobs }, null, 2)}\n`);
  fs.rmSync(retiredFile);
  if (fs.existsSync(retiredSummary)) fs.rmSync(retiredSummary);
  console.log('applied');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
