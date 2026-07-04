#!/usr/bin/env node
/**
 * VISIONAPARTMENTS job parser — jobs.ch company-page scraper.
 *
 * VISIONAPARTMENTS (legal entity: Vision Management Services GmbH, HQ
 * Talstrasse 62, 8001 Zürich ZH) is a Swiss serviced/furnished-apartment
 * rental company. Its own corporate site (visionapartments.com, Next.js)
 * ships a hand-maintained "career" page — investigated 2026-07-04, it
 * currently lists only 2 static entries, both in Warsaw (Poland), each
 * linking to a PDF hosted on the company's own blob storage (not a
 * structured ATS, not Swiss-relevant, not paginated/scrapeable).
 *
 * The company's real, live Swiss vacancies are published exclusively on
 * the public jobs.ch board (TX Group), same pattern as the
 * Saint-Gobain Weber/Isover Suisse crawler
 * (scripts/lib/saint-gobain-weber-isover-job-parser.mjs). Confirmed live
 * 2026-07-04: jobs.ch company profile
 * `69c35774-5e33-4b40-94e0-4a9d949707c6-vision-management-services-gmbh`
 * (the older `38711-visionapartments` profile 301-redirects to it) lists
 * 1 open Swiss vacancy with full JobPosting JSON-LD on its detail page
 * (title, jobLocation.address incl. streetAddress/postalCode,
 * hiringOrganization.name, datePosted, employmentType).
 *
 * Crawl strategy:
 *
 * 1. GET https://www.jobs.ch/en/companies/{id}-{slug}/ for the known
 *    jobs.ch company profile. Open vacancy links render as
 *    `<a href="/en/vacancies/detail/{uuid}/" data-cy="vacancy-serp-item">`.
 *    Zero open positions renders no vacancy links — a valid (empty)
 *    result, not a fetch failure.
 *
 * 2. GET each vacancy detail page, extract the `JobPosting` JSON-LD
 *    block for title/description/address/dates/employer.
 *
 * Only source-locale (`de` — jobs.ch Swiss postings are German by
 * default) fields are populated here; other locales are filled by the
 * shared AI localization step (`needsRetranslation: true`).
 *
 * Implements the 4 exports required by the standard crawler template,
 * plus parsing helpers unit-tested directly:
 * - fetchAllVisionapartmentsJobs()
 * - isVisionapartmentsJob() / isTrustedDomain()
 * - parseVacancyLinks() / extractJobPostingJsonLd() / cleanStreetAddress()
 * - detectCategory() / detectEmploymentType() / detectExperienceLevel()
 * - VISIONAPARTMENTS_KEY / VISIONAPARTMENTS_COMPANY_NAME /
 *   VISIONAPARTMENTS_COMPANY_DOMAIN
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import { inferSwissTargetCanton, inferAnyCanton } from './target-swiss-locations.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
} from './hospital-custom-html-helpers.mjs';

export const VISIONAPARTMENTS_KEY = 'visionapartments';
export const VISIONAPARTMENTS_COMPANY_NAME = 'VISIONAPARTMENTS';
export const VISIONAPARTMENTS_COMPANY_DOMAIN = 'visionapartments.com';

const HQ = getCompanyDefaults(VISIONAPARTMENTS_KEY) || {
  city: 'Zürich',
  canton: 'ZH',
  postalCode: '8001',
  addressRegion: 'ZH',
};

const BASE_URL = 'https://www.jobs.ch';

// Known jobs.ch company profile page for Vision Management Services GmbH
// (the legal entity behind the VISIONAPARTMENTS brand). The old
// `38711-visionapartments` profile 301-redirects to this canonical one —
// use the canonical path directly so the crawler doesn't depend on
// jobs.ch's redirect behavior staying stable.
const COMPANY_TARGETS = [
  {
    path: '69c35774-5e33-4b40-94e0-4a9d949707c6-vision-management-services-gmbh',
    label: 'Vision Management Services GmbH',
  },
];

/* ── Listing pages ────────────────────────────────────────── */

export function parseVacancyLinks(html = '') {
  if (!html) return [];
  const urls = new Set();
  const re = /href="(\/en\/vacancies\/detail\/[a-f0-9-]+\/)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    urls.add(`${BASE_URL}${m[1]}`);
  }
  return Array.from(urls);
}

/* ── Detail page parser ───────────────────────────────────── */

export function extractJobPostingJsonLd(html = '') {
  if (!html) return null;
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    try {
      const obj = JSON.parse(raw);
      if (obj && (obj['@type'] === 'JobPosting' || (Array.isArray(obj) && obj.find((o) => o && o['@type'] === 'JobPosting')))) {
        return Array.isArray(obj) ? obj.find((o) => o && o['@type'] === 'JobPosting') : obj;
      }
    } catch {
      // try next script block
    }
  }
  return null;
}

/**
 * jobs.ch sometimes ships `streetAddress` as a combined "street, postal
 * city" string and sometimes as an empty string. Strip the redundant
 * trailing "postal city" segment when present; fall back to the city
 * name (safe default) when empty.
 */
export function cleanStreetAddress(raw = '', city = '', postalCode = '') {
  const text = normalizeSpace(raw);
  if (!text) return city || '';
  if (postalCode && city) {
    const suffixRe = new RegExp(`,?\\s*${postalCode}\\s*${city}\\s*$`, 'i');
    const cleaned = normalizeSpace(text.replace(suffixRe, ''));
    if (cleaned) return cleaned;
  }
  return text;
}

/* ── Category detection ──────────────────────────────────── */

export function detectCategory(title = '', occupationalCategory = '') {
  const combined = `${title} ${occupationalCategory}`.toLowerCase();
  if (/reinig|hauswirtschaft|housekeep|room attendant|hôtellerie|hotellerie/i.test(combined)) return 'Ospitalità';
  if (/reception|empfang|concierge|guest relations|front office/i.test(combined)) return 'Ospitalità';
  if (/real estate|immobil|liegenschaft|maintenance|unterhalt|facility|bau|architek|engineer|supervision/i.test(combined)) return 'Ingegneria';
  if (/verkauf|sales|vertrieb|aussendienst|key account|commercial|leasing/i.test(combined)) return 'Commerciale';
  if (/market|kommunik|comunicaz/i.test(combined)) return 'Marketing';
  if (/\bit\s|software|develop|programm|digital|informatik|system.?admin/i.test(combined)) return 'IT';
  if (/finanz|finance|controll|buchhalt|accounting/i.test(combined)) return 'Finanza';
  if (/hr\b|human|personal|recruit/i.test(combined)) return 'Risorse Umane';
  if (/admin|segret|office|büro|assist/i.test(combined)) return 'Amministrazione';
  if (/qualit|qa\b|qc\b|quality/i.test(combined)) return 'Qualità';
  if (/legal|recht|jurist|compliance/i.test(combined)) return 'Legale';
  return 'Altro';
}

/* ── Employment type detection ────────────────────────────── */

export function detectEmploymentType(title = '', workHours = '') {
  const combined = `${title} ${workHours}`.toLowerCase();
  if (/teilzeit|part[- ]?time|tempo parziale|temps partiel/i.test(combined)) return 'PART_TIME';
  const pctMatch = combined.match(/(\d{1,3})\s*[-–]\s*(\d{1,3})\s*%/) || combined.match(/(\d{1,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2], 10) : parseInt(pctMatch[1], 10);
    if (maxPct < 80) return 'PART_TIME';
  }
  const hoursMatch = combined.match(/(\d{1,3}(?:\.\d+)?)\s*-\s*(\d{1,3}(?:\.\d+)?)\s*hours\/week/);
  if (hoursMatch) {
    const maxHours = parseFloat(hoursMatch[2]);
    if (maxHours > 0 && maxHours < 32) return 'PART_TIME';
  }
  return 'FULL_TIME';
}

export function detectExperienceLevel(title = '') {
  const t = String(title || '').toLowerCase();
  if (/praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|ausbildung|trainee/i.test(t)) return 'intern';
  if (/junior|jr\b/i.test(t)) return 'junior';
  if (/senior|sr\b|lead|head|director|dirett|chef|verantwort|responsab|leiter|manager/i.test(t)) return 'senior';
  return 'mid';
}

/* ── Job identification ───────────────────────────────────── */

export function isVisionapartmentsJob(job = {}) {
  const key = String(job?.companyKey || '')
    .trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();

  return (
    key === VISIONAPARTMENTS_KEY ||
    key.startsWith('visionapartments') ||
    company.includes('visionapartments') ||
    company.includes('vision apartments') ||
    company.includes('vision management services') ||
    url.includes('visionapartments.com')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'jobs.ch' ||
      host === 'www.jobs.ch' ||
      host.endsWith('.jobs.ch') ||
      host === 'visionapartments.com' ||
      host === 'www.visionapartments.com' ||
      host.endsWith('.visionapartments.com')
    );
  } catch {
    return false;
  }
}

/* ── Main fetch function ──────────────────────────────────── */

/**
 * Fetch all VISIONAPARTMENTS jobs published on jobs.ch.
 *
 * Returns an array of ParsedJob objects with source-locale fields only.
 * Other locales are filled by the shared AI localization step.
 */
export async function fetchAllVisionapartmentsJobs() {
  console.log('🏢 Fetching VISIONAPARTMENTS jobs from jobs.ch company page');

  const vacancyUrls = new Set();
  for (const target of COMPANY_TARGETS) {
    // locale-segment-ok: '/en/' is jobs.ch's own external site-language path, not a site locale route
    const companyPageUrl = `${BASE_URL}/en/companies/${target.path}/`;
    let html = '';
    try {
      html = await fetchHtml(companyPageUrl);
    } catch (err) {
      console.warn(`  ⚠️ Failed to fetch ${target.label} company page: ${err?.message || err}`);
      continue;
    }
    const links = parseVacancyLinks(html);
    console.log(`  📋 ${target.label}: ${links.length} open vacancy link(s)`);
    for (const link of links) vacancyUrls.add(link);
  }

  if (!vacancyUrls.size) {
    console.warn('⚠️ No VISIONAPARTMENTS vacancy URLs found on jobs.ch');
    return [];
  }

  console.log(`  📋 Total unique vacancy URLs: ${vacancyUrls.size}\n`);

  const jobs = [];
  for (const jobUrl of vacancyUrls) {
    let posting = null;
    try {
      const detailHtml = await fetchHtml(jobUrl);
      posting = extractJobPostingJsonLd(detailHtml);
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${jobUrl}: ${err?.message || err}`);
    }
    if (!posting) continue;

    const title = decodeEntities(posting.title || '').trim();
    if (!title) continue;

    const addr = posting.jobLocation?.address || {};
    // jobs.ch quirk: addressRegion holds the CITY, not a canton code.
    const city = decodeEntities(addr.addressRegion || addr.addressLocality || '').trim() || HQ.city;
    const postalCode = String(addr.postalCode || '').trim() || HQ.postalCode;
    const canton = inferSwissTargetCanton(city) || inferAnyCanton(city) || HQ.canton;
    const country = 'CH';
    const streetAddress = cleanStreetAddress(decodeEntities(addr.streetAddress || ''), city, postalCode) || city;

    let description = htmlToText(posting.description || '');
    const wordCount = description.split(/\s+/).filter(Boolean).length;
    if (wordCount < 50) {
      const overview = htmlToText(posting.employerOverview || '');
      description = normalizeSpace([description, overview].filter(Boolean).join('\n\n'));
    }
    if (!description) continue;

    const hiringOrg = decodeEntities(posting.hiringOrganization?.name || '').trim();
    const occCategory = posting.occupationalCategory?.name || '';
    const workHours = posting.workHours || '';
    const employmentType = detectEmploymentType(title, workHours);

    const postedDate = (() => {
      const raw = posting.datePosted;
      if (!raw) return new Date().toISOString().slice(0, 10);
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
    })();

    let validThrough;
    if (posting.validThrough) {
      const vd = new Date(posting.validThrough);
      if (!Number.isNaN(vd.getTime())) validThrough = vd.toISOString().slice(0, 10);
    }

    const sourceLang = detectLang(`${title} ${description}`, 'de');

    const urlHash = createHash('sha1').update(jobUrl).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${title} ${VISIONAPARTMENTS_KEY} ${city}`);

    jobs.push({
      id: `${VISIONAPARTMENTS_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: hiringOrg || VISIONAPARTMENTS_COMPANY_NAME,
      companyKey: VISIONAPARTMENTS_KEY,
      companyDomain: VISIONAPARTMENTS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: city,
      canton,
      url: jobUrl,
      source: 'VISIONAPARTMENTS Dedicated Parser (jobs.ch)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: city,
      addressRegion: canton,
      addressCountry: country,
      country,
      postalCode,
      streetAddress,
      category: detectCategory(title, occCategory),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Immobiliare / Ospitalità',
      currency: 'CHF',
      featured: false,
      postedDate,
      ...(validThrough ? { validThrough } : {}),
      applyUrl: jobUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });

    console.log(`  ✅ ${title.substring(0, 60)} — ${city}`);
  }

  console.log(`\n📋 Total unique VISIONAPARTMENTS jobs discovered: ${jobs.length}`);
  return jobs;
}
