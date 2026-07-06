/**
 * Unit tests for `subscribeJobAlertOneTap`, `normalizeKeyword`,
 * and `findMatchingAlertForCategory` in services/jobAlertService.ts.
 *
 * `subscribeJobAlertOneTap` flows into the existing `createAlert`, which
 * in turn calls `addDoc`/`setDoc` on Firestore. We mock those primitives
 * and inspect the document body that `addDoc` is invoked with to verify
 * the canonical 1-tap config shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JobAlert } from '@/services/jobAlertService';

const addDocMock = vi.fn<(...args: unknown[]) => Promise<{ id: string }>>(async () => ({
  id: 'alert-id',
}));
const setDocMock = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
const getDocsMock = vi.fn<(...args: unknown[]) => Promise<{ size: number; docs: unknown[] }>>(
  async () => ({ size: 0, docs: [] }),
);

vi.mock('firebase/firestore', () => ({
  collectionGroup: vi.fn(() => ({})),
  collection: vi.fn(() => ({})),
  addDoc: (...args: unknown[]) => addDocMock(...args),
  doc: vi.fn(() => ({})),
  setDoc: (...args: unknown[]) => setDocMock(...args),
  updateDoc: vi.fn(async () => undefined),
  query: vi.fn(() => ({})),
  where: vi.fn(() => ({})),
  getDocs: (...args: unknown[]) => getDocsMock(...args),
  orderBy: vi.fn(() => ({})),
  serverTimestamp: vi.fn(() => new Date()),
  getFirestore: vi.fn(() => ({})),
}));

import {
  normalizeKeyword,
  findMatchingAlertForCategory,
  subscribeJobAlertOneTap,
} from '@/services/jobAlertService';

describe('normalizeKeyword', () => {
  it('lowercases', () => {
    expect(normalizeKeyword('Sanità')).toBe('sanita');
  });

  it('strips accents (NFD)', () => {
    expect(normalizeKeyword('Édition')).toBe('edition');
  });

  it('trims and collapses whitespace', () => {
    expect(normalizeKeyword('  multiple   spaces ')).toBe('multiple spaces');
  });

  it('returns empty string for falsy input', () => {
    expect(normalizeKeyword('')).toBe('');
    expect(normalizeKeyword(undefined as unknown as string)).toBe('');
    expect(normalizeKeyword(null as unknown as string)).toBe('');
  });

  it('strips the category emoji so "💻 Tecnologia" and "Tecnologia" compare equal', () => {
    expect(normalizeKeyword('💻 Tecnologia')).toBe('tecnologia');
    expect(normalizeKeyword('Tecnologia')).toBe('tecnologia');
    expect(normalizeKeyword('🏥 Sanità')).toBe('sanita');
  });

  it('strips emoji outside the legacy BMP ranges (⭐, ❤️, ⚙️ compound)', () => {
    expect(normalizeKeyword('⭐ Premium')).toBe('premium');
    expect(normalizeKeyword('❤️ Cura')).toBe('cura');
    expect(normalizeKeyword('⚙️ Ingegneria')).toBe('ingegneria');
  });
});

describe('findMatchingAlertForCategory', () => {
  const alert = (id: string, keywords: string[], active = true): JobAlert => ({
    id,
    userId: 'u1',
    email: 'a@b.com',
    keywords,
    locations: [],
    contractTypes: [],
    sectors: [],
    frequency: 'weekly',
    locale: 'it',
    active,
    createdAt: new Date(),
    lastMatchedAt: null,
    matchCount: 0,
  });

  it('returns null on empty alerts', () => {
    expect(findMatchingAlertForCategory([], 'Sanità')).toBeNull();
  });

  it('returns null when category empty', () => {
    expect(findMatchingAlertForCategory([alert('a', ['sanita'])], '')).toBeNull();
  });

  it('matches case- and accent-insensitively', () => {
    const a = alert('a', ['Sanità']);
    expect(findMatchingAlertForCategory([a], 'sanita')).toBe(a);
  });

  it('skips inactive alerts', () => {
    const a = alert('a', ['Sanità'], false);
    expect(findMatchingAlertForCategory([a], 'Sanità')).toBeNull();
  });

  it('returns null when no keyword matches', () => {
    const a = alert('a', ['Finanza', 'IT']);
    expect(findMatchingAlertForCategory([a], 'Sanità')).toBeNull();
  });

  it('returns the first matching alert', () => {
    const a = alert('a', ['Marketing']);
    const b = alert('b', ['Sanità']);
    const c = alert('c', ['Sanità']);
    expect(findMatchingAlertForCategory([a, b, c], 'Sanità')).toBe(b);
  });
});

describe('subscribeJobAlertOneTap', () => {
  beforeEach(() => {
    addDocMock.mockClear();
    setDocMock.mockClear();
    getDocsMock.mockClear();
    getDocsMock.mockResolvedValue({ size: 0, docs: [] });
  });

  it('writes the canonical 1-tap config to Firestore', async () => {
    const result = await subscribeJobAlertOneTap('user-1', 'Foo@Example.COM', 'Sanità', 'it');

    // The parent subscriber doc is upserted with normalised email.
    expect(setDocMock).toHaveBeenCalledTimes(1);
    const subscriberPayload = (setDocMock.mock.calls[0] as unknown[])[1];
    expect(subscriberPayload).toMatchObject({
      email: 'foo@example.com',
      userId: 'user-1',
      locale: 'it',
    });

    // The alert subdoc carries the canonical 1-tap shape.
    expect(addDocMock).toHaveBeenCalledTimes(1);
    const alertPayload = (addDocMock.mock.calls[0] as unknown[])[1];
    expect(alertPayload).toMatchObject({
      email: 'foo@example.com',
      userId: 'user-1',
      keywords: ['Sanità'],
      locations: [],
      contractTypes: [],
      sectors: [],
      // 1-tap subscriptions default to no canton filter — alert covers
      // all 26 cantons. `null` keeps the storage shape backward-compatible.
      cantonFilter: null,
      frequency: 'weekly',
      locale: 'it',
      active: true,
      matchCount: 0,
      lastMatchedAt: null,
    });

    expect(result.id).toBe('alert-id');
    expect(result.frequency).toBe('weekly');
  });

  it('trims whitespace from the category and forwards locale', async () => {
    await subscribeJobAlertOneTap('u', 'e@x.com', '  Marketing  ', 'en');
    const alertPayload = (addDocMock.mock.calls[0] as unknown[])[1] as {
      keywords: string[];
      locale: string;
    };
    expect(alertPayload.keywords).toEqual(['Marketing']);
    expect(alertPayload.locale).toBe('en');
  });

  it('strips the leading emoji from the stored keyword (so it can match job text)', async () => {
    await subscribeJobAlertOneTap('u', 'e@x.com', '💻 Tecnologia', 'it');
    const alertPayload = (addDocMock.mock.calls[0] as unknown[])[1] as { keywords: string[] };
    expect(alertPayload.keywords).toEqual(['Tecnologia']);
  });

  it('records the source job provenance when provided', async () => {
    await subscribeJobAlertOneTap('u', 'e@x.com', '💻 Tecnologia', 'it', {
      slug: 'ingegnere-software-duferco-lugano',
      url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/ingegnere-software-duferco-lugano/',
      title: 'Ingegnere di software senior',
    });
    const alertPayload = (addDocMock.mock.calls[0] as unknown[])[1] as {
      sourceJobSlug: string | null;
      sourceJobUrl: string | null;
      sourceJobTitle: string | null;
    };
    expect(alertPayload.sourceJobSlug).toBe('ingegnere-software-duferco-lugano');
    expect(alertPayload.sourceJobUrl).toContain('/cerca-lavoro-ticino/');
    expect(alertPayload.sourceJobTitle).toBe('Ingegnere di software senior');
  });

  it('defaults source provenance to null when omitted', async () => {
    await subscribeJobAlertOneTap('u', 'e@x.com', 'Marketing', 'it');
    const alertPayload = (addDocMock.mock.calls[0] as unknown[])[1] as {
      sourceJobSlug: string | null;
      sourceJobUrl: string | null;
      sourceJobTitle: string | null;
    };
    expect(alertPayload.sourceJobSlug).toBeNull();
    expect(alertPayload.sourceJobUrl).toBeNull();
    expect(alertPayload.sourceJobTitle).toBeNull();
  });

  it('propagates the max-3-alerts cap from createAlert', async () => {
    getDocsMock.mockResolvedValueOnce({ size: 3, docs: [] });
    await expect(
      subscribeJobAlertOneTap('user-1', 'a@b.com', 'Sanità', 'it'),
    ).rejects.toThrow(/Maximum 3/);
    expect(addDocMock).not.toHaveBeenCalled();
  });

  // Issue #3650 — the job-match profile CTA pre-fills the alert's canton from
  // services/jobMatchProfile.ts (already-validated canton code) as a 6th
  // optional arg, hard-scoping the alert instead of covering all cantons.
  it('sets cantonFilter from the optional cantonCode argument', async () => {
    await subscribeJobAlertOneTap('u', 'e@x.com', '💻 Tecnologia', 'it', undefined, 'TI');
    const alertPayload = (addDocMock.mock.calls[0] as unknown[])[1] as {
      cantonFilter: string[] | null;
    };
    expect(alertPayload.cantonFilter).toEqual(['TI']);
  });

  it('defaults cantonFilter to null when cantonCode is omitted', async () => {
    await subscribeJobAlertOneTap('u', 'e@x.com', 'Marketing', 'it');
    const alertPayload = (addDocMock.mock.calls[0] as unknown[])[1] as {
      cantonFilter: string[] | null;
    };
    expect(alertPayload.cantonFilter).toBeNull();
  });

  it('defaults cantonFilter to null when cantonCode is explicitly null', async () => {
    await subscribeJobAlertOneTap('u', 'e@x.com', 'Marketing', 'it', undefined, null);
    const alertPayload = (addDocMock.mock.calls[0] as unknown[])[1] as {
      cantonFilter: string[] | null;
    };
    expect(alertPayload.cantonFilter).toBeNull();
  });
});
