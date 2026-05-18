#!/usr/bin/env node
/**
 * Vaudoise Assurances job parser — Fetcher and job builder.
 *
 * Source: https://www.vaudoise.ch/fr/carrieres/postes-disponibles which links
 * out to the Softgarden public job-board:
 *   https://vaudoise.softgarden.io/   (≈ 75 jobs, single page, no pagination)
 *
 * The Softgarden page is server-rendered HTML (Wicket framework). All ~75
 * jobs render in `<div class="matchElement" id="job_id_*">` rows on first
 * load — there is no pagination or "load more" button. No anti-bot
 * (verified 2026-05-10). We still drive it through `playwright-runtime.mjs`
 * to inherit the project-wide retry / timeout / proxy / image-block hooks
 * and stay consistent with other Tier-3 marquee parsers.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllVaudoiseJobs()  — Fetch and parse all jobs
 *   - isVaudoiseJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()       — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const VAUDOISE_KEY = 'vaudoise';
export const VAUDOISE_COMPANY_NAME = 'Vaudoise Assurances';
export const VAUDOISE_COMPANY_DOMAIN = 'vaudoise.ch';

const CAREER_URL = 'https://www.vaudoise.ch/fr/carrieres/postes-disponibles';
const SOFTGARDEN_BASE = 'https://vaudoise.softgarden.io';
const SOFTGARDEN_LISTING_URL = `${SOFTGARDEN_BASE}/`;

// Each job is rendered as a <div class="matchElement" id="job_id_{id}">. The
// title link sits inside `.matchValue.title > a`, the location text in
// `.matchValue.ProjectGeoLocationCity .location-view-item`, the date in
// `.matchValue.date`, the audience (experience level) in
// `.matchValue.audience`, and the job category in `.matchValue.jobcategory`.
const ROW_SELECTOR = 'div.matchElement[id^="job_id_"]';

// Belt-and-braces filter: Softgarden returns the full Vaudoise board
// (mostly Swiss). Keep only Swiss-looking locations.
const SWISS_LOCATION_RX =
  /\b(switzerland|suisse|svizzera|schweiz|lausanne|gen[èe]ve|geneva|fribourg|bern|berne|zurich|z[üu]rich|basel|b[âa]le|sion|sierre|neuch[âa]tel|delemont|del[ée]mont|lugano|bellinzona|nyon|morges|montreux|vevey|yverdon|aigle|payerne|romanel|ch[âa]teau|ch)\b/i;

const ROW_HARD_CAP = 200;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Vaudoise Assurances.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isVaudoiseJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === VAUDOISE_KEY ||
    key.startsWith('vaudoise') ||
    company.includes('vaudoise assurances') ||
    url.includes('vaudoise.ch')
  );
}

/**
 * Validate that a URL belongs to Vaudoise Assurances's domain.
 *
 * Trusts both the corporate domain (vaudoise.ch + subdomains) and the
 * Softgarden ATS subdomain (`vaudoise.softgarden.io`), which is where the
 * public job postings actually live. Without the ATS host the dedicated
 * locale-validation gate flags every job as `url_not_vaudoise_domain` and
 * the crawler exits 1 (49/49 issues, GH run 26004869125 + history).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'vaudoise.ch' ||
      host.endsWith('.vaudoise.ch') ||
      host === 'vaudoise.softgarden.io'
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

function detectExperienceLevel(title = '', audience = '') {
  const a = normalize(audience);
  if (/premier emploi|graduate|junior|entry/.test(a)) return 'junior';
  if (/exp[ée]riment|senior/.test(a)) return 'senior';
  if (/stage|stagiair|intern|apprend|lehrling|lernend|apprenti/.test(a)) return 'intern';

  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  // Vaudoise titles encode "80-100%" — anything < 100% is part-time.
  if (/\b(\d{1,2})\s*-\s*\d{1,3}\s*%/.test(t)) {
    const match = t.match(/\b(\d{1,2})\s*-\s*(\d{1,3})\s*%/);
    if (match) {
      const lo = Number(match[1]);
      const hi = Number(match[2]);
      if (hi < 100 || lo < 100) return 'PART_TIME';
    }
  }
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Softgarden URL helpers ────────────────────────────────── */

/**
 * Resolve a Softgarden listing href (relative `../job/{id}/...`) to an
 * absolute URL on `vaudoise.softgarden.io`.
 *
 * @param {string} href
 * @returns {string}
 */
function resolveApplyUrl(href = '') {
  if (!href) return SOFTGARDEN_LISTING_URL;
  if (/^https?:\/\//i.test(href)) return href;
  try {
    return new URL(href, `${SOFTGARDEN_BASE}/`).toString();
  } catch {
    return SOFTGARDEN_LISTING_URL;
  }
}

/**
 * Default Playwright runtime factory — re-exposed so tests can swap it for
 * a stubbed runtime via the `_runtime` option without touching the call site.
 */
async function defaultRuntimeFactory() {
  return import('./ats-clients/playwright-runtime.mjs');
}

/**
 * Read the Softgarden match-elements out of the currently-loaded page.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{
 *   title: string,
 *   url: string,
 *   location: string,
 *   postedDate: string,
 *   audience: string,
 *   jobCategory: string,
 *   id: string,
 * }>>}
 */
async function extractRows(page) {
  return page.$$eval(
    ROW_SELECTOR,
    /* eslint-disable-next-line no-undef */
    (rows) =>
      rows
        .map((row) => {
          const idAttr = row.getAttribute('id') || '';
          const idMatch = idAttr.match(/job_id_(\d+)/);
          const id = idMatch ? idMatch[1] : '';
          const link =
            row.querySelector('.matchValue.title a[href]') ||
            row.querySelector('a[href*="/job/"]');
          const title = (link?.textContent || '').trim();
          const href = link?.getAttribute('href') || '';
          const locationEl =
            row.querySelector('.matchValue.ProjectGeoLocationCity .location-view-item') ||
            row.querySelector('.location-view-item');
          const location = (locationEl?.textContent || '').trim();
          const dateEl = row.querySelector('.matchValue.date');
          const postedDate = (dateEl?.textContent || '').trim();
          const audienceEl = row.querySelector('.matchValue.audience');
          const audience = (audienceEl?.textContent || '').trim();
          const categoryEl = row.querySelector('.matchValue.jobcategory');
          const jobCategory = (categoryEl?.textContent || '').trim();
          return {
            title,
            url: href,
            location,
            postedDate,
            audience,
            jobCategory,
            id,
          };
        })
        .filter((r) => r.title && r.url),
  );
}

/**
 * Drive the Softgarden listing with Playwright and return raw rows.
 * Errors are degraded to `[]` so the larger crawler keeps moving.
 *
 * @param {object} [options]
 * @param {() => Promise<unknown>} [options._runtime] Test seam.
 * @returns {Promise<Array<object>>}
 */
async function fetchJobListings(options = {}) {
  const runtimeFactory = options._runtime || defaultRuntimeFactory;

  let runtime;
  try {
    runtime = await runtimeFactory();
  } catch (err) {
    console.warn(
      `   ⚠️ Vaudoise: could not load Playwright runtime (${err?.message || err}). Returning [].`,
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

  console.log(`   Fetching from: ${SOFTGARDEN_LISTING_URL}`);

  let browser = null;
  try {
    browser = await createBrowser();
    const context = await createPoliteContext(browser);
    const page = await fetchWithRateLimit(context, SOFTGARDEN_LISTING_URL);

    try {
      await page.waitForSelector(ROW_SELECTOR, { timeout: 15_000 });
    } catch {
      console.warn(
        '   ⚠️ Vaudoise: Softgarden rows never appeared — selectors may have changed. Returning [].',
      );
      return [];
    }

    const rows = await extractRows(page);
    const seen = new Set();
    const out = [];

    for (const row of rows) {
      const key = row.id || row.url;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ...row,
        url: resolveApplyUrl(row.url),
      });
      if (out.length >= ROW_HARD_CAP) break;
    }

    // Belt-and-braces Swiss filter — softgarden may surface CH-adjacent
    // postings; keep only Swiss locations to honour CH-wide cathedral scope.
    const swissOnly = out.filter((row) => {
      if (!row.location) return false;
      return SWISS_LOCATION_RX.test(row.location);
    });

    console.log(
      `   ✅ Vaudoise Softgarden returned ${out.length} cards (${swissOnly.length} Swiss).`,
    );
    return swissOnly;
  } catch (err) {
    if (AntiBotBlockError && err instanceof AntiBotBlockError) {
      console.warn(
        `   ⚠️ Vaudoise: anti-bot block (status=${err.status}, title=${JSON.stringify(err.title || '')}). Returning [].`,
      );
      return [];
    }
    if (NavigationTimeout && err instanceof NavigationTimeout) {
      console.warn(
        `   ⚠️ Vaudoise: navigation timeout for ${err.url || SOFTGARDEN_LISTING_URL}. Returning [].`,
      );
      return [];
    }
    if (BrowserLaunchError && err instanceof BrowserLaunchError) {
      console.warn(
        `   ⚠️ Vaudoise: browser launch failed (${err.message}). Returning [].`,
      );
      return [];
    }
    console.warn(
      `   ⚠️ Vaudoise: unexpected scraper error (${err?.message || err}). Returning [].`,
    );
    return [];
  } finally {
    if (browser) {
      await closeAll(browser);
    }
  }
}

/* ── Detail-page description extraction ────────────────────── */

const DETAIL_FETCH_UA =
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch)';
const DETAIL_FETCH_TIMEOUT_MS = 15_000;

/**
 * Parse a Softgarden job-detail HTML page and extract the long description
 * from the embedded JSON-LD `JobPosting`. Returns plain text (HTML stripped)
 * or `''` when unavailable.
 *
 * @param {string} html
 * @returns {string}
 */
export function parseVaudoiseDetailHtml(html = '') {
  if (!html || typeof html !== 'string') return '';
  const ldMatch = html.match(
    /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!ldMatch) return '';
  try {
    const ld = JSON.parse(ldMatch[1]);
    const candidates = Array.isArray(ld) ? ld : [ld];
    for (const entry of candidates) {
      if (!entry || typeof entry !== 'object') continue;
      const type = entry['@type'];
      const isJobPosting =
        type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
      if (isJobPosting && entry.description) {
        return normalizeSpace(stripHtml(String(entry.description)));
      }
    }
  } catch {
    /* ignore parse errors — fall through to '' */
  }
  return '';
}

/**
 * Default `fetch` wrapper used to pull Softgarden detail pages. Isolated so
 * tests can inject a stub via the `_detailFetcher` option without touching
 * the global `fetch`.
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
async function defaultDetailFetcher(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DETAIL_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': DETAIL_FETCH_UA, Accept: 'text/html' },
      signal: controller.signal,
    });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch and parse the long description for a single detail URL.
 *
 * @param {string} url
 * @param {(url: string) => Promise<string>} [fetcher]
 * @returns {Promise<string>}
 */
export async function fetchVaudoiseDescription(url, fetcher = defaultDetailFetcher) {
  if (!url) return '';
  const html = await fetcher(url);
  if (!html) return '';
  return parseVaudoiseDetailHtml(html);
}

// Internal export for test injection — not part of the public crawler contract.
export const __testables = {
  fetchJobListings,
  resolveApplyUrl,
  parseVaudoiseDetailHtml,
  fetchVaudoiseDescription,
  defaultDetailFetcher,
  SWISS_LOCATION_RX,
  SOFTGARDEN_LISTING_URL,
  SOFTGARDEN_BASE,
  ROW_SELECTOR,
};

/**
 * Fetch all Vaudoise Assurances jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 *
 * @param {object} [options]
 * @param {() => Promise<unknown>} [options._runtime] Test seam — Playwright runtime factory.
 * @param {(url: string) => Promise<string>} [options._detailFetcher] Test seam — Softgarden detail-page fetcher.
 */
export async function fetchAllVaudoiseJobs(options = {}) {
  console.log(`🔍 Fetching Vaudoise Assurances jobs`);
  console.log(`   Source: ${SOFTGARDEN_LISTING_URL}\n`);

  const listings = await fetchJobListings(options);
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const detailFetcher = options._detailFetcher || defaultDetailFetcher;

  const jobs = [];
  let detailFilled = 0;
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const location = listing.location || 'Lausanne'; // HQ: Lausanne (VD)
    const canton = inferSwissTargetCanton(location) || 'VD';
    const publicUrl = listing.url || SOFTGARDEN_LISTING_URL;

    // Softgarden listing rows do NOT include the long description — only
    // title/location/date/category. Fetch the detail page and pull the
    // JSON-LD `JobPosting.description` so source-locale descriptions are
    // real content (≥120 chars) instead of a `"${title} — Vaudoise…"`
    // stub. Without this every job tripped the locale-validation gate's
    // `untranslated_description` check after hardening copied the stub
    // into every locale slot (GH run 26004869125).
    let descriptionText = '';
    try {
      descriptionText = await fetchVaudoiseDescription(publicUrl, detailFetcher);
    } catch {
      descriptionText = '';
    }
    if (descriptionText && descriptionText.length >= 120) {
      detailFilled += 1;
    } else if (listing.description) {
      descriptionText = stripHtml(listing.description);
    }

    const sourceLang = detectLang(descriptionText || title, 'fr');
    const jobSlug = slugify(`${title} vaudoise ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `vaudoise-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: VAUDOISE_COMPANY_NAME,
      companyKey: VAUDOISE_KEY,
      companyDomain: VAUDOISE_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Vaudoise Assurances`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Vaudoise Assurances` },
      location,
      canton,
      url: publicUrl,
      source: 'Vaudoise Assurances Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(title),
      experienceLevel: detectExperienceLevel(title, listing.audience || ''),
      sector: 'Assicurazioni', // Insurance (life, non-life, pensions)
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      jobCategory: listing.jobCategory || undefined,
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 100)); // Rate limiting
  }

  console.log(
    `\n📋 Total Vaudoise Assurances jobs discovered: ${jobs.length} ` +
      `(${detailFilled} with real detail-page descriptions).`,
  );
  return jobs;
}

// Re-export CAREER_URL for the workflow runner banner.
export { CAREER_URL };
