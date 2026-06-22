/**
 * TopAdsChart — horizontal animated bar chart of an employer's top ads by views.
 *
 * Pure CSS/flex bars (no charting lib, no new deps). Bars grow from 0 → their
 * share-of-max width when the chart scrolls into view (`useReveal`). Each row is
 * an accessible group: title + view count are real text (not just visual), and
 * the bar carries an aria-label so screen-reader users get the same data.
 *
 * Colour: semantic chart tokens only (`--color-chart-area` / `--color-chart-line`).
 * Reduced-motion users get bars at full width instantly (transition is disabled
 * globally via the prefers-reduced-motion media query in index.css, and reveal
 * fires immediately).
 */
import React from 'react';
import type { EmployerAd } from '@/services/employerInsights';
import { useReveal } from './useReveal';

interface TopAdsChartProps {
  ads: EmployerAd[];
  /** How many top rows to show. Default 10. */
  limit?: number;
}

const nf = new Intl.NumberFormat('it-IT');

export function TopAdsChart({ ads, limit = 10 }: TopAdsChartProps): React.ReactElement | null {
  const { ref, inView } = useReveal<HTMLDivElement>();
  const rows = ads.slice(0, limit);
  if (rows.length === 0) return null;

  const max = Math.max(...rows.map((a) => a.views), 1);

  return (
    <div ref={ref}>
      <ul className="space-y-3" aria-label="Annunci più visti">
        {rows.map((ad, i) => {
          const pct = Math.max((ad.views / max) * 100, 2); // floor so tiny bars stay visible
          return (
            <li key={ad.slug || ad.path || i} className="group">
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <span className="text-sm font-medium text-body truncate">{ad.title}</span>
                <span className="text-sm font-bold text-strong tabular-nums shrink-0">
                  {nf.format(ad.views)}
                </span>
              </div>
              <div
                className="h-3 w-full rounded-full bg-surface-alt overflow-hidden"
                role="img"
                aria-label={`${ad.title}: ${nf.format(ad.views)} visualizzazioni`}
              >
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-1000 ease-out"
                  style={{
                    width: inView ? `${pct}%` : '0%',
                    transitionDelay: `${i * 70}ms`,
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default TopAdsChart;
