#!/usr/bin/env node
/**
 * Hilti (Switzerland) job parser — Fetcher and job builder.
 *
 * Source: https://careers.hilti.group/en/jobs/?country=20000532
 *
 * Platform: custom Umbraco CMS job board at careers.hilti.group. There is no
 * public Workday/Greenhouse/Lever/SuccessFactors API (some reqs carry a Workday
 * `wd-` id but applications are surfaced through this custom board). The
 * `?country=20000532` Switzerland facet is applied CLIENT-SIDE after hydration:
 *   - a plain HTTP GET (no JS) ignores the filter and returns the unfiltered
 *     ~767 worldwide jobs, and raw curl is WAF-403'd;
 *   - the internal XHR `/umbraco/jobboard/CandidateJobs/GetJobs?culture=en` is
 *     gated by an `x-ph: internal` header and returns an empty body on replay.
 * The only reliable path is a real headless browser that loads the filtered
 * listing and reads the rendered job cards (verified: 15 CH cards render). We
 * then follow each detail page and parse its schema.org JobPosting microdata
 * for the structured location/date/employmentType/description.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllHiltiJobs()  — Fetch and parse all jobs
 *   - isHiltiJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()    — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeDescriptionBullets } from './crawler-template.mjs';
import {
  resolveDetailOrListingSwissGeography,
  schemaJobLocationCandidates,
} from './prospector/location-evidence.mjs';
import {
  createBrowser,
  createPoliteContext,
  fetchWithRateLimit,
  closeAll,
  AntiBotBlockError,
  NavigationTimeout,
} from './ats-clients/playwright-runtime.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const HILTI_KEY = 'hilti';
export const HILTI_COMPANY_NAME = 'Hilti';
export const HILTI_COMPANY_DOMAIN = 'hilti.group';

const ATS_HOST = 'careers.hilti.group';
const BASE_URL = `https://${ATS_HOST}`;
// `country=20000532` is the Switzerland country facet value, captured directly
// from the live filter <option> elements. Applied client-side after hydration.
// locale-segment-ok: '/en/' is Hilti's external ATS path, not a site locale route
const CAREER_URL = `${BASE_URL}/en/jobs/?country=20000532`;

const HILTI_SECTOR = 'Construction tools & fastening technology (manufacturing)';

// Known office metadata — Hilti (Schweiz) AG, Adliswil ZH (recon). NOTE: the
// Hilti GROUP HQ in Schaan is Liechtenstein (LI), NOT Switzerland; never use it
// as job-location evidence and never classify Schaan/Nendeln jobs as CH.
const HQ = {
  addressLocality: 'Adliswil',
  canton: 'ZH',
  postalCode: '8134',
  addressRegion: 'Zürich',
};

// Realistic desktop Chrome UA — the WAF 403s the default bot UA / raw curl.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const LISTING_WAIT_SELECTOR_MS = 25_000;
const DETAIL_WAIT_SELECTOR_MS = 15_000;
// Polite spacing between detail-page fetches (15 CH jobs → single listing page).
const PER_DETAIL_DELAY_MS = 1500;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

async function safeClose(page) {
  try { if (page) await page.close(); } catch { /* no-op */ }
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Hilti.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isHiltiJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === HILTI_KEY ||
    key.startsWith('hilti') ||
    company.includes('hilti') ||
    url.includes('hilti.group')
  );
}

/**
 * Validate that a URL belongs to Hilti's domain.
 *
 * Accepts the primary corporate domain AND the real ATS posting host
 * (careers.hilti.group, a subdomain of hilti.group — already covered by the
 * subdomain check, but asserted explicitly so the contract is visible).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'hilti.group' ||
      host.endsWith('.hilti.group') ||
      host === ATS_HOST
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
  if (/\b(vendita|sales|verkauf|commerce|conseiller|berater|vertrieb)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm|cyber|digital)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ|debitor|controlling)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti|career.?starter)/.test(t)) return 'intern';
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

/* ── Date helper ──────────────────────────────────────────── */

/** Normalise an ISO-ish datePosted to "YYYY-MM-DD". Returns '' on failure. */
function toDateOnly(raw = '') {
  const m = String(raw || '').trim().match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

/* ── Schema.org extraction ─────────────────────────────────── */

/**
 * Pull the JobPosting object out of a detail page's ld+json blocks. The board
 * sometimes wraps it in an `@graph`; handle both shapes.
 */
function pickJobPosting(ldBlocks = []) {
  for (const raw of ldBlocks) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const candidates = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.['@graph'])
        ? parsed['@graph']
        : [parsed];
    const jp = candidates.find((o) => o && o['@type'] === 'JobPosting');
    if (jp) return jp;
  }
  return null;
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Render the Switzerland-filtered listing and return the rendered job cards.
 * Each card yields { url, jobReqId, title, location, team }.
 *
 * @param {import('playwright').BrowserContext} context
 */
async function fetchListingRows(context) {
  let page;
  try {
    page = await fetchWithRateLimit(context, CAREER_URL, { minDelayMs: 0 });
  } catch (err) {
    if (err instanceof AntiBotBlockError) {
      console.warn(`⚠️ Hilti listing anti-bot block: ${err.message}`);
      return [];
    }
    if (err instanceof NavigationTimeout) {
      console.warn(`⚠️ Hilti listing navigation timeout: ${err.message}`);
      return [];
    }
    throw err;
  }

  try {
    await page.waitForSelector('.card-job', {
      timeout: LISTING_WAIT_SELECTOR_MS,
      state: 'attached',
    });
  } catch {
    console.warn('   Listing: no Hilti job cards rendered within timeout');
    await safeClose(page);
    return [];
  }

  const rows = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.card-job')];
    const out = [];
    for (const card of cards) {
      const a = card.querySelector("a[href*='/jobs/']");
      const href = a?.getAttribute('href') || '';
      if (!href || /saved-jobs/.test(href)) continue;
      const idHolder = card.querySelector('[data-id]');
      const meta = card.querySelector('.job-meta');
      const metaItems = meta
        ? [...meta.querySelectorAll('li')].map((li) => (li.textContent || '').replace(/\s+/g, ' ').trim())
        : [];
      out.push({
        href,
        jobReqId: idHolder?.getAttribute('data-id') || '',
        title: (a?.textContent || '').replace(/\s+/g, ' ').trim(),
        // metaItems[0] = location text, metaItems[1] = team/department label.
        location: metaItems[0] || '',
        team: metaItems[1] || '',
      });
    }
    return out;
  });

  await safeClose(page);

  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    if (!row.href || !row.title || seen.has(row.href)) continue;
    seen.add(row.href);
    deduped.push({
      ...row,
      url: row.href.startsWith('http') ? row.href : `${BASE_URL}${row.href}`,
    });
  }
  return deduped;
}

/**
 * Open one detail page and parse its schema.org JobPosting microdata.
 * Returns { datePosted, employmentType, addressLocality, addressRegion,
 * addressCountry, location, description } or null on failure.
 *
 * @param {import('playwright').BrowserContext} context
 */
async function fetchDetailPage(context, url) {
  let page;
  try {
    page = await fetchWithRateLimit(context, url, { minDelayMs: PER_DETAIL_DELAY_MS });
    await page
      .waitForSelector('script[type="application/ld+json"]', {
        timeout: DETAIL_WAIT_SELECTOR_MS,
        state: 'attached',
      })
      .catch(() => { /* fall through — may have body-only content */ });

    const ldBlocks = await page.$$eval(
      'script[type="application/ld+json"]',
      (els) => els.map((e) => e.textContent || ''),
    );
    await safeClose(page);
    page = null;

    const jp = pickJobPosting(ldBlocks);
    if (!jp) return null;

    const locationCandidates = schemaJobLocationCandidates(jp.jobLocation);
    const primaryLocation = locationCandidates[0];
    const description = normalizeDescriptionBullets(stripHtml(jp.description || ''));

    return {
      datePosted: toDateOnly(jp.datePosted || ''),
      employmentType: typeof jp.employmentType === 'string' ? jp.employmentType : '',
      addressLocality: primaryLocation?.addressLocality || '',
      addressRegion: primaryLocation?.addressRegion || '',
      addressCountry: primaryLocation?.addressCountry || '',
      locationCandidates,
      description,
    };
  } catch (err) {
    if (err instanceof AntiBotBlockError) {
      console.warn(`   ⚠️ Anti-bot block on detail ${url}: ${err.message}`);
    } else if (err instanceof NavigationTimeout) {
      console.warn(`   ⚠️ Detail navigation timeout: ${url}`);
    } else {
      console.warn(`   ⚠️ Detail fetch error on ${url}: ${err?.message || err}`);
    }
    return null;
  } finally {
    if (page) await safeClose(page);
  }
}

async function fetchJobListings() {
  console.log(`   Fetching from: ${CAREER_URL}`);

  let browser;
  try {
    browser = await createBrowser({ userAgent: BROWSER_UA });
    const context = await createPoliteContext(browser, { userAgent: BROWSER_UA });

    const rows = await fetchListingRows(context);
    console.log(`  📋 Discovered ${rows.length} job cards (Playwright)`);
    if (rows.length === 0) return [];

    const listings = [];
    for (const row of rows) {
      const detail = await fetchDetailPage(context, row.url);

      listings.push({
        title: row.title,
        location: row.location || '',
        url: row.url,
        jobReqId: row.jobReqId,
        team: row.team,
        postedAt: detail?.datePosted || '',
        description: detail?.description || '',
        employmentType: detail?.employmentType || '',
        addressLocality: detail?.addressLocality || '',
        addressRegion: detail?.addressRegion || '',
        addressCountry: detail?.addressCountry || '',
        locationCandidates: detail?.locationCandidates || [],
      });
    }
    return listings;
  } catch (err) {
    console.warn(`⚠️ Hilti fetch failed: ${err?.message || err}`);
    return [];
  } finally {
    if (browser) await closeAll(browser);
  }
}

export function resolveHiltiListingGeography(listing = {}) {
  return resolveDetailOrListingSwissGeography(
    {
      locationCandidates: listing.locationCandidates || [],
      location: [listing.addressLocality, listing.addressRegion].filter(Boolean).join(', '),
      addressCountry: listing.addressCountry || '',
    },
    { location: listing.location || '' },
  );
}

/**
 * Fetch all Hilti (Switzerland) jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllHiltiJobs() {
  console.log(`🔍 Fetching Hilti (Switzerland) jobs`);
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

    const decision = resolveHiltiListingGeography(listing);
    const geography = decision.geography;
    if (!geography) {
      console.log(`   ⏭️  Skipping non-CH or locationless job: ${title}`);
      continue;
    }
    const { location, canton } = geography;
    const evidence = decision.candidate;
    const descriptionText = stripHtml(listing.description || '');
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} hilti ch`);
    // Stable id: prefer the board's numeric/wd- req id, fall back to URL hash.
    const stableId = (listing.jobReqId || '')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '');
    const idSuffix = stableId
      || createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `hilti-${idSuffix}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: HILTI_COMPANY_NAME,
      companyKey: HILTI_KEY,
      companyDomain: HILTI_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — ${HILTI_COMPANY_NAME}`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — ${HILTI_COMPANY_NAME}` },
      location,
      canton,
      url: publicUrl,
      source: 'Hilti Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: evidence.addressLocality || location.split(',')[0].trim(),
      postalCode: evidence.postalCode || (location.startsWith(HQ.addressLocality) ? HQ.postalCode : ''),
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(`${title} ${listing.team || ''}`),
      contract: 'full-time',
      employmentType: listing.employmentType || detectEmploymentType(title),
      experienceLevel: detectExperienceLevel(title),
      sector: HILTI_SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedAt || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Hilti jobs discovered: ${jobs.length}`);
  return jobs;
}

export { slugify, stripHtml };
