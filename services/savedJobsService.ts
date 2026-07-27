/**
 * Saved Jobs — Firestore-backed store for the job-board "Salvati" feature,
 * gated behind a real account (epic #4465, sub #4466/#4467, account-gating
 * follow-up).
 *
 * Registration required: saving now writes to `users/{uid}/savedJobs/{jobId}`
 * (one doc per job) instead of localStorage. An anonymous visitor's toggle
 * attempt is refused (`toggleSavedJob` returns `'auth_required'`, no write) —
 * the caller (`JobBoard.tsx`) is responsible for prompting sign-in and
 * replaying the toggle once `uid` becomes available.
 *
 * Firestore is the source of truth; `loadSavedJobs()` stays a SYNCHRONOUS,
 * dependency-free read (same contract as the old localStorage version) by
 * serving an in-memory cache that `subscribeSavedJobsFirestore()` keeps live
 * via `onSnapshot` — mirrors the split already used by
 * `services/readerEntitlement.ts` (sync flag read + async Firestore
 * subscription mounted once at the app root). A failed optimistic write
 * self-heals on the next snapshot rather than needing its own rollback path.
 *
 * `SAVED_JOBS_STORAGE_KEY` localStorage is now migration-source-only: on the
 * first Firestore subscription for a freshly-signed-in uid, any pre-existing
 * local entries are upserted (doc id = job id, so re-running is a no-op) then
 * the local key is cleared — carries forward saves made before this account
 * gate shipped instead of dropping them silently.
 *
 * Cross-component sync: every cache mutation (optimistic local change or a
 * live snapshot) dispatches SAVED_JOBS_CHANGED_EVENT on `window` so any
 * mounted consumer (list card, detail chip, filter pill counter) can re-read
 * without prop drilling through the 9k-line JobBoard.
 *
 * The nudge gating (threshold + dismiss cooldown) still lives here, unchanged
 * and still localStorage-based — it's a one-shot in-app UI cooldown, not
 * user data, so it isn't part of the account migration.
 */

import { isStorageAvailable } from '@/services/storageAvailability';
import { reportCaughtError } from '@/services/errorReporter';
import type { Firestore } from 'firebase/firestore';

export const SAVED_JOBS_STORAGE_KEY = 'frontaliere_saved_jobs';
export const SAVED_JOBS_CHANGED_EVENT = 'frontaliere:saved-jobs-changed';

/** Max persisted entries — oldest dropped first (both cache and Firestore docs). */
export const SAVED_JOBS_CAP = 100;

export interface SavedJobEntry {
  /** Stable job id (`JobListing.id`) — the match key against the loaded pool, and the Firestore doc id. */
  id: string;
  slug: string | null;
  title: string;
  company: string;
  canton: string | null;
  category: string | null;
  savedAt: number;
}

interface SavedJobsEnvelope {
  version: 1;
  jobs: SavedJobEntry[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeEntry(raw: unknown): SavedJobEntry | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
  return {
    id: raw.id,
    slug: typeof raw.slug === 'string' && raw.slug.length > 0 ? raw.slug : null,
    title: typeof raw.title === 'string' ? raw.title : '',
    company: typeof raw.company === 'string' ? raw.company : '',
    canton: typeof raw.canton === 'string' && raw.canton.length > 0 ? raw.canton : null,
    category: typeof raw.category === 'string' && raw.category.length > 0 ? raw.category : null,
    savedAt: typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : 0,
  };
}

// ── In-memory cache (Firestore is the source of truth) ─────────────────────

let cache: SavedJobEntry[] = [];

function dispatchChanged(): void {
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(SAVED_JOBS_CHANGED_EVENT));
    }
  } catch {
    // ignore
  }
}

function setCache(entries: SavedJobEntry[]): void {
  cache = entries;
  dispatchChanged();
}

/** Read the cached saved-jobs list (oldest first). Empty when signed out or not yet loaded. */
export function loadSavedJobs(): SavedJobEntry[] {
  return cache;
}

/** Whether a job id is currently saved (cache read, no network call). */
export function isJobSaved(jobId: string): boolean {
  if (!jobId) return false;
  return cache.some((entry) => entry.id === jobId);
}

// ── Firestore lazy access (keeps firebase/firestore out of the main bundle) ─

let _fs: typeof import('firebase/firestore') | null = null;
async function fs() {
  if (!_fs) _fs = await import('firebase/firestore');
  return _fs;
}

/** Test-only seam: firebase/firestore's conditional exports defeat vi.mock's dynamic-import interception under jsdom. */
export function __setFirestoreModuleForTests(mod: typeof import('firebase/firestore') | null): void {
  _fs = mod;
}

let db: Firestore | null = null;

/** Discard the cached Firestore instance to force a fresh connection (iOS Safari IndexedDB loss). */
function resetFirestoreConnection(): void {
  db = null;
}

function isIndexedDbError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error || '');
  return msg.includes('Indexed Database') || msg.includes('IDBDatabase')
    || msg.includes('IndexedDB') || msg.includes('internal error was encountered');
}

async function getDb(): Promise<Firestore> {
  if (!db) {
    const [{ getApp }, { getFirestore }] = await Promise.all([
      import('@/services/firebase'),
      fs(),
    ]);
    db = getFirestore(await getApp());
  }
  return db;
}

function savedJobDocData(entry: SavedJobEntry): Record<string, unknown> {
  return {
    slug: entry.slug,
    title: entry.title,
    company: entry.company,
    canton: entry.canton,
    category: entry.category,
    savedAt: entry.savedAt,
  };
}

async function writeSavedJobDoc(uid: string, entry: SavedJobEntry): Promise<void> {
  try {
    const [firestore, f] = await Promise.all([getDb(), fs()]);
    await f.setDoc(f.doc(firestore, 'users', uid, 'savedJobs', entry.id), savedJobDocData(entry));
  } catch (error) {
    if (isIndexedDbError(error)) resetFirestoreConnection();
    reportCaughtError(error, 'savedJobsService.writeSavedJobDoc');
  }
}

async function deleteSavedJobDoc(uid: string, jobId: string): Promise<void> {
  try {
    const [firestore, f] = await Promise.all([getDb(), fs()]);
    await f.deleteDoc(f.doc(firestore, 'users', uid, 'savedJobs', jobId));
  } catch (error) {
    if (isIndexedDbError(error)) resetFirestoreConnection();
    reportCaughtError(error, 'savedJobsService.deleteSavedJobDoc');
  }
}

export type ToggleSavedJobResult = 'saved' | 'unsaved' | 'auth_required';

/** Shared "add" branch for toggleSavedJob and ensureSavedJob — applies the cap/eviction and writes through. */
function addSavedJobEntry(entry: Omit<SavedJobEntry, 'savedAt'>, uid: string): 'saved' {
  const savedEntry: SavedJobEntry = { ...entry, savedAt: Date.now() };
  let next = [...cache, savedEntry];
  const overflow = next.length - SAVED_JOBS_CAP;
  let dropped: SavedJobEntry[] = [];
  if (overflow > 0) {
    dropped = [...next].sort((a, b) => a.savedAt - b.savedAt).slice(0, overflow);
    const droppedIds = new Set(dropped.map((d) => d.id));
    next = next.filter((e) => !droppedIds.has(e.id));
  }
  setCache(next);
  void writeSavedJobDoc(uid, savedEntry);
  for (const d of dropped) void deleteSavedJobDoc(uid, d.id);
  return 'saved';
}

/**
 * Toggle a job in the saved list for a signed-in user. `uid` null/undefined
 * (anonymous visitor) refuses the write and returns `'auth_required'` — the
 * caller prompts sign-in and re-calls this once `uid` is known. The cache is
 * updated optimistically (and SAVED_JOBS_CHANGED_EVENT dispatched)
 * synchronously; the Firestore write happens in the background and
 * self-heals from the live snapshot if it fails.
 */
export function toggleSavedJob(
  entry: Omit<SavedJobEntry, 'savedAt'>,
  uid: string | null | undefined,
): ToggleSavedJobResult {
  if (!uid) return 'auth_required';

  const alreadySaved = cache.some((e) => e.id === entry.id);
  if (alreadySaved) {
    setCache(cache.filter((e) => e.id !== entry.id));
    void deleteSavedJobDoc(uid, entry.id);
    return 'unsaved';
  }

  return addSavedJobEntry(entry, uid);
}

export type EnsureSavedJobResult = 'saved' | 'already_saved' | 'auth_required';

/**
 * Idempotent add-only variant of toggleSavedJob — NEVER un-saves. Used by the
 * cross-tab pending-save replay (services/pendingSaveJob.ts): two tabs racing
 * to replay the same intent (e.g. a magic-link email opened in a fresh tab
 * while the original tab also picks up the auth-state change) must not
 * toggle each other off, since a genuine toggle reading stale cache state
 * would flip an already-saved job back out. Worst case here is a harmless
 * duplicate `setDoc` to the same doc id.
 */
export function ensureSavedJob(
  entry: Omit<SavedJobEntry, 'savedAt'>,
  uid: string | null | undefined,
): EnsureSavedJobResult {
  if (!uid) return 'auth_required';
  if (cache.some((e) => e.id === entry.id)) return 'already_saved';
  return addSavedJobEntry(entry, uid);
}

// ── localStorage → Firestore migration (one-time per uid, per page load) ───

const initializedUids = new Set<string>();

/**
 * Test-only reset of the module-scoped Firestore-sync state (`cache` +
 * `initializedUids`). Needed because `tests/services/savedJobsService.test.ts`
 * mocks `firebase/firestore`, and `vi.resetModules()` + a fresh dynamic
 * `import()` per test does NOT reliably re-apply that mock to the
 * freshly-loaded module instance (real Firestore calls leaked through in
 * practice) — a plain exported reset keeps the persistence tests isolated
 * without fighting that.
 */
export function __resetSavedJobsCacheForTests(): void {
  cache = [];
  initializedUids.clear();
}

function readLocalSavedJobs(): SavedJobEntry[] {
  if (!isStorageAvailable()) return [];
  try {
    const raw = localStorage.getItem(SAVED_JOBS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.jobs)) return [];
    const entries: SavedJobEntry[] = [];
    const seen = new Set<string>();
    for (const item of parsed.jobs) {
      const entry = sanitizeEntry(item);
      if (entry && !seen.has(entry.id)) {
        seen.add(entry.id);
        entries.push(entry);
      }
    }
    return entries;
  } catch {
    return [];
  }
}

async function migrateLocalSavedJobs(uid: string): Promise<void> {
  const localEntries = readLocalSavedJobs();
  if (localEntries.length === 0) return;

  try {
    const [firestore, f] = await Promise.all([getDb(), fs()]);
    const batch = f.writeBatch(firestore);
    for (const entry of localEntries.slice(-SAVED_JOBS_CAP)) {
      batch.set(f.doc(firestore, 'users', uid, 'savedJobs', entry.id), savedJobDocData(entry), { merge: true });
    }
    await batch.commit();
    if (isStorageAvailable()) localStorage.removeItem(SAVED_JOBS_STORAGE_KEY);
  } catch (error) {
    if (isIndexedDbError(error)) resetFirestoreConnection();
    reportCaughtError(error, 'savedJobsService.migrateLocalSavedJobs');
    // Leave localStorage intact — migration is retried on the next login.
  }
}

/**
 * Owner-only profile fields the digest + this migration need. Only written
 * on first-ever creation of `users/{uid}` (see below) or refreshed on later
 * logins for `email`/`locale` — `savedJobsDigest.optedOut` is deliberately
 * NEVER touched again after creation so a digest unsubscribe flip (set
 * server-side by `savedJobsDigestUnsubscribe`) can't be clobbered by a
 * subsequent client re-login re-defaulting it to `false`.
 */
async function ensureUserProfileDoc(
  uid: string,
  meta: { email: string | null; locale: string } | undefined,
): Promise<void> {
  try {
    const [firestore, f] = await Promise.all([getDb(), fs()]);
    const ref = f.doc(firestore, 'users', uid);
    const existing = await f.getDoc(ref);
    if (!existing.exists()) {
      await f.setDoc(ref, {
        email: meta?.email ?? null,
        locale: meta?.locale ?? 'it',
        savedJobsDigest: { optedOut: false },
      });
    } else if (meta) {
      await f.setDoc(ref, { email: meta.email, locale: meta.locale }, { merge: true });
    }
  } catch (error) {
    if (isIndexedDbError(error)) resetFirestoreConnection();
    reportCaughtError(error, 'savedJobsService.ensureUserProfileDoc');
  }
}

export interface SavedJobsSubscriptionMeta {
  email: string | null;
  locale: string;
}

/**
 * Mount once near the app root, keyed off the authenticated user's uid (same
 * pattern as `subscribeReaderEntitlement`). A falsy uid (signed-out visitor)
 * clears the cache immediately and returns a no-op unsubscribe. For a
 * signed-in uid: runs the local→Firestore migration + profile-doc init once
 * per uid per page load, then keeps the cache live via `onSnapshot`.
 */
export function subscribeSavedJobsFirestore(
  uid: string | null | undefined,
  meta?: SavedJobsSubscriptionMeta,
): () => void {
  if (!uid) {
    setCache([]);
    return () => {};
  }

  let cancelled = false;
  let unsubscribeSnapshot: (() => void) | null = null;

  (async () => {
    if (!initializedUids.has(uid)) {
      initializedUids.add(uid);
      await migrateLocalSavedJobs(uid);
      await ensureUserProfileDoc(uid, meta);
    }
    if (cancelled) return;

    try {
      const [firestore, f] = await Promise.all([getDb(), fs()]);
      const q = f.query(
        f.collection(firestore, 'users', uid, 'savedJobs'),
        f.orderBy('savedAt', 'asc'),
      );
      if (cancelled) return;
      unsubscribeSnapshot = f.onSnapshot(
        q,
        (snap) => {
          const entries: SavedJobEntry[] = [];
          snap.forEach((docSnap) => {
            const sanitized = sanitizeEntry({ id: docSnap.id, ...docSnap.data() });
            if (sanitized) entries.push(sanitized);
          });
          setCache(entries);
        },
        (error) => {
          if (isIndexedDbError(error)) resetFirestoreConnection();
          // Read failure (offline / rules) — leave the last cached list in
          // place rather than flipping to empty on a transient blip. The
          // next successful snapshot reconciles it either way.
          reportCaughtError(error, 'savedJobsService.onSnapshot');
        },
      );
    } catch (error) {
      reportCaughtError(error, 'savedJobsService.subscribeSavedJobsFirestore');
    }
  })();

  return () => {
    cancelled = true;
    if (unsubscribeSnapshot) unsubscribeSnapshot();
  };
}

// ── Alert-criteria derivation (#4467) ───────────────────────────────────────
// Moved to savedJobsAlertCriteria.ts (relative-imports-only) so
// scripts/send-saved-jobs-digest.mjs can import it directly under plain Node
// — this file's `@/`-aliased imports only resolve under Vite. Re-exported
// here unchanged so JobBoard.tsx / tests keep resolving the same symbols.
export { deriveSavedJobsAlertCriteria, type SavedJobsAlertCriteria } from './savedJobsAlertCriteria';

// ── Nudge gating (#4467) ────────────────────────────────────────────────────

export const SAVED_JOBS_NUDGE_STORAGE_KEY = 'frontaliere_saved_jobs_nudge';
/** Minimum saved jobs before the alert nudge may show. */
export const SAVED_JOBS_NUDGE_THRESHOLD = 2;
/** After an explicit dismiss, stay quiet for this long. */
export const NUDGE_DISMISS_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

export interface SavedJobsNudgeState {
  /** Epoch ms of the last explicit dismiss, or null. */
  dismissedAt: number | null;
  /** Epoch ms of a successful accept — terminal, nudge never returns. */
  acceptedAt: number | null;
}

function defaultNudgeState(): SavedJobsNudgeState {
  return { dismissedAt: null, acceptedAt: null };
}

export function loadNudgeState(): SavedJobsNudgeState {
  if (!isStorageAvailable()) return defaultNudgeState();
  try {
    const raw = localStorage.getItem(SAVED_JOBS_NUDGE_STORAGE_KEY);
    if (!raw) return defaultNudgeState();
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return defaultNudgeState();
    return {
      dismissedAt:
        typeof parsed.dismissedAt === 'number' && Number.isFinite(parsed.dismissedAt)
          ? parsed.dismissedAt
          : null,
      acceptedAt:
        typeof parsed.acceptedAt === 'number' && Number.isFinite(parsed.acceptedAt)
          ? parsed.acceptedAt
          : null,
    };
  } catch {
    return defaultNudgeState();
  }
}

export function saveNudgeState(state: SavedJobsNudgeState): void {
  if (!isStorageAvailable()) return;
  try {
    localStorage.setItem(SAVED_JOBS_NUDGE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

/**
 * Whether the alert nudge may show: threshold reached, never accepted, and
 * any previous dismiss older than the cooldown window.
 */
export function shouldShowSavedJobsNudge(
  savedCount: number,
  state: SavedJobsNudgeState,
  now: Date,
): boolean {
  if (savedCount < SAVED_JOBS_NUDGE_THRESHOLD) return false;
  if (state.acceptedAt !== null) return false;
  if (state.dismissedAt !== null && now.getTime() - state.dismissedAt < NUDGE_DISMISS_COOLDOWN_MS) {
    return false;
  }
  return true;
}

/** Immutable state transition for an explicit dismiss. */
export function recordNudgeDismissed(state: SavedJobsNudgeState, now: Date): SavedJobsNudgeState {
  return { ...state, dismissedAt: now.getTime() };
}

/** Immutable state transition for a successful accept (terminal). */
export function recordNudgeAccepted(state: SavedJobsNudgeState, now: Date): SavedJobsNudgeState {
  return { ...state, acceptedAt: now.getTime() };
}
