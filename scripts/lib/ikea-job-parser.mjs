#!/usr/bin/env node
/**
 * IKEA job parser — Fetcher and job builder.
 *
 * Source: https://jobs.ikea.com/en/location/switzerland-jobs/22908/2658434/2
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllIkeaJobs()  — Fetch and parse all jobs
 *   - isIkeaJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import {
  resolveDetailOrListingSwissGeography,
  schemaJobLocationCandidates,
} from './prospector/location-evidence.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const IKEA_KEY = 'ikea';
export const IKEA_COMPANY_NAME = 'IKEA';
export const IKEA_COMPANY_DOMAIN = 'ikea.ch';

// IKEA Switzerland runs a self-hosted TalentBrew/Radancy career portal on
// jobs.ikea.com. The CH listing is path-scoped to the Switzerland geo facet
// (place id 2658434, level 2 = country); pagination is path-style (/{page}).
// The unscoped /en root and AJAX results endpoints return the global ~1168-job
// set and ignore the geo facet, so we MUST crawl the path-paginated landing.
const ATS_HOST = 'jobs.ikea.com';
const ATS_ORIGIN = 'https://jobs.ikea.com';
const CAREER_URL = 'https://jobs.ikea.com/en/location/switzerland-jobs/22908/2658434/2';

const HQ_CITY = 'Spreitenbach';
const HQ_POSTAL = '8957';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to IKEA.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isIkeaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === IKEA_KEY ||
    key.startsWith('ikea') ||
    company.includes('ikea') ||
    url.includes('ikea.ch')
  );
}

/**
 * Validate that a URL belongs to IKEA's domain or its real ATS host.
 * The public listing + indexed job-detail pages live on jobs.ikea.com
 * (Radancy/TalentBrew portal); apply links go to ikea.avature.net.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'ikea.ch' ||
      host.endsWith('.ikea.ch') ||
      host === 'jobs.ikea.com' ||
      host === 'ikea.avature.net' ||
      host.endsWith('.avature.net')
    );
  } catch {
    return false;
  }
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

/* ── Fetch + Parse ─────────────────────────────────────────── */

const FETCH_OPTS = { headers: { 'User-Agent': UA, 'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8' } };

function decodeEntities(s = '') {
  return String(s || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;|&#xA0;|&#x202F;/g, ' ');
}

/** Parse the rendered listing HTML into raw row objects. */
function parseListingRows(html) {
  const rows = [];
  // Each job row is a <a ... data-job-id="N" class="job-list__anchor"> followed
  // (in document order) by span.job-list__title and span.job-list__location.
  const re =
    /<a href="(\/en\/job\/[^"]+)" data-job-id="(\d+)" class="job-list__anchor">([\s\S]*?)(?=<a href="\/en\/job\/|<\/(?:ul|section)\b)/g;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const jobReqId = m[2];
    const body = m[3] || '';
    const titleM = body.match(/job-list__title">\s*([^<]*)/);
    const locM = body.match(/job-list__location">\s*([^<]*)/);
    const title = normalizeSpace(decodeEntities(titleM ? titleM[1] : ''));
    const location = normalizeSpace(decodeEntities(locM ? locM[1] : ''));
    if (!title) continue;
    rows.push({ title, location, url: ATS_ORIGIN + href, jobReqId });
  }
  return rows;
}

/** Pull the JSON-LD JobPosting (if any) from a detail page. */
function parseJobPosting(html) {
  const blocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
  for (const block of blocks) {
    const raw = block.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '').trim();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    const candidates = Array.isArray(data) ? data : [data];
    for (const c of candidates) {
      if (c && c['@type'] === 'JobPosting') return c;
    }
  }
  return null;
}

/** Normalize the JSON-LD datePosted (e.g. "2026-6-10") to ISO YYYY-MM-DD. */
function normalizeDate(value) {
  if (!value) return null;
  const m = String(value).match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Crawl all path-paginated CH landing pages and enrich each row from its
 * job-detail JSON-LD (description, datePosted, employmentType, postal code).
 */
async function fetchJobListings() {
  console.log(`   Fetching from: ${CAREER_URL}`);

  const firstHtml = await fetchHtml(CAREER_URL, FETCH_OPTS);
  const totalPagesM = firstHtml.match(/data-total-pages="(\d+)"/);
  const MAX_PAGES = 20;
  const reportedTotalPages = totalPagesM ? Number(totalPagesM[1]) : 1;
  const totalPages = Math.min(reportedTotalPages, MAX_PAGES);
  // Surface the safety-ceiling so a silent cap ≠ a fully drained feed.
  if (reportedTotalPages > MAX_PAGES) {
    console.warn(`   ⚠️ Pagination capped at ${MAX_PAGES}/${reportedTotalPages} pages (MAX_PAGES=${MAX_PAGES} ceiling) — raise the cap if the IKEA CH listing has grown.`);
  }

  const seen = new Set();
  const rows = [];
  const pushRows = (parsed) => {
    for (const r of parsed) {
      if (seen.has(r.jobReqId)) continue;
      seen.add(r.jobReqId);
      rows.push(r);
    }
  };

  pushRows(parseListingRows(firstHtml));

  for (let page = 2; page <= totalPages; page++) {
    const pageUrl = `${CAREER_URL}/${page}`;
    try {
      const html = await fetchHtml(pageUrl, FETCH_OPTS);
      pushRows(parseListingRows(html));
    } catch (err) {
      console.warn(`   ⚠️ page ${page} failed: ${err?.message || err}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log(`  🗂  Listing rows (CH, deduped): ${rows.length}`);

  // Enrich from detail JSON-LD (description, datePosted, postalCode, employment).
  for (const row of rows) {
    try {
      const detailHtml = await fetchHtml(row.url, FETCH_OPTS);
      const posting = parseJobPosting(detailHtml);
      if (posting) {
        row.description = posting.description || '';
        row.postedAt = normalizeDate(posting.datePosted);
        row.employmentTypeRaw = posting.employmentType || '';
        row.locationCandidates = schemaJobLocationCandidates(posting.jobLocation);
      }
    } catch (err) {
      console.warn(`   ⚠️ detail fetch failed (${row.jobReqId}): ${err?.message || err}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return rows;
}

/** Map IKEA's free-text employmentType to the schema.org enum. */
function mapEmploymentType(raw = '', title = '') {
  const t = normalize(raw);
  if (/part.?time|teilzeit|temps partiel|tempo parziale/.test(t)) return 'PART_TIME';
  if (/full.?time|vollzeit|temps plein|tempo pieno/.test(t)) return 'FULL_TIME';
  if (/\b(intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|trainee)/.test(t)) return 'INTERN';
  if (/temporary|befristet|temporär/.test(t)) return 'TEMPORARY';
  // Fall back to the title's workload percent hint (IKEA titles end in e.g.
  // "... 50%" / "... 100%"): <100% → part-time, 100% → full-time.
  const pct = String(title).match(/(\d{2,3})\s*%/);
  if (pct) return Number(pct[1]) >= 100 ? 'FULL_TIME' : 'PART_TIME';
  return detectEmploymentType(title);
}

/**
 * Validate a source-feed `addressRegion` against the independently-inferred
 * canton. IKEA's own JSON-LD feed provides `addressRegion` as unvalidated
 * source data — trust it only when it's a real 2-letter Swiss canton code
 * that AGREES with `canton` (derived from the listing-page location text); a
 * disagreeing/malformed value must never silently override the safer,
 * location-derived canton (same bug class fixed centrally in
 * jobPostingSchema.ts's resolveAddress()).
 */
export function resolveIkeaAddressRegion(feedAddressRegion, canton) {
  const feedRegion = String(feedAddressRegion || '').toUpperCase().trim();
  const cantonCode = String(canton || '').toUpperCase().trim();
  return /^[A-Z]{2}$/.test(feedRegion) && feedRegion === cantonCode ? feedRegion : '';
}

export function resolveIkeaListingGeography(listing = {}) {
  return resolveDetailOrListingSwissGeography(
    { locationCandidates: listing.locationCandidates || [] },
    { location: listing.location || '' },
  );
}

/**
 * Fetch all IKEA jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllIkeaJobs() {
  console.log(`🔍 Fetching IKEA jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const decision = resolveIkeaListingGeography(listing);
    const geography = decision.geography;
    if (!geography) continue;
    const { location, canton } = geography;
    const evidence = decision.candidate;
    const addressLocality = evidence.addressLocality || location.split(',')[0].trim();
    const addressRegion = resolveIkeaAddressRegion(evidence.addressRegion, canton);
    // IKEA sometimes places its 4-digit Swiss postal code in streetAddress.
    const postalCandidate = String(evidence.postalCode || evidence.streetAddress || '').trim();
    const postalCode = (/^\d{4}$/.test(postalCandidate) ? postalCandidate : '')
      || (addressLocality === HQ_CITY ? HQ_POSTAL : '');
    const descriptionText = stripHtml(listing.description || '');
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} ikea ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `ikea-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: IKEA_COMPANY_NAME,
      companyKey: IKEA_KEY,
      companyDomain: IKEA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — ${IKEA_COMPANY_NAME}`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — ${IKEA_COMPANY_NAME}` },
      location,
      canton,
      url: publicUrl,
      source: 'IKEA Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality,
      postalCode,
      addressRegion: addressRegion || canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: mapEmploymentType(listing.employmentTypeRaw, title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Retail / Furniture',
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedAt || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total IKEA jobs discovered: ${jobs.length}`);
  return jobs;
}
