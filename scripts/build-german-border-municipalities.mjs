#!/usr/bin/env node
/**
 * build-german-border-municipalities.mjs — construct the Germany border-municipality
 * dataset (issue #4882, third of the FR/DE/AT/LI rollout after France #4545/#4878).
 *
 * Emits `data/german-border-municipalities.json`: the 112 candidate Gemeinden of the
 * 4 Landkreise (Lörrach, Waldshut, Konstanz, Schwarzwald-Baar-Kreis) hosting the 67
 * DE entries in data/borderCrossings.ts, split into above-floor (indexable
 * "vivere a {Gemeinde}" page) and below-floor (noindex,follow bridge at the same
 * URL) — same shape/rationale as build-french-border-municipalities.mjs /
 * build-fiscal-municipalities.mjs.
 *
 * SOURCE
 * ------
 * Derived from the committed `data/germanBorderMunicipalities.ts` (see that
 * file's header for full sourcing: Destatis GV-ISys nationwide registry, OSRM
 * road-routing). Re-run after that file changes:
 *
 *   node scripts/build-german-border-municipalities.mjs            # writes the JSON
 *   node scripts/build-german-border-municipalities.mjs --stats    # print counts only
 *   node scripts/build-german-border-municipalities.mjs --check    # fail if drifted
 *
 * FLOOR (explicit — which Gemeinden merit an indexable page)
 * -----------------------------------------------------------------------
 *   1. Population >= 5000 (matches the French/Italian corridor floor).
 *   2. Real road distance (OSRM) to the nearest DE border crossing <= 20 km —
 *      NOT haversine (see data/germanBorderMunicipalities.ts header for why
 *      this diverges from data/municipalities.ts's haversine-only distanceKm).
 *   Below-floor Gemeinden still get a page (noindex,follow bridge, same URL) —
 *   never a silent gap (AGENTS.md § Static SEO Pages below-floor-bridge rule).
 *
 * REGIME (fiscal mechanism — deliberately UNIFORM, not derived from `canton`)
 * -----------------------------------------------------------------------
 *   Unlike the French corridor (canton GE vs VD/NE/JU/VS drives a real
 *   per-canton regime split, see CANTON_REGIME in
 *   build-french-border-municipalities.mjs), the German Grenzgänger regime
 *   under Art. 15a DBA Deutschland/Schweiz is the SAME regardless of which
 *   Swiss canton employs the frontaliere: 4.5% Quellensteuer, credited via
 *   Anrechnungsmethode, >60-Nichtrückkehrtage-per-year carve-out (see the
 *   fiscal research doc's "Passo 1"). `REGIME` below is therefore a single
 *   constant applied to every row, not a canton-keyed map — `canton` in the
 *   output stays purely geographic (see data/germanBorderMunicipalities.ts).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertPlausibleMunicipality } from './lib/municipality-plausibility-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'germanBorderMunicipalities.ts');
const OUT = path.join(ROOT, 'data', 'german-border-municipalities.json');

// ── Floor / scope constants (documented above) ──────────────────
export const MIN_POPULATION = 5000;
export const MAX_DISTANCE_KM = 20;

/** The 4 Landkreise verified (against data/borderCrossings.ts `province`) to
 *  host all 67 DE border crossings. A Gemeinde outside this set means the
 *  source .ts was edited with a typo or an out-of-scope Landkreis — fail
 *  loud rather than silently including/excluding it. */
export const KNOWN_LANDKREISE = ['Lörrach', 'Waldshut', 'Konstanz', 'Schwarzwald-Baar-Kreis'];

/** Single uniform regime — see REGIME note above for why this is not a
 *  canton-keyed map like the French builder's CANTON_REGIME. */
export const REGIME = 'grenzgaenger-15a';

const SOURCE_LABEL =
  'Destatis Gemeindeverzeichnis-Informationssystem (GV-ISys), "Alle politisch selbständigen Gemeinden mit ausgewählten Merkmalen am 31.12.2025" (population reference 31.12.2024, Zensus-2022-fortgeschrieben; boundaries/PLZ/coordinates reference 31.12.2025) + OSRM road-routing (router.project-osrm.org) vs data/borderCrossings.ts; vedi data/germanBorderMunicipalities.ts per dettaglio fonte-per-fonte.';
const SOURCE_YEAR = 2026;

/** Slugify — byte-identical to build-french-border-municipalities.mjs / build-fiscal-municipalities.mjs. */
export function slugify(value) {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Parse every Gemeinde object out of data/germanBorderMunicipalities.ts. Same
 *  field-order-independent per-line extraction as parseFrenchBorderMunicipalities()
 *  in build-french-border-municipalities.mjs, robust to a hand-maintained flat literal. */
export function parseGermanBorderMunicipalities(tsSource) {
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
    const ags = str('ags');
    if (!name || !ags) continue;
    out.push({
      name,
      ags,
      landkreis: str('landkreis'),
      lat: num('lat'),
      lng: num('lng'),
      population: num('population'),
      plz: str('plz'),
      distanceKm: num('distanceKm'),
      nearestCrossing: str('nearestCrossing'),
      canton: str('canton'),
    });
  }
  return out;
}

/** Apply the population/proximity floor. Fails loud on an unknown Landkreis
 *  or an out-of-range value (via the shared plausibility guard) instead of
 *  silently dropping the row — a Gemeinde that vanishes from the dataset
 *  because of a transcription typo is a data bug that needs a human. */
export function buildDataset(all) {
  const valid = all.filter(
    (m) =>
      Number.isFinite(m.lat) &&
      Number.isFinite(m.lng) &&
      Number.isFinite(m.population) &&
      Number.isFinite(m.distanceKm) &&
      typeof m.ags === 'string' &&
      /^\d{8}$/.test(m.ags) &&
      typeof m.canton === 'string',
  );

  for (const m of valid) {
    if (!KNOWN_LANDKREISE.includes(m.landkreis)) {
      throw new Error(
        `[german-border-municipalities] unknown Landkreis "${m.landkreis}" for "${m.name}" ` +
          `(expected one of: ${KNOWN_LANDKREISE.join(', ')}) — ` +
          'check data/germanBorderMunicipalities.ts for a typo or an out-of-scope Landkreis.',
      );
    }
    assertPlausibleMunicipality(m, { sourceLabel: 'german-border-municipalities' });
  }

  const toRecord = (m) => ({
    name: m.name,
    slug: slugify(m.name),
    ags: m.ags,
    landkreis: m.landkreis,
    lat: m.lat,
    lng: m.lng,
    population: m.population,
    plz: m.plz,
    distanceKm: m.distanceKm,
    nearestCrossing: m.nearestCrossing,
    canton: m.canton,
    regime: REGIME,
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
      note: 'Above-floor Gemeinden get an indexable page; below-floor Gemeinden get a noindex,follow bridge at the same URL (never a silent gap).',
    },
    regime: {
      value: REGIME,
      note: 'Art. 15a DBA Deutschland/Schweiz Grenzgänger regime: uniform 4.5% Quellensteuer regardless of Swiss canton, credited via Anrechnungsmethode, >60 Nichtrückkehrtage/year carve-out. Applies identically to every row — see the REGIME note in this file and data/germanBorderMunicipalities.ts header.',
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
  const all = parseGermanBorderMunicipalities(tsSource);
  if (all.length < 112) {
    console.error(
      `[german-border-municipalities] FATAL: parsed only ${all.length} Gemeinden from ${SRC} (expected >=112). ` +
        'The literal shape may have changed — fix the parser before regenerating.',
    );
    process.exit(1);
  }
  const dataset = buildDataset(all);
  const json = stableJson(dataset);

  console.log(
    `[german-border-municipalities] parsed ${all.length} Gemeinden → ` +
      `${dataset.aboveFloor.length} above-floor (indexable) + ${dataset.belowFloor.length} below-floor (bridge).`,
  );

  if (args.has('--stats')) return;

  if (args.has('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf-8') : '';
    if (current !== json) {
      console.error('[german-border-municipalities] DRIFT: data/german-border-municipalities.json is stale. Re-run without --check.');
      process.exit(1);
    }
    console.log('[german-border-municipalities] up to date.');
    return;
  }

  fs.writeFileSync(OUT, json, 'utf-8');
  console.log(`[german-border-municipalities] wrote ${path.relative(ROOT, OUT)}`);
}

const invokedDirectly = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]); }
  catch { return false; }
})();

if (invokedDirectly) main();
