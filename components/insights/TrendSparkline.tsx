/**
 * TrendSparkline — animated weekly-views area + line chart, hand-rolled SVG
 * (no charting lib, no new deps).
 *
 * "Wow" detail: the line path "draws in" left→right via stroke-dasharray /
 * stroke-dashoffset, and the area gradient fades up, both triggered when the
 * chart scrolls into view (`useReveal`). A pulsing end dot marks the latest
 * week so the eye lands on "now".
 *
 * Responsive: the SVG uses a viewBox + preserveAspectRatio="none" so it scales
 * full-width on mobile. Colours come from semantic chart tokens
 * (`--color-chart-line` / `--color-chart-area` / `--color-chart-dot`) — no hex.
 *
 * Accessibility: role="img" + a descriptive aria-label summarising the trend
 * (first→last week, direction); reduced-motion users see the final drawn path
 * instantly (dashoffset 0 + reveal fires immediately, transitions disabled in CSS).
 */
import React, { useId } from 'react';
import type { EmployerInsights } from '@/services/employerInsights';
import type { Locale } from '@/services/i18n';
import { useReveal } from './useReveal';

interface TrendSparklineProps {
  trend: EmployerInsights['trend'];
  /** SVG coordinate height. Width is a fixed 100-unit viewBox (scales to container). */
  height?: number;
  locale?: Locale;
}

function trendCopy(locale: Locale): { growing: string; declining: string; stable: string; label: string; latest: string } {
  if (locale === 'en') return { growing: 'growing', declining: 'declining', stable: 'stable', label: 'Weekly recorded views', latest: 'in the latest week' };
  if (locale === 'de') return { growing: 'steigend', declining: 'sinkend', stable: 'stabil', label: 'Wöchentliche erfasste Aufrufe', latest: 'in der letzten Woche' };
  if (locale === 'fr') return { growing: 'en hausse', declining: 'en baisse', stable: 'stable', label: 'Vues hebdomadaires enregistrées', latest: 'durant la dernière semaine' };
  return { growing: 'in crescita', declining: 'in calo', stable: 'stabile', label: 'Andamento visualizzazioni settimanali', latest: "nell'ultima settimana" };
}

export function TrendSparkline({ trend, height = 48, locale = 'it' }: TrendSparklineProps): React.ReactElement | null {
  const { ref, inView } = useReveal<HTMLDivElement>();
  const gradId = useId();

  if (!trend || trend.length < 2) return null;

  const W = 100;
  const H = height;
  const pad = 4;
  const values = trend.map((p) => p.views);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = Math.max(max - min, 1);

  const x = (i: number) => pad + (i / (trend.length - 1)) * (W - pad * 2);
  const y = (v: number) => H - pad - ((v - min) / span) * (H - pad * 2);

  const linePts = trend.map((p, i) => `${x(i).toFixed(2)},${y(p.views).toFixed(2)}`);
  const linePath = `M ${linePts.join(' L ')}`;
  const areaPath = `${linePath} L ${x(trend.length - 1).toFixed(2)},${H - pad} L ${x(0).toFixed(2)},${H - pad} Z`;

  const first = trend[0].views;
  const last = trend[trend.length - 1].views;
  const nf = new Intl.NumberFormat(locale === 'it' ? 'it-IT' : locale);
  const copy = trendCopy(locale);
  const dir = last > first ? copy.growing : last < first ? copy.declining : copy.stable;
  const ariaLabel = `${copy.label}, ${dir}: ${nf.format(first)} → ${nf.format(last)} ${copy.latest}.`;

  const endX = x(trend.length - 1);
  const endY = y(last);

  return (
    <div ref={ref} className="w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full h-16 sm:h-20"
        role="img"
        aria-label={ariaLabel}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-chart-area)" stopOpacity="0.55" />
            <stop offset="100%" stopColor="var(--color-chart-area)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* Area fill — fades up on reveal */}
        <path
          d={areaPath}
          fill={`url(#${gradId})`}
          style={{ opacity: inView ? 1 : 0, transition: 'opacity 900ms ease-out 250ms' }}
        />
        {/* Line — draws in left→right */}
        <path
          d={linePath}
          fill="none"
          stroke="var(--color-chart-line)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          pathLength={1}
          style={{
            strokeDasharray: 1,
            strokeDashoffset: inView ? 0 : 1,
            transition: 'stroke-dashoffset 1200ms cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        />
        {/* End dot — pulses to draw the eye to "now" */}
        <circle
          cx={endX}
          cy={endY}
          r={2.4}
          fill="var(--color-chart-dot)"
          vectorEffect="non-scaling-stroke"
          style={{ opacity: inView ? 1 : 0, transition: 'opacity 400ms ease-out 1100ms' }}
        >
          <animate attributeName="r" values="2.4;3.6;2.4" dur="1.8s" repeatCount="indefinite" />
        </circle>
      </svg>
    </div>
  );
}

export default TrendSparkline;
