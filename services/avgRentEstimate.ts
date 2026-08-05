/**
 * `Municipality.avgRentMonthly` — zone-level ESTIMATE, not a measured
 * per-comune figure (issue #4545 residual 4, same class as #4922 / #4875).
 *
 * The number is presented on maps, detail cards, rankings and indexed SSG
 * pages as if it were a per-comune observation. It is not, and the dataset
 * says so in two docblocks (`data/municipalities.ts` file header and the
 * field comment) — but nothing told the READER. Documentation the user never
 * sees is not disclosure.
 *
 * The committed data settles the question on its own: 518 comuni carry only
 * **32 distinct** rent values, and **483 of 518** share their value with at
 * least four other comuni (400 appears 135 times, 550 appears 118, 520 appears
 * 92, 450 appears 50). A field where 93 % of rows repeat a neighbour's number
 * is a per-fascia stand-in for "typical for this zone", exactly as the dataset
 * header states.
 *
 * Why a shared module rather than a note per component: the field is read by
 * seven SPA surfaces plus two SSG plugins, and the SSG pages are the INDEXED
 * ones. A disclosure that exists only in the SPA would drift on the side that
 * carries the traffic — Non-Negotiable #6. Mirrors the shape of
 * `services/irpefAddizionaleRegime.ts` (#4875): predicate + locale-native note
 * here, a React wrapper in `components/shared/AvgRentValue.tsx`, and
 * text-level helpers for the plugins that emit plain HTML.
 *
 * NOT a re-sourcing fix, deliberately. The #4922 pass looked for a verified
 * per-comune Italian rental source covering all 518 border comuni and found
 * none (ISTAT does not publish rents at this granularity); that finding is
 * recorded in `data/municipalities.ts`. Inventing per-comune rents to remove
 * the repetition would be fabricating data, which the corridor datasets
 * explicitly forbid. So the value stays and is labelled for what it is.
 *
 * SCOPE. This module covers `data/municipalities.ts` ONLY. The French corridor
 * (`data/frenchBorderMunicipalities.ts`) carries a genuinely sourced rent —
 * DGALN/DHUP "Carte des loyers" 2025, with `rentSource` and `rentObs`
 * observation counts per commune — and must NOT be labelled an estimate.
 */
import { MUNICIPALITIES } from '@/data/municipalities';

/** Only the fields this module needs, so callers can pass partial records. */
export interface RentBearingMunicipality {
  readonly avgRentMonthly: number;
}

/**
 * A rent value shared by at least this many comuni is demonstrably a
 * zone-level figure rather than a per-comune measurement. Five is deliberately
 * conservative: the real clusters are 135/118/92/50 comuni wide, so the
 * threshold separates the obvious stand-ins without needing a judgement call
 * about the long tail.
 */
export const SHARED_RENT_COHORT_THRESHOLD = 5;

/** value → how many comuni in the dataset carry it. Computed once at load. */
const RENT_VALUE_COHORTS: ReadonlyMap<number, number> = (() => {
  const counts = new Map<number, number>();
  for (const m of MUNICIPALITIES) {
    counts.set(m.avgRentMonthly, (counts.get(m.avgRentMonthly) ?? 0) + 1);
  }
  return counts;
})();

/** How many comuni share this comune's rent figure (itself included). */
export function sharedRentCohortSize(m: RentBearingMunicipality): number {
  return RENT_VALUE_COHORTS.get(m.avgRentMonthly) ?? 1;
}

/**
 * True when the figure is shared widely enough to be provably zone-level.
 * Note that EVERY value in this dataset is an estimate (see the header) — this
 * predicate only distinguishes the ones whose repetition makes the point
 * self-evident, so the note can be specific instead of hand-wavy.
 */
export function isSharedRentEstimate(m: RentBearingMunicipality): boolean {
  return sharedRentCohortSize(m) >= SHARED_RENT_COHORT_THRESHOLD;
}

type Locale = string;

function lang(locale: Locale): 'it' | 'en' | 'de' | 'fr' {
  const base = (locale || 'it').slice(0, 2).toLowerCase();
  return base === 'en' || base === 'de' || base === 'fr' ? base : 'it';
}

/** Short marker rendered next to the figure, e.g. "stima". */
export function rentEstimateLabel(locale: Locale): string {
  return { it: 'stima', en: 'estimate', de: 'Schätzung', fr: 'estimation' }[lang(locale)];
}

/**
 * The disclosure itself. When the value is a wide-cohort one the note says how
 * many comuni share it — a checkable fact from the committed data, which is
 * more informative (and harder to quietly invalidate) than the word "approx".
 */
export function rentEstimateNote(m: RentBearingMunicipality, locale: Locale): string {
  const cohort = sharedRentCohortSize(m);
  const shared = cohort >= SHARED_RENT_COHORT_THRESHOLD;
  switch (lang(locale)) {
    case 'en':
      return shared
        ? `Zone-level estimate, not a measured figure for this town: the same value is used for ${cohort} municipalities in the dataset. Indicative only.`
        : 'Zone-level estimate, not a measured figure for this town. Indicative only.';
    case 'de':
      return shared
        ? `Schätzung auf Zonenebene, kein für diesen Ort gemessener Wert: derselbe Betrag wird für ${cohort} Gemeinden im Datensatz verwendet. Nur als Anhaltspunkt.`
        : 'Schätzung auf Zonenebene, kein für diesen Ort gemessener Wert. Nur als Anhaltspunkt.';
    case 'fr':
      return shared
        ? `Estimation au niveau de la zone, et non une valeur mesurée pour cette commune : la même valeur est utilisée pour ${cohort} communes du jeu de données. À titre indicatif uniquement.`
        : 'Estimation au niveau de la zone, et non une valeur mesurée pour cette commune. À titre indicatif uniquement.';
    default:
      return shared
        ? `Stima di zona, non un dato rilevato per questo comune: lo stesso valore è usato per ${cohort} comuni del dataset. Solo indicativo.`
        : 'Stima di zona, non un dato rilevato per questo comune. Solo indicativo.';
  }
}

/**
 * `title` attribute value for a static-HTML rent cell — the SSG counterpart of
 * `components/shared/AvgRentValue.tsx`, for the plugins that emit plain HTML
 * and cannot mount React (`build-plugins/borderMunicipalityPagesPlugin.ts`).
 * Always returns the note: unlike the IRPEF case there is no subset of "real"
 * values to leave unmarked.
 */
export function rentDisplayTitle(m: RentBearingMunicipality, locale: Locale): string {
  return rentEstimateNote(m, locale);
}

/** Caption suffix for a metric tile, e.g. "bilocale mensile indicativo · stima di zona". */
export function rentCaptionSuffix(m: RentBearingMunicipality, locale: Locale): string {
  const cohort = sharedRentCohortSize(m);
  const shared = cohort >= SHARED_RENT_COHORT_THRESHOLD;
  switch (lang(locale)) {
    case 'en':
      return shared ? `zone estimate (shared by ${cohort} municipalities)` : 'zone estimate';
    case 'de':
      return shared ? `Zonenschätzung (für ${cohort} Gemeinden verwendet)` : 'Zonenschätzung';
    case 'fr':
      return shared ? `estimation de zone (partagée par ${cohort} communes)` : 'estimation de zone';
    default:
      return shared ? `stima di zona (condivisa da ${cohort} comuni)` : 'stima di zona';
  }
}

/**
 * Axis-level note, for surfaces that use rent as a COLOUR SCALE or a SORT KEY
 * rather than printing one comune's figure. Those turn the estimate into a
 * comparison: with only 32 distinct values across 518 comuni the axis has far
 * fewer real steps than the ranking implies, so ties are common and small
 * gaps are artifacts of the zone bucketing, not of the housing market.
 *
 * The axis is kept — it is still the best available rent signal, and dropping
 * it would remove information rather than add honesty — but it is labelled.
 */
export function rentAxisNote(locale: Locale): string {
  switch (lang(locale)) {
    case 'en':
      return 'Rent is a zone-level estimate: the dataset holds only 32 distinct values for 518 municipalities, so ranking on this axis produces many ties and small gaps are not meaningful.';
    case 'de':
      return 'Die Miete ist eine Schätzung auf Zonenebene: der Datensatz enthält nur 32 verschiedene Werte für 518 Gemeinden — Ranglisten auf dieser Achse ergeben viele Gleichstände, kleine Unterschiede sind nicht aussagekräftig.';
    case 'fr':
      return "Le loyer est une estimation au niveau de la zone : le jeu de données ne contient que 32 valeurs distinctes pour 518 communes, donc ce classement produit de nombreux ex aequo et les petits écarts ne sont pas significatifs.";
    default:
      return 'L\'affitto è una stima di zona: il dataset contiene solo 32 valori distinti per 518 comuni, quindi ordinare su questo asse produce molti pari merito e le differenze piccole non sono significative.';
  }
}
