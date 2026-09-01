import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEmptyTranslationMemoryV2,
  recordTranslationCandidateV2,
} from '../scripts/lib/content-addressed-translation-memory-v2.mjs';
import {
  createJobTranslationUnitIdentityV2,
  createTranslationDerivedPatchV2,
} from '../scripts/lib/translation-derived-patch-v2.mjs';
import {
  createTranslationStateStoreV2,
  MAX_TRANSLATION_STATE_ARTIFACT_BYTES_V2,
  validateTranslationSlicePathV2,
} from '../scripts/lib/translation-state-store-v2.mjs';
import { digestTranslationDocumentV2 } from '../scripts/lib/translation-unit-identity-v2.mjs';

const roots: string[] = [];
const SLICE_PATH = 'data/jobs/by-crawler/example-crawler.json';
const JOB = {
  url: 'https://jobs.example.test/positions/123456/',
  slug: 'senior-entwicklerin',
  title: 'Senior Entwicklerin',
  description: 'Eine vielseitige Aufgabe',
  sourceLang: 'de',
  company: 'Example AG',
  location: 'Zürich',
  titleByLocale: { de: 'Senior Entwicklerin', it: '' },
};

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createRepositories() {
  const root = mkdtempSync(join(tmpdir(), 'translation-state-store-v2-test-'));
  roots.push(root);
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  git(root, 'init', '-q', '--bare', '--initial-branch=main', remote);
  git(root, 'init', '-q', '--initial-branch=main', seed);
  git(seed, 'config', 'user.name', 'Translation State Test');
  git(seed, 'config', 'user.email', 'translation-state-test@example.test');
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  git(seed, 'add', 'README.md');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  const one = join(root, 'one');
  const two = join(root, 'two');
  git(root, 'clone', '-q', remote, one);
  git(root, 'clone', '-q', remote, two);
  for (const repo of [one, two]) {
    git(repo, 'config', 'user.name', 'Translation State Test');
    git(repo, 'config', 'user.email', 'translation-state-test@example.test');
  }
  return { remote, one, two };
}

function patchFor(job = JOB, outputText = 'Sviluppatrice senior') {
  const identity = createJobTranslationUnitIdentityV2(job, {
    fieldPath: 'title',
    targetLocale: 'it',
  });
  const memory = recordTranslationCandidateV2(createEmptyTranslationMemoryV2(), {
    identity,
    engineVersion: 'engine-2',
    gateVersion: 'gate-3',
    outputText,
    status: 'validated',
    evidence: [],
  });
  return createTranslationDerivedPatchV2({
    crawlerKey: 'example-crawler',
    job,
    fieldPath: 'title',
    targetLocale: 'it',
    candidate: memory.records[0].candidates[0],
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('translation state store v2', () => {
  it('initializes an isolated state ref and rejects main, traversal and expired paths', async () => {
    const { remote, one } = createRepositories();
    const store = createTranslationStateStoreV2({ repository: one });
    const initialized = await store.initialize();

    expect(git(one, 'ls-remote', '--refs', 'origin', store.ref)).toContain(initialized.commit);
    expect(git(one, 'ls-tree', '-r', '--name-only', initialized.commit)).toBe('v2/schema.json');
    expect(git(one, 'ls-remote', '--refs', 'origin', 'refs/heads/main')).not.toContain(initialized.commit);
    expect(() => createTranslationStateStoreV2({ repository: one, ref: 'refs/heads/main' })).toThrow(/dedicated/);
    git(one, 'push', '-q', 'origin', 'origin/main:refs/heads/translation-state-invalid-v2');
    const invalid = createTranslationStateStoreV2({
      repository: one,
      ref: 'refs/heads/translation-state-invalid-v2',
    });
    await expect(invalid.initialize()).rejects.toThrow(/outside v2/);
    expect(() => validateTranslationSlicePathV2('../data/jobs/by-crawler/a.json')).toThrow(/slicePath/);
    expect(() => validateTranslationSlicePathV2('data/jobs/expired/a.json')).toThrow(/slicePath/);
    expect(remote).toContain('remote.git');
  });

  it('checks state tip currency with one ls-remote and no history materialization', async () => {
    const { one, two } = createRepositories();
    const first = createTranslationStateStoreV2({ repository: one });
    await first.initialize();
    const original = await first.checkpointBatch({ slicePath: SLICE_PATH, patches: [patchFor()] });
    const trace: string[][] = [];
    const tracedGit = async (args: string[]) => {
      trace.push([...args]);
      try {
        return { code: 0, stdout: execFileSync('git', args, { cwd: one, encoding: 'utf8' }), stderr: '' };
      } catch (error: any) {
        return {
          code: typeof error?.status === 'number' ? error.status : 1,
          stdout: error?.stdout ?? '',
          stderr: error?.stderr ?? String(error),
        };
      }
    };
    const checker = createTranslationStateStoreV2({ repository: one, git: tracedGit });
    const secondJob = {
      ...JOB,
      url: 'https://jobs.example.test/positions/222222/',
      slug: 'zweite-stelle',
      title: 'Zweite Stelle',
      titleByLocale: { de: 'Zweite Stelle', it: '' },
    };
    const moved = await createTranslationStateStoreV2({ repository: two }).checkpointBatch({
      slicePath: SLICE_PATH,
      patches: [patchFor(secondJob, 'Seconda posizione')],
    });

    trace.length = 0;
    expect(await checker.isCurrentCommit(original.commit)).toBe(false);
    expect(trace).toEqual([['ls-remote', '--refs', 'origin', first.ref]]);
    trace.length = 0;
    expect(await checker.isCurrentCommit(moved.commit)).toBe(true);
    expect(trace).toEqual([['ls-remote', '--refs', 'origin', first.ref]]);
    await expect(checker.isCurrentCommit('not-a-sha')).rejects.toThrow(/expected commit/);
  });

  it('rejects an intermediate merge even when the state tip has one parent', async () => {
    const { one } = createRepositories();
    const initialized = await createTranslationStateStoreV2({ repository: one }).initialize();
    mkdirSync(join(one, 'v2'), { recursive: true });
    git(one, 'checkout', '-q', '-B', 'state-left', initialized.commit);
    writeFileSync(join(one, 'v2', 'left.json'), '{}\n');
    git(one, 'add', 'v2/left.json');
    git(one, 'commit', '-q', '-m', 'state left');
    git(one, 'checkout', '-q', '-B', 'state-right', initialized.commit);
    writeFileSync(join(one, 'v2', 'right.json'), '{}\n');
    git(one, 'add', 'v2/right.json');
    git(one, 'commit', '-q', '-m', 'state right');
    git(one, 'checkout', '-q', 'state-left');
    git(one, 'merge', '-q', '--no-ff', 'state-right', '-m', 'merge state histories');
    writeFileSync(join(one, 'v2', 'after-merge.json'), '{}\n');
    git(one, 'add', 'v2/after-merge.json');
    git(one, 'commit', '-q', '-m', 'single-parent tip');
    const ref = 'refs/heads/translation-state-merge-history-v2';
    git(one, 'push', '-q', 'origin', `HEAD:${ref}`);

    const store = createTranslationStateStoreV2({ repository: one, ref });
    await expect(store.initialize()).rejects.toThrow(/single-parent/);
  });

  it('rejects an intermediate outside-v2 path even when the tip removes it', async () => {
    const { one } = createRepositories();
    const initialized = await createTranslationStateStoreV2({ repository: one }).initialize();
    git(one, 'checkout', '-q', '-B', 'state-outside-history', initialized.commit);
    writeFileSync(join(one, 'outside-state.txt'), 'must never enter the state ref\n');
    git(one, 'add', 'outside-state.txt');
    git(one, 'commit', '-q', '-m', 'contaminate state history');
    git(one, 'rm', '-q', 'outside-state.txt');
    git(one, 'commit', '-q', '-m', 'hide state contamination');
    const ref = 'refs/heads/translation-state-outside-history-v2';
    git(one, 'push', '-q', 'origin', `HEAD:${ref}`);

    const store = createTranslationStateStoreV2({ repository: one, ref });
    await expect(store.initialize()).rejects.toThrow(/history contains paths outside v2/);
  });

  it('audits a long fresh-process lineage with bounded witness output', async () => {
    const { one } = createRepositories();
    const initialized = await createTranslationStateStoreV2({ repository: one }).initialize();
    git(one, 'checkout', '-q', '-B', 'long-state-history', initialized.commit);
    for (let index = 0; index < 80; index += 1) {
      const path = join(one, 'v2', 'linear', `${String(index).padStart(3, '0')}.json`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ index })}\n`);
      git(one, 'add', path);
      git(one, 'commit', '-q', '-m', `linear state ${index}`);
    }
    const tip = git(one, 'rev-parse', 'HEAD');
    git(one, 'push', '-q', 'origin', 'HEAD:refs/heads/translation-state-v2');
    const trace: Array<{ args: string[]; stdoutBytes: number }> = [];
    const tracedGit = async (args: string[], options: any = {}) => {
      try {
        const stdout = execFileSync('git', args, {
          cwd: one,
          encoding: 'utf8',
          env: options.env ? { ...process.env, ...options.env } : process.env,
        });
        trace.push({ args: [...args], stdoutBytes: Buffer.byteLength(stdout) });
        return { code: 0, stdout, stderr: '' };
      } catch (error: any) {
        const stdout = error?.stdout ?? '';
        trace.push({ args: [...args], stdoutBytes: Buffer.byteLength(stdout) });
        return {
          code: typeof error?.status === 'number' ? error.status : 1,
          stdout,
          stderr: error?.stderr ?? String(error),
        };
      }
    };

    await createTranslationStateStoreV2({ repository: one, git: tracedGit }).initialize();
    const witnesses = trace.filter(({ args }) => args[0] === 'rev-list' || args[0] === 'log');
    expect(witnesses).toHaveLength(2);
    expect(witnesses[0]).toEqual({
      args: ['rev-list', '--min-parents=2', '--max-count=1', '--parents', `${initialized.commit}..${tip}`],
      stdoutBytes: 0,
    });
    expect(witnesses[1].args).toEqual([
      'log', '-1', '--format=', '--name-only', '-z', '--no-renames', `${initialized.commit}..${tip}`,
      '--', '.', ':(exclude)v2/**',
    ]);
    expect(witnesses[1].stdoutBytes).toBe(0);
  });

  it('physically truncates deterministic pending scans with more than 250 indexed entries', async () => {
    const { one } = createRepositories();
    const scans: any[] = [];
    const store = createTranslationStateStoreV2({
      repository: one,
      onStage: async (stage: string, details: any) => {
        if (stage === 'afterStatePathScan' && details.prefix?.startsWith('v2/queue/by-crawler/')) scans.push(details);
      },
    });
    const otherJob = {
      ...JOB,
      url: 'https://jobs.example.test/positions/333333/',
      slug: 'dritte-stelle',
      title: 'Dritte Stelle',
      titleByLocale: { de: 'Dritte Stelle', it: '' },
    };
    const patches = [patchFor(), patchFor(otherJob, 'Terza posizione')];
    await store.initialize();
    const checkpoint = await store.checkpointBatch({ slicePath: SLICE_PATH, patches });
    const firstIndexPath = git(one, 'ls-tree', '-r', '--name-only', checkpoint.commit)
      .split('\n')
      .find((path) => path.startsWith('v2/queue/by-crawler/'));
    expect(firstIndexPath).toBeDefined();
    const crawlerPrefix = firstIndexPath!.split('/').slice(0, 5).join('/');
    git(one, 'checkout', '-q', '-B', 'large-indexed-queue-state', checkpoint.commit);
    for (let index = 0; index < 251; index += 1) {
      const path = join(one, crawlerPrefix, 'zz', `${String(index).padStart(3, '0')}.json`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{}\n');
    }
    git(one, 'add', join(one, crawlerPrefix, 'zz'));
    git(one, 'commit', '-q', '-m', 'add later malformed queue index entries');
    git(one, 'push', '-q', 'origin', 'HEAD:refs/heads/translation-state-v2');
    scans.length = 0;
    const pending = await store.listPending({ crawlerKey: 'example-crawler', limit: 1 });

    expect(pending.pending.map((entry) => entry.patch.patchHash))
      .toEqual(patches.map((patch) => patch.patchHash).sort().slice(0, 1));
    expect(scans).toEqual([expect.objectContaining({
      limit: 1,
      mode: 'truncate',
      count: 1,
      stopped: true,
    })]);
  });

  it('checkpoints immutable sharded artifacts and atomically acks lifecycle plus queue removal', async () => {
    const { one } = createRepositories();
    const store = createTranslationStateStoreV2({ repository: one });
    const patch = patchFor();
    await store.initialize();
    const checkpoint = await store.checkpointBatch({ slicePath: SLICE_PATH, patches: [patch] });
    const pending = await store.listPending({ crawlerKey: 'example-crawler' });
    const queuedState = await store.readAcknowledgments([patch.patchHash]);
    const queuedCommitIsCurrent = await store.isCurrentCommit(checkpoint.commit);

    expect(pending.pending).toHaveLength(1);
    expect(pending.pending[0].patch).toEqual(patch);
    expect(queuedState).toMatchObject({
      commit: checkpoint.commit,
      acknowledgments: [null],
      queued: [true],
    });
    expect(queuedCommitIsCurrent).toBe(true);
    const paths = git(one, 'ls-tree', '-r', '--name-only', checkpoint.commit).split('\n');
    expect(paths.some((path) => path.startsWith(`v2/patches/${patch.patchHash.slice(0, 2)}/`))).toBe(true);
    expect(paths.some((path) => path.startsWith('v2/memory/'))).toBe(true);
    expect(paths.filter((path) => path.startsWith('v2/journal/'))).toHaveLength(4);
    expect(paths.some((path) => path.startsWith('v2/queue/'))).toBe(true);
    expect(paths.some((path) => path.startsWith('v2/queue/by-crawler/'))).toBe(true);

    const ack = await store.acknowledgeBatch([{
      patch,
      slicePath: SLICE_PATH,
      outcome: 'already_valid',
      mainCommit: git(one, 'rev-parse', 'origin/main'),
      publishedCommit: null,
      intentHash: null,
    }]);
    expect((await store.listPending({ crawlerKey: 'example-crawler' })).pending).toHaveLength(0);
    const acknowledgedState = await store.readAcknowledgments([patch.patchHash]);
    expect(acknowledgedState.commit).toBe(ack.commit);
    expect(acknowledgedState.queued).toEqual([false]);
    expect(acknowledgedState.acknowledgments[0].outcome).toBe('already_valid');

    const changed = git(one, 'diff-tree', '--no-commit-id', '--name-status', '-r', `${ack.commit}^`, ack.commit);
    expect(changed).toMatch(/^A\s+v2\/acks\//m);
    expect(changed).toMatch(/^A\s+v2\/journal\//m);
    expect(changed).toMatch(/^D\s+v2\/queue\//m);
    expect(changed).toMatch(/^D\s+v2\/queue\/by-crawler\//m);

    const firstReceipt = (await store.readAcknowledgment(patch.patchHash)).acknowledgment;
    const requeue = await store.checkpointBatch({ slicePath: SLICE_PATH, patches: [patch], requeue: true });
    expect((await store.listPending({ crawlerKey: 'example-crawler' })).pending).toHaveLength(1);
    const requeuedState = await store.readAcknowledgments([patch.patchHash]);
    expect(requeuedState.commit).toBe(requeue.commit);
    expect(requeuedState.queued).toEqual([true]);
    expect(requeuedState.acknowledgments[0].ackHash).toBe(firstReceipt.ackHash);
    await store.acknowledgeBatch([{
      patch,
      slicePath: SLICE_PATH,
      outcome: 'already_valid',
      mainCommit: git(one, 'rev-parse', 'origin/main'),
      publishedCommit: null,
      intentHash: null,
    }]);
    const latest = await store.readAcknowledgment(patch.patchHash);
    expect(latest.acknowledgment.outcome).toBe('already_valid');
    expect(latest.acknowledgment.lifecycleSequence).toBeGreaterThan(firstReceipt.lifecycleSequence);
    expect(git(one, 'ls-tree', '-r', '--name-only', latest.commit, '--', `v2/acks/${patch.patchHash.slice(0, 2)}/${patch.patchHash}`)
      .split('\n')).toHaveLength(2);
  });

  it.each([
    ['canonical queue', 'v2/queue/by-patch/'],
    ['crawler index', 'v2/queue/by-crawler/'],
  ])('fails closed when the %s is orphaned', async (_label, prefix) => {
    const { one } = createRepositories();
    const store = createTranslationStateStoreV2({ repository: one });
    const patch = patchFor();
    await store.initialize();
    const checkpoint = await store.checkpointBatch({ slicePath: SLICE_PATH, patches: [patch] });
    const queuePath = git(one, 'ls-tree', '-r', '--name-only', checkpoint.commit)
      .split('\n')
      .find((path) => path.startsWith(prefix));
    expect(queuePath).toBeDefined();

    git(one, 'checkout', '-q', '-B', 'tampered-state', checkpoint.commit);
    git(one, 'rm', '-q', queuePath!);
    git(one, 'commit', '-q', '-m', 'remove queue without lifecycle transition');
    git(one, 'push', '-q', 'origin', 'HEAD:refs/heads/translation-state-v2');

    const fresh = createTranslationStateStoreV2({ repository: one });
    await expect(fresh.readAcknowledgment(patch.patchHash)).rejects.toThrow(/canonical queue and crawler index disagree/);
  });

  it.each([
    ['applied acknowledgment without provenance', (receipt: any) => {
      receipt.outcome = 'applied';
      receipt.publishedCommit = null;
      receipt.intentHash = null;
    }, /requires publish provenance/],
    ['acknowledgment with partial provenance', (receipt: any, mainCommit: string) => {
      receipt.publishedCommit = mainCommit;
      receipt.intentHash = null;
    }, /both be present or absent/],
    ['acknowledgment with a missing publish intent', (receipt: any, mainCommit: string) => {
      receipt.publishedCommit = mainCommit;
      receipt.intentHash = 'f'.repeat(64);
    }, /publish intent pointer/],
  ])('fails closed on a tampered %s', async (_label, mutate, expectedError) => {
    const { one } = createRepositories();
    const store = createTranslationStateStoreV2({ repository: one });
    const patch = patchFor();
    await store.initialize();
    await store.checkpointBatch({ slicePath: SLICE_PATH, patches: [patch] });
    const acknowledged = await store.acknowledgeBatch([{
      patch,
      slicePath: SLICE_PATH,
      outcome: 'already_valid',
      mainCommit: git(one, 'rev-parse', 'origin/main'),
      publishedCommit: null,
      intentHash: null,
    }]);
    const ackPath = git(one, 'ls-tree', '-r', '--name-only', acknowledged.commit)
      .split('\n')
      .find((path) => path.startsWith(`v2/acks/${patch.patchHash.slice(0, 2)}/${patch.patchHash}/`));
    expect(ackPath).toBeDefined();
    const receipt = JSON.parse(git(one, 'show', `${acknowledged.commit}:${ackPath}`));
    mutate(receipt, git(one, 'rev-parse', 'origin/main'));
    const { ackHash: priorHash, ...payload } = receipt;
    receipt.ackHash = digestTranslationDocumentV2(payload);
    const replacementPath = `${ackPath!.slice(0, ackPath!.lastIndexOf('/') + 1)}${receipt.ackHash}.json`;

    git(one, 'checkout', '-q', '-B', 'tampered-ack-state', acknowledged.commit);
    git(one, 'rm', '-q', ackPath!);
    mkdirSync(dirname(join(one, replacementPath)), { recursive: true });
    writeFileSync(join(one, replacementPath), `${JSON.stringify(receipt)}\n`);
    git(one, 'add', replacementPath);
    git(one, 'commit', '-q', '-m', `tamper acknowledgment ${priorHash}`);
    git(one, 'push', '-q', 'origin', 'HEAD:refs/heads/translation-state-v2');

    const fresh = createTranslationStateStoreV2({ repository: one });
    await expect(fresh.readAcknowledgment(patch.patchHash)).rejects.toThrow(expectedError);
  });

  it('validates acknowledgment provenance against the indexed intent on the same state tip', async () => {
    const { one } = createRepositories();
    const store = createTranslationStateStoreV2({ repository: one });
    const patch = patchFor();
    await store.initialize();
    await store.checkpointBatch({ slicePath: SLICE_PATH, patches: [patch] });
    const mainCommit = git(one, 'rev-parse', 'origin/main');
    const recorded = await store.recordIntent({
      patches: [patch],
      slicePath: SLICE_PATH,
      outcomes: ['applied'],
      expectedMain: mainCommit,
      proposedCommit: mainCommit,
      expectedSliceBlob: '1'.repeat(40),
    });
    const acknowledged = await store.acknowledgeBatch([{
      patch,
      slicePath: SLICE_PATH,
      outcome: 'applied',
      mainCommit,
      publishedCommit: mainCommit,
      intentHash: recorded.intent.intentHash,
    }]);
    const valid = await store.readAcknowledgment(patch.patchHash);
    expect(valid.acknowledgment).toMatchObject({
      publishedCommit: mainCommit,
      intentHash: recorded.intent.intentHash,
    });

    const ackPath = git(one, 'ls-tree', '-r', '--name-only', acknowledged.commit)
      .split('\n')
      .find((path) => path.startsWith(`v2/acks/${patch.patchHash.slice(0, 2)}/${patch.patchHash}/`));
    expect(ackPath).toBeDefined();
    const receipt = JSON.parse(git(one, 'show', `${acknowledged.commit}:${ackPath}`));
    receipt.publishedCommit = '2'.repeat(40);
    const { ackHash: priorHash, ...payload } = receipt;
    receipt.ackHash = digestTranslationDocumentV2(payload);
    const replacementPath = `${ackPath!.slice(0, ackPath!.lastIndexOf('/') + 1)}${receipt.ackHash}.json`;

    git(one, 'checkout', '-q', '-B', 'tampered-intent-ack-state', acknowledged.commit);
    git(one, 'rm', '-q', ackPath!);
    mkdirSync(dirname(join(one, replacementPath)), { recursive: true });
    writeFileSync(join(one, replacementPath), `${JSON.stringify(receipt)}\n`);
    git(one, 'add', replacementPath);
    git(one, 'commit', '-q', '-m', `tamper acknowledgment intent ${priorHash}`);
    git(one, 'push', '-q', 'origin', 'HEAD:refs/heads/translation-state-v2');

    const fresh = createTranslationStateStoreV2({ repository: one });
    await expect(fresh.readAcknowledgment(patch.patchHash)).rejects.toThrow(/does not match its publish intent/);
  });

  it('fails closed when a descendant state commit deletes an acknowledged patch', async () => {
    const { one } = createRepositories();
    const store = createTranslationStateStoreV2({ repository: one });
    const patch = patchFor();
    await store.initialize();
    await store.checkpointBatch({ slicePath: SLICE_PATH, patches: [patch] });
    const acknowledged = await store.acknowledgeBatch([{
      patch,
      slicePath: SLICE_PATH,
      outcome: 'already_valid',
      mainCommit: git(one, 'rev-parse', 'origin/main'),
      publishedCommit: null,
      intentHash: null,
    }]);
    const storedPatchPath = `v2/patches/${patch.patchHash.slice(0, 2)}/${patch.patchHash}.json`;
    git(one, 'checkout', '-q', '-B', 'deleted-ack-patch-state', acknowledged.commit);
    git(one, 'rm', '-q', storedPatchPath);
    git(one, 'commit', '-q', '-m', 'delete acknowledged patch');
    git(one, 'push', '-q', 'origin', 'HEAD:refs/heads/translation-state-v2');

    const fresh = createTranslationStateStoreV2({ repository: one });
    await expect(fresh.readAcknowledgment(patch.patchHash)).rejects.toThrow(/requires its stored patch/);
  });

  it('fails closed when a descendant state commit leaves a queue without its patch', async () => {
    const { one } = createRepositories();
    const store = createTranslationStateStoreV2({ repository: one });
    const patch = patchFor();
    await store.initialize();
    const checkpoint = await store.checkpointBatch({ slicePath: SLICE_PATH, patches: [patch] });
    const storedPatchPath = `v2/patches/${patch.patchHash.slice(0, 2)}/${patch.patchHash}.json`;
    git(one, 'checkout', '-q', '-B', 'deleted-queued-patch-state', checkpoint.commit);
    git(one, 'rm', '-q', storedPatchPath);
    git(one, 'commit', '-q', '-m', 'delete queued patch');
    git(one, 'push', '-q', 'origin', 'HEAD:refs/heads/translation-state-v2');

    const fresh = createTranslationStateStoreV2({ repository: one });
    await expect(fresh.readAcknowledgment(patch.patchHash)).rejects.toThrow(/queue requires its stored patch/);
  });

  it('checks an absent arbitrary patch without scanning the queue index', async () => {
    const { one } = createRepositories();
    const scans: any[] = [];
    const store = createTranslationStateStoreV2({
      repository: one,
      onStage: async (stage: string, details: any) => {
        if (stage === 'afterStatePathScan') scans.push(details);
      },
    });
    await store.initialize();
    await store.checkpointBatch({ slicePath: SLICE_PATH, patches: [patchFor()] });
    scans.length = 0;
    const missing = await store.readAcknowledgment('f'.repeat(64));

    expect(missing).toMatchObject({ acknowledgment: null, queued: false });
    expect(scans.some((scan) => scan.prefix?.startsWith('v2/queue'))).toBe(false);
    expect(scans).toEqual([expect.objectContaining({ prefix: `v2/acks/${'f'.repeat(2)}/${'f'.repeat(64)}` })]);
  });

  it('fails closed when an acknowledgment identity disagrees with its stored patch', async () => {
    const { one } = createRepositories();
    const store = createTranslationStateStoreV2({ repository: one });
    const patch = patchFor();
    await store.initialize();
    await store.checkpointBatch({ slicePath: SLICE_PATH, patches: [patch] });
    const acknowledged = await store.acknowledgeBatch([{
      patch,
      slicePath: SLICE_PATH,
      outcome: 'already_valid',
      mainCommit: git(one, 'rev-parse', 'origin/main'),
      publishedCommit: null,
      intentHash: null,
    }]);
    const ackPath = git(one, 'ls-tree', '-r', '--name-only', acknowledged.commit)
      .split('\n')
      .find((path) => path.startsWith(`v2/acks/${patch.patchHash.slice(0, 2)}/${patch.patchHash}/`));
    expect(ackPath).toBeDefined();
    const receipt = JSON.parse(git(one, 'show', `${acknowledged.commit}:${ackPath}`));
    receipt.crawlerKey = 'tampered-crawler';
    const { ackHash: priorHash, ...payload } = receipt;
    receipt.ackHash = digestTranslationDocumentV2(payload);
    const replacementPath = `${ackPath!.slice(0, ackPath!.lastIndexOf('/') + 1)}${receipt.ackHash}.json`;
    git(one, 'checkout', '-q', '-B', 'mismatched-ack-patch-state', acknowledged.commit);
    git(one, 'rm', '-q', ackPath!);
    mkdirSync(dirname(join(one, replacementPath)), { recursive: true });
    writeFileSync(join(one, replacementPath), `${JSON.stringify(receipt)}\n`);
    git(one, 'add', replacementPath);
    git(one, 'commit', '-q', '-m', `mismatch acknowledgment patch ${priorHash}`);
    git(one, 'push', '-q', 'origin', 'HEAD:refs/heads/translation-state-v2');

    const fresh = createTranslationStateStoreV2({ repository: one });
    await expect(fresh.readAcknowledgment(patch.patchHash)).rejects.toThrow(/does not match its stored patch/);
  });

  it('stops strict acknowledgment scans at one over the lifecycle budget', async () => {
    const { one } = createRepositories();
    const store = createTranslationStateStoreV2({ repository: one });
    const patch = patchFor();
    await store.initialize();
    await store.checkpointBatch({ slicePath: SLICE_PATH, patches: [patch] });
    const acknowledged = await store.acknowledgeBatch([{
      patch,
      slicePath: SLICE_PATH,
      outcome: 'already_valid',
      mainCommit: git(one, 'rev-parse', 'origin/main'),
      publishedCommit: null,
      intentHash: null,
    }]);
    const directory = join(one, 'v2', 'acks', patch.patchHash.slice(0, 2), patch.patchHash);
    git(one, 'checkout', '-q', '-B', 'overflow-ack-state', acknowledged.commit);
    mkdirSync(directory, { recursive: true });
    for (let index = 0; index < 64; index += 1) {
      writeFileSync(join(directory, `${index.toString(16).padStart(64, '0')}.json`), '{}\n');
    }
    git(one, 'add', directory);
    git(one, 'commit', '-q', '-m', 'overflow acknowledgment directory');
    git(one, 'push', '-q', 'origin', 'HEAD:refs/heads/translation-state-v2');
    const scans: any[] = [];
    const fresh = createTranslationStateStoreV2({
      repository: one,
      onStage: async (stage: string, details: any) => {
        if (stage === 'afterStatePathScan' && details.prefix?.startsWith('v2/acks/')) scans.push(details);
      },
    });

    await expect(fresh.readAcknowledgment(patch.patchHash)).rejects.toThrow(/exceeds the bounded count/);
    expect(scans).toEqual([expect.objectContaining({
      limit: 64,
      mode: 'strict',
      count: 65,
      stopped: true,
    })]);
  });

  it('rebuilds a losing CAS transaction from the winning state without dropping either patch', async () => {
    const { one, two } = createRepositories();
    await createTranslationStateStoreV2({ repository: one }).initialize();
    let arrivals = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    const onStage = async (stage: string, details: any) => {
      if (stage !== 'beforeStatePush' || details.message !== 'translation-state-v2: checkpoint batch'
        || details.attempt !== 1) return;
      arrivals += 1;
      if (arrivals === 2) releaseBarrier();
      await barrier;
    };
    const first = createTranslationStateStoreV2({ repository: one, onStage });
    const second = createTranslationStateStoreV2({ repository: two, onStage });
    const otherJob = {
      ...JOB,
      url: 'https://jobs.example.test/positions/654321/',
      slug: 'leiterin-entwicklung',
      title: 'Leiterin Entwicklung',
      titleByLocale: { de: 'Leiterin Entwicklung', it: '' },
    };
    const firstPatch = patchFor();
    const secondPatch = patchFor(otherJob, 'Responsabile sviluppo');

    const outcomes = await Promise.all([
      first.checkpointBatch({ slicePath: SLICE_PATH, patches: [firstPatch] }),
      second.checkpointBatch({ slicePath: SLICE_PATH, patches: [secondPatch] }),
    ]);
    expect(outcomes.some((outcome) => outcome.retries > 0)).toBe(true);
    const pending = await first.listPending({ crawlerKey: 'example-crawler' });
    expect(pending.pending.map((entry) => entry.patch.patchHash).sort())
      .toEqual([firstPatch.patchHash, secondPatch.patchHash].sort());
  });

  it('is idempotent and rejects duplicate, oversized and over-limit checkpoint batches', async () => {
    const { one } = createRepositories();
    const store = createTranslationStateStoreV2({ repository: one });
    const patch = patchFor();
    await store.initialize();
    const first = await store.checkpointBatch({ slicePath: SLICE_PATH, patches: [patch] });
    const replay = await store.checkpointBatch({ slicePath: SLICE_PATH, patches: [patch] });
    expect(replay.commit).toBe(first.commit);
    expect(replay.changed).toBe(false);
    await expect(store.checkpointBatch({ slicePath: SLICE_PATH, patches: [patch, patch] }))
      .rejects.toThrow(/duplicate/);
    await expect(store.checkpointBatch({
      slicePath: SLICE_PATH,
      patches: Array.from({ length: 251 }, () => patch),
    })).rejects.toThrow(/between 1 and 250/);

    const oversized = patchFor(JOB, `Traduzione ${'x'.repeat(MAX_TRANSLATION_STATE_ARTIFACT_BYTES_V2)}`);
    await expect(store.checkpointBatch({ slicePath: SLICE_PATH, patches: [oversized] }))
      .rejects.toThrow(/bounded size/);
  });
});
