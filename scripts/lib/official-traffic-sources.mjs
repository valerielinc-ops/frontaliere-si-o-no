/**
 * Official open-data signals for the border traffic collector.
 *
 * The adapters are intentionally best-effort. A source outage must not stop a
 * paid routing provider or the webcam fallback. Every parser is exported as a
 * pure helper so fixtures can test the mapping without network access.
 */

import { BORDER_CROSSINGS, slugifyCrossingName } from '../../functions/src/borderCrossingsData.js';
import { reserveTrafficProviderRequest } from '../../functions/src/trafficProviderMesh.js';

const SWISS_TRAFFIC_BASE_URL = 'https://api.opentransportdata.swiss/TDP/Rest_OcitC/Read/v1';
const SWISS_TRAFFIC_URL = `${SWISS_TRAFFIC_BASE_URL}/snippets`;
const SWISS_AREAS_URL = `${SWISS_TRAFFIC_BASE_URL}/areas`;
const SWISS_SOURCE_ID = 'ch-astra-traffic-lights';

const FRANCE_SPEEDS_URL = 'https://transport.data.gouv.fr/resources/79165/download';
const FRANCE_STATIONS_URL = 'https://transport.data.gouv.fr/resources/79167/download';
const AUTOSTRADE_A9_URL = 'https://viabilita.autostrade.it/traffico-fasce-orarie-cantieri-lombardia/allA9.json';
const CCISS_URL = 'https://www.cciss.it/web/cciss?cciss_lang=it';
const ATMB_BULLETIN_URL = 'https://www.atmb.com/les-webcams-de-la40-et-la-rn205/';

export const OFFICIAL_TRAFFIC_SOURCES = Object.freeze([
  Object.freeze({
    id: SWISS_SOURCE_ID,
    region: 'CH',
    kind: 'traffic-lights',
    url: SWISS_TRAFFIC_URL,
    license: 'OpenTransportData / ASTRA official OCIT-C traffic-lights feed',
    requiresKey: true,
  }),
  Object.freeze({
    id: 'fr-bison-qtv',
    region: 'FR',
    kind: 'measured-speeds',
    url: FRANCE_SPEEDS_URL,
    referenceUrl: FRANCE_STATIONS_URL,
    license: 'French Ministry / Bison Futé open data',
    requiresKey: false,
  }),
  Object.freeze({
    id: 'it-autostrade-a9',
    region: 'IT',
    kind: 'motorway-status',
    url: AUTOSTRADE_A9_URL,
    license: 'Autostrade per l’Italia official traffic/works feed',
    requiresKey: false,
  }),
  Object.freeze({
    id: 'it-cciss',
    region: 'IT',
    kind: 'national-bulletin',
    url: CCISS_URL,
    license: 'CCISS official national traffic bulletin',
    requiresKey: false,
  }),
  Object.freeze({
    id: 'fr-atmb-bulletin',
    region: 'FR',
    kind: 'operator-bulletin',
    url: ATMB_BULLETIN_URL,
    license: 'ATMB official A40/RN205 bulletin',
    requiresKey: false,
  }),
]);

function finiteNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function normaliseText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function parseTag(block, tag) {
  const match = String(block).match(new RegExp(`<(?:(?:[A-Za-z0-9_]+):)?${tag}\\b[^>]*>([^<]+)<`, 'i'));
  return match ? normaliseText(match[1]) : null;
}

function parseAttribute(block, tag, attribute) {
  const match = String(block).match(new RegExp(`<(?:(?:[A-Za-z0-9_]+):)?${tag}\\b[^>]*\\b${attribute}=["']([^"']+)["']`, 'i'));
  return match ? normaliseText(match[1]) : null;
}

function haversineKm(aLat, aLng, bLat, bLng) {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(Math.max(0, 1 - x)));
}

export function nearestCrossingSlug(lat, lng, crossings = BORDER_CROSSINGS, maxDistanceKm = Infinity) {
  const latitude = finiteNumber(lat);
  const longitude = finiteNumber(lng);
  if (latitude === null || longitude === null) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const crossing of crossings) {
    const distance = haversineKm(latitude, longitude, crossing.lat, crossing.lng);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = crossing;
    }
  }
  return best && bestDistance <= maxDistanceKm ? slugifyCrossingName(best.name) : null;
}

/** Lambert-93 metres → WGS84 degrees, sufficient for nearest-border mapping. */
export function lambert93ToWgs84(x, y) {
  const east = finiteNumber(x);
  const north = finiteNumber(y);
  if (east === null || north === null) return null;

  const a = 6378137;
  const e = 0.0818191910428158;
  const n = 0.725607765053267;
  const c = 11754255.426096;
  const xs = 700000;
  const ys = 12655612.049876;
  const lon0 = 3 * Math.PI / 180;
  const r = Math.hypot(east - xs, north - ys);
  const gamma = Math.atan((east - xs) / (ys - north));
  const isoLat = -Math.log(r / c) / n;
  let lat = 2 * Math.atan(Math.exp(isoLat)) - Math.PI / 2;
  for (let i = 0; i < 6; i++) {
    lat = 2 * Math.atan(
      Math.exp(isoLat) * ((1 - e * Math.sin(lat)) / (1 + e * Math.sin(lat))) ** (e / 2),
    ) - Math.PI / 2;
  }
  const lng = lon0 + gamma / n;
  return { lat: lat * 180 / Math.PI, lng: lng * 180 / Math.PI };
}

export function parseBisonReferenceCsv(csv) {
  const lines = String(csv ?? '').split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));
  if (lines.length === 0) return new Map();
  const header = lines[0].split(';').map((field) => field.trim().toLowerCase());
  const idIndex = header.indexOf('code_pme');
  const refs = new Map();
  if (idIndex < 0) return refs;
  for (const line of lines.slice(1)) {
    const fields = line.split(';').map((field) => field.trim());
    const id = fields[idIndex];
    // QTV-DIR has released rows with one optional column omitted while the
    // header kept its 20-column shape. Locate the first adjacent Lambert-93
    // easting/northing pair instead of trusting a positional index.
    let point = null;
    for (let i = 0; i < fields.length - 1; i++) {
      const east = finiteNumber(fields[i]);
      const north = finiteNumber(fields[i + 1]);
      if (east !== null && east >= 100_000 && east <= 1_000_000
        && north !== null && north >= 6_000_000 && north <= 7_500_000) {
        point = lambert93ToWgs84(east, north);
        break;
      }
    }
    if (id && point) refs.set(id, point);
  }
  return refs;
}

function bisonSpeedToApproachMinutes(speedKmh) {
  if (speedKmh === null) return null;
  if (speedKmh < 10) return 30;
  if (speedKmh < 25) return 15;
  if (speedKmh < 45) return 8;
  return 0;
}

/** Parse the QTV-DIR measured-speed XML into crossing-keyed official signals. */
export function parseBisonMeasuredXml(xml, references, crossings = BORDER_CROSSINGS) {
  const output = new Map();
  const blocks = String(xml ?? '').match(/<(?:(?:[A-Za-z0-9_]+):)?siteMeasurements\b[^>]*>[\s\S]*?<\/(?:(?:[A-Za-z0-9_]+):)?siteMeasurements>/gi) ?? [];
  for (const block of blocks) {
    const id = parseTag(block, 'measurementSiteReference')
      ?? parseAttribute(block, 'measurementSiteReference', 'id');
    const point = references?.get(id);
    if (!point) continue;
    const speed = finiteNumber(parseTag(block, 'speed'));
    const flow = finiteNumber(parseTag(block, 'vehicleFlow')) ?? finiteNumber(parseTag(block, 'vehicleFlowRate'));
    const slug = nearestCrossingSlug(point.lat, point.lng, crossings, 12);
    if (!slug || (speed === null && flow === null)) continue;
    const approachMinutes = bisonSpeedToApproachMinutes(speed);
    const signal = {
      sourceIds: ['fr-bison-qtv'],
      updatedAt: parseTag(block, 'measurementTimeDefault') ?? new Date().toISOString(),
      ...(approachMinutes === null ? {} : { approachMinutes }),
      ...(flow === null ? {} : { flowVehiclesPerHour: flow }),
    };
    const previous = output.get(slug);
    output.set(slug, mergeSignal(previous, signal));
  }
  return output;
}

function parseBoolean(value) {
  return /^(true|1|yes|ja|si)$/i.test(String(value ?? '').trim());
}

function extractNumberByKeys(record, keys) {
  for (const key of keys) {
    const value = finiteNumber(record?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function walkObjects(value, visit) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, visit);
    return;
  }
  visit(value);
  for (const child of Object.values(value)) walkObjects(child, visit);
}

/** Parse the official A9 status JSON, preserving incident-only records. */
export function parseAutostradeA9Json(payload, crossings = BORDER_CROSSINGS) {
  const output = new Map();
  walkObjects(payload, (record) => {
    const label = normaliseText(record.t_des ?? record.description ?? record.name);
    if (!label || !/(chiasso|como centro|lago di como)/i.test(label)) return;
    const blocked = parseBoolean(record.ftrafficoBloccato ?? record.trafficBlocked);
    const closed = parseBoolean(record.fchiusura ?? record.closed);
    const approachMinutes = extractNumberByKeys(record, [
      't_tempoPercorrenza', 'tempoPercorrenza', 'travelTimeMinutes', 'delayMinutes', 'ritardoMinuti',
    ]);
    const target = crossings.find((crossing) => /chiasso/i.test(crossing.name))
      ?? crossings.find((crossing) => /como/i.test(crossing.name));
    if (!target) return;
    const slug = slugifyCrossingName(target.name);
    const signal = {
      sourceIds: ['it-autostrade-a9'],
      incident: blocked || closed,
      ...(approachMinutes === null ? {} : { approachMinutes }),
      // A motorway explicitly marked blocked is a hard signal, unlike a generic
      // works record. The cap keeps it conservative and visible in the UI.
      ...(blocked ? { queueMinutes: 30 } : {}),
    };
    output.set(slug, mergeSignal(output.get(slug), signal));
  });
  return output;
}

/** Parse CCISS's official real-time HTML bulletin for border-corridor events. */
export function parseCcissHtml(html, crossings = BORDER_CROSSINGS) {
  const output = new Map();
  const text = normaliseText(String(html ?? '').replace(/<[^>]+>/g, ' '));
  const lower = text.toLowerCase();
  const corridors = [
    { pattern: /(?:a9|chiasso|como)/i, names: [/chiasso/i] },
    { pattern: /(?:a8|a60|gaggiolo|varese|clivio|stabio)/i, names: [/gaggiolo/i, /san pietro/i] },
    { pattern: /(?:ss233|ponte tresa|luino)/i, names: [/ponte tresa/i] },
  ];
  for (const corridor of corridors) {
    if (!corridor.pattern.test(lower)) continue;
    const target = crossings.find((crossing) => corridor.names.some((pattern) => pattern.test(crossing.name)));
    if (!target) continue;
    const relevant = text.match(new RegExp(`[^.!?]{0,180}${corridor.pattern.source}[^.!?]{0,260}`, 'i'))?.[0] ?? text.slice(0, 420);
    output.set(slugifyCrossingName(target.name), mergeSignal(output.get(slugifyCrossingName(target.name)), {
      sourceIds: ['it-cciss'],
      incident: /(coda|code|rallentato|incidente|veicolo|lavori|chiusura|bloccato)/i.test(relevant),
      bulletinText: relevant,
      updatedAt: new Date().toISOString(),
    }));
  }
  return output;
}

/** Parse ATMB's official HTML bulletin for explicit Bardonnex queue messages. */
export function parseAtmbBulletinHtml(html) {
  const output = new Map();
  const text = normaliseText(String(html ?? '').replace(/<[^>]+>/g, ' '));
  const matches = text.match(/(?:A41|A40)[^.!?]{0,260}BARDONNEX[^.!?]*/gi) ?? [];
  for (const match of matches) {
    const queueKm = finiteNumber(match.match(/(?:BOUCHON|QUEUE)[^0-9]{0,20}(\d+(?:[.,]\d+)?)\s*KM/i)?.[1]);
    const delayMinutes = finiteNumber(match.match(/(?:RETARD|DELAY)[^0-9]{0,20}(\d+(?:[.,]\d+)?)\s*(?:MIN|MN)/i)?.[1]);
    if (queueKm === null && delayMinutes === null) continue;
    output.set('bardonnex', mergeSignal(output.get('bardonnex'), {
      sourceIds: ['fr-atmb-bulletin'],
      updatedAt: new Date().toISOString(),
      ...(queueKm === null ? {} : { queueKm }),
      ...(delayMinutes === null ? {} : { queueMinutes: delayMinutes }),
    }));
  }
  return output;
}

/** Parse coarse coordinates/severity from a Swiss DATEX traffic response. */
export function parseSwissDatexXml(xml, crossings = BORDER_CROSSINGS) {
  const output = new Map();
  const text = String(xml ?? '');
  const latitudes = [...text.matchAll(/<(?:(?:[A-Za-z0-9_]+):)?latitude\b[^>]*>([-+\d.]+)</gi)].map((m) => Number(m[1]));
  const longitudes = [...text.matchAll(/<(?:(?:[A-Za-z0-9_]+):)?longitude\b[^>]*>([-+\d.]+)</gi)].map((m) => Number(m[1]));
  const lower = text.toLowerCase();
  const incident = /(queue|congestion|stationary|blocked|roadworks|accident|stau|bouchon|coda)/i.test(lower);
  for (let i = 0; i < Math.min(latitudes.length, longitudes.length); i++) {
    const slug = nearestCrossingSlug(latitudes[i], longitudes[i], crossings, 15);
    if (!slug) continue;
    output.set(slug, mergeSignal(output.get(slug), {
      sourceIds: ['ch-fedro-datex'],
      updatedAt: parseTag(text, 'publicationTime') ?? new Date().toISOString(),
      incident,
    }));
  }
  return output;
}

const SWISS_BORDER_AREA_RE = /(?:^|[.:_\s-])(?:TI|GE|VD|VS|NE|JU)(?:[.:_\s-]|$)|ticino|geneva|vaud|valais|neuchatel|neuchâtel|jura/i;

function tagBlocks(text, tag) {
  const pattern = '<(?:(?:[A-Za-z0-9_]+):)?' + tag
    + '\\b[^>]*>[\\s\\S]*?<\\/(?:(?:[A-Za-z0-9_]+):)?' + tag + '>';
  return String(text ?? '').match(new RegExp(pattern, 'gi')) ?? [];
}

function normaliseUnitId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value !== 'object') return null;
  const parts = ['System', 'Subsystem', 'Unit']
    .map((key) => value[key] ?? value[key.toLowerCase()])
    .filter((part) => part !== null && part !== undefined && String(part).trim() !== '');
  return parts.length ? parts.join('-') : null;
}

function swissUnitKey(areaId, unitId) {
  const area = normaliseText(areaId);
  const unit = normaliseUnitId(unitId);
  return area && unit ? [area, unit].join('|') : null;
}

function swissCoordinates(value) {
  const coordinates = value?.Coordinates ?? value?.coordinates ?? value;
  const latitude = finiteNumber(coordinates?.Latitude ?? coordinates?.latitude ?? coordinates?.lat);
  const longitude = finiteNumber(coordinates?.Longitude ?? coordinates?.longitude ?? coordinates?.lng);
  if (latitude === null || longitude === null) return null;
  const epsg = finiteNumber(coordinates?.EPSGCode ?? coordinates?.epsgCode);
  if (epsg !== null && epsg !== 4326) return null;
  return { lat: latitude, lng: longitude };
}

/** Parse the OCIT-C areas XML catalogue. */
export function parseSwissTrafficLightAreas(payload) {
  if (payload && typeof payload === 'object') {
    const values = payload.Area ?? payload.Areas ?? payload.areas ?? [];
    return (Array.isArray(values) ? values : [values]).map((area) => ({
      areaId: normaliseText(area?.AreaId ?? area?.areaId ?? area?.id),
      name: normaliseText(area?.Name?.Value ?? area?.name),
    })).filter((area) => area.areaId);
  }
  return tagBlocks(payload, 'Area').map((block) => ({
    areaId: parseTag(block, 'AreaId'),
    name: parseTag(block, 'Value') ?? parseTag(block, 'Name'),
  })).filter((area) => area.areaId);
}

/** Parse intersection coordinates so OCIT-C snippets can be matched to a crossing. */
export function parseSwissTrafficLightIntersections(payload) {
  const output = new Map();
  if (payload && typeof payload === 'object') {
    const values = payload.Intersection ?? payload.Intersections ?? payload.intersections ?? [];
    for (const intersection of (Array.isArray(values) ? values : [values])) {
      const key = swissUnitKey(
        intersection?.AreaId ?? intersection?.areaId,
        intersection?.Identification?.UnitId ?? intersection?.unitId ?? intersection?.UnitId,
      );
      const point = swissCoordinates(intersection);
      if (key && point) output.set(key, point);
    }
    return output;
  }
  for (const block of tagBlocks(payload, 'Intersection')) {
    const unitBlock = tagBlocks(block, 'UnitId')[0] ?? block;
    const unitId = [
      parseTag(unitBlock, 'System'),
      parseTag(unitBlock, 'Subsystem'),
      parseTag(unitBlock, 'Unit'),
    ].filter(Boolean).join('-');
    const key = swissUnitKey(parseTag(block, 'AreaId'), unitId);
    const point = swissCoordinates({
      Latitude: parseTag(block, 'Latitude'),
      Longitude: parseTag(block, 'Longitude'),
    });
    if (key && point) output.set(key, point);
  }
  return output;
}

function measurementQueueMeters(value) {
  let maximum = null;
  walkObjects(value, (record) => {
    const spillback = record.SpillbackLength ?? record.spillbackLength;
    const values = Array.isArray(spillback) ? spillback : spillback ? [spillback] : [];
    for (const item of values) {
      const candidates = [
        item.Length,
        item.length,
        ...(Array.isArray(item.Lengths) ? item.Lengths : []),
        ...(Array.isArray(item.lengths) ? item.lengths : []),
      ];
      for (const candidate of candidates) {
        const meters = finiteNumber(candidate);
        if (meters !== null) maximum = maximum === null ? meters : Math.max(maximum, meters);
      }
    }
  });
  return maximum;
}

/** Parse OCIT-C snippets and map measured spillback to the nearest border. */
export function parseSwissTrafficLightJson(payload, intersectionCoordinates = new Map(), crossings = BORDER_CROSSINGS) {
  const output = new Map();
  const groups = payload?.Snippets ?? payload?.snippets ?? [];
  for (const group of (Array.isArray(groups) ? groups : [groups])) {
    const key = swissUnitKey(group?.AreaId ?? group?.areaId, group?.UnitId ?? group?.unitId);
    const point = intersectionCoordinates.get(key)
      ?? swissCoordinates(group)
      ?? swissCoordinates(group?.Intersection);
    if (!point) continue;
    const slug = nearestCrossingSlug(point.lat, point.lng, crossings, 15);
    if (!slug) continue;
    const queueMeters = measurementQueueMeters(group);
    if (queueMeters === null) continue;
    const snippets = group.Snippet ?? group.snippet ?? [];
    const timestamps = (Array.isArray(snippets) ? snippets : [snippets])
      .map((snippet) => snippet?.Timestamp ?? snippet?.timestamp)
      .map((timestamp) => timestamp && new Date(timestamp).toString() !== 'Invalid Date' ? String(timestamp) : null)
      .filter(Boolean);
    output.set(slug, mergeSignal(output.get(slug), {
      sourceIds: [SWISS_SOURCE_ID],
      incident: queueMeters > 0,
      queueKm: queueMeters / 1000,
      ...(timestamps.length ? { updatedAt: timestamps.sort().at(-1) } : {}),
    }));
  }
  return output;
}

export function mergeSignal(previous, next) {
  if (!previous) return { ...next, sourceIds: [...new Set(next.sourceIds ?? [])] };
  const sourceIds = [...new Set([...(previous.sourceIds ?? []), ...(next.sourceIds ?? [])])];
  const merged = { ...previous, ...next, sourceIds };
  for (const key of ['queueMinutes', 'approachMinutes', 'queueKm', 'flowVehiclesPerHour']) {
    const values = [previous[key], next[key]].map(finiteNumber).filter((value) => value !== null);
    if (values.length) merged[key] = Math.max(...values);
  }
  merged.incident = Boolean(previous.incident || next.incident);
  return merged;
}

function mergeSignalMap(target, source) {
  for (const [slug, signal] of source ?? []) target.set(slug, mergeSignal(target.get(slug), signal));
}

async function fetchText(url, init = {}, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`official traffic HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url, init = {}, fetchImpl = globalThis.fetch) {
  const text = await fetchText(url, init, fetchImpl);
  return JSON.parse(text);
}

function sourceResult(source, status, recordCount, extra = {}) {
  return {
    id: source.id,
    region: source.region,
    kind: source.kind,
    url: source.url,
    status,
    recordCount,
    fetchedAt: new Date().toISOString(),
    license: source.license,
    ...extra,
  };
}

async function reserveSwissRequestWithCadence(reserveSwissRequest) {
  let reservation;
  for (let attempt = 0; attempt < 2; attempt++) {
    reservation = await reserveSwissRequest();
    if (reservation?.allowed) return reservation;
    if (reservation?.reason !== 'rate-limit') return reservation;
    const retryAfterMs = Number(reservation.retryAfterMs);
    if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return reservation;
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.ceil(retryAfterMs), 60_000)));
  }
  return reservation;
}

function swissApiInit(apiKey) {
  return {
    headers: {
      Authorization: 'Bearer ' + apiKey,
      Accept: 'application/json, application/xml',
      'User-Agent': 'frontaliereticino.ch traffic scheduler',
    },
  };
}

async function fetchSwissText(url, apiKey, fetchImpl, reserveSwissRequest) {
  const reservation = await reserveSwissRequestWithCadence(reserveSwissRequest);
  if (!reservation?.allowed) {
    const error = new Error('OpenTransportData quota guard blocked request');
    error.code = 'OPENTRANSPORTDATA_QUOTA_BLOCKED';
    error.reason = reservation?.reason ?? 'quota';
    error.retryAfterMs = reservation?.retryAfterMs;
    throw error;
  }
  return fetchText(url, swissApiInit(apiKey), fetchImpl);
}

async function fetchSwissJson(url, apiKey, fetchImpl, reserveSwissRequest) {
  const text = await fetchSwissText(url, apiKey, fetchImpl, reserveSwissRequest);
  return JSON.parse(text);
}

async function collectSwiss(apiKey, fetchImpl, reserveSwissRequest) {
  const source = OFFICIAL_TRAFFIC_SOURCES.find((item) => item.id === SWISS_SOURCE_ID);
  if (!apiKey) return { signals: new Map(), health: sourceResult(source, 'skipped', 0, { reason: 'missing API key' }) };
  try {
    const areasPayload = await fetchSwissText(SWISS_AREAS_URL, apiKey, fetchImpl, reserveSwissRequest);
    const areas = parseSwissTrafficLightAreas(areasPayload)
      .filter((area) => SWISS_BORDER_AREA_RE.test((area.areaId ?? '') + ' ' + (area.name ?? '')))
      .slice(0, 6);
    const intersectionCoordinates = new Map();
    for (const area of areas) {
      const url = SWISS_TRAFFIC_BASE_URL + '/intersections/' + encodeURIComponent(area.areaId);
      const intersections = await fetchSwissText(url, apiKey, fetchImpl, reserveSwissRequest);
      for (const [key, point] of parseSwissTrafficLightIntersections(intersections)) {
        intersectionCoordinates.set(key, point);
      }
    }
    if (!intersectionCoordinates.size) {
      return {
        signals: new Map(),
        health: sourceResult(source, 'ok', 0, { areas: areas.length, intersections: 0 }),
      };
    }
    const signals = new Map();
    for (const area of areas) {
      const url = SWISS_TRAFFIC_BASE_URL + '/snippets/' + encodeURIComponent(area.areaId);
      const snippets = await fetchSwissJson(url, apiKey, fetchImpl, reserveSwissRequest);
      mergeSignalMap(signals, parseSwissTrafficLightJson(snippets, intersectionCoordinates));
    }
    return {
      signals,
      health: sourceResult(source, 'ok', signals.size, {
        areas: areas.length,
        intersections: intersectionCoordinates.size,
      }),
    };
  } catch (error) {
    if (error?.code === 'OPENTRANSPORTDATA_QUOTA_BLOCKED') {
      return {
        signals: new Map(),
        health: sourceResult(source, 'skipped', 0, {
          reason: error.reason ?? 'quota exhausted',
          retryAfterMs: error.retryAfterMs,
        }),
      };
    }
    throw error;
  }
}

async function collectBison(fetchImpl) {
  const source = OFFICIAL_TRAFFIC_SOURCES.find((item) => item.id === 'fr-bison-qtv');
  const [xml, csv] = await Promise.all([
    fetchText(FRANCE_SPEEDS_URL, {}, fetchImpl),
    fetchText(FRANCE_STATIONS_URL, {}, fetchImpl),
  ]);
  const refs = parseBisonReferenceCsv(csv);
  const signals = parseBisonMeasuredXml(xml, refs);
  return { signals, health: sourceResult(source, 'ok', signals.size, { stations: refs.size }) };
}

async function collectAutostrade(fetchImpl) {
  const source = OFFICIAL_TRAFFIC_SOURCES.find((item) => item.id === 'it-autostrade-a9');
  const payload = await fetchJson(AUTOSTRADE_A9_URL, {}, fetchImpl);
  const signals = parseAutostradeA9Json(payload);
  return { signals, health: sourceResult(source, 'ok', signals.size) };
}

async function collectCciss(fetchImpl) {
  const source = OFFICIAL_TRAFFIC_SOURCES.find((item) => item.id === 'it-cciss');
  const html = await fetchText(CCISS_URL, {}, fetchImpl);
  const signals = parseCcissHtml(html);
  return { signals, health: sourceResult(source, 'ok', signals.size) };
}

async function collectAtmb(fetchImpl) {
  const source = OFFICIAL_TRAFFIC_SOURCES.find((item) => item.id === 'fr-atmb-bulletin');
  const html = await fetchText(ATMB_BULLETIN_URL, {}, fetchImpl);
  const signals = parseAtmbBulletinHtml(html);
  return { signals, health: sourceResult(source, 'ok', signals.size) };
}

/**
 * Collect all official sources concurrently. The returned object is safe to
 * pass through `fetchCrossingTraffic({ officialSignals })`.
 */
export async function collectOfficialTrafficSignals({
  swissApiKey = process.env.OPENTRANSPORTDATA_API_KEY,
  fetchImpl = globalThis.fetch,
  reserveSwissRequest = () => reserveTrafficProviderRequest('opentransportdata', 'traffic-lights'),
} = {}) {
  const jobs = [
    collectSwiss(swissApiKey, fetchImpl, reserveSwissRequest),
    collectBison(fetchImpl),
    collectAutostrade(fetchImpl),
    collectCciss(fetchImpl),
    collectAtmb(fetchImpl),
  ];
  const settled = await Promise.allSettled(jobs);
  const byCrossing = new Map();
  const sources = [];
  settled.forEach((item, index) => {
    const source = OFFICIAL_TRAFFIC_SOURCES[index];
    if (item.status === 'fulfilled') {
      mergeSignalMap(byCrossing, item.value.signals);
      sources.push(item.value.health);
    } else {
      sources.push(sourceResult(source, 'error', 0, { error: String(item.reason?.message ?? item.reason ?? 'unknown error') }));
    }
  });
  return {
    generatedAt: new Date().toISOString(),
    sources,
    byCrossing: Object.fromEntries(byCrossing),
  };
}
