import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const { article } = vi.hoisted(() => ({
  article: { id: 'source-date', date: '', title: { it: 'Articolo con data sconosciuta' }, slug: { it: 'source-date' } },
}));
vi.mock('@/data/news-ticker-data', () => ({ TICKER_ARTICLES: [article] }));
vi.mock('@/services/i18n', () => ({ useTranslation: () => ({ t: (key: string) => key, locale: 'it' }) }));
vi.mock('@/services/router', () => ({ buildPath: () => '/articoli-frontaliere/source-date/' }));
vi.mock('@/services/analytics', () => ({ Analytics: { trackUIInteraction: vi.fn(), trackSelectContent: vi.fn() } }));
import NewsFeed from '../components/community/NewsFeed';

afterEach(() => { article.date = ''; });

describe('news ticker source dates', () => {
  it.each(['', 'invalid'])('keeps the headline without inventing a date for %s', (date) => {
    article.date = date;
    const html = renderToStaticMarkup(<NewsFeed onNavigate={() => {}} />);
    expect(html).toContain('Articolo con data sconosciuta');
    expect(html).toContain('/articoli-frontaliere/source-date/');
    expect(html).not.toContain('Invalid Date');
    expect(html).not.toContain('mr-1.5');
  });

  it('renders a documented calendar date', () => {
    article.date = '2026-02-18';
    const html = renderToStaticMarkup(<NewsFeed onNavigate={() => {}} />);
    expect(html).toContain('18 feb');
    expect(html).not.toContain('Invalid Date');
  });
});
