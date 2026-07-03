#!/usr/bin/env node
/**
 * Google Switzerland job parser — careers.google.com search + detail pages.
 *
 * Source: https://www.google.com/about/careers/applications/jobs/results/?location=Zurich%2C%20Switzerland
 * (issue #3337 Wave D row 2: "Custom, Google Switzerland, Zurigo, ..." — the
 * "Custom" tag turned out accurate: Google's careers portal is a bespoke
 * Google-built Angular/wiz app (product name "HiringCportalFrontendUi"), NOT
 * a 3rd-party ATS. No public REST/GraphQL API and no JobPosting JSON-LD were
 * found (checked both the raw HTML — 0 `application/ld+json` blocks — and the
 * JS-rendered DOM via Jina with `X-Return-Format: html` — still 0 blocks).
 *
 * Both the search-results listing AND the job-detail pages are fully
 * client-rendered: a plain `curl`/`fetch` of either URL returns only the JS
 * app shell (~500KB of bootstrap script, zero job data — confirmed via direct
 * `curl` during discovery). Per the task brief's documented fallback, this
 * parser routes every fetch through the Jina Reader proxy
 * (`JINA_READER_BASE` from ./jina-proxy.mjs + fetchHtml() from this module's
 * sibling ./crawler-template.mjs) which renders the page with a real browser
 * and returns clean Markdown — verified live: the Zurich-filtered search
 * (`?location=Zurich%2C%20Switzerland`) rendered "61 jobs matched" across 4
 * pages of ?page=N (20/20/20/1), and each detail page rendered a clean
 * Minimum/Preferred qualifications + About the job + Responsibilities body.
 * fetchHtml()'s own WAF/anti-bot rescue never fires here (the shell page
 * carries no anti-bot challenge marker — it is a legitimate empty JS shell,
 * not a block), so this parser explicitly builds the Jina-proxied URL itself
 * and hands it to fetchHtml() for the actual network call + retry/timeout
 * handling (no custom Jina retry/backoff logic duplicated here).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllGoogleSwitzerlandJobs() — Fetch and parse all Zurich-eligible jobs
 *   - isGoogleSwitzerlandJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()               — Validate URLs belong to this company
 *   - slugify() / stripHtml()         — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { JINA_READER_BASE } from './jina-proxy.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const GOOGLE_SWITZERLAND_KEY = 'google-switzerland';
export const GOOGLE_SWITZERLAND_COMPANY_NAME = 'Google Switzerland';
export const GOOGLE_SWITZERLAND_COMPANY_DOMAIN = 'google.com';

const CAREER_URL = 'https://www.google.com/about/careers/applications/jobs/results/?location=Zurich%2C%20Switzerland';
const SEARCH_LOCATION_QS = 'location=Zurich%2C%20Switzerland';
const MAX_LISTING_PAGES = 8; // safety cap — 61 jobs / ~20 per page observed live ≈ 4 pages

/* ── HQ fallback (Brandschenkestrasse 110, 8002 Zürich, ZH) ──────────
 * Registered seat of "Google Switzerland GmbH" (Swiss commercial register
 * CHE-110.474.423, https://www.northdata.com/Google%20Switzerland%20GmbH,
 * %20Z%C3%BCrich/CHE-110.474.423), matching Google's own Zurich office
 * listing (Google Maps / about.google location directory). Used only as a
 * street/postal-code fallback for jobs where the Zurich office is the
 * resolved city (see resolveAddress() below — gated on the CITY TEXT, not
 * canton, per scripts/lib/staubli-job-parser.mjs's resolveAddress()).
 */
const HQ = {
  city: 'Zürich',
  canton: 'ZH',
  postalCode: '8002',
  streetAddress: 'Brandschenkestrasse 110',
  region: 'Zürich',
};

const SECTOR = 'Tecnologia / R&D';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Google Switzerland.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isGoogleSwitzerlandJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === GOOGLE_SWITZERLAND_KEY ||
    key.startsWith('google-switzerland') ||
    company === 'google' ||
    company === 'google switzerland' ||
    url.includes('google.com/about/careers')
  );
}

/**
 * Validate that a URL belongs to Google's careers domain.
 * Scoped to google.com (apex + www) rather than any *.google.com subdomain —
 * google.com hosts many unrelated products, so a broad suffix match would be
 * too permissive for a domain-trust check.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'google.com' || host === 'www.google.com';
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
  if (/\b(vendita|sales|verkauf|commerce|account executive)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm|research scientist|data scientist)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '', level = '') {
  const t = normalize(`${title} ${level}`);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|apprenticeship|university grad)/.test(t)) return 'intern';
  if (/\b(junior|jr|early)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|staff|principal|advanced)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(intern|apprenticeship|apprendist)/.test(t)) return 'OTHER';
  return 'FULL_TIME';
}

/**
 * Pick city / postal code / street from the resolved location text, falling
 * back to the documented HQ address (Brandschenkestrasse 110, 8002 Zürich)
 * ONLY when the resolved city text is actually Zurich — never on canton
 * equality alone. Mirrors scripts/lib/staubli-job-parser.mjs's
 * resolveAddress() (city-gated /z[üu]rich/i check, not addressRegion/canton).
 */
function resolveAddress(cityText = '') {
  const city = normalizeSpace(cityText);
  const isZurichCity = /z[üu]rich/i.test(city);
  return {
    city: city || HQ.city,
    postalCode: isZurichCity || !city ? HQ.postalCode : '',
    streetAddress: isZurichCity || !city ? HQ.streetAddress : '',
    region: isZurichCity || !city ? HQ.region : '',
  };
}

/* ── Fetch (Jina-rendered — see module header) ────────────────────── */

/**
 * Fetch a Google careers URL through the Jina Reader proxy via the shared
 * fetchHtml() (timeout/retry/anti-bot-rescue all live there — this only
 * builds the proxied URL from the shared JINA_READER_BASE constant).
 * Jina's default response format is Markdown, which is what the regex-based
 * extraction below is written against.
 */
async function fetchJinaMarkdown(targetUrl) {
  return fetchHtml(`${JINA_READER_BASE}${targetUrl}`);
}

/**
 * Parse one listing page's Markdown into raw job entries.
 * Each entry block looks like:
 *   ### <Title>  _corporate\_fare_ <Org> _place_ <Location>   _\_bar\\_chart\__ <Level> ## <Level>
 *   <snippet>      <Org> | <Location>
 *   #### Minimum qualifications
 *       *   <bullet>
 *       ...
 *   Learn more[](<url>)
 */
function parseListingPage(markdown) {
  const entries = [];
  const blockRe = /###\s+([\s\S]+?)Learn more\[\]\((https:\/\/www\.google\.com\/about\/careers\/applications\/jobs\/results\/(\d+)-([a-z0-9-]+))[^)]*\)/g;
  let m;
  while ((m = blockRe.exec(markdown))) {
    const raw = m[1];
    const canonicalUrl = m[2];
    const jobId = m[3];
    const slugPart = m[4];

    const headMatch = raw.match(/^(.+?)\s+_corporate\\_fare_\s*(.+?)\s+_place_\s*(.+?)\s+_\\_bar\\\\_chart\\__\s*(.+?)\s+##/);
    if (!headMatch) continue;
    const title = normalizeSpace(headMatch[1]);
    const org = normalizeSpace(headMatch[2]);
    const location = normalizeSpace(headMatch[3]);
    const level = normalizeSpace(headMatch[4]);

    const qualsMatch = raw.match(/#### Minimum qualifications\s*([\s\S]*?)(?:Learn more\[\]|$)/);
    const minQualsRaw = qualsMatch ? qualsMatch[1] : '';
    const minQuals = minQualsRaw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('*'))
      .map((l) => normalizeSpace(l.replace(/^\*+\s*/, '')))
      .filter(Boolean);

    if (!title || title.length < 3 || !jobId) continue;

    entries.push({ jobId, slugPart, canonicalUrl, title, org, location, level, minQuals });
  }
  return entries;
}

/**
 * Fetch every listing page (page=1..N) via Jina until a page contributes no
 * new job IDs (last page reached) or MAX_LISTING_PAGES is reached.
 * Dedupes by jobId across pages.
 */
async function fetchJobListings() {
  console.log(`   Fetching (via Jina Reader): ${CAREER_URL}`);
  const seen = new Map();

  for (let page = 1; page <= MAX_LISTING_PAGES; page += 1) {
    const pageUrl = `https://www.google.com/about/careers/applications/jobs/results/?${SEARCH_LOCATION_QS}&page=${page}`;
    let markdown;
    try {
      markdown = await fetchJinaMarkdown(pageUrl);
    } catch (err) {
      console.warn(`   ⚠️ Listing page ${page} fetch failed: ${err?.message || err}`);
      break;
    }
    const entries = parseListingPage(markdown);
    if (entries.length === 0) break;

    let newCount = 0;
    for (const entry of entries) {
      if (!seen.has(entry.jobId)) {
        seen.set(entry.jobId, entry);
        newCount += 1;
      }
    }
    console.log(`   📄 Page ${page}: ${entries.length} entries (${newCount} new, ${seen.size} total)`);

    // Don't rely on entries.length < PAGE_SIZE to detect the last page — the
    // live per-page count is not guaranteed to be exactly PAGE_SIZE (observed
    // 17 and 20 across different live runs). Keep paginating until a page
    // returns zero *new* jobs (checked above) or truly zero entries, capped
    // by MAX_LISTING_PAGES as the hard safety stop.
    if (newCount === 0) break; // no forward progress — avoid infinite loop
  }

  return [...seen.values()];
}

/**
 * Fetch a job's detail page via Jina and return a cleaned description body
 * (Minimum/Preferred qualifications + About the job + Responsibilities),
 * with the boilerplate EEO/legal footer (identical across every posting)
 * trimmed off.
 */
async function fetchJobDescription(canonicalUrl) {
  let markdown;
  try {
    markdown = await fetchJinaMarkdown(canonicalUrl);
  } catch (err) {
    console.warn(`   ⚠️ Detail fetch failed for ${canonicalUrl}: ${err?.message || err}`);
    return '';
  }

  const bodyStart = markdown.indexOf('Markdown Content:');
  let body = bodyStart >= 0 ? markdown.slice(bodyStart + 'Markdown Content:'.length) : markdown;

  // Trim the standard EEO/legal boilerplate footer (identical on every
  // Google careers posting) so the stored description stays job-specific.
  const footerMarkers = [
    'Information collected and processed as part of your Google Careers profile',
    'Google is proud to be an equal opportunity',
  ];
  for (const marker of footerMarkers) {
    const idx = body.indexOf(marker);
    if (idx > 0) {
      body = body.slice(0, idx);
      break;
    }
  }

  // Strip markdown link syntax [text](url) → text, and bold markers.
  body = body
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return body;
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch all Google Switzerland jobs (Zurich R&D hub only).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled by
 * the AI localization step and translate-pending pipeline.
 */
export async function fetchAllGoogleSwitzerlandJobs() {
  console.log(`🔍 Fetching ${GOOGLE_SWITZERLAND_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  const seenUrls = new Set();
  let detailIndex = 0;
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const publicUrl = listing.canonicalUrl;
    if (seenUrls.has(publicUrl)) continue;
    seenUrls.add(publicUrl);

    // Only keep postings whose listed location(s) actually include Zurich
    // (the location filter narrows the search, but multi-location postings
    // can list Zurich alongside other cities — that's still a valid Zurich
    // opening, so we keep it and store the Zurich-facing location text).
    const rawLocation = listing.location || '';
    if (!/z[üu]rich/i.test(rawLocation)) continue;

    detailIndex += 1;
    // Polite delay between sequential Jina detail fetches (mirrors the
    // 250ms inter-page delay used by scripts/lib/apple-retail-switzerland-job-parser.mjs).
    if (detailIndex > 1) await new Promise((r) => setTimeout(r, 300));

    const detailBody = await fetchJobDescription(publicUrl);
    const minQualsText = listing.minQuals.length
      ? `Minimum qualifications:\n${listing.minQuals.map((q) => `• ${q}`).join('\n')}`
      : '';
    const descriptionRaw = detailBody || minQualsText;
    const descriptionText = stripHtml(descriptionRaw) || `${title} — ${GOOGLE_SWITZERLAND_COMPANY_NAME}, Zürich.`;

    const location = 'Zürich';
    const canton = inferSwissTargetCanton(location) || HQ.canton;
    const { city, postalCode, streetAddress, region } = resolveAddress(location);

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} google-switzerland ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(`${listing.level} ${title}`);
    const postedDate = new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${GOOGLE_SWITZERLAND_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: GOOGLE_SWITZERLAND_COMPANY_NAME,
      companyKey: GOOGLE_SWITZERLAND_KEY,
      companyDomain: GOOGLE_SWITZERLAND_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'Google Switzerland Dedicated Parser (Jina-rendered)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      addressRegion: region || canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title, listing.level),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      jobReqId: listing.jobId || null,
      requirements: listing.minQuals || [],
      requirementsByLocale: { [sourceLang]: listing.minQuals || [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${GOOGLE_SWITZERLAND_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
