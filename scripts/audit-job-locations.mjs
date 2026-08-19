#!/usr/bin/env node
/**
 * Audit all job locations against BFS municipality data + Nominatim geocoding.
 *
 * Layers:
 *   1. BFS check — is the city a known Swiss municipality? What canton?
 *   2. inferAnyCanton — does our location engine agree with the stored canton?
 *   3. Crawler-vs-dataset — does the published LOCALITY still match the one the
 *      crawler recorded in `data/jobs/by-crawler/<key>.json`?
 *   4. Nominatim — for cities not in BFS, verify country via geocoding
 *   5. FORMAT — does the location string already say which canton it is in, so
 *      that every UI appending `(canton)` prints it twice?
 *
 * Layer 5 answers a question layers 1-4 structurally cannot ask. They all
 * adjudicate WHICH PLACE a job is in; a location can name the right place and
 * still be malformed. "Lengnau (BE)" stamped BE is correct by every layer above
 * and rendered "Lengnau (BE) (BE)" on the live page — 2,457 of 27,590 jobs
 * (8.91%, measured on origin/main 2026-08-19) printed a doubled or empty
 * parenthetical. `scripts/lib/job-location-display.mjs` now removes the
 * duplication at render time, which is why this layer reports on the DATA
 * rather than on the page: the crawler that emits "Konolfingen, CH" is still
 * emitting it, and only the crawler can stop.
 *
 * It reports three things, all grouped BY CRAWLER so the issue names the file
 * to edit:
 *   · `redundantLocationMarker` — the location carries a canton/country marker.
 *   · `locationCantonConflict`  — it names a DIFFERENT canton than the field.
 *     Never a formatting problem: one of the two halves is factually wrong.
 *   · `implausibleLocation`   — layer 6: what is left after the markers are
 *     removed cannot be a municipality name at all, because a scraper leaked
 *     page furniture into the field. Judged AFTER stripping, so the two layers
 *     never double-report the same row: "Geneva, GENEVA, Switzerland" is a
 *     redundancy that cleans up to "Geneva", while
 *     "0200 Deutsch Suche Suche Masterdata Specialist" cleans up to itself.
 *   · `descriptionCantonDuplicated` — the crawler's own description text repeats
 *     the canton after the redundant location ("Konolfingen, CH, Kanton BE").
 *     This is the only one of the three that survives a render-time fix, since
 *     the string is frozen into the indexed description at crawl time.
 *
 * Layer 3 exists because layers 1-2 are BFS-only and are therefore BLIND to the
 * largest mislabel class this audit is supposed to catch — in two ways.
 *
 * Layer 6 exists because `unknownCity` conflates two different things, which
 * this file's own header already calls out below: a real hamlet BFS happens not
 * to list, and text that was never a place. Both land in the same bucket, so a
 * count of it cannot tell a data-coverage gap from a broken parser, and the
 * issue could name neither. Structural implausibility separates them without a
 * gazetteer — five or more words, an adjacent repeated word, markup — and is
 * deliberately conservative: measured 191 of 27,508 non-empty locations (0.69%)
 * on origin/main 2026-08-19, concentrated in convit-holding 64,
 * vf-international 39, zurich-insurance-sede-ticino 37, tether 17. The reported
 * job that opened this work is one of them
 * ("0200 Deutsch Suche Suche Masterdata Specialist", rado).
 *
 * A job in a hamlet BFS does not list as a municipality (Obbürgen, NW —
 * Bürgenstock Hotels AG, #4838) lands in `unknownCity`, where a wrong canton is
 * indistinguishable from a merely unrecognised one: 28 of 39 Bürgenstock
 * postings shipped `canton="TI"` for months while every weekly snapshot
 * reported 0 problems for them.
 *
 * The converse is worse and is what #5136 turned out to be: a job moved onto a
 * city that IS a real BFS municipality. Layers 1-2 then actively certify it as
 * correct. Roche postings in Jakarta and Kyiv shipped as "Alle" (JU) — a real
 * Jura village whose name is also the German word "all" — so `cantonMismatch`
 * and `foreignInSwiss` both read 0 while 1592 jobs sat on a fabricated location.
 *
 * Comparing against the crawler's own record needs no municipality database, so
 * it adjudicates both cases. Compare the LOCALITY, not the canton: a dedicated
 * crawler stamps the employer's home canton on every posting it emits (Roche
 * writes BS on its Shanghai ads), so a canton-only comparison flags ~775 jobs
 * whose published canton is simply the correct one — noise that buried the real
 * signal until #5136.
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
  swissCityFromLocationField,
} from './lib/target-swiss-locations.mjs';
import { buildStableJobIdentity } from './lib/job-identity.mjs';
import { splitJobLocation } from './lib/job-location-display.mjs';
import { descriptionRepeatsRegion, implausibilityReasons } from './lib/job-location-plausibility.mjs';
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
  crawlerLocationRewritten: [], // assemble replaced the locality the crawler recorded (BFS-independent)
  crawlerCantonStampDiffers: [], // same place, crawler's per-company canton stamp is stale — context only
  redundantLocationMarker: [],   // layer 5: location already names its canton/country
  locationCantonConflict: [],    // layer 5: location names a DIFFERENT canton than the field
  descriptionCantonDuplicated: [], // layer 5: the description text repeats the canton after the location
  implausibleLocation: [],       // layer 6: what remains after stripping cannot be a place name
};

/**
 * Patterns a crawler uses to append the canton to a location inside DESCRIPTION
 * prose. Kept next to the audit rather than in the formatter because they are
 * label templates ("Kanton XX", "XX canton"), not location syntax — the
 * formatter never produces them, it only has to recognise the location half.
 * @param {string} location @param {string} canton @returns {string[]}
 */
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

/* ── Crawler-recorded location index ──────────────────────────
 * `data/jobs/by-crawler/<key>.json` is what each crawler actually wrote for a
 * posting, before any assemble-time inference or pin-ledger reconciliation.
 * Keyed by the same stable identity the pin ledger uses.
 *
 * Indexes the crawler's LOCALITY as well as its canton, because the two carry
 * very different amounts of signal:
 *
 *   - `canton` is frequently a per-crawler constant, not a per-job fact. A
 *     dedicated crawler stamps the employer's home canton on every posting it
 *     emits — Roche writes canton=BS on its Shanghai, Madrid and Budapest ads
 *     alike. So `published canton != crawler canton` on its own says nothing:
 *     for a Roche job in Dietlikon the published ZH is right and the crawler's
 *     BS is the stale value.
 *   - the locality IS per-job. When the published city differs from the one
 *     the crawler recorded, the assemble step rewrote the location, and THAT
 *     is the condition worth alarming on.
 *
 * Missing directory (fresh clone / sparse checkout) simply disables layer 3
 * rather than failing the audit. */
function loadCrawlerRecords() {
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
      const city = norm(job.addressLocality || job.location);
      if (!canton && !city) continue;
      const id = buildStableJobIdentity(job);
      if (id) index.set(id, { canton, city });
    }
  }
  return index;
}
const crawlerRecordById = loadCrawlerRecords();

/* Same-place test between the crawler's locality and the published one.
 * Tolerates the decoration crawlers add around a city name — "Geneva,
 * Switzerland", "Baden, Aargau", "Luzern / hybrid", "Pratteln 1" — so those do
 * not read as a rewrite when the published city is the very city named inside. */
function sameRecordedPlace(crawlerCity, publishedCity) {
  const a = crawlerCity.toLowerCase();
  const b = publishedCity.toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  const inner = swissCityFromLocationField(crawlerCity);
  return Boolean(inner) && inner.toLowerCase() === b;
}

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

  // ── Layer 5: location FORMAT (see header) ──────────────────────────────
  // Runs on `job.location` — the field every UI renders — not on the
  // `addressLocality` fallback `city` above, because it is the rendered string
  // whose shape is in question.
  const rawLocation = norm(job.location || '');
  if (rawLocation) {
    const parts = splitJobLocation(rawLocation, cantonUpper);
    const crawler = norm(job.companyKey || '') || company || 'unknown';
    if (parts.conflict) {
      results.locationCantonConflict.push({
        id, crawler, company, location: rawLocation, storedCanton: cantonUpper,
      });
    } else if (parts.stripped.length) {
      results.redundantLocationMarker.push({
        id, crawler, company, location: rawLocation, storedCanton: cantonUpper,
        kinds: parts.stripped, cleaned: parts.city,
      });
    }

    // Did the duplication also get frozen into an already-published
    // description? Checked for EVERY job, not only for those whose location
    // still looks wrong — see descriptionRepeatsRegion() for the hour in which
    // production proved that distinction fatal.
    const frozen = descriptionRepeatsRegion(job, rawLocation, cantonUpper);
    if (frozen) {
      results.descriptionCantonDuplicated.push({
        id, crawler, company, location: rawLocation, storedCanton: cantonUpper, evidence: frozen,
      });
    }

    // ── Layer 6: is what is LEFT even a place name? ─────────────────────────
    // Judged on the stripped city so a redundancy handled above is never
    // re-reported here as junk.
    const cleanedCity = parts.city || rawLocation;
    const implausible = implausibilityReasons(cleanedCity);
    if (implausible.length) {
      results.implausibleLocation.push({
        id, crawler, company, location: rawLocation, cleaned: cleanedCity,
        storedCanton: cantonUpper, reasons: implausible,
      });
    }
  }

  // Layer 3: the assemble step rewrote the location the crawler recorded.
  // BFS-independent, so it catches what layers 1-2 structurally cannot: a job
  // moved onto a city that IS a real BFS municipality, which layer 1 therefore
  // signs off as "correct". That is the whole #4838 class — a Roche posting in
  // Jakarta republished as "Alle" (JU) reads as perfectly valid to layer 1.
  //
  // Runs before the empty-location `continue` so a job with no city text is
  // still checked.
  //
  // Split matters. `canton` alone is a per-crawler constant (see
  // loadCrawlerRecords), so comparing cantons flags ~775 jobs whose published
  // canton is simply the correct one for a city the crawler agreed on. Only a
  // changed LOCALITY means the pipeline invented a location, so that is what
  // lands in the alarming bucket; a bare canton-stamp difference is recorded
  // separately as context and never trips the "must never produce" verdict.
  const crawlerRecord = crawlerRecordById.get(buildStableJobIdentity(job) || '');
  if (crawlerRecord && cantonUpper) {
    const crawlerCity = crawlerRecord.city;
    const entry = {
      id, company, city: city || '(empty)',
      storedCanton: cantonUpper,
      crawlerCanton: crawlerRecord.canton || '(none)',
      crawlerCity: crawlerCity || '(none)',
      inferredCanton: city ? inferAnyCanton(city) || '(none)' : '(none)',
    };
    if (crawlerCity && city && !sameRecordedPlace(crawlerCity, city)) {
      results.crawlerLocationRewritten.push(entry);
    } else if (crawlerRecord.canton && crawlerRecord.canton !== cantonUpper) {
      results.crawlerCantonStampDiffers.push(entry);
    }
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
console.log(`📌 Crawler locality rewritten by dataset: ${results.crawlerLocationRewritten.length}${crawlerRecordById.size ? '' : ' (by-crawler slices unavailable — check skipped)'}`);
console.log(`ℹ️  Crawler canton stamp differs (same place, benign): ${results.crawlerCantonStampDiffers.length}`);
console.log(`🔁 Location already names its canton/country: ${results.redundantLocationMarker.length}`);
console.log(`❗ Location names a DIFFERENT canton than the field: ${results.locationCantonConflict.length}`);
console.log(`📝 Description text repeats the canton: ${results.descriptionCantonDuplicated.length}`);
console.log(`🧩 Location cannot be a place name (scraper leak): ${results.implausibleLocation.length}`);
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

// Detail: locality rewritten by the assembled dataset
if (results.crawlerLocationRewritten.length > 0) {
  console.log('\n' + '─'.repeat(70));
  console.log('📌 PUBLISHED LOCALITY CONTRADICTS THE CRAWLER RECORD');
  console.log('─'.repeat(70));
  const byCompany = {};
  for (const o of results.crawlerLocationRewritten) {
    const key = `${o.company} — crawler="${o.crawlerCity}" (${o.crawlerCanton}) → published="${o.city}" (${o.storedCanton})`;
    byCompany[key] = (byCompany[key] || 0) + 1;
  }
  for (const [key, count] of Object.entries(byCompany).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count.toString().padStart(4)} × ${key}`);
  }

  // The destination city is the actionable part: a handful of everyday words
  // that are also municipality names account for most rewrites, and each one
  // is fixed by a single entry in TEXT_RESCUE_AMBIGUOUS_TOKENS.
  console.log('\n  Rewritten INTO (add repeat offenders to TEXT_RESCUE_AMBIGUOUS_TOKENS):');
  const byTarget = {};
  for (const o of results.crawlerLocationRewritten) {
    const key = `${o.city} (${o.storedCanton})`;
    byTarget[key] = (byTarget[key] || 0) + 1;
  }
  for (const [key, count] of Object.entries(byTarget).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
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

// Detail: layer 5 — location format, grouped BY CRAWLER.
// By crawler, not by company: the repair is an edit to one
// `scripts/lib/<crawler>-job-parser.mjs`, and the crawler key IS that filename.
// A leaderboard by company would name Coop 1,011 times and never say which file.
/**
 * The file a fixer should open for a crawler key, or `null`.
 *
 * RESOLVED BY SEARCH, NOT BY NAMING CONVENTION. The first version printed
 * `scripts/lib/<key>-job-parser.mjs` unconditionally and the job that opened
 * this work disproved it immediately: `rado` is crawled by
 * `scripts/update-swatchgroup-jobs.mjs`. The convention holds for a minority —
 * `convit-holding` lives in `update-convit-jobs.mjs`,
 * `vf-international-the-north-face-timberland` in `update-vf-jobs.mjs`,
 * `zurich-insurance-sede-ticino` in `update-zurich-jobs.mjs`. Pointing an
 * autonomous fixer at a path that does not exist is worse than pointing it at
 * nothing, because it looks like an answer, so the key is looked up in the
 * sources instead.
 *
 * The index is built once, lazily, and only when there is something to report.
 */
let crawlerFileIndex = null;

function buildCrawlerFileIndex() {
  /** @type {Map<string, string>} */
  const index = new Map();
  const dirs = [
    { dir: 'scripts', match: (f) => f.startsWith('update-') && f.endsWith('.mjs') },
    { dir: join('scripts', 'lib'), match: (f) => f.endsWith('-job-parser.mjs') || f.endsWith('-common.mjs') },
  ];
  for (const { dir, match } of dirs) {
    let entries = [];
    try {
      entries = readdirSync(join(ROOT, dir));
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!match(file)) continue;
      const rel = `${dir}/${file}`;
      let source = '';
      try {
        source = readFileSync(join(ROOT, rel), 'utf8');
      } catch {
        continue;
      }
      for (const m of source.matchAll(/['"]([a-z0-9]+(?:-[a-z0-9]+){0,8})['"]/g)) {
        // First writer wins: a dedicated parser is scanned after its update-*
        // driver only when the driver did not already claim the key.
        if (!index.has(m[1])) index.set(m[1], rel);
      }
    }
  }
  return index;
}

/** @param {string} crawler @returns {string|null} */
function parserFileFor(crawler) {
  if (!crawler) return null;
  for (const candidate of [
    `scripts/lib/${crawler}-job-parser.mjs`,
    `scripts/update-${crawler}-jobs.mjs`,
  ]) {
    if (existsSync(join(ROOT, candidate))) return candidate;
  }
  if (!crawlerFileIndex) crawlerFileIndex = buildCrawlerFileIndex();
  return crawlerFileIndex.get(crawler) || null;
}

function printByCrawler(rows, heading, extra) {
  if (!rows.length) return;
  console.log('\n' + '─'.repeat(70));
  console.log(heading);
  console.log('─'.repeat(70));
  const byCrawler = new Map();
  for (const row of rows) {
    if (!byCrawler.has(row.crawler)) byCrawler.set(row.crawler, []);
    byCrawler.get(row.crawler).push(row);
  }
  for (const [crawler, items] of [...byCrawler].sort((a, b) => b[1].length - a[1].length)) {
    const parser = parserFileFor(crawler);
    console.log(`\n  ${crawler} (${items.length} jobs) — ${parser || 'file del crawler non risolto: grep del companyKey'}`);
    const byValue = new Map();
    for (const item of items) {
      const key = extra(item);
      byValue.set(key, (byValue.get(key) || 0) + 1);
    }
    for (const [value, count] of [...byValue].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`    ${String(count).padStart(4)} × ${value}`);
    }
  }
}

printByCrawler(
  results.redundantLocationMarker,
  '🔁 LOCATION ALREADY NAMES ITS CANTON / COUNTRY (every UI then appends it again)',
  (o) => `"${o.location}" (${o.storedCanton}) → "${o.cleaned}" [${o.kinds.join('+')}]`,
);
printByCrawler(
  results.locationCantonConflict,
  '❗ LOCATION NAMES A DIFFERENT CANTON THAN THE STORED FIELD (one half is wrong)',
  (o) => `"${o.location}" but canton=${o.storedCanton}`,
);
printByCrawler(
  results.implausibleLocation,
  '🧩 LOCATION THAT CANNOT BE A PLACE NAME (page furniture leaked into the field)',
  (o) => `"${o.cleaned}" [${o.reasons.join('+')}]`,
);
printByCrawler(
  results.descriptionCantonDuplicated,
  '📝 DESCRIPTION TEXT REPEATS THE CANTON (frozen at crawl time — render fix does not reach it)',
  (o) => `"${o.evidence}"`,
);

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
    crawlerLocationRewritten: results.crawlerLocationRewritten.length,
    crawlerCantonStampDiffers: results.crawlerCantonStampDiffers.length,
    geocodeResults: results.geocodeResults.length,
    redundantLocationMarker: results.redundantLocationMarker.length,
    locationCantonConflict: results.locationCantonConflict.length,
    descriptionCantonDuplicated: results.descriptionCantonDuplicated.length,
    implausibleLocation: results.implausibleLocation.length,
  },
  // Layer 5 leaderboards, pre-grouped by crawler so the issue body does not have
  // to re-aggregate 27k rows (and cannot get the aggregation subtly different
  // from the console output above).
  locationFormatByCrawler: (() => {
    const acc = new Map();
    const bump = (crawler, field) => {
      if (!acc.has(crawler)) {
        acc.set(crawler, { crawler, redundant: 0, conflict: 0, descriptionDuplicated: 0, implausible: 0 });
      }
      acc.get(crawler)[field] += 1;
    };
    for (const row of results.redundantLocationMarker) bump(row.crawler, 'redundant');
    for (const row of results.locationCantonConflict) bump(row.crawler, 'conflict');
    for (const row of results.descriptionCantonDuplicated) bump(row.crawler, 'descriptionDuplicated');
    for (const row of results.implausibleLocation) bump(row.crawler, 'implausible');
    for (const row of acc.values()) row.parserFile = parserFileFor(row.crawler);
    return [...acc.values()].sort(
      (a, b) => (b.conflict + b.descriptionDuplicated + b.implausible + b.redundant)
        - (a.conflict + a.descriptionDuplicated + a.implausible + a.redundant),
    );
  })(),
  crawlerRecordsIndexed: crawlerRecordById.size,
  cantonMismatches: results.cantonMismatch,
  foreignInSwiss: results.foreignInSwiss,
  unknownCities: results.unknownCity,
  emptyLocations: results.emptyLocation,
  lowercaseCantons: results.lowercaseCanton,
  companyDefaultFallback: results.companyDefaultFallback,
  crawlerLocationRewritten: results.crawlerLocationRewritten,
  crawlerCantonStampDiffers: results.crawlerCantonStampDiffers,
  geocodeResults: results.geocodeResults,
  redundantLocationMarker: results.redundantLocationMarker,
  locationCantonConflict: results.locationCantonConflict,
  descriptionCantonDuplicated: results.descriptionCantonDuplicated,
  implausibleLocation: results.implausibleLocation,
}, null, 2));
console.log(`\n📄 Detailed report saved to: data/location-audit-report.json\n`);
