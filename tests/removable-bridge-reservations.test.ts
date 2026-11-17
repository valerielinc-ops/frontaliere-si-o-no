import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  explainUnsafeDistPath,
  getSafeDistPageTargets,
  MAX_DIST_PATH_BYTES,
  MAX_FILESYSTEM_SEGMENT_BYTES,
} from '../build-plugins/shared/distPathSafety';
import {
  assertRemovableBridgeSkipThreshold,
  MAX_UNSAFE_REMOVABLE_BRIDGE_SKIPS,
  planRemovableBridgeReservations,
  type RemovableBridgeCandidate,
} from '../build-plugins/shared/removableBridgeReservations';

describe('explainUnsafeDistPath', () => {
  it('explains URL and target failures using the same result as the directory-only preflight', () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'removable-bridge-safety-'));
    const overlongDistDir = path.resolve(
      os.tmpdir(),
      ...Array.from({ length: 17 }, () => 'd'.repeat(235)),
    );
    const samples = [
      { distDir, pathname: '/de/jobs/ordinary/' },
      { distDir, pathname: `/${'x'.repeat(MAX_FILESYSTEM_SEGMENT_BYTES + 1)}/` },
      { distDir, pathname: `/${'x'.repeat(MAX_DIST_PATH_BYTES + 1)}/` },
      { distDir, pathname: '/foo/.env/' },
      { distDir, pathname: '/foo/%zz/' },
      { distDir, pathname: `/${'x'.repeat(251)}/` },
      { distDir: overlongDistDir, pathname: '/safe/' },
    ];

    try {
      expect(explainUnsafeDistPath(distDir, '/de/jobs/ordinary/')).toEqual([]);
      expect(explainUnsafeDistPath(
        distDir,
        `/${'x'.repeat(MAX_FILESYSTEM_SEGMENT_BYTES + 1)}/`,
      )).toContain('path-over-filesystem-limits');
      expect(explainUnsafeDistPath(
        distDir,
        `/${'x'.repeat(MAX_DIST_PATH_BYTES + 1)}/`,
      )).toContain('path-over-filesystem-limits');
      expect(explainUnsafeDistPath(distDir, '/foo/.env/')).toContain('unsafe-compat-path');
      expect(explainUnsafeDistPath(distDir, '/foo/%zz/')).toContain('unsafe-compat-path');
      expect(explainUnsafeDistPath(overlongDistDir, '/safe/')).toEqual(expect.arrayContaining([
        'target-directory-unsafe',
        'target-index-unsafe',
      ]));

      for (const sample of samples) {
        expect(explainUnsafeDistPath(sample.distDir, sample.pathname).length === 0)
          .toBe(getSafeDistPageTargets(sample.distDir, sample.pathname, { includeFlat: false }) !== null);
      }
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  });
});

describe('planRemovableBridgeReservations', () => {
  it('reserves safe emitted paths, records unsafe paths, preserves counts, and ignores non-emitted locales', () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'removable-bridge-plan-'));
    const bridges: RemovableBridgeCandidate[] = [
      { path: '/en/jobs/old-one/', locale: 'en', kind: 'previousSlug' },
      { path: `/${'x'.repeat(MAX_FILESYSTEM_SEGMENT_BYTES + 1)}/`, locale: 'en', kind: 'previousSlug' },
      { path: '/fr/jobs/old-two/', locale: 'fr', kind: 'legacyTiMirror' },
      { path: '/de/jobs/old-three/', locale: 'de', kind: 'crossLocale' },
    ];
    const removable = new Set(bridges.map(({ path: bridgePath }) => bridgePath));

    try {
      const plan = planRemovableBridgeReservations({
        distDir,
        bridges,
        removable,
        shouldEmitLocale: (locale) => locale !== 'de',
      });

      expect(plan.reservations.map(({ path: bridgePath }) => bridgePath)).toEqual([
        '/en/jobs/old-one/',
        '/fr/jobs/old-two/',
      ]);
      expect(plan.reservations.every(({ directoryPath }) => directoryPath.startsWith(distDir))).toBe(true);
      expect(plan.skipped).toEqual([{
        path: bridges[1].path,
        locale: 'en',
        kind: 'previousSlug',
        reasons: ['path-over-filesystem-limits'],
      }]);
      expect([...plan.removableCountsByLocale.entries()].sort()).toEqual([
        ['de', 1],
        ['en', 2],
        ['fr', 1],
      ]);
      expect([...plan.removableCountsByKind.entries()].sort()).toEqual([
        ['crossLocale', 1],
        ['legacyTiMirror', 1],
        ['previousSlug', 2],
      ]);
      expect(plan.emittedRemovableCount).toBe(3);
      expect(fs.readdirSync(distDir)).toEqual([]);
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  });

  it('fails above the absolute or 2% threshold with the count and first ten paths', () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'removable-bridge-threshold-'));
    try {
      const absoluteLimitPaths = Array.from(
        { length: MAX_UNSAFE_REMOVABLE_BRIDGE_SKIPS + 1 },
        (_, index) => `/${String(index).padStart(4, '0')}-${'x'.repeat(MAX_FILESYSTEM_SEGMENT_BYTES)}/`,
      );
      const absoluteLimitBridges = absoluteLimitPaths.map((bridgePath) => ({
        path: bridgePath,
        locale: 'en',
        kind: 'previousSlug',
      }));
      const absoluteLimitPlan = planRemovableBridgeReservations({
        distDir,
        bridges: absoluteLimitBridges,
        removable: new Set(absoluteLimitPaths),
        shouldEmitLocale: () => true,
      });
      let absoluteLimitError: Error | undefined;
      try {
        assertRemovableBridgeSkipThreshold(absoluteLimitPlan);
      } catch (error) {
        absoluteLimitError = error as Error;
      }
      expect(absoluteLimitError?.message).toContain(`${MAX_UNSAFE_REMOVABLE_BRIDGE_SKIPS + 1} removable bridge paths`);
      expect(absoluteLimitError?.message).toContain(absoluteLimitPaths[0]);
      expect(absoluteLimitError?.message).toContain(absoluteLimitPaths[9]);
      expect(absoluteLimitError?.message).toContain('[path-over-filesystem-limits]');

      const relativeThresholdBridges = Array.from({ length: 100 }, (_, index) => ({
        path: index < 3
          ? `/${'y'.repeat(MAX_FILESYSTEM_SEGMENT_BYTES + 1)}-${index}/`
          : `/safe/${index}/`,
        locale: 'it',
        kind: 'legacyTiMirror',
      }));
      const relativeThresholdPlan = planRemovableBridgeReservations({
        distDir,
        bridges: relativeThresholdBridges,
        removable: new Set(relativeThresholdBridges.map(({ path: bridgePath }) => bridgePath)),
        shouldEmitLocale: () => true,
      });
      let relativeThresholdError: Error | undefined;
      try {
        assertRemovableBridgeSkipThreshold(relativeThresholdPlan);
      } catch (error) {
        relativeThresholdError = error as Error;
      }
      expect(relativeThresholdError?.message).toContain('3 removable bridge paths');
      expect(relativeThresholdError?.message).toContain(relativeThresholdBridges[0].path);
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  });

  it('allows a skip below both thresholds', () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'removable-bridge-below-threshold-'));
    const bridges = Array.from({ length: 100 }, (_, index) => ({
      path: index === 0
        ? `/${'z'.repeat(MAX_FILESYSTEM_SEGMENT_BYTES + 1)}/`
        : `/safe/${index}/`,
      locale: 'it',
      kind: 'crossLocale',
    }));
    try {
      const plan = planRemovableBridgeReservations({
        distDir,
        bridges,
        removable: new Set(bridges.map(({ path: bridgePath }) => bridgePath)),
        shouldEmitLocale: () => true,
      });
      expect(plan.skipped).toHaveLength(1);
      expect(() => assertRemovableBridgeSkipThreshold(plan)).not.toThrow();
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  });
});
