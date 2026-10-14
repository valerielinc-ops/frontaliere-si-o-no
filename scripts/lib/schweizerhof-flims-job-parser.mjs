#!/usr/bin/env node
/**
 * Schweizerhof job parser — Fetcher and job builder.
 *
 * Source: https://romantikhotels.hcm4all.de/list/?l=de
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSchweizerhofFlimsJobs()  — Fetch and parse all jobs
 *   - isSchweizerhofFlimsJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { mergeSourcePostingDates } from './source-posting-date.mjs';
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { extractRuntimeDetailFields } from './prospector/detail-extract.mjs';
import {
  fetchHtmlViaBrowser,
  loadSpec,
  runSpecInProduction,
} from './prospector/spec-crawler.mjs';
import { resolveSourceBackedSwissGeography } from './prospector/location-evidence.mjs';
import { extractBalancedTagBlock } from './hospital-custom-html-helpers.mjs';
import { readAttr, scanStartTags } from './html-attr.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SCHWEIZERHOF_FLIMS_KEY = 'schweizerhof-flims';
export const SCHWEIZERHOF_FLIMS_COMPANY_NAME = 'Schweizerhof';
export const SCHWEIZERHOF_FLIMS_COMPANY_DOMAIN = 'romantikhotels.hcm4all.de';

const CAREER_URL = 'https://romantikhotels.hcm4all.de/list/?l=de';
const LEGACY_SOURCE_DOMAIN = 'hotelcareer.ch';
const LEGACY_ROMANTIK_SOURCE_DOMAIN = 'romantikhotels.com';
const SCHWEIZERHOF_FLIMS_PATH = '/jobs/romantik-hotel-schweizerhof-11933';
const HCM4ALL_DETAIL_PATH = '/list/';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function isSchweizerhofFlimsListingUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    const isLegacyListing = (host === LEGACY_SOURCE_DOMAIN || host.endsWith(`.${LEGACY_SOURCE_DOMAIN}`))
      && (path === SCHWEIZERHOF_FLIMS_PATH || path.startsWith(`${SCHWEIZERHOF_FLIMS_PATH}/`));
    const isHcm4allDetail = (host === SCHWEIZERHOF_FLIMS_COMPANY_DOMAIN
      || host.endsWith(`.${SCHWEIZERHOF_FLIMS_COMPANY_DOMAIN}`))
      && path.startsWith(HCM4ALL_DETAIL_PATH)
      && path.length > HCM4ALL_DETAIL_PATH.length;

    return isLegacyListing || isHcm4allDetail;
  } catch {
    return false;
  }
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Schweizerhof.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isSchweizerhofFlimsJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = job?.url || '';

  return (
    key === SCHWEIZERHOF_FLIMS_KEY ||
    key.startsWith('schweizerhof-flims-') ||
    company.includes('schweizerhof') ||
    isSchweizerhofFlimsListingUrl(url)
  );
}

/**
 * Validate that a URL belongs to Schweizerhof's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === LEGACY_SOURCE_DOMAIN
      || host.endsWith(`.${LEGACY_SOURCE_DOMAIN}`)
      || host === LEGACY_ROMANTIK_SOURCE_DOMAIN
      || host.endsWith(`.${LEGACY_ROMANTIK_SOURCE_DOMAIN}`)
      || host === SCHWEIZERHOF_FLIMS_COMPANY_DOMAIN
      || host.endsWith(`.${SCHWEIZERHOF_FLIMS_COMPANY_DOMAIN}`)
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

function removeSchweizerhofExcludedMarkup(html = '') {
  return String(html || '')
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<([a-z][\w:-]*)\b[^>]*\bitemprop\s*=\s*(['"])(?:email|telephone)\2[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<([a-z][\w:-]*)\b[^>]*\bhref\s*=\s*(['"])(?:mailto:|tel:)[^>]*>[\s\S]*?<\/\1>/gi, '');
}

function extractSchweizerhofJobMain(html = '') {
  const source = String(html || '');
  const jobBody = scanStartTags(source, 'div').find(({ raw }) =>
    /\bjob-ad-body\b/i.test(readAttr(raw, 'class')),
  );
  if (!jobBody) return '';

  const body = extractBalancedTagBlock(source.slice(jobBody.end), 'div');
  return removeSchweizerhofExcludedMarkup(
    /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(body)?.[1] || '',
  ).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
}

function normalizeSchweizerhofEvidence(value = '') {
  return stripHtml(String(value || ''))
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasSchweizerhofFlimsLocation(detail = {}) {
  const candidates = [
    detail.location,
    detail.addressLocality,
    detail.postalCode,
    ...(Array.isArray(detail.locationCandidates)
      ? detail.locationCandidates.flatMap((candidate) => [
        candidate?.location,
        candidate?.addressLocality,
        candidate?.postalCode,
      ])
      : []),
  ];
  return candidates.some((value) => {
    const normalized = normalizeSchweizerhofEvidence(value);
    return /\bflims(?:\s+(?:waldhaus|dorf))?\b/u.test(normalized)
      || /\b701[78]\b/u.test(normalized);
  });
}

function hasSchweizerhofFlimsIdentity(html, detail) {
  const tenantHeading = normalizeSchweizerhofEvidence(extractSchweizerhofTenantHeading(html));
  return /\bschweizerhof\b/u.test(tenantHeading)
    && hasSchweizerhofFlimsLocation(detail);
}

/**
 * Read the source-owned tenant heading from the HCM4all job body.
 *
 * The current portal places the native tenant heading in the vacancy benefits
 * section (section.offers[itemprop="jobBenefits"] > h2), while other sections
 * contain unrelated headings. Use the first native h2 in that source-owned
 * container. A Schweizerhof tenant is exposed as Schweizerhof Flims only with
 * source-backed Flims locality/address evidence. Never use email, phone,
 * footer or body prose as tenant evidence.
 *
 * @param {string} html
 * @returns {string}
 */
function extractSchweizerhofTenantHeading(html = '') {
  const main = extractSchweizerhofJobMain(html);
  const tenantSection = scanStartTags(main, 'section').find(({ raw }) => {
    const classes = readAttr(raw, 'class').toLowerCase().split(/\s+/u).filter(Boolean);
    const properties = readAttr(raw, 'itemprop').toLowerCase().split(/\s+/u).filter(Boolean);
    return classes.includes('offers') || properties.includes('jobbenefits');
  });
  if (!tenantSection) return '';
  const tenantSource = extractBalancedTagBlock(
    main.slice(tenantSection.end),
    tenantSection.name,
  );
  const match = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(tenantSource);
  return stripHtml(match?.[1] || '').replace(/\s+/g, ' ').trim();
}

/**
 * Add the source-scoped tenant heading to the shared detail evidence.
 *
 * @param {string} html
 * @param {string} url
 * @param {{ recordUrl?: string }} [opts]
 * @returns {Record<string, any>}
 */
export function extractSchweizerhofFlimsDetailFields(html = '', url = '', opts = {}) {
  const detail = extractRuntimeDetailFields(
    {},
    removeSchweizerhofExcludedMarkup(html),
    url,
    { recordUrl: opts.recordUrl },
  );
  const heading = extractSchweizerhofTenantHeading(html);
  const hasSchweizerhofTenantHeading = /\bschweizerhof\b/i.test(heading);
  const tenantHeading = hasSchweizerhofFlimsIdentity(html, detail)
    ? 'Schweizerhof Flims'
    : heading;
  const workplaceLabels = [
    ...(detail.workplaceLabels || []),
    ...(hasSchweizerhofTenantHeading ? [heading] : []),
    ...(hasSchweizerhofFlimsIdentity(html, detail) ? ['Schweizerhof Flims'] : []),
  ].filter((label, index, labels) => labels.indexOf(label) === index);
  return {
    ...detail,
    tenantHeading,
    ...(workplaceLabels.length ? { workplaceLabels } : {}),
  };
}

/* ── Fetcher guidato dalla spec ───────────────────────────────
 * Spec: data/prospector/crawlers/{key}.json — seed, modalita' di estrazione e
 * template degli URL di dettaglio, appresi dalla pagina reale.
 */
async function fetchJobListings() {
  const spec = loadSpec(SCHWEIZERHOF_FLIMS_KEY);
  // HCM4all can return the listing shell without rendered vacancy links to the
  // CI egress. Keep the shared direct/Jina path first, then let the browser
  // rescue render the same public index before the detail tenant filter runs.
  return runSpecInProduction(spec, {
    browserFetchImpl: fetchHtmlViaBrowser,
    detailExtractor: extractSchweizerhofFlimsDetailFields,
  });
}

/**
 * Fetch all Schweizerhof jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllSchweizerhofFlimsJobs() {
  console.log(`🔍 Fetching Schweizerhof jobs`);
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
    // Required structured-data geography must come from the vacancy source.
    // Missing, foreign or non-specific values are not replaced with an HQ.
    if (!geography) continue;
    const { location, canton } = geography;
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    if (!descriptionText) continue;
    // The detail URL is the vacancy identity: falling back to the listing page
    // would give every posting the same `url`, `applyUrl` and `id` hash.
    if (!listing.url) continue;
    const publicUrl = listing.url;
    const employmentType = detectEmploymentType(listing.timeType || title);

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} ${location} schweizerhof-flims ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `schweizerhof-flims-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SCHWEIZERHOF_FLIMS_COMPANY_NAME,
      companyKey: SCHWEIZERHOF_FLIMS_KEY,
      companyDomain: SCHWEIZERHOF_FLIMS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'Schweizerhof Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      // Prospected runtime rows retain the selected structured candidate;
      // other ATS tiers use the same fields when their client exposes them.
      addressLocality: normalizeSpace(listing.addressLocality || location.split(/[,;/|]/)[0]),
      addressRegion: normalizeSpace(listing.addressRegion || canton),
      addressCountry: normalizeSpace(listing.addressCountry || 'CH'),
      country: normalizeSpace(listing.addressCountry || 'CH'),
      ...(listing.postalCode ? { postalCode: normalizeSpace(listing.postalCode) } : {}),
      ...(listing.streetAddress ? { streetAddress: normalizeSpace(listing.streetAddress) } : {}),
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Altro', // TODO: Set appropriate sector
      currency: 'CHF',
      featured: false,
      ...mergeSourcePostingDates({}, listing),
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Schweizerhof jobs discovered: ${jobs.length}`);
  return jobs;
}
