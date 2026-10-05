#!/usr/bin/env node

/**
 * Generate `data/swiss-canton-boundaries.json`: the 26 canton polygons used by
 * `scripts/lib/swiss-canton-geo.mjs` (`cantonAtPoint`) to give an event with
 * coordinates its canton without any network call at assemble time.
 *
 * Source: swisstopo swissBOUNDARIES3D, layer
 * `ch.swisstopo.swissboundaries3d-kanton-flaeche.fill`, read through the
 * public geo.admin.ch REST API (`find` by canton abbreviation `ak`, WGS84
 * GeoJSON). Open government data, attribution "© swisstopo". One request per
 * canton, paced.
 *
 *   node scripts/generate-swiss-canton-boundaries.mjs            # fetch + write
 *   node scripts/generate-swiss-canton-boundaries.mjs --dry-run  # fetch + report only
 *
 * Simplification: Douglas-Peucker with TOLERANCE_DEG on every ring, then
 * coordinates rounded to DECIMALS. 0.0005° is ~38 m of longitude and ~55 m of
 * latitude at Swiss latitudes: only a point that close to a cantonal border
 * can change side, and an overlap sliver there yields `null` (ambiguous), not
 * a guess — see the contract in swiss-canton-geo.mjs. Measured on the
 * 2026-10-03 events dataset: the full-resolution and the 0.0001° / 0.0003°
 * tables attribute exactly the same events, and all 555 cached Nominatim
 * canton answers agree with this table.
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_FILE = join(__dirname, '..', 'data', 'swiss-canton-boundaries.json');
const LAYER = 'ch.swisstopo.swissboundaries3d-kanton-flaeche.fill';
const API = 'https://api3.geo.admin.ch/rest/services/api/MapServer/find';
const USER_AGENT = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch)';
const CANTONS = ['ZH', 'BE', 'LU', 'UR', 'SZ', 'OW', 'NW', 'GL', 'ZG', 'FR', 'SO', 'BS', 'BL', 'SH', 'AR', 'AI', 'SG', 'GR', 'AG', 'TG', 'TI', 'VD', 'VS', 'NE', 'GE', 'JU'];
export const TOLERANCE_DEG = 0.0005;
export const DECIMALS = 4;
const DELAY_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function perpendicularDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Iterative Douglas-Peucker; keeps the first and last point (closed rings stay closed). */
export function simplifyRing(points, tolerance) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    let maxDistance = 0;
    let index = -1;
    for (let i = start + 1; i < end; i += 1) {
      const distance = perpendicularDistance(points[i], points[start], points[end]);
      if (distance > maxDistance) {
        maxDistance = distance;
        index = i;
      }
    }
    if (index > 0 && maxDistance > tolerance) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * GeoJSON (Multi)Polygon → `[[flatRing, …], …]`, simplified and rounded.
 * A ring that collapses below a triangle is dropped; a polygon whose OUTER
 * ring collapses is dropped with its holes (a hole never survives alone).
 */
export function compactGeometry(geometry, tolerance = TOLERANCE_DEG, decimals = DECIMALS) {
  const factor = 10 ** decimals;
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : null;
  if (!polygons) throw new Error(`unsupported geometry type ${geometry?.type}`);
  const out = [];
  for (const polygon of polygons) {
    const rings = polygon.map((ring) => simplifyRing(ring, tolerance)
      .flatMap(([x, y]) => [Math.round(x * factor) / factor, Math.round(y * factor) / factor]));
    if (rings[0].length < 8) continue;
    out.push([rings[0], ...rings.slice(1).filter((ring) => ring.length >= 8)]);
  }
  return out;
}

async function fetchCanton(code) {
  const params = new URLSearchParams({
    layer: LAYER,
    searchText: code,
    searchField: 'ak',
    contains: 'false',
    returnGeometry: 'true',
    geometryFormat: 'geojson',
    sr: '4326',
  });
  const res = await fetch(`${API}?${params}`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${code}: HTTP ${res.status}`);
  const body = await res.text();
  const results = JSON.parse(body).results || [];
  const matches = results.filter((r) => r?.properties?.ak === code);
  if (matches.length !== 1) throw new Error(`${code}: expected exactly one feature, got ${matches.length}`);
  return { geometry: matches[0].geometry, bytes: body.length, sha: createHash('sha256').update(body).digest('hex') };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const cantons = {};
  const sourceDigest = createHash('sha256');
  let points = 0;
  for (const code of CANTONS) {
    const { geometry, sha } = await fetchCanton(code);
    sourceDigest.update(`${code}:${sha}\n`);
    cantons[code] = compactGeometry(geometry);
    if (cantons[code].length === 0) throw new Error(`${code}: geometry collapsed during simplification`);
    points += cantons[code].flat().reduce((sum, ring) => sum + ring.length / 2, 0);
    await sleep(DELAY_MS);
  }
  const doc = {
    generatedAt: new Date().toISOString().slice(0, 10),
    source: 'swisstopo swissBOUNDARIES3D — Kantonsgrenzen (open government data, © swisstopo)',
    sourceUrl: `${API}?layer=${LAYER}&searchField=ak`,
    layer: LAYER,
    sourceSha256: sourceDigest.digest('hex'),
    simplification: { method: 'douglas-peucker', toleranceDeg: TOLERANCE_DEG, decimals: DECIMALS },
    format: 'cantons[code] = polygons; polygon = [outerRing, ...holeRings]; ring = flat [lng0, lat0, lng1, lat1, ...] (WGS84)',
    cantons,
  };
  const json = `${JSON.stringify(doc)}\n`;
  console.log(`[canton-boundaries] ${CANTONS.length} cantons, ${points} points, ${json.length} bytes`);
  if (dryRun) return;
  writeFileSync(OUTPUT_FILE, json);
  console.log(`[canton-boundaries] wrote ${OUTPUT_FILE}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(`[canton-boundaries] ${err?.message || err}`);
    process.exit(1);
  });
}
