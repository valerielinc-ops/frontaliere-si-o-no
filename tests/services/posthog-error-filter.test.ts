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
});
