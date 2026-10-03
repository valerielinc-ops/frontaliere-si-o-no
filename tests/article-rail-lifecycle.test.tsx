import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ArticleRailAdStack from '@/components/shared/ArticleRailAdStack';

const { panels } = vi.hoisted(() => ({ panels: [] as Array<{ onEmptyChange: (empty: boolean) => void }> }));
vi.mock('@/components/shared/ArticleRailAd', () => ({ default: (props: { onEmptyChange: (empty: boolean) => void }) => { panels.push(props); return <div data-test-panel />; } }));
beforeEach(() => {
  vi.useFakeTimers();
  panels.length = 0;
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 2100, height: 2000, left: 0, right: 300, width: 300, x: 0, y: 100, toJSON() {} });
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target, contentRect: { height: 2000 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('rail gutter shares GPT terminal decisions', () => {
  it('does not replace unanswered panels with a timed iframe-absence verdict', () => {
    const onEmptyResolved = vi.fn();
    render(<ArticleRailAdStack side="left" onEmptyResolved={onEmptyResolved} />);
    expect(panels.length).toBe(2);
    act(() => vi.advanceTimersByTime(30_000));
    expect(onEmptyResolved).not.toHaveBeenCalled();
  });
  it('collapses only after every panel is safely empty and restores after a late fill', () => {
    const onEmptyResolved = vi.fn();
    render(<ArticleRailAdStack side="left" onEmptyResolved={onEmptyResolved} />);
    act(() => panels[0].onEmptyChange(true));
    expect(onEmptyResolved).not.toHaveBeenCalled();
    act(() => panels[1].onEmptyChange(true));
    expect(onEmptyResolved).toHaveBeenLastCalledWith(true);
    act(() => panels[0].onEmptyChange(false));
    expect(onEmptyResolved).toHaveBeenLastCalledWith(false);
  });
});
