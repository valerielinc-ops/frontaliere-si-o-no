import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase/firestore';

const sdk = vi.hoisted(() => ({
  loaded: vi.fn(),
  getDoc: vi.fn(async () => ({ exists: () => false })),
  reportCaughtError: vi.fn(),
}));

vi.mock('firebase/firestore', () => {
  sdk.loaded();
  return {
    collection: vi.fn(() => ({})),
    doc: vi.fn(() => ({})),
    getDoc: sdk.getDoc,
  };
});
vi.mock('@/services/errorReporter', () => ({ reportCaughtError: sdk.reportCaughtError }));

import {
  isNewsletterOptedOut,
  normalizeNewsletterEmail,
  recordNewsletterEvent,
  captureNewsletterSubscriber,
} from '@/services/newsletterSubscribers';

describe('newsletter Firestore loading', () => {
  it('keeps helpers and rejected inputs SDK-free, then reuses the SDK for subsequent reads', async () => {
    expect(sdk.loaded).not.toHaveBeenCalled();
    expect(normalizeNewsletterEmail(' Person@Example.com ')).toBe('person@example.com');
    const db = {} as Firestore;
    expect(await isNewsletterOptedOut(db, '')).toBe(false);
    await recordNewsletterEvent(db, { email: '', eventType: 'open' });
    await expect(captureNewsletterSubscriber(db, { email: '' })).rejects.toThrow('Invalid email');
    expect(sdk.loaded).not.toHaveBeenCalled();

    // Vitest's manual-module mock loader does not support simultaneous first
    // imports; exercise module reuse with successive reads instead.
    expect(await isNewsletterOptedOut(db, 'one@example.com')).toBe(false);
    expect(await isNewsletterOptedOut(db, 'two@example.com')).toBe(false);
    expect(sdk.reportCaughtError).not.toHaveBeenCalled();
    expect(sdk.loaded).toHaveBeenCalledTimes(1);
    expect(sdk.getDoc).toHaveBeenCalledTimes(2);

    const failure = new Error('unavailable');
    sdk.getDoc.mockRejectedValueOnce(failure);
    expect(await isNewsletterOptedOut(db, 'one@example.com')).toBe(true);
    expect(sdk.reportCaughtError).toHaveBeenCalled();
  });
});
