import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

// Esegue davvero lo step «Collect failing check context (zero-Claude)» del
// ❌-check-fixer contro un log nel formato di `gh run view --log-failed`
// (`job<TAB>step<TAB>timestamp testo`). I test di sorgente in
// pr-redcheck-fixer-guards.test.ts pinnano il filtro `FAIL `; qui si verifica
// cosa arriva al fixer quando il rosso NON e' di vitest.

const WORKFLOW = path.resolve(__dirname, '..', '.github', 'workflows', 'pr-redcheck-fixer.yml');
const workflow = YAML.parse(readFileSync(WORKFLOW, 'utf8')) as {
  jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
};
const STEP_NAME = 'Collect failing check context (zero-Claude)';
const ctxStep = Object.values(workflow.jobs)
  .flatMap((job) => job.steps ?? [])
  .find((step) => step.name === STEP_NAME);
if (!ctxStep?.run) throw new Error(`${STEP_NAME} not found in pr-redcheck-fixer.yml`);
const CTX = ctxStep.run;

const JOB = 'vitest (unit + integration)';
const line = (ts: string, text: string) => `${JOB}\tUNKNOWN STEP\t2026-09-24T23:44:${ts}Z ${text}`;

// Estratto reale della run 36061365735 (#9695): vitest verde, typecheck gate rosso.
const TSC_RED_LOG = [
  line('01.7609974', '\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[32m64 passed\u001b[39m\u001b[22m\u001b[90m (64)\u001b[39m'),
  line('10.9631464', '[tsc] exit=1'),
  line('10.9638043', '> frontaliereticino@0.0.0 typecheck:gate'),
  line('10.9639662', 'tsc 5.8.3 — 1451 errori (bloccanti 21, tests/ 1430)'),
  line('10.9666811', '✗ 1 nuovo/i errore/i di tipo fuori da tests/, in 1 file:'),
  line('10.9667389', '  services/professionSynonyms.ts: 0 → 1'),
  line('10.9668012', "      services/professionSynonyms.ts(34): TS2345: Argument of type 'readonly string[]' is not assignable to parameter of type 'any[]'."),
  line('10.9671401', '[audit-markers] exit=0'),
  line('10.9673182', '✅ audit-no-merge-markers: 0 files contain merge conflict markers (scanned 36101).'),
  line('10.9754774', '##[error]Process completed with exit code 1.'),
].join('\n');

const VITEST_RED_LOG = [
  line('01.0000000', ' FAIL  tests/example.test.ts > example > breaks'),
  line('01.1000000', 'AssertionError: expected 1 to be 2'),
  line('02.0000000', ' Test Files  1 failed | 63 passed (64)'),
  line('02.1000000', '[tsc] exit=0'),
].join('\n');

// Il corpo di una sezione `### <titolo>` di failing.txt, senza la riga di
// intestazione (che a sua volta cita `[gate] exit=N`).
function section(text: string, title: string) {
  const body = text.split(`### ${title}`)[1] ?? '';
  return body.slice(body.indexOf('\n') + 1).split('\n###')[0];
}

function runContext(log: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'redcheck-ctx-'));
  const bin = path.join(root, 'bin');
  const logFile = path.join(root, 'run.log');
  const gh = path.join(bin, 'gh');
  mkdirSync(bin, { recursive: true });
  writeFileSync(logFile, `${log}\n`);
  writeFileSync(
    gh,
    `#!/bin/sh
if [ "$1" = run ] && [ "$2" = view ]; then cat "${logFile}"; exit 0; fi
exit 1
`,
  );
  chmodSync(gh, 0o755);
  const result = spawnSync('bash', ['-e', '-c', CTX], {
    encoding: 'utf8',
    env: {
      ...process.env,
      RUNNER_TEMP: root,
      TRUSTED_GH_BIN: gh,
      GH_TOKEN: 'x',
      REPO: 'owner/repo',
      FAILED_RUN_ID: '123',
      PR_NUMBER: '42',
    },
  });
  const failing = readFileSync(path.join(root, 'redcheck', 'failing.txt'), 'utf8');
  rmSync(root, { recursive: true, force: true });
  return { result, failing };
}

describe('pr-redcheck-fixer: il contesto del rosso raggiunge il fixer', () => {
  it('porta al fixer l\'errore di un gate sorgente quando vitest e\' verde (#9695)', () => {
    const { result, failing } = runContext(TSC_RED_LOG);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(failing).toContain('[tsc] exit=1');
    expect(failing).toContain('services/professionSynonyms.ts(34): TS2345');
    expect(result.stdout).toMatch(/[1-9][0-9]* righe di gate sorgente falliti/);
  });

  it('non elenca come falliti i gate usciti con 0', () => {
    const { failing } = runContext(TSC_RED_LOG);
    const failedSection = section(failing, 'Gate sorgente falliti');
    expect(failedSection).toContain('[tsc] exit=1');
    expect(failedSection).not.toContain('[audit-markers] exit=0');
  });

  it('mantiene le righe `FAIL ` di vitest e non inventa gate falliti', () => {
    const { result, failing } = runContext(VITEST_RED_LOG);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(failing).toContain('FAIL  tests/example.test.ts');
    expect(section(failing, 'Gate sorgente falliti')).not.toMatch(/exit=/);
    expect(section(failing, 'Estratto attorno al primo gate sorgente fallito').trim()).toBe('');
  });
});
