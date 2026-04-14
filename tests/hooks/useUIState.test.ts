import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    locale: 'it' as const,
  }),
  initLocale: vi.fn(),
  isTranslationsReady: () => true,
  itReady: Promise.resolve(),
  loadTabTranslations: vi.fn(() => Promise.resolve()),
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
}));

vi.mock('@/services/webVitals', () => ({
  initWebVitals: vi.fn(),
}));

import { useUIState } from '@/hooks/useUIState';
import { Analytics, unlockAchievement } from '@/services/analyticsProxy';

describe('useUIState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('returns correct initial state', () => {
    const { result } = renderHook(() => useUIState('calculator'));

    expect(result.current.isDarkMode).toBe(false);
    expect(result.current.isFocusMode).toBe(false);
    expect(result.current.showBlobs).toBe(false);
    expect(result.current.showDeferredHomeWidgets).toBe(false);
    expect(result.current.translationsReady).toBe(true); // isTranslationsReady mocked to true
    expect(typeof result.current.toggleTheme).toBe('function');
    expect(typeof result.current.setIsFocusMode).toBe('function');
  });

  it('initializes dark mode from localStorage', () => {
    localStorage.setItem('theme', 'dark');
    // Need to set localStorage.theme directly (our mock uses getItem/setItem)
    Object.defineProperty(localStorage, 'theme', { value: 'dark', writable: true, configurable: true });

    const { result } = renderHook(() => useUIState('calculator'));

    expect(result.current.isDarkMode).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    // Cleanup
    delete (localStorage as any).theme;
    document.documentElement.classList.remove('dark');
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

    it('disables dark mode when currently dark', () => {
      // Start in dark mode
      Object.defineProperty(localStorage, 'theme', { value: 'dark', writable: true, configurable: true });
      const { result } = renderHook(() => useUIState('calculator'));

      expect(result.current.isDarkMode).toBe(true);

      // Toggle back to light
      act(() => { result.current.toggleTheme(); });

      expect(result.current.isDarkMode).toBe(false);
      expect(document.documentElement.classList.contains('dark')).toBe(false);
      expect((localStorage as any).theme).toBe('light');

      // Cleanup
      delete (localStorage as any).theme;
    });
  });

  it('setIsFocusMode updates focus mode state', () => {
    const { result } = renderHook(() => useUIState('calculator'));

    act(() => {
      result.current.setIsFocusMode(true);
    });

    expect(result.current.isFocusMode).toBe(true);
  });
});
