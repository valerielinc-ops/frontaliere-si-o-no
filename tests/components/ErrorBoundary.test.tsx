/**
 * Tests for `components/shared/ErrorBoundary.tsx` — SilentErrorBoundary.
 *
 * Focus (#4590): SilentErrorBoundary wraps non-critical widget clusters
 * (nav-actions, ai-chatbot via SafeLazy, home-widgets-*) and — unlike the
 * top-level `ErrorBoundary` — deliberately never forces a
 * `window.location.reload()` on catch (ref cwji52: a forced reload from a
 * non-critical widget previously disrupted an in-progress newsletter
 * autologin). Before this fix it also never called `bustAssetHttpCache()`,
 * so a stale chunk / version-skew SyntaxError caught here left the
 * browser's HTTP disk cache holding the stale bytes for the rest of the
 * session. Asserts:
 *   (a) chunk-load errors trigger bustAssetHttpCache(),
 *   (b) version-skew (link-time) SyntaxErrors trigger bustAssetHttpCache(),
 *   (c) parse-time SyntaxErrors trigger bustAssetHttpCache() (#5531/#6778 —
 *       previously the one recoverable class this boundary didn't match),
 *   (d) NEITHER case ever calls window.location.reload(),
 *   (e) non-chunk errors do NOT trigger bustAssetHttpCache(),
 *   (f) the subtree fallback still renders (existing behaviour unchanged).
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ErrorBoundary, SilentErrorBoundary } from '@/components/shared/ErrorBoundary';
import * as resilientImport from '@/services/resilientImport';

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
  vi.restoreAllMocks();
});

/** Throws on render — used to simulate a failing widget subtree. */
function Thrower({ message }: { message: string }) {
  throw new Error(message);
}

/**
 * Throws a SyntaxError on render — isVersionSkewError's message-pattern
 * branch (resilientImport.ts) only matches when `error.name === 'SyntaxError'`
 * (mirrors the real link-time failure: a native `SyntaxError` from the module
 * loader), so a plain `new Error(...)` (name: 'Error') would never match it.
 */
function SkewThrower({ message }: { message: string }) {
  throw Object.assign(new Error(message), { name: 'SyntaxError' });
}

describe('SilentErrorBoundary', () => {
  it('renders children when no error occurs', () => {
    render(
      <SilentErrorBoundary boundary="test-widget">
        <p>widget ok</p>
      </SilentErrorBoundary>,
    );
    expect(screen.getByText('widget ok')).toBeInTheDocument();
  });

  it('renders the fallback (default: nothing) after a render error, without crashing the page', () => {
    render(
      <SilentErrorBoundary boundary="test-widget">
        <Thrower message="boom" />
      </SilentErrorBoundary>,
    );
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
  });

  it('busts the HTTP asset cache on a chunk-load error (#4590)', async () => {
    const bustSpy = vi.spyOn(resilientImport, 'bustAssetHttpCache').mockResolvedValue(undefined);
    render(
      <SilentErrorBoundary boundary="ai-chatbot">
        <Thrower message="Failed to fetch dynamically imported module: /assets/AiChatbot.js" />
      </SilentErrorBoundary>,
    );
    expect(bustSpy).toHaveBeenCalledTimes(1);
    // Non-disruptive by design — SafeLazy/ref cwji52 constraint.
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('busts the HTTP asset cache on a link-time version-skew SyntaxError (#4590)', async () => {
    const bustSpy = vi.spyOn(resilientImport, 'bustAssetHttpCache').mockResolvedValue(undefined);
    render(
      <SilentErrorBoundary boundary="nav-actions">
        <SkewThrower message="The requested module './internalLinks.js' does not provide an export named 'NAV_ACTION_HOME'" />
      </SilentErrorBoundary>,
    );
    expect(bustSpy).toHaveBeenCalledTimes(1);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('busts the HTTP asset cache on a parse-time SyntaxError (#5531/#6778)', async () => {
    const bustSpy = vi.spyOn(resilientImport, 'bustAssetHttpCache').mockResolvedValue(undefined);
    render(
      <SilentErrorBoundary boundary="ai-chatbot">
        <SkewThrower message="Unexpected identifier 'diploma'" />
      </SilentErrorBoundary>,
    );
    expect(bustSpy).toHaveBeenCalledTimes(1);
    // Non-disruptive by design — SafeLazy/ref cwji52 constraint, same as the
    // other two recoverable classes above.
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('does NOT bust the HTTP asset cache on a non-chunk, non-skew error', () => {
    const bustSpy = vi.spyOn(resilientImport, 'bustAssetHttpCache').mockResolvedValue(undefined);
    render(
      <SilentErrorBoundary boundary="home-widgets-desktop">
        <Thrower message="Cannot read properties of undefined (reading 'foo')" />
      </SilentErrorBoundary>,
    );
    expect(bustSpy).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('never calls window.location.reload(), regardless of error type (SafeLazy / ref cwji52 constraint)', () => {
    vi.spyOn(resilientImport, 'bustAssetHttpCache').mockResolvedValue(undefined);
    render(
      <SilentErrorBoundary boundary="ai-chatbot">
        <Thrower message="ChunkLoadError: Loading chunk 7 failed." />
      </SilentErrorBoundary>,
    );
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});

/**
 * Tests for the top-level `ErrorBoundary` — the crash-page debug tooling
 * added alongside the side-banner layout (build/commit row, stack-trace
 * disclosure, "Copia info debug" clipboard button). Banners themselves
 * (DesktopTopBanner/ArticleRailAd/AdSenseBanner) self-gate to `null` outside
 * `IS_PROD` (GptAdSlot), so they're not asserted on directly here — only
 * that they don't crash the page (covered by the "renders the crash card"
 * assertions below, which pass only if the whole tree mounted cleanly).
 */
describe('ErrorBoundary (top-level crash page)', () => {
  it('renders the crash card with a Build/Commit debug row', async () => {
    render(
      <ErrorBoundary>
        <Thrower message="boom" />
      </ErrorBoundary>,
    );
    const details = screen.getByTestId('error-boundary-details');
    // Before fetchBuildId/fetchCommitHash resolve (unmocked fetch in jsdom
    // — safely caught by buildInfo.ts's try/catch), the row shows the
    // "(sconosciuto)" fallback rather than being absent.
    expect(details).toHaveTextContent('Build');
    await waitFor(() => expect(details).toHaveTextContent('sconosciuto'));
  });

  it('copies debug info to the clipboard and shows confirmation feedback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(
      <ErrorBoundary>
        <Thrower message="boom" />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: /copia info debug/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copiedText = writeText.mock.calls[0][0] as string;
    expect(copiedText).toContain('REF:');
    expect(copiedText).toContain('Build ID:');
    expect(copiedText).toContain('Stack:');

    await waitFor(() => expect(screen.getByRole('button', { name: /copiato/i })).toBeInTheDocument());
  });

  it('does NOT crash when clipboard API is unavailable (falls back to execCommand)', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    const execCommandSpy = vi.fn().mockReturnValue(true);
    document.execCommand = execCommandSpy;

    render(
      <ErrorBoundary>
        <Thrower message="boom" />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: /copia info debug/i }));

    await waitFor(() => expect(execCommandSpy).toHaveBeenCalledWith('copy'));
    await waitFor(() => expect(screen.getByRole('button', { name: /copiato/i })).toBeInTheDocument());
  });
});
