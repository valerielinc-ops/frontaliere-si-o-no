#!/usr/bin/env node
/**
 * Kudelski NAGRA job parser — Fetcher and job builder.
 *
 * Source: https://careers.nagra.com/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllKudelskiNagraJobs()  — Fetch and parse all jobs
 *   - isKudelskiNagraJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { resolveFallbackAddress } from '../../build-plugins/shared/companyHqAddresses.ts';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace as _normalizeSpace, fetchHtml, fetchJson } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import { isTargetSwissLocation, isSwissLocationText, inferAnyCanton } from './target-swiss-locations.mjs';
import { assertJsonListShapeMultiKey } from './assert-json-list-shape.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const KUDELSKI_NAGRA_KEY = 'kudelski-nagra';
export const KUDELSKI_NAGRA_COMPANY_NAME = 'Kudelski NAGRA';
export const KUDELSKI_NAGRA_COMPANY_DOMAIN = 'nagra.com';

const CAREER_URL = 'https://careers.nagra.com/';
const BASE_URL = 'https://careers.nagra.com';
// The listing page lives under the `?page=advertisement` route of the
// in-house ATS — the bare CAREER_URL root has no job table (issue #3797).
const ADVERTISEMENT_URL = 'https://careers.nagra.com/?page=advertisement';

/**
 * Kudelski/NAGRA uses Greenhouse for recruitment. Greenhouse provides
 * a public JSON API for job boards.
 */
const GH_BOARDS_API = 'https://boards-api.greenhouse.io/v1/boards/kudelski/jobs';
const GH_BOARDS_DETAIL = 'https://boards-api.greenhouse.io/v1/boards/kudelski/jobs';
const GH_PUBLIC_BASE = 'https://careers.nagra.com';
const COMPANY_DEFAULTS = getCompanyDefaults(KUDELSKI_NAGRA_KEY);

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Kudelski NAGRA.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isKudelskiNagraJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === KUDELSKI_NAGRA_KEY ||
    key.startsWith('kudelski-nagra') ||
    company.includes('kudelski nagra') ||
    url.includes('nagra.com')
  );
}

/**
 * Validate that a URL belongs to Kudelski NAGRA's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'nagra.com' || host.endsWith('.nagra.com');
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
 * Fetch jobs from Greenhouse Boards API.
 * Greenhouse provides a public JSON API for job boards.
 * The board slug may be 'kudelski', 'nagra', 'kudelskigroup', etc.
 */
async function tryGreenhouseApi() {
  const boardSlugs = ['kudelski', 'nagra', 'kudelskigroup', 'kudelski-group'];

  for (const board of boardSlugs) {
    const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`;
    try {
      console.log(`   Trying Greenhouse API: ${apiUrl}`);
      const data = await fetchJson(apiUrl, { timeoutMs: 15000 });
      const items = assertJsonListShapeMultiKey(data, {
        keys: ['jobs'],
        allowBareArray: true,
        source: KUDELSKI_NAGRA_KEY,
      });
      if (items.length > 0) {
        console.log(`   Greenhouse API (board: ${board}) returned ${items.length} jobs`);
        return { items, board };
      }
    } catch (err) {
      console.log(`   Greenhouse board '${board}' failed: ${err.message}`);
    }
  }
  return null;
}

/**
 * Parse the careers.nagra.com HTML page for job listings.
 * If not Greenhouse, try generic HTML scraping.
 */
/**
 * Parse careers.nagra.com's `?page=advertisement` listing table.
 * Markup is a plain server-rendered <table> — no auth/JS execution needed:
 *   <tr class="table-primary ...">
 *     <td>{id}</td><td>{date DD-MM-YYYY}</td>
 *     <td><a href="?page=advertisement_display&id={id}">{Title}.</a></td>
 *     <td>{Contract type}</td><td>{Location}</td><td>{Entity}</td>
 *     <td><a ...>Apply</a></td>
 *   </tr>
 * (issue #3797 — the old CAREER_URL root has no job table at all; the real
 * data lives under this `?page=advertisement` route.)
 */
function parseNagraAdvertisementTable(html = '') {
  if (!html) return [];
  const jobs = [];
  const rowRx = /<tr class="table-primary\s*">([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRx.exec(html))) {
    const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    if (cells.length < 6) continue;

    const [, dateRaw, titleCell, contractTypeRaw, locationRaw, entityRaw] = cells;
    const idMatch = titleCell.match(/id=(\d+)/);
    const title = normalizeSpace(stripHtml(titleCell)).replace(/\.$/, '');
    if (!title || !idMatch) continue;

    const [, d, m, y] = dateRaw.match(/(\d{2})-(\d{2})-(\d{4})/) || [];
    const postedDate = d ? `${y}-${m}-${d}` : '';
    const contractType = normalizeSpace(stripHtml(contractTypeRaw));
    const entity = normalizeSpace(stripHtml(entityRaw));
    // The listing table has no free-text description (only Kudelski/id/date/
    // contract/location/entity columns) — build a description long enough to
    // clear the quality gate's 80-char floor instead of leaving it thin
    // enough to get quarantined as a suspected crawl bug (issue #3797).
    const description = (contractType || entity)
      ? `${contractType || 'Open position'} at ${entity || 'Kudelski NAGRA'}, part of the Kudelski Group — a global leader in digital security and content protection technology.`
      : '';

    jobs.push({
      title,
      url: `${BASE_URL}/?page=advertisement_display&id=${idMatch[1]}`,
      location: normalizeSpace(stripHtml(locationRaw)),
      description,
      postedDate,
    });
  }
  return jobs;
}

/**
 * Check whether a posting belongs to any Swiss canton.
 */
function isSwissLocation(location = '') {
  const loc = normalizeSpace(location);
  return Boolean(loc) && isTargetSwissLocation(loc, { includeBorderProximity: false });
}

function isSwissListingCandidate(location = '') {
  const loc = normalizeSpace(location);
  if (!loc) return false;
  // The listing table sometimes exposes only the country. Keep that source
  // candidate long enough to resolve its actual city from the detail page;
  // the publish gate below still requires isTargetSwissLocation + a canton.
  return isSwissLocation(loc) || (isSwissLocationText(loc) && !inferAnyCanton(loc));
}

function extractDetailLocation(html = '') {
  if (!html) return '';
  const labelled = [
    /<(?:strong|b)[^>]*>\s*(?:location|work\s+location|lieu\s+de\s+travail|arbeitsort)\s*:?\s*<\/(?:strong|b)>\s*([^<]+)/i,
    /<label[^>]*>\s*(?:location|work\s+location|lieu\s+de\s+travail|arbeitsort)\s*:?\s*<\/label>\s*<span[^>]*>([\s\S]*?)<\/span>/i,
  ];
  for (const pattern of labelled) {
    const match = html.match(pattern);
    const location = normalizeSpace(stripHtml(match?.[1] || ''));
    if (location) return location;
  }
  return '';
}

/** Title of a raw listing, whatever shape the source used for it. */
function listingTitle(listing) {
  return normalizeSpace(listing?.title || listing?.name || '');
}

/**
 * Fetch all Kudelski NAGRA jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Strategy:
 *  1. Try Greenhouse Boards API with multiple board slugs
 *  2. Fall back to HTML scraping of careers.nagra.com
 *  3. Filter for Swiss locations across all 26 cantons
 */
export async function fetchAllKudelskiNagraJobs() {
  console.log(`🔍 Fetching Kudelski NAGRA jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  let listings = [];
  let ghBoard = '';

  // Strategy 1: Greenhouse API
  const ghResult = await tryGreenhouseApi();
  if (ghResult) {
    listings = ghResult.items;
    ghBoard = ghResult.board;
  }

  // Strategy 2: HTML scraping of the advertisement listing table
  if (!listings || listings.length === 0) {
    console.log('   Greenhouse API did not return jobs, trying HTML scraping...');
    try {
      const html = await fetchHtml(ADVERTISEMENT_URL, { timeoutMs: 20000 });
      listings = parseNagraAdvertisementTable(html);
      console.log(`   HTML scraping found ${listings?.length || 0} job links`);
    } catch (err) {
      console.warn(`   HTML fetch failed: ${err.message}`);
      listings = [];
    }
  }

  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Kudelski NAGRA job listings found.');
    return [];
  }

  // Filter for Swiss locations across the full canton set.
  const swissListings = listings.filter((l) => {
    const loc = l.location?.name || l.location || l.city || '';
    return isSwissListingCandidate(typeof loc === 'string' ? loc : loc?.name || '');
  });

  console.log(`  📋 Total listings: ${listings.length}, Swiss-filtered: ${swissListings.length}`);

  // Candidates that cleared every NON-geographic gate the loop below applies
  // (only the title gate), counted over the UNfiltered listings so the number
  // stays pre-geographic — see the note next to `discoveredCount`.
  const titleEligible = listings.filter((l) => listingTitle(l).length >= 3).length;

  const jobs = [];
  for (const listing of swissListings) {
    const title = listingTitle(listing);
    if (title.length < 3) continue;

    // Greenhouse returns location as { name: "..." } or a string.
    const rawLoc = listing.location?.name || listing.location || listing.city || '';
    let location = normalizeSpace(typeof rawLoc === 'string' ? rawLoc : rawLoc?.name || '');

    // The NAGRA table currently gives some Swiss offers only as
    // "Switzerland". Resolve the city from the official detail page instead
    // of inventing a headquarters canton (the old code stamped these TI).
    if (!isSwissLocation(location)) {
      const detailUrl = listing.absolute_url || listing.url || listing.link || '';
      if (isTrustedDomain(detailUrl)) {
        try {
          const detailHtml = await fetchHtml(detailUrl, { timeoutMs: 20000 });
          const detailLocation = extractDetailLocation(detailHtml);
          if (detailLocation) location = detailLocation;
        } catch (err) {
          console.warn(`  ⚠️ Kudelski NAGRA: detail fetch failed for ${title}: ${err.message}`);
        }
      }
    }

    const canton = inferAnyCanton(location);
    if (!location || !canton) {
      console.warn(`  ⚠️ Kudelski NAGRA: skipping unresolvable Swiss location "${location || '(empty)'}" (${title})`);
      continue;
    }

    // Keep source address data when present; otherwise resolve a complete
    // same-canton fallback from the posting location. The company default is
    // only eligible when its canton agrees with the derived canton, so a
    // posting outside the historical Lugano HQ cannot inherit TI/6900.
    const addressLocality = normalizeSpace(
      location.replace(/,?\s*(?:Switzerland|Schweiz|Suisse|Svizzera)$/i, ''),
    );
    const fallbackAddress = resolveFallbackAddress(
      KUDELSKI_NAGRA_KEY,
      addressLocality || (COMPANY_DEFAULTS?.canton === canton ? COMPANY_DEFAULTS.city : ''),
      canton,
    );
    const sourcePostalCode = normalizeSpace(
      listing.postalCode
      || listing.zipCode
      || listing.location?.postalCode
      || listing.location?.zipCode
      || '',
    );
    const sourceStreetAddress = normalizeSpace(
      listing.streetAddress
      || listing.address
      || listing.location?.streetAddress
      || listing.location?.address
      || '',
    );

    // Greenhouse provides job content as HTML
    const descriptionHtml = listing.content || listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);

    // Build public URL
    let publicUrl = listing.absolute_url || listing.url || listing.link || '';
    if (!publicUrl && ghBoard) {
      publicUrl = `https://boards.greenhouse.io/${ghBoard}/jobs/${listing.id}`;
    }
    if (!publicUrl) publicUrl = CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} kudelski-nagra ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const desc = descriptionText || `${title} — Position at Kudelski NAGRA in ${location}. The Kudelski Group is a world leader in digital security and convergent media solutions, with NAGRA providing content protection technology for major media companies.`;

    const job = {
      id: `kudelski-nagra-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KUDELSKI_NAGRA_COMPANY_NAME,
      companyKey: KUDELSKI_NAGRA_KEY,
      companyDomain: KUDELSKI_NAGRA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: desc,
      descriptionByLocale: { [sourceLang]: desc },
      location,
      canton,
      url: publicUrl,
      source: 'Kudelski NAGRA Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: addressLocality || fallbackAddress.addressLocality,
      addressRegion: canton,
      streetAddress: sourceStreetAddress || fallbackAddress.streetAddress,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: /^\d{4}$/.test(sourcePostalCode) ? sourcePostalCode : fallbackAddress.postalCode,
      category: detectCategory(title),
      contract: detectEmploymentType(listing.timeType || title) === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(listing.timeType || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Sicurezza digitale / Media technology',
      currency: 'CHF',
      featured: false,
      postedDate: listing.updated_at?.slice(0, 10) || listing.postedDate || new Date().toISOString().split('T')[0],
      applyUrl: listing.absolute_url || publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total Kudelski NAGRA jobs discovered: ${jobs.length}`);
  // Pre-filter candidate count (issue #6271, mirrors update-baronie-jobs.mjs)
  // — lets the crawler-template pipeline report "found N listings, 0 Swiss
  // after filtering" as healthy instead of broken (check-crawler-health.mjs
  // autoFilteredEmpty, issue #5945). All 11 current listings are Spain/
  // Germany/France; that is the source's genuine state, not a selector break.
  // It counts post-title-gate, not `listings.length` (issue #7707): if title
  // extraction broke the outcome would otherwise be `discovered > 0,
  // written === 0` — a real selector break disguised as filtered-empty.
  Object.defineProperty(jobs, 'discoveredCount', {
    value: titleEligible,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return jobs;
}
