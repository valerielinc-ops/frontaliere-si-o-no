// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const GIT_COMMIT_DATA_PATH = resolve(ROOT, 'scripts/lib/git-commit-data.sh');
const GIT_COMMIT_DATA = readFileSync(GIT_COMMIT_DATA_PATH, 'utf-8');
const WORKFLOWS_DIR = resolve(ROOT, '.github/workflows');

// Consolidation (2026-07): these 3 crawlers no longer have their own
// `.github/workflows/update-jobs-{slug}.yml` — they were folded into grouped
// `crawler-group-*.yml` workflows as `background: true` steps (see
// scripts/generate-crawler-group-workflows.mjs). Each crawler's own env
// values (including GH_TOKEN for the commit-and-push phase) are declared in
// that step's own YAML `env:` map rather than spliced into the shell body
// (root-cause fix for #3713: a text-spliced `${{ ... }}` resolves to literal
// text before the shell parses the line, which is an injection risk for any
// expression an actor can influence). Rather than hardcode which group each
// crawler currently lands in (bin-packing can reassign groups whenever the
// generator re-runs), locate the crawler's own background step by its
// stable `name: Run <slug>` marker in whichever group file currently
// contains it.
const DEDICATED_CRAWLER_SLUGS = ['spital-lachen', 'hopital-de-lavaux', 'hoch-health'] as const;

function findCrawlerBlock(slug: string): string {
  const groupFiles = readdirSync(WORKFLOWS_DIR).filter((f) => /^crawler-group-\d+\.yml$/.test(f));
  for (const file of groupFiles) {
    const content = readFileSync(resolve(WORKFLOWS_DIR, file), 'utf-8');
    const stepStart = content.indexOf(`- name: Run ${slug}\n`);
    if (stepStart === -1) continue;
    // The next background step (or the final `wait-all` step) starts the
    // next `- name:` at the same indentation — slice up to there, or to EOF.
    const nextStepIdx = content.indexOf('\n      - name:', stepStart + 1);
    return content.slice(stepStart, nextStepIdx === -1 ? undefined : nextStepIdx);
  }
  throw new Error(`Crawler '${slug}' not found as a background step in any crawler-group-*.yml`);
}

describe('git-commit-data.sh GitHub auth hardening', () => {
  it('fail-closes on GITHUB_PAT/APP_TOKEN via configure-main-push-auth.sh (ruleset-era)', () => {
    expect(GIT_COMMIT_DATA).toContain('configure-main-push-auth.sh');
    expect(GIT_COMMIT_DATA).not.toContain('local token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"');
    expect(GIT_COMMIT_DATA).not.toContain('token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"');
    expect(GIT_COMMIT_DATA).not.toContain('CHECKOUT_GIT_EXTRAHEADER=');
  });

  it('refreshes git auth before every network operation in the retry loop', () => {
    const networkOps = [...GIT_COMMIT_DATA.matchAll(/^\s*git (fetch|pull|push)\b/gm)];
    expect(networkOps.length).toBeGreaterThan(0);

    for (const match of networkOps) {
      const before = GIT_COMMIT_DATA.slice(Math.max(0, match.index - 160), match.index);
      expect(before, `missing ensure_git_auth before: ${match[0]}`).toMatch(/ensure_git_auth\s*$/m);
    }
  });
});

describe('dedicated crawlers using git-commit-data.sh (now inlined in crawler-group-*.yml)', () => {
  it('pass GH_TOKEN via the step env: map (never spliced into the shell body)', () => {
    for (const slug of DEDICATED_CRAWLER_SLUGS) {
      const block = findCrawlerBlock(slug);
      // Root-cause fix for #3713: GH_TOKEN must be declared in the step's own
      // YAML `env:` map, resolved directly to a process env var by GitHub —
      // never text-spliced as `export GH_TOKEN="${{ ... }}"` into the run
      // body, where GitHub substitutes the expression to literal text before
      // the shell parses the line (injection risk for any actor-controlled
      // value that could contain `"` or a backtick).
      expect(block, `crawler '${slug}' missing GH_TOKEN in step env:`).toMatch(
        /env:\n(?:.*\n)*?\s+GH_TOKEN: \$\{\{ (?:secrets\.GITHUB_TOKEN|github\.token) \}\}/,
      );
      expect(
        block,
        `crawler '${slug}' still splices GH_TOKEN into the shell body instead of using step env:`,
      ).not.toMatch(/export GH_TOKEN=/);
    }
  });
});

// Regression coverage for the group-06 production incident (2026-07-06): one
// crawler's git commit crashed mid-operation inside a shared crawler-group-*.yml
// job, leaving `.git/index.lock` behind. Every subsequently-queued crawler in
// that same group then hit git's own "Another git process seems to be
// running..." guard and failed too, even though the `flock
// /tmp/crawler-group-git.lock` wrapper around each crawler's commit-and-push
// step (added in #3701) had already released — flock releases automatically
// when the holding process dies, but a plain `.git/index.lock` FILE has no
// such lifecycle binding and is never cleaned up after an abnormal exit.
describe('git-commit-data.sh stale .git/index.lock recovery (group-06 incident)', () => {
  it('removes .git/index.lock before the first git-index-mutating operation', () => {
    const lockCheckIndex = GIT_COMMIT_DATA.indexOf('.git/index.lock');
    const setEIndex = GIT_COMMIT_DATA.indexOf('set -euo pipefail');

    expect(lockCheckIndex, 'no .git/index.lock handling found in git-commit-data.sh').toBeGreaterThan(-1);
    expect(GIT_COMMIT_DATA).toMatch(/if \[ -f "\.git\/index\.lock" \]; then[\s\S]*?rm -f "\.git\/index\.lock"/);

    // Runs early (right after set -euo pipefail / merge-driver registration),
    // strictly before the first executable `git stash`/`add`/`commit`
    // statement anywhere in the file — including inside function bodies
    // (e.g. `git stash pop`/`git stash drop` in
    // restore_stashed_changes_with_safe_merge()), not just the retry loop's
    // own top-level calls further down. A regex over source text can't tell
    // "function body" from "retry loop", so this asserts the stronger
    // property: the guard precedes every such call site in the script, not
    // merely the ones after its own function definition.
    const indexMutatingOpPattern = /^\s*git (stash|add|commit)\b/m;
    const firstOpMatch = indexMutatingOpPattern.exec(GIT_COMMIT_DATA);
    expect(firstOpMatch, 'no executable git stash/add/commit call found').not.toBeNull();

    expect(lockCheckIndex).toBeGreaterThan(setEIndex);
    expect(lockCheckIndex).toBeLessThan(firstOpMatch!.index);
  });

  it('functionally recovers: a crawler proceeds and commits even with a stale index.lock left by a crashed prior holder', () => {
    // Model the exact production scenario: within one shared working directory
    // (one job, one .git), a prior crawler's git operation crashed mid-way and
    // left `.git/index.lock` orphaned. The flock itself has already been
    // released (the crashing process is gone) by the time the next crawler
    // enters its critical section — only the stale lock FILE remains. Extract
    // just the recovery guard (the same snippet shipped in the real script)
    // and run it against a real temp git repo to prove the next crawler's
    // git commit succeeds instead of failing on "Another git process seems to
    // be running...".
    const repoDir = mkdtempSync(join(tmpdir(), 'git-commit-data-stale-lock-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
      writeFileSync(join(repoDir, 'seed.txt'), 'seed\n');
      execFileSync('git', ['add', 'seed.txt'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });

      // Simulate the crashed crawler: it created data + the index.lock git
      // would create for `git add`/`git commit`, then died before finishing.
      writeFileSync(join(repoDir, 'crashed-crawler-output.txt'), 'partial\n');
      writeFileSync(join(repoDir, '.git', 'index.lock'), '');

      // Sanity check: without recovery, git itself refuses to proceed — this
      // is exactly what every subsequent crawler in group-06 hit last night.
      expect(() => execFileSync('git', ['add', '.'], { cwd: repoDir })).toThrow(/index\.lock/);

      // Extract the actual recovery guard from the shipped script (not a
      // reimplementation) so this test tracks the real fix.
      const guardMatch = GIT_COMMIT_DATA.match(
        /if \[ -f "\.git\/index\.lock" \]; then\n(?:.*\n)*?fi\n/,
      );
      expect(guardMatch, 'could not extract stale-lock guard block from git-commit-data.sh').not.toBeNull();
      const guardScript = guardMatch![0];

      // Run the next crawler's critical section: recovery guard, then a real
      // git add + commit, exactly as git-commit-data.sh does after it.
      execFileSync(
        'bash',
        ['-euo', 'pipefail', '-c', `${guardScript}\ngit add . && git commit -q -m "next crawler commit"`],
        { cwd: repoDir },
      );

      const log = execFileSync('git', ['log', '--oneline'], { cwd: repoDir }).toString();
      expect(log).toContain('next crawler commit');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

const CONFIGURE_AUTH = resolve(ROOT, 'scripts/lib/configure-main-push-auth.sh');
const ACTIONS_TOKEN = 'ghs_dummy_actions_token_must_not_be_used';
const PAT_TOKEN = 'ghp_dummy_pat_bypass_identity';
const APP_TOKEN = 'ghs_dummy_app_installation_token';
const REPO = 'valerielinc-ops/frontaliere-si-o-no';

function initGithubLookingRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'main-push-auth-'));
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  writeFileSync(join(repoDir, 'seed.txt'), 'seed\n');
  execFileSync('git', ['add', 'seed.txt'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
  execFileSync(
    'git',
    ['remote', 'add', 'origin', `https://github.com/${REPO}.git`],
    { cwd: repoDir },
  );
  const encoded = Buffer.from(`x-access-token:${ACTIONS_TOKEN}`).toString('base64');
  execFileSync(
    'git',
    ['config', '--local', 'http.https://github.com/.extraheader', `AUTHORIZATION: basic ${encoded}`],
    { cwd: repoDir },
  );
  return repoDir;
}

function runConfigure(
  cwd: string,
  env: NodeJS.ProcessEnv,
): { status: number; stderr: string; stdout: string } {
  try {
    const stdout = execFileSync('bash', [CONFIGURE_AUTH], {
      cwd,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stderr?: string | Buffer; stdout?: string | Buffer };
    return {
      status: typeof e.status === 'number' ? e.status : 1,
      stdout: String(e.stdout || ''),
      stderr: String(e.stderr || ''),
    };
  }
}

describe('configure-main-push-auth.sh (shipped fail-closed main-push auth)', () => {
  it('exits non-zero on GITHUB_TOKEN/GH_TOKEN alone and does not write them into origin or extraheader', () => {
    const repoDir = initGithubLookingRepo();
    try {
      const beforeUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: repoDir,
        encoding: 'utf8',
      }).trim();
      const beforeHeader = execFileSync(
        'git',
        ['config', '--local', '--get', 'http.https://github.com/.extraheader'],
        { cwd: repoDir, encoding: 'utf8' },
      ).trim();

      const result = runConfigure(repoDir, {
        GITHUB_TOKEN: ACTIONS_TOKEN,
        GH_TOKEN: ACTIONS_TOKEN,
        GITHUB_REPOSITORY: REPO,
        GITHUB_PAT: '',
        APP_TOKEN: '',
      });

      expect(result.status).toBeGreaterThan(0);
      expect(`${result.stderr}${result.stdout}`).toMatch(/GITHUB_PAT|APP_TOKEN|GH013/);

      const afterUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: repoDir,
        encoding: 'utf8',
      }).trim();
      const afterHeader = execFileSync(
        'git',
        ['config', '--local', '--get', 'http.https://github.com/.extraheader'],
        { cwd: repoDir, encoding: 'utf8' },
      ).trim();
      expect(afterUrl).toBe(beforeUrl);
      expect(afterUrl).not.toContain(ACTIONS_TOKEN);
      expect(afterHeader).toBe(beforeHeader);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('with GITHUB_PAT: clears checkout extraheader and rewrites origin to that token', () => {
    const repoDir = initGithubLookingRepo();
    try {
      const result = runConfigure(repoDir, {
        GITHUB_TOKEN: ACTIONS_TOKEN,
        GH_TOKEN: ACTIONS_TOKEN,
        GITHUB_PAT: PAT_TOKEN,
        APP_TOKEN: '',
        GITHUB_REPOSITORY: REPO,
      });
      expect(result.status).toBe(0);

      const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: repoDir,
        encoding: 'utf8',
      }).trim();
      expect(url).toBe(`https://x-access-token:${PAT_TOKEN}@github.com/${REPO}.git`);
      expect(url).not.toContain(ACTIONS_TOKEN);

      expect(() =>
        execFileSync(
          'git',
          ['config', '--local', '--get', 'http.https://github.com/.extraheader'],
          { cwd: repoDir, encoding: 'utf8' },
        ),
      ).toThrow();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('with APP_TOKEN only: same extraheader clear + origin rewrite; PAT wins when both are set', () => {
    const repoDir = initGithubLookingRepo();
    try {
      const appOnly = runConfigure(repoDir, {
        GITHUB_TOKEN: ACTIONS_TOKEN,
        APP_TOKEN,
        GITHUB_PAT: '',
        GITHUB_REPOSITORY: REPO,
      });
      expect(appOnly.status).toBe(0);
      expect(
        execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoDir, encoding: 'utf8' }).trim(),
      ).toBe(`https://x-access-token:${APP_TOKEN}@github.com/${REPO}.git`);

      execFileSync(
        'git',
        ['remote', 'set-url', 'origin', `https://github.com/${REPO}.git`],
        { cwd: repoDir },
      );
      const encoded = Buffer.from(`x-access-token:${ACTIONS_TOKEN}`).toString('base64');
      execFileSync(
        'git',
        ['config', '--local', 'http.https://github.com/.extraheader', `AUTHORIZATION: basic ${encoded}`],
        { cwd: repoDir },
      );

      const both = runConfigure(repoDir, {
        GITHUB_TOKEN: ACTIONS_TOKEN,
        APP_TOKEN,
        GITHUB_PAT: PAT_TOKEN,
        GITHUB_REPOSITORY: REPO,
      });
      expect(both.status).toBe(0);
      expect(
        execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoDir, encoding: 'utf8' }).trim(),
      ).toBe(`https://x-access-token:${PAT_TOKEN}@github.com/${REPO}.git`);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('leaves a non-github origin alone so local helper tests keep their temp remotes', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'main-push-auth-local-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repoDir });
      execFileSync('git', ['remote', 'add', 'origin', repoDir], { cwd: repoDir });
      const result = runConfigure(repoDir, {
        GITHUB_TOKEN: ACTIONS_TOKEN,
        GITHUB_REPOSITORY: REPO,
      });
      expect(result.status).toBe(0);
      expect(
        execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoDir, encoding: 'utf8' }).trim(),
      ).toBe(repoDir);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
