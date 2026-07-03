#!/usr/bin/env node
/**
 * Saint-Gobain Weber/Isover Suisse job parser — jobs.ch company-page scraper.
 *
 * The two Swiss legal entities of the Saint-Gobain building-materials group
 * — Saint-Gobain Weber AG (renders/mortars/adhesives, HQ Volketswil ZH,
 * corporate site `https://www.ch.weber` — Cloudflare-protected) and
 * Saint-Gobain Isover SA (insulation, HQ Lucens VD) — do NOT run a dedicated
 * corporate ATS. Both publish their open Swiss positions exclusively via the
 * public jobs.ch board (TX Group), which is not Cloudflare-protected and is
 * plain-HTTP scrapable.
 *
 * Investigated 2026-07-03: `curl`/WebFetch on `ch.weber`, `isover.ch` and
 * `saint-gobain.ch` all return a Cloudflare Turnstile challenge (confirmed
 * via Playwright screenshot — headless AND headed, with stealth patches and
 * manual checkbox interaction, never clears the challenge). The generic
 * SmartRecruiters "SaintGobain" tenant is the *global* group careers site
 * (no Swiss-market filter) and was ruled out as non-Swiss-specific.
 *
 * Crawl strategy:
 *
 *   1. GET https://www.jobs.ch/en/companies/{id}-{slug}/ for each known
 *      jobs.ch company profile:
 *        - 40563-saint-gobain-weber-ag   (Saint-Gobain Weber AG)
 *        - 107006-saint-gobain-isover-sa (Saint-Gobain Isover SA)
 *      Each open vacancy renders as
 *      `<a href="/en/vacancies/detail/{uuid}/" data-cy="vacancy-serp-item">`.
 *      Isover currently has 0 open Swiss postings — its company page simply
 *      yields no vacancy links, which is a valid (empty) result, not a
 *      fetch failure.
 *
 *   2. For each unique vacancy URL, GET the detail page. Each detail page
 *      embeds a clean `<script type="application/ld+json">` schema.org
 *      JobPosting block with `title`, `description` (HTML),
 *      `jobLocation.address`, `datePosted`, `employmentType`, `workHours`,
 *      `hiringOrganization`, `occupationalCategory`.
 *
 *      jobs.ch quirk: `jobLocation.address.addressRegion` actually holds the
 *      CITY name (e.g. "Volketswil"), not a canton code — we treat it as the
 *      location and derive the real canton via `inferSwissTargetCanton()` /
 *      `inferAnyCanton()`. `streetAddress` is sometimes a combined
 *      "street, postal city" string and sometimes empty — cleaned/defaulted
 *      in `cleanStreetAddress()`.
 *
 * All parsed jobs ship with `needsRetranslation: true` so the shared AI
 * localization step fills the remaining 3 locales.
 *
 * Implements the 4 exports required by the standard crawler template, plus
 * the parsing helpers unit-tested directly:
 *   - fetchAllSaintGobainWeberIsoverJobs()
 *   - isSaintGobainWeberIsoverJob() / isTrustedDomain()
 *   - parseVacancyLinks() / extractJobPostingJsonLd() / cleanStreetAddress()
 *   - detectCategory() / detectEmploymentType() / detectExperienceLevel()
 *   - SAINT_GOBAIN_WEBER_ISOVER_KEY / SAINT_GOBAIN_WEBER_ISOVER_COMPANY_NAME /
 *     SAINT_GOBAIN_WEBER_ISOVER_COMPANY_DOMAIN
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

export const SAINT_GOBAIN_WEBER_ISOVER_KEY = 'saint-gobain-weber-isover';
export const SAINT_GOBAIN_WEBER_ISOVER_COMPANY_NAME = 'Saint-Gobain Weber/Isover Suisse';
export const SAINT_GOBAIN_WEBER_ISOVER_COMPANY_DOMAIN = 'ch.weber';

const HQ = getCompanyDefaults(SAINT_GOBAIN_WEBER_ISOVER_KEY) || {
  city: 'Baden',
  canton: 'AG',
  postalCode: '5405',
  addressRegion: 'AG',
};

const BASE_URL = 'https://www.jobs.ch';

// Known jobs.ch company profile pages for the two Swiss Saint-Gobain
// building-materials entities. Isover currently has 0 open positions — its
// company page yields no vacancy links, which is expected.
const COMPANY_TARGETS = [
  { path: '40563-saint-gobain-weber-ag', label: 'Saint-Gobain Weber AG' },
  { path: '107006-saint-gobain-isover-sa', label: 'Saint-Gobain Isover SA' },
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
 * city" string (e.g. "Industriestrasse 10, 8604 Volketswil") and sometimes
 * as an empty string. Strip the redundant trailing "postal city" segment
 * when present; fall back to the city name (safe default) when empty.
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
  if (/labor|chemi|chemist|farbmetri|analys|f&e|forschung|entwicklung|r&d/i.test(combined)) return 'Tecnica';
  if (/produk|production|fabrik|anlagenführ|maschinenführ|operator|betrieb|werk/i.test(combined)) return 'Produzione';
  if (/verkauf|sales|vertrieb|aussendienst|key account|commercial|conseill/i.test(combined)) return 'Commerciale';
  if (/logist|lager|warehouse|chauffeur|driver|transport|versand|dispon/i.test(combined)) return 'Logistica';
  if (/market|kommunik|comunicaz/i.test(combined)) return 'Marketing';
  if (/\bit\s|software|develop|programm|digital|informatik|system.?admin/i.test(combined)) return 'IT';
  if (/finanz|finance|controll|buchhalt|accounting/i.test(combined)) return 'Finanza';
  if (/hr\b|human|personal|recruit/i.test(combined)) return 'Risorse Umane';
  if (/admin|segret|empfang|office|büro|assist/i.test(combined)) return 'Amministrazione';
  if (/qualit|qa\b|qc\b|quality/i.test(combined)) return 'Qualità';
  if (/legal|recht|jurist|compliance/i.test(combined)) return 'Legale';
  if (/engineer|ingenieur|entwickl/i.test(combined)) return 'Ingegneria';
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

/* ── Experience level detection ───────────────────────────── */

export function detectExperienceLevel(title = '') {
  const t = String(title || '').toLowerCase();
  if (/praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|ausbildung|trainee/i.test(t)) return 'intern';
  if (/junior|jr\b/i.test(t)) return 'junior';
  if (/senior|sr\b|lead|head|director|dirett|chef|verantwort|responsab|leiter|manager/i.test(t)) return 'senior';
  return 'mid';
}

/* ── Job identification ───────────────────────────────────── */

export function isSaintGobainWeberIsoverJob(job = {}) {
  const key = String(job?.companyKey || '')
    .trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();

  return (
    key === SAINT_GOBAIN_WEBER_ISOVER_KEY ||
    key.startsWith('saint-gobain-weber-isover') ||
    company.includes('saint-gobain weber') ||
    company.includes('saint-gobain isover') ||
    company.includes('weber ag') ||
    company.includes('isover sa') ||
    url.includes('ch.weber') ||
    url.includes('isover.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'jobs.ch' ||
      host === 'www.jobs.ch' ||
      host.endsWith('.jobs.ch') ||
      host === 'ch.weber' ||
      host === 'www.ch.weber' ||
      host.endsWith('.weber') ||
      host === 'isover.ch' ||
      host === 'www.isover.ch' ||
      host.endsWith('.isover.ch') ||
      host === 'saint-gobain.ch' ||
      host === 'www.saint-gobain.ch' ||
      host.endsWith('.saint-gobain.ch')
    );
  } catch {
    return false;
  }
}

/* ── Main fetch function ──────────────────────────────────── */

/**
 * Fetch all Saint-Gobain Weber/Isover Suisse jobs published on jobs.ch.
 *
 * Returns an array of ParsedJob objects with source-locale fields only.
 * Other locales are filled by the shared AI localization step.
 */
export async function fetchAllSaintGobainWeberIsoverJobs() {
  console.log('🧱 Fetching Saint-Gobain Weber/Isover Suisse jobs from jobs.ch company pages');

  const vacancyUrls = new Set();
  for (const target of COMPANY_TARGETS) {
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
    console.warn('⚠️ No Saint-Gobain Weber/Isover vacancy URLs found on jobs.ch');
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
    const jobSlug = slugify(`${title} ${SAINT_GOBAIN_WEBER_ISOVER_KEY} ${city}`);

    jobs.push({
      id: `${SAINT_GOBAIN_WEBER_ISOVER_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: hiringOrg || SAINT_GOBAIN_WEBER_ISOVER_COMPANY_NAME,
      companyKey: SAINT_GOBAIN_WEBER_ISOVER_KEY,
      companyDomain: SAINT_GOBAIN_WEBER_ISOVER_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: city,
      canton,
      url: jobUrl,
      source: 'Saint-Gobain Weber/Isover Suisse Dedicated Parser (jobs.ch)',
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
      sector: 'Edilizia / Materiali da Costruzione',
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

  console.log(`\n📋 Total unique Saint-Gobain Weber/Isover Suisse jobs discovered: ${jobs.length}`);
  return jobs;
}
