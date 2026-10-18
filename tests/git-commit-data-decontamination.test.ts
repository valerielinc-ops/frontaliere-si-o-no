// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { filterNewForeignClaims } from '../scripts/lib/crawler-commit-ownership.mjs';
import { loadSourceHostOwnership } from '../scripts/lib/crawler-source-hosts.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = resolve(ROOT, 'scripts/lib/git-commit-data.sh');
const BASH_BIN = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash'].find(existsSync) ?? 'bash';

function initClonePair() {
  const originDir = mkdtempSync(join(tmpdir(), 'gcd-decontam-origin-'));
  const repoDir = mkdtempSync(join(tmpdir(), 'gcd-decontam-repo-'));
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', originDir]);
  execFileSync('git', ['clone', '-q', originDir, repoDir]);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  return { originDir, repoDir };
}

function runScript(repoDir: string, sliceFile: string) {
  execFileSync(BASH_BIN, [SCRIPT_PATH, '--slice-only', 'test commit'], {
    cwd: repoDir,
    env: {
      ...process.env,
      JOBS_SLICE_FILE: sliceFile,
      SKIP_AI_TRANSLATION: '1',
      SLUG_HISTORY_SUMMARY_FILE: join(repoDir, 'no-such-slug-history-summary.txt'),
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      GITHUB_RUN_ID: '',
      GITHUB_REPOSITORY: '',
      GITHUB_OUTPUT: '',
    },
  });
}

function writeSlice(repoDir: string, key: string, jobs: unknown[]) {
  const file = join(repoDir, 'data/jobs/by-crawler', `${key}.json`);
  writeFileSync(file, `${JSON.stringify({ crawlerKey: key, jobs }, null, 2)}\n`);
}

describe('git-commit-data.sh cross-job decontamination preservation', () => {
  it('filters only a route absent from the claimant and uniquely owned elsewhere', () => {
    const root = mkdtempSync(join(tmpdir(), 'gcd-decontam-index-'));
    try {
      const sliceDir = join(root, 'data/jobs/by-crawler');
      mkdirSync(sliceDir, { recursive: true });
      const transferredRoute = 'legacy-role-owner-hash';
      writeFileSync(join(sliceDir, 'owner.json'), JSON.stringify({
        crawlerKey: 'owner',
        jobs: [{ url: 'https://jobs.example.test/owner', slug: 'owner-route', previousSlugs: [transferredRoute] }],
      }));
      writeFileSync(join(sliceDir, 'claimant.json'), JSON.stringify({
        crawlerKey: 'claimant',
        jobs: [{ url: 'https://jobs.example.test/claimant', slug: 'claimant-route', previousSlugs: [] }],
      }));

      const ownership = loadSourceHostOwnership(root, { urls: true, routes: true });
      const stale = {
        crawlerKey: 'claimant',
        jobs: [{
          url: 'https://jobs.example.test/claimant',
          slug: 'claimant-route',
          previousSlugs: [transferredRoute],
          previousSlugsByLocale: { it: [transferredRoute] },
        }],
      };
      const remote = {
        crawlerKey: 'claimant',
        jobs: [{ url: 'https://jobs.example.test/claimant', slug: 'claimant-route', previousSlugs: [] }],
      };
      const result = filterNewForeignClaims('claimant', stale, stale, ownership, remote);

      expect(result.droppedHistorical).toEqual([{ slug: transferredRoute, owner: 'owner' }]);
      expect(result.payload).toEqual({
        crawlerKey: 'claimant',
        jobs: [{ url: 'https://jobs.example.test/claimant', slug: 'claimant-route' }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a fleet-proven transfer out of a stale claimant merge', () => {
    const { originDir, repoDir } = initClonePair();
    const otherDir = mkdtempSync(join(tmpdir(), 'gcd-decontam-other-'));
    try {
      mkdirSync(join(repoDir, 'data/jobs/by-crawler'), { recursive: true });
      const transferredRoute = 'legacy-role-owner-hash';
      writeSlice(repoDir, 'owner', [{
        url: 'https://jobs.example.test/owner',
        slug: 'owner-current-route',
        previousSlugs: [transferredRoute],
      }]);
      writeSlice(repoDir, 'claimant', [{
        url: 'https://jobs.example.test/claimant',
        slug: 'claimant-current-route',
        previousSlugs: [transferredRoute],
        previousSlugsByLocale: { it: [transferredRoute] },
      }]);
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed duplicate history'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });

      const otherClone = join(otherDir, 'clone');
      execFileSync('git', ['clone', '-q', originDir, otherClone]);
      execFileSync('git', ['config', 'user.email', 'other@example.com'], { cwd: otherClone });
      execFileSync('git', ['config', 'user.name', 'Other'], { cwd: otherClone });
      const remoteClaimant = JSON.parse(readFileSync(
        join(otherClone, 'data/jobs/by-crawler/claimant.json'),
        'utf8',
      ));
      remoteClaimant.jobs[0].previousSlugs = [];
      remoteClaimant.jobs[0].previousSlugsByLocale = {};
      writeFileSync(
        join(otherClone, 'data/jobs/by-crawler/claimant.json'),
        `${JSON.stringify(remoteClaimant, null, 2)}\n`,
      );
      execFileSync('git', ['add', '.'], { cwd: otherClone });
      execFileSync('git', ['commit', '-q', '-m', 'decontaminate claimant history'], { cwd: otherClone });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: otherClone });

      // This writer started from the duplicate-history base and changed an
      // unrelated field. It must not re-add the route the remote fleet has
      // already moved to the unique owner.
      const staleClaimant = JSON.parse(readFileSync(
        join(repoDir, 'data/jobs/by-crawler/claimant.json'),
        'utf8',
      ));
      staleClaimant.jobs[0].titleByLocale = { en: 'Stale writer translation' };
      writeFileSync(
        join(repoDir, 'data/jobs/by-crawler/claimant.json'),
        `${JSON.stringify(staleClaimant, null, 2)}\n`,
      );

      runScript(repoDir, 'data/jobs/by-crawler/claimant.json');

      execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: repoDir });
      const ownerGitPath = relative(repoDir, join(repoDir, 'data/jobs/by-crawler/owner.json'));
      const claimantGitPath = relative(repoDir, join(repoDir, 'data/jobs/by-crawler/claimant.json'));
      const publishedOwner = JSON.parse(execFileSync(
        'git', ['show', `origin/main:${ownerGitPath}`],
        { cwd: repoDir, encoding: 'utf8' },
      ));
      const publishedClaimant = JSON.parse(execFileSync(
        'git', ['show', `origin/main:${claimantGitPath}`],
        { cwd: repoDir, encoding: 'utf8' },
      ));

      expect(publishedOwner.jobs[0].previousSlugs).toContain(transferredRoute);
      expect(publishedClaimant.jobs[0].previousSlugs).not.toContain(transferredRoute);
      expect(publishedClaimant.jobs[0].previousSlugsByLocale).not.toHaveProperty('it');
      expect(publishedClaimant.jobs[0].titleByLocale).toEqual({ en: 'Stale writer translation' });
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
