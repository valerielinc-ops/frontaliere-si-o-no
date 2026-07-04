/**
 * Editorial copy for the "frontaliere" pillar hub (#3393) — 4 locales.
 *
 * Orchestration-only content: every section is a short, self-contained
 * primer that hands off to the existing deep page via inline links
 * (trailing-slash canonical, per CLAUDE.md). No section duplicates the
 * child pages — the pillar answers "what do I need to know" and routes.
 *
 * Regulatory claims cite the primary source in the sources block
 * (SEM permits, UST cross-border statistics, AFC 2023 tax agreement,
 * UFSP LAMal option right).
 */

import type { ProfessionId } from './professionLandingsData';

export interface FrontalierePillarCopy {
  readonly title: string;
  readonly description: string;
  readonly eyebrow: string;
  readonly h1: string;
  readonly lede: string;
  readonly breadcrumbHome: string;
  readonly breadcrumbGuide: string;
  readonly guideHubHref: string;
  readonly statTiles: ReadonlyArray<{ value: string; label: string }>;
  readonly primaryCtaLabel: string;
  readonly primaryCtaHref: string;
  readonly sections: ReadonlyArray<{ heading: string; paragraphsHtml: readonly string[] }>;
  readonly professionsHeading: string;
  readonly professionsIntro: string;
  readonly faqHeading: string;
  readonly faqs: ReadonlyArray<{ question: string; answer: string }>;
  readonly relatedHeading: string;
  readonly related: ReadonlyArray<{ href: string; label: string }>;
  readonly sourcesLabel: string;
  readonly sources: ReadonlyArray<{ label: string; url: string }>;
}

/** Professions surfaced in the "find work by profession" section — the
 * healthcare cluster the pillar was built to expose, plus the strongest
 * existing landings. Paths come from buildProfessionLandingPath so the
 * locale variants are correct by construction. */
export const PILLAR_PROFESSION_IDS: readonly ProfessionId[] = [
  'infermiere',
  'psicologo',
  'fisioterapista',
  'oss',
  'farmacista',
  'ostetrica',
  'tecnico-radiologia',
  'contabile',
];

const IT: FrontalierePillarCopy = {
  title: 'Frontaliere in Svizzera: guida completa 2026',
  description:
    'Permesso G, stipendio, tasse, cassa malati e lavoro in Ticino: tutto quello che serve a un frontaliere, con calcolatori e guide passo-passo.',
  eyebrow: 'Guida frontaliere',
  h1: 'Frontaliere in Svizzera: la guida completa',
  lede: 'Permesso G, stipendio netto, tasse e cassa malati: il percorso completo in una pagina.',
  breadcrumbHome: 'Home',
  breadcrumbGuide: 'Guida frontaliere',
  guideHubHref: '/guida-frontaliere/',
  statTiles: [
    { value: '~80.000', label: 'frontalieri attivi in Ticino (UST)' },
    { value: '24', label: 'guide di lavoro per professione' },
    { value: '4', label: 'temi chiave: permesso, stipendio, tasse, salute' },
  ],
  primaryCtaLabel: 'Calcola il tuo stipendio netto da frontaliere',
  primaryCtaHref: '/calcola-stipendio/',
  sections: [
    {
      heading: 'Chi è frontaliere e come funziona il permesso G',
      paragraphsHtml: [
        'Il frontaliere è un lavoratore residente in Italia (o in un altro Stato UE/AELS) impiegato in Svizzera che rientra al proprio domicilio almeno una volta alla settimana. Il documento che autorizza il lavoro è il <strong>permesso G</strong>, richiesto dal datore di lavoro al momento dell\'assunzione e rinnovabile. I requisiti, i tempi e i documenti sono spiegati passo-passo nella <a href="/guida-frontaliere/permessi-di-lavoro/">guida ai permessi di lavoro</a>; se stai valutando il trasferimento in Svizzera, il <a href="/guida-frontaliere/confronta-permesso-g-vs-b/">confronto permesso G vs B</a> mette i due statuti fianco a fianco.',
      ],
    },
    {
      heading: 'Quanto guadagna un frontaliere: stipendio lordo e netto',
      paragraphsHtml: [
        'Lo stipendio svizzero si valuta al netto di contributi AVS, LPP, imposta alla fonte e cassa malati: la cifra lorda da sola dice poco. Il <a href="/calcola-stipendio/">calcolatore dello stipendio netto</a> applica aliquote e deduzioni reali del tuo cantone e stato civile; per capire se un\'offerta è competitiva rispetto all\'Italia c\'è il <a href="/statistiche/confronta-stipendi/">confronto stipendi Italia–Svizzera</a> per ruolo.',
      ],
    },
    {
      heading: 'Tasse del frontaliere: vecchi e nuovi, imposta alla fonte',
      paragraphsHtml: [
        'Dal 2024 convivono due regimi: i <strong>«vecchi» frontalieri</strong> (assunti prima del 17 luglio 2023) restano tassati solo in Svizzera, mentre i <strong>«nuovi»</strong> pagano l\'imposta alla fonte svizzera ridotta e dichiarano anche in Italia con credito d\'imposta. La <a href="/tasse-e-pensione/simulazione-tasse-nuovi-frontalieri/">simulazione per nuovi frontalieri</a> stima l\'impatto reale; le <a href="/tasse-e-pensione/aliquote-imposta-alla-fonte-ticino-2026/">aliquote alla fonte Ticino 2026</a> e la guida alla <a href="/tasse-e-pensione/dichiarazione-redditi/">dichiarazione dei redditi</a> completano il quadro.',
      ],
    },
    {
      heading: 'Cassa malati: il diritto d\'opzione LAMal',
      paragraphsHtml: [
        'Entro 3 mesi dall\'assunzione il frontaliere sceglie tra assicurazione svizzera <strong>LAMal</strong> e sistema sanitario italiano (diritto d\'opzione, in linea di massima irrevocabile). I <a href="/premi-cassa-malati/">premi di cassa malati per frontalieri</a> variano molto per assicuratore: il <a href="/compara-servizi/confronta-casse-malati/">comparatore casse malati</a> mette a confronto i premi correnti, mentre la <a href="/guida-frontaliere/lamal-frontalieri/">guida LAMal frontalieri</a> spiega vincoli e eccezioni.',
      ],
    },
    {
      heading: 'Vivere al confine: comuni, valichi e tempi di attesa',
      paragraphsHtml: [
        'Dove abiti cambia il pendolarismo: i <a href="/vivere-in-ticino/comuni-di-frontiera/">comuni di frontiera</a> raccolgono affitti, servizi e distanze dai valichi, la <a href="/guida-frontaliere/mappa-confine/">mappa del confine</a> mostra i valichi principali e i <a href="/guida-frontaliere/tempi-attesa-dogana/">tempi di attesa in dogana</a> sono aggiornati in continuo. Tutte le guide pratiche (primo giorno, disoccupazione, auto) vivono nella <a href="/guida-frontaliere/">guida frontaliere</a>.',
      ],
    },
  ],
  professionsHeading: 'Trova lavoro in Ticino per professione',
  professionsIntro:
    'Ogni professione ha requisiti di riconoscimento, salari e datori diversi: le guide per ruolo raccolgono annunci reali, iter di riconoscimento del titolo (CRS, MEBEKO, SEFRI) e range salariali. Tutte le offerte sono su <a href="/cerca-lavoro-ticino/">cerca lavoro Ticino</a>.',
  faqHeading: 'Domande frequenti',
  faqs: [
    {
      question: 'Chi può lavorare come frontaliere in Svizzera?',
      answer:
        'I cittadini UE/AELS residenti in un comune estero che rientrano al domicilio almeno una volta alla settimana. Serve un contratto di lavoro svizzero: il datore richiede il permesso G alle autorità cantonali.',
    },
    {
      question: 'Quanto guadagna in media un frontaliere in Ticino?',
      answer:
        'Dipende dal ruolo: le mediane degli annunci vanno da circa 54.000 CHF lordi/anno per le professioni di cura di base a oltre 90.000 CHF per farmacisti e profili ingegneristici. Il calcolatore stima il netto reale per cantone e stato civile.',
    },
    {
      question: 'Che differenza c\'è tra vecchi e nuovi frontalieri per le tasse?',
      answer:
        'Chi era già assunto in Svizzera prima del 17 luglio 2023 resta tassato solo alla fonte in Svizzera. Chi è stato assunto dopo paga un\'imposta alla fonte svizzera ridotta e dichiara il reddito anche in Italia, con credito per le imposte svizzere.',
    },
    {
      question: 'Il frontaliere deve pagare la cassa malati svizzera?',
      answer:
        'Può scegliere entro 3 mesi dall\'assunzione tra LAMal svizzera e iscrizione al SSN italiano tramite il diritto d\'opzione. La scelta è in linea di principio definitiva, salvo eventi come matrimonio o nascita di un figlio.',
    },
    {
      question: 'Quanto tempo serve per ottenere il permesso G?',
      answer:
        'In Ticino tipicamente poche settimane dalla richiesta del datore di lavoro, se il dossier è completo. Il rinnovo è quinquennale per i contratti a tempo indeterminato.',
    },
  ],
  relatedHeading: 'Approfondisci',
  related: [
    { href: '/cerca-lavoro-ticino/', label: 'Tutte le offerte di lavoro in Ticino' },
    { href: '/calcola-stipendio/', label: 'Calcolatore stipendio netto frontaliere' },
    { href: '/tasse-e-pensione/simulazione-tasse-nuovi-frontalieri/', label: 'Simulazione tasse nuovi frontalieri' },
    { href: '/premi-cassa-malati/', label: 'Premi cassa malati per frontalieri' },
    { href: '/vivere-in-ticino/comuni-di-frontiera/', label: 'Comuni di frontiera: dove conviene vivere' },
    { href: '/statistiche/confronta-stipendi/', label: 'Confronto stipendi Italia vs Svizzera' },
  ],
  sourcesLabel: 'Fonti',
  sources: [
    { label: 'UST — Statistica dei frontalieri', url: 'https://www.bfs.admin.ch/it' },
    { label: 'SEM — Permesso per frontalieri G', url: 'https://www.sem.admin.ch/it' },
    { label: 'AFC — Imposizione dei frontalieri (accordo CH-IT 2023)', url: 'https://www.estv.admin.ch/it' },
    { label: 'UFSP — Assicurazione malattie: frontalieri e diritto d\'opzione', url: 'https://www.bag.admin.ch/it' },
  ],
};

const EN: FrontalierePillarCopy = {
  title: 'Cross-border worker in Switzerland: complete 2026 guide',
  description:
    'G permit, net salary, taxes, health insurance and jobs in Ticino: everything a cross-border worker needs, with calculators and step-by-step guides.',
  eyebrow: 'Cross-border guide',
  h1: 'Working in Switzerland as a cross-border commuter',
  lede: 'G permit, net salary, taxes and health insurance: the full path on one page.',
  breadcrumbHome: 'Home',
  breadcrumbGuide: 'Cross-border guide',
  guideHubHref: '/en/cross-border-guide/',
  statTiles: [
    { value: '~80,000', label: 'active cross-border workers in Ticino (FSO)' },
    { value: '24', label: 'per-profession job guides' },
    { value: '4', label: 'key topics: permit, salary, taxes, health' },
  ],
  primaryCtaLabel: 'Calculate your net Swiss salary',
  primaryCtaHref: '/en/calculate-salary/',
  sections: [
    {
      heading: 'Who counts as a cross-border worker and how the G permit works',
      paragraphsHtml: [
        'A cross-border worker lives in Italy (or another EU/EFTA state) and works in Switzerland, returning home at least weekly. Work is authorised by the <strong>G permit</strong>, requested by the employer at hiring and renewable. Requirements and timelines are covered in the cross-border guide.',
      ],
    },
    {
      heading: 'What a cross-border worker earns: gross vs net',
      paragraphsHtml: [
        'A Swiss salary only makes sense net of AVS contributions, occupational pension (LPP), withholding tax and health insurance. The <a href="/en/calculate-salary/">net salary calculator</a> applies real cantonal rates; the <a href="/en/statistics/compare-salaries/">Italy vs Switzerland salary comparison</a> benchmarks offers by role.',
      ],
    },
    {
      heading: 'Taxes: “old” vs “new” cross-border workers',
      paragraphsHtml: [
        'Since the 2023 CH-IT agreement two regimes coexist: workers hired before 17 July 2023 are taxed at source in Switzerland only, while those hired later pay a reduced Swiss withholding tax and also file in Italy with a tax credit. The Italian-language tax simulator estimates the real impact for new hires.',
      ],
    },
    {
      heading: 'Health insurance: the LAMal option right',
      paragraphsHtml: [
        'Within 3 months of hiring, cross-border workers choose between Swiss <strong>LAMal</strong> insurance and the Italian health system — a choice that is in principle irrevocable. Premiums vary widely by insurer; the site\'s comparator tracks current cross-border premiums.',
      ],
    },
    {
      heading: 'Living at the border',
      paragraphsHtml: [
        'Where you live drives the commute: border municipality pages collect rents, services and distances to crossings, and customs waiting times are updated continuously in the <a href="/en/cross-border-guide/">cross-border guide</a>.',
      ],
    },
  ],
  professionsHeading: 'Find work in Ticino by profession',
  professionsIntro:
    'Each profession has its own recognition path (SRC, MEBEKO, SEFRI), salaries and employers: the per-role guides collect real openings and requirements. All openings live on <a href="/en/find-jobs-ticino/">the Ticino job board</a>.',
  faqHeading: 'Frequently asked questions',
  faqs: [
    {
      question: 'Who can work as a cross-border commuter in Switzerland?',
      answer:
        'EU/EFTA citizens resident abroad who return home at least once a week. A Swiss employment contract is required: the employer applies for the G permit with the cantonal authorities.',
    },
    {
      question: 'How much does a cross-border worker earn in Ticino?',
      answer:
        'It depends on the role: posting medians range from about CHF 54,000 gross/year for basic care roles to over CHF 90,000 for pharmacists and engineering profiles. The calculator estimates the real net amount.',
    },
    {
      question: 'What changed with the 2023 tax agreement?',
      answer:
        'Workers already employed in Switzerland before 17 July 2023 remain taxed at source in Switzerland only. Those hired later pay a reduced Swiss withholding tax and also declare the income in Italy with a credit for Swiss taxes.',
    },
    {
      question: 'Do cross-border workers pay Swiss health insurance?',
      answer:
        'They choose within 3 months of hiring between Swiss LAMal and the Italian national health system (option right). The choice is in principle final, barring life events such as marriage or the birth of a child.',
    },
    {
      question: 'How long does the G permit take?',
      answer:
        'Typically a few weeks from the employer\'s application in Ticino, if the file is complete. Renewal is five-yearly for permanent contracts.',
    },
  ],
  relatedHeading: 'Go deeper',
  related: [
    { href: '/en/find-jobs-ticino/', label: 'All Ticino job openings' },
    { href: '/en/calculate-salary/', label: 'Cross-border net salary calculator' },
    { href: '/en/statistics/compare-salaries/', label: 'Italy vs Switzerland salary comparison' },
    { href: '/en/nursing-jobs-switzerland/', label: 'Nursing jobs in Switzerland' },
    { href: '/en/cross-border-guide/', label: 'Cross-border guide' },
  ],
  sourcesLabel: 'Sources',
  sources: [
    { label: 'FSO — Cross-border commuter statistics', url: 'https://www.bfs.admin.ch/en' },
    { label: 'SEM — Cross-border commuter permit G', url: 'https://www.sem.admin.ch/en' },
    { label: 'FTA — Taxation of cross-border commuters (2023 CH-IT agreement)', url: 'https://www.estv.admin.ch/en' },
    { label: 'FOPH — Health insurance for cross-border commuters', url: 'https://www.bag.admin.ch/en' },
  ],
};

const DE: FrontalierePillarCopy = {
  title: 'Grenzgänger in der Schweiz: der komplette Ratgeber 2026',
  description:
    'G-Bewilligung, Nettolohn, Steuern, Krankenkasse und Stellen im Tessin: alles, was Grenzgänger brauchen — mit Rechnern und Schritt-für-Schritt-Guides.',
  eyebrow: 'Grenzgänger-Ratgeber',
  h1: 'Als Grenzgänger in der Schweiz arbeiten',
  lede: 'G-Bewilligung, Nettolohn, Steuern und Krankenkasse: der ganze Weg auf einer Seite.',
  breadcrumbHome: 'Home',
  breadcrumbGuide: 'Grenzgänger-Ratgeber',
  guideHubHref: '/de/grenzgaenger-ratgeber/',
  statTiles: [
    { value: '~80\'000', label: 'aktive Grenzgänger im Tessin (BFS)' },
    { value: '24', label: 'Stellen-Guides pro Beruf' },
    { value: '4', label: 'Kernthemen: Bewilligung, Lohn, Steuern, Gesundheit' },
  ],
  primaryCtaLabel: 'Nettolohn als Grenzgänger berechnen',
  primaryCtaHref: '/de/gehalt-berechnen/',
  sections: [
    {
      heading: 'Wer Grenzgänger ist und wie die G-Bewilligung funktioniert',
      paragraphsHtml: [
        'Grenzgänger wohnen in Italien (oder einem anderen EU/EFTA-Staat), arbeiten in der Schweiz und kehren mindestens wöchentlich an den Wohnort zurück. Die Arbeit autorisiert die <strong>G-Bewilligung</strong>, die der Arbeitgeber bei der Anstellung beantragt; sie ist erneuerbar.',
      ],
    },
    {
      heading: 'Was Grenzgänger verdienen: brutto vs. netto',
      paragraphsHtml: [
        'Ein Schweizer Lohn zählt erst netto — nach AHV, BVG, Quellensteuer und Krankenkasse. Der <a href="/de/gehalt-berechnen/">Nettolohn-Rechner</a> rechnet mit echten kantonalen Sätzen; der <a href="/de/statistiken/gehaelter-vergleichen/">Lohnvergleich Italien vs. Schweiz</a> ordnet Angebote nach Beruf ein.',
      ],
    },
    {
      heading: 'Steuern: «alte» vs. «neue» Grenzgänger',
      paragraphsHtml: [
        'Seit dem CH-IT-Abkommen 2023 gelten zwei Regime: Wer vor dem 17. Juli 2023 angestellt wurde, bleibt nur in der Schweiz quellenbesteuert; später Angestellte zahlen eine reduzierte Schweizer Quellensteuer und deklarieren zusätzlich in Italien mit Steueranrechnung.',
      ],
    },
    {
      heading: 'Krankenkasse: das Optionsrecht (KVG/LAMal)',
      paragraphsHtml: [
        'Innert 3 Monaten nach Stellenantritt wählen Grenzgänger zwischen Schweizer <strong>KVG-Versicherung</strong> und italienischem Gesundheitssystem — grundsätzlich unwiderruflich. Die Prämien unterscheiden sich stark je nach Versicherer.',
      ],
    },
    {
      heading: 'Leben an der Grenze',
      paragraphsHtml: [
        'Der Wohnort bestimmt das Pendeln: Grenzgemeinden-Seiten sammeln Mieten, Services und Distanzen zu den Übergängen; die Wartezeiten am Zoll werden laufend aktualisiert — alles im <a href="/de/grenzgaenger-ratgeber/">Grenzgänger-Ratgeber</a>.',
      ],
    },
  ],
  professionsHeading: 'Arbeit im Tessin nach Beruf finden',
  professionsIntro:
    'Jeder Beruf hat eigene Anerkennungswege (SRK, MEBEKO, SEFRI), Löhne und Arbeitgeber: die Berufs-Guides bündeln echte Stellen und Anforderungen. Alle Angebote auf <a href="/de/jobs-im-tessin/">der Tessiner Stellenbörse</a>.',
  faqHeading: 'Häufige Fragen',
  faqs: [
    {
      question: 'Wer kann als Grenzgänger in der Schweiz arbeiten?',
      answer:
        'EU/EFTA-Bürger mit Wohnsitz im Ausland, die mindestens wöchentlich nach Hause zurückkehren. Nötig ist ein Schweizer Arbeitsvertrag: der Arbeitgeber beantragt die G-Bewilligung beim Kanton.',
    },
    {
      question: 'Wie viel verdient ein Grenzgänger im Tessin?',
      answer:
        'Je nach Beruf: die Median-Inserate reichen von rund CHF 54\'000 brutto/Jahr in der Grundpflege bis über CHF 90\'000 für Apotheker und Ingenieurprofile. Der Rechner schätzt den echten Nettolohn.',
    },
    {
      question: 'Was änderte das Steuerabkommen 2023?',
      answer:
        'Wer vor dem 17. Juli 2023 in der Schweiz angestellt war, bleibt nur in der Schweiz quellenbesteuert. Später Angestellte zahlen eine reduzierte Quellensteuer und deklarieren das Einkommen zusätzlich in Italien mit Anrechnung.',
    },
    {
      question: 'Müssen Grenzgänger die Schweizer Krankenkasse zahlen?',
      answer:
        'Sie wählen innert 3 Monaten zwischen KVG und italienischem Gesundheitssystem (Optionsrecht). Die Wahl ist grundsätzlich definitiv, ausser bei Ereignissen wie Heirat oder Geburt.',
    },
    {
      question: 'Wie lange dauert die G-Bewilligung?',
      answer:
        'Im Tessin typischerweise wenige Wochen ab Antrag des Arbeitgebers, sofern das Dossier vollständig ist. Erneuerung alle fünf Jahre bei unbefristeten Verträgen.',
    },
  ],
  relatedHeading: 'Vertiefen',
  related: [
    { href: '/de/jobs-im-tessin/', label: 'Alle Tessin-Stellenangebote' },
    { href: '/de/gehalt-berechnen/', label: 'Grenzgänger-Gehaltsrechner' },
    { href: '/de/statistiken/gehaelter-vergleichen/', label: 'Lohnvergleich Italien vs. Schweiz' },
    { href: '/de/pflegejobs-schweiz/', label: 'Pflegestellen in der Schweiz' },
    { href: '/de/grenzgaenger-ratgeber/', label: 'Grenzgänger-Ratgeber' },
  ],
  sourcesLabel: 'Quellen',
  sources: [
    { label: 'BFS — Grenzgängerstatistik', url: 'https://www.bfs.admin.ch/de' },
    { label: 'SEM — Grenzgängerbewilligung G', url: 'https://www.sem.admin.ch/de' },
    { label: 'ESTV — Besteuerung der Grenzgänger (Abkommen CH-IT 2023)', url: 'https://www.estv.admin.ch/de' },
    { label: 'BAG — Krankenversicherung für Grenzgänger', url: 'https://www.bag.admin.ch/de' },
  ],
};

const FR: FrontalierePillarCopy = {
  title: 'Frontalier en Suisse : le guide complet 2026',
  description:
    'Permis G, salaire net, impôts, caisse maladie et emploi au Tessin : tout ce qu\'il faut à un frontalier, avec calculateurs et guides pas à pas.',
  eyebrow: 'Guide frontalier',
  h1: 'Travailler en Suisse comme frontalier',
  lede: 'Permis G, salaire net, impôts et caisse maladie : le parcours complet sur une page.',
  breadcrumbHome: 'Accueil',
  breadcrumbGuide: 'Guide frontalier',
  guideHubHref: '/fr/guide-frontalier/',
  statTiles: [
    { value: '~80 000', label: 'frontaliers actifs au Tessin (OFS)' },
    { value: '24', label: 'guides emploi par profession' },
    { value: '4', label: 'thèmes clés : permis, salaire, impôts, santé' },
  ],
  primaryCtaLabel: 'Calculer votre salaire net de frontalier',
  primaryCtaHref: '/fr/calculer-salaire/',
  sections: [
    {
      heading: 'Qui est frontalier et comment fonctionne le permis G',
      paragraphsHtml: [
        'Le frontalier réside en Italie (ou dans un autre État UE/AELE), travaille en Suisse et rentre chez lui au moins une fois par semaine. Le travail est autorisé par le <strong>permis G</strong>, demandé par l\'employeur à l\'embauche et renouvelable.',
      ],
    },
    {
      heading: 'Combien gagne un frontalier : brut vs net',
      paragraphsHtml: [
        'Un salaire suisse s\'évalue net — après AVS, LPP, impôt à la source et caisse maladie. Le <a href="/fr/calculer-salaire/">calculateur de salaire net</a> applique les taux cantonaux réels ; la <a href="/fr/statistiques/comparer-salaires/">comparaison salaires Italie–Suisse</a> situe chaque offre par métier.',
      ],
    },
    {
      heading: 'Impôts : « anciens » vs « nouveaux » frontaliers',
      paragraphsHtml: [
        'Depuis l\'accord CH-IT de 2023, deux régimes coexistent : les frontaliers embauchés avant le 17 juillet 2023 restent imposés à la source uniquement en Suisse ; les nouveaux paient un impôt à la source suisse réduit et déclarent aussi en Italie avec crédit d\'impôt.',
      ],
    },
    {
      heading: 'Caisse maladie : le droit d\'option LAMal',
      paragraphsHtml: [
        'Dans les 3 mois suivant l\'embauche, le frontalier choisit entre l\'assurance suisse <strong>LAMal</strong> et le système de santé italien — un choix en principe irrévocable. Les primes varient fortement selon l\'assureur.',
      ],
    },
    {
      heading: 'Vivre à la frontière',
      paragraphsHtml: [
        'Le lieu de résidence détermine le trajet : les pages des communes frontalières rassemblent loyers, services et distances aux postes-frontière ; les temps d\'attente en douane sont mis à jour en continu — tout est dans le <a href="/fr/guide-frontalier/">guide frontalier</a>.',
      ],
    },
  ],
  professionsHeading: 'Trouver un emploi au Tessin par profession',
  professionsIntro:
    'Chaque profession a son parcours de reconnaissance (CRS, MEBEKO, SEFRI), ses salaires et ses employeurs : les guides par métier réunissent offres réelles et prérequis. Toutes les offres sur <a href="/fr/trouver-emploi-tessin/">la bourse d\'emploi du Tessin</a>.',
  faqHeading: 'Questions fréquentes',
  faqs: [
    {
      question: 'Qui peut travailler comme frontalier en Suisse ?',
      answer:
        'Les citoyens UE/AELE résidant à l\'étranger qui rentrent chez eux au moins une fois par semaine. Il faut un contrat de travail suisse : l\'employeur demande le permis G au canton.',
    },
    {
      question: 'Combien gagne un frontalier au Tessin ?',
      answer:
        'Selon le métier : les médianes des annonces vont d\'environ 54 000 CHF bruts/an pour les soins de base à plus de 90 000 CHF pour les pharmaciens et profils d\'ingénierie. Le calculateur estime le net réel.',
    },
    {
      question: 'Qu\'a changé l\'accord fiscal de 2023 ?',
      answer:
        'Les frontaliers déjà employés en Suisse avant le 17 juillet 2023 restent imposés à la source uniquement en Suisse. Les nouveaux paient un impôt à la source réduit et déclarent aussi le revenu en Italie avec crédit d\'impôt.',
    },
    {
      question: 'Le frontalier doit-il payer la caisse maladie suisse ?',
      answer:
        'Il choisit dans les 3 mois entre la LAMal suisse et le système de santé italien (droit d\'option). Le choix est en principe définitif, sauf événements comme mariage ou naissance.',
    },
    {
      question: 'Combien de temps pour obtenir le permis G ?',
      answer:
        'Au Tessin, généralement quelques semaines après la demande de l\'employeur, si le dossier est complet. Renouvellement quinquennal pour les contrats à durée indéterminée.',
    },
  ],
  relatedHeading: 'Approfondir',
  related: [
    { href: '/fr/trouver-emploi-tessin/', label: 'Toutes les offres du Tessin' },
    { href: '/fr/calculer-salaire/', label: 'Calculateur salaire frontalier' },
    { href: '/fr/statistiques/comparer-salaires/', label: 'Comparaison salaires Italie vs Suisse' },
    { href: '/fr/emplois-infirmiers-suisse/', label: 'Emplois infirmiers en Suisse' },
    { href: '/fr/guide-frontalier/', label: 'Guide frontalier' },
  ],
  sourcesLabel: 'Sources',
  sources: [
    { label: 'OFS — Statistique des frontaliers', url: 'https://www.bfs.admin.ch/fr' },
    { label: 'SEM — Autorisation frontalière G', url: 'https://www.sem.admin.ch/fr' },
    { label: 'AFC — Imposition des frontaliers (accord CH-IT 2023)', url: 'https://www.estv.admin.ch/fr' },
    { label: 'OFSP — Assurance-maladie des frontaliers', url: 'https://www.bag.admin.ch/fr' },
  ],
};

export const FRONTALIERE_PILLAR_COPY = { it: IT, en: EN, de: DE, fr: FR } as const;
