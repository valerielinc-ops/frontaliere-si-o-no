#!/usr/bin/env node
/**
 * Sonova job parser — Fetcher and job builder.
 *
 * Source: https://jobs.sonova.com/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSonovaJobs()  — Fetch and parse all jobs
 *   - isSonovaJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { parseSuccessFactorsPostedDate } from './ats-clients/successfactors-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SONOVA_KEY = 'sonova';
export const SONOVA_COMPANY_NAME = 'Sonova';
export const SONOVA_COMPANY_DOMAIN = 'sonova.com';

const CAREER_URL = 'https://jobs.sonova.com/';
// SuccessFactors RMK (Career Site Builder / jobs2web) HTML feed. The whole
// instance is the Sonova group; the location filter narrows to CH, but RMK
// falls back to ALL countries once startrow exceeds the filtered count, so we
// hard-filter client-side against the CH guard list below.
const TILE_SEARCH_URL = 'https://jobs.sonova.com/tile-search-results/';
const ATS_HOST = 'jobs.sonova.com';
const PAGE_SIZE = 25;
const MAX_PAGES = 12;
const SECTOR = 'MedTech / Hearing care (hearing aids, cochlear implants, consumer hearing)';

// HQ fallback (Laubisrütistrasse 28, 8712 Stäfa, ZH) — used when a job tile
// carries no city we can map.
const HQ_LOCALITY = 'Stäfa';
const HQ_CANTON = 'ZH';
const HQ_POSTAL = '8712';
const HQ_REGION = 'Zürich';

// Client-side Switzerland guard (RMK leaks foreign jobs past the filtered
// result count — recon observed Berlin/Cahors/Warszawa at startrow=50).
const CH_GUARD = [
  'switzerland', 'schweiz', 'suisse', 'svizzera',
  'stäfa', 'staefa', 'murten', 'zürich', 'zurich', 'lugano',
  'genève', 'geneve', 'geneva', 'bern', 'basel', 'lausanne',
];

const CRAWLER_UA =
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
 * Check if a job belongs to Sonova.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isSonovaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SONOVA_KEY ||
    key.startsWith('sonova') ||
    company.includes('sonova') ||
    url.includes('sonova.com')
  );
}

/**
 * Validate that a URL belongs to Sonova's domain.
 * Accepts the primary domain (and subdomains) AND the real job-posting host
 * (jobs.sonova.com, a subdomain of sonova.com — covered by the endsWith check),
 * keeping the test's primary-domain expectations green.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'sonova.com' ||
      host.endsWith('.sonova.com') || // includes jobs.sonova.com ATS host
      host === 'rmkcdn.successfactors.com' ||
      host.endsWith('.successfactors.com') ||
      host.endsWith('.successfactors.eu')
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

/* ── SuccessFactors RMK (jobs2web) HTML fetcher ────────────────
 * jobs.sonova.com runs SuccessFactors Recruiting Marketing / Career Site
 * Builder (jobs2web). detectSuccessFactorsKind() does not recognise the
 * branded host, and there is no CXS/OData JSON, so we scrape the documented
 * /tile-search-results/ HTML listing directly (location=Switzerland), then
 * enrich each /job/{slug}/{id}/ detail page (schema.org microdata) for the
 * posted date + description.
 */

function decodeEntities(s = '') {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function isSwissLocation(loc = '') {
  const l = normalize(loc);
  return CH_GUARD.some((g) => l.includes(g));
}

/**
 * Parse one /tile-search-results/ page into raw listing rows.
 * Each tile carries: data-url="/job/{slug}/{id}/", a jobTitle-link anchor,
 * and an sr-only "Location" label followed by the location text.
 * @returns {Array<{title:string, location:string, url:string, jobReqId:string}>}
 */
function parseTilePage(html = '') {
  if (!html) return [];
  const rows = [];
  const seen = new Set();
  // Tiles repeat per breakpoint (desktop/tablet/mobile) — dedupe by job id.
  const tileRe = /data-url="(\/job\/[^"]+\/(\d+)\/?)"/gi;
  let m;
  while ((m = tileRe.exec(html)) !== null) {
    const jobReqId = m[2];
    if (seen.has(jobReqId)) continue;
    seen.add(jobReqId);
    const relUrl = decodeEntities(m[1]);
    const url = new URL(relUrl, TILE_SEARCH_URL).toString();

    // Slice the tile block so title/location regexes don't cross into siblings.
    const blockStart = m.index;
    const next = html.indexOf('data-url="/job/', m.index + m[0].length);
    const block = html.slice(blockStart, next === -1 ? blockStart + 4000 : next);

    const titleM = block.match(/<a[^>]*class="[^"]*jobTitle-link[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const title = titleM
      ? normalizeSpace(decodeEntities(titleM[1].replace(/<[^>]+>/g, ' ')))
      : '';
    if (!title) continue;

    // RMK markup: <span ...>Location</span> ... <div id="job-{id}-...-location-value">TEXT</div>
    const locM =
      block.match(/id="[^"]*location-value"[^>]*>([\s\S]*?)<\/div>/i) ||
      block.match(/Location\s*<\/span>\s*<(?:span|div)[^>]*>([\s\S]*?)<\/(?:span|div)>/i);
    const location = locM
      ? normalizeSpace(decodeEntities(locM[1].replace(/<[^>]+>/g, ' ')))
      : '';

    rows.push({ title, location, url, jobReqId });
  }
  return rows;
}

/**
 * Fetch a detail page and pull schema.org microdata: posted date +
 * description. Best-effort — returns {} on any failure.
 */
async function fetchJobDetail(url) {
  let html;
  try {
    html = await fetchHtml(url, { headers: { 'User-Agent': CRAWLER_UA } });
  } catch (err) {
    console.warn(`   ⚠️ detail fetch failed (${url}): ${err?.message || err}`);
    return {};
  }
  if (!html) return {};

  const dateM = html.match(/itemprop="datePosted"[^>]*content="([^"]+)"/i);
  const postedDate = dateM
    ? parseSuccessFactorsPostedDate(dateM[1]) || null
    : null;

  let description = '';
  const descM = html.match(/<span class="jobdescription"[^>]*>/i);
  if (descM) {
    const start = descM.index + descM[0].length;
    const rest = html.slice(start);
    // Cut at the share/apply chrome region (CSB display containers).
    let end = rest.search(/data-careersite-propertyid|class="[^"]*displayDTM|<div class="row apply/i);
    const body = end !== -1 ? rest.slice(0, end) : rest.slice(0, 8000);
    description = body;
  }

  const empM = html.match(/itemprop="employmentType"[^>]*content="([^"]+)"/i);
  return {
    postedDate,
    descriptionHtml: description,
    employmentTypeHint: empM ? empM[1] : '',
  };
}

async function fetchJobListings() {
  const all = [];
  const seen = new Set();
  for (let page = 0; page < MAX_PAGES; page++) {
    const startrow = page * PAGE_SIZE;
    const url = `${TILE_SEARCH_URL}?q=&location=Switzerland&startrow=${startrow}`;
    let html;
    try {
      html = await fetchHtml(url, { headers: { 'User-Agent': CRAWLER_UA } });
    } catch (err) {
      console.error(`❌ listing fetch failed (startrow=${startrow}): ${err?.message || err}`);
      break;
    }
    const rows = parseTilePage(html);
    if (rows.length === 0) {
      // Fetch succeeded but parsed to zero rows — could be genuine EOF or a
      // challenge/error page rendered with a 200 status. Warn so a sustained
      // pattern is visible, since we can't tell the two apart here.
      console.warn(`   ⚠️ Sonova: page ${page} (startrow=${startrow}) parsed 0 rows — treating as end of pagination.`);
      break;
    }

    // RMK leaks non-CH jobs once startrow exceeds the filtered count → stop
    // paginating as soon as a page yields zero CH-city tiles (recon guidance).
    const chRows = rows.filter((r) => isSwissLocation(r.location));
    if (chRows.length === 0) break;

    let added = 0;
    for (const r of chRows) {
      if (seen.has(r.jobReqId)) continue;
      seen.add(r.jobReqId);
      all.push(r);
      added++;
    }
    if (added === 0) break;
    if (rows.length < PAGE_SIZE) break;
  }

  // Enrich each listing with detail-page date + description.
  for (const listing of all) {
    const detail = await fetchJobDetail(listing.url);
    Object.assign(listing, detail);
    await new Promise((r) => setTimeout(r, 200));
  }
  return all;
}

/**
 * Fetch all Sonova jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllSonovaJobs() {
  console.log(`🔍 Fetching Sonova jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    // Location string from the tile (e.g. "Staefa, Switzerland" / "Murten, Switzerland").
    const rawLocation = normalizeSpace(listing.location || '');
    if (rawLocation && !isSwissLocation(rawLocation)) continue; // CH guard

    // City = first comma-segment ("Staefa"); fall back to HQ.
    const city = rawLocation
      ? normalizeSpace(rawLocation.split(',')[0]) || HQ_LOCALITY
      : HQ_LOCALITY;
    const location = rawLocation || `${HQ_LOCALITY}, Switzerland`;
    const canton = inferSwissTargetCanton(location) || inferSwissTargetCanton(city) || HQ_CANTON;

    const descriptionHtml = listing.descriptionHtml || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;
    // RMK apply endpoint per recon: /talentcommunity/apply/{jobId}/?locale=en_US
    const applyUrl = listing.jobReqId
      ? `https://${ATS_HOST}/talentcommunity/apply/${listing.jobReqId}/?locale=en_US`
      : publicUrl;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const description = descriptionText || `${title} — ${SONOVA_COMPANY_NAME}`;
    const jobSlug = slugify(`${title} sonova ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `sonova-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SONOVA_COMPANY_NAME,
      companyKey: SONOVA_KEY,
      companyDomain: SONOVA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Sonova Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      postalCode: city === HQ_LOCALITY ? HQ_POSTAL : undefined,
      addressRegion: canton === HQ_CANTON ? HQ_REGION : undefined,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      employmentType: detectEmploymentType(listing.employmentTypeHint || descriptionText || title),
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate || new Date().toISOString().split('T')[0],
      applyUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Sonova jobs discovered: ${jobs.length}`);
  return jobs;
}
