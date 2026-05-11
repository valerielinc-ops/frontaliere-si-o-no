#!/usr/bin/env node
/**
 * Dedicated OSCAM crawler runner.
 *
 * OSCAM — Ospedale e Casa Anziani Malcantonese is a public hospital and
 * elderly care facility in the Malcantone region of Ticino. It has two
 * main locations: Castelrotto (Ospedale) and Caslano (Casa Anziani).
 *
 * Job postings ("concorsi") are published on two WordPress-powered pages:
 *   - https://www.oscam.ch/lavoraconnoi/       (Ospedale — main page)
 *   - https://www.oscam.ch/lavoraconnoi-cam/   (Casa Anziani — subset)
 *
 * Discovery flow:
 *   1. Fetch both career pages
 *   2. Parse "CONCORSI ATTIVI" sections — extract h3 titles + PDF links
 *   3. Filter out non-job entries (forms, certificates)
 *   4. Deduplicate across both pages by PDF URL
 *   5. Build job objects with structured descriptions
 *   6. Merge into data/jobs.json (add new, update existing, prune stale)
 *   7. Run the base crawler for AI localization (4 locales)
 *   8. Post-process: fix company name, location, canton
 *   9. Validate locale coverage across IT/EN/DE/FR
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
import { validateJobUrls } from './lib/validate-job-url.mjs';
import {
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  mergeLocaleTextMap,
  detectLang,
} from './lib/dedicated-crawler-common.mjs';
import {
  extractPdfJobContentFromUrl,
  buildPdfBackedDescription,
} from './lib/pdf-job-content.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'oscam';
const HQ = getCompanyDefaults('oscam');
const COMPANY_NAME = 'OSCAM – Ospedale e Casa Anziani Malcantonese';
const COMPANY_HOST = 'www.oscam.ch';
const CAREERS_URLS = [
  'https://www.oscam.ch/lavoraconnoi/',
  'https://www.oscam.ch/lavoraconnoi-cam/',
];
const LOCALES = ['it', 'en', 'de', 'fr'];

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(text = '') {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
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

function decodeHtmlEntities(html = '') {
  return String(html)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"');
}

function stripHtml(html = '') {
  return decodeHtmlEntities(
    html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
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
    key === 'oscam-ospedale-e-casa-anziani-malcantonese' ||
    key.startsWith('oscam') ||
    (company.includes('oscam') && (company.includes('ospedale') || company.includes('malcanton'))) ||
    url.includes('oscam.ch')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'oscam.ch' || host === 'www.oscam.ch';
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// HTML fetching
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// Job listing parsing
// ─────────────────────────────────────────────────────────────

/**
 * Parse the WordPress-powered careers page for "CONCORSI ATTIVI".
 *
 * HTML structure for each job:
 *   <h3>Job Title</h3>
 *   <h4>
 *     <a href="icon.pdf"><img .../></a>
 *     <span>  Apri il </span>
 *     <a href="https://www.oscam.ch/wp-content/uploads/.../concorso.pdf">Title</a>
 *   </h4>
 *
 * Non-job entries (Certificato medico, Autocertificazioni) must be skipped.
 */
function parseListingPage(html) {
  const jobs = [];

  // Extract the CONCORSI ATTIVI section
  const concorsiStart = html.indexOf('CONCORSI ATTIVI');
  if (concorsiStart === -1) {
    console.warn('⚠️ Could not find "CONCORSI ATTIVI" section.');
    return jobs;
  }

  // Find the end of the concorsi section (CANDIDATURE heading or end of content)
  const afterConcorsi = html.slice(concorsiStart);
  const sectionEnd = afterConcorsi.search(/CANDIDATURE|NORMATIVA|<\/article>/i);
  const section = sectionEnd > 0 ? afterConcorsi.slice(0, sectionEnd) : afterConcorsi;

  // Find all <h3> blocks with following <h4> that contains PDF links
  const h3Regex = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  let match;

  while ((match = h3Regex.exec(section)) !== null) {
    const rawTitle = normalizeSpace(stripHtml(match[1]));
    if (!rawTitle) continue;

    // Skip non-job entries (administrative forms)
    if (/certificato\s+medico|autocertificazion/i.test(rawTitle)) continue;

    // Look for the PDF link in the following <h4> block
    const afterH3 = section.slice(match.index + match[0].length);
    const h4Match = afterH3.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i);
    if (!h4Match) continue;

    const h4Block = h4Match[1];

    // Find the concorso PDF link — it's the <a> tag after "Apri il" span,
    // typically the second <a> in the <h4> (first is the icon link)
    const pdfLinks = [...h4Block.matchAll(/<a\s[^>]*href="([^"]*\.pdf)"[^>]*>/gi)];
    // The actual concorso PDF is usually the last <a> with a PDF href
    // that points to a concorso file (not an icon)
    let pdfUrl = null;
    for (const pl of pdfLinks) {
      const href = pl[1];
      if (href && !href.includes('icon') && /concorso|generale/i.test(href)) {
        pdfUrl = href;
      }
    }
    // If no match with "concorso" in name, take the last PDF link that isn't tiny/icon
    if (!pdfUrl && pdfLinks.length > 0) {
      pdfUrl = pdfLinks[pdfLinks.length - 1][1];
    }

    if (!pdfUrl) continue;

    // Also extract the anchor text from the PDF link for a better title
    const pdfAnchorText = h4Block.match(
      /<a\s[^>]*href="[^"]*\.pdf"[^>]*>([\s\S]*?)<\/a>/gi
    );
    let anchorTitle = rawTitle;
    if (pdfAnchorText && pdfAnchorText.length > 0) {
      const lastAnchor = pdfAnchorText[pdfAnchorText.length - 1];
      const extracted = normalizeSpace(stripHtml(lastAnchor.replace(/<a[^>]*>/i, '').replace(/<\/a>/i, '')));
      if (extracted && extracted.length > 5 && !/^\s*$/.test(extracted)) {
        anchorTitle = extracted;
      }
    }

    jobs.push({
      title: anchorTitle || rawTitle,
      pdfUrl: pdfUrl.startsWith('http') ? pdfUrl : `https://www.oscam.ch${pdfUrl}`,
    });
  }

  return jobs;
}

// ─────────────────────────────────────────────────────────────
// Description building (PDF-backed)
// ─────────────────────────────────────────────────────────────

function buildDescription(title, pdfText = '') {
  return buildPdfBackedDescription({
    introLines: [
      `## Concorso`,
      `${COMPANY_NAME} pubblica il seguente concorso: ${title}.`,
    ],
    pdfText,
    fallbackText: 'Per i dettagli completi del concorso, consultare il bando PDF allegato.',
    footerLines: [
      '---',
      '**Settore:** Sanità pubblica / Assistenza anziani',
      '**Sede Ospedale:** Via Cantonale 4, 6980 Castelrotto (TI), Svizzera',
      '**Sede Casa Anziani:** Via Simen, 6987 Caslano (TI), Svizzera',
      '**Contatto:** info@oscam.ch | Tel. +41 (0)91 611 37 00',
    ],
  });
}

/**
 * Validate OSCAM job description quality.
 * @param {string} description
 * @param {string} pdfText
 * @returns {{ ok: boolean, warnings: string[] }}
 */
function validateOscamDescription(description, pdfText = '') {
  const warnings = [];
  const descLen = (description || '').length;
  const pdfLen = (pdfText || '').length;

  if (descLen < 500 && pdfLen > 200) {
    warnings.push(`Description too short: ${descLen} chars (min 500 when PDF has ${pdfLen} chars)`);
  }

  // Count meaningful content blocks: paragraphs OR sentence groups
  const blocks = (description || '').split(/\n{2,}/).filter((p) => p.trim().length > 20);
  const sentences = (description || '').split(/[.!?]\s+/).filter((s) => s.trim().length > 20);
  const contentBlocks = Math.max(blocks.length, Math.floor(sentences.length / 3));
  if (contentBlocks < 3 && pdfLen > 300) {
    warnings.push(`Too few content blocks: ${contentBlocks} (need at least 3 from PDF with ${pdfLen} chars)`);
  }

  // Check ratio: description should capture at least 20% of PDF text
  if (pdfLen > 200 && descLen / pdfLen < 0.2) {
    warnings.push(
      `Low PDF coverage: ${descLen}/${pdfLen} = ${(descLen / pdfLen).toFixed(2)} (min 0.2)`
    );
  }

  return { ok: warnings.length === 0, warnings };
}

// ─────────────────────────────────────────────────────────────
// Category & experience detection
// ─────────────────────────────────────────────────────────────

function detectCategory(title = '') {
  const t = normalize(title);
  if (/contabil|finanz|amministra|conteg|vice[\s-]*responsabile/i.test(t)) return 'admin';
  if (/infermier|medico|sanitar|fisioterapi|ergoterapi|farmaci/i.test(t)) return 'healthcare';
  if (/cuoco|cucina|panettier|pasticcer|fornaio/i.test(t)) return 'hospitality';
  if (/responsabile|dirett|manager|coordinat|capo/i.test(t)) return 'management';
  if (/assistente|operatore|operatrice|oss|asa/i.test(t)) return 'social-services';
  if (/stage|stagiaire|stagist/i.test(t)) return 'internship';
  if (/apprendist|afc|cfp|formazione/i.test(t)) return 'apprenticeship';
  if (/generale/i.test(t)) return 'general';
  return 'general';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/apprendist|afc|cfp|stage|stagist|stagiaire|junior|assistente/i.test(t)) return 'ENTRY';
  if (/senior|responsabile|capo|dirett|manager|head|vice[\s-]*responsabile/i.test(t))
    return 'SENIOR';
  return 'MID';
}

function detectEmploymentType(title = '') {
  const pctMatch = title.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/);
  if (pctMatch) {
    const max = parseInt(pctMatch[2], 10);
    return max >= 100 ? 'FULL_TIME' : 'PART_TIME';
  }
  if (/100\s*%|full[\s-]?time/i.test(title)) return 'FULL_TIME';
  if (/part[\s-]?time|50%|60%|70%|80%/i.test(title)) return 'PART_TIME';
  if (/stage|stagiaire/i.test(title)) return 'INTERN';
  return 'FULL_TIME';
}

// ─────────────────────────────────────────────────────────────
// Main discovery
// ─────────────────────────────────────────────────────────────

async function fetchOscamJobs() {
  const seenPdfUrls = new Set();
  const allJobs = [];

  for (const url of CAREERS_URLS) {
    console.log(`📡 Fetching careers page: ${url}`);
    const html = await fetchPage(url);
    if (!html) {
      console.warn(`⚠️ Failed to fetch: ${url}`);
      continue;
    }

    const listings = parseListingPage(html);
    console.log(`📋 Found ${listings.length} concorso(i) on ${url}`);

    for (const listing of listings) {
      // Deduplicate by PDF URL across pages
      if (seenPdfUrls.has(listing.pdfUrl)) {
        console.log(`  ⏭️  Skipping duplicate: ${listing.title}`);
        continue;
      }
      seenPdfUrls.add(listing.pdfUrl);

      console.log(`  📄 Processing: ${listing.title}`);

      // Fetch and extract PDF content
      console.log(`    📎 Fetching PDF: ${listing.pdfUrl}`);
      const pdfContent = await extractPdfJobContentFromUrl(listing.pdfUrl);
      const pdfText = pdfContent.text || '';

      if (pdfContent.error) {
        console.warn(`    ⚠️ PDF extraction failed: ${pdfContent.error}`);
      } else {
        console.log(`    ✅ PDF text: ${pdfText.length} chars (${pdfContent.totalPages} pages)`);
      }

      const description = buildDescription(listing.title, pdfText);

      // Validate quality
      const validation = validateOscamDescription(description, pdfText);
      if (!validation.ok) {
        console.warn(`    ⚠️ Quality warnings for "${listing.title}":`);
        for (const w of validation.warnings) console.warn(`      - ${w}`);
      }

      const slug = slugify(listing.title, COMPANY_KEY);

      const job = {
        title: listing.title,
        slug,
        company: COMPANY_NAME,
        companyKey: COMPANY_KEY,
        location: 'Castelrotto',
        canton: HQ.canton,
        country: 'CH',
        url: listing.pdfUrl,
        applyUrl: 'mailto:info@oscam.ch',
        description,
        category: detectCategory(listing.title),
        sector: 'Sanità pubblica / Assistenza anziani',
        employmentType: detectEmploymentType(listing.title),
        experienceLevel: detectExperienceLevel(listing.title),
        source: 'oscam-crawler',
        postedDate: new Date().toISOString().slice(0, 10),
        titleByLocale: { it: listing.title },
        descriptionByLocale: { it: description },
        slugByLocale: { it: slug },
        sourceLang: detectLang(description || listing.title, 'it'),
        _targetScope: { canton: HQ.canton, location: 'Castelrotto' },
      };

      allJobs.push(job);
    }
  }

  return allJobs;
}

// ─────────────────────────────────────────────────────────────
// Merge
// ─────────────────────────────────────────────────────────────

function jobMatchKey(job) {
  return `${slugify(job.title)}-${COMPANY_KEY}`;
}

function filterEmpty(obj = {}) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && String(v).trim()) out[k] = v;
  }
  return out;
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
        url: discovered.url || ex.url,
        applyUrl: discovered.applyUrl || ex.applyUrl,
        category: discovered.category || ex.category,
        sector: discovered.sector || ex.sector,
        source: 'oscam-crawler',
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

// ─────────────────────────────────────────────────────────────
// Adapter management
// ─────────────────────────────────────────────────────────────

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
  adapter.crawlerModes = ['html'];
  adapter.seedUrls = [...CAREERS_URLS];
  adapter.notes =
    'WordPress CMS — "Concorsi" listings with h3 titles and PDF download links.';
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${COMPANY_KEY} updated.`);
}

// ─────────────────────────────────────────────────────────────
// Base crawler (AI localization only)
// ─────────────────────────────────────────────────────────────

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: COMPANY_KEY,
    localizeOnlyCompanyKeys: COMPANY_KEY,
    forceLocalizeKeys: COMPANY_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: '10',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '10',
    },
  });
}

// ─────────────────────────────────────────────────────────────
// Post-processing
// ─────────────────────────────────────────────────────────────

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
      job.location = 'Castelrotto';
      fixed++;
    }
  }

  if (fixed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(
      `🔧 Post-processed ${fixed} OSCAM jobs (fixed company/location/canton).`
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Stats & validation
// ─────────────────────────────────────────────────────────────

function logStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json not found — no stats available.');
    return { total: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const targetJobs = allJobs.filter(isTargetJob);

  console.log(`\n📊 === OSCAM Job Stats ===`);
  console.log(`  🏥 Total OSCAM jobs: ${targetJobs.length}`);

  if (targetJobs.length > 0) {
    console.log(`  📋 Jobs:`);
    for (const job of targetJobs) {
      console.log(`     - ${job.title} (${job.location || 'Castelrotto'})`);
    }
  }

  const afterSnapshot = snapshotJobSlugs(targetJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'OSCAM');
  writeCrawlChangeSummaryToGH(crawlDiff, 'OSCAM');
  return { total: targetJobs.length, crawlDiff };

}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_OSCAM_STRICT',
    label: 'OSCAM',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_oscam_domain',
    failWhenNoJobs: false,
    noJobsMessage:
      'No OSCAM jobs found — the hospital may not have active concorsi.',
  });
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'OSCAM');
  let crawlDiff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };
  console.log('═══════════════════════════════════════════════');
  console.log('  OSCAM — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Career pages: ${CAREERS_URLS.join(', ')}\n`);

  console.log('🔍 Fetching OSCAM jobs...');

  // Snapshot before
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isTargetJob))

  // Phase 1: Fetch and parse jobs
  const discoveredJobs = await fetchOscamJobs();

  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No OSCAM jobs discovered.');
    console.log(
      '   The career pages may have changed structure or have no current concorsi.'
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

  // Phase 4: Run base crawler for AI localization
  console.log(
    '\n🌐 Running base crawler for AI localization of OSCAM jobs...'
  );
  await runBaseCrawler();

  // Phase 5: Post-process
  postProcessJobs();

  // Phase 6: Log stats
  const stats = logStats(beforeSnapshot);
  if (stats.total === 0) {
    console.log(
      'ℹ️ No OSCAM jobs found after crawl. No error — exiting OK.'
    );
    return;
  }

  // Phase 7: Validate locale coverage
  validateLocales();

  console.log('\n✅ OSCAM crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'OSCAM',
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
  console.error(`❌ OSCAM crawler failed: ${err?.message || err}`);
  process.exit(1);
});
