import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../scripts/lib/onboarding-drip-candidates.mjs', () => ({
  loadOnboardingDripCandidates: vi.fn(),
}));

vi.mock('../scripts/lib/subscriberFromFirestoreRow.mjs', () => ({
  subscriberFromFirestoreRow: vi.fn((row: Record<string, unknown>) => (
    row.email === 'invalid-address' ? null : { email: row.email, locale: 'it' }
  )),
}));

import { loadOnboardingDripCandidates } from '../scripts/lib/onboarding-drip-candidates.mjs';
import { subscriberFromFirestoreRow } from '../scripts/lib/subscriberFromFirestoreRow.mjs';
import { buildQueue } from '../scripts/send-onboarding-drip.mjs';

describe('onboarding drip queue', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps later due subscribers when an earlier due row has no usable email', async () => {
    const now = new Date('2026-11-08T12:00:00.000Z');
    const startedAt = new Date(now.getTime() - 2 * 86400000);
    const docs = [
      {
        id: 'invalid-address',
        ref: { path: 'newsletter_subscribers/invalid-address' },
        data: () => ({ drip_started_at: startedAt, drip_last_step: -1 }),
      },
      {
        id: 'valid@example.invalid',
        ref: { path: 'newsletter_subscribers/valid@example.invalid' },
        data: () => ({ email: 'valid@example.invalid', drip_started_at: startedAt, drip_last_step: -1 }),
      },
    ];
    vi.mocked(loadOnboardingDripCandidates).mockResolvedValue({ docs } as any);

    const queue = await buildQueue(9, now, {} as any);

    expect(queue).toHaveLength(1);
    expect(queue[0].email).toBe('valid@example.invalid');
    expect(queue[0].step).toBe(0);
    expect(subscriberFromFirestoreRow).toHaveBeenCalledTimes(2);
  });
});
