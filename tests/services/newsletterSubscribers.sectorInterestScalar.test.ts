/**
 * Regression test for issue #4615 item 2 (adversarial-check follow-up on
 * PR #4609's "sector_interest as tier-1 eligibility signal" fix).
 *
 * Concern: a non-string `sector_interest` (e.g. an array from a multi-select)
 * would coerce via `String(...)` the same as `job_category`/`job_location` —
 * consistent with the pre-existing pattern, but not previously confirmed that
 * (a) no real write path ever produces a non-scalar `sectorInterest`, and
 * (b) if one somehow did (bypassing the `string | null` type at a JS→TS
 * boundary), the coercion stays a plain scalar string rather than silently
 * writing something eligibility logic could misread.
 *
 * Audit (issue #4615 item 2): every source that feeds
 * `NewsletterUpsertInput.sectorInterest` is scalar by construction —
 * `URLSearchParams.get()` (App.tsx), `JobCategory`/`ExpiredJob.sector`
 * (`string`-typed fields normalized via `normalizeJobCategory`), or
 * `derivePersonalizationPatch`'s `topWeighted` (already `String()`-coerced
 * per entry, see subscriber-personalization.test.ts). No multi-select/array
 * source exists. This test pins the defense-in-depth boundary: even a
 * caller that bypasses the TS type still can't get a non-scalar value
 * written to Firestore.
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

describe('captureNewsletterSubscriber — sector_interest stays scalar (issue #4615 item 2)', () => {
  beforeEach(() => {
    setDocMock.mockClear();
    addDocMock.mockClear();
    getDocMock.mockReset();
  });

  it('coerces a non-scalar sectorInterest input into a plain string, never an array/object', async () => {
    getDocMock.mockResolvedValue({ exists: () => false, data: () => undefined });

    await captureNewsletterSubscriber(
      {} as any,
      {
        email: 'array-sector@example.com',
        source: 'newsletter_page',
        // Bypasses the `string | null` type — simulates a hypothetical
        // caller that doesn't respect NewsletterUpsertInput.
        sectorInterest: ['health', 'tech'] as unknown as string,
      },
    );

    expect(setDocMock).toHaveBeenCalledTimes(1);
    const payload = (setDocMock.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(typeof payload.sector_interest).toBe('string');
    expect(Array.isArray(payload.sector_interest)).toBe(false);
  });
});
