import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import YAML from 'yaml';
import { exportResponseArtifact, prepareResponseArtifact, MAX_RESPONSE_BYTES } from '../.github/actions/claude-codex-fallback/response-artifact.mjs';

interface ActionStep { id?: string; name?: string; run?: string }
interface WorkflowStep { uses?: string; with?: Record<string, string> }
const action = YAML.parse(readFileSync(resolve('.github/actions/claude-codex-fallback/action.yml'), 'utf8')) as {
  inputs: { response_artifact: { default: string } };
  runs: { steps: ActionStep[] };
};
function stepScript(predicate: (step: ActionStep) => boolean): string {
  const script = action.runs.steps.find(predicate)?.run;
  if (!script) throw new Error('Expected action shell step');
  return script;
}
const helper = resolve('.github/actions/claude-codex-fallback/response-artifact.mjs');
const roots: string[] = [];
function fixture() {
  const runnerTemp = mkdtempSync(join(tmpdir(), 'codex-response-'));
  roots.push(runnerTemp);
  const home = join(runnerTemp, 'codex-home.fixture');
  const scratchRoot = join(home, 'scratch');
  mkdirSync(scratchRoot, { recursive: true });
  return { runnerTemp, home, scratchRoot, filename: 'redflag-response.md' };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('declared Codex response handoff', () => {
  it.each([0, 1, 124])('exports the real action response before cleanup after model exit %i', status => {
    const f = fixture();
    const runtime = join(f.runnerTemp, 'trusted-runtime');
    mkdirSync(join(runtime, 'action'), { recursive: true });
    copyFileSync(helper, join(runtime, 'action/response-artifact.mjs'));
    prepareResponseArtifact(f);
    const response = '`source:L1` — disputed: current source proves the finding is obsolete.\n';
    writeFileSync(join(f.scratchRoot, f.filename), response);
    const codex = stepScript(step => step.id === 'codex');
    const exportBlock = codex.match(/if \[ -n "\$CODEX_RESPONSE_ARTIFACT" \]; then\n[\s\S]*?\nfi/g)
      ?.find(block => block.includes(' export '));
    expect(exportBlock).toBeDefined();
    expect(codex.indexOf(exportBlock!)).toBeGreaterThan(codex.indexOf('\nstop_bridge\n'));
    const cleanup = stepScript(step => step.name === 'Cleanup ephemeral Codex subscription auth');
    const output = execFileSync('/bin/bash', ['-c', `${exportBlock}\nprintf 'model_status=%s\\n' "$codex_status"\n${cleanup}`], {
      env: { ...process.env, CODEX_RESPONSE_ARTIFACT: f.filename, runner_temp: f.runnerTemp, scratch_dir: f.scratchRoot,
        runtime_root: runtime, node_realpath: process.execPath, codex_status: String(status),
        CODEX_HOME: f.home, RUNNER_TEMP: f.runnerTemp, TRUSTED_NODE: process.execPath }, encoding: 'utf8',
    });
    expect(output).toContain(`model_status=${status}`);
    expect(readFileSync(join(f.runnerTemp, f.filename), 'utf8')).toBe(response);
    expect(existsSync(f.home)).toBe(false);
  });

  it('removes stale host output and reports a missing response without manufacturing one', () => {
    const f = fixture();
    writeFileSync(join(f.runnerTemp, f.filename), 'old response');
    prepareResponseArtifact(f);
    expect(exportResponseArtifact(f)).toEqual({ status: 'missing', bytes: 0 });
    expect(existsSync(join(f.runnerTemp, f.filename))).toBe(false);
  });

  it.each(['../outside.md', '/absolute.md', 'nested/file.md', '.hidden', 'bad\nname'])('rejects unsafe basename %j', filename => {
    const f = fixture();
    expect(() => prepareResponseArtifact({ ...f, filename })).toThrow('plain basename');
  });

  it.each(['symlink', 'hardlink'])('rejects a %s source without copying protected content', kind => {
    const f = fixture();
    const outside = join(f.runnerTemp, 'protected.txt');
    writeFileSync(outside, 'protected fixture');
    const source = join(f.scratchRoot, f.filename);
    if (kind === 'symlink') symlinkSync(outside, source);
    else linkSync(outside, source);
    expect(() => exportResponseArtifact(f)).toThrow();
    expect(existsSync(join(f.runnerTemp, f.filename))).toBe(false);
  });

  it('rejects a substituted scratch directory', () => {
    const f = fixture();
    rmSync(f.scratchRoot, { recursive: true });
    symlinkSync(f.runnerTemp, f.scratchRoot);
    expect(() => exportResponseArtifact(f)).toThrow('scratch directory');
  });

  it('fails on an oversized response or a destination directory without recursive deletion', () => {
    const f = fixture();
    writeFileSync(join(f.scratchRoot, f.filename), Buffer.alloc(MAX_RESPONSE_BYTES + 1));
    expect(() => exportResponseArtifact(f)).toThrow('size limit');
    writeFileSync(join(f.scratchRoot, f.filename), 'valid response');
    mkdirSync(join(f.runnerTemp, f.filename));
    expect(() => prepareResponseArtifact(f)).toThrow();
    expect(() => exportResponseArtifact(f)).toThrow();
    expect(existsSync(join(f.runnerTemp, f.filename))).toBe(true);
  });

  it('keeps the handoff opt-in and snapshots its helper while retaining sandbox confinement', () => {
    const snapshot = stepScript(step => step.id === 'runtime_snapshot');
    const codex = stepScript(step => step.id === 'codex');
    const workflow = YAML.parse(readFileSync(resolve('.github/workflows/pr-redflag-fixer.yml'), 'utf8')) as {
      jobs: Record<string, { steps?: WorkflowStep[] }>;
    };
    const caller = Object.values(workflow.jobs).flatMap(job => job.steps || [])
      .find(step => step.uses === './.github/actions/claude-codex-fallback');
    expect(action.inputs.response_artifact.default).toBe('');
    expect(snapshot).toContain('sanitize-git-config.mjs response-artifact.mjs; do');
    expect(snapshot).toContain('prepare "$CODEX_RESPONSE_ARTIFACT" "$runner_temp"');
    expect(caller?.with?.response_artifact).toBe('redflag-response.md');
    expect(codex).toContain('RUNNER_TEMP="$scratch_dir"');
    expect(codex).toContain('permissions.codex-fallback.network.enabled=false');
  });
});
