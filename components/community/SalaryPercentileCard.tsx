import React, { useMemo } from 'react';
import { TrendingUp } from 'lucide-react';
import {
  generateInsightsStructuredData,
  estimateMonthlyNetFrontaliereChf,
} from '../../scripts/lib/salary-insights.mjs';

export interface SalaryPercentileCardProps {
  medianSalary: number;
  sampleSize?: number;
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

function formatCurrency(value: number, locale = 'it'): string {
  return new Intl.NumberFormat(FORMAT_LOCALE[locale] || 'it-CH', {
    style: 'currency',
    currency: 'CHF',
    maximumFractionDigits: 0,
  }).format(value || 0);
}

export const SalaryPercentileCard: React.FC<SalaryPercentileCardProps> = ({
  medianSalary,
  sampleSize = 100,
  canton = 'TI',
  locale = 'it',
  className = '',
}) => {
  const p25Salary = Math.round(medianSalary * 0.82);
  const p75Salary = Math.round(medianSalary * 1.22);
  const p90Salary = Math.round(medianSalary * 1.45);
  const netMonthlyChf = estimateMonthlyNetFrontaliereChf(medianSalary, canton);
  const netMonthlyEur = Math.round(netMonthlyChf * 1.05);

  const structuredData = useMemo(() => {
    return generateInsightsStructuredData({
      role: 'Lavoratore Frontaliere Ticino',
      canton,
      sampleSize,
      min: Math.round(p25Salary * 0.85),
      p25: p25Salary,
      median: medianSalary,
      p75: p75Salary,
      p90: p90Salary,
      monthlyNetChf: netMonthlyChf,
      calculatedAt: new Date().toISOString(),
    });
  }, [canton, medianSalary, netMonthlyChf, p25Salary, p75Salary, p90Salary, sampleSize]);

  return (
    <section
      data-testid="salary-percentile-card"
      className={`rounded-3xl border border-edge bg-surface p-6 shadow-sm space-y-4 ${className}`}
      aria-label="Distribuzione percentili retributivi e stima netto"
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-edge/60 pb-3">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-accent" />
          <h3 className="text-base font-bold font-display text-heading">
            Distribuzione Percentili e Stima Netto Frontaliere (FreeHire Model)
          </h3>
        </div>
        <span className="text-xs px-2.5 py-1 rounded-full bg-accent-subtle text-accent border border-accent-border font-medium self-start sm:self-auto">
          Schema.org Dataset Attivo
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
        <div className="p-3 rounded-2xl bg-surface-raised border border-edge">
          <div className="text-[11px] font-bold uppercase tracking-wider text-muted">P25 (Entry)</div>
          <div className="mt-1 text-lg font-bold font-display text-body">{formatCurrency(p25Salary, locale)}</div>
        </div>
        <div className="p-3 rounded-2xl bg-accent-subtle border border-accent-border">
          <div className="text-[11px] font-bold uppercase tracking-wider text-accent">P50 (Mediana)</div>
          <div className="mt-1 text-lg font-bold font-display text-accent">{formatCurrency(medianSalary, locale)}</div>
        </div>
        <div className="p-3 rounded-2xl bg-surface-raised border border-edge">
          <div className="text-[11px] font-bold uppercase tracking-wider text-muted">P75 (Senior)</div>
          <div className="mt-1 text-lg font-bold font-display text-body">{formatCurrency(p75Salary, locale)}</div>
        </div>
        <div className="p-3 rounded-2xl bg-surface-raised border border-edge">
          <div className="text-[11px] font-bold uppercase tracking-wider text-muted">P90 (Lead)</div>
          <div className="mt-1 text-lg font-bold font-display text-body">{formatCurrency(p90Salary, locale)}</div>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-4 rounded-2xl bg-success-subtle border border-success-border">
        <div>
          <span className="text-xs font-bold font-display uppercase tracking-wider text-success block">
            Stima Netto Mensile Mediano (Accordo Fiscale 2026)
          </span>
          <span className="text-sm text-body block mt-0.5">
            Calcolato su 12 mensilità al netto di contributi AVS/LPP e imposta alla fonte
          </span>
        </div>
        <div className="text-right shrink-0">
          <div className="text-2xl font-extrabold font-display text-success">
            ~{formatCurrency(netMonthlyChf, locale)} / mese
          </div>
          <div className="text-xs text-muted">
            (indicativo ~€{netMonthlyEur.toLocaleString()})
          </div>
        </div>
      </div>
    </section>
  );
};
