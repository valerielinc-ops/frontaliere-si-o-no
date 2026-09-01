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
 * 4. All data is in the API response (no detail page fetching needed)
 * 5. Skips jobs already covered by VTG / Agroscope crawlers
 * 6. Merges into data/jobs.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
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
import { getCompanyDefaults, getCantonDisplayName } from './lib/crawler-location-config.mjs';
import { assertJsonListShape } from './lib/assert-json-list-shape.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { truncateSlugAtWordBoundary } from './lib/slug-truncate.mjs';

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

async function fetchJson(url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
        Origin: 'https://jobs.admin.ch',
        Referer: 'https://jobs.admin.ch/',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
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
  // A single-canton region label like "Ticino (TI)" is used only as last resort.
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

  // Build description from szas fields
  const parts = [];
  if (szas.sza_tasks) parts.push(stripHtml(szas.sza_tasks));
  if (szas.sza_requirements) parts.push(stripHtml(szas.sza_requirements));
  const description = parts.join('\n\n');

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
    startDate: j.start_date || '',
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
  const dept = String(job.subDepartment || job.department || 'Confederazione Svizzera').trim();
  const description = String(job.description || '').trim();
  const deptShort = dept.replace(/\s*\([^)]*\)\s*/g, '').trim();

  // Ensure description meets 50-word threshold
  const descWordCount = description.split(/\s+/).filter(Boolean).length;
  let sourceDesc = '';

  if (descWordCount >= 50) {
    sourceDesc = description;
  } else if (sourceLang === 'it') {
    const pensumText = job.pensum ? ` Grado di occupazione: ${job.pensum}.` : '';
    const fieldText = job.fieldOfActivity ? ` Settore: ${job.fieldOfActivity}.` : '';
    sourceDesc = [
      `${title} — ${deptShort}, ${city}.`,
      `Posizione nell'Amministrazione federale svizzera (Confederazione Svizzera).`,
      description ? description : '',
      `${fieldText}${pensumText}`,
      `La Confederazione Svizzera è uno dei maggiori datori di lavoro del Paese, con condizioni di impiego moderne, opportunità di formazione continua, orari di lavoro flessibili e prestazioni sociali competitive. L'Amministrazione federale si impegna per le pari opportunità e promuove un ambiente di lavoro inclusivo e diversificato.`,
      `Candidati online su jobs.admin.ch.`,
    ].filter(Boolean).join('\n');
  } else if (sourceLang === 'de') {
    const pensumText = job.pensum ? ` Beschäftigungsgrad: ${job.pensum}.` : '';
    const fieldText = job.fieldOfActivity ? ` Bereich: ${job.fieldOfActivity}.` : '';
    sourceDesc = [
      `${title} — ${deptShort}, ${city}.`,
      `Stelle in der Schweizerischen Bundesverwaltung (Schweizerische Eidgenossenschaft).`,
      description ? description : '',
      `${fieldText}${pensumText}`,
      `Die Schweizerische Eidgenossenschaft ist einer der grössten Arbeitgeber des Landes mit modernen Anstellungsbedingungen, Weiterbildungsmöglichkeiten, flexiblen Arbeitszeiten und wettbewerbsfähigen Sozialleistungen. Die Bundesverwaltung setzt sich für Chancengleichheit ein und fördert ein inklusives und vielfältiges Arbeitsumfeld.`,
      `Bewerben Sie sich online auf jobs.admin.ch.`,
    ].filter(Boolean).join('\n');
  } else {
    sourceDesc = description || title;
  }

  return {
    titleByLocale: { [sourceLang]: title },
    descriptionByLocale: { [sourceLang]: sourceDesc || title },
    // Slug-only guard: `job.city` can be the literal "undefined"/"null" string
    // (truthy) → `-undefined` in an active slug (#952, class #900/#901). Fallback is
    // `regionLabel` (Ticino/Grigioni), region-correct. addressLocality untouched.
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
  let total = 0;

  do {
    const url = `${API_BASE}?lang=it&offset=${offset}&limit=${limit}`;
    console.log(`  API: ${url}`);

    const data = await fetchJson(url);
    const items = assertJsonListShape(data, { key: 'jobs', source: 'confederazione:CH' }).map(parseApiJob);
    total = data.total || 0;
    allItems.push(...items);
    offset += limit;
  } while (offset < total);

  console.log(`  CH: ${total} jobs from API`);
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
    if (seenViewkeys.has(vk)) continue;
    seenViewkeys.add(vk);
    allJobs.push(job);
  }

  console.log(`\nTotal: ${allJobs.length} unique CH jobs (${swissJobs.length - allJobs.length} duplicates)`);
  return allJobs;
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
    postedDate: row.startDate ? row.startDate.slice(0, 10) : new Date().toISOString().slice(0, 10),
    validThrough: row.endDate ? row.endDate.slice(0, 10) : '',
    employmentType: empType,
    contractType: empType,
    description: localized.descriptionByLocale.it || localized.descriptionByLocale[sourceLang] || '',
    titleByLocale: localized.titleByLocale,
    descriptionByLocale: localized.descriptionByLocale,
    slugByLocale: localized.slugByLocale,
  };
}

/* ── Merge ─────────────────────────────────────────────────── */

function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);

  // Collect viewkeys from the dedicated slices themselves. Reading only the
  // Confederazione slice here made this set permanently empty and let the
  // broad crawler republish VTG/Agroscope vacancies under a second company.
  const coveredViewkeys = new Set();
  for (const coveredKey of COVERED_KEYS) {
    for (const job of readExistingCrawlerJobs(coveredKey)) {
      const vk = extractViewkey(job.url);
      if (vk) coveredViewkeys.add(vk);
    }
  }

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
  const mergedTarget = newJobs.map((job) => {
    const key = extractStableJobId(job?.url);
    const prev = key ? existingByUrl.get(key) : null;
    if (!prev) {
      added += 1;
      return job;
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
      titleByLocale: mergeLocaleTextMap(prevTitles, job.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(prevDescs, job.descriptionByLocale, 30, job.sourceLang),
      slugByLocale: mergeLocaleTextMap(prevSlugs, job.slugByLocale, 3),
    };
    captureLostSlugs(merged, prev.slugByLocale, prev.slug, 20);
    return merged;
  });

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
      postedDate: job.postedDate,
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
    noJobsMessage: 'No Confederazione Ticino jobs found after dedicated crawl.',
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

main().catch((error) => exitCrawlerOnError(error, 'Confederazione'));
