export interface SwitzerlandUnemploymentRateData {
  rate: number;
  unit: 'percent';
  period: string; // YYYY-MM
  history?: Array<{ period: string; rate: number }>;
  seoText?: Record<string, string>; // locale -> SEO prose
  sourceName: string;
  sourceUrl: string;
  releaseUrl?: string;
  methodology: string;
  fetchedAt: string;
}

const DATA_URL = '/data/switzerland-unemployment-rate.json';

export async function fetchSwitzerlandUnemploymentRate(): Promise<SwitzerlandUnemploymentRateData | null> {
  try {
    const res = await fetch(DATA_URL);
    if (!res.ok) return null;
    const data = (await res.json()) as SwitzerlandUnemploymentRateData;
    if (!data || typeof data.rate !== 'number' || !data.period) return null;
    if (Array.isArray(data.history)) {
      data.history = data.history
        .filter((x) => x && typeof x.period === 'string' && Number.isFinite(Number(x.rate)))
        .map((x) => ({ period: x.period, rate: Number(Number(x.rate).toFixed(1)) }))
        .sort((a, b) => a.period.localeCompare(b.period));
    }
    return data;
  } catch {
    return null;
  }
}
