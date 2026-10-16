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
import { writeSummaryCrawlerSlice,
  writeJobsCrawlerSliceVerified, registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, mergePreserveLocaleData } from './lib/dedicated-crawler-common.mjs';
import { dropStaleLocaleDescriptions, sourceLangOfBody, sourceSlotTitleAndSlug } from './lib/source-locale-slots.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { parseListingPage, slugify, detectCategory, detectExperienceLevel, inferEmploymentType, ZAMBON_SWISS_SITE, extractZambonJobBody } from './lib/zambon-job-parser.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { markAuthoritativeEmptySnapshot, isAuthoritativeEmptySnapshot } from './lib/authoritative-empty-snapshot.mjs';
import { archiveRemovedJobsToSlice } from './lib/expired-jobs-archive.mjs';
import { classifyCountryValue } from './lib/prospector/country-inventory.mjs';
import { isExplicitlyForeign } from './lib/prospector/location-evidence.mjs';

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
const EXPIRED_JOBS_ARCHIVE = path.join(ROOT, 'data', 'jobs', 'expired', 'by-crawler', `${COMPANY_KEY}.json`);
// The archived Zambon detail records were crawled from the English NcorePlat
// page. The archive writer does not persist sourceLang, so use only this
// explicitly evidenced slot; never pick an arbitrary locale as a fallback.
const ARCHIVE_SOURCE_LOCALE = 'en';

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

function classifyCountryEvidence(values = []) {
  const classifications = values
    .map((value) => classifyCountryValue(value))
    .filter((classification) => classification !== 'unknown');
  const hasSwiss = classifications.includes('CH');
  const hasForeign = classifications.includes('foreign');
  if (hasSwiss && hasForeign) return 'unknown';
  if (hasSwiss) return 'swiss';
  if (hasForeign) return 'foreign';
  return 'unknown';
}

/**
 * Classify the API's country evidence without treating an arbitrary non-empty
 * value as a foreign country. Unknown values must keep the source fail-closed.
 */
export function classifyZambonApiLocation(job = {}) {
  return classifyCountryEvidence([job?.country, job?.country_label]);
}

/**
 * Classify the HTML listing location. Cadempino is the reviewed Swiss source
 * site; country labels are accepted only when the shared country inventory
 * recognises them. A free-form unknown location is never a zero proof.
 */
export function classifyZambonHtmlLocation(rawLocation = '') {
  const location = normalize(rawLocation);
  if (!location) return 'unknown';

  const segments = String(rawLocation)
    .split(/[,;/|()]+|\s+-\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const countryClassifications = segments
    .map((segment) => classifyCountryValue(segment))
    .filter((classification) => classification !== 'unknown');
  const hasSwissCountry = countryClassifications.includes('CH');
  const hasForeignCountry = countryClassifications.includes('foreign');
  const hasSwissSite = /\bcadempino\b/.test(location);

  if (hasSwissCountry && hasForeignCountry) return 'unknown';
  if (hasForeignCountry && (hasSwissCountry || hasSwissSite)) return 'unknown';
  if (hasForeignCountry || isExplicitlyForeign(rawLocation)) return 'foreign';
  if (hasSwissCountry || hasSwissSite) return 'swiss';
  return 'unknown';
}

/**
 * Return the API rows and outcome that the runner may safely publish. A
 * filtered-empty result is valid only when every discovered row is explicitly
 * foreign; any unknown row makes the batch a parser/source failure.
 */
export function classifyZambonApiRows(allJobs = []) {
  const rows = Array.isArray(allJobs) ? allJobs : [];
  const classifications = rows.map(classifyZambonApiLocation);
  const swissJobs = rows.filter((_, index) => classifications[index] === 'swiss');

  if (classifications.some((classification) => classification === 'unknown')) {
    return {
      swissJobs: [],
      parsed: 0,
      lastFetchOutcome: 'selector_miss',
      abortKind: 'no-jobs-parsed',
    };
  }
  if (swissJobs.length === 0) {
    return {
      swissJobs,
      parsed: 0,
      lastFetchOutcome: rows.length > 0 ? 'filtered_empty' : 'selector_miss',
      abortKind: rows.length > 0 ? null : 'no-jobs-parsed',
    };
  }
  return { swissJobs, parsed: swissJobs.length, lastFetchOutcome: 'ok', abortKind: null };
}

/**
 * Apply the same fail-closed zero-path contract to HTML listings. Unknown
 * locations are not silently dropped as if they were known foreign rows.
 */
export function classifyZambonHtmlListings(listings = []) {
  const rows = Array.isArray(listings) ? listings : [];
  const classifications = rows.map((listing) => classifyZambonHtmlLocation(listing?.location));
  const sourceBackedListings = rows.filter((_, index) => classifications[index] === 'swiss');

  if (classifications.some((classification) => classification === 'unknown')) {
    return {
      sourceBackedListings: [],
      classifications,
      parsed: 0,
      lastFetchOutcome: 'selector_miss',
      abortKind: 'no-jobs-parsed',
    };
  }
  if (sourceBackedListings.length === 0) {
    return {
      sourceBackedListings,
      classifications,
      parsed: 0,
      lastFetchOutcome: rows.length > 0 ? 'filtered_empty' : 'selector_miss',
      abortKind: rows.length > 0 ? null : 'no-jobs-parsed',
    };
  }
  return {
    sourceBackedListings,
    classifications,
    parsed: sourceBackedListings.length,
    lastFetchOutcome: 'ok',
    abortKind: null,
  };
}

/**
 * Read the careers API envelope without confusing a successful source-zero
 * with a parser miss. Only the documented HTTP/JSON success envelope with an
 * explicit empty `data` array proves that the source has no positions.
 */
export function parseZambonApiPayload(body) {
  const allJobs = body?.data ?? body;
  if (!Array.isArray(allJobs)) throw new Error('API response is not an array');
  if (!Array.isArray(body) && body?.status === 200 && Array.isArray(body.data) && body.data.length === 0) {
    return markAuthoritativeEmptySnapshot(
      allJobs,
      'Zambon careers API returned a successful status=200 envelope with data=[]',
    );
  }
  return allJobs;
}

const DETAIL_DELAY_MS = 1000;
// Fragments only the runner ever wrote: the description it composed from API
// metadata ("<titolo>: opportunità professionale presso Zambon Svizzera SA, …"
// and "<titolo> — posizione presso Zambon Svizzera SA a Cadempino (TI).").
// Only ever recognised to be removed from stored records.
export const ZAMBON_FABRICATED_DESCRIPTION_RE = /opportunità professionale presso Zambon Svizzera SA|— posizione presso Zambon Svizzera SA a /;

function readZambonExpiredJobs() {
  try {
    const parsed = JSON.parse(fs.readFileSync(EXPIRED_JOBS_ARCHIVE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function archivedZambonSourceUrl(entry = {}) {
  const identity = String(entry?.sourceIdentity || '').trim();
  return identity.startsWith('url:') ? identity.slice('url:'.length) : '';
}

function buildZambonArchiveFallback(row, archivedEntry) {
  const archivedDescriptions = archivedEntry?.descriptionByLocale;
  if (!archivedDescriptions || typeof archivedDescriptions !== 'object' || Array.isArray(archivedDescriptions)) {
    return null;
  }
  const sourceBody = String(archivedDescriptions[ARCHIVE_SOURCE_LOCALE] || '').trim();
  if (!meetsSourceBodyFloor(sourceBody)) return null;

  const restored = buildZambonJob(row, sourceBody);
  const descriptionByLocale = Object.fromEntries(
    Object.entries(archivedDescriptions)
      .filter(([locale, text]) => LOCALES.includes(locale) && meetsSourceBodyFloor(text))
      .map(([locale, text]) => [locale, String(text).trim()]),
  );
  descriptionByLocale[ARCHIVE_SOURCE_LOCALE] = sourceBody;

  return {
    ...restored,
    descriptionByLocale,
    titleByLocale: {
      ...(archivedEntry.titleByLocale || {}),
      ...(restored.titleByLocale || {}),
    },
    slugByLocale: {
      ...(archivedEntry.slugByLocale || {}),
      ...(restored.slugByLocale || {}),
    },
    ...(archivedEntry.slug ? { slug: archivedEntry.slug } : {}),
    ...(Array.isArray(archivedEntry.previousSlugs) ? { previousSlugs: [...archivedEntry.previousSlugs] } : {}),
    ...(archivedEntry.previousSlugsByLocale && typeof archivedEntry.previousSlugsByLocale === 'object'
      ? { previousSlugsByLocale: structuredClone(archivedEntry.previousSlugsByLocale) }
      : {}),
    ...(archivedEntry.firstSeenAt ? { firstSeenAt: archivedEntry.firstSeenAt } : {}),
  };
}

/**
 * Restore current source rows from source-backed expired records when the
 * listing is readable but every NcorePlat detail request is blocked. Matching
 * requires an unambiguous stable URL key and the archive's explicit English
 * source slot with the shared 50-word floor. No title or locale guess is used.
 */
export function restoreZambonArchivedJobs(rows = [], archivedJobs = []) {
  const archivedByKey = new Map();
  const ambiguousKeys = new Set();
  for (const entry of Array.isArray(archivedJobs) ? archivedJobs : []) {
    const key = extractStableJobId(archivedZambonSourceUrl(entry));
    if (!key) continue;
    if (archivedByKey.has(key)) {
      ambiguousKeys.add(key);
      continue;
    }
    archivedByKey.set(key, entry);
  }

  return (Array.isArray(rows) ? rows : []).map((row) => {
    const key = extractStableJobId(row?.url);
    if (!key || ambiguousKeys.has(key)) return null;
    const archivedEntry = archivedByKey.get(key);
    return archivedEntry ? buildZambonArchiveFallback(row, archivedEntry) : null;
  }).filter(Boolean);
}

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

async function readZambonBodies(rows, { archivedJobs = [], summaryCounts = null } = {}) {
  let read = 0;
  let restored = 0;
  const sourceBodyFailures = [];
  const archivedFallbacks = new Map(
    restoreZambonArchivedJobs(rows, archivedJobs)
      .map((job) => [extractStableJobId(job.url), job])
      .filter(([key]) => Boolean(key)),
  );
  const jobs = [];
  for (const [index, row] of rows.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, DETAIL_DELAY_MS));
    const job = buildZambonJob(row, extractZambonJobBody(await fetchPage(row.url)));
    if (job.description) read += 1;
    else {
      const fallback = archivedFallbacks.get(extractStableJobId(row?.url));
      sourceBodyFailures.push({
        title: row.title,
        url: row.url,
        reason: 'detail_body_unreadable',
        ...(fallback ? { fallback: 'expired-job-archive' } : {}),
      });
      if (fallback) {
        restored += 1;
        console.warn(`  ⚠️ ${row.title}: no vacancy text on ${row.url}; using its source-backed expired archive record.`);
        jobs.push(fallback);
      } else {
        console.warn(`  ⚠️ ${row.title}: no vacancy text on ${row.url}`);
        jobs.push(job);
      }
    }
  }
  const parsed = jobs.filter((job) => Boolean(job.description)).length;
  if (summaryCounts) {
    summaryCounts.parsed = parsed;
    summaryCounts.lastFetchOutcome = read === rows.length ? 'ok' : 'anti_bot_block';
    summaryCounts.sourceBodyFailures = sourceBodyFailures;
    summaryCounts.abortKind = null;
  }
  // Not one page readable is a source-level failure (e.g. a WAF in front of
  // NcorePlat), not "every vacancy lost its text": return nothing only when
  // the source-backed archive cannot safely recover any current row. When it
  // can, the recovered rows keep the active slice publishable without making
  // up a description.
  if (rows.length > 0 && parsed === 0) {
    if (summaryCounts) summaryCounts.abortKind = 'no-jobs-parsed';
    console.warn('  ⚠️ No NcorePlat page or source-backed archive record readable in this run — keeping the stored Zambon slice.');
    return [];
  }
  if (restored > 0) {
    console.log(`  🗄️ Recovered ${restored} current Zambon row(s) from source-backed expired records after detail blocking.`);
  }
  return jobs;
}

async function fetchJobs(summaryCounts = null) {
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
    const allJobs = parseZambonApiPayload(body);
    if (summaryCounts) {
      summaryCounts.discovered = allJobs.length;
      summaryCounts.lastFetchOutcome = 'ok';
      summaryCounts.abortKind = null;
    }
    if (isAuthoritativeEmptySnapshot(allJobs)) {
      console.log('  📋 Zambon careers API explicitly reports no open positions.');
      if (summaryCounts) summaryCounts.parsed = 0;
      return allJobs;
    }

    // Filter to Switzerland only, but fail closed when the source's location
    // vocabulary is unknown rather than treating it as a healthy foreign zero.
    const locationResult = classifyZambonApiRows(allJobs);
    const swissJobs = locationResult.swissJobs;
    console.log(`  📋 API returned ${allJobs.length} total positions, ${swissJobs.length} in Switzerland`);

    if (summaryCounts) {
      summaryCounts.parsed = locationResult.parsed;
      summaryCounts.lastFetchOutcome = locationResult.lastFetchOutcome;
      summaryCounts.abortKind = locationResult.abortKind;
    }
    if (locationResult.lastFetchOutcome !== 'ok') {
      return [];
    }

    const rows = swissJobs.map((raw) => ({
      id: `zambon-${raw.id}`,
      url: raw.web_url || `https://app.ncoreplat.com/jobposition/${raw.id}`,
      title: (raw.title || '').trim(),
      datePosted: raw.opening_date || '',
      contract: raw.contract_type_3 || '',
      department: raw.job_family || '',
      seniority: raw.seniority || '',
    }));
    return await readZambonBodies(rows, {
      archivedJobs: readZambonExpiredJobs(),
      summaryCounts,
    });
  } catch (err) {
    console.warn(`⚠️ API fetch failed: ${err.message} — falling back to HTML parsing`);
  } finally {
    clearTimeout(timer);
  }

  // Fallback: HTML parsing (unlikely to work for Vue.js rendered pages)
  console.log(`🔍 Fallback: Fetching Zambon jobs from ${CAREERS_URL}`);
  const html = await fetchPage(CAREERS_URL, 25000);
  if (!html) {
    if (summaryCounts) {
      summaryCounts.discovered = 0;
      summaryCounts.parsed = 0;
      summaryCounts.lastFetchOutcome = 'connection_error';
      summaryCounts.abortKind = 'connection-level-fetch';
    }
    console.error('❌ Failed to fetch Zambon careers page.');
    return [];
  }
  const listings = parseListingPage(html);
  console.log(`  📋 HTML fallback found: ${listings.length} jobs`);
  if (summaryCounts) summaryCounts.discovered = listings.length;

  const locationResult = classifyZambonHtmlListings(listings);
  for (const [index, raw] of listings.entries()) {
    const classification = locationResult.classifications[index];
    if (classification === 'foreign') {
      console.warn(`  ⏭️ Dropping fallback row with non-Cadempino source location: ${raw.location}`);
    } else if (classification === 'unknown') {
      console.warn(`  ⚠️ Unrecognized fallback source location: ${raw.location}`);
    }
  }
  if (summaryCounts) {
    summaryCounts.parsed = locationResult.parsed;
    summaryCounts.lastFetchOutcome = locationResult.lastFetchOutcome;
    summaryCounts.abortKind = locationResult.abortKind;
  }
  if (locationResult.lastFetchOutcome !== 'ok') {
    return [];
  }
  const sourceBackedListings = locationResult.sourceBackedListings;

  const rows = sourceBackedListings.map((raw) => ({
    url: raw.url,
    title: raw.title,
    source: 'zambon-careers-crawler',
  }));
  return readZambonBodies(rows, {
    archivedJobs: readZambonExpiredJobs(),
    summaryCounts,
  });
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
  // A valid empty API envelope is the only empty batch allowed to retire
  // stored offers. Bare [] still means the source was not read completely.
  if (isAuthoritativeEmptySnapshot(discoveredJobs)) return [];
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

/**
 * Diff the stored company slice against the slice that the merge actually
 * produced, optionally archiving routes retired by an authoritative empty
 * snapshot. The post-merge argument is deliberately the returned slice: the
 * scratch dataset may still contain the prior jobs until the verified writer
 * publishes the replacement.
 */
export function computeZambonCrawlResult(beforeJobs = [], afterJobs = [], {
  archiveRemoved = false,
  archiveDir,
} = {}) {
  const companyJobs = (jobs) => (Array.isArray(jobs) ? jobs : []).filter(isCompanyJob);
  const beforeSnapshot = snapshotJobSlugs(companyJobs(beforeJobs));
  const afterSnapshot = snapshotJobSlugs(companyJobs(afterJobs));
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  const archived = archiveRemoved
    ? archiveRemovedJobsToSlice(
      diff.removedJobs,
      COMPANY_KEY,
      archiveDir ? { dir: archiveDir } : {},
    )
    : 0;
  return { diff, archived };
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
  const summaryCounts = {
    discovered: null,
    parsed: null,
    lastFetchOutcome: null,
    abortKind: null,
    sourceBodyFailures: [],
  };
  registerCrawlerSummaryGuard(COMPANY_KEY, COMPANY_NAME, summaryCounts);
  console.log('═══════════════════════════════════════════════');
  console.log('  Zambon Svizzera SA — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════\n');
  const beforeJobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob);
  const discovered = await fetchJobs(summaryCounts);
  const authoritativeEmptySnapshot = isAuthoritativeEmptySnapshot(discovered);
  const filteredEmpty = summaryCounts.lastFetchOutcome === 'filtered_empty';
  if (!discovered.length && !authoritativeEmptySnapshot && !filteredEmpty) {
    console.log('⚠️ No Zambon jobs discovered from a complete source snapshot; keeping the stored slice.');
    return;
  }
  updateAdapterConfig(discovered.map((j) => j.url));
  const mergedCompanyJobs = await mergeJobs(discovered);
  if (authoritativeEmptySnapshot) {
    console.log('  ✅ Publishing source-confirmed empty Zambon snapshot; prior offers will be retired.');
  } else {
    console.log('\n🌐 Running base crawler for AI localization...');
    await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, localizeOnlyCompanyKeys: COMPANY_KEY, forceLocalizeKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true });
  }
  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_ZAMBON_STRICT', label: COMPANY_NAME, dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, locales: LOCALES, isTrustedDomain, untrustedDomainReason: 'url_not_zambon_domain', failWhenNoJobs: false });
  const { diff, archived } = computeZambonCrawlResult(beforeJobs, mergedCompanyJobs, {
    archiveRemoved: authoritativeEmptySnapshot,
  });
  printCrawlChangeSummary(diff, COMPANY_NAME); writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);
  const _dur = getCrawlerElapsedMs();
  const _sliceJobs = mergedCompanyJobs;
  await writeJobsCrawlerSliceVerified(COMPANY_KEY, _sliceJobs, {
    skipShrinkGuard: authoritativeEmptySnapshot,
  });
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: COMPANY_NAME,
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    discovered: Number.isFinite(summaryCounts.discovered) ? summaryCounts.discovered : discovered.length,
    parsed: Number.isFinite(summaryCounts.parsed) ? summaryCounts.parsed : discovered.length,
    written: _sliceJobs.length,
    lastFetchOutcome: summaryCounts.lastFetchOutcome || 'ok',
    abortKind: summaryCounts.abortKind,
    sourceBodyFailureCount: summaryCounts.sourceBodyFailures.length,
    sourceBodyFailures: summaryCounts.sourceBodyFailures,
    authoritativeEmptySnapshot,
    authoritativeSnapshotVerified: authoritativeEmptySnapshot,
    ...(authoritativeEmptySnapshot
      ? { authoritativeEmptyEvidence: discovered.authoritativeEmptyEvidence }
      : {}),
    newCount: diff.newJobs.length,
    updatedCount: diff.updatedJobs.length,
    removedCount: diff.removedJobs.length,
    unchangedCount: diff.unchangedCount,
    durationMs: _dur,
    avgDurationMs: _dur,
    durationHistory: [_dur],
    newJobs: diff.newJobs.slice(0, 30),
    updatedJobs: diff.updatedJobs.slice(0, 30),
    removedJobs: diff.removedJobs.slice(0, 30),
    unchangedJobs: (diff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
  if (archived > 0) console.log(`📦 Archived ${archived} retired Zambon route(s) for expired-job soft landing.`);
  console.log('\n✅ Zambon crawler complete.');
}

// Guarded so tests can import the helpers without running a live crawl that
// writes the slice and the summary under data/.
if (isInvokedDirectly(import.meta.url)) {
  main().catch((err) => exitCrawlerOnError(err, 'Zambon'));
}
