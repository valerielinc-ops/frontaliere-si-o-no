#!/usr/bin/env node
/**
 * Montagetechnik BERNER AG job parser — Workday ATS.
 *
 * The company career page (https://shop.berner.eu/ch-de/vacancies/) that this
 * crawler originally scraped was retired — the URL now 404s on the Berner
 * shop site (issue #6269: 6 consecutive empty runs). The Akamai edge in front
 * of `shop.berner.eu` also returns a blanket "Access Denied" to plain HTTP
 * clients (even for `/robots.txt`), which is why the old fetcher looked like
 * a bot block; a real browser hits the SAME 404, confirming the page is
 * genuinely gone rather than fenced. Berner Group career pages now link out
 * to a shared Workday tenant instead:
 *   https://shop.berner.eu/ch-de/career/welcome → "Hier bewerben" →
 *   https://bernergroup.wd3.myworkdayjobs.com/de-DE/Careers_Berner_Group
 *
 * Tenant host: bernergroup.wd3.myworkdayjobs.com
 * Site path:   Careers_Berner_Group
 *
 * Confirmed live via the public CXS API:
 *   curl -X POST https://bernergroup.wd3.myworkdayjobs.com/wday/cxs/bernergroup/Careers_Berner_Group/jobs \
 *     -H 'Content-Type: application/json' \
 *     -d '{"appliedFacets":{"locationCountry":["187134fccb084a0ea9b4b95f23890dbe"]},"limit":20,"offset":0}'
 *
 * The Swiss-country facet on this tenant returns only postings for the CH
 * subsidiary (`bulletFields` tagged "Montagetechnik Berner AG" / "Montagetechnik AG"),
 * so no extra per-listing company filter is needed beyond the country facet.
 *
 * HQ (per https://shop.berner.eu/ch-de/imprint):
 *   Montagetechnik Berner AG, Kägenstrasse 8, 4153 Reinach BL, Schweiz.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllBernerMontageJobs()  — Fetch and parse all jobs
 *   - isBernerMontageJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang, isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeDescriptionBullets } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  buildWorkdayApiBase,
  fetchWorkdayJobs,
  fetchWorkdayJobDetail,
  parseWorkdayPostedDate,
  extractWorkdayJobIdentity,
  WorkdayAuthError,
} from './ats-clients/workday-client.mjs';
/* ── Constants ─────────────────────────────────────────────── */

export const BERNER_MONTAGE_KEY = 'berner-montage';
export const BERNER_MONTAGE_COMPANY_NAME = 'Montagetechnik BERNER AG';
export const BERNER_MONTAGE_COMPANY_DOMAIN = 'berner.eu';

const WORKDAY_TENANT_HOST = 'bernergroup.wd3.myworkdayjobs.com';
const WORKDAY_SITE_PATH = 'Careers_Berner_Group';
const WORKDAY_API_BASE = buildWorkdayApiBase(WORKDAY_TENANT_HOST, WORKDAY_SITE_PATH);
const WORKDAY_PUBLIC_BASE = `https://${WORKDAY_TENANT_HOST}/${WORKDAY_SITE_PATH}`;

const CAREER_URL = 'https://shop.berner.eu/ch-de/career/welcome';

// Standard Workday Switzerland country facet UUID (same across nearly all
// tenants — see workday-swiss-job-parser-common.mjs).
const WORKDAY_SWISS_LOCATION_ID = '187134fccb084a0ea9b4b95f23890dbe';

/* ── HQ address (Montagetechnik Berner AG, Kägenstrasse 8, 4153 Reinach BL) ── */

const HQ = {
  city: 'Reinach',
  canton: 'BL',
  postalCode: '4153',
  streetAddress: 'Kägenstrasse 8',
};

const SECTOR = 'Bau / Montage';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * The Workday CXS `locationsText` field (listing AND detail payloads) is
 * either `"City, Switzerland"` (single location) or the placeholder
 * `"N Locations"` when a posting spans multiple sites — the placeholder is
 * not a usable city name. Strips the country suffix from the former and
 * discards the latter.
 */
function cityFromLocationText(raw = '') {
  const cleaned = normalizeSpace(raw);
  if (!cleaned || /^\d+\s+location/i.test(cleaned)) return '';
  return cleaned.split(',')[0].trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Montagetechnik BERNER AG.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isBernerMontageJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === BERNER_MONTAGE_KEY ||
    key.startsWith('berner-montage') ||
    company.includes('montagetechnik berner ag') ||
    url.includes('berner.eu')
  );
}

/**
 * Validate that a URL belongs to Montagetechnik BERNER AG's domain OR the
 * Workday ATS host that actually serves postings.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'berner.eu' || host.endsWith('.berner.eu')) return true;
    if (host === WORKDAY_TENANT_HOST || host.endsWith('.myworkdayjobs.com')) return true;
    return false;
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
  if (/\b(vendita|sales|verkauf|commerce|aussendienst|regional|commercial)/.test(t)) return 'Commerciale';
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

function detectEmploymentType(timeType = '', title = '') {
  const t = normalize(`${timeType} ${title}`);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Address resolution ───────────────────────────────────────
 * Only apply the HQ street/postal-code fallback when the job's own
 * resolved city TEXT matches the HQ city (Reinach) — never gate on canton
 * equality. Pattern mirrors scripts/lib/bossard-job-parser.mjs's
 * resolveAddress().
 */
function resolveAddress(rawCity = '') {
  const city = normalizeSpace(rawCity || '');
  const isHqCity = !city || /\breinach\b/i.test(city);

  return {
    city: city || HQ.city,
    postalCode: isHqCity ? HQ.postalCode : '',
    streetAddress: isHqCity ? HQ.streetAddress : '',
  };
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch Switzerland-only Montagetechnik BERNER AG postings from the Workday
 * CXS API.
 */
async function fetchJobListings() {
  const out = [];
  try {
    for await (const posting of fetchWorkdayJobs(WORKDAY_API_BASE, {
      appliedFacets: { locationCountry: [WORKDAY_SWISS_LOCATION_ID] },
      maxPages: 100000,
    })) {
      const id = extractWorkdayJobIdentity(posting, {
        apiBase: WORKDAY_API_BASE,
        company: BERNER_MONTAGE_COMPANY_NAME,
      });
      out.push({
        title: id.title,
        location: cityFromLocationText(posting.locationsText || ''),
        url: id.applyUrl,
        postedAt: id.postedAt || (posting.postedOn ? parseWorkdayPostedDate(posting.postedOn) : null),
        externalPath: id.externalPath,
        jobReqId: id.jobReqId,
        timeType: posting.timeType || '',
      });
    }
  } catch (err) {
    if (err instanceof WorkdayAuthError) {
      console.error(`❌ Workday anti-bot block (${BERNER_MONTAGE_COMPANY_NAME}): ${err.message}`);
      return [];
    }
    // Some tenants reject an unrecognised locationCountry facet outright —
    // fall back to the unfiltered board and rely on the per-listing
    // foreign guard below.
    console.warn(`⚠️ ${BERNER_MONTAGE_COMPANY_NAME}: Swiss facet fetch failed (${err?.message || err}). Refetching unfiltered.`);
    out.length = 0;
    for await (const posting of fetchWorkdayJobs(WORKDAY_API_BASE, { maxPages: 100000 })) {
      const id = extractWorkdayJobIdentity(posting, {
        apiBase: WORKDAY_API_BASE,
        company: BERNER_MONTAGE_COMPANY_NAME,
      });
      out.push({
        title: id.title,
        location: cityFromLocationText(posting.locationsText || ''),
        url: id.applyUrl,
        postedAt: id.postedAt || (posting.postedOn ? parseWorkdayPostedDate(posting.postedOn) : null),
        externalPath: id.externalPath,
        jobReqId: id.jobReqId,
        timeType: posting.timeType || '',
      });
    }
  }
  return out;
}

/**
 * Fetch all Montagetechnik BERNER AG jobs (Switzerland only).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only source-locale fields are set here. Other locales are
 * filled later by the AI localization pipeline (translate-pending).
 */
export async function fetchAllBernerMontageJobs() {
  console.log(`🔍 Fetching ${BERNER_MONTAGE_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL}`);
  console.log(`   Workday: ${WORKDAY_API_BASE}\n`);

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

    const publicUrl = listing.url || WORKDAY_PUBLIC_BASE;
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    // Workday listing endpoint never returns the job body, and its
    // `locationsText` collapses to a useless "N Locations" placeholder for
    // multi-site postings — the detail payload's `jobPostingInfo.location`
    // carries the single primary site instead, so fetch it unconditionally.
    let detail = null;
    try {
      detail = await fetchWorkdayJobDetail(WORKDAY_API_BASE, listing.externalPath);
    } catch {
      detail = null;
    }
    // Be polite to the Workday tenant between per-job detail fetches.
    await new Promise((r) => setTimeout(r, 400));

    const rawLocation = cityFromLocationText(detail?.jobPostingInfo?.location || '') || listing.location || '';
    if (isLocationExplicitlyForeign(rawLocation)) {
      console.log(`  ⏭️ Skipped foreign location: ${rawLocation} — ${title}`);
      continue;
    }

    const { city, postalCode, streetAddress } = resolveAddress(rawLocation);
    const location = rawLocation || city || HQ.city;
    const canton = inferSwissTargetCanton(location) || inferSwissTargetCanton(city) || HQ.canton;

    const descriptionHtml = String(detail?.jobPostingInfo?.jobDescription || '').trim();
    const detailDescription = descriptionHtml
      ? normalizeDescriptionBullets(
          stripHtml(descriptionHtml)
            .replace(/[ \t]+/g, ' ')
            .replace(/[ \t]*\n[ \t]*/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim(),
        ).slice(0, 4000)
      : '';

    const fallbackDescription = [
      `${title} — ${BERNER_MONTAGE_COMPANY_NAME}, ${location}.`,
      '',
      'Key details:',
      `• Standort: ${location}${canton ? `, Kanton ${canton}` : ''}, Schweiz`,
      '• Arbeitgeber: Montagetechnik Berner AG',
      '• Bewerbung über: Berner Group Karriereportal (Workday)',
    ].join('\n');
    const description = detailDescription.length >= 100 ? detailDescription : fallbackDescription;

    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} berner-montage ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(listing.timeType || '', title);
    const postedDate = listing.postedAt || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `berner-montage-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: BERNER_MONTAGE_COMPANY_NAME,
      companyKey: BERNER_MONTAGE_KEY,
      companyDomain: BERNER_MONTAGE_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't, translate-pending.yml picks the job up.
      needsRetranslation: true,
      location,
      canton,
      url: publicUrl,
      source: `${BERNER_MONTAGE_COMPANY_NAME} Dedicated Parser (Workday)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city || location,
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
      applyUrl: publicUrl,
      jobReqId: listing.jobReqId || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${BERNER_MONTAGE_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
