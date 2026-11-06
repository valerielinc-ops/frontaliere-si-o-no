import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderArticlePages, resolveStaticTemplateUrl } from '../build-plugins/ogPagesPlugin';

const temporaryRoots: string[] = [];
afterEach(() => temporaryRoots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

const BASE_URL = 'https://frontaliereticino.ch';

it('normalizes Event price text and resolves BASE_URL templates before completeness validation', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-pages-event-jsonld-'));
  temporaryRoots.push(rootDir);
  const write = (relativePath: string, value: string) => {
    const filePath = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, value);
  };

  const id = 'event-base-url-template-contract';
  const excerpt = 'Un evento di prova con una descrizione completa e verificabile per i dati strutturati.';
  const organizerUrl = ['`', '${BASE_URL}/organizers/event-', '\\u0063', 'est/', '`'].join('');
  const offerUrl = ['`', '${BASE_URL}/tickets/event-', '\\u0063', 'est/', '`'].join('');
  const secondOfferUrl = '\u0060${BASE_URL}/tickets/event-test/second/\u0060';

  expect(resolveStaticTemplateUrl(organizerUrl, BASE_URL))
    .toBe(`${BASE_URL}/organizers/event-cest/`);

  write('data/blog-articles-data.ts', `const RAW_ARTICLES = [{ id: '${id}', category: 'pratico', date: '2026-12-01' }];`);
  write('services/seo/seo-blog.ts', `export const entries = {
  'blog-${id}': {
    title: 'Evento di prova', description: '${excerpt}', keywords: 'evento',
    ogTitle: 'Evento di prova', ogDescription: '${excerpt}',
    canonicalPath: '/articoli-frontaliere/${id}/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "Event",
      "name": "Evento di prova",
      "startDate": "2026-12-01T19:00:00+01:00",
      "endDate": "2026-12-01T21:00:00+01:00",
      "eventStatus": ["https://schema.org/EventScheduled", "https://schema.org/EventPostponed"],
      "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
      "isAccessibleForFree": true,
      "description": "${excerpt}",
      "location": {
        "@type": "Place", "name": "Teatro di prova",
        "address": {
          "@type": "PostalAddress", "streetAddress": "Via della Prova 1",
          "addressLocality": "Lugano", "addressRegion": "TI", "postalCode": "6900",
          "addressCountry": "CH"
        }
      },
      "performer": { "@type": "Person", "name": "Artista di prova" },
      "organizer": { "@type": "Organization", "name": "Organizzatore di prova", "url": ${organizerUrl} },
      "offers": [
        {
          "@type": "Offer", "price": "0", "priceCurrency": "CHF",
          "availability": "https://schema.org/InStock", "url": ${offerUrl}
        },
        {
          "@type": "Offer", "price": "25", "priceCurrency": "CHF",
          "availability": "https://schema.org/InStock", "url": ${secondOfferUrl}
        }
      ]
    }
  }
};`);
  write('services/routerBlogData.ts', `export const BLOG_SLUGS = ${JSON.stringify({ [id]: {
    it: id, en: `en-${id}`, de: `de-${id}`, fr: `fr-${id}`,
  } })};`);
  for (const locale of ['it', 'en', 'de', 'fr'] as const) {
    const translations = {
      [`blog.article.${id}.title`]: 'Evento di prova',
      [`blog.article.${id}.excerpt`]: excerpt,
    };
    write(`services/locales/blog-meta-${locale}.ts`, `const translations: Record<string, string> = ${JSON.stringify(translations)};\nexport default translations;\n`);
  }

  const distDir = path.join(rootDir, 'dist');
  const result = await renderArticlePages({ rootDir, distDir, section: 'frontaliere' });
  expect(result.entries).toHaveLength(1);
  const html = fs.readFileSync(path.join(distDir, result.entries[0].paths.it), 'utf8');
  const schema = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gu)]
    .map((match) => JSON.parse(match[1]) as Record<string, unknown>)
    .find((record) => record['@type'] === 'Event');

  expect(schema).toBeDefined();
  expect(schema?.eventStatus).toEqual([
    'https://schema.org/EventScheduled',
    'https://schema.org/EventPostponed',
  ]);
  expect((schema?.organizer as Record<string, unknown>)?.url).toBe(`${BASE_URL}/organizers/event-cest/`);
  const offers = schema?.offers as Record<string, unknown>[];
  expect(offers).toHaveLength(2);
  expect(offers.map((offer) => offer.price)).toEqual([0, 25]);
  expect(offers.map((offer) => offer.url)).toEqual([
    `${BASE_URL}/tickets/event-cest/`,
    `${BASE_URL}/tickets/event-test/second/`,
  ]);
});
