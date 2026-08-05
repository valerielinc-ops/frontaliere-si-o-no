/**
 * Regression coverage for issue #4173 —
 * `RangeError: Maximum call stack size exceeded.`
 *
 * The PostHog `$exception` autocapture reported this as a first-party fatal
 * error for months because it arrives with `stacktrace.frames === []`: WebKit
 * redacts the `url:line:col` tail of every frame belonging to a script the
 * page loaded cross-origin without CORS, and PostHog's frame parser drops
 * frames without that tail. Our own `app_error` pipeline DID keep the
 * unparsed stack, and it shows an infinite mutual recursion between two
 * adjacent Closure-Compiler-minified names with no source on any frame.
 *
 * The stacks below are verbatim samples from production `app_error` events
 * (PostHog, 90-day window) — the minified names rotate with each third-party
 * deploy, which is why several shapes are covered.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { isOriginRedactedThirdPartyStack } from '@/services/benignErrorPatterns';
import {
  createExceptionFilter,
  recordRawErrorStack,
  _resetRawStackBufferForTests,
} from '@/services/posthog-error-filter';

/** Build the alternating-pair stack shape observed in production. */
function mutualRecursionStack(a: string, b: string, leadingAnonymous: number, pairs: number): string {
  const lines: string[] = [];
  for (let i = 0; i < leadingAnonymous; i += 1) lines.push('@');
  for (let i = 0; i < pairs; i += 1) { lines.push(`${a}@`); lines.push(`${b}@`); }
  return lines.join('\n');
}

// Verbatim production samples (same shape, names differ per third-party build).
const PRODUCTION_STACKS = [
  mutualRecursionStack('Nk', 'Pk', 3, 40),
  mutualRecursionStack('Sk', 'Qk', 4, 40),
  mutualRecursionStack('ll', 'jl', 4, 40),
  mutualRecursionStack('$k', 'Yk', 5, 40),
  mutualRecursionStack('gl', 'el', 1, 40),
];

describe('isOriginRedactedThirdPartyStack (#4173)', () => {
  it.each(PRODUCTION_STACKS)('classifies a production origin-redacted stack as third-party', (stack) => {
    expect(isOriginRedactedThirdPartyStack(stack)).toBe(true);
  });

  it('does NOT classify a first-party WebKit stack as third-party', () => {
    const firstParty = [
      'scoreMunicipalities@https://cdn.frontaliereticino.ch/assets/LivabilityIndex.js:12:3401',
      'Wr@https://cdn.frontaliereticino.ch/assets/vendor-react.js:9:12045',
      'gl@https://cdn.frontaliereticino.ch/assets/router.js:3:889',
      'il@https://cdn.frontaliereticino.ch/assets/router.js:3:1204',
      '@https://frontaliereticino.ch/:44:12',
    ].join('\n');
    expect(isOriginRedactedThirdPartyStack(firstParty)).toBe(false);
  });

  it('does NOT classify a MIXED stack (one first-party frame) as third-party', () => {
    const mixed = `${mutualRecursionStack('Nk', 'Pk', 3, 20)}\nboot@https://cdn.frontaliereticino.ch/assets/index-entry.js:1:12`;
    expect(isOriginRedactedThirdPartyStack(mixed)).toBe(false);
  });

  it('does NOT classify a V8-shaped stack as third-party (URL-less frame means eval there)', () => {
    const v8 = [
      'RangeError: Maximum call stack size exceeded',
      '    at eval (eval at <anonymous>)',
      '    at eval (eval at <anonymous>)',
      '    at eval (eval at <anonymous>)',
      '    at eval (eval at <anonymous>)',
      '    at eval (eval at <anonymous>)',
    ].join('\n');
    expect(isOriginRedactedThirdPartyStack(v8)).toBe(false);
  });

  it('needs a run of frames — a 1-2 frame nameless stack is inconclusive', () => {
    expect(isOriginRedactedThirdPartyStack('@')).toBe(false);
    expect(isOriginRedactedThirdPartyStack('Nk@\nPk@')).toBe(false);
  });

  it('is a no-op for empty / non-string input', () => {
    expect(isOriginRedactedThirdPartyStack('')).toBe(false);
    expect(isOriginRedactedThirdPartyStack(undefined as unknown as string)).toBe(false);
  });
});

describe('posthog before_send raw-stack bridge (#4173)', () => {
  beforeEach(() => { _resetRawStackBufferForTests(); });

  const zeroFrameRangeError = {
    event: '$exception',
    properties: {
      $exception_values: ['Maximum call stack size exceeded.'],
      $exception_list: [{
        type: 'RangeError',
        value: 'Maximum call stack size exceeded.',
        stacktrace: { type: 'resolved', frames: [] },
      }],
    },
  };

  it('drops the zero-frame RangeError once the raw stack is known', () => {
    const filter = createExceptionFilter();
    recordRawErrorStack('Maximum call stack size exceeded.', PRODUCTION_STACKS[0]);
    expect(filter(zeroFrameRangeError)).toBeNull();
  });

  it('KEEPS the same zero-frame RangeError when no raw stack proves it third-party', () => {
    const filter = createExceptionFilter();
    expect(filter(zeroFrameRangeError)).not.toBeNull();
  });

  it('KEEPS a RangeError whose recorded stack is first-party', () => {
    const filter = createExceptionFilter();
    recordRawErrorStack(
      'Maximum call stack size exceeded.',
      'walk@https://cdn.frontaliereticino.ch/assets/App.js:4:9001\nwalk@https://cdn.frontaliereticino.ch/assets/App.js:4:9001',
    );
    expect(filter(zeroFrameRangeError)).not.toBeNull();
  });

  it('never drops a real first-party exception that carries resolved frames', () => {
    const filter = createExceptionFilter();
    recordRawErrorStack('boom', PRODUCTION_STACKS[0]);
    const realError = {
      event: '$exception',
      properties: {
        $exception_values: ['TypeError: Cannot read properties of undefined (reading "salary")'],
        $exception_list: [{
          stacktrace: { frames: [{ filename: 'https://cdn.frontaliereticino.ch/assets/App.js' }] },
        }],
      },
    };
    expect(filter(realError)).not.toBeNull();
  });

  it('keeps the ring buffer bounded', () => {
    for (let i = 0; i < 30; i += 1) recordRawErrorStack(`msg-${i}`, PRODUCTION_STACKS[0]);
    const filter = createExceptionFilter();
    // The oldest entry has been evicted → the matching lookup must miss.
    expect(filter({
      event: '$exception',
      properties: { $exception_values: ['msg-0'], $exception_list: [{ stacktrace: { frames: [] } }] },
    })).not.toBeNull();
  });
});

describe('app_error pipelines re-classify origin-redacted stacks (#4173)', () => {
  it('errorReporter reports cross_origin_script / non-fatal instead of api_error', async () => {
    vi.resetModules();
    const trackAppError = vi.fn();
    vi.doMock('@/services/analytics', () => ({ Analytics: { trackAppError } }));
    vi.doMock('@/services/newsletterAutologinSignal', () => ({ isNewsletterAutologinInFlight: () => false }));
    vi.doMock('@/services/resilientImport', () => ({
      isVersionSkewError: () => false,
      recoverFromStaleChunk: vi.fn(),
    }));
    const { reportCaughtError, _resetThrottleMapForTests } = await import('@/services/errorReporter');
    _resetThrottleMapForTests();

    const thirdParty = new Error('Maximum call stack size exceeded.');
    thirdParty.stack = PRODUCTION_STACKS[0];
    reportCaughtError(thirdParty, 'ads.thirdParty', { fatal: true });
    expect(trackAppError).toHaveBeenCalledWith('cross_origin_script', expect.objectContaining({ fatal: false }));

    trackAppError.mockClear();
    const firstParty = new Error('boom');
    firstParty.stack = 'calc@https://cdn.frontaliereticino.ch/assets/App.js:1:2';
    reportCaughtError(firstParty, 'calc.run', { fatal: true });
    expect(trackAppError).toHaveBeenCalledWith('api_error', expect.objectContaining({ fatal: true }));
    vi.doUnmock('@/services/analytics');
    vi.doUnmock('@/services/newsletterAutologinSignal');
    vi.doUnmock('@/services/resilientImport');
    vi.resetModules();
  });
});
