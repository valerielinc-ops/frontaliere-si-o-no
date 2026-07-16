#!/usr/bin/env node
/**
 * Bucher + Suter AG job parser — WordPress REST API discovery + own-site
 * HTML detail scrape.
 *
 * Bucher + Suter AG (b+s), HQ Lindenpark, Lindenhofstrasse 1, CH-3048
 * Worblaufen / Bern — the largest Cisco Contact Center Partner in Europe
 * (CTI & Omni-Channel integration for Cisco Contact Center, ~160 employees).
 * Careers hub: https://www.bucher-suter.com/careers/ — runs WordPress with a
 * custom `job-listings` post type (confirmed via `/wp-json/wp/v2/types`,
 * `rest_base: "job-listings"`).
 *
 * IMPORTANT: the WP REST API listing endpoint does NOT expose post content
 * (`acf: []`, no `content` field — the theme renders the body from a
 * non-REST-registered field, likely a page-builder blob in postmeta). The
 * listing endpoint is used ONLY for discovery (id/slug/link/title/dates);
 * the actual job body, Location, and Job Type fields must be scraped from
 * each detail page's live HTML.
 *
 * Crawl strategy:
 *
 * 1. GET https://www.bucher-suter.com/wp-json/wp/v2/job-listings?per_page=50
 *    → array of { id, slug, link, title.rendered, date, modified }. No
 *    pagination needed in practice (~5 open roles at a time).
 * 2. GET each `link` (own bucher-suter.com domain, no anti-bot fence
 *    observed — plain HTTP 200, server-rendered) and extract:
 *    - `Location` / `Job Type` label→value pairs (fixed markup pattern,
 *      identical across both content-layout variants seen on the site).
 *    - The `<div class="article-prose">…</div>` body block (balanced-tag
 *      extraction — two layout variants exist: older postings wrap
 *      sections in `<section class="job__tasks job__grid grid">` with a
 *      `job__tasks__title` header; newer postings (Salesforce roles) use
 *      plain `<h3>`/`<h4>`/`<ul><li>` directly inside `article-prose`.
 *      `htmlToText()` handles both generically.
 * 3. Only Swiss-based postings are indexed. Bucher + Suter also posts a
 *    Germany-remote role (`…-de` slug) — `Location` reads "Germany
 *    (Remote)", no CH municipality — dropped here (same convention as
 *    Duferco: a real Swiss municipality must resolve, never a raw
 *    fallback, or JobPosting ends up geographically contradictory).
 * 4. Only source language (English — the whole site is English-only) is
 *    set; `needsRetranslation: true` so the shared AI localization step
 *    fills the other 3 locales.
 *
 * Source: https://www.bucher-suter.com/careers/
 * Verified live 2026-07-04 via curl (wp-json discovery + detail HTML).
 *
 * Implements 4 exports required by the standard crawler template, plus
 * parsing helpers unit-tested directly:
 * - fetchAllBucherSuterJobs()
 * - isBucherSuterJob() / isTrustedDomain()
 * - extractLabelValue() / extractArticleProseHtml()
 * - detectCategory() / detectEmploymentType() / detectExperienceLevel()
 * - BUCHER_SUTER_KEY / BUCHER_SUTER_COMPANY_NAME / BUCHER_SUTER_COMPANY_DOMAIN
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, normalizeSpace, normalizeDescriptionSpace, warnIfListingAtCap, fetchJson } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import { inferSwissTargetCanton, canonicalSwissCityName, findSwissCityInText } from './target-swiss-locations.mjs';
import {
  fetchHtml,
  decodeEntities,
  htmlToText,
  locateTagByAttribute,
  extractBalancedTagBlock,
} from './hospital-custom-html-helpers.mjs';

export const BUCHER_SUTER_KEY = 'bucher-suter';
export const BUCHER_SUTER_COMPANY_NAME = 'Bucher + Suter AG';
export const BUCHER_SUTER_COMPANY_DOMAIN = 'bucher-suter.com';

const HQ = getCompanyDefaults(BUCHER_SUTER_KEY) || {
  city: 'Bern',
  canton: 'BE',
  postalCode: '3048',
  addressRegion: 'BE',
};

const BASE_URL = 'https://www.bucher-suter.com';
const LISTING_PAGE_CAP = 50;
const API_URL = `${BASE_URL}/wp-json/wp/v2/job-listings?per_page=${LISTING_PAGE_CAP}`;

/* ── Discovery: WordPress REST API listing metadata ─────────────────── */

/**
 * NOTE: this listing endpoint must use fetchJson() (crawler-template.mjs),
 * NOT fetchHtml() (hospital-custom-html-helpers.mjs, used below for detail
 * pages). fetchHtml() proxies through Jina Reader on IP-reputation WAF
 * blocks / connection failures, and Jina always returns HTML — corrupting a
 * JSON response instead of rescuing it. fetchJson() retries transient
 * failures (5xx/429, network blips, and a 200-but-non-JSON "challenge" body)
 * via the same backoff loop WITHOUT that HTML-returning proxy, so a
 * transient block self-heals and a persistent one still fails loudly
 * (#4247: "Unexpected token '<' ... is not valid JSON").
 */
async function fetchJobListingsMeta() {
  return fetchJson(API_URL, { label: 'Bucher + Suter WP REST job-listings' });
}

/* ── Detail-page extraction ──────────────────────────────────────────── */

/**
 * Extract the value following a `<p>Label</p>` marker in the fixed
 * "Location" / "Job Type" info box present on every job detail page.
 * Returns '' when the label is absent.
 */
export function extractLabelValue(html = '', label = '') {
  if (!html || !label) return '';
  const re = new RegExp(`>${label}</p>\\s*<p[^>]*>([^<]*)</p>`, 'i');
  const m = String(html).match(re);
  return m ? normalizeSpace(decodeEntities(m[1])) : '';
}

/**
 * Extract the raw inner HTML of `<div class="article-prose">…</div>` —
 * the job body container shared by both layout variants on the site.
 * Uses balanced-tag scanning (not a naive `[\s\S]*?</div>`) because the
 * container has nested `<div>`s.
 */
export function extractArticleProseHtml(html = '') {
  const located = locateTagByAttribute(html, 'class="article-prose"', { skipVoidTags: true });
  if (!located) return '';
  return extractBalancedTagBlock(located.rest, located.tagName, 30000);
}

/* ── Category detection ──────────────────────────────────────────────── */

export function detectCategory(title = '') {
  const t = String(title || '').toLowerCase();
  if (/salesforce|crm|agentforce/.test(t)) return 'IT / Salesforce';
  if (/linux|system.?admin|infrastructure|devops|network/.test(t)) return 'IT / Infrastruttura';
  if (/\bqa\b|quality|test/.test(t)) return 'IT / Quality Assurance';
  if (/typescript|javascript|developer|software|engineer(?!ing manager)/.test(t)) return 'IT / Sviluppo Software';
  if (/project manager|program manager|scrum|agile/.test(t)) return 'Gestione Progetti';
  if (/operations/.test(t)) return 'Operations';
  return 'IT / Contact Center';
}

/* ── Employment type detection ───────────────────────────────────────── */

export function detectEmploymentType(jobTypeLabel = '') {
  const t = String(jobTypeLabel || '').toLowerCase();
  if (/part.?time/.test(t)) return 'PART_TIME';
  if (/full.?time/.test(t)) return 'FULL_TIME';
  if (/intern|apprentice|trainee/.test(t)) return 'INTERN';
  if (/contract|temporary/.test(t)) return 'CONTRACTOR';
  return 'FULL_TIME';
}

/* ── Experience level detection ──────────────────────────────────────── */

export function detectExperienceLevel(title = '') {
  const t = String(title || '').toLowerCase();
  if (/intern|apprentice|trainee|working student|werkstudent/.test(t)) return 'intern';
  if (/junior|jr\b/.test(t)) return 'junior';
  if (/senior|sr\b|lead|head|director|manager|principal/.test(t)) return 'senior';
  return 'mid';
}

/* ── Job identification ───────────────────────────────────────────────── */

export function isBucherSuterJob(job = {}) {
  if (!job || typeof job !== 'object') return false;
  const key = String(job?.companyKey || '')
    .trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();

  return (
    key === BUCHER_SUTER_KEY
    || company.includes('bucher + suter')
    || company.includes('bucher+suter')
    || company.includes('bucher and suter')
    || url.includes('bucher-suter.com')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'bucher-suter.com' || host === 'www.bucher-suter.com' || host.endsWith('.bucher-suter.com');
  } catch {
    return false;
  }
}

/* ── Fetch all jobs ───────────────────────────────────────────────────── */

/**
 * Fetch all Bucher + Suter jobs.
 * Returns array of ParsedJob objects (source-locale only, English).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step / translate-pending pipeline.
 */
export async function fetchAllBucherSuterJobs() {
  console.log('🔍 Fetching Bucher + Suter AG jobs');
  console.log(`   Source: ${API_URL}\n`);

  const listings = await fetchJobListingsMeta();
  if (!Array.isArray(listings) || listings.length === 0) {
    console.warn('⚠️ No job listings returned from WordPress API.');
    return [];
  }

  console.log(`   📋 WordPress job listings found: ${listings.length}`);
  warnIfListingAtCap({ label: 'Bucher + Suter WP REST listing', count: listings.length, cap: LISTING_PAGE_CAP });

  const jobs = [];
  let skippedNonSwiss = 0;

  for (const listing of listings) {
    const wpId = listing?.id;
    const wpLink = String(listing?.link || '').trim();
    const title = normalizeSpace(decodeEntities(listing?.title?.rendered || ''));
    if (!wpId || !wpLink || !title) continue;
    if (!isTrustedDomain(wpLink)) continue;

    let detailHtml = '';
    try {
      detailHtml = await fetchHtml(wpLink);
    } catch (err) {
      console.warn(`   ⚠️ Detail fetch failed for ${wpLink}: ${err?.message || err}`);
      continue;
    }

    const rawLocation = extractLabelValue(detailHtml, 'Location');
    const jobTypeLabel = extractLabelValue(detailHtml, 'Job Type');

    // Only index real Swiss postings — Bucher + Suter also posts a
    // Germany-remote role. Require BOTH a resolved canton AND a genuine
    // Swiss municipality; never fall back to the raw (possibly foreign)
    // location string.
    const canton = inferSwissTargetCanton(rawLocation) || (/switzerland/i.test(rawLocation) ? HQ.canton : '');
    const cityToken = findSwissCityInText(rawLocation);
    const city = cityToken ? canonicalSwissCityName(cityToken) : (/switzerland/i.test(rawLocation) ? HQ.city : '');
    if (!canton || !city) {
      skippedNonSwiss += 1;
      continue;
    }

    const articleProseHtml = extractArticleProseHtml(detailHtml);
    const description = normalizeDescriptionSpace(htmlToText(articleProseHtml));
    const wordCount = description.split(/\s+/).filter(Boolean).length;
    if (wordCount < 50) continue;

    const postalCode = HQ.postalCode;
    const addressRegion = canton;
    const streetAddress = HQ.city === city ? 'Lindenhofstrasse 1' : city;
    const country = 'CH';

    const postedRaw = listing?.modified || listing?.date || '';
    const postedDate = postedRaw ? String(postedRaw).split('T')[0] : new Date().toISOString().split('T')[0];

    const idHash = createHash('sha1').update(`wp-${wpId}`).digest('hex').slice(0, 12);
    const sourceLang = detectLang(title) === 'de' ? 'de' : 'en';
    const jobSlug = slugify(`${title} bucher-suter ${city}`);
    const employmentType = detectEmploymentType(jobTypeLabel);

    jobs.push({
      // ── Required fields ──
      id: `${BUCHER_SUTER_KEY}-${idHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: BUCHER_SUTER_COMPANY_NAME,
      companyKey: BUCHER_SUTER_KEY,
      companyDomain: BUCHER_SUTER_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: city,
      canton,
      url: wpLink,
      source: 'Bucher + Suter AG Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended / SEO structured-data fields ──
      addressLocality: city,
      addressRegion,
      addressCountry: country,
      country,
      postalCode,
      streetAddress,
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'IT / Contact Center Solutions',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: wpLink,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });

    console.log(`   ✅ ${title.substring(0, 60)} — ${city}`);
  }

  if (skippedNonSwiss > 0) {
    console.log(`   ℹ️ Skipped ${skippedNonSwiss} non-Swiss posting(s) (e.g. Germany remote).`);
  }

  console.log(`\n📋 Total unique Bucher + Suter AG jobs discovered: ${jobs.length}`);
  return jobs;
}
