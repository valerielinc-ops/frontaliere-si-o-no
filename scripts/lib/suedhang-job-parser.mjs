#!/usr/bin/env node
/**
 * Klinik Südhang — psychiatric clinic for addiction therapy (Kirchlindach, BE).
 *
 * Public career site: https://www.suedhang.ch/karriere/offene-stellen/
 *
 * Klinik Südhang operates as the Bern-canton specialty hospital for
 * Suchttherapien (addiction therapy / Psychiatrie) in Kirchlindach plus
 * outpatient ambulatori in Bern, Biel, Burgdorf. Listed standalone in the
 * 2026-05 welches-spital inventory (BE, Psichiatria).
 *
 * The careers page is a WordPress site (suedhang.ch is a Tutto Bene Group
 * brand). No third-party ATS — every job is its own permalink under
 * /karriere/offene-stellen/{slug}/ with rich detail content. We scrape the
 * listing index, then fetch each detail page for the description.
 */
import { createHash } from 'node:crypto';
import { slugify } from './crawler-template.mjs';
import {
  decodeEntities,
  fetchHtml,
  htmlToText,
  normalizeSpace,
  detectHealthcareCategory,
  detectHealthcareEmploymentType,
  detectHealthcareExperienceLevel,
} from './hospital-custom-html-helpers.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SUEDHANG_KEY = 'suedhang';
export const SUEDHANG_COMPANY_NAME = 'Klinik Südhang';
export const SUEDHANG_COMPANY_DOMAIN = 'suedhang.ch';

const LISTING_URL = 'https://www.suedhang.ch/karriere/offene-stellen/';
const DETAIL_URL_PREFIX = 'https://www.suedhang.ch/karriere/offene-stellen/';

const POSTAL_CODE_BY_CITY = {
  kirchlindach: '3038',
  bern: '3000',
  biel: '2502',
  bienne: '2502',
  'biel/bienne': '2502',
  burgdorf: '3400',
};

/* ── Company Matchers ──────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

export function isSuedhangJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');
  return (
    key === SUEDHANG_KEY ||
    key.startsWith('suedhang') ||
    company.includes('südhang') ||
    company.includes('suedhang') ||
    url.includes('suedhang.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'suedhang.ch' || host.endsWith('.suedhang.ch');
  } catch {
    return false;
  }
}

/* ── Listing parser ────────────────────────────────────────── */

function parseListing(html = '') {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]*href="(https:\/\/www\.suedhang\.ch\/karriere\/offene-stellen\/[^/"#]+\/)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    if (seen.has(url)) continue;
    if (url.endsWith('/offene-stellen/')) continue;
    seen.add(url);
    const text = normalizeSpace(decodeEntities(m[2].replace(/<[^>]+>/g, ' ')));
    if (!text || text.length < 3) continue;
    out.push({ url, titleHint: text });
  }
  return out;
}

/* ── Detail extraction ─────────────────────────────────────── */

function extractDetail(html = '') {
  if (!html) return { title: '', description: '', location: '', pensum: '' };
  const noScripts = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  // Title from <h1> (or first h2 in main)
  let title = '';
  const h1 = noScripts.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) title = normalizeSpace(decodeEntities(h1[1].replace(/<[^>]+>/g, ' ')));

  // Suedhang uses Gutenberg WP blocks: <div class="content page-content">…</div>
  // wraps the actual body. Slice from there to the next </footer> or the
  // sibling </div> closing the page wrapper — but since the WP HTML has many
  // nested divs, easier: take everything from the `content page-content` opener
  // up to the start of the footer/page-footer.
  let body = noScripts;
  const startMatch = noScripts.match(/<div[^>]*class="content page-content"[^>]*>/i);
  if (startMatch) {
    const startIx = startMatch.index + startMatch[0].length;
    // Find the next "footer-like" tag — sticky-footer / <footer> / sibling page block
    const tail = noScripts.slice(startIx);
    const cutMatch = tail.match(/<footer\b|<div[^>]*class="[^"]*(?:page-footer|site-footer|footer-wrap|cf-footer)/i);
    body = cutMatch ? tail.slice(0, cutMatch.index) : tail;
  } else {
    const mainMatch = noScripts.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
      || noScripts.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
      || noScripts.match(/<div[^>]*class="[^"]*(?:entry-content|content-wrap|page-content)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
    body = mainMatch ? mainMatch[1] : noScripts;
  }

  const text = normalizeSpace(htmlToText(body));

  // Heuristic location + pensum from text (e.g. "Arbeitsort Klinik Südhang, Kirchlindach")
  let location = '';
  const arbeitsortMatch = text.match(/Arbeitsort[: ]+([^.]{3,120}?)(?:\s+Beschäftigungsgrad|\s+Stellenantritt|\s+Pensum|\.|$)/i);
  if (arbeitsortMatch) {
    location = normalizeSpace(arbeitsortMatch[1]).replace(/Klinik Südhang,?\s*/i, '').trim();
  }

  let pensum = '';
  const pensumMatch = text.match(/Beschäftigungsgrad[: ]+([\d\s\-–%]{3,30})/i);
  if (pensumMatch) pensum = normalizeSpace(pensumMatch[1]);

  return {
    title,
    description: text.slice(0, 6000),
    location,
    pensum,
  };
}

/* ── Pensum helper ───────────────────────────────────────── */

function extractPensum(s = '') {
  const rangeMatch = String(s).match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/);
  if (rangeMatch) {
    return { min: parseInt(rangeMatch[1], 10), max: parseInt(rangeMatch[2], 10) };
  }
  const singleMatch = String(s).match(/(\d{2,3})\s*%/);
  if (singleMatch) {
    const val = parseInt(singleMatch[1], 10);
    return { min: val, max: val };
  }
  return null;
}

function postalCodeFor(city = '') {
  const key = normalize(city);
  for (const k of Object.keys(POSTAL_CODE_BY_CITY)) {
    if (key.includes(k)) return POSTAL_CODE_BY_CITY[k];
  }
  return '3038'; // default Kirchlindach
}

/* ── Main Fetch Function ──────────────────────────────────── */

export async function fetchAllSuedhangJobs() {
  console.log(`🏥 Fetching ${SUEDHANG_COMPANY_NAME} jobs`);
  console.log(`   Listing:       ${LISTING_URL}\n`);

  const listingHtml = await fetchHtml(LISTING_URL);
  const tiles = parseListing(listingHtml);
  console.log(`  📋 Listing tiles: ${tiles.length}`);

  const jobs = [];
  const seenUrls = new Set();

  for (const tile of tiles) {
    if (seenUrls.has(tile.url)) continue;
    seenUrls.add(tile.url);

    let detailHtml = '';
    try {
      detailHtml = await fetchHtml(tile.url);
    } catch (err) {
      console.warn(`  ⚠️ detail fetch failed (${tile.url}): ${err?.message || err}`);
    }
    if (jobs.length > 0) await new Promise((r) => setTimeout(r, 350));

    const detail = extractDetail(detailHtml);
    const title = normalizeSpace(detail.title || tile.titleHint);
    if (!title || title.length < 3) continue;

    // Location from detail page, fallback to title hint parsing, then default
    let location = detail.location || '';
    if (!location) {
      const hintCityMatch = tile.titleHint.match(/,\s*([A-ZÄÖÜ][a-zäöü]+(?:\/[A-ZÄÖÜ][a-zäöü]+)?)\s*$/);
      if (hintCityMatch) location = hintCityMatch[1];
    }
    if (!location) location = 'Kirchlindach';

    const sourceLang = 'de';
    const jobSlug = slugify(`${title} ${SUEDHANG_KEY} ch`);
    const urlHash = createHash('sha1').update(tile.url).digest('hex').slice(0, 12);

    const pensumSource = `${detail.pensum} ${title}`;
    const pensum = extractPensum(pensumSource);
    const employmentType = detectHealthcareEmploymentType(pensumSource);
    const contract = pensum && pensum.max < 80 ? 'part-time' : 'full-time';

    const fallbackDesc = `${title} — ${SUEDHANG_COMPANY_NAME}, ${location}. Klinik für Suchttherapien.`;
    const description = detail.description && detail.description.split(/\s+/).length >= 30
      ? detail.description
      : fallbackDesc;

    const job = {
      id: `${SUEDHANG_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SUEDHANG_COMPANY_NAME,
      companyKey: SUEDHANG_KEY,
      companyDomain: SUEDHANG_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location,
      canton: 'BE',
      url: tile.url,
      source: `${SUEDHANG_COMPANY_NAME} Dedicated Parser (custom HTML)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      postalCode: postalCodeFor(location),
      addressCountry: 'CH',
      country: 'CH',
      category: detectHealthcareCategory(title),
      contract,
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: tile.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (pensum) {
      job.pensumMin = pensum.min;
      job.pensumMax = pensum.max;
      job.pensum = pensum.min === pensum.max ? `${pensum.min}%` : `${pensum.min} - ${pensum.max}%`;
    }

    jobs.push(job);
  }

  console.log(`\n📋 Total ${SUEDHANG_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
