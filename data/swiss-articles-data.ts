/**
 * Switzerland-wide article metadata — the national mirror of
 * `blog-articles-data.ts`. Same `Article` shape; articles here cover the whole
 * of Switzerland (economy, taxes, work, living, housing) for anyone living or
 * working in CH, not only cross-border workers.
 *
 * Rendered by the shared `BlogArticles` component with `section="svizzera"`.
 * Body text lives in `services/locales/blog-body-ch/{locale}/{id}.ts`; meta in
 * `services/locales/blog-meta-ch-{locale}.ts`. Slugs in
 * `services/routerSwissData.ts`. See `services/articleSections.ts`.
 */
import type { Article } from './blog-articles-data';

export type { Article };

export const SWISS_ARTICLES: Article[] = [
  {
    id: 'costo-vita-svizzera-2026',
    category: 'pratico',
    date: '2026-06-02',
    image: '/images/places/swissminiatur.webp',
    hasCalculator: true,
    authorSlug: 'marco-ferrari',
    authorName: 'Marco Ferrari',
  },
  {
    id: 'premi-cassa-malati-svizzera-2026',
    category: 'fiscale',
    date: '2026-06-02',
    image: '/images/places/bellinzona.webp',
    hasCalculator: true,
    authorSlug: 'laura-bianchi',
    authorName: 'Laura Bianchi',
  },
   {
    id: 'berna-non-vuole-creare-attriti-con-litalia',
    category: 'novita',
    date: '2026-06-02T20:38:18.558Z',
    image: '/images/blog/berna-non-vuole-creare-attriti-con-litalia.webp',
    hasCalculator: false,
    authorSlug: 'redazione',
    authorName: 'Redazione Frontaliere Ticino',
   },
   {
    id: 'iniziative-casse-malati-2026',
    category: 'fiscale',
    date: '2026-06-02T21:12:32.990Z',
    image: '/images/blog/iniziative-casse-malati-2026.webp',
    hasCalculator: true,
    authorSlug: 'marco-ferrari',
    authorName: 'Marco Ferrari',
   },
   {
    id: 'candidatura-lavoro-estero-ticino',
    category: 'pratico',
    date: '2026-06-02T21:47:29.166Z',
    image: '/images/blog/candidatura-lavoro-estero-ticino.webp',
    hasCalculator: true,
    authorSlug: 'redazione',
    authorName: 'Redazione Frontaliere Ticino',
   },
   {
    id: 'intelligenza-artificiale-lavoro-svizzera-2026',
    category: 'novita',
    date: '2026-06-02T23:12:13.838Z',
    image: '/images/blog/intelligenza-artificiale-lavoro-svizzera-2026.webp',
    hasCalculator: true,
    authorSlug: 'redazione',
    authorName: 'Redazione Frontaliere Ticino',
   },
   {
    id: 'lavoro-media-ssr-talenti-ticino',
    category: 'pratico',
    date: '2026-06-03T00:19:25.227Z',
    image: '/images/blog/lavoro-media-ssr-talenti-ticino.webp',
    hasCalculator: true,
    authorSlug: 'redazione',
    authorName: 'Redazione Frontaliere Ticino',
   },
];
