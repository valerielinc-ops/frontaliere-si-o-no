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
import type { Locale } from '@/services/i18n';
import { useReveal } from './useReveal';

interface TopAdsChartProps {
  ads: EmployerAd[];
  /** How many top rows to show. Default 10. */
  limit?: number;
  locale?: Locale;
}

function chartCopy(locale: Locale): { listLabel: string; views: string; clicks: string; rate: string } {
  if (locale === 'en') return { listLabel: 'Most viewed ads', views: 'views', clicks: 'clicks', rate: 'interest rate' };
  if (locale === 'de') return { listLabel: 'Am häufigsten aufgerufene Anzeigen', views: 'Aufrufe', clicks: 'Klicks', rate: 'Interesse' };
  if (locale === 'fr') return { listLabel: 'Offres les plus consultées', views: 'vues', clicks: 'clics', rate: 'taux d’intérêt' };
  return { listLabel: 'Annunci più visti', views: 'visualizzazioni', clicks: 'click', rate: 'tasso di interesse' };
}

export function TopAdsChart({ ads, limit = 10, locale = 'it' }: TopAdsChartProps): React.ReactElement | null {
  const { ref, inView } = useReveal<HTMLDivElement>();
  const rows = ads.slice(0, limit);
  if (rows.length === 0) return null;

  const max = Math.max(...rows.map((a) => a.views), 1);
  const nf = new Intl.NumberFormat(locale === 'it' ? 'it-IT' : locale);
  const copy = chartCopy(locale);

  return (
    <div ref={ref}>
      <ul className="space-y-3" aria-label={copy.listLabel}>
        {rows.map((ad, i) => {
          const pct = Math.max((ad.views / max) * 100, 2); // floor so tiny bars stay visible
          const clickCount = typeof ad.applyClicks === 'number' && Number.isFinite(ad.applyClicks) ? Math.max(ad.applyClicks, 0) : null;
          const rate = ad.views > 0 && clickCount != null ? clickCount / ad.views : null;
          return (
            <li key={ad.slug || ad.path || i} className="group rounded-xl border border-edge bg-surface-raised px-3 py-3 sm:px-4">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-xs font-semibold text-accent" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <span className="line-clamp-2 text-sm font-semibold leading-snug text-body">{ad.title}</span>
                    <span className="shrink-0 text-right text-sm font-bold text-strong tabular-nums">
                      {nf.format(ad.views)}
                      <span className="ml-1 text-xs font-normal text-muted">{copy.views}</span>
                    </span>
                  </div>
                </div>
              </div>
              <div className="mt-3 pl-10">
                <div
                  className="h-2.5 w-full overflow-hidden rounded-full bg-surface-alt"
                  role="img"
                  aria-label={`${ad.title}: ${nf.format(ad.views)} ${copy.views}`}
                >
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-1000 ease-out"
                    style={{
                      width: inView ? `${pct}%` : '0%',
                      transitionDelay: `${i * 70}ms`,
                    }}
                  />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  {clickCount != null && <span className="tabular-nums">{nf.format(clickCount)} {copy.clicks}</span>}
                  {rate != null && <span className="tabular-nums">{new Intl.NumberFormat(locale === 'it' ? 'it-IT' : locale, { style: 'percent', maximumFractionDigits: 1 }).format(rate)} {copy.rate}</span>}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default TopAdsChart;
