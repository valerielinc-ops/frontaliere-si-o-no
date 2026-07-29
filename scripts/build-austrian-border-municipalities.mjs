#!/usr/bin/env node
/**
 * build-austrian-border-municipalities.mjs — construct the Austria
 * border-municipality dataset (issue #4883, fourth of the FR/DE/AT/LI
 * rollout after France #4545/#4878, Germany #4882, Liechtenstein #4884).
 *
 * Emits `data/austrian-border-municipalities.json`: the 24 comuni of
 * Vorarlberg (17) and Tirol/Bezirk Landeck (7), individually verified as
 * border-touching (see data/austrianBorderMunicipalities.ts header — NOT
 * derived from the `foreignSide` of data/borderCrossings.ts), split into
 * above-floor (indexable "vivere a {comune}" page) and below-floor
 * (noindex,follow bridge at the same URL) — same shape/rationale as
 * build-german-border-municipalities.mjs / build-liechtenstein-municipalities.mjs.
 *
 * SOURCE
 * ------
 * Derived from the committed `data/austrianBorderMunicipalities.ts` (see
 * that file's header for full sourcing: Vorarlberg/Statistik Austria GKZ
 * registries, Wikipedia population/coordinates, OSRM road-routing). Re-run
 * after that file changes:
 *
 *   node scripts/build-austrian-border-municipalities.mjs            # writes the JSON
 *   node scripts/build-austrian-border-municipalities.mjs --stats    # print counts only
 *   node scripts/build-austrian-border-municipalities.mjs --check    # fail if drifted
 *
 * FLOOR (explicit — POPULATION-ONLY, deliberately NOT the German dual floor)
 * -----------------------------------------------------------------------
 *   Population >= 5000 (matches the French/German/Italian corridor floor).
 *   No distance gate: OSRM found a genuinely border-touching comune
 *   (Nenzing, pop. 6502) at 25.7 km real road distance from the nearest AT
 *   vehicular crossing — above a naive 20 km cutoff — purely because that
 *   stretch of the Vorarlberg/Graubünden border runs over a roadless alpine
 *   ridge (Naafkopf) with no crossing nearby. The candidate list itself was
 *   already adjacency-verified (see data/austrianBorderMunicipalities.ts
 *   header), so a distance-to-crossing gate would incorrectly demote comuni
 *   that really do sit on the border — same reasoning that led the
 *   Liechtenstein twin to drop the distance filter entirely for its corridor.
 *   distanceKm/nearestCrossing/canton are still carried per record as
 *   informational metadata, just not used to compute aboveFloor/belowFloor.
 *   Below-floor comuni still get a page (noindex,follow bridge, same URL) —
 *   never a silent gap (AGENTS.md § Static SEO Pages below-floor-bridge rule).
 *
 * REGIME (fiscal mechanism — DECISIVE, uniform across every row)
 * -----------------------------------------------------------------------
 *   Austria's special frontalieri regime (Art. 15 §4, DBA-A, SR 0.672.916.31)
 *   was ABROGATED by the 21.3.2006 amending protocol (BGBl. III Nr. 22/2007).
 *   Since then: ordinary cantonal Quellensteuer under Art. 15 §1 (no reduced
 *   rate, no cap comparable to Germany's 4.5%), no defined border zone, no
 *   non-return-day threshold (only the general OECD 183-day short-stay
 *   exception, unrelated to border-commuter status), double taxation avoided
 *   via the credit method (Art. 23 §2) rather than Austria's usual exemption
 *   method, and an inter-state compensation of 12.5% of Swiss source-tax
 *   revenue paid by ALL Swiss cantons to Austria (Final Protocol point 4) —
 *   see the REGIME_NOTE constant below for the full citation text and
 *   data/austrianBorderMunicipalities.ts for source URLs. This is a SINGLE
 *   uniform constant applied to every row (like the German builder's
 *   REGIME, unlike the French builder's per-canton CANTON_REGIME map) —
 *   Austria's treaty has no canton-driven variant.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertPlausibleMunicipality } from './lib/municipality-plausibility-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'austrianBorderMunicipalities.ts');
const OUT = path.join(ROOT, 'data', 'austrian-border-municipalities.json');

// ── Floor / scope constants (documented above) ──────────────────
export const MIN_POPULATION = 5000;
export const EXPECTED_MUNICIPALITY_COUNT = 24;

/** The 5 Bezirke verified (against data/austrianBorderMunicipalities.ts
 *  sourcing) to host the 24 border-touching comuni. A comune outside this
 *  set means the source .ts was edited with a typo or an out-of-scope
 *  Bezirk — fail loud rather than silently including/excluding it. */
export const KNOWN_BEZIRKE = ['Bregenz', 'Dornbirn', 'Feldkirch', 'Bludenz', 'Landeck'];
export const KNOWN_LAND = ['Vorarlberg', 'Tirol'];

/** Single uniform regime — see REGIME note above for why this is not a
 *  canton-keyed map like the French builder's CANTON_REGIME, and why it is
 *  NOT the German 'grenzgaenger-15a' regime (Austria's is abrogated). */
export const REGIME = 'no-regime-frontalieri-art15';

export const REGIME_NOTE =
  'Regime speciale frontalieri (Art. 15 §4 DBA-A, SR 0.672.916.31) abrogato dal ' +
  "21.3.2006 (BGBl. III Nr. 22/2007: 'aufgehoben'). Dal 2006/2007 si applica la " +
  'regola ordinaria Art. 15 §1: tassazione con tariffa cantonale Quellensteuer piena ' +
  'nello stato di lavoro (nessuna riduzione, nessun tetto comparabile al 4.5% ' +
  'tedesco), nessuna zona di confine definita, nessuna soglia di giorni di ' +
  'non-rientro (esiste solo la soglia generale OCSE dei 183 giorni per le missioni ' +
  "brevi, Art. 15 §2, non legata allo status di frontaliere). L'Austria evita la " +
  'doppia imposizione col metodo del credito (Anrechnungsmethode, Art. 23 §2) ' +
  "anziché il metodo dell'esenzione che usa come regola generale. In luogo di uno " +
  'sgravio individuale, la Svizzera versa una compensazione inter-statale del 12.5% ' +
  'del gettito della Quellensteuer ex Art. 15 §1, pagata da tutti i cantoni svizzeri ' +
  '(Protocollo finale, punto 4). Telelavoro: soglia previdenziale 49.9% (accordo ' +
  'quadro UE-EFTA ex Art. 16(1) Reg. 883/2004, AT e CH firmatari dal 1.7.2023) — ' +
  'nessun accordo fiscale bilaterale sul telelavoro trovato (assenza di evidenza, ' +
  'non prova di assenza). Fonti: SR 0.672.916.31 (RIS Austria, consolidato); ' +
  'rapporto del Consiglio federale svizzero al Parlamento, 15.11.2013 (Postulato ' +
  'Robbiani 11.3607).';

const SOURCE_LABEL =
  'Vorarlberg open-data GKZ registry (data.vorarlberg.gv.at) + Statistik Austria ' +
  'nationwide Gemeinde list (statistik.at, Gebietsstand 2026) per GKZ/bezirk/land; ' +
  'Wikipedia per-comune infobox (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; ' +
  'coordinate) per population/lat/lng; OSRM road-routing (router.project-osrm.org) ' +
  'vs data/borderCrossings.ts per distanceKm/nearestCrossing/canton (informational, ' +
  'see FLOOR note); vedi data/austrianBorderMunicipalities.ts per dettaglio ' +
  'fonte-per-fonte e per-riga.';
const SOURCE_YEAR = 2026;

/** Slugify — byte-identical to build-german-border-municipalities.mjs /
 *  build-french-border-municipalities.mjs / build-fiscal-municipalities.mjs. */
export function slugify(value) {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Parse every comune object out of data/austrianBorderMunicipalities.ts. Same
 *  field-order-independent per-line extraction as parseGermanBorderMunicipalities()
 *  in build-german-border-municipalities.mjs, robust to a hand-maintained flat literal. */
export function parseAustrianBorderMunicipalities(tsSource) {
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
    const gkz = str('gkz');
    if (!name || !gkz) continue;
    out.push({
      name,
      gkz,
      bezirk: str('bezirk'),
      land: str('land'),
      lat: num('lat'),
      lng: num('lng'),
      population: num('population'),
      populationDate: str('populationDate'),
      distanceKm: num('distanceKm'),
      nearestCrossing: str('nearestCrossing'),
      canton: str('canton'),
      source: str('source'),
    });
  }
  return out;
}

/** Apply the population-only floor (see FLOOR note above). Fails loud on an
 *  unknown Bezirk/Land or an out-of-range value (via the shared plausibility
 *  guard) instead of silently dropping the row — a comune that vanishes from
 *  the dataset because of a transcription typo is a data bug that needs a
 *  human. */
export function buildDataset(all) {
  const valid = all.filter(
    (m) =>
      Number.isFinite(m.lat) &&
      Number.isFinite(m.lng) &&
      Number.isFinite(m.population) &&
      typeof m.gkz === 'string' &&
      /^\d{5}$/.test(m.gkz) &&
      typeof m.bezirk === 'string' &&
      typeof m.land === 'string' &&
      typeof m.populationDate === 'string' &&
      typeof m.source === 'string',
  );

  for (const m of valid) {
    if (!KNOWN_BEZIRKE.includes(m.bezirk)) {
      throw new Error(
        `[austrian-border-municipalities] unknown Bezirk "${m.bezirk}" for "${m.name}" ` +
          `(expected one of: ${KNOWN_BEZIRKE.join(', ')}) — ` +
          'check data/austrianBorderMunicipalities.ts for a typo or an out-of-scope Bezirk.',
      );
    }
    if (!KNOWN_LAND.includes(m.land)) {
      throw new Error(
        `[austrian-border-municipalities] unknown Land "${m.land}" for "${m.name}" ` +
          `(expected one of: ${KNOWN_LAND.join(', ')}) — ` +
          'check data/austrianBorderMunicipalities.ts for a typo or an out-of-scope Land.',
      );
    }
    assertPlausibleMunicipality(m, { sourceLabel: 'austrian-border-municipalities' });
  }

  const toRecord = (m) => ({
    name: m.name,
    slug: slugify(m.name),
    gkz: m.gkz,
    bezirk: m.bezirk,
    land: m.land,
    lat: m.lat,
    lng: m.lng,
    population: m.population,
    populationDate: m.populationDate,
    distanceKm: m.distanceKm,
    nearestCrossing: m.nearestCrossing,
    canton: m.canton,
    regime: REGIME,
    source: m.source,
  });

  const isAboveFloor = (m) => m.population >= MIN_POPULATION;

  const byPopThenName = (a, b) => b.population - a.population || a.name.localeCompare(b.name);
  const aboveFloor = valid.filter(isAboveFloor).map(toRecord).sort(byPopThenName);
  const belowFloor = valid.filter((m) => !isAboveFloor(m)).map(toRecord).sort(byPopThenName);

  return {
    source: SOURCE_LABEL,
    year: SOURCE_YEAR,
    floor: {
      minPopulation: MIN_POPULATION,
      note:
        'Above-floor comuni get an indexable page; below-floor comuni get a ' +
        'noindex,follow bridge at the same URL (never a silent gap). No ' +
        'distance-based gate — see the FLOOR note in ' +
        'scripts/build-austrian-border-municipalities.mjs and ' +
        'data/austrianBorderMunicipalities.ts for why a population-only floor ' +
        'fits this corridor (adjacency-already-verified border list; OSRM ' +
        'distanceKm carried on every record as informational metadata only).',
    },
    regime: {
      value: REGIME,
      note: REGIME_NOTE,
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
  const all = parseAustrianBorderMunicipalities(tsSource);
  if (all.length < EXPECTED_MUNICIPALITY_COUNT) {
    console.error(
      `[austrian-border-municipalities] FATAL: parsed only ${all.length} comuni from ${SRC} ` +
        `(expected >=${EXPECTED_MUNICIPALITY_COUNT}). The literal shape may have changed — ` +
        'fix the parser before regenerating.',
    );
    process.exit(1);
  }
  const dataset = buildDataset(all);
  const json = stableJson(dataset);

  console.log(
    `[austrian-border-municipalities] parsed ${all.length} comuni → ` +
      `${dataset.aboveFloor.length} above-floor (indexable) + ${dataset.belowFloor.length} below-floor (bridge).`,
  );

  if (args.has('--stats')) return;

  if (args.has('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf-8') : '';
    if (current !== json) {
      console.error('[austrian-border-municipalities] DRIFT: data/austrian-border-municipalities.json is stale. Re-run without --check.');
      process.exit(1);
    }
    console.log('[austrian-border-municipalities] up to date.');
    return;
  }

  fs.writeFileSync(OUT, json, 'utf-8');
  console.log(`[austrian-border-municipalities] wrote ${path.relative(ROOT, OUT)}`);
}

const invokedDirectly = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]); }
  catch { return false; }
})();

if (invokedDirectly) main();
