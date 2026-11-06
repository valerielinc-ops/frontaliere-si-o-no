/**
 * MeteoSwiss fetcher — observations + official alerts. Re-framed in /plan-eng-review:
 *
 *   1. OBSERVATIONS: SwissMetNet stations real-time, CH-side only
 *      (no JSON forecast endpoint exists publicly; ICON-CH1/CH2 are GRIB2).
 *      Used to anchor the council with an authoritative on-the-ground
 *      reading for Lugano/Bellinzona/Mendrisio/Locarno/Chiasso.
 *
 *   2. ALERTS: official warning bulletins from the Federal Office of
 *      Meteorology and Climatology — primary trigger for /allerte/* pages.
 *      The endpoint surfaces snow, wind, frost, rain, heat, ice and storm
 *      warnings keyed by region.
 *
 * Both endpoints are CC-BY 4.0, commercial-OK with attribution.
 */

import type { FetcherResult, WeatherCurrent, AlertState } from './types';

const OBSERVATIONS_ENDPOINT = 'https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/ogd-smn_meta.csv';
const STATION_LATEST_BASE = 'https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn';
/**
 * Official EUMETNET MeteoAlarm feed for Switzerland — MeteoSwiss feeds this
 * pan-European aggregator. CAP (Common Alerting Protocol) JSON shape.
 * Verified live 2026-05-07.
 */
const ALERTS_ENDPOINT = 'https://feeds.meteoalarm.org/api/v1/warnings/feeds-switzerland';

export const METEO_SWISS_ATTRIBUTION_TEXT = 'MeteoSwiss';
export const METEO_SWISS_ATTRIBUTION_URL = 'https://www.meteoswiss.admin.ch/';

/**
 * Mapping of frontaliere CH-side cities to nearest SwissMetNet station IDs.
 * Source: https://www.meteoswiss.admin.ch/services-and-publications/applications/measurement-values-and-measuring-networks.html
 */
export const CH_CITY_TO_STATION: Record<string, string> = {
  lugano: 'LUG',
  bellinzona: 'OTL',
  mendrisio: 'SBE',
  locarno: 'OTL',
  chiasso: 'SBE',
};

export interface MeteoSwissObservationOpts {
  cityId: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function fetchMeteoSwissObservation(opts: MeteoSwissObservationOpts): Promise<FetcherResult> {
  const { cityId, signal, fetchImpl = fetch } = opts;
  const stationId = CH_CITY_TO_STATION[cityId];
  if (!stationId) return { source: 'meteo-swiss', ok: false, error: `no station for cityId=${cityId}` };

  const url = `${STATION_LATEST_BASE}/${stationId.toLowerCase()}/ogd-smn_${stationId.toLowerCase()}_t_now.csv`;

  let res: Response;
  try {
    res = await fetchImpl(url, { signal, headers: { Accept: 'text/csv' } });
  } catch (e) {
    return { source: 'meteo-swiss', ok: false, error: `network: ${(e as Error).message}` };
  }
  if (res.status === 429) return { source: 'meteo-swiss', ok: false, error: '429 rate-limited' };
  if (!res.ok) return { source: 'meteo-swiss', ok: false, error: `http ${res.status}` };

  const text = await res.text();
  const current = parseStationCsv(text);
  if (!current) return { source: 'meteo-swiss', ok: false, error: 'malformed CSV' };

  return { source: 'meteo-swiss', ok: true, current };
}

/**
 * SwissMetNet CSV layout (semicolon-delimited):
 *   station/location;reference_timestamp;tre200s0;rre150z0;sre000z0;...
 *   tre200s0 = air temperature 2m, current (°C)
 *   ure200s0 = relative humidity (%)
 *   fkl010z0 = wind speed (m/s)
 *
 * Header is the first row, latest reading is the last data row.
 */
function parseStationCsv(text: string): WeatherCurrent | null {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const header = lines[0].split(';').map((h) => h.trim().toLowerCase());
  const lastRow = lines[lines.length - 1].split(';');
  const get = (col: string): number | undefined => {
    const idx = header.indexOf(col);
    if (idx < 0) return undefined;
    const raw = lastRow[idx]?.trim();
    if (!raw || raw === '-' || raw === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };

  const t = get('tre200s0');
  if (typeof t !== 'number') return null;
  const hum = get('ure200s0');
  const wind = get('fkl010z0');
  return {
    temperature: t,
    weatherCode: 0,
    isDay: inferDayFromTimestamp(lastRow[1]),
    humidity: typeof hum === 'number' ? Math.trunc(hum) : undefined,
    windSpeedKmh: typeof wind === 'number' ? Math.round(wind * 3.6) : undefined,
  };
}

function inferDayFromTimestamp(iso?: string): boolean {
  if (!iso) return true;
  const m = iso.match(/T(\d{2}):/);
  if (!m) return true;
  const h = Number(m[1]);
  return h >= 6 && h < 20;
}

// ── Alerts feed ──────────────────────────────────────────────

export type MeteoSwissAlertType =
  | 'snow' | 'rain' | 'wind' | 'thunderstorm' | 'frost' | 'heat' | 'slipperiness';

export interface MeteoSwissAlertItem {
  type: MeteoSwissAlertType;
  /** 1 = no danger, 2 = moderate, 3 = considerable, 4 = strong, 5 = very strong */
  level: number;
  regionId: string;
  validFrom?: string;
  validTo?: string;
  description?: string;
}

export interface MeteoSwissAlertsResult {
  ok: boolean;
  items?: MeteoSwissAlertItem[];
  error?: string;
}

export interface MeteoSwissAlertsFetchOpts {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function fetchMeteoSwissAlerts(opts: MeteoSwissAlertsFetchOpts = {}): Promise<MeteoSwissAlertsResult> {
  const { signal, fetchImpl = fetch } = opts;
  let res: Response;
  try {
    res = await fetchImpl(ALERTS_ENDPOINT, { signal, headers: { Accept: 'application/json' } });
  } catch (e) {
    return { ok: false, error: `network: ${(e as Error).message}` };
  }
  if (res.status === 429) return { ok: false, error: '429 rate-limited' };
  if (!res.ok) return { ok: false, error: `http ${res.status}` };
  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    return { ok: false, error: `parse: ${(e as Error).message}` };
  }
  const items = parseAlertsPayload(json);
  return { ok: true, items };
}

/**
 * Parse MeteoAlarm CAP payload (`{warnings: [{alert: {info: [...]}}]}`).
 * Each warning has multiple `info` entries (one per language); we pick the
 * Italian one when present, fall back to English/German otherwise.
 *
 * MeteoAlarm severity → numeric level (matches existing config minLevel):
 *   Minor=1, Moderate=2, Severe=3, Extreme=4 (rare).
 *
 * Region tagging from `area[].areaDesc`: "Ticino" → "TI";
 *   "settentrionale|nord" → "TI-N"; "meridionale|sud|Mendrisio" → "TI-S".
 *   IT-side regions are not in the CH feed (deferred follow-up).
 */
function parseAlertsPayload(payload: unknown): MeteoSwissAlertItem[] {
  const out: MeteoSwissAlertItem[] = [];
  if (!payload || typeof payload !== 'object') return out;
  const obj = payload as Record<string, unknown>;
  const warnings = obj.warnings;
  if (!Array.isArray(warnings)) return out;
  for (const w of warnings) {
    if (!w || typeof w !== 'object') continue;
    const ww = w as Record<string, unknown>;
    const alert = ww.alert as Record<string, unknown> | undefined;
    if (!alert || typeof alert !== 'object') continue;
    const infoList = alert.info as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(infoList) || infoList.length === 0) continue;
    const info = infoList.find((i) => i.language === 'it-IT' || i.language === 'it')
              ?? infoList.find((i) => i.language === 'en-GB' || i.language === 'en')
              ?? infoList[0];
    const event = typeof info.event === 'string' ? info.event : '';
    const type = mapAlertType(event);
    if (!type) continue;
    const severityStr = typeof info.severity === 'string' ? info.severity : '';
    const level = severityToLevel(severityStr);
    const areaArr = info.area as Array<Record<string, unknown>> | undefined;
    const areaDesc = Array.isArray(areaArr) && typeof areaArr[0]?.areaDesc === 'string'
      ? (areaArr[0].areaDesc as string)
      : '';
    const regionId = areaDescToRegionId(areaDesc);
    const validFrom = typeof info.onset === 'string' ? info.onset : typeof info.effective === 'string' ? info.effective : undefined;
    const validTo = typeof info.expires === 'string' ? info.expires : undefined;
    const description = typeof info.description === 'string' ? info.description : typeof info.headline === 'string' ? info.headline : undefined;
    out.push({ type, level, regionId, validFrom, validTo, description });
  }
  return out;
}

function severityToLevel(severity: string): number {
  const s = severity.toLowerCase();
  if (s === 'extreme') return 4;
  if (s === 'severe') return 3;
  if (s === 'moderate') return 2;
  if (s === 'minor') return 1;
  return 1;
}

function areaDescToRegionId(desc: string): string {
  const d = desc.toLowerCase();
  if (d.includes('ticin')) {
    if (d.includes('settentrional') || d.includes('nord')) return 'TI-N';
    if (d.includes('meridional') || d.includes('sud') || d.includes('mendrisio')) return 'TI-S';
    return 'TI';
  }
  if (d.includes('lecco')) return 'IT-LECCO';
  if (d.includes('como')) return 'IT-COMO';
  if (d.includes('vares')) return 'IT-VARESE';
  return desc;
}

function mapAlertType(s: string): MeteoSwissAlertType | null {
  const k = s.toLowerCase();
  if (k.includes('snow') || k.includes('schnee') || k.includes('neve') || k === 'snow' || k === '4') return 'snow';
  if (k.includes('rain') || k.includes('regen') || k.includes('pioggia') || k === 'rain' || k === '2') return 'rain';
  if (k.includes('wind') || k.includes('vento') || k === 'wind' || k === '3') return 'wind';
  if (k.includes('thund') || k.includes('gewitter') || k.includes('temporal') || k === '6') return 'thunderstorm';
  if (k.includes('frost') || k.includes('gelo') || k === '7') return 'frost';
  if (k.includes('heat') || k.includes('hitze') || k.includes('calore') || k.includes('caldo') || k === '9') return 'heat';
  if (k.includes('slip') || k.includes('glatt') || k.includes('ghiaccio') || k === '8') return 'slipperiness';
  return null;
}

/**
 * Convert MeteoSwiss alert items into AlertState objects keyed by alert
 * configuration. Caller passes the wired-up alert config (id, type, region)
 * and receives the corresponding active/inactive states.
 */
export function alertItemsToStates(items: MeteoSwissAlertItem[], config: Array<{ id: string; type: MeteoSwissAlertType; regionId?: string; minLevel?: number }>): AlertState[] {
  const out: AlertState[] = [];
  for (const cfg of config) {
    const min = cfg.minLevel ?? 2;
    const match = items.find((it) => it.type === cfg.type && (!cfg.regionId || it.regionId === cfg.regionId) && it.level >= min);
    if (match) {
      out.push({
        alertId: cfg.id,
        active: true,
        trigger: 'meteoswiss-official',
        startedAt: match.validFrom,
        confidence: 'high',
        source: 'MeteoSwiss',
        description: match.description,
      });
    } else {
      out.push({
        alertId: cfg.id,
        active: false,
        trigger: 'none',
        confidence: 'high',
        source: 'MeteoSwiss',
      });
    }
  }
  return out;
}

export const _internals = { parseStationCsv, parseAlertsPayload, mapAlertType };
