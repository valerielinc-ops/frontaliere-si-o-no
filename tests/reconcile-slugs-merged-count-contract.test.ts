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

// The early-return path (above) and the main-loop path return distinct object
// literals (reconcile-job-slugs.mjs:495 vs :619, :693 vs :808). The static
// guard in the assemble file only covers the caller, not the function's return
// shape — so a regression that adds a `merged` alias next to `mergedCount` on
// the main-loop literal would slip past both. These cases drive non-empty input
// through the loop and assert the main-loop return contract directly.
describe('reconcile slug functions — main-loop return contract (non-empty input)', () => {
  it('reconcileOrphanSlugs merges a high-Jaccard orphan and returns numeric `mergedCount`, no `merged`', () => {
    // 4-token active slug vs 3-token orphan subset → Jaccard 3/4 = 0.75 ≥ 0.70
    // (no recognizable companyKey in the slug → full-set scan, threshold 0.70).
    const activeJobs = [
      {
        slug: 'elettricista-cantiere-notturno-rotazione',
        company: 'Test Co',
        companyKey: 'testco',
        slugByLocale: { it: 'elettricista-cantiere-notturno-rotazione' },
        titleByLocale: { it: 'Elettricista di cantiere' },
      },
    ];
    const res = reconcileOrphanSlugs(activeJobs, ['elettricista-cantiere-notturno'], [], { dryRun: false });
    expect(res.mergedCount).toBe(1);
    expect('merged' in res).toBe(false);
    // The merge must be applied in place — this is the previousSlugs bridge.
    expect(activeJobs[0].previousSlugs).toContain('elettricista-cantiere-notturno');
  });

  it('reconcileExpiredSlugs reaches the main-loop return with non-empty input — numeric `mergedCount`, no `merged`', () => {
    const activeJobs = [
      {
        slug: 'magazziniere-turni-deposito-regionale',
        company: 'Test Co',
        companyKey: 'testco',
        slugByLocale: { it: 'magazziniere-turni-deposito-regionale' },
        titleByLocale: { it: 'Magazziniere' },
      },
    ];
    const expiredJobs = [
      { slug: 'contabile-clienti-fatturazione-estero', titleByLocale: { it: 'Contabile clienti' } },
    ];
    const res = reconcileExpiredSlugs(activeJobs, expiredJobs, { dryRun: false });
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
