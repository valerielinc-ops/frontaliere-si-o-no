#!/usr/bin/env node
/**
 * Solothurner Spitäler AG (soH / SOH) — Solothurn cantonal hospital group.
 *
 * Public listing page (DOES NOT require auth):
 *   https://www.solothurnerspitaeler.ch/jobs-karriere/jobangebote
 * Public detail URLs (DOES NOT require auth, but ATS root is auth-gated):
 *   https://jobs.so-h.ch/offene-stellen/{slug}/{uuid}
 *
 * The "jobs.so-h.ch" host is a SaaS-style ATS subdomain that blocks crawler
 * access at the index level (returns HTTP 200 with 0 bytes / 403 on most
 * paths) — likely a Cloudfront WAF or auth-gated career site. However:
 *   - the corporate Typo3 site (www.solothurnerspitaeler.ch/jobs-karriere/
 *     jobangebote) renders ALL active openings server-side with direct links
 *     to the deep-link detail URL for each opening; and
 *   - each /offene-stellen/{slug}/{uuid} detail page IS accessible without
 *     a session and embeds a complete JSON-LD `JobPosting` document with
 *     title, description, qualifications, responsibilities, location,
 *     employment type and datePosted.
 *
 * Strategy:
 *   1. Fetch the public listing on solothurnerspitaeler.ch and extract every
 *      unique `https://jobs.so-h.ch/offene-stellen/{slug}/{uuid}` link.
 *   2. Polite-fetch each detail page (250 ms delay), parse the JSON-LD
 *      script tag, and assemble a ParsedJob.
 *
 * As of May 2026 the listing exposes ~129 unique openings across all soH
 * sites (Solothurn, Olten, Dornach, Breitenbach, Niederbipp, …).
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
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

export const SOH_KEY = 'soh-solothurner-spitaeler';
export const SOH_COMPANY_NAME = 'Solothurner Spitäler AG (soH)';
export const SOH_COMPANY_DOMAIN = 'solothurnerspitaeler.ch';

const LISTING_URL = 'https://www.solothurnerspitaeler.ch/jobs-karriere/jobangebote';
const ATS_HOST = 'jobs.so-h.ch';
const DETAIL_DELAY_MS = 250;

const DEFAULT_CANTON = 'SO';
const DEFAULT_CITY = 'Solothurn';
const DEFAULT_POSTAL = '4500';

const SOURCE_LABEL = 'Solothurner Spitäler Dedicated Parser (Typo3 listing + JSON-LD detail)';

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

export function isSohJob(job) {
  const key = normalize(job?.companyKey || '');
  const url = normalize(job?.url || '');
  return key === SOH_KEY
    || url.includes('jobs.so-h.ch')
    || url.includes('solothurnerspitaeler.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === ATS_HOST
      || host === 'so-h.ch'
      || host === SOH_COMPANY_DOMAIN
      || host.endsWith(`.${SOH_COMPANY_DOMAIN}`)
      || host.endsWith('.so-h.ch');
  } catch {
    return false;
  }
}

/**
 * Extract unique soH detail-page URLs from the public listing HTML.
 * Each card emits ≥2 anchors (title + "Zur Stellenanzeige") for the same
 * URL — we dedupe.
 */
export function parseSohListing(html) {
  const out = [];
  const seen = new Set();
  const linkRe = /href="(https:\/\/jobs\.so-h\.ch\/offene-stellen\/[a-z0-9\-]+\/[a-f0-9\-]{8,})"/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const url = m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * Parse a soH detail page. The page embeds a `<script type="application/ld+json">`
 * containing a `JobPosting` document. We strip JSON-escape artifacts and
 * extract the fields we need.
 */
export function parseSohDetail(html) {
  if (!html || typeof html !== 'string') return null;
  // Find all JSON-LD blocks — the page may have multiple (WebSite + JobPosting).
  const blocks = [];
  const rx = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = rx.exec(html))) blocks.push(m[1].trim());
  let jp = null;
  for (const raw of blocks) {
    try {
      const obj = JSON.parse(raw);
      // Could be an array or a single object
      const candidates = Array.isArray(obj) ? obj : [obj];
      for (const c of candidates) {
        const type = c?.['@type'];
        if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) {
          jp = c;
          break;
        }
      }
      if (jp) break;
    } catch {
      // skip malformed block
    }
  }
  if (!jp) return null;

  const title = String(jp.title || '').trim();
  const descriptionHtml = String(jp.description || '');
  // Concatenate description with responsibilities + qualifications for
  // a richer body.
  const richParts = [
    descriptionHtml,
    jp.responsibilities ? String(jp.responsibilities) : '',
    jp.qualifications ? String(jp.qualifications) : '',
  ].filter(Boolean);
  const richHtml = richParts.join('\n\n');
  const descriptionText = htmlToText(richHtml);

  const loc = jp.jobLocation && jp.jobLocation.address ? jp.jobLocation.address : {};
  const city = String(loc.addressLocality || '').trim();
  const region = String(loc.addressRegion || '').trim();
  const postalCode = String(loc.postalCode || '').trim();
  const country = String(loc.addressCountry || '').trim();

  const employmentTypeRaw = String(jp.employmentType || '').toUpperCase();
  const validThrough = jp.validThrough ? String(jp.validThrough) : '';
  const postedRaw = jp.datePosted ? String(jp.datePosted) : '';
  const postedDate = (() => {
    if (!postedRaw) return '';
    const d = new Date(postedRaw);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  })();

  return {
    title,
    descriptionHtml: richHtml,
    descriptionText,
    city,
    region,
    postalCode,
    country,
    employmentTypeRaw,
    postedDate,
    validThrough,
    industry: jp.industry ? String(jp.industry) : '',
  };
}

export async function fetchAllSohJobs() {
  console.log(`🏥 Fetching ${SOH_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL} (Typo3) + ${ATS_HOST}/offene-stellen (JSON-LD)\n`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(LISTING_URL);
  } catch (err) {
    console.warn(`⚠️ Listing fetch failed: ${err?.message || err}`);
    return [];
  }

  const urls = parseSohListing(listingHtml);
  console.log(`  ✓ ${urls.length} unique offerings discovered`);
  if (!urls.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let failed = 0;
  for (let i = 0; i < urls.length; i += 1) {
    const fullUrl = urls[i];
    let detail = null;
    try {
      const html = await fetchHtml(fullUrl);
      detail = parseSohDetail(html);
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${fullUrl}: ${err?.message || err}`);
    }
    if (!detail || !detail.title) {
      failed += 1;
      if (i < urls.length - 1) {
        await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
      }
      continue;
    }

    const title = detail.title;
    const city = detail.city || DEFAULT_CITY;
    const cantonInferred = inferSwissTargetCanton(`${city} ${detail.region || ''}`) || DEFAULT_CANTON;
    const postalCode = detail.postalCode || DEFAULT_POSTAL;
    const sourceLang = detectLang(detail.descriptionText || title, 'de');

    let description = detail.descriptionText || '';
    const uniqueWords = new Set(
      description.toLowerCase().replace(/[^a-zà-ÿäöüß\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2),
    );
    if (uniqueWords.size < 30) {
      description = `${title} bei ${SOH_COMPANY_NAME} in ${city}.\n\nDie Solothurner Spitäler AG (soH) ist die Spitalgruppe des Kantons Solothurn mit den Standorten Bürgerspital Solothurn, Kantonsspital Olten, Spital Dornach und weiteren Aussenstandorten. Über 4'500 Mitarbeitende betreuen jährlich rund 35'000 stationäre Patientinnen und Patienten.`;
    }

    const postedDate = detail.postedDate || todayIso;
    const urlHash = createHash('sha1').update(fullUrl).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${title} ${SOH_KEY} ${city}`);

    // Map SF-style employmentType to our internal enum
    let employmentType = 'OTHER';
    if (/FULL_TIME/.test(detail.employmentTypeRaw)) employmentType = 'FULL_TIME';
    else if (/PART_TIME/.test(detail.employmentTypeRaw)) employmentType = 'PART_TIME';
    else if (/INTERN|TRAINEE|APPRENT/.test(detail.employmentTypeRaw)) employmentType = 'OTHER';
    if (employmentType === 'OTHER') {
      employmentType = detectHealthcareEmploymentType(title);
    }

    jobs.push({
      id: `${SOH_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SOH_COMPANY_NAME,
      companyKey: SOH_KEY,
      companyDomain: SOH_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: city,
      canton: cantonInferred,
      url: fullUrl,
      source: SOURCE_LABEL,
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: city,
      addressRegion: cantonInferred,
      addressCountry: 'CH',
      country: 'CH',
      postalCode,
      category: detectHealthcareCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: detail.industry && /gesundheit/i.test(detail.industry) ? 'Sanità / Ospedali' : 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: fullUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });

    if (i < urls.length - 1) {
      await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
    }
  }

  console.log(`📋 Total ${SOH_COMPANY_NAME} jobs discovered: ${jobs.length} (${failed} detail failures)`);
  return jobs;
}

export const fetchAllSohSolothurnerSpitaelerJobs = fetchAllSohJobs;
export const isSohSolothurnerSpitaelerJob = isSohJob;
