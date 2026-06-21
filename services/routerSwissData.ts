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
 'hotel-flaz-pontresina-2028': { it: 'hotel-flaz-pontresina-2028', en: 'hotel-flaz-pontresina-2028', de: 'hotel-flaz-pontresina-2028', fr: 'hotel-flaz-pontresina-2028' },
 'carenza-manodopera-gr-2024': { it: 'carenza-manodopera-gr-2024', en: 'labour-shortage-graubuenden', de: 'arbeitskraeftemangel-graubuenden', fr: 'penurie-main-d-oeuvre-grisons' },
 'premi-di-cassa-malati-ticino': { it: 'premi-di-cassa-malati-ticino', en: 'treatment-fee-premiums-ticino', de: 'kassenservice-pramien-tessin', fr: 'primes-maladie-ticino' },
 'soggiorno-estero-avs-evitare-lacuna': { it: 'soggiorno-estero-avs-evitare-lacuna', en: 'living-abroad-avoid-avs-gap', de: 'ausland-aufenthalt-vermeiden-avs-luecke', fr: 'sejour-etranger-eviter-lacune-avs' },
 'avs-finanziamento-13esima': { it: 'avs-finanziamento-13esima', en: 'ahv-financing-13th', de: 'ahv-finanzierung-13', fr: 'avs-financement-13e' },
 'givaudan-licenziamenti': { it: 'givaudan-licenziamenti', en: 'givaudan-layoffs', de: 'givaudan-entlassungen', fr: 'givaudan-licenciements' },
 'agefi-nuovi-vertici': { it: 'agefi-nuovi-vertici', en: 'agefi-management-change-new-partners', de: 'agefi-fuhrungswechsel-neue-partner', fr: 'agefi-changement-direction-nouveaux-partenaires' },
 'aeroporti-svizzeri-aumentano-pas-s-vieto': { it: 'aeroporti-svizzeri-aumentano-pas-s-vieto', en: 'swiss-airports-passengers-increase', de: 'schweizer-flughafen-aufschwung-passagiere', fr: 'aeroports-suisse-augmentation-passagers' },
 'parlamento-avs-protezione-adozione': { it: 'parlamento-avs-protezione-adozione', en: 'parliament-avs-adoption-protection', de: 'parlament-avs-adozione-schutz', fr: 'parlement-avs-protection-adoption' },
 'pensione-avs-inps-2026-famiglia-con-figli': { it: 'pensione-avs-inps-2026-famiglia-con-figli', en: 'swiss-frontier-pension-avs-inps-2026-family-with-children', de: 'schweizerischer-grenz-beitrag-avs-inps-2026-familienmit-kindern', fr: 'prelevement-suissier-avs-inps-2026-famille-avec-enfants' },
 'smartworking-frontaliere-s-definitivo': { it: 'smartworking-frontaliere-s-definitivo', en: 'cross-border-workers-final-yes-smartworking', de: 'grenzgaenger-endgueltig-ja-smartworking', fr: 'frontaliers-oui-definitif-travail-a-distance' },
 'bocciatura-sportello-disoccupati-coldrerio': { it: 'bocciatura-sportello-disoccupati-coldrerio', en: 'rejection-unemployed-center-coldrerio', de: 'ablehnung-arbeitslosenberatung-coldrerio', fr: 'rejet-guichet-chomeurs-coldrerio' },
 'ffs-nuova-locomotiva-merci-stadler': { it: 'ffs-nuova-locomotiva-merci-stadler', en: 'new-sbb-freight-locomotive-stadler', de: 'neue-sbb-gueterzuglokomotive-stadler', fr: 'nouvelle-locomotive-fret-cff-stadler' },
 'iniziativa-10-milioni-svizzera': { it: 'iniziativa-10-milioni-svizzera', en: 'initiative-10-million-switzerland', de: 'initiative-10-millionen-schweiz', fr: 'initiative-10-millions-suisse' },
 'trump-dazi-doganali-2026': { it: 'trump-dazi-doganali-2026', en: 'trump-tariffs-2026', de: 'trump-zolle-2026', fr: 'trump-droits-de-douane-2026' },
 'sciopero-femminista-vd-ne': { it: 'sciopero-femminista-vd-ne', en: 'feminist-strike-vaud-neuchatel', de: 'frauenstreik-waadt-neuenburg', fr: 'greve-feministe-vaud-neuchatel' },
 'bce-tassi-inflazione-2023': { it: 'bce-tassi-inflazione-2023', en: 'bce-interest-inflation-2023', de: 'bce-zinssatz-inflation-2023', fr: 'bce-taux-inflation-2023' },
 'tassa-prenotazione-capanne-cas': { it: 'tassa-prenotazione-capanne-cas', en: 'cas-hut-reservation-fee-switzerland', de: 'sac-huetten-reservierungsgebuehr-schweiz', fr: 'taxe-reservation-cabanes-cas-suisse' },
 'salario-minimo-vaud-si-ma-cantone-sesto': { it: 'salario-minimo-vaud-si-ma-cantone-sesto', en: 'minimum-wage-vd-yes-but-canton-sixth', de: 'mindestlohn-wd-ja-aber-der-sechste-kanton', fr: 'salaire-minimum-vd-oui-mais-la-sixieme-canton' },
 'votazioni-federali-giugno-2026': { it: 'votazioni-federali-giugno-2026', en: 'federal-votes-june-2026', de: 'eidgenoessische-abstimmung-juni-2026', fr: 'votations-federales-juin-2026' },
 'imposizione-fonte-basilea': { it: 'imposizione-fonte-basilea', en: 'source-tax-basel', de: 'quelle-steuer-basel', fr: 'impot-source-basel' },
 'blocchi-immigrazione-ticino': { it: 'blocchi-immigrazione-ticino', en: 'immigration-block-ticino', de: 'einwanderungsblock-tessin', fr: 'blocage-immigration-tessin' },
 'treni-fermi-stabio-gallarate-incompetenza-regione': { it: 'treni-fermi-stabio-gallarate-incompetenza-regione', en: 'trains-halted-stabio-gallarate-regional-incompetence', de: 'verzoegerte-zuege-stabio-gallarate-regionale-unfahigkeit', fr: 'trains-arretes-stabio-gallarate-incompetence-regionale' },
 'offerte-lavoro-intelligenza-artificiale-2025': { it: 'offerte-lavoro-intelligenza-artificiale-2025', en: 'ai-job-offers-switzerland-2025', de: 'ki-jobangebote-schweiz-2025', fr: 'offres-emploi-ia-suisse-2025' },
 'la-svizzera-invia-un-segnale-a-favore-delleuropa-e-delleconomia-secondo-la-stampa-internazionale': { it: 'la-svizzera-invia-un-segnale-a-favore-delleuropa-e-delleconomia-secondo-la-stampa-internazionale', en: 'switzerland-sends-signal-in-favour-of-europe-and-economy', de: 'die-schweiz-sendet-einen-signal-an-fur-europa-und-wirtschaft', fr: 'la-suisse-envoie-un-signal-en-faveur-de-l-europe-et-de-l-economie' },
 'deduzione-da-ristorni-contraria-accordi-con-roma': { it: 'deduzione-da-ristorni-contraria-accordi-con-roma', en: 'deduction-from-rentals-contrary-to-rome-agreements', de: 'abzug-und-abhebung-gegen-vertrage-mit-rom', fr: 'depense-rentement-contre-l-accord-avec-rome' },
 'cicor-piano-efficienza-tagli-lavoro': { it: 'cicor-piano-efficienza-tagli-lavoro', en: 'cicor-efficiency-plan-job-cuts', de: 'cicor-effizienzplan-stellenabbau', fr: 'cicor-plan-efficacite-reduction-emplois' },
 'ia-chatbot-influenza-acquisti-svizzera': { it: 'ia-chatbot-influenza-acquisti-svizzera', en: 'ai-chatbot-influence-purchases-switzerland', de: 'ki-chatbot-einfluss-einkaeufe-schweiz', fr: 'chatbot-ia-influence-achats-suisse' },
 'tassa-salute-frontalieri-sindacati-attacco': { it: 'tassa-salute-frontalieri-sindacati-attacco', en: 'health-tax-crossborder-unions-criticism', de: 'gesundheitsabgabe-grenzgaenger-gewerkschaften', fr: 'taxe-sante-frontalier-syndicats-attaque' },
 'infermiere-lugano-lis': { it: 'infermiere-lugano-lis', en: 'nurses-lugano-lis', de: 'pfleger-lugano-lis', fr: 'infirmieres-lugano-lis' },
 'tasse-frontalieri-scambio-dati-stipendi-italia': { it: 'tasse-frontalieri-scambio-dati-stipendi-italia', en: 'switzerland-italy-tax-treaty', de: 'schweiz-italien-steuerabkommen', fr: 'suisses-italie-accord-fiscal' },
 'lavorare-nel-servizio-alla-casa-ticino': { it: 'lavorare-nel-servizio-alla-casa-ticino', en: 'working-in-household-services-ticino', de: 'arbeit-in-haushaltsdienst-ticino', fr: 'travailler-dans-services-a-la-maison-ticino' },
 'disoccupazione-transfrontaliera-svizzera': { it: 'disoccupazione-transfrontaliera-svizzera', en: 'cross-border-unemployment-switzerland', de: 'grenzueberschreitende-arbeitslosigkeit-schweiz', fr: 'chomage-transfrontalier-suisse' },
 'hoval-ticino-opportunita-lavoro': { it: 'hoval-ticino-opportunita-lavoro', en: 'hoval-ticino-job-opportunities', de: 'hoval-tessin-arbeitsmoeglichkeiten', fr: 'hoval-tessin-opportunites-emploi' },
 'ufficio-postale-chiasso-aggiornamenti': { it: 'ufficio-postale-chiasso-aggiornamenti', en: 'chiasso-post-office-updates', de: 'postfiliale-chiasso-updates', fr: 'mises-a-jour-bureau-poste-chiasso' },
 'bloccare-ridurre-ristorni-frontalieri-roma': { it: 'bloccare-ridurre-ristorni-frontalieri-roma', en: 'cross-border-workers-block-reduce-reimbursements-rome', de: 'grenzaer-blockieren-verringern-erstattung-roma', fr: 'frontaliers-bloquer-reduire-restitutions-rome' },
 'roche-basel-offerte-lavoro': { it: 'roche-basel-offerte-lavoro', en: 'roche-basel-job-openings', de: 'roche-basel-stellenangebote', fr: 'offres-d-emploi-roche-basel' },
 'ticino-concorsi': { it: 'ticino-concorsi', en: 'ticino-concorsi', de: 'ticino-stellenangebote', fr: 'ticino-offres-emploi' },
 'lidl-biasca-ticino': { it: 'lidl-biasca-ticino', en: 'lidl-biasca-switzerland', de: 'lidl-biasca-schweiz', fr: 'lidl-biasca-suisse' },
 'dogana-chiasso-svizzera': { it: 'dogana-chiasso-svizzera', en: 'chiasso-border-switzerland', de: 'grenze-chiasso-schweiz', fr: 'frontiere-chiasso-suisse' },
 'imposta-alla-fonte-frontalieri-ticino': { it: 'imposta-alla-fonte-frontalieri-ticino', en: 'withholding-tax-cross-border-ticino', de: 'quellensteuer-grenzgaenger-tessin', fr: 'imposition-a-la-source-frontaliers-tessin' },
 'dogana-stabio-gaggiolo': { it: 'dogana-stabio-gaggiolo', en: 'dogana-gaggiolo-stabio', de: 'zoll-gaggiolo-stabio', fr: 'douane-gaggiolo-stabio' },
 'trasporti-45-ticino-margini': { it: 'trasporti-45-ticino-margini', en: 'swiss-transport-policy-ticino-marginalized', de: 'verkehrspolitik-ticino-am-rand', fr: 'politique-transports-ticino-en-marge' },
 'nucleare-13avs-salari-votazioni': { it: 'nucleare-13avs-salari-votazioni', en: 'nuclear-13avs-wages-votes', de: 'kernenergie-13avs-loehne-abstimmungen', fr: 'energie-nucleaire-13avs-salaires-votes' },
 'lavoro-nero-dumping-2025-svizzera': { it: 'lavoro-nero-dumping-2025-svizzera', en: 'black-work-salary-dumping-2025-switzerland', de: 'schwarzarbeit-lohn-dumping-2025-schweiz', fr: 'travail-illegal-salaire-dumping-2025-suisse' },
 'lpp-prestazioni-tassazione-svizzera': { it: 'lpp-prestazioni-tassazione-svizzera', en: 'swiss-lpp-benefits-taxation', de: 'schweizer-bvg-leistungen-besteuerung', fr: 'prestations-lpp-suisse-imposition' },
 'caritas-ticino-poverta-2025': { it: 'caritas-ticino-poverta-2025', en: 'caritas-ticino-poverty-2025', de: 'caritas-ticino-armut-2025', fr: 'caritas-ticino-pauvrete-2025' },
 'caldo-lavoro-casa': { it: 'caldo-lavoro-casa', en: 'workers-rights-summer-heat', de: 'arbeiterrechte-sommerhitze', fr: 'droits-travailleurs-chaud-ete' },
 'vivere-senza-big-tech': { it: 'vivere-senza-big-tech', en: 'living-without-big-tech', de: 'ohne-big-tech-leben', fr: 'vivre-sans-les-big-tech' },
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
