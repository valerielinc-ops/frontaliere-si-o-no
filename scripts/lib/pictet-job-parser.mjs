#!/usr/bin/env node
/**
 * Pictet Group job parser — SAP SuccessFactors career5 (html-career flavor).
 *
 * Source: https://career012.successfactors.eu/career?company=banquepict
 *
 * STATUS (2026-05-11):
 *   The career5 listing index is a JavaScript SPA, so plain HTTP returns
 *   no job rows. We render the listing with Playwright via the shared
 *   `playwright-runtime.mjs` helper, harvest every `<a href*="career_job_req_id=">`
 *   visible after hydration, and then re-enter the SuccessFactors client
 *   per detail URL — each detail page is server-rendered HTML and the
 *   shared client extracts `{title, reqId, area, country}` via
 *   `parseHtmlCareerDetail`.
 *
 * Pictet HQ: Geneva (GE) — default canton when SuccessFactors location
 * extraction fails. The downstream canton-quorum-gate re-classifies based
 * on title/body/locality 2-of-3.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllPictetJobs()  — Fetch and parse all jobs
 *   - isPictetJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()     — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  buildSuccessFactorsApiUrl,
  detectSuccessFactorsKind,
  fetchSuccessFactorsJobs,
  SuccessFactorsAuthError,
} from './ats-clients/successfactors-client.mjs';
import {
  createBrowser,
  createPoliteContext,
  fetchWithRateLimit,
  closeAll,
  AntiBotBlockError,
  NavigationTimeout,
} from './ats-clients/playwright-runtime.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const PICTET_KEY = 'pictet';
export const PICTET_COMPANY_NAME = 'Pictet Group';
export const PICTET_COMPANY_DOMAIN = 'pictet.com';

/** career5 tenant code seen on https://www.pictet.com/careers (2026-05-10). */
const SF_TENANT = 'banquepict';
const SF_HOST = 'career012.successfactors.eu';
const SF_DETAIL_LANG = 'en_GB';
const CAREER_URL = `https://${SF_HOST}/career?company=${SF_TENANT}`;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Rebuild a career5 detail URL into its canonical, session-free form.
 *
 * Anchors harvested from the hydrated career5 SPA carry PER-REQUEST query
 * state next to the stable `career_job_req_id`:
 *   - `_s.crb=<base64>`              — per-session CSRF token, changes EVERY run
 *   - `browserTimeZone=Europe/Zurich`— client environment echo
 *   - `jobAlertController_jobAlertId` / `…Name` — empty job-alert form state
 * plus randomly `%5f`-encoded param names (`career%5fns=`). Persisting that
 * raw href makes the job's URL byte-different on every crawl, so every
 * URL-keyed identity downstream fragments: `id` = sha1(url) churns, the
 * assemble-time dedup key (assembleUrlKey = full raw URL) never matches, and
 * the 3-way slice merge in git-commit-data.sh (job arrays keyed by `url`)
 * unions the per-run variants into duplicates (observed: 10 → 26 dupes in
 * data/jobs/by-crawler/pictet.json within one day, audit-parser-quality
 * critical). The crawl-time merge key (mergeUrlKey → `num:<reqId>`) survives,
 * which is why the dupes shared one preserved `id` while their URLs drifted.
 *
 * The detail page is served identically without the session params (verified
 * live 2026-07-10: HTTP 200 + `joqReqDescription` body with only
 * `career_ns=job_listing&company=banquepict&career_job_req_id=<id>`), so we
 * rebuild via the shared `buildSuccessFactorsApiUrl` html-career formatter —
 * the SAME canonical shape the other SuccessFactors crawlers persist —
 * keeping only the identity params (tenant + reqId + stable locale).
 *
 * @param {string} rawUrl - href harvested from the listing SPA (or any
 *   career5 URL). `&amp;`-decoded defensively; `%5f` key encoding is handled
 *   by URLSearchParams' own percent-decoding.
 * @returns {string|null} canonical detail URL, or null when the input has no
 *   numeric `career_job_req_id` (listing/root pages).
 */
export function canonicalPictetDetailUrl(rawUrl = '') {
  try {
    const u = new URL(String(rawUrl || '').replace(/&amp;/g, '&'));
    const reqId = u.searchParams.get('career_job_req_id');
    if (!reqId || !/^\d+$/.test(reqId)) return null;
    return buildSuccessFactorsApiUrl(SF_TENANT, 'html-career', {
      host: u.hostname || SF_HOST,
      jobReqId: reqId,
      lang: SF_DETAIL_LANG,
    });
  } catch {
    return null;
  }
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Pictet Group (covers also Pictet Asset
 * Management, Pictet Wealth Management, Banque Pictet & Cie SA).
 */
export function isPictetJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === PICTET_KEY ||
    /^pictet(-|$)/.test(key) ||
    company.includes('pictet') ||
    company.includes('banque pictet') ||
    url.includes('pictet.com') ||
    url.includes('group.pictet') ||
    url.includes('company=banquepict')
  );
}

/**
 * Validate that a URL belongs to Pictet Group's domain or its career5 tenant.
 * SuccessFactors hosts the public-facing apply pages under
 * `career5.successfactors.eu/career?company=banquepict&...` — those are
 * first-party for our trust model since they are the canonical apply
 * destination.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host === 'pictet.com' || host.endsWith('.pictet.com')) return true;
    if (host.endsWith('.successfactors.eu') || host.endsWith('.successfactors.com')) {
      return /company=banquepict/i.test(url.search);
    }
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(wealth|asset.?manag|investment|portfolio|trading)/.test(t)) return 'Finanza';
  if (/\b(banker|relationship.?manag|client.?advis|conseil.*client)/.test(t)) return 'Finanza';
  if (/\b(ingegner|engineer|entwickl|ing[eé]nieur|architect)/.test(t)) return 'Ingegneria';
  if (/\b(it|software|develop|programm|data|cloud|infrastructure|cyber|devops)/.test(t)) return 'IT';
  if (/\b(admin|segret|contab|buchhalt|account|administrative|operations)/.test(t)) return 'Amministrazione';
  if (/\b(hr|human|risorse|personal|talent|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz|communication|brand)/.test(t)) return 'Marketing';
  if (/\b(legal|giurid|recht|juridique|compliance|regulatory)/.test(t)) return 'Legale';
  if (/\b(audit|risk|control)/.test(t)) return 'Finanza';
  if (/\b(finanz|finance|financ|tax)/.test(t)) return 'Finanza';
  return 'Finanza'; // Default for a private bank.
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(intern|stage|stagiair|apprenti|graduate|trainee)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|directrice|chef|responsab|verantwort|leiter)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  if (/\b(intern|stage|stagiair)/.test(t)) return 'INTERN';
  if (/\b(temporary|tempor|befristet|fixed.?term|cdd)/.test(t)) return 'CONTRACTOR';
  return 'OTHER';
}

/* ── SuccessFactors fetcher ─────────────────────────────────── */

/**
 * Build a ParsedJob from a NormalizedJob yielded by the SuccessFactors
 * client. Extracted as a separate helper so the next iteration (with
 * Playwright-discovered detail URLs) can reuse it without duplicating the
 * sourceLang / slug / postedDate plumbing.
 */
function buildParsedJobFromSf(normalized) {
  const title = normalizeSpace(normalized?.title || '');
  if (!title || title.length < 3) return null;

  const locationText = normalizeSpace(normalized?.location || '') || 'Genève';
  const city = locationText.split(',')[0].trim();
  const canton = inferSwissTargetCanton(locationText) || inferSwissTargetCanton(city) || 'GE';

  const descriptionRaw = typeof normalized?.descriptionHtml === 'string' ? normalized.descriptionHtml : '';
  const descriptionText = stripHtml(descriptionRaw);
  // Belt-and-braces: canonicalize even here so `id` (sha1 of the URL) can
  // never be derived from a session-tokenized URL, whatever upstream path
  // produced applyUrl (discovery already canonicalizes; this pins the
  // invariant at the single point where the id is minted).
  const publicUrl =
    canonicalPictetDetailUrl(normalized?.applyUrl) || normalized?.applyUrl || CAREER_URL;

  const sourceLang = detectLang(descriptionText || title, 'en');
  const jobSlug = slugify(`${title} pictet ${city || 'geneva'}`);
  const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

  const postedDate = (() => {
    const raw = normalized?.postedAt || '';
    if (!raw) return new Date().toISOString().slice(0, 10);
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
    return d.toISOString().slice(0, 10);
  })();

  return {
    // ── Required fields ──
    id: `pictet-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: PICTET_COMPANY_NAME,
    companyKey: PICTET_KEY,
    companyDomain: PICTET_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description: descriptionText || `${title} — Pictet Group`,
    descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Pictet Group` },
    location: city || locationText,
    canton,
    url: publicUrl,
    source: 'Pictet Group Dedicated Parser (SuccessFactors career5)',
    sourceLang,
    crawledAt: new Date().toISOString(),

    // ── Recommended fields ──
    addressLocality: city || locationText,
    addressRegion: canton,
    addressCountry: 'CH',
    country: 'CH',
    category: detectCategory(title),
    contract: 'full-time',
    employmentType: detectEmploymentType(title),
    experienceLevel: detectExperienceLevel(title),
    sector: 'Finanza / Banca privata',
    currency: 'CHF',
    featured: false,
    postedDate,
    applyUrl: publicUrl,
    jobReqId: normalized?.jobReqId || null,
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },
  };
}

/**
 * Render the career5 listing index with Playwright and extract every unique
 * detail URL exposed via `<a href*="career_job_req_id=">`.
 *
 * The SPA is hydrated after `domcontentloaded`, so we additionally wait for
 * at least one matching anchor to appear before reading the DOM.
 *
 * @param {string} listingUrl
 * @returns {Promise<string[]>}
 */
async function discoverPictetDetailUrls(listingUrl) {
  let browser;
  try {
    browser = await createBrowser();
    const context = await createPoliteContext(browser);
    // Listing discovery is a single page-load; no per-context rate-limit
    // history yet, so we don't need an artificial delay before the request.
    const page = await fetchWithRateLimit(context, listingUrl, { minDelayMs: 0 });

    try {
      await page.waitForSelector('a[href*="career_job_req_id="]', {
        timeout: 30_000,
        state: 'attached',
      });
    } catch {
      // SPA never populated job rows — origin may have shipped no openings.
      console.warn(`   No "career_job_req_id" anchors appeared within 30s`);
    }

    const hrefs = await page.$$eval(
      'a[href*="career_job_req_id="]',
      (links) => links.map((a) => a.href),
    );

    // Deduplicate by reqId — career5 often renders the same row in multiple
    // places (table + sidebar) and pagination links can repeat IDs — and
    // CANONICALIZE each href before returning it. The hydrated SPA stamps a
    // per-session `_s.crb` CSRF token (plus browserTimeZone/jobAlert form
    // state) into every anchor, so the raw href is byte-different on every
    // run; persisting it downstream duplicated the whole slice (see
    // canonicalPictetDetailUrl above).
    const seen = new Set();
    const unique = [];
    for (const href of hrefs) {
      const canonical = canonicalPictetDetailUrl(href);
      if (!canonical || seen.has(canonical)) continue;
      seen.add(canonical);
      unique.push(canonical);
    }
    return unique;
  } catch (err) {
    if (err instanceof AntiBotBlockError) {
      console.warn(`⚠️ Anti-bot block during Pictet listing discovery: ${err.message}`);
      return [];
    }
    if (err instanceof NavigationTimeout) {
      console.warn(`⚠️ Pictet listing navigation timeout: ${err.message}`);
      return [];
    }
    throw err;
  } finally {
    await closeAll(browser);
  }
}

/**
 * Fetch all Pictet Group jobs.
 *
 * Pipeline:
 *   1. Render `${CAREER_URL}&career_ns=job_listing_summary&navBarLevel=JOB_SEARCH`
 *      with Playwright and collect every `career_job_req_id` detail URL.
 *   2. Re-enter the SuccessFactors client per detail URL — each detail is
 *      a server-rendered HTML page that `parseHtmlCareerDetail` can handle.
 *   3. Build a ParsedJob via `buildParsedJobFromSf` for each item.
 *
 * Returns an array of ParsedJob objects (source-locale only). The downstream
 * canton-quorum-gate is responsible for filtering to relevant cantons.
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllPictetJobs() {
  console.log(`🔍 Fetching Pictet Group jobs (CH-wide via SuccessFactors career5)`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const kind = detectSuccessFactorsKind(CAREER_URL);
  if (!kind) {
    console.warn(`⚠️ URL not recognised as SuccessFactors: ${CAREER_URL}`);
    return [];
  }

  const listingUrl = `${CAREER_URL}&career_ns=job_listing_summary&navBarLevel=JOB_SEARCH`;
  console.log(`   Discovering jobReqIds via Playwright at ${listingUrl}`);
  const detailUrls = await discoverPictetDetailUrls(listingUrl);
  console.log(`   Discovered ${detailUrls.length} unique career_job_req_id detail URLs`);

  if (detailUrls.length === 0) {
    console.warn(`⚠️ Pictet career5 listing yielded 0 detail URLs.`);
    return [];
  }

  const jobs = [];
  for (const detailUrl of detailUrls) {
    try {
      for await (const normalized of fetchSuccessFactorsJobs(detailUrl, {
        locationFilters: [],
        company: PICTET_COMPANY_NAME,
      })) {
        const job = buildParsedJobFromSf(normalized);
        if (job) jobs.push(job);
      }
    } catch (err) {
      if (err instanceof SuccessFactorsAuthError) {
        console.warn(`⚠️ Anti-bot on Pictet detail page ${detailUrl}: ${err?.message || err}`);
        continue;
      }
      console.warn(`⚠️ Skipping Pictet detail ${detailUrl}: ${err?.message || err}`);
    }
  }

  console.log(`\n📋 Total Pictet jobs discovered: ${jobs.length}`);
  return jobs;
}
