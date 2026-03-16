/**
 * Script to geocode Italian municipalities using Nominatim (OpenStreetMap).
 * Run with: npx tsx scripts/geocode-municipalities.ts
 * 
 * This script:
 * 1. Parses municipality data from BorderMunicipalitiesMap.tsx
 * 2. Geocodes each using Nominatim API (free, no API key needed)
 * 3. Outputs updated coordinates for manual review
 * 
 * Note: Nominatim has a 1 request/second rate limit.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Municipality {
  name: string;
  province: string;
  lat: number;
  lng: number;
}

// Parse municipalities from the component file
function parseMunicipalities(): Municipality[] {
  const filePath = path.join(__dirname, '../components/guide/BorderMunicipalitiesMap.tsx');
  const content = fs.readFileSync(filePath, 'utf-8');
  
  const regex = /\{\s*name:\s*['"]([^'"]+)['"],\s*province:\s*['"]([^'"]+)['"],\s*lat:\s*([\d.]+),\s*lng:\s*([\d.]+)/g;
  const municipalities: Municipality[] = [];
  
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    municipalities.push({
      name: match[1],
      province: match[2],
      lat: parseFloat(match[3]),
      lng: parseFloat(match[4]),
    });
  }
  
  return municipalities;
}

const MUNICIPALITIES = parseMunicipalities();

async function geocodeMunicipality(name: string, province: string): Promise<{ lat: number; lng: number } | null> {
  const query = encodeURIComponent(`${name}, ${province}, Lombardia, Italia`);
  const url = `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1&addressdetails=1`;
  
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'FrontaliereTicino/1.0 (geocoding script for municipality coordinates)',
      },
    });
    
    if (!response.ok) {
      console.error(`HTTP error for ${name}: ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    
    if (data && data.length > 0) {
      return {
        lat: parseFloat(data[0].lat),
        lng: parseFloat(data[0].lon),
      };
    }
    
    return null;
  } catch (error) {
    console.error(`Error geocoding ${name}:`, error);
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('Starting geocoding of municipalities...\n');
  console.log('Note: Using Nominatim (OpenStreetMap) with 1.5s delay between requests.\n');
  
  const results: Array<{
    name: string;
    province: string;
    oldLat: number;
    oldLng: number;
    newLat: number | null;
    newLng: number | null;
    diff: string;
  }> = [];
  
  for (let i = 0; i < MUNICIPALITIES.length; i++) {
    const mun = MUNICIPALITIES[i];
    console.log(`[${i + 1}/${MUNICIPALITIES.length}] Geocoding: ${mun.name} (${mun.province})...`);
    
    const newCoords = await geocodeMunicipality(mun.name, mun.province);
    
    if (newCoords) {
      const latDiff = Math.abs(newCoords.lat - mun.lat);
      const lngDiff = Math.abs(newCoords.lng - mun.lng);
      const diffKm = Math.sqrt(latDiff * latDiff + lngDiff * lngDiff) * 111; // Rough km estimate
      
      results.push({
        name: mun.name,
        province: mun.province,
        oldLat: mun.lat,
        oldLng: mun.lng,
        newLat: newCoords.lat,
        newLng: newCoords.lng,
        diff: diffKm > 0.5 ? `⚠️ ${diffKm.toFixed(2)} km` : `✅ OK`,
      });
      
      console.log(`  → Old: ${mun.lat}, ${mun.lng}`);
      console.log(`  → New: ${newCoords.lat}, ${newCoords.lng}`);
      console.log(`  → Diff: ${diffKm.toFixed(2)} km\n`);
    } else {
      results.push({
        name: mun.name,
        province: mun.province,
        oldLat: mun.lat,
        oldLng: mun.lng,
        newLat: null,
        newLng: null,
        diff: '❌ Not found',
      });
      console.log(`  → ❌ Could not geocode\n`);
    }
    
    // Rate limiting: 1.5 second delay between requests
    if (i < MUNICIPALITIES.length - 1) {
      await sleep(1500);
    }
  }
  
  // Print summary
  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80) + '\n');
  
  console.log('Municipalities with significant coordinate differences (> 0.5 km):');
  const needsUpdate = results.filter(r => r.diff.includes('⚠️'));
  
  if (needsUpdate.length === 0) {
    console.log('  None! All coordinates appear accurate.\n');
  } else {
    for (const r of needsUpdate) {
      console.log(`  ${r.name} (${r.province}): ${r.diff}`);
      console.log(`    Old: ${r.oldLat}, ${r.oldLng}`);
      console.log(`    New: ${r.newLat}, ${r.newLng}`);
    }
  }
  
  // Output updated data for copy-paste
  console.log('\n' + '='.repeat(80));
  console.log('UPDATED DATA (copy-paste ready):');
  console.log('='.repeat(80) + '\n');
  
  for (const r of results) {
    if (r.newLat !== null && r.newLng !== null) {
      console.log(`  { name: '${r.name}', province: '${r.province}', lat: ${r.newLat.toFixed(4)}, lng: ${r.newLng.toFixed(4)}, ... },`);
    }
  }
}

main().catch(console.error);
