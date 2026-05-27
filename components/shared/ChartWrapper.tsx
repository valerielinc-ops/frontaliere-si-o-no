import { useState, useEffect, type ReactNode } from 'react';
import { ResponsiveContainer } from 'recharts';
import { useChartColors, type ChartChrome } from '@/hooks/useChartColors';

interface ChartWrapperProps {
  /** Height in pixels passed to ResponsiveContainer. Default 300. */
  height?: number | string;
  /** Extra classes on the outer div. */
  className?: string;
  /** Render prop that receives resolved chart chrome colors. */
  children: (colors: ChartChrome) => ReactNode;
  /**
   * If the parent already tracks dark mode, pass it here to skip the
   * internal MutationObserver. Useful for components that receive
   * isDarkMode as a prop (e.g. ComparisonChart).
   */
  isDarkMode?: boolean;
}

function useDarkMode(): boolean {
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains('dark'),
  );
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setIsDark(document.documentElement.classList.contains('dark')),
    );
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => obs.disconnect();
  }, []);
  return isDark;
}

function ChartWrapper({
  height = 300,
  className,
  children,
  isDarkMode,
}: ChartWrapperProps) {
  const internalDark = useDarkMode();
  const dark = isDarkMode ?? internalDark;
  const chart = useChartColors(dark);

  return (
    <ResponsiveContainer width="100%" height={height} className={className}>
      {children(chart)}
    </ResponsiveContainer>
  );
}

export default ChartWrapper;
