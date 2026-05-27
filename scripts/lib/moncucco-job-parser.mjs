#!/usr/bin/env node
/**
 * Gruppo Ospedaliero Moncucco job parser — Fetcher and job builder.
 *
 * Source: https://www.moncucco.ch/lavora-con-noi.php
 *
 * Simple static PHP page. Job listings are <a> cards, each containing:
 *   <h3>Job Title</h3>
 *   <p>Percentuale di impiego: 80-100%</p>
 *   <p>Disponibilità: Da convenire</p>
 * Detail pages are at https://www.moncucco.ch/{slug}.php5
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllMoncuccoJobs()  — Fetch and parse all jobs
 *   - isMoncuccoJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, buildJobSlug, stripHtml, normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

const BASE_URL = 'https://www.moncucco.ch';
const CAREERS_URL = 'https://www.moncucco.ch/lavora-con-noi.php';
const HQ = getCompanyDefaults('moncucco');

export const MONCUCCO_KEY = 'moncucco';
export const MONCUCCO_COMPANY_NAME = 'Gruppo Ospedaliero Moncucco';
export const MONCUCCO_COMPANY_DOMAIN = 'moncucco.ch';

export const MIN_DESC_LENGTH = 100;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Gruppo Ospedaliero Moncucco.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isMoncuccoJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === MONCUCCO_KEY ||
    key.startsWith('moncucco') ||
    company.includes('gruppo ospedaliero moncucco') ||
    url.includes('moncucco.ch')
  );
}

/**
 * Validate that a URL belongs to Gruppo Ospedaliero Moncucco's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'moncucco.ch' || host.endsWith('.moncucco.ch');
  } catch {
    return false;
  }
}

/* ── HTML Parsing ─────────────────────────────────────────── */

/* Exported for tests — pure HTML→data transforms. */
export { parseListingPage, parseDetailPage };

/**
 * Parse the Moncucco careers listing page.
 *
 * The careers page (/lavora-con-noi.php) wraps each open position in a
 * `.item-job` block:
 *   <div class="item-job">
 *     <a href="https://www.moncucco.ch/{slug}.php5">
 *       <h3>Job Title</h3>
 *       <p>Lead paragraph…</p>
 *       <div class="info-job">Percentuale di impiego: <span>…</span></div>
 *       <div class="info-job">Disponibilità: <span>…</span></div>
 *     </a>
 *   </div>
 *
 * The page also contains other `<a><h3>` blocks (CANDIDATURA SPONTANEA box,
 * "Unione Clinica Moncucco" group card, megamenu items). Scoping to
 * `.item-job a` keeps real openings and rejects those decoys.
 *
 * Detail URLs always end in `.php5` — used as a final guard in case the
 * markup grows new sibling cards inside `.listing-job`.
 */
function parseListingPage(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  const cardLinks = document.querySelectorAll('.item-job a[href], .listing-job .item-job a[href]');
  for (const link of cardLinks) {
    const h3 = link.querySelector('h3, h4');
    if (!h3) continue;

    const title = normalizeSpace(h3.textContent || '');
    if (!title || title.length < 3) continue;

    const href = link.getAttribute('href') || '';
    if (!href) continue;
    const url = href.startsWith('http') ? href : `${BASE_URL}/${href.replace(/^\//, '')}`;
    // Job detail pages on moncucco.ch end with `.php5`; reject anything else.
    if (!/\.php5(?:[?#]|$)/i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    let percentage = '';
    let availability = '';
    for (const info of link.querySelectorAll('.info-job, p')) {
      const text = normalizeSpace(info.textContent || '');
      if (!text) continue;
      if (!percentage && /percentuale|impiego|%/i.test(text)) {
        percentage = text;
      } else if (!availability && /disponibilit/i.test(text)) {
        availability = text;
      }
    }

    jobs.push({ title, url, percentage, availability });
  }

  return jobs;
}

/**
 * Parse a Moncucco job detail page for full description.
 *
 * On moncucco.ch detail pages (`/{slug}.php5`), the job body lives inside
 * `<div class="testo-pagina">`. The previous implementation walked generic
 * selectors like `.container` / `main` / `article`, which on this template
 * match the whole page — so descriptions ended up containing the megamenu
 * (Pronto soccorso, Le strutture, Specializzazioni…) instead of the offer.
 *
 * Strip `<script>`, `<style>`, and the `.section-altri-job` carousel
 * ("Le altre posizioni aperte") before extracting text so the description
 * doesn't bleed sibling job titles into this one.
 */
function parseDetailPage(html = '') {
  if (!html) return '';

  const { document } = new JSDOM(html).window;

  for (const noisy of document.querySelectorAll(
    'script, style, noscript, .section-altri-job, .droopmenu-navbar, footer, .footer',
  )) {
    noisy.remove();
  }

  const BODY_SELECTORS = ['.testo-pagina', '.col-testo-pagina', '.section-contenuto-info'];

  let body = '';
  for (const sel of BODY_SELECTORS) {
    for (const el of document.querySelectorAll(sel)) {
      const candidate = stripHtml(el.innerHTML || '');
      if (candidate.length > body.length) body = candidate;
    }
    if (body.length >= MIN_DESC_LENGTH) break;
  }

  return body;
}

/* ── Category / Employment helpers ────────────────────────── */

function detectCategory(title = '') {
  const t = title.toLowerCase();
  if (/medic|dottor|chirurg|anest|pronto soccorso|cardiol|radiolog|patolog/i.test(t)) return 'medical';
  if (/infermier|nurse|pflege|cura/i.test(t)) return 'nursing';
  if (/fisioterapi|ergoterapi|logoped|riabilit/i.test(t)) return 'rehabilitation';
  if (/farmaci|pharmacy/i.test(t)) return 'pharmacy';
  if (/laborator|analisi|biomedic/i.test(t)) return 'laboratory';
  if (/admin|segret|contab|buchhalt|account/i.test(t)) return 'admin';
  if (/techni|tecnic|mecanic|elektr|install|manutenz/i.test(t)) return 'engineering';
  if (/cucin|chef|ristora|gastro|cuoco/i.test(t)) return 'hospitality';
  if (/pulizia|housekeep|igiene/i.test(t)) return 'housekeeping';
  if (/\bit\b|software|develop|programm|informatic/i.test(t)) return 'technology';
  return 'healthcare';
}

function detectExperienceLevel(title = '') {
  if (/stage|stagiair|apprendist|junior|tirocinant/i.test(title)) return 'ENTRY';
  if (/senior|capo|responsabil|dirigent|primario|chef/i.test(title)) return 'SENIOR';
  return 'MID';
}

function inferEmploymentType(title = '', percentageText = '') {
  const combined = `${title} ${percentageText}`;
  if (/part[- ]?time|teilzeit|tempo parziale/i.test(combined)) return 'PART_TIME';
  const pctMatch = combined.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || combined.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2]) : parseInt(pctMatch[1]);
    if (maxPct < 80) return 'PART_TIME';
  }
  return 'FULL_TIME';
}

/* ── Main fetch function ──────────────────────────────────── */

/**
 * Fetch all Moncucco jobs. Returns ParsedJob[] (source locale only).
 */
export async function fetchAllMoncuccoJobs() {
  console.log(`  Fetching Moncucco jobs from ${CAREERS_URL}`);

  let html = '';
  try {
    html = await fetchHtml(CAREERS_URL, { timeoutMs: 20000 });
  } catch (err) {
    console.warn(`  Failed to fetch: ${err.message}`);
    return [];
  }
  const listings = parseListingPage(html);
  console.log(`  Jobs found on listing page: ${listings.length}`);
  if (!listings.length) return [];

  const jobs = [];
  for (const listing of listings) {
    let description = '';
    if (listing.url) {
      try {
        const detailHtml = await fetchHtml(listing.url, { timeoutMs: 15000 });
        description = parseDetailPage(detailHtml);
      } catch (err) {
        console.warn(`  Detail fetch failed for ${listing.url}: ${err.message}`);
      }
    }

    // Build a snippet from listing metadata if description is thin
    if (!description || description.length < MIN_DESC_LENGTH) {
      const parts = [listing.title, '— Gruppo Ospedaliero Moncucco, Lugano'];
      if (listing.percentage) parts.push(listing.percentage);
      if (listing.availability) parts.push(listing.availability);
      description = parts.join(' ');
    }

    const sourceLang = detectLang(listing.title, 'it');
    const jobSlug = buildJobSlug(`${listing.title} Lugano`, 'moncucco');
    const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);
    const empType = inferEmploymentType(listing.title, listing.percentage);

    jobs.push({
      id: `${MONCUCCO_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: MONCUCCO_COMPANY_NAME,
      companyKey: MONCUCCO_KEY,
      companyDomain: MONCUCCO_COMPANY_DOMAIN,
      title: listing.title,
      titleByLocale: { [sourceLang]: listing.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: 'Lugano',
      canton: HQ.canton,
      addressLocality: 'Lugano',
      addressRegion: HQ.addressRegion,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ.postalCode,
      category: detectCategory(listing.title),
      sector: 'Sanità / Ospedaliero',
      contract: empType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: empType,
      experienceLevel: detectExperienceLevel(listing.title),
      featured: false,
      postedDate: new Date().toISOString().slice(0, 10),
      url: listing.url,
      applyUrl: listing.url,
      source: 'Gruppo Ospedaliero Moncucco Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
    });
  }

  console.log(`  Total Moncucco jobs discovered: ${jobs.length}`);
  return jobs;
}
