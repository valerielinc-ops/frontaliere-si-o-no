import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assertOldHistorySafe,
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
    expect(inspectOldHistory({
      cwd: repo,
      markerRef: '0'.repeat(40),
      headRef: oldPrHead,
      baseRef: rewrittenBase,
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
});
