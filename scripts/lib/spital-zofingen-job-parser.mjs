#!/usr/bin/env node
/**
 * Spital Zofingen AG job parser — jobs.spitalzofingen.ch board.
 *
 * Live source: https://jobs.spitalzofingen.ch/  (Swiss Medical Network career
 *   board, server-rendered). Listing cards link to
 *   https://jobs.spitalzofingen.ch/offene-stellen/{slug}/{uuid} detail pages,
 *   each carrying a clean schema.org/JobPosting JSON-LD block (title,
 *   description, jobLocation w/ postalCode + streetAddress, employmentType,
 *   datePosted).
 *
 * Migrated off Umantis: the old tenant 22707 `/Vacancies/{id}/Description` page
 * now 302-redirects to swissmedical.net (issue #1245); this board is the live
 * source of truth. Crawl it directly via its JSON-LD detail pages.
 *
 * Regional hospital in Zofingen, canton Aargau.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
} from './hospital-custom-html-helpers.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { extractJobPostingLd, jobPostingDescriptionText, jobPostingAddress } from './jsonld-jobposting.mjs';

export const SPITAL_ZOFINGEN_KEY = 'spital-zofingen';
export const SPITAL_ZOFINGEN_COMPANY_NAME = 'Spital Zofingen';
export const SPITAL_ZOFINGEN_COMPANY_DOMAIN = 'spitalzofingen.ch';

const LISTING_URL = 'https://jobs.spitalzofingen.ch/';
const BOARD_HOST = 'jobs.spitalzofingen.ch';
const DEFAULT_CANTON = 'AG';
const DEFAULT_CITY = 'Zofingen';
const DEFAULT_POSTAL = '4800';
const POLITE_DELAY_MS = 200;

const REGION_TO_CANTON = {
  aargau: 'AG', luzern: 'LU', bern: 'BE', solothurn: 'SO', zürich: 'ZH', zurich: 'ZH',
};

export function isSpitalZofingenJob(job) {
  const key = String(job?.companyKey || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return key === SPITAL_ZOFINGEN_KEY
    || url.includes('spitalzofingen.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === BOARD_HOST || host === 'spitalzofingen.ch' || host.endsWith('.spitalzofingen.ch');
  } catch {
    return false;
  }
}

/** Extract unique detail URLs from the listing HTML. */
export function parseSpitalZofingenListing(html) {
  const seen = new Set();
  const out = [];
  // Accept BOTH absolute (`https://jobs.spitalzofingen.ch/offene-stellen/…`) and
  // root-relative (`/offene-stellen/…`) hrefs: the Swiss Medical Network board
  // can switch between the two across template updates, and pinning to
  // absolute-only would silently drop all jobs on such a switch. The trailing
  // detail segment is a 36-char UUID today, but we accept any single non-empty
  // slug-like segment so a non-UUID detail path still resolves — the
  // `/offene-stellen/{slug}/{segment}` two-segment shape keeps it from matching
  // the listing index itself. Relative hits are normalized to absolute below.
  const rx = /href="((?:https?:\/\/jobs\.spitalzofingen\.ch)?\/offene-stellen\/[^"/]+\/[^"/]+\/?)"/gi;
  let m;
  while ((m = rx.exec(html))) {
    const raw = m[1];
    const url = raw.startsWith('http') ? raw : `https://${BOARD_HOST}${raw}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

export async function fetchAllSpitalZofingenJobs() {
  console.log(`🏥 Fetching ${SPITAL_ZOFINGEN_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL} (Swiss Medical Network board)\n`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(LISTING_URL);
  } catch (err) {
    console.warn(`⚠️ Spital Zofingen listing fetch failed: ${err?.message || err}`);
    return [];
  }
  const detailUrls = parseSpitalZofingenListing(listingHtml);
  console.log(`  ✓ ${detailUrls.length} jobs from board listing`);
  if (!detailUrls.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const url of detailUrls) {
    let ld;
    try {
      const detailHtml = await fetchHtml(url);
      ld = extractJobPostingLd(detailHtml);
    } catch (err) {
      console.warn(`  ⚠️ detail fetch failed: ${err?.message || err}`);
    }
    await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));
    if (!ld || !ld.title) continue;

    const title = String(ld.title).replace(/\s+/g, ' ').trim();
    const description = jobPostingDescriptionText(ld.description || '');
    if (!description || description.split(/\s+/).length < 20) continue;

    const addr = jobPostingAddress(ld);
    const location = addr.addressLocality || DEFAULT_CITY;
    const canton = REGION_TO_CANTON[addr.addressRegion.toLowerCase()]
      || inferSwissTargetCanton(location) || DEFAULT_CANTON;
    const postalCode = addr.postalCode || DEFAULT_POSTAL;
    const employmentType = /PART_TIME/i.test(ld.employmentType) ? 'PART_TIME'
      : /FULL_TIME/i.test(ld.employmentType) ? 'FULL_TIME' : 'OTHER';
    const postedDate = /^\d{4}-\d{2}-\d{2}/.test(String(ld.datePosted || ''))
      ? String(ld.datePosted).slice(0, 10) : todayIso;

    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${SPITAL_ZOFINGEN_KEY} ${location}`);
    const urlHash = createHash('sha1').update(url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${SPITAL_ZOFINGEN_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SPITAL_ZOFINGEN_COMPANY_NAME,
      companyKey: SPITAL_ZOFINGEN_KEY,
      companyDomain: SPITAL_ZOFINGEN_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location,
      canton,
      url,
      source: 'Spital Zofingen Dedicated Parser (jobs.spitalzofingen.ch JSON-LD)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode,
      streetAddress: addr.streetAddress || '',
      category: detectHealthcareCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`\n📋 Total ${SPITAL_ZOFINGEN_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
