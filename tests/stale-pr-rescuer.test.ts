import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOW = readFileSync(new URL('../.github/workflows/stale-pr-rescuer.yml', import.meta.url), 'utf8');

function decisionBlock(): string {
  const start = WORKFLOW.indexOf('            IMPORTANT_MARKER_STATUS=1');
  const end = WORKFLOW.indexOf('            echo "::warning::PR #$N STALLED', start);
  expect(start, 'stale-pr-rescuer marker guard not found').toBeGreaterThanOrEqual(0);
  expect(end, 'stale-pr-rescuer class decision block not found').toBeGreaterThan(start);
  return WORKFLOW.slice(start, end)
    .split('\n')
    .map((line) => line.startsWith('          ') ? line.slice(10) : line)
    .join('\n');
}

function runDecision({ tests, lastCid }: { tests: string; lastCid: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'stale-pr-rescuer-marker-error-'));
  try {
    const grep = join(dir, 'grep');
    writeFileSync(grep, '#!/bin/sh\nexit 2\n');
    chmodSync(grep, 0o755);
    const script = [
      'set -uo pipefail',
      'for item in 1; do',
      decisionBlock(),
      'done',
      'printf \'CLASS=%s\\n\' "${CLASS:-}"',
    ].join('\n');
    const output = execFileSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH || ''}`,
        LAST_BODY: '🔴 Important: marker fixture',
        TESTS_CONCL: tests,
        TESTS_PENDING: '0',
        LAST_CID: lastCid,
        HEAD: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        BRANCH: 'fix/fixture',
      },
    });
    return output;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('stale-pr-rescuer — un errore PCRE non spegne le classi indipendenti (#8015)', () => {
  it('usa capture jq in forma compatibile senza optional chaining', () => {
    expect(WORKFLOW).toContain('try (capture("/actions/runs/(?<id>[1-9][0-9]*)").id) catch ""');
    expect(WORKFLOW).not.toContain('capture("/actions/runs/(?<id>[1-9][0-9]*)")?.id');
  });

  it('mantiene raggiungibile la Classe A quando il guard marker esce 2', () => {
    expect(runDecision({
      tests: 'success',
      lastCid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    })).toContain('CLASS=A');
  });

  it('mantiene raggiungibile la Classe C quando il guard marker esce 2', () => {
    expect(runDecision({
      tests: 'failure',
      lastCid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })).toContain('CLASS=C');
  });
});

describe('stale-pr-rescuer — classe D (conflitto) prima delle altre (#10608)', () => {
  it('una PR con has-conflicts è classe D anche con vitest rosso e 🔴 sulla HEAD', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stale-pr-rescuer-class-d-'));
    try {
      const script = [
        'set -uo pipefail',
        'for item in 1; do',
        decisionBlock(),
        'done',
        'printf \'CLASS=%s\\n\' "${CLASS:-}"',
      ].join('\n');
      const output = execFileSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          LAST_BODY: 'PR body:L3: 🔴 Important: [funnel] fixture',
          TESTS_CONCL: 'none',
          TESTS_PENDING: '0',
          LAST_CID: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          HEAD: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          BRANCH: 'fix/fixture',
          HAS_CONFLICTS: 'true',
        },
      });
      expect(output).toContain('CLASS=D');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function actionBlock(): string {
  const start = WORKFLOW.indexOf('            posted=$("$TRUSTED_GH_BIN" api --paginate "repos/$REPO/issues/$N/comments');
  const end = WORKFLOW.indexOf('          done\n          echo "Scan completo."', start);
  expect(start, 'stale-pr-rescuer action block not found').toBeGreaterThanOrEqual(0);
  expect(end, 'stale-pr-rescuer loop end not found').toBeGreaterThan(start);
  return WORKFLOW.slice(start, end)
    .split('\n')
    .map((line) => line.startsWith('          ') ? line.slice(10) : line)
    .join('\n');
}

type ActionRun = { calls: string[]; comments: string[] };

function runAction({ cls, priorComments, rerunId, rerunOk = true }: {
  cls: string; priorComments: string[]; rerunId?: string; rerunOk?: boolean;
}): ActionRun {
  const dir = mkdtempSync(join(tmpdir(), 'stale-pr-rescuer-action-'));
  try {
    const gh = join(dir, 'gh');
    const log = join(dir, 'calls.log');
    const commentsOut = join(dir, 'comments.log');
    writeFileSync(join(dir, 'posted.json'), JSON.stringify(priorComments.map((body) => ({ body }))));
    writeFileSync(gh, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
case "$1 $2" in
  "api --paginate") cat "${join(dir, 'posted.json')}" ;;
  "run rerun") [ "${rerunOk ? '1' : '0'}" = 1 ] || exit 1 ;;
  "pr comment")
    while [ $# -gt 0 ]; do
      if [ "$1" = "--body" ]; then printf '%s\\n<<END>>\\n' "$2" >> "${commentsOut}"; fi
      shift
    done ;;
esac
exit 0
`);
    chmodSync(gh, 0o755);
    const checks = rerunId
      ? JSON.stringify({ check_runs: [{
        id: 1, name: 'vitest (unit + integration)', status: 'completed', conclusion: 'failure',
        head_sha: 'a'.repeat(40), created_at: '2026-09-30T10:00:00Z',
        details_url: `https://github.com/o/r/actions/runs/${rerunId}/job/2`,
      }] })
      : JSON.stringify({ check_runs: [] });
    const script = [
      'set -uo pipefail',
      'for item in 1; do',
      actionBlock(),
      'done',
    ].join('\n');
    execFileSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TRUSTED_GH_BIN: gh,
        REPO: 'o/r',
        N: '10608',
        HEAD: 'a'.repeat(40),
        BRANCH: 'fix/issue-10544',
        CLASS: cls,
        REASON: 'fixture reason',
        RESCUE: 'fixture rescue',
        CI_CHECK_NAME: 'vitest (unit + integration)',
        LEGACY_CI_CHECK_NAME: 'vitest execution',
        checks,
      },
    });
    const read = (file: string) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
    return {
      calls: read(log).split('\n').filter(Boolean),
      comments: read(commentsOut).split('<<END>>\n').filter((c) => c.trim()),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('stale-pr-rescuer — un commento per (classe, head), anche quando il rerun non può partire', () => {
  const full = (cls: string) => `<!-- stale-pr-rescuer class=${cls} head=aaaaaaa -->`;
  const pending = (cls: string) => `<!-- stale-pr-rescuer class=${cls} head=aaaaaaa pending -->`;

  it('REGRESSIONE #10608: senza run da rilanciare il primo commento porta il marker pending', () => {
    const run = runAction({ cls: 'C', priorComments: [] });
    expect(run.comments).toHaveLength(1);
    expect(run.comments[0]).toContain(pending('C'));
  });

  it('REGRESSIONE #10608: al giro dopo, stesso stallo e stesso esito → nessun commento nuovo', () => {
    const run = runAction({ cls: 'C', priorComments: [`🔧 stale-review\n${pending('C')}`] });
    expect(run.comments).toHaveLength(0);
    expect(run.calls.some((c) => c.startsWith('pr comment'))).toBe(false);
  });

  it('se il rerun riesce dopo un pending, chiude la coppia con un commento breve', () => {
    const run = runAction({ cls: 'C', priorComments: [pending('C')], rerunId: '36688879127' });
    expect(run.calls).toContain('run rerun 36688879127 --repo o/r');
    expect(run.comments).toHaveLength(1);
    expect(run.comments[0]).toContain(full('C'));
    expect(run.comments[0]).not.toContain('Classe:');
  });

  it('marker pieno già presente → nessuna azione', () => {
    const run = runAction({ cls: 'C', priorComments: [full('C')], rerunId: '1' });
    expect(run.calls.filter((c) => !c.startsWith('api'))).toEqual([]);
  });

  it.each(['B', 'D'])('classe %s: nessun rerun (non produce un verdetto nuovo), commento con marker pieno', (cls) => {
    const run = runAction({ cls, priorComments: [], rerunId: '36688879127' });
    expect(run.calls.some((c) => c.startsWith('run rerun'))).toBe(false);
    expect(run.comments).toHaveLength(1);
    expect(run.comments[0]).toContain(full(cls));
  });

  it('classe A con rerun riuscito: marker pieno al primo commento', () => {
    const run = runAction({ cls: 'A', priorComments: [], rerunId: '42' });
    expect(run.calls).toContain('run rerun 42 --repo o/r');
    expect(run.comments[0]).toContain(full('A'));
  });
});
