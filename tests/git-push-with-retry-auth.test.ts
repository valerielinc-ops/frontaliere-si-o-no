// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = resolve(ROOT, 'scripts/lib/git-push-with-retry.sh');
const SCRIPT = readFileSync(SCRIPT_PATH, 'utf-8');
const ACTIONS_TOKEN = 'ghs_dummy_actions_token_must_not_be_used';
const PAT_TOKEN = 'ghp_dummy_pat_bypass_identity';
const REPO = 'valerielinc-ops/frontaliere-si-o-no';

describe('git-push-with-retry.sh main-push auth', () => {
  it('delegates to the fail-closed configure helper and does not fall back to GITHUB_TOKEN', () => {
    expect(SCRIPT).toContain('configure-main-push-auth.sh');
    expect(SCRIPT).not.toMatch(/PUSH_TOKEN="\$\{APP_TOKEN:-\$\{GITHUB_PAT:-\}\}"/);
    expect(SCRIPT).not.toMatch(/GITHUB_TOKEN:-\}/);
  });

  it('exits non-zero when only GITHUB_TOKEN is set against a github.com origin', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'git-push-retry-auth-'));
    try {
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

      let status = 0;
      let combined = '';
      try {
        execFileSync('bash', [SCRIPT_PATH, '--max-attempts', '1'], {
          cwd: repoDir,
          env: {
            ...process.env,
            GITHUB_TOKEN: ACTIONS_TOKEN,
            GH_TOKEN: ACTIONS_TOKEN,
            GITHUB_REPOSITORY: REPO,
            GITHUB_PAT: '',
            APP_TOKEN: '',
          },
          encoding: 'utf8',
        });
      } catch (err) {
        const e = err as { status?: number; stderr?: string | Buffer; stdout?: string | Buffer };
        status = typeof e.status === 'number' ? e.status : 1;
        combined = `${e.stdout || ''}${e.stderr || ''}`;
      }

      expect(status).toBeGreaterThan(0);
      expect(combined).toMatch(/GITHUB_PAT|APP_TOKEN|GH013/);
      const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: repoDir,
        encoding: 'utf8',
      }).trim();
      expect(url).not.toContain(ACTIONS_TOKEN);
      expect(url).toBe(`https://github.com/${REPO}.git`);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('with GITHUB_PAT set, running the shipped retry script clears extraheader and rewrites origin before push', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'git-push-retry-pat-'));
    const wrapDir = mkdtempSync(join(tmpdir(), 'git-push-retry-wrap-'));
    try {
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

      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      const wrapPath = join(wrapDir, 'git');
      writeFileSync(
        wrapPath,
        `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "push" ]; then
  echo "wrapped-push $*"
  exit 0
fi
exec "${realGit}" "$@"
`,
      );
      execFileSync('chmod', ['+x', wrapPath]);

      execFileSync('bash', [SCRIPT_PATH, '--max-attempts', '1'], {
        cwd: repoDir,
        env: {
          ...process.env,
          PATH: `${wrapDir}:${process.env.PATH || ''}`,
          GITHUB_TOKEN: ACTIONS_TOKEN,
          GITHUB_PAT: PAT_TOKEN,
          APP_TOKEN: '',
          GITHUB_REPOSITORY: REPO,
        },
        encoding: 'utf8',
      });

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
      rmSync(wrapDir, { recursive: true, force: true });
    }
  });
});
