#!/usr/bin/env node
/**
 * Sobi (Swedish Orphan Biovitrum) — SmartRecruiters API job parser.
 *
 * Source: https://careers.smartrecruiters.com/Sobi
 * API:    https://api.smartrecruiters.com/v1/companies/Sobi/postings
 *
 * Sobi is a Swedish biopharma group with a major Swiss footprint:
 *   - Basel HQ for international commercial / supply / IT
 *   - Zurich commercial office
 *
 * Therapeutic areas: rare diseases, haematology, immunology, specialty care.
 *
 * SmartRecruiters tenant ID: `Sobi` (case-sensitive).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSobiJobs() — Fetch and parse all Swiss jobs
 *   - isSobiJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()  — Validate URLs belong to this company
 *   - SOBI_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
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

export const SOBI_KEY = 'sobi';
export const SOBI_COMPANY_NAME = 'Sobi';
export const SOBI_COMPANY_DOMAIN = 'sobi.com';

const SR_TENANT = 'Sobi';
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

export function isSobiJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SOBI_KEY ||
    /^sobi(-|$)/.test(key) ||
    /\bsobi\b/.test(company) ||
    /swedish\s+orphan\s+biovitrum/.test(company) ||
    url.includes('sobi.com') ||
    url.includes('smartrecruiters.com/sobi')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host === 'sobi.com' || host.endsWith('.sobi.com')) return true;
    if (host === 'jobs.smartrecruiters.com' || host === 'careers.smartrecruiters.com' || host === 'smartrecruiters.com') {
      return /\/sobi(\/|$)/i.test(url.pathname);
    }
    if (host === 'api.smartrecruiters.com') {
      return /\/companies\/sobi(\/|$)/i.test(url.pathname);
    }
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(regulatory|qualität|qualit|qa|qc|validation|compliance|gxp|gmp)/.test(t)) return 'Qualità / Compliance';
  if (/\b(manufactur|production|fertigung|produktion|operator|technician|maint|wartung|msat|drug\s*substance)/.test(t)) return 'Tecnica';
  if (/\b(engineer|ingenieur|developer|software|programm|informatik|r&d|research|scientist|biolog|chemist|technical)/.test(t)) return 'Ingegneria';
  if (/\b(sales|account|vertrieb|representative|business\s*develop|territory|key\s*account|commercial)/.test(t)) return 'Vendite';
  if (/\b(market|kommunikation|brand|product\s*manager|medical\s*affairs|launch)/.test(t)) return 'Marketing';
  if (/\b(supply|logist|warehouse|lager|procurement|sourcing|purchas|einkauf|distribution)/.test(t)) return 'Logistica';
  if (/\b(hr|human|talent|recruit|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(finance|controller|controlling|buchhalt|finanz|treasur|tax)/.test(t)) return 'Finanza';
  if (/\b(legal|counsel|lawyer|attorney|compliance\s*officer)/.test(t)) return 'Legale';
  if (/\b(it\b|sap|cloud|cyber|data|infrastructure|network|devops|digital|stack\s*developer|azure|ai)/.test(t)) return 'IT';
  if (/\b(clinical|pharma|medical\s*manager|safety|drug\s*safety|pharmacovigilance)/.test(t)) return 'Sanità';
  return 'Sanità';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|intern|stage|stagiair|apprenti|ausbildung|trainee|graduate)/.test(t)) return 'intern';
  if (/\b(junior|jr\.?|entry|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr\.?|lead|head|director|principal|chief|associate\s*director|leiter)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  if (/\b(intern|stage|stagiair|praktik|apprenti)/.test(t)) return 'INTERN';
  if (/\b(contract|temporary|tempor|befristet|fixed.?term|interim|6\s*months)/.test(t)) return 'CONTRACTOR';
  return 'FULL_TIME';
}

/* ── SmartRecruiters Posting Helpers ───────────────────────── */

function isSwissPosting(posting) {
  const country = String(posting?.location?.country?.code || posting?.location?.country || '').toLowerCase();
  if (country === 'ch') return true;
  if (country && country !== 'ch') return false;
  const text = composeLocationText(posting?.location);
  if (!text) return false;
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

export async function fetchAllSobiJobs() {
  console.log(`🔍 Fetching ${SOBI_COMPANY_NAME} jobs (CH via SmartRecruiters)`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || SR_REQUEST_TIMEOUT_MS;
  const userAgent = process.env.JOBS_CRAWLER_USER_AGENT || SR_USER_AGENT;

  const jobs = [];
  let yielded = 0;
  try {
    const iter = fetchSmartRecruitersJobs(SR_TENANT, {
      company: SOBI_COMPANY_NAME,
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

      const locationText = composeLocationText(posting?.location) || 'Basel';
      const city = (posting?.location?.city && String(posting.location.city).trim())
        || locationText.split(',')[0].trim();
      const canton = inferSwissTargetCanton(locationText)
        || inferSwissTargetCanton(city)
        || (posting?.location?.region && String(posting.location.region).trim().toUpperCase())
        || 'BS';

      const descriptionRaw = extractPostingDescription(posting) || normalized.descriptionHtml || '';
      const descriptionText = stripHtml(descriptionRaw);

      const postingId = String(posting?.id || '').trim();
      const publicUrl =
        (typeof posting?.applyUrl === 'string' && posting.applyUrl) ||
        (typeof posting?.postingUrl === 'string' && posting.postingUrl) ||
        (postingId ? `https://jobs.smartrecruiters.com/${SR_TENANT}/${postingId}` : CAREER_URL);

      const sourceLang = detectLang(descriptionText || title, 'en');
      const jobSlug = slugify(`${title} sobi ${city || 'basel'}`);
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
        id: `${SOBI_KEY}-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: SOBI_COMPANY_NAME,
        companyKey: SOBI_KEY,
        companyDomain: SOBI_COMPANY_DOMAIN,
        title,
        titleByLocale: { [sourceLang]: title },
        description: descriptionText || `${title} — ${SOBI_COMPANY_NAME}`,
        descriptionByLocale: { [sourceLang]: descriptionText || `${title} — ${SOBI_COMPANY_NAME}` },
        // Newly-discovered jobs ship with source-locale-only fields. The shared
        // AI-localization step clears this flag when it fills the remaining 3
        // locales; if it can't, translate-pending.yml picks the job up.
        needsRetranslation: true,
        location: city || locationText,
        canton,
        url: publicUrl,
        source: `${SOBI_COMPANY_NAME} Dedicated Parser (SmartRecruiters API)`,
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
        sector: 'Sanità / Farmaceutico / Malattie rare',
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

  console.log(`\n📋 Total ${SOBI_COMPANY_NAME} jobs discovered: ${jobs.length} (yielded ${yielded})`);
  return jobs;
}
