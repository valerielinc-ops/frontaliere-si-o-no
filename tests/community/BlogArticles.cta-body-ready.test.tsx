import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const fixture = vi.hoisted(() => ({
  id: 'fixture-lazy-body-cta',
  locale: 'it',
  translations: {} as Record<string, string>,
  loadBody: vi.fn(),
}));

vi.mock('@/data/blog-articles-data', () => ({
  ARTICLES: [{
    id: fixture.id, category: 'pratico', date: '',
    image: '/images/blog/fixture-lazy-body-cta.webp', hasCalculator: false,
  }],
}));

vi.mock('@/services/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/i18n')>()),
  getLocale: () => fixture.locale,
  useLocale: () => [fixture.locale],
  // Body chunks populate the store without replacing the translator function.
  useTranslation: () => ({ t: translate }),
  loadBlogMeta: vi.fn(async () => {}),
  loadArticleBody: fixture.loadBody,
}));
vi.mock('@/services/router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/router')>()),
  preloadBlogData: vi.fn(async () => {}),
}));
vi.mock('@/services/authorProfileService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/authorProfileService')>()),
  getArticleAuthorOverride: vi.fn(async () => null),
}));
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));
vi.mock('@/components/shared/AdSenseBanner', () => ({ default: () => null }));
vi.mock('@/components/shared/ArticleRailAdStack', () => ({ default: () => null }));
vi.mock('@/components/shared/GptPocSlot', () => ({ default: () => null }));
vi.mock('@/components/shared/LeadMagnetCTA', () => ({ default: () => null }));
vi.mock('@/components/shared/PreferredSourceCTA', () => ({ default: () => null }));
vi.mock('@/components/community/PreferredSourcePopup', () => ({ default: () => null }));
vi.mock('@/components/calculator/ConsultingCTA', () => ({ ConsultingCTA: () => null }));

import BlogArticles from '@/components/community/BlogArticles';
import NavigationContext, { type NavigationContextType } from '@/services/NavigationContext';

function translate(key: string): string {
  return fixture.translations[key] ?? key;
}

beforeEach(() => {
  fixture.translations = {
    [`blog.article.${fixture.id}.title`]: 'Aggiornamento / Update / Aktuelles / Actualités',
    [`blog.article.${fixture.id}.excerpt`]: 'Informazioni / Information / Informationen / Informations',
  };
  fixture.loadBody.mockReset();
  sessionStorage.setItem(`viewed_${fixture.id}`, '1');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('article CTAs after asynchronous body loading', () => {
  it.each([
    ['it', 'Il tasso di cambio aiuta a confrontare le valute.', '/compara-servizi/cambio-franco-euro/'],
    ['en', 'The exchange rate helps compare currencies.', '/en/service-comparison/chf-eur-exchange-rate/'],
    ['de', 'Der Wechselkurs hilft beim Vergleich von Währungen.', '/de/service-vergleich/chf-eur-wechselkurs/'],
    ['fr', 'Le taux de change aide à comparer les devises.', '/fr/comparaison-services/taux-change-chf-eur/'],
  ])('uses the newly loaded %s body to select a localized CTA', async (locale, body, href) => {
    fixture.locale = locale;
    let finishLoading!: () => void;
    const pendingBody = new Promise<void>((resolve) => { finishLoading = resolve; });
    fixture.loadBody.mockReturnValue(pendingBody);
    const nav = { navigateTo: vi.fn() } as unknown as NavigationContextType;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NavigationContext.Provider value={nav}>{children}</NavigationContext.Provider>
    );
    const { container } = render(
      <BlogArticles selectedArticle={fixture.id as never} section="frontaliere" />,
      { wrapper },
    );
    await waitFor(() => expect(fixture.loadBody).toHaveBeenCalled());
    // Flush metadata/registry work while the body request is still pending.
    await act(async () => {});
    expect(container.querySelector('a.mt-3')).toBeNull();

    await act(async () => {
      fixture.translations[`blog.article.${fixture.id}.body1`] = body;
      finishLoading();
      await pendingBody;
    });
    await waitFor(() => expect(container.textContent).toContain(body));
    const ctas = [...container.querySelectorAll<HTMLAnchorElement>('a.mt-3')];
    expect(ctas.map((link) => link.getAttribute('href'))).toEqual([href]);
  });
});
