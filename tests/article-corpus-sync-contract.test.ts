import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBorderWaitTodayPath } from '../scripts/lib/borderWaitSections.mjs';

const SOURCE = readFileSync(resolve(__dirname, '../scripts/pull-articles-corpus.mjs'), 'utf8');
const PHARMACY_ARTICLE_IDS = [
  'farmacia-aperta-turno-elenco',
  'farmacie-ticino-elenco-contatti',
  'farmacie-confine-italia-como-varese-verbano',
  'farmacie-turno-svizzera-confine-italiano',
  'farmacie-turno-ticino-guida',
] as const;
const PHARMACY_ARTICLE_LOCALES = ['it', 'en', 'de', 'fr'] as const;
const CANONICAL_TICINO_PATHS = {
  it: '/farmacie/ticino/',
  en: '/en/pharmacies/ticino/',
  de: '/de/apotheken/ticino/',
  fr: '/fr/pharmacies/ticino/',
} as const;
const LEGACY_TICINO_PATHS = ['/de/apotheken/Tessin/', '/fr/pharmacies/Tessin/'] as const;
const BORDER_WAIT_ARTICLE_BODIES = {
  it: resolve(__dirname, '../packages/articles/content/blog-body/it/dosso-dogana-stabio-gaggiolo-traffico-frontalieri.ts'),
  en: resolve(__dirname, '../packages/articles/content/blog-body/en/dosso-dogana-stabio-gaggiolo-traffico-frontalieri.ts'),
  de: resolve(__dirname, '../packages/articles/content/blog-body/de/dosso-dogana-stabio-gaggiolo-traffico-frontalieri.ts'),
  fr: resolve(__dirname, '../packages/articles/content/blog-body/fr/dosso-dogana-stabio-gaggiolo-traffico-frontalieri.ts'),
};

describe('article corpus sync site-owned contract', () => {
  it('rethrows unreadable snapshots while allowing only a missing first-sync file', () => {
    expect(SOURCE).toMatch(
      /catch \(error\) \{\s*if \(error\?\.code === ['"]ENOENT['"]\) return null;\s*throw error;\s*\}/u,
    );
    expect(SOURCE).toMatch(/site-owned Article provenance field missing before corpus mirror/u);
  });

  it('restores the declaration immediately after the corpus mirror', () => {
    expect(SOURCE).toMatch(
      /const siteOwnedArticleFields = readSiteOwnedArticleFields\(\);[\s\S]*?mirrorTree\(src, DEST,[\s\S]*?restoreSiteOwnedArticleFields\(siteOwnedArticleFields\);/u,
    );
  });

  it('keeps synchronized pharmacy articles on canonical Ticino routes in every locale', () => {
    for (const locale of PHARMACY_ARTICLE_LOCALES) {
      for (const articleId of PHARMACY_ARTICLE_IDS) {
        const relativeFile = `../packages/articles/content/blog-body-ch/${locale}/${articleId}.ts`;
        const source = readFileSync(resolve(__dirname, relativeFile), 'utf8');
        const label = `${locale}/${articleId}`;

        expect(source, label).toContain(CANONICAL_TICINO_PATHS[locale]);
        for (const legacyPath of LEGACY_TICINO_PATHS) {
          expect(source, label).not.toContain(legacyPath);
        }
      }
    }
  });

  it('keeps the localized Gaggiolo article links on the canonical today routes', () => {
    for (const [locale, path] of Object.entries(BORDER_WAIT_ARTICLE_BODIES)) {
      const source = readFileSync(path, 'utf8');
      const localLinks = [...source.matchAll(/\]\((\/[^)]+)\)/gu)].map((match) => match[1]);
      const borderLinks = localLinks.filter((link) => link.includes('gaggiolo'));

      expect(borderLinks, locale).toEqual([buildBorderWaitTodayPath(locale, 'gaggiolo')]);
    }
  });
});
