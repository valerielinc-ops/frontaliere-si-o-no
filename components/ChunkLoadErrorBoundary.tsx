import React, { Component, type ReactNode } from 'react';

/**
 * Last-resort boundary for Vite chunk-load failures during render.
 *
 * Defence-in-depth layer that sits ABOVE the regular `ErrorBoundary`:
 * - `index.tsx` listens to `vite:preloadError` and reloads (catches most cases)
 * - `services/lazyRetry.ts` wraps every `React.lazy()` with retry + reload
 * - This boundary catches the residual ~93/30 d render-time chunk errors
 *   that escape both paths (e.g. dynamic import outside `lazy()`, third-party
 *   render path, or a chunk error thrown synchronously from a Suspense child
 *   that the lazyRetry guard already burned its one reload on).
 *
 * Behaviour:
 * 1. If the error matches a chunk-load pattern AND we have not reloaded in
 *    the last 60 s, force a hard reload to pick up the new asset hashes.
 * 2. Otherwise, fall through (`getDerivedStateFromError` returns null) so
 *    the regular `ErrorBoundary` below us renders its full error UI.
 * 3. Between the reload trigger and the actual page swap, render a minimal
 *    Italian fallback so the user never sees a blank white screen.
 *
 * Intentionally narrow scope — does NOT swallow non-chunk errors. The regex
 * is the one place to extend if new chunk-error wording appears in the wild.
 */

const CHUNK_ERROR_PATTERN = /Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk \d+ failed/i;
const RELOAD_FLAG = 'fr_chunk_reload_attempted_at';
const RELOAD_COOLDOWN_MS = 60_000;

interface State {
  hasError: boolean;
}

interface Props {
  children: ReactNode;
}

export class ChunkLoadErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  // Defining componentDidCatch (even as a no-op) signals to React that this
  // class is a real error boundary that fully handles caught errors. Without
  // it, React 19 in development re-throws errors whose getDerivedStateFromError
  // returns a truthy state, which breaks our reload-and-fallback flow.
  componentDidCatch(_error: Error) {
    // Reporting handled by the regular ErrorBoundary downstream + Analytics
    // (which is already invoked via the lazyRetry → trackForceReload path).
  }

  static getDerivedStateFromError(error: Error): State | null {
    const message = error?.message ?? '';
    if (!CHUNK_ERROR_PATTERN.test(message)) {
      // Not our concern — let the next boundary handle it.
      return null;
    }
    try {
      const last = Number(sessionStorage.getItem(RELOAD_FLAG) ?? '0');
      if (Date.now() - last > RELOAD_COOLDOWN_MS) {
        sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
        window.location.reload();
        return { hasError: true };
      }
    } catch {
      // Private mode / disabled storage — fall through to non-error state
      // so the inner ErrorBoundary can render its real error UI.
    }
    return null;
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '2rem', textAlign: 'center' }}>
          <p>Aggiornamento del sito in corso&hellip;</p>
        </div>
      );
    }
    return (this as React.Component<Props, State>).props.children;
  }
}
