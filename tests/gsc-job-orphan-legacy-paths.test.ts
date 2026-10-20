import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { urlToOrphan } from '../scripts/lib/gsc-job-orphans.mjs';
import {
  assertGscLegacyAliasSnapshot,
  assertGscOrphanSnapshot,
  gscOrphanPathKey,
  gscOrphanRouteKey,
  isAllowedGscOrphanUrl,
  mergeGscOrphanRecords,
} from '../scripts/lib/gsc-orphan-snapshot.mjs';
import { sectionPathFromOrphan } from '../build-plugins/jobOrphanBridgePlugin';
import { legacyAliasPlugin } from '../build-plugins/legacyAliasPlugin';

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

  it('merges path-based legacy aliases by normalized route and keeps absent routes', () => {
    const oldAlias = { orphanPath: '/fr/articles-frontalier/old/', canonicalPath: '/fr/articles-frontalier/', cohort: 'blogLocaleMismatch' };
    const currentAlias = { ...oldAlias, orphanPath: '/fr//articles-frontalier/old/', canonicalPath: '/fr/articles-frontalier/new/' };
    const retainedAlias = { orphanPath: '/de/grenzgaenger-artikel/other/', canonicalPath: '/de/grenzgaenger-artikel/', cohort: 'blogLocaleMismatch' };
    expect(mergeGscOrphanRecords(
      [oldAlias, retainedAlias],
      [currentAlias],
      (entry) => gscOrphanPathKey(entry.orphanPath),
    )).toEqual([currentAlias, retainedAlias]);
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

  it('validates path-based legacy alias snapshots before refreshing them', () => {
    const alias = {
      orphanPath: '/fr/articles-frontalier/old/',
      locale: 'fr',
      kind: 'unmatched',
      canonicalPath: '/fr/articles-frontalier/',
      cohort: 'blogLocaleMismatch',
    };
    const snapshot = { aliases: [alias] };
    const validateRoute = (entry: typeof alias) => entry.locale === 'fr' && entry.cohort === 'blogLocaleMismatch';
    expect(() => assertGscLegacyAliasSnapshot(snapshot, { file: 'legacy-aliases.json', validateRoute })).not.toThrow();
    expect(() => assertGscLegacyAliasSnapshot({ aliases: [{ ...alias, orphanPath: '//evil.example/path' }] }, {
      file: 'legacy-aliases.json',
      validateRoute,
    })).toThrow(/refusing to overwrite/);
    expect(() => assertGscLegacyAliasSnapshot({ aliases: [{ ...alias, locale: 'de' }] }, {
      file: 'legacy-aliases.json',
      validateRoute,
    })).toThrow(/refusing to overwrite/);
    expect(() => assertGscLegacyAliasSnapshot({ aliases: [{ ...alias, canonicalPath: '//evil.example/path' }] }, {
      file: 'legacy-aliases.json',
      validateRoute,
    })).toThrow(/refusing to overwrite/);
    expect(() => assertGscLegacyAliasSnapshot({ aliases: [{ ...alias, orphanPath: '/jobs/../outside/' }] }, {
      file: 'legacy-aliases.json',
      validateRoute,
    })).toThrow(/refusing to overwrite/);
  });

  it('rejects unkeyable routes instead of silently creating a non-route identity', () => {
    expect(() => gscOrphanRouteKey({ url: 'ftp://example.com/job/' })).toThrow(/Unsupported/);
    expect(() => gscOrphanRouteKey({ url: 'https://evil.example/job/' })).toThrow(/host/);
    expect(() => gscOrphanPathKey('/jobs/../outside/')).toThrow(/pathname/);
    expect(() => gscOrphanPathKey('/jobs/./current/')).toThrow(/pathname/);
    expect(() => gscOrphanPathKey(`/jobs/${String.fromCharCode(92)}outside/`)).toThrow(/pathname/);
    expect(gscOrphanRouteKey({ url: 'https://www.frontaliereticino.ch/fr/lavoro/old-job/' }))
      .toBe('/fr/lavoro/old-job/');
  });

  it('skips out-of-property CSV rows before classification and preserves prior routes', () => {
    const rows = [
      'https://example.test/cerca-lavoro-ticino/sales-assistant/',
      'https://example.test/en/find-jobs-ticino/location-zurich/',
      'https://example.test/de/jobs-im-tessin/company-acme/',
    ];
    const prior = [{
      locale: 'fr',
      slug: 'legacy-job',
      url: 'https://frontaliereticino.ch/fr/lavoro/legacy-job/',
      kind: 'expired',
    }];
    const accepted = rows.filter(isAllowedGscOrphanUrl);
    expect(accepted).toEqual([]);
    expect(isAllowedGscOrphanUrl('https://www.frontaliereticino.ch/fr/lavoro/current/')).toBe(true);
    expect(mergeGscOrphanRecords(prior, accepted)).toEqual(prior);

    for (const [file, parser, classification] of [
      ['../scripts/ingest-gsc-job-orphans.mjs', 'const o = urlToOrphan(url, JOB_SECTION_SLUGS);', 'const classified = classifyOrphan('],
      ['../scripts/ingest-gsc-location-hubs.mjs', 'const h = urlToHub(url);', 'const classified = classifyHub('],
      ['../scripts/ingest-gsc-company-hubs.mjs', 'const h = urlToHub(url);', 'const classified = classifyHub('],
    ] as const) {
      const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
      const guard = source.indexOf('if (!isAllowedGscOrphanUrl(url)) continue;');
      const parsed = source.indexOf(parser);
      const classified = source.indexOf(classification);
      const key = source.indexOf('gscOrphanRouteKey(classified)');
      expect(guard, file).toBeGreaterThanOrEqual(0);
      expect(parsed, file).toBeGreaterThan(guard);
      expect(classified, file).toBeGreaterThan(parsed);
      expect(key, file).toBeGreaterThan(classified);
    }
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

  it('protects the path-based legacy alias generator from capped-export pruning', () => {
    const source = fs.readFileSync(new URL('../scripts/build-legacy-aliases.mjs', import.meta.url), 'utf8');
    expect(source).toContain('assertGscLegacyAliasSnapshot');
    expect(source).toContain('mergeGscOrphanRecords');
    expect(source).toContain('refreshedExisting');
    expect(source).toContain('withSingleFlightLock');
    expect(source).toMatch(/function normalizePath\(rawUrl\)\s*\{\s*try\s*\{\s*return gscOrphanRouteKey\(\{ url: rawUrl \}\);\s*\}\s*catch\s*\{[\s\S]*?return null;/);
    expect(source).toContain('if (!p) continue;');
  });

  it('keeps malformed legacy alias paths from writing outside dist', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-alias-path-guard-'));
    try {
      const distDir = path.join(rootDir, 'dist');
      const dataDir = path.join(rootDir, 'data');
      const outsideDir = path.join(rootDir, 'outside');
      fs.mkdirSync(distDir, { recursive: true });
      fs.mkdirSync(dataDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(path.join(outsideDir, 'flat-target.html'), 'preserve');
      fs.symlinkSync(outsideDir, path.join(distDir, 'linked-route'), 'dir');
      fs.symlinkSync(path.join(outsideDir, 'flat-target.html'), path.join(distDir, 'flat-route.html'));
      fs.writeFileSync(path.join(dataDir, 'legacy-aliases.json'), JSON.stringify({ aliases: [
        {
          orphanPath: '/../outside/',
          locale: 'it',
          kind: 'unmatched',
          canonicalPath: '/cerca-lavoro-ticino/',
          cohort: 'jobLegacySection',
        },
        {
          orphanPath: '/linked-route/',
          locale: 'it',
          kind: 'unmatched',
          canonicalPath: '/cerca-lavoro-ticino/',
          cohort: 'jobLegacySection',
        },
        {
          orphanPath: '/flat-route/',
          locale: 'it',
          kind: 'unmatched',
          canonicalPath: '/cerca-lavoro-ticino/',
          cohort: 'jobLegacySection',
        },
      ] }));

      const plugin = legacyAliasPlugin(rootDir);
      const closeBundle = plugin.closeBundle as { handler: () => Promise<void> };
      await closeBundle.handler();

      expect(fs.existsSync(path.join(outsideDir, 'index.html'))).toBe(false);
      expect(fs.existsSync(path.join(distDir, 'flat-route', 'index.html'))).toBe(false);
      expect(fs.readFileSync(path.join(outsideDir, 'flat-target.html'), 'utf8')).toBe('preserve');
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
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
