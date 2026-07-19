/**
 * CantonNetComparison — "lo stesso lavoro in altri cantoni" (issue #4471).
 *
 * Below the simulation result, estimate the monthly net a RESIDENT would take
 * home for the SAME role in a handful of high-interest cantons, and cross-link
 * each to that canton's job surface (Cathedral CH-wide is live). Deepens the
 * session and pushes intent into the job funnel.
 *
 * Figures come from `services/cantonSalary.ts` (BFS grossregion wage index +
 * ESTV tax-burden curves) — no fabricated numbers. The section renders a fixed
 * set of rows unconditionally, so its height is stable and it never shifts
 * layout (zero CLS, Auto Ads untouched — Non-Negotiable #7).
 */

import React from 'react';
import { ArrowUpRight, MapPin } from 'lucide-react';
import { buildPath } from '@/services/router';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { useNavigationOptional } from '@/services/NavigationContext';
import { getCantonLabel, type CantonLocale } from '@/services/cantonList';
import {
  estimateCantonNetMonthly,
  CANTON_COMPARISON_DEFAULTS,
} from '@/services/cantonSalary';

interface Props {
  /** User's gross annual CHF income from the simulation. */
  grossAnnualCHF: number;
}

const HOME_CANTON = 'TI';

function formatCHF(value: number): string {
  return `CHF ${Math.round(value).toLocaleString('it-CH')}`;
}

export const CantonNetComparison: React.FC<Props> = ({ grossAnnualCHF }) => {
  const { t, locale } = useTranslation();
  const nav = useNavigationOptional();
  const typedLocale = (locale as CantonLocale) || 'it';

  if (!Number.isFinite(grossAnnualCHF) || grossAnnualCHF <= 0) return null;

  // Ticino resident baseline via the SAME model, so every delta is
  // apples-to-apples (resident vs resident, one consistent estimator).
  const tiBaseline = estimateCantonNetMonthly(grossAnnualCHF, HOME_CANTON, HOME_CANTON);
  const netMonthlyTicinoCHF = tiBaseline ? tiBaseline.netMonthlyCHF : 0;

  const rows = CANTON_COMPARISON_DEFAULTS
    .filter((code) => code !== HOME_CANTON)
    .map((code) => estimateCantonNetMonthly(grossAnnualCHF, code, HOME_CANTON))
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (rows.length === 0) return null;

  const handleNavigate = (e: React.MouseEvent, code: string) => {
    Analytics.trackCtaClick('calculator_canton_net_compare', {
      component: 'CantonNetComparison',
      section: 'calculator_results',
      label: `canton_${code}`,
    });
    if (nav) {
      e.preventDefault();
      nav.navigateTo('job-board', undefined, code);
    }
  };

  return (
    <div className="mt-6 rounded-2xl border border-edge bg-surface-alt/50 p-4 sm:p-5">
      <div className="flex items-center gap-2 mb-1">
        <MapPin size={16} className="text-accent" aria-hidden="true" />
        <h3 className="text-sm font-bold text-heading">{t('results.cantonCompare.title')}</h3>
      </div>
      <p className="text-xs text-subtle mb-3">{t('results.cantonCompare.subtitle')}</p>

      <ul className="space-y-1.5">
        {rows.map((row) => {
          const href = buildPath({ activeTab: 'job-board', jobBoardCanton: row.canton }, locale);
          const delta = Math.round(row.netMonthlyCHF - netMonthlyTicinoCHF);
          const deltaLabel = delta === 0 ? '±0' : `${delta > 0 ? '+' : '−'}${formatCHF(Math.abs(delta))}`;
          return (
            <li key={row.canton}>
              <a
                href={href}
                onClick={(e) => handleNavigate(e, row.canton)}
                className="flex items-center justify-between gap-3 rounded-xl border border-transparent bg-surface px-3 py-2.5 hover:border-accent-border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className="inline-flex items-center justify-center min-w-[2.25rem] px-1.5 py-0.5 rounded-md bg-surface-raised text-xs font-bold text-subtle">
                    {row.canton}
                  </span>
                  <span className="truncate text-sm text-body">{getCantonLabel(row.canton, typedLocale)}</span>
                </span>
                <span className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-right">
                    <span className="block font-mono font-bold text-sm text-strong tabular-nums">
                      {formatCHF(row.netMonthlyCHF)}
                    </span>
                    <span
                      className={`block text-[11px] font-semibold tabular-nums ${
                        delta > 0 ? 'text-success' : delta < 0 ? 'text-danger' : 'text-muted'
                      }`}
                    >
                      {deltaLabel}
                    </span>
                  </span>
                  <ArrowUpRight size={15} className="text-link" aria-hidden="true" />
                </span>
              </a>
            </li>
          );
        })}
      </ul>

      <p className="text-[11px] text-muted mt-3 leading-relaxed">
        {t('results.cantonCompare.disclaimer')}
      </p>
    </div>
  );
};

export default CantonNetComparison;
