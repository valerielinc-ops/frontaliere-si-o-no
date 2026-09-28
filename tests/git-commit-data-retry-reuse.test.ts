// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

/**
 * A rejected push used to rebuild the whole isolated commit: ownership guard
 * (a scan of every remote slice), 3-way merge and integrity guard for every
 * file. translate-pending hands the script ~560 slices, ~2.4 s each, so each
 * attempt lasted ~20 minutes, main moved again meanwhile, and corpus runs
 * 36280478724 / 36298797251 retried 6+ times (140+ min) until the 350-minute
 * job cap killed them with nothing published. A retry now recomputes only the
 * files whose inputs changed, and the ownership helper skips the remote scan
 * when a slice brings no new claim.
 */
const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = resolve(ROOT, 'scripts/lib/git-commit-data.sh');
const OWNERSHIP_HELPER = resolve(ROOT, 'scripts/lib/crawler-commit-ownership.mjs');
const BASH_BIN = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash'].find(existsSync) ?? 'bash';

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function slice(key: string, jobs: Array<Record<string, unknown>>) {
  return `${JSON.stringify({ companyKey: key, jobs }, null, 2)}\n`;
}

function job(key: string, n: number, extra: Record<string, unknown> = {}) {
  return { url: `https://jobs.example.com/${key}/${n}`, title: `Job ${key}${n}`, ...extra };
}

describe('git-commit-data: a rejected push reuses unchanged per-file results', () => {
  it('recomputes on the retry only the slices whose remote moved or that bring new claims', () => {
    const originDir = mkdtempSync(join(tmpdir(), 'gcd-reuse-origin-'));
    const repoDir = mkdtempSync(join(tmpdir(), 'gcd-reuse-repo-'));
    const otherDir = mkdtempSync(join(tmpdir(), 'gcd-reuse-other-'));
    const shimDir = mkdtempSync(join(tmpdir(), 'gcd-reuse-shim-'));
    try {
      execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', originDir]);
      execFileSync('git', ['clone', '-q', originDir, repoDir]);
      for (const dir of [repoDir]) {
        git(dir, 'config', 'user.email', 'test@example.com');
        git(dir, 'config', 'user.name', 'Test');
      }
      const sliceDir = join(repoDir, 'data/jobs/by-crawler');
      mkdirSync(sliceDir, { recursive: true });
      for (const key of ['a', 'b', 'c']) {
        writeFileSync(join(sliceDir, `${key}.json`), slice(key, [job(key, 1), job(key, 2)]));
      }
      git(repoDir, 'add', '.');
      git(repoDir, 'commit', '-q', '-m', 'seed');
      git(repoDir, 'push', '-q', 'origin', 'HEAD:main');

      // Translation-like local edits on all three slices; b also brings a new
      // vacancy, i.e. a claim the ownership guard must judge on every attempt.
      writeFileSync(join(sliceDir, 'a.json'), slice('a', [job('a', 1, { titleByLocale: { en: 'A1' } }), job('a', 2)]));
      writeFileSync(join(sliceDir, 'b.json'), slice('b', [job('b', 1, { titleByLocale: { en: 'B1' } }), job('b', 2), job('b', 3)]));
      writeFileSync(join(sliceDir, 'c.json'), slice('c', [job('c', 1, { titleByLocale: { en: 'C1' } }), job('c', 2)]));

      // Another writer moves main during our first attempt: its push lands just
      // before ours, so the first push is rejected for real (fetch first).
      const otherClone = join(otherDir, 'clone');
      execFileSync('git', ['clone', '-q', originDir, otherClone]);
      git(otherClone, 'config', 'user.email', 'other@example.com');
      git(otherClone, 'config', 'user.name', 'Other');
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      const counter = join(shimDir, 'pushes');
      writeFileSync(counter, '0');
      writeFileSync(
        join(shimDir, 'git'),
        [
          '#!/bin/bash',
          'if [ "$1" = "push" ]; then',
          `  n=$(cat '${counter}'); echo $((n + 1)) > '${counter}'`,
          '  if [ "$n" = "0" ]; then',
          `    printf '%s' '${slice('c', [job('c', 1), job('c', 2, { title: 'Job c2 (remote edit)' })]).replace(/'/g, "'\\''")}' > '${otherClone}/data/jobs/by-crawler/c.json'`,
          `    '${realGit}' -C '${otherClone}' commit -q -am 'other writer: c' >/dev/null`,
          `    '${realGit}' -C '${otherClone}' push -q origin HEAD:main >/dev/null 2>&1`,
          '  fi',
          'fi',
          `exec '${realGit}' "$@"`,
          '',
        ].join('\n'),
      );
      chmodSync(join(shimDir, 'git'), 0o755);
      // The retry backoff is 5-24 s of real sleep: make it instant here.
      writeFileSync(join(shimDir, 'sleep'), '#!/bin/bash\nexit 0\n');
      chmodSync(join(shimDir, 'sleep'), 0o755);

      const result = spawnSync(BASH_BIN, [SCRIPT_PATH, '--slice-only', 'translate commit', 'data/jobs/by-crawler/'], {
        cwd: repoDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}`,
          MAX_PUSH_ATTEMPTS: '3',
          SKIP_AI_TRANSLATION: '1',
          SLUG_HISTORY_SUMMARY_FILE: join(repoDir, 'no-such-slug-history-summary.txt'),
          JOBS_HOUSEKEEPING_PROOF_DIR: join(shimDir, 'no-proofs'),
          GH_TOKEN: '',
          GITHUB_TOKEN: '',
          GITHUB_RUN_ID: '',
          GITHUB_REPOSITORY: '',
          GITHUB_OUTPUT: '',
        },
      });
      const log = `${result.stdout}${result.stderr}`;
      expect(result.status, log).toBe(0);
      expect(log).toContain('Push rejected (attempt 1/3)');
      expect(log).toContain('grouped-isolated attempt 1: 3 file(s) computed, 0 reused from the previous attempt');
      // a: unchanged inputs -> reused. b: new claim -> ownership consulted,
      // never reused. c: remote blob moved -> recomputed and re-merged.
      expect(log).toContain('grouped-isolated attempt 2: 2 file(s) computed, 1 reused from the previous attempt');
      expect(log).toContain('Pushed successfully');

      git(repoDir, 'fetch', '-q', 'origin', 'main');
      const remote = (key: string) => JSON.parse(git(repoDir, 'show', `origin/main:data/jobs/by-crawler/${key}.json`));
      expect(remote('a').jobs[0].titleByLocale).toEqual({ en: 'A1' });
      expect(remote('b').jobs.map((j: { url: string }) => j.url)).toContain('https://jobs.example.com/b/3');
      // Both sides of c survive: the other writer's edit and our translation.
      expect(remote('c').jobs[0].titleByLocale).toEqual({ en: 'C1' });
      expect(remote('c').jobs[1].title).toBe('Job c2 (remote edit)');
    } finally {
      for (const dir of [originDir, repoDir, otherDir, shimDir]) rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('crawler-commit-ownership: no new claim, no remote scan', () => {
  function run(localJobs: Array<Record<string, unknown>>, baseJobs: Array<Record<string, unknown>>) {
    const dir = mkdtempSync(join(tmpdir(), 'ownership-fast-'));
    try {
      // The remote view holds another crawler already publishing x/1.
      mkdirSync(join(dir, 'root/data/jobs/by-crawler'), { recursive: true });
      writeFileSync(join(dir, 'root/data/jobs/by-crawler/other.json'), slice('other', [job('x', 1)]));
      writeFileSync(join(dir, 'base.json'), slice('mine', baseJobs));
      writeFileSync(join(dir, 'local.json'), slice('mine', localJobs));
      const stdout = execFileSync(process.execPath, [
        OWNERSHIP_HELPER, 'mine', join(dir, 'base.json'), join(dir, 'local.json'),
        join(dir, 'root'), join(dir, 'out.json'), join(dir, 'verdict'),
      ], { encoding: 'utf8' });
      return {
        dropped: JSON.parse(stdout).dropped,
        verdict: readFileSync(join(dir, 'verdict'), 'utf8').trim(),
        identical: readFileSync(join(dir, 'out.json'), 'utf8') === readFileSync(join(dir, 'local.json'), 'utf8'),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('skips the ownership view when every URL was already in the base', () => {
    expect(run([job('mine', 1, { titleByLocale: { en: 'T' } })], [job('mine', 1)]))
      .toEqual({ dropped: [], verdict: 'skipped', identical: true });
  });

  it('still consults it, and still drops a foreign-owned new claim', () => {
    const result = run([job('mine', 1), job('x', 1)], [job('mine', 1)]);
    expect(result.verdict).toBe('consulted');
    expect(result.dropped).toEqual([{ url: 'https://jobs.example.com/x/1', owner: 'other' }]);
  });
});
