#!/usr/bin/env node
/**
 * Dedicated Città di Mendrisio crawler runner.
 *
 * Source:
 *   https://mendrisio.ch/home/lavorare/lavorare-per-la-citta/concorsi-di-lavoro.html
 *
 * The Mendrisio concorsi page loads job listings from two sources:
 *   1. AJAX endpoint — pi-ASP (P&I) ATS jobs with UUIDs, PDF downloads,
 *      and application links at cittamen.pi-asp.de
 *   2. Static HTML — additional listings embedded directly in the page body
 *      (e.g., seasonal positions with PDF-only applications)
 *
 * Discovery flow:
 *   1. Fetch AJAX endpoint for pi-ASP job listings
 *   2. Fetch main page for static listings outside the AJAX container
 *   3. Parse both HTML sources for job articles
 *   4. Build job objects with descriptions, PDF links, apply URLs
 *   5. Merge into data/jobs.json (add new, update existing, prune stale)
 *   6. Run the base crawler for AI localization (4 locales)
 *   7. Post-process: fix company name, location, canton
 *   8. Validate locale coverage across IT/EN/DE/FR
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
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  mergeLocaleTextMap,
  detectLang,
} from './lib/dedicated-crawler-common.mjs';
import {
  buildPdfBackedDescription,
  extractPdfJobContentFromUrl,
} from './lib/pdf-job-content.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const MENDRISIO_KEY = 'citta-di-mendrisio';
const HQ = getCompanyDefaults('mendrisio');
const MENDRISIO_COMPANY_NAME = 'Città di Mendrisio';
const MENDRISIO_HOST = 'mendrisio.ch';
const MENDRISIO_CAREERS_URL =
  'https://mendrisio.ch/home/lavorare/lavorare-per-la-citta/concorsi-di-lavoro.html';
const MENDRISIO_AJAX_URL =
  'https://mendrisio.ch/home/lavorare/lavorare-per-la-citta/concorsi-di-lavoro/content/04.html?ajax=true';
const LOCALES = ['it', 'en', 'de', 'fr'];

/* ── Helpers ───────────────────────────────────────────────── */
function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Word-level overlap between two strings (0..1).
 */
function titleOverlap(a, b) {
  if (!a || !b) return 0;
  const clean = (s) =>
    String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean);
  const wordsA = new Set(clean(a));
  const wordsB = new Set(clean(b));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let common = 0;
  for (const w of wordsA) if (wordsB.has(w)) common++;
  return common / Math.min(wordsA.size, wordsB.size);
}

/**
 * Normalize a Mendrisio concorso title into a proper job title.
 * Strips leading quantities, "Cercansi", "Un o una", etc.
 * Capitalizes the first letter of the role.
 */
function normalizeJobTitle(rawTitle = '') {
  let t = normalizeSpace(rawTitle);
  if (!t) return t;

  // Strip leading quantity: "1 apprendista" → "Apprendista", "3 apprendisti/e" → "Apprendisti/e"
  t = t.replace(/^\d+\s+/, '');

  // Strip "Cercansi " prefix: "Cercansi bagnini..." → "Bagnini..."
  t = t.replace(/^cercansi\s+/i, '');

  // Strip "Un o una " / "Un o Un " prefix: "Un o una educatore/trice" → "Educatore/trice"
  t = t.replace(/^un\s+o\s+un[ao]?\s+/i, '');

  // Capitalize first letter
  if (t.length > 0) {
    t = t.charAt(0).toUpperCase() + t.slice(1);
  }

  return t;
}

/**
 * Guard: reject titles that are too generic (no role specification).
 */
function isTitleTooGeneric(title = '') {
  const t = normalize(title);
  // Generic headings without role specifics
  if (/^concorso$/i.test(t)) return true;
  if (/^apprendistato$/i.test(t)) return true;
  if (/^concorso per l.assunzione/i.test(t) && t.length < 50) return true;
  if (/^bando$/i.test(t)) return true;
  if (t.length < 5) return true;
  return false;
}

function slugify(text = '', suffix = '') {
  let s = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (suffix) {
    s = `${s}-${suffix}`.replace(/--+/g, '-');
  }
  return s.slice(0, 200);
}

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&#0*38;|&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&agrave;/gi, 'à')
    .replace(/&egrave;/gi, 'è')
    .replace(/&igrave;/gi, 'ì')
    .replace(/&ograve;/gi, 'ò')
    .replace(/&ugrave;/gi, 'ù')
    .replace(/&rsquo;/gi, '\u2019')
    .replace(/&lsquo;/gi, '\u2018')
    .replace(/&rdquo;/gi, '\u201D')
    .replace(/&ldquo;/gi, '\u201C')
    .replace(/&ndash;/gi, '\u2013')
    .replace(/&mdash;/gi, '\u2014')
    .replace(/&nbsp;/gi, ' ')
    .trim();
}

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isMendrisioJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();

  return (
    key === MENDRISIO_KEY ||
    key === 'citta-mendrisio' ||
    key.startsWith('citta-di-mendrisio') ||
    (company.includes('mendrisio') && (company.includes('città') || company.includes('citta'))) ||
    url.includes('mendrisio.ch/home/lavorare') ||
    url.includes('mendrisio.ch/downloadConcorsiPdf')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === MENDRISIO_HOST ||
      host === `www.${MENDRISIO_HOST}` ||
      host.endsWith(`.${MENDRISIO_HOST}`) ||
      host === 'cittamen.pi-asp.de'
    );
  } catch {
    return false;
  }
}

/* ── HTML fetching ─────────────────────────────────────────── */
async function fetchPage(url, timeoutMs = 20000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'it-CH,it;q=0.9',
        'User-Agent':
          process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`⚠️ HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

/* ── HTML parsing — AJAX endpoint (pi-ASP jobs) ──────────── */
/**
 * Parse job articles from the AJAX endpoint HTML.
 *
 * Each article has:
 *   <article class="document">
 *     <ul><li><time datetime="YYYY-MM-DD">posted date</time></li></ul>
 *     <div class="content">
 *       <span class="note">In scadenza il: <time datetime="YYYY-MM-DD">deadline</time></span>
 *       <h3>Job Title</h3>
 *       <ul class="download-list">
 *         <li><a href="/downloadConcorsiPdf?uuid=UUID">Scarica PDF</a></li>
 *       </ul>
 *     </div>
 *     <div class="detail">
 *       <a href="https://cittamen.pi-asp.de/bewerber-web?...#position,id=UUID,...">Partecipa</a>
 *     </div>
 *   </article>
 */
function parseAjaxJobs(html) {
  const jobs = [];
  const articleRe = /<article\s+class="document">([\s\S]*?)<\/article>/gi;
  let match;

  while ((match = articleRe.exec(html)) !== null) {
    const block = match[1];

    // Extract posted date
    const dateMatch = block.match(/<time\s+datetime="(\d{4}-\d{2}-\d{2})">/);
    const datePosted = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];

    // Extract deadline
    const deadlineMatch = block.match(
      /In scadenza il:\s*<time\s+datetime="([^"]+)">/
    );
    const deadline = deadlineMatch ? deadlineMatch[1].split(' ')[0] : null;

    // Extract title
    const titleMatch = block.match(/<h3>([\s\S]*?)<\/h3>/);
    if (!titleMatch) continue;
    const rawTitle = normalizeSpace(decodeHtmlEntities(stripHtml(titleMatch[1])));
    if (!rawTitle || rawTitle.length < 3) continue;
    const title = normalizeJobTitle(rawTitle);
    if (isTitleTooGeneric(title)) {
      console.warn(`⚠️ Skipping too-generic AJAX title: "${rawTitle}"`);
      continue;
    }

    // Extract UUID from PDF link
    const pdfMatch = block.match(/\/downloadConcorsiPdf\?uuid=([a-f0-9-]+)/i);
    const uuid = pdfMatch ? pdfMatch[1] : null;
    const pdfUrl = uuid ? `https://mendrisio.ch/downloadConcorsiPdf?uuid=${uuid}` : null;

    // Extract apply URL (pi-ASP link)
    const applyMatch = block.match(/href="(https:\/\/cittamen\.pi-asp\.de\/bewerber-web[^"]+)"/i);
    const applyUrl = applyMatch ? decodeHtmlEntities(applyMatch[1]) : null;

    // Extract description text from content div
    const contentMatch = block.match(/<div\s+class="content">([\s\S]*?)<\/div>/);
    const contentHtml = contentMatch ? contentMatch[1] : '';
    // Remove the h3 title and download list from content
    const descHtml = contentHtml
      .replace(/<h3>[\s\S]*?<\/h3>/gi, '')
      .replace(/<ul\s+class="download-list">[\s\S]*?<\/ul>/gi, '')
      .replace(/<span\s+class="note">[\s\S]*?<\/span>/gi, '');

    jobs.push({
      title,
      datePosted,
      deadline,
      uuid,
      pdfUrl,
      applyUrl,
      descriptionHtml: descHtml,
      source: 'ajax',
    });
  }

  return jobs;
}

/* ── HTML parsing — main page (static listings) ──────────── */
/**
 * Parse static job listings embedded in the main page HTML
 * (outside the #simapItems1 AJAX container).
 *
 * These follow the same <article class="document"> structure but
 * may use /dam/jcr:UUID/filename.pdf for downloads and have
 * inline description text with application instructions.
 */
function parseStaticJobs(html) {
  const jobs = [];

  // Only look at content AFTER the simapItems1 div (static listings are below it)
  const markerIdx = html.indexOf('id="simapItems1"');
  if (markerIdx === -1) return jobs;

  // Find the closing div for simapItems1 and look after it
  const afterMarker = html.slice(markerIdx);
  const articleRe = /<article\s+class="document">([\s\S]*?)<\/article>/gi;
  let match;

  while ((match = articleRe.exec(afterMarker)) !== null) {
    const block = match[1];

    // Extract posted date
    const dateMatch = block.match(/<time\s+datetime="(\d{4}-\d{2}-\d{2}[^"]*)">/);
    const datePosted = dateMatch
      ? dateMatch[1].split(' ')[0]
      : new Date().toISOString().split('T')[0];

    // Extract deadline
    const deadlineMatch = block.match(
      /In scadenza il:\s*<time\s+datetime="([^"]+)">/
    );
    const deadline = deadlineMatch ? deadlineMatch[1].split(' ')[0] : null;

    // Extract title
    const titleMatch = block.match(/<h3>([\s\S]*?)<\/h3>/);
    if (!titleMatch) continue;
    const rawTitle = normalizeSpace(decodeHtmlEntities(stripHtml(titleMatch[1])));
    if (!rawTitle || rawTitle.length < 3) continue;
    const title = normalizeJobTitle(rawTitle);
    if (isTitleTooGeneric(title)) {
      console.warn(`⚠️ Skipping too-generic static title: "${rawTitle}"`);
      continue;
    }

    // Check for PDF link (either /downloadConcorsiPdf?uuid= or /dam/jcr:...)
    const pdfMatch = block.match(
      /href="(\/downloadConcorsiPdf\?uuid=[a-f0-9-]+|\/dam\/jcr:[^"]+\.pdf)"/i
    );
    const pdfUrl = pdfMatch
      ? `https://mendrisio.ch${decodeHtmlEntities(pdfMatch[1])}`
      : null;

    // Check for pi-ASP apply URL
    const applyMatch = block.match(
      /href="(https:\/\/cittamen\.pi-asp\.de\/bewerber-web[^"]+)"/i
    );
    const applyUrl = applyMatch ? decodeHtmlEntities(applyMatch[1]) : null;

    // Check for email application
    const emailMatch = block.match(/href="mailto:\s*([^"]+)"/i);
    const applyEmail = emailMatch ? emailMatch[1].trim() : null;

    // Extract UUID from PDF link if available
    const uuidMatch = (pdfUrl || '').match(/uuid=([a-f0-9-]+)/i);
    const uuid = uuidMatch ? uuidMatch[1] : null;

    // Extract description from content div
    const contentMatch = block.match(/<div\s+class="content">([\s\S]*?)<\/div>/);
    const contentHtml = contentMatch ? contentMatch[1] : '';
    const descText = normalizeSpace(
      decodeHtmlEntities(
        stripHtml(
          contentHtml
            .replace(/<h3>[\s\S]*?<\/h3>/gi, '')
            .replace(/<span\s+class="note">[\s\S]*?<\/span>/gi, '')
        )
      )
    );

    jobs.push({
      title,
      datePosted,
      deadline,
      uuid,
      pdfUrl,
      applyUrl: applyUrl || (applyEmail ? `mailto:${applyEmail}` : null),
      descriptionText: descText,
      source: 'static',
    });
  }

  return jobs;
}

/* ── Fetch and parse all Mendrisio jobs ──────────────────── */
async function fetchMendrisioJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  console.log(`🔍 Fetching Città di Mendrisio jobs...`);

  // Phase 1: AJAX endpoint (pi-ASP jobs)
  console.log(`  📡 AJAX endpoint: ${MENDRISIO_AJAX_URL}`);
  const ajaxHtml = await fetchPage(MENDRISIO_AJAX_URL, timeoutMs);
  const ajaxJobs = ajaxHtml ? parseAjaxJobs(ajaxHtml) : [];
  console.log(`  📋 AJAX jobs found: ${ajaxJobs.length}`);

  // Phase 2: Static page listings
  console.log(`  📄 Main page: ${MENDRISIO_CAREERS_URL}`);
  const pageHtml = await fetchPage(MENDRISIO_CAREERS_URL, timeoutMs);
  const staticJobs = pageHtml ? parseStaticJobs(pageHtml) : [];
  console.log(`  📋 Static jobs found: ${staticJobs.length}`);

  // Deduplicate by title (static jobs may duplicate AJAX jobs)
  const seenTitles = new Set(ajaxJobs.map((j) => normalize(j.title)));
  const uniqueStaticJobs = staticJobs.filter(
    (j) => !seenTitles.has(normalize(j.title))
  );
  if (staticJobs.length > uniqueStaticJobs.length) {
    console.log(
      `  🔄 Deduped: ${staticJobs.length - uniqueStaticJobs.length} static job(s) already in AJAX`
    );
  }

  const allParsed = [...ajaxJobs, ...uniqueStaticJobs];
  console.log(`\n📋 Total unique Mendrisio jobs discovered: ${allParsed.length}`);

  // Build job objects
  const jobs = await Promise.all(allParsed.map(async (parsed) => {
    const slug = slugify(parsed.title, 'mendrisio');
    const canonicalUrl = parsed.pdfUrl || `${MENDRISIO_CAREERS_URL}#${slug}`;
    const pdfContent = parsed.pdfUrl
      ? await extractPdfJobContentFromUrl(parsed.pdfUrl)
      : { text: '', error: '' };

    // Title–PDF overlap check: warn if job title keywords aren't in the PDF
    const pdfText = pdfContent.text || '';
    if (pdfText && pdfText.length > 100) {
      const overlap = titleOverlap(parsed.title, pdfText);
      if (overlap < 0.3) {
        console.warn(`⚠️ Low title–PDF overlap (${(overlap * 100).toFixed(0)}%) for "${parsed.title}" — PDF may be a shared/generic document`);
      }
    }

    const description = buildDescription(parsed, pdfText);

    const category = detectCategory(parsed.title);
    const experienceLevel = detectExperienceLevel(parsed.title);
    const employmentType = detectEmploymentType(parsed.title);

    const job = {
      url: canonicalUrl,
      applyUrl: parsed.applyUrl || MENDRISIO_CAREERS_URL,
      title: parsed.title,
      company: MENDRISIO_COMPANY_NAME,
      companyKey: MENDRISIO_KEY,
      location: 'Mendrisio',
      canton: HQ.canton,
      country: 'CH',
      description,
      descriptionByLocale: { it: description },
      titleByLocale: { it: parsed.title },
      slug,
      slugByLocale: { it: slug },
      sourceLang: detectLang(description || parsed.title, 'it'),
      category,
      datePosted: parsed.datePosted,
      validThrough: parsed.deadline || undefined,
      source: 'mendrisio-concorsi-crawler',
      employmentType,
      experienceLevel,
      sector: 'Amministrazione pubblica',
      _targetScope: { canton: HQ.canton, location: 'Mendrisio' },
      _enrichedFromDetail: true,
    };
    if (parsed.pdfUrl && pdfContent.error) {
      console.warn(`⚠️ Mendrisio PDF extraction fallback for "${parsed.title}": ${pdfContent.error}`);
    }
    return job;
  }));

  return jobs;
}

/* ── Description building ──────────────────────────────────── */
function buildDescription(parsed, pdfText = '') {
  const footerLines = [];
  if (parsed.deadline) footerLines.push(`Termine di iscrizione: ${parsed.deadline}.`);
  if (parsed.pdfUrl) footerLines.push('Bando ufficiale disponibile in PDF.');

  return buildPdfBackedDescription({
    introLines: [
      'Concorso pubblico presso la Città di Mendrisio.',
      `Posizione: ${parsed.title}.`,
    ],
    pdfText,
    fallbackText: parsed.descriptionText || '',
    footerLines,
  });
}

function detectCategory(title = '') {
  const t = normalize(title);
  if (/educato|docente|insegnante|maestr/i.test(t)) return 'education';
  if (/apprendist|afc|cfp|tirocin/i.test(t)) return 'apprenticeship';
  if (/ingegner|tecnic|elettric|informatic/i.test(t)) return 'engineering';
  if (/giardinier|paesaggist|manutenzi/i.test(t)) return 'maintenance';
  if (/bagnin|sport|piscin/i.test(t)) return 'hospitality';
  if (/impiegat|commerc|amministrat|segretari/i.test(t)) return 'admin';
  if (/social|assistente/i.test(t)) return 'social';
  return 'general';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/apprendist|afc|cfp|tirocin|stage|stagist/i.test(t)) return 'ENTRY';
  if (/senior|responsabile|capo|dirett/i.test(t)) return 'SENIOR';
  return 'MID';
}

function detectEmploymentType(title = '') {
  const t = normalize(title);
  if (/tempo indeterminato/i.test(t)) return 'FULL_TIME';
  if (/tempo determinato/i.test(t)) return 'CONTRACTOR';
  if (/part[\s-]?time|50%|60%|70%|80%/i.test(t)) return 'PART_TIME';
  if (/apprendist|afc|cfp/i.test(t)) return 'FULL_TIME';
  if (/stagional/i.test(t)) return 'TEMPORARY';
  return 'FULL_TIME';
}

/* ── Merge into data/jobs.json ─────────────────────────────── */
function canonicalizeUrl(url = '') {
  try {
    return new URL(url).href.replace(/\/$/, '').toLowerCase();
  } catch {
    return normalize(url);
  }
}

function filterEmpty(obj = {}) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && String(v).trim()) out[k] = v;
  }
  return out;
}

async function mergeMendrisioJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(MENDRISIO_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];

  const nonMendrisioJobs = allJobs.filter((j) => !isMendrisioJob(j));
  const existingMendrisioJobs = allJobs.filter(isMendrisioJob);

  const existingBySlug = new Map();
  for (const job of existingMendrisioJobs) {
    existingBySlug.set(normalize(job.slug || ''), job);
  }

  const discoveredBySlug = new Map();
  for (const job of discoveredJobs) {
    discoveredBySlug.set(normalize(job.slug || ''), job);
  }

  let added = 0;
  let updated = 0;
  let removed = 0;
  const merged = [];

  for (const discovered of discoveredJobs) {
    const key = normalize(discovered.slug);
    const existing = existingBySlug.get(key);

    if (existing) {
      // If newly enriched, clear stale translations so AI re-translates
      const prevDescByLocale = discovered._enrichedFromDetail
        ? { it: existing.descriptionByLocale?.it }
        : existing.descriptionByLocale || {};
      const prevTitleByLocale = discovered._enrichedFromDetail
        ? { it: existing.titleByLocale?.it }
        : existing.titleByLocale || {};
      const prevSlugByLocale = discovered._enrichedFromDetail
        ? { it: existing.slugByLocale?.it }
        : existing.slugByLocale || {};

      const updatedJob = {
        ...existing,
        title: discovered.title || existing.title,
        company: MENDRISIO_COMPANY_NAME,
        companyKey: MENDRISIO_KEY,
        location: 'Mendrisio',
        canton: HQ.canton,
        country: 'CH',
        applyUrl: discovered.applyUrl || existing.applyUrl,
        category: discovered.category || existing.category,
        sector: discovered.sector || existing.sector,
        source: 'mendrisio-concorsi-crawler',
        validThrough: discovered.validThrough || existing.validThrough,
        titleByLocale: mergeLocaleTextMap(prevTitleByLocale, discovered.titleByLocale, 3),
        descriptionByLocale: mergeLocaleTextMap(prevDescByLocale, discovered.descriptionByLocale, 30),
        slugByLocale: mergeLocaleTextMap(prevSlugByLocale, discovered.slugByLocale, 3),
      };

      if (
        discovered.description &&
        discovered.description.length > (existing.description || '').length
      ) {
        updatedJob.description = discovered.description;
      }

      // Clean up internal flag
      delete updatedJob._enrichedFromDetail;

      merged.push(updatedJob);
      updated++;
    } else {
      const newJob = { ...discovered };
      delete newJob._enrichedFromDetail;
      merged.push(newJob);
      added++;
    }
  }

  for (const [slug] of existingBySlug) {
    if (!discoveredBySlug.has(slug)) {
      removed++;
    }
  }

  const final = [...nonMendrisioJobs, ...merged];

  fs.writeFileSync(DATA_JOBS, JSON.stringify(final, null, 2) + '\n');
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(final, null, 2) + '\n');

  console.log(`\n📦 Merge results:`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);
  console.log(`  🗑️  Removed (stale): ${removed}`);
  console.log(`  📊 Total jobs in file: ${final.length}`);

  return { added, updated, removed, total: final.length };
}

/* ── Adapter management ────────────────────────────────────── */
function updateAdapterConfig() {
  const adapterPath = path.join(ADAPTERS_DIR, `${MENDRISIO_KEY}.json`);

  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  adapter.companyKey = MENDRISIO_KEY;
  adapter.companyName = MENDRISIO_COMPANY_NAME;
  adapter.companyHost = MENDRISIO_HOST;
  adapter.enabled = true;
  adapter.priority = 10;
  adapter.crawlerModes = ['html', 'pdf'];
  adapter.seedUrls = [MENDRISIO_CAREERS_URL, MENDRISIO_AJAX_URL];
  adapter.notes =
    'Città di Mendrisio concorsi crawler — AJAX endpoint for pi-ASP ATS jobs + static HTML for additional listings, with PDF text extraction for full bandi.';
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${MENDRISIO_KEY} updated.`);
}

/* ── Base crawler (AI localization only) ───────────────────── */
function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: MENDRISIO_KEY,
    localizeOnlyCompanyKeys: MENDRISIO_KEY,
    forceLocalizeKeys: MENDRISIO_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: '50',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '50',
    },
  });
}

/* ── Post-processing ───────────────────────────────────────── */
async function postProcessMendrisioJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of jobs) {
    if (!isMendrisioJob(job)) continue;

    if (job.company !== MENDRISIO_COMPANY_NAME) {
      job.company = MENDRISIO_COMPANY_NAME;
      fixed++;
    }
    if (job.companyKey !== MENDRISIO_KEY) {
      job.companyKey = MENDRISIO_KEY;
      fixed++;
    }
    job.canton = HQ.canton;
    job.country = 'CH';
    if (!job.location) {
      job.location = 'Mendrisio';
      fixed++;
    }

    if (/downloadConcorsiPdf/i.test(String(job.url || ''))) {
      const pdfContent = await extractPdfJobContentFromUrl(job.url);
      const refreshedDescription = buildDescription(
        {
          title: job.title,
          deadline: job.validThrough,
          pdfUrl: job.url,
          descriptionText: job.descriptionByLocale?.it || job.description || '',
        },
        pdfContent.text || ''
      );
      if (refreshedDescription && refreshedDescription !== job.description) {
        job.description = refreshedDescription;
        fixed++;
      }
      job.descriptionByLocale = {
        ...(job.descriptionByLocale || {}),
        it: refreshedDescription || job.descriptionByLocale?.it || job.description || '',
      };
    }
  }

  if (fixed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(
      `🔧 Post-processed ${fixed} Mendrisio jobs (fixed company/location/canton).`
    );
  }
}

/* ── Stats & validation ────────────────────────────────────── */
function logStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json not found — no stats available.');
    return { total: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const mendrisioJobs = allJobs.filter(isMendrisioJob);

  console.log(`\n📊 === Città di Mendrisio Job Stats ===`);
  console.log(`  🏢 Total Mendrisio jobs: ${mendrisioJobs.length}`);

  if (mendrisioJobs.length > 0) {
    console.log(`  📋 Jobs:`);
    for (const job of mendrisioJobs) {
      console.log(`     - ${job.title} (${job.location || 'Mendrisio'})`);
    }
  }

  const afterSnapshot = snapshotJobSlugs(mendrisioJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Città di Mendrisio');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Città di Mendrisio');
  return { total: mendrisioJobs.length, crawlDiff };

}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_MENDRISIO_STRICT',
    label: 'Città di Mendrisio',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isMendrisioJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_mendrisio_domain',
    failWhenNoJobs: false,
    noJobsMessage:
      'No Città di Mendrisio jobs found — the municipality may not have active openings.',
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(MENDRISIO_KEY, 'Città di Mendrisio');
  let crawlDiff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };
  console.log('═══════════════════════════════════════════════');
  console.log('  Città di Mendrisio — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${MENDRISIO_CAREERS_URL}\n`);

  // Snapshot before
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(MENDRISIO_KEY, DATA_JOBS).filter(isMendrisioJob))

  // Phase 1: Fetch and parse jobs
  const discoveredJobs = await fetchMendrisioJobs();

  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No Mendrisio jobs discovered.');
    console.log(
      '   The concorsi page may have changed structure or have no current openings.'
    );
    console.log('   Keeping existing jobs — no changes to data/jobs.json.');
    const _cdResult = logStats(beforeSnapshot);
    crawlDiff = _cdResult.crawlDiff || crawlDiff;
    return;
  }

  // Phase 2: Update adapter config
  updateAdapterConfig();

  // Phase 3: Merge into data/jobs.json
  await mergeMendrisioJobs(discoveredJobs);

  // Phase 4: Run base crawler for AI localization (EN/DE/FR translations)
  console.log('\n🌐 Running base crawler for AI localization of Mendrisio jobs...');
  await runBaseCrawler();

  // Phase 5: Post-process
  await postProcessMendrisioJobs();

  // Phase 6: Log stats
  const stats = logStats(beforeSnapshot);
  if (stats.total === 0) {
    console.log('ℹ️ No Mendrisio jobs found after crawl. No error — exiting OK.');
    return;
  }

  // Phase 7: Validate locale coverage
  validateLocales();

  console.log('\n✅ Città di Mendrisio crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isMendrisioJob) : [];
  writeJobsCrawlerSlice(MENDRISIO_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: MENDRISIO_KEY,
    label: 'Città di Mendrisio',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: crawlDiff.newJobs.length,
    updatedCount: crawlDiff.updatedJobs.length,
    removedCount: crawlDiff.removedJobs.length,
    unchangedCount: crawlDiff.unchangedCount,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: crawlDiff.newJobs.slice(0, 30),
    updatedJobs: crawlDiff.updatedJobs.slice(0, 30),
    removedJobs: crawlDiff.removedJobs.slice(0, 30),
    unchangedJobs: (crawlDiff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

main().catch((err) => {
  console.error(`❌ Città di Mendrisio crawler failed: ${err?.message || err}`);
  process.exit(1);
});
