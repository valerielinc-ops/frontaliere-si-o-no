import { cdnDataUrl } from './cdnDataBase';
import type { BorderCrossingSlug } from '@/build-plugins/borderWaitData';

export interface BorderWaitRankingRow {
  slug: BorderCrossingSlug;
  rank: number;
  avgMinutes: number;
  totalSamples: number;
  trend: 'better' | 'worse' | 'flat';
  /** Week-over-week change in minutes (positive = slower). Null = no prior-week data. */
  deltaMinutes: number | null;
}

export interface BorderWaitRankingFunFacts {
  bestSlug: BorderCrossingSlug;
  worstSlug: BorderCrossingSlug;
  deltaMinutesPerCrossing: number;
  minutesPerYear: number;
  hoursPerYear: number;
  workingDaysLostPerYear: number;
}

export interface BorderWaitRankingMover {
  slug: BorderCrossingSlug;
  deltaMinutes: number;
}

export interface BorderWaitRankingMovers {
  improved: BorderWaitRankingMover[];
  worsened: BorderWaitRankingMover[];
}

export interface BorderWaitRankingSnapshot {
  updatedAt: string;
  windowDays: number;
  weekStart: string;
  weekEnd: string;
  ranking: BorderWaitRankingRow[];
  funFacts: BorderWaitRankingFunFacts | null;
  movers: BorderWaitRankingMovers | null;
}

const DATA_URL = '/data/border-wait-ranking.json';

export async function fetchBorderWaitRanking(): Promise<BorderWaitRankingSnapshot | null> {
  try {
    const res = await fetch(cdnDataUrl(DATA_URL));
    if (!res.ok) return null;
    const data = (await res.json()) as BorderWaitRankingSnapshot;
    if (!data || !Array.isArray(data.ranking) || typeof data.updatedAt !== 'string') return null;
    return data;
  } catch {
    return null;
  }
}
