import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPersonalScorer, schedulePersonalJobScores, scorePersonalJobs, scheduleNewJobsCount, computeNewJobsCount } from '@/services/personalizationScoring';

const jobs = Array.from({ length: 100 }, (_, i) => ({
 id: String(i), slug: `infermiere-${i}`, title: 'Infermiere', category: 'health', company: 'Ospedale', location: 'Lugano', postedDate: new Date().toISOString(),
}));
const behavior = { version: 1 as const, lastVisit: null, viewedJobs: [], searches: [{ query: 'infermiere', ts: Date.now(), resultCount: 100 }], filterUsage: { category: {}, location: {}, contract: {} }, syncedAt: null };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function frames() {
 const pending = new Map<number, FrameRequestCallback>();
 let nextId = 0;
 vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { pending.set(++nextId, cb); return nextId; });
 vi.stubGlobal('cancelAnimationFrame', (id: number) => pending.delete(id));
 let tick = 0;
 vi.spyOn(performance, 'now').mockImplementation(() => tick += 9);
 return { pending, next: () => {
  const [id, cb] = pending.entries().next().value!;
  pending.delete(id); cb(0);
 } };
}

describe('scheduled personal scores', () => {
 it('yields between batches and publishes exactly the synchronous scores once', () => {
  const queue = frames();
  const complete = vi.fn();
  const scorer = vi.fn(createPersonalScorer(behavior, null));
  schedulePersonalJobScores(jobs, scorer, complete);
  expect(scorer).not.toHaveBeenCalled();
  queue.next();
  expect(scorer).toHaveBeenCalledTimes(16);
  expect(complete).not.toHaveBeenCalled();
  while (queue.pending.size) queue.next();
  expect(scorer).toHaveBeenCalledTimes(jobs.length);
  expect(complete).toHaveBeenCalledOnce();
  expect(complete.mock.calls[0][0]).toEqual(scorePersonalJobs(jobs, createPersonalScorer(behavior, null)));
 });
 it('does not publish partial or superseded results after cancellation', () => {
  const queue = frames(); const complete = vi.fn();
  const cancel = schedulePersonalJobScores(jobs, createPersonalScorer(behavior, null), complete);
  queue.next();
  const alreadyQueued = [...queue.pending.values()][0];
  cancel();
  expect(queue.pending.size).toBe(0);
  alreadyQueued(0);
  expect(complete).not.toHaveBeenCalled();
 });
 it('keeps the new-jobs badge equivalent to its synchronous personalization-only count', () => {
  const queue = frames(); const complete = vi.fn();
  const lastVisit = Date.now() - 86400000;
  scheduleNewJobsCount(jobs, lastVisit, behavior, null, null, complete);
  while (queue.pending.size) queue.next();
  expect(complete).toHaveBeenCalledWith(computeNewJobsCount(jobs, lastVisit, behavior, null, null));
 });
 it('publishes a complete empty map for an empty board', () => {
  const queue = frames(); const complete = vi.fn();
  schedulePersonalJobScores([], createPersonalScorer(behavior, null), complete);
  queue.next();
  expect(complete).toHaveBeenCalledWith(new Map());
 });
});
