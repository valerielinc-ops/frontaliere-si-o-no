import { useTranslation } from '@/services/i18n';
import type { Municipality } from '@/data/municipalities';
import { rentEstimateNote } from '@/services/avgRentEstimate';

export interface AvgRentValueProps {
  municipality: Pick<Municipality, 'avgRentMonthly'>;
  /** Rendered before the number (e.g. `€ ` or `EUR `). Defaults to `€`. */
  prefix?: string;
  /** Rendered after the number (e.g. `/mese`). */
  suffix?: string;
}

/**
 * Renders `Municipality.avgRentMonthly` — the ONE place that decides what a
 * comune's average rent looks like on screen (issue #4545 residual 4).
 *
 * The figure is a zone-level estimate: 518 comuni carry only 32 distinct
 * values, and 483 of them repeat a neighbour's number. Printed bare as
 * `€550/mese` it reads as a measured per-comune observation, which is how it
 * ended up feeding map colour scales and livability rankings. This component
 * keeps the number visible — it is still the best available signal — but
 * marks it as an estimate and explains, in the reader's language, how many
 * comuni share it.
 *
 * Same shape and rationale as `IrpefAddizionaleValue` (#4875): one shared
 * component rather than a `title=` copy-pasted into each call site, because a
 * disclosure that silently disappears from one of several surfaces is worse
 * than none (Non-Negotiable #6).
 *
 * NOT for the French corridor dataset, whose rent IS sourced (DGALN/DHUP
 * "Carte des loyers", with per-commune observation counts).
 */
export default function AvgRentValue({ municipality, prefix = '€', suffix }: AvgRentValueProps) {
  const { locale } = useTranslation();
  const note = rentEstimateNote(municipality, locale);
  return (
    <abbr
      title={note}
      aria-label={note}
      className="no-underline decoration-dotted underline-offset-2 cursor-help"
    >
      {prefix}
      {municipality.avgRentMonthly}
      {suffix}
    </abbr>
  );
}
