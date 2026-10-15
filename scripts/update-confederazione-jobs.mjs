#!/usr/bin/env node
/**
 * Confederazione Svizzera — CH-wide Federal Jobs Crawler
 *
 * Crawls Swiss federal government jobs across ALL 26 cantons via the
 * Prospective.ch API (medium 1000624 — Stellenportal Bund / jobs.admin.ch).
 *
 * The Confederazione Svizzera (federal government) is a national CH-wide
 * employer, so this crawler fetches the unfiltered national listing (no
 * region facet) and keeps every job whose location resolves to a Swiss
 * canton via inferAnyCanton (all 26 cantons). Foreign postings ("Estero")
 * and jobs with no resolvable Swiss canton are dropped.
 *
 * This crawler fills the gap left by the department-specific VTG and Agroscope
 * crawlers. It captures federal jobs from ALL departments (DATEC, DEFR, DFGP,
 * TPF, etc.) including apprenticeships ("Lernende") and internships
 * ("Praktikanten"), which are categorized under field 25 values:
 *   - 1091487 = Professionisti e persone al primo impiego
 *   - 1091485 = Scolari (apprendisti/stage)
 *   - 1091486 = Studenti e neodiplomati universitari
 *
 * To avoid duplicates with VTG and Agroscope crawlers, this script skips
 * any job whose direct link URL already exists in jobs.json under a
 * different company key.
 *
 * 1. Fetches the unfiltered national listing via API (no region filter)
 * 2. Infers per-job canton from the location text (inferAnyCanton, 26 cantons)
 * 3. Keeps only jobs that resolve to a Swiss canton (drops "Estero"/foreign)
 * 4. The API carries tasks, requirements, benefits and unit profile; each
 *    detail page adds the role summary, key facts and additional information
 * 5. Skips jobs already covered by VTG / Agroscope crawlers
 * 6. Merges into data/jobs.json
 */

import { sourcePostingDateFields, mergeSourcePostingDates } from './lib/source-posting-date.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { exitCrawlerOnError, fetchHtml, fetchJson } from './lib/crawler-template.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { fileURLToPath } from 'node:url';
import { safeLocationToken } from './lib/safe-location-token.mjs';
import {
  printPublishedJobUrls,
  writeJobsSummary,
  snapshotJobSlugs,
  computeCrawlDiff,
  printCrawlChangeSummary,
  writeCrawlChangeSummaryToGH,
  setCrawlerStartTime,
  getCrawlerElapsedMs,
} from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import {
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  detectLang,
  mergeLocaleTextMap,
  captureLostSlugs,
} from './lib/dedicated-crawler-common.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { inferAnyCanton, normalizeCantonCode } from './lib/target-swiss-locations.mjs';
import { normalizeFederalJobLocation } from './lib/federal-job-normalization.mjs';
import {
  composeFederalJobDescription,
  federalApiDescription,
  parseFederalJobDetailExtras,
} from './lib/federal-job-detail.mjs';
import { preferEnrichedDescription } from './lib/enriched-description-fallback.mjs';
import { meetsSourceBodyFloor } from './lib/source-body-floor.mjs';
import { mapPool } from './lib/prospector/polite-fetch.mjs';
import { getCompanyDefaults, getCantonDisplayName } from './lib/crawler-location-config.mjs';
import { assertJsonListShape } from './lib/assert-json-list-shape.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { truncateSlugAtWordBoundary } from './lib/slug-truncate.mjs';
import {
  createMutableFeedPaginationTracker,
  recordMutableFeedPageWithRetry,
} from './lib/pagination-identity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'confederazione-ticino.json');

const COMPANY_KEY = 'confederazione-ticino';
// Per-crawler-scoped scratch path — this crawler does its own fetch+merge
// (no runDedicatedBaseCrawler call), but still runs as one of ~25 sibling
// background steps sharing a filesystem checkout in CI, so writing straight
// to the shared, gitignored, CI-absent data/jobs.json is the same
// cross-process-racy write pattern behind #3769/#3770. Scope it per-company.
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'Confederazione Svizzera';
const COMPANY_HOST = 'jobs.admin.ch';
const COMPANY_DOMAIN = 'admin.ch';
const API_BASE = 'https://ohws.prospective.ch/public/v1/medium/1000624/jobs';
// CH-wide: the federal government is a national employer, so we fetch the
// unfiltered national listing (no `f=region:` facet) and keep every job whose
// location resolves to a Swiss canton via inferAnyCanton (all 26 cantons).
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 25000;

/* ── Helpers ──────────────────────────────────────────────── */

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    // Open each <li> as a line-start bullet so list structure survives the strip (#2476).
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function slugify(value = '') {
  const slug = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return truncateSlugAtWordBoundary(slug, 180);
}

/* ── Matchers ──────────────────────────────────────────────── */

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  return key === COMPANY_KEY || key === 'confederazione-ticino';
}

/** Company keys whose jobs we skip to avoid duplicates. */
const COVERED_KEYS = new Set(['vtg', 'agroscope', 'agroscope-defr']);

/**
 * Extract the UUID viewkey from a jobs.admin.ch URL.
 * URLs have the form: https://jobs.admin.ch/{locale-path}/{slug}/{uuid}
 * The UUID is always the last path segment.
 */
function extractViewkey(url = '') {
  const match = String(url).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match ? match[1].toLowerCase() : '';
}

/* ── API Parsing ──────────────────────────────────────────── */

function parseApiJob(j = {}) {
  const attrs = j.attributes || {};
  const szas = j.szas || {};
  const links = j.links || {};

  const locationRaw = (attrs.arbeitsort || [])[0] || '';
  const regionRaw = (attrs.region || [])[0] || '';
  const normalizedLocation = normalizeFederalJobLocation(locationRaw);
  const pensum = (attrs['75'] || [])[0] || '';
  const pensumMin = szas['sza_pensum.min'] || szas.sza_pensum_min || '';

  const city =
    normalizedLocation.addressLocality ||
    locationRaw.match(/^\d{4}\s+(.+)$/)?.[1]?.trim() ||
    locationRaw.replace(/,\s*Schweiz$/i, '').trim();

  // Per-job canton (CH-wide). Prefer the normalized location canton, then infer
  // from the location text via inferAnyCanton (all 26 cantons). Most federal
  // region labels are composite (e.g. "Espace Mittelland (BE, FR, JU, NE, SO)"),
  // so we infer from the actual arbeitsort/city rather than trust the label.
  // A single-canton region label is used only as a last resort.
  const cantonMatch = regionRaw.match(/\(([A-Z]{2})\)$/);
  const cantonFromRegion = normalizeCantonCode(cantonMatch ? cantonMatch[1] : '');
  const canton = normalizedLocation.canton
    || inferAnyCanton(locationRaw)
    || inferAnyCanton(normalizedLocation.location || '')
    || inferAnyCanton(normalizedLocation.addressLocality || '')
    || cantonFromRegion || '';

  // Department info
  const department = (attrs.verwaltungseinheit || [])[0] || '';
  const subDeptKeys = Object.keys(attrs).filter((k) => k.startsWith('verwaltungseinheit_'));
  const subDepartment = subDeptKeys.length > 0 ? (attrs[subDeptKeys[0]] || [])[0] || '' : '';

  // Employment type from field 25
  const employmentCategory = (attrs['25'] || [])[0] || '';

  // Tasks, requirements, benefits and the unit profile — the full API text.
  // Only tasks + requirements used to be published (23-35 % of the detail
  // page); `enrichWithDetailPages` adds the page-only sections on top.
  const description = federalApiDescription(szas);

  return {
    id: String(j.id || ''),
    viewkey: j.viewkey || '',
    title: normalizeSpace(j.title),
    city,
    location: normalizedLocation.location || locationRaw,
    region: regionRaw,
    canton,
    department,
    subDepartment,
    employmentCategory,
    pensum: pensum ? `${pensumMin || pensum}-${pensum}%` : '',
    pensumMax: pensum,
    pensumMin: pensumMin || pensum,
    description,
    applyUrl: szas.sza_apply_link || '',
    directLink: links.directlink || '',
    // Federal Prospective medium1000624 start_date is the publication instant:
    // jobs.admin.ch detail c927355d-e225-479e-9c1b-fa450252ff02 declares
    // JSON-LD datePosted2026-10-02 alongside API2026-10-01T22:00:00Z;
    // the employment starts in March2027. Preserve the complete source instant.
    ...sourcePostingDateFields(j.start_date),
    endDate: j.end_date || '',
    language: j.language || 'it',
    fieldOfActivity: szas.sza_field_of_activity || (attrs.taetigkeitsbereich || [])[0] || '',
    role: szas.sza_role || (attrs.funktion || [])[0] || '',
    benefits: szas.sza_benefits ? stripHtml(szas.sza_benefits) : '',
  };
}

/* ── Content Building ─────────────────────────────────────── */

function inferCategory(job = {}) {
  const haystack = `${job.fieldOfActivity || ''} ${job.title || ''} ${job.role || ''} ${job.employmentCategory || ''}`.toLowerCase();
  if (/lernend|apprendist|lehrstell|apprenti|scolari/i.test(haystack)) return 'apprenticeship';
  if (/\b(praktikan|stagiar|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|studenti|neodiplomati)/i.test(haystack)) return 'internship';
  if (/informatica|software|ict|it\b|digital|cyber/i.test(haystack)) return 'it';
  if (/ingegner|engineer|techni|tecnico/i.test(haystack)) return 'engineering';
  if (/scien|ricerca|research|forschung/i.test(haystack)) return 'science';
  if (/giurid|legal|recht|richter|diritto/i.test(haystack)) return 'legal';
  if (/dirigen|leader|responsabile|leiter|chef/i.test(haystack)) return 'management';
  if (/amministra|admin|sachbearbeit|segretari/i.test(haystack)) return 'admin';
  if (/logisti|trasport|transport|magazz/i.test(haystack)) return 'logistics';
  if (/dolmetsch|interprete|tradut|translat/i.test(haystack)) return 'translation';
  if (/koch|cuoc|cucina|küch|gastro/i.test(haystack)) return 'hospitality';
  if (/mechatronik|meccanico|automat/i.test(haystack)) return 'engineering';
  return 'public-administration';
}

function inferEmploymentType(job = {}) {
  const cat = (job.employmentCategory || '').toLowerCase();
  if (/scolari/i.test(cat)) return 'apprenticeship';
  if (/studenti|neodiplomati/i.test(cat)) return 'internship';
  if (job.pensumMax === '100') return 'full-time';
  return 'part-time';
}

// German words that must NOT appear in an Italian slug
const GERMAN_SLUG_WORDS = /(?:^|-)(?:als|und|fur|oder|frau|mann|fach|stelle|lehrstelle|lehre|mitarbeiter|leiter|stellvertretend|verkauf|lernend|chauffeu|gartencenter|befristet|ablosen|disponentin|disponent|ladenleit|logistiker|projektleiter|elektroinstallateur|elektroplaner|unterhaltsfachmann|servicetechniker|immobilienberater|bauleiter|zeichner|fachrichtung|ingenieurbau|tunnelbau|tiefbau|innendienst|generalagentur|vorsorge|vermogen|wissenschaftlich|detailhandels|bekampfung|japankafer|lager)(?:-|$)/i;

/**
 * Build localised title/description/slug maps for a job.
 * Only the detected source-language slot is populated here.
 * The locale-fill step (translateMissingJobLocales) will translate the
 * remaining locales so we never store a German string in the IT slot.
 */
function buildLocalizedContent(job = {}, sourceLang = 'it') {
  const title = String(job.title || '').trim();
  const canton = job.canton || DEFAULT_CANTON;
  // CH-wide: when the API has no city, fall back to the localized canton display
  // name (e.g. 'Zurigo'/'Berna', not the bare 'ZH'/'BE' code) so the
  // slug/description/addressLocality stays region-correct for any of the 26
  // cantons (the city is virtually always present; rare last-resort token).
  const regionLabel = getCantonDisplayName(canton, 'it') || canton;
  const city = String(job.city || regionLabel).trim();
  const description = String(job.description || '').trim();

  // Only the source's own text: the full API/page text. The old padding for
  // bodies under 50 words ("Posizione nell'Amministrazione federale
  // svizzera…", a generic employer paragraph, "Candidati online su
  // jobs.admin.ch.") and the title-as-body fallback published text the
  // posting does not contain (1/261 jobs of slice 995a6583431); an empty body
  // is handled in mergeJobs (stored source text, else not published).
  const sourceDesc = description;

  return {
    titleByLocale: { [sourceLang]: title },
    descriptionByLocale: sourceDesc ? { [sourceLang]: sourceDesc } : {},
    // Slug-only guard: `job.city` can be the literal "undefined"/"null" string
    // (truthy) → `-undefined` in an active slug (#952, class #900/#901). Fallback is
    // the localized region label, region-correct. addressLocality untouched.
    slugByLocale: { [sourceLang]: slugify(`${title} confederazione ${safeLocationToken(city, regionLabel)}`) },
  };
}

/* ── Fetching ─────────────────────────────────────────────── */

/**
 * Fetch the unfiltered national federal listing (all 26 cantons).
 * No `f=region:` facet → the API returns every Swiss federal job.
 */
async function fetchNationalListings() {
  console.log('\nFetching CH-wide federal jobs (national, unfiltered)...');

  const allItems = [];
  let offset = 0;
  const limit = 100;
  const maxPages = 1000;
  let declaredTotal = null;
  let pageCount = 0;
  const progress = createMutableFeedPaginationTracker({
    getIdentity: (job) => job?.viewkey || job?.id,
    getFingerprint: (job) => JSON.stringify(job),
    source: 'Confederazione API',
  });

  const fetchPage = async (pageOffset) => {
    const url = `${API_BASE}?lang=it&offset=${pageOffset}&limit=${limit}`;
    console.log(`  API: ${url}`);

    const data = await fetchJson(url, {
      timeoutMs: TIMEOUT_MS,
      headers: {
        Origin: 'https://jobs.admin.ch',
        Referer: 'https://jobs.admin.ch/',
      },
    });
    const rawItems = data?.jobs;
    assertJsonListShape(data, { key: 'jobs', source: 'confederazione:CH' });
    if (!Array.isArray(rawItems)) {
      throw new Error(`Confederazione API pagination failed at offset ${pageOffset}: expected jobs array.`);
    }
    return { data, items: rawItems.map(parseApiJob) };
  };

  while (true) {
    let page = await fetchPage(offset);
    const recorded = await recordMutableFeedPageWithRetry({
      tracker: progress,
      items: page.items,
      page: `offset ${offset}`,
      reload: async () => {
        page = await fetchPage(offset);
        return page.items;
      },
    });
    const items = recorded.items;

    const rawTotal = page.data?.total;
    if (rawTotal !== undefined && rawTotal !== null && rawTotal !== '') {
      const pageTotal = Number(rawTotal);
      if (!Number.isFinite(pageTotal) || pageTotal < 0) {
        throw new Error(`Confederazione API pagination failed at offset ${offset}: invalid declared total.`);
      }
      // Some API responses expose total=0 while still returning rows. Treat
      // that value as unknown so it cannot truncate a national crawl.
      if (pageTotal > 0) {
        if (declaredTotal !== null && declaredTotal !== pageTotal) {
          throw new Error(
            `Confederazione API pagination failed: declared total changed from ${declaredTotal} to ${pageTotal}.`,
          );
        }
        declaredTotal = pageTotal;
      }
    }

    allItems.push(...items);
    pageCount += 1;

    if (progress.hasReached(declaredTotal)) {
      if (!progress.hasMinimumUniqueCoverage(declaredTotal, 0.9)) {
        throw new Error(
          `Confederazione API pagination incomplete: received ${progress.uniqueCount} unique of `
          + `${declaredTotal} declared rows (minimum coverage 0.9).`,
        );
      }
      break;
    }
    if (items.length === 0) {
      if (declaredTotal !== null && progress.scannedRows < declaredTotal) {
        throw new Error(
          `Confederazione API pagination incomplete: received ${progress.scannedRows} of ${declaredTotal} declared rows (${progress.uniqueCount} unique).`,
        );
      }
      break;
    }
    if (pageCount >= maxPages) {
      throw new Error(
        `Confederazione API pagination incomplete after ${pageCount} pages: ` +
          `${progress.scannedRows} rows received (${progress.uniqueCount} unique)` +
          `${declaredTotal !== null ? ` of ${declaredTotal} declared` : ''}.`,
      );
    }
    offset += limit;
  }

  console.log(`  CH: ${declaredTotal ?? 'unknown'} declared jobs; ${progress.scannedRows} source rows (${progress.uniqueCount} unique records) read from API`);
  return allItems;
}

async function fetchAllListings() {
  // Fetch the national listing and keep only jobs that resolve to a Swiss
  // canton (parseApiJob already inferred per-job canton via inferAnyCanton).
  // Jobs with no resolvable Swiss canton ("Estero"/foreign postings) are dropped.
  const nationalJobs = await fetchNationalListings();
  const swissJobs = nationalJobs.filter((job) => Boolean(job.canton));
  console.log(`  CH-wide → kept ${swissJobs.length} jobs with a Swiss canton (discarded ${nationalJobs.length - swissJobs.length} foreign/unresolved)`);

  // Deduplicate by viewkey
  const seenViewkeys = new Set();
  const allJobs = [];
  for (const job of swissJobs) {
    const vk = job.viewkey || job.id;
    if (!vk) throw new Error('Confederazione API returned a Swiss job without a stable source identity.');
    if (seenViewkeys.has(vk)) continue;
    seenViewkeys.add(vk);
    allJobs.push(job);
  }

  console.log(`\nTotal: ${allJobs.length} unique CH jobs (${swissJobs.length - allJobs.length} duplicates)`);
  return allJobs;
}

/* ── Detail enrichment ─────────────────────────────────────── */

const DETAIL_CONCURRENCY = 3;

function readCoveredViewkeys() {
  // Viewkeys published by the dedicated VTG/Agroscope slices (see mergeJobs).
  const covered = new Set();
  for (const coveredKey of COVERED_KEYS) {
    for (const job of readExistingCrawlerJobs(coveredKey)) {
      const vk = extractViewkey(job.url);
      if (vk) covered.add(vk);
    }
  }
  return covered;
}

/**
 * Add the jobs.admin.ch page-only sections ("Auf den Punkt gebracht", key
 * facts, "Zusätzliche Informationen", notes) to each listing, with the page's
 * own section headings from its JSON-LD. A page that cannot be read leaves
 * the listing on its API text; `mergeJobs` then keeps a previously enriched
 * text (preferEnrichedDescription) instead of shrinking it for one run.
 */
async function enrichWithDetailPages(listings, coveredViewkeys = new Set()) {
  let enriched = 0;
  let failed = 0;
  await mapPool(listings, DETAIL_CONCURRENCY, async (row) => {
    const vk = extractViewkey(row.directLink);
    if (!row.directLink || (vk && coveredViewkeys.has(vk))) return;
    try {
      const extras = parseFederalJobDetailExtras(await fetchHtml(row.directLink));
      const base = extras.roleText || row.description;
      const description = composeFederalJobDescription(base, extras);
      if (description && description !== row.description) {
        row.description = description;
        row.detailEnriched = true;
        enriched += 1;
      }
    } catch {
      failed += 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  console.log(`  Detail pages enriched: ${enriched}/${listings.length}${failed ? ` (${failed} unreadable, API text kept)` : ''}`);
}

/* ── Job Building ─────────────────────────────────────────── */

function buildJob(row) {
  const sourceLang = detectLang(`${row.title} ${row.description}`, row.language || 'it');
  const localized = buildLocalizedContent(row, sourceLang);
  const canton = row.canton || DEFAULT_CANTON;
  // Region label fallback (used only when row.location/city is empty): the
  // 2-letter canton code is region-correct for any of the 26 CH cantons.
  const regionLabel = getCantonDisplayName(canton, 'it') || canton;
  const detailUrl = row.directLink || 'https://jobs.admin.ch/?lang=it';
  const empType = inferEmploymentType(row);

  // Canonical slug: use Italian if available, otherwise fall back to source-lang slug.
  // When sourceLang !== 'it', slugByLocale.it is intentionally absent — locale hardening
  // will translate the title and populate it after the merge.
  const canonicalSlug = localized.slugByLocale.it || localized.slugByLocale[sourceLang] || '';

  return {
    title: localized.titleByLocale.it || localized.titleByLocale[sourceLang] || row.title,
    slug: canonicalSlug,
    url: detailUrl,
    applyUrl: row.applyUrl || detailUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: row.location || regionLabel,
    addressLocality: row.city || row.location || regionLabel,
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferCategory(row),
    sector: 'Pubblica amministrazione',
    source: 'confederazione-dedicated-crawler',
    sourceLang,
    ...mergeSourcePostingDates({}, row),
    validThrough: row.endDate ? row.endDate.slice(0, 10) : '',
    employmentType: empType,
    contractType: empType,
    description: localized.descriptionByLocale.it || localized.descriptionByLocale[sourceLang] || '',
    titleByLocale: localized.titleByLocale,
    descriptionByLocale: localized.descriptionByLocale,
    slugByLocale: localized.slugByLocale,
    detailEnriched: row.detailEnriched === true,
  };
}

/* ── Merge ─────────────────────────────────────────────────── */

// Sentences of the padding the crawler used to add under 50 words (removed in
// issue 5253). A stored body that still carries them is not source text.
const RETIRED_FEDERAL_FILLER_RE = /Posizione nell'Amministrazione federale svizzera|Stelle in der Schweizerischen Bundesverwaltung|Candidati online su jobs\.admin\.ch|Bewerben Sie sich online auf jobs\.admin\.ch/;

export function isRetiredFederalFiller(text = '') {
  return RETIRED_FEDERAL_FILLER_RE.test(String(text || ''));
}

/**
 * The source body a Confederation job may be published with, or null.
 *
 * The publish boundary enforces the 50-word floor on SOURCE text only (the
 * padding that used to lift a short body over 50 words is gone): this run's
 * body when it clears the floor; otherwise the body an earlier run read from
 * the source, when that one clears it and is not the retired filler;
 * otherwise nothing — the job is not published this run.
 *
 * @param {object} job   freshly built job (`sourceLang`, `descriptionByLocale`)
 * @param {object|null} prev  stored record for the same stable id, if any
 * @returns {{ sourceLang: string, body: string } | null}
 */
export function confederazionePublishableBody(job, prev) {
  const freshLang = job?.sourceLang || '';
  const fresh = String(job?.descriptionByLocale?.[freshLang] || '');
  if (freshLang && meetsSourceBodyFloor(fresh) && !isRetiredFederalFiller(fresh)) {
    return { sourceLang: freshLang, body: fresh };
  }
  const storedLang = prev?.sourceLang || freshLang;
  const stored = String(prev?.descriptionByLocale?.[storedLang] || '');
  if (storedLang && meetsSourceBodyFloor(stored) && !isRetiredFederalFiller(stored)) {
    return { sourceLang: storedLang, body: stored };
  }
  return null;
}


function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);

  // Collect viewkeys from the dedicated slices themselves. Reading only the
  // Confederazione slice here made this set permanently empty and let the
  // broad crawler republish VTG/Agroscope vacancies under a second company.
  const coveredViewkeys = readCoveredViewkeys();

  // Filter out jobs whose viewkey is already covered by another crawler
  const newJobs = discoveredJobs.filter((job) => {
    const vk = extractViewkey(job.url);
    if (vk && coveredViewkeys.has(vk)) {
      console.log(`  ⏭️  Skipping (covered by VTG/Agroscope): ${job.title}`);
      return false;
    }
    return true;
  });

  console.log(`\n  New jobs after dedup: ${newJobs.length} (skipped ${discoveredJobs.length - newJobs.length} covered by VTG/Agroscope)`);

  const nonTargetJobs = existing.filter((job) => !isTargetJob(job));
  const targetExisting = existing.filter(isTargetJob);
  const beforeSnapshot = snapshotJobSlugs(targetExisting);
  // Match on the stable id extracted from the URL (the jobs.admin.ch UUID
  // leaf) rather than the raw lowercased URL, so a Prospective title/slug
  // rewrite doesn't orphan the previousSlugs/previousSlugsByLocale history
  // captured below via captureLostSlugs (issue #3699).
  const existingByUrl = new Map();
  for (const job of targetExisting) {
    const key = extractStableJobId(job?.url);
    if (key) existingByUrl.set(key, job);
  }

  let added = 0;
  let updated = 0;
  let unpublished = 0;
  const mergedTarget = newJobs.map((fresh) => {
    const { detailEnriched, ...job } = fresh;
    const key = extractStableJobId(job?.url);
    const prev = key ? existingByUrl.get(key) : null;
    if (!prev) {
      if (!confederazionePublishableBody(job, null)) {
        // Under 50 words of source text (or none) and nothing stored: not
        // published — no padding is ever counted (NN #4, issue 5253).
        unpublished += 1;
        return null;
      }
      added += 1;
      return job;
    }
    if (!detailEnriched && job.sourceLang) {
      // Detail page unreadable this run: keep the stored enriched source text
      // when it still contains the whole fresh API text.
      const kept = preferEnrichedDescription(
        prev.descriptionByLocale?.[job.sourceLang] || '',
        job.descriptionByLocale?.[job.sourceLang] || '',
      );
      if (kept && kept !== job.descriptionByLocale?.[job.sourceLang]) {
        job.descriptionByLocale = { ...job.descriptionByLocale, [job.sourceLang]: kept };
        if (job.sourceLang === 'it' || !job.descriptionByLocale.it) job.description = kept;
      }
    }
    const publishable = confederazionePublishableBody(job, prev);
    if (!publishable) {
      // Under 50 words of source text this run and no stored source body that
      // clears the floor: not published this run.
      unpublished += 1;
      return null;
    }
    if (publishable.sourceLang !== job.sourceLang
      || publishable.body !== job.descriptionByLocale?.[job.sourceLang]) {
      // The short body of this run is dropped, not kept next to the stored one.
      job.sourceLang = publishable.sourceLang;
      job.descriptionByLocale = { [publishable.sourceLang]: publishable.body };
      job.description = publishable.body;
    }
    updated += 1;
    // When merging slugByLocale, discard any pre-existing IT slug that contains German words
    // (artefacts from a previous broken crawl) so locale hardening can regenerate a proper one.
    const prevSlugs = { ...(prev.slugByLocale || {}) };
    const prevItSlug = String(prevSlugs.it || '');
    if (prevItSlug && GERMAN_SLUG_WORDS.test(prevItSlug)) {
      delete prevSlugs.it;
    }
    // Similarly, only carry forward IT titleByLocale/descriptionByLocale if they look Italian
    // (i.e., locale hardening already ran); otherwise let locale hardening fill them again.
    const prevTitles = { ...(prev.titleByLocale || {}) };
    const prevDescs = { ...(prev.descriptionByLocale || {}) };
    if (job.sourceLang && job.sourceLang !== 'it' && !job.titleByLocale?.it) {
      // The new crawl has no Italian translation yet — discard stale German values
      // from prev so locale hardening can fill them properly.
      const prevItTitle = String(prevTitles.it || '');
      if (prevItTitle && GERMAN_SLUG_WORDS.test(prevItTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-'))) {
        delete prevTitles.it;
        delete prevDescs.it;
      }
    }
    // Traced end-to-end (issue 3639): passing job.sourceLang here does NOT
    // change how the L505 purge interacts with the 'it' locale. The purge
    // above only ever fires when job.sourceLang !== 'it', which means 'it'
    // is always a NON-source locale in mergeLocaleTextMap's sourceLocale
    // branch — and that branch's non-source-locale rule ("existing wins if
    // long enough, else fall back to fresh") is the exact same formula as
    // the no-sourceLocale fallback path used before this arg was threaded.
    // The only locale whose merge behavior actually changed is job.sourceLang
    // itself (fresh now wins there over stale existing text), which is never
    // 'it' inside the purge branch. No new IT-locale gap is introduced.
    const merged = {
      ...prev,
      ...job,
      ...mergeSourcePostingDates(prev, job),
      titleByLocale: mergeLocaleTextMap(prevTitles, job.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(prevDescs, job.descriptionByLocale, 30, job.sourceLang),
      slugByLocale: mergeLocaleTextMap(prevSlugs, job.slugByLocale, 3),
    };
    captureLostSlugs(merged, prev.slugByLocale, prev.slug, 20);
    return merged;
  }).filter(Boolean);
  if (unpublished > 0) {
    console.log(`  ⏭️  ${unpublished} job(s) without any body from the source — not published.`);
  }

  const allJobs = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, allJobs);
  writeJson(PUBLIC_JOBS, allJobs);

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'Confederazione CH');
  writeCrawlChangeSummaryToGH(diff, 'Confederazione CH');
  writeJobsSummary(mergedTarget, 'Confederazione CH');
  printPublishedJobUrls(mergedTarget, 'Confederazione CH');
  return { total: mergedTarget.length, added, updated, diff };
}

/* ── Adapter Config ────────────────────────────────────────── */

function updateAdapterConfig(jobs) {
  const seedMetaByUrl = {};
  for (const job of jobs) {
    seedMetaByUrl[job.url] = {
      location: job.location,
      canton: job.canton,
      company: COMPANY_NAME,
      ...mergeSourcePostingDates({}, job),
    };
  }
  writeJson(ADAPTER_PATH, {
    companyKey: COMPANY_KEY,
    companyName: COMPANY_NAME,
    companyHost: COMPANY_HOST,
    enabled: true,
    priority: 15,
    crawlerModes: ['api'],
    seedUrls: [
      `${API_BASE}?lang=it`,
    ],
    notes: 'Confederazione Svizzera — CH-wide federal jobs (all 26 cantons). Fetches the unfiltered national listing from the Prospective.ch API (medium 1000624 — Stellenportal Bund / jobs.admin.ch) and keeps every job whose location resolves to a Swiss canton (inferAnyCanton); foreign "Estero" postings are dropped. Covers departments not handled by VTG or Agroscope crawlers: DATEC, DEFR/SECO, DFGP, TPF, etc. Includes apprenticeship and internship positions.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

/* ── Validation ────────────────────────────────────────────── */

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_CONFEDERAZIONE_STRICT',
    label: 'Confederazione CH',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain: (rawUrl = '') => {
      try {
        const host = new URL(rawUrl).hostname.toLowerCase();
        return host.endsWith('admin.ch') || host.endsWith('sapsf.eu') || host.endsWith('prospective.ch');
      } catch {
        return false;
      }
    },
    untrustedDomainReason: 'url_not_admin_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Confederazione Swiss jobs found after dedicated crawl.',
    detectSourceLang: (text, job) => job?.sourceLang || detectLang(text, 'it'),
    maxToleratedMissingDescriptions: 20,
  });
}

/* ── Main ──────────────────────────────────────────────────── */

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Confederazione CH');
  console.log('===============================================');
  console.log('  Confederazione Svizzera — CH-wide Federal Jobs');
  console.log('===============================================');
  console.log(`  API: ${API_BASE}`);
  console.log('  Scope: national (unfiltered) — keep all 26 Swiss cantons\n');

  const listings = await fetchAllListings();
  if (listings.length === 0) {
    console.log('No CH federal jobs found — skipping.');
    return;
  }

  // Log canton breakdown
  const byCanton = {};
  for (const l of listings) {
    const c = l.canton || DEFAULT_CANTON;
    byCanton[c] = (byCanton[c] || 0) + 1;
  }
  console.log('\nCanton breakdown:');
  for (const [canton, count] of Object.entries(byCanton)) {
    console.log(`  ${canton}: ${count}`);
  }

  // Log employment type breakdown
  const byType = {};
  for (const l of listings) {
    const cat = l.employmentCategory || 'unknown';
    byType[cat] = (byType[cat] || 0) + 1;
  }
  console.log('\nEmployment categories:');
  for (const [cat, count] of Object.entries(byType)) {
    console.log(`  ${cat}: ${count}`);
  }

  await enrichWithDetailPages(listings, readCoveredViewkeys());

  const jobs = listings.map(buildJob);

  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\nRunning locale fill for Confederazione jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  const cantonCounts = {};
  for (const j of jobs) {
    const c = j.canton || DEFAULT_CANTON;
    cantonCounts[c] = (cantonCounts[c] || 0) + 1;
  }
  const cantonSummary = Object.entries(cantonCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${c}:${n}`)
    .join(' | ');
  console.log('\n=== Confederazione Federal Job Stats (CH-wide) ===');
  console.log(`  Total federal jobs (CH): ${total}`);
  console.log(`  By canton: ${cantonSummary}`);
  console.log(`  Added: ${added}`);
  console.log(`  Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Confederazione CH',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: diff.newJobs.length,
    updatedCount: diff.updatedJobs.length,
    removedCount: diff.removedJobs.length,
    unchangedCount: diff.unchangedCount,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: diff.newJobs.slice(0, 30),
    updatedJobs: diff.updatedJobs.slice(0, 30),
    removedJobs: diff.removedJobs.slice(0, 30),
    unchangedJobs: (diff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

// Importable by tests (mergeJobs) without running the crawl.
if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => exitCrawlerOnError(error, 'Confederazione'));
}
