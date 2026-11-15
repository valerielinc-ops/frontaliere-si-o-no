// @vitest-environment node
/**
 * Wiring of the sharded first-seen ledger through the publish pipeline.
 *
 * Evidence (publisher run 43692928043, job `commit-it-dist-history`): the single
 * `data/url-first-seen.json` reached 213.54 MB, GitHub answered `GH001: Large
 * files detected` five times, and the dist-size-history row committed next to it
 * was lost inside a `continue-on-error` job that stayed green. These tests pin
 * that every stage of the pipeline now speaks shards, and that the size guard
 * runs BEFORE anything is staged.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { URL_FIRST_SEEN_DIR, URL_FIRST_SEEN_LEGACY_FILE } from '../scripts/lib/url-first-seen-store.mjs';
import { applyForwardBuckets, FORWARD_BUCKETS } from '../scripts/ci/checkout-bucket-forward.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const workflow = (name: string) => YAML.parse(read(`.github/workflows/${name}`));

const PUBLISH = workflow('deploy-publish.yml');
const COMMIT_JOB = PUBLISH.jobs['commit-it-dist-history'];
const COMMIT_STEP = COMMIT_JOB.steps.find((s: { name?: string }) => s.name === 'Commit dist-size-history row + url-first-seen updates');
const COMMIT_RUN: string = COMMIT_STEP.run;

describe('deploy-publish.yml: the history artifact carries shards', () => {
  it('uploads the shard directory, not the single file', () => {
    const upload = Object.values(PUBLISH.jobs as Record<string, { steps?: Array<Record<string, any>> }>)
      .flatMap((job) => job.steps ?? [])
      .find((s) => s.name === 'Upload dist-size-history + url-first-seen for the history commit');
    expect(upload).toBeDefined();
    const paths = String(upload!.with.path).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    expect(paths).toEqual(['data/dist-size-history.jsonl', `${URL_FIRST_SEEN_DIR}/`]);
    expect(paths).not.toContain(URL_FIRST_SEEN_LEGACY_FILE);
  });

  it('the commit job checks out the shard directory and the guard script', () => {
    const checkout = COMMIT_JOB.steps.find((s: { name?: string }) => s.name === 'Checkout IT history writer');
    const sparse = String(checkout.with['sparse-checkout']).split('\n').map((l) => l.trim());
    for (const p of [
      '/data/dist-size-history.jsonl',
      `/${URL_FIRST_SEEN_DIR}/`,
      '/scripts/lib/',
      '/scripts/ci/assert-accumulator-write.mjs',
      '/scripts/ci/dist-history-accumulators.mjs',
      '/scripts/ci/merge-json-first-seen.mjs',
    ]) expect(sparse).toContain(p);
    // the job never touches the legacy file, so it is not materialised (87 MB)
    expect(sparse).not.toContain(`/${URL_FIRST_SEEN_LEGACY_FILE}`);
  });
});

describe('commit-it-dist-history: size guard before staging, no silent loss', () => {
  it('has no GitHub expression inside the run script', () => {
    expect(COMMIT_RUN).not.toContain('${{');
  });

  it('runs the size guard before `git add`, and stages only what the guard selected', () => {
    const guard = COMMIT_RUN.indexOf('dist-history-accumulators.mjs guard');
    const floor = COMMIT_RUN.indexOf('assert-accumulator-write.mjs');
    const add = COMMIT_RUN.indexOf('git add --');
    const commit = COMMIT_RUN.indexOf('git commit --only');
    const push = COMMIT_RUN.indexOf('git-push-with-retry.sh');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(floor);
    expect(floor).toBeLessThan(add);
    expect(add).toBeLessThan(commit);
    expect(commit).toBeLessThan(push);
    expect(COMMIT_RUN).toContain('git add -- "${stage_paths[@]}"');
    expect(COMMIT_RUN).toContain('-- "${stage_paths[@]}"');
    // never a blanket add
    expect(COMMIT_RUN).not.toMatch(/git add (-A|--all|\.)(\s|$)/);
  });

  it('an oversized accumulator is skipped, the rest is still committed and pushed, and the step ends RED afterwards', () => {
    // status 3 from the guard = something was skipped; it must not abort the script...
    expect(COMMIT_RUN).toMatch(/guard_status=0\n\s*node scripts\/ci\/dist-history-accumulators\.mjs guard[^\n]*\|\| guard_status=\$\?/);
    expect(COMMIT_RUN).toMatch(/if \[ "\$guard_status" -eq 3 \]; then\n\s*skipped=1/);
    // ...and the failure is raised only after the push
    const push = COMMIT_RUN.indexOf('git-push-with-retry.sh');
    const redExit = COMMIT_RUN.lastIndexOf('if [ "$skipped" -ne 0 ]; then');
    expect(redExit).toBeGreaterThan(push);
    expect(COMMIT_RUN.slice(redExit)).toContain('::error title=dist-history incomplete::');
    expect(COMMIT_RUN.slice(redExit)).toContain('exit 1');
  });

  it('stages before diffing: `git diff` does not see the new shards of the first sharded publish', () => {
    expect(COMMIT_RUN).not.toMatch(/git diff --quiet --\s+data\//);
    expect(COMMIT_RUN).toContain('git diff --cached --quiet');
  });

  it('merges artifact shards into the checked-out ones (union, earliest date) instead of overwriting them', () => {
    expect(COMMIT_RUN).toContain('node scripts/ci/merge-json-first-seen.mjs /dev/null "$target" "$artifact_shard"');
  });

  it('keeps the path allowlist and the merge-driver registration', () => {
    expect(COMMIT_RUN).toContain('dist-history-accumulators.mjs unexpected');
    expect(COMMIT_RUN).toContain("git config merge.json-first-seen.driver 'node scripts/ci/merge-json-first-seen.mjs %O %A %B'");
    expect(COMMIT_RUN).toContain('--max-attempts 5');
  });

  it('is valid bash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-step-syntax-'));
    const script = path.join(dir, 'step.sh');
    try {
      fs.writeFileSync(script, COMMIT_RUN);
      const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    } finally {
      fs.rmSync(script, { force: true });
      fs.rmdirSync(dir);
    }
  });
});

describe('package-it-publish-source.sh', () => {
  const source = read('scripts/ci/package-it-publish-source.sh');

  it('ships the shard directory and/or the legacy file, and fails when neither exists', () => {
    expect(source).toContain('for first_seen_member in data/url-first-seen data/url-first-seen.json; do');
    expect(source).toContain('root_members+=("${first_seen_members[@]}")');
    expect(source).toContain('neither data/url-first-seen/ nor data/url-first-seen.json exists');
    // the fixed list no longer names the legacy file: a missing member would fail `find`
    expect(source).toMatch(/root_members=\(public\/images data\/dist-size-history\.jsonl\)/);
  });

  it('the member selection works on a tree that has only one of the two', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-members-'));
    try {
      const snippet = source.slice(source.indexOf('first_seen_members=()'), source.indexOf('root_members+=("${first_seen_members[@]}")') + 'root_members+=("${first_seen_members[@]}")'.length);
      const run = (setup: () => void) => {
        for (const entry of fs.readdirSync(dir)) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
        setup();
        return spawnSync('bash', ['-c', `set -euo pipefail\nroot_members=(base)\n${snippet}\necho "\${root_members[@]}"`], { cwd: dir, encoding: 'utf8' });
      };
      expect(run(() => fs.mkdirSync(path.join(dir, 'data/url-first-seen'), { recursive: true })).stdout.trim()).toBe('base data/url-first-seen');
      expect(run(() => { fs.mkdirSync(path.join(dir, 'data')); fs.writeFileSync(path.join(dir, 'data/url-first-seen.json'), '{}'); }).stdout.trim()).toBe('base data/url-first-seen.json');
      expect(run(() => { fs.mkdirSync(path.join(dir, 'data/url-first-seen'), { recursive: true }); fs.writeFileSync(path.join(dir, 'data/url-first-seen.json'), '{}'); }).stdout.trim()).toBe('base data/url-first-seen data/url-first-seen.json');
      const none = run(() => fs.mkdirSync(path.join(dir, 'data')));
      expect(none.status).toBe(1);
      expect(none.stdout).toContain('::error::neither data/url-first-seen/ nor data/url-first-seen.json exists');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('every workflow that names the legacy exclusion also excludes the shard directory', () => {
  it('(a checkout that skips the 87 MB file must not materialise the 214 MB directory)', () => {
    const offenders: string[] = [];
    for (const name of fs.readdirSync(path.join(ROOT, '.github/workflows')).filter((f) => f.endsWith('.yml'))) {
      const lines = read(`.github/workflows/${name}`).split('\n');
      lines.forEach((line, i) => {
        if (line.trim() !== `!/${URL_FIRST_SEEN_LEGACY_FILE}`) return;
        const indent = line.length - line.trimStart().length;
        let start = i;
        while (start > 0 && /^\s*(!?\/|#)/.test(lines[start - 1]) && lines[start - 1].length - lines[start - 1].trimStart().length === indent) start--;
        let end = i;
        while (end + 1 < lines.length && /^\s*(!?\/|#)/.test(lines[end + 1]) && lines[end + 1].length - lines[end + 1].trimStart().length === indent) end++;
        if (!lines.slice(start, end + 1).some((l) => l.trim() === `!/${URL_FIRST_SEEN_DIR}/`)) offenders.push(`${name}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('deploy.yml names the directory in all four places the file was named', () => {
    const deploy = read('.github/workflows/deploy.yml');
    expect(deploy.split('\n').filter((l) => l.trim() === `/${URL_FIRST_SEEN_DIR}/`)).toHaveLength(1);
    expect(deploy.split('\n').filter((l) => l.trim() === `!/${URL_FIRST_SEEN_DIR}/`)).toHaveLength(3);
    expect(deploy.split('\n').filter((l) => l.trim() === `/${URL_FIRST_SEEN_LEGACY_FILE}`)).toHaveLength(1);
    expect(deploy.split('\n').filter((l) => l.trim() === `!/${URL_FIRST_SEEN_LEGACY_FILE}`)).toHaveLength(3);
  });

  it('tests.yml ignores pushes that only touch shards, like the legacy file', () => {
    const ignored: string[] = YAML.parse(read('.github/workflows/tests.yml')).on.push['paths-ignore'];
    expect(ignored).toContain(URL_FIRST_SEEN_LEGACY_FILE);
    expect(ignored).toContain(`${URL_FIRST_SEEN_DIR}/*.json`);
  });
});

describe('checkout bucket for the not-yet-landed directory', () => {
  it('is in the committed table as a forward bucket, sized from the measured migration', () => {
    const table = JSON.parse(read('scripts/ci/checkout-buckets.json'));
    const bucket = table.buckets.find((b: { id: string }) => b.id === `${URL_FIRST_SEEN_DIR}/`);
    expect(bucket).toMatchObject({ files: 16, forward: true });
    expect(bucket.mb).toBeGreaterThanOrEqual(table.minMb);
    expect(FORWARD_BUCKETS.map((b) => b.id)).toContain(`${URL_FIRST_SEEN_DIR}/`);
  });

  it('applyForwardBuckets adds a missing bucket and accounts for it in the tree totals', () => {
    const payload = { buckets: [{ id: 'a/', mb: 100, files: 3 }], treeMb: 500, treeFiles: 40, baselineMb: 400 };
    const next = applyForwardBuckets(payload, [{ id: 'new/', mb: 214, files: 16, reason: 'x' }]);
    expect(next.buckets.map((b: { id: string }) => b.id)).toEqual(['new/', 'a/']);
    expect(next.treeMb).toBe(714);
    expect(next.treeFiles).toBe(56);
    expect(next.baselineMb).toBe(400);
  });

  it('a measured bucket wins: nothing is added once the tree contains the directory', () => {
    const payload = { buckets: [{ id: 'new/', mb: 230, files: 16 }], treeMb: 700, treeFiles: 50 };
    const next = applyForwardBuckets(payload, [{ id: 'new/', mb: 214, files: 16, reason: 'x' }]);
    expect(next).toBe(payload);
  });
});

describe('the legacy path is read through the store only', () => {
  // Same discipline as tests/all-known-job-slugs-store.test.ts: a reader that
  // opens the single file directly sees an empty or stale ledger once the file
  // is retired, and does it silently.
  const DIRECT_READERS_ALLOWED = new Set([
    'scripts/lib/url-first-seen-store.mjs', // the store itself
    'scripts/ci/package-it-publish-source.sh', // ships the legacy file to the publisher during the migration
    'scripts/assemble-jobs-dataset.mjs', // content-hash input of the assemble cache
    'scripts/ci/check-cron-count-literals.mjs', // lists of cron-managed paths
    'scripts/ci/live-data-test-guard.mjs', // lists of live data roots
    'scripts/ci/checkout-buckets.json', // sparse-checkout bucket table
  ]);

  it('no script or build plugin outside the allowlist spells the legacy file name in code', () => {
    const out = execFileSync('git', ['grep', '-l', '-F', 'url-first-seen.json', '--', 'scripts', 'build-plugins', 'services'], {
      cwd: ROOT, encoding: 'utf8',
    }).split('\n').filter(Boolean);
    const offenders = out.filter((file) => {
      if (DIRECT_READERS_ALLOWED.has(file)) return false;
      // Mentions in comments are documentation, not readers.
      const code = read(file).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l)).join('\n');
      return code.includes('url-first-seen.json');
    });
    expect(offenders).toEqual([]);
  });
});
