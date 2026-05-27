#!/usr/bin/env node
/**
 * scripts/geocode-municipalities.mjs
 *
 * Parse comuni-frontiera.csv (522 border municipalities) and geocode
 * all entries using the Google Maps Geocoding API.
 *
 * Produces data/municipalities-geocoded.json as an intermediate cache,
 * then generates data/municipalities.ts with the full TypeScript array.
 *
 * Usage:
 *   GOOGLE_MAPS_API_KEY=xxx node scripts/geocode-municipalities.mjs
 *
 * If data/municipalities-geocoded.json already exists, previously geocoded
 * entries are reused (incremental mode).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CSV_PATH = path.join(ROOT, 'comuni-frontiera.csv');
const CACHE_PATH = path.join(ROOT, 'data', 'municipalities-geocoded.json');
const TS_OUTPUT = path.join(ROOT, 'data', 'municipalities.ts');

// ── Province lookup ──────────────────────────────────────────
// First 2 digits of the Italian ISTAT code → province abbreviation
const ISTAT_PREFIX_TO_PROVINCE = {
  '11': 'AO', // Aosta
  '13': 'VC', // Vercelli
  '20': 'MB', // Monza-Brianza
  '21': 'VA', // Varese
  '22': 'CO', // Como
  '23': 'SO', // Sondrio
  '24': 'BG', // Bergamo
  '25': 'BS', // Brescia
  '28': 'VB', // Verbano-Cusio-Ossola
  '38': 'TN', // Trento
  '39': 'BZ', // Bolzano
};

// ── Default addizionale IRPEF by province ────────────────────
const DEFAULT_IRPEF_BY_PROVINCE = {
  CO: 0.55, VA: 0.55, SO: 0.55, VB: 0.55, LC: 0.55,
  AO: 0.0,  // Valle d'Aosta: no addizionale regionale
  VC: 0.55, MB: 0.7, BG: 0.6, BS: 0.6, TN: 0.5, BZ: 0.5,
};

// ── Default rent by province (monthly, EUR) ──────────────────
const DEFAULT_RENT_BY_PROVINCE = {
  CO: 550, VA: 520, SO: 400, VB: 450, LC: 550,
  AO: 400, VC: 380, MB: 620, BG: 500, BS: 480, TN: 550, BZ: 600,
};

// ── Province full names for geocoding queries ────────────────
const PROVINCE_FULL = {
  CO: 'Como', VA: 'Varese', VB: 'Verbano-Cusio-Ossola', SO: 'Sondrio', LC: 'Lecco',
  AO: "Valle d'Aosta", VC: 'Vercelli', MB: 'Monza e Brianza', BG: 'Bergamo',
  BS: 'Brescia', TN: 'Trento', BZ: 'Bolzano',
};

// ── Google Maps Geocoding (primary) ──────────────────────────
const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const USE_GOOGLE = !!GOOGLE_API_KEY;
if (USE_GOOGLE) {
  console.log('🗺️  Using Google Maps Geocoding API (primary)');
} else {
  console.log('🗺️  No GOOGLE_MAPS_API_KEY — using OpenStreetMap Nominatim only');
}

async function geocodeGoogle(name, province) {
  if (!GOOGLE_API_KEY) return null;
  const provFull = PROVINCE_FULL[province] || province;
  const query = `${name}, ${provFull}, Italia`;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&region=it&language=it&key=${GOOGLE_API_KEY}`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === 'OK' && data.results.length > 0) {
      const loc = data.results[0].geometry.location;
      return { lat: Math.round(loc.lat * 10000) / 10000, lng: Math.round(loc.lng * 10000) / 10000, source: 'google' };
    }
  } catch (e) {
    // fall through to Nominatim
  }
  return null;
}

// ── Nominatim (OpenStreetMap) fallback ───────────────────────
async function geocodeNominatim(name, province) {
  const provFull = PROVINCE_FULL[province] || province;
  // Try 1: specific query with province
  const queries = [
    `${name}, ${provFull}, Italy`,
    `${name}, Italy`,
    `Comune di ${name}, Italy`,
  ];

  for (const q of queries) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&countrycodes=it&limit=1&accept-language=it`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'FrontaliereTicino/1.0 (geocode-municipalities)' },
      });
      const data = await res.json();
      if (data.length > 0) {
        return {
          lat: Math.round(parseFloat(data[0].lat) * 10000) / 10000,
          lng: Math.round(parseFloat(data[0].lon) * 10000) / 10000,
          source: 'nominatim',
        };
      }
    } catch (e) {
      // try next query
    }
    // Nominatim rate limit: max 1 req/sec
    await new Promise(r => setTimeout(r, 1100));
  }
  return null;
}

// ── Combined geocoder ────────────────────────────────────────
async function geocode(name, province) {
  // Try Google first (if key available)
  const google = await geocodeGoogle(name, province);
  if (google) return google;

  // Fallback to Nominatim
  const nom = await geocodeNominatim(name, province);
  if (nom) return nom;

  console.warn(`  ⚠️ Could not geocode: ${name} (${province})`);
  return null;
}

// ── Parse CSV ────────────────────────────────────────────────
function parseCSV() {
  const raw = fs.readFileSync(CSV_PATH, 'utf-8');
  const lines = raw.split('\n');
  const entries = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // CSV fields: NAP, Località, Inizio, Fine, Fascia1, Fascia1A
    const parts = line.split(',');
    if (parts.length < 6) continue;

    const nap = parts[0].trim();
    const name = parts[1].trim();
    if (!nap || !name || !/^\d+$/.test(nap)) continue;

    // Skip footer lines
    if (name.startsWith('Comuni nella fascia')) continue;

    const prefix = nap.substring(0, 2);
    const province = ISTAT_PREFIX_TO_PROVINCE[prefix];
    if (!province) {
      console.warn(`  ⚠️ Unknown ISTAT prefix ${prefix} for ${name} (NAP: ${nap})`);
      continue;
    }

    const hasFascia1 = parts[4].toLowerCase().includes('x');
    const hasFascia1A = parts[5].toLowerCase().includes('x');

    // Determine fascia: if only Fascia 1 → '1', if both → '1' (qualifies for both)
    // The CSV doesn't have Fascia 2 — that was manually assigned to distant comuni
    // We'll determine fascia based on distance later: >20km → '1A' if hasFascia1A, else '1'
    const fascia = hasFascia1A ? '1A' : '1';

    // Title-case the name
    const titleName = name
      .split(/\s+/)
      .map(w => {
        const lower = w.toLowerCase();
        // Keep small Italian prepositions/articles lowercase (except at start)
        if (['di', 'del', 'della', 'delle', 'dei', 'degli', 'da', 'con', 'sul', 'sulla', 'sulle', 'in', 'al', 'alla', 'alle', 'e', 'ed'].includes(lower)) {
          return lower;
        }
        // Handle apostrophes: D'ITALIA → d'Italia
        if (lower.includes("'")) {
          const parts = lower.split("'");
          return parts.map((p, i) => i === 0 && p.length <= 2 ? p : p.charAt(0).toUpperCase() + p.slice(1)).join("'");
        }
        // Handle hyphens: SAINT-ANDRÉ → Saint-André
        if (lower.includes('-')) {
          return lower.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('-');
        }
        return lower.charAt(0).toUpperCase() + lower.slice(1);
      })
      .join(' ');

    // Capitalize first word always
    const finalName = titleName.charAt(0).toUpperCase() + titleName.slice(1);

    entries.push({
      nap,
      name: finalName,
      province,
      hasFascia1,
      hasFascia1A,
      fascia,
    });
  }

  return entries;
}

// ── Estimate distance from Swiss border ──────────────────────
// Approximate Swiss border points for distance estimation
const SWISS_BORDER_POINTS = [
  // Chiasso area
  { lat: 45.8350, lng: 9.0300 },
  // Ponte Tresa
  { lat: 45.9680, lng: 8.8600 },
  // Luino/Zenna
  { lat: 46.0100, lng: 8.7500 },
  // Gandria
  { lat: 46.0050, lng: 9.0000 },
  // Sempione
  { lat: 46.2500, lng: 8.0000 },
  // Splügen
  { lat: 46.4800, lng: 9.3200 },
  // Campocologno
  { lat: 46.2500, lng: 10.0800 },
  // Brissago
  { lat: 46.0800, lng: 8.7100 },
  // Livigno
  { lat: 46.5400, lng: 10.1400 },
  // Gran San Bernardo (for AO)
  { lat: 45.8700, lng: 7.1700 },
  // Piccolo San Bernardo
  { lat: 45.6800, lng: 6.8800 },
  // Stelvio (for BZ/TN)
  { lat: 46.5300, lng: 10.4500 },
];

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function estimateDistanceFromBorder(lat, lng) {
  let min = Infinity;
  for (const bp of SWISS_BORDER_POINTS) {
    const d = haversineKm(lat, lng, bp.lat, bp.lng);
    if (d < min) min = d;
  }
  return Math.round(min);
}

// ── Estimate population (rough, by province capital size) ────
function estimatePopulation(name, province) {
  // Known large cities
  const KNOWN = {
    'Aosta': 34000, 'Varese': 80000, 'Como': 84000, 'Sondrio': 21500,
    'Verbania': 30000, 'Lecco': 48000, 'Domodossola': 18000, 'Luino': 14200,
    'Busto Arsizio': 84000, 'Gallarate': 54000, 'Saronno': 39000,
    'Cantù': 40000, 'Erba': 16500, 'Mariano Comense': 24000,
    'Bolzano': 108000, 'Merano': 42000, 'Trento': 120000,
    'Monza': 124000, 'Seregno': 45000, 'Giussano': 25000,
    'Merate': 15100, 'Bormio': 4100, 'Chiavenna': 7200,
    'Tirano': 9100, 'Livigno': 6700, 'Stresa': 5000,
    'Omegna': 15700, 'Baveno': 5000, 'Cannobio': 5100,
  };
  if (KNOWN[name]) return KNOWN[name];
  // Default small municipality
  return 2000;
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  console.log('📋 Parsing comuni-frontiera.csv...');
  const entries = parseCSV();
  console.log(`   Found ${entries.length} municipalities`);

  // Load cache
  let cache = {};
  if (fs.existsSync(CACHE_PATH)) {
    cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    console.log(`📦 Loaded ${Object.keys(cache).length} cached geocoded entries`);
  }

  // Also load existing municipalities.ts data for known values
  const existingTS = path.join(ROOT, 'data', 'municipalities.ts');
  const existingData = {};
  if (fs.existsSync(existingTS)) {
    const tsContent = fs.readFileSync(existingTS, 'utf-8');
    // Extract entries with regex
    const re = /\{\s*name:\s*'([^']+)',\s*province:\s*'([^']+)',\s*lat:\s*([\d.]+),\s*lng:\s*([\d.]+),\s*irpefAddizionale:\s*([\d.]+),\s*distanceKm:\s*(\d+),\s*avgRentMonthly:\s*(\d+),\s*population:\s*(\d+),\s*fascia:\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(tsContent)) !== null) {
      existingData[m[1]] = {
        lat: parseFloat(m[3]),
        lng: parseFloat(m[4]),
        irpefAddizionale: parseFloat(m[5]),
        distanceKm: parseInt(m[6]),
        avgRentMonthly: parseInt(m[7]),
        population: parseInt(m[8]),
        fascia: m[9],
      };
    }
    console.log(`📝 Found ${Object.keys(existingData).length} entries in existing municipalities.ts`);
  }

  // Geocode missing entries
  let geocoded = 0;
  let skipped = 0;
  let failed = 0;
  const results = [];

  for (const entry of entries) {
    const cacheKey = `${entry.name}|${entry.province}`;

    // Check if we have coordinates from cache or existing TS
    let coords = cache[cacheKey];
    if (!coords && existingData[entry.name]) {
      coords = { lat: existingData[entry.name].lat, lng: existingData[entry.name].lng };
    }

    if (coords) {
      skipped++;
    } else {
      // Geocode with Google Maps + Nominatim fallback
      coords = await geocode(entry.name, entry.province);
      if (coords) {
        cache[cacheKey] = { lat: coords.lat, lng: coords.lng };
        geocoded++;
        if (coords.source === 'google') {
          // Google rate limit: 50 req/sec
          await new Promise(r => setTimeout(r, 50));
        }
        // Nominatim already has built-in 1.1s delay
      } else {
        failed++;
        continue;
      }

      // Save cache every 50 geocoded entries
      if (geocoded % 50 === 0) {
        fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
        console.log(`   💾 Cache saved (${geocoded} geocoded so far)`);
      }
    }

    // Use existing data for populated fields if available
    const existing = existingData[entry.name];
    const distanceKm = existing?.distanceKm ?? estimateDistanceFromBorder(coords.lat, coords.lng);
    const population = existing?.population ?? estimatePopulation(entry.name, entry.province);
    const irpefAddizionale = existing?.irpefAddizionale ?? (DEFAULT_IRPEF_BY_PROVINCE[entry.province] ?? 0.55);
    const avgRentMonthly = existing?.avgRentMonthly ?? (DEFAULT_RENT_BY_PROVINCE[entry.province] ?? 500);

    // Determine fascia: use existing if available, otherwise from CSV + distance
    let fascia = existing?.fascia;
    if (!fascia) {
      if (entry.hasFascia1A) {
        fascia = distanceKm > 20 ? '1A' : '1';
      } else {
        fascia = '1';
      }
    }

    results.push({
      name: entry.name,
      province: entry.province,
      lat: coords.lat,
      lng: coords.lng,
      irpefAddizionale,
      distanceKm,
      avgRentMonthly,
      population,
      fascia,
      hasFascia1: entry.hasFascia1,
      hasFascia1A: entry.hasFascia1A,
    });
  }

  // Save final cache
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  console.log(`\n✅ Geocoding complete: ${geocoded} new, ${skipped} cached, ${failed} failed`);
  console.log(`   Total: ${results.length} municipalities`);

  // ── Generate TypeScript file ─────────────────────────────
  // Group by province for readability
  const byProvince = {};
  for (const r of results) {
    if (!byProvince[r.province]) byProvince[r.province] = [];
    byProvince[r.province].push(r);
  }

  // Sort provinces, then sort municipalities within each province by name
  const provinceOrder = ['CO', 'VA', 'VB', 'SO', 'LC', 'AO', 'VC', 'MB', 'BG', 'BS', 'TN', 'BZ'];
  const provinceFullNames = {
    CO: 'Como', VA: 'Varese', VB: 'Verbano-Cusio-Ossola', SO: 'Sondrio', LC: 'Lecco',
    AO: 'Aosta', VC: 'Vercelli', MB: 'Monza e Brianza', BG: 'Bergamo', BS: 'Brescia',
    TN: 'Trento', BZ: 'Bolzano',
  };

  let tsEntries = '';
  for (const prov of provinceOrder) {
    const grupo = byProvince[prov];
    if (!grupo || grupo.length === 0) continue;
    grupo.sort((a, b) => a.name.localeCompare(b.name, 'it'));
    tsEntries += `  // ── ${provinceFullNames[prov] || prov} (${prov}) — ${grupo.length} comuni ──\n`;
    for (const m of grupo) {
      const nameEsc = m.name.replace(/'/g, "\\'");
      tsEntries += `  { name: '${nameEsc}', province: '${m.province}', lat: ${m.lat}, lng: ${m.lng}, irpefAddizionale: ${m.irpefAddizionale}, distanceKm: ${m.distanceKm}, avgRentMonthly: ${m.avgRentMonthly}, population: ${m.population}, fascia: '${m.fascia}' },\n`;
    }
  }

  const tsContent = `/**
 * Shared municipality data for Italian border municipalities (comuni di frontiera).
 *
 * Source: comuni-frontiera.csv — official list from ti.ch/fonte (2024)
 * Coordinates: Google Maps Geocoding API
 *
 * Total: ${results.length} municipalities across ${Object.keys(byProvince).length} provinces
 * Generated: ${new Date().toISOString().slice(0, 10)}
 */

export interface Municipality {
  name: string;
  province: string;
  lat: number;
  lng: number;
  irpefAddizionale: number;
  distanceKm: number;
  avgRentMonthly: number;
  population: number;
  fascia: '1' | '1A' | '2';
}

/** All Italian border municipalities — official ti.ch list. */
export const MUNICIPALITIES: Municipality[] = [
${tsEntries}];

/** Get all municipality names (for autocomplete). */
export function getMunicipalityNames(): string[] {
  return MUNICIPALITIES.map(m => \`\${m.name} (\${m.province})\`);
}

/** Find a municipality by name (case-insensitive, ignoring province suffix). */
export function findMunicipality(name: string): Municipality | undefined {
  const clean = name.replace(/\\s*\\(.*\\)$/, '').trim().toLowerCase();
  return MUNICIPALITIES.find(m => m.name.toLowerCase() === clean);
}
`;

  fs.writeFileSync(TS_OUTPUT, tsContent);
  console.log(`\n📝 Generated ${TS_OUTPUT}`);
  console.log(`   ${results.length} municipalities across ${Object.keys(byProvince).length} provinces`);

  // Print province summary
  console.log('\n📊 Province summary:');
  for (const prov of provinceOrder) {
    const n = byProvince[prov]?.length ?? 0;
    if (n > 0) console.log(`   ${prov} (${provinceFullNames[prov]}): ${n}`);
  }
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
