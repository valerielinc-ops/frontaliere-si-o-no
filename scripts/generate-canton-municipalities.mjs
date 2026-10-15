#!/usr/bin/env node

/**
 * Generate canton municipality data from the official BFS (Swiss Federal
 * Statistical Office) Communes API.
 *
 * Source: https://www.agvchapp.bfs.admin.ch/api/communes/snapshot
 *
 * Produces `data/canton-municipalities.json` — a stable snapshot of all
 * Swiss municipalities grouped by canton. Used by the crawler location
 * matching engine (`scripts/lib/target-swiss-locations.mjs`).
 *
 * Usage:
 *   node scripts/generate-canton-municipalities.mjs          # fetch fresh + write
 *   node scripts/generate-canton-municipalities.mjs --cached  # use local cache only
 *
 * The script is error-resilient:
 * - On network failure, falls back to the local cache if available
 * - Never overwrites a valid cache with empty/corrupt data
 * - Validates output before writing
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const OUTPUT_FILE = join(DATA_DIR, 'canton-municipalities.json');
const BFS_CACHE_FILE = join(DATA_DIR, 'bfs-communes-snapshot.csv');
const ALIASES_FILE = join(DATA_DIR, 'canton-location-aliases.json');

const BFS_API_URL = 'https://www.agvchapp.bfs.admin.ch/api/communes/snapshot';

// ─── BFS CSV hierarchy ─────────────────────────────────────────────────────
// Level 1 = Canton, Level 2 = District, Level 3 = Municipality
// Parent field references the HistoricalCode of the parent level.

/**
 * Fetch the BFS CSV snapshot. Falls back to local cache on failure.
 */
async function fetchBfsSnapshot(useCachedOnly = false) {
  if (useCachedOnly) {
    if (!existsSync(BFS_CACHE_FILE)) {
      throw new Error(`--cached flag set but no cache file found at ${BFS_CACHE_FILE}`);
    }
    console.log('📂 Using cached BFS snapshot');
    return readFileSync(BFS_CACHE_FILE, 'utf8');
  }

  const today = new Date();
  const dateParam = `${String(today.getDate()).padStart(2, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}-${today.getFullYear()}`;
  const url = `${BFS_API_URL}?date=${dateParam}`;

  console.log(`🌐 Fetching BFS communes snapshot: ${url}`);

  try {
    const response = await fetch(url, {
      headers: { Accept: 'text/csv' },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`BFS API returned ${response.status}: ${response.statusText}`);
    }

    const csv = await response.text();

    // Basic validation: must have header + at least 2000 rows (Switzerland has ~2100 municipalities)
    const lineCount = csv.split('\n').filter((l) => l.trim()).length;
    if (lineCount < 2000) {
      throw new Error(`BFS response too small: ${lineCount} lines (expected >2000)`);
    }

    // Cache locally
    writeFileSync(BFS_CACHE_FILE, csv, 'utf8');
    console.log(`💾 Cached BFS snapshot (${lineCount} lines) → ${BFS_CACHE_FILE}`);

    return csv;
  } catch (err) {
    console.warn(`⚠️  BFS API fetch failed: ${err.message}`);

    if (existsSync(BFS_CACHE_FILE)) {
      console.log('📂 Falling back to cached BFS snapshot');
      return readFileSync(BFS_CACHE_FILE, 'utf8');
    }

    throw new Error(`BFS API failed and no local cache available: ${err.message}`);
  }
}

/**
 * Parse the BFS CSV into a map of canton code → municipality names.
 */
function parseBfsCsv(csv) {
  const lines = csv.split('\n').slice(1).filter((l) => l.trim());

  // Parse CSV rows (simple split — BFS CSV has no quoted fields with commas)
  const rows = lines.map((line) => {
    const cols = line.split(',');
    return {
      histCode: cols[0]?.trim(),
      bfsCode: cols[1]?.trim(),
      level: cols[4]?.trim(),
      parent: cols[5]?.trim(),
      name: cols[6]?.trim(),
      shortName: cols[7]?.trim(),
    };
  });

  // Level 1: Canton → map HistoricalCode → ShortName (e.g., "1" → "ZH")
  const cantonByHistCode = new Map();
  for (const row of rows) {
    if (row.level === '1') {
      cantonByHistCode.set(row.histCode, row.shortName);
    }
  }

  // Level 2: District → map HistoricalCode → canton ShortName
  const districtToCanton = new Map();
  for (const row of rows) {
    if (row.level === '2') {
      const canton = cantonByHistCode.get(row.parent);
      if (canton) {
        districtToCanton.set(row.histCode, canton);
      }
    }
  }

  // Level 3: Municipality → group by canton
  const municipalitiesByCanton = {};
  for (const row of rows) {
    if (row.level === '3') {
      const canton = districtToCanton.get(row.parent);
      if (!canton) continue;
      if (!municipalitiesByCanton[canton]) {
        municipalitiesByCanton[canton] = [];
      }
      municipalitiesByCanton[canton].push(row.name);
    }
  }

  // Sort municipalities within each canton
  for (const canton of Object.keys(municipalitiesByCanton)) {
    municipalitiesByCanton[canton].sort((a, b) => a.localeCompare(b, 'de'));
  }

  return municipalitiesByCanton;
}

/**
 * Load manual location aliases (sub-localities, historical names, etc.).
 */
function loadAliases() {
  if (!existsSync(ALIASES_FILE)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(ALIASES_FILE, 'utf8'));
  } catch {
    console.warn(`⚠️  Could not parse ${ALIASES_FILE}, using empty aliases`);
    return {};
  }
}

/**
 * Validate the output before writing.
 */
function validateOutput(data) {
  const errors = [];

  if (!data.cantons || typeof data.cantons !== 'object') {
    errors.push('Missing or invalid "cantons" object');
  }

  const cantonCount = Object.keys(data.cantons || {}).length;
  if (cantonCount !== 26) {
    errors.push(`Expected 26 cantons, got ${cantonCount}`);
  }

  // Every canton should have at least 3 municipalities
  for (const [code, info] of Object.entries(data.cantons || {})) {
    if (!info.municipalities || info.municipalities.length < 3) {
      errors.push(`Canton ${code} has only ${info.municipalities?.length || 0} municipalities`);
    }
  }

  // Specific cantons we know well
  const expectedMinimums = { TI: 95, GR: 90, VS: 120, ZH: 150, BE: 300 };
  for (const [code, min] of Object.entries(expectedMinimums)) {
    const actual = data.cantons[code]?.municipalities?.length || 0;
    if (actual < min) {
      errors.push(`Canton ${code}: expected ≥${min} municipalities, got ${actual}`);
    }
  }

  return errors;
}

// ─── Main ──────────────────────────────────────────────────────────────────

const useCached = process.argv.includes('--cached');

try {
  const csv = await fetchBfsSnapshot(useCached);
  const municipalitiesByCanton = parseBfsCsv(csv);
  const aliases = loadAliases();

  // Build output
  const output = {
    generatedAt: new Date().toISOString().split('T')[0],
    source: 'BFS AGV Communes API (www.agvchapp.bfs.admin.ch)',
    sourceUrl: BFS_API_URL,
    totalMunicipalities: Object.values(municipalitiesByCanton).reduce((sum, m) => sum + m.length, 0),
    cantons: {},
  };

  // All 26 cantons in alphabetical order
  const allCantonCodes = Object.keys(municipalitiesByCanton).sort();

  for (const code of allCantonCodes) {
    const municipalities = municipalitiesByCanton[code] || [];
    const cantonAliases = aliases[code] || [];

    output.cantons[code] = {
      municipalities,
      municipalityCount: municipalities.length,
      ...(cantonAliases.length > 0 ? { aliases: cantonAliases } : {}),
    };
  }

  // Validate
  const errors = validateOutput(output);
  if (errors.length > 0) {
    console.error('❌ Validation errors:');
    errors.forEach((e) => console.error(`   - ${e}`));

    // If we have a valid existing file, don't overwrite
    if (existsSync(OUTPUT_FILE)) {
      console.error('🛡️  Keeping existing file to avoid data loss');
      process.exit(1);
    }
  }

  // Never overwrite with obviously bad data
  if (output.totalMunicipalities < 2000) {
    console.error(`❌ Total municipalities (${output.totalMunicipalities}) below safety threshold (2000). Aborting.`);
    process.exit(1);
  }

  writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2) + '\n', 'utf8');

  console.log(`\n✅ Generated ${OUTPUT_FILE}`);
  console.log(`   Cantons: ${allCantonCodes.length}`);
  console.log(`   Total municipalities: ${output.totalMunicipalities}`);
  console.log(`   Top 5 by count:`);
  allCantonCodes
    .sort((a, b) => (municipalitiesByCanton[b]?.length || 0) - (municipalitiesByCanton[a]?.length || 0))
    .slice(0, 5)
    .forEach((c) => console.log(`     ${c}: ${municipalitiesByCanton[c].length}`));
} catch (err) {
  console.error(`❌ Fatal: ${err.message}`);
  process.exit(1);
}
