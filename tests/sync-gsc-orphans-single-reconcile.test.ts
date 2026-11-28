import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/sync-gsc-orphans.yml', import.meta.url), 'utf8'));

describe('GSC orphan workflow assembly reconciliation', () => {
  it('leaves the single full slug-reconciliation pass to the following step', () => {
    const steps = workflow.jobs['sync-orphans'].steps;
    const assembleIndex = steps.findIndex((step: { name?: string }) => step.name === 'Assemble jobs dataset (needed by reconcile)');
    const reconcileIndex = steps.findIndex((step: { name?: string }) => step.name === 'Reconcile orphan + expired slugs with active jobs');

    expect(assembleIndex).toBeGreaterThanOrEqual(0);
    expect(reconcileIndex).toBeGreaterThan(assembleIndex);
    expect(steps[assembleIndex].env.JOBS_SKIP_RECONCILIATION).toBe('1');
    expect(steps[reconcileIndex].run).toBe('node scripts/reconcile-job-slugs.mjs');
  });

  it('gives the orphan sync the 8 GB heap it ran out of without', () => {
    const sync = workflow.jobs['sync-orphans'].steps
      .find((step: { name?: string }) => step.name === 'Sync GSC orphan slugs + enrich');

    expect(sync.env.NODE_OPTIONS).toBe('--max-old-space-size=8192');
  });

  // The post-merge capacity check reads this line from the run log, so the
  // step's real shell script is executed with a stand-in for the sync script.
  it.skipIf(process.platform === 'win32').each([
    ['exits normally', '', 0],
    ['fails on its own', 'process.exit(3)', 3],
    ['aborts like a V8 heap OOM', 'process.abort()', 134],
    ['is killed from outside', "process.kill(process.pid, 'SIGKILL')", 137],
  ])('prints the memory line and keeps the exit code when node %s', (_label, body, code) => {
    const sync = workflow.jobs['sync-orphans'].steps
      .find((step: { name?: string }) => step.name === 'Sync GSC orphan slugs + enrich');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-orphan-memory-'));
    try {
      const standIn = path.join(dir, 'sync.mjs');
      fs.writeFileSync(standIn, body);
      expect(sync.run).toContain('node scripts/sync-gsc-orphans.mjs');
      const script = sync.run
        .replace('scripts/sync-gsc-orphans.mjs', `'${standIn}'`)
        .replace(/\$\{\{[^}]*\}\}/g, '');
      const result = spawnSync('bash', ['-e', '-c', script], { encoding: 'utf8', cwd: dir });

      expect(result.status).toBe(code);
      expect(result.stdout).toMatch(new RegExp(`^\\[memory\\] sync-gsc-orphans peak_rss_mib=[1-9]\\d* exit=${code}$`, 'm'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
