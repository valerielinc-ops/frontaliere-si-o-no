#!/usr/bin/env node
/**
 * GIM Architekten AG job parser — jobs.ch company-page scraper.
 *
 * GIM Architekten AG is a Bern-based architecture firm (HQ Altenbergstrasse
 * 28, 3013 Bern) — no dedicated corporate ATS; own careers page
 * (`https://www.gim.ch/jobs/`) is a static two-tile layout linking directly
 * to downloadable PDF job descriptions with a `mailto:` apply link (no
 * scrapable structured postings). All formal open positions are published on
 * the public jobs.ch board (TX Group), which does carry full JobPosting
 * JSON-LD per vacancy — plain-HTTP scrapable, same shared pattern already
 * used for Saint-Gobain Weber/Isover Suisse.
 *
 * Investigated 2026-07-04: `curl`/WebFetch confirmed two known jobs.ch
 * company profile ids for this single legal entity (numeric ids predate a
 * later UUID-slug migration on jobs.ch — both still resolve and are kept as
 * targets so neither is missed):
 *   - `49929-gim-architekten-ag` (legacy numeric id, self-canonical; lists
 *     "Dipl. Architekt/In - GIM", Jura location)
 *   - `70650-gim-architekten-ag` (301-redirects to the canonical UUID slug
 *     `d7896bfc-a2ec-4eda-a48b-d9eeeb8191e5-gim-architekten-ag`; lists
 *     "Leitung Administration, Personal & Finanzbuchhaltung", Bern location)
 * Both organization schema blocks confirm the same address (Bern,
 * Altenbergstrasse 28, 3013) — one company, two still-live jobs.ch profile
 * pages. `fetch()`'s default redirect-follow means passing either numeric id
 * as the path works; both are listed explicitly below for clarity/robustness
 * in case jobs.ch changes which id redirects.
 *
 * Crawl strategy:
 *
 * 1. GET https://www.jobs.ch/en/companies/{id}-{slug}/ for each known
 *    jobs.ch company profile; open vacancy links render as
 *    `<a href="/en/vacancies/detail/{uuid}/" data-cy="vacancy-serp-item">`.
 * 2. GET each unique vacancy detail page, extract the embedded JobPosting
 *    JSON-LD block (schema.org), map into the shared ParsedJob shape.
 * 3. Only the source locale (German) is populated directly; other locales
 *    get `needsRetranslation: true` so the shared AI localization step fills
 *    the remaining 3 locales.
 *
 * Implements the 4 exports required by the standard crawler template, plus
 * parsing helpers unit-tested directly:
 *   - fetchAllGimArchitektenJobs()
 *   - isGimArchitektenJob() / isTrustedDomain()
 *   - parseVacancyLinks() / extractJobPostingJsonLd() / cleanStreetAddress()
 *   - detectCategory() / detectEmploymentType() / detectExperienceLevel()
 *   - GIM_ARCHITEKTEN_KEY / GIM_ARCHITEKTEN_COMPANY_NAME /
 *     GIM_ARCHITEKTEN_COMPANY_DOMAIN
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import { inferSwissTargetCanton, inferAnyCanton, findSwissCityInText } from './target-swiss-locations.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
} from './hospital-custom-html-helpers.mjs';

export const GIM_ARCHITEKTEN_KEY = 'gim-architekten';
export const GIM_ARCHITEKTEN_COMPANY_NAME = 'GIM Architekten AG';
export const GIM_ARCHITEKTEN_COMPANY_DOMAIN = 'gim.ch';

const HQ = getCompanyDefaults(GIM_ARCHITEKTEN_KEY) || {
  city: 'Bern',
  canton: 'BE',
  postalCode: '3013',
  addressRegion: 'BE',
};

const BASE_URL = 'https://www.jobs.ch';

// Known jobs.ch company profile pages for GIM Architekten AG (single legal
// entity; two still-live profile ids — see file header for detail).
const COMPANY_TARGETS = [
  { path: '49929-gim-architekten-ag', label: 'GIM Architekten AG (legacy id)' },
  { path: '70650-gim-architekten-ag', label: 'GIM Architekten AG' },
];

/* ── Listing pages ─────────────────────────────────────────── */

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
 * jobs.ch sometimes ships `streetAddress` combined as "street, postal
 * city" string (e.g. "Altenbergstrasse 28, 3013 Bern"), sometimes as an
 * empty string. Strip a redundant trailing "postal city" segment when
 * present; fall back to the city name (safe default) when empty.
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
  // Apprenticeship/trainee roles checked first so a title like "Lehrstelle
  // Zeichner/-in EFZ Architektur" isn't mis-bucketed into the senior
  // architect/drafting categories below.
  if (/lehrling|lehrstelle|apprenti|apprendist|ausbildung|trainee/i.test(combined)) return 'Altro';
  if (/architekt|architect|projektleit|project.?lead|bauleit|construction.?management/i.test(combined)) return 'Ingegneria';
  if (/zeichner|drafting|technical.?drawing|planung|planning/i.test(combined)) return 'Tecnica';
  if (/finanz|finance|buchhalt|accounting|controll/i.test(combined)) return 'Finanza';
  if (/verkauf|sales|vertrieb|käufer|betreuung/i.test(combined)) return 'Commerciale';
  if (/market|kommunik|comunicaz/i.test(combined)) return 'Marketing';
  if (/\bit\s|software|develop|programm|digital|informatik|system.?admin/i.test(combined)) return 'IT';
  if (/admin|segret|empfang|office|büro|assist/i.test(combined)) return 'Amministrazione';
  if (/legal|recht|jurist|compliance/i.test(combined)) return 'Legale';
  if (/engineer|ingenieur|entwickl/i.test(combined)) return 'Ingegneria';
  return 'Altro';
}

/* ── Employment type detection ────────────────────────────── */

export function detectEmploymentType(title = '', workHours = '') {
  const combined = `${title} ${workHours}`.toLowerCase();
  if (/teilzeit|part[- ]?time|tempo\s?parziale/i.test(combined)) return 'PART_TIME';
  const pctMatch = combined.match(/(\d{2,3})\s?%/);
  if (pctMatch) {
    const pct = Number(pctMatch[1]);
    if (pct > 0 && pct < 90) return 'PART_TIME';
  }
  return 'FULL_TIME';
}

export function detectExperienceLevel(title = '') {
  const t = String(title || '').toLowerCase();
  if (/praktik|stage|stagiair|intern|apprendist|lehrling|lehrstelle|lernend|apprenti|ausbildung|trainee/i.test(t)) return 'intern';
  if (/junior|jr\b/i.test(t)) return 'junior';
  if (/senior|sr\b|lead|head|director|dirett|chef|verantwort|responsab|leiter|leitung|manager/i.test(t)) return 'senior';
  return 'mid';
}

/* ── Job identification ───────────────────────────────────── */

export function isGimArchitektenJob(job = {}) {
  const key = String(job?.companyKey || '')
    .trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();

  return (
    key === GIM_ARCHITEKTEN_KEY ||
    key.startsWith('gim-architekten') ||
    company.includes('gim architekten') ||
    url.includes('gim.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'jobs.ch' ||
      host === 'www.jobs.ch' ||
      host.endsWith('.jobs.ch') ||
      host === 'gim.ch' ||
      host === 'www.gim.ch' ||
      host.endsWith('.gim.ch')
    );
  } catch {
    return false;
  }
}

/* ── Main fetch function ──────────────────────────────────── */

/**
 * Fetch all GIM Architekten AG jobs published on jobs.ch.
 *
 * Returns an array of ParsedJob objects with source-locale fields only.
 * Other locales are filled by the shared AI localization step.
 */
export async function fetchAllGimArchitektenJobs() {
  console.log('🏛️ Fetching GIM Architekten AG jobs from jobs.ch company pages');

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
    console.warn('⚠️ No GIM Architekten AG vacancy URLs found on jobs.ch');
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
    // jobs.ch quirk: addressRegion sometimes holds a canton/region NAME, not a city
    // (e.g. "Jura") — only trust it as a city fallback when it actually resolves to
    // a known Swiss municipality, otherwise fall back to HQ.city.
    const addressLocality = decodeEntities(addr.addressLocality || '').trim();
    const addressRegionRaw = decodeEntities(addr.addressRegion || '').trim();
    const regionAsCity = addressRegionRaw && findSwissCityInText(addressRegionRaw) ? addressRegionRaw : '';
    const city = addressLocality || regionAsCity || HQ.city;
    const postalCode = String(addr.postalCode || '').trim() || HQ.postalCode;
    const canton = inferSwissTargetCanton(city) || inferAnyCanton(city) || HQ.canton;
    const country = 'CH';
    const streetAddress = cleanStreetAddress(decodeEntities(addr.streetAddress || ''), city, postalCode) || HQ.city;

    let description = htmlToText(posting.description || '');
    const wordCount = description.split(/\s+/).filter(Boolean).length;
    if (wordCount < 50) {
      const overview = htmlToText(posting.employerOverview || '');
      description = normalizeSpace([description, overview].filter(Boolean).join('\n\n'));
    }
    if (!description) continue;

    const hiringOrg = decodeEntities(posting.hiringOrganization?.name || '').trim() || GIM_ARCHITEKTEN_COMPANY_NAME;
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
    const jobSlug = slugify(`${title} ${GIM_ARCHITEKTEN_KEY} ${city}`);

    jobs.push({
      id: `${GIM_ARCHITEKTEN_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: hiringOrg,
      companyKey: GIM_ARCHITEKTEN_KEY,
      companyDomain: GIM_ARCHITEKTEN_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: city,
      canton,
      url: jobUrl,
      source: 'GIM Architekten AG Dedicated Parser (jobs.ch)',
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
      sector: 'Architettura / Edilizia',
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

  console.log(`\n📋 Total unique GIM Architekten AG jobs discovered: ${jobs.length}`);
  return jobs;
}
