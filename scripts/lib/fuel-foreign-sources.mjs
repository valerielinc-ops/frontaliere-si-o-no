// Network fetchers for the Swiss baseline and foreign overlays of
// `data/fuel-prices-cantons.json`.
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
// - CH: the BFS/UST LIK monthly workbook is OPEN-BY with mandatory attribution;
//   the stable DAM asset URL is used directly, not a web page scrape.
// - AT: the public E-Control Spritpreisrechner API; no robots.txt on
//   api.e-control.at (the API is publicly documented, but no separate open-data
//   licence was found; keep the provider attribution in the output).
// - DE: Tankerkönig/MTS-K data is CC BY 4.0. The optional adapter uses one
//   list.php request per configured border point, serialised at the provider's
//   one-request-per-minute limit, and skips the whole overlay on ok:false.
// One plain request per source per daily run, honest User-Agent, no header
// spoofing. Tankerkönig requests deliberately have no retry: a retry would be
// another API request and could violate the provider's frequency limit.

import { inflateRawSync } from 'node:zlib';

import {
  AT_REGIONS_BY_CANTON,
  DE_POINTS_BY_CANTON,
  DE_SEARCH_RADIUS_KM,
  FR_DEPARTMENTS_BY_CANTON,
  FUELS,
  MIN_STATIONS_PER_RECORD,
  MAX_NATIONAL_PRICE_AGE_DAYS,
  extractSingleZipEntry,
  isPlausiblePrice,
  parseBfsFuelXlsx,
  parseEControStations,
  parseFrenchInstantXml,
  parseTankerkoenigStations,
} from './fuel-cantons-dataset.mjs';

export const FR_INSTANT_FEED_URL = 'https://donnees.roulez-eco.fr/opendata/instantane';
export const BFS_FUEL_PRICES_URL = 'https://dam-api.bfs.admin.ch/hub/api/dam/assets/orderNr:su-d-05.02.91/master';
export const AT_ECONTROL_BY_REGION_URL = 'https://api.e-control.at/sprit/1.0/search/gas-stations/by-region';
export const DE_TANKERKOENIG_LIST_URL = 'https://creativecommons.tankerkoenig.de/json/list.php';
export const DE_REQUEST_INTERVAL_MS = 60_000;
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

export async function fetchSwissNationalFuelPrices({ fetchImpl, retries, now = new Date() } = {}) {
  try {
    const workbook = await fetchWithRetry(BFS_FUEL_PRICES_URL, { as: 'buffer', fetchImpl, retries });
    const prices = parseBfsFuelXlsx(workbook, inflateRawSync);
    if (!prices.sp95 || !prices.diesel) {
      return { status: 'failed', reason: 'BFS LIK workbook is missing SP95 or diesel', data: {} };
    }
    const observedMonths = Object.entries(prices)
      .map(([fuel, observation]) => ({ fuel, observedAt: observation.observedAt }))
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    const staleFuel = observedMonths.find(({ observedAt }) => {
      const observedMs = Date.parse(observedAt || '');
      return !Number.isFinite(observedMs)
        || now.getTime() - observedMs > MAX_NATIONAL_PRICE_AGE_DAYS * 86_400_000
        || observedMs > now.getTime() + 3_600_000;
    });
    if (staleFuel) {
      return {
        status: 'failed',
        reason: `BFS LIK ${staleFuel.fuel} month is older than ${MAX_NATIONAL_PRICE_AGE_DAYS} days or is invalid`,
        data: {},
      };
    }
    return {
      status: 'ok',
      observedMonth: observedMonths[observedMonths.length - 1]?.observedAt?.slice(0, 7) || null,
      data: prices,
    };
  } catch (err) {
    return { status: 'failed', reason: String(err?.message || err), data: {} };
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

export async function fetchGermanStations({
  apiKey = process.env.TANKERKOENIG_API_KEY,
  fetchImpl,
  requestIntervalMs = DE_REQUEST_INTERVAL_MS,
  sleepImpl = wait,
} = {}) {
  if (!apiKey) {
    return {
      status: 'skipped',
      reason: 'TANKERKOENIG_API_KEY is not configured (Remote Config); DE overlay skipped',
      data: {},
    };
  }
  const byCanton = {};
  const failures = [];
  const coverage = {};
  let rejectedReason = null;
  let requestNumber = 0;
  // Requests are intentionally sequential, including multiple points in one
  // canton. Tankerkönig documents one request per minute for the free API;
  // parallel calls would make an otherwise valid daily run exceed that limit
  // and could deactivate the key.
  for (const [canton, points] of Object.entries(DE_POINTS_BY_CANTON)) {
    const seen = new Map();
    let parsedPoint = false;
    for (const point of points) {
      if (requestNumber > 0 && requestIntervalMs > 0) await sleepImpl(requestIntervalMs);
      requestNumber++;
      const radiusKm = Number.isFinite(point.radiusKm) ? point.radiusKm : DE_SEARCH_RADIUS_KM;
      const qs = new URLSearchParams({
        lat: String(point.lat), lng: String(point.lng), rad: String(radiusKm),
        sort: 'dist', type: 'all', apikey: apiKey,
      });
      try {
        // Never retry a Tankerkönig request: even a transient HTTP/network
        // error is reported as a source failure and leaves the other overlays
        // publishable. A rejected ok:false response also stops immediately, as
        // the provider recommends sending no further requests for that key.
        const response = await fetchWithRetry(`${DE_TANKERKOENIG_LIST_URL}?${qs}`, { fetchImpl, retries: 1 });
        if (response?.ok === false) {
          rejectedReason = `rejected: ${redactKey(response.message || 'API returned ok:false', apiKey)}`;
          break;
        }
        for (const s of parseTankerkoenigStations(response)) {
          if (!seen.has(s.id)) seen.set(s.id, s);
        }
        parsedPoint = true;
      } catch (err) {
        failures.push(`${canton}/${point.label}: ${redactKey(err?.message || err, apiKey)}`);
      }
    }
    if (rejectedReason) break;
    byCanton[canton] = [...seen.values()];
    if (!parsedPoint) continue;
    const stations = byCanton[canton];
    const counts = Object.fromEntries(FUELS.map((fuel) => [
      fuel,
      stations.filter((station) => isPlausiblePrice(station[fuel])).length,
    ]));
    coverage[canton] = { stations: stations.length, ...counts };
    const insufficient = FUELS
      .filter((fuel) => counts[fuel] < MIN_STATIONS_PER_RECORD)
      .map((fuel) => `${fuel}=${counts[fuel]}`);
    if (insufficient.length) {
      failures.push(`${canton}: fewer than ${MIN_STATIONS_PER_RECORD} stations per fuel (${insufficient.join(', ')})`);
    }
  }
  // A rejected key invalidates the whole DE overlay, including groups fetched
  // before the rejection. Do not publish a partial snapshot while advertising
  // `skipped` health to downstream consumers.
  if (rejectedReason) return { status: 'skipped', reason: rejectedReason, data: {}, coverage: {} };
  const total = Object.values(byCanton).reduce((n, list) => n + list.length, 0);
  if (!total) return { status: 'failed', reason: failures.join('; ') || 'empty response', data: byCanton, coverage };
  return {
    status: failures.length ? 'failed' : 'ok',
    ...(failures.length ? { reason: failures.join('; ') } : {}),
    data: byCanton,
    coverage,
  };
}
