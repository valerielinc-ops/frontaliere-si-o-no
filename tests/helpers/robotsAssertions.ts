/**
 * Shared assertions for the robots meta of an emitted page.
 *
 * WHY A HELPER AND NOT A STRING MATCH.
 *
 * Tests across the repo asserted indexability by looking for the literal
 * `'index,follow'` in the emitted HTML. That is a match on the *spelling* of
 * the directive, not on the property the test cares about — and when the
 * indexable directive was normalised to carry the Discover preview qualifiers
 * (`max-image-preview:large`, issue #5001), every one of those assertions broke
 * at once while the invariant they defend — "this page is indexable" — was
 * still perfectly true.
 *
 * That is the same coupling that made `exchangeRatePagesPlugin`'s thin-content
 * demotion match `content="index,follow"` and silently stop firing. There it
 * failed silently; here it failed loudly, which was luck, not design.
 *
 * So express the property, once, here. A future change to the directive is
 * then a one-line change to `ROBOTS_INDEX_ENHANCED_CONTENT` and nothing else.
 */
import { expect } from 'vitest';

import { ROBOTS_INDEX_ENHANCED_CONTENT } from '@/build-plugins/constants';

/** Matches the emitted robots meta whatever quoting the minifier chose. */
const ROBOTS_META = /<meta\s+name=["']?robots["']?\s+content=["']?([^"'>]+)["']?\s*\/?>/i;

/** The robots directive an emitted page carries, or `null` when it has none. */
export function robotsDirectiveOf(html: string): string | null {
  return html.match(ROBOTS_META)?.[1]?.trim() ?? null;
}

/**
 * Assert a page is indexable AND eligible for a large Discover/SERP preview.
 *
 * Use this wherever a test previously asserted `toContain('index,follow')`.
 *
 * @param html emitted page HTML
 * @param label optional context for the failure message (e.g. the URL path)
 */
export function expectIndexableWithLargePreview(html: string, label = ''): void {
  const directive = robotsDirectiveOf(html);
  const where = label ? ` (${label})` : '';

  expect(directive, `no <meta name="robots"> found${where}`).not.toBeNull();
  expect(directive, `page is noindex${where}`).not.toMatch(/\bnoindex\b/i);
  // The Discover prerequisite — the whole point of normalising the directive.
  expect(directive, `robots directive lacks max-image-preview:large${where}`).toContain(
    'max-image-preview:large',
  );
  expect(directive, `robots directive is not the canonical indexable form${where}`).toBe(
    ROBOTS_INDEX_ENHANCED_CONTENT,
  );
}

/** Assert a page opts out of indexing (unchanged by the #5001 normalisation). */
export function expectNoindex(html: string, label = ''): void {
  const directive = robotsDirectiveOf(html);
  const where = label ? ` (${label})` : '';
  expect(directive, `no <meta name="robots"> found${where}`).not.toBeNull();
  expect(directive, `page is not noindex${where}`).toMatch(/\bnoindex\b/i);
}
