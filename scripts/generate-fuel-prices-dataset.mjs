#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

import fs from 'node:fs';
import { haversineKm } from './lib/haversine.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dedupStations } from './lib/fuel-station-dedup.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MUNICIPALITIES_PATH = path.join(ROOT, 'data', 'municipalities.ts');
const DATA_OUT = path.join(ROOT, 'data', 'fuel-prices.json');
const PUBLIC_OUT = path.join(ROOT, 'public', 'data', 'fuel-prices.json');

const ITALY_PRICES_URL = 'https://www.mimit.gov.it/images/exportCSV/prezzo_alle_8.csv';
const ITALY_STATIONS_URL = 'https://www.mimit.gov.it/images/exportCSV/anagrafica_impianti_attivi.csv';
const MIMIT_API_URL = 'https://carburanti.mise.gov.it/ospzApi/search/area';
// The generator only publishes the border municipalities below. Keep the
// region mapping explicit so an unknown province cannot silently broaden an
// API query and produce data for the wrong target set.
const MIMIT_API_REGION_BY_PROVINCE = Object.freeze({
  AO: 2,
  CO: 3,
  VA: 3,
  VB: 1,
  LC: 3,
  SO: 3,
  VC: 1,
  MB: 3,
  BG: 3,
  BS: 3,
  TN: 4,
  BZ: 4,
});
const MIMIT_API_CONCURRENCY = 4;
const MIMIT_PRICES_REQUIRED_COLUMNS = Object.freeze([
  'idImpianto', 'descCarburante', 'prezzo', 'isSelf', 'dtComu',
]);
const MIMIT_STATIONS_REQUIRED_COLUMNS = Object.freeze([
  'idImpianto', 'Comune', 'Provincia',
]);
const ECB_DAILY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
// TCS deprecated direct Firestore reads on 2026-05-22 (App Check + anon-auth
// enforcement). Their web app now hits a public Cloud Function in
// europe-west6 — no auth, no App Check, just a Referer check. The function
// returns clustered or unclustered stations for a given bbox + fuel filter.
const SWISS_TCS_BBOX_URL = 'https://europe-west6-tcs-digitalbackend.cloudfunctions.net/benzinGetStationByBbox';
const SWISS_TCS_REFERER = 'https://gas-prices-prod.firebaseapp.com/';
// Single bbox covering all CH within 25 km of the Italian border (Geneva to
// Mustair). At zoom 18 the server returns no clusters even for this span.
const SWISS_TCS_BBOX = [6.0, 45.7, 10.7, 47.0];
const SWISS_TCS_ZOOM = 18;
const SWISS_SEARCH_RADIUS_KM = 20;
const SWISS_BORDER_FILTER_KM = 25;
const TOP_SWISS_OPTIONS = 5;

function readMunicipalities() {
  const source = fs.readFileSync(MUNICIPALITIES_PATH, 'utf8');
  const rows = [];
  const re = /\{\s*name:\s*'((?:\\'|[^'])+)',\s*province:\s*'([^']+)',\s*lat:\s*([\d.]+),\s*lng:\s*([\d.]+),\s*irpefAddizionale:\s*([\d.]+),\s*distanceKm:\s*(\d+),\s*avgRentMonthly:\s*(\d+),\s*population:\s*(\d+),\s*fascia:\s*'([^']+)'/g;
  let match;
  while ((match = re.exec(source))) {
    rows.push({
      name: match[1].replace(/\\'/g, "'"),
      province: match[2],
      lat: Number(match[3]),
      lng: Number(match[4]),
      irpefAddizionale: Number(match[5]),
      distanceKm: Number(match[6]),
      avgRentMonthly: Number(match[7]),
      population: Number(match[8]),
      fascia: match[9],
    });
  }
  return rows;
}

function normalizeText(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '')
    .toUpperCase()
    .trim();
}

function parseDelimited(text) {
  const lines = String(text || '').trim().split(/\r?\n/);
  const extractedAtLine = lines.shift() || '';
  const extractedAtMatch = extractedAtLine.match(/(\d{4}-\d{2}-\d{2})/);
  const header = (lines.shift() || '').split('|');
  const rows = lines.map((line) => {
    const cols = line.split('|');
    return Object.fromEntries(header.map((key, index) => [key, cols[index] ?? '']));
  });
  return {
    extractedAt: extractedAtMatch ? extractedAtMatch[1] : null,
    rows,
  };
}

function assertDelimitedSource(parsed, requiredColumns, label) {
  if (!parsed.extractedAt || !normalizeItalyObservationDate(parsed.extractedAt)) {
    throw new Error(`MIMIT ${label} CSV has no valid extraction date`);
  }
  const columns = new Set(parsed.rows.length ? Object.keys(parsed.rows[0]) : []);
  const missing = requiredColumns.filter((column) => !columns.has(column));
  if (missing.length) {
    throw new Error(`MIMIT ${label} CSV is missing required columns: ${missing.join(', ')}`);
  }
  if (!parsed.rows.length) throw new Error(`MIMIT ${label} CSV has no data rows`);
}

/**
 * Validate the two bulk MIMIT responses before treating an HTTP 200 as a live
 * source. The export endpoint sometimes answers with an HTML/empty payload
 * while still returning 200; accepting that shape bypasses the Osservaprezzi
 * fallback and publishes an undated Italian snapshot.
 */
export function validateMimitCsvPayload({ pricesText, stationsText, municipalities }) {
  const prices = parseDelimited(pricesText);
  const stations = parseDelimited(stationsText);
  assertDelimitedSource(prices, MIMIT_PRICES_REQUIRED_COLUMNS, 'prices');
  assertDelimitedSource(stations, MIMIT_STATIONS_REQUIRED_COLUMNS, 'stations');

  const hasUsableBenzina = prices.rows.some((row) => (
    String(row.descCarburante || '').trim() === 'Benzina'
    && String(row.idImpianto || '').trim() !== ''
    && toNumber(row.prezzo) != null
    && normalizeItalyObservationDate(row.dtComu) != null
  ));
  if (!hasUsableBenzina) throw new Error('MIMIT prices CSV has no usable Benzina rows');

  const stationMap = buildItalyStations(municipalities, stations.rows, prices.rows);
  if (![...stationMap.values()].some((entries) => entries.length > 0)) {
    throw new Error('MIMIT CSV has no usable Benzina station in target municipalities');
  }
  return { prices, stations };
}

/**
 * MIMIT `dtComu` values are commonly Italian `dd/mm/yyyy HH:mm:ss` strings,
 * which JavaScript parses inconsistently across runtimes. Keep a valid
 * observation date in an unambiguous ISO form; unknown source values stay
 * unknown rather than being replaced with the extraction date.
 */
function normalizeItalyObservationDate(value) {
  const source = String(value || '').trim();
  if (!source) return null;

  const italianDate = source.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (italianDate) {
    const [, dayText, monthText, yearText, hourText, minuteText, secondText] = italianDate;
    const day = Number(dayText);
    const month = Number(monthText);
    const year = Number(yearText);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    if (hourText !== undefined && (Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText ?? '0') > 59)) return null;
    return `${yearText}-${monthText}-${dayText}`;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(source)) {
    const date = new Date(`${source}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === source ? source : null;
  }

  const isoTimestamp = source.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/);
  if (!isoTimestamp) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone, , offsetHourText, offsetMinuteText] = isoTimestamp;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText ?? '0');
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (zone !== 'Z') {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return null;
  }
  const timestamp = Date.parse(source);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

async function fetchText(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'FrontaliereTicino/1.0' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`Request failed ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = attempt * 5_000;
      console.warn(`⚠️ Attempt ${attempt}/${retries} failed for ${url}: ${err.message} — retrying in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function toNumber(value) {
  const n = Number(String(value || '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function consistentValue(values, normalize = (value) => String(value).trim()) {
  const present = values.filter((value) => value != null && String(value).trim() !== '');
  if (!present.length) return { value: null, ambiguous: false };
  const normalized = present.map((value) => normalize(value));
  if (normalized.some((value) => value == null || value === '')) return { value: null, ambiguous: true };
  if (new Set(normalized).size !== 1) return { value: null, ambiguous: true };
  return { value: present[0], ambiguous: false };
}

function readApiCoordinatePair(station) {
  const location = station.location && typeof station.location === 'object' ? station.location : {};
  const candidates = [
    [location.lat, location.lng],
    [location.latitude, location.longitude],
    [location.lat, location.lon],
    [station.lat, station.lng],
    [station.latitude, station.longitude],
    [station.lat, station.lon],
  ];
  const pairs = [];
  for (const [latValue, lngValue] of candidates) {
    if (latValue == null || lngValue == null || String(latValue).trim() === '' || String(lngValue).trim() === '') continue;
    const lat = toNumber(latValue);
    const lng = toNumber(lngValue);
    if (lat == null || lng == null || lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    if (!pairs.some(([knownLat, knownLng]) => knownLat === lat && knownLng === lng)) pairs.push([lat, lng]);
  }
  if (pairs.length !== 1) return null;
  return { lat: pairs[0][0], lng: pairs[0][1] };
}

function readApiObservationTimestamp(station) {
  const values = [station.insertDate, station.dIns].filter((value) => value != null && String(value).trim() !== '');
  if (!values.length) return null;
  const normalized = values.map((value) => normalizeMimitApiObservationDate(value));
  if (normalized.some((value) => !value) || new Set(normalized).size !== 1) return null;
  return normalized[0];
}

function normalizeMimitApiObservationDate(value) {
  const normalized = normalizeItalyObservationDate(value);
  if (normalized) return normalized.slice(0, 10);
  // The legacy Osservaprezzi response documents `dIns` as a date-time but
  // emits it without a timezone. Preserve its verified calendar day instead
  // of inventing a timezone, which is all the downstream freshness contract
  // needs for the source snapshot.
  const legacy = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!legacy) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = legacy;
  const date = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)));
  if (date.getUTCFullYear() !== Number(yearText) || date.getUTCMonth() !== Number(monthText) - 1 || date.getUTCDate() !== Number(dayText)) return null;
  if (Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59) return null;
  return `${yearText}-${monthText}-${dayText}`;
}

function readApiFuelList(station) {
  const lists = [station.fuels, station.carburanti].filter(Array.isArray);
  if (!lists.length) return null;
  if (lists.length > 1 && JSON.stringify(lists[0]) !== JSON.stringify(lists[1])) return null;
  return lists[0];
}

function readApiBoolean(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return null;
}

function resolveApiMunicipality(station, province, municipalities) {
  const provinceCode = String(province || '').trim().toUpperCase();
  const provinceMunicipalities = municipalities.filter(
    (municipality) => String(municipality.province || '').trim().toUpperCase() === provinceCode,
  );
  if (!provinceMunicipalities.length) return null;

  const location = station.location && typeof station.location === 'object' ? station.location : {};
  const stationProvince = consistentValue(
    [station.province, station.provincia, location.province, location.provincia],
    (value) => normalizeText(value),
  );
  if (stationProvince.ambiguous || (stationProvince.value && normalizeText(stationProvince.value) !== normalizeText(provinceCode))) return null;

  const directTown = consistentValue(
    [station.town, station.comune, station.municipality, location.town, location.comune, location.municipality, location.city],
    (value) => normalizeText(value),
  );
  if (directTown.ambiguous) return null;
  if (directTown.value) {
    const directMatches = provinceMunicipalities.filter(
      (municipality) => normalizeText(municipality.name) === normalizeText(directTown.value),
    );
    return directMatches.length === 1 ? directMatches[0] : null;
  }

  const address = consistentValue([station.address, station.addr, station.indirizzo], (value) => normalizeText(value));
  if (address.ambiguous || !address.value) return null;
  const normalizedAddress = normalizeText(address.value);
  const suffixMatches = provinceMunicipalities.filter((municipality) => {
    const municipalitySuffix = `${normalizeText(municipality.name)}${normalizeText(provinceCode)}`;
    return municipalitySuffix && normalizedAddress.endsWith(municipalitySuffix);
  });
  return suffixMatches.length === 1 ? suffixMatches[0] : null;
}

function readApiFuelRows(station, observationTimestamp) {
  const fuels = readApiFuelList(station);
  if (!fuels) return [];
  const rows = [];
  for (const fuel of fuels) {
    if (!fuel || typeof fuel !== 'object') continue;
    const name = consistentValue([fuel.name, fuel.carb], (value) => normalizeText(value));
    if (name.ambiguous || !name.value) continue;
    const normalizedName = normalizeText(name.value);
    if (normalizedName !== 'BENZINA' && normalizedName !== 'GASOLIO') continue;
    const price = consistentValue([fuel.price, fuel.prezzo], (value) => {
      const parsed = toNumber(value);
      return parsed == null || parsed <= 0 ? null : String(parsed);
    });
    const self = consistentValue([fuel.isSelf], (value) => {
      const parsed = readApiBoolean(value);
      return parsed == null ? null : String(parsed);
    });
    if (price.ambiguous || self.ambiguous || price.value == null || self.value == null) continue;
    rows.push({
      descCarburante: normalizedName === 'BENZINA' ? 'Benzina' : 'Gasolio',
      prezzo: String(toNumber(price.value)),
      isSelf: readApiBoolean(self.value) ? '1' : '0',
      dtComu: observationTimestamp,
    });
  }
  return rows;
}

/**
 * Normalize the official MIMIT Osservaprezzi response into the same rows
 * consumed by the existing MIMIT CSV parser. The API has no municipality
 * filter in this job, so a station is accepted only when its province and
 * municipality are resolved unambiguously from the response/address.
 */
export function buildItalyRowsFromMimitApi({ municipalities, responses }) {
  if (!Array.isArray(municipalities) || !municipalities.length) throw new Error('MIMIT API fallback has no target municipalities');
  if (!Array.isArray(responses)) throw new Error('MIMIT API fallback response list is invalid');

  const stationsById = new Map();
  const pricesByKey = new Map();
  let latestObservedAt = null;
  for (const response of responses) {
    const province = String(response?.province || '').trim().toUpperCase();
    if (!province || !Array.isArray(response?.results)) continue;
    for (const station of response.results) {
      if (!station || typeof station !== 'object') continue;
      const id = consistentValue([station.id, station.idImpianto], (value) => String(value).trim());
      if (id.ambiguous || !id.value) continue;
      const municipality = resolveApiMunicipality(station, province, municipalities);
      if (!municipality) continue;
      const coordinates = readApiCoordinatePair(station);
      const observationTimestamp = readApiObservationTimestamp(station);
      if (!coordinates || !observationTimestamp) continue;
      const fuelRows = readApiFuelRows(station, observationTimestamp);
      if (!fuelRows.length) continue;

      const name = consistentValue([station.name, station.nome], (value) => normalizeText(value));
      const brand = consistentValue([station.brand, station.bnd, station.bandiera], (value) => normalizeText(value));
      const address = consistentValue([station.address, station.addr, station.indirizzo], (value) => normalizeText(value));
      if (name.ambiguous || brand.ambiguous || address.ambiguous) continue;
      const stationRow = {
        idImpianto: String(id.value),
        'Nome Impianto': name.value || brand.value || `Impianto ${id.value}`,
        Gestore: brand.value || '',
        Bandiera: brand.value || '',
        Indirizzo: address.value || '',
        Comune: municipality.name,
        Provincia: municipality.province,
        Latitudine: String(coordinates.lat),
        Longitudine: String(coordinates.lng),
      };
      const existingStation = stationsById.get(String(id.value));
      if (existingStation) {
        if (JSON.stringify(existingStation) !== JSON.stringify(stationRow)) {
          throw new Error(`MIMIT API returned conflicting station identity for ${id.value}`);
        }
      } else {
        stationsById.set(String(id.value), stationRow);
      }

      for (const fuelRow of fuelRows) {
        const key = `${id.value}:${fuelRow.descCarburante}:${fuelRow.isSelf}`;
        const normalizedPriceRow = { idImpianto: String(id.value), ...fuelRow };
        const existingPrice = pricesByKey.get(key);
        if (existingPrice && JSON.stringify(existingPrice) !== JSON.stringify(normalizedPriceRow)) {
          throw new Error(`MIMIT API returned conflicting price rows for ${key}`);
        }
        pricesByKey.set(key, normalizedPriceRow);
      }
      if (!latestObservedAt || Date.parse(observationTimestamp) > Date.parse(latestObservedAt)) latestObservedAt = observationTimestamp;
    }
  }

  const stationsRows = [...stationsById.values()];
  const pricesRows = [...pricesByKey.values()];
  if (!stationsRows.length || !pricesRows.some((row) => row.descCarburante === 'Benzina')) {
    throw new Error('MIMIT API returned no valid Benzina rows for target municipalities');
  }
  return {
    stationsRows,
    pricesRows,
    extractedAt: latestObservedAt?.slice(0, 10) ?? null,
  };
}

export async function fetchMimitApiSource(municipalities, { fetchImpl = fetch, retries = 3 } = {}) {
  const provinces = [...new Set(municipalities.map((municipality) => String(municipality.province || '').trim().toUpperCase()))]
    .filter(Boolean)
    .sort();
  if (!provinces.length) throw new Error('MIMIT API fallback has no target provinces');
  const responses = await mapWithConcurrency(provinces, MIMIT_API_CONCURRENCY, async (province) => {
    const region = MIMIT_API_REGION_BY_PROVINCE[province];
    if (region == null) throw new Error(`MIMIT API fallback has no region mapping for province ${province}`);
    const json = await fetchJsonWithRetry(MIMIT_API_URL, retries, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Osservaprezzi encodes the fuel and refuelling mode as <fuel>-<mode>;
      // 1 is Benzina and x means either self-service or served. `0-x` is not
      // the API's all-fuels selector and returns no usable station rows.
      body: JSON.stringify({ region, province, town: null, priceOrder: 'asc', fuelType: '1-x' }),
    }, fetchImpl, (payload) => {
      const results = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload?.array) ? payload.array : null;
      if (payload?.success !== true || !results || results.length === 0) {
        throw new Error(`MIMIT API returned no usable rows for province ${province}`);
      }
      return payload;
    });
    const results = Array.isArray(json?.results) ? json.results : Array.isArray(json?.array) ? json.array : null;
    if (json?.success !== true || !results) {
      throw new Error(`Unexpected response shape from ${MIMIT_API_URL} for province ${province}`);
    }
    return { province, results };
  });
  return { ok: true, source: 'mimit-api', ...buildItalyRowsFromMimitApi({ municipalities, responses }) };
}

// haversineKm (e il suo deg2rad) ora arrivano dal modulo condiviso
// scripts/lib/haversine.mjs: era una delle sei copie byte-equivalenti della
// stessa formula nel repo (#5002).

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, item) => sum + item, 0) / values.length;
}

function round(value, digits = 3) {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function extractEcbRate(xml) {
  const rateDateMatch = String(xml).match(/<Cube\b[^>]*\btime=['"](\d{4}-\d{2}-\d{2})['"][^>]*>/i);
  if (!rateDateMatch) throw new Error('ECB reference date not found in XML');
  const rateDate = rateDateMatch[1];
  const parsedRateDate = new Date(`${rateDate}T00:00:00.000Z`);
  if (!Number.isFinite(parsedRateDate.getTime()) || parsedRateDate.toISOString().slice(0, 10) !== rateDate) {
    throw new Error('Invalid ECB reference date in XML');
  }
  const match = String(xml).match(/currency=['"]CHF['"]\s+rate=['"]([\d.]+)['"]/i);
  if (!match) throw new Error('CHF rate not found in ECB XML');
  const chfPerEur = Number(match[1]);
  if (!Number.isFinite(chfPerEur) || chfPerEur <= 0) throw new Error('Invalid ECB CHF rate in XML');
  return {
    rateDate,
    chfPerEur,
    eurPerChf: 1 / chfPerEur,
  };
}

async function fetchJsonWithRetry(url, retries = 3, init = {}, fetchImpl = fetch, validateResponse = null) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, {
        ...init,
        headers: { 'user-agent': 'FrontaliereTicino/1.0', ...(init.headers || {}) },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const json = await res.json();
      return validateResponse ? validateResponse(json) : json;
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = attempt * 5_000;
      console.warn(`⚠️ Attempt ${attempt}/${retries} failed for ${url}: ${err.message} — retrying in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// `fiability` is the TCS proxy for price freshness. The previous direct-
// Firestore feed exposed a per-fuel timestamp; the public Cloud Function only
// returns this categorical signal. We drop OUTDATED_LAST_PRICE_UPDATE (matches
// the spirit of the old 30-day max-age cutoff) and keep the rest.
const STALE_FIABILITY = new Set(['OUTDATED_LAST_PRICE_UPDATE']);

async function fetchSwissStationsByFuel(fuel) {
  const body = {
    zoom: SWISS_TCS_ZOOM,
    pixelRatio: 1,
    bbox: SWISS_TCS_BBOX,
    filters: { fuel, brands: [] },
  };
  const json = await fetchJsonWithRetry(SWISS_TCS_BBOX_URL, 3, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      referer: SWISS_TCS_REFERER,
    },
    body: JSON.stringify(body),
  });
  if (!Array.isArray(json)) throw new Error(`Unexpected response shape from ${SWISS_TCS_BBOX_URL}`);
  return json;
}

async function fetchSwissStations() {
  // Two calls: SP95 (mandatory) + DIESEL (best-effort). Join by station id.
  const [sp95Raw, dieselRaw] = await Promise.all([
    fetchSwissStationsByFuel('SP95'),
    fetchSwissStationsByFuel('DIESEL').catch((err) => {
      console.warn(`⚠️ DIESEL fetch failed (continuing without diesel): ${err.message}`);
      return [];
    }),
  ]);
  const dieselById = new Map();
  for (const station of dieselRaw) {
    if (station.cluster || !station.id) continue;
    if (STALE_FIABILITY.has(station.fiability)) continue;
    if (!Number.isFinite(Number(station.price))) continue;
    dieselById.set(station.id, station);
  }

  const generatedAtIso = new Date().toISOString();
  const out = [];
  for (const station of sp95Raw) {
    if (station.cluster || !station.id) continue;
    if (STALE_FIABILITY.has(station.fiability)) continue;
    const lat = Number(station.latitude);
    const lng = Number(station.longitude);
    const sp95Price = Number(station.price);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(sp95Price)) continue;

    const diesel = dieselById.get(station.id);
    const dieselPriceChf = diesel ? Number(diesel.price) : null;

    out.push({
      id: String(station.id),
      name: station.displayName || station.brand || 'Station',
      brand: station.brand && station.brand !== 'UNDEFINED' ? station.brand : '',
      address: station.formattedAddress || '',
      lat,
      lng,
      sp95PriceChf: sp95Price,
      dieselPriceChf: Number.isFinite(dieselPriceChf) ? dieselPriceChf : null,
      dieselSource: diesel ? 'api' : 'unknown',
      // The CF response no longer carries a per-station lastPriceUpdate. We
      // record the snapshot time so dedup tiebreaks remain meaningful and the
      // UI's "ultimo aggiornamento" label keeps showing a date instead of
      // disappearing.
      dieselUpdatedAt: diesel ? generatedAtIso : null,
      updatedAt: generatedAtIso,
    });
  }
  return out;
}

export function buildItalyStations(municipalities, stationsRows, pricesRows) {
  const municipalityIndex = new Map();
  for (const municipality of municipalities) {
    municipalityIndex.set(`${normalizeText(municipality.name)}:${municipality.province}`, municipality);
  }

  const stationsById = new Map();
  for (const row of stationsRows) {
    const municipality = municipalityIndex.get(`${normalizeText(row.Comune)}:${String(row.Provincia || '').toUpperCase()}`);
    if (!municipality) continue;
    stationsById.set(String(row.idImpianto), {
      id: String(row.idImpianto),
      municipalityName: municipality.name,
      province: municipality.province,
      name: row['Nome Impianto'] || row.Gestore || 'Impianto',
      brand: row.Bandiera || '',
      address: row.Indirizzo || '',
      lat: toNumber(row.Latitudine),
      lng: toNumber(row.Longitudine),
    });
  }

  // Merge the per-fuel MIMIT price rows into one entry per
  // station + service-mode (self/served). Each station publishes up to four
  // rows (self/served × Benzina/Gasolio). We keep `priceEur` = Benzina (the
  // historically-tracked cut, consumed by FuelPriceStats + snapshot history)
  // and add `dieselPriceEur` = Gasolio alongside so the diesel pages can show
  // real diesel prices and link per-station detail pages.
  const entryByKey = new Map();
  for (const row of pricesRows) {
    const desc = String(row.descCarburante || '');
    if (desc !== 'Benzina' && desc !== 'Gasolio') continue;
    const station = stationsById.get(String(row.idImpianto));
    const price = toNumber(row.prezzo);
    if (!station || price == null) continue;
    const isSelf = String(row.isSelf || '') === '1';
    const key = `${station.id}:${isSelf ? 'self' : 'served'}`;
    let entry = entryByKey.get(key);
    if (!entry) {
      entry = {
        id: station.id,
        stationName: station.name,
        brand: station.brand,
        address: station.address,
        lat: station.lat,
        lng: station.lng,
        priceEur: null,
        dieselPriceEur: null,
        benzinaUpdatedAt: null,
        dieselUpdatedAt: null,
        isSelf,
        updatedAt: row.dtComu || null,
        municipalityKey: `${station.municipalityName}:${station.province}`,
      };
      entryByKey.set(key, entry);
    }
    if (desc === 'Benzina') {
      entry.priceEur = price;
      entry.benzinaUpdatedAt = normalizeItalyObservationDate(row.dtComu);
    } else {
      entry.dieselPriceEur = price;
      entry.dieselUpdatedAt = normalizeItalyObservationDate(row.dtComu);
    }
    if (row.dtComu) entry.updatedAt = row.dtComu;
  }

  const pricesByMunicipality = new Map();
  for (const entry of entryByKey.values()) {
    // Keep `italy.stations` benzina-anchored: only emit entries that carry a
    // Benzina price (every downstream benzina consumer assumes `priceEur` is a
    // number). Diesel-only stations are dropped — extremely rare at the border
    // and not worth the null-guard churn across FuelPriceStats/snapshot.
    if (entry.priceEur == null) continue;
    const key = entry.municipalityKey;
    delete entry.municipalityKey;
    if (!pricesByMunicipality.has(key)) pricesByMunicipality.set(key, []);
    pricesByMunicipality.get(key).push(entry);
  }
  return pricesByMunicipality;
}

function summarizeItalyStations(stations) {
  const allPrices = stations.map((station) => station.priceEur);
  const selfPrices = stations.filter((station) => station.isSelf).map((station) => station.priceEur);
  const servedPrices = stations.filter((station) => !station.isSelf).map((station) => station.priceEur);
  const sorted = [...stations].sort((a, b) => a.priceEur - b.priceEur);
  const cheapest = sorted[0] || null;
  // Diesel (Gasolio) aggregates — computed only over stations that reported a
  // diesel price. Used by the diesel city pages' cross-border verdict.
  const dieselPrices = stations
    .map((station) => station.dieselPriceEur)
    .filter((p) => typeof p === 'number' && Number.isFinite(p));
  return {
    stationCount: stations.length,
    minPriceEur: cheapest ? round(cheapest.priceEur) : null,
    avgPriceEur: round(average(allPrices)),
    maxPriceEur: round(allPrices.length ? Math.max(...allPrices) : null),
    minSelfPriceEur: selfPrices.length ? round(Math.min(...selfPrices)) : null,
    minServedPriceEur: servedPrices.length ? round(Math.min(...servedPrices)) : null,
    minDieselPriceEur: dieselPrices.length ? round(Math.min(...dieselPrices)) : null,
    avgDieselPriceEur: dieselPrices.length ? round(average(dieselPrices)) : null,
    dieselStationCount: dieselPrices.length,
    cheapestStation: cheapest,
    stations: sorted,
  };
}

export function buildSwissBorderStations(municipalities, swissStations, eurPerChf) {
  const filtered = [];
  for (const station of swissStations) {
    let closestMunicipality = null;
    let minDistance = Number.POSITIVE_INFINITY;
    for (const municipality of municipalities) {
      const distanceKm = haversineKm(municipality.lat, municipality.lng, station.lat, station.lng);
      if (distanceKm < minDistance) {
        minDistance = distanceKm;
        closestMunicipality = municipality;
      }
    }
    if (minDistance > SWISS_BORDER_FILTER_KM) continue;
    filtered.push({
      ...station,
      nearestMunicipality: closestMunicipality ? `${closestMunicipality.name} (${closestMunicipality.province})` : null,
      nearestMunicipalityDistanceKm: round(minDistance, 1),
      sp95PriceEur: round(station.sp95PriceChf * eurPerChf),
      dieselPriceEur:
        station.dieselPriceChf != null && Number.isFinite(station.dieselPriceChf)
          ? round(station.dieselPriceChf * eurPerChf)
          : null,
    });
  }
  return filtered.sort((a, b) => a.sp95PriceChf - b.sp95PriceChf);
}

export function buildDataset({
  municipalities,
  italyExtractedAt,
  swissStations,
  italyByMunicipality,
  exchangeRate,
  italyStatus = null,
}) {
  const municipalityRows = municipalities.map((municipality) => {
    const italyStations = italyByMunicipality.get(`${municipality.name}:${municipality.province}`) || [];
    const italy = summarizeItalyStations(italyStations);
    const swissCandidates = swissStations
      .map((station) => ({
        ...station,
        distanceKm: round(haversineKm(municipality.lat, municipality.lng, station.lat, station.lng), 1),
      }))
      .filter((station) => station.distanceKm <= SWISS_SEARCH_RADIUS_KM)
      .sort((a, b) => a.sp95PriceChf - b.sp95PriceChf);

    const cheapestSwiss = swissCandidates[0] || null;
    // `cheapestStation`/`nearbyStations` are ranked + truncated by sp95
    // (benzina). For an accurate diesel verdict we must rank the FULL 20km
    // candidate set by diesel and persist the genuinely diesel-cheapest pump,
    // since it can fall outside the sp95 top-5.
    const dieselCandidates = swissCandidates.filter(
      (station) => typeof station.dieselPriceEur === 'number' && Number.isFinite(station.dieselPriceEur),
    );
    const cheapestDieselSwiss = dieselCandidates.length
      ? dieselCandidates.reduce((min, station) => (station.dieselPriceEur < min.dieselPriceEur ? station : min))
      : null;
    let cheaperCountry = 'NO_DATA';
    let priceDeltaEur = null;
    let saving50LEur = null;
    if (italy.minPriceEur != null && cheapestSwiss?.sp95PriceEur != null) {
      priceDeltaEur = round(cheapestSwiss.sp95PriceEur - italy.minPriceEur);
      saving50LEur = round(Math.abs(priceDeltaEur) * 50, 2);
      if (Math.abs(priceDeltaEur) < 0.005) cheaperCountry = 'SAME';
      else cheaperCountry = priceDeltaEur > 0 ? 'IT' : 'CH';
    }

    return {
      municipality: municipality.name,
      province: municipality.province,
      lat: municipality.lat,
      lng: municipality.lng,
      distanceKm: municipality.distanceKm,
      fascia: municipality.fascia,
      italy,
      swiss: {
        searchRadiusKm: SWISS_SEARCH_RADIUS_KM,
        optionCount: swissCandidates.length,
        dieselOptionCount: dieselCandidates.length,
        cheapestStation: cheapestSwiss,
        nearbyStations: swissCandidates.slice(0, TOP_SWISS_OPTIONS),
        minPriceChf: cheapestSwiss ? round(cheapestSwiss.sp95PriceChf) : null,
        minPriceEur: cheapestSwiss ? round(cheapestSwiss.sp95PriceEur) : null,
        // Diesel-ranked over the full candidate set (not sp95-truncated).
        cheapestDieselStation: cheapestDieselSwiss,
        minDieselPriceChf: cheapestDieselSwiss ? round(cheapestDieselSwiss.dieselPriceChf) : null,
        minDieselPriceEur: cheapestDieselSwiss ? round(cheapestDieselSwiss.dieselPriceEur) : null,
      },
      comparison: {
        cheaperCountry,
        priceDeltaEur,
        saving50LEur,
      },
    };
  });

  const comparisonRows = municipalityRows.filter((row) => row.comparison.cheaperCountry !== 'NO_DATA');
  const cheaperItalyCount = comparisonRows.filter((row) => row.comparison.cheaperCountry === 'IT').length;
  const cheaperSwissCount = comparisonRows.filter((row) => row.comparison.cheaperCountry === 'CH').length;
  const tieCount = comparisonRows.filter((row) => row.comparison.cheaperCountry === 'SAME').length;

  const cheapestItalyMunicipalities = municipalityRows
    .filter((row) => row.italy.minPriceEur != null)
    .sort((a, b) => a.italy.minPriceEur - b.italy.minPriceEur)
    .slice(0, 20)
    .map((row) => ({
      municipality: row.municipality,
      province: row.province,
      minPriceEur: row.italy.minPriceEur,
      cheapestStation: row.italy.cheapestStation,
    }));

  const bestCrossBorderSavings = comparisonRows
    .slice()
    .sort((a, b) => {
      const aValue = a.comparison.saving50LEur || 0;
      const bValue = b.comparison.saving50LEur || 0;
      return bValue - aValue;
    })
    .slice(0, 20)
    .map((row) => ({
      municipality: row.municipality,
      province: row.province,
      cheaperCountry: row.comparison.cheaperCountry,
      saving50LEur: row.comparison.saving50LEur,
      italyPriceEur: row.italy.minPriceEur,
      swissPriceEur: row.swiss.minPriceEur,
      swissPriceChf: row.swiss.minPriceChf,
      swissStation: row.swiss.cheapestStation,
    }));

  const swissUpdatedAtValues = swissStations.map((item) => item.updatedAt).filter(Boolean).sort();
  const swissWithDiesel = swissStations.filter(
    (s) => typeof s.dieselPriceChf === 'number' && Number.isFinite(s.dieselPriceChf),
  ).length;
  const swissDieselCoveragePct = swissStations.length
    ? Math.round((swissWithDiesel / swissStations.length) * 1000) / 10
    : 0;

  return {
    generatedAt: new Date().toISOString(),
    sources: {
      italy: {
        provider: 'MIMIT Open Data',
        priceSnapshotDate: italyExtractedAt,
        stationsUrl: ITALY_STATIONS_URL,
        pricesUrl: ITALY_PRICES_URL,
        // `live` when this run read MIMIT; otherwise the Italian rows are the
        // previous snapshot (`carried-over`) or absent (`unavailable`), and
        // `priceSnapshotDate` keeps the date of the cut actually shown.
        status: italyStatus?.status ?? 'live',
        ...(italyStatus?.reason ? { unavailableReason: italyStatus.reason } : {}),
      },
      switzerland: {
        provider: 'TCS Benzinpreis',
        providerUrl: 'https://benzin.tcs.ch/de/map/SP95',
        stationCount: swissStations.length,
        latestObservedUpdate: swissUpdatedAtValues[swissUpdatedAtValues.length - 1] || null,
        // F6 — real-diesel ingestion. See `fetchSwissStations` above for the
        // dual SP95 + DIESEL pull from the TCS Cloud Function.
        dieselStationCount: swissWithDiesel,
        dieselCoveragePct: swissDieselCoveragePct,
      },
      exchangeRate: {
        provider: 'ECB',
        sourceUrl: ECB_DAILY_URL,
        rateDate: exchangeRate.rateDate ?? null,
        chfPerEur: round(exchangeRate.chfPerEur, 6),
        eurPerChf: round(exchangeRate.eurPerChf, 6),
      },
    },
    summary: {
      municipalityCount: municipalityRows.length,
      municipalitiesWithItalyPrices: municipalityRows.filter((row) => row.italy.stationCount > 0).length,
      municipalitiesWithSwissComparison: comparisonRows.length,
      cheaperItalyCount,
      cheaperSwissCount,
      tieCount,
      cheapestItalyMunicipality: cheapestItalyMunicipalities[0] || null,
      cheapestSwissStation: swissStations[0] || null,
    },
    rankings: {
      cheapestItalyMunicipalities,
      cheapestSwissStations: swissStations.slice(0, 20),
      bestCrossBorderSavings,
    },
    municipalities: municipalityRows,
  };
}

function readPreviousDataset() {
  try {
    return JSON.parse(fs.readFileSync(DATA_OUT, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Rebuild the per-municipality Italian station map from a previously
 * published dataset. `summarizeItalyStations` keeps the full sorted station
 * list, so the rows round-trip without a new MIMIT read.
 */
export function italyByMunicipalityFromDataset(dataset) {
  const map = new Map();
  for (const row of dataset?.municipalities ?? []) {
    const stations = row?.italy?.stations;
    if (!Array.isArray(stations) || stations.length === 0) continue;
    map.set(`${row.municipality}:${row.province}`, stations.map((station) => ({ ...station })));
  }
  return map;
}

/**
 * Decide which Italian rows this run publishes. A live MIMIT read wins; on a
 * failed read the previous snapshot is carried over with its own date, so
 * every Italian price stays labelled with the day it was reported and the
 * Swiss half can still be refreshed.
 */
export function resolveItalySource({ italyResult, municipalities, previousDataset }) {
  if (italyResult?.ok) {
    if (italyResult.source === 'mimit-api') {
      return {
        status: 'live',
        reason: null,
        extractedAt: italyResult.extractedAt,
        italyByMunicipality: buildItalyStations(municipalities, italyResult.stationsRows, italyResult.pricesRows),
      };
    }
    const prices = parseDelimited(italyResult.pricesText);
    const stations = parseDelimited(italyResult.stationsText);
    return {
      status: 'live',
      reason: null,
      extractedAt: prices.extractedAt,
      italyByMunicipality: buildItalyStations(municipalities, stations.rows, prices.rows),
    };
  }
  const reason = italyResult?.error instanceof Error ? italyResult.error.message : String(italyResult?.error ?? 'unknown error');
  const carried = italyByMunicipalityFromDataset(previousDataset);
  if (carried.size > 0) {
    return {
      status: 'carried-over',
      reason,
      extractedAt: previousDataset?.sources?.italy?.priceSnapshotDate ?? null,
      italyByMunicipality: carried,
    };
  }
  return { status: 'unavailable', reason, extractedAt: null, italyByMunicipality: new Map() };
}

/**
 * Hand-off for `scripts/build-fuel-cantons-dataset.mjs` (P9b): the full
 * border-strip Swiss station list and every Italian MIMIT row of the border
 * municipalities, which `buildDataset` truncates (top-N per municipality) and
 * therefore cannot be re-read from `data/fuel-prices.json`. Written to a temp
 * path only when `--cantons-input-out <file>` is passed, so no second request
 * to TCS/MIMIT is ever needed for the canton dataset.
 */
export function buildFuelCantonsInput({ generatedAt, italyExtractedAt, swissStations, italyByMunicipality, exchangeRate }) {
  const italyStations = [];
  for (const [key, entries] of italyByMunicipality) {
    const province = String(key).split(':').pop();
    for (const entry of entries) {
      italyStations.push({
        id: entry.id,
        province,
        isSelf: entry.isSelf,
        priceEur: entry.priceEur,
        dieselPriceEur: entry.dieselPriceEur,
        updatedAt: entry.updatedAt,
      });
    }
  }
  return {
    generatedAt,
    italyExtractedAt,
    exchangeRate: { chfPerEur: exchangeRate.chfPerEur, eurPerChf: exchangeRate.eurPerChf },
    swissStations: swissStations.map((s) => ({
      id: s.id,
      address: s.address,
      lat: s.lat,
      lng: s.lng,
      sp95PriceChf: s.sp95PriceChf,
      dieselPriceChf: s.dieselPriceChf,
      updatedAt: s.updatedAt,
    })),
    italyStations,
  };
}

// ─── Firestore write ────────────────────────────────────────

async function writeToFirestore(payload) {
  const { getApps, initializeApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (!getApps().length) {
    initializeApp({ projectId: process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || 'frontaliere-ticino' });
  }
  const db = getFirestore();

  const metadataDoc = {
    generatedAt: payload.generatedAt,
    sources: payload.sources,
    summary: payload.summary,
    rankings: payload.rankings,
    municipalities: payload.municipalities.map((m) => ({
      municipality: m.municipality, province: m.province,
      lat: m.lat, lng: m.lng, distanceKm: m.distanceKm, fascia: m.fascia,
      comparison: m.comparison,
    })),
  };

  const italyDoc = {
    municipalities: payload.municipalities
      .filter((m) => m.italy.stationCount > 0)
      .map((m) => ({ municipality: m.municipality, province: m.province, italy: m.italy })),
  };

  const switzerlandDoc = {
    municipalities: payload.municipalities
      .filter((m) => m.swiss.optionCount > 0)
      .map((m) => ({ municipality: m.municipality, province: m.province, swiss: m.swiss })),
  };

  const batch = db.batch();
  const col = db.collection('fuelPrices');
  batch.set(col.doc('metadata'), metadataDoc);
  batch.set(col.doc('italy'), italyDoc);
  batch.set(col.doc('switzerland'), switzerlandDoc);
  await batch.commit();

  console.log('🔥 Firestore: wrote 3 docs (metadata: ' + JSON.stringify(metadataDoc).length + ' B, italy: ' + JSON.stringify(italyDoc).length + ' B, switzerland: ' + JSON.stringify(switzerlandDoc).length + ' B)');
}

async function main() {
  const municipalities = readMunicipalities();
  if (!municipalities.length) throw new Error('Unable to read municipalities dataset');

  const saveLocal = process.argv.includes('--save-local');
  const cantonsInputFlag = process.argv.indexOf('--cantons-input-out');
  const cantonsInputOut = cantonsInputFlag >= 0 ? process.argv[cantonsInputFlag + 1] : null;

  try {
    // MIMIT is fetched apart from TCS/ECB: from 2026-10-17 its host stopped
    // answering the runners (`fetch failed` on every daily run), and because
    // the four requests shared one Promise.all the Swiss TCS prices — the
    // only source of the /prezzi-*/oggi/ pages — were thrown away with it.
    // An Italian outage now degrades the Italian half only (see
    // `resolveItalySource`); TCS/ECB failures keep the old skip behaviour.
    const italyFetch = Promise.all([fetchText(ITALY_PRICES_URL), fetchText(ITALY_STATIONS_URL)])
      .then(([pricesText, stationsText]) => {
        validateMimitCsvPayload({ pricesText, stationsText, municipalities });
        return { ok: true, pricesText, stationsText };
      })
      .catch(async (csvError) => {
        try {
          const apiResult = await fetchMimitApiSource(municipalities);
          console.warn(`::warning::[fuel] MIMIT bulk CSV unavailable (${csvError.message}) — official Osservaprezzi API fallback used`);
          return apiResult;
        } catch (apiError) {
          const csvMessage = csvError instanceof Error ? csvError.message : String(csvError);
          const apiMessage = apiError instanceof Error ? apiError.message : String(apiError);
          const combined = new Error(`MIMIT bulk CSV unavailable (${csvMessage}); official Osservaprezzi API fallback failed (${apiMessage})`);
          combined.cause = apiError;
          return { ok: false, error: combined };
        }
      });
    const [italyResult, ecbXml, swissDocs] = await Promise.all([
      italyFetch,
      fetchText(ECB_DAILY_URL),
      fetchSwissStations(),
    ]);

    const exchangeRate = extractEcbRate(ecbXml);
    const italySource = resolveItalySource({
      italyResult,
      municipalities,
      previousDataset: readPreviousDataset(),
    });
    if (italySource.status !== 'live') {
      console.warn(`::warning::[fuel] MIMIT unavailable (${italySource.reason}) — Swiss TCS prices refreshed, Italian prices ${italySource.status === 'carried-over' ? `carried over from the ${italySource.extractedAt} snapshot` : 'omitted (no previous snapshot)'}`);
    }
    const italyByMunicipality = italySource.italyByMunicipality;
    const prices = { extractedAt: italySource.extractedAt };

    // AE-9 — collapse duplicate TCS records (same name + address, drifted
    // coords) before geo-filtering so every downstream consumer sees one
    // canonical entry per physical station.
    const { unique: dedupedSwissDocs, removed: swissRemoved } = dedupStations(swissDocs);
    if (swissRemoved.length > 0) {
      console.log(`⛽ Swiss station dedup: collapsed ${swissRemoved.length} duplicate record(s) (${swissDocs.length} → ${dedupedSwissDocs.length}).`);
    }

    const swissStations = buildSwissBorderStations(municipalities, dedupedSwissDocs, exchangeRate.eurPerChf);

    const payload = buildDataset({
      municipalities,
      italyExtractedAt: prices.extractedAt,
      swissStations,
      italyByMunicipality,
      exchangeRate,
      italyStatus: italySource.status === 'live' ? null : { status: italySource.status, reason: italySource.reason },
    });

    // Retry Firestore write — transient 503/UNAVAILABLE errors happen
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await writeToFirestore(payload);
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        console.warn(`⚠️ Firestore write attempt ${attempt}/3 failed: ${err.message} — retrying in ${attempt * 3}s`);
        await new Promise((r) => setTimeout(r, attempt * 3_000));
      }
    }

    if (saveLocal) {
      writeJson(DATA_OUT, payload);
      writeJson(PUBLIC_OUT, payload);
      console.log('💾 Local JSON files written (--save-local)');
    }

    if (cantonsInputOut) {
      // A carried-over Italian snapshot stays out of the canton hand-off: the
      // canton builder dates IT records by the fetch, and an old MIMIT cut
      // there would read as today's. Without it the builder reports IT
      // `failed`, which is the truth for this run.
      const liveItaly = italySource.status === 'live';
      writeJson(cantonsInputOut, buildFuelCantonsInput({
        generatedAt: payload.generatedAt,
        italyExtractedAt: liveItaly ? prices.extractedAt : null,
        swissStations,
        italyByMunicipality: liveItaly ? italyByMunicipality : new Map(),
        exchangeRate,
      }));
      console.log(`💾 Canton dataset hand-off written to ${cantonsInputOut}`);
    }

    console.log('⛽ Fuel dataset generated: ' + payload.summary.municipalityCount + ' municipalities, ' + payload.summary.municipalitiesWithItalyPrices + ' with Italian prices, ' + payload.summary.municipalitiesWithSwissComparison + ' with IT/CH comparison.');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? error.cause : undefined;
    const isTransientFetch =
      msg.includes('fetch failed') ||
      msg.includes('TIMEOUT') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('ENOTFOUND') ||
      (cause && String(cause).includes('ConnectTimeoutError'));

    if (isTransientFetch) {
      console.warn('⚠️ Fuel dataset refresh skipped — external API unreachable: ' + msg);
      console.warn('ℹ️ Existing data in Firestore remains valid. Exiting gracefully.');
      process.exit(0);
    }

    console.error('⚠️ Fuel dataset refresh failed. ' + msg);
    throw error;
  }
}

// Only run main() when invoked as a CLI, not when imported (e.g. by tests).
const invokedAsCli = process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (invokedAsCli) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
