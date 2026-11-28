import { describe, expect, it } from 'vitest';
import { dryRunExitCode, summarizeDryRun } from '../scripts/ci/summarize-backfill-dry-run.mjs';
import { compareRouteSnapshots } from '../scripts/backfill-expired-from-history.mjs';

const owners = (entries: Record<string, string[]>) => new Map(
  Object.entries(entries).map(([route, ids]) => [route, new Set(ids)]),
);

describe('backfill dry-run route comparison', () => {
  it('counts a route served before and not after as lost, never a restored one', () => {
    const result = compareRouteSnapshots(
      owners({ 'it:kept': ['a'], 'it:gone': ['a'] }),
      owners({ 'it:kept': ['a'], 'de:new': ['b'] }),
    );
    expect(result.lost).toEqual(['it:gone']);
    expect(result.ownerChanged).toEqual([]);
    expect(result.restoredByLocale).toEqual({ de: 1 });
  });

  it('flags a route whose owner changed', () => {
    const result = compareRouteSnapshots(owners({ 'it:x': ['a'] }), owners({ 'it:x': ['b'] }));
    expect(result.ownerChanged).toEqual(['it:x']);
  });

  it('keeps an owner that gained an extra owner unchanged', () => {
    const result = compareRouteSnapshots(owners({ 'it:x': ['a'] }), owners({ 'it:x': ['a', 'b'] }));
    expect(result.ownerChanged).toEqual([]);
  });
});

describe('summarize-backfill-dry-run', () => {
  const clean = { crawlerKey: 'a', restoredByLocale: { it: 2 }, lost: [], ownerChanged: [], maxRssMb: 10 };

  it('aggregates per-locale restorations, refusals and log evidence', () => {
    const summary = summarizeDryRun([
      clean,
      { crawlerKey: 'b', refused: true, refusedRoutes: 3, collisions: 3, unrestoredLegitimateRoutes: 4, maxRssMb: 20 },
    ], 'x\n::error::f.json: refusing to write the archive, 1 route\n[heap] phase: peak heap 5 MB\n');
    expect(summary.totals.restoredByLocale).toEqual({ it: 2 });
    expect(summary.totals.refusedCrawlers).toEqual(['b']);
    expect(summary.totals.unrestoredLegitimateRoutes).toBe(4);
    expect(summary.totals.maxRssMb).toBe(20);
    expect(summary.refusalLogLines).toHaveLength(1);
    expect(summary.heapLines).toHaveLength(1);
    expect(dryRunExitCode(summary)).toBe(0);
  });

  it('fails when a route is lost or an owner changed', () => {
    expect(dryRunExitCode(summarizeDryRun([{ ...clean, lost: ['it:x'] }]))).toBe(1);
    expect(dryRunExitCode(summarizeDryRun([{ ...clean, ownerChanged: ['it:x'] }]))).toBe(1);
  });

  it('marks the run incomplete and fails acceptance when a requested crawler left no report', () => {
    const summary = summarizeDryRun([clean], '', ['a', 'b']);
    expect(summary.complete).toBe(false);
    expect(summary.missingCrawlers).toEqual(['b']);
    expect(dryRunExitCode(summary)).toBe(1);
  });

  it('is complete when every requested crawler reported', () => {
    const summary = summarizeDryRun([clean], '', ['a']);
    expect(summary.complete).toBe(true);
    expect(dryRunExitCode(summary)).toBe(0);
  });
});
