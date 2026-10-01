// post-deploy-validate-dist.yml wiring for the out-of-space failures of
// validate-dist-postbuild (runs 36595840668, 36670912411, 36687304462,
// 36810296662, 36830161110 died on the runner's own ENOSPC; 36566812671,
// 36656159822, 36706643053 sat until the 300-minute job timeout). Each of
// them reached integrity-verdict as an anonymous `__UNKNOWN__:dist` and
// blocked `publish` without saying why.
//
// Pinned here: (1) the free-disk step reclaims the toolchains this job never
// calls but keeps the node toolcache setup-node reads; (2) the rehydrate step
// has its own bound under the job ceiling and turns a disk-guard refusal into
// a named `infra:disk` row; (3) the combined gate-results script — executed
// for real, with its /tmp paths redirected — reports that row instead of
// three `__UNKNOWN__` phases, and keeps `__UNKNOWN__` when no row explains a
// missing phase file.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';

const WORKFLOW = YAML.parse(
  readFileSync(resolve('.github/workflows/post-deploy-validate-dist.yml'), 'utf8'),
) as any;
const JOB = WORKFLOW.jobs['validate-dist-postbuild'];
const STEPS: Array<Record<string, any>> = JOB.steps;
const stepNamed = (name: string) => {
  const step = STEPS.find((s) => s.name === name);
  expect(step, `step "${name}" not found`).toBeDefined();
  return step!;
};
const FREE_DISK = stepNamed('Free disk space on runner');
const REHYDRATE = stepNamed('Rehydrate locale then section shards into dist/ (when sharding active)');
const GATE_RESULTS = STEPS.find((s) => s.id === 'gate-results')!;

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('validate-dist-postbuild — free-disk step', () => {
  it('reclaims the second wave of unused toolchains and keeps the node toolcache', () => {
    const run = String(FREE_DISK.run);
    expect(run).toContain('/usr/local/.ghcup');
    expect(run).toMatch(/find \/opt\/hostedtoolcache -mindepth 1 -maxdepth 1 ! -name node/);
    expect(run).toContain('/usr/lib/jvm');
    // Memory-bound validators run later on this runner: swap is not disk to free.
    expect(run).not.toMatch(/swapoff/);
    // setup-node resolves node from the toolcache kept above.
    expect(STEPS.indexOf(FREE_DISK)).toBeLessThan(STEPS.findIndex((s) => s.name === 'Setup Node.js'));
  });
});

describe('validate-dist-postbuild — rehydrate step', () => {
  it('has its own bound, well under the job ceiling', () => {
    expect(JOB['timeout-minutes']).toBe(300);
    expect(REHYDRATE['timeout-minutes']).toBeGreaterThanOrEqual(45);
    expect(REHYDRATE['timeout-minutes']).toBeLessThan(JOB['timeout-minutes']);
  });

  it('turns the disk-guard marker into a named infra:disk row before exiting', () => {
    const run = String(REHYDRATE.run);
    expect(run).toContain('bash scripts/lib/rehydrate-section-shards.sh || SECTION_RC=$?');
    const marker = run.indexOf('"$RUNNER_TEMP/rehydrate-disk-exhausted"');
    const exitSection = run.indexOf('exit "$SECTION_RC"');
    expect(marker).toBeGreaterThan(-1);
    expect(exitSection).toBeGreaterThan(marker);
    expect(run).toContain("printf '%-40s %7.2f rc=%d\\n' 'infra:disk' 0 1 > /tmp/infra-gate-results.txt");
    // Same marker path as the guard library's default.
    expect(readFileSync(resolve('scripts/lib/rehydrate-disk-guard.sh'), 'utf8')).toContain(
      '${RUNNER_TEMP:-/tmp}/rehydrate-disk-exhausted',
    );
  });
});

/** Run the real gate-results script with every /tmp path moved into `dir`. */
function runGateResults(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-results-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  const output = join(dir, 'github-output');
  writeFileSync(output, '');
  const script = String(GATE_RESULTS.run).replaceAll('/tmp/', `${dir}/`);
  execFileSync('bash', ['-c', script], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GITHUB_OUTPUT: output },
  });
  const line = readFileSync(output, 'utf8').split('\n').find((l) => l.startsWith('failed_gates='));
  return (line ?? '').slice('failed_gates='.length);
}

describe('validate-dist-postbuild — combined gate results', () => {
  const INFRA_ROW = `${'infra:disk'.padEnd(40)}    0.00 rc=1\n`;

  it('reports infra:disk instead of three anonymous phases when the disk guard stopped the job', () => {
    expect(runGateResults({ 'infra-gate-results.txt': INFRA_ROW })).toBe('infra:disk');
  });

  it('NEGATIVE CASE: without a named row, missing phase files stay __UNKNOWN__ (fail-closed)', () => {
    expect(runGateResults({})).toBe('__UNKNOWN__:source,__UNKNOWN__:postbuild,__UNKNOWN__:bfs');
  });

  it('still collects a phase that did write its rows', () => {
    expect(
      runGateResults({
        'infra-gate-results.txt': INFRA_ROW,
        'source-val-results.txt': 'validate:sitemap-pages  4.10  rc=1\n',
      }),
    ).toBe('infra:disk,validate:sitemap-pages');
  });
});
