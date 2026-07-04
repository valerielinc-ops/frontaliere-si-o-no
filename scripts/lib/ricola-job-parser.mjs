#!/usr/bin/env node
/**
 * Ricola job parser — Fetcher + job builder.
 *
 * Source: https://www.ricola.com/it-it/chi-siamo/carriera/posizioni-aperte/
 * embeds a public Umantis (Haufe-Umantis) job board via `<iframe>` at:
 *   https://career.ricola.com/Jobs/2?lang=eng
 *
 * `career.ricola.com` is a CNAME onto the raw Umantis tenant
 * `recruitingapp-2747.umantis.com` (verified via `dig`/direct fetch — both
 * hosts return byte-identical listing/detail markup). We fetch the custom
 * domain directly; no Cloudflare/anti-bot fence observed (plain `fetch()`
 * returns full server-rendered HTML, verified 2026-07-04).
 *
 * Listing markup is Umantis' "older UI" generation (`tr.tableaslist_contentrow1|2`,
 * `a.HSTableLinkSubTitle` title link, pipe-separated `tableaslist_subtitle` spans
 * for metadata) — same family as `bobst-job-parser.mjs`, but Ricola's tenant
 * labels metadata in English ("Type:", "Employment period:") rather than the
 * German labels ("Art:", "Befristung:", "Unternehmensbereich:") the shared
 * `umantis-listing-common.mjs` factory expects, and this tenant's category
 * defaults there are hospital-oriented (factory built for the Swiss-hospital
 * Umantis wave). Neither the shared factory nor the Bobst Playwright-driven
 * scraper fit cleanly, so this is a bespoke fetch()-based parser reusing only
 * the generic low-level helpers (`fetchHtml`, `stripHtml`, `slugify`,
 * `detectLang`, `inferSwissTargetCanton`).
 *
 * Detail pages (`/Vacancies/{id}/Description/{n}`) use a bespoke Ricola
 * template (`h1.jobTitle`, `h2.title__small` section headers, `<p>`/`<ul><li>`
 * prose) — NOT the `customdatablock` markup `extractUmantisDetailContent()`
 * expects, and NOT chrome-heavy enough to need its prose-fallback heuristics.
 * Critically, the detail page ends with a `<p class="contact
 * ricola-regular">` block naming a real recruiter (name + direct-dial phone +
 * personal email) — this MUST be excluded from the scraped description (PII;
 * same class of issue as the 2026-06-05 Allianz erasure request). The
 * generic "we only accept online applications" notice uses a different class
 * combo (`…"applyNote"`) and carries no personal data, so it survives.
 *
 * Pagination: `?tc66856=p{n}` (Umantis table id `66856`, stable across
 * requests/langs) — walked until an empty page or until we hit the same
 * first-job-id seen on page 1 (Umantis wraps past the last page back to p1).
 * Currently only 1 vacancy is published; the loop is still generic so it
 * keeps working as headcount grows.
 *
 * HQ: Ricola Group AG, Baselstrasse 31, 4242 Laufen (BL). Verified via the
 * company's own Impressum (ricola.com/it-it/chi-siamo/impressum/) AND
 * cross-checked against the Swiss commercial register (Zefix: "Ricola Group
 * AG", legalSeat "Laufen", UID CHE-439.050.235).
 *
 * Exports 4 functions per crawler template:
 * - fetchAllRicolaJobs() — Fetch + parse jobs
 * - isRicolaJob()        — Match jobs belonging to this company
 * - isTrustedDomain()    — Validate URLs belong to this company
 * - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang, decodeHtmlEntities, decodeNumericEntities, normalizeSpace as normalizeSpaceDCC } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ────────────────────────────────────────────── */

export const RICOLA_KEY = 'ricola';
export const RICOLA_COMPANY_NAME = 'Ricola';
export const RICOLA_COMPANY_DOMAIN = 'ricola.com';

const CAREER_URL = 'https://www.ricola.com/it-it/chi-siamo/carriera/posizioni-aperte/';
// Umantis embed (custom domain CNAME onto recruitingapp-2747.umantis.com).
const UMANTIS_BASE = 'https://career.ricola.com';
const UMANTIS_LISTING_URL = `${UMANTIS_BASE}/Jobs/2?lang=eng`;
const UMANTIS_TABLE_PARAM = 'tc66856';

// HQ: Baselstrasse 31, 4242 Laufen BL (Impressum + Zefix, see module docblock).
const HQ = {
  city: 'Laufen',
  canton: 'BL',
  postalCode: '4242',
  streetAddress: 'Baselstrasse 31',
  region: 'Basel-Landschaft',
};

const SECTOR = 'Industria alimentare / Dolciumi';

// <tr class="tableaslist_contentrow1|2"> = one vacancy row. Title link is
// `a.HSTableLinkSubTitle`; metadata (Type/Employment period/location) rides
// in sibling `tableaslist_subtitle` spans prefixed with a leading "|".
const ROW_RX = /<tr class="tableaslist_contentrow[12]">([\s\S]*?)<\/tr>/gi;
const TITLE_LINK_RX = /<a\s+[^>]*href="(\/Vacancies\/(\d+)\/Description\/\d+)"[^>]*>([^<]+)<\/a>/i;

const PAGE_LIMIT = 30; // Hard cap on pagination loops (~300 jobs)
const ROW_HARD_CAP = 300;

/* ── Helpers ──────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return normalizeSpaceDCC(s);
}

function decodeEntities(s = '') {
  return decodeNumericEntities(decodeHtmlEntities(s));
}

/* ── Company Matchers ─────────────────────────────────────── */

export function isRicolaJob(job) {
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');
  if (!job) return false;
  return (
    key === RICOLA_KEY ||
    company === 'ricola' ||
    company.includes('ricola') ||
    url.includes('ricola.com') ||
    url.includes('career.ricola.com') ||
    url.includes('recruitingapp-2747.umantis.com')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'ricola.com' ||
      host.endsWith('.ricola.com') ||
      host === 'recruitingapp-2747.umantis.com'
    );
  } catch {
    return false;
  }
}

/* ── Category / Experience / Employment Detection ────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(admin|segret|contab|buchhalt|account|finan)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce|export)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse|supply chain|einkauf|acquist)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur|packaging|imballagg)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm|informatik)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz|brand)/.test(t)) return 'Marketing';
  if (/\b(ingegner|engineer|entwickl|technic|tecnic)/.test(t)) return 'Ingegneria';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
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

/* ── Address Resolution ──────────────────────────────────────
 * CRITICAL correctness rule (see AGENTS.md / staubli-job-parser.mjs
 * precedent): HQ-fallback for street/postal code is gated on the job's
 * resolved CITY TEXT matching via regex — NEVER on canton alone. A job
 * genuinely posted in a different BL town must not inherit the Laufen HQ
 * street address just because it shares a canton.
 */
function resolveAddress(rawLocation = '') {
  const city = normalizeSpace(rawLocation) || HQ.city;
  const isHqCity = /\blaufen\b/i.test(city);
  return {
    city,
    postalCode: isHqCity ? HQ.postalCode : '',
    streetAddress: isHqCity ? HQ.streetAddress : '',
  };
}

/* ── Listing Row Parsing ──────────────────────────────────── */

/**
 * Parse the pipe-separated metadata segments trailing the title inside a
 * listing row's flattened text, e.g.:
 *   "Accounting Specialist | Type: Full time | Employment period: unlimited | Laufen"
 */
export function parseRowMetadata(cellText = '', title = '') {
  const out = { location: '', employmentType: '', contractTerm: '' };
  if (!cellText) return out;

  let rest = cellText;
  const idx = title ? rest.indexOf(title) : -1;
  if (idx >= 0) rest = rest.slice(idx + title.length);

  const segments = rest
    .split('|')
    .map((s) => normalizeSpace(s))
    .filter(Boolean);

  for (const seg of segments) {
    const lower = seg.toLowerCase();
    if (lower.startsWith('type:')) {
      out.employmentType = normalizeSpace(seg.slice('type:'.length));
    } else if (lower.startsWith('employment period:')) {
      out.contractTerm = normalizeSpace(seg.slice('employment period:'.length));
    } else if (
      // Bare segment (no "key:" prefix) that looks like a place name.
      !seg.includes(':') &&
      seg.length >= 2 &&
      seg.length <= 80 &&
      !out.location
    ) {
      out.location = seg;
    }
  }
  return out;
}

/** Build the Umantis pagination URL for page N, preserving lang. */
export function buildPageUrl(pageIdx) {
  if (pageIdx <= 1) return UMANTIS_LISTING_URL;
  return `${UMANTIS_LISTING_URL}&${UMANTIS_TABLE_PARAM}=p${pageIdx}`;
}

/** Resolve a relative Umantis href to an absolute career.ricola.com URL. */
export function resolveDetailUrl(rawHref = '') {
  if (!rawHref) return UMANTIS_LISTING_URL;
  try {
    return new URL(rawHref, UMANTIS_BASE).toString();
  } catch {
    return UMANTIS_LISTING_URL;
  }
}

/** Extract vacancy rows from one listing-page HTML document. */
export function extractListingRows(html = '') {
  const out = [];
  let m;
  ROW_RX.lastIndex = 0;
  while ((m = ROW_RX.exec(html))) {
    const rowHtml = m[1];
    const linkMatch = rowHtml.match(TITLE_LINK_RX);
    if (!linkMatch) continue;
    const href = linkMatch[1];
    const vacancyId = linkMatch[2];
    const title = normalizeSpace(decodeEntities(linkMatch[3]));
    if (!title || title.length < 3) continue;
    const cellText = normalizeSpace(decodeEntities(stripHtml(rowHtml)));
    out.push({ vacancyId, title, href, cellText });
  }
  return out;
}

/**
 * Fetch + paginate the Umantis listing until an empty page or a
 * wrap-around (Umantis loops back to page 1 once N exceeds the total).
 */
async function fetchJobListings(options = {}) {
  const fetchPage = options._fetchHtml || fetchHtml;
  const out = [];
  const seenIds = new Set();
  let firstPageFirstId = null;

  for (let pageIdx = 1; pageIdx <= PAGE_LIMIT; pageIdx += 1) {
    let html;
    try {
      html = await fetchPage(buildPageUrl(pageIdx));
    } catch (err) {
      console.warn(`  ⚠️ Ricola: fetch failed on page ${pageIdx} (${err?.message || err}). Stopping pagination.`);
      break;
    }

    const rows = extractListingRows(html);
    if (rows.length === 0) break;

    const pageFirstId = rows[0].vacancyId;
    if (pageIdx === 1) {
      firstPageFirstId = pageFirstId;
    } else if (firstPageFirstId && pageFirstId === firstPageFirstId) {
      break; // Umantis wrapped back to page 1.
    }

    let newRowsThisPage = 0;
    for (const row of rows) {
      if (seenIds.has(row.vacancyId)) continue;
      seenIds.add(row.vacancyId);
      newRowsThisPage += 1;

      const meta = parseRowMetadata(row.cellText, row.title);
      out.push({
        vacancyId: row.vacancyId,
        title: row.title,
        location: meta.location,
        url: resolveDetailUrl(row.href),
        employmentType: meta.employmentType,
        contractTerm: meta.contractTerm,
      });

      if (out.length >= ROW_HARD_CAP) return out;
    }

    if (newRowsThisPage === 0) break; // Nothing new — avoid infinite loop.
  }

  return out;
}

/* ── Detail Page Extraction ───────────────────────────────── */

/**
 * Extract rich prose from a Ricola/Umantis detail page, structurally
 * excluding the recruiter contact PII block (name + direct-dial phone +
 * personal email) before the generic `stripHtml()` helper converts the
 * remainder to plain text with preserved bullet lists.
 */
export function extractRicolaDetailContent(html) {
  if (!html || typeof html !== 'string') return '';

  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Drop the "Contact" heading + the structured name/city/direct-phone/email
  // paragraph. The generic "we only accept online applications" notice uses
  // a DIFFERENT class combo (…"applyNote") and carries no personal data, so
  // it is NOT matched here and survives in the extracted text.
  body = body.replace(
    /<h2[^>]*>\s*Contact\s*<\/h2>\s*<p class="contact ricola-regular">[\s\S]*?<\/p>/gi,
    '',
  );

  // Drop the footer chrome row (LinkedIn widget + company logo image) —
  // boilerplate, not job content.
  body = body.replace(/<div class="row row__footer">[\s\S]*?<\/div>\s*<\/div>/gi, '');

  return stripHtml(body);
}

/**
 * Fetch one Umantis detail page and return validated prose content, or ''
 * on any failure (caller falls back to listing-derived boilerplate).
 */
async function fetchDetailContent(detailUrl, options = {}) {
  const fetchPage = options._fetchHtml || fetchHtml;
  try {
    const html = await fetchPage(detailUrl);
    return extractRicolaDetailContent(html);
  } catch (err) {
    console.warn(`  ⚠️ Ricola: detail fetch failed for ${detailUrl} (${err?.message || err}).`);
    return '';
  }
}

/* ── Public API ───────────────────────────────────────────── */

// Internal export for test injection — not part of the public crawler contract.
export const __testables = {
  fetchJobListings,
  fetchDetailContent,
  buildPageUrl,
  resolveDetailUrl,
  parseRowMetadata,
  extractListingRows,
  resolveAddress,
  UMANTIS_LISTING_URL,
  UMANTIS_BASE,
};

/**
 * Fetch all Ricola jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled by the
 * shared AI-localization step / translate-pending pipeline.
 */
export async function fetchAllRicolaJobs(options = {}) {
  console.log(`🔍 Fetching ${RICOLA_COMPANY_NAME} jobs`);
  console.log(`   Source: ${UMANTIS_LISTING_URL}\n`);

  const listings = await fetchJobListings(options);
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const { city, postalCode, streetAddress } = resolveAddress(listing.location);
    const canton = inferSwissTargetCanton(city) || HQ.canton;

    const detailContent = await fetchDetailContent(listing.url, options);

    const meta = [];
    if (listing.employmentType) meta.push(`Type: ${listing.employmentType}`);
    if (listing.contractTerm) meta.push(`Employment period: ${listing.contractTerm}`);
    const metaLine = meta.length > 0 ? `\n\n${meta.join('. ')}.` : '';

    const descriptionText = detailContent
      ? `${detailContent}${metaLine}`
      : [
          `${title} at ${RICOLA_COMPANY_NAME}, ${city}${canton ? ` (${canton} canton)` : ''}, Switzerland.`,
          `${RICOLA_COMPANY_NAME} is a Swiss herbal-candy manufacturer headquartered in Laufen (BL).`,
          `Apply via the Ricola careers portal.${metaLine}`,
        ].join(' ');

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} ricola ch`);
    const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(listing.employmentType || title);

    const job = {
      // ── Required fields
      id: `${RICOLA_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: RICOLA_COMPANY_NAME,
      companyKey: RICOLA_KEY,
      companyDomain: RICOLA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      // Newly-discovered jobs ship source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band.
      needsRetranslation: true,
      location: city,
      canton,
      url: listing.url,
      source: `${RICOLA_COMPANY_NAME} Dedicated Parser (Umantis listing tenant 2747)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields (structured-data completeness, Non-Negotiable #3)
      addressLocality: city,
      addressRegion: canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: /limited|befristet|temporary/i.test(listing.contractTerm || '') ? 'temporary' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().slice(0, 10),
      applyUrl: listing.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${RICOLA_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
