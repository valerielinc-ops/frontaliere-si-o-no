import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WriteCollector } from '../../build-plugins/batchWrite';
import {
  hasClaimedPath,
  reserveJobAliasRedirectDir,
  reset as resetWriteRegistry,
} from '../../build-plugins/sharedWriteRegistry';
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

  it('treats a reserved alias as claimed so self-heal cannot enqueue a tombstone', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-alias-reserved-'));
    const distDir = path.join(root, 'dist');
    const pageDir = path.join(distDir, 'de', 'jobs-in-zurich', 'old-route');
    const indexPath = path.join(pageDir, 'index.html');
    const collector = new WriteCollector({ distDir, pluginName: 'self-heal-fixture' });
    try {
      reserveJobAliasRedirectDir(pageDir);
      const relativePath = '/de/jobs-in-zurich/old-route';
      const selfHealTrackingPathClaimed = hasClaimedPath(
        path.join(distDir, relativePath.replace(/^\/+/, ''), 'index.html'),
      );
      expect(selfHealTrackingPathClaimed).toBe(true);
      if (!selfHealTrackingPathClaimed) collector.add(indexPath, '<html>noindex tombstone</html>');
      await collector.flush();
      expect(fs.existsSync(indexPath)).toBe(false);
    } finally {
      resetWriteRegistry();
      fs.rmSync(root, { recursive: true, force: true });
    }
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
      '/* ── Retained full-content pages for previousSlugs',
    );

    expect(lastExpiredPathRead).toBeGreaterThan(-1);
    expect(prune).toBeGreaterThan(lastExpiredPathRead);
    expect(previousSlugPhase).toBeGreaterThan(prune);
    expect(pluginSource).toContain('const isSelfHealTrackingPathClaimed = (relativePath: string): boolean => pathWasClaimed(');
    expect(pluginSource).toContain('if (pathWasClaimed(absFile)) continue;');
  });

  it('releases expired-sweep rows on every sweep exit and preserves cross-locale rows', () => {
    const release = pluginSource.indexOf('const releaseExpiredSweepSlug = (slug: string, expiredSlugIndex: number)');
    const releaseCalls = [...pluginSource.matchAll(/releaseExpiredSweepSlug\(slug, expiredSlugIndex\);/gu)]
      .map((match) => match.index ?? -1);
    const noResolvedLocalePaths = pluginSource.indexOf('if (!localeList.some((locale) => paths[locale])) {');
    const noResolvedLocaleRelease = pluginSource.indexOf(
      'releaseExpiredSweepSlug(slug, expiredSlugIndex);',
      noResolvedLocalePaths,
    );
    const noResolvedLocaleDrain = pluginSource.indexOf(
      'await drainExpiredSweepSlot(expiredSlugIndex);',
      noResolvedLocaleRelease,
    );
    const crossLocalePass = pluginSource.indexOf('/* ── Cross-locale reconciliation for expired jobs');
    const retainedCrossLocaleSlugs = pluginSource.indexOf(
      '!progressiveExpiredCrossLocaleSlugs?.has(slug)',
    );

    expect(release).toBeGreaterThan(-1);
    // The third release handles rows whose every locale path was filtered by
    // the expired-emission policy before rendering. It runs before the shared
    // cross-locale pass, while the release helper still retains cross-locale rows.
    expect(releaseCalls).toHaveLength(3);
    expect(noResolvedLocaleRelease).toBeGreaterThan(noResolvedLocalePaths);
    expect(noResolvedLocaleDrain).toBeGreaterThan(noResolvedLocaleRelease);
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
