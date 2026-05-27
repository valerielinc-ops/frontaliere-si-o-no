#!/usr/bin/env node
/**
 * Givaudan job parser — Fetcher and job builder.
 *
 * Source: https://careers.givaudan.com/global/en/europe
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllGivaudanJobs()  — Fetch and parse all jobs
 *   - isGivaudanJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const GIVAUDAN_KEY = 'givaudan';
export const GIVAUDAN_COMPANY_NAME = 'Givaudan';
export const GIVAUDAN_COMPANY_DOMAIN = 'givaudan.com';

// Phenom People search-results URL with the Switzerland country filter applied.
// `from=0` is the offset; pagination is offset-based in 10s.
const SEARCH_URL =
  'https://careers.givaudan.com/global/en/jobs-search-results?from=0&s=1&rk=l-switzerland';
const CAREER_URL = 'https://careers.givaudan.com/global/en/europe';

const PHENOM_RESULTS_SELECTOR =
  '[data-ph-id="ph-page-element-page9-job-results"]';
const PHENOM_CARD_SELECTOR =
  '[data-ph-id*="ph-page-element-page9-Y2H56N"], li.jobs-list-item, article.job-result, [data-ph-at-job-title-text]';
const PHENOM_LOAD_MORE_SELECTOR =
  '[data-ph-at-id="pagination-load-more"], button[aria-label*="Load more" i], button.load-more';
const SWISS_LOCATION_RX =
  /\b(switzerland|suisse|svizzera|schweiz|geneva|gen[èe]ve|geneve|vernier|kemptthal|d[üu]bendorf|wallisellen|ch)\b/i;

const PAGE_LIMIT = 10; // Hard cap on pagination loops
const CARD_HARD_CAP = 200;
const ACTION_DELAY_MS = 5_000;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Givaudan.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isGivaudanJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === GIVAUDAN_KEY ||
    key.startsWith('givaudan') ||
    company.includes('givaudan') ||
    url.includes('givaudan.com')
  );
}

/**
 * Validate that a URL belongs to Givaudan's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'givaudan.com' || host.endsWith('.givaudan.com');
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

/* ── Fetch + Parse ─────────────────────────────────────────── */

// TODO: Implement the actual fetching logic for Givaudan's career page.
// This is a placeholder. Replace with the actual API/scraping logic.
//
// Common patterns:
//   - JSON API:     use --source api for a ready-made paginated API template
//   - Workday API:  re-scaffold with --ats=workday for a ready-made template
//   - Greenhouse:   --ats=greenhouse
//   - Lever:        --ats=lever
//   - SuccessFactors: --ats=successfactors
//   - Generic HTML: fetch + parse with regex or cheerio

/* ── Givaudan / Phenom People notes ────────────────────────────
 * Givaudan careers run on Phenom People (CareerConnect). The site is a
 * client-rendered SPA — `careers.givaudan.com/global/en/europe` returns
 * 0 job links via plain `fetch`. The Phenom REST APIs we probed
 * (/api/jobs, /api/jobs/locations/Switzerland, /widgets) all return
 * 500 / "Tenant not identified" / 404 from a server-side caller without
 * a browser session that primes the Phenom tenant cookie + CSRF token.
 *
 * Approach: drive Phenom with Playwright through `playwright-runtime.mjs`.
 *  1. Land on the search-results URL with the Switzerland filter applied
 *     (`?rk=l-switzerland`). Phenom hydrates the cards SPA-side.
 *  2. Wait for the results container `[data-ph-id="ph-page-element-page9-
 *     job-results"]` (or fall back to a generic results selector).
 *  3. Extract title / location / applyUrl / postedDate by reading the
 *     hydrated DOM via `page.$$eval`.
 *  4. Click the "Load more" button until it disappears or we hit a hard cap.
 *  5. Filter to Swiss locations (Switzerland / Vernier / Geneva / Kemptthal
 *     / Dübendorf …) — the URL filter alone is sometimes loose, so we
 *     belt-and-braces with a regex post-filter.
 *  6. Polite: 5s delay between actions (handled by `fetchWithRateLimit` and
 *     an explicit sleep around clicks).
 *
 * If selectors drift (Phenom rebrands the SPA every few quarters) the
 * function returns []; the caller treats that as "no jobs" and the parser
 * falls back to a stub. First live dispatch will validate selectors.
 */

/**
 * Default Playwright runtime factory — re-exposed so tests can swap it for
 * a stubbed runtime via the `_runtime` option without touching the call site.
 *
 * @returns {Promise<{
 *   createBrowser: typeof import('./ats-clients/playwright-runtime.mjs')['createBrowser'],
 *   createPoliteContext: typeof import('./ats-clients/playwright-runtime.mjs')['createPoliteContext'],
 *   fetchWithRateLimit: typeof import('./ats-clients/playwright-runtime.mjs')['fetchWithRateLimit'],
 *   closeAll: typeof import('./ats-clients/playwright-runtime.mjs')['closeAll'],
 *   AntiBotBlockError: typeof import('./ats-clients/playwright-runtime.mjs')['AntiBotBlockError'],
 *   NavigationTimeout: typeof import('./ats-clients/playwright-runtime.mjs')['NavigationTimeout'],
 *   BrowserLaunchError: typeof import('./ats-clients/playwright-runtime.mjs')['BrowserLaunchError'],
 * }>}
 */
async function defaultRuntimeFactory() {
  return import('./ats-clients/playwright-runtime.mjs');
}

/**
 * Pause helper used between paginated clicks — kept module-local so tests
 * can shorten it via `_sleepMs`.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read the visible card data out of the Phenom-hydrated DOM.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{title:string,location:string,url:string,postedDate:string}>>}
 */
async function extractCards(page) {
  return page.$$eval(
    PHENOM_CARD_SELECTOR,
    /* eslint-disable-next-line no-undef */
    (nodes) =>
      nodes
        .map((node) => {
          const titleEl =
            node.querySelector('[data-ph-at-job-title-text]') ||
            node.querySelector('.job-title') ||
            node.querySelector('a[href*="/job/"]') ||
            node.querySelector('h3') ||
            node.querySelector('h2');
          const locationEl =
            node.querySelector('[data-ph-at-job-location-text]') ||
            node.querySelector('.job-location') ||
            node.querySelector('.location');
          const linkEl =
            node.querySelector('a[href*="/job/"]') ||
            node.querySelector('a[href*="careers.givaudan.com"]') ||
            node.querySelector('a[href]');
          const dateEl =
            node.querySelector('[data-ph-at-job-post-date-text]') ||
            node.querySelector('.posted-date') ||
            node.querySelector('time');

          const title = (titleEl?.textContent || '').trim();
          const location = (locationEl?.textContent || '').trim();
          const url = linkEl?.getAttribute('href') || '';
          const postedDate =
            (dateEl?.getAttribute('datetime') || dateEl?.textContent || '').trim();

          return { title, location, url, postedDate };
        })
        .filter((card) => card.title && card.url),
  );
}

/**
 * Click the Phenom "Load more" button if present and visible. Returns
 * `true` if a click was attempted, `false` if the button is gone.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
async function clickLoadMore(page) {
  try {
    const button = await page.$(PHENOM_LOAD_MORE_SELECTOR);
    if (!button) return false;
    const isVisible = await button.isVisible().catch(() => false);
    if (!isVisible) return false;
    await button.click({ timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a Phenom card href to an absolute URL on the careers domain.
 *
 * @param {string} href
 * @returns {string}
 */
function resolveApplyUrl(href = '') {
  if (!href) return SEARCH_URL;
  if (/^https?:\/\//i.test(href)) return href;
  try {
    return new URL(href, 'https://careers.givaudan.com').toString();
  } catch {
    return SEARCH_URL;
  }
}

/**
 * Drive Phenom People with Playwright and return raw card payloads.
 *
 * Errors are caught and degraded to `[]` so the larger crawler keeps moving:
 * Phenom is known to A/B-test its selectors, so a structural mismatch should
 * not break the whole jobs pipeline.
 *
 * @param {object} [options]
 * @param {() => Promise<unknown>} [options._runtime]
 *   Test seam — replace the runtime module factory with a stub.
 * @param {number} [options._sleepMs]
 *   Test seam — override the inter-action delay.
 * @returns {Promise<Array<{
 *   title: string,
 *   location: string,
 *   url: string,
 *   postedDate: string,
 * }>>}
 */
async function fetchJobListings(options = {}) {
  const runtimeFactory = options._runtime || defaultRuntimeFactory;
  const sleepMs =
    typeof options._sleepMs === 'number' ? options._sleepMs : ACTION_DELAY_MS;

  let runtime;
  try {
    runtime = await runtimeFactory();
  } catch (err) {
    console.warn(
      `   ⚠️ Givaudan: could not load Playwright runtime (${err?.message || err}). Returning [].`,
    );
    return [];
  }

  const {
    createBrowser,
    createPoliteContext,
    fetchWithRateLimit,
    closeAll,
    AntiBotBlockError,
    NavigationTimeout,
    BrowserLaunchError,
  } = runtime;

  console.log(`   Fetching from: ${SEARCH_URL}`);

  let browser = null;
  try {
    browser = await createBrowser();
    const context = await createPoliteContext(browser);
    const page = await fetchWithRateLimit(context, SEARCH_URL);

    // Wait for Phenom to hydrate the results container. If the selector ever
    // drifts, fall back to waiting for any anchor that points at /job/.
    try {
      await page.waitForSelector(PHENOM_RESULTS_SELECTOR, { timeout: 15_000 });
    } catch {
      try {
        await page.waitForSelector('a[href*="/job/"]', { timeout: 10_000 });
      } catch {
        console.warn(
          '   ⚠️ Givaudan: Phenom results container never appeared — selectors may have changed. Returning [].',
        );
        return [];
      }
    }

    const seen = new Set();
    const out = [];

    for (let pageIdx = 0; pageIdx < PAGE_LIMIT; pageIdx++) {
      const cards = await extractCards(page);
      for (const card of cards) {
        const key = card.url || `${card.title}|${card.location}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          ...card,
          url: resolveApplyUrl(card.url),
        });
        if (out.length >= CARD_HARD_CAP) break;
      }
      if (out.length >= CARD_HARD_CAP) break;

      const clicked = await clickLoadMore(page);
      if (!clicked) break;
      await sleep(sleepMs);
      // Give Phenom time to append more results to the list.
      try {
        await page.waitForLoadState('networkidle', { timeout: 10_000 });
      } catch {
        // networkidle isn't reliable on Phenom; carry on.
      }
    }

    // Belt-and-braces filter: keep only jobs whose location string looks Swiss.
    const swissOnly = out.filter((card) => {
      if (!card.location) return false;
      return SWISS_LOCATION_RX.test(card.location);
    });

    console.log(
      `   ✅ Givaudan Phenom returned ${out.length} cards (${swissOnly.length} Swiss).`,
    );
    return swissOnly;
  } catch (err) {
    if (
      AntiBotBlockError && err instanceof AntiBotBlockError
    ) {
      console.warn(
        `   ⚠️ Givaudan: anti-bot block (status=${err.status}, title=${JSON.stringify(err.title || '')}). Returning [].`,
      );
      return [];
    }
    if (NavigationTimeout && err instanceof NavigationTimeout) {
      console.warn(
        `   ⚠️ Givaudan: navigation timeout for ${err.url || SEARCH_URL}. Returning [].`,
      );
      return [];
    }
    if (BrowserLaunchError && err instanceof BrowserLaunchError) {
      console.warn(
        `   ⚠️ Givaudan: browser launch failed (${err.message}). Returning [].`,
      );
      return [];
    }
    console.warn(
      `   ⚠️ Givaudan: unexpected scraper error (${err?.message || err}). Returning [].`,
    );
    return [];
  } finally {
    if (browser) {
      await closeAll(browser);
    }
  }
}

// Internal export for test injection — not part of the public crawler contract.
export const __testables = {
  fetchJobListings,
  resolveApplyUrl,
  SWISS_LOCATION_RX,
  SEARCH_URL,
};

/**
 * Fetch all Givaudan jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 *
 * @param {object} [options]
 * @param {() => Promise<unknown>} [options._runtime] Test seam — Playwright runtime factory.
 * @param {number} [options._sleepMs] Test seam — inter-action delay.
 */
export async function fetchAllGivaudanJobs(options = {}) {
  console.log(`🔍 Fetching Givaudan jobs`);
  console.log(`   Source: ${SEARCH_URL}\n`);

  const listings = await fetchJobListings(options);
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    // TODO: Extract fields from each listing.
    // Adapt these field names to match the actual API response.
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const location = listing.location || 'Vernier'; // Givaudan global HQ
    const canton = inferSwissTargetCanton(location) || 'GE';
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} givaudan ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `givaudan-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: GIVAUDAN_COMPANY_NAME,
      companyKey: GIVAUDAN_KEY,
      companyDomain: GIVAUDAN_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Givaudan`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Givaudan` },
      location,
      canton,
      url: publicUrl,
      source: 'Givaudan Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(listing.timeType || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Industria', // Flavours & fragrances / specialty chemicals
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300)); // Rate limiting
  }

  console.log(`\n📋 Total Givaudan jobs discovered: ${jobs.length}`);
  return jobs;
}
