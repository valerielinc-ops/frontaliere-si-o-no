#!/usr/bin/env node
/**
 * Josef Müller Gemüse AG job parser — jobs.ch company-profile scrape
 * (JobCloud JSON-LD JobPosting per detail page).
 *
 * ATS discovery (issue #3337 lists this company as "Custom" — PARTIALLY
 * WRONG, same recurring pattern as other rows in this backlog):
 *   1. Confirmed correct legal entity first: "Josef Müller" is a common
 *      Swiss name. Zefix/Moneyhouse/North Data all resolve to ONE match for
 *      "Josef Müller Gemüse AG" — UID CHE-100.379.852, Aktiengesellschaft,
 *      legal seat Hünenberg ZG, founded 1989. This is the produce/salad
 *      processing company (170 employees, part of the Spanish Foodiverse
 *      group since 2019) — not to be confused with any other "Josef
 *      Müller"-named entity.
 *   2. The corporate site (muellergemuese.com, WordPress — confirmed via
 *      the Yoast SEO block in /robots.txt) links its "Jobs"/"Karriere" page
 *      out to the Foodiverse group's OWN custom PHP recruiting portal:
 *      https://foodiverse.com/ofertas/?idioma=en (jQuery + Bootstrap
 *      SB-Admin2 template, form posts to `ver_oferta.php?id=…`). That
 *      portal is genuinely custom/bespoke and lists a company filter
 *      (`<select name="empresa">`) including "Josef Muller Gemuse AG"
 *      (empresa id=4) alongside Foodiverse, Verdifresh and Thurländer
 *      Salate GmbH — BUT at discovery time (2026-07) all 8 active postings
 *      on that portal belonged to Verdifresh (Spain) or Thurländer Salate
 *      GmbH (Germany); ZERO were filed under Josef Müller Gemüse AG. So
 *      while a bespoke ATS-like system exists group-wide, it currently
 *      carries no Swiss postings for this employer — building a scraper
 *      against it now would have nothing live to verify against.
 *   3. The company's ACTUAL live Swiss vacancy (confirmed via jobs.ch,
 *      JobScout24 and Indeed all mirroring the same posting) is published
 *      directly on jobs.ch — a third-party Swiss job board (JobCloud), NOT
 *      the group's own portal and NOT a commercial ATS product (no
 *      SmartRecruiters/Workday/Personio/Greenhouse fingerprint anywhere:
 *      no iframe, no ATS cookie, no `<meta name="ATS">`). This matches the
 *      brief's "small companies sometimes ONLY post on third-party job
 *      boards" case — the crawl target is jobs.ch's public company-profile
 *      page, not the employer's own domain.
 *   4. jobs.ch's company-profile page (`/de/firmen/{id}-{slug}/`) is a
 *      server-rendered React/Next app (heavy atomic-CSS class soup,
 *      unstable class names) BUT each vacancy card is a plain anchor
 *      `href="/de/stellenangebote/detail/{uuid}/"` — that URL shape is
 *      stable, so listing extraction keys on it via regex rather than on
 *      any class name. Each DETAIL page embeds a full schema.org
 *      `JobPosting` JSON-LD block (title, description, datePosted,
 *      employmentType, jobLocation address, hiringOrganization) — parsing
 *      that structured block is far more robust than scraping the
 *      generated CSS, and is the sole source this parser depends on for
 *      per-job data.
 *   5. `robots.txt` on jobs.ch was not checked for a disallow (public
 *      company-profile + vacancy detail pages are indexed by Google in the
 *      wild, i.e. jobs.ch actively wants them crawled by search engines).
 *
 * No existing shared client fits: `./ats-clients/*` cover named commercial
 * ATS products (Greenhouse/Lever/Workday/…), and `./jobup-ch-feed-common.mjs`
 * is specific to the jobup.ch **mask/feed JSON API**
 * (`jobup.ch/masks/{key}/list_{key}.asp?cmd=json`) used by Romandie
 * "company mask" integrations — a structurally different product/URL
 * family from jobs.ch's own company-profile HTML + JSON-LD detail pages.
 * Reuses shared generic utilities instead of reimplementing them:
 * `fetchHtml`/`stripHtml`/`slugify`/`normalizeSpace` (crawler-template.mjs),
 * `detectLang`/`guessCategory`/`normalizeContract`/`decodeHtmlEntities`
 * (dedicated-crawler-common.mjs), `inferSwissTargetCanton`
 * (target-swiss-locations.mjs), and `stripContactPII`
 * (strip-contact-pii.mjs) — the last one is employer-agnostic by design
 * (Allianz-originated but documented as reusable) and defensively applied
 * here too since small-company postings on third-party boards are a known
 * risk for leaking a named HR contact + direct phone number.
 *
 * HQ address (Rothusstrasse 26, 6331 Hünenberg ZG) confirmed via THREE
 * independent sources: (a) jobs.ch company-profile JSON-LD Organization
 * block, (b) the company's own muellergemuese.com site footer contact
 * info, (c) North Data's public Handelsregister mirror for
 * CHE-100.379.852. All three agree exactly on street/postal/city.
 *
 * Source URLs:
 *   Listing: https://www.jobs.ch/de/firmen/33612-josef-mueller-gemuese-ag/
 *   Detail:  https://www.jobs.ch/de/stellenangebote/detail/{uuid}/
 *
 * Exports the 4 conventional functions for the crawler template:
 *   - fetchAllJosefMuellerJobs() — Fetch + parse all current postings
 *   - isJosefMuellerJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()          — Validate URLs belong to a trusted host
 *   - resolveAddress()           — City-gated HQ address fallback
 */
import { createHash } from 'node:crypto';
import { fetchHtml, slugify, normalizeSpace, stripHtml } from './crawler-template.mjs';
import { detectLang, guessCategory, normalizeContract, decodeHtmlEntities } from './dedicated-crawler-common.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { stripContactPII } from './strip-contact-pii.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const JOSEF_MUELLER_KEY = 'josef-mueller';
export const JOSEF_MUELLER_COMPANY_NAME = 'Josef Müller Gemüse AG';
export const JOSEF_MUELLER_COMPANY_DOMAIN = 'muellergemuese.ch';

const LISTING_URL = 'https://www.jobs.ch/de/firmen/33612-josef-mueller-gemuese-ag/';
const DETAIL_ORIGIN = 'https://www.jobs.ch';

const SECTOR = 'Agricoltura / Industria alimentare';

/** HQ — Rothusstrasse 26, 6331 Hünenberg (ZG). See file header for the
 * three independent sources cross-checked for this address. */
const HQ = {
  city: 'Hünenberg',
  canton: 'ZG',
  postalCode: '6331',
  streetAddress: 'Rothusstrasse 26',
  region: 'Zug',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function cleanText(value = '') {
  return normalizeSpace(decodeHtmlEntities(stripHtml(value)));
}

/**
 * Resolve the best city / postal code / street address for a job, falling
 * back to the documented Hünenberg HQ ONLY when the resolved city text
 * itself matches Hünenberg (city-gated, never canton-only). This company
 * currently has a single physical production site with no other postings
 * ever observed, but the gate is still applied defensively — a future
 * posting for a different Zug-canton town (e.g. Zug, Cham, Baar — all
 * plausible neighbours) must NOT silently inherit the Hünenberg street
 * address just because it shares canton ZG.
 *
 * Exported so tests exercise this exact gate instead of a duplicated regex.
 *
 * @param {{ city?: string, postalCode?: string, streetAddress?: string }} [raw]
 * @returns {{ city: string, postalCode: string, streetAddress: string }}
 */
export function resolveAddress(raw = {}) {
  const city = normalizeSpace(raw.city || '') || HQ.city;
  const isHuenenbergHq = /h(?:u|ü|ue)nenberg/i.test(city);
  return {
    city,
    postalCode: normalizeSpace(raw.postalCode || '') || (isHuenenbergHq ? HQ.postalCode : ''),
    streetAddress: normalizeSpace(raw.streetAddress || '') || (isHuenenbergHq ? HQ.streetAddress : ''),
  };
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Josef Müller Gemüse AG.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isJosefMuellerJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const url = normalize(job?.url || '');

  return (
    key === JOSEF_MUELLER_KEY ||
    key.startsWith('josef-mueller') ||
    company.includes('josef muller gemuse') ||
    company.includes('muellergemuese') ||
    url.includes('muellergemuese.ch') ||
    url.includes('muellergemuese.com')
  );
}

/**
 * Validate a URL belongs to a trusted host for this crawler: the company's
 * own domain, OR jobs.ch (the third-party board the company actually
 * publishes its vacancy on — see file header). jobs.ch hosts every
 * employer on the platform, so this check (like the Interdiscount/Jumbo
 * shared-Prospective-tenant crawlers) validates the HOST only; the actual
 * company association is validated separately via `isJosefMuellerJob`,
 * whose `company`/`companyKey` fields this parser controls directly.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === JOSEF_MUELLER_COMPANY_DOMAIN ||
      host.endsWith(`.${JOSEF_MUELLER_COMPANY_DOMAIN}`) ||
      host === 'muellergemuese.com' ||
      host.endsWith('.muellergemuese.com') ||
      host === 'jobs.ch' ||
      host.endsWith('.jobs.ch')
    );
  } catch {
    return false;
  }
}

/* ── Listing parse ─────────────────────────────────────────── */

/**
 * Parse the jobs.ch company-profile page into a list of unique vacancy
 * detail-page paths.
 *
 * Markup (per card, generated atomic-CSS class names — NOT relied on):
 *   <a href="/de/stellenangebote/detail/{uuid}/" data-discover="true">
 *     <div data-cy="vacancy-serp-item">…</div>
 *   </a>
 *
 * Only the href SHAPE is stable, so extraction keys on the URL pattern
 * (`/de/stellenangebote/detail/{uuid}/`) rather than any class name.
 *
 * @param {string} html
 * @returns {string[]} unique detail-page paths (relative, leading slash)
 */
export function parseJosefMuellerListing(html = '') {
  if (!html || typeof html !== 'string') return [];
  const rx = /href="(\/[a-z]{2}\/(?:stellenangebote|vacancies|offres-emplois)\/detail\/[0-9a-f-]{20,}\/)"/gi;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = rx.exec(html))) {
    const href = m[1];
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}

/* ── Detail page: JobPosting JSON-LD ──────────────────────────── */

/**
 * Extract the schema.org `JobPosting` JSON-LD block from a jobs.ch detail
 * page. jobs.ch emits SEVERAL separate `<script type="application/ld+json">`
 * tags on the same page (a `BreadcrumbList` plus the `JobPosting` object) —
 * NOT one array containing both — so every script block is parsed and the
 * first one whose `@type` is `JobPosting` is returned.
 *
 * @param {string} html
 * @returns {Object|null}
 */
export function extractJosefMuellerJobPosting(html = '') {
  if (!html || typeof html !== 'string') return null;
  const rx = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = rx.exec(html))) {
    let parsed;
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const candidate of candidates) {
      if (candidate && candidate['@type'] === 'JobPosting') return candidate;
    }
  }
  return null;
}

/**
 * Parse a jobs.ch detail page into a normalized shape.
 *
 * jobs.ch's own JSON-LD has a naming quirk: the resolved municipality name
 * (e.g. "Hünenberg") is placed in `jobLocation.address.addressRegion`, NOT
 * `addressLocality` (which is absent entirely on observed postings) — this
 * is jobs.ch's schema, not a parsing bug, so `cityRaw` reads addressRegion
 * as the fallback.
 *
 * @param {string} html
 * @returns {{ title: string, description: string, datePosted: string,
 *   employmentTypeRaw: string, city: string, postalCode: string,
 *   streetAddress: string, hiringOrgName: string } | null}
 */
export function parseJosefMuellerDetail(html = '') {
  const posting = extractJosefMuellerJobPosting(html);
  if (!posting) return null;

  const title = cleanText(posting.title || '');
  if (!title) return null;

  const address = posting.jobLocation?.address || {};
  const cityRaw = normalizeSpace(address.addressLocality || address.addressRegion || '');
  const postalCode = normalizeSpace(address.postalCode || '');
  const streetAddress = normalizeSpace(address.streetAddress || '');

  const descriptionRaw = String(posting.description || '');
  const description = stripContactPII(cleanText(descriptionRaw));

  return {
    title,
    description,
    datePosted: normalizeSpace(String(posting.datePosted || '')),
    employmentTypeRaw: normalizeSpace(String(posting.employmentType || '')),
    city: cityRaw,
    postalCode,
    streetAddress,
    hiringOrgName: cleanText(posting.hiringOrganization?.name || ''),
  };
}

/* ── Employment type mapping ──────────────────────────────────── */

/**
 * jobs.ch's `employmentType` JSON-LD value is a free-text German/French/
 * English label ("Festanstellung", "Temporär", "Praktikum", …), not the
 * schema.org enum — map the observed labels to the internal contract/
 * employmentType convention used across the codebase.
 */
export function mapEmploymentType(raw = '', title = '', description = '') {
  const t = normalize(raw);
  if (/praktik|stage|intern/.test(t)) return { contract: 'internship', employmentType: 'OTHER' };
  if (/teilzeit|temps partiel|part.?time/.test(t)) return { contract: 'part-time', employmentType: 'PART_TIME' };
  if (/temporär|befristet|tempor|fixed.?term/.test(t)) return { contract: 'temporary', employmentType: 'OTHER' };
  if (/festanstellung|unbefristet|permanent|cdi/.test(t)) return { contract: 'full-time', employmentType: 'FULL_TIME' };
  // Fallback: infer from title/description text using the shared heuristic.
  const contract = normalizeContract(raw, title, description);
  const employmentType = contract === 'part-time' ? 'PART_TIME' : contract === 'internship' ? 'OTHER' : 'FULL_TIME';
  return { contract, employmentType };
}

/* ── Fetch + Assemble ──────────────────────────────────────── */

/**
 * Fetch all current Josef Müller Gemüse AG postings from jobs.ch.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled by the
 * AI localization step and translate-pending pipeline.
 */
export async function fetchAllJosefMuellerJobs() {
  console.log(`🔍 Fetching ${JOSEF_MUELLER_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL} (jobs.ch company profile)\n`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(LISTING_URL);
  } catch (err) {
    console.warn(`⚠️ jobs.ch listing fetch failed: ${err?.message || err}`);
    throw err;
  }

  const hrefs = parseJosefMuellerListing(listingHtml);
  if (!hrefs.length) {
    console.warn('⚠️ No vacancy links parsed from jobs.ch company profile.');
    return [];
  }
  console.log(`  📋 Listings found: ${hrefs.length}`);

  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const jobs = [];
  const seen = new Set();

  for (const href of hrefs) {
    const publicUrl = new URL(href, DETAIL_ORIGIN).toString();
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    let detailHtml = '';
    try {
      detailHtml = await fetchHtml(publicUrl, { timeoutMs });
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${publicUrl}: ${err?.message || err}`);
      continue;
    }

    const parsed = parseJosefMuellerDetail(detailHtml);
    if (!parsed || !parsed.title) {
      console.warn(`  ⚠️ Could not parse JobPosting JSON-LD for ${publicUrl}`);
      continue;
    }

    const { title, description, datePosted, employmentTypeRaw } = parsed;
    const { city, postalCode, streetAddress } = resolveAddress({
      city: parsed.city,
      postalCode: parsed.postalCode,
      streetAddress: parsed.streetAddress,
    });
    const location = city || HQ.city;
    const canton = inferSwissTargetCanton(location) || HQ.canton;

    const finalDescription = description || `${title} — ${JOSEF_MUELLER_COMPANY_NAME} (${location}).`;
    const sourceLang = detectLang(finalDescription || title, 'de');
    const jobSlug = slugify(`${title} josef mueller gemuese ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const { contract, employmentType } = mapEmploymentType(employmentTypeRaw, title, finalDescription);
    const postedDate = datePosted ? datePosted.slice(0, 10) : new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${JOSEF_MUELLER_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: JOSEF_MUELLER_COMPANY_NAME,
      companyKey: JOSEF_MUELLER_KEY,
      companyDomain: JOSEF_MUELLER_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: finalDescription,
      descriptionByLocale: { [sourceLang]: finalDescription },
      location,
      canton,
      url: publicUrl,
      source: 'Josef Müller Gemüse AG Dedicated Parser (jobs.ch)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city || location,
      addressRegion: canton === HQ.canton ? HQ.region : canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: guessCategory(title, finalDescription),
      contract,
      employmentType,
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log(`\n📋 Total ${JOSEF_MUELLER_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
