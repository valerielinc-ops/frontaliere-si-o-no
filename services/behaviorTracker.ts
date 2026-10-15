/**
 * Behavior Tracker — localStorage CRUD + Firestore sync for job personalization.
 *
 * Tracks: viewed jobs, search queries, filter usage, and bounded redirect-only
 * application-intent ranking keys.
 * Syncs to Firestore for logged-in users (cross-device).
 * localStorage is source of truth; Firestore is best-effort.
 */

import type { Firestore } from 'firebase/firestore';
import { resilientImport } from '@/services/resilientImport';
import { isStorageAvailable } from '@/services/storageAvailability';
import {
 activeApplicationIntentJobKeys,
 MAX_APPLICATION_INTENT_SCAN,
 MAX_APPLICATION_INTENT_SIGNALS,
 recordApplicationIntentSignal as updateApplicationIntentSignal,
} from '@/services/applicationIntentRanking.mjs';

// ─── Types ──────────────────────────────────────────────────────

export interface ViewedJob {
 slug: string;
 category: string;
 company: string;
 location: string;
 ts: number;
}

export interface SearchEntry {
 query: string;
 ts: number;
 resultCount: number;
}

export interface ApplicationIntentSignal {
 jobKey: string;
 application_status: 'redirect_only';
 timestamp: number;
 retentionUntil: number;
 /** Local-only account boundary; never sent as part of the remote projection. */
 authUid?: string;
}

export interface ApplicationIntentProfile {
 optedOut?: boolean;
 intents: ApplicationIntentSignal[];
}

export interface BehaviorData {
 version: 1;
 lastVisit: string | null;
 viewedJobs: ViewedJob[];
 searches: SearchEntry[];
 applicationIntent?: ApplicationIntentProfile;
 filterUsage: {
 category: Record<string, number>;
 location: Record<string, number>;
 contract: Record<string, number>;
 };
 syncedAt: number | null;
 /** Local owner of the account-bound application-intent projection. */
 applicationIntentAuthUid?: string;
}

/** Emitted when an application-intent preference or signal changes locally. */
export const BEHAVIOR_DATA_CHANGED_EVENT = 'frontaliere:behavior-data-changed';

// ─── Constants ──────────────────────────────────────────────────

const STORAGE_KEY = 'frontaliere_job_personalization';
const MAX_VIEWED_JOBS = 100;
const MAX_SEARCHES = 50;
const EXPIRY_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const SYNC_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

// ─── Internal helpers ───────────────────────────────────────────

function emptyBehavior(): BehaviorData {
 return {
 version: 1,
 lastVisit: null,
 viewedJobs: [],
 searches: [],
 filterUsage: { category: {}, location: {}, contract: {} },
 syncedAt: null,
 };
}

function readRaw(): BehaviorData {
 try {
 const raw = localStorage.getItem(STORAGE_KEY);
 if (!raw) return emptyBehavior();
 const parsed = JSON.parse(raw);
 if (!parsed || parsed.version !== 1) return emptyBehavior();
 return parsed as BehaviorData;
 } catch {
 // Corrupt data — reset
 try { localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
 return emptyBehavior();
 }
}

function writeRaw(data: BehaviorData): void {
 try {
 localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
 } catch (err: unknown) {
 // QuotaExceededError — prune 50% oldest entries and retry
 if (err instanceof DOMException && err.name === 'QuotaExceededError') {
 const half = Math.floor(data.viewedJobs.length / 2);
 data.viewedJobs = data.viewedJobs.slice(half);
 data.searches = data.searches.slice(Math.floor(data.searches.length / 2));
 try {
 localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
 } catch {
 // Give up silently
 }
 }
 }
}

function pruneExpired(data: BehaviorData): BehaviorData {
 const cutoff = Date.now() - EXPIRY_MS;
 return {
 ...data,
 viewedJobs: data.viewedJobs.filter((v) => v.ts > cutoff),
 searches: data.searches.filter((s) => s.ts > cutoff),
 applicationIntent: normalizeApplicationIntentProfile(data.applicationIntent),
 };
}

function epochMs(value: unknown): number {
 if (typeof value === 'number' && Number.isFinite(value)) return value;
 if (value instanceof Date) return value.getTime();
 if (value && typeof value === 'object' && 'toMillis' in value && typeof value.toMillis === 'function') {
 const timestamp = value.toMillis();
 return Number.isFinite(timestamp) ? timestamp : NaN;
 }
 if (typeof value === 'string' && value.trim()) {
 const timestamp = Date.parse(value);
 return Number.isFinite(timestamp) ? timestamp : NaN;
 }
 return NaN;
}

function normalizeApplicationIntentProfile(value: unknown): ApplicationIntentProfile | undefined {
 if (!value || typeof value !== 'object') return undefined;
 const source = value as Record<string, unknown>;
 const applicationIntent = {
 optedOut: source.optedOut === true,
 intents: Array.isArray(source.intents) ? source.intents : [],
 };
 const activeKeys = activeApplicationIntentJobKeys(applicationIntent);
 const latestByKey = new Map<string, ApplicationIntentSignal>();
 for (const raw of applicationIntent.intents.slice(-MAX_APPLICATION_INTENT_SCAN)) {
 if (!raw || typeof raw !== 'object') continue;
 const item = raw as Record<string, unknown>;
 const jobKey = typeof item.jobKey === 'string' ? item.jobKey.trim() : '';
 if (!jobKey || !activeKeys.has(jobKey) || item.application_status !== 'redirect_only') continue;
 const timestamp = epochMs(item.timestamp ?? item.ts ?? item.createdAt);
 const retentionUntil = epochMs(item.retentionUntil);
 if (!Number.isFinite(timestamp) || !Number.isFinite(retentionUntil)) continue;
 const prior = latestByKey.get(jobKey);
 if (!prior || timestamp > prior.timestamp) {
   const signal: ApplicationIntentSignal = {
    jobKey,
    application_status: 'redirect_only',
    timestamp,
    retentionUntil,
   };
   if (typeof item.authUid === 'string' && item.authUid.trim()) signal.authUid = item.authUid.trim();
   latestByKey.set(jobKey, signal);
 }
 }
 const result: ApplicationIntentProfile = {
 intents: [...latestByKey.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-MAX_APPLICATION_INTENT_SIGNALS),
 };
 if (source.optedOut === true) result.optedOut = true;
 else if (source.optedOut === false) result.optedOut = false;
 return result;
}

function pruneSize(data: BehaviorData): BehaviorData {
 return {
 ...data,
 viewedJobs: data.viewedJobs.length > MAX_VIEWED_JOBS
 ? data.viewedJobs.slice(-MAX_VIEWED_JOBS)
 : data.viewedJobs,
 searches: data.searches.length > MAX_SEARCHES
 ? data.searches.slice(-MAX_SEARCHES)
 : data.searches,
 };
}

function parseLastVisitTimestamp(data: BehaviorData): number | null {
 const timestamp = data.lastVisit ? new Date(data.lastVisit).getTime() : NaN;
 return Number.isFinite(timestamp) ? timestamp : null;
}

// ─── Public API ─────────────────────────────────────────────────

let _available: boolean | null = null;

function available(): boolean {
 if (_available === null) _available = isStorageAvailable();
 return _available;
}

function notifyBehaviorDataChanged(): void {
 if (typeof window === 'undefined') return;
 window.dispatchEvent(new Event(BEHAVIOR_DATA_CHANGED_EVENT));
}

function scopedApplicationIntentProfile(
 profile: ApplicationIntentProfile | undefined,
 accountUid: string,
): ApplicationIntentProfile | undefined {
 if (!profile) return undefined;
 const intents = profile.intents.filter((intent) => intent.authUid === accountUid);
 if (intents.length === 0 && profile.optedOut !== true) return undefined;
 return {
  ...profile,
  intents,
 };
}

function bindApplicationIntentProfile(
 profile: ApplicationIntentProfile | undefined,
 accountUid: string,
): ApplicationIntentProfile | undefined {
 if (!profile) return undefined;
 return {
  ...profile,
  intents: profile.intents.map((intent) => ({ ...intent, authUid: accountUid })),
 };
}

/**
 * Move the local projection across an Auth boundary without merging browser
 * history from the previous account. Anonymous signals and signals belonging
 * to another uid are deliberately discarded before the next account hydrates.
 */
export function setApplicationIntentAccount(accountUid?: string | null): void {
 if (!available()) return;
 const data = readRaw();
 const normalizedUid = typeof accountUid === 'string' ? accountUid.trim() : '';
 if (!normalizedUid) {
  if (data.applicationIntentAuthUid) {
   data.applicationIntent = undefined;
   delete data.applicationIntentAuthUid;
   writeRaw(pruneSize(pruneExpired(data)));
   notifyBehaviorDataChanged();
  }
  return;
 }

 if (data.applicationIntentAuthUid !== normalizedUid) {
  data.applicationIntent = undefined;
 } else {
  data.applicationIntent = scopedApplicationIntentProfile(data.applicationIntent, normalizedUid);
 }
 data.applicationIntentAuthUid = normalizedUid;
 writeRaw(pruneSize(pruneExpired(data)));
 notifyBehaviorDataChanged();
}

/** Read and prune behavior data from localStorage. */
export function getBehaviorData(): BehaviorData {
 if (!available()) return emptyBehavior();
 return pruneExpired(readRaw());
}

export function isApplicationIntentOptedOut(): boolean {
 return getBehaviorData().applicationIntent?.optedOut === true;
}

/** Record only the bounded ranking projection of an explicitly consented apply click. */
export function trackApplicationIntent(jobKey: string, now = Date.now(), accountUid?: string | null): boolean {
 if (!available()) return false;
 const data = pruneExpired(readRaw());
 const normalizedUid = typeof accountUid === 'string' ? accountUid.trim() : '';
 if (normalizedUid) {
  if (data.applicationIntentAuthUid !== normalizedUid) data.applicationIntent = undefined;
  data.applicationIntentAuthUid = normalizedUid;
  data.applicationIntent = scopedApplicationIntentProfile(data.applicationIntent, normalizedUid);
 } else if (data.applicationIntentAuthUid) {
  data.applicationIntent = undefined;
  delete data.applicationIntentAuthUid;
 }
 if (data.applicationIntent?.optedOut === true) return false;
 const updated = updateApplicationIntentSignal(data.applicationIntent, jobKey, now);
 if (updated.recorded && normalizedUid) {
  updated.applicationIntent = {
   ...updated.applicationIntent,
   intents: updated.applicationIntent.intents.map((intent) => (
    intent.jobKey === jobKey.trim() && intent.timestamp === now
     ? { ...intent, authUid: normalizedUid }
     : intent
   )),
  };
 }
 data.applicationIntent = normalizeApplicationIntentProfile(updated.applicationIntent);
 writeRaw(pruneSize(pruneExpired(data)));
 notifyBehaviorDataChanged();
 return updated.recorded;
}

/** Apply the authenticated purpose preference to the local ranking projection. */
export function setApplicationIntentOptOut(optedOut: boolean, accountUid?: string | null): void {
 if (!available()) return;
 const data = pruneExpired(readRaw());
 const normalizedUid = typeof accountUid === 'string' ? accountUid.trim() : '';
 data.applicationIntentAuthUid = normalizedUid || undefined;
 if (!normalizedUid) delete data.applicationIntentAuthUid;
 data.applicationIntent = { optedOut, intents: [] };
 writeRaw(pruneSize(data));
 notifyBehaviorDataChanged();
}

/**
 * Read the behavior snapshot for this visit, then record the new visit.
 *
 * The previous timestamp is returned separately because callers must compare
 * against it after the write. Keeping that boundary here also means a blocked
 * or corrupt localStorage behaves like a first visit without throwing.
 */
export function readBehaviorAndMarkVisit(): {
 data: BehaviorData;
 previousLastVisit: number | null;
} {
 if (!available()) return { data: emptyBehavior(), previousLastVisit: null };
 const data = pruneExpired(readRaw());
 const previousLastVisit = parseLastVisitTimestamp(data);
 data.lastVisit = new Date().toISOString();
 writeRaw(data);
 return { data, previousLastVisit };
}

/** Track a job view. */
export function trackJobViewBehavior(job: {
 slug: string;
 category: string;
 company: string;
 location: string;
}): void {
 if (!available() || !job.slug) return;
 const data = readRaw();
 // Dedupe by slug
 const existing = data.viewedJobs.findIndex((v) => v.slug === job.slug);
 if (existing >= 0) {
 data.viewedJobs[existing] = { ...job, ts: Date.now() };
 } else {
 data.viewedJobs.push({ ...job, ts: Date.now() });
 }
 writeRaw(pruneSize(data));
}

/** Track a search query. */
export function trackSearch(query: string, resultCount: number): void {
 if (!available()) return;
 const clean = String(query || '').trim();
 if (!clean) return;
 const data = readRaw();
 data.searches.push({ query: clean, ts: Date.now(), resultCount });
 writeRaw(pruneSize(data));
}

/** Track filter usage (category, location, contract). */
export function trackFilterUsage(filterType: 'category' | 'location' | 'contract', value: string): void {
 if (!available() || !value) return;
 const data = readRaw();
 const bucket = data.filterUsage[filterType];
 if (bucket) {
 bucket[value] = (bucket[value] || 0) + 1;
 }
 writeRaw(data);
}

/** Get last visit timestamp. */
export function getLastVisitTimestamp(): number | null {
 if (!available()) return null;
 const data = readRaw();
 return parseLastVisitTimestamp(data);
}

/** Update last visit to now. */
export function updateLastVisit(): void {
 if (!available()) return;
 const data = readRaw();
 data.lastVisit = new Date().toISOString();
 writeRaw(data);
}

// ─── Firestore sync ─────────────────────────────────────────────

type FirestoreRuntime = {
 db: Firestore;
 api: typeof import('firebase/firestore');
};

let _firestoreRuntimePromise: Promise<FirestoreRuntime | null> | null = null;
let _syncTimer: ReturnType<typeof setInterval> | null = null;
let _firestoreSyncQueue: Promise<void> = Promise.resolve();

function getFirestoreRuntime(): Promise<FirestoreRuntime | null> {
 if (!_firestoreRuntimePromise) {
  _firestoreRuntimePromise = (async (): Promise<FirestoreRuntime | null> => {
   try {
    const api = await resilientImport(
     () => import('firebase/firestore'),
     (m) => typeof m.getFirestore === 'function',
    );
    const { app } = await resilientImport(
     () => import('@/services/firebase'),
     (m) => m.app !== undefined,
    );
    return { db: api.getFirestore(app), api };
   } catch {
    return null;
   }
  })();
 }
 return _firestoreRuntimePromise;
}

/**
 * Sync behavior data to Firestore
 * (newsletter_subscribers/{email}/private/personalization).
 *
 * The UID marker is the account boundary for application-intent signals. It
 * is written only by an authenticated caller; email is deliberately not used
 * as an identity proof for this purpose.
 */
export function syncToFirestore(email: string, accountUid?: string | null): Promise<boolean> {
 if (!email || !available()) return Promise.resolve(false);
 const normalizedEmail = email.trim().toLowerCase();
 const normalizedAccountUid = typeof accountUid === 'string' ? accountUid.trim() : '';
 const snapshot = getBehaviorData();
 const ownsApplicationIntent = normalizedAccountUid
  && snapshot.applicationIntentAuthUid === normalizedAccountUid
  && (!snapshot.applicationIntent
   || snapshot.applicationIntent.intents.every((intent) => intent.authUid === normalizedAccountUid));
 const serializedApplicationIntent = ownsApplicationIntent && snapshot.applicationIntent
  ? {
   ...snapshot.applicationIntent,
   intents: snapshot.applicationIntent.intents.map(({ authUid: _authUid, ...intent }) => intent),
  }
  : undefined;
 const operation = _firestoreSyncQueue.then(async () => {
  try {
   const runtime = await getFirestoreRuntime();
   if (!runtime) return false;
   const { db, api } = runtime;
   // Capture at call time. Reading later could let a queued write from the
   // previous account serialize the next account's local signal under the old
   // email/uid pair.
   const data = snapshot;
   const { doc, setDoc } = api;
   await setDoc(
    doc(db, 'newsletter_subscribers', normalizedEmail, 'private', 'personalization'),
    {
     viewedJobs: data.viewedJobs,
     searches: data.searches,
     filterUsage: data.filterUsage,
     ...(serializedApplicationIntent ? { applicationIntent: serializedApplicationIntent } : {}),
     ...(normalizedAccountUid ? { applicationIntentAuthUid: normalizedAccountUid } : {}),
     lastSynced: new Date(),
    },
    { merge: true },
   );
   // Mark sync time locally
   const updated = readRaw();
   updated.syncedAt = Date.now();
   writeRaw(updated);
   return true;
  } catch {
   // Firestore unavailable — silent, localStorage-only mode
   return false;
  }
 });
 _firestoreSyncQueue = operation.then(() => undefined, () => undefined);
 return operation;
}

/** Hydrate behavior data from Firestore and merge with localStorage. */
export async function hydrateFromFirestore(email: string, accountUid?: string | null): Promise<boolean> {
 if (!email || !available()) return false;
 const normalizedAccountUid = typeof accountUid === 'string' ? accountUid.trim() : '';
 try {
 const normalizedEmail = email.trim().toLowerCase();
 const runtime = await getFirestoreRuntime();
 if (!runtime) return false;
 const { db, api } = runtime;
 const { doc, getDoc } = api;
 const normalizedUid = normalizedAccountUid;
 const userSnap = normalizedUid
  ? await getDoc(doc(db, 'users', normalizedUid))
  : null;
 const accountOptedOut = userSnap?.exists() && userSnap.data()?.applicationIntent?.optedOut === true;
 const snap = await getDoc(doc(db, 'newsletter_subscribers', normalizedEmail, 'private', 'personalization'));
 if (!snap.exists()) {
  if (normalizedUid) {
   const local = getBehaviorData();
   local.applicationIntentAuthUid = normalizedUid;
   local.applicationIntent = accountOptedOut ? { optedOut: true, intents: [] } : undefined;
   writeRaw(local);
   notifyBehaviorDataChanged();
  }
  return true;
 }
 const remote = snap.data();
 if (!remote) {
  if (normalizedUid) {
   const local = getBehaviorData();
   local.applicationIntentAuthUid = normalizedUid;
   local.applicationIntent = accountOptedOut ? { optedOut: true, intents: [] } : undefined;
   writeRaw(local);
   notifyBehaviorDataChanged();
  }
  return true;
 }

 const remoteIntent = normalizeApplicationIntentProfile(remote.applicationIntent);
 const remoteAccountUid = typeof remote.applicationIntentAuthUid === 'string'
  ? remote.applicationIntentAuthUid.trim()
  : '';
 const accountMatches = !normalizedUid || remoteAccountUid === normalizedUid;
 // A current users/{uid} preference is authoritative. A legacy opt-out with
 // no marker is retained for compatibility, but a signal bound to another uid
 // is never imported into this account.
 const applicationIntent = accountOptedOut
  ? { optedOut: true, intents: [] }
  : accountMatches
   ? (normalizedUid ? bindApplicationIntentProfile(remoteIntent, normalizedUid) : undefined)
   : (!remoteAccountUid && remoteIntent?.optedOut === true
    ? { optedOut: true, intents: [] }
    : undefined);

 const local = getBehaviorData();
 const localApplicationIntent = normalizedUid
  ? scopedApplicationIntentProfile(local.applicationIntent, normalizedUid)
  : undefined;

 const cloud: BehaviorData = {
 version: 1,
 lastVisit: null,
 viewedJobs: Array.isArray(remote.viewedJobs) ? remote.viewedJobs : [],
 searches: Array.isArray(remote.searches) ? remote.searches : [],
 applicationIntent,
 filterUsage: remote.filterUsage || { category: {}, location: {}, contract: {} },
 syncedAt: null,
 applicationIntentAuthUid: normalizedUid || undefined,
 };
 const localForMerge = {
  ...local,
  applicationIntent: accountOptedOut ? { optedOut: true, intents: [] } : localApplicationIntent,
  applicationIntentAuthUid: normalizedUid || undefined,
 };
 const merged = mergeBehavior(localForMerge, cloud);
 writeRaw(merged);
 return true;
 } catch {
 // Firestore unavailable — keep localStorage data
 return false;
 }
}

/** Union merge: combine local + cloud, dedupe by slug/query, keep most recent. */
export function mergeBehavior(local: BehaviorData, cloud: BehaviorData): BehaviorData {
 // Merge viewed jobs: union by slug, keep most recent timestamp
 const jobMap = new Map<string, ViewedJob>();
 for (const job of [...cloud.viewedJobs, ...local.viewedJobs]) {
 const existing = jobMap.get(job.slug);
 if (!existing || job.ts > existing.ts) {
 jobMap.set(job.slug, job);
 }
 }

 // Merge searches: concat and dedupe by query+ts
 const searchSet = new Set<string>();
 const mergedSearches: SearchEntry[] = [];
 for (const s of [...local.searches, ...cloud.searches]) {
 const key = `${s.query}|${s.ts}`;
 if (!searchSet.has(key)) {
 searchSet.add(key);
 mergedSearches.push(s);
 }
 }

 // Merge filter usage: sum counters
 const mergedFilters = { ...emptyBehavior().filterUsage };
 for (const type of ['category', 'location', 'contract'] as const) {
 const localBucket = local.filterUsage[type] || {};
 const cloudBucket = cloud.filterUsage[type] || {};
 const merged: Record<string, number> = {};
 for (const key of new Set([...Object.keys(localBucket), ...Object.keys(cloudBucket)])) {
 merged[key] = Math.max(localBucket[key] || 0, cloudBucket[key] || 0);
 }
 mergedFilters[type] = merged;
 }

 const ownerCandidates = [local.applicationIntentAuthUid, cloud.applicationIntentAuthUid]
  .filter((uid): uid is string => Boolean(uid));
 const applicationIntentAuthUid = ownerCandidates.length > 0
  && ownerCandidates.every((uid) => uid === ownerCandidates[0])
  ? ownerCandidates[0]
  : undefined;

 return pruneSize(pruneExpired({
 version: 1,
 lastVisit: local.lastVisit || cloud.lastVisit,
 viewedJobs: Array.from(jobMap.values()).sort((a, b) => a.ts - b.ts),
 searches: mergedSearches.sort((a, b) => a.ts - b.ts),
 applicationIntent: mergeApplicationIntentProfiles(local.applicationIntent, cloud.applicationIntent),
 filterUsage: mergedFilters,
 syncedAt: null,
  applicationIntentAuthUid,
 }));
}

function mergeApplicationIntentProfiles(
 local: ApplicationIntentProfile | undefined,
 cloud: ApplicationIntentProfile | undefined,
): ApplicationIntentProfile | undefined {
 if (!local && !cloud) return undefined;
 const optedOut = local?.optedOut === true || cloud?.optedOut === true;
 const byJob = new Map<string, ApplicationIntentSignal>();
 for (const intent of [...(cloud?.intents || []), ...(local?.intents || [])]) {
 const previous = byJob.get(intent.jobKey);
 if (!previous || intent.timestamp > previous.timestamp) byJob.set(intent.jobKey, intent);
 }
 const result: ApplicationIntentProfile = {
 intents: [...byJob.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-MAX_APPLICATION_INTENT_SIGNALS),
 };
 if (optedOut) result.optedOut = true;
 else if (local?.optedOut === false || cloud?.optedOut === false) result.optedOut = false;
 return result;
}

/** Start debounced sync interval for authenticated users. Returns cleanup function. */
export function startSyncInterval(
 email: string,
 profileHydrated = false,
 accountUid?: string | null,
): () => void {
 stopSyncInterval();
 let hydrated = profileHydrated;
 _syncTimer = setInterval(async () => {
  if (!hydrated) {
   hydrated = await hydrateFromFirestore(email, accountUid);
   if (!hydrated) return;
  }
  await syncToFirestore(email, accountUid);
 }, SYNC_DEBOUNCE_MS);

 // Best-effort sync on page unload
 const onUnload = () => {
  if (hydrated) void syncToFirestore(email, accountUid);
 };
 window.addEventListener('beforeunload', onUnload);

 return () => {
 stopSyncInterval();
 window.removeEventListener('beforeunload', onUnload);
 };
}

/** Stop sync interval. */
export function stopSyncInterval(): void {
 if (_syncTimer) {
 clearInterval(_syncTimer);
 _syncTimer = null;
 }
}
