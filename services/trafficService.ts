/**
 * Traffic Service
 *
 * The browser reads the latest border-crossing snapshot from Firestore.
 * When no fresh Firestore snapshot is available, it falls back to the last-known
 * committed snapshot (data/border-wait-current.json) — the SAME real values the
 * static /traffico-dogane/<crossing>/oggi/ pages render — instead of calling a
 * paid routing API or fabricating random numbers on the client. The latter used
 * to make pages disagree (issue #2997): the guide page showed an invented
 * "5 min" while /traffico-dogane/.../oggi/ correctly showed "0 min".
 */

import { reportCaughtError } from '@/services/errorReporter';
import { borderCrossings as centralizedCrossings } from '../data/borderCrossings';
import borderWaitCurrent from '../data/border-wait-current.json';
import { slugifyCrossingName } from './borderCrossingSlug';

const IS_TEST_ENV = typeof process !== 'undefined' && (process.env.NODE_ENV === 'test' || !!process.env.VITEST);
const TRAFFIC_LS_KEY = 'traffic_current_cache';
const TRAFFIC_LS_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface BorderCrossingCoordinates {
 name: string;
}

export interface TrafficData {
 crossingName: string;
 waitTimeMinutes: number;
 status: 'green' | 'yellow' | 'red';
 direction: string;
 lastUpdate: Date;
 source: 'tomtom' | 'google-maps' | 'here' | 'webcam' | 'mock' | 'firestore';
 /** Traffic delay on the ≈500 m approach road on the Italian side (set by scheduled function) */
 approachMinutes?: number;
 /** Total estimated crossing time: approach delay + border queue (set by scheduled function) */
 totalCrossingMinutes?: number;
}

/** Shape of the committed snapshot consumed as the non-live fallback. */
interface BorderWaitSnapshotEntry {
 waitTimeMinutes?: number;
 approachMinutes?: number;
 totalCrossingMinutes?: number;
 status?: string;
 source?: string;
 lastUpdate?: string;
}
interface BorderWaitSnapshot {
 updatedAt?: string;
 perCrossing?: Record<string, BorderWaitSnapshotEntry>;
}

const BORDER_WAIT_SNAPSHOT = borderWaitCurrent as BorderWaitSnapshot;

// trafficLevel undefined just means "no historical trafficLevel label
// assigned yet" (e.g. non-Ticino borders added later), NOT 'closed' — see
// data/borderCrossings.ts doc comment. Filtering on `!== undefined` here
// left the fallback snapshot blind to every non-Ticino crossing (111/143,
// issue #4892 sibling fix); only crossings actually marked closed drop out.
const BORDER_CROSSINGS: BorderCrossingCoordinates[] = centralizedCrossings
 .filter(c => c.trafficLevel !== 'closed')
 .map(c => ({ name: c.name }));

export function hasLiveTrafficData(data: TrafficData[]): boolean {
 return data.some(item => item.source === 'firestore' || item.source === 'tomtom' || item.source === 'google-maps' || item.source === 'here' || item.source === 'webcam');
}

class TrafficService {
 private readLocalCache(): TrafficData[] | null {
 if (IS_TEST_ENV) return null;
 try {
 const raw = localStorage.getItem(TRAFFIC_LS_KEY);
 if (!raw) return null;
 const parsed = JSON.parse(raw);
 if (!Array.isArray(parsed?.data) || typeof parsed.timestamp !== 'number') return null;
 if ((Date.now() - parsed.timestamp) >= TRAFFIC_LS_TTL_MS) return null;
 return (parsed.data as Array<{
 crossingName: string; waitTimeMinutes: number; status: string; direction: string;
 lastUpdateMs: number; source: string; approachMinutes?: number; totalCrossingMinutes?: number;
 }>).map(d => ({
 crossingName: d.crossingName,
 waitTimeMinutes: d.waitTimeMinutes,
 status: d.status as TrafficData['status'],
 direction: d.direction,
 lastUpdate: new Date(d.lastUpdateMs),
 source: d.source as TrafficData['source'],
 approachMinutes: d.approachMinutes,
 totalCrossingMinutes: d.totalCrossingMinutes,
 }));
 } catch { return null; }
 }

 private writeLocalCache(data: TrafficData[]): void {
 if (IS_TEST_ENV) return;
 try {
 localStorage.setItem(TRAFFIC_LS_KEY, JSON.stringify({
 data: data.map(d => ({
 crossingName: d.crossingName,
 waitTimeMinutes: d.waitTimeMinutes,
 status: d.status,
 direction: d.direction,
 lastUpdateMs: d.lastUpdate.getTime(),
 source: d.source,
 approachMinutes: d.approachMinutes,
 totalCrossingMinutes: d.totalCrossingMinutes,
 })),
 timestamp: Date.now(),
 }));
 } catch { /* ignore */ }
 }

 /**
 * Priority order:
 * 1. localStorage cache (fresh < 5 min) — skip Firestore on repeat page loads.
 * 2. Firestore `trafficCurrent` collection — written by the scheduled collector.
 * 3. Committed snapshot (data/border-wait-current.json) — last-known REAL values,
 *    the same source the static /traffico-dogane/.../oggi/ pages render, used
 *    when no fresh Firestore data is available. Never random/fabricated (#2997).
 */
 async getTrafficData(): Promise<TrafficData[]> {
 // 1. Fresh localStorage cache
 const cached = this.readLocalCache();
 if (cached) return cached;

 try {
 const firestoreData = await this.getTrafficDataFromFirestore();
 if (firestoreData.length > 0) {
 this.writeLocalCache(firestoreData);
 return firestoreData;
 }
 } catch (error) {
 reportCaughtError(error, 'traffic.firestoreRead');
 }

 return this.getFallbackTrafficData();
 }

 /**
 * Used by diagnostics UI to tell whether the live scheduler is currently feeding Firestore.
 */
 async hasFreshTrafficSnapshot(): Promise<boolean> {
 try {
 const firestoreData = await this.getTrafficDataFromFirestore();
 return firestoreData.length > 0;
 } catch (error) {
 reportCaughtError(error, 'traffic.snapshotStatus');
 return false;
 }
 }

 /**
 * Reads the latest traffic snapshot for all crossings from Firestore.
 * Returns an empty array when the collection is empty or the data is stale
 * (scheduler inactive for more than 2 hours).
 */
 private async getTrafficDataFromFirestore(): Promise<TrafficData[]> {
 const { getApp } = await import('./firebase');
 const { getFirestore, collection, getDocs } = await import('firebase/firestore');

 const app = await getApp();
 const db = getFirestore(app);
 const snapshot = await getDocs(collection(db, 'trafficCurrent'));

 if (snapshot.empty) return [];

 const results: TrafficData[] = [];
 const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000;
 const now = Date.now();

 snapshot.forEach(docSnap => {
 const d = docSnap.data();
 let lastUpdate;
 if (d.lastUpdate && typeof d.lastUpdate.toDate === 'function') {
 lastUpdate = d.lastUpdate.toDate();
 } else {
 console.warn(`[trafficService] Missing lastUpdate for Firestore doc ${docSnap.id}`);
 lastUpdate = new Date(d.lastUpdate ?? Date.now());
 }

 results.push({
 crossingName: d.crossingName,
 waitTimeMinutes: d.waitTimeMinutes ?? 0,
 status: d.status ?? 'green',
 direction: d.direction ?? 'Entrambi',
 lastUpdate,
 source: 'firestore',
 approachMinutes: d.approachMinutes,
 totalCrossingMinutes: d.totalCrossingMinutes,
 });
 });

 if (results.length > 0 && results.every(r => now - r.lastUpdate.getTime() > STALE_THRESHOLD_MS)) {
 console.warn('[trafficService] Firestore data is stale (>2 h old) — using committed snapshot fallback');
 return [];
 }

 return results;
 }

 /**
 * Non-live fallback: the last-known committed snapshot
 * (data/border-wait-current.json), keyed by `slugifyCrossingName`. These are
 * REAL recorded values (the same the static /traffico-dogane/.../oggi/ pages
 * show), not fabricated — so the guide page and the oggi page agree (#2997).
 *
 * Entries are tagged `source: 'mock'` so `hasLiveTrafficData()` still treats
 * the UI as "not live" (we cannot confirm current conditions without a live
 * feed); the displayed minutes are the real last-known figure, never random.
 * A crossing missing from the snapshot falls back to 0 / green (no queue).
 */
 private getFallbackTrafficData(): TrafficData[] {
 const perCrossing = BORDER_WAIT_SNAPSHOT.perCrossing ?? {};
 const snapshotUpdate = BORDER_WAIT_SNAPSHOT.updatedAt;
 return BORDER_CROSSINGS.map(({ name }) => {
 const entry = perCrossing[slugifyCrossingName(name)];
 return {
 crossingName: name,
 waitTimeMinutes: entry?.waitTimeMinutes ?? 0,
 status: (entry?.status as TrafficData['status']) ?? 'green',
 direction: 'Entrambi',
 lastUpdate: new Date(entry?.lastUpdate ?? snapshotUpdate ?? Date.now()),
 source: 'mock',
 approachMinutes: entry?.approachMinutes,
 totalCrossingMinutes: entry?.totalCrossingMinutes,
 };
 });
 }

 /**
 * Clears the localStorage cache so the next `getTrafficData()` call re-reads
 * Firestore. Called by tests (beforeEach) and by callers that force a refresh.
 */
 clearCache() {
 try { localStorage.removeItem(TRAFFIC_LS_KEY); } catch { /* ignore */ }
 }
}

export const trafficService = new TrafficService();
