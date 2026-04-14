/**
 * Traffic Service
 *
 * The browser reads the latest border-crossing snapshot from Firestore.
 * When no fresh snapshot is available, it falls back to the deterministic
 * mock model instead of calling a paid routing API directly from the client.
 */

import { reportCaughtError } from '@/services/errorReporter';
import { borderCrossings as centralizedCrossings } from '../data/borderCrossings';

interface BorderCrossingCoordinates {
 name: string;
}

export interface TrafficData {
 crossingName: string;
 waitTimeMinutes: number;
 status: 'green' | 'yellow' | 'red';
 direction: string;
 lastUpdate: Date;
 source: 'tomtom' | 'google-maps' | 'mock' | 'firestore';
 /** Traffic delay on the ≈500 m approach road on the Italian side (set by scheduled function) */
 approachMinutes?: number;
 /** Total estimated crossing time: approach delay + border queue (set by scheduled function) */
 totalCrossingMinutes?: number;
}

const BORDER_CROSSINGS: BorderCrossingCoordinates[] = centralizedCrossings
 .filter(c => c.trafficLevel !== 'closed')
 .map(c => ({ name: c.name }));

export function hasLiveTrafficData(data: TrafficData[]): boolean {
 return data.some(item => item.source === 'firestore' || item.source === 'tomtom' || item.source === 'google-maps');
}

class TrafficService {
 private cache: Map<string, { data: TrafficData; timestamp: number }> = new Map();
 private readonly CACHE_DURATION = 60 * 60 * 1000; // 1 ora

 /**
 * Priority order:
 * 1. Firestore `trafficCurrent` collection — written by the scheduled collector.
 * 2. Mock data — deterministic fallback when no fresh snapshot exists.
 */
 async getTrafficData(): Promise<TrafficData[]> {
 try {
 const firestoreData = await this.getTrafficDataFromFirestore();
 if (firestoreData.length > 0) {
 return firestoreData;
 }
 } catch (error) {
 reportCaughtError(error, 'traffic.firestoreRead');
 }

 return this.getMockTrafficData();
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
 console.warn('[trafficService] Firestore data is stale (>2 h old) — using mock data');
 return [];
 }

 return results;
 }

 private getMockTrafficData(): TrafficData[] {
 return BORDER_CROSSINGS.map(crossing => this.getMockTrafficForCrossing(crossing.name));
 }

 private getMockTrafficForCrossing(crossingName: string): TrafficData {
 const cacheKey = crossingName;
 const cached = this.cache.get(cacheKey);
 if (cached && Date.now() - cached.timestamp < this.CACHE_DURATION) {
 return cached.data;
 }

 const hour = new Date().getHours();
 const dayOfWeek = new Date().getDay();

 let baseWait = 3;
 let direction = 'Entrambi';

 if (crossingName.includes('Chiasso')) {
 baseWait = 8;
 }
 if (crossingName.includes('Gaggiolo') || crossingName.includes('Brogeda')) {
 baseWait = 6;
 }
 if (crossingName.includes('Ponte Tresa') || crossingName.includes('San Pietro') || crossingName.includes('Luino')) {
 baseWait = 5;
 }

 if (hour >= 7 && hour < 9) {
 baseWait *= crossingName.includes('Chiasso') ? 3 : 2;
 direction = 'IT → CH';
 }
 if (hour >= 17 && hour < 19) {
 baseWait *= crossingName.includes('Chiasso') ? 4 : 2.5;
 direction = 'CH → IT';
 }
 if (dayOfWeek === 5 && hour >= 16) {
 baseWait *= 1.5;
 }
 if (dayOfWeek === 0 && hour >= 17) {
 baseWait *= 1.3;
 }

 const variation = 0.7 + Math.random() * 0.6;
 const waitTimeMinutes = Math.round(baseWait * variation);

 let status: 'green' | 'yellow' | 'red';
 if (waitTimeMinutes < 5) status = 'green';
 else if (waitTimeMinutes < 15) status = 'yellow';
 else status = 'red';

 const trafficData: TrafficData = {
 crossingName,
 waitTimeMinutes,
 status,
 direction,
 lastUpdate: new Date(),
 source: 'mock',
 };

 this.cache.set(cacheKey, {
 data: trafficData,
 timestamp: Date.now(),
 });

 return trafficData;
 }

 clearCache() {
 this.cache.clear();
 }
}

export const trafficService = new TrafficService();
