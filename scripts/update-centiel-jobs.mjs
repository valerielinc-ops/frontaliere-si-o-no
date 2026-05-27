#!/usr/bin/env node
/**
 * Dedicated Centiel crawler runner.
 *
 * Centiel is a power-protection / UPS company headquartered in
 * Cadro (Lugano), CH-6965, Via alla Stampa 15.
 *
 * The careers page at https://www.centiel.com/careers/ lists jobs inline
 * inside div.accordion-item blocks — there are no individual detail-page URLs.
 * Each accordion shows a short summary and links to a PDF job description
 * containing the full role details (responsibilities, requirements,
 * qualifications). The PDF is the source of truth for description content.
 *
 * This crawler:
 *   1. Fetches the /careers/ page HTML.
 *   2. Parses div.accordion-item blocks via jsdom to extract title, summary,
 *      PDF URL. Bounded extraction prevents form-chrome leak into the last
 *      accordion's content.
 *   3. Fetches each linked PDF and extracts the full text. PDF text is
 *      preferred when richer than the inline summary; falls back to inline
 *      on PDF fetch/parse failure.
 *   4. Builds job objects and merges into jobs.json.
 *   5. Translates and validates locale coverage.
 */
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { PDFParse } from 'pdf-parse';
import { extractStableJobId } from './lib/job-match-key.mjs';
import {
  snapshotJobSlugs,
  computeCrawlDiff,
  printCrawlChangeSummary,
  writeCrawlChangeSummaryToGH,
  printPublishedJobUrls,
  writeJobsSummary,
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

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'centiel.json');

const COMPANY_KEY = 'centiel';
const HQ = getCompanyDefaults(COMPANY_KEY);
const COMPANY_NAME = 'Centiel';
const COMPANY_HOST = 'www.centiel.com';
const COMPANY_DOMAIN = 'centiel.com';
const CAREERS_URL = 'https://www.centiel.com/careers/';
const LOCALES = ['it', 'en', 'de', 'fr'];

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */
function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeKey(value = '') {
  return String(value || '')
    .trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&#038;/g, '&')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function deriveSlug(title) {
  return normalizeKey(`${title} ${COMPANY_KEY} ticino`);
}

/* ── Matchers ──────────────────────────────────────────────── */
function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return key === COMPANY_KEY || company.includes('centiel') || url.includes('centiel.com');
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === COMPANY_HOST || host.endsWith('.centiel.com');
  } catch { return false; }
}

/* ── Fetch & Parse ─────────────────────────────────────────── */
async function fetchCareersHtml() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(CAREERS_URL, {
      signal: controller.signal,
      headers: { Accept: 'text/html', 'User-Agent': UA },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Parse job listings from the Centiel careers page HTML.
 *
 * Current layout: div.accordion-item wrappers, each containing
 *   button > h3.block-title   (job title)
 *   div.accordion-content > div.career-block > div.block-content
 *     > <p> paragraphs with the summary, <strong>Workplace</strong>,
 *       <strong>Reporting to</strong>, and a "Learn more" link to the PDF.
 *
 * Bounded extraction via DOM walk prevents the last accordion from
 * sweeping the application form, footer, and contact chrome (the
 * pre-2026 regex parser leaked all of that into the After-Sales
 * Technician description).
 */
function parseCareersPage(html) {
  const jobs = [];
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const items = doc.querySelectorAll('div.accordion-item');
  for (const item of items) {
    const titleEl = item.querySelector('h3.block-title, .block-title');
    const title = (titleEl?.textContent || '').trim();
    if (!title) continue;

    const block = item.querySelector('.block-content');
    if (!block) continue;

    // PDF link (Learn more) — bounded to this accordion only.
    const pdfAnchor = [...block.querySelectorAll('a[href]')]
      .find((a) => /\.pdf(\?|$)/i.test(a.getAttribute('href') || ''));
    const pdfUrl = pdfAnchor
      ? new URL(pdfAnchor.getAttribute('href'), CAREERS_URL).href
      : '';

    // Pull labelled metadata from the block content. The page mixes
    // <strong>Workplace:</strong> and <strong>Reporting to:</strong>
    // inside <p> elements without consistent closing tags.
    const blockHtml = block.innerHTML || '';
    const workplaceMatch = blockHtml.match(
      /<strong[^>]*>\s*Workplace\s*:?\s*<\/?strong[^>]*>\s*([^<]+)/i,
    );
    const workplace = workplaceMatch
      ? stripHtml(workplaceMatch[1]).trim()
      : 'Cadro (Lugano)';
    const reportingMatch = blockHtml.match(
      /<strong[^>]*>\s*Reporting\s+to\s*:?\s*<\/?strong[^>]*>\s*([^<]+)/i,
    );
    const reportingTo = reportingMatch ? stripHtml(reportingMatch[1]).trim() : '';
    const rateMatch = blockHtml.match(
      /<strong[^>]*>\s*Working\s+rate\s*:?\s*<\/?strong[^>]*>\s*([^<]+)/i,
    );
    const workingRate = rateMatch ? stripHtml(rateMatch[1]).trim() : '';

    // Inline summary = block-content text minus the "Learn more" link text.
    const inlineSummary = decodeHtmlEntities(
      (block.textContent || '')
        .replace(/\s+/g, ' ')
        .replace(/\bLearn more\b/i, '')
        .trim(),
    );

    jobs.push({
      title,
      inlineSummary,
      workplace,
      reportingTo,
      workingRate,
      pdfUrl,
    });
  }

  return jobs;
}

/**
 * Fetch a PDF URL and extract its text. Returns the cleaned text or
 * an empty string on any failure (network error, non-200, parse error).
 * The crawler falls back to the inline summary when this returns empty.
 */
async function fetchPdfText(pdfUrl) {
  if (!pdfUrl) return '';
  const timeoutMs = Number(process.env.JOBS_CRAWLER_PDF_TIMEOUT_MS) || 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(pdfUrl, {
      signal: controller.signal,
      headers: { Accept: 'application/pdf', 'User-Agent': UA },
      redirect: 'follow',
    });
    if (!res.ok) {
      console.warn(`  ⚠️ PDF ${pdfUrl} → HTTP ${res.status}`);
      return '';
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const parser = new PDFParse({ data: buf });
    const out = await parser.getText();
    const raw = (out?.text || '').trim();
    if (!raw) return '';
    // Light cleanup: normalise line breaks, collapse whitespace, then
    // drop the contact-instruction tail that every Centiel PDF ends with
    // (e.g. "If you identify with this role ... please send your
    // application ... to: hr@hq.centiel.com"). The role-relevant content
    // ends before this paragraph; keeping it bloats the description and
    // exposes a contact email on the public job page.
    const normalised = raw
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    const contactCutMarkers = [
      /\n[^\n]*If you (?:identify|are interested|recognise)[^\n]*\n[\s\S]*$/i,
      /\nplease send your application[\s\S]*$/i,
      /\n[^\n]*\b(?:hr|write|jobs)@(?:hq\.)?centiel\.com[\s\S]*$/i,
    ];
    let text = normalised;
    for (const re of contactCutMarkers) text = text.replace(re, '').trim();
    return text;
  } catch (err) {
    console.warn(`  ⚠️ PDF ${pdfUrl} failed: ${err?.message || err}`);
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decide which description body to use: PDF text when it's substantially
 * richer than the inline summary, otherwise the inline summary. Both can
 * be empty; downstream `buildJob` pads with company boilerplate to meet
 * the 50-word non-negotiable.
 */
function selectDescriptionBody(pdfText, inlineSummary) {
  const pdfWords = (pdfText || '').split(/\s+/).filter(Boolean).length;
  const inlineWords = (inlineSummary || '').split(/\s+/).filter(Boolean).length;
  // Prefer PDF when it's at least 1.5× longer than the inline summary
  // (the inline tail typically only has summary + labels).
  if (pdfWords >= 80 && pdfWords >= inlineWords * 1.5) return pdfText;
  return inlineSummary || pdfText || '';
}

/* ── Category inference ────────────────────────────────────── */
function inferCategory(title = '') {
  const t = normalize(title);
  if (t.includes('engineer') || t.includes('r&d') || t.includes('development')) return 'engineering';
  if (t.includes('sales') || t.includes('account') || t.includes('partner')) return 'sales';
  if (t.includes('technician') || t.includes('after-sales') || t.includes('service')) return 'engineering';
  if (t.includes('admin') || t.includes('assistant') || t.includes('hr')) return 'admin';
  if (t.includes('marketing') || t.includes('communication')) return 'marketing';
  return 'other';
}

/* ── Build job object ──────────────────────────────────────── */
function buildJob(row) {
  const slug = deriveSlug(row.title);
  // Use the PDF URL as the canonical URL if available, otherwise careers page
  const url = row.pdfUrl || CAREERS_URL;

  // Pick PDF text over inline summary when meaningfully richer.
  let description = selectDescriptionBody(row.pdfText, row.inlineSummary);

  // Ensure description meets the 50-word minimum threshold
  const wordCount = description.split(/\s+/).filter(Boolean).length;
  if (wordCount < 50) {
    // Build a richer description with job-specific details
    const parts = [
      `${row.title} — Centiel, Cadro (Lugano), Canton Ticino, Switzerland.`,
      row.reportingTo ? `Reporting to: ${row.reportingTo}.` : '',
      row.workingRate ? `Working rate: ${row.workingRate}.` : '',
      description ? `\n${description}` : '',
      `\nCentiel is a Swiss company headquartered in Cadro (Lugano), specializing in the design and manufacture of uninterruptible power supply (UPS) systems and power protection solutions. The company develops innovative three-phase modular UPS technology for mission-critical applications including data centers, hospitals, industrial facilities, and telecommunications infrastructure. Centiel's products are known for their high efficiency, reliability, and scalability, serving clients across Europe and globally.`,
      `\nWorkplace: ${row.workplace || 'Cadro (Lugano)'}, Via alla Stampa 15, CH-6965.`,
      `Apply via: ${CAREERS_URL}`,
    ];
    description = parts.filter(Boolean).join('\n').trim();
  }

  return {
    title: row.title,
    slug,
    url,
    applyUrl: url,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: 'Cadro (Lugano)',
    addressLocality: 'Lugano',
    addressRegion: HQ.addressRegion,
    addressCountry: 'CH',
    canton: HQ.canton,
    country: 'CH',
    category: inferCategory(row.title),
    sector: 'Energia / UPS / Power Protection',
    source: 'centiel-dedicated-crawler',
    sourceLang: 'en',
    postedDate: new Date().toISOString().slice(0, 10),
    employmentType: row.workingRate || 'full-time',
    contractType: 'full-time',
    validThrough: '',
    description,
    titleByLocale: { en: row.title },
    descriptionByLocale: { en: description },
    slugByLocale: { it: slug },
  };
}

/* ── Merge ─────────────────────────────────────────────────── */
function jobMatchKey(job = {}) {
  return extractStableJobId(job.url) || String(job.slug || '').trim().toLowerCase();
}

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
    if (!prev) { added += 1; return job; }
    updated += 1;
    return {
      ...prev,
      ...job,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, job.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(prev.descriptionByLocale, job.descriptionByLocale, 30),
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale, job.slugByLocale, 3),
    };
  });

  const allJobs = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, allJobs);
  writeJson(PUBLIC_JOBS, allJobs);

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME);
  writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);
  writeJobsSummary(mergedTarget, COMPANY_NAME);
  printPublishedJobUrls(mergedTarget, COMPANY_NAME);
  return { total: mergedTarget.length, added, updated, diff };
}

/* ── Adapter ───────────────────────────────────────────────── */
function updateAdapterConfig(jobs) {
  const seedMetaByUrl = {};
  for (const job of jobs) {
    seedMetaByUrl[job.url] = { location: 'Cadro (Lugano)', canton: HQ.canton, company: COMPANY_NAME };
  }
  writeJson(ADAPTER_PATH, {
    companyKey: COMPANY_KEY,
    companyName: COMPANY_NAME,
    companyHost: COMPANY_HOST,
    enabled: true,
    priority: 10,
    crawlerModes: ['html'],
    seedUrls: [CAREERS_URL],
    notes: 'Centiel — UPS/power protection in Cadro, Lugano TI. Careers are inline accordion items on a single page with PDF job descriptions.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

/* ── Validation ────────────────────────────────────────────── */
function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_CENTIEL_STRICT',
    label: COMPANY_NAME,
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_centiel_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Centiel jobs found after dedicated crawl.',
    detectSourceLang: () => 'en',
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'centiel');
  console.log('═══════════════════════════════════════════════');
  console.log('  Centiel — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  // 1. Fetch and parse
  console.log('🔍 Fetching Centiel careers page...');
  const html = await fetchCareersHtml();
  const listings = parseCareersPage(html);
  console.log(`📋 Found ${listings.length} job listings:`);
  for (const l of listings) {
    console.log(`  📄 ${l.title} (${l.workplace})`);
  }

  if (listings.length === 0) {
    console.log('ℹ️ No job listings found on the Centiel careers page.');
    return;
  }

  // 2. Fetch each PDF for the full role description (sequential to be
  //    polite to centiel.com — 5 PDFs typical).
  console.log('\n📄 Fetching role PDFs for full descriptions...');
  for (const l of listings) {
    l.pdfText = await fetchPdfText(l.pdfUrl);
    const pdfWords = (l.pdfText || '').split(/\s+/).filter(Boolean).length;
    console.log(`  ${pdfWords > 0 ? '✓' : '∅'} ${l.title} → PDF ${pdfWords} words`);
  }

  // 3. Build job objects
  const jobs = listings.map(buildJob);

  // 4. Merge into jobs.json
  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  // 5. Translate missing locales
  console.log('\n🌐 Running locale fill for Centiel jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  // 6. Validate
  validateLocales();

  console.log('\n📊 === Centiel Job Stats ===');
  console.log(`  ⚡ Total Centiel jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'centiel',
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
  console.error(`❌ Centiel crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
