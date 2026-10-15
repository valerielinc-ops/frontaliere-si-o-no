// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = resolve(ROOT, 'scripts/lib/configure-main-push-auth.sh');
const PAT_TOKEN = 'ghp_dummy_pat_bypass_identity';

function initRepo(originUrl: string): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'configure-main-push-auth-'));
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['remote', 'add', 'origin', originUrl], { cwd: repoDir });
  return repoDir;
}

function originUrl(repoDir: string): string {
  return execFileSync('git', ['remote', 'get-url', 'origin'], {
    cwd: repoDir,
    encoding: 'utf8',
  }).trim();
}

describe('configure-main-push-auth.sh origin owner/repo resolution', () => {
  it('keeps origin on the owner/repo already explicit in the URL, ignoring a mismatched GITHUB_REPOSITORY (workflow_call cross-repo)', () => {
    const repoDir = initRepo('https://github.com/owner-a/repo-a.git');
    try {
      execFileSync('bash', [SCRIPT_PATH], {
        cwd: repoDir,
        env: {
          ...process.env,
          GITHUB_PAT: PAT_TOKEN,
          APP_TOKEN: '',
          // Simulates a `workflow_call` invoked cross-repo: GITHUB_REPOSITORY
          // resolves to the CALLER's repo, not the one origin already targets.
          GITHUB_REPOSITORY: 'owner-b/repo-b',
        },
        encoding: 'utf8',
      });
      expect(originUrl(repoDir)).toBe(`https://x-access-token:${PAT_TOKEN}@github.com/owner-a/repo-a.git`);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('strips an existing x-access-token credential from origin before re-deriving owner/repo', () => {
    const repoDir = initRepo('https://x-access-token:stale-token@github.com/owner-a/repo-a.git');
    try {
      execFileSync('bash', [SCRIPT_PATH], {
        cwd: repoDir,
        env: {
          ...process.env,
          GITHUB_PAT: PAT_TOKEN,
          APP_TOKEN: '',
          GITHUB_REPOSITORY: 'owner-b/repo-b',
        },
        encoding: 'utf8',
      });
      expect(originUrl(repoDir)).toBe(`https://x-access-token:${PAT_TOKEN}@github.com/owner-a/repo-a.git`);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('leaves a non-github.com origin untouched (early exit, in-repo helper test remotes)', () => {
    const repoDir = initRepo('https://example.com/not-a-github-remote.git');
    try {
      execFileSync('bash', [SCRIPT_PATH], {
        cwd: repoDir,
        env: {
          ...process.env,
          GITHUB_PAT: PAT_TOKEN,
          APP_TOKEN: '',
          GITHUB_REPOSITORY: 'owner-b/repo-b',
        },
        encoding: 'utf8',
      });
      expect(originUrl(repoDir)).toBe('https://example.com/not-a-github-remote.git');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('falls back to GITHUB_REPOSITORY when a github.com origin has no cleanly parseable owner/repo path', () => {
    const repoDir = initRepo('https://github.com/owner-a/repo-a/extra-segment.git');
    try {
      execFileSync('bash', [SCRIPT_PATH], {
        cwd: repoDir,
        env: {
          ...process.env,
          GITHUB_PAT: PAT_TOKEN,
          APP_TOKEN: '',
          GITHUB_REPOSITORY: 'owner-b/repo-b',
        },
        encoding: 'utf8',
      });
      expect(originUrl(repoDir)).toBe(`https://x-access-token:${PAT_TOKEN}@github.com/owner-b/repo-b.git`);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('rewrites cleanly without doubling the .git suffix', () => {
    const repoDir = initRepo('https://github.com/owner-a/repo-a.git');
    try {
      execFileSync('bash', [SCRIPT_PATH], {
        cwd: repoDir,
        env: {
          ...process.env,
          GITHUB_PAT: PAT_TOKEN,
          APP_TOKEN: '',
          GITHUB_REPOSITORY: 'owner-a/repo-a',
        },
        encoding: 'utf8',
      });
      const url = originUrl(repoDir);
      expect(url).not.toMatch(/\.git\.git$/);
      expect(url).toBe(`https://x-access-token:${PAT_TOKEN}@github.com/owner-a/repo-a.git`);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

/**
 * actions/checkout >= v6 (v7 here since fe85af95, 2026-09-30) no longer writes
 * `http.https://github.com/.extraheader` into .git/config: it writes the
 * GITHUB_TOKEN header into `$RUNNER_TEMP/git-credentials-<uuid>.config` and
 * pulls it in with `includeIf.gitdir:<repo>/.git.path` (+ worktrees and the
 * container-path variants). The old `--unset-all` left that include in place,
 * the header kept winning over the PAT in the origin URL, and every direct
 * main push went out as github-actions[bot] → GH013 (persist-job-stats run
 * 36784759656 and siblings). Reproduced on a temp repo without network: what
 * is asserted is the configuration git will use, not a push.
 */
const CLEAR_HELPER = resolve(ROOT, 'scripts/lib/clear-checkout-git-credentials.sh');
const CHECKOUT_TOKEN_HEADER = `AUTHORIZATION: basic ${Buffer.from('x-access-token:ghs_checkout_token').toString('base64')}`;
const CREDENTIALS_NAME = 'git-credentials-0f16e234-65bd-4f28-91a4-93315b8295f5.config';

type V7Fixture = { root: string; repoDir: string; unrelatedInclude: string; env: NodeJS.ProcessEnv };

function initCheckoutV7Repo(): V7Fixture {
  // realpath: on macOS tmpdir() is a symlink, and includeIf.gitdir matches
  // the resolved git dir.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'configure-main-push-auth-v7-')));
  const repoDir = join(root, 'repo');
  const runnerTemp = join(root, 'runner-temp');
  mkdirSync(repoDir);
  mkdirSync(runnerTemp);
  // Isolated from the developer's/runner's global and system config: the
  // assertions are about the EFFECTIVE configuration.
  const globalConfig = join(root, 'global.gitconfig');
  writeFileSync(globalConfig, '');
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' };
  delete env.GIT_CONFIG_COUNT;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, env, encoding: 'utf8' });
  git('init', '-q');
  git('remote', 'add', 'origin', 'https://github.com/owner-a/repo-a.git');
  const credentialsFile = join(runnerTemp, CREDENTIALS_NAME);
  writeFileSync(credentialsFile, `[http "https://github.com/"]\n\textraheader = ${CHECKOUT_TOKEN_HEADER}\n`);
  const gitDir = join(repoDir, '.git');
  // The same four entries checkout@v7 writes (the "Checkout" group of any run
  // after 2026-09-30): host path, its worktrees, container path, its worktrees.
  git('config', '--local', `includeIf.gitdir:${gitDir}.path`, credentialsFile);
  git('config', '--local', `includeIf.gitdir:${gitDir}/worktrees/*.path`, credentialsFile);
  git('config', '--local', 'includeIf.gitdir:/github/workspace/.git.path', `/github/runner_temp/${CREDENTIALS_NAME}`);
  git('config', '--local', 'includeIf.gitdir:/github/workspace/.git/worktrees/*.path', `/github/runner_temp/${CREDENTIALS_NAME}`);
  // An include that is not a checkout credentials file must survive.
  const unrelatedInclude = join(root, 'team-settings.config');
  writeFileSync(unrelatedInclude, '[core]\n\tautocrlf = false\n');
  git('config', '--local', '--add', `includeIf.gitdir:${gitDir}.path`, unrelatedInclude);
  return { root, repoDir, unrelatedInclude, env };
}

function gitLines(fx: V7Fixture, args: string[]): string[] {
  try {
    return execFileSync('git', args, { cwd: fx.repoDir, env: fx.env, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

const effectiveHeaders = (fx: V7Fixture) => gitLines(fx, ['config', '--get-all', 'http.https://github.com/.extraheader']);
const includeEntries = (fx: V7Fixture) => gitLines(fx, ['config', '--local', '--get-regexp', '^includeif\\.gitdir:']);

function runBash(fx: V7Fixture, args: string[], extraEnv: NodeJS.ProcessEnv = {}): { status: number; output: string } {
  try {
    const stdout = execFileSync('bash', args, {
      cwd: fx.repoDir,
      env: { ...fx.env, ...extraEnv },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: typeof e.status === 'number' ? e.status : 1, output: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

function expectOnlyUnrelatedInclude(fx: V7Fixture): void {
  expect(effectiveHeaders(fx)).toEqual([]);
  const includes = includeEntries(fx);
  expect(includes.some((line) => line.includes('git-credentials-'))).toBe(false);
  expect(includes).toEqual([expect.stringContaining(fx.unrelatedInclude)]);
}

describe('configure-main-push-auth.sh with actions/checkout@v7 persisted credentials', () => {
  const PAT_ENV = { GITHUB_PAT: PAT_TOKEN, APP_TOKEN: '', GITHUB_REPOSITORY: 'owner-a/repo-a' };

  it('reproduces the trap: the header is effective through includeIf and invisible to --local --unset-all', () => {
    const fx = initCheckoutV7Repo();
    try {
      expect(effectiveHeaders(fx)).toEqual([CHECKOUT_TOKEN_HEADER]);
      // Exit 5, "no such key" in .git/config: the old helper's blind spot.
      expect(() =>
        execFileSync('git', ['config', '--local', '--unset-all', 'http.https://github.com/.extraheader'], {
          cwd: fx.repoDir,
          env: fx.env,
          stdio: 'ignore',
        }),
      ).toThrow();
      expect(effectiveHeaders(fx)).toEqual([CHECKOUT_TOKEN_HEADER]);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('with GITHUB_PAT: drops the checkout includeIf credentials, keeps unrelated includes, rewrites origin', () => {
    const fx = initCheckoutV7Repo();
    try {
      const result = runBash(fx, [SCRIPT_PATH], PAT_ENV);
      expect(result.status, result.output).toBe(0);
      expectOnlyUnrelatedInclude(fx);
      expect(originUrl(fx.repoDir)).toBe(`https://x-access-token:${PAT_TOKEN}@github.com/owner-a/repo-a.git`);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('without GITHUB_PAT/APP_TOKEN: fails closed before touching origin or the checkout credentials', () => {
    const fx = initCheckoutV7Repo();
    try {
      const before = includeEntries(fx);
      const result = runBash(fx, [SCRIPT_PATH], { ...PAT_ENV, GITHUB_PAT: '', GITHUB_TOKEN: 'ghs_ambient' });
      expect(result.status).toBeGreaterThan(0);
      expect(result.output).toMatch(/GITHUB_PAT|APP_TOKEN/);
      expect(includeEntries(fx)).toEqual(before);
      expect(originUrl(fx.repoDir)).toBe('https://github.com/owner-a/repo-a.git');
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('fails closed, without rewriting origin, when an AUTHORIZATION header survives in a scope it must not edit', () => {
    const fx = initCheckoutV7Repo();
    try {
      writeFileSync(
        fx.env.GIT_CONFIG_GLOBAL as string,
        `[http "https://github.com/"]\n\textraheader = ${CHECKOUT_TOKEN_HEADER}\n`,
      );
      const result = runBash(fx, [SCRIPT_PATH], PAT_ENV);
      expect(result.status).toBeGreaterThan(0);
      expect(result.output).toContain('still effective');
      expect(result.output).not.toContain(CHECKOUT_TOKEN_HEADER.split(' ').pop());
      expect(originUrl(fx.repoDir)).toBe('https://github.com/owner-a/repo-a.git');

      // git's own list rule (an empty value clears the headers collected so
      // far) is honoured: a later empty extraheader neutralises the survivor.
      const reset = runBash(fx, [SCRIPT_PATH], {
        ...PAT_ENV,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: '',
      });
      expect(reset.status, reset.output).toBe(0);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

/**
 * Class guard. Workflows whose working tree is not trusted code at that point
 * (a PR head, or a tree the agent already edited) cannot run the versioned
 * helper with a token in the environment, so they carry an inline copy of its
 * includeIf loop. The copies must stay identical and must behave like the
 * helper; any other `--unset-all …extraheader` site must reach the helper.
 */
const INLINE_SITES = [
  '.github/workflows/pr-redcheck-fixer.yml',
  '.github/workflows/pr-redflag-fixer.yml',
  '.github/workflows/issue-fix.yml',
];
const INLINE_START = 'while IFS= read -r inc_key; do';
const INLINE_END = "done < <({ git config --local --name-only --get-regexp '^includeif\\.gitdir:' || true; } | sort -u)";

function inlineCopies(file: string): string[] {
  const lines = readFileSync(resolve(ROOT, file), 'utf8').split('\n');
  const copies: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== INLINE_START) continue;
    const end = lines.findIndex((line, j) => j > i && line.trim() === INLINE_END);
    expect(end, `${file}:${i + 1}: inline loop without its closing line`).toBeGreaterThan(i);
    const indent = lines[i].length - lines[i].trimStart().length;
    copies.push(lines.slice(i, end + 1).map((line) => line.slice(indent)).join('\n'));
  }
  return copies;
}

function filesUnder(dir: string, exts: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...filesUnder(full, exts));
    } else if (exts.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('checkout credential removal outside configure-main-push-auth.sh', () => {
  it('every inline copy is identical and drops the checkout@v7 includeIf credentials like the helper', () => {
    const copies = INLINE_SITES.flatMap((file) => inlineCopies(file).map((text) => ({ file, text })));
    expect(copies.map((c) => c.file)).toEqual(INLINE_SITES);
    expect(new Set(copies.map((c) => c.text)).size, copies.map((c) => `${c.file}\n${c.text}`).join('\n\n')).toBe(1);

    // Both shells the steps run with: the Actions default `bash -e` and a
    // body that opts into `set -euo pipefail`.
    for (const prelude of ['', 'set -euo pipefail\n']) {
      const fx = initCheckoutV7Repo();
      try {
        const result = runBash(fx, ['-e', '-c', `${prelude}${copies[0].text}`]);
        expect(result.status, result.output).toBe(0);
        expectOnlyUnrelatedInclude(fx);
      } finally {
        rmSync(fx.root, { recursive: true, force: true });
      }
    }
  });

  it('the shared helper does the same, and is idempotent on an already-clean repo', () => {
    const fx = initCheckoutV7Repo();
    try {
      for (let pass = 0; pass < 2; pass++) {
        const result = runBash(fx, [CLEAR_HELPER]);
        expect(result.status, result.output).toBe(0);
        expectOnlyUnrelatedInclude(fx);
      }
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('no `--unset-all …extraheader` site relies on the unset alone', () => {
    const sources = [
      ...filesUnder(resolve(ROOT, '.github'), /\.ya?ml$/),
      ...filesUnder(resolve(ROOT, 'scripts'), /\.(sh|mjs|cjs|js)$/),
    ];
    const bare: string[] = [];
    for (const file of sources) {
      if (file === CLEAR_HELPER) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(#|\/\/|\*)/.test(line) || !/unset-all\b.*extraheader/.test(line)) return;
        const window = lines.slice(i, i + 12).join('\n');
        if (!window.includes(INLINE_START) && !window.includes('clear-checkout-git-credentials.sh')) {
          bare.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(bare, bare.join('\n')).toEqual([]);
  });
});
