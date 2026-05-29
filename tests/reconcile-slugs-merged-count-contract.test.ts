import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error — .mjs ESM module, no type declarations
import { reconcileOrphanSlugs, reconcileExpiredSlugs } from '../scripts/reconcile-job-slugs.mjs';

const root = path.resolve(__dirname, '..');

// Regression guard for the silently-dead writeJson gate in
// assemble-jobs-dataset.mjs: the reconcile functions return `mergedCount`,
// but the assemble caller read `orphanResult.merged` / `expResult.merged`
// (always undefined → `undefined > 0` false), so the post-reconcile
// writeJson(DATA_JOBS/PUBLIC_JOBS) never fired and the merged previousSlugs
// (the redirect bridge for indexed orphan/expired slugs) were never persisted
// to the canonical dataset. previousSlugs preservation is funnel-critical:
// without it, previously-indexed job URLs 404 instead of bridging.

describe('reconcile slug functions — mergedCount return contract', () => {
  it('reconcileOrphanSlugs returns numeric `mergedCount`, never `merged`', () => {
    const res = reconcileOrphanSlugs([], [], {}, { dryRun: true });
    expect(typeof res.mergedCount).toBe('number');
    expect('merged' in res).toBe(false);
  });

  it('reconcileExpiredSlugs returns numeric `mergedCount`, never `merged`', () => {
    const res = reconcileExpiredSlugs([], [], { dryRun: true });
    expect(typeof res.mergedCount).toBe('number');
    expect('merged' in res).toBe(false);
  });
});

describe('assemble-jobs-dataset reconcile guards read the correct property', () => {
  const source = fs.readFileSync(
    path.resolve(root, 'scripts/assemble-jobs-dataset.mjs'),
    'utf-8',
  );

  it('gates the post-reconcile writeJson on `.mergedCount`, not `.merged`', () => {
    expect(source).toContain('orphanResult.mergedCount > 0');
    expect(source).toContain('expResult.mergedCount > 0');
    // The dead-gate property must not reappear on either result object.
    expect(source).not.toMatch(/orphanResult\.merged\b(?!Count)/);
    expect(source).not.toMatch(/expResult\.merged\b(?!Count)/);
  });
});
