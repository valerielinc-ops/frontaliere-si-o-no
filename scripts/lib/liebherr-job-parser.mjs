#!/usr/bin/env node
/**
 * Liebherr job parser — SAP SuccessFactors / jobs2web careers portal.
 *
 * Source (canonical, scrapable): https://careers.liebherr.com/search/?locationsearch=Switzerland
 *
 * STATUS (2026-06-10):
 *   The "official" career5.successfactors.eu/career?company=LiMySLive instance
 *   is a SAPUI5 `surj` SPA and its JSON API
 *   (POST /services/recruiting/v1/jobs) returns HTTP 403 to any non-browser
 *   client — it requires the in-page minted x-ajax-token + session cookies, so
 *   it cannot be scraped server-side.
 *
 *   However, the surj job-search entry point (`portalcareer?company=LiMySLive`)
 *   302-redirects to a STANDARD jobs2web careers portal at
 *   `https://careers.liebherr.com/search`. That portal is server-rendered
 *   plain HTML (no anti-bot, no JS required): `<li class="job-tile job-id-{id}"
 *   data-url="/job/{slug}/{id}/">` rows carrying title (`.jobTitle-link`) and
 *   a `…section-location-value">{City}, CH<` cell. Adding
 *   `?locationsearch=Switzerland` applies the server-side Switzerland filter
 *   (~87 CH jobs across all Swiss Liebherr entities — Bulle FR, Nussbaumen AG,
 *   Reiden LU, Daillens VD, Baden AG — which all recruit through this one
 *   tenant). Pagination is `startrow += 25`.
 *
 *   The detail pages (`/job/{slug}/{id}/`) ARE server-rendered plain HTML on
 *   `careers.liebherr.com` (verified 2026-06-11: the page carries the full job
 *   body in an `itemprop="description"` schema.org/JobPosting microdata block,
 *   ~2.5k chars / ~385 words). We fetch each detail page to recover the REAL
 *   description (the previous title-only stub failed the assemble
 *   boilerplate-guard, #1722). Falls back to a brand blurb on fetch failure;
 *   the AI-localization pipeline enriches locales.
 *
 * Liebherr Swiss HQ: Rue Hans-Liebherr 7, 1630 Bulle (FR) — default canton when
 * location extraction can't resolve one.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllLiebherrJobs()  — Fetch and parse all jobs
 *   - isLiebherrJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()       — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { extractMicrodataDescription } from './jobposting-jsonld.mjs';
import { isSuccessFactorsWidgetText, sanitizeSuccessFactorsField } from './successfactors-jobs2web-widget-guard.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const LIEBHERR_KEY = 'liebherr';
export const LIEBHERR_COMPANY_NAME = 'Liebherr';
export const LIEBHERR_COMPANY_DOMAIN = 'liebherr.com';

const LIEBHERR_SECTOR =
  'Manufacturing / Machinery (construction equipment, engines, hydraulics, aerospace, refrigeration)';

/** jobs2web careers portal — the scrapable, server-rendered source. */
const CAREERS_HOST = 'careers.liebherr.com';
const SEARCH_URL = `https://${CAREERS_HOST}/search/?q=&locationsearch=Switzerland`;
const PAGE_SIZE = 25;
const MAX_PAGES = 20; // 20 × 25 = 500 cap (only ~87 CH jobs as of 2026-06).

/** Realistic browser UA — jobs2web is permissive but bot UAs occasionally 403. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s = '') {
  return String(s || '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Liebherr (covers all Swiss Liebherr entities:
 * Liebherr Machines Bulle SA, Liebherr-Aerospace, Liebherr Components
 * Nussbaumen, Liebherr-Export Reiden, Liebherr-Transportation/Daillens —
 * they all recruit through the same SuccessFactors tenant).
 */
export function isLiebherrJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === LIEBHERR_KEY ||
    key.startsWith('liebherr') ||
    company.includes('liebherr') ||
    url.includes('liebherr.com') ||
    url.includes('company=limyslive')
  );
}

/**
 * Validate that a URL belongs to Liebherr's domain or its ATS hosts.
 * The public apply destination is the jobs2web portal
 * `careers.liebherr.com` (a liebherr.com subdomain). The original
 * SuccessFactors tenant lives on `*.successfactors.eu` with
 * `company=LiMySLive` — first-party for our trust model since it is the
 * canonical apply origin.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host === 'liebherr.com' || host.endsWith('.liebherr.com')) return true;
    if (host.endsWith('.successfactors.eu') || host.endsWith('.successfactors.com')) {
      return /company=limyslive/i.test(url.search);
    }
    return false;
  } catch {
    return false;
  }
}

/* ── Category / level / type detection ─────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl|ing[eé]nieur|konstrukt)/.test(t)) return 'Ingegneria';
  if (/\b(it|software|develop|programm|data|cloud|cyber|devops|security)/.test(t)) return 'IT';
  if (/\b(techni|tecnic|m[eé]canic|mechanic|elektr|install|wartung|maintenance|monteur)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account|sachbearbeit|assistant)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce|commercial|vente)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse|supply|douani|tarification)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur|fertigung|production|usinage)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(hr|human|risorse|personal|talent|recruit|ressources humaines)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz|communication|brand)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ|controll|tax)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht|juridique|compliance)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti|trainee|graduate)/.test(t)) return 'intern';
  if (/\b(junior|jr)\b/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|leitung)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|praktik)/.test(t)) return 'INTERN';
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(tempor|befristet|fixed.?term|cdd|temporaire)/.test(t)) return 'CONTRACTOR';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── jobs2web listing parser ───────────────────────────────── */

/**
 * @typedef {Object} LiebherrListing
 * @property {string} title
 * @property {string} location   Raw location cell, e.g. "Bulle, CH".
 * @property {string} url        Absolute detail URL.
 * @property {string} jobReqId   Numeric jobs2web job id.
 */

/**
 * Parse one jobs2web search-results page into listing rows.
 * Each job is a `<li class="job-tile job-id-{id}" data-url="/job/{slug}/{id}/">`
 * carrying the title in `<a class="jobTitle-link" …>{Title}</a>` and the
 * location in `…section-location-value">{City}, CH</…>`.
 *
 * @param {string} html
 * @returns {LiebherrListing[]}
 */
function parseSearchPage(html = '') {
  if (!html) return [];
  const out = [];
  const tileRe = /<li class="job-tile job-id-(\d+)[^"]*"[^>]*data-url="([^"]+)"[\s\S]*?(?=<li class="job-tile job-id-|<\/ul>|$)/gi;
  let m;
  while ((m = tileRe.exec(html)) !== null) {
    const jobReqId = m[1];
    const dataUrl = decodeEntities(m[2]);
    const block = m[0];

    const titleMatch =
      block.match(/<a[^>]*class="jobTitle-link[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ||
      block.match(/<a[^>]*href="[^"]*\/job\/[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const title = titleMatch
      ? normalizeSpace(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, ' ')))
      : '';
    if (!title || title.length < 3) continue;
    // The generic-anchor fallback above (no jobTitle-link on this tenant skin)
    // can pick up the j2w cookie-consent/keyword-search/job-alert widget as if
    // it were a job tile. A row whose title IS that widget chrome is not a
    // posting — discard it rather than clean it (a cleaned title would leave
    // an anonymous job).
    if (isSuccessFactorsWidgetText(title)) continue;

    // The location VALUE node ends `…location-value">{City}, CH<`. A separate
    // label span carries `aria-describedby="…location-value"` followed by
    // `class=…` — so we require the closing `">` immediately after
    // `location-value` to skip the label and grab the value.
    const locMatch = block.match(/section-location-value">([^<]+)</i);
    const location = locMatch ? normalizeSpace(decodeEntities(locMatch[1])) : '';

    const url = dataUrl.startsWith('http')
      ? dataUrl
      : `https://${CAREERS_HOST}${dataUrl.startsWith('/') ? '' : '/'}${dataUrl}`;

    out.push({ title, location, url, jobReqId });
  }
  return out;
}

/**
 * Fetch every Switzerland-filtered listing row across all result pages.
 * @returns {Promise<LiebherrListing[]>}
 */
async function fetchJobListings() {
  const seen = new Set();
  const listings = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const startrow = page * PAGE_SIZE;
    const pageUrl = startrow > 0 ? `${SEARCH_URL}&startrow=${startrow}` : SEARCH_URL;

    let html;
    try {
      html = await fetchHtml(pageUrl, { headers: { 'User-Agent': USER_AGENT } });
    } catch (err) {
      console.warn(`⚠️ Listing fetch failed (startrow=${startrow}): ${err?.message || err}`);
      break;
    }

    const rows = parseSearchPage(html);
    if (rows.length === 0) break;

    let added = 0;
    for (const row of rows) {
      if (seen.has(row.jobReqId)) continue;
      seen.add(row.jobReqId);
      listings.push(row);
      added++;
    }
    // Last page (partial) or no new rows → stop paginating.
    if (rows.length < PAGE_SIZE || added === 0) break;

    await new Promise((r) => setTimeout(r, 500)); // polite delay
  }

  return listings;
}

/* ── Job assembly ──────────────────────────────────────────── */

/**
 * Fetch the full job-body description from a Liebherr jobs2web detail page.
 * The page is server-rendered plain HTML carrying the body in an
 * `itemprop="description"` schema.org/JobPosting microdata block. Returns the
 * inner HTML (caller strips tags) or '' on any failure → caller falls back to
 * a brand blurb. fetchHtml follows the 302 to the canonical detail URL.
 */
async function fetchLiebherrDetailDescription(url) {
  if (!url || !/^https?:\/\//.test(url)) return '';
  try {
    const html = await fetchHtml(url, {
      timeoutMs: 15000,
      headers: { 'User-Agent': USER_AGENT },
    });
    return extractMicrodataDescription(html);
  } catch {
    return ''; // network/timeout → caller falls back to the brand blurb
  }
}

/**
 * Fetch all Liebherr jobs.
 * Returns an array of ParsedJob objects (source-locale only). Other locales
 * are filled by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllLiebherrJobs() {
  console.log(`🔍 Fetching Liebherr jobs (CH-wide via jobs2web careers portal)`);
  console.log(`   Source: ${SEARCH_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    // Location cell is "City, CH" — keep the city as the human-facing locality.
    const rawLocation = normalizeSpace(listing.location || '');
    const city = (rawLocation.split(',')[0] || '').trim() || 'Bulle';
    const canton =
      inferSwissTargetCanton(rawLocation) ||
      inferSwissTargetCanton(city) ||
      'FR'; // HQ canton (Bulle, Fribourg)

    const publicUrl = listing.url || SEARCH_URL;
    // The jobs2web detail page is server-rendered: recover the REAL job body
    // from the itemprop="description" microdata block. Fall back to a brand
    // blurb on any fetch failure (fail-per-record, never fake content). This
    // replaces the previous title-only stub that 100%-failed the boilerplate
    // guard (#1722).
    const detailDescHtml = await fetchLiebherrDetailDescription(publicUrl);
    // Detail page can itself surface widget chrome as the "description" body
    // (same class of bleed as the title) — sanitize before falling back to
    // the brand blurb.
    const detailDescText = detailDescHtml
      ? sanitizeSuccessFactorsField(normalizeSpace(stripHtml(detailDescHtml)))
      : '';
    const descriptionText = detailDescText || `${title} — Liebherr (${city}, CH)`;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} liebherr ${city}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `liebherr-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: LIEBHERR_COMPANY_NAME,
      companyKey: LIEBHERR_KEY,
      companyDomain: LIEBHERR_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location: city,
      canton,
      url: publicUrl,
      source: 'Liebherr Dedicated Parser (jobs2web)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(title),
      experienceLevel: detectExperienceLevel(title),
      sector: LIEBHERR_SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      jobReqId: listing.jobReqId || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Liebherr jobs discovered: ${jobs.length}`);
  return jobs;
}

export { slugify, stripHtml };
