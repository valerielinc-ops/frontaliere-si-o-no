#!/usr/bin/env node
/**
 * Richemont job parser — Playwright DOM scraper of the public careers
 * portal (Cloudflare-protected, JS-rendered SPA).
 *
 * Source: https://careers.richemont.com/en/jobs/?country=Switzerland&pagesize=50
 *
 * The portal sits behind Cloudflare's JS challenge: plain HTTP fetches
 * return 403 regardless of UA. A real Chromium with a browser-grade UA
 * passes the challenge automatically and renders the listing as
 * `.card.card-job[data-id="jrXXXX"]` rows containing title, maison,
 * department, and location. Pagination is `?page=N` with `pagesize=50`
 * (server caps to 50 even when larger values are requested); the page
 * also exposes a `Displaying N to M of TOTAL matching jobs` summary
 * which lets us stop without overshooting.
 *
 * Backed by the shared `playwright-runtime.mjs` helper. The runtime's
 * default UA is a bot string ("FrontaliereTicino-Bot/1.0") which
 * Cloudflare blocks; we override it via `createPoliteContext`.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllRichemontJobs()  — Fetch and parse all jobs
 *   - isRichemontJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()        — Validate URLs belong to this company
 *   - slugify() / stripHtml()  — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton, inferAnyCanton } from './target-swiss-locations.mjs';
import {
  createBrowser,
  createPoliteContext,
  fetchWithRateLimit,
  closeAll,
  AntiBotBlockError,
  NavigationTimeout,
} from './ats-clients/playwright-runtime.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const RICHEMONT_KEY = 'richemont';
export const RICHEMONT_COMPANY_NAME = 'Richemont';
export const RICHEMONT_COMPANY_DOMAIN = 'richemont.com';

const CAREER_BASE = 'https://careers.richemont.com/en/jobs/';
const LISTING_URL = `${CAREER_BASE}?country=Switzerland&pagesize=50`;

// Cloudflare doesn't honour the default playwright-runtime bot UA.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Safari/605.1.15';

const PAGE_SIZE = 50;
// Safety cap: at 50 jobs/page, 20 pages = 1000 listings, well above the
// 166 currently visible and the historical peak (~250). The loop exits
// early as soon as a page returns no new IDs or fewer than PAGE_SIZE rows.
const MAX_PAGES = 20;
const PER_PAGE_DELAY_MS = 4000;
// Detail-page enrichment: visit each job URL with the same BrowserContext
// that already cleared Cloudflare on the listing pass. The CF clearance
// cookie carries over, so no re-challenge fires.
const PER_DETAIL_DELAY_MS = 3000;
const DETAIL_NAV_TIMEOUT_MS = 30_000;
const DETAIL_WAIT_SELECTOR_MS = 15_000;
const MIN_DETAIL_DESCRIPTION_LEN = 200;
// `.job-detail` is Richemont's job-body container (verified 2026-05-12):
// returns ~3k chars of clean job description. Fall back to `article`,
// then `main` if the markup ever shifts.
const DETAIL_SELECTORS = ['.job-detail', 'article', 'main'];

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Richemont's brand portfolio — used to match jobs whose `company` field
 * carries the Maison name rather than "Richemont". Keep in sync with
 * https://www.richemont.com/en/home/our-maisons/.
 */
const RICHEMONT_MAISONS = [
  'cartier', 'van cleef', 'iwc', 'jaeger-lecoultre', 'jaeger lecoultre',
  'panerai', 'piaget', 'vacheron constantin', 'a. lange', 'a.lange',
  'baume & mercier', 'baume mercier', 'montblanc', 'roger dubuis',
  'chloé', 'chloe', 'alaia', 'alaïa', 'dunhill', 'peter millar', 'purdey',
  'delvaux', 'serapian', 'gianvito rossi', 'donzé baume', 'donze baume',
  'time vallée', 'time vallee', 'watchfinder', 'net-a-porter',
];

/**
 * Check if a job belongs to Richemont or one of its Maisons.
 */
export function isRichemontJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  if (
    key === RICHEMONT_KEY ||
    key.startsWith('richemont') ||
    company.includes('richemont')
  ) return true;

  if (url.includes('richemont.com')) return true;

  return RICHEMONT_MAISONS.some((m) => company.includes(m));
}

/**
 * Validate that a URL belongs to Richemont's careers surface or the
 * Workday tenant that backs some Maisons.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'richemont.com' ||
      host.endsWith('.richemont.com') ||
      host.endsWith('.myworkdayjobs.com') // richemont.wd3.myworkdayjobs.com
    );
  } catch {
    return false;
  }
}

/* ── Category / Experience / Employment detection ──────────── */

function detectCategory(title = '', department = '') {
  const t = `${normalize(title)} ${normalize(department)}`;
  if (/\b(ingegner|engineer|engineering|entwickl)\b/.test(t)) return 'Ingegneria';
  if (/\b(qualit|qa|qc|quality)\b/.test(t)) return 'Qualità';
  if (/\b(manufactur|production|atelier|polissage|emaill|reglag|reglage|regleur|controleur|emailleur)\b/.test(t)) return 'Produzione';
  if (/\b(supply.?chain|logist|magazz|warehouse|procurement|sourcing)\b/.test(t)) return 'Logistica';
  if (/\b(commercial|sales|vendita|retail|store|boutique)\b/.test(t)) return 'Commerciale';
  if (/\b(market|kommunik|comunicaz|communication|brand|pr)\b/.test(t)) return 'Marketing';
  if (/\b(hr|human|risorse|personal|talent|recruit)\b/.test(t)) return 'Risorse Umane';
  if (/\b(it|software|develop|programm|data|cyber|cloud|devops|technology)\b/.test(t)) return 'IT';
  if (/\b(finance|financ|tax|account|comptab)\b/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht|juridique|compliance|regulatory)\b/.test(t)) return 'Legale';
  if (/\b(design|creative|visual|merch)\b/.test(t)) return 'Design';
  return 'Lusso / Orologeria';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|trainee|graduate)\b/.test(t)) return 'intern';
  if (/\b(junior|jr)\b/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|directrice|chef|verantwort|responsab|manager|principal|chief)\b/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(title = '', department = '') {
  const t = `${normalize(title)} ${normalize(department)}`;
  if (/\b(intern|stage|stagiair|praktik|trainee)\b/.test(t)) return 'INTERN';
  if (/\b(temporary|tempor|befristet|fixed.?term|cdd|contract|interim)\b/.test(t)) return 'CONTRACTOR';
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)\b/.test(t)) return 'PART_TIME';
  return 'FULL_TIME';
}

/* ── Playwright DOM extraction ─────────────────────────────── */

async function safeClose(page) {
  try { await page.close(); } catch { /* no-op */ }
}

/**
 * Render one listing page and return the rows visible there.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {number} page                          — 1-indexed
 * @returns {Promise<{ rows: Array<object>, total: number | null }>}
 */
async function fetchListingPage(context, page) {
  const url = page === 1
    ? LISTING_URL
    : `${LISTING_URL}&page=${page}`;
  let renderedPage;
  try {
    // Bypass the per-context rate-limiter — pagination already includes
    // an explicit delay below (PER_PAGE_DELAY_MS) and we want the first
    // request to fire immediately.
    renderedPage = await fetchWithRateLimit(context, url, { minDelayMs: 0 });
  } catch (err) {
    if (err instanceof AntiBotBlockError) {
      console.warn(`⚠️ Cloudflare anti-bot on Richemont page ${page}: ${err.message}`);
      return { rows: [], total: null };
    }
    if (err instanceof NavigationTimeout) {
      console.warn(`⚠️ Richemont page ${page} navigation timeout: ${err.message}`);
      return { rows: [], total: null };
    }
    throw err;
  }

  try {
    await renderedPage.waitForSelector('div.card.card-job', { timeout: 30_000, state: 'attached' });
  } catch {
    console.warn(`   Page ${page}: no .card.card-job rendered within 30s`);
    await safeClose(renderedPage);
    return { rows: [], total: null };
  }

  const data = await renderedPage.evaluate(() => {
    const cards = [...document.querySelectorAll('div.card.card-job')];
    const rows = cards.map((card) => {
      const id = card.getAttribute('data-id') || '';
      const a = card.querySelector('a.stretched-link, .card-title a');
      const titleEl = card.querySelector('.card-title');
      const metas = [...card.querySelectorAll('ul.job-meta li, .job-meta li')]
        .map((li) => (li.textContent || '').trim())
        .filter(Boolean);
      return {
        id,
        title: (titleEl?.textContent || a?.textContent || '').trim(),
        href: a?.getAttribute('href') || '',
        brand: card.querySelector('[data-brand]')?.getAttribute('data-brand') || metas[0] || '',
        maison: metas[0] || '',
        department: metas[1] || '',
        location: metas[2] || '',
      };
    });
    const summary = (document.body.innerText.match(/Displaying\s+\d+\s+to\s+\d+\s+of\s+(\d+)\s+matching\s+jobs/i) || [])[1];
    return { rows, total: summary ? Number(summary) : null };
  });

  await safeClose(renderedPage);
  return data;
}

/**
 * Open one detail page and extract the rich job-body text.
 *
 * Reuses the BrowserContext passed in, which already cleared Cloudflare
 * on the listing pass — the clearance cookie travels with the context,
 * so detail navigations don't refire the JS challenge.
 *
 * Returns `''` (empty string) on any failure: anti-bot, timeout, missing
 * markup, or text shorter than `MIN_DETAIL_DESCRIPTION_LEN`. The caller
 * falls back to the templated description.
 */
async function fetchRichDescription(context, url) {
  let page;
  try {
    page = await fetchWithRateLimit(context, url, { minDelayMs: PER_DETAIL_DELAY_MS });
    await page.waitForSelector(DETAIL_SELECTORS[0], {
      timeout: DETAIL_WAIT_SELECTOR_MS,
      state: 'attached',
    }).catch(() => { /* fall through to selector evaluation */ });
    const text = await page.evaluate((selectors) => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          const t = (el.innerText || '').trim();
          if (t.length >= 200) return t;
        }
      }
      return '';
    }, DETAIL_SELECTORS);
    return normalizeSpace(text);
  } catch (err) {
    if (err instanceof AntiBotBlockError) {
      console.warn(`   ⚠️ CF block on detail ${url}: ${err.message}`);
    } else if (err instanceof NavigationTimeout) {
      console.warn(`   ⚠️ Detail navigation timeout: ${url}`);
    } else {
      console.warn(`   ⚠️ Detail fetch error on ${url}: ${err?.message || err}`);
    }
    return '';
  } finally {
    if (page) await safeClose(page);
  }
}

/**
 * Second-pass enrichment: walk each listing row and attach the actual
 * job description scraped from its detail page. Fail-soft per row.
 *
 * Mutates rows in place: sets `row.detailText` (string, may be empty).
 */
async function enrichRowsWithDetail(context, rows) {
  console.log(`\n   Enriching ${rows.length} detail pages (≈${Math.round(rows.length * PER_DETAIL_DELAY_MS / 60_000)} min)`);
  let ok = 0;
  let fallback = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const detailUrl = row.href.startsWith('http')
      ? row.href
      : `https://careers.richemont.com${row.href.startsWith('/') ? '' : '/'}${row.href}`;
    const text = await fetchRichDescription(context, detailUrl);
    row.detailText = text;
    if (text && text.length >= MIN_DETAIL_DESCRIPTION_LEN) {
      ok++;
    } else {
      fallback++;
    }
    if ((i + 1) % 25 === 0) {
      console.log(`     progress: ${i + 1}/${rows.length} (${ok} rich, ${fallback} fallback)`);
    }
  }
  console.log(`   Detail enrichment: ${ok} rich, ${fallback} fallback to template`);
}

/**
 * Build the job description body. Pure function — exported so unit
 * tests can verify the rich-vs-template choice without spinning up
 * Playwright.
 *
 * When detail-page scraping yielded a rich body (≥ MIN_DETAIL_DESCRIPTION_LEN
 * chars), return that. Otherwise compose the legacy templated description
 * from listing-card fields. Never return an empty string.
 */
export function buildJobDescription({
  detailText = '',
  title = '',
  maison = '',
  department = '',
  locationText = '',
} = {}) {
  const rich = normalizeSpace(detailText);
  if (rich && rich.length >= MIN_DETAIL_DESCRIPTION_LEN) return rich;

  const parts = [
    title,
    maison ? `Maison: ${maison}.` : '',
    department ? `Department: ${department}.` : '',
    locationText ? `Location: ${locationText}.` : '',
    `Open position at Compagnie Financière Richemont (Swiss luxury group: Cartier, Van Cleef & Arpels, IWC, Jaeger-LeCoultre, Panerai, Piaget, Vacheron Constantin, and more).`,
  ].filter(Boolean);
  return parts.join(' ');
}

/**
 * Walk paginated Richemont listings and return the full deduplicated
 * row set. Stops on empty page, duplicate-only page, or MAX_PAGES.
 * Each row is then enriched with its detail-page description in a
 * second pass over the same BrowserContext.
 */
async function discoverAllRows() {
  let browser;
  try {
    browser = await createBrowser({ userAgent: BROWSER_UA });
    const context = await createPoliteContext(browser, { userAgent: BROWSER_UA });
    const seenIds = new Set();
    const rows = [];
    let totalLabel = null;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const { rows: pageRows, total } = await fetchListingPage(context, page);
      if (total && totalLabel === null) {
        totalLabel = total;
        console.log(`   Richemont reports ${total} matching jobs`);
      }
      if (!pageRows.length) break;

      let added = 0;
      for (const r of pageRows) {
        const id = r.id || (r.href.match(/jobs\/(jr\d+)/i) || [])[1] || '';
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        rows.push({ ...r, id });
        added++;
      }
      console.log(`   Page ${page}: ${pageRows.length} rows on page, ${added} new (running total: ${rows.length})`);
      if (added === 0) break;
      if (totalLabel && rows.length >= totalLabel) break;
      if (pageRows.length < PAGE_SIZE) break;

      await new Promise((r) => setTimeout(r, PER_PAGE_DELAY_MS));
    }

    // Second pass: visit each detail page in the same context so the
    // Cloudflare clearance cookie carries over. Mutates rows in place.
    if (rows.length) {
      await enrichRowsWithDetail(context, rows);
    }

    return rows;
  } finally {
    await closeAll(browser);
  }
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch all Richemont jobs from the public careers portal.
 *
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllRichemontJobs() {
  console.log(`🔍 Fetching Richemont jobs via Playwright (Cloudflare-gated)`);
  console.log(`   Source: ${LISTING_URL}\n`);

  let rows;
  try {
    rows = await discoverAllRows();
  } catch (err) {
    console.error(`❌ Richemont Playwright discovery failed: ${err?.message || err}`);
    return [];
  }

  console.log(`  📋 Total Swiss-located rows discovered: ${rows.length}`);

  if (rows.length === 0) {
    console.warn('⚠️ No Richemont job rows found.');
    return [];
  }

  const jobs = [];
  for (const row of rows) {
    const title = normalizeSpace(row.title);
    if (!title || title.length < 3) continue;

    const maison = normalizeSpace(row.maison || row.brand || 'Richemont');
    const department = normalizeSpace(row.department || '');
    const locationText = normalizeSpace(row.location || '');
    // Location format observed: "Le Sentier, CH" or "Genève, CH"
    const city = (locationText.split(',')[0] || '').trim() || 'Geneva';
    const canton = inferSwissTargetCanton(city) || inferAnyCanton(city) || 'GE';

    const path = row.href.startsWith('http')
      ? row.href
      : `https://careers.richemont.com${row.href.startsWith('/') ? '' : '/'}${row.href}`;
    const sourceLang = detectLang(title, 'en');
    const jobSlug = slugify(`${title} richemont ${city || 'switzerland'}`);
    const urlHash = createHash('sha1').update(path).digest('hex').slice(0, 12);

    const description = buildJobDescription({
      detailText: row.detailText || '',
      title,
      maison,
      department,
      locationText,
    });

    const job = {
      id: `richemont-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: maison && maison !== 'Richemont' ? maison : RICHEMONT_COMPANY_NAME,
      companyKey: RICHEMONT_KEY,
      companyDomain: RICHEMONT_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: city,
      canton,
      url: path,
      source: 'Richemont Dedicated Parser (Playwright)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: city,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, department),
      contract: detectEmploymentType(title, department) === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(title, department),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Lusso / Orologeria',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: path,
      jobReqId: row.id || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Richemont jobs discovered: ${jobs.length}`);
  return jobs;
}
