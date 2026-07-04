import { describe, it, expect } from 'vitest';
import { createExceptionFilter } from '@/services/posthog-error-filter';

const makeExceptionEvent = (...messages: string[]) => ({
  event: '$exception',
  properties: {
    $exception_values: messages.map((value) => ({ type: 'Error', value })),
  },
});

describe('createExceptionFilter()', () => {
  const filter = createExceptionFilter();

  it('passes non-exception events through unchanged', () => {
    const event = { event: '$pageview', properties: { url: '/' } };
    expect(filter(event)).toBe(event);
  });

  it('drops ResizeObserver loop noise', () => {
    const event = makeExceptionEvent('ResizeObserver loop completed with undelivered notifications.');
    expect(filter(event)).toBeNull();
  });

  it('drops cross-origin "Script error." messages', () => {
    const event = makeExceptionEvent('Script error.');
    expect(filter(event)).toBeNull();
  });

  it('drops Non-Error promise rejections', () => {
    const event = makeExceptionEvent('Non-Error promise rejection captured with value: undefined');
    expect(filter(event)).toBeNull();
  });

  it('drops Safari IDB "Connection to Indexed Database server lost"', () => {
    const event = makeExceptionEvent(
      'UnknownError: Connection to Indexed Database server lost. Refresh the page to try again',
    );
    expect(filter(event)).toBeNull();
  });

  it('drops Firebase RC InvalidStateError on IDBDatabase', () => {
    const event = makeExceptionEvent(
      "InvalidStateError: Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
    );
    expect(filter(event)).toBeNull();
  });

  it('drops AbortError from aborted signals', () => {
    const event = makeExceptionEvent('AbortError: signal is aborted without reason');
    expect(filter(event)).toBeNull();
  });

  it('drops Safari generic "TypeError: Load failed" (transport noise — no actionable source)', () => {
    const event = makeExceptionEvent('TypeError: Load failed');
    expect(filter(event)).toBeNull();
  });

  it('keeps real Load-failed errors that carry extra context', () => {
    // Only the bare canonical Safari message is benign; anything richer should pass.
    const event = makeExceptionEvent('TypeError: Load failed for https://api.example.com/v1/data');
    expect(filter(event)).toBe(event);
  });

  it('lets real errors through (ChunkLoadError)', () => {
    const event = makeExceptionEvent('TypeError: Importing a module script failed.');
    expect(filter(event)).toBe(event);
  });

  it('lets real TypeErrors in app code through', () => {
    const event = makeExceptionEvent("TypeError: Cannot read properties of undefined (reading 'foo')");
    expect(filter(event)).toBe(event);
  });

  it('supports the alternate $exception_list payload shape', () => {
    const event = {
      event: '$exception',
      properties: {
        $exception_list: ['ResizeObserver loop limit exceeded'],
      },
    };
    expect(filter(event)).toBeNull();
  });

  it('returns the event when exception payload is empty (avoid dropping by mistake)', () => {
    const event = { event: '$exception', properties: { $exception_values: [] } };
    expect(filter(event)).toBe(event);
  });

  // Issue #3407 ("Error: oa"): live PostHog data showed every sampled
  // occurrence's resolved stack lives entirely inside Google's own
  // accounts.google.com/gsi/client script — a third-party origin we do
  // not control. The message itself ("oa") is too short/generic to
  // pattern-match safely, so the filter inspects resolved stack frames.
  it('drops exceptions whose entire resolved stack is Google Identity Services (#3407)', () => {
    const event = {
      event: '$exception',
      properties: {
        $exception_values: [{ type: 'Error', value: 'oa' }],
        $exception_list: [
          {
            type: 'Error',
            value: 'oa',
            stacktrace: {
              frames: [
                { filename: 'https://accounts.google.com/gsi/client', lineno: 193, colno: 71 },
                { filename: 'https://accounts.google.com/gsi/client', lineno: 188, colno: 1 },
              ],
            },
          },
        ],
      },
    };
    expect(filter(event)).toBeNull();
  });

  it('keeps exceptions with a mixed first-party + third-party stack', () => {
    const event = {
      event: '$exception',
      properties: {
        $exception_values: [{ type: 'TypeError', value: 'oa' }],
        $exception_list: [
          {
            type: 'TypeError',
            value: 'oa',
            stacktrace: {
              frames: [
                { filename: 'https://accounts.google.com/gsi/client', lineno: 193, colno: 71 },
                { filename: 'https://frontaliereticino.ch/assets/index-entry.js', lineno: 12, colno: 4 },
              ],
            },
          },
        ],
      },
    };
    expect(filter(event)).toBe(event);
  });

  it('keeps exceptions with no resolved stack frames even if message is short/opaque', () => {
    const event = {
      event: '$exception',
      properties: {
        $exception_values: [{ type: 'Error', value: 'oa' }],
        $exception_list: [{ type: 'Error', value: 'oa' }],
      },
    };
    expect(filter(event)).toBe(event);
  });

  it('supports junk_drawer.raw_frame.filename fallback for unresolved frames', () => {
    const event = {
      event: '$exception',
      properties: {
        $exception_values: [{ type: 'Error', value: 'oa' }],
        $exception_list: [
          {
            type: 'Error',
            value: 'oa',
            stacktrace: {
              frames: [
                { junk_drawer: { raw_frame: { filename: 'https://accounts.google.com/gsi/client' } } },
              ],
            },
          },
        ],
      },
    };
    expect(filter(event)).toBeNull();
  });
});
