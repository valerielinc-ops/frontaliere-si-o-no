// scripts/lib/topic-sources/googleNewsRss.mjs
//
// Pulls keyword-driven Google News RSS items for a static seed list.
// Endpoint:
//   https://news.google.com/rss/search?q=<seed>&hl=it&gl=IT&ceid=IT:it
//
// Response is XML with `<item>` elements containing `<title>`, `<link>`,
// `<pubDate>`, `<source>`. Empirical: 9 spot-on results for "frontalieri
// ticino", 6 for "permesso G". Used by the Phase A+C experimental tier
// (alongside Reddit) to feed the experimental-candidates pool.
//
// XML parsing uses the same regex pattern as `googleTrends.mjs:299-319`
// (`parseTrendsRss`) — boring tech, no new XML dep.
//
// Resilience:
//   - Each request wrapped in try/catch; module never throws.
//   - 15s per-request timeout (RSS payload heavier than Suggest).
//   - One retry on transient error.
//   - Per-seed graceful degradation.

import { fnv1a8, normalizeKeyword } from './gscOrphans.mjs';

// keep in sync with googleTrends.mjs SEEDS_FALLBACK
const SEEDS_FALLBACK = [
  'frontaliere',
  'frontalieri',
  'permesso G',
  'tasse svizzera',
  'LPP',
  'telelavoro frontalieri',
  'ristorni frontalieri',
  'AVS frontalieri',
  'LAMal',
  'CMI frontalieri',
  'IRPEF frontalieri',
  'busta paga svizzera',
  'nuovo accordo fiscale',
  'secondo pilastro',
];

const REQUEST_TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 1500;
const DEFAULT_MAX_PER_SEED = 20;

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  if (t && typeof t.unref === 'function') t.unref();
  try {
    return await fetchImpl(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/rss+xml, application/xml, text/xml',
      },
      signal: ac.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

function extractTagText(block, tagName) {
  const re = new RegExp(
    `<${tagName}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tagName}>`,
    'i',
  );
  const m = block.match(re);
  if (!m) return '';
  return (m[1] ?? m[2] ?? '').replace(/<[^>]+>/g, '').trim();
}

/**
 * Parse the Google-News-RSS XML payload. Mirrors `parseTrendsRss` shape.
 * Returns array of `{ title, link, pubDate, source }`. Items missing a
 * non-empty `<title>` are skipped. Always returns an array — never
 * throws.
 *
 * @param {string} xml
 * @returns {Array<{title: string, link: string, pubDate: string, source: string}>}
 */
export function parseNewsRss(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const items = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)];
  const out = [];
  for (const m of items) {
    const block = m[0];
    const title = extractTagText(block, 'title');
    if (!title) continue;
    const link = extractTagText(block, 'link');
    const pubDate = extractTagText(block, 'pubDate');
    const source = extractTagText(block, 'source');
    out.push({ title, link, pubDate, source });
  }
  return out;
}

async function fetchOneSeed(seed, fetchImpl) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
    seed,
  )}&hl=it&gl=IT&ceid=IT:it`;
  let lastReason = null;
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const res = await fetchWithTimeout(fetchImpl, url, REQUEST_TIMEOUT_MS);
      if (!res || typeof res.ok !== 'boolean') {
        lastReason = 'invalid response';
      } else if (!res.ok) {
        lastReason = `HTTP ${res.status}`;
      } else {
        const xml = await res.text();
        const items = parseNewsRss(xml);
        return { ok: true, items };
      }
    } catch (e) {
      lastReason = `fetch error: ${e?.message ?? String(e)}`;
    }
    if (attempt === 0) await sleep(RETRY_DELAY_MS);
  }
  return { ok: false, items: [], reason: lastReason ?? 'unknown error' };
}

/**
 * Fetch Google News RSS items for each seed. Always resolves; never
 * throws. Per-seed graceful degradation.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.seeds]
 * @param {Function} [opts.fetchImpl]
 * @param {number} [opts.maxPerSeed]
 * @returns {Promise<{
 *   ok: boolean,
 *   perSeed: Record<string, {ok: boolean, candidates: any[], reason?: string}>,
 *   candidates: any[]
 * }>}
 */
export async function fetchNewsRssCandidates(opts = {}) {
  const seeds = Array.isArray(opts.seeds) && opts.seeds.length ? opts.seeds : SEEDS_FALLBACK;
  const maxPerSeed = Number.isFinite(opts.maxPerSeed) && opts.maxPerSeed > 0
    ? opts.maxPerSeed
    : DEFAULT_MAX_PER_SEED;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    const empty = {};
    for (const seed of seeds) {
      empty[seed] = { ok: false, candidates: [], reason: 'no fetch implementation available' };
    }
    return { ok: false, perSeed: empty, candidates: [] };
  }

  const perSeed = {};
  const all = [];
  const seenNorm = new Set();

  for (const seed of seeds) {
    const { ok, items, reason } = await fetchOneSeed(seed, fetchImpl);
    const seedCandidates = [];
    if (ok && items.length) {
      const limited = items.slice(0, maxPerSeed);
      for (const it of limited) {
        const title = it.title;
        const norm = normalizeKeyword(title);
        if (!norm || seenNorm.has(norm)) continue;
        seenNorm.add(norm);
        seedCandidates.push({
          id: fnv1a8(norm),
          keyword: title,
          normalizedKeyword: norm,
          angle: null,
          locale: 'it',
          sources: ['googleNewsRss'],
          demandSignals: {
            googleNewsRssSeed: seed,
            googleNewsRssLink: it.link || null,
            googleNewsRssPubDate: it.pubDate || null,
            googleNewsRssSource: it.source || null,
          },
          rationale: `Google News RSS seed "${seed}" — ${it.source || 'unknown source'}`,
        });
      }
    }
    perSeed[seed] = ok
      ? { ok: true, candidates: seedCandidates }
      : { ok: false, candidates: [], reason };
    for (const c of seedCandidates) all.push(c);
  }

  const ok = Object.values(perSeed).some((s) => s.ok && s.candidates.length > 0);
  return { ok, perSeed, candidates: all };
}

export default fetchNewsRssCandidates;
