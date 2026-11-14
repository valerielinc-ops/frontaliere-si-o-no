// F1.1 / F1.2: the PR gate runs the same SEO source tests as the deploy prep, and
// gate:seo-source holds no wall-clock test.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const read = (rel: string) => fs.readFileSync(path.resolve(rel), 'utf8');
const tests = YAML.parse(read('.github/workflows/tests.yml')) as any;
const deploy = YAML.parse(read('.github/workflows/deploy.yml')) as any;
const pkg = JSON.parse(read('package.json'));

const stepsOf = (job: any) => job.steps as any[];
const find = (steps: any[], name: string) => steps.find((s) => s.name === name);

describe('F1.1 — tests.yml (the required check) runs gate:seo-source on every PR', () => {
  const vitestJob = tests.jobs.vitest;
  const prStep = find(stepsOf(vitestJob), 'SEO source tests (same gate as deploy prep)');
  const deployStep = find(stepsOf(deploy.jobs.prep), 'Run SEO source tests once per build');

  it('keeps the required check name', () => {
    expect(vitestJob.name).toBe('vitest (unit + integration)');
  });

  it('runs the same command with the same environment as the deploy prep step', () => {
    expect(prStep).toBeTruthy();
    expect(deployStep).toBeTruthy();
    expect(prStep.run).toBe('npm run gate:seo-source');
    expect(deployStep.run).toBe('npm run gate:seo-source');
    expect(prStep.env.VITEST_SKIP_LIVE_DATA).toBe('true');
    expect(prStep.env.BUILD_LOCALE).toBe('');
    expect(prStep.env.VITEST_SKIP_LIVE_DATA).toBe(deployStep.env.VITEST_SKIP_LIVE_DATA);
    expect(prStep.env.BUILD_LOCALE).toBe(deployStep.env.BUILD_LOCALE);
  });

  it('is not tied to a PR event: it runs on every event the job runs on, unless cancelled', () => {
    expect(prStep.if).toContain('!cancelled()');
    expect(prStep.if).not.toMatch(/github\.event_name/);
    expect(prStep['timeout-minutes']).toBeGreaterThan(0);
    expect(prStep['timeout-minutes']).toBeLessThanOrEqual(30);
  });

  it('does not overlap Vitest or TSC: it sits after the related run and before the collector/typecheck', () => {
    const names = stepsOf(vitestJob).map((s) => s.name);
    const at = names.indexOf(prStep.name);
    expect(at).toBeGreaterThan(names.indexOf('vitest related (PR diff)'));
    expect(at).toBeLessThan(names.indexOf('Collect independent source gates'));
    expect(at).toBeLessThan(names.indexOf('Typecheck after detached source gates'));
    // no step output is produced or consumed: nothing to collide on $GITHUB_OUTPUT
    expect(prStep.run).not.toMatch(/GITHUB_OUTPUT/);
    const raw = JSON.stringify(vitestJob);
    expect(raw).not.toContain('steps.seo-source-gate.outputs');
  });

  it('leaves the deploy prep step in place', () => {
    expect(deployStep).toBeTruthy();
  });

  it('puts the large-dataset AST lint in the parallel source guards (every PR)', () => {
    const guards = find(stepsOf(vitestJob), 'Run source guards in parallel');
    expect(guards.run).toContain('start_gate large-dataset-reads node scripts/ci/check-large-dataset-reads.mjs');
    expect(guards.if).not.toMatch(/github\.event_name == 'pull_request'/);
  });
});

describe('F1.2 — gate:seo-source is deterministic', () => {
  it('has no wall-clock test: the ratio test moved to tests/perf and is excluded from every gate', () => {
    expect(fs.existsSync('tests/seo/sitemap-loader-flatten-budget.test.ts')).toBe(false);
    expect(fs.existsSync('tests/perf/sitemap-loader-flatten-budget.test.ts')).toBe(true);
    const src = read('tests/perf/sitemap-loader-flatten-budget.test.ts');
    expect(src).toContain('MAX_OVERHEAD_RATIO');
    const config = read('vitest.config.ts');
    expect(config).toContain("process.env.VITEST_PERF === '1' ? [] : WALLTIME_TESTS");
    expect(config).toContain("'tests/perf/sitemap-loader-flatten-budget.test.ts'");
  });

  it('can still be run by hand', () => {
    expect(pkg.scripts['test:perf']).toBe('VITEST_PERF=1 vitest run tests/perf/sitemap-loader-flatten-budget.test.ts');
    expect(pkg.scripts['gate:seo-source']).toBe('vitest run tests/seo/ --reporter=dot');
  });

  it('no test under tests/seo/ times itself', () => {
    const offenders: string[] = [];
    for (const entry of fs.readdirSync('tests/seo', { withFileTypes: true })) {
      if (!entry.isFile() || !/\.test\.tsx?$/.test(entry.name)) continue;
      const text = fs.readFileSync(path.join('tests/seo', entry.name), 'utf8');
      if (/process\.hrtime|performance\.now\(\)/.test(text)) offenders.push(entry.name);
    }
    expect(offenders).toEqual([]);
  });
});
