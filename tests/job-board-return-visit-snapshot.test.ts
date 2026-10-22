import { describe, expect, it, vi } from 'vitest';
import {
  createJobBoardReturnVisitSnapshotStore,
  JOB_BOARD_RETURN_VISIT_INACTIVITY_TTL_MS,
  JOB_BOARD_RETURN_VISIT_SNAPSHOT_KEY,
  readOrCaptureJobBoardReturnVisitSnapshot,
  type JobBoardReturnVisitSnapshotStorage,
} from '@/services/jobBoardReturnVisitSnapshot';

function createMemoryStorage(initial: string | null = null): JobBoardReturnVisitSnapshotStorage {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key, nextValue) => { value = nextValue; },
  };
}

const visit = (previousLastVisit: number | null) => ({ data: { previousLastVisit }, previousLastVisit });

describe('job board return-visit snapshot', () => {
  it('captures once and reuses a stable boundary for remounts in the active tab', () => {
    const store = createJobBoardReturnVisitSnapshotStore();
    const storage = createMemoryStorage();
    const startVisit = vi.fn(() => visit(1_800_000_000_000));

    const first = readOrCaptureJobBoardReturnVisitSnapshot({ store, storage, now: 1_800_000_000_100, startVisit });
    const remount = readOrCaptureJobBoardReturnVisitSnapshot({ store, storage, now: 1_800_000_000_200, startVisit });

    expect(first.startedVisit).toBe(true);
    expect(remount.startedVisit).toBe(false);
    expect(remount.snapshot.previousLastVisit).toBe(first.snapshot.previousLastVisit);
    expect(startVisit).toHaveBeenCalledTimes(1);
    expect(storage.getItem(JOB_BOARD_RETURN_VISIT_SNAPSHOT_KEY)).toContain('"version":1');
  });

  it('starts a new visit after 30 minutes without a board mount', () => {
    const store = createJobBoardReturnVisitSnapshotStore();
    const storage = createMemoryStorage();
    const startVisit = vi.fn()
      .mockReturnValueOnce(visit(1_800_000_000_000))
      .mockReturnValueOnce(visit(1_800_000_000_250));

    readOrCaptureJobBoardReturnVisitSnapshot({ store, storage, now: 1_800_000_000_100, startVisit });
    const returned = readOrCaptureJobBoardReturnVisitSnapshot({
      store,
      storage,
      now: 1_800_000_000_100 + JOB_BOARD_RETURN_VISIT_INACTIVITY_TTL_MS,
      startVisit,
    });

    expect(returned.startedVisit).toBe(true);
    expect(returned.snapshot.previousLastVisit).toBe(1_800_000_000_250);
    expect(startVisit).toHaveBeenCalledTimes(2);
  });

  it('recaptures corrupt or future stored snapshots and sanitizes future visit markers', () => {
    const corrupt = createMemoryStorage('{not-json');
    const corruptResult = readOrCaptureJobBoardReturnVisitSnapshot({
      store: createJobBoardReturnVisitSnapshotStore(),
      storage: corrupt,
      now: 1_800_000_000_100,
      startVisit: () => visit(1_800_000_000_000),
    });
    expect(corruptResult.startedVisit).toBe(true);

    const future = createMemoryStorage(JSON.stringify({
      version: 1,
      previousLastVisit: 1_800_000_000_101,
      lastActivityAt: 1_800_000_000_100,
    }));
    const futureResult = readOrCaptureJobBoardReturnVisitSnapshot({
      store: createJobBoardReturnVisitSnapshotStore(),
      storage: future,
      now: 1_800_000_000_100,
      startVisit: () => visit(1_800_000_000_101),
    });
    expect(futureResult.startedVisit).toBe(true);
    expect(futureResult.snapshot.previousLastVisit).toBeNull();
  });

  it('keeps remount state in memory when storage is unavailable', () => {
    const store = createJobBoardReturnVisitSnapshotStore();
    const startVisit = vi.fn(() => visit(1_800_000_000_000));

    readOrCaptureJobBoardReturnVisitSnapshot({ store, storage: null, now: 1_800_000_000_100, startVisit });
    const remount = readOrCaptureJobBoardReturnVisitSnapshot({ store, storage: null, now: 1_800_000_000_200, startVisit });

    expect(remount.startedVisit).toBe(false);
    expect(startVisit).toHaveBeenCalledTimes(1);
  });
});
