#!/usr/bin/env node
/**
 * Decathlon job parser — Fetcher and job builder.
 *
 * Source: https://joinus.decathlon.ch/fr_CH/annonces
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllDecathlonJobs()  — Fetch and parse all jobs
 *   - isDecathlonJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchJson } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { assertJsonListShape } from './assert-json-list-shape.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const DECATHLON_KEY = 'decathlon';
export const DECATHLON_COMPANY_NAME = 'Decathlon';
export const DECATHLON_COMPANY_DOMAIN = 'decathlon.ch';

// Switzerland-only career domain (DigitalRecruiters ATS). Every job_ad here is a
// Swiss store/HQ role, so no country facet is needed.
const CAREER_DOMAIN = 'joinus.decathlon.ch';
const CAREER_URL = `https://${CAREER_DOMAIN}/fr_CH/annonces`;
// DigitalRecruiters public job-ads API. Locale MUST be underscore form (fr_CH /
// de_CH); hyphen form returns HTTP 400. Detail URL = /fr_CH/annonce/{item.url}.
const API_BASE = 'https://api.digitalrecruiters.com/public/v1/careers-site/job-ads';
const API_LOCALE = 'fr_CH';
const PAGE_LIMIT = 200;
const DETAIL_URL_PREFIX = `https://${CAREER_DOMAIN}/${API_LOCALE}/annonce/`;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Decathlon.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isDecathlonJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === DECATHLON_KEY ||
    key.startsWith('decathlon') ||
    company.includes('decathlon') ||
    url.includes('decathlon.ch')
  );
}

/**
 * Validate that a URL belongs to Decathlon's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'decathlon.ch' ||
      host.endsWith('.decathlon.ch') || // joinus.decathlon.ch (real posting host)
      host === 'api.digitalrecruiters.com' // DigitalRecruiters ATS API
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
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
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

const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Content-Type': 'application/json',
  Origin: `https://${CAREER_DOMAIN}`,
  Referer: CAREER_URL,
};

/**
 * Parse the trailing "-{4-digit-postal}-{city}" segment from a job-ad slug.
 * e.g. "...-decathlon-martigny-1920-martigny" → { postalCode: '1920' }.
 */
function parsePostalFromSlug(slug = '') {
  const m = String(slug).match(/-(\d{4})-[a-z0-9-]+$/i);
  return m ? m[1] : '';
}

/**
 * Fetch all job-ad listings from the DigitalRecruiters public API.
 * Paginates by 1-based `page` until collected items reach the reported count.
 * Returns raw listing objects from the ATS (no normalization here).
 */
async function fetchJobListings() {
  console.log(`   Fetching from: ${API_BASE} (domain ${CAREER_DOMAIN})`);

  const collected = [];
  let page = 1;
  let total = Infinity;

  // Hard cap on pages as a safety net (count is ~72; PAGE_LIMIT=200 fits in 1).
  while (collected.length < total && page <= 25) {
    const url = `${API_BASE}?domainName=${encodeURIComponent(CAREER_DOMAIN)}&limit=${PAGE_LIMIT}&page=${page}&locale=${API_LOCALE}`;
    const data = await fetchJson(url, {
      method: 'POST',
      headers: REQUEST_HEADERS,
      body: { filters: {}, searchParameters: {} },
    });

    const items = assertJsonListShape(data, { key: 'items', source: 'decathlon' });
    if (typeof data?.count === 'number') total = data.count;
    if (items.length === 0) break;

    collected.push(...items);
    if (items.length < PAGE_LIMIT) break; // last page
    page += 1;
  }

  return collected;
}

/**
 * Fetch all Decathlon jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllDecathlonJobs() {
  console.log(`🔍 Fetching Decathlon jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  const seen = new Set();
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    // url slug is the stable per-ad identifier; build the public detail URL.
    const slug = String(listing.url || '').trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const publicUrl = `${DETAIL_URL_PREFIX}${slug}`;

    // Swiss-only domain: location is always a Swiss city. Canton via the city,
    // fall back to the HQ canton (Vernier / GE) for the rare unmatched city.
    const location = normalizeSpace(listing.location || 'Vernier');
    const canton = inferSwissTargetCanton(location) || 'GE';
    const postalCode = parsePostalFromSlug(slug);

    // Listing API has no body; the assembled title carries the role context.
    // The AI localization step enriches the description from the detail page.
    const descriptionText = title;

    const sourceLang = detectLang(title, 'fr');
    const jobSlug = slugify(`${title} decathlon ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    // contract: "Contrat à durée indéterminée" (CDI) / "...déterminée" (CDD).
    const contractText = String(listing.contract || '');

    const job = {
      // ── Required fields ──
      id: `decathlon-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: DECATHLON_COMPANY_NAME,
      companyKey: DECATHLON_KEY,
      companyDomain: DECATHLON_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'Decathlon Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      postalCode: postalCode || (canton === 'GE' ? '1214' : ''),
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      employmentType: detectEmploymentType(`${contractText} ${title}`),
      experienceLevel: detectExperienceLevel(title),
      sector: 'retail',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Decathlon jobs discovered: ${jobs.length}`);
  return jobs;
}
