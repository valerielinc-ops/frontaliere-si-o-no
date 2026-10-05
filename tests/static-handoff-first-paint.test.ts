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
 * HTML (a paint timing entry; bounded, and skipped for hidden documents)
 * before the first hide. Runner traces (run 37337515121): first main frame at
 * 1.27-1.37 s, hide at ~1.0 s, first contentful paint at 2.29-2.36 s.
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

/** Hand-driven paint observer and timer, so paint and time are explicit. */
function fakePaint(alreadyPainted = false) {
  const listeners: Array<() => void> = [];
  const timers: Array<{ cb: () => void; ms: number }> = [];
  let unsubscribed = 0;
  return {
    paintEntries: () => (alreadyPainted ? [{ name: 'first-paint' }] : []),
    observePaint: (cb: () => void) => { listeners.push(cb); return () => { unsubscribed += 1; }; },
    setTimer: (cb: () => void, ms: number) => { timers.push({ cb, ms }); },
    paint: () => { for (const cb of listeners.splice(0)) cb(); },
    fireTimers: () => { for (const t of timers.splice(0)) t.cb(); },
    timers,
    unsubscribed: () => unsubscribed,
  };
}

async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true; });
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

const visible = { visibilityState: 'visible' } as const;

describe('waitForStaticFirstPaint', () => {
  it('waits for the first paint entry, not for a frame callback', async () => {
    const f = fakePaint();
    const wait = waitForStaticFirstPaint({ doc: visible, ...f });

    expect(await settled(wait)).toBe(false);
    f.paint();
    expect(await settled(wait)).toBe(true);
    expect(f.unsubscribed()).toBe(1);
  });

  it('resolves at once when the static HTML has already painted', async () => {
    const f = fakePaint(true);
    expect(await settled(waitForStaticFirstPaint({ doc: visible, ...f }))).toBe(true);
    expect(f.timers).toEqual([]);
  });

  it('is bounded by the timeout when no paint comes', async () => {
    const f = fakePaint();
    const wait = waitForStaticFirstPaint({ doc: visible, ...f });

    expect(f.timers.map((t) => t.ms)).toEqual([STATIC_FIRST_PAINT_TIMEOUT_MS]);
    expect(await settled(wait)).toBe(false);
    f.fireTimers();
    expect(await settled(wait)).toBe(true);
  });

  it('does not wait in a hidden document (background tab, prerender: nothing paints)', async () => {
    const f = fakePaint();
    const observePaint = vi.fn(f.observePaint);
    const wait = waitForStaticFirstPaint({ doc: { visibilityState: 'hidden' }, ...f, observePaint });

    expect(await settled(wait)).toBe(true);
    expect(observePaint).not.toHaveBeenCalled();
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
