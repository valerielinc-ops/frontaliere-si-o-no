/**
 * Switzerland-wide article slug data — the national mirror of
 * `routerBlogData.ts`. Dynamically imported at runtime to keep the main App
 * chunk small. Build plugins (ogPagesPlugin) read this file at build time via
 * regex, so keep `SWISS_SLUGS` / `REVERSE_SWISS` as top-level object-literal
 * exports.
 *
 * Article ids are loosely typed `string` (not a literal union) to avoid the
 * TS2590 "union too complex" pressure as the generator appends entries — the
 * frontaliere registry hits the same limit and chunks the union; the svizzera
 * section sidesteps it entirely by validating ids at runtime via REVERSE_SWISS.
 */
import type { Locale } from './i18n';

export const SWISS_SLUGS: Record<string, Record<Locale, string>> = {
  'costo-vita-svizzera-2026': {
    it: 'costo-vita-svizzera-2026',
    en: 'cost-of-living-switzerland-2026',
    de: 'lebenshaltungskosten-schweiz-2026',
    fr: 'cout-vie-suisse-2026',
  },
  'premi-cassa-malati-svizzera-2026': {
    it: 'premi-cassa-malati-svizzera-2026',
    en: 'health-insurance-premiums-switzerland-2026',
    de: 'krankenkassenpraemien-schweiz-2026',
    fr: 'primes-assurance-maladie-suisse-2026',
  },
 'berna-non-vuole-creare-attriti-con-litalia': { it: 'berna-non-vuole-creare-attriti-con-litalia', en: 'bern-does-not-want-to-create-tensions-with-italy', de: 'bern-will-keine-reibungen-mit-italien', fr: 'bern-ne-veut-pas-creer-de-tensions-avec-litalie' },
 'iniziative-casse-malati-2026': { it: 'iniziative-casse-malati-2026', en: 'health-insurance-initiatives-2026', de: 'gesundheitsversicherungsinitiativen-2026', fr: 'initiatives-assurance-maladie-2026' },
 'candidatura-lavoro-estero-ticino': { it: 'candidatura-lavoro-estero-ticino', en: 'job-application-abroad-ticino', de: 'bewerbung-ausland-ticino', fr: 'candidature-emploi-etranger-ticino' },
 'intelligenza-artificiale-lavoro-svizzera-2026': { it: 'intelligenza-artificiale-lavoro-svizzera-2026', en: 'artificial-intelligence-work-switzerland-2026', de: 'kunstliche-intelligenz-arbeit-schweiz-2026', fr: 'intelligence-artificielle-travail-suisse-2026' },
 'lavoro-media-ssr-talenti-ticino': { it: 'lavoro-media-ssr-talenti-ticino', en: 'media-jobs-ssr-talents-ticino', de: 'medien-jobs-ssr-talente-tessin', fr: 'emplois-medias-ssr-talents-tessin' },
 'cern-future-collider-ticino': { it: 'cern-future-collider-ticino', en: 'cern-future-collider-ticino', de: 'cern-future-collider-ticino', fr: 'cern-future-collider-ticino' },
};

export const REVERSE_SWISS: Record<Locale, Record<string, string>> = (() => {
  const result = { it: {}, en: {}, de: {}, fr: {} } as Record<Locale, Record<string, string>>;
  for (const [articleId, locSlugs] of Object.entries(SWISS_SLUGS)) {
    for (const locale of ['it', 'en', 'de', 'fr'] as Locale[]) {
      result[locale][locSlugs[locale]] = articleId;
    }
  }
  return result;
})();

/** All svizzera article ids, derived from SWISS_SLUGS keys. */
export const ALL_SWISS_ARTICLE_IDS: string[] = Object.keys(SWISS_SLUGS);
