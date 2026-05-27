/**
 * Open-Meteo fetcher — primary source for forecast (fast, hourly + daily).
 * Free tier ~10k req/day. NOTE: TOS technically restricts commercial-with-ads
 * use; mitigated by council-of-sources redundancy. Attribution mandatory.
 */

import type { FetcherResult, WeatherForecastDay, WeatherForecastHour } from './types';

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

export interface OpenMeteoFetchOpts {
  lat: number;
  lng: number;
  hourlyHours?: number;
  dailyDays?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function fetchOpenMeteo(opts: OpenMeteoFetchOpts): Promise<FetcherResult> {
  const { lat, lng, hourlyHours = 48, dailyDays = 7, signal, fetchImpl = fetch } = opts;
  const url = new URL(ENDPOINT);
  url.searchParams.set('latitude', lat.toFixed(4));
  url.searchParams.set('longitude', lng.toFixed(4));
  url.searchParams.set('current', 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day');
  url.searchParams.set('hourly', 'temperature_2m,weather_code,is_day');
  url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,sunrise,sunset');
  url.searchParams.set('forecast_days', String(Math.min(7, dailyDays)));
  url.searchParams.set('timezone', 'Europe/Zurich');

  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      signal,
      headers: { Accept: 'application/json' },
    });
  } catch (e) {
    return { source: 'open-meteo', ok: false, error: `network: ${(e as Error).message}` };
  }

  if (res.status === 429) return { source: 'open-meteo', ok: false, error: '429 rate-limited' };
  if (!res.ok) return { source: 'open-meteo', ok: false, error: `http ${res.status}` };

  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    return { source: 'open-meteo', ok: false, error: `parse: ${(e as Error).message}` };
  }
  const obj = json as Record<string, unknown>;
  const current = (obj.current ?? {}) as Record<string, unknown>;
  const hourly = (obj.hourly ?? {}) as Record<string, unknown>;
  const daily = (obj.daily ?? {}) as Record<string, unknown>;

  const cur = parseCurrent(current);
  if (!cur) return { source: 'open-meteo', ok: false, error: 'malformed current' };

  const hourly24 = parseHourly(hourly, Math.min(48, hourlyHours));
  const daily7 = parseDaily(daily, Math.min(7, dailyDays));

  return {
    source: 'open-meteo',
    ok: true,
    current: cur,
    hourly24,
    daily7,
  };
}

function parseCurrent(o: Record<string, unknown>): FetcherResult['current'] | null {
  const t = (o.temperature_2m as number | undefined);
  const c = (o.weather_code as number | undefined);
  const d = (o.is_day as number | boolean | undefined);
  if (typeof t !== 'number' || typeof c !== 'number') return null;
  return {
    temperature: t,
    weatherCode: Math.trunc(c),
    isDay: d === 1 || d === true,
    windSpeedKmh: typeof o.wind_speed_10m === 'number' ? o.wind_speed_10m : undefined,
    humidity: typeof o.relative_humidity_2m === 'number' ? Math.trunc(o.relative_humidity_2m) : undefined,
    apparentTemp: typeof o.apparent_temperature === 'number' ? o.apparent_temperature : undefined,
  };
}

function parseHourly(o: Record<string, unknown>, limit: number): WeatherForecastHour[] {
  const time = (o.time as string[] | undefined) ?? [];
  const temps = (o.temperature_2m as number[] | undefined) ?? [];
  const codes = (o.weather_code as number[] | undefined) ?? [];
  const isDayArr = (o.is_day as Array<number | boolean> | undefined) ?? [];
  const out: WeatherForecastHour[] = [];
  for (let i = 0; i < Math.min(time.length, temps.length, codes.length, limit); i++) {
    out.push({
      hour: time[i],
      temp: temps[i],
      weatherCode: Math.trunc(codes[i]),
      isDay: isDayArr[i] === 1 || isDayArr[i] === true,
    });
  }
  return out;
}

function parseDaily(o: Record<string, unknown>, limit: number): WeatherForecastDay[] {
  const time = (o.time as string[] | undefined) ?? [];
  const tmax = (o.temperature_2m_max as number[] | undefined) ?? [];
  const tmin = (o.temperature_2m_min as number[] | undefined) ?? [];
  const codes = (o.weather_code as number[] | undefined) ?? [];
  const pp = (o.precipitation_probability_max as Array<number | null> | undefined) ?? [];
  const sunrise = (o.sunrise as string[] | undefined) ?? [];
  const sunset = (o.sunset as string[] | undefined) ?? [];
  const out: WeatherForecastDay[] = [];
  for (let i = 0; i < Math.min(time.length, tmax.length, tmin.length, codes.length, limit); i++) {
    out.push({
      date: time[i],
      tempMax: tmax[i],
      tempMin: tmin[i],
      weatherCode: Math.trunc(codes[i]),
      precipProb: typeof pp[i] === 'number' ? Math.trunc(pp[i] as number) : undefined,
      sunrise: sunrise[i],
      sunset: sunset[i],
    });
  }
  return out;
}

export const _internals = { parseCurrent, parseHourly, parseDaily };
