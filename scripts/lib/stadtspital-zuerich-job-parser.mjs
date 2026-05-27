#!/usr/bin/env node
/**
 * Stadtspital Zürich (Triemli + Waid) job parser — best-effort Playwright.
 *
 * Source: https://www.stadtspital.ch/karriere
 *
 * ⚠️ Connectivity note: the public site geo-blocks non-CH egress at the
 * TCP level (connect timeouts from non-CH IPs). GitHub Actions runners on
 * Microsoft Azure may originate from a CH region and reach the site; this
 * parser is wired through Playwright (workflow already provisioned via the
 * `--playwright` tier) so the FIRST live workflow_dispatch run validates
 * connectivity. If TCP times out / 451 / anti-bot blocks, the parser logs
 * gracefully and returns [] — the crawler is non-failure on empty results.
 *
 * Probe strategy when the page DOES load: the Stadt Zürich municipal CMS is
 * Drupal/TYPO3-flavoured and listings tend to use `.job-list-item` /
 * `[data-job-id]` / `article.job` selectors. We try a defensive cascade of
 * known patterns and fall back to extracting any `<a href>` containing
 * "/karriere/" or "/jobs/" / "/stellen/".
 *
 * Once the embedded ATS is identified (Umantis / Prospective / SuccessFactors)
 * this scraper should be replaced with the matching dedicated client; until
 * then the DOM scrape is the safest non-CH-IP best-effort.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllStadtspitalZuerichJobs()  — Fetch and parse all jobs
 *   - isStadtspitalZuerichJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()                 — Validate URLs belong to this company
 *   - STADTSPITAL_ZUERICH_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  createBrowser,
  createPoliteContext,
  fetchWithRateLimit,
  closeAll,
  BrowserLaunchError,
  NavigationTimeout,
  AntiBotBlockError,
} from './ats-clients/playwright-runtime.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const STADTSPITAL_ZUERICH_KEY = 'stadtspital-zuerich';
export const STADTSPITAL_ZUERICH_COMPANY_NAME = 'Stadtspital Zürich';
export const STADTSPITAL_ZUERICH_COMPANY_DOMAIN = 'stadtspital.ch';

const CAREER_URL = 'https://www.stadtspital.ch/karriere';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Stadtspital Zürich.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isStadtspitalZuerichJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === STADTSPITAL_ZUERICH_KEY ||
    key.startsWith('stadtspital-zuerich') ||
    company.includes('stadtspital zürich') ||
    url.includes('stadtspital.ch')
  );
}

/**
 * Validate that a URL belongs to Stadtspital Zürich's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'stadtspital.ch' || host.endsWith('.stadtspital.ch');
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

/**
 * Defensive selector cascade tried on the rendered DOM. First non-empty
 * match wins. Built from common CH municipal-CMS patterns (Drupal/TYPO3 +
 * embedded SuccessFactors / Umantis / Prospective widgets).
 */
const PROBE_SELECTORS = [
  '[data-job-id]',
  'article.job, article.job-list-item',
  '.job-list-item, .joblist-item, .stellen-item',
  '.career-list .career-item, .karriere-list .karriere-item',
  'a[href*="/karriere/"], a[href*="/stellen/"], a[href*="/jobs/"]',
];

/**
 * Run a defensive DOM scrape against the rendered Stadtspital Zürich
 * `/karriere` page. Returns raw {title, location, url} listings; the caller
 * normalises them into ParsedJob objects.
 *
 * Always non-throwing — geo-block / anti-bot / chromium-launch failures are
 * logged and surfaced as an empty array.
 */
async function fetchJobListings() {
  console.log(`   Fetching from: ${CAREER_URL}`);

  let browser = null;
  try {
    browser = await createBrowser();
  } catch (err) {
    if (err instanceof BrowserLaunchError) {
      console.warn(`   ⚠️ chromium launch failed (${err.message}); returning [].`);
      return [];
    }
    throw err;
  }

  try {
    const context = await createPoliteContext(browser);
    let page;
    try {
      page = await fetchWithRateLimit(context, CAREER_URL);
    } catch (err) {
      if (err instanceof NavigationTimeout) {
        console.warn(
          `   ⚠️ Stadtspital Zürich navigation timed out — likely the TCP-level ` +
            `geo-block (CH-only). This is expected from non-CH IPs; returning [].`,
        );
        return [];
      }
      if (err instanceof AntiBotBlockError) {
        console.warn(
          `   ⚠️ Stadtspital Zürich returned an anti-bot block ` +
            `(status=${err.status ?? 'n/a'}, title=${JSON.stringify(err.title ?? '')}); ` +
            `returning [].`,
        );
        return [];
      }
      throw err;
    }

    // Give the SPA / Drupal embed a beat to render any deferred listings.
    try {
      await page.waitForLoadState('networkidle', { timeout: 10_000 });
    } catch {
      /* networkidle is best-effort; carry on with whatever rendered */
    }

    const raw = await page.evaluate((selectorList) => {
      const seen = new Set();
      const items = [];

      const pushItem = (titleText, href, locationText) => {
        const t = (titleText || '').replace(/\s+/g, ' ').trim();
        const u = href || '';
        if (!t || t.length < 3) return;
        const key = u || t;
        if (seen.has(key)) return;
        seen.add(key);
        items.push({
          title: t,
          url: u,
          location: (locationText || '').replace(/\s+/g, ' ').trim() || 'Zürich',
        });
      };

      for (const sel of selectorList) {
        const nodes = document.querySelectorAll(sel);
        if (!nodes || nodes.length === 0) continue;
        nodes.forEach((node) => {
          // Anchor case
          if (node.tagName === 'A') {
            pushItem(
              node.textContent || node.getAttribute('aria-label') || '',
              node.href || '',
              '',
            );
            return;
          }
          // Container case — look for nested anchor + location chip
          const anchor = node.querySelector('a[href]');
          const titleNode =
            node.querySelector('[class*="title"], h2, h3, h4') || anchor;
          const locNode = node.querySelector(
            '[class*="location"], [class*="standort"], [class*="ort"]',
          );
          pushItem(
            titleNode ? titleNode.textContent : '',
            anchor ? anchor.href : '',
            locNode ? locNode.textContent : '',
          );
        });
        if (items.length > 0) break; // first matching selector wins
      }
      return items;
    }, PROBE_SELECTORS);

    if (!raw || raw.length === 0) {
      console.warn(
        `   ⚠️ Stadtspital Zürich page rendered but no known listing pattern matched. ` +
          `The site likely embeds an external ATS — re-probe and clone the matching adapter.`,
      );
      return [];
    }

    return raw;
  } catch (err) {
    console.warn(
      `   ⚠️ Stadtspital Zürich scrape failed unexpectedly: ${err && err.message ? err.message : err}; returning [].`,
    );
    return [];
  } finally {
    await closeAll(browser);
  }
}

/**
 * Fetch all Stadtspital Zürich jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllStadtspitalZuerichJobs() {
  console.log(`🔍 Fetching Stadtspital Zürich jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
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

    const location = listing.location || 'Zürich';
    const canton = inferSwissTargetCanton(location) || 'ZH';
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} stadtspital-zuerich ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `stadtspital-zuerich-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: STADTSPITAL_ZUERICH_COMPANY_NAME,
      companyKey: STADTSPITAL_ZUERICH_KEY,
      companyDomain: STADTSPITAL_ZUERICH_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Stadtspital Zürich`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Stadtspital Zürich` },
      location,
      canton,
      url: publicUrl,
      source: 'Stadtspital Zürich Dedicated Parser',
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
      sector: 'Sanità / Ospedali',
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

  console.log(`\n📋 Total Stadtspital Zürich jobs discovered: ${jobs.length}`);
  return jobs;
}
