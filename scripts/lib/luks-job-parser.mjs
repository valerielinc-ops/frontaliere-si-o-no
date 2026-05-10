#!/usr/bin/env node
/**
 * Luzerner Kantonsspital (LUKS) job parser — best-effort two-path.
 *
 * Source: https://www.luks.ch/stellen-und-karriere/offene-stellen
 *
 * ⚠️ Status note (2026-05-10): the LUKS Gatsby site
 * (`gatsby-source-silverback` build, Drupal 10 CMS at `cms.luks.ch`) renders
 * the open-positions page with an empty `advertCollection` — i.e. the
 * public site is currently NOT exposing job adverts at all (corroborated
 * by the May newsroom note "Wiedereinführung des JobAbos am Luzerner
 * Kantonsspital"). Until the JobAbo is reinstated this parser will
 * legitimately return [] every run; the crawler treats 0 jobs as
 * non-failure.
 *
 * Strategy:
 *
 *   Path A (preferred): Gatsby page-data walk
 *     GET https://www.luks.ch/page-data/stellen-und-karriere/offene-stellen/page-data.json
 *     and look for an `advertCollection` (or any `*Collection` containing
 *     job-shaped nodes) anywhere in `result.data` / `result.pageContext`.
 *     If found and non-empty, normalise into raw listings.
 *
 *   Path B (fallback): sitemap probe
 *     GET https://www.luks.ch/sitemap-0.xml (or /sitemap.xml) and collect
 *     `/stellen-und-karriere/...` URLs that look like advert detail pages.
 *     Each detail URL has its own page-data.json which is fetched and
 *     parsed for title / location.
 *
 *   Path C (LUKS still without JobAbo): empty array, single info log line.
 *
 * Once LUKS re-introduces public listings and the embedded ATS shape is
 * confirmed (Drupal-baked vs. Prospective / Umantis / SuccessFactors),
 * the matching dedicated adapter should replace this best-effort scraper.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllLuksJobs()  — Fetch and parse all jobs
 *   - isLuksJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()   — Validate URLs belong to this company
 *   - LUKS_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const LUKS_KEY = 'luks';
export const LUKS_COMPANY_NAME = 'Luzerner Kantonsspital (LUKS)';
export const LUKS_COMPANY_DOMAIN = 'luks.ch';

const CAREER_URL = 'https://www.luks.ch/stellen-und-karriere/offene-stellen';
const PAGE_DATA_URL =
  'https://www.luks.ch/page-data/stellen-und-karriere/offene-stellen/page-data.json';
const SITEMAP_CANDIDATES = [
  'https://www.luks.ch/sitemap-0.xml',
  'https://www.luks.ch/sitemap.xml',
];
const FETCH_HEADERS = {
  'User-Agent': 'FrontaliereTicino-Bot/1.0 (+https://frontaliereticino.ch/bot)',
  Accept: 'application/json, text/xml, */*',
};
const FETCH_TIMEOUT_MS = 20_000;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Luzerner Kantonsspital (LUKS).
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isLuksJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === LUKS_KEY ||
    key.startsWith('luks') ||
    company.includes('luzerner kantonsspital (luks)') ||
    url.includes('luks.ch')
  );
}

/**
 * Validate that a URL belongs to Luzerner Kantonsspital (LUKS)'s domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'luks.ch' || host.endsWith('.luks.ch');
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

async function safeFetch(url, { accept = 'json' } = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`   ⚠️ ${url} → HTTP ${res.status}`);
      return null;
    }
    if (accept === 'json') return await res.json();
    return await res.text();
  } catch (err) {
    console.warn(
      `   ⚠️ fetch failed for ${url}: ${err && err.message ? err.message : err}`,
    );
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Walk a Gatsby page-data.json blob (arbitrary tree) for a non-empty
 * `advertCollection` (or any collection of nodes with a `title` field).
 * Returns the array if found, otherwise null.
 */
function findAdvertCollection(node, depth = 0) {
  if (!node || depth > 8) return null;
  if (Array.isArray(node)) {
    if (node.length > 0 && typeof node[0] === 'object' && node[0] && 'title' in node[0]) {
      return node;
    }
    for (const child of node) {
      const found = findAdvertCollection(child, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === 'object') {
    if (Array.isArray(node.advertCollection) && node.advertCollection.length > 0) {
      return node.advertCollection;
    }
    if (Array.isArray(node.nodes) && node.nodes.length > 0 && node.nodes[0]?.title) {
      return node.nodes;
    }
    for (const key of Object.keys(node)) {
      const found = findAdvertCollection(node[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function normaliseAdvertNode(advert) {
  const title = String(advert.title || advert.name || '').trim();
  const location = String(
    advert.location || advert.workLocation || advert.standort || 'Luzern',
  ).trim() || 'Luzern';
  const path = advert.path || advert.url || advert.slug || '';
  const url = path.startsWith('http')
    ? path
    : path
      ? `https://www.luks.ch${path.startsWith('/') ? '' : '/'}${path}`
      : CAREER_URL;
  const description = String(
    advert.description || advert.body?.value || advert.summary || '',
  );
  return { title, location, url, description };
}

/**
 * Path A — Gatsby page-data walk on /offene-stellen.
 */
async function fetchListingsViaPageData() {
  const pageData = await safeFetch(PAGE_DATA_URL, { accept: 'json' });
  if (!pageData) return null; // network/HTTP error → fall through to Path B

  const collection = findAdvertCollection(pageData);
  if (!collection || collection.length === 0) {
    return []; // 200 but empty — JobAbo not yet reinstated
  }
  return collection.map(normaliseAdvertNode).filter((j) => j.title.length >= 3);
}

/**
 * Path B — sitemap probe for /stellen-und-karriere/* detail URLs.
 */
async function fetchListingsViaSitemap() {
  for (const sitemapUrl of SITEMAP_CANDIDATES) {
    const xml = await safeFetch(sitemapUrl, { accept: 'text' });
    if (!xml) continue;

    const locs = Array.from(xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/g)).map(
      (m) => m[1].trim(),
    );
    const advertUrls = locs.filter(
      (u) =>
        /\/stellen-und-karriere\/[^?#]+/.test(u) &&
        !/\/offene-stellen\/?$/.test(u) &&
        !/\/stellen-und-karriere\/?$/.test(u),
    );

    if (advertUrls.length === 0) continue;

    const items = [];
    for (const advertUrl of advertUrls.slice(0, 100)) {
      const path = new URL(advertUrl).pathname.replace(/\/$/, '');
      const pageDataUrl = `https://www.luks.ch/page-data${path}/page-data.json`;
      const pageData = await safeFetch(pageDataUrl, { accept: 'json' });
      if (!pageData) continue;

      const node =
        findAdvertCollection(pageData)?.[0] ||
        pageData?.result?.pageContext?.node ||
        pageData?.result?.data?.advert ||
        pageData?.result?.data?.node;
      if (!node || !node.title) continue;

      items.push(
        normaliseAdvertNode({
          ...node,
          path: node.path || advertUrl,
        }),
      );
      await new Promise((r) => setTimeout(r, 250));
    }
    return items;
  }
  return null;
}

async function fetchJobListings() {
  console.log(`   Fetching from: ${CAREER_URL}`);

  // Path A: Gatsby page-data walk
  const pathA = await fetchListingsViaPageData();
  if (Array.isArray(pathA)) {
    if (pathA.length === 0) {
      console.log(
        '[luks] no advertCollection — JobAbo not yet reinstated, return []',
      );
      return [];
    }
    console.log(`   ✓ Path A (page-data) → ${pathA.length} adverts`);
    return pathA;
  }

  // Path B: sitemap fallback
  const pathB = await fetchListingsViaSitemap();
  if (Array.isArray(pathB) && pathB.length > 0) {
    console.log(`   ✓ Path B (sitemap) → ${pathB.length} adverts`);
    return pathB;
  }

  console.log(
    '[luks] no advertCollection and sitemap probe yielded 0 — JobAbo not yet reinstated, return []',
  );
  return [];
}

/**
 * Fetch all Luzerner Kantonsspital (LUKS) jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllLuksJobs() {
  console.log(`🔍 Fetching Luzerner Kantonsspital (LUKS) jobs`);
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

    const location = listing.location || 'Luzern';
    const canton = inferSwissTargetCanton(location) || 'LU';
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} luks ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `luks-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: LUKS_COMPANY_NAME,
      companyKey: LUKS_KEY,
      companyDomain: LUKS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Luzerner Kantonsspital (LUKS)`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Luzerner Kantonsspital (LUKS)` },
      location,
      canton,
      url: publicUrl,
      source: 'Luzerner Kantonsspital (LUKS) Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(listing.timeType || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Sanità / Ospedali',
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

  console.log(`\n📋 Total Luzerner Kantonsspital (LUKS) jobs discovered: ${jobs.length}`);
  return jobs;
}
