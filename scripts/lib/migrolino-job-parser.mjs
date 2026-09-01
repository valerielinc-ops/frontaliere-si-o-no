#!/usr/bin/env node
/**
 * migrolino job parser — Migros Group shared careers portal (jobs.migros.ch).
 *
 * ATS discovery (issue #3337 lists migrolino as "Custom" — WRONG):
 *   1. migrolino's own site (migrolino.ch/de/jobs/, migrolino-ag.ch/de/karriere)
 *      is a plain Craft CMS page with NO job data of its own. It links out to
 *      the shop-floor and HQ listings on the shared Migros Group careers
 *      portal:
 *        https://jobs.migros.ch/de/unsere-unternehmen/migrolino/offene-stellen
 *   2. jobs.migros.ch is the SAME Nuxt.js SSR/SPA portal already partially
 *      supported in this repo by the `migros-ticino` dedicated crawler
 *      (`./migros-job-parser.mjs` HTML section extractor +
 *      `scripts/update-migros-jobs.mjs` Playwright pagination). migrolino is
 *      simply one of the many "unsere-unternehmen" (group-company) tenants on
 *      that shared portal — confirmed via live fetch (`curl
 *      https://www.migrolino.ch/de/jobs/` → JSON-LD `og:url
 *      https://www.migrolino-ag.ch/de/karriere` → links to
 *      `jobs.migros.ch/de/unsere-unternehmen/migrolino/offene-stellen`, and
 *      detail pages at
 *      `jobs.migros.ch/de/unsere-unternehmen/job/migrolino/{slug}/{uuid}`).
 *      So the "Custom" label is wrong: this is a known, already
 *      partially-supported ATS/portal, not a bespoke system.
 *   3. IMPORTANT: because the nationwide `migros-ticino` crawler scopes
 *      `jobs.migros.ch` by HOST ONLY (any group-company posting matches
 *      `isMigrosJob()`), migrolino postings are ALREADY present in
 *      `data/jobs/by-crawler/migros-ticino.json` today — but lumped under
 *      `companyKey: 'migros-ticino'` with `company: 'migrolino'`, not their
 *      own dedicated company identity. This dedicated crawler gives migrolino
 *      its own `companyKey`/HQ/SEO profile (as the #3337 backlog requires for
 *      every company) by re-fetching the SAME portal scoped to the
 *      migrolino-only listing URL and, defensively, filtering discovered
 *      hrefs to the `/job/migrolino/` company-slug segment (the nationwide
 *      listing's server-rendered "pinned jobs" include OTHER group brands
 *      even when a RUBRIC filter is applied — verified live: the migrolino
 *      RUBRIC listing SSR HTML also contained `/job/migros-logistics/` and
 *      `/job/genossenschaft-migros-aare/` hrefs — so the href-segment filter,
 *      not the RUBRIC query param, is what actually scopes results to
 *      migrolino).
 *   4. Detail pages carry a full `JobPosting` JSON-LD block (title,
 *      description, datePosted, employmentType, workHours, occupationalCategory,
 *      hiringOrganization, jobLocation.address with a REAL per-store
 *      street/postal/city) — richer than the `migros-job-parser.mjs` docstring
 *      assumed ("no JSON-LD"/"only brief overview text"); the JSON-LD
 *      `description` field IS present but short, so the fuller HTML section
 *      content (`extractMigrosStructuredData`, reused from
 *      `./migros-job-parser.mjs` rather than reimplemented) is preferred
 *      whenever it is longer.
 *
 * Source URLs:
 *   Listing: https://jobs.migros.ch/de/unsere-unternehmen/migrolino/offene-stellen
 *            (Nuxt SPA — SSR renders only a handful of pinned jobs; the full
 *            result set requires the same Playwright hydration+pagination
 *            pattern as `scripts/update-migros-jobs.mjs`, reused here via
 *            `./ensure-chromium.mjs`)
 *   Detail:  https://jobs.migros.ch/{locale}/unsere-unternehmen/job/migrolino/{slug}/{uuid}
 *            (plain server-rendered HTML — no JS needed to read it, reused
 *            via the shared `fetchHtml` from `./crawler-template.mjs`)
 *
 * migrolino AG operates ~700 convenience-store shop locations across ALL of
 * Switzerland (a retail chain, not a single-site employer), so per-job
 * addresses come from the JSON-LD `jobLocation.address` of EACH posting
 * (the real shop address) — `resolveAddress()` below is the migrolino AG
 * HQ-fallback ONLY, and is gated on the resolved city text actually matching
 * Suhr (never applied canton-wide), so a same-canton-but-different-city shop
 * posting (e.g. Baden AG, Wohlen AG) never inherits the Suhr HQ street
 * address just because it shares canton AG.
 *
 * migrolino AG HQ address — Wynenfeldstrasse 3, 5034 Suhr (AG) — confirmed via
 * THREE independent sources: (1) the company's own JSON-LD `LocalBusiness`
 * block on migrolino-ag.ch/de/karriere (`addressLocality: "Suhr", postalCode:
 * "5034", streetAddress: "Wynenfeld"`) AND the JobPosting JSON-LD for an
 * HQ-based role (`streetAddress: "Wynenfeldstrasse 3", addressLocality:
 * "Suhr", postalCode: "5034"`); (2) help.ch Handelsregister entry (UID
 * CHE-105.489.643, "migrolino AG in Suhr"); (3) Moneyhouse company profile
 * (migrolino AG, Suhr, canton Aargau) — cross-checked, not assumed.
 */
import { createHash } from 'node:crypto';
import { fetchHtml, slugify, normalizeSpace } from './crawler-template.mjs';
import { detectLang, guessCategory, normalizeContract } from './dedicated-crawler-common.mjs';
import { extractMigrosStructuredData, cleanDescription } from './migros-job-parser.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { launchChromium } from './ensure-chromium.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const MIGROLINO_KEY = 'migrolino';
export const MIGROLINO_COMPANY_NAME = 'migrolino';
export const MIGROLINO_COMPANY_DOMAIN = 'migrolino.ch';

const LISTING_URL =
  'https://jobs.migros.ch/de/unsere-unternehmen/migrolino/offene-stellen?text=&location=&RUBRIC=10189,10200,10241,10246,10239';
const DETAIL_BASE = 'https://jobs.migros.ch';
const CAREER_URL = 'https://www.migrolino-ag.ch/de/karriere';

const SECTOR = 'Retail / Convenience Store';

/**
 * Matches a migrolino job detail href in any of the four locale prefixes AND
 * any of the four "our companies" URL segment translations, but ONLY when
 * the company-slug segment is literally `migrolino` — this is what actually
 * scopes discovery to migrolino (see file-header note 3: the RUBRIC query
 * param alone does not).
 */
const JOB_HREF_RE =
  /^\/(it|de|fr|en)\/(le-nostre-imprese|unsere-unternehmen|nos-entreprises|our-companies)\/job\/migrolino\/[^/]+\/[a-f0-9-]{36}$/;

/** HQ fallback — migrolino AG, Wynenfeldstrasse 3, 5034 Suhr (AG). See file
 * header for the 3-source verification. */
const HQ = {
  city: 'Suhr',
  canton: 'AG',
  postalCode: '5034',
  streetAddress: 'Wynenfeldstrasse 3',
  region: 'Aargau',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/**
 * Resolve the best city / postal code / street address for a job, falling
 * back to the documented migrolino AG HQ ONLY when the resolved city text
 * itself matches Suhr (city-gated, never canton-only) — this is what stops a
 * same-canton-but-different-city shop posting (e.g. Baden AG, Wohlen AG) from
 * incorrectly inheriting the Suhr HQ street address just because it shares
 * canton AG.
 *
 * Exported so tests exercise this exact gate instead of a duplicated regex.
 *
 * @param {{ city?: string, postalCode?: string, streetAddress?: string }} [raw]
 * @returns {{ city: string, postalCode: string, streetAddress: string }}
 */
export function resolveAddress(raw = {}) {
  const city = normalizeSpace(raw.city || '') || HQ.city;
  const isSuhrHq = /\bsuhr\b/i.test(city);
  return {
    city,
    postalCode: normalizeSpace(raw.postalCode || '') || (isSuhrHq ? HQ.postalCode : ''),
    streetAddress: normalizeSpace(raw.streetAddress || '') || (isSuhrHq ? HQ.streetAddress : ''),
  };
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to migrolino. Matching is keyed primarily on
 * `companyKey`/company-slug URL segment so store-level postings (whose
 * `company` field is sometimes "migrolino Shop" rather than "migrolino")
 * still match.
 */
export function isMigrolinoJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === MIGROLINO_KEY ||
    key.startsWith('migrolino') ||
    company.includes('migrolino') ||
    url.includes('migrolino.ch') ||
    url.includes('migrolino-ag.ch') ||
    /\/job\/migrolino\//.test(url)
  );
}

/**
 * Validate a URL belongs to migrolino's own domain(s) or the migrolino
 * company-slug segment on the shared jobs.migros.ch portal.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host === MIGROLINO_COMPANY_DOMAIN || host.endsWith(`.${MIGROLINO_COMPANY_DOMAIN}`)) return true;
    if (host === 'migrolino-ag.ch' || host.endsWith('.migrolino-ag.ch')) return true;
    if (host === 'mio-shops.ch' || host.endsWith('.mio-shops.ch')) return true;
    if (host === 'jobs.migros.ch') {
      return /\/job\/migrolino\//i.test(url.pathname);
    }
    return false;
  } catch {
    return false;
  }
}

/* ── Detail page parse (JSON-LD JobPosting) ──────────────────*/

/**
 * Extract the single `JobPosting` JSON-LD block from a jobs.migros.ch detail
 * page. Returns null if absent, malformed, or not a JobPosting.
 *
 * @param {string} html
 * @returns {object | null}
 */
export function parseMigrolinoJsonLd(html = '') {
  if (!html || typeof html !== 'string') return null;
  const m = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]);
    if (!data || data['@type'] !== 'JobPosting') return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Parse a migrolino detail page into assembled fields, combining the
 * structured JSON-LD (address, dates, employment type) with the fuller
 * HTML-section description (`extractMigrosStructuredData`, shared with the
 * `migros-ticino` crawler) whenever the latter is longer than the JSON-LD's
 * brief overview text.
 *
 * @param {string} html
 * @param {string} [url]
 * @returns {{ title: string, description: string, city: string, canton: string,
 *   postalCode: string, streetAddress: string, employmentType: string,
 *   contract: string, postedDate: string, occupationalCategory: string,
 *   hiringOrganizationName: string }}
 */
export function parseMigrolinoDetail(html = '', url = '') {
  const jsonLd = parseMigrolinoJsonLd(html);
  const structured = extractMigrosStructuredData(html);

  const title = normalizeSpace(jsonLd?.title || '');
  const address = jsonLd?.jobLocation?.address || {};
  const rawCity = normalizeSpace(address.addressLocality || '');
  const { city, postalCode, streetAddress } = resolveAddress({
    city: rawCity,
    postalCode: address.postalCode || '',
    streetAddress: address.streetAddress || '',
  });

  const jsonLdDescription = normalizeSpace(cleanDescription(jsonLd?.description || ''));
  const richDescription = structured?.description ? cleanDescription(structured.description) : '';
  const description =
    richDescription && richDescription.length > jsonLdDescription.length ? richDescription : jsonLdDescription;

  const employmentTypeRaw = normalizeSpace(jsonLd?.employmentType || '');
  const workHours = normalizeSpace(jsonLd?.workHours || '');
  // migrolino JSON-LD `workHours` is a workload RANGE (e.g. "80% - 100%"),
  // not a single figure. Since #3482 `normalizeContract()` is range-aware
  // (classifies a range by its upper bound), so the raw value can be fed
  // straight through — the old local max-percent workaround is redundant.
  const contract = normalizeContract(`${employmentTypeRaw} ${workHours}`, title, description);
  const employmentType = contract === 'part-time' ? 'PART_TIME' : 'FULL_TIME';

  const postedDate = normalizeSpace(jsonLd?.datePosted || '').slice(0, 10);
  const canton = inferSwissTargetCanton(city) || HQ.canton;

  return {
    title,
    description: description || (title ? `${title} — ${MIGROLINO_COMPANY_NAME} (${city}).` : ''),
    city,
    canton,
    postalCode,
    streetAddress,
    employmentType,
    contract,
    postedDate: postedDate || new Date().toISOString().split('T')[0],
    occupationalCategory: normalizeSpace(jsonLd?.occupationalCategory || ''),
    hiringOrganizationName: normalizeSpace(jsonLd?.hiringOrganization?.name || MIGROLINO_COMPANY_NAME),
    url,
  };
}

/* ── Listing discovery (Playwright — reuses migros-ticino's hydration+pagination pattern) ── */

/**
 * Discover every migrolino job detail href from the shared jobs.migros.ch
 * Nuxt SPA. Mirrors `scripts/update-migros-jobs.mjs`'s hydration+pagination
 * approach (SSR renders only a handful of pinned jobs; the full result set
 * needs a headless browser to click through pagination), scoped to the
 * migrolino-only listing URL and href pattern rather than the nationwide one.
 *
 * @returns {Promise<string[]>} relative href strings (locale-prefixed)
 */
export async function fetchMigrolinoListingHrefs() {
  const headless = process.env.JOBS_MIGROLINO_HEADLESS !== '0';
  const navTimeoutMs = Number(process.env.JOBS_MIGROLINO_NAV_TIMEOUT_MS) || 30000;
  const paginationTimeoutMs = Number(process.env.JOBS_MIGROLINO_PAGINATION_TIMEOUT_MS) || 2000;
  const paginationStallPolls = Math.max(1, Number(process.env.JOBS_MIGROLINO_PAGINATION_STALL_POLLS) || 4);
  const maxPages = Number(process.env.JOBS_MIGROLINO_MAX_PAGES) || 200;

  const browser = await launchChromium({
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(LISTING_URL, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });

    const consent = page
      .locator(
        'button:has-text("Akzeptieren"), button:has-text("Alle akzeptieren"), button:has-text("Accept"), button:has-text("Accetta")',
      )
      .first();
    if (await consent.isVisible().catch(() => false)) {
      await consent.click().catch(() => {});
      await page.waitForTimeout(1500);
    }

    // Wait for hydration to populate the result panel past the initial SSR.
    await page.waitForTimeout(3000);

    const collect = () =>
      page.evaluate((reSrc) => {
        const re = new RegExp(reSrc);
        const out = new Set();
        for (const a of document.querySelectorAll('a[href]')) {
          const href = a.getAttribute('href');
          if (href && re.test(href)) out.add(href);
        }
        return [...out];
      }, JOB_HREF_RE.source);

    const allUrls = new Set();
    for (const u of await collect()) allUrls.add(u);

    let pageIdx = 1;
    while (pageIdx < maxPages) {
      const nextBtn = page.locator('button[aria-label*="ächste" i], button:has-text("Nächste Seite")').first();
      const visible = await nextBtn.isVisible().catch(() => false);
      const disabled = await nextBtn.isDisabled().catch(() => true);
      if (!visible || disabled) break;

      await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
      try {
        await nextBtn.click();
      } catch (err) {
        throw new Error(
          `migrolino discovery incomplete at page ${pageIdx}: next control click failed (${err?.message || err}).`,
        );
      }
      pageIdx += 1;

      const before = allUrls.size;
      for (let poll = 0; poll < paginationStallPolls; poll += 1) {
        await page.waitForTimeout(paginationTimeoutMs);
        for (const u of await collect()) allUrls.add(u);
        if (allUrls.size > before) break;
      }
      if (allUrls.size === before) {
        throw new Error(
          `migrolino discovery incomplete: page ${pageIdx} stalled while the next control remained enabled after ${paginationStallPolls} poll(s) (${allUrls.size} total URLs).`,
        );
      }
    }

    return [...allUrls];
  } finally {
    await browser.close().catch(() => {});
  }
}

/* ── Fetch + Assemble ──────────────────────────────────────── */

/**
 * Fetch all migrolino jobs (nationwide — migrolino has shop locations in
 * every Swiss canton). Returns an array of ParsedJob objects (source-locale
 * only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled by the
 * AI localization step and translate-pending pipeline.
 */
export async function fetchAllMigrolinoJobs() {
  console.log(`🔍 Fetching ${MIGROLINO_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL} (Migros Group shared jobs.migros.ch portal, migrolino-scoped)\n`);

  const hrefs = await fetchMigrolinoListingHrefs();
  if (!hrefs.length) {
    console.warn('⚠️ No migrolino listings discovered on jobs.migros.ch.');
    return [];
  }
  console.log(`  📋 migrolino listings found: ${hrefs.length}`);

  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const jobs = [];
  const seen = new Set();

  for (const href of hrefs) {
    const publicUrl = new URL(href, DETAIL_BASE).toString();
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    let detailHtml = '';
    try {
      detailHtml = await fetchHtml(publicUrl, { timeoutMs });
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${publicUrl}: ${err?.message || err}`);
      continue;
    }

    const parsed = parseMigrolinoDetail(detailHtml, publicUrl);
    if (!parsed.title) {
      console.warn(`  ⚠️ Could not parse JobPosting JSON-LD for ${publicUrl} — skipping.`);
      continue;
    }

    const sourceLang = detectLang(parsed.description || parsed.title, 'de');
    const jobSlug = slugify(`${parsed.title} migrolino ${parsed.city}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `${MIGROLINO_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: MIGROLINO_COMPANY_NAME,
      companyKey: MIGROLINO_KEY,
      companyDomain: MIGROLINO_COMPANY_DOMAIN,
      title: parsed.title,
      titleByLocale: { [sourceLang]: parsed.title },
      description: parsed.description,
      descriptionByLocale: { [sourceLang]: parsed.description },
      location: parsed.city,
      canton: parsed.canton,
      url: publicUrl,
      source: 'migrolino Dedicated Parser (Migros Group jobs.migros.ch)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: parsed.city,
      addressRegion: parsed.canton === HQ.canton ? HQ.region : parsed.canton,
      streetAddress: parsed.streetAddress,
      postalCode: parsed.postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: guessCategory(parsed.title, parsed.description),
      contract: parsed.contract,
      employmentType: parsed.employmentType,
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate: parsed.postedDate,
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\n📋 Total ${MIGROLINO_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { CAREER_URL, LISTING_URL };
