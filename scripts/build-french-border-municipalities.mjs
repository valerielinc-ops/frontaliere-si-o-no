#!/usr/bin/env node
/**
 * build-french-border-municipalities.mjs — construct the France border-municipality
 * dataset (issue #4545, first of the FR/DE/AT/LI rollout).
 *
 * Emits `data/french-border-municipalities.json`: the 22 candidate communes on the
 * Genève/Vaud/Neuchâtel/Jura/Valais corridor, split into above-floor (indexable
 * "vivere a {commune}" page) and below-floor (noindex,follow bridge at the same
 * URL) — same shape/rationale as build-fiscal-municipalities.mjs for Italy.
 *
 * SOURCE
 * ------
 * Derived from the committed `data/frenchBorderMunicipalities.ts` (see that
 * file's header for full sourcing: geo.api.gouv.fr, OSRM road-routing,
 * DGALN/DHUP rent CSV). Re-run after that file changes:
 *
 *   node scripts/build-french-border-municipalities.mjs            # writes the JSON
 *   node scripts/build-french-border-municipalities.mjs --stats    # print counts only
 *   node scripts/build-french-border-municipalities.mjs --check    # fail if drifted
 *
 * FLOOR (explicit — which communes merit an indexable page)
 * -----------------------------------------------------------------------
 *   1. Population >= 5000 (matches the Italian corridor floor).
 *   2. Real road distance (OSRM) to the nearest FR border crossing <= 20 km —
 *      NOT haversine (see data/frenchBorderMunicipalities.ts header for why
 *      this diverges from data/municipalities.ts's haversine-only distanceKm).
 *   Below-floor communes still get a page (noindex,follow bridge, same URL) —
 *   never a silent gap (AGENTS.md § Static SEO Pages below-floor-bridge rule).
 *
 * REGIME (fiscal mechanism, derived here from `canton` — NOT stored per-row)
 * -----------------------------------------------------------------------
 *   - 'geneve' (canton GE, accord de 1973): Swiss source taxation, barème A0.
 *   - 'huit-cantons' (cantons VD/NE/JU/VS present here — accord de 1983):
 *     France taxes fully via declaration, forfait 10% + barème.
 *   See build-plugins/frenchBorderMunicipalityData.ts for the sourced tax
 *   figures (REGIME_TAX) applied to the reference profile below.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertPlausibleMunicipality } from './lib/municipality-plausibility-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'frenchBorderMunicipalities.ts');
const OUT = path.join(ROOT, 'data', 'french-border-municipalities.json');

// ── Floor / scope constants (documented above) ──────────────────
export const MIN_POPULATION = 5000;
export const MAX_DISTANCE_KM = 20;

export const CANTON_REGIME = {
  GE: 'geneve',
  VD: 'huit-cantons',
  NE: 'huit-cantons',
  JU: 'huit-cantons',
  VS: 'huit-cantons',
};

const SOURCE_LABEL =
  'geo.api.gouv.fr (INSEE population/coordonnate 2023) + OSRM road-routing (router.project-osrm.org) vs data/borderCrossings.ts + DGALN/DHUP "Carte des loyers" 2025 (data.gouv.fr, loypredm2 x 50m2); vedi data/frenchBorderMunicipalities.ts per dettaglio fonte-per-fonte.';
const SOURCE_YEAR = 2026;

/** Slugify — byte-identical to build-fiscal-municipalities.mjs / borderMunicipalityPagesPlugin.ts. */
export function slugify(value) {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Parse every commune object out of data/frenchBorderMunicipalities.ts. Same
 *  field-order-independent per-line extraction as parseMunicipalities() in
 *  build-fiscal-municipalities.mjs, robust to a hand-maintained flat literal. */
export function parseFrenchBorderMunicipalities(tsSource) {
  const out = [];
  const objectRe = /\{\s*name:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,([^}]*)\}/g;
  let m;
  while ((m = objectRe.exec(tsSource))) {
    const name = (m[1] ?? m[2] ?? '').replace(/\\'/g, "'").replace(/\\"/g, '"');
    const fields = m[3];
    const num = (key) => {
      const mm = fields.match(new RegExp(`${key}:\\s*(-?[\\d.]+)`));
      return mm ? Number.parseFloat(mm[1]) : undefined;
    };
    const str = (key) => {
      const mm = fields.match(new RegExp(`${key}:\\s*(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")`));
      return mm ? (mm[1] ?? mm[2] ?? '').replace(/\\'/g, "'").replace(/\\"/g, '"') : undefined;
    };
    const inseeCode = str('inseeCode');
    if (!name || !inseeCode) continue;
    out.push({
      name,
      inseeCode,
      dept: str('dept'),
      lat: num('lat'),
      lng: num('lng'),
      population: num('population'),
      distanceKm: num('distanceKm'),
      nearestCrossing: str('nearestCrossing'),
      canton: str('canton'),
      avgRentMonthly: num('avgRentMonthly'),
      rentSource: str('rentSource'),
      rentObs: num('rentObs'),
    });
  }
  return out;
}

/** Apply the population/proximity floor and derive the fiscal regime from canton. */
export function buildDataset(all) {
  const valid = all.filter(
    (m) =>
      Number.isFinite(m.lat) &&
      Number.isFinite(m.lng) &&
      Number.isFinite(m.population) &&
      Number.isFinite(m.distanceKm) &&
      typeof m.canton === 'string' &&
      CANTON_REGIME[m.canton],
  );
  for (const m of valid) {
    assertPlausibleMunicipality(m, { sourceLabel: 'french-border-municipalities' });
  }

  const toRecord = (m) => ({
    name: m.name,
    slug: slugify(m.name),
    inseeCode: m.inseeCode,
    dept: m.dept,
    lat: m.lat,
    lng: m.lng,
    population: m.population,
    distanceKm: m.distanceKm,
    nearestCrossing: m.nearestCrossing,
    canton: m.canton,
    regime: CANTON_REGIME[m.canton],
    avgRentMonthly: m.avgRentMonthly,
    rentSource: m.rentSource,
    rentObs: m.rentObs,
  });

  const isAboveFloor = (m) => m.population >= MIN_POPULATION && m.distanceKm <= MAX_DISTANCE_KM;

  const byPopThenName = (a, b) => b.population - a.population || a.name.localeCompare(b.name);
  const aboveFloor = valid.filter(isAboveFloor).map(toRecord).sort(byPopThenName);
  const belowFloor = valid.filter((m) => !isAboveFloor(m)).map(toRecord).sort(byPopThenName);

  return {
    source: SOURCE_LABEL,
    year: SOURCE_YEAR,
    floor: {
      minPopulation: MIN_POPULATION,
      maxDistanceKm: MAX_DISTANCE_KM,
      distanceMethod: 'osrm-road-routing',
      note: 'Above-floor communes get an indexable page; below-floor communes get a noindex,follow bridge at the same URL (never a silent gap).',
    },
    profile: {
      annualIncomeCHF: 55000,
      maritalStatus: 'SINGLE',
      children: 0,
      note: 'Same reference frontaliere profile as data/fiscal-municipalities.json, used to render the sourced regime tax figures in build-plugins/frenchBorderMunicipalityData.ts (REGIME_TAX).',
    },
    aboveFloor,
    belowFloor,
  };
}

function stableJson(dataset) {
  return JSON.stringify(dataset, null, 2) + '\n';
}

function main() {
  const args = new Set(process.argv.slice(2));
  const tsSource = fs.readFileSync(SRC, 'utf-8');
  const all = parseFrenchBorderMunicipalities(tsSource);
  if (all.length < 22) {
    console.error(
      `[french-border-municipalities] FATAL: parsed only ${all.length} communes from ${SRC} (expected >=22). ` +
        'The literal shape may have changed — fix the parser before regenerating.',
    );
    process.exit(1);
  }
  const dataset = buildDataset(all);
  const json = stableJson(dataset);

  console.log(
    `[french-border-municipalities] parsed ${all.length} communes → ` +
      `${dataset.aboveFloor.length} above-floor (indexable) + ${dataset.belowFloor.length} below-floor (bridge).`,
  );

  if (args.has('--stats')) return;

  if (args.has('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf-8') : '';
    if (current !== json) {
      console.error('[french-border-municipalities] DRIFT: data/french-border-municipalities.json is stale. Re-run without --check.');
      process.exit(1);
    }
    console.log('[french-border-municipalities] up to date.');
    return;
  }

  fs.writeFileSync(OUT, json, 'utf-8');
  console.log(`[french-border-municipalities] wrote ${path.relative(ROOT, OUT)}`);
}

const invokedDirectly = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]); }
  catch { return false; }
})();

if (invokedDirectly) main();
