// @vitest-environment jsdom
/**
 * All'idratazione di un termine di glossario en/de/fr la SPA scrive nell'head
 * la definizione tradotta del termine — la stessa dell'HTML statico — e non
 * più «Page Ainp. Practical tools, updated data…».
 *
 * È il percorso vero: `updateMetaTags('glossario-<id>')` sull'URL localizzato,
 * con il chunk `stats` della lingua caricato da i18n (`loadLocalePageChunk`).
 * La parità termine per termine con lo statico è in
 * `glossary-localized-head-parity.test.ts`; qui si verifica che il risolutore
 * sia davvero quello che finisce nel `<head>`.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { buildPath, type AppRoute } from '@/services/router';
import { ensureLocaleLoaded, setLocale, type Locale } from '@/services/i18n';
import { localizedGlossaryMetaDescription } from '@/build-plugins/shared/glossaryTermDetail';
import { clampMetaDescription } from '@/build-plugins/shared/titleSuffix';

// setup-common mocca seoService per tutta la suite: qui serve quello vero.
vi.doUnmock('@/services/seoService');
let seo: typeof import('@/services/seoService');
beforeAll(async () => {
  seo = await import('@/services/seoService');
});

const QUALIFIER = { en: 'Glossary', de: 'Glossar', fr: 'Glossaire' } as const;
const meta = (selector: string) => document.querySelector(selector)?.getAttribute('content');

describe('head SPA di un termine di glossario localizzato', () => {
  for (const locale of ['en', 'de', 'fr'] as const) {
    for (const termId of ['ainp', 'impostaAllaFonte']) {
      it(`${locale} · ${termId}: description e og:description = statico, title con il qualificatore`, async () => {
        const path = buildPath({ activeTab: 'glossario', glossaryTerm: termId } as AppRoute, locale as Locale);
        window.history.replaceState({}, '', path);
        await ensureLocaleLoaded(locale);
        setLocale(locale);
        document.head.innerHTML = '<title>stale</title><meta name="description" content="stale"><meta property="og:description" content="stale">';

        await seo.updateMetaTags(`glossario-${termId}`);

        // Il `<meta>` statico è `clampMetaDescription(desc)` (staticPagesPlugin,
        // emit dell'head); la SPA applica lo stesso clamp allo stesso input.
        const source = localizedGlossaryMetaDescription(termId, locale);
        expect(source).toBeTruthy();
        const expected = clampMetaDescription(source!, undefined, locale);
        expect(meta('meta[name="description"]')).toBe(expected);
        expect(meta('meta[property="og:description"]')).toBe(expected);
        expect(document.title).toMatch(new RegExp(`\\(${QUALIFIER[locale]}\\) \\| Frontaliere Ticino$`));
        expect(document.title).not.toMatch(/^Page /);
      });
    }
  }
});
