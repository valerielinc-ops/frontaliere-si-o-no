import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = resolve(ROOT, 'scripts/ci/check-issue-fix-dispatch.mjs');
const ISSUE_NUMBER = 19752;

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function createFakeGh(directory: string) {
  const ghPath = join(directory, 'gh');
  writeFileSync(ghPath, `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_CALLS_FILE"
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  cat "$GH_LIVE_FILE"
  exit 0
fi
exit 64
`);
  chmodSync(ghPath, 0o755);
}

function runGate(mode: '--select' | '--verify', options: {
  frozen: Record<string, unknown>;
  event?: Record<string, unknown>;
  live?: Record<string, unknown>;
  expectedScopeFingerprint?: string;
  expectedIsDaily?: string;
  expectedItemId?: string;
}) {
  const directory = mkdtempSync(join(tmpdir(), 'issue-fix-dispatch-'));
  const snapshotPath = join(directory, 'snapshot.json');
  const eventPath = join(directory, 'event.json');
  const livePath = join(directory, 'live.json');
  const outputPath = join(directory, 'github-output');
  const callsPath = join(directory, 'gh-calls');
  writeJson(snapshotPath, options.frozen);
  writeJson(eventPath, { issue: options.event || options.frozen });
  writeJson(livePath, options.live || options.frozen);
  writeFileSync(callsPath, '');
  createFakeGh(directory);

  const result = spawnSync(process.execPath, [SCRIPT, mode], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH || ''}`,
      GH_REPO: 'owner/repo',
      ISSUE_NUMBER: String(ISSUE_NUMBER),
      ISSUE_FIX_SNAPSHOT_FILE: snapshotPath,
      ISSUE_FIX_EVENT_PATH: eventPath,
      GH_LIVE_FILE: livePath,
      GH_CALLS_FILE: callsPath,
      GITHUB_OUTPUT: outputPath,
      DISPATCH_SCOPE_FINGERPRINT: options.expectedScopeFingerprint || '',
      DISPATCH_IS_DAILY: options.expectedIsDaily || '',
      DISPATCH_ITEM_ID: options.expectedItemId || '',
    },
  });
  const output = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '';
  const calls = readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean);
  rmSync(directory, { recursive: true, force: true });
  return { ...result, output, calls };
}

function issue(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    number: ISSUE_NUMBER,
    state: 'OPEN',
    title: 'Fix stale issue-fix dispatch',
    body: 'Scope body',
    labels: [{ name: 'agent:fix' }],
    comments: [],
    ...overrides,
  };
}

function scopeFingerprint(current: Record<string, unknown>) {
  return createHash('sha256').update(JSON.stringify({
    number: current.number,
    state: current.state,
    title: current.title,
    body: current.body,
    dailyKey: '',
    selectedItemId: '',
  })).digest('hex');
}

function dailyInProgressIssue() {
  return issue({
    title: 'follow-up(daily:2026-09-09): 1 item — owner/repo',
    body: [
      '## Batch',
      '- Daily key: 2026-09-09 (Europe/Zurich)',
      '- State: sealed',
      '- Target repository: owner/repo',
      '',
      '## Item',
      '',
      '### FU-2026-09-09-001 — In progress',
      '- State: in-progress',
      '- Target file: `scripts/example.mjs`',
      '- Suggested action: keep `firstGuard()`',
      '- Acceptance token: `firstGuard()`',
      '',
    ].join('\n'),
  });
}

describe('issue-fix dispatch admission', () => {
  it('denies missing live routing and daily in-progress scopes before capabilities', () => {
    const frozen = issue();

    const stale = runGate('--verify', {
      frozen,
      event: frozen,
      live: issue({ labels: [] }),
      expectedScopeFingerprint: scopeFingerprint(frozen),
      expectedIsDaily: 'false',
    });
    expect(
      stale.status,
      JSON.stringify({ error: stale.error, signal: stale.signal, stdout: stale.stdout, stderr: stale.stderr }),
    ).toBe(0);
    expect(stale.output).toContain('proceed=false');
    expect(stale.output).toContain('stale=true');
    expect(stale.calls).toEqual([
      `issue view ${ISSUE_NUMBER} --repo owner/repo --json number,state,title,body,labels,comments`,
    ]);

    const inProgress = runGate('--select', { frozen: dailyInProgressIssue() });
    expect(inProgress.status).toBe(1);
    expect(inProgress.output).toContain('proceed=false');
    expect(inProgress.output).not.toContain('scope_fingerprint=');
    expect(inProgress.calls).toEqual([]);
  });
});
