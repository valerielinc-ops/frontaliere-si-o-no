/**
 * Key facts about the site and its audience — ONE source, cited.
 *
 * The site stated three founding years (2023 in the Organization JSON-LD, 2024
 * on /chi-siamo/), "79.000", "78.000" and "oltre 80.000" frontalieri, and
 * "28%", "29%" or "30%" of the cantonal workforce, often with a "+2-3% per
 * year" growth that the official series contradicts (USTAT: downward trend over
 * the last two years). Every surface now reads these values from here, or is
 * held to them by `tests/key-facts-single-source.test.ts`.
 *
 * Source of the labour figures: USTAT, Notiziario statistico 2026-18 «Il
 * mercato del lavoro, Ticino, primo trimestre 2026» (28 May 2026), table T.1,
 * from the UST cross-border commuter statistics (STAF). The workforce share is
 * our computation on that table (frontalieri / employed persons under the
 * domestic concept); USTAT notes the two series use different definitions, so
 * it is stated as an approximation.
 */

import { ORGANIZATION_FOUNDING_DATE } from './organizationLd';

export type KeyFactsLocale = 'it' | 'en' | 'de' | 'fr';

export const KEY_FACTS_SOURCE = Object.freeze({
  name: 'USTAT — Notiziario statistico 2026-18 (STAF, UST)',
  url: 'https://www3.ti.ch/DFE/DR/USTAT/allegati/news/259587ns_2026-18.pdf',
  publisher: 'Ufficio di statistica del Cantone Ticino (USTAT)',
  datePublished: '2026-05-28',
  period: { it: 'I trimestre 2026', en: 'Q1 2026', de: '1. Quartal 2026', fr: '1er trimestre 2026' } as Record<KeyFactsLocale, string>,
});

/** Frontalieri working in Canton Ticino, Q1 2026 (USTAT T.1, source STAF/UST). */
export const TICINO_CROSS_BORDER_WORKERS = 78_561;
/** Employed persons in Ticino, domestic concept, Q1 2026 (USTAT T.1). */
export const TICINO_EMPLOYED_DOMESTIC = 244_531;
/** Year-on-year change of frontalieri, Q1 2026 (USTAT T.1), in percent. */
export const TICINO_CROSS_BORDER_YOY_PERCENT = -0.5;

/** Rounded to the thousand — the only headcount the copy may state. */
export const TICINO_CROSS_BORDER_WORKERS_ROUNDED = Math.round(TICINO_CROSS_BORDER_WORKERS / 1000) * 1000; // 79 000
/** Share of employed persons, rounded percent — the only share the copy may state. */
export const TICINO_CROSS_BORDER_SHARE_PERCENT = Math.round((TICINO_CROSS_BORDER_WORKERS / TICINO_EMPLOYED_DOMESTIC) * 100); // 32

/** Founding year of Frontaliere Ticino, as stated on /chi-siamo/ and in Organization JSON-LD. */
export const FOUNDING_YEAR = ORGANIZATION_FOUNDING_DATE;

/** Locale-formatted headcount ("79.000", "79,000", "79 000"). */
export function formatCrossBorderWorkers(locale: KeyFactsLocale): string {
  const n = TICINO_CROSS_BORDER_WORKERS_ROUNDED;
  if (locale === 'en') return n.toLocaleString('en-US');
  if (locale === 'fr') return n.toLocaleString('en-US').replace(',', ' ');
  return n.toLocaleString('en-US').replace(',', '.');
}
