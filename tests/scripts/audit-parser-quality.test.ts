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
import {
  applyNoStructureRatchet,
  applyDuplicateDescriptionRatchet,
} from '../../scripts/audit-parser-quality.mjs';

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

/**
 * The duplicate-description ratchet escalates a crawler to CRITICAL when
 * ≥80 % of its jobs share the same description AND there are ≥5 jobs.
 *
 * Motivating regression: Moncucco shipped 9/9 jobs with an identical 4 125-char
 * blob (the page nav/megamenu). Thin-description and tag-soup checks all passed
 * because the blob was long, prose-shaped, and unique to that crawler. The only
 * remaining signal was the duplicate ratio, which was previously a WARNING.
 */
function makeDuplicateEntry(dupeCount: number, total: number, severity: Entry['severity'] = 'WARNING'): Entry {
  return {
    total,
    severity,
    issues: [
      {
        type: 'duplicate-descriptions',
        count: dupeCount,
        total,
        message: `${dupeCount}/${total} duplicate descriptions`,
      },
    ],
  };
}

describe('applyDuplicateDescriptionRatchet', () => {
  it('escalates a crawler with 100% duplicate descriptions and >=5 jobs to CRITICAL', () => {
    const report: Record<string, Entry> = {
      'moncucco-style': makeDuplicateEntry(9, 9),
    };

    const regressions = applyDuplicateDescriptionRatchet(report);

    expect(report['moncucco-style'].severity).toBe('CRITICAL');
    expect(regressions).toHaveLength(1);
    expect(regressions[0]).toMatchObject({ key: 'moncucco-style', count: 9, total: 9 });
    expect(regressions[0].ratio).toBeCloseTo(1, 5);
    expect(report['moncucco-style'].issues[0].message).toMatch(/PARSER LIKELY GRABBING CHROME/);
    expect(report['moncucco-style'].action).toMatch(/page chrome/i);
  });

  it('escalates at exactly 80% duplicate ratio with >=5 jobs', () => {
    const report: Record<string, Entry> = {
      'eighty-pct': makeDuplicateEntry(8, 10),
    };

    const regressions = applyDuplicateDescriptionRatchet(report);

    expect(report['eighty-pct'].severity).toBe('CRITICAL');
    expect(regressions).toHaveLength(1);
  });

  it('does NOT escalate below 80% duplicate ratio', () => {
    const report: Record<string, Entry> = {
      'mild-dupes': makeDuplicateEntry(7, 10),
    };

    const regressions = applyDuplicateDescriptionRatchet(report);

    expect(report['mild-dupes'].severity).toBe('WARNING');
    expect(regressions).toHaveLength(0);
  });

  it('does NOT escalate small crawlers (<5 jobs) even at 100% duplicate', () => {
    const report: Record<string, Entry> = {
      'tiny': makeDuplicateEntry(4, 4),
    };

    const regressions = applyDuplicateDescriptionRatchet(report);

    expect(report['tiny'].severity).toBe('WARNING');
    expect(regressions).toHaveLength(0);
  });

  it('skips crawlers with no duplicate-descriptions issue', () => {
    const report: Record<string, Entry> = {
      'no-dupes': { total: 20, severity: 'OK', issues: [] },
    };

    const regressions = applyDuplicateDescriptionRatchet(report);

    expect(report['no-dupes'].severity).toBe('OK');
    expect(regressions).toHaveLength(0);
  });

  it('preserves an existing action prefix when escalating', () => {
    const entry = makeDuplicateEntry(10, 10, 'WARNING');
    entry.action = 'Existing hint.';
    const report: Record<string, Entry> = { 'with-action': entry };

    applyDuplicateDescriptionRatchet(report);

    expect(report['with-action'].action).toMatch(/^Existing hint\. /);
    expect(report['with-action'].action).toMatch(/page chrome/i);
  });
});
