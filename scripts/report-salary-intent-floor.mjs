#!/usr/bin/env node
/**
 * One-off analysis for issue #4460 (epic #4459): counts how many
 * (profession × canton) pairs would clear a real-data floor for the
 * proposed "stipendio {professione} {cantone}" salary-intent family,
 * reusing the SAME aggregation the live /lavoro-{canton}-{role}/ family
 * uses (aggregateProfessionJobsByCanton) so the count isn't a fresh
 * heuristic — it's the actual corpus.
 *
 * Floor = MIN_JOBS real active jobs for the pair (same MIN_JOBS=3 as
 * professionCantonLandings.ts) AND a profession-specific real median
 * available (data/profession-salary-medians.json presets — TI-scoped,
 * scaled to other cantons via cantonSalaryIndex factor). Professions
 * without a preset are excluded outright: showing a canton's generic
 * median under a profession-specific headline ("stipendio infermiere
 * ginevra") when the number is actually the canton's ALL-jobs median
 * would misrepresent the page's own premise.
 *
 * Run: npx tsx scripts/report-salary-intent-floor.mjs
 */
import { aggregateProfessionJobsByCanton } from '../build-plugins/professionJobsAggregate.ts';
import { PROFESSION_CANTON_KEYS } from '../build-plugins/professionCantonData.ts';
import medians from '../data/profession-salary-medians.json' with { type: 'json' };

const MIN_JOBS = 3;
const LOCALES = ['it', 'en', 'de', 'fr'];

const medianProfessionIds = new Set(medians.presets.map((p) => p.id));
const byCanton = aggregateProfessionJobsByCanton(process.cwd());

const pairs = [];
for (const cantonKey of PROFESSION_CANTON_KEYS) {
  const perProfession = byCanton[cantonKey];
  if (!perProfession) continue;
  for (const id of medianProfessionIds) {
    const snapshot = perProfession[id];
    if (!snapshot || snapshot.liveCount < MIN_JOBS) continue;
    pairs.push({ cantonKey, id, liveCount: snapshot.liveCount });
  }
}

pairs.sort((a, b) => a.cantonKey.localeCompare(b.cantonKey) || a.id.localeCompare(b.id));

console.log(`Cantons in scope (excl. TI): ${PROFESSION_CANTON_KEYS.length}`);
console.log(`Professions with real median preset: ${medianProfessionIds.size} / 29 (${[...medianProfessionIds].join(', ')})`);
console.log(`Theoretical max pairs (cantons × median-professions): ${PROFESSION_CANTON_KEYS.length * medianProfessionIds.size}`);
console.log(`Post-floor pairs (>= ${MIN_JOBS} real jobs): ${pairs.length}`);
console.log(`Pages per locale: ${pairs.length} (x${LOCALES.length} locales = ${pairs.length * LOCALES.length} total URLs)`);
console.log('');
console.log('By profession:');
for (const id of medianProfessionIds) {
  const count = pairs.filter((p) => p.id === id).length;
  console.log(`  ${id}: ${count} cantons clear the floor`);
}
console.log('');
console.log('Pairs:');
for (const p of pairs) {
  console.log(`  ${p.cantonKey} x ${p.id}: ${p.liveCount} jobs`);
}
