import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveExpiredEmitPath } from '../../build-plugins/shared/expiredEmitPath';

describe('resolveExpiredEmitPath', () => {
  const isNeverActive = () => false;
  const isNeverOccupied = () => false;

  it('skips Sins when its active DE slug is tracked under legacy Zurich, including on another locale shard', () => {
    const slug = 'verkaufer-in-kassen-services-coop-genossenschaft-sins';
    const activeJob = { canton: 'AG', slugByLocale: { de: slug } };
    const currentBuildLocale = 'it';
    const activeSlugLocales = new Map([[activeJob.slugByLocale.de, new Set(['de'])]]);

    expect(activeJob.canton).toBe('AG');
    expect(currentBuildLocale).toBe('it');
    expect(resolveExpiredEmitPath({
      locale: 'de',
      trackedPath: '/de/jobs-im-zurich/' + slug,
      slug,
      isActiveSlug: (candidateSlug, locale) =>
        activeSlugLocales.get(candidateSlug)?.has(locale) === true,
      isTargetOccupied: isNeverOccupied,
    })).toEqual({ kind: 'skip', reason: 'active-slug' });
  });

  it('canonicalizes a genuinely expired Zurich alias to its current section', () => {
    const slug = 'expired-zurich-role';
    expect(resolveExpiredEmitPath({
      locale: 'de',
      trackedPath: '/de/jobs-im-zurich/' + slug,
      slug,
      isActiveSlug: isNeverActive,
      isTargetOccupied: isNeverOccupied,
    })).toEqual({
      kind: 'emit',
      path: '/de/jobs-in-zurich/' + slug + '/',
      canonicalizedLegacySection: true,
    });
  });

  it('does not emit a legacy alias when its current-section target is occupied', () => {
    const slug = 'occupied-zurich-role';
    const target = '/de/jobs-in-zurich/' + slug + '/';
    expect(resolveExpiredEmitPath({
      locale: 'de',
      trackedPath: '/de/jobs-im-zurich/' + slug,
      slug,
      isActiveSlug: isNeverActive,
      isTargetOccupied: (path) => path === target,
    })).toEqual({
      kind: 'skip',
      reason: 'unroutable-occupied',
      targetPath: target,
    });
  });

  it('preserves Ticino jobs-im-tessin and ordinary current-section paths', () => {
    expect(resolveExpiredEmitPath({
      locale: 'de',
      trackedPath: '/de/jobs-im-tessin/expired-ti-role',
      slug: 'expired-ti-role',
      isActiveSlug: isNeverActive,
      isTargetOccupied: () => {
        throw new Error('Ticino is not an unroutable legacy section');
      },
    })).toEqual({
      kind: 'emit',
      path: '/de/jobs-im-tessin/expired-ti-role',
      canonicalizedLegacySection: false,
    });

    expect(resolveExpiredEmitPath({
      locale: 'de',
      trackedPath: '/de/jobs-in-zurich/current-format-role',
      slug: 'current-format-role',
      isActiveSlug: isNeverActive,
      isTargetOccupied: isNeverOccupied,
    })).toEqual({
      kind: 'emit',
      path: '/de/jobs-in-zurich/current-format-role',
      canonicalizedLegacySection: false,
    });
  });

  it('does not reinterpret a German-looking tracking path owned by another locale', () => {
    const trackedPath = '/de/jobs-im-zurich/ambiguous-locale-role';
    expect(resolveExpiredEmitPath({
      locale: 'it',
      trackedPath,
      slug: 'ambiguous-locale-role',
      isActiveSlug: isNeverActive,
      isTargetOccupied: () => {
        throw new Error('a non-DE tracking row is not a German alias');
      },
    })).toEqual({ kind: 'emit', path: trackedPath, canonicalizedLegacySection: false });
  });

  it('keeps current-slug ownership global across split-locale rendering', () => {
    const source = readFileSync(
      new URL('../../build-plugins/jobsSeoPagesPlugin.ts', import.meta.url),
      'utf8',
    );
    const start = source.indexOf('const currentSlugs = new Map<string, number>();');
    const end = source.indexOf('const nativeRouteSnapshotSlugs = new Set<string>();', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const activeSlugIndex = source.slice(start, end);
    expect(activeSlugIndex).toContain('for (const locale of localeList)');
    expect(activeSlugIndex).toContain('markCurrentSlug(ls, locale)');
    expect(activeSlugIndex).not.toContain('shouldEmitLocale(locale)');
  });

  it('applies the shared path policy to the main, cross-locale, and self-healing expired emitters', () => {
    const source = readFileSync(
      new URL('../../build-plugins/jobsSeoPagesPlugin.ts', import.meta.url),
      'utf8',
    );
    expect(source.match(/resolveExpiredPathForEmission\(/g)?.length).toBe(3);
    expect(source).toContain('writeSoftLandingPage(relPath.slice(1), softLandingHtml');
    expect(source).toContain('const wroteRelocation = writeSoftLandingPage(');
    expect(source).toContain('const wroteHistorical = writeSoftLandingPage(');
    expect(source).toContain('expiredSkippedActiveSlug=${expiredSkippedActiveSlug}');
    expect(source).toContain('expiredLegacySectionCanonicalized=${expiredLegacySectionCanonicalized}');
  });
});
