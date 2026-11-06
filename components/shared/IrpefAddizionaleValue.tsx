import { useTranslation } from '@/services/i18n';
import type { Municipality } from '@/data/municipalities';
import {
  formatIrpefAddizionale,
  noSurchargeLabel,
  noSurchargeNote,
} from '@/services/irpefAddizionaleRegime';

export interface IrpefAddizionaleValueProps {
  municipality: Pick<Municipality, 'province' | 'irpefAddizionale'>;
  /** Optional prefix rendered before the rate (e.g. `+` in a compact caption). */
  prefix?: string;
}

/**
 * Renders `Municipality.irpefAddizionale` — the ONE place that decides what a
 * comune's addizionale comunale IRPEF looks like on screen (issue #4875).
 *
 * Seven components used to print `{m.irpefAddizionale}%` bare. For the 51
 * Valle d'Aosta comuni in the dataset that rendered a confident `0%`, which
 * reads as "the cheapest municipality on the list" when it actually means
 * "this tax does not exist here" — a special-statute regime, not a rate. This
 * component renders a locale-native `n.d.` / `n/a` / `entfällt` / `s.o.`
 * with a native-language `title` explaining why, and the plain rate otherwise.
 *
 * Kept as one shared component rather than a `title=` copy-pasted into each
 * call site (Non-Negotiable #6): the copy and the guard drift otherwise, and
 * a disclosure that silently disappears from one of seven surfaces is worse
 * than none.
 */
export default function IrpefAddizionaleValue({ municipality, prefix }: IrpefAddizionaleValueProps) {
  const { locale } = useTranslation();
  const formatted = formatIrpefAddizionale(municipality);
  if (formatted !== null) {
    return <>{prefix ? `${prefix}${formatted}` : formatted}</>;
  }
  const note = noSurchargeNote(locale);
  return (
    <abbr title={note} aria-label={note} className="no-underline decoration-dotted underline-offset-2 cursor-help">
      {noSurchargeLabel(locale)}
    </abbr>
  );
}
