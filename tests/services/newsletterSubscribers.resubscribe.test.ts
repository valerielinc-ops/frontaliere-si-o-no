/**
 * Regression test for issue #2852 item 2 (adversarial-check follow-up on
 * PR #2836's winback/sunset guard).
 *
 * scripts/lib/subscriberSunset.mjs gates the win-back grace period on
 * `resubscribed_at`/`resubscribedAt` (`reengagedAt >= winbackAt`). The
 * win-back "stay subscribed" email link is built by
 * services/winbackEmail.mjs via makeAuthenticatedActionUrl('resubscribe', ...),
 * which points at the SPA root (`/?action=resubscribe&email=...&ac=...`).
 * App.tsx's resubscribe handler (around L917-929) processes that action
 * entirely client-side via `upsertNewsletterSubscriber` →
 * `captureNewsletterSubscriber`, passing `source: 'resubscribe_link'` — it
 * never calls the Cloud Function `newsletterManageSubscription` (whose own
 * `action === 'resubscribe'` branch in
 * functions/src/newsletterSubscriptionManagement.js DOES stamp
 * `resubscribed_at`, but is unreachable from that link).
 *
 * Before this fix, `captureNewsletterSubscriber` never wrote
 * `resubscribed_at`/`resubscribedAt`, so the sunset guard's re-consent check
 * was permanently dead code in production for winback clicks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const setDocMock = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
const addDocMock = vi.fn<(...args: unknown[]) => Promise<{ id: string }>>(async () => ({ id: 'evt-1' }));
const getDocMock = vi.fn<(...args: unknown[]) => Promise<{ exists: () => boolean; data: () => any }>>();

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => ({})),
  doc: vi.fn(() => ({})),
  getDoc: (...args: unknown[]) => getDocMock(...args),
  setDoc: (...args: unknown[]) => setDocMock(...args),
  addDoc: (...args: unknown[]) => addDocMock(...args),
  increment: vi.fn((n: number) => ({ __increment: n })),
  serverTimestamp: vi.fn(() => '__server_timestamp__'),
  deleteField: vi.fn(() => '__delete_field__'),
}));

import { captureNewsletterSubscriber } from '@/services/newsletterSubscribers';

describe('captureNewsletterSubscriber — resubscribe_link source (issue #2852 item 2)', () => {
  beforeEach(() => {
    setDocMock.mockClear();
    addDocMock.mockClear();
    getDocMock.mockReset();
  });

  it('stamps resubscribed_at/resubscribedAt for a winback recipient who clicks "stay subscribed"', async () => {
    // Winback recipients are still 'confirmed'/mailable (non-engaging, not
    // unsubscribed) — exactly the population scripts/lib/subscriberSunset.mjs
    // sends the winback email to before the grace-period sunset check.
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        email: 'winback@example.com',
        status: 'confirmed',
        isActive: true,
        active: true,
        winback_sent_at: '2026-06-01T00:00:00.000Z',
      }),
    });

    await captureNewsletterSubscriber(
      // db param is opaque to the mocked firestore functions
      {} as any,
      {
        email: 'winback@example.com',
        source: 'resubscribe_link',
        isActive: true,
        preferences: { exchangeRate: true, traffic: true, taxUpdates: true, tips: false },
      },
    );

    expect(setDocMock).toHaveBeenCalledTimes(1);
    const payload = (setDocMock.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(payload.resubscribed_at).toBe('__server_timestamp__');
    expect(payload.resubscribedAt).toBe('__server_timestamp__');
  });

  it('does not stamp resubscribed_at for unrelated subscribe sources', async () => {
    getDocMock.mockResolvedValue({ exists: () => false, data: () => undefined });

    await captureNewsletterSubscriber(
      {} as any,
      { email: 'new@example.com', source: 'popup' },
    );

    expect(setDocMock).toHaveBeenCalledTimes(1);
    const payload = (setDocMock.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(payload.resubscribed_at).toBeUndefined();
    expect(payload.resubscribedAt).toBeUndefined();
  });
});
