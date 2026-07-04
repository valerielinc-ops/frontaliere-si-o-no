#!/usr/bin/env node
/**
 * On Running job parser — Greenhouse API.
 *
 * Discovery note (issue #3337 tags On Running as "Custom" — WRONG, same
 * class of mislabeled row as Veeam/Clariant elsewhere in this backlog; a
 * SmartRecruiters tenant for "On"/"On Running" IS publicly rumored, but that
 * is NOT what actually feeds the company's own careers site):
 *   1. https://www.on-running.com/en-ch/careers 301-redirects twice, first
 *      to https://www.on.com/en-ch/careers, then to https://culture.on.com/
 *      — a separate Next.js careers micro-site is the real source.
 *   2. https://culture.on.com/jobs/ links every open requisition directly to
 *      `boards.greenhouse.io/onrunning/jobs/{id}?gh_jid={id}` (verified live
 *      via curl — no SmartRecruiters/Workday/bespoke backend involved here).
 *   3. Confirmed against the public, unauthenticated Greenhouse Job Board
 *      API: `https://boards-api.greenhouse.io/v1/boards/onrunning/jobs` →
 *      HTTP 200, 312 jobs worldwide, 76 tagged Zurich/Switzerland (verified
 *      2026-07-04). Board token is "onrunning" (derivable via
 *      `extractGreenhouseBoardToken()` from the leaked board URLs above).
 *   4. Every Swiss posting's raw `offices[]` entry carries a full street
 *      address straight from Greenhouse: `{"name":"HQ Zurich","location":
 *      "Förrlibuckstrasse 190, 8005 Zürich, Switzerland"}` — this
 *      independently matches BOTH Zefix (Swiss commercial register, "On
 *      Clouds GmbH", CHE-109.909.325, legalSeat Zürich) and Moneyhouse's
 *      registered address (see scripts/lib/crawler-location-config.mjs
 *      comment for the on-running HQ entry), so the static HQ fallback
 *      below is corroborated by 3 independent sources, not assumed from
 *      public brand lore alone.
 *
 * Reuses the shared Greenhouse client (./ats-clients/greenhouse-client.mjs)
 * — this board behaves like any other public Greenhouse tenant (single
 * unpaginated GET). Its `content` field is HTML-entity-*double*-encoded,
 * the exact same quirk documented in scripts/lib/veeam-job-parser.mjs (the
 * literal characters `&lt;p&gt;…&lt;/p&gt;` appear in the already
 * JSON-decoded string — confirmed live on this board too), so the same
 * local `decodeHtmlEntities()` pre-pass is required before `stripHtml()`.
 *
 * Address resolution (`resolveAddress()`) mirrors
 * scripts/lib/staubli-job-parser.mjs's `resolveAddress()`: the HQ
 * street/postal fallback is gated on the job's resolved CITY TEXT
 * (`/z[üu]rich/i`) — never on canton (ZH) alone — so a hypothetical future
 * On Running posting in some OTHER canton-ZH municipality (e.g. Winterthur)
 * would not silently inherit the Zürich HQ street address.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllOnRunningJobs() — Fetch and parse all Swiss jobs
 *   - isOnRunningJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()       — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang, normalizeContract } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { fetchGreenhouseJobs } from './ats-clients/greenhouse-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const ON_RUNNING_KEY = 'on-running';
export const ON_RUNNING_COMPANY_NAME = 'On Running';
export const ON_RUNNING_COMPANY_DOMAIN = 'on-running.com';

const CAREER_URL = 'https://culture.on.com/jobs/';
const GREENHOUSE_BOARD = 'onrunning';

const SECTOR = 'Sportswear / Calzature sportive';

// On Clouds GmbH — Swiss legal seat, Förrlibuckstrasse 190, 8005 Zürich.
// Confirmed via Zefix (Swiss commercial registry, CHE-109.909.325,
// legalSeat "Zürich") cross-checked against Moneyhouse's registered address
// AND the company's own Greenhouse `offices[].location` field for every
// Zurich posting ("HQ Zurich" → "Förrlibuckstrasse 190, 8005 Zürich,
// Switzerland") — three independent sources agree, see file header note.
const HQ = {
  city: 'Zürich',
  canton: 'ZH',
  postalCode: '8005',
  streetAddress: 'Förrlibuckstrasse 190',
  region: 'Zürich',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// Same inline entity-decode pattern as scripts/lib/veeam-job-parser.mjs /
// scripts/lib/adus-klinik-job-parser.mjs — Greenhouse `content` on this
// board is HTML-entity-encoded, so this MUST run before stripHtml() sees
// the string, else literal `<div ...>` tag soup leaks into the description.
function decodeHtmlEntities(s = '') {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number.parseInt(n, 10)));
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to On Running.
 * Used by the template to filter this company's jobs from the global dataset.
 *
 * NOTE: the brand name "On" is a single common English word, so — unlike
 * most other dedicated parsers — this deliberately does NOT do a loose
 * `company.includes('on')` substring check (that would false-positive on
 * almost any company/title containing the letters "on"). Matching is
 * restricted to the exact companyKey, an exact/word-bounded company name,
 * or a trusted URL.
 */
export function isOnRunningJob(job) {
  const key = normalize(job?.companyKey || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === ON_RUNNING_KEY ||
    company === 'on running' ||
    company === 'on' ||
    /^on\s*(running)?$/.test(company) ||
    url.includes('on-running.com') ||
    url.includes('culture.on.com') ||
    url.includes('greenhouse.io/onrunning')
  );
}

/**
 * Validate that a URL belongs to On Running's domain(s) or its Greenhouse board.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'on-running.com' ||
      host.endsWith('.on-running.com') ||
      host === 'on.com' ||
      host.endsWith('.on.com') ||
      host.includes('greenhouse.io')
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl|develop)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install|support)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account.*payable|account.*receivable)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce|account executive|retail)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse|supply\s*chain)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality|testing)/.test(t)) return 'Qualità';
  if (/\b(it\b|software|develop|programm|data\s*scien|cloud)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal|recruit|talent|compensation)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz|brand|content)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ|reporting)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  if (/\b(design|product\s*creation|footwear|apparel)/.test(t)) return 'Design';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|graduate)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|principal|staff|vp\b|vice president)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Map the shared `normalizeContract()` classification (from
 * ./dedicated-crawler-common.mjs — reused rather than re-implementing a
 * parallel title/description regex, per AGENTS.md sibling-pattern rule) to
 * the schema.org `employmentType` enum used across this codebase's job-page
 * structured data.
 *
 * Greenhouse's per-job "Employment Type" metadata field (observed values on
 * this board: Permanent, Full-time, Fixed_Term, Intern) is NOT surfaced by
 * the shared Greenhouse client (`normalizeGreenhouseJob()` in
 * ./ats-clients/greenhouse-client.mjs deliberately keeps its NormalizedJob
 * shape vendor-agnostic and doesn't pass through raw `metadata[]`), but in
 * practice every observed Fixed_Term/Intern/Part-Time posting on this board
 * already states so directly in the title/description (e.g. "Intern - EMEA
 * Sales Planning", "Fit Model (Flexible, Part-Time Opportunity)"), which
 * `normalizeContract()` already classifies correctly.
 *
 * @param {string} contract Value returned by `normalizeContract()`.
 * @returns {string} schema.org employmentType enum value.
 */
function mapContractToEmploymentType(contract = '') {
  switch (contract) {
    case 'part-time': return 'PART_TIME';
    case 'internship': return 'INTERN';
    case 'temporary': return 'TEMPORARY';
    case 'contract': return 'CONTRACTOR';
    default: return 'FULL_TIME';
  }
}

/**
 * Pick the best city / postal code / street address for an On Running
 * posting, falling back to the documented Zürich HQ address ONLY when the
 * resolved city text itself matches Zürich (accepts the ASCII "u" spelling
 * too) — city-gated, NEVER canton-gated (see file header + AGENTS.md
 * sibling-pattern note). A posting merely sharing canton ZH with some other
 * ZH municipality (e.g. Winterthur, Uster) must NOT inherit this address.
 *
 * Exported so tests exercise this exact gate instead of a duplicated regex.
 *
 * @param {string} locationName Raw Greenhouse `location.name` string, e.g.
 *   "Zurich" or the combined multi-office "London; Zurich".
 * @returns {{ city: string, postalCode: string, streetAddress: string }}
 */
export function resolveAddress(locationName = '') {
  // Multi-office postings combine offices with "; " (e.g. "London; Zurich").
  // Extract just the Swiss/Zurich fragment for the display city.
  const parts = String(locationName || '').split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  const zurichPart = parts.find((p) => /z[üu]rich/i.test(p));
  const city = zurichPart ? HQ.city : (parts[0] || '');
  const cityMatchesHq = !city || /z[üu]rich/i.test(city);

  return {
    city: city || HQ.city,
    postalCode: cityMatchesHq ? HQ.postalCode : '',
    streetAddress: cityMatchesHq ? HQ.streetAddress : '',
  };
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

// On Running's board lists postings from many countries under a single
// `location.name` string that may combine several offices (e.g. "London;
// Zurich"). We fetch unfiltered from the shared client and match strictly
// against that resolved string ourselves — same approach as
// scripts/lib/veeam-job-parser.mjs — rather than relying on the shared
// client's `locationContains` option (which also inspects raw `offices[]`
// text and could over-match on unrelated multi-country listings).
const SWISS_LOCATION_RE = /switzerland|schweiz|suisse|svizzera|z[üu]rich/i;

async function fetchJobListings() {
  const jobs = await fetchGreenhouseJobs(GREENHOUSE_BOARD, {
    includeContent: true,
    companyName: ON_RUNNING_COMPANY_NAME,
  });
  return jobs
    .filter((j) => SWISS_LOCATION_RE.test(j.location || ''))
    .map((j) => ({
      title: j.title,
      location: j.location,
      url: j.applyUrl,
      postedAt: j.postedAt,
      description: j.descriptionHtml || '',
      jobReqId: j.jobReqId,
    }));
}

/**
 * Fetch all On Running jobs (Switzerland only).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllOnRunningJobs() {
  console.log(`🔍 Fetching ${ON_RUNNING_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL} (Greenhouse board "${GREENHOUSE_BOARD}")\n`);

  let listings;
  try {
    listings = await fetchJobListings();
  } catch (err) {
    console.error(`❌ Failed to fetch ${ON_RUNNING_COMPANY_NAME} jobs from Greenhouse: ${err?.message || err}`);
    return [];
  }
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Swiss job listings returned.');
    return [];
  }

  console.log(`  📋 Swiss listings found: ${listings.length}`);

  const jobs = [];
  const seen = new Set();
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const publicUrl = listing.url || CAREER_URL;
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    const { city, postalCode, streetAddress } = resolveAddress(listing.location || '');
    const location = normalizeSpace(city || HQ.city);
    const canton = inferSwissTargetCanton(location) || inferSwissTargetCanton(listing.location || '') || HQ.canton;

    const descriptionHtml = decodeHtmlEntities(listing.description || '');
    const descriptionText = stripHtml(descriptionHtml);
    const description = descriptionText || `${title} — ${ON_RUNNING_COMPANY_NAME}, ${location}.`;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} on-running ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const contract = normalizeContract('', title, description);
    const employmentType = mapContractToEmploymentType(contract);
    const postedDate = (listing.postedAt && String(listing.postedAt).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${ON_RUNNING_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ON_RUNNING_COMPANY_NAME,
      companyKey: ON_RUNNING_KEY,
      companyDomain: ON_RUNNING_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'On Running Dedicated Parser (Greenhouse)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields (structured-data completeness, AGENTS.md #3) ──
      addressLocality: city || HQ.city,
      addressRegion: canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract,
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
      _targetScope: { canton, location: city || HQ.city },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${ON_RUNNING_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { CAREER_URL };
