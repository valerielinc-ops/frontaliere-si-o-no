#!/usr/bin/env node
/**
 * Holcim Group job parser — Fetcher and job builder.
 *
 * Source: https://careers.holcimgroup.com/search/
 *
 * ISSUE #3797 FALSE-NEGATIVE FIX: the previous parser pointed the shared
 * `successfactors-client.mjs` at `career2.successfactors.eu/career?company=
 * holcimgrou` — the classic SAP UI5 "Recruiting Marketing" search widget.
 * That page's listing index is populated by an `AjaxService`/`ASProxy` call
 * gated behind a per-session CSRF-style token (`_s.crb`, tied to the page's
 * own `jsessionid`) — genuinely not fetchable without executing the page's
 * JS, which is exactly why the shared client's `html-career` branch bails
 * out with "listing index requires Playwright" and the crawler always
 * returned 0 jobs.
 *
 * However, Holcim's OWN public-facing career site (`careers.holcimgroup.com`)
 * is a DIFFERENT, newer SAP SuccessFactors "Career Site Builder" tenant that
 * (unlike Oerlikon's CSB tenant) still fully server-renders its search
 * results — `careers.holcimgroup.com/search/?locationsearch=Switzerland`
 * returns "Showing 1 to 25 of 34 Jobs" directly in the raw HTML (34 exactly
 * matches the evidence), no Playwright needed at all. The `locationsearch`
 * query param does a genuine server-side filter (confirmed: unfiltered
 * `/search/` reports 410 jobs; `Switzerland`-filtered reports 34).
 *
 * Listing markup is a newer "tile" skin of the Jobs2Web family: each job is
 * rendered 3x (desktop/tablet/mobile responsive variants), so results must
 * be de-duplicated by URL. Location lives in a single field per tile
 * (labelled "Other Locations" in the DOM, but it is in fact the job's own
 * location — this tenant has no separate primary-location field):
 *   <a class="jobTitle-link" href="/job/{slug}/">​{title}</a>
 *   ...-multilocation-value">{City}[, {Canton}], {CountryCode}, {Postal}</div>
 * Pagination via `&startrow=N` (25 rows/page), same as Benteler/Constellium.
 *
 * Detail pages carry schema.org microdata (`itemprop="streetAddress"
 * content="{City}, CH, {Postal}"`, `itemprop="datePosted"`) plus a
 * `<span class="jobdescription">...</span>` description block ending before
 * a `<p id="job-location" ...>` marker — same description-extraction pattern
 * as Benteler/Constellium, just a differently-attributed closing `<p>` tag.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllHolcimJobs()  — Fetch and parse all jobs
 *   - isHolcimJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const HOLCIM_KEY = 'holcim';
export const HOLCIM_COMPANY_NAME = 'Holcim Group';
export const HOLCIM_COMPANY_DOMAIN = 'holcim.com';

const CAREER_HOST = 'careers.holcimgroup.com';
const CAREER_URL = `https://${CAREER_HOST}/search/?locationsearch=Switzerland&locale=en_US`;
const PAGE_SIZE = 25;
const MAX_PAGES = 20; // safety cap (500 rows) — real board is ~34 CH jobs

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Holcim Group.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isHolcimJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === HOLCIM_KEY ||
    key.startsWith('holcim') ||
    company.includes('holcim') ||
    url.includes('holcim.com') ||
    url.includes('holcimgroup.com')
  );
}

/**
 * Validate that a URL belongs to Holcim Group's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'holcim.com' ||
      host.endsWith('.holcim.com') ||
      host === 'careers.holcimgroup.com' ||
      host.endsWith('.holcimgroup.com')
    );
  } catch {
    return false;
  }
}

/**
 * Parse the "{City}[, {Canton}], {CountryCode}, {Postal}" location string
 * this tenant returns (e.g. "Zug, CH, 6300" or "Oberdorf, NW, CH, 6370").
 * Country-code-first, same collision-safe pattern used for Benteler/
 * Constellium: canton codes are NOT globally unique (e.g. Swiss "NW" =
 * Nidwalden vs. German "NW" = Nordrhein-Westfalen), so only trust an
 * explicit trailing country token, never a bare canton-looking token alone.
 */
function parseHolcimLocation(raw = '') {
  // Strip soft hyphens (U+00AD) — seen glued onto a postal code in at
  // least one real listing ("Zurich, CH, CH-­8050"), which otherwise
  // breaks a naive "is the last token purely numeric" postal-code check.
  const cleaned = String(raw || '').replace(/­/g, '');
  const parts = cleaned.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { city: '', canton: '', country: '' };
  const city = parts[0];
  const tail = parts.slice(1);
  const last = tail[tail.length - 1] || '';

  // Country: look for an exact "CH" token anywhere after the city (position
  // varies: "City, CH, Postal" vs "City, Canton, CH, Postal"), plus a guard
  // for the postal-token-absorbed-country case above ("CH-8050").
  const country = tail.some((p) => /^CH$/i.test(p)) || /^CH-/i.test(last) ? 'CH' : '';

  // Canton: only trust a genuine 2-letter Swiss canton CODE (never a full
  // canton NAME like "St. Gallen" or a misspelled one like "Shaffhausen" —
  // both seen on this tenant — and never the "CH" token itself). Anything
  // else is left for inferAnyCanton(city) to resolve by city name.
  const middle = tail.slice(0, -1);
  const explicitCanton = middle.find((p) => /^[A-Z]{2}$/.test(p) && p.toUpperCase() !== 'CH') || '';

  return { city, canton: explicitCanton.toUpperCase(), country };
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install|installateur)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse|chauffeur|lastwagenführer|matros)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur|baumaschin|betriebsstoff)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ|debitoren|cash)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|manager)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Holcim titles commonly carry a workload-percentage suffix
 * (e.g. "80-100%", "60-70%") rather than a plain part-time/full-time label.
 */
function detectEmploymentType(title = '') {
  const pctMatch = title.match(/\((\d{1,3})\s*(?:-\s*(\d{1,3})\s*)?%\)|(\d{1,3})\s*(?:-\s*(\d{1,3})\s*)?%/);
  if (pctMatch) {
    const nums = [pctMatch[1], pctMatch[2], pctMatch[3], pctMatch[4]].filter(Boolean).map(Number);
    if (nums.length && Math.max(...nums) < 100) return 'PART_TIME';
    if (nums.length) return 'FULL_TIME';
  }
  const t = normalize(title);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Fetch + Parse (Jobs2Web "tile" search + detail pages) ───── */

/**
 * Parse one search-results page: extract unique job tiles (each tile is
 * rendered 3x for responsive breakpoints, so de-dupe by href) plus the
 * "Showing X to Y of Z Jobs" total for pagination bookkeeping.
 */
export function parseSearchPage(html = '') {
  // Collect every tile-link occurrence (each job tile is rendered up to 3x
  // for responsive breakpoints) and every location block WITH their byte
  // offsets, then attribute by DOCUMENT POSITION: a tile's location is the
  // first "-multilocation-value" block that appears after that tile and
  // before the next tile. This makes no assumption about a fixed/uniform
  // render ratio between location blocks and tiles (the previous
  // `locs[i * floor(locs/rows)]` indexing silently misattributed every
  // location as soon as one job rendered a different number of location
  // blocks — e.g. a genuinely multi-location posting).
  const tileHits = [];
  const tileRx = /class="jobTitle-link[^"]*"[^>]*href="([^"]+)"[^>]*>\s*([^<]*?)\s*</g;
  let m;
  while ((m = tileRx.exec(html)) !== null) {
    tileHits.push({ href: m[1], title: normalizeSpace(m[2]), index: m.index });
  }

  const locHits = [];
  const locRx = /-multilocation-value">([^<]*)/g;
  let lm;
  while ((lm = locRx.exec(html)) !== null) {
    locHits.push({ text: normalizeSpace(lm[1]), index: lm.index });
  }

  const rows = [];
  const byHref = new Map();
  let locPtr = 0;
  for (let t = 0; t < tileHits.length; t += 1) {
    const tile = tileHits[t];
    const nextTileIndex = t + 1 < tileHits.length ? tileHits[t + 1].index : Infinity;
    // Advance to the first location block at/after this tile...
    while (locPtr < locHits.length && locHits[locPtr].index < tile.index) locPtr += 1;
    // ...and only claim it if it belongs to THIS tile (before the next one).
    const locationText = (locPtr < locHits.length && locHits[locPtr].index < nextTileIndex)
      ? locHits[locPtr].text
      : '';

    const existing = byHref.get(tile.href);
    if (existing) {
      // Duplicate responsive copy of an already-seen tile: use it only to
      // backfill a location the first copy was missing.
      if (!existing.locationText && locationText) existing.locationText = locationText;
      continue;
    }
    const row = { href: tile.href, title: tile.title, locationText };
    byHref.set(tile.href, row);
    rows.push(row);
  }

  const rowsWithoutLocation = rows.filter((r) => !r.locationText).length;
  if (rows.length > 0 && rowsWithoutLocation > 0) {
    console.warn(`⚠️ Holcim search page: ${rowsWithoutLocation}/${rows.length} job tiles have no adjacent location block — page markup may have drifted.`);
  }

  const totalMatch = html.match(/Showing\s+\d+\s+to\s+\d+\s+of\s+(\d+)\s+Jobs/i);
  const total = totalMatch ? Number(totalMatch[1]) : 0;

  return { rows, total };
}

/**
 * Fetch every page of the Switzerland-filtered search results.
 */
async function listSwissJobs() {
  const allRows = [];
  let expectedTotal = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const startrow = page * PAGE_SIZE;
    const pageUrl = startrow === 0 ? CAREER_URL : `${CAREER_URL}&startrow=${startrow}`;
    let html;
    try {
      html = await fetchHtml(pageUrl, { timeoutMs: 20000 });
    } catch (err) {
      if (page === 0) console.warn(`⚠️ Failed to fetch Holcim search page: ${err.message}`);
      break;
    }
    const { rows, total } = parseSearchPage(html);
    if (page === 0) expectedTotal = total;
    if (rows.length === 0) break;
    allRows.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    if (expectedTotal > 0 && allRows.length >= expectedTotal) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`  🎯 Swiss-filtered jobs found: ${allRows.length}`);
  return allRows;
}

/**
 * Fetch and parse a job detail page for its description + posted date.
 * Description sits in a `<span class="jobdescription">...</span>` block
 * that ends right before the `<p id="job-location" ...>` marker.
 */
async function fetchJobDetail(detailUrl) {
  let html;
  try {
    html = await fetchHtml(detailUrl, { timeoutMs: 20000 });
  } catch (err) {
    console.warn(`⚠️ Detail fetch failed for ${detailUrl}: ${err.message}`);
    return null;
  }

  const descStart = html.indexOf('<span class="jobdescription">');
  const descEnd = html.indexOf('<p id="job-location"');
  const descriptionHtml = descStart >= 0 && descEnd > descStart
    ? html.slice(descStart, descEnd)
    : '';

  const dateM = html.match(/itemprop="datePosted"\s+content="([^"]+)"/);
  let postedDate = '';
  if (dateM) {
    const d = new Date(dateM[1]);
    if (!Number.isNaN(d.getTime())) postedDate = d.toISOString().slice(0, 10);
  }

  return { descriptionHtml, postedDate };
}

/**
 * Fetch all Holcim Group jobs (Switzerland-filtered via the search page's
 * own `locationsearch` server-side filter).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllHolcimJobs() {
  console.log(`🔍 Fetching ${HOLCIM_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await listSwissJobs();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Holcim Group job listings found.');
    return [];
  }

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const publicUrl = new URL(listing.href, `https://${CAREER_HOST}/`).toString();
    console.log(`  📄 Fetching detail: ${title}`);
    const detail = await fetchJobDetail(publicUrl);

    // Server-side `locationsearch=Switzerland` already filters the board, so
    // we trust every listing here is Swiss (same as Constellium/Oerlikon);
    // parseHolcimLocation() only ever resolves an explicit "CH" or "" for
    // `country` (never a foreign code), so it's not used as an admission
    // gate here — only city/canton extraction.
    const { city, canton: explicitCanton } = parseHolcimLocation(listing.locationText || '');

    const location = city || 'Zug';
    const canton = explicitCanton || inferAnyCanton(location) || 'ZG';
    const descriptionText = detail ? stripHtml(detail.descriptionHtml || '') : '';
    const description = descriptionText || `${title} — ${HOLCIM_COMPANY_NAME} a ${location}.`;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} holcim ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(title);

    const job = {
      // ── Required fields ──
      id: `holcim-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: HOLCIM_COMPANY_NAME,
      companyKey: HOLCIM_KEY,
      companyDomain: HOLCIM_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Holcim Group Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Materiali da costruzione / Cemento',
      currency: 'CHF',
      featured: false,
      postedDate: (detail && detail.postedDate) || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300)); // Rate limiting
  }

  console.log(`\n📋 Total ${HOLCIM_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
