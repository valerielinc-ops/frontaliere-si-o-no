/**
 * Keep the large SPA runtime off the main thread until prerendered content has
 * actually reached a contentful paint. Two animation frames only prove that
 * callbacks ran; they do not prove the browser painted text before React's
 * shared chunks start parsing and evaluating.
 */
export const INITIAL_PAINT_FRAME_TIMEOUT_MS = 250;
export const INITIAL_CONTENTFUL_PAINT_TIMEOUT_MS = 2500;
export const INITIAL_LARGEST_CONTENTFUL_PAINT_TIMEOUT_MS = 5000;
export const LARGEST_CONTENTFUL_PAINT_QUIET_TIMEOUT_MS = 250;

export type LargestContentfulPaintCandidateFilter = (element: Element | null) => boolean;

export interface InitialPaintBootstrapOptions {
  /** Wait for the real FCP entry on routes with useful prerendered content. */
  waitForContentfulPaint?: boolean;
  /** Wait for a quiet LCP candidate before booting the SPA runtime. */
  waitForLargestContentfulPaint?: boolean;
  /** Restrict the LCP wait to the prerendered surface that must paint first. */
  largestContentfulPaintSelector?: string;
}

export interface InitialPaintBootstrapEnv {
  visible: () => boolean;
  hasContentfulPaint: () => boolean;
  observeContentfulPaint: (callback: () => void) => (() => void) | null;
  hasLargestContentfulPaint?: (filter?: LargestContentfulPaintCandidateFilter) => boolean;
  observeLargestContentfulPaint?: (callback: (element: Element | null) => void) => (() => void) | null;
  requestFrame: (callback: FrameRequestCallback) => number;
  setTimer: (callback: () => void, ms: number) => number;
  clearTimer: (timer: number) => void;
}

export function waitForInitialPaintOpportunity(
  options: InitialPaintBootstrapOptions = {},
  env: InitialPaintBootstrapEnv = {
    visible: () => document.visibilityState !== 'hidden',
    hasContentfulPaint: () => performance.getEntriesByType('paint')
      .some((entry) => entry.name === 'first-contentful-paint'),
    observeContentfulPaint: (callback) => {
      if (typeof PerformanceObserver === 'undefined') return null;
      const observer = new PerformanceObserver((list) => {
        if (list.getEntries().some((entry) => entry.name === 'first-contentful-paint')) callback();
      });
      try {
        observer.observe({ type: 'paint', buffered: true });
      } catch {
        observer.disconnect();
        return null;
      }
      return () => observer.disconnect();
    },
    hasLargestContentfulPaint: (filter = () => true) => performance
      .getEntriesByType('largest-contentful-paint')
      .some((entry) => filter(largestContentfulPaintElement(entry))),
    observeLargestContentfulPaint: (callback) => {
      if (typeof PerformanceObserver === 'undefined') return null;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) callback(largestContentfulPaintElement(entry));
      });
      try {
        observer.observe({ type: 'largest-contentful-paint', buffered: true });
      } catch {
        observer.disconnect();
        return null;
      }
      return () => observer.disconnect();
    },
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    setTimer: (callback, ms) => window.setTimeout(callback, ms),
    clearTimer: (timer) => window.clearTimeout(timer),
  },
): Promise<void> {
  if (!env.visible()) return Promise.resolve();
  if (options.waitForContentfulPaint && env.hasContentfulPaint()) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    let frames = 0;
    let timer = 0;
    let quietTimer: number | null = null;
    let stopObserving = () => {};
    const finish = () => {
      if (settled) return;
      settled = true;
      env.clearTimer(timer);
      if (quietTimer !== null) env.clearTimer(quietTimer);
      stopObserving();
      resolve();
    };

    if (options.waitForLargestContentfulPaint) {
      const candidateFilter: LargestContentfulPaintCandidateFilter = options.largestContentfulPaintSelector
        ? (element) => Boolean(element?.closest(options.largestContentfulPaintSelector!))
        : () => true;
      const armQuietTimer = () => {
        if (quietTimer !== null) env.clearTimer(quietTimer);
        quietTimer = env.setTimer(finish, LARGEST_CONTENTFUL_PAINT_QUIET_TIMEOUT_MS);
      };
      const reportCandidate = (element: Element | null) => {
        if (candidateFilter(element)) armQuietTimer();
      };
      const stop = env.observeLargestContentfulPaint?.(reportCandidate);
      if (stop) {
        stopObserving = stop;
        if (settled) {
          stopObserving();
          return;
        }
        timer = env.setTimer(finish, INITIAL_LARGEST_CONTENTFUL_PAINT_TIMEOUT_MS);
        // A buffered observer normally reports this entry, but arm the quiet
        // period explicitly for implementations that only notify future entries.
        if (env.hasLargestContentfulPaint?.(candidateFilter)) armQuietTimer();
        return;
      }
      if (env.hasLargestContentfulPaint?.(candidateFilter)) {
        finish();
        return;
      }
    }

    if (options.waitForContentfulPaint) {
      const stop = env.observeContentfulPaint(finish);
      if (stop) {
        stopObserving = stop;
        if (settled) {
          stopObserving();
          return;
        }
        timer = env.setTimer(finish, INITIAL_CONTENTFUL_PAINT_TIMEOUT_MS);
        return;
      }
    }

    const nextFrame: FrameRequestCallback = () => {
      frames += 1;
      if (frames === 2) finish();
      else env.requestFrame(nextFrame);
    };

    // If the browser cannot observe the requested paint, preserve the short
    // bounded frame fallback rather than waiting the longer paint deadline.
    timer = env.setTimer(finish, INITIAL_PAINT_FRAME_TIMEOUT_MS);
    env.requestFrame(nextFrame);
  });
}

const largestContentfulPaintElement = (entry: PerformanceEntry): Element | null => {
  const element = (entry as PerformanceEntry & { element?: Element | null }).element;
  return element && typeof element.closest === 'function' ? element : null;
};
