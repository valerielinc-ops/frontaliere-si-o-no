import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

import { runWithConcurrency } from '../../scripts/enrich-related-search-clusters.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const WORKFLOWS_DIR = resolve(ROOT, '.github/workflows');

// The Codex broker runs ONE request at a time at max reasoning effort
// (~116 s each, run 36230809455), so a global Codex preference is only safe
// where the worst-case number of calls per run is bounded well inside the job
// timeout. Anything that scales with items (clusters, articles, cohorts, pings)
// must not prefer Codex globally: send-newsletter did, and run 36407582573
// spent 5h51 on ~672 serial calls and sent nothing.
const BOUNDED_CODEX_PREFER = new Map([
  // Phase 2/3: one briefing per locale + ≤8 subjects, each phase capped at
  // AI_PHASE_BUDGET_MS (scripts/send-newsletter.mjs).
  ['send-newsletter.yml', 'O(locales), 30-minute budget per AI phase'],
  // One parser per dispatch, plus one regeneration on conflict.
  ['generate-company-parser.yml', 'one call per run'],
  // One UX-suggestion call per weekly report.
  ['analytics.yml', 'one call per run'],
]);

function envBlocks(workflow: any): Array<{ where: string; env: Record<string, unknown> }> {
  const blocks: Array<{ where: string; env: Record<string, unknown> }> = [];
  if (workflow?.env) blocks.push({ where: 'workflow', env: workflow.env });
  for (const [jobId, job] of Object.entries<any>(workflow?.jobs || {})) {
    if (job?.env) blocks.push({ where: `jobs.${jobId}`, env: job.env });
    (job?.steps || []).forEach((step: any, i: number) => {
      if (step?.env) blocks.push({ where: `jobs.${jobId}.steps[${i}] ${step.name || step.id || ''}`.trim(), env: step.env });
    });
  }
  return blocks;
}

function codexPreferences() {
  const found: Array<{ file: string; where: string }> = [];
  for (const file of readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const workflow = YAML.parse(readFileSync(resolve(WORKFLOWS_DIR, file), 'utf8'));
    for (const { where, env } of envBlocks(workflow)) {
      if (String(env.AI_MODELS_PREFER ?? '').includes('codex-cli/')) found.push({ file, where });
    }
  }
  return found;
}

describe('global Codex preference only where the call count is bounded', () => {
  it('no workflow outside the bounded list prefers Codex globally', () => {
    const unbounded = codexPreferences().filter(({ file }) => !BOUNDED_CODEX_PREFER.has(file));
    expect(unbounded).toEqual([]);
  });

  it.each([
    'snapshot-jobs-weekly.yml',
    'batch-faq-articles.yml',
    'publish-journalist-articles.yml',
    'smoke-test-ai-models.yml',
  ])('%s does not prefer Codex (per-item volume)', (file) => {
    expect(codexPreferences().filter((p) => p.file === file)).toEqual([]);
  });

  it('the smoke test neutralises any inherited preference before pinging', () => {
    const smoke = readFileSync(resolve(ROOT, 'scripts/smoke-test-ai-models.mjs'), 'utf8');
    const reset = smoke.indexOf("process.env.AI_MODELS_PREFER = '';");
    expect(reset).toBeGreaterThan(-1);
    expect(reset).toBeLessThan(smoke.indexOf('await callLLM('));
  });
});

describe('snapshot-jobs-weekly enrichment time budget', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops starting clusters at the deadline and reports the rest as not started', async () => {
    vi.useFakeTimers({ now: 0 });
    const started: number[] = [];
    const run = runWithConcurrency(
      Array.from({ length: 10 }, (_, i) => i),
      2,
      async (item: number) => {
        started.push(item);
        await new Promise((r) => setTimeout(r, 20));
      },
      { deadlineMs: 30 },
    );
    await vi.advanceTimersByTimeAsync(200);
    // t=0 starts 0,1; t=20 (< 30) starts 2,3; at t=40 the deadline has passed.
    await expect(run).resolves.toBe(6);
    expect(started).toEqual([0, 1, 2, 3]);
  });

  it('runs every item when no deadline is given', async () => {
    const seen: number[] = [];
    await expect(runWithConcurrency([1, 2, 3], 5, async (i: number) => { seen.push(i); })).resolves.toBe(0);
    expect(seen.sort()).toEqual([1, 2, 3]);
  });

  it('the workflow budget ends before the step timeout', () => {
    const workflow = YAML.parse(readFileSync(resolve(WORKFLOWS_DIR, 'snapshot-jobs-weekly.yml'), 'utf8'));
    const step = workflow.jobs.snapshot.steps.find((s: any) => String(s.run || '').includes('enrich-related-search-clusters.mjs'));
    const budget = Number(/--budget-minutes=(\d+)/.exec(step.run)?.[1]);
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(step['timeout-minutes'] - 5);
  });
});
