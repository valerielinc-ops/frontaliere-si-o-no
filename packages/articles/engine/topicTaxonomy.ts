/**
 * The editorial topic taxonomy behind the article topic hubs (issue #5001).
 *
 * WHY THIS IS CURATED AND NOT DERIVED
 * ───────────────────────────────────
 * `./topicClusters.ts` derives cluster MEMBERSHIP from the corpus. It cannot
 * derive the NAME: labelling similarity components by their dominant token
 * was measured on this corpus and produced stems (`arrestat`, `impost`), a
 * 224-article cluster called `2026`, and a different concept per locale for
 * one and the same set of articles. The full measurement is in that file's
 * header. Names are therefore human, and pinned here.
 *
 * PINNED IS THE POINT. These slugs are public URLs. A slug derived from the
 * corpus would move when the corpus moves, and a topic hub that renames
 * itself between deploys is a crawler telling itself the site restructures
 * daily. Membership under a slug may change freely — the slug may not. Adding
 * a topic is additive and safe; renaming or removing one is a redirect
 * decision, not an edit.
 *
 * SEEDS ARE ITALIAN ONLY, on purpose. Assignment runs once, on the Italian
 * corpus, because the four locale variants of a hub are hreflang siblings and
 * must hold the same articles (measured: per-locale assignment puts 221
 * articles in `fiscalita` on it and 151 on de, because German compounds like
 * `Grenzgängerbewilligung` never split into a seed token). Nothing reads
 * seeds in the other three locales, so they are not carried here — unread
 * data drifts.
 *
 * Seeds are natural words, not stems: `./topicClusters.ts` runs them through
 * the same tokenizer as the corpus, which folds inflection for both sides.
 */

/** The four locales every article surface is published in. */
export const TOPIC_LOCALES = ['it', 'en', 'de', 'fr'] as const;
export type TopicLocale = (typeof TOPIC_LOCALES)[number];

export interface TopicClusterDefinition {
  /** Stable identity. Never a URL — see `slug`. Never renamed. */
  readonly key: string;
  /** Public URL segment per locale. Pinned; changing one is a redirect. */
  readonly slug: Record<TopicLocale, string>;
  /** H1 / nav label per locale. */
  readonly label: Record<TopicLocale, string>;
  /** One-line lede, ≤120 chars (AGENTS.md § Static SEO Pages). */
  readonly intro: Record<TopicLocale, string>;
  /** Italian seed vocabulary that defines the topic. See header. */
  readonly seedText: string;
}

// ~24% of the frontaliere-section corpus and ~16% of svizzera (845/3.539 and
// 221/1.341, measured 2026-08-24 — see docs/topical-authority-map.md) match
// none of the 14 topics below. TRIED AND REJECTED before adding a 15th: 3
// candidate topics (comuni-confine, cultura-eventi, economia-imprese) raised
// frontaliere coverage 75.9% → 80.1%, but 153/222 of comuni-confine's new
// members were STOLEN from other topics with wrong matches (a drug-bust
// article landed there for mentioning a border town's name). Low-specificity
// topics buy coverage by degrading the 14 that already work. Re-measure with
// `computeSectionTopicAssignment` (articleHubPagesPlugin.ts) before trying
// again — don't re-attempt this from the same hunch.
export const TOPIC_CLUSTERS: readonly TopicClusterDefinition[] = [
  {
    key: 'fiscalita',
    slug: { it: 'tasse-e-imposte', en: 'taxes', de: 'steuern', fr: 'impots' },
    label: { it: 'Tasse e imposte', en: 'Taxes', de: 'Steuern', fr: 'Impôts' },
    intro: {
      it: 'Imposta alla fonte, dichiarazione dei redditi, ristorni e franchigia: cosa cambia per chi lavora in Svizzera.',
      en: 'Withholding tax, tax returns, refunds and allowances: what changes for cross-border workers in Switzerland.',
      de: 'Quellensteuer, Steuererklärung, Rückerstattungen und Freibetrag: was sich für Grenzgänger ändert.',
      fr: 'Impôt à la source, déclaration de revenus, ristournes et franchise : ce qui change pour les frontaliers.',
    },
    seedText:
      'tasse imposte fisco fiscale tassazione dichiarazione redditi ristorni franchigia aliquota irpef imposta fonte 730 detrazioni tributi imponibile',
  },
  {
    key: 'permesso-g',
    slug: { it: 'permesso-g', en: 'g-permit', de: 'g-bewilligung', fr: 'permis-g' },
    label: { it: 'Permesso G', en: 'G permit', de: 'G-Bewilligung', fr: 'Permis G' },
    intro: {
      it: 'Permesso G, statuto di frontaliere, notifica e domicilio: requisiti e procedure aggiornate.',
      en: 'G permit, cross-border status, notification and residence: current requirements and procedures.',
      de: 'G-Bewilligung, Grenzgängerstatus, Meldung und Wohnsitz: aktuelle Voraussetzungen und Verfahren.',
      fr: 'Permis G, statut de frontalier, notification et domicile : conditions et procédures à jour.',
    },
    seedText:
      'permesso permessi frontalierato autorizzazione soggiorno dimora residenza notifica statuto',
  },
  {
    key: 'salari-stipendi',
    slug: { it: 'salari-e-stipendi', en: 'salaries', de: 'loehne', fr: 'salaires' },
    label: { it: 'Salari e stipendi', en: 'Salaries', de: 'Löhne', fr: 'Salaires' },
    intro: {
      it: 'Stipendi in Svizzera, salari minimi, contratti collettivi e busta paga: i numeri che contano.',
      en: 'Swiss pay levels, minimum wages, collective agreements and payslips: the numbers that matter.',
      de: 'Schweizer Löhne, Mindestlöhne, Gesamtarbeitsverträge und Lohnabrechnung: die relevanten Zahlen.',
      fr: 'Salaires suisses, salaires minimums, conventions collectives et fiche de paie : les chiffres utiles.',
    },
    seedText:
      'stipendio stipendi salario salari retribuzione guadagno busta paga salariale minimo contratto collettivo',
  },
  {
    key: 'lavoro-mercato',
    slug: {
      it: 'lavoro-e-occupazione',
      en: 'jobs-and-employment',
      de: 'arbeit-und-beschaeftigung',
      fr: 'travail-et-emploi',
    },
    label: {
      it: 'Lavoro e occupazione',
      en: 'Jobs and employment',
      de: 'Arbeit und Beschäftigung',
      fr: 'Travail et emploi',
    },
    intro: {
      it: 'Mercato del lavoro ticinese, assunzioni, disoccupazione e settori che cercano frontalieri.',
      en: 'The Ticino labour market, hiring, unemployment and the sectors recruiting cross-border workers.',
      de: 'Tessiner Arbeitsmarkt, Einstellungen, Arbeitslosigkeit und Branchen, die Grenzgänger suchen.',
      fr: 'Marché du travail tessinois, embauches, chômage et secteurs qui recrutent des frontaliers.',
    },
    seedText:
      'lavoro lavoratori occupazione assunzioni aziende posti mercato disoccupazione impiego professione carriera',
  },
  {
    key: 'pensioni',
    slug: {
      it: 'pensioni-avs-lpp',
      en: 'pensions-avs-lpp',
      de: 'renten-ahv-bvg',
      fr: 'retraites-avs-lpp',
    },
    label: {
      it: 'Pensioni AVS e LPP',
      en: 'AVS and LPP pensions',
      de: 'AHV- und BVG-Renten',
      fr: 'Retraites AVS et LPP',
    },
    intro: {
      it: 'AVS, LPP, terzo pilastro e riscatto: come si costruisce la pensione di un frontaliere.',
      en: 'AVS, LPP, third pillar and buy-backs: how a cross-border worker builds a pension.',
      de: 'AHV, BVG, dritte Säule und Einkauf: wie Grenzgänger ihre Rente aufbauen.',
      fr: 'AVS, LPP, troisième pilier et rachat : comment un frontalier construit sa retraite.',
    },
    seedText:
      'pensione pensioni avs lpp rendita previdenza pilastro contributi vecchiaia riscatto',
  },
  {
    key: 'salute-assicurazione',
    slug: {
      it: 'salute-e-cassa-malati',
      en: 'health-insurance',
      de: 'gesundheit-krankenkasse',
      fr: 'sante-assurance-maladie',
    },
    label: {
      it: 'Salute e cassa malati',
      en: 'Health and insurance',
      de: 'Gesundheit und Krankenkasse',
      fr: 'Santé et assurance maladie',
    },
    intro: {
      it: 'LAMal o CMI, premi, franchigia e cure: la copertura sanitaria di chi lavora oltre confine.',
      en: 'LAMal or CMI, premiums, deductibles and care: health cover for those working across the border.',
      de: 'LAMal oder CMI, Prämien, Franchise und Pflege: der Krankenversicherungsschutz für Grenzgänger.',
      fr: 'LAMal ou CMI, primes, franchise et soins : la couverture santé de ceux qui travaillent au-delà.',
    },
    seedText:
      'salute sanitario sanita cassa malati lamal cmi assicurazione premi medico ospedale cure franchigia malattia',
  },
  {
    key: 'trasporti',
    slug: {
      it: 'trasporti-e-traffico',
      en: 'transport-and-traffic',
      de: 'verkehr-und-transport',
      fr: 'transports-et-trafic',
    },
    label: {
      it: 'Trasporti e traffico',
      en: 'Transport and traffic',
      de: 'Verkehr und Transport',
      fr: 'Transports et trafic',
    },
    intro: {
      it: 'Treni TILO, abbonamenti, autostrade e code: come si sposta ogni giorno chi fa il frontaliere.',
      en: 'TILO trains, season tickets, motorways and queues: the daily commute across the border.',
      de: 'TILO-Züge, Abonnemente, Autobahnen und Staus: der tägliche Weg der Grenzgänger.',
      fr: 'Trains TILO, abonnements, autoroutes et files : le trajet quotidien des frontaliers.',
    },
    seedText:
      'treno treni tilo trenord ferroviario autobus abbonamento trasporti traffico autostrada coda pendolari mobilita',
  },
  {
    key: 'confine-dogana',
    slug: {
      it: 'confine-e-dogana',
      en: 'border-and-customs',
      de: 'grenze-und-zoll',
      fr: 'frontiere-et-douane',
    },
    label: {
      it: 'Confine e dogana',
      en: 'Border and customs',
      de: 'Grenze und Zoll',
      fr: 'Frontière et douane',
    },
    intro: {
      it: 'Valichi, tempi di attesa, controlli doganali e transito: la frontiera giorno per giorno.',
      en: 'Crossings, waiting times, customs checks and transit: the border day by day.',
      de: 'Grenzübergänge, Wartezeiten, Zollkontrollen und Transit: die Grenze Tag für Tag.',
      fr: 'Passages, temps d’attente, contrôles douaniers et transit : la frontière au jour le jour.',
    },
    seedText:
      'dogana doganale valico confine frontiera controlli guardie brogeda chiasso ponte transito',
  },
  {
    key: 'sicurezza-cronaca',
    slug: {
      it: 'sicurezza-e-cronaca',
      en: 'safety-and-crime',
      de: 'sicherheit-und-kriminalitaet',
      fr: 'securite-et-faits-divers',
    },
    label: {
      it: 'Sicurezza e cronaca',
      en: 'Safety and crime',
      de: 'Sicherheit und Kriminalität',
      fr: 'Sécurité et faits divers',
    },
    intro: {
      it: 'Controlli, incidenti, indagini e sicurezza sul territorio tra Ticino e province di confine.',
      en: 'Checks, accidents, investigations and public safety across Ticino and the border provinces.',
      de: 'Kontrollen, Unfälle, Ermittlungen und Sicherheit im Tessin und den Grenzprovinzen.',
      fr: 'Contrôles, accidents, enquêtes et sécurité entre le Tessin et les provinces frontalières.',
    },
    seedText:
      'polizia arrestato arrestati incidente ferito sequestro furto rapina droga indagine processo condanna',
  },
  {
    key: 'casa-affitti',
    slug: {
      it: 'casa-e-affitti',
      en: 'housing-and-rent',
      de: 'wohnen-und-miete',
      fr: 'logement-et-loyers',
    },
    label: {
      it: 'Casa e affitti',
      en: 'Housing and rent',
      de: 'Wohnen und Miete',
      fr: 'Logement et loyers',
    },
    intro: {
      it: 'Affitti, mutui e mercato immobiliare tra Ticino e fascia di confine: costi e diritti.',
      en: 'Rents, mortgages and the property market in Ticino and the border belt: costs and rights.',
      de: 'Mieten, Hypotheken und Immobilienmarkt im Tessin und Grenzgebiet: Kosten und Rechte.',
      fr: 'Loyers, hypothèques et marché immobilier au Tessin et en zone frontalière : coûts et droits.',
    },
    seedText:
      'casa abitazione affitto affitti alloggio immobiliare appartamento mutuo canone inquilini',
  },
  {
    key: 'franco-prezzi',
    slug: {
      it: 'franco-e-prezzi',
      en: 'franc-and-prices',
      de: 'franken-und-preise',
      fr: 'franc-et-prix',
    },
    label: {
      it: 'Franco e prezzi',
      en: 'Franc and prices',
      de: 'Franken und Preise',
      fr: 'Franc et prix',
    },
    intro: {
      it: 'Cambio euro-franco, inflazione e potere d’acquisto: quanto vale davvero uno stipendio svizzero.',
      en: 'Euro-franc exchange, inflation and purchasing power: what a Swiss salary is really worth.',
      de: 'Euro-Franken-Kurs, Inflation und Kaufkraft: was ein Schweizer Lohn wirklich wert ist.',
      fr: 'Change euro-franc, inflation et pouvoir d’achat : ce que vaut vraiment un salaire suisse.',
    },
    seedText:
      'franco cambio euro banca banche tasso inflazione prezzi rincari potere acquisto valuta',
  },
  {
    key: 'accordi-politica',
    slug: {
      it: 'accordi-e-politica',
      en: 'agreements-and-politics',
      de: 'abkommen-und-politik',
      fr: 'accords-et-politique',
    },
    label: {
      it: 'Accordi e politica',
      en: 'Agreements and politics',
      de: 'Abkommen und Politik',
      fr: 'Accords et politique',
    },
    intro: {
      it: 'Bilaterali, accordo fiscale, votazioni federali e riforme che toccano i frontalieri.',
      en: 'Bilateral treaties, the tax agreement, federal votes and reforms affecting cross-border workers.',
      de: 'Bilaterale, Steuerabkommen, eidgenössische Abstimmungen und Reformen für Grenzgänger.',
      fr: 'Bilatérales, accord fiscal, votations fédérales et réformes qui touchent les frontaliers.',
    },
    seedText:
      'accordo accordi bilaterali parlamento consiglio federale iniziativa votazione referendum legge riforma governo',
  },
  {
    key: 'energia-carburanti',
    slug: {
      it: 'energia-e-carburanti',
      en: 'energy-and-fuel',
      de: 'energie-und-treibstoff',
      fr: 'energie-et-carburants',
    },
    label: {
      it: 'Energia e carburanti',
      en: 'Energy and fuel',
      de: 'Energie und Treibstoff',
      fr: 'Énergie et carburants',
    },
    intro: {
      it: 'Benzina, diesel, elettricità e dove conviene fare il pieno tra Italia e Svizzera.',
      en: 'Petrol, diesel, electricity and where it pays to fill up between Italy and Switzerland.',
      de: 'Benzin, Diesel, Strom und wo sich das Tanken zwischen Italien und der Schweiz lohnt.',
      fr: 'Essence, diesel, électricité et où faire le plein entre l’Italie et la Suisse.',
    },
    seedText:
      'benzina carburante carburanti diesel energia elettricita distributori rifornimento gasolio',
  },
  {
    key: 'famiglia-scuola',
    slug: {
      it: 'famiglia-e-scuola',
      en: 'family-and-school',
      de: 'familie-und-schule',
      fr: 'famille-et-ecole',
    },
    label: {
      it: 'Famiglia e scuola',
      en: 'Family and school',
      de: 'Familie und Schule',
      fr: 'Famille et école',
    },
    intro: {
      it: 'Assegni familiari, asili, scuola e apprendistato: la vita familiare di chi lavora oltre confine.',
      en: 'Family allowances, childcare, school and apprenticeships: family life for cross-border workers.',
      de: 'Familienzulagen, Kitas, Schule und Lehre: das Familienleben der Grenzgänger.',
      fr: 'Allocations familiales, crèches, école et apprentissage : la vie de famille des frontaliers.',
    },
    seedText:
      'famiglia famiglie assegni figli scuola scuole studenti apprendisti giovani asilo formazione',
  },
];

/** Localized URL segment that groups every topic hub under a section archive. */
export const TOPIC_HUB_SEGMENT: Record<TopicLocale, string> = {
  it: 'argomenti',
  en: 'topics',
  de: 'themen',
  fr: 'sujets',
};

/**
 * Title of the page that segment resolves to on its own — the bare topic index
 * at `/{section}/{TOPIC_HUB_SEGMENT}/` (issue #5436), which used to be a 404
 * between an archive that linked 14 topic hubs and 14 hubs that all answered
 * 200.
 *
 * ONE table, read by both sides of that link. `articleHubPagesPlugin.ts` uses
 * it as the archive nav's anchor text and `build-plugins/topicClusterHubsPlugin.ts`
 * as the destination's `<h1>` and `<title>`: anchor text and destination
 * heading agree BY CONSTRUCTION rather than by two literals that happen to
 * match today (AGENTS.md #6). It lives here, with the segment it names, for
 * the same reason TOPIC_HUB_MIN_ARTICLES does — the engine may not import
 * `build-plugins/**`, so anything both sides need has to be on this side.
 */
export const TOPIC_INDEX_TITLE: Record<TopicLocale, string> = {
  it: 'Tutti gli argomenti',
  en: 'All topics',
  de: 'Alle Themen',
  fr: 'Tous les sujets',
};

/**
 * Minimum articles for a topic hub to be indexable in a given (section,
 * locale). Below it the page is still emitted — as a `noindex,follow` bridge —
 * so the URL never 404s, but it does not enter the sitemap.
 *
 * 8 is the same floor the cluster measurement used: it is the point below
 * which a hub is a list too short to be worth a crawl of its own, while still
 * being low enough that real but small topics (energy/fuel on the svizzera
 * section: 8 articles) keep a live hub.
 *
 * Lives HERE (issue #5414) — not in `build-plugins/topicClusterHubsData.ts`,
 * which re-exports it — because the floor is part of "which topic hubs exist
 * as indexable pages", the truth this taxonomy pins. The archive pages'
 * "Argomenti" nav (`articleHubPagesPlugin.ts`) must link exactly the eligible
 * hubs and, being engine code, cannot import from `build-plugins/**` (the
 * confinement `tests/packages-articles-confinement.test.ts` proves). A second
 * literal `8` on the engine side would be the AGENTS.md #6 drift that links
 * noindex bridges the day one copy moves.
 */
export const TOPIC_HUB_MIN_ARTICLES = 8;

/** Lookup by stable key. */
export const TOPIC_CLUSTER_BY_KEY: ReadonlyMap<string, TopicClusterDefinition> = new Map(
  TOPIC_CLUSTERS.map((t) => [t.key, t]),
);
