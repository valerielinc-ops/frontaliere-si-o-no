#!/usr/bin/env node
/**
 * Mistral AI job parser — Fetcher and job builder.
 *
 * Source: https://jobs.ashbyhq.com/mistral.ai
 *
 * Mistral AI migrated its careers portal from Lever
 * (https://jobs.lever.co/mistral, now permanently "No job postings currently
 * open") to Ashby (https://jobs.ashbyhq.com/mistral.ai, ~164 live roles). The
 * public Lever JSON API still answers HTTP 200 but with an empty array, so the
 * old fetcher silently returned 0 jobs even though the company is actively
 * hiring — including Zurich-based research roles (issue #4145). This parser now
 * reads the Ashby posting API.
 *
 * Exports the required functions for the crawler template:
 *   - fetchAllMistralAiJobs()  — Fetch and parse all jobs
 *   - isMistralAiJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()        — Validate URLs belong to this company
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { fetchWithRetry } from './transient-fetch.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const MISTRAL_AI_KEY = 'mistral-ai';
export const MISTRAL_AI_COMPANY_NAME = 'Mistral AI';
export const MISTRAL_AI_COMPANY_DOMAIN = 'mistral.ai';

// Ashby job-board slug (note the literal dot — the board is "mistral.ai", not
// "mistral"). The public posting API returns every listed role in one call.
const ASHBY_BOARD_SLUG = 'mistral.ai';
const ASHBY_HOST = 'jobs.ashbyhq.com';
const CAREER_URL = `https://${ASHBY_HOST}/${ASHBY_BOARD_SLUG}`;
const ASHBY_API_URL = `https://api.ashbyhq.com/posting-api/job-board/${ASHBY_BOARD_SLUG}?includeCompensation=true`;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Mistral AI.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isMistralAiJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === MISTRAL_AI_KEY ||
    key.startsWith('mistral-ai') ||
    company.includes('mistral ai') ||
    url.includes('mistral.ai') ||
    url.includes(`${ASHBY_HOST}/${ASHBY_BOARD_SLUG}`)
  );
}

/**
 * Validate that a URL belongs to Mistral AI's domain or its Ashby job board.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host === 'mistral.ai' || host.endsWith('.mistral.ai')) return true;
    if (host === ASHBY_HOST) {
      const path = url.pathname.toLowerCase();
      const slug = ASHBY_BOARD_SLUG.toLowerCase();
      return path.startsWith(`/${slug}/`) || path === `/${slug}`;
    }
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(scientist|research|researcher|r&d|ml|machine learning|ai\b)/.test(t)) return 'Ricerca';
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
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
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Map Ashby's `employmentType` enum to a schema.org employmentType, falling
 * back to a title/text heuristic when the field is absent/unknown.
 */
const ASHBY_EMPLOYMENT_TYPE = {
  fulltime: 'FULL_TIME',
  parttime: 'PART_TIME',
  intern: 'INTERN',
  contract: 'CONTRACTOR',
  temporary: 'TEMPORARY',
};

function mapEmploymentType(ashbyType = '', text = '') {
  const mapped = ASHBY_EMPLOYMENT_TYPE[normalize(ashbyType).replace(/[^a-z]/g, '')];
  if (mapped) return mapped;
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Ashby Swiss-location helpers (pure, unit-tested) ──────────
 * Mistral is a global org (~164 open roles, mostly Paris). A role targets
 * Switzerland either via its PRIMARY `location`/`address` or one of its
 * `secondaryLocations` (e.g. "Research Engineer, Machine Learning" has
 * primary location "Paris" but a secondary "Zurich" office). We must inspect
 * both, and — for a matched role — surface the Swiss location string (not the
 * Paris primary) so canton inference lands in CH.
 */
const SWISS_COUNTRY_NEEDLES = ['switzerland', 'suisse', 'schweiz', 'svizzera'];
const SWISS_LOCATION_NEEDLES = [
  'switzerland', 'suisse', 'schweiz', 'svizzera',
  'zurich', 'zürich', 'zuerich',
  'geneva', 'genève', 'geneve', 'genf', 'ginevra',
  'lausanne', 'basel', 'basle', 'bern', 'berne', 'lugano', 'zug', 'winterthur',
];

function isSwissLocationEntry(entry) {
  const country = normalize(entry?.address?.postalAddress?.addressCountry || '');
  if (SWISS_COUNTRY_NEEDLES.some((n) => country.includes(n))) return true;
  const locality = normalize(entry?.address?.postalAddress?.addressLocality || '');
  const label = normalize(entry?.location || '');
  const hay = `${label} ${locality}`;
  return SWISS_LOCATION_NEEDLES.some((n) => hay.includes(n));
}

/**
 * Flatten an Ashby posting into its location entries (primary first, then
 * secondary offices). Each entry keeps its `location` label + `address`.
 */
export function ashbyLocationEntries(job) {
  const entries = [];
  if (job?.location || job?.address) {
    entries.push({ location: job?.location || '', address: job?.address });
  }
  if (Array.isArray(job?.secondaryLocations)) {
    for (const sec of job.secondaryLocations) {
      if (!sec || typeof sec !== 'object') continue;
      entries.push({ location: sec?.location || '', address: sec?.address });
    }
  }
  return entries;
}

/** Does this Ashby posting target a Swiss office (primary or secondary)? */
export function isSwissAshbyJob(job) {
  return ashbyLocationEntries(job).some(isSwissLocationEntry);
}

/**
 * Pick the Swiss location LABEL for a matched posting (prefer the Swiss entry
 * over a non-Swiss primary), falling back to the primary location text.
 */
export function pickSwissLocationLabel(job) {
  const entries = ashbyLocationEntries(job);
  const swiss = entries.find(isSwissLocationEntry);
  const label = normalizeSpace(swiss?.location || entries[0]?.location || '');
  return label || 'Zurich';
}

/* ── Ashby fetcher ─────────────────────────────────────────── */

const TIMEOUT_MS = 20_000;
const POLITE_UA = 'FrontaliereTicino-Bot/1.0 (+https://frontaliereticino.ch/bot)';

async function fetchAshbyBoard() {
  return fetchWithRetry(
    async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      let res;
      try {
        res = await fetch(ASHBY_API_URL, {
          signal: ac.signal,
          headers: { 'User-Agent': POLITE_UA, Accept: 'application/json' },
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const err = new Error(`Ashby API ${res.status} ${res.statusText} for ${ASHBY_API_URL}`);
        err.statusCode = res.status;
        throw err;
      }
      const json = await res.json();
      const jobs = Array.isArray(json?.jobs) ? json.jobs : null;
      if (!jobs) {
        const err = new Error(`Ashby API returned unexpected body shape for ${ASHBY_API_URL}`);
        err.nonTransient = true;
        throw err;
      }
      return jobs;
    },
    {
      label: `ashby ${ASHBY_API_URL}`,
      isTransient: (err) => {
        if (err?.nonTransient) return false;
        const code = err?.statusCode;
        // Network/abort (no status) → transient; otherwise only 5xx.
        return code == null || code >= 500;
      },
    },
  );
}

async function fetchJobListings() {
  const board = await fetchAshbyBoard();
  const listings = [];
  for (const raw of board) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.isListed === false) continue;
    if (!isSwissAshbyJob(raw)) continue;
    listings.push({
      title: normalizeSpace(raw.title || ''),
      location: pickSwissLocationLabel(raw),
      url: String(raw.jobUrl || raw.applyUrl || CAREER_URL),
      postedAt: raw.publishedAt || null,
      description: typeof raw.descriptionHtml === 'string' ? raw.descriptionHtml : '',
      jobReqId: String(raw.id || ''),
      employmentType: raw.employmentType || '',
    });
  }
  return listings;
}

/**
 * Fetch all Mistral AI jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllMistralAiJobs() {
  console.log(`🔍 Fetching Mistral AI jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Swiss job listings returned.');
    return [];
  }

  console.log(`  📋 Swiss listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const location = listing.location || 'Zurich';
    const canton = inferSwissTargetCanton(location) || 'ZH';
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} mistral-ai ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `mistral-ai-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: MISTRAL_AI_COMPANY_NAME,
      companyKey: MISTRAL_AI_KEY,
      companyDomain: MISTRAL_AI_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Mistral AI`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Mistral AI` },
      location,
      canton,
      url: publicUrl,
      source: 'Mistral AI Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: mapEmploymentType(listing.employmentType, title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Intelligenza Artificiale / Ricerca',
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedAt
        ? new Date(listing.postedAt).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Mistral AI jobs discovered: ${jobs.length}`);
  return jobs;
}
