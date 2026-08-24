#!/usr/bin/env node
/**
 * Stadler Rail job parser — Fetcher and job builder.
 *
 * Source: https://careers.stadlerrail.com/search/
 *
 * ATS: SAP SuccessFactors Recruiting Marketing (RMK / jobs2web), backed by
 * hcm55.sapsf.eu. The listing index is server-rendered HTML tiles (25/page,
 * paginated via `?startrow=0,25,50…`). There is NO machine-readable JSON
 * endpoint exposed, so we scrape:
 *   1. Listing pages → collect every `<a class="jobTitle-link" href="/job/…/{id}/">`
 *      anchor. Each slug ends in `…-<CANTON 2-letter>-<x>-<postal>` (free
 *      location signal).
 *   2. Each detail page carries schema.org microdata
 *      (itemprop addressCountry=CH, addressLocality, addressRegion, postalCode,
 *      datePosted, title, description) — used for clean fields.
 *
 * This RMK instance is CH-dedicated: all jobs are Switzerland on-site
 * (Bussnang, Frauenfeld, Wallisellen, Altenrhein, St. Margrethen, Olten).
 * The US portal (stadlerrail.com/en/us/careers) is a SEPARATE instance and is
 * NOT served here, so no extra CH filter is required — we still belt-and-suspenders
 * keep only jobs whose detail microdata reports addressCountry=CH (default CH).
 *
 * Exports the required functions for the crawler template:
 *   - fetchAllStadlerRailJobs()  — Fetch and parse all jobs
 *   - isStadlerRailJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeDescriptionSpace, stripScriptsAndStyles } from './crawler-template.mjs';
import { inferSwissTargetCanton, normalizeCantonCode } from './target-swiss-locations.mjs';
import { rescueHtmlIfChallenged } from './jina-proxy.mjs';
import { isSuccessFactorsWidgetText, sanitizeSuccessFactorsField } from './successfactors-jobs2web-widget-guard.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const STADLER_RAIL_KEY = 'stadler-rail';
export const STADLER_RAIL_COMPANY_NAME = 'Stadler Rail';
export const STADLER_RAIL_COMPANY_DOMAIN = 'stadlerrail.com';

const BASE_URL = 'https://careers.stadlerrail.com';
const SEARCH_URL = `${BASE_URL}/search/`;
const PAGE_SIZE = 25;
const MAX_PAGES = 30; // 188 jobs / 25 ≈ 8 pages; generous cap.

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const SECTOR = 'Rail vehicle manufacturing';

// HQ fallback (Bussnang, Thurgau) per recon.
const HQ_CITY = 'Bussnang';
const HQ_CANTON = 'TG';
const HQ_POSTAL = '9565';
const HQ_REGION = 'Thurgau';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Stadler Rail.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isStadlerRailJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === STADLER_RAIL_KEY ||
    key.startsWith('stadler-rail') ||
    company.includes('stadler rail') ||
    company.includes('stadler') ||
    url.includes('stadlerrail.com')
  );
}

/**
 * Validate that a URL belongs to Stadler Rail's domain or its ATS posting host.
 * Accepts the primary domain (+ subdomains, e.g. careers.stadlerrail.com)
 * plus the SAP SuccessFactors backend hosts that serve the job pages.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'stadlerrail.com' ||
      host.endsWith('.stadlerrail.com') ||
      host.endsWith('.successfactors.eu') ||
      host.endsWith('.successfactors.com') ||
      host.endsWith('.sapsf.eu') ||
      host.endsWith('.sapsf.com')
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur|mechanik|fertig|montage|inbetrieb)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm|ict|devops|sap)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti|berufsbildn)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── HTTP fetch with timeout ──────────────────────────────── */

async function fetchPage(url, timeoutMs, userAgent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.7,it;q=0.5,fr;q=0.4',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    // 200-but-challenge (IP-reputation WAF, cambiavalute class #1363) → Jina.
    return await rescueHtmlIfChallenged(await res.text(), url, { timeoutMs });
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ── Listing page parser ──────────────────────────────────── */

/**
 * Parse the RMK / jobs2web search-results HTML.
 * Each tile links to a detail page at `/job/{slug}/{jobId}/` via an
 * `<a class="jobTitle-link" …>`. The slug encodes the city (leading segment)
 * and the canton/postal (`…-<CANTON>-<x>-<postal>` tail).
 *
 * Returns array of { title, url, jobId, slugCity, canton, postalCode }.
 */
export function parseSearchResults(html) {
  if (!html || typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();

  // Assert the jobTitle-link class via a zero-width lookahead so class/href
  // can appear in either attribute order (a skin reorder must not zero-match).
  const anchorRe =
    /<a(?=[^>]*class="[^"]*jobTitle-link[^"]*")[^>]*href="(\/job\/([^"]+?)\/(\d+)\/?)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const relUrl = m[1].replace(/&amp;/g, '&');
    const slug = m[2];
    const jobId = m[3];
    const title = normalizeSpace(stripHtml(m[4]));
    if (!title || title.length < 3) continue;
    // A `jobTitle-link` anchor carrying page-chrome text (cookie consent, job
    // alert, keyword search) is not a posting — drop the row, don't clean it.
    if (isSuccessFactorsWidgetText(title)) continue;
    if (seen.has(jobId)) continue;
    seen.add(jobId);

    // Slug tail location signal: …-<City>-<Title…>-<CANTON 2-letter>-<x>-<4-digit postal>
    // e.g. Frauenfeld-Systems-Engineer-Elektro-TG-T-8500
    const tail = slug.match(/-([A-Z]{2})-[A-Za-z]-(\d{4})$/);
    const canton = tail ? tail[1] : '';
    const postalCode = tail ? tail[2] : '';
    // The city is the leading slug segment before the first dash.
    const slugCity = normalizeSpace((slug.split('-')[0] || '').replace(/%20/g, ' '));

    out.push({
      title,
      url: `${BASE_URL}${relUrl}`,
      jobId,
      slugCity,
      canton,
      postalCode,
    });
  }
  return out;
}

/* ── Detail page parser ──────────────────────────────────── */

function getMicrodataContent(html, prop) {
  // <span itemprop="addressLocality" content="Frauenfeld">  OR
  // <... itemprop="datePosted" content="...">
  const re = new RegExp(
    `itemprop="${prop}"[^>]*content="([^"]*)"`,
    'i'
  );
  const m = html.match(re);
  return m ? normalizeSpace(m[1].replace(/&amp;/g, '&')) : '';
}

/**
 * Parse a Stadler Rail RMK detail page. The page carries schema.org microdata:
 *   <h1 itemprop="title">…</h1>
 *   itemprop="addressLocality|addressRegion|postalCode|addressCountry" content="…"
 *   itemprop="datePosted" content="Wed Jun 10 02:00:00 UTC 2026"
 *   <... itemprop="description" class="jobdescription">…</...>
 *
 * Returns { title, description, addressLocality, addressRegion, postalCode,
 *           addressCountry, postedDate } or null.
 */
export function parseDetailPage(html) {
  if (!html || typeof html !== 'string') return null;

  const titleSource = stripScriptsAndStyles(html);
  const titleMatch =
    titleSource.match(/<h1[^>]*itemprop="title"[^>]*>([\s\S]*?)<\/h1>/i) ||
    titleSource.match(/<h1[^>]*id="job-title"[^>]*>([\s\S]*?)<\/h1>/i) ||
    titleSource.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  // '' here makes fetchAll's `detail?.title || listing.title` fall back to the
  // authoritative listing-row title instead of publishing widget chrome.
  const title = sanitizeSuccessFactorsField(
    titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '',
  );

  const addressLocality = getMicrodataContent(html, 'addressLocality');
  // addressRegion in microdata is the canton-prefixed code, e.g. "TG T" — keep
  // the leading 2-letter canton only for region/canton inference.
  const rawRegion = getMicrodataContent(html, 'addressRegion');
  const postalCode = getMicrodataContent(html, 'postalCode');
  const addressCountry = getMicrodataContent(html, 'addressCountry') || 'CH';
  const rawDate = getMicrodataContent(html, 'datePosted');
  const postedDate = parseDetailDate(rawDate);

  // Description: itemprop="description" class="jobdescription"
  let descriptionHtml = '';
  const descAnchor = html.search(/itemprop="description"[^>]*>/i);
  if (descAnchor !== -1) {
    const openTag = html.slice(descAnchor).match(/itemprop="description"[^>]*>/i);
    const start = descAnchor + (openTag ? openTag[0].length : 0);
    const slice = html.slice(start);
    // Stop at the apply/footer region or the closing of the description container.
    const endMarker = slice.search(
      /<div[^>]*class="[^"]*(?:apply|jobapply|jobAction|btn-apply|formButtonBar)/i
    );
    descriptionHtml = endMarker !== -1 ? slice.slice(0, endMarker) : slice.slice(0, 20000);
  }
  let description = normalizeDescriptionSpace(stripHtml(descriptionHtml));

  // Reject SF widget garbage that occasionally bleeds in.
  description = sanitizeSuccessFactorsField(description);

  return {
    title,
    description,
    addressLocality,
    addressRegion: rawRegion,
    postalCode,
    addressCountry: (addressCountry || 'CH').toUpperCase().slice(0, 2),
    postedDate,
  };
}

/**
 * Parse the RMK microdata datePosted, e.g. "Wed Jun 10 02:00:00 UTC 2026".
 * Returns ISO `YYYY-MM-DD` or null.
 */
function parseDetailDate(raw = '') {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/* ── Fallback description ─────────────────────────────────── */

function buildFallbackDescription(title, location) {
  return `${title} bei Stadler Rail in ${location || 'der Schweiz'}.\n\nStadler ist ein weltweit tätiger Schweizer Hersteller von Schienenfahrzeugen mit Hauptsitz in Bussnang (Kanton Thurgau). Das 1942 gegründete Unternehmen entwickelt und produziert Voll-, Regional- und S-Bahnen, Strassenbahnen, Lokomotiven sowie Zahnradbahnen und beschäftigt mehrere tausend Mitarbeitende in der Schweiz. Stadler bietet ein modernes Arbeitsumfeld, attraktive Anstellungsbedingungen und vielfältige Entwicklungsmöglichkeiten in einem innovativen Schweizer Industrieunternehmen.`;
}

/* ── Fetch listings ───────────────────────────────────────── */

/**
 * Scrape every listing tile across the paginated RMK search index.
 * Returns array of raw listing objects.
 */
async function fetchJobListings() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const userAgent = process.env.JOBS_CRAWLER_USER_AGENT || DEFAULT_USER_AGENT;

  const all = [];
  const seenIds = new Set();
  let startrow = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${SEARCH_URL}?q=&startrow=${startrow}`;
    console.log(`  📄 Fetching search page at startrow=${startrow}...`);
    let html;
    try {
      html = await fetchPage(url, timeoutMs, userAgent);
    } catch (err) {
      if (startrow === 0) {
        throw new Error(`Failed to fetch search page: ${err?.message || err}`);
      }
      console.warn(`  ⚠️ Pagination fetch failed at startrow=${startrow}, stopping.`);
      break;
    }
    const listings = parseSearchResults(html);
    if (listings.length === 0) break;

    let added = 0;
    for (const l of listings) {
      if (seenIds.has(l.jobId)) continue;
      seenIds.add(l.jobId);
      all.push(l);
      added += 1;
    }
    // No new jobs on this page → we've reached the end (RMK clamps startrow).
    if (added === 0) break;
    if (listings.length < PAGE_SIZE) break;

    startrow += PAGE_SIZE;
    await new Promise((r) => setTimeout(r, 500));
  }
  return all;
}

/**
 * Fetch all Stadler Rail jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllStadlerRailJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const userAgent = process.env.JOBS_CRAWLER_USER_AGENT || DEFAULT_USER_AGENT;

  console.log(`🔍 Fetching Stadler Rail jobs`);
  console.log(`   Source: ${SEARCH_URL} (SAP SuccessFactors RMK / jobs2web)\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}\n`);

  const jobs = [];
  for (const listing of listings) {
    let detail = null;
    try {
      const detailHtml = await fetchPage(listing.url, timeoutMs, userAgent);
      detail = parseDetailPage(detailHtml);
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${listing.title}: ${err?.message || err}`);
    }

    // CH-only guard (belt-and-suspenders; whole instance is CH already).
    const country = (detail?.addressCountry || 'CH').toUpperCase();
    if (country && country !== 'CH') continue;

    const title = normalizeSpace(detail?.title || listing.title);
    if (!title || title.length < 3) continue;

    const location =
      detail?.addressLocality || listing.slugCity || HQ_CITY;
    const canton =
      inferSwissTargetCanton(location) ||
      normalizeCantonCode(listing.canton || '') ||
      inferSwissTargetCanton(detail?.addressRegion || '') ||
      HQ_CANTON;
    const postalCode = detail?.postalCode || listing.postalCode || HQ_POSTAL;
    const addressRegion = inferSwissTargetCanton(location) === HQ_CANTON || canton === HQ_CANTON
      ? HQ_REGION
      : (detail?.addressRegion || '').split(/\s+/)[0] || '';

    let description = '';
    if (detail?.description && detail.description.split(/\s+/).length >= 50) {
      description = detail.description;
    } else {
      description = buildFallbackDescription(title, location);
    }

    const sourceLang = detectLang(description || title, 'de');
    const publicUrl = listing.url;
    const jobSlug = slugify(`${title} stadler-rail ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const postedDate =
      detail?.postedDate || new Date().toISOString().slice(0, 10);

    const job = {
      // ── Required fields ──
      id: `stadler-rail-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: STADLER_RAIL_COMPANY_NAME,
      companyKey: STADLER_RAIL_KEY,
      companyDomain: STADLER_RAIL_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Stadler Rail Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      postalCode,
      addressRegion: addressRegion || undefined,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(`${title} ${description}`),
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 250)); // Rate limiting
  }

  console.log(`\n📋 Total Stadler Rail jobs discovered: ${jobs.length}`);
  return jobs;
}

// Re-export shared helpers for parser-consumer convenience.
export { slugify, stripHtml };
