// @vitest-environment node
/**
 * `scripts/ci/lib/vitest-json-report.mjs`: la regola condivisa che dice quale
 * FILE del report JSON di Vitest è rosso. La usano
 * `scripts/ci/full-suite-red-files.mjs` e `scripts/ci/report-vitest-failure.mjs`.
 */
import { describe, expect, it } from 'vitest';
import { countRedTestFiles, isRedTestFileResult } from '../scripts/ci/lib/vitest-json-report.mjs';

describe('vitest-json-report', () => {
  it('verde, saltato, pending e todo non sono rossi', () => {
    for (const status of ['passed', 'skipped', 'pending', 'todo']) {
      expect(isRedTestFileResult({ status, assertionResults: [{ status: 'passed' }] }), status).toBe(false);
    }
  });

  it('un file caduto in raccolta è rosso anche senza asserzioni', () => {
    expect(isRedTestFileResult({ status: 'failed', message: 'Cannot find module', assertionResults: [] })).toBe(true);
  });

  it('un\'asserzione failed rende rosso il file anche se lo stato del file dice passed', () => {
    expect(isRedTestFileResult({ status: 'passed', assertionResults: [{ status: 'failed' }] })).toBe(true);
  });

  it('un file senza stato leggibile conta rosso: il conteggio non lo nasconde', () => {
    expect(isRedTestFileResult({})).toBe(true);
    expect(isRedTestFileResult(null)).toBe(true);
  });

  it('countRedTestFiles conta file, non le suite di Vitest', () => {
    const report = {
      // file + describe annidati: non è il numero di file.
      numFailedTestSuites: 3,
      numTotalTestSuites: 6,
      testResults: [
        { status: 'failed', assertionResults: [{ status: 'failed' }, { status: 'failed' }] },
        { status: 'passed', assertionResults: [{ status: 'passed' }] },
        { status: 'skipped', assertionResults: [] },
      ],
    };
    expect(countRedTestFiles(report)).toBe(1);
    expect(countRedTestFiles({})).toBe(0);
    expect(countRedTestFiles(null)).toBe(0);
  });
});
