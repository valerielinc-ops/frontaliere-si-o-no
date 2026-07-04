#!/usr/bin/env node
/**
 * SFS Group job parser — AEM career portal (join.sfs.com) + Umantis apply flow.
 *
 * ATS investigation (issue #3337 lists this company's ATS as "Custom" — that
 * label is WRONG, refuted below):
 *
 *   - The apply flow (`jobapplication.sfs.com/Vacancies/{id}/Application/...`)
 *     literally serves `<meta name="ATS" content="Abacus-Umantis">` in its
 *     HTML head, plus the classic CGI-era Umantis cookies (`CGISESSID`,
 *     `CompanyID`, `ExternalDesignID`). This IS Umantis (Haufe-Umantis /
 *     Abacus-Umantis), same family as scripts/lib/bobst-job-parser.mjs and
 *     scripts/lib/hoval-job-parser.mjs.
 *   - HOWEVER the raw Umantis listing endpoint
 *     (`jobapplication.sfs.com/Jobs/All?lang=eng|ger`) only exposes a small
 *     GLOBAL job subset (3 postings when checked), not the ~15 Swiss postings
 *     visible on SFS's own public career site. The authoritative CH listing +
 *     rich per-job detail pages (Adobe Experience Manager / AEM front-end)
 *     live at `join.sfs.com/ch/en/vacancies/...` — Umantis is only the
 *     underlying APPLY-flow backend, same architecture already validated by
 *     hoval-job-parser.mjs (Hybris/SAP listing JSON + Umantis apply link).
 *   - The shared `scripts/lib/umantis-listing-common.mjs` factory
 *     (`createUmantisListingParser`) was evaluated and NOT reused here:
 *     (a) it parses the raw `recruitingapp-{tenantId}.umantis.com` HTML
 *     layouts, which don't match SFS's AEM-wrapped chrome at all, and
 *     (b) it under-reports the real CH job set for the same reason the raw
 *     `/Jobs/All` endpoint does above, and (c) it hardcodes a hospital-sector
 *     default (`sector: 'Sanità / Ospedali'`) that doesn't fit an industrial
 *     fastening/mechatronics group. A bespoke parser against the AEM listing
 *     + detail HTML is therefore the correct approach.
 *
 * Source: https://join.sfs.com/ch/en/vacancies/index.jsp (public CH listing)
 * HQ: SFS Group AG, Rosenbergsaustrasse 8, CH-9435 Heerbrugg SG — confirmed via
 * the company's own Impressum pages (join.sfs.com/ch/en/imprint/ and
 * www.sfs.com/ch/en/imprint/, both agree; UID CHE-103.670.002).
 *
 * The listing also carries a handful of postings under a co-tenant brand,
 * "Tegra Medical" (SFS Group's medical-devices division, seen at Hallau SH on
 * the same career portal). These ARE included here — unlike dormakaba's Legic
 * exclusion, there is no signal suggesting Tegra Medical should be scoped out;
 * it's the same corporate group publishing through the same portal/tenant.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSfsGroupJobs() — Fetch and parse all Swiss jobs
 *   - isSfsGroupJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()      — Validate URLs belong to this company
 *   - resolveAddress()       — City-gated HQ-address resolver (exported for tests)
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml, normalizeSpace } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SFS_GROUP_KEY = 'sfs-group';
export const SFS_GROUP_COMPANY_NAME = 'SFS Group';
export const SFS_GROUP_COMPANY_DOMAIN = 'sfs.com';

const LISTING_URL = 'https://join.sfs.com/ch/en/vacancies/index.jsp';
const PORTAL_ORIGIN = 'https://join.sfs.com';
const CAREER_URL = LISTING_URL;

/* ── HQ fallback (Rosenbergsaustrasse 8, 9435 Heerbrugg, SG) ─── */

const HQ = {
  city: 'Heerbrugg',
  canton: 'SG',
  postalCode: '9435',
  streetAddress: 'Rosenbergsaustrasse 8',
  region: 'St. Gallen',
};

const SECTOR = 'Industria / Meccanica';

// Safe canton-level postal fallbacks for Swiss cities that appear in job
// addresses but have no verified SFS office street — never invent a street
// number we haven't confirmed (Non-Negotiable #3: safe default, not removal,
// of the postalCode/streetAddress check). Cantons cover the towns actually
// observed on the live listing: Heerbrugg/Rebstein (SG), Hallau (SH, Tegra
// Medical), Payerne (VD).
const CANTON_POSTAL_FALLBACK = {
  SG: '9000',
  SH: '8200',
  VD: '1000',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function decodeEntities(value = '') {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * City-gated HQ-address resolver.
 *
 * IMPORTANT (bug-class prevention, see scripts/lib/staubli-job-parser.mjs and
 * scripts/lib/dormakaba-job-parser.mjs for the same pattern): the HQ street
 * address must ONLY be attached to jobs whose OWN resolved city text matches
 * Heerbrugg — never inferred from the canton alone. SFS Group posts jobs
 * across several SG-canton towns (e.g. Rebstein) that are NOT the HQ site and
 * must NOT inherit its street address.
 */
export function resolveAddress(city = '') {
  const c = String(city || '');
  if (/heerbrugg/i.test(c)) {
    return { streetAddress: HQ.streetAddress, postalCode: HQ.postalCode, canton: HQ.canton };
  }
  return null;
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isSfsGroupJob(job) {
  if (!job) return false;
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SFS_GROUP_KEY ||
    company.includes('sfs group') ||
    company === 'tegra medical' ||
    url.includes('sfs.com')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'sfs.com' || host.endsWith('.sfs.com');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl|developer)/.test(t)) return 'Ingegneria';
  if (/\b(polymechanik|automatik|mechatronik|techni|tecnic|instandhalt|maintenance)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|kreditor|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce|vente)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse|kommissionier)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur|kunststofftechnolog)/.test(t)) return 'Produzione';
  if (/\b(qualit|qm|qa|qc|reklamation)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm|digital|sap)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|teamleit)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Determine employmentType from the percentage suffix SFS attaches to every
 * title (e.g. "100%", "80–100%", "50 % (m/f/d) 50%"). A range/percentage
 * whose LOWEST bound is below 100 is treated as PART_TIME-eligible; a flat
 * 100% is FULL_TIME.
 */
function detectEmploymentType(text = '') {
  const t = normalize(text);
  const percents = [...t.matchAll(/(\d{2,3})\s*%/g)].map((m) => Number(m[1]));
  if (percents.length > 0) {
    const min = Math.min(...percents);
    return min < 100 ? 'PART_TIME' : 'FULL_TIME';
  }
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  return 'FULL_TIME';
}

/* ── Listing Parser ────────────────────────────────────────── */

const LISTING_ROW_RX = /<a\s+class="molecule-responsive-datalist-entry values-are-copytext"\s+href="([^"]+)"\s*>([\s\S]*?)<\/a>/g;
const COLUMN_VALUE_RX = /<span class="column-value">([\s\S]*?)<\/span>/g;

/**
 * Parse the SFS "join.sfs.com" CH vacancies index page into raw row objects.
 * Pure function (no network) — directly unit-testable against a fixture.
 */
export function parseSfsGroupListing(html = '') {
  const rows = [];
  const seen = new Set();
  let match;
  LISTING_ROW_RX.lastIndex = 0;
  while ((match = LISTING_ROW_RX.exec(html))) {
    const href = match[1];
    // Skip the page's own <script type="text/html" class="entry-template">
    // placeholder block, which matches the same row markup but with literal
    // "{col1}"…"{col4}" template tokens instead of real hrefs/values.
    if (!href || href.includes('{')) continue;

    const inner = match[2];
    const cols = [...inner.matchAll(COLUMN_VALUE_RX)].map((c) =>
      decodeEntities(c[1].replace(/<[^>]+>/g, '')).trim()
    );
    if (cols.length < 3) continue;

    const [rawTitle, rawLocation, rawCompany] = cols;
    if (seen.has(href)) continue;
    seen.add(href);

    rows.push({
      href,
      rawTitle,
      rawLocation,
      rawCompany,
    });
  }
  return rows;
}

/* ── Detail Parser ─────────────────────────────────────────── */

const SUBLINE_RX = /<div class="subline auto-hyphenate">([\s\S]*?)<\/div>/;
const APPLY_URL_RX = /href="(https:\/\/jobapplication\.sfs\.com\/Vacancies\/(\d+)\/[^"]+)"/;
const HEADED_SECTION_RX = /<h3\s+class="atom-section-headline[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/h3>\s*<div\s+class="atom-copytext[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
const INTRO_RX = /<div class="organism-text">\s*<div class="text">\s*([\s\S]*?)<\/div>/;

/**
 * Parse an SFS vacancy detail page into { description, applyUrl, jobReqId }.
 * Pure function (no network) — directly unit-testable against a fixture.
 */
export function parseSfsGroupDetail(html = '') {
  const applyMatch = html.match(APPLY_URL_RX);
  const applyUrl = applyMatch ? applyMatch[1] : '';
  const jobReqId = applyMatch ? applyMatch[2] : '';

  const introMatch = html.match(INTRO_RX);
  const intro = introMatch ? stripHtml(decodeEntities(introMatch[1])) : '';

  const sections = [];
  HEADED_SECTION_RX.lastIndex = 0;
  let hm;
  while ((hm = HEADED_SECTION_RX.exec(html))) {
    const heading = stripHtml(decodeEntities(hm[1]));
    const body = stripHtml(decodeEntities(hm[2]));
    if (heading && body) sections.push(`${heading}: ${body}`);
  }

  const description = normalizeSpace([intro, ...sections].filter(Boolean).join('\n\n'));
  return { description, applyUrl, jobReqId };
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

async function fetchJobListings() {
  console.log(`   Fetching listing: ${LISTING_URL}`);
  const html = await fetchHtml(LISTING_URL);
  return parseSfsGroupListing(html);
}

/**
 * Fetch all SFS Group jobs (Switzerland only).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllSfsGroupJobs() {
  console.log(`🔍 Fetching ${SFS_GROUP_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const rows = await fetchJobListings();
  if (!rows || rows.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${rows.length}`);

  const jobs = [];
  for (const row of rows) {
    const location = normalizeSpace(row.rawLocation || '').replace(/,\s*Schweiz$/i, '').trim() || HQ.city;
    const legalEntity = normalizeSpace(row.rawCompany || '') || SFS_GROUP_COMPANY_NAME;
    // Strip the trailing percentage token(s) SFS appends to every title
    // (e.g. "Digital Process Manager (m/f/d) 100%" → "Digital Process
    // Manager (m/f/d)"); the percentage itself feeds detectEmploymentType.
    const percentageSuffix = (row.rawTitle.match(/(\d{1,3}\s*%(?:\s*[–-]\s*\d{1,3}\s*%)?)\s*$/) || [])[1] || '';
    const title = normalizeSpace(row.rawTitle.replace(/\s*\d{1,3}\s*%(?:\s*[–-]\s*\d{1,3}\s*%)?\s*$/, ''));
    if (!title || title.length < 3) continue;

    const publicUrl = `${PORTAL_ORIGIN}${row.href}`;

    let description = '';
    let applyUrl = publicUrl;
    let jobReqId = '';
    try {
      const detailHtml = await fetchHtml(publicUrl);
      const parsed = parseSfsGroupDetail(detailHtml);
      description = parsed.description;
      applyUrl = parsed.applyUrl || publicUrl;
      jobReqId = parsed.jobReqId;
    } catch (err) {
      console.warn(`   ⚠️ Detail fetch failed for ${publicUrl}: ${err?.message || err}`);
    }

    const canton = inferSwissTargetCanton(location) || HQ.canton;
    const resolvedHq = resolveAddress(location);
    const postalCode = resolvedHq?.postalCode
      || (location === HQ.city ? HQ.postalCode : CANTON_POSTAL_FALLBACK[canton])
      || HQ.postalCode;
    const streetAddress = resolvedHq?.streetAddress
      || (location === HQ.city ? HQ.streetAddress : undefined);
    const description_ = description
      || `${title} bei ${legalEntity} (${SFS_GROUP_COMPANY_NAME}) in ${location}.`;
    const sourceLang = detectLang(description_ || title, 'de');
    const jobSlug = slugify(`${title} sfs group ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(percentageSuffix || row.rawTitle);
    const postedDate = new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${SFS_GROUP_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SFS_GROUP_COMPANY_NAME,
      companyKey: SFS_GROUP_KEY,
      companyDomain: SFS_GROUP_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: description_,
      descriptionByLocale: { [sourceLang]: description_ },
      location,
      canton,
      url: publicUrl,
      source: 'SFS Group Dedicated Parser (Umantis/AEM)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressRegion: canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl,
      jobReqId: jobReqId || null,
      legalEntity,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${SFS_GROUP_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
