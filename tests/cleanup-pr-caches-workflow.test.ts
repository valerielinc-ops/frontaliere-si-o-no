// W0-D: PR caches must not compete with the deploy's caches in the 10 GiB pool.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

const source = fs.readFileSync(path.resolve('.github/workflows/cleanup-pr-caches.yml'), 'utf8');
const workflow = YAML.parse(source) as any;
const testsYml = fs.readFileSync(path.resolve('.github/workflows/tests.yml'), 'utf8');
const deployYml = fs.readFileSync(path.resolve('.github/workflows/deploy.yml'), 'utf8');

const PROTECTED = [
  'jobs-seo-html-', 'incremental-manifest-', 'og-jobs-', 'deploy-content-manifest-',
  'node-modules-', 'node-cache-', 'assemble-jobs-',
];

describe('cleanup-pr-caches.yml — shape', () => {
  it('runs on PR close (pull_request_target), daily and by hand', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request_target', 'schedule', 'workflow_dispatch']);
    expect(workflow.on.pull_request_target.types).toEqual(['closed']);
    expect(workflow.on.schedule).toHaveLength(1);
  });

  it('has the minimum permissions and every job a timeout', () => {
    expect(workflow.permissions).toEqual({ actions: 'write', contents: 'read' });
    for (const job of Object.values<any>(workflow.jobs)) {
      expect(job['timeout-minutes']).toBeGreaterThan(0);
      expect(job['timeout-minutes']).toBeLessThanOrEqual(120);
    }
  });

  it('never checks out code: nothing from a PR can run under pull_request_target', () => {
    expect(source).not.toMatch(/actions\/checkout/);
    for (const job of Object.values<any>(workflow.jobs)) {
      for (const step of job.steps) expect(step.uses).toBeUndefined();
    }
  });

  it('deletes both PR refs of the closed PR and validates the number first', () => {
    const run = workflow.jobs['delete-closed-pr-caches'].steps[0].run as string;
    expect(run).toContain('refs/pull/${PR_NUMBER}/merge');
    expect(run).toContain('refs/pull/${PR_NUMBER}/head');
    expect(run).toMatch(/\*\[!0-9\]\*/);
    expect(run).not.toContain('refs/heads/main');
  });

  it('carries the protected deploy families and a hard guard for main', () => {
    const env = workflow.jobs['sweep-stale-pr-caches'].steps[0].env;
    const protectedList = String(env.PROTECTED_KEY_PREFIXES).split(/\s+/);
    for (const family of PROTECTED) expect(protectedList).toContain(family);
    expect(workflow.jobs['sweep-stale-pr-caches'].steps[0].run).toContain('[ "$ref" = "refs/heads/main" ]');
    // the stale families are only PR leftovers
    expect(String(env.STALE_KEY_PREFIXES).split(/\s+/)).toEqual(['vitest-transform-', 'assemble-jobs-', 'tsc-incremental-']);
  });
});

describe('cleanup-pr-caches.yml — the sweep, run for real against a fake gh', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  function sweep(rows: string[], prStates: Record<string, string>, dryRun = 'false') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-sweep-'));
    dirs.push(dir);
    const log = path.join(dir, 'calls.log');
    const rowsFile = path.join(dir, 'rows.tsv');
    fs.writeFileSync(rowsFile, `${rows.join('\n')}\n`);
    fs.writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$*" in
  *"-X DELETE"*) exit 0 ;;
  *"actions/caches"*) cat "${rowsFile}" ;;
  *"/pulls/"*) all="$*"; n="\${all#*pulls/}"; n="\${n%% *}"; case "$n" in ${Object.entries(prStates).map(([n, st]) => `${n}) echo ${st} ;;`).join(' ')} *) echo unknown ;; esac ;;
esac
`, { mode: 0o755 });
    const summary = path.join(dir, 'summary.md');
    const run = workflow.jobs['sweep-stale-pr-caches'].steps[0].run as string;
    const env = workflow.jobs['sweep-stale-pr-caches'].steps[0].env;
    execFileSync('bash', ['-c', run], {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        GH_REPO: 'o/r',
        GITHUB_STEP_SUMMARY: summary,
        DRY_RUN: dryRun,
        PROTECTED_KEY_PREFIXES: String(env.PROTECTED_KEY_PREFIXES).replace(/\s+/g, ' ').trim(),
        STALE_KEY_PREFIXES: env.STALE_KEY_PREFIXES,
        STALE_DAYS: env.STALE_DAYS,
      },
      encoding: 'utf8',
    });
    const calls = fs.readFileSync(log, 'utf8').split('\n');
    return calls.filter((c) => c.includes('-X DELETE')).map((c) => c.match(/caches\/(\d+)/)![1]);
  }

  const now = Math.floor(Date.now() / 1000);
  const row = (id: number, ref: string, key: string, ageDays: number, mib = 90) =>
    `${id}\t${ref}\t${key}\t${now - ageDays * 86400}\t${mib * 1048576}`;

  it('deletes closed-PR caches and stale open-PR transform caches, and nothing else', () => {
    const deleted = sweep([
      row(1, 'refs/heads/main', 'jobs-seo-html-de-abc', 30),
      row(2, 'refs/heads/main', 'assemble-jobs-Linux-k', 30),
      row(3, 'refs/heads/main', 'vitest-transform-Linux-x', 30),
      row(4, 'refs/pull/10/merge', 'vitest-transform-Linux-x', 0),      // PR 10 closed -> delete
      row(5, 'refs/pull/10/merge', 'node-modules-Linux-y', 0),          // closed -> delete whatever it is
      row(6, 'refs/pull/20/merge', 'vitest-transform-Linux-x', 5),      // open + stale -> delete
      row(7, 'refs/pull/20/merge', 'assemble-jobs-Linux-k', 3),         // open + stale -> delete
      row(8, 'refs/pull/20/merge', 'vitest-transform-Linux-x', 1),      // open + fresh -> keep
      row(9, 'refs/pull/20/merge', 'node-cache-Linux-z', 30),           // open, not a stale family -> keep
      row(10, 'refs/pull/30/merge', 'vitest-transform-Linux-x', 30),    // PR state unknown -> keep
      row(11, 'refs/heads/some-branch', 'og-jobs-key', 30),             // a branch, not a PR -> keep
    ], { 10: 'closed', 20: 'open' });
    expect(deleted.sort((a, b) => Number(a) - Number(b))).toEqual(['4', '5', '6', '7']);
  });

  it('dry run deletes nothing', () => {
    const deleted = sweep([row(4, 'refs/pull/10/merge', 'vitest-transform-Linux-x', 0)], { 10: 'closed' }, 'true');
    expect(deleted).toEqual([]);
  });

  it('never deletes an entry saved on main, whatever its age or family', () => {
    const rows = PROTECTED.concat(['vitest-transform-', 'tsc-incremental-']).map((p, i) => row(100 + i, 'refs/heads/main', `${p}k`, 60));
    expect(sweep(rows, {})).toEqual([]);
  });
});

describe('PR caches are saved only on main', () => {
  const block = (name: string, source = testsYml) => {
    const start = source.indexOf(`- name: ${name}`);
    expect(start, name).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf('\n      - name:', start + 10));
  };
  it.each(['Save assemble-jobs cache', 'Save TypeScript incremental state (solo su main)', 'Save Vitest related graph (solo su main)'])(
    'tests.yml: %s is gated on refs/heads/main',
    (name) => {
      expect(block(name)).toMatch(/if: \$\{\{ github\.ref == 'refs\/heads\/main' && /);
    },
  );
  it('tests.yml keeps restoring for every ref', () => {
    expect(testsYml).toMatch(/Cache Vitest\/Vite transform cache\n\s+id: vitest-cache/);
    expect(block('Cache Vitest/Vite transform cache')).not.toContain("github.ref == 'refs/heads/main'");
    expect(block('Cache assemble-jobs output')).not.toContain("github.ref == 'refs/heads/main'");
  });
  it('deploy.yml reports the pool occupancy per key family at the end of build-locale', () => {
    const step = block('Cache pool occupancy (per key family)', deployYml);
    expect(step).toContain('continue-on-error: true');
    expect(step).toContain('actions/cache/usage');
    expect(step).toContain('GITHUB_STEP_SUMMARY');
  });
});
