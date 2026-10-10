// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

/**
 * The isolated commit path runs inside the global data-pipeline lease and most
 * of it prints nothing. Issue 12379: the first attempt of the crawler groups
 * stayed silent for 52-197 s (runs 37597639187, 37686343357, 37686863730,
 * 37687760826) between the "candidate(s)" line and the next one, and the log
 * could not tell which of the steps in between was waiting. Every attempt now
 * ends with one line that says where its time went.
 */
const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = resolve(ROOT, 'scripts/lib/git-commit-data.sh');
const BASH_BIN = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash'].find(existsSync) ?? 'bash';
const SLICE_DIR = 'data/jobs/by-crawler';
const PHASES = ['fetch', 'history-guard', 'skip-scan', 'seed-index', 'ownership-view', 'files', 'tree', 'commit', 'push'];
const TIMING_LINE = /^⏱️ grouped-isolated attempt (\d+) timings: (.+)$/gmu;

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function slice(key: string, jobs: Array<Record<string, unknown>>) {
  return `${JSON.stringify({ companyKey: key, jobs }, null, 2)}\n`;
}

function job(key: string, n: number, extra: Record<string, unknown> = {}) {
  return { url: `https://jobs.example.com/${key}/${n}`, title: `Job ${key}${n}`, ...extra };
}

/** The phase labels of a timing line, in the order the line prints them. */
function phasesOf(body: string): string[] {
  // Split only at top-level commas: a phase detail can itself contain nested
  // parentheses, as in "5 remote slice(s) refreshed since last snapshot".
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index++) {
    if (body[index] === '(') depth++;
    else if (body[index] === ')') depth--;
    else if (depth === 0 && body.startsWith(', ', index)) {
      parts.push(body.slice(start, index));
      start = index + 2;
      index++;
    }
    expect(depth, `unbalanced timing detail in "${body}"`).toBeGreaterThanOrEqual(0);
  }
  expect(depth, `unbalanced timing detail in "${body}"`).toBe(0);

  return parts.concat(body.slice(start)).map((part) => {
    const match = /^([a-z-]+) \d+\.\d s(?: \(.+\))?$/u.exec(part);
    expect(match, `unexpected timing fragment "${part}" in "${body}"`).not.toBeNull();
    return match![1];
  });
}

function timingLines(log: string) {
  return [...log.matchAll(TIMING_LINE)].map((match) => ({ attempt: Number(match[1]), body: match[2] }));
}

it('parses nested phase annotations without splitting their commas', () => {
  expect(phasesOf('fetch 0.0 s, ownership-view 0.0 s (5 remote slice(s), refreshed since snapshot), files 0.2 s (integrity 0.1 s)'))
    .toEqual(['fetch', 'ownership-view', 'files']);
});

function setup(keys: string[]) {
  const originDir = mkdtempSync(join(tmpdir(), 'gcd-timings-origin-'));
  const repoDir = mkdtempSync(join(tmpdir(), 'gcd-timings-repo-'));
  const otherDir = mkdtempSync(join(tmpdir(), 'gcd-timings-other-'));
  const shimDir = mkdtempSync(join(tmpdir(), 'gcd-timings-shim-'));
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', originDir]);
  execFileSync('git', ['clone', '-q', originDir, repoDir]);
  git(repoDir, 'config', 'user.email', 'test@example.com');
  git(repoDir, 'config', 'user.name', 'Test');
  mkdirSync(join(repoDir, SLICE_DIR), { recursive: true });
  for (const key of keys) writeFileSync(join(repoDir, SLICE_DIR, `${key}.json`), slice(key, [job(key, 1), job(key, 2)]));
  git(repoDir, 'add', '.');
  git(repoDir, 'commit', '-q', '-m', 'seed');
  git(repoDir, 'push', '-q', 'origin', 'HEAD:main');
  // The retry backoff is 5-24 s of real sleep: make it instant here.
  writeFileSync(join(shimDir, 'sleep'), '#!/bin/bash\nexit 0\n');
  chmodSync(join(shimDir, 'sleep'), 0o755);

  const shim = (name: string, lines: string[]) => {
    writeFileSync(join(shimDir, name), [...lines, ''].join('\n'));
    chmodSync(join(shimDir, name), 0o755);
  };
  const run = (cwd = repoDir, extraEnv: Record<string, string> = {}) => {
    const result = spawnSync(BASH_BIN, [SCRIPT_PATH, '--slice-only', 'timings commit', `${SLICE_DIR}/`], {
      cwd,
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
        ...extraEnv,
      },
    });
    return { status: result.status, log: `${result.stdout}${result.stderr}` };
  };
  const cleanup = () => {
    for (const dir of [originDir, repoDir, otherDir, shimDir]) rmSync(dir, { recursive: true, force: true });
  };
  return { originDir, repoDir, otherDir, shimDir, shim, run, cleanup };
}

const edit = (repoDir: string, key: string, jobs: Array<Record<string, unknown>>) =>
  writeFileSync(join(repoDir, SLICE_DIR, `${key}.json`), slice(key, jobs));

describe('git-commit-data: every isolated attempt says where its time went', () => {
  it('prints one timing line per attempt, for the rejected push and for the one that lands', () => {
    const t = setup(['a', 'b', 'c']);
    try {
      edit(t.repoDir, 'a', [job('a', 1, { titleByLocale: { en: 'A1' } }), job('a', 2)]);
      edit(t.repoDir, 'b', [job('b', 1), job('b', 2), job('b', 3)]);

      // Another writer moves main while our first push is on its way.
      const otherClone = join(t.otherDir, 'clone');
      execFileSync('git', ['clone', '-q', t.originDir, otherClone]);
      git(otherClone, 'config', 'user.email', 'other@example.com');
      git(otherClone, 'config', 'user.name', 'Other');
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      const counter = join(t.shimDir, 'pushes');
      writeFileSync(counter, '0');
      const remoteEdit = slice('c', [job('c', 1), job('c', 2, { title: 'Job c2 (remote edit)' })]);
      t.shim('git', [
        '#!/bin/bash',
        'is_push=false',
        'for arg in "$@"; do [ "$arg" = "push" ] && is_push=true; done',
        'if [ "$is_push" = true ]; then',
        `  n=$(cat '${counter}'); echo $((n + 1)) > '${counter}'`,
        '  if [ "$n" = "0" ]; then',
        `    printf '%s' '${remoteEdit}' > '${otherClone}/${SLICE_DIR}/c.json'`,
        `    '${realGit}' -C '${otherClone}' commit -q -am 'other writer: c' >/dev/null`,
        `    '${realGit}' -C '${otherClone}' push -q origin HEAD:main >/dev/null 2>&1`,
        '  fi',
        'fi',
        `exec '${realGit}' "$@"`,
      ]);

      const { status, log } = t.run();
      expect(status, log).toBe(0);
      expect(log).toContain('Push rejected (attempt 1/3)');
      expect(log).toContain('Pushed successfully');

      const lines = timingLines(log);
      expect(lines.map((line) => line.attempt), log).toEqual([1, 2]);
      for (const line of lines) expect(phasesOf(line.body), line.body).toEqual(PHASES);
      // A complete clone has every remote slice at hand.
      expect(log).not.toContain('fetched on demand');

      // The line closes its own attempt: after that attempt's last step and
      // before the next attempt starts.
      const at = (needle: string) => {
        const index = log.indexOf(needle);
        expect(index, `missing "${needle}"`).toBeGreaterThanOrEqual(0);
        return index;
      };
      expect(at('grouped-isolated attempt 1: 2 file(s) computed')).toBeLessThan(at('grouped-isolated attempt 1 timings:'));
      expect(at('grouped-isolated attempt 1 timings:')).toBeLessThan(at('grouped-isolated attempt 2: '));
      expect(at('grouped-isolated attempt 2: ')).toBeLessThan(at('grouped-isolated attempt 2 timings:'));
    } finally {
      t.cleanup();
    }
  }, 120_000);

  it('charges a slow step to its own label and names the file it was spent on', () => {
    const t = setup(['a', 'b', 'c']);
    try {
      edit(t.repoDir, 'a', [job('a', 1, { titleByLocale: { en: 'A1' } }), job('a', 2)]);
      // b brings a new vacancy: its ownership check reads the remote view.
      edit(t.repoDir, 'b', [job('b', 1), job('b', 2), job('b', 3)]);
      edit(t.repoDir, 'c', [job('c', 1, { titleByLocale: { en: 'C1' } }), job('c', 2)]);

      // The ownership helper of b stalls for two seconds, as a silent step
      // would in production. /bin/sleep: the shim directory makes `sleep` instant.
      t.shim('node', [
        '#!/bin/bash',
        'if [[ "$*" == *crawler-commit-ownership.mjs*' + `${SLICE_DIR}/b.json` + '* ]]; then /bin/sleep 2; fi',
        `exec '${process.execPath}' "$@"`,
      ]);

      const { status, log } = t.run();
      expect(status, log).toBe(0);
      const lines = timingLines(log);
      expect(lines.map((line) => line.attempt), log).toEqual([1]);
      const { body } = lines[0];
      expect(phasesOf(body), body).toEqual(PHASES);

      const seconds = (pattern: RegExp) => {
        const match = pattern.exec(body);
        expect(match, `${pattern} not found in "${body}"`).not.toBeNull();
        return Number(match![1]);
      };
      const files = seconds(/(?:^|, )files (\d+\.\d) s \(/u);
      const ownership = seconds(/\((?:[^)]*, )?ownership (\d+\.\d) s/u);
      const slowest = seconds(new RegExp(`; slowest ${SLICE_DIR}/b\\.json (\\d+\\.\\d) s\\)`, 'u'));
      expect(ownership).toBeGreaterThanOrEqual(2);
      expect(slowest).toBeGreaterThanOrEqual(2);
      // The parts never add up to more than the whole.
      expect(files).toBeGreaterThanOrEqual(ownership);
      expect(files).toBeGreaterThanOrEqual(slowest);
      // The stall is charged to `files` only: the phases around it stay short.
      for (const phase of ['seed-index', 'tree']) {
        expect(seconds(new RegExp(`(?:^|, )${phase} (\\d+\\.\\d) s`, 'u')), body).toBeLessThan(2);
      }
    } finally {
      t.cleanup();
    }
  }, 120_000);

  it('charges the commit object to its own phase, so `push` is the round trip alone', () => {
    const t = setup(['a', 'b']);
    try {
      edit(t.repoDir, 'a', [job('a', 1, { titleByLocale: { en: 'A1' } }), job('a', 2)]);
      // A stall while the commit object is built must not read as a slow push.
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      t.shim('git', [
        '#!/bin/bash',
        'for arg in "$@"; do if [ "$arg" = "commit-tree" ]; then /bin/sleep 2; fi; done',
        `exec '${realGit}' "$@"`,
      ]);

      const { status, log } = t.run();
      expect(status, log).toBe(0);
      const [line] = timingLines(log);
      expect(phasesOf(line.body), line.body).toEqual(PHASES);
      const seconds = (phase: string) => Number(new RegExp(`(?:^|, )${phase} (\\d+\\.\\d) s`, 'u').exec(line.body)?.[1]);
      expect(seconds('commit'), line.body).toBeGreaterThanOrEqual(2);
      expect(seconds('push'), line.body).toBeLessThan(2);
      expect(seconds('tree'), line.body).toBeLessThan(2);
    } finally {
      t.cleanup();
    }
  }, 120_000);

  it('says so when the missing slices cannot be counted, instead of reporting none', () => {
    const t = setup(['a', 'b']);
    try {
      edit(t.repoDir, 'a', [job('a', 1), job('a', 2), job('a', 3)]);
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      t.shim('git', [
        '#!/bin/bash',
        'for arg in "$@"; do if [ "$arg" = "--missing=print" ]; then echo "fatal: simulated rev-list failure" >&2; exit 128; fi; done',
        `exec '${realGit}' "$@"`,
      ]);

      const { status, log } = t.run();
      // The count is observation only: the commit still lands.
      expect(status, log).toBe(0);
      expect(log).toContain('Pushed successfully');
      const [line] = timingLines(log);
      expect(phasesOf(line.body), line.body).toEqual(PHASES);
      expect(log).toContain('grouped-isolated ownership-view prepared before lease: remote slice count unavailable');
    } finally {
      t.cleanup();
    }
  }, 120_000);

  it('counts the remote slices a blobless checkout has to fetch for the ownership view', () => {
    // The crawler groups run from a sparse checkout, which actions/checkout
    // turns into a partial clone without blobs (corpus run 37686343357:
    // `fetch --filter=blob:none --depth=50`). Seventy minutes later the
    // ownership view needs every slice that moved on main in the meantime.
    const keys = Array.from({ length: 8 }, (_, index) => `s${index}`);
    const t = setup(keys);
    try {
      git(t.originDir, 'config', 'uploadpack.allowFilter', 'true');
      git(t.originDir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
      const runner = join(t.otherDir, 'runner');
      execFileSync('git', [
        'clone', '-q', '--depth=1', '--filter=blob:none', '--no-checkout', '--branch', 'main', `file://${t.originDir}`, runner,
      ]);
      git(runner, 'sparse-checkout', 'set', '--no-cone', '/*', '!/data/jobs/by-crawler/*.json', '/data/jobs/by-crawler/s0.json', '/data/jobs/by-crawler/s6.json', '/data/jobs/by-crawler/s7.json');
      git(runner, 'checkout', '-q', 'main');
      git(runner, 'config', 'user.email', 'test@example.com');
      git(runner, 'config', 'user.name', 'Test');

      // After that checkout another writer changes five slices on main.
      const changed = keys.slice(1, 6);
      for (const key of changed) edit(t.repoDir, key, [job(key, 1, { title: `Job ${key}1 (remote edit)` }), job(key, 2)]);
      git(t.repoDir, 'commit', '-q', '-am', 'other writers');
      git(t.repoDir, 'push', '-q', 'origin', 'HEAD:main');

      // Ours: a slice the remote did not touch, with a new vacancy.
      edit(runner, 's0', [job('s0', 1), job('s0', 2), job('s0', 3)]);
      const { status, log } = t.run(runner);
      expect(status, log).toBe(0);
      expect(log).toContain('Pushed successfully');

      const lines = timingLines(log);
      expect(lines.map((line) => line.attempt), log).toEqual([1]);
      expect(phasesOf(lines[0].body), lines[0].body).toEqual(PHASES);
      expect(log).toMatch(
        new RegExp(`grouped-isolated ownership-view prepared before lease: ${changed.length} of ${keys.length} remote slices fetched on demand`, 'u'),
      );
    } finally {
      t.cleanup();
    }
  }, 120_000);

  it('prepares ownership outside the lease, then refreshes only intervening slices before filtering claims', () => {
    const keys = Array.from({ length: 8 }, (_, index) => `s${index}`);
    const t = setup(keys);
    try {
      git(t.originDir, 'config', 'uploadpack.allowFilter', 'true');
      git(t.originDir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
      const runner = join(t.otherDir, 'runner');
      execFileSync('git', [
        'clone', '-q', '--depth=1', '--filter=blob:none', '--no-checkout', '--branch', 'main', `file://${t.originDir}`, runner,
      ]);
      git(runner, 'sparse-checkout', 'set', '--no-cone', '/*', '!/data/jobs/by-crawler/*.json', '/data/jobs/by-crawler/s0.json', '/data/jobs/by-crawler/s6.json', '/data/jobs/by-crawler/s7.json');
      git(runner, 'checkout', '-q', 'main');
      git(runner, 'config', 'user.email', 'test@example.com');
      git(runner, 'config', 'user.name', 'Test');

      const changedBeforeLease = keys.slice(1, 6);
      for (const key of changedBeforeLease) edit(t.repoDir, key, [job(key, 1), job(key, 2, { title: `Remote ${key}` })]);
      git(t.repoDir, 'commit', '-q', '-am', 'other writer before ownership preparation');
      git(t.repoDir, 'push', '-q', 'origin', 'HEAD:main');

      const sharedUrl = 'https://jobs.example.com/shared/1';
      edit(runner, 's0', [job('s0', 1), job('s0', 2), job('s0', 3, { url: sharedUrl })]);
      const otherClone = join(t.otherDir, 'lease-writer');
      execFileSync('git', ['clone', '-q', t.originDir, otherClone]);
      git(otherClone, 'config', 'user.email', 'other@example.com');
      git(otherClone, 'config', 'user.name', 'Other');
      edit(otherClone, 's7', [job('s7', 1), job('s7', 2), job('s7', 3, { url: sharedUrl })]);
      git(otherClone, 'commit', '-q', '-am', 'other writer while lease is acquired');

      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      const realNode = process.execPath;
      const order = join(t.shimDir, 'ownership-order');
      const triggered = join(t.shimDir, 'lease-writer-triggered');
      t.shim('git', [
        '#!/bin/bash',
        `if [ "\${1:-}" = archive ]; then printf 'archive %s\\n' "$*" >> '${order}'; fi`,
        `exec '${realGit}' "$@"`,
      ]);
      t.shim('node', [
        '#!/bin/bash',
        'if [[ "$*" == *global-data-pipeline-lease.mjs* ]]; then',
        '  case " $* " in',
        '    *" acquire "*)',
        `      printf 'lease-acquire\\n' >> '${order}'`,
        `      if [ ! -f '${triggered}' ]; then '${realGit}' -C '${otherClone}' push -q origin HEAD:main >/dev/null 2>&1; : > '${triggered}'; fi`,
        '      exit 0 ;;',
        "    *' release '*) printf 'lease-release\\n' >> '" + order + "'; exit 0 ;;",
        '  esac',
        'fi',
        `exec '${realNode}' "$@"`,
      ]);

      const { status, log } = t.run(runner, { DATA_PIPELINE_LEASE: '1' });
      expect(status, log).toBe(0);
      expect(log).toContain('grouped-isolated ownership-view prepared before lease: 5 of 8 remote slices fetched on demand');
      expect(log).toContain('1 remote slice(s) refreshed since last snapshot');
      expect(log).toContain('ownership guard filtered new claims from data/jobs/by-crawler/s0.json');

      const orderLines = readFileSync(order, 'utf8').trim().split('\n');
      const firstArchive = orderLines.findIndex((line) => line.startsWith('archive '));
      const leaseAcquire = orderLines.indexOf('lease-acquire');
      expect(firstArchive).toBeGreaterThanOrEqual(0);
      expect(leaseAcquire).toBeGreaterThan(firstArchive);
      expect(orderLines.some((line) => line.includes('-- data/jobs/by-crawler/s7.json'))).toBe(true);
      expect(git(t.originDir, 'show', 'main:data/jobs/by-crawler/s7.json')).toContain(sharedUrl);
      expect(git(t.originDir, 'show', 'main:data/jobs/by-crawler/s0.json')).not.toContain(sharedUrl);
    } finally {
      t.cleanup();
    }
  }, 120_000);

  it('reports the attempt that finds nothing to publish', () => {
    const t = setup(['a', 'b']);
    try {
      // Nothing changed: no candidate, no ownership view, no push.
      const { status, log } = t.run();
      expect(status, log).toBe(0);
      expect(log).toContain('0 candidate(s)');
      expect(log).not.toContain('Pushed successfully');

      const lines = timingLines(log);
      expect(lines.map((line) => line.attempt), log).toEqual([1]);
      expect(phasesOf(lines[0].body), lines[0].body).toEqual(
        PHASES.filter((phase) => !['ownership-view', 'commit', 'push'].includes(phase)),
      );
      expect(log.indexOf('grouped-isolated attempt 1 timings:')).toBeLessThan(log.indexOf('nothing to commit'));
    } finally {
      t.cleanup();
    }
  }, 120_000);
});
