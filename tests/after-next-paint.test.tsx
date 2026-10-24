/**
 * runAfterNextPaint keeps telemetry off the path between a tap and its paint
 * (INP) without losing it: FIFO order, one frame, flushed on pagehide/hidden,
 * and a fallback when no frame comes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushAfterNextPaintForTests, runAfterNextPaint } from '@/services/afterNextPaint';

describe('runAfterNextPaint', () => {
  let frames: FrameRequestCallback[];

  beforeEach(() => {
    vi.useFakeTimers();
    frames = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
  });

  afterEach(() => {
    flushAfterNextPaintForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const paint = () => {
    const pending = frames.splice(0);
    for (const cb of pending) cb(performance.now());
  };

  it('does not run inside the caller, nor in the frame callback, but right after the frame', () => {
    const calls: string[] = [];
    runAfterNextPaint(() => calls.push('a'));
    runAfterNextPaint(() => calls.push('b'));
    expect(calls).toEqual([]);
    expect(frames).toHaveLength(1); // one frame for the batch
    paint();
    expect(calls).toEqual([]); // still before the frame is presented
    vi.advanceTimersByTime(0);
    expect(calls).toEqual(['a', 'b']);
  });

  it('flushes synchronously on pagehide, so a navigating click is still recorded', () => {
    const calls: string[] = [];
    runAfterNextPaint(() => calls.push('x'));
    window.dispatchEvent(new Event('pagehide'));
    expect(calls).toEqual(['x']);
    paint();
    vi.advanceTimersByTime(2000);
    expect(calls).toEqual(['x']); // not run twice
  });

  it('runs on the fallback timer when no frame is ever produced', () => {
    const calls: string[] = [];
    runAfterNextPaint(() => calls.push('late'));
    vi.advanceTimersByTime(999);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(['late']);
  });

  it('an old fallback does not flush a newer batch before its own frame', () => {
    const calls: string[] = [];
    runAfterNextPaint(() => calls.push('first'));
    paint();
    vi.advanceTimersByTime(0);
    expect(calls).toEqual(['first']);
    vi.advanceTimersByTime(900);
    runAfterNextPaint(() => calls.push('second'));
    vi.advanceTimersByTime(150); // the first batch's fallback fires here
    expect(calls).toEqual(['first']);
    paint();
    vi.advanceTimersByTime(0);
    expect(calls).toEqual(['first', 'second']);
  });

  it('a throwing task does not stop the ones queued behind it', () => {
    const calls: string[] = [];
    const errors: unknown[] = [];
    const original = globalThis.queueMicrotask;
    globalThis.queueMicrotask = (cb: () => void) => { try { cb(); } catch (e) { errors.push(e); } };
    try {
      runAfterNextPaint(() => { throw new Error('boom'); });
      runAfterNextPaint(() => calls.push('after'));
      flushAfterNextPaintForTests();
    } finally {
      globalThis.queueMicrotask = original;
    }
    expect(calls).toEqual(['after']);
    expect(String(errors[0])).toContain('boom');
  });
});
