import { describe, expect, it } from 'vitest';
import { planJanitor } from '@/scripts/ci/cdn-prune-plan.mjs';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Guards the CDN janitor's prune decision (planJanitor). The bug this fixes:
 * after the stable-name cutover (#1933) the build emits locale-qualified blog
 * chunks (`slug.it.js`), which live in a DIFFERENT chunk-name group than the
 * pre-cutover legacy `slug-<hash>.js` / `slug2-<hash>.js`. The old
 * "superseded-sibling" heuristic therefore never GC'd those hashed files →
 * 16 k orphans / 1.7 GB breaching the GitHub Pages soft limit. The lastActive
 * model below prunes them purely on "absent from the active set past grace".
 */
describe('planJanitor', () => {
  const NOW_MS = Date.UTC(2026, 5, 14, 12, 0, 0);
  const now = iso(NOW_MS);
  const graceCutoffMs = NOW_MS - 7 * DAY; // 7-day grace
  const old = iso(NOW_MS - 30 * DAY); // well past grace
  const recent = iso(NOW_MS - 1 * DAY); // within grace

  const base = { now, graceCutoffMs, maxPrune: 6000 };

  it('prunes legacy hashed orphans absent from the active set past grace', () => {
    const active = new Set(['slug.it.js', 'slug.en.js', 'App.js']);
    const registry: Record<string, any> = {
      'slug-AbCdEf12.js': old, // legacy hashed (it), pre-cutover — orphan
      'slug2-Gh34Ij56.js': old, // legacy hashed (en) — orphan
      'slug.it.js': { f: old, a: old }, // current stable, in active set
      'slug.en.js': { f: old, a: old },
      'App.js': { f: old, a: old },
    };
    const allAssets = Object.keys(registry);
    const r = planJanitor({
      ...base, allAssets, registry,
      isActive: (f: string) => active.has(f), canPrune: true,
    });
    expect(r.toPrune.sort()).toEqual(['slug-AbCdEf12.js', 'slug2-Gh34Ij56.js']);
    // active stable files refresh lastActive, never pruned
    expect(registry['slug.it.js'].a).toBe(now);
  });

  it('NEVER prunes a file in the active set, even if its lastActive looks old', () => {
    const active = new Set(['vendor-charts.js']); // a lazy chunk present in dist
    const registry: Record<string, any> = { 'vendor-charts.js': { f: old, a: old } };
    const r = planJanitor({
      ...base, allAssets: ['vendor-charts.js'], registry,
      isActive: (f: string) => active.has(f), canPrune: true,
    });
    expect(r.toPrune).toEqual([]);
  });

  it('keeps inactive files still within the grace window (in-flight HTML safety)', () => {
    const registry: Record<string, any> = { 'gone-recent.js': { f: recent, a: recent } };
    const r = planJanitor({
      ...base, allAssets: ['gone-recent.js'], registry,
      isActive: () => false, canPrune: true,
    });
    expect(r.toPrune).toEqual([]);
  });

  it('FAIL-CLOSED: prunes nothing when canPrune is false (dist/assets absent)', () => {
    const registry: Record<string, any> = { 'orphan-old.js': old };
    const r = planJanitor({
      ...base, allAssets: ['orphan-old.js'], registry,
      isActive: () => false, canPrune: false,
    });
    expect(r.toPrune).toEqual([]);
  });

  it('migrates legacy string entries to {f,a} and registers new files', () => {
    const registry: Record<string, any> = { 'App.js': old }; // legacy string form
    const r = planJanitor({
      ...base, allAssets: ['App.js', 'New.js'], registry,
      isActive: (f: string) => f === 'App.js' || f === 'New.js', canPrune: true,
    });
    expect(registry['App.js']).toEqual({ f: old, a: now }); // migrated + refreshed (active)
    expect(registry['New.js']).toEqual({ f: now, a: now });
    expect(r.newCount).toBe(1);
    expect(r.toPrune).toEqual([]);
  });

  it('drops registry entries for files no longer on the CDN', () => {
    const registry: Record<string, any> = {
      'App.js': { f: old, a: old },
      'deleted.js': { f: old, a: old }, // not in allAssets anymore
    };
    const r = planJanitor({
      ...base, allAssets: ['App.js'], registry,
      isActive: (f: string) => f === 'App.js', canPrune: true,
    });
    expect(Object.keys(registry)).toEqual(['App.js']);
    expect(r.registryPruned).toBe(1);
  });

  it('caps the prune set at maxPrune, oldest-inactive first', () => {
    const registry: Record<string, any> = {
      'a.js': { f: old, a: iso(NOW_MS - 30 * DAY) },
      'b.js': { f: old, a: iso(NOW_MS - 20 * DAY) },
      'c.js': { f: old, a: iso(NOW_MS - 10 * DAY) },
    };
    const r = planJanitor({
      ...base, maxPrune: 2, allAssets: ['a.js', 'b.js', 'c.js'], registry,
      isActive: () => false, canPrune: true,
    });
    expect(r.eligible).toBe(3);
    expect(r.toPrune).toEqual(['a.js', 'b.js']); // oldest two
  });
});
