// Network fetchers for the foreign side of `data/fuel-prices-cantons.json`.
// Each fetcher is failure-isolated: it returns `{ status, reason?, data }`
// instead of throwing, so one foreign source being down degrades the dataset
// (and is published as such in `sources`) instead of losing all of it. The
// validity floor in `fuel-cantons-dataset.mjs` decides whether what is left
// is still worth publishing.
//
// Access policy (checked 2026-10-05, D10 of the canton-sections programme):
// - FR: the official instant feed `donnees.roulez-eco.fr/opendata/instantane`
//   is the distribution endpoint the Ministry documents for reuse (Licence
//   Ouverte). `data.economie.gouv.fr/robots.txt` disallows `/api/` for `*`,
//   so its Opendatasoft API copy of the same dataset is NOT used.
// - AT: the public E-Control Spritpreisrechner API; no robots.txt on
//   api.e-control.at.
// - DE: Tankerkönig (MTS-K data, CC BY 4.0) requires a personal API key; the
//   source is skipped when `TANKERKOENIG_API_KEY` is not set.
// One plain request per source per day (the daily run of
// update-fuel-prices.yml), honest User-Agent, no header spoofing.

import { inflateRawSync } from 'node:zlib';

import {
  AT_REGIONS_BY_CANTON,
  DE_POINTS_BY_CANTON,
  DE_SEARCH_RADIUS_KM,
  FR_DEPARTMENTS_BY_CANTON,
  extractSingleZipEntry,
  parseEControStations,
  parseFrenchInstantXml,
  parseTankerkoenigStations,
} from './fuel-cantons-dataset.mjs';

export const FR_INSTANT_FEED_URL = 'https://donnees.roulez-eco.fr/opendata/instantane';
export const AT_ECONTROL_BY_REGION_URL = 'https://api.e-control.at/sprit/1.0/search/gas-stations/by-region';
export const DE_TANKERKOENIG_LIST_URL = 'https://creativecommons.tankerkoenig.de/json/list.php';
const USER_AGENT = 'FrontaliereTicino/1.0 (+https://frontaliereticino.ch/)';
const TIMEOUT_MS = 45_000;

async function fetchWithRetry(url, { retries = 3, as = 'json', fetchImpl = fetch } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (as === 'buffer') return Buffer.from(await res.arrayBuffer());
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, attempt * 3_000));
    }
  }
  throw lastError;
}

function redactKey(message, key) {
  return key ? String(message).split(key).join('***') : String(message);
}

export async function fetchFrenchStations({ fetchImpl, retries } = {}) {
  const departments = [...new Set(Object.values(FR_DEPARTMENTS_BY_CANTON).flat())];
  try {
    const zip = await fetchWithRetry(FR_INSTANT_FEED_URL, { as: 'buffer', fetchImpl, retries });
    // The feed is declared ISO-8859-1; only ASCII attributes are read here.
    const xml = extractSingleZipEntry(zip, inflateRawSync).toString('latin1');
    const stations = parseFrenchInstantXml(xml, { departments });
    if (!stations.length) return { status: 'failed', reason: 'no station in the configured départements', data: [] };
    return { status: 'ok', stationCount: stations.length, data: stations };
  } catch (err) {
    return { status: 'failed', reason: String(err?.message || err), data: [] };
  }
}

export async function fetchAustrianStations({ fetchImpl, retries } = {}) {
  const regions = [...new Set(Object.values(AT_REGIONS_BY_CANTON).flat())];
  const fuelTypes = { sp95: 'SUP', diesel: 'DIE' };
  const byRegion = {};
  const failures = [];
  for (const code of regions) {
    byRegion[code] = {};
    for (const [fuel, fuelType] of Object.entries(fuelTypes)) {
      const url = `${AT_ECONTROL_BY_REGION_URL}?code=${code}&type=BL&fuelType=${fuelType}&includeClosed=false`;
      try {
        byRegion[code][fuel] = parseEControStations(await fetchWithRetry(url, { fetchImpl, retries }));
      } catch (err) {
        byRegion[code][fuel] = [];
        failures.push(`BL${code}/${fuelType}: ${err?.message || err}`);
      }
    }
  }
  const total = Object.values(byRegion).reduce((n, f) => n + f.sp95.length + f.diesel.length, 0);
  if (!total) return { status: 'failed', reason: failures.join('; ') || 'empty response', data: byRegion };
  return {
    status: failures.length ? 'partial' : 'ok',
    ...(failures.length ? { reason: failures.join('; ') } : {}),
    data: byRegion,
  };
}

export async function fetchGermanStations({ apiKey = process.env.TANKERKOENIG_API_KEY, fetchImpl, retries } = {}) {
  if (!apiKey) {
    return { status: 'skipped', reason: 'TANKERKOENIG_API_KEY not configured (Remote Config)', data: {} };
  }
  const byCanton = {};
  const failures = [];
  for (const [canton, points] of Object.entries(DE_POINTS_BY_CANTON)) {
    const seen = new Map();
    for (const point of points) {
      const qs = new URLSearchParams({
        lat: String(point.lat), lng: String(point.lng), rad: String(DE_SEARCH_RADIUS_KM),
        sort: 'dist', type: 'all', apikey: apiKey,
      });
      try {
        for (const s of parseTankerkoenigStations(await fetchWithRetry(`${DE_TANKERKOENIG_LIST_URL}?${qs}`, { fetchImpl, retries }))) {
          if (!seen.has(s.id)) seen.set(s.id, s);
        }
      } catch (err) {
        failures.push(`${canton}: ${redactKey(err?.message || err, apiKey)}`);
      }
    }
    byCanton[canton] = [...seen.values()];
  }
  const total = Object.values(byCanton).reduce((n, list) => n + list.length, 0);
  if (!total) return { status: 'failed', reason: failures.join('; ') || 'empty response', data: byCanton };
  return {
    status: failures.length ? 'partial' : 'ok',
    ...(failures.length ? { reason: failures.join('; ') } : {}),
    data: byCanton,
  };
}
