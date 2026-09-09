// Client-side fetch for the live per-crossing wait snapshot
// (data/border-wait-current.json, published to public/data/ — see
// scripts/snapshot-border-wait-history.mjs). Mirrors borderWaitRankingService.ts:
// cdnDataUrl() resolution, try/catch/null-safe, never throws (issue #4892).

import { cdnDataUrl } from './cdnDataBase';

export interface BorderWaitCurrentEntry {
  waitTimeMinutes?: number;
  approachMinutes?: number;
  totalCrossingMinutes?: number;
  status?: string;
  source?: string;
  lastUpdate?: string;
}

export interface BorderWaitCurrentSnapshot {
  updatedAt: string;
  perCrossing: Record<string, BorderWaitCurrentEntry>;
}

const DATA_URL = '/data/border-wait-current.json';

export async function fetchBorderWaitCurrent(): Promise<BorderWaitCurrentSnapshot | null> {
  try {
    const res = await fetch(cdnDataUrl(DATA_URL));
    if (!res.ok) return null;
    const data = (await res.json()) as BorderWaitCurrentSnapshot;
    if (!data || typeof data.updatedAt !== 'string' || typeof data.perCrossing !== 'object' || data.perCrossing === null) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Best available wait figure for a crossing entry: total crossing time
 * (approach + queue) when present, else the raw queue wait, else `null`
 * when the entry itself is missing/empty.
 */
export function effectiveWaitMinutes(entry: BorderWaitCurrentEntry | undefined): number | null {
  if (!entry) return null;
  return entry.totalCrossingMinutes ?? entry.waitTimeMinutes ?? null;
}
