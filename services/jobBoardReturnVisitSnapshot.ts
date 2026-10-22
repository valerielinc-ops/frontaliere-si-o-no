export const JOB_BOARD_RETURN_VISIT_SNAPSHOT_KEY = 'frontaliere_job_board_return_visit_snapshot_v1';
export const JOB_BOARD_RETURN_VISIT_INACTIVITY_TTL_MS = 30 * 60 * 1000;
const STORAGE_VERSION = 1;
const STORAGE_WRITE_INTERVAL_MS = 60 * 1000;

export interface JobBoardReturnVisitSnapshot {
  previousLastVisit: number | null;
  lastActivityAt: number;
}

export interface JobBoardReturnVisitSnapshotStore {
  memory: JobBoardReturnVisitSnapshot | null;
  lastPersistedAt: number;
}

export interface JobBoardReturnVisitSnapshotStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface StoredSnapshot {
  version: number;
  previousLastVisit: number | null;
  lastActivityAt: number;
}

export function createJobBoardReturnVisitSnapshotStore(): JobBoardReturnVisitSnapshotStore {
  return { memory: null, lastPersistedAt: 0 };
}

function isValidTimestamp(value: unknown, now: number): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value > 0
    && value <= now;
}

function isValidPreviousVisit(value: unknown, now: number): value is number | null {
  return value === null || isValidTimestamp(value, now);
}

function isReusableSnapshot(
  snapshot: JobBoardReturnVisitSnapshot | null,
  now: number,
): snapshot is JobBoardReturnVisitSnapshot {
  if (!snapshot || !Number.isFinite(now) || now <= 0) return false;
  if (!isValidPreviousVisit(snapshot.previousLastVisit, now)) return false;
  if (!Number.isFinite(snapshot.lastActivityAt) || snapshot.lastActivityAt <= 0 || snapshot.lastActivityAt > now) return false;
  return now - snapshot.lastActivityAt < JOB_BOARD_RETURN_VISIT_INACTIVITY_TTL_MS;
}

function readStoredSnapshot(
  storage: JobBoardReturnVisitSnapshotStorage | null,
  now: number,
): JobBoardReturnVisitSnapshot | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(JOB_BOARD_RETURN_VISIT_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSnapshot>;
    if (parsed.version !== STORAGE_VERSION) return null;
    const snapshot = {
      previousLastVisit: parsed.previousLastVisit,
      lastActivityAt: parsed.lastActivityAt,
    } as JobBoardReturnVisitSnapshot;
    return isReusableSnapshot(snapshot, now) ? snapshot : null;
  } catch {
    return null;
  }
}

function persistSnapshot(
  storage: JobBoardReturnVisitSnapshotStorage | null,
  snapshot: JobBoardReturnVisitSnapshot,
): boolean {
  if (!storage) return false;
  try {
    const stored: StoredSnapshot = {
      version: STORAGE_VERSION,
      previousLastVisit: snapshot.previousLastVisit,
      lastActivityAt: snapshot.lastActivityAt,
    };
    storage.setItem(JOB_BOARD_RETURN_VISIT_SNAPSHOT_KEY, JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

/**
 * Reuse the previous-visit boundary for one active tab session. After 30
 * minutes without activity, capture a new boundary through the caller's
 * existing consent-gated visit reader. Storage is best effort; module memory
 * keeps SPA remounts stable when sessionStorage is unavailable.
 */
export function readOrCaptureJobBoardReturnVisitSnapshot<T extends { previousLastVisit: number | null }>(options: {
  store: JobBoardReturnVisitSnapshotStore;
  storage: JobBoardReturnVisitSnapshotStorage | null;
  now: number;
  startVisit: () => T;
}): {
  snapshot: JobBoardReturnVisitSnapshot;
  startedVisit: boolean;
  visit: T | null;
} {
  const { store, storage } = options;
  const now = Number.isFinite(options.now) && options.now > 0 ? options.now : Date.now();
  const reusable = isReusableSnapshot(store.memory, now)
    ? store.memory
    : readStoredSnapshot(storage, now);

  if (reusable) {
    const snapshot = { ...reusable, lastActivityAt: now };
    store.memory = snapshot;
    if (store.lastPersistedAt === 0 || now - store.lastPersistedAt >= STORAGE_WRITE_INTERVAL_MS) {
      if (persistSnapshot(storage, snapshot)) store.lastPersistedAt = now;
    }
    return { snapshot, startedVisit: false, visit: null };
  }

  const visit = options.startVisit();
  const snapshot: JobBoardReturnVisitSnapshot = {
    previousLastVisit: isValidPreviousVisit(visit.previousLastVisit, now) ? visit.previousLastVisit : null,
    lastActivityAt: now,
  };
  store.memory = snapshot;
  if (persistSnapshot(storage, snapshot)) store.lastPersistedAt = now;
  return { snapshot, startedVisit: true, visit };
}
