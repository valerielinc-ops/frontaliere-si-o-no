#!/usr/bin/env node
/**
 * Universitäts-Kinderspital Zürich (Kispi) job parser — Prospective.ch career
 * center (white-label HTML at `stellen.kispi-jobs.ch`).
 *
 * Public career site: https://www.kispi.uzh.ch/jobs/offene-stellen
 *   → embeds iframe → https://stellen.kispi-jobs.ch/?lang=de
 *   The iframe is a static HTML listing (one anchor per vacancy under
 *   `/offene-stellen/{slug}/{uuid}`).
 *
 * Detail pages expose a single `schema.org/JobPosting` JSON-LD `<script>` tag
 * with the full canonical fields (title via `<title>`, `description`,
 * `datePosted`, `validThrough`, `jobLocation.address`, `employmentType`,
 * `baseSalary`). We rely on JSON-LD as the source of truth.
 *
 * Note: there's no public JSON listing endpoint — the Prospective backend
 * gates ohws.prospective.ch behind tenant credentials — but the HTML listing
 * is fully server-rendered, so a single GET returns all open vacancies.
 *
 * Kispi has ~3'000 employees and is the largest paediatric hospital in
 * Switzerland (canton Zürich); typically 50+ open positions.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

export const KISPI_KEY = 'kispi';
export const KISPI_COMPANY_NAME = 'Universitäts-Kinderspital Zürich';
export const KISPI_COMPANY_DOMAIN = 'kispi.uzh.ch';

const LISTING_URL = 'https://stellen.kispi-jobs.ch/?lang=de';
const PUBLIC_CAREER_URL = 'https://www.kispi.uzh.ch/jobs/offene-stellen';
const DETAIL_DELAY_MS = 250;

const DEFAULT_CITY = 'Zürich';
const DEFAULT_POSTAL_CODE = '8032';
const DEFAULT_STREET = 'Lenggstrasse 30';

export function isKispiJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return job?.companyKey === KISPI_KEY
    || url.includes('kispi.uzh.ch')
    || url.includes('stellen.kispi-jobs.ch')
    || url.includes('kispi-jobs.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'kispi.uzh.ch'
      || host.endsWith('.kispi.uzh.ch')
      || host === 'kispi-jobs.ch'
      || host.endsWith('.kispi-jobs.ch');
  } catch {
    return false;
  }
}

/**
 * Parse the white-label listing HTML and return all unique vacancy URLs.
 *
 * Anchor shape:
 *   <a href="https://stellen.kispi-jobs.ch/offene-stellen/{slug}/{uuid}">
 */
export function parseKispiListing(html) {
  const out = [];
  const seen = new Set();
  const rx = /href="(https:\/\/stellen\.kispi-jobs\.ch\/offene-stellen\/[^"]+)"/g;
  let m;
  while ((m = rx.exec(html))) {
    const url = m[1];
    const uuidMatch = url.match(/\/([a-f0-9-]{36})(?:\?|#|$)/);
    const uuid = uuidMatch ? uuidMatch[1] : url;
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    out.push({ uuid, url });
  }
  return out;
}

/**
 * Extract the JSON-LD JobPosting block from a detail page.
 * Returns null if missing or unparseable.
 */
function extractJobPostingLd(html) {
  const blocks = [];
  const rx = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = rx.exec(html))) {
    blocks.push(m[1].trim());
  }
  for (const raw of blocks) {
    try {
      const parsed = JSON.parse(raw);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const c of candidates) {
        if (c && (c['@type'] === 'JobPosting' || (Array.isArray(c['@type']) && c['@type'].includes('JobPosting')))) {
          return c;
        }
      }
    } catch {
      // Try a permissive cleanup pass: strip trailing commas
      try {
        const cleaned = raw.replace(/,\s*([}\]])/g, '$1');
        const parsed = JSON.parse(cleaned);
        if (parsed && parsed['@type'] === 'JobPosting') return parsed;
      } catch {
        // give up on this block
      }
    }
  }
  return null;
}

function extractTitleFromHtml(html) {
  // <title>Kinderspital Zürich: {TITLE}</title>
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  const raw = normalizeSpace(decodeEntities(m[1])).replace(/<[^>]+>/g, '');
  return raw.replace(/^Kinderspital\s+Zürich:\s*/i, '').trim();
}

function extractMetaDescription(html) {
  const m = html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/i);
  if (!m) return '';
  return normalizeSpace(decodeEntities(m[1]));
}

function normaliseEmploymentType(raw) {
  if (!raw) return 'full-time';
  const s = String(Array.isArray(raw) ? raw[0] : raw).toUpperCase();
  if (s.includes('PART')) return 'part-time';
  if (s.includes('TEMP') || s.includes('CONTRACT')) return 'contract';
  if (s.includes('INTERN')) return 'internship';
  return 'full-time';
}

async function fetchDetail(url) {
  try {
    const html = await fetchHtml(url);
    if (!html) return null;
    const ld = extractJobPostingLd(html);
    const titleFromHtml = extractTitleFromHtml(html);
    const metaDesc = extractMetaDescription(html);
    return { html, ld, titleFromHtml, metaDesc };
  } catch (err) {
    console.warn(`  ⚠️ detail fetch failed (${url}): ${err?.message || err}`);
    return null;
  }
}

export async function fetchAllKispiJobs() {
  console.log(`🏥 Fetching ${KISPI_COMPANY_NAME} jobs`);
  console.log(`   Listing: ${LISTING_URL}`);
  console.log(`   Public:  ${PUBLIC_CAREER_URL}\n`);

  const listingHtml = await fetchHtml(LISTING_URL);
  const items = parseKispiListing(listingHtml);
  console.log(`  ✓ ${items.length} vacancy URLs parsed from listing`);
  if (!items.length) return [];
  console.log(`  📄 Fetching detail pages for JSON-LD JobPosting payloads...`);

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let ldHits = 0;

  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (i > 0) await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
    const detail = await fetchDetail(it.url);
    if (!detail) continue;
    const ld = detail.ld || {};
    if (detail.ld) ldHits += 1;

    const title = normalizeSpace(decodeEntities(String(ld.title || detail.titleFromHtml || '')));
    if (!title || title.length < 3) continue;

    const descriptionHtml = String(ld.description || '');
    const descriptionText = descriptionHtml
      ? normalizeSpace(htmlToText(descriptionHtml)).slice(0, 6000)
      : detail.metaDesc;
    const description = descriptionText
      || `${title} — ${KISPI_COMPANY_NAME}, Zürich.`;

    const address = (ld.jobLocation && ld.jobLocation.address) || {};
    const city = normalizeSpace(decodeEntities(String(address.addressLocality || DEFAULT_CITY)));
    const street = normalizeSpace(decodeEntities(String(address.streetAddress || DEFAULT_STREET)));
    const postal = String(address.postalCode || DEFAULT_POSTAL_CODE);
    const datePostedRaw = String(ld.datePosted || '').slice(0, 10);
    const datePosted = /^\d{4}-\d{2}-\d{2}$/.test(datePostedRaw) ? datePostedRaw : todayIso;
    const employmentType = normaliseEmploymentType(ld.employmentType);

    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${KISPI_KEY} ${city}`);
    const urlHash = createHash('sha1').update(it.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${KISPI_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KISPI_COMPANY_NAME,
      companyKey: KISPI_KEY,
      companyDomain: KISPI_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band. Without this
      // flag the locale-completeness gate trips before translation can run.
      needsRetranslation: true,
      location: city,
      canton: 'ZH',
      url: it.url,
      source: `${KISPI_COMPANY_NAME} Dedicated Parser (Prospective careercenter HTML)`,
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: city,
      addressRegion: 'ZH',
      addressCountry: 'CH',
      country: 'CH',
      streetAddress: street,
      postalCode: postal,
      category: detectHealthcareCategory(title),
      contract: employmentType === 'part-time' ? 'part-time' : 'full-time',
      employmentType: employmentType === 'full-time'
        ? detectHealthcareEmploymentType(title)
        : employmentType,
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: datePosted,
      applyUrl: it.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(
    `📋 Total ${KISPI_COMPANY_NAME} jobs discovered: ${jobs.length} `
    + `(${ldHits}/${items.length} via JSON-LD)`,
  );
  return jobs;
}

export { LISTING_URL, PUBLIC_CAREER_URL };
