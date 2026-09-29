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
 * vacancy it does not hold is rehomed under `bethesda-spital` so the next
 * crawl merges onto it by stable id — but with the canonical crawler's own
 * detail-page body (same URL, extractor and validity check as the factory),
 * never with the retired JSON-LD teaser or its translations. A vacancy whose
 * detail page yields no valid body is not published: it goes to the expired
 * archive of `bethesda-spital`, where its routes stay served as soft landings.
 * The run aborts if any locale route either slice published would be lost, or
 * if a retired record is unknown.
 *
 * Re-running after the retired slice is gone is a no-op, which is what makes
 * it safe to replay when the canonical slice conflicts with a crawler commit:
 * take `main`'s version of both slices and run it again (it re-reads the four
 * detail pages).
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
import { archiveRemovedJobsToSlice } from './lib/expired-jobs-archive.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { extractUmantisDetailContent, isDetailContentValid } from './lib/umantis-listing-common.mjs';
import { normalizeDescriptionBullets } from './lib/crawler-template.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const UMANTIS_BASE = 'https://recruitingapp-2998.umantis.com';
const CANONICAL_KEY = 'bethesda-spital';
const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

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
 * @param {{ detailFor?: (vacancyId: string) => string }} [opts]
 *   `detailFor` returns the canonical detail-page body for a vacancy the
 *   canonical slice does not hold yet ('' when the page gave nothing usable).
 * @returns {{ jobs: object[], archived: object[], collapsed: number, rehomed: number,
 *   slugsTransferred: number, routesBefore: number, routesAfter: number }}
 *   `archived`: retired records whose vacancy has no usable canonical body.
 *   They are NOT published under the canonical crawler with the retired
 *   teaser text; the caller files them in the expired archive, where their
 *   routes stay served as soft landings.
 */
export function migrateRetiredImBethesdaJobs(canonicalJobs, retiredJobs, opts = {}) {
  const detailFor = typeof opts.detailFor === 'function' ? opts.detailFor : () => '';
  const canonicalIdentities = new Set(canonicalJobs.map((job) => extractStableJobId(job?.url)).filter(Boolean));
  const toMerge = [];
  const archived = [];
  for (const job of retiredJobs) {
    const fragment = String(job?.url || '').split('#')[1] || '';
    const vacancyId = RETIRED_FRAGMENT_TO_VACANCY.get(fragment);
    if (!vacancyId) throw new Error(`unknown retired record ${job?.url} ("${job?.title}")`);
    const url = `${UMANTIS_BASE}/Vacancies/${vacancyId}/Description/1`;
    const rewritten = {
      ...job,
      id: `${CANONICAL_KEY}-${createHash('sha1').update(url).digest('hex').slice(0, 12)}`,
      url,
      applyUrl: `${UMANTIS_BASE}/Vacancies/${vacancyId}/Application/CheckLogin/1`,
    };
    if (canonicalIdentities.has(extractStableJobId(url))) {
      // Collapsed onto the canonical record: only its slugs travel.
      toMerge.push(rewritten);
      continue;
    }
    // A rehomed record would publish under bethesda-spital. The retired
    // crawler's text is the JSON-LD teaser (issue 5253 review): it must not
    // come along, and neither may its translations of that teaser.
    const body = String(detailFor(vacancyId) || '').trim();
    if (!body) {
      archived.push({ ...rewritten, companyKey: CANONICAL_KEY, company: canonicalJobs[0]?.company || job.company });
      continue;
    }
    toMerge.push({
      ...rewritten,
      description: body,
      descriptionByLocale: { de: body },
      sourceLang: 'de',
      needsRetranslation: true,
    });
  }
  const result = mergeRetiredCrawlerJobs(canonicalJobs, toMerge, CANONICAL_KEY);
  const before = new Set([...canonicalJobs, ...retiredJobs].flatMap((job) => [...localeRouteKeys(job)]));
  const after = new Set([...result.jobs, ...archived].flatMap((job) => [...localeRouteKeys(job)]));
  const lost = [...before].filter((route) => !after.has(route));
  if (lost.length > 0) throw new Error(`${lost.length} locale routes lost (${lost.slice(0, 5).join(', ')})`);
  return { ...result, archived, routesBefore: before.size, routesAfter: after.size };
}

/**
 * The canonical crawler's own body for one vacancy: same detail URL, same
 * extractor and same validity check as `createUmantisListingParser`.
 *
 * @param {string} vacancyId
 * @param {string} title
 * @returns {Promise<string>}
 */
async function fetchCanonicalBody(vacancyId, title) {
  const url = `${UMANTIS_BASE}/Vacancies/${vacancyId}/Description/1`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' } });
    if (!res.ok || new URL(res.url).hostname !== new URL(url).hostname) return '';
    const content = extractUmantisDetailContent(await res.text());
    return isDetailContentValid(content, title) ? normalizeDescriptionBullets(content) : '';
  } catch {
    return '';
  }
}

async function main() {
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
  const canonicalIdentities = new Set(canonical.jobs.map((job) => extractStableJobId(job?.url)).filter(Boolean));
  const bodies = new Map();
  for (const job of retired.jobs) {
    const vacancyId = RETIRED_FRAGMENT_TO_VACANCY.get(String(job?.url || '').split('#')[1] || '');
    if (!vacancyId) continue;
    if (canonicalIdentities.has(extractStableJobId(`${UMANTIS_BASE}/Vacancies/${vacancyId}/Description/1`))) continue;
    bodies.set(vacancyId, await fetchCanonicalBody(vacancyId, job.title));
    await new Promise((r) => setTimeout(r, 300));
  }
  const result = migrateRetiredImBethesdaJobs(canonical.jobs, retired.jobs, { detailFor: (id) => bodies.get(id) || '' });
  console.log(JSON.stringify({
    canonicalBefore: canonical.jobs.length,
    retired: retired.jobs.length,
    collapsed: result.collapsed,
    rehomed: result.rehomed,
    archived: result.archived.length,
    rehomedBodyChars: [...bodies.values()].map((b) => b.length),
    slugsTransferred: result.slugsTransferred,
    canonicalAfter: result.jobs.length,
    routesBefore: result.routesBefore,
    routesAfter: result.routesAfter,
  }));
  if (!apply) return;
  fs.writeFileSync(canonicalFile, `${JSON.stringify({ ...canonical, jobs: result.jobs }, null, 2)}\n`);
  if (result.archived.length) archiveRemovedJobsToSlice(result.archived, CANONICAL_KEY);
  fs.rmSync(retiredFile);
  if (fs.existsSync(retiredSummary)) fs.rmSync(retiredSummary);
  console.log('applied');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
