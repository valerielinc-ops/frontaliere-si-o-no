#!/usr/bin/env node
/**
 * generate-profession-salary-medians
 *
 * Computes the calculator's "1-tap profession preset" chips from the live
 * jobs dataset — issue #4307. Writes `data/profession-salary-medians.json`,
 * a small, committed, GENERATED file (never hand-edit the numbers in it).
 *
 * Reuses the existing profession taxonomy + median computation instead of
 * re-implementing either:
 *  - `aggregateProfessionJobs()` (build-plugins/professionJobsAggregate.ts)
 *    already matches every job in data/jobs.json against the 24-profession
 *    taxonomy (title regex, TI-scoped) and computes `medianSalaryChf` via
 *    `realSalaryMedianChf()` (build-plugins/shared/realSalaryMedian.ts) —
 *    the SAME median logic the profession-landing pages (/lavoro-ticino-*)
 *    already show, so the preset chips never drift from that number.
 *
 * Picks the top N professions by live job count that also have a real
 * (non-null, ≥3-sample) median, so the chips always reflect actual on-site
 * demand rather than an arbitrary hand list.
 *
 * Run: npx tsx scripts/generate-profession-salary-medians.mjs
 */
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { aggregateProfessionJobs, _resetProfessionJobsAggregateCache } from '../build-plugins/professionJobsAggregate.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** Max chips shown on the calculator (issue #4307 scope: 5-8). */
const MAX_PRESETS = 8;
/** Below this live count a profession isn't "common" enough for a 1-tap chip. */
const MIN_LIVE_COUNT = 5;

/**
 * Display label per locale for each profession id. Copy sourced from the
 * SAME role terms already used by the profession-landing H1s
 * (build-plugins/professionLandingsCopy.ts `role` field) — kept as a small
 * literal map here (content, not logic) so this generator has no runtime
 * dependency on that build-plugin's private per-locale copy tables.
 */
const PROFESSION_LABELS = {
  infermiere: { it: 'Infermiere', en: 'Nurse', de: 'Pflegefachperson', fr: 'Infirmier·ère' },
  operaio: { it: 'Operaio', en: 'Factory worker', de: 'Produktionsmitarbeiter', fr: 'Ouvrier' },
  impiegato: { it: 'Impiegato', en: 'Office clerk', de: 'Kaufmännischer Angestellter', fr: 'Employé de bureau' },
  ingegnere: { it: 'Ingegnere', en: 'Engineer', de: 'Ingenieur', fr: 'Ingénieur' },
  educatore: { it: 'Educatore', en: 'Social educator', de: 'Sozialpädagoge', fr: 'Éducateur' },
  autista: { it: 'Autista', en: 'Driver', de: 'Fahrer', fr: 'Chauffeur' },
  muratore: { it: 'Muratore', en: 'Construction worker', de: 'Maurer', fr: 'Maçon' },
  cuoco: { it: 'Cuoco', en: 'Cook', de: 'Koch', fr: 'Cuisinier' },
  cameriere: { it: 'Cameriere', en: 'Waiter', de: 'Kellner', fr: 'Serveur' },
  elettricista: { it: 'Elettricista', en: 'Electrician', de: 'Elektriker', fr: 'Électricien' },
  psicologo: { it: 'Psicologo', en: 'Psychologist', de: 'Psychologe', fr: 'Psychologue' },
  fisioterapista: { it: 'Fisioterapista', en: 'Physiotherapist', de: 'Physiotherapeut', fr: 'Physiothérapeute' },
  logopedista: { it: 'Logopedista', en: 'Speech therapist', de: 'Logopäde', fr: 'Orthophoniste' },
  farmacista: { it: 'Farmacista', en: 'Pharmacist', de: 'Apotheker', fr: 'Pharmacien' },
  ostetrica: { it: 'Ostetrica', en: 'Midwife', de: 'Hebamme', fr: 'Sage-femme' },
  'assistente-dentale': { it: 'Assistente dentale', en: 'Dental assistant', de: 'Dentalassistent', fr: 'Assistant dentaire' },
  'tecnico-radiologia': { it: 'Tecnico di radiologia', en: 'Radiology technician', de: 'Radiologiefachperson', fr: 'Technicien en radiologie' },
  oss: { it: 'Operatore socio sanitario', en: 'Healthcare assistant', de: 'Fachfrau/-mann Gesundheit', fr: 'Assistant en soins' },
  'ottico-optometrista': { it: 'Ottico optometrista', en: 'Optician', de: 'Optiker', fr: 'Opticien' },
  contabile: { it: 'Contabile', en: 'Accountant', de: 'Buchhalter', fr: 'Comptable' },
  'assistente-sociale': { it: 'Assistente sociale', en: 'Social worker', de: 'Sozialarbeiter', fr: 'Assistant social' },
  macellaio: { it: 'Macellaio', en: 'Butcher', de: 'Metzger', fr: 'Boucher' },
  saldatore: { it: 'Saldatore', en: 'Welder', de: 'Schweisser', fr: 'Soudeur' },
  architetto: { it: 'Architetto', en: 'Architect', de: 'Architekt', fr: 'Architecte' },
};

function main() {
  _resetProfessionJobsAggregateCache();
  const snapshots = aggregateProfessionJobs(ROOT);

  const candidates = Object.entries(snapshots)
    .map(([id, snap]) => ({ id, liveCount: snap.liveCount, medianSalaryChf: snap.medianSalaryChf }))
    .filter((c) => c.medianSalaryChf !== null && c.liveCount >= MIN_LIVE_COUNT)
    .sort((a, b) => b.liveCount - a.liveCount)
    .slice(0, MAX_PRESETS);

  if (candidates.length === 0) {
    console.error('[generate-profession-salary-medians] no profession cleared the floor — aborting write.');
    process.exit(1);
  }

  const presets = candidates.map((c) => {
    const label = PROFESSION_LABELS[c.id];
    if (!label) {
      throw new Error(`[generate-profession-salary-medians] missing PROFESSION_LABELS entry for "${c.id}" — add it before regenerating.`);
    }
    return {
      id: c.id,
      label,
      medianSalaryChf: c.medianSalaryChf,
      liveCount: c.liveCount,
    };
  });

  const out = {
    generatedAt: new Date().toISOString(),
    source: 'data/jobs.json via build-plugins/professionJobsAggregate.ts#aggregateProfessionJobs (TI-scoped)',
    minLiveCount: MIN_LIVE_COUNT,
    presets,
  };

  const outPath = path.join(ROOT, 'data', 'profession-salary-medians.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  console.log(`[generate-profession-salary-medians] wrote ${presets.length} presets to ${path.relative(ROOT, outPath)}`);
  for (const p of presets) {
    console.log(`  ${p.id}: median CHF ${p.medianSalaryChf} (n=${p.liveCount})`);
  }
}

main();
