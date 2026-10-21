import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const fixture = vi.hoisted(() => ({
  id: 'fixture-lazy-body-cta',
  nextId: 'fixture-lazy-body-next',
  absentId: 'fixture-lazy-body-missing-registry',
  locale: 'it',
  translations: {} as Record<string, string>,
  loadBody: vi.fn(),
  fetchOverlay: vi.fn(),
  resilientImport: vi.fn(),
}));

vi.mock('@/data/blog-articles-data', () => ({
  ARTICLES: [fixture.id, fixture.nextId].map((id) => ({
    id, category: 'pratico', date: '',
    image: '/images/blog/fixture-lazy-body-cta.webp', hasCalculator: false,
  })),
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
vi.mock('@/services/articlesOverlay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/articlesOverlay')>()),
  fetchArticleOverlay: fixture.fetchOverlay,
}));
vi.mock('@/services/resilientImport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/resilientImport')>()),
  resilientImport: fixture.resilientImport,
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
    [`blog.article.${fixture.nextId}.title`]: 'Titolo successivo non verificato',
    [`blog.article.${fixture.nextId}.excerpt`]: 'Estratto successivo non verificato',
  };
  fixture.loadBody.mockReset();
  fixture.fetchOverlay.mockReset().mockResolvedValue([]);
  fixture.resilientImport.mockReset().mockImplementation((factory: () => Promise<unknown>) => factory());
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
  it('does not paint the previous article title or body while a new identity is loading', async () => {
    fixture.loadBody
      .mockImplementationOnce(async () => {
        fixture.translations[`blog.article.${fixture.id}.body1`] = 'Corpo del primo articolo.';
        fixture.translations[`blog.article.${fixture.id}.body2`] = 'Secondo paragrafo del primo articolo.';
        fixture.translations[`blog.article.${fixture.id}.body3`] = 'Terzo paragrafo del primo articolo.';
        return { status: 'loaded' };
      })
      .mockReturnValueOnce(new Promise(() => {}));
    const nav = { navigateTo: vi.fn() } as unknown as NavigationContextType;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NavigationContext.Provider value={nav}>{children}</NavigationContext.Provider>
    );
    const view = render(
      <BlogArticles selectedArticle={fixture.id as never} section="frontaliere" />,
      { wrapper },
    );

    await waitFor(() => expect(view.container.textContent).toContain('Corpo del primo articolo.'));
    view.rerender(<BlogArticles selectedArticle={fixture.nextId as never} section="frontaliere" />);

    expect(view.container.textContent).not.toContain('Corpo del primo articolo.');
    expect(view.container.textContent).not.toContain('Aggiornamento / Update / Aktuelles / Actualités');
    expect(view.container.textContent).not.toContain('Titolo successivo non verificato');
  });

  it('releases a deferred static snapshot to an accessible retry state after authoritative API failure', async () => {
    fixture.translations[`blog.article.${fixture.id}.title`] = 'Titolo compilato obsoleto';
    fixture.loadBody.mockResolvedValue({
      status: 'error', reason: 'network', authoritative: true,
    });
    const nav = { navigateTo: vi.fn() } as unknown as NavigationContextType;
    const onArticleReady = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NavigationContext.Provider value={nav}>{children}</NavigationContext.Provider>
    );
    const { container, getByRole } = render(
      <BlogArticles
        selectedArticle={fixture.id as never}
        section="frontaliere"
        articleReadyKey="fixture-static-owner"
        onArticleReady={onArticleReady}
        deferUntilArticleReady
      />,
      { wrapper },
    );

    await waitFor(() => expect(container.textContent).toContain('Non è stato possibile caricare il testo.'));
    expect(getByRole('alert').textContent).toContain('Non è stato possibile caricare il testo.');
    expect(getByRole('button', { name: 'Riprova' })).toBeTruthy();
    expect(onArticleReady).toHaveBeenCalledWith('fixture-static-owner');
    expect(container.textContent).not.toContain('Titolo compilato obsoleto');
  });

  it('retries registry and body lookup when a loaded body has no registry record', async () => {
    fixture.translations[`blog.article.${fixture.absentId}.title`] = 'Articolo recuperato dal registry';
    fixture.translations[`blog.article.${fixture.absentId}.body1`] = 'Testo recuperato dopo il retry.';
    fixture.loadBody
      .mockResolvedValueOnce({ status: 'loaded' })
      .mockResolvedValueOnce({ status: 'loaded' });
    fixture.fetchOverlay
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: fixture.absentId,
        title: 'Articolo recuperato dal registry',
        image: '/images/blog/fixture-lazy-body-cta.webp',
      }]);
    const nav = { navigateTo: vi.fn() } as unknown as NavigationContextType;
    const onArticleReady = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NavigationContext.Provider value={nav}>{children}</NavigationContext.Provider>
    );
    const { container, getByRole } = render(
      <BlogArticles
        selectedArticle={fixture.absentId as never}
        section="frontaliere"
        articleReadyKey="fixture-missing-registry"
        onArticleReady={onArticleReady}
        deferUntilArticleReady
      />,
      { wrapper },
    );

    expect(getByRole('status').getAttribute('aria-busy')).toBe('true');
    await waitFor(() => expect(fixture.loadBody).toHaveBeenCalled());
    expect(onArticleReady).toHaveBeenCalledWith('fixture-missing-registry');
    await waitFor(() => expect(getByRole('alert').textContent).toContain('Non è stato possibile trovare questo articolo nell’indice aggiornato.'));
    expect(fixture.fetchOverlay).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('Titolo successivo non verificato');

    fireEvent.click(getByRole('button', { name: 'Riprova' }));
    await waitFor(() => expect(container.textContent).toContain('Testo recuperato dopo il retry.'));
    expect(fixture.fetchOverlay).toHaveBeenCalledTimes(2);
    expect(fixture.loadBody).toHaveBeenCalledTimes(2);
  });

  it('shows retry when the Swiss registry bootstrap rejects, then recovers on the next attempt', async () => {
    fixture.translations[`blog.article.${fixture.absentId}.title`] = 'Articolo recuperato dal registry';
    fixture.translations[`blog.article.${fixture.absentId}.body1`] = 'Testo recuperato dopo il bootstrap.';
    fixture.resilientImport
      .mockRejectedValueOnce(new Error('Swiss registry unavailable'))
      .mockResolvedValueOnce({ SWISS_ARTICLES: [] });
    fixture.fetchOverlay.mockResolvedValueOnce([{
      id: fixture.absentId,
      title: 'Articolo recuperato dal registry',
      image: '/images/blog/fixture-lazy-body-cta.webp',
    }]);
    fixture.loadBody
      .mockResolvedValueOnce({ status: 'loaded' })
      .mockResolvedValueOnce({ status: 'loaded' });
    const nav = { navigateTo: vi.fn() } as unknown as NavigationContextType;
    const onArticleReady = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NavigationContext.Provider value={nav}>{children}</NavigationContext.Provider>
    );
    const { container, getByRole } = render(
      <BlogArticles
        selectedArticle={fixture.absentId as never}
        section="svizzera"
        articleReadyKey="fixture-swiss-registry"
        onArticleReady={onArticleReady}
        deferUntilArticleReady
      />,
      { wrapper },
    );

    await waitFor(() => expect(getByRole('alert').textContent).toContain('Non è stato possibile trovare questo articolo nell’indice aggiornato.'));
    expect(fixture.resilientImport).toHaveBeenCalledTimes(1);
    expect(onArticleReady).toHaveBeenCalledWith('fixture-swiss-registry');

    fireEvent.click(getByRole('button', { name: 'Riprova' }));
    await waitFor(() => expect(container.textContent).toContain('Testo recuperato dopo il bootstrap.'));
    expect(fixture.resilientImport).toHaveBeenCalledTimes(2);
    expect(fixture.fetchOverlay).toHaveBeenCalledTimes(1);
  });

  it('ignores an older registry response after the selected section changes', async () => {
    fixture.translations[`blog.article.${fixture.absentId}.title`] = 'Titolo da registry precedente';
    fixture.translations[`blog.article.${fixture.absentId}.body1`] = 'Body da registry precedente';
    fixture.loadBody.mockResolvedValue({ status: 'loaded' });
    fixture.resilientImport.mockResolvedValue({ SWISS_ARTICLES: [] });
    let finishOldOverlay!: (articles: Array<{ id: string; title: string; image: string }>) => void;
    const oldOverlay = new Promise<Array<{ id: string; title: string; image: string }>>((resolve) => {
      finishOldOverlay = resolve;
    });
    fixture.fetchOverlay
      .mockReturnValueOnce(oldOverlay)
      .mockResolvedValueOnce([]);
    const nav = { navigateTo: vi.fn() } as unknown as NavigationContextType;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NavigationContext.Provider value={nav}>{children}</NavigationContext.Provider>
    );
    const view = render(
      <BlogArticles selectedArticle={fixture.absentId as never} section="frontaliere" />,
      { wrapper },
    );

    await waitFor(() => expect(fixture.fetchOverlay).toHaveBeenCalledTimes(1));
    view.rerender(<BlogArticles selectedArticle={fixture.absentId as never} section="svizzera" />);
    await waitFor(() => expect(fixture.fetchOverlay).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('Non è stato possibile trovare questo articolo nell’indice aggiornato.'));

    await act(async () => {
      finishOldOverlay([{
        id: fixture.absentId,
        title: 'Titolo da registry precedente',
        image: '/images/blog/fixture-lazy-body-cta.webp',
      }]);
    });
    await act(async () => {});
    expect(view.getByRole('alert').textContent).toContain('Non è stato possibile trovare questo articolo nell’indice aggiornato.');
    expect(view.container.textContent).not.toContain('Body da registry precedente');
  });

  it('shows a localized retry state instead of compiled text after an API failure', async () => {
    fixture.translations[`blog.article.${fixture.id}.body1`] = 'Corpo compilato non aggiornato.';
    fixture.translations[`blog.article.${fixture.id}.body2`] = 'Secondo paragrafo compilato.';
    fixture.translations[`blog.article.${fixture.id}.body3`] = 'Terzo paragrafo compilato.';
    fixture.loadBody
      .mockResolvedValueOnce({ status: 'error', reason: 'network' })
      .mockImplementationOnce(async () => {
        fixture.translations[`blog.article.${fixture.id}.body1`] = 'Testo API aggiornato.';
        return { status: 'loaded' };
      });
    const nav = { navigateTo: vi.fn() } as unknown as NavigationContextType;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NavigationContext.Provider value={nav}>{children}</NavigationContext.Provider>
    );
    const { container, getByRole } = render(
      <BlogArticles selectedArticle={fixture.id as never} section="frontaliere" />,
      { wrapper },
    );

    await waitFor(() => expect(container.textContent).toContain('Non è stato possibile caricare il testo.'));
    expect(container.textContent).not.toContain('Corpo compilato non aggiornato.');

    fireEvent.click(getByRole('button', { name: 'Riprova' }));
    await waitFor(() => expect(container.textContent).toContain('Testo API aggiornato.'));
    expect(fixture.loadBody).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['it', 'Il tasso di cambio aiuta a confrontare le valute.', '/compara-servizi/cambio-franco-euro/'],
    ['en', 'The exchange rate helps compare currencies.', '/en/service-comparison/chf-eur-exchange-rate/'],
    ['de', 'Der Wechselkurs hilft beim Vergleich von Währungen.', '/de/service-vergleich/chf-eur-wechselkurs/'],
    ['fr', 'Le taux de change aide à comparer les devises.', '/fr/comparaison-services/taux-change-chf-eur/'],
  ])('uses the newly loaded %s body to select a localized CTA', async (locale, body, href) => {
    fixture.locale = locale;
    let finishLoading!: () => void;
    const pendingBody = new Promise<{ status: 'loaded' }>((resolve) => {
      finishLoading = () => resolve({ status: 'loaded' });
    });
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
