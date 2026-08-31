#!/usr/bin/env node
/**
 * One-off repair for data/job-canton-pins.json entries poisoned by the
 * bug fixed in scripts/assemble-jobs-dataset.mjs (issue #4570):
 * inferAnyCanton() confidently matches a bare canton-NAME string ("Ticino")
 * as if it were a real city, so a job whose location field is forged/
 * corrupted to the literal canton name — while its own `canton` field is
 * correct — got that correct canton silently overwritten, then the pin
 * ledger froze the wrong value forever.
 *
 * Scans every live crawler file in data/jobs/by-crawler/*.json (all
 * crawlers, not just ETA SA/Swatch Group — issue #4570 asked to check the
 * whole crawler fleet for the same shape). For each job, if:
 *   - the ledger has a pin that differs from the job's own `canton` field
 *     (non-empty), AND
 *   - the job's addressLocality/location is a canton-ONLY label (not a
 *     real city — see isCantonOnlyLabel), AND
 *   - that label names the SAME canton as the (wrong) pin, AND
 *   - the job's OWN canton is corroborated by a real Swiss location signal:
 *     either a format-valid Swiss postal code on record, OR a "<4-digit PLZ>
 *     <City>" pair found adjacent in the description/street text (many
 *     crawlers, e.g. ETA SA, only put the true address — "2540 Grenchen" —
 *     in free-text description, never in a structured postalCode field),
 *     where the City is a REAL known Swiss municipality that itself
 *     resolves (via inferAnyCanton) to the SAME canton being repaired.
 *
 *     Deliberately NOT a bare "does any known Swiss city appear anywhere in
 *     this text" search (that was tried and reverted — see git history):
 *     free text is full of unrelated Swiss city mentions (nav boilerplate,
 *     other branch listings, even a city name that happens to be a company
 *     name substring, e.g. "Zurich Insurance"), so an unanchored match
 *     regularly corroborates the WRONG canton. Requiring the PLZ+City pair
 *     to be adjacent, and the resolved canton to match, ties the signal to
 *     an actual postal address instead of incidental text.
 *
 *     zurich-insurance-sede-ticino.json is hard-excluded below regardless:
 *     its `company` field is itself corrupted (polluted with description
 *     text fragments, e.g. ". Reporting directly to the Head of Credit
 *     Research..."), and spot checks found foreign postings (Barcelona,
 *     Köln, Vienna, Tyrol) carrying the same forged-Zürich-HQ-default shape
 *     as the "Country Manager for Sweden" case that prompted this guard.
 *     That's foreign-job leakage, a different bug from #4570's canton
 *     mislabeling, and needs its own dedicated fix — not touched here.
 * — then the pin was seeded from exactly the #4570 weak signal. Repair it
 * to the job's own canton instead.
 *
 * Usage:
 *   node scripts/dev/repair-canton-only-label-pins.mjs
 *   node scripts/dev/repair-canton-only-label-pins.mjs --apply
 *
 * Default is dry-run — prints the planned repairs. Pass --apply to write
 * data/job-canton-pins.json.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildStableJobIdentity } from '../lib/job-identity.mjs';
import { isCantonOnlyLabel, normalizeCantonCode, isKnownSwissCity, inferAnyCanton } from '../lib/target-swiss-locations.mjs';
import { isSwissPostalCode } from '../assemble-jobs-dataset.mjs';
import { isSliceFile } from '../lib/crawler-slice-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const PINS_PATH = path.join(ROOT, 'data', 'job-canton-pins.json');
const CRAWLER_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const APPLY = process.argv.includes('--apply');

// "<4-digit PLZ> <City>" — a real postal address, not just a stray city
// mention. First captured word only (keeps this simple; multi-word cities
// like "La Chaux-de-Fonds" won't match, which just means fewer repairs, not
// wrong ones).
const PLZ_CITY_RE = /\b(\d{4})\s+([A-ZÀ-ÖØ-Þ][\p{L}.-]{2,})/gu;

/** True iff the haystack has a real PLZ+City pair resolving to `targetCanton`. */
function hasCorroboratingAddress(haystack, targetCanton) {
  PLZ_CITY_RE.lastIndex = 0;
  let match;
  while ((match = PLZ_CITY_RE.exec(haystack))) {
    const [, plz, city] = match;
    if (!isSwissPostalCode(plz)) continue;
    // #6147: targetCanton is already known here, so pass it as the hint —
    // a bare "<City> (XX)"-only BFS entry (e.g. Küsnacht) would otherwise
    // fail isKnownSwissCity and this corroboration was silently skipped.
    if (!isKnownSwissCity(city, targetCanton)) continue;
    if (inferAnyCanton(city) === targetCanton) return true;
  }
  return false;
}

console.log(APPLY ? '🟢 APPLY mode — will write data/job-canton-pins.json' : '🟡 DRY RUN — no writes (pass --apply to commit)');

// Excluded: known-corrupted crawler data (see file header) that a text-match
// corroboration heuristic can't reliably vet — needs its own dedicated fix.
const EXCLUDED_CRAWLER_FILES = new Set(['zurich-insurance-sede-ticino.json']);

const pins = JSON.parse(fs.readFileSync(PINS_PATH, 'utf-8'));
const files = fs
  .readdirSync(CRAWLER_DIR)
  .filter((f) => isSliceFile(f) && !EXCLUDED_CRAWLER_FILES.has(f));

let repaired = 0;
const byCrawler = new Map();

for (const file of files) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(CRAWLER_DIR, file), 'utf-8'));
  } catch {
    continue;
  }
  const jobs = Array.isArray(data) ? data : data.jobs || [];
  for (const job of jobs) {
    const canton = String(job.canton || '').trim().toUpperCase();
    if (!canton) continue;
    const pinId = buildStableJobIdentity(job);
    const pinned = pins[pinId];
    if (!pinned || pinned === canton) continue;
    const locality = String(job.addressLocality || job.location || '').trim();
    if (!isCantonOnlyLabel(locality)) continue;
    if (normalizeCantonCode(locality) !== pinned) continue;

    let corroborated = isSwissPostalCode(job.postalCode);
    if (!corroborated) {
      const haystack = `${job.description || ''} ${job.descriptionByLocale?.it || ''} ${job.descriptionByLocale?.en || ''} ${job.descriptionByLocale?.de || ''} ${job.descriptionByLocale?.fr || ''} ${job.streetAddress || ''}`;
      corroborated = hasCorroboratingAddress(haystack, canton);
    }
    if (!corroborated) continue;

    pins[pinId] = canton;
    repaired++;
    const list = byCrawler.get(file) || [];
    if (list.length < 5) {
      list.push(`${pinId} ${pinned}→${canton} (locality="${locality}", ${job.url || job.id || ''})`);
    }
    byCrawler.set(file, list);
  }
}

console.log(`\nFound ${repaired} stale canton-only-label pin(s) across ${byCrawler.size} crawler file(s):\n`);
for (const [file, samples] of byCrawler) {
  console.log(`  ${file}:`);
  for (const s of samples) console.log(`    ${s}`);
}

if (repaired > 0 && APPLY) {
  fs.writeFileSync(PINS_PATH, JSON.stringify(pins) + '\n', 'utf-8');
  console.log(`\n✅ Wrote ${repaired} repair(s) to ${path.relative(ROOT, PINS_PATH)}`);
} else if (repaired > 0) {
  console.log('\n(dry run — re-run with --apply to write)');
} else {
  console.log('\nNothing to repair.');
}
