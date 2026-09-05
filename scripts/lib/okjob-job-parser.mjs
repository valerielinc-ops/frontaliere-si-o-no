#!/usr/bin/env node
/**
 * OK Job SA, succursale di Mendrisio job parser — Fetcher and job builder.
 *
 * Source: https://www.okjob.ch/offres-demplois/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllOkjobJobs()  — Fetch and parse all jobs
 *   - isOkjobJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { extractDetailFields } from './prospector/extract.mjs';
import { resolveSourceBackedSwissGeography } from './prospector/location-evidence.mjs';
import { loadSpec, runSpecInProduction } from './prospector/spec-crawler.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const OKJOB_KEY = 'okjob';
export const OKJOB_COMPANY_NAME = 'OK Job SA, succursale di Mendrisio';
export const OKJOB_COMPANY_DOMAIN = 'okjob.ch';

const CAREER_URL = 'https://www.okjob.ch/offres-demplois/';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to OK Job SA, succursale di Mendrisio.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isOkjobJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === OKJOB_KEY ||
    key.startsWith('okjob') ||
    company.includes('ok job sa, succursale di mendrisio') ||
    url.includes('okjob.ch')
  );
}

/**
 * Validate that a URL belongs to OK Job SA, succursale di Mendrisio's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'okjob.ch' || host.endsWith('.okjob.ch');
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

/**
 * La pagina di dettaglio okjob non pubblica ne' schema.org ne' un campo
 * indirizzo: il comune vive solo nel titolo di pagina, `<Prefisso> <titolo> -
 * <Comune> | Okjob` (`Emploi ... | Okjob` in francese, `Stellenangebote ... |
 * Okjob` in tedesco). Senza questa evidenza il gate geografico scarta ogni
 * riga e il crawler pubblica zero annunci.
 *
 * Il comune resta source-backed — e' il sito stesso a dichiararlo — e il
 * suffisso di marca e' obbligatorio, cosi' il titolo di una pagina qualunque
 * non puo' diventare evidenza. La validita' del comune la decide comunque il
 * resolver svizzero condiviso.
 *
 * @param {string} html
 * @param {string} pageUrl
 */
export function extractOkjobDetailFields(html = '', pageUrl = '') {
  const source = String(html || '');
  const detail = extractDetailFields(source, pageUrl);
  if (!source || detail.location || detail.locationCandidates?.length) return detail;

  const dom = new JSDOM(source);
  const { document } = dom.window;
  try {
    const branded = normalizeSpace(
      document.querySelector('meta[property="og:title"]')?.getAttribute('content')
      || document.querySelector('title')?.textContent
      || '',
    );
    // `<Prefisso> <titolo> - <Comune> | Okjob`: accetta solo il suffisso di
    // marca del sito, cosi' un titolo qualunque non diventa evidenza.
    const withoutBrand = /\|\s*okjob\s*$/i.test(branded)
      ? normalizeSpace(branded.replace(/\|\s*okjob\s*$/i, ''))
      : '';
    const separator = withoutBrand.lastIndexOf(' - ');
    const location = separator === -1 ? '' : normalizeSpace(withoutBrand.slice(separator + 3));
    if (!location) return detail;

    return {
      ...detail,
      location,
      addressLocality: location,
      locationCandidates: [{ location, addressLocality: location, addressCountry: '' }],
    };
  } finally {
    dom.window.close();
  }
}

async function fetchJobListings(runtime = {}) {
  const spec = loadSpec(OKJOB_KEY);
  return runSpecInProduction(spec, {
    ...runtime,
    detailExtractor: extractOkjobDetailFields,
  });
}

/**
 * Fetch all OK Job SA, succursale di Mendrisio jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllOkjobJobs(runtime = {}) {
  console.log(`🔍 Fetching OK Job SA, succursale di Mendrisio jobs`);
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

    const sourceLang = detectLang(descriptionText || title, 'fr');
    const jobSlug = slugify(`${title} okjob ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `okjob-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: OKJOB_COMPANY_NAME,
      companyKey: OKJOB_KEY,
      companyDomain: OKJOB_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'OK Job SA, succursale di Mendrisio Dedicated Parser',
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

  console.log(`\n📋 Total OK Job SA, succursale di Mendrisio jobs discovered: ${jobs.length}`);
  return jobs;
}
