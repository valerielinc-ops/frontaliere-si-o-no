/**
 * Run work AFTER the browser has presented the next frame.
 *
 * Why: INP measures from the input to the next paint, and everything queued
 * before that paint counts — the event listeners, the microtasks they spawn
 * (Firebase `logEvent` awaits its init promise, so GA4's `gtag` processing
 * lands there), and requestAnimationFrame callbacks. The document-level click
 * listener in services/analytics.ts did all of that for every tap on the site:
 * measured on /calcola-stipendio/ with a 4x CPU profile, `#document.onclick`
 * alone held a single interaction for ~660 ms, ahead of React's own handler.
 * Telemetry about a tap does not need to happen before the tap is painted.
 *
 * Ordering is FIFO. Pending work is flushed synchronously on `pagehide` and
 * when the page becomes hidden, so an event recorded right before a full-page
 * navigation or a tab switch is not dropped (rAF does not fire in a hidden
 * tab).
 */

type Task = () => void;

const queue: Task[] = [];
let scheduled = false;
let lifecycleBound = false;
let batch = 0;
// A frame that never comes (tab already hidden, rendering throttled) must not
// strand the queue.
const FALLBACK_MS = 1000;

function runQueued(): void {
  scheduled = false;
  batch++;
  const tasks = queue.splice(0);
  for (const task of tasks) {
    try {
      task();
    } catch (error) {
      // Surface the failure the way an uncaught listener error would, without
      // stopping the tasks queued behind it.
      queueMicrotask(() => { throw error; });
    }
  }
}

function bindLifecycleFlush(): void {
  if (lifecycleBound) return;
  lifecycleBound = true;
  window.addEventListener('pagehide', runQueued);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') runQueued();
  });
}

export function runAfterNextPaint(task: Task): void {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    task();
    return;
  }
  queue.push(task);
  bindLifecycleFlush();
  if (scheduled) return;
  scheduled = true;
  const scheduledBatch = batch;
  const runIfStillPending = () => {
    if (batch === scheduledBatch) runQueued();
  };
  // rAF runs right before the frame is painted; the timeout queued from it
  // runs after that frame has been presented.
  window.requestAnimationFrame(() => {
    window.setTimeout(runIfStillPending, 0);
  });
  window.setTimeout(runIfStillPending, FALLBACK_MS);
}

/** Test hook: run whatever is queued now. */
export function flushAfterNextPaintForTests(): void {
  runQueued();
}
