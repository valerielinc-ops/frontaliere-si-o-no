#!/usr/bin/env node
/**
 * Spitäler fmi AG — Frutigen Meiringen Interlaken (Berner Oberland, BE).
 *
 * Public career site:  https://www.spitalfmi.ch/karriere
 * Listing iframe host: https://fmi.prospective.ch/    (legacy Prospective.ch careercenter)
 * Detail host:         https://jobs.spitalfmi.ch/offene-stellen/{slug}/{uuid}
 *
 * Why a dedicated parser and not the shared Prospective.ch factory:
 *   fmi runs an older Prospective "careercenter" tenant. Its medium_id is
 *   exposed only as a path prefix (`/careercenter/1000273/...`) and the
 *   public `/public/v1/medium/{id}/jobs` JSON endpoint returns HTTP 400 for
 *   this tenant — it is not whitelisted server-side. The listing is server
 *   rendered HTML returned by `POST https://fmi.prospective.ch/` with
 *   `offset=0&limit=100&lang=de`. Detail pages on `jobs.spitalfmi.ch` ship
 *   a clean schema.org JobPosting JSON-LD blob inside a single
 *   <script type="application/ld+json"> tag, which we use as the canonical
 *   source for description / location / employmentType / datePosted.
 *
 * Coverage: ~63 open positions across Spital Interlaken (3800 Unterseen),
 * Spital Frutigen (3714 Frutigen), Gesundheitszentrum Meiringen,
 * Seniorenpark Frutigen, Seniorenpark Weissenau (Interlaken),
 * Rettungsdienst, Walk-in-Clinic. All in canton Bern.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  USER_AGENT,
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

export const FMI_KEY = 'fmi';
export const FMI_COMPANY_NAME = 'Spitäler fmi AG';
export const FMI_COMPANY_DOMAIN = 'spitalfmi.ch';

const LISTING_URL = 'https://fmi.prospective.ch/';
const DETAIL_HOST = 'jobs.spitalfmi.ch';

// Site label → { city, postalCode } (canton stays BE for every fmi site).
const SITE_LOCATIONS = {
  'spital interlaken':         { city: 'Unterseen',  postalCode: '3800' },
  'spital frutigen':           { city: 'Frutigen',   postalCode: '3714' },
  'gesundheitszentrum meiringen': { city: 'Meiringen', postalCode: '3860' },
  'seniorenpark frutigen':     { city: 'Frutigen',   postalCode: '3714' },
  'seniorenpark weissenau':    { city: 'Unterseen',  postalCode: '3800' },
  'rettungsdienst':            { city: 'Interlaken', postalCode: '3800' },
  'walk-in-clinic':            { city: 'Interlaken', postalCode: '3800' },
};
const DEFAULT_CITY = 'Interlaken';
const DEFAULT_POSTAL = '3800';
const DEFAULT_CANTON = 'BE';

export function isFmiJob(job) {
  if (!job) return false;
  if (job.companyKey === FMI_KEY) return true;
  const url = String(job.url || '').toLowerCase();
  const company = String(job.company || '').toLowerCase();
  if (url.includes('spitalfmi.ch')) return true;
  if (url.includes('fmi.prospective.ch')) return true;
  if (company.includes('spitäler fmi') || company.includes('spitaler fmi')) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'spitalfmi.ch' || host.endsWith('.spitalfmi.ch')) return true;
    if (host === 'fmi.prospective.ch') return true;
    return false;
  } catch {
    return false;
  }
}

async function postListing({ offset = 0, limit = 100, lang = 'de', timeoutMs } = {}) {
  const t = timeoutMs || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), t);
  try {
    const body = new URLSearchParams({ offset: String(offset), limit: String(limit), lang });
    const res = await fetch(LISTING_URL, {
      method: 'POST',
      headers: {
        Accept: 'text/html,application/xhtml+xml,*/*',
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${LISTING_URL}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function fetchDetail(url, { timeoutMs } = {}) {
  const t = timeoutMs || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), t);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/html,application/xhtml+xml,*/*', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    return '';
  }
}

/**
 * Parse the listing HTML into { url, title, category, site } records.
 * Skips PDF-only entries (older legacy postings linking to assets/images).
 */
export function parseFmiListing(html) {
  const out = [];
  const seen = new Set();

  // Each posting is an <a class="job" href="..."> ... </a> block.
  const linkRx = /<a\s+class="job"\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = linkRx.exec(html))) {
    const url = m[1];
    const body = m[2];

    // Skip PDF brochure entries — no machine-readable detail page.
    if (/\.pdf(?:$|[?#])/i.test(url)) continue;
    if (!/jobs\.spitalfmi\.ch\/offene-stellen\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const catMatch = body.match(/<div class="jobTitle">\s*<span>([\s\S]*?)<\/span>/);
    const titleMatch = body.match(/<div class="jobTitle">[\s\S]*?<h2>([\s\S]*?)<\/h2>/);
    const siteMatch = body.match(/<div class="jobArbeitsOrt">([\s\S]*?)<\/div>\s*<div class="mehrErfahren"/);

    const title = titleMatch ? normalizeSpace(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, ' '))) : '';
    if (!title || title.length < 3) continue;
    const category = catMatch ? normalizeSpace(decodeEntities(catMatch[1].replace(/<[^>]+>/g, ' '))) : '';
    const site = siteMatch
      ? normalizeSpace(decodeEntities(siteMatch[1].replace(/<[^>]+>/g, ' ').replace(/<\?xml[\s\S]*?\?>/g, '')))
      : '';

    out.push({ url, title, category, site });
  }
  return out;
}

function extractJsonLd(html) {
  // Find the JobPosting JSON-LD block. fmi pages embed it as a single
  // <script type="application/ld+json"> tag with one JSON object.
  const rx = /<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = rx.exec(html))) {
    const raw = m[1].trim();
    if (!/"@type"\s*:\s*"JobPosting"/i.test(raw)) continue;
    try {
      return JSON.parse(raw);
    } catch {
      // ignore malformed; keep scanning
    }
  }
  return null;
}

function mapSiteLocation(siteLabel = '') {
  const key = String(siteLabel || '').toLowerCase().trim();
  for (const [k, v] of Object.entries(SITE_LOCATIONS)) {
    if (key.includes(k)) return v;
  }
  return null;
}

function pickLocation(jsonLd, siteLabel) {
  // Prefer JSON-LD postal address; fall back to listing site label mapping.
  const addr = jsonLd?.jobLocation?.address || {};
  const city = normalizeSpace(addr.addressLocality || '');
  const postalCode = normalizeSpace(addr.postalCode || '');
  if (city) {
    return {
      city,
      postalCode: postalCode || mapSiteLocation(siteLabel)?.postalCode || DEFAULT_POSTAL,
    };
  }
  const mapped = mapSiteLocation(siteLabel);
  if (mapped) return mapped;
  return { city: DEFAULT_CITY, postalCode: DEFAULT_POSTAL };
}

function pickEmploymentType(jsonLd, title) {
  const raw = String(jsonLd?.employmentType || '').toUpperCase();
  if (raw === 'PART_TIME') return 'PART_TIME';
  if (raw === 'FULL_TIME') return 'FULL_TIME';
  if (raw === 'CONTRACTOR' || raw === 'TEMPORARY') return 'OTHER';
  // Fallback to healthcare heuristic on the title (covers "80-100%" style).
  return detectHealthcareEmploymentType(title);
}

function buildDescription(jsonLd, fallbackTitle, siteLabel) {
  const parts = [];
  const desc = htmlToText(jsonLd?.description || '');
  if (desc) parts.push(desc);
  if (!desc) {
    const resp = htmlToText(jsonLd?.responsibilities || '');
    const qual = htmlToText(jsonLd?.qualifications || '');
    if (resp) parts.push(`Aufgaben:\n${resp}`);
    if (qual) parts.push(`Anforderungen:\n${qual}`);
  }
  if (!parts.length && fallbackTitle) parts.push(fallbackTitle);
  if (siteLabel) parts.push(`Standort: ${siteLabel}`);
  parts.push(
    'Zur Spitäler fmi AG gehören die Akutspitäler Interlaken und Frutigen, das Gesundheitszentrum Meiringen, die Seniorenparks Frutigen und Weissenau, der Rettungsdienst und die Walk-in-Clinic im Berner Oberland.',
  );
  return parts.filter(Boolean).join('\n\n');
}

export async function fetchAllFmiJobs() {
  console.log(`🏥 Fetching ${FMI_COMPANY_NAME} jobs`);
  console.log(`   Source:  ${LISTING_URL}  (POST offset/limit/lang form)`);
  console.log(`   Details: https://${DETAIL_HOST}/offene-stellen/...\n`);

  // Listing is paginated; we request a generous page first and keep
  // walking until a page returns fewer than `limit` postings.
  const PAGE = 100;
  let offset = 0;
  const items = [];
  const seen = new Set();
  // Hard upper bound to avoid runaway loops on a misbehaving server.
  for (let i = 0; i < 10; i++) {
    const html = await postListing({ offset, limit: PAGE, lang: 'de' });
    const page = parseFmiListing(html);
    const fresh = page.filter((p) => !seen.has(p.url));
    for (const f of fresh) seen.add(f.url);
    items.push(...fresh);
    console.log(`  📄 offset=${offset} → +${fresh.length} (total ${items.length})`);
    if (page.length < PAGE) break;
    offset += PAGE;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`  ✓ ${items.length} Stellen aus dem Stellenmarkt`);
  if (!items.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let detailHits = 0;
  for (const it of items) {
    const detailHtml = await fetchDetail(it.url);
    const jsonLd = detailHtml ? extractJsonLd(detailHtml) : null;
    if (jsonLd) detailHits++;
    await new Promise((r) => setTimeout(r, 250));

    const title = normalizeSpace(jsonLd?.title || it.title);
    const { city, postalCode } = pickLocation(jsonLd, it.site);
    const description = buildDescription(jsonLd, title, it.site);
    const employmentType = pickEmploymentType(jsonLd, `${title} ${it.category}`);
    const datePosted = String(jsonLd?.datePosted || '').slice(0, 10) || todayIso;

    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${FMI_KEY} ${city}`);
    const urlHash = createHash('sha1').update(it.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${FMI_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: FMI_COMPANY_NAME,
      companyKey: FMI_KEY,
      companyDomain: FMI_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Source-locale-only on discovery; cleared by the shared AI-localization
      // step once it fills the remaining 3 locales. Without this flag the
      // locale-completeness gate would trip before translation can run.
      needsRetranslation: true,
      location: city,
      canton: DEFAULT_CANTON,
      url: it.url,
      source: 'Spitäler fmi Dedicated Parser (Prospective careercenter + JSON-LD)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: city,
      addressRegion: DEFAULT_CANTON,
      addressCountry: 'CH',
      country: 'CH',
      postalCode,
      category: detectHealthcareCategory(`${title} ${it.category} ${it.site}`),
      contract: 'full-time',
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(`${title} ${it.category}`),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: datePosted,
      applyUrl: it.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }
  console.log(
    `📋 Total ${FMI_COMPANY_NAME} jobs discovered: ${jobs.length} ` +
      `(${detailHits}/${items.length} with JSON-LD detail content)`,
  );
  return jobs;
}
