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
  hasFormChrome,
} from '../../scripts/audit-parser-quality.mjs';

type Issue = {
  type: string;
  count: number;
  total: number;
  message: string;
  hidden?: boolean;
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
 * The duplicate-description ratchet now distinguishes two signals:
 *   1. `duplicate-descriptions` (title-aware fingerprint, ≥80%) — real source
 *      duplicates: same title AND same body across multiple records.
 *   2. `duplicate-descriptions-desc-only` (chrome fingerprint, ≥95%) — chrome
 *      scraping: identical bodies across records with distinct titles.
 *
 * Motivating regression: Moncucco shipped 9/9 jobs with an identical 4 125-char
 * blob (the page nav/megamenu). The titles WERE distinct, so this is the chrome
 * case — both signals would have fired, but in a real run the chrome signal is
 * the one we want surfaced (the action item is "fix the parser selectors", not
 * "dedupe duplicate listings"). Tests below set both signals when simulating
 * the moncucco case to verify chrome-scraping detection still works.
 */
function makeDuplicateEntry(dupeCount: number, total: number, severity: Entry['severity'] = 'WARNING', kind: 'chrome' | 'listings' = 'chrome'): Entry {
  // Default to chrome-style: distinct titles, identical bodies. Only the
  // hidden desc-only signal fires; the visible duplicate-descriptions issue
  // is synthesized by the ratchet itself when chrome is detected.
  const issues: Entry['issues'] = [];
  if (kind === 'listings') {
    issues.push({
      type: 'duplicate-descriptions',
      count: dupeCount,
      total,
      message: `${dupeCount}/${total} duplicate descriptions`,
    });
  } else {
    issues.push({
      type: 'duplicate-descriptions-desc-only',
      count: dupeCount,
      total,
      message: '',
      hidden: true,
    });
  }
  return {
    total,
    severity,
    issues,
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
    expect(regressions[0]).toMatchObject({ key: 'moncucco-style', count: 9, total: 9, kind: 'chrome-scraping' });
    expect(regressions[0].ratio).toBeCloseTo(1, 5);
    // The chrome path synthesizes a visible duplicate-descriptions issue and
    // appends the chrome warning to its message. The original hidden chrome
    // signal stays in issues[0]; the visible message is the non-hidden one.
    const visible = report['moncucco-style'].issues.find((i) => !i.hidden);
    expect(visible?.message).toMatch(/PARSER LIKELY GRABBING CHROME/);
    expect(report['moncucco-style'].action).toMatch(/page chrome/i);
  });

  it('escalates at exactly 80% duplicate ratio with >=5 jobs (title-aware listings signal)', () => {
    // 80% is the threshold for the title-aware "duplicate listings" signal,
    // which catches feeds publishing the same role multiple times (bitfinex
    // posts each opening 9× via Recruitee). Chrome scraping uses a stricter
    // 95% threshold to avoid false-positives on legitimately templated
    // sources (reboot-monkey: 142 city-specific listings sharing a template).
    const report: Record<string, Entry> = {
      'eighty-pct': makeDuplicateEntry(8, 10, 'WARNING', 'listings'),
    };

    const regressions = applyDuplicateDescriptionRatchet(report);

    expect(report['eighty-pct'].severity).toBe('CRITICAL');
    expect(regressions).toHaveLength(1);
    expect(regressions[0].kind).toBe('duplicate-listings');
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

  it('does NOT false-positive on templated sources (chrome signal between 80% and 95%)', () => {
    // reboot-monkey case: 142 city-specific data-center-technician listings
    // sharing a templated body. Title-aware fingerprint dropped the duplicate
    // ratio from 90% to 41% (each city → distinct title). The chrome signal
    // (desc-only) is still ~90%, but a templated parser should not be flagged
    // as chrome scraping unless duplicates are essentially universal (≥95%).
    const report: Record<string, Entry> = {
      'templated-source': {
        total: 142,
        severity: 'WARNING',
        issues: [
          { type: 'duplicate-descriptions', count: 58, total: 142, message: '58/142 duplicate descriptions' },
          { type: 'duplicate-descriptions-desc-only', count: 128, total: 142, message: '', hidden: true },
        ],
      },
    };

    const regressions = applyDuplicateDescriptionRatchet(report);

    expect(report['templated-source'].severity).toBe('WARNING');
    expect(regressions).toHaveLength(0);
  });
});

describe('hasFormChrome', () => {
  // Each pattern came from the 2026-05-18 Centiel After-Sales Technician
  // regression: the regex-split parser ran past the last accordion and
  // swept in WordPress Contact Form 7 widget HTML + footer chrome.
  it('flags the wpcf7 form-control class', () => {
    expect(hasFormChrome('Some text wpcf7-form-control here')).toBe(true);
  });

  it('flags the privacy-checkbox label verbatim', () => {
    expect(hasFormChrome('I agree to the treatment of my personal information.')).toBe(true);
  });

  it('flags the exact CV-upload field label', () => {
    expect(hasFormChrome('Attachment: CV in PDF format, maximum weight 3 Mb')).toBe(true);
  });

  it('flags the "A brief presentation *" placeholder', () => {
    expect(hasFormChrome('A brief presentation *')).toBe(true);
  });

  it('flags the CORPORATE ENQUIRIES footer block', () => {
    expect(hasFormChrome('CORPORATE ENQUIRIES Media & Investor Enquiries')).toBe(true);
  });

  it('does NOT flag legitimate apply-instruction copy from a role PDF', () => {
    // The Centiel role PDFs all end with this sentence. It is legitimate
    // role content (the apply-to address) and must not trigger the chrome
    // signal — that would force a parser fix where none is needed.
    const pdfTail = 'If you identify with this role, please send your application, indicating "After-Sales Technician" in the subject line, to: hr@hq.centiel.com';
    expect(hasFormChrome(pdfTail)).toBe(false);
  });

  it('does NOT flag a generic role description', () => {
    const desc = 'We are looking for a Senior Engineer to join our team in Lugano. Responsibilities include designing systems, reviewing code, and mentoring junior engineers.';
    expect(hasFormChrome(desc)).toBe(false);
  });
});
