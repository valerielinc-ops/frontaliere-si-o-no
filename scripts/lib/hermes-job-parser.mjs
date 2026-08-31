#!/usr/bin/env node
/**
 * Hermès job parser — Fetcher and job builder.
 *
 * Source: https://talents.hermes.com/en/sites/CX/jobs
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllHermesJobs()  — Fetch and parse all jobs
 *   - isHermesJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchJson } from './crawler-template.mjs';
import { resolveSourceBackedSwissGeography } from './prospector/location-evidence.mjs';
import { assertJsonListShape } from './assert-json-list-shape.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const HERMES_KEY = 'hermes';
export const HERMES_COMPANY_NAME = 'Hermès';
export const HERMES_COMPANY_DOMAIN = 'hermes.com';

const CAREER_URL = 'https://talents.hermes.com/en/sites/CX/jobs';

// Oracle Recruiting Cloud (ORC / HCM Fusion) REST endpoint for site CX_12001.
const ORC_HOST = 'fa-eoic-saasfaprod1.fa.ocs.oraclecloud.com';
const ORC_BASE = `https://${ORC_HOST}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`;
// Per-requisition detail endpoint — carries the full ExternalDescriptionStr
// body (the list endpoint above returns it empty). Finder: ById;Id="…".
const ORC_DETAIL_BASE = `https://${ORC_HOST}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails`;
const ORC_SITE_NUMBER = 'CX_12001';
const ORC_PAGE_SIZE = 200;
const ORC_MAX_PAGES = 12; // safety cap (~2400 reqs); current global total ~956

// Public job-detail URL host (talents.hermes.com) — what we publish/apply to.
const JOB_DETAIL_BASE = 'https://talents.hermes.com/en/sites/CX/jobs';

const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** @param {string} location @param {string} canton */
export function hermesAddressFields(location, canton) {
  const addressLocality = normalizeSpace(location.split(',')[0])
    .replace(/\s+(?:GE|CH)$/i, '')
    .trim();
  const normalizedLocality = normalize(addressLocality)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const isGenevaHq = canton === 'GE'
    && new Set(['geneve', 'geneva', 'genf', 'ginevra']).has(normalizedLocality);
  return {
    addressLocality,
    postalCode: isGenevaHq ? '1204' : undefined,
    addressRegion: isGenevaHq ? 'Genève' : canton,
  };
}

/** Coerce a date-ish value to an ISO YYYY-MM-DD string, or '' if unparseable. */
function normalizeDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().split('T')[0];
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Hermès.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isHermesJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === HERMES_KEY ||
    key.startsWith('hermes') ||
    company.includes('hermès') ||
    url.includes('hermes.com')
  );
}

/**
 * Validate that a URL belongs to Hermès's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      // Primary domain + subdomains (keeps unit test green).
      host === 'hermes.com' ||
      host.endsWith('.hermes.com') ||
      // Real ATS posting host (Oracle ORC career portal).
      host === 'talents.hermes.com' ||
      // Oracle Recruiting Cloud REST API host (machine-readable source).
      host === ORC_HOST ||
      host.endsWith('.oraclecloud.com')
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

/**
 * Build the Oracle ORC requisitions endpoint URL for a given offset.
 */
function buildOrcUrl(offset) {
  const finder =
    `findReqs;siteNumber=${ORC_SITE_NUMBER},limit=${ORC_PAGE_SIZE},` +
    `offset=${offset},sortBy=POSTING_DATES_DESC`;
  const params = new URLSearchParams({
    onlyData: 'true',
    expand: 'requisitionList.secondaryLocations',
    finder,
  });
  return `${ORC_BASE}?${params.toString()}`;
}

/**
 * True if a requisition is located in Switzerland.
 * Matches the EXACT 2-letter country field (PrimaryLocationCountry or any
 * secondaryLocations[].CountryCode) — NOT a substring of the location string
 * (substring 'CH' false-positives on French towns like 'CHESSY').
 */
function isSwissRequisition(req) {
  if (String(req?.PrimaryLocationCountry || '').toUpperCase() === 'CH') return true;
  const secondary = Array.isArray(req?.secondaryLocations) ? req.secondaryLocations : [];
  return secondary.some((loc) => String(loc?.CountryCode || '').toUpperCase() === 'CH');
}

/**
 * Fetch all Swiss job requisitions from the Oracle ORC REST endpoint.
 * Pages by incrementing offset by ORC_PAGE_SIZE until offset >= TotalJobsCount.
 * Returns an array of raw listing objects: {title, location, url, postedAt, jobReqId}.
 */
async function fetchJobListings() {
  console.log(`   Fetching from Oracle ORC: ${ORC_BASE} (site ${ORC_SITE_NUMBER})`);

  const headers = { Accept: 'application/json', 'User-Agent': DESKTOP_UA };
  const listings = [];
  let total = Infinity;
  let scanned = 0;

  for (let page = 0; page < ORC_MAX_PAGES; page += 1) {
    const offset = page * ORC_PAGE_SIZE;
    if (offset >= total) break;

    const url = buildOrcUrl(offset);
    let payload;
    try {
      payload = await fetchJson(url, { headers });
    } catch (err) {
      console.warn(`   ⚠️ ORC page offset=${offset} failed: ${err.message}`);
      break;
    }

    const data = Array.isArray(payload?.items) ? payload.items[0] : null;
    if (!data) break;

    if (Number.isFinite(data.TotalJobsCount)) total = data.TotalJobsCount;
    const reqs = assertJsonListShape(data, { key: 'requisitionList', source: 'hermes' });
    if (reqs.length === 0) break;

    for (const req of reqs) {
      scanned += 1;
      if (!isSwissRequisition(req)) continue;

      const id = String(req.Id || '').trim();
      const title = normalizeSpace(req.Title || '');
      if (!id || !title) continue;

      listings.push({
        jobReqId: id,
        title,
        location: normalizeSpace(req.PrimaryLocation || ''),
        url: `${JOB_DETAIL_BASE}/${id}/`,
        postedAt: req.PostedDate || req.PostingStartDate || '',
        description: '',
      });
    }
  }

  console.log(`   Scanned ${scanned} global requisitions → ${listings.length} Switzerland (CH) jobs`);
  return listings;
}

/**
 * Fetch the full external description for a single requisition from the Oracle
 * ORC detail endpoint. The list endpoint returns ShortDescriptionStr /
 * ExternalDescriptionStr EMPTY; the detail endpoint carries the full
 * ExternalDescriptionStr body (HTML, verified live ~6k chars). Concatenates the
 * responsibilities + qualifications sections when present. Returns '' on any
 * failure so the caller falls back to a title-only lede.
 */
async function fetchHermesDetailDescription(jobReqId) {
  if (!jobReqId) return '';
  const finder = `ById;Id="${jobReqId}",siteNumber=${ORC_SITE_NUMBER}`;
  const params = new URLSearchParams({ onlyData: 'true', expand: 'all', finder });
  const url = `${ORC_DETAIL_BASE}?${params.toString()}`;
  try {
    const payload = await fetchJson(url, {
      headers: { Accept: 'application/json', 'User-Agent': DESKTOP_UA },
      timeoutMs: 15000,
    });
    const item = Array.isArray(payload?.items) ? payload.items[0] : null;
    if (!item) return '';
    const parts = [
      item.ExternalDescriptionStr,
      item.ExternalResponsibilitiesStr,
      item.ExternalQualificationsStr,
    ].filter(Boolean);
    return parts.join('\n');
  } catch {
    return ''; // network/timeout → caller falls back to the title lede
  }
}

/**
 * Fetch all Hermès jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllHermesJobs() {
  console.log(`🔍 Fetching Hermès jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    // TODO: Extract fields from each listing.
    // Adapt these field names to match the actual API response.
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const geography = resolveSourceBackedSwissGeography(listing.location);
    if (!geography) continue;
    const { location, canton } = geography;
    const address = hermesAddressFields(location, canton);
    // The list endpoint carries no body; fetch the full ExternalDescriptionStr
    // from the ORC detail endpoint so jobs aren't thin → boilerplate-padded →
    // boilerplate-guard failure (#1718). Falls back to '' (then a title lede).
    const descriptionHtml = await fetchHermesDetailDescription(listing.jobReqId) || listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'fr');
    const jobSlug = slugify(`${title} hermes ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `hermes-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: HERMES_COMPANY_NAME,
      companyKey: HERMES_KEY,
      companyDomain: HERMES_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Hermès`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Hermès` },
      location,
      canton,
      url: publicUrl,
      source: 'Hermès Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: address.addressLocality,
      // 1204 is the Genève HQ, not a canton-wide fallback: Meyrin/Carouge and
      // other GE vacancies must retain their own source address or no CAP.
      postalCode: address.postalCode,
      // Region = canton (not the city name). For non-GE jobs the old
      // `: location` branch leaked the city into addressRegion (#1720 item 3,
      // same class as decathlon). Keep the friendly 'Genève' label for the GE HQ.
      addressRegion: address.addressRegion,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Luxury goods / fashion / watchmaking',
      currency: 'CHF',
      featured: false,
      postedDate: normalizeDate(listing.postedAt) || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300)); // Rate limiting
  }

  console.log(`\n📋 Total Hermès jobs discovered: ${jobs.length}`);
  return jobs;
}
