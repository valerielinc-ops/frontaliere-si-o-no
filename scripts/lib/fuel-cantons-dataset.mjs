// Pure builders for `data/fuel-prices-cantons.json` (P9b, programma «sezioni
// articoli per cantone», decisione D11): one flat record per
// (canton group, side, fuel) with the average, median and minimum price, the
// number of stations behind them and the newest observation time.
//
// Everything here is network-free and fs-free so the producer CLI
// (`scripts/build-fuel-cantons-dataset.mjs`) and the tests share one
// implementation. The network fetchers live in `fuel-foreign-sources.mjs`.
//
// Sides and why each canton gets them:
//   CH  stations already collected by `generate-fuel-prices-dataset.mjs` (TCS,
//       border strip within 25 km of the Italian fascia). The national
//       extension is deliberately NOT done here: the TCS terms of use allow
//       private use only and reproduction only with explicit permission, so
//       collecting more of it is not a legitimate source (see the PR body).
//   IT  MIMIT open data stations of the Italian border provinces, already
//       fetched by the same generator.
//   FR  official instant feed of the French Ministry of Economy (Licence
//       Ouverte), by département close to the canton.
//   AT  E-Control Spritpreisrechner API, by Bundesland. The API publishes only
//       the cheapest stations of a region, so `coverage` says so.
//   DE  Tankerkönig (MTS-K, CC BY 4.0), OPTIONAL: skipped when the API key is
//       not configured.

export const FUEL_CANTONS_SCHEMA_VERSION = 1;
export const FUELS = Object.freeze(['sp95', 'diesel']);
export const SIDES = Object.freeze(['CH', 'FR', 'AT', 'IT', 'DE']);

/** IT side: Italian provinces (MIMIT `Provincia`) adjacent to each canton. */
export const IT_PROVINCES_BY_CANTON = Object.freeze({
  TI: ['CO', 'VA', 'VB'],
  GR: ['SO', 'BZ'],
  VS: ['VB', 'AO'],
});

/** FR side: départements (first two digits of the postcode) by proximity. */
export const FR_DEPARTMENTS_BY_CANTON = Object.freeze({
  GE: ['74', '01'],
  VD: ['01', '25'],
  NE: ['25'],
  JU: ['25', '90', '68'],
  BASILEA: ['68'],
  SO: ['68'],
  VS: ['74'],
});

/** AT side: E-Control Bundesland codes (8 Vorarlberg, 7 Tirol). */
export const AT_REGIONS_BY_CANTON = Object.freeze({
  SG: [8],
  APPENZELLO: [8],
  GR: [8, 7],
});

/** DE side (optional): Tankerkönig radius search around the main crossings. */
export const DE_POINTS_BY_CANTON = Object.freeze({
  BASILEA: [{ label: 'Weil am Rhein', lat: 47.594, lng: 7.621 }],
  AG: [{ label: 'Waldshut-Tiengen', lat: 47.623, lng: 8.214 }],
  ZH: [{ label: 'Jestetten', lat: 47.654, lng: 8.573 }],
  SH: [{ label: 'Gottmadingen', lat: 47.735, lng: 8.776 }],
  TG: [{ label: 'Konstanz', lat: 47.663, lng: 9.175 }],
});
export const DE_SEARCH_RADIUS_KM = 10;

/** CH side: cantons the TCS border strip is expected to cover. */
export const CH_EXPECTED_CANTONS = Object.freeze(['TI', 'GR', 'VS']);

/** Sides whose absence is tolerated (no credential configured). */
export const OPTIONAL_SIDES = Object.freeze(['DE']);

export const MIN_STATIONS_PER_RECORD = 3;
export const MAX_PRICE_AGE_DAYS = 14;
// A litre outside these bounds is a typo in the source (prices in cents, a
// missing decimal point): drop it instead of letting it skew the average.
export const PRICE_BOUNDS = Object.freeze({ min: 0.8, max: 4.0 });
// Inside the bounds a source can still carry a stale or mistyped row (MIMIT
// had a 1.206 EUR benzina next to a 1.999 median on 2026-10-05): a price
// further than this fraction from the median of its own set is dropped.
export const MAX_DEVIATION_FROM_MEDIAN = 0.2;
// Validity floor, same idea as the other producers: refuse to publish a
// dataset in which too many of the cantons we have a source for came out
// empty. 0.75 of the expected cantons keeps one foreign source failing
// (AT: 2 cantons) publishable and rejects the loss of the French feed
// (6 cantons) or of the Swiss/Italian generator input.
export const MIN_EXPECTED_CANTON_COVERAGE = 0.75;

export function round(value, digits = 3) {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function isPlausiblePrice(value) {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= PRICE_BOUNDS.min && value <= PRICE_BOUNDS.max;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Offset (ms) of `timeZone` from UTC at the instant `utcMs`.
 * Pure Intl, so it follows DST without a tz database dependency.
 */
function timeZoneOffsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Wall-clock time in `timeZone` -> ISO string (UTC), or null. */
export function zonedWallTimeToIso({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(guess)) return null;
  const first = guess - timeZoneOffsetMs(guess, timeZone);
  // Second pass settles the instant when the guess straddled a DST switch.
  const settled = guess - timeZoneOffsetMs(first, timeZone);
  return new Date(settled).toISOString();
}

/** "2026-09-28 11:45:27" (Europe/Paris) -> ISO. */
export function parseFrenchTimestamp(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return zonedWallTimeToIso({
    year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], second: +(m[6] || 0),
  }, 'Europe/Paris');
}

/** MIMIT "01/10/2026 07:54:22" (Europe/Rome) -> ISO. */
export function parseItalianTimestamp(value) {
  const m = String(value || '').match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return zonedWallTimeToIso({
    year: +m[3], month: +m[2], day: +m[1], hour: +(m[4] || 0), minute: +(m[5] || 0), second: +(m[6] || 0),
  }, 'Europe/Rome');
}

function isFresh(iso, nowMs) {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && nowMs - t <= MAX_PRICE_AGE_DAYS * 86_400_000 && t <= nowMs + 3_600_000;
}

// ─── Canton resolution (CH stations) ─────────────────────────────────────

/**
 * Bind the canton resolver to the reference data, all from the official
 * swisstopo/Swiss Post locality directory already in the repo:
 * - `postalIndex`: `data/swiss-postal-code-index.json` (NPA -> [canton,
 *   locality], only NPAs with one canton AND one locality);
 * - `localityIndex`: `data/swiss-locality-postal-codes.json` (canton ->
 *   locality -> NPA), which also covers the NPAs shared by several localities
 *   of the same canton (6900 Lugano/Massagno/Paradiso) that the first one
 *   leaves out;
 * - `cantonSlugFile`: `data/canton-url-slugs.json` for the URL groups.
 * Returns the URL group (AI/AR -> APPENZELLO, BL/BS -> BASILEA) or null when
 * nothing in the address is unambiguous — never a default canton.
 */
export function createStationCantonResolver({ postalIndex, localityIndex, cantonSlugFile }) {
  const memberToGroup = {};
  for (const [group, info] of Object.entries(cantonSlugFile?.cantonGroups || {})) {
    for (const member of info.members || []) memberToGroup[member] = group;
  }
  const known = new Set(Object.keys(cantonSlugFile?.cantons || {}));
  const toGroup = (code) => {
    const c = String(code || '').toUpperCase();
    const group = memberToGroup[c] ?? c;
    return known.has(group) ? group : null;
  };
  const normalizeName = (value) => String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

  const groupsByNpa = new Map();
  const groupsByName = new Map();
  const addTo = (map, key, group) => {
    if (!key || !group) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(group);
  };
  for (const [npa, entry] of Object.entries(postalIndex?.postalCodes || {})) {
    addTo(groupsByNpa, npa, toGroup(entry?.[0]));
    addTo(groupsByName, normalizeName(entry?.[1]), toGroup(entry?.[0]));
  }
  for (const [canton, localities] of Object.entries(localityIndex?.cantons || {})) {
    for (const [name, npa] of Object.entries(localities || {})) {
      addTo(groupsByNpa, String(npa), toGroup(canton));
      addTo(groupsByName, normalizeName(name), toGroup(canton));
    }
  }
  const unique = (set) => (set && set.size === 1 ? [...set][0] : null);

  return function resolveStationCanton(station) {
    const address = String(station?.address || '');
    // Swiss addresses end with "<NPA> <Ort>"; scan from the end so a house
    // number of four digits earlier in the street is not mistaken for it.
    const npaMatches = [...address.matchAll(/\b(\d{4})\b/g)].reverse();
    for (const m of npaMatches) {
      const group = unique(groupsByNpa.get(m[1]));
      if (group) return group;
    }
    // NPA unknown or shared across cantons: fall back to the locality name
    // after it (or the last comma-separated segment), when unambiguous.
    const tail = npaMatches.length
      ? address.slice(npaMatches[0].index + 4)
      : address.split(',').pop();
    return unique(groupsByName.get(normalizeName(tail)));
  };
}

// ─── Source parsers ──────────────────────────────────────────────────────

/**
 * Extract the single entry of a ZIP archive (the French feed ships one XML
 * file). Dependency-free on purpose: the refresh workflow runs plain `node`
 * without `npm ci`. Reads the central directory, so archives written with a
 * trailing data descriptor work too.
 */
export function extractSingleZipEntry(buffer, inflateRawSync) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: end of central directory not found');
  const entries = buf.readUInt16LE(eocd + 10);
  if (entries < 1) throw new Error('zip: archive is empty');
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('zip: bad central directory header');
  const method = buf.readUInt16LE(cd + 10);
  const compressedSize = buf.readUInt32LE(cd + 20);
  const localOffset = buf.readUInt32LE(cd + 42);
  if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('zip: bad local file header');
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + compressedSize);
  if (method === 0) return Buffer.from(data);
  if (method === 8) return inflateRawSync(data);
  throw new Error(`zip: unsupported compression method ${method}`);
}

function readXmlAttributes(source) {
  const out = {};
  for (const m of String(source).matchAll(/([\w-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/**
 * Parse the French instant feed (`PrixCarburants_instantane.xml`) keeping only
 * the stations whose postcode falls in `departments`. Returns one entry per
 * station with `sp95` (SP95, else E10 — both are 95-octane unleaded; E10 is the
 * dominant one in France) and `diesel` (Gazole), each `{ price, observedAt }`.
 */
export function parseFrenchInstantXml(xml, { departments }) {
  const wanted = new Set(departments.map(String));
  const stations = [];
  for (const m of String(xml).matchAll(/<pdv\b([^>]*)>([\s\S]*?)<\/pdv>/g)) {
    const attrs = readXmlAttributes(m[1]);
    const cp = String(attrs.cp || '').padStart(5, '0');
    const department = cp.slice(0, 2);
    if (!wanted.has(department)) continue;
    const prices = {};
    for (const p of m[2].matchAll(/<prix\b([^>]*)\/?>/g)) {
      const a = readXmlAttributes(p[1]);
      const value = Number(String(a.valeur || '').replace(',', '.'));
      // Pre-2022 feeds expressed prices in thousandths of a euro.
      const price = value > 100 ? value / 1000 : value;
      if (!a.nom || !Number.isFinite(price)) continue;
      prices[a.nom] = { price, observedAt: parseFrenchTimestamp(a.maj) };
    }
    const sp95 = prices.SP95 || prices.E10 || null;
    const diesel = prices.Gazole || null;
    if (!sp95 && !diesel) continue;
    stations.push({ id: `FR-${attrs.id}`, department, sp95, diesel });
  }
  return stations;
}

/** E-Control `by-region` response -> `[{ id, price }]` for one fuel. */
export function parseEControStations(json) {
  if (!Array.isArray(json)) throw new Error('E-Control: unexpected response shape');
  const out = [];
  for (const station of json) {
    const amount = Array.isArray(station?.prices) ? Number(station.prices[0]?.amount) : NaN;
    if (!station?.id || !Number.isFinite(amount)) continue;
    out.push({ id: `AT-${station.id}`, price: amount });
  }
  return out;
}

/** Tankerkönig `list.php?type=all` response -> stations with e5/diesel. */
export function parseTankerkoenigStations(json) {
  if (!json || json.ok !== true || !Array.isArray(json.stations)) {
    throw new Error(`Tankerkönig: ${json?.message || 'unexpected response shape'}`);
  }
  return json.stations
    .filter((s) => s?.id)
    .map((s) => ({
      id: `DE-${s.id}`,
      sp95: typeof s.e5 === 'number' ? s.e5 : null,
      diesel: typeof s.diesel === 'number' ? s.diesel : null,
    }));
}

// ─── Aggregation ─────────────────────────────────────────────────────────

/**
 * Collapse `[{ id, price, observedAt }]` into the public record. Stations are
 * deduped by id (a station listed by two adjacent départements/regions counts
 * once), implausible prices and outliers (`MAX_DEVIATION_FROM_MEDIAN`) are
 * dropped. Returns null below `MIN_STATIONS_PER_RECORD`.
 */
export function summarizePrices({ canton, side, fuel, currency, observations, observedAtFallback, source, area, coverage }) {
  const byId = new Map();
  for (const o of observations) {
    if (!o || !isPlausiblePrice(o.price)) continue;
    if (!byId.has(o.id)) byId.set(o.id, o);
  }
  const candidates = [...byId.values()];
  const center = median(candidates.map((r) => r.price));
  const rows = candidates.filter((r) => Math.abs(r.price - center) / center <= MAX_DEVIATION_FROM_MEDIAN);
  if (rows.length < MIN_STATIONS_PER_RECORD) return null;
  const prices = rows.map((r) => r.price);
  const observed = rows.map((r) => r.observedAt).filter(Boolean).sort();
  return {
    canton,
    side,
    fuel,
    currency,
    avg: round(prices.reduce((s, v) => s + v, 0) / prices.length),
    median: round(median(prices)),
    min: round(Math.min(...prices)),
    stations: rows.length,
    observedAt: observed[observed.length - 1] || observedAtFallback || null,
    source,
    area,
    coverage,
  };
}

function pushRecord(records, record) {
  if (record) records.push(record);
}

export function buildChRecords({ swissStations, resolveStationCanton, observedAtFallback }) {
  const byCanton = new Map();
  for (const station of swissStations || []) {
    const canton = resolveStationCanton(station);
    if (!canton) continue;
    if (!byCanton.has(canton)) byCanton.set(canton, []);
    byCanton.get(canton).push(station);
  }
  const records = [];
  for (const [canton, stations] of [...byCanton.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (const fuel of FUELS) {
      const key = fuel === 'sp95' ? 'sp95PriceChf' : 'dieselPriceChf';
      pushRecord(records, summarizePrices({
        canton, side: 'CH', fuel, currency: 'CHF',
        observations: stations.map((s) => ({ id: `CH-${s.id}`, price: s[key], observedAt: s.updatedAt || null })),
        observedAtFallback,
        source: 'TCS Benzinpreis-Radar',
        area: 'CH (fascia entro 25 km dal confine italiano)',
        coverage: 'border-strip',
      }));
    }
  }
  return records;
}

export function buildItRecords({ italyStations, nowMs }) {
  const records = [];
  for (const [canton, provinces] of Object.entries(IT_PROVINCES_BY_CANTON)) {
    const wanted = new Set(provinces);
    // Self-service prices: the comparable figure for a driver crossing over,
    // and one row per station (MIMIT publishes self and served separately).
    const stations = (italyStations || []).filter((s) => wanted.has(s.province) && s.isSelf);
    for (const fuel of FUELS) {
      const key = fuel === 'sp95' ? 'priceEur' : 'dieselPriceEur';
      pushRecord(records, summarizePrices({
        canton, side: 'IT', fuel, currency: 'EUR',
        observations: stations
          .map((s) => ({ id: `IT-${s.id}`, price: s[key], observedAt: parseItalianTimestamp(s.updatedAt) }))
          .filter((o) => isFresh(o.observedAt, nowMs)),
        source: 'MIMIT Osservaprezzi carburanti (open data)',
        area: provinces.map((p) => `IT-${p}`).join(','),
        coverage: 'border-municipalities-self-service',
      }));
    }
  }
  return records;
}

export function buildFrRecords({ frenchStations, nowMs }) {
  const records = [];
  for (const [canton, departments] of Object.entries(FR_DEPARTMENTS_BY_CANTON)) {
    const wanted = new Set(departments);
    const stations = (frenchStations || []).filter((s) => wanted.has(s.department));
    for (const fuel of FUELS) {
      pushRecord(records, summarizePrices({
        canton, side: 'FR', fuel, currency: 'EUR',
        observations: stations
          .filter((s) => s[fuel] && isFresh(s[fuel].observedAt, nowMs))
          .map((s) => ({ id: s.id, price: s[fuel].price, observedAt: s[fuel].observedAt })),
        source: 'prix-carburants.gouv.fr — flux instantané (Licence Ouverte)',
        area: departments.map((d) => `FR-${d}`).join(','),
        coverage: 'departement',
      }));
    }
  }
  return records;
}

/** `austrianByRegion`: `{ [regionCode]: { sp95: [{id,price}], diesel: [...] } }`. */
export function buildAtRecords({ austrianByRegion, observedAt }) {
  const records = [];
  for (const [canton, regions] of Object.entries(AT_REGIONS_BY_CANTON)) {
    for (const fuel of FUELS) {
      const observations = regions.flatMap((code) => (austrianByRegion?.[code]?.[fuel] || [])
        .map((s) => ({ ...s, observedAt })));
      pushRecord(records, summarizePrices({
        canton, side: 'AT', fuel, currency: 'EUR',
        observations,
        source: 'E-Control Spritpreisrechner',
        area: regions.map((r) => `AT-BL${r}`).join(','),
        // The API lists only the cheapest stations of a Bundesland: the
        // average is the average of that published set, not of the region.
        coverage: 'cheapest-published',
      }));
    }
  }
  return records;
}

/** `germanByCanton`: `{ [canton]: [{ id, sp95, diesel }] }`. */
export function buildDeRecords({ germanByCanton, observedAt }) {
  const records = [];
  for (const [canton, stations] of Object.entries(germanByCanton || {})) {
    const points = DE_POINTS_BY_CANTON[canton] || [];
    for (const fuel of FUELS) {
      pushRecord(records, summarizePrices({
        canton, side: 'DE', fuel, currency: 'EUR',
        observations: stations.map((s) => ({ id: s.id, price: s[fuel], observedAt })),
        source: 'Tankerkönig / MTS-K (CC BY 4.0)',
        area: points.map((p) => `DE-${p.label} ${DE_SEARCH_RADIUS_KM} km`).join(','),
        coverage: 'radius',
      }));
    }
  }
  return records;
}

/** Cantons for which at least one non-optional side has a configured source. */
export function expectedCantons() {
  return [...new Set([
    ...CH_EXPECTED_CANTONS,
    ...Object.keys(IT_PROVINCES_BY_CANTON),
    ...Object.keys(FR_DEPARTMENTS_BY_CANTON),
    ...Object.keys(AT_REGIONS_BY_CANTON),
  ])].sort();
}

/**
 * Assemble the dataset. `sourceStatus` is `{ [side]: { status, reason?, ... } }`
 * as reported by the fetchers; it is published verbatim so a consumer can tell
 * "no data because the source was skipped" from "no stations".
 */
export function buildFuelCantonsDataset({
  cantonCodes,
  generatedAt,
  exchangeRate,
  sourceStatus,
  records,
}) {
  const known = new Set(cantonCodes);
  const configured = new Set([
    ...expectedCantons(),
    ...Object.keys(DE_POINTS_BY_CANTON),
  ]);
  for (const code of configured) {
    if (!known.has(code)) throw new Error(`fuel-cantons: canton ${code} is not a URL group of canton-url-slugs.json`);
  }
  const sorted = records
    .filter((r) => known.has(r.canton))
    .sort((a, b) => a.canton.localeCompare(b.canton)
      || SIDES.indexOf(a.side) - SIDES.indexOf(b.side)
      || FUELS.indexOf(a.fuel) - FUELS.indexOf(b.fuel));
  const withData = [...new Set(sorted.map((r) => r.canton))].sort();
  const expected = expectedCantons();
  return {
    schemaVersion: FUEL_CANTONS_SCHEMA_VERSION,
    generatedAt,
    fuels: [...FUELS],
    sides: [...SIDES],
    cantons: [...cantonCodes].sort(),
    exchangeRate: exchangeRate
      ? { provider: 'ECB', chfPerEur: round(exchangeRate.chfPerEur, 6), eurPerChf: round(exchangeRate.eurPerChf, 6) }
      : null,
    sources: sourceStatus,
    coverage: {
      expectedCantons: expected,
      cantonsWithData: withData,
      expectedCantonsWithData: expected.filter((c) => withData.includes(c)),
      cantonsWithoutData: [...cantonCodes].filter((c) => !withData.includes(c)).sort(),
      minExpectedCoverage: MIN_EXPECTED_CANTON_COVERAGE,
    },
    records: sorted,
  };
}

/**
 * Validity gate. Returns `{ ok, errors, coverageRatio }`; the CLI refuses to
 * write when `ok` is false, so the last good file stays published.
 */
export function validateFuelCantonsDataset(dataset) {
  const errors = [];
  if (dataset?.schemaVersion !== FUEL_CANTONS_SCHEMA_VERSION) errors.push('schemaVersion mismatch');
  const records = Array.isArray(dataset?.records) ? dataset.records : [];
  for (const r of records) {
    const bad = !SIDES.includes(r.side) || !FUELS.includes(r.fuel)
      || !isPlausiblePrice(r.avg) || !isPlausiblePrice(r.min) || r.min > r.avg
      || !Number.isInteger(r.stations) || r.stations < MIN_STATIONS_PER_RECORD
      || !r.observedAt || !r.source || !r.canton;
    if (bad) errors.push(`invalid record ${r.canton}/${r.side}/${r.fuel}`);
  }
  const expected = dataset?.coverage?.expectedCantons || expectedCantons();
  const withData = new Set(records.map((r) => r.canton));
  const covered = expected.filter((c) => withData.has(c)).length;
  const coverageRatio = expected.length ? covered / expected.length : 0;
  if (coverageRatio < MIN_EXPECTED_CANTON_COVERAGE) {
    errors.push(`only ${covered}/${expected.length} expected cantons have data (floor ${MIN_EXPECTED_CANTON_COVERAGE})`);
  }
  for (const side of ['CH', 'IT']) {
    if (!records.some((r) => r.side === side)) errors.push(`no ${side} record: generator input missing or empty`);
  }
  return { ok: errors.length === 0, errors, coverageRatio: round(coverageRatio, 3) };
}
