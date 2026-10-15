#!/usr/bin/env node
/**
 * Refresh the frontaliere public-holidays dataset (Ticino / Switzerland vs
 * Italy) used by `build-plugins/holidaysLandingsPlugin.ts`.
 *
 * Why a script (not a hand-written JSON)
 * --------------------------------------
 * The Easter-derived holidays (Good Friday, Easter Monday, Ascension, Whit
 * Monday, Corpus Christi) move every year. Hand-typing them is error-prone —
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
 * Sources of the holiday catalogue (which day is observed where):
 *   - Ticino cantonal public holidays: Legge cantonale sul lavoro / giorni
 *     festivi ufficiali del Cantone Ticino (15 giorni + Capodanno).
 *   - Italy national public holidays: L. 260/1949 e succ. mod. (festività
 *     nazionali; NON include le patronali comunali).
 * The observed-where flags are stable legislation, not survey data, so they are
 * encoded here rather than fetched.
 */

import fs from 'node:fs';
import np from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = np.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = np.resolve(__dirname, '..', 'data', 'seo', 'frontaliere-holidays.json');

/** Meeus/Jones/Butcher Gregorian Easter Sunday (UTC). */
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function iso(dt) {
  return dt.toISOString().slice(0, 10);
}

function addDays(dt, days) {
  const d = new Date(dt);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Holiday catalogue. `date(year)` returns an ISO string.
 *  - ticino: observed as a public holiday in Canton Ticino
 *  - italy:  observed as a national public holiday in Italy
 *  - swissFederal: one of the 4 nationwide Swiss holidays (info flag)
 */
const CATALOGUE = [
  { id: 'capodanno', ticino: true, italy: true, swissFederal: true, date: (y) => iso(new Date(Date.UTC(y, 0, 1))),
    name: { it: 'Capodanno', en: "New Year's Day", de: 'Neujahr', fr: 'Nouvel An' } },
  { id: 'epifania', ticino: true, italy: true, swissFederal: false, date: (y) => iso(new Date(Date.UTC(y, 0, 6))),
    name: { it: 'Epifania', en: 'Epiphany', de: 'Dreikönigstag', fr: 'Épiphanie' } },
  { id: 'venerdi-santo', ticino: true, italy: false, swissFederal: false, date: (y) => iso(addDays(easterSunday(y), -2)),
    name: { it: 'Venerdì Santo', en: 'Good Friday', de: 'Karfreitag', fr: 'Vendredi Saint' } },
  { id: 'lunedi-angelo', ticino: true, italy: true, swissFederal: false, date: (y) => iso(addDays(easterSunday(y), 1)),
    name: { it: "Lunedì dell'Angelo", en: 'Easter Monday', de: 'Ostermontag', fr: 'Lundi de Pâques' } },
  { id: 'liberazione', ticino: false, italy: true, swissFederal: false, date: (y) => iso(new Date(Date.UTC(y, 3, 25))),
    name: { it: 'Anniversario della Liberazione', en: 'Liberation Day (Italy)', de: 'Tag der Befreiung (Italien)', fr: 'Fête de la Libération (Italie)' } },
  { id: 'festa-lavoro', ticino: true, italy: true, swissFederal: false, date: (y) => iso(new Date(Date.UTC(y, 4, 1))),
    name: { it: 'Festa del Lavoro', en: 'Labour Day', de: 'Tag der Arbeit', fr: 'Fête du Travail' } },
  { id: 'ascensione', ticino: true, italy: false, swissFederal: true, date: (y) => iso(addDays(easterSunday(y), 39)),
    name: { it: 'Ascensione', en: 'Ascension Day', de: 'Auffahrt', fr: 'Ascension' } },
  { id: 'lunedi-pentecoste', ticino: true, italy: false, swissFederal: false, date: (y) => iso(addDays(easterSunday(y), 50)),
    name: { it: 'Lunedì di Pentecoste', en: 'Whit Monday', de: 'Pfingstmontag', fr: 'Lundi de Pentecôte' } },
  { id: 'corpus-domini', ticino: true, italy: false, swissFederal: false, date: (y) => iso(addDays(easterSunday(y), 60)),
    name: { it: 'Corpus Domini', en: 'Corpus Christi', de: 'Fronleichnam', fr: 'Fête-Dieu' } },
  { id: 'repubblica', ticino: false, italy: true, swissFederal: false, date: (y) => iso(new Date(Date.UTC(y, 5, 2))),
    name: { it: 'Festa della Repubblica', en: 'Republic Day (Italy)', de: 'Tag der Republik (Italien)', fr: 'Fête de la République (Italie)' } },
  { id: 'pietro-paolo', ticino: true, italy: false, swissFederal: false, date: (y) => iso(new Date(Date.UTC(y, 5, 29))),
    name: { it: 'Santi Pietro e Paolo', en: 'Saints Peter and Paul', de: 'Peter und Paul', fr: 'Saints Pierre et Paul' } },
  { id: 'festa-nazionale', ticino: true, italy: false, swissFederal: true, date: (y) => iso(new Date(Date.UTC(y, 7, 1))),
    name: { it: 'Festa nazionale svizzera', en: 'Swiss National Day', de: 'Bundesfeier', fr: 'Fête nationale suisse' } },
  { id: 'assunzione', ticino: true, italy: true, swissFederal: false, date: (y) => iso(new Date(Date.UTC(y, 7, 15))),
    name: { it: 'Assunzione di Maria', en: 'Assumption of Mary', de: 'Mariä Himmelfahrt', fr: 'Assomption' } },
  { id: 'ognissanti', ticino: true, italy: true, swissFederal: false, date: (y) => iso(new Date(Date.UTC(y, 10, 1))),
    name: { it: 'Ognissanti', en: "All Saints' Day", de: 'Allerheiligen', fr: 'Toussaint' } },
  { id: 'immacolata', ticino: true, italy: true, swissFederal: false, date: (y) => iso(new Date(Date.UTC(y, 11, 8))),
    name: { it: 'Immacolata Concezione', en: 'Immaculate Conception', de: 'Mariä Empfängnis', fr: 'Immaculée Conception' } },
  { id: 'natale', ticino: true, italy: true, swissFederal: true, date: (y) => iso(new Date(Date.UTC(y, 11, 25))),
    name: { it: 'Natale', en: 'Christmas Day', de: 'Weihnachten', fr: 'Noël' } },
  { id: 'santo-stefano', ticino: true, italy: true, swissFederal: false, date: (y) => iso(new Date(Date.UTC(y, 11, 26))),
    name: { it: 'Santo Stefano', en: "St Stephen's Day", de: 'Stephanstag', fr: 'Saint-Étienne' } },
];

function build(years) {
  const holidays = CATALOGUE.map((h) => {
    const dates = {};
    for (const y of years) dates[String(y)] = h.date(y);
    return {
      id: h.id,
      name: h.name,
      ticino: h.ticino,
      italy: h.italy,
      swissFederal: h.swissFederal,
      // Coincidence class from the frontaliere point of view (works in CH,
      // lives in IT): 'both' = free on both sides; 'ticino-only' = free in CH
      // but Italy works; 'italy-only' = Italy closed but the frontaliere works
      // in Switzerland.
      coincidence: h.ticino && h.italy ? 'both' : h.ticino ? 'ticino-only' : 'italy-only',
      dates,
    };
  });
  return {
    meta: {
      description:
        'Giorni festivi ufficiali di Canton Ticino / Svizzera e Italia, con classificazione di coincidenza per i frontalieri.',
      source:
        'Ticino: giorni festivi ufficiali cantonali. Italia: festività nazionali (L. 260/1949 e succ.). Date pasquali via algoritmo di Gauss/Meeus.',
      refreshScript: 'scripts/update-holidays-dataset.mjs',
      refreshCadence: 'annual',
      years,
      generatedAt: new Date().toISOString().slice(0, 10),
    },
    holidays,
  };
}

function main() {
  const now = new Date();
  const argYears = process.argv.slice(2).map((n) => parseInt(n, 10)).filter((n) => !Number.isNaN(n));
  const years = argYears.length >= 1 ? argYears : [now.getUTCFullYear(), now.getUTCFullYear() + 1];
  const data = build(years);
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
