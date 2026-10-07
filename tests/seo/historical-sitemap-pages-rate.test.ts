import { describe, expect, it } from 'vitest';
import { readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HISTORICAL_TOLERANCE_LIMITS,
  HISTORICAL_SITEMAP_CHECKS,
  evaluateHistoricalCorpusRate,
  readHistoricalCorpusLedgerOrNull,
} from '../../scripts/lib/historicalCorpusRate.mjs';

const VALIDATOR_SOURCE = readFileSync(
  new URL('../../scripts/validate-sitemap-pages.mjs', import.meta.url),
  'utf8',
);

function ledgerFor(check: string, ceilingRatePct = 1) {
  const checks = Object.fromEntries(
    HISTORICAL_SITEMAP_CHECKS.map((name) => [name, {
      ceilingRatePct,
      measurement: { filesScanned: 1_000, observedOffenders: 10 },
    }]),
  );
  checks[check] = {
    ceilingRatePct,
    measurement: { filesScanned: 1_000, observedOffenders: 10 },
  };
  return { version: 1, checks };
}

describe('validate:sitemap-pages historical corpus rate gate', () => {
  it('keeps source and local validation at strict zero tolerance', () => {
    const verdict = evaluateHistoricalCorpusRate({
      check: 'validate:canonical',
      offenders: 1,
      filesScanned: 100,
      historicalCorpus: false,
      ledger: ledgerFor('validate:canonical'),
    });

    expect(verdict.historicalCorpus).toBe(false);
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toBe('source/local validation');
  });

  it('passes the sealed historical draw and prints its measured rate', () => {
    const verdict = evaluateHistoricalCorpusRate({
      check: 'audit:sitemap-canonicals',
      offenders: 10,
      filesScanned: 1_000,
      historicalCorpus: true,
      ledger: ledgerFor('audit:sitemap-canonicals'),
    });

    expect(verdict.passed).toBe(true);
    expect(verdict.ratcheted).toBe(true);
    expect(verdict.ratePct).toBe(1);
    expect(verdict.humanSummary).toContain('1.000000%');
    expect(verdict.humanSummary).toContain('ceiling 1.000000%');
  });

  it('fails a systemic historical rate regression', () => {
    const verdict = evaluateHistoricalCorpusRate({
      check: 'validate:content-quality',
      offenders: 11,
      filesScanned: 1_000,
      historicalCorpus: true,
      ledger: ledgerFor('validate:content-quality'),
    });

    expect(verdict.passed).toBe(false);
    expect(verdict.regression).toBe(true);
    expect(verdict.humanSummary).toContain('REGRESSION');
  });

  it('fails closed when the ledger is unavailable or the population is empty', () => {
    const missingLedger = evaluateHistoricalCorpusRate({
      check: 'validate:canonical',
      offenders: 0,
      filesScanned: 100,
      historicalCorpus: true,
      ledger: null,
    });
    expect(missingLedger.passed).toBe(false);
    expect(missingLedger.historicalCorpus).toBe(false);
    expect(missingLedger.measured).toBe(false);
    expect(missingLedger.reason).toBe('historical ledger unavailable');

    const emptyPopulation = evaluateHistoricalCorpusRate({
      check: 'validate:canonical',
      offenders: 0,
      filesScanned: 0,
      historicalCorpus: true,
      ledger: ledgerFor('validate:canonical'),
    });
    expect(emptyPopulation.passed).toBe(false);
    expect(emptyPopulation.measured).toBe(false);
    expect(emptyPopulation.reason).toBe('empty historical population');
  });

  it('rejects ceilings and permissive tolerance values outside safe bounds', () => {
    const invalidEntries = [
      ['ceilingRatePct', HISTORICAL_TOLERANCE_LIMITS.absPp + 1],
      ['tolerance.absPp', HISTORICAL_TOLERANCE_LIMITS.absPp + 1],
      ['tolerance.relPct', HISTORICAL_TOLERANCE_LIMITS.relPct + 1],
      ['tolerance.minAbsDelta', HISTORICAL_TOLERANCE_LIMITS.minAbsDelta + 1],
    ] as const;

    for (const [field, invalidValue] of invalidEntries) {
      const checks = Object.fromEntries(
        HISTORICAL_SITEMAP_CHECKS.map((name) => [name, {
          ceilingRatePct: 1,
          tolerance: { relPct: 0, absPp: 0, minAbsDelta: 0 },
          measurement: { filesScanned: 1_000, observedOffenders: 10 },
        }]),
      );
      if (field === 'ceilingRatePct') {
        checks['validate:canonical'].ceilingRatePct = invalidValue;
      } else {
        const toleranceField = field.slice('tolerance.'.length) as 'absPp' | 'relPct' | 'minAbsDelta';
        checks['validate:canonical'].tolerance[toleranceField] = invalidValue;
      }

      const dir = mkdtempSync(join(tmpdir(), 'historical-ledger-invalid-'));
      const path = join(dir, 'ledger.json');
      try {
        writeFileSync(path, JSON.stringify({ version: 1, checks }));
        expect(readHistoricalCorpusLedgerOrNull(path), field).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('counts only successfully inspected canonical pages in the historical denominator', () => {
    expect(VALIDATOR_SOURCE).toMatch(
      /let filesScanned = 0;[\s\S]*?if \(fullContent === null\) continue;\s*filesScanned \+= 1;/,
    );
    expect(VALIDATOR_SOURCE).toMatch(
      /historicalErrors\.length,\s*\n\s*filesScanned,\s*\n\s*\);/,
    );
    expect(VALIDATOR_SOURCE).not.toMatch(
      /historicalErrors\.length,\s*\n\s*sitemapUrls\.size,\s*\n\s*\);/,
    );
  });

  it('ships a valid, passing ledger for all three blocking sub-checks', () => {
    const ledger = readHistoricalCorpusLedgerOrNull();
    expect(ledger).not.toBeNull();

    for (const check of HISTORICAL_SITEMAP_CHECKS) {
      const entry = ledger!.checks[check];
      const verdict = evaluateHistoricalCorpusRate({
        check,
        offenders: entry.measurement.observedOffenders,
        filesScanned: entry.measurement.filesScanned,
        historicalCorpus: true,
        ledger,
      });
      expect(verdict.passed, `${check}: ${verdict.humanSummary}`).toBe(true);
    }
  });
});
