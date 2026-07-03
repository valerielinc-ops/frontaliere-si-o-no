#!/usr/bin/env node
/**
 * Bucherer job parser — Ceridian Dayforce HCM "CandidatePortal" ATS.
 *
 * Source: https://www.bucherer.com/en/career (redirects into the Dayforce
 * candidate portal) → https://jobs.dayforcehcm.com/en-GB/bucherer/CANDIDATEPORTAL
 *
 * Bucherer AG (founded 1888, HQ Langensandstrasse 27, 6005 Luzern) is
 * Switzerland's leading luxury watch & jewelry retailer (official partner
 * of Rolex, Patek Philippe, Cartier, …) and also runs its own watchmaking
 * manufacture, Carl F. Bucherer. It publishes postings across many Swiss
 * boutique locations (Luzern, Zürich, Genève, Basel, Bern, Lugano, …), not
 * just the Lucerne HQ — canton must be resolved per-posting.
 *
 * The Dayforce candidate-portal backend (`POST
 * https://jobs.dayforcehcm.com/api/geo/bucherer/jobposting/search`) is
 * behind Cloudflare Bot Management: plain curl / manually-constructed
 * `fetch()` calls — even replayed from inside an already-navigated,
 * CF-cleared Playwright page — get a hard 403. The portal's own bundled JS
 * fires the same request organically on page load and it succeeds, so this
 * parser drives a real headless browser to the listing page and captures
 * that response via a `context.on('response', …)` listener instead of ever
 * constructing the request itself. Individual job-detail pages
 * (`/jobs/{id}`) are NOT CF-gated and embed a `__NEXT_DATA__` JSON blob, but
 * the search response already carries the full HTML description, address,
 * and posting dates needed here, so no per-job detail fetch is required.
 *
 * Exports the 4 functions expected by the crawler template:
 *   - fetchAllBuchererJobs() — Fetch and parse all Swiss jobs
 *   - isBuchererJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()      — Validate URLs belong to this company/ATS
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferAnyCanton, normalizeCantonCode } from './target-swiss-locations.mjs';
import {
  createBrowser,
  createPoliteContext,
  fetchWithRateLimit,
  closeAll,
} from './ats-clients/playwright-runtime.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const BUCHERER_KEY = 'bucherer';
export const BUCHERER_COMPANY_NAME = 'Bucherer';
export const BUCHERER_COMPANY_DOMAIN = 'bucherer.com';

const ATS_HOST = 'dayforcehcm.com';
const LISTING_URL = 'https://jobs.dayforcehcm.com/en-GB/bucherer/CANDIDATEPORTAL';
const SEARCH_API_PATH = '/jobposting/search';
const MAX_PAGES = 20;

// Cloudflare on jobs.dayforcehcm.com blocks the shared bot UA; a plain
// desktop Safari UA (same fix used by the Richemont Playwright parser)
// clears the challenge.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

/* ── HQ fallback (Langensandstrasse 27, 6005 Luzern, LU) ─────── */

const HQ = {
  city: 'Luzern',
  canton: 'LU',
  postalCode: '6005',
  streetAddress: 'Langensandstrasse 27',
  region: 'Luzern',
};

const SECTOR = 'Lusso / Orologeria e Gioielleria';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Bucherer.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isBuchererJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === BUCHERER_KEY ||
    key.startsWith('bucherer') ||
    company.includes('bucherer') ||
    url.includes('bucherer.com') ||
    url.includes('dayforcehcm.com/en-gb/bucherer')
  );
}

/**
 * Validate that a URL belongs to Bucherer's domain OR the Dayforce ATS host
 * that actually serves the postings.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === BUCHERER_COMPANY_DOMAIN || host.endsWith(`.${BUCHERER_COMPANY_DOMAIN}`)) return true;
    if (host === ATS_HOST || host.endsWith(`.${ATS_HOST}`)) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(orolog|watchmak|uhrmach|horlog)/.test(t)) return 'Orologeria';
  if (/\b(gioiell|jewel|schmuck|bijout)/.test(t)) return 'Gioielleria';
  if (/\b(vendita|sales|verkauf|commerce|consulen|berater|conseil)/.test(t)) return 'Vendita';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(it|software|develop|programm|digital)/.test(t)) return 'IT';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  if (/\b(store\s*manager|filialleit|responsab.*negozio|direttor.*negozio)/.test(t)) return 'Management';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|manager)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Address parsing ───────────────────────────────────────── */

// Dayforce `formattedAddress` looks like "Langensandstrasse 27, 6005 Luzern,
// Switzerland" (street present) or "6300 Zug, Switzerland" (no street).
const ADDRESS_WITH_STREET_RE = /^(.+?),\s*(\d{4})\s+([^,]+),\s*Switzerland\s*$/i;
const ADDRESS_NO_STREET_RE = /^(\d{4})\s+([^,]+),\s*Switzerland\s*$/i;

function parseFormattedAddress(formattedAddress = '') {
  const text = normalizeSpace(formattedAddress);
  if (!text) return { street: '', postalCode: '', city: '' };

  const withStreet = text.match(ADDRESS_WITH_STREET_RE);
  if (withStreet) {
    return { street: withStreet[1].trim(), postalCode: withStreet[2], city: withStreet[3].trim() };
  }

  const noStreet = text.match(ADDRESS_NO_STREET_RE);
  if (noStreet) {
    return { street: '', postalCode: noStreet[1], city: noStreet[2].trim() };
  }

  return { street: '', postalCode: '', city: '' };
}

/**
 * Pick the best city / postal code / street / region from a raw Dayforce
 * posting location. No HQ fallback is applied here — that happens exactly
 * once, at final job-object assembly, gated on the resolved canton matching
 * HQ.canton (Bucherer is a multi-location retailer, so blindly attaching
 * the Lucerne HQ street address to every job would be wrong for postings
 * in other cantons).
 */
function resolveAddress(rawLoc = {}) {
  const parsed = parseFormattedAddress(rawLoc.formattedAddress || '');
  const city = (rawLoc.cityName || parsed.city || '').trim();
  const postalCode = (rawLoc.postalCode || parsed.postalCode || '').trim();
  const streetAddress = (rawLoc.addressLine1 || parsed.street || '').trim();
  const region = (rawLoc.stateName || '').trim();

  return { city, postalCode, streetAddress, region };
}

/* ── Thin-content guard (Non-Negotiable #4: never index <50 words) ──── */

function buildFallbackDescription(title, location) {
  return [
    `Bucherer cerca un/una ${title} per la sede di ${location}.`,
    `Bucherer AG, fondata nel 1888 a Lucerna, è il principale rivenditore svizzero di orologi e gioielli di lusso e partner ufficiale di marchi come Rolex, Patek Philippe, Cartier e Breitling.`,
    `Il gruppo gestisce oltre 30 boutique in Svizzera, Germania e altri mercati internazionali e possiede la propria manifattura orologiera, Carl F. Bucherer.`,
    `Lavorare in Bucherer significa entrare in un ambiente dedicato al lusso e all'artigianato svizzero, con formazione specialistica in orologeria e gioielleria, percorsi di carriera internazionali e un forte legame con la tradizione del settore.`,
    `Le posizioni aperte spaziano tra vendita in boutique, orologeria e gioielleria, logistica, amministrazione, marketing e ruoli corporate presso la sede centrale di Lucerna.`,
    `Candidature online sul portale ufficiale bucherer.com/en/career.`,
  ].join(' ');
}

function resolveDescription(rawHtml, title, location) {
  const text = stripHtml(rawHtml || '');
  if (text && text.split(/\s+/).filter(Boolean).length >= 50) return text;
  return buildFallbackDescription(title, location);
}

/* ── Fetch (Playwright, Cloudflare-gated) ─────────────────────── */

/**
 * Navigate to the Dayforce candidate-portal listing page and capture the
 * organic `jobposting/search` XHR response(s) it fires (never replayed
 * manually — see module docblock). Defensively paginates via the Ant
 * Design "next page" control in case the current single-page result grows,
 * capped at MAX_PAGES.
 */
async function discoverAllJobPostings() {
  let browser;
  const rawPostings = [];
  const seenIds = new Set();

  try {
    browser = await createBrowser({ userAgent: BROWSER_UA });
    const context = await createPoliteContext(browser, { userAgent: BROWSER_UA });

    const capturedResponses = [];
    context.on('response', (resp) => {
      const url = resp.url();
      if (resp.status() !== 200 || !url.includes(SEARCH_API_PATH)) return;
      resp
        .json()
        .then((body) => {
          if (body) capturedResponses.push(body);
        })
        .catch(() => {
          /* not JSON / unrelated response — ignore */
        });
    });

    const page = await fetchWithRateLimit(context, LISTING_URL, { minDelayMs: 3000 });

    // Dismiss cookie-consent banner if present — it intercepts pointer
    // events on the search results / pagination controls below.
    try {
      const acceptBtn = page.locator('button:has-text("Accept")').first();
      if (await acceptBtn.isVisible({ timeout: 5000 })) {
        await acceptBtn.click({ timeout: 5000, force: true });
      }
    } catch {
      /* no consent banner shown — nothing to dismiss */
    }

    // The listing page auto-fires the search XHR on load; wait for the
    // organic response rather than constructing the API call ourselves.
    await page.waitForTimeout(8000);

    const collectFrom = (body) => {
      let addedNew = false;
      for (const posting of body?.jobPostings || []) {
        const id = String(posting.jobPostingId || posting.jobReqId || '');
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        rawPostings.push(posting);
        addedNew = true;
      }
      return addedNew;
    };

    for (const body of capturedResponses) collectFrom(body);

    for (let pageNum = 1; pageNum < MAX_PAGES; pageNum += 1) {
      const nextBtn = page.locator('.ant-pagination-next:not(.ant-pagination-disabled)').first();
      const hasNext = await nextBtn.count().catch(() => 0);
      if (!hasNext) break;

      const beforeCount = capturedResponses.length;
      await nextBtn.click({ timeout: 5000, force: true }).catch(() => {});
      await page.waitForTimeout(4000);
      if (capturedResponses.length === beforeCount) break; // no new response fired

      if (!collectFrom(capturedResponses[capturedResponses.length - 1])) break;
    }

    await page.close().catch(() => {});
  } finally {
    await closeAll(browser);
  }

  return rawPostings;
}

/**
 * Convert raw Dayforce `jobPostings[]` entries (as captured from the
 * organic `jobposting/search` response) into ParsedJob objects. Pure
 * function — no network/Playwright involved — so it can be unit-tested
 * with fixture postings without spinning up a browser.
 *
 * Filters out: postings with no usable title, postings whose only
 * location(s) are outside Switzerland (foreign-office filtering), and
 * duplicate public URLs.
 */
export function parsePostings(postings = []) {
  const jobs = [];
  const seenUrls = new Set();
  for (const posting of postings) {
    const title = normalizeSpace(posting.jobTitle || '');
    if (!title || title.length < 3) continue;

    const locations = Array.isArray(posting.postingLocations) ? posting.postingLocations : [];
    const swissLocations = locations.filter(
      (l) => normalize(l.isoCountryCode || l.countryCode || '') === 'ch',
    );
    // Foreign-office-only postings (e.g. group corporate roles outside CH) are
    // out of scope for this funnel.
    if (locations.length > 0 && swissLocations.length === 0) continue;

    const rawLoc = swissLocations[0] || locations[0] || {};
    const { city, postalCode, streetAddress, region } = resolveAddress(rawLoc);
    const location = normalizeSpace(city || HQ.city);
    const canton =
      normalizeCantonCode(rawLoc.stateCode || '') ||
      inferAnyCanton(location) ||
      inferAnyCanton(`${location} ${region}`) ||
      HQ.canton;

    const jobPostingId = String(posting.jobPostingId || posting.jobReqId || '');
    const publicUrl = jobPostingId
      ? `https://jobs.dayforcehcm.com/en-GB/bucherer/CANDIDATEPORTAL/Job/${jobPostingId}`
      : LISTING_URL;
    if (seenUrls.has(publicUrl)) continue;
    seenUrls.add(publicUrl);

    const description = resolveDescription(posting.jobDescription, title, location);
    const sourceLang = detectLang(description, 'de');
    const jobSlug = slugify(`${title} bucherer ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(`${posting.typeOfEmployment?.label || ''} ${title}`);
    const postedDate = (posting.postingStartTimestampUTC && String(posting.postingStartTimestampUTC).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${BUCHERER_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: BUCHERER_COMPANY_NAME,
      companyKey: BUCHERER_KEY,
      companyDomain: BUCHERER_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Bucherer Dedicated Parser (Dayforce CandidatePortal)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: city || location,
      addressRegion: region || canton,
      streetAddress: streetAddress || (canton === HQ.canton ? HQ.streetAddress : ''),
      postalCode: postalCode || (canton === HQ.canton ? HQ.postalCode : ''),
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      jobReqId: posting.jobReqId || jobPostingId || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  return jobs;
}

/**
 * Fetch all Bucherer jobs (Switzerland only, all cantons).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllBuchererJobs() {
  console.log(`🔍 Fetching ${BUCHERER_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);

  let postings;
  try {
    postings = await discoverAllJobPostings();
  } catch (err) {
    console.warn(`⚠️ Bucherer Dayforce fetch failed: ${err?.message || err}`);
    throw err;
  }

  if (!postings || postings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${postings.length}`);

  const jobs = parsePostings(postings);

  console.log(`\n📋 Total ${BUCHERER_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
