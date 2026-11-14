import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { selectedCandidateIssue } from '../scripts/ci/translate-pending-budget-benchmark.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, '.github/workflows/translate-pending-budget-benchmark.yml');
const PRODUCTION_WORKFLOW_PATH = path.join(ROOT, '.github/workflows/translate-pending-logic.yml');
const SCRIPT_PATH = path.join(ROOT, 'scripts/ci/translate-pending-budget-benchmark.mjs');

function workflow() {
  return YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8')) as {
    on: {
      pull_request?: { paths?: string[] };
      workflow_dispatch: { inputs: Record<string, { default?: string; type?: string; required?: boolean }> };
    };
    jobs: Record<string, { if?: string; 'timeout-minutes': number; env?: Record<string, string>; steps: Array<{ name?: string; run?: string; uses?: string; with?: Record<string, string>; env?: Record<string, string>; if?: string }> }>;
  };
}

function productionRepairLaneGate() {
  const parsed = YAML.parse(fs.readFileSync(PRODUCTION_WORKFLOW_PATH, 'utf8')) as {
    jobs: { translate: { steps: Array<{ id?: string; env?: Record<string, string> }> } };
  };
  return parsed.jobs.translate.steps.find((step) => step.id === 'repair_lane_budget');
}

function reportWith({ handoffState = 'complete', candidateFingerprintAfter = 'changed' } = {}) {
  const stages = [
    'budget-gate', 'assemble', 'stats-before', 'lane', 'lane-commit',
    'assemble-final', 'stats-after', 'slugs', 'slug-commit', 'handoff',
  ].map((name) => ({ name, status: 0, finishedAt: 1_000 }));
  const lane = stages.find((stage) => stage.name === 'lane');
  const handoff = stages.find((stage) => stage.name === 'handoff');
  Object.assign(lane!, {
    startedAt: 0,
    elapsedMs: 1_000,
    populationBefore: {
      phase: 'descriptions',
      fileCount: 1,
      jobCount: 1,
      candidateCount: 1,
      sliceFingerprint: 'slice-before',
      candidateFingerprint: 'candidates-before',
      candidateRefs: [{ relative: 'data/jobs/by-crawler/test.json', index: 0, locale: 'it' }],
    },
    populationAfter: {
      phase: 'descriptions',
      fileCount: 1,
      jobCount: 1,
      candidateCount: 1,
      sliceFingerprint: 'slice-after',
      candidateFingerprint: candidateFingerprintAfter,
    },
  });
  Object.assign(handoff!, { handoffState });
  Object.assign(lane!, { selectedLaneComplete: true });
  return {
    schemaVersion: 1,
    phase: 'descriptions',
    sourceRef: 'test',
    sourceCommit: 'test',
    runUrl: '',
    startedAt: 0,
    jobCapMs: 350 * 60_000,
    baseline: { runId: '', laneMinutes: null, note: '' },
    stages,
  };
}

function finalizeReport(report: ReturnType<typeof reportWith>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'translate-pending-budget-'));
  const reportPath = path.join(directory, 'report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`, 'utf8');
  const result = spawnSync(process.execPath, [SCRIPT_PATH, '--finalize', '--report', reportPath], {
    encoding: 'utf8',
  });
  return { result, report: JSON.parse(fs.readFileSync(reportPath, 'utf8')) };
}

describe('translate-pending budget benchmark', () => {
  it('rejects an unchanged source-copy title even when it clears the character floor', () => {
    const job = {
      sourceLang: 'de',
      title: 'Lagermitarbeiter Logistik 100%',
      titleByLocale: {
        de: 'Lagermitarbeiter Logistik 100%',
        it: 'Lagermitarbeiter Logistik 100%',
      },
    };

    expect(selectedCandidateIssue(job, 'titles', 'it'))
      .toBe('title still matches the repair-lane detector');
    expect(selectedCandidateIssue({
      ...job,
      titleByLocale: { ...job.titleByLocale, it: 'Magazziniere logistica 100%' },
    }, 'titles', 'it')).toBeNull();
  });

  it('is manual, ref-selectable and retains the production job cap', () => {
    const parsed = workflow();
    expect(parsed.on.pull_request).toBeUndefined();
    expect(parsed.on.workflow_dispatch.inputs.source_ref).toMatchObject({ type: 'string', required: true });
    expect(parsed.on.workflow_dispatch.inputs.phase).toMatchObject({ type: 'choice', required: true });
    expect(parsed.jobs.benchmark.if).toBeUndefined();
    expect(parsed.jobs.benchmark['timeout-minutes']).toBe(350);
    expect(parsed.jobs.benchmark.env?.BENCHMARK_REPORT).toBe('${{ github.workspace }}/translate-pending-budget-benchmark.json');
    expect(parsed.jobs.benchmark.env?.BENCHMARK_REPORT).not.toContain('runner.temp');
    expect(parsed.jobs.benchmark.env?.BENCHMARK_DISPATCH_REF)
      .toBe('${{ inputs.source_ref || github.sha }}');
    const checkout = parsed.jobs.benchmark.steps.find((step) => step.name === 'Checkout benchmark ref');
    expect(checkout?.uses).toBe('actions/checkout@v7');
    expect(checkout?.with?.ref).toBe('${{ inputs.source_ref || github.sha }}');
    expect(parsed.jobs.benchmark.steps.find((step) => step.name === 'Run Phase 2d title lane')?.if)
      .toBe("env.BENCHMARK_PHASE == 'titles'");
    expect(parsed.jobs.benchmark.steps.find((step) => step.name === 'Run Phase 2e description lane')?.if)
      .toBe("env.BENCHMARK_PHASE == 'descriptions'");
    expect(parsed.jobs.benchmark.steps.find((step) => step.name === 'Upload benchmark report')?.with?.path)
      .toBe('${{ github.workspace }}/translate-pending-budget-benchmark.json');
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

    const resolveBudget = steps.find((step) => step.name === 'Resolve Codex reserve budget');
    expect(resolveBudget?.env?.FREE_TRANSLATE_CODEX_MAX_CALLS_REPO)
      .toBe('${{ vars.FREE_TRANSLATE_CODEX_MAX_CALLS }}');
    expect(resolveBudget?.run).toContain('FREE_TRANSLATE_CODEX_MAX_CALLS=350');
    expect(names.indexOf('Resolve Codex reserve budget'))
      .toBeGreaterThan(names.indexOf('Load Remote Config secrets'));
    expect(names.indexOf('Resolve Codex reserve budget'))
      .toBeLessThan(names.indexOf('Start Codex reserve broker'));
    const prepareRemote = steps.find((step) => step.name === 'Prepare isolated benchmark remote')?.run;
    expect(prepareRemote).toContain('receive.shallowUpdate true');
    expect(prepareRemote).toContain('git push --no-thin');
    const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
    expect(source).toContain('same-population anchor');
    expect(source).toContain('candidateFingerprint');
    expect(source).toContain('underJobCap');
    expect(source).toContain('Selected-lane handoff');
    expect(steps.find((step) => step.name === 'Complete translation deploy handoff')?.run).toContain('--verify-selected-lane');
    expect(source).toContain("candidateCountBefore > 0");
    expect(steps.find((step) => step.name === 'Commit selected repair lane')?.run).toContain('git-commit-data.sh --slice-only');
    expect(steps.find((step) => step.name === 'Commit after statistics')?.env?.TRANSLATION_STATS_AFTER_TREE).toBe('1');
    expect(steps.find((step) => step.name === 'Complete translation deploy handoff')?.run).toContain('validate-translation-completeness.mjs');
  });

  it('keeps the pre-merge budget gate bound to the production step contract', () => {
    const production = productionRepairLaneGate();
    const benchmark = workflow().jobs.benchmark.steps.find((step) => step.name === 'Run budget gate');

    expect(workflow().on.pull_request).toBeUndefined();
    expect(workflow().on.workflow_dispatch).toBeDefined();
    expect(benchmark?.env?.REPAIR_LANE_DEADLINE_MS).toBe(production?.env?.REPAIR_LANE_DEADLINE_MS);
    expect(benchmark?.env?.REPAIR_LANE_MIN_REMAINING_MS).toBe(production?.env?.REPAIR_LANE_MIN_REMAINING_MS);
  });

  it('rejects fallback handoff evidence even when every stage exits successfully', () => {
    const { result, report } = finalizeReport(reportWith({ handoffState: 'fallback' }));
    expect(result.status).toBe(1);
    expect(report.accepted).toBe(false);
  });

  it('rejects a no-op lane whose candidate fingerprint is unchanged', () => {
    const { result, report } = finalizeReport(reportWith({ candidateFingerprintAfter: 'candidates-before' }));
    expect(result.status).toBe(1);
    expect(report.accepted).toBe(false);
  });
});
