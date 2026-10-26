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

type StatsCacheData = StatsData & { timestamp: number };

function isRecord(value: unknown): value is Record<string, unknown> {
 return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
 return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
 return typeof value === 'number' && Number.isFinite(value);
}

function isValidLastUpdated(value: unknown): value is string {
 return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function normalizeCollection<T>(
 value: unknown,
 normalize: (item: unknown) => T | null,
): T[] | null {
 if (!Array.isArray(value)) return null;
 const normalized: T[] = [];
 for (const item of value) {
 const safeItem = normalize(item);
 if (safeItem) normalized.push(safeItem);
 }
 return normalized;
}

function normalizeTrendPoint(value: unknown): TrendPoint | null {
 if (!isRecord(value) || !isNonEmptyString(value.year) || !isFiniteNumber(value.frontalieri)) {
 return null;
 }
 return { year: value.year, frontalieri: value.frontalieri };
}

function normalizeAgePoint(value: unknown): AgePoint | null {
 if (!isRecord(value) || !isNonEmptyString(value.name) || !isFiniteNumber(value.value)) {
 return null;
 }
 return { name: value.name, value: value.value };
}

function normalizeGenderTrendPoint(value: unknown): GenderTrendPoint | null {
 if (
 !isRecord(value)
 || !isNonEmptyString(value.year)
 || !isFiniteNumber(value.Uomini)
 || !isFiniteNumber(value.Donne)
 ) {
 return null;
 }
 return { year: value.year, Uomini: value.Uomini, Donne: value.Donne };
}

function normalizeGenderSnapshot(value: unknown): GenderSnapshot | null {
 if (
 !isRecord(value)
 || !isNonEmptyString(value.name)
 || !isFiniteNumber(value.value)
 || !isNonEmptyString(value.pct)
 || !isNonEmptyString(value.color)
 ) {
 return null;
 }
 return {
 name: value.name,
 value: value.value,
 pct: value.pct,
 color: value.color,
 };
}

/**
 * Validate and normalize data crossing the localStorage/Firestore boundary.
 * Invalid points are discarded, but a missing collection invalidates the
 * envelope so consumers never receive a partially-shaped StatsData object.
 */
export function validateStatsData(value: unknown): StatsData | null {
 if (!isRecord(value) || !isValidLastUpdated(value.lastUpdated)) return null;

 const trend = normalizeCollection(value.trend, normalizeTrendPoint);
 const ages = normalizeCollection(value.ages, normalizeAgePoint);
 const genderTrend = normalizeCollection(value.genderTrend, normalizeGenderTrendPoint);
 const genderSnapshot = normalizeCollection(value.genderSnapshot, normalizeGenderSnapshot);

 if (!trend || !ages || !genderTrend || !genderSnapshot || trend.length === 0) return null;

 return {
 trend,
 ages,
 genderTrend,
 genderSnapshot,
 lastUpdated: value.lastUpdated,
 };
}

/** Return a numeric cache timestamp, including a Firestore Timestamp value. */
export function validateStatsCacheTimestamp(value: unknown): number | null {
 let timestamp = value;
 try {
 if (isRecord(value) && typeof value.toMillis === 'function') {
 timestamp = value.toMillis();
 }
 } catch {
 return null;
 }
 return isFiniteNumber(timestamp) && timestamp >= 0 ? timestamp : null;
}

export function validateStatsCachePayload(value: unknown): StatsCacheData | null {
 if (!isRecord(value)) return null;
 const data = validateStatsData(value);
 const timestamp = validateStatsCacheTimestamp(value.timestamp);
 if (!data || timestamp === null) return null;
 return { ...data, timestamp };
}

// ─── Constants ───────────────────────────────────────────────

export const SOURCE_LINK =
 'https://www.bfs.admin.ch/bfs/it/home/statistiche/industria-servizi.html';

const LOCAL_CACHE_KEY = 'bfs_stats_cache_v2';
const FIRESTORE_COLLECTION = 'config';
const FIRESTORE_DOC = 'bfs_stats';
export const STATS_CACHE_DURATION_MS = 60 * 60 * 1000;

import { reportCaughtError } from '@/services/errorReporter';

// ─── localStorage (L1 cache) ─────────────────────────────────

function getLocalCache(): StatsCacheData | null {
 try {
 const raw = localStorage.getItem(LOCAL_CACHE_KEY);
 if (!raw) return null;
 return validateStatsCachePayload(JSON.parse(raw));
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

async function getFirestoreStats(): Promise<StatsCacheData | null> {
 try {
 const { getFirestore, doc, getDoc } = await import('firebase/firestore');
 const { getApp } = await import('@/services/firebase');
 const db = getFirestore(await getApp());
 const snap = await getDoc(doc(db, FIRESTORE_COLLECTION, FIRESTORE_DOC));
 if (snap.exists()) {
 const data = validateStatsCachePayload(snap.data());
 if (data) return data;
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
