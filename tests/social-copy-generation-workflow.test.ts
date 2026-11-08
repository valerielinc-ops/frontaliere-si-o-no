import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function generationOutcomeScript() {
  const workflow = YAML.parse(readFileSync(path.join(ROOT, '.github/workflows/social-copy-pack.yml'), 'utf8'));
  const step = workflow.jobs.generate.steps.find((candidate: { id?: string }) => candidate.id === 'generation_result');
  expect(step?.run).toEqual(expect.any(String));
  return String(step.run);
}

function runGenerationOutcome(fallbackReason: string) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'social-copy-generation-workflow-'));
  const output = path.join(directory, 'github-output.txt');
  const summary = path.join(directory, 'github-step-summary.txt');
  try {
    return {
      result: spawnSync('bash', ['--noprofile', '--norc', '-euo', 'pipefail', '-c', generationOutcomeScript()], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          CODEX_ALLOWED: 'false',
          CODEX_OUTCOME: 'skipped',
          CODEX_SUCCESS: 'false',
          FALLBACK_GENERATED: 'false',
          FALLBACK_PROVIDER: 'none',
          FALLBACK_REASON: fallbackReason,
          FALLBACK_FAILURES: 'none',
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          RUNNER_TEMP: directory,
        },
      }),
      output: readFileSync(output, 'utf8'),
      summary: readFileSync(summary, 'utf8'),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('social copy generation outcome', () => {
  it('defers cleanly when the free-provider rolling budget is exhausted', () => {
    const { result, output, summary } = runGenerationOutcome('free-fallback-weekly-budget-exhausted');

    expect(result.status).toBe(0);
    expect(output).toContain('pack_generated=false');
    expect(output).toContain('deferred=true');
    expect(summary).toContain('- Outcome: **deferred**');
    expect(result.stdout).toContain('free-provider budget window reopens');
  });

  it('keeps provider failures blocking when no pack was generated', () => {
    const { result, output, summary } = runGenerationOutcome('all-free-models-failed');

    expect(result.status).not.toBe(0);
    expect(output).toContain('deferred=false');
    expect(summary).toContain('- Outcome: **failure**');
    expect(result.stdout).toContain('Social copy generation produced no validated pack');
  });
});
