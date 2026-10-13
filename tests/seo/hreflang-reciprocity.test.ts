import { describe, expect, it } from 'vitest';

import {
  findHreflangReciprocityFailures,
  normalizeHreflangUrl,
} from '../../scripts/lib/hreflang-reciprocity.mjs';

const BASE = 'https://frontaliereticino.ch';

function page(url: string, alternates: Record<string, string>) {
  return { url, relPath: new URL(url).pathname, alternates: new Map(Object.entries(alternates)) };
}

describe('hreflang reciprocal return-link invariant', () => {
  it('accepts a complete two-page locale pair', () => {
    const itUrl = `${BASE}/guida/`;
    const enUrl = `${BASE}/en/guide/`;
    expect(findHreflangReciprocityFailures([
      page(itUrl, { it: itUrl, en: enUrl, 'x-default': itUrl }),
      page(enUrl, { it: itUrl, en: enUrl, 'x-default': itUrl }),
    ])).toEqual([]);
  });

  it('reports the target when it omits the source URL', () => {
    const itUrl = `${BASE}/guida/`;
    const enUrl = `${BASE}/en/guide/`;
    const failures = findHreflangReciprocityFailures([
      page(itUrl, { it: itUrl, en: enUrl, 'x-default': itUrl }),
      page(enUrl, { en: enUrl, 'x-default': enUrl }),
    ]);
    expect(failures).toEqual([expect.objectContaining({
      source: normalizeHreflangUrl(itUrl),
      target: normalizeHreflangUrl(enUrl),
      hreflang: 'en',
    })]);
  });

  it('does not create a second failure for x-default or an unparsed target', () => {
    const itUrl = `${BASE}/guida/`;
    const enUrl = `${BASE}/en/guide/`;
    const failures = findHreflangReciprocityFailures([
      page(itUrl, { it: itUrl, en: enUrl, 'x-default': itUrl }),
    ]);
    expect(failures).toEqual([]);
  });

  it('allows a target served by another repository when the caller marks it external', () => {
    const itUrl = `${BASE}/articoli-frontaliere/guida/`;
    const externalUrl = `${BASE}/en/cross-border-articles/guide/`;
    const failures = findHreflangReciprocityFailures([
      page(itUrl, { it: itUrl, en: externalUrl, 'x-default': itUrl }),
      page(externalUrl, { en: externalUrl }),
    ], { skipTarget: (href) => href.includes('/en/cross-border-articles/') });
    expect(failures).toEqual([]);
  });
});
