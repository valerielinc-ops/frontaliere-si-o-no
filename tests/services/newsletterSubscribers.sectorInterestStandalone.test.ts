/**
 * Regression test for issue #4615 item 1 (adversarial-check follow-up on
 * PR #4609's "sector_interest as tier-1 eligibility signal" fix).
 *
 * Concern: `functions/src/lib/subscriberPersonalization.js`'s tier-3
 * fallback always derives `sector_interest`/`job_category` together from the
 * same weighted value — so it never produces a sector-only subscriber, which
 * raised the question of whether ANY real write path into
 * `newsletter_subscribers` can leave `sector_interest` set without
 * `job_category` (the exact shape PR #4609 made eligible for tier-1).
 *
 * `captureNewsletterSubscriber` (services/newsletterSubscribers.ts) is such a
 * path: `sector_interest` comes from `input.sectorInterest` (a standalone
 * signup-time signal — e.g. the `sector_interest` URL param on a newsletter
 * link, App.tsx L716/741/760), independent of `job_category`, which only
 * comes from `jobContext.category` (job-page context). A subscriber who
 * signs up with a sector signal but no job context gets `sector_interest`
 * with no `job_category` — pins that this real writer both (a) produces the
 * sector-only shape and (b) that shape is treated as tier-1 by
 * `getSignalTier`, so PR #4609's added case is exercised in production, not
 * moot.
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
import { getSignalTier } from '../../functions/src/jobAlertBackfillCore.js';

describe('captureNewsletterSubscriber — sector_interest without job_category (issue #4615 item 1)', () => {
  beforeEach(() => {
    setDocMock.mockClear();
    addDocMock.mockClear();
    getDocMock.mockReset();
  });

  it('writes sector_interest with no job_category for a sector-only signup, and that shape is tier-1 eligible', async () => {
    getDocMock.mockResolvedValue({ exists: () => false, data: () => undefined });

    await captureNewsletterSubscriber(
      {} as any,
      {
        email: 'sector-only@example.com',
        source: 'newsletter_page',
        sectorInterest: 'health',
        // No jobContext — this subscriber never visited a job page.
      },
    );

    expect(setDocMock).toHaveBeenCalledTimes(1);
    const payload = (setDocMock.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(payload.sector_interest).toBe('health');
    expect(payload.job_category).toBeFalsy();

    // The invariant "sector_interest never appears without job_category"
    // does NOT hold for this writer — confirm the eligibility gate still
    // treats it as tier-1, not a weaker fallback.
    expect(getSignalTier(payload)).toBe('signal');
  });
});
