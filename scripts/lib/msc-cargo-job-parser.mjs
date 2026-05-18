#!/usr/bin/env node
/**
 * MSC Group job parser — Phenom ATS direct crawler.
 *
 * Source: https://careers.msccruises.com/gb/en/search-results
 *   The MSC Cruises careers portal is a Phenom-hosted React app that
 *   server-renders an `eagerLoadRefineSearch.data.jobs[]` array into the
 *   HTML body. Pagination is `?from=N` (10 jobs/page, totalHits exposed).
 *   Plain HTTP returns 200; no anti-bot, no Playwright needed.
 *
 *   The historical direct URL `https://www.msc.com/en/careers` (MSC Cargo
 *   arm) is protected by Akamai BMP (403) and is intentionally NOT used
 *   here. The brand scope is widened to **MSC Group** so that MSC Cruises
 *   jobs surface alongside any cargo openings exposed via the cruises
 *   portal (some shoreside cargo/logistics positions live there too).
 *
 * The crawler key remains `msc-cargo` for compatibility with existing
 * workflow filename, output paths, and Firestore registry — only the
 * display COMPANY_NAME pivots to "MSC Group".
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllMscCargoJobs()  — Fetch and parse all jobs
 *   - isMscCargoJob()         — Match jobs belonging to MSC Group
 *   - isTrustedDomain()       — Validate URLs (msc.com + msccruises.com)
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton, inferAnyCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const MSC_CARGO_KEY = 'msc-cargo';
export const MSC_CARGO_COMPANY_NAME = 'MSC Group';
export const MSC_CARGO_COMPANY_DOMAIN = 'msc.com';

const PHENOM_BASE_URL = 'https://careers.msccruises.com/gb/en/search-results';
const PHENOM_DETAIL_BASE = 'https://careers.msccruises.com/gb/en/job';
const PAGE_SIZE = 10;
// Hard cap to keep CI bounded; covers the 401 listings seen on 2026-05-11.
const MAX_PAGES = 60;
const FETCH_DELAY_MS = 3000;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to MSC Group. Covers MSC Cruises, MSC Cargo,
 * MSC Mediterranean Shipping Company, MSC Technology, MSC Logistics, etc.
 */
export function isMscCargoJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === MSC_CARGO_KEY ||
    key.startsWith('msc-cargo') ||
    key.startsWith('msc-cruises') ||
    key.startsWith('msc-group') ||
    /\bmsc\b/.test(company) ||
    url.includes('msc.com') ||
    url.includes('msccruises.com')
  );
}

/**
 * Validate that a URL belongs to MSC Group's surfaces.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'msc.com' ||
      host.endsWith('.msc.com') ||
      host === 'msccruises.com' ||
      host.endsWith('.msccruises.com')
    );
  } catch {
    return false;
  }
}

/* ── Category / Experience / Employment detection ──────────── */

function detectCategory(title = '', subCategory = '') {
  const t = `${normalize(title)} ${normalize(subCategory)}`;
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account|finance|financ|tax)/.test(t)) return /\b(account|finance|financ|tax)/.test(t) ? 'Finanza' : 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce|commercial)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse|supply|procurement)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur|production)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm|data|cyber|cloud|devops|infrastructure)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal|talent|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz|communication|brand|pr)/.test(t)) return 'Marketing';
  if (/\b(legal|giurid|recht|juridique|compliance|regulatory)/.test(t)) return 'Legale';
  if (/\b(crew|onboard|hotel|hospitality|guest|entertain|chef|kitchen|housekeeping|bartender|waiter|sommelier)/.test(t)) return 'Hospitality';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|graduate|trainee)/.test(t)) return 'intern';
  if (/\b(junior|jr)\b/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|directrice|chef|verantwort|responsab|manager|principal|chief)\b/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(intern|stage|stagiair|praktik|trainee)/.test(t)) return 'INTERN';
  if (/\b(temporary|tempor|befristet|fixed.?term|cdd|contract)/.test(t)) return 'CONTRACTOR';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── HTML → text with bullet preservation ─────────────────── */

/**
 * Decode common HTML entities. The Phenom JobPosting JSON-LD ships the
 * description HTML-entity-encoded (`&lt;ul&gt;&lt;li&gt;…`) so the static
 * HTML stays well-formed JSON. We must decode before extracting `<li>`.
 */
function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x2F;/g, '/')
    .replace(/&#13;/g, '\n')
    .replace(/&#10;/g, '\n')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

/**
 * Convert HTML body → plain text while preserving `<li>` items as
 * line-start "- " bullet markers. Mirrors the strategy used in
 * `lidl-job-parser.mjs` and `postch-job-parser.mjs`: the parser-quality
 * audit's `hasStructuredContent` gate requires either real `<li>` tags or
 * line-start markdown bullets (`/^\s*[-•*]\s/m`). Collapsing list markup
 * into flat prose is the root cause of the "no structured content"
 * regression on this crawler.
 */
function htmlBodyToBulletedText(rawHtml = '') {
  if (!rawHtml) return '';
  const decoded = decodeHtmlEntities(String(rawHtml || ''));
  const withBullets = decoded
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/?(p|div|ul|ol|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return withBullets
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract the JobPosting JSON-LD block from a Phenom detail page and
 * return the bullet-preserved description text. Returns '' when the page
 * lacks JSON-LD or the description field is empty.
 */
function extractDetailDescription(html = '') {
  if (!html) return '';
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const blocks = Array.isArray(data) ? data : [data];
    for (const block of blocks) {
      const type = block?.['@type'];
      const isJobPosting = type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
      if (!isJobPosting) continue;
      const desc = block?.description || '';
      if (!desc) continue;
      return htmlBodyToBulletedText(desc);
    }
  }
  return '';
}

/* ── Phenom embedded-JSON extraction ───────────────────────── */

/**
 * Locate the `eagerLoadRefineSearch.data` object inside the HTML and return
 * its parsed JSON. The Phenom React app renders this state directly into
 * the HTML for the initial paint.
 *
 * Returns null if the data block can't be found or doesn't parse.
 *
 * @param {string} html
 * @returns {{ totalHits: number, jobs: Array<object> } | null}
 */
function extractPhenomEagerLoad(html) {
  if (!html) return null;
  const anchor = html.indexOf('"eagerLoadRefineSearch":');
  if (anchor === -1) return null;
  const dataStart = html.indexOf('"data":{', anchor);
  if (dataStart === -1) return null;

  // Walk balanced braces to find the closing `}` of the data object.
  let depth = 0;
  let inStr = false;
  let escape = false;
  let end = -1;
  for (let i = dataStart + 7; i < html.length; i++) {
    const c = html[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;
  try {
    const data = JSON.parse(html.slice(dataStart + 7, end + 1));
    // Total hits live one level up — climb back to read it.
    const totalMatch = html.slice(anchor, dataStart).match(/"totalHits":(\d+)/);
    return {
      totalHits: totalMatch ? Number(totalMatch[1]) : data?.jobs?.length || 0,
      jobs: Array.isArray(data?.jobs) ? data.jobs : [],
    };
  } catch {
    return null;
  }
}

/**
 * Build the canonical apply URL for a Phenom job from its jobSeqNo. Phenom's
 * URL pattern is `/<lang>/job/<seqNo>/<slug>` — we omit the slug; Phenom
 * server-side canonicalises it anyway.
 */
function buildApplyUrl(rawJob) {
  if (rawJob?.applyUrl && /^https?:\/\//.test(rawJob.applyUrl)) return rawJob.applyUrl;
  const seq = rawJob?.jobSeqNo || rawJob?.jobId;
  return seq ? `${PHENOM_DETAIL_BASE}/${seq}` : PHENOM_BASE_URL;
}

/**
 * Some Phenom payloads ship locations as either a flat string or a
 * comma-separated multi-location array. Pick the first Swiss-looking entry
 * if any, else the first non-empty one.
 */
function pickSwissLocation(rawJob) {
  const candidates = [
    rawJob?.location,
    ...(Array.isArray(rawJob?.multi_location_array)
      ? rawJob.multi_location_array.map((e) => e?.location || e)
      : []),
    rawJob?.cityState,
    rawJob?.cityStateCountry,
  ].filter(Boolean).map((s) => String(s));

  for (const c of candidates) {
    if (/(switzerland|suisse|svizzera|schweiz|\bch\b)/i.test(c)) return c;
  }
  return candidates[0] || '';
}

function isSwissJob(rawJob) {
  const country = normalize(rawJob?.country || '');
  if (/(switzerland|suisse|svizzera|schweiz)/.test(country)) return true;
  const multi = Array.isArray(rawJob?.multi_location_array)
    ? rawJob.multi_location_array
    : [];
  if (multi.some((m) => /(switzerland|suisse|svizzera|schweiz)/i.test(JSON.stringify(m || '')))) return true;
  return false;
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Paginate the Phenom search-results page until we've covered the reported
 * totalHits (or hit MAX_PAGES as a safety cap). Returns the union of raw
 * job records across all pages.
 *
 * @returns {Promise<object[]>}
 */
async function fetchAllRawJobs() {
  const collected = [];
  let totalHits = null;
  let page = 0;

  while (page < MAX_PAGES) {
    const url = page === 0
      ? PHENOM_BASE_URL
      : `${PHENOM_BASE_URL}?from=${page * PAGE_SIZE}`;
    let html;
    try {
      html = await fetchHtml(url, { timeoutMs: 25000 });
    } catch (err) {
      console.warn(`  Page ${page} fetch failed: ${err?.message || err}`);
      break;
    }

    const block = extractPhenomEagerLoad(html);
    if (!block || block.jobs.length === 0) {
      if (page === 0) {
        console.warn('  No Phenom eagerLoadRefineSearch block on first page');
      }
      break;
    }

    if (totalHits === null) {
      totalHits = block.totalHits;
      console.log(`   Phenom totalHits: ${totalHits}`);
    }
    collected.push(...block.jobs);
    page++;
    if (collected.length >= totalHits) break;
    await sleep(FETCH_DELAY_MS);
  }

  return collected;
}

/**
 * Fetch all MSC Group jobs and filter to Swiss locations.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllMscCargoJobs() {
  console.log(`🔍 Fetching MSC Group jobs via Phenom careers portal`);
  console.log(`   Source: ${PHENOM_BASE_URL}\n`);

  const rawJobs = await fetchAllRawJobs();
  console.log(`  📋 Raw listings across all pages: ${rawJobs.length}`);

  const swissJobs = rawJobs.filter(isSwissJob);
  console.log(`  🇨🇭 Swiss-located listings: ${swissJobs.length}`);

  if (swissJobs.length === 0) {
    console.warn('⚠️ No MSC Group Swiss listings found.');
    return [];
  }

  const jobs = [];
  for (const raw of swissJobs) {
    const title = normalizeSpace(raw?.title || '');
    if (!title || title.length < 3) continue;

    const locationText = pickSwissLocation(raw) || raw?.city || 'Geneva';
    const city = normalizeSpace(String(locationText).split(',')[0] || 'Geneva');
    const canton = inferSwissTargetCanton(locationText) || inferAnyCanton(locationText) || 'GE';

    const teaser = normalizeSpace(raw?.descriptionTeaser || '');
    const applyUrl = buildApplyUrl(raw);

    // Fetch the detail page and pull the full JobPosting description with
    // <li> bullets preserved. The listing JSON only ships a one-paragraph
    // `descriptionTeaser` (flat prose, no structure) which fails the
    // parser-quality audit's hasStructuredContent gate. Fall back to the
    // teaser when the detail fetch fails or yields nothing.
    let description = teaser;
    try {
      const detailHtml = await fetchHtml(applyUrl, { timeoutMs: 20000 });
      const detailDesc = extractDetailDescription(detailHtml);
      if (detailDesc && detailDesc.length >= 100) {
        description = detailDesc;
      }
    } catch (err) {
      console.warn(`  Detail fetch failed for ${applyUrl}: ${err?.message || err}`);
    }
    // Be polite to the Phenom origin — the listing pass already paginates
    // at FETCH_DELAY_MS; per-detail pacing protects against burst-throttle.
    await sleep(500);
    const sourceLang = detectLang(description || title, 'en');
    const jobSlug = slugify(`${title} msc ${city || 'geneva'}`);
    const urlHash = createHash('sha1').update(applyUrl).digest('hex').slice(0, 12);

    const postedDate = (() => {
      const raw0 = raw?.postedDate || raw?.dateCreated || '';
      if (!raw0) return new Date().toISOString().slice(0, 10);
      const d = new Date(raw0);
      if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
      return d.toISOString().slice(0, 10);
    })();

    const job = {
      id: `msc-cargo-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: MSC_CARGO_COMPANY_NAME,
      companyKey: MSC_CARGO_KEY,
      companyDomain: MSC_CARGO_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: description || `${title} — MSC Group`,
      descriptionByLocale: { [sourceLang]: description || `${title} — MSC Group` },
      location: city,
      canton,
      url: applyUrl,
      source: 'MSC Group Dedicated Parser (Phenom careers portal)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: city,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, raw?.subCategory || ''),
      contract: detectEmploymentType(raw?.employeeType || title) === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(raw?.employeeType || raw?.type || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Logistica e crocieristica',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl,
      jobReqId: raw?.reqId || raw?.jobId || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total MSC Group jobs discovered: ${jobs.length}`);
  return jobs;
}
