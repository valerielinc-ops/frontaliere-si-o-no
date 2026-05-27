#!/usr/bin/env node
/**
 * Dedicated AIL SA (Aziende Industriali di Lugano) crawler runner.
 *
 * Source:
 *   https://www.ail.ch/AIL/risorse-umane/offerte-di-lavoro.html
 *
 * The AIL careers page loads job listings via an AJAX endpoint:
 *   /AIL/risorse-umane/offerte-di-lavoro/content/0.html?ajax=true
 *
 * Each job listing has a PDF download link with the full job description.
 * There is no dedicated detail HTML page — all info is in the PDF.
 *
 * Discovery flow:
 *   1. Fetch the AJAX endpoint for job listing HTML
 *   2. Parse job articles: title, dates, PDF UUID, apply URL
 *   3. Download and extract text from each job's PDF
 *   4. Build job objects with PDF-backed descriptions
 *   5. Merge into data/jobs.json (add new, update existing, prune stale)
 *   6. Run the base crawler for AI localization (4 locales)
 *   7. Post-process: fix company name, location, canton
 *   8. Validate locale coverage across IT/EN/DE/FR
 */
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
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
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  detectLang,
  mergeLocaleTextMap,
} from './lib/dedicated-crawler-common.mjs';
import {
  buildPdfBackedDescription,
  extractPdfJobContentFromUrl,
} from './lib/pdf-job-content.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'ail-lugano';
const HQ = getCompanyDefaults(COMPANY_KEY);
const COMPANY_NAME = 'Aziende Industriali di Lugano (AIL) SA';
const COMPANY_HOST = 'ail.ch';
const CAREERS_URL =
  'https://www.ail.ch/AIL/risorse-umane/offerte-di-lavoro.html';
const AJAX_URL =
  'https://www.ail.ch/AIL/risorse-umane/offerte-di-lavoro/content/0.html?ajax=true';
const BASE_URL = 'https://www.ail.ch';
const LOCALES = ['it', 'en', 'de', 'fr'];

/* ── Helpers ───────────────────────────────────────────────── */
function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
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

function isTargetJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();

  return (
    key === COMPANY_KEY ||
    key === 'aziende-industriali-di-lugano-ail-sa' ||
    key.startsWith('ail-lugano') ||
    (company.includes('industriali') && company.includes('lugano')) ||
    (company.includes('ail') && company.includes('lugano')) ||
    url.includes('ail.ch/downloadJobPosition')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'ail.ch' || host === 'www.ail.ch';
  } catch {
    return false;
  }
}

/* ── Date parsing ──────────────────────────────────────────── */
const ITALIAN_MONTHS = {
  gennaio: '01', febbraio: '02', marzo: '03', aprile: '04',
  maggio: '05', giugno: '06', luglio: '07', agosto: '08',
  settembre: '09', ottobre: '10', novembre: '11', dicembre: '12',
};

function parseItalianDate(dateStr = '') {
  // Format: "25 febbraio 2026"
  const m = dateStr.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (!m) return '';
  const day = m[1].padStart(2, '0');
  const month = ITALIAN_MONTHS[m[2].toLowerCase()];
  const year = m[3];
  if (!month) return '';
  return `${year}-${month}-${day}`;
}

/* ── HTML fetching ─────────────────────────────────────────── */
async function fetchPage(url, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; FrontaliereBot/1.0; +https://frontaliereticino.ch)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) {
      console.warn(`⚠️ HTTP ${res.status} for ${url}`);
      return '';
    }
    return await res.text();
  } catch (err) {
    console.warn(`⚠️ Fetch failed for ${url}: ${err?.message || err}`);
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/* ── Listing page parsing ──────────────────────────────────── */

/**
 * Extract the job title from PDF text.
 * AIL PDFs typically contain "per il ruolo di {TITLE}" before the tasks section.
 */
function extractTitleFromPdf(pdfText = '') {
  if (!pdfText) return '';
  // Pattern: "per il ruolo di <TITLE>" followed by tasks/impact section
  const roleMatch = pdfText.match(
    /per il ruolo di\s+(.+?)(?:\s*Cosa farai|\s*Il tuo impatto|\s*Requisiti|\s*Chi cerchiamo|\s*Le tue|$)/i
  );
  if (roleMatch) return normalizeSpace(roleMatch[1]);

  // Fallback: look for "Posizione:" or "Ruolo:" lines
  const posMatch = pdfText.match(/(?:Posizione|Ruolo)\s*:\s*(.+?)(?:\n|$)/i);
  if (posMatch) return normalizeSpace(posMatch[1]);

  return '';
}

/**
 * Compute word-level overlap between two title strings.
 * Returns a value 0..1 representing how many words from `expected` appear in `actual`.
 */
function titleOverlap(expected = '', actual = '') {
  const norm = (s) =>
    s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const expWords = norm(expected).split(' ').filter(Boolean);
  const actWords = new Set(norm(actual).split(' ').filter(Boolean));
  if (expWords.length === 0) return 1;
  const matches = expWords.filter((w) => actWords.has(w)).length;
  return matches / expWords.length;
}

function parseListingPage(html) {
  const jobs = [];

  // Each job is in <article class="job-position">...</article>
  const articleRegex = /<article\s+class="job-position">([\s\S]*?)<\/article>/gi;
  let articleMatch;

  while ((articleMatch = articleRegex.exec(html)) !== null) {
    const block = articleMatch[1];

    // Title from <h4>
    const titleMatch = block.match(/<h4>([\s\S]*?)<\/h4>/i);
    const title = titleMatch
      ? normalizeSpace(decodeHtmlEntities(titleMatch[1]))
      : '';

    if (!title) continue;

    // Dates from <div class="job-dates">
    const pubDateMatch = block.match(
      /Data di pubblicazione\s*<span>([\s\S]*?)<\/span>/i
    );
    const closeDateMatch = block.match(
      /Data di chiusura\s*<span>([\s\S]*?)<\/span>/i
    );
    const datePosted = pubDateMatch
      ? parseItalianDate(normalizeSpace(pubDateMatch[1]))
      : new Date().toISOString().slice(0, 10);
    const validThrough = closeDateMatch
      ? parseItalianDate(normalizeSpace(closeDateMatch[1]))
      : '';

    // PDF link: /downloadJobPosition?uuid=UUID
    const pdfMatch = block.match(
      /href="(\/downloadJobPosition\?uuid=[a-f0-9-]+)"/i
    );
    const pdfUrl = pdfMatch
      ? `${BASE_URL}${decodeHtmlEntities(pdfMatch[1])}`
      : '';

    // UUID extraction
    const uuidMatch = (pdfUrl || '').match(/uuid=([a-f0-9-]+)/i);
    const uuid = uuidMatch ? uuidMatch[1] : '';

    // Apply URL
    const applyUrl = uuid
      ? `${BASE_URL}/AIL/risorse-umane/concorsi.html?applicationId=${uuid}`
      : CAREERS_URL;

    jobs.push({
      title,
      datePosted,
      validThrough,
      pdfUrl,
      uuid,
      applyUrl,
    });
  }

  return jobs;
}

/* ── Category & experience detection ───────────────────────── */
function detectCategory(title = '') {
  const t = normalize(title);
  if (/elettric|rete|distribuzione|energia/i.test(t)) return 'engineering';
  if (/project\s*manager|responsabile|dirett|coordinat/i.test(t)) return 'management';
  if (/manutenzi|manutentr|impiant/i.test(t)) return 'maintenance';
  if (/ingegner|analista|tecnic/i.test(t)) return 'engineering';
  if (/informatica|software|developer|ict/i.test(t)) return 'it';
  if (/impiegat|amministrat|segretari|audit|revision/i.test(t)) return 'admin';
  if (/apprendist|afc|cfp|tirocin/i.test(t)) return 'apprenticeship';
  return 'general';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/apprendist|afc|cfp|tirocin|stage|stagist|junior/i.test(t)) return 'ENTRY';
  if (/senior|responsabile|capo|dirett|manager|head/i.test(t)) return 'SENIOR';
  return 'MID';
}

function detectEmploymentType(title = '') {
  const t = normalize(title);
  if (/part[\s-]?time|50%|60%|70%|80%/i.test(t)) return 'PART_TIME';
  if (/tempo determinato|temporane/i.test(t)) return 'TEMPORARY';
  if (/stagional/i.test(t)) return 'TEMPORARY';
  return 'FULL_TIME';
}

/* ── Main discovery ────────────────────────────────────────── */
async function fetchAilJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  console.log(`🔍 Fetching AIL SA jobs...`);
  console.log(`  📡 AJAX endpoint: ${AJAX_URL}`);

  const ajaxHtml = await fetchPage(AJAX_URL, timeoutMs);
  if (!ajaxHtml) {
    console.warn('⚠️ Failed to fetch AJAX listing page.');
    return [];
  }

  const listings = parseListingPage(ajaxHtml);
  console.log(`  📋 Found ${listings.length} job listing(s) on page.`);

  // Fetch PDF content for each job
  const jobs = [];
  for (const listing of listings) {
    console.log(`  📄 Extracting PDF: ${listing.title}`);

    const pdfContent = listing.pdfUrl
      ? await extractPdfJobContentFromUrl(listing.pdfUrl)
      : { text: '', error: '' };

    if (listing.pdfUrl && pdfContent.error) {
      console.warn(
        `  ⚠️ PDF extraction failed for "${listing.title}": ${pdfContent.error}`
      );
    }

    // Validate title against PDF content
    let title = listing.title;
    if (pdfContent.text) {
      const pdfTitle = extractTitleFromPdf(pdfContent.text);
      if (pdfTitle) {
        const overlap = titleOverlap(title, pdfTitle);
        if (overlap < 0.7) {
          console.warn(
            `  ⚠️ Title mismatch: listing="${title}" vs PDF="${pdfTitle}" (overlap=${overlap.toFixed(2)})`
          );
          // Prefer the PDF title when overlap is low — it's the official source
          title = pdfTitle;
          console.log(`    → Using PDF title: "${title}"`);
        } else {
          console.log(`    ✅ Title OK (overlap=${overlap.toFixed(2)})`);
        }
      }
    }

    const description = buildPdfBackedDescription({
      introLines: [
        `## ${title}`,
        `${COMPANY_NAME} — posizione aperta a Lugano/Muzzano (TI).`,
      ],
      pdfText: pdfContent.text || '',
      fallbackText: `Posizione: ${title} presso ${COMPANY_NAME}. Consultare il bando ufficiale (PDF) per maggiori dettagli.`,
      footerLines: [
        '---',
        listing.validThrough
          ? `**Termine di candidatura:** ${listing.validThrough}`
          : '',
        '**Settore:** Energia / Servizi pubblici',
        '**Sede:** Via Industria 2, 6933 Muzzano (Lugano), TI, Svizzera',
        `[Bando ufficiale (PDF)](${listing.pdfUrl || CAREERS_URL})`,
      ].filter(Boolean),
    });

    const slug = slugify(title, COMPANY_KEY);

    const job = {
      title,
      company: COMPANY_NAME,
      companyKey: COMPANY_KEY,
      location: 'Lugano',
      canton: HQ.canton,
      country: 'CH',
      // Use the careers page URL (HTML) as the job URL for audit compatibility.
      // The PDF URL is preserved as applyUrl and in the description footer.
      url: CAREERS_URL,
      applyUrl: listing.applyUrl,
      description,
      category: detectCategory(title),
      sector: 'Energia / Servizi pubblici',
      employmentType: detectEmploymentType(title),
      experienceLevel: detectExperienceLevel(title),
      source: 'ail-lugano-crawler',
      datePosted: listing.datePosted,
      validThrough: listing.validThrough || undefined,
      titleByLocale: { it: title },
      descriptionByLocale: { it: description },
      slug,
      slugByLocale: { it: slug },
      sourceLang: detectLang(description || title, 'it'),
      _targetScope: { canton: HQ.canton, location: 'Lugano' },
    };

    jobs.push(job);
    // Small delay between PDF fetches
    await new Promise((r) => setTimeout(r, 300));
  }

  return jobs;
}

/* ── Merge ─────────────────────────────────────────────────── */
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

function jobMatchKey(job) {
  // Match by UUID from PDF URL or by slug
  const url = String(job?.url || '');
  const uuidMatch = url.match(/uuid=([a-f0-9-]+)/i);
  if (uuidMatch) return `uuid:${uuidMatch[1].toLowerCase()}`;
  return `slug:${normalize(job?.slug || '')}`;
}

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];

  const nonTargetJobs = allJobs.filter((j) => !isTargetJob(j));
  const existingTargetJobs = allJobs.filter(isTargetJob);

  const existingByKey = new Map();
  for (const job of existingTargetJobs) {
    existingByKey.set(jobMatchKey(job), job);
  }

  const discoveredByKey = new Map();
  for (const job of discoveredJobs) {
    discoveredByKey.set(jobMatchKey(job), job);
  }

  let added = 0;
  let updated = 0;
  let removed = 0;
  const merged = [];

  for (const discovered of discoveredJobs) {
    const key = jobMatchKey(discovered);
    const ex = existingByKey.get(key);

    if (ex) {
      const updatedJob = {
        ...ex,
        title: discovered.title || ex.title,
        company: COMPANY_NAME,
        companyKey: COMPANY_KEY,
        location: discovered.location || ex.location,
        canton: HQ.canton,
        country: 'CH',
        applyUrl: discovered.applyUrl || ex.applyUrl,
        category: discovered.category || ex.category,
        sector: discovered.sector || ex.sector,
        source: 'ail-lugano-crawler',
        validThrough: discovered.validThrough || ex.validThrough,
        titleByLocale: mergeLocaleTextMap(ex.titleByLocale, discovered.titleByLocale, 3),
        descriptionByLocale: mergeLocaleTextMap(ex.descriptionByLocale, discovered.descriptionByLocale, 30),
        slugByLocale: mergeLocaleTextMap(ex.slugByLocale, discovered.slugByLocale, 3),
      };

      if (
        discovered.description &&
        discovered.description.length > (ex.description || '').length
      ) {
        updatedJob.description = discovered.description;
        // Clear stale locale translations when description changes significantly
        const prevLen = (ex.description || '').length;
        const newLen = discovered.description.length;
        if (Math.abs(newLen - prevLen) > 100) {
          updatedJob.descriptionByLocale = {
            ...filterEmpty(discovered.descriptionByLocale),
          };
        }
      }

      merged.push(updatedJob);
      updated++;
    } else {
      merged.push(discovered);
      added++;
    }
  }

  for (const [key] of existingByKey) {
    if (!discoveredByKey.has(key)) removed++;
  }

  const final = [...nonTargetJobs, ...merged];

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
  const adapterPath = path.join(ADAPTERS_DIR, `${COMPANY_KEY}.json`);

  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  adapter.companyKey = COMPANY_KEY;
  adapter.companyName = COMPANY_NAME;
  adapter.companyHost = COMPANY_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(adapter.priority || 0, 10);
  adapter.crawlerModes = ['html', 'pdf'];
  adapter.seedUrls = [CAREERS_URL, AJAX_URL];
  adapter.notes =
    'AIL SA — AJAX endpoint for job listings, PDF download for full descriptions. Job details are only in PDFs (no dedicated HTML detail pages).';
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${COMPANY_KEY} updated.`);
}

/* ── Base crawler (AI localization only) ───────────────────── */
function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: COMPANY_KEY,
    localizeOnlyCompanyKeys: COMPANY_KEY,
    forceLocalizeKeys: COMPANY_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: '20',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '20',
    },
  });
}

/* ── Post-processing ───────────────────────────────────────── */
function postProcessJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of jobs) {
    if (!isTargetJob(job)) continue;

    if (job.company !== COMPANY_NAME) {
      job.company = COMPANY_NAME;
      fixed++;
    }
    if (job.companyKey !== COMPANY_KEY) {
      job.companyKey = COMPANY_KEY;
      fixed++;
    }
    job.canton = HQ.canton;
    job.country = 'CH';
    if (!job.location) {
      job.location = 'Lugano';
      fixed++;
    }
  }

  if (fixed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(
      `🔧 Post-processed ${fixed} AIL jobs (fixed company/location/canton).`
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
  const targetJobs = allJobs.filter(isTargetJob);

  console.log(`\n📊 === AIL SA Job Stats ===`);
  console.log(`  🏢 Total AIL jobs: ${targetJobs.length}`);

  if (targetJobs.length > 0) {
    console.log(`  📋 Jobs:`);
    for (const job of targetJobs) {
      console.log(`     - ${job.title} (${job.location || 'Lugano'})`);
    }
  }

  const afterSnapshot = snapshotJobSlugs(targetJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'AIL SA');
  writeCrawlChangeSummaryToGH(crawlDiff, 'AIL SA');
  return { total: targetJobs.length, crawlDiff };

}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_AIL_STRICT',
    label: 'AIL SA',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_ail_domain',
    failWhenNoJobs: false,
    noJobsMessage:
      'No AIL SA jobs found — the company may not have active openings.',
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'AIL SA');
  let crawlDiff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };
  console.log('═══════════════════════════════════════════════');
  console.log('  AIL SA (Aziende Industriali di Lugano) — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  // Snapshot before
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isTargetJob))

  // Phase 1: Fetch and parse jobs
  const discoveredJobs = await fetchAilJobs();

  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No AIL jobs discovered.');
    console.log(
      '   The careers page may have changed structure or have no current openings.'
    );
    console.log('   Keeping existing jobs — no changes to data/jobs.json.');
    const _cdResult = logStats(beforeSnapshot);
    crawlDiff = _cdResult.crawlDiff || crawlDiff;
    return;
  }

  // Phase 2: Update adapter config
  updateAdapterConfig();

  // Phase 3: Merge into data/jobs.json
  await mergeJobs(discoveredJobs);

  // Phase 4: Run base crawler for AI localization (EN/DE/FR translations)
  console.log('\n🌐 Running base crawler for AI localization of AIL jobs...');
  await runBaseCrawler();
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  // Phase 5: Post-process
  postProcessJobs();

  // Phase 6: Log stats
  const stats = logStats(beforeSnapshot);
  if (stats.total === 0) {
    console.log('ℹ️ No AIL jobs found after crawl. No error — exiting OK.');
    return;
  }

  // Phase 7: Validate locale coverage
  validateLocales();

  console.log('\n✅ AIL SA crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'AIL SA',
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
  console.error(`❌ AIL SA crawler failed: ${err?.message || err}`);
  process.exit(1);
});
