/**
 * useAdPageDiag — starts the per-page ad diagnosis (services/adPageDiag.ts)
 * for the landing page and for every SPA route change.
 *
 * It listens to the synthetic events of useSeoPageTracking's history patch
 * instead of patching history again: those fire right after `pushState` /
 * `replaceState`, before the new route renders, so the previous page view's
 * snapshot is taken on its own DOM. `startAdPageDiag` is keyed on the
 * pathname: a `replaceState` that only rewrites the query is a no-op, and on
 * a static page the loader already owns the first page view.
 *
 * The service is loaded lazily, off the first-render path. Development and
 * test builds skip it (no AdSense there, AdSenseBanner renders nothing).
 */
import { useEffect } from 'react';

import { SEO_TRACKING_PUSH_EVENT, SEO_TRACKING_REPLACE_EVENT } from './useSeoPageTracking';

const ROUTE_EVENTS = ['popstate', SEO_TRACKING_PUSH_EVENT, SEO_TRACKING_REPLACE_EVENT] as const;

export function useAdPageDiag(enabled: boolean = !import.meta.env.DEV): void {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;
    let cancelled = false;
    let start: ((pathname: string) => void) | null = null;
    const fire = () => {
      try {
        start?.(window.location.pathname);
      } catch {
        // Never let a diagnosis break navigation.
      }
    };
    for (const name of ROUTE_EVENTS) window.addEventListener(name, fire);
    import('@/services/adPageDiag')
      .then((mod) => {
        if (cancelled) return;
        start = (pathname) => mod.startAdPageDiag(pathname);
        fire();
      })
      .catch(() => {
        /* chunk failed to load: no diagnosis, nothing else changes */
      });
    return () => {
      cancelled = true;
      for (const name of ROUTE_EVENTS) window.removeEventListener(name, fire);
    };
  }, [enabled]);
}
