#!/usr/bin/env node
/**
 * Selecta AG job parser — eRecruiter ATS (Hutter Consult AG), careers.selecta.ch.
 *
 * Discovery note (issue #3337 backlog): the backlog tagged Selecta's ATS as
 * "Custom" — that label is WRONG. `careers.selecta.ch` is not a homegrown
 * vending-company inventory tool; it runs the Swiss "eRecruiter" applicant
 * portal product (confirmed live: cookie names `eRecruiterCookieConsent`,
 * and an inline comment literally reading `eRecruiter.ApplicantPortal:
 * Version 2.74.0.15` in the page source, plus `/Login?job={id}` apply
 * links). eRecruiter is not one of the shared ATS clients already wired up
 * in `scripts/lib/ats-clients/` (Workday, SmartRecruiters, Greenhouse,
 * Lever, SuccessFactors, Personio, csod) — no shared client exists for it
 * in this codebase, so this is a bespoke HTML/inline-JSON scraper rather
 * than a shared-client reuse.
 *
 * Listing page (https://careers.selecta.ch/Jobs) server-renders the FULL
 * job list as an inline JSON payload passed to the page's Mustache-hydration
 * call `new JobList($("#jobListPlaceholder"), $("#jobListTemplate"), {...})`
 * — every open Swiss posting (id/title/subtitle/location/date) is already in
 * that single fetch (confirmed live: `TotalJobsCount` matches `Jobs.length`,
 * `DisplayPagination: false` — no pagination needed at Selecta's current
 * headcount of ~20 open Swiss reqs). `extractJobListPayload()` below pulls
 * that object out with a brace-matching scan (safer than a greedy regex
 * against nested JSON) and `JSON.parse`s it directly — no HTML parsing
 * needed for the listing step at all.
 *
 * Per-job detail is fetched separately from
 * `https://careers.selecta.ch/Job/{Id}`. That page DOES carry a
 * `application/ld+json` JobPosting block, but it is an EMPTY skeleton
 * (`"description":""`, `"hiringOrganization":{"name":""}`) — eRecruiter
 * ships the schema.org markup without populating it — so this parser
 * builds the description itself from the visible `.jobAdContent` HTML
 * block (company blurb + `Arbeitsort`/`Hauptaufgaben`/`Ausbildung`/`Profil`
 * table rows) instead of trusting that JSON-LD.
 *
 * Selecta AG legal HQ: Hinterbergstrasse 16, 6312 Steinhausen ZG — confirmed
 * via Moneyhouse's company extract (mirrors the Swiss commercial register /
 * Zefix record), which shows the registered seat moved to Steinhausen per
 * SHAB publication No. 154 of 13.08.2025 (previously Cham ZG — do NOT use
 * the older Cham address, it is stale as of this seat change). NOT Rotkreuz
 * ZG either (a plausible-looking but wrong guess that appears in some older
 * secondary sources — Rotkreuz is a Zug-area town but was never Selecta's
 * registered seat).
 *
 * Selecta's Swiss postings are almost entirely field/route-service roles
 * (Automatenbetreuer vending-route technicians, drivers, telesales,
 * apprenticeships) posted against a "coverage region" string (e.g. "Region
 * Solothurn", "Region Berner Oberland", "Kirchberg BE" — the latter is
 * Selecta's Swiss logistics/ops hub, NOT the Steinhausen legal seat), so
 * `resolveAddress()` below gates the HQ street/postal fallback on the job's
 * own resolved CITY TEXT literally naming Steinhausen, never on canton (ZG)
 * alone — mirroring `scripts/lib/staubli-job-parser.mjs`'s `resolveAddress()`
 * and the recurring canton-only-gating bug class flagged in AGENTS.md #7. A
 * region string that cannot be resolved to any single canton (e.g. the
 * multi-canton "Westschweiz") falls back to the FULL HQ address rather than
 * being dropped — same safe-default-never-drop pattern as
 * `scripts/lib/postauto-job-parser.mjs`'s `resolveAddress()`.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSelectaJobs() — Fetch and parse all Selecta jobs
 *   - isSelectaJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()     — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang, workloadPercent } from './dedicated-crawler-common.mjs';
import { fetchHtml, slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SELECTA_KEY = 'selecta';
export const SELECTA_COMPANY_NAME = 'Selecta';
export const SELECTA_COMPANY_DOMAIN = 'selecta.com';

const LISTING_URL = 'https://careers.selecta.ch/Jobs';
const ATS_HOST = 'careers.selecta.ch';

const SECTOR = 'Vending / Food & Coffee Tech';

// Selecta AG HQ — Hinterbergstrasse 16, 6312 Steinhausen ZG. See module
// docblock for the Moneyhouse/Zefix source + Cham→Steinhausen seat-move note.
const HQ = {
  city: 'Steinhausen',
  canton: 'ZG',
  postalCode: '6312',
  streetAddress: 'Hinterbergstrasse 16',
  region: 'Zug',
};

// Colloquial Swiss region phrases Selecta uses in its own postings that
// `inferAnyCanton()` cannot resolve on their own (not a canton or municipality
// alias) but which unambiguously mean one canton.
const REGION_CANTON_HINTS = [
  [/\bberner\s*oberland\b/i, 'BE'],
];

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/**
 * Pull the inline JSON payload out of the listing page's
 * `new JobList($(...), $(...), {...})` hydration call via brace-matching
 * (safer than a greedy regex against deeply nested JSON — a naive
 * `/\{.*\}/` would either under- or over-match on the surrounding markup).
 *
 * @param {string} html Listing page HTML.
 * @returns {object|null} Parsed payload, or null if not found/invalid.
 */
function extractJobListPayload(html = '') {
  const marker = '"RegionsViewModel"';
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) return null;
  const startIdx = html.lastIndexOf('{', markerIdx);
  if (startIdx === -1) return null;

  let depth = 0;
  for (let i = startIdx; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const jsonStr = html.slice(startIdx, i + 1);
        try {
          return JSON.parse(jsonStr);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Extract the job detail page's visible `.jobAdContent` block (company
 * blurb + Arbeitsort/Arbeitsbeginn/Hauptaufgaben/Ausbildung/Profil table),
 * stopping before the "Jetzt online Bewerben" apply button so that button
 * label never leaks into the description text.
 *
 * @param {string} html Job detail page HTML.
 * @returns {string} Raw (still-HTML) content block, or '' if not found.
 */
function extractJobAdContent(html = '') {
  const startTag = '<div class="jobAdContent">';
  const startIdx = html.indexOf(startTag);
  if (startIdx === -1) return '';
  const endMarkers = ['<div class="jobBlock jobApply">', '<div class="jobAdFooter">'];
  let endIdx = -1;
  for (const marker of endMarkers) {
    const idx = html.indexOf(marker, startIdx);
    if (idx !== -1 && (endIdx === -1 || idx < endIdx)) endIdx = idx;
  }
  const slice = endIdx === -1 ? html.slice(startIdx) : html.slice(startIdx, endIdx);
  return slice.slice(startTag.length);
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Selecta.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isSelectaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SELECTA_KEY ||
    key.startsWith('selecta') ||
    company.includes('selecta') ||
    url.includes('careers.selecta.ch') ||
    url.includes('selecta.com')
  );
}

/**
 * Validate that a URL belongs to Selecta's marketing domain or the
 * eRecruiter ATS host that actually serves the job postings.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === ATS_HOST ||
      host === 'selecta.com' ||
      host.endsWith('.selecta.com')
    );
  } catch {
    return false;
  }
}

/* ── Category / experience / employment-type detection ───────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ausbildung|lehre|lernend|apprenti|efz)\b/.test(t)) return 'Formazione';
  if (/\b(automatenbetreuer|kundenbetreuer|customer)\b/.test(t)) return 'Assistenza Clienti';
  if (/\b(chauffeur|fahrer|driver|lenker)\b/.test(t)) return 'Logistica';
  if (/\b(telesales|sales|verkauf|account manager|vendita|key account)\b/.test(t)) return 'Commerciale';
  if (/\b(techniker|technicien|projekttechniker|servicetechniker)\b/.test(t)) return 'Tecnica';
  if (/\b(mitarbeiter kundendienst|administra|hr|human resources)\b/.test(t)) return 'Amministrazione';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|ausbildung)\b/.test(t)) return 'intern';
  if (/\b(junior|jr)\b/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|leiterin)\b/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Derive schema.org `employmentType` from the posting's title + subtitle
 * (subtitle carries the workload percentage and contract-type wording, e.g.
 * "100% - Befristete Anstellung (...)" or "70% (Einsatz Montag - Samstag...)").
 */
function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(ausbildung|lehrstelle|lernende|apprenti)\b/.test(t)) return 'INTERN';
  // Range-aware (#3482 class): "60% - 100%" classifies by upper bound via
  // the shared helper, a single value by first match.
  const percent = workloadPercent(t);
  if (Number.isFinite(percent) && percent > 0 && percent < 90) return 'PART_TIME';
  if (/\b(befristet|aushilfe|temporary|zeitarbeit)\b/.test(t)) return 'CONTRACTOR';
  return 'FULL_TIME';
}

/* ── Address / canton resolution ──────────────────────────────
 * Selecta posts almost every Swiss role against a "coverage region" string,
 * not the Steinhausen legal seat — resolveAddress() gates the HQ street/
 * postal fallback on the job's own resolved CITY TEXT literally naming
 * Steinhausen (regex), NEVER on canton (ZG) alone, so a job merely sharing
 * ZG canton with Steinhausen (e.g. "Zug", "Cham", "Rotkreuz") does NOT
 * silently inherit the HQ street address. Mirrors
 * scripts/lib/staubli-job-parser.mjs's resolveAddress() (AGENTS.md #7).
 *
 * An unresolvable region (no single canton match, e.g. "Westschweiz") falls
 * back to the FULL HQ address rather than being dropped — same
 * never-drop safe-default pattern as
 * scripts/lib/postauto-job-parser.mjs's resolveAddress().
 */
export function resolveAddress(rawLocation = '') {
  // Drop a trailing scheduling parenthetical, e.g. "Winterthur (Start 1.
  // Juni 2026 oder nach Vereinbarung)" → "Winterthur".
  const cleaned = normalizeSpace(rawLocation).replace(/\([^)]*\)\s*$/, '').trim();
  // "Region " is Selecta's own vocabulary for "coverage area", not a place
  // name — strip it so canton/city inference matches the informative
  // remainder ("Solothurn", "Sursee", "Berner Oberland", ...).
  const withoutRegionPrefix = cleaned.replace(/^region\s+/i, '').trim();
  const city = withoutRegionPrefix || cleaned;

  let canton = inferAnyCanton(withoutRegionPrefix) || inferAnyCanton(cleaned) || '';
  if (!canton) {
    for (const [re, code] of REGION_CANTON_HINTS) {
      if (re.test(cleaned)) {
        canton = code;
        break;
      }
    }
  }

  if (city && canton) {
    const isHqCity = /\bsteinhausen\b/i.test(city);
    return {
      city,
      canton,
      postalCode: isHqCity ? HQ.postalCode : '',
      streetAddress: isHqCity ? HQ.streetAddress : '',
    };
  }

  // Unmapped/empty location → safe HQ fallback, never dropped.
  return {
    city: HQ.city,
    canton: HQ.canton,
    postalCode: HQ.postalCode,
    streetAddress: HQ.streetAddress,
  };
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch and parse the listing page's inline JSON job payload.
 * @returns {Promise<Array<object>>} Raw listing entries (Id/Title/SubTitle/Location/Date/OnlineDateCorrected).
 */
async function fetchJobListings() {
  const html = await fetchHtml(LISTING_URL);
  const payload = extractJobListPayload(html);
  if (!payload || !Array.isArray(payload.Jobs)) return [];
  return payload.Jobs;
}

/**
 * Fetch a single job's detail page and extract its description block.
 * Soft-fails to '' on any per-job fetch error — a single broken detail page
 * must not abort the whole crawl (the listing already has title/location).
 *
 * @param {number|string} id
 * @returns {Promise<string>} Plain-text description, or '' on failure.
 */
async function fetchJobDescription(id) {
  try {
    const html = await fetchHtml(`https://${ATS_HOST}/Job/${id}`);
    const contentHtml = extractJobAdContent(html);
    if (!contentHtml) return '';
    return normalizeSpace === null ? stripHtml(contentHtml) : stripHtml(contentHtml).trim();
  } catch (err) {
    console.warn(`  ⚠️ Selecta: failed to fetch detail for job ${id}: ${err?.message || err}`);
    return '';
  }
}

/**
 * Fetch all Selecta jobs (Switzerland — this employer has no other market).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled by the
 * AI localization step and translate-pending pipeline.
 */
export async function fetchAllSelectaJobs() {
  console.log(`🔍 Fetching ${SELECTA_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL} (eRecruiter ATS)\n`);

  let listings;
  try {
    listings = await fetchJobListings();
  } catch (err) {
    console.error(`❌ Selecta: failed to fetch listing page: ${err?.message || err}`);
    return [];
  }
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  const seen = new Set();
  for (const listing of listings) {
    const title = normalizeSpace(listing.Title || '');
    if (!title || title.length < 3) continue;
    const id = listing.Id;
    if (id == null) continue;

    const publicUrl = `https://${ATS_HOST}/Job/${id}`;
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    const subTitle = normalizeSpace(listing.SubTitle || '');
    const rawLocation = normalizeSpace(listing.Location || '');
    const { city, canton, postalCode, streetAddress } = resolveAddress(rawLocation);
    const location = rawLocation || city || HQ.city;

    const descriptionText = normalizeSpace(await fetchJobDescription(id));
    const description = descriptionText
      || `${title} (${subTitle || 'n/d'}) — ${SELECTA_COMPANY_NAME}, ${location}.`;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} selecta ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(`${subTitle} ${title}`);

    // .NET "/Date(epoch_ms)/" wire format — more reliable than the
    // locale-ambiguous "dd.mm.yyyy" Date string also present on the listing.
    const epochMatch = String(listing.OnlineDateCorrected || '').match(/\/Date\((\d+)\)\//);
    const postedDate = epochMatch
      ? new Date(Number(epochMatch[1])).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${SELECTA_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SELECTA_COMPANY_NAME,
      companyKey: SELECTA_KEY,
      companyDomain: SELECTA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: city || HQ.city,
      canton,
      url: publicUrl,
      source: 'Selecta Dedicated Parser (eRecruiter)',
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
      jobReqId: String(id),
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      _targetScope: { canton, location: city || HQ.city },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${SELECTA_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { slugify, stripHtml };
