// scripts/migrate-slug-registry-add-canton.mjs
// One-shot migration that adds `canton` field to every entry in data/slug-registry.json.
// Source of truth: data/jobs.json (job.canton or inferred from job.location via city → canton).
// Fallback: 'TI' (preserves legacy behavior for entries we can't resolve).
import fs from 'node:fs';
import path from 'node:path';

const REG_PATH = path.resolve('data/slug-registry.json');
const JOBS_PATH = path.resolve('data/jobs.json');
const MUNI_PATH = path.resolve('data/canton-municipalities.json');

const registry = JSON.parse(fs.readFileSync(REG_PATH, 'utf8'));
const jobs = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));
const muni = JSON.parse(fs.readFileSync(MUNI_PATH, 'utf8'));

// Build slug → canton map from current jobs.json
const slugToCanton = new Map();
for (const job of jobs) {
  const c = String(job.canton || '').toUpperCase();
  const sl = [job.slug, job.slugByLocale?.it, job.slugByLocale?.en, job.slugByLocale?.de, job.slugByLocale?.fr].filter(Boolean);
  for (const s of sl) if (c && !slugToCanton.has(s)) slugToCanton.set(s, c);
}

// City → canton (disambiguator-aware)
const cityToCanton = new Map();
const cityCounts = new Map();
for (const [canton, info] of Object.entries(muni.cantons)) {
  for (const city of info.municipalities) {
    const lower = city.toLowerCase();
    if (lower.includes(' (')) cityToCanton.set(lower, canton);
    const bare = lower.split(' (')[0].trim();
    cityCounts.set(bare, (cityCounts.get(bare) || 0) + 1);
    if (!cityToCanton.has(bare)) cityToCanton.set(bare, canton);
  }
}
// Erase ambiguous bare entries
for (const [bare, count] of cityCounts) {
  if (count > 1) cityToCanton.delete(bare);
}

let backfilled = 0, fallback = 0, alreadyHad = 0;
const FALLBACK = 'TI';

const out = {};
for (const [slug, entry] of Object.entries(registry)) {
  if (entry && typeof entry === 'object' && entry.canton) {
    out[slug] = entry; alreadyHad++; continue;
  }
  let canton = slugToCanton.get(slug);
  if (!canton) {
    // try slug parsing: e.g. "frontend-developer-zurich-abc123" → city "zurich"
    const parts = String(slug).toLowerCase().split('-');
    for (let i = parts.length - 1; i >= 0; i--) {
      const c = cityToCanton.get(parts[i]);
      if (c) { canton = c; break; }
    }
  }
  if (!canton) { canton = FALLBACK; fallback++; } else { backfilled++; }
  out[slug] = { ...(entry && typeof entry === 'object' ? entry : {}), canton };
}

fs.writeFileSync(REG_PATH, JSON.stringify(out, null, 2) + '\n');
console.log(`slug-registry back-fill: ${backfilled} canton-resolved, ${fallback} fell back to ${FALLBACK}, ${alreadyHad} already had canton`);
