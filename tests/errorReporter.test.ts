/**
 * Tests for services/errorReporter.ts
 *
 * Verifies: message extraction, throttle/deduplication, Analytics integration,
 * and resilience when Analytics is unavailable.
 */

// Force the real module — other test files may have registered a vi.mock() for
// @/services/errorReporter that would otherwise shadow the real implementation.
vi.unmock('@/services/errorReporter');

// Keep isVersionSkewError/isModuleLinkSkewMessage real (so test messages exercise
// the actual classifier) but replace recoverFromStaleChunk with a spy — its own
// behavior (cache-busting, reload, budget) is covered by tests/resilient-import.test.ts;
// here we only need to assert reportCaughtError calls it for skew-shaped errors.
vi.mock('@/services/resilientImport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/resilientImport')>();
  return { ...actual, recoverFromStaleChunk: vi.fn().mockResolvedValue(true) };
});

// Controllable in the "does not self-heal during newsletter autologin" test
// below without depending on window.location.search at module-load time.
vi.mock('@/services/newsletterAutologinSignal', () => ({
  isNewsletterAutologinInFlight: vi.fn().mockReturnValue(false),
}));

import { Analytics } from '@/services/analytics';
import { isNewsletterAutologinInFlight } from '@/services/newsletterAutologinSignal';
import { recoverFromStaleChunk } from '@/services/resilientImport';

// Analytics.trackAppError is auto-mocked in tests/setup.tsx as vi.fn()

let reportCaughtError: typeof import('@/services/errorReporter').reportCaughtError;
let _resetThrottleMapForTests: typeof import('@/services/errorReporter')._resetThrottleMapForTests;

async function waitForAnalyticsCalls(expected: number): Promise<void> {
  await vi.waitFor(() => {
    expect(Analytics.trackAppError).toHaveBeenCalledTimes(expected);
  });
}

async function settleAnalyticsImport(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeAll(async () => {
  const mod = await vi.importActual<typeof import('@/services/errorReporter')>('@/services/errorReporter');
  reportCaughtError = mod.reportCaughtError;
  _resetThrottleMapForTests = mod._resetThrottleMapForTests;
});

describe('reportCaughtError', () => {
  beforeEach(() => {
    // Clear the module-level throttle Map so state from other test files
    // (isolate: false — all files share one module registry per worker)
    // cannot suppress our assertions.
    _resetThrottleMapForTests();
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('reports Error instances with message and stack', async () => {
    const err = new Error('fetch failed');
    reportCaughtError(err, 'test.context');
    await waitForAnalyticsCalls(1);

    expect(Analytics.trackAppError).toHaveBeenCalledWith('api_error', expect.objectContaining({
      message: '[test.context] fetch failed',
      fatal: false,
    }));
    // Stack should be a non-empty string
    const call = (Analytics.trackAppError as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].stack).toContain('Error: fetch failed');
  });

  it('reports plain string errors', async () => {
    reportCaughtError('something broke', 'test.string');
    await waitForAnalyticsCalls(1);

    expect(Analytics.trackAppError).toHaveBeenCalledWith('api_error', expect.objectContaining({
      message: '[test.string] something broke',
      stack: '',
    }));
  });

  it('reports unknown object errors via JSON.stringify', async () => {
    reportCaughtError({ code: 'ENOENT' }, 'test.object');
    await waitForAnalyticsCalls(1);

    expect(Analytics.trackAppError).toHaveBeenCalledWith('api_error', expect.objectContaining({
      message: '[test.object] {"code":"ENOENT"}',
    }));
  });

  it('forwards optional type, apiEndpoint, statusCode, and fatal', async () => {
    reportCaughtError(new Error('timeout'), 'api.call', {
      type: 'resource_load',
      apiEndpoint: 'https://example.com/api',
      statusCode: 503,
      fatal: true,
    });
    await waitForAnalyticsCalls(1);

    expect(Analytics.trackAppError).toHaveBeenCalledWith('resource_load', expect.objectContaining({
      apiEndpoint: 'https://example.com/api',
      statusCode: 503,
      fatal: true,
    }));
  });

  it('throttles duplicate reports with same context + message', async () => {
    const err = new Error('dup error');
    reportCaughtError(err, 'throttle.test');
    await waitForAnalyticsCalls(1);
    reportCaughtError(err, 'throttle.test');
    reportCaughtError(err, 'throttle.test');

    // Only the first call should go through
    expect(Analytics.trackAppError).toHaveBeenCalledTimes(1);
  });

  it('allows same message after throttle window expires', async () => {
    const err = new Error('temporary');
    // Use fake timers only for this test so we can advance Date.now().
    vi.useFakeTimers({ now: 1_000_000_000_000 });
    reportCaughtError(err, 'throttle.expire');
    await waitForAnalyticsCalls(1);

    // Advance past the 60s throttle window
    vi.advanceTimersByTime(61_000);

    reportCaughtError(err, 'throttle.expire');
    await waitForAnalyticsCalls(2);
    vi.useRealTimers();
    // Clear the map so this entry doesn't bleed into subsequent tests.
    _resetThrottleMapForTests();
  });

  it('does not throttle different contexts', async () => {
    const err = new Error('same');
    reportCaughtError(err, 'context.a');
    reportCaughtError(err, 'context.b');
    await waitForAnalyticsCalls(2);

    expect(Analytics.trackAppError).toHaveBeenCalledTimes(2);
  });

  it('does not throw when Analytics.trackAppError throws', async () => {
    (Analytics.trackAppError as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('analytics not initialized');
    });

    // Should not throw
    expect(() => reportCaughtError(new Error('safe'), 'resilience.test')).not.toThrow();
    await waitForAnalyticsCalls(1);
  });

  it('defaults to api_error type when not specified', async () => {
    reportCaughtError(new Error('x'), 'default.type');
    await waitForAnalyticsCalls(1);
    expect(Analytics.trackAppError).toHaveBeenCalledWith('api_error', expect.anything());
  });

  it('logs to console.warn for dev visibility', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = new Error('visible');
    reportCaughtError(err, 'console.test');
    await settleAnalyticsImport();

    expect(warnSpy).toHaveBeenCalledWith('[console.test]', err);
    warnSpy.mockRestore();
  });

  describe('version-skew self-heal', () => {
    it('triggers recoverFromStaleChunk for a link-time module-skew SyntaxError', async () => {
      const err = new Error("The requested module './router.js' does not provide an export named 'MUNICIPALITY_DATA'");
      err.name = 'SyntaxError';
      reportCaughtError(err, 'seo.updateMetaTags');
      await settleAnalyticsImport();

      expect(recoverFromStaleChunk).toHaveBeenCalledWith(`version_skew:${err.message.slice(0, 80)}`);
    });

    it('triggers recoverFromStaleChunk for a call-time skew TypeError', async () => {
      const err = new Error('ls(...).then is not a function');
      err.name = 'TypeError';
      reportCaughtError(err, 'app.loadUserProfile');
      await settleAnalyticsImport();

      expect(recoverFromStaleChunk).toHaveBeenCalledWith(`version_skew:${err.message.slice(0, 80)}`);
    });

    it('does not trigger recoverFromStaleChunk for an ordinary error', async () => {
      reportCaughtError(new Error('genuine bug, not a skew'), 'real.bug.skewcheck');
      await settleAnalyticsImport();
      expect(recoverFromStaleChunk).not.toHaveBeenCalled();
    });

    it('does not trigger recoverFromStaleChunk while a newsletter autologin exchange is in flight', async () => {
      vi.mocked(isNewsletterAutologinInFlight).mockReturnValueOnce(true);
      const err = new Error('ls(...).then is not a function');
      err.name = 'TypeError';
      reportCaughtError(err, 'app.newsletterAutologin');
      await settleAnalyticsImport();

      expect(recoverFromStaleChunk).not.toHaveBeenCalled();
    });

    it('still reports the error to Analytics after triggering self-heal', async () => {
      const err = new Error("does not provide an export named 'X'");
      err.name = 'SyntaxError';
      reportCaughtError(err, 'seo.trackSectionView');
      await waitForAnalyticsCalls(1);

      expect(recoverFromStaleChunk).toHaveBeenCalled();
      expect(Analytics.trackAppError).toHaveBeenCalledWith('api_error', expect.objectContaining({
        message: `[seo.trackSectionView] ${err.message}`,
      }));
    });
  });

  describe('benign noise filter', () => {
    it.each([
      'Failed to load Google Identity Services',
      'ResizeObserver loop completed with undelivered notifications.',
      'Script error.',
      'Failed to get document because the client is offline.',
      'TypeError: Importing a module script failed.',
    ])('drops noise pattern: %s', async (msg) => {
      reportCaughtError(new Error(msg), 'noise.test');
      await settleAnalyticsImport();
      expect(Analytics.trackAppError).not.toHaveBeenCalled();
    });

    it('drops AbortError caught in try/catch (name-prefixed pattern match)', async () => {
      // Browsers produce DOMException with name='AbortError' when a fetch is aborted
      // via AbortController. error.message is the bare string without the name prefix,
      // so isBenignErrorMessage(error.message) alone misses the /AbortError:…/ pattern.
      // The fix in reportCaughtError builds "AbortError: The user aborted a request."
      // before checking, so the pattern now matches and the error is suppressed.
      const abort = Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
      reportCaughtError(abort, 'exchangeRate.frankfurterFallback');
      await settleAnalyticsImport();
      expect(Analytics.trackAppError).not.toHaveBeenCalled();
    });

    it('drops AbortError with "The operation was aborted." message', async () => {
      const abort = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
      reportCaughtError(abort, 'some.fetch');
      await settleAnalyticsImport();
      expect(Analytics.trackAppError).not.toHaveBeenCalled();
    });

    it('still reports messages that do not match noise patterns', async () => {
      reportCaughtError(new Error('genuine bug in calculator'), 'real.bug');
      await waitForAnalyticsCalls(1);
      expect(Analytics.trackAppError).toHaveBeenCalledTimes(1);
    });
  });

  describe('per-session cap', () => {
    it('caps total reports per page-load to prevent flood storms', async () => {
      // Cap is 25 per session — emit 30 unique-context errors so throttle
      // never kicks in, only the cap.
      for (let i = 0; i < 30; i++) {
        reportCaughtError(new Error(`unique-${i}`), `flood.context.${i}`);
      }
      await waitForAnalyticsCalls(25);
      expect(Analytics.trackAppError).toHaveBeenCalledTimes(25);
    });
  });
});
