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
 * are dropped — no canton is invented for unresolved locations.
 *
 * This crawler:
 *   1. Fetches all pages of the national career center (unfiltered).
 *   2. Parses job listings from HTML (title, company, location, workload).
 *   3. Infers the canton per job from the city; drops non-CH jobs.
 *   4. Builds standardized job objects.
 *   5. Merges into data/jobs.json.
 *   6. Translates missing locales.
 */
import { decode as decodeHTML } from 'html-entities';
import fs from 'node:fs';
import path from 'node:path';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
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
  captureLostSlugs,
} from './lib/dedicated-crawler-common.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { officialLocalityPostalCode } from './lib/swiss-locality-directory.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { truncateSlugAtWordBoundary } from './lib/slug-truncate.mjs';
import { collapseRepublishedCoopVacancies, enrichCoopSourceBackedJobs } from './lib/coop-job-parser.mjs';
import { detailDropSummaryFields } from './lib/crawler-detail-drop.mjs';
import { meetsSourceBodyFloor } from './lib/source-body-floor.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const COMPANY_KEY = 'volg-fenaco';
const volgSummaryCounts = { detailDrop: null };
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
  const slug = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return truncateSlugAtWordBoundary(slug, 120);
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
  return match ? parseInt(match[1], 10) : null;
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

    // Parse "COMPANY, CITY" (e.g., "VOLG, Zuoz"). The city is the LAST
    // segment: multi-part employer names ("Kunz Landtechnik, Serco Retail AG,
    // Reiden", "fenaco Getreide, Ölsaaten, Futtermittel, Bern") used to publish
    // "Serco Retail AG, Reiden" as the location of 10/555 vacancies.
    const companyParts = companyLocation.split(',').map((s) => s.trim()).filter(Boolean);
    const company = companyParts[0] || '';
    const city = companyParts.length > 1 ? companyParts.at(-1) : '';

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
 * Swiss location (foreign / unknown) — never invents a canton.
 */
function resolveJobCanton(city = '') {
  return inferAnyCanton(String(city || '').trim()) || '';
}

/**
 * Fetch the full national career center (no region facet) and paginate
 * via the `offset` query parameter. Canton is inferred per job later
 * from the city; non-CH / unresolved jobs are dropped.
 */
export async function fetchAllJobs() {
  const uniqueJobs = new Map();
  let offset = 0;

  // First page to get total count
  const firstUrl = `${CC_BASE}?lang=de&offset=0`;
  console.log(`  📥 Fetching national page 1: ${firstUrl}`);
  const firstHtml = await fetchPage(firstUrl);
  const totalCount = extractTotalCount(firstHtml);
  if (totalCount === null) {
    throw new Error('Volg source did not publish a total job count; refusing an unproven partial crawl');
  }
  console.log(`     Total: ${totalCount} jobs (national, unfiltered)`);

  if (totalCount === 0) return [];

  const firstBatch = parseJobListings(firstHtml);
  if (firstBatch.length === 0) {
    throw new Error(`Volg source declared ${totalCount} jobs but page 1 contained none`);
  }
  const addUniqueJobs = (batch) => {
    let added = 0;
    for (const job of batch) {
      const key = jobMatchKey(job);
      if (!key) {
        throw new Error('Volg source listing has no stable identity; pagination completeness is unverified');
      }
      if (!uniqueJobs.has(key)) {
        uniqueJobs.set(key, job);
        added += 1;
      }
    }
    return added;
  };

  addUniqueJobs(firstBatch);
  if (uniqueJobs.size > totalCount) {
    throw new Error(`Volg pagination exceeded declared total: fetched ${uniqueJobs.size}/${totalCount} unique jobs`);
  }

  // Paginate through remaining pages
  offset += firstBatch.length;
  while (uniqueJobs.size < totalCount) {
    const pageNum = Math.floor(offset / JOBS_PER_PAGE) + 1;
    const url = `${CC_BASE}?lang=de&offset=${offset}`;
    console.log(`  📥 Fetching national page ${pageNum}: ${url}`);
    const html = await fetchPage(url);
    const batch = parseJobListings(html);
    if (batch.length === 0) {
      throw new Error(
        `Volg source pagination ended early: fetched ${uniqueJobs.size}/${totalCount} unique jobs`,
      );
    }
    const added = addUniqueJobs(batch);
    if (uniqueJobs.size > totalCount) {
      throw new Error(`Volg pagination exceeded declared total: fetched ${uniqueJobs.size}/${totalCount} unique jobs`);
    }
    if (added === 0) {
      throw new Error(
        `Volg source pagination did not advance at offset ${offset}: page added no unique jobs`,
      );
    }
    offset += batch.length;
  }

  if (uniqueJobs.size !== totalCount) {
    throw new Error(`Volg source pagination incomplete: fetched ${uniqueJobs.size}/${totalCount} unique jobs`);
  }
  console.log(`     Fetched ${uniqueJobs.size}/${totalCount} unique jobs`);

  return [...uniqueJobs.values()];
}

/* ── Fetch & Parse Detail Page ──────────────────────────────── */

/**
 * Decode common HTML entities in text.
 */
function decodeEntities(text = '') {
  return decodeHTML(String(text || ''), { scope: 'strict' }).replaceAll('\u00a0', ' ');
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
  const sourceBacked = await enrichCoopSourceBackedJobs(jobs, {
    allowedHosts: ['jobs.fenaco.com'],
    concurrency: 4,
    onDropSummary: (drop) => { volgSummaryCounts.detailDrop = drop; },
    // A retryable detail status must not abort the complete, already parsed
    // listing batch: such a job comes back without a body and
    // resolveVolgJobBodies() carries the previously read source text or keeps
    // it out of this run. Network/DNS/TLS failures remain fail-closed in the
    // shared helper.
    preserveListingOnTransientFailure: true,
  });
  // The same source-backed ad published twice under two UUIDs (same body and
  // facts, even when fenaco omits a street) is one vacancy: keep the
  // earliest-seen record. Listing fallbacks are not source-backed and stay
  // outside this no-address proof.
  const { kept: enriched, collapsed } = collapseRepublishedCoopVacancies(sourceBacked, {
    allowIdenticalSourcePostingsWithoutAddress: true,
  });
  for (const { url, keptUrl } of collapsed) console.log(`  ↪️ Republished vacancy ${url} collapsed into ${keptUrl}`);
  jobs.splice(0, jobs.length, ...enriched);
  console.log(`  📄 Detail pages: ${enriched.length} source-backed${collapsed.length ? ` (${collapsed.length} republished duplicate(s) collapsed)` : ''}`);
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

/* ── Source-only bodies ─────────────────────────────────────── */

// Earlier runs gave a vacancy without a detail body an invented text: a
// listing line ("<title> — VOLG, Krauchthal (Bern). Pensum: 20-30%. Vertrag:
// unbefristet. Bewerbung über https://jobs.fenaco.com") followed by a
// per-company marketing paragraph written here (COMPANY_BOILERPLATE, removed
// with issue 5253), or the shared Italian "VOLG è il marchio di prossimità…"
// padding of the shared thin-description helper. The opening sentence of every
// variant is enough to recognise records that still carry it.
const VOLG_INVENTED_TEXT_MARKERS = [
  'Volg ist spezialisiert auf Dorfläden und kleine Verkaufsflächen in der Deutschschweiz und Romandie.',
  'Volg est spécialisé dans les magasins de village et les petites surfaces de vente en Suisse alémanique et en Romandie.',
  'Volg è specializzata in negozi di villaggio e piccole superfici di vendita nella Svizzera tedesca e in Romandia.',
  'LANDI ist Teil der fenaco Genossenschaft, der grössten Agrargenossenschaft der Schweiz.',
  'LANDI fait partie de la coopérative fenaco, la plus grande coopérative agricole de Suisse.',
  'LANDI fa parte della cooperativa fenaco, la più grande cooperativa agricola della Svizzera.',
  'TRAVECO Transporte AG ist ein führendes Unternehmen im Bereich Transport und Logistik in der Schweiz,',
  'TRAVECO Transporte AG est une entreprise leader dans le domaine du transport et de la logistique en Suisse,',
  "TRAVECO Transporte AG è un'azienda leader nel settore dei trasporti e della logistica in Svizzera,",
  'fenaco Genossenschaft ist die grösste Agrargenossenschaft der Schweiz mit über 11.000 Mitarbeitenden.',
  'La coopérative fenaco est la plus grande coopérative agricole de Suisse avec plus de 11 000 collaborateurs.',
  'La cooperativa fenaco è la più grande cooperativa agricola della Svizzera con oltre 11.000 collaboratori.',
  'VOLG è il marchio di prossimità della cooperativa fenaco',
];
const VOLG_LISTING_LINE_RX = /\b(?:Bewerbung über|Postulez sur|Candidati su) https:\/\/jobs\.fenaco\.com\b/;

/** True when `text` carries the invented listing line or company paragraph. */
export function isVolgInventedText(text = '') {
  const value = String(text || '');
  return VOLG_LISTING_LINE_RX.test(value) || VOLG_INVENTED_TEXT_MARKERS.some((marker) => value.includes(marker));
}

function previousSourceBody(job) {
  for (const candidate of [job?.descriptionByLocale?.[job?.sourceLang], job?.description]) {
    const text = String(candidate || '').trim();
    if (text && !isVolgInventedText(text) && meetsSourceBodyFloor(text)) return text;
  }
  return '';
}

/**
 * Give every job of this run a body read from the source. A vacancy whose
 * detail page failed with a retryable status (kept by the enricher with an
 * empty body) keeps the text a previous run read from the SAME vacancy, with
 * that run's `sourceLang`; with no such text it is not published in this run
 * (mergeJobs() publishes only this run's jobs) and comes back with the next
 * successful detail read.
 *
 * @returns {{ jobs: object[], carried: string[], withheld: string[] }}
 */
export function resolveVolgJobBodies(freshJobs = [], existingJobs = []) {
  const previousByKey = new Map();
  for (const job of existingJobs) {
    const key = jobMatchKey(job);
    if (key) previousByKey.set(key, job);
  }
  const jobs = [];
  const carried = [];
  const withheld = [];
  for (const job of freshJobs) {
    const body = String(job?.description || '').trim();
    if (body && !isVolgInventedText(body)) {
      jobs.push(job);
      continue;
    }
    const previous = previousByKey.get(jobMatchKey(job));
    const previousBody = previous ? previousSourceBody(previous) : '';
    if (!previousBody) {
      withheld.push(job.url);
      continue;
    }
    const sourceLang = previous.sourceLang || job.sourceLang;
    carried.push(job.url);
    jobs.push({
      ...job,
      sourceLang,
      description: previousBody,
      descriptionByLocale: { [sourceLang]: previousBody },
    });
  }
  return { jobs, carried, withheld };
}

/**
 * Remove invented text that earlier runs stored in the locale slots. The merge
 * keeps non-source slots ("existing translation wins"), so a record that once
 * published the invented paragraph kept it — untranslated German in `it`/`en`/
 * `fr` included — after the real body came back. When any slot carries it,
 * every non-source slot is of that vintage: drop them and flag the record for
 * retranslation from the real source slot.
 */
export function stripVolgInventedSlots(job) {
  if (!job || typeof job !== 'object') return job;
  const slots = job.descriptionByLocale && typeof job.descriptionByLocale === 'object' ? job.descriptionByLocale : {};
  const slotsInvented = Object.values(slots).some((text) => isVolgInventedText(text));
  const flatInvented = isVolgInventedText(job.description);
  if (!slotsInvented && !flatInvented) return job;
  const sourceLang = job.sourceLang;
  const sourceText = String(slots[sourceLang] || '').trim();
  const realSource = sourceLang && !isVolgInventedText(sourceText) && meetsSourceBodyFloor(sourceText) ? sourceText : '';
  // The flat `description` is what a grace-retained record publishes: it must
  // be the real source body too (review #10333), or the record goes.
  const flat = flatInvented ? realSource : job.description;
  if (!realSource && (!flat || isVolgInventedText(flat))) return null;
  const kept = realSource ? { [sourceLang]: slots[sourceLang] } : {};
  return { ...job, description: flat, descriptionByLocale: slotsInvented ? kept : slots, needsRetranslation: true };
}

// One pattern for the stored-record scrub (drop-fabricated-description.mjs):
// the listing line or the opening sentence of any retired company paragraph.
export const VOLG_INVENTED_TEXT_RX = new RegExp(
  [VOLG_LISTING_LINE_RX.source, ...VOLG_INVENTED_TEXT_MARKERS.map((marker) => marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))].join('|'),
);

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

// The career center publishes each vacancy under a language-specific path;
// the path is the page's own language declaration. Detecting the language from
// a short title labelled 14/555 postings wrongly (German "Lehrstelle als
// Detailhandelsfachmann/-frau EFZ" as `it`, French "Vendeuse / Vendeur LANDI
// (f/h/d)" as `en`), which filed the source text under a foreign locale.
const DETAIL_PATH_LANG = {
  'offene-stellen': 'de',
  'postes-vacants': 'fr',
  'posti-vacanti': 'it',
};

export function sourceLangFromDetailUrl(url = '') {
  try {
    const [segment] = new URL(String(url || '')).pathname.split('/').filter(Boolean);
    return DETAIL_PATH_LANG[String(segment || '').toLowerCase()] || '';
  } catch {
    return '';
  }
}

export function buildJob(raw) {
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
  const sourceLang = sourceLangFromDetailUrl(url) || detectLang(title, localeFallback);
  const today = new Date().toISOString().slice(0, 10);
  // The listing names only the locality: its CAP comes from the official
  // directory of localities or stays empty for the detail page to fill. A
  // hand-kept city table with canton stand-ins published Reiden (LU) as 5000,
  // the CAP of Aarau, and every unknown Zürich locality as 8000.
  const postalCode = officialLocalityPostalCode(city, canton);
  // No body before the detail page is read: the listing carries only title,
  // employer, place, Pensum and contract, which the enriched body repeats from
  // the page's own facts. A vacancy without a detail body gets none here — see
  // resolveVolgJobBodies().
  const description = '';

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
  // Stored records first lose the text this crawler once invented (slots,
  // translations made from it and the flat description), so nothing merged
  // or retained from them republishes it.
  dropFabricatedDescriptions(targetExisting, VOLG_INVENTED_TEXT_RX, 'Volg/fenaco');
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
    return stripVolgInventedSlots(merged);
  }).filter(Boolean);

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
  volgSummaryCounts.detailDrop = null;
  registerCrawlerSummaryGuard(COMPANY_KEY, 'volg', volgSummaryCounts);
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

  // Keep the same identity used by pagination (same job might appear across pages).
  const seen = new Set();
  const uniqueJobs = allRawJobs.filter((j) => {
    const key = jobMatchKey(j);
    if (!key) throw new Error('Volg listing has no stable identity after pagination');
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

  // Step 2c: Only source text is published. A job without a detail body keeps
  // the text a previous run read from the same vacancy, or waits for a run
  // that reads it.
  const previousJobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isTargetJob);
  const { jobs: sourceBodied, carried, withheld } = resolveVolgJobBodies(jobs, previousJobs);
  if (carried.length > 0) {
    console.warn(`  ⚠️  Detail body unavailable, previous source text kept: ${carried.length} (${carried.join(', ')})`);
  }
  if (withheld.length > 0) {
    console.warn(`  ⚠️  Detail body unavailable and never read before — not published this run: ${withheld.length} (${withheld.join(', ')})`);
  }
  jobs.splice(0, jobs.length, ...sourceBodied);

  // Step 3: Merge into jobs.json
  const { total, added, updated, diff} = mergeJobs(jobs);
  console.log(`\n📦 Merge complete: ${total} total, ${added} added, ${updated} updated`);

  // Step 4: Translate missing locales
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  // No thin-description padding step: every body here is source text that
  // meets the shared source-body word floor (the detail enricher rejects
  // shorter ones and resolveVolgJobBodies() carries only such text); the
  // shared padding helper would append the invented "VOLG è il marchio di
  // prossimità…" paragraph.

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
    ...detailDropSummaryFields(volgSummaryCounts.detailDrop),
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

if (isInvokedDirectly(import.meta.url)) {
  main().catch((err) => exitCrawlerOnError(err, 'Volg / fenaco'));
}
