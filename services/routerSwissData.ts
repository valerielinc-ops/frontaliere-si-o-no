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
 'neutralizzazione-stime-2026-classi-media': { it: 'neutralizzazione-stime-2026-classi-media', en: 'neutralisation-estimates-2026-protect-middle-class-and-home', de: 'neutralisierung-der-schaetzungen-2026-schutz-fuer-mittelschicht-und-wohneigentum', fr: 'neutralisation-des-estimations-2026-proteger-les-classes-moyennes-et-le-logement' },
 'lavoro-estero-guida-frontalieri': { it: 'lavoro-estero-guida-frontalieri', en: 'working-abroad-guide-cross-border-workers', de: 'arbeit-ausland-leitfaden-grenzgaenger-tessin', fr: 'travail-etranger-guide-travailleurs-frontaliers-tessin' },
 'guerre-dellinformazione': { it: 'guerre-dellinformazione', en: 'information-wars', de: 'informationskriege', fr: 'guerres-de-linformation' },
 'imposta-fonte-frontalieri-ticino': { it: 'imposta-fonte-frontalieri-ticino', en: 'withholding-tax-frontalieri-ticino', de: 'quellensteuer-grenzganger-tessin', fr: 'impot-a-la-source-frontaliers-tessin' },
 'hantavirus-ginevra-identificazione': { it: 'hantavirus-ginevra-identificazione', en: 'how-geneva-identified-hantavirus', de: 'wie-genf-das-hantavirus-identifizierte', fr: 'comment-geneve-a-identifie-le-hantavirus' },
 'svizzera-dazi-usa-lavoro-forzato': { it: 'svizzera-dazi-usa-lavoro-forzato', en: 'switzerland-us-tariffs-forced-labor', de: 'schweiz-usa-zwangsarbeit-zoelle', fr: 'suisse-etats-unis-droits-forced-labor' },
 'rientro-svizzera-senza-lavoro': { it: 'rientro-svizzera-senza-lavoro', en: 'return-to-switzerland-unemployed-guide', de: 'rueckkehr-in-die-schweiz-ohne-arbeitslosigkeit', fr: 'retour-suisse-chomage-guide' },
 'festivita-ticino-2026': { it: 'festivita-ticino-2026', en: 'festivities-ticino-2026', de: 'feierlichkeiten-ticino-2026', fr: 'fetes-ticino-2026' },
 'un-blocco-dei-ristorni-reazione-comprensibile': { it: 'un-blocco-dei-ristorni-reazione-comprensibile', en: 'a-block-of-restaurants-a-comprehensible-reaction', de: 'eine-blockierung-von-restaurants-eine-verstandliche-reaktion', fr: 'un-blocage-de-restaurants-une-reaction-comprehensible' },
 'medico-medicina-interna-intensiva-eoc': { it: 'medico-medicina-interna-intensiva-eoc', en: 'doctor-internal-intensive-medicine-eoc', de: 'arzt-innere-intensivmedizin-eoc', fr: 'medecin-medecine-interne-intensive-eoc' },
 'frontalieri-svizzera': { it: 'frontalieri-svizzera', en: 'frontaliers-switzerland', de: 'grenzgaenger-schweiz', fr: 'frontaliers-suisse' },
 'permesso-g-vs-b-2026-oltre-20-km': { it: 'permesso-g-vs-b-2026-oltre-20-km', en: 'permesso-g-vs-b-2026-beyond-20-km', de: 'permesso-g-vs-b-2026-ueber-20-km', fr: 'permesso-g-vs-b-2026-au-dela-de-20-km' },
 'calcul-salaire-net-suiss-frontalier': { it: 'calcul-salaire-net-suiss-frontalier', en: 'swiss-border-worker-net-salary-calculation', de: 'schweizer-grenzarbeiter-nettolohnberechnung', fr: 'calcul-salaire-net-frontalier-suisse' },
 'lonza-concierge-ticino-job': { it: 'lonza-concierge-ticino-job', en: 'lonza-concierge-ticino', de: 'lonza-concierge-ticino', fr: 'lonza-concierge-ticino' },
 'naspi-disoccupazione-frontaliere': { it: 'naspi-disoccupazione-frontaliere', en: 'naspi-unemployment-benefits-cross-border', de: 'naspi-arbeitslosengeld-grenzgaenger', fr: 'naspi-chomage-frontalier-regles' },
 'lavoro-produzione-farmaceutica-coira': { it: 'lavoro-produzione-farmaceutica-coira', en: 'pharmaceutical-production-jobs-chur', de: 'stellen-arzneimittelherstellung-chur', fr: 'emplois-production-pharmaceutique-coire' },
 'la-finanza-svizzera-sotto-esame-per-il-suo-impatto-sul-clima': { it: 'la-finanza-svizzera-sotto-esame-per-il-suo-impatto-sul-clima', en: 'swiss-finance-under-scrutiny-for-its-climate-impact', de: 'die-schweizerische-finanzbranche-untersucht-auf-ihren-klimaeinfluss', fr: 'la-finance-suisse-sous-examen-pour-son-impact-sur-le-climat' },
 'cassa-malati-estero-scelta-assicurazione': { it: 'cassa-malati-estero-scelta-assicurazione', en: 'swiss-health-insurance-abroad-choice', de: 'krankenversicherung-schweizer-ausland-wahl', fr: 'assurance-maladie-suisse-etranger-choix' },
 'disoccupazione-svizzera-maggio-2026': { it: 'disoccupazione-svizzera-maggio-2026', en: 'unemployment-switzerland-may-2026', de: 'arbeitslosigkeit-schweiz-mai-2026', fr: 'chomage-suisse-mai-2026' },
 'pensione-iva-parlamento': { it: 'pensione-iva-parlamento', en: 'swiss-parliament-pension-vat-debate', de: 'schweizer-parlament-pension-uebernahme', fr: 'parlement-suisse-pension-tva' },
 'migros-24h-herisau': { it: 'migros-24h-herisau', en: 'migros-24-hour-supermarket-herisau', de: 'migros-24-stunden-supermarkt-herisau', fr: 'migros-supermarche-24-heures-herisau' },
 'sem-taglia-108-posti-lavoro-2027': { it: 'sem-taglia-108-posti-lavoro-2027', en: 'sem-cuts-108-jobs-2027', de: 'sem-streicht-108-stellen-2027', fr: 'sem-supprime-108-emplois-2027' },
 'voto-zurigo-alloggi-cassa-malati': { it: 'voto-zurigo-alloggi-cassa-malati', en: 'zurich-vote-affordable-housing-health-insurance', de: 'abstimmung-zuerich-wohnraum-krankenkassenpraemien', fr: 'vote-zurich-logement-abordable-assurance-maladie' },
 'votazioni-cantonali-giugno-salario-minimo': { it: 'votazioni-cantonali-giugno-salario-minimo', en: 'cantonal-votes-june-minimum-wage', de: 'kantonale-abstimmungen-juni-mindestlohn', fr: 'votations-cantonales-juin-salaire-minimum' },
 'donne-parlamento-record': { it: 'donne-parlamento-record', en: 'swiss-parliament-women-record', de: 'rekord-frauen-parlament-schweiz', fr: 'record-femmes-parlement-suisse' },
 'diaspora-svizzera-parlamento': { it: 'diaspora-svizzera-parlamento', en: 'swiss-diaspora-parliament', de: 'schweizer-diaspora-parlament', fr: 'diaspora-suisse-parlement' },
 'ritmi-insostenibili-logistica-dpd': { it: 'ritmi-insostenibili-logistica-dpd', en: 'unsustainable-pace-pressure-logistics-workers', de: 'untragbare-tempo-druck-logistikarbeiter', fr: 'rythmes-intenables-pression-travailleurs-logistique' },
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
