/**
 * useImpressionTracker — fire an impression callback the first time an element
 * is actually visible in the viewport.
 *
 * Why this exists (issue #5039): `Analytics.trackJobAlertCtaShown` documents
 * itself as "the surface became VISIBLE to the user without any explicit
 * action", but several call sites fired it from a bare `useEffect` on mount.
 * A surface that renders at the bottom of a long job list is mounted on every
 * page load and seen by almost nobody, so the `job_alert_cta_shown` denominator
 * of the `alert_funnel_conversion` goal counted renders, not impressions.
 *
 * Measured on 14d of PostHog before the fix: `end_card` 440 "impressions" with
 * 0 clicks and 0 conversions, `job_match_pill` 300 with 0 and 0 — together 56%
 * of the denominator, from two surfaces that never registered a single
 * interaction. A CTA with hundreds of impressions and literally zero clicks is
 * a surface nobody saw, not a surface nobody liked.
 *
 * Contract:
 *   - fires AT MOST ONCE per mounted element, on first intersection;
 *   - `threshold` is the fraction of the element that must be visible (default
 *     0.5 — half the card on screen is a defensible "seen");
 *   - no IntersectionObserver (jsdom, very old browsers) → fires immediately,
 *     i.e. degrades to the previous mount-based behaviour rather than losing
 *     the event entirely;
 *   - the callback is read through a ref, so an inline arrow function at the
 *     call site does not re-arm the observer on every render.
 *
 * Returns a ref callback to spread onto the element whose visibility counts.
 */
import { useCallback, useEffect, useRef } from 'react';

export interface ImpressionTrackerOptions {
  /** Fraction of the element that must be visible to count. Default 0.5. */
  threshold?: number;
  /** When false the observer is never armed and no impression is recorded. */
  enabled?: boolean;
}

export function useImpressionTracker(
  onImpression: () => void,
  { threshold = 0.5, enabled = true }: ImpressionTrackerOptions = {},
): (node: Element | null) => void {
  const callbackRef = useRef(onImpression);
  callbackRef.current = onImpression;

  const firedRef = useRef(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const nodeRef = useRef<Element | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const fire = useCallback(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    observerRef.current?.disconnect();
    observerRef.current = null;
    callbackRef.current();
  }, []);

  const observe = useCallback(
    (node: Element | null) => {
      nodeRef.current = node;
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!node || firedRef.current || !enabledRef.current) return;

      if (typeof IntersectionObserver === 'undefined') {
        // Degrade to mount-based rather than dropping the event.
        fire();
        return;
      }

      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) fire();
        },
        { threshold },
      );
      io.observe(node);
      observerRef.current = io;
    },
    [fire, threshold],
  );

  // Arm late: a surface can be rendered while `enabled` is still false (e.g. an
  // eligibility check is in flight). Re-observe when it flips true so the
  // impression is not lost for an element that mounted before it was eligible.
  useEffect(() => {
    if (enabled && !firedRef.current && nodeRef.current && !observerRef.current) {
      observe(nodeRef.current);
    }
  }, [enabled, observe]);

  useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
  }, []);

  return observe;
}

export default useImpressionTracker;
