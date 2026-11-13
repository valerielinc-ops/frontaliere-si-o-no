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
  let pending = null;

  async function sections({ requireRegistry = false } = {}) {
    const requireKnownRegistry = (value) => {
      if (requireRegistry && !lastGood) {
        throw new Error('section tree layout registry is unavailable; refusing to infer a dynamic layout');
      }
      return value;
    };
    const currentTime = now();
    if (cachedSections && currentTime < cacheUntil) return requireKnownRegistry(cachedSections);
    if (pending) return requireKnownRegistry(await pending);

    pending = (async () => {
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
          lastGood ??= new Set(SECTION_TREE_FANOUT_SECTIONS);
          cachedSections = lastGood;
          cacheUntil = now() + cacheTtlMs;
          return lastGood;
        }
        if (!response?.ok) throw new Error(`registry fetch returned ${response?.status ?? 'no response'}`);
        const body = await response.text();
        if (body.length > SECTION_TREE_LAYOUT_MAX_BYTES) throw new Error('registry exceeds the size limit');
        const registry = parseSectionTreeLayoutRegistry(JSON.parse(body));
        lastGood = new Set([
          ...SECTION_TREE_FANOUT_SECTIONS,
          ...Object.keys(registry.sections),
        ]);
        cachedSections = lastGood;
        cacheUntil = now() + cacheTtlMs;
        return lastGood;
      } catch {
        cachedSections = lastGood ?? new Set(SECTION_TREE_FANOUT_SECTIONS);
        cacheUntil = now() + retryMs;
        return cachedSections;
      } finally {
        clearTimeout(timer);
        pending = null;
      }
    })();
    return requireKnownRegistry(await pending);
  }

  function reset() {
    lastGood = null;
    cachedSections = null;
    cacheUntil = 0;
    pending = null;
  }

  return { sections, reset };
}
