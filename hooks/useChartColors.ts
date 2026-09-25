/**
 * useChartColors — reads chart CSS custom properties so Recharts gets
 * the correct hex values for the current light/dark mode.
 *
 * CSS variables auto-switch when html.dark is toggled; this hook
 * re-resolves them via getComputedStyle so chart chrome (grid, ticks,
 * tooltips) stays in sync without isDark ternaries in every component.
 *
 * Data series colors (green = positive, red = negative, etc.) are
 * mode-independent constants exported as CHART_DATA_COLORS.
 */
import { useMemo, type CSSProperties } from 'react';

function resolveVar(name: string): string {
 return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export interface ChartChrome {
 grid: string;
 tick: string;
 tooltipBg: string;
 tooltipText: string;
 tooltipBorder: string;
 /** Pre-built Recharts Tooltip contentStyle object */
 tooltipStyle: CSSProperties;
}

/** Recharts data-series palette — constant across light/dark */
export const CHART_DATA_COLORS = {
 // Semantic
 positive: '#10b981',   // emerald-500
 positiveAlt: '#34d399', // emerald-400
 negative: '#ef4444',   // red-500
 negativeAlt: '#fca5a5', // red-300
 warning: '#f59e0b',    // amber-500
 rose: '#f43f5e',       // rose-500
 // Series
 indigo: '#6366f1',     // indigo-500
 blue: '#3b82f6',       // blue-500
 violet: '#8b5cf6',     // violet-500
 violetLight: '#a78bfa', // violet-400
 orange: '#f97316',     // orange-500
 green: '#22c55e',      // green-500
 greenLight: '#86efac',  // green-300
 slate: '#64748b',      // slate-500
 slateLight: '#94a3b8',  // slate-400
 slateMuted: '#cbd5e1',  // slate-300
} as const;

/**
 * Returns resolved chart chrome colors from CSS variables.
 * Re-resolves when isDarkMode changes.
 */
export function useChartColors(isDarkMode: boolean): ChartChrome {
 return useMemo(() => {
   const grid = resolveVar('--color-chart-grid') || (isDarkMode ? '#334155' : '#e2e8f0');
   const tick = resolveVar('--color-chart-tick') || (isDarkMode ? '#94a3b8' : '#64748b');
   const tooltipBg = resolveVar('--color-chart-tooltip-bg') || (isDarkMode ? '#1e293b' : '#fff');
   const tooltipText = resolveVar('--color-chart-tooltip-text') || (isDarkMode ? '#e2e8f0' : '#1e293b');
   const tooltipBorder = resolveVar('--color-chart-tooltip-border') || (isDarkMode ? '#334155' : '#e2e8f0');
   return {
     grid,
     tick,
     tooltipBg,
     tooltipText,
     tooltipBorder,
     tooltipStyle: {
       borderRadius: '12px',
       border: 'none',
       backgroundColor: tooltipBg,
       color: tooltipText,
     },
   };
 }, [isDarkMode]);
}
