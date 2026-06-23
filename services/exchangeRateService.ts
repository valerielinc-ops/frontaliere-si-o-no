/**
 * Centralized Exchange Rate Manager
 *
 * Single source of truth for CHF→EUR exchange rates across the entire app.
 * Every component must use fetchExchangeRate() or useExchangeRate() from here.
 *
 * Flow:
 * 1. In-memory cache (instant, same session)
 * 2. Firestore cache (config/exchange_rate doc, shared across all clients)
 * 3. If stale (>5 min) → fetch live from TwelveData API
 * 4. Save new rate to Firestore + localStorage
 * 5. Fallback: expired Firestore → expired localStorage → hardcoded default
 */

import { useState, useEffect, useCallback } from 'react';
import { reportCaughtError } from '@/services/errorReporter';
import { resilientImport } from '@/services/resilientImport';

const CACHE_KEY = 'exchange_rate_cache';
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes
const DEFAULT_RATE = 0.94;
const IS_TEST_ENV = typeof process !== 'undefined' && (process.env.NODE_ENV === 'test' || !!process.env.VITEST);

/** Which source provided the current rate */
export type RateSource = 'twelvedata' | 'firestore' | 'cache' | 'fallback';

interface CacheEntry {
 rate: number;
 timestamp: number;
 source?: RateSource;
}

// Track the last source for diagnostics
let lastSource: RateSource = 'fallback';

// In-memory singleton: once fetched, all hook instances share the same value
let memoryRate: number | null = null;
let memoryTimestamp = 0;

/** Returns which API source provided the current rate */
export function getRateSource(): RateSource {
 return lastSource;
}

// ─── localStorage cache (offline / instant fallback) ─────────

function getLocalCache(): CacheEntry | null {
 try {
 const cached = localStorage.getItem(CACHE_KEY);
 if (!cached) return null;
 return JSON.parse(cached) as CacheEntry;
 } catch {
 return null;
 }
}

function setLocalCache(rate: number, source: RateSource): void {
 try {
 const entry: CacheEntry = { rate, timestamp: Date.now(), source };
 localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
 } catch { /* ignore */ }
}

// ─── Firestore cache (shared across all clients) ─────────────

async function getFirestoreRate(): Promise<CacheEntry | null> {
 if (IS_TEST_ENV) return null;
 try {
 const { getFirestore, doc, getDoc } = await resilientImport(
 () => import('firebase/firestore'),
 (m) => typeof m.getFirestore === 'function',
 );
 const { getApp } = await resilientImport(
 () => import('@/services/firebase'),
 (m) => typeof m.getApp === 'function',
 );
 const db = getFirestore(await getApp());
 const snap = await getDoc(doc(db, 'config', 'exchange_rate'));
 if (snap.exists()) {
 const data = snap.data();
 if (data?.rate && data?.timestamp) {
 return {
 rate: data.rate,
 timestamp: typeof data.timestamp?.toMillis === 'function'
 ? data.timestamp.toMillis()
 : data.timestamp,
 source: 'firestore',
 };
 }
 }
 } catch (e) {
 // Permission errors are expected for anonymous users — don't inflate error metrics
 const msg = e instanceof Error ? e.message : String(e);
 if (msg.includes('permission') || msg.includes('Permission') || msg.includes('PERMISSION_DENIED')) {
 console.warn('[ExchangeRate] Firestore read blocked: insufficient permissions');
 } else {
 reportCaughtError(e, 'exchangeRate.firestoreRead', { apiEndpoint: 'config/exchange_rate' });
 }
 }
 return null;
}

// Cache Firestore write permission failures to avoid repeated attempts
let firestoreWriteBlocked = false;

async function saveFirestoreRate(rate: number): Promise<void> {
 if (IS_TEST_ENV || firestoreWriteBlocked) return;
 try {
 const { getFirestore, doc, getDoc, setDoc, serverTimestamp } = await resilientImport(
 () => import('firebase/firestore'),
 (m) => typeof m.getFirestore === 'function',
 );
 const { getApp } = await resilientImport(
 () => import('@/services/firebase'),
 (m) => typeof m.getApp === 'function',
 );
 const db = getFirestore(await getApp());
 const ref = doc(db, 'config', 'exchange_rate');
 // Preserve previous rate for weekly comparison
 let previousRate: number | null = null;
 try {
 const snap = await getDoc(ref);
 if (snap.exists()) {
 previousRate = snap.data()?.rate ?? null;
 }
 } catch { /* proceed without previousRate */ }
 await setDoc(ref, {
 rate,
 ...(previousRate !== null && { previousRate }),
 timestamp: serverTimestamp(),
 updatedAt: new Date().toISOString(),
 source: 'twelvedata',
 });
 } catch (e) {
 const msg = e instanceof Error ? e.message : String(e);
 if (msg.includes('permission') || msg.includes('Permission') || msg.includes('PERMISSION_DENIED')) {
 firestoreWriteBlocked = true;
 console.warn('[ExchangeRate] Firestore write blocked: insufficient permissions');
 }
 }
}

// ─── Live rate (via getExchangeRate Cloud Function) ──────────

// Live rate now comes from the getExchangeRate Cloud Function, which calls
// TwelveData server-side (retries + the API key stay off the browser).
const EXCHANGE_RATE_ENDPOINT = 'https://europe-west6-frontaliere-ticino.cloudfunctions.net/getExchangeRate';

async function fetchFromTwelveData(): Promise<number | null> {
 if (IS_TEST_ENV) return null;
 const controller = new AbortController();
 const timeoutId = setTimeout(() => controller.abort(), 6000);
 try {
 const res = await fetch(EXCHANGE_RATE_ENDPOINT, { signal: controller.signal });
 if (!res.ok) return null;
 const data = await res.json();
 return data?.ok && typeof data.rate === 'number' ? data.rate : null;
 } catch (e) {
 const isAbort = (e instanceof Error && e.name === 'AbortError') || (e instanceof DOMException && e.name === 'AbortError');
 if (!isAbort) {
 reportCaughtError(e, 'exchangeRate.cfFetch', { apiEndpoint: EXCHANGE_RATE_ENDPOINT });
 }
 return null;
 } finally {
 clearTimeout(timeoutId);
 }
}

// ─── Main fetch function ─────────────────────────────────────

/**
 * Fetch the latest CHF→EUR exchange rate.
 *
 * Resolution order:
 * 1. In-memory cache (if < 5 min old)
 * 2. Firestore cache (if < 5 min old) — shared across all clients
 * 3. TwelveData API → save to Firestore + localStorage
 * 4. Expired Firestore / localStorage cache
 * 5. Hardcoded default (0.94)
 */
export async function fetchExchangeRate(): Promise<number> {
 const now = Date.now();

 // 1. In-memory cache (fastest, same session)
 if (memoryRate !== null && (now - memoryTimestamp) < CACHE_DURATION) {
 lastSource = 'cache';
 return memoryRate;
 }

 // 2. Firestore cache (shared across all users/tabs)
 const firestoreEntry = await getFirestoreRate();
 if (firestoreEntry && (now - firestoreEntry.timestamp) < CACHE_DURATION) {
 lastSource = 'firestore';
 memoryRate = firestoreEntry.rate;
 memoryTimestamp = firestoreEntry.timestamp;
 setLocalCache(firestoreEntry.rate, 'firestore');
 return firestoreEntry.rate;
 }

 // 3. Fetch live from TwelveData
 const liveRate = await fetchFromTwelveData();
 if (liveRate !== null) {
 lastSource = 'twelvedata';
 memoryRate = liveRate;
 memoryTimestamp = now;
 setLocalCache(liveRate, 'twelvedata');
 // Save to Firestore (fire-and-forget, don't block the user)
 saveFirestoreRate(liveRate).catch(() => {});
 return liveRate;
 }

 // 4. Expired Firestore cache (better than nothing)
 if (firestoreEntry) {
 lastSource = 'firestore';
 memoryRate = firestoreEntry.rate;
 memoryTimestamp = firestoreEntry.timestamp;
 return firestoreEntry.rate;
 }

 // 5. Expired localStorage cache (offline fallback)
 const localEntry = getLocalCache();
 if (localEntry) {
 lastSource = 'cache';
 memoryRate = localEntry.rate;
 memoryTimestamp = localEntry.timestamp;
 return localEntry.rate;
 }

 // 6. Hardcoded fallback
 lastSource = 'fallback';
 return DEFAULT_RATE;
}

/**
 * React hook to get the live CHF/EUR exchange rate.
 * Centralizes exchange rate usage across the entire app.
 * All components using this hook share the same cached value.
 */
export function useExchangeRate(): {
 rate: number;
 loading: boolean;
 lastUpdate: Date | null;
 source: RateSource;
 refresh: () => void;
} {
 const [rate, setRate] = useState<number>(() => {
 if (memoryRate !== null) return memoryRate;
 return getLocalCache()?.rate || DEFAULT_RATE;
 });
 const [loading, setLoading] = useState(false);
 const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
 const [source, setSource] = useState<RateSource>('fallback');

 const load = useCallback(async () => {
 setLoading(true);
 try {
 const r = await fetchExchangeRate();
 setRate(r);
 setSource(getRateSource());
 setLastUpdate(new Date());
 } finally {
 setLoading(false);
 }
 }, []);

 useEffect(() => {
 load();
 // Refresh every 5 minutes
 const interval = setInterval(load, CACHE_DURATION);
 return () => clearInterval(interval);
 }, [load]);

 return { rate, loading, lastUpdate, source, refresh: load };
}

/**
 * Check if TwelveData API key is configured.
 * Used by ApiStatus component.
 */
export async function isTwelveDataConfigured(): Promise<boolean> {
 // The TwelveData key is now server-side (getExchangeRate Cloud Function); the
 // browser no longer holds it, so there is nothing to check client-side.
 return true;
}

// ─── Historical exchange rate data (Firestore-cached) ────────

export type HistoryPoint = { date: string; rate: number };
export type HistoryPeriod = '1m' | '3m' | '6m' | '1y' | '5y';

const HISTORY_LOCAL_KEY = 'ft_exchange_history_';

function getHistoryDateRange(period: HistoryPeriod): { startStr: string; endStr: string } {
 const end = new Date();
 const start = new Date();
 switch (period) {
 case '1m': start.setMonth(end.getMonth() - 1); break;
 case '3m': start.setMonth(end.getMonth() - 3); break;
 case '6m': start.setMonth(end.getMonth() - 6); break;
 case '1y': start.setFullYear(end.getFullYear() - 1); break;
 case '5y': start.setFullYear(end.getFullYear() - 5); break;
 }
 return {
 startStr: start.toISOString().split('T')[0],
 endStr: end.toISOString().split('T')[0],
 };
}

/** Read history from localStorage (instant offline fallback) */
function getLocalHistory(period: HistoryPeriod): { points: HistoryPoint[]; lastDate: string } | null {
 try {
 const raw = localStorage.getItem(HISTORY_LOCAL_KEY + period);
 if (!raw) return null;
 const parsed = JSON.parse(raw);
 if (Array.isArray(parsed?.points) && parsed.points.length > 0 && parsed.lastDate) {
 return parsed;
 }
 } catch { /* ignore */ }
 return null;
}

function setLocalHistory(period: HistoryPeriod, points: HistoryPoint[]): void {
 try {
 const lastDate = points[points.length - 1]?.date || '';
 localStorage.setItem(HISTORY_LOCAL_KEY + period, JSON.stringify({ points, lastDate }));
 } catch { /* ignore */ }
}

/** Read history from Firestore (shared across all clients) */
async function getHistoryFromFirestore(period: HistoryPeriod): Promise<{ points: HistoryPoint[]; lastDate: string } | null> {
 if (IS_TEST_ENV) return null;
 try {
 const { getFirestore, doc, getDoc } = await resilientImport(
 () => import('firebase/firestore'),
 (m) => typeof m.getFirestore === 'function',
 );
 const { getApp } = await resilientImport(
 () => import('@/services/firebase'),
 (m) => typeof m.getApp === 'function',
 );
 const db = getFirestore(await getApp());
 const snap = await getDoc(doc(db, 'exchangeHistory', `chf-eur-${period}`));
 if (snap.exists()) {
 const data = snap.data();
 if (Array.isArray(data?.points) && data.points.length > 0 && data?.lastDate) {
 return { points: data.points as HistoryPoint[], lastDate: data.lastDate };
 }
 }
 } catch (e) {
 const msg = e instanceof Error ? e.message : String(e);
 if (msg.includes('permission') || msg.includes('Permission') || msg.includes('PERMISSION_DENIED')) {
 console.warn('[ExchangeRate] Firestore history read blocked: insufficient permissions');
 } else {
 reportCaughtError(e, 'exchangeRate.firestoreHistoryRead', { apiEndpoint: `exchangeHistory/chf-eur-${period}` });
 }
 }
 return null;
}

/** Fetch from a Frankfurter-compatible API (v2) */
async function fetchFrankfurter(baseUrl: string, startStr: string, endStr: string): Promise<HistoryPoint[]> {
 const controller = new AbortController();
 const timeoutId = setTimeout(() => controller.abort(), 8000);
 try {
 const res = await fetch(
 `${baseUrl}/v2/rates?base=CHF&quotes=EUR&from=${startStr}&to=${endStr}`,
 { signal: controller.signal }
 );
 if (!res.ok) throw new Error(`HTTP ${res.status}`);
 const data = await res.json();
 if (!Array.isArray(data) || data.length === 0) throw new Error('No rates in response');
 return data.map((entry: { date: string; rate: number }) => ({
 date: entry.date,
 rate: entry.rate,
 }));
 } finally {
 clearTimeout(timeoutId);
 }
}

/** Fetch from ECB Data API */
async function fetchEcbHistory(startStr: string, endStr: string): Promise<HistoryPoint[]> {
 const controller = new AbortController();
 const timeoutId = setTimeout(() => controller.abort(), 10000);
 try {
 const ecbRes = await fetch(
 `https://data-api.ecb.europa.eu/service/data/EXR/D.CHF.EUR.SP00.A?startPeriod=${startStr}&endPeriod=${endStr}&format=csvdata`,
 { signal: controller.signal }
 );
 const csv = await ecbRes.text();
 const lines = csv.split('\n');
 const points: HistoryPoint[] = [];
 for (let i = 1; i < lines.length; i++) {
 const cols = lines[i].split(',');
 if (cols.length < 8) continue;
 const date = cols[6];
 const obsValue = parseFloat(cols[7]);
 if (!date || isNaN(obsValue) || obsValue === 0) continue;
 points.push({ date, rate: +(1 / obsValue).toFixed(6) });
 }
 return points;
 } finally {
 clearTimeout(timeoutId);
 }
}

/**
 * Fetch historical CHF→EUR exchange rate data for a given period.
 *
 * Resolution order (client is read-only — a daily cron job keeps Firestore fresh):
 * 1. Firestore (authoritative, updated daily by update-exchange-history.mjs)
 * 2. localStorage cache (offline / instant fallback)
 * 3. Frankfurter API (emergency fallback if Firestore is empty) → save to localStorage only
 *
 * @param period - Time period: '1m', '3m', '6m', '1y', '5y'
 * @param liveRate - Current live rate to append as today's data point
 * @returns Array of { date, rate } points sorted chronologically
 */
export async function fetchExchangeHistory(
 period: HistoryPeriod,
 liveRate?: number | null,
): Promise<HistoryPoint[]> {
 // 1. Firestore (authoritative source, updated by daily cron)
 const firestoreCache = await getHistoryFromFirestore(period);
 if (firestoreCache && firestoreCache.points.length > 0) {
 setLocalHistory(period, firestoreCache.points);
 return appendLiveRate(firestoreCache.points, liveRate);
 }

 // 2. localStorage (offline fallback — even if stale, better than nothing)
 const localCache = getLocalHistory(period);
 if (localCache && localCache.points.length > 0) {
 return appendLiveRate(localCache.points, liveRate);
 }

 // 3. Emergency fallback: fetch from Frankfurter API directly
 const { startStr, endStr } = getHistoryDateRange(period);
 let points: HistoryPoint[] = [];

 try {
 points = await fetchFrankfurter('https://api.frankfurter.dev', startStr, endStr);
 } catch {
 try {
 points = await fetchFrankfurter('https://api.frankfurter.app', startStr, endStr);
 } catch (e2) {
 reportCaughtError(e2, 'exchangeRate.frankfurterFallback', { apiEndpoint: 'api.frankfurter.app' });
 try {
 points = await fetchEcbHistory(startStr, endStr);
 } catch (e3) {
 reportCaughtError(e3, 'exchangeRate.allHistoryApisFailed');
 }
 }
 }

 if (points.length > 0) {
 setLocalHistory(period, points);
 }

 return appendLiveRate(points, liveRate);
}

/** Append today's live rate if not already the last data point */
function appendLiveRate(points: HistoryPoint[], liveRate?: number | null): HistoryPoint[] {
 if (!liveRate || points.length === 0) return points;
 const today = new Date().toISOString().split('T')[0];
 const result = [...points];
 if (result[result.length - 1].date !== today) {
 result.push({ date: today, rate: liveRate });
 }
 return result;
}
