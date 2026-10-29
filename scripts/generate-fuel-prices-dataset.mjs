#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

import fs from 'node:fs';
import { haversineKm } from './lib/haversine.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStationCantonResolver } from './lib/fuel-cantons-dataset.mjs';
import {
  FUEL_STATION_SCHEMA_VERSION,
  dedupStations,
  normaliseFuelStationObservation,
  sortStationsStable,
} from './lib/fuel-station-dedup.mjs';
import {
  OSM_FUEL_DATA_URL,
  OSM_FUEL_LICENSE,
  OSM_FUEL_MAP_URL,
  OSM_FUEL_PROVIDER,
  OSM_FUEL_SOURCE,
  mergeSwissStationInventories,
} from './lib/fuel-openstreetmap.mjs';
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
// Osservaprezzi answers concurrent bursts with HTTP 429. Keep both lookup
// levels serial and enforce the same spacing through the request wrapper. A
// province response that already contains a target row stays bounded; only an
// empty target result falls back to the same official endpoint per town.
const MIMIT_API_CONCURRENCY = 1;
const MIMIT_API_TOWN_CONCURRENCY = 1;
const MIMIT_API_MIN_INTERVAL_MS = 1_000;
const MIMIT_API_RATE_LIMIT_DEFAULT_COOLDOWN_MS = 15_000;
const MIMIT_API_RATE_LIMIT_MAX_COOLDOWN_MS = 60_000;
const MIMIT_MAX_AGE_HOURS = 48;
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
// The verified TCS Cloud Function accepts a bbox + fuel filter and returns
// concrete station rows at zoom 18. The national bbox was verified against
// the public Cloud Function on 2026-10-29: [6.0, 45.7, 10.7, 47.0] returned
// only 1,634 SP95 rows, while this envelope returned 3,954 SP95 rows / 3,956
// DIESEL rows and reaches latitude 47.79. Keep this as a source-contract
// invariant: changing it changes national coverage, not just request tuning.
// The border comparator is derived later by the explicit 25 km geo-filter.
// Keep the national query separate from that consumer filter so the full
// source snapshot remains available without changing existing comparator rows.
export const SWISS_TCS_BBOX = Object.freeze([5.8, 45.7, 10.7, 47.9]);
const SWISS_TCS_SOURCE = 'tcs-benzinpreis-cloud-function';
const SWISS_TCS_ZOOM = 18;
const SWISS_SEARCH_RADIUS_KM = 20;
const SWISS_BORDER_FILTER_KM = 25;
const TOP_SWISS_OPTIONS = 5;
const FUEL_DATASET_SCHEMA_VERSION = 2;
const SWISS_INVENTORY_PATH = path.join(ROOT, 'data', 'fuel-station-inventory.json');
const SWISS_NATIONAL_FIRESTORE_CHUNK_SIZE = 250;
const SWISS_BORDER_FIRESTORE_CHUNK_SIZE = 50;

function chunkRows(rows, chunkSize, label) {
  const input = Array.isArray(rows) ? rows : [];
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) throw new Error(`${label} chunk size must be a positive integer`);
  const chunks = [];
  for (let index = 0; index < input.length; index += chunkSize) chunks.push(input.slice(index, index + chunkSize));
  return chunks;
}

export function chunkSwissNationalStations(stations, chunkSize = SWISS_NATIONAL_FIRESTORE_CHUNK_SIZE) {
  return chunkRows(stations, chunkSize, 'Swiss national');
}

/**
 * Keep the legacy border-comparator projection under Firestore's 1 MiB
 * document limit once the national station feed grows. The national feed has
 * its own chunks; this projection needs the same treatment independently.
 */
export function chunkSwissBorderMunicipalities(
  municipalities,
  chunkSize = SWISS_BORDER_FIRESTORE_CHUNK_SIZE,
) {
  return chunkRows(municipalities, chunkSize, 'Swiss border');
}

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
export function validateMimitCsvPayload({ pricesText, stationsText, municipalities, now = new Date(), maxAgeHours = MIMIT_MAX_AGE_HOURS }) {
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

  const latestObservationTimestamp = assertMimitObservationFresh(latestMimitObservationTimestamp(prices.rows), now, maxAgeHours);
  const stationMap = buildItalyStations(municipalities, stations.rows, prices.rows);
  if (![...stationMap.values()].some((entries) => entries.length > 0)) {
    throw new Error('MIMIT CSV has no usable Benzina station in target municipalities');
  }
  return {
    prices,
    stations,
    latestObservedAt: latestObservationTimestamp.slice(0, 10),
    latestObservationTimestamp,
  };
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

function italyLocalTimestampToIso(year, month, day, hour = 0, minute = 0, second = 0) {
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(localAsUtc)) return null;
  let utcMillis = localAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Rome',
      timeZoneName: 'shortOffset',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(utcMillis));
    const offsetToken = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
    const offsetMatch = offsetToken.match(/^GMT(?:(\+|-)(\d{1,2})(?::(\d{2}))?)?$/);
    if (!offsetMatch) return null;
    const offsetMinutes = offsetMatch[1]
      ? (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3] ?? '0')) * (offsetMatch[1] === '-' ? -1 : 1)
      : 0;
    const nextUtcMillis = localAsUtc - offsetMinutes * 60_000;
    if (nextUtcMillis === utcMillis) break;
    utcMillis = nextUtcMillis;
  }
  const result = new Date(utcMillis);
  return Number.isFinite(result.getTime()) ? result.toISOString() : null;
}

function normalizeItalyObservationTimestamp(value) {
  const source = String(value || '').trim();
  const italianDate = source.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (italianDate) {
    const [, dayText, monthText, yearText, hourText = '00', minuteText = '00', secondText = '00'] = italianDate;
    const dateOnly = normalizeItalyObservationDate(`${dayText}/${monthText}/${yearText}`);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    if (!dateOnly || hour > 23 || minute > 59 || second > 59) return null;
    return italyLocalTimestampToIso(Number(yearText), Number(monthText), Number(dayText), hour, minute, second);
  }

  const normalized = normalizeItalyObservationDate(source);
  if (!normalized) return null;
  return normalized.length > 10 ? normalized : `${normalized}T00:00:00.000Z`;
}

function latestMimitObservationTimestamp(rows) {
  const timestamps = rows
    .filter((row) => (
      String(row.descCarburante || '').trim() === 'Benzina'
      && String(row.idImpianto || '').trim() !== ''
      && toNumber(row.prezzo) != null
    ))
    .map((row) => normalizeItalyObservationTimestamp(row.dtComu))
    .filter(Boolean)
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return timestamps[timestamps.length - 1] ?? null;
}

function assertMimitObservationFresh(observedAtIso, now = new Date(), maxAgeHours = MIMIT_MAX_AGE_HOURS) {
  if (!observedAtIso) throw new Error('MIMIT source has no usable Benzina observation timestamp');
  const observedAt = Date.parse(observedAtIso);
  const ageHours = (now.getTime() - observedAt) / 3_600_000;
  if (!Number.isFinite(observedAt) || !Number.isFinite(ageHours) || ageHours > maxAgeHours) {
    throw new Error(`MIMIT Benzina observations are older than ${maxAgeHours}h (latest ${observedAtIso})`);
  }
  return observedAtIso;
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
  const normalized = values.map((value) => normalizeMimitApiObservationTimestamp(value));
  if (normalized.some((value) => !value) || new Set(normalized).size !== 1) return null;
  return normalized[0];
}

function normalizeMimitApiObservationTimestamp(value) {
  const normalized = normalizeItalyObservationTimestamp(value);
  if (normalized) return normalized;
  const legacy = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!legacy) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = legacy;
  const date = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)));
  if (date.getUTCFullYear() !== Number(yearText) || date.getUTCMonth() !== Number(monthText) - 1 || date.getUTCDate() !== Number(dayText)) return null;
  if (Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59) return null;
  // The API's legacy `dIns` alias is documented without a timezone and is
  // paired with the ISO `insertDate` field in the same response. Treat its
  // wall-clock value as UTC so the two documented aliases compare equal.
  return new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText), Number(hourText), Number(minuteText), Number(secondText))).toISOString();
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
      const fuelRows = readApiFuelRows(station, observationTimestamp.slice(0, 10));
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
  // The area endpoint can return a valid, bounded subset of a province. The
  // bulk CSV validator above has the same invariant: at least one proven
  // Benzina station in the target set, not synthetic coverage for every
  // municipality. Requiring every target here caused an N×municipality retry
  // storm and turned a usable live source into HTTP 429 carry-over.
  if (!stationsRows.length || !pricesRows.some((row) => row.descCarburante === 'Benzina')) {
    throw new Error('MIMIT API returned no valid Benzina rows for target municipalities');
  }
  return {
    stationsRows,
    pricesRows,
    extractedAt: latestObservedAt?.slice(0, 10) ?? null,
    latestObservedAt,
  };
}

function retryAfterMs(response) {
  const value = response?.headers?.get?.('retry-after');
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) {
      return Math.min(
        MIMIT_API_RATE_LIMIT_MAX_COOLDOWN_MS,
        Math.max(MIMIT_API_MIN_INTERVAL_MS, seconds * 1_000),
      );
    }
    const retryAt = Date.parse(value);
    if (Number.isFinite(retryAt)) {
      return Math.min(
        MIMIT_API_RATE_LIMIT_MAX_COOLDOWN_MS,
        Math.max(MIMIT_API_MIN_INTERVAL_MS, retryAt - Date.now()),
      );
    }
  }
  return MIMIT_API_RATE_LIMIT_DEFAULT_COOLDOWN_MS;
}

/**
 * Serialize the official API requests and leave a measured gap between them.
 * The fallback may schedule a province lookup and several town lookups from
 * different workers; limiting only each worker still creates a burst at the
 * shared upstream. A rejected/429 response must release the queue, while a
 * 429 also extends the next slot for the bounded retry sequence.
 */
function createMimitApiRateLimitedFetch(fetchImpl, requestIntervalMs) {
  const intervalMs = Number.isFinite(Number(requestIntervalMs)) && Number(requestIntervalMs) >= 0
    ? Number(requestIntervalMs)
    : MIMIT_API_MIN_INTERVAL_MS;
  let queue = Promise.resolve();
  let nextRequestAt = 0;
  let cooldownUntil = 0;

  const schedule = (operation) => {
    const run = queue.then(async () => {
      const waitMs = Math.max(0, Math.max(nextRequestAt, cooldownUntil) - Date.now());
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

      let response;
      try {
        response = await operation();
        if (response?.status === 429) {
          cooldownUntil = Math.max(cooldownUntil, Date.now() + retryAfterMs(response));
        }
        return response;
      } finally {
        nextRequestAt = Date.now() + intervalMs;
      }
    });
    // A failed request must not strand every later request behind a rejected
    // promise. The failed attempt is still surfaced to its own retry loop.
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  return (url, init) => schedule(() => fetchImpl(url, init));
}

async function fetchMimitApiArea({ region, province, town, fetchImpl, retries }) {
  const json = await fetchJsonWithRetry(MIMIT_API_URL, retries, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Osservaprezzi accepts a province-wide lookup, but some responses now
    // return an empty result for `town: null`. Keep that response as a valid
    // empty page so the caller can retry the same official source per target
    // municipality instead of carrying a stale snapshot.
    body: JSON.stringify({ region, province, town, priceOrder: 'asc', fuelType: '1-x' }),
  }, fetchImpl, (payload) => {
    const results = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload?.array) ? payload.array : null;
    if (!results || (payload?.success !== true && results.length > 0)) {
      throw new Error(`Unexpected response shape from ${MIMIT_API_URL} for province ${province}`);
    }
    return payload;
  });
  const results = Array.isArray(json?.results) ? json.results : Array.isArray(json?.array) ? json.array : [];
  return { province, results };
}

export async function fetchMimitApiSource(
  municipalities,
  { fetchImpl = fetch, retries = 3, requestIntervalMs = MIMIT_API_MIN_INTERVAL_MS } = {},
) {
  const provinces = [...new Set(municipalities.map((municipality) => String(municipality.province || '').trim().toUpperCase()))]
    .filter(Boolean)
    .sort();
  if (!provinces.length) throw new Error('MIMIT API fallback has no target provinces');
  const municipalitiesByProvince = new Map(provinces.map((province) => [
    province,
    municipalities.filter((municipality) => String(municipality.province || '').trim().toUpperCase() === province),
  ]));
  const rateLimitedFetch = createMimitApiRateLimitedFetch(fetchImpl, requestIntervalMs);
  const responsesByProvince = await mapWithConcurrency(provinces, MIMIT_API_CONCURRENCY, async (province) => {
    const region = MIMIT_API_REGION_BY_PROVINCE[province];
    if (region == null) throw new Error(`MIMIT API fallback has no region mapping for province ${province}`);
    const targetMunicipalities = municipalitiesByProvince.get(province) || [];
    const provinceResponse = await fetchMimitApiArea({
      region,
      province,
      town: null,
      fetchImpl: rateLimitedFetch,
      retries,
    });
    try {
      buildItalyRowsFromMimitApi({ municipalities: targetMunicipalities, responses: [provinceResponse] });
      return [provinceResponse];
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'MIMIT API returned no valid Benzina rows for target municipalities') throw error;
      console.warn(`::warning::[fuel] MIMIT area lookup returned no target Benzina rows for ${province}; retrying ${targetMunicipalities.length} target municipalities`);
      return mapWithConcurrency(targetMunicipalities, MIMIT_API_TOWN_CONCURRENCY, async (municipality) => fetchMimitApiArea({
        region,
        province,
        town: municipality.name,
        fetchImpl: rateLimitedFetch,
        retries,
      }));
    }
  });
  const responses = responsesByProvince.flat();
  const result = { ok: true, source: 'mimit-api', ...buildItalyRowsFromMimitApi({ municipalities, responses }) };
  assertMimitObservationFresh(result.latestObservedAt, new Date());
  return result;
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

export async function fetchSwissStationsByFuel(
  fuel,
  { fetchImpl = fetch, retries = 3, bbox = SWISS_TCS_BBOX } = {},
) {
  const body = {
    zoom: SWISS_TCS_ZOOM,
    pixelRatio: 1,
    bbox,
    filters: { fuel, brands: [] },
  };
  const json = await fetchJsonWithRetry(SWISS_TCS_BBOX_URL, retries, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      referer: SWISS_TCS_REFERER,
    },
    body: JSON.stringify(body),
  }, fetchImpl);
  if (!Array.isArray(json)) throw new Error(`Unexpected response shape from ${SWISS_TCS_BBOX_URL}`);
  return json;
}

export async function fetchSwissStations({ fetchImpl = fetch, retries = 3, now = new Date(), bbox = SWISS_TCS_BBOX } = {}) {
  // Two calls: SP95 (mandatory) + DIESEL (best-effort). Join by station id,
  // then retain the union: a station returned only by DIESEL is still a valid
  // national inventory row with an explicit missing-SP95 status. The border
  // comparator applies its own SP95 filter in buildSwissBorderStations.
  const [sp95Raw, dieselRaw] = await Promise.all([
    fetchSwissStationsByFuel('SP95', { fetchImpl, retries, bbox }),
    fetchSwissStationsByFuel('DIESEL', { fetchImpl, retries, bbox }).catch((err) => {
      console.warn(`⚠️ DIESEL fetch failed (continuing without diesel): ${err.message}`);
      return [];
    }),
  ]);
  const collectUsableById = (rows) => {
    const byId = new Map();
    for (const station of rows) {
      if (station.cluster || !station.id) continue;
      if (STALE_FIABILITY.has(station.fiability)) continue;
      if (!Number.isFinite(Number(station.price)) || Number(station.price) <= 0) continue;
      const id = String(station.id);
      // A provider duplicate is not a second physical station. Keep the
      // first row here; address-based dedup remains the final guard.
      if (!byId.has(id)) byId.set(id, station);
    }
    return byId;
  };
  const sp95ById = collectUsableById(sp95Raw);
  const dieselById = collectUsableById(dieselRaw);
  const stationIds = new Set([...sp95ById.keys(), ...dieselById.keys()]);

  const generatedAtIso = new Date(now).toISOString();
  const out = [];
  for (const id of stationIds) {
    const sp95 = sp95ById.get(id) || null;
    const diesel = dieselById.get(id) || null;
    const station = sp95 || diesel;
    const lat = Number(station.latitude);
    const lng = Number(station.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const normalized = normaliseFuelStationObservation({
      id,
      name: sp95?.displayName || sp95?.brand || diesel?.displayName || diesel?.brand || 'Station',
      brand: (sp95?.brand && sp95.brand !== 'UNDEFINED' ? sp95.brand : diesel?.brand && diesel.brand !== 'UNDEFINED' ? diesel.brand : '') || '',
      address: sp95?.formattedAddress || diesel?.formattedAddress || '',
      lat,
      lng,
      sp95PriceChf: sp95 ? Number(sp95.price) : null,
      dieselPriceChf: diesel ? Number(diesel.price) : null,
      dieselSource: diesel ? 'api' : 'unknown',
      // The CF response carries no authoritative per-price timestamp. Keep
      // retrieval time explicit; it is a snapshot timestamp, not a claim
      // that the pump changed at that instant. Fiability stays per fuel.
      // The Cloud Function response does not expose the pump-change time.
      // Keep price-update fields null and store the retrieval moment only in
      // `observedAt`; consumers must label it as an acquisition timestamp.
      dieselUpdatedAt: null,
      updatedAt: null,
      observedAt: generatedAtIso,
      source: SWISS_TCS_SOURCE,
      // `sourceQuality` is the legacy SP95-first alias. The explicit fields
      // retain the provider fiability for each fuel independently.
      sourceQuality: sp95?.fiability || diesel?.fiability || null,
      sp95SourceQuality: sp95?.fiability || null,
      dieselSourceQuality: diesel?.fiability || null,
    });
    if (normalized) out.push(normalized);
  }
  if (!sp95ById.size || !out.some((station) => station.priceStatus?.sp95 === 'available')) {
    throw new Error('TCS SP95 returned no usable national station rows');
  }
  if (!out.length) throw new Error('TCS returned no usable national station rows');
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
    // The national union may contain DIESEL-only rows. They remain in
    // `national.stations`, but the historical benzina comparator is explicitly
    // SP95-backed and must not turn a missing value into zero.
    if (!hasUsableFuelPrice(station.sp95PriceChf)) continue;
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

function percentage(part, total) {
  return total ? Math.round((part / total) * 1000) / 10 : 0;
}

function hasUsableFuelPrice(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return false;
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function collectionTimestamp(station) {
  // OpenStreetMap rows carry the inventory snapshot time, not a TCS price
  // acquisition. The national page reports the TCS collection separately and
  // exposes the inventory timestamp in its source metadata.
  if (station?.source === OSM_FUEL_SOURCE) return null;
  return station?.observedAt || station?.updatedAt || null;
}

function emptySwissAreaCoverage() {
  return { stations: 0, benzina: 0, diesel: 0, dieselCoveragePct: 0 };
}

/**
 * Produce diagnostics for the unfiltered national source snapshot.
 *
 * `byCanton` is deliberately diagnostic data, not a renderer input: an
 * unresolved address is counted and reported instead of being silently
 * assigned to a default canton. `byArea.CH` records the whole queried area,
 * while the canton buckets show where the source actually resolved stations.
 */
export function buildSwissCoverageDiagnostics(stations, {
  resolveStationCanton = null,
  expectedCantons = [],
  queriedBbox = SWISS_TCS_BBOX,
  inputStationCount = Array.isArray(stations) ? stations.length : 0,
  duplicateCount = 0,
  observedAt = null,
  source = SWISS_TCS_SOURCE,
  inventory = null,
} = {}) {
  const rows = Array.isArray(stations) ? stations.filter(Boolean) : [];
  const expected = [...new Set((expectedCantons || []).map((canton) => String(canton)).filter(Boolean))].sort();
  const byCanton = Object.fromEntries(expected.map((canton) => [canton, emptySwissAreaCoverage()]));
  let resolvedStationCount = 0;
  let unresolvedStationCount = 0;
  let resolutionError = false;

  for (const station of rows) {
    let canton = null;
    if (typeof resolveStationCanton === 'function') {
      try {
        canton = resolveStationCanton(station);
      } catch {
        resolutionError = true;
      }
    }
    if (!canton || !Object.hasOwn(byCanton, canton)) {
      unresolvedStationCount += 1;
      continue;
    }
    resolvedStationCount += 1;
    const area = byCanton[canton];
    area.stations += 1;
    if (hasUsableFuelPrice(station.sp95PriceChf)) area.benzina += 1;
    if (hasUsableFuelPrice(station.dieselPriceChf)) area.diesel += 1;
    area.dieselCoveragePct = percentage(area.diesel, area.stations);
  }

  const benzinaCount = rows.filter((station) => hasUsableFuelPrice(station.sp95PriceChf)).length;
  const dieselCount = rows.filter((station) => hasUsableFuelPrice(station.dieselPriceChf)).length;
  const area = {
    stations: rows.length,
    benzina: benzinaCount,
    diesel: dieselCount,
    dieselCoveragePct: percentage(dieselCount, rows.length),
  };
  const bbox = Array.isArray(queriedBbox) && queriedBbox.length === 4
    ? { west: Number(queriedBbox[0]), south: Number(queriedBbox[1]), east: Number(queriedBbox[2]), north: Number(queriedBbox[3]) }
    : null;
  const coveredCantonCount = Object.values(byCanton).filter((item) => item.stations > 0).length;

  return {
    schemaVersion: FUEL_STATION_SCHEMA_VERSION,
    scope: 'national',
    country: 'CH',
    coverageType: 'provider-snapshot',
    inventoryCompleteness: 'not-verified',
    anchorFuel: 'SP95',
    source,
    observedAt,
    bbox,
    inputStationCount,
    uniqueStationCount: rows.length,
    duplicateCount,
    resolvedStationCount,
    unresolvedStationCount,
    resolution: {
      status: typeof resolveStationCanton === 'function'
        ? (resolutionError || unresolvedStationCount > 0 || coveredCantonCount < expected.length ? 'partial' : 'ok')
        : 'not-configured',
      expectedCantonCount: expected.length,
      coveredCantonCount,
    },
    fuelCoverage: {
      benzina: {
        stationCount: benzinaCount,
        missingPriceCount: rows.length - benzinaCount,
        coveragePct: percentage(benzinaCount, rows.length),
      },
      diesel: {
        stationCount: dieselCount,
        missingPriceCount: rows.length - dieselCount,
        coveragePct: percentage(dieselCount, rows.length),
      },
    },
    ...(inventory && typeof inventory === 'object' ? {
      inventory: {
        source: inventory.source || OSM_FUEL_SOURCE,
        stationCount: Number(inventory.stationCount ?? 0),
        matchedStationCount: Number(inventory.matchCount ?? 0),
        inventoryOnlyStationCount: Number(inventory.inventoryOnlyCount ?? 0),
        observedAt: inventory.observedAt || null,
        completeness: inventory.completeness || 'not-verified',
      },
    } : {}),
    byArea: { CH: area },
    byCanton,
  };
}

function readSwissCoverageConfig() {
  try {
    const readJson = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', name), 'utf8'));
    const cantonSlugFile = readJson('canton-url-slugs.json');
    return {
      resolveStationCanton: createStationCantonResolver({
        postalIndex: readJson('swiss-postal-code-index.json'),
        localityIndex: readJson('swiss-locality-postal-codes.json'),
        cantonSlugFile,
      }),
      expectedCantons: Object.keys(cantonSlugFile.cantons || {}).sort(),
    };
  } catch (error) {
    // The national station feed remains useful even if optional local
    // reference data is unavailable. Diagnostics make that loss explicit.
    console.warn(`⚠️ Swiss canton coverage resolver unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return { resolveStationCanton: null, expectedCantons: [] };
  }
}

/**
 * Read the optional OSM physical-station registry produced by the weekly
 * inventory workflow. Price refreshes must remain independent from this
 * slower source: an unavailable or not-yet-generated inventory never blocks a
 * valid TCS price snapshot.
 */
export function readSwissFuelInventory(filePath = SWISS_INVENTORY_PATH) {
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const stations = Array.isArray(payload?.stations) ? payload.stations.filter((station) => station && typeof station === 'object') : [];
    return {
      stations,
      observedAt: typeof payload?.observedAt === 'string' ? payload.observedAt : typeof payload?.generatedAt === 'string' ? payload.generatedAt : null,
      source: payload?.source && typeof payload.source === 'object' ? payload.source : null,
      coverageType: typeof payload?.coverageType === 'string' ? payload.coverageType : 'open-inventory',
      inventoryCompleteness: typeof payload?.inventoryCompleteness === 'string' ? payload.inventoryCompleteness : 'not-verified',
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`⚠️ Swiss OSM fuel inventory unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { stations: [], observedAt: null, source: null, coverageType: 'open-inventory', inventoryCompleteness: 'not-verified' };
  }
}

export function buildDataset({
  municipalities,
  italyExtractedAt,
  swissStations,
  nationalSwissStations = swissStations,
  swissCoverage = null,
  swissInventory = null,
  italyByMunicipality,
  exchangeRate,
  italyStatus = null,
}) {
  const nationalStations = sortStationsStable(nationalSwissStations || []);
  const nationalObservedAtValues = nationalStations.map(collectionTimestamp).filter(Boolean).sort();
  const nationalCoverage = {
    ...(swissCoverage || buildSwissCoverageDiagnostics(nationalStations, {
      observedAt: nationalObservedAtValues[nationalObservedAtValues.length - 1] || null,
    })),
  };
  if (swissInventory && !swissCoverage) {
    nationalCoverage.inventory = {
      source: OSM_FUEL_SOURCE,
      stationCount: Number(swissInventory.stationCount ?? swissInventory.stations?.length ?? 0),
      matchedStationCount: Number(swissInventory.matchCount ?? 0),
      inventoryOnlyStationCount: Number(swissInventory.inventoryOnlyCount ?? 0),
      observedAt: swissInventory.observedAt ?? null,
      completeness: swissInventory.inventoryCompleteness ?? 'not-verified',
    };
  }
  const inventoryStationCount = Number(swissInventory?.stationCount ?? swissInventory?.stations?.length ?? 0);
  const hasOpenInventory = inventoryStationCount > 0;
  const nationalCoverageType = hasOpenInventory ? 'registry-plus-price-snapshot' : 'provider-snapshot';
  // Keep the detailed diagnostics in lockstep with the renderer-facing
  // national contract. Without this, the top-level dataset could advertise
  // the OSM+TCS registry while its nested coverage object still said only
  // provider-snapshot.
  nationalCoverage.coverageType = nationalCoverageType;
  const nationalProvider = hasOpenInventory
    ? `${'TCS Benzinpreis'} + ${OSM_FUEL_PROVIDER}`
    : 'TCS Benzinpreis';
  const inventorySource = swissInventory?.source && typeof swissInventory.source === 'object'
    ? swissInventory.source
    : null;
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

  const swissUpdatedAtValues = swissStations.map(collectionTimestamp).filter(Boolean).sort();
  const swissWithDiesel = swissStations.filter((s) => hasUsableFuelPrice(s.dieselPriceChf)).length;
  const swissDieselCoveragePct = swissStations.length
    ? Math.round((swissWithDiesel / swissStations.length) * 1000) / 10
    : 0;
  const nationalWithDiesel = nationalStations.filter((s) => hasUsableFuelPrice(s.dieselPriceChf)).length;
  const nationalDieselCoveragePct = nationalStations.length
    ? Math.round((nationalWithDiesel / nationalStations.length) * 1000) / 10
    : 0;
  const nationalLatestObservedAt = nationalObservedAtValues[nationalObservedAtValues.length - 1]
    || (typeof nationalCoverage.observedAt === 'string' ? nationalCoverage.observedAt : null);

  return {
    schemaVersion: FUEL_DATASET_SCHEMA_VERSION,
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
        // Keep `stationCount` as the historical border-comparator count for
        // existing consumers; the national count is additive and explicit.
        stationCount: swissStations.length,
        latestObservedUpdate: swissUpdatedAtValues[swissUpdatedAtValues.length - 1] || null,
        // F6 — real-diesel ingestion. See `fetchSwissStations` above for the
        // dual SP95 + DIESEL pull from the TCS Cloud Function.
        dieselStationCount: swissWithDiesel,
        dieselCoveragePct: swissDieselCoveragePct,
        borderStationCount: swissStations.length,
        nationalStationCount: nationalStations.length,
        nationalDieselStationCount: nationalWithDiesel,
        nationalDieselCoveragePct,
        nationalCoverageType,
        nationalInventoryStationCount: inventoryStationCount,
        nationalInventoryMatchedStationCount: Number(swissInventory?.matchCount ?? 0),
        nationalInventoryOnlyStationCount: Number(swissInventory?.inventoryOnlyCount ?? 0),
        nationalCoverage: nationalCoverage,
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
      swissBorderStationCount: swissStations.length,
      swissNationalStationCount: nationalStations.length,
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
    national: {
      schemaVersion: FUEL_STATION_SCHEMA_VERSION,
      country: 'CH',
      scope: 'national',
      coverageType: nationalCoverageType,
      inventoryCompleteness: swissInventory?.inventoryCompleteness ?? 'not-verified',
      anchorFuel: 'SP95',
      stationCount: nationalStations.length,
      observedAt: nationalLatestObservedAt,
      source: {
        provider: nationalProvider,
        sourceId: SWISS_TCS_SOURCE,
        endpoint: SWISS_TCS_BBOX_URL,
        providerUrl: 'https://benzin.tcs.ch/de/map/SP95',
        timestampKind: 'retrieved-snapshot',
        observedAt: nationalLatestObservedAt,
        ...(hasOpenInventory ? {
          inventoryProvider: OSM_FUEL_PROVIDER,
          inventorySourceId: OSM_FUEL_SOURCE,
          inventoryDataUrl: inventorySource?.dataUrl || OSM_FUEL_DATA_URL,
          inventoryAttributionUrl: inventorySource?.attributionUrl || OSM_FUEL_MAP_URL,
          inventoryLicense: inventorySource?.license || OSM_FUEL_LICENSE,
          inventoryAttribution: inventorySource?.attribution || '© OpenStreetMap contributors',
          inventoryObservedAt: swissInventory?.observedAt ?? null,
          inventoryStationCount,
          inventoryMatchedStationCount: Number(swissInventory?.matchCount ?? 0),
          inventoryOnlyStationCount: Number(swissInventory?.inventoryOnlyCount ?? 0),
        } : {}),
      },
      coverage: nationalCoverage,
      stations: nationalStations,
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
      extractedAt: italyResult.extractedAt ?? prices.extractedAt,
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
    schemaVersion: payload.schemaVersion ?? FUEL_DATASET_SCHEMA_VERSION,
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

  const borderMunicipalities = payload.municipalities
    .filter((m) => m.swiss.optionCount > 0)
    .map((m) => ({ municipality: m.municipality, province: m.province, swiss: m.swiss }));
  const borderChunks = chunkSwissBorderMunicipalities(borderMunicipalities);
  const switzerlandDoc = borderChunks.length > 1
    ? {
      chunkCount: borderChunks.length,
      chunkSize: SWISS_BORDER_FIRESTORE_CHUNK_SIZE,
      municipalityCount: borderMunicipalities.length,
    }
    : { municipalities: borderMunicipalities };

  // Keep the full station feed in a separate document. The legacy
  // `switzerland` document remains the border-comparator projection; putting
  // the national rows there would make the existing Firestore contract both
  // ambiguous and unnecessarily large.
  // Firestore documents are capped at 1 MiB. A national TCS snapshot is
  // already larger than that before the OSM inventory is unioned in, so the
  // metadata document carries only the manifest and the station rows live in
  // deterministic chunks. The client reads exactly the advertised chunks;
  // the batch makes the manifest + chunks visible atomically.
  const nationalStations = payload.national?.stations ?? [];
  const nationalChunks = chunkSwissNationalStations(nationalStations);
  const nationalChunkCount = nationalChunks.length;
  const switzerlandNationalDoc = payload.national ? {
    schemaVersion: payload.national.schemaVersion,
    country: payload.national.country,
    scope: payload.national.scope,
    coverageType: payload.national.coverageType,
    inventoryCompleteness: payload.national.inventoryCompleteness,
    anchorFuel: payload.national.anchorFuel,
    stationCount: payload.national.stationCount,
    observedAt: payload.national.observedAt,
    source: payload.national.source,
    coverage: payload.national.coverage,
    chunkCount: nationalChunkCount,
    chunkSize: SWISS_NATIONAL_FIRESTORE_CHUNK_SIZE,
  } : null;

  const batch = db.batch();
  const col = db.collection('fuelPrices');
  batch.set(col.doc('metadata'), metadataDoc);
  batch.set(col.doc('italy'), italyDoc);
  batch.set(col.doc('switzerland'), switzerlandDoc);
  if (borderChunks.length > 1) {
    for (let index = 0; index < borderChunks.length; index += 1) {
      const municipalities = borderChunks[index];
      const chunkId = `switzerland-${String(index).padStart(3, '0')}`;
      batch.set(col.doc(chunkId), {
        chunkIndex: index,
        chunkCount: borderChunks.length,
        municipalities,
      });
    }
  }
  if (switzerlandNationalDoc) {
    batch.set(col.doc('switzerland-national'), switzerlandNationalDoc);
    for (let index = 0; index < nationalChunkCount; index += 1) {
      const stations = nationalChunks[index];
      const chunkId = `switzerland-national-${String(index).padStart(3, '0')}`;
      batch.set(col.doc(chunkId), {
        schemaVersion: payload.national.schemaVersion,
        country: payload.national.country,
        scope: payload.national.scope,
        chunkIndex: index,
        chunkCount: nationalChunkCount,
        stations,
      });
    }
  }
  await batch.commit();

  const baseDocCount = switzerlandNationalDoc ? 4 : 3;
  const borderDocCount = borderChunks.length > 1 ? borderChunks.length : 0;
  console.log('🔥 Firestore: wrote ' + (baseDocCount + borderDocCount + (switzerlandNationalDoc ? nationalChunkCount : 0)) + ' docs (metadata: ' + JSON.stringify(metadataDoc).length + ' B, italy: ' + JSON.stringify(italyDoc).length + ' B, switzerland: ' + JSON.stringify(switzerlandDoc).length + ' B' + (borderChunks.length > 1 ? `, ${borderChunks.length} border-comparator chunks` : '') + (switzerlandNationalDoc ? `, switzerland-national manifest: ${JSON.stringify(switzerlandNationalDoc).length} B, ${nationalChunkCount} station chunks` : '') + ')');
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
        const validation = validateMimitCsvPayload({ pricesText, stationsText, municipalities });
        return { ok: true, pricesText, stationsText, extractedAt: validation.latestObservedAt };
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

    // OSM is a physical-station registry, not a price source. Attach its
    // identity to nearby TCS rows where the address/brand match is strong and
    // keep unmatched OSM rows as explicit price-unavailable inventory rows.
    // The optional file is refreshed weekly, independently from the hourly
    // TCS price pull.
    const inventorySnapshot = readSwissFuelInventory();
    const inventoryMerge = mergeSwissStationInventories(swissDocs, inventorySnapshot.stations);
    const mergedSwissDocs = inventoryMerge.stations;
    if (inventorySnapshot.stations.length > 0) {
      console.log(`⛽ Swiss inventory union: ${inventorySnapshot.stations.length} OSM rows, ${inventoryMerge.matchCount} matched to TCS, ${inventoryMerge.inventoryOnlyCount} inventory-only rows.`);
    }

    // AE-9 — collapse duplicate TCS/OSM records (same name + address, drifted
    // coords) before geo-filtering so every downstream consumer sees one
    // canonical entry per physical station.
    const { unique: dedupedSwissDocs, removed: swissRemoved } = dedupStations(mergedSwissDocs);
    if (swissRemoved.length > 0) {
      console.log(`⛽ Swiss station dedup: collapsed ${swissRemoved.length} duplicate record(s) (${swissDocs.length} → ${dedupedSwissDocs.length}).`);
    }

    const coverageConfig = readSwissCoverageConfig();
    // Preserve the full TCS provider snapshot for national consumers, then
    // derive the historical 25 km border projection from the same canonical
    // rows. Canton is a derived URL-group field from the local Swiss postal /
    // locality resolver; unresolved rows remain explicit nulls.
    const nationalSwissStations = sortStationsStable(dedupedSwissDocs).map((station) => {
      let canton = null;
      if (typeof station.canton === 'string' && /^[A-Z]{2}$/.test(station.canton)) {
        canton = station.canton;
      } else if (typeof coverageConfig.resolveStationCanton === 'function') {
        try {
          canton = coverageConfig.resolveStationCanton(station) || null;
        } catch {
          canton = null;
        }
      }
      return { ...station, canton };
    });
    const nationalObservedAt = nationalSwissStations.map(collectionTimestamp).filter(Boolean).sort().at(-1) || null;
    const swissCoverage = buildSwissCoverageDiagnostics(nationalSwissStations, {
      resolveStationCanton: (station) => (
        typeof station?.canton === 'string' && /^[A-Z]{2}$/.test(station.canton)
          ? station.canton
          : coverageConfig.resolveStationCanton?.(station)
      ),
      expectedCantons: coverageConfig.expectedCantons,
      inputStationCount: mergedSwissDocs.length,
      duplicateCount: swissRemoved.length,
      observedAt: nationalObservedAt,
      inventory: {
        source: OSM_FUEL_SOURCE,
        stationCount: inventorySnapshot.stations.length,
        matchCount: inventoryMerge.matchCount,
        inventoryOnlyCount: inventoryMerge.inventoryOnlyCount,
        observedAt: inventorySnapshot.observedAt,
        completeness: inventorySnapshot.inventoryCompleteness,
      },
    });
    const swissStations = buildSwissBorderStations(municipalities, nationalSwissStations, exchangeRate.eurPerChf);

    const payload = buildDataset({
      municipalities,
      italyExtractedAt: prices.extractedAt,
      swissStations,
      nationalSwissStations,
      swissCoverage,
      swissInventory: {
        ...inventorySnapshot,
        stationCount: inventorySnapshot.stations.length,
        matchCount: inventoryMerge.matchCount,
        inventoryOnlyCount: inventoryMerge.inventoryOnlyCount,
      },
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

    console.log('⛽ Fuel dataset generated: ' + payload.summary.municipalityCount + ' municipalities, ' + payload.summary.municipalitiesWithItalyPrices + ' with Italian prices, ' + payload.summary.municipalitiesWithSwissComparison + ' with IT/CH comparison, ' + payload.national.stationCount + ' national Swiss stations (' + payload.national.coverage.resolution.coveredCantonCount + '/' + payload.national.coverage.resolution.expectedCantonCount + ' canton groups covered).');
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
