import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { createTranslationStateDrainerV2 } from '../scripts/lib/translation-state-drainer-v2.mjs';
import { createTranslationStateStoreV2 } from '../scripts/lib/translation-state-store-v2.mjs';

const roots: string[] = [];
const SLICE_PATH = 'data/jobs/by-crawler/example-crawler.json';

function job(index: number) {
  return {
    url: `https://jobs.example.test/positions/${100000 + index}/`,
    slug: `stelle-${index}`,
    title: `Stelle ${index}`,
    description: `Aufgabe ${index}`,
    sourceLang: 'de',
    company: 'Example AG',
    location: 'Zürich',
    datePosted: 'relative-fixture',
    titleByLocale: { de: `Stelle ${index}`, it: '' },
    descriptionByLocale: { de: `Aufgabe ${index}` },
    slugByLocale: { de: `stelle-${index}` },
    needsRetranslation: { title: ['it'] },
    history: [{ event: 'seen' }],
    cache: { score: index },
  };
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function configure(repo: string) {
  git(repo, 'config', 'user.name', 'Translation Drainer Test');
  git(repo, 'config', 'user.email', 'translation-drainer-test@example.test');
}

function setup(jobCount = 4, mutateSlice?: (slice: any) => void) {
  const root = mkdtempSync(join(tmpdir(), 'translation-state-drainer-v2-test-'));
  roots.push(root);
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  git(root, 'init', '-q', '--bare', '--initial-branch=main', remote);
  git(root, 'init', '-q', '--initial-branch=main', seed);
  configure(seed);
  const slice = {
    crawlerKey: 'example-crawler',
    assembledAt: 'relative-fixture',
    jobs: Array.from({ length: jobCount }, (_, index) => job(index + 1)),
  };
  mutateSlice?.(slice);
  const sliceFile = join(seed, SLICE_PATH);
  mkdirSync(dirname(sliceFile), { recursive: true });
  writeFileSync(sliceFile, `${JSON.stringify(slice, null, 2)}\n`);
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  git(seed, 'add', 'README.md', SLICE_PATH);
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  const writers = ['one', 'two', 'rival'].map((name) => {
    const repo = join(root, name);
    git(root, 'clone', '-q', remote, repo);
    configure(repo);
    return repo;
  });
  return { remote, seed, one: writers[0], two: writers[1], rival: writers[2], slice };
}

function patchFor(sourceJob: ReturnType<typeof job>, outputText = `Traduzione ${sourceJob.slug}`) {
  const identity = createJobTranslationUnitIdentityV2(sourceJob, {
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
    job: sourceJob,
    fieldPath: 'title',
    targetLocale: 'it',
    candidate: memory.records[0].candidates[0],
  });
}

function createPair(repository: string, onStage?: (stage: string, value: unknown) => Promise<void>) {
  const stateStore = createTranslationStateStoreV2({ repository });
  const drainer = createTranslationStateDrainerV2({ repository, stateStore, onStage });
  return { stateStore, drainer };
}

function cloneShallow(remote: string, name: string) {
  const repository = join(dirname(remote), name);
  git(dirname(remote), 'clone', '-q', '--depth=1', `file://${remote}`, repository);
  configure(repository);
  return repository;
}

function gitRunnerWithUnavailableIntentFetch(repository: string, { failUnshallow = false } = {}) {
  return async (args: string[]) => {
    if (args[0] === 'fetch' && /^[a-f0-9]{40}$/u.test(args.at(-1) ?? '')) {
      return { code: 1, stdout: '', stderr: 'simulated unavailable exact object fetch' };
    }
    if (failUnshallow && args[0] === 'fetch' && args.includes('--unshallow')) {
      return { code: 1, stdout: '', stderr: 'simulated unshallow failure' };
    }
    try {
      const stdout = execFileSync('git', args, { cwd: repository, encoding: 'utf8' });
      return { code: 0, stdout, stderr: '' };
    } catch (error: any) {
      return {
        code: typeof error?.status === 'number' ? error.status : 1,
        stdout: error?.stdout ?? '',
        stderr: error?.stderr ?? String(error),
      };
    }
  };
}

function readRemoteSlice(repo: string) {
  git(repo, 'fetch', '-q', 'origin', 'main');
  return JSON.parse(git(repo, 'show', `origin/main:${SLICE_PATH}`));
}

function advanceMain(repo: string, name: string, mutate?: (slice: any) => void) {
  git(repo, 'fetch', '-q', 'origin', 'main');
  git(repo, 'checkout', '-q', '-B', 'main', 'origin/main');
  if (mutate) {
    const file = join(repo, SLICE_PATH);
    const slice = JSON.parse(readFileSync(file, 'utf8'));
    mutate(slice);
    writeFileSync(file, `${JSON.stringify(slice, null, 2)}\n`);
    git(repo, 'add', SLICE_PATH);
  } else {
    writeFileSync(join(repo, `${name}.txt`), `${name}\n`);
    git(repo, 'add', `${name}.txt`);
  }
  git(repo, 'commit', '-q', '-m', name);
  git(repo, 'push', '-q', 'origin', 'HEAD:main');
  return git(repo, 'rev-parse', 'HEAD');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('translation state drainer v2', () => {
  it('publishes one semantic microcommit from fresh main and preserves every primary field', async () => {
    const { one, slice } = setup();
    const { drainer, stateStore } = createPair(one);
    const patch = patchFor(slice.jobs[0]);
    const secondPatch = patchFor(slice.jobs[1], 'Traduzione batch due');
    const beforeMain = git(one, 'rev-parse', 'origin/main');
    const beforeJob = structuredClone(slice.jobs[0]);
    const result = await drainer.drain({ slicePath: SLICE_PATH, patches: [patch, secondPatch] });
    const after = readRemoteSlice(one);

    expect(result.outcomes).toEqual(['applied', 'applied']);
    expect(result.publishedCommit).not.toBeNull();
    expect(git(one, 'diff-tree', '--no-commit-id', '--name-only', '-r', beforeMain, result.publishedCommit))
      .toBe(SLICE_PATH);
    expect(after.jobs[0].titleByLocale.it).toBe(`Traduzione ${beforeJob.slug}`);
    expect(after.jobs[1].titleByLocale.it).toBe('Traduzione batch due');
    const expectedPrimary = structuredClone(beforeJob);
    expectedPrimary.titleByLocale.it = `Traduzione ${beforeJob.slug}`;
    expect(after.jobs[0]).toEqual(expectedPrimary);
    expect((await stateStore.listPending({ crawlerKey: 'example-crawler' })).pending).toHaveLength(0);
    expect((await stateStore.readAcknowledgment(patch.patchHash)).acknowledgment.outcome).toBe('applied');
    const stateCommit = (await stateStore.readAcknowledgment(patch.patchHash)).commit;
    const statePaths = git(one, 'ls-tree', '-r', '--name-only', stateCommit).split('\n');
    expect(statePaths.filter((path) => path.startsWith('v2/intents/by-hash/'))).toHaveLength(1);
    expect(statePaths.filter((path) => path.startsWith('v2/intents/by-patch/'))).toHaveLength(2);
  });

  it('rebuilds from a newly advanced main after CAS rejection', async () => {
    const { one, rival, slice } = setup();
    let advanced = false;
    const { drainer } = createPair(one, async (stage) => {
      if (stage === 'afterIntent' && !advanced) {
        advanced = true;
        advanceMain(rival, 'concurrent-main-advance');
      }
    });
    const result = await drainer.drain({
      slicePath: SLICE_PATH,
      patches: [patchFor(slice.jobs[0])],
    });

    expect(result.outcomes).toEqual(['applied']);
    expect(result.retries).toBeGreaterThanOrEqual(1);
    expect(git(one, 'show', `${result.publishedCommit}:concurrent-main-advance.txt`)).toBe('concurrent-main-advance');
  });

  it('reconciles a remote-accepted push that the client reports as failed', async () => {
    const { one, rival, slice } = setup();
    const patch = patchFor(slice.jobs[0]);
    let returnedAmbiguousFailure = false;
    const ambiguousGit = async (args: string[]) => {
      try {
        const stdout = execFileSync('git', args, { cwd: one, encoding: 'utf8' });
        if (
          !returnedAmbiguousFailure
          && args[0] === 'push'
          && args.at(-1)?.endsWith(':refs/heads/main')
        ) {
          returnedAmbiguousFailure = true;
          advanceMain(rival, 'descendant-after-ambiguous-push');
          return { code: 1, stdout, stderr: 'simulated disconnect after receive' };
        }
        return { code: 0, stdout, stderr: '' };
      } catch (error: any) {
        return {
          code: typeof error?.status === 'number' ? error.status : 1,
          stdout: error?.stdout ?? '',
          stderr: error?.stderr ?? String(error),
        };
      }
    };
    const stateStore = createTranslationStateStoreV2({ repository: one });
    const drainer = createTranslationStateDrainerV2({ repository: one, stateStore, git: ambiguousGit });
    const result = await drainer.drain({ slicePath: SLICE_PATH, patches: [patch] });
    const acknowledgment = (await stateStore.readAcknowledgment(patch.patchHash)).acknowledgment;

    expect(returnedAmbiguousFailure).toBe(true);
    expect(result.outcomes).toEqual(['applied']);
    expect(result.publishedCommit).not.toBeNull();
    expect(git(one, 'merge-base', '--is-ancestor', result.publishedCommit, result.mainCommit)).toBe('');
    expect(acknowledgment.publishedCommit).toBe(result.publishedCommit);
    expect(acknowledgment.intentHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await stateStore.listPending({ crawlerKey: 'example-crawler' })).pending).toHaveLength(0);

    const replay = await drainer.drain({ slicePath: SLICE_PATH, patches: [patch] });
    expect(replay.replayed).toBe(true);
    expect(replay.publishedCommit).toBe(result.publishedCommit);
    expect((await stateStore.readAcknowledgment(patch.patchHash)).acknowledgment.ackHash)
      .toBe(acknowledgment.ackHash);
  });

  it('lets two writers race without losing either derived update', async () => {
    const { one, two, slice } = setup();
    const first = createPair(one);
    const second = createPair(two);
    const firstPatch = patchFor(slice.jobs[0], 'Traduzione uno');
    const secondPatch = patchFor(slice.jobs[1], 'Traduzione due');
    const [left, right] = await Promise.all([
      first.drainer.drain({ slicePath: SLICE_PATH, patches: [firstPatch] }),
      second.drainer.drain({ slicePath: SLICE_PATH, patches: [secondPatch] }),
    ]);
    const after = readRemoteSlice(one);

    expect(left.outcomes).toEqual(['applied']);
    expect(right.outcomes).toEqual(['applied']);
    expect(after.jobs[0].titleByLocale.it).toBe('Traduzione uno');
    expect(after.jobs[1].titleByLocale.it).toBe('Traduzione due');
  });

  it.each(['afterCheckpoint', 'afterIntent', 'afterMainPush', 'beforeAck'])(
    'replays idempotently after a crash at %s',
    async (crashStage) => {
      const { one, two, slice } = setup();
      const patch = patchFor(slice.jobs[0]);
      let crashed = false;
      const crashing = createPair(one, async (stage) => {
        if (stage === crashStage && !crashed) {
          crashed = true;
          throw new Error(`crash:${stage}`);
        }
      });
      await expect(crashing.drainer.drain({ slicePath: SLICE_PATH, patches: [patch] }))
        .rejects.toThrow(`crash:${crashStage}`);
      const mainAfterCrash = git(one, 'ls-remote', '--refs', 'origin', 'refs/heads/main').split(/\s+/u)[0];

      const replay = createPair(crashStage === 'afterIntent' ? two : one);
      const result = await replay.drainer.drain({ slicePath: SLICE_PATH, patches: [patch] });
      const after = readRemoteSlice(one);
      expect(result.outcomes).toEqual(['applied']);
      expect(after.jobs[0].titleByLocale.it).toBe(`Traduzione ${slice.jobs[0].slug}`);
      expect((await replay.stateStore.listPending({ crawlerKey: 'example-crawler' })).pending)
        .toHaveLength(0);
      if (['afterMainPush', 'beforeAck'].includes(crashStage)) {
        expect(git(one, 'ls-remote', '--refs', 'origin', 'refs/heads/main').split(/\s+/u)[0])
          .toBe(mainAfterCrash);
        expect(result.replayed).toBe(true);
      }
    },
    30_000,
  );

  it('recovers publish provenance from a fresh depth-one clone via bounded unshallow fallback', async () => {
    const { remote, one, rival, slice } = setup();
    const patch = patchFor(slice.jobs[0]);
    let proposedCommit: string | null = null;
    const crashing = createPair(one, async (stage, value) => {
      if (stage !== 'afterMainPush') return;
      proposedCommit = (value as any).intent.proposedCommit;
      advanceMain(rival, 'descendant-before-shallow-replay');
      throw new Error('crash:published-before-shallow-replay');
    });
    await expect(crashing.drainer.drain({ slicePath: SLICE_PATH, patches: [patch] }))
      .rejects.toThrow('crash:published-before-shallow-replay');
    expect(proposedCommit).not.toBeNull();

    const shallow = cloneShallow(remote, 'fresh-shallow-replay');
    expect(git(shallow, 'rev-parse', '--is-shallow-repository')).toBe('true');
    expect(() => git(shallow, 'cat-file', '-e', `${proposedCommit}^{commit}`)).toThrow();
    const stateStore = createTranslationStateStoreV2({ repository: shallow });
    const drainer = createTranslationStateDrainerV2({
      repository: shallow,
      stateStore,
      git: gitRunnerWithUnavailableIntentFetch(shallow),
    });
    const result = await drainer.drain({ slicePath: SLICE_PATH, patches: [patch] });
    const acknowledgment = (await stateStore.readAcknowledgment(patch.patchHash)).acknowledgment;

    expect(git(shallow, 'rev-parse', '--is-shallow-repository')).toBe('false');
    expect(result.replayed).toBe(true);
    expect(result.publishedCommit).toBe(proposedCommit);
    expect(acknowledgment.publishedCommit).toBe(proposedCommit);
    expect(acknowledgment.intentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect((await stateStore.listPending({ crawlerKey: 'example-crawler' })).pending).toHaveLength(0);
  }, 30_000);

  it('rebuilds a truly unpushed intent from a fresh depth-one clone with new provenance', async () => {
    const { remote, one, rival, slice } = setup();
    const patch = patchFor(slice.jobs[0]);
    let unpushedCommit: string | null = null;
    const crashing = createPair(one, async (stage, value) => {
      if (stage !== 'afterIntent') return;
      unpushedCommit = (value as any).intent.proposedCommit;
      throw new Error('crash:unpushed-intent-before-shallow-replay');
    });
    await expect(crashing.drainer.drain({ slicePath: SLICE_PATH, patches: [patch] }))
      .rejects.toThrow('crash:unpushed-intent-before-shallow-replay');
    expect(unpushedCommit).not.toBeNull();
    advanceMain(rival, 'main-advanced-after-unpushed-intent');

    const shallow = cloneShallow(remote, 'fresh-shallow-unpushed-replay');
    expect(git(shallow, 'rev-parse', '--is-shallow-repository')).toBe('true');
    expect(() => git(shallow, 'cat-file', '-e', `${unpushedCommit}^{commit}`)).toThrow();
    const { drainer, stateStore } = createPair(shallow);
    const result = await drainer.drain({ slicePath: SLICE_PATH, patches: [patch] });
    const acknowledgment = (await stateStore.readAcknowledgment(patch.patchHash)).acknowledgment;

    expect(git(shallow, 'rev-parse', '--is-shallow-repository')).toBe('false');
    expect(result.outcomes).toEqual(['applied']);
    expect(result.publishedCommit).not.toBe(unpushedCommit);
    expect(acknowledgment.publishedCommit).toBe(result.publishedCommit);
    expect(acknowledgment.intentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(git(shallow, 'merge-base', '--is-ancestor', result.publishedCommit, result.mainCommit)).toBe('');
  }, 30_000);

  it('fails closed in a shallow clone when publish provenance cannot be materialized', async () => {
    const { remote, one, rival, slice } = setup();
    const patch = patchFor(slice.jobs[0]);
    const crashing = createPair(one, async (stage) => {
      if (stage !== 'afterMainPush') return;
      advanceMain(rival, 'descendant-before-failed-shallow-replay');
      throw new Error('crash:published-before-failed-shallow-replay');
    });
    await expect(crashing.drainer.drain({ slicePath: SLICE_PATH, patches: [patch] }))
      .rejects.toThrow('crash:published-before-failed-shallow-replay');

    const shallow = cloneShallow(remote, 'failed-shallow-replay');
    const stateStore = createTranslationStateStoreV2({ repository: shallow });
    const drainer = createTranslationStateDrainerV2({
      repository: shallow,
      stateStore,
      git: gitRunnerWithUnavailableIntentFetch(shallow, { failUnshallow: true }),
    });
    await expect(drainer.drain({ slicePath: SLICE_PATH, patches: [patch] }))
      .rejects.toThrow(/unshallow failed/);
    expect((await stateStore.readAcknowledgment(patch.patchHash)).acknowledgment).toBeNull();
    expect((await stateStore.listPending({ crawlerKey: 'example-crawler' })).pending).toHaveLength(1);
  }, 30_000);

  it('re-evaluates latest main after push and records stale instead of a false applied ack', async () => {
    const { one, rival, slice } = setup();
    let advanced = false;
    const patch = patchFor(slice.jobs[0]);
    const { drainer, stateStore } = createPair(one, async (stage) => {
      if (stage === 'afterMainPush' && !advanced) {
        advanced = true;
        advanceMain(rival, 'source-rotated-after-push', (current) => {
          current.jobs[0].title = 'Neue Stelle';
          current.jobs[0].titleByLocale.it = '';
        });
      }
    });
    const result = await drainer.drain({ slicePath: SLICE_PATH, patches: [patch] });
    const acknowledgment = (await stateStore.readAcknowledgment(patch.patchHash)).acknowledgment;

    expect(result.outcomes).toEqual(['stale_source']);
    expect(acknowledgment.outcome).toBe('stale_source');
    expect(acknowledgment.publishedCommit).not.toBeNull();
    expect(acknowledgment.intentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(git(one, 'merge-base', '--is-ancestor', acknowledgment.publishedCommit, acknowledgment.mainCommit))
      .toBe('');

    const replay = await drainer.drain({ slicePath: SLICE_PATH, patches: [patch] });
    expect(replay.replayed).toBe(true);
    expect(replay.publishedCommit).toBe(acknowledgment.publishedCommit);
    expect((await stateStore.readAcknowledgment(patch.patchHash)).acknowledgment.ackHash)
      .toBe(acknowledgment.ackHash);
  });

  it.each([
    ['already_valid', (current: any) => { current.jobs[0].titleByLocale.it = 'Traduzione curata'; }],
    ['stale_target', (current: any) => { current.jobs[0].url += 'rotated/'; }],
    ['ambiguous_target', (current: any) => { current.jobs.push(structuredClone(current.jobs[0])); }],
    ['malformed_target', (current: any) => { current.jobs[0].titleByLocale = []; }],
  ])('persists the exact no-write reducer outcome %s', async (expectedOutcome, mutateSlice) => {
    const originalJob = job(1);
    const { one } = setup(4, mutateSlice);
    const { drainer, stateStore } = createPair(one);
    const patch = patchFor(originalJob);
    const before = git(one, 'rev-parse', 'origin/main');
    const result = await drainer.drain({ slicePath: SLICE_PATH, patches: [patch] });

    expect(result.outcomes).toEqual([expectedOutcome]);
    expect(result.publishedCommit).toBeNull();
    expect(git(one, 'ls-remote', '--refs', 'origin', 'refs/heads/main').split(/\s+/u)[0]).toBe(before);
    expect((await stateStore.readAcknowledgment(patch.patchHash)).acknowledgment.outcome)
      .toBe(expectedOutcome);
  });

  it('requeues the same candidate when its derived value disappears and retains both immutable acks', async () => {
    const { one, rival, slice } = setup();
    const patch = patchFor(slice.jobs[0]);
    const { drainer, stateStore } = createPair(one);
    const first = await drainer.drain({ slicePath: SLICE_PATH, patches: [patch] });
    const firstAck = (await stateStore.readAcknowledgment(patch.patchHash)).acknowledgment;
    expect(first.outcomes).toEqual(['applied']);

    advanceMain(rival, 'derived-value-disappeared', (current) => {
      current.jobs[0].titleByLocale.it = '';
    });
    const replay = await drainer.drain({ slicePath: SLICE_PATH, patches: [patch] });
    const latestAckResult = await stateStore.readAcknowledgment(patch.patchHash);
    const latestAck = latestAckResult.acknowledgment;

    expect(replay.outcomes).toEqual(['applied']);
    expect(replay.replayed).toBe(false);
    expect(readRemoteSlice(one).jobs[0].titleByLocale.it).toBe(`Traduzione ${slice.jobs[0].slug}`);
    expect(latestAck.lifecycleSequence).toBeGreaterThan(firstAck.lifecycleSequence);
    expect(git(one, 'ls-tree', '-r', '--name-only', latestAckResult.commit, '--', `v2/acks/${patch.patchHash.slice(0, 2)}/${patch.patchHash}`)
      .split('\n')).toHaveLength(2);
  });

  it('requeues only the changed recoverable subset and survives a crash with a terminal sibling', async () => {
    const { one, rival } = setup(4, (current) => {
      current.jobs[1].title = 'Fonte cambiata';
    });
    const firstPatch = patchFor(job(1), 'Traduzione ripristinata');
    const terminalPatch = patchFor(job(2), 'Traduzione terminale');
    const initial = createPair(one);
    const first = await initial.drainer.drain({
      slicePath: SLICE_PATH,
      patches: [firstPatch, terminalPatch],
    });
    const terminalAck = (await initial.stateStore.readAcknowledgment(terminalPatch.patchHash)).acknowledgment;
    expect(first.outcomes).toEqual(['applied', 'stale_source']);

    advanceMain(rival, 'mixed-batch-derived-disappeared', (current) => {
      current.jobs[0].titleByLocale.it = '';
    });
    let crashed = false;
    const crashing = createPair(one, async (stage) => {
      if (stage === 'afterCheckpoint' && !crashed) {
        crashed = true;
        throw new Error('crash:mixed-subset-checkpoint');
      }
    });
    await expect(crashing.drainer.drain({
      slicePath: SLICE_PATH,
      patches: [firstPatch, terminalPatch],
    })).rejects.toThrow('crash:mixed-subset-checkpoint');

    const replay = createPair(one);
    const result = await replay.drainer.drain({
      slicePath: SLICE_PATH,
      patches: [firstPatch, terminalPatch],
    });
    const terminalAfter = (await replay.stateStore.readAcknowledgment(terminalPatch.patchHash)).acknowledgment;
    expect(result.outcomes).toEqual(['applied', 'stale_source']);
    expect(readRemoteSlice(one).jobs[0].titleByLocale.it).toBe('Traduzione ripristinata');
    expect(terminalAfter.ackHash).toBe(terminalAck.ackHash);
    expect((await replay.stateStore.listPending({ crawlerKey: 'example-crawler' })).pending)
      .toHaveLength(0);
  }, 30_000);

  it('does not consume journal or ack capacity when a recoverable outcome is unchanged', async () => {
    const originalJob = job(1);
    const { one } = setup(4, (current) => {
      current.jobs[0].url += 'rotated/';
    });
    const patch = patchFor(originalJob);
    const { drainer, stateStore } = createPair(one);
    const first = await drainer.drain({ slicePath: SLICE_PATH, patches: [patch] });
    const firstAck = await stateStore.readAcknowledgment(patch.patchHash);
    expect(first.outcomes).toEqual(['stale_target']);

    for (let replay = 0; replay < 35; replay += 1) {
      const result = await drainer.drain({ slicePath: SLICE_PATH, patches: [patch] });
      expect(result.outcomes).toEqual(['stale_target']);
      expect(result.replayed).toBe(true);
    }
    const latestAck = await stateStore.readAcknowledgment(patch.patchHash);
    expect(latestAck.commit).toBe(firstAck.commit);
    expect(latestAck.acknowledgment.ackHash).toBe(firstAck.acknowledgment.ackHash);
  }, 30_000);

  it('does not create or resurrect an absent target and enforces the 1..250 boundary', async () => {
    const { one, rival, slice } = setup();
    const { drainer } = createPair(one);
    const absent = patchFor({
      ...slice.jobs[0],
      url: 'https://jobs.example.test/positions/999999/',
      slug: 'assente',
    });
    const before = git(one, 'rev-parse', 'origin/main');
    const result = await drainer.drain({ slicePath: SLICE_PATH, patches: [absent] });

    expect(result.outcomes).toEqual(['target_absent']);
    expect(result.publishedCommit).toBeNull();
    expect(git(one, 'ls-remote', '--refs', 'origin', 'refs/heads/main').split(/\s+/u)[0]).toBe(before);
    expect(readRemoteSlice(one).jobs).toHaveLength(slice.jobs.length);

    advanceMain(rival, 'exact-logical-readd', (current) => {
      current.jobs.push(structuredClone({
        ...slice.jobs[0],
        url: absent.target.url,
        slug: 'assente',
      }));
    });
    const readded = await drainer.drain({ slicePath: SLICE_PATH, patches: [absent] });
    expect(readded.outcomes).toEqual(['applied']);
    expect(readRemoteSlice(one).jobs.at(-1).titleByLocale.it).toBe('Traduzione assente');

    await expect(drainer.drain({ slicePath: SLICE_PATH, patches: [] })).rejects.toThrow(/between 1 and 250/);
    await expect(drainer.drain({
      slicePath: SLICE_PATH,
      patches: Array.from({ length: 251 }, () => absent),
    })).rejects.toThrow(/between 1 and 250/);
  });

  it('records the exact stale outcome when an absent target reappears with changed source', async () => {
    const { one, rival, slice } = setup();
    const missingJob = {
      ...slice.jobs[0],
      url: 'https://jobs.example.test/positions/888888/',
      slug: 'riapparsa-cambiata',
    };
    const patch = patchFor(missingJob);
    const { drainer, stateStore } = createPair(one);
    expect((await drainer.drain({ slicePath: SLICE_PATH, patches: [patch] })).outcomes)
      .toEqual(['target_absent']);

    advanceMain(rival, 'changed-logical-readd', (current) => {
      current.jobs.push({ ...structuredClone(missingJob), title: 'Fonte nuova' });
    });
    const replay = await drainer.drain({ slicePath: SLICE_PATH, patches: [patch] });
    expect(replay.outcomes).toEqual(['stale_source']);
    expect((await stateStore.readAcknowledgment(patch.patchHash)).acknowledgment.outcome)
      .toBe('stale_source');
    expect(readRemoteSlice(one).jobs.at(-1).titleByLocale.it).toBe('');
  });

  it('measures a real local bare-remote fetch-to-push p95 below two seconds', async () => {
    const { one, slice } = setup(20);
    const { drainer } = createPair(one);
    const samples: number[] = [];
    for (const sourceJob of slice.jobs) {
      const result = await drainer.drain({
        slicePath: SLICE_PATH,
        patches: [patchFor(sourceJob)],
      });
      samples.push(...result.fetchPushDurationsMs);
    }
    const ordered = [...samples].sort((left, right) => left - right);
    const p95 = ordered[Math.ceil(ordered.length * 0.95) - 1];

    expect(samples).toHaveLength(20);
    console.info(`translation drainer local fetch->push p95: ${p95.toFixed(1)}ms (${samples.length} samples)`);
    expect(p95).toBeLessThan(2_000);
  }, 120_000);
});
