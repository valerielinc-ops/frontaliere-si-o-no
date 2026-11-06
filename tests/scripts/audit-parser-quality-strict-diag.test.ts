// @vitest-environment node
/**
 * Issue 5253 — "Audit Parser Quality: lo strict fallisce senza che il motivo
 * arrivi alla issue". The strict verdict must be written to a diag file that
 * the in-job failure reporter turns into the issue excerpt.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as audit from '../../scripts/audit-parser-quality.mjs';
import { extractStepExcerpt } from '../../scripts/ci/report-validate-dist-failure.mjs';

const { finishAudit, SOURCE_DETAIL_UNEXPLAINED_FAILURE_MAX_PCT } = audit;

// Shape of the two CRITICAL crawlers of run 37213030719 (parser-quality-report
// artifact), trimmed to the fields the diagnostic reads.
function criticalReportFromRun37213030719() {
  return {
    'ffs-officine-ferrovie-federali': {
      total: 42,
      severity: 'CRITICAL',
      action: 'Published locations disagree with sampled source detail pages — inspect the crawler location selector and remove generic-city fallbacks.',
      issues: [
        { type: 'source-distinct-duplicates', count: 2, total: 42, informational: true, message: '2/42 duplicate descriptions with distinct source IDs (informational)' },
        { type: 'duplicate-descriptions-desc-only', count: 2, total: 42, hidden: true, message: '' },
        {
          type: 'source-detail-mismatch',
          count: 1,
          total: 3,
          message: '1/2 authoritative source location mismatches, 0/3 incomplete descriptions',
          details: ['https://jobs.example.test/v2/offene-stellen/umwelt/e5fc: published "Stansstad", source "Bern, Bern" [jsonld]'],
        },
      ],
    },
    premiumpflege24: {
      total: 1,
      severity: 'CRITICAL',
      action: 'Published locations disagree with sampled source detail pages — inspect the crawler location selector and remove generic-city fallbacks.',
      issues: [{
        type: 'source-detail-mismatch',
        count: 1,
        total: 1,
        message: '1/1 authoritative source location mismatches, 0/1 incomplete descriptions',
        details: ['https://premiumpflege24.example.test/job-registrierung/: published "Schweiz", source "Subingen" [jsonld]'],
      }],
    },
    'healthy-crawler': { total: 10, severity: 'OK', issues: [] },
  };
}

describe('Audit Parser Quality: lo strict fallisce senza che il motivo arrivi alla issue', () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-quality-strict-diag-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a diag naming every CRITICAL crawler, its finding and the verdict when strict fails', () => {
    const outPath = path.join(dir, 'report.json');
    const diagPath = path.join(dir, 'nested', 'strict-diag.txt');
    const exitCode = finishAudit(criticalReportFromRun37213030719(), { strict: true, outPath, diagPath });

    expect(exitCode).toBe(1);
    expect(fs.existsSync(diagPath), 'strict failure must leave a diag file for the reporter').toBe(true);
    const diag = fs.readFileSync(diagPath, 'utf8');
    expect(diag).toContain('ffs-officine-ferrovie-federali (42 jobs)');
    expect(diag).toContain('premiumpflege24 (1 jobs)');
    expect(diag).toContain('published "Stansstad", source "Bern, Bern"');
    expect(diag).toContain('ACTION: Published locations disagree');
    expect(diag).not.toContain('healthy-crawler');
    // Informational and hidden findings do not fail the gate: not the reason.
    expect(diag).not.toContain('(informational)');
    expect(diag.trimEnd().split('\n').at(-1)).toBe('❌ --strict: 2 critical crawler(s) found. Failing.');
  });

  it('the reporter excerpt built from the diag keeps the crawlers AND the verdict', () => {
    const outPath = path.join(dir, 'report.json');
    const diagPath = path.join(dir, 'strict-diag.txt');
    finishAudit(criticalReportFromRun37213030719(), { strict: true, outPath, diagPath });
    // Same call as scripts/ci/report-workflow-failure.mjs (MAX_EXCERPT_LINES).
    const excerpt = extractStepExcerpt(fs.readFileSync(diagPath, 'utf8'), { maxLines: 40 });
    expect(excerpt).toContain('ffs-officine-ferrovie-federali');
    expect(excerpt).toContain('premiumpflege24');
    expect(excerpt).toContain('❌ --strict: 2 critical crawler(s) found');
  });

  it('stays bounded below the reporter window with many CRITICAL crawlers', () => {
    const report: Record<string, unknown> = {};
    for (let i = 0; i < 30; i += 1) {
      report[`crawler-${String(i).padStart(2, '0')}`] = {
        total: 5,
        severity: 'CRITICAL',
        action: 'Fix the parser.',
        issues: [{ type: 'parse-error', message: 'broken', details: ['a', 'b', 'c', 'd'] }],
      };
    }
    const diagPath = path.join(dir, 'strict-diag.txt');
    finishAudit(report, { strict: true, outPath: path.join(dir, 'report.json'), diagPath });
    const lines = fs.readFileSync(diagPath, 'utf8').trimEnd().split('\n');
    expect(lines.length).toBeLessThanOrEqual(40);
    expect(lines.join('\n')).toMatch(/more CRITICAL crawler\(s\): see the parser-quality-report artifact/);
    expect(lines.at(-1)).toMatch(/^❌ --strict: /);
  });

  it('names the unexplained fetch-failure rate and its causes when that is the reason', () => {
    const diagPath = path.join(dir, 'strict-diag.txt');
    const rate = SOURCE_DETAIL_UNEXPLAINED_FAILURE_MAX_PCT + 1.5;
    const sourceDetailSummary = {
      requested: 1000,
      unexplainedFetchFailures: rate * 10,
      unexplainedFetchFailureRatePct: rate,
      fetchFailureCauses: { 'transport-timeout': 40, 'blocked-by-source': 25 },
    };
    const exitCode = finishAudit({ ok: { total: 1, severity: 'OK', issues: [] } }, {
      strict: true, outPath: path.join(dir, 'report.json'), diagPath, sourceDetailSummary,
    });
    expect(exitCode).toBe(1);
    const diag = fs.readFileSync(diagPath, 'utf8');
    expect(diag).toContain(`${rate * 10}/1000 unexplained (${rate} %`);
    expect(diag).toContain('transport-timeout 40');
    expect(diag).not.toContain('CRITICAL crawlers');
  });

  it('writes nothing when strict passes or strict is off', () => {
    const diagPath = path.join(dir, 'strict-diag.txt');
    expect(finishAudit({ ok: { total: 1, severity: 'OK', issues: [] } }, {
      strict: true, outPath: path.join(dir, 'report.json'), diagPath,
    })).toBe(0);
    expect(finishAudit(criticalReportFromRun37213030719(), {
      strict: false, outPath: path.join(dir, 'report2.json'), diagPath,
    })).toBe(0);
    expect(fs.existsSync(diagPath)).toBe(false);
  });
});
