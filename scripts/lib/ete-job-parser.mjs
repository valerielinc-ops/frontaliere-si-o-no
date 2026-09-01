#!/usr/bin/env node
/**
 * Emil Egger AG job parser — Fetcher and job builder.
 *
 * Source: https://www.ete.ch/unternehmen/jobs/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllEteJobs()  — Fetch and parse all jobs
 *   - isEteJob()         — Match jobs belonging to this company
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

/* ── Constants ─────────────────────────────────────────────── */

export const ETE_KEY = 'ete';
export const ETE_COMPANY_NAME = 'Emil Egger AG';
export const ETE_COMPANY_DOMAIN = 'ete.ch';

const CAREER_URL = 'https://www.ete.ch/unternehmen/jobs/';
const ETE_REQUEST_HEADERS = {
  // ETE currently serves Brotli bytes through the custom public-DNS dispatcher
  // without exposing a decoded HTML body. Requesting identity encoding keeps
  // the SSRF-safe transport and makes the source document parseable.
  'Accept-Encoding': 'identity',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * ETE renders the authoritative vacancy body in `section.job_description`,
 * which the generic detail extractor already reads correctly. Its job-specific
 * location is a labelled `dt`/`dd` pair instead of a schema/location class, so
 * generic extraction cannot see it and the geography gate drops every row.
 *
 * Keep the shared body extraction, but accept a location only from the exact
 * ETE datasheet field (`Standort`, or its observed French label `Site`). The
 * listing grid and the related-jobs widget repeat other locations on the same
 * page; neither is allowed to become evidence for the current vacancy.
 *
 * @param {string} html
 * @param {string} pageUrl
 */
export function extractEteDetailFields(html = '', pageUrl = '') {
  const source = String(html || '');
  const detail = extractDetailFields(source, pageUrl);
  if (!source) return detail;

  const dom = new JSDOM(source);
  const { document } = dom.window;
  try {
    const vacancyBody = document.querySelector('section.job_description');
    const locationLabel = [...document.querySelectorAll('section.data-sheet dt')]
      .find((node) => /^(?:standort|site)$/i.test(normalizeSpace(node.textContent || '')));
    const locationValue = locationLabel?.nextElementSibling;
    const location = locationValue?.tagName === 'DD'
      ? normalizeSpace(locationValue.textContent || '')
      : '';
    const description = vacancyBody && isSufficientVacancyDescription(detail.description)
      ? detail.description
      : '';
    const locationCandidate = location
      ? { location, addressLocality: location, addressCountry: '' }
      : null;

    return {
      ...detail,
      description,
      location,
      addressLocality: locationCandidate?.addressLocality || '',
      addressCountry: '',
      locationCandidates: locationCandidate ? [locationCandidate] : [],
    };
  } finally {
    dom.window.close();
  }
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Emil Egger AG.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isEteJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === ETE_KEY ||
    key.startsWith('ete') ||
    company.includes('emil egger ag') ||
    url.includes('ete.ch')
  );
}

/**
 * Validate that a URL belongs to Emil Egger AG's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'ete.ch' || host.endsWith('.ete.ch');
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
  const spec = loadSpec(ETE_KEY);
  return runSpecInProduction(spec, {
    ...runtime,
    headers: { ...(runtime.headers || {}), ...ETE_REQUEST_HEADERS },
    detailExtractor: extractEteDetailFields,
  });
}

/**
 * Fetch all Emil Egger AG jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllEteJobs(runtime = {}) {
  console.log(`🔍 Fetching Emil Egger AG jobs`);
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
    // ETE publishes identical titles at distinct depots. Location is exact
    // source evidence and keeps new routes injective; the runner separately
    // pins already-published records to their existing slugs.
    const jobSlug = slugify(`${title} ete ch ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `ete-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ETE_COMPANY_NAME,
      companyKey: ETE_KEY,
      companyDomain: ETE_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'Emil Egger AG Dedicated Parser',
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
    await new Promise((r) => setTimeout(r, 300)); // Rate limiting
  }

  console.log(`\n📋 Total Emil Egger AG jobs discovered: ${jobs.length}`);
  return jobs;
}
