/**
 * BFS Cross-Border Worker Statistics Service — read-only client.
 *
 * Data is refreshed server-side twice a day by the
 * `refresh-bfs-stats` GitHub Actions workflow, which writes the parsed
 * payload to Firestore `config/bfs_stats`. The client never fetches the
 * BFS CSV directly anymore — that flow caused the first visitor of every
 * hour to pay a ~1 MB CSV round-trip, and a stale-or-failed BFS endpoint
 * left the page with an error banner.
 *
 * Read order on the client:
 *   1. localStorage  bfs_stats_cache_v2  (instant, fresh < 1h)
 *   2. Firestore     config/bfs_stats   (shared across users)
 *   3. Stale localStorage / Firestore   (fallback)
 *
 * If Firestore is empty (very first deploy before the cron has run) the
 * caller surfaces a "data not yet available" state instead of trying to
 * scrape BFS from the browser.
 */

// ─── Types ───────────────────────────────────────────────────

export interface TrendPoint {
 year: string; // e.g. "2024-Q3"
 frontalieri: number;
}

export interface AgePoint {
 name: string; // e.g. "25-29"
 value: number;
}

export interface GenderTrendPoint {
 year: string;
 Uomini: number;
 Donne: number;
}

export interface GenderSnapshot {
 name: string; // "Uomini" | "Donne"
 value: number;
 pct: string;
 color: string;
}

export interface StatsData {
 trend: TrendPoint[];
 ages: AgePoint[];
 genderTrend: GenderTrendPoint[];
 genderSnapshot: GenderSnapshot[];
 lastUpdated: string; // ISO string
}

// ─── Constants ───────────────────────────────────────────────

export const SOURCE_LINK =
 'https://www.bfs.admin.ch/bfs/it/home/statistiche/industria-servizi.html';

const LOCAL_CACHE_KEY = 'bfs_stats_cache_v2';
const FIRESTORE_COLLECTION = 'config';
const FIRESTORE_DOC = 'bfs_stats';
export const STATS_CACHE_DURATION_MS = 60 * 60 * 1000;

import { reportCaughtError } from '@/services/errorReporter';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
 return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeFinite(value: unknown): value is number {
 return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
 return typeof value === 'string' && value.trim().length > 0;
}

/** Normalize an untrusted BFS payload while retaining valid points. */
export function normalizeStatsData(value: unknown): StatsData | null {
 if (!isPlainRecord(value)) return null;
 if (!Array.isArray(value.trend) || !Array.isArray(value.ages) || !Array.isArray(value.genderTrend) || !Array.isArray(value.genderSnapshot)) {
 return null;
 }
 if (!isNonEmptyString(value.lastUpdated)) return null;

 const trend = value.trend.flatMap((point): TrendPoint[] => {
  if (!isPlainRecord(point) || !isNonEmptyString(point.year) || !isNonNegativeFinite(point.frontalieri)) return [];
  return [{ year: point.year, frontalieri: point.frontalieri }];
 });
 if (trend.length === 0) return null;

 const ages = value.ages.flatMap((point): AgePoint[] => {
  if (!isPlainRecord(point) || !isNonEmptyString(point.name) || !isNonNegativeFinite(point.value)) return [];
  return [{ name: point.name, value: point.value }];
 });
 const genderTrend = value.genderTrend.flatMap((point): GenderTrendPoint[] => {
  if (!isPlainRecord(point) || !isNonEmptyString(point.year) || !isNonNegativeFinite(point.Uomini) || !isNonNegativeFinite(point.Donne)) return [];
  return [{ year: point.year, Uomini: point.Uomini, Donne: point.Donne }];
 });
 const genderSnapshot = value.genderSnapshot.flatMap((point): GenderSnapshot[] => {
  if (!isPlainRecord(point) || !isNonEmptyString(point.name) || !isNonNegativeFinite(point.value) || !isNonEmptyString(point.pct) || !isNonEmptyString(point.color)) return [];
  return [{ name: point.name, value: point.value, pct: point.pct, color: point.color }];
 });

 return { trend, ages, genderTrend, genderSnapshot, lastUpdated: value.lastUpdated };
}

/** Validate the persisted cache envelope, including freshness metadata. */
export function normalizeStatsCacheEntry(value: unknown, now = Date.now()): (StatsData & { timestamp: number }) | null {
 if (!isPlainRecord(value) || !isNonNegativeFinite(value.timestamp) || value.timestamp > now) return null;
 const stats = normalizeStatsData(value);
 return stats ? { ...stats, timestamp: value.timestamp } : null;
}

// ─── localStorage (L1 cache) ─────────────────────────────────

function getLocalCache(): (StatsData & { timestamp: number }) | null {
 try {
 const raw = localStorage.getItem(LOCAL_CACHE_KEY);
 if (!raw) return null;
 return normalizeStatsCacheEntry(JSON.parse(raw));
 } catch { /* ignore */ }
 return null;
}

function setLocalCache(stats: StatsData): void {
 try {
 localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify({
 ...stats,
 timestamp: Date.now(),
 }));
 } catch { /* ignore */ }
}

// ─── Firestore (L2 cache — shared across all clients) ────────

async function getFirestoreStats(): Promise<(StatsData & { timestamp: number }) | null> {
 try {
 const { getFirestore, doc, getDoc } = await import('firebase/firestore');
 const { getApp } = await import('@/services/firebase');
 const db = getFirestore(await getApp());
 const snap = await getDoc(doc(db, FIRESTORE_COLLECTION, FIRESTORE_DOC));
 if (snap.exists()) {
 const data = snap.data();
 const ts = typeof data.timestamp?.toMillis === 'function'
 ? data.timestamp.toMillis()
 : (data.timestamp ?? 0);
 const normalized = normalizeStatsCacheEntry({ ...data, timestamp: ts });
 if (normalized) return normalized;
 }
 } catch (e) {
 reportCaughtError(e, 'stats.firestoreRead', { apiEndpoint: `${FIRESTORE_COLLECTION}/${FIRESTORE_DOC}` });
 }
 return null;
}

// ─── Public API ──────────────────────────────────────────────

export type StatsSource = 'firestore' | 'cache' | 'error';

export interface StatsResult {
 data: StatsData | null;
 source: StatsSource;
 error?: string;
}

/**
 * Fetch BFS cross-border worker statistics.
 *
 * Read-only: never writes Firestore, never scrapes BFS. The cron worker is
 * the single producer; the browser just consumes.
 *
 * Strategy:
 *   1. Fresh localStorage cache (< 1h) → instant return.
 *   2. Firestore read → populate localStorage and return.
 *   3. Stale localStorage fallback if Firestore is unreachable.
 *   4. `{ data: null, source: 'error' }` only when both layers are empty
 *      (typically the very first deploy before the first cron run).
 */
export async function fetchStats(): Promise<StatsResult> {
 const now = Date.now();

 // 1. Fresh localStorage
 const local = getLocalCache();
 if (local && (now - local.timestamp) < STATS_CACHE_DURATION_MS) {
 return { data: local, source: 'cache' };
 }

 // 2. Firestore (single source of truth, refreshed server-side 2x/day)
 const firestore = await getFirestoreStats();
 if (firestore) {
 setLocalCache(firestore);
 return { data: firestore, source: 'firestore' };
 }

 // 3. Stale localStorage fallback
 if (local) {
 return { data: local, source: 'cache' };
 }

 return { data: null, source: 'error', error: 'No data available' };
}
