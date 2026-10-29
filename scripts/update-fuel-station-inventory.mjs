#!/usr/bin/env node
/**
 * Build the tracked Swiss fuel-station inventory from an OSM GeoJSON export.
 *
 * The scheduled workflow supplies the GeoJSON by downloading the Switzerland
 * Geofabrik extract and running `osmium tags-filter ... amenity=fuel` followed
 * by `osmium export`. Keeping the parser separate makes the source contract
 * testable without downloading the 500+ MB PBF locally.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { cantonAtPoint } from './lib/swiss-canton-geo.mjs';
import {
  OSM_FUEL_DATA_URL,
  OSM_FUEL_LICENSE,
  OSM_FUEL_MAP_URL,
  OSM_FUEL_PROVIDER,
  OSM_FUEL_QUERY_TAG,
  OSM_FUEL_SOURCE,
  parseOsmFuelGeoJson,
} from './lib/fuel-openstreetmap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
export function buildFuelStationInventory(input, { observedAt = new Date().toISOString(), cantonResolver = cantonAtPoint } = {}) {
  const stations = parseOsmFuelGeoJson(input, { observedAt, cantonResolver });
  return {
    schemaVersion: 1,
    country: 'CH',
    scope: 'national',
    coverageType: 'open-inventory',
    inventoryCompleteness: 'not-verified',
    generatedAt: observedAt,
    observedAt,
    source: {
      provider: OSM_FUEL_PROVIDER,
      sourceId: OSM_FUEL_SOURCE,
      query: OSM_FUEL_QUERY_TAG,
      dataUrl: OSM_FUEL_DATA_URL,
      attributionUrl: OSM_FUEL_MAP_URL,
      license: OSM_FUEL_LICENSE,
      attribution: '© OpenStreetMap contributors',
    },
    stationCount: stations.length,
    stations,
  };
}

function main() {
  const inputPath = argValue('--input');
  const outputPath = path.resolve(argValue('--output') || path.join(ROOT, 'data', 'fuel-station-inventory.json'));
  if (!inputPath) throw new Error('--input <geojson> is required');
  const input = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
  const observedAt = argValue('--observed-at') || new Date().toISOString();
  const inventory = buildFuelStationInventory(input, { observedAt });
  if (inventory.stationCount === 0) throw new Error('OSM export produced no Swiss road-fuel stations');
  writeJsonAtomic(outputPath, inventory);
  const publicPath = path.join(ROOT, 'public', 'data', 'fuel-station-inventory.json');
  if (path.resolve(outputPath) === path.resolve(path.join(ROOT, 'data', 'fuel-station-inventory.json'))) {
    writeJsonAtomic(publicPath, inventory);
  }
  console.log(`[fuel-inventory] ${inventory.stationCount} Swiss OSM stations written to ${outputPath}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(`[fuel-inventory] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
