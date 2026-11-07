import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, '.github/workflows/translate-pending-budget-benchmark.yml');
const SCRIPT_PATH = path.join(ROOT, 'scripts/ci/translate-pending-budget-benchmark.mjs');

function workflow() {
  return YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8')) as {
    on: {
      push?: { branches?: string[]; paths?: string[] };
      workflow_dispatch: { inputs: Record<string, { default?: string; type?: string; required?: boolean }> };
    };
    jobs: Record<string, { 'timeout-minutes': number; env?: Record<string, string>; steps: Array<{ name?: string; run?: string; uses?: string; with?: Record<string, string>; env?: Record<string, string>; if?: string }> }>;
  };
}

describe('translate-pending budget benchmark', () => {
  it('is manual, ref-selectable and retains the production job cap', () => {
    const parsed = workflow();
    expect(parsed.on.push?.branches).toContain('fix/issue-17555');
    expect(parsed.on.push?.paths).toContain('.github/workflows/translate-pending-budget-benchmark.yml');
    expect(parsed.on.workflow_dispatch.inputs.source_ref).toMatchObject({ type: 'string', required: true });
    expect(parsed.on.workflow_dispatch.inputs.phase).toMatchObject({ type: 'choice', required: true });
    expect(parsed.jobs.benchmark['timeout-minutes']).toBe(350);
    expect(parsed.jobs.benchmark.env?.BENCHMARK_REPORT).toBe('${{ github.workspace }}/translate-pending-budget-benchmark.json');
    expect(parsed.jobs.benchmark.env?.BENCHMARK_REPORT).not.toContain('runner.temp');
    const checkout = parsed.jobs.benchmark.steps.find((step) => step.name === 'Checkout benchmark ref');
    expect(checkout?.uses).toBe('actions/checkout@v7');
    expect(checkout?.with?.ref).toBe("${{ inputs.source_ref || github.sha }}");
  });

  it('runs the real lane and every persistence barrier against a local remote', () => {
    const steps = workflow().jobs.benchmark.steps;
    const names = steps.map((step) => step.name);
    for (const required of [
      'Prepare isolated benchmark remote',
      'Run initial assembly',
      'Capture before statistics',
      'Run budget gate',
      'Run Phase 2d title lane',
      'Run Phase 2e description lane',
      'Commit selected repair lane',
      'Commit after statistics',
      'Regenerate locale slugs',
      'Commit locale slugs',
      'Complete translation deploy handoff',
      'Finalize benchmark report',
    ]) expect(names).toContain(required);

    const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
    expect(source).toContain('same-population anchor');
    expect(source).toContain('candidateFingerprint');
    expect(source).toContain('underJobCap');
    expect(source).toContain("candidateCountBefore > 0");
    expect(steps.find((step) => step.name === 'Commit selected repair lane')?.run).toContain('git-commit-data.sh --slice-only');
    expect(steps.find((step) => step.name === 'Commit after statistics')?.env?.TRANSLATION_STATS_AFTER_TREE).toBe('1');
    expect(steps.find((step) => step.name === 'Complete translation deploy handoff')?.run).toContain('validate-translation-completeness.mjs');
  });
});
