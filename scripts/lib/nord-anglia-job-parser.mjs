#!/usr/bin/env node
/**
 * La Côte International School Aubonne (Nord Anglia Education) job parser.
 *
 * ── ATS discovery ──────────────────────────────────────────────────────
 * Table row listed ATS as "n.d." (undetermined). Discovered from scratch:
 *
 * - https://www.nordangliaeducation.com/careers is the group marketing page
 *   (no ATS signature — plain marketing site).
 * - The actual application backend lives on `careers.nordangliaeducation.com`,
 *   an SAP SuccessFactors "jobs2web" (j2w) Career Site Builder tenant shared
 *   by ALL Nord Anglia schools worldwide, including several other Swiss
 *   brands: Collège du Léman (Geneva), Collège Champittet (Lausanne/Pully),
 *   Collège Beau Soleil (Villars-sur-Ollon) — confirmed via a broad
 *   `keywords=(Switzerland)` RSS query that returned 20 postings across all
 *   four schools. This parser scopes strictly to Aubonne (see below).
 * - The tenant exposes a free, unauthenticated RSS export per saved search:
 *   `https://careers.nordangliaeducation.com/services/rss/job/?locale=en_GB&keywords=(Aubonne)`
 *   — confirmed live, returns full HTML job descriptions inline (no
 *   secondary detail-page fetch needed). This is simpler and more robust
 *   than scraping the jobs2web HTML search/detail pages (used by the
 *   shared `./ats-clients/successfactors-client.mjs` 'html-jobreq' flavor
 *   for other tenants) so this parser talks to the RSS feed directly
 *   instead of routing through that shared client.
 *
 * School: La Côte International School (LCIS), Aubonne VD — a Nord Anglia
 * Education campus. Address: Chemin de Clamogne 8, 1170 Aubonne, VD
 * (confirmed via school's public listing / IB World Schools directory).
 *
 * Multi-brand-tenant scope guard: the RSS `keywords=(Aubonne)` filter is a
 * full-text search, not a strict location filter, so every parsed item is
 * additionally required to carry an explicit "(Aubonne, CH)" suffix in its
 * title AND an `/job/Aubonne-...` path segment in its link — both must
 * agree before a listing is accepted. This keeps the crawler scoped to the
 * Aubonne campus even if the shared tenant's search relevance ever drifts.
 *
 * Generic/evergreen "Share Your Profile With ..." talent-pool listings are
 * dropped (not real open roles) — same convention as other dedicated
 * parsers (see GENERIC_OFFER_PATTERNS in scripts/lib/casale-job-parser.mjs).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllNordAngliaJobs()  — Fetch and parse all jobs
 *   - isNordAngliaJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()         — Validate URLs belong to this company
 *   - slugify() / stripHtml()  — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { httpFetchWithRetry } from './transient-fetch.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const NORD_ANGLIA_KEY = 'nord-anglia';
export const NORD_ANGLIA_COMPANY_NAME = 'La Côte International School (Nord Anglia Education)';
export const NORD_ANGLIA_COMPANY_DOMAIN = 'nordangliaeducation.com';

const CAREER_URL = 'https://careers.nordangliaeducation.com/services/rss/job/?locale=en_GB&keywords=(Aubonne)';
const ATS_HOST = 'careers.nordangliaeducation.com';
const POLITE_UA = 'FrontaliereTicino-Bot/1.0 (+https://frontaliereticino.ch/bot)';
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ITEM_DROP_RATIO = 0.5;
const RSS_ITEM_STATS = Symbol('nordAngliaRssItemStats');

/** Confirmed real-world address of the Aubonne VD campus (Non-Negotiable #3 inputs). */
const HQ = {
  city: 'Aubonne',
  canton: 'VD',
  postalCode: '1170',
  streetAddress: 'Chemin de Clamogne 8',
  region: 'VD',
};

const SECTOR = 'Istruzione / Scuole internazionali';

/** Marker required in BOTH title and link before a listing is trusted as Aubonne-scoped. */
const AUBONNE_TITLE_RE = /\(Aubonne,\s*CH\)\s*$/i;
const AUBONNE_LINK_RE = /\/job\/Aubonne-/i;

/** Evergreen talent-pool / "share your profile" placeholders — not real open roles. */
const GENERIC_OFFER_PATTERNS = [
  /\bshare\s+your\s+profile\b/i,
  /\bwork\s+with\s+us\b/i,
  /\bjoin\s+(?:our\s+)?team\b/i,
  /\bspontaneous\s+application\b/i,
  /\bopen\s+application\b/i,
  /\bcandidature\s+spontan[eé]es?\b/i,
  /\bcandidatura\s+spontanea\b/i,
  /\bpostuler\s+spontan[eé]ment\b/i,
  /\binitiativbewerbung\b/i,
  /\btalent\s+pool\b/i,
];

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function toArray(val) {
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}

class NordAngliaRssItemShapeError extends Error {}

function readOptionalRssScalar(item, field, itemNumber) {
  const value = item?.[field];
  if (value == null) return '';
  if (typeof value !== 'string') {
    throw new NordAngliaRssItemShapeError(
      `Nord Anglia RSS item ${itemNumber} ${field} must be a single scalar string`,
    );
  }
  return value;
}

function readRequiredRssScalar(item, field, itemNumber) {
  const value = readOptionalRssScalar(item, field, itemNumber);
  if (!normalizeSpace(value)) {
    throw new NordAngliaRssItemShapeError(
      `Nord Anglia RSS item ${itemNumber} ${field} must be a non-empty scalar string`,
    );
  }
  return value;
}

function assertDropRatioWithinLimit(label, total, dropped) {
  if (!dropped || total <= 0 || dropped / total <= MAX_ITEM_DROP_RATIO) return;
  const percentage = Math.round((dropped / total) * 100);
  throw new Error(
    `[nord-anglia-drop-ratio] ${label}: dropped ${dropped}/${total} items (${percentage}%, max 50%)`,
  );
}

function jobUrlForDiagnostic(rawUrl = '') {
  try {
    const url = new URL(normalizeSpace(rawUrl));
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[missing or invalid URL]';
  }
}

function toIsoDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Strip the trailing "(Aubonne, CH)" location suffix jobs2web appends to RSS titles. */
function stripLocationSuffix(title = '') {
  return normalizeSpace(String(title || '').replace(/\(\s*[^()]*,\s*CH\s*\)\s*$/i, ''));
}

/** Extract the numeric jobs2web requisition ID from a public job URL. */
function extractJobReqId(url = '') {
  const m = String(url || '').match(/\/job\/[^/]+\/(\d+)\/?/);
  return m ? m[1] : '';
}

function isGenericOffer(title = '') {
  return GENERIC_OFFER_PATTERNS.some((re) => re.test(title));
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to La Côte International School Aubonne.
 * Used by the template to filter this company's jobs from the global dataset.
 *
 * IMPORTANT — collision guard: `careers.nordangliaeducation.com` is a SHARED
 * jobs2web tenant serving multiple unrelated Nord Anglia Swiss brands
 * (Collège du Léman Geneva, Collège Champittet Lausanne/Pully, Collège Beau
 * Soleil Villars-sur-Ollon). Bare host membership is NOT sufficient to claim
 * a job here — a job on that host only belongs to this crawler if it is
 * either explicitly labelled with this company's key/name, or its URL path
 * carries the Aubonne-specific `/job/Aubonne-...` segment this parser scopes
 * to. The plain marketing domain (`nordangliaeducation.com` and subdomains
 * other than the shared ATS host) is always trusted since LCIS is presently
 * the only Aubonne-branded page on it.
 */
export function isNordAngliaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const rawUrl = String(job?.url || '');

  if (
    key === NORD_ANGLIA_KEY ||
    key.startsWith('nord-anglia') ||
    company.includes('la côte international school') ||
    company.includes('la cote international school')
  ) {
    return true;
  }

  // "nord anglia" alone is ambiguous (matches every sibling school too) —
  // only trust it combined with an explicit Aubonne marker.
  const mentionsNordAnglia = company.includes('nord anglia');
  const mentionsAubonne = normalize(job?.location || '').includes('aubonne') || /aubonne/i.test(rawUrl);
  if (mentionsNordAnglia && mentionsAubonne) return true;

  let host = '';
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    host = '';
  }
  if (!host) return false;

  if (host === ATS_HOST) {
    // Shared multi-school tenant — only the Aubonne-scoped path belongs here.
    return AUBONNE_LINK_RE.test(rawUrl);
  }
  return host === 'nordangliaeducation.com' || host.endsWith('.nordangliaeducation.com');
}

/**
 * Validate that a URL belongs to Nord Anglia Education's marketing domain OR
 * the shared jobs2web ATS host (careers.nordangliaeducation.com) that
 * actually serves postings.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'nordangliaeducation.com' ||
      host.endsWith('.nordangliaeducation.com') ||
      host === ATS_HOST
    );
  } catch {
    return false;
  }
}

export function canonicalizeNordAngliaJobUrl(rawUrl = '') {
  try {
    const url = new URL(normalizeSpace(rawUrl));
    if (url.hostname.toLowerCase() !== ATS_HOST || !AUBONNE_LINK_RE.test(url.pathname)) return '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(teacher|enseignant|professeur|educat|docent)/.test(t)) return 'Istruzione';
  if (/\b(nurse|infirmi[eè]r|health)/.test(t)) return 'Sanità';
  if (/\b(chauffeur|driver|transport|coordinateur des transports)/.test(t)) return 'Logistica';
  if (/\b(concierge|maintenance|manutenzione)/.test(t)) return 'Tecnica';
  if (/\b(admission|counselor|coach)/.test(t)) return 'Amministrazione';
  if (/\b(director|manager|responsab|head of)/.test(t)) return 'Direzione';
  return 'Istruzione';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(stagiaire|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel|\b\d{1,2}%)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein|100%)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch and parse the Aubonne-scoped RSS feed. Single request, no
 * pagination — jobs2web RSS exports return every matching item at once.
 *
 * @returns {Promise<Array<{title, link, description, pubDate}>>}
 */
async function fetchJobListings() {
  console.log(`   Fetching from: ${CAREER_URL}`);

  const res = await httpFetchWithRetry(
    CAREER_URL,
    { headers: { 'User-Agent': POLITE_UA, Accept: 'application/rss+xml,application/xml,text/xml' } },
    { timeout: DEFAULT_TIMEOUT_MS, label: 'nord-anglia rss' },
  );
  if (!res.ok) {
    throw new Error(`Nord Anglia RSS feed returned HTTP ${res.status}`);
  }

  const xml = await res.text();
  return parseNordAngliaRss(xml);
}

/** Parse the Aubonne-scoped jobs2web RSS payload into scalar item fields. */
export function parseNordAngliaRss(xml = '') {
  if (typeof xml !== 'string') {
    throw new Error('Nord Anglia RSS feed XML parse failed: expected a string');
  }
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    const detail = validation?.err?.msg || validation?.err?.code || 'invalid XML';
    throw new Error(`Nord Anglia RSS feed XML parse failed: ${detail}`);
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: false,
    trimValues: false,
  });

  let parsed;
  try {
    parsed = parser.parse(xml);
  } catch (err) {
    throw new Error(`Nord Anglia RSS feed XML parse failed: ${err?.message || err}`);
  }

  const channel = parsed?.rss?.channel;
  if (channel == null || typeof channel !== 'object' || Array.isArray(channel)) {
    throw new Error('Nord Anglia RSS feed shape drift: expected an rss.channel object');
  }

  const sourceItems = toArray(channel.item);
  let malformedItems = 0;
  const validItems = sourceItems.map((item, index) => {
    const itemNumber = index + 1;
    try {
      if (item == null || typeof item !== 'object' || Array.isArray(item)) {
        throw new NordAngliaRssItemShapeError(`Nord Anglia RSS item ${itemNumber} must be an object`);
      }
      return {
        title: readRequiredRssScalar(item, 'title', itemNumber),
        link: readRequiredRssScalar(item, 'link', itemNumber),
        description: readOptionalRssScalar(item, 'description', itemNumber),
        pubDate: readOptionalRssScalar(item, 'pubDate', itemNumber),
      };
    } catch (err) {
      // Only the item-shape failures declared above are recoverable. A coding
      // regression or an unexpected parser error must still abort the feed.
      if (!(err instanceof NordAngliaRssItemShapeError)) throw err;
      malformedItems++;
      // Per-item guard: one degenerate item (non-object shape, non-scalar or
      // repeated leaf) must not zero out the whole feed. Feed-shape drift
      // (malformed XML, missing envelope) still throws above, before this map.
      console.warn(`⚠️ Nord Anglia RSS item ${itemNumber} skipped: ${err?.message || err}`);
      return null;
    }
  }).filter(Boolean);

  // Keep parseNordAngliaRss() array-compatible while carrying the aggregate
  // evidence needed by fetchAllNordAngliaJobs() to distinguish one bad item
  // from a feed-wide leaf/schema drift.
  Object.defineProperty(validItems, RSS_ITEM_STATS, {
    value: { total: sourceItems.length, dropped: malformedItems },
  });
  return validItems;
}

/**
 * Fetch all La Côte International School Aubonne (Nord Anglia Education)
 * jobs. Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllNordAngliaJobs() {
  console.log(`🔍 Fetching ${NORD_ANGLIA_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  const rssItemStats = listings?.[RSS_ITEM_STATS];
  if (rssItemStats) {
    assertDropRatioWithinLimit('malformed RSS item guard', rssItemStats.total, rssItemStats.dropped);
  }
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned (may genuinely mean zero open Aubonne roles right now).');
    return [];
  }

  console.log(`  📋 Raw RSS items found: ${listings.length}`);

  const jobs = [];
  const seen = new Set();
  let canonicalCandidates = 0;
  let canonicalUrlDrops = 0;
  for (const item of listings) {
    const rawTitle = normalizeSpace(item.title || '');
    const link = normalizeSpace(item.link || '');

    // The RSS `keywords=` param is full-text search, not a strict location
    // filter. The title identifies an Aubonne candidate; canonicalization
    // below independently requires the trusted host + Aubonne path. Keeping
    // those checks separate makes a vendor URL-template drift observable.
    if (!AUBONNE_TITLE_RE.test(rawTitle)) continue;

    const title = stripLocationSuffix(rawTitle);
    if (!title || title.length < 3) continue;
    if (isGenericOffer(title)) continue; // evergreen "share your profile" placeholder

    canonicalCandidates++;
    const publicUrl = canonicalizeNordAngliaJobUrl(link);
    if (!publicUrl) {
      canonicalUrlDrops++;
      console.warn(
        `[nord-anglia-canonical-url-drop] Skipped "${title}"; candidate URL `
        + `${jobUrlForDiagnostic(link)} is not a trusted canonical Aubonne job URL`,
      );
      continue;
    }
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    const descriptionHtml = item.description;
    const descriptionText = stripHtml(descriptionHtml);
    const description = descriptionText || `${title} presso ${NORD_ANGLIA_COMPANY_NAME} ad Aubonne.`;
    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} nord-anglia aubonne`);
    // New identity is derived from the same canonical URL that is published,
    // so tracking/session query rotation cannot mint a new job. The standard
    // crawler merge matches the stable numeric requisition ID in this URL and
    // preserves any already-indexed legacy raw-link ID and slug history.
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const jobReqId = extractJobReqId(publicUrl);
    const employmentType = detectEmploymentType(`${descriptionText} ${title}`);
    const postedDate = toIsoDate(item.pubDate) || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${NORD_ANGLIA_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: NORD_ANGLIA_COMPANY_NAME,
      companyKey: NORD_ANGLIA_KEY,
      companyDomain: NORD_ANGLIA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: HQ.city,
      canton: HQ.canton,
      url: publicUrl,
      source: 'La Côte International School Aubonne Dedicated Parser (Nord Anglia jobs2web RSS)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: HQ.city,
      addressRegion: HQ.region,
      streetAddress: HQ.streetAddress,
      postalCode: HQ.postalCode,
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
      applyUrl: publicUrl,
      jobReqId: jobReqId || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  // One malformed candidate is logged and dropped, but a vendor-wide host or
  // path change remains a hard failure so the existing slice is kept intact.
  assertDropRatioWithinLimit('canonical Aubonne URL guard', canonicalCandidates, canonicalUrlDrops);

  console.log(`\n📋 Total ${NORD_ANGLIA_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
