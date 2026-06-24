#!/usr/bin/env node

import fs from 'node:fs';
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

async function fetchJsonWithRetry(url, retries = 3, init = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'user-agent': 'FrontaliereTicino/1.0', ...(init.headers || {}) },
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
        isSelf,
        updatedAt: row.dtComu || null,
        municipalityKey: `${station.municipalityName}:${station.province}`,
      };
      entryByKey.set(key, entry);
    }
    if (desc === 'Benzina') entry.priceEur = price;
    else entry.dieselPriceEur = price;
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

// Only run main() when invoked as a CLI, not when imported (e.g. by tests).
const invokedAsCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedAsCli) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
