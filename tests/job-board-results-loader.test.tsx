/**
 * JobBoardResultsLoader (#2968) — animated, accessible loading state for the
 * job-board result list. Guards the contract that replaced the bare
 * "0 risultati" flash: a single stable status for assistive tech, decorative
 * shimmer cards sized for CLS safety, and a rotating reassurance message.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import JobBoardResultsLoader from '@/components/community/JobBoardResultsLoader';

beforeEach(() => {
  // Component reads prefers-reduced-motion; force "no preference" so rotation runs.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('JobBoardResultsLoader', () => {
  it('exposes a single stable loading status for assistive tech', () => {
    const { container } = render(<JobBoardResultsLoader cards={4} />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    // Exactly one screen-reader announcement (sr-only); the rotating banner is
    // aria-hidden so it never spams a live region every 1.8s.
    expect(container.querySelectorAll('.sr-only')).toHaveLength(1);
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('reserves the requested number of shimmer skeleton cards (anti-CLS)', () => {
    const { container } = render(<JobBoardResultsLoader cards={7} />);
    expect(container.querySelectorAll('.job-loader-shimmer')).toHaveLength(7);
  });

  it('rotates the reassurance message over time', () => {
    vi.useFakeTimers();
    const { container } = render(<JobBoardResultsLoader cards={2} />);
    const banner = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    const first = banner.textContent;
    act(() => {
      vi.advanceTimersByTime(1800);
    });
    expect(banner.textContent).not.toEqual(first);
  });
});
