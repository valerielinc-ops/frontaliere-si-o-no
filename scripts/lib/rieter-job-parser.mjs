#!/usr/bin/env node
/**
 * Rieter job parser — Solique (live.solique.ch) recruiting board, "corporate
 * multi-brand" template.
 *
 * ATS discovery (issue #3337 lists Rieter as "Custom" — WRONG, same pattern
 * as other rows in this backlog):
 *   1. https://www.rieter.com/careers/open-positions is a plain TYPO3 CMS
 *      page with NO job data of its own — it embeds an iframe:
 *        <iframe class="ce-iframe" src="https://live.solique.ch/rieter/en/internet ">
 *   2. live.solique.ch is the Swiss "Solique" recruiting-portal SaaS — the
 *      SAME platform already used by several hospital/foundation crawlers in
 *      this repo (see `./solique-common.mjs`: adullam, ipw, ksw, spital-*,
 *      svar-*). So the "Custom" label is wrong: this is a known, already
 *      partially-supported ATS.
 *   3. However Rieter's tenant renders a DIFFERENT Solique template than any
 *      already-supported tenant: a "corporate group" listing/detail layout
 *      (`.job-brand`/`.job-title`/`.job-function`/`.job-location`/
 *      `.job-country` tiles; `.group-left`/`.group-right`/`.facts-figures`/
 *      `.recruiter-info-item` detail page) used because Rieter publishes
 *      postings for its whole corporate group (brands Rieter, Bräcker,
 *      Temco, Suessen) on one tenant. None of `parseSoliqueListing`,
 *      `parseSoliqueApiListing`, or `extractSoliqueDetailContent` in
 *      `./solique-common.mjs` match this markup (verified: their tile regex
 *      expects `<div class="job"><a href="job/details/{id}">…`, Rieter's
 *      tenant uses `<div class="job"><div class="job-brand">…<div
 *      class="job-title"><a href="jobs/{slug}--{id}">…`). Reusing
 *      `createSoliqueParser` would silently return zero jobs, so this file
 *      implements bespoke listing/detail parsing for the group template
 *      while still reusing the shared fetch/HTML utilities
 *      (`fetchHtml`/`stripHtml`/`slugify`/`normalizeSpace` from
 *      `./crawler-template.mjs`, `detectLang`/`guessCategory`/
 *      `normalizeContract` from `./dedicated-crawler-common.mjs`,
 *      `inferSwissTargetCanton` from `./target-swiss-locations.mjs`) rather
 *      than reimplementing them.
 *
 * Source URLs:
 *   Listing: https://live.solique.ch/rieter/en/internet
 *            (server-rendered HTML, one page, no pagination — 10 open roles
 *            worldwide observed 2026-07; small enough that no paging exists)
 *   Detail:  https://live.solique.ch/rieter/en/{href}  (href from listing tile)
 *
 * Rieter Group publishes jobs for its Swiss HQ (Rieter AG, Winterthur ZH)
 * AND for wholly-owned brands/subsidiaries at OTHER locations, including
 * outside Switzerland (Temco/Suessen — Hammelburg & Süßen, Germany) and
 * other Swiss sites (Bräcker AG — Pfäffikon ZH). This site targets jobs IN
 * Switzerland for cross-border commuters, so only postings whose
 * `.job-country` tile field is Switzerland/Schweiz are ingested; German
 * Temco/Suessen postings are filtered out at listing time.
 *
 * Each Solique detail page embeds the REAL per-posting employer address in
 * `.recruiter-info-item` (e.g. "Rieter AG<br>Klosterstrasse 20<br>8406
 * Winterthur" vs "Bräcker AG<br>Obermattstrasse 65<br>8330 Pfäffikon"), so
 * address resolution prefers that live per-job data; `resolveAddress()`
 * below is the HQ-fallback ONLY, and is gated on the resolved city text
 * actually matching Winterthur (never applied canton-wide) so a Bräcker
 * (Pfäffikon ZH) job never inherits the Rieter Winterthur street address.
 */
import { createHash } from 'node:crypto';
import { fetchHtml, slugify, normalizeSpace, stripHtml } from './crawler-template.mjs';
import { detectLang, guessCategory, normalizeContract, decodeHtmlEntities } from './dedicated-crawler-common.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const RIETER_KEY = 'rieter';
export const RIETER_COMPANY_NAME = 'Rieter';
export const RIETER_COMPANY_DOMAIN = 'rieter.com';

const SOLIQUE_TENANT = 'rieter';
const LISTING_URL = 'https://live.solique.ch/rieter/en/internet';
const DETAIL_BASE = 'https://live.solique.ch/rieter/en/';
const CAREER_URL = 'https://www.rieter.com/careers/open-positions';

const SECTOR = 'Industria / Macchinari Tessili';

/** HQ fallback — Rieter AG, Klosterstrasse 20, 8406 Winterthur (ZH).
 * Verified via the company's own Solique job-detail recruiter block
 * (`Rieter AG<br>Klosterstrasse 20<br>8406 Winterthur`) AND cross-checked
 * against the public Impressum (rieter.com/imprint) and the commercial
 * register (Moneyhouse: "Rieter Holding AG", Winterthur). */
const HQ = {
  city: 'Winterthur',
  canton: 'ZH',
  postalCode: '8406',
  streetAddress: 'Klosterstrasse 20',
  region: 'Zürich',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/**
 * Strip tags then decode the extended named-entity set (curly quotes,
 * en/em-dash, accented Latin letters, etc.) that Solique's German/English
 * source text uses but `stripHtml`'s narrower entity table doesn't cover
 * (observed live: `&rsquo;`, `&ndash;` in Rieter AG's English postings).
 */
function cleanText(value = '') {
  return normalizeSpace(decodeHtmlEntities(stripHtml(value)));
}

/**
 * Resolve the best city / postal code / street address for a job, falling
 * back to the documented Rieter HQ ONLY when the resolved city text itself
 * matches Winterthur (city-gated, never canton-only) — this is what stops a
 * Bräcker (Pfäffikon ZH) or other non-HQ Swiss posting from incorrectly
 * inheriting the Winterthur street address just because it shares canton ZH.
 *
 * Exported so tests exercise this exact gate instead of a duplicated regex.
 *
 * @param {{ city?: string, postalCode?: string, streetAddress?: string }} [raw]
 * @returns {{ city: string, postalCode: string, streetAddress: string }}
 */
export function resolveAddress(raw = {}) {
  const city = normalizeSpace(raw.city || '') || HQ.city;
  const isWinterthurHq = /winterthur/i.test(city);
  return {
    city,
    postalCode: normalizeSpace(raw.postalCode || '') || (isWinterthurHq ? HQ.postalCode : ''),
    streetAddress: normalizeSpace(raw.streetAddress || '') || (isWinterthurHq ? HQ.streetAddress : ''),
  };
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Rieter (or one of its Swiss group brands
 * ingested by this crawler, e.g. Bräcker). Matching is keyed primarily on
 * `companyKey`, which this parser always sets to `RIETER_KEY` regardless of
 * the specific group brand, so brand-name jobs (e.g. "Bräcker AG") still
 * match even though `company` doesn't literally contain "rieter".
 */
export function isRieterJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === RIETER_KEY ||
    key.startsWith('rieter') ||
    company.includes('rieter') ||
    url.includes('rieter.com') ||
    (url.includes('solique.ch') && url.includes(`/${SOLIQUE_TENANT}/`))
  );
}

/**
 * Validate a URL belongs to Rieter's own domain or the Rieter tenant on the
 * shared Solique host.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host === RIETER_COMPANY_DOMAIN || host.endsWith(`.${RIETER_COMPANY_DOMAIN}`)) return true;
    if (host === 'live.solique.ch' || host === 'solique.ch' || host.endsWith('.solique.ch')) {
      return new RegExp(`\\/${SOLIQUE_TENANT}(\\/|$)`, 'i').test(url.pathname);
    }
    return false;
  } catch {
    return false;
  }
}

/* ── Listing parse (corporate multi-brand template) ─────────── */

/**
 * Parse the Rieter Solique listing page into raw tiles.
 *
 * Markup (per tile, no stable outer closing-tag boundary to anchor a single
 * regex on since `.job-brand`/`.job-title`/… are themselves `<div>`s that
 * close before the tile's own `</div>`):
 *   <div class="job">
 *     <div class="job-brand"><img class="logo" src="…" alt="Rieter" /></div>
 *     <div class="job-title"><a href="jobs/{slug}--{id}">{title}</a></div>
 *     <div class="job-function">{department}</div>
 *     <div class="job-location">{city}</div>
 *     <div class="job-country">{country}</div>
 *   </div>
 *
 * Splitting on the literal `<div class="job">` delimiter and scoping each
 * field regex to the resulting chunk avoids the nested-`</div>` ambiguity a
 * single lazy `<div class="job">([\s\S]*?)<\/div>` match would hit.
 *
 * @param {string} html
 * @returns {Array<{brand: string, href: string, title: string, department: string, location: string, country: string}>}
 */
export function parseRieterListing(html = '') {
  if (!html || typeof html !== 'string') return [];
  const marker = '<div class="job">';
  const start = html.indexOf(marker);
  if (start === -1) return [];

  const out = [];
  const seen = new Set();
  const chunks = html.slice(start + marker.length).split(marker);
  for (const chunk of chunks) {
    const titleMatch = chunk.match(/<div\s+class="job-title">\s*<a\s+href="([^"]+)">([\s\S]*?)<\/a>\s*<\/div>/i);
    if (!titleMatch) continue;
    const href = titleMatch[1].trim();
    if (!href || seen.has(href)) continue;
    seen.add(href);

    const brandMatch = chunk.match(/<div\s+class="job-brand">[\s\S]*?alt="([^"]*)"/i);
    const funcMatch = chunk.match(/<div\s+class="job-function">([\s\S]*?)<\/div>/i);
    const locMatch = chunk.match(/<div\s+class="job-location">([\s\S]*?)<\/div>/i);
    const countryMatch = chunk.match(/<div\s+class="job-country">([\s\S]*?)<\/div>/i);

    const title = cleanText(titleMatch[2]);
    if (!title || title.length < 3) continue;

    out.push({
      brand: brandMatch ? cleanText(brandMatch[1]) : '',
      href,
      title,
      department: funcMatch ? cleanText(funcMatch[1]) : '',
      location: locMatch ? cleanText(locMatch[1]) : '',
      country: countryMatch ? cleanText(countryMatch[1]) : '',
    });
  }
  return out;
}

/* ── Detail page parse ────────────────────────────────────────*/

/**
 * Extract the free-text description from a Rieter Solique detail page.
 *
 * The desktop layout (`<div class="content">…`) and a mobile accordion
 * duplicate (`<div id="wrapper-mobile">…`) render the SAME content twice —
 * only the desktop half is parsed (cut the HTML at the mobile marker first)
 * to avoid doubling every paragraph/bullet.
 *
 * Every substantive block (intro copy, job blurb, "Your Tasks"/"Your
 * Qualifications"/"Our Offer" heading+list groups, closing paragraph) is
 * wrapped in a plain `<div class="text">…</div>` with no nested `<div>`
 * inside, so a lazy match safely finds each block's own closing tag.
 * `stripHtml` (shared, from crawler-template.mjs) already converts
 * `<li>`→"\n• ", `</h3>`→"\n", decodes entities and strips tags, so each
 * block just needs stripHtml + a length guard against decorative noise.
 */
export function extractRieterDetailContent(html = '') {
  if (!html || typeof html !== 'string') return '';
  const desktopHtml = html.split('id="wrapper-mobile"')[0];

  const blocks = [];
  const textRx = /<div\s+class="text">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = textRx.exec(desktopHtml))) {
    const text = decodeHtmlEntities(stripHtml(m[1])).trim();
    if (text && text.length > 3) blocks.push(text);
  }
  return blocks.join('\n\n');
}

/**
 * Extract the `.facts-figures-item` key/value metadata panel. Rieter's
 * tenant renders labels in the posting's own source language (German for
 * Temco/Suessen/Bräcker-authored posts, English for Rieter AG posts), so
 * both label variants are mapped.
 */
const FACTS_FIELD_MAP = {
  'stellen id': 'jobId',
  'job id': 'jobId',
  geschäftsbereich: 'business',
  business: 'business',
  land: 'country',
  country: 'country',
  unternehmen: 'brand',
  company: 'brand',
  funktionsbereich: 'department',
  'functional area': 'department',
  einstiegslevel: 'entryLevel',
  'entry level': 'entryLevel',
  vertragstyp: 'contractType',
  'contract type': 'contractType',
  ort: 'city',
  location: 'city',
};

export function parseRieterFactsFigures(html = '') {
  const facts = {};
  if (!html || typeof html !== 'string') return facts;
  const rx = /<div\s+class="facts-figures-item">([^:<]+):\s*([^<]*)<\/div>/g;
  let m;
  while ((m = rx.exec(html))) {
    const label = normalizeSpace(m[1]).toLowerCase();
    const field = FACTS_FIELD_MAP[label];
    if (!field) continue;
    facts[field] = cleanText(m[2]);
  }
  return facts;
}

/**
 * Extract street/postal/city/legal-entity from the `.recruiter-info-item`
 * contact block (real per-posting address, e.g.
 * "Rieter AG<br>Klosterstrasse 20<br>8406 Winterthur" or
 * "Bräcker AG<br>Obermattstrasse 65<br>8330 Pfäffikon").
 */
export function parseRieterRecruiterAddress(html = '') {
  const result = { streetAddress: '', postalCode: '', city: '', entity: '' };
  if (!html || typeof html !== 'string') return result;
  const blockMatch = html.match(/<div\s+class="recruiter-info-item">([\s\S]*?)<\/div>/i);
  if (!blockMatch) return result;

  const lines = blockMatch[1]
    .replace(/<br\s*\/?>/gi, '\n')
    .split('\n')
    .map((l) => cleanText(l))
    .filter(Boolean);

  for (let i = 0; i < lines.length; i += 1) {
    const zipMatch = lines[i].match(/^(\d{4,5})\s+(.+)$/);
    if (zipMatch) {
      result.postalCode = zipMatch[1];
      result.city = zipMatch[2].trim();
      result.streetAddress = (lines[i - 1] || '').trim();
      break;
    }
  }
  const entityLine = lines.find((l) => /\b(AG|GmbH|Ltd|SA|S\.?A\.?R\.?L\.?|Inc)\b/i.test(l));
  result.entity = entityLine || '';
  return result;
}

/* ── Fetch + Assemble ──────────────────────────────────────── */

function isSwissCountryLabel(country = '') {
  return /schweiz|switzerland|suisse|svizzera/i.test(country);
}

/**
 * Fetch all Rieter jobs (Switzerland only — Temco/Suessen postings in
 * Germany are filtered out at listing time via `.job-country`).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled by the
 * AI localization step and translate-pending pipeline.
 */
export async function fetchAllRieterJobs() {
  console.log(`🔍 Fetching ${RIETER_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL} (Solique, corporate group template)\n`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(LISTING_URL);
  } catch (err) {
    console.warn(`⚠️ Rieter Solique listing fetch failed: ${err?.message || err}`);
    throw err;
  }

  const tiles = parseRieterListing(listingHtml).filter((t) => isSwissCountryLabel(t.country));
  if (!tiles.length) {
    console.warn('⚠️ No Switzerland-located openings parsed from Rieter Solique listing.');
    return [];
  }
  console.log(`  📋 Switzerland listings found: ${tiles.length}`);

  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const jobs = [];
  const seen = new Set();

  for (const tile of tiles) {
    const publicUrl = new URL(tile.href, DETAIL_BASE).toString();
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    let detailHtml = '';
    try {
      detailHtml = await fetchHtml(publicUrl, { timeoutMs });
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${tile.title}: ${err?.message || err}`);
    }

    const facts = parseRieterFactsFigures(detailHtml);
    const recruiter = parseRieterRecruiterAddress(detailHtml);
    const detailDescription = extractRieterDetailContent(detailHtml);

    const title = tile.title;
    const rawLocation = recruiter.city || facts.city || tile.location || HQ.city;
    const { city, postalCode, streetAddress } = resolveAddress({
      city: rawLocation,
      postalCode: recruiter.postalCode,
      streetAddress: recruiter.streetAddress,
    });
    const location = normalizeSpace(tile.location || city);
    const canton = inferSwissTargetCanton(location) || inferSwissTargetCanton(city) || HQ.canton;

    const brandEntity = recruiter.entity || facts.brand || tile.brand || RIETER_COMPANY_NAME;

    const descParts = [];
    if (detailDescription) descParts.push(detailDescription);
    if (tile.department) descParts.push(`Bereich: ${tile.department}`);
    if (facts.entryLevel) descParts.push(`Level: ${facts.entryLevel}`);
    const description = descParts.length
      ? descParts.join('\n\n')
      : `${title} — ${RIETER_COMPANY_NAME} (${location}).`;

    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} rieter ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const contract = normalizeContract(facts.contractType || '', title, description);
    const employmentType = contract === 'part-time' ? 'PART_TIME' : 'FULL_TIME';
    const postedDate = new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${RIETER_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: RIETER_COMPANY_NAME,
      companyKey: RIETER_KEY,
      companyDomain: RIETER_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Rieter Dedicated Parser (Solique)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city || location,
      addressRegion: canton === HQ.canton ? HQ.region : canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: guessCategory(title, description),
      contract,
      employmentType,
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      jobReqId: facts.jobId || null,
      employerBrand: brandEntity !== RIETER_COMPANY_NAME ? brandEntity : undefined,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log(`\n📋 Total ${RIETER_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
