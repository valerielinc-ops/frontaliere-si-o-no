import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DELIVERY_STATUS,
  classifyWorkflowOutcome,
  createDeliveryBaseline,
  evaluatePrDelivery,
  normalizeDeliveryEvidence,
  normalizePrList,
} from '../scripts/ci/lib/pr-delivery-evidence.mjs';

const REPO = 'valerielinc-ops/frontaliere-si-o-no';
const BRANCH = 'fix/issue-42';
const RUN = {
  repo: REPO,
  issue: 42,
  branch: BRANCH,
  runId: '35440000000',
  runAttempt: '1',
  runStartedAt: '2026-09-19T10:00:00Z',
};

function pr(overrides: Record<string, unknown> = {}) {
  return {
    number: 700,
    state: 'OPEN',
    headRefName: BRANCH,
    headRefOid: 'sha-before',
    headRepository: { nameWithOwner: REPO },
    createdAt: '2026-09-19T09:00:00Z',
    updatedAt: '2026-09-19T09:30:00Z',
    mergedAt: null,
    ...overrides,
  };
}

function baseline(prs: unknown[] = [pr()]) {
  const result = createDeliveryBaseline({ ...RUN, prs });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.baseline;
}

function evaluate(base: unknown, currentPrs: unknown[], runAttempt = RUN.runAttempt) {
  return evaluatePrDelivery({
    baseline: base,
    currentPrs,
    ...RUN,
    runAttempt,
  });
}

describe('pr-delivery-evidence', () => {
  it('non tratta una PR MERGED storica aggiornata come delivery corrente', () => {
    const old = pr({
      state: 'MERGED',
      headRefOid: 'sha-old',
      updatedAt: '2026-09-19T10:15:00Z',
      mergedAt: '2026-09-18T12:00:00Z',
    });
    expect(evaluate(baseline([old]), [old])).toEqual({
      status: DELIVERY_STATUS.NONE,
      reason: 'no-current-delivery-evidence',
      prNumber: null,
    });
  });

  it('prova una nuova PR soltanto se createdAt appartiene al tentativo', () => {
    const current = pr({ number: 701, createdAt: '2026-09-19T10:04:00Z', updatedAt: '2026-09-19T10:04:00Z' });
    expect(evaluate(baseline(), [current])).toMatchObject({
      status: DELIVERY_STATUS.DELIVERED,
      reason: 'new-pr-this-attempt',
      prNumber: 701,
    });
    const beforeRun = { ...current, createdAt: '2026-09-19T09:59:00Z' };
    expect(evaluate(baseline(), [beforeRun]).status).toBe(DELIVERY_STATUS.UNAVAILABLE);
  });

  it('non considera delivery una nuova PR chiusa senza merge', () => {
    const closed = pr({
      number: 702,
      state: 'CLOSED',
      createdAt: '2026-09-19T10:04:00Z',
      updatedAt: '2026-09-19T10:05:00Z',
    });
    expect(evaluate(baseline(), [closed])).toEqual({
      status: DELIVERY_STATUS.NONE,
      reason: 'no-current-delivery-evidence',
      prNumber: null,
    });
  });

  it('rifiuta una PR omonima proveniente da un fork', () => {
    const forkPr = pr({
      number: 703,
      headRepository: { nameWithOwner: 'fork-owner/frontaliere-si-o-no' },
      createdAt: '2026-09-19T10:04:00Z',
      updatedAt: '2026-09-19T10:04:00Z',
    });
    expect(evaluate(baseline(), [forkPr])).toEqual({
      status: DELIVERY_STATUS.UNAVAILABLE,
      reason: 'pr-head-repository-mismatch',
      prNumber: null,
    });
  });

  it('prova una delivery OPEN solo quando cambia headSha, non con updatedAt da solo', () => {
    const unchanged = pr({ updatedAt: '2026-09-19T10:20:00Z' });
    expect(evaluate(baseline(), [unchanged]).status).toBe(DELIVERY_STATUS.NONE);
    const changed = { ...unchanged, headRefOid: 'sha-after' };
    expect(evaluate(baseline(), [changed])).toMatchObject({
      status: DELIVERY_STATUS.DELIVERED,
      reason: 'open-head-changed-this-attempt',
      prNumber: 700,
    });
  });

  it('prova la transizione OPEN → MERGED nel tentativo', () => {
    const current = pr({
      state: 'MERGED',
      mergedAt: '2026-09-19T10:12:00Z',
      updatedAt: '2026-09-19T10:12:00Z',
    });
    expect(evaluate(baseline(), [current])).toMatchObject({
      status: DELIVERY_STATUS.DELIVERED,
      reason: 'open-to-merged-this-attempt',
      prNumber: 700,
    });
  });

  it('rifiuta un baseline appartenente a un attempt precedente', () => {
    expect(evaluate(baseline(), [pr()], '2')).toEqual({
      status: DELIVERY_STATUS.UNAVAILABLE,
      reason: 'baseline-runAttempt-mismatch',
      prNumber: null,
    });
  });

  it('non fabbrica zero da record malformed o lista cap/troncata', () => {
    expect(evaluate(baseline(), [{}]).status).toBe(DELIVERY_STATUS.UNAVAILABLE);
    expect(normalizePrList(Array.from({ length: 100 }, () => pr()), { branch: BRANCH }).reason).toBe('pr-list-capped');
  });

  it('mantiene skipped/cancelled distinti dalla delivery', () => {
    expect(classifyWorkflowOutcome({
      actionOutcome: 'skipped',
      delivery: { status: DELIVERY_STATUS.UNAVAILABLE },
    })).toMatchObject({ classification: 'skipped', exitCode: 0 });
    expect(classifyWorkflowOutcome({
      actionOutcome: 'cancelled',
      delivery: { status: DELIVERY_STATUS.UNAVAILABLE },
    })).toMatchObject({ classification: 'cancelled', exitCode: 0 });
  });

  it('rifiuta prNumber coercibili ma non interi espliciti nel sidecar', () => {
    for (const prNumber of [true, [1], 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(normalizeDeliveryEvidence({
        status: DELIVERY_STATUS.DELIVERED,
        prNumber,
      })).toEqual({
        status: DELIVERY_STATUS.UNAVAILABLE,
        reason: 'evidence-pr-number-invalid',
        prNumber: null,
      });
    }
    expect(normalizeDeliveryEvidence({
      status: DELIVERY_STATUS.DELIVERED,
      prNumber: '701',
    })).toEqual({
      status: DELIVERY_STATUS.DELIVERED,
      reason: null,
      prNumber: 701,
    });
  });

  it('con un lookup REST/gh fallito restituisce unavailable, non verified-none', () => {
    const temp = mkdtempSync(join(tmpdir(), 'pr-delivery-gh-'));
    const baselineFile = join(temp, 'baseline.json');
    const fakeGh = join(temp, 'gh');
    const helper = fileURLToPath(new URL('../scripts/ci/lib/pr-delivery-evidence.mjs', import.meta.url));
    try {
      writeFileSync(baselineFile, `${JSON.stringify(baseline())}\n`);
      writeFileSync(fakeGh, '#!/usr/bin/env node\nprocess.exit(42);\n');
      chmodSync(fakeGh, 0o755);
      const output = execFileSync(process.execPath, [helper, 'evaluate',
        '--baseline', baselineFile,
        '--repo', REPO,
        '--issue', '42',
        '--branch', BRANCH,
        '--run-id', RUN.runId,
        '--run-attempt', RUN.runAttempt,
      ], {
        env: { ...process.env, PATH: `${temp}:${process.env.PATH || ''}` },
        encoding: 'utf8',
      });
      expect(JSON.parse(output)).toEqual({
        status: DELIVERY_STATUS.UNAVAILABLE,
        reason: 'github-read-failed',
        prNumber: null,
      });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('failure senza delivery e success con lookup unknown restano non-verdi', () => {
    expect(classifyWorkflowOutcome({
      actionOutcome: 'failure',
      delivery: { status: DELIVERY_STATUS.NONE, reason: 'no-current-delivery-evidence' },
    })).toMatchObject({ classification: 'non-delivery', exitCode: 1 });
    expect(classifyWorkflowOutcome({
      actionOutcome: 'success',
      delivery: { status: DELIVERY_STATUS.UNAVAILABLE, reason: 'github-read-failed' },
    })).toMatchObject({ classification: 'unknown', exitCode: 1 });
    expect(classifyWorkflowOutcome({
      actionOutcome: 'success',
      delivery: {},
    })).toMatchObject({ classification: 'unknown', exitCode: 1, reason: 'evidence-status-invalid' });
    expect(classifyWorkflowOutcome({
      actionOutcome: 'success',
      delivery: { status: 'future-status' },
    })).toMatchObject({ classification: 'unknown', exitCode: 1, reason: 'evidence-status-invalid' });
    expect(classifyWorkflowOutcome({
      actionOutcome: 'success',
      delivery: { status: DELIVERY_STATUS.DELIVERED },
    })).toMatchObject({ classification: 'unknown', exitCode: 1, reason: 'evidence-pr-number-missing' });
  });

  it('il baseline conserva il file numerico legacy senza JSON wrapping', () => {
    const temp = mkdtempSync(join(tmpdir(), 'pr-delivery-baseline-'));
    const baselineFile = join(temp, 'baseline.json');
    const legacyFile = join(temp, 'legacy');
    const fakeGh = join(temp, 'gh');
    const helper = fileURLToPath(new URL('../scripts/ci/lib/pr-delivery-evidence.mjs', import.meta.url));
    try {
      writeFileSync(fakeGh, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'api') process.stdout.write(JSON.stringify({ runStartedAt: '${RUN.runStartedAt}', runAttempt: '${RUN.runAttempt}' }));
else process.stdout.write(JSON.stringify([${JSON.stringify(pr())}]));
`);
      chmodSync(fakeGh, 0o755);
      execFileSync(process.execPath, [helper, 'capture',
        '--repo', REPO,
        '--issue', '42',
        '--branch', BRANCH,
        '--run-id', RUN.runId,
        '--run-attempt', RUN.runAttempt,
        '--output', baselineFile,
        '--legacy-output', legacyFile,
      ], {
        env: { ...process.env, PATH: `${temp}:${process.env.PATH || ''}` },
        encoding: 'utf8',
      });
      expect(readFileSync(legacyFile, 'utf8')).toBe('700\n');
      expect(JSON.parse(readFileSync(baselineFile, 'utf8')).runAttempt).toBe('1');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('il terminal marker non posta pr-created/max-turns quando il lookup è unavailable', () => {
    const temp = mkdtempSync(join(tmpdir(), 'pr-delivery-marker-'));
    const baselineFile = join(temp, 'baseline.json');
    const executionFile = join(temp, 'execution.json');
    const fakeGh = join(temp, 'gh');
    const ghLog = join(temp, 'gh.log');
    const marker = fileURLToPath(new URL('../scripts/ci/mark-claude-terminal-outcome.mjs', import.meta.url));
    try {
      writeFileSync(baselineFile, `${JSON.stringify(baseline())}\n`);
      writeFileSync(executionFile, JSON.stringify([{ type: 'result', subtype: 'error_max_turns' }]));
      writeFileSync(fakeGh, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_GH_LOG, process.argv.slice(2).join(' ') + '\\n');
process.exit(42);
`);
      chmodSync(fakeGh, 0o755);
      execFileSync(process.execPath, [marker], {
        env: {
          ...process.env,
          PATH: `${temp}:${process.env.PATH || ''}`,
          ISSUE: '42',
          EXEC_FILE: executionFile,
          GH_REPO: REPO,
          GITHUB_RUN_ID: RUN.runId,
          GITHUB_RUN_ATTEMPT: RUN.runAttempt,
          PR_DELIVERY_BASELINE_FILE: baselineFile,
          FAKE_GH_LOG: ghLog,
        },
        encoding: 'utf8',
      });
      const calls = readFileSync(ghLog, 'utf8');
      expect(calls).toContain('pr list');
      expect(calls).not.toContain('issue comment');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
