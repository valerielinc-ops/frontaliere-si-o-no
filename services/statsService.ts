/**
 * BFS Cross-Border Worker Statistics Service
 *
 * Fetches cross-border worker stats from Swiss Federal Statistics (BFS)
 * SDMX REST API in CSV format and caches parsed results in Firestore.
 *
 * Data flow:
 * 1. localStorage cache (instant, same browser)
 * 2. Firestore cache (shared across all clients, refreshed once/hour)
 * 3. Remote CSV fetch (only if Firestore is stale > 1h)
 * 4. Save to Firestore + localStorage
 * 5. Fallback: stale Firestore → stale localStorage
 *
 * CSV source: Swiss SDMX REST – DF_GGS_6 (cross-border commuters by canton,
 * age group and gender).
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

const CSV_URL =
 'https://disseminate.stats.swiss/rest/data/CH1.GGS,DF_GGS_6,/all' +
 '?dimensionAtObservation=AllDimensions&format=csvfilewithlabels';

export const SOURCE_LINK =
 'https://www.bfs.admin.ch/bfs/it/home/statistiche/industria-servizi/imprese-addetti/statistica-frontalieri.html';

const LOCAL_CACHE_KEY = 'bfs_stats_cache_v2';
const FIRESTORE_COLLECTION = 'config';
const FIRESTORE_DOC = 'bfs_stats';
export const STATS_CACHE_DURATION_MS = 60 * 60 * 1000;
const SHOULD_LOG_STATS_WARNINGS = import.meta.env.MODE !== 'test';

import { reportCaughtError } from '@/services/errorReporter';

function statsWarn(...args: unknown[]): void {
 if (SHOULD_LOG_STATS_WARNINGS) {
 console.warn(...args);
 }
}

/** Ticino canton code in the SDMX dataset */
const TICINO = '21';

// ─── CSV Parsing ─────────────────────────────────────────────

/**
 * Column indices (from header):
 * 0 STRUCTURE
 * 1 STRUCTURE_ID
 * 2 STRUCTURE_NAME ← quoted, may contain commas
 * 3 ACTION
 * 4 FREQ
 * 5 Frequency of observation
 * 6 WORK_CANTON ← canton code ("21" = Ticino, "_T" = Total)
 * 7 Swiss cantons ← label
 * 8 SEX ← "_T" | "1" (male) | "2" (female)
 * 9 Gender ← label
 * 10 AGE_CLASS ← "_T" | "Y15T19" | …
 * 11 Age groups ← label
 * 12 TIME_PERIOD ← "2024-Q3"
 * 13 Quartal
 * 14 OBS_VALUE ← numeric string
 */

const COL_CANTON = 6;
const COL_SEX = 8;
const COL_AGE = 10;
const COL_AGE_LABEL = 11;
const COL_PERIOD = 12;
const COL_VALUE = 14;

interface CSVRow {
 canton: string;
 sex: string;
 ageClass: string;
 ageLabel: string;
 period: string;
 value: number;
}

/**
 * RFC 4180-compliant CSV line parser that handles quoted fields.
 */
function parseCSVLine(line: string): string[] {
 const fields: string[] = [];
 let current = '';
 let inQuotes = false;

 for (let i = 0; i < line.length; i++) {
 const ch = line[i];
 if (inQuotes) {
 if (ch === '"') {
 if (i + 1 < line.length && line[i + 1] === '"') {
 current += '"';
 i++; // skip escaped quote
 } else {
 inQuotes = false;
 }
 } else {
 current += ch;
 }
 } else {
 if (ch === '"') {
 inQuotes = true;
 } else if (ch === ',') {
 fields.push(current);
 current = '';
 } else {
 current += ch;
 }
 }
 }
 fields.push(current);
 return fields;
}

/**
 * Parse raw CSV text into typed rows (skipping the header).
 * Only keeps rows for Ticino canton to minimise memory usage.
 */
function parseCSV(raw: string): CSVRow[] {
 const lines = raw.split(/\r?\n/);
 const rows: CSVRow[] = [];

 for (let i = 1; i < lines.length; i++) {
 const line = lines[i].trim();
 if (!line) continue;
 const cols = parseCSVLine(line);
 if (cols.length < 15) continue;

 const canton = cols[COL_CANTON];
 // Only keep Ticino rows
 if (canton !== TICINO) continue;

 const val = parseFloat(cols[COL_VALUE]);
 if (isNaN(val)) continue;

 rows.push({
 canton,
 sex: cols[COL_SEX],
 ageClass: cols[COL_AGE],
 ageLabel: cols[COL_AGE_LABEL],
 period: cols[COL_PERIOD],
 value: Math.round(val),
 });
 }
 return rows;
}

// ─── Data Extraction ─────────────────────────────────────────

/**
 * Get last N quarters of total Ticino frontalieri (trend chart).
 */
function extractTrend(rows: CSVRow[], count = 20): TrendPoint[] {
 const totals = rows
 .filter(r => r.sex === '_T' && r.ageClass === '_T')
 .sort((a, b) => a.period.localeCompare(b.period));

 return totals.slice(-count).map(r => ({
 year: r.period,
 frontalieri: r.value,
 }));
}

/**
 * Age distribution for the latest available quarter.
 */
function extractAgeDistribution(rows: CSVRow[]): AgePoint[] {
 // Find the latest period with total data
 const totalRows = rows.filter(r => r.sex === '_T' && r.ageClass === '_T');
 if (totalRows.length === 0) return [];
 const latestPeriod = totalRows.sort((a, b) =>
 b.period.localeCompare(a.period))[0].period;

 // Age breakdown for that period (exclude _T total and unknown -9)
 const ageRows = rows
 .filter(r =>
 r.sex === '_T' &&
 r.ageClass !== '_T' &&
 r.ageClass !== '-9' &&
 r.period === latestPeriod
 )
 .sort((a, b) => a.ageClass.localeCompare(b.ageClass));

 return ageRows.map(r => ({
 name: r.ageLabel.replace(' years', '').replace(' or older', '+'),
 value: r.value,
 }));
}

/**
 * Gender trend: male + female series over last N quarters.
 */
function extractGenderTrend(rows: CSVRow[], count = 20): GenderTrendPoint[] {
 const maleMap = new Map<string, number>();
 const femaleMap = new Map<string, number>();

 for (const r of rows) {
 if (r.ageClass !== '_T') continue;
 if (r.sex === '1') maleMap.set(r.period, r.value);
 else if (r.sex === '2') femaleMap.set(r.period, r.value);
 }

 const periods = [...new Set([...maleMap.keys(), ...femaleMap.keys()])]
 .sort()
 .slice(-count);

 return periods
 .filter(p => maleMap.has(p) && femaleMap.has(p))
 .map(p => ({
 year: p,
 Uomini: maleMap.get(p)!,
 Donne: femaleMap.get(p)!,
 }));
}

/**
 * Gender snapshot (pie chart) for the latest quarter.
 */
function extractGenderSnapshot(rows: CSVRow[]): GenderSnapshot[] {
 const totalRows = rows.filter(r => r.sex === '_T' && r.ageClass === '_T');
 if (totalRows.length === 0) return [];
 const latestPeriod = totalRows.sort((a, b) =>
 b.period.localeCompare(a.period))[0].period;

 const male = rows.find(r =>
 r.sex === '1' && r.ageClass === '_T' && r.period === latestPeriod);
 const female = rows.find(r =>
 r.sex === '2' && r.ageClass === '_T' && r.period === latestPeriod);

 if (!male || !female) return [];

 const total = male.value + female.value;
 return [
 {
 name: 'Uomini',
 value: male.value,
 pct: ((male.value / total) * 100).toFixed(1),
 color: '#3b82f6',
 },
 {
 name: 'Donne',
 value: female.value,
 pct: ((female.value / total) * 100).toFixed(1),
 color: '#ec4899',
 },
 ];
}

/**
 * Parse CSV text and extract all stat datasets.
 */
function buildStatsFromCSV(raw: string): Omit<StatsData, 'lastUpdated'> | null {
 const rows = parseCSV(raw);
 if (rows.length === 0) return null;

 const trend = extractTrend(rows);
 const ages = extractAgeDistribution(rows);
 const genderTrend = extractGenderTrend(rows);
 const genderSnapshot = extractGenderSnapshot(rows);

 if (trend.length === 0) return null;

 return { trend, ages, genderTrend, genderSnapshot };
}

// ─── localStorage (L1 cache) ─────────────────────────────────

function getLocalCache(): (StatsData & { timestamp: number }) | null {
 try {
 const raw = localStorage.getItem(LOCAL_CACHE_KEY);
 if (!raw) return null;
 const data = JSON.parse(raw);
 if (data?.trend?.length > 0) return data;
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
 if (data?.trend?.length > 0) {
 const ts = typeof data.timestamp?.toMillis === 'function'
 ? data.timestamp.toMillis()
 : (data.timestamp ?? 0);
 return {
 trend: data.trend,
 ages: data.ages,
 genderTrend: data.genderTrend,
 genderSnapshot: data.genderSnapshot,
 lastUpdated: data.lastUpdated,
 timestamp: ts,
 };
 }
 }
 } catch (e) {
 reportCaughtError(e, 'stats.firestoreRead', { apiEndpoint: `${FIRESTORE_COLLECTION}/${FIRESTORE_DOC}` });
 }
 return null;
}

async function saveFirestoreStats(stats: StatsData): Promise<void> {
 try {
 const { getFirestore, doc, setDoc, serverTimestamp } = await import('firebase/firestore');
 const { getApp } = await import('@/services/firebase');
 const db = getFirestore(await getApp());
 await setDoc(doc(db, FIRESTORE_COLLECTION, FIRESTORE_DOC), {
 ...stats,
 timestamp: serverTimestamp(),
 });
 } catch (e) {
 reportCaughtError(e, 'stats.firestoreWrite', { apiEndpoint: `${FIRESTORE_COLLECTION}/${FIRESTORE_DOC}` });
 }
}

// ─── Remote CSV Fetch ────────────────────────────────────────

async function fetchRemoteCSV(): Promise<string | null> {
 try {
 const res = await fetch(CSV_URL);
 if (!res.ok) throw new Error(`HTTP ${res.status}`);
 return await res.text();
 } catch (e) {
 reportCaughtError(e, 'stats.bfsCsvFetch', { apiEndpoint: CSV_URL });
 return null;
 }
}

// ─── Public API ──────────────────────────────────────────────

export type StatsSource = 'remote' | 'firestore' | 'cache' | 'error';

export interface StatsResult {
 data: StatsData | null;
 source: StatsSource;
 error?: string;
}

/**
 * Fetch BFS cross-border worker statistics.
 *
 * Strategy:
 * 1. Return localStorage cache immediately if fresh (< 1h)
 * 2. Check Firestore cache — if fresh (< 1h), use it and update localStorage
 * 3. Fetch remote CSV, parse, save to Firestore + localStorage
 * 4. On remote failure, fall back to any available cache (even stale)
 *
 * @param forceRefresh Skip caches, go straight to remote CSV
 */
export async function fetchStats(forceRefresh = false): Promise<StatsResult> {
 const now = Date.now();

 // 1. localStorage (L1) — instant
 if (!forceRefresh) {
 const local = getLocalCache();
 if (local && (now - local.timestamp) < STATS_CACHE_DURATION_MS) {
 return { data: local, source: 'cache' };
 }
 }

 // 2. Firestore (L2) — shared across clients
 if (!forceRefresh) {
 const firestore = await getFirestoreStats();
 if (firestore && (now - firestore.timestamp) < STATS_CACHE_DURATION_MS) {
 setLocalCache(firestore); // populate L1
 return { data: firestore, source: 'firestore' };
 }
 }

 // 3. Remote CSV
 const csv = await fetchRemoteCSV();
 if (csv) {
 const parsed = buildStatsFromCSV(csv);
 if (parsed) {
 const stats: StatsData = {
 ...parsed,
 lastUpdated: new Date().toISOString(),
 };
 // Save to both caches in parallel
 setLocalCache(stats);
 saveFirestoreStats(stats).catch(() => {});
 return { data: stats, source: 'remote' };
 }
 }

 // 4. Fallback — any stale cache
 const staleFirestore = await getFirestoreStats();
 if (staleFirestore) {
 setLocalCache(staleFirestore);
 return { data: staleFirestore, source: 'firestore' };
 }

 const staleLocal = getLocalCache();
 if (staleLocal) {
 return { data: staleLocal, source: 'cache' };
 }

 return { data: null, source: 'error', error: 'No data available' };
}
