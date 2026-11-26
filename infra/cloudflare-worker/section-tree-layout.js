import { SECTION_TREE_FANOUT_SECTIONS } from './ticino-tree-bucket.js';
import {
  parseSectionTreeLayoutRegistry,
  SECTION_TREE_LAYOUT_REGISTRY_KEY,
} from './section-tree-layout-schema.js';

export { SECTION_TREE_LAYOUT_REGISTRY_KEY };
export const SECTION_TREE_LAYOUT_CACHE_TTL_MS = 5 * 60 * 1000;
const SECTION_TREE_LAYOUT_RETRY_MS = 30 * 1000;
const SECTION_TREE_LAYOUT_MAX_BYTES = 64 * 1024;

export function createSectionTreeLayoutReader({
  url,
  fetchImpl = null,
  now = () => Date.now(),
  cacheTtlMs = SECTION_TREE_LAYOUT_CACHE_TTL_MS,
  retryMs = SECTION_TREE_LAYOUT_RETRY_MS,
} = {}) {
  if (typeof url !== 'string' || !url) throw new Error('section tree layout registry URL is required');
  let lastGood = null;
  let cachedSections = null;
  let cacheUntil = 0;
  let refreshSequence = 0;
  let publishedRefreshSequence = 0;

  async function sections({ requireRegistry = false } = {}) {
    const requireKnownRegistry = (value) => {
      if (requireRegistry && !lastGood) {
        throw new Error('section tree layout registry is unavailable; refusing to infer a dynamic layout');
      }
      return value;
    };
    const currentTime = now();
    if (cachedSections && currentTime < cacheUntil) return requireKnownRegistry(cachedSections);

    // Keep the network wait inside this request context. A module-level pending
    // promise can outlive the Worker request that created it; if Cloudflare
    // cancels that request, concurrent callers can inherit a wait that never
    // produces a response (the same failure mode as the public-config route).
    const requestSequence = ++refreshSequence;
    const loaded = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await (fetchImpl ?? globalThis.fetch)(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          cache: 'no-store',
          signal: controller.signal,
        });
        if (response?.status === 404) {
          const fallback = lastGood ?? new Set(SECTION_TREE_FANOUT_SECTIONS);
          if (requestSequence === refreshSequence) {
            lastGood ??= fallback;
            cachedSections = lastGood;
            cacheUntil = now() + cacheTtlMs;
          }
          return lastGood ?? fallback;
        }
        if (!response?.ok) throw new Error(`registry fetch returned ${response?.status ?? 'no response'}`);
        const body = await response.text();
        if (body.length > SECTION_TREE_LAYOUT_MAX_BYTES) throw new Error('registry exceeds the size limit');
        const registry = parseSectionTreeLayoutRegistry(JSON.parse(body));
        const fresh = new Set([
          ...SECTION_TREE_FANOUT_SECTIONS,
          ...Object.keys(registry.sections),
        ]);
        if (requestSequence > publishedRefreshSequence) {
          publishedRefreshSequence = requestSequence;
          lastGood = fresh;
          cachedSections = lastGood;
          cacheUntil = now() + cacheTtlMs;
        }
        return lastGood ?? fresh;
      } catch {
        const fallback = lastGood ?? new Set(SECTION_TREE_FANOUT_SECTIONS);
        if (requestSequence === refreshSequence) {
          cachedSections = fallback;
          cacheUntil = now() + retryMs;
        }
        return lastGood ?? fallback;
      } finally {
        clearTimeout(timer);
      }
    })();
    return requireKnownRegistry(await loaded);
  }

  function reset() {
    lastGood = null;
    cachedSections = null;
    cacheUntil = 0;
    refreshSequence += 1;
    publishedRefreshSequence = refreshSequence;
  }

  return { sections, reset };
}
