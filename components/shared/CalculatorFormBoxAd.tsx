/**
 * CalculatorFormBoxAd — dedicated GPT/GAM box at the bottom of the calculator
 * input column.
 *
 * Fills the white space below the form when the input column is shorter than
 * the results column. Serves `/23355151813/calculator-form-box` (300x250 /
 * 336x280 + fluid) via GptAdSlot.
 *
 * CLS-safe by POSITION: it is the LAST element in the scrollable input column,
 * so filling it only extends the column's own scroll area — it pushes nothing
 * below it on the page (minHeight 0 = no reserved band). Collapses to
 * display:none when unsold (default GptAdSlot behaviour) so it never leaves
 * white space when there is no demand.
 *
 * GPT (pubads) is independent of adsbygoogle.js → Auto Ads keep serving
 * untouched (AGENTS §7). Runtime kill-switch: Firebase Remote Config
 * `KILL_CALCULATOR_FORM_BOX` (~1 min, no redeploy; default-safe = shown).
 */
import GptAdSlot, { type GptSize } from '@/components/shared/GptAdSlot';
import { useKillSwitches } from '@/hooks/useKillSwitches';

const FORM_BOX_UNIT_PATH = '/23355151813/calculator-form-box';
const FORM_BOX_SIZES: GptSize[] = [[300, 250], [336, 280], 'fluid'];

export default function CalculatorFormBoxAd() {
  const { calculatorFormBox: killed } = useKillSwitches();
  return (
    <GptAdSlot
      adUnitPath={FORM_BOX_UNIT_PATH}
      sizes={FORM_BOX_SIZES}
      killed={killed}
      // No reserved band: the slot is the last child of a scrollable column, so
      // a fill grows the column's scroll area without shifting page content
      // (CLS-safe by position). Collapses when unsold → no white space.
      minHeight={0}
      className="mx-5 mb-5 mt-2 w-full flex justify-center"
    />
  );
}
