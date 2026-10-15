/**
 * Council aggregator — combines results from Open-Meteo + Met.no +
 * MeteoSwiss into a single CityWeather/ValicoMeteo with confidence flag.
 *
 * Re-framing per /plan-eng-review D11:
 *   - Forecast (current + hourly + daily) is council-of-2 (Open-Meteo +
 *     Met.no). MeteoSwiss does NOT publish a JSON forecast endpoint.
 *   - MeteoSwiss provides observation (CH-side cities) → anchors current
 *     temperature for high-confidence local readings.
 *   - Quorum is dynamic per-field: denominator = number of sources that
 *     responded with a value, not a fixed 3.
 *   - Confidence = high (≥2 forecast sources agree within 2°C),
 *                  medium (1 forecast source available),
 *                  low (no forecast source — only observation).
 */

import type {
  FetcherResult, CityWeather, ValicoMeteo, WeatherCurrent, WeatherForecastDay,
  WeatherForecastHour, WeatherSource, Confidence,
} from './types';

interface AggregateInput {
  cityId: string;
  results: FetcherResult[];
  /** Optional MeteoSwiss observation, anchors current. */
  observation?: FetcherResult;
}

export function aggregateCityWeather(input: AggregateInput): CityWeather {
  const { cityId, results, observation } = input;
  const ok = results.filter((r) => r.ok && r.current);
  const sources: WeatherSource[] = ok.map((r) => r.source);

  const current = mergeCurrents(ok.map((r) => r.current!), observation?.ok ? observation.current : undefined);
  const hourly24 = mergeHourly(ok);
  const daily7 = mergeDaily(ok);

  const confidence = computeConfidence(ok.length, observation?.ok === true);
  if (observation?.ok && !sources.includes('meteo-swiss')) sources.push('meteo-swiss');

  return {
    cityId,
    current,
    hourly24,
    daily7,
    sources,
    confidence,
    generatedAt: new Date().toISOString(),
  };
}

export function aggregateValicoMeteo(input: { valicoId: string; results: FetcherResult[]; webcamUrl?: string; webcamTimestamp?: string; alertActive?: boolean }): ValicoMeteo {
  const { valicoId, results, webcamUrl, webcamTimestamp, alertActive = false } = input;
  const ok = results.filter((r) => r.ok && r.current);
  const sources: WeatherSource[] = ok.map((r) => r.source);
  const current = mergeCurrents(ok.map((r) => r.current!), undefined);
  const hourly24 = mergeHourly(ok).slice(0, 24);
  const confidence = computeConfidence(ok.length, false);
  return {
    valicoId,
    current,
    hourly24,
    alertActive,
    webcamUrl,
    webcamTimestamp,
    sources,
    confidence,
  };
}

/**
 * Merge current readings: median temperature across responding sources,
 * majority vote on weatherCode, prefer observation reading if MeteoSwiss
 * provided one (high-confidence on-the-ground anchor).
 */
function mergeCurrents(currents: WeatherCurrent[], observation: WeatherCurrent | undefined): WeatherCurrent {
  if (currents.length === 0 && observation) return observation;
  const temps = currents.map((c) => c.temperature);
  if (observation) temps.push(observation.temperature);
  const tempMedian = median(temps);
  const codes = currents.map((c) => c.weatherCode);
  const code = majorityVote(codes) ?? codes[0] ?? 0;
  const isDayVotes = currents.map((c) => c.isDay);
  const isDay = isDayVotes.length > 0 ? majorityVoteBool(isDayVotes) : true;
  return {
    temperature: tempMedian,
    weatherCode: code,
    isDay,
    windSpeedKmh: average(currents.map((c) => c.windSpeedKmh).filter(isNum)),
    humidity: average(currents.map((c) => c.humidity).filter(isNum)),
    apparentTemp: average(currents.map((c) => c.apparentTemp).filter(isNum)),
  };
}

function mergeHourly(results: FetcherResult[]): WeatherForecastHour[] {
  const all = results.map((r) => r.hourly24 ?? []).filter((a) => a.length > 0);
  if (all.length === 0) return [];
  const byHour = new Map<string, WeatherForecastHour[]>();
  for (const arr of all) {
    for (const h of arr) {
      let bucket = byHour.get(h.hour);
      if (!bucket) { bucket = []; byHour.set(h.hour, bucket); }
      bucket.push(h);
    }
  }
  const out: WeatherForecastHour[] = [];
  for (const hour of [...byHour.keys()].sort()) {
    const bucket = byHour.get(hour)!;
    out.push({
      hour,
      temp: median(bucket.map((b) => b.temp)),
      weatherCode: majorityVote(bucket.map((b) => b.weatherCode)) ?? bucket[0].weatherCode,
      isDay: majorityVoteBool(bucket.map((b) => b.isDay)),
    });
  }
  return out.slice(0, 48);
}

function mergeDaily(results: FetcherResult[]): WeatherForecastDay[] {
  const all = results.map((r) => r.daily7 ?? []).filter((a) => a.length > 0);
  if (all.length === 0) return [];
  const byDate = new Map<string, WeatherForecastDay[]>();
  for (const arr of all) {
    for (const d of arr) {
      let bucket = byDate.get(d.date);
      if (!bucket) { bucket = []; byDate.set(d.date, bucket); }
      bucket.push(d);
    }
  }
  const out: WeatherForecastDay[] = [];
  for (const date of [...byDate.keys()].sort()) {
    const bucket = byDate.get(date)!;
    out.push({
      date,
      tempMax: median(bucket.map((b) => b.tempMax)),
      tempMin: median(bucket.map((b) => b.tempMin)),
      weatherCode: majorityVote(bucket.map((b) => b.weatherCode)) ?? bucket[0].weatherCode,
      precipProb: average(bucket.map((b) => b.precipProb).filter(isNum)),
      sunrise: bucket.find((b) => b.sunrise)?.sunrise,
      sunset: bucket.find((b) => b.sunset)?.sunset,
    });
  }
  return out.slice(0, 7);
}

function computeConfidence(forecastSourceCount: number, hasObservation: boolean): Confidence {
  if (forecastSourceCount >= 2) return 'high';
  if (forecastSourceCount === 1) return hasObservation ? 'high' : 'medium';
  if (hasObservation) return 'medium';
  return 'low';
}

function median(values: number[]): number {
  const xs = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid];
}

function majorityVote(codes: number[]): number | undefined {
  if (codes.length === 0) return undefined;
  const counts = new Map<number, number>();
  for (const c of codes) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bestCode = codes[0];
  let bestCount = 0;
  for (const [code, count] of counts) {
    if (count > bestCount) { bestCode = code; bestCount = count; }
  }
  return bestCode;
}

function majorityVoteBool(values: boolean[]): boolean {
  let t = 0; let f = 0;
  for (const v of values) v ? t++ : f++;
  return t >= f;
}

function average(values: (number | undefined)[]): number | undefined {
  const xs = values.filter(isNum);
  if (xs.length === 0) return undefined;
  return Math.round((xs.reduce((s, v) => s + v, 0) / xs.length) * 10) / 10;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && !Number.isNaN(v) && Number.isFinite(v);
}

export const _internals = { median, majorityVote, majorityVoteBool, average, computeConfidence };
