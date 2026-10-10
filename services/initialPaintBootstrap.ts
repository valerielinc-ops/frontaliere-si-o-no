/**
 * Give prerendered HTML one browser paint opportunity before loading the SPA
 * runtime. On static SEO routes, React's shared vendor chunk can occupy the
 * main thread for seconds on Lighthouse's mobile CPU throttle; loading it
 * before the crawler-facing fallback has painted turns that otherwise-useful
 * HTML into a late first paint.
 */
export const INITIAL_PAINT_FRAME_TIMEOUT_MS = 250;

export interface InitialPaintBootstrapEnv {
  visible: () => boolean;
  requestFrame: (callback: FrameRequestCallback) => number;
  setTimer: (callback: () => void, ms: number) => number;
  clearTimer: (timer: number) => void;
}

export function waitForInitialPaintOpportunity(
  env: InitialPaintBootstrapEnv = {
    visible: () => document.visibilityState !== 'hidden',
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    setTimer: (callback, ms) => window.setTimeout(callback, ms),
    clearTimer: (timer) => window.clearTimeout(timer),
  },
): Promise<void> {
  if (!env.visible()) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    let frames = 0;
    let timer = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      env.clearTimer(timer);
      resolve();
    };
    const nextFrame: FrameRequestCallback = () => {
      frames += 1;
      if (frames === 2) finish();
      else env.requestFrame(nextFrame);
    };

    timer = env.setTimer(finish, INITIAL_PAINT_FRAME_TIMEOUT_MS);
    env.requestFrame(nextFrame);
  });
}
