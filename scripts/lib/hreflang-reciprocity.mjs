/**
 * Pure hreflang return-link invariant.
 *
 * A crawler can report a missing return link simply because it scanned one
 * side of a locale cluster and not the other. The build must nevertheless be
 * able to prove the invariant on the pages it has parsed: every own-host
 * alternate target that is present in the supplied page set must link back to
 * the source URL.
 */

const DEFAULT_BASE_URL = 'https://frontaliereticino.ch';

export function normalizeHreflangUrl(value, baseUrl = DEFAULT_BASE_URL) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  try {
    const url = new URL(value, baseUrl);
    url.search = '';
    url.hash = '';
    if (!url.pathname) url.pathname = '/';
    if (url.pathname !== '/' && !url.pathname.endsWith('/')) url.pathname += '/';
    return url.toString();
  } catch {
    return value.trim();
  }
}

function alternateEntries(alternates) {
  if (alternates instanceof Map) return alternates.entries();
  if (alternates && typeof alternates === 'object') return Object.entries(alternates);
  return [];
}

function isOwnHostUrl(value, baseUrl) {
  try {
    return new URL(value, baseUrl).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Memoize target-page metadata without retaining an unbounded corpus index.
 * Values may be promises so concurrent sources share the same in-flight read.
 * The resolver exposes its observed high-water mark for deterministic tests.
 */
export function createBoundedHreflangTargetResolver(resolveTargetPage, options = {}) {
  if (typeof resolveTargetPage !== 'function') {
    throw new TypeError('createBoundedHreflangTargetResolver: resolver must be a function');
  }

  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const requestedLimit = Number(options.maxEntries ?? 4096);
  const maxEntries = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? requestedLimit
    : 4096;
  const cache = new Map();
  let peakCacheSize = 0;

  function trim() {
    while (cache.size > maxEntries) {
      cache.delete(cache.keys().next().value);
    }
    peakCacheSize = Math.max(peakCacheSize, cache.size);
  }

  function remember(href, page) {
    const key = normalizeHreflangUrl(href, baseUrl);
    if (!key || cache.has(key)) return false;
    cache.set(key, Promise.resolve(page));
    trim();
    return true;
  }

  const resolve = async (href) => {
    const key = normalizeHreflangUrl(href, baseUrl);
    if (!key) return null;

    if (cache.has(key)) {
      const cached = cache.get(key);
      cache.delete(key);
      cache.set(key, cached);
      return await cached;
    }

    const pending = Promise.resolve().then(() => resolveTargetPage(href));
    cache.set(key, pending);
    trim();

    try {
      const page = await pending;
      if (cache.get(key) === pending) {
        cache.delete(key);
        cache.set(key, page);
        trim();
      }
      return page;
    } catch (error) {
      if (cache.get(key) === pending) cache.delete(key);
      throw error;
    }
  };

  return {
    resolve,
    remember,
    get cacheSize() { return cache.size; },
    get peakCacheSize() { return peakCacheSize; },
    maxEntries,
  };
}

/**
 * Check one parsed source page against its own-host targets. The caller owns
 * the bounded target resolver, so the source page and its targets can be
 * checked immediately without retaining a corpus-wide page index.
 */
export async function findHreflangReciprocityFailuresForPage(page, options = {}) {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const skipTarget = options.skipTarget ?? (() => false);
  const resolveTargetPage = options.resolveTargetPage;
  if (typeof resolveTargetPage !== 'function') {
    throw new TypeError('findHreflangReciprocityFailuresForPage: resolveTargetPage must be a function');
  }

  const source = normalizeHreflangUrl(page?.url ?? page?.href, baseUrl);
  if (!source) return [];

  const checks = [...alternateEntries(page?.alternates)].map(async ([hreflang, href]) => {
    if (hreflang === 'x-default' || !isOwnHostUrl(href, baseUrl) || skipTarget(href)) return null;

    const target = normalizeHreflangUrl(href, baseUrl);
    const targetPage = await resolveTargetPage(href);
    // Missing/unreadable/noindex targets are handled by their own invariant
    // or are intentionally outside the reciprocal-cluster check.
    if (!targetPage) return null;

    for (const [, targetHref] of alternateEntries(targetPage.alternates)) {
      if (normalizeHreflangUrl(targetHref, baseUrl) === source) return null;
    }

    return {
      source,
      target,
      hreflang,
      sourcePath: page.relPath ?? options.getPagePath?.(page) ?? source,
      targetPath: targetPage.relPath ?? options.getPagePath?.(targetPage) ?? target,
    };
  });

  return (await Promise.all(checks)).filter(Boolean);
}

/**
 * @param {Iterable<{url?: string, href?: string, relPath?: string, alternates: Map<string,string>|Record<string,string>}>} pages
 * @param {{baseUrl?: string, skipTarget?: (href: string) => boolean, pageIndex?: Map<string, object>, getPagePath?: (page: object) => string|undefined}} options
 * @returns {Array<{source: string, target: string, hreflang: string, sourcePath: string, targetPath: string}>}
 */
export function findHreflangReciprocityFailures(pages, options = {}) {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const skipTarget = options.skipTarget ?? (() => false);
  // Large dist audits can pass their already-built target Map here. Rebuilding
  // the same million-entry URL index would duplicate the dominant data shape
  // at the end of the scan, exactly when the heap is closest to its limit.
  const pageByUrl = options.pageIndex ?? new Map();
  const pageList = (options.pageIndex || Array.isArray(pages)) ? pages : [...pages];

  if (!options.pageIndex) {
    for (const page of pageList) {
      const url = normalizeHreflangUrl(page?.url ?? page?.href, baseUrl);
      if (url) pageByUrl.set(url, page);
    }
  }

  const failures = [];
  for (const page of pageList) {
    const source = normalizeHreflangUrl(page?.url ?? page?.href, baseUrl);
    if (!source) continue;

    for (const [hreflang, href] of alternateEntries(page?.alternates)) {
      if (hreflang === 'x-default' || !isOwnHostUrl(href, baseUrl) || skipTarget(href)) continue;
      const target = normalizeHreflangUrl(href, baseUrl);
      const targetPage = pageByUrl.get(target);
      // Missing targets are a separate invariant. Do not turn one missing
      // file into two failures or claim reciprocity for a page not parsed.
      if (!targetPage) continue;

      let returnsToSource = false;
      for (const [, targetHref] of alternateEntries(targetPage.alternates)) {
        if (normalizeHreflangUrl(targetHref, baseUrl) === source) {
          returnsToSource = true;
          break;
        }
      }
      if (returnsToSource) continue;

      failures.push({
        source,
        target,
        hreflang,
        sourcePath: page.relPath ?? options.getPagePath?.(page) ?? source,
        targetPath: targetPage.relPath ?? options.getPagePath?.(targetPage) ?? target,
      });
    }
  }

  return failures;
}
