/**
 * weatherService — public entry point for runtime weather widgets and the
 * cron snapshot writer. Replaces the three pre-existing Open-Meteo client
 * implementations in FooterWeather, MorningDashboard, and (formerly)
 * scripts/update-weather.mjs by routing through a single council of sources.
 *
 * For runtime widgets (browser): pass-through to Open-Meteo for speed,
 * uses localStorage cache on top.
 * For the cron writer (Node): pass council fetchers + cache + observation.
 */

import { fetchOpenMeteo } from './weather/openMeteoFetcher';
import { fetchMetNo, type MetNoCacheEntry } from './weather/metNoFetcher';
import { fetchMeteoSwissObservation } from './weather/meteoSwissFetcher';
import { aggregateCityWeather, aggregateValicoMeteo } from './weather/aggregator';
import type { CityWeather, FetcherResult, ValicoMeteo } from './weather/types';

export type { CityWeather, ValicoMeteo, FetcherResult, WeatherSnapshot, AlertState, WeatherCurrent, WeatherForecastDay, WeatherForecastHour, Confidence } from './weather/types';

export { wmoIcon, wmoText, wmoI18nKey, wmoEmoji, entryFor as wmoEntry, type Locale as WmoLocale } from './weather/wmoCodes';
export { parseWeatherSnapshot, isStaleSnapshot, snapshotAgeHours } from './weather/types';
export { MET_NO_USER_AGENT, MET_NO_ATTRIBUTION_TEXT, MET_NO_ATTRIBUTION_URL } from './weather/metNoFetcher';
export { METEO_SWISS_ATTRIBUTION_TEXT, METEO_SWISS_ATTRIBUTION_URL, fetchMeteoSwissAlerts, alertItemsToStates, type MeteoSwissAlertType } from './weather/meteoSwissFetcher';

export interface RuntimeWeatherOpts {
  lat: number;
  lng: number;
  signal?: AbortSignal;
}

export interface RuntimeWeather {
  temperature: number;
  weatherCode: number;
  isDay: boolean;
  humidity?: number;
  windSpeedKmh?: number;
  apparentTemp?: number;
}

/**
 * Runtime entry — used by FooterWeather + MorningDashboard. Single source
 * (Open-Meteo) for speed; council aggregation lives only in the cron writer
 * which writes data/weather-snapshot.json.
 */
export async function fetchRuntimeWeather(opts: RuntimeWeatherOpts): Promise<RuntimeWeather | null> {
  const res = await fetchOpenMeteo({ lat: opts.lat, lng: opts.lng, hourlyHours: 0, dailyDays: 0, signal: opts.signal });
  if (!res.ok || !res.current) return null;
  return {
    temperature: res.current.temperature,
    weatherCode: res.current.weatherCode,
    isDay: res.current.isDay,
    humidity: res.current.humidity,
    windSpeedKmh: res.current.windSpeedKmh,
    apparentTemp: res.current.apparentTemp,
  };
}

export interface RuntimeForecastOpts extends RuntimeWeatherOpts {
  days?: number;
}

export interface RuntimeForecast {
  current: RuntimeWeather;
  daily: Array<{ date: string; tempMax: number; tempMin: number; weatherCode: number; precipProb?: number }>;
}

export async function fetchRuntimeForecast(opts: RuntimeForecastOpts): Promise<RuntimeForecast | null> {
  const res = await fetchOpenMeteo({ lat: opts.lat, lng: opts.lng, hourlyHours: 0, dailyDays: opts.days ?? 3, signal: opts.signal });
  if (!res.ok || !res.current) return null;
  return {
    current: {
      temperature: res.current.temperature,
      weatherCode: res.current.weatherCode,
      isDay: res.current.isDay,
      humidity: res.current.humidity,
      windSpeedKmh: res.current.windSpeedKmh,
      apparentTemp: res.current.apparentTemp,
    },
    daily: (res.daily7 ?? []).map((d) => ({
      date: d.date,
      tempMax: d.tempMax,
      tempMin: d.tempMin,
      weatherCode: d.weatherCode,
      precipProb: d.precipProb,
    })),
  };
}

// ── Council orchestrator (cron writer side) ──────────────────

export interface CouncilFetchOpts {
  cityId: string;
  lat: number;
  lng: number;
  hourlyHours?: number;
  dailyDays?: number;
  perSourceTimeoutMs?: number;
  globalTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  metNoCache?: {
    read: (lat: number, lng: number) => Promise<MetNoCacheEntry | undefined> | MetNoCacheEntry | undefined;
    write: (lat: number, lng: number, entry: MetNoCacheEntry) => Promise<void> | void;
  };
}

export async function fetchCouncilCity(opts: CouncilFetchOpts): Promise<CityWeather> {
  const {
    cityId, lat, lng, hourlyHours = 48, dailyDays = 7,
    perSourceTimeoutMs = 5000, globalTimeoutMs = 8000,
    fetchImpl, metNoCache,
  } = opts;

  const controllers: AbortController[] = [];
  const makeSignal = () => {
    const c = new AbortController();
    controllers.push(c);
    setTimeout(() => c.abort(), perSourceTimeoutMs);
    return c.signal;
  };

  const promises: Promise<FetcherResult>[] = [
    fetchOpenMeteo({ lat, lng, hourlyHours, dailyDays, signal: makeSignal(), fetchImpl }),
    fetchMetNo({ lat, lng, hourlyHours, dailyDays, signal: makeSignal(), fetchImpl, readCache: metNoCache?.read, writeCache: metNoCache?.write }),
  ];
  // MeteoSwiss observation only for known CH cities
  let observationPromise: Promise<FetcherResult> | null = null;
  try {
    observationPromise = fetchMeteoSwissObservation({ cityId, signal: makeSignal(), fetchImpl });
  } catch {
    observationPromise = null;
  }

  const settled = await raceWithTimeout(Promise.allSettled(promises), globalTimeoutMs);
  const observationSettled = observationPromise ? await raceWithTimeout(Promise.allSettled([observationPromise]).then((r) => r[0]), Math.max(1000, globalTimeoutMs - 1000)) : null;

  for (const c of controllers) c.abort();

  const results: FetcherResult[] = [];
  if (settled === 'TIMEOUT') {
    return aggregateCityWeather({ cityId, results: [], observation: undefined });
  }
  for (const s of settled) {
    if (s.status === 'fulfilled') results.push(s.value);
  }
  let observation: FetcherResult | undefined;
  if (observationSettled && observationSettled !== 'TIMEOUT' && observationSettled.status === 'fulfilled') {
    observation = observationSettled.value;
  }

  return aggregateCityWeather({ cityId, results, observation });
}

export interface CouncilValicoFetchOpts {
  valicoId: string;
  lat: number;
  lng: number;
  webcamUrl?: string;
  alertActive?: boolean;
  perSourceTimeoutMs?: number;
  globalTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  metNoCache?: CouncilFetchOpts['metNoCache'];
}

export async function fetchCouncilValico(opts: CouncilValicoFetchOpts): Promise<ValicoMeteo> {
  const {
    valicoId, lat, lng, webcamUrl, alertActive = false,
    perSourceTimeoutMs = 5000, globalTimeoutMs = 8000,
    fetchImpl, metNoCache,
  } = opts;

  const controllers: AbortController[] = [];
  const makeSignal = () => {
    const c = new AbortController();
    controllers.push(c);
    setTimeout(() => c.abort(), perSourceTimeoutMs);
    return c.signal;
  };

  const promises: Promise<FetcherResult>[] = [
    fetchOpenMeteo({ lat, lng, hourlyHours: 24, dailyDays: 1, signal: makeSignal(), fetchImpl }),
    fetchMetNo({ lat, lng, hourlyHours: 24, dailyDays: 1, signal: makeSignal(), fetchImpl, readCache: metNoCache?.read, writeCache: metNoCache?.write }),
  ];

  const settled = await raceWithTimeout(Promise.allSettled(promises), globalTimeoutMs);
  for (const c of controllers) c.abort();

  const results: FetcherResult[] = [];
  if (settled !== 'TIMEOUT') {
    for (const s of settled) if (s.status === 'fulfilled') results.push(s.value);
  }

  return aggregateValicoMeteo({
    valicoId, results, webcamUrl,
    webcamTimestamp: webcamUrl ? new Date().toISOString() : undefined,
    alertActive,
  });
}

async function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'TIMEOUT'> {
  return Promise.race<T | 'TIMEOUT'>([
    promise,
    new Promise<'TIMEOUT'>((resolve) => setTimeout(() => resolve('TIMEOUT'), ms)),
  ]);
}
