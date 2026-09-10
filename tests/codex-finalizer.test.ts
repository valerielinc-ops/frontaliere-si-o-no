import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const action = readFileSync(resolve('.github/actions/claude-codex-fallback/action.yml'), 'utf8');
const section = action.split('    - name: Record structured Codex fallback evidence')[1].split('\n    - name: Cleanup ephemeral Codex subscription auth')[0];
const shell = section.split('      run: |\n')[1].replace(/\$\{\{ steps\.(?:runtime_snapshot|preflight|runtime)\.outcome \}\}/g, 'success');
function finalize(mode = 'success') {
  const root = mkdtempSync(join(tmpdir(), 'codex-finalizer-'));
  const evidence = join(root, 'evidence');
  const outputs = join(root, 'outputs');
  if (mode === 'writer-error') mkdirSync(evidence);
  try {
    const result = spawnSync('/bin/bash', ['-c', shell], {
      encoding: 'utf8', env: {
        PATH: '/usr/bin:/bin', TRUSTED_NODE: process.execPath, RUNTIME_ROOT: resolve('scripts'),
        PREFLIGHT_FALLBACK: mode === 'missing-evidence' || mode === 'no-fallback' ? 'false' : 'true',
        PREFLIGHT_TRIGGER: 'preflight-quota', RUNTIME_FALLBACK: mode === 'missing-evidence' ? 'true' : 'false',
        RUNTIME_TRIGGER: 'runtime-429', CODEX_OUTCOME: mode === 'codex-failure' ? 'failure' : 'success',
        EVIDENCE_FILE: evidence, EXEC_FILE: '', GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: '/dev/null',
      },
    });
    let output = '';
    try { output = readFileSync(outputs, 'utf8'); } catch { /* No success outputs is expected on failure. */ }
    return { status: result.status, output, stderr: result.stderr };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
describe('actual Codex evidence finalizer', () => {
  it.each(['writer-error', 'missing-evidence'])('does not publish success after %s', mode => {
    const result = finalize(mode);
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain('fallback_success=true');
  });
  it('publishes success only with a successfully written evidence file', () => {
    const result = finalize();
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain('fallback_evidence_file=');
    expect(result.output).toContain('fallback_success=true');
  });
  it('retains a failed Codex outcome in the evidence and outputs', () => {
    const result = finalize('codex-failure');
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain('fallback_success=false');
    expect(result.output).toContain('fallback_used=true');
  });
  it('keeps the ordinary Claude path valid without Codex evidence', () => {
    const result = finalize('no-fallback');
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain('fallback_used=false');
    expect(result.output).not.toContain('fallback_evidence_file=');
  });
});
