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

export async function discoverSources({
  sources = registry.sources,
  fetcher = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetcher !== 'function') throw new Error('A fetch implementation is required');
  const entries = [];
  for (const [key, source] of Object.entries(sources)) {
    const startedAt = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetcher(source.officialUrl, {
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
        httpStatus: response.status,
        title,
        elapsedMs: Date.now() - startedAt,
        ...classifyDiscovery({ status: response.status, title, body }),
      });
    } catch (error) {
      entries.push({
        key,
        canton: source.canton,
        plateCode: source.plateCode,
        officialUrl: source.officialUrl,
        httpStatus: 0,
        title: '',
        elapsedMs: Date.now() - startedAt,
        errorCode: error?.name === 'AbortError' ? 'timeout' : 'fetch-failed',
        ...classifyDiscovery({ status: 0 }),
      });
    }
  }
  return entries;
}

async function main() {
  const results = await discoverSources({
    timeoutMs: intFromEnv('PLATE_AUCTION_DISCOVERY_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
  });
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Plate-auction source discovery failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
