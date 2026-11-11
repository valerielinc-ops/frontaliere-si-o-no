import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  JOB_SEO_LOCALES,
 appendNativeJobPrefixIndex,
  buildCantonAwareJobDetailPath,
  buildNativeJobPrefixIndex,
  nativeJobPathRecoveredByWorker,
} from '../build-plugins/jobsSeoPagesPlugin';
import { augmentExpiredSliceIndex, ExpiredSliceOverflow } from '../build-plugins/shared/expiredSliceOverflow';
import { sanitizeSitemapHreflangReciprocity } from '../build-plugins/sitemapAliasPlugin';

type Locale = (typeof JOB_SEO_LOCALES)[number];
type Tracking = Record<string, Partial<Record<Locale, string>>>;
const prefixes = { it: '', en: '/en', de: '/de', fr: '/fr' };
const sections = { it: 'cerca-lavoro-ticino', en: 'jobs-in-ticino', de: 'jobs-im-tessin', fr: 'emploi-au-tessin' };
const normalize = (value: string) => `/${String(value || '').replace(/^\/+|\/+$/g, '')}/`;

// The pre-change implementation is the oracle, including all four locales,
// legacy-TI exclusion, insertion order, route slug and edge-slash handling.
// Self-contained so the same oracle can run in the isolated Node benchmark.
function oldBuildIndex(tracking: Tracking, localePrefix: Record<Locale, string>, sectionByLocale: Record<Locale, string>) {
  const normalizePath = (value: string) => `/${String(value || '').replace(/^\/+|\/+$/g, '')}/`;
  const index = new Map<string, string>();
  for (const paths of Object.values(tracking)) {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const value = paths?.[locale];
      if (!value) continue;
      const normalized = normalizePath(value);
      const prefix = normalizePath(`${localePrefix[locale]}/${sectionByLocale[locale]}`);
      const rest = normalized.slice(prefix.length);
      if (normalized.startsWith(prefix) && rest.length > 1 && !rest.slice(0, -1).includes('/')) continue;
      const slug = normalizePath(value).split('/').filter(Boolean).pop();
      if (slug) index.set(`${locale}:${slug}`, normalizePath(value));
    }
  }
  return index;
}

function oldRecovered(locale: Locale, slug: string, relPath: string, tracking: Tracking, index: Map<string, string>) {
  if (locale === 'it') return false;
  const normalized = normalize(relPath);
  const registryPath = tracking[slug]?.[locale];
  if (registryPath && normalize(registryPath) !== normalized) return true;
  const routeSlug = normalized.split('/').filter(Boolean).pop();
  const nativePath = routeSlug ? index.get(`${locale}:${routeSlug}`) : undefined;
  return Boolean(nativePath && nativePath !== normalized);
}

describe('native job route ownership with interned prefixes', () => {
  it('preserves Map membership, insertion order, and emitted fixture bytes in compact mode', () => {
    const originalMode = process.env.JOBS_SEO_NATIVE_ROUTE_INDEX;
    const activeRouteOwners = new Map<string, number>();
    const activeTracking: Tracking = {
      'active-master': { de: '/de/jobs-in-zurich/shared-route', en: '/en/jobs-in-zurich/active-en' },
    };
    const expiredTracking: Tracking = {
      'expired-first': { de: '/de/jobs-in-bern/shared-route', fr: '/fr/emploi-au-tessin/expired-fr' },
      'expired-last': { de: '/de/jobs-in-luzern/shared-route', en: '/en/jobs-in-bern/expired-en' },
    };
    const activeCandidates = new Set(Object.keys(activeTracking));
    const expiredCandidates = new Set(Object.keys(expiredTracking));
    const snapshots = new Map<string, string[]>();

    try {
      delete process.env.JOBS_SEO_NATIVE_ROUTE_INDEX;
      const compactOwners = new Map<string, number>();
      const compact = buildNativeJobPrefixIndex(activeTracking, prefixes, sections, activeCandidates, compactOwners);
      appendNativeJobPrefixIndex(compact, expiredTracking, prefixes, sections, expiredCandidates, compactOwners);

      process.env.JOBS_SEO_NATIVE_ROUTE_INDEX = 'legacy';
      const legacyOwners = new Map<string, number>();
      const legacy = buildNativeJobPrefixIndex(activeTracking, prefixes, sections, activeCandidates, legacyOwners);
      appendNativeJobPrefixIndex(legacy, expiredTracking, prefixes, sections, expiredCandidates, legacyOwners);

      expect(compact.size).toBe(legacy.size);
      expect([...compact.keys()]).toEqual([...legacy.keys()]);
      expect([...compact.values()]).toEqual([...legacy.values()]);
      expect([...compact]).toEqual([...legacy]);

      const candidatePaths = [
        ['de', 'shared-route', '/de/jobs-im-tessin/shared-route'],
        ['de', 'expired-first', '/de/jobs-im-tessin/shared-route'],
        ['de', 'expired-last', '/de/jobs-im-tessin/shared-route'],
        ['en', 'expired-en', '/en/jobs-im-tessin/expired-en'],
        ['fr', 'expired-fr', '/fr/emploi-au-tessin/expired-fr'],
      ] as const;
      for (const [name, index] of [['compact', compact], ['legacy', legacy]] as const) {
        const decisions = candidatePaths.map(([locale, slug, relPath]) =>
          nativeJobPathRecoveredByWorker(locale, slug, relPath, { ...activeTracking, ...expiredTracking }, index));
        const html = candidatePaths
          .filter((_, index) => !decisions[index])
          .map(([, slug, relPath]) => `<article data-slug="${slug}" data-path="${relPath}"></article>`)
          .join('\n');
        const sitemap = `<urlset>${candidatePaths
          .filter((_, index) => !decisions[index])
          .map(([, , relPath]) => `<url><loc>https://frontaliereticino.ch${relPath}</loc></url>`)
          .join('')}</urlset>`;
        snapshots.set(name, [html, sitemap]);
      }
      expect(snapshots.get('compact')).toEqual(snapshots.get('legacy'));
    } finally {
      if (originalMode === undefined) delete process.env.JOBS_SEO_NATIVE_ROUTE_INDEX;
      else process.env.JOBS_SEO_NATIVE_ROUTE_INDEX = originalMode;
    }
  });

  it('clears compact route and prefix tables after their final reader', () => {
    const index = buildNativeJobPrefixIndex({
      'route-owner': { de: '/de/jobs-in-zurich/route-owner' },
    }, prefixes, sections);

    expect(index.size).toBe(1);
    expect(index.get('de:route-owner')).toBe('/de/jobs-in-zurich/');

    index.clear();

    expect(index.size).toBe(0);
    expect(index.get('de:route-owner')).toBeUndefined();
    expect([...index]).toEqual([]);
  });

  it('appends expired owners in place while preserving active owners and expired last-wins order', () => {
    const activeRouteOwners = new Map<string, number>();
    const active = buildNativeJobPrefixIndex({
      'active-owner': { de: '/de/jobs-in-bern/shared-active' },
    }, prefixes, sections, new Set(['active-owner']), activeRouteOwners);
    const expired: Tracking = {
      'expired-first': {
        de: '/de/jobs-in-zurich/shared-active',
        en: '/en/jobs-in-zug/shared-expired',
      },
      'expired-last': {
        de: '/de/jobs-in-luzern/shared-active',
        en: '/en/jobs-in-bern/shared-expired',
      },
    };
    const candidates = new Set(Object.keys(expired));
    const standaloneExpired = buildNativeJobPrefixIndex(expired, prefixes, sections, candidates);
    const expected = new Map(active);
    for (const [key, prefix] of standaloneExpired) {
      if (!expected.has(key)) expected.set(key, prefix);
    }

    expect(appendNativeJobPrefixIndex(active, expired, prefixes, sections, candidates, activeRouteOwners)).toBe(active);
    expect([...active]).toEqual([...expected]);
    expect(active.get('de:shared-active')).toBe('/de/jobs-in-bern/');
    expect(active.get('en:shared-expired')).toBe('/en/jobs-in-bern/');
  });

  it('recovers identity routes directly and keeps only expired alias winners in order', () => {
    const originalMode = process.env.JOBS_SEO_NATIVE_ROUTE_INDEX;
    const identityOnly: Tracking = { shared: { de: '/de/jobs-in-bern/shared' } };
    const cases = [
      {
        entries: [
          ['identity', { de: '/de/jobs-in-bern/shared' }],
          ['alias', { de: '/de/jobs-in-zurich/shared' }],
        ],
        winner: '/de/jobs-in-zurich/shared',
      },
      {
        entries: [
          ['alias', { de: '/de/jobs-in-zurich/shared' }],
          ['identity', { de: '/de/jobs-in-bern/shared' }],
        ],
        winner: '/de/jobs-in-bern/shared',
      },
    ] as const;

    try {
      delete process.env.JOBS_SEO_NATIVE_ROUTE_INDEX;
      const identityIndex = buildNativeJobPrefixIndex({}, prefixes, sections);
      appendNativeJobPrefixIndex(
        identityIndex,
        identityOnly,
        prefixes,
        sections,
        new Set(Object.keys(identityOnly)),
        new Map(),
      );
      expect(identityIndex.size).toBe(0);
      expect(nativeJobPathRecoveredByWorker(
        'de',
        'missing-key',
        '/de/jobs-in-zurich/shared',
        identityOnly,
        identityIndex,
      )).toBe(true);
      expect(nativeJobPathRecoveredByWorker(
        'de',
        'missing-key',
        '/de/jobs-in-bern/shared',
        identityOnly,
        identityIndex,
      )).toBe(false);

      for (const fixture of cases) {
        const tracking = Object.fromEntries(fixture.entries) as Tracking;
        const candidates = new Set(Object.keys(tracking));
        delete process.env.JOBS_SEO_NATIVE_ROUTE_INDEX;
        const compact = buildNativeJobPrefixIndex({}, prefixes, sections);
        appendNativeJobPrefixIndex(compact, tracking, prefixes, sections, candidates, new Map());
        expect(compact.has('de:shared')).toBe(true);

        process.env.JOBS_SEO_NATIVE_ROUTE_INDEX = 'legacy';
        const legacy = buildNativeJobPrefixIndex({}, prefixes, sections);
        appendNativeJobPrefixIndex(legacy, tracking, prefixes, sections, candidates, new Map());
        const routes = [
          '/de/jobs-in-bern/shared',
          '/de/jobs-in-zurich/shared',
          '/de/jobs-im-tessin/shared',
          '/de/jobs-im-tessin/nested/shared',
        ];
        for (const relPath of routes) {
          for (const slug of ['missing-key', 'identity', 'alias']) {
            expect(nativeJobPathRecoveredByWorker('de', slug, relPath, tracking, compact))
              .toBe(nativeJobPathRecoveredByWorker('de', slug, relPath, tracking, legacy));
          }
        }
        expect(nativeJobPathRecoveredByWorker('de', 'missing-key', fixture.winner, tracking, compact)).toBe(false);
      }
    } finally {
      if (originalMode === undefined) delete process.env.JOBS_SEO_NATIVE_ROUTE_INDEX;
      else process.env.JOBS_SEO_NATIVE_ROUTE_INDEX = originalMode;
    }
  });

  it('protects active ownership per locale without blocking a historical sibling locale', () => {
    const activeRouteOwners = new Map<string, number>();
    const active = buildNativeJobPrefixIndex({
      'active-master': { de: '/de/jobs-in-zurich/shared-slug' },
    }, prefixes, sections, new Set(['active-master']), activeRouteOwners);
    const expired: Tracking = {
      'expired-english': { en: '/en/jobs-in-bern/shared-slug' },
      'expired-german': { de: '/de/jobs-in-bern/shared-slug' },
    };

    appendNativeJobPrefixIndex(
      active,
      expired,
      prefixes,
      sections,
      new Set(Object.keys(expired)),
      activeRouteOwners,
    );

    expect(active.get('de:shared-slug')).toBe('/de/jobs-in-zurich/');
    expect(active.get('en:shared-slug')).toBe('/en/jobs-in-bern/');
  });

  it('retains arbitrary prefixes and the last route for each locale + route slug', () => {
    const routes = [
      'single', '', '/', '///', '///one//two/job///', '/emploi/équipe/%2f/',
      '/emploi/équipe/%2F/', '/de/jobs-im-tessin/legacy/',
      '/de/jobs-im-tessin/nested/nested-job/', '/unknown/place/unknown-job/',
    ];
    const tracking: Tracking = Object.fromEntries(routes.map((route, i) => [
      `tracking-key-${i}`, Object.fromEntries(JOB_SEO_LOCALES.map(locale => [locale, route])),
    ]));
    const old = oldBuildIndex(tracking, prefixes, sections);
    const next = buildNativeJobPrefixIndex(tracking, prefixes, sections);
    expect([...next.keys()]).toEqual([...old.keys()].filter(key => !key.startsWith('it:')));
    for (const [key, value] of old) {
      if (key.startsWith('it:')) continue;
      const slug = value.split('/').filter(Boolean).pop()!;
      expect(next.get(key)).toBe(value.slice(0, -(slug.length + 1)));
    }
    expect(next.get('en:single')).toBe('/');
    expect(next.get('de:legacy')).toBeUndefined();
    expect(next.get('en:%2f')).not.toBeUndefined();
    expect(next.get('en:%2F')).not.toBeUndefined();
    expect(next.get('de:nested-job')).toBe('/de/jobs-im-tessin/nested/');
    expect(next.get('fr:unknown-job')).toBe('/unknown/place/');
    expect(next.get('en:job')).toBe('/one//two/');
    for (const reversed of [false, true]) {
      const values = ['/de/jobs-in-unknown/job/', '/de/jobs-in-another/job/'];
      if (reversed) values.reverse();
      const duplicate: Tracking = { first: { de: values[0] }, last: { de: values[1] } };
      const index = buildNativeJobPrefixIndex(duplicate, prefixes, sections);
      expect(index.get('de:job')).toBe(normalize(values[1]).slice(0, -4));
      for (const value of values) {
        expect(nativeJobPathRecoveredByWorker('de', 'missing-key', value, duplicate, index))
          .toBe(oldRecovered('de', 'missing-key', value, duplicate, oldBuildIndex(duplicate, prefixes, sections)));
      }
    }
  });

  it('matches the old decision across route aliases, compat mutations and registry states', () => {
    const slugs = ['offre-équipe', '%2f', '%2F', 'same', 'nested'];
    const roots = ['', 'arbitrary', 'one//two', 'jobs-im-tessin', 'jobs-im-tessin/nested'];
    const tracking: Tracking = {};
    for (let i = 0; i < 120; i++) {
      tracking[`key-${i}`] = Object.fromEntries(JOB_SEO_LOCALES.map((locale, l) => [
        locale, `${i % 2 ? '///' : ''}${locale}/${roots[(i + l) % roots.length]}/${slugs[i % slugs.length]}${i % 3 ? '/' : '///'}`,
      ]));
    }
    const old = oldBuildIndex(tracking, prefixes, sections);
    const next = buildNativeJobPrefixIndex(tracking, prefixes, sections);
    // Compatibility merge happens AFTER capture and overwrites native aliases.
    for (const locale of JOB_SEO_LOCALES) tracking['key-0'][locale] = `${prefixes[locale]}/${sections[locale]}/offre-équipe/`;
    for (const locale of JOB_SEO_LOCALES) {
      for (const slug of [...slugs, '', 'absent']) {
        for (const root of roots) {
          for (const edge of ['', '/', '///']) {
            const relPath = `${edge}${locale}/${root}/${slug}${edge}`;
            // Registry differs, agrees exactly, or is absent. The lookup key
            // deliberately differs from the route slug in the first two cases.
            tracking.same = { [locale]: relPath };
            for (const key of ['key-0', 'same', 'absent-key']) {
              expect(nativeJobPathRecoveredByWorker(locale, key, relPath, tracking, next))
                .toBe(oldRecovered(locale, key, relPath, tracking, old));
            }
          }
        }
      }
    }
  });

  it('snapshots only tracking rows that the compat merge can overwrite', () => {
    const tracking: Tracking = {
      'current-de': {
        de: '/de/jobs-in-zurich/current-de',
        en: '/en/jobs-in-zurich/current-en',
      },
      'historical-de': {
        de: '/de/jobs-in-bern/historical-de',
        en: '/en/jobs-in-bern/historical-en',
      },
    };
    const currentSlugs = new Set(['current-de']);
    const index = buildNativeJobPrefixIndex(tracking, prefixes, sections, currentSlugs);

    expect([...index.keys()]).toEqual(['en:current-en', 'de:current-de']);
    expect(index.has('de:historical-de')).toBe(false);
    expect(index.has('en:historical-en')).toBe(false);

    // The compat merge overwrites the German active path. Its native prefix
    // remains available to the Worker guard from the filtered snapshot.
    tracking['current-de'].de = '/de/jobs-im-tessin/current-de';
    expect(nativeJobPathRecoveredByWorker(
      'de',
      'unknown-tracking-key',
      '/de/jobs-im-tessin/current-de',
      tracking,
      index,
    )).toBe(true);
    expect(nativeJobPathRecoveredByWorker(
      'de',
      'historical-de',
      '/de/jobs-in-bern/historical-de',
      tracking,
      index,
    )).toBe(false);
  });

  it('keeps active master identifiers and expired locale variants in the bounded snapshot', () => {
    // Active jobs whose master slug differs from the localized route used to
    // be omitted when the snapshot was filtered only by currentSlugs. The
    // compat merge then added the localized route as a legacy-TI key and the
    // self-healing pass could emit a canonical-less page at that alias.
    const activeTracking: Tracking = {
      'active-master-slug': {
        en: '/en/find-jobs-vaud/localized-active-slug',
      },
    };
    const activeCandidates = new Set(['localized-active-slug', 'active-master-slug']);
    const activeIndex = buildNativeJobPrefixIndex(activeTracking, prefixes, sections, activeCandidates);
    activeTracking['localized-active-slug'] = {
      en: '/en/find-jobs-ticino/localized-active-slug',
    };
    expect(nativeJobPathRecoveredByWorker(
      'en',
      'localized-active-slug',
      '/en/find-jobs-ticino/localized-active-slug',
      activeTracking,
      activeIndex,
    )).toBe(true);

    // Expired records use locale-specific variants too. They are merged into
    // a second bounded index after the compat pass, while the native row stays
    // authoritative and must still suppress a TI copy.
    const expiredTracking: Tracking = {
      'expired-master-slug': {
        de: '/de/jobs-in-der-waadt/expired-locale-slug',
      },
    };
    const expiredIndex = buildNativeJobPrefixIndex(
      expiredTracking,
      prefixes,
      sections,
      new Set(['expired-master-slug', 'expired-locale-slug']),
    );
    expiredTracking['expired-locale-slug'] = {
      de: '/de/jobs-im-tessin/expired-locale-slug',
    };
    expect(nativeJobPathRecoveredByWorker(
      'de',
      'expired-locale-slug',
      '/de/jobs-im-tessin/expired-locale-slug',
      expiredTracking,
      expiredIndex,
    )).toBe(true);
  });

  it('recovers a native alias retained only in expired slice overflow', () => {
    const primary = new Map<string, { slug: string; slugByLocale: { de: string } }>();
    const overflow = new ExpiredSliceOverflow<{ slug: string; slugByLocale: { de: string } }>();
    const late = { slug: 'late-master-slug', slugByLocale: { de: 'late-locale-slug' } };
    const emittedSlugs = new Set(['late-master-slug', 'late-locale-slug']);
    try {
      augmentExpiredSliceIndex([late], emittedSlugs, primary, overflow, 1, () => 0);
      expect([...overflow.keys()]).toEqual(['late-locale-slug']);
      const candidates = new Set([...primary.keys(), ...overflow.keys()]);
      const tracking: Tracking = {
        'late-master-slug': { de: '/de/jobs-in-der-waadt/late-locale-slug' },
      };
      const index = buildNativeJobPrefixIndex(tracking, prefixes, sections, candidates);
      tracking['late-locale-slug'] = { de: '/de/jobs-im-tessin/late-locale-slug' };
      expect(nativeJobPathRecoveredByWorker(
        'de',
        'late-locale-slug',
        '/de/jobs-im-tessin/late-locale-slug',
        tracking,
        index,
      )).toBe(true);
    } finally { overflow.close(); }
  });

  it('keeps foreign ownership, expired/self-healing decisions and reciprocal canonical paths after compat merge', () => {
    const slugs = { it: 'ingegnere', en: 'engineer', de: 'ingenieur', fr: 'ingénieur' };
    const canonical = Object.fromEntries(JOB_SEO_LOCALES.map(locale => [
      locale, buildCantonAwareJobDetailPath(locale, 'ZH', slugs[locale]),
    ])) as Record<Locale, string>;
    const tracking: Tracking = { 'master-key': { ...canonical } };
    const old = oldBuildIndex(tracking, prefixes, sections);
    const next = buildNativeJobPrefixIndex(tracking, prefixes, sections, new Set(['master-key']));
    const legacy = Object.fromEntries(JOB_SEO_LOCALES.map(locale => [
      locale, normalize(`${prefixes[locale]}/${sections[locale]}/${slugs[locale]}`),
    ])) as Record<Locale, string>;
    tracking['master-key'] = { ...legacy };
    const emit = (guard: (locale: Locale, key: string, route: string) => boolean) => {
      // Both production passes call the same real guard before locale gating.
      const expired = JOB_SEO_LOCALES.filter(locale => !guard(locale, 'master-key', legacy[locale]));
      const selfHealing = Object.entries(tracking).flatMap(([key, paths]) =>
        JOB_SEO_LOCALES.filter(locale => !guard(locale, key, paths[locale]!)));
      return { expired, selfHealing };
    };
    const expected = emit((locale, key, route) => oldRecovered(locale, key, route, tracking, old));
    const actual = emit((locale, key, route) => nativeJobPathRecoveredByWorker(locale, key, route, tracking, next));
    expect(actual).toEqual(expected);
    expect(actual).toEqual({ expired: ['it'], selfHealing: ['it'] });
    // An IT build must still know EN/DE/FR ownership before shouldEmitLocale.
    for (const locale of ['en', 'de', 'fr'] as const) {
      expect(next.has(`${locale}:${slugs[locale]}`)).toBe(true);
      expect(nativeJobPathRecoveredByWorker(locale, 'foreign-key', legacy[locale], tracking, next)).toBe(true);
      expect(nativeJobPathRecoveredByWorker(locale, 'foreign-key', canonical[locale], tracking, next)).toBe(false);
    }
    const base = 'https://frontaliereticino.ch';
    const alternates = JOB_SEO_LOCALES.map(locale => `<xhtml:link rel="alternate" hreflang="${locale}" href="${base}${canonical[locale]}" />`).join('');
    const xml = `<urlset>${JOB_SEO_LOCALES.map(locale => `<url><loc>${base}${canonical[locale]}</loc>${alternates}</url>`).join('')}</urlset>`;
    const changedFiles = sanitizeSitemapHreflangReciprocity([{ file: 'sitemap-jobs.xml', xml }]);
    expect(changedFiles.size).toBe(0);
    const sanitized = changedFiles.get('sitemap-jobs.xml') ?? xml;
    for (const locale of JOB_SEO_LOCALES) {
      expect(sanitized).toContain(`<loc>${base}${canonical[locale]}</loc>`);
      expect(sanitized).toContain(`hreflang="${locale}" href="${base}${canonical[locale]}"`);
    }
  });

  // Keep heap measurements observational, opt-in, and comparable within a
  // single runtime. The sample records the Node version for interpretation.
 it.skipIf(process.env.CI !== 'true')('reports isolated native-route index peak and retained heaps', { timeout: 120_000 }, () => {
    const pluginUrl = pathToFileURL(path.resolve(__dirname, '../build-plugins/jobsSeoPagesPlugin.ts')).href;
    const samples: Array<{ mode: string; heapDelta: number; peakHeapDelta: number; keys: number }> = [];
    for (let repeat = 0; repeat < 3; repeat++) {
      for (const mode of ['prefix', 'active', 'temporary-merge', 'in-place-append']) {
        const indexExpression = mode === 'prefix'
          ? 'buildNativeJobPrefixIndex(tracking, prefixes, sections)'
          : mode === 'active'
            ? 'buildNativeJobPrefixIndex(tracking, prefixes, sections, activeTrackingSlugs)'
            : `(() => {
                const activeRouteOwners = new Map();
                const index = buildNativeJobPrefixIndex(tracking, prefixes, sections, activeTrackingSlugs, activeRouteOwners);
                const expiredTrackingSlugs = new Set(Object.keys(tracking).filter(slug => !activeTrackingSlugs.has(slug)));
                if (${JSON.stringify(mode)} === 'temporary-merge') {
                  const expiredIndex = buildNativeJobPrefixIndex(tracking, prefixes, sections, expiredTrackingSlugs);
                  for (const [key, prefix] of expiredIndex) {
                    const routeSeparator = key.indexOf(':');
                    const locale = key.slice(0, routeSeparator);
                    const slug = key.slice(routeSeparator + 1);
                    const localeBit = 1 << ['it', 'en', 'de', 'fr'].indexOf(locale);
                    if (((activeRouteOwners.get(slug) ?? 0) & localeBit) === 0) index.set(key, prefix);
                  }
                  globalThis.expiredIndexForPeak = expiredIndex;
                } else {
                  appendNativeJobPrefixIndex(index, tracking, prefixes, sections, expiredTrackingSlugs, activeRouteOwners);
                }
                peakHeapUsed = process.memoryUsage().heapUsed;
                return index;
              })()`;
        const script = `
          const { buildNativeJobPrefixIndex, appendNativeJobPrefixIndex } = await import(${JSON.stringify(pluginUrl)});
          const prefixes = ${JSON.stringify(prefixes)};
          const sections = ${JSON.stringify(sections)};
          let tracking = {};
          for (let i = 0; i < 24000; i++) {
            const paths = {};
            for (const locale of ['it', 'en', 'de', 'fr']) {
              const section = i % 17 === 0 ? sections[locale] : 'jobs-in-canton-' + (i % 26);
            const routeSlug = i % 5 === 0
              ? locale + '-senior-engineering-specialist-production-quality-assurance-company-' + i
              : 'master-key-' + i;
            paths[locale] = prefixes[locale] + '/' + section + '/' + routeSlug;
            }
            tracking['master-key-' + i] = paths;
          }
          const activeTrackingSlugs = new Set(Array.from({ length: 2400 }, (_, i) => 'master-key-' + i));
          // Match the JSON-loaded registry representation before either
          // baseline; do not measure flattening fixture-construction ropes.
          tracking = JSON.parse(JSON.stringify(tracking));
          globalThis.retainedTracking = tracking;
          for (let i = 0; i < 3; i++) global.gc();
          const before = process.memoryUsage().heapUsed;
          let peakHeapUsed = before;
          const index = ${indexExpression};
          if (peakHeapUsed === before) peakHeapUsed = process.memoryUsage().heapUsed;
          globalThis.retainedIndex = index;
          const peakHeapDelta = peakHeapUsed - before;
          globalThis.expiredIndexForPeak = undefined;
          for (let i = 0; i < 3; i++) global.gc();
          const after = process.memoryUsage().heapUsed;
          console.log('NATIVE_ROUTE_HEAP_SAMPLE ' + JSON.stringify({
            mode: ${JSON.stringify(mode)}, repeat: ${repeat}, node: process.versions.node,
            trackingKeys: Object.keys(tracking).length, keys: index.size,
            uniqueValues: new Set(index.values()).size,
            heapDelta: after - before,
            peakHeapDelta,
          }));
        `;
        const result = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', '--input-type=module', '-e', script], {
          cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 20_000,
        });
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        const line = result.stdout.split('\n').find(value => value.startsWith('NATIVE_ROUTE_HEAP_SAMPLE '));
        expect(line, result.stdout).toBeDefined();
        const sample = JSON.parse(line!.slice('NATIVE_ROUTE_HEAP_SAMPLE '.length));
        expect(sample.trackingKeys).toBe(24000);
        // Each non-TI route contributes three locales; `i % 5 === 0` models
        // localized aliases, while the remaining 80% can be read directly
        // from tracking by the compact historical lookup.
        const isLegacyRouteIndex = process.env.JOBS_SEO_NATIVE_ROUTE_INDEX === 'legacy';
        const expectedKeys = mode === 'active'
          ? 6774
          : mode === 'in-place-append' && !isLegacyRouteIndex
            ? 18972
            : 67764;
        expect(sample.keys).toBe(expectedKeys);
        console.log('NATIVE_ROUTE_HEAP_SAMPLE', sample);
        samples.push(sample);
      }
    }
    console.log('NATIVE_ROUTE_HEAP_AB', JSON.stringify(samples));
  });
});
