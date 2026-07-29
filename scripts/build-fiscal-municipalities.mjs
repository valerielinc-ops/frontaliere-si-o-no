#!/usr/bin/env node
/**
 * build-fiscal-municipalities.mjs — construct the fiscal-guide dataset.
 *
 * WHAT (issue #4483, epic #4482)
 * ------------------------------
 * Emits `data/fiscal-municipalities.json`: the list of Italian border
 * municipalities in the 20 km band from the Swiss border (accordo frontalieri
 * 2024) that qualify for a per-municipality FISCAL guide page ("tasse
 * frontaliere residente a {comune}: vecchio vs nuovo regime"), each carrying
 * its real addizionale comunale IRPEF rate.
 *
 * SOURCE
 * ------
 * Derived from the committed `data/municipalities.ts` — itself the official
 * list published by ti.ch / MEF (2024) with the comuni-di-frontiera fascia,
 * per-comune addizionale comunale IRPEF and population. This script is the
 * single re-runnable builder; re-run it after `data/municipalities.ts`
 * changes:
 *
 *   node scripts/build-fiscal-municipalities.mjs            # writes the JSON
 *   node scripts/build-fiscal-municipalities.mjs --stats    # print counts only
 *   node scripts/build-fiscal-municipalities.mjs --check    # fail if drifted
 *
 * FLOOR (explicit — which comuni merit an indexable page)
 * -------------------------------------------------------
 *   1. Ticino corridor only — provinces CO / VA / VB (the same corridor the
 *      "vivere a {comune}" pages in borderMunicipalityPagesPlugin cover, so
 *      the anti-cannibalization cross-link always has a live target).
 *   2. Real data only — municipalities whose population is a curated real
 *      figure (population !== 2000, the region-average placeholder used for
 *      minor comuni); a fiscal page MUST publish a real addizionale, never a
 *      placeholder.
 *   3. Above floor (indexable full page) ⇔ population >= 5000 AND distance to
 *      the border <= 20 km (inside the accordo 2024 band). The rest of the
 *      real-data corridor comuni go to a noindex,follow below-floor bridge at
 *      the same URL (never a silent 404 — AGENTS.md § Static SEO Pages).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'municipalities.ts');
const OUT = path.join(ROOT, 'data', 'fiscal-municipalities.json');

// ── Floor / scope constants (documented above) ──────────────────
export const CORRIDOR_PROVINCES = ['CO', 'VA', 'VB'];
export const MIN_POPULATION = 5000;
export const MAX_DISTANCE_KM = 20;
const PLACEHOLDER_POPULATION = 2000;

const SOURCE_LABEL =
  'MEF/Agenzia delle Entrate — comuni italiani in fascia di 20 km dal confine svizzero (accordo frontalieri 2024) + addizionale comunale IRPEF (opendata MEF), 2024; derivato da data/municipalities.ts (elenco ti.ch/MEF 2024).';
const SOURCE_YEAR = 2024;

/** Slugify — byte-identical to borderMunicipalityPagesPlugin.ts `slugify`
 *  so the fiscal page slug matches the "vivere a" cross-link target. */
export function slugify(value) {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Parse every municipality object out of data/municipalities.ts. The file is
 *  a hand-maintained flat literal array with a stable one-object-per-line
 *  shape, so a field-order-independent per-line extraction is robust. */
export function parseMunicipalities(tsSource) {
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
      const mm = fields.match(new RegExp(`${key}:\\s*'((?:[^'\\\\]|\\\\.)*)'`));
      return mm ? mm[1].replace(/\\'/g, "'").replace(/\\"/g, '"') : undefined;
    };
    const province = str('province');
    if (!name || !province) continue;
    out.push({
      name,
      province,
      lat: num('lat'),
      lng: num('lng'),
      irpefAddizionale: num('irpefAddizionale'),
      distanceKm: num('distanceKm'),
      avgRentMonthly: num('avgRentMonthly'),
      population: num('population'),
      fascia: str('fascia'),
      note: str('note'),
      noteType: str('noteType'),
    });
  }
  return out;
}

/** Apply the corridor + real-data filter and the population/proximity floor. */
export function buildDataset(all) {
  const corridor = all.filter(
    (m) =>
      CORRIDOR_PROVINCES.includes(m.province) &&
      m.population !== PLACEHOLDER_POPULATION &&
      Number.isFinite(m.irpefAddizionale) &&
      Number.isFinite(m.distanceKm) &&
      Number.isFinite(m.population),
  );

  const toRecord = (m) => ({
    name: m.name,
    slug: slugify(m.name),
    province: m.province,
    irpefAddizionale: m.irpefAddizionale,
    distanceKm: m.distanceKm,
    population: m.population,
    avgRentMonthly: m.avgRentMonthly,
    lat: m.lat,
    lng: m.lng,
    ...(m.note ? { note: m.note } : {}),
    ...(m.noteType ? { noteType: m.noteType } : {}),
  });

  const isAboveFloor = (m) => m.population >= MIN_POPULATION && m.distanceKm <= MAX_DISTANCE_KM;

  const byPopThenName = (a, b) => b.population - a.population || a.name.localeCompare(b.name);
  const aboveFloor = corridor.filter(isAboveFloor).map(toRecord).sort(byPopThenName);
  const belowFloor = corridor.filter((m) => !isAboveFloor(m)).map(toRecord).sort(byPopThenName);

  return {
    source: SOURCE_LABEL,
    year: SOURCE_YEAR,
    floor: {
      corridorProvinces: CORRIDOR_PROVINCES,
      minPopulation: MIN_POPULATION,
      maxDistanceKm: MAX_DISTANCE_KM,
      requiresRealPopulation: true,
      note: 'Above-floor comuni get an indexable fiscal page; the rest of the corridor real-data comuni get a noindex,follow below-floor bridge at the same URL.',
    },
    profile: {
      annualIncomeCHF: 55000,
      maritalStatus: 'SINGLE',
      children: 0,
      distanceZone: 'WITHIN_20KM',
      note: 'Typical single frontaliere profile used to render the vecchio-vs-nuovo-regime numeric scenario via the salaryHubScenarios / calculationService engine.',
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
  const all = parseMunicipalities(tsSource);
  if (all.length < 500) {
    console.error(
      `[fiscal-municipalities] FATAL: parsed only ${all.length} municipalities from ${SRC} (expected >=500). ` +
        'The literal shape may have changed — fix the parser before regenerating.',
    );
    process.exit(1);
  }
  const dataset = buildDataset(all);
  const json = stableJson(dataset);

  console.log(
    `[fiscal-municipalities] parsed ${all.length} comuni → ` +
      `${dataset.aboveFloor.length} above-floor (indexable) + ${dataset.belowFloor.length} below-floor (bridge) ` +
      `in corridor ${CORRIDOR_PROVINCES.join('/')}.`,
  );

  if (args.has('--stats')) return;

  if (args.has('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf-8') : '';
    if (current !== json) {
      console.error('[fiscal-municipalities] DRIFT: data/fiscal-municipalities.json is stale. Re-run without --check.');
      process.exit(1);
    }
    console.log('[fiscal-municipalities] up to date.');
    return;
  }

  fs.writeFileSync(OUT, json, 'utf-8');
  console.log(`[fiscal-municipalities] wrote ${path.relative(ROOT, OUT)}`);
}

main();
