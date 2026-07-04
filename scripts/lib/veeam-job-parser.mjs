#!/usr/bin/env node
/**
 * Veeam Software job parser — Greenhouse API fetcher and job builder.
 *
 * Discovery note (issue #3337 Wave D, row 5): the backlog tagged Veeam as
 * "Custom" (career URL careers.veeam.com/search-jobs). That front-end is
 * actually a Radancy/TMP-Worldwide "TalentBrew" recruitment-marketing shell
 * (data-ajax-post-url="/search-jobs/resultspost", TalentBrew client id
 * "22681" visible in job detail hrefs) — it is a CMS skin, NOT the real
 * ATS. The page's footer "Recruiter/Employee" sign-in link points at
 * `my.greenhouse.io/users/sign_in?job_board=veeamsoftware`, which leaked the
 * real board token. Confirmed live against Greenhouse's public,
 * unauthenticated Job Board API:
 *   https://boards-api.greenhouse.io/v1/boards/veeamsoftware/jobs
 * → HTTP 200, 280 jobs worldwide (verified 2026-07-03). Individual postings
 * resolve to `https://job-boards.eu.greenhouse.io/veeamsoftware/jobs/{id}`
 * (EU-hosted Greenhouse instance), but the public list/read API itself is
 * served from the same unified `boards-api.greenhouse.io` host regardless
 * of which regional job-board front-end a posting is displayed on.
 * `extractGreenhouseBoardToken()` (./ats-clients/greenhouse-client.mjs)
 * does NOT recognise either the `job-boards.eu.greenhouse.io` host or the
 * TalentBrew front-end URL, so the board token is hardcoded below
 * (`GREENHOUSE_BOARD`) rather than derived from CAREER_URL.
 *
 * Veeam is a global company (280 open reqs worldwide, HQ Seattle) with a
 * Swiss legal entity, Veeam Software Group GmbH, headquartered in Baar ZG.
 * Most Swiss-relevant postings on the board are tagged `location.name`
 * "Remote, Switzerland" (no city) rather than tied to a physical Baar
 * office — we filter to those explicitly Swiss-tagged postings only, we do
 * NOT match on cantons/regions mentioned inside descriptions (which would
 * false-positive on EMEA-wide postings that merely list Switzerland among
 * many countries a remote hire could sit in).
 *
 * `content` field on this Greenhouse board is HTML-entity-*double*-encoded
 * (e.g. the literal characters `&lt;div class=&quot;...&quot;&gt;` appear
 * inside the already-JSON-decoded string, i.e. there is no raw `<` byte at
 * all) — confirmed across multiple postings, not isolated to any one
 * department. `stripHtml()` (crawler-template.mjs) strips real `<tag>`
 * markup and THEN unescapes entities, so feeding it this content directly
 * would leave literal `<div ...>` tag soup in the description text. We run
 * a local `decodeHtmlEntities()` pass first (same inline pattern used by
 * scripts/lib/adus-klinik-job-parser.mjs) so `stripHtml()` sees real tags.
 *
 * Address resolution (`resolveAddress()`) mirrors
 * scripts/lib/staubli-job-parser.mjs's `resolveAddress()`: HQ street/postal
 * fallback is gated on the job's resolved CITY TEXT (`/baar/i.test(city)`)
 * or on having NO city at all — never on canton/addressRegion equality
 * alone, so a Swiss-remote posting merely sharing ZG canton with some other
 * ZG city would not silently inherit the Baar street address.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllVeeamJobs()  — Fetch and parse all Swiss jobs
 *   - isVeeamJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()    — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { fetchGreenhouseJobs } from './ats-clients/greenhouse-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const VEEAM_KEY = 'veeam';
export const VEEAM_COMPANY_NAME = 'Veeam Software';
export const VEEAM_COMPANY_DOMAIN = 'veeam.com';

const CAREER_URL = 'https://careers.veeam.com/search-jobs';
// See discovery note above — not derivable via extractGreenhouseBoardToken().
const GREENHOUSE_BOARD = 'veeamsoftware';

const SECTOR = 'IT / Software (backup, data resilience & AI security)';

// Veeam Software Group GmbH — Swiss legal seat, Baar ZG.
// Confirmed via Veeam's own official contacts page
// (https://www.veeam.com/company/contacts.html → "Linden Park, Lindenstr.
// 16, Baar, CH-6340") cross-checked against Zefix (Swiss commercial
// registry, entity CHE / firm id 1036504, "Veeam Software Group GmbH",
// Baar ZG). No fallback/guess used.
const HQ = {
  city: 'Baar',
  canton: 'ZG',
  postalCode: '6340',
  streetAddress: 'Lindenstrasse 16',
  region: 'Zug',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// Same inline entity-decode pattern as scripts/lib/adus-klinik-job-parser.mjs
// — Greenhouse `content` on this board is HTML-entity-encoded (see file
// header note), so this MUST run before stripHtml() sees the string.
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
 * Check if a job belongs to Veeam Software.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isVeeamJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === VEEAM_KEY ||
    key.startsWith('veeam') ||
    company.includes('veeam') ||
    url.includes('veeam.com') ||
    url.includes('greenhouse.io/veeamsoftware') ||
    url.includes('greenhouse.io/veeam')
  );
}

/**
 * Validate that a URL belongs to Veeam's domain or its Greenhouse board.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'veeam.com' ||
      host.endsWith('.veeam.com') ||
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
  if (/\b(vendita|sales|verkauf|commerce|account executive)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse|supply\s*chain)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm|engineer|security|cloud|data)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal|recruit|talent)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|graduate)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|principal|staff)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(intern(ship)?|stage|apprendist|lehrling)/.test(t)) return 'INTERN';
  if (/\b(contract|contractor|temporary|befristet)/.test(t)) return 'CONTRACTOR';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein|regular)/.test(t)) return 'FULL_TIME';
  return 'FULL_TIME';
}

/**
 * Pick best city / postal code / street / region for a Veeam posting,
 * falling back to the documented Baar ZG HQ address when the Greenhouse
 * `location.name` carries no city (most Swiss postings are simply "Remote,
 * Switzerland") or explicitly names Baar.
 *
 * City-gated, NOT canton-gated — mirrors
 * scripts/lib/staubli-job-parser.mjs's resolveAddress(): a posting merely
 * sharing ZG canton with some other ZG municipality must NOT silently
 * inherit the Baar street address.
 *
 * @param {string} locationName Raw Greenhouse `location.name` string.
 */
function resolveAddress(locationName = '') {
  const parts = String(locationName || '').split(',').map((s) => s.trim()).filter(Boolean);
  // "Remote, Switzerland" → first token "Remote" is not a real city; treat
  // it (and the bare country name) as "no city" rather than a place name.
  const rawCity = parts.find((p) => !/^remote$/i.test(p) && !/^(switzerland|schweiz|suisse|svizzera)$/i.test(p)) || '';
  const city = rawCity;
  const cityMatchesHq = !city || /\bbaar\b/i.test(city);

  return {
    city: city || HQ.city,
    postalCode: cityMatchesHq ? HQ.postalCode : '',
    streetAddress: cityMatchesHq ? HQ.streetAddress : '',
  };
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

// Veeam's board lists postings from many countries; the shared client's
// `locationContains` matches against BOTH `location.name` AND `offices[]`,
// and this board's `offices[]` entries are frequently just "Switzerland" /
// "Remote" style umbrella labels shared across many non-Swiss reqs too —
// so like scandit-job-parser.mjs we fetch unfiltered and match strictly on
// the resolved primary `location.name` string ourselves.
const SWISS_LOCATION_RE = /switzerland|schweiz|suisse|svizzera|\bbaar\b|\bzug\b/i;

async function fetchJobListings() {
  const jobs = await fetchGreenhouseJobs(GREENHOUSE_BOARD, {
    includeContent: true,
    companyName: VEEAM_COMPANY_NAME,
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
 * Fetch all Veeam Software jobs (Switzerland only).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllVeeamJobs() {
  console.log(`🔍 Fetching ${VEEAM_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL} (Greenhouse board "${GREENHOUSE_BOARD}")\n`);

  const listings = await fetchJobListings();
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
    const location = normalizeSpace(listing.location || city || HQ.city);
    const canton = inferSwissTargetCanton(location) || inferSwissTargetCanton(city) || HQ.canton;

    const descriptionHtml = decodeHtmlEntities(listing.description || '');
    const descriptionText = stripHtml(descriptionHtml);
    const description = descriptionText || `${title} — ${VEEAM_COMPANY_NAME}`;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} veeam ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(title);
    const postedDate = (listing.postedAt && String(listing.postedAt).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${VEEAM_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: VEEAM_COMPANY_NAME,
      companyKey: VEEAM_KEY,
      companyDomain: VEEAM_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: city || HQ.city,
      canton,
      url: publicUrl,
      source: 'Veeam Software Dedicated Parser (Greenhouse)',
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
      contract: employmentType === 'CONTRACTOR' ? 'contract' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      department: '',
      jobReqId: listing.jobReqId || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      _targetScope: { canton, location: city || HQ.city },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${VEEAM_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
