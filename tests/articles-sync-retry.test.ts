import { describe, expect, it, vi } from 'vitest';

import {
  MAX_ARTICLE_SYNC_ATTEMPTS,
  isPublishedApiMovement,
  retryArticleSyncOnMovement,
} from '../scripts/lib/articles-sync-retry.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const moved = (from: string, to: string) =>
  `the published API moved from ${from} to ${to} while this run was working; committing now would mismatch`;

describe('article HTTP sync pair retry', () => {
  it('recognizes only manifest movement skips as retryable', () => {
    expect(isPublishedApiMovement(moved(SHA_A, SHA_B))).toBe(true);
    expect(isPublishedApiMovement('the corpus mirror is behind the published manifest')).toBe(false);
    expect(isPublishedApiMovement(moved('not-a-sha', SHA_B))).toBe(false);
  });

  it('restarts both pulls from the newly published pin after a movement skip', async () => {
    const corpusPins = [SHA_A, SHA_B];
    const runCorpus = vi.fn(async ({ attempt }: { attempt: number }) => ({
      exitCode: 0,
      commit: corpusPins[attempt - 1],
    }));
    const runApi = vi.fn(async ({ commit }: { attempt: number; commit: string }) => commit === SHA_A
      ? { exitCode: 0, skipped: true, reason: moved(SHA_A, SHA_B) }
      : { exitCode: 0, skipped: false, commit });

    const result = await retryArticleSyncOnMovement({ runCorpus, runApi });

    expect(result).toEqual({ status: 'success', commit: SHA_B, attempts: 2 });
    expect(runCorpus).toHaveBeenCalledTimes(2);
    expect(runApi.mock.calls.map(([args]) => args.commit)).toEqual([SHA_A, SHA_B]);
  });

  it('restarts the corpus pull when its first attempt reports movement', async () => {
    const runCorpus = vi.fn(async ({ attempt }: { attempt: number }) => attempt === 1
      ? { exitCode: 0, skipped: true, reason: moved(SHA_A, SHA_B) }
      : { exitCode: 0, skipped: false, commit: SHA_B });
    const runApi = vi.fn(async ({ commit }: { attempt: number; commit: string }) => ({
      exitCode: 0,
      skipped: false,
      commit,
    }));
    const onRetry = vi.fn();

    const result = await retryArticleSyncOnMovement({ runCorpus, runApi, onRetry });

    expect(result).toEqual({ status: 'success', commit: SHA_B, attempts: 2 });
    expect(runCorpus.mock.calls.map(([args]) => args.attempt)).toEqual([1, 2]);
    expect(runApi.mock.calls.map(([args]) => args.attempt)).toEqual([2]);
    expect(onRetry).toHaveBeenCalledWith({
      attempt: 1,
      nextAttempt: 2,
      stage: 'corpus',
      reason: moved(SHA_A, SHA_B),
    });
  });

  it('stops after the fixed retry cap and reports the final clean skip', async () => {
    let commit = 0;
    const runCorpus = vi.fn(async () => ({ exitCode: 0, commit: (commit++ === 0 ? SHA_A : SHA_B) }));
    const runApi = vi.fn(async ({ commit: pin }: { attempt: number; commit: string }) => ({
      exitCode: 0,
      skipped: true,
      reason: moved(pin, pin === SHA_A ? SHA_B : SHA_A),
    }));
    const onRetry = vi.fn();

    const result = await retryArticleSyncOnMovement({ runCorpus, runApi, onRetry });

    expect(MAX_ARTICLE_SYNC_ATTEMPTS).toBe(3);
    expect(result).toMatchObject({ status: 'skipped', stage: 'api', attempts: 3 });
    expect(runCorpus).toHaveBeenCalledTimes(3);
    expect(runApi).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-movement skip or a failed pull', async () => {
    const runCorpus = vi.fn(async () => ({ exitCode: 0, commit: SHA_A }));
    const runApi = vi.fn(async () => ({
      exitCode: 0,
      skipped: true,
      reason: 'the published API manifest has no usable commit',
    }));

    const skipped = await retryArticleSyncOnMovement({ runCorpus, runApi });
    expect(skipped).toMatchObject({ status: 'skipped', attempts: 1 });
    expect(runCorpus).toHaveBeenCalledTimes(1);
    expect(runApi).toHaveBeenCalledTimes(1);

    runCorpus.mockResolvedValue({ exitCode: 2, commit: null });
    const failed = await retryArticleSyncOnMovement({ runCorpus, runApi });
    expect(failed).toMatchObject({ status: 'failed', stage: 'corpus', exitCode: 2, attempts: 1 });
    expect(runApi).toHaveBeenCalledTimes(1);
  });
});
