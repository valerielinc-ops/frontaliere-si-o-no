// @vitest-environment node
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs CLI module, no type declarations
import { diffReports } from '../scripts/verify-l3-report-equivalence.mjs';

/**
 * `verify-l3` compares the legacy per-audit reports with the ones `audit:all`
 * writes, and its `byFeature` check reads a missing key as 0. That holds only
 * while a breakdown is complete. `spa-bundle-injection` folds the tail of its
 * breakdown into `<other>` past GROUP_CAP (#7679), and from that moment:
 *
 *   • the two `<other>` buckets cover different directory sets — comparing
 *     them is arithmetic over non-homologous populations, and against an
 *     unfolded side there is no `<other>` at all, so `?? 0` reports the entire
 *     fold as a divergence;
 *   • a key absent from a folded side is "0 OR inside that side's `<other>`",
 *     which the report cannot disambiguate.
 *
 * Neither is a legacy-vs-unified divergence, so neither may fail the run.
 * These pin that, and pin that a complete breakdown still fails on a real one.
 */
describe('verify-l3 byFeature comparison is fold-aware', () => {
  const report = (byFeature: Record<string, number>, extra: Record<string, unknown> = {}) => ({
    audit: 'spa-bundle-injection',
    ranAt: '2026-09-06T00:00:00.000Z',
    passed: true,
    offendersTotal: 3,
    byFeature,
    topOffenders: [],
    ...extra,
  });

  it('does not compare the two overflow buckets when both sides are folded', () => {
    const { issues, notes } = diffReports(
      report({ 'a/b': 1, '<other>': 400 }, { byFeatureTruncated: true }),
      report({ 'a/b': 1, '<other>': 900 }, { byFeatureTruncated: true }),
    );
    expect(issues).toEqual([]);
    expect(notes.join('\n')).toContain('<other>');
  });

  it('does not report the whole fold as a divergence against an unfolded side', () => {
    const { issues } = diffReports(
      report({ 'a/b': 1 }),
      report({ 'a/b': 1, '<other>': 900 }, { byFeatureTruncated: true }),
    );
    expect(issues).toEqual([]);
  });

  it('does not read a key missing from a folded side as 0', () => {
    const { issues, notes } = diffReports(
      report({ 'a/b': 1 }, { byFeatureTruncated: true }),
      report({ 'a/b': 1, 'c/d': 7 }),
    );
    expect(issues).toEqual([]);
    expect(notes.join('\n')).toContain('c/d');
  });

  it('still fails on a real per-key divergence between complete breakdowns', () => {
    const { issues } = diffReports(report({ 'a/b': 1, 'c/d': 2 }), report({ 'a/b': 1, 'c/d': 5 }));
    expect(issues).toEqual(['byFeature["c/d"]: legacy=2 current=5']);
  });

  it('still reads a missing key as 0 when neither breakdown is folded', () => {
    const { issues } = diffReports(report({ 'a/b': 1 }), report({ 'a/b': 1, 'c/d': 3 }));
    expect(issues).toEqual(['byFeature["c/d"]: legacy=0 current=3']);
  });

  it('still compares keys present on both sides while one is folded', () => {
    const { issues } = diffReports(
      report({ 'a/b': 2, '<other>': 400 }, { byFeatureTruncated: true }),
      report({ 'a/b': 9 }),
    );
    expect(issues).toEqual(['byFeature["a/b"]: legacy=2 current=9']);
  });

  it('detects a fold declared only by the presence of the overflow key', () => {
    const { issues } = diffReports(report({ 'a/b': 1, '<other>': 400 }), report({ 'a/b': 1, 'c/d': 7 }));
    expect(issues).toEqual([]);
  });
});
