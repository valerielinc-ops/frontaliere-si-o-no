#!/usr/bin/env node
/**
 * Read-only discovery pass for the 26 official canton candidates.
 *
 * Discovery never changes the registry. It produces evidence for a human
 * review; only a separately reviewed registry edit can activate a connector.
 */
import registry from '../../data/plate-auction-sources-registry.json' with { type: 'json' };
import { intFromEnv } from '../lib/int-from-env.mjs';

const DEFAULT_TIMEOUT_MS = 12_000;
const AUCTION_TERMS = /\b(auktion|eauktion|auction|asta|ench[eè]re|ecari|offert(?:e|en)?|angebot(?:e|en)?)\b/i;
const GE_LIST_TERMS = /liste\s+(?:des\s+)?num[ée]ros[^<\n]{0,100}(?:vente|ench[eè]re)|\/document\/[^\s"']*liste[^\s"']*plaques/i;
const ZG_AUCTION_TERMS = /\b(auktion|versteigerung|auction|asta|ench[eè]re)\b/i;
const ZG_SUSPENDED_TERMS = /(?:bis\s+auf\s+weiteres|auf\s+unbestimmte\s+zeit|ausgesetzt|suspend(?:ed|u|ue)|sistiert|keine\s+[^.\n]{0,80})[^.\n]{0,80}(?:auktion|versteigerung|auction|asta|ench[eè]re)|(?:auktion|versteigerung|auction|asta|ench[eè]re)[^.\n]{0,80}(?:bis\s+auf\s+weiteres|ausgesetzt|suspend(?:ed|u|ue)|sistiert)/i;
const RICARDO_HOST = /(?:^|\.)ricardo\.ch$/i;

// The registry keeps Ricardo as the human-facing auction link for JU/NE. The
// discovery pass uses these official canton pages instead, so a scheduled
// probe can look for a future feed without ever requesting Ricardo.
export const SAFE_DISCOVERY_URLS = Object.freeze({
  ju: 'https://www.jura.ch/fr/Autorites/Administration/DEC/OVJ/Vente-de-plaques-JU/Vente-aux-encheres-et-a-prix-fixe-des-plaques-d-immatriculation.html',
  ne: 'https://www.scan-ne.ch/vehicule/voitures-motos-scooters-quads/plaques/choisir-mon-numero-de-plaques/',
});

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
 * Canton-specific readiness classification layered on top of the generic
 * reachability probe. A reachable page is not enough to activate a source:
 * GE needs a current official list, while ZG must first publish that auctions
 * have resumed. JU/NE are observed through their canton pages, never through
 * their Ricardo storefronts.
 */
export function classifyCantonDiscovery({ key, status = 0, title = '', body = '' } = {}) {
  const generic = classifyDiscovery({ status, title, body });
  const text = `${title} ${body}`;

  if (key === 'ge') {
    const officialListSignal = generic.reachable && GE_LIST_TERMS.test(text);
    return {
      ...generic,
      officialListSignal,
      recommendation: !generic.reachable
        ? 'blocked-or-invalid-url'
        : officialListSignal
          ? 'ready-for-connector-check'
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
    return {
      ...generic,
      recommendation: !generic.reachable
        ? 'blocked-or-invalid-url'
        : 'official-feed-request-needed',
    };
  }

  return generic;
}

export async function discoverSources({
  sources = registry.sources,
  fetcher = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
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
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetcher(discoveryUrl, {
          redirect: 'follow',
          signal: controller.signal,
          headers: { 'user-agent': 'frontaliere-plate-auction-discovery/1.0' },
        });
      } finally {
        clearTimeout(timeout);
      }
      const body = await response.text();
      const title = titleFromHtml(body);
      entries.push({
        key,
        canton: source.canton,
        plateCode: source.plateCode,
        officialUrl: source.officialUrl,
        discoveryUrl,
        httpStatus: response.status,
        title,
        elapsedMs: Date.now() - startedAt,
        ...classifyCantonDiscovery({ key, status: response.status, title, body }),
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
  const sources = blockedOnly
    ? Object.fromEntries(Object.entries(registry.sources).filter(([, source]) => source.status !== 'active'))
    : registry.sources;
  const results = await discoverSources({
    sources,
    timeoutMs: intFromEnv('PLATE_AUCTION_DISCOVERY_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
  });
  for (const result of results.filter((entry) => ['ready-for-connector-check', 'manual-confirmation-needed'].includes(entry.recommendation))) {
    console.warn(`::warning title=Plate-auction source ready::${result.key.toUpperCase()} needs the reviewed activation gate: ${result.recommendation}`);
  }
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    sourceFilter: blockedOnly ? 'non-active' : 'all',
    results,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Plate-auction source discovery failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
