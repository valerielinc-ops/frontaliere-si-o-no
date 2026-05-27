#!/usr/bin/env node
/**
 * One-time repair script: fix canton assignments in all crawler slices.
 *
 * For each job in each slice:
 *   1. Parse the city from addressLocality / location
 *   2. Check against BFS municipalities (inferAnyCanton)
 *   3. If BFS returns a different canton → fix it
 *   4. If city is explicitly foreign → clear canton + set addressCountry = ''
 *   5. Skip unparseable locations (street addresses, HTML fragments, etc.)
 *
 * Usage:
 *   node scripts/repair-job-locations.mjs           # dry run (report only)
 *   node scripts/repair-job-locations.mjs --apply    # apply fixes to slices
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  isKnownSwissMunicipality,
  inferAnyCanton,
} from './lib/target-swiss-locations.mjs';
import { isLocationExplicitlyForeign } from './lib/dedicated-crawler-common.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SLICES_DIR = join(__dirname, '..', 'data', 'jobs', 'by-crawler');
const apply = process.argv.includes('--apply');

console.log(`\n🔧 Job Location Repair Script`);
console.log(`   Mode: ${apply ? 'APPLY (writing changes)' : 'DRY RUN (report only)'}`);
console.log(`   Slices dir: ${SLICES_DIR}\n`);

/* ── Helpers ─────────────────────────────────────────────── */

function norm(v = '') {
  return String(v || '').trim();
}

/** Detect if a location string is actually a street address, PO box, or garbage */
function isUnparseableLocation(city) {
  if (!city || city.length < 2) return true;
  // Street addresses end with numbers
  if (/\d+\s*$/.test(city) && /strasse|weg|gasse|platz|rue|via|chemin/i.test(city)) return true;
  // PO Box / Postfach / CP
  if (/^postfach\b|^p\.?\s*o\.?\s*box\b|^casella\b|^cp\s+\d/i.test(city)) return true;
  // Pure postal codes
  if (/^\d{4,5}$/.test(city)) return true;
  // HTML/metadata fragments
  if (city.includes('content=') || city.includes('<') || city.length > 120) return true;
  // Percentage/description fragments
  if (/^\d{2,3}\s*[-–]/.test(city) || /befristet|homeoffice|arbeitsort|standorte/i.test(city)) return true;
  return false;
}

/* ── Stats ────────────────────────────────────────────────── */

const stats = {
  slicesRead: 0,
  slicesModified: 0,
  jobsScanned: 0,
  cantonFixed: 0,
  foreignCleared: 0,
  lowercaseFixed: 0,
  skippedUnparseable: 0,
};

const fixes = []; // detailed log

/* ── Process slices ───────────────────────────────────────── */

const sliceFiles = readdirSync(SLICES_DIR).filter((f) => f.endsWith('.json'));
console.log(`   Found ${sliceFiles.length} crawler slices\n`);

for (const file of sliceFiles) {
  const filePath = join(SLICES_DIR, file);
  let data;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    continue;
  }

  const jobs = data.jobs;
  if (!Array.isArray(jobs) || jobs.length === 0) continue;
  stats.slicesRead++;

  let sliceModified = false;

  for (const job of jobs) {
    stats.jobsScanned++;

    const city = norm(job.addressLocality || job.location || '');
    const storedCanton = norm(job.canton || '');

    // Fix lowercase cantons first
    if (storedCanton && storedCanton !== storedCanton.toUpperCase()) {
      const fixed = storedCanton.toUpperCase();
      fixes.push({ file, company: job.company, city, action: 'lowercase', from: storedCanton, to: fixed });
      job.canton = fixed;
      stats.lowercaseFixed++;
      sliceModified = true;
    }

    // Skip unparseable locations
    if (isUnparseableLocation(city) || city === 'CH') {
      stats.skippedUnparseable++;
      continue;
    }

    const cantonUpper = (job.canton || '').toUpperCase();

    // Check: is city a known Swiss municipality?
    const inferredCanton = inferAnyCanton(city);

    if (inferredCanton) {
      // BFS knows this city — verify canton matches
      if (cantonUpper && cantonUpper !== inferredCanton) {
        fixes.push({
          file, company: job.company, city,
          action: 'canton_mismatch',
          from: cantonUpper, to: inferredCanton,
        });
        job.canton = inferredCanton;
        // Also fix addressRegion if it was the old canton
        if (job.addressRegion === cantonUpper || job.addressRegion === storedCanton) {
          job.addressRegion = inferredCanton;
        }
        stats.cantonFixed++;
        sliceModified = true;
      }
    } else if (isLocationExplicitlyForeign(city)) {
      // Explicitly foreign city — clear Swiss canton
      if (cantonUpper) {
        fixes.push({
          file, company: job.company, city,
          action: 'foreign_cleared',
          from: cantonUpper, to: '(removed)',
        });
        job.canton = '';
        job.addressCountry = '';
        job.country = '';
        stats.foreignCleared++;
        sliceModified = true;
      }
    }
    // If neither BFS nor foreign list knows the city, leave it alone
    // (conservative — avoid Nominatim false positives)
  }

  if (sliceModified) {
    stats.slicesModified++;
    if (apply) {
      writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    }
  }
}

/* ── Report ────────────────────────────────────────────────── */

console.log('═'.repeat(70));
console.log('  REPAIR REPORT');
console.log('═'.repeat(70));
console.log(`  Slices read:        ${stats.slicesRead}`);
console.log(`  Slices modified:    ${stats.slicesModified}`);
console.log(`  Jobs scanned:       ${stats.jobsScanned}`);
console.log(`  Canton fixed:       ${stats.cantonFixed}`);
console.log(`  Foreign cleared:    ${stats.foreignCleared}`);
console.log(`  Lowercase fixed:    ${stats.lowercaseFixed}`);
console.log(`  Skipped unparseable: ${stats.skippedUnparseable}`);
console.log('═'.repeat(70));

if (fixes.length > 0) {
  // Group by action
  const byAction = {};
  for (const f of fixes) {
    if (!byAction[f.action]) byAction[f.action] = [];
    byAction[f.action].push(f);
  }

  for (const [action, items] of Object.entries(byAction)) {
    console.log(`\n── ${action.toUpperCase()} (${items.length}) ──`);
    // Group by company for readability
    const byCompany = {};
    for (const item of items) {
      const key = item.company || 'unknown';
      if (!byCompany[key]) byCompany[key] = [];
      byCompany[key].push(item);
    }
    for (const [company, companyItems] of Object.entries(byCompany).sort((a, b) => b[1].length - a[1].length)) {
      const unique = [...new Set(companyItems.map((i) => `${i.city}: ${i.from}→${i.to}`))];
      console.log(`  ${company} (${companyItems.length} jobs): ${unique.slice(0, 5).join('; ')}${unique.length > 5 ? ` ...+${unique.length - 5}` : ''}`);
    }
  }
}

if (!apply && fixes.length > 0) {
  console.log(`\n⚠️  DRY RUN — no files modified. Run with --apply to fix.\n`);
} else if (apply && fixes.length > 0) {
  console.log(`\n✅ Applied ${fixes.length} fixes across ${stats.slicesModified} slices.\n`);
} else {
  console.log(`\n✅ No fixes needed.\n`);
}
