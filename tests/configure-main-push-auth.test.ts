// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
