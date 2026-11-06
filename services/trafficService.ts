/**
 * Traffic Service
 *
 * The browser reads the latest border-crossing snapshot from a cached public
 * read model. The server reads Firestore, so page visits do not each create a
 * billed client read. When no fresh snapshot is available, it falls back to the last-known
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
import { PUBLIC_TRAFFIC_CURRENT_URL } from './publicTrafficEndpoints';

const IS_TEST_ENV = typeof process !== 'undefined' && (process.env.NODE_ENV === 'test' || !!process.env.VITEST);
const TRAFFIC_LS_KEY = 'traffic_current_cache';
const TRAFFIC_LS_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface BorderCrossingCoordinates {
 name: string;
}

export interface TrafficData {
 crossingName: string;
 waitTimeMinutes?: number;
 status?: TrafficStatus;
 lastUpdate: Date;
 source: 'tomtom' | 'google-maps' | 'google-routes' | 'here' | 'mapbox' | 'geoapify' | 'openrouteservice' | 'graphhopper' | 'stadia' | 'traffic-mesh' | 'official+webcam' | 'official' | 'webcam' | 'mock' | 'firestore';
 /** Traffic delay on the ≈500 m approach road on the Italian side (set by scheduled function) */
 approachMinutes?: number;
 /** Total estimated crossing time: approach delay + border queue (set by scheduled function) */
 totalCrossingMinutes?: number;
 officialSources?: string;
 officialLastUpdate?: string;
 officialQueueKm?: number;
 dataQuality?: string;
}

export type TrafficStatus = 'green' | 'yellow' | 'red';

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

const TRAFFIC_STATUSES: readonly TrafficStatus[] = ['green', 'yellow', 'red'];

function finiteNumber(value: unknown): number | undefined {
 return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizedTrafficStatus(value: unknown): TrafficStatus | undefined {
 return typeof value === 'string' && TRAFFIC_STATUSES.includes(value as TrafficStatus)
  ? value as TrafficStatus
  : undefined;
}

type PublicFirestoreValue = {
 stringValue?: string;
 integerValue?: string | number;
 doubleValue?: number;
 booleanValue?: boolean;
 timestampValue?: string;
 nullValue?: null;
};

function decodePublicFirestoreValue(value: unknown): unknown {
 const encoded = value as PublicFirestoreValue | undefined;
 if (!encoded || typeof encoded !== 'object') return undefined;
 if (typeof encoded.stringValue === 'string') return encoded.stringValue;
 if (typeof encoded.integerValue === 'string' || typeof encoded.integerValue === 'number') {
  const parsed = Number(encoded.integerValue);
  return Number.isFinite(parsed) ? parsed : undefined;
 }
 if (typeof encoded.doubleValue === 'number' && Number.isFinite(encoded.doubleValue)) return encoded.doubleValue;
 if (typeof encoded.booleanValue === 'boolean') return encoded.booleanValue;
 if (typeof encoded.timestampValue === 'string') {
  const parsed = new Date(encoded.timestampValue);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
 }
 if ('nullValue' in encoded) return null;
 return undefined;
}

/** Parse the allowlisted public read model without trusting malformed rows. */
export function parsePublicTrafficCurrent(payload: unknown, nowMs = Date.now()): TrafficData[] {
 const documents = (payload as { documents?: unknown[] } | null)?.documents;
 if (!Array.isArray(documents)) throw new Error('invalid trafficCurrent response');

 const results: TrafficData[] = [];
 const staleThresholdMs = 2 * 60 * 60 * 1000;
 for (const document of documents) {
  const fields = (document as { fields?: Record<string, unknown> } | null)?.fields;
  const crossingName = decodePublicFirestoreValue(fields?.crossingName);
  const lastUpdate = decodePublicFirestoreValue(fields?.lastUpdate);
  const waitTimeMinutes = finiteNumber(decodePublicFirestoreValue(fields?.waitTimeMinutes));
  const totalCrossingMinutes = finiteNumber(decodePublicFirestoreValue(fields?.totalCrossingMinutes));

  if (
   typeof crossingName !== 'string'
   || !(lastUpdate instanceof Date)
   || Number.isNaN(lastUpdate.getTime())
   || (waitTimeMinutes === undefined && totalCrossingMinutes === undefined)
  ) {
   console.warn('[trafficService] Incomplete public traffic reading');
   continue;
  }

  const status = normalizedTrafficStatus(decodePublicFirestoreValue(fields?.status));
  results.push({
   crossingName,
   ...(waitTimeMinutes === undefined ? {} : { waitTimeMinutes }),
   ...(status === undefined ? {} : { status }),
   lastUpdate,
   source: 'firestore',
   approachMinutes: finiteNumber(decodePublicFirestoreValue(fields?.approachMinutes)),
   ...(totalCrossingMinutes === undefined ? {} : { totalCrossingMinutes }),
  });
 }

 const freshResults = results.filter(result => nowMs - result.lastUpdate.getTime() <= staleThresholdMs);
 if (results.length > 0 && freshResults.length === 0) {
  console.warn('[trafficService] Public traffic data is stale (>2 h) — using committed snapshot fallback');
  return [];
 }

 if (freshResults.length < results.length) {
  console.warn('[trafficService] Ignoring stale public traffic readings while keeping fresh crossings');
 }

 return freshResults;
}

/** Total crossing time wins, while preserving a missing reading as missing. */
export function effectiveTrafficWaitMinutes(
 data: Pick<TrafficData, 'waitTimeMinutes' | 'totalCrossingMinutes'> | null | undefined,
): number | null {
 for (const value of [data?.totalCrossingMinutes, data?.waitTimeMinutes]) {
  const minutes = finiteNumber(value);
  if (minutes !== undefined) return minutes;
 }
 return null;
}

/** Build one honest snapshot fallback without inventing status or collapsing fields. */
export function buildFallbackTrafficData(
 crossingName: string,
 entry: BorderWaitSnapshotEntry | undefined,
 snapshotUpdate?: string,
): TrafficData | null {
 const waitTimeMinutes = finiteNumber(entry?.waitTimeMinutes);
 const totalCrossingMinutes = finiteNumber(entry?.totalCrossingMinutes);
 if (waitTimeMinutes === undefined && totalCrossingMinutes === undefined) return null;

 const status = normalizedTrafficStatus(entry?.status);
 return {
  crossingName,
  ...(waitTimeMinutes === undefined ? {} : { waitTimeMinutes }),
  ...(status === undefined ? {} : { status }),
  lastUpdate: new Date(entry?.lastUpdate ?? snapshotUpdate ?? Date.now()),
  source: 'mock',
  approachMinutes: entry?.approachMinutes,
  ...(totalCrossingMinutes === undefined ? {} : { totalCrossingMinutes }),
 };
}

// trafficLevel undefined just means "no historical trafficLevel label
// assigned yet" (e.g. non-Ticino borders added later), NOT 'closed' — see
// data/borderCrossings.ts doc comment. Filtering on `!== undefined` here
// left the fallback snapshot blind to every non-Ticino crossing (111/143,
// issue #4892 sibling fix); only crossings actually marked closed drop out.
const BORDER_CROSSINGS: BorderCrossingCoordinates[] = centralizedCrossings
 .filter(c => c.trafficLevel !== 'closed')
 .map(c => ({ name: c.name }));

export function hasLiveTrafficData(data: TrafficData[]): boolean {
 return data.some(item => item.source !== 'mock');
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
 crossingName: string; waitTimeMinutes?: number; status?: string;
 lastUpdateMs: number; source: string; approachMinutes?: number; totalCrossingMinutes?: number;
 }>).map(d => ({
 crossingName: d.crossingName,
 waitTimeMinutes: d.waitTimeMinutes,
 status: d.status as TrafficStatus | undefined,
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
 * 1. localStorage cache (fresh < 5 min) — skip the public endpoint on repeat page loads.
 * 2. Cached public traffic read model — the server reads `trafficCurrent`.
 * 3. Committed snapshot (data/border-wait-current.json) — last-known REAL values,
 *    the same source the static /traffico-dogane/.../oggi/ pages render, used
 *    when no fresh public snapshot is available. Never random/fabricated (#2997).
 */
 async getTrafficData(): Promise<TrafficData[]> {
 // 1. Fresh localStorage cache
 const cached = this.readLocalCache();
 if (cached) return cached;

 try {
 const publicData = await this.getTrafficDataFromPublicEndpoint();
 if (publicData.length > 0) {
 this.writeLocalCache(publicData);
 return publicData;
 }
 } catch (error) {
 reportCaughtError(error, 'traffic.publicRead');
 }

 return this.getFallbackTrafficData();
 }

 /**
 * Used by diagnostics UI to tell whether the live scheduler is currently feeding the public snapshot.
 */
 async hasFreshTrafficSnapshot(): Promise<boolean> {
 try {
 const publicData = await this.getTrafficDataFromPublicEndpoint();
 return publicData.length > 0;
 } catch (error) {
 reportCaughtError(error, 'traffic.snapshotStatus');
 return false;
 }
 }

 /**
 * Reads the latest traffic snapshot from the cached public endpoint.
 * Returns an empty array when the collection is empty or the data is stale
 * (scheduler inactive for more than 2 hours).
 */
 private async getTrafficDataFromPublicEndpoint(): Promise<TrafficData[]> {
 const response = await fetch(PUBLIC_TRAFFIC_CURRENT_URL, { credentials: 'omit', mode: 'cors' });
 if (!response.ok) throw new Error(`trafficCurrent HTTP ${response.status}`);
 return parsePublicTrafficCurrent(await response.json());
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
 * A crossing missing from the snapshot is omitted; absence stays absence until
 * the UI decides how to represent it.
 */
 private getFallbackTrafficData(): TrafficData[] {
 const perCrossing = BORDER_WAIT_SNAPSHOT.perCrossing ?? {};
 const snapshotUpdate = BORDER_WAIT_SNAPSHOT.updatedAt;
 return BORDER_CROSSINGS.flatMap(({ name }) => {
  const entry = perCrossing[slugifyCrossingName(name)];
 const fallback = buildFallbackTrafficData(name, entry, snapshotUpdate);
 return fallback ? [fallback] : [];
 });
}

 /**
 * Clears the localStorage cache so the next `getTrafficData()` call re-reads
 * public snapshot endpoint. Called by tests (beforeEach) and by callers that force a refresh.
 */
 clearCache() {
 try { localStorage.removeItem(TRAFFIC_LS_KEY); } catch { /* ignore */ }
 }
}

export const trafficService = new TrafficService();
