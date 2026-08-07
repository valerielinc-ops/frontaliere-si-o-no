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
 * ── Fetch strategy: direct HTML first, Jina second (#5295) ──────────────────
 *
 * When this parser was written both the listing AND the detail pages were
 * fully client-rendered — a plain `curl` returned only the JS app shell
 * (~500KB of bootstrap, zero job data) — so every fetch went through the Jina
 * Reader proxy, which renders with a real browser and returns Markdown.
 *
 * That single channel then failed closed. Jina applied an abuse block to
 * `www.google.com` for ALL anonymous traffic (HTTP 403 `AbuseAlleviationError`:
 * "Anonymous access to domain www.google.com blocked until …"), triggered by
 * someone else's use of the shared anonymous pool. It is keyed on the DOMAIN,
 * not on the caller's IP, so `fetchViaJinaWithRetry()`'s IP-rotation retry —
 * built for the per-IP reputation pattern of #1363 — retried into the identical
 * 403 four times over. `fetchJobListings()` broke out of its page loop on the
 * first failure, returned zero listings, and the crawler reported 0 jobs on
 * every run. The block is not a one-off: its expiry timestamp rolled forward
 * on each re-check across several days.
 *
 * Meanwhile Google started server-rendering the same pages. Verified live
 * 2026-08-07 with a plain UA'd `fetch`, no proxy: the Zurich-filtered search
 * returns the complete card markup (title, org, location, experience level,
 * Minimum qualifications) and its own declared total ("34 jobs matched" /
 * "Showing 1 to 20 of 34 rows" — 20 + 14 across `?page=1,2`, reconciled below),
 * and each detail page returns the full Minimum/Preferred qualifications +
 * About the job + Responsibilities body. Still zero `application/ld+json`.
 *
 * So the direct fetch is now the primary path: no proxy, no shared abuse pool,
 * no third-party dependency in the hot path. Jina is kept as the FALLBACK
 * rather than deleted, because it buys something the direct path structurally
 * cannot — it executes JavaScript. If Google reverts to client-rendering, the
 * Markdown path below still works; if it doesn't, the fallback simply never
 * runs.
 *
 * The direct-HTML extraction deliberately anchors on ACCESSIBILITY and ICON
 * attributes (`aria-label="Learn more about …"`, the `place` / `corporate_fare`
 * material-icon ligatures, the `<h4>Minimum qualifications</h4>` heading) and
 * on the app's own URL scheme — never on the CSS classes, which are
 * build-generated (`QJPWVe`, `l103df`, `Xsxa1e`) and rotate with every Google
 * deploy. A class-based selector here would have a shelf life of days.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllGoogleSwitzerlandJobs() — Fetch and parse all Zurich-eligible jobs
 *   - isGoogleSwitzerlandJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()               — Validate URLs belong to this company
 *   - slugify() / stripHtml()         — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { fetchViaJinaWithRetry, detectJinaErrorBody } from './jina-proxy.mjs';
import { fetchHtml, htmlToText, decodeEntities } from './hospital-custom-html-helpers.mjs';

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
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti|apprenticeship|university grad)/.test(t)) return 'intern';
  if (/\b(junior|jr|early)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|staff|principal|advanced)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprenticeship|apprendist)/.test(t)) return 'OTHER';
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

/* ── Direct HTML extraction (primary path — see module header) ────── */

/**
 * The "Learn more" link that closes every job card. One per card, and the only
 * element on the page carrying BOTH the job's canonical URL and its title —
 * the title in `aria-label`, which exists for screen readers and is therefore
 * far more stable than the build-generated class on the `<h3>` that renders it.
 */
const LEARN_MORE_ANCHOR_RE = /<a\b[^>]*\baria-label="Learn more about [^"]*"[^>]*>/gi;

/** `?location=…` is a search-result decoration; the canonical URL has no query. */
function canonicalJobUrl(jobId, slugPart) {
  return `https://www.google.com/about/careers/applications/jobs/results/${jobId}-${slugPart}`;
}

/**
 * Boilerplate EEO/legal footer, byte-identical on every Google posting. Shared
 * by both fetch paths so the stored description stays job-specific either way.
 */
const DETAIL_FOOTER_MARKERS = [
  'Information collected and processed as part of your Google Careers profile',
  'Google is proud to be an equal opportunity',
];

/**
 * Source-declared job total, for the completeness reconciliation in
 * fetchJobListings(). The results view renders it twice, identically:
 * `<span class="…">34</span>  jobs matched` and, on the pager,
 * `Showing 1 to 20 of 34 rows`. Both are plain sentences rather than classes,
 * so we read whichever is present.
 */
export function parseGoogleDeclaredTotal(html) {
  if (!html || typeof html !== 'string') return null;
  const m = html.match(/Showing\s+\d+\s+to\s+\d+\s+of\s+(\d{1,5})\s+rows/i)
    || html.match(/>(\d{1,5})<\/span>\s*jobs matched/i);
  if (!m) return null;
  const value = Number(m[1]);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Parse one server-rendered listing page into the same entry shape
 * parseListingPage() produces from Markdown, so the assembly loop in
 * fetchAllGoogleSwitzerlandJobs() is identical for both fetch paths:
 *   `{ jobId, slugPart, canonicalUrl, title, org, location, level, minQuals }`
 *
 * Card segmentation: each card ENDS at its "Learn more" anchor and BEGINS at
 * its own `<h3>` title — so we walk the anchors and, for each, take the body
 * back to the nearest preceding `<h3>`, clamped so a card can never reach past
 * the previous card's anchor. Anchoring the start on `<h3>` (rather than on the
 * previous anchor) is what keeps the first card from swallowing the entire page
 * prologue, ~1MB of bootstrap script whose JSON payload is full of `|` and
 * would otherwise be mistaken for the card's `Org | Location` summary line.
 */
export function parseGoogleListingHtml(html) {
  if (!html || typeof html !== 'string') return [];

  const anchors = [];
  LEARN_MORE_ANCHOR_RE.lastIndex = 0;
  let m;
  while ((m = LEARN_MORE_ANCHOR_RE.exec(html)) !== null) {
    anchors.push({ tag: m[0], start: m.index });
  }

  const entries = [];
  const seen = new Set();
  for (let i = 0; i < anchors.length; i += 1) {
    const { tag, start } = anchors[i];
    // Read href/aria-label out of the tag separately, so attribute ORDER in the
    // rendered markup is not part of the contract.
    const href = (tag.match(/\bhref="([^"]*)"/i) || [])[1] || '';
    const idMatch = href.match(/jobs\/results\/(\d+)-([a-z0-9-]+)/i);
    if (!idMatch) continue;
    const [, jobId, slugPart] = idMatch;
    if (seen.has(jobId)) continue;
    seen.add(jobId);

    const title = normalizeSpace(decodeEntities((tag.match(/\baria-label="Learn more about ([^"]*)"/i) || [])[1] || ''));
    if (!title || title.length < 3) continue;

    const prevEnd = i === 0 ? 0 : anchors[i - 1].start + anchors[i - 1].tag.length;
    let cardStart = html.lastIndexOf('<h3', start);
    if (cardStart < prevEnd) cardStart = prevEnd;
    const body = html.slice(cardStart, start);

    // `<p>Org | Location; Location; …</p>` — the card's one-line summary. It is
    // the only `<p>` inside a card, and the `|` separator is what identifies it
    // without naming its class.
    const summary = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((x) => normalizeSpace(decodeEntities(stripHtml(x[1]))))
      .find((x) => x.includes('|')) || '';
    const pipe = summary.indexOf('|');
    const org = pipe >= 0 ? normalizeSpace(summary.slice(0, pipe)) : '';
    const location = pipe >= 0 ? normalizeSpace(summary.slice(pipe + 1)) : '';

    // Experience level, from the filter button's own screen-reader label
    // ("Mid, Learn more about experience filters."). Optional: apprenticeships
    // and some research roles carry no level chip at all, and
    // detectExperienceLevel() falls back to the title in that case.
    const level = normalizeSpace((body.match(/\baria-label="([^",]+),\s*Learn more about experience filters/i) || [])[1] || '');

    const qualsBlock = body.match(/<h4[^>]*>\s*Minimum qualifications\s*<\/h4>\s*<ul[^>]*>([\s\S]*?)<\/ul>/i);
    const minQuals = qualsBlock
      ? [...qualsBlock[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
        .map((x) => normalizeSpace(decodeEntities(stripHtml(x[1]))))
        .filter(Boolean)
      : [];

    entries.push({
      jobId,
      slugPart,
      canonicalUrl: canonicalJobUrl(jobId, slugPart),
      title,
      org,
      location,
      level,
      minQuals,
    });
  }
  return entries;
}

/**
 * Pull the job body out of a server-rendered detail page: everything from the
 * first content heading to the start of the legal footer.
 *
 * The four headings are Google's own visible section titles, identical across
 * every posting; the footer markers are the same ones the Markdown path trims.
 * Bounding on BOTH ends matters — the page ships ~1MB of app shell around the
 * body, so an unbounded slice would publish bootstrap script as job content.
 */
export function extractGoogleDetailDescription(html) {
  if (!html || typeof html !== 'string') return '';
  const start = html.match(/<h[234][^>]*>\s*(?:Minimum qualifications|About the job|Responsibilities)\b/i);
  if (!start) return '';
  let body = html.slice(start.index);
  for (const marker of DETAIL_FOOTER_MARKERS) {
    const idx = body.indexOf(marker);
    if (idx > 0) {
      body = body.slice(0, idx);
      break;
    }
  }
  return htmlToText(body).trim();
}

/* ── Fetch (Jina-rendered — fallback, see module header) ──────────── */

/**
 * Fetch a Google careers URL through the Jina Reader proxy via the shared
 * fetchViaJinaWithRetry() (timeout/IP-rotation-retry/circuit-breaker all live
 * there). Requests `format: 'markdown'` — Jina's default response format,
 * which is what the regex-based extraction below is written against — and
 * throws on exhausted retries (both a hard non-2xx and a 200-but-challenge
 * body per `detectJinaErrorBody()`) so callers' existing try/catch still
 * fires instead of silently publishing a WAF/error page as job content.
 */
async function fetchJinaMarkdown(targetUrl) {
  const res = await fetchViaJinaWithRetry(targetUrl, { format: 'markdown' });
  if (!res.ok) {
    throw new Error(`Jina fetch failed for ${targetUrl}: HTTP ${res.status}`);
  }
  const text = await res.text();
  const reason = detectJinaErrorBody(text);
  if (reason) {
    throw new Error(`Jina fetch for ${targetUrl} returned a non-target page (${reason})`);
  }
  return text;
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
 * Fetch one listing page and return `{ entries, declaredTotal, via }`.
 *
 * Direct HTML is tried first (see module header); the Jina Markdown path is the
 * fallback. Two things route to it, and only two: the fetch threw, or it
 * returned a page we found no cards in — which is what a re-render back into
 * client-side-only markup would look like, and it is otherwise silent.
 *
 * `allowFallbackOnEmpty` is what keeps "no cards" from meaning two different
 * things. Past the last page of results the source legitimately returns a page
 * with zero cards, and treating that as a parse failure would fire a proxy
 * request — and a misleading warning — on every single run. So an empty page
 * only justifies the fallback while we have not yet extracted anything: before
 * that, empty means "we can't read this"; after it, empty means "that's the
 * end", which is exactly the caller's stop condition.
 */
async function fetchListingPage(pageUrl, page, { allowFallbackOnEmpty = true } = {}) {
  try {
    const html = await fetchHtml(pageUrl);
    const entries = parseGoogleListingHtml(html);
    if (entries.length > 0) {
      return { entries, declaredTotal: parseGoogleDeclaredTotal(html), via: 'direct' };
    }
    if (!allowFallbackOnEmpty) {
      return { entries: [], declaredTotal: parseGoogleDeclaredTotal(html), via: 'direct' };
    }
    console.warn(`   ⚠️ Listing page ${page}: direct HTML returned 0 cards — falling back to Jina.`);
  } catch (err) {
    console.warn(`   ⚠️ Listing page ${page}: direct fetch failed (${err?.message || err}) — falling back to Jina.`);
  }

  const markdown = await fetchJinaMarkdown(pageUrl);
  return { entries: parseListingPage(markdown), declaredTotal: null, via: 'jina' };
}

/**
 * Fetch every listing page (page=1..N) until a page contributes no new job IDs
 * (last page reached) or MAX_LISTING_PAGES is reached. Dedupes by jobId across
 * pages. Returns `{ listings, declaredTotal }` — the total is the source's own
 * count, used by the caller to reject a truncated extraction.
 */
async function fetchJobListings() {
  console.log(`   Fetching: ${CAREER_URL}`);
  const seen = new Map();
  let declaredTotal = null;

  for (let page = 1; page <= MAX_LISTING_PAGES; page += 1) {
    const pageUrl = `https://www.google.com/about/careers/applications/jobs/results/?${SEARCH_LOCATION_QS}&page=${page}`;
    let result;
    try {
      result = await fetchListingPage(pageUrl, page, { allowFallbackOnEmpty: seen.size === 0 });
    } catch (err) {
      console.warn(`   ⚠️ Listing page ${page} fetch failed: ${err?.message || err}`);
      break;
    }
    const { entries } = result;
    if (declaredTotal === null && result.declaredTotal !== null) declaredTotal = result.declaredTotal;
    if (entries.length === 0) break;

    let newCount = 0;
    for (const entry of entries) {
      if (!seen.has(entry.jobId)) {
        seen.set(entry.jobId, entry);
        newCount += 1;
      }
    }
    console.log(`   📄 Page ${page} (${result.via}): ${entries.length} entries (${newCount} new, ${seen.size} total)`);

    // Don't rely on entries.length < PAGE_SIZE to detect the last page — the
    // live per-page count is not guaranteed to be exactly PAGE_SIZE (observed
    // 17 and 20 across different live runs). Keep paginating until a page
    // returns zero *new* jobs (checked above) or truly zero entries, capped
    // by MAX_LISTING_PAGES as the hard safety stop.
    if (newCount === 0) break; // no forward progress — avoid infinite loop
  }

  return { listings: [...seen.values()], declaredTotal };
}

/**
 * Fetch a job's detail page and return a cleaned description body
 * (Minimum/Preferred qualifications + About the job + Responsibilities),
 * with the boilerplate EEO/legal footer (identical across every posting)
 * trimmed off.
 *
 * Direct HTML first, Jina Markdown second — same rule as the listing: fall
 * through when the fetch throws OR when it returns a page we can't find a body
 * in. A missing body is not fatal for a single job (the caller falls back to
 * the listing's Minimum-qualifications block), so both paths failing returns ''
 * rather than throwing.
 */
async function fetchJobDescription(canonicalUrl) {
  try {
    const html = await fetchHtml(canonicalUrl);
    const body = extractGoogleDetailDescription(html);
    if (body) return body;
    console.warn(`   ⚠️ Detail ${canonicalUrl}: direct HTML had no body section — trying Jina.`);
  } catch (err) {
    console.warn(`   ⚠️ Detail direct fetch failed for ${canonicalUrl}: ${err?.message || err}`);
  }

  let markdown;
  try {
    markdown = await fetchJinaMarkdown(canonicalUrl);
  } catch (err) {
    console.warn(`   ⚠️ Detail fetch failed for ${canonicalUrl}: ${err?.message || err}`);
    return '';
  }

  const bodyStart = markdown.indexOf('Markdown Content:');
  let body = bodyStart >= 0 ? markdown.slice(bodyStart + 'Markdown Content:'.length) : markdown;

  for (const marker of DETAIL_FOOTER_MARKERS) {
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

  const { listings, declaredTotal } = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  // ── Completeness reconciliation (#5295) ──────────────────────────────────
  // The results view publishes its own total ("Showing 1 to 20 of 34 rows"),
  // so "the extractor found some cards" can be upgraded to "the extractor
  // found exactly as many cards as the source says exist". Without this, a
  // card-markup change that halves the match rate writes a half-sized slice
  // and reports success; the only thing that would notice is the downstream
  // shrink guard, hours later. Same pattern as #5200 (grace-la-margna).
  //
  // Not fail-closed on a missing total, because the Jina Markdown fallback
  // doesn't carry one — refusing there would mean the fallback could never
  // succeed, which defeats the point of having it.
  const COMPLETENESS_FLOOR = 0.9;
  if (declaredTotal === null) {
    console.warn('   ⚠️ Source-declared total not found — completeness unverified.');
  } else if (listings.length < Math.floor(declaredTotal * COMPLETENESS_FLOOR)) {
    throw new Error(
      `Google Switzerland listing extraction is incomplete: found ${listings.length} of `
      + `${declaredTotal} jobs declared by the source (floor: ${Math.round(COMPLETENESS_FLOOR * 100)}%). `
      + 'The card markup most likely changed — check parseGoogleListingHtml() against '
      + `${CAREER_URL} before trusting this run.`,
    );
  } else {
    console.log(`   ✅ Completeness: ${listings.length}/${declaredTotal} declared by source`);
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
    // Polite delay between sequential detail fetches (mirrors the 250ms
    // inter-page delay used by scripts/lib/apple-retail-switzerland-job-parser.mjs).
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
      source: 'Google Switzerland Dedicated Parser (server-rendered HTML)',
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
