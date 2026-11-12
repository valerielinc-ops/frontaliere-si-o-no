import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  pruneSelfHealTracking,
  pruneSelfHealTrackingRow,
} from '../../build-plugins/shared/pruneSelfHealTracking';

const pluginSource = readFileSync(resolve(process.cwd(), 'build-plugins/jobsSeoPagesPlugin.ts'), 'utf8');

describe('self-heal tracking retention', () => {
  it('can progressively prune a row with the same claimed-path rule as the final pass', () => {
    const tracking = {
      alreadyCovered: { it: '/it/jobs/a', de: '/de/jobs/a' },
      stillPending: { it: '/it/jobs/b', de: '/de/jobs/b' },
    };

    expect(pruneSelfHealTrackingRow(tracking, 'alreadyCovered', ['de'], () => true)).toBe(true);
    expect(pruneSelfHealTrackingRow(tracking, 'stillPending', ['de'], () => false)).toBe(false);
    expect(tracking).toEqual({
      stillPending: { it: '/it/jobs/b', de: '/de/jobs/b' },
    });
  });

  it('drops claimed shard rows and preserves every locale path for pending rows', () => {
    const tracking = {
      alreadyEmitted: { it: '/it/jobs/a', de: '/de/jobs/a', fr: '/fr/jobs/a' },
      stillPending: { it: '/it/jobs/b', de: '/de/jobs/b', fr: '/fr/jobs/b' },
      noOwnedLocalePath: { it: '/it/jobs/c', fr: '/fr/jobs/c' },
    };

    const result = pruneSelfHealTracking(
      tracking,
      ['de'],
      (relativePath) => relativePath === '/de/jobs/a',
    );

    expect(result).toEqual({ pruned: 2, retained: 1 });
    expect(tracking).toEqual({
      stillPending: { it: '/it/jobs/b', de: '/de/jobs/b', fr: '/fr/jobs/b' },
    });
  });

  it('keeps a full-locale row when any emitted locale remains unclaimed', () => {
    const tracking = {
      pendingFrenchPath: { it: '/it/jobs/a', de: '/de/jobs/a', fr: '/fr/jobs/a' },
    };

    const result = pruneSelfHealTracking(
      tracking,
      ['it', 'de', 'fr'],
      (relativePath) => relativePath !== '/fr/jobs/a',
    );

    expect(result).toEqual({ pruned: 0, retained: 1 });
    expect(tracking.pendingFrenchPath).toEqual({
      it: '/it/jobs/a',
      de: '/de/jobs/a',
      fr: '/fr/jobs/a',
    });
  });

  it('prunes a large registry without materializing a full keys array', () => {
    const tracking = Object.fromEntries(
      Array.from({ length: 50_000 }, (_, index) => [`slug-${index}`, { de: `/de/jobs/slug-${index}/` }]),
    );
    const objectKeys = vi.spyOn(Object, 'keys');

    try {
      expect(pruneSelfHealTracking(tracking, ['de'], () => true)).toEqual({
        pruned: 50_000,
        retained: 0,
      });
      expect(objectKeys).not.toHaveBeenCalled();
      expect(Object.keys(tracking)).toEqual([]);
    } finally {
      objectKeys.mockRestore();
    }
  });

  it('prunes after expired-path readers and before the previous-slug phase', () => {
    const lastExpiredPathRead = pluginSource.lastIndexOf('tracking[baseSlug]?.[baseLocale]');
    const prune = pluginSource.indexOf('const selfHealTrackingRetention = pruneSelfHealTracking(');
    const previousSlugPhase = pluginSource.indexOf(
      '/* ── Full-content pages for previousSlugs of active jobs',
    );

    expect(lastExpiredPathRead).toBeGreaterThan(-1);
    expect(prune).toBeGreaterThan(lastExpiredPathRead);
    expect(previousSlugPhase).toBeGreaterThan(prune);
  });

  it('releases expired-sweep rows on both sweep exits and preserves cross-locale rows', () => {
    const release = pluginSource.indexOf('const releaseExpiredSweepSlug = (slug: string, expiredSlugIndex: number)');
    const releaseCalls = [...pluginSource.matchAll(/releaseExpiredSweepSlug\(slug, expiredSlugIndex\);/gu)]
      .map((match) => match.index ?? -1);
    const crossLocalePass = pluginSource.indexOf('/* ── Cross-locale reconciliation for expired jobs');
    const retainedCrossLocaleSlugs = pluginSource.indexOf(
      '!progressiveExpiredCrossLocaleSlugs?.has(slug)',
    );

    expect(release).toBeGreaterThan(-1);
    expect(releaseCalls).toHaveLength(2);
    expect(releaseCalls.every((index) => index > release && index < crossLocalePass)).toBe(true);
    expect(retainedCrossLocaleSlugs).toBeGreaterThan(release);
    expect(retainedCrossLocaleSlugs).toBeLessThan(crossLocalePass);
  });

  it('releases native route and tracking indexes after the final self-heal readers', () => {
    const lastNativeRouteReader = pluginSource.lastIndexOf('return nativeJobPathRecoveredByWorker(');
    const nativeRouteRelease = pluginSource.indexOf('nativeJobPrefixByLocaleAndSlug.clear();');
    const lastTrackingReader = pluginSource.lastIndexOf('for (const slug in tracking)', nativeRouteRelease);
    const afterSelfHeal = pluginSource.indexOf("logBuildMem('jobsSeoPages: after-self-heal'");
    const trackingRelease = pluginSource.indexOf('tracking = Object.create(null)', afterSelfHeal);
    const trackingProbeRelease = pluginSource.indexOf('jobsSeoMemContext.tracking = undefined', trackingRelease);

    expect(lastNativeRouteReader).toBeGreaterThan(-1);
    expect(nativeRouteRelease).toBeGreaterThan(lastNativeRouteReader);
    expect(lastTrackingReader).toBeGreaterThan(-1);
    expect(nativeRouteRelease).toBeGreaterThan(lastTrackingReader);
    expect(afterSelfHeal).toBeGreaterThan(nativeRouteRelease);
    expect(trackingRelease).toBeGreaterThan(afterSelfHeal);
    expect(trackingProbeRelease).toBeGreaterThan(trackingRelease);
  });
});
