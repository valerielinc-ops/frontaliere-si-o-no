// scripts/migrate-previous-slug-winners-add-canton.mjs
//
// One-shot migration that rewrites data/previous-slug-winners.json from the
// legacy `${locale}::${oldSlug}` key shape to the Phase 8b canton-aware
// `${canton}::${locale}::${oldSlug}` shape, and stamps a `canton` field on
// each entry.
//
// Canton resolution order, for each entry:
//   1. Look up `winnerJobIdentifier` in data/jobs.json → use job.canton if set.
//   2. Else resolve job.location against data/canton-municipalities.json
//      (matches `build-plugins/shared/cantonSection.ts: resolveJobCanton`).
//   3. Fallback: 'TI' (preserves legacy bridge URLs for unresolvable entries).
//
// This script is idempotent: running it twice on the same file is safe.
// Entries already in the new shape (key contains 3 segments AND entry.canton
// is set) are left untouched.
//
// Why this migration exists
// -------------------------
// Before Phase 8b, every bridge emitted under the TI legacy section
// (`/cerca-lavoro-ticino/...`) regardless of the winning job's canton. The
// registry was keyed `(locale, oldSlug)`. Phase 8b makes bridges live under
// the winning job's canton path (`/cerca-lavoro-zurigo/...` for ZH jobs), so
// the registry key MUST include canton — two jobs in different cantons can
// legitimately share the same oldSlug now and they emit at DIFFERENT URLs.
import fs from 'node:fs';
import path from 'node:path';

const WINNERS_PATH = path.resolve('data/previous-slug-winners.json');
const JOBS_PATH = path.resolve('data/jobs.json');
const MUNI_PATH = path.resolve('data/canton-municipalities.json');

if (!fs.existsSync(WINNERS_PATH)) {
  console.error(`[migrate-prev-slug-winners] no file at ${WINNERS_PATH}; nothing to migrate`);
  process.exit(0);
}
if (!fs.existsSync(JOBS_PATH)) {
  console.error(`[migrate-prev-slug-winners] no data/jobs.json — cannot resolve cantons. Aborting.`);
  process.exit(1);
}
if (!fs.existsSync(MUNI_PATH)) {
  console.error(`[migrate-prev-slug-winners] no data/canton-municipalities.json — cannot resolve cantons. Aborting.`);
  process.exit(1);
}

const winners = JSON.parse(fs.readFileSync(WINNERS_PATH, 'utf8'));
const jobs = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));
const muni = JSON.parse(fs.readFileSync(MUNI_PATH, 'utf8'));

// Build identifier → job map. The plugin uses
// `String(job.id || job.slug || currentSlug)` as the identifier; the same
// value lands in winnerJobIdentifier. Index both id and slug to maximise hit
// rate (jobs without `id` collapse to slug → also indexed).
const jobByIdentifier = new Map();
for (const job of jobs) {
  if (job?.id) jobByIdentifier.set(String(job.id), job);
  if (job?.slug) {
    if (!jobByIdentifier.has(String(job.slug))) jobByIdentifier.set(String(job.slug), job);
  }
}

// City → canton lookup (NFD-normalised, disambiguator-aware). Matches the
// approach used by `build-plugins/shared/cantonSection.ts: resolveJobCanton`
// closely enough that the migration converges on the same canton at build
// time.
function normalizeCityKey(s) {
  return String(s).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}
const cityToCanton = new Map();
const cityCounts = new Map();
for (const [canton, info] of Object.entries(muni.cantons)) {
  for (const city of info.municipalities) {
    const lower = normalizeCityKey(city);
    if (lower.includes(' (')) cityToCanton.set(lower, canton);
    const bare = lower.split(' (')[0].trim();
    cityCounts.set(bare, (cityCounts.get(bare) || 0) + 1);
    if (!cityToCanton.has(bare)) cityToCanton.set(bare, canton);
  }
}
for (const [bare, count] of cityCounts) {
  if (count > 1) cityToCanton.delete(bare);
}

const VALID_CANTONS = new Set([
  'TI','ZH','AG','GE','VD','BE','LU','VS','GR','SG','SO','SZ','SH','OW','NW','UR','TG','GL','FR','JU','NE','ZG','AI','AR','BL','BS',
]);
const FALLBACK = 'TI';

function resolveCantonForJob(job) {
  const explicit = String(job?.canton || '').toUpperCase().trim();
  if (explicit && VALID_CANTONS.has(explicit)) return explicit;
  const loc = normalizeCityKey(String(job?.location || '')).replace(/\bsankt\s+/g, 'st. ');
  const fullCity = loc.split(/[,(]/)[0].trim();
  if (fullCity && cityToCanton.get(fullCity)) return cityToCanton.get(fullCity);
  const tokens = loc.replace(/[(),]/g, ' ').split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (cityToCanton.get(token)) return cityToCanton.get(token);
    const up = token.toUpperCase();
    if (VALID_CANTONS.has(up)) return up;
  }
  return null;
}

// ── Migration ────────────────────────────────────────────────────────────
let cantonResolved = 0;
let fallbackUsed = 0;
let alreadyMigrated = 0;
let totalMigrated = 0;
const out = {};

for (const [oldKey, entry] of Object.entries(winners)) {
  if (!entry || typeof entry !== 'object') continue;
  totalMigrated += 1;

  // Detect already-migrated rows. The new key shape has exactly TWO `::` in
  // the canton+locale prefix; canton field present is the stronger signal.
  const looksMigrated = entry.canton && /^[A-Z]{2,}::[a-z]{2}::/.test(oldKey);
  if (looksMigrated) {
    out[oldKey] = entry;
    alreadyMigrated += 1;
    continue;
  }

  // Parse legacy key `${locale}::${oldSlug}`.
  const sep = oldKey.indexOf('::');
  if (sep < 0) {
    // Unparseable legacy row — keep verbatim, no canton stamp possible.
    out[oldKey] = entry;
    continue;
  }
  const locale = oldKey.slice(0, sep);
  const oldSlug = oldKey.slice(sep + 2);

  const winnerJob = jobByIdentifier.get(String(entry.winnerJobIdentifier || ''));
  let canton = null;
  if (winnerJob) canton = resolveCantonForJob(winnerJob);
  if (canton) {
    cantonResolved += 1;
  } else {
    canton = FALLBACK;
    fallbackUsed += 1;
  }

  const newKey = `${canton}::${locale}::${oldSlug}`;
  out[newKey] = { ...entry, canton };
}

// Sort keys for stable diffs (matches saveWinners() behaviour).
const sorted = {};
for (const k of Object.keys(out).sort()) sorted[k] = out[k];

fs.writeFileSync(WINNERS_PATH, JSON.stringify(sorted, null, 2) + '\n');
console.log(
  `[migrate-prev-slug-winners] migrated ${totalMigrated} entries → canton-resolved ${cantonResolved}, fallback ${FALLBACK} ${fallbackUsed}, already-migrated ${alreadyMigrated}`,
);
