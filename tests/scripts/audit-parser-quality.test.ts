// @vitest-environment node
/**
 * Unit tests for the no-structured-content ratchet exported by
 * scripts/audit-parser-quality.mjs.
 *
 * The ratchet escalates a `no-structured-content` warning to CRITICAL when:
 *   - the crawler is NEW (no baseline entry) AND has >=95% flat AND >=10 jobs
 *   - the crawler EXISTS in baseline AND its current count is HIGHER than the
 *     baseline count
 *
 * Existing crawlers staying at the same count, or improving, must NOT trigger
 * CRITICAL. Crawlers with <10 jobs must NOT trigger CRITICAL even at 100% flat.
 */

import { describe, it, expect } from 'vitest';
import { applyNoStructureRatchet } from '../../scripts/audit-parser-quality.mjs';

type Issue = {
  type: string;
  count: number;
  total: number;
  message: string;
};

type Entry = {
  total: number;
  issues: Issue[];
  severity: 'CRITICAL' | 'WARNING' | 'OK';
  action?: string;
};

function makeEntry(noStructCount: number, total: number, severity: Entry['severity'] = 'WARNING'): Entry {
  return {
    total,
    severity,
    issues: [
      {
        type: 'no-structured-content',
        count: noStructCount,
        total,
        message: `${noStructCount}/${total} no structured content (no bullets/lists)`,
      },
    ],
  };
}

describe('applyNoStructureRatchet', () => {
  it('escalates a NEW crawler with 100% flat and >=10 jobs to CRITICAL', () => {
    const report: Record<string, Entry> = {
      'new-broken': makeEntry(15, 15),
    };
    const baseline = { generatedAt: null, perCrawler: {} };

    const regressions = applyNoStructureRatchet(report, baseline);

    expect(report['new-broken'].severity).toBe('CRITICAL');
    expect(regressions).toHaveLength(1);
    expect(regressions[0]).toMatchObject({ key: 'new-broken', was: 0, now: 15, total: 15 });
    expect(report['new-broken'].issues[0].message).toMatch(/NEW OFFENDER/);
    expect(report['new-broken'].action).toMatch(/audit:parser-quality:rebaseline/);
  });

  it('does NOT escalate an existing crawler whose count is unchanged from baseline', () => {
    const report: Record<string, Entry> = {
      'flat-but-known': makeEntry(132, 132),
    };
    const baseline = {
      generatedAt: '2026-05-06T00:00:00Z',
      perCrawler: { 'flat-but-known': { noStructureCount: 132, total: 132 } },
    };

    const regressions = applyNoStructureRatchet(report, baseline);

    expect(report['flat-but-known'].severity).toBe('WARNING');
    expect(regressions).toHaveLength(0);
  });

  it('escalates an existing crawler whose count INCREASED above baseline to CRITICAL', () => {
    const report: Record<string, Entry> = {
      'regressed': makeEntry(50, 60),
    };
    const baseline = {
      generatedAt: '2026-05-06T00:00:00Z',
      perCrawler: { 'regressed': { noStructureCount: 30, total: 50 } },
    };

    const regressions = applyNoStructureRatchet(report, baseline);

    expect(report['regressed'].severity).toBe('CRITICAL');
    expect(regressions).toHaveLength(1);
    expect(regressions[0]).toMatchObject({ key: 'regressed', was: 30, now: 50 });
    expect(report['regressed'].issues[0].message).toMatch(/REGRESSION: was 30, now 50/);
  });

  it('does NOT escalate a NEW crawler with only 5 jobs at 100% flat', () => {
    const report: Record<string, Entry> = {
      'tiny-crawler': makeEntry(5, 5),
    };
    const baseline = { generatedAt: null, perCrawler: {} };

    const regressions = applyNoStructureRatchet(report, baseline);

    expect(report['tiny-crawler'].severity).toBe('WARNING');
    expect(regressions).toHaveLength(0);
  });

  it('does NOT escalate when the count IMPROVED (went DOWN) vs baseline', () => {
    const report: Record<string, Entry> = {
      'improving': makeEntry(20, 50),
    };
    const baseline = {
      generatedAt: '2026-05-06T00:00:00Z',
      perCrawler: { 'improving': { noStructureCount: 40, total: 50 } },
    };

    const regressions = applyNoStructureRatchet(report, baseline);

    expect(report['improving'].severity).toBe('WARNING');
    expect(regressions).toHaveLength(0);
  });

  it('skips entries that have no no-structured-content issue', () => {
    const report: Record<string, Entry> = {
      'thin-only': {
        total: 10,
        severity: 'WARNING',
        issues: [{ type: 'thin-description', count: 5, total: 10, message: '5/10 thin' }],
      },
    };
    const baseline = { generatedAt: null, perCrawler: {} };

    const regressions = applyNoStructureRatchet(report, baseline);

    expect(report['thin-only'].severity).toBe('WARNING');
    expect(regressions).toHaveLength(0);
  });

  it('does NOT escalate a NEW crawler at 90% flat (below the 95% threshold)', () => {
    const report: Record<string, Entry> = {
      'borderline': makeEntry(9, 10),
    };
    const baseline = { generatedAt: null, perCrawler: {} };

    const regressions = applyNoStructureRatchet(report, baseline);

    expect(report['borderline'].severity).toBe('WARNING');
    expect(regressions).toHaveLength(0);
  });
});
