#!/usr/bin/env node
/**
 * STRABAG AG job parser — jobs.ch company-page scraper.
 *
 * STRABAG SE is an Austrian-headquartered construction group (~86,000
 * employees, 2,400+ sites worldwide). Its Swiss operations are split across
 * two legal entities that both publish exclusively via the public jobs.ch
 * board (TX Group) — no dedicated corporate ATS, no Cloudflare protection:
 *   - STRABAG AG (main civil-engineering/construction entity, HQ Schlieren ZH)
 *   - Strabag BMTI GmbH (machinery/equipment subsidiary, Swiss apprenticeship
 *     + technical roles, e.g. Lindau ZH)
 *
 * Investigated 2026-07-04: the campaign table hint labelled this
 * 'jobs.ch (feed)' / 'Custom (jobs.ch affiliate)' — live-verified this is
 * CORRECT for STRABAG (unlike ~9/10 other rows in the same campaign batch
 * that were mislabeled). `www.strabag.ch` / `www.strabag.com` do not carry
 * a job board of their own; every open Swiss position resolves through
 * native jobs.ch `JobPosting` JSON-LD (`hiringOrganization.name` ===
 * "STRABAG AG" / "Strabag BMTI GmbH"), confirmed via curl on the company
 * profile + several detail pages. No Prospective/SuccessFactors/Teamtailor/
 * Workday/SmartRecruiters/Refline/rexx/Avature signatures found anywhere in
 * the redirect chain or page source.
 *
 * Crawl strategy:
 *
 * 1. GET https://www.jobs.ch/en/companies/{id}-{slug}/vacancies/ for each
 *    known jobs.ch company profile:
 *    - 39383-strabag-ag (STRABAG AG, ~33 open Swiss roles)
 *    - 116762-strabag-bmti-gmbh (Strabag BMTI GmbH, ~1 open Swiss role)
 *    Server-rendered HTML exposes `<a href="/en/vacancies/detail/{uuid}/">`
 *    for the first results page (rest load via client-side infinite scroll,
 *    which a plain HTTP scraper does not execute) — same limitation as the
 *    Saint-Gobain Weber/Isover parser this file mirrors; still yields a
 *    healthy, real, non-fabricated subset with no bespoke internal-API
 *    reverse engineering.
 * 2. GET each vacancy detail page, parse the `JobPosting` JSON-LD block.
 * 3. Only source-locale (`sourceLang`, default 'de') fields are populated;
 *    `needsRetranslation: true` so the shared AI localization step fills
 *    the remaining 3 locales.
 *
 * Implements the 4 exports required by the standard crawler template, plus
 * parsing helpers unit-tested directly:
 *   - fetchAllStrabagJobs()
 *   - isStrabagJob() / isTrustedDomain()
 *   - parseVacancyLinks() / extractJobPostingJsonLd() / cleanStreetAddress()
 *   - detectCategory() / detectEmploymentType() / detectExperienceLevel()
 *   - STRABAG_KEY / STRABAG_COMPANY_NAME / STRABAG_COMPANY_DOMAIN
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

export const STRABAG_KEY = 'strabag';
export const STRABAG_COMPANY_NAME = 'STRABAG AG';
export const STRABAG_COMPANY_DOMAIN = 'strabag.ch';

// STRABAG AG's registered Swiss office (jobs.ch company profile, confirmed
// 2026-07-04): Unterrohrstrasse 5, 8952 Schlieren (canton Zurich).
const HQ = getCompanyDefaults(STRABAG_KEY) || {
  city: 'Schlieren',
  canton: 'ZH',
  postalCode: '8952',
  addressRegion: 'ZH',
};

const BASE_URL = 'https://www.jobs.ch';

// Known jobs.ch company profiles for STRABAG's Swiss legal entities.
const COMPANY_TARGETS = [
  { path: '39383-strabag-ag', label: 'STRABAG AG' },
  { path: '116762-strabag-bmti-gmbh', label: 'Strabag BMTI GmbH' },
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
 * city" string (e.g. "Unterrohrstr. 5, 8952 Schlieren"), sometimes as an
 * empty string. Strip the redundant trailing "postal city" segment when
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

// Ordered bucket rules. Evaluated title-only first; occupationalCategory is
// consulted ONLY as a fallback when the title alone matches nothing (see
// detectCategory below). jobs.ch's shared `occupationalCategory.name`
// taxonomy for this company is a broad, near-identical string across almost
// every posting (e.g. "Technical / Construction / Architecture / Engineer /
// Civil Engineering / Supervision", or "Technical / Vehicles / Craft /
// Warehouse / Transport / Vehicle Mechanics / Diagnostics") — it happens to
// contain generic words ("Engineer", "Warehouse", "Transport") that would
// otherwise swamp specific title signal (e.g. "Baumaschinenmechaniker:in"
// getting misfiled as Logistica because its shared category mentions
// "Warehouse / Transport", or every construction-site role getting filed as
// Ingegneria because its shared category mentions "Engineer"). Title-first
// resolution keeps categorization tied to what the role actually is.
const CATEGORY_RULES = [
  [/labor|chemi|chemist|analys|f&e|forschung|entwicklung|r&d/i, 'Tecnica'],
  [/produk|production|fabrik|anlagenführ|maschinenführ|operator|betrieb|werk/i, 'Produzione'],
  [/verkauf|sales|vertrieb|aussendienst|key account|commercial|conseill/i, 'Commerciale'],
  [/logist|lager|warehouse|chauffeur|driver|transport|versand|dispon|umschlag/i, 'Logistica'],
  [/market|kommunik|comunicaz/i, 'Marketing'],
  [/\bit\s|software|develop|programm|digital|informatik|system.?admin/i, 'IT'],
  [/finanz|finance|controll|buchhalt|accounting|abrechn/i, 'Finanza'],
  [/hr\b|human|personal|recruit/i, 'Risorse Umane'],
  [/admin|segret|empfang|office|büro|assist/i, 'Amministrazione'],
  [/qualit|qa\b|qc\b|quality/i, 'Qualità'],
  [/legal|recht|jurist|compliance/i, 'Legale'],
  [/bauführ|polier|maurer|strassenbau|straßenbau|tiefbau|hochbau|brücken|tunnelbau|baustell|maschinist|kranführ|schaler|eisenleger|betonbau|bauarbeit|vermessung|zimmermann|gerüstbau|baumaschin|baugeräte/i, 'Costruzioni'],
  [/ingenieur|engineer|bauleit/i, 'Ingegneria'],
];

export function detectCategory(title = '', occupationalCategory = '') {
  const t = String(title || '').toLowerCase();
  for (const [re, category] of CATEGORY_RULES) {
    if (re.test(t)) return category;
  }
  // Title alone gave no signal — fall back to the shared occupationalCategory
  // taxonomy text as a weak hint (better than defaulting straight to 'Altro').
  const occ = String(occupationalCategory || '').toLowerCase();
  if (occ) {
    for (const [re, category] of CATEGORY_RULES) {
      if (re.test(occ)) return category;
    }
  }
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

export function isStrabagJob(job = {}) {
  if (!job) return false;
  const key = String(job?.companyKey || '')
    .trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();

  return Boolean(
    key === STRABAG_KEY ||
    key.startsWith('strabag') ||
    company.includes('strabag') ||
    url.includes('strabag.ch') ||
    url.includes('strabag.com')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return Boolean(
      host === 'jobs.ch' ||
      host === 'www.jobs.ch' ||
      host.endsWith('.jobs.ch') ||
      host === 'strabag.ch' ||
      host === 'www.strabag.ch' ||
      host.endsWith('.strabag.ch') ||
      host === 'strabag.com' ||
      host === 'www.strabag.com' ||
      host.endsWith('.strabag.com')
    );
  } catch {
    return false;
  }
}

/* ── Main fetch function ──────────────────────────────────── */

/**
 * Fetch all STRABAG (Switzerland) jobs published on jobs.ch.
 *
 * Returns an array of ParsedJob objects with source-locale fields only.
 * Other locales are filled by the shared AI localization step.
 */
export async function fetchAllStrabagJobs() {
  console.log('🏗️  Fetching STRABAG AG jobs from jobs.ch company pages');
  const vacancyUrls = new Set();

  for (const target of COMPANY_TARGETS) {
    // locale-segment-ok: '/en/' is jobs.ch's own external site-language path, not our site locale route
    const companyPageUrl = `${BASE_URL}/en/companies/${target.path}/vacancies/`;
    let html = '';
    try {
      html = await fetchHtml(companyPageUrl);
    } catch (err) {
      console.warn(`  ⚠️ Company page fetch failed for ${target.label} (${companyPageUrl}): ${err?.message || err}`);
      continue;
    }
    const links = parseVacancyLinks(html);
    console.log(`  📄 ${target.label}: ${links.length} vacancy link(s)`);
    for (const link of links) vacancyUrls.add(link);
  }

  if (!vacancyUrls.size) {
    console.warn('⚠️ No STRABAG vacancy URLs found on jobs.ch');
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

    const hiringOrg = decodeEntities(posting.hiringOrganization?.name || '').trim();
    // Safety net: only keep postings genuinely published by a STRABAG entity
    // (defends against jobs.ch cross-linking noise beyond our own scoped
    // company-profile crawl).
    if (hiringOrg && !isStrabagJob({ company: hiringOrg })) continue;

    const addr = posting.jobLocation?.address || {};
    // jobs.ch quirk: addressRegion holds CITY, not a canton code.
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

    const occCategory = posting.occupationalCategory?.name || posting.disambiguatingDescription || '';
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
    const jobSlug = slugify(`${title} ${STRABAG_KEY} ${city}`);

    jobs.push({
      id: `${STRABAG_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: hiringOrg || STRABAG_COMPANY_NAME,
      companyKey: STRABAG_KEY,
      companyDomain: STRABAG_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: city,
      canton,
      url: jobUrl,
      source: 'STRABAG AG Dedicated Parser (jobs.ch)',
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
      sector: 'Edilizia / Costruzioni',
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

  console.log(`\n📋 Total unique STRABAG AG jobs discovered: ${jobs.length}`);
  return jobs;
}
