import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
// @ts-expect-error — plain .mjs CI gate
import { validatePrBody } from '../scripts/ci/pr-body-check-gate.mjs';

const WORKFLOW_DIR = '.github/workflows';

const THIN_PROMOTION_RUNTIME_SPARSE_PATHS = [
  '/.gitattributes',
  '/.npmrc',
  '/data/thin-page-promotions-active.json',
  '/data/thin-page-promotions.jsonl',
  '/package-lock.json',
  '/package.json',
  '/scripts/ci/',
  '/scripts/fetch-thin-page-promotions.mjs',
  '/scripts/lib/',
  '/scripts/load-rc-env.mjs',
];

const THIN_PROMOTION_LEGACY_SPARSE_PATHS = [
  '/*',
  '!/public/images/',
  '!/data/jobs/',
  '!/data/translation-cache/',
  '!/packages/articles/content/',
  '!/data/related-search-candidates.json',
  '!/data/cf-hot-404s.json',
  '!/data/jobs-ai-cache.json',
  '!/data/dist-size-history.jsonl',
  '!/data/jobs-stats-history.json',
  '!/data/url-first-seen.json',
  '!/data/jobs-snapshots-history/',
  '!/data/slug-registry.json',
  '!/data/evidence-index.json',
  '!/data/health-premiums/',
  '!/data/jobs-crawler-summaries/',
];

function workflow(name: string): any {
  return YAML.parse(fs.readFileSync(`${WORKFLOW_DIR}/${name}`, 'utf8'));
}

describe('CI failure triad workflow regressions (#12926, #12902)', () => {
  it('validates the event-image data PR body with the same strict gate used before writes', () => {
    const steps = workflow('event-image-library.yml').jobs.generate.steps;
    const publish = steps.find((step: any) => step.name === 'Publish registry through a data PR');
    const body = /cat > "\$body" <<'EOF'\n([\s\S]*?)\nEOF/u.exec(publish?.run || '')?.[1];

    expect(body, 'event-image PR body heredoc').toBeTruthy();
    const result = validatePrBody(body);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('fetches only required workflow inputs and branch history for the profession writer', () => {
    const steps = workflow('profession-keyword-opportunities.yml').jobs.rank.steps;
    const checkout = steps.find((step: any) => step.uses?.startsWith('actions/checkout@'));
    const historyIndex = steps.findIndex((step: any) => step.name === 'Fetch blobless history for push retries');
    const setupNodeIndex = steps.findIndex((step: any) => step.uses?.startsWith('actions/setup-node@'));
    const sparsePaths = String(checkout?.with?.['sparse-checkout'] || '')
      .split('\n')
      .map((entry: string) => entry.trim())
      .filter(Boolean);
    const history = steps[historyIndex];

    expect(checkout?.with?.ref).toBe('${{ github.ref }}');
    expect(checkout?.with?.['fetch-depth']).toBe(1);
    expect(checkout?.with?.filter).toBeUndefined();
    expect(checkout?.with?.['sparse-checkout-cone-mode']).toBe(false);
    expect(sparsePaths).toEqual(expect.arrayContaining([
      '/build-plugins/professionLandingsData.ts',
      '/data/gsc-orphan-queries.json',
      '/data/jobs.json',
      '/data/jobs/by-crawler/',
      '/data/keyword-pages-config.json',
      '/data/profession-keyword-opportunities.json',
      '/package-lock.json',
      '/scripts/lib/',
      '/scripts/load-rc-env.mjs',
      '/scripts/profession-keyword-opportunities.mjs',
    ]));
    expect(historyIndex).toBeGreaterThan(steps.indexOf(checkout));
    expect(historyIndex).toBeLessThan(setupNodeIndex);
    expect(history?.['timeout-minutes']).toBe(5);
    expect(history?.env?.BRANCH).toBe('${{ github.ref_name }}');
    expect(history?.run).toContain('git fetch --no-tags --filter=blob:none --unshallow origin');
    expect(history?.run).toContain('"+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}"');
    expect(history?.run).toContain('"+refs/heads/main:refs/remotes/origin/main"');
    expect(history?.run).not.toMatch(/\+refs\/(?:heads|tags)\/\*/u);
  });

  it('keeps thin-promotion checkout shallow until its targeted history fetch', () => {
    const steps = workflow('refresh-thin-promotions.yml').jobs.refresh.steps;
    const checkout = steps.find((step: any) => step.uses?.startsWith('actions/checkout@'));
    const historyIndex = steps.findIndex((step: any) => step.name === 'Fetch blobless history for push retries');
    const setupNodeIndex = steps.findIndex((step: any) => step.uses?.startsWith('actions/setup-node@'));
    const history = steps[historyIndex];

    expect(checkout?.with?.ref).toBe('${{ github.ref }}');
    expect(checkout?.with?.['fetch-depth']).toBe(1);
    expect(checkout?.with?.filter).toBe('blob:none');
    const sparsePaths = String(checkout?.with?.['sparse-checkout'] || '')
      .split('\n')
      .map((entry: string) => entry.trim())
      .filter(Boolean);
    expect(sparsePaths).toEqual(THIN_PROMOTION_RUNTIME_SPARSE_PATHS);
    expect(sparsePaths).not.toContain('/*');
    expect(checkout?.['timeout-minutes']).toBe(7);
    expect(historyIndex).toBeGreaterThan(steps.indexOf(checkout));
    expect(historyIndex).toBeLessThan(setupNodeIndex);
    expect(history?.['timeout-minutes']).toBe(5);
    expect(history?.env?.BRANCH).toBe('${{ github.ref_name }}');
    expect(history?.run).toContain('git fetch --no-tags --filter=blob:none --unshallow origin');
    expect(history?.run).toContain('"+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}"');
    expect(history?.run).not.toMatch(/\+refs\/(?:heads|tags)\/\*/u);
  });

  it('measures the thin-promotion history fetch on the exact PR head before merge', () => {
    const config = workflow('refresh-thin-promotions.yml');
    const validation = config.jobs['validate-history-fetch'];
    const steps = validation.steps;
    const checkout = steps.find((step: any) => step.uses?.startsWith('actions/checkout@'));
    const history = steps.find((step: any) => step.name === 'Measure blobless history fetch');
    const sparsePaths = String(checkout?.with?.['sparse-checkout'] || '')
      .split('\n')
      .map((entry: string) => entry.trim())
      .filter(Boolean);

    expect(config.on.pull_request.paths).toContain('.github/workflows/refresh-thin-promotions.yml');
    expect(validation.if).toBe("github.event_name == 'pull_request' || (github.event_name == 'workflow_dispatch' && (inputs.benchmark_only == true || inputs.benchmark_only == 'true'))");
    expect(validation.permissions).toEqual({ contents: 'read' });
    expect(validation['timeout-minutes']).toBe(15);
    expect(checkout?.with?.ref).toBe('${{ github.event.pull_request.head.sha || github.sha }}');
    expect(checkout?.with?.['fetch-depth']).toBe(1);
    expect(checkout?.with?.filter).toBe('blob:none');
    expect(checkout?.with?.['sparse-checkout-cone-mode']).toBe(false);
    expect(sparsePaths).toEqual(THIN_PROMOTION_RUNTIME_SPARSE_PATHS);
    expect(sparsePaths).not.toContain('/*');
    expect(checkout?.['timeout-minutes']).toBe(7);
    expect(history?.env?.BRANCH).toBe('${{ github.event.pull_request.head.ref || github.ref_name }}');
    expect(history?.env?.HEAD_SHA).toBe('${{ github.event.pull_request.head.sha || github.sha }}');
    expect(history?.['timeout-minutes']).toBe(5);
    expect(history?.run).toContain('git fetch --no-tags --filter=blob:none --unshallow origin');
    expect(history?.run).toContain('duration_ms');
    expect(history?.run).toContain('GITHUB_RUN_ID');
    expect(history?.run).toContain('if [ "$duration_ms" -ge 300000 ]');
    expect(config.jobs.refresh.if).toBe("github.event_name != 'pull_request' && inputs.benchmark_only != true && inputs.benchmark_only != 'true'");
  });

  it('compares legacy and narrowed checkout materialization on the same PR head', () => {
    const config = workflow('refresh-thin-promotions.yml');
    const benchmark = config.jobs['compare-checkout-materialization'];
    const steps = benchmark.steps;
    const legacy = steps.find((step: any) => step.id === 'legacy_checkout');
    const narrowed = steps.find((step: any) => step.id === 'narrowed_checkout');
    const summary = steps.find((step: any) => step.name === 'Publish linked checkout materialization comparison');

    expect(config.on.workflow_dispatch.inputs.benchmark_only).toEqual({
      description: 'Run the PR checkout-materialization comparison only',
      required: false,
      default: false,
      type: 'boolean',
    });
    expect(benchmark.if).toBe("github.event_name == 'pull_request' || (github.event_name == 'workflow_dispatch' && (inputs.benchmark_only == true || inputs.benchmark_only == 'true'))");
    expect(benchmark['runs-on']).toBe('ubuntu-latest');
    expect(benchmark.permissions).toEqual({ contents: 'read' });
    expect(benchmark['timeout-minutes']).toBe(16);
    expect(legacy?.uses).toBe('actions/checkout@v7');
    expect(legacy?.['continue-on-error']).toBe(true);
    expect(narrowed?.uses).toBe('actions/checkout@v7');
    expect(narrowed?.['continue-on-error']).toBeUndefined();

    for (const checkout of [legacy, narrowed]) {
      expect(checkout?.with?.ref).toBe('${{ github.event.pull_request.head.sha || github.sha }}');
      expect(checkout?.with?.['fetch-depth']).toBe(1);
      expect(checkout?.with?.filter).toBe('blob:none');
      expect(checkout?.with?.['persist-credentials']).toBe(false);
      expect(checkout?.with?.['sparse-checkout-cone-mode']).toBe(false);
      expect(checkout?.['timeout-minutes']).toBe(7);
    }

    const legacyPaths = String(legacy?.with?.['sparse-checkout'] || '')
      .split('\n')
      .map((entry: string) => entry.trim())
      .filter(Boolean);
    const narrowedPaths = String(narrowed?.with?.['sparse-checkout'] || '')
      .split('\n')
      .map((entry: string) => entry.trim())
      .filter(Boolean);
    expect(legacy?.with?.path).toBe('checkout-legacy');
    expect(narrowed?.with?.path).toBe('checkout-narrowed');
    expect(legacyPaths).toEqual(THIN_PROMOTION_LEGACY_SPARSE_PATHS);
    expect(narrowedPaths).toEqual(THIN_PROMOTION_RUNTIME_SPARSE_PATHS);
    expect(summary?.if).toBe('always()');
    expect(summary?.run).toContain('GITHUB_STEP_SUMMARY');
    expect(summary?.run).toContain('GITHUB_RUN_ID');
    expect(summary?.run).toContain('NARROWED_OUTCOME');
    expect(summary?.run).toContain('seven-minute step cap');
  });

  it('refreshes keyword pages after the ranking writer succeeds, not only on a racing schedule', () => {
    const configWorkflow = workflow('refresh-keyword-config.yml');

    expect(configWorkflow.on.workflow_run).toEqual({
      workflows: ['Profession Keyword Opportunities'],
      types: ['completed'],
      branches: ['main'],
    });
    const concurrencyGroup = String(configWorkflow.concurrency.group);
    expect(concurrencyGroup).toContain('inputs.dry_run == true');
    expect(concurrencyGroup).toContain("inputs.dry_run == 'true'");
    expect(concurrencyGroup).toContain("'refresh-keyword-config-preview'");
    expect(concurrencyGroup).toContain("'refresh-keyword-config-write'");
    expect(concurrencyGroup).not.toBe('refresh-keyword-config');
    expect(configWorkflow.concurrency['cancel-in-progress']).toBe(false);
    expect(configWorkflow.jobs.refresh.if).toContain("github.event_name != 'workflow_run'");
    expect(configWorkflow.jobs.refresh.if).toContain("github.event.workflow_run.conclusion == 'success'");
  });
});
