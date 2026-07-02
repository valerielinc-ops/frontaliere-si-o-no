import React, { Component, type ReactNode } from 'react';
import {
  isModuleLinkSkewMessage,
  bustAssetHttpCache,
  CHUNK_LOAD_ERROR_PATTERN_SOURCE,
} from '@/services/resilientImport';

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
 * It also matches LINK-TIME version-skew SyntaxErrors (issue #3097, e.g.
 * "...does not provide an export named 'House'") via the shared
 * isModuleLinkSkewMessage predicate — same stale-deploy root cause, same reload
 * recovery — so a module-graph mismatch that escapes the inner ErrorBoundary
 * still reloads here instead of white-screening.
 */

// Built from the shared CHUNK_LOAD_ERROR_SUBSTRINGS (resilientImport.ts)
// instead of a hand-copied literal — this pattern had drifted from the other
// chunk-load detectors in the codebase (issue #3216 item 1; AGENTS.md
// §Non-Negotiables #6). 'ChunkLoadError' stays as a bare message-content
// alternative (distinct from the `.name === 'ChunkLoadError'` check other
// consumers use) to preserve this boundary's existing behaviour.
const CHUNK_ERROR_PATTERN = new RegExp(`${CHUNK_LOAD_ERROR_PATTERN_SOURCE}|ChunkLoadError`, 'i');
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
    if (!CHUNK_ERROR_PATTERN.test(message) && !isModuleLinkSkewMessage(message)) {
      // Not our concern — let the next boundary handle it.
      return null;
    }
    try {
      const last = Number(sessionStorage.getItem(RELOAD_FLAG) ?? '0');
      if (Date.now() - last > RELOAD_COOLDOWN_MS) {
        sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
        // Bust the HTTP cache (not just CacheStorage) before reloading: a
        // link-time version-skew (#3097) re-serves the same stale cross-origin
        // chunk on a plain reload, so this boundary's one reload would be wasted.
        // Show the "Aggiornamento…" fallback while the async bust + reload run.
        void bustAssetHttpCache().finally(() => window.location.reload());
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
        <div className="p-8 text-center">
          <p>Aggiornamento del sito in corso&hellip;</p>
        </div>
      );
    }
    return (this as React.Component<Props, State>).props.children;
  }
}
