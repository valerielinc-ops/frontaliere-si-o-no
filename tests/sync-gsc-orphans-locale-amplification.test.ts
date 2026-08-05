/**
 * Issue #4248 — "Workflow Failure: Sync GSC Orphan Job Slugs".
 *
 * Every run of sync-gsc-orphans.yml since 2026-07-17 died on
 * `remote: error: GH001 … data/orphan-enriched-data.json is 284.54 MB; this
 * exceeds GitHub's file size limit of 100.00 MB`. The store had inflated
 * 64.6 MB → ~285 MB in a single run because the orphan record identity carried
 * the locale:
 *
 *   step 2d writes FOUR locale paths per orphan into data/seo-404-compat →
 *   step 2b reads them back, derives the SAME slug from each of the four paths
 *   and, keying on `${locale}:${slug}`, minted four full ~2.5 KB enriched
 *   records for one slug.
 *
 * The duplicates were dead weight: build-plugins/jobsSeoPagesPlugin.ts indexes
 * the store with `orphanGscData.set(entry.slug, …)` — last-one-wins — so three
 * of every four were discarded at read time. The only thing they carried that
 * the survivor did not was the observed path; that now lives in
 * `observedPaths`.
 *
 * These tests pin both halves of the contract:
 *   1. one record per slug (the size fix), and
 *   2. mine-all-job-slugs still resolves the SAME four locale paths, so
 *      data/all-known-job-slugs.json — and therefore the 404 soft-landing
 *      coverage that protects indexed URLs — does not regress.
 */
import { describe, expect, it } from 'vitest';

import {
  ORPHAN_LOCALES,
  collectObservedPaths,
  hasSearchSignal,
  recordCompatObservation,
} from '../scripts/sync-gsc-orphans.mjs';
import { mineOrphanData } from '../scripts/mine-all-job-slugs.mjs';

const SLUG = 'operaio-specializzato-acme-lugano';
const LOCALE_PATHS: Record<string, string> = {
  it: `/cerca-lavoro-ticino/${SLUG}`,
  en: `/en/find-jobs-ticino/${SLUG}`,
  de: `/de/jobs-im-tessin/${SLUG}`,
  fr: `/fr/trouver-emploi-tessin/${SLUG}`,
};

/** The four records the pre-fix `${locale}:${slug}` key used to mint. */
function legacyPerLocaleRecords(): Array<Record<string, unknown>> {
  return ORPHAN_LOCALES.map((locale) => ({
    slug: SLUG,
    locale,
    path: LOCALE_PATHS[locale],
    queries: [],
    totalImpressions: 0,
    totalClicks: 0,
    source: 'gsc-404-compat',
  }));
}

describe('orphan record identity is the slug, not locale:slug (#4248)', () => {
  it('folds every locale observation of one slug into a single record', () => {
    const record: Record<string, unknown> = {
      slug: SLUG,
      locale: 'it',
      path: LOCALE_PATHS.it,
      queries: [],
      totalImpressions: 0,
      totalClicks: 0,
      source: 'gsc-404-compat',
    };

    expect(recordCompatObservation(record, 'it', LOCALE_PATHS.it)).toBe(true);
    for (const locale of ['en', 'de', 'fr']) {
      expect(recordCompatObservation(record, locale, LOCALE_PATHS[locale])).toBe(true);
    }
    // Re-observing an already-recorded locale is a no-op: the compat store is
    // re-read on every run, so this is the steady state, and it is what stops
    // the store from growing without bound.
    expect(recordCompatObservation(record, 'en', LOCALE_PATHS.en)).toBe(false);

    expect(Object.keys(record.observedPaths as object).sort()).toEqual(['de', 'en', 'fr', 'it']);
  });

  it('exposes legacy path/locale records through the same accessor', () => {
    // Pre-#4248 record: no observedPaths map at all.
    expect(collectObservedPaths({ slug: SLUG, locale: 'de', path: LOCALE_PATHS.de })).toEqual({
      de: LOCALE_PATHS.de,
    });
    // Mixed shape: the map plus the record's own primary observation.
    expect(
      collectObservedPaths({
        slug: SLUG,
        locale: 'it',
        path: LOCALE_PATHS.it,
        observedPaths: { en: LOCALE_PATHS.en },
      }),
    ).toEqual({ it: LOCALE_PATHS.it, en: LOCALE_PATHS.en });
  });

  it('never collapses a record that carries its own Search Console signal', () => {
    // Signal-free: pure path coverage, safe to fold into a sibling.
    expect(hasSearchSignal({ queries: [], totalImpressions: 0, totalClicks: 0 })).toBe(false);
    // Real per-locale demand — queries/impressions are locale-specific and must
    // stay addressable per locale, so these records are never merged away.
    expect(hasSearchSignal({ queries: [{ query: 'lavoro lugano' }] })).toBe(true);
    expect(hasSearchSignal({ queries: [], totalImpressions: 12, totalClicks: 0 })).toBe(true);
    expect(hasSearchSignal({ queries: [], totalImpressions: 0, totalClicks: 3 })).toBe(true);
  });
});

describe('all-known-job-slugs locale coverage survives the collapse (#4248)', () => {
  it('resolves the same 4 locale paths from 1 folded record as from 4 duplicates', () => {
    const fromDuplicates = mineOrphanData(legacyPerLocaleRecords());

    const folded: Record<string, unknown> = {
      slug: SLUG,
      locale: 'it',
      path: LOCALE_PATHS.it,
      queries: [],
      totalImpressions: 0,
      totalClicks: 0,
      source: 'gsc-404-compat',
      observedPaths: { ...LOCALE_PATHS },
    };
    const fromFolded = mineOrphanData([folded]);

    expect(fromFolded.get(SLUG)?.locales).toEqual(fromDuplicates.get(SLUG)?.locales);
    expect(fromFolded.get(SLUG)?.locales).toEqual(LOCALE_PATHS);
  });

  it('still honours a legacy record with no observedPaths map', () => {
    const legacy = mineOrphanData([
      { slug: SLUG, locale: 'fr', path: LOCALE_PATHS.fr, queries: [], totalImpressions: 0 },
    ]);
    expect(legacy.get(SLUG)?.locales.fr).toBe(LOCALE_PATHS.fr);
  });

  it('does not let an observed path overwrite an earlier one for the same locale', () => {
    const result = mineOrphanData([
      {
        slug: SLUG,
        locale: 'it',
        path: LOCALE_PATHS.it,
        observedPaths: { it: '/cerca-lavoro-zurigo/drifted' },
        queries: [],
        totalImpressions: 0,
      },
    ]);
    // observedPaths is consulted first and wins; the point of the assertion is
    // that exactly ONE value survives — no duplicate/last-write-wins churn.
    expect(result.get(SLUG)?.locales.it).toBe('/cerca-lavoro-zurigo/drifted');
  });
});
