#!/usr/bin/env node
/**
 * Tertianum job parser — SuccessFactors CSB (tile-search variant).
 *
 * Public career site: https://jobs.tertianum.ch (SuccessFactors Career Site
 * Builder, tile-search flavor — different from the classic html-jobreq layout
 * used by ZURZACH Care). Tertianum is one of the largest Swiss premium senior
 * living and care operators (~30 residences across DE-CH + Suisse romande).
 *
 * Crawl strategy:
 *
 *   1. GET https://jobs.tertianum.ch/sitemap.xml → returns 200+ `<loc>` entries
 *      of the form `https://jobs.tertianum.ch/job/{City}-{Slug}-{REG}-{PLZ}/{jobId}/`.
 *      We treat the sitemap as the source of truth because the `/search/` page
 *      is a SuccessFactors widget-loader SPA — its job tiles are XHR-loaded and
 *      not reachable via plain HTTP.
 *
 *   2. For each URL, GET the detail page. SF CSB renders the JobPosting
 *      microdata server-side inside a `<div class="jobDisplayShell"
 *      itemscope itemtype="http://schema.org/JobPosting">` wrapper. Title is
 *      in `<meta property="og:title">`, description body in
 *      `<div class="joblayouttoken displayDTM">` (containing the full HTML
 *      of the job posting). Date is in `<meta itemprop="datePosted">`.
 *
 *   3. URL embeds city + canton + postal code: `{City}-{...}-{XX}-{NNNN}` —
 *      we extract them with a regex, since the SPA renders the location
 *      block only after JS execution.
 *
 * Locale handling: detail pages preserve the source language in `xml:lang`
 * attributes inside the description block (`fr-FR`, `de-DE`, `it-IT`).
 *
 * All parsed jobs ship with `needsRetranslation: true` so the shared AI
 * localization step fills the remaining 3 locales.
 *
 * Implements the 4 exports required by the standard crawler template.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

export const TERTIANUM_KEY = 'tertianum';
export const TERTIANUM_COMPANY_NAME = 'Tertianum';
export const TERTIANUM_COMPANY_DOMAIN = 'tertianum.ch';
const BASE_URL = 'https://jobs.tertianum.ch';
const SITEMAP_URL = `${BASE_URL}/sitemap.xml`;
const DETAIL_DELAY_MS = 220;

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

/* ── Sitemap walker ───────────────────────────────────────── */

export function parseTertianumSitemap(xml = '') {
  if (!xml) return [];
  const out = [];
  const re = /<loc>\s*(https?:\/\/jobs\.tertianum\.ch\/job\/[^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const url = m[1].trim();
    const idMatch = url.match(/\/(\d{6,})\/?$/);
    if (!idMatch) continue;
    out.push({ url, jobId: idMatch[1] });
  }
  return out;
}

/* ── URL parser — pull city / canton / postal from URL ────── */

const SWISS_CANTONS = new Set([
  'AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU',
  'NE', 'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS',
  'ZG', 'ZH',
]);

export function parseTertianumUrlMetadata(url = '') {
  // Expected pattern: .../job/{City}-{...}-{CANTON}-{PLZ}/{jobId}/
  // E.g. /job/Horgen-Lernender-Restaurationsangestellter-Z%C3%BCri-8810/1374564933/
  // Note: VAUD URLs sometimes use "VD-1024", german ones use "Züri-8810" /
  // "Bern-3000" (city as canton-name) — we look for the trailing 4-digit
  // postal code and the 2-letter canton code preceding it.
  try {
    const u = decodeURIComponent(url);
    const slugSeg = u.match(/\/job\/([^/]+)\/\d{6,}\/?$/);
    if (!slugSeg) return null;
    const slug = slugSeg[1];
    // Trailing "-CC-NNNN" — capture canton + PLZ
    const tail = slug.match(/-([A-Za-zÀ-ÿ]{2,15})-(\d{4})$/);
    let postalCode = '';
    let cantonGuess = '';
    let leftover = slug;
    if (tail) {
      cantonGuess = tail[1];
      postalCode = tail[2];
      leftover = slug.slice(0, slug.length - tail[0].length);
    }
    // City is the first hyphen-separated token before the title
    const firstHyphen = leftover.indexOf('-');
    const city = firstHyphen > 0 ? leftover.slice(0, firstHyphen) : leftover;
    return { city: city.replace(/_/g, ' '), cantonGuess, postalCode };
  } catch {
    return null;
  }
}

/* ── Detail page parser ───────────────────────────────────── */

export function parseTertianumDetailPage(html = '') {
  if (!html) return null;
  // Title: prefer og:title
  let title = '';
  const ogt = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (ogt) title = decodeEntities(ogt[1]).trim();
  if (!title) {
    const t = html.match(/<title>([^<]+)<\/title>/i);
    if (t) title = decodeEntities(t[1]).split(/[|–-]/)[0].trim();
  }

  // Description: the .joblayouttoken / .displayDTM block carries the full
  // job posting HTML. There are usually 2-3 such blocks (title, body, footer).
  const descBlocks = [];
  const blockRe = /<div class="joblayouttoken[^"]*displayDTM[^"]*"[^>]*>([\s\S]*?)(?=<div class="joblayouttoken|<\/div>\s*<\/div>\s*<\/div>\s*<\/div>)/gi;
  let bm;
  while ((bm = blockRe.exec(html)) !== null) {
    descBlocks.push(bm[1]);
  }
  let descriptionText = htmlToText(descBlocks.join('\n')).trim();

  // Source language — detect from xml:lang attribute inside description block
  let language = '';
  const langMatch = html.match(/xml:lang=["']([a-z]{2})/i);
  if (langMatch) language = langMatch[1].toLowerCase();
  if (!language) {
    const htmlLang = html.match(/<html[^>]+lang=["']([a-z]{2})/i);
    if (htmlLang) language = htmlLang[1].toLowerCase();
  }

  // Date posted — schema.org itemprop or `data-careersite-propertyid="latestHireDate"`
  let postedDate = '';
  const dp = html.match(/itemprop=["']datePosted["'][^>]*content=["']([^"']+)["']/i);
  if (dp) {
    const d = new Date(dp[1]);
    if (!Number.isNaN(d.getTime())) postedDate = d.toISOString().slice(0, 10);
  }

  // Apply URL — SF "Apply Now" widget points at /sfcareer/jobreqcareer or the
  // talentcommunity endpoint. Fall back to canonical URL.
  const applyMatch = html.match(/href=["']([^"']*sfcareer\/jobreqcareer[^"']+)["']/i)
    || html.match(/href=["']([^"']*talentcommunity\/apply[^"']+)["']/i);
  const applyUrl = applyMatch ? applyMatch[1] : '';

  return { title, descriptionText, language, postedDate, applyUrl };
}

/* ── Factory-style exports ────────────────────────────────── */

export async function fetchAllTertianumJobs() {
  console.log(`🏥 Fetching ${TERTIANUM_COMPANY_NAME} jobs`);
  console.log(`   Source: ${BASE_URL} (SuccessFactors CSB via sitemap)\n`);

  let sitemapXml = '';
  try {
    sitemapXml = await fetchHtml(SITEMAP_URL);
  } catch (err) {
    throw new Error(`Failed to fetch Tertianum sitemap: ${err?.message || err}`);
  }
  const listings = parseTertianumSitemap(sitemapXml);
  if (!listings.length) {
    console.warn('⚠️ No job URLs found in Tertianum sitemap');
    return [];
  }
  console.log(`  📋 Job URLs discovered: ${listings.length}\n`);

  const jobs = [];
  for (const listing of listings) {
    const urlMeta = parseTertianumUrlMetadata(listing.url) || {};
    let detail = null;
    try {
      const detailHtml = await fetchHtml(listing.url);
      detail = parseTertianumDetailPage(detailHtml);
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${listing.jobId}: ${err?.message || err}`);
    }

    const title = (detail?.title || '').trim();
    if (!title) continue;

    const city = urlMeta.city || 'Zürich';
    const postalCode = urlMeta.postalCode || '8000';
    const cantonRaw = (urlMeta.cantonGuess || '').toUpperCase();
    let canton = SWISS_CANTONS.has(cantonRaw) ? cantonRaw : '';
    if (!canton) canton = inferSwissTargetCanton(city) || 'ZH';

    let description = detail?.descriptionText || '';
    const uniqueWords = new Set(
      description.toLowerCase().replace(/[^a-zà-ÿäöüß\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2),
    );
    if (uniqueWords.size < 30) {
      description = `${title} bei ${TERTIANUM_COMPANY_NAME} in ${city}.\n\n${TERTIANUM_COMPANY_NAME} ist eine der führenden Schweizer Anbieterinnen für Wohnen und Pflege im Alter mit rund 30 Residenzen in der ganzen Schweiz. Diese Stelle bietet ein modernes Arbeitsumfeld, attraktive Anstellungsbedingungen und vielfältige Weiterbildungsmöglichkeiten.`;
    }

    const sourceLang = (detail?.language && /^(de|fr|it|en)$/.test(detail.language))
      ? detail.language
      : detectLang(description || title, 'de');

    const postedDate = detail?.postedDate || new Date().toISOString().slice(0, 10);
    const employmentType = detectHealthcareEmploymentType(title);
    const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${title} ${TERTIANUM_KEY} ${city}`);
    const applyUrl = detail?.applyUrl
      ? (detail.applyUrl.startsWith('http') ? detail.applyUrl : `${BASE_URL}${detail.applyUrl}`)
      : listing.url;

    const job = {
      id: `${TERTIANUM_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: TERTIANUM_COMPANY_NAME,
      companyKey: TERTIANUM_KEY,
      companyDomain: TERTIANUM_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: city,
      canton,
      url: listing.url,
      source: 'Tertianum Dedicated Parser (SuccessFactors CSB)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: city,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode,
      category: detectHealthcareCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };
    jobs.push(job);

    await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
  }

  const seen = new Set();
  const deduped = [];
  for (const job of jobs) {
    const k = job.url.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(job);
  }
  console.log(`\n📋 Total unique ${TERTIANUM_COMPANY_NAME} jobs: ${deduped.length}`);
  return deduped;
}

export function isTertianumJob(job) {
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');
  if (key === TERTIANUM_KEY) return true;
  if (company.includes('tertianum')) return true;
  if (url.includes('jobs.tertianum.ch') || url.includes('tertianum.ch')) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'jobs.tertianum.ch'
      || host === 'tertianum.ch'
      || host === 'www.tertianum.ch'
      || host.endsWith('.tertianum.ch')
      || host.endsWith('.successfactors.eu')
      || host.endsWith('.successfactors.com');
  } catch {
    return false;
  }
}
