import { describe, expect, it } from 'vitest';
import { urlsFromPublishSummary } from '../scripts/notify-article-search-engines.mjs';

describe('fast-publish IndexNow URL coverage', () => {
  it('includes every pushed index page, not only the article canonical URL', () => {
    const urls = urlsFromPublishSummary({
      shards: [
        {
          url: 'https://frontaliereticino.ch/articoli-frontaliere/nuovo-articolo/',
          paths: [
            'articoli-frontaliere/nuovo-articolo/index.html',
            'articoli-frontaliere/tutti/index.html',
            'articoli-frontaliere/argomenti/fisco/index.html',
            'articoli-frontaliere/nuovo-articolo.html',
          ],
        },
        {
          paths: ['en/cross-border-articles/new-article/index.html'],
        },
      ],
    });

    expect(urls).toEqual([
      'https://frontaliereticino.ch/articoli-frontaliere/argomenti/fisco/',
      'https://frontaliereticino.ch/articoli-frontaliere/nuovo-articolo/',
      'https://frontaliereticino.ch/articoli-frontaliere/tutti/',
      'https://frontaliereticino.ch/en/cross-border-articles/new-article/',
    ]);
  });

  it('understands the section-rerender summary used by the hub workflow', () => {
    expect(urlsFromPublishSummary({
      sections: {
        frontaliere: {
          pathsByLocale: {
            it: ['articoli-frontaliere/tutti/index.html'],
            en: ['en/cross-border-articles/argomenti/fisco/index.html'],
          },
        },
      },
    })).toEqual([
      'https://frontaliereticino.ch/articoli-frontaliere/tutti/',
      'https://frontaliereticino.ch/en/cross-border-articles/argomenti/fisco/',
    ]);
  });
});
