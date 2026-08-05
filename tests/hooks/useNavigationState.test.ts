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
  preloadSwissData: vi.fn(() => Promise.resolve()),
  resolveSwissSlug: vi.fn(() => null),
  learnRuntimeBlogSlugs: vi.fn(),
  learnRuntimeSwissSlugs: vi.fn(),
}));

// Dynamically imported by the hook, so the mock has to be registered here.
vi.mock('@/services/runtimeArticleResolution', () => ({
  adoptRuntimeArticle: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@/services/i18n', () => ({
  setLocale: vi.fn(),
  onLocaleChange: vi.fn(() => vi.fn()), // returns unsubscribe fn
  getCantonI18nParams: () => ({} as Record<string, string>),
}));

vi.mock('@/services/prefetch', () => ({
  prefetchTab: vi.fn(),
}));

vi.mock('@/hooks/seoHelpers', () => ({
  enableRuntimeSeo: vi.fn(),
  updateMetaTags: vi.fn(),
  trackSectionView: vi.fn(),
}));

// seoService is mocked globally in tests/setup.tsx (includes applyNotFoundSeo).
// No local override needed — setup.tsx mock is sufficient.

vi.mock('@/services/analyticsProxy', () => ({
  Analytics: {
    trackTabNavigation: vi.fn(),
    trackFunnelStep: vi.fn(),
  },
  unlockAchievement: vi.fn(),
}));

import { useNavigationState } from '@/hooks/useNavigationState';
import { pushRoute, parseHashToPath, parsePath, resolveBlogSlug, learnRuntimeBlogSlugs } from '@/services/router';
import { adoptRuntimeArticle } from '@/services/runtimeArticleResolution';
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

  // Regression: legacy-redirect useEffect must not drop ?ne=…&ac=… autologin
  // params when canonicalizing legacy paths on mount. See commit 315e2ac0e.
  describe('legacy-redirect query string preservation', () => {
    const AUTOLOGIN_SEARCH = '?ne=user%40example.com&ac=deadbeef&utm_medium=newsletter';

    it('preserves search when rewriting /calculator → /', () => {
      window.history.replaceState({}, '', '/calculator' + AUTOLOGIN_SEARCH);
      renderHook(() => useNavigationState());
      expect(window.location.pathname).toBe('/');
      expect(window.location.search).toBe(AUTOLOGIN_SEARCH);
    });

    it('preserves search when rewriting /stats → /statistiche', () => {
      window.history.replaceState({}, '', '/stats' + AUTOLOGIN_SEARCH);
      renderHook(() => useNavigationState());
      expect(window.location.pathname).toBe('/statistiche');
      expect(window.location.search).toBe(AUTOLOGIN_SEARCH);
    });

    it('preserves search when rewriting /guide → /guida-frontaliere', () => {
      window.history.replaceState({}, '', '/guide' + AUTOLOGIN_SEARCH);
      renderHook(() => useNavigationState());
      expect(window.location.pathname).toBe('/guida-frontaliere');
      expect(window.location.search).toBe(AUTOLOGIN_SEARCH);
    });

    it('preserves search when rewriting locale calc-home slug /calcola-stipendio → /', () => {
      window.history.replaceState({}, '', '/calcola-stipendio' + AUTOLOGIN_SEARCH);
      renderHook(() => useNavigationState());
      expect(window.location.pathname).toBe('/');
      expect(window.location.search).toBe(AUTOLOGIN_SEARCH);
    });

    it('preserves search when migrating legacy hash URL', () => {
      vi.mocked(parseHashToPath).mockReturnValueOnce('/compara-servizi/cambio-franco-euro');
      window.history.replaceState({}, '', '/' + AUTOLOGIN_SEARCH + '#/comparatori/cambio-valuta');
      renderHook(() => useNavigationState());
      expect(window.location.pathname).toBe('/compara-servizi/cambio-franco-euro');
      expect(window.location.search).toBe(AUTOLOGIN_SEARCH);
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

  // Issue #4974 item 3. An article published after the last deploy is missing
  // from the compiled slug map, so parsePath hands back `blogSlug` and never
  // `blogArticle`. The SPA then rendered the hub list over a correct article
  // page — measured 2026-08-04 on 17 live URLs, h1 going from the article
  // title to "Guida Frontaliere" on hydration.
  describe('unresolved article slug', () => {
    const STATIC_ARTICLE = '<div id="root"></div>'
      + '<main class="seo-static-content"><article class="ft-blog-article">'
      + '<h1>Poste Italiane cerca consulenti finanziari in Varese</h1>'
      + '<section><h2>Contesto</h2><p>Testo.</p></section>'
      + '</article></main>';

    const pendingArticleRoute = () => {
      vi.mocked(parsePath).mockReturnValue({
        route: { activeTab: 'blog' as const, blogSlug: 'poste-italiane-consulenti-finanziari-varese' },
        locale: 'it' as const,
      } as never);
    };

    beforeEach(() => {
      document.body.innerHTML = STATIC_ARTICLE;
      pendingArticleRoute();
      vi.mocked(resolveBlogSlug).mockReturnValue(null as never);
    });

    afterEach(() => {
      document.body.innerHTML = '';
      vi.mocked(parsePath).mockReturnValue({
        route: { activeTab: 'calculator' as const },
        locale: 'it' as const,
      } as never);
    });

    it('hands the page to the static article instead of the hub list, from the first frame', () => {
      const { result } = renderHook(() => useNavigationState());
      // staticOverlay is what makes App.tsx skip its own <main> and leave the
      // shard's article visible. It must be true synchronously — a value set
      // only after the async resolution would still flash the hub list.
      expect(result.current.staticOverlay).toBe(true);
      expect(result.current.blogArticle).toBeNull();
    });

    it('does not stamp the hub\'s SEO over the article\'s own head', () => {
      renderHook(() => useNavigationState());
      expect(updateMetaTags).not.toHaveBeenCalled();
      expect(trackSectionView).not.toHaveBeenCalled();
    });

    it('stays on the static article when the corpus API cannot resolve the slug', async () => {
      vi.mocked(adoptRuntimeArticle).mockResolvedValue(null);
      const { result } = renderHook(() => useNavigationState());
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(result.current.staticOverlay).toBe(true);
      expect(result.current.blogArticle).toBeNull();
    });

    it('stays on the static article when the corpus API throws', async () => {
      vi.mocked(adoptRuntimeArticle).mockRejectedValue(new Error('offline'));
      const { result } = renderHook(() => useNavigationState());
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(result.current.staticOverlay).toBe(true);
      expect(result.current.blogArticle).toBeNull();
    });

    it('stays on the static article when the id resolves but the page cannot be drawn', async () => {
      vi.mocked(adoptRuntimeArticle).mockResolvedValue({
        id: 'poste-italiane-consulenti-finanziari-varese',
        slugs: { it: 'poste-italiane-consulenti-finanziari-varese' },
        renderable: false,
      });
      const { result } = renderHook(() => useNavigationState());
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(result.current.staticOverlay).toBe(true);
      expect(result.current.blogArticle).toBeNull();
      // The pair is still learned: canonical URLs and the language switcher
      // point at the real article even when the SPA does not render it.
      expect(learnRuntimeBlogSlugs).toHaveBeenCalledWith(
        'poste-italiane-consulenti-finanziari-varese',
        { it: 'poste-italiane-consulenti-finanziari-varese' },
      );
    });

    it('takes over only once the article is fully resolved', async () => {
      vi.mocked(adoptRuntimeArticle).mockResolvedValue({
        id: 'poste-italiane-consulenti-finanziari-varese',
        slugs: { it: 'poste-italiane-consulenti-finanziari-varese' },
        renderable: true,
      });
      const { result } = renderHook(() => useNavigationState());
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(result.current.blogArticle).toBe('poste-italiane-consulenti-finanziari-varese');
      expect(result.current.staticOverlay).toBe(false);
    });

    it('never reaches the network for an article this build already ships', async () => {
      vi.mocked(resolveBlogSlug).mockReturnValue('poste-italiane-consulenti-finanziari-varese' as never);
      const { result } = renderHook(() => useNavigationState());
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(result.current.blogArticle).toBe('poste-italiane-consulenti-finanziari-varese');
      expect(result.current.staticOverlay).toBe(false);
      expect(adoptRuntimeArticle).not.toHaveBeenCalled();
    });

    it('does not blank the page when there is no static article to fall back to', async () => {
      // No `main.seo-static-content` — a client-side arrival, or a URL the
      // shard never emitted. Overlay mode here would show nothing at all.
      document.body.innerHTML = '<div id="root"></div>';
      vi.mocked(adoptRuntimeArticle).mockResolvedValue(null);
      const { result } = renderHook(() => useNavigationState());
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(result.current.staticOverlay).toBe(false);
    });
  });
});
