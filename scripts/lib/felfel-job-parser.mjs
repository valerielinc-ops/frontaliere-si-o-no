#!/usr/bin/env node
/**
 * FELFEL job parser — Personio ATS (tenant subdomain "felfel").
 *
 * FELFEL is a Zürich-founded office-catering / foodtech company (micro-markets,
 * "Gavetti" coffee machines, meal subscriptions for Swiss offices), HQ at
 * Räffelstrasse 24, 8045 Zürich ZH (confirmed via northdata/Moneyhouse
 * Handelsregister entry + local.ch/search.ch directory listings).
 *
 * Public job feed: the free, unauthenticated Personio XML feed at
 *   https://felfel.jobs.personio.de/xml
 * (verified live: 13 open positions as of this writing). Fetching + XML
 * parsing + normalisation to vendor-agnostic shape is entirely delegated to
 * the shared client `./ats-clients/personio-client.mjs` — this module only
 * owns FELFEL-specific concerns: office→canton/city mapping, category /
 * employment-type detection, and the final job-object shape.
 *
 * Personio's `<office>` field is a bare city name with no street/postal
 * code (unlike some SmartRecruiters/Workday feeds). Observed live values:
 * "Zürich" (bulk of postings, matches HQ), "Lausanne" (VD satellite office,
 * no confirmed street address — left blank so the build-time JobPosting
 * schema safe-default fills a city-based postal code) and "New York" (US —
 * explicitly foreign, filtered out via `isLocationExplicitlyForeign`, same
 * as every other dedicated parser with a global ATS tenant). Any other/
 * unrecognised office string still gets a Swiss canton via
 * `inferSwissTargetCanton`, or — only if that also fails — the Zürich HQ
 * fallback; unmapped offices are never silently dropped.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllFelfelJobs() — Fetch and parse all Swiss FELFEL jobs
 *   - isFelfelJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()    — Validate URLs belong to this company / ATS
 *   - FELFEL_KEY / FELFEL_COMPANY_NAME constants
 */
import { createHash } from 'node:crypto';
import { detectLang, isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { fetchPersonioJobs, PersonioApiError, buildPersonioXmlUrl } from './ats-clients/personio-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const FELFEL_KEY = 'felfel';
export const FELFEL_COMPANY_NAME = 'FELFEL';
export const FELFEL_COMPANY_DOMAIN = 'felfel.ch';

const PERSONIO_SUBDOMAIN = 'felfel';
const CAREER_URL = 'https://felfel.jobs.personio.de/';

/* ── HQ fallback (Räffelstrasse 24, 8045 Zürich, ZH) ─────────── */

const HQ = {
  city: 'Zürich',
  canton: 'ZH',
  postalCode: '8045',
  streetAddress: 'Räffelstrasse 24',
};

const SECTOR = 'Foodtech / Catering aziendale';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to FELFEL.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isFelfelJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === FELFEL_KEY ||
    key.startsWith('felfel') ||
    company.includes('felfel') ||
    url.includes('felfel.ch') ||
    url.includes('felfel.jobs.personio.de')
  );
}

/**
 * Validate that a URL belongs to FELFEL's domain OR the Personio ATS host
 * that actually serves the postings.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'felfel.ch' || host.endsWith('.felfel.ch')) return true;
    if (host === 'personio.de' || host.endsWith('.personio.de')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category / Employment Detection ──────────────────────── */

function detectCategory(title = '', department = '') {
  const t = normalize(`${title} ${department}`);
  if (/\b(sales|account executive|account manager|vertrieb|commercial)/.test(t)) return 'Commerciale';
  if (/\b(customer success|customer experience|client success|kundenservice|kundenbetreuung)/.test(t)) return 'Customer Success';
  if (/\b(culinar|kitchen|chef|koch|k[oö]chin|gastronom|barista|catering)/.test(t)) return 'Ristorazione';
  if (/\b(logist|warehouse|lager|fahrer|driver|delivery|magazzin)/.test(t)) return 'Logistica';
  if (/\b(engineer|developer|software|data|it\b)/.test(t)) return 'IT';
  if (/\b(marketing|kommunikation|brand|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(hr\b|human resources|people|talent|recruit|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(finance|controlling|accounting|buchhaltung|contab)/.test(t)) return 'Finanza';
  if (/\b(operations|ops\b|betrieb|operativ)/.test(t)) return 'Operazioni';
  if (/\b(admin|office manager|segret)/.test(t)) return 'Amministrazione';
  return 'Altro';
}

function detectExperienceLevel(title = '', seniority = '', personioEmploymentType = '') {
  const sen = normalize(seniority);
  const pet = normalize(personioEmploymentType);
  if (sen.includes('student') || pet === 'intern') return 'intern';
  if (sen.includes('entry')) return 'junior';
  const t = normalize(title);
  if (/\b(praktikum|praktikant|stage|stagiaire|intern|apprenti|lehrling|lernende)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|chef|responsable|leiter|verantwort)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(schedule = '', title = '') {
  const s = normalize(schedule);
  if (/part.?time/.test(s)) return 'PART_TIME';
  if (/full.?time/.test(s)) return 'FULL_TIME';
  const t = normalize(title);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  return 'FULL_TIME';
}

/* ── Location Resolution ───────────────────────────────────── */

/**
 * Map a Personio `office` string to a Swiss city/canton/address.
 * Falls back to the Zürich HQ when the field is empty or fully unrecognised
 * — an office we can't map still produces a job, it just inherits HQ address
 * fields rather than being dropped.
 */
function resolveOffice(rawOffice = '') {
  const office = normalizeSpace(rawOffice);
  if (!office) {
    return { city: HQ.city, canton: HQ.canton, postalCode: HQ.postalCode, streetAddress: HQ.streetAddress };
  }

  const lower = office.toLowerCase();
  if (/z[uü]rich/.test(lower)) {
    return { city: HQ.city, canton: HQ.canton, postalCode: HQ.postalCode, streetAddress: HQ.streetAddress };
  }
  if (/lausanne/.test(lower)) {
    // Confirmed satellite office, but no public street address on record —
    // left blank so the build-time JobPosting schema fills a safe
    // city-based postal-code default instead of stamping the Zürich HQ
    // street onto a Lausanne (VD) posting.
    return { city: 'Lausanne', canton: 'VD', postalCode: '', streetAddress: '' };
  }

  // Unrecognised office string — try generic Swiss-city inference before
  // giving up to the HQ fallback (still never dropped).
  const inferredCanton = inferSwissTargetCanton(office);
  if (inferredCanton) {
    return { city: office, canton: inferredCanton, postalCode: '', streetAddress: '' };
  }
  return { city: HQ.city, canton: HQ.canton, postalCode: HQ.postalCode, streetAddress: HQ.streetAddress };
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch all FELFEL jobs (Switzerland only) from the shared Personio client.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled by the
 * AI localization step of the translate-pending pipeline.
 */
export async function fetchAllFelfelJobs() {
  console.log(`🔍 Fetching ${FELFEL_COMPANY_NAME} jobs`);
  console.log(`   Source: ${buildPersonioXmlUrl(PERSONIO_SUBDOMAIN)}\n`);

  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || undefined;

  let normalizedJobs;
  try {
    normalizedJobs = await fetchPersonioJobs(PERSONIO_SUBDOMAIN, timeoutMs ? { timeoutMs } : {});
  } catch (err) {
    if (err instanceof PersonioApiError) {
      console.warn(`⚠️ Personio feed fetch failed: ${err.message}`);
      return [];
    }
    throw err;
  }

  if (!normalizedJobs || normalizedJobs.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${normalizedJobs.length}`);

  const jobs = [];
  const seen = new Set();
  for (const nj of normalizedJobs) {
    const title = normalizeSpace(nj.title || '');
    if (!title || title.length < 3) continue;

    const rawOffice = nj.location || '';
    if (isLocationExplicitlyForeign(rawOffice)) {
      console.log(`  ⏭️ Skipped foreign office: ${rawOffice} — ${title}`);
      continue;
    }

    const publicUrl = nj.applyUrl || CAREER_URL;
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    const { city, canton, postalCode, streetAddress } = resolveOffice(rawOffice);
    const location = city || HQ.city;

    const descriptionHtml = nj.descriptionHtml || '';
    const descriptionText = stripHtml(descriptionHtml);
    const description = descriptionText || `${title} bei ${FELFEL_COMPANY_NAME} in ${location}.`;
    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} felfel ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(nj.schedule || '', title);
    const postedDate = (nj.postedAt && String(nj.postedAt).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${FELFEL_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: FELFEL_COMPANY_NAME,
      companyKey: FELFEL_KEY,
      companyDomain: FELFEL_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'FELFEL Dedicated Parser (Personio)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: location,
      addressRegion: canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, nj.department || ''),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title, nj.rawPosition?.seniority || nj.seniority || '', nj.rawPosition?.employmentType || ''),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      jobReqId: nj.jobReqId || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${FELFEL_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
