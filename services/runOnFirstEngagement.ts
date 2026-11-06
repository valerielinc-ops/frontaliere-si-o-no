/**
 * Run background work once the visitor engages, or after a timeout.
 *
 * Bookkeeping that needs a heavy client must not compete with first paint and
 * hydration, where it turns straight into INP on mobile. Lighthouse and crawlers
 * do not interact, so they only reach the timeout.
 */
const ENGAGEMENT_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'scroll'] as const;

export function runOnFirstEngagement(task: () => void, timeoutMs = 15000): void {
  if (typeof window === 'undefined') return;
  let done = false;
  const options: AddEventListenerOptions = { capture: true, passive: true };
  const run = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    for (const name of ENGAGEMENT_EVENTS) window.removeEventListener(name, run, options);
    task();
  };
  const timer = setTimeout(run, timeoutMs);
  for (const name of ENGAGEMENT_EVENTS) window.addEventListener(name, run, options);
}
