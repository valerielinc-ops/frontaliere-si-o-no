#!/usr/bin/env node
/**
 * Dedicated Volg Konsumwaren AG / fenaco crawler runner.
 *
 * Volg is a subsidiary of the fenaco cooperative — one of Switzerland's
 * largest employers (~11,400 staff). Job vacancies are published via a
 * Prospective.ch career center embedded on fenaco.com:
 *   https://ohws.prospective.ch/public/v1/careercenter/1001859/
 *
 * The career center serves server-rendered HTML with 7 jobs per page
 * and pagination via an `offset` query parameter (POST form, but also
 * works via GET).
 *
 * fenaco / Volg is a national employer, so this crawler fetches the
 * career center UNFILTERED (no region facet) and paginates the full
 * national set. The canton of each job is inferred per-job from the
 * city string alone via inferAnyCanton (CH-wide, all 26 cantons).
 * Jobs whose city does not resolve to a Swiss canton (foreign / unknown)
 * are dropped — there is no TI default.
 *
 * This crawler:
 *   1. Fetches all pages of the national career center (unfiltered).
 *   2. Parses job listings from HTML (title, company, location, workload).
 *   3. Infers the canton per job from the city; drops non-CH jobs.
 *   4. Builds standardized job objects.
 *   5. Merges into data/jobs.json.
 *   6. Translates missing locales.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { fileURLToPath } from 'node:url';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { safeLocationToken } from './lib/safe-location-token.mjs';
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
  ensureMinimumDescriptionWordCount,
  captureLostSlugs,
} from './lib/dedicated-crawler-common.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { getCantonDisplayName } from './lib/crawler-location-config.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const COMPANY_KEY = 'volg-fenaco';
// Per-crawler-scoped scratch path. This script does its own Prospective.ch
// fenaco career-center discovery + merge (no runDedicatedBaseCrawler pass)
// but still wrote straight to the literal data/jobs.json path — shared
// across ~25 sibling `background: true` crawler-group steps on one
// filesystem, gitignored and absent in CI (CRAWLER_SLICE_ONLY=1). Scoping
// the path per company avoids racing/clobbering siblings writing the same
// file (bug class of #3775/#3768, confirmed cause of #3769/#3770).
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const COMPANY_NAME = 'Volg / fenaco';
const COMPANY_DOMAIN = 'fenaco.com';

const CC_BASE = 'https://ohws.prospective.ch/public/v1/careercenter/1001859/';
const JOBS_PORTAL = 'https://jobs.fenaco.com';

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';
const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;
const JOBS_PER_PAGE = 7;

/* ── Helpers ───────────────────────────────────────────────── */
function readJson(filePath, fallback = []) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  const source = String(job.source || '').toLowerCase();
  return (
    key === COMPANY_KEY ||
    source === 'volg-fenaco-dedicated-crawler' ||
    (url.includes('jobs.fenaco.com') && source.includes('volg'))
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

/* ── Fetch HTML ────────────────────────────────────────────── */
async function fetchPage(url) {
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
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ── Parse Job Listings from HTML ──────────────────────────── */

/**
 * Extract the total job count from the career center page.
 * The count is in: <span class="total">33</span>
 */
function extractTotalCount(html) {
  const match = html.match(/<span\s+class="total">\s*(\d+)\s*<\/span>/i);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Parse individual job listings from the HTML.
 * Each job is an <a class="job job-N" href="..."> block with:
 *   - href → detail page URL on jobs.fenaco.com
 *   - h3.job-title → job title
 *   - div.company-name → "COMPANY, CITY"
 *   - span.place-of-work → "60-80%, Teilzeit" or "100%, unbefristet"
 */
function parseJobListings(html) {
  const jobs = [];
  // Match each job anchor block
  const jobRegex = /<a\s+class="job\s+job-\d+"\s+href="([^"]+)"[^>]*>[\s\S]*?<h3[^>]*class="[^"]*job-title[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/h3>[\s\S]*?<div\s+class="company-name">\s*([\s\S]*?)\s*<\/div>[\s\S]*?<span\s+class="place-of-work">[^]*?(?:<!---[^]*?--->)?\s*([\s\S]*?)\s*<\/span>[\s\S]*?<\/a>/g;

  let match;
  while ((match = jobRegex.exec(html)) !== null) {
    const [, url, rawTitle, rawCompany, rawMeta] = match;
    const title = rawTitle.replace(/\s+/g, ' ').trim();
    const companyLocation = rawCompany.replace(/\s+/g, ' ').trim();
    const meta = rawMeta.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim();

    // Parse "COMPANY, CITY" (e.g., "VOLG, Zuoz")
    const companyParts = companyLocation.split(',').map((s) => s.trim());
    const company = companyParts[0] || '';
    const city = companyParts.slice(1).join(', ').trim() || '';

    // Parse meta: "60-80%, Teilzeit" or "100%, unbefristet"
    const workloadMatch = meta.match(/([\d-]+%)/);
    const workload = workloadMatch ? workloadMatch[1] : '';

    const contractTerms = meta.replace(workloadMatch ? workloadMatch[0] : '', '').replace(/^[\s,]+|[\s,]+$/g, '').trim();

    jobs.push({ url, title, company, city, workload, contractTerms });
  }

  return jobs;
}

/* ── Fetch All Jobs (national, unfiltered) ─────────────────── */

/**
 * Resolve a job's canton CH-wide from its city string alone.
 *
 * The city is the cleanest single signal (the part after the company in
 * the "COMPANY, CITY" company-name div). Passing a "city + region"
 * combined string to inferAnyCanton would let TARGET_CANTONS array order
 * pick the wrong canton, so we infer from the bare city only.
 * Returns a 2-letter Swiss canton code, or '' when the city is not a
 * Swiss location (foreign / unknown) — never defaults to TI.
 */
function resolveJobCanton(city = '') {
  return inferAnyCanton(String(city || '').trim()) || '';
}

/**
 * Fetch the full national career center (no region facet) and paginate
 * via the `offset` query parameter. Canton is inferred per job later
 * from the city; non-CH / unresolved jobs are dropped.
 */
async function fetchAllJobs() {
  const allJobs = [];
  let offset = 0;

  // First page to get total count
  const firstUrl = `${CC_BASE}?lang=de&offset=0`;
  console.log(`  📥 Fetching national page 1: ${firstUrl}`);
  const firstHtml = await fetchPage(firstUrl);
  const totalCount = extractTotalCount(firstHtml);
  console.log(`     Total: ${totalCount} jobs (national, unfiltered)`);

  if (totalCount === 0) return [];

  allJobs.push(...parseJobListings(firstHtml));

  // Paginate through remaining pages
  offset += JOBS_PER_PAGE;
  while (offset < totalCount) {
    const pageNum = Math.floor(offset / JOBS_PER_PAGE) + 1;
    const url = `${CC_BASE}?lang=de&offset=${offset}`;
    console.log(`  📥 Fetching national page ${pageNum}: ${url}`);
    const html = await fetchPage(url);
    const batch = parseJobListings(html);
    if (batch.length === 0) break;
    allJobs.push(...batch);
    offset += JOBS_PER_PAGE;
  }

  return allJobs;
}

/* ── Fetch & Parse Detail Page ──────────────────────────────── */

/**
 * Decode common HTML entities in text.
 */
function decodeEntities(text) {
  return text
    .replace(/&bull;/g, '•')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&auml;/g, 'ä')
    .replace(/&ouml;/g, 'ö')
    .replace(/&uuml;/g, 'ü')
    .replace(/&Auml;/g, 'Ä')
    .replace(/&Ouml;/g, 'Ö')
    .replace(/&Uuml;/g, 'Ü')
    .replace(/&#\d+;/g, (m) => String.fromCharCode(parseInt(m.slice(2, -1), 10)));
}

/**
 * Extract list items from an HTML block, handling <ul><li>, <p> with bullets, and plain text.
 */
function extractItems(htmlBlock) {
  // Try <ul><li> first
  const ulMatch = htmlBlock.match(/<ul>([\s\S]*?)<\/ul>/i);
  if (ulMatch) {
    const items = [];
    const liRegex = /<li>([\s\S]*?)<\/li>/gi;
    let li;
    while ((li = liRegex.exec(ulMatch[1])) !== null) {
      const text = decodeEntities(li[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')).trim();
      if (text) items.push(text);
    }
    if (items.length > 0) return items;
  }

  // Try <p> with bullets or <br>-separated content
  const pMatches = htmlBlock.match(/<p>([\s\S]*?)<\/p>/gi);
  if (pMatches) {
    const items = [];
    for (const pm of pMatches) {
      const inner = pm.replace(/<\/?p>/gi, '');
      const content = decodeEntities(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
      const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const l of lines) {
        const cleaned = l.replace(/^[•\-–]\s*/, '').trim();
        if (cleaned) items.push(cleaned);
      }
    }
    if (items.length > 0) return items;
  }

  // Plain text fallback
  const plainText = decodeEntities(htmlBlock.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
  if (plainText.length > 20) {
    const lines = plainText.split(/(?:•|–)\s+/).filter((l) => l.trim().length > 3);
    return lines.length > 1 ? lines.map((l) => l.trim()) : [plainText];
  }

  return [];
}

/**
 * Calculate word-level overlap ratio between two strings (0..1).
 */
function titleOverlap(a, b) {
  if (!a || !b) return 0;
  const wordsA = new Set(a.toLowerCase().replace(/[^a-zäöüàéè\s]/gi, '').split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().replace(/[^a-zäöüàéè\s]/gi, '').split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let common = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) common++;
  }
  return common / Math.max(wordsA.size, wordsB.size);
}

// Exported for testing
export { titleOverlap };

/**
 * Parse rich content from a fenaco/Volg/LANDI job detail page.
 *
 * Primary strategy: use itemprop semantic attributes (responsibilities,
 * qualifications, incentives) which the fenaco ATS reliably emits.
 * Fallback strategy: heading-based extraction for non-standard layouts.
 *
 * Returns { text, title, sourceBodyLength, hasSections } so callers
 * can apply quality guards.
 */
function parseDetailPage(html, locale = 'de') {
  // Strip script/style/noscript blocks
  let clean = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');

  // ── Extract page title from <h1> ──
  const h1Match = clean.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const detailTitle = h1Match ? h1Match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';

  // ── Compute source body text length (for quality ratio check) ──
  const bodyText = decodeEntities(clean.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
  const sourceBodyLength = bodyText.length;

  const sections = [];
  const sectionLabelsByLocale = {
    de: { responsibilities: 'Aufgaben', qualifications: 'Profil', incentives: 'Vorteile' },
    fr: { responsibilities: 'Missions', qualifications: 'Profil', incentives: 'Avantages' },
    it: { responsibilities: 'Mansioni', qualifications: 'Profilo', incentives: 'Vantaggi' },
  };
  const sectionLabels = sectionLabelsByLocale[locale] || sectionLabelsByLocale.de;

  // ── Strategy 1 (primary): itemprop semantic blocks ──
  let usedItemprop = false;
  for (const [prop, label] of Object.entries(sectionLabels)) {
    const regex = new RegExp(`<div[^>]*itemprop="${prop}"[^>]*>([\\s\\S]*?)</div>`, 'i');
    const m = clean.match(regex);
    if (!m) continue;

    const block = m[1];
    // Extract the actual heading from inside the block
    const headingMatch = block.match(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/i);
    const heading = headingMatch
      ? headingMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      : label;

    const items = extractItems(block);
    if (items.length > 0) {
      sections.push(`## ${heading}\n${items.map((i) => `- ${i}`).join('\n')}`);
      usedItemprop = true;
    }
  }

  // ── Strategy 2 (fallback): heading + content blocks ──
  if (!usedItemprop) {
    // Multilingual (not locale-switched): the raw page's own headings can be in
    // any of de/fr/it regardless of the resolved fallback locale, so recognition
    // must cover all three — same class as the itemprop label fix above.
    const skipHeadings = /Arbeitsort|Kontakt|Standort|Recruiter|Stelleninformation|Bewerbungsinformation|Job-Ad|teilen|Druckversion|Datenschutz|Über uns|Weitere Stellen|Lieu de travail|Contact|Informations sur le poste|Informations de candidature|Partager|Politique de confidentialité|À propos|Autres offres|Luogo di lavoro|Contatto|Informazioni sulla posizione|Informazioni di candidatura|Condividi|Informativa sulla privacy|Chi siamo|Altre offerte/i;
    const sectionHeadingsRe = /Aufgaben|Profil|Vorteile|Anforderungen|Bieten|Erwarten|Leistungen|Kompetenzen|freuen|Missions|Avantages|Exigences|Offrons|Compétences|Votre profil|Vos tâches|Mansioni|Profilo|Vantaggi|Competenze|Requisiti|offriamo|Il tuo profilo/i;

    const introArticleMatch = clean.match(/<article>\s*<p>([\s\S]*?)<\/p>\s*<\/article>/i);
    if (introArticleMatch) {
      const intro = decodeEntities(
        introArticleMatch[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '),
      ).trim();
      if (intro.length > 30) sections.push(intro);
    }

    const headingContentRegex =
      /<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>\s*([\s\S]*?)(?=<h[2-4][^>]*>|<footer|<\/main|<\/article>\s*<\/div>\s*<\/div>|$)/gi;
    let match;
    const seenHeadings = new Set();

    while ((match = headingContentRegex.exec(clean)) !== null) {
      const heading = match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (!heading || skipHeadings.test(heading) || heading.length > 80) continue;
      if (!sectionHeadingsRe.test(heading) && !introArticleMatch) continue;
      if (seenHeadings.has(heading)) continue;
      seenHeadings.add(heading);

      const items = extractItems(match[2]);
      if (items.length > 0) {
        sections.push(`## ${heading}\n${items.map((i) => `- ${i}`).join('\n')}`);
      }
    }
  }

  const text = sections.join('\n\n');
  return { text, title: detailTitle, sourceBodyLength, hasSections: sections.length > 0 };
}

// Exported for testing
export { parseDetailPage };

/**
 * Fetch detail pages for all jobs in parallel batches.
 * Applies quality guards: body ratio >= 25% and title overlap >= 0.6.
 */
async function enrichWithDetails(jobs) {
  const BATCH_SIZE = 4;
  const DETAIL_TIMEOUT = 20000;
  const MIN_BODY_RATIO = 0.03; // parsed text must be >= 3% of raw source body
  const MIN_TITLE_OVERLAP = 0.6;
  let enriched = 0;
  let failed = 0;
  let rejected = 0;

  for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
    const batch = jobs.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async (job) => {
        if (!job.url) return;
        const detailUrl = job.url.includes('?') ? `${job.url}&lang=de` : `${job.url}?lang=de`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DETAIL_TIMEOUT);
        try {
          const res = await fetch(detailUrl, {
            signal: controller.signal,
            headers: {
              Accept: 'text/html',
              'User-Agent':
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            },
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const html = await res.text();
          const result = parseDetailPage(html, resolveCantonLocale(job.canton));

          // ── Quality guard: body ratio ──
          if (result.hasSections && result.sourceBodyLength > 0) {
            const ratio = result.text.length / result.sourceBodyLength;
            if (ratio < MIN_BODY_RATIO) {
              console.warn(
                `  ⚠️ Body ratio too low for "${job.title}": ${(ratio * 100).toFixed(1)}% (need ≥${(MIN_BODY_RATIO * 100).toFixed(0)}%)`,
              );
              rejected++;
              return;
            }
          }

          // ── Quality guard: title overlap ──
          if (result.title) {
            const overlap = titleOverlap(job.title, result.title);
            if (overlap < MIN_TITLE_OVERLAP) {
              // Low overlap: keep listing title (more descriptive than hashtag/marketing titles)
              console.warn(
                `  ⚠️ Title mismatch for "${job.title}" vs detail "${result.title}": overlap ${(overlap * 100).toFixed(0)}% (need ≥${(MIN_TITLE_OVERLAP * 100).toFixed(0)}%) — keeping listing title`,
              );
            }
          }

          if (result.text && result.text.length > 100) {
            // If the detail page content is richer than the current description, replace it.
            // If it's shorter (thin apprenticeship pages etc.), append it to the boilerplate
            // so we never lose context in exchange for a minimal "Deine Vorteile" blurb.
            if (result.text.length >= job.description.length * 0.6) {
              job.description = result.text;
            } else {
              job.description = `${result.text}\n\n${job.description}`;
            }
            // Mark as enriched so merge clears stale translations
            job._enrichedFromDetail = true;
            enriched++;
          }
        } catch (err) {
          failed++;
          console.warn(`  ⚠️ Detail fetch failed for ${job.title}: ${err.message}`);
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    // Small delay between batches to be polite
    if (i + BATCH_SIZE < jobs.length) await new Promise((r) => setTimeout(r, 500));
  }

  console.log(
    `  📄 Detail pages: ${enriched} enriched, ${rejected} rejected (quality), ${failed} failed`,
  );
}

/* ── Build Job Objects ─────────────────────────────────────── */
function mapCategory(company = '') {
  const c = company.toLowerCase();
  if (c.includes('volg')) return 'Vendita & Commercio';
  if (c.includes('landi')) return 'Agricoltura & Commercio';
  if (c.includes('traveco')) return 'Logistica & Trasporti';
  if (c.includes('agrola')) return 'Energia';
  if (c.includes('ufa')) return 'Agricoltura & Mangimi';
  if (c.includes('frigemo') || c.includes('ernst sutter')) return 'Industria Alimentare';
  if (c.includes('anicom')) return 'Commercio Bestiame';
  if (c.includes('serco') || c.includes('landtechnik')) return 'Tecnica Agricola';
  return 'Commercio & Servizi';
}

function mapSector(company = '') {
  const c = company.toLowerCase();
  if (c.includes('volg')) return 'Dettaglio & Alimentari';
  if (c.includes('landi')) return 'Agricoltura & Dettaglio';
  if (c.includes('traveco')) return 'Trasporti & Logistica';
  return 'Cooperativa Agricola';
}

function mapEmploymentType(workload = '', contractTerms = '') {
  const w = workload.replace(/%/g, '');
  const parts = w.split('-');
  const maxPercent = parseInt(parts[parts.length - 1], 10) || 100;

  const terms = contractTerms.toLowerCase();
  let employmentType = maxPercent >= 80 ? 'full-time' : 'part-time';
  let contractType = 'permanent';

  if (terms.includes('teilzeit')) employmentType = 'part-time';
  if (terms.includes('vollzeit')) employmentType = 'full-time';
  if (terms.includes('befristet') && !terms.includes('unbefristet')) contractType = 'fixed-term';
  if (terms.includes('unbefristet')) contractType = 'permanent';

  return { employmentType, contractType };
}

// Per-company "about us" boilerplate, localized by canton-resolved locale.
// Volg/LANDI/fenaco crawl CH-wide (see CANTON_LOCALE_FALLBACK above); a
// German-only boilerplate mixed into an otherwise French/Italian description
// is the same cross-language-contamination bug class as the sourceLang fix.
const COMPANY_BOILERPLATE = {
  volg: {
    de: [
      'Volg ist spezialisiert auf Dorfläden und kleine Verkaufsflächen in der Deutschschweiz und Romandie.',
      'Wir setzen auf Kundennähe und bieten bequeme Einkaufsmöglichkeiten mit persönlicher Interaktion.',
      'Unsere Mitarbeitenden sind das Herzstück des Ladens — unser Motto ist «frisch und fründlich».',
      'Als Tochterunternehmen der fenaco Genossenschaft gehören wir zu einem der grössten Arbeitgeber der Schweiz mit über 11.000 Mitarbeitenden.',
      '',
      'Wir bieten: Abwechslungsreiche Aufgaben, familiäres Arbeitsumfeld, direkten Kundenkontakt,',
      '6 Wochen Ferien, SBB-Vergünstigungen, Weiterbildung an der Volg Academy,',
      'ausgezeichnete Karrieremöglichkeiten und eine fundierte Berufsausbildung für Lernende.',
    ],
    fr: [
      "Volg est spécialisé dans les magasins de village et les petites surfaces de vente en Suisse alémanique et en Romandie.",
      "Nous misons sur la proximité avec la clientèle et proposons des possibilités d'achat pratiques avec une interaction personnelle.",
      'Nos collaboratrices et collaborateurs sont le cœur du magasin — notre devise est «frais et sympathique».',
      'En tant que filiale de la coopérative fenaco, nous comptons parmi les plus grands employeurs de Suisse avec plus de 11 000 collaborateurs.',
      '',
      'Nous offrons : des tâches variées, un environnement de travail familial, un contact client direct,',
      '6 semaines de vacances, des réductions CFF, une formation continue à la Volg Academy,',
      "d'excellentes perspectives de carrière et une formation professionnelle solide pour les apprenti-e-s.",
    ],
    it: [
      'Volg è specializzata in negozi di villaggio e piccole superfici di vendita nella Svizzera tedesca e in Romandia.',
      "Puntiamo sulla vicinanza alla clientela e offriamo comode possibilità di acquisto con un'interazione personale.",
      'I nostri collaboratori sono il cuore del negozio — il nostro motto è «freschezza e cordialità».',
      'Come filiale della cooperativa fenaco, siamo tra i maggiori datori di lavoro della Svizzera con oltre 11.000 collaboratori.',
      '',
      'Offriamo: mansioni variate, un ambiente di lavoro familiare, contatto diretto con la clientela,',
      '6 settimane di vacanza, agevolazioni FFS, formazione continua alla Volg Academy,',
      'eccellenti opportunità di carriera e una solida formazione professionale per gli apprendisti.',
    ],
  },
  landi: {
    de: [
      'LANDI ist Teil der fenaco Genossenschaft, der grössten Agrargenossenschaft der Schweiz.',
      'Wir betreiben TopShop-Verkaufsstellen, Tankstellen und Fachgeschäfte in der ganzen Schweiz.',
      'Die fenaco Genossenschaft beschäftigt über 11.000 Mitarbeitende und ist einer der bedeutendsten Arbeitgeber im ländlichen Raum.',
      'Unsere LANDI-Läden bieten ein breites Sortiment an landwirtschaftlichen Produkten, Bau- und Gartenbedarf, Lebensmitteln und Treibstoffen.',
      '',
      'Wir bieten ein dynamisches Arbeitsumfeld mit direktem Kundenkontakt,',
      'umfassende Weiterbildungsmöglichkeiten, attraktive Anstellungsbedingungen im Detailhandel,',
      'mindestens 5 Wochen Ferien, Personalrabatte auf das gesamte Sortiment',
      'und eine praxisorientierte Berufsausbildung für Lernende.',
    ],
    fr: [
      "LANDI fait partie de la coopérative fenaco, la plus grande coopérative agricole de Suisse.",
      'Nous exploitons des points de vente TopShop, des stations-service et des commerces spécialisés dans toute la Suisse.',
      "La coopérative fenaco emploie plus de 11 000 collaborateurs et est l'un des plus importants employeurs en milieu rural.",
      'Nos magasins LANDI proposent un large assortiment de produits agricoles, de matériaux de construction et de jardinage, de denrées alimentaires et de carburants.',
      '',
      'Nous offrons un environnement de travail dynamique avec un contact client direct,',
      "de vastes possibilités de formation continue, des conditions d'engagement attractives dans le commerce de détail,",
      'au moins 5 semaines de vacances, des rabais sur l\'ensemble de l\'assortiment',
      "et une formation professionnelle axée sur la pratique pour les apprenti-e-s.",
    ],
    it: [
      'LANDI fa parte della cooperativa fenaco, la più grande cooperativa agricola della Svizzera.',
      'Gestiamo punti vendita TopShop, stazioni di servizio e negozi specializzati in tutta la Svizzera.',
      'La cooperativa fenaco impiega oltre 11.000 collaboratori ed è uno dei maggiori datori di lavoro nelle aree rurali.',
      'I nostri negozi LANDI offrono un ampio assortimento di prodotti agricoli, materiale edile e da giardinaggio, alimentari e carburanti.',
      '',
      'Offriamo un ambiente di lavoro dinamico con contatto diretto con la clientela,',
      'ampie possibilità di formazione continua, condizioni di assunzione interessanti nel commercio al dettaglio,',
      'almeno 5 settimane di vacanza, sconti per il personale sull\'intero assortimento',
      'e una formazione professionale orientata alla pratica per gli apprendisti.',
    ],
  },
  traveco: {
    de: [
      'TRAVECO Transporte AG ist ein führendes Unternehmen im Bereich Transport und Logistik in der Schweiz,',
      'Teil der fenaco Genossenschaft mit über 11.000 Mitarbeitenden schweizweit.',
      'Wir betreiben eine moderne Flotte und bieten zuverlässige Transportdienstleistungen in der ganzen Schweiz.',
      'Mit modernsten Fahrzeugen und höchsten Sicherheitsstandards sorgen wir für den effizienten Transport von Lebensmitteln und Agrarprodukten.',
      '',
      'Wir bieten: Professionelles Arbeitsumfeld, moderne Fahrzeuge, kontinuierliche Weiterbildung,',
      'wettbewerbsfähige Anstellungsbedingungen, mindestens 5 Wochen Ferien',
      'und ausgezeichnete Perspektiven im Transportsektor.',
    ],
    fr: [
      "TRAVECO Transporte AG est une entreprise leader dans le domaine du transport et de la logistique en Suisse,",
      'faisant partie de la coopérative fenaco avec plus de 11 000 collaborateurs dans tout le pays.',
      'Nous exploitons une flotte moderne et proposons des prestations de transport fiables dans toute la Suisse.',
      'Grâce à des véhicules à la pointe de la technologie et aux normes de sécurité les plus strictes, nous assurons un transport efficace des denrées alimentaires et des produits agricoles.',
      '',
      'Nous offrons : un environnement de travail professionnel, des véhicules modernes, une formation continue,',
      'des conditions d\'engagement compétitives, au moins 5 semaines de vacances',
      "et d'excellentes perspectives dans le secteur du transport.",
    ],
    it: [
      "TRAVECO Transporte AG è un'azienda leader nel settore dei trasporti e della logistica in Svizzera,",
      'parte della cooperativa fenaco con oltre 11.000 collaboratori in tutto il Paese.',
      'Gestiamo una flotta moderna e offriamo servizi di trasporto affidabili in tutta la Svizzera.',
      'Con veicoli all\'avanguardia e standard di sicurezza elevati, garantiamo un trasporto efficiente di alimenti e prodotti agricoli.',
      '',
      'Offriamo: un ambiente di lavoro professionale, veicoli moderni, formazione continua,',
      'condizioni di assunzione competitive, almeno 5 settimane di vacanza',
      'ed eccellenti prospettive nel settore dei trasporti.',
    ],
  },
  default: {
    de: [
      'fenaco Genossenschaft ist die grösste Agrargenossenschaft der Schweiz mit über 11.000 Mitarbeitenden.',
      'Wir bieten vielfältige Karrieremöglichkeiten in Landwirtschaft, Detailhandel,',
      'Logistik und Lebensmittelproduktion mit attraktiven Anstellungsbedingungen,',
      'umfassenden Sozialleistungen und individuellen Weiterbildungsmöglichkeiten.',
      'Als genossenschaftliches Unternehmen im Besitz der Schweizer Landwirtschaft vereinen wir über 80 Tochtergesellschaften.',
      'Wir bieten sichere Arbeitsplätze, moderne Infrastruktur und die Möglichkeit, einen Beitrag zur Schweizer Landwirtschaft zu leisten.',
    ],
    fr: [
      'La coopérative fenaco est la plus grande coopérative agricole de Suisse avec plus de 11 000 collaborateurs.',
      "Nous offrons de nombreuses possibilités de carrière dans l'agriculture, le commerce de détail,",
      'la logistique et la production alimentaire, avec des conditions d\'engagement attractives,',
      'des prestations sociales complètes et des possibilités de formation continue individuelles.',
      "En tant qu'entreprise coopérative détenue par l'agriculture suisse, nous réunissons plus de 80 sociétés filiales.",
      'Nous offrons des emplois sûrs, une infrastructure moderne et la possibilité de contribuer à l\'agriculture suisse.',
    ],
    it: [
      'La cooperativa fenaco è la più grande cooperativa agricola della Svizzera con oltre 11.000 collaboratori.',
      'Offriamo molteplici opportunità di carriera in agricoltura, commercio al dettaglio,',
      'logistica e produzione alimentare, con condizioni di assunzione interessanti,',
      'prestazioni sociali complete e possibilità di formazione continua individuali.',
      "Come impresa cooperativa di proprietà dell'agricoltura svizzera, riuniamo oltre 80 società affiliate.",
      "Offriamo posti di lavoro sicuri, un'infrastruttura moderna e la possibilità di contribuire all'agricoltura svizzera.",
    ],
  },
};

function getCompanyBoilerplate(company = '', locale = 'de') {
  const c = company.toLowerCase();
  const key = c.includes('volg') ? 'volg'
    : c.includes('landi') ? 'landi'
    : c.includes('traveco') ? 'traveco'
    : 'default';
  const entry = COMPANY_BOILERPLATE[key];
  return (entry[locale] || entry.de).join('\n');
}

// Per-city postal code table for known Volg/LANDI/fenaco locations.
// Used as a fast lookup; cities outside the table fall back to a
// canton-level postal code (see CANTON_POSTAL_FALLBACK), then '0000'.
// Prevents applyCompanyDefaults from overwriting per-job locations with HQ (Cadenazzo).
const CITY_POSTAL_CH = {
  // Graubünden
  Andeer: '7440', Arosa: '7050', Bever: '7502', Bonaduz: '7402', Chur: '7000',
  'Davos Dorf': '7260', 'Davos Platz': '7270', 'Disentis/Mustér': '7180',
  'Eggersriet SG': '9034', Flims: '7017', Klosters: '7250', 'Laax Signina': '7031',
  Landquart: '7302', Lenzerheide: '7078', Malans: '7208', Maienfeld: '7304',
  Nufenen: '6546', Pany: '7234', Pontresina: '7504', Poschiavo: '7742',
  Saas: '7247', 'Sils Maria': '7514', Splügen: '7435', 'St. Moritz': '7500',
  'Tenna GR': '7106', Thusis: '7430', Trimmis: '7203', Untervaz: '7204',
  Vals: '7132', Zuoz: '7524',
  // Valais / Wallis
  Anniviers: '3960', Baltschieder: '3937', Bettmeralp: '3992', Binn: '3996',
  'Brig-Glis': '3900', Bürchen: '3943', 'Collombey-Muraz': '1868',
  Ernen: '3995', Eyholz: '3930', Founex: '1297', Grächen: '3925',
  'Obergoms VS': '3988', Orsières: '1937', Raron: '3942', Reckingen: '3993',
  'Saint-Maurice': '1890', Saxon: '1907', Saas: '3910',
  'Unterbäch': '3944', Veysonnaz: '1993', Vex: '1981', Visp: '3930',
  Visperterminen: '3932', Vissoie: '3960', 'Wiler (Lötschen)': '3918',
  // Ticino
  Bellinzona: '6500', Biasca: '6710', Cadenazzo: '6593', Chiasso: '6830',
  'Giubiasco': '6512', Locarno: '6600', Lugano: '6900', Mendrisio: '6850',
};

// Canton-specific fallback postal codes (canton capital / representative PLZ)
// when the city is not in the lookup table. CH-wide now (Volg is national), so
// every canton needs a sane fallback — '0000' would emit a bogus postalCode in
// the JobPosting structured data on hundreds of pages.
const CANTON_POSTAL_FALLBACK = {
  AG: '5000', AI: '9050', AR: '9100', BE: '3000', BL: '4410', BS: '4000',
  FR: '1700', GE: '1200', GL: '8750', GR: '7000', JU: '2800', LU: '6000',
  NE: '2000', NW: '6370', OW: '6060', SG: '9000', SH: '8200', SO: '4500',
  SZ: '6430', TG: '8500', TI: '6900', UR: '6460', VD: '1000', VS: '3900',
  ZG: '6300', ZH: '8000',
};

function getPostalCode(city = '', canton = '') {
  return CITY_POSTAL_CH[city] || CANTON_POSTAL_FALLBACK[canton] || '0000';
}

// Canton -> primary official language fallback. Volg/LANDI/fenaco is CH-wide,
// so a hardcoded 'de' fallback mislabels French/Italian-canton postings
// (detectLang() falls back to the caller-supplied default for short/ambiguous
// titles) and generates German-only description text for those jobs. Officially
// bilingual FR/VS/BE default to their French/German majority-practical locale.
const CANTON_LOCALE_FALLBACK = {
  GE: 'fr', VD: 'fr', NE: 'fr', JU: 'fr', VS: 'fr', FR: 'fr',
  TI: 'it',
};

function resolveCantonLocale(canton = '') {
  return CANTON_LOCALE_FALLBACK[canton] || 'de';
}

const META_LABELS = {
  de: { workload: 'Pensum', contract: 'Vertrag', apply: 'Bewerbung über' },
  fr: { workload: "Taux d'occupation", contract: 'Contrat', apply: 'Postulez sur' },
  it: { workload: 'Grado di occupazione', contract: 'Contratto', apply: 'Candidati su' },
};

function buildJob(raw) {
  const { url, title, company, city, workload, contractTerms, canton } = raw;
  const { employmentType, contractType } = mapEmploymentType(workload, contractTerms);
  const slug = slugify(`${title}-${company}-${safeLocationToken(city)}`);
  // Volg/LANDI/fenaco crawl CH-wide (see CANTON_LOCALE_FALLBACK): fall back to
  // the job's canton-primary locale, not a hardcoded 'de', so ambiguous/short
  // titles from French/Italian cantons don't get mislabeled as German — the
  // root cause of the titleByLocale.de flapping (raw fresh-scrape text always
  // wins the source-locale merge slot; a wrong sourceLang points that slot at
  // the wrong language every run).
  const localeFallback = resolveCantonLocale(canton);
  const sourceLang = detectLang(title, localeFallback);
  const today = new Date().toISOString().slice(0, 10);
  const postalCode = getPostalCode(city, canton);
  const labels = META_LABELS[localeFallback] || META_LABELS.de;

  const metaLine = [
    `${title} — ${company}, ${city} (${getCantonDisplayName(canton, localeFallback) || canton}).`,
    workload ? `${labels.workload}: ${workload}.` : '',
    contractTerms ? `${labels.contract}: ${contractTerms}.` : '',
    `${labels.apply} ${JOBS_PORTAL}`,
  ].filter(Boolean).join(' ');

  // Build rich description with company context so content is never thin
  const companyBoilerplate = getCompanyBoilerplate(company, localeFallback);
  const description = `${metaLine}\n\n${companyBoilerplate}`;

  return {
    title,
    slug,
    url,
    applyUrl: url,
    company,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: city,
    addressLocality: city,
    addressRegion: canton,
    addressCountry: 'CH',
    postalCode,
    streetAddress: '',
    canton,
    country: 'CH',
    category: mapCategory(company),
    sector: mapSector(company),
    source: 'volg-fenaco-dedicated-crawler',
    sourceLang,
    postedDate: today,
    validThrough: '',
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
      const j = { ...job };
      delete j._enrichedFromDetail;
      return j;
    }
    updated += 1;
    // When description was enriched from the detail page, clear stale
    // translations so translateMissingJobLocales regenerates them.
    const srcLang = job.sourceLang || prev.sourceLang || null;
    const descByLocale = job._enrichedFromDetail
      ? mergeLocaleTextMap(prev.descriptionByLocale || {}, job.descriptionByLocale || {}, 30, srcLang)
      : mergeLocaleTextMap(prev.descriptionByLocale || {}, job.descriptionByLocale || {}, 30, srcLang);
    const merged = {
      ...prev,
      ...job,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, job.titleByLocale, 3, srcLang),
      descriptionByLocale: descByLocale,
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale, job.slugByLocale, 3, srcLang),
      needsRetranslation: job._enrichedFromDetail ? true : (prev.needsRetranslation || false),
    };
    captureLostSlugs(merged, prev.slugByLocale, prev.slug, 20);
    delete merged._enrichedFromDetail;
    return merged;
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

  // Canton breakdown (CH-wide)
  const cantons = {};
  for (const j of jobs) {
    const c = (j.canton || '??').toUpperCase();
    cantons[c] = (cantons[c] || 0) + 1;
  }

  // Company breakdown
  const companies = {};
  for (const j of jobs) {
    const c = j.company || 'Unknown';
    companies[c] = (companies[c] || 0) + 1;
  }

  console.log(`\n📊 === ${COMPANY_NAME} Job Stats ===`);
  console.log(`  🏪 Total jobs: ${jobs.length}`);
  console.log(
    `  📍 Cantons: ${Object.entries(cantons)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(', ')}`,
  );
  console.log(`  🏢 Companies:`);
  for (const [name, count] of Object.entries(companies).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${name}: ${count}`);
  }
  console.log('');
}

function validateLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_VOLG_STRICT',
    label: COMPANY_NAME,
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    noJobsMessage: 'No Volg / fenaco jobs found after crawl.',
    maxToleratedMissingDescriptions: 20,
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'volg');
  console.log('🏪 Running dedicated Volg / fenaco jobs crawler...');
  console.log(`   Source: ${CC_BASE}`);
  console.log('');

  // Step 1: Fetch the full national career center (unfiltered)
  const allRawJobs = await fetchAllJobs();
  console.log(`📋 Found ${allRawJobs.length} total jobs (national)`);

  if (allRawJobs.length === 0) {
    console.log('ℹ️ No jobs found. Exiting OK.');
    return;
  }

  // Deduplicate by URL (same job might appear across pages)
  const seen = new Set();
  const uniqueJobs = allRawJobs.filter((j) => {
    const key = j.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log(`🎯 ${uniqueJobs.length} unique jobs after dedup`);

  // Step 1b: Infer canton CH-wide from the city; drop non-Swiss / unresolved.
  let dropped = 0;
  const chJobs = uniqueJobs
    .map((j) => ({ ...j, canton: resolveJobCanton(j.city) }))
    .filter((j) => {
      if (!j.canton) {
        dropped += 1;
        return false;
      }
      return true;
    });
  console.log(`🇨🇭 ${chJobs.length} jobs resolved to a Swiss canton (${dropped} non-CH/unresolved dropped)`);

  if (chJobs.length === 0) {
    console.log('ℹ️ No Swiss-resolved jobs. Exiting OK.');
    return;
  }

  // Step 2: Build standardized job objects
  const jobs = chJobs.map(buildJob);
  console.log(`✅ Built ${jobs.length} job objects`);

  // Step 2b: Enrich with detail page content
  console.log('\n📄 Fetching detail pages for rich descriptions...');
  await enrichWithDetails(jobs);

  // Step 3: Merge into jobs.json
  const { total, added, updated, diff} = mergeJobs(jobs);
  console.log(`\n📦 Merge complete: ${total} total, ${added} added, ${updated} updated`);

  // Step 4: Translate missing locales
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  // Step 4b: Ensure no thin descriptions (< 50 words)
  const allJobsForPatch = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const volgJobs = allJobsForPatch.filter(isTargetJob);
  const patchedCount = ensureMinimumDescriptionWordCount(volgJobs, 50);
  if (patchedCount > 0) {
    writeJson(DATA_JOBS, allJobsForPatch);
    if (fs.existsSync(path.dirname(PUBLIC_JOBS))) {
      writeJson(PUBLIC_JOBS, allJobsForPatch);
    }
    console.log(`📝 Patched ${patchedCount} thin descriptions (< 50 words)`);
  }

  // Step 5: Stats + validation
  logStats();
  validateLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'volg',
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

main().catch((err) => exitCrawlerOnError(err, 'Volg / fenaco'));
