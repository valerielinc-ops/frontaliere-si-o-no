import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  LOCALE_CONFIG,
  LOCALES,
  assertNonEmptyLegacyMap,
  legacyClusterUrls,
} from '@/scripts/build-search-cluster-301-map.mjs';

// One realistic legacy per-canton cluster URL per locale (issue #2918 item 1:
// coverage was IT-only until PR #3300 extended LOCALE_CONFIG to en/de/fr —
// these guard against a regression back to IT-only classification).
const SAMPLE_LEGACY_URL: Record<string, string> = {
  it: '/cerca-lavoro-ticino/ricerca-infermiera-lugano/',
  en: '/en/find-jobs-ticino/search-nurse-lugano/',
  de: '/de/jobs-im-tessin/suche-krankenschwester-lugano/',
  fr: '/fr/trouver-emploi-tessin/recherche-infirmiere-lugano/',
};

function withTempIndexedFile(contents: unknown, fn: (filePath: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'indexed-cluster-'));
  const file = path.join(dir, 'indexed-cluster-urls.json');
  writeFileSync(file, JSON.stringify(contents));
  try {
    fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('build-search-cluster-301-map: locale coverage (issue #2918 item 1)', () => {
  it.each(LOCALES)('legacyBodyRx matches the legacy per-canton cluster shape for locale=%s', (locale) => {
    expect(LOCALE_CONFIG[locale].legacyBodyRx.test(SAMPLE_LEGACY_URL[locale])).toBe(true);
  });

  it('a locale URL never matches a DIFFERENT locale\'s legacyBodyRx (no cross-locale bleed)', () => {
    for (const locale of LOCALES) {
      for (const otherLocale of LOCALES) {
        if (locale === otherLocale) continue;
        expect(LOCALE_CONFIG[otherLocale].legacyBodyRx.test(SAMPLE_LEGACY_URL[locale])).toBe(false);
      }
    }
  });

  it('legacyClusterUrls classifies a mixed it/en/de/fr indexedPaths array by locale (real generator shape)', () => {
    withTempIndexedFile({ indexedPaths: Object.values(SAMPLE_LEGACY_URL) }, (file) => {
      const out = legacyClusterUrls(file);
      expect(out.size).toBe(4);
      for (const [locale, url] of Object.entries(SAMPLE_LEGACY_URL)) {
        expect(out.get(url)).toBe(locale);
      }
    });
  });
});

// Shape-validation for the raw parsed JSON (bare array / { urls } / real
// { indexedPaths } shape, plus the fail-loud-instead-of-empty guard) is
// already exhaustively covered by
// tests/scripts/build-search-cluster-301-map-shape-guard.test.ts against
// `resolveLegacyUrlsArray`/`legacyClusterUrls`. This block only covers the
// SEPARATE zero-map-after-locale-matching guard (`assertNonEmptyLegacyMap`),
// which trips even on a validly-shaped, non-empty source file whose URLs
// simply don't match any locale pattern — a distinct failure mode from a bad
// top-level shape.
describe('build-search-cluster-301-map: zero-map-after-match guard (issue #2918 item 2)', () => {
  it('assertNonEmptyLegacyMap throws on an empty Map (zero-map guard)', () => {
    expect(() => assertNonEmptyLegacyMap(new Map(), 'x.json')).toThrow(/ZERO/);
  });

  it('assertNonEmptyLegacyMap is a no-op for a non-empty Map', () => {
    expect(() => assertNonEmptyLegacyMap(new Map([['/a/', 'it']]), 'x.json')).not.toThrow();
  });

  it('end-to-end: a valid-shape file whose URLs match no locale pattern trips the zero-map guard', () => {
    withTempIndexedFile({ indexedPaths: ['/totally/unrelated/path/'] }, (file) => {
      const out = legacyClusterUrls(file);
      expect(() => assertNonEmptyLegacyMap(out, file)).toThrow(/ZERO/);
    });
  });
});
