// @vitest-environment node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  BASELINE_PATH,
  checkParserContract,
  formatRegression,
  listParserFiles,
} from '../scripts/ci/check-parser-contract.mjs';

/**
 * OSSERVATORE (statico) — issue 11674: un parser toccato dal diff non aveva
 * nessun gate di CI. Questo test fa girare `check-parser-contract.mjs` su
 * tutti i `scripts/lib/*-job-parser.mjs` e `scripts/update-*-jobs.mjs` del
 * disco contro la baseline committata. `run-related-tests.mjs` lo seleziona
 * (`sourceTreeLintTests`) quando il diff tocca uno di quei file: nessuno
 * importa questo test, quindi il grafo da solo non lo farebbe partire.
 *
 * Rosso = una violazione nuova (file nuovo o conteggio salito): correggi la
 * riga oppure annotala con `// parser-contract-ok R<n>: <motivo>`.
 * Rosso «baseline da abbassare» = una violazione e' sparita: registra il
 * miglioramento con `node scripts/ci/check-parser-contract.mjs --update-baseline`.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('parser-contract sul diff', () => {
  it('trova i file di parser sul disco', () => {
    expect(listParserFiles(REPO_ROOT).length).toBeGreaterThan(0);
  });

  it('nessuna violazione oltre la baseline e nessuna baseline stantia', () => {
    const { regressions, improvements } = checkParserContract(REPO_ROOT);
    const report = [
      ...regressions.map(formatRegression),
      ...improvements.map((i: { file: string; rule: string; allowed: number; now: number }) => (
        `parser-contract baseline da abbassare: ${i.file} ${i.rule} ${i.allowed} -> ${i.now} `
        + `(node scripts/ci/check-parser-contract.mjs --update-baseline, ${BASELINE_PATH})`
      )),
    ].join('\n');
    expect(report).toBe('');
  });
});
