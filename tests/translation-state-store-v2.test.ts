import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('checkpoints immutable sharded artifacts and atomically acks lifecycle plus queue removal', async () => {
    const { one } = createRepositories();
    const store = createTranslationStateStoreV2({ repository: one });
    const patch = patchFor();
    await store.initialize();
    const checkpoint = await store.checkpointBatch({ slicePath: SLICE_PATH, patches: [patch] });
    const pending = await store.listPending({ crawlerKey: 'example-crawler' });

    expect(pending.pending).toHaveLength(1);
    expect(pending.pending[0].patch).toEqual(patch);
    const paths = git(one, 'ls-tree', '-r', '--name-only', checkpoint.commit).split('\n');
    expect(paths.some((path) => path.startsWith(`v2/patches/${patch.patchHash.slice(0, 2)}/`))).toBe(true);
    expect(paths.some((path) => path.startsWith('v2/memory/'))).toBe(true);
    expect(paths.filter((path) => path.startsWith('v2/journal/'))).toHaveLength(4);
    expect(paths.some((path) => path.startsWith('v2/queue/'))).toBe(true);

    const ack = await store.acknowledgeBatch([{
      patch,
      slicePath: SLICE_PATH,
      outcome: 'already_valid',
      mainCommit: git(one, 'rev-parse', 'origin/main'),
      publishedCommit: null,
      intentHash: null,
    }]);
    expect((await store.listPending({ crawlerKey: 'example-crawler' })).pending).toHaveLength(0);
    expect((await store.readAcknowledgment(patch.patchHash)).acknowledgment.outcome).toBe('already_valid');

    const changed = git(one, 'diff-tree', '--no-commit-id', '--name-status', '-r', `${ack.commit}^`, ack.commit);
    expect(changed).toMatch(/^A\s+v2\/acks\//m);
    expect(changed).toMatch(/^A\s+v2\/journal\//m);
    expect(changed).toMatch(/^D\s+v2\/queue\//m);

    const firstReceipt = (await store.readAcknowledgment(patch.patchHash)).acknowledgment;
    await store.checkpointBatch({ slicePath: SLICE_PATH, patches: [patch], requeue: true });
    expect((await store.listPending({ crawlerKey: 'example-crawler' })).pending).toHaveLength(1);
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
