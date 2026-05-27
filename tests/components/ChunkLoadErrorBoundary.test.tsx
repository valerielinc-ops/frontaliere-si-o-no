/**
 * Tests for `components/ChunkLoadErrorBoundary.tsx`.
 *
 * Asserts:
 *   (a) reloads on the first chunk-load render error,
 *   (b) honours the 60s cooldown — no second reload inside the window,
 *   (c) renders children when there is no error,
 *   (d) renders the Italian "in corso" fallback after triggering a reload,
 *   (e) does NOT reload on errors that are NOT chunk-load failures (regex narrow).
 */

import React, { Component, type ReactNode, type Ref } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ChunkLoadErrorBoundary } from '@/components/ChunkLoadErrorBoundary';

/**
 * Catch-all sink boundary that simulates the regular `<ErrorBoundary>`
 * sitting BELOW `ChunkLoadErrorBoundary` in production. Without it, any
 * error that `ChunkLoadErrorBoundary` chooses NOT to handle (cooldown,
 * non-chunk error) propagates uncaught and React aborts the render.
 */
interface CatchAllProps { children: ReactNode }
interface CatchAllState { caught: Error | null }
class CatchAll extends Component<CatchAllProps, CatchAllState> {
  state: CatchAllState = { caught: null };
  static getDerivedStateFromError(error: Error): CatchAllState { return { caught: error }; }
  render(): ReactNode {
    if (this.state.caught) return <p data-testid="caught">{this.state.caught.message}</p>;
    return (this as React.Component<CatchAllProps, CatchAllState>).props.children;
  }
}

// JSDOM marks `window.location` read-only; replace it with a writable stub
// so we can spy on .reload(). Restore after each test to keep isolation.
const originalLocation = window.location;
let reloadSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  reloadSpy = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, reload: reloadSpy },
    writable: true,
  });
  sessionStorage.clear();
  // Silence the React error-in-render console noise for the deliberate throws.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: originalLocation,
    writable: true,
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Throws on render — used to simulate a chunk-load failure. */
function ChunkThrower({ message }: { message: string }) {
  throw new Error(message);
}

describe('ChunkLoadErrorBoundary', () => {
  it('renders children when no error occurs', () => {
    render(
      <ChunkLoadErrorBoundary>
        <p>app ok</p>
      </ChunkLoadErrorBoundary>,
    );
    expect(screen.getByText('app ok')).toBeInTheDocument();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('reloads on the first chunk-load failure', () => {
    render(
      <CatchAll>
        <ChunkLoadErrorBoundary>
          <ChunkThrower message="TypeError: Importing a module script failed." />
        </ChunkLoadErrorBoundary>
      </CatchAll>,
    );
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('renders the Italian "in corso" fallback after triggering a reload', () => {
    // Capture the boundary instance via ref so we can drive its state to the
    // post-reload mode without relying on React 19 dev-mode re-throw behaviour
    // (which surfaces as a vitest unhandled error even though the boundary
    // legitimately caught the original throw).
    const ref = { current: null as ChunkLoadErrorBoundary | null };
    render(
      <ChunkLoadErrorBoundary ref={ref as unknown as Ref<ChunkLoadErrorBoundary>}>
        <p>app ok</p>
      </ChunkLoadErrorBoundary>,
    );
    expect(ref.current).not.toBeNull();
    // Simulate what getDerivedStateFromError sets when we choose to reload.
    act(() => {
      (ref.current as unknown as { setState: (s: { hasError: boolean }) => void }).setState({ hasError: true });
    });
    expect(screen.getByText(/Aggiornamento del sito in corso/i)).toBeInTheDocument();
  });

  it('does NOT reload twice within the 60s cooldown', () => {
    vi.useFakeTimers();
    const start = 1_700_000_000_000;
    vi.setSystemTime(start);

    const first = render(
      <CatchAll>
        <ChunkLoadErrorBoundary>
          <ChunkThrower message="Failed to fetch dynamically imported module: /assets/Tab-abc.js" />
        </ChunkLoadErrorBoundary>
      </CatchAll>,
    );
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    first.unmount();

    // Advance only 10 seconds — still inside the cooldown window.
    vi.setSystemTime(start + 10_000);

    render(
      <CatchAll>
        <ChunkLoadErrorBoundary>
          <ChunkThrower message="Failed to fetch dynamically imported module: /assets/Tab-abc.js" />
        </ChunkLoadErrorBoundary>
      </CatchAll>,
    );
    // Still 1 — second render inside the cooldown must NOT trigger reload.
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    // CatchAll caught the rethrown error.
    expect(screen.getByTestId('caught')).toBeInTheDocument();
  });

  it('reloads again once the 60s cooldown has elapsed', () => {
    vi.useFakeTimers();
    const start = 1_700_000_000_000;
    vi.setSystemTime(start);

    const first = render(
      <CatchAll>
        <ChunkLoadErrorBoundary>
          <ChunkThrower message="ChunkLoadError: Loading chunk 7 failed." />
        </ChunkLoadErrorBoundary>
      </CatchAll>,
    );
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    first.unmount();

    // Jump past the cooldown.
    vi.setSystemTime(start + 61_000);

    render(
      <CatchAll>
        <ChunkLoadErrorBoundary>
          <ChunkThrower message="ChunkLoadError: Loading chunk 7 failed." />
        </ChunkLoadErrorBoundary>
      </CatchAll>,
    );
    expect(reloadSpy).toHaveBeenCalledTimes(2);
  });

  it('does NOT reload on non-chunk errors (regex stays narrow)', () => {
    // The outer CatchAll mimics the production setup where the regular
    // <ErrorBoundary> sits below us and catches anything we ignore.
    render(
      <CatchAll>
        <ChunkLoadErrorBoundary>
          <ChunkThrower message="TypeError: Cannot read properties of undefined (reading 'foo')" />
        </ChunkLoadErrorBoundary>
      </CatchAll>,
    );
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('caught')).toHaveTextContent(/Cannot read properties of undefined/);
  });
});
