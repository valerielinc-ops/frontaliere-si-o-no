/**
 * Behavior Tracker — localStorage CRUD + Firestore sync for job personalization.
 *
 * Tracks: viewed jobs, search queries, filter usage.
 * Syncs to Firestore for logged-in users (cross-device).
 * localStorage is source of truth; Firestore is best-effort.
 */

import type { Firestore } from 'firebase/firestore';

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

export interface BehaviorData {
 version: 1;
 lastVisit: string | null;
 viewedJobs: ViewedJob[];
 searches: SearchEntry[];
 filterUsage: {
 category: Record<string, number>;
 location: Record<string, number>;
 contract: Record<string, number>;
 };
 syncedAt: number | null;
}

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

function isStorageAvailable(): boolean {
 try {
 const key = '__fs_test__';
 localStorage.setItem(key, '1');
 localStorage.removeItem(key);
 return true;
 } catch {
 return false;
 }
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
 };
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

// ─── Public API ─────────────────────────────────────────────────

let _available: boolean | null = null;

function available(): boolean {
 if (_available === null) _available = isStorageAvailable();
 return _available;
}

/** Read and prune behavior data from localStorage. */
export function getBehaviorData(): BehaviorData {
 if (!available()) return emptyBehavior();
 return pruneExpired(readRaw());
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
 return data.lastVisit ? new Date(data.lastVisit).getTime() : null;
}

/** Update last visit to now. */
export function updateLastVisit(): void {
 if (!available()) return;
 const data = readRaw();
 data.lastVisit = new Date().toISOString();
 writeRaw(data);
}

// ─── Firestore sync ─────────────────────────────────────────────

let _db: Firestore | null = null;
let _dbInit = false;
let _syncTimer: ReturnType<typeof setInterval> | null = null;

async function getDb(): Promise<Firestore | null> {
 if (!_dbInit) {
 _dbInit = true;
 try {
 const { getFirestore } = await import('firebase/firestore');
 const { app } = await import('@/services/firebase');
 _db = getFirestore(app);
 } catch {
 _db = null;
 }
 }
 return _db;
}

/** Sync behavior data to Firestore (newsletter_subscribers/{email}/private/personalization). */
export async function syncToFirestore(email: string): Promise<void> {
 if (!email || !available()) return;
 try {
 const db = await getDb();
 if (!db) return;
 const data = getBehaviorData();
 const { doc, setDoc } = await import('firebase/firestore');
 await setDoc(
 doc(db, 'newsletter_subscribers', email, 'private', 'personalization'),
 {
 viewedJobs: data.viewedJobs,
 searches: data.searches,
 filterUsage: data.filterUsage,
 lastSynced: new Date(),
 },
 { merge: true },
 );
 // Mark sync time locally
 const updated = readRaw();
 updated.syncedAt = Date.now();
 writeRaw(updated);
 } catch {
 // Firestore unavailable — silent, localStorage-only mode
 }
}

/** Hydrate behavior data from Firestore and merge with localStorage. */
export async function hydrateFromFirestore(email: string): Promise<void> {
 if (!email || !available()) return;
 try {
 const db = await getDb();
 if (!db) return;
 const { doc, getDoc } = await import('firebase/firestore');
 const snap = await getDoc(doc(db, 'newsletter_subscribers', email, 'private', 'personalization'));
 if (!snap.exists()) return;
 const remote = snap.data();
 if (!remote) return;

 const cloud: BehaviorData = {
 version: 1,
 lastVisit: null,
 viewedJobs: Array.isArray(remote.viewedJobs) ? remote.viewedJobs : [],
 searches: Array.isArray(remote.searches) ? remote.searches : [],
 filterUsage: remote.filterUsage || { category: {}, location: {}, contract: {} },
 syncedAt: null,
 };
 const local = getBehaviorData();
 const merged = mergeBehavior(local, cloud);
 writeRaw(merged);
 } catch {
 // Firestore unavailable — keep localStorage data
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

 return pruneSize(pruneExpired({
 version: 1,
 lastVisit: local.lastVisit || cloud.lastVisit,
 viewedJobs: Array.from(jobMap.values()).sort((a, b) => a.ts - b.ts),
 searches: mergedSearches.sort((a, b) => a.ts - b.ts),
 filterUsage: mergedFilters,
 syncedAt: null,
 }));
}

/** Start debounced sync interval for authenticated users. Returns cleanup function. */
export function startSyncInterval(email: string): () => void {
 stopSyncInterval();
 _syncTimer = setInterval(() => {
 syncToFirestore(email);
 }, SYNC_DEBOUNCE_MS);

 // Best-effort sync on page unload
 const onUnload = () => {
 syncToFirestore(email);
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
