/**
 * useCountUp — animates a number from 0 → target on mount (or when `active`
 * flips true), using an ease-out-quart curve via requestAnimationFrame.
 *
 * Honours `prefers-reduced-motion`: those users see the final value instantly,
 * no animation. Shared by the publisher dashboard KPI band and the
 * For-Employers landing stat tiles so the "count up" behaviour stays identical
 * in both places (single source of truth, no copy-paste drift).
 */

import { useEffect, useRef, useState } from 'react';

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ease-out-quart — fast start, gentle deceleration (real objects decelerate).
const easeOutQuart = (t: number): number => 1 - Math.pow(1 - t, 4);

interface UseCountUpOptions {
  /** Milliseconds for the full sweep. Default 1400. */
  durationMs?: number;
  /** When false, the counter stays at 0 and waits (e.g. until data is ready). */
  active?: boolean;
  /** Decimal places to preserve while counting (e.g. 1 for a 3.7% rate). Default 0. */
  decimals?: number;
}

export function useCountUp(
  target: number,
  { durationMs = 1400, active = true, decimals = 0 }: UseCountUpOptions = {},
): number {
  const safeTarget = Number.isFinite(target) ? target : 0;
  const factor = Math.pow(10, decimals);
  const round = (n: number) => Math.round(n * factor) / factor;
  const [value, setValue] = useState(0);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;

    if (prefersReducedMotion() || safeTarget === 0) {
      setValue(round(safeTarget));
      return;
    }

    let start: number | null = null;
    const tick = (now: number) => {
      if (start === null) start = now;
      const progress = Math.min((now - start) / durationMs, 1);
      // Land exactly on the target at the final frame, so a decimal like 3.7
      // isn't rounded up to 4.
      setValue(progress >= 1 ? round(safeTarget) : round(easeOutQuart(progress) * safeTarget));
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(tick);
      }
    };
    frameRef.current = requestAnimationFrame(tick);

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [safeTarget, durationMs, active, decimals]);

  return value;
}
