import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const WORKFLOW = path.resolve(__dirname, '..', '.github', 'workflows', 'pr-redcheck-fixer.yml');
const source = readFileSync(WORKFLOW, 'utf8');
const workflow = YAML.parse(source) as {
  jobs?: { preflight?: { steps?: Array<{ id?: string; run?: string }> } };
};
const preflight = workflow.jobs?.preflight?.steps?.find((step) => step.id === 'pre');
if (!preflight?.run) throw new Error('preflight step not found in pr-redcheck-fixer.yml');
const PREFLIGHT = preflight.run;

const BODY_CONTRACT_STEP = 'PR-body completeness + multi-issue Closes (no checkout, all events)';
const BODY_CONTRACT_COMPAT_STEP = 'PR-body completeness + multi-issue Closes (no checkout, pull requests)';
const REVIEW_GATE_STEP = 'Require approving Claude review';
const REVIEW_GATE_COMPAT_STEP = 'Require approving Codex review';
const TEST_STEP = 'vitest related (PR diff)';
const TSC_STEP = 'Collect independent source gates';
const SOURCE_GUARD_STEP = 'Run source guards in parallel';

type Mode = 'body-contract' | 'body-contract-compat' | 'review-gate' | 'review-gate-compat' | 'test' | 'tsc' | 'source-guard' | 'check-api-unavailable' | 'jobs-api-unavailable';

function failedStepForMode(mode: Mode) {
  switch (mode) {
    case 'body-contract':
      return BODY_CONTRACT_STEP;
    case 'body-contract-compat':
      return BODY_CONTRACT_COMPAT_STEP;
    case 'review-gate':
      return REVIEW_GATE_STEP;
    case 'review-gate-compat':
      return REVIEW_GATE_COMPAT_STEP;
    case 'tsc':
      return TSC_STEP;
    case 'source-guard':
      return SOURCE_GUARD_STEP;
    default:
      return TEST_STEP;
  }
}

function runPreflight(mode: Mode) {
  const root = mkdtempSync(path.join(tmpdir(), 'redcheck-preflight-'));
  const bin = path.join(root, 'bin');
  const output = path.join(root, 'github-output');
  const calls = path.join(root, 'gh-calls');
  const gh = path.join(bin, 'gh');
  mkdirSync(bin, { recursive: true });
  writeFileSync(output, '');
  writeFileSync(calls, '');
  writeFileSync(
    gh,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${calls}"
if [ "\${1:-}" = api ]; then
  endpoint="\${2:-}"
  case "$endpoint" in
    *"/pulls?state=open"*)
      # The real gh invocation applies --jq to this response; emit its
      # post-filtered scalar here because this is a CLI double, not the API.
      printf '%s\\n' '42'
      ;;
    *"/pulls/42")
      printf '%s\\n' '{"state":"open","draft":false,"user":{"type":"Bot","login":"frontaliere-automation[bot]"},"head":{"ref":"fix/redcheck-test","sha":"headsha"},"body":"## Implementato\\n- preflight\\n\\n## Non implementato (ancora)\\n- Nessuno"}'
      ;;
    *"/commits/headsha/check-runs"*)
      if [ "\${FAIL_MODE:-}" = check-runs ]; then exit 1; fi
      printf '%s\\n' '["vitest (unit + integration)"]'
      ;;
    *"/actions/runs/123/jobs"*)
      if [ "\${FAIL_MODE:-}" = jobs ]; then exit 1; fi
      printf '%s\\n' "\${JOBS_JSON}"
      ;;
    *)
      exit 1
      ;;
  esac
  exit 0
fi
if [ "\${1:-}" = run ] && [ "\${2:-}" = list ]; then
  printf '%s\\n' '0'
  exit 0
fi
exit 1
`,
  );
  chmodSync(gh, 0o755);

  const failedStep = failedStepForMode(mode);
  const jobs = JSON.stringify([{
    jobs: [{
      name: 'vitest (unit + integration)',
      status: 'completed',
      conclusion: 'failure',
      steps: [{ name: failedStep, conclusion: 'failure' }],
    }],
  }]);
  // The shared gh coordinator prepends its shim to PATH when bash starts;
  // re-prepend the fixture inside the shell so this test remains hermetic.
  const result = spawnSync('bash', ['-euo', 'pipefail', '-c', `PATH="${bin}:$PATH"\n${PREFLIGHT}`], {
    cwd: path.dirname(WORKFLOW),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      GITHUB_OUTPUT: output,
      REPO: 'owner/repo',
      EVENT_NAME: 'workflow_run',
      DISPATCH_PR: '',
      RUN_ID: '123',
      RUN_SHA: 'headsha',
      RUN_BRANCH: 'fix/redcheck-test',
      FAIL_MODE: mode === 'check-api-unavailable' ? 'check-runs' : mode === 'jobs-api-unavailable' ? 'jobs' : '',
      JOBS_JSON: jobs,
    },
  });
  const githubOutput = readFileSync(output, 'utf8');
  const ghCalls = readFileSync(calls, 'utf8');
  rmSync(root, { recursive: true, force: true });
  return { result, githubOutput, ghCalls };
}

describe('pr-redcheck-fixer preflight classifies the consolidated tests job', () => {
  it.each([
    ['current all-events body contract', 'body-contract'],
    ['origin/main pull-requests body contract', 'body-contract-compat'],
  ] as const)('skips a %s failure before any fixer job can run', (_label, mode) => {
    const { result, githubOutput, ghCalls } = runPreflight(mode);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(githubOutput).toContain('actionable=false');
    expect(githubOutput).not.toContain('actionable=true');
    expect(ghCalls).not.toMatch(/pr (comment|edit)/);
  });

  it.each([
    ['current Claude review gate', 'review-gate'],
    ['origin/main Codex review gate', 'review-gate-compat'],
  ] as const)('skips a %s failure before any fixer job can run', (_label, mode) => {
    const { result, githubOutput, ghCalls } = runPreflight(mode);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(githubOutput).toContain('actionable=false');
    expect(githubOutput).not.toContain('actionable=true');
    expect(ghCalls).not.toMatch(/pr (comment|edit)/);
  });

  it('keeps a real Vitest failure actionable', () => {
    const { result, githubOutput, ghCalls } = runPreflight('test');
    expect(result.status, `${result.stdout}\n${result.stderr}\n${ghCalls}`).toBe(0);
    expect(githubOutput, `${result.stdout}\n${result.stderr}\n${ghCalls}`).toContain('actionable=true');
    expect(githubOutput).toContain('failed_run_id=123');
  });

  it.each([
    ['tsc/source gate', 'tsc'],
    ['source guard', 'source-guard'],
  ] as const)('keeps a verified %s failure actionable', (_label, mode) => {
    const { result, githubOutput } = runPreflight(mode);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(githubOutput).toContain('actionable=true');
  });

  it('fails closed when the check-runs API is unavailable', () => {
    const { result, githubOutput, ghCalls } = runPreflight('check-api-unavailable');
    expect(result.status, `${result.stdout}\n${result.stderr}\n${ghCalls}`).not.toBe(0);
    expect(githubOutput).not.toContain('actionable=true');
  });

  it('fails closed when the step-level jobs API is unavailable', () => {
    const { result, githubOutput, ghCalls } = runPreflight('jobs-api-unavailable');
    expect(result.status, `${result.stdout}\n${result.stderr}\n${ghCalls}`).not.toBe(0);
    expect(githubOutput).not.toContain('actionable=true');
  });
});
