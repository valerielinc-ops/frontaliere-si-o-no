/**
 * Assembly rewrites the tracked expired slices in place; ghost reconciliation
 * moves routes into data/jobs.json, which is gitignored. A workflow that later
 * commits those slices therefore loses URLs (commit 1d69ad33b41, 2026-11-26).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { runPreservingExpiredSlices } from '../scripts/ci/assemble-preserving-expired-slices.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'assemble-preserving-'));
  roots.push(root);
  const dir = join(root, 'data', 'jobs', 'expired', 'by-crawler');
  mkdirSync(dir, { recursive: true });
  // What an earlier step of the workflow wrote must survive.
  writeFileSync(join(dir, 'pruned.json'), '[{"slug":"kept-route"}]\n');
  writeFileSync(join(dir, 'removed.json'), '[{"slug":"other-route"}]\n');
  return { root, dir };
}

const rewriteSlices = (exitCode: number) => [
  "const fs = require('node:fs');",
  "const dir = 'data/jobs/expired/by-crawler/';",
  "fs.writeFileSync(dir + 'pruned.json', '[]\\n');",
  "fs.rmSync(dir + 'removed.json');",
  "fs.writeFileSync(dir + 'created.json', '[]\\n');",
  "fs.writeFileSync('data/jobs.json', 'assembled');",
  `process.exit(${exitCode});`,
].join('\n');

describe('runPreservingExpiredSlices', () => {
  it.each([0, 3])('puts the expired slices back and keeps other outputs (exit %i)', async (exitCode) => {
    const { root, dir } = fixture();

    const status = await runPreservingExpiredSlices({ args: ['-e', rewriteSlices(exitCode)], cwd: root });

    expect(status).toBe(exitCode);
    expect(readdirSync(dir).sort()).toEqual(['pruned.json', 'removed.json']);
    expect(readFileSync(join(dir, 'pruned.json'), 'utf8')).toBe('[{"slug":"kept-route"}]\n');
    expect(readFileSync(join(dir, 'removed.json'), 'utf8')).toBe('[{"slug":"other-route"}]\n');
    expect(readFileSync(join(root, 'data', 'jobs.json'), 'utf8')).toBe('assembled');
  });

  it('does not run the command when the archive cannot be snapshotted', async () => {
    const { root, dir } = fixture();
    rmSync(dir, { recursive: true });

    await expect(runPreservingExpiredSlices({ args: ['-e', rewriteSlices(0)], cwd: root })).rejects.toThrow();
    expect(existsSync(join(root, 'data', 'jobs.json'))).toBe(false);
  });
});

describe('workflows that publish the expired archive', () => {
  const workflowsDir = new URL('../.github/workflows/', import.meta.url);
  // Discards the final gate output in its own shell; contract pinned in
  // tests/backfill-resumable.test.ts.
  const RESTORES_IN_SHELL = 'backfill-expired-from-history.yml';
  // Pushes only to a throwaway bare repository on the runner.
  const ISOLATED_REMOTE = 'translate-pending-budget-benchmark.yml';
  // `--slice-only` without JOBS_SLICE_FILE stages every expired slice, as does
  // a `git add` that names the archive or one of its parent directories.
  const PUBLISHES_EXPIRED = /git-commit-data\.sh["']?\s+(?:--slice-only|"\$commit_scope")|\bgit add\b[^\n]*\sdata(?:\/jobs(?:\/expired(?:\/by-crawler)?)?)?\/?(?=\s|$)/m;

  const assemblesExpired = (run: string) => run.split('\n').some((line) => (
    !line.trim().startsWith('#')
    && /\bnode\b[^\n]*scripts\/assemble-jobs-dataset\.mjs/.test(line)
    && !/--(?:active-only|projection-only|print-cache-key)\b/.test(line)
  ));

  const publishers = readdirSync(workflowsDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => {
      const jobs = Object.values(parseYaml(readFileSync(new URL(name, workflowsDir), 'utf8')).jobs ?? {});
      const raw = (jobs as Array<{ steps?: Array<{ run?: string }> }>).some((job) => {
        const runs = (job.steps ?? []).map((step) => String(step.run ?? ''));
        return runs.some((run, index) => (
          assemblesExpired(run) && runs.slice(index).some((later) => PUBLISHES_EXPIRED.test(later))
        ));
      });
      return { name, raw };
    });

  it('never assemble in place before committing the archive', () => {
    const allowed = [RESTORES_IN_SHELL, ISOLATED_REMOTE];
    expect(publishers.filter(({ name, raw }) => raw && !allowed.includes(name)).map(({ name }) => name))
      .toEqual([]);
    expect(readFileSync(new URL(ISOLATED_REMOTE, workflowsDir), 'utf8'))
      .toContain('git remote set-url origin "$BENCHMARK_ORIGIN"');
    // The detector still sees the one workflow that assembles in place.
    expect(publishers.find(({ name }) => name === RESTORES_IN_SHELL)?.raw).toBe(true);
  });

  it.each([
    'cleanup-stale-jobs.yml',
    'reconcile-expired-route-duplicates.yml',
    'sync-gsc-orphans.yml',
    'translate-pending.yml',
  ])('%s assembles through the preserving wrapper', (name) => {
    const source = readFileSync(new URL(name, workflowsDir), 'utf8');
    expect(source).toContain('run: node scripts/ci/assemble-preserving-expired-slices.mjs');
  });
});
