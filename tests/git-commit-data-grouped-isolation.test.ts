// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = resolve(ROOT, 'scripts/lib/git-commit-data.sh');
const GENERATION_TOKEN = '9001-2';

// The script uses `declare -A` (associative arrays), requiring bash 4+.
const BASH_BIN = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash'].find(existsSync) ?? 'bash';

function initClonePair() {
  const originDir = mkdtempSync(join(tmpdir(), 'gcd-grouped-origin-'));
  const repoDir = mkdtempSync(join(tmpdir(), 'gcd-grouped-repo-'));
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', originDir]);
  execFileSync('git', ['clone', '-q', originDir, repoDir]);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  return { originDir, repoDir };
}

function runScript(repoDir: string, sliceFile: string, githubOutput = '') {
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
      GITHUB_OUTPUT: githubOutput,
    },
  });
}

function groupEnv(
  repoDir: string,
  runnerTemp: string,
  crawlerId = '',
  generationToken = GENERATION_TOKEN,
) {
  return {
    ...process.env,
    CRAWLER_GROUP_COMMIT_DIR: 'crawler-generation/commit-batch',
    CRAWLER_GENERATION_RECEIPT_DIR: 'crawler-generation/receipts',
    CRAWLER_GENERATION_TOKEN: generationToken,
    RUNNER_TEMP: runnerTemp,
    ...(crawlerId ? { JOBS_HOUSEKEEPING_SCOPE: crawlerId } : {}),
    SKIP_AI_TRANSLATION: '1',
    SLUG_HISTORY_SUMMARY_FILE: join(repoDir, 'no-such-slug-history-summary.txt'),
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    GITHUB_RUN_ID: '',
    GITHUB_REPOSITORY: '',
    GITHUB_OUTPUT: '',
  };
}

function deferGroupCommit(
  repoDir: string,
  runnerTemp: string,
  crawlerId: string,
  extraPaths: string[] = [],
  generationToken = GENERATION_TOKEN,
) {
  return spawnSync(BASH_BIN, [SCRIPT_PATH, '--slice-only', `update ${crawlerId}`, ...extraPaths], {
    cwd: repoDir,
    encoding: 'utf8',
    env: {
      ...groupEnv(repoDir, runnerTemp, crawlerId, generationToken),
      CRAWLER_GROUP_DEFER_COMMIT: '1',
      JOBS_SLICE_FILE: `data/jobs/by-crawler/${crawlerId}.json`,
    },
  });
}

function commitGroup(repoDir: string, runnerTemp: string) {
  return spawnSync(BASH_BIN, [SCRIPT_PATH, '--group-batch', 'batch update'], {
    cwd: repoDir,
    encoding: 'utf8',
    env: groupEnv(repoDir, runnerTemp),
  });
}

// Regression coverage for the post-#3701 shared-workspace commit-loss class:
// crawler-group workflows run ~25 sibling crawlers as concurrent background
// steps against ONE checkout. The legacy commit path (stash --include-untracked
// → rebase → pop → drop) swept every sibling's not-yet-committed dirty file
// into the stash whenever origin/main had moved; on a pop conflict it restored
// only the invoking crawler's own files and DROPPED the rest — silently
// reverting sibling slices to HEAD (confirmed live: commit d2a7e49e
// "Auto-update EMS-Chemie" contained only a sibling's adapter while EMS's own
// freshly-crawled slice had been wiped; its summary stayed frozen at the
// 2026-07-06 earlyExit). The grouped-isolated path must never mutate the
// shared worktree/index at all: it builds the commit via a private temp index
// on top of the freshly fetched origin/main and pushes the sha directly.
describe('git-commit-data.sh grouped-isolated commit path (shared workspace)', () => {
  it.each([
    ['missing', '', /Missing CRAWLER_GENERATION_TOKEN/],
    ['malformed', 'not-a-generation-token', /Invalid crawler commit descriptor generation token/],
  ])('fails closed on a %s generation token before persisting a descriptor', (_label, token, error) => {
    const { originDir, repoDir } = initClonePair();
    const runnerTemp = mkdtempSync(join(tmpdir(), 'gcd-grouped-token-'));
    try {
      mkdirSync(join(repoDir, 'data/jobs/by-crawler'), { recursive: true });
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), '[{"id":"old"}]\n');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
      const remoteHead = execFileSync(
        'git',
        ['ls-remote', 'origin', 'refs/heads/main'],
        { cwd: repoDir, encoding: 'utf8' },
      ).trim();

      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), '[{"id":"new"}]\n');
      const deferred = deferGroupCommit(repoDir, runnerTemp, 'a', [], token);
      expect(deferred.status).toBe(1);
      expect(`${deferred.stdout}${deferred.stderr}`).toMatch(error);
      expect(existsSync(join(
        runnerTemp,
        'crawler-generation',
        'commit-batch',
        'a.json',
      ))).toBe(false);
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim())
        .toBe(head);
      expect(execFileSync(
        'git',
        ['ls-remote', 'origin', 'refs/heads/main'],
        { cwd: repoDir, encoding: 'utf8' },
      ).trim()).toBe(remoteHead);
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  it('commits the deferred active+expired snapshots after a sibling rewrites the live paths', () => {
    const { originDir, repoDir } = initClonePair();
    const runnerTemp = mkdtempSync(join(tmpdir(), 'gcd-grouped-runner-'));
    try {
      mkdirSync(join(repoDir, 'data/jobs/by-crawler'), { recursive: true });
      mkdirSync(join(repoDir, 'data/jobs/expired/by-crawler'), { recursive: true });
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/ipersonal.json'), '[{"id":"old-active"}]\n');
      writeFileSync(join(repoDir, 'data/jobs/expired/by-crawler/ipersonal.json'), '[{"id":"old-expired"}]\n');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });

      const deferredActive = '[{"id":"schinznach","previousSlugs":["route-a"]},{"id":"st-moritz","previousSlugsByLocale":{"de":["route-b"]}}]\n';
      const deferredExpired = `${JSON.stringify(Array.from({ length: 110 }, (_, index) => ({ id: `expired-${index}` })))}\n`;
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/ipersonal.json'), deferredActive);
      writeFileSync(join(repoDir, 'data/jobs/expired/by-crawler/ipersonal.json'), deferredExpired);

      const deferred = deferGroupCommit(repoDir, runnerTemp, 'ipersonal');
      expect(deferred.status, `${deferred.stdout}${deferred.stderr}`).toBe(0);
      const descriptor = JSON.parse(readFileSync(
        join(runnerTemp, 'crawler-generation', 'commit-batch', 'ipersonal.json'),
        'utf8',
      ));
      expect(descriptor).toMatchObject({
        schemaVersion: 3,
        generationToken: GENERATION_TOKEN,
        crawlerId: 'ipersonal',
      });
      expect(descriptor.files).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: 'data/jobs/by-crawler/ipersonal.json',
          operation: 'modify',
          state: 'present',
          blobOid: expect.stringMatching(/^[a-f0-9]{40,64}$/),
          sha256: expect.stringMatching(/^sha256:/),
        }),
        expect.objectContaining({
          path: 'data/jobs/expired/by-crawler/ipersonal.json',
          operation: 'modify',
          state: 'present',
          sha256: expect.stringMatching(/^sha256:/),
        }),
      ]));

      // Reproduce the production ordering: after iPersonal deferred its 110
      // expired records, a sibling/global assembler rewrites both live paths
      // with a degraded view before the atomic batch starts.
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/ipersonal.json'), '[{"id":"degraded-active"}]\n');
      writeFileSync(
        join(repoDir, 'data/jobs/expired/by-crawler/ipersonal.json'),
        `${JSON.stringify(Array.from({ length: 98 }, (_, index) => ({ id: `degraded-${index}` })))}\n`,
      );

      const firstBatch = commitGroup(repoDir, runnerTemp);
      expect(firstBatch.status, `${firstBatch.stdout}${firstBatch.stderr}`).toBe(0);
      execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: repoDir });
      const pushed = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: repoDir, encoding: 'utf8' }).trim();
      expect(execFileSync('git', ['show', `${pushed}:data/jobs/by-crawler/ipersonal.json`], {
        cwd: repoDir,
        encoding: 'utf8',
      })).toBe(deferredActive);
      expect(execFileSync('git', ['show', `${pushed}:data/jobs/expired/by-crawler/ipersonal.json`], {
        cwd: repoDir,
        encoding: 'utf8',
      })).toBe(deferredExpired);
      expect(readFileSync(join(repoDir, 'data/jobs/by-crawler/ipersonal.json'), 'utf8')).toContain('degraded-active');

      const secondBatch = commitGroup(repoDir, runnerTemp);
      expect(secondBatch.status, `${secondBatch.stdout}${secondBatch.stderr}`).toBe(0);
      expect(execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], {
        cwd: repoDir,
        encoding: 'utf8',
      }).split(/\s+/)[0]).toBe(pushed);
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  it('fails closed before any commit when a descriptor is tampered or missing', () => {
    for (const failure of ['tampered', 'missing'] as const) {
      const { originDir, repoDir } = initClonePair();
      const runnerTemp = mkdtempSync(join(tmpdir(), 'gcd-grouped-runner-'));
      try {
        mkdirSync(join(repoDir, 'data/jobs/by-crawler'), { recursive: true });
        for (const crawlerId of ['a', 'b']) {
          writeFileSync(join(repoDir, `data/jobs/by-crawler/${crawlerId}.json`), '[]\n');
        }
        execFileSync('git', ['add', '.'], { cwd: repoDir });
        execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
        execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });
        const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
        writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), '[{"id":"a1"}]\n');
        writeFileSync(join(repoDir, 'data/jobs/by-crawler/b.json'), '[{"id":"b1"}]\n');
        expect(deferGroupCommit(repoDir, runnerTemp, 'a').status).toBe(0);
        expect(deferGroupCommit(repoDir, runnerTemp, 'b').status).toBe(0);

        const descriptorPath = join(runnerTemp, 'crawler-generation', 'commit-batch', 'b.json');
        if (failure === 'tampered') {
          const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
          descriptor.commitMessage = 'tampered attribution';
          writeFileSync(descriptorPath, JSON.stringify(descriptor));
        } else {
          rmSync(descriptorPath);
        }

        const batch = commitGroup(repoDir, runnerTemp);
        expect(batch.status, `${failure}: ${batch.stdout}${batch.stderr}`).toBe(1);
        expect(execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], {
          cwd: repoDir,
          encoding: 'utf8',
        }).split(/\s+/)[0]).toBe(base);
      } finally {
        rmSync(originDir, { recursive: true, force: true });
        rmSync(repoDir, { recursive: true, force: true });
        rmSync(runnerTemp, { recursive: true, force: true });
      }
    }
  });

  it('fails closed when a descriptor snapshot blob is missing', () => {
    const { originDir, repoDir } = initClonePair();
    const runnerTemp = mkdtempSync(join(tmpdir(), 'gcd-grouped-runner-'));
    try {
      mkdirSync(join(repoDir, 'data/jobs/by-crawler'), { recursive: true });
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), '[]\n');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });
      const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), '[{"id":"snapshot-only-content"}]\n');
      expect(deferGroupCommit(repoDir, runnerTemp, 'a').status).toBe(0);
      const descriptor = JSON.parse(readFileSync(
        join(runnerTemp, 'crawler-generation', 'commit-batch', 'a.json'),
        'utf8',
      ));
      const snapshot = descriptor.files.find(({ path: filePath }: { path: string }) => (
        filePath === 'data/jobs/by-crawler/a.json'
      ));
      rmSync(join(repoDir, '.git', 'objects', snapshot.blobOid.slice(0, 2), snapshot.blobOid.slice(2)));

      const batch = commitGroup(repoDir, runnerTemp);
      expect(batch.status, `${batch.stdout}${batch.stderr}`).toBe(1);
      expect(execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], {
        cwd: repoDir,
        encoding: 'utf8',
      }).split(/\s+/)[0]).toBe(base);
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  it('rejects same-path sibling descriptors deterministically', () => {
    const { originDir, repoDir } = initClonePair();
    const runnerTemp = mkdtempSync(join(tmpdir(), 'gcd-grouped-runner-'));
    try {
      mkdirSync(join(repoDir, 'data/jobs/by-crawler'), { recursive: true });
      mkdirSync(join(repoDir, 'data/shared'), { recursive: true });
      for (const crawlerId of ['a', 'b']) {
        writeFileSync(join(repoDir, `data/jobs/by-crawler/${crawlerId}.json`), '[]\n');
      }
      writeFileSync(join(repoDir, 'data/shared/ownership.json'), '{}\n');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });
      const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
      writeFileSync(join(repoDir, 'data/shared/ownership.json'), '{"writer":"both"}\n');
      expect(deferGroupCommit(repoDir, runnerTemp, 'a', ['data/shared/ownership.json']).status).toBe(0);
      expect(deferGroupCommit(repoDir, runnerTemp, 'b', ['data/shared/ownership.json']).status).toBe(0);

      const batch = commitGroup(repoDir, runnerTemp);
      expect(batch.status).toBe(1);
      expect(`${batch.stdout}${batch.stderr}`).toContain(
        'Crawler commit descriptor path conflict: data/shared/ownership.json (a,b)',
      );
      expect(execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], {
        cwd: repoDir,
        encoding: 'utf8',
      }).split(/\s+/)[0]).toBe(base);
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  it('commits a deferred deletion even when the live path is recreated before the batch', () => {
    const { originDir, repoDir } = initClonePair();
    const runnerTemp = mkdtempSync(join(tmpdir(), 'gcd-grouped-runner-'));
    try {
      mkdirSync(join(repoDir, 'data/jobs/by-crawler'), { recursive: true });
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), '[{"id":"retire-me"}]\n');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });
      rmSync(join(repoDir, 'data/jobs/by-crawler/a.json'));
      expect(deferGroupCommit(repoDir, runnerTemp, 'a').status).toBe(0);

      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), '[{"id":"recreated-too-late"}]\n');
      const firstBatch = commitGroup(repoDir, runnerTemp);
      expect(firstBatch.status, `${firstBatch.stdout}${firstBatch.stderr}`).toBe(0);
      execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: repoDir });
      expect(spawnSync('git', ['cat-file', '-e', 'origin/main:data/jobs/by-crawler/a.json'], {
        cwd: repoDir,
      }).status).not.toBe(0);

      const pushed = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: repoDir, encoding: 'utf8' }).trim();
      const secondBatch = commitGroup(repoDir, runnerTemp);
      expect(secondBatch.status, `${secondBatch.stdout}${secondBatch.stderr}`).toBe(0);
      expect(execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], {
        cwd: repoDir,
        encoding: 'utf8',
      }).split(/\s+/)[0]).toBe(pushed);
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  it.each<[string, string, string[]]>([
    ['active slice', 'data/jobs/by-crawler/a.json', []],
    ['crawler summary', 'data/jobs-crawler-summaries/by-crawler/a.json', []],
    ['translation cache', 'data/translation-cache/a.json', []],
    ['explicit adapter', 'data/jobs-crawler-adapters/adapters/a.json', ['data/jobs-crawler-adapters/adapters/a.json']],
  ])('aborts instead of resurrecting a remotely deleted %s after defer', (_kind, targetPath, extraPaths) => {
    const { originDir, repoDir } = initClonePair();
    const runnerTemp = mkdtempSync(join(tmpdir(), 'gcd-grouped-runner-'));
    try {
      mkdirSync(dirname(join(repoDir, targetPath)), { recursive: true });
      writeFileSync(join(repoDir, targetPath), '{"state":"old"}\n');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });

      writeFileSync(join(repoDir, targetPath), '{"state":"deferred"}\n');
      expect(deferGroupCommit(repoDir, runnerTemp, 'a', extraPaths).status).toBe(0);

      const remoteDir = mkdtempSync(join(tmpdir(), 'gcd-grouped-remote-'));
      try {
        execFileSync('git', ['clone', '-q', originDir, remoteDir]);
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: remoteDir });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: remoteDir });
        rmSync(join(remoteDir, targetPath));
        execFileSync('git', ['add', '.'], { cwd: remoteDir });
        execFileSync('git', ['commit', '-q', '-m', 'retire slice'], { cwd: remoteDir });
        execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: remoteDir });

        const remoteDeletion = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: remoteDir,
          encoding: 'utf8',
        }).trim();
        const batch = commitGroup(repoDir, runnerTemp);
        expect(batch.status, `${batch.stdout}${batch.stderr}`).toBe(1);
        expect(`${batch.stdout}${batch.stderr}`).toContain(
          `snapshot conflicts with a newer remote deletion for ${targetPath}`,
        );
        expect(execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], {
          cwd: repoDir,
          encoding: 'utf8',
        }).split(/\s+/)[0]).toBe(remoteDeletion);
      } finally {
        rmSync(remoteDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  // #7060 follow-up on #7054: the fail-closed abort's blast radius and
  // reachability on non-job paths (summary/translation-cache/adapter) were
  // unmeasured in production. Both open questions need queryable signal in
  // the batch's own Actions log, not just a passing unit test — this locks
  // in that the abort message tags its path class and that a per-run
  // summary line reports non-"unchanged" operations by class.
  it.each<[string, string, string[]]>([
    ['crawler summary', 'data/jobs-crawler-summaries/by-crawler/a.json', []],
    ['translation cache', 'data/translation-cache/a.json', []],
    ['explicit adapter', 'data/jobs-crawler-adapters/adapters/a.json', ['data/jobs-crawler-adapters/adapters/a.json']],
  ])('tags the fail-closed abort for a remotely deleted %s with its path class', (_kind, targetPath, extraPaths) => {
    const { originDir, repoDir } = initClonePair();
    const runnerTemp = mkdtempSync(join(tmpdir(), 'gcd-grouped-runner-'));
    try {
      mkdirSync(dirname(join(repoDir, targetPath)), { recursive: true });
      writeFileSync(join(repoDir, targetPath), '{"state":"old"}\n');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });

      writeFileSync(join(repoDir, targetPath), '{"state":"deferred"}\n');
      expect(deferGroupCommit(repoDir, runnerTemp, 'a', extraPaths).status).toBe(0);

      const remoteDir = mkdtempSync(join(tmpdir(), 'gcd-grouped-remote-'));
      try {
        execFileSync('git', ['clone', '-q', originDir, remoteDir]);
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: remoteDir });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: remoteDir });
        rmSync(join(remoteDir, targetPath));
        execFileSync('git', ['add', '.'], { cwd: remoteDir });
        execFileSync('git', ['commit', '-q', '-m', 'retire slice'], { cwd: remoteDir });
        execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: remoteDir });

        const batch = commitGroup(repoDir, runnerTemp);
        expect(batch.status, `${batch.stdout}${batch.stderr}`).toBe(1);
        const kindToClass: Record<string, string> = {
          'crawler summary': 'summary',
          'translation cache': 'translation-cache',
          'explicit adapter': 'adapter',
        };
        expect(`${batch.stdout}${batch.stderr}`).toContain(
          `snapshot conflicts with a newer remote deletion for ${targetPath} (class=${kindToClass[_kind]})`,
        );
      } finally {
        rmSync(remoteDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  it('logs a per-class snapshot operation summary for a mixed non-job batch', () => {
    const { originDir, repoDir } = initClonePair();
    const runnerTemp = mkdtempSync(join(tmpdir(), 'gcd-grouped-runner-'));
    const summaryPath = 'data/jobs-crawler-summaries/by-crawler/a.json';
    const cachePath = 'data/translation-cache/a.json';
    try {
      mkdirSync(dirname(join(repoDir, summaryPath)), { recursive: true });
      mkdirSync(dirname(join(repoDir, cachePath)), { recursive: true });
      execFileSync('git', ['add', '-A'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed', '--allow-empty'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });

      writeFileSync(join(repoDir, summaryPath), '{"state":"created"}\n');
      writeFileSync(join(repoDir, cachePath), '{"state":"created"}\n');
      expect(deferGroupCommit(repoDir, runnerTemp, 'a', [summaryPath, cachePath]).status).toBe(0);

      const batch = commitGroup(repoDir, runnerTemp);
      expect(batch.status, `${batch.stdout}${batch.stderr}`).toBe(0);
      expect(`${batch.stdout}${batch.stderr}`).toMatch(
        /snapshot operations by class \(excludes unchanged\):.*summary:create=1/,
      );
      expect(`${batch.stdout}${batch.stderr}`).toMatch(
        /snapshot operations by class \(excludes unchanged\):.*translation-cache:create=1/,
      );
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  it('keeps create, unchanged and explicit delete semantics distinct for non-job descriptor paths', () => {
    const { originDir, repoDir } = initClonePair();
    const runnerTemp = mkdtempSync(join(tmpdir(), 'gcd-grouped-runner-'));
    const root = 'data/jobs-crawler-adapters/adapters';
    const createPath = `${root}/create.json`;
    const unchangedPath = `${root}/unchanged.json`;
    const deletePath = `${root}/delete.json`;
    try {
      mkdirSync(join(repoDir, root), { recursive: true });
      writeFileSync(join(repoDir, unchangedPath), '{"state":"same"}\n');
      writeFileSync(join(repoDir, deletePath), '{"state":"delete-me"}\n');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });

      writeFileSync(join(repoDir, createPath), '{"state":"created"}\n');
      rmSync(join(repoDir, deletePath));
      expect(deferGroupCommit(repoDir, runnerTemp, 'a', [createPath, unchangedPath, deletePath]).status).toBe(0);

      const remoteDir = mkdtempSync(join(tmpdir(), 'gcd-grouped-remote-'));
      try {
        execFileSync('git', ['clone', '-q', originDir, remoteDir]);
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: remoteDir });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: remoteDir });
        rmSync(join(remoteDir, unchangedPath));
        execFileSync('git', ['add', '.'], { cwd: remoteDir });
        execFileSync('git', ['commit', '-q', '-m', 'delete unchanged path remotely'], { cwd: remoteDir });
        execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: remoteDir });
      } finally {
        rmSync(remoteDir, { recursive: true, force: true });
      }

      writeFileSync(join(repoDir, deletePath), '{"state":"recreated-too-late"}\n');
      const firstBatch = commitGroup(repoDir, runnerTemp);
      expect(firstBatch.status, `${firstBatch.stdout}${firstBatch.stderr}`).toBe(0);
      execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: repoDir });
      expect(execFileSync('git', ['show', `origin/main:${createPath}`], {
        cwd: repoDir,
        encoding: 'utf8',
      })).toBe('{"state":"created"}\n');
      for (const absentPath of [unchangedPath, deletePath]) {
        expect(spawnSync('git', ['cat-file', '-e', `origin/main:${absentPath}`], { cwd: repoDir }).status).not.toBe(0);
      }

      const pushed = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: repoDir, encoding: 'utf8' }).trim();
      const secondBatch = commitGroup(repoDir, runnerTemp);
      expect(secondBatch.status, `${secondBatch.stdout}${secondBatch.stderr}`).toBe(0);
      expect(execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], {
        cwd: repoDir,
        encoding: 'utf8',
      }).split(/\s+/)[0]).toBe(pushed);
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  it('rejects repository-escaping descriptor paths at defer time', () => {
    const { originDir, repoDir } = initClonePair();
    const runnerTemp = mkdtempSync(join(tmpdir(), 'gcd-grouped-runner-'));
    try {
      mkdirSync(join(repoDir, 'data/jobs/by-crawler'), { recursive: true });
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), '[]\n');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });

      const deferred = deferGroupCommit(repoDir, runnerTemp, 'a', ['../escape.json']);
      expect(deferred.status).toBe(1);
      expect(`${deferred.stdout}${deferred.stderr}`).toContain('Invalid crawler commit descriptor path');
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  it('persists successful crawler descriptors in one ancestor commit and is idempotent', () => {
    const { originDir, repoDir } = initClonePair();
    const runnerTemp = mkdtempSync(join(tmpdir(), 'gcd-grouped-runner-'));
    try {
      mkdirSync(join(repoDir, 'data/jobs/by-crawler'), { recursive: true });
      mkdirSync(join(repoDir, 'data/jobs-crawler-adapters/adapters'), { recursive: true });
      for (const crawlerId of ['a', 'b', 'failed']) {
        writeFileSync(join(repoDir, `data/jobs/by-crawler/${crawlerId}.json`), '[]\n');
      }
      for (const crawlerId of ['b', 'failed']) {
        writeFileSync(join(repoDir, `data/jobs-crawler-adapters/adapters/${crawlerId}.json`), '{}\n');
      }
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });
      const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), '[{"id":"a1"}]\n');
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/b.json'), '[{"id":"b1"}]\n');
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/failed.json'), '[{"id":"partial"}]\n');
      writeFileSync(join(repoDir, 'data/jobs-crawler-adapters/adapters/b.json'), '{"status":"complete"}\n');
      writeFileSync(join(repoDir, 'data/jobs-crawler-adapters/adapters/failed.json'), '{"status":"partial"}\n');

      expect(deferGroupCommit(repoDir, runnerTemp, 'a', ['data/jobs-crawler-adapters/']).status).toBe(0);
      expect(deferGroupCommit(repoDir, runnerTemp, 'b', ['data/jobs-crawler-adapters/adapters/b.json']).status).toBe(0);
      expect(execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], { cwd: repoDir, encoding: 'utf8' }).split(/\s+/)[0]).toBe(base);

      const firstBatch = commitGroup(repoDir, runnerTemp);
      expect(firstBatch.status, `${firstBatch.stdout}${firstBatch.stderr}`).toBe(0);
      execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: repoDir });
      const pushed = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: repoDir, encoding: 'utf8' }).trim();
      expect(execFileSync('git', ['rev-list', '--count', `${base}..${pushed}`], { cwd: repoDir, encoding: 'utf8' }).trim()).toBe('1');
      expect(execFileSync('git', ['show', `${pushed}:data/jobs/by-crawler/a.json`], { cwd: repoDir, encoding: 'utf8' })).toContain('a1');
      expect(execFileSync('git', ['show', `${pushed}:data/jobs/by-crawler/b.json`], { cwd: repoDir, encoding: 'utf8' })).toContain('b1');
      expect(execFileSync('git', ['show', `${pushed}:data/jobs/by-crawler/failed.json`], { cwd: repoDir, encoding: 'utf8' })).toBe('[]\n');
      expect(execFileSync('git', ['show', `${pushed}:data/jobs-crawler-adapters/adapters/b.json`], { cwd: repoDir, encoding: 'utf8' })).toContain('complete');
      expect(execFileSync('git', ['show', `${pushed}:data/jobs-crawler-adapters/adapters/failed.json`], { cwd: repoDir, encoding: 'utf8' })).toBe('{}\n');

      const receiptRoot = join(runnerTemp, 'crawler-generation', 'receipts');
      const receipts = ['a', 'b'].map((crawlerId) => JSON.parse(readFileSync(join(receiptRoot, `${crawlerId}.json`), 'utf8')));
      expect(receipts.map(({ outcome }) => outcome)).toEqual(['pushed', 'pushed']);
      expect(new Set(receipts.map(({ commit }) => commit))).toEqual(new Set([pushed]));
      expect(new Set(receipts.map(({ remoteBaseCommit }) => remoteBaseCommit))).toEqual(new Set([base]));
      expect(existsSync(join(receiptRoot, 'failed.json'))).toBe(false);

      const secondBatch = commitGroup(repoDir, runnerTemp);
      expect(secondBatch.status, `${secondBatch.stdout}${secondBatch.stderr}`).toBe(0);
      expect(execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], { cwd: repoDir, encoding: 'utf8' }).split(/\s+/)[0]).toBe(pushed);
      for (const crawlerId of ['a', 'b']) {
        const receipt = JSON.parse(readFileSync(join(receiptRoot, `${crawlerId}.json`), 'utf8'));
        expect(receipt).toMatchObject({ crawlerId, outcome: 'noop', commit: pushed, remoteBaseCommit: pushed });
      }
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  it('survives a remote divergence without touching the sibling\'s dirty worktree files (no stash, no rebase)', () => {
    const { originDir, repoDir } = initClonePair();
    // Second clone simulates ANOTHER group's runner pushing to origin
    // after this workspace was checked out.
    const otherDir = mkdtempSync(join(tmpdir(), 'gcd-grouped-other-'));

    try {
      mkdirSync(join(repoDir, 'data/jobs/by-crawler'), { recursive: true });
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), '[]\n');
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/b.json'), '[]\n');
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/c.json'), '[]\n');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });

      // Remote moves AFTER our checkout: crawler "c" (another group) pushes.
      execFileSync('git', ['clone', '-q', originDir, join(otherDir, 'clone')]);
      const otherClone = join(otherDir, 'clone');
      execFileSync('git', ['config', 'user.email', 'other@example.com'], { cwd: otherClone });
      execFileSync('git', ['config', 'user.name', 'Other'], { cwd: otherClone });
      writeFileSync(join(otherClone, 'data/jobs/by-crawler/c.json'), '[{"id":"c1"}]\n');
      execFileSync('git', ['add', '.'], { cwd: otherClone });
      execFileSync('git', ['commit', '-q', '-m', 'other group: crawler c'], { cwd: otherClone });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: otherClone });

      // Meanwhile, in THIS shared workspace: crawler "a" finished (invokes the
      // script), sibling crawler "b" is still mid-run with a dirty slice.
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), '[{"id":"a1"}]\n');
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/b.json'), '[{"id":"b1"}]\n');

      runScript(repoDir, 'data/jobs/by-crawler/a.json');

      // The sibling's dirty file must be EXACTLY as the sibling left it —
      // not stashed, not reverted, not merged away.
      expect(readFileSync(join(repoDir, 'data/jobs/by-crawler/b.json'), 'utf-8')).toBe('[{"id":"b1"}]\n');
      const stashList = execFileSync('git', ['stash', 'list'], { cwd: repoDir, encoding: 'utf-8' });
      expect(stashList.trim()).toBe('');

      // origin/main has BOTH crawler c's earlier push AND crawler a's data,
      // but crawler a's commit contains ONLY its own file.
      execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: repoDir });
      const committedFiles = execFileSync(
        'git',
        ['show', '--stat', '--format=', 'origin/main'],
        { cwd: repoDir, encoding: 'utf-8' },
      );
      expect(committedFiles).toContain('a.json');
      expect(committedFiles).not.toContain('b.json');
      expect(committedFiles).not.toContain('c.json');
      const aRemote = execFileSync('git', ['show', 'origin/main:data/jobs/by-crawler/a.json'], { cwd: repoDir, encoding: 'utf-8' });
      expect(aRemote).toContain('a1');
      const cRemote = execFileSync('git', ['show', 'origin/main:data/jobs/by-crawler/c.json'], { cwd: repoDir, encoding: 'utf-8' });
      expect(cRemote).toContain('c1');
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('3-way merges a shared tracked file (jobs-ai-cache) when the remote updated it after checkout', () => {
    const { originDir, repoDir } = initClonePair();
    const otherDir = mkdtempSync(join(tmpdir(), 'gcd-grouped-other-'));

    try {
      mkdirSync(join(repoDir, 'data/jobs/by-crawler'), { recursive: true });
      mkdirSync(join(repoDir, 'data'), { recursive: true });
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), '[]\n');
      writeFileSync(join(repoDir, 'data/jobs-ai-cache.json'), '{"seed":1}\n');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });

      // Another group's crawler adds ITS ai-cache entry on the remote.
      execFileSync('git', ['clone', '-q', originDir, join(otherDir, 'clone')]);
      const otherClone = join(otherDir, 'clone');
      execFileSync('git', ['config', 'user.email', 'other@example.com'], { cwd: otherClone });
      execFileSync('git', ['config', 'user.name', 'Other'], { cwd: otherClone });
      writeFileSync(join(otherClone, 'data/jobs-ai-cache.json'), '{"seed":1,"remoteEntry":2}\n');
      execFileSync('git', ['add', '.'], { cwd: otherClone });
      execFileSync('git', ['commit', '-q', '-m', 'other group: ai-cache'], { cwd: otherClone });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: otherClone });

      // This workspace's crawler also added a DIFFERENT ai-cache entry.
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), '[{"id":"a1"}]\n');
      writeFileSync(join(repoDir, 'data/jobs-ai-cache.json'), '{"seed":1,"localEntry":3}\n');

      runScript(repoDir, 'data/jobs/by-crawler/a.json');

      execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: repoDir });
      const merged = JSON.parse(
        execFileSync('git', ['show', 'origin/main:data/jobs-ai-cache.json'], { cwd: repoDir, encoding: 'utf-8' }),
      );
      // Neither side's concurrent addition may be clobbered.
      expect(merged).toMatchObject({ seed: 1, remoteEntry: 2, localEntry: 3 });
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  // Regression coverage for issue #4603: a job slice's array-merge must not
  // resurrect a record the remote side already deleted just because the
  // local (stale) snapshot still has it edited. Concretely: a crawl-time
  // merge collapses two URL-variant postings sharing one stable `id` into a
  // single surviving record (remote push). Meanwhile a long-running sibling
  // process (e.g. translate-pending's slug-regen) started from a snapshot
  // taken BEFORE that collapse — its local worktree still has both records,
  // one of them cosmetically touched. The 3-way merge must respect the
  // remote-side deletion instead of letting the stale local edit resurrect
  // the retired record (previously: mergeArray always kept a "touched" key
  // from local even when remote no longer had it at all).
  it('does not resurrect a job record the remote side already collapsed away, even if local touched it', () => {
    const { originDir, repoDir } = initClonePair();
    const otherDir = mkdtempSync(join(tmpdir(), 'gcd-grouped-other-'));

    try {
      mkdirSync(join(repoDir, 'data/jobs/by-crawler'), { recursive: true });
      const base = [
        { id: 'j1', url: 'https://x.example/old' },
        { id: 'j1', url: 'https://x.example/new', title: 'v1' },
      ];
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), `${JSON.stringify(base)}\n`);
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });

      // The crawler's own dedicated crawl runs concurrently and pushes the
      // collapsed (correct) state: only the "new" URL variant survives.
      execFileSync('git', ['clone', '-q', originDir, join(otherDir, 'clone')]);
      const otherClone = join(otherDir, 'clone');
      execFileSync('git', ['config', 'user.email', 'other@example.com'], { cwd: otherClone });
      execFileSync('git', ['config', 'user.name', 'Other'], { cwd: otherClone });
      const collapsed = [{ id: 'j1', url: 'https://x.example/new', title: 'v1' }];
      writeFileSync(join(otherClone, 'data/jobs/by-crawler/a.json'), `${JSON.stringify(collapsed)}\n`);
      execFileSync('git', ['add', '.'], { cwd: otherClone });
      execFileSync('git', ['commit', '-q', '-m', 'crawler: collapse duplicate req id'], { cwd: otherClone });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: otherClone });

      // Meanwhile this workspace (simulating translate-pending, started from
      // the pre-collapse snapshot) cosmetically touches the now-retired "old"
      // record — it never re-fetched, so it still has both.
      const staleLocal = [
        { id: 'j1', url: 'https://x.example/old', note: 'slug-regen touched me' },
        { id: 'j1', url: 'https://x.example/new', title: 'v1' },
      ];
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), `${JSON.stringify(staleLocal)}\n`);

      runScript(repoDir, 'data/jobs/by-crawler/a.json');

      execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: repoDir });
      const merged = JSON.parse(
        execFileSync('git', ['show', 'origin/main:data/jobs/by-crawler/a.json'], { cwd: repoDir, encoding: 'utf-8' }),
      );
      expect(merged).toHaveLength(1);
      expect(merged[0].url).toBe('https://x.example/new');
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  // Regression coverage for issue 4433: a job's array-merge must not let a
  // "touched" local job wholesale-replace a matched remote job and silently
  // discard the remote side's OWN independent field-level gains. Concretely:
  // a long-running translate-pending run holds a stale checkout of a job and
  // touches only an UNRELATED field (e.g. crawledAt); meanwhile a separate,
  // faster writer independently appends a new previousSlugs entry to the
  // SAME job on origin/main (e.g. a concurrent slug-rename). Both edits are
  // legitimate and target different fields of the same record, so the 3-way
  // merge must reconcile them field-by-field — not let whichever side is
  // "touched" win the whole record and drop the other side's addition.
  it('reconciles independent field-level edits to the SAME matched job instead of one side clobbering the other', () => {
    const { originDir, repoDir } = initClonePair();
    const otherDir = mkdtempSync(join(tmpdir(), 'gcd-grouped-other-'));

    try {
      mkdirSync(join(repoDir, 'data/jobs/by-crawler'), { recursive: true });
      const base = [
        {
          id: 'j1',
          url: 'https://x.example/job',
          crawledAt: '2026-06-01',
          previousSlugs: ['old-slug-a', 'old-slug-b'],
        },
      ];
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), `${JSON.stringify(base)}\n`);
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });

      // A separate writer (e.g. a concurrent slug-rename) independently
      // appends a NEW previousSlugs entry to the same job on the remote.
      execFileSync('git', ['clone', '-q', originDir, join(otherDir, 'clone')]);
      const otherClone = join(otherDir, 'clone');
      execFileSync('git', ['config', 'user.email', 'other@example.com'], { cwd: otherClone });
      execFileSync('git', ['config', 'user.name', 'Other'], { cwd: otherClone });
      const remote = [
        {
          id: 'j1',
          url: 'https://x.example/job',
          crawledAt: '2026-06-01',
          previousSlugs: ['old-slug-a', 'old-slug-b', 'concurrent-rename-slug'],
        },
      ];
      writeFileSync(join(otherClone, 'data/jobs/by-crawler/a.json'), `${JSON.stringify(remote)}\n`);
      execFileSync('git', ['add', '.'], { cwd: otherClone });
      execFileSync('git', ['commit', '-q', '-m', 'crawler: rename slug'], { cwd: otherClone });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: otherClone });

      // Meanwhile this workspace (simulating translate-pending, started from
      // the pre-rename snapshot) touches only an UNRELATED field — it never
      // re-fetched, so its own previousSlugs copy is still the stale 2-entry
      // array.
      const staleLocal = [
        {
          id: 'j1',
          url: 'https://x.example/job',
          crawledAt: '2026-07-01',
          previousSlugs: ['old-slug-a', 'old-slug-b'],
        },
      ];
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), `${JSON.stringify(staleLocal)}\n`);

      runScript(repoDir, 'data/jobs/by-crawler/a.json');

      execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: repoDir });
      const merged = JSON.parse(
        execFileSync('git', ['show', 'origin/main:data/jobs/by-crawler/a.json'], { cwd: repoDir, encoding: 'utf-8' }),
      );
      expect(merged).toHaveLength(1);
      // Local's unrelated field edit must survive...
      expect(merged[0].crawledAt).toBe('2026-07-01');
      // ...AND remote's independently-added previousSlugs entry must not be
      // silently dropped just because local also touched the same record.
      expect(merged[0].previousSlugs).toEqual(
        expect.arrayContaining(['old-slug-a', 'old-slug-b', 'concurrent-rename-slug']),
      );
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('commits a brand-new untracked slice file (first-ever run of a crawler in a group)', () => {
    const { originDir, repoDir } = initClonePair();
    try {
      mkdirSync(join(repoDir, 'data/jobs/by-crawler'), { recursive: true });
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/existing.json'), '[]\n');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });

      // New crawler's very first slice: untracked file, no tracked change at
      // all. The legacy whole-tree early-exit would have said "No changes
      // detected" and silently skipped the commit.
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/newbie.json'), '[{"id":"n1"}]\n');

      runScript(repoDir, 'data/jobs/by-crawler/newbie.json');

      execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: repoDir });
      const remote = execFileSync('git', ['show', 'origin/main:data/jobs/by-crawler/newbie.json'], { cwd: repoDir, encoding: 'utf-8' });
      expect(remote).toContain('n1');
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  // Exit-42 classification (PR #4056 round-1): 42 = PUSH_CONTENTION_EXHAUSTED
  // may ONLY fire when the LAST push attempt failed with a ref rejection/race
  // (rejected / fetch first / cannot lock ref / non-fast-forward). Any other
  // terminal failure (network outage, auth expiry, hook decline) must stay
  // exit 1 — the grouped workflows absorb 42 as "self-heals next run", and an
  // outage silently classified as contention would turn a real failure into a
  // green step. Simulated deterministically with a PATH `git` shim that fails
  // every `git push` with a canned output and delegates everything else to
  // the real git; MAX_PUSH_ATTEMPTS=1 exhausts the loop on the first attempt.
  function runScriptWithPushShim(
    repoDir: string,
    sliceFile: string | undefined,
    pushFailureOutput: string,
    githubOutput = '',
  ) {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf-8' }).trim();
    const shimDir = mkdtempSync(join(tmpdir(), 'gcd-git-shim-'));
    const outputFile = join(shimDir, 'push-output.txt');
    writeFileSync(outputFile, pushFailureOutput);
    writeFileSync(
      join(shimDir, 'git'),
      `#!/bin/bash\nif [ "$1" = "push" ]; then\n  cat '${outputFile}' >&2\n  exit 1\nfi\nexec '${realGit}' "$@"\n`,
    );
    chmodSync(join(shimDir, 'git'), 0o755);

    const result = spawnSync(BASH_BIN, [SCRIPT_PATH, '--slice-only', 'test commit'], {
      cwd: repoDir,
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}`,
        MAX_PUSH_ATTEMPTS: '1',
        ...(sliceFile ? { JOBS_SLICE_FILE: sliceFile } : {}),
        SKIP_AI_TRANSLATION: '1',
        SLUG_HISTORY_SUMMARY_FILE: join(repoDir, 'no-such-slug-history-summary.txt'),
        GH_TOKEN: '',
        GITHUB_TOKEN: '',
        GITHUB_RUN_ID: '',
        GITHUB_REPOSITORY: '',
        GITHUB_OUTPUT: githubOutput,
      },
    });
    rmSync(shimDir, { recursive: true, force: true });
    return result;
  }

  function seedRepoWithPendingSlice(repoDir: string) {
    mkdirSync(join(repoDir, 'data/jobs/by-crawler'), { recursive: true });
    writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), '[]\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repoDir });
    writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), '[{"id":"a1"}]\n');
  }

  it('emits the pushed SHA while preserving the local HEAD', () => {
    const { originDir, repoDir } = initClonePair();
    const output = join(repoDir, 'github-output.txt');
    try {
      seedRepoWithPendingSlice(repoDir);
      const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();

      runScript(repoDir, 'data/jobs/by-crawler/a.json', output);

      const pushed = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], { cwd: repoDir, encoding: 'utf-8' })
        .split(/\s+/)[0];
      expect(readFileSync(output, 'utf-8')).toBe(`has_changes=true\nfinal_commit=${pushed}\n`);
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim()).toBe(headBefore);
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('does not emit final_commit for a no-op or sequential soft push contention', () => {
    const { originDir, repoDir } = initClonePair();
    const output = join(repoDir, 'github-output.txt');
    const contention = ' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs\n';
    try {
      seedRepoWithPendingSlice(repoDir);
      execFileSync('git', ['checkout', '--', 'data/jobs/by-crawler/a.json'], { cwd: repoDir });

      runScript(repoDir, 'data/jobs/by-crawler/a.json', output);
      expect(readFileSync(output, 'utf-8')).toBe('has_changes=false\n');

      writeFileSync(output, '');
      writeFileSync(join(repoDir, 'data/jobs/by-crawler/a.json'), '[{"id":"a1"}]\n');
      const result = runScriptWithPushShim(repoDir, undefined, contention, output);
      expect(result.status).toBe(0);
      expect(readFileSync(output, 'utf-8')).not.toContain('final_commit=');
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('exits 42 when retries are exhausted by a genuine ref rejection/race', () => {
    const { originDir, repoDir } = initClonePair();
    try {
      seedRepoWithPendingSlice(repoDir);
      const result = runScriptWithPushShim(
        repoDir,
        'data/jobs/by-crawler/a.json',
        'To https://github.com/example/repo.git\n' +
          ' ! [rejected]        main -> main (fetch first)\n' +
          "error: failed to push some refs to 'https://github.com/example/repo.git'\n" +
          'hint: Updates were rejected because the remote contains work that you do not have locally.\n',
      );
      expect(result.status).toBe(42);
      expect(`${result.stdout}${result.stderr}`).toContain('contention loss');
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('exits 1 (NOT 42) when retries are exhausted by a non-contention failure (outage/auth)', () => {
    const { originDir, repoDir } = initClonePair();
    try {
      seedRepoWithPendingSlice(repoDir);
      const result = runScriptWithPushShim(
        repoDir,
        'data/jobs/by-crawler/a.json',
        "fatal: unable to access 'https://github.com/example/repo.git/': Could not resolve host: github.com\n",
      );
      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain('NOT a ref rejection/race');
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
