#!/usr/bin/env node
/**
 * Nord Anglia Education Switzerland job parser.
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
 *   `keywords=(Switzerland)` RSS query that returned postings across the
 *   Swiss schools. This parser keeps every Swiss location returned by the
 *   tenant.
 * - The tenant exposes a free, unauthenticated RSS export per saved search:
 *   `https://careers.nordanglia.com/services/rss/job/?locale=en_GB&keywords=(Switzerland)`
 *   — confirmed live, returns full HTML job descriptions inline (no
 *   secondary detail-page fetch needed). This is simpler and more robust
 *   than scraping the jobs2web HTML search/detail pages (used by the
 *   shared `./ats-clients/successfactors-client.mjs` 'html-jobreq' flavor
 *   for other tenants) so this parser talks to the RSS feed directly
 *   instead of routing through that shared client.
 *
 * The RSS `keywords=(Switzerland)` filter is a full-text search, not a strict
 * location filter. Each item is therefore accepted only when its title or
 * canonical route resolves to a Swiss locality through the shared location
 * helper; conflicting foreign route evidence is dropped.
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
import { resolveFallbackAddress } from '../../build-plugins/shared/companyHqAddresses.ts';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { assertFeedBodyLooksLikeXml, assertFeedEndpointHost } from './feed-endpoint-guard.mjs';
import { httpFetchWithRetry } from './transient-fetch.mjs';
import { inferAnyCanton, isSwissLocationText, isTargetSwissLocation } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const NORD_ANGLIA_KEY = 'nord-anglia';
export const NORD_ANGLIA_COMPANY_NAME = 'Nord Anglia Education Switzerland';
export const NORD_ANGLIA_COMPANY_DOMAIN = 'nordangliaeducation.com';

const CAREER_URL = 'https://careers.nordanglia.com/services/rss/job/?locale=en_GB&keywords=(Switzerland)';
const ATS_HOST = 'careers.nordanglia.com';
const LEGACY_ATS_HOST = 'careers.nordangliaeducation.com';
const ATS_HOSTS = new Set([ATS_HOST, LEGACY_ATS_HOST]);
const POLITE_UA = 'FrontaliereTicino-Bot/1.0 (+https://frontaliereticino.ch/bot)';
const DEFAULT_TIMEOUT_MS = 20_000;
// Exactly 50% is deliberately tolerated: one malformed vendor item must not
// suppress the one valid job in a two-item boutique feed. More than half
// indicates feed-wide drift and aborts the refresh so the indexed slice stays.
const MAX_ITEM_DROP_RATIO = 0.5;
const RSS_ITEM_STATS = Symbol('nordAngliaRssItemStats');
const BARE_XML_AMPERSAND_RE = /<!\[CDATA\[[\s\S]*?\]\]>|&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g;

const SECTOR = 'Istruzione / Scuole internazionali';

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

/**
 * Repair the unescaped ampersands emitted by the Nord Anglia RSS endpoint.
 *
 * The feed has emitted raw `&` characters in query strings and HTML text,
 * which are not legal XML and make fast-xml-parser reject the complete feed.
 * Keep CDATA blocks opaque: raw ampersands are valid there and escaping them
 * would change the description delivered to the crawler.
 */
function repairBareXmlAmpersands(xml) {
  return xml.replace(BARE_XML_AMPERSAND_RE, (match) => (
    match.startsWith('<![CDATA[') ? match : '&amp;'
  ));
}

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

/** Strip the trailing "(City, CH)" location suffix jobs2web appends to RSS titles. */
function stripLocationSuffix(title = '') {
  return normalizeSpace(String(title || '').replace(/\(\s*[^()]*,\s*CH\s*\)\s*$/i, ''));
}

function isSwissNordAngliaLocation(value = '') {
  return isTargetSwissLocation(value, { includeGrigioni: true, includeBorderProximity: false })
    || isSwissLocationText(value);
}

function extractTitleLocation(title = '') {
  return normalizeSpace(String(title || '').match(/\(\s*([^(),]+(?:\s+[^(),]+)*)\s*,\s*CH\s*\)\s*$/i)?.[1] || '');
}

function extractJobRouteToken(rawUrl = '') {
  try {
    const url = new URL(normalizeSpace(rawUrl));
    return decodeURIComponent(url.pathname).match(/^\/job\/([^/]+)\/\d+\/?$/i)?.[1] || '';
  } catch {
    return '';
  }
}

function extractRouteLocation(rawUrl = '') {
  const routeToken = extractJobRouteToken(rawUrl);
  if (!routeToken) return '';
  const segments = routeToken.split('-').filter(Boolean);
  // jobs2web encodes a multi-word locality as the beginning of the slug
  // (`St-Moritz-...`, `Villars-sur-Ollon-...`) and may mark its boundary with
  // an underscore. Try prefixes and let the shared helper resolve the first
  // Swiss locality instead of maintaining a city list here.
  for (let length = 1; length <= segments.length; length += 1) {
    const rawCandidate = segments.slice(0, length).join(' ');
    const candidate = normalizeSpace(rawCandidate.replace(/_/g, ' '));
    if (candidate && isSwissNordAngliaLocation(candidate)) return candidate;
  }
  return '';
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
 * Check if a job belongs to Nord Anglia Education's Swiss tenant.
 * Used by the template to filter this company's jobs from the global dataset.
 *
 * The shared jobs2web tenant contains several Swiss Nord Anglia schools. The
 * tenant is therefore accepted only when the job has a Swiss location signal;
 * unrelated domains and explicitly labelled non-Nord-Anglia schools remain
 * outside this crawler.
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

  // A different explicit company identity wins over the shared ATS host.
  // The national feed itself emits the generic nord-anglia key; this guard
  // prevents an already-labelled sibling crawler record from being claimed
  // during global dataset filtering.
  if (
    key
    && !key.startsWith('nord-anglia')
    && !company.includes('nord anglia')
    && !company.includes('la côte international school')
    && !company.includes('la cote international school')
  ) return false;

  // "nord anglia" plus a Swiss location identifies the national tenant while
  // avoiding claims for foreign sibling postings.
  const mentionsNordAnglia = company.includes('nord anglia');
  const locationText = [job?.location, job?.addressLocality, job?.title, rawUrl].filter(Boolean).join(' ');
  if (mentionsNordAnglia && isSwissNordAngliaLocation(locationText)) return true;

  let host = '';
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    host = '';
  }
  if (!host) return false;

  if (ATS_HOSTS.has(host)) {
    // Shared multi-school tenant — claim only Swiss routes.
    return Boolean(extractRouteLocation(rawUrl));
  }
  return host === 'nordangliaeducation.com' || host.endsWith('.nordangliaeducation.com');
}

/**
 * Validate that a URL belongs to Nord Anglia Education's marketing domain OR
 * one of the shared jobs2web ATS hosts that serves postings.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'nordangliaeducation.com' ||
      host.endsWith('.nordangliaeducation.com') ||
      ATS_HOSTS.has(host)
    );
  } catch {
    return false;
  }
}

export function canonicalizeNordAngliaJobUrl(rawUrl = '') {
  try {
    const url = new URL(normalizeSpace(rawUrl));
    if (!ATS_HOSTS.has(url.hostname.toLowerCase()) || !/^\/job\/[^/]+\/\d+\/?$/i.test(url.pathname)) return '';
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
 * Fetch and parse the Switzerland-scoped RSS feed. Single request, no
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
  assertFeedEndpointHost('nord-anglia', ATS_HOST, res.url);
  if (!res.ok) {
    const error = new Error(`Nord Anglia RSS feed returned HTTP ${res.status}`);
    error.status = res.status;
    if (res.retryBudgetExhausted === true) error.retryBudgetExhausted = true;
    throw error;
  }

  const xml = await res.text();
  assertFeedBodyLooksLikeXml('nord-anglia', ATS_HOST, xml);
  return parseNordAngliaRss(xml);
}

/** Parse the Switzerland-scoped jobs2web RSS payload into scalar item fields. */
export function parseNordAngliaRss(xml = '') {
  if (typeof xml !== 'string') {
    throw new Error('Nord Anglia RSS feed XML parse failed: expected a string');
  }
  const parseableXml = repairBareXmlAmpersands(xml);
  const validation = XMLValidator.validate(parseableXml);
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
    parsed = parser.parse(parseableXml);
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
 * Fetch all Nord Anglia Education Switzerland jobs. Returns an array of
 * ParsedJob objects (source-locale only).
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
    console.warn('⚠️ No Swiss job listings returned (the vendor feed may currently be unavailable).');
    return [];
  }

  console.log(`  📋 Raw RSS items found: ${listings.length}`);

  const jobs = [];
  const seen = new Set();
  let nonGenericFeedItems = 0;
  let swissScopeCandidates = 0;
  let swissScopeDrops = 0;
  for (const item of listings) {
    const rawTitle = normalizeSpace(item.title || '');
    const link = normalizeSpace(item.link || '');
    const title = stripLocationSuffix(rawTitle);

    // Evergreen placeholders are intentionally outside the drop-ratio
    // denominator: they are valid vendor records, but not open positions.
    if (isGenericOffer(title)) continue;
    nonGenericFeedItems++;

    const titleLocation = extractTitleLocation(rawTitle);
    const routeToken = extractJobRouteToken(link);
    const routeLocation = extractRouteLocation(link);
    const publicUrl = canonicalizeNordAngliaJobUrl(link);
    const titleIsSwiss = Boolean(titleLocation && isSwissNordAngliaLocation(titleLocation));
    const routeIsSwiss = Boolean(routeLocation);
    // The national RSS query is full-text and may return unrelated records.
    // Only Swiss title/route signals enter the drift denominator; a foreign
    // result with no Swiss signal is ordinary vendor search noise.
    if (!titleIsSwiss && !routeIsSwiss) continue;
    swissScopeCandidates++;

    let scopeDropped = false;
    if (routeToken && !routeIsSwiss) {
      scopeDropped = true;
      console.warn(
        `[nord-anglia-location-conflict-drop] Skipped "${title || '[missing title]'}" at `
        + `${jobUrlForDiagnostic(link)} because its route does not resolve to Switzerland`,
      );
    }
    if (titleIsSwiss && routeIsSwiss) {
      const titleCanton = inferAnyCanton(titleLocation);
      const routeCanton = inferAnyCanton(routeLocation);
      if (titleCanton && routeCanton && titleCanton !== routeCanton) {
        scopeDropped = true;
        console.warn(
          `[nord-anglia-location-conflict-drop] Skipped "${title}" at `
          + `${jobUrlForDiagnostic(link)} because title and route cantons differ`,
        );
      }
    }
    if (!publicUrl) {
      scopeDropped = true;
      console.warn(
        `[nord-anglia-canonical-url-drop] Skipped "${title}"; candidate URL `
        + `${jobUrlForDiagnostic(link)} is not a trusted canonical Swiss job URL`,
      );
    }
    if (scopeDropped) {
      swissScopeDrops++;
      continue;
    }
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    const descriptionHtml = item.description;
    const descriptionText = stripHtml(descriptionHtml);
    const location = titleIsSwiss ? titleLocation : routeLocation;
    const canton = inferAnyCanton(location);
    if (!canton) {
      swissScopeDrops++;
      console.warn(
        `[nord-anglia-location-drop] Skipped "${title}"; no Swiss canton could be inferred from "${location}"`,
      );
      continue;
    }
    const fallbackAddress = resolveFallbackAddress(undefined, location, canton);
    const description = descriptionText || `${title} presso ${NORD_ANGLIA_COMPANY_NAME} a ${location}, Svizzera.`;
    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} nord-anglia ${location}`);
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
      location,
      canton,
      url: publicUrl,
      source: 'Nord Anglia Education Switzerland Dedicated Parser (jobs2web RSS)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: location,
      addressRegion: canton,
      streetAddress: fallbackAddress.streetAddress,
      postalCode: fallbackAddress.postalCode,
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

  // One malformed candidate is logged and dropped, but combined title/URL
  // drift over half of the relevant items remains a hard failure so the
  // indexed slice is kept.
  if (nonGenericFeedItems > 0 && swissScopeCandidates === 0) {
    throw new Error(
      `[nord-anglia-drop-ratio] Swiss location guard: no Swiss title or route signals found in ${nonGenericFeedItems} non-generic RSS items`,
    );
  }
  assertDropRatioWithinLimit('Swiss location guard', swissScopeCandidates, swissScopeDrops);

  console.log(`\n📋 Total ${NORD_ANGLIA_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
