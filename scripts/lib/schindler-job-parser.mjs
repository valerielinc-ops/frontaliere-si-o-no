#!/usr/bin/env node
/**
 * Schindler job parser — SmartRecruiters API consumer.
 *
 * Source: https://api.smartrecruiters.com/v1/companies/Schindler/postings
 *
 * Pagination + transport are delegated to the shared SmartRecruiters client
 * (`scripts/lib/ats-clients/smartrecruiters-client.mjs`). This file only owns
 * Schindler-specific concerns:
 *   - Country/location filter (CH via `locationCountryCodes` + Swiss-region
 *     fallback for postings where the country code is missing)
 *   - Canton inference + ParsedJob assembly (id, slug, sector, employmentType,
 *     experienceLevel, …)
 *   - Description extraction policy: "first non-empty jobAd section among
 *     [jobDescription, qualifications, additionalInformation]" (preserved from
 *     pre-extraction behaviour for byte-identical output).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSchindlerJobs()  — Fetch and parse all jobs
 *   - isSchindlerJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()        — Validate URLs belong to this company
 *   - slugify() / stripHtml()  — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton, isTargetSwissLocation } from './target-swiss-locations.mjs';
import {
  fetchSmartRecruitersJobs,
  SmartRecruitersApiError,
} from './ats-clients/smartrecruiters-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SCHINDLER_KEY = 'schindler';
export const SCHINDLER_COMPANY_NAME = 'Schindler';
export const SCHINDLER_COMPANY_DOMAIN = 'schindler.com';

const SR_TENANT = 'Schindler';
const CAREER_URL = `https://jobs.smartrecruiters.com/${SR_TENANT}`;
const SR_API = `https://api.smartrecruiters.com/v1/companies/${SR_TENANT}/postings`;
const SR_PAGE_DELAY_MS = 2000;
const SR_REQUEST_TIMEOUT_MS = 5000;
const SR_USER_AGENT = 'FrontaliereTicino-Bot/1.0 (+https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Schindler.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isSchindlerJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SCHINDLER_KEY ||
    key.startsWith('schindler') ||
    company.includes('schindler') ||
    url.includes('schindler.com') ||
    url.includes('schindler.ch') ||
    url.includes('smartrecruiters.com/schindler') ||
    url.includes('jobs.smartrecruiters.com/schindler')
  );
}

/**
 * Validate that a URL belongs to Schindler or its SmartRecruiters tenant.
 * SmartRecruiters hosts the public-facing apply pages under
 * `jobs.smartrecruiters.com/Schindler/...` — those are first-party for our
 * trust model since they are the canonical apply destination.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host === 'schindler.com' || host.endsWith('.schindler.com')) return true;
    if (host === 'schindler.ch' || host.endsWith('.schindler.ch')) return true;
    if (host === 'jobs.smartrecruiters.com' || host === 'smartrecruiters.com') {
      return /\/schindler(\/|$)/i.test(url.pathname);
    }
    if (host === 'api.smartrecruiters.com') {
      return /\/companies\/schindler(\/|$)/i.test(url.pathname);
    }
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

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── SmartRecruiters Posting Helpers ───────────────────────── */

/**
 * Decide whether a SmartRecruiters posting is in Switzerland. Used as a
 * custom filter passed to the shared client (the client's built-in
 * `locationCountryCodes` filter accepts postings with no country code; we
 * still want them only if the human-readable string resolves to a Swiss
 * target region — hence this hybrid predicate).
 */
function isSwissPosting(posting) {
  const country = String(posting?.location?.country?.code || posting?.location?.country || '').toLowerCase();
  if (country === 'ch') return true;
  if (country && country !== 'ch') return false;
  const text = composeLocationText(posting?.location);
  if (!text) return false;
  return isTargetSwissLocation(text, { includeGrigioni: true });
}

/**
 * Build a single human-readable location string from a SmartRecruiters
 * posting `location` object. Falls back through fullLocation → city +
 * region → country.
 */
function composeLocationText(loc = {}) {
  if (!loc || typeof loc !== 'object') return '';
  if (typeof loc.fullLocation === 'string' && loc.fullLocation.trim()) {
    return loc.fullLocation.trim();
  }
  const parts = [loc.city, loc.region, loc.country?.name || loc.country]
    .filter((part) => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.trim());
  return parts.join(', ');
}

/**
 * Extract a description string from `posting.jobAd.sections.jobDescription`
 * when the field is populated. SmartRecruiters returns either rich-text
 * HTML or plain text in `text`; both are accepted and stripped of HTML.
 *
 * Policy (preserved verbatim from the pre-extraction implementation): take
 * the FIRST non-empty section among [jobDescription, qualifications,
 * additionalInformation]. The shared client offers a concatenated
 * `descriptionHtml`; Schindler intentionally does NOT use it to keep
 * downstream localisation token budgets stable.
 */
function extractPostingDescription(posting) {
  const sections = posting?.jobAd?.sections;
  if (!sections || typeof sections !== 'object') return '';
  const candidates = [
    sections.jobDescription,
    sections.qualifications,
    sections.additionalInformation,
  ];
  for (const section of candidates) {
    const raw = typeof section?.text === 'string' ? section.text : '';
    if (raw && raw.trim().length > 0) return raw;
  }
  return '';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch all Schindler jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllSchindlerJobs() {
  console.log(`🔍 Fetching Schindler jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);
  console.log(`   Fetching from: ${SR_API}`);

  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || SR_REQUEST_TIMEOUT_MS;
  const userAgent = process.env.JOBS_CRAWLER_USER_AGENT || SR_USER_AGENT;

  const jobs = [];
  let yielded = 0;
  try {
    const iter = fetchSmartRecruitersJobs(SR_TENANT, {
      company: SCHINDLER_COMPANY_NAME,
      // Country-code is the primary signal; the custom filter handles the
      // "missing country code" fallback via `isTargetSwissLocation`.
      locationCountryCodes: ['ch'],
      filter: isSwissPosting,
      // Schindler intentionally consumes the listing payload only — the
      // jobDescription text is present on the listing posting object via
      // `jobAd.sections` because the SR API includes it for the Schindler
      // tenant. Leaving `fetchDetail: false` preserves the legacy fetch
      // count (no extra detail call per posting).
      fetchDetail: false,
      maxPages: 50,
      minDelayMs: SR_PAGE_DELAY_MS,
      timeoutMs,
      userAgent,
    });

    for await (const normalized of iter) {
      yielded += 1;
      const posting = normalized.rawPosting || {};
      const title = normalizeSpace(posting?.name || '');
      if (!title || title.length < 3) continue;

      const locationText = composeLocationText(posting?.location) || 'Switzerland';
      const city = (posting?.location?.city && String(posting.location.city).trim())
        || locationText.split(',')[0].trim();
      const canton = inferSwissTargetCanton(locationText) || inferSwissTargetCanton(city) || 'LU';

      const descriptionRaw = extractPostingDescription(posting);
      const descriptionText = stripHtml(descriptionRaw);

      // SmartRecruiters publishes both an authenticated apply URL and a
      // public-facing job page. Prefer `applyUrl`; fall back to the
      // canonical jobs.smartrecruiters.com URL composed from the posting id.
      const postingId = String(posting?.id || '').trim();
      const publicUrl =
        (typeof posting?.applyUrl === 'string' && posting.applyUrl) ||
        (postingId ? `https://jobs.smartrecruiters.com/Schindler/${postingId}` : CAREER_URL);

      const sourceLang = detectLang(descriptionText || title, 'en');
      const jobSlug = slugify(`${title} schindler ${city || 'ch'}`);
      const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

      // Date: prefer `releasedDate` (ISO); otherwise `createdOn`; default to today.
      const releasedRaw = posting?.releasedDate || posting?.createdOn || '';
      const postedDate = (() => {
        if (!releasedRaw) return new Date().toISOString().slice(0, 10);
        const d = new Date(releasedRaw);
        if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
        return d.toISOString().slice(0, 10);
      })();

      const job = {
        // ── Required fields ──
        id: `schindler-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: SCHINDLER_COMPANY_NAME,
        companyKey: SCHINDLER_KEY,
        companyDomain: SCHINDLER_COMPANY_DOMAIN,
        title,
        titleByLocale: { [sourceLang]: title },
        description: descriptionText || `${title} — Schindler`,
        descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Schindler` },
        location: city || locationText,
        canton,
        url: publicUrl,
        source: 'Schindler Dedicated Parser (SmartRecruiters API)',
        sourceLang,
        crawledAt: new Date().toISOString(),

        // ── Recommended fields ──
        addressLocality: city || locationText,
        addressRegion: canton,
        addressCountry: 'CH',
        country: 'CH',
        category: detectCategory(title),
        contract: 'full-time',
        employmentType: detectEmploymentType(`${posting?.typeOfEmployment?.id || ''} ${title}`),
        experienceLevel: detectExperienceLevel(title),
        sector: 'Industrial',
        currency: 'CHF',
        featured: false,
        postedDate,
        applyUrl: publicUrl,
        jobReqId: postingId || null,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
      };

      jobs.push(job);
    }
  } catch (err) {
    if (err instanceof SmartRecruitersApiError) {
      console.warn(`  ⚠️ SmartRecruiters API error: ${err.message} (status=${err.statusCode ?? 'n/a'})`);
    }
    throw err;
  }

  console.log(`  ✅ SmartRecruiters Swiss postings yielded: ${yielded}`);
  console.log(`\n📋 Total Schindler jobs discovered: ${jobs.length}`);
  return jobs;
}
