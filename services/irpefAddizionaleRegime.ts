/**
 * IRPEF *addizionale comunale* regime — single source of truth (issue #4875).
 *
 * `Municipality.irpefAddizionale` is a per-comune municipal surcharge rate.
 * For 51 of the 518 border comuni in `data/municipalities.ts` the value is
 * `0`, and those 51 are EXACTLY the comuni with `province: 'AO'` — the whole
 * Valle d'Aosta present in the dataset. That zero is not missing data (unlike
 * the `population: 2000` placeholder fixed in #4922): Valle d'Aosta is a
 * region with a special statute (Statuto speciale, l. cost. 4/1948) and
 * levies no comunal IRPEF surcharge at all. It is a real zero produced by a
 * DIFFERENT tax regime.
 *
 * Why that matters, and why this module exists.
 * A `0` that means "not subject to this tax" is not comparable with a `0.55`
 * that means "0.55 % of taxable income". Every surface that ranked, coloured
 * or min-max normalised the raw number silently treated the two as the same
 * scale, so the 51 Valdostan comuni took the BEST value on the fiscal axis of
 * every ranking and the greenest marker on the map — not because they are
 * cheaper for the reader, but because they are not in the comparison. The user
 * is never told this, and cannot tell from the number.
 *
 * The corrective is a shared predicate, not a copy-pasted `if (province ===
 * 'AO')` in each of the seven components that read this field
 * (BorderMunicipalitiesMap, FrontierGuide, PermitCompare, UserProfile,
 * LivabilityIndex, LivabilityMap, ResidencySimulator). Non-Negotiable #6:
 * a guard duplicated in ≥2 files must live in ONE module, or it drifts.
 *
 * SCOPE NOTE. This module deliberately does NOT classify "aliquota media
 * effettiva (progressiva)" vs "aliquota unica statutaria" — the
 * `noteType: 'progressive' | 'noTax'` split the original issue text assumed.
 * That split is not derivable from the committed data and needs a verified
 * MEF/comune-by-comune source; it is tracked separately. What IS derivable
 * from the committed data, and is fixed here, is the no-surcharge regime.
 */
import type { Municipality } from '../data/municipalities';

/**
 * Italian provinces whose comuni levy NO addizionale comunale IRPEF because
 * the region has a special statute. Currently only Valle d'Aosta (`AO`) —
 * the only special-statute region among the 11 provinces in the border
 * dataset. Kept as a set so adding one is a data change, not a code change.
 */
export const NO_SURCHARGE_PROVINCES: ReadonlySet<string> = new Set(['AO']);

type MunicipalityLike = Pick<Municipality, 'province' | 'irpefAddizionale'>;

/**
 * `true` when the comune levies an addizionale comunale IRPEF at all — i.e.
 * when its `irpefAddizionale` is a rate on the same scale as everyone else's.
 * `false` for the special-statute regime, where `0` means "not applicable".
 */
export function leviesIrpefAddizionale(m: MunicipalityLike): boolean {
  return !NO_SURCHARGE_PROVINCES.has(String(m.province || '').toUpperCase());
}

/**
 * Human-readable rate for display. Returns `null` for the no-surcharge
 * regime so every caller must decide explicitly what to render instead of
 * printing a bare `0%` that reads as "the cheapest option".
 */
export function formatIrpefAddizionale(m: MunicipalityLike): string | null {
  if (!leviesIrpefAddizionale(m)) return null;
  return `${m.irpefAddizionale}%`;
}

/**
 * Short native-language explanation of the no-surcharge regime, for a `title`
 * tooltip / caption next to the value. Falls back to Italian for any locale
 * outside the four the site ships.
 */
export function noSurchargeNote(locale: string): string {
  switch (locale) {
    case 'en':
      return 'No municipal IRPEF surcharge: Valle d’Aosta is a special-statute region and levies none. Not a zero rate — a different tax regime, so it is not comparable with the other municipalities.';
    case 'de':
      return 'Keine kommunale IRPEF-Zusatzsteuer: Das Aostatal ist eine Region mit Sonderstatut und erhebt keine. Kein Nullsatz, sondern ein anderes Steuersystem — daher nicht mit den übrigen Gemeinden vergleichbar.';
    case 'fr':
      return 'Pas de surtaxe communale IRPEF : la Vallée d’Aoste est une région à statut spécial et n’en prélève aucune. Ce n’est pas un taux nul mais un régime fiscal différent, donc non comparable aux autres communes.';
    default:
      return 'Nessuna addizionale comunale IRPEF: la Valle d’Aosta è una regione a statuto speciale e non la applica. Non è un’aliquota zero ma un regime fiscale diverso, quindi non confrontabile con gli altri comuni.';
  }
}

/**
 * Label to render in place of the rate for the no-surcharge regime.
 * Deliberately not `0%`.
 */
export function noSurchargeLabel(locale: string): string {
  switch (locale) {
    case 'en': return 'n/a';
    case 'de': return 'entfällt';
    case 'fr': return 's.o.';
    default: return 'n.d.';
  }
}

/**
 * Fiscal-axis score for a composite ranking, in `[0, 1]`, higher = better for
 * the reader (lower surcharge).
 *
 * `min`/`max` MUST be computed over the comuni that actually levy the
 * surcharge (see {@link irpefRateRange}). Comuni under the no-surcharge
 * regime return `null`: they do not belong on this axis at all, and the
 * caller renormalises the remaining weights rather than awarding them the
 * top score for a tax they are not subject to.
 */
export function irpefFiscalScore(
  m: MunicipalityLike,
  min: number,
  max: number,
): number | null {
  if (!leviesIrpefAddizionale(m)) return null;
  if (max === min) return 1;
  return 1 - (m.irpefAddizionale - min) / (max - min);
}

/**
 * Min/max of `irpefAddizionale` across ONLY the comuni that levy it.
 * Returns `{ min: 0, max: 0 }` when the list has none.
 */
export function irpefRateRange(
  municipalities: ReadonlyArray<MunicipalityLike>,
): { min: number; max: number } {
  const rates = municipalities.filter(leviesIrpefAddizionale).map((m) => m.irpefAddizionale);
  if (rates.length === 0) return { min: 0, max: 0 };
  return { min: Math.min(...rates), max: Math.max(...rates) };
}

/**
 * Ascending comparator for `irpefAddizionale` sort columns. Comuni that
 * actually levy the surcharge sort first, ordered by rate; no-surcharge
 * comuni (see {@link leviesIrpefAddizionale}) sort last instead of tying at
 * raw `0` and winning the "cheapest" spot in an ascending sort (#4875).
 */
export function compareIrpefAddizionale(a: MunicipalityLike, b: MunicipalityLike): number {
  const aLevies = leviesIrpefAddizionale(a);
  const bLevies = leviesIrpefAddizionale(b);
  if (aLevies !== bLevies) return aLevies ? -1 : 1;
  if (!aLevies) return 0;
  return a.irpefAddizionale - b.irpefAddizionale;
}

/**
 * Direction-aware counterpart of {@link compareIrpefAddizionale} for sortable
 * columns with an asc/desc toggle. A naive `dir === 'asc' ? cmp : -cmp`
 * flips the no-surcharge tie-break along with the numeric one: in `desc` the
 * comuni that sort last in `asc` (correctly, since they are not on the
 * fiscal axis) would flip to first — the exact "wins the ranking for a tax
 * they don't pay" distortion this module exists to remove, just mirrored
 * (#4875 round-2). No-surcharge comuni stay last regardless of `dir`; only
 * the numeric comparison between comuni that actually levy the surcharge
 * inverts.
 */
export function compareIrpefAddizionaleWithDirection(
  a: MunicipalityLike,
  b: MunicipalityLike,
  dir: 'asc' | 'desc',
): number {
  const aLevies = leviesIrpefAddizionale(a);
  const bLevies = leviesIrpefAddizionale(b);
  if (aLevies !== bLevies) return aLevies ? -1 : 1;
  if (!aLevies) return 0;
  const cmp = a.irpefAddizionale - b.irpefAddizionale;
  return dir === 'asc' ? cmp : -cmp;
}

/**
 * Text-level counterpart of `components/shared/IrpefAddizionaleValue.tsx`, for
 * the SSG plugins that emit static HTML and cannot mount a React component
 * (`build-plugins/borderMunicipalityPagesPlugin.ts`,
 * `build-plugins/fiscalMunicipalityPagesPlugin.ts`). Those pages are the
 * INDEXED surface — leaving them printing a bare `0%` while the SPA discloses
 * the regime would be exactly the drift Non-Negotiable #6 forbids, on the
 * side that carries the traffic.
 *
 * @param formattedRate The already locale-formatted rate string (e.g. `0,55%`),
 *   used verbatim when the comune actually levies the surcharge.
 */
export function irpefDisplayText(
  m: MunicipalityLike,
  locale: string,
  formattedRate: string,
): string {
  return leviesIrpefAddizionale(m) ? formattedRate : noSurchargeLabel(locale);
}

/**
 * `title` attribute value for a static-HTML rate cell: the regime note when
 * the comune is exempt, an empty string otherwise (callers omit the attribute).
 */
export function irpefDisplayTitle(m: MunicipalityLike, locale: string): string {
  return leviesIrpefAddizionale(m) ? '' : noSurchargeNote(locale);
}
