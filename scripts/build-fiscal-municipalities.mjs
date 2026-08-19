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
 *   1. Corridor scope — ALL 11 provinces present in data/municipalities.ts
 *      (CO/VA/VB/SO/AO/VC/BS/BZ/MB/BG/TN), not just CO/VA/VB (issue #4893,
 *      widened from the original CO/VA/VB-only cut — see CORRIDOR CRITERION
 *      below for the numeric rationale).
 *   2. Real data only — municipalities whose population is a curated real
 *      figure (population !== 2000, the region-average placeholder used for
 *      minor comuni); a fiscal page MUST publish a real addizionale, never a
 *      placeholder.
 *   3. Above floor (indexable full page) ⇔ population >= 5000 AND distance to
 *      the border <= 20 km (inside the accordo 2024 band). The rest of the
 *      real-data corridor comuni go to a noindex,follow below-floor bridge at
 *      the same URL (never a silent 404 — AGENTS.md § Static SEO Pages).
 *
 * CORRIDOR CRITERION — province list vs distanceKm threshold (issue #4893)
 * --------------------------------------------------------------------------
 * data/municipalities.ts's `distanceKm` is already computed against the
 * nearest of 12 SWISS_BORDER_POINTS spanning Ticino, Grigioni AND Vallese
 * crossings (scripts/geocode-municipalities.mjs) — it was never Ticino-only,
 * so a pure distanceKm-based corridor is possible in principle. In practice
 * it is provably EQUIVALENT to "every province present in the file": the
 * live 518-row dataset spans exactly 11 provinces (CO/VA/VB/SO/AO/VC/BS/
 * BZ/MB/BG/TN) and every single row's distanceKm falls in 0–59 km — well
 * inside the shared plausibility ceiling (100 km, municipality-plausibility-
 * guard.mjs) and with zero rows from any 12th province or beyond ~60 km. The
 * file's curators already pre-filtered to "Italian comuni bordering
 * Switzerland" before committing it, so listing all 11 provinces here picks
 * up literally the whole file — same membership a bare `distanceKm <= 100`
 * (or any threshold >= 59) would produce, with none of the extra parsing
 * risk of relying on a numeric field that this same script's own homemade
 * regex parser already has to coerce from string source. Kept as an
 * explicit province Set (not a distance formula) because it is easier to
 * audit against the source list and matches the grouping the fiscal hub
 * page already renders (byProvince).
 *
 * KNOWN DATA DEFECT — inherited, NOT fixed here: ~25 rows carry
 * `province: 'SO'` while being geographically Lecco (LC) comuni (predates
 * and was deliberately left uncorrected by issue #4922, per that issue's
 * explicit scope). Expanding CORRIDOR_PROVINCES to include SO means these
 * rows now get a real fiscal page (their own name/population/addizionale/
 * distanceKm data is genuine, un-mislabeled) — only the `province` field
 * they carry, and therefore which heading they group under on the fiscal
 * hub page, is wrong. This is a pre-existing data-layer label defect, not a
 * bug introduced by this corridor change; fixing the province mislabeling
 * itself is out of this script's scope (data/municipalities.ts is the
 * source of truth to correct, not this derived builder).
 *
 * Previous cut (CO/VA/VB only) existed because it originally mirrored the
 * "vivere a {comune}" pages' Ticino-specific corridor — that page family's
 * content (destination commute times to Mendrisio/Lugano/Locarno) is
 * irreducibly Ticino-only and is NOT being extended here; the fiscal pages'
 * content (addizionale comunale + vecchio/nuovo regime scenario) has no such
 * canton-specific dependency, so widening only this builder's corridor does
 * not create any broken cross-link — see fiscalMunicipalityPagesPlugin.ts's
 * conditional `vitaLink` (only rendered when the comune is in the Ticino
 * "vivere a" corridor).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertPlausibleMunicipality,
  assertPlausibleDistribution,
  assertDistinctValueFloor,
} from './lib/municipality-plausibility-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'municipalities.ts');
const OUT = path.join(ROOT, 'data', 'fiscal-municipalities.json');

// ── Floor / scope constants (documented above) ──────────────────
// All 12 provinces present in data/municipalities.ts (issue #4893 —
// widened from the original ['CO', 'VA', 'VB']; see CORRIDOR CRITERION doc
// above for the numeric equivalence-to-distance-threshold argument).
//
// 'LC' added 2026-08-18 together with the #211 province fix in
// data/municipalities.ts, which relabels 25 Lake Como Lecco-shore rows from
// their mislabelled 'SO' to their real 'LC'. This Set's contract is "every
// province present in the file", so it has to follow: without 'LC' those 25
// rows would silently leave the corridor, taking 2 above-floor fiscal pages
// with them. Membership is therefore unchanged by that fix — same 518 rows,
// same slugs (no name collisions exist, so no province suffix is in play) —
// only the `province` string on those 25 moves.
export const CORRIDOR_PROVINCES = ['CO', 'VA', 'VB', 'SO', 'LC', 'AO', 'VC', 'BS', 'BZ', 'MB', 'BG', 'TN'];
export const MIN_POPULATION = 5000;
export const MAX_DISTANCE_KM = 20;
// 2000 was data/municipalities.ts's unreplaced default population (issue
// #4922, fixed 2026-07-29: real ISTAT figures now populate all 518 rows).
// Kept as a defensive exclusion, not a comment-out — a future new/edited
// row left at this exact default must still be excluded from the corridor
// (never published with a fabricated population), and assertPlausibleDistribution
// below now also fails the whole build loud if this value ever again covers
// an implausible share of the corridor, instead of silently draining rows here.
const PLACEHOLDER_POPULATION = 2000;

// ── avgRentMonthly containment (issue #4545 residual 4) ─────────
//
// The rent field is a per-fascia ZONE BAND, not a per-comune measurement:
// 518 comuni carry 32 distinct values, and the four widest bands cover 400
// ×135, 550 ×118, 520 ×92, 450 ×50. #4922 searched for a verified per-comune
// Italian rental source covering all 518 border comuni and found none
// (ISTAT does not publish rents at this granularity); that finding is
// recorded in data/municipalities.ts. So the value stays, is labelled for
// what it is on every surface (services/avgRentEstimate.ts), and is FENCED
// here so it cannot silently get coarser.
//
// WHY THE THRESHOLD SITS ABOVE TODAY'S WORST BAND. The committed maximum is
// 400 on 135/518 rows = 26.1%, already over the shared DEFAULT_MAX_VALUE_SHARE
// of 25%. Any ceiling at or below 135 comuni fails on day one, and the only
// two ways to satisfy it would be to invent per-comune variety — precisely
// the defect this guard exists to prevent — or to delete the signal. So the
// ceiling is a RATCHET pinned just above the committed state, not an
// aspiration: 30% = 155 comuni, ~20 rows of headroom, which absorbs an
// ordinary re-banding of one zone but is nowhere near the 80% that the real
// population placeholder reached in #4922.
//
// The share ceiling alone is gameable (spread a mass overwrite across four
// buckets and every one stays under 30%), so it is paired with a floor on
// the distinct-value count — see assertDistinctValueFloor. Together: to
// reintroduce a mass placeholder you would have to keep 30 distinct values
// AND keep every band under 155 comuni, which is no longer a placeholder.
export const RENT_MAX_VALUE_SHARE = 0.3;
/** The same ceiling as a comune count, for readers and tests: 155 of 518. */
export const RENT_MAX_VALUE_COHORT = 155;
// Committed granularity is 32 distinct values. The floor sits two below, so
// a legitimate correction that merges a singleton into an existing band
// (e.g. one comune moving 320 → 400) does not break the build, while any
// real collapse does. Raise it if re-sourcing ever adds granularity.
export const RENT_MIN_DISTINCT_VALUES = 30;

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
      const mm = fields.match(new RegExp(`${key}:\\s*'([^']*)'`));
      return mm ? mm[1] : undefined;
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
    });
  }
  return out;
}

/**
 * Mutates `records` in place: if two or more corridor comuni share the same
 * base slug (same name, different province — Italy has many repeated comune
 * names across provinces, e.g. "San Fedele" / "Casale" patterns; the live
 * 518-row dataset has zero such collisions today but that is a fact about
 * today's data, not a structural guarantee once the corridor spans 11
 * provinces instead of 3), every member of the colliding group gets its
 * province code appended to the slug (`{base}-{province-lowercase}`) and is
 * then claimed against a `seen` set, so no two comuni ever emit the same URL.
 * Applied to ALL members of a colliding group (not just the 2nd-and-later
 * one) so a slug never silently shifts meaning depending on array order.
 *
 * The `seen`-set loop is load-bearing, not belt-and-braces: the province
 * suffix alone does NOT guarantee uniqueness when two colliding records share
 * the same province (two genuinely homonymous comuni within one province, or
 * a duplicated source row) — both would land on the identical
 * `{base}-{province}` and the collision would survive. It would also survive
 * *silently*: `WRITE_COLLISION_MODE` defaults to `'report'`, not `'throw'`
 * (`build-plugins/sharedWriteRegistry.ts`), so the build logs
 * last-writer-wins and stays green while one comune's page overwrites the
 * other's. The incrementing-counter idiom mirrors `makeExpiredKeyAssigner`
 * in `build-plugins/shared/slimExpiredIndex.ts`; determinism is preserved
 * because input order is deterministic (sorted upstream) and the counter is
 * only reached in the same-province case the suffix cannot resolve.
 */
export function disambiguateHomonymSlugs(records) {
  const bySlug = new Map();
  for (const r of records) {
    if (!bySlug.has(r.slug)) bySlug.set(r.slug, []);
    bySlug.get(r.slug).push(r);
  }
  // Slugs that were never in a colliding group keep their base and must be
  // reserved up-front, so a disambiguated slug can never collide with them.
  const seen = new Set();
  for (const [slug, group] of bySlug) {
    if (group.length < 2) seen.add(slug);
  }
  for (const group of bySlug.values()) {
    if (group.length < 2) continue;
    for (const r of group) {
      const base = `${r.slug}-${r.province.toLowerCase()}`;
      let candidate = base;
      let n = 2;
      while (seen.has(candidate)) {
        candidate = `${base}-${n}`;
        n += 1;
      }
      seen.add(candidate);
      r.slug = candidate;
    }
  }
  return records;
}

/** Apply the corridor + real-data filter and the population/proximity floor. */
export function buildDataset(all) {
  // Distribution check runs on the raw corridor rows, BEFORE the
  // placeholder-exclusion filter below drops population === 2000 rows —
  // otherwise a placeholder that dominates the input (issue #4922: 417/518
  // rows) would just get silently excluded here instead of failing the
  // build loud.
  const corridorRaw = all.filter(
    (m) => CORRIDOR_PROVINCES.includes(m.province) && Number.isFinite(m.population),
  );
  assertPlausibleDistribution(corridorRaw, { field: 'population', sourceLabel: 'fiscal-municipalities' });
  // avgRentMonthly rides along into every published record (see toRecord
  // below) with no source of its own, so it gets the same fail-loud
  // treatment as population — a coarser ceiling because the field is a
  // documented zone band rather than a per-comune figure, plus a floor on
  // granularity that the share check cannot express. Constants and the
  // reasoning for both numbers are at the top of this file.
  assertPlausibleDistribution(corridorRaw, {
    field: 'avgRentMonthly',
    maxShare: RENT_MAX_VALUE_SHARE,
    sourceLabel: 'fiscal-municipalities',
  });
  assertDistinctValueFloor(corridorRaw, {
    field: 'avgRentMonthly',
    minDistinct: RENT_MIN_DISTINCT_VALUES,
    sourceLabel: 'fiscal-municipalities',
  });

  const corridor = corridorRaw.filter(
    (m) =>
      m.population !== PLACEHOLDER_POPULATION &&
      Number.isFinite(m.irpefAddizionale) &&
      Number.isFinite(m.distanceKm),
  );
  for (const m of corridor) {
    assertPlausibleMunicipality(m, { sourceLabel: 'fiscal-municipalities' });
  }

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
  });

  const isAboveFloor = (m) => m.population >= MIN_POPULATION && m.distanceKm <= MAX_DISTANCE_KM;

  const byPopThenName = (a, b) => b.population - a.population || a.name.localeCompare(b.name);
  const aboveFloor = corridor.filter(isAboveFloor).map(toRecord).sort(byPopThenName);
  const belowFloor = corridor.filter((m) => !isAboveFloor(m)).map(toRecord).sort(byPopThenName);

  disambiguateHomonymSlugs([...aboveFloor, ...belowFloor]);

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

const invokedDirectly = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]); }
  catch { return false; }
})();

if (invokedDirectly) main();
