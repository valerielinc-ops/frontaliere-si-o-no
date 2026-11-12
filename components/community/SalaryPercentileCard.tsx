import React, { useMemo } from 'react';
import { TrendingUp } from 'lucide-react';
import {
  generateInsightsStructuredData,
  getSalaryInsightsCopy,
} from '../../scripts/lib/salary-insights.mjs';

export interface SalaryPercentileCardProps {
  p10Salary?: number | null;
  p25Salary?: number | null;
  medianSalary?: number | null;
  p75Salary?: number | null;
  p90Salary?: number | null;
  exactSalaryCount?: number;
  salaryRangeCount?: number;
  medianRangeMin?: number | null;
  medianRangeMax?: number | null;
  canton?: string;
  locale?: string;
  className?: string;
}

const FORMAT_LOCALE: Record<string, string> = {
  it: 'it-CH',
  en: 'en-CH',
  de: 'de-CH',
  fr: 'fr-CH',
};

const CARD_COPY = {
  it: {
    ariaLabel: 'Distribuzione salariale osservata',
    heading: 'Distribuzione degli importi puntuali osservati',
    rangeHeading: 'Range salariali dichiarati',
    datasetBadge: 'Dataset Schema.org',
    p25: 'P25 (primo quartile)',
    p50: 'P50 (mediana)',
    p75: 'P75 (terzo quartile)',
    p90: 'P90',
    methodology: 'Percentili calcolati solo su importi annuali esatti dichiarati; gli annunci con range non entrano nel campione.',
    sample: (exact: number, ranges: number) => `Importi puntuali: ${exact}; annunci con stipendio dichiarato: ${ranges}.`,
    rangeLabel: 'Mediana separata dei limiti inferiori e superiori dichiarati',
    rangeOnlyNote: 'Gli annunci riportano intervalli, non importi individuali: non si possono calcolare percentili salariali.',
    rangeSample: (count: number) => `Annunci con range dichiarato: ${count}`,
  },
  en: {
    ariaLabel: 'Observed salary distribution',
    heading: 'Observed exact salary amounts',
    rangeHeading: 'Reported salary ranges',
    datasetBadge: 'Schema.org dataset',
    p25: 'P25 (first quartile)',
    p50: 'P50 (median)',
    p75: 'P75 (third quartile)',
    p90: 'P90',
    methodology: 'Percentiles use only exact annual salary amounts reported in CHF; listings with ranges are excluded.',
    sample: (exact: number, ranges: number) => `Exact amounts: ${exact}; listings with reported salary: ${ranges}.`,
    rangeLabel: 'Separate medians of reported lower and upper bounds',
    rangeOnlyNote: 'Listings provide ranges rather than individual amounts, so salary percentiles cannot be calculated.',
    rangeSample: (count: number) => `Listings with reported ranges: ${count}`,
  },
  de: {
    ariaLabel: 'Beobachtete Gehaltsverteilung',
    heading: 'Beobachtete genaue Gehaltsbeträge',
    rangeHeading: 'Gemeldete Gehaltsspannen',
    datasetBadge: 'Schema.org-Datensatz',
    p25: 'P25 (erstes Quartil)',
    p50: 'P50 (Median)',
    p75: 'P75 (drittes Quartil)',
    p90: 'P90',
    methodology: 'Perzentile verwenden nur genau angegebene Jahreslöhne in CHF; Anzeigen mit Spannen sind ausgeschlossen.',
    sample: (exact: number, ranges: number) => `Genaue Beträge: ${exact}; Anzeigen mit gemeldetem Lohn: ${ranges}.`,
    rangeLabel: 'Getrennter Median der gemeldeten Unter- und Obergrenzen',
    rangeOnlyNote: 'Die Anzeigen enthalten Lohnspannen statt einzelner Beträge; deshalb lassen sich keine Gehaltsperzentile berechnen.',
    rangeSample: (count: number) => `Anzeigen mit gemeldeter Lohnspanne: ${count}`,
  },
  fr: {
    ariaLabel: 'Distribution salariale observée',
    heading: 'Montants exacts observés',
    rangeHeading: 'Fourchettes salariales déclarées',
    datasetBadge: 'Jeu de données Schema.org',
    p25: 'P25 (premier quartile)',
    p50: 'P50 (médiane)',
    p75: 'P75 (troisième quartile)',
    p90: 'P90',
    methodology: 'Les percentiles utilisent uniquement les montants annuels exacts déclarés en CHF ; les annonces avec fourchette sont exclues.',
    sample: (exact: number, ranges: number) => `Montants exacts : ${exact} ; annonces avec salaire déclaré : ${ranges}.`,
    rangeLabel: 'Médianes distinctes des bornes inférieures et supérieures déclarées',
    rangeOnlyNote: 'Les annonces indiquent des fourchettes, pas des montants individuels ; les percentiles ne peuvent pas être calculés.',
    rangeSample: (count: number) => `Annonces avec fourchette déclarée : ${count}`,
  },
} as const;

function positiveNumber(value?: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function formatCurrency(value: number, locale = 'it'): string {
  return new Intl.NumberFormat(FORMAT_LOCALE[locale] || 'it-CH', {
    style: 'currency',
    currency: 'CHF',
    maximumFractionDigits: 0,
  }).format(value);
}

export const SalaryPercentileCard: React.FC<SalaryPercentileCardProps> = ({
  p10Salary,
  p25Salary,
  medianSalary,
  p75Salary,
  p90Salary,
  exactSalaryCount,
  salaryRangeCount,
  medianRangeMin,
  medianRangeMax,
  canton = 'TI',
  locale = 'it',
  className = '',
}) => {
  const safeLocale = locale in CARD_COPY ? locale as keyof typeof CARD_COPY : 'it';
  const copy = CARD_COPY[safeLocale];
  const insightCopy = getSalaryInsightsCopy(safeLocale);
  const p10 = positiveNumber(p10Salary);
  const p25 = positiveNumber(p25Salary);
  const median = positiveNumber(medianSalary);
  const p75 = positiveNumber(p75Salary);
  const p90 = positiveNumber(p90Salary);
  const lowerRangeMedian = positiveNumber(medianRangeMin);
  const upperRangeMedian = positiveNumber(medianRangeMax);
  const hasExactSample = typeof exactSalaryCount === 'number'
    && Number.isInteger(exactSalaryCount)
    && exactSalaryCount > 0
    && p10 !== null && p25 !== null && median !== null && p75 !== null && p90 !== null;
  const hasRangeSummary = typeof salaryRangeCount === 'number'
    && Number.isInteger(salaryRangeCount)
    && salaryRangeCount > 0
    && lowerRangeMedian !== null
    && upperRangeMedian !== null;

  const structuredData = useMemo(() => {
    if (!hasExactSample || p10 === null || p25 === null || median === null || p75 === null || p90 === null
      || typeof exactSalaryCount !== 'number') {
      return null;
    }

    return generateInsightsStructuredData({
      role: insightCopy.role,
      canton,
      sampleSize: exactSalaryCount,
      p10,
      p25,
      median,
      p75,
      p90,
      calculatedAt: new Date().toISOString(),
    }, safeLocale);
  }, [canton, exactSalaryCount, hasExactSample, insightCopy.role, median, p10, p25, p75, p90, safeLocale]);

  if (!hasExactSample) {
    if (!hasRangeSummary || lowerRangeMedian === null || upperRangeMedian === null || typeof salaryRangeCount !== 'number') {
      return null;
    }

    return (
      <section
        data-testid="salary-percentile-card"
        className={`rounded-3xl border border-edge bg-surface p-6 shadow-sm space-y-4 ${className}`}
        aria-label={copy.rangeHeading}
      >
        <div className="flex items-center gap-2 border-b border-edge/60 pb-3">
          <TrendingUp className="h-5 w-5 text-accent" />
          <h3 className="text-base font-bold font-display text-heading">{copy.rangeHeading}</h3>
        </div>
        <div>
          <div className="text-xs font-bold font-display uppercase tracking-wider text-muted">{copy.rangeLabel}</div>
          <div className="mt-1 text-2xl font-bold font-display text-body">
            {formatCurrency(lowerRangeMedian, safeLocale)} – {formatCurrency(upperRangeMedian, safeLocale)}
          </div>
        </div>
        <p className="text-xs text-muted">{copy.rangeOnlyNote}</p>
        <p className="text-xs text-muted">{copy.rangeSample(salaryRangeCount)}</p>
      </section>
    );
  }

  if (!structuredData || p10 === null || p25 === null || median === null || p75 === null || p90 === null
    || typeof exactSalaryCount !== 'number' || typeof salaryRangeCount !== 'number') {
    return null;
  }

  return (
    <section
      data-testid="salary-percentile-card"
      className={`rounded-3xl border border-edge bg-surface p-6 shadow-sm space-y-4 ${className}`}
      aria-label={copy.ariaLabel}
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-edge/60 pb-3">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-accent" />
          <h3 className="text-base font-bold font-display text-heading">{copy.heading}</h3>
        </div>
        <span className="text-xs px-2.5 py-1 rounded-full bg-accent-subtle text-accent border border-accent-border font-medium self-start sm:self-auto">
          {copy.datasetBadge}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
        <div className="p-3 rounded-2xl bg-surface-raised border border-edge">
          <div className="text-[11px] font-bold uppercase tracking-wider text-muted">{copy.p25}</div>
          <div className="mt-1 text-lg font-bold font-display text-body">{formatCurrency(p25, safeLocale)}</div>
        </div>
        <div className="p-3 rounded-2xl bg-accent-subtle border border-accent-border">
          <div className="text-[11px] font-bold uppercase tracking-wider text-accent">{copy.p50}</div>
          <div className="mt-1 text-lg font-bold font-display text-accent">{formatCurrency(median, safeLocale)}</div>
        </div>
        <div className="p-3 rounded-2xl bg-surface-raised border border-edge">
          <div className="text-[11px] font-bold uppercase tracking-wider text-muted">{copy.p75}</div>
          <div className="mt-1 text-lg font-bold font-display text-body">{formatCurrency(p75, safeLocale)}</div>
        </div>
        <div className="p-3 rounded-2xl bg-surface-raised border border-edge">
          <div className="text-[11px] font-bold uppercase tracking-wider text-muted">{copy.p90}</div>
          <div className="mt-1 text-lg font-bold font-display text-body">{formatCurrency(p90, safeLocale)}</div>
        </div>
      </div>

      <p className="text-xs text-muted">{copy.methodology}</p>
      <p className="text-xs text-muted">{copy.sample(exactSalaryCount, salaryRangeCount)}</p>
    </section>
  );
};
