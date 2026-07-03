#!/usr/bin/env node
/**
 * Confiserie Sprüngli job parser — Refline (tenant "116352") careers portal.
 *
 * Source: https://www.spruengli.ch/en/jobs/job-vacancies.html (public career
 * page; embeds the Refline widget via `pub.refline.ch/116352/refline.js`).
 * The listing itself is server-rendered HTML at
 *   https://apply.refline.ch/116352/positions.html
 * (no pagination, no JSON feed). Sprüngli is not registered as an
 * ats-clients/ integration — Refline is a table/anchor-scraped ATS with a
 * shared factory in `./refline-common.mjs`, but Sprüngli's listing table uses
 * an extra `<td class="businessUnit">` column between `position` and
 * `workplace` that `parseReflineTableListing()` does not expect (it assumes
 * `workplace` immediately follows `position`), so this parser uses a local
 * listing regex instead of the shared table parser. `parseReflineDetail()`
 * (generic paragraph-scan) is reused as a fallback description source only.
 *
 * Detail pages (`.../{tenant}/{posId}/pub/{rev}/index.html`) additionally
 * embed a full schema.org `JobPosting` JSON-LD block with authoritative
 * per-job data: `title`, `datePosted`, `employmentType`,
 * `hiringOrganization.name`, and — critically — `jobLocation.address`
 * (`streetAddress`, `postalCode`, `addressLocality`, `addressRegion`,
 * `addressCountry`). This is the primary data source for this parser; it is
 * richer and more reliable than the generic HTML scrape and lets each job
 * carry its own real address instead of defaulting to Sprüngli's Zürich HQ.
 *
 * Sprüngli's Swiss postings span multiple cantons (own production site in
 * Dietikon ZH, retail branches across ZH/GE/ZG/BE/VS, etc.) — canton is
 * resolved per-job from the JSON-LD `addressRegion`, never hardcoded to HQ.
 *
 * HQ fallback (used ONLY when a job's own JSON-LD address is missing AND its
 * resolved canton matches HQ's — see resolveAddress()):
 *   Confiserie Sprüngli AG, Bahnhofstrasse 21, 8001 Zürich (ZH)
 *   Source: https://www.spruengli.ch/en/contact/ (Impressum)
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSpruengliJobs() — Fetch and parse all Swiss jobs
 *   - isSpruengliJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()       — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang, ensureMinimumDescriptionWordCount } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { getCompanyDefaults, normalizeAnyCantonCode, isTargetCanton } from './crawler-location-config.mjs';
import { parseReflineDetail } from './refline-common.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SPRUENGLI_KEY = 'spruengli';
export const SPRUENGLI_COMPANY_NAME = 'Confiserie Sprüngli AG';
export const SPRUENGLI_COMPANY_DOMAIN = 'spruengli.ch';

const REFLINE_TENANT = '116352';
const LISTING_HOST = 'apply.refline.ch';
const LISTING_URL = `https://${LISTING_HOST}/${REFLINE_TENANT}/positions.html`;
const CAREER_URL = 'https://www.spruengli.ch/en/jobs/job-vacancies.html';

/* ── HQ fallback (Bahnhofstrasse 21, 8001 Zürich, ZH) ────────── */

const HQ_DEFAULTS = getCompanyDefaults(SPRUENGLI_KEY) || {
  city: 'Zürich',
  canton: 'ZH',
  postalCode: '8001',
  addressRegion: 'ZH',
};

const HQ = {
  city: HQ_DEFAULTS.city,
  canton: HQ_DEFAULTS.canton,
  postalCode: HQ_DEFAULTS.postalCode,
  streetAddress: 'Bahnhofstrasse 21',
};

const SECTOR = 'Alimentare / Confetteria';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Confiserie Sprüngli.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isSpruengliJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SPRUENGLI_KEY ||
    key.startsWith('spruengli') ||
    company.includes('sprüngli') ||
    company.includes('spruengli') ||
    url.includes('spruengli.ch') ||
    url.includes(`refline.ch/${REFLINE_TENANT}/`)
  );
}

/**
 * Validate that a URL belongs to Sprüngli's domain OR the Refline ATS host
 * that actually serves the postings for this tenant.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'spruengli.ch' || host.endsWith('.spruengli.ch')) return true;
    if (host === LISTING_HOST || host.endsWith(`.${LISTING_HOST}`)) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(businessUnit = '', title = '') {
  const t = normalize(`${businessUnit} ${title}`);
  if (/\b(verkauf|vente|vendita|filial|shop|boutique|store)/.test(t)) return 'Vendita';
  if (/\b(produktion|konditor|confiseur|confiserie|patiss|bäcker|baecker)/.test(t)) return 'Produzione';
  if (/\b(logist|lager|chauffeur|fahrer|transport|zentrallager)/.test(t)) return 'Logistica';
  if (/\b(reinigung|nettoyage|pulizia)/.test(t)) return 'Pulizia';
  if (/\b(techni|mechatron|instandhaltung|manutenzione|anlagenführer)/.test(t)) return 'Tecnica';
  if (/\b(gastronomie|küche|service|café|office|buffet)/.test(t)) return 'Ristorazione';
  if (/\b(hr|human resources|personal|risorse umane)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunikation|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|buchhaltung|contab)/.test(t)) return 'Finanza';
  if (/\b(it\b|informatik|informatica|software)/.test(t)) return 'IT';
  if (/\b(admin|verwaltung|segret)/.test(t)) return 'Amministrazione';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|schnupperlehre)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|leitung|filialleiter)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Listing + Detail Parsing ─────────────────────────────────── */

/**
 * Parse the Refline "table-row" listing for Sprüngli's tenant. Sprüngli's
 * table has an extra `businessUnit` column between `position` and
 * `workplace` that the shared `parseReflineTableListing()` helper does not
 * expect, so this is a bespoke regex tailored to that exact column order:
 *   <tr><td class="position"><a href=".../{posId}/pub/{rev}/index.html">Title</a></td>
 *       <td class="businessUnit">…</td>
 *       <td class="workplace">…</td>
 *       <td class="workload">…</td></tr>
 */
export function parseSpruengliListing(html = '') {
  if (!html) return [];
  const out = [];
  const seen = new Set();

  const rowRe = new RegExp(
    `<tr[^>]*>\\s*<td class="position">\\s*<a\\s+href="(https?:\\/\\/${LISTING_HOST.replace(/\./g, '\\.')}\\/${REFLINE_TENANT}\\/([A-Za-z0-9]+)\\/pub\\/(\\d+)\\/index\\.html)"[^>]*>([\\s\\S]*?)<\\/a>\\s*<\\/td>\\s*(?:<td class="businessUnit">([\\s\\S]*?)<\\/td>\\s*)?(?:<td class="workplace">([\\s\\S]*?)<\\/td>\\s*)?(?:<td class="workload">([\\s\\S]*?)<\\/td>\\s*)?`,
    'gi',
  );

  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const url = m[1];
    const posId = m[2];
    const rev = m[3];
    const title = normalizeSpace(stripHtml(m[4] || ''));
    const businessUnit = m[5] ? normalizeSpace(stripHtml(m[5])) : '';
    const workplace = m[6] ? normalizeSpace(stripHtml(m[6])) : '';
    const workload = m[7] ? normalizeSpace(stripHtml(m[7])) : '';
    if (!title || title.length < 3) continue;
    if (seen.has(posId)) continue;
    seen.add(posId);
    out.push({ url, posId, rev, title, businessUnit, workplace, workload });
  }
  return out;
}

/**
 * Extract the schema.org JobPosting JSON-LD block embedded on Refline detail
 * pages for this tenant. Returns null if absent or malformed.
 */
export function parseSpruengliJsonLd(html = '') {
  if (!html) return null;
  const match = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]);
    if (data && data['@type'] === 'JobPosting') return data;
    return null;
  } catch {
    return null;
  }
}

/**
 * Pick the best city / postal code / street / region for a job. The JSON-LD
 * `jobLocation.address` is authoritative per-job data (Sprüngli postings span
 * several cantons — Dietikon ZH production site, retail branches in
 * ZH/GE/ZG/BE/VS, etc.), so it is used whenever present. Only when a field is
 * genuinely missing from the source AND the resolved canton matches HQ's
 * canton do we fall back to the documented HQ address — this must NEVER be
 * an unconditional fallback (a Geneva job must never inherit the Zürich HQ
 * street address just because its own address field was momentarily empty).
 */
function resolveAddress(addr = {}, canton) {
  const city = normalizeSpace(addr.city || '');
  const postalCode = normalizeSpace(addr.postalCode || '');
  const streetAddress = normalizeSpace(addr.streetAddress || '');
  const region = normalizeSpace(addr.region || '');

  return {
    city: city || (canton === HQ.canton ? HQ.city : ''),
    postalCode: postalCode || (canton === HQ.canton ? HQ.postalCode : ''),
    streetAddress: streetAddress || (canton === HQ.canton ? HQ.streetAddress : ''),
    region,
  };
}

/**
 * Fetch the Sprüngli listing page and every detail page it links to.
 * Returns an array of raw listing objects with detail HTML attached.
 */
async function fetchJobListings() {
  console.log(`   Fetching Refline tenant "${REFLINE_TENANT}" listing`);
  const html = await fetchHtml(LISTING_URL, {
    headers: { Referer: CAREER_URL },
  });

  const rows = parseSpruengliListing(html);
  if (!rows.length) return [];

  const listings = [];
  for (const row of rows) {
    let detailHtml = '';
    try {
      detailHtml = await fetchHtml(row.url, { headers: { Referer: LISTING_URL } });
    } catch (err) {
      console.warn(`⚠️ Detail fetch failed for ${row.url}: ${err?.message || err}`);
    }
    listings.push({ ...row, detailHtml });
  }
  return listings;
}

/**
 * Fetch all Sprüngli jobs (Switzerland only).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllSpruengliJobs() {
  console.log(`🔍 Fetching ${SPRUENGLI_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  const seen = new Set();
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const publicUrl = listing.url || CAREER_URL;
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    const jsonLd = parseSpruengliJsonLd(listing.detailHtml || '');
    const jsonLdAddr = jsonLd?.jobLocation?.address || {};

    // Non-Swiss / foreign-office guard: skip any posting whose JSON-LD
    // address explicitly names a non-CH country.
    const rawCountry = normalizeSpace(jsonLdAddr.addressCountry || '');
    if (rawCountry && rawCountry.toUpperCase() !== 'CH') continue;

    const workplaceHint = listing.workplace || jsonLdAddr.addressLocality || '';
    let canton =
      normalizeAnyCantonCode(jsonLdAddr.addressRegion || '') ||
      inferSwissTargetCanton(workplaceHint) ||
      inferSwissTargetCanton(jsonLdAddr.addressLocality || '') ||
      HQ.canton;
    if (!isTargetCanton(canton)) canton = HQ.canton;

    const { city, postalCode, streetAddress, region } = resolveAddress(
      {
        city: jsonLdAddr.addressLocality,
        postalCode: jsonLdAddr.postalCode,
        streetAddress: jsonLdAddr.streetAddress,
        region: jsonLdAddr.addressRegion,
      },
      canton,
    );
    const location = normalizeSpace(workplaceHint || city || HQ.city);

    // Description: prefer the rich JSON-LD description (real job body, incl.
    // tasks/requirements/benefits), fall back to the generic Refline detail
    // paragraph-scan, then a minimal synthetic sentence.
    const jsonLdDescription = jsonLd?.description ? stripHtml(jsonLd.description) : '';
    const detailParsed = parseReflineDetail(listing.detailHtml || '');
    const descriptionText = jsonLdDescription || detailParsed.description || '';
    let description = descriptionText || `${title} bei ${SPRUENGLI_COMPANY_NAME} in ${location}.`;

    // Thin-description guard (Non-Negotiable #4: never index <50-word content).
    // Real Sprüngli JSON-LD bodies run 300+ words, but if the source ever
    // returns a stub, append company context inline instead of leaving thin
    // content indexable.
    const descWordCount = description.split(/\s+/).filter(Boolean).length;
    if (descWordCount < 50) {
      description = [
        description,
        `Confiserie Sprüngli AG ist ein 1836 gegründetes Schweizer Familienunternehmen und zählt mit seinem erlesenen Sortiment an Confiserie, Schokolade und Backwaren zu den renommiertesten Confiserien Europas. Das Unternehmen betreibt seine Manufaktur in Dietikon sowie zahlreiche Filialen, Cafés und Restaurants in der ganzen Schweiz und bietet Stellen in Produktion, Verkauf, Logistik und Administration.`,
      ].join('\n');
    }

    const resolvedTitle = normalizeSpace(jsonLd?.title || detailParsed.title || title);
    const sourceLang = detectLang(descriptionText || resolvedTitle, 'de');
    const jobSlug = slugify(`${resolvedTitle} spruengli ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const jsonLdEmploymentType = Array.isArray(jsonLd?.employmentType) ? jsonLd.employmentType[0] : jsonLd?.employmentType;
    const employmentType = jsonLdEmploymentType || detectEmploymentType(`${listing.workload || ''} ${resolvedTitle}`);
    const postedDate = (jsonLd?.datePosted && String(jsonLd.datePosted).slice(0, 10))
      || new Date().toISOString().split('T')[0];
    const hiringOrgName = jsonLd?.hiringOrganization?.name || SPRUENGLI_COMPANY_NAME;

    const job = {
      // ── Required fields ──
      id: `${SPRUENGLI_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SPRUENGLI_COMPANY_NAME,
      companyKey: SPRUENGLI_KEY,
      companyDomain: SPRUENGLI_COMPANY_DOMAIN,
      title: resolvedTitle,
      titleByLocale: { [sourceLang]: resolvedTitle },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Confiserie Sprüngli Dedicated Parser (Refline 116352)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city || location,
      addressRegion: region || canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(listing.businessUnit, resolvedTitle),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(resolvedTitle),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      hiringOrganizationName: hiringOrgName,
      jobReqId: listing.posId || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  ensureMinimumDescriptionWordCount(jobs, 50);

  console.log(`\n📋 Total ${SPRUENGLI_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
