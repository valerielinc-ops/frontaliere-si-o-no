#!/usr/bin/env node
/**
 * Bobst job parser — Fetcher and job builder.
 *
 * Source: https://careers.bobst.com/en (AEM landing) which embeds the public
 * Umantis (Abacus-Umantis) job board at:
 *   https://jobs.bobst.com/Jobs/All?DesignID=10008&lang=eng
 *
 * The Umantis listing is server-rendered HTML inside an `<iframe>` — selectors
 * are stable and there is no Cloudflare/Akamai protection (verified
 * 2026-05-10). We still drive it through `playwright-runtime.mjs` so we
 * inherit the project-wide retry / timeout / proxy / image-block hooks and
 * stay consistent with other Tier-3 marquee parsers.
 *
 * Pagination: `?tc1152481=p{n}` — 10 entries per page, walked until we hit
 * the same first-job-id we saw on page 1 (Umantis wraps when n exceeds the
 * total) or until the page returns no rows.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllBobstJobs()   — Fetch and parse all jobs
 *   - isBobstJob()          — Match jobs belonging to this company
 *   - isTrustedDomain()     — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const BOBST_KEY = 'bobst';
export const BOBST_COMPANY_NAME = 'Bobst';
export const BOBST_COMPANY_DOMAIN = 'bobst.com';

const CAREER_URL = 'https://careers.bobst.com/en';
// Umantis embed (the AEM page proxies this via iframe).
const UMANTIS_BASE = 'https://jobs.bobst.com';
const UMANTIS_LISTING_URL = `${UMANTIS_BASE}/Jobs/All?message=&DesignID=10008&lang=eng`;
const UMANTIS_TABLE_PARAM = 'tc1152481';

// Each <tr class="tableaslist_contentrow1|2"> is one vacancy. The single <td>
// inside groups several <span class="tableaslist_subtitle"> chunks each
// prefixed with a leading "|" — we tokenize on "|" to extract Type / Term /
// Department / Location, etc.
const ROW_SELECTOR = 'tr.tableaslist_contentrow1, tr.tableaslist_contentrow2';
const TITLE_LINK_SELECTOR = 'a.HSTableLinkSubTitle';

const PAGE_LIMIT = 30; // Hard cap on pagination loops (~300 jobs)
const ROW_HARD_CAP = 300;
const ACTION_DELAY_MS = 1_500;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Bobst.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isBobstJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === BOBST_KEY ||
    key.startsWith('bobst') ||
    company.includes('bobst') ||
    url.includes('bobst.com')
  );
}

/**
 * Validate that a URL belongs to Bobst's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'bobst.com' || host.endsWith('.bobst.com');
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

/* ── Umantis URL helpers ───────────────────────────────────── */

/**
 * Build the Umantis pagination URL for page index `n` (1-based).
 *
 * @param {number} n 1-based page number.
 * @returns {string}
 */
function buildPageUrl(n) {
  const url = new URL(UMANTIS_LISTING_URL);
  url.searchParams.set(UMANTIS_TABLE_PARAM, `p${n}`);
  return url.toString();
}

/**
 * Resolve a Umantis Description href to an absolute URL on jobs.bobst.com.
 *
 * @param {string} href
 * @returns {string}
 */
function resolveApplyUrl(href = '') {
  if (!href) return UMANTIS_LISTING_URL;
  if (/^https?:\/\//i.test(href)) return href;
  try {
    return new URL(href, UMANTIS_BASE).toString();
  } catch {
    return UMANTIS_LISTING_URL;
  }
}

/**
 * Parse the Umantis row's "<td>" cell text (with `|`-separated subtitle spans)
 * into a {location, employmentType, department} bag. Every field is optional.
 *
 * @param {string} cellText The full normalized text of the row's `<td>`.
 * @param {string} title The already-extracted vacancy title (used to strip).
 */
function parseRowMetadata(cellText, title) {
  const out = {
    location: '',
    employmentType: '',
    department: '',
    contractTerm: '',
    postedDate: '',
  };

  if (!cellText) return out;

  // Strip the title chunk to leave the metadata.
  let rest = cellText;
  if (title) {
    const idx = rest.indexOf(title);
    if (idx >= 0) rest = rest.slice(idx + title.length);
  }

  // Posted date — "Online since: dd.mm.yyyy" appears before the title.
  const onlineSince = cellText.match(/Online since:\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i);
  if (onlineSince) out.postedDate = onlineSince[1];

  const segments = rest
    .split('|')
    .map((s) => normalizeSpace(s))
    .filter(Boolean);

  for (const seg of segments) {
    const lower = seg.toLowerCase();
    if (lower.startsWith('type:')) {
      out.employmentType = normalizeSpace(seg.slice(5));
    } else if (lower.startsWith('term of employment:')) {
      out.contractTerm = normalizeSpace(seg.slice('term of employment:'.length));
    } else if (lower.startsWith('department:')) {
      out.department = normalizeSpace(seg.slice('department:'.length));
    } else if (lower.startsWith('starting as:')) {
      // ignored, but skip so it does not get classed as a location
    } else if (
      // Location is the only segment with no "key:" prefix and looks like a place.
      !seg.includes(':') &&
      seg.length >= 3 &&
      seg.length <= 80 &&
      !out.location
    ) {
      out.location = seg;
    }
  }
  return out;
}

/**
 * Default Playwright runtime factory — re-exposed so tests can swap it for
 * a stubbed runtime via the `_runtime` option without touching the call site.
 */
async function defaultRuntimeFactory() {
  return import('./ats-clients/playwright-runtime.mjs');
}

/** Pause helper — kept module-local so tests can shorten it via `_sleepMs`. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read the Umantis listing rows out of the currently-loaded page.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{title:string,href:string,cellText:string}>>}
 */
async function extractRows(page) {
  return page.$$eval(
    ROW_SELECTOR,
    /* eslint-disable-next-line no-undef */
    (rows, opts) => {
      const titleSel = opts.titleLinkSelector;
      return rows
        .map((row) => {
          const link = row.querySelector(titleSel);
          if (!link) return null;
          const title = (link.textContent || '').trim();
          const href = link.getAttribute('href') || '';
          const cellText = (row.textContent || '').replace(/\s+/g, ' ').trim();
          return { title, href, cellText };
        })
        .filter((r) => r && r.title && r.href);
    },
    { titleLinkSelector: TITLE_LINK_SELECTOR },
  );
}

/**
 * Drive the Umantis paginated listing with Playwright and return raw rows.
 *
 * Errors are caught and degraded to `[]` so the larger crawler keeps moving.
 *
 * @param {object} [options]
 * @param {() => Promise<unknown>} [options._runtime] Test seam — replace the
 *   runtime module factory with a stub.
 * @param {number} [options._sleepMs] Test seam — override the inter-action delay.
 * @returns {Promise<Array<{
 *   title: string,
 *   location: string,
 *   url: string,
 *   postedDate: string,
 *   employmentType: string,
 *   department: string,
 *   contractTerm: string,
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
      `   ⚠️ Bobst: could not load Playwright runtime (${err?.message || err}). Returning [].`,
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

  console.log(`   Fetching from: ${UMANTIS_LISTING_URL}`);

  let browser = null;
  try {
    browser = await createBrowser();
    const context = await createPoliteContext(browser);

    const seenIds = new Set();
    const out = [];
    let firstPageFirstId = '';

    for (let pageIdx = 1; pageIdx <= PAGE_LIMIT; pageIdx++) {
      const url = buildPageUrl(pageIdx);
      const page = await fetchWithRateLimit(context, url);

      try {
        await page.waitForSelector(ROW_SELECTOR, { timeout: 15_000 });
      } catch {
        if (pageIdx === 1) {
          console.warn(
            '   ⚠️ Bobst: Umantis rows never appeared — selectors may have changed. Returning [].',
          );
          await page.close().catch(() => undefined);
          return [];
        }
        // Empty page mid-walk — natural end of pagination.
        await page.close().catch(() => undefined);
        break;
      }

      const rows = await extractRows(page);
      await page.close().catch(() => undefined);

      if (rows.length === 0) break;

      // Detect Umantis wrap-around — page index past the end loops back to p1.
      const pageFirstHref = rows[0]?.href || '';
      const pageFirstIdMatch = pageFirstHref.match(/\/Vacancies\/(\d+)\//);
      const pageFirstId = pageFirstIdMatch ? pageFirstIdMatch[1] : pageFirstHref;
      if (pageIdx === 1) {
        firstPageFirstId = pageFirstId;
      } else if (pageFirstId === firstPageFirstId && firstPageFirstId) {
        break;
      }

      let newRowsThisPage = 0;
      for (const row of rows) {
        const idMatch = row.href.match(/\/Vacancies\/(\d+)\//);
        const vacancyId = idMatch ? idMatch[1] : row.href;
        if (seenIds.has(vacancyId)) continue;
        seenIds.add(vacancyId);
        newRowsThisPage += 1;

        const meta = parseRowMetadata(row.cellText, row.title);
        out.push({
          title: row.title,
          location: meta.location,
          url: resolveApplyUrl(row.href),
          postedDate: meta.postedDate,
          employmentType: meta.employmentType,
          department: meta.department,
          contractTerm: meta.contractTerm,
        });

        if (out.length >= ROW_HARD_CAP) break;
      }

      if (out.length >= ROW_HARD_CAP) break;
      if (newRowsThisPage === 0) break;

      if (sleepMs > 0) await sleep(sleepMs);
    }

    console.log(`   ✅ Bobst Umantis returned ${out.length} unique vacancies.`);
    return out;
  } catch (err) {
    if (AntiBotBlockError && err instanceof AntiBotBlockError) {
      console.warn(
        `   ⚠️ Bobst: anti-bot block (status=${err.status}, title=${JSON.stringify(err.title || '')}). Returning [].`,
      );
      return [];
    }
    if (NavigationTimeout && err instanceof NavigationTimeout) {
      console.warn(
        `   ⚠️ Bobst: navigation timeout for ${err.url || UMANTIS_LISTING_URL}. Returning [].`,
      );
      return [];
    }
    if (BrowserLaunchError && err instanceof BrowserLaunchError) {
      console.warn(
        `   ⚠️ Bobst: browser launch failed (${err.message}). Returning [].`,
      );
      return [];
    }
    console.warn(
      `   ⚠️ Bobst: unexpected scraper error (${err?.message || err}). Returning [].`,
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
  buildPageUrl,
  parseRowMetadata,
  UMANTIS_LISTING_URL,
  UMANTIS_BASE,
  ROW_SELECTOR,
  TITLE_LINK_SELECTOR,
};

/**
 * Fetch all Bobst jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 *
 * @param {object} [options]
 * @param {() => Promise<unknown>} [options._runtime] Test seam — Playwright runtime factory.
 * @param {number} [options._sleepMs] Test seam — inter-action delay.
 */
export async function fetchAllBobstJobs(options = {}) {
  console.log(`🔍 Fetching Bobst jobs`);
  console.log(`   Source: ${UMANTIS_LISTING_URL}\n`);

  const listings = await fetchJobListings(options);
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const location = listing.location || 'Mex'; // HQ: Mex (VD)
    const canton = inferSwissTargetCanton(location) || 'VD';
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || UMANTIS_LISTING_URL;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} bobst ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `bobst-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: BOBST_COMPANY_NAME,
      companyKey: BOBST_KEY,
      companyDomain: BOBST_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Bobst`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Bobst` },
      location,
      canton,
      url: publicUrl,
      source: 'Bobst Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(listing.employmentType || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Industria', // Industrial packaging machinery / printing equipment
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      department: listing.department || undefined,
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 100)); // Rate limiting
  }

  console.log(`\n📋 Total Bobst jobs discovered: ${jobs.length}`);
  return jobs;
}

// Re-export CAREER_URL for the workflow runner banner.
export { CAREER_URL };
