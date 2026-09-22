/**
 * Read-only client for the server-refreshed ASTRA/FEDRO vehicle observatory.
 *
 * The browser reads one compact Firestore document.  It never downloads the
 * IVZ attachments directly: the source files are large, served as downloads,
 * and do not expose a browser-friendly CORS contract.
 */

import { reportCaughtError } from "@/services/errorReporter";

export type VehicleFuelKey =
  | "electric"
  | "plugInHybrid"
  | "hybrid"
  | "petrol"
  | "diesel"
  | "gas"
  | "other";

export interface VehicleFuelPoint {
  key: VehicleFuelKey;
  count: number;
  share: number;
}

export interface VehicleMetrics {
  total: number;
  electric: number;
  plugInHybrid: number;
  hybrid: number;
  petrol: number;
  diesel: number;
  gas: number;
  other: number;
  averageCo2: number | null;
  fuelMix: VehicleFuelPoint[];
}

export interface WeeklyVehicleSnapshot {
  period: string;
  provisional: boolean;
  dataAsOf: string | null;
  national: VehicleMetrics;
  byCanton: Record<string, VehicleMetrics>;
  sourceRows: number;
}

export interface WeeklyVehicleHistoryPoint {
  period: string;
  provisional: boolean;
  nationalTotal: number;
  ticinoTotal: number;
  ticinoElectric: number;
  dataAsOf: string | null;
}

export interface MonthlyCantonVehicleMetrics {
  code: string;
  stock: VehicleMetrics;
  newRegistrations: VehicleMetrics;
  usedImports: VehicleMetrics;
}

export interface MonthlyVehicleSnapshot {
  period: string;
  dataAsOf: string | null;
  national: {
    stock: VehicleMetrics;
    newRegistrations: VehicleMetrics;
    usedImports: VehicleMetrics;
  };
  byCanton: MonthlyCantonVehicleMetrics[];
  sourceRows: {
    stock: number;
    newRegistrations: number;
    usedImports: number;
  };
}

export interface MonthlyVehicleHistoryPoint {
  period: string;
  nationalStock: number;
  ticinoStock: number;
  ticinoNewRegistrations: number;
  ticinoUsedImports: number;
  ticinoElectric: number;
  dataAsOf: string | null;
}

export interface AstraVehicleStatsData {
  schemaVersion: number;
  generatedAt: string;
  lastUpdated: string;
  daily: {
    dataAsOf: string | null;
    national: VehicleMetrics;
    sourceRows: number;
    signal: boolean;
  };
  weekly: {
    latest: WeeklyVehicleSnapshot;
    history: WeeklyVehicleHistoryPoint[];
  };
  monthly: {
    latest: MonthlyVehicleSnapshot;
    history: MonthlyVehicleHistoryPoint[];
  };
  technical: {
    status: string;
    datasets: Array<{
      key: string;
      cadence: string;
      access: string;
      public: boolean;
      use: string;
    }>;
    note: string;
    checkedAt: string;
  };
  localDetail: {
    status: string;
    note: string;
    checkedAt: string;
  };
  source: {
    provider: string;
    overviewUrl: string;
    attribution: string;
    frequencies: Record<string, string>;
  };
}

export type AstraVehicleStatsSource = "firestore" | "cache" | "error";

export interface AstraVehicleStatsResult {
  data: AstraVehicleStatsData | null;
  source: AstraVehicleStatsSource;
  error?: string;
}

export const ASTRA_SOURCE_LINK =
  "https://www.astra.admin.ch/astra/it/home/documentazione/dati-aperti/veicoli.html";

const LOCAL_CACHE_KEY = "astra_vehicle_stats_cache_v1";
const FIRESTORE_COLLECTION = "config";
const FIRESTORE_DOC = "astra_vehicle_stats";
export const ASTRA_CACHE_DURATION_MS = 6 * 60 * 60 * 1000;

function isMetrics(value: unknown): value is VehicleMetrics {
  const metrics = value as VehicleMetrics | null;
  return Boolean(
    metrics &&
      Number.isFinite(metrics.total) &&
      Array.isArray(metrics.fuelMix) &&
      metrics.fuelMix.length === 7,
  );
}

function isValidData(value: unknown): value is AstraVehicleStatsData {
  const data = value as AstraVehicleStatsData | null;
  return Boolean(
    data &&
      data.schemaVersion === 1 &&
      data.weekly?.latest?.period &&
      isMetrics(data.weekly.latest.national) &&
      data.monthly?.latest?.period &&
      isMetrics(data.monthly.latest.national.stock) &&
      Array.isArray(data.monthly.latest.byCanton) &&
      data.monthly.latest.byCanton.length === 26,
  );
}

function readLocalCache():
  | (AstraVehicleStatsData & { timestamp: number })
  | null {
  try {
    const raw = localStorage.getItem(LOCAL_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AstraVehicleStatsData & {
      timestamp?: unknown;
    };
    return isValidData(parsed) && Number.isFinite(Number(parsed.timestamp))
      ? (parsed as AstraVehicleStatsData & { timestamp: number })
      : null;
  } catch {
    return null;
  }
}

function writeLocalCache(data: AstraVehicleStatsData): void {
  try {
    localStorage.setItem(
      LOCAL_CACHE_KEY,
      JSON.stringify({ ...data, timestamp: Date.now() }),
    );
  } catch {
    // Quota/private-mode failures are non-fatal; Firestore remains available.
  }
}

async function readFirestore(): Promise<
  (AstraVehicleStatsData & { timestamp: number }) | null
> {
  try {
    const { getFirestore, doc, getDoc } = await import("firebase/firestore");
    const { getApp } = await import("@/services/firebase");
    const db = getFirestore(await getApp());
    const snapshot = await getDoc(doc(db, FIRESTORE_COLLECTION, FIRESTORE_DOC));
    if (!snapshot.exists()) return null;
    const value = snapshot.data() as AstraVehicleStatsData & {
      timestamp?: { toMillis?: () => number } | number;
    };
    if (!isValidData(value)) return null;
    const timestamp =
      typeof value.timestamp === "object" &&
      typeof value.timestamp?.toMillis === "function"
        ? value.timestamp.toMillis()
        : Number(value.timestamp || 0);
    return { ...value, timestamp } as AstraVehicleStatsData & {
      timestamp: number;
    };
  } catch (error) {
    reportCaughtError(error, "astraVehicleStats.firestoreRead", {
      apiEndpoint: `${FIRESTORE_COLLECTION}/${FIRESTORE_DOC}`,
    });
    return null;
  }
}

export async function fetchAstraVehicleStats({
  force = false,
}: { force?: boolean } = {}): Promise<AstraVehicleStatsResult> {
  const now = Date.now();
  const local = readLocalCache();
  if (!force && local && now - local.timestamp < ASTRA_CACHE_DURATION_MS) {
    return { data: local, source: "cache" };
  }

  const firestore = await readFirestore();
  if (firestore) {
    writeLocalCache(firestore);
    return { data: firestore, source: "firestore" };
  }

  if (local) return { data: local, source: "cache" };
  return {
    data: null,
    source: "error",
    error: "ASTRA vehicle data not available",
  };
}
