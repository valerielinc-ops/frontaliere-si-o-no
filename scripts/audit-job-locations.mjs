#!/usr/bin/env node
/**
 * Audit all job locations against BFS municipality data + Nominatim geocoding.
 *
 * Layers:
 *   1. BFS check — is the city a known Swiss municipality? What canton?
 *   2. inferAnyCanton — does our location engine agree with the stored canton?
 *   3. Nominatim — for cities not in BFS, verify country via geocoding
 *
 * Output: structured report of mismatches grouped by severity.
 *
 * Usage: node scripts/audit-job-locations.mjs [--geocode] [--limit N]
 *   --geocode   Enable Nominatim lookups for unknown cities (slow, 1 req/sec)
 *   --limit N   Only audit the first N jobs
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  isKnownSwissMunicipality,
  inferAnyCanton,
  isCantonRelevant,
} from './lib/target-swiss-locations.mjs';
import { isLocationExplicitlyForeign, geocodeCountry } from './lib/dedicated-crawler-common.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/* ── Args ──────────────────────────────────────────────────── */
const args = process.argv.slice(2);
const enableGeocode = args.includes('--geocode');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;

/* ── Load jobs ─────────────────────────────────────────────── */
const jobs = JSON.parse(readFileSync(join(ROOT, 'data', 'jobs.json'), 'utf8'));
console.log(`\n📋 Total jobs in dataset: ${jobs.length}`);
console.log(`   Auditing: ${Math.min(jobs.length, limit)} jobs`);
console.log(`   Geocoding: ${enableGeocode ? 'ENABLED (slow — 1 req/sec)' : 'DISABLED (use --geocode to enable)'}\n`);

/* ── Categories ────────────────────────────────────────────── */
const results = {
  correct: [],           // BFS confirms city is in stated canton
  cantonMismatch: [],    // BFS says different canton than stored
  foreignInSwiss: [],    // City is foreign but tagged as Swiss canton
  unknownCity: [],       // City not in BFS, not obviously foreign — needs geocoding
  emptyLocation: [],     // No city/location data
  lowercaseCanton: [],   // Canton code is lowercase (data quality)
  geocodeResults: [],    // Results from Nominatim verification
};

/* ── Geocode cache to avoid duplicate lookups ──────────────── */
const geocodeCache = new Map();

async function cachedGeocode(city) {
  if (geocodeCache.has(city)) return geocodeCache.get(city);
  const result = await geocodeCountry(city);
  geocodeCache.set(city, result);
  // Rate limit: 1 req/sec for Nominatim
  await new Promise((r) => setTimeout(r, 1100));
  return result;
}

/* ── Normalize ─────────────────────────────────────────────── */
function norm(v = '') {
  return String(v || '').trim();
}

/* ── Audit each job ────────────────────────────────────────── */
const jobsToAudit = jobs.slice(0, limit);
let processed = 0;

for (const job of jobsToAudit) {
  processed++;
  if (processed % 500 === 0) {
    console.log(`   ... processed ${processed}/${jobsToAudit.length}`);
  }

  const city = norm(job.addressLocality || job.location || '');
  const storedCanton = norm(job.canton || '');
  const company = norm(job.company || job.companyKey || '');
  const id = job.id || job.slug || '?';

  // Data quality: lowercase canton
  if (storedCanton && storedCanton !== storedCanton.toUpperCase()) {
    results.lowercaseCanton.push({
      id, company, city, storedCanton,
      fix: storedCanton.toUpperCase(),
    });
  }

  const cantonUpper = storedCanton.toUpperCase();

  // Empty location
  if (!city || city === 'CH' || city.length < 2) {
    results.emptyLocation.push({ id, company, city, storedCanton });
    continue;
  }

  // Check 1: Is city a known Swiss municipality?
  const isSwiss = isKnownSwissMunicipality(city);

  // Check 2: What canton does our engine infer?
  const inferredCanton = inferAnyCanton(city);

  // Check 3: Is the city explicitly foreign?
  const isForeign = isLocationExplicitlyForeign(city);

  if (isSwiss && inferredCanton) {
    // BFS knows this city
    if (inferredCanton === cantonUpper) {
      results.correct.push({ id, company, city, storedCanton });
    } else if (!cantonUpper) {
      // No canton stored but we know it
      results.cantonMismatch.push({
        id, company, city, storedCanton: '(empty)',
        inferredCanton,
        severity: 'missing',
      });
    } else {
      // Canton mismatch
      results.cantonMismatch.push({
        id, company, city, storedCanton: cantonUpper,
        inferredCanton,
        severity: 'wrong',
      });
    }
  } else if (isForeign && cantonUpper) {
    // Foreign city tagged with a Swiss canton
    results.foreignInSwiss.push({
      id, company, city, storedCanton: cantonUpper,
    });
  } else if (isForeign && !cantonUpper) {
    // Foreign city correctly has no canton — correct
    results.correct.push({ id, company, city, storedCanton: '(none — foreign)' });
  } else if (!isSwiss && !isForeign) {
    // Unknown city — not in BFS, not in foreign list
    if (enableGeocode) {
      // Verify via Nominatim
      const countryCode = await cachedGeocode(city);
      const entry = {
        id, company, city, storedCanton: cantonUpper || '(empty)',
        geocodeCountry: countryCode || 'UNKNOWN',
      };

      if (countryCode === 'ch') {
        // Nominatim says Swiss — probably a small locality or alias not in BFS
        entry.verdict = 'swiss-not-in-bfs';
      } else if (countryCode && countryCode !== 'ch') {
        entry.verdict = cantonUpper ? 'FOREIGN-TAGGED-SWISS' : 'foreign-correct';
      } else {
        entry.verdict = 'geocode-failed';
      }
      results.geocodeResults.push(entry);
    } else {
      results.unknownCity.push({
        id, company, city, storedCanton: cantonUpper || '(empty)',
      });
    }
  } else if (isSwiss && !inferredCanton) {
    // BFS has it but inferAnyCanton didn't match — edge case
    results.unknownCity.push({
      id, company, city, storedCanton: cantonUpper || '(empty)',
      note: 'in BFS but inferAnyCanton returned empty',
    });
  } else {
    // Catch-all
    results.correct.push({ id, company, city, storedCanton });
  }
}

/* ── Report ────────────────────────────────────────────────── */
console.log('\n' + '═'.repeat(70));
console.log('  LOCATION AUDIT REPORT');
console.log('═'.repeat(70));

console.log(`\n✅ Correct:              ${results.correct.length}`);
console.log(`⚠️  Canton mismatch:      ${results.cantonMismatch.length}`);
console.log(`🚨 Foreign in Swiss:      ${results.foreignInSwiss.length}`);
console.log(`❓ Unknown city:          ${results.unknownCity.length}`);
console.log(`📭 Empty location:        ${results.emptyLocation.length}`);
console.log(`🔤 Lowercase canton:      ${results.lowercaseCanton.length}`);
if (enableGeocode) {
  console.log(`🌍 Geocode results:       ${results.geocodeResults.length}`);
}

// Detail: Canton mismatches
if (results.cantonMismatch.length > 0) {
  console.log('\n' + '─'.repeat(70));
  console.log('⚠️  CANTON MISMATCHES');
  console.log('─'.repeat(70));
  for (const m of results.cantonMismatch) {
    console.log(`  ${m.company.padEnd(30)} ${m.city.padEnd(25)} stored=${m.storedCanton.padEnd(4)} inferred=${m.inferredCanton} [${m.severity}]`);
  }
}

// Detail: Foreign cities tagged as Swiss
if (results.foreignInSwiss.length > 0) {
  console.log('\n' + '─'.repeat(70));
  console.log('🚨 FOREIGN CITIES TAGGED AS SWISS CANTON');
  console.log('─'.repeat(70));
  // Group by company
  const byCompany = {};
  for (const f of results.foreignInSwiss) {
    if (!byCompany[f.company]) byCompany[f.company] = [];
    byCompany[f.company].push(f);
  }
  for (const [company, items] of Object.entries(byCompany)) {
    console.log(`\n  ${company} (${items.length} jobs):`);
    // Group by city
    const byCityMap = {};
    for (const item of items) {
      const key = `${item.city} → ${item.storedCanton}`;
      byCityMap[key] = (byCityMap[key] || 0) + 1;
    }
    for (const [cityInfo, count] of Object.entries(byCityMap)) {
      console.log(`    ${cityInfo} (${count} jobs)`);
    }
  }
}

// Detail: Unknown cities
if (results.unknownCity.length > 0) {
  console.log('\n' + '─'.repeat(70));
  console.log('❓ UNKNOWN CITIES (not in BFS, not in foreign list)');
  console.log('─'.repeat(70));
  // Deduplicate by city name
  const uniqueCities = new Map();
  for (const u of results.unknownCity) {
    const key = u.city.toLowerCase();
    if (!uniqueCities.has(key)) {
      uniqueCities.set(key, { ...u, count: 1 });
    } else {
      uniqueCities.get(key).count++;
    }
  }
  const sorted = [...uniqueCities.values()].sort((a, b) => b.count - a.count);
  for (const u of sorted) {
    const note = u.note ? ` [${u.note}]` : '';
    console.log(`  ${u.city.padEnd(30)} canton=${u.storedCanton.padEnd(4)} company=${u.company.padEnd(25)} ×${u.count}${note}`);
  }
}

// Detail: Geocode results
if (enableGeocode && results.geocodeResults.length > 0) {
  console.log('\n' + '─'.repeat(70));
  console.log('🌍 GEOCODE VERIFICATION RESULTS');
  console.log('─'.repeat(70));
  const foreignTaggedSwiss = results.geocodeResults.filter((r) => r.verdict === 'FOREIGN-TAGGED-SWISS');
  const swissNotBfs = results.geocodeResults.filter((r) => r.verdict === 'swiss-not-in-bfs');
  const foreignCorrect = results.geocodeResults.filter((r) => r.verdict === 'foreign-correct');
  const failed = results.geocodeResults.filter((r) => r.verdict === 'geocode-failed');

  if (foreignTaggedSwiss.length > 0) {
    console.log(`\n  🚨 Foreign cities incorrectly tagged as Swiss (${foreignTaggedSwiss.length}):`);
    for (const r of foreignTaggedSwiss) {
      console.log(`    ${r.city.padEnd(25)} country=${r.geocodeCountry.toUpperCase().padEnd(4)} stored_canton=${r.storedCanton} (${r.company})`);
    }
  }
  if (swissNotBfs.length > 0) {
    console.log(`\n  ℹ️  Swiss cities not in BFS data (${swissNotBfs.length}):`);
    for (const r of swissNotBfs) {
      console.log(`    ${r.city.padEnd(25)} canton=${r.storedCanton} (${r.company})`);
    }
  }
  if (foreignCorrect.length > 0) {
    console.log(`\n  ✅ Foreign cities correctly tagged (${foreignCorrect.length}):`);
    for (const r of foreignCorrect) {
      console.log(`    ${r.city.padEnd(25)} country=${r.geocodeCountry.toUpperCase()}`);
    }
  }
  if (failed.length > 0) {
    console.log(`\n  ⚠️  Geocode failed (${failed.length}):`);
    for (const r of failed) {
      console.log(`    ${r.city.padEnd(25)} canton=${r.storedCanton} (${r.company})`);
    }
  }
}

// Detail: Lowercase cantons
if (results.lowercaseCanton.length > 0) {
  console.log('\n' + '─'.repeat(70));
  console.log('🔤 LOWERCASE CANTON CODES');
  console.log('─'.repeat(70));
  for (const l of results.lowercaseCanton) {
    console.log(`  ${l.company.padEnd(30)} ${l.city.padEnd(25)} "${l.storedCanton}" → "${l.fix}"`);
  }
}

// Detail: Empty locations
if (results.emptyLocation.length > 0) {
  console.log('\n' + '─'.repeat(70));
  console.log(`📭 EMPTY/MISSING LOCATIONS (${results.emptyLocation.length})`);
  console.log('─'.repeat(70));
  const byCompany = {};
  for (const e of results.emptyLocation) {
    const c = e.company || 'unknown';
    byCompany[c] = (byCompany[c] || 0) + 1;
  }
  for (const [company, count] of Object.entries(byCompany).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${company.padEnd(40)} ${count} jobs`);
  }
}

console.log('\n' + '═'.repeat(70));

// Save detailed results to JSON for further analysis
const reportPath = join(ROOT, 'data', 'location-audit-report.json');
writeFileSync(reportPath, JSON.stringify({
  timestamp: new Date().toISOString(),
  totalJobs: jobs.length,
  audited: jobsToAudit.length,
  geocodingEnabled: enableGeocode,
  summary: {
    correct: results.correct.length,
    cantonMismatch: results.cantonMismatch.length,
    foreignInSwiss: results.foreignInSwiss.length,
    unknownCity: results.unknownCity.length,
    emptyLocation: results.emptyLocation.length,
    lowercaseCanton: results.lowercaseCanton.length,
    geocodeResults: results.geocodeResults.length,
  },
  cantonMismatches: results.cantonMismatch,
  foreignInSwiss: results.foreignInSwiss,
  unknownCities: results.unknownCity,
  emptyLocations: results.emptyLocation,
  lowercaseCantons: results.lowercaseCanton,
  geocodeResults: results.geocodeResults,
}, null, 2));
console.log(`\n📄 Detailed report saved to: data/location-audit-report.json\n`);
