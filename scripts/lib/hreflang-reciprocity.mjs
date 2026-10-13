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
  if (alternates instanceof Map) return [...alternates.entries()];
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
 * @param {Array<{url: string, relPath?: string, alternates: Map<string,string>|Record<string,string>}>} pages
 * @param {{baseUrl?: string, skipTarget?: (href: string) => boolean}} options
 * @returns {Array<{source: string, target: string, hreflang: string, sourcePath: string, targetPath: string}>}
 */
export function findHreflangReciprocityFailures(pages, options = {}) {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const skipTarget = options.skipTarget ?? (() => false);
  const pageByUrl = new Map();

  for (const page of pages) {
    const url = normalizeHreflangUrl(page?.url, baseUrl);
    if (url) pageByUrl.set(url, page);
  }

  const failures = [];
  for (const page of pages) {
    const source = normalizeHreflangUrl(page?.url, baseUrl);
    if (!source) continue;

    for (const [hreflang, href] of alternateEntries(page?.alternates)) {
      if (hreflang === 'x-default' || !isOwnHostUrl(href, baseUrl) || skipTarget(href)) continue;
      const target = normalizeHreflangUrl(href, baseUrl);
      const targetPage = pageByUrl.get(target);
      // Missing targets are a separate invariant. Do not turn one missing
      // file into two failures or claim reciprocity for a page not parsed.
      if (!targetPage) continue;

      const returnsToSource = alternateEntries(targetPage.alternates)
        .some(([, targetHref]) => normalizeHreflangUrl(targetHref, baseUrl) === source);
      if (returnsToSource) continue;

      failures.push({
        source,
        target,
        hreflang,
        sourcePath: page.relPath ?? source,
        targetPath: targetPage.relPath ?? target,
      });
    }
  }

  return failures;
}
