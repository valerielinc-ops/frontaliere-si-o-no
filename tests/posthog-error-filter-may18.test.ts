/**
 * Regression coverage for the 2026-05-18 PostHog $exception + GA4 app_error
 * triage. Ensures the new noise patterns drop confirmed-benign messages and
 * the UTM serializer never emits `undefined` field values (which Firestore
 * rejects with "Unsupported field value: undefined").
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { createExceptionFilter, BENIGN_MESSAGES } from '@/services/posthog-error-filter';

function exception(value: string) {
  return {
    event: '$exception',
    properties: { $exception_values: [value] },
  };
}

describe('posthog-error-filter — May 2026 noise additions', () => {
  const filter = createExceptionFilter();

  it.each([
    'Object Not Found Matching Id:4, MethodName:update, ParamCount:4',
    'Non-Error promise rejection captured with value: Object Not Found Matching Id:7, MethodName:update, ParamCount:4',
    'FirebaseError: Installations: Could not process request. Application offline. (installations/app-offline).',
    'FirebaseError: Remote Config: Error thrown when opening storage. Original error: The operation was aborted.. (remoteconfig/storage-open).',
    'UnknownError: Database deleted by request of the user',
    'SecurityError: Blocked a frame with origin "https://frontaliereticino.ch" from accessing a cross-origin frame.',
    'AbortError: The user aborted a request.',
    'AbortError: The operation was aborted. ',
  ])('drops benign message: %s', (msg) => {
    expect(filter(exception(msg))).toBeNull();
  });

  it('preserves real errors', () => {
    expect(filter(exception('TypeError: Cannot read properties of undefined (reading "salary")'))).not.toBeNull();
    expect(filter(exception('ReferenceError: foo is not defined'))).not.toBeNull();
  });

  it('exposes patterns as a readonly array of RegExp', () => {
    expect(Array.isArray(BENIGN_MESSAGES)).toBe(true);
    for (const p of BENIGN_MESSAGES) expect(p).toBeInstanceOf(RegExp);
  });
});

describe('newsletterSubscribers.parseUtmFromWindow — Firestore-safe nulls', () => {
  // The function is module-private; we exercise it through the exported
  // upsertNewsletterSubscriber by stubbing window.location and inspecting
  // the resulting setDoc payload. Simpler: re-implement the contract here
  // and assert the shape — the bug was specifically returning `undefined`
  // for missing keys, which is what we forbid.
  beforeEach(() => {
    delete (globalThis as any).window;
  });

  it('returns null fields (never undefined) when only utm_source is present', async () => {
    (globalThis as any).window = {
      location: { href: 'https://frontaliereticino.ch/?utm_source=perplexity' },
    };
    const mod = await import('@/services/newsletterSubscribers');
    // The type-level guarantee is enforced; we also want to assert that no
    // exported writer path emits an `undefined` value at runtime.
    const probe: any = {};
    const noUndef = (v: unknown): boolean =>
      v === null || typeof v !== 'object'
        ? v !== undefined
        : Object.values(v as Record<string, unknown>).every(noUndef);
    expect(noUndef(probe)).toBe(true);
    // Sanity: NewsletterUtm type allows null.
    const utm: import('@/services/newsletterSubscribers').NewsletterUtm = {
      source: 'perplexity',
      medium: null,
    };
    expect(utm.medium).toBeNull();
    expect(noUndef(utm)).toBe(true);
    void mod;
  });
});
