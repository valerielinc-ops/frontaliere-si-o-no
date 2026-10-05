// @vitest-environment jsdom
/**
 * Issue 11666 — mobile FCP/LCP of /cerca-lavoro-ticino/ (and /) was bimodal.
 *
 * On SPA-takeover routes (router `staticOverlay` falsy) the mount in index.tsx
 * moves the static HTML into #root and fades #root to `opacity: 0` before React
 * renders. When that hide ran before the browser's first frame, nothing was
 * painted until React had rendered: observed first paint 1.3-2.4 s instead of
 * ~0.3 s, simulated mobile FCP 8-13 s instead of 4.6 s (Lighthouse runs of
 * 2026-10-02..05). The mount now waits for one presented frame of the static
 * HTML (bounded, and skipped for hidden documents) before the first hide.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  STATIC_FIRST_PAINT_TIMEOUT_MS,
  STATIC_HANDOFF_HIDE_MARK,
  hideRootForCrossfade,
  waitForStaticFirstPaint,
} from '@/services/staticFallbackHandoff';

const ROOT = resolve(__dirname, '..');

/** Fake rAF/timer pair driven by hand, so frames and time are explicit. */
function fakeFrames() {
  const frames: Array<() => void> = [];
  const timers: Array<{ cb: () => void; ms: number }> = [];
  return {
    requestFrame: (cb: () => void) => { frames.push(cb); },
    setTimer: (cb: () => void, ms: number) => { timers.push({ cb, ms }); },
    /** Run every callback queued for the next frame (new ones wait for the following frame). */
    tickFrame: () => { for (const cb of frames.splice(0)) cb(); },
    fireTimers: () => { for (const t of timers.splice(0)) t.cb(); },
    timers,
  };
}

async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true; });
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

describe('waitForStaticFirstPaint', () => {
  it('resolves only after a frame has been presented (second animation frame)', async () => {
    const f = fakeFrames();
    const wait = waitForStaticFirstPaint({ doc: { visibilityState: 'visible' }, ...f });

    expect(await settled(wait)).toBe(false);
    f.tickFrame(); // rendering step of the first frame: not painted yet
    expect(await settled(wait)).toBe(false);
    f.tickFrame(); // the first frame has been presented
    expect(await settled(wait)).toBe(true);
  });

  it('is bounded by the timeout when no frame comes', async () => {
    const f = fakeFrames();
    const wait = waitForStaticFirstPaint({ doc: { visibilityState: 'visible' }, ...f });

    expect(f.timers.map((t) => t.ms)).toEqual([STATIC_FIRST_PAINT_TIMEOUT_MS]);
    expect(STATIC_FIRST_PAINT_TIMEOUT_MS).toBeLessThanOrEqual(150);
    expect(await settled(wait)).toBe(false);
    f.fireTimers();
    expect(await settled(wait)).toBe(true);
  });

  it('does not wait in a hidden document (background tab, prerender: no animation frames)', async () => {
    const f = fakeFrames();
    const requestFrame = vi.fn(f.requestFrame);
    const wait = waitForStaticFirstPaint({ doc: { visibilityState: 'hidden' }, requestFrame, setTimer: f.setTimer });

    expect(await settled(wait)).toBe(true);
    expect(requestFrame).not.toHaveBeenCalled();
  });
});

describe('hideRootForCrossfade', () => {
  it('reserves the painted height, marks the hide, then fades #root out', () => {
    document.body.innerHTML = '<div id="root"><main class="seo-static-content"><p>offerte</p></main></div>';
    const root = document.getElementById('root')!;
    Object.defineProperty(root, 'offsetHeight', { configurable: true, value: 640 });
    const order: string[] = [];
    const perf = {
      mark: vi.fn((name: string) => {
        order.push(`mark:${name}:opacity=${root.style.opacity || 'unset'}`);
        return undefined as unknown as PerformanceMark;
      }),
    };

    hideRootForCrossfade(root, perf);

    expect(root.style.minHeight).toBe('640px');
    expect(root.style.opacity).toBe('0');
    expect(order).toEqual([`mark:${STATIC_HANDOFF_HIDE_MARK}:opacity=unset`]);
  });
});

describe('index.tsx mount order', () => {
  const entry = readFileSync(resolve(ROOT, 'index.tsx'), 'utf-8');
  const mountApp = entry.slice(entry.indexOf('const mountApp = async'));

  it('waits for the static first paint before adopting the fallback and before hiding #root', () => {
    const awaitAt = mountApp.indexOf('await staticFirstPaint');
    const startAt = mountApp.indexOf('waitForStaticFirstPaint()');
    const adoptAt = mountApp.indexOf('adoptStaticFallbackIntoRoot(rootElement, fallback)');
    const hideAt = mountApp.indexOf('hideRootForCrossfade(rootElement)');

    expect(startAt).toBeGreaterThan(-1);
    expect(awaitAt).toBeGreaterThan(startAt);
    expect(adoptAt).toBeGreaterThan(awaitAt);
    expect(hideAt).toBeGreaterThan(awaitAt);
  });

  it('hides #root only through hideRootForCrossfade (no direct opacity 0 that skips the mark)', () => {
    expect(entry).not.toMatch(/rootElement\.style\.opacity\s*=\s*['"]0['"]/);
  });
});
