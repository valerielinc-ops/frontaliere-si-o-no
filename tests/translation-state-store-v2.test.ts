import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEmptyTranslationMemoryV2,
  lookupTranslationMemoryV2,
  recordTranslationCandidateV2,
} from '../scripts/lib/content-addressed-translation-memory-v2.mjs';
import {
  createEmptyTranslationSchedulerCursorV2,
  planTranslationScheduleV2,
} from '../scripts/lib/translation-completion-scheduler-v2.mjs';
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
const SCHEDULER_SCOPE = 'translation-shadow-v2';
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

function schedulerReservation(
  scopeKey = SCHEDULER_SCOPE,
  cursor = createEmptyTranslationSchedulerCursorV2({ scopeKey }),
  token = 'default',
  jobCount = 1,
) {
  const jobs = Array.from({ length: jobCount }, (_, index) => {
    const job = {
      ...JOB,
      url: `https://jobs.example.test/positions/${token}-${index}/`,
      slug: `${token}-${index}`,
      title: `Engineer ${token} ${index}`,
      titleByLocale: { de: `Engineer ${token} ${index}`, it: '' },
    };
    return {
      target: {
        crawlerKey: 'example-crawler',
        slicePath: SLICE_PATH,
        jobKey: `${token}-${index}`,
        url: job.url,
      },
      queuedAtMs: 1_000 + index,
      units: [{
        identity: createJobTranslationUnitIdentityV2(job, {
          fieldPath: 'title',
          targetLocale: 'it',
        }),
        memory: createEmptyTranslationMemoryV2(),
      }],
    };
  });
  return planTranslationScheduleV2({
    scopeKey,
    baselineMainSha: 'a'.repeat(40),
    scanDigest: `sha256:${digestTranslationDocumentV2({ token })}`,
    engineVersion: 'engine-2',
    gateVersion: 'gate-3',
    cursor,
    activePlan: null,
    limits: { maxJobs: 250, maxUnits: 250, fairnessNumerator: 1, fairnessDenominator: 5 },
    jobs,
  });
}

function schedulerOutcomes(plan: ReturnType<typeof schedulerReservation>['plan'], status = 'generation_failed') {
  return plan.selectedJobs.map((job) => ({
    schedulingKey: job.schedulingKey,
    units: job.units.map((unit) => ({ attemptKey: unit.attemptKey, status })),
  }));
}

function rejectedCheckpoint(
  identity: ReturnType<typeof createJobTranslationUnitIdentityV2>,
  engineVersion = 'engine-2',
  gateVersion = 'gate-3',
  outputText = 'Candidate rejected by the deterministic gate',
) {
  const memory = recordTranslationCandidateV2(createEmptyTranslationMemoryV2(), {
    identity,
    engineVersion,
    gateVersion,
    outputText,
    status: 'rejected',
    evidence: [],
  });
  return { identity, candidate: memory.records[0].candidates[0] };
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

  it('reserves one immutable plan, requires initialization and recovers it in a fresh process', async () => {
    const { one } = createRepositories();
    const store = createTranslationStateStoreV2({ repository: one });
    const empty = await store.readSchedulerScope({ scopeKey: SCHEDULER_SCOPE });
    const reservation = schedulerReservation();
    expect(empty).toMatchObject({ commit: null, cursor: { activePlanHash: null, generation: 0 }, activePlan: null });
    await expect(store.reserveSchedulerPlan({
      scopeKey: SCHEDULER_SCOPE,
      expectedCursorHash: empty.cursor.cursorHash,
      ...reservation,
    })).rejects.toThrow(/initialized/);

    await store.initialize();
    const reserved = await store.reserveSchedulerPlan({
      scopeKey: SCHEDULER_SCOPE,
      expectedCursorHash: empty.cursor.cursorHash,
      ...reservation,
    });
    expect(reserved).toMatchObject({
      changed: true,
      cursor: { activePlanHash: reservation.plan.planHash, generation: 0 },
      plan: { planHash: reservation.plan.planHash },
    });
    expect(Object.isFrozen(reserved)).toBe(true);
    expect(Object.isFrozen(reserved.cursor)).toBe(true);
    expect(Object.isFrozen(reserved.plan.selectedJobs)).toBe(true);
    expect(reserved.cursor).not.toBe(reservation.cursor);
    expect(reserved.plan).not.toBe(reservation.plan);
    const recovered = await createTranslationStateStoreV2({ repository: one })
      .readSchedulerScope({ scopeKey: SCHEDULER_SCOPE });
    expect(recovered.commit).toBe(reserved.commit);
    expect(recovered.cursor).toEqual(reservation.cursor);
    expect(recovered.activePlan).toEqual(reservation.plan);

    const replay = await store.reserveSchedulerPlan({
      scopeKey: SCHEDULER_SCOPE,
      expectedCursorHash: empty.cursor.cursorHash,
      ...reservation,
    });
    expect(replay).toMatchObject({ commit: reserved.commit, changed: false });
  });

  it('settles all and only active scheduling keys with outcomes and cursor in one CAS commit', async () => {
    const { one } = createRepositories();
    const store = createTranslationStateStoreV2({ repository: one });
    await store.initialize();
    const before = await store.readSchedulerScope({ scopeKey: SCHEDULER_SCOPE });
    const reservation = schedulerReservation(SCHEDULER_SCOPE, before.cursor, 'settlement', 2);
    const reserved = await store.reserveSchedulerPlan({
      scopeKey: SCHEDULER_SCOPE,
      expectedCursorHash: before.cursor.cursorHash,
      ...reservation,
    });
    const outcomes = schedulerOutcomes(reservation.plan);

    await expect(store.settleSchedulerPlan({
      scopeKey: SCHEDULER_SCOPE,
      planHash: reservation.plan.planHash,
      outcomes: outcomes.slice(0, 1),
    })).rejects.toThrow(/cover selected jobs/);
    await expect(store.settleSchedulerPlan({
      scopeKey: SCHEDULER_SCOPE,
      planHash: reservation.plan.planHash,
      outcomes: [...outcomes, { ...outcomes[0], schedulingKey: `translation-scheduling:v2:${'f'.repeat(64)}` }],
    })).rejects.toThrow(/cover selected jobs/);
    expect((await store.readSchedulerScope({ scopeKey: SCHEDULER_SCOPE })).cursor)
      .toEqual(reservation.cursor);

    const settled = await store.settleSchedulerPlan({
      scopeKey: SCHEDULER_SCOPE,
      planHash: reservation.plan.planHash,
      outcomes,
    });
    expect(settled.settlement).toMatchObject({
      planHash: reservation.plan.planHash,
      cursor: reservation.plan.cursorAfter,
    });
    expect(Object.isFrozen(settled.settlement)).toBe(true);
    expect(Object.isFrozen(settled.settlement.outcomes)).toBe(true);
    expect(settled.settlement.outcomes).not.toBe(outcomes);
    expect(settled.settlement.outcomes.map((outcome) => outcome.schedulingKey).sort())
      .toEqual(outcomes.map((outcome) => outcome.schedulingKey).sort());
    const changedPaths = git(one, 'diff-tree', '--no-commit-id', '--name-status', '-r', reserved.commit, settled.commit)
      .split('\n');
    expect(changedPaths).toHaveLength(2);
    expect(changedPaths.some((line) => line.startsWith('M\t') && line.endsWith('/cursor.json'))).toBe(true);
    expect(changedPaths.some((line) => line.startsWith('A\t') && line.includes('/settlements/'))).toBe(true);
    const after = await store.readSchedulerScope({ scopeKey: SCHEDULER_SCOPE });
    expect(after).toMatchObject({
      commit: settled.commit,
      cursor: { activePlanHash: null, generation: 1 },
      activePlan: null,
    });

    const replay = await store.settleSchedulerPlan({
      scopeKey: SCHEDULER_SCOPE,
      planHash: reservation.plan.planHash,
      outcomes: [...outcomes].reverse(),
    });
    expect(replay).toMatchObject({ commit: settled.commit, changed: false });
    const conflicting = structuredClone(outcomes);
    conflicting[0].units[0].status = 'rejected';
    await expect(store.settleSchedulerPlan({
      scopeKey: SCHEDULER_SCOPE,
      planHash: reservation.plan.planHash,
      outcomes: conflicting,
    })).rejects.toThrow(/hash|outcomes/);

    const nextReservation = schedulerReservation(SCHEDULER_SCOPE, after.cursor, 'next-generation');
    const nextReserved = await store.reserveSchedulerPlan({
      scopeKey: SCHEDULER_SCOPE,
      expectedCursorHash: after.cursor.cursorHash,
      ...nextReservation,
    });
    const lateReplay = await store.settleSchedulerPlan({
      scopeKey: SCHEDULER_SCOPE,
      planHash: reservation.plan.planHash,
      outcomes,
    });
    expect(lateReplay).toMatchObject({ commit: nextReserved.commit, changed: false });
    await expect(store.settleSchedulerPlan({
      scopeKey: SCHEDULER_SCOPE,
      planHash: reservation.plan.planHash,
      outcomes: conflicting,
    })).rejects.toThrow(/hash|outcomes/);
    expect(await store.readSchedulerScope({ scopeKey: SCHEDULER_SCOPE })).toMatchObject({
      cursor: { activePlanHash: nextReservation.plan.planHash, generation: 1 },
      activePlan: { planHash: nextReservation.plan.planHash },
    });
  });

  it('rebuilds concurrent identical plan reservations and rejects a different active plan', async () => {
    const { one, two } = createRepositories();
    await createTranslationStateStoreV2({ repository: one }).initialize();
    let arrivals = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    const onStage = async (stage: string, details: { message?: string }) => {
      if (stage !== 'beforeStatePush' || details.message !== 'translation-state-v2: reserve scheduler plan') return;
      arrivals += 1;
      if (arrivals === 2) releaseBarrier();
      await barrier;
    };
    const first = createTranslationStateStoreV2({ repository: one, onStage });
    const second = createTranslationStateStoreV2({ repository: two, onStage });
    const empty = createEmptyTranslationSchedulerCursorV2({ scopeKey: SCHEDULER_SCOPE });
    const reservation = schedulerReservation(SCHEDULER_SCOPE, empty, 'concurrent');
    const results = await Promise.all([
      first.reserveSchedulerPlan({
        scopeKey: SCHEDULER_SCOPE,
        expectedCursorHash: empty.cursorHash,
        ...reservation,
      }),
      second.reserveSchedulerPlan({
        scopeKey: SCHEDULER_SCOPE,
        expectedCursorHash: empty.cursorHash,
        ...reservation,
      }),
    ]);
    expect(results.some((result) => result.retries > 0)).toBe(true);
    expect(results.map((result) => result.commit).every((commit) => commit === results[0].commit)).toBe(true);
    const different = schedulerReservation(SCHEDULER_SCOPE, empty, 'different');
    await expect(first.reserveSchedulerPlan({
      scopeKey: SCHEDULER_SCOPE,
      expectedCursorHash: empty.cursorHash,
      ...different,
    })).rejects.toMatchObject({ code: 'TRANSLATION_STATE_SCHEDULER_CONFLICT_V2' });
  });

  it('persists exact rejected candidates without queueing and preserves every bounded memory candidate', async () => {
    const { one } = createRepositories();
    const store = createTranslationStateStoreV2({ repository: one });
    await store.initialize();
    const originalIdentity = createJobTranslationUnitIdentityV2(JOB, {
      fieldPath: 'title',
      targetLocale: 'it',
    });
    const rotatedIdentity = createJobTranslationUnitIdentityV2({
      ...JOB,
      url: 'https://jobs.example.test/positions/re-added/',
      slug: 're-added',
    }, {
      fieldPath: 'title',
      targetLocale: 'it',
    });
    expect(rotatedIdentity.key).toBe(originalIdentity.key);
    const first = rejectedCheckpoint(originalIdentity);
    const second = rejectedCheckpoint(originalIdentity, 'engine-3', 'gate-4', 'Second exact rejection');
    const checkpoint = await store.checkpointRejectedCandidatesBatch([first, second]);
    const replay = await store.checkpointRejectedCandidatesBatch([second, first]);
    expect(replay).toMatchObject({ commit: checkpoint.commit, changed: false });

    const read = await store.readTranslationMemories({ identities: [rotatedIdentity] });
    expect(read.memories[0].records[0].candidates).toHaveLength(2);
    expect(Object.isFrozen(read.memories[0].records[0].candidates)).toBe(true);
    expect(read.memories[0].records[0].candidates[0]).not.toBe(first.candidate);
    expect(lookupTranslationMemoryV2(read.memories[0], {
      identity: rotatedIdentity,
      engineVersion: 'engine-2',
      gateVersion: 'gate-3',
    }).status).toBe('negative_cache');
    expect(lookupTranslationMemoryV2(read.memories[0], {
      identity: rotatedIdentity,
      engineVersion: 'engine-4',
      gateVersion: 'gate-4',
    }).status).toBe('missing');
    const paths = git(one, 'ls-tree', '-r', '--name-only', checkpoint.commit).split('\n');
    expect(paths.filter((path) => path.startsWith('v2/memory/'))).toHaveLength(2);
    expect(paths.filter((path) => path.startsWith('v2/journal/'))).toHaveLength(6);
    expect(paths.some((path) => path.startsWith('v2/queue/'))).toBe(false);
    await expect(store.checkpointRejectedCandidatesBatch(Array.from({ length: 251 }, () => first)))
      .rejects.toThrow(/between 1 and 250/);
    await expect(store.checkpointRejectedCandidatesBatch([first, first]))
      .rejects.toThrow(/duplicates/);
    const oversized = rejectedCheckpoint(
      originalIdentity,
      'engine-oversized',
      'gate-oversized',
      `Rejected ${'x'.repeat(MAX_TRANSLATION_STATE_ARTIFACT_BYTES_V2)}`,
    );
    await expect(store.checkpointRejectedCandidatesBatch([oversized]))
      .rejects.toThrow(/bounded size/);
    expect(await store.isCurrentCommit(checkpoint.commit)).toBe(true);
    expect((await store.readTranslationMemories({ identities: [originalIdentity] }))
      .memories[0].records[0].candidates).toHaveLength(2);
    await expect(store.readTranslationMemories({ identities: Array.from({ length: 251 }, () => originalIdentity) }))
      .rejects.toThrow(/between 1 and 250/);
  });

  it('fails closed when rejected candidate memory and journal become asymmetric', async () => {
    for (const removedKind of ['memory', 'journal']) {
      const { one } = createRepositories();
      const store = createTranslationStateStoreV2({ repository: one });
      await store.initialize();
      const identity = createJobTranslationUnitIdentityV2(JOB, {
        fieldPath: 'title',
        targetLocale: 'it',
      });
      const rejected = rejectedCheckpoint(identity);
      const checkpoint = await store.checkpointRejectedCandidatesBatch([rejected]);
      const prefix = removedKind === 'memory' ? 'v2/memory/' : 'v2/journal/';
      const removedPaths = git(one, 'ls-tree', '-r', '--name-only', checkpoint.commit)
        .split('\n')
        .filter((path) => path.startsWith(prefix));
      expect(removedPaths).toHaveLength(removedKind === 'memory' ? 1 : 3);
      git(one, 'checkout', '-q', '-B', `tampered-rejected-${removedKind}`, checkpoint.commit);
      git(one, 'rm', '-q', ...removedPaths);
      git(one, 'commit', '-q', '-m', `delete rejected ${removedKind}`);
      const tamperedTip = git(one, 'rev-parse', 'HEAD');
      git(one, 'push', '-q', 'origin', 'HEAD:refs/heads/translation-state-v2');

      const replay = createTranslationStateStoreV2({ repository: one });
      await expect(replay.checkpointRejectedCandidatesBatch([rejected]))
        .rejects.toThrow(/memory and journal disagree/);
      expect(await replay.isCurrentCommit(tamperedTip)).toBe(true);
    }
  });

  it('returns all 250 memory candidates and fails closed at the 251st artifact', async () => {
    const { one } = createRepositories();
    const initialized = await createTranslationStateStoreV2({ repository: one }).initialize();
    const identity = createJobTranslationUnitIdentityV2(JOB, {
      fieldPath: 'title',
      targetLocale: 'it',
    });
    const directory = join(
      one,
      'v2',
      'memory',
      identity.identityHash.slice(0, 2),
      identity.identityHash,
    );
    git(one, 'checkout', '-q', '-B', 'state-memory-cap', initialized.commit);
    mkdirSync(directory, { recursive: true });
    const candidates = Array.from({ length: 251 }, (_, index) => rejectedCheckpoint(
      identity,
      'engine-cap',
      'gate-cap',
      `Rejected candidate ${String(index).padStart(3, '0')}`,
    ).candidate);
    for (const candidate of candidates.slice(0, 250)) {
      const digest = candidate.candidateId.split(':').at(-1)!;
      writeFileSync(
        join(directory, `${digest}.json`),
        `${JSON.stringify({ schemaVersion: 2, records: [{ identity, candidates: [candidate] }] })}\n`,
      );
    }
    git(one, 'add', 'v2/memory');
    git(one, 'commit', '-q', '-m', 'add bounded memory candidates');
    git(one, 'push', '-q', 'origin', 'HEAD:refs/heads/translation-state-v2');

    const store = createTranslationStateStoreV2({ repository: one });
    const bounded = await store.readTranslationMemories({ identities: [identity] });
    expect(bounded.memories[0].records[0].candidates).toHaveLength(250);
    expect(lookupTranslationMemoryV2(bounded.memories[0], {
      identity,
      engineVersion: 'engine-cap',
      gateVersion: 'gate-cap',
    }).status).toBe('conflicting_candidates');

    const overflow = candidates[250];
    const overflowDigest = overflow.candidateId.split(':').at(-1)!;
    writeFileSync(
      join(directory, `${overflowDigest}.json`),
      `${JSON.stringify({ schemaVersion: 2, records: [{ identity, candidates: [overflow] }] })}\n`,
    );
    git(one, 'add', 'v2/memory');
    git(one, 'commit', '-q', '-m', 'overflow memory candidates');
    git(one, 'push', '-q', 'origin', 'HEAD:refs/heads/translation-state-v2');
    await expect(createTranslationStateStoreV2({ repository: one })
      .readTranslationMemories({ identities: [identity] }))
      .rejects.toThrow(/exceeds the bounded count/);
  }, 60_000);

  it('keeps reserve CAS p95 below two seconds across at least twenty samples', async () => {
    const { one } = createRepositories();
    const store = createTranslationStateStoreV2({ repository: one });
    await store.initialize();
    const samples = [];
    for (let index = 0; index < 20; index += 1) {
      const scopeKey = `translation-benchmark-${index}`;
      const cursor = createEmptyTranslationSchedulerCursorV2({ scopeKey });
      const reservation = schedulerReservation(scopeKey, cursor, `benchmark-${index}`);
      const started = performance.now();
      await store.reserveSchedulerPlan({
        scopeKey,
        expectedCursorHash: cursor.cursorHash,
        ...reservation,
      });
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
    expect(samples).toHaveLength(20);
    expect(p95).toBeLessThan(2_000);
  }, 60_000);

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
