#!/usr/bin/env node
/**
 * Confederazione Svizzera — TI + GR Federal Jobs Crawler
 *
 * Crawls Swiss federal government jobs for Ticino and Graubünden via the
 * Prospective.ch API (medium 1000624 — Stellenportal Bund / jobs.admin.ch).
 *
 * Filters:
 *   - region:1083341 (Ticino / TI) — all jobs kept
 *   - region:1083334 (Ostschweiz / AI, AR, GL, GR, SG, SH, TG) — only GR kept
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
 * 1. Fetches all TI listings via API (region:1083341)
 * 2. Fetches Ostschweiz listings (region:1083334) and filters to GR only
 * 3. All data is in the API response (no detail page fetching needed)
 * 4. Skips jobs already covered by VTG / Agroscope crawlers
 * 5. Merges into data/jobs.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
} from './lib/dedicated-crawler-common.mjs';
import { isTicinoRelevant, isGrigioniRelevant, isTargetSwissLocation, inferSwissTargetCanton, inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { normalizeFederalJobLocation } from './lib/federal-job-normalization.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'confederazione-ticino.json');

const COMPANY_KEY = 'confederazione-ticino';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'Confederazione Svizzera';
const COMPANY_HOST = 'jobs.admin.ch';
const COMPANY_DOMAIN = 'admin.ch';
const API_BASE = 'https://ohws.prospective.ch/public/v1/medium/1000624/jobs';
const REGION_TICINO = '1083341';
const REGION_OSTSCHWEIZ = '1083334'; // Ostschweiz (AI, AR, GL, GR, SG, SH, TG) — we filter to GR only
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

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
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

function isAlreadyCovered(job = {}) {
  const key = normalizeKey(job.companyKey || '');
  return COVERED_KEYS.has(key);
}

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

  // Extract canton from region label: "Ticino (TI)" → "TI", "Ostschweiz (AI, AR, GL, GR, SG, SH, TG)" → use inferSwissTargetCanton
  const cantonMatch = regionRaw.match(/\(([A-Z]{2})\)$/);
  const cantonFromRegion = cantonMatch ? cantonMatch[1] : '';
  // For composite regions (Ostschweiz), infer canton from location text
  const canton = normalizedLocation.canton || cantonFromRegion || inferAnyCanton(`${locationRaw} ${regionRaw}`) || DEFAULT_CANTON;

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
  if (/praktikan|stagiar|stage|intern|studenti|neodiplomati/i.test(haystack)) return 'internship';
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
  const regionLabel = canton === 'GR' ? 'Grigioni' : 'Ticino';
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
    slugByLocale: { [sourceLang]: slugify(`${title} confederazione ${city}`) },
  };
}

/* ── Fetching ─────────────────────────────────────────────── */

/**
 * Fetch all jobs for a given Prospective region ID.
 * @param {string} regionId – region filter value (e.g. '1083341')
 * @param {string} regionLabel – human-readable label for logging
 */
async function fetchRegionListings(regionId, regionLabel) {
  console.log(`\nFetching ${regionLabel} federal jobs (region:${regionId})...`);

  const allItems = [];
  let offset = 0;
  const limit = 100;
  let total = 0;

  do {
    const url = `${API_BASE}?lang=it&offset=${offset}&limit=${limit}&f=region:${regionId}`;
    console.log(`  API: ${url}`);

    const data = await fetchJson(url);
    const items = (data.jobs || []).map(parseApiJob);
    total = data.total || 0;
    allItems.push(...items);
    offset += limit;
  } while (offset < total);

  console.log(`  ${regionLabel}: ${total} jobs from API`);
  return allItems;
}

async function fetchAllListings() {
  // 1. Fetch TI region (all jobs kept)
  const tiJobs = await fetchRegionListings(REGION_TICINO, 'Ticino');

  // 2. Fetch Ostschweiz region and filter to GR only
  const ostschweizJobs = await fetchRegionListings(REGION_OSTSCHWEIZ, 'Ostschweiz');
  const grJobs = ostschweizJobs.filter((job) => {
    // Only use location/city for canton inference — not region label (it always contains "GR")
    const locationText = `${job.location} ${job.city}`;
    const canton = inferAnyCanton(locationText);
    if (canton === 'GR') {
      job.canton = 'GR';
      return true;
    }
    return false;
  });
  console.log(`  Ostschweiz → filtered to ${grJobs.length} GR jobs (discarded ${ostschweizJobs.length - grJobs.length} non-GR)`);

  // 3. Merge and deduplicate by viewkey
  const seenViewkeys = new Set();
  const allJobs = [];
  for (const job of [...tiJobs, ...grJobs]) {
    const vk = job.viewkey || job.id;
    if (seenViewkeys.has(vk)) continue;
    seenViewkeys.add(vk);
    allJobs.push(job);
  }

  console.log(`\nTotal: ${allJobs.length} unique jobs (${tiJobs.length} TI + ${grJobs.length} GR, ${tiJobs.length + grJobs.length - allJobs.length} duplicates)`);
  return allJobs;
}

/* ── Job Building ─────────────────────────────────────────── */

function buildJob(row) {
  const sourceLang = detectLang(`${row.title} ${row.description}`, row.language || 'it');
  const localized = buildLocalizedContent(row, sourceLang);
  const canton = row.canton || DEFAULT_CANTON;
  const regionLabel = canton === 'GR' ? 'Graubünden' : 'Ticino';
  const detailUrl = row.directLink || `https://jobs.admin.ch/?lang=it&f=region:${canton === 'GR' ? REGION_OSTSCHWEIZ : REGION_TICINO}`;
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

  // Collect viewkeys already covered by VTG / Agroscope
  const coveredViewkeys = new Set();
  for (const job of existing) {
    if (isAlreadyCovered(job)) {
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
  const existingByUrl = new Map(targetExisting.map((job) => [String(job.url || '').trim().toLowerCase(), job]));

  let added = 0;
  let updated = 0;
  const mergedTarget = newJobs.map((job) => {
    const url = String(job.url || '').trim().toLowerCase();
    const prev = existingByUrl.get(url);
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
    return {
      ...prev,
      ...job,
      titleByLocale: mergeLocaleTextMap(prevTitles, job.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(prevDescs, job.descriptionByLocale, 30),
      slugByLocale: mergeLocaleTextMap(prevSlugs, job.slugByLocale, 3),
    };
  });

  const allJobs = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, allJobs);
  writeJson(PUBLIC_JOBS, allJobs);

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'Confederazione TI+GR');
  writeCrawlChangeSummaryToGH(diff, 'Confederazione TI+GR');
  writeJobsSummary(mergedTarget, 'Confederazione TI+GR');
  printPublishedJobUrls(mergedTarget, 'Confederazione TI+GR');
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
      `${API_BASE}?lang=it&f=region:${REGION_TICINO}`,
      `${API_BASE}?lang=it&f=region:${REGION_OSTSCHWEIZ}`,
    ],
    notes: 'Confederazione Svizzera — federal jobs in Ticino (region 1083341) + Graubünden (filtered from Ostschweiz region 1083334). Uses Prospective.ch API (medium 1000624 — Stellenportal Bund / jobs.admin.ch). Covers departments not handled by VTG or Agroscope crawlers: DATEC, DEFR/SECO, DFGP, TPF, etc. Includes apprenticeship and internship positions.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

/* ── Validation ────────────────────────────────────────────── */

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_CONFEDERAZIONE_STRICT',
    label: 'Confederazione TI+GR',
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
    detectSourceLang: (job) => job.sourceLang || 'it',
    maxToleratedMissingDescriptions: 20,
  });
}

/* ── Main ──────────────────────────────────────────────────── */

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Confederazione TI+GR');
  console.log('===============================================');
  console.log('  Confederazione Svizzera — TI + GR Federal Jobs');
  console.log('===============================================');
  console.log(`  API: ${API_BASE}`);
  console.log(`  Filters: region:${REGION_TICINO} (Ticino) + region:${REGION_OSTSCHWEIZ} (Ostschweiz→GR)\n`);

  const listings = await fetchAllListings();
  if (listings.length === 0) {
    console.log('No federal jobs found for TI/GR — skipping.');
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

  const tiCount = jobs.filter((j) => j.canton === 'TI').length;
  const grCount = jobs.filter((j) => j.canton === 'GR').length;
  console.log('\n=== Confederazione Federal Job Stats ===');
  console.log(`  Total federal jobs (TI+GR): ${total}`);
  console.log(`  TI: ${tiCount} | GR: ${grCount}`);
  console.log(`  Added: ${added}`);
  console.log(`  Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Confederazione TI+GR',
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

main().catch((error) => {
  console.error(`Confederazione crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
