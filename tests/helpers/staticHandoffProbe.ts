/**
 * Probe and verdict for the static snapshot → SPA handoff (issue 12421).
 *
 * Two halves on purpose. `installStaticHandoffProbe` runs IN THE PAGE, from
 * before the first script, and only records what a reader could see, one entry
 * per change. `judgeStaticHandoff` runs in Node on that record and is plain
 * arithmetic, so the rule a red check enforces is unit-tested without a
 * browser (tests/article-hydration-handoff.test.ts) instead of being trusted
 * because it once passed against production.
 *
 * What the first version of this guard got wrong, and why the SPA copy is
 * found by its TITLE and not by `#root article`: until this fix the entry moved
 * the static article INSIDE `#root`, so `#root article` matched the static
 * article itself and the probe declared the page hydrated one frame before the
 * article vanished. A guard that goes green on the defect it was written for
 * guards nothing.
 */

export type StaticPlace = 'none' | 'outside-visible' | 'outside-hidden' | 'inside-visible' | 'inside-hidden';

export interface HandoffState {
  /** Milliseconds since navigation start. */
  t: number;
  /** Where the static snapshot is, and whether a reader can see it. */
  snapshot: StaticPlace;
  /** Document-relative top of the snapshot's title while a reader can see it. */
  snapshotTop: number | null;
  /** Document-relative top of the SPA's own copy of that title, once drawn. */
  spaTop: number | null;
  /** The SPA `<main>` is painted. It must not be while the snapshot is. */
  spaMainPainted: boolean;
}

export interface HandoffRecord {
  states: HandoffState[];
  /** The snapshot's title, as first read. */
  title: string | null;
  samples: number;
  /** Longest stretch without a sample: what the record cannot vouch for. */
  longestSampleGapMs: number;
  /** The SPA copy was the only one on screen for the whole settle window. */
  settled: boolean;
  endedAt: number;
  /** Sum of the layout shifts the browser reported (no recent input). */
  layoutShift: number;
}

export interface HandoffProbeOptions {
  /** The static snapshot whose `<h1>` is the title to follow. */
  snapshotSelector: string;
  /** How long the SPA copy must stay up alone before the probe stops. */
  settleMs: number;
  limitMs: number;
}

/**
 * Pass to `page.addInitScript(installStaticHandoffProbe, options)`. Serialized
 * into the page: it must not close over anything in this module.
 */
export function installStaticHandoffProbe(options: HandoffProbeOptions): void {
  const record: HandoffRecord = {
    states: [], title: null, samples: 0, longestSampleGapMs: 0, settled: false, endedAt: 0, layoutShift: 0,
  };
  (window as unknown as { __staticHandoff: HandoffRecord }).__staticHandoff = record;

  const normalize = (text: string | null | undefined) => (text || '').replace(/\s+/g, ' ').trim();
  // Painted for a reader: laid out, not hidden by itself or an ancestor, not
  // faded out, and not clipped away by a collapsed ancestor.
  const painted = (element: Element | null): boolean => {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility !== 'visible') return false;
      if (Number.parseFloat(style.opacity) < 0.05) return false;
      if (node !== element && (style.overflowY === 'hidden' || style.overflowY === 'clip')
        && node.getBoundingClientRect().height < 2) return false;
    }
    return true;
  };
  const documentTop = (element: Element) => Math.round(element.getBoundingClientRect().top + window.scrollY);

  const read = (): Omit<HandoffState, 't'> => {
    const root = document.getElementById('root');
    const snapshot = document.querySelector(options.snapshotSelector);
    const snapshotTitle = snapshot ? snapshot.querySelector('h1') : null;
    if (snapshotTitle && record.title === null) record.title = normalize(snapshotTitle.textContent);
    let place: StaticPlace = 'none';
    if (snapshot) {
      const where = root && root.contains(snapshot) ? 'inside' : 'outside';
      place = `${where}-${painted(snapshotTitle || snapshot) ? 'visible' : 'hidden'}` as StaticPlace;
    }
    let spaTop: number | null = null;
    if (root && record.title) {
      for (const heading of Array.from(root.querySelectorAll('h1'))) {
        if (snapshot && snapshot.contains(heading)) continue;
        if (normalize(heading.textContent) !== record.title || !painted(heading)) continue;
        spaTop = documentTop(heading);
        break;
      }
    }
    return {
      snapshot: place,
      snapshotTop: snapshotTitle && place.endsWith('visible') ? documentTop(snapshotTitle) : null,
      spaTop,
      spaMainPainted: painted(document.getElementById('main-content')),
    };
  };

  let lastSampleAt = 0;
  let lastKey = '';
  let spaAloneSince: number | null = null;
  let stopped = false;
  const stop = (settled: boolean) => {
    if (stopped) return;
    stopped = true;
    record.settled = settled;
    record.endedAt = Math.round(performance.now());
  };
  const sample = () => {
    if (stopped) return;
    const now = performance.now();
    if (lastSampleAt) record.longestSampleGapMs = Math.max(record.longestSampleGapMs, Math.round(now - lastSampleAt));
    lastSampleAt = now;
    record.samples += 1;
    const state = read();
    const key = JSON.stringify(state);
    if (key !== lastKey) {
      lastKey = key;
      record.states.push({ t: Math.round(now), ...state });
    }
    const spaAlone = state.spaTop !== null && !state.snapshot.endsWith('visible');
    if (!spaAlone) spaAloneSince = null;
    else if (spaAloneSince === null) spaAloneSince = now;
    else if (now - spaAloneSince >= options.settleMs) stop(true);
    if (now >= options.limitMs) stop(false);
  };
  // Every frame is what a reader sees; the timer covers a frame loop that
  // stalls (long task) or never runs (background tab).
  const frame = () => {
    sample();
    if (!stopped) window.requestAnimationFrame(frame);
  };
  window.requestAnimationFrame(frame);
  window.setInterval(() => {
    if (!stopped && performance.now() - lastSampleAt > 200) sample();
  }, 100);

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) {
        if (!entry.hadRecentInput) record.layoutShift += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {
    // Layout Instability is not exposed: the positions in the record still are.
  }
}

export interface HandoffVerdict {
  /** When the snapshot was first on screen. */
  firstSnapshotMs: number | null;
  /** Start of the last, uninterrupted run of "SPA copy alone on screen". */
  swapMs: number | null;
  /** Neither the snapshot nor the SPA copy on screen. */
  gapMs: number;
  /** Both on screen at once. */
  bothMs: number;
  /** The SPA `<main>` painted while the snapshot was on screen. */
  spaMainOverSnapshotMs: number;
  /** Farthest the snapshot's title moved from where it was first painted. */
  snapshotShiftPx: number;
  violations: string[];
}

export interface HandoffVerdictOptions {
  toleratedShiftPx?: number;
  /**
   * A version-skewed runtime payload deliberately leaves the complete static
   * snapshot in charge. Callers that own that fail-closed contract may accept
   * the unchanged snapshot after the probe window instead of requiring a SPA
   * takeover; gaps, duplicate copies, movement and a painted SPA main still
   * remain violations.
   */
  allowStableSnapshot?: boolean;
}

/**
 * The invariant: from the first paint of the snapshot until the SPA copy has
 * settled (or an opted-in fail-closed snapshot owns the whole probe window), a
 * reader always sees exactly one body, and the snapshot does not move while it
 * is the one on screen.
 */
export function judgeStaticHandoff(
  record: HandoffRecord,
  { toleratedShiftPx = 4, allowStableSnapshot = false }: HandoffVerdictOptions = {},
): HandoffVerdict {
  const verdict: HandoffVerdict = {
    firstSnapshotMs: null, swapMs: null, gapMs: 0, bothMs: 0, spaMainOverSnapshotMs: 0, snapshotShiftPx: 0, violations: [],
  };
  let firstTop: number | null = null;
  let movedInsideRoot = false;
  record.states.forEach((state, index) => {
    const until = index + 1 < record.states.length ? record.states[index + 1].t : Math.max(record.endedAt, state.t);
    const lasted = until - state.t;
    const snapshotShown = state.snapshot.endsWith('visible');
    if (verdict.firstSnapshotMs === null && snapshotShown) verdict.firstSnapshotMs = state.t;
    if (verdict.firstSnapshotMs === null) return;
    if (state.snapshot.startsWith('inside')) movedInsideRoot = true;
    if (state.spaTop !== null && !snapshotShown) {
      if (verdict.swapMs === null) verdict.swapMs = state.t;
    } else {
      verdict.swapMs = null;
    }
    if (!snapshotShown && state.spaTop === null) verdict.gapMs += lasted;
    if (snapshotShown && state.spaTop !== null) verdict.bothMs += lasted;
    if (snapshotShown && state.spaMainPainted) verdict.spaMainOverSnapshotMs += lasted;
    if (snapshotShown && state.snapshotTop !== null) {
      if (firstTop === null) firstTop = state.snapshotTop;
      verdict.snapshotShiftPx = Math.max(verdict.snapshotShiftPx, Math.abs(state.snapshotTop - firstTop));
    }
  });

  if (verdict.firstSnapshotMs === null) {
    verdict.violations.push('the static snapshot was never on screen: there was nothing to hand off');
    return verdict;
  }
  if (movedInsideRoot) {
    verdict.violations.push('the static snapshot was moved inside #root, where the first React render replaces it');
  }
  if (verdict.gapMs > 0) {
    verdict.violations.push(`neither the static snapshot nor the SPA copy was on screen for ${verdict.gapMs} ms`);
  }
  if (verdict.bothMs > 0) {
    verdict.violations.push(`the static snapshot and the SPA copy were both on screen for ${verdict.bothMs} ms`);
  }
  if (verdict.spaMainOverSnapshotMs > 0) {
    verdict.violations.push(`the SPA <main> was painted for ${verdict.spaMainOverSnapshotMs} ms while the static snapshot owned the page`);
  }
  if (verdict.snapshotShiftPx > toleratedShiftPx) {
    verdict.violations.push(`the static snapshot moved by ${verdict.snapshotShiftPx} px while it was on screen`);
  }
  const finalState = record.states[record.states.length - 1];
  const spaEverPainted = record.states.some((state) => state.spaTop !== null || state.spaMainPainted);
  const stableSnapshotFallback = allowStableSnapshot
    && !record.settled
    && finalState?.snapshot === 'outside-visible'
    && finalState.spaTop === null
    && !spaEverPainted;
  if ((!record.settled || verdict.swapMs === null) && !stableSnapshotFallback) {
    verdict.violations.push('the SPA never settled on its own copy within the time limit');
  }
  return verdict;
}
