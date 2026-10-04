#!/usr/bin/env node
import { sourcePostingDateFields } from './lib/source-posting-date.mjs';
/**
 * Dedicated Zambon Svizzera SA Swiss-source crawler runner.
 *
 * Zambon's careers portal is at:
 *   https://www.zambon.com/en/open-positions
 *
 * The page uses NcorePlat ATS with a Vue.js frontend. The API is national
 * for Zambon's Swiss entity and exposes country=CH; its source-backed Swiss
 * site address is Cadempino, so this is not a Ticino facet or a city filter.
 * Job data is rendered client-side, so the HTML may contain only
 * Vue template placeholders when fetched server-side.
 *
 * Previously used jobopportunity.ch (defunct as of early 2026).
 */
import { meetsSourceBodyFloor } from './lib/source-body-floor.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { exitCrawlerOnError, fetchHtml } from './lib/crawler-template.mjs';
import { fileURLToPath } from 'node:url';
import { snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, mergePreserveLocaleData } from './lib/dedicated-crawler-common.mjs';
import { dropStaleLocaleDescriptions, sourceLangOfBody, sourceSlotTitleAndSlug } from './lib/source-locale-slots.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { parseListingPage, slugify, detectCategory, detectExperienceLevel, inferEmploymentType, ZAMBON_SWISS_SITE, extractZambonJobBody } from './lib/zambon-job-parser.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'zambon';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768, confirmed cause of #3769/#3770).
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const COMPANY_NAME = 'Zambon Svizzera SA';
const COMPANY_HOST = 'www.zambon.com';
const CAREERS_URL = 'https://www.zambon.com/en/open-positions';
const CAREERS_API = 'https://www.zambon.com/it/api/careers-api?visibility=external';
const LOCALES = ['it', 'en', 'de', 'fr'];

function normalize(v = '') { return String(v || '').trim().toLowerCase(); }
function isCompanyJob(job) {
  const key = normalize(job?.companyKey || ''); const company = normalize(job?.company || ''); const url = String(job?.url || '').toLowerCase();
  return key === COMPANY_KEY || key.includes('zambon') || company.includes('zambon') || url.includes('zambon');
}
function isTrustedDomain(rawUrl = '') { try { const h = new URL(rawUrl).hostname.toLowerCase(); return h.includes('zambon') || h.includes('ncoreplat.com'); } catch { return false; } }

async function fetchPage(url, timeoutMs = 20000) {
  try {
    return await fetchHtml(url, {
      timeoutMs,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en,it-CH;q=0.9',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
  } catch (err) { console.warn(`⚠️ Fetch failed: ${err.message}`); return null; }
}

function isZambonSwissSiteLocation(rawLocation = '') {
  const location = normalize(rawLocation);
  return !location || /\bcadempino\b/.test(location);
}

const DETAIL_DELAY_MS = 1000;
// Fragments only the runner ever wrote: the description it composed from API
// metadata ("<titolo>: opportunità professionale presso Zambon Svizzera SA, …"
// and "<titolo> — posizione presso Zambon Svizzera SA a Cadempino (TI).").
// Only ever recognised to be removed from stored records.
export const ZAMBON_FABRICATED_DESCRIPTION_RE = /opportunità professionale presso Zambon Svizzera SA|— posizione presso Zambon Svizzera SA a /;

/**
 * Build one Zambon job from its source row and the vacancy text of its
 * NcorePlat page (issue 5253). The careers API carries only metadata; the
 * runner used to publish a description it wrote from those fields and a
 * company paragraph (3/3 jobs). The NcorePlat page is server-rendered with the
 * real ad, so that text is the description, in its own language. A job whose
 * page yields no text gets an empty description: `mergeZambonJobs` then keeps
 * the body an earlier run read, or does not publish it.
 */
export function buildZambonJob({ id = '', url, title, datePosted = '', contract = '', department = '', seniority = '', source = 'zambon-ncoreplat-api' }, body = '') {
  const description = meetsSourceBodyFloor(body) ? String(body).trim() : '';
  const slug = slugify(title, 'zambon');
  const sourceLang = sourceLangOfBody(description, 'it');
  return {
    ...(id ? { id } : {}),
    url, applyUrl: url, title,
    company: COMPANY_NAME, companyKey: COMPANY_KEY,
    location: ZAMBON_SWISS_SITE.city, canton: ZAMBON_SWISS_SITE.canton, country: ZAMBON_SWISS_SITE.country,
    addressLocality: ZAMBON_SWISS_SITE.city, addressRegion: ZAMBON_SWISS_SITE.canton, addressCountry: ZAMBON_SWISS_SITE.country,
    postalCode: ZAMBON_SWISS_SITE.postalCode, streetAddress: ZAMBON_SWISS_SITE.streetAddress,
    description,
    ...sourceSlotTitleAndSlug(title, slug, sourceLang),
    descriptionByLocale: description ? { [sourceLang]: description } : {},
    slug,
    category: detectCategory(title),
    ...sourcePostingDateFields(datePosted),
    source,
    employmentType: inferEmploymentType(title, contract || description),
    experienceLevel: detectExperienceLevel(title),
    sector: 'Farmaceutica',
    ...(department ? { department } : {}),
    ...(seniority ? { seniority } : {}),
    sourceLang,
  };
}

async function readZambonBodies(rows) {
  let read = 0;
  const jobs = [];
  for (const [index, row] of rows.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, DETAIL_DELAY_MS));
    const job = buildZambonJob(row, extractZambonJobBody(await fetchPage(row.url)));
    if (job.description) read += 1;
    else console.warn(`  ⚠️ ${row.title}: no vacancy text on ${row.url}`);
    jobs.push(job);
  }
  // Not one page readable is a source-level failure (e.g. a WAF in front of
  // NcorePlat), not "every vacancy lost its text": return nothing so main()
  // leaves the stored slice untouched instead of unpublishing every job.
  if (rows.length > 0 && read === 0) {
    console.warn('  ⚠️ No NcorePlat page readable in this run — keeping the stored Zambon slice.');
    return [];
  }
  return jobs;
}

async function fetchJobs() {
  // Primary: use the JSON API (Vue.js frontend loads from this)
  console.log(`🔍 Fetching Zambon jobs from API: ${CAREERS_API}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(CAREERS_API, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const allJobs = body.data || body;
    if (!Array.isArray(allJobs)) throw new Error('API response is not an array');

    // Filter to Switzerland only
    const swissJobs = allJobs.filter(j => j.country === 'CH' || (j.country_label || '').toLowerCase().includes('switz'));
    console.log(`  📋 API returned ${allJobs.length} total positions, ${swissJobs.length} in Switzerland`);

    return await readZambonBodies(swissJobs.map((raw) => ({
      id: `zambon-${raw.id}`,
      url: raw.web_url || `https://app.ncoreplat.com/jobposition/${raw.id}`,
      title: (raw.title || '').trim(),
      datePosted: raw.opening_date || '',
      contract: raw.contract_type_3 || '',
      department: raw.job_family || '',
      seniority: raw.seniority || '',
    })));
  } catch (err) {
    console.warn(`⚠️ API fetch failed: ${err.message} — falling back to HTML parsing`);
  } finally {
    clearTimeout(timer);
  }

  // Fallback: HTML parsing (unlikely to work for Vue.js rendered pages)
  console.log(`🔍 Fallback: Fetching Zambon jobs from ${CAREERS_URL}`);
  const html = await fetchPage(CAREERS_URL, 25000);
  if (!html) { console.error('❌ Failed to fetch Zambon careers page.'); return []; }
  const listings = parseListingPage(html);
  console.log(`  📋 HTML fallback found: ${listings.length} jobs`);

  const sourceBackedListings = listings.filter((raw) => {
    if (isZambonSwissSiteLocation(raw.location)) return true;
    console.warn(`  ⏭️ Dropping fallback row with non-Cadempino source location: ${raw.location}`);
    return false;
  });

  return readZambonBodies(sourceBackedListings.map((raw) => ({
    url: raw.url,
    title: raw.title,
    source: 'zambon-careers-crawler',
  })));
}


function storedZambonSourceBody(job = {}) {
  const text = String(job?.descriptionByLocale?.[job?.sourceLang] || job?.description || '').trim();
  return text && meetsSourceBodyFloor(text) ? text : '';
}

/**
 * Merge freshly read Zambon jobs with the stored ones (issue 5253).
 *
 * - The stored jobs first lose the metadata description the runner once
 *   wrote, with the translations made from it (`dropFabricatedDescriptions`,
 *   on copies: the function stays pure).
 * - A job whose page gave no text keeps the body an earlier run read from
 *   the source, with its language; without one it is not published.
 * - The source slot follows the language of the text: the old rule wrote the
 *   fresh description into `it` whatever its language, and forced a
 *   retranslation of every job on every run. Retranslation is now asked only
 *   when the source text or its language changed.
 *
 * mergePreserveLocaleData matches on the stable trailing job id extracted
 * from the URL, so a vendor title/slug rewrite does not orphan the job's
 * previousSlugs/firstSeenAt history (issue #3699).
 */
export function mergeZambonJobs(existingCompanyJobs = [], discoveredJobs = []) {
  // No row read from the source (the listing failed, or `readZambonBodies`
  // found no readable NcorePlat page) is a source-level failure, not "every
  // vacancy closed": the stored slice stays exactly as it is. Scrubbing it
  // here would drop every record whose only text is a legacy one.
  if (!Array.isArray(discoveredJobs) || discoveredJobs.length === 0) {
    return existingCompanyJobs.map((job) => structuredClone(job));
  }
  const stored = dropFabricatedDescriptions(
    existingCompanyJobs.map((job) => structuredClone(job)),
    ZAMBON_FABRICATED_DESCRIPTION_RE,
    COMPANY_NAME,
  );
  const existingByKey = new Map();
  for (const job of stored) {
    const key = extractStableJobId(job?.url);
    if (key) existingByKey.set(key, job);
  }
  const withBodies = [];
  for (const job of discoveredJobs) {
    if (job.description) { withBodies.push(job); continue; }
    const old = existingByKey.get(extractStableJobId(job?.url));
    const storedBody = old ? storedZambonSourceBody(old) : '';
    if (!storedBody) {
      console.log(`  ⏭️ ${job.title}: no source text — not published this run`);
      continue;
    }
    const storedLang = sourceLangOfBody(storedBody, old.sourceLang || 'it');
    const sourceTitle = String(job.titleByLocale?.[job.sourceLang] || job.title || '').trim();
    const sourceSlug = String(job.slugByLocale?.[job.sourceLang] || job.slug || '').trim();
    withBodies.push({
      ...job,
      sourceLang: storedLang,
      ...sourceSlotTitleAndSlug(sourceTitle, sourceSlug, storedLang),
      description: storedBody,
      descriptionByLocale: { [storedLang]: storedBody },
    });
  }
  const keep = new Set(withBodies.map((job) => extractStableJobId(job?.url)));
  // Stored jobs whose only text was the runner's own description (now
  // removed) are not carried over by the grace policy either.
  const existingKept = stored.filter((job) => keep.has(extractStableJobId(job?.url)) || storedZambonSourceBody(job));

  return mergePreserveLocaleData(existingKept, withBodies).map((job) => {
    const old = existingByKey.get(extractStableJobId(job?.url));
    const byLocale = { ...(job.descriptionByLocale || {}) };
    const oldSource = old ? String(old.descriptionByLocale?.[old.sourceLang] || old.description || '').trim() : '';
    const changed = Boolean(old) && (old.sourceLang !== job.sourceLang || oldSource !== String(job.description || '').trim());
    // The other locales were translated from the previous source text. When
    // the source changed, only the source slot survives and the translation
    // step rebuilds the rest.
    job.descriptionByLocale = changed && byLocale[job.sourceLang]
      ? { [job.sourceLang]: byLocale[job.sourceLang] }
      : byLocale;
    if (changed) job.needsRetranslation = true;
    dropStaleLocaleDescriptions(job);
    return job;
  });
}

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const nonCompanyJobs = (Array.isArray(existing) ? existing : []).filter((j) => !isCompanyJob(j));
  const existingCompanyJobs = (Array.isArray(existing) ? existing : []).filter(isCompanyJob);

  const existingByKey = new Map();
  for (const job of existingCompanyJobs) {
    const key = extractStableJobId(job?.url);
    if (key) existingByKey.set(key, job);
  }
  const existingKeys = new Set(existingByKey.keys());
  const discoveredKeys = new Set(discoveredJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean));
  const added = [...discoveredKeys].filter((k) => !existingKeys.has(k)).length;
  const updated = [...discoveredKeys].filter((k) => existingKeys.has(k)).length;

  const merged = mergeZambonJobs(existingCompanyJobs, discoveredJobs);

  const final = [...nonCompanyJobs, ...merged];
  writeJsonAtomic(DATA_JOBS, final);
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  writeJsonAtomic(PUBLIC_JOBS, final);
  console.log(`📦 Merge: ➕ ${added}, 🔄 ${updated}, 📊 ${final.length} total`);
  return merged;
}

function updateAdapterConfig(seedUrls) {
  const p = path.join(ADAPTERS_DIR, `${COMPANY_KEY}.json`);
  const a = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
  Object.assign(a, { companyKey: COMPANY_KEY, companyName: COMPANY_NAME, companyHost: COMPANY_HOST, enabled: true, priority: 10, crawlerModes: ['html'], seedUrls: seedUrls.length ? seedUrls : [CAREERS_URL], notes: `zambon.com NcorePlat ATS — national Swiss feed filtered by source country=CH. Current Swiss postings use the source-backed Zambon Switzerland SA site at ${ZAMBON_SWISS_SITE.city} (${ZAMBON_SWISS_SITE.canton}); this is not a regional facet.`, updatedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(a, null, 2) + '\n');
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, COMPANY_NAME);
  console.log('═══════════════════════════════════════════════');
  console.log('  Zambon Svizzera SA — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════\n');
    const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob))
  const discovered = await fetchJobs();
  if (!discovered.length) { console.log('⚠️ No Zambon jobs discovered.'); return; }
  updateAdapterConfig(discovered.map((j) => j.url));
  const mergedCompanyJobs = await mergeJobs(discovered);
  console.log('\n🌐 Running base crawler for AI localization...');
  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, localizeOnlyCompanyKeys: COMPANY_KEY, forceLocalizeKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true });
  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_ZAMBON_STRICT', label: COMPANY_NAME, dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, locales: LOCALES, isTrustedDomain, untrustedDomainReason: 'url_not_zambon_domain', failWhenNoJobs: false });
  const afterSnapshot = snapshotJobSlugs((readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS)).filter(isCompanyJob));
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME); writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);
  const _dur = getCrawlerElapsedMs();
  const _sliceJobs = mergedCompanyJobs;
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: COMPANY_NAME, generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _dur, avgDurationMs: _dur, durationHistory: [_dur], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: (diff.unchangedJobs || []).slice(0, 30) });
  await assembleJobsDataset();
  console.log('\n✅ Zambon crawler complete.');
}

// Guarded so tests can import the helpers without running a live crawl that
// writes the slice and the summary under data/.
if (isInvokedDirectly(import.meta.url)) {
  main().catch((err) => exitCrawlerOnError(err, 'Zambon'));
}
