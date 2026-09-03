#!/usr/bin/env node
/**
 * Constellium Valais job parser — Fetcher and job builder.
 *
 * Source: https://jobs.constellium.com/search/
 *
 * ISSUE #3797 FALSE-NEGATIVE FIX: the previous parser queried a guessed
 * Workday CXS endpoint (`constellium.wd3.myworkdayjobs.com/wday/cxs/...`)
 * that returns HTTP 422 — Constellium is NOT on Workday. The real board is
 * `jobs.constellium.com/search/`, a server-rendered SAP SuccessFactors
 * Jobs2Web career site (confirmed via `j2w.*.js` assets + `rmkcdn.successfactors.com`
 * markers): the listing table (`<tr class="data-row">`, `jobTitle-link`,
 * `jobLocation`, `jobFacility`) and detail pages (schema.org `JobPosting`
 * microdata) are both plain server HTML, no JS/API needed. Pagination via
 * `?startrow=N` (25 rows/page). `jobFacility` on this tenant holds the
 * posting's COUNTRY (e.g. "Switzerland", "Germany"), used as the primary
 * Swiss filter alongside the location text.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllConstelliumJobs()  — Fetch and parse all jobs
 *   - isConstelliumJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace, fetchHtml } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton, rescueSwissCityFromText  } from './target-swiss-locations.mjs';
import { isSuccessFactorsWidgetText, sanitizeSuccessFactorsField } from './successfactors-jobs2web-widget-guard.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const CONSTELLIUM_KEY = 'constellium';
export const CONSTELLIUM_COMPANY_NAME = 'Constellium Valais';
export const CONSTELLIUM_COMPANY_DOMAIN = 'constellium.com';

const CAREER_HOST = 'jobs.constellium.com';
const CAREER_URL = `https://${CAREER_HOST}/search/`;

const PAGE_SIZE = 25;
const MAX_PAGES = 40; // safety cap (40 * 25 = 1000 rows)

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Constellium Valais.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isConstelliumJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === CONSTELLIUM_KEY ||
    key.startsWith('constellium') ||
    company.includes('constellium valais') ||
    url.includes('constellium.com')
  );
}

/**
 * Validate that a URL belongs to Constellium Valais's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'constellium.com' || host.endsWith('.constellium.com');
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
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Jobs2Web listing + detail (server-rendered HTML) ─────── */

/**
 * Check if a listing's location/facility text indicates a Swiss location.
 *
 * Jobs2Web location text is formatted "City, RegionCode, CountryCode" (e.g.
 * "Sierre, Vala, CH" or "Neuf-Brisach, GES, FR"). A trailing 2/3-letter
 * country code, when present, is authoritative and MUST be checked before
 * any fuzzy city-name matching: naive substring checks (e.g. `includes('bern')`
 * matching inside an unrelated foreign place name) risk false positives, and
 * this tenant's `jobFacility` column already gives a full country name for
 * an even more reliable primary signal.
 */
function isSwissLocation(locationsText = '') {
  const loc = normalize(locationsText);
  if (!loc) return false;
  if (loc === 'switzerland' || /\b(schweiz|suisse|svizzera)\b/.test(loc)) return true;
  const parts = loc.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    if (/^[a-z]{2,3}$/.test(last)) {
      return last === 'ch';
    }
  }
  return /\b(sierre|sion|visp|steg|chippis|valais|wallis|zurich|zürich|basel|bern|genev|lausanne|lugano|bellinzona)\b/.test(loc);
}

/**
 * Parse one Jobs2Web search-results page (server-rendered `<tr class="data-row">`
 * table). Returns `{ rows, total }` where `total` is the "Results X to Y of
 * TOTAL" count parsed from the page (0 if not found).
 */
export function parseSearchPage(html = '') {
  const rows = [];
  const blocks = String(html || '').split('<tr class="data-row">').slice(1);
  for (const block of blocks) {
    const titleM = block.match(/class="jobTitle-link">([^<]*)</);
    const hrefM = block.match(/href="([^"]+)"\s*class="jobTitle-link"/);
    // Stop at the first tag, NOT at </span>: multi-location rows append
    // `<small class="nobr">+N more&hellip;</small>` inside the span, so a
    // strict `</span>` boundary yields locationText='' for them (same
    // Jobs2Web-tenant antipattern fixed for benteler in #3893 — live row
    // "Master Planner 100%", Sierre + 1 more, verified 2026-07-11).
    const locM = block.match(/<span class="jobLocation">\s*([^<]*?)\s*</);
    const facM = block.match(/class="jobFacility">([^<]*)</);
    if (!titleM || !hrefM) continue;
    const rowTitle = normalizeSpace(titleM[1]);
    // A row whose anchor text is j2w page chrome (cookie-consent widget,
    // search/alert box) isn't a job at all — discard the row, don't clean it,
    // or it becomes a posting with no title.
    if (isSuccessFactorsWidgetText(rowTitle)) continue;
    rows.push({
      title: rowTitle,
      href: hrefM[1],
      locationText: locM ? normalizeSpace(locM[1]) : '',
      facility: facM ? normalizeSpace(facM[1]) : '',
    });
  }
  const totalM = html.match(/Results\s+\d+\s+to\s+\d+\s+of\s+(\d+)/i);
  return { rows, total: totalM ? Number(totalM[1]) : 0 };
}

/**
 * Fetch every Jobs2Web search-results page, then filter client-side for
 * Swiss locations (using both the `jobFacility` country column and the
 * location text — some tenants only populate one of the two).
 */
async function listSwissJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const allRows = [];
  let startrow = 0;
  let expectedTotal = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${CAREER_URL}?q=&sortColumn=referencedate&sortDirection=desc&startrow=${startrow}`;
    let html;
    try {
      html = await fetchHtml(url, { timeoutMs });
    } catch (err) {
      if (startrow === 0) console.warn(`⚠️ Failed to fetch Jobs2Web listing: ${err.message}`);
      break;
    }
    const { rows, total } = parseSearchPage(html);
    if (page === 0) expectedTotal = total;
    if (rows.length === 0) break;
    allRows.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    if (expectedTotal > 0 && allRows.length >= expectedTotal) break;
    startrow += PAGE_SIZE;
    await new Promise((r) => setTimeout(r, 500));
  }

  const swissRows = allRows.filter(
    (r) => isSwissLocation(r.facility) || isSwissLocation(r.locationText),
  );
  console.log(`  🎯 Filtered ${allRows.length} total → ${swissRows.length} Swiss jobs`);
  return swissRows;
}

/**
 * Fetch and parse a job detail page (schema.org `JobPosting` microdata,
 * server-rendered — no JS needed).
 */
async function fetchJobDetail(href) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const url = href.startsWith('http') ? href : `https://${CAREER_HOST}${href}`;
  let html;
  try {
    html = await fetchHtml(url, { timeoutMs });
  } catch (err) {
    console.warn(`⚠️ Detail fetch failed for ${url}: ${err.message}`);
    return null;
  }

  const addrM = html.match(
    /itemprop="addressLocality" content="([^"]*)"[\s\S]{0,200}?itemprop="addressRegion" content="([^"]*)"[\s\S]{0,200}?itemprop="postalCode" content="([^"]*)"[\s\S]{0,200}?itemprop="addressCountry" content="([^"]*)"/,
  );
  const dateM = html.match(/itemprop="datePosted" content="([^"]*)"/);

  let descriptionHtml = '';
  const startMarker = '<span class="jobdescription">';
  const start = html.indexOf(startMarker);
  if (start !== -1) {
    const from = start + startMarker.length;
    const endMarker = '<p class="job-location">';
    const end = html.indexOf(endMarker, from);
    descriptionHtml = html.slice(from, end !== -1 ? end : from + 20000);
  }

  let postedDate = '';
  if (dateM) {
    const d = new Date(dateM[1]);
    if (!Number.isNaN(d.getTime())) postedDate = d.toISOString().slice(0, 10);
  }

  return {
    addressLocality: addrM ? addrM[1] : '',
    addressRegion: addrM ? addrM[2] : '',
    postalCode: addrM ? addrM[3] : '',
    addressCountry: addrM ? addrM[4] : '',
    postedDate,
    descriptionHtml,
    url,
  };
}

/* ── Location & Canton ────────────────────────────────────── */

/**
 * Parse city name from Workday location text like "CH - Sierre".
 */
function parseWorkdayLocation(locText = '') {
  const cleaned = String(locText || '').trim();
  if (/\d+\s+location/i.test(cleaned)) return '';
  const match = cleaned.match(/-\s*(.+)$/);
  return match ? match[1].trim() : cleaned;
}

function inferCanton(location = '') {
  const canton = inferAnyCanton(location);
  if (canton) return canton;
  const loc = normalize(location);
  if (loc.includes('sierre') || loc.includes('sion') || loc.includes('visp') || loc.includes('viège') || loc.includes('valais')) return 'VS';
  if (loc.includes('zürich') || loc.includes('zurich')) return 'ZH';
  if (loc.includes('basel') || loc.includes('bâle')) return 'BS';
  if (loc.includes('bern') || loc.includes('berne')) return 'BE';
  return 'VS'; // Default to Valais — Constellium's main Swiss site is Sierre
}

/* ── Main Fetch Function ─────────────────────────────────── */

/**
 * Fetch all Constellium Valais Swiss jobs from the Workday API.
 * Returns ParsedJob[] with source-locale fields only.
 */
export async function fetchAllConstelliumJobs() {
  console.log(`🔍 Fetching Constellium Valais jobs from ${CAREER_URL}`);
  console.log(`   Filter: Switzerland (jobFacility country + location text)\n`);

  const listings = await listSwissJobs();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Swiss job listings found on the Jobs2Web board.');
    return [];
  }

  console.log(`  📋 Swiss job listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    if (!listing.href) continue;

    console.log(`  📄 Fetching detail: ${listing.title}`);
    const detail = await fetchJobDetail(listing.href);
    if (!detail) continue;

    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) {
      console.log(`  ⏭️  Skipped — empty title`);
      continue;
    }

    // listSwissJobs() already scoped this listing to Switzerland; a
    // free-text location that failed to parse doesn't mean it's foreign —
    // give it the same second-chance anchor as assemble-jobs-dataset.mjs's
    // canton rescue: a real Swiss city named in the description, falling
    // back to Constellium's documented main Swiss site (Sierre) rather
    // than dropping a listing the API itself already confirmed is Swiss.
    const city = normalizeSpace(detail.addressLocality || parseWorkdayLocation(listing.locationText) || '')
      || rescueSwissCityFromText(stripHtml(detail.descriptionHtml || ''))
      || 'Sierre';

    const canton = inferCanton(`${city} ${detail.addressRegion || ''}`);
    // Detail-page description can also be j2w page chrome (same widget bleed
    // as the title); sanitize before it can fall through to the fallback text.
    const descriptionText = sanitizeSuccessFactorsField(stripHtml(detail.descriptionHtml || ''));
    const publicUrl = detail.url;

    const descText = descriptionText
      ? `${descriptionText}\n\nConstellium Valais SA is a global leader in aluminium products and solutions, with a major rolling and recycling facility in Sierre (Valais), Switzerland. The company serves aerospace, automotive, packaging, and defence markets.`.trim()
      : `${title} position at Constellium Valais in ${city}, Switzerland.\n\nConstellium Valais SA is a global leader in aluminium products and solutions, with a major rolling and recycling facility in Sierre (Valais), Switzerland. The company serves aerospace, automotive, packaging, and defence markets.`.trim();

    const sourceLang = detectLang(descriptionText || title, 'fr');
    const jobSlug = slugify(`${title} constellium ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(title);

    const job = {
      id: `constellium-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CONSTELLIUM_COMPANY_NAME,
      companyKey: CONSTELLIUM_KEY,
      companyDomain: CONSTELLIUM_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descText,
      descriptionByLocale: { [sourceLang]: descText },
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      location: city,
      canton,
      addressLocality: city,
      postalCode: detail.postalCode || '',
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Metallurgia / Alluminio',
      currency: 'CHF',
      featured: false,
      postedDate: detail.postedDate || new Date().toISOString().split('T')[0],
      url: publicUrl,
      applyUrl: publicUrl,
      source: 'Constellium Valais Dedicated Parser (Jobs2Web)',
      sourceLang,
      crawledAt: new Date().toISOString(),
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total unique Constellium Valais jobs discovered: ${jobs.length}`);
  return jobs;
}
