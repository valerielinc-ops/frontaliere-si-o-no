#!/usr/bin/env node
/**
 * Dedicated Grand Hotel Kronenhof / Kulm Group crawler runner.
 *
 * The Kulm Group operates luxury hotels in the Engadin (GR):
 *   - Grand Hotel Kronenhof (Pontresina)
 *   - Kulm Hotel (St. Moritz)
 * Careers portal: https://careers.kronenhof.com/en/vacancies
 *
 * The site exposes a paginated JSON API at:
 *   https://careers.kronenhof.com/en/vacancies/json?page=N
 * Each page returns up to 10 jobs with: id, title, location,
 * contract_duration, contract_starts_at, workload.
 *
 * This crawler:
 *   1. Paginates through the JSON API to collect all vacancies.
 *   2. Builds standardized job objects (all are in GR canton).
 *   3. Merges into data/jobs.json.
 *   4. Translates missing locales.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
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
  normalize,
  normalizeKey,
  detectLang,
  mergeLocaleTextMap,
} from './lib/dedicated-crawler-common.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');

const COMPANY_KEY = 'grand-hotel-kronenhof';
const COMPANY_NAME = 'Grand Hotel Kronenhof';
const COMPANY_DOMAIN = 'kronenhof.com';
const HQ = getCompanyDefaults(COMPANY_KEY);

const API_BASE = 'https://careers.kronenhof.com/en/vacancies/json';
const CAREERS_URL = 'https://careers.kronenhof.com/en/vacancies';

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';
const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;

/* ── Helpers ───────────────────────────────────────────────── */
function readJson(filePath, fallback = []) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return fallback; }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return (
    key === COMPANY_KEY ||
    key === 'kulm-hotel' ||
    key.includes('kronenhof') ||
    key.includes('kulm-group') ||
    company.includes('kronenhof') ||
    company.includes('kulm hotel') ||
    company.includes('kulm group') ||
    url.includes('kronenhof.com') ||
    url.includes('kulm.com')
  );
}

function jobMatchKey(job) {
  return extractStableJobId(job.url) || String(job.slug || '').trim().toLowerCase();
}

function slugify(text = '') {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

const DETAIL_DELAY_MS = 1200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── Fetch API ─────────────────────────────────────────────── */
async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': UA,
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html',
        'User-Agent': UA,
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
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
    .replace(/<\/h[1-6]>/gi, '\n')
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

/**
 * Parse the Kronenhof/Kulm detail page HTML to extract structured description.
 *
 * The detail page at /en/vacancies/{id} contains sections like:
 *   - Job description / responsibilities
 *   - Requirements / qualifications
 *   - Benefits / what we offer
 */
function parseDetailPage(html = '') {
  // Extract the main job content area first to avoid contamination from
  // sidebar "other vacancies" sections that share the same page.
  const mainAreaMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<div[^>]*class="[^"]*vacancy[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/<div[^>]*class="[^"]*job[^"]*detail[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  // Restrict search to the main area; fall back to full page only if nothing found.
  const searchArea = mainAreaMatch ? mainAreaMatch[1] : html;

  const sections = [];
  const sectionRegex = /<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>\s*([\s\S]*?)(?=<h[2-4][^>]*>|<footer|<\/main|<\/article|$)/gi;
  const skipHeadings = /cookie|privacy|navigation|menu|footer|header|breadcrumb|vacancy overview|share this|andere stellen|other positions|weitere stellen|offene stellen|weitere vakanz/i;

  let match;
  while ((match = sectionRegex.exec(searchArea)) !== null) {
    const heading = stripHtml(match[1]).trim();
    if (!heading || heading.length > 100 || skipHeadings.test(heading)) continue;

    const content = stripHtml(match[2]).trim();
    if (!content || content.length < 20) continue;

    sections.push(`## ${heading}\n${content}`);
  }

  if (sections.length > 0) {
    return sections.join('\n\n');
  }

  // Fallback: use the already-extracted main area text directly.
  if (mainAreaMatch) {
    const text = stripHtml(mainAreaMatch[1]).trim();
    if (text.length > 100) return text;
  }

  return '';
}

/**
 * Paginate through the JSON API to collect all vacancies.
 */
async function fetchAllVacancies() {
  const allJobs = [];
  let page = 1;
  let lastPage = 1;

  do {
    const url = `${API_BASE}?page=${page}`;
    console.log(`  📥 Fetching page ${page}/${lastPage}: ${url}`);
    const response = await fetchJson(url);

    if (response.data && Array.isArray(response.data)) {
      allJobs.push(...response.data);
    }

    lastPage = response.meta?.last_page || 1;
    page++;
  } while (page <= lastPage);

  return allJobs;
}

/* ── Build Job Objects ─────────────────────────────────────── */

/** Map location string to city and company name. */
function mapLocation(rawLocation = '') {
  const loc = rawLocation.trim();
  if (loc.toLowerCase().includes('kronenhof')) {
    return { city: 'Pontresina', company: 'Grand Hotel Kronenhof' };
  }
  if (loc.toLowerCase().includes('kulm')) {
    return { city: 'St. Moritz', company: 'Kulm Hotel St. Moritz' };
  }
  return { city: 'Pontresina', company: COMPANY_NAME };
}

/** Map contract_duration to employment/contract type. */
function mapContractType(duration = '') {
  switch (duration) {
    case 'indefinite': return { employmentType: 'full-time', contractType: 'permanent' };
    case 'seasonal': return { employmentType: 'full-time', contractType: 'seasonal' };
    case '10-months': return { employmentType: 'full-time', contractType: 'fixed-term' };
    case '6-months': return { employmentType: 'full-time', contractType: 'fixed-term' };
    default: return { employmentType: 'full-time', contractType: duration || 'seasonal' };
  }
}

function buildJob(raw, detailDescription = '') {
  const title = String(raw.title || '').trim();
  const { city, company } = mapLocation(raw.location);
  const { employmentType, contractType } = mapContractType(raw.contract_duration);
  // Include vacancy ID to prevent slug collisions when two vacancies share
  // the same title + company + city (e.g., two "Office Employee" openings).
  const slug = slugify(`${title}-${company}-${city}-${raw.id}`);
  const detailUrl = `https://careers.kronenhof.com/en/vacancies/${raw.id}`;
  const postedDate = raw.contract_starts_at
    ? raw.contract_starts_at.slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const sourceLang = detectLang(title, 'de');
  const workload = raw.workload ? `${raw.workload}%` : '100%';

  // Build a description from available data
  const durationLabel = {
    'indefinite': 'Unbefristet / Permanent',
    'seasonal': 'Saisonstelle / Seasonal',
    '10-months': '10-Monats-Stelle / 10-month contract',
    '6-months': '6-Monats-Stelle / 6-month contract',
  }[raw.contract_duration] || raw.contract_duration || 'Seasonal';

  const metaLine = [
    `${title} — ${company}, ${city} (Engadin, Graubünden).`,
    `Pensum: ${workload}. Vertrag: ${durationLabel}.`,
    raw.contract_starts_at ? `Stellenantritt: ${raw.contract_starts_at.slice(0, 10)}.` : '',
  ].filter(Boolean).join(' ');

  // Prefer detail page description if rich enough (>= 50 words), otherwise use fallback
  const detailWordCount = detailDescription ? detailDescription.split(/\s+/).length : 0;
  const hasRichDetail = detailWordCount >= 50;

  const fallbackDescription = [
    metaLine,
    `Die Kulm Gruppe betreibt zwei der exklusivsten 5-Sterne-Hotels im Engadin: das Grand Hotel Kronenhof in Pontresina und das Kulm Hotel in St. Moritz.`,
    `Beide Häuser stehen für Schweizer Luxushotellerie auf höchstem Niveau mit einer langen Tradition, erstklassigem Service und einem engagierten internationalen Team.`,
    `Als Arbeitgeber bieten wir: Personalunterkunft in der Engadiner Bergwelt, vergünstigte Verpflegung, umfassende Weiterbildungsmöglichkeiten, attraktive Mitarbeitervergünstigungen und ein inspirierendes Arbeitsumfeld in einer der schönsten Regionen der Schweiz.`,
    `Die Kulm Gruppe beschäftigt rund 500 Mitarbeitende und bietet vielfältige Karrieremöglichkeiten in Gastronomie, Küche, Housekeeping, Front Office, Spa, Events und Administration.`,
    `Bewerbungen an: people@kulmgroup.com oder über ${CAREERS_URL}`,
  ].join(' ');

  const description = hasRichDetail
    ? `${metaLine}\n\n${detailDescription}`
    : fallbackDescription;

  return {
    title,
    slug,
    url: detailUrl,
    applyUrl: detailUrl,
    company,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: city,
    addressLocality: city,
    addressRegion: 'GR',
    addressCountry: 'CH',
    canton: HQ.canton,
    country: 'CH',
    category: 'Turismo & Ospitalità',
    sector: 'Hotellerie & Gastronomia',
    source: 'kronenhof-dedicated-crawler',
    sourceLang,
    postedDate,
    validThrough: '',
    contract: contractType,   // canonical field expected by JobPosting schema + CLAUDE.md validation
    employmentType,
    contractType,
    description,
    titleByLocale: {},
    descriptionByLocale: {},
    slugByLocale: {},
    crawledAt: new Date().toISOString(),
  };
}

/* ── Merge ─────────────────────────────────────────────────── */
function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const nonTargetJobs = existing.filter((job) => !isTargetJob(job));
  const targetExisting = existing.filter(isTargetJob);
  const beforeSnapshot = snapshotJobSlugs(targetExisting);
  const existingByKey = new Map(targetExisting.map((job) => [jobMatchKey(job), job]));

  let added = 0;
  let updated = 0;
  const mergedTarget = discoveredJobs.map((job) => {
    const prev = existingByKey.get(jobMatchKey(job));
    if (!prev) {
      added += 1;
      return job;
    }
    updated += 1;
    // If the slug changed (e.g., due to ID suffix being added on first re-crawl),
    // preserve the old slug in previousSlugs so existing indexed URLs don't 404.
    const prevPreviousSlugs = prev.previousSlugs || [];
    const previousSlugs =
      prev.slug && prev.slug !== job.slug && !prevPreviousSlugs.includes(prev.slug)
        ? [...prevPreviousSlugs, prev.slug]
        : prevPreviousSlugs;
    return {
      ...prev,
      ...job,
      previousSlugs,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, job.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(prev.descriptionByLocale, job.descriptionByLocale, 30),
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale, job.slugByLocale, 3),
    };
  });

  const allJobs = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, allJobs);
  if (fs.existsSync(path.dirname(PUBLIC_JOBS))) {
    writeJson(PUBLIC_JOBS, allJobs);
  }

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME);
  writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);

  return { total: mergedTarget.length, added, updated, diff };
}

/* ── Stats & Validation ────────────────────────────────────── */
function logStats() {
  const allJobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const jobs = allJobs.filter(isTargetJob);
  const kronenhof = jobs.filter((j) => normalize(j.company).includes('kronenhof'));
  const kulm = jobs.filter((j) => normalize(j.company).includes('kulm'));

  console.log(`\n📊 === Kronenhof / Kulm Group Job Stats ===`);
  console.log(`  🏨 Total jobs: ${jobs.length}`);
  console.log(`  ✅ Grand Hotel Kronenhof: ${kronenhof.length}`);
  console.log(`  ✅ Kulm Hotel St. Moritz: ${kulm.length}`);
  console.log(`  📍 All in canton GR (Engadin)`);
  console.log('');

  return { total: jobs.length };
}

function validateLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_KRONENHOF_STRICT',
    label: COMPANY_NAME,
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    noJobsMessage: 'No Kronenhof / Kulm Group jobs found after crawl.',
    maxToleratedMissingDescriptions: 10,
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'kronenhof');
  console.log('🏨 Running dedicated Grand Hotel Kronenhof crawler...');
  console.log(`   API: ${API_BASE}`);
  console.log('');

  // Step 1: Fetch all vacancies via paginated API
  console.log('📥 Fetching vacancies from JSON API...');
  const allVacancies = await fetchAllVacancies();
  console.log(`📋 Found ${allVacancies.length} total vacancies`);

  if (allVacancies.length === 0) {
    console.log('ℹ️ No vacancies found. Exiting OK.');
    return;
  }

  // Step 2: Fetch detail pages for rich descriptions
  console.log('\n📄 Fetching detail pages for rich descriptions...');
  const detailDescriptions = new Map();
  let enriched = 0;
  let failed = 0;
  for (let i = 0; i < allVacancies.length; i++) {
    const vac = allVacancies[i];
    const detailUrl = `https://careers.kronenhof.com/en/vacancies/${vac.id}`;
    try {
      const html = await fetchText(detailUrl);
      const desc = parseDetailPage(html);
      if (desc && desc.split(/\s+/).length >= 50) {
        detailDescriptions.set(vac.id, desc);
        enriched++;
        console.log(`  ✅ ${i + 1}/${allVacancies.length}: ${String(vac.title).trim()}`);
      } else {
        console.log(`  ⚠️ ${i + 1}/${allVacancies.length}: ${String(vac.title).trim()} — thin detail page`);
      }
    } catch (err) {
      failed++;
      console.log(`  ⚠️ Detail fetch failed for ${vac.id}: ${err.message}`);
    }
    if (i < allVacancies.length - 1) await sleep(DETAIL_DELAY_MS);
  }
  console.log(`  📄 Detail pages: ${enriched} enriched, ${failed} failed`);

  // Step 3: Build standardized job objects
  const jobs = allVacancies.map((vac) => buildJob(vac, detailDescriptions.get(vac.id) || ''));
  console.log(`✅ Built ${jobs.length} job objects`);

  // Log location breakdown
  const locations = {};
  for (const j of jobs) {
    const loc = j.company;
    locations[loc] = (locations[loc] || 0) + 1;
  }
  for (const [loc, count] of Object.entries(locations)) {
    console.log(`   📍 ${loc}: ${count}`);
  }

  // Step 4: Merge into jobs.json
  const { total, added, updated, diff} = mergeJobs(jobs);
  console.log(`\n📦 Merge complete: ${total} total, ${added} added, ${updated} updated`);

  // Step 5: Translate missing locales
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  // Step 6: Stats + validation
  logStats();
  validateLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'kronenhof',
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

main().catch((err) => {
  console.error(`❌ Kronenhof crawler failed: ${err?.message || err}`);
  process.exit(1);
});
