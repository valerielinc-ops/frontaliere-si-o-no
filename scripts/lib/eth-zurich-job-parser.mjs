#!/usr/bin/env node
/**
 * ETH Zürich job parser — Fetcher and job builder.
 *
 * Source: https://jobs.ethz.ch/
 *
 * Strategy: HTML scrape (no public JSON API exposed by jobs.ethz.ch).
 *
 * Each listing is a single anchor:
 *   <a class="job-ad__item__link"
 *      href="/job/view/JOPG_ethz_<id>"
 *      aria-label="<title> - <percentage>, <location>, <fixed-term/unbefristet>">
 *
 * The page renders all jobs (~110) at once — no pagination, no JS-only render,
 * no public Umantis-style JSON endpoint discovered as of 2026-05-10. Plain
 * `fetch()` + regex extraction is sufficient and avoids the Playwright tax.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllEthZurichJobs()  — Fetch and parse all jobs
 *   - isEthZurichJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()        — Validate URLs belong to this company
 *   - slugify() / stripHtml()  — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeDescriptionBullets } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const ETH_ZURICH_KEY = 'eth-zurich';
export const ETH_ZURICH_COMPANY_NAME = 'ETH Zürich';
export const ETH_ZURICH_COMPANY_DOMAIN = 'ethz.ch';

const CAREER_URL = 'https://jobs.ethz.ch/';
const JOB_DETAIL_BASE = 'https://jobs.ethz.ch';
const USER_AGENT = 'Mozilla/5.0 (compatible; FrontaliereTicino-JobCrawler/2.0; +https://frontaliereticino.ch)';
const REQUEST_TIMEOUT_MS = 20_000;
const DETAIL_RATE_LIMIT_MS = 350;
const MAX_DETAIL_FETCHES = 200; // cover the full ~110-listing index; rate-limited via DETAIL_RATE_LIMIT_MS

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(s = '') {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'de,en;q=0.8,it;q=0.5',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to ETH Zürich.
 */
export function isEthZurichJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === ETH_ZURICH_KEY ||
    key.startsWith('eth-zurich') ||
    key === 'eth' ||
    company.includes('eth zürich') ||
    company.includes('eth zurich') ||
    url.includes('jobs.ethz.ch') ||
    url.includes('ethz.ch/jobs')
  );
}

/**
 * Validate that a URL belongs to ETH Zürich's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'ethz.ch' ||
      host.endsWith('.ethz.ch') ||
      host === 'jobs.ethz.ch'
    );
  } catch {
    return false;
  }
}

/* ── Category / Level / Type Detection ─────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(phd|doctoral|doktorand|dottorat)/.test(t)) return 'Ricerca';
  if (/\b(postdoc|post.?doc)/.test(t)) return 'Ricerca';
  if (/\b(professor|professur|professore)/.test(t)) return 'Accademico';
  if (/\b(research|forschung|ricerca|wissenschaftlich|scientific)/.test(t)) return 'Ricerca';
  if (/\b(ingegner|engineer|entwickl|architekt)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mechanic|elektr|install|laborant|techniker)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account|sachbearbeit)/.test(t)) return 'Amministrazione';
  if (/\b(it|software|develop|programm|data|machine.?learning|computing)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz|medien)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|controlling)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|student.?(assistant|research))/.test(t)) return 'intern';
  if (/\b(phd|doctoral|doktorand|dottorat)/.test(t)) return 'junior';
  if (/\b(postdoc|post.?doc)/.test(t)) return 'mid';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leitung|professor)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  // ETH job aria-labels look like: "... - 80%-100%, Zürich, unbefristet"
  // Pull the first percentage and treat anything <80% as PART_TIME.
  const pctMatch = t.match(/(\d{1,3})\s*%/);
  if (pctMatch) {
    const pct = parseInt(pctMatch[1], 10);
    if (pct < 80) return 'PART_TIME';
    return 'FULL_TIME';
  }
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'FULL_TIME';
}

function detectContract(ariaLabel = '') {
  const t = normalize(ariaLabel);
  if (/\b(befristet|fixed.?term|temps déterminé|tempo determinato)/.test(t)) return 'fixed-term';
  if (/\b(unbefristet|permanent|tempo indeterminato|durée indéterminée)/.test(t)) return 'full-time';
  return 'full-time';
}

/* ── HTML Parsing ──────────────────────────────────────────── */

/**
 * Extract job listings from the jobs.ethz.ch index page.
 * Each listing is rendered as an anchor with class `job-ad__item__link`
 * and an `aria-label` containing "<title> - <pct>, <location>, <term>".
 *
 * @param {string} html
 * @returns {Array<{ title: string, location: string, contractHint: string, jobId: string, url: string, ariaLabel: string }>}
 */
function parseListings(html) {
  const out = [];
  const seen = new Set();
  // Match the full anchor opening tag (attributes can be in any order).
  const re = /<a\b[^>]*class="[^"]*\bjob-ad__item__link\b[^"]*"[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const hrefMatch = tag.match(/href="([^"]+)"/i);
    const ariaMatch = tag.match(/aria-label="([^"]+)"/i);
    if (!hrefMatch || !ariaMatch) continue;

    const rawHref = decodeHtmlEntities(hrefMatch[1]);
    const ariaLabel = decodeHtmlEntities(ariaMatch[1]);
    const url = rawHref.startsWith('http')
      ? rawHref
      : `${JOB_DETAIL_BASE}${rawHref.startsWith('/') ? '' : '/'}${rawHref}`;

    const idMatch = url.match(/\/job\/view\/([A-Za-z0-9_-]+)/);
    const jobId = idMatch ? idMatch[1] : createHash('sha1').update(url).digest('hex').slice(0, 16);
    if (seen.has(jobId)) continue;
    seen.add(jobId);

    // aria-label format: "<title> - <pct>, <location>, <term>"
    // Split from the right on ", " to robustly extract the trailing fields.
    const parts = ariaLabel.split(/,\s*/);
    let term = '';
    let location = '';
    let titleAndPct = ariaLabel;
    if (parts.length >= 3) {
      term = parts[parts.length - 1].trim();
      location = parts[parts.length - 2].trim();
      titleAndPct = parts.slice(0, -2).join(', ');
    }
    // titleAndPct still contains " - <pct>" suffix; strip the last " - <pct>" segment.
    const dashIdx = titleAndPct.lastIndexOf(' - ');
    const title = dashIdx > 0 ? titleAndPct.slice(0, dashIdx).trim() : titleAndPct.trim();

    out.push({
      title: normalizeSpace(title),
      location: normalizeSpace(location || 'Zürich'),
      contractHint: normalizeSpace(term),
      jobId,
      url,
      ariaLabel,
    });
  }
  return out;
}

/**
 * Optionally enrich a listing with description text from its detail page.
 * Best-effort — failures fall back to the aria-label as description.
 */
async function fetchDetailDescription(url) {
  try {
    const html = await fetchText(url);
    // Look for the main job-ad text container; fall back to <main> or <article>.
    const blockMatch =
      html.match(/<div[^>]*class="[^"]*\bjob-ad-text\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<\/main>)/i) ||
      html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
      html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    if (!blockMatch) return '';
    const text = stripHtml(decodeHtmlEntities(blockMatch[1]));
    // crawler-template.stripHtml converts <li> → "\n• " so list structure
    // survives; preserve newlines (only collapse intra-line whitespace), then
    // restore bullet markers for any inline `•` that slipped through.
    const compact = text
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return normalizeDescriptionBullets(compact).slice(0, 4000);
  } catch {
    return '';
  }
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

async function fetchJobListings() {
  console.log(`   Fetching from: ${CAREER_URL}`);
  const html = await fetchText(CAREER_URL);
  const listings = parseListings(html);
  console.log(`   Parsed ${listings.length} job-ad__item__link anchors`);
  return listings;
}

/**
 * Fetch all ETH Zürich jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 */
export async function fetchAllEthZurichJobs() {
  console.log(`🔍 Fetching ETH Zürich jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  let detailFetches = 0;

  for (const listing of listings) {
    const title = listing.title;
    if (!title || title.length < 3) continue;

    // ETH HQ is Zürich (Zentrum + Hönggerberg). Some satellite postings
    // (e.g. Singapore — ETH SEC) keep their declared location verbatim;
    // inferSwissTargetCanton returns null for non-CH and we fall through to ZH
    // only when the location string clearly maps to a Swiss town.
    const location = listing.location || 'Zürich';
    const canton = inferSwissTargetCanton(location) || (
      /singapore|new york|boston|london|paris|berlin/i.test(location) ? '' : 'ZH'
    );
    const publicUrl = listing.url;

    let descriptionText = '';
    if (detailFetches < MAX_DETAIL_FETCHES) {
      descriptionText = await fetchDetailDescription(publicUrl);
      detailFetches += 1;
      await new Promise((r) => setTimeout(r, DETAIL_RATE_LIMIT_MS));
    }
    if (!descriptionText) {
      const fallbackBits = [
        `${title} — ETH Zürich (${location}).`,
        '',
        'Eckdaten der Stelle:',
        `• Standort: ${location}${canton ? `, Kanton ${canton}` : ''}`,
        `• Pensum/Vertrag: ${listing.ariaLabel || 'siehe Stellenbeschrieb'}`,
        '• Arbeitgeber: ETH Zürich — Eidgenössische Technische Hochschule',
        '• Bewerbungsplattform: jobs.ethz.ch',
      ];
      descriptionText = fallbackBits.join('\n');
    }

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} eth-zurich ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `eth-zurich-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ETH_ZURICH_COMPANY_NAME,
      companyKey: ETH_ZURICH_KEY,
      companyDomain: ETH_ZURICH_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'ETH Zürich Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: detectContract(listing.contractHint),
      employmentType: detectEmploymentType(listing.ariaLabel || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Università / Ricerca',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ETH Zürich jobs discovered: ${jobs.length}`);
  console.log(`   Detail-page fetches: ${detailFetches}/${listings.length}`);
  return jobs;
}
