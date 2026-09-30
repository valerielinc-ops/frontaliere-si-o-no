#!/usr/bin/env node
/**
 * Read-only discovery pass for the 26 official canton candidates.
 *
 * Discovery never changes the registry. It produces evidence for a human
 * review; only a separately reviewed registry edit can activate a connector.
 * `readyKeys` in the output lists the sources whose evidence changed enough to
 * need that review; refresh-plate-auctions.yml turns each one into an issue.
 */
import registry from '../../data/plate-auction-sources-registry.json' with { type: 'json' };
import { intFromEnv } from '../lib/int-from-env.mjs';
import { fetchGePlateAuctions, GE_PLATE_AUCTION_SOURCE } from './connectors/ge.mjs';

const DEFAULT_TIMEOUT_MS = 12_000;
const AUCTION_TERMS = /\b(auktion|eauktion|auction|asta|ench[eè]re|ecari|offert(?:e|en)?|angebot(?:e|en)?)\b/i;
const GE_LIST_TERMS = /liste\s+(?:des\s+)?num[ée]ros[^<\n]{0,100}(?:vente|ench[eè]re)|\/document\/[^\s"']*liste[^\s"']*plaques/i;
const ZG_AUCTION_TERMS = /\b(auktion|versteigerung|auction|asta|ench[eè]re)\b/i;
const ZG_SUSPENDED_TERMS = /(?:bis\s+auf\s+weiteres|auf\s+unbestimmte\s+zeit|ausgesetzt|suspend(?:ed|u|ue)|sistiert|keine\s+[^.\n]{0,80})[^.\n]{0,80}(?:auktion|versteigerung|auction|asta|ench[eè]re)|(?:auktion|versteigerung|auction|asta|ench[eè]re)[^.\n]{0,80}(?:bis\s+auf\s+weiteres|ausgesetzt|suspend(?:ed|u|ue)|sistiert)/i;
const RICARDO_HOST = /(?:^|\.)ricardo\.ch$/i;

/** Recommendations that need a reviewed activation decision. */
export const READY_RECOMMENDATIONS = Object.freeze(['ready-for-connector-check', 'manual-confirmation-needed']);

// The registry keeps Ricardo as the human-facing auction link for JU/NE. The
// discovery pass uses these official canton pages instead, so a scheduled
// probe can look for a future feed without ever requesting Ricardo.
export const SAFE_DISCOVERY_URLS = Object.freeze({
  ju: 'https://www.jura.ch/fr/Autorites/Administration/DEC/OVJ/Vente-de-plaques-JU/Vente-aux-encheres-et-a-prix-fixe-des-plaques-d-immatriculation.html',
  ne: 'https://www.scan-ne.ch/vehicule/voitures-motos-scooters-quads/plaques/choisir-mon-numero-de-plaques/',
});

// JU/NE publish no list: their pages link only Ricardo, a captcha-protected
// plate search (guichet.jura.ch, guichetunique.ch) and, for NE, the general
// conditions PDFs (measured 2026-09-30). A new link to a data file or a feed
// on the official page is the signal worth a human look. Captcha hosts and
// Ricardo are never candidates, and neither are conditions, rules or forms.
const DATA_LINK = /\.(?:csv|json|xml|xlsx?|ods|pdf|ics|rss|atom)(?:$|[?#])|\/(?:rss|feed|api|opendata)(?:\/|$|[?#])|[?&]format=(?:json|xml|csv)\b/i;
const NON_FEED_DOCUMENT = /conditions?[\s_-]*g[eé]n[eé]rales|r[eè]glement|formulaire|tarifs?\b|[eé]moluments?/i;
const CAPTCHA_HOST = /(?:^|\.)(?:guichet\.jura\.ch|guichetunique\.ch)$/i;
// Links a reviewer has already checked and found not to be a plate list,
// keyed by source; `host/path`, lower case. Adding one here closes a false alarm.
export const REVIEWED_NON_FEED_LINKS = Object.freeze({ ju: Object.freeze([]), ne: Object.freeze([]) });

// ge.ch has no feed (/rss and /jsonapi answer 404, measured 2026-09-30): a new
// OCV list is a Drupal document that may not be linked from the auction page
// before its session, so its slug is looked up in the sitemap index (15 pages,
// ~9.5 MB), which the workflow reads once a day.
const GE_SITEMAP_INDEX_URL = 'https://www.ge.ch/sitemap.xml';
const GE_SITEMAP_MAX_PAGES = 40;
const GE_LIST_DOCUMENT_SLUG = /\/document\/[^/?#]*(?:liste[^/?#]*plaques|plaques[^/?#]*ench[eè]res|ench[eè]res[^/?#]*plaques)/i;
const GE_NON_LIST_SLUG = /r[eè]glement|conditions|formulaire/i;

function titleFromHtml(html) {
  return String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() || '';
}

export function classifyDiscovery({ status = 0, title = '', body = '' } = {}) {
  const reachable = Number.isFinite(status) && status >= 200 && status < 400;
  const auctionSignal = reachable && AUCTION_TERMS.test(`${title} ${body}`);
  return {
    reachable,
    auctionSignal,
    recommendation: !reachable
      ? 'blocked-or-invalid-url'
      : auctionSignal
        ? 'manual-confirmation-needed'
        : 'candidate-office-page-only',
  };
}

/**
 * Resolve a safe official discovery URL. Ricardo pages remain human links in
 * the registry, never machine inputs: even a read-only discovery pass must
 * not trigger a Cloudflare challenge or process offer data.
 */
export function resolveDiscoveryUrl(source = {}) {
  const key = String(source.plateCode || '').toLowerCase();
  const candidate = source.discoveryUrl || SAFE_DISCOVERY_URLS[key] || source.officialUrl;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || RICARDO_HOST.test(url.hostname)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * Links on an official page that could carry a machine-readable plate list:
 * data files and feeds, minus Ricardo, captcha hosts, conditions/rules/forms
 * and the links already reviewed for `key`.
 */
export function extractOfficialDataLinks(html, { baseUrl, key } = {}) {
  const reviewed = REVIEWED_NON_FEED_LINKS[key] || [];
  const links = [];
  for (const match of String(html || '').matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url;
    try {
      url = new URL(match[1].replace(/&amp;/gi, '&'), baseUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol) || RICARDO_HOST.test(url.hostname) || CAPTCHA_HOST.test(url.hostname)) continue;
    if (!DATA_LINK.test(`${url.pathname}${url.search}`)) continue;
    const text = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    let path = url.pathname;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      // Keep the raw path when it is not valid percent-encoding.
    }
    if (NON_FEED_DOCUMENT.test(`${path} ${text}`)) continue;
    if (reviewed.includes(`${url.hostname}${url.pathname}`.toLowerCase())) continue;
    if (!links.some((link) => link.url === url.toString())) links.push({ url: url.toString(), text: text.slice(0, 120) });
  }
  return links;
}

/** `<sitemap><loc>` entries of a sitemap index, limited to www.ge.ch. */
export function extractSitemapPageUrls(xml) {
  const urls = [];
  for (const match of String(xml || '').matchAll(/<sitemap>\s*<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    try {
      const url = new URL(match[1].replace(/&amp;/gi, '&'));
      if (url.hostname === 'www.ge.ch' && !urls.includes(url.toString())) urls.push(url.toString());
    } catch {
      // Not a URL: skip.
    }
  }
  return urls;
}

/** ge.ch document URLs whose slug names a plate-auction list (not the rules or forms). */
export function extractGeListDocumentUrlsFromSitemap(xml) {
  const urls = [];
  for (const match of String(xml || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    let url;
    try {
      url = new URL(match[1].replace(/&amp;/gi, '&'));
    } catch {
      continue;
    }
    if (url.hostname !== 'www.ge.ch') continue;
    if (!GE_LIST_DOCUMENT_SLUG.test(url.pathname) || GE_NON_LIST_SLUG.test(url.pathname)) continue;
    if (!urls.includes(url.toString())) urls.push(url.toString());
  }
  return urls;
}

async function fetchText(fetcher, url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'frontaliere-plate-auction-discovery/1.0' },
    });
    return { status: response.status, body: await response.text() };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * List documents in the ge.ch sitemap that the GE connector does not already
 * know. An index without `<sitemap>` pages is read as a plain urlset.
 */
export async function discoverGeSitemapListDocuments({
  fetcher = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  indexUrl = GE_SITEMAP_INDEX_URL,
} = {}) {
  const index = await fetchText(fetcher, indexUrl, timeoutMs);
  if (index.status < 200 || index.status >= 400) throw new Error(`HTTP ${index.status} from ${indexUrl}`);
  const pages = extractSitemapPageUrls(index.body).slice(0, GE_SITEMAP_MAX_PAGES);
  const found = new Set(extractGeListDocumentUrlsFromSitemap(index.body));
  for (const pageUrl of pages) {
    const page = await fetchText(fetcher, pageUrl, timeoutMs);
    if (page.status < 200 || page.status >= 400) throw new Error(`HTTP ${page.status} from ${pageUrl}`);
    for (const url of extractGeListDocumentUrlsFromSitemap(page.body)) found.add(url);
  }
  return [...found].filter((url) => !GE_PLATE_AUCTION_SOURCE.listDocumentUrls.includes(url));
}

/**
 * Validate the GE list with the connector itself: the source is ready only
 * when the newest official OCV list parses into plate rows for a session that
 * has not ended. A page that merely links a list, or an old list, is not.
 */
export async function probeGeOfficialList({ now = new Date(), injectedFetcher, extraListDocumentUrls = [] } = {}) {
  try {
    const rows = await fetchGePlateAuctions({ now, injectedFetcher, extraListDocumentUrls });
    const open = rows.filter((row) => Date.parse(row.endsAt) > now.getTime());
    return {
      connectorRows: open.length,
      ...(open[0] ? {
        sessionStartsAt: open[0].startsAt,
        sessionEndsAt: open[0].endsAt,
        listPdfUrl: open[0].officialDetailUrl,
      } : {}),
      unknownListDocuments: extraListDocumentUrls,
    };
  } catch (error) {
    return {
      connectorRows: 0,
      connectorError: error instanceof Error ? error.message : String(error),
      unknownListDocuments: extraListDocumentUrls,
    };
  }
}

/**
 * Canton-specific readiness classification layered on top of the generic
 * reachability probe. A reachable page is not enough to activate a source:
 * GE needs a current official list, while ZG must first publish that auctions
 * have resumed. JU/NE are observed through their canton pages, never through
 * their Ricardo storefronts.
 *
 * `geList` is the result of probeGeOfficialList. Without it the auction page
 * alone can only ask for a manual look, never declare GE ready.
 */
export function classifyCantonDiscovery({ key, status = 0, title = '', body = '', baseUrl, geList } = {}) {
  const generic = classifyDiscovery({ status, title, body });
  const text = `${title} ${body}`;

  if (key === 'ge') {
    const officialListSignal = generic.reachable && GE_LIST_TERMS.test(text);
    const connectorRows = geList?.connectorRows ?? 0;
    const unknownListDocuments = geList?.unknownListDocuments ?? [];
    // A list the page or the sitemap points at, but that the connector could
    // not read, may be a new layout: worth a look, not an activation.
    const unreadList = Boolean(geList?.connectorError) && (officialListSignal || unknownListDocuments.length > 0);
    return {
      ...generic,
      officialListSignal,
      ...(geList ? { geList } : {}),
      recommendation: !generic.reachable
        ? 'blocked-or-invalid-url'
        : connectorRows > 0
          ? 'ready-for-connector-check'
          : unreadList || (!geList && officialListSignal)
            ? 'manual-confirmation-needed'
            : 'blocked-until-official-list',
    };
  }

  if (key === 'zg') {
    const suspended = generic.reachable && ZG_SUSPENDED_TERMS.test(text);
    const auctionSignal = generic.reachable && !suspended && ZG_AUCTION_TERMS.test(text);
    return {
      ...generic,
      suspended,
      auctionSignal,
      recommendation: !generic.reachable
        ? 'blocked-or-invalid-url'
        : suspended
          ? 'no-public-auction'
          : auctionSignal
            ? 'manual-confirmation-needed'
            : 'candidate-office-page-only',
    };
  }

  if (key === 'ju' || key === 'ne') {
    const dataLinks = generic.reachable
      ? extractOfficialDataLinks(body, { baseUrl: baseUrl || SAFE_DISCOVERY_URLS[key], key })
      : [];
    return {
      ...generic,
      dataLinks,
      recommendation: !generic.reachable
        ? 'blocked-or-invalid-url'
        : dataLinks.length > 0
          ? 'manual-confirmation-needed'
          : 'official-feed-request-needed',
    };
  }

  return generic;
}

export async function discoverSources({
  sources = registry.sources,
  fetcher = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = new Date(),
  geSitemap = false,
  geListProbe = probeGeOfficialList,
} = {}) {
  if (typeof fetcher !== 'function') throw new Error('A fetch implementation is required');
  const entries = [];
  for (const [key, source] of Object.entries(sources)) {
    const startedAt = Date.now();
    const discoveryUrl = resolveDiscoveryUrl(source);
    if (!discoveryUrl) {
      entries.push({
        key,
        canton: source.canton,
        plateCode: source.plateCode,
        officialUrl: source.officialUrl,
        discoveryUrl: null,
        httpStatus: 0,
        title: '',
        elapsedMs: Date.now() - startedAt,
        errorCode: 'unsafe-or-missing-discovery-url',
        ...classifyCantonDiscovery({ key, status: 0 }),
      });
      continue;
    }
    try {
      const response = await fetchText(fetcher, discoveryUrl, timeoutMs);
      const title = titleFromHtml(response.body);
      let geList;
      if (key === 'ge' && response.status >= 200 && response.status < 400) {
        let extraListDocumentUrls = [];
        let sitemapError;
        if (geSitemap) {
          try {
            extraListDocumentUrls = await discoverGeSitemapListDocuments({ fetcher, timeoutMs });
          } catch (error) {
            sitemapError = error instanceof Error ? error.message : String(error);
          }
        }
        geList = await geListProbe({ now, extraListDocumentUrls });
        if (sitemapError) geList = { ...geList, sitemapError };
      }
      entries.push({
        key,
        canton: source.canton,
        plateCode: source.plateCode,
        officialUrl: source.officialUrl,
        discoveryUrl,
        httpStatus: response.status,
        title,
        elapsedMs: Date.now() - startedAt,
        ...classifyCantonDiscovery({ key, status: response.status, title, body: response.body, baseUrl: discoveryUrl, geList }),
      });
    } catch (error) {
      entries.push({
        key,
        canton: source.canton,
        plateCode: source.plateCode,
        officialUrl: source.officialUrl,
        discoveryUrl,
        httpStatus: 0,
        title: '',
        elapsedMs: Date.now() - startedAt,
        errorCode: error?.name === 'AbortError' ? 'timeout' : 'fetch-failed',
        ...classifyCantonDiscovery({ key, status: 0 }),
      });
    }
  }
  return entries;
}

async function main() {
  const blockedOnly = process.argv.includes('--blocked-only');
  const geSitemap = process.argv.includes('--ge-sitemap');
  const sources = blockedOnly
    ? Object.fromEntries(Object.entries(registry.sources).filter(([, source]) => source.status !== 'active'))
    : registry.sources;
  const results = await discoverSources({
    sources,
    timeoutMs: intFromEnv('PLATE_AUCTION_DISCOVERY_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
    geSitemap,
  });
  const ready = results.filter((entry) => READY_RECOMMENDATIONS.includes(entry.recommendation));
  for (const result of ready) {
    console.warn(`::warning title=Plate-auction source ready::${result.key.toUpperCase()} needs the reviewed activation gate: ${result.recommendation}`);
  }
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    sourceFilter: blockedOnly ? 'non-active' : 'all',
    geSitemap,
    readyKeys: ready.map((entry) => entry.key),
    results,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Plate-auction source discovery failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
