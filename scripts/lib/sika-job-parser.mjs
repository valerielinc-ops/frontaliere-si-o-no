#!/usr/bin/env node
/**
 * Sika job parser — Fetcher and job builder.
 *
 * Source: https://www.sika.com/en/career/jobs.html
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSikaJobs()  — Fetch and parse all jobs
 *   - isSikaJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { sourcePostingDateFields } from './source-posting-date.mjs';
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchJson, fetchHtml, normalizeDescriptionSpace } from './crawler-template.mjs';
import { decodeEntities } from './prospector/entities.mjs';
import {
  resolveDetailOrListingSwissGeography,
  schemaJobLocationCandidates,
} from './prospector/location-evidence.mjs';
import { assertJsonListShape } from './assert-json-list-shape.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SIKA_KEY = 'sika';
export const SIKA_COMPANY_NAME = 'Sika';
export const SIKA_COMPANY_DOMAIN = 'sika.com';

const CAREER_URL = 'https://www.sika.com/en/career/jobs.html';

// AEM (Adobe Experience Manager) custom JSON listing endpoint. Server hard-caps
// items at 10/page; page via `offset` += 10 until response `nextOffset` is null.
// `country=ch` is the ISO-3166 alpha-2 CH dropdown filter (totalItems = CH count).
const LISTING_BASE =
  'https://www.sika.com/en/career/jobs/_jcr_content/content/layoutcontainer_1337473725/first/jobposting.listing.json';
const LISTING_PARAMS = 'country=ch';
const PAGE_STEP = 10;
const MAX_OFFSET = 1000; // hard safety cap on pagination

const SECTOR = 'Specialty chemicals (construction & industrial)';

// Known HQ postal metadata (Sika AG, Zugerstrasse 50, CH-6341 Baar, ZG).
const HQ = { city: 'Baar', canton: 'ZG', postalCode: '6341', addressRegion: 'Canton of Zug' };

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Sika.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isSikaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SIKA_KEY ||
    key.startsWith('sika') ||
    company.includes('sika') ||
    url.includes('sika.com')
  );
}

/**
 * Validate that a URL belongs to Sika's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'sika.com' || host.endsWith('.sika.com');
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

/**
 * Fetch the CH-filtered job listing from Sika's AEM JSON endpoint.
 * Pages by `offset` += 10 (server hard-caps items at 10/page, ignore `limit`)
 * until `nextOffset` is null. Returns raw listing objects:
 *   { title, location, url, description, jobReqId }
 */
async function fetchJobListings() {
  const headers = { 'User-Agent': UA };
  const listings = [];
  const seen = new Set();

  let offset = 0;
  while (offset <= MAX_OFFSET) {
    const url = `${LISTING_BASE}?${LISTING_PARAMS}&offset=${offset}`;
    let data;
    try {
      data = await fetchJson(url, { headers });
    } catch (err) {
      console.warn(`   ⚠️ Listing fetch failed at offset=${offset}: ${err?.message || err}`);
      // A fetch failure is not the end of the listing: let the crawler pipeline
      // classify it (connection-level soft exit or HTTP error) instead of
      // publishing a partial or cause-less empty result.
      throw err;
    }

    const items = assertJsonListShape(data, { key: 'items', source: 'sika' });
    for (const item of items) {
      const jobUrl = item?.url || '';
      if (!jobUrl || seen.has(jobUrl) || !isTrustedDomain(jobUrl)) continue;
      seen.add(jobUrl);
      listings.push({
        title: item.title || '',
        location: item.location || '',
        url: jobUrl,
        description: item.description || '',
        jobReqId: item.id || '',
        tags: Array.isArray(item.tags) ? item.tags : [],
      });
    }

    const next = data?.nextOffset;
    if (next == null || items.length === 0) break;
    offset = Number(next);
    if (!Number.isFinite(offset) || offset <= 0) break;
  }

  return listings;
}

/**
 * Read the vacancy body rendered by the AEM `cmp-job-posting-details`
 * component: "Über die Rolle" (description), "Ihre Fähigkeiten und
 * Erfahrungen" (qualifications), "Warum Sie zu uns kommen sollten"
 * (additional-information, i.e. benefits) and "Über Sika" (company). The
 * listing JSON and the JSON-LD only carry the first block, so the published
 * rows lost profile, benefits and company paragraph (source-detail audit
 * 2026-09-29: 393 of 952 chars published) and `<li>` came through as prose.
 *
 * Each heading is kept on its own line above its section; a heading followed
 * by an empty section (the component renders an empty
 * `additional-information` div before the filled one) attaches to the next
 * non-empty section. Returns '' when the component is absent.
 *
 * @param {string} html
 * @returns {string}
 */
export function parseSikaJobPostingDetails(html = '') {
  const src = String(html || '');
  const start = src.search(/<div class="cmp-job-posting-details">/);
  if (start < 0) return '';
  const tokenPattern = /<(h[23]) class="cmp-job-posting-details__title[^"]*">([\s\S]*?)<\/\1>|<div class="cmp-job-posting-details__(?:description|qualifications|additional-information|company-description)">/g;
  tokenPattern.lastIndex = start;
  const componentEnd = balancedDivEnd(src, src.indexOf('>', start) + 1);
  const parts = [];
  let pendingHeading = '';
  let token;
  while ((token = tokenPattern.exec(src)) !== null && token.index < componentEnd) {
    if (token[1]) {
      pendingHeading = normalizeSpace(decodeEntities(stripHtml(token[2])));
      continue;
    }
    const contentEnd = balancedDivEnd(src, tokenPattern.lastIndex);
    const text = normalizeDescriptionSpace(
      decodeEntities(stripHtml(src.slice(tokenPattern.lastIndex, contentEnd))).replace(/\u00a0/g, ' '),
    );
    tokenPattern.lastIndex = contentEnd;
    if (!text) continue;
    parts.push(pendingHeading ? `${pendingHeading}\n${text}` : text);
    pendingHeading = '';
  }
  return parts.join('\n\n').trim();
}

/** Index of the `</div>` closing a div whose opening tag ends at `from`. */
function balancedDivEnd(src, from) {
  const tagPattern = /<\/?div\b[^>]*>/gi;
  tagPattern.lastIndex = from;
  let depth = 1;
  let tag;
  while ((tag = tagPattern.exec(src)) !== null) {
    if (tag[0][1] === '/') depth -= 1;
    else if (!tag[0].endsWith('/>')) depth += 1;
    if (depth === 0) return tag.index;
  }
  return src.length;
}

/**
 * Fetch a job-detail page and extract the schema.org JobPosting JSON-LD.
 * Returns { datePosted, employmentType, addressLocality, postalCode,
 * streetAddress, addressRegion } or {} on any failure (safe defaults applied
 * in the assembly loop — never drop the structured-data check per Non-Neg #3).
 */
async function fetchJobDetail(url) {
  try {
    const html = await fetchHtml(url, { headers: { 'User-Agent': UA } });
    const bodyText = parseSikaJobPostingDetails(html);
    const blocks = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const block of blocks) {
      const json = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
      let parsed;
      try {
        parsed = JSON.parse(json);
      } catch {
        continue;
      }
      const node = Array.isArray(parsed) ? parsed.find((n) => n?.['@type'] === 'JobPosting') : parsed;
      if (!node || node['@type'] !== 'JobPosting') continue;
      const locationCandidates = schemaJobLocationCandidates(node.jobLocation);
      const primaryLocation = locationCandidates[0];
      return {
        bodyText,
        datePosted: node.datePosted || '',
        employmentType: node.employmentType || '',
        addressLocality: primaryLocation?.addressLocality || '',
        addressCountry: primaryLocation?.addressCountry || '',
        postalCode: primaryLocation?.postalCode || '',
        streetAddress: primaryLocation?.streetAddress || '',
        addressRegion: primaryLocation?.addressRegion || '',
        locationCandidates,
      };
    }
    if (bodyText) return { bodyText };
  } catch (err) {
    console.warn(`   ⚠️ Detail fetch failed for ${url}: ${err?.message || err}`);
  }
  return {};
}

export function resolveSikaListingGeography(listing = {}, detail = {}) {
  return resolveDetailOrListingSwissGeography(
    {
      locationCandidates: detail.locationCandidates || [],
      location: [detail.addressLocality, detail.addressRegion].filter(Boolean).join(', '),
      addressCountry: detail.addressCountry || '',
    },
    { location: listing.location || '' },
  );
}

/**
 * Fetch all Sika jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllSikaJobs() {
  console.log(`🔍 Fetching Sika jobs`);
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

    const descriptionHtml = listing.description || '';
    const publicUrl = listing.url || CAREER_URL;

    // Enrich from the detail page: full vacancy body + JSON-LD (datePosted,
    // employmentType, address). The listing snippet is only the fallback when
    // the detail component cannot be read.
    const detail = await fetchJobDetail(publicUrl);
    const descriptionText = detail.bodyText
      || normalizeDescriptionSpace(decodeEntities(stripHtml(descriptionHtml)));
    const decision = resolveSikaListingGeography(listing, detail);
    const geography = decision.geography;
    if (!geography) continue;
    const { location, canton } = geography;
    const evidence = decision.candidate;

    // Resolve address fields from the detail JSON-LD or listing string only.
    const localityFromListing = location.split(',')[0]?.trim() || '';
    const addressLocality = evidence.addressLocality || localityFromListing;
    const addressRegion = canton;
    const postalCode = evidence.postalCode || (addressLocality === HQ.city ? HQ.postalCode : '');
    const streetAddress = evidence.streetAddress || '';

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} sika ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const employmentType = detail.employmentType
      ? detectEmploymentType(detail.employmentType)
      : detectEmploymentType((listing.tags || []).join(' ') || title);
    const publication = sourcePostingDateFields(detail.datePosted);

    const job = {
      // ── Required fields ──
      id: `sika-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SIKA_COMPANY_NAME,
      companyKey: SIKA_KEY,
      companyDomain: SIKA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Sika`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Sika` },
      location,
      canton,
      url: publicUrl,
      source: 'Sika Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality,
      postalCode,
      streetAddress,
      addressRegion,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      ...publication,
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 200)); // Rate limiting
  }

  console.log(`\n📋 Total Sika jobs discovered: ${jobs.length}`);
  return jobs;
}
