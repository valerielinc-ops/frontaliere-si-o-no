import { describe, expect, it } from 'vitest';

import {
  createBoundedHreflangTargetResolver,
  findHreflangReciprocityFailures,
  findHreflangReciprocityFailuresForPage,
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

  it('uses the supplied audit target index without rebuilding it', () => {
    const itUrl = `${BASE}/guida/`;
    const enUrl = `${BASE}/en/guide/`;
    const italian = page(itUrl, { en: enUrl });
    const english = { href: enUrl, file: 'dist/en/guide/index.html', alternates: new Map([['en', enUrl]]) };
    const lookups = [];
    class ObservedMap extends Map {
      get(key) {
        lookups.push(key);
        return super.get(key);
      }
    }
    const pageIndex = new ObservedMap([
      [normalizeHreflangUrl(itUrl), italian],
      [normalizeHreflangUrl(enUrl), english],
    ]);

    expect(findHreflangReciprocityFailures([italian], {
      pageIndex,
      getPagePath: (target) => target.file,
    })).toEqual([{
      source: itUrl,
      target: enUrl,
      hreflang: 'en',
      sourcePath: '/guida/',
      targetPath: 'dist/en/guide/index.html',
    }]);
    expect(lookups).toContain(normalizeHreflangUrl(enUrl));
    expect(pageIndex.get(normalizeHreflangUrl(enUrl))).toBe(english);
  });

  it('matches the full-index verdict while bounding retained target metadata', async () => {
    const sampledSources = [];
    const pages = [];
    const byUrl = new Map();
    for (let i = 0; i < 40; i += 1) {
      const itUrl = `${BASE}/guida-${i}/`;
      const enUrl = `${BASE}/en/guide-${i}/`;
      const italian = page(itUrl, { it: itUrl, en: enUrl, 'x-default': itUrl });
      const missingBacklink = i === 17;
      const english = page(enUrl, {
        it: missingBacklink ? `${BASE}/wrong/` : itUrl,
        en: enUrl,
        'x-default': missingBacklink ? `${BASE}/wrong/` : itUrl,
      });
      pages.push(italian, english);
      sampledSources.push(italian);
      byUrl.set(normalizeHreflangUrl(itUrl), italian);
      byUrl.set(normalizeHreflangUrl(enUrl), english);
    }

    let targetReads = 0;
    const resolveTarget = createBoundedHreflangTargetResolver(async (href) => {
      targetReads += 1;
      return byUrl.get(normalizeHreflangUrl(href)) ?? null;
    }, { maxEntries: 8 });
    const observed = [];
    for (const source of sampledSources) {
      resolveTarget.remember(source.url, source);
      observed.push(...await findHreflangReciprocityFailuresForPage(source, {
        resolveTargetPage: resolveTarget.resolve,
      }));
    }

    expect(observed).toEqual(findHreflangReciprocityFailures(sampledSources, { pageIndex: byUrl }));
    expect(resolveTarget.cacheSize).toBeLessThanOrEqual(8);
    expect(resolveTarget.peakCacheSize).toBe(8);
    expect(targetReads).toBeGreaterThan(8);
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
