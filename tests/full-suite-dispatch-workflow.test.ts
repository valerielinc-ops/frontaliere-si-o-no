// @vitest-environment node
/**
 * Contratto di `.github/workflows/full-suite-dispatch.yml` (issue #9740,
 * FU-2026-09-18-013): l'unico runner che esegue la suite Vitest riproducibile in
 * un checkout PIENO. I test che ricostruiscono artifact generati sono esclusi
 * e restano eseguibili in modo mirato. Ogni asserzione tiene fermo un modo
 * concreto in cui la misura
 * smetterebbe di misurare in silenzio: un trigger automatico (costo CI
 * permanente), uno sparse-checkout (file rossi per assenza), una env di
 * selezione o tolleranza (suite parziale), un `continue-on-error` o un
 * `|| true` (verde fabbricato), un report che non sopravvive al rosso.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import {
  main,
  renderRedFilesText,
  renderStepSummary,
  summarizeVitestReport,
} from '../scripts/ci/full-suite-red-files.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = join(ROOT, '.github/workflows/full-suite-dispatch.yml');
const RAW = readFileSync(WORKFLOW_PATH, 'utf8');
const DOC = YAML.parse(RAW) as Record<string, any>;
// Il file spiega nei commenti cosa NON fa (`continue-on-error`, `VITEST_*`):
// le asserzioni testuali guardano solo le righe di configurazione.
const CODE = RAW.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
  'timeout-minutes'?: number;
  'continue-on-error'?: unknown;
};

const jobs = Object.entries(DOC.jobs ?? {}) as Array<[string, Record<string, any>]>;
const job = jobs[0]?.[1] ?? {};
const steps = (job.steps ?? []) as Step[];
const indexOf = (predicate: (s: Step) => boolean) => steps.findIndex(predicate);
const runIncludes = (needle: string) => (s: Step) => typeof s.run === 'string' && s.run.includes(needle);
const testIndex = indexOf(runIncludes('npm test'));
const testStep = steps[testIndex] ?? {};

describe('full-suite-dispatch.yml: trigger, permessi, limiti', () => {
  it('ha un solo job', () => {
    expect(jobs).toHaveLength(1);
  });

  it('si avvia SOLO con workflow_dispatch (niente schedule/push/pull_request/workflow_run)', () => {
    // YAML legge la chiave `on:` come booleano `true`.
    const on = DOC.on ?? DOC[true as unknown as string];
    const triggers = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
    expect(triggers).toEqual(['workflow_dispatch']);
  });

  it('permessi limitati a `contents: read`, a livello workflow e senza override di job', () => {
    expect(DOC.permissions).toEqual({ contents: 'read' });
    expect(job.permissions).toBeUndefined();
  });

  it('nessun secret oltre al GITHUB_TOKEN di default', () => {
    const secrets = [...RAW.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    expect(secrets.filter((s) => s !== 'GITHUB_TOKEN')).toEqual([]);
  });

  it('concurrency dedicata, non per-run e non cancellante', () => {
    expect(String(DOC.concurrency?.group ?? '')).toMatch(/^full-suite-dispatch/);
    expect(String(DOC.concurrency?.group ?? '')).not.toMatch(/run_id|run_number|run_attempt/);
    expect(DOC.concurrency?.['cancel-in-progress']).toBe(false);
  });

  it('riserva 60 minuti alla suite e 30 al setup/riepilogo del report #12130', () => {
    expect(job['timeout-minutes']).toBe(90);
    expect(testStep['timeout-minutes']).toBe(60);
    expect(job['timeout-minutes'] - testStep['timeout-minutes']).toBeGreaterThanOrEqual(30);
  });
});

describe('full-suite-dispatch.yml: checkout pieno e dati runtime', () => {
  it('actions/checkout@v7 senza sparse-checkout, con la storia completa', () => {
    const checkouts = steps.filter((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0].uses).toBe('actions/checkout@v7');
    expect(checkouts[0].with?.['sparse-checkout']).toBeUndefined();
    expect(checkouts[0].with?.['sparse-checkout-cone-mode']).toBeUndefined();
    expect(checkouts[0].with?.['fetch-depth']).toBe(0);
    expect(CODE).not.toMatch(/sparse-checkout/);
  });

  it('npm ci passa dalla composite che salva la cache npm solo su main', () => {
    expect(indexOf((s) => s.uses === './.github/actions/ci-npm-setup')).toBeGreaterThan(-1);
    expect(CODE).not.toMatch(/cache:\s*['"]?npm/);
  });

  it('prepara Java e avvia il Firestore emulator prima della suite', () => {
    const javaIndex = indexOf((s) => s.uses === 'actions/setup-java@v4');
    expect(javaIndex).toBeGreaterThan(-1);
    expect(javaIndex).toBeLessThan(testIndex);
    expect(steps[javaIndex].with).toMatchObject({ distribution: 'temurin', 'java-version': '21' });

    const run = String(testStep.run ?? '');
    expect(run).toContain('./node_modules/.bin/firebase emulators:exec');
    expect(run).toContain('--only firestore');
    expect(run).toContain('--project frontaliereticino-rules-test');
    expect(run).toContain('status=$?');
    expect(run).toContain('FULL_SUITE_EXIT_CODE');
    expect(run).toContain('exit "$status"');
  });

  it('assemble e migrate girano, in quest\'ordine, PRIMA di npm test', () => {
    const keyIndex = indexOf((s) => s.uses === './.github/actions/assemble-jobs-cache-key');
    const assembleIndex = indexOf(runIncludes('node scripts/assemble-jobs-dataset.mjs --stats'));
    const migrateIndex = indexOf(runIncludes('node scripts/migrate-all-known-job-slugs-canton-aware.mjs'));
    expect(testIndex).toBeGreaterThan(-1);
    expect(keyIndex).toBeGreaterThan(-1);
    expect(keyIndex).toBeLessThan(assembleIndex);
    expect(assembleIndex).toBeLessThan(migrateIndex);
    expect(migrateIndex).toBeLessThan(testIndex);
    for (const s of [steps[assembleIndex], steps[migrateIndex]]) {
      expect(s.if).toBeUndefined();
      expect(s['continue-on-error']).toBeUndefined();
    }
  });

  it('la cache assemble-jobs è chiavata sull\'impronta dell\'assembler, non su hashFiles()', () => {
    const cacheLines = RAW.match(/key: assemble-jobs-[^\n]+/g) ?? [];
    expect(cacheLines.length).toBeGreaterThan(0);
    for (const line of cacheLines) {
      expect(line).toContain('steps.assemble_cache_key.outputs.key');
      expect(line).not.toContain('hashFiles(');
    }
  });
});

describe('full-suite-dispatch.yml: la suite è intera e il rosso resta rosso', () => {
  it('npm test con reporter default + json verso full-suite-report.json, sotto pipefail', () => {
    const run = String(testStep.run ?? '');
    expect(run).toContain('set -o pipefail');
    expect(run).toMatch(/npm test -- --reporter=default --reporter=json --outputFile=full-suite-report\.json/);
  });

  it('esclude i test che ricostruiscono dati generati dal percorso completo', () => {
    const run = String(testStep.run ?? '');
    expect(run).toContain('--exclude tests/generate-crawler-group-workflows.test.ts');
    expect(run).toContain('--exclude tests/translation-state-drainer-v2.test.ts');
  });

  it('nessuna env di selezione o tolleranza, nessun --bail, nessun continue-on-error', () => {
    expect(CODE).not.toMatch(/VITEST_(CORPUS_GROUP|CORPUS_SKIP|DATASET_GROUP|SKIP_[A-Z_]+)\s*:/);
    expect(testStep.env).toBeUndefined();
    expect(String(testStep.run)).not.toMatch(/--bail|--passWithNoTests|--changed|--related|--shard/);
    expect(testStep['continue-on-error']).toBeUndefined();
    expect(testStep.if).toBeUndefined();
    expect(CODE).not.toMatch(/continue-on-error/);
  });

  it('nessun fallback che fabbrichi un verde', () => {
    for (const s of steps) {
      if (typeof s.run !== 'string') continue;
      expect(s.run, s.name).not.toMatch(/\|\|\s*(true|echo|exit 0|:)/);
    }
  });

  it('il riepilogo dei file rossi, delle metriche e l\'upload girano `if: always()` dopo la suite', () => {
    const summaryIndex = indexOf(runIncludes('scripts/ci/full-suite-red-files.mjs'));
    const uploadIndex = indexOf((s) => String(s.uses ?? '').startsWith('actions/upload-artifact@'));
    expect(summaryIndex).toBeGreaterThan(testIndex);
    expect(uploadIndex).toBeGreaterThan(summaryIndex);
    expect(steps[summaryIndex].if).toBe('always()');
    expect(steps[uploadIndex].if).toBe('always()');
    expect(String(steps[summaryIndex].run)).toContain('--metrics-out full-suite-performance.json');
    const uploaded = String(steps[uploadIndex].with?.path ?? '');
    for (const file of ['full-suite-report.json', 'full-suite-red-files.txt', 'full-suite-performance.json', 'full-suite-vitest.log']) {
      expect(uploaded).toContain(file);
    }
  });

  it('non apre issue, non commenta, non scrive sul repo', () => {
    expect(CODE).not.toMatch(/report-failure|github-issue-creator|gh (issue|pr) |git (push|commit)/);
  });
});

describe('scripts/ci/full-suite-red-files.mjs', () => {
  const root = '/home/runner/work/repo/repo';
  // Forma reale del reporter JSON di Vitest: `numTotalTestSuites` e
  // `numFailedTestSuites` contano i FILE più ogni `describe` (`getSuites`).
  // Quattro file, tre `describe`: 7 suite; i test rossi di zeta stanno in un
  // `describe`, quindi zeta pesa due suite rosse e alpha una → 3.
  const report = {
    numTotalTestSuites: 7,
    numFailedTestSuites: 3,
    numFailedTests: 3,
    startTime: 1000,
    testResults: [
      {
        name: `${root}/tests/ok.test.ts`, status: 'passed', startTime: 1000, endTime: 1300,
        assertionResults: [{ status: 'passed' }],
      },
      {
        name: `${root}/tests/zeta.test.ts`,
        status: 'failed',
        startTime: 1100,
        endTime: 1700,
        message: '',
        assertionResults: [
          { status: 'failed', failureMessages: ['AssertionError: expected 1 to be 2 | pipe\nstack'] },
          { status: 'failed', failureMessages: ['second'] },
          { status: 'passed' },
        ],
      },
      {
        name: `${root}/tests/scripts/alpha.test.ts`,
        status: 'failed',
        startTime: 1200,
        endTime: 1400,
        message: 'Error: Cannot find module data/jobs.json',
        assertionResults: [],
      },
      { name: `${root}/tests/skip.test.ts`, status: 'skipped', startTime: 1400, endTime: 1400, assertionResults: [] },
    ],
  };

  it('elenca i file rossi (anche quelli caduti in collection), ordinati e relativi alla root', () => {
    const summary = summarizeVitestReport(report, root);
    expect(summary.numFailedTestSuites).toBe(3);
    expect(summary.numTotalTestSuites).toBe(7);
    // I file vengono da `testResults`, non da `numTotalTestSuites`.
    expect(summary.totalFiles).toBe(4);
    expect(summary.redFiles).toEqual([
      { file: 'tests/scripts/alpha.test.ts', failedTests: 0, message: 'Error: Cannot find module data/jobs.json' },
      { file: 'tests/zeta.test.ts', failedTests: 2, message: 'AssertionError: expected 1 to be 2 | pipe' },
    ]);
    expect(summary.performance).toEqual({
      reportStartTimeMs: 1000,
      reportEndTimeMs: 1700,
      suiteDurationMs: 700,
      timedFiles: 4,
      medianFileDurationMs: 250,
      p95FileDurationMs: 600,
      maxFileDurationMs: 600,
    });
    expect(renderRedFilesText(summary)).toBe('tests/scripts/alpha.test.ts\ntests/zeta.test.ts\n');
  });

  it('il riepilogo porta il conteggio e una riga per file, con le pipe escapate', () => {
    const text = renderStepSummary(summarizeVitestReport(report, root), { sha: 'abc123', ref: 'main' });
    expect(text).toContain('- file di test: 4\n');
    expect(text).toContain('- file rossi: **2** (elencati qui sotto)');
    // Le suite di Vitest restano visibili, ma con la loro etichetta: mai come «file».
    expect(text).toContain('(`numFailedTestSuites`, file + blocchi `describe`): 3 su 7');
    expect(text).toContain('- durata Vitest: **700 ms**');
    expect(text).toContain('- durata file: mediana **250 ms**, p95 **600 ms**, massimo **600 ms**');
    expect(text).not.toMatch(/file[^\n]*\*\*3\*\*/);
    expect(text).toContain('| `tests/zeta.test.ts` | 2 | AssertionError: expected 1 to be 2 \\| pipe |');
    expect(text).toContain('| `tests/scripts/alpha.test.ts` | 0 |');
  });

  it('senza i contatori di Vitest i file restano misurati e le suite non vengono inventate', () => {
    const bare = { testResults: report.testResults };
    const summary = summarizeVitestReport(bare, root);
    expect(summary.totalFiles).toBe(4);
    expect(summary.redFiles).toHaveLength(2);
    expect(summary.numFailedTestSuites).toBeNull();
    expect(summary.numFailedTests).toBeNull();
    const text = renderStepSummary(summary);
    expect(text).toContain('- file rossi: **2**');
    expect(text).not.toContain('numFailedTestSuites');
  });

  it('un report senza testResults è un errore, non uno zero', () => {
    expect(() => summarizeVitestReport({}, root)).toThrow(/testResults/);
  });

  it('CLI: report assente → exit 1 e riepilogo che lo dice; report valido → exit 0 e file scritto', () => {
    const dir = mkdtempSync(join(tmpdir(), 'full-suite-red-files-'));
    try {
      const summaryFile = join(dir, 'summary.md');
      const metricsFile = join(dir, 'metrics.json');
      writeFileSync(summaryFile, '');
      const originalSummary = process.env.GITHUB_STEP_SUMMARY;
      process.env.GITHUB_STEP_SUMMARY = summaryFile;
      try {
        const missingStatus = main([
          '--report', join(dir, 'missing.json'),
          '--out', join(dir, 'red.txt'),
          '--metrics-out', metricsFile,
        ]);
        expect(missingStatus).toBe(1);
        expect(readFileSync(summaryFile, 'utf8')).toContain('Report Vitest file assente');
        expect(JSON.parse(readFileSync(metricsFile, 'utf8'))).toMatchObject({
          status: 'unavailable',
          reportAvailable: false,
          performance: { suiteDurationMs: null, medianFileDurationMs: null },
        });

        const malformedFile = join(dir, 'malformed.json');
        writeFileSync(malformedFile, JSON.stringify({ success: false }));
        const malformedStatus = main([
          '--report', malformedFile,
          '--out', join(dir, 'red.txt'),
          '--metrics-out', metricsFile,
        ]);
        expect(malformedStatus).toBe(1);
        expect(JSON.parse(readFileSync(metricsFile, 'utf8'))).toMatchObject({
          status: 'unavailable',
          reportAvailable: false,
          reason: expect.stringContaining('testResults'),
        });

        const reportFile = join(dir, 'report.json');
        writeFileSync(reportFile, JSON.stringify(report));
        const validStatus = main([
          '--report', reportFile,
          '--out', join(dir, 'red.txt'),
          '--metrics-out', metricsFile,
        ]);
        expect(validStatus).toBe(0);
        expect(readFileSync(join(dir, 'red.txt'), 'utf8')).toBe('tests/scripts/alpha.test.ts\ntests/zeta.test.ts\n');
        expect(JSON.parse(readFileSync(metricsFile, 'utf8'))).toMatchObject({
          schemaVersion: 1,
          status: 'measured',
          reportAvailable: true,
          invariants: { totalFiles: 4, redFiles: 2, numFailedTests: 3 },
          performance: { suiteDurationMs: 700, medianFileDurationMs: 250, p95FileDurationMs: 600 },
        });
      } finally {
        if (originalSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
        else process.env.GITHUB_STEP_SUMMARY = originalSummary;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
