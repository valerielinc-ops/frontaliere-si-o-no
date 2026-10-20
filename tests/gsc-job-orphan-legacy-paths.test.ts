import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { urlToOrphan } from '../scripts/lib/gsc-job-orphans.mjs';
import { assertGscOrphanSnapshot, gscOrphanRouteKey, mergeGscOrphanRecords } from '../scripts/lib/gsc-orphan-snapshot.mjs';
import { sectionPathFromOrphan } from '../build-plugins/jobOrphanBridgePlugin';

const jobSections = {
  it: new Set(['cerca-lavoro-ticino']),
  en: new Set(['find-jobs-ticino']),
  de: new Set(['jobs-im-tessin']),
  fr: new Set(['trouver-emploi-tessin']),
};

describe('GSC job-orphan paths', () => {
  it.each(['it', 'en', 'de', 'fr'] as const)('recognizes the shared legacy /lavoro route (%s)', (locale) => {
    const prefix = locale === 'it' ? '' : `/${locale}`;
    const url = `https://frontaliereticino.ch${prefix}/lavoro/legacy-job-slug/`;
    expect(urlToOrphan(url, jobSections)).toEqual({ locale, slug: 'legacy-job-slug', url });
  });

  it('continues to recognize current localized job sections', () => {
    expect(urlToOrphan('https://frontaliereticino.ch/fr/trouver-emploi-tessin/job-slug/', jobSections))
      .toMatchObject({ locale: 'fr', slug: 'job-slug' });
    expect(urlToOrphan('https://frontaliereticino.ch/de/jobs-im-tessin/job-slug/', jobSections))
      .toMatchObject({ locale: 'de', slug: 'job-slug' });
  });

  it.each([
    'https://frontaliereticino.ch/fr/articles-frontalier/editorial-slug/',
    'https://frontaliereticino.ch/de/grenzgaenger-artikel/editorial-slug/',
    'https://frontaliereticino.ch/fr/lavoro/',
    'https://frontaliereticino.ch/lavoro/ricerca-fisioterapista/',
  ])('does not ingest non-job or job-hub paths (%s)', (url) => {
    expect(urlToOrphan(url, jobSections)).toBeNull();
  });

  it('keeps distinct section URLs even when locale and slug are equal', () => {
    const one = { locale: 'de', slug: 'same-slug', url: 'https://frontaliereticino.ch/de/jobs-in-bern/same-slug/', kind: 'expired' };
    const two = { ...one, url: 'https://frontaliereticino.ch/de/jobs-in-zurich/same-slug/' };
    expect(mergeGscOrphanRecords([], [one, two])).toEqual([one, two]);
  });

  it('updates a route when re-imported but retains routes absent from a later sample', () => {
    const oldRoute = { locale: 'fr', slug: 'old', url: 'https://frontaliereticino.ch/fr/lavoro/old/', kind: 'expired' };
    const refreshedRoute = {
      ...oldRoute,
      url: 'https://frontaliereticino.ch/fr//lavoro/old/',
      kind: 'expired-tracked',
    };
    const unrelated = { locale: 'de', slug: 'other', url: 'https://frontaliereticino.ch/de/lavoro/other/', kind: 'expired' };
    expect(mergeGscOrphanRecords([oldRoute, unrelated], [refreshedRoute])).toEqual([refreshedRoute, unrelated]);
  });

  it('validates historical snapshots before allowing them to be rewritten', () => {
    const options = {
      file: 'gsc-job-orphans.json',
      recordsKey: 'orphans',
      identityField: 'slug',
      kinds: ['matched', 'expired-tracked', 'expired'],
    };
    const snapshot = {
      sources: ['coverage-export'],
      orphans: [{ locale: 'fr', slug: 'old-job', url: 'https://frontaliereticino.ch/fr/lavoro/old-job/', kind: 'expired', csvOrigin: 'coverage-export' }],
    };
    const validateJobRoute = (entry: { locale: string; slug: string; url: string }) => {
      const route = urlToOrphan(entry.url, jobSections);
      return route?.locale === entry.locale && route?.slug === entry.slug;
    };
    expect(() => assertGscOrphanSnapshot(snapshot, { ...options, validateRoute: validateJobRoute })).not.toThrow();
    expect(() => assertGscOrphanSnapshot({ ...snapshot, sources: 'coverage-export' }, options)).toThrow(/refusing to overwrite/);
    expect(() => assertGscOrphanSnapshot({ ...snapshot, orphans: [{ ...snapshot.orphans[0], slug: '' }] }, options)).toThrow(/refusing to overwrite/);
    expect(() => assertGscOrphanSnapshot({ ...snapshot, orphans: [{ ...snapshot.orphans[0], url: undefined }] }, options)).toThrow(/refusing to overwrite/);
    expect(() => assertGscOrphanSnapshot({ ...snapshot, orphans: [{ ...snapshot.orphans[0], kind: 'unknown' }] }, options)).toThrow(/refusing to overwrite/);
    expect(() => assertGscOrphanSnapshot({ ...snapshot, orphans: [{ ...snapshot.orphans[0], url: 'file:///tmp/old-job' }] }, options)).toThrow(/refusing to overwrite/);
    expect(() => assertGscOrphanSnapshot({ ...snapshot, orphans: [{ ...snapshot.orphans[0], url: 'https://evil.example/fr/lavoro/old-job/' }] }, options)).toThrow(/refusing to overwrite/);
    expect(() => assertGscOrphanSnapshot({ ...snapshot, orphans: [{ ...snapshot.orphans[0], locale: 'de', slug: 'other' }] }, {
      ...options,
      validateRoute: validateJobRoute,
    })).toThrow(/refusing to overwrite/);
    expect(() => assertGscOrphanSnapshot({ ...snapshot, orphans: [{ ...snapshot.orphans[0], kind: 'expired', jobId: 'active-job' }] }, {
      ...options,
      validateRecord: (entry) => entry.kind === 'matched'
        ? typeof entry.jobId === 'string' && entry.jobId.length > 0
        : entry.jobId === undefined,
    })).toThrow(/refusing to overwrite/);
  });

  it('rejects unkeyable routes instead of silently creating a non-route identity', () => {
    expect(() => gscOrphanRouteKey({ url: 'ftp://example.com/job/' })).toThrow(/Unsupported/);
    expect(() => gscOrphanRouteKey({ url: 'https://evil.example/job/' })).toThrow(/host/);
    expect(gscOrphanRouteKey({ url: 'https://www.frontaliereticino.ch/fr/lavoro/old-job/' }))
      .toBe('/fr/lavoro/old-job/');
  });

  it('uses the same additive snapshot merge in all URL-based GSC bridge ingesters', () => {
    for (const file of [
      '../scripts/ingest-gsc-job-orphans.mjs',
      '../scripts/ingest-gsc-location-hubs.mjs',
      '../scripts/ingest-gsc-company-hubs.mjs',
    ]) {
      const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source, file).toContain('mergeGscOrphanRecords');
      expect(source, file).toContain('gscOrphanRouteKey');
      expect(source, file).toContain('assertGscOrphanSnapshot');
      expect(source, file).toContain('refreshedExisting');
      expect(source, file).toContain('validateRoute:');
      expect(source, file).toContain('withSingleFlightLock');
    }
  });

  it.each([
    ['fr', 'https://frontaliereticino.ch/fr/lavoro/fisioterapista-con-riconoscimento-crs-fisiocare-sagl-fisiocare-sagl/', '/fr/trouver-emploi-tessin/'],
    ['de', 'https://frontaliereticino.ch/de/lavoro/fisioterapista-con-riconoscimento-crs-fisiocare-sagl-fisiocare-sagl/', '/de/jobs-im-tessin/'],
  ] as const)('canonicalizes an expired %s legacy job to the live localized board', (locale, url, canonicalPath) => {
    const entry = {
      locale,
      slug: 'fisioterapista-con-riconoscimento-crs-fisiocare-sagl-fisiocare-sagl',
      url,
      kind: 'expired' as const,
    };
    expect(sectionPathFromOrphan(entry)).toBe(canonicalPath);
  });
});
