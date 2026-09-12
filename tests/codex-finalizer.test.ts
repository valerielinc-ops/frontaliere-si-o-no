import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const action = readFileSync(resolve('.github/actions/claude-codex-fallback/action.yml'), 'utf8');
const section = action
  .split('    - name: Record structured Codex primary evidence')[1]
  .split('\n    - name: Cleanup ephemeral Codex subscription auth')[0];
const shell = section.split('      run: |\n')[1];

function finalize(mode = 'codex-success') {
  const root = mkdtempSync(join(tmpdir(), 'codex-finalizer-'));
  const evidence = join(root, 'evidence.md');
  const outputs = join(root, 'outputs');
  if (mode === 'writer-error') mkdirSync(evidence);
  const codexOutcome = mode === 'codex-success' || mode === 'writer-error' ? 'success' : mode === 'no-providers' ? 'skipped' : 'failure';
  const claudeOutcome = mode === 'claude-success' ? 'success'
    : mode === 'codex-failure-claude-failure' ? 'failure'
      : 'skipped';
  try {
    const result = spawnSync('/bin/bash', ['-c', shell], {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        TRUSTED_NODE: process.execPath,
        RUNTIME_ROOT: resolve('scripts'),
        CODEX_OUTCOME: codexOutcome,
        CLAUDE_OUTCOME: claudeOutcome,
        CODEX_OUTPUT: mode === 'codex-success' ? join(root, 'codex-output.txt') : '',
        EXEC_FILE: mode === 'claude-success' ? join(root, 'claude-execution.json') : '',
        EVIDENCE_FILE: evidence,
        GITHUB_OUTPUT: outputs,
        GITHUB_STEP_SUMMARY: '/dev/null',
        ...(mode === 'quota-held' ? {
          REPAIR_QUOTA_ADMIT: 'false',
          REPAIR_QUOTA_HELD: 'true',
        } : {}),
      },
    });
    let output = '';
    try { output = readFileSync(outputs, 'utf8'); } catch { /* No outputs after an evidence writer failure. */ }
    return { status: result.status, output, stderr: result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('actual Codex-primary/Claude-fallback finalizer', () => {
  it('publishes Codex success only with a successfully written evidence file', () => {
    const result = finalize();
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain('fallback_evidence_file=');
    expect(result.output).toContain('primary_success=true');
    expect(result.output).toContain('selected_provider=codex');
    expect(result.output).toContain('action_success=true');
    expect(result.output).toContain('claude_used=false');
  });

  it('does not publish provider success after an evidence writer failure', () => {
    const result = finalize('writer-error');
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain('action_success=true');
  });

  it('accepts Claude as the fallback after a failed Codex primary', () => {
    const result = finalize('claude-success');
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain('fallback_used=true');
    expect(result.output).toContain('fallback_success=true');
    expect(result.output).toContain('primary_success=false');
    expect(result.output).toContain('selected_provider=claude');
    expect(result.output).toContain('action_success=true');
    expect(result.output).not.toContain('fallback_evidence_file=/');
  });

  it('preserves a failed dual-provider outcome for the outer action', () => {
    const result = finalize('codex-failure-claude-failure');
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain('fallback_used=true');
    expect(result.output).toContain('fallback_success=false');
    expect(result.output).toContain('action_success=false');
  });

  it('does not claim success when both providers are skipped', () => {
    const result = finalize('no-providers');
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain('selected_provider=none');
    expect(result.output).toContain('action_success=false');
  });

  it('records a quota-held round as a successful provider-neutral no-op', () => {
    const result = finalize('quota-held');
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain('selected_provider=none');
    expect(result.output).toContain('action_success=true');
    expect(result.output).toContain('codex_outcome=skipped');
    expect(result.output).toContain('claude_outcome=skipped');
  });
});
