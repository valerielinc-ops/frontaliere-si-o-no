/**
 * TicinoMunicipalTax — municipal multiplier refinement for a Ticino RESIDENT
 * (permit B/C) net (issue #4470).
 *
 * The source-tax tariff in `services/calculationService.ts` embeds Ticino's
 * cantonal-AVERAGE municipal multiplier. Picking a specific comune re-scales
 * only the municipal share (via `ticinoMunicipalTaxDeltaCHF`) so the resident
 * net moves with the real `moltiplicatore comunale` — reinforcing the "numbers
 * you can trust" moat. Data (with source + year) lives in
 * `data/ticino-municipal-multipliers.json`.
 *
 * Only affects the CH-resident scenario — a frontaliere is taxed at source / in
 * Italy, so their net does NOT depend on a Swiss comune of domicile.
 *
 * The whole block renders unconditionally with a stable layout (the figure row
 * is always present), so selecting a comune never shifts surrounding content —
 * zero CLS, Auto Ads untouched (Non-Negotiable #7).
 */

import React, { useMemo, useState } from 'react';
import { Building2 } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { ticinoMunicipalTaxDeltaCHF } from '@/services/calculationService';
import municipalData from '@/data/ticino-municipal-multipliers.json';

interface Props {
  /** Base annual Ticino income tax from the simulation (result.chResident.taxes). */
  baseChTaxAnnualCHF: number;
  /** Base CH-resident monthly net from the simulation. */
  baseNetMonthlyCHF: number;
  /** Months basis used by the simulation (12 or 13). */
  monthsBasis: number;
}

interface MunicipalityEntry {
  name: string;
  multiplierPct: number;
}

const BASELINE_PCT = (municipalData as { sourceTaxBaselineMultiplierPct: number })
  .sourceTaxBaselineMultiplierPct;
const REFERENCE_YEAR = (municipalData as { referenceYear: number }).referenceYear;
const MUNICIPALITIES = ((municipalData as { municipalities: MunicipalityEntry[] }).municipalities || [])
  .slice()
  .sort((a, b) => a.name.localeCompare(b.name, 'it'));

function formatCHF(value: number): string {
  return `CHF ${Math.round(value).toLocaleString('it-CH')}`;
}

export const TicinoMunicipalTax: React.FC<Props> = ({
  baseChTaxAnnualCHF,
  baseNetMonthlyCHF,
  monthsBasis,
}) => {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string>('');

  const months = monthsBasis > 0 ? monthsBasis : 12;

  const { adjustedNetMonthly, deltaMonthly } = useMemo(() => {
    const entry = MUNICIPALITIES.find((m) => m.name === selected);
    if (!entry) return { adjustedNetMonthly: baseNetMonthlyCHF, deltaMonthly: 0 };
    const deltaAnnual = ticinoMunicipalTaxDeltaCHF(baseChTaxAnnualCHF, entry.multiplierPct, BASELINE_PCT);
    const dMonthly = deltaAnnual / months;
    return { adjustedNetMonthly: baseNetMonthlyCHF - dMonthly, deltaMonthly: -dMonthly };
  }, [selected, baseChTaxAnnualCHF, baseNetMonthlyCHF, months]);

  const deltaLabel =
    Math.round(deltaMonthly) === 0
      ? '±0'
      : `${deltaMonthly > 0 ? '+' : '−'}${formatCHF(Math.abs(deltaMonthly))}`;

  return (
    <div className="mt-2 rounded-2xl border border-edge bg-surface-alt/50 p-4">
      <div className="flex items-center gap-2 mb-1">
        <Building2 size={15} className="text-accent" aria-hidden="true" />
        <h4 className="text-sm font-bold text-heading">{t('results.municipalTax.title')}</h4>
      </div>
      <p className="text-xs text-subtle mb-3">{t('results.municipalTax.subtitle')}</p>

      <label htmlFor="ti-municipality" className="block text-xs font-medium text-subtle mb-1">
        {t('results.municipalTax.selectLabel')}
      </label>
      <select
        id="ti-municipality"
        value={selected}
        onChange={(e) => {
          setSelected(e.target.value);
          if (e.target.value) {
            Analytics.trackUIInteraction('simulatore', 'results', 'municipal_tax', 'select', e.target.value);
          }
        }}
        className="w-full px-3 py-2 text-sm rounded-lg border border-edge bg-surface focus-visible:ring-2 focus-visible:ring-accent outline-none"
      >
        <option value="">{t('results.municipalTax.cantonAverage')}</option>
        {MUNICIPALITIES.map((m) => (
          <option key={m.name} value={m.name}>
            {m.name} · {m.multiplierPct}%
          </option>
        ))}
      </select>

      <div className="mt-3 flex items-end justify-between gap-3 rounded-xl bg-surface px-3 py-2.5 border border-edge">
        <span className="text-xs text-subtle font-medium">
          {selected ? t('results.municipalTax.netIn', { municipality: selected }) : t('results.municipalTax.netAverage')}
        </span>
        <span className="text-right">
          <span className="block font-mono font-bold text-base text-success tabular-nums">
            {formatCHF(adjustedNetMonthly)}
          </span>
          {selected && (
            <span
              className={`block text-[11px] font-semibold tabular-nums ${
                deltaMonthly > 0 ? 'text-success' : deltaMonthly < 0 ? 'text-danger' : 'text-muted'
              }`}
            >
              {deltaLabel}
            </span>
          )}
        </span>
      </div>

      <p className="text-[11px] text-muted mt-2 leading-relaxed">
        {t('results.municipalTax.source', { year: REFERENCE_YEAR })}
      </p>
    </div>
  );
};

export default TicinoMunicipalTax;
