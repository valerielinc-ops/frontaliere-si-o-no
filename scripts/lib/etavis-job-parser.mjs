#!/usr/bin/env node
/**
 * ETAVIS job parser — Fetcher and job builder.
 *
 * ETAVIS is a Swiss electrical-installation group (part of VINCI Energies
 * Switzerland) operating under several regional subsidiary brands — ETAVIS
 * AG, ETAVIS Grossenbacher AG, ETAVIS Bern-Mittelland AG, ETAVIS
 * Elettro-Impianti SA (Ticino/Lugano), ETAVIS Romandie SA, Gfeller Elektro,
 * ETAVIS Kriegel+Schaffner AG, ETAVIS Arnold, ETAVIS Beutler, ETAVIS ELCOM,
 * ETAVIS JAG JAKOB, ... All roles are published on one shared Softgarden
 * career board:
 *
 *   https://etavis.softgarden.io/de/vacancies
 *
 * Softgarden "Wicket" listing markup (same family as vaudoise.softgarden.io):
 * server-rendered HTML, all ~86 rows present on first load, no "load more"
 * pagination, no anti-bot challenge on a plain UA fetch (verified
 * 2026-07-03). Unlike vaudoise-job-parser.mjs this tenant does NOT need
 * Playwright, so this parser drives it with plain fetchHtml()
 * (hospital-custom-html-helpers.mjs) instead of the Playwright runtime.
 *
 * Kept as an independent implementation rather than merged into a shared
 * Softgarden client: the two known tenants (vaudoise, etavis) use different
 * fetch mechanics (Playwright DOM $$eval vs. plain fetch + regex-over-HTML)
 * and neither needs the other's machinery. If a third plain-fetch
 * Softgarden "Wicket" tenant shows up, promote the row-selector set below
 * (matchElement / jobcategory / ProjectGeoLocationCity / sg_company_id)
 * into scripts/lib/ats-clients/softgarden.mjs to prevent copy-paste drift.
 *
 * Listing rows: <div class="matchElement" id="job_id_{id}"> ... </div>
 *   .matchValue.title a[href]                              → title + relative apply URL
 *   .matchValue.jobcategory                                → category label
 *   .matchValue.ProjectGeoLocationCity .location-view-item  → city
 *   .matchValue.sg_company_id                                → posting subsidiary brand name
 *
 * Detail page: full JobPosting JSON-LD (`<script type="application/ld+json">`)
 * with rich HTML description, datePosted, employmentType,
 * hiringOrganization.name (actual posting subsidiary), jobLocation.address
 * {streetAddress, postalCode, addressLocality, addressRegion,
 * addressCountry}. baseSalary is present in the JSON-LD but always
 * zero-valued (minValue/maxValue = 0.0, currency "EUR") on this tenant — no
 * real salary data is published, so it is intentionally NOT copied into the
 * job object; downstream per-canton salary estimation fills it in.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllEtavisJobs()  — Fetch and parse all jobs
 *   - isEtavisJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()     — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import { fetchHtml, decodeEntities } from './hospital-custom-html-helpers.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const ETAVIS_KEY = 'etavis';
export const ETAVIS_COMPANY_NAME = 'ETAVIS';
export const ETAVIS_COMPANY_DOMAIN = 'etavis.ch';

const LISTING_URL = 'https://etavis.softgarden.io/de/vacancies';
const SOFTGARDEN_BASE = 'https://etavis.softgarden.io';
const DEFAULT_CITY = 'Zürich';
const DEFAULT_CANTON = 'ZH';
const DEFAULT_POSTAL = '8050';
const POLITE_DELAY_MS = 120;

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to ETAVIS (any of its regional subsidiaries).
 * Used by the template to filter this company's jobs from the global
 * dataset. `companyKey` is always set to ETAVIS_KEY by fetchAllEtavisJobs,
 * so this matches regardless of the display `company` name (which varies
 * per subsidiary, e.g. "Gfeller Elektro" or "VINCI Energies Schweiz AG").
 */
export function isEtavisJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === ETAVIS_KEY ||
    key.startsWith('etavis') ||
    company.includes('etavis') ||
    url.includes('etavis.ch') ||
    url.includes('etavis.softgarden.io')
  );
}

/**
 * Validate that a URL belongs to ETAVIS's domain, trusting both the
 * corporate domain and the Softgarden ATS subdomain where postings live.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'etavis.ch' ||
      host.endsWith('.etavis.ch') ||
      host === 'etavis.softgarden.io'
    );
  } catch {
    return false;
  }
}

/* ── Category / experience / employment detection ─────────── */

function detectCategory(title = '', jobCategory = '') {
  const t = normalize(`${title} ${jobCategory}`);
  if (/\b(lernend|lehrling|apprend|apprenti|berufslehre)/.test(t)) return 'Apprendistato';
  if (/\b(ingegner|engineer|entwickl|planif|pianific|projektleit|capo progetto)/.test(t)) return 'Ingegneria';
  if (/\b(elektr|electric|installat|montag|monteur|servicemonteur|reti di distribuzione)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce|acquisit)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse|disposition)/.test(t)) return 'Logistica';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  // ETAVIS is an electrical-installation contractor — technical roles dominate.
  return 'Tecnica';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(lernend|lehrling|apprend|apprenti|praktik|stage|stagiair|intern)\b/.test(t)) return 'intern';
  if (/\b(junior|jr)\b/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter)\b/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(title = '', jsonLdType = '') {
  const t = normalize(title);
  // ETAVIS titles commonly encode "80-100%" — anything under 100% is part-time.
  const range = t.match(/\b(\d{1,3})\s*[-–]\s*(\d{1,3})\s*%/);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    return hi < 100 || lo < 100 ? 'PART_TIME' : 'FULL_TIME';
  }
  const single = t.match(/\b(\d{1,3})\s*%/);
  if (single) {
    return Number(single[1]) < 100 ? 'PART_TIME' : 'FULL_TIME';
  }
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  if (jsonLdType && /full/i.test(jsonLdType)) return 'FULL_TIME';
  if (jsonLdType && /part/i.test(jsonLdType)) return 'PART_TIME';
  return 'OTHER';
}

/* ── Listing parsing ───────────────────────────────────────── */

/**
 * Resolve a Softgarden listing href (relative `../job/{id}/...`) to an
 * absolute URL on `etavis.softgarden.io`.
 *
 * @param {string} href
 * @returns {string}
 */
export function resolveApplyUrl(href = '') {
  if (!href) return LISTING_URL;
  if (/^https?:\/\//i.test(href)) return href;
  try {
    return new URL(href, LISTING_URL).toString();
  } catch {
    return LISTING_URL;
  }
}

/**
 * Parse the ETAVIS Softgarden listing HTML into row objects. The rows are
 * server-rendered `<div class="matchElement" id="job_id_{id}">` blocks — no
 * pagination, everything is present on first load.
 *
 * @param {string} html
 * @returns {Array<{id:string, title:string, href:string, jobCategory:string, location:string, subsidiary:string}>}
 */
export function parseListingHtml(html = '') {
  const rows = [];
  const seen = new Set();
  const parts = String(html || '').split(/<div class="matchElement" id="job_id_(\d+)">/);
  // parts[0] is the pre-amble; afterwards it alternates id, chunk, id, chunk, ...
  for (let i = 1; i < parts.length; i += 2) {
    const id = parts[i];
    const chunk = parts[i + 1] || '';
    if (seen.has(id)) continue;

    const titleMatch = chunk.match(
      /class="matchValue title">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!titleMatch) continue;
    const href = decodeEntities(titleMatch[1]);
    const title = normalizeSpace(decodeEntities(titleMatch[2].replace(/<[^>]+>/g, ' ')));
    if (!title || title.length < 3) continue;

    const categoryMatch = chunk.match(/class="matchValue jobcategory">([^<]*)</i);
    const jobCategory = categoryMatch ? normalizeSpace(decodeEntities(categoryMatch[1])) : '';

    const locationMatch = chunk.match(/class="location-view-item">([^<]*)</i);
    const location = locationMatch ? normalizeSpace(decodeEntities(locationMatch[1])) : '';

    const companyMatch = chunk.match(/class="matchValue sg_company_id">([^<]*)</i);
    const subsidiary = companyMatch ? normalizeSpace(decodeEntities(companyMatch[1])) : '';

    seen.add(id);
    rows.push({ id, title, href, jobCategory, location, subsidiary });
  }
  return rows;
}

/* ── Detail-page JSON-LD extraction ────────────────────────── */

/**
 * Extract the `JobPosting` JSON-LD block from a Softgarden detail page.
 *
 * @param {string} html
 * @returns {object|null}
 */
export function parseDetailJsonLd(html = '') {
  if (!html || typeof html !== 'string') return null;
  const ldMatch = html.match(
    /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!ldMatch) return null;
  try {
    const parsed = JSON.parse(ldMatch[1]);
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of candidates) {
      if (!entry || typeof entry !== 'object') continue;
      const type = entry['@type'];
      const isJobPosting = type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
      if (isJobPosting) return entry;
    }
  } catch {
    /* ignore parse errors — fall through to null */
  }
  return null;
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch all ETAVIS jobs across all its regional subsidiaries.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only sets source-locale fields. Other locales are filled by
 * the AI localization step and translate-pending pipeline.
 *
 * @param {object} [options]
 * @param {(url: string) => Promise<string>} [options._fetchHtml] Test seam.
 * @returns {Promise<Array<object>>}
 */
export async function fetchAllEtavisJobs(options = {}) {
  console.log(`🔌 Fetching ${ETAVIS_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);

  const htmlFetcher = options._fetchHtml || fetchHtml;

  let listingHtml;
  try {
    listingHtml = await htmlFetcher(LISTING_URL);
  } catch (err) {
    console.warn(`⚠️ ETAVIS listing fetch failed: ${err?.message || err}`);
    return [];
  }

  const rows = parseListingHtml(listingHtml);
  if (!rows.length) {
    console.warn('⚠️ No job listings returned (selector drift?).');
    return [];
  }
  console.log(`  📋 Listings found: ${rows.length}`);
  console.log(`  📄 Fetching detail pages for rich descriptions + addresses...`);

  const jobs = [];
  let detailHits = 0;
  for (const row of rows) {
    const title = row.title;
    const publicUrl = resolveApplyUrl(row.href);

    let detail = null;
    try {
      const detailHtml = await htmlFetcher(publicUrl);
      detail = parseDetailJsonLd(detailHtml);
    } catch {
      detail = null;
    }

    const address = detail?.jobLocation?.address || {};
    const location = normalizeSpace(address.addressLocality || row.location || DEFAULT_CITY);
    const canton =
      inferSwissTargetCanton(`${address.addressRegion || ''} ${location}`) || DEFAULT_CANTON;
    const postalCode = normalizeSpace(address.postalCode || DEFAULT_POSTAL);
    const streetAddress = normalizeSpace(address.streetAddress || '');
    // hiringOrganization.name is the actual posting subsidiary (e.g. "ETAVIS
    // Elettro-Impianti SA", "Gfeller Elektro") — more accurate for job
    // seekers than the generic group label, and still matched by
    // isEtavisJob() via the fixed companyKey below.
    const subsidiary = normalizeSpace(
      detail?.hiringOrganization?.name || row.subsidiary || ETAVIS_COMPANY_NAME,
    );

    let descriptionText = '';
    if (detail?.description) {
      descriptionText = normalizeSpace(stripHtml(String(detail.description)));
    }
    if (descriptionText.length >= 40) detailHits += 1;
    if (!descriptionText) {
      descriptionText = `${title} — ${subsidiary}, ${location}`;
    }

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} etavis ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const postedDate = detail?.datePosted
      ? String(detail.datePosted).slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    const employmentTypeRaw = Array.isArray(detail?.employmentType)
      ? detail.employmentType[0]
      : detail?.employmentType;
    const employmentType = detectEmploymentType(title, employmentTypeRaw);

    const job = {
      // ── Required fields ──
      id: `etavis-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: subsidiary,
      companyKey: ETAVIS_KEY,
      companyDomain: ETAVIS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'ETAVIS Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      postalCode,
      streetAddress,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, row.jobCategory),
      contract: 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Impiantistica elettrica', // Electrical / building-technology installation
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      jobCategory: row.jobCategory || undefined,
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, POLITE_DELAY_MS)); // Rate limiting
  }

  console.log(
    `\n📋 Total ${ETAVIS_COMPANY_NAME} jobs discovered: ${jobs.length} ` +
      `(${detailHits} with real detail-page descriptions).`,
  );
  return jobs;
}

// Internal export for test injection — not part of the public crawler contract.
export const __testables = {
  parseListingHtml,
  parseDetailJsonLd,
  resolveApplyUrl,
  LISTING_URL,
  SOFTGARDEN_BASE,
};

// Re-export for the workflow runner banner.
export { LISTING_URL as CAREER_URL };
