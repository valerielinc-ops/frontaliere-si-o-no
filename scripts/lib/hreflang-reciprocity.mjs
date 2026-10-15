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
