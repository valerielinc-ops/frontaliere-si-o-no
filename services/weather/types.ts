/**
 * Weather domain types — single source of truth for the council-of-sources
 * pipeline. All readers (cron writer, build plugins, runtime widgets) parse
 * data/weather-snapshot.json against these types.
 */

export type Confidence = 'high' | 'medium' | 'low';
export type WeatherSource = 'open-meteo' | 'met-no' | 'meteo-swiss';
export type AlertTrigger = 'meteoswiss-official' | 'council-confirmed' | 'council-soft' | 'none';

export interface WeatherCurrent {
  temperature: number;
  weatherCode: number;
  isDay: boolean;
  windSpeedKmh?: number;
  humidity?: number;
  apparentTemp?: number;
}

export interface WeatherForecastHour {
  hour: string;
  temp: number;
  weatherCode: number;
  isDay: boolean;
}

export interface WeatherForecastDay {
  date: string;
  tempMax: number;
  tempMin: number;
  weatherCode: number;
  precipProb?: number;
  sunrise?: string;
  sunset?: string;
}

export interface CityWeather {
  cityId: string;
  current: WeatherCurrent;
  hourly24: WeatherForecastHour[];
  daily7: WeatherForecastDay[];
  sources: WeatherSource[];
  confidence: Confidence;
  generatedAt: string;
}

export interface AlertState {
  alertId: string;
  active: boolean;
  trigger: AlertTrigger;
  startedAt?: string;
  metric?: { value: number; unit: string };
  confidence: Confidence;
  source: string;
  description?: string;
}

export interface ValicoMeteo {
  valicoId: string;
  current: WeatherCurrent;
  hourly24: WeatherForecastHour[];
  alertActive: boolean;
  webcamUrl?: string;
  webcamTimestamp?: string;
  sources: WeatherSource[];
  confidence: Confidence;
}

export interface WeatherSnapshot {
  generatedAt: string;
  cities: Record<string, CityWeather>;
  alerts: Record<string, AlertState>;
  valichi: Record<string, ValicoMeteo>;
}

export interface FetcherResult {
  source: WeatherSource;
  ok: boolean;
  current?: WeatherCurrent;
  hourly24?: WeatherForecastHour[];
  daily7?: WeatherForecastDay[];
  error?: string;
}

export interface ParsedSnapshotResult<T> {
  ok: true;
  value: T;
}

export interface ParsedSnapshotError {
  ok: false;
  error: string;
  path?: string;
}

export type ParsedSnapshot<T> = ParsedSnapshotResult<T> | ParsedSnapshotError;

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && !Number.isNaN(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function expectField<T>(o: Record<string, unknown>, key: string, validator: (v: unknown) => v is T, path: string): ParsedSnapshot<T> {
  if (!(key in o)) return { ok: false, error: `missing field: ${key}`, path: `${path}.${key}` };
  const v = o[key];
  if (!validator(v)) return { ok: false, error: `invalid type for ${key}`, path: `${path}.${key}` };
  return { ok: true, value: v };
}

function parseWeatherCurrent(o: unknown, path: string): ParsedSnapshot<WeatherCurrent> {
  if (!isObj(o)) return { ok: false, error: 'not an object', path };
  const t = expectField(o, 'temperature', isNum, path); if (!t.ok) return t as ParsedSnapshotError;
  const c = expectField(o, 'weatherCode', isNum, path); if (!c.ok) return c as ParsedSnapshotError;
  const d = expectField(o, 'isDay', isBool, path); if (!d.ok) return d as ParsedSnapshotError;
  return {
    ok: true,
    value: {
      temperature: t.value,
      weatherCode: Math.trunc(c.value),
      isDay: d.value,
      windSpeedKmh: isNum(o.windSpeedKmh) ? o.windSpeedKmh : undefined,
      humidity: isNum(o.humidity) ? Math.trunc(o.humidity) : undefined,
      apparentTemp: isNum(o.apparentTemp) ? o.apparentTemp : undefined,
    },
  };
}

function parseHour(o: unknown, path: string): ParsedSnapshot<WeatherForecastHour> {
  if (!isObj(o)) return { ok: false, error: 'not an object', path };
  const h = expectField(o, 'hour', isStr, path); if (!h.ok) return h as ParsedSnapshotError;
  const t = expectField(o, 'temp', isNum, path); if (!t.ok) return t as ParsedSnapshotError;
  const c = expectField(o, 'weatherCode', isNum, path); if (!c.ok) return c as ParsedSnapshotError;
  const d = expectField(o, 'isDay', isBool, path); if (!d.ok) return d as ParsedSnapshotError;
  return { ok: true, value: { hour: h.value, temp: t.value, weatherCode: Math.trunc(c.value), isDay: d.value } };
}

function parseDay(o: unknown, path: string): ParsedSnapshot<WeatherForecastDay> {
  if (!isObj(o)) return { ok: false, error: 'not an object', path };
  const d = expectField(o, 'date', isStr, path); if (!d.ok) return d as ParsedSnapshotError;
  const hi = expectField(o, 'tempMax', isNum, path); if (!hi.ok) return hi as ParsedSnapshotError;
  const lo = expectField(o, 'tempMin', isNum, path); if (!lo.ok) return lo as ParsedSnapshotError;
  const c = expectField(o, 'weatherCode', isNum, path); if (!c.ok) return c as ParsedSnapshotError;
  return {
    ok: true,
    value: {
      date: d.value,
      tempMax: hi.value,
      tempMin: lo.value,
      weatherCode: Math.trunc(c.value),
      precipProb: isNum(o.precipProb) ? Math.trunc(o.precipProb) : undefined,
      sunrise: isStr(o.sunrise) ? o.sunrise : undefined,
      sunset: isStr(o.sunset) ? o.sunset : undefined,
    },
  };
}

function parseConfidence(v: unknown, path: string): ParsedSnapshot<Confidence> {
  if (v === 'high' || v === 'medium' || v === 'low') return { ok: true, value: v };
  return { ok: false, error: `invalid confidence: ${String(v)}`, path };
}

function parseSourcesArray(v: unknown, path: string): ParsedSnapshot<WeatherSource[]> {
  if (!Array.isArray(v)) return { ok: false, error: 'not an array', path };
  const out: WeatherSource[] = [];
  for (const s of v) {
    if (s === 'open-meteo' || s === 'met-no' || s === 'meteo-swiss') out.push(s);
    else return { ok: false, error: `invalid source: ${String(s)}`, path };
  }
  return { ok: true, value: out };
}

function parseCityWeather(o: unknown, path: string): ParsedSnapshot<CityWeather> {
  if (!isObj(o)) return { ok: false, error: 'not an object', path };
  const id = expectField(o, 'cityId', isStr, path); if (!id.ok) return id as ParsedSnapshotError;
  const cur = parseWeatherCurrent(o.current, `${path}.current`); if (!cur.ok) return cur as ParsedSnapshotError;
  if (!Array.isArray(o.hourly24)) return { ok: false, error: 'hourly24 not array', path };
  const hourly: WeatherForecastHour[] = [];
  for (let i = 0; i < o.hourly24.length; i++) {
    const r = parseHour(o.hourly24[i], `${path}.hourly24[${i}]`); if (!r.ok) return r as ParsedSnapshotError;
    hourly.push(r.value);
  }
  if (!Array.isArray(o.daily7)) return { ok: false, error: 'daily7 not array', path };
  const daily: WeatherForecastDay[] = [];
  for (let i = 0; i < o.daily7.length; i++) {
    const r = parseDay(o.daily7[i], `${path}.daily7[${i}]`); if (!r.ok) return r as ParsedSnapshotError;
    daily.push(r.value);
  }
  const srcs = parseSourcesArray(o.sources, `${path}.sources`); if (!srcs.ok) return srcs as ParsedSnapshotError;
  const conf = parseConfidence(o.confidence, `${path}.confidence`); if (!conf.ok) return conf as ParsedSnapshotError;
  const ts = expectField(o, 'generatedAt', isStr, path); if (!ts.ok) return ts as ParsedSnapshotError;
  return { ok: true, value: { cityId: id.value, current: cur.value, hourly24: hourly, daily7: daily, sources: srcs.value, confidence: conf.value, generatedAt: ts.value } };
}

function parseAlertState(o: unknown, path: string): ParsedSnapshot<AlertState> {
  if (!isObj(o)) return { ok: false, error: 'not an object', path };
  const id = expectField(o, 'alertId', isStr, path); if (!id.ok) return id as ParsedSnapshotError;
  const a = expectField(o, 'active', isBool, path); if (!a.ok) return a as ParsedSnapshotError;
  const t = o.trigger;
  if (t !== 'meteoswiss-official' && t !== 'council-confirmed' && t !== 'council-soft' && t !== 'none') {
    return { ok: false, error: `invalid trigger: ${String(t)}`, path: `${path}.trigger` };
  }
  const conf = parseConfidence(o.confidence, `${path}.confidence`); if (!conf.ok) return conf as ParsedSnapshotError;
  const src = expectField(o, 'source', isStr, path); if (!src.ok) return src as ParsedSnapshotError;
  let metric: AlertState['metric'];
  if (isObj(o.metric) && isNum(o.metric.value) && isStr(o.metric.unit)) metric = { value: o.metric.value, unit: o.metric.unit };
  return {
    ok: true,
    value: {
      alertId: id.value,
      active: a.value,
      trigger: t,
      startedAt: isStr(o.startedAt) ? o.startedAt : undefined,
      metric,
      confidence: conf.value,
      source: src.value,
      description: isStr(o.description) ? o.description : undefined,
    },
  };
}

function parseValicoMeteo(o: unknown, path: string): ParsedSnapshot<ValicoMeteo> {
  if (!isObj(o)) return { ok: false, error: 'not an object', path };
  const id = expectField(o, 'valicoId', isStr, path); if (!id.ok) return id as ParsedSnapshotError;
  const cur = parseWeatherCurrent(o.current, `${path}.current`); if (!cur.ok) return cur as ParsedSnapshotError;
  if (!Array.isArray(o.hourly24)) return { ok: false, error: 'hourly24 not array', path };
  const hourly: WeatherForecastHour[] = [];
  for (let i = 0; i < o.hourly24.length; i++) {
    const r = parseHour(o.hourly24[i], `${path}.hourly24[${i}]`); if (!r.ok) return r as ParsedSnapshotError;
    hourly.push(r.value);
  }
  const a = expectField(o, 'alertActive', isBool, path); if (!a.ok) return a as ParsedSnapshotError;
  const srcs = parseSourcesArray(o.sources, `${path}.sources`); if (!srcs.ok) return srcs as ParsedSnapshotError;
  const conf = parseConfidence(o.confidence, `${path}.confidence`); if (!conf.ok) return conf as ParsedSnapshotError;
  return {
    ok: true,
    value: {
      valicoId: id.value,
      current: cur.value,
      hourly24: hourly,
      alertActive: a.value,
      webcamUrl: isStr(o.webcamUrl) ? o.webcamUrl : undefined,
      webcamTimestamp: isStr(o.webcamTimestamp) ? o.webcamTimestamp : undefined,
      sources: srcs.value,
      confidence: conf.value,
    },
  };
}

export function parseWeatherSnapshot(o: unknown): ParsedSnapshot<WeatherSnapshot> {
  if (!isObj(o)) return { ok: false, error: 'snapshot is not an object', path: '$' };
  const ts = expectField(o, 'generatedAt', isStr, '$'); if (!ts.ok) return ts as ParsedSnapshotError;
  if (!isObj(o.cities)) return { ok: false, error: 'cities not an object', path: '$.cities' };
  if (!isObj(o.alerts)) return { ok: false, error: 'alerts not an object', path: '$.alerts' };
  if (!isObj(o.valichi)) return { ok: false, error: 'valichi not an object', path: '$.valichi' };
  const cities: Record<string, CityWeather> = {};
  for (const [k, v] of Object.entries(o.cities)) {
    const r = parseCityWeather(v, `$.cities.${k}`); if (!r.ok) return r as ParsedSnapshotError;
    cities[k] = r.value;
  }
  const alerts: Record<string, AlertState> = {};
  for (const [k, v] of Object.entries(o.alerts)) {
    const r = parseAlertState(v, `$.alerts.${k}`); if (!r.ok) return r as ParsedSnapshotError;
    alerts[k] = r.value;
  }
  const valichi: Record<string, ValicoMeteo> = {};
  for (const [k, v] of Object.entries(o.valichi)) {
    const r = parseValicoMeteo(v, `$.valichi.${k}`); if (!r.ok) return r as ParsedSnapshotError;
    valichi[k] = r.value;
  }
  return { ok: true, value: { generatedAt: ts.value, cities, alerts, valichi } };
}

export function isStaleSnapshot(snapshot: WeatherSnapshot, nowMs: number = Date.now()): boolean {
  const generatedMs = Date.parse(snapshot.generatedAt);
  if (Number.isNaN(generatedMs)) return true;
  return nowMs - generatedMs > 12 * 60 * 60 * 1000;
}

export function snapshotAgeHours(snapshot: WeatherSnapshot, nowMs: number = Date.now()): number {
  const generatedMs = Date.parse(snapshot.generatedAt);
  if (Number.isNaN(generatedMs)) return Infinity;
  return Math.max(0, (nowMs - generatedMs) / (60 * 60 * 1000));
}
