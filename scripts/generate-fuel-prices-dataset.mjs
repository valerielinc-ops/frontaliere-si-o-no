#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MUNICIPALITIES_PATH = path.join(ROOT, 'data', 'municipalities.ts');
const DATA_OUT = path.join(ROOT, 'data', 'fuel-prices.json');
const PUBLIC_OUT = path.join(ROOT, 'public', 'data', 'fuel-prices.json');

const ITALY_PRICES_URL = 'https://www.mimit.gov.it/images/exportCSV/prezzo_alle_8.csv';
const ITALY_STATIONS_URL = 'https://www.mimit.gov.it/images/exportCSV/anagrafica_impianti_attivi.csv';
const ECB_DAILY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const SWISS_FIRESTORE_KEY = 'AIzaSyCQ8f6sXb1gYIiv5rlHKeZ2EVMzC-anzIU';
const SWISS_FIRESTORE_URL = 'https://firestore.googleapis.com/v1/projects/gas-prices-prod/databases/(default)/documents/stations';
const SWISS_SEARCH_RADIUS_KM = 20;
const SWISS_BORDER_FILTER_KM = 25;
const TOP_SWISS_OPTIONS = 5;
const SWISS_MAX_PRICE_AGE_DAYS = 30;

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

function deg2rad(v) {
  return (v * Math.PI) / 180;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = deg2rad(lat2 - lat1);
  const dLng = deg2rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, item) => sum + item, 0) / values.length;
}

function round(value, digits = 3) {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function extractEcbRate(xml) {
  const match = String(xml).match(/currency=['"]CHF['"]\s+rate=['"]([\d.]+)['"]/i);
  if (!match) throw new Error('CHF rate not found in ECB XML');
  const chfPerEur = Number(match[1]);
  return {
    chfPerEur,
    eurPerChf: 1 / chfPerEur,
  };
}

function unwrapFirestoreValue(node) {
  if (!node || typeof node !== 'object') return null;
  if ('stringValue' in node) return node.stringValue;
  if ('integerValue' in node) return Number(node.integerValue);
  if ('doubleValue' in node) return Number(node.doubleValue);
  if ('booleanValue' in node) return Boolean(node.booleanValue);
  if ('timestampValue' in node) return node.timestampValue;
  if ('mapValue' in node) {
    const out = {};
    for (const [key, value] of Object.entries(node.mapValue.fields || {})) {
      out[key] = unwrapFirestoreValue(value);
    }
    return out;
  }
  if ('arrayValue' in node) {
    return (node.arrayValue.values || []).map(unwrapFirestoreValue);
  }
  return null;
}

async function fetchJsonWithRetry(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'FrontaliereTicino/1.0' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = attempt * 5_000;
      console.warn(`⚠️ Attempt ${attempt}/${retries} failed for ${url}: ${err.message} — retrying in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function fetchSwissStations() {
  const now = Date.now();
  const docs = [];
  let pageToken = '';
  while (true) {
    const url = new URL(SWISS_FIRESTORE_URL);
    url.searchParams.set('pageSize', '300');
    url.searchParams.set('key', SWISS_FIRESTORE_KEY);
    url.searchParams.set('mask.fieldPaths', 'displayName');
    url.searchParams.append('mask.fieldPaths', 'brand');
    url.searchParams.append('mask.fieldPaths', 'formattedAddress');
    url.searchParams.append('mask.fieldPaths', 'fuelCollection');
    url.searchParams.append('mask.fieldPaths', 'location');
    url.searchParams.append('mask.fieldPaths', 'isDeleted');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const json = await fetchJsonWithRetry(url.toString());
    for (const doc of json.documents || []) {
      docs.push(doc);
    }
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }
  return docs
    .map((doc) => {
      const fields = unwrapFirestoreValue({ mapValue: { fields: doc.fields || {} } }) || {};
      const sp95 = fields.fuelCollection?.SP95;
      const diesel = fields.fuelCollection?.DIESEL;
      const lat = fields.location?.lat;
      const lng = fields.location?.lng;
      if (!sp95 || sp95.isDeleted || fields.isDeleted || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      const updatedAt = sp95.fiability?.lastPriceUpdate || sp95.lastCachedPriceRefresh || null;
      if (updatedAt) {
        const ageMs = now - new Date(updatedAt).getTime();
        if (Number.isFinite(ageMs) && ageMs > SWISS_MAX_PRICE_AGE_DAYS * 24 * 60 * 60 * 1000) return null;
      }

      // Diesel is opt-in per station in the TCS feed. Include it when the
      // station publishes a non-deleted DIESEL record with a fresh price; this
      // is the authoritative per-station value — no SP95+offset approximation.
      let dieselPriceChf = null;
      let dieselSource = 'unknown';
      let dieselUpdatedAt = null;
      if (diesel && !diesel.isDeleted && Number.isFinite(Number(diesel.displayPrice))) {
        const dUpdate = diesel.fiability?.lastPriceUpdate || diesel.lastCachedPriceRefresh || null;
        const dAgeMs = dUpdate ? now - new Date(dUpdate).getTime() : 0;
        const withinWindow = !dUpdate || (Number.isFinite(dAgeMs) && dAgeMs <= SWISS_MAX_PRICE_AGE_DAYS * 24 * 60 * 60 * 1000);
        if (withinWindow) {
          dieselPriceChf = Number(diesel.displayPrice);
          dieselSource = 'api';
          dieselUpdatedAt = dUpdate;
        }
      }

      const name = String(doc.name || '').split('/').pop() || '';
      return {
        id: name,
        name: fields.displayName || fields.brand || 'Station',
        brand: fields.brand || '',
        address: fields.formattedAddress || '',
        lat,
        lng,
        sp95PriceChf: Number(sp95.displayPrice),
        dieselPriceChf,
        dieselSource,
        dieselUpdatedAt,
        updatedAt,
      };
    })
    .filter(Boolean);
}

function buildItalyStations(municipalities, stationsRows, pricesRows) {
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

  const pricesByMunicipality = new Map();
  for (const row of pricesRows) {
    if (String(row.descCarburante || '') !== 'Benzina') continue;
    const station = stationsById.get(String(row.idImpianto));
    const price = toNumber(row.prezzo);
    if (!station || price == null) continue;
    const entry = {
      id: station.id,
      stationName: station.name,
      brand: station.brand,
      address: station.address,
      lat: station.lat,
      lng: station.lng,
      priceEur: price,
      isSelf: String(row.isSelf || '') === '1',
      updatedAt: row.dtComu || null,
    };
    const key = `${station.municipalityName}:${station.province}`;
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
  return {
    stationCount: stations.length,
    minPriceEur: cheapest ? round(cheapest.priceEur) : null,
    avgPriceEur: round(average(allPrices)),
    maxPriceEur: round(allPrices.length ? Math.max(...allPrices) : null),
    minSelfPriceEur: selfPrices.length ? round(Math.min(...selfPrices)) : null,
    minServedPriceEur: servedPrices.length ? round(Math.min(...servedPrices)) : null,
    cheapestStation: cheapest,
    stations: sorted,
  };
}

function buildSwissBorderStations(municipalities, swissStations, eurPerChf) {
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

function buildDataset({
  municipalities,
  italyExtractedAt,
  swissStations,
  italyByMunicipality,
  exchangeRate,
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
        cheapestStation: cheapestSwiss,
        nearbyStations: swissCandidates.slice(0, TOP_SWISS_OPTIONS),
        minPriceChf: cheapestSwiss ? round(cheapestSwiss.sp95PriceChf) : null,
        minPriceEur: cheapestSwiss ? round(cheapestSwiss.sp95PriceEur) : null,
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
      },
      switzerland: {
        provider: 'TCS Benzinpreis',
        providerUrl: 'https://benzin.tcs.ch/de/map/SP95',
        stationCount: swissStations.length,
        latestObservedUpdate: swissUpdatedAtValues[swissUpdatedAtValues.length - 1] || null,
        // F6 — real-diesel ingestion. See scripts/generate-fuel-prices-dataset.mjs
        // `fetchSwissStations` for the DIESEL unwrap from the TCS Firestore feed.
        dieselStationCount: swissWithDiesel,
        dieselCoveragePct: swissDieselCoveragePct,
      },
      exchangeRate: {
        provider: 'ECB',
        sourceUrl: ECB_DAILY_URL,
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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// ─── Firestore write ────────────────────────────────────────

async function writeToFirestore(payload) {
  const admin = await import('firebase-admin');
  if (!admin.default.apps.length) {
    admin.default.initializeApp({ projectId: process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || 'frontaliere-ticino' });
  }
  const db = admin.default.firestore();

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

  try {
    const [pricesText, stationsText, ecbXml, swissDocs] = await Promise.all([
      fetchText(ITALY_PRICES_URL),
      fetchText(ITALY_STATIONS_URL),
      fetchText(ECB_DAILY_URL),
      fetchSwissStations(),
    ]);

    const prices = parseDelimited(pricesText);
    const stations = parseDelimited(stationsText);
    const exchangeRate = extractEcbRate(ecbXml);
    const italyByMunicipality = buildItalyStations(municipalities, stations.rows, prices.rows);
    const swissStations = buildSwissBorderStations(municipalities, swissDocs, exchangeRate.eurPerChf);

    const payload = buildDataset({
      municipalities,
      italyExtractedAt: prices.extractedAt,
      swissStations,
      italyByMunicipality,
      exchangeRate,
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
