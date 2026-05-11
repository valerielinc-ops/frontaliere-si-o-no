#!/usr/bin/env node
/**
 * Dedicated USI (Università della Svizzera italiana) crawler runner.
 * Runs only USI jobs from their Drupal careers page and enforces full
 * locale coverage for SEO-critical fields.
 *
 * The USI careers portal is a server-rendered Drupal page listing all
 * open positions as HTML paragraphs, each with a link to a PDF call/bando.
 * There is NO ATS API and NO individual job detail pages.
 *
 * Available in two locales:
 *   IT: https://www.usi.ch/it/universita/collabora-con-noi/concorsi-e-offerte-di-lavoro
 *   EN: https://www.usi.ch/en/university/work-with-us/job-opportunities
 *
 * Discovery flow:
 *   1. Fetch the IT listing page (server-side rendered HTML)
 *   2. Parse each job block: <strong>org+dept</strong>, title, <a href="PDF">
 *   3. Optionally fetch the EN listing page to harvest English titles
 *   4. Build job objects with the PDF URL as canonical identifier
 *   5. Merge into data/jobs.json (add new, update existing, prune stale)
 *   6. Run the base crawler for AI localization of descriptions (4 locales)
 *   7. Post-process: fix company name, location, canton, clean descriptions
 *   8. Validate locale coverage across IT/EN/DE/FR
 *
 * Job categories on USI page:
 *   - Professori (professors, tenured positions)
 *   - Assistenti/Ricercatori (PhD students, postdocs, researchers)
 *   - Amministrativi (administrative, technical, support staff)
 *   - Apprendisti (apprenticeships)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printPublishedJobUrls, writeJobsSummary, snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { validateJobUrls } from './lib/validate-job-url.mjs';
import { translateMissingJobLocales, validateDedicatedLocaleCoverage, mergeLocaleTextMap,
  ensureMinimumDescriptionWordCount, isSlugStable,
} from './lib/dedicated-crawler-common.mjs';
import { buildPdfBackedDescription, extractPdfJobContentFromUrl } from './lib/pdf-job-content.mjs';
import { extractDrupalNodeId, extractIrsolDetailPage, MIN_IRSOL_BODY_LENGTH } from './lib/irsol-html-parser.mjs';
import { translateTextWithLocalPipeline } from './lib/job-localization-pipeline.mjs';
import { freeTranslateWithRetry } from './lib/free-translate.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { detectLanguage } from './lib/detect-language.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');
const USI_KEY = 'usi-universita-della-svizzera-italiana';
const HQ = getCompanyDefaults('usi');
const LOCALES = ['it', 'en', 'de', 'fr'];

/**
 * USI listing page URLs for both available locales.
 */
const LISTING_URL_IT = 'https://www.usi.ch/it/universita/collabora-con-noi/concorsi-e-offerte-di-lavoro';
const LISTING_URL_EN = 'https://www.usi.ch/en/university/work-with-us/job-opportunities';

const USI_COMPANY_NAME = 'USI – Università della Svizzera italiana';
const USI_COMPANY_HOST = 'usi.ch';

/**
 * USI campuses and their cities.
 * USI has campuses in Lugano (main) and Mendrisio (Architecture).
 */
const USI_CAMPUSES = {
  'Academy of Architecture': { city: 'Mendrisio', campus: 'Campus Mendrisio' },
  'Accademia di architettura': { city: 'Mendrisio', campus: 'Campus Mendrisio' },
  'Biblioteca universitaria Lugano': { city: 'Lugano', campus: 'Campus Lugano' },
  'Istituto ricerche solari': { city: 'Locarno', campus: 'IRSOL Locarno' },
  IRSOL: { city: 'Locarno', campus: 'IRSOL Locarno' },
};

/**
 * Default location when no specific campus is detected.
 * USI main campus is in Lugano.
 */
const DEFAULT_CITY = 'Lugano';
const DEFAULT_CANTON = HQ.canton;

/**
 * Job category detection patterns.
 * Used to classify USI positions into categories.
 */
const CATEGORY_PATTERNS = [
  { re: /\b(?:Professor|Professore|Professoressa|Full Professor|Associate Professor|Assistant Professor)\b/i, category: 'professor' },
  { re: /\b(?:PostDoc|Post-Doc|Post-Doctoral|Postdoctoral|Ricercatore|Researcher)\b/i, category: 'researcher' },
  { re: /\b(?:PhD|Dottoran|Doctoral)\b/i, category: 'phd' },
  { re: /\b(?:Apprendista|Apprentice|Apprenticeship|AFC)\b/i, category: 'apprentice' },
  { re: /\b(?:Internship|Stagiaire|Stage|Stagista|Tirocinio)\b/i, category: 'internship' },
  { re: /\b(?:Coach|Coordinat|Bibliotecari|Librarian|Sviluppat|Developer|Amministrat|Network Engineer|Tecnico|Collaborat)\b/i, category: 'staff' },
];

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

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

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function detectLang(text = '') {
  return detectLanguage(text, 'it');
}

/**
 * Match a job object as belonging to the USI crawl.
 */
function isUsiJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === USI_KEY ||
    key.includes('usi-universita') ||
    key.includes('universita-della-svizzera') ||
    (host.includes('usi.ch') && !host.includes('music')) ||
    (company.includes('usi') && (company.includes('universit') || company.includes('svizzera')))
  );
}

/**
 * Check whether a URL belongs to one of USI's trusted domains.
 */
function isTrustedUsiDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.endsWith('usi.ch');
  } catch {
    return false;
  }
}

function deriveLocalizedSlug(job, locale) {
  const explicit = String(job?.slugByLocale?.[locale] || '').trim();
  if (explicit) return explicit;
  return String(job?.slug || '').trim();
}

/**
 * Generate a stable slug from a title string.
 */
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


async function translateUsiTitle(text = '', sourceLang = 'it', targetLang = 'en', job = {}) {
  const source = String(text || '').trim();
  if (!source || sourceLang === targetLang) return source;

  const local = await translateTextWithLocalPipeline({
    text: source,
    sourceLang,
    targetLang,
    kind: 'title',
    context: {
      title: source,
      company: job.company || USI_COMPANY_NAME,
      location: job.location || DEFAULT_CITY,
    },
    minChars: 2,
  });
  if (local && normalize(local) !== normalize(source)) return String(local).trim();

  const fallback = await freeTranslateWithRetry({
    text: source,
    sourceLang,
    targetLang,
    maxRetries: 0,
  });
  if (fallback && normalize(fallback) !== normalize(source)) return String(fallback).trim();
  return source;
}

function rescueUsiTitleTranslation(text = '', targetLang = 'it') {
  const source = String(text || '').trim();
  if (!source) return '';

  const rules = [
    {
      match: /^startup coach life science$/i,
      values: {
        it: 'Coach startup Life Science',
        de: 'Startup-Coach im Bereich Life Sciences',
        fr: 'Coach startup Life Science',
      },
    },
    {
      match: /^bibliotecaria\/o specializzata\/o in risorse elettroniche/i,
      values: {
        en: 'Specialized librarian in electronic resources',
        de: 'Spezialisierte/r Bibliothekar/in für elektronische Ressourcen',
        fr: 'Bibliothécaire spécialisé/e en ressources électroniques',
      },
    },
    {
      match: /^apprendista operatore\/trice di edifici e infrastrutture/i,
      values: {
        en: 'Apprentice building and infrastructure operator, concierge services - AFC',
        de: 'Lernende/r Gebäudetechnik- und Infrastrukturbetreiber/in, Portierdienste - EFZ',
        fr: 'Apprenti/e opérateur/trice de bâtiments et d’infrastructures, services de conciergerie - AFC',
      },
    },
    {
      match: /^posizione postdoc nel campo/i,
      values: {
        fr: 'Poste de PostDoc dans le domaine de la durabilité, de l’architecture et de la technologie',
      },
    },
  ];

  for (const rule of rules) {
    if (rule.match.test(source)) {
      return String(rule.values?.[targetLang] || '').trim();
    }
  }
  return '';
}

/**
 * Extract the PDF filename (without extension) as a stable job ID.
 * e.g. "elab-sviluppatore-junior-2026.pdf" → "elab-sviluppatore-junior-2026"
 */
function pdfFilenameId(pdfUrl = '') {
  try {
    const pathname = new URL(pdfUrl).pathname;
    const filename = pathname.split('/').pop() || '';
    return filename.replace(/\.pdf$/i, '');
  } catch {
    return '';
  }
}

// ──────────────────────────────────────────────────────────────
// HTML fetching
// ──────────────────────────────────────────────────────────────

/**
 * Fetch a single URL with timeout and User-Agent header.
 * Returns the response body as text, or null on failure.
 */
async function fetchPage(url, timeoutMs = 15000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'it-CH,it;q=0.9,en;q=0.8',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
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

// ──────────────────────────────────────────────────────────────
// HTML parsing — extract job blocks from the Drupal listing page
// ──────────────────────────────────────────────────────────────

/**
 * Extract the main content section containing job listings.
 * USI uses Drupal with a <div class="text_container"> wrapper.
 */
function extractContentSection(html = '') {
  // Look for the text_container that holds the job listings.
  // The section starts after "I concorsi e le offerte di lavoro" heading.
  const marker = /concorsi e (?:le )?offerte di lavoro|Job opportunities/i;
  const textContainerStart = html.search(/<div[^>]*class="[^"]*\btext_container\b[^"]*"[^>]*>/i);
  if (textContainerStart === -1) return html;

  // Find the text_container section that contains the marker AND has job-link
  // signals. The marker string also appears in the page header/breadcrumbs
  // (section 0, before the text_container div), so iterate in reverse order
  // to prefer the section AFTER the text_container opening tag.
  const sections = html.split(/<div[^>]*class="[^"]*\btext_container\b[^"]*"[^>]*>/i);
  for (let i = sections.length - 1; i >= 0; i--) {
    if (marker.test(sections[i])) {
      const endIdx = sections[i].search(/<\/section>/i);
      const candidate = endIdx !== -1 ? sections[i].slice(0, endIdx) : sections[i];
      const hasJobSignals = /(content\.usi\.ch\/sites\/default\/files\/storage\/attachments\/[^"']+\.pdf|Call\s*\(pdf|Bando\s*\(pdf|jobopportunities\.usi\.ch)/i.test(candidate);
      if (hasJobSignals) return candidate;
    }
  }
  // Fallback to full HTML if section heuristics fail.
  return html;
}

/**
 * Parse individual job blocks from the content HTML.
 *
 * Each job block follows this pattern:
 *   <p><strong>Organization Name<br/>Department</strong><br/>
 *   Job Title<br/>
 *   <a href="PDF_URL">Call/Bando (pdf, N Kb)</a></p>
 *
 * Some blocks have external links instead of PDF attachments (e.g., IRSOL).
 *
 * Returns an array of raw parsed job objects:
 *   { organization, department, title, pdfUrl, linkText, rawHtml }
 */
function parseJobBlocks(html = '', locale = 'it') {
  const content = extractContentSection(html);
  const jobs = [];

  // Extract individual <p>...</p> blocks first, then parse each one.
  // Using [\s\S]*? across </p> boundaries causes cross-block matching when
  // a bare <p><strong>HEADER</strong></p> (no <br/>) precedes a job block.
  const paragraphs = content.split(/<\/p>/i);

  for (const para of paragraphs) {
    // Each job block must contain <strong>...</strong><br/> and an <a href>
    const strongMatch = para.match(/<p[^>]*>\s*<strong>([\s\S]*?)<\/strong>\s*<br\s*\/?>\s*([\s\S]*)/i);
    if (!strongMatch) continue;

    const strongContent = strongMatch[1].trim();
    const afterStrong = strongMatch[2].trim();

    // Skip blocks that are clearly not job listings
    if (!strongContent || strongContent.length < 10) continue;
    if (/concorsi e (?:le )?offerte|Job opportunities are sorted/i.test(strongContent)) continue;
    if (/Call for candidates to apply to the ERC/i.test(strongContent)) continue;

    // Parse organization and department from <strong> block
    // Format: "Università della Svizzera italiana<br/>Faculty Name<br/>Institute Name"
    const orgParts = strongContent
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    const organization = orgParts[0] || '';
    const department = orgParts.slice(1).join(' – ') || '';

    // Parse title and link from the content after </strong>
    // The title is the text before the <a> tag
    const linkMatch = afterStrong.match(/<a\s+[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/i);
    const linkUrl = linkMatch ? linkMatch[1].trim() : '';
    const linkText = linkMatch ? linkMatch[2].replace(/<[^>]+>/g, '').trim() : '';

    // Title: everything before the <a> tag, cleaned of HTML
    let title = afterStrong;
    if (linkMatch) {
      title = afterStrong.slice(0, afterStrong.indexOf(linkMatch[0]));
    }
    title = title
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/?em>/gi, '')
      .replace(/<[^>]+>/g, '')
      .trim();

    // Skip if no meaningful title
    if (!title || title.length < 5) continue;

    // Determine if the link is a PDF or external URL
    const isPdf = /\.pdf(?:$|[?#])/i.test(linkUrl) || /content\.usi\.ch/i.test(linkUrl);
    const pdfUrl = isPdf ? linkUrl : '';
    const externalUrl = !isPdf && linkUrl ? linkUrl : '';

    jobs.push({
      organization,
      department,
      title: normalizeSpace(title),
      pdfUrl,
      externalUrl,
      linkText,
      locale,
    });
  }

  return jobs;
}

/**
 * Detect the job category based on title and department.
 */
function detectCategory(title = '', department = '') {
  const text = `${title} ${department}`;
  for (const { re, category } of CATEGORY_PATTERNS) {
    if (re.test(text)) return category;
  }
  return 'staff';
}

/**
 * Detect the city/campus from the department/organization name.
 */
function detectCity(department = '', organization = '') {
  const text = `${organization} ${department}`;
  for (const [keyword, info] of Object.entries(USI_CAMPUSES)) {
    if (text.includes(keyword)) return info.city;
  }
  // Mendrisio detection from text
  if (/mendrisio|architettura|architecture/i.test(text)) return 'Mendrisio';
  if (/locarno|irsol|solari/i.test(text)) return 'Locarno';
  return DEFAULT_CITY;
}

/**
 * Build a description from the parsed job block data.
 * Since USI jobs don't have individual detail pages (only PDFs),
 * we construct a meaningful description from the available metadata.
 */
function buildDescription(job, locale = 'it', pdfText = '') {
  const city = detectCity(job.department, job.organization);
  const category = detectCategory(job.title, job.department);
  const footerLines = job.pdfUrl
    ? [locale === 'en' ? 'Official call available as PDF.' : 'Bando ufficiale disponibile in PDF.']
    : [];

  // Build a richer fallback when PDF text is empty/thin
  const hasPdfText = pdfText && pdfText.split(/\s+/).length >= 30;

  if (locale === 'en') {
    const fallbackText = !hasPdfText ? [
      `USI – Università della Svizzera italiana is the only Italian-speaking university in Switzerland, with campuses in Lugano and Mendrisio.`,
      `The university offers a stimulating academic and research environment with a strong international orientation, hosting students and researchers from over 100 countries.`,
      category === 'professor' || category === 'researcher' || category === 'phd' ?
        `The position involves academic research and teaching activities within the department.` :
        `The position contributes to the university's operational excellence and academic mission.`,
      `USI offers competitive employment conditions, a dynamic multicultural environment, and professional development opportunities.`,
    ].join(' ') : '';

    return buildPdfBackedDescription({
      introLines: [
        `Open position at ${job.organization || USI_COMPANY_NAME}.`,
        ...(job.department ? [`Department/Institute: ${job.department}.`] : []),
        `Role: ${job.title}.`,
        `Location: ${city}, Switzerland (Canton Ticino).`,
      ],
      pdfText,
      fallbackText,
      footerLines,
    });
  }

  const fallbackText = !hasPdfText ? [
    `L'USI – Università della Svizzera italiana è l'unica università di lingua italiana in Svizzera, con campus a Lugano e Mendrisio.`,
    `L'ateneo offre un ambiente accademico e di ricerca stimolante con un forte orientamento internazionale, ospitando studenti e ricercatori da oltre 100 Paesi.`,
    category === 'professor' || category === 'researcher' || category === 'phd' ?
      `La posizione prevede attività di ricerca accademica e insegnamento all'interno del dipartimento.` :
      `La posizione contribuisce all'eccellenza operativa e alla missione accademica dell'università.`,
    `L'USI offre condizioni di impiego competitive, un ambiente multiculturale dinamico e opportunità di sviluppo professionale.`,
  ].join(' ') : '';

  return buildPdfBackedDescription({
    introLines: [
      `Posizione aperta presso ${job.organization || USI_COMPANY_NAME}.`,
      ...(job.department ? [`Dipartimento/Istituto: ${job.department}.`] : []),
      `Ruolo: ${job.title}.`,
      `Sede: ${city}, Svizzera (Canton Ticino).`,
    ],
    pdfText,
    fallbackText,
    footerLines,
  });
}

// ──────────────────────────────────────────────────────────────
// Fetch and merge IT + EN job listings
// ──────────────────────────────────────────────────────────────

/**
 * Match English jobs to Italian jobs based on PDF URL similarity.
 * Some PDFs have "-en" suffixed versions for English listings.
 * Returns a Map of IT PDF filename → EN job data.
 */
function matchEnglishJobs(itJobs, enJobs) {
  const enByPdfBase = new Map();

  for (const enJob of enJobs) {
    const pdfId = pdfFilenameId(enJob.pdfUrl || enJob.externalUrl || '');
    if (pdfId) enByPdfBase.set(pdfId, enJob);
  }

  const matches = new Map();

  for (const itJob of itJobs) {
    const itPdfId = pdfFilenameId(itJob.pdfUrl || itJob.externalUrl || '');
    if (!itPdfId) continue;

    // Exact match
    if (enByPdfBase.has(itPdfId)) {
      matches.set(itPdfId, enByPdfBase.get(itPdfId));
      continue;
    }

    // Try matching with/without "-en" suffix
    const enVariant = `${itPdfId}-en`;
    if (enByPdfBase.has(enVariant)) {
      matches.set(itPdfId, enByPdfBase.get(enVariant));
      continue;
    }

    // Try removing "-en" from EN PDFs
    for (const [enPdfId, enJob] of enByPdfBase) {
      if (enPdfId.replace(/-en$/, '') === itPdfId || enPdfId.replace(/-en-/, '-') === itPdfId) {
        matches.set(itPdfId, enJob);
        break;
      }
    }

    // Strategy 4: match external HTML pages (e.g. IRSOL Drupal) by trailing
    // numeric node ID. IT ".../del-41206" and EN ".../scientist-41206" share
    // the same node ID, making it a stable bilingual match key.
    if (!matches.has(itPdfId)) {
      const itNodeId = extractDrupalNodeId(itJob.externalUrl || '');
      if (itNodeId) {
        for (const [, enJob] of enByPdfBase) {
          const enNodeId = extractDrupalNodeId(enJob.externalUrl || '');
          if (enNodeId && enNodeId === itNodeId) {
            matches.set(itPdfId, enJob);
            break;
          }
        }
      }
    }
  }

  return matches;
}

/**
 * Fetch both IT and EN listing pages and extract all unique jobs.
 * Returns an array of merged job objects with both locale titles.
 */
async function fetchUsiJobs() {
  console.log('🔍 Fetching USI job listings from Drupal page...');

  // Fetch Italian page (primary source)
  console.log(`  📄 Fetching IT page: ${LISTING_URL_IT}`);
  const htmlIt = await fetchPage(LISTING_URL_IT, 20000);
  if (!htmlIt) {
    console.error('❌ Failed to fetch USI Italian listing page.');
    return [];
  }

  const itJobs = parseJobBlocks(htmlIt, 'it');
  console.log(`  ✅ IT page: ${itJobs.length} job blocks parsed`);

  // Fetch English page for cross-referencing titles
  console.log(`  📄 Fetching EN page: ${LISTING_URL_EN}`);
  const htmlEn = await fetchPage(LISTING_URL_EN, 20000);
  let enJobs = [];
  if (htmlEn) {
    enJobs = parseJobBlocks(htmlEn, 'en');
    console.log(`  ✅ EN page: ${enJobs.length} job blocks parsed`);
  } else {
    console.warn('  ⚠️ Failed to fetch EN page — will use AI localization for English titles.');
  }

  // Match EN jobs to IT jobs
  const enMatches = matchEnglishJobs(itJobs, enJobs);
  console.log(`  🔗 IT↔EN matches: ${enMatches.size}/${itJobs.length}`);

  // Build unified job objects
  const jobs = [];
  const seenPdfIds = new Set();

  for (const itJob of itJobs) {
    const jobUrl = itJob.pdfUrl || itJob.externalUrl || LISTING_URL_IT;
    const pdfId = pdfFilenameId(jobUrl);

    // Deduplicate by PDF ID
    if (pdfId && seenPdfIds.has(pdfId)) continue;
    if (pdfId) seenPdfIds.add(pdfId);

    const enJob = enMatches.get(pdfId);
    const city = detectCity(itJob.department, itJob.organization);
    const category = detectCategory(itJob.title, itJob.department);
    const pdfContent = itJob.pdfUrl
      ? await extractPdfJobContentFromUrl(itJob.pdfUrl)
      : { text: '', error: '' };

    // For external HTML pages (e.g. IRSOL Drupal detail pages): fetch the
    // detail page to obtain (a) the canonical title from <h1> — more stable
    // than the listing-page title which can drift between runs — and (b) the
    // full job body instead of a synthetic 4-line summary.
    let externalContent = { title: '', body: '' };
    if (itJob.externalUrl && !itJob.pdfUrl) {
      const detailHtml = await fetchPage(itJob.externalUrl, 15000);
      if (detailHtml) {
        externalContent = extractIrsolDetailPage(detailHtml);
        if (externalContent.title) {
          console.log(`  🏷️ IRSOL detail title: "${externalContent.title}"`);
        }
        if (externalContent.body.length < MIN_IRSOL_BODY_LENGTH) {
          console.warn(`  ⚠️ IRSOL body too short (${externalContent.body.length} chars) for ${itJob.externalUrl} — using synthetic description.`);
          externalContent.body = '';
        }
      }
    }

    // Prefer detail-page title (stable h1) over listing-page title.
    const canonicalItTitle = externalContent.title || itJob.title;
    // Body text: PDF content takes priority, then HTML detail page body.
    const bodyText = pdfContent.text || externalContent.body || '';

    const slug = slugify(canonicalItTitle, 'usi');
    const descIt = buildDescription({ ...itJob, title: canonicalItTitle }, 'it', bodyText);
    const descEn = buildDescription(enJob ? { ...enJob } : { ...itJob, title: canonicalItTitle }, 'en', bodyText);

    const job = {
      url: jobUrl,
      applyUrl: itJob.pdfUrl || itJob.externalUrl || LISTING_URL_IT,
      title: canonicalItTitle,
      company: USI_COMPANY_NAME,
      companyKey: USI_KEY,
      location: city,
      canton: DEFAULT_CANTON,
      country: 'CH',
      description: descIt,
      descriptionByLocale: {
        it: descIt,
        en: descEn,
      },
      titleByLocale: {
        it: canonicalItTitle,
        en: enJob ? enJob.title : '',
      },
      slug,
      slugByLocale: {
        it: slug,
        en: enJob ? slugify(enJob.title, 'usi') : '',
      },
      department: itJob.department,
      category,
      datePosted: new Date().toISOString().split('T')[0],
      source: 'usi-drupal-crawler',
      employmentType: category === 'apprentice' ? 'APPRENTICESHIP' : category === 'internship' ? 'INTERN' : 'FULL_TIME',
      experienceLevel: category === 'professor' ? 'SENIOR' : category === 'phd' ? 'ENTRY' : category === 'researcher' ? 'MID' : '',
      sector: 'Istruzione e ricerca',
      _targetScope: { canton: HQ.canton, location: city },
    };

    if (itJob.pdfUrl && pdfContent.error) {
      console.warn(`⚠️ USI PDF extraction error for "${itJob.title}": ${pdfContent.error}`);
    }
    if (itJob.pdfUrl && pdfContent.warning) {
      console.warn(`⚠️ USI PDF thin content for "${itJob.title}": ${pdfContent.warning}`);
    }
    jobs.push(job);
  }

  // Add EN-only jobs (present in EN page but not in IT)
  const itPdfIds = new Set(itJobs.map((j) => pdfFilenameId(j.pdfUrl || j.externalUrl || '')).filter(Boolean));
  for (const enJob of enJobs) {
    const enPdfId = pdfFilenameId(enJob.pdfUrl || enJob.externalUrl || '');
    if (!enPdfId) continue;
    // Check if already covered (exact or with -en suffix)
    if (itPdfIds.has(enPdfId) || itPdfIds.has(enPdfId.replace(/-en$/, '')) || itPdfIds.has(enPdfId.replace(/-en-/, '-'))) continue;
    if (seenPdfIds.has(enPdfId)) continue;
    seenPdfIds.add(enPdfId);

    const jobUrl = enJob.pdfUrl || enJob.externalUrl || LISTING_URL_EN;
    const city = detectCity(enJob.department, enJob.organization);
    const category = detectCategory(enJob.title, enJob.department);
    const slug = slugify(enJob.title, 'usi');
    const pdfContent = enJob.pdfUrl
      ? await extractPdfJobContentFromUrl(enJob.pdfUrl)
      : { text: '', error: '' };

    const descEn = buildDescription(enJob, 'en', pdfContent.text || '');
    const descIt = buildDescription(enJob, 'it', pdfContent.text || '');

    const job = {
      url: jobUrl,
      applyUrl: enJob.pdfUrl || enJob.externalUrl || LISTING_URL_EN,
      title: enJob.title,
      company: USI_COMPANY_NAME,
      companyKey: USI_KEY,
      location: city,
      canton: DEFAULT_CANTON,
      country: 'CH',
      description: descIt,
      descriptionByLocale: {
        it: descIt,
        en: descEn,
      },
      titleByLocale: {
        en: enJob.title,
      },
      slug,
      slugByLocale: {
        en: slug,
      },
      department: enJob.department,
      category,
      datePosted: new Date().toISOString().split('T')[0],
      source: 'usi-drupal-crawler',
      employmentType: category === 'apprentice' ? 'APPRENTICESHIP' : category === 'internship' ? 'INTERN' : 'FULL_TIME',
      experienceLevel: category === 'professor' ? 'SENIOR' : category === 'phd' ? 'ENTRY' : category === 'researcher' ? 'MID' : '',
      sector: 'Istruzione e ricerca',
      _targetScope: { canton: HQ.canton, location: city },
    };

    if (enJob.pdfUrl && pdfContent.error) {
      console.warn(`⚠️ USI PDF extraction error for "${enJob.title}": ${pdfContent.error}`);
    }
    if (enJob.pdfUrl && pdfContent.warning) {
      console.warn(`⚠️ USI PDF thin content for "${enJob.title}": ${pdfContent.warning}`);
    }
    jobs.push(job);
  }

  console.log(`\n📋 Total unique USI jobs discovered: ${jobs.length}`);
  return jobs;
}

// ──────────────────────────────────────────────────────────────
// Merge into data/jobs.json
// ──────────────────────────────────────────────────────────────

/**
 * Canonical URL for deduplication.
 * Normalizes PDF URLs and website URLs.
 */
function canonicalizeUrl(url = '') {
  try {
    const u = new URL(url);
    return u.href.replace(/\/$/, '').toLowerCase();
  } catch {
    return normalize(url);
  }
}

/**
 * Merge discovered USI jobs into the existing data/jobs.json.
 * - Adds new jobs not already present
 * - Updates existing USI jobs (refresh metadata)
 * - Removes stale USI jobs no longer on the listing page
 */
async function mergeUsiJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(USI_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];

  // Separate USI jobs from other companies
  const nonUsiJobs = allJobs.filter((j) => !isUsiJob(j));
  const existingUsiJobs = allJobs.filter(isUsiJob);

  // Build lookup for existing USI jobs by canonical URL
  const existingByUrl = new Map();
  for (const job of existingUsiJobs) {
    existingByUrl.set(canonicalizeUrl(job.url), job);
  }

  // Build lookup for discovered jobs
  const discoveredByUrl = new Map();
  for (const job of discoveredJobs) {
    discoveredByUrl.set(canonicalizeUrl(job.url), job);
  }

  let added = 0;
  let updated = 0;
  let removed = 0;
  const merged = [];

  // Add/update discovered jobs
  for (const discovered of discoveredJobs) {
    const key = canonicalizeUrl(discovered.url);
    const existing = existingByUrl.get(key);

    if (existing) {
      // Update existing: keep locale data, refresh core fields
      const updatedJob = {
        ...existing,
        title: discovered.title || existing.title,
        company: USI_COMPANY_NAME,
        companyKey: USI_KEY,
        location: discovered.location || existing.location,
        canton: DEFAULT_CANTON,
        country: 'CH',
        applyUrl: discovered.applyUrl || existing.applyUrl,
        department: discovered.department || existing.department,
        category: discovered.category || existing.category,
        sector: discovered.sector || existing.sector,
        source: 'usi-drupal-crawler',
        // Merge locale data (keep AI-localized content, update source locales)
        titleByLocale: mergeLocaleTextMap(existing.titleByLocale, discovered.titleByLocale, 3),
        descriptionByLocale: mergeLocaleTextMap(existing.descriptionByLocale, discovered.descriptionByLocale, 30),
        slugByLocale: mergeLocaleTextMap(existing.slugByLocale, discovered.slugByLocale, 3),
      };

      // Update base description only if it's richer
      if (discovered.description && discovered.description.length > (existing.description || '').length) {
        updatedJob.description = discovered.description;
      }

      merged.push(updatedJob);
      updated++;
    } else {
      // New job
      merged.push(discovered);
      added++;
    }
  }

  // Count removed (existing USI jobs not in discovery)
  for (const [url] of existingByUrl) {
    if (!discoveredByUrl.has(url)) {
      removed++;
    }
  }

  // Validate URLs of newly added jobs before writing
  if (added > 0) {
    const newJobs = merged.filter((j) => !existingByUrl.has(canonicalizeUrl(j.url)));
    if (newJobs.length > 0) {
      console.log(`\n🔗 Validating URLs for ${newJobs.length} new USI jobs…`);
      const urlChecks = await validateJobUrls(
        newJobs.map((j) => ({ id: j.id || j.url, url: j.applyUrl || j.url })),
        { concurrency: 5, timeoutMs: 7000 }
      );
      const deadIds = new Set();
      for (const vr of urlChecks) {
        if (!vr.valid) {
          console.log(`   ❌ ${vr.id}: ${vr.reason} (${vr.status || '?'})`);
          deadIds.add(vr.id);
        }
      }
      if (deadIds.size > 0) {
        const before = merged.length;
        const filteredMerged = merged.filter((j) => {
          const jId = j.id || j.url;
          return !deadIds.has(jId);
        });
        console.log(`🚫 Removed ${before - filteredMerged.length} USI jobs with dead URLs`);
        added -= (before - filteredMerged.length);
        // Rebuild merged array
        merged.length = 0;
        merged.push(...filteredMerged);
      }
    }
  }

  // Combine non-USI jobs with merged USI jobs
  const final = [...nonUsiJobs, ...merged];

  // Write to data/jobs.json and public/data/jobs.json
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

/**
 * Filter out empty string values from a locale map.
 */
function filterEmpty(obj = {}) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && String(v).trim()) out[k] = v;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────
// Adapter seed URL management
// ──────────────────────────────────────────────────────────────

/**
 * Update the USI adapter JSON with the listing page URL.
 * For USI, seed URLs are the listing pages (not detail pages),
 * so the base crawler uses them primarily for localization.
 */
function updateAdapterConfig() {
  const adapterPath = path.join(ADAPTERS_DIR, `${USI_KEY}.json`);

  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  adapter.companyKey = USI_KEY;
  adapter.companyName = USI_COMPANY_NAME;
  adapter.companyHost = USI_COMPANY_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(adapter.priority || 0, 10);
  adapter.crawlerModes = ['html', 'pdf'];
  adapter.seedUrls = [LISTING_URL_IT, LISTING_URL_EN];
  adapter.notes = 'Drupal CMS at usi.ch — job listings extracted directly from HTML listing page, with PDF text extraction for calls/bandi.';
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${USI_KEY} updated.`);
}

function localizeUsiJobs() {
  return translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob: isUsiJob,
    maxJobs: 200,
  });
}

// ──────────────────────────────────────────────────────────────
// Post-processing: final cleanup after base crawler localization
// ──────────────────────────────────────────────────────────────

/**
 * Post-process all USI jobs in data/jobs.json to ensure consistent
 * company name, location, and canton after the base crawler pass.
 */
async function postProcessUsiJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of jobs) {
    if (!isUsiJob(job)) continue;

    if (!job.titleByLocale || typeof job.titleByLocale !== 'object') {
      job.titleByLocale = {};
      fixed++;
    }
    if (!job.slugByLocale || typeof job.slugByLocale !== 'object') {
      job.slugByLocale = {};
      fixed++;
    }

    // Ensure company name is consistent
    if (job.company !== USI_COMPANY_NAME) {
      job.company = USI_COMPANY_NAME;
      fixed++;
    }

    // Ensure companyKey
    if (job.companyKey !== USI_KEY) {
      job.companyKey = USI_KEY;
      fixed++;
    }

    // All USI positions are in Ticino
    job.canton = DEFAULT_CANTON;
    job.country = 'CH';

    // Ensure location is set
    if (!job.location) {
      job.location = DEFAULT_CITY;
      fixed++;
    }

    // Regenerate slug if it contains boilerplate or is too long
    if (job.slug && job.slug.length > 100) {
      const city = job.location || DEFAULT_CITY;
      job.slug = slugify(job.title, `usi-${city.toLowerCase()}`);
      fixed++;
    }

    const sourceLang = detectLang(`${job.title || ''} ${job.description || ''}`);
    const sourceTitle = String(job.titleByLocale?.[sourceLang] || job.title || '').trim();
    const citySuffix = `usi-${String(job.location || DEFAULT_CITY).toLowerCase()}`;

    for (const locale of LOCALES) {
      const currentTitle = String(job.titleByLocale?.[locale] || '').trim();
      if (locale !== sourceLang && sourceTitle) {
        const needsTitleTranslation = !currentTitle || normalize(currentTitle) === normalize(sourceTitle);
        if (needsTitleTranslation) {
          let translatedTitle = await translateUsiTitle(sourceTitle, sourceLang, locale, job);
          if (!translatedTitle || normalize(translatedTitle) === normalize(sourceTitle)) {
            translatedTitle = rescueUsiTitleTranslation(sourceTitle, locale) || translatedTitle;
          }
          if (translatedTitle && normalize(translatedTitle) !== normalize(currentTitle)) {
            job.titleByLocale[locale] = translatedTitle;
            fixed++;
          }
        }
      } else if (locale === sourceLang && sourceTitle && !currentTitle) {
        job.titleByLocale[locale] = sourceTitle;
        fixed++;
      }

      const localizedTitle = String(job.titleByLocale?.[locale] || '').trim() || sourceTitle;
      if (localizedTitle) {
        const newSlug = slugify(localizedTitle, citySuffix);
        const existingSlug = String(job.slugByLocale?.[locale] || '').trim();
        // Pass per-job location hint so isSlugStable can never collapse two
        // distinct city openings into the same slug.
        const _slugLocationHint = String(job.addressLocality || job.location || '');
        if (newSlug && !isSlugStable(existingSlug, newSlug, {
          existingLocation: _slugLocationHint,
          newLocation: _slugLocationHint,
        })) {
          job.slugByLocale[locale] = newSlug;
          fixed++;
        }
      }
    }

    if (/^Startup coach Life Science$/i.test(sourceTitle)) {
      job.titleByLocale.de = 'Startup-Coach Life Science';
      job.slugByLocale.de = slugify(job.titleByLocale.de, citySuffix);
      fixed++;
    }
    if (/^Bibliotecaria\/o specializzata\/o in risorse elettroniche/i.test(sourceTitle)) {
      job.titleByLocale.de = 'Spezialisierte/r Bibliothekar/in für elektronische Ressourcen';
      job.slugByLocale.de = slugify(job.titleByLocale.de, citySuffix);
      fixed++;
    }
    if (/^Apprendista Operatore\/trice di edifici e infrastrutture/i.test(sourceTitle)) {
      job.titleByLocale.en = 'Apprentice building and infrastructure operator, concierge services - AFC';
      job.slugByLocale.en = slugify(job.titleByLocale.en, citySuffix);
      fixed++;
    }
    if (/^Posizione PostDoc nel campo/i.test(sourceTitle)) {
      job.titleByLocale.fr = 'Poste de PostDoc dans le domaine de la durabilité, de l’architecture et de la technologie';
      job.slugByLocale.fr = slugify(job.titleByLocale.fr, citySuffix);
      fixed++;
    }

    const canonicalItSlug = String(job.slugByLocale?.it || '').trim();
    if (canonicalItSlug && job.slug !== canonicalItSlug) {
      job.slug = canonicalItSlug;
      fixed++;
    }

    const pdfUrl = /\.pdf(?:$|[?#])/i.test(String(job.url || '')) ? job.url : '';
    if (pdfUrl) {
      const pdfContent = await extractPdfJobContentFromUrl(pdfUrl);
      if (pdfContent.error) {
        console.warn(`⚠️ USI post-process PDF error for "${job.title}": ${pdfContent.error}`);
      }
      if (pdfContent.warning) {
        console.warn(`⚠️ USI post-process PDF thin content for "${job.title}": ${pdfContent.warning}`);
      }
      const itDescription = buildDescription({
        organization: job.company,
        department: job.department,
        title: job.titleByLocale?.it || job.title,
        pdfUrl,
      }, 'it', pdfContent.text || '');
      const enDescription = buildDescription({
        organization: job.company,
        department: job.department,
        title: job.titleByLocale?.en || job.title,
        pdfUrl,
      }, 'en', pdfContent.text || '');

      if (itDescription && itDescription !== job.description) {
        job.description = itDescription;
        fixed++;
      }
      job.descriptionByLocale = {
        ...(job.descriptionByLocale || {}),
        it: String(job.descriptionByLocale?.it || '').trim() || itDescription || job.description || '',
        en: String(job.descriptionByLocale?.en || '').trim() || enDescription || '',
      };
      const descriptionFallback =
        String(job.descriptionByLocale?.it || '').trim() ||
        String(job.descriptionByLocale?.en || '').trim() ||
        itDescription ||
        enDescription ||
        String(job.description || '').trim();
      for (const locale of LOCALES) {
        if (!String(job.descriptionByLocale?.[locale] || '').trim() && descriptionFallback) {
          job.descriptionByLocale[locale] = descriptionFallback;
        }
      }
      if (String(job.descriptionByLocale?.it || '').trim()) {
        job.description = job.descriptionByLocale.it;
      }
      if (String(job.titleByLocale?.it || '').trim()) {
        job.title = job.titleByLocale.it;
      }
    }

    if (job.slug === 'startup-coach-life-science-usi-lugano') {
      const forcedDeTitle = 'Startup-Coach im Bereich Life Sciences';
      if (job.titleByLocale.de !== forcedDeTitle) {
        job.titleByLocale.de = forcedDeTitle;
        job.slugByLocale.de = slugify(forcedDeTitle, citySuffix);
        fixed++;
      }
    }
    if (job.slug === 'posizione-postdoc-nel-campo-del-supporto-dell-architettura-e-della-tecnologia-usi-mendrisi') {
      const forcedFrTitle = 'Poste de PostDoc dans le domaine de la durabilité, de l’architecture et de la technologie';
      if (job.titleByLocale.fr !== forcedFrTitle) {
        job.titleByLocale.fr = forcedFrTitle;
        job.slugByLocale.fr = slugify(forcedFrTitle, citySuffix);
        fixed++;
      }
    }
  }

  if (fixed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(`🔧 Post-processed ${fixed} USI jobs (fixed company/location/canton).`);
  }
}

function applyUsiLocaleOverrides() {
  if (!fs.existsSync(DATA_JOBS)) return 0;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of jobs) {
    if (!isUsiJob(job)) continue;
    if (!job.titleByLocale || typeof job.titleByLocale !== 'object') job.titleByLocale = {};
    if (!job.slugByLocale || typeof job.slugByLocale !== 'object') job.slugByLocale = {};
    const citySuffix = `usi-${String(job.location || DEFAULT_CITY).toLowerCase()}`;

    if (job.slug === 'startup-coach-life-science-usi-lugano') {
      const title = 'Startup-Coach im Bereich Life Sciences';
      if (job.titleByLocale.de !== title) {
        job.titleByLocale.de = title;
        job.slugByLocale.de = slugify(title, citySuffix);
        fixed++;
      }
    }
    if (job.slug === 'coach-per-startup-nel-settore-delle-scienze-della-vita-usi-lugano') {
      const title = 'Startup-Coach im Bereich Life Sciences';
      if (job.titleByLocale.de !== title) {
        job.titleByLocale.de = title;
        job.slugByLocale.de = slugify(title, citySuffix);
        fixed++;
      }
    }
    if (job.slug === 'posizione-postdoc-nel-campo-del-supporto-dell-architettura-e-della-tecnologia-usi-mendrisi') {
      const title = 'Poste de PostDoc dans le domaine de la durabilité, de l’architecture et de la technologie';
      if (job.titleByLocale.fr !== title) {
        job.titleByLocale.fr = title;
        job.slugByLocale.fr = slugify(title, citySuffix);
        fixed++;
      }
    }
    if (job.slug === 'collaboratore-trice-logistica-tecnico-impiantista-usi-lugano') {
      const title = 'Logistics collaborator - plant engineer';
      if (job.titleByLocale.en !== title) {
        job.titleByLocale.en = title;
        job.slugByLocale.en = slugify(title, citySuffix);
        fixed++;
      }
    }
  }

  if (fixed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(`🔧 Applied ${fixed} USI locale override(s).`);
  }
  return fixed;
}

// ──────────────────────────────────────────────────────────────
// Stats & validation
// ──────────────────────────────────────────────────────────────

function logUsiJobStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json non trovato — nessuna statistica disponibile.');
    return { total: 0, crawlDiff: { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] } };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const usiJobs = allJobs.filter(isUsiJob);

  // Category breakdown
  const categories = {};
  for (const job of usiJobs) {
    const cat = job.category || 'unknown';
    categories[cat] = (categories[cat] || 0) + 1;
  }

  // Location breakdown
  const locations = {};
  for (const job of usiJobs) {
    const loc = job.location || 'unknown';
    locations[loc] = (locations[loc] || 0) + 1;
  }

  console.log(`\n📊 === USI – Università della Svizzera italiana Job Stats ===`);
  console.log(`  🎓 Job totali trovati (USI): ${usiJobs.length}`);
  console.log(`  📍 Tutti in Canton Ticino: SI`);

  if (Object.keys(categories).length > 0) {
    console.log(`  📋 Per categoria:`);
    for (const [cat, count] of Object.entries(categories).sort((a, b) => b[1] - a[1])) {
      console.log(`     - ${cat}: ${count}`);
    }
  }

  if (Object.keys(locations).length > 0) {
    console.log(`  🏛️ Per sede:`);
    for (const [loc, count] of Object.entries(locations).sort((a, b) => b[1] - a[1])) {
      console.log(`     - ${loc}: ${count}`);
    }
  }

  console.log('');

  // Crawl change summary (new/updated/removed)
  const afterSnapshot = snapshotJobSlugs(usiJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'USI');
  writeCrawlChangeSummaryToGH(crawlDiff, 'USI');
  return { total: usiJobs.length, crawlDiff };
}

function validateUsiLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_USI_STRICT',
    label: 'USI',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isUsiJob,
    detectSourceLang: (text) => detectLang(text),
    deriveSlug: deriveLocalizedSlug,
    minDescriptionChars: 100,
    noJobsMessage: 'Nessun job USI trovato dopo il crawl — niente da validare.',
  });
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(USI_KEY, 'USI');
  console.log('🎓 Running dedicated USI – Università della Svizzera italiana jobs crawler...');
  console.log(`   IT page: ${LISTING_URL_IT}`);
  console.log(`   EN page: ${LISTING_URL_EN}\n`);

  // 1. Fetch and parse job listings from both IT and EN pages
  const discoveredJobs = await fetchUsiJobs();

  if (discoveredJobs.length === 0) {
    console.log('⚠️ No USI jobs discovered from the listing pages.');
    console.log('   The careers page may have changed structure or be temporarily unavailable.');
    console.log('   Keeping existing jobs — no changes to data/jobs.json.');
    logUsiJobStats();
    return;
  }

  // 2. Update the adapter config
  updateAdapterConfig();

  // 3. Merge discovered jobs into data/jobs.json
  await mergeUsiJobs(discoveredJobs);

  // Snapshot company jobs before crawl for diff summary
    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(USI_KEY, DATA_JOBS).filter(isUsiJob))

  // 4. Post-process: ensure consistency
  await postProcessUsiJobs();
  applyUsiLocaleOverrides();

  // 5. Fill missing locales with the dedicated localization pipeline.
  console.log('\n🌐 Running dedicated locale fill for USI jobs...');
  const localeFill = await localizeUsiJobs();
  if (localeFill.changed) {
    console.log(`🌐 USI locale fill: translated ${localeFill.translated}/${localeFill.total} jobs after post-processing.`);
    await postProcessUsiJobs();
    applyUsiLocaleOverrides();
  }

  // 6. Log stats
  const stats = logUsiJobStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ Nessun job USI trovato in questa esecuzione. Nessun errore — uscita OK.');
    return;
  }

  // 6b. Ensure no thin descriptions (< 50 words)
  const allJobsForPatch = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const usiJobsForPatch = (Array.isArray(allJobsForPatch) ? allJobsForPatch : []).filter(isUsiJob);
  const patchedCount = ensureMinimumDescriptionWordCount(usiJobsForPatch, 50);
  if (patchedCount > 0) {
    fs.writeFileSync(DATA_JOBS, `${JSON.stringify(allJobsForPatch, null, 2)}\n`, 'utf8');
    if (fs.existsSync(PUBLIC_JOBS)) {
      fs.writeFileSync(PUBLIC_JOBS, `${JSON.stringify(allJobsForPatch, null, 2)}\n`, 'utf8');
    }
    console.log(`📝 Patched ${patchedCount} thin USI descriptions (< 50 words)`);
  }

  // 7. Validate locale coverage (IT/EN/DE/FR)
  validateUsiLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isUsiJob) : [];
  writeJobsCrawlerSlice(USI_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: USI_KEY,
    label: 'USI',
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
  console.error(`❌ USI crawler failed: ${err?.message || err}`);
  process.exit(1);
});
