#!/usr/bin/env node
/**
 * imad (Institution genevoise de maintien à domicile) — SmartRecruiters API parser.
 *
 * Source: https://careers.smartrecruiters.com/Imad
 * API:    https://api.smartrecruiters.com/v1/companies/Imad/postings
 *
 * imad is the public home-care (maintien à domicile) institution of Canton
 * Geneva. It employs >3'000 nurses, aides, ergotherapists and home-help
 * staff providing in-home medical and social care across the canton.
 *
 * All postings are Geneva-based — default canton GE.
 *
 * SmartRecruiters tenant ID: `Imad` (case-sensitive; the lowercase `imad` is
 * also accepted by the API but we use the canonical capitalised form).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllImadJobs() — Fetch and parse all jobs
 *   - isImadJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()  — Validate URLs belong to this company
 *   - IMAD_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
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

export const IMAD_KEY = 'imad';
export const IMAD_COMPANY_NAME = 'imad';
export const IMAD_COMPANY_DOMAIN = 'imad-ge.ch';

const SR_TENANT = 'Imad';
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

export function isImadJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === IMAD_KEY ||
    /^imad(-|$)/.test(key) ||
    /\bimad\b/.test(company) ||
    /maintien\s+(à|a)\s+domicile/.test(company) ||
    url.includes('imad-ge.ch') ||
    url.includes('smartrecruiters.com/imad')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host === 'imad-ge.ch' || host.endsWith('.imad-ge.ch')) return true;
    if (host === 'jobs.smartrecruiters.com' || host === 'careers.smartrecruiters.com' || host === 'smartrecruiters.com') {
      return /\/imad(\/|$)/i.test(url.pathname);
    }
    if (host === 'api.smartrecruiters.com') {
      return /\/companies\/imad(\/|$)/i.test(url.pathname);
    }
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(infirmi|nurse|sage.?femme|aide.?soign|soin|soignant)/.test(t)) return 'Sanità';
  if (/\b(m[ée]decin|doctor|chirurg|dentiste|psycholog)/.test(t)) return 'Sanità';
  if (/\b(physioth[eé]rap|ergoth[eé]rap|kin[eé]si|di[eé]t[eé]ticien)/.test(t)) return 'Sanità';
  if (/\b(assistant.?e?\s*social|service\s*social|travailleur.?social)/.test(t)) return 'Sanità';
  if (/\b(ASSC|ASE|auxiliaire|aide\s*à\s*domicile)/i.test(title)) return 'Sanità';
  if (/\b(secr[eé]taire|reception|admin|comptab|administra|gestion)/.test(t)) return 'Amministrazione';
  if (/\b(logist|magazz|lager|transport)/.test(t)) return 'Logistica';
  if (/\b(it|software|develop|programm|informatique|syst[eè]me)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal|ressources humaines)/.test(t)) return 'Risorse Umane';
  if (/\b(finance|finanz|compt|account)/.test(t)) return 'Finanza';
  if (/\b(stage|stagiair|apprenti)/.test(t)) return 'Sanità';
  return 'Sanità';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(stage|stagiair|intern|apprenti|lehrling|lernend)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|chef|responsab|directeur|directrice|head|lead|leiter)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  if (/\b(stage|intern|stagiair)/.test(t)) return 'INTERN';
  if (/\b(cdm|cdd|temporary|tempor|befristet|fixed.?term)/.test(t)) return 'CONTRACTOR';
  return 'OTHER';
}

/* ── SmartRecruiters Posting Helpers ───────────────────────── */

/**
 * imad operates only in Canton Geneva — assume CH when country code missing.
 */
function isSwissPosting(posting) {
  const country = String(posting?.location?.country?.code || posting?.location?.country || '').toLowerCase();
  if (country === 'ch') return true;
  if (country && country !== 'ch') return false;
  const text = composeLocationText(posting?.location);
  if (!text) return true; // imad is GE-only — assume CH when ambiguous.
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
  const parts = [];
  for (const key of ['jobDescription', 'qualifications', 'additionalInformation']) {
    const raw = typeof sections[key]?.text === 'string' ? sections[key].text : '';
    if (raw && raw.trim().length > 0) parts.push(raw);
  }
  return parts.join('\n\n').trim();
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

export async function fetchAllImadJobs() {
  console.log(`🔍 Fetching ${IMAD_COMPANY_NAME} jobs (Genève via SmartRecruiters)`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || SR_REQUEST_TIMEOUT_MS;
  const userAgent = process.env.JOBS_CRAWLER_USER_AGENT || SR_USER_AGENT;

  const jobs = [];
  let yielded = 0;
  try {
    const iter = fetchSmartRecruitersJobs(SR_TENANT, {
      company: IMAD_COMPANY_NAME,
      locationCountryCodes: ['ch'],
      filter: isSwissPosting,
      fetchDetail: true,
      maxPages: 20,
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
      const canton = inferSwissTargetCanton(locationText)
        || inferSwissTargetCanton(city)
        || (posting?.location?.region && String(posting.location.region).trim().toUpperCase())
        || 'GE';

      const descriptionRaw = extractPostingDescription(posting) || normalized.descriptionHtml || '';
      const descriptionText = stripHtml(descriptionRaw);

      const postingId = String(posting?.id || '').trim();
      const publicUrl =
        (typeof posting?.applyUrl === 'string' && posting.applyUrl) ||
        (typeof posting?.postingUrl === 'string' && posting.postingUrl) ||
        (postingId ? `https://jobs.smartrecruiters.com/${SR_TENANT}/${postingId}` : CAREER_URL);

      const sourceLang = detectLang(descriptionText || title, 'fr');
      const jobSlug = slugify(`${title} imad ${city || 'geneve'}`);
      const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

      const releasedRaw = posting?.releasedDate || posting?.createdOn || '';
      const postedDate = (() => {
        if (!releasedRaw) return new Date().toISOString().slice(0, 10);
        const d = new Date(releasedRaw);
        if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
        return d.toISOString().slice(0, 10);
      })();

      const postalCode = (posting?.location?.postalCode && String(posting.location.postalCode).trim()) || '';

      const job = {
        // ── Required fields ──
        id: `${IMAD_KEY}-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: IMAD_COMPANY_NAME,
        companyKey: IMAD_KEY,
        companyDomain: IMAD_COMPANY_DOMAIN,
        title,
        titleByLocale: { [sourceLang]: title },
        description: descriptionText || `${title} — ${IMAD_COMPANY_NAME}`,
        descriptionByLocale: { [sourceLang]: descriptionText || `${title} — ${IMAD_COMPANY_NAME}` },
        // Newly-discovered jobs ship with source-locale-only fields. The shared
        // AI-localization step clears this flag when it fills the remaining 3
        // locales; if it can't, translate-pending.yml picks the job up.
        needsRetranslation: true,
        location: city || locationText,
        canton,
        url: publicUrl,
        source: `${IMAD_COMPANY_NAME} Dedicated Parser (SmartRecruiters API)`,
        sourceLang,
        crawledAt: new Date().toISOString(),

        // ── Recommended fields ──
        addressLocality: city || locationText,
        addressRegion: canton,
        addressCountry: 'CH',
        country: 'CH',
        category: detectCategory(title),
        contract: 'full-time',
        employmentType: detectEmploymentType(
          `${posting?.typeOfEmployment?.id || ''} ${posting?.typeOfEmployment?.label || ''} ${title}`,
        ),
        experienceLevel: detectExperienceLevel(title),
        sector: 'Sanità / Cure a domicilio',
        currency: 'CHF',
        featured: false,
        postedDate,
        applyUrl: publicUrl,
        jobReqId: postingId || null,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
      };
      if (postalCode) job.postalCode = postalCode;

      jobs.push(job);
    }
  } catch (err) {
    if (err instanceof SmartRecruitersApiError) {
      console.warn(`  ⚠️ SmartRecruiters API error: ${err.message} (status=${err.statusCode ?? 'n/a'})`);
    }
    throw err;
  }

  console.log(`\n📋 Total ${IMAD_COMPANY_NAME} jobs discovered: ${jobs.length} (yielded ${yielded})`);
  return jobs;
}
