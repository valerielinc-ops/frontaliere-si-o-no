import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runRemoteSiblingPrePush } from '../.github/actions/claude-codex-fallback/git-bridge-server.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const read = (relative: string) => readFileSync(resolve(ROOT, relative), 'utf8');
const readCommitted = (relative: string) => execFileSync(
  'git',
  ['show', `HEAD:${relative}`],
  { cwd: ROOT, encoding: 'utf8' },
);

describe('remote PR agents use the same committed hook contract as local agents', () => {
  // `.claude/` can be omitted by a sparse/hidden-file checkout, while the
  // contract itself is versioned and must still be checked in CI.
  const settings = readCommitted('.claude/settings.json');
  const prePush = read('.githooks/pre-push');
  const packageJson = read('package.json');
  const issueFix = read('.github/workflows/issue-fix.yml');
  const remoteGhWrapper = read('scripts/gh-pr-body-check.mjs');
  const gitBridge = read('.github/actions/claude-codex-fallback/git-bridge-server.mjs');

  it('keeps both PR gates in the project settings loaded by Claude Code', () => {
    expect(settings).toContain('scripts/ci/sibling-check-gate.mjs');
    expect(settings).toContain('scripts/ci/pr-body-check-gate.mjs');
  });

  it('activates the same pre-push hook in a fresh remote checkout', () => {
    expect(packageJson).toContain('"prepare": "git config core.hooksPath .githooks || true"');
    expect(prePush).toContain('push_input=$(cat)');
    expect(prePush).toContain('node scripts/ci/check-sibling-patterns.mjs --head "$local_sha"');
    expect(prePush).not.toMatch(/^\s*git\s+push[^\n]*--no-verify/m);
  });

  it('runs npm ci before the remote agent that opens a PR', () => {
    const install = issueFix.indexOf('run: npm ci');
    const agent = issueFix.indexOf('uses: ./.github/actions/claude-codex-fallback');
    expect(install).toBeGreaterThanOrEqual(0);
    expect(agent).toBeGreaterThan(install);
    expect(issueFix).toContain('gh pr create');
    expect(issueFix).toContain('scripts/gh-pr-body-check.mjs');
    expect(issueFix).toContain('$GITHUB_PATH');
    expect(issueFix).toContain('## Implementato');
    expect(issueFix).toContain('## Non implementato (ancora)');
    expect(issueFix).not.toContain('git push --no-verify');
  });

  it('makes the remote gh wrapper invoke the exact local sibling gate for PR creation', () => {
    expect(remoteGhWrapper).toContain("scripts', 'ci', 'sibling-check-gate.mjs");
    expect(remoteGhWrapper).toContain("'--head',\n    'HEAD'");
    expect(remoteGhWrapper).toContain('mutation.subcommand === \'create\'');
  });

  it('keeps the bridge security boundary but runs the same committed-head sibling check before remote push', () => {
    expect(gitBridge).toContain("path.join(cwd, 'scripts', 'ci', 'check-sibling-patterns.mjs')");
    expect(gitBridge).toContain("[checker, '--head', headSha]");
    expect(gitBridge).toContain('runRemoteSiblingPrePush');
    expect(gitBridge).toContain("['core.hooksPath', '/dev/null']");
  });

  it('passes the exact local HEAD SHA to the remote pre-push equivalent', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'remote-hook-parity-'));
    try {
      mkdirSync(resolve(root, '.githooks'), { recursive: true });
      mkdirSync(resolve(root, 'scripts', 'ci'), { recursive: true });
      writeFileSync(resolve(root, '.githooks', 'pre-push'), '# fixture opt-in\n');
      writeFileSync(
        resolve(root, 'scripts', 'ci', 'check-sibling-patterns.mjs'),
        "console.log(process.argv.slice(2).join(' ') + ' token=' + (process.env.GIT_CONFIG_VALUE_0 || ''));\n",
      );
      writeFileSync(resolve(root, 'tracked.txt'), 'fixture\n');
      execFileSync('git', ['init', '-q', root]);
      execFileSync('git', ['-C', root, 'add', 'tracked.txt']);
      execFileSync('git', [
        '-C', root,
        '-c', 'user.name=Fixture',
        '-c', 'user.email=fixture@example.invalid',
        'commit', '-q', '-m', 'fixture',
      ]);
      execFileSync('git', ['-C', root, 'checkout', '-qb', 'fixture-branch']);
      const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const result = runRemoteSiblingPrePush({
        realGit: 'git',
        cwd: root,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.extraheader',
          GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic fixture-secret',
        },
        workBranchRef: 'refs/heads/fixture-branch',
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`--head ${head}`);
      expect(result.stdout).not.toContain('fixture-secret');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
