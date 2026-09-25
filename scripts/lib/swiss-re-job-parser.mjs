#!/usr/bin/env node
/**
 * Swiss Re job parser — Fetcher and job builder.
 *
 * Source: https://careers.swissre.com (SuccessFactors / jobs2web overlay)
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSwissReJobs()  — Fetch and parse all jobs
 *   - isSwissReJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang, isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { ISO_ALPHA2_COUNTRY_CODES } from './prospector/country-inventory.mjs';
import { resolveSourceBackedSwissGeography } from './prospector/location-evidence.mjs';
import {
  detectSuccessFactorsKind,
  fetchSuccessFactorsJobs,
  SuccessFactorsAuthError,
} from './ats-clients/successfactors-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SWISS_RE_KEY = 'swiss-re';
export const SWISS_RE_COMPANY_NAME = 'Swiss Re';
export const SWISS_RE_COMPANY_DOMAIN = 'swissre.com';

// SuccessFactors CSB tenant, "JobTeaserList" card overlay (#3797).
// detectSuccessFactorsKind('https://www.swissre.com/careers/jobSearch.html') → 'html-jobreq'
// Note: careers.swissre.com (the old seed) is a dead redirect target — the
// real listing lives on www.swissre.com, not the careers. subdomain.
const CAREER_URL = 'https://www.swissre.com/careers/jobSearch.html';

// ── Detail-page fetch budget (#3836) ──
// The JobTeaserList listing cards carry NO description — the real, structured
// job body (About the Role / Key Responsibilities bullets) only exists on the
// detail pages at /careers/job/{slug}/{id}. We therefore fetch one detail page
// per listing whose card is not already explicitly foreign (issue 9843: the
// listing is global, ~270 cards of which ~16 are Swiss on 2026-09-25). A run
// that fetched every card cost ~320 × (fetch + DETAIL_FETCH_DELAY_MS) ≈ 6-9
// min. The cap below is a safety valve against a listing-count
// explosion, NOT a routine limiter: when it trips, every skipped job is
// counted and reported loudly in the run log (no silent thinning).
export const DETAIL_FETCH_DELAY_MS = 500;
export const MAX_DETAIL_FETCHES = (() => {
  const raw = Number(process.env.SWISS_RE_MAX_DETAIL_FETCHES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 500;
})();

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Swiss Re.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isSwissReJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SWISS_RE_KEY ||
    key.startsWith('swiss-re') ||
    company.includes('swiss re') ||
    url.includes('swissre.com') ||
    url.includes('swissre.ch')
  );
}

/**
 * Validate that a URL belongs to Swiss Re's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'swissre.com' ||
      host.endsWith('.swissre.com') ||
      host === 'swissre.ch' ||
      host.endsWith('.swissre.ch')
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

/* ── Source geography ─────────────────────────────────────────
 * Swiss Re writes every location as `City[, Region], CC`: the terminal
 * two-letter segment is the ISO 3166-1 country code (`Zurich, CH`,
 * `Paris, FR`, `Kansas City, MO, US`), and a multi-location posting lists
 * such entries separated by `|`. In that position FR, SG and LU are France,
 * Singapore and Luxembourg, not the cantons Fribourg, St. Gallen and Lucerne
 * that the generic trailing-suffix rule of inferSwissTargetCanton() reads
 * (issue 9843). The position in the source field decides, before any canton
 * inference; the canton itself comes from the fail-closed source-backed
 * resolver, never from the Zürich HQ.
 */

/**
 * Split a Swiss Re location field into its entries.
 *
 * @param {string} text `City, CC` or `City, CC | City, Region, CC`.
 * @returns {string[]}
 */
export function splitSwissReLocations(text = '') {
  return String(text || '')
    .split('|')
    .map((entry) => normalizeSpace(entry))
    .filter(Boolean);
}

/**
 * ISO country code carried by the terminal segment of one Swiss Re entry, or
 * `''` when the entry has no such segment (`Zürich`, `Lugano, TI`: a canton
 * code that is not an assigned ISO country code stays canton evidence).
 *
 * @param {string} entry
 * @returns {string}
 */
export function swissReEntryCountryCode(entry = '') {
  const segments = String(entry || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) return '';
  const last = segments[segments.length - 1];
  if (!/^[A-Za-z]{2}$/.test(last)) return '';
  const code = last.toUpperCase();
  return ISO_ALPHA2_COUNTRY_CODES.has(code) ? code : '';
}

/**
 * True when every entry of the field is explicitly outside Switzerland:
 * a terminal country code other than CH, or an explicit foreign country in
 * an entry without that segment.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isSwissReLocationForeign(text = '') {
  const entries = splitSwissReLocations(text);
  if (entries.length === 0) return false;
  return entries.every((entry) => {
    const country = swissReEntryCountryCode(entry);
    return country ? country !== 'CH' : isLocationExplicitlyForeign(entry);
  });
}

/**
 * Resolve the Swiss geography of a Swiss Re location field: the first entry
 * that is not explicitly foreign and that the source-backed resolver maps to
 * a canton. `null` means the row has no Swiss location and must be dropped.
 *
 * @param {string} text
 * @returns {{ location: string, canton: string } | null}
 */
export function resolveSwissReGeography(text = '') {
  for (const entry of splitSwissReLocations(text)) {
    const country = swissReEntryCountryCode(entry);
    if (country && country !== 'CH') continue;
    const geography = resolveSourceBackedSwissGeography({ location: entry, addressCountry: country });
    if (geography) return { location: entry, canton: geography.canton };
  }
  return null;
}

/* ── Detail-page parser ───────────────────────────────────────
 * www.swissre.com/careers/job/{slug}/{id} is a Magnolia CMS page (SSR):
 *   <div class="PageHeaderCareer"> … <div class="SectionTitle--content">
 *     Regular Employment</div> …
 *   <section class="ArticleSection"><div class="richtext">
 *     <p><strong>Location:</strong> Hyderabad, TG, IN</p></div></section>
 *   (multi-location postings: <strong>Locations:</strong> Schaumburg, IL, US |
 *    Armonk, NY, US — their listing card carries no plain location span)
 *   <section class="ArticleSection"><div class="richtext">
 *     …full job body with <ul type="disc"><li> bullets…</div></section>
 * There is NO JobPosting JSON-LD on these pages (only WebSite +
 * BreadcrumbList), so the richtext sections are the description source.
 */

// Longest single entry accepted as location metadata. A body paragraph that
// merely opens with "Location:" runs longer and stays in the description.
const MAX_LOCATION_ENTRY_CHARS = 80;

/**
 * Parse a Swiss Re careers detail page.
 *
 * @param {string} html Raw detail-page HTML.
 * @returns {{descriptionHtml: string, location: string, employmentText: string} | null}
 *   `null` when the page has no ArticleSection content (challenge page,
 *   redirect stub, expired posting). `location` keeps the source entries,
 *   joined with ` | ` for a multi-location posting.
 */
export function parseSwissReDetailPage(html = '') {
  if (!html) return null;
  const sections = [
    ...String(html).matchAll(
      /<section[^>]*class="[^"]*ArticleSection[^"]*"[^>]*>([\s\S]*?)<\/section>/gi
    ),
  ].map((m) => m[1]);

  let location = '';
  const bodyParts = [];
  for (const section of sections) {
    const plain = stripHtml(section);
    if (!plain) continue;
    // The first richtext section is a short "Location: City, Region, CC" (or
    // "Locations: A, CC | B, CC") paragraph and nothing else. Every entry must
    // be short so a real body mentioning "Location:" never gets swallowed as
    // metadata.
    const locMatch = location
      ? null
      : section.match(/<strong>\s*Locations?\s*:?\s*<\/strong>([\s\S]*?)(?:<\/p>|$)/i);
    if (locMatch) {
      const entries = splitSwissReLocations(stripHtml(locMatch[1]));
      const rest = normalizeSpace(stripHtml(section.replace(locMatch[0], '')));
      if (!rest && entries.length > 0
        && entries.every((entry) => entry.length <= MAX_LOCATION_ENTRY_CHARS)) {
        location = entries.join(' | ');
        continue;
      }
    }
    bodyParts.push(section);
  }

  // "Regular Employment" / "Temporary Employment" chip under the H1.
  const empMatch = html.match(
    /<div[^>]*class="[^"]*SectionTitle--content[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  );
  const employmentText = empMatch ? normalizeSpace(stripHtml(empMatch[1])) : '';

  const descriptionHtml = bodyParts.join('\n').trim();
  if (!descriptionHtml && !location) return null;
  return { descriptionHtml, location, employmentText };
}

/**
 * Fetch and parse one detail page. Uses the shared fetchHtml (retry +
 * WAF/Jina rescue — www.swissre.com 403s plain curl but serves normal
 * browser-shaped requests).
 *
 * @param {string} url Detail-page URL.
 * @returns {Promise<ReturnType<typeof parseSwissReDetailPage>>}
 */
export async function fetchSwissReJobDetail(url) {
  const html = await fetchHtml(url, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  return parseSwissReDetailPage(html);
}

/* ── SuccessFactors fetcher ───────────────────────────────────
 * Three flavors auto-detected from CAREER_URL:
 *   - 'odata-api'    → api{N}.successfactors.com/odata/v2/...
 *   - 'html-career'  → career5.successfactors.eu/career?company=...
 *   - 'html-jobreq'  → jobs2web / SSR overlay (jobs.sbb.ch, etc.)
 * For 'html-career' listing index you typically need Playwright
 * (re-scaffold with --playwright if so).
 */
// No substring facet: Swiss Re's listing is GLOBAL (issue 9843: 272 cards,
// 16 Swiss, on 2026-09-25), but a multi-location card has no plain location
// span, so a client-side substring filter would drop it before its detail page
// can name a Swiss office. fetchAllSwissReJobs() filters on the source
// geography instead.
const SF_LOCATION_FILTERS = [];

async function fetchJobListings() {
  const kind = detectSuccessFactorsKind(CAREER_URL);
  if (!kind) {
    console.warn(`⚠️ URL not recognised as SuccessFactors: ${CAREER_URL}`);
    return [];
  }
  const out = [];
  try {
    for await (const job of fetchSuccessFactorsJobs(CAREER_URL, {
      locationFilters: SF_LOCATION_FILTERS,
      company: SWISS_RE_COMPANY_NAME,
    })) {
      out.push({
        title: job.title,
        location: job.location,
        url: job.applyUrl,
        postedAt: job.postedAt,
        jobReqId: job.jobReqId,
      });
    }
  } catch (err) {
    if (err instanceof SuccessFactorsAuthError) {
      console.error(`❌ SuccessFactors anti-bot block: ${err.message}`);
      return [];
    }
    throw err;
  }
  return out;
}

/**
 * Fetch all Swiss Re jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllSwissReJobs() {
  console.log(`🔍 Fetching Swiss Re jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  let detailOk = 0;
  let detailFailed = 0;
  let detailSkipped = 0;
  const skippedForeign = new Map();
  let skippedNoGeography = 0;
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const publicUrl = listing.url || CAREER_URL;

    // The card's location is the source's own field: an explicitly foreign
    // card is dropped here, before paying for its detail page (issue 9843).
    const listingLocation = normalizeSpace(listing.location || '');
    if (listingLocation && isSwissReLocationForeign(listingLocation)) {
      skippedForeign.set(listingLocation, (skippedForeign.get(listingLocation) || 0) + 1);
      continue;
    }

    // Listing cards carry no description — fetch the detail page (#3836).
    let detail = null;
    if (detailOk + detailFailed < MAX_DETAIL_FETCHES) {
      try {
        detail = await fetchSwissReJobDetail(publicUrl);
        if (detail?.descriptionHtml) {
          detailOk += 1;
        } else {
          detailFailed += 1;
          console.warn(`  ⚠️ No description sections on detail page: ${publicUrl}`);
        }
      } catch (err) {
        detailFailed += 1;
        console.warn(`  ⚠️ Detail fetch failed for ${publicUrl}: ${err?.message || err}`);
      }
      await new Promise((r) => setTimeout(r, DETAIL_FETCH_DELAY_MS)); // Rate limiting
    } else {
      detailSkipped += 1;
    }

    // Source-backed geography only: listing card first, then the detail
    // page's Location(s) line. No Zürich-HQ fallback — a row without a
    // resolvable Swiss location is dropped (fail-closed, owner rule).
    const detailLocation = normalizeSpace(detail?.location || '');
    const geography = resolveSwissReGeography(listingLocation)
      || resolveSwissReGeography(detailLocation);
    if (!geography) {
      const evidence = listingLocation || detailLocation;
      if (evidence && isSwissReLocationForeign(evidence)) {
        skippedForeign.set(evidence, (skippedForeign.get(evidence) || 0) + 1);
      } else {
        skippedNoGeography += 1;
        console.warn(`  ⏭️  No Swiss location in listing or detail (${evidence || 'none'}): ${publicUrl}`);
      }
      continue;
    }
    const { location, canton } = geography;
    const descriptionHtml = detail?.descriptionHtml || '';
    const descriptionText = stripHtml(descriptionHtml);

    const sourceLang = detectLang(descriptionText || title, 'it');
    const jobSlug = slugify(`${title} swiss-re ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `swiss-re-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SWISS_RE_COMPANY_NAME,
      companyKey: SWISS_RE_KEY,
      companyDomain: SWISS_RE_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Swiss Re`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Swiss Re` },
      location,
      canton,
      url: publicUrl,
      source: 'Swiss Re Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(
        [detail?.employmentText, listing.timeType, title].filter(Boolean).join(' ')
      ),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Assicurazioni', // Reinsurance / financial services
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  const foreignTotal = [...skippedForeign.values()].reduce((sum, n) => sum + n, 0);
  if (foreignTotal > 0) {
    const sample = [...skippedForeign.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([loc, n]) => `${loc} ×${n}`)
      .join('; ');
    console.log(`\n  ⏭️  Skipped ${foreignTotal} non-Swiss listings (${sample})`);
  }
  if (skippedNoGeography > 0) {
    console.warn(`  ⏭️  Skipped ${skippedNoGeography} listings without a resolvable Swiss location`);
  }
  console.log(
    `\n  📄 Detail pages: ${detailOk} with description, ${detailFailed} failed/empty, ${detailSkipped} skipped`
  );
  if (detailSkipped > 0) {
    // NOT a silent cap: every skipped job is visible here and falls back to
    // the "<title> — Swiss Re" stub, which the parser-quality audit flags.
    console.warn(
      `  ⚠️ Detail-fetch cap hit: ${detailSkipped}/${listings.length} listings NOT enriched ` +
        `(cap ${MAX_DETAIL_FETCHES}; raise SWISS_RE_MAX_DETAIL_FETCHES to cover all).`
    );
  }

  console.log(`\n📋 Total Swiss Re jobs discovered: ${jobs.length}`);
  return jobs;
}
