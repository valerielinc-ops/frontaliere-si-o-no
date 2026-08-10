/**
 * lazyRetry — the two dynamic-import failure shapes that reached real users as
 * a blank page instead of a silent recovery (issues #5531 / #5533).
 *
 * Chunk filenames on this site are STABLE (no content hash — vite.config
 * rollupOptions.output.entryFileNames/chunkFileNames), index.html is cached
 * `max-age=21600` while `/assets/*` is `max-age=600, must-revalidate`
 * (public/_headers), and deploys land every ~2h. A client therefore routinely
 * ends up holding a MIXED set of same-named chunks, which is the whole reason
 * resilientImport.ts + lazyRetry.ts exist.
 *
 * Both regressions below are about CLASSIFICATION, not about the recovery
 * itself: the clear-caches → retry → budgeted-reload path already worked, but
 * neither failure shape was recognised as a stale chunk, so it never ran.
 *
 *   #5533  factory RESOLVES `undefined` (or `{ default: undefined }`) → React
 *          read `.default` off it and threw
 *          "TypeError: Cannot read properties of undefined (reading 'default')"
 *          from inside the render. 20 hits / 20 users on /cerca-lavoro-ticino/.
 *   #5531  factory REJECTS with a parse-time SyntaxError → the chunk URL
 *          answered with an HTML document (404 page / SPA fallback) that the
 *          browser parsed as a module, surfacing a CONTENT word from this
 *          site's own job pages as a bare identifier:
 *          "SyntaxError: Unexpected identifier 'diploma'".
 */

import React, { Component, Suspense } from 'react';
import type { ComponentType, ReactElement, ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lazyRetry reports every retry outcome through a dynamic import of the
// analytics module; stub it so these tests exercise recovery, not telemetry.
vi.mock('@/services/analytics', () => ({
  Analytics: { trackChunkRetry: vi.fn(), trackForceReload: vi.fn() },
}));

import { lazyRetry } from '@/services/lazyRetry';

function Loaded(): ReactElement {
  return <div>chunk-rendered</div>;
}

interface TrapProps {
  children: ReactNode;
}
interface TrapState {
  err: Error | null;
}

/** Captures whatever escapes lazyRetry so a regression shows its real message. */
class Trap extends Component<TrapProps, TrapState> {
  // Explicit re-declaration: under this tsconfig the inherited `props`/`state`
  // members are not visible on subclasses declared inside tests/ (same pre-existing
  // resolution quirk as the other tests/*.tsx class components), and `declare`
  // adds no emit.
  declare props: TrapProps;
  declare state: TrapState;

  constructor(props: TrapProps) {
    super(props);
    this.state = { err: null };
  }
  static getDerivedStateFromError(err: Error): TrapState {
    return { err };
  }
  componentDidCatch(): void {
    /* swallow — the assertion reads the error out of the rendered text */
  }
  render(): ReactNode {
    if (this.state.err) return <div data-testid="crash">{String(this.state.err.message)}</div>;
    return this.props.children;
  }
}

function renderLazy(factory: () => Promise<{ default: ComponentType }>) {
  const Comp = lazyRetry(factory as () => Promise<{ default: ComponentType<any> }>);
  return render(
    <Trap>
      <Suspense fallback={<span>loading</span>}>
        <Comp />
      </Suspense>
    </Trap>,
  );
}

describe('lazyRetry — resolved-but-unusable module (#5533)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sessionStorage.clear();
    // React logs a component-stack error for every boundary catch; silence it so
    // the deliberate-crash cases don't drown the run.
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('recovers when the first import resolves `undefined`', async () => {
    // Rollup rewrites `import('@/x')` to `import('./x.js').then(m => m.<ns>)`
    // when x is ALSO statically imported, so a chunk published without that
    // generated namespace export resolves `undefined` rather than failing to
    // fetch (#4881). Before the guard this went straight into React.lazy.
    const factory = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ default: Loaded });

    renderLazy(factory as never);

    await waitFor(() => expect(screen.getByText('chunk-rendered')).toBeInTheDocument());
    expect(factory).toHaveBeenCalledTimes(2); // the retry actually ran
    expect(screen.queryByTestId('crash')).toBeNull();
  });

  it("recovers when the import resolves `{ default: undefined }`", async () => {
    // The shape produced by App.tsx's 58 `.then(m => ({ default: m.X }))` call
    // sites when the skewed chunk no longer exports `X`: an object, so a plain
    // null-check on the module would have missed it.
    const factory = vi
      .fn()
      .mockResolvedValueOnce({ default: undefined })
      .mockResolvedValueOnce({ default: Loaded });

    renderLazy(factory as never);

    await waitFor(() => expect(screen.getByText('chunk-rendered')).toBeInTheDocument());
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("never surfaces the raw \"reading 'default'\" TypeError to the boundary", async () => {
    // Even when recovery cannot succeed, the error that escapes must be the
    // classified ChunkLoadError — the signature every downstream surface
    // (ErrorBoundary, ChunkLoadErrorBoundary, the GA4 app_error classifier)
    // already knows how to act on — not React's opaque property read.
    //
    // This path runs both retries, so it crosses lazyRetry's real 2s
    // CDN-propagation delay before rejecting, and then asks for a reload:
    // stub it the way tests/resilient-import.test.ts does, so jsdom does not
    // raise "Not implemented: navigation".
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    });
    const factory = vi.fn().mockResolvedValue(undefined);

    renderLazy(factory as never);

    await waitFor(() => expect(screen.getByTestId('crash')).toBeInTheDocument(), { timeout: 8000 });
    const message = screen.getByTestId('crash').textContent ?? '';
    expect(message).not.toContain("reading 'default'");
    expect(message).toContain('Failed to fetch dynamically imported module');
  }, 15000);
});

describe('lazyRetry — parse-time SyntaxError from a chunk URL (#5531)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sessionStorage.clear();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('retries after an HTML-parsed-as-JavaScript SyntaxError', async () => {
    // The live signature: a word out of this site's own job-ad copy appearing
    // where JavaScript expected a token.
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new SyntaxError("Unexpected identifier 'diploma'"))
      .mockResolvedValueOnce({ default: Loaded });

    renderLazy(factory as never);

    await waitFor(() => expect(screen.getByText('chunk-rendered')).toBeInTheDocument());
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a link-time export-set skew SyntaxError', async () => {
    // Retrying re-links the same cached importer/dependency pair, so this class
    // must keep going straight to the ErrorBoundary, whose isVersionSkewError →
    // recoverFromStaleChunk does the correct clear-caches + single reload. This
    // pins that the #5531 widening did not swallow that path.
    const skew = new SyntaxError(
      "The requested module './router.js' does not provide an export named 'isJobSlugMapReady'",
    );
    const factory = vi.fn().mockRejectedValue(skew);

    renderLazy(factory as never);

    await waitFor(() => expect(screen.getByTestId('crash')).toBeInTheDocument());
    expect(factory).toHaveBeenCalledTimes(1); // no retry
    expect(screen.getByTestId('crash').textContent).toContain('does not provide an export named');
  });

  it('still rethrows an unrelated error untouched', async () => {
    const factory = vi.fn().mockRejectedValue(new TypeError('genuine app bug'));

    renderLazy(factory as never);

    await waitFor(() => expect(screen.getByTestId('crash')).toBeInTheDocument());
    expect(factory).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('crash').textContent).toContain('genuine app bug');
  });
});
