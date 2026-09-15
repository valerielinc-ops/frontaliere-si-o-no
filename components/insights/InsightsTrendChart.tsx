import React, { useId } from 'react';
import type { EmployerInsightsTrendPoint } from '@/services/employerInsights';
import type { Locale } from '@/services/i18n';
import { useReveal } from './useReveal';

interface InsightsTrendChartProps {
  trend: EmployerInsightsTrendPoint[];
  locale?: Locale;
}

function localeTag(locale: Locale): string {
  return locale === 'it' ? 'it-IT' : locale;
}

function dateFromWeek(week: string): Date | null {
  const match = String(week || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  return Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() !== Number(match[2]) - 1
    || date.getUTCDate() !== Number(match[3])
    ? null
    : date;
}

function formatWeek(week: string, locale: Locale): string {
  const date = dateFromWeek(week);
  if (!date) return '';
  return new Intl.DateTimeFormat(localeTag(locale), {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(date);
}

function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(localeTag(locale)).format(value);
}

function chartCopy(locale: Locale): {
  views: string;
  clicks: string;
  recordedViews: string;
  recordedClicks: string;
  latest: string;
  growing: string;
  declining: string;
  stable: string;
  chartLabel: string;
  noSeries: string;
  clicksUnavailable: string;
} {
  if (locale === 'en') {
    return {
      views: 'Ad views', clicks: 'Apply clicks',
      recordedViews: 'recorded ad views', recordedClicks: 'apply clicks',
      latest: 'latest week', growing: 'growing', declining: 'declining', stable: 'stable',
      chartLabel: 'Weekly employer insights', noSeries: 'Not enough weekly observations for a chart.', clicksUnavailable: 'Weekly apply clicks are not included in this snapshot.',
    };
  }
  if (locale === 'de') {
    return {
      views: 'Anzeigenaufrufe', clicks: 'Bewerbungsklicks',
      recordedViews: 'erfasste Anzeigenaufrufe', recordedClicks: 'Bewerbungsklicks',
      latest: 'letzte Woche', growing: 'steigend', declining: 'sinkend', stable: 'stabil',
      chartLabel: 'Wöchentliche Arbeitgeber-Insights', noSeries: 'Für ein Diagramm gibt es zu wenige Wochenwerte.', clicksUnavailable: 'Wöchentliche Bewerbungsklicks sind in diesem Snapshot nicht enthalten.',
    };
  }
  if (locale === 'fr') {
    return {
      views: 'Vues des offres', clicks: 'Clics pour postuler',
      recordedViews: 'vues d’offres enregistrées', recordedClicks: 'clics pour postuler',
      latest: 'dernière semaine', growing: 'en hausse', declining: 'en baisse', stable: 'stable',
      chartLabel: 'Insights entreprises hebdomadaires', noSeries: 'Il n’y a pas assez de semaines observées pour afficher un graphique.', clicksUnavailable: 'Les clics hebdomadaires ne sont pas inclus dans ce snapshot.',
    };
  }
  return {
    views: 'Visualizzazioni annunci', clicks: 'Click per candidarsi',
    recordedViews: 'visualizzazioni annuncio registrate', recordedClicks: 'click per candidarsi',
    latest: 'ultima settimana', growing: 'in crescita', declining: 'in calo', stable: 'stabile',
    chartLabel: 'Andamento settimanale degli insights azienda', noSeries: 'Non ci sono abbastanza settimane osservate per il grafico.', clicksUnavailable: 'I click settimanali non sono presenti in questo snapshot.',
  };
}

function finiteMetric(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function hasFiniteMetric(value: number | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function InsightsTrendChart({ trend, locale = 'it' }: InsightsTrendChartProps): React.ReactElement {
  const { ref, inView } = useReveal<HTMLDivElement>();
  const titleId = useId();
  const copy = chartCopy(locale);
  const points = trend.filter((point) => dateFromWeek(point.week) && hasFiniteMetric(point.views));

  if (points.length < 2) {
    return <p className="rounded-xl border border-edge bg-surface-alt px-4 py-5 text-sm text-subtle">{copy.noSeries}</p>;
  }

  const hasClicks = points.some((point) => hasFiniteMetric(point.applyClicks));
  const maxViews = Math.max(...points.map((point) => finiteMetric(point.views)), 1);
  const maxClicks = Math.max(...points.map((point) => finiteMetric(point.applyClicks)), 1);
  const width = 760;
  const height = 280;
  const left = 48;
  const right = 18;
  const top = 24;
  const bottom = 48;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const x = (index: number) => left + (index / (points.length - 1)) * chartWidth;
  const y = (value: number) => top + chartHeight - (value / maxViews) * chartHeight;
  const yClicks = (value: number) => top + chartHeight - (value / maxClicks) * chartHeight;
  const viewPath = points.map((point, index) => `${x(index).toFixed(2)},${y(finiteMetric(point.views)).toFixed(2)}`).join(' L ');
  const areaPath = `M ${left},${top + chartHeight} L ${viewPath} L ${x(points.length - 1)},${top + chartHeight} Z`;
  const firstViews = finiteMetric(points[0].views);
  const lastViews = finiteMetric(points.at(-1)?.views);
  const direction = lastViews > firstViews ? copy.growing : lastViews < firstViews ? copy.declining : copy.stable;
  const latest = points.at(-1);
  const latestDetails = [
    hasClicks && typeof latest?.applyClicks === 'number'
      ? `${formatNumber(finiteMetric(latest.applyClicks), locale)} ${copy.recordedClicks}`
      : null,
  ].filter(Boolean).join('; ');
  const summary = `${copy.chartLabel}, ${direction}: ${formatNumber(firstViews, locale)} → ${formatNumber(lastViews, locale)} ${copy.recordedViews}${latestDetails ? `; ${latestDetails} ${copy.latest}` : ''}.`;
  const gradientId = `insights-area-${titleId.replace(/:/g, '')}`;
  const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];

  return (
    <div ref={ref} className="w-full">
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-subtle" aria-label={copy.chartLabel}>
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-accent" aria-hidden="true" />
          {copy.views}
        </span>
        {hasClicks && (
          <span className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-sm bg-success" aria-hidden="true" />
            {copy.clicks}
          </span>
        )}
      </div>
      {!hasClicks && <p className="mb-3 text-xs text-muted">{copy.clicksUnavailable}</p>}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-64 w-full overflow-visible sm:h-72"
        role="img"
        aria-labelledby={titleId}
      >
        <title id={titleId}>{summary}</title>
        <desc>{summary}</desc>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-chart-area)" stopOpacity="0.62" />
            <stop offset="100%" stopColor="var(--color-chart-area)" stopOpacity="0.04" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((ratio) => {
          const yPos = top + chartHeight * ratio;
          const tickValue = maxViews * (1 - ratio);
          return (
            <g key={ratio}>
              <line x1={left} x2={width - right} y1={yPos} y2={yPos} stroke="var(--color-chart-grid)" strokeWidth="1" />
              <text x={left - 10} y={yPos} textAnchor="end" dominantBaseline="middle" style={{ fill: 'var(--color-chart-tick)', fontSize: '11px' }}>{formatNumber(Math.round(tickValue), locale)}</text>
            </g>
          );
        })}
        <path
          d={areaPath}
          fill={`url(#${gradientId})`}
          style={{ opacity: inView ? 1 : 0, transition: 'opacity 700ms ease-out 100ms' }}
        />
        {hasClicks && points.map((point, index) => {
          if (typeof point.applyClicks !== 'number') return null;
          const barWidth = Math.max(chartWidth / points.length * 0.38, 8);
          const barHeight = chartHeight - (yClicks(finiteMetric(point.applyClicks)) - top);
          return (
            <rect
              key={`click-${point.week}`}
              x={x(index) - barWidth / 2}
              y={top + chartHeight - barHeight}
              width={barWidth}
              height={barHeight}
              rx="3"
              fill="var(--color-success)"
              opacity={inView ? 0.72 : 0}
              style={{ transition: `opacity 500ms ease-out ${index * 60}ms` }}
            >
              <title>{`${formatWeek(point.week, locale)}: ${formatNumber(finiteMetric(point.applyClicks), locale)} ${copy.recordedClicks}`}</title>
            </rect>
          );
        })}
        <path
          d={`M ${viewPath}`}
          fill="none"
          stroke="var(--color-chart-line)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          pathLength={1}
          style={{
            strokeDasharray: 1,
            strokeDashoffset: inView ? 0 : 1,
            transition: 'stroke-dashoffset 1000ms cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        />
        {points.map((point, index) => (
          <circle
            key={`view-${point.week}`}
            cx={x(index)}
            cy={y(finiteMetric(point.views))}
            r="4.5"
            fill="var(--color-chart-dot)"
            stroke="var(--color-surface)"
            strokeWidth="2"
            opacity={inView ? 1 : 0}
            style={{ transition: `opacity 500ms ease-out ${index * 60 + 180}ms` }}
          >
            <title>{`${formatWeek(point.week, locale)}: ${formatNumber(finiteMetric(point.views), locale)} ${copy.recordedViews}${typeof point.applyClicks === 'number' ? `; ${formatNumber(finiteMetric(point.applyClicks), locale)} ${copy.recordedClicks}` : ''}`}</title>
          </circle>
        ))}
        {labelIndexes.map((index) => (
          <text
            key={points[index].week}
            x={x(index)}
            y={height - 14}
            textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
            style={{ fill: 'var(--color-chart-label)', fontSize: '12px' }}
          >
            {formatWeek(points[index].week, locale)}
          </text>
        ))}
      </svg>
      <ol className="sr-only">
        {points.map((point) => <li key={`summary-${point.week}`}>{`${formatWeek(point.week, locale)}: ${formatNumber(finiteMetric(point.views), locale)} ${copy.recordedViews}${hasFiniteMetric(point.applyClicks) ? `; ${formatNumber(finiteMetric(point.applyClicks), locale)} ${copy.recordedClicks}` : ''}`}</li>)}
      </ol>
      <p className="sr-only">{summary}</p>
    </div>
  );
}

export default InsightsTrendChart;
