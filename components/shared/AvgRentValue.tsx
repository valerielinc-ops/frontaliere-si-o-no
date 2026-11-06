import { useTranslation } from '@/services/i18n';
import type { Municipality } from '@/data/municipalities';
import { rentEstimateLabel, rentEstimateNote } from '@/services/avgRentEstimate';

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
 * THE MARKER IS VISIBLE, NOT HOVER-ONLY. The first version carried the whole
 * disclosure in `title`/`aria-label`. A `title` tooltip needs a pointer:
 * there is no hover on a touch screen, so on phones — the majority of this
 * site's traffic — the number rendered completely unqualified, which is the
 * defect the component was built to remove. The indexed SSG page already got
 * this right (`borderMunicipalityPagesPlugin` prints `rentCaptionSuffix` as
 * visible caption text under the tile), so the SPA was also the side that
 * disagreed with the SSG side about what the reader is told.
 *
 * So the short locale-native marker (`stima` / `estimate` / `Schätzung` /
 * `estimation`) always renders next to the figure, and `title` keeps the long
 * form for pointer users. Same division as `IrpefAddizionaleValue`, which
 * renders its visible `n.d.` / `entfällt` and explains it in `title`.
 *
 * No opt-out prop, deliberately: a `hideMarker` escape hatch is exactly how a
 * disclosure ends up missing from the one surface nobody re-checked.
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
      {/* aria-hidden: the abbr's aria-label already reads the full note, so
          announcing the short marker too would just repeat it. */}
      <span aria-hidden="true" className="ml-1 text-[0.85em] font-normal text-muted">
        ({rentEstimateLabel(locale)})
      </span>
    </abbr>
  );
}
