import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock firebase/firestore
const mockAddDoc = vi.fn(() => Promise.resolve());
const mockUpdateDoc = vi.fn(() => Promise.resolve());
const mockGetDocs = vi.fn(() => Promise.resolve({ empty: true, docs: [] }));
vi.mock('firebase/firestore', () => ({
  getFirestore: vi.fn(() => ({})),
  collection: vi.fn((_db: any, name: string) => name),
  addDoc: (...args: any[]) => mockAddDoc(...args),
  updateDoc: (...args: any[]) => mockUpdateDoc(...args),
  query: vi.fn((...args: any[]) => args),
  where: vi.fn((...args: any[]) => args),
  getDocs: (...args: any[]) => mockGetDocs(...args),
}));

vi.mock('@/services/firebase', () => ({
  app: {},
}));

vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    locale: 'it' as const,
  }),
}));

vi.mock('@/services/errorReporter', () => ({
  reportCaughtError: vi.fn(),
}));

vi.mock('@/services/newsletterSubscribers', () => ({
  confirmNewsletterSubscription: vi.fn(() => Promise.resolve({ success: true })),
  clearNewsletterPendingLocally: vi.fn(),
  markNewsletterSubscribedLocally: vi.fn(),
}));

import { useNewsletterState } from '@/hooks/useNewsletterState';

describe('useNewsletterState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // Reset URL to clean state
    window.history.replaceState({}, '', '/');
  });

  it('returns correct initial state', () => {
    const { result } = renderHook(() => useNewsletterState());

    expect(result.current.unsubscribeMsg).toBeNull();
    expect(result.current.newsletterActionEmail).toBeNull();
    expect(result.current.newsletterActionType).toBeNull();
    expect(typeof result.current.setUnsubscribeMsg).toBe('function');
    expect(typeof result.current.upsertNewsletterSubscriber).toBe('function');
  });

  it('setUnsubscribeMsg updates the message', () => {
    const { result } = renderHook(() => useNewsletterState());

    act(() => {
      result.current.setUnsubscribeMsg('Test message');
    });

    expect(result.current.unsubscribeMsg).toBe('Test message');
  });

  describe('upsertNewsletterSubscriber', () => {
    it('creates new subscriber when none exists', async () => {
      mockGetDocs.mockResolvedValueOnce({ empty: true, docs: [] });
      mockAddDoc.mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => useNewsletterState());

      let ok: boolean;
      await act(async () => {
        ok = await result.current.upsertNewsletterSubscriber('Test@Example.com', 'signup', 'Test User');
      });

      expect(ok!).toBe(true);
      expect(mockAddDoc).toHaveBeenCalledTimes(1);
      // Verify email was normalized
      const addDocCall = mockAddDoc.mock.calls[0];
      expect(addDocCall[1].email).toBe('test@example.com');
      expect(addDocCall[1].source).toBe('signup');
      expect(addDocCall[1].name).toBe('Test User');
      expect(addDocCall[1].isActive).toBe(true);
      expect(localStorage.getItem('newsletter_subscribed')).toBe('true');
    });

    it('updates existing subscriber', async () => {
      const mockDocRef = { id: 'doc1' };
      mockGetDocs.mockResolvedValueOnce({
        empty: false,
        docs: [{ ref: mockDocRef }],
      });

      const { result } = renderHook(() => useNewsletterState());

      let ok: boolean;
      await act(async () => {
        ok = await result.current.upsertNewsletterSubscriber('existing@test.com', 'chatbot_google');
      });

      expect(ok!).toBe(true);
      expect(mockUpdateDoc).toHaveBeenCalledWith(mockDocRef, expect.objectContaining({
        isActive: true,
        source: 'chatbot_google',
      }));
      expect(mockAddDoc).not.toHaveBeenCalled();
    });

    it('returns false for empty email', async () => {
      const { result } = renderHook(() => useNewsletterState());

      let ok: boolean;
      await act(async () => {
        ok = await result.current.upsertNewsletterSubscriber('  ', 'signup');
      });

      expect(ok!).toBe(false);
      expect(mockAddDoc).not.toHaveBeenCalled();
    });

    it('returns false on firestore error', async () => {
      mockGetDocs.mockRejectedValueOnce(new Error('Firestore error'));

      const { result } = renderHook(() => useNewsletterState());

      let ok: boolean;
      await act(async () => {
        ok = await result.current.upsertNewsletterSubscriber('test@test.com', 'signup');
      });

      expect(ok!).toBe(false);
    });
  });
});
