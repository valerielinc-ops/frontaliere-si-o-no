import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assertOldHistorySafe,
  checkOldHistory,
  inspectOldHistory,
  OLD_HISTORY_FIRST_CHANGED_COMMIT,
} from '../scripts/lib/old-history-guard.mjs';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

const commit = (cwd: string, message: string) => git(
  cwd,
  '-c', 'user.name=old-history-guard-test',
  '-c', 'user.email=old-history-guard-test@example.invalid',
  'commit', '--no-verify', '-m', message,
);

describe('old-history-guard', () => {
  let repo = '';
  let marker = '';
  let preRewriteBase = '';
  let oldPrHead = '';
  let rewrittenBase = '';
  let cleanPrHead = '';

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'old-history-guard-'));
    git(repo, 'init', '--quiet', '--initial-branch=main');

    writeFileSync(join(repo, 'root.txt'), 'root\n');
    git(repo, 'add', 'root.txt');
    commit(repo, 'root');
    preRewriteBase = git(repo, 'rev-parse', 'HEAD');

    writeFileSync(join(repo, 'history.txt'), 'old history\n');
    git(repo, 'add', 'history.txt');
    commit(repo, 'marker');
    marker = git(repo, 'rev-parse', 'HEAD');

    writeFileSync(join(repo, 'main.txt'), 'before rewrite\n');
    git(repo, 'add', 'main.txt');
    commit(repo, 'main before rewrite');

    git(repo, 'switch', '--quiet', '-c', 'old-pr');
    writeFileSync(join(repo, 'old-pr.txt'), 'old branch\n');
    git(repo, 'add', 'old-pr.txt');
    commit(repo, 'old PR commit');
    oldPrHead = git(repo, 'rev-parse', 'HEAD');

    git(repo, 'switch', '--quiet', 'main');
    git(repo, 'switch', '--quiet', '-c', 'rewritten-main', preRewriteBase);
    writeFileSync(join(repo, 'rewritten.txt'), 'new history\n');
    git(repo, 'add', 'rewritten.txt');
    commit(repo, 'main after rewrite');
    rewrittenBase = git(repo, 'rev-parse', 'HEAD');

    git(repo, 'switch', '--quiet', '-c', 'clean-pr');
    writeFileSync(join(repo, 'clean-pr.txt'), 'clean branch\n');
    git(repo, 'add', 'clean-pr.txt');
    commit(repo, 'clean PR commit');
    cleanPrHead = git(repo, 'rev-parse', 'HEAD');
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('blocca una PR la cui head conserva la storia precedente dopo la riscrittura', () => {
    expect(inspectOldHistory({
      cwd: repo,
      markerRef: marker,
      headRef: oldPrHead,
      baseRef: rewrittenBase,
    })).toMatchObject({ outcome: 'blocked' });
  });

  it('fa fallire anche i writer Node prima di un push diretto su main', () => {
    expect(() => assertOldHistorySafe({
      cwd: repo,
      markerRef: marker,
      headRef: oldPrHead,
      baseRef: rewrittenBase,
    })).toThrow(/git rebase --onto origin\/main/);
  });

  it('lascia passare una PR ricreata dal base riscritto', () => {
    expect(inspectOldHistory({
      cwd: repo,
      markerRef: marker,
      headRef: cleanPrHead,
      baseRef: rewrittenBase,
    })).toEqual({ outcome: 'pass', reason: 'marker-not-in-head' });
  });

  it('lascia passare quando il marker non è più disponibile', () => {
    const missingMarker = '0'.repeat(40);
    expect(inspectOldHistory({
      cwd: repo,
      markerRef: missingMarker,
      headRef: oldPrHead,
      baseRef: rewrittenBase,
    })).toEqual({ outcome: 'pass', reason: 'marker-unavailable' });
    expect(checkOldHistory({
      cwd: repo,
      markerRef: missingMarker,
      headRef: oldPrHead,
      baseRef: rewrittenBase,
      refreshBase: true,
      remote: repo,
      branch: 'main',
    })).toEqual({ outcome: 'pass', reason: 'marker-unavailable' });
  });

  it('resta inerte prima della riscrittura, quando il base contiene il marker', () => {
    expect(inspectOldHistory({
      cwd: repo,
      markerRef: marker,
      headRef: oldPrHead,
      baseRef: git(repo, 'rev-parse', 'main'),
    })).toEqual({ outcome: 'pass', reason: 'marker-in-base' });
  });

  it('mantiene una sola costante di produzione per il marker', () => {
    expect(OLD_HISTORY_FIRST_CHANGED_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });

  it('non completa il grafo quando il marker è già assente dall’head shallow', () => {
    const shallow = mkdtempSync(join(tmpdir(), 'old-history-guard-current-head-'));
    try {
      execFileSync('git', [
        'clone', '--quiet', '--depth', '1', '--branch', 'rewritten-main',
        `file://${repo}`, shallow,
      ], {
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // Keep an available marker in a separate, disconnected ref without
      // asking the guard to fetch it by object id; the current head remains a
      // separate shallow history.
      git(shallow, 'switch', '--quiet', '--orphan', 'available-marker');
      writeFileSync(join(shallow, 'available-marker.txt'), 'legacy marker\n');
      git(shallow, 'add', 'available-marker.txt');
      commit(shallow, 'available marker');
      const availableMarker = git(shallow, 'rev-parse', 'HEAD');
      git(shallow, 'switch', '--quiet', 'rewritten-main');

      expect(checkOldHistory({
        cwd: shallow,
        markerRef: availableMarker,
        headRef: 'HEAD',
        baseRef: 'refs/remotes/origin/rewritten-main',
        refreshBase: true,
        remote: 'origin',
        branch: 'main',
      })).toEqual({ outcome: 'pass', reason: 'marker-not-in-head' });
      expect(git(shallow, 'rev-parse', '--is-shallow-repository')).toBe('true');
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  });

  it('completa la storia prima di classificare il marker oltre il confine shallow', () => {
    const root = mkdtempSync(join(tmpdir(), 'old-history-guard-shallow-'));
    const seed = join(root, 'seed');
    const remote = join(root, 'remote.git');
    const shallow = join(root, 'shallow');
    try {
      git(root, 'init', '--bare', '--quiet', remote);
      git(root, 'init', '--quiet', '--initial-branch=main', seed);
      git(seed, 'config', 'user.name', 'old-history-guard-test');
      git(seed, 'config', 'user.email', 'old-history-guard-test@example.invalid');
      git(seed, 'commit', '--allow-empty', '-m', 'root');
      git(seed, 'commit', '--allow-empty', '-m', 'marker');
      const shallowMarker = git(seed, 'rev-parse', 'HEAD');
      git(seed, 'commit', '--allow-empty', '-m', 'old one');
      git(seed, 'commit', '--allow-empty', '-m', 'old two');
      git(seed, 'branch', '-M', 'main');
      git(seed, 'push', '--quiet', remote, 'main');
      git(seed, 'push', '--quiet', remote, 'main:old-branch');
      git(seed, 'switch', '--quiet', '--orphan', 'rewritten-main');
      git(seed, 'commit', '--allow-empty', '-m', 'rewritten main');
      git(seed, 'push', '--quiet', remote, '+HEAD:main');

      execFileSync('git', ['clone', '--quiet', '--depth', '1', '--branch', 'old-branch', `file://${remote}`, shallow], {
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      git(shallow, 'fetch', '--quiet', '--depth', '1', 'origin', 'main:refs/remotes/origin/main');
      expect(() => git(shallow, 'cat-file', '-e', `${shallowMarker}^{commit}`)).toThrow();

      expect(checkOldHistory({
        cwd: shallow,
        markerRef: shallowMarker,
        headRef: 'refs/remotes/origin/old-branch',
        baseRef: 'refs/remotes/origin/main',
        refreshBase: true,
        remote: 'origin',
        branch: 'main',
      })).toMatchObject({ outcome: 'blocked' });
      expect(git(shallow, 'rev-parse', '--is-shallow-repository')).toBe('false');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
