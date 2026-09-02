#!/usr/bin/env node
/**
 * Apleona Schweiz AG job parser — Fetcher and job builder.
 *
 * Source: https://recruitingapp-2765.umantis.com/Jobs/1?lang=ger&ContentOnly=&message=
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllApleonaSchweizAgJobs()  — Fetch and parse all jobs
 *   - isApleonaSchweizAgJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import {
  extractDetailFields,
  isSufficientVacancyDescription,
} from './prospector/extract.mjs';
import { resolveSourceBackedSwissGeography } from './prospector/location-evidence.mjs';
import { loadSpec, runSpecInProduction } from './prospector/spec-crawler.mjs';
import { ALL_CANTON_CODES } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const APLEONA_SCHWEIZ_AG_KEY = 'apleona-schweiz-ag';
export const APLEONA_SCHWEIZ_AG_COMPANY_NAME = 'Apleona Schweiz AG';
export const APLEONA_SCHWEIZ_AG_COMPANY_DOMAIN = 'recruitingapp-2765.umantis.com';

const CAREER_URL = 'https://recruitingapp-2765.umantis.com/Jobs/1?lang=ger&ContentOnly=&message=';
const APLEONA_DETAIL_SECTIONS = [
  { className: 'tasks', vacancySpecific: true },
  { className: 'requirements', vacancySpecific: true },
  { className: 'why-apleona', vacancySpecific: false },
  { className: 'benefits', vacancySpecific: false },
];
const APLEONA_CANTON_CODES = new Set(ALL_CANTON_CODES);

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** Preserve paragraph boundaries and list bullets from a vacancy-owned node. */
function structuredElementText(element) {
  if (!element) return '';
  const clone = element.cloneNode(true);
  for (const removable of clone.querySelectorAll('script, style, template, h1, h2, h3, h4, h5, h6, .button')) {
    removable.remove();
  }
  for (const br of clone.querySelectorAll('br')) br.replaceWith('\n');
  for (const item of clone.querySelectorAll('li')) {
    const text = normalizeSpace(item.textContent || '');
    item.replaceWith(text ? `\n• ${text}\n` : '');
  }
  for (const paragraph of clone.querySelectorAll('p')) paragraph.append('\n');
  return String(clone.textContent || '')
    .split(/\n+/)
    .map(normalizeSpace)
    .filter(Boolean)
    .join('\n');
}

/**
 * @param {string} location
 * @returns {{ rejected: true } | { location: string, addressLocality: string, addressRegion: string, addressCountry: string, postalCode: string, streetAddress: string } | null}
 */
function apleonaLocationCandidate(location = '') {
  const display = normalizeSpace(location);
  if (!display) return null;
  const suffix = /\s+([A-Z]{2})$/.exec(display);
  const addressRegion = suffix && APLEONA_CANTON_CODES.has(suffix[1]) ? suffix[1] : '';
  const addressLocality = addressRegion
    ? display.slice(0, suffix.index).trim()
    : display;
  if (addressRegion) {
    const independentlyResolved = resolveSourceBackedSwissGeography(addressLocality);
    // A suffix that fails independent verification is a rejection, not an
    // absence of evidence: the caller must not let the raw display string
    // leak back into the generic location-evidence fallback, where the
    // shared resolver could re-derive a different canton than this
    // tenant-specific gate just refused.
    if (!independentlyResolved || independentlyResolved.canton !== addressRegion) return { rejected: true };
  }
  return {
    // Feed the municipality and CH evidence to the shared resolver separately.
    // Some ISO country/subdivision inventories also contain a colliding `BE`;
    // the municipality must independently resolve to the declared Swiss canton
    // instead of letting that suffix become foreign evidence.
    location: addressLocality,
    addressLocality,
    addressRegion: '',
    // A terminal code is accepted only after exact validation against all 26
    // Swiss cantons. That paired locality+region is explicit CH evidence, not
    // an employer/HQ fallback (and avoids interpreting BE as Belgium).
    addressCountry: addressRegion ? 'CH' : '',
    postalCode: '',
    streetAddress: '',
  };
}

/**
 * Extract the exact Apleona vacancy boundary rendered inside the Umantis
 * detail page. The surrounding page also contains branding, application and
 * contact chrome; selecting only these four job sections keeps useful headings
 * and bullets without publishing that repeated boilerplate as a description.
 *
 * At least one vacancy-specific section (tasks or requirements) is mandatory.
 * A page containing only the shared benefits panel therefore stays empty and
 * is quarantined by the shared detail-enrichment floor.
 *
 * @param {string} html
 * @param {string} pageUrl
 */
export function extractApleonaDetailFields(html = '', pageUrl = '') {
  const source = String(html || '');
  const base = extractDetailFields(source, pageUrl);
  if (!source) return base;

  const dom = new JSDOM(source);
  const { document } = dom.window;
  try {
    const title = normalizeSpace(
      document.querySelector('.heading .title')?.textContent
      || document.querySelector('.hero-title h1')?.textContent
      || '',
    );
    const location = normalizeSpace(
      document.querySelector('.heading .location .text')?.textContent
      || document.querySelector('.hero-details span')?.textContent
      || '',
    );
    const descriptionBlocks = [];
    let hasVacancySpecificSection = false;

    for (const sectionConfig of APLEONA_DETAIL_SECTIONS) {
      const section = document.querySelector(`.section.${sectionConfig.className}`);
      const body = section?.querySelector('.body');
      if (!section || !body) continue;

      const heading = normalizeSpace(section.querySelector('.title span')?.textContent || '');
      const bodyText = structuredElementText(body);
      if (!bodyText) continue;

      if (sectionConfig.vacancySpecific) hasVacancySpecificSection = true;
      descriptionBlocks.push([heading, bodyText].filter(Boolean).join('\n'));
    }

    // The same tenant currently serves a second Apleona-owned skin where the
    // vacancy sections are plain `<section><div class="container"><h2>...`.
    // Heading identity is the boundary: generic company/contact sections are
    // intentionally excluded even when they are longer.
    if (descriptionBlocks.length === 0) {
      for (const section of document.querySelectorAll('section')) {
        const heading = normalizeSpace(section.querySelector('h2')?.textContent || '');
        if (!/^(?:deine\s+)?(?:aufgaben|anforderungen)$/i.test(heading)) continue;
        const body = section.querySelector('.container') || section;
        const bodyText = structuredElementText(body);
        if (!bodyText) continue;
        hasVacancySpecificSection = true;
        descriptionBlocks.push([heading, bodyText].join('\n'));
      }
    }

    const candidateDescription = descriptionBlocks.join('\n\n');
    const description = hasVacancySpecificSection
      && isSufficientVacancyDescription(candidateDescription)
      ? candidateDescription
      : '';
    const locationResult = apleonaLocationCandidate(location);
    const locationRejected = Boolean(locationResult?.rejected);
    const locationCandidate = locationResult && !locationRejected ? locationResult : null;

    return {
      ...base,
      title: title || base.title,
      description,
      // On rejection, drop the raw string instead of publishing it: it would
      // otherwise become a candidate again downstream (locationEvidenceCandidates'
      // raw-location fallback, and the generic Umantis detail re-derivation in
      // spec-crawler.mjs), bypassing the gate that just refused it.
      location: locationRejected ? '' : (locationCandidate?.location || location),
      addressLocality: locationCandidate?.addressLocality || '',
      addressRegion: '',
      addressCountry: locationCandidate?.addressCountry || '',
      locationCandidates: locationCandidate ? [locationCandidate] : [],
      ...(locationRejected ? { locationGateRejected: true } : {}),
    };
  } finally {
    dom.window.close();
  }
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Apleona Schweiz AG.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isApleonaSchweizAgJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === APLEONA_SCHWEIZ_AG_KEY ||
    key.startsWith('apleona-schweiz-ag') ||
    company.includes('apleona schweiz ag') ||
    url.includes('recruitingapp-2765.umantis.com')
  );
}

/**
 * Validate that a URL belongs to Apleona Schweiz AG's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'recruitingapp-2765.umantis.com' || host.endsWith('.recruitingapp-2765.umantis.com');
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
async function fetchJobListings(runtime = {}) {
  const spec = loadSpec(APLEONA_SCHWEIZ_AG_KEY);
  return runSpecInProduction(spec, {
    ...runtime,
    detailExtractor: extractApleonaDetailFields,
  });
}

/**
 * Fetch all Apleona Schweiz AG jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllApleonaSchweizAgJobs(runtime = {}) {
  console.log(`🔍 Fetching Apleona Schweiz AG jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings(runtime);
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
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    if (!descriptionText) continue;
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'de');
    // Location is source-backed and separates same-title postings in distinct
    // offices. Existing routes are re-pinned by the runner; this only gives
    // newcomers a deterministic collision-free source slug.
    const jobSlug = slugify(`${title} apleona-schweiz-ag ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `apleona-schweiz-ag-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: APLEONA_SCHWEIZ_AG_COMPANY_NAME,
      companyKey: APLEONA_SCHWEIZ_AG_KEY,
      companyDomain: APLEONA_SCHWEIZ_AG_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'Apleona Schweiz AG Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: normalizeSpace(listing.addressLocality || location.split(/[,;/|]/)[0]),
      addressRegion: normalizeSpace(listing.addressRegion || canton),
      addressCountry: normalizeSpace(listing.addressCountry || "CH"),
      country: normalizeSpace(listing.addressCountry || "CH"),
      ...(listing.postalCode ? { postalCode: normalizeSpace(listing.postalCode) } : {}),
      ...(listing.streetAddress ? { streetAddress: normalizeSpace(listing.streetAddress) } : {}),
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(listing.timeType || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Altro', // TODO: Set appropriate sector
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    if (typeof runtime.sleepImpl === 'function') await runtime.sleepImpl(300);
    else await new Promise((r) => setTimeout(r, 300)); // Rate limiting
  }

  console.log(`\n📋 Total Apleona Schweiz AG jobs discovered: ${jobs.length}`);
  return jobs;
}
