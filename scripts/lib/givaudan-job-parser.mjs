#!/usr/bin/env node
/**
 * Givaudan job parser — Fetcher and job builder.
 *
 * Source: https://careers.givaudan.com/global/en
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllGivaudanJobs()  — Fetch and parse all jobs
 *   - isGivaudanJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchJson, fetchHtml } from './crawler-template.mjs';
import { htmlToMarkdown } from './axpo-job-parser.mjs';
import { resolveSourceBackedSwissGeography } from './prospector/location-evidence.mjs';
import { assertJsonListShape } from './assert-json-list-shape.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const GIVAUDAN_KEY = 'givaudan';
export const GIVAUDAN_COMPANY_NAME = 'Givaudan';
export const GIVAUDAN_COMPANY_DOMAIN = 'givaudan.com';

const CAREER_URL = 'https://careers.givaudan.com/global/en';

// Phenom People (CareerConnect) widgets endpoint, tenant GIVGIVGB.
const WIDGETS_URL = 'https://careers.givaudan.com/widgets';
const JOB_DETAIL_BASE = 'https://careers.givaudan.com/global/en/job';
const PAGE_SIZE = 50;
const HQ = { city: 'Vernier', canton: 'GE', postalCode: '1214', addressRegion: 'Genève' };
const SECTOR = 'Flavors & Fragrances (chemicals / FMCG ingredients)';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Givaudan.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isGivaudanJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === GIVAUDAN_KEY ||
    key.startsWith('givaudan') ||
    company.includes('givaudan') ||
    url.includes('givaudan.com')
  );
}

/**
 * Validate that a URL belongs to Givaudan's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    // Primary domain + subdomains (careers.givaudan.com, jobs.givaudan.com,
    // the real Phenom-served job-posting hosts) all live under givaudan.com.
    return host === 'givaudan.com' || host.endsWith('.givaudan.com');
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
 * Build the Phenom `refineSearch` request body for a given pagination offset.
 * `selected_fields.country=['Switzerland']` narrows the global pool (368) to
 * the Swiss-relevant set (~31) on the server side.
 */
function buildWidgetsBody(from) {
  return {
    lang: 'en_global',
    deviceType: 'desktop',
    country: 'global',
    ddoKey: 'refineSearch',
    sortBy: 'Most relevant',
    from,
    jobs: true,
    counts: true,
    size: PAGE_SIZE,
    clearAll: false,
    jdsource: 'facets',
    pageName: 'search-results',
    siteType: 'external',
    keywords: '',
    global: true,
    selected_fields: { country: ['Switzerland'] },
  };
}

/**
 * A raw job is CH-relevant when its primary country is Switzerland, OR it is a
 * multi-location role that lists a Swiss site (legitimate CH opening).
 */
function pickSwissLocation(raw) {
  if (String(raw?.country || '').trim() === 'Switzerland') {
    return raw.cityStateCountry || raw.location || raw.city || null;
  }
  const arr = Array.isArray(raw?.multi_location_array) ? raw.multi_location_array : [];
  const swiss = arr.find((m) => /,\s*Switzerland$/i.test(m?.location || ''));
  if (swiss) return swiss.location;
  // cityStateCountry can still carry Switzerland on some single-location records.
  if (/Switzerland/i.test(raw?.cityStateCountry || '')) return raw.cityStateCountry;
  return null;
}

/** The real source location text (empty when nothing was scraped at all). */
function pickRealLocationText(raw) {
  if (String(raw?.country || '').trim() === 'Switzerland') {
    return String(raw.cityStateCountry || raw.location || raw.city || '').trim();
  }
  const arr = Array.isArray(raw?.multi_location_array) ? raw.multi_location_array : [];
  const swiss = arr.find((m) => /,\s*Switzerland$/i.test(m?.location || ''));
  if (swiss) return String(swiss.location || '').trim();
  if (/Switzerland/i.test(raw?.cityStateCountry || '')) return String(raw.cityStateCountry || '').trim();
  return '';
}

/**
 * Fetch all Swiss listings from the Phenom widgets endpoint, paginating via
 * `from`/`size` until `from >= totalHits`. Returns normalized raw listings.
 */
async function fetchJobListings() {
  console.log(`   Fetching from: ${WIDGETS_URL}`);

  const headers = {
    'User-Agent': UA,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: 'https://careers.givaudan.com',
    Referer: CAREER_URL,
  };

  const listings = [];
  let from = 0;
  let totalHits = Infinity;
  let guard = 0;

  while (from < totalHits && guard < 50) {
    guard += 1;
    const payload = await fetchJson(WIDGETS_URL, {
      method: 'POST',
      headers,
      body: buildWidgetsBody(from),
    });

    const refine = payload?.refineSearch;
    const rawJobs = assertJsonListShape(refine?.data, { key: 'jobs', source: 'givaudan' });
    if (Number.isFinite(Number(refine?.totalHits))) totalHits = Number(refine.totalHits);

    if (rawJobs.length === 0) break;

    for (const raw of rawJobs) {
      const swissLocation = pickSwissLocation(raw);
      if (!swissLocation) continue; // strict CH-only post-filter

      const jobSeqNo = String(raw.jobSeqNo || '').trim();
      const title = String(raw.title || '').trim();
      if (!jobSeqNo || !title) continue;

      const url = `${JOB_DETAIL_BASE}/${jobSeqNo}/${slugify(title) || 'job'}`;

      listings.push({
        title,
        location: swissLocation,
        rawLocation: pickRealLocationText(raw),
        url,
        applyUrl: raw.applyUrl || raw.externalApply || url,
        postedAt: raw.postedDate || raw.dateCreated || '',
        description: raw.descriptionTeaser || '',
        jobReqId: jobSeqNo,
        category: raw.category || '',
        jobType: raw.jobType || raw.type || '',
        postalCode: raw.postalCode || '',
        address: raw.address || '',
      });
    }

    from += PAGE_SIZE;
  }

  return listings;
}

/**
 * Fetch the FULL structured description for one Givaudan job from its detail page.
 *
 * The Phenom listing widget only carries a short flat `descriptionTeaser`
 * (1-2 sentences, no list structure) — publishing that leaves every job as flat
 * prose with no <ul><li>, which the parser-quality audit flags as a
 * "no structured content" critical. The SSR detail page (the same URL the
 * listing builds) embeds the complete schema.org JobPosting description in a
 * JSON-LD <script>, with real <ul>/<li> bullets and headings (verified live:
 * 5000-8000 chars per job). We extract that HTML and convert it to markdown via
 * the shared htmlToMarkdown so the bullets/headings survive as `- `/`## ` lines.
 *
 * Returns markdown on success, '' on any failure so the caller falls back to the
 * listing teaser (never synthesises content).
 */
async function fetchGivaudanDetailDescription(url) {
  if (!url || !/^https?:\/\//.test(url)) return '';
  try {
    const html = await fetchHtml(url, { timeoutMs: 15000 });
    if (!html) return '';
    const blocks = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    for (const block of blocks) {
      try {
        const data = JSON.parse(block);
        const arr = Array.isArray(data) ? data : [data];
        for (const o of arr) {
          if (String(o?.['@type'] || '').includes('JobPosting') && o.description) {
            // o.description is entity-encoded HTML (e.g. &lt;ul&gt;&lt;li&gt;…);
            // htmlToMarkdown decodes entities and preserves list/heading structure.
            const { markdown } = htmlToMarkdown(String(o.description));
            return markdown || '';
          }
        }
      } catch { /* skip malformed JSON-LD block */ }
    }
  } catch { /* network/timeout → caller falls back to the teaser */ }
  return '';
}

/**
 * Fetch all Givaudan jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllGivaudanJobs() {
  console.log(`🔍 Fetching Givaudan jobs`);
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

    const sourceLocation = normalizeSpace(listing.rawLocation || listing.location || '');
    const geography = resolveSourceBackedSwissGeography(sourceLocation);
    if (!geography) {
      console.warn(`  ⚠️ Givaudan: skipping unresolvable location "${sourceLocation}" (${title})`);
      continue;
    }
    const { location, canton } = geography;
    // Locality = leading city token of the "City, Switzerland" string.
    const addressLocality = normalizeSpace(location.split(',')[0]);
    const publicUrl = listing.url || CAREER_URL;
    const applyUrl = listing.applyUrl || publicUrl;

    if (seen.has(listing.jobReqId || publicUrl)) continue;
    seen.add(listing.jobReqId || publicUrl);

    // Prefer the FULL structured detail-page description (markdown with bullets)
    // over the flat listing teaser. Falls back to the teaser on any fetch failure.
    const detailMarkdown = await fetchGivaudanDetailDescription(publicUrl);
    const descriptionText = detailMarkdown || stripHtml(listing.description || '');

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} givaudan ch`);
    const idBasis = listing.jobReqId || publicUrl;
    const urlHash = createHash('sha1').update(idBasis).digest('hex').slice(0, 12);

    // Normalize postedDate to YYYY-MM-DD when an ISO timestamp is present.
    const postedDate = listing.postedAt
      ? new Date(listing.postedAt).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `givaudan-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: GIVAUDAN_COMPANY_NAME,
      companyKey: GIVAUDAN_KEY,
      companyDomain: GIVAUDAN_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — ${GIVAUDAN_COMPANY_NAME}`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — ${GIVAUDAN_COMPANY_NAME}` },
      location,
      canton,
      url: publicUrl,
      source: 'Givaudan Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality,
      postalCode: listing.postalCode || (addressLocality === HQ.city ? HQ.postalCode : ''),
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: /part.?time|teilzeit/i.test(listing.jobType || '') ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(`${listing.jobType || ''} ${title}`),
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Givaudan jobs discovered: ${jobs.length}`);
  return jobs;
}
