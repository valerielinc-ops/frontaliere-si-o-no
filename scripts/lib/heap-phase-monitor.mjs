/**
 * Per-phase heap/RSS log for memory-bound Node steps.
 *
 * A synchronous phase blocks timers, so the peak comes from two sources:
 * explicit `sample()` calls (e.g. after each input file) and V8's GC profiler,
 * which reports the heap size right before every collection. `sample()` warns
 * as soon as the threshold is crossed: a phase that dies of OOM never reaches
 * its final line, so the warning cannot wait for `finish()`.
 *
 * Observational only: nothing here may change the result of the caller.
 */
import v8 from 'node:v8';

export const HEAP_WARN_RATIO = 0.75;
const MB = 1024 * 1024;
const toMb = (bytes) => Math.round(bytes / MB);

export function startHeapPhase(phase, {
  log = (line) => console.log(line),
  warnRatio = HEAP_WARN_RATIO,
  heapLimitBytes = v8.getHeapStatistics().heap_size_limit,
  readUsage = () => process.memoryUsage(),
  GCProfiler = v8.GCProfiler,
} = {}) {
  let peakHeap = 0;
  let peakRss = 0;
  let warned = false;
  let finished = false;
  let profiler = null;
  try {
    if (GCProfiler) {
      profiler = new GCProfiler();
      profiler.start();
    }
  } catch {
    profiler = null;
  }

  const percent = (bytes) => Math.round((bytes / heapLimitBytes) * 100);
  const warnIfHigh = (note) => {
    if (warned || peakHeap <= heapLimitBytes * warnRatio) return;
    warned = true;
    const message = `[heap] ⚠️ ${phase}: heap ${toMb(peakHeap)} MB is ${percent(peakHeap)}% of the `
      + `${toMb(heapLimitBytes)} MB limit (warning above ${Math.round(warnRatio * 100)}%)`
      + `${note ? ` at ${note}` : ''}`;
    log(process.env.GITHUB_ACTIONS ? `::warning::${message}` : message);
  };

  const sample = (note = '') => {
    const usage = readUsage();
    peakHeap = Math.max(peakHeap, usage.heapUsed);
    peakRss = Math.max(peakRss, usage.rss);
    warnIfHigh(note);
    return usage;
  };

  const start = sample('phase start');
  log(`[heap] ${phase}: start heap ${toMb(start.heapUsed)} MB, rss ${toMb(start.rss)} MB, limit ${toMb(heapLimitBytes)} MB`);

  return {
    sample,
    finish() {
      if (finished) return null;
      finished = true;
      const end = sample('phase end');
      try {
        for (const gc of profiler?.stop()?.statistics ?? []) {
          peakHeap = Math.max(peakHeap, gc.beforeGC?.heapStatistics?.usedHeapSize ?? 0);
        }
      } catch {
        // The sampled peak is still reported.
      }
      warnIfHigh('a garbage collection inside the phase');
      log(
        `[heap] ${phase}: peak heap ${toMb(peakHeap)} MB (${percent(peakHeap)}% of limit), `
        + `end heap ${toMb(end.heapUsed)} MB, peak sampled rss ${toMb(peakRss)} MB`,
      );
      return { peakHeapBytes: peakHeap, peakRssBytes: peakRss, warned };
    },
  };
}
