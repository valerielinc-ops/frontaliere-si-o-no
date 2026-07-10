#!/usr/bin/env node
/**
 * CSS Versicherung AG job parser — Fetcher and job builder.
 *
 * Source: https://jobs.css.ch/ — a Prospective.ch-hosted careercenter
 * (asset path `/careercenter/1000981/`) whose apply links point at a
 * SAP SuccessFactors backend (`atsconnector.prospective.ch/successfactors/
 * EMEA_PREMIUM/CSS/...`). UNLIKE most other Prospective tenants in this
 * codebase, medium 1000981 does NOT expose the public
 * `https://ohws.prospective.ch/public/v1/medium/{ID}/jobs` JSON API
 * (verified live: every lang returns `400 BAD_REQUEST`, while the same
 * endpoint pattern works fine for other tenants such as Balgrist). The
 * shared `createProspectiveChParser` factory therefore cannot be reused
 * here — this parser scrapes the tenant's own HTML front-end instead.
 *
 * Actual mechanism (verified live 2026-07-03):
 *   1. Listing pages: GET https://jobs.css.ch/?lang={lang}&offset={N}&limit={L}
 *      returns an HTML fragment with `a.job-title[href*="/offene-stellen/"]`
 *      anchors. Paginate by offset until a page returns zero NEW links
 *      (72 open positions confirmed at limit=50: page 1 = 50, page 2 = 22).
 *   2. Each job detail page (https://jobs.css.ch/offene-stellen/{slug}/{id})
 *      embeds a single `<script type="application/ld+json">` schema.org
 *      JobPosting block with the full title/description/employmentType/
 *      datePosted/jobLocation.address — used as the primary data source
 *      instead of re-parsing the detail page's visible HTML.
 *
 * CSS posts jobs across many Swiss cantons (regional Kundenberatung
 * agencies + head-office roles) — canton is inferred per job from the
 * JSON-LD `addressLocality` (the real city), never defaulted to HQ.
 * `addressRegion` in CSS's own data is a marketing label ("Region
 * Zentralschweiz", "Suisse romande", ...), not a canton — do not use it
 * for canton inference.
 *
 * HQ: Tribschenstrasse 21, 6002 Luzern LU (confirmed via Kompass/
 * Moneyhouse/OpenCorpData cross-reference; postal code 6002 matches what
 * CSS's own live JobPosting JSON-LD emits for its Luzern-based postings).
 *
 * `streetAddress` is always empty in CSS's own JSON-LD (verified across
 * multiple samples) — the canton-gated HQ fallback below supplies it only
 * when the job's own canton matches HQ's canton, exactly like `postalCode`.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllCssVersicherungJobs() — Fetch and parse all jobs
 *   - isCssVersicherungJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()             — Validate URLs belong to this company
 *   - slugify() / stripHtml()       — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const CSS_VERSICHERUNG_KEY = 'css-versicherung';
export const CSS_VERSICHERUNG_COMPANY_NAME = 'CSS Versicherung';
export const CSS_VERSICHERUNG_COMPANY_DOMAIN = 'css.ch';

const CAREER_URL = 'https://jobs.css.ch/';
const LIST_PAGE_SIZE = 50;
const MAX_OFFSET = 2000; // safety cap against a runaway pagination loop
const SECTOR = 'Assicurazioni';
const REQUEST_DELAY_MS = 200;

const HQ = {
  city: 'Luzern',
  canton: 'LU',
  postalCode: '6002',
  streetAddress: 'Tribschenstrasse 21',
  region: 'LU',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to CSS Versicherung.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isCssVersicherungJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === CSS_VERSICHERUNG_KEY ||
    key.startsWith('css-versicherung') ||
    company.includes('css versicherung') ||
    company === 'css' ||
    url.includes('jobs.css.ch')
  );
}

/**
 * Validate that a URL belongs to CSS Versicherung's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'css.ch' || host === 'jobs.css.ch' || host.endsWith('.css.ch');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(underwrit|schaden|sinistr|claims|leistung)/.test(t)) return 'Assicurazioni';
  if (/\b(kundenberat|consulen.*client|conseill.*client|customer|service client)/.test(t)) return 'Servizio Clienti';
  if (/\b(vendita|sales|verkauf|vente|akquisi|acquisiz)/.test(t)) return 'Commerciale';
  if (/\b(it|software|develop|programm|data|cloud|devops)/.test(t)) return 'IT';
  if (/\b(admin|segret|contab|buchhalt|account|comptab)/.test(t)) return 'Amministrazione';
  if (/\b(hr|human|risorse|personal|ressources humaines)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz|communication)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ|controll)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht|jurid|compliance)/.test(t)) return 'Legale';
  if (/\b(actuar|attuari|mathematik)/.test(t)) return 'Attuariato';
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'Formazione';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|manager)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/**
 * Resolve the canton-gated address fields for a job.
 *
 * Mirrors the yapeal-job-parser.mjs `resolveAddress()` pattern: postalCode
 * and streetAddress are NEVER unconditionally backfilled from HQ — only
 * when the job's own inferred canton matches HQ's canton. CSS's own
 * JSON-LD usually provides an accurate per-job postalCode (unlike office-
 * only sources), so that value is preferred when it looks valid; it is
 * never trusted blindly since at least one edge case in the live data
 * ("Root et/ou Lausanne") emits a malformed combined value ("6037/1100").
 */
function resolveAddress(address = {}) {
  const rawLocality = normalizeSpace(address.addressLocality || '');
  const canton = rawLocality ? inferSwissTargetCanton(rawLocality) : '';
  const rawPostal = String(address.postalCode || '').trim();
  const postalCode = /^\d{4}$/.test(rawPostal) ? rawPostal : '';
  const rawStreet = normalizeSpace(address.streetAddress || '');

  if (!rawLocality || !canton) {
    // No usable location signal — fall back to HQ entirely (never dropped).
    return {
      city: HQ.city,
      canton: HQ.canton,
      postalCode: postalCode || HQ.postalCode,
      streetAddress: rawStreet || HQ.streetAddress,
      region: HQ.region,
    };
  }

  const isHqCity = /luzern|lucerne/i.test(rawLocality);
  return {
    city: rawLocality,
    canton,
    postalCode: postalCode || (isHqCity ? HQ.postalCode : ''),
    streetAddress: rawStreet || (isHqCity ? HQ.streetAddress : ''),
    region: canton,
  };
}

/* ── HTTP helpers ─────────────────────────────────────────── */

/**
 * Extract job detail URLs from one listing page's HTML.
 */
function extractListingLinks(html = '') {
  const links = new Set();
  const re = /<a\s+class="job-title"[^>]*href="([^"]+)"/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    const href = String(match[1] || '').trim();
    if (href.includes('/offene-stellen/')) {
      links.add(href.startsWith('http') ? href : new URL(href, CAREER_URL).toString());
    }
  }
  return [...links];
}

/**
 * Discover every open job URL by paginating the listing endpoint until a
 * page contributes zero new links.
 */
async function collectAllJobUrls() {
  const seen = new Set();
  let offset = 0;

  while (offset < MAX_OFFSET) {
    const listUrl = `${CAREER_URL}?lang=de&offset=${offset}&limit=${LIST_PAGE_SIZE}`;
    let html;
    try {
      html = await fetchHtml(listUrl, { headers: { Accept: 'text/html,application/xhtml+xml' } });
    } catch (err) {
      console.warn(`  ⚠️  Listing fetch failed at offset=${offset}: ${err?.message || err}`);
      break;
    }

    const links = extractListingLinks(html);
    if (!links.length) break;

    let newCount = 0;
    for (const link of links) {
      if (!seen.has(link)) {
        seen.add(link);
        newCount += 1;
      }
    }
    if (newCount === 0) break; // fully duplicate page → pagination exhausted

    offset += LIST_PAGE_SIZE;
    await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
  }

  return [...seen];
}

/**
 * Extract and parse the schema.org JobPosting block embedded in a job
 * detail page.
 */
function parseJobPostingJsonLd(html = '') {
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    try {
      const payload = JSON.parse(match[1]);
      const candidates = Array.isArray(payload) ? payload : [payload];
      for (const candidate of candidates) {
        if (candidate && candidate['@type'] === 'JobPosting') return candidate;
      }
    } catch {
      // Malformed JSON-LD block — try the next <script> tag, if any.
    }
  }
  return null;
}

/* ── Main Fetcher ─────────────────────────────────────────── */

/**
 * Fetch and parse all open CSS Versicherung jobs.
 */
export async function fetchAllCssVersicherungJobs() {
  console.log(`🔍 Fetching ${CSS_VERSICHERUNG_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL} (Prospective careercenter listing + per-job JobPosting JSON-LD)\n`);

  const jobUrls = await collectAllJobUrls();
  if (!jobUrls.length) {
    console.warn('⚠️  No job listings discovered.');
    return [];
  }
  console.log(`  📋 Listings found: ${jobUrls.length}`);

  const jobs = [];

  for (const jobUrl of jobUrls) {
    let html;
    try {
      html = await fetchHtml(jobUrl, { headers: { Accept: 'text/html,application/xhtml+xml' } });
    } catch (err) {
      console.warn(`  ⚠️  Skipping ${jobUrl} — fetch failed: ${err?.message || err}`);
      continue;
    }

    const jsonLd = parseJobPostingJsonLd(html);
    if (!jsonLd) {
      console.warn(`  ⚠️  Skipping ${jobUrl} — no JobPosting JSON-LD found`);
      continue;
    }

    const title = normalizeSpace(jsonLd.title || '');
    if (!title || title.length < 3) continue;

    const address = jsonLd.jobLocation?.address || {};
    const { city, canton, postalCode, streetAddress, region } = resolveAddress(address);

    let descriptionText = stripHtml(jsonLd.description || '');
    const sourceLang = detectLang(descriptionText || title, 'de');

    // Thin-content guard (Non-Negotiable #4): never index < 50 words —
    // mirrors the enrichment pattern used by sibling parsers (e.g.
    // afry-job-parser.mjs) rather than dropping the job outright.
    const wordCount = descriptionText.split(/\s+/).filter(Boolean).length;
    if (wordCount < 50) {
      descriptionText = [
        descriptionText || `${title} — ${CSS_VERSICHERUNG_COMPANY_NAME}, ${city}.`,
        'Die CSS ist eine der führenden Kranken- und Sachversicherungen der Schweiz mit rund 1,7 Millionen Kundinnen und Kunden, rund 100 Agenturen in der ganzen Schweiz und rund 3000 Mitarbeitenden. Seit 1899 begleitet die CSS Menschen in der Schweiz mit Grundversicherung, Zusatzversicherungen und Vorsorgelösungen und bietet ihren Mitarbeitenden flexible Arbeitsmodelle, Weiterbildungsmöglichkeiten und ein dynamisches Arbeitsumfeld.',
        'Bewirb dich direkt online über jobs.css.ch.',
      ]
        .filter(Boolean)
        .join('\n\n');
    }

    const employmentType =
      String(jsonLd.employmentType || '').toUpperCase().trim() || detectEmploymentType(title);
    const applyUrl = String(jsonLd.url || '').trim() || jobUrl;
    const jobSlug = slugify(`${title} css versicherung ${city}`);
    const urlHash = createHash('sha1').update(jobUrl).digest('hex').slice(0, 12);

    const postedDate = (() => {
      const parsed = new Date(String(jsonLd.datePosted || ''));
      return Number.isNaN(parsed.getTime())
        ? new Date().toISOString().slice(0, 10)
        : parsed.toISOString().slice(0, 10);
    })();

    const job = {
      id: `${CSS_VERSICHERUNG_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: jsonLd.hiringOrganization?.name || CSS_VERSICHERUNG_COMPANY_NAME,
      companyKey: CSS_VERSICHERUNG_KEY,
      companyDomain: CSS_VERSICHERUNG_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location: city,
      canton,
      url: jobUrl,
      source: `${CSS_VERSICHERUNG_COMPANY_NAME} Dedicated Parser (Prospective careercenter + JobPosting JSON-LD)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: city,
      addressRegion: region,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
  }

  console.log(`\n📋 Total ${CSS_VERSICHERUNG_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
