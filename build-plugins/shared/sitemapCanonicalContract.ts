import { readAttr, scanMarkupStartTags } from '../../scripts/lib/html-attr.mjs';

/**
 * Read the first canonical link from the document head.
 *
 * Sitemap eligibility is a head contract. Looking at the whole document would
 * let a body link (or markup-shaped text in a script) mask a missing head
 * canonical, so use the repository's quote-balanced markup scanner and the
 * head boundary from the original source.
 */
export function canonicalHrefFromHead(html: string): string | null {
  const headEnd = html.toLowerCase().indexOf('</head');
  if (headEnd < 0) return null;

  for (const { raw, index } of scanMarkupStartTags(html, 'link')) {
    if (index >= headEnd) break;
    const rel = readAttr(raw, 'rel');
    if (!rel.split(/\s+/u).some((token) => token.toLowerCase() === 'canonical')) continue;
    const href = decodeHtmlAttribute(readAttr(raw, 'href').trim());
    return href || null;
  }
  return null;
}

/**
 * Compare a canonical URL with the sitemap URL using the same rules as the
 * final dist-truth gate: host case and trailing slash are insignificant,
 * fragments are ignored, and query strings remain significant.
 */
function normalizeUrl(value: string, baseUrl: string): string | null {
  try {
    const parsed = new URL(value, baseUrl);
    let pathname = parsed.pathname;
    if (pathname.length > 1) pathname = pathname.replace(/\/+$/u, '');
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

/** Whether an HTML document has a valid self-referencing canonical. */
export function hasSelfCanonical(html: string, expectedUrl: string): boolean {
  const canonical = canonicalHrefFromHead(html);
  if (!canonical) return false;
  const expected = normalizeUrl(expectedUrl, expectedUrl);
  const actual = normalizeUrl(canonical, expectedUrl);
  return expected !== null && actual === expected;
}

/** Fail closed when an indexable page is about to enter a sitemap. */
export function assertSelfCanonical(
  html: string,
  expectedUrl: string,
  context: string,
): void {
  if (hasSelfCanonical(html, expectedUrl)) return;
  throw new Error(
    `[sitemap-canonical-contract] ${context} has no valid self-referencing canonical for ${expectedUrl}`,
  );
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/giu, '&')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&apos;/giu, "'")
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>');
}
