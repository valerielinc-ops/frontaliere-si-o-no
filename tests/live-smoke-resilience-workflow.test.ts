import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type WorkflowStep = {
  name?: string;
  env?: Record<string, string>;
  run?: string;
  'timeout-minutes'?: number;
};

type WorkflowDocument = {
  jobs: {
    'validate-live': {
      'timeout-minutes'?: number;
      steps: WorkflowStep[];
    };
  };
};

const WORKFLOW_SOURCE = readFileSync(
  new URL('../.github/workflows/post-deploy-validate-live.yml', import.meta.url),
  'utf8',
);
const WORKFLOW = parse(WORKFLOW_SOURCE) as WorkflowDocument;
const JOB = WORKFLOW.jobs['validate-live'];
const SMOKE_STEP = JOB.steps.find((step) => step.name === 'Live smoke (probe 5xx + blocking e2e:live)');
const SMOKE_RUN = String(SMOKE_STEP?.run ?? '');
const temporaryDirectories: string[] = [];

const FAKE_NPM = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_NPM_LOG"

if [[ "$*" == *"run probe:5xx"* ]]; then
  probe_attempt=0
  if [ -f "$FAKE_PROBE_LOG" ]; then
    probe_attempt="$(< "$FAKE_PROBE_LOG")"
  fi
  probe_attempt=$((probe_attempt + 1))
  printf '%s\\n' "$probe_attempt" > "$FAKE_PROBE_LOG"
  if [ "$probe_attempt" -le "$FAKE_PROBE_FAILS" ]; then
    printf '[fake probe] transient failure %s\\n' "$probe_attempt"
    exit 1
  fi
  printf '[fake probe] success %s\\n' "$probe_attempt"
  exit 0
fi

if [[ "$*" == *"run test:e2e:live"* ]]; then
  e2e_attempt=0
  if [ -f "$FAKE_E2E_LOG" ]; then
    e2e_attempt="$(< "$FAKE_E2E_LOG")"
  fi
  e2e_attempt=$((e2e_attempt + 1))
  printf '%s\\n' "$e2e_attempt" > "$FAKE_E2E_LOG"
  mkdir -p test-results
  if [ "$e2e_attempt" -gt 1 ]; then
    if [[ "$*" != *"--last-failed"* ]]; then
      printf '[fake e2e] retry did not include --last-failed\\n' >&2
      exit 91
    fi
    if [ ! -f test-results/.last-run.json ]; then
      printf '[fake e2e] last-run state was removed between rounds\\n' >&2
      exit 92
    fi
  fi
  failed_line='  1) [chromium] › tests/e2e/edge-retry.spec.ts:10:5 › recovers after a transient edge error ──'
  case "$FAKE_E2E_MODE:$e2e_attempt" in
    first-pass:*)
      printf '  ✓ 1 [chromium] › tests/e2e/edge-retry.spec.ts:10:5 › recovers after a transient edge error (1ms)\\n'
      printf '{"status":"passed","failedTests":[]}\\n' > test-results/.last-run.json
      exit 0
      ;;
    flaky:1)
      printf '%s\\n' "$failed_line"
      printf '{"status":"failed","failedTests":["edge-test"]}\\n' > test-results/.last-run.json
      exit 1
      ;;
    flaky:*)
      printf '  ✓ 1 [chromium] › tests/e2e/edge-retry.spec.ts:10:5 › recovers after a transient edge error (1ms)\\n'
      printf '{"status":"passed","failedTests":[]}\\n' > test-results/.last-run.json
      exit 0
      ;;
    persistent:*)
      printf '%s\\n' "$failed_line"
      printf '{"status":"failed","failedTests":["edge-test"]}\\n' > test-results/.last-run.json
      exit 1
      ;;
    *)
      printf '[fake e2e] unknown scenario\\n' >&2
      exit 93
      ;;
  esac
fi

printf '[fake npm] unexpected command: %s\\n' "$*" >&2
exit 94
`;

function collectIfConditions(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectIfConditions);
  if (!value || typeof value !== 'object') return [];

  return Object.entries(value).flatMap(([key, nested]) => {
    const own = key === 'if' && typeof nested === 'string' ? [nested] : [];
    return [...own, ...collectIfConditions(nested)];
  });
}

function runSmoke(options: {
  probeFailures?: number;
  e2eMode: 'first-pass' | 'flaky' | 'persistent';
  summaryIsDirectory?: boolean;
}) {
  const parent = process.env.FRONTALIERE_VALIDATE_LIVE_TMP || tmpdir();
  const tempDirectory = mkdtempSync(join(parent, 'validate-live-smoke-'));
  temporaryDirectories.push(tempDirectory);

  const binDirectory = join(tempDirectory, 'bin');
  const summaryPath = join(tempDirectory, 'summary.md');
  const npmLog = join(tempDirectory, 'npm.log');
  const probeLog = join(tempDirectory, 'probe-count');
  const e2eLog = join(tempDirectory, 'e2e-count');
  mkdirSync(binDirectory);
  if (options.summaryIsDirectory) mkdirSync(summaryPath);
  writeFileSync(join(binDirectory, 'npm'), FAKE_NPM);
  chmodSync(join(binDirectory, 'npm'), 0o755);

  const result = spawnSync('bash', [
    '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', SMOKE_RUN,
  ], {
    cwd: tempDirectory,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(SMOKE_STEP?.env ?? {}),
      PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
      GITHUB_STEP_SUMMARY: summaryPath,
      LIVE_PROBE_RETRY_DELAY_SECONDS: '0',
      LIVE_E2E_RETRY_DELAY_SECONDS_2: '0',
      LIVE_E2E_RETRY_DELAY_SECONDS_3: '0',
      FAKE_NPM_LOG: npmLog,
      FAKE_PROBE_LOG: probeLog,
      FAKE_E2E_LOG: e2eLog,
      FAKE_PROBE_FAILS: String(options.probeFailures ?? 0),
      FAKE_E2E_MODE: options.e2eMode,
    },
  });

  return {
    ...result,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    npmCalls: readFileSync(npmLog, 'utf8').trim().split('\n').filter(Boolean),
    probeAttempts: readFileSync(probeLog, 'utf8').trim(),
    e2eAttempts: existsSync(e2eLog) ? readFileSync(e2eLog, 'utf8').trim() : '',
    smokeLog: readFileSync(join(tempDirectory, 'live-smoke-output.log'), 'utf8'),
    summary: options.summaryIsDirectory ? '' : readFileSync(summaryPath, 'utf8'),
  };
}

afterEach(() => {
  for (const temporaryDirectory of temporaryDirectories.splice(0)) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

describe('post-deploy live smoke retry contract', () => {
  it('parses the YAML step, keeps the retry budgets visible, and preserves valid if expressions', () => {
    expect(SMOKE_STEP).toBeTruthy();
    expect(SMOKE_RUN).not.toContain('${{');
    expect(SMOKE_RUN).toContain('npm run probe:5xx 2>&1 | tee -a live-smoke-output.log');
    expect(SMOKE_RUN).toContain('npm run test:e2e:live -- --grep-invert "static article"');
    expect(SMOKE_RUN).toContain('npm run test:e2e:live -- --last-failed --grep-invert "static article"');
    expect(SMOKE_RUN).toContain('>> "$GITHUB_STEP_SUMMARY" || true');
    expect(SMOKE_RUN).toContain('tee -a live-smoke-output.log');
    expect(SMOKE_STEP?.env).toMatchObject({
      LIVE_PROBE_MAX_ATTEMPTS: '3',
      LIVE_PROBE_RETRY_DELAY_SECONDS: '30',
      LIVE_E2E_MAX_ROUNDS: '3',
      LIVE_E2E_RETRY_DELAY_SECONDS_2: '60',
      LIVE_E2E_RETRY_DELAY_SECONDS_3: '120',
    });

    for (const condition of collectIfConditions(WORKFLOW)) {
      if (condition.includes('${{')) {
        expect(condition.trim()).toMatch(/^\$\{\{[\s\S]*\}\}$/);
      }
    }

    const probeAttempts = Number(SMOKE_STEP?.env?.LIVE_PROBE_MAX_ATTEMPTS);
    const e2eRounds = Number(SMOKE_STEP?.env?.LIVE_E2E_MAX_ROUNDS);
    const typicalRoundSeconds = 6 * 60;
    const retryPauseSeconds =
      (probeAttempts - 1) * Number(SMOKE_STEP?.env?.LIVE_PROBE_RETRY_DELAY_SECONDS) +
      Number(SMOKE_STEP?.env?.LIVE_E2E_RETRY_DELAY_SECONDS_2) +
      Number(SMOKE_STEP?.env?.LIVE_E2E_RETRY_DELAY_SECONDS_3);
    // Conservatively allow the ~6-minute typical duration for every probe and e2e round.
    const estimatedBudgetSeconds = (probeAttempts + e2eRounds) * typicalRoundSeconds + retryPauseSeconds;
    const timeoutMinutes = Number(SMOKE_STEP?.['timeout-minutes'] ?? JOB['timeout-minutes'] ?? 360);
    expect(timeoutMinutes * 60).toBeGreaterThanOrEqual(estimatedBudgetSeconds);
  });

  it('passes on the first probe and e2e round without repeating either command', () => {
    const result = runSmoke({ e2eMode: 'first-pass' });

    expect(result.status).toBe(0);
    expect(result.probeAttempts).toBe('1');
    expect(result.e2eAttempts).toBe('1');
    expect(result.npmCalls).toHaveLength(2);
    expect(result.npmCalls[1]).not.toContain('--last-failed');
    expect(result.smokeLog).toContain('[fake probe] success 1');
    expect(result.smokeLog).toContain('recovers after a transient edge error');
    expect(result.summary).toContain('| probe 1/3 | passed |');
    expect(result.summary).toContain('| e2e 1/3 | passed |');
  });

  it('retries only failed e2e tests and reports a pass after retry as flaky', () => {
    const result = runSmoke({ e2eMode: 'flaky' });

    expect(result.status).toBe(0);
    expect(result.e2eAttempts).toBe('2');
    const e2eCalls = result.npmCalls.filter((call) => call.includes('test:e2e:live'));
    expect(e2eCalls).toHaveLength(2);
    expect(e2eCalls[0]).not.toContain('--last-failed');
    expect(e2eCalls[1]).toContain('--last-failed');
    expect(result.output).toContain('::warning::[validate-live] e2e smoke passed on retry');
    expect(result.output).toContain('[validate-live] flaky (passed on retry): [chromium] › tests/e2e/edge-retry.spec.ts:10:5 › recovers after a transient edge error');
    expect(result.summary).toContain('**flaky (passed on retry):**');
    expect(result.summary).toContain('recovers after a transient edge error');
    expect(result.smokeLog).toContain('  1) [chromium] › tests/e2e/edge-retry.spec.ts:10:5');
    expect(result.smokeLog).toContain('  ✓ 1 [chromium]');
  });

  it('fails closed after three e2e rounds and reports the persistent test', () => {
    const result = runSmoke({ e2eMode: 'persistent' });

    expect(result.status).not.toBe(0);
    expect(result.e2eAttempts).toBe('3');
    expect(result.output).toContain('[validate-live] tests failing in every e2e round:');
    expect(result.output).toContain('[chromium] › tests/e2e/edge-retry.spec.ts:10:5 › recovers after a transient edge error');
    expect(result.summary).toContain('| e2e 3/3 | failed |');
    expect(result.summary).toContain('**Still failing after the final round:**');
  });

  it('repeats probe:5xx after two failures, then continues to e2e on success', () => {
    const result = runSmoke({ probeFailures: 2, e2eMode: 'first-pass' });

    expect(result.status).toBe(0);
    expect(result.probeAttempts).toBe('3');
    expect(result.e2eAttempts).toBe('1');
    expect(result.output).toContain('[validate-live] probe round 3/3: passed');
    expect(result.summary).toContain('| probe 1/3 | failed |');
    expect(result.summary).toContain('| probe 2/3 | failed |');
    expect(result.summary).toContain('| probe 3/3 | passed |');
  });

  it('fails after three probe failures without starting e2e', () => {
    const result = runSmoke({ probeFailures: 3, e2eMode: 'first-pass' });

    expect(result.status).not.toBe(0);
    expect(result.probeAttempts).toBe('3');
    expect(result.e2eAttempts).toBe('');
    expect(result.summary).toContain('| probe 3/3 | failed |');
    expect(result.output).toContain('probe:5xx failed on all 3 attempts');
  });

  it('does not fail the smoke when writing GITHUB_STEP_SUMMARY fails', () => {
    const result = runSmoke({ e2eMode: 'first-pass', summaryIsDirectory: true });

    expect(result.status).toBe(0);
    expect(result.e2eAttempts).toBe('1');
  });
});
