import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@/services/authService', () => ({
  useAuth: () => ({
    user: null,
    loading: false,
    signIn: vi.fn(() => Promise.resolve(null)),
    signInFacebook: vi.fn(() => Promise.resolve(null)),
    signInEmail: vi.fn(() => Promise.resolve(null)),
  }),
  getAuthEmail: vi.fn((user: any) => user?.email || null),
  promptOneTap: vi.fn(),
  cancelOneTap: vi.fn(),
  getUserPhotoURL: vi.fn(() => null),
  getUserDisplayName: vi.fn(() => ''),
}));

vi.mock('@/services/errorReporter', () => ({
  reportCaughtError: vi.fn(),
}));

vi.mock('@/services/analyticsProxy', () => ({
  Analytics: {
    trackNewsletter: vi.fn(),
    trackUIInteraction: vi.fn(),
  },
  unlockAchievement: vi.fn(),
}));

vi.mock('@/components/pages/UserProfile', () => ({
  loadUserProfile: vi.fn(() => ({
    familySituation: '',
    children: '0',
    age: '',
    frontaliereType: '',
  })),
  profileToSimInputs: vi.fn(() => ({})),
}));

import { useUserState } from '@/hooks/useUserState';
import { Analytics, unlockAchievement } from '@/services/analyticsProxy';
import type { SimulationInputs } from '@/types';

describe('useUserState', () => {
  const mockUpsertNewsletter = vi.fn(() => Promise.resolve(true));
  const mockSetInputs = vi.fn();
  const mockUrlHydrated = { current: false };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    mockUrlHydrated.current = false;
  });

  const renderUserState = () =>
    renderHook(() =>
      useUserState(mockUpsertNewsletter, mockSetInputs, mockUrlHydrated),
    );

  it('returns correct initial state', () => {
    const { result } = renderUserState();

    expect(result.current.authUser).toBeNull();
    expect(result.current.authLoading).toBe(false);
    expect(result.current.authEmail).toBeNull();
    expect(result.current.isPrivilegedAdmin).toBe(false);
    expect(result.current.userProfile).toBeNull();
    expect(result.current.contactPrefill).toBeNull();
  });

  it('exports all required functions', () => {
    const { result } = renderUserState();

    expect(typeof result.current.googleSignIn).toBe('function');
    expect(typeof result.current.facebookSignIn).toBe('function');
    expect(typeof result.current.signInEmail).toBe('function');
    expect(typeof result.current.chatbotGoogleSignIn).toBe('function');
    expect(typeof result.current.chatbotFacebookSignIn).toBe('function');
    expect(typeof result.current.chatbotContinueWithEmail).toBe('function');
    expect(typeof result.current.setUserProfile).toBe('function');
    expect(typeof result.current.setContactPrefill).toBe('function');
  });

  describe('chatbotContinueWithEmail', () => {
    it('subscribes to newsletter and tracks analytics on success', async () => {
      mockUpsertNewsletter.mockResolvedValueOnce(true);
      const { result } = renderUserState();

      let ok: boolean;
      await act(async () => {
        ok = await result.current.chatbotContinueWithEmail('test@example.com');
      });

      expect(ok!).toBe(true);
      expect(mockUpsertNewsletter).toHaveBeenCalledWith('test@example.com', 'chatbot_email', null);
      expect(Analytics.trackNewsletter).toHaveBeenCalledWith('subscribe', 'example.com');
      expect(unlockAchievement).toHaveBeenCalledWith('newsletter_sub');
    });

    it('tracks error on newsletter failure', async () => {
      mockUpsertNewsletter.mockResolvedValueOnce(false);
      const { result } = renderUserState();

      let ok: boolean;
      await act(async () => {
        ok = await result.current.chatbotContinueWithEmail('fail@test.com');
      });

      expect(ok!).toBe(false);
      expect(Analytics.trackUIInteraction).toHaveBeenCalledWith(
        'chatbot', 'auth_gate', 'newsletter_email_subscribe', 'error',
      );
    });
  });

  describe('setUserProfile / setContactPrefill', () => {
    it('updates userProfile state', () => {
      const { result } = renderUserState();

      const profile = { familySituation: 'MARRIED', children: '2', age: '35', frontaliereType: 'NEW' } as any;
      act(() => {
        result.current.setUserProfile(profile);
      });

      expect(result.current.userProfile).toEqual(profile);
    });

    it('updates contactPrefill state', () => {
      const { result } = renderUserState();

      const prefill = { name: 'Test', email: 'test@test.com' } as any;
      act(() => {
        result.current.setContactPrefill(prefill);
      });

      expect(result.current.contactPrefill).toEqual(prefill);
    });
  });
});
