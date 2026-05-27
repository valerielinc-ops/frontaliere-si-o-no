/**
 * Met.no / YR.no fetcher — Norwegian Meteorological Institute, free API
 * (CC-BY 4.0), commercial OK with attribution. STRICT TOS requirements:
 *
 *  1. User-Agent MUST be specific (product/version contact-email).
 *     Generic UAs (node-fetch, axios) get 403.
 *  2. If-Modified-Since header MUST be honored. Cache the Last-Modified
 *     value per-coordinate and resend it on subsequent calls. Cache-Control
 *     Expires is typically 30min.
 *  3. Rate limit ~1 req/sec sustained, hard cap 20 req/sec.
 *  4. Attribution text required: "Weather forecast from MET Norway".
 *
 * Cache file: data/.weather-cache/met-no-{lat}-{lng}.json (gitignored)
 *   stores Last-Modified header. On 304 we reuse the previous payload —
 *   the cache also holds it for that purpose.
 */

import type { FetcherResult, WeatherForecastDay, WeatherForecastHour } from './types';

const ENDPOINT = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';

export const MET_NO_USER_AGENT = 'frontaliereticino.ch/1.0 valerielinc@gmail.com';
export const MET_NO_ATTRIBUTION_TEXT = 'Weather forecast from MET Norway';
export const MET_NO_ATTRIBUTION_URL = 'https://www.met.no/';

export interface MetNoCacheEntry {
  lastModified?: string;
  payload?: unknown;
  fetchedAt: string;
}

export interface MetNoFetchOpts {
  lat: number;
  lng: number;
  hourlyHours?: number;
  dailyDays?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Returns the cached entry for this lat/lng (or undefined). */
  readCache?: (lat: number, lng: number) => Promise<MetNoCacheEntry | undefined> | MetNoCacheEntry | undefined;
  /** Persists a new cache entry for this lat/lng. */
  writeCache?: (lat: number, lng: number, entry: MetNoCacheEntry) => Promise<void> | void;
}

export async function fetchMetNo(opts: MetNoFetchOpts): Promise<FetcherResult> {
  const { lat, lng, hourlyHours = 48, dailyDays = 7, signal, fetchImpl = fetch, readCache, writeCache } = opts;

  const cached = await Promise.resolve(readCache?.(lat, lng));

  const url = `${ENDPOINT}?lat=${lat.toFixed(4)}&lon=${lng.toFixed(4)}`;
  const headers: Record<string, string> = {
    'User-Agent': MET_NO_USER_AGENT,
    Accept: 'application/json',
  };
  if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

  let res: Response;
  try {
    res = await fetchImpl(url, { signal, headers });
  } catch (e) {
    return { source: 'met-no', ok: false, error: `network: ${(e as Error).message}` };
  }

  if (res.status === 304 && cached?.payload) {
    const parsed = parseMetNoPayload(cached.payload, hourlyHours, dailyDays);
    if (!parsed) return { source: 'met-no', ok: false, error: 'cached payload malformed' };
    return { source: 'met-no', ok: true, ...parsed };
  }
  if (res.status === 429) return { source: 'met-no', ok: false, error: '429 rate-limited' };
  if (res.status === 403) return { source: 'met-no', ok: false, error: '403 (likely UA missing/invalid)' };
  if (!res.ok) return { source: 'met-no', ok: false, error: `http ${res.status}` };

  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    return { source: 'met-no', ok: false, error: `parse: ${(e as Error).message}` };
  }

  const lastModified = res.headers.get('last-modified') ?? undefined;
  await Promise.resolve(writeCache?.(lat, lng, { lastModified, payload: json, fetchedAt: new Date().toISOString() }));

  const parsed = parseMetNoPayload(json, hourlyHours, dailyDays);
  if (!parsed) return { source: 'met-no', ok: false, error: 'malformed payload' };
  return { source: 'met-no', ok: true, ...parsed };
}

interface MetNoSeriesEntry {
  time: string;
  data: {
    instant?: { details?: Record<string, number> };
    next_1_hours?: { summary?: { symbol_code?: string }; details?: Record<string, number> };
    next_6_hours?: { summary?: { symbol_code?: string }; details?: Record<string, number> };
    next_12_hours?: { summary?: { symbol_code?: string } };
  };
}

function parseMetNoPayload(payload: unknown, hourlyHours: number, dailyDays: number) {
  const obj = payload as { properties?: { timeseries?: MetNoSeriesEntry[] } };
  const series = obj?.properties?.timeseries;
  if (!Array.isArray(series) || series.length === 0) return null;
  const first = series[0];
  const inst = first?.data?.instant?.details ?? {};
  const next1Sym = first?.data?.next_1_hours?.summary?.symbol_code ?? first?.data?.next_6_hours?.summary?.symbol_code;
  const isDay = inferDayFromSymbol(next1Sym);
  const current = {
    temperature: numOrUndefined(inst.air_temperature) ?? 0,
    weatherCode: symbolToWmo(next1Sym),
    isDay: isDay,
    windSpeedKmh: numOrUndefined(inst.wind_speed) !== undefined ? Math.round(inst.wind_speed * 3.6) : undefined,
    humidity: numOrUndefined(inst.relative_humidity) !== undefined ? Math.trunc(inst.relative_humidity) : undefined,
  };

  const hourly24: WeatherForecastHour[] = [];
  for (let i = 0; i < Math.min(series.length, hourlyHours); i++) {
    const e = series[i];
    const det = e.data.instant?.details ?? {};
    const sym = e.data.next_1_hours?.summary?.symbol_code ?? e.data.next_6_hours?.summary?.symbol_code;
    if (typeof det.air_temperature !== 'number') continue;
    hourly24.push({
      hour: e.time,
      temp: det.air_temperature,
      weatherCode: symbolToWmo(sym),
      isDay: inferDayFromSymbol(sym),
    });
  }

  const daily7 = aggregateDaily(series, Math.min(7, dailyDays));

  return { current, hourly24, daily7 };
}

function numOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && !Number.isNaN(v) ? v : undefined;
}

function inferDayFromSymbol(sym?: string): boolean {
  if (!sym) return true;
  if (sym.endsWith('_night')) return false;
  if (sym.endsWith('_day') || sym.endsWith('_polartwilight')) return true;
  return true;
}

/**
 * Aggregate Met.no hourly series into daily summaries. Uses min/max of
 * air_temperature across the day, picks the dominant weather symbol from
 * midday entries (closest to local noon).
 */
function aggregateDaily(series: MetNoSeriesEntry[], days: number): WeatherForecastDay[] {
  const byDate = new Map<string, MetNoSeriesEntry[]>();
  for (const e of series) {
    const date = e.time.slice(0, 10);
    let arr = byDate.get(date);
    if (!arr) { arr = []; byDate.set(date, arr); }
    arr.push(e);
  }
  const out: WeatherForecastDay[] = [];
  const sortedDates = Array.from(byDate.keys()).sort();
  for (const date of sortedDates.slice(0, days)) {
    const entries = byDate.get(date)!;
    let tempMax = -Infinity;
    let tempMin = Infinity;
    for (const e of entries) {
      const t = e.data.instant?.details?.air_temperature;
      if (typeof t === 'number') {
        tempMax = Math.max(tempMax, t);
        tempMin = Math.min(tempMin, t);
      }
    }
    const middayEntry = entries.find((e) => e.time.slice(11, 13) === '12') ?? entries[Math.floor(entries.length / 2)];
    const sym = middayEntry?.data.next_6_hours?.summary?.symbol_code ?? middayEntry?.data.next_1_hours?.summary?.symbol_code;
    if (!Number.isFinite(tempMax) || !Number.isFinite(tempMin)) continue;
    out.push({
      date,
      tempMax,
      tempMin,
      weatherCode: symbolToWmo(sym),
    });
  }
  return out;
}

/**
 * Met.no symbol_code → WMO 4677 mapping. Met.no uses textual symbols
 * (clearsky_day, partlycloudy_night, lightrainshowers_day, etc.); we map
 * them to the closest WMO numeric code so the rest of the pipeline can
 * stay WMO-native.
 */
export function symbolToWmo(sym?: string): number {
  if (!sym) return 0;
  const base = sym.replace(/_(day|night|polartwilight)$/, '');
  switch (base) {
    case 'clearsky': return 0;
    case 'fair': return 1;
    case 'partlycloudy': return 2;
    case 'cloudy': return 3;
    case 'fog': return 45;
    case 'lightrainshowers': case 'lightrainshowersandthunder': return 80;
    case 'rainshowers': case 'rainshowersandthunder': return 81;
    case 'heavyrainshowers': case 'heavyrainshowersandthunder': return 82;
    case 'lightrain': case 'lightrainandthunder': return 61;
    case 'rain': case 'rainandthunder': return 63;
    case 'heavyrain': case 'heavyrainandthunder': return 65;
    case 'lightsleet': case 'lightsleetshowers': case 'lightsleetshowersandthunder': case 'lightsleetandthunder': return 66;
    case 'sleet': case 'sleetshowers': case 'sleetshowersandthunder': case 'sleetandthunder': return 67;
    case 'heavysleet': case 'heavysleetshowers': case 'heavysleetshowersandthunder': case 'heavysleetandthunder': return 67;
    case 'lightsnow': case 'lightsnowshowers': case 'lightsnowshowersandthunder': case 'lightsnowandthunder': return 71;
    case 'snow': case 'snowshowers': case 'snowshowersandthunder': case 'snowandthunder': return 73;
    case 'heavysnow': case 'heavysnowshowers': case 'heavysnowshowersandthunder': case 'heavysnowandthunder': return 75;
    case 'lightssleetshowers': return 85;
    case 'heavysleetshowers' as const: return 86;
    default: return 3;
  }
}

export const _internals = { parseMetNoPayload, symbolToWmo, aggregateDaily };
