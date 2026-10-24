#!/usr/bin/env node
/**
 * Refresh the frontaliere public-holidays dataset (Ticino / Switzerland vs
 * Italy) used by `build-plugins/holidaysLandingsPlugin.ts`.
 *
 * Why a script (not a hand-written JSON)
 * --------------------------------------
 * The Easter-derived holidays (Easter Monday, Ascension, Whit Monday,
 * Corpus Christi) move every year. Hand-typing them is error-prone —
 * a single wrong date on a frontaliere calendar is a trust-killer. This script
 * computes every date deterministically (fixed dates + the Meeus/Jones/Butcher
 * Gregorian Easter algorithm) so the committed dataset is always internally
 * consistent.
 *
 * Refresh cadence: ANNUAL. Run once when the current calendar year rolls over
 * so the dataset always covers `currentYear` + `currentYear + 1`:
 *
 *     node scripts/update-holidays-dataset.mjs            # writes current + next year
 *     node scripts/update-holidays-dataset.mjs 2027 2028  # explicit year span
 *
 * Output: data/seo/frontaliere-holidays.json (committed).
 *
 * The catalogue (which day is observed where, with sources) and the date
 * computation live in build-plugins/shared/ticinoHolidaysCatalog.mjs, shared
 * with build-plugins/holidaysLandingsPlugin.ts — which derives its years from
 * the build date, so the landing no longer waits for this refresh to roll over.
 * This JSON stays as the committed, reviewable snapshot of that catalogue.
 */

import fs from 'node:fs';
import np from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHolidaysDataset, holidayYearsFor } from '../build-plugins/shared/ticinoHolidaysCatalog.mjs';

const __dirname = np.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = np.resolve(__dirname, '..', 'data', 'seo', 'frontaliere-holidays.json');

function main() {
  const now = new Date();
  const argYears = process.argv.slice(2).map((n) => parseInt(n, 10)).filter((n) => !Number.isNaN(n));
  const years = argYears.length >= 1 ? argYears : holidayYearsFor(now);
  const data = buildHolidaysDataset(years, now.toISOString().slice(0, 10));
  fs.mkdirSync(np.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  const tiOnly = data.holidays.filter((h) => h.coincidence === 'ticino-only').length;
  const itOnly = data.holidays.filter((h) => h.coincidence === 'italy-only').length;
  console.log(
    `[holidays] wrote ${data.holidays.length} holidays for years ${years.join(', ')} → ${np.relative(process.cwd(), OUT_PATH)} ` +
      `(${tiOnly} Ticino-only, ${itOnly} Italy-only non-coincident)`,
  );
}

main();
