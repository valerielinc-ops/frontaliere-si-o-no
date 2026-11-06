#!/usr/bin/env node
/**
 * Vereina job parser — Fetcher and job builder.
 *
 * Source: https://www.hotelcareer.ch/jobs/hotel-vereina-52746
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllVereinaklostersJobs()  — Fetch and parse all jobs
 *   - isVereinaklostersJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  copySpecFetchMetadata,
  fetchHtmlViaBrowser,
  loadSpec,
  runSpecInProduction,
} from './prospector/spec-crawler.mjs';
import { resolveSourceBackedSwissGeography } from './prospector/location-evidence.mjs';
import {
  isAuthoritativeEmptySnapshot,
  markAuthoritativeEmptySnapshot,
} from './authoritative-empty-snapshot.mjs';
import { hotelcareerEmptyEmployerPageEvidence } from './hotelcareer-employer-page.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const VEREINAKLOSTERS_KEY = 'vereinaklosters';
export const VEREINAKLOSTERS_COMPANY_NAME = 'Vereina';
export const VEREINAKLOSTERS_COMPANY_DOMAIN = 'hotelcareer.ch';

const CAREER_URL = 'https://www.hotelcareer.ch/jobs/hotel-vereina-52746';
const VEREINAKLOSTERS_PATH = '/jobs/hotel-vereina-52746';
const MIN_DESCRIPTION_WORDS = 50;
const VEREINAKLOSTERS_EMPTY_FETCH_OUTCOME = 'anti_bot_block';
export const VEREINAKLOSTERS_SECONDARY_SPEC = {
  companyKey: VEREINAKLOSTERS_KEY,
  companyName: VEREINAKLOSTERS_COMPANY_NAME,
  companyHost: 'local-job.ch',
  platform: 'local-job.ch',
  mode: 'template',
  seedUrls: [
    'https://local-job.ch/berufsgruppe/gastronomie-tourismus/graubuenden/serneus/',
  ],
  detailTemplate: '/job/*/',
  // local-job's listing anchors carry the role title while the employer label
  // sits beside the link. Filter on the source-backed detail page instead of
  // dropping every candidate before detail enrichment can prove its tenant.
  detailCandidateText: 'Hotel Vereina',
  detailEnrichment: true,
  detailFetchWorkers: 4,
  pagination: { maxPages: 10 },
  canton: 'GR',
  sourceLang: 'de',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function isVereinaListingUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return (host === VEREINAKLOSTERS_COMPANY_DOMAIN || host.endsWith(`.${VEREINAKLOSTERS_COMPANY_DOMAIN}`))
      && (url.pathname.toLowerCase() === VEREINAKLOSTERS_PATH
        || url.pathname.toLowerCase().startsWith(`${VEREINAKLOSTERS_PATH}/`));
  } catch {
    return false;
  }
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Vereina.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isVereinaklostersJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === VEREINAKLOSTERS_KEY ||
    key.startsWith('vereinaklosters-') ||
    company.includes('vereina') ||
    isVereinaListingUrl(url)
  );
}

/**
 * Validate that a URL belongs to Vereina's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'hotelcareer.ch'
      || host.endsWith('.hotelcareer.ch')
      || host === 'local-job.ch'
      || host.endsWith('.local-job.ch');
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

/* ── Fetcher guidato dalla spec ───────────────────────────────
 * Spec: data/prospector/crawlers/{key}.json — seed, modalita' di estrazione e
 * template degli URL di dettaglio, appresi dalla pagina reale.
 */
export async function fetchPrimaryJobListings({
  spec = loadSpec(VEREINAKLOSTERS_KEY),
  runtime = { browserFetchImpl: fetchHtmlViaBrowser },
} = {}) {
  // Every seed page the runtime accepted (direct, clean-IP or browser), kept
  // to read the employer page's own empty-state statement below.
  const seedPages = [];
  const seedUrls = new Set(spec.seedUrls || []);
  // Hotelcareer has served a source-backed listing to a clean IP while the
  // CI egress received an unmarked HTTP 200 interstitial. Ask the shared
  // runtime for its clean-IP empty-listing rescue; it still accepts the page
  // only when the normal vacancy extraction finds real detail links.
  const rows = await runSpecInProduction(
    {
      ...spec,
      rescueOnEmptyListing: true,
      // A zero after direct + clean-IP + browser rescue is not evidence that
      // Vereina has no vacancies: Hotelcareer has previously served two
      // source-backed detail links to a clean egress. Keep the prior slice and
      // make the WAF/interstitial verdict visible to crawler-health instead of
      // collapsing it to the generic no-jobs-parsed symptom.
      emptyListingOutcome: VEREINAKLOSTERS_EMPTY_FETCH_OUTCOME,
    },
    {
      ...runtime,
      onPageFetched: (page, url) => {
        if (seedUrls.has(url)) seedPages.push(page);
      },
    },
  );
  if (rows.length > 0) return rows;
  // An empty result is no proof of a zero (see above) — unless the employer
  // page itself says so. Hotelcareer serves Vereina's canonical page with
  // "Dieses Unternehmen sucht aktuell nicht nach Verstärkung" and no vacancy
  // link (verified 2026-10-01; vereinaklosters.ch/jobs links this page as its
  // open positions): the source's own zero, not a fetch gap. Without this
  // proof corpus group 19 reported it as `no-jobs-parsed` (runs 36632563903,
  // 36778722341) and crawler-health as broken.
  for (const page of seedPages) {
    const evidence = hotelcareerEmptyEmployerPageEvidence(page?.body, VEREINAKLOSTERS_PATH);
    if (evidence) return markAuthoritativeEmptySnapshot([], evidence);
  }
  return rows;
}

async function fetchSecondaryJobListings() {
  // Hotelcareer's Akamai fence has outlived the bounded direct/Jina/browser
  // rescue. local-job is a public regional board that currently republishes
  // Vereina's live Serneus vacancies with full detail pages; the generic
  // prospector still filters the employer and validates every detail before
  // anything can be published. Only consulted when the employer page did not
  // prove a zero itself (see fetchAllVereinaklostersJobs).
  return runSpecInProduction(VEREINAKLOSTERS_SECONDARY_SPEC);
}

/**
 * @param {Array<Record<string, any>>} listings
 * @returns {Array<Record<string, any>>}
 */
function buildVereinaJobs(listings) {
  if (!listings || listings.length === 0) return [];

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    // TODO: Extract fields from each listing.
    // Adapt these field names to match the actual API response.
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const geography = resolveSourceBackedSwissGeography(listing.location);
    // Required structured-data geography must come from the vacancy source.
    // Missing, foreign or non-specific values are not replaced by an HQ.
    if (!geography) continue;
    const { location, canton } = geography;
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    if (descriptionText.split(/\s+/).filter(Boolean).length < MIN_DESCRIPTION_WORDS) continue;
    // The detail URL is the vacancy identity: falling back to the listing page
    // would give every posting the same `url`, `applyUrl` and `id` hash.
    if (!listing.url) continue;
    const publicUrl = listing.url;
    const employmentType = detectEmploymentType(listing.timeType || title);
    const postedDate = normalizeSpace(listing.postedAt || listing.postedDate || '');

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} ${location} vereinaklosters ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `vereinaklosters-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: VEREINAKLOSTERS_COMPANY_NAME,
      companyKey: VEREINAKLOSTERS_KEY,
      companyDomain: VEREINAKLOSTERS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'Vereina Dedicated Parser',
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
      ...(postedDate ? { postedDate } : {}),
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Vereina jobs discovered: ${jobs.length}`);
  return jobs;
}

/**
 * Fetch all Vereina jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllVereinaklostersJobs({
  primaryFetchImpl = fetchPrimaryJobListings,
  secondaryFetchImpl = fetchSecondaryJobListings,
} = {}) {
  console.log(`🔍 Fetching Vereina jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  let primaryListings;
  let primaryError;
  try {
    primaryListings = await primaryFetchImpl();
  } catch (error) {
    primaryError = error;
  }

  // The official source proved it has no vacancy: a third-party board cannot
  // contradict it (local-job still republished a 2026-09-09 JobG8 copy of a
  // Vereina ad the employer page no longer lists).
  if (isAuthoritativeEmptySnapshot(primaryListings)) {
    console.log(`  🧩 Source-proven zero: ${primaryListings.authoritativeEmptyEvidence}`);
    return primaryListings;
  }

  const primaryJobs = buildVereinaJobs(primaryListings || []);
  if (primaryJobs.length > 0) return copySpecFetchMetadata(primaryJobs, primaryListings);

  let secondaryListings;
  let secondaryError;
  try {
    secondaryListings = await secondaryFetchImpl();
  } catch (error) {
    secondaryError = error;
  }

  const secondaryJobs = buildVereinaJobs(secondaryListings || []);
  if (secondaryJobs.length > 0) return copySpecFetchMetadata(secondaryJobs, secondaryListings);

  // Keep the primary source's explicit anti-bot/transport evidence when the
  // fallback is also empty or unavailable. Never turn a failed source into a
  // healthy authoritative zero, and never let a secondary outage hide the
  // primary diagnosis.
  if (primaryListings) return copySpecFetchMetadata(primaryJobs, primaryListings);
  if (primaryError) throw primaryError;
  if (secondaryListings) return copySpecFetchMetadata(secondaryJobs, secondaryListings);
  if (secondaryError) throw secondaryError;
  return [];
}
