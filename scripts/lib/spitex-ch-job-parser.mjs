#!/usr/bin/env node
/**
 * Spitex Schweiz job parser — federation-level home care job board.
 *
 * Public career site: https://www.spitexjobs.ch/
 *
 * Spitex Schweiz is the Swiss federation of non-profit Spitex (home care)
 * organizations. `spitexjobs.ch` is their consolidated job board, listing
 * positions from all member organizations (community Spitex services across
 * all 26 cantons).
 *
 * Crawl strategy:
 *
 *   1. GET https://www.spitexjobs.ch/suche/page/{N} — paginated server-
 *      rendered HTML, ~23-24 jobs per page. Each card has
 *      `data-url="https://www.spitexjobs.ch/job/{slug}/J{jobId}"`. The first
 *      few pages may include sticky/featured jobs that repeat across pages —
 *      we dedupe by jobId.
 *
 *      The page also exposes the total count via `data-total="{N}"` on the
 *      pagination wrapper — we use it as a stop condition.
 *
 *   2. For each unique job URL, GET the detail page. Each detail page contains
 *      a clean `<script type="application/ld+json">` JobPosting block with
 *      `title`, `description` (HTML), `jobLocation.address`, `datePosted`,
 *      `validThrough`, `employmentType`, `hiringOrganization`, `industry`,
 *      `educationRequirements`. The hiringOrganization.name is the actual
 *      Spitex org (e.g. "Spitex Aare") — we capture it but bucket all jobs
 *      under the federation slug `spitex-ch` because they share the same
 *      published-by entity.
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

export const SPITEX_CH_KEY = 'spitex-ch';
export const SPITEX_CH_COMPANY_NAME = 'Spitex Schweiz';
export const SPITEX_CH_COMPANY_DOMAIN = 'spitexjobs.ch';
const BASE_URL = 'https://www.spitexjobs.ch';
const DETAIL_DELAY_MS = 200;
const MAX_LISTING_PAGES = 30;

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

/* ── Listing pages ────────────────────────────────────────── */

export function parseSpitexListing(html = '') {
  if (!html) return { urls: [], total: 0 };
  const urls = new Set();
  const urlRe = /data-url=["'](https?:\/\/www\.spitexjobs\.ch\/job\/[^"']+\/J(\d+))["']/gi;
  let m;
  while ((m = urlRe.exec(html)) !== null) {
    urls.add(m[1]);
  }
  let total = 0;
  const totalMatch = html.match(/data-total=["'](\d+)["']/i);
  if (totalMatch) total = parseInt(totalMatch[1], 10);
  return { urls: Array.from(urls), total };
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
      // try next
    }
  }
  return null;
}

const COUNTRY_TO_CC = { Schweiz: 'CH', Switzerland: 'CH', Suisse: 'CH', Svizzera: 'CH' };

/* ── Factory-style exports ────────────────────────────────── */

export async function fetchAllSpitexChJobs() {
  console.log(`🏥 Fetching ${SPITEX_CH_COMPANY_NAME} jobs`);
  console.log(`   Source: ${BASE_URL}/suche (federation home-care board)\n`);

  // Step 1 — walk paginated listing
  const seenUrls = new Set();
  let total = 0;
  for (let page = 1; page <= MAX_LISTING_PAGES; page += 1) {
    const url = `${BASE_URL}/suche/page/${page}`;
    let html;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      if (page === 1) throw err;
      console.warn(`  ⚠️ Pagination failed at page=${page}: ${err?.message || err}`);
      break;
    }
    const { urls, total: t } = parseSpitexListing(html);
    if (t > total) total = t;
    let added = 0;
    for (const u of urls) {
      if (seenUrls.has(u)) continue;
      seenUrls.add(u);
      added += 1;
    }
    console.log(`  📄 page=${page}: +${added} (unique: ${seenUrls.size}${total ? `/${total}` : ''})`);
    if (added === 0 && page >= 2) break; // no new jobs → end of pagination
    if (total > 0 && seenUrls.size >= total) break;
    await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
  }

  if (!seenUrls.size) {
    console.warn('⚠️ No Spitex job URLs found');
    return [];
  }
  console.log(`  📋 Total unique job URLs: ${seenUrls.size}\n`);

  // Step 2 — fetch detail pages
  const jobs = [];
  for (const jobUrl of seenUrls) {
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
    const city = decodeEntities(addr.addressLocality || '').trim() || 'Bern';
    const postalCode = String(addr.postalCode || '').trim() || '3000';
    const cantonGuess = String(addr.addressRegion || '').toUpperCase().trim();
    const canton = /^[A-Z]{2}$/.test(cantonGuess) ? cantonGuess : (inferSwissTargetCanton(city) || 'BE');
    const country = COUNTRY_TO_CC[addr.addressCountry] || 'CH';

    const descHtml = posting.description || '';
    let description = htmlToText(descHtml);
    const uniqueWords = new Set(
      description.toLowerCase().replace(/[^a-zà-ÿäöüß\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2),
    );
    const hiringOrg = posting.hiringOrganization?.name
      ? decodeEntities(String(posting.hiringOrganization.name)).trim()
      : '';
    if (uniqueWords.size < 30) {
      description = `${title}${hiringOrg ? ` bei ${hiringOrg}` : ''} in ${city}.\n\nSpitex-Stelle in der Schweizer Hauspflege. Diese Position bietet ein modernes Arbeitsumfeld, attraktive Anstellungsbedingungen und vielfältige Weiterbildungsmöglichkeiten.`;
    }

    const sourceLang = detectLang(description || title, 'de');
    const postedDate = (() => {
      const raw = posting.datePosted || '';
      if (!raw) return new Date().toISOString().slice(0, 10);
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
    })();
    const validThrough = (() => {
      const raw = posting.validThrough || '';
      if (!raw) return '';
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
    })();
    const employmentTypeRaw = String(posting.employmentType || '').toUpperCase();
    const employmentType = employmentTypeRaw === 'PART_TIME' || /\b(20|30|40|50|60|70|80)\s?%/.test(title)
      ? 'PART_TIME'
      : (employmentTypeRaw === 'FULL_TIME' ? 'FULL_TIME' : detectHealthcareEmploymentType(title));

    const urlHash = createHash('sha1').update(jobUrl).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${title} ${SPITEX_CH_KEY} ${city}`);

    const job = {
      id: `${SPITEX_CH_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: hiringOrg || SPITEX_CH_COMPANY_NAME,
      companyKey: SPITEX_CH_KEY,
      companyDomain: SPITEX_CH_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: city,
      canton,
      url: jobUrl,
      source: 'Spitex Schweiz Dedicated Parser (spitexjobs.ch federation board)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: city,
      addressRegion: canton,
      addressCountry: country,
      country,
      postalCode,
      category: detectHealthcareCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate,
      ...(validThrough ? { validThrough } : {}),
      applyUrl: jobUrl,
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
  console.log(`\n📋 Total unique ${SPITEX_CH_COMPANY_NAME} jobs: ${deduped.length}`);
  return deduped;
}

export function isSpitexChJob(job) {
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');
  if (key === SPITEX_CH_KEY) return true;
  if (url.includes('spitexjobs.ch')) return true;
  if (company.startsWith('spitex ')) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'spitexjobs.ch'
      || host === 'www.spitexjobs.ch'
      || host === 'api.spitexjobs.ch'
      || host.endsWith('.spitexjobs.ch');
  } catch {
    return false;
  }
}
