/**
 * Catalogo dei giorni festivi Ticino / Italia — UNA sorgente per lo script
 * `scripts/update-holidays-dataset.mjs` (che scrive il JSON committato) e per
 * `build-plugins/holidaysLandingsPlugin.ts` (che calcola gli anni dalla data di
 * build, così il cambio d'anno non dipende più da un refresh manuale).
 *
 * Fonti (quale giorno vale dove):
 *   - Ticino: «Legge concernente i giorni festivi ufficiali nel Cantone Ticino»
 *     del 15 dicembre 2009, elenco pubblicato dal Cantone (DFE, Ufficio
 *     dell'ispettorato del lavoro): {@link TICINO_HOLIDAYS_SOURCE_URL}.
 *     15 giorni: Capodanno, Epifania, San Giuseppe, Lunedì di Pasqua, 1° maggio,
 *     Ascensione, Lunedì di Pentecoste, Corpus Domini, SS. Pietro e Paolo,
 *     1° agosto, Assunzione, Ognissanti, Immacolata, Natale, Santo Stefano.
 *     Il Venerdì Santo NON è festivo ufficiale in Ticino (verificato sull'elenco
 *     cantonale 2026 e 2027).
 *   - Italia: festività nazionali (L. 260/1949 e succ. mod.), senza patronali.
 * Le date pasquali sono calcolate (Meeus/Jones/Butcher), mai digitate a mano.
 */

export const TICINO_HOLIDAYS_SOURCE_URL = 'https://www4.ti.ch/dfe/de/uil/legge-lavoro/giorni-festivi-in-ticino-1';
export const TICINO_HOLIDAYS_LAW = 'Legge concernente i giorni festivi ufficiali nel Cantone Ticino (15 dicembre 2009)';

/** Meeus/Jones/Butcher Gregorian Easter Sunday (UTC). */
export function easterSunday(year) {
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

const fixed = (month, day) => (y) => iso(new Date(Date.UTC(y, month - 1, day)));
const fromEaster = (offset) => (y) => iso(addDays(easterSunday(y), offset));

/**
 * Holiday catalogue. `date(year)` returns an ISO string.
 *  - ticino: official public holiday in Canton Ticino (cantonal law)
 *  - italy:  national public holiday in Italy
 *  - swissFederal: one of the 4 nationwide Swiss holidays (info flag)
 */
export const HOLIDAY_CATALOGUE = [
  { id: 'capodanno', ticino: true, italy: true, swissFederal: true, date: fixed(1, 1),
    name: { it: 'Capodanno', en: "New Year's Day", de: 'Neujahr', fr: 'Nouvel An' } },
  { id: 'epifania', ticino: true, italy: true, swissFederal: false, date: fixed(1, 6),
    name: { it: 'Epifania', en: 'Epiphany', de: 'Dreikönigstag', fr: 'Épiphanie' } },
  { id: 'san-giuseppe', ticino: true, italy: false, swissFederal: false, date: fixed(3, 19),
    name: { it: 'San Giuseppe', en: "St Joseph's Day", de: 'Josefstag', fr: 'Saint-Joseph' } },
  { id: 'lunedi-angelo', ticino: true, italy: true, swissFederal: false, date: fromEaster(1),
    name: { it: "Lunedì dell'Angelo", en: 'Easter Monday', de: 'Ostermontag', fr: 'Lundi de Pâques' } },
  { id: 'liberazione', ticino: false, italy: true, swissFederal: false, date: fixed(4, 25),
    name: { it: 'Anniversario della Liberazione', en: 'Liberation Day (Italy)', de: 'Tag der Befreiung (Italien)', fr: 'Fête de la Libération (Italie)' } },
  { id: 'festa-lavoro', ticino: true, italy: true, swissFederal: false, date: fixed(5, 1),
    name: { it: 'Festa del Lavoro', en: 'Labour Day', de: 'Tag der Arbeit', fr: 'Fête du Travail' } },
  { id: 'ascensione', ticino: true, italy: false, swissFederal: true, date: fromEaster(39),
    name: { it: 'Ascensione', en: 'Ascension Day', de: 'Auffahrt', fr: 'Ascension' } },
  { id: 'lunedi-pentecoste', ticino: true, italy: false, swissFederal: false, date: fromEaster(50),
    name: { it: 'Lunedì di Pentecoste', en: 'Whit Monday', de: 'Pfingstmontag', fr: 'Lundi de Pentecôte' } },
  { id: 'corpus-domini', ticino: true, italy: false, swissFederal: false, date: fromEaster(60),
    name: { it: 'Corpus Domini', en: 'Corpus Christi', de: 'Fronleichnam', fr: 'Fête-Dieu' } },
  { id: 'repubblica', ticino: false, italy: true, swissFederal: false, date: fixed(6, 2),
    name: { it: 'Festa della Repubblica', en: 'Republic Day (Italy)', de: 'Tag der Republik (Italien)', fr: 'Fête de la République (Italie)' } },
  { id: 'pietro-paolo', ticino: true, italy: false, swissFederal: false, date: fixed(6, 29),
    name: { it: 'Santi Pietro e Paolo', en: 'Saints Peter and Paul', de: 'Peter und Paul', fr: 'Saints Pierre et Paul' } },
  { id: 'festa-nazionale', ticino: true, italy: false, swissFederal: true, date: fixed(8, 1),
    name: { it: 'Festa nazionale svizzera', en: 'Swiss National Day', de: 'Bundesfeier', fr: 'Fête nationale suisse' } },
  { id: 'assunzione', ticino: true, italy: true, swissFederal: false, date: fixed(8, 15),
    name: { it: 'Assunzione di Maria', en: 'Assumption of Mary', de: 'Mariä Himmelfahrt', fr: 'Assomption' } },
  { id: 'ognissanti', ticino: true, italy: true, swissFederal: false, date: fixed(11, 1),
    name: { it: 'Ognissanti', en: "All Saints' Day", de: 'Allerheiligen', fr: 'Toussaint' } },
  { id: 'immacolata', ticino: true, italy: true, swissFederal: false, date: fixed(12, 8),
    name: { it: 'Immacolata Concezione', en: 'Immaculate Conception', de: 'Mariä Empfängnis', fr: 'Immaculée Conception' } },
  { id: 'natale', ticino: true, italy: true, swissFederal: true, date: fixed(12, 25),
    name: { it: 'Natale', en: 'Christmas Day', de: 'Weihnachten', fr: 'Noël' } },
  { id: 'santo-stefano', ticino: true, italy: true, swissFederal: false, date: fixed(12, 26),
    name: { it: 'Santo Stefano', en: "St Stephen's Day", de: 'Stephanstag', fr: 'Saint-Étienne' } },
];

/**
 * Month (1-12) from which the searched year is the NEXT one. Search Console
 * (L28 al 2026-10-23) shows the «2027» queries already outnumbering «2026»
 * ones by ~5:1 in October: from September the page leads with next year.
 */
export const NEXT_YEAR_FOCUS_FROM_MONTH = 9;

/** The calendar year a reader is most likely looking for at `now`. */
export function holidayFocusYear(now) {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() + 1 >= NEXT_YEAR_FOCUS_FROM_MONTH ? y + 1 : y;
}

/** The two calendar years covered at `now`: current year and the next one. */
export function holidayYearsFor(now) {
  const y = now.getUTCFullYear();
  return [y, y + 1];
}

/**
 * Build the dataset for `years`. Same shape as data/seo/frontaliere-holidays.json.
 * `generatedAt` is passed in so the output is deterministic for a given input.
 */
export function buildHolidaysDataset(years, generatedAt) {
  const holidays = HOLIDAY_CATALOGUE.map((h) => {
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
        `Ticino: ${TICINO_HOLIDAYS_LAW}, ${TICINO_HOLIDAYS_SOURCE_URL}. Italia: festività nazionali (L. 260/1949 e succ.). Date pasquali via algoritmo di Meeus/Jones/Butcher.`,
      refreshScript: 'scripts/update-holidays-dataset.mjs',
      refreshCadence: 'annual',
      years: [...years],
      generatedAt,
    },
    holidays,
  };
}
