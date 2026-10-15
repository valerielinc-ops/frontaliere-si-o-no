#!/usr/bin/env node
/**
 * Refresh the BFS/OFS salary-by-age / salary-by-education dataset used by
 * `build-plugins/bfsSalaryLandingsPlugin.ts`.
 *
 * Source
 * ------
 * Swiss Federal Statistical Office (BFS/OFS) — Swiss Earnings Structure Survey
 * (RSS / LSE), STAT-TAB (PxWeb API, free, no key). The median gross monthly
 * wage (standardised to 4⅓ weeks, full private + public sector, Switzerland
 * total) is published by:
 *
 *   - age class      → cube px-x-0304010000_101  ("Salaire mensuel brut
 *                       (valeur médiane) selon les classes d'âge")
 *   - education level → cube px-x-0304010000_112  ("... selon le niveau de
 *                       formation")
 *
 * PxWeb endpoint (metadata is a GET, data is a POST with a JSON query):
 *
 *   https://www.pxweb.bfs.admin.ch/api/v1/it/px-x-0304010000_101/px-x-0304010000_101.px
 *
 * The published LSE wave is biennial (2018, 2020, 2022, next 2024 expected
 * ~2026). This is a ONE-TIME / ON-NEW-WAVE refresh, not a daily crawler —
 * hence a committed dataset rather than a runtime fetch.
 *
 * Refresh cadence: on each new LSE wave (~every 2 years). Run:
 *
 *     node scripts/update-bfs-salary-by-age.mjs
 *
 * and update the median values below from the newest cube, bumping `waveYear`.
 * Values are stored as the BFS median gross monthly wage in CHF (integer).
 *
 * NOTE ON PRECISION: the site renders these with a leading "≈" and always
 * labels them as BFS LSE medians (gross, standardised) — never as a personal
 * net salary. The salary calculator CTA takes the user to a personalised net
 * estimate.
 */

import fs from 'node:fs';
import np from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = np.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = np.resolve(__dirname, '..', 'data', 'seo', 'bfs-salary-by-age.json');

// LSE 2022 median gross monthly wage (CHF), Switzerland total, private+public,
// standardised — from BFS STAT-TAB cube px-x-0304010000_101 (age) and
// px-x-0304010000_112 (education). Update these on the next LSE wave.
const WAVE_YEAR = 2022;
const NATIONAL_MEDIAN_CHF = 6788; // BFS LSE 2022 overall median gross monthly.

const AGE_BANDS = [
  { id: '20-29', label: '20–29', medianChf: 5500, anchorAges: [20, 25] },
  { id: '30-39', label: '30–39', medianChf: 6600, anchorAges: [30, 35] },
  { id: '40-49', label: '40–49', medianChf: 7100, anchorAges: [40, 45] },
  { id: '50-59', label: '50–59', medianChf: 7000, anchorAges: [50, 55] },
  { id: '60plus', label: '60+', medianChf: 6900, anchorAges: [60] },
];

const EDUCATION_LEVELS = [
  {
    id: 'scuola-obbligatoria',
    medianChf: 5300,
    name: {
      it: 'Scuola dell’obbligo',
      en: 'Compulsory education only',
      de: 'Obligatorische Schule',
      fr: 'Scolarité obligatoire',
    },
  },
  {
    id: 'apprendistato-afc',
    medianChf: 6100,
    name: {
      it: 'Apprendistato (AFC)',
      en: 'Vocational apprenticeship (VET)',
      de: 'Berufslehre (EFZ)',
      fr: 'Apprentissage (CFC)',
    },
  },
  {
    id: 'formazione-superiore',
    medianChf: 7900,
    name: {
      it: 'Formazione professionale superiore',
      en: 'Higher vocational education',
      de: 'Höhere Berufsbildung',
      fr: 'Formation professionnelle supérieure',
    },
  },
  {
    id: 'universita',
    medianChf: 9500,
    name: {
      it: 'Università / SUP',
      // Was 'University / University of Applied Sciences' (45 char) — the
      // odd one out among these four EN labels (all otherwise compact
      // two-noun forms, matching the DE/FR siblings below) and the only one
      // long enough to push the "Salary in Switzerland with {name}" title
      // template (build-plugins/bfsSalaryLandingsPlugin.ts) past the
      // audit-title-length.mjs 66-char cap: 73 char, see issue #5355. `name`
      // feeds <title> AND <h1> from the SAME template, so shortening it here
      // (rather than adding a title-only override) keeps them identical and
      // routed through the normal differentiateH1FromTitle tag-append below
      // — the fix tests/bfs-salary-border-hub-h1-title-differentiation.test.ts
      // already pins for this whole producer family.
      en: 'University / Applied Sciences',
      de: 'Universität / Fachhochschule',
      fr: 'Université / Haute école',
    },
  },
];

function build() {
  return {
    meta: {
      description:
        'Salario mensile lordo mediano in Svizzera per classe d’età e livello di formazione (BFS/OFS, Rilevazione della struttura dei salari).',
      source: 'BFS/OFS — Rilevazione svizzera della struttura dei salari (RSS/LSE), STAT-TAB',
      cubes: {
        age: 'px-x-0304010000_101',
        education: 'px-x-0304010000_112',
      },
      pxwebEndpoint: 'https://www.pxweb.bfs.admin.ch/api/v1/it/',
      waveYear: WAVE_YEAR,
      currency: 'CHF',
      basis: 'median gross monthly wage, standardised (4⅓ weeks), Switzerland total, private + public sector',
      refreshScript: 'scripts/update-bfs-salary-by-age.mjs',
      refreshCadence: 'per-lse-wave',
      generatedAt: new Date().toISOString().slice(0, 10),
    },
    nationalMedianChf: NATIONAL_MEDIAN_CHF,
    ageBands: AGE_BANDS,
    educationLevels: EDUCATION_LEVELS,
  };
}

function main() {
  const data = build();
  fs.mkdirSync(np.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  console.log(
    `[bfs-salary] wrote ${data.ageBands.length} age bands + ${data.educationLevels.length} education levels ` +
      `(LSE ${WAVE_YEAR}, national median CHF ${NATIONAL_MEDIAN_CHF}) → ${np.relative(process.cwd(), OUT_PATH)}`,
  );
}

main();
