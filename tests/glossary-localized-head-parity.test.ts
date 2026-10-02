/**
 * Il termine di glossario in en/de/fr ha LO STESSO head nell'HTML statico e
 * dopo l'idratazione SPA.
 *
 * Prima: la pagina statica `/en/cross-border-glossary/<termine>/` (e de/fr)
 * portava la definizione tradotta del termine, ma la SPA, all'idratazione,
 * passava la sezione `glossario-<id>` a `resolveLocalizedSeoContent`, che non
 * la conosce: title «Page Ainp | Frontaliere Ticino» e description «Page Ainp.
 * Practical tools, updated data…» scritti sopra l'head vero.
 *
 * Ora entrambi passano per `buildLocalizedGlossaryMetaDescription`
 * (`services/seo/glossaryTermDefinitions.ts`) sulle stesse stringhe
 * `glossary.terms.<id>.title|desc`. Il test confronta, termine per termine e
 * lingua per lingua, ciò che la SPA scrive (`resolveLocalizedGlossarySeo`) con
 * ciò che lo statico emette (`localizedGlossaryMetaDescription`, letto da
 * `deriveLocaleSeo` in staticPagesPlugin.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import itStats from '@/services/locales/it-stats';
import enStats from '@/services/locales/en-stats';
import { localizedGlossaryMetaDescription } from '@/build-plugins/shared/glossaryTermDetail';
import { buildTitleWithBrand } from '@/build-plugins/shared/titleSuffix';

// La SPA legge il chunk `stats` della lingua tramite i18n; qui lo si risolve
// con i moduli veri, così il test misura le stesse stringhe che il browser
// riceve, senza dipendere dal caricamento lazy.
vi.mock('@/services/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/i18n')>();
  return {
    ...actual,
    loadLocalePageChunk: async (locale: string, page: string) => {
      if (page !== 'stats') return null;
      if (locale === 'en') return (await import('@/services/locales/en-stats')).default;
      if (locale === 'de') return (await import('@/services/locales/de-stats')).default;
      if (locale === 'fr') return (await import('@/services/locales/fr-stats')).default;
      return null;
    },
  };
});

// setup-common mocca seoService per tutta la suite: qui serve quello vero.
vi.doUnmock('@/services/seoService');
const { resolveLocalizedGlossarySeo } = await import('@/services/seoService');

const TERM_IDS = Object.keys(itStats)
  .map((k) => /^glossary\.terms\.([^.]+)\.title$/.exec(k)?.[1])
  .filter((id): id is string => Boolean(id));

/** The Italian head the SPA starts from (`buildGlossarySeoMetadata`). */
const italianMetadata = (label: string) => ({
  title: buildTitleWithBrand(`${label} (Glossario)`),
  keywords: `glossario frontalieri, ${label}`,
});

const QUALIFIER = { en: 'Glossary', de: 'Glossar', fr: 'Glossaire' } as const;

describe('glossario en/de/fr: head SPA = head statico', () => {
  it('copre tutti i termini', () => {
    expect(TERM_IDS.length).toBeGreaterThanOrEqual(40);
  });

  for (const locale of ['en', 'de', 'fr'] as const) {
    it(`${locale}: stessa meta description dello statico, nel range 80-170`, async () => {
      const mismatches: string[] = [];
      for (const id of TERM_IDS) {
        const spa = await resolveLocalizedGlossarySeo(`glossario-${id}`, italianMetadata(id.toUpperCase()), locale);
        const ssg = localizedGlossaryMetaDescription(id, locale);
        if (!spa || !ssg || spa.description !== ssg) mismatches.push(`${id}: spa=${spa?.description} ssg=${ssg}`);
        else if (spa.description.length < 80 || spa.description.length > 170) mismatches.push(`${id}: ${spa.description.length} char`);
      }
      expect(mismatches).toEqual([]);
    });

    it(`${locale}: il title è il termine con il qualificatore, come deriveLocaleSeo`, async () => {
      const spa = await resolveLocalizedGlossarySeo('glossario-ainp', italianMetadata('AINP'), locale);
      expect(spa?.title).toBe(`AINP (${QUALIFIER[locale]}) | Frontaliere Ticino`);
      expect(spa?.title).not.toMatch(/^Page /);
    });
  }

  it('la description è nella lingua della pagina, non il segnaposto né l’italiano', async () => {
    const spa = await resolveLocalizedGlossarySeo('glossario-impostaAllaFonte', italianMetadata('Imposta Alla Fonte'), 'en');
    expect(spa?.description.startsWith(enStats['glossary.terms.impostaAllaFonte.title'])).toBe(true);
    expect(spa?.description).not.toMatch(/^Definition and explanation of/);
    expect(spa?.description).not.toContain(itStats['glossary.terms.impostaAllaFonte.desc'].slice(0, 30));
  });

  it("l'italiano, una sezione che non è un termine e un termine sconosciuto restano sul percorso generico", async () => {
    expect(await resolveLocalizedGlossarySeo('glossario-ainp', italianMetadata('AINP'), 'it')).toBeNull();
    expect(await resolveLocalizedGlossarySeo('glossario', italianMetadata('Glossario'), 'en')).toBeNull();
    expect(await resolveLocalizedGlossarySeo('glossario-nonEsiste', italianMetadata('X'), 'de')).toBeNull();
  });
});
