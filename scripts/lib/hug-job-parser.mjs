#!/usr/bin/env node
/**
 * HUG (Hôpitaux Universitaires de Genève) job parser — SmartRecruiters API.
 *
 * Source: https://careers.smartrecruiters.com/HUG
 * API:    https://api.smartrecruiters.com/v1/companies/HUG/postings
 *
 * Pagination + transport are delegated to the shared SmartRecruiters client
 * (`scripts/lib/ats-clients/smartrecruiters-client.mjs`). This file owns
 * HUG-specific concerns:
 *   - Country/location filter (CH via `locationCountryCodes` + Swiss-region
 *     fallback for postings where the country code is missing)
 *   - Canton inference + ParsedJob assembly
 *   - Description extraction policy: first non-empty jobAd section
 *
 * HUG is the largest French-speaking university hospital in Switzerland,
 * headquartered in Geneva. Default canton is GE.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllHugJobs()  — Fetch and parse all jobs
 *   - isHugJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()  — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
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

export const HUG_KEY = 'hug';
export const HUG_COMPANY_NAME = 'HUG';
export const HUG_COMPANY_DOMAIN = 'hug.ch';

const SR_TENANT = 'HUG';
const CAREER_URL = `https://careers.smartrecruiters.com/${SR_TENANT}`;
const SR_PAGE_DELAY_MS = 2000;
const SR_REQUEST_TIMEOUT_MS = 15000;
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
 * Check if a job belongs to HUG.
 */
export function isHugJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === HUG_KEY ||
    /^hug(-|$)/.test(key) ||
    /\bhug\b/.test(company) ||
    /h[oô]pitaux\s*universitaires\s*de\s*gen[èe]ve/.test(company) ||
    url.includes('hug.ch') ||
    url.includes('smartrecruiters.com/hug')
  );
}

/**
 * Validate that a URL belongs to HUG or its SmartRecruiters tenant.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host === 'hug.ch' || host.endsWith('.hug.ch')) return true;
    if (host === 'jobs.smartrecruiters.com' || host === 'careers.smartrecruiters.com' || host === 'smartrecruiters.com') {
      return /\/hug(\/|$)/i.test(url.pathname);
    }
    if (host === 'api.smartrecruiters.com') {
      return /\/companies\/hug(\/|$)/i.test(url.pathname);
    }
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(m[ée]decin|doctor|chirurg|cardiolog|radiolog|p[ée]diatr|psychiatr)/.test(t)) return 'Sanità';
  if (/\b(infirmi|nurse|sage.?femme|aide.?soign|soin)/.test(t)) return 'Sanità';
  if (/\b(pharma|laborant|laboratoire|biomedi)/.test(t)) return 'Sanità';
  if (/\b(physiotherap|ergotherap|kinesi)/.test(t)) return 'Sanità';
  if (/\b(ingegner|engineer|entwickl|ing[eé]nieur)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install|electrici)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account|secr[eé]tariat|gestion)/.test(t)) return 'Amministrazione';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(it|software|develop|programm|informatique|syst[eè]me)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal|ressources humaines)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz|communication)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht|juridique)/.test(t)) return 'Legale';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(stage|stagiair|apprent)/.test(t)) return 'Sanità';
  return 'Sanità';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(stage|stagiair|intern|apprenti|apprendist|lehrling|lernend)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|chef|responsab|directeur|directrice|head|lead|leiter)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  if (/\b(stage|intern|stagiair)/.test(t)) return 'INTERN';
  if (/\b(cdd|temporary|tempor|befristet|fixed.?term)/.test(t)) return 'CONTRACTOR';
  return 'OTHER';
}

/* ── SmartRecruiters Posting Helpers ───────────────────────── */

/**
 * Decide whether a SmartRecruiters posting is in Switzerland.
 * HUG only operates in Geneva, so the country code is almost always CH —
 * we still keep the hybrid predicate as a safety net.
 */
function isSwissPosting(posting) {
  const country = String(posting?.location?.country?.code || posting?.location?.country || '').toLowerCase();
  if (country === 'ch') return true;
  if (country && country !== 'ch') return false;
  const text = composeLocationText(posting?.location);
  if (!text) return true; // HUG-only — assume CH when ambiguous.
  return isTargetSwissLocation(text, { includeGrigioni: true });
}

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
 * Fetch all HUG jobs from the SmartRecruiters API.
 *
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllHugJobs() {
  console.log(`🔍 Fetching HUG jobs (CH-wide via SmartRecruiters)`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || SR_REQUEST_TIMEOUT_MS;
  const userAgent = process.env.JOBS_CRAWLER_USER_AGENT || SR_USER_AGENT;

  const jobs = [];
  let yielded = 0;
  try {
    const iter = fetchSmartRecruitersJobs(SR_TENANT, {
      company: HUG_COMPANY_NAME,
      locationCountryCodes: ['ch'],
      filter: isSwissPosting,
      fetchDetail: true, // HUG list endpoint omits jobAd; need detail call.
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

      const locationText = composeLocationText(posting?.location) || 'Genève';
      const city = (posting?.location?.city && String(posting.location.city).trim())
        || locationText.split(',')[0].trim();
      const canton = inferSwissTargetCanton(locationText) || inferSwissTargetCanton(city) || 'GE';

      const descriptionRaw = extractPostingDescription(posting) || normalized.descriptionHtml || '';
      const descriptionText = stripHtml(descriptionRaw);

      const postingId = String(posting?.id || '').trim();
      const publicUrl =
        (typeof posting?.applyUrl === 'string' && posting.applyUrl) ||
        (postingId ? `https://jobs.smartrecruiters.com/${SR_TENANT}/${postingId}` : CAREER_URL);

      const sourceLang = detectLang(descriptionText || title, 'fr');
      const jobSlug = slugify(`${title} hug ${city || 'geneve'}`);
      const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

      const releasedRaw = posting?.releasedDate || posting?.createdOn || '';
      const postedDate = (() => {
        if (!releasedRaw) return new Date().toISOString().slice(0, 10);
        const d = new Date(releasedRaw);
        if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
        return d.toISOString().slice(0, 10);
      })();

      const job = {
        // ── Required fields ──
        id: `hug-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: HUG_COMPANY_NAME,
        companyKey: HUG_KEY,
        companyDomain: HUG_COMPANY_DOMAIN,
        title,
        titleByLocale: { [sourceLang]: title },
        description: descriptionText || `${title} — HUG`,
        descriptionByLocale: { [sourceLang]: descriptionText || `${title} — HUG` },
        location: city || locationText,
        canton,
        url: publicUrl,
        source: 'HUG Dedicated Parser (SmartRecruiters API)',
        sourceLang,
        crawledAt: new Date().toISOString(),

        // ── Recommended fields ──
        addressLocality: city || locationText,
        addressRegion: canton,
        addressCountry: 'CH',
        country: 'CH',
        category: detectCategory(title),
        contract: 'full-time',
        employmentType: detectEmploymentType(`${posting?.typeOfEmployment?.id || ''} ${posting?.typeOfEmployment?.label || ''} ${title}`),
        experienceLevel: detectExperienceLevel(title),
        sector: 'Sanità',
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

  console.log(`\n📋 Total HUG jobs discovered: ${jobs.length} (yielded ${yielded})`);
  return jobs;
}
