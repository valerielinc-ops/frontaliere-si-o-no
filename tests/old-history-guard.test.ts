import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
import * as oldHistoryGuard from '../scripts/lib/old-history-guard.mjs';

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
const appendGitConfigEnvironment = oldHistoryGuard.appendGitConfigEnvironment;

type TraceEntry = { step: string; ms?: number; failed?: boolean; proven?: boolean; why?: string; addedCommits?: number; verdict?: string };

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
    advanceMainWithLargeBlobs() {
      git(seed, 'switch', '--quiet', 'rewritten');
      const files = [0, 1, 2].map((index) => `large-${index}.bin`);
      files.forEach((file, index) => writeFileSync(join(seed, file), Buffer.alloc(2 * 1024 * 1024, 0x61 + index)));
      git(seed, 'add', ...files);
      commit(seed, 'main moved with large blobs');
      git(seed, 'push', '--quiet', remote, 'HEAD:refs/heads/main');
      return git(seed, 'rev-parse', 'HEAD');
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const guardCall = (cwd: string, markerRef: string, trace: TraceEntry[], headRef = 'HEAD', remote = 'origin') => checkOldHistory({
  cwd,
  markerRef,
  headRef,
  baseRef: 'refs/remotes/origin/main',
  refreshBase: true,
  remote,
  branch: 'main',
  trace,
});

const steps = (trace: TraceEntry[]) => trace.map((entry) => entry.step);

function withGitConfigEnvironment<T>(entries: Array<{ key: string; value: string }>, run: () => T): T {
  const prior = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key === 'GIT_CONFIG_NOSYSTEM' || key.startsWith('GIT_CONFIG_')));
  for (const key of Object.keys(prior)) delete process.env[key];
  const env = appendGitConfigEnvironment({ ...process.env, GIT_CONFIG_COUNT: '0' }, entries);
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('GIT_CONFIG_') && value !== undefined) process.env[key] = value;
  }
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  try {
    return run();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key === 'GIT_CONFIG_NOSYSTEM' || key.startsWith('GIT_CONFIG_')) delete process.env[key];
    }
    Object.assign(process.env, prior);
  }
}

function withEnvironment<T>(entries: Record<string, string>, run: () => T): T {
  const previous = Object.fromEntries(Object.keys(entries).map((key) => [key, process.env[key]]));
  Object.assign(process.env, entries);
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function mockGithubCli(root: string, statuses: string[]) {
  const bin = join(root, 'mock-bin');
  const log = join(root, 'gh-api-calls.jsonl');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$GH_COMPARE_CALL_LOG"',
    'call_count="$(wc -l < "$GH_COMPARE_CALL_LOG" | tr -d " ")"',
    'printf "%s\\n" "$GH_COMPARE_STATUSES" | cut -d, -f "$call_count"',
    '',
  ].join('\n'), { mode: 0o755 });
  return { bin, log, statuses: statuses.join(',') };
}

const scratchDirectories = () => readdirSync(tmpdir(), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('old-history-guard-'))
  .map((entry) => entry.name)
  .sort();

const filesUnder = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? filesUnder(path) : [path];
});

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

  it('accoda la configurazione Git temporanea senza perdere quella già presente', () => {
    expect(typeof appendGitConfigEnvironment).toBe('function');
    if (typeof appendGitConfigEnvironment !== 'function') return;
    const env = appendGitConfigEnvironment({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'preserved',
    }, [{ key: 'remote.guard.url', value: 'file:///tmp/remote.git' }]);

    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'preserved',
      GIT_CONFIG_KEY_1: 'remote.guard.url',
      GIT_CONFIG_VALUE_1: 'file:///tmp/remote.git',
    });
  });

  it('toglie dall’ambiente dello scratch ciò che lega un comando al checkout, non le credenziali', () => {
    const { detachedRepositoryEnvironment, REPOSITORY_BINDING_ENVIRONMENT } = oldHistoryGuard;
    expect(typeof detachedRepositoryEnvironment).toBe('function');
    if (typeof detachedRepositoryEnvironment !== 'function') return;

    const bindings = Object.fromEntries(REPOSITORY_BINDING_ENVIRONMENT.map((name) => [name, `/checkout/${name}`]));
    const env = detachedRepositoryEnvironment({
      ...bindings,
      PATH: '/usr/bin',
      GIT_CONFIG_PARAMETERS: "'http.extraheader=AUTHORIZATION: basic caller'",
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://example.invalid/.extraheader',
      GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic preserved',
    }, [{ key: 'remote.guard.url', value: 'file:///tmp/remote.git' }]);

    expect(Object.keys(env).filter((name) => REPOSITORY_BINDING_ENVIRONMENT.includes(name))).toEqual([]);
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_PARAMETERS: "'http.extraheader=AUTHORIZATION: basic caller'",
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'http.https://example.invalid/.extraheader',
      GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic preserved',
      GIT_CONFIG_KEY_1: 'remote.guard.url',
      GIT_CONFIG_VALUE_1: 'file:///tmp/remote.git',
    });
  });

  it('copre ogni variabile che git dichiara locale al repository', () => {
    // If a newer git binds its children through one more variable, the scratch
    // repository must drop that one too: this is where it shows up.
    const configCarriers = ['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'];
    const declared = git(repo, 'rev-parse', '--local-env-vars').split('\n').filter(Boolean);

    expect(declared).toEqual(expect.arrayContaining(['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']));
    expect(declared.filter((name) => !configCarriers.includes(name)
      && !(oldHistoryGuard.REPOSITORY_BINDING_ENVIRONMENT || []).includes(name))).toEqual([]);
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
      expect(steps(trace)).toEqual(['remote-descends-from-base', 'bounded-proof']);
      expect(trace[1]).toMatchObject({ proven: true, addedCommits: 0 });
      // The checkout is left as `actions/checkout` made it.
      expect(git(checkout, 'rev-parse', '--is-shallow-repository')).toBe('true');
      expect(() => git(checkout, 'cat-file', '-e', `${fixture.fixtureMarker}^{commit}`)).toThrow();
      expect(() => git(checkout, 'config', '--get', 'remote.origin.promisor')).toThrow();
    } finally {
      fixture.cleanup();
    }
  });

  it('su un clone parziale non chiede il marker al promisor: decide senza scaricarlo', () => {
    const fixture = rewrittenRemoteFixture();
    try {
      // The monitors' checkout is shallow and blobless, so git has a promisor to
      // ask, and this remote serves the previous history by id as the real one does.
      git(fixture.remote, 'config', 'uploadpack.allowFilter', 'true');
      git(fixture.remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
      const checkout = join(fixture.root, 'partial-checkout');
      execFileSync('git', [
        'clone', '--quiet', '--depth', '1', '--filter=blob:none', '--branch', 'main', `file://${fixture.remote}`, checkout,
      ], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      expect(git(checkout, 'config', '--get', 'remote.origin.promisor')).toBe('true');
      const markerIsLocal = () => {
        try {
          execFileSync('git', ['cat-file', '-e', `${fixture.fixtureMarker}^{commit}`], {
            cwd: checkout,
            env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1' },
            stdio: 'ignore',
          });
          return true;
        } catch {
          return false;
        }
      };
      const trace: TraceEntry[] = [];

      expect(guardCall(checkout, fixture.fixtureMarker, trace)).toEqual({ outcome: 'pass', reason: 'head-adds-no-old-history' });
      expect(steps(trace)).toEqual(['remote-descends-from-base', 'bounded-proof']);
      expect(markerIsLocal()).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it('non lascia nel checkout l’URL del remoto: né remoto promisor né FETCH_HEAD (issue 12320)', () => {
    const fixture = rewrittenRemoteFixture();
    try {
      const checkout = fixture.shallowClone('main');
      fixture.advanceMain(1);
      // The data-refresh helper passes the push URL, which carries its token.
      // A filtered fetch would register that URL as a promisor remote.
      const remoteUrl = `file://localhost${fixture.remote}`;
      const fetchHead = () => {
        try {
          return readFileSync(join(checkout, '.git', 'FETCH_HEAD'), 'utf8');
        } catch {
          return null;
        }
      };
      const fetchHeadBefore = fetchHead();

      expect(checkOldHistory({
        cwd: checkout,
        markerRef: fixture.fixtureMarker,
        headRef: 'HEAD',
        baseRef: 'refs/remotes/origin/main',
        refreshBase: true,
        remote: remoteUrl,
        branch: 'main',
      })).toEqual({ outcome: 'pass', reason: 'head-adds-no-old-history' });

      const remoteKeys = git(checkout, 'config', '--local', '--name-only', '--get-regexp', '^remote\\.');
      expect(remoteKeys.split('\n').filter((key) => !key.startsWith('remote.origin.'))).toEqual([]);
      expect(remoteKeys).not.toContain('promisor');
      expect(fetchHead()).toBe(fetchHeadBefore);
      expect(git(checkout, 'rev-parse', '--is-shallow-repository')).toBe('true');
      const gitDirectory = resolve(checkout, git(checkout, 'rev-parse', '--git-dir'));
      const urlBytes = Buffer.from(remoteUrl);
      expect(filesUnder(gitDirectory).filter((path) => readFileSync(path).includes(urlBytes))).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it('decide senza toccare il checkout quando main è avanzato con blob grandi', () => {
    const fixture = rewrittenRemoteFixture();
    try {
      const checkout = fixture.shallowClone('main');
      git(fixture.remote, 'config', 'uploadpack.allowFilter', 'true');
      git(fixture.remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
      const baseBefore = git(checkout, 'rev-parse', 'refs/remotes/origin/main');
      const objectsBefore = git(checkout, 'count-objects', '-v');
      const fetchHeadBefore = (() => {
        try {
          return readFileSync(join(checkout, '.git', 'FETCH_HEAD'), 'utf8');
        } catch {
          return null;
        }
      })();
      const remoteKeysBefore = git(checkout, 'config', '--local', '--name-only', '--get-regexp', '^remote\\.');
      const shallowBefore = readFileSync(resolve(checkout, git(checkout, 'rev-parse', '--git-path', 'shallow')), 'utf8');
      const movedTip = fixture.advanceMainWithLargeBlobs();
      const scratchBefore = scratchDirectories();
      const trace: TraceEntry[] = [];

      expect(guardCall(checkout, fixture.fixtureMarker, trace)).toEqual({ outcome: 'pass', reason: 'head-adds-no-old-history' });
      expect(steps(trace)).toEqual(['remote-descends-from-base', 'bounded-proof']);
      expect(trace.at(-1)).toMatchObject({ step: 'bounded-proof', proven: true, addedCommits: 0 });
      // The scratch proof must leave the actions/checkout state untouched.
      expect(movedTip).not.toBe(baseBefore);
      expect(git(checkout, 'rev-parse', 'refs/remotes/origin/main')).toBe(baseBefore);
      expect(git(checkout, 'count-objects', '-v')).toBe(objectsBefore);
      expect((() => {
        try {
          return readFileSync(join(checkout, '.git', 'FETCH_HEAD'), 'utf8');
        } catch {
          return null;
        }
      })()).toBe(fetchHeadBefore);
      expect(git(checkout, 'config', '--local', '--name-only', '--get-regexp', '^remote\\.')).toBe(remoteKeysBefore);
      expect(readFileSync(resolve(checkout, git(checkout, 'rev-parse', '--git-path', 'shallow')), 'utf8')).toBe(shallowBefore);
      expect(git(checkout, 'rev-parse', '--is-shallow-repository')).toBe('true');
      expect(scratchDirectories()).toEqual(scratchBefore);
    } finally {
      fixture.cleanup();
    }
  });

  it('non scrive nel checkout quando git esporta GIT_DIR, come all’hook pre-push di un worktree collegato', () => {
    const fixture = rewrittenRemoteFixture();
    try {
      const checkout = fixture.shallowClone('main');
      git(fixture.remote, 'config', 'uploadpack.allowFilter', 'true');
      fixture.advanceMain(2);
      const gitDirectory = resolve(checkout, git(checkout, 'rev-parse', '--git-dir'));
      const state = () => ({
        refs: git(checkout, 'for-each-ref', '--format=%(refname) %(objectname)'),
        shallow: (() => {
          try {
            return readFileSync(join(gitDirectory, 'shallow'), 'utf8');
          } catch {
            return null;
          }
        })(),
        config: git(checkout, 'config', '--local', '--list'),
        objects: git(checkout, 'count-objects', '-v'),
      });
      const before = state();
      const scratchBefore = scratchDirectories();

      // What git 2.54 exports to a pre-push hook in a linked worktree, plus the
      // index a commit-time hook would see.
      const output = execFileSync(process.execPath, [
        GUARD_SCRIPT, '--head', 'HEAD', '--base', 'refs/remotes/origin/main', '--refresh-base', '--remote', 'origin', '--branch', 'main',
      ], {
        cwd: checkout,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_DIR: gitDirectory,
          GIT_INDEX_FILE: join(gitDirectory, 'index'),
          GIT_PREFIX: '',
        },
      });

      expect(output).toMatch(/\[discendenza del ramo remoto dal base: \d+\.\d s; prova limitata riuscita, 0 commit sopra il base\]/);
      // Without the detached environment the checkout gained refs/heads/remote
      // and a promisor remote with no URL, and lost its shallow boundary.
      expect(state()).toEqual(before);
      expect(scratchDirectories()).toEqual(scratchBefore);
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

  it('completa il fallback con un solo fetch filtrato e non salva il token remoto (issue 12320)', () => {
    const fixture = rewrittenRemoteFixture();
    try {
      // The run that the guard exists for: checked out before the rewrite,
      // still running (or re-run) after it.
      const checkout = fixture.shallowClone('old-branch');
      const oldBase = git(checkout, 'rev-parse', 'HEAD');
      git(checkout, 'update-ref', 'refs/remotes/origin/main', oldBase);
      const trace: TraceEntry[] = [];
      const credentialUrl = 'https://x-access-token:fixture-token@github.com/fixture/publisher.git';
      const credentiallessUrl = 'https://github.com/fixture/publisher.git';
      const rewrite = `file://${fixture.remote}`;

      const result = withGitConfigEnvironment([
        { key: `url.${rewrite}.insteadOf`, value: credentialUrl },
        { key: `url.${rewrite}.insteadOf`, value: credentiallessUrl },
      ], () => guardCall(checkout, fixture.fixtureMarker, trace, 'HEAD', credentialUrl));

      expect(result).toMatchObject({ outcome: 'blocked' });
      expect(steps(trace)).toEqual(['remote-descends-from-base', 'complete-shallow-history', 'bounded-proof']);
      expect(trace.find((entry) => entry.step === 'remote-descends-from-base')).toMatchObject({
        proven: false, why: 'base-not-in-remote-branch',
      });
      expect(trace.find((entry) => entry.step === 'complete-shallow-history')?.failed).toBeUndefined();
      expect(trace.find((entry) => entry.step === 'bounded-proof')).toMatchObject({
        proven: false, why: 'marker-among-added-commits',
      });
      expect(git(checkout, 'rev-parse', '--is-shallow-repository')).toBe('false');
      const gitDirectory = resolve(checkout, git(checkout, 'rev-parse', '--git-dir'));
      const token = Buffer.from('fixture-token');
      expect(filesUnder(gitDirectory).filter((file) => readFileSync(file).includes(token))).toEqual([]);
      expect(git(checkout, 'config', '--local', '--list')).toContain(credentiallessUrl);
    } finally {
      fixture.cleanup();
    }
  });

  it('completa la prova storica col commit acquisito se la stable ref viene eliminata dopo il merge', () => {
    const fixture = rewrittenRemoteFixture();
    const branch = 'chore/sync-articles-sitemaps';
    try {
      const stableHead = git(fixture.remote, 'rev-parse', 'refs/heads/old-branch');
      git(fixture.seed, 'push', '--quiet', fixture.remote, `${stableHead}:refs/heads/${branch}`);
      const checkout = fixture.shallowClone('main');
      const headRef = `refs/remotes/refresh/${branch}`;
      git(checkout, 'fetch', '--quiet', '--no-tags', '--depth=1', 'origin', `+refs/heads/${branch}:${headRef}`);
      expect(git(checkout, 'rev-parse', headRef)).toBe(stableHead);

      // A merged PR deletes the stable branch, while GitHub still serves its
      // captured head commit through the pull request's retained head ref.
      git(fixture.remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
      git(fixture.remote, 'config', 'uploadpack.hideRefs', 'refs/pull');
      git(fixture.remote, 'update-ref', 'refs/pull/42/head', stableHead);
      git(fixture.remote, 'update-ref', '-d', `refs/heads/${branch}`);
      expect(() => git(fixture.remote, 'rev-parse', `refs/heads/${branch}`)).toThrow();

      const trace: TraceEntry[] = [];
      const result = withEnvironment({ GH_TOKEN: '', GITHUB_TOKEN: '' }, () => checkOldHistory({
        cwd: checkout,
        markerRef: fixture.fixtureMarker,
        headRef,
        baseRef: 'refs/remotes/origin/main',
        refreshBase: true,
        remote: 'origin',
        branch: 'main',
        trace,
      }));

      expect(result).toMatchObject({ outcome: 'blocked' });
      expect(steps(trace)).toEqual([
        'remote-descends-from-base',
        'bounded-proof',
        'complete-shallow-history',
        'bounded-proof',
      ]);
      expect(steps(trace)).not.toContain('fetch-marker');
      expect(trace.find((entry) => entry.step === 'complete-shallow-history')?.failed).toBeUndefined();
      expect(git(checkout, 'rev-parse', '--is-shallow-repository')).toBe('false');
      expect(git(checkout, 'rev-parse', headRef)).toBe(stableHead);
    } finally {
      fixture.cleanup();
    }
  });

  it('usa compare remoto per bloccare la storia riscritta senza scaricare il grafo né salvare il token', () => {
    const fixture = rewrittenRemoteFixture();
    try {
      const checkout = fixture.shallowClone('old-branch');
      const oldBase = git(checkout, 'rev-parse', 'HEAD');
      git(checkout, 'update-ref', 'refs/remotes/origin/main', oldBase);
      const trace: TraceEntry[] = [];
      const remote = 'https://x-access-token:fixture-token@github.com/fixture/publisher.git';
      const github = mockGithubCli(fixture.root, ['diverged', 'ahead']);

      const result = withEnvironment({
        GH_TOKEN: 'fixture-token',
        GITHUB_REPOSITORY: 'fixture/publisher',
        GH_COMPARE_STATUSES: github.statuses,
        GH_COMPARE_CALL_LOG: github.log,
        PATH: `${github.bin}:${process.env.PATH || ''}`,
      }, () => guardCall(checkout, fixture.fixtureMarker, trace, 'HEAD', remote));

      expect(result).toMatchObject({ outcome: 'blocked' });
      expect(steps(trace)).toEqual(['github-compare']);
      expect(trace[0]).toMatchObject({ step: 'github-compare', verdict: 'blocked' });
      expect(trace[0].ms).toBeLessThan(5_000);
      const head = git(checkout, 'rev-parse', 'HEAD');
      const calls = readFileSync(github.log, 'utf8').trim().split('\n');
      expect(calls).toEqual([
        `api repos/fixture/publisher/compare/${fixture.fixtureMarker}...main --jq .status`,
        `api repos/fixture/publisher/compare/${fixture.fixtureMarker}...${head} --jq .status`,
      ]);
      expect(git(checkout, 'rev-parse', '--is-shallow-repository')).toBe('true');
      const gitDirectory = resolve(checkout, git(checkout, 'rev-parse', '--git-dir'));
      const token = Buffer.from('fixture-token');
      expect(filesUnder(gitDirectory).filter((file) => readFileSync(file).includes(token))).toEqual([]);
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

      // No such branch on the remote and no marker: the combined graph fetch
      // cannot conclude, then the missing-marker path preserves the prior
      // fail-open result.
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
      expect(trace[0]).toMatchObject({ step: 'remote-descends-from-base', proven: false, why: 'base-not-in-remote-branch' });
      expect(steps(trace)).toEqual(['remote-descends-from-base', 'complete-shallow-history', 'fetch-marker']);
      expect(trace[1].failed).toBeUndefined();
    } finally {
      fixture.cleanup();
    }
  });

  it('ricade senza eccezione quando il remoto è irraggiungibile e pulisce lo scratch', () => {
    const fixture = rewrittenRemoteFixture();
    try {
      const checkout = fixture.shallowClone('main');
      const missingRemote = `file://${join(fixture.root, 'missing.git')}`;
      const scratchBefore = scratchDirectories();
      const trace: TraceEntry[] = [];

      let result;
      expect(() => {
        result = checkOldHistory({
          cwd: checkout,
          markerRef: '0'.repeat(40),
          headRef: 'HEAD',
          baseRef: 'refs/remotes/origin/main',
          refreshBase: true,
          remote: missingRemote,
          branch: 'main',
          trace,
        });
      }).not.toThrow();
      expect(result).toEqual({ outcome: 'pass', reason: 'marker-unavailable' });
      expect(trace[0]).toMatchObject({ step: 'remote-descends-from-base', proven: false, why: 'remote-descent-unverified' });
      expect(scratchDirectories()).toEqual(scratchBefore);
      expect(git(checkout, 'rev-parse', '--is-shallow-repository')).toBe('true');
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

      expect(output).toMatch(/controllo superato senza scaricare il grafo\. \[discendenza del ramo remoto dal base: \d+\.\d s; prova limitata riuscita, 0 commit sopra il base\]/);
      expect(describeTrace([
        { step: 'refresh-base', ms: 900 },
        { step: 'bounded-proof', proven: false, why: 'added-commit-on-shallow-boundary' },
        { step: 'complete-shallow-history', ms: 61_600 },
      ])).toBe(' [aggiornamento del base: 0.9 s; prova limitata non conclusiva: added-commit-on-shallow-boundary; completamento del grafo della storia: 61.6 s]');
      expect(describeTrace([{ step: 'complete-shallow-history', ms: 300_000, failed: true }]))
        .toBe(' [completamento del grafo della storia: non riuscito dopo 300.0 s]');
      expect(describeTrace([{ step: 'remote-descends-from-base', ms: 100, proven: false, why: 'base-not-in-remote-branch' }]))
        .toBe(' [discendenza del ramo remoto dal base: non conclusiva: base-not-in-remote-branch dopo 0.1 s]');
      expect(describeTrace([])).toBe('');
    } finally {
      fixture.cleanup();
    }
  });
});
