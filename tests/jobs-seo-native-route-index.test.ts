import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  JOB_SEO_LOCALES,
  buildCantonAwareJobDetailPath,
  buildNativeJobPrefixIndex,
  nativeJobPathRecoveredByWorker,
} from '../build-plugins/jobsSeoPagesPlugin';
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

  it('keeps foreign ownership, expired/self-healing decisions and reciprocal canonical paths after compat merge', () => {
    const slugs = { it: 'ingegnere', en: 'engineer', de: 'ingenieur', fr: 'ingénieur' };
    const canonical = Object.fromEntries(JOB_SEO_LOCALES.map(locale => [
      locale, buildCantonAwareJobDetailPath(locale, 'ZH', slugs[locale]),
    ])) as Record<Locale, string>;
    const tracking: Tracking = { 'master-key': { ...canonical } };
    const old = oldBuildIndex(tracking, prefixes, sections);
    const next = buildNativeJobPrefixIndex(tracking, prefixes, sections);
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

  // CI is Node 22. Do not add a noisy heap assertion or run this on the
  // pressure-constrained developer host: print measured samples for review.
  it.skipIf(process.env.CI !== 'true')('reports isolated Node 22 A/B retained heaps with tracking alive', { timeout: 120_000 }, () => {
    expect(process.versions.node.split('.')[0]).toBe('22');
    const pluginUrl = pathToFileURL(path.resolve(__dirname, '../build-plugins/jobsSeoPagesPlugin.ts')).href;
    const samples: Array<{ mode: string; heapDelta: number; keys: number }> = [];
    for (let repeat = 0; repeat < 3; repeat++) {
      for (const mode of ['old', 'prefix']) {
        const script = `
          const { buildNativeJobPrefixIndex } = await import(${JSON.stringify(pluginUrl)});
          const oldBuildIndex = ${oldBuildIndex.toString()};
          const prefixes = ${JSON.stringify(prefixes)};
          const sections = ${JSON.stringify(sections)};
          const tracking = {};
          for (let i = 0; i < 24000; i++) {
            const paths = {};
            for (const locale of ['it', 'en', 'de', 'fr']) {
              const section = i % 17 === 0 ? sections[locale] : 'jobs-in-canton-' + (i % 26);
              paths[locale] = prefixes[locale] + '/' + section + '/' + locale + '-senior-engineering-specialist-production-quality-assurance-company-' + i;
            }
            tracking['master-key-' + i] = paths;
          }
          globalThis.retainedTracking = tracking;
          for (let i = 0; i < 3; i++) global.gc();
          const before = process.memoryUsage().heapUsed;
          const index = ${mode === 'old' ? 'oldBuildIndex' : 'buildNativeJobPrefixIndex'}(tracking, prefixes, sections);
          globalThis.retainedIndex = index;
          for (let i = 0; i < 3; i++) global.gc();
          const after = process.memoryUsage().heapUsed;
          console.log('NATIVE_ROUTE_HEAP_SAMPLE ' + JSON.stringify({
            mode: ${JSON.stringify(mode)}, repeat: ${repeat}, node: process.versions.node,
            trackingKeys: Object.keys(tracking).length, keys: index.size,
            uniqueValues: new Set(index.values()).size,
            heapDelta: after - before,
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
        expect(sample.keys).toBe(mode === 'old' ? 90352 : 67764);
        console.log('NATIVE_ROUTE_HEAP_SAMPLE', sample);
        samples.push(sample);
      }
    }
    console.log('NATIVE_ROUTE_HEAP_AB', JSON.stringify(samples));
  });
});
