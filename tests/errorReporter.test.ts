/**
 * Tests for services/errorReporter.ts
 *
 * Verifies: message extraction, throttle/deduplication, Analytics integration,
 * and resilience when Analytics is unavailable.
 */

// Force the real module — other test files may have registered a vi.mock() for
// @/services/errorReporter that would otherwise shadow the real implementation.
vi.unmock('@/services/errorReporter');

import { Analytics } from '@/services/analytics';

// Analytics.trackAppError is auto-mocked in tests/setup.tsx as vi.fn()

let reportCaughtError: typeof import('@/services/errorReporter').reportCaughtError;
let _resetThrottleMapForTests: typeof import('@/services/errorReporter')._resetThrottleMapForTests;

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

  it('reports Error instances with message and stack', () => {
    const err = new Error('fetch failed');
    reportCaughtError(err, 'test.context');

    expect(Analytics.trackAppError).toHaveBeenCalledWith('api_error', expect.objectContaining({
      message: '[test.context] fetch failed',
      fatal: false,
    }));
    // Stack should be a non-empty string
    const call = (Analytics.trackAppError as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].stack).toContain('Error: fetch failed');
  });

  it('reports plain string errors', () => {
    reportCaughtError('something broke', 'test.string');

    expect(Analytics.trackAppError).toHaveBeenCalledWith('api_error', expect.objectContaining({
      message: '[test.string] something broke',
      stack: '',
    }));
  });

  it('reports unknown object errors via JSON.stringify', () => {
    reportCaughtError({ code: 'ENOENT' }, 'test.object');

    expect(Analytics.trackAppError).toHaveBeenCalledWith('api_error', expect.objectContaining({
      message: '[test.object] {"code":"ENOENT"}',
    }));
  });

  it('forwards optional type, apiEndpoint, statusCode, and fatal', () => {
    reportCaughtError(new Error('timeout'), 'api.call', {
      type: 'resource_load',
      apiEndpoint: 'https://example.com/api',
      statusCode: 503,
      fatal: true,
    });

    expect(Analytics.trackAppError).toHaveBeenCalledWith('resource_load', expect.objectContaining({
      apiEndpoint: 'https://example.com/api',
      statusCode: 503,
      fatal: true,
    }));
  });

  it('throttles duplicate reports with same context + message', () => {
    const err = new Error('dup error');
    reportCaughtError(err, 'throttle.test');
    reportCaughtError(err, 'throttle.test');
    reportCaughtError(err, 'throttle.test');

    // Only the first call should go through
    expect(Analytics.trackAppError).toHaveBeenCalledTimes(1);
  });

  it('allows same message after throttle window expires', () => {
    const err = new Error('temporary');
    // Use fake timers only for this test so we can advance Date.now().
    vi.useFakeTimers({ now: 1_000_000_000_000 });
    reportCaughtError(err, 'throttle.expire');

    expect(Analytics.trackAppError).toHaveBeenCalledTimes(1);

    // Advance past the 60s throttle window
    vi.advanceTimersByTime(61_000);

    reportCaughtError(err, 'throttle.expire');
    expect(Analytics.trackAppError).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    // Clear the map so this entry doesn't bleed into subsequent tests.
    _resetThrottleMapForTests();
  });

  it('does not throttle different contexts', () => {
    const err = new Error('same');
    reportCaughtError(err, 'context.a');
    reportCaughtError(err, 'context.b');

    expect(Analytics.trackAppError).toHaveBeenCalledTimes(2);
  });

  it('does not throw when Analytics.trackAppError throws', () => {
    (Analytics.trackAppError as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('analytics not initialized');
    });

    // Should not throw
    expect(() => reportCaughtError(new Error('safe'), 'resilience.test')).not.toThrow();
  });

  it('defaults to api_error type when not specified', () => {
    reportCaughtError(new Error('x'), 'default.type');
    expect(Analytics.trackAppError).toHaveBeenCalledWith('api_error', expect.anything());
  });

  it('logs to console.warn for dev visibility', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = new Error('visible');
    reportCaughtError(err, 'console.test');

    expect(warnSpy).toHaveBeenCalledWith('[console.test]', err);
    warnSpy.mockRestore();
  });
});
