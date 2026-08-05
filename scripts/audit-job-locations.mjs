#!/usr/bin/env node
/**
 * Audit all job locations against BFS municipality data + Nominatim geocoding.
 *
 * Layers:
 *   1. BFS check — is the city a known Swiss municipality? What canton?
 *   2. inferAnyCanton — does our location engine agree with the stored canton?
 *   3. Crawler-vs-dataset — does the published canton still match the canton the
 *      crawler recorded in `data/jobs/by-crawler/<key>.json`?
 *   4. Nominatim — for cities not in BFS, verify country via geocoding
 *
 * Layer 3 exists because layers 1-2 are BFS-only and are therefore BLIND to the
 * largest mislabel class this audit is supposed to catch. A job in a hamlet BFS
 * does not list as a municipality (Obbürgen, NW — Bürgenstock Hotels AG, #4838)
 * lands in `unknownCity`, where a wrong canton is indistinguishable from a
 * merely unrecognised one: 28 of 39 Bürgenstock postings shipped `canton="TI"`
 * for months while every weekly snapshot reported 0 problems for them. Comparing
 * the published canton against the crawler's own record needs no municipality
 * database, so it catches exactly the cases BFS cannot adjudicate.
 *
 * Usage: node scripts/audit-job-locations.mjs [--geocode] [--limit N]
 *   --geocode   Enable Nominatim lookups for unknown cities (slow, 1 req/sec)
 *   --limit N   Only audit the first N jobs
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  isKnownSwissMunicipality,
  inferAnyCanton,
  isCantonRelevant,
} from './lib/target-swiss-locations.mjs';
import { buildStableJobIdentity } from './lib/job-identity.mjs';
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
  unknownCity: [],       // City not in BFS, not obviously foreign — needs geocoding (= "custom" location)
  emptyLocation: [],     // No city/location data
  lowercaseCanton: [],   // Canton code is lowercase (data quality)
  geocodeResults: [],    // Results from Nominatim verification
  companyDefaultFallback: [], // cantonMismatch subset where stored canton == company's modal canton
  crawlerCantonOverridden: [], // published canton != canton the crawler recorded (BFS-independent)
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

/* ── Crawler-recorded canton index ────────────────────────────
 * `data/jobs/by-crawler/<key>.json` is what each crawler actually wrote for a
 * posting, before any assemble-time inference or pin-ledger reconciliation.
 * Keyed by the same stable identity the pin ledger uses, so a divergence here
 * means the published dataset overrode the crawler — the #4838 signature.
 * Missing directory (fresh clone / sparse checkout) simply disables layer 3
 * rather than failing the audit. */
function loadCrawlerCantons() {
  const dir = join(ROOT, 'data', 'jobs', 'by-crawler');
  const index = new Map();
  if (!existsSync(dir)) return index;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    let doc;
    try { doc = JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch { continue; }
    const slice = Array.isArray(doc) ? doc : (doc.jobs || []);
    for (const job of slice) {
      if (!job || typeof job !== 'object') continue;
      const canton = norm(job.canton).toUpperCase();
      if (!canton) continue;
      const id = buildStableJobIdentity(job);
      if (id) index.set(id, canton);
    }
  }
  return index;
}
const crawlerCantonById = loadCrawlerCantons();

/* ── Pass 0: per-company modal canton ─────────────────────────
 * Empirical proxy for "this company's HQ/default canton" — the most
 * frequent stored canton across all of a company's jobs. Derived from the
 * dataset itself rather than a hand-maintained per-company dict, so it
 * can't drift into the hardcoded-dict sibling-bug class fixed elsewhere in
 * this audit (AGENTS.md #6). Used below to flag canton mismatches that
 * look like a parser silently falling back to the company default instead
 * of the job's real location. */
const jobsToAudit = jobs.slice(0, limit);
const companyCantonTally = new Map();
for (const job of jobsToAudit) {
  const company = norm(job.company || job.companyKey || '');
  const canton = norm(job.canton || '').toUpperCase();
  if (!company || !canton) continue;
  if (!companyCantonTally.has(company)) companyCantonTally.set(company, new Map());
  const tally = companyCantonTally.get(company);
  tally.set(canton, (tally.get(canton) || 0) + 1);
}
const companyModalCanton = new Map();
for (const [company, tally] of companyCantonTally) {
  let best = '';
  let bestCount = 0;
  for (const [canton, count] of tally) {
    if (count > bestCount) {
      best = canton;
      bestCount = count;
    }
  }
  companyModalCanton.set(company, best);
}

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

  // Layer 3: the published canton contradicts the canton the crawler recorded.
  // BFS-independent, so it fires for hamlets/resorts/"Remote" placeholders that
  // layers 1-2 can only file under "unknown city". Runs before the empty-location
  // `continue` so a job with no city text is still checked.
  const crawlerCanton = crawlerCantonById.get(buildStableJobIdentity(job) || '');
  if (crawlerCanton && cantonUpper && crawlerCanton !== cantonUpper) {
    results.crawlerCantonOverridden.push({
      id, company, city: city || '(empty)',
      storedCanton: cantonUpper,
      crawlerCanton,
      inferredCanton: city ? inferAnyCanton(city) || '(none)' : '(none)',
    });
  }

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

// Subset of cantonMismatch where the stored (wrong) canton equals this
// company's modal canton — i.e. the job's real location (per the city text)
// is elsewhere, but the record carries the company's typical/HQ value. That
// pattern is the signature of a parser silently defaulting instead of
// resolving the actual crawled location (the "custom value" bug the location
// mapping fix in this PR targets).
results.companyDefaultFallback = results.cantonMismatch.filter((m) => {
  const modalCanton = companyModalCanton.get(m.company) || '';
  return modalCanton && m.storedCanton === modalCanton && m.inferredCanton !== modalCanton;
});

/* ── Report ────────────────────────────────────────────────── */
console.log('\n' + '═'.repeat(70));
console.log('  LOCATION AUDIT REPORT');
console.log('═'.repeat(70));

console.log(`\n✅ Correct:              ${results.correct.length}`);
console.log(`⚠️  Canton mismatch:      ${results.cantonMismatch.length}`);
console.log(`🚨 Foreign in Swiss:      ${results.foreignInSwiss.length}`);
console.log(`❓ Unknown city (custom): ${results.unknownCity.length}`);
console.log(`📭 Empty location:        ${results.emptyLocation.length}`);
console.log(`🔤 Lowercase canton:      ${results.lowercaseCanton.length}`);
console.log(`🏢 Company-default fallback (suspected): ${results.companyDefaultFallback.length}`);
console.log(`📌 Crawler canton overridden by dataset: ${results.crawlerCantonOverridden.length}${crawlerCantonById.size ? '' : ' (by-crawler slices unavailable — check skipped)'}`);
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

// Detail: Suspected company-default fallbacks
if (results.companyDefaultFallback.length > 0) {
  console.log('\n' + '─'.repeat(70));
  console.log('🏢 SUSPECTED COMPANY-DEFAULT FALLBACKS');
  console.log('─'.repeat(70));
  for (const m of results.companyDefaultFallback) {
    console.log(`  ${m.company.padEnd(30)} ${m.city.padEnd(25)} stored=${m.storedCanton.padEnd(4)} (company modal) inferred=${m.inferredCanton}`);
  }
}

// Detail: Crawler canton overridden by the assembled dataset
if (results.crawlerCantonOverridden.length > 0) {
  console.log('\n' + '─'.repeat(70));
  console.log('📌 PUBLISHED CANTON CONTRADICTS THE CRAWLER RECORD');
  console.log('─'.repeat(70));
  const byCompany = {};
  for (const o of results.crawlerCantonOverridden) {
    const key = `${o.company} — crawler=${o.crawlerCanton} → published=${o.storedCanton} (city="${o.city}", BFS=${o.inferredCanton})`;
    byCompany[key] = (byCompany[key] || 0) + 1;
  }
  for (const [key, count] of Object.entries(byCompany).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count.toString().padStart(4)} × ${key}`);
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
    customLocation: results.unknownCity.length, // alias: city matches no canonical Swiss location
    emptyLocation: results.emptyLocation.length,
    lowercaseCanton: results.lowercaseCanton.length,
    companyDefaultFallback: results.companyDefaultFallback.length,
    crawlerCantonOverridden: results.crawlerCantonOverridden.length,
    geocodeResults: results.geocodeResults.length,
  },
  crawlerRecordsIndexed: crawlerCantonById.size,
  cantonMismatches: results.cantonMismatch,
  foreignInSwiss: results.foreignInSwiss,
  unknownCities: results.unknownCity,
  emptyLocations: results.emptyLocation,
  lowercaseCantons: results.lowercaseCanton,
  companyDefaultFallback: results.companyDefaultFallback,
  crawlerCantonOverridden: results.crawlerCantonOverridden,
  geocodeResults: results.geocodeResults,
}, null, 2));
console.log(`\n📄 Detailed report saved to: data/location-audit-report.json\n`);
