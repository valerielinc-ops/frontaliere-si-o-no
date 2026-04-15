import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@/services/router', () => ({
  parsePath: vi.fn(() => ({
    route: { activeTab: 'calculator' as const },
    locale: 'it' as const,
  })),
  parseHashToPath: vi.fn(() => null),
  pushRoute: vi.fn(),
  replaceRoute: vi.fn(),
  getSeoSection: vi.fn(() => 'home'),
  updatePathForLocale: vi.fn(),
  scrollToAnchor: vi.fn(() => false),
  preloadBlogData: vi.fn(() => Promise.resolve()),
  resolveBlogSlug: vi.fn(() => null),
  getLocalizedJobSlug: vi.fn((slug: string) => slug),
}));

vi.mock('@/services/i18n', () => ({
  setLocale: vi.fn(),
  onLocaleChange: vi.fn(() => vi.fn()), // returns unsubscribe fn
}));

vi.mock('@/services/prefetch', () => ({
  prefetchTab: vi.fn(),
}));

vi.mock('@/hooks/seoHelpers', () => ({
  enableRuntimeSeo: vi.fn(),
  updateMetaTags: vi.fn(),
  trackSectionView: vi.fn(),
}));

vi.mock('@/services/seoService', () => ({
  applyNotFoundSeo: vi.fn(),
}));

vi.mock('@/services/analyticsProxy', () => ({
  Analytics: {
    trackTabNavigation: vi.fn(),
    trackFunnelStep: vi.fn(),
  },
  unlockAchievement: vi.fn(),
}));

import { useNavigationState } from '@/hooks/useNavigationState';
import { pushRoute } from '@/services/router';
import { prefetchTab } from '@/services/prefetch';
import { updateMetaTags, trackSectionView } from '@/hooks/seoHelpers';
import { Analytics, unlockAchievement } from '@/services/analyticsProxy';

describe('useNavigationState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
  });

  it('initializes from parsePath result', () => {
    const { result } = renderHook(() => useNavigationState());

    expect(result.current.activeTab).toBe('calculator');
    expect(result.current.calcolatoreSubTab).toBe('calculator');
    expect(result.current.confrontiSubTab).toBe('exchange');
    expect(result.current.fiscoSubTab).toBe('tax-return');
    expect(result.current.guidaSubTab).toBe('first-day');
    expect(result.current.vitaSubTab).toBe('living-ch');
    expect(result.current.statsSubTab).toBe('overview');
  });

  it('deep-link state starts as null', () => {
    const { result } = renderHook(() => useNavigationState());

    expect(result.current.blogArticle).toBeNull();
    expect(result.current.seoLanding).toBeNull();
    expect(result.current.glossaryTerm).toBeNull();
    expect(result.current.borderCrossing).toBeNull();
    expect(result.current.jobSlug).toBeNull();
    expect(result.current.showApiStatus).toBe(false);
  });

  it('prefetches active tab on mount', () => {
    renderHook(() => useNavigationState());
    expect(prefetchTab).toHaveBeenCalledWith('calculator');
  });

  it('exports all required setters and handlers', () => {
    const { result } = renderHook(() => useNavigationState());

    // Setters
    expect(typeof result.current.setActiveTab).toBe('function');
    expect(typeof result.current.setCalcolatoreSubTab).toBe('function');
    expect(typeof result.current.setConfrontiSubTab).toBe('function');
    expect(typeof result.current.setFiscoSubTab).toBe('function');
    expect(typeof result.current.setGuidaSubTab).toBe('function');
    expect(typeof result.current.setVitaSubTab).toBe('function');
    expect(typeof result.current.setStatsSubTab).toBe('function');
    expect(typeof result.current.setBlogArticle).toBe('function');
    expect(typeof result.current.setSeoLanding).toBe('function');
    expect(typeof result.current.setGlossaryTerm).toBe('function');
    expect(typeof result.current.setBorderCrossing).toBe('function');
    expect(typeof result.current.setJobSlug).toBe('function');
    expect(typeof result.current.setTaxReturnCountry).toBe('function');
    expect(typeof result.current.setShowApiStatus).toBe('function');

    // Handlers
    expect(typeof result.current.handleTabChange).toBe('function');
    expect(typeof result.current.handleSearchNavigate).toBe('function');

    // Refs
    expect(result.current.suppressNextRouteSyncForTabRef).toBeDefined();
    expect(result.current.suppressNextRouteSyncForTabRef.current).toBeNull();
  });

  describe('handleTabChange', () => {
    it('updates activeTab and pushes route', () => {
      const { result } = renderHook(() => useNavigationState());

      act(() => {
        result.current.handleTabChange('confronti');
      });

      expect(result.current.activeTab).toBe('confronti');
      expect(Analytics.trackTabNavigation).toHaveBeenCalledWith('calculator', 'confronti');
      expect(pushRoute).toHaveBeenCalled();
      expect(updateMetaTags).toHaveBeenCalled();
      expect(trackSectionView).toHaveBeenCalled();
    });

    it('tracks funnel step for confronti tab', () => {
      const { result } = renderHook(() => useNavigationState());

      act(() => {
        result.current.handleTabChange('confronti');
      });

      expect(Analytics.trackFunnelStep).toHaveBeenCalledWith('compare', { from_tab: 'calculator' });
    });

    it('unlocks achievements for specific tabs', () => {
      const { result } = renderHook(() => useNavigationState());

      act(() => { result.current.handleTabChange('guida'); });
      expect(unlockAchievement).toHaveBeenCalledWith('guide_reader');

      act(() => { result.current.handleTabChange('stats'); });
      expect(unlockAchievement).toHaveBeenCalledWith('stats_checker');

      act(() => { result.current.handleTabChange('fisco'); });
      expect(unlockAchievement).toHaveBeenCalledWith('pension_planner');
    });

    it('clears seoLanding when navigating away from calculator', () => {
      const { result } = renderHook(() => useNavigationState());

      // Set a seoLanding value
      act(() => { result.current.setSeoLanding('salary-60000' as any); });

      // Navigate away
      act(() => { result.current.handleTabChange('confronti'); });

      expect(result.current.seoLanding).toBeNull();
    });
  });

  describe('handleSearchNavigate', () => {
    it('navigates to tab with subTab', () => {
      const { result } = renderHook(() => useNavigationState());

      act(() => {
        result.current.handleSearchNavigate('confronti', 'health');
      });

      expect(result.current.activeTab).toBe('confronti');
      expect(result.current.confrontiSubTab).toBe('health');
      expect(pushRoute).toHaveBeenCalled();
    });

    it('sets suppressNextRouteSyncForTabRef then clears it in sub-tab effect', () => {
      const { result } = renderHook(() => useNavigationState());

      act(() => {
        result.current.handleSearchNavigate('fisco', 'pension');
      });

      // The ref is set to 'fisco' by handleSearchNavigate, then the fisco
      // sub-tab effect fires and clears it to null. That's correct behavior:
      // the ref prevents the sub-tab effect from pushing a duplicate route.
      expect(result.current.suppressNextRouteSyncForTabRef.current).toBeNull();
      expect(result.current.fiscoSubTab).toBe('pension');
    });
  });

  describe('state setters', () => {
    it('setActiveTab updates state', () => {
      const { result } = renderHook(() => useNavigationState());

      act(() => { result.current.setActiveTab('blog'); });
      expect(result.current.activeTab).toBe('blog');
    });

    it('setBlogArticle updates state', () => {
      const { result } = renderHook(() => useNavigationState());

      act(() => { result.current.setBlogArticle('test-article' as any); });
      expect(result.current.blogArticle).toBe('test-article');
    });

    it('setJobSlug updates state', () => {
      const { result } = renderHook(() => useNavigationState());

      act(() => { result.current.setJobSlug('some-job-slug'); });
      expect(result.current.jobSlug).toBe('some-job-slug');
    });
  });
});
