import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ArticleRailAdStack from '@/components/shared/ArticleRailAdStack';
import type { ArticleRailAdStackProps } from '@/components/shared/ArticleRailAdStack';

vi.mock('@/components/shared/ArticleRailAd', () => ({
  default: (props: ArticleRailAdStackProps & { reserve: boolean }) => (
    <div data-testid="panel" data-side={props.side} data-enabled={String(props.enabled)}
      data-reserve={String(props.reserve)} data-narrow={String(props.narrow)}
      data-compact={String(props.compact)} data-desktop={String(props.desktopRail)} />
  ),
}));
let callback: ResizeObserverCallback;
let target: Element;
const disconnect = vi.fn();
function deliver(height: number, borderHeight?: number) {
  act(() => callback([{
    target, contentRect: { height },
    borderBoxSize: borderHeight === undefined ? [] : [{ blockSize: borderHeight, inlineSize: 300 }],
  } as unknown as ResizeObserverEntry], {} as ResizeObserver));
}
function resize(height: number) {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  act(() => window.dispatchEvent(new Event('resize')));
}
const count = () => screen.queryAllByTestId('panel').length;
beforeEach(() => {
  disconnect.mockClear();
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1300 });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => { throw new Error('Rail sizing must not force layout'); });
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: ResizeObserverCallback) { callback = cb; }
    observe(el: Element) { target = el; }
    disconnect = disconnect;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('rail sizing from observed layout', () => {
  it('waits for layout and handles hidden and short gutters without synchronous reads', () => {
    render(<ArticleRailAdStack side="left" />);
    expect(count()).toBe(0);
    resize(1400); expect(count()).toBe(0);
    deliver(0); expect(count()).toBe(0);
    deliver(599); expect(count()).toBe(0);
    deliver(600); expect(count()).toBe(1);
    deliver(2000); expect(count()).toBe(3);
    deliver(0); expect(count()).toBe(0);
  });
  it('uses border-box delivery and cached height for viewport changes', () => {
    render(<ArticleRailAdStack side="right" />);
    deliver(0, 2000); expect(count()).toBe(3);
    resize(800); expect(count()).toBe(2);
    resize(400); expect(count()).toBe(1);
    expect(HTMLElement.prototype.getBoundingClientRect).not.toHaveBeenCalled();
  });
  it('preserves default and caller caps, including count changes with cached height', () => {
    const { rerender } = render(<ArticleRailAdStack side="left" />);
    resize(10000); deliver(10000); expect(count()).toBe(6);
    rerender(<ArticleRailAdStack side="left" count={2} />); expect(count()).toBe(2);
    rerender(<ArticleRailAdStack side="left" count={4} />); expect(count()).toBe(4);
    rerender(<ArticleRailAdStack side="left" count={0} />); expect(count()).toBe(1);
  });
  it.each([
    { narrow: false, compact: false, desktopRail: false },
    { narrow: true, compact: false, desktopRail: false },
    { narrow: false, compact: true, desktopRail: false },
    { narrow: false, compact: false, desktopRail: true },
  ])('forwards eligibility and creative props unchanged: %j', (props) => {
    const { container } = render(<ArticleRailAdStack side="right" enabled={false} {...props} />);
    deliver(2000);
    const panels = screen.getAllByTestId('panel'); expect(panels).toHaveLength(3);
    panels.forEach((panel, i) => expect(panel.dataset).toMatchObject({
      side: 'right', enabled: 'false', reserve: String(i === 0),
      narrow: String(props.narrow || props.compact), compact: String(props.compact), desktop: String(props.desktopRail),
    }));
    expect(container.firstElementChild?.className).toBe(props.compact
      ? 'hidden xlc:flex xlc:flex-col xlc:flex-1 xlc:min-h-0 xlw:hidden'
      : props.desktopRail ? 'ft-static-rail-stack' : 'hidden xlw:flex xlw:flex-col xlw:flex-1 xlw:min-h-0');
  });
  it('disconnects and removes its own viewport listener on unmount', () => {
    const add = vi.spyOn(window, 'addEventListener'); const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<ArticleRailAdStack side="left" />);
    const listener = add.mock.calls.find(([event]) => event === 'resize')?.[1];
    expect(listener).toBeTypeOf('function'); unmount();
    expect(disconnect).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledWith('resize', listener);
  });
});
