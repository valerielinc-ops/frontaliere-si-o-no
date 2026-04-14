import { useEffect, useState } from 'react';

/**
 * Client-side media query hook.
 * Returns `null` during SSR (no window), then `true`/`false` based on the query.
 * On the browser, the lazy `useState` initializer evaluates the query synchronously
 * during the first render — eliminating the null→boolean transition that causes CLS.
 *
 * Usage:
 * const isDesktop = useMediaQuery('(min-width: 1024px)');
 * if (isDesktop === null) return null; // SSR-only guard (rarely needed on client)
 * if (isDesktop) return <DesktopLayout />;
 */
export function useMediaQuery(query: string): boolean | null {
 const [matches, setMatches] = useState<boolean | null>(() => {
 // Lazy initializer: runs synchronously during first render on the client.
 // On SSR (no window) returns null; on the browser returns the real match state,
 // so there is never a null→boolean transition that would cause layout shift.
 if (typeof window === 'undefined') return null;
 return window.matchMedia(query).matches;
 });

 useEffect(() => {
 const mql = window.matchMedia(query);
 // Re-confirm on mount (handles query changes after first render)
 setMatches(mql.matches);
 const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
 mql.addEventListener('change', handler);
 return () => mql.removeEventListener('change', handler);
 }, [query]);

 return matches;
}
