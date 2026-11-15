/**
 * Publisher fast gate, class 2: 489 de/en/fr URLs live in sitemap-jobs.xml but
 * absent from the page manifest of their locale.
 *
 * pushEditorialSitemapEntry probed the IT file in dist/ before publishing any
 * group. A BUILD_LOCALE=de|en|fr build never writes the IT file, so every
 * editorial entry of that locale vanished from its own sitemap (hence from the
 * page manifest) while the IT build advertised it. The gate is now decided on
 * the page of a locale the build emits (shared/editorialSitemapEmitGate.ts),
 * and the Issue 18 invariant (never advertise a URL whose HTML was not emitted)
 * stays in force.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { editorialSitemapEmitGate } from '../build-plugins/shared/editorialSitemapEmitGate';

type L = 'it' | 'en' | 'de' | 'fr';
const ALL: readonly L[] = ['it', 'en', 'de', 'fr'];
const PATHS = new Map<L, string>([
  ['it', '/cerca-lavoro-argovia/offerte-di-lavoro-argovia-oggi/'],
  ['en', '/en/find-jobs-aargau/aargau-jobs-today/'],
  ['de', '/de/jobs-im-aargau/jobs-aargau-heute/'],
  ['fr', '/fr/trouver-emploi-argovie/offres-emploi-argovie-aujourdhui/'],
]);

const gateFor = (owned: readonly L[], emittedLocales: readonly L[], sitemapLocales: readonly L[] = ALL) =>
  editorialSitemapEmitGate<L>({
    sitemapLocales,
    localePaths: PATHS,
    emitsLocale: (l) => owned.includes(l),
    pageEmitted: (p) => emittedLocales.some((l) => PATHS.get(l) === p),
  });

describe('editorialSitemapEmitGate - build that emits IT (monolithic or IT leg)', () => {
  it('publishes every group when the IT page was emitted, without probing sibling locales', () => {
    const gate = gateFor(['it'], ['it']);
    expect(gate).not.toBeNull();
    for (const l of ALL) expect(gate!.advertises(l)).toBe(true);
  });

  it('publishes nothing when the IT page was not emitted (Issue 18 invariant)', () => {
    expect(gateFor(['it'], [])).toBeNull();
    expect(gateFor(ALL, ['en', 'de', 'fr'])).toBeNull();
  });

  it('publishes nothing when IT is not an indexable locale of the entry', () => {
    expect(gateFor(['it'], ['it'], ['en', 'de', 'fr'])).toBeNull();
  });
});

describe('editorialSitemapEmitGate - BUILD_LOCALE=de|en|fr build (class 2)', () => {
  for (const owned of ['en', 'de', 'fr'] as const) {
    it(`${owned} build publishes only its owned group when the ${owned} page was emitted`, () => {
      const gate = gateFor([owned], [owned]);
      expect(gate).not.toBeNull();
      for (const locale of ALL) {
        expect(gate!.advertises(locale)).toBe(locale === owned);
      }
    });

    it(`${owned} build does NOT publish when the ${owned} page was not emitted`, () => {
      expect(gateFor([owned], [])).toBeNull();
    });
  }

  it('a build owning two locales publishes only owned groups whose pages were emitted', () => {
    const gate = gateFor(['en', 'de'], ['en']);
    expect(gate).not.toBeNull();
    expect(gate!.advertises('en')).toBe(true);
    expect(gate!.advertises('de')).toBe(false);
    expect(gate!.advertises('it')).toBe(false);
    expect(gate!.advertises('fr')).toBe(false);
  });

  it('is not fooled by an emitted page of a locale the build does not own', () => {
    // The IT file present in a de build's dist (stale restore) is no evidence for de.
    expect(gateFor(['de'], ['it'])).toBeNull();
  });
});

describe('pushEditorialSitemapEntry wiring', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../build-plugins/jobsSeoPagesPlugin.ts'), 'utf-8');
  const start = src.indexOf('const pushEditorialSitemapEntry = (');
  const end = src.indexOf('// Phase 5 (Cathedral P1-A)', start);
  const body = src.slice(start, end);

  it('locates the function', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  it('decides through the shared gate and no longer probes only the IT file', () => {
    expect(body).toContain('editorialSitemapEmitGate(');
    expect(body).toContain('emitGate.advertises(group.locale)');
    expect(body).not.toContain('itEmitted');
  });

  it('keeps the on-disk probe (claims and files) as the page-emitted evidence', () => {
    expect(body).toContain('pathWasClaimed(dirIndex)');
    expect(body).toContain('fs.existsSync(flatHtml)');
  });
});
