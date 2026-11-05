import { describe, expect, it } from 'vitest';
import { buildNewsletter } from '../services/newsletter-template.mjs';
import { omitDuplicateDiscoveryArticle } from '../scripts/lib/newsletter-discovery-selection.mjs';

const labels = {
  it: 'Tema in crescita',
  en: 'Trending now',
  de: 'Thema im Trend',
  fr: 'Tendance du moment',
} as const;

const base = {
  exchangeRate: { rate: 0.94, previousRate: 0.95 },
  matchedJobs: [],
  totalJobs: 0,
  weeklyFact: { text: 'Un dato utile.', source: 'Test' },
  unsubscribeUrl: 'https://frontaliereticino.ch/u/test',
};

describe('newsletter discovery article block', () => {
  it.each(Object.entries(labels))('renders a localized discovery block for %s', (locale, label) => {
    const html = buildNewsletter({
      ...base,
      locale,
      article: {
        title: 'Contenuto personalizzato',
        excerpt: 'Il contenuto scelto per il profilo.',
        url: '/articoli-frontaliere/personalizzato/',
      },
      discoveryArticle: {
        id: 'trend-topic-example',
        provider: 'google_trends',
        title: 'Il tema della settimana',
        excerpt: 'Un approfondimento nato da un tema in crescita.',
        url: '/articoli-frontaliere/trend-topic-example/',
      },
    });

    expect(html).toContain(label);
    expect(html).toContain('Il tema della settimana');
    expect(html).toContain('Contenuto personalizzato');
    expect(html).toContain('https://frontaliereticino.ch/articoli-frontaliere/trend-topic-example/');
  });

  it('omits the discovery section when there is no localized selection', () => {
    const html = buildNewsletter({ ...base, locale: 'it', discoveryArticle: null });
    expect(html).not.toContain(labels.it);
  });

  it('does not render a duplicate discovery card when it matches the personalized article', () => {
    const article = {
      id: 'same-article',
      title: 'Articolo personalizzato',
      excerpt: 'Il contenuto scelto per il profilo.',
      url: '/articoli-frontaliere/same-article/',
    };
    const frozenDiscoverySelection = {
      articleId: 'same-article',
      provider: 'google_trends',
      article: {
        id: 'same-article',
        provider: 'google_trends',
        title: 'Articolo selezionato dai trend',
        excerpt: 'Questo contenuto coincide con il selezionato.',
        url: 'https://frontaliereticino.ch/articoli-frontaliere/same-article/?utm_campaign=old',
      },
    };
    const perRecipientDiscovery = omitDuplicateDiscoveryArticle(frozenDiscoverySelection, article);
    const html = buildNewsletter({
      ...base,
      locale: 'it',
      article,
      discoveryArticle: perRecipientDiscovery?.article || null,
    });

    expect(html).toContain('Articolo personalizzato');
    expect(html).not.toContain('Articolo selezionato dai trend');
    expect(html).not.toContain(labels.it);
  });
});
