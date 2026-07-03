import { cdnDataUrl } from './cdnDataBase';
import type { BorderCrossingSlug } from '@/build-plugins/borderWaitData';

export interface BorderWaitRankingRow {
  slug: BorderCrossingSlug;
  rank: number;
  avgMinutes: number;
  totalSamples: number;
  trend: 'better' | 'worse' | 'flat';
}

export interface BorderWaitRankingFunFacts {
  bestSlug: BorderCrossingSlug;
  worstSlug: BorderCrossingSlug;
  deltaMinutesPerCrossing: number;
  minutesPerYear: number;
  hoursPerYear: number;
  workingDaysLostPerYear: number;
}

export interface BorderWaitRankingSnapshot {
  updatedAt: string;
  windowDays: number;
  ranking: BorderWaitRankingRow[];
  funFacts: BorderWaitRankingFunFacts | null;
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
