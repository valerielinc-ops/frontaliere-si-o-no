#!/usr/bin/env node
/**
 * BMS Building Materials job parser — Fetcher and job builder.
 *
 * Source: https://jobs.bmsuisse.ch/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllBmsBuildingJobs()  — Fetch and parse all jobs
 *   - isBmsBuildingJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { extractDetailFields, isSufficientVacancyDescription } from './prospector/extract.mjs';
import {
  fetchHtml as sharedFetchHtml,
  normalizeDescriptionSpace,
  slugify,
  stripHtml,
} from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton, isTargetSwissLocation  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const BMS_BUILDING_KEY = 'bms-building';
export const BMS_BUILDING_COMPANY_NAME = 'BMS Building Materials';
export const BMS_BUILDING_COMPANY_DOMAIN = 'bmsuisse.ch';

const CAREER_URL = 'https://jobs.bmsuisse.ch/';
const BMS_DETAIL_SELECTOR = '.tx-webx-jobs > .details';

// The old parser started at the document body, so every saved description
// began with this exact menu rendering. Keep the whole sequence anchored: a
// shorter match would risk deleting source prose that merely mentions BMS.
export const BMS_NAVIGATION_PREFIX_RE = /^\s*•\s*X\s+Arbeiten\s+bei\s+BMS\s+Arbeiten\s+bei\s+BMS\s+Unsere\s+Werte\s+Deine\s+Benefits\s+Health\s*&\s*Safety\s+Jobs\s+Jobs\s+Offene\s+Stellen\s+Lehrstellen\s+DE\s+FR\s+IT\s+DE\s+/i;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to BMS Building Materials.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isBmsBuildingJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === BMS_BUILDING_KEY ||
    key.startsWith('bms-building') ||
    company.includes('bms building materials') ||
    url.includes('bmsuisse.ch')
  );
}

/**
 * Validate that a URL belongs to BMS Building Materials's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'bmsuisse.ch' || host.endsWith('.bmsuisse.ch');
  } catch {
    return false;
  }
}

/**
 * Remove the complete BMS navigation prefix from a stored source body.
 *
 * This deliberately does not recognise an isolated menu word or a partial
 * language switcher: only the full, anchored sequence emitted by the old
 * document-level fallback is historical chrome.
 */
export function stripBmsNavigationPrefix(value = '') {
  return String(value || '').replace(BMS_NAVIGATION_PREFIX_RE, '').trim();
}

/**
 * Repair stored BMS bodies before locale-preserving merge.
 *
 * The source slot is kept (with its chrome removed); every non-source
 * description slot is dropped because it was translated from the dirty body.
 * The title/slug maps are intentionally untouched so published URLs remain
 * stable while the localization step rebuilds the descriptions.
 */
export function prepareBmsBuildingExistingJobs(jobs = []) {
  const list = Array.isArray(jobs) ? jobs : [];
  let repaired = 0;

  for (const job of list) {
    if (!job || typeof job !== 'object') continue;
    const byLocale = job.descriptionByLocale && typeof job.descriptionByLocale === 'object'
      ? job.descriptionByLocale
      : {};
    const sourceLang = String(job.sourceLang || 'de');
    const sourceValues = [job.description, byLocale[sourceLang]];
    const hasDirtySource = sourceValues.some((value) => BMS_NAVIGATION_PREFIX_RE.test(String(value || '')));
    if (!hasDirtySource) continue;

    let changed = false;
    if (typeof job.description === 'string') {
      const cleaned = stripBmsNavigationPrefix(job.description);
      if (cleaned !== job.description) {
        job.description = cleaned;
        changed = true;
      }
    }
    if (typeof byLocale[sourceLang] === 'string') {
      const cleaned = stripBmsNavigationPrefix(byLocale[sourceLang]);
      if (cleaned !== byLocale[sourceLang]) {
        byLocale[sourceLang] = cleaned;
        changed = true;
      }
    }

    let droppedLocalizedSlots = 0;
    for (const locale of Object.keys(byLocale)) {
      if (locale === sourceLang) continue;
      delete byLocale[locale];
      droppedLocalizedSlots += 1;
    }
    if (droppedLocalizedSlots > 0) job.needsRetranslation = true;
    if (changed || droppedLocalizedSlots > 0) repaired += 1;
  }

  if (repaired > 0) {
    console.log(
      `  🧹 ${BMS_BUILDING_COMPANY_NAME}: removed the complete navigation prefix from `
      + `${repaired} stored job(s); localized slots will be retranslated`,
    );
  }
  return list;
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
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
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

/* ── HTTP helpers ─────────────────────────────────────────── */

const LISTING_URL = 'https://jobs.bmsuisse.ch/jobs/offene-stellen/';
const JOB_BASE = 'https://jobs.bmsuisse.ch';

/**
 * Fetch a URL and return HTML text with timeout handling.
 */
async function fetchHtml(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  return sharedFetchHtml(url, {
    timeoutMs,
    headers: {
      Accept: 'text/html,application/xhtml+xml,*/*',
      'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
        'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
    },
  });
}

/**
 * Parse the BMS listing page HTML to extract job entries.
 * Each job appears as a link to /jobs/detail/{id}-{slug}/
 * with location info (postal code + city) and employment type.
 */
function parseListingPage(html = '') {
  const entries = [];

  // Match job detail links: /jobs/detail/{id}-{slug}/
  const linkPattern = /href="(\/jobs\/detail\/(\d+)-[^"]+)"/gi;
  let match;

  while ((match = linkPattern.exec(html)) !== null) {
    const relUrl = match[1];
    const jobId = match[2];
    const fullUrl = `${JOB_BASE}${relUrl}`;

    // Look at the surrounding context (500 chars after the link) for metadata
    const context = html.slice(match.index, match.index + 800);

    // Extract title from the anchor tag content
    const titleMatch = context.match(/href="[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/a>/i);
    const title = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';

    // Extract location (postal code + city pattern)
    const locMatch = context.match(/(\d{4})\s+([\w\u00C0-\u024F\s\-.]+?)(?:\s*<|,|\n)/);
    const postalCode = locMatch ? locMatch[1] : '';
    const city = locMatch ? normalizeSpace(locMatch[2]) : '';

    // Extract employment type (Full-time / Part-time)
    const empMatch = context.match(/(?:Full-time|Part-time|Vollzeit|Teilzeit)/i);
    const employmentRaw = empMatch ? empMatch[0] : '';

    if (title && title.length >= 3) {
      entries.push({
        jobId,
        url: fullUrl,
        title,
        city,
        postalCode,
        employmentRaw,
      });
    }
  }

  // Deduplicate by jobId
  const seen = new Set();
  return entries.filter((e) => {
    if (seen.has(e.jobId)) return false;
    seen.add(e.jobId);
    return true;
  });
}

/**
 * Extract only the BMS announcement container from a detail page.
 *
 * The page has no JobPosting wrapper that the generic extractor can safely
 * select. The real announcement is the direct `.details` child of the jobs
 * component; the navigation and site footer live outside it. The generic
 * extractor is still used for structured fields and future markup variants,
 * while the description is fail-closed when this source-specific container is
 * absent.
 */
export function extractBmsBuildingDetailFields(html = '', pageUrl = '', opts = {}) {
  const source = String(html || '');
  const base = extractDetailFields(source, pageUrl, opts);
  if (!source) return { ...base, description: '' };

  const dom = new JSDOM(source);
  try {
    const details = dom.window.document.querySelector(BMS_DETAIL_SELECTOR);
    if (!details) return { ...base, description: '' };

    const content = details.cloneNode(true);
    content.querySelectorAll('header, footer, nav, .footer-frame, .job-title').forEach((node) => node.remove());
    const description = normalizeDescriptionSpace(
      stripHtml(content.innerHTML).replace(/^[ \t]*•[ \t]+/gm, '- '),
    );
    return {
      ...base,
      title: normalizeSpace(details.querySelector('.job-title')?.textContent || base.title || ''),
      description: isSufficientVacancyDescription(description) ? description : '',
    };
  } finally {
    dom.window.close();
  }
}

/**
 * Parse a BMS detail page to extract the announcement and application URL.
 */
function parseDetailPage(html = '', pageUrl = '') {
  if (!html) return null;

  const detail = extractBmsBuildingDetailFields(html, pageUrl, { recordUrl: pageUrl });

  // Extract apply URL (Onlyfy pattern or generic apply link)
  const applyMatch = html.match(/href="(https:\/\/bmsuisse\.onlyfy\.jobs\/[^"]+)"/i)
    || html.match(/href="([^"]*(?:apply|bewerb|onlyfy)[^"]*)"/i);
  const applyUrl = applyMatch ? applyMatch[1] : '';

  // Extract requirements (look for list items in requirement sections)
  const reqMatch = html.match(/(?:Anforderungen|Requirements|Profil|bringst du mit)([\s\S]*?)(?:<h[23]|<\/section|$)/i);
  const requirements = reqMatch
    ? [...reqMatch[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
        .map((m) => stripHtml(m[1]).trim())
        .filter((s) => s.length > 3)
    : [];

  return { ...detail, applyUrl, requirements };
}

/**
 * Fetch all BMS Building Materials jobs in Switzerland.
 * Strategy:
 *   1. Fetch the listing page HTML
 *   2. Parse job entries from HTML
 *   3. Filter for Swiss locations
 *   4. Fetch detail pages for richer descriptions
 *
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllBmsBuildingJobs() {
  console.log(`🔍 Fetching BMS Building Materials jobs`);
  console.log(`   Source: ${LISTING_URL}`);
  console.log(`   Strategy: Listing page → filter Switzerland → detail pages\n`);

  const listingHtml = await fetchHtml(LISTING_URL);
  const allEntries = parseListingPage(listingHtml);
  console.log(`  📋 Total jobs on listing page: ${allEntries.length}`);

  const swissEntries = allEntries.filter((e) => isTargetSwissLocation(`${e.city} ${e.postalCode}`));
  console.log(`  🇨🇭 Swiss jobs: ${swissEntries.length}`);

  if (swissEntries.length === 0) {
    console.warn('⚠️ No Swiss job listings found.');
    return [];
  }

  console.log(`\n  📋 Fetching ${swissEntries.length} detail pages...\n`);

  const jobs = [];
  for (const entry of swissEntries) {
    try {
      const detailHtml = await fetchHtml(entry.url);
      const detail = parseDetailPage(detailHtml);

      const title = detail?.title || entry.title;
      const location = entry.city || '';
      const canton = inferAnyCanton(location) || '';
      // Publish source text only. The standard pipeline quarantines a missing
      // or thin body instead of allowing a fabricated title/location fallback.
      const rawDesc = detail?.description || '';
      const descriptionText = rawDesc.trim();

      const sourceLang = detectLang(descriptionText || title, 'de');
      const jobSlug = slugify(`${title} bms-building ch`);
      const urlHash = createHash('sha1').update(entry.url).digest('hex').slice(0, 12);

      const job = {
        // ── Required fields ──
        id: `bms-building-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: BMS_BUILDING_COMPANY_NAME,
        companyKey: BMS_BUILDING_KEY,
        companyDomain: BMS_BUILDING_COMPANY_DOMAIN,
        title,
        titleByLocale: { [sourceLang]: title },
        description: descriptionText,
        descriptionByLocale: { [sourceLang]: descriptionText },
        location,
        canton,
        url: entry.url,
        source: 'BMS Building Materials Dedicated Parser',
        sourceLang,
        crawledAt: new Date().toISOString(),

        // ── Recommended fields ──
        addressLocality: location,
        addressCountry: 'CH',
        country: 'CH',
        ...(entry.postalCode ? { postalCode: entry.postalCode } : {}),
        category: detectCategory(title),
        contract: 'full-time',
        employmentType: detectEmploymentType(entry.employmentRaw || title),
        experienceLevel: detectExperienceLevel(title),
        sector: 'Edilizia / Materiali da costruzione',
        currency: 'CHF',
        featured: false,
        postedDate: new Date().toISOString().split('T')[0],
        applyUrl: detail?.applyUrl || entry.url,
        requirements: detail?.requirements || [],
        requirementsByLocale: { [sourceLang]: detail?.requirements || [] },
      };

      jobs.push(job);
      console.log(`  ✅ #${entry.jobId} — ${title.substring(0, 60)}`);
    } catch (err) {
      console.warn(`  ⚠️ Skipping #${entry.jobId} — ${err?.message || err}`);
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\n📋 Total BMS Building Materials Swiss jobs discovered: ${jobs.length}`);
  return jobs;
}
