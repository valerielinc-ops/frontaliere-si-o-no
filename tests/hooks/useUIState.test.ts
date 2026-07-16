import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    locale: 'it' as const,
  }),
  initLocale: vi.fn(),
  isTranslationsReady: () => true,
  itReady: Promise.resolve(),
  loadTabTranslations: vi.fn(() => Promise.resolve()),
  getCantonI18nParams: () => ({} as Record<string, string>),
}));

vi.mock('@/services/consentService', () => ({
  setDefaultConsent: vi.fn(),
  isAnalyticsGranted: vi.fn(() => false),
  onConsentChange: vi.fn(() => () => {}),
}));

vi.mock('@/services/analyticsProxy', () => ({
  Analytics: {
    init: vi.fn(),
    trackPageView: vi.fn(),
    trackSettingsChange: vi.fn(),
    trackFunnelStep: vi.fn(),
    initGlobalErrorTracking: vi.fn(),
  },
  unlockAchievement: vi.fn(),
  fireCalcEntryIfNeeded: vi.fn(),
}));

vi.mock('@/hooks/seoHelpers', () => ({
  enableRuntimeSeo: vi.fn(),
  updateMetaTags: vi.fn(),
  trackSectionView: vi.fn(),
}));

vi.mock('@/services/webVitals', () => ({
  initWebVitals: vi.fn(),
}));

vi.mock('@/services/clarity', () => ({
  initClarity: vi.fn(),
}));

import { useUIState } from '@/hooks/useUIState';
import { Analytics, unlockAchievement } from '@/services/analyticsProxy';

describe('useUIState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // Clean up both the property and the class
    delete (localStorage as any).theme;
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    cleanup();
    // Ensure dark mode state is reset after each test
    document.documentElement.classList.remove('dark');
    delete (localStorage as any).theme;
  });

  it('returns correct initial state', () => {
    const { result } = renderHook(() => useUIState('calculator'));

    expect(result.current.isDarkMode).toBe(false);
    expect(result.current.isFocusMode).toBe(false);
    expect(result.current.showDeferredHomeWidgets).toBe(false);
    expect(result.current.translationsReady).toBe(true); // isTranslationsReady mocked to true
    expect(typeof result.current.toggleTheme).toBe('function');
    expect(typeof result.current.setIsFocusMode).toBe('function');
  });

  it('initializes dark mode from localStorage', () => {
    // The hook reads localStorage.theme as a property (not getItem)
    (localStorage as any).theme = 'dark';

    const { result } = renderHook(() => useUIState('calculator'));

    expect(result.current.isDarkMode).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  describe('toggleTheme', () => {
    it('enables dark mode when currently light', () => {
      const { result } = renderHook(() => useUIState('calculator'));

      act(() => {
        result.current.toggleTheme();
      });

      expect(result.current.isDarkMode).toBe(true);
      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect((localStorage as any).theme).toBe('dark');
      expect(Analytics.trackSettingsChange).toHaveBeenCalledWith('theme', 'dark');
      expect(unlockAchievement).toHaveBeenCalledWith('dark_mode_fan');
    });

    it('disables dark mode when currently dark (functional setter)', () => {
      const { result } = renderHook(() => useUIState('calculator'));

      // Toggle to dark
      act(() => { result.current.toggleTheme(); });
      expect(result.current.isDarkMode).toBe(true);

      // Toggle back to light
      act(() => { result.current.toggleTheme(); });

      expect(result.current.isDarkMode).toBe(false);
      expect(document.documentElement.classList.contains('dark')).toBe(false);
      expect((localStorage as any).theme).toBe('light');
    });
  });

  it('setIsFocusMode updates focus mode state', () => {
    const { result } = renderHook(() => useUIState('calculator'));

    act(() => {
      result.current.setIsFocusMode(true);
    });

    expect(result.current.isFocusMode).toBe(true);
  });

  describe('history.pushState monkeypatch (issue #4304)', () => {
    const originalPushState = history.pushState;

    afterEach(() => {
      // Guard against a test leaving history.pushState patched if unmount failed.
      history.pushState = originalPushState;
    });

    it('does not throw on navigation when the pre-existing pushState is not a function at mount time', () => {
      // Simulates the live PostHog cluster: "Cannot read properties of
      // undefined (reading 'apply')". A stale/tampered `history.pushState`
      // (e.g. from an interleaved mount/unmount with useSeoPageTracking's own
      // history patch, or third-party tampering) means the closed-over
      // originalPushState captured at hook-mount time can be non-function —
      // the wrapper must degrade to a no-op instead of throwing.
      (history as unknown as { pushState: unknown }).pushState = undefined;

      const { unmount } = renderHook(() => useUIState('calculator'));
      vi.clearAllMocks();

      expect(() => {
        act(() => {
          history.pushState({}, '', '/premi-cassa-malati/ticino/');
        });
      }).not.toThrow();

      // The tracking side-effect still runs despite the missing original.
      expect(Analytics.trackPageView).toHaveBeenCalled();

      unmount();
    });
  });
});
