import { useEffect, useState } from 'react';

/**
 * Client-side media query hook.
 * Returns `null` during SSR/initial hydration (no match assumed),
 * then resolves to `true`/`false` once the browser evaluates the query.
 *
 * Usage:
 *   const isDesktop = useMediaQuery('(min-width: 1024px)');
 *   if (isDesktop === null) return null; // hydration phase
 *   if (isDesktop) return <DesktopAd />;
 */
export function useMediaQuery(query: string): boolean | null {
  const [matches, setMatches] = useState<boolean | null>(null);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);

    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}
