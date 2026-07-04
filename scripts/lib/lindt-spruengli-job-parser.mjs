#!/usr/bin/env node
/**
 * Lindt & Sprüngli job parser — Workday (tenant "lindtspruengli", site
 * "LindtSpruengliGroupCareers") career portal.
 *
 * ⚠️ NOT AFFILIATED with "Confiserie Sprüngli AG" (companyKey `spruengli`,
 * scripts/lib/spruengli-job-parser.mjs) — a completely separate Zurich/
 * Dietikon pastry & confectionery chain that happens to share the
 * "Sprüngli" name for historical reasons (a 19th-century family-business
 * split). Lindt & Sprüngli is the global chocolate manufacturer
 * headquartered in Kilchberg ZH (issue #3337 explicitly flags the two as
 * "non affiliata"). Because the true, honest company name genuinely
 * contains the substring "Sprüngli", `isSpruengliJob()` in
 * spruengli-job-parser.mjs previously matched on a loose
 * `company.includes('sprüngli')` check that WOULD have swept Lindt jobs
 * into the Confiserie Sprüngli slice (and deleted them from "others" on
 * every Sprüngli crawler run). That matcher now has an explicit
 * Lindt-exclusion guard — see the collision-regression test in
 * tests/lindt-spruengli-crawler.test.ts.
 *
 * ATS discovery: issue #3337 tagged this company's ATS as "Custom", but
 * live probing (public career page + direct CXS API calls) found it's
 * genuinely Workday:
 *   https://lindtspruengli.wd103.myworkdayjobs.com/wday/cxs/lindtspruengli/LindtSpruengliGroupCareers/jobs
 * Public landing page: https://www.lindt-spruengli.com/careers/vacancies
 *
 * Country-facet quirk: this tenant's country-facet parameter is named
 * `locationsCountry` (with an "s") — the more common `locationCountry` key
 * (the shared `workday-client.mjs` default when using `locationFilters`)
 * returns HTTP 400 on this tenant. We therefore pass
 * `appliedFacets: { locationsCountry: [...] }` directly, bypassing the
 * client's default facet-key assumption. Verified live: unfiltered board
 * total=245, `locationsCountry=CH` facet total=27 — matching the CH count
 * reported in the unfiltered board's own country-facet breakdown, so the
 * facet is reliable on this tenant (no silent-ignore fallback needed). A
 * defensive per-listing foreign-location guard is still kept.
 *
 * This parser is written directly against `ats-clients/workday-client.mjs`
 * rather than the `workday-swiss-job-parser-common.mjs` factory because
 * that shared factory does not populate `postalCode`/`streetAddress` at
 * all. Lindt & Sprüngli's Swiss board spans multiple cantons — production
 * site + group headquarters in Kilchberg ZH, logistics center in Altendorf
 * SZ, Lindt Cocoa Center in Olten SO, and ~15 retail "Lindt Shop"
 * locations across the country (including Jungfraujoch BE and Luzern LU)
 * — so the HQ street address may only be safely applied when a job's own
 * city text actually resolves to Kilchberg (see resolveAddress()), never
 * blanket-applied by canton alone.
 *
 * HQ address — verified via Zefix-derived Swiss commercial-register data
 * (northdata.com entries, cross-checked across THREE separate Lindt &
 * Sprüngli group entities that all share the same registered seat):
 *   - Lindt & Sprüngli (Schweiz) AG        — CHE-105.927.933
 *   - Lindt & Sprüngli (International) AG  — CHE-102.231.350
 *   - Chocoladefabriken Lindt & Sprüngli AG (holding) — CHE-102.232.125
 *   Seestrasse 204, 8802 Kilchberg, ZH
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllLindtSpruengliJobs() — Fetch and parse all Swiss jobs
 *   - isLindtSpruengliJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()            — Validate URLs belong to this company
 *   - slugify() / stripHtml()      — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang, isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';
import {
  buildWorkdayApiBase,
  fetchWorkdayJobs,
  fetchWorkdayJobDescriptionText,
  parseWorkdayPostedDate,
  extractWorkdayJobIdentity,
  WorkdayAuthError,
} from './ats-clients/workday-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const LINDT_SPRUENGLI_KEY = 'lindt-spruengli';
export const LINDT_SPRUENGLI_COMPANY_NAME = 'Lindt & Sprüngli';
export const LINDT_SPRUENGLI_COMPANY_DOMAIN = 'lindt-spruengli.com';

const WORKDAY_TENANT_HOST = 'lindtspruengli.wd103.myworkdayjobs.com';
const WORKDAY_SITE_PATH = 'LindtSpruengliGroupCareers';
const WORKDAY_API_BASE = buildWorkdayApiBase(WORKDAY_TENANT_HOST, WORKDAY_SITE_PATH);
// This tenant's own `externalUrl` field (verified via job-detail probe) has
// NO `/en/` locale segment, unlike most other Workday tenants — public form
// is `https://{host}/{site}{externalPath}`.
const WORKDAY_PUBLIC_BASE = `https://${WORKDAY_TENANT_HOST}/${WORKDAY_SITE_PATH}`;
const CAREER_URL = 'https://www.lindt-spruengli.com/careers/vacancies';

// Standard Workday Switzerland country-facet UUID (this tenant's facet
// parameter is named `locationsCountry`, not the more common
// `locationCountry` — see module doc comment above).
const SWISS_COUNTRY_FACET_ID = '187134fccb084a0ea9b4b95f23890dbe';

/* ── HQ fallback (Seestrasse 204, 8802 Kilchberg, ZH) ────────── */

const HQ = {
  city: 'Kilchberg',
  canton: 'ZH',
  postalCode: '8802',
  streetAddress: 'Seestrasse 204',
};

const SECTOR = 'Alimentare / Manifattura';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Lindt & Sprüngli.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isLindtSpruengliJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === LINDT_SPRUENGLI_KEY ||
    key.startsWith('lindt') ||
    company.includes('lindt') ||
    url.includes('lindt-spruengli.com') ||
    url.includes('lindt.com') ||
    url.includes(WORKDAY_TENANT_HOST)
  );
}

/**
 * Validate that a URL belongs to Lindt & Sprüngli's domain OR the Workday
 * tenant that actually serves the postings.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'lindt-spruengli.com' || host.endsWith('.lindt-spruengli.com')) return true;
    if (host === 'lindt.com' || host.endsWith('.lindt.com')) return true;
    if (host === WORKDAY_TENANT_HOST || host.endsWith('.myworkdayjobs.com')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category / experience / employment heuristics ───────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(verkauf|vente|vendita|filial|shop|boutique|store|retail|kundenberat)/.test(t)) return 'Vendita';
  if (/\b(produktion|production|konditor|confiseur|confiserie|patiss|chocolatier|bäcker|baecker)/.test(t)) return 'Produzione';
  if (/\b(logist|lager|warehouse|chauffeur|fahrer|transport|zentrallager|supply)/.test(t)) return 'Logistica';
  if (/\b(techni|mechatron|instandhaltung|manutenzione|anlagenführer|maintenance)/.test(t)) return 'Tecnica';
  if (/\b(qualit|qa\b|qc\b|quality|gmp|hygien)/.test(t)) return 'Qualità';
  if (/\b(gastronomie|küche|kitchen|service|café|barista)/.test(t)) return 'Ristorazione';
  if (/\b(hr\b|human resources|personal|risorse umane|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunikation|comunicaz|brand)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|buchhaltung|contab|controller|controlling)/.test(t)) return 'Finanza';
  if (/\b(it\b|informatik|informatica|software|sap|digital|data)/.test(t)) return 'IT';
  if (/\b(admin|verwaltung|segret)/.test(t)) return 'Amministrazione';
  if (/\b(engineer|ingenieur|ingegner)/.test(t)) return 'Ingegneria';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|schnupperlehre|trainee)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|leitung|filialleiter)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(timeType = '', title = '') {
  const t = normalize(`${timeType} ${title}`);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Location parsing ─────────────────────────────────────────── */

/**
 * Extract a clean city name from Workday's raw `locationsText` field.
 *
 * Handles three shapes actually observed live on this tenant:
 *   - "Kilchberg, Switzerland"                       → "Kilchberg"
 *   - "2 Locations"                                   → '' (ambiguous, drop)
 *   - "LCH - CHE - Plant - Kilchberg - Plant"          → "Kilchberg"
 *     (a raw internal org-hierarchy descriptor leaking through for a
 *     handful of requisitions instead of the usual "City, Country" text —
 *     resolved by scanning dash-separated segments for the first one that
 *     resolves to a real Swiss canton, rather than hardcoding a city list).
 */
export function extractCityFromLocationText(raw = '') {
  const cleaned = normalizeSpace(raw);
  if (!cleaned) return '';
  if (/^\d+\s*locations?$/i.test(cleaned)) return ''; // ambiguous multi-site posting

  if (cleaned.includes(',')) {
    const first = cleaned.split(',')[0].trim();
    if (first && !/^[a-z]{2}$/i.test(first)) return first;
  }

  const dashParts = cleaned.split(/\s*-\s*/).map((p) => p.trim()).filter(Boolean);
  for (const part of dashParts) {
    if (part.length >= 3 && inferAnyCanton(part)) return part;
  }
  return '';
}

/**
 * Resolve the canton for a job's already-extracted city, or signal (via
 * null) that it should be skipped.
 *
 * extractCityFromLocationText()'s comma-split branch returns the raw text
 * before the first comma UNCONDITIONALLY (only its dash-split fallback
 * branch checks inferAnyCanton()) — so `city` here can be a real, present
 * location string that still fails to resolve to any known Swiss canton.
 * Given the board spans ZH/SZ/SO/LU/BE and more (see file header), never
 * fabricate the Kilchberg HQ canton (ZH) for a job that isn't positively
 * there (AGENTS.md Non-Negotiable #3, mirrors clariant-job-parser.mjs /
 * swisslog-job-parser.mjs). Callers only reach this after already
 * confirming `city` is non-empty, so there is no separate "no real text"
 * branch here.
 */
export function resolveLindtSpruengliCanton(city = '') {
  return inferAnyCanton(city) || null;
}

/**
 * Pick city / postal code / street address for a job, falling back to the
 * documented HQ address (Kilchberg ZH) ONLY when the job's own resolved
 * city text actually matches Kilchberg — never by canton alone (Lindt &
 * Sprüngli's Swiss board spans ZH/SZ/SO/LU/BE and more).
 */
function resolveAddress(cityText = '') {
  const city = String(cityText || '').trim();
  const isHqCity = !city || /kilchberg/i.test(city);
  return {
    city: city || HQ.city,
    postalCode: isHqCity ? HQ.postalCode : '',
    streetAddress: isHqCity ? HQ.streetAddress : '',
  };
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

async function fetchJobListings() {
  console.log(`   Fetching Workday tenant "lindtspruengli" (site=${WORKDAY_SITE_PATH}, locationsCountry=CH)`);
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  const out = [];
  try {
    for await (const posting of fetchWorkdayJobs(WORKDAY_API_BASE, {
      appliedFacets: { locationsCountry: [SWISS_COUNTRY_FACET_ID] },
      maxPages: 100000,
      timeoutMs,
    })) {
      const id = extractWorkdayJobIdentity(posting, {
        apiBase: WORKDAY_API_BASE,
        publicBase: WORKDAY_PUBLIC_BASE,
        company: LINDT_SPRUENGLI_COMPANY_NAME,
      });
      out.push({
        title: id.title,
        locationRaw: posting.locationsText || id.location || '',
        url: id.applyUrl,
        postedAt: id.postedAt || (posting.postedOn ? parseWorkdayPostedDate(posting.postedOn) : null),
        externalPath: id.externalPath,
        jobReqId: id.jobReqId,
        timeType: posting.timeType || '',
      });
    }
  } catch (err) {
    if (err instanceof WorkdayAuthError) {
      console.error(`❌ Workday anti-bot block: ${err.message}`);
      return [];
    }
    throw err;
  }

  return out;
}

/**
 * Fetch all Lindt & Sprüngli jobs (Switzerland only).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllLindtSpruengliJobs() {
  console.log(`🍫 Fetching ${LINDT_SPRUENGLI_COMPANY_NAME} jobs`);
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

    if (isLocationExplicitlyForeign(listing.locationRaw)) continue;

    const city = extractCityFromLocationText(listing.locationRaw);
    if (!city) {
      console.log(`   ⏭️ Skipped unresolved/ambiguous location: "${listing.locationRaw}" — ${title}`);
      continue;
    }

    const canton = resolveLindtSpruengliCanton(city);
    if (canton === null) {
      console.warn(`   ⚠️ Skipping unresolvable location "${city}" (${title})`);
      continue;
    }
    const { postalCode, streetAddress } = resolveAddress(city);

    const publicUrl = listing.url || CAREER_URL;
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    // Workday listing endpoint never returns the job body — fetch detail.
    let detailDescription = '';
    try {
      detailDescription = await fetchWorkdayJobDescriptionText(WORKDAY_API_BASE, listing.externalPath, stripHtml);
    } catch {
      detailDescription = '';
    }
    await new Promise((r) => setTimeout(r, 350));

    const fallbackDescription = [
      `${title} — ${LINDT_SPRUENGLI_COMPANY_NAME}, ${city}.`,
      '',
      'Key details:',
      `• Location: ${city}${canton ? `, Kanton ${canton}` : ''}, Schweiz`,
      `• Employer: ${LINDT_SPRUENGLI_COMPANY_NAME}.`,
      `• Apply: ${LINDT_SPRUENGLI_COMPANY_NAME} Workday careers portal.`,
    ].join('\n');
    const descriptionText = detailDescription.length >= 100 ? detailDescription : fallbackDescription;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} lindt spruengli ${city}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(listing.timeType || '', title);
    const postedDate = listing.postedAt || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${LINDT_SPRUENGLI_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: LINDT_SPRUENGLI_COMPANY_NAME,
      companyKey: LINDT_SPRUENGLI_KEY,
      companyDomain: LINDT_SPRUENGLI_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location: city,
      canton,
      url: publicUrl,
      source: `${LINDT_SPRUENGLI_COMPANY_NAME} Dedicated Parser (Workday)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
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

  console.log(`\n📋 Total ${LINDT_SPRUENGLI_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
