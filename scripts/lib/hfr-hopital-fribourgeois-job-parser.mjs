#!/usr/bin/env node
/**
 * Hôpital fribourgeois (HFR) / freiburger spital job parser.
 *
 * HFR moved its public recruitment portal from Breezy HR to Oracle HCM on
 * 2 November 2026. The employer page now links to the Oracle candidate
 * experience site, while the former Breezy board is an empty migration stub.
 * Query Oracle's public recruiting endpoint directly instead of scraping the
 * candidate-experience SPA shell.
 */
import { createHash } from 'node:crypto';
import { sourcePostingDateCandidatesFields } from './source-posting-date.mjs';
import { detectLang } from './dedicated-crawler-common.mjs';
import { assertJsonListShape } from './assert-json-list-shape.mjs';
import { slugify } from './slugify.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  detectHealthcareCategory,
  detectHealthcareEmploymentType,
  detectHealthcareExperienceLevel,
  htmlToText,
} from './hospital-custom-html-helpers.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { fetchWithRetry, RETRYABLE_STATUS } from './transient-fetch.mjs';

export const HFR_KEY = 'hfr-hopital-fribourgeois';
export const HFR_COMPANY_NAME = 'Hôpital fribourgeois (HFR)';
export const HFR_COMPANY_DOMAIN = 'h-fr.ch';
export const HFR_CAREERS_URL = 'https://www.h-fr.ch/le-reseau-hfr/nos-offres-demploi/';
export const HFR_ORACLE_BASE = 'https://fa-eswr-saasfaprod1.fa.ocs.oraclecloud.com';
export const HFR_ORACLE_SITE = 'CX_1';

const HFR_ORACLE_HOST = new URL(HFR_ORACLE_BASE).hostname;
const HFR_DEFAULT_CITY = 'Fribourg';
const HFR_DEFAULT_CANTON = 'FR';
const HFR_DEFAULT_POSTAL_CODE = '1708';
const ORACLE_ITEMS_PER_PAGE = 50;
const ORACLE_MAX_PAGES = 100;
const OLD_BREEZY_HOSTS = new Set([
  'hopital-fribourgeois.breezy.hr',
  'hfr-emploi.breezy.hr',
]);

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeKey(value = '') {
  return normalize(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isSwissCountry(value = '') {
  return /^(?:ch|che|switzerland|suisse|schweiz|svizzera)$/i.test(normalizeSpace(value));
}

function hostOf(rawUrl = '') {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isHfrHost(host = '') {
  return host === HFR_COMPANY_DOMAIN
    || host.endsWith(`.${HFR_COMPANY_DOMAIN}`)
    || host === HFR_ORACLE_HOST
    || OLD_BREEZY_HOSTS.has(host);
}

/**
 * Check whether a stored job belongs to HFR, including records created by the
 * former Breezy parser so the Oracle migration can merge them safely.
 */
export function isHfrJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const urlHost = hostOf(job?.url || '');
  return key === HFR_KEY
    || key.startsWith(`${HFR_KEY}-`)
    || company.includes('hôpital fribourgeois')
    || company.includes('hopital fribourgeois')
    || company.includes('freiburger spital')
    || /\bhfr\b/.test(company)
    || isHfrHost(urlHost);
}

/** Validate employer and Oracle candidate URLs before they reach JobPosting. */
export function isTrustedDomain(rawUrl = '') {
  return isHfrHost(hostOf(rawUrl));
}

function buildOracleDetailUrl(requisitionId) {
  const id = String(requisitionId || '').trim();
  return `${HFR_ORACLE_BASE}/hcmUI/CandidateExperience/fr/sites/${HFR_ORACLE_SITE}/job/${encodeURIComponent(id)}`;
}

function buildOracleListingUrl(offset) {
  const params = new URLSearchParams({
    onlyData: 'true',
    expand: 'requisitionList.secondaryLocations',
    finder: `findReqs;siteNumber=${HFR_ORACLE_SITE},facetsList=LOCATIONS,limit=${ORACLE_ITEMS_PER_PAGE},offset=${offset},sortBy=POSTING_DATES_DESC`,
  });
  return `${HFR_ORACLE_BASE}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?${params}`;
}

async function fetchJson(url) {
  return fetchWithRetry(async () => {
    const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await globalThis.fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
        },
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} from ${url}`);
        error.status = response.status;
        error.retryable = RETRYABLE_STATUS.has(response.status);
        throw error;
      }
      const raw = await response.text();
      try {
        return JSON.parse(raw);
      } catch (cause) {
        const error = new Error(`Invalid JSON from ${url}: ${cause?.message || cause}`);
        error.retryable = true;
        error.cause = cause;
        throw error;
      }
    } finally {
      clearTimeout(timer);
    }
  }, { label: `hfr-oracle ${url}` });
}

function selectorMiss(message, discoveredCount = null) {
  console.warn(`⚠️ HFR Oracle listing extraction failed: ${message}`);
  return {
    requisitions: [],
    discoveredCount,
    fetchOutcome: 'selector_miss',
  };
}

function validRequisition(row) {
  return row && typeof row === 'object'
    && String(row.Id || '').trim()
    && normalizeSpace(row.Title || '').length >= 3;
}

/**
 * Fetch a complete Oracle requisition snapshot. A malformed envelope or an
 * incomplete page is returned as selector_miss metadata, never as a genuine
 * empty board, so the standard pipeline preserves the previous slice.
 */
async function fetchOracleRequisitions() {
  const requisitions = [];
  const seenIds = new Set();
  let offset = 0;
  let totalCount = null;
  let lastPageSize = 0;

  for (let page = 1; page <= ORACLE_MAX_PAGES; page += 1) {
    const data = await fetchJson(buildOracleListingUrl(offset));
    const envelopes = assertJsonListShape(data, {
      key: 'items',
      source: HFR_KEY,
      rowShapeOk: (row) => row && typeof row === 'object' && !Array.isArray(row),
    });
    if (envelopes.length === 0) {
      if (page === 1 || (totalCount !== null && requisitions.length < totalCount)) {
        return selectorMiss(`page ${page} has no Oracle result envelope (offset=${offset})`, totalCount);
      }
      break;
    }

    const envelope = envelopes[0];
    const rawRequisitions = assertJsonListShape(envelope, {
      key: 'requisitionList',
      source: HFR_KEY,
      rowShapeOk: validRequisition,
    });
    if (!Array.isArray(envelope.requisitionList)) {
      return selectorMiss('Oracle result envelope has no requisitionList array', totalCount);
    }

    if (totalCount === null) {
      const declaredTotal = Number(envelope.TotalJobsCount ?? envelope.totalJobsCount);
      if (Number.isSafeInteger(declaredTotal) && declaredTotal >= 0) totalCount = declaredTotal;
    }
    lastPageSize = rawRequisitions.length;

    if (rawRequisitions.length === 0) {
      if (page === 1 && totalCount === 0) {
        return { requisitions: [], discoveredCount: 0, fetchOutcome: 'ok' };
      }
      if (totalCount !== null && requisitions.length >= totalCount) break;
      return selectorMiss(`page ${page} exposes no requisitions before the declared total`, totalCount);
    }

    if (rawRequisitions.some((row) => !validRequisition(row))) {
      console.warn(`⚠️ HFR Oracle requisition row shape changed on page ${page}; invalid rows are not publishable.`);
    }
    for (const requisition of rawRequisitions) {
      if (!validRequisition(requisition)) continue;
      const id = String(requisition.Id).trim();
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      requisitions.push(requisition);
    }

    offset += rawRequisitions.length;
    if (totalCount !== null && offset >= totalCount) break;
    if (totalCount === null && rawRequisitions.length < ORACLE_ITEMS_PER_PAGE) break;
    if (page < ORACLE_MAX_PAGES) await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (totalCount !== null && requisitions.length < totalCount) {
    return selectorMiss(
      `pagination ended after ${requisitions.length}/${totalCount} requisitions`,
      totalCount,
    );
  }
  if (requisitions.length === 0 && lastPageSize > 0) {
    return selectorMiss('Oracle returned rows but none had the expected Id/Title fields', totalCount);
  }
  return {
    requisitions,
    discoveredCount: totalCount ?? requisitions.length,
    fetchOutcome: 'ok',
  };
}

function unwrapDetailPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (Array.isArray(payload.items)) return payload.items[0] || null;
  return payload;
}

async function fetchRequisitionDetails(requisitionId) {
  const id = String(requisitionId || '').trim();
  if (!id) return null;
  try {
    return unwrapDetailPayload(await fetchJson(
      `${HFR_ORACLE_BASE}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails/${encodeURIComponent(id)}?onlyData=true`,
    ));
  } catch (error) {
    console.warn(`⚠️ HFR Oracle detail fetch failed for ${id}: ${error?.message || error}`);
    return null;
  }
}

function extractCity(rawLocation = '') {
  const parts = normalizeSpace(rawLocation)
    .split(',')
    .map((part) => normalizeSpace(part))
    .filter(Boolean);
  const city = parts.find((part) => !isSwissCountry(part) && !/^(?:CH|FR)$/i.test(part) && !/^\d{4}$/.test(part));
  return city || HFR_DEFAULT_CITY;
}

function extractPostalCode(requisition, rawLocation) {
  const explicit = [
    requisition.PrimaryLocationPostalCode,
    requisition.PostalCode,
    normalizeSpace(rawLocation).match(/\b\d{4}\b/)?.[0],
  ].map((value) => String(value || '').trim()).find((value) => /^\d{4}$/.test(value));
  if (explicit) return explicit;
  return normalizeKey(extractCity(rawLocation)) === normalizeKey(HFR_DEFAULT_CITY)
    ? HFR_DEFAULT_POSTAL_CODE
    : '';
}

function resolveLocation(requisition) {
  const rawLocation = normalizeSpace(
    requisition.PrimaryLocation
    || requisition.PrimaryLocationName
    || requisition.Location
    || '',
  );
  const city = extractCity(rawLocation);
  const canton = inferSwissTargetCanton(
    `${rawLocation} ${requisition.PrimaryLocationRegion || requisition.Region || ''}`,
  ) || HFR_DEFAULT_CANTON;
  return {
    location: rawLocation || city,
    city,
    canton,
    postalCode: extractPostalCode(requisition, rawLocation),
    streetAddress: normalizeSpace(
      requisition.PrimaryLocationStreet
      || requisition.PrimaryLocationAddress
      || requisition.StreetAddress
      || '',
    ),
  };
}

function detectEmploymentType(text = '') {
  const value = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)\b/.test(value)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)\b/.test(value)) return 'FULL_TIME';
  return detectHealthcareEmploymentType(text);
}

function isForeignRequisition(requisition) {
  const country = normalizeSpace(requisition.PrimaryLocationCountry || requisition.Country || '');
  if (country && !isSwissCountry(country)) return true;
  return false;
}

function buildJob(requisition, detail) {
  const reqId = String(requisition.Id || '').trim();
  const title = normalizeSpace(requisition.Title || '');
  if (!reqId || title.length < 3) return null;

  const detailDescription = htmlToText(detail?.ExternalDescriptionStr || '');
  const listingDescription = htmlToText(requisition.ShortDescriptionStr || '');
  const description = [detailDescription, listingDescription]
    .find((candidate) => meetsSourceBodyFloor(candidate)) || '';
  if (!description) return null;

  const publicUrl = buildOracleDetailUrl(reqId);
  const sourceLang = detectLang(description || title, 'fr');
  const location = resolveLocation(requisition);
  const employmentType = detectEmploymentType(
    `${requisition.TimeType || requisition.JobType || ''} ${title}`,
  );
  const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
  const jobSlug = slugify(`${title} ${HFR_KEY} ${location.city}`);

  return {
    id: `${HFR_KEY}-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: HFR_COMPANY_NAME,
    companyKey: HFR_KEY,
    companyDomain: HFR_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description,
    descriptionByLocale: { [sourceLang]: description },
    needsRetranslation: true,
    location: location.location,
    canton: location.canton,
    url: publicUrl,
    source: 'HFR Hôpital fribourgeois Dedicated Parser (Oracle HCM)',
    sourceLang,
    crawledAt: new Date().toISOString(),
    addressLocality: location.city,
    addressRegion: location.canton,
    streetAddress: location.streetAddress,
    postalCode: location.postalCode,
    addressCountry: 'CH',
    country: 'CH',
    category: detectHealthcareCategory(title),
    contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
    employmentType,
    experienceLevel: detectHealthcareExperienceLevel(title),
    sector: 'Sanità / Ospedali',
    currency: 'CHF',
    featured: false,
    ...sourcePostingDateCandidatesFields([
      requisition.PostedDate,
      requisition.postedDate,
      detail?.ExternalPostedStartDate,
      detail?.PostedDate,
    ]),
    applyUrl: publicUrl,
    jobReqId: reqId,
    externalId: reqId,
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },
  };
}

/**
 * Fetch all HFR jobs from the current Oracle HCM portal.
 *
 * The structured return keeps the source verdict beside the jobs array. A
 * malformed Oracle envelope is therefore distinguishable from a valid empty
 * result by the standard crawler summary and cannot silently retire the old
 * HFR slice.
 */
export async function fetchAllHfrJobs() {
  console.log(`🏥 Fetching ${HFR_COMPANY_NAME} jobs`);
  console.log(`   Oracle HCM site: ${HFR_ORACLE_SITE}`);
  console.log(`   Careers page: ${HFR_CAREERS_URL}\n`);

  const discovery = await fetchOracleRequisitions();
  if (discovery.fetchOutcome !== 'ok') {
    return {
      jobs: [],
      discoveredCount: discovery.discoveredCount,
      fetchOutcome: discovery.fetchOutcome,
    };
  }
  if (discovery.requisitions.length === 0) {
    console.log('ℹ️ Oracle HCM returned a verified empty HFR requisition snapshot.');
    return { jobs: [], discoveredCount: 0, fetchOutcome: 'ok' };
  }

  const jobs = [];
  let skippedForeign = 0;
  let skippedThin = 0;
  for (const requisition of discovery.requisitions) {
    if (isForeignRequisition(requisition)) {
      skippedForeign += 1;
      continue;
    }
    const detail = await fetchRequisitionDetails(requisition.Id);
    const job = buildJob(requisition, detail);
    if (!job) {
      skippedThin += 1;
      continue;
    }
    jobs.push(job);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  console.log(
    `📋 Total ${HFR_COMPANY_NAME} jobs discovered: ${jobs.length}`
    + ` (${skippedForeign} foreign, ${skippedThin} without a source body)`,
  );
  return {
    jobs,
    discoveredCount: discovery.discoveredCount,
    fetchOutcome: 'ok',
  };
}
