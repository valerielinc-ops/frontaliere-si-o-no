#!/usr/bin/env node
/**
 * build-liechtenstein-municipalities.mjs — construct the Liechtenstein
 * per-comune dataset (issue #4884, third of the FR/DE/AT/LI rollout started
 * by #4545).
 *
 * Emits `data/liechtenstein-municipalities.json`: all 11 comuni of the
 * Principality, split into above-floor (indexable "vivere a {comune}" page)
 * and below-floor (noindex,follow bridge at the same URL) — same
 * shape/rationale as build-french-border-municipalities.mjs /
 * build-fiscal-municipalities.mjs.
 *
 * SOURCE
 * ------
 * Derived from the committed `data/liechtensteinMunicipalities.ts` (see that
 * file's header for full sourcing: Amt für Statistik Liechtenstein for
 * population, Wikidata for coordinates). Re-run after that file changes:
 *
 *   node scripts/build-liechtenstein-municipalities.mjs            # writes the JSON
 *   node scripts/build-liechtenstein-municipalities.mjs --stats    # print counts only
 *   node scripts/build-liechtenstein-municipalities.mjs --check    # fail if drifted
 *
 * FLOOR (explicit — which comuni merit an indexable page)
 * -----------------------------------------------------------------------
 * The France corridor floor (population >= 5000, data/frenchBorderMunicipalities.ts)
 * does NOT transplant here: applied mechanically to this dataset it would
 * leave 8 of the 11 comuni below floor (only Schaan 6109, Vaduz 5826, Triesen
 * 5532 clear 5000) — for a country of 40'015 residents total, that throws
 * away comuni like Balzers (4747) or Ruggell (2523) that are anything but
 * marginal locally. There is also no distance-to-border filter here (see
 * data/liechtensteinMunicipalities.ts header): the whole country is ~160 km^2,
 * so a proximity cut would not discriminate anything.
 *
 * Population sorted descending, the 11 values cluster into 3 groups with two
 * clear gaps rather than a smooth curve:
 *   6109 5826 5532 4747 4607 4589 | 2671 2523 | 1768 1155 488
 *                                 ^ gap 1918   ^ gap 755
 * The lower gap (1768 -> 2523, a +43% jump, the largest proportional gap in
 * the bottom half of the distribution) is the natural split point: below it
 * sit Gamprin (1768), Schellenberg (1155) and Planken (488) — the three
 * smallest comuni in the country by a wide margin (Planken is nationally the
 * smallest of all 11, under 500 residents). Above it, Ruggell (2523) and
 * Triesenberg (2671) join the six larger comuni as comuni that plainly carry
 * real local weight (Ruggell alone is ~6% of the national population).
 *
 * MIN_POPULATION = 2000 draws the line inside that gap. Above-floor: 8 of 11
 * comuni, 38'804 of 40'015 residents (~97%). Below-floor (bridge, never a
 * silent skip — AGENTS.md § Static SEO Pages): Gamprin, Schellenberg, Planken.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertPlausibleMunicipality } from './lib/municipality-plausibility-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'liechtensteinMunicipalities.ts');
const OUT = path.join(ROOT, 'data', 'liechtenstein-municipalities.json');

// ── Floor / scope constants (reasoning documented above) ──────────────────
export const MIN_POPULATION = 2000;
export const EXPECTED_MUNICIPALITY_COUNT = 11;

const SOURCE_LABEL =
  'Amt für Statistik Liechtenstein, "Statistisches Jahrbuch Liechtensteins 2025", tab. T_2.1_01 "Bevölkerung nach Wohngemeinde, 1960-2023", p. 75 (dato 31.12.2023) + Wikidata (wdt:P31 wd:Q203300, wdt:P625) per le coordinate; vedi data/liechtensteinMunicipalities.ts per dettaglio fonte-per-fonte.';
const SOURCE_YEAR = 2023;

export const NATIONAL_POPULATION = {
  value: 40015,
  year: 2023,
  source:
    'Amt für Statistik Liechtenstein, "Statistisches Jahrbuch Liechtensteins 2025", tab. T_2.1_01, p. 75 — totale nazionale pubblicato, somma dei valori per-comune verificata coerente.',
};

/**
 * Structural fact that makes this corridor's editorial framing different
 * from France/Italy: the DOMINANT commuting flow is Switzerland -> Liechtenstein,
 * not the reverse the site's existing template assumes. Carried in the
 * emitted JSON (not just in a comment) so any downstream consumer renders
 * the same sourced numbers instead of re-deriving or paraphrasing them.
 * Source: Statistisches Jahrbuch Liechtensteins 2025, tab. T_3.1_23
 * "Erwerbstätige Auslandspendler - Wegpendler und Zupendler, 1960-2023", p. 141
 * (verified primary — see tax-research-de-li.md, Passo 2 Punto A).
 */
export const LIECHTENSTEIN_COMMUTING_CONTEXT = {
  year: 2023,
  chToLi: 14891,
  liToCh: 2426,
  ratio: '~6.1:1 (CH->LI is the dominant direction)',
  workforceShareCrossBorder: "57% (2022) of Liechtenstein's total workforce commutes in from abroad",
  note:
    "Questo sito copre il flusso minoritario (residenti in Liechtenstein che lavorano in Svizzera, 2'426 persone nel 2023) perché coerente col suo pubblico, ma DEVE dichiarare che il flusso dominante e' l'opposto — mai presentare 'vivere in Liechtenstein, lavorare in Svizzera' come il pattern maggioritario.",
  source:
    'Statistisches Jahrbuch Liechtensteins 2025, Amt für Statistik Liechtenstein, tab. T_3.1_23, p. 141.',
};

/** Slugify — same implementation as build-french-border-municipalities.mjs /
 *  build-fiscal-municipalities.mjs (both already carry this exact function;
 *  duplicated here rather than extracted into a shared module because this
 *  worktree is intentionally scoped to data-only files and other corridor
 *  builders are being edited in parallel by other agents — a shared-module
 *  extraction touching those sibling files belongs to whoever integrates all
 *  of them, not to this isolated change). */
export function slugify(value) {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Parse every comune object out of data/liechtensteinMunicipalities.ts. Same
 *  field-order-independent per-line extraction as parseFrenchBorderMunicipalities()
 *  / parseMunicipalities(), robust to a hand-maintained flat literal. */
export function parseLiechtensteinMunicipalities(tsSource) {
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
    const wikidataId = str('wikidataId');
    if (!name || !wikidataId) continue;
    out.push({
      name,
      wikidataId,
      lat: num('lat'),
      lng: num('lng'),
      population: num('population'),
      populationYear: num('populationYear'),
    });
  }
  return out;
}

/** Apply the population floor. */
export function buildDataset(all) {
  const valid = all.filter(
    (m) =>
      Number.isFinite(m.lat) &&
      Number.isFinite(m.lng) &&
      Number.isFinite(m.population) &&
      Number.isFinite(m.populationYear) &&
      typeof m.name === 'string' &&
      m.name.length > 0 &&
      typeof m.wikidataId === 'string' &&
      m.wikidataId.length > 0,
  );
  for (const m of valid) {
    assertPlausibleMunicipality(m, { sourceLabel: 'liechtenstein-municipalities' });
  }

  const toRecord = (m) => ({
    name: m.name,
    slug: slugify(m.name),
    wikidataId: m.wikidataId,
    lat: m.lat,
    lng: m.lng,
    population: m.population,
    populationYear: m.populationYear,
  });

  const isAboveFloor = (m) => m.population >= MIN_POPULATION;

  const byPopThenName = (a, b) => b.population - a.population || a.name.localeCompare(b.name);
  const aboveFloor = valid.filter(isAboveFloor).map(toRecord).sort(byPopThenName);
  const belowFloor = valid.filter((m) => !isAboveFloor(m)).map(toRecord).sort(byPopThenName);

  return {
    source: SOURCE_LABEL,
    year: SOURCE_YEAR,
    nationalPopulation: NATIONAL_POPULATION,
    commutingContext: LIECHTENSTEIN_COMMUTING_CONTEXT,
    floor: {
      minPopulation: MIN_POPULATION,
      note:
        'Above-floor comuni get an indexable page; below-floor comuni get a noindex,follow bridge at the same URL (never a silent gap). No distance filter — see scripts/build-liechtenstein-municipalities.mjs header for why a population-only floor fits this corridor.',
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
  const all = parseLiechtensteinMunicipalities(tsSource);
  if (all.length < EXPECTED_MUNICIPALITY_COUNT) {
    console.error(
      `[liechtenstein-municipalities] FATAL: parsed only ${all.length} comuni from ${SRC} (expected ${EXPECTED_MUNICIPALITY_COUNT}). ` +
        'The literal shape may have changed — fix the parser before regenerating.',
    );
    process.exit(1);
  }
  const dataset = buildDataset(all);
  const json = stableJson(dataset);

  console.log(
    `[liechtenstein-municipalities] parsed ${all.length} comuni → ` +
      `${dataset.aboveFloor.length} above-floor (indexable) + ${dataset.belowFloor.length} below-floor (bridge).`,
  );

  if (args.has('--stats')) return;

  if (args.has('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf-8') : '';
    if (current !== json) {
      console.error('[liechtenstein-municipalities] DRIFT: data/liechtenstein-municipalities.json is stale. Re-run without --check.');
      process.exit(1);
    }
    console.log('[liechtenstein-municipalities] up to date.');
    return;
  }

  fs.writeFileSync(OUT, json, 'utf-8');
  console.log(`[liechtenstein-municipalities] wrote ${path.relative(ROOT, OUT)}`);
}

const invokedDirectly = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]); }
  catch { return false; }
})();

if (invokedDirectly) main();
