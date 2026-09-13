/**
 * Shared, dependency-free primitives for the SEO health loop.
 *
 * This module deliberately contains no network or filesystem access.  The
 * scheduled runner owns those side effects; these functions define the
 * invariants that the runner and its tests must agree on:
 *
 *   - sitemap URLs are compared without silently changing their slash shape;
 *   - page samples are deterministic, so a green run is reproducible;
 *   - a source that could not be read is never represented as a healthy empty
 *     source;
 *   - a finding becomes actionable only after consecutive observed runs.
 *
 * Keeping the contract here avoids a second, slightly different parser in a
 * workflow shell step.  It also makes the live loop testable with fixtures.
 */

import { JOB_BOARD_SECTION_RX } from './jobBoardSections.mjs';

export const SEO_HEALTH_SCHEMA_VERSION = 1;
export const SITE_ORIGIN = 'https://frontaliereticino.ch';
export const SITE_HOST = 'frontaliereticino.ch';

const ASSET_EXT_RE = /\.[a-z0-9]{1,8}$/i;
const HTML_PAGE_EXTENSIONS = new Set(['.html']);

function decodeXmlEntities(value) {
  return String(value ?? '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'");
}

/**
 * Convert a relative/absolute URL to a safe absolute HTTP(S) URL.
 * Invalid values return null rather than being allowed into a fetch queue.
 */
export function absoluteHttpUrl(value, base = SITE_ORIGIN) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw, base);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Canonical comparison key.  The path's trailing slash is intentionally
 * preserved: slash shape is an SEO contract, not cosmetic punctuation.
 */
export function comparableUrl(value, base = SITE_ORIGIN) {
  const absolute = absoluteHttpUrl(value, base);
  if (!absolute) return null;
  const parsed = new URL(absolute);
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();
  if ((parsed.protocol === 'https:' && parsed.port === '443') ||
      (parsed.protocol === 'http:' && parsed.port === '80')) {
    parsed.port = '';
  }
  if (!parsed.pathname) parsed.pathname = '/';
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
}

export function isSameUrl(left, right, base = SITE_ORIGIN) {
  const a = comparableUrl(left, base);
  const b = comparableUrl(right, base);
  return Boolean(a && b && a === b);
}

export function urlPath(value, base = SITE_ORIGIN) {
  const absolute = absoluteHttpUrl(value, base);
  if (!absolute) return null;
  return new URL(absolute).pathname || '/';
}

export function isAssetUrl(value, base = SITE_ORIGIN) {
  const pathname = urlPath(value, base);
  if (!pathname || pathname === '/') return false;
  const segment = pathname.split('/').pop() || '';
  return ASSET_EXT_RE.test(segment) && !HTML_PAGE_EXTENSIONS.has(
    segment.slice(segment.lastIndexOf('.')).toLowerCase(),
  );
}

/** Extract `<loc>` values from a sitemap index. */
export function parseSitemapIndex(xml, base = SITE_ORIGIN) {
  const output = [];
  const blockRe = /<sitemap\b[\s\S]*?<\/sitemap>/gi;
  let block;
  while ((block = blockRe.exec(String(xml ?? ''))) !== null) {
    const match = block[0].match(/<loc\b[^>]*>\s*([^<]+?)\s*<\/loc>/i);
    const loc = match ? absoluteHttpUrl(decodeXmlEntities(match[1]), base) : null;
    if (loc) output.push(loc);
  }
  return [...new Set(output)];
}

/** Extract URL entries from a normal sitemap or news sitemap. */
export function parseSitemapUrlSet(xml, base = SITE_ORIGIN) {
  const output = [];
  const blockRe = /<url\b[\s\S]*?<\/url>/gi;
  let block;
  while ((block = blockRe.exec(String(xml ?? ''))) !== null) {
    const locMatch = block[0].match(/<loc\b[^>]*>\s*([^<]+?)\s*<\/loc>/i);
    const loc = locMatch ? absoluteHttpUrl(decodeXmlEntities(locMatch[1]), base) : null;
    if (!loc) continue;
    const lastmodMatch = block[0].match(/<lastmod\b[^>]*>\s*([^<]+?)\s*<\/lastmod>/i);
    output.push({
      url: loc,
      lastmod: lastmodMatch ? decodeXmlEntities(lastmodMatch[1].trim()) : null,
    });
  }
  return output;
}

/**
 * Stable FNV-1a hash used only to choose a repeatable live sample.
 * It is not a security primitive.
 */
export function stableHash(value) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(String(value))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Pick a stable sample.  Sorting the selected result makes report diffs
 * deterministic even if fetches complete in a different order.
 */
export function deterministicSample(values, limit, salt = 'seo-health-v1') {
  const unique = [...new Set((values || []).filter(Boolean).map(String))];
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return [];
  return unique
    .sort((a, b) => {
      const delta = stableHash(`${salt}:${a}`) - stableHash(`${salt}:${b}`);
      return delta || a.localeCompare(b);
    })
    .slice(0, Math.floor(n))
    .sort();
}

function tagAttribute(tag, name) {
  const quoted = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
  if (quoted) return quoted[1].trim();
  const unquoted = tag.match(new RegExp(`${name}\\s*=\\s*([^\\s>]+)`, 'i'));
  return unquoted ? unquoted[1].trim() : null;
}

function extractCanonical(html, pageUrl) {
  const tags = String(html ?? '').match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const rel = tagAttribute(tag, 'rel');
    if (!rel || !rel.split(/\s+/).some((token) => token.toLowerCase() === 'canonical')) continue;
    const href = tagAttribute(tag, 'href');
    return href ? absoluteHttpUrl(href, pageUrl) : null;
  }
  return null;
}

function extractRobots(html) {
  const tags = String(html ?? '').match(/<meta\b[^>]*>/gi) || [];
  const directives = [];
  for (const tag of tags) {
    const name = tagAttribute(tag, 'name');
    if (!name || !['robots', 'googlebot', 'googlebot-news'].includes(name.toLowerCase())) continue;
    const content = tagAttribute(tag, 'content');
    if (content) directives.push(content);
  }
  const value = directives.join(', ');
  return { value: value || null, noindex: /\bnoindex\b/i.test(value) };
}

function jsonLdHasType(value, wanted) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => jsonLdHasType(item, wanted));
  const type = value['@type'];
  if (Array.isArray(type) && type.some((item) => String(item).toLowerCase() === wanted.toLowerCase())) return true;
  if (typeof type === 'string' && type.split(/\s+/).some((item) => item.toLowerCase() === wanted.toLowerCase())) return true;
  return Object.values(value).some((item) => jsonLdHasType(item, wanted));
}

function jsonLdTypes(value, out = new Set()) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((item) => jsonLdTypes(item, out));
    return out;
  }
  const type = value['@type'];
  if (Array.isArray(type)) type.forEach((item) => out.add(String(item)));
  else if (type) out.add(String(type));
  Object.values(value).forEach((item) => jsonLdTypes(item, out));
  return out;
}

/** Extract the SEO signals that can be asserted on a sampled HTML response. */
export function extractPageSignals(html, pageUrl) {
  const source = String(html ?? '');
  const jsonLdTypesSeen = new Set();
  let hasJobPosting = false;
  const scripts = source.match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const script of scripts) {
    const body = script.replace(/^<[\s\S]*?>/, '').replace(/<\/script>\s*$/i, '').trim();
    try {
      const parsed = JSON.parse(body);
      hasJobPosting ||= jsonLdHasType(parsed, 'JobPosting');
      jsonLdTypes(parsed, jsonLdTypesSeen);
    } catch {
      // A malformed JSON-LD block is not a false green: it is counted as
      // missing the required type below, while the runner records the count.
    }
  }
  const robots = extractRobots(source);
  return {
    canonical: extractCanonical(source, pageUrl),
    robots: robots.value,
    noindex: robots.noindex,
    jsonLdCount: scripts.length,
    jsonLdTypes: [...jsonLdTypesSeen].sort(),
    hasJobPosting,
    hasTitle: /<title\b[^>]*>\s*[^<\s][\s\S]*?<\/title>/i.test(source),
  };
}

const JOB_DETAIL_EXCLUDED_SLUG_RX = /^(?:azienda|company|unternehmen|entreprise|ricerca|search|suche|recherche|categoria|category|kategorie|categorie|pagina|page|seite)-/i;
const JOB_DETAIL_FILTER_SLUG_RX = /^(?:lavoro|jobs?|stellen|emploi|offerte)-(?:part-time|full-time|tempo-pieno|teilzeit|vollzeit|temps-partiel|temps-plein)/i;
const JOB_DETAIL_EDITORIAL_SLUGS = new Set([
  'offerte-di-lavoro-ticino-oggi', 'ticino-jobs-today', 'jobs-tessin-heute', 'offres-emploi-tessin-aujourdhui',
  'foglio-ufficiale-offerte-di-lavoro-ticino', 'official-gazette-ticino-jobs', 'amtsblatt-stellen-tessin', 'feuille-officielle-emplois-tessin',
  'infermieri-in-ticino', 'nurses-in-ticino', 'pflege-jobs-im-tessin', 'infirmiers-au-tessin',
  'cliniche-ticino', 'clinics-ticino-jobs', 'kliniken-tessin-jobs', 'cliniques-ticino',
  'case-anziani-ticino', 'care-homes-ticino-jobs', 'altersheime-tessin-jobs', 'maisons-retraite-ticino',
  'oss-ticino', 'healthcare-assistants-ticino', 'pflegeassistenz-tessin', 'oss-tessin',
  'educatori-ticino', 'educators-ticino', 'paedagogen-tessin', 'educateurs-ticino',
]);

/** Job detail routes, excluding section, filter, company and editorial hubs. */
export function isJobDetailPath(value, base = SITE_ORIGIN) {
  const pathname = urlPath(value, base);
  if (!pathname) return false;
  if (!JOB_BOARD_SECTION_RX.test(pathname)) return false;
  const parts = pathname.split('/').filter(Boolean);
  const sectionIndex = ['en', 'de', 'fr'].includes(parts[0]?.toLowerCase()) ? 1 : 0;
  if (parts.length !== sectionIndex + 2) return false;
  const slug = parts[sectionIndex + 1].replace(/\.html$/i, '').toLowerCase();
  return Boolean(slug)
    && !JOB_DETAIL_EXCLUDED_SLUG_RX.test(slug)
    && !JOB_DETAIL_FILTER_SLUG_RX.test(slug)
    && !JOB_DETAIL_EDITORIAL_SLUGS.has(slug);
}

/**
 * Build the deterministic findings for one probe.  A redirect in a sitemap,
 * a missing/mismatched canonical, a sitemap noindex, and a missing JobPosting
 * are distinct findings because they have different owners and fixes.
 */
export function findingsForProbe({
  url,
  status,
  location = null,
  finalUrl = null,
  body = '',
  error = null,
} = {}) {
  const pageUrl = absoluteHttpUrl(url);
  const path = urlPath(pageUrl);
  const findings = [];
  const add = (code, detail = {}) => findings.push({ code, url: pageUrl || String(url || ''), path, ...detail });

  if (!pageUrl) {
    add('invalid-sitemap-url');
    return findings;
  }
  if (error) {
    add('network-error', { message: String(error) });
    return findings;
  }
  const numericStatus = Number(status) || 0;
  if (numericStatus >= 500 || numericStatus === 0) {
    add('http-server-error', { status: numericStatus });
    return findings;
  }
  if (numericStatus >= 400) {
    add('http-client-error', { status: numericStatus });
    return findings;
  }
  if (numericStatus >= 300 && numericStatus < 400) {
    add('sitemap-redirect', { status: numericStatus, location });
    return findings;
  }

  const effectiveFinal = finalUrl ? comparableUrl(finalUrl) : comparableUrl(pageUrl);
  if (effectiveFinal && !isSameUrl(pageUrl, effectiveFinal)) {
    add('sitemap-followed-redirect', { finalUrl: effectiveFinal });
  }
  if (isAssetUrl(pageUrl)) return findings;

  const signals = extractPageSignals(body, pageUrl);
  if (!signals.canonical) add('canonical-missing');
  else if (!isSameUrl(signals.canonical, pageUrl)) {
    add('canonical-mismatch', { canonical: signals.canonical });
  }
  if (signals.noindex) add('sitemap-noindex', { robots: signals.robots });
  if (isJobDetailPath(pageUrl) && !signals.hasJobPosting) {
    add('jobposting-missing', { jsonLdTypes: signals.jsonLdTypes });
  }
  return findings;
}

/** A source is healthy only when it returned a non-empty, trustworthy sample. */
export function sourceResult({ name, startedAt, finishedAt, rows = 0, error = null, skipped = false } = {}) {
  const count = Number(rows) || 0;
  const available = !skipped && !error && count > 0;
  return {
    name: String(name || 'unknown'),
    available,
    rows: count,
    startedAt: startedAt || null,
    finishedAt: finishedAt || null,
    error: error ? String(error) : skipped ? 'skipped' : available ? null : 'empty result',
  };
}

/**
 * Advance the persisted consecutive-run counters.  A missing finding is
 * removed from the active map, so recovery is explicit and inspectable.
 */
export function advanceFindingStreaks(previous = {}, activeFindings = [], now = new Date(), maxGapHours = 72) {
  const nowIso = new Date(now).toISOString();
  const nowMs = Date.parse(nowIso);
  const previousLastRun = Date.parse(previous.lastRunAt || '');
  const gapTooLarge = Number.isFinite(previousLastRun) && (nowMs - previousLastRun) > maxGapHours * 3_600_000;
  const prior = previous.findings && typeof previous.findings === 'object' ? previous.findings : {};
  const next = {};
  for (const finding of activeFindings || []) {
    const key = finding.key || `${finding.code}|${finding.url}`;
    const old = prior[key];
    const consecutiveRuns = old && !gapTooLarge ? Number(old.consecutiveRuns || 0) + 1 : 1;
    next[key] = {
      code: finding.code,
      url: finding.url,
      consecutiveRuns,
      firstSeenAt: old && !gapTooLarge ? old.firstSeenAt || nowIso : nowIso,
      lastSeenAt: nowIso,
      detail: finding.detail || null,
    };
  }
  return { schemaVersion: SEO_HEALTH_SCHEMA_VERSION, lastRunAt: nowIso, findings: next };
}

export function actionableStreaks(state, threshold = 2) {
  return Object.values(state?.findings || {})
    .filter((finding) => Number(finding.consecutiveRuns) >= Number(threshold))
    .sort((a, b) => `${a.code}|${a.url}`.localeCompare(`${b.code}|${b.url}`));
}
