import { afterEach, describe, expect, it } from 'vitest';
import { parsePath } from '../services/router';
import { resolveSearchConsoleCompatTarget } from '../build-plugins/searchConsoleCompat';
import { replaceEmittedEventArchivePaths } from '../build-plugins/shared/eventArchiveCompat';
import { historicalComuneArchivePath, pathFor } from '../build-plugins/eventsSeoPagesPlugin';

afterEach(() => replaceEmittedEventArchivePaths([]));

describe('municipal archive route ownership', () => {
  it.each(['it', 'en', 'de', 'fr'] as const)('retains the static page on direct and client navigation (%s)', (locale) => {
    for (const page of [1, 2, 37]) {
      const pathname = historicalComuneArchivePath(locale, 'GE', 'Lancy', page);
      const parsed = parsePath(pathname);
      expect(parsed.locale).toBe(locale);
      expect(parsed.route.staticOverlay).toBe(true);
      expect(parsed.route.activeTab).toBe('vita');
    }
  });

  it.each([
    '/fr/evenements/not-a-canton/lancy/archives/page-2/',
    '/fr/evenements/geneve/lancy/archive/page-2/',
    '/fr/evenements/geneve/lancy/archives/page-0/',
    '/fr/evenements/geneve/lancy/archives/page-02/',
    '/fr/evenements/geneve/lancy/archives/arbitrary/',
    '/fr/evenements/geneve/archives/page-2/extra/',
  ])('does not claim an unknown or malformed deep archive: %s', (pathname) => {
    expect(parsePath(pathname).route.staticOverlay).not.toBe(true);
  });

  it('self-maps only exact paths actually published by the source producer', () => {
    const municipal = pathFor('fr', 'GE', 'Lancy');
    const archive = historicalComuneArchivePath('fr', 'GE', 'Lancy');
    const second = historicalComuneArchivePath('fr', 'GE', 'Lancy', 2);
    replaceEmittedEventArchivePaths([municipal, archive, second]);
    for (const pathname of [municipal, archive, second]) {
      expect(resolveSearchConsoleCompatTarget(pathname)).toEqual({ canonicalPath: pathname, kind: 'legacy', locale: 'fr' });
      expect(resolveSearchConsoleCompatTarget(pathname.slice(0, -1))?.canonicalPath).toBe(pathname);
    }
    const unknown = historicalComuneArchivePath('fr', 'GE', 'Unknown');
    expect(resolveSearchConsoleCompatTarget(unknown)?.canonicalPath).not.toBe(unknown);
    replaceEmittedEventArchivePaths([]);
    expect(resolveSearchConsoleCompatTarget(archive)?.canonicalPath).not.toBe(archive);
  });
});
