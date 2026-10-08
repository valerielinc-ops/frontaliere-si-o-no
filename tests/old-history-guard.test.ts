import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assertOldHistorySafe,
  checkOldHistory,
  describeTrace,
  HISTORY_GRAPH_FETCH_TIMEOUT_MS,
  inspectOldHistory,
  OLD_HISTORY_FIRST_CHANGED_COMMIT,
  proveHeadAddsNoOldHistory,
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

const GUARD_SCRIPT = fileURLToPath(new URL('../scripts/lib/old-history-guard.mjs', import.meta.url));

type TraceEntry = { step: string; ms?: number; failed?: boolean; proven?: boolean; why?: string; addedCommits?: number };

const emptyCommit = (cwd: string, message: string) => {
  git(
    cwd,
    '-c', 'user.name=old-history-guard-test',
    '-c', 'user.email=old-history-guard-test@example.invalid',
    'commit', '--no-verify', '--allow-empty', '-m', message,
  );
  return git(cwd, 'rev-parse', 'HEAD');
};

/**
 * A remote in the state the real one is in after the rewrite: `main` carries
 * the rewritten history, and the previous one (root → marker → old tip) is
 * still served under another ref. Both share the root, as the real histories
 * share everything before the first rewritten commit.
 */
function rewrittenRemoteFixture() {
  const root = mkdtempSync(join(tmpdir(), 'old-history-guard-bounded-'));
  const seed = join(root, 'seed');
  const remote = join(root, 'remote.git');
  git(root, 'init', '--bare', '--quiet', remote);
  git(root, 'init', '--quiet', '--initial-branch=main', seed);
  const sharedRoot = emptyCommit(seed, 'root');
  const fixtureMarker = emptyCommit(seed, 'marker');
  emptyCommit(seed, 'old tip');
  git(seed, 'push', '--quiet', remote, 'HEAD:refs/heads/old-branch');
  git(seed, 'switch', '--quiet', '-c', 'rewritten', sharedRoot);
  const forkPoint = emptyCommit(seed, 'rewritten one');
  emptyCommit(seed, 'rewritten two');
  emptyCommit(seed, 'rewritten three');
  git(seed, 'push', '--quiet', remote, 'HEAD:refs/heads/main');
  let clones = 0;
  return {
    root,
    seed,
    remote,
    fixtureMarker,
    forkPoint,
    shallowClone(branch: string) {
      clones += 1;
      const directory = join(root, `checkout-${clones}`);
      execFileSync('git', ['clone', '--quiet', '--depth', '1', '--branch', branch, `file://${remote}`, directory], {
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return directory;
    },
    advanceMain(count: number) {
      git(seed, 'switch', '--quiet', 'rewritten');
      for (let index = 0; index < count; index += 1) emptyCommit(seed, `main moved ${index}`);
      git(seed, 'push', '--quiet', remote, 'HEAD:refs/heads/main');
      return git(seed, 'rev-parse', 'HEAD');
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const guardCall = (cwd: string, markerRef: string, trace: TraceEntry[], headRef = 'HEAD') => checkOldHistory({
  cwd,
  markerRef,
  headRef,
  baseRef: 'refs/remotes/origin/main',
  refreshBase: true,
  remote: 'origin',
  branch: 'main',
  trace,
});

const steps = (trace: TraceEntry[]) => trace.map((entry) => entry.step);

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

  it('usa un budget separato e bounded per completare un grafo shallow grande', () => {
    expect(HISTORY_GRAPH_FETCH_TIMEOUT_MS).toBe(5 * 60_000);
  });

  it('completa il grafo per un marker locale scollegato dall’head shallow', () => {
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

      // This object is local but unrelated to the current head. A shallow
      // merge-base false is still inconclusive, so the guard must complete
      // the graph before retaining the pass result.
      expect(() => git(shallow, 'cat-file', '-e', `${availableMarker}^{commit}`)).not.toThrow();

      expect(checkOldHistory({
        cwd: shallow,
        markerRef: availableMarker,
        headRef: 'HEAD',
        baseRef: 'refs/remotes/origin/rewritten-main',
        refreshBase: true,
        remote: 'origin',
        branch: 'main',
      })).toEqual({ outcome: 'pass', reason: 'marker-not-in-head' });
      expect(git(shallow, 'rev-parse', '--is-shallow-repository')).toBe('false');
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  });

  it('mantiene il fast path quando il marker è già provato nel base shallow', () => {
    const shallow = mkdtempSync(join(tmpdir(), 'old-history-guard-base-fast-path-'));
    try {
      execFileSync('git', [
        'clone', '--quiet', '--depth', '3', '--branch', 'old-pr',
        `file://${repo}`, shallow,
      ], {
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      git(shallow, 'fetch', '--quiet', '--depth', '3', 'origin', 'main:refs/remotes/origin/main');

      expect(checkOldHistory({
        cwd: shallow,
        markerRef: marker,
        headRef: 'HEAD',
        baseRef: 'refs/remotes/origin/main',
        refreshBase: true,
        remote: 'origin',
        branch: 'main',
      })).toEqual({ outcome: 'pass', reason: 'marker-in-base' });
      expect(git(shallow, 'rev-parse', '--is-shallow-repository')).toBe('true');
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  });

  it('completa la storia per un marker locale oltre il confine shallow', () => {
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
      // Materialise the marker as a detached object without changing the
      // shallow boundary. It is an ancestor of the checked-out old branch,
      // but merge-base cannot prove that until the graph is completed.
      git(shallow, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--filter=tree:0', 'origin', shallowMarker);
      expect(() => git(shallow, 'cat-file', '-e', `${shallowMarker}^{commit}`)).not.toThrow();

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

  // ── The bounded proof ────────────────────────────────────────────────────
  // After the rewrite every data writer on a shallow checkout paid for the
  // whole commit graph before its first commit (61.6 s in a crawler group, 83 s
  // in the job that then ran out of its 30 minutes). These cases pin the
  // ordinary shapes that are decided in one fetch, and the ones that are not.

  it('decide un checkout shallow di main senza marker né grafo', () => {
    const fixture = rewrittenRemoteFixture();
    try {
      const checkout = fixture.shallowClone('main');
      const trace: TraceEntry[] = [];

      expect(guardCall(checkout, fixture.fixtureMarker, trace)).toEqual({ outcome: 'pass', reason: 'head-adds-no-old-history' });
      expect(steps(trace)).toEqual(['refresh-base', 'bounded-proof']);
      expect(trace[1]).toMatchObject({ proven: true, addedCommits: 0 });
      // The checkout is left as `actions/checkout` made it.
      expect(git(checkout, 'rev-parse', '--is-shallow-repository')).toBe('true');
      expect(() => git(checkout, 'cat-file', '-e', `${fixture.fixtureMarker}^{commit}`)).toThrow();
      expect(() => git(checkout, 'config', '--get', 'remote.origin.promisor')).toThrow();
    } finally {
      fixture.cleanup();
    }
  });

  it('decide lo stesso checkout quando main è avanzato dopo il checkout', () => {
    const fixture = rewrittenRemoteFixture();
    try {
      const checkout = fixture.shallowClone('main');
      const movedTip = fixture.advanceMain(3);
      const trace: TraceEntry[] = [];

      expect(guardCall(checkout, fixture.fixtureMarker, trace)).toEqual({ outcome: 'pass', reason: 'head-adds-no-old-history' });
      expect(trace.at(-1)).toMatchObject({ step: 'bounded-proof', proven: true, addedCommits: 0 });
      // The verdict is about the remote branch as it is now.
      expect(git(checkout, 'rev-parse', 'refs/remotes/origin/main')).toBe(movedTip);
      expect(git(checkout, 'rev-parse', '--is-shallow-repository')).toBe('true');
    } finally {
      fixture.cleanup();
    }
  });

  it('decide un writer che ha già committato sopra il checkout, e il commit che sta per pushare', () => {
    const fixture = rewrittenRemoteFixture();
    try {
      const checkout = fixture.shallowClone('main');
      fixture.advanceMain(2);
      const local = emptyCommit(checkout, 'data refresh');
      const trace: TraceEntry[] = [];

      expect(guardCall(checkout, fixture.fixtureMarker, trace)).toEqual({ outcome: 'pass', reason: 'head-adds-no-old-history' });
      expect(trace.at(-1)).toMatchObject({ step: 'bounded-proof', proven: true, addedCommits: 1 });
      // The pre-push hook passes the pushed commit, not HEAD.
      expect(guardCall(checkout, fixture.fixtureMarker, [], local)).toEqual({ outcome: 'pass', reason: 'head-adds-no-old-history' });
      expect(git(checkout, 'rev-parse', '--is-shallow-repository')).toBe('true');
    } finally {
      fixture.cleanup();
    }
  });

  it('non decide un checkout shallow rimasto sulla storia precedente: lo blocca il controllo completo', () => {
    const fixture = rewrittenRemoteFixture();
    try {
      // The run that the guard exists for: checked out before the rewrite,
      // still running (or re-run) after it.
      const checkout = fixture.shallowClone('old-branch');
      const trace: TraceEntry[] = [];

      expect(guardCall(checkout, fixture.fixtureMarker, trace)).toMatchObject({ outcome: 'blocked' });
      expect(trace.find((entry) => entry.step === 'bounded-proof')).toMatchObject({
        proven: false,
        why: 'added-commit-on-shallow-boundary',
      });
      expect(steps(trace)).toEqual(['refresh-base', 'bounded-proof', 'fetch-marker', 'complete-shallow-history']);
      expect(git(checkout, 'rev-parse', '--is-shallow-repository')).toBe('false');
    } finally {
      fixture.cleanup();
    }
  });

  it('prova limitata: una storia del base troncata allunga l’elenco, e il marker nell’elenco la ferma', () => {
    const fixture = rewrittenRemoteFixture();
    try {
      // Two branches forked below the shallow boundary of main: one on the
      // rewritten history, one that carries the marker.
      git(fixture.seed, 'switch', '--quiet', '-c', 'clean-branch', fixture.forkPoint);
      emptyCommit(fixture.seed, 'clean work');
      git(fixture.seed, 'push', '--quiet', fixture.remote, 'HEAD:refs/heads/clean-branch');
      const checkout = fixture.shallowClone('main');
      git(checkout, 'fetch', '--quiet', '--no-tags', 'origin',
        '+refs/heads/clean-branch:refs/remotes/origin/clean-branch',
        '+refs/heads/old-branch:refs/remotes/origin/old-branch');
      const proof = (headRef: string) => proveHeadAddsNoOldHistory({
        cwd: checkout,
        markerRef: fixture.fixtureMarker,
        headRef,
        baseRef: 'refs/remotes/origin/main',
      });

      // root and «rewritten one» are ancestors of main, but the checkout cannot
      // see that below its boundary: they are listed, and the proof still holds.
      expect(proof('refs/remotes/origin/clean-branch')).toEqual({ proven: true, addedCommits: 3 });
      expect(proof('refs/remotes/origin/old-branch')).toEqual({ proven: false, why: 'marker-among-added-commits' });
      expect(guardCall(checkout, fixture.fixtureMarker, [], 'refs/remotes/origin/old-branch')).toMatchObject({ outcome: 'blocked' });
    } finally {
      fixture.cleanup();
    }
  });

  it('un base che non si aggiorna lascia la decisione al controllo completo', () => {
    const fixture = rewrittenRemoteFixture();
    try {
      const checkout = fixture.shallowClone('main');
      const trace: TraceEntry[] = [];

      // No such branch on the remote: the refresh fails, the proof is not
      // attempted, and the ordinary path answers as it did before.
      expect(checkOldHistory({
        cwd: checkout,
        markerRef: '0'.repeat(40),
        headRef: 'HEAD',
        baseRef: 'refs/remotes/origin/main',
        refreshBase: true,
        remote: 'origin',
        branch: 'no-such-branch',
        trace,
      })).toEqual({ outcome: 'pass', reason: 'marker-unavailable' });
      expect(trace[0]).toMatchObject({ step: 'refresh-base', failed: true });
      expect(trace[1]).toMatchObject({ step: 'bounded-proof', proven: false, why: 'base-refresh-failed' });
    } finally {
      fixture.cleanup();
    }
  });

  it('la riga del verdetto dice quale prova ha deciso e quanto è costata', () => {
    const fixture = rewrittenRemoteFixture();
    try {
      const checkout = fixture.shallowClone('main');
      // The marker is a constant of the real repository, absent from this
      // remote: the command line exercises the same path a data writer takes.
      const output = execFileSync(process.execPath, [
        GUARD_SCRIPT, '--head', 'HEAD', '--base', 'refs/remotes/origin/main', '--refresh-base', '--remote', 'origin', '--branch', 'main',
      ], { cwd: checkout, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });

      expect(output).toMatch(/controllo superato senza scaricare il grafo\. \[aggiornamento del base: \d+\.\d s; prova limitata riuscita, 0 commit sopra il base\]/);
      expect(describeTrace([
        { step: 'refresh-base', ms: 900 },
        { step: 'bounded-proof', proven: false, why: 'added-commit-on-shallow-boundary' },
        { step: 'complete-shallow-history', ms: 61_600 },
      ])).toBe(' [aggiornamento del base: 0.9 s; prova limitata non conclusiva: added-commit-on-shallow-boundary; completamento del grafo della storia: 61.6 s]');
      expect(describeTrace([{ step: 'complete-shallow-history', ms: 300_000, failed: true }]))
        .toBe(' [completamento del grafo della storia: non riuscito dopo 300.0 s]');
      expect(describeTrace([])).toBe('');
    } finally {
      fixture.cleanup();
    }
  });
});
