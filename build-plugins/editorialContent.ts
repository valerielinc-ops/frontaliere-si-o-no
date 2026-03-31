/**
 * Section-specific editorial content for non-Italian locale static pages.
 *
 * Keyed by Italian canonical path prefix (longest-first for prefix matching).
 * Each entry provides 2-3 unique paragraphs per locale so that Google sees
 * topically-relevant content instead of generic boilerplate. This directly
 * prevents soft-404 classification by search engines.
 *
 * Italian editorial content remains inline in staticPagesPlugin.ts.
 */

export type SectionEditorialMap = Record<string, Record<string, string[]>>;

export const SECTION_EDITORIAL: SectionEditorialMap = {
  // ───── Calculator ─────────────────────────────────────────────
  '/calcola-stipendio/simula-busta-paga': {
    en: [
      'The payslip simulator reconstructs your net salary step by step starting from the gross annual amount in Swiss francs: AVS/AI/IPG (5.3%), unemployment insurance (1.1%), non-occupational accident insurance, and daily sickness benefits are deducted before calculating the withholding tax.',
      'Withholding tax is computed using the Canton Ticino A/B/C/H tax tables, updated for 2026, accounting for marital status, number of children, and religious affiliation. The result is then converted to euros at the selected exchange rate to show real purchasing power in Italy.',
      'After the simulation you can compare the net result against actual cross-border living costs: transport, LAMal health insurance, lunches, parking, and car insurance with Swiss plates — giving you a realistic estimate of monthly savings.',
    ],
    de: [
      'Der Lohnabrechnungssimulator berechnet Ihr Nettogehalt Schritt für Schritt ab dem Bruttojahresbetrag in Schweizer Franken: AHV/IV/EO (5,3 %), Arbeitslosenversicherung (1,1 %), Nichtberufsunfallversicherung und Krankentaggeld werden vor der Quellensteuer abgezogen.',
      'Die Quellensteuer wird anhand der Tessiner Steuertabellen A/B/C/H berechnet, aktualisiert für 2026, unter Berücksichtigung von Familienstand, Kinderzahl und Konfession. Das Ergebnis wird zum gewählten Wechselkurs in Euro umgerechnet, um die reale Kaufkraft in Italien zu zeigen.',
      'Nach der Simulation können Sie das Nettoergebnis mit den tatsächlichen Grenzgänger-Lebenshaltungskosten vergleichen: Transport, LAMal-Versicherung, Mittagessen, Parkplatz und Autoversicherung mit Schweizer Kennzeichen.',
    ],
    fr: [
      'Le simulateur de fiche de paie reconstitue votre salaire net étape par étape à partir du brut annuel en francs suisses : AVS/AI/APG (5,3 %), assurance chômage (1,1 %), assurance accidents non professionnels et indemnités journalières de maladie sont déduits avant le calcul de l\'impôt à la source.',
      'L\'impôt à la source est calculé selon les barèmes A/B/C/H du Canton du Tessin, mis à jour pour 2026, en tenant compte de l\'état civil, du nombre d\'enfants et de l\'appartenance religieuse. Le résultat est converti en euros au taux de change sélectionné pour montrer le pouvoir d\'achat réel en Italie.',
      'Après la simulation, vous pouvez comparer le résultat net aux coûts réels de la vie transfrontalière : transport, assurance LAMal, repas, parking et assurance auto avec plaques suisses.',
    ],
  },
  '/calcola-stipendio/cosa-cambia-se': {
    en: [
      'The "What If" simulator lets you change one parameter at a time — marital status, distance from the border, number of children, work percentage, canton — and instantly see the impact on monthly and annual net salary, so you can evaluate real decisions before making them.',
      'Each scenario is calculated with the same rules as the main simulator: Swiss social deductions, cantonal withholding tax, and CHF-EUR conversion. Differences are highlighted visually for quick comparison.',
      'This tool is particularly useful when evaluating a change of residence, a marriage, the birth of a child, or a switch to part-time work: all situations that significantly modify a cross-border worker\'s taxation.',
    ],
    de: [
      'Der Was-wäre-wenn-Simulator ermöglicht es Ihnen, einen Parameter nach dem anderen zu ändern — Familienstand, Entfernung zur Grenze, Kinderzahl, Arbeitspensum, Kanton — und sofort die Auswirkung auf das monatliche und jährliche Nettogehalt zu sehen.',
      'Jedes Szenario wird mit denselben Regeln wie der Hauptsimulator berechnet: Schweizer Sozialabzüge, kantonale Quellensteuer und CHF-EUR-Umrechnung. Die Unterschiede werden visuell hervorgehoben.',
      'Dieses Tool ist besonders nützlich bei der Planung eines Wohnsitzwechsels, einer Heirat, der Geburt eines Kindes oder dem Wechsel in Teilzeit — alles Situationen, die die Besteuerung des Grenzgängers erheblich verändern.',
    ],
    fr: [
      'Le simulateur « Et si » permet de modifier un paramètre à la fois — état civil, distance de la frontière, nombre d\'enfants, taux d\'activité, canton — et de voir immédiatement l\'impact sur le salaire net mensuel et annuel.',
      'Chaque scénario est calculé avec les mêmes règles que le simulateur principal : déductions sociales suisses, impôt à la source cantonal et conversion CHF-EUR. Les différences sont mises en évidence visuellement.',
      'Cet outil est particulièrement utile pour évaluer un changement de résidence, un mariage, une naissance ou un passage à temps partiel : toutes des situations qui modifient significativement la fiscalité du frontalier.',
    ],
  },
  '/calcola-stipendio/confronta-stipendi': {
    en: [
      'The salary comparator compares net pay for the same role in Ticino (CHF) and in Lombardy/Piedmont (EUR), factoring in taxation, social contributions, and cost of living in both countries.',
      'Reference data comes from real salary statistics by sector and experience level, integrated with the tax and contribution rates in force in Switzerland and Italy for 2026.',
      'The comparison includes indirect costs typical of cross-border workers (transport, health insurance, currency exchange) to give a complete picture of the net economic advantage of working in Switzerland versus an equivalent position in Italy.',
    ],
    de: [
      'Der Gehaltsvergleicher vergleicht das Nettogehalt für die gleiche Stelle im Tessin (CHF) und in der Lombardei/Piemont (EUR) unter Berücksichtigung von Besteuerung, Sozialabgaben und Lebenshaltungskosten in beiden Ländern.',
      'Die Referenzdaten stammen aus realen Gehaltsstatistiken nach Branche und Erfahrungsstufe, integriert mit den 2026 geltenden Steuer- und Beitragssätzen in der Schweiz und Italien.',
      'Der Vergleich umfasst indirekte Grenzgänger-Kosten (Transport, Krankenversicherung, Währungsumtausch) für ein vollständiges Bild des wirtschaftlichen Nettovorteils der Arbeit in der Schweiz.',
    ],
    fr: [
      'Le comparateur de salaires compare la rémunération nette pour le même poste au Tessin (CHF) et en Lombardie/Piémont (EUR), en tenant compte de la fiscalité, des cotisations sociales et du coût de la vie dans les deux pays.',
      'Les données de référence proviennent de statistiques salariales réelles par secteur et niveau d\'expérience, intégrées avec les taux fiscaux et de cotisation en vigueur en Suisse et en Italie pour 2026.',
      'La comparaison inclut les coûts indirects typiques des frontaliers (transport, assurance maladie, change de devises) pour un tableau complet de l\'avantage économique net de travailler en Suisse.',
    ],
  },
  '/calcola-stipendio/quiz-stipendio': {
    en: [
      'The salary quiz tests your knowledge of the tax and contribution rules that determine a cross-border worker\'s net pay: social deductions, withholding tax, franchise, and the 2026 New Fiscal Agreement.',
      'Each question includes a detailed explanation of the underlying mechanism, making the quiz both an assessment and a learning tool for anyone new to cross-border work.',
    ],
    de: [
      'Das Gehaltsquiz testet Ihr Wissen über die Steuer- und Beitragsregeln, die das Nettogehalt eines Grenzgängers bestimmen: Sozialabzüge, Quellensteuer, Franchise und das Neue Steuerabkommen 2026.',
      'Jede Frage enthält eine ausführliche Erklärung des zugrunde liegenden Mechanismus, sodass das Quiz sowohl Wissenstest als auch Lernwerkzeug für Grenzgänger-Neulinge ist.',
    ],
    fr: [
      'Le quiz salarial teste vos connaissances sur les règles fiscales et de cotisation qui déterminent le net d\'un frontalier : déductions sociales, impôt à la source, franchise et le Nouvel Accord fiscal 2026.',
      'Chaque question inclut une explication détaillée du mécanisme sous-jacent, faisant du quiz un outil d\'évaluation et de formation pour les nouveaux frontaliers.',
    ],
  },
  '/calcola-stipendio/': {
    en: [
      'The salary calculation tool uses the 2026 tax and social security parameters for Switzerland and Italy, applying the rules of the New Fiscal Agreement on cross-border worker taxation that entered into force in 2024.',
      'Results account for Canton Ticino specifics: withholding tax rates, A/B/C/H classification tables, per-child deductions, and automatic CHF-EUR conversion at market rates.',
      'For a reliable estimate, enter your gross annual salary in Swiss francs: the system automatically applies AVS/AI/IPG, AC, LAA, IJM, and LPP contributions based on the age brackets defined by federal law.',
    ],
    de: [
      'Das Gehaltsberechnungstool verwendet die Steuer- und Sozialversicherungsparameter 2026 für die Schweiz und Italien und wendet die Regeln des Neuen Steuerabkommens über die Besteuerung von Grenzgängern an, das 2024 in Kraft trat.',
      'Die Ergebnisse berücksichtigen Tessiner Besonderheiten: Quellensteuersätze, Klassifizierungstabellen A/B/C/H, Kinderabzüge und automatische CHF-EUR-Umrechnung zu Marktkursen.',
      'Für eine zuverlässige Schätzung geben Sie Ihr Bruttojahresgehalt in Schweizer Franken ein: Das System wendet automatisch AHV/IV/EO-, ALV-, UVG-, KTG- und BVG-Beiträge nach Altersgruppen des Bundesgesetzes an.',
    ],
    fr: [
      'L\'outil de calcul de salaire utilise les paramètres fiscaux et de sécurité sociale 2026 pour la Suisse et l\'Italie, en appliquant les règles du Nouvel Accord fiscal sur l\'imposition des frontaliers entré en vigueur en 2024.',
      'Les résultats tiennent compte des spécificités du Tessin : taux d\'impôt à la source, barèmes A/B/C/H, déductions par enfant et conversion automatique CHF-EUR aux taux du marché.',
      'Pour une estimation fiable, saisissez votre salaire brut annuel en francs suisses : le système applique automatiquement les cotisations AVS/AI/APG, AC, LAA, IJM et LPP selon les tranches d\'âge prévues par la loi fédérale.',
    ],
  },

  // ───── Comparators ────────────────────────────────────────────
  '/compara-servizi/cambio-franco-euro': {
    en: [
      'The CHF-EUR currency converter uses real-time exchange rates from TwelveData, with Firestore caching for speed and reliability even during traffic peaks.',
      'Beyond instant conversion, interactive charts show the Swiss franc to euro exchange rate history over the last 12 months, useful for identifying the best time to convert your salary.',
      'For cross-border workers, the exchange rate is a decisive factor: a 1% variation on a salary of 6,000 CHF corresponds to roughly 55–60 EUR per month. Monitoring the rate helps plan conversions and reduce bank fees.',
    ],
    de: [
      'Der CHF-EUR-Währungsrechner nutzt Echtzeit-Wechselkurse von TwelveData mit Firestore-Caching für Geschwindigkeit und Zuverlässigkeit auch bei hohem Zugriff.',
      'Neben der Sofortumrechnung zeigen interaktive Grafiken den Verlauf des Schweizer Franken zum Euro über die letzten 12 Monate — nützlich, um den besten Zeitpunkt für die Gehaltsumrechnung zu finden.',
      'Für Grenzgänger ist der Wechselkurs entscheidend: Eine Schwankung von 1 % bei einem Gehalt von 6.000 CHF entspricht etwa 55–60 EUR pro Monat. Die Kursüberwachung hilft, Umrechnungen zu planen und Bankgebühren zu senken.',
    ],
    fr: [
      'Le convertisseur CHF-EUR utilise les taux de change en temps réel de TwelveData, avec mise en cache Firestore pour la rapidité et la fiabilité même lors des pics de trafic.',
      'Au-delà de la conversion instantanée, des graphiques interactifs montrent l\'historique du taux de change franc suisse / euro sur les 12 derniers mois, utile pour identifier le meilleur moment pour convertir votre salaire.',
      'Pour les frontaliers, le taux de change est un facteur déterminant : une variation de 1 % sur un salaire de 6 000 CHF correspond à environ 55–60 EUR par mois. Surveiller le taux aide à planifier les conversions et réduire les frais bancaires.',
    ],
  },
  '/compara-servizi/confronta-casse-malati': {
    en: [
      'The LAMal health insurance comparator compares monthly premiums from 14 recognized Swiss insurers (FOPH), calculated by canton, insurance model, deductible, age group, and accident coverage.',
      'Cross-border workers with a G permit can choose between Swiss LAMal and the Italian national health service: the choice is irrevocable for the duration of employment. This tool helps compare costs before deciding.',
      'Premiums are calculated using the formula: base × (1 − model discount) × (1 + deductible factor) × age multiplier × (1 + accident coverage). Data covers cantons TI, GR, VS, ZH, GE, BE, and LU.',
    ],
    de: [
      'Der KVG-Krankenkassenvergleicher vergleicht monatliche Prämien von 14 anerkannten Schweizer Versicherern (BAG), berechnet nach Kanton, Versicherungsmodell, Franchise, Altersgruppe und Unfalldeckung.',
      'Grenzgänger mit Ausweis G können zwischen der Schweizer KVG und dem italienischen nationalen Gesundheitsdienst wählen: Die Wahl ist für die gesamte Beschäftigungsdauer unwiderruflich. Dieses Tool hilft, die Kosten vor der Entscheidung zu vergleichen.',
      'Die Prämien werden berechnet mit: Basis × (1 − Modellrabatt) × (1 + Franchisefaktor) × Altersmultiplikator × (1 + Unfalldeckung). Die Daten umfassen die Kantone TI, GR, VS, ZH, GE, BE und LU.',
    ],
    fr: [
      'Le comparateur d\'assurance maladie LAMal compare les primes mensuelles de 14 assureurs suisses reconnus (OFSP), calculées par canton, modèle d\'assurance, franchise, tranche d\'âge et couverture accidents.',
      'Les frontaliers avec un permis G peuvent choisir entre la LAMal suisse et le service national de santé italien : le choix est irrévocable pour toute la durée de l\'emploi. Cet outil aide à comparer les coûts avant de décider.',
      'Les primes sont calculées selon la formule : base × (1 − rabais modèle) × (1 + facteur franchise) × multiplicateur âge × (1 + couverture accidents). Les données couvrent les cantons TI, GR, VS, ZH, GE, BE et LU.',
    ],
  },
  '/compara-servizi/confronta-banche': {
    en: [
      'The bank comparison analyses the main Swiss and Italian banks used by cross-border workers, comparing exchange commissions, account fees, debit/credit cards, and cross-border transfer services.',
      'For cross-border workers, the choice of bank directly affects net pay: CHF→EUR exchange commissions can range from 0.3% to 2.5% depending on the institution and the transfer method used.',
      'The tool also compares multi-currency accounts, SEPA transfer fees, and mobile banking features — key factors when managing income in CHF and expenses in EUR on a daily basis.',
    ],
    de: [
      'Der Bankenvergleich analysiert die wichtigsten Schweizer und italienischen Banken für Grenzgänger und vergleicht Wechselkurskommissionen, Kontogebühren, Debit-/Kreditkarten und grenzüberschreitende Überweisungsdienste.',
      'Für Grenzgänger wirkt sich die Bankwahl direkt auf das Nettogehalt aus: CHF→EUR-Wechselkurskommissionen können je nach Institut und Überweisungsmethode zwischen 0,3 % und 2,5 % variieren.',
      'Das Tool vergleicht auch Multiwährungskonten, SEPA-Überweisungsgebühren und Mobile-Banking-Funktionen — entscheidende Faktoren bei der täglichen Verwaltung von CHF-Einkommen und EUR-Ausgaben.',
    ],
    fr: [
      'La comparaison bancaire analyse les principales banques suisses et italiennes utilisées par les frontaliers, en comparant les commissions de change, les frais de compte, les cartes de débit/crédit et les services de virement transfrontalier.',
      'Pour les frontaliers, le choix de la banque affecte directement le salaire net : les commissions de change CHF→EUR peuvent varier de 0,3 % à 2,5 % selon l\'établissement et la méthode de transfert utilisée.',
      'L\'outil compare également les comptes multidevises, les frais de virement SEPA et les fonctionnalités de banque mobile — des critères essentiels pour gérer au quotidien des revenus en CHF et des dépenses en EUR.',
    ],
  },
  '/compara-servizi/confronta-offerte-lavoro': {
    en: [
      'The Ticino jobs section gathers job postings published on official company sources, with data normalization to facilitate comparison between role, location, contract type, and match with your professional profile.',
      'For each position, useful metadata is maintained: publication date, company, location, requirements, and direct link to apply on the employer\'s original website.',
      'Listings are filtered for Canton Ticino and updated daily by dedicated crawlers that monitor the HR portals of over 100 Ticino companies, public entities, and multinationals based in the canton.',
    ],
    de: [
      'Die Tessiner Stellensuche sammelt Stellenangebote von offiziellen Unternehmensquellen mit Datennormalisierung zum einfachen Vergleich von Rolle, Standort, Vertragsart und Übereinstimmung mit Ihrem Berufsprofil.',
      'Für jede Stelle werden nützliche Metadaten gepflegt: Veröffentlichungsdatum, Unternehmen, Standort, Anforderungen und Direktlink zur Bewerbung auf der Originalwebsite des Arbeitgebers.',
      'Die Angebote werden für den Kanton Tessin gefiltert und täglich von dedizierten Crawlern aktualisiert, die die HR-Portale von über 100 Tessiner Unternehmen, öffentlichen Einrichtungen und Konzernen überwachen.',
    ],
    fr: [
      'La section emploi au Tessin recueille les offres d\'emploi publiées sur les sources officielles des entreprises, avec normalisation des données pour faciliter la comparaison entre poste, lieu, type de contrat et adéquation avec votre profil professionnel.',
      'Pour chaque poste, des métadonnées utiles sont conservées : date de publication, entreprise, localité, exigences et lien direct pour postuler sur le site original de l\'employeur.',
      'Les offres sont filtrées pour le Canton du Tessin et mises à jour quotidiennement par des crawlers dédiés qui surveillent les portails RH de plus de 100 entreprises tessinoises.',
    ],
  },
  '/compara-servizi/costo-auto': {
    en: [
      'The car cost calculator compares annual expenses of owning and using a vehicle in Switzerland and in Italy, including liability insurance, road tax, maintenance, fuel, and tolls.',
      'For cross-border workers who cross the border daily, Swiss and Italian plates carry different costs: Swiss insurance covers driving throughout Europe but premiums can exceed CHF 1,500/year.',
      'The calculator also factors in fuel price differences across the border, motorway vignette costs, and the impact of choosing electric vs combustion vehicles on total annual ownership expenses.',
    ],
    de: [
      'Der Autokostenrechner vergleicht die jährlichen Kosten für Besitz und Nutzung eines Fahrzeugs in der Schweiz und in Italien, einschliesslich Haftpflichtversicherung, Strassensteuer, Wartung, Kraftstoff und Maut.',
      'Für Grenzgänger, die täglich die Grenze überqueren, sind Schweizer und italienische Kennzeichen mit unterschiedlichen Kosten verbunden: Die Schweizer Versicherung deckt ganz Europa ab, aber die Prämien können 1.500 CHF/Jahr übersteigen.',
      'Der Rechner berücksichtigt auch Kraftstoffpreisunterschiede an der Grenze, Autobahnvignettenkosten und den Einfluss der Wahl zwischen Elektro- und Verbrennungsfahrzeugen auf die jährlichen Gesamtkosten.',
    ],
    fr: [
      'Le calculateur de coûts auto compare les frais annuels de possession et d\'utilisation d\'un véhicule en Suisse et en Italie, incluant assurance RC, taxe de circulation, entretien, carburant et péages.',
      'Pour les frontaliers qui traversent la frontière quotidiennement, les plaques suisses et italiennes impliquent des coûts différents : l\'assurance suisse couvre toute l\'Europe mais les primes peuvent dépasser 1 500 CHF/an.',
      'Le calculateur prend aussi en compte les écarts de prix du carburant de part et d\'autre de la frontière, le coût de la vignette autoroutière et l\'impact du choix entre véhicule électrique et thermique sur les frais annuels totaux.',
    ],
  },
  '/compara-servizi/costo-della-vita': {
    en: [
      'The cost of living index compares major expense categories between Switzerland (Ticino) and Italy (Lombardy/Piedmont): rent, transport, groceries, healthcare, education, and leisure.',
      'The cost-of-living differential is the key factor in choosing between a G permit (residence in Italy) and a B permit (residence in Switzerland): living in Italy can reduce fixed expenses by 30–50% compared to Ticino.',
      'The comparison breaks down costs across rental, transport, and groceries categories using real data collected from Ticino and the Italian border region. Each category shows price ranges and percentage differences, helping you build a realistic monthly budget before deciding on your residence permit type.',
    ],
    de: [
      'Der Lebenshaltungskostenindex vergleicht die wichtigsten Ausgabenkategorien zwischen der Schweiz (Tessin) und Italien (Lombardei/Piemont): Miete, Transport, Lebensmittel, Gesundheitswesen, Bildung und Freizeit.',
      'Das Lebenshaltungskostengefälle ist der entscheidende Faktor bei der Wahl zwischen Ausweis G (Wohnsitz in Italien) und Ausweis B (Wohnsitz in der Schweiz): Das Leben in Italien kann die Fixkosten um 30–50 % im Vergleich zum Tessin senken.',
      'Der Vergleich schlüsselt die Kosten nach Miete, Transport und Lebensmittel auf, basierend auf realen Erhebungsdaten aus dem Tessin und der italienischen Grenzregion. Jede Kategorie zeigt Preisspannen und prozentuale Unterschiede, damit Sie vor der Wahl des Aufenthaltstitels ein realistisches Monatsbudget erstellen können.',
    ],
    fr: [
      'L\'indice du coût de la vie compare les principales catégories de dépenses entre la Suisse (Tessin) et l\'Italie (Lombardie/Piémont) : loyer, transports, alimentation, santé, éducation et loisirs.',
      'Le différentiel de coût de la vie est le facteur clé dans le choix entre un permis G (résidence en Italie) et un permis B (résidence en Suisse) : vivre en Italie peut réduire les charges fixes de 30 à 50 % par rapport au Tessin.',
      'La comparaison détaille les coûts par catégorie — loyer, transports et courses — à partir de données réelles collectées au Tessin et dans la région frontalière italienne. Chaque catégorie affiche les fourchettes de prix et les écarts en pourcentage, vous aidant à établir un budget mensuel réaliste avant de choisir votre type de permis.',
    ],
  },
  '/compara-servizi/': {
    en: [
      'This section compares services, costs, and conditions relevant to those who work in Switzerland and live in Italy, with up-to-date data and interactive tools for informed decisions.',
      'Each comparator uses real data and verifiable sources to ensure reliable results. Parameters can be customized to your specific cross-border worker situation.',
      'The section includes eight dedicated comparator tools — from currency exchange and health insurance to cost of living and childcare — all maintained with data updated monthly. Browse each tool individually or use the overview to identify which comparisons matter most for your cross-border situation.',
    ],
    de: [
      'Dieser Bereich vergleicht Dienstleistungen, Kosten und Bedingungen, die für Personen relevant sind, die in der Schweiz arbeiten und in Italien leben, mit aktuellen Daten und interaktiven Tools.',
      'Jeder Vergleicher verwendet reale Daten und überprüfbare Quellen für zuverlässige Ergebnisse. Die Parameter können an Ihre spezifische Grenzgänger-Situation angepasst werden.',
      'Der Bereich umfasst acht spezialisierte Vergleichstools — von Währungsumrechnung und Krankenversicherung bis hin zu Lebenshaltungskosten und Kinderbetreuung — alle mit monatlich aktualisierten Daten. Nutzen Sie die einzelnen Tools oder die Übersicht, um die für Ihre Grenzgänger-Situation relevantesten Vergleiche zu finden.',
    ],
    fr: [
      'Cette section compare les services, coûts et conditions pertinents pour ceux qui travaillent en Suisse et vivent en Italie, avec des données actualisées et des outils interactifs pour des décisions éclairées.',
      'Chaque comparateur utilise des données réelles et des sources vérifiables pour garantir des résultats fiables. Les paramètres sont personnalisables selon votre situation spécifique de frontalier.',
      'La section comprend huit outils de comparaison dédiés — du change de devises à l\'assurance maladie, en passant par le coût de la vie et les crèches — tous alimentés par des données mises à jour mensuellement. Parcourez chaque outil ou utilisez la vue d\'ensemble pour identifier les comparaisons les plus pertinentes pour votre situation frontalière.',
    ],
  },

  // ───── Taxes & Pension ────────────────────────────────────────
  '/tasse-e-pensione/calcola-previdenza': {
    en: [
      'The pension simulator estimates retirement benefits by combining the first pillar AVS (maximum 2024 pension: CHF 2,450/month), second pillar LPP (contribution credits from 7% to 18% based on age), and the optional third pillar 3a.',
      'For cross-border workers, the Swiss pension is paid even after permanently returning to Italy. AVS contributions accrued in Switzerland are combined with Italian INPS contributions thanks to the bilateral social security convention.',
      'The simulator also shows the impact of different strategies: voluntary third pillar 3a contributions, LPP buy-ins, and the effect of the conversion rate on the final pension, with projections at 5, 10, and 20 years.',
    ],
    de: [
      'Der Vorsorgesimulator schätzt die Rentenleistungen durch Kombination der ersten Säule AHV (maximale Rente 2024: CHF 2.450/Monat), der zweiten Säule BVG (Gutschriften von 7 % bis 18 % je nach Alter) und der freiwilligen dritten Säule 3a.',
      'Für Grenzgänger wird die Schweizer Rente auch nach der endgültigen Rückkehr nach Italien gezahlt. In der Schweiz angesammelte AHV-Beiträge werden dank des bilateralen Sozialversicherungsabkommens mit italienischen INPS-Beiträgen kombiniert.',
      'Der Simulator zeigt auch die Auswirkung verschiedener Strategien: freiwillige Säule-3a-Einzahlungen, BVG-Einkäufe und den Effekt des Umwandlungssatzes auf die Endrente, mit Prognosen auf 5, 10 und 20 Jahre.',
    ],
    fr: [
      'Le simulateur de prévoyance estime les prestations de retraite en combinant le premier pilier AVS (rente maximale 2024 : CHF 2 450/mois), le deuxième pilier LPP (bonifications de 7 % à 18 % selon l\'âge) et le troisième pilier 3a facultatif.',
      'Pour les frontaliers, la pension suisse est versée même après le retour définitif en Italie. Les cotisations AVS accumulées en Suisse s\'ajoutent aux cotisations INPS italiennes grâce à la convention bilatérale de sécurité sociale.',
      'Le simulateur montre également l\'impact de différentes stratégies : versements volontaires au pilier 3a, rachats LPP et effet du taux de conversion sur la rente finale, avec des projections à 5, 10 et 20 ans.',
    ],
  },
  '/tasse-e-pensione/scadenze-fiscali': {
    en: [
      'The tax calendar displays all deadlines a cross-border worker must meet in Switzerland and Italy: income tax returns (730/Modello Redditi PF), withholding tax adjustment, IMU payment, and regional/municipal surcharges.',
      'For new cross-border workers (regime from 2024), the EUR 10,000 franchise applies to Swiss employment income for IRPEF purposes: the Italian tax return accounts for this reduction in the taxable base.',
      'Meeting every deadline avoids penalties and late interest. The tool sends personalised reminders and displays the complete calendar with Italian and Swiss dates side by side.',
    ],
    de: [
      'Der Steuerkalender zeigt alle Fristen, die ein Grenzgänger in der Schweiz und Italien einhalten muss: Steuererklärung (730/Modello Redditi PF), Quellensteuerausgleich, IMU-Zahlung und regionale/kommunale Zuschläge.',
      'Für neue Grenzgänger (Regelung ab 2024) gilt die Franchise von EUR 10.000 für Schweizer Arbeitseinkommen im Rahmen der IRPEF: Die italienische Steuererklärung berücksichtigt diese Reduktion der Bemessungsgrundlage.',
      'Die Einhaltung jeder Frist vermeidet Bussen und Verzugszinsen. Das Tool sendet personalisierte Erinnerungen und zeigt den vollständigen Kalender mit italienischen und Schweizer Terminen nebeneinander an.',
    ],
    fr: [
      'Le calendrier fiscal affiche toutes les échéances qu\'un frontalier doit respecter en Suisse et en Italie : déclarations fiscales (730/Modello Redditi PF), ajustement de l\'impôt à la source, paiement de l\'IMU et surtaxes régionales/communales.',
      'Pour les nouveaux frontaliers (régime à partir de 2024), la franchise de 10 000 EUR s\'applique au revenu de travail suisse à des fins IRPEF : la déclaration italienne tient compte de cette réduction de la base imposable.',
      'Respecter chaque échéance évite pénalités et intérêts de retard. L\'outil envoie des rappels personnalisés et affiche le calendrier complet avec les dates italiennes et suisses côte à côte.',
    ],
  },
  '/tasse-e-pensione/simula-terzo-pilastro': {
    en: [
      'The third pillar 3a simulator calculates accumulated capital and future pension based on annual contributions, duration, expected return, and withdrawal tax, showing the fiscal advantage over non-tax-advantaged investments.',
      'In 2026, the maximum deductible for pillar 3a is CHF 7,258 for workers affiliated with an LPP pension fund. The contribution directly reduces taxable income for cantonal withholding tax purposes.',
      'The simulator also compares scenarios with different time horizons and returns, letting you visualise the effect of compound interest and tax relief over the long term.',
    ],
    de: [
      'Der Säule-3a-Simulator berechnet das angesammelte Kapital und die zukünftige Rente basierend auf jährlichen Einzahlungen, Laufzeit, erwarteter Rendite und Kapitalbezugssteuer — und zeigt den steuerlichen Vorteil gegenüber nicht begünstigten Anlagen.',
      'Im Jahr 2026 beträgt der maximale Abzug für die Säule 3a CHF 7.258 für Arbeitnehmer mit BVG-Anschluss. Die Einzahlung reduziert direkt das quellensteuerbare Einkommen.',
      'Der Simulator vergleicht auch Szenarien mit unterschiedlichen Zeithorizonten und Renditen, sodass Sie den Effekt von Zinseszins und Steuervorteil über die Langfristigkeit hinweg visualisieren können.',
    ],
    fr: [
      'Le simulateur du troisième pilier 3a calcule le capital accumulé et la rente future en fonction des versements annuels, de la durée, du rendement attendu et de l\'impôt de retrait, montrant l\'avantage fiscal par rapport aux investissements non privilégiés.',
      'En 2026, le maximum déductible pour le pilier 3a est de CHF 7 258 pour les travailleurs affiliés à une caisse de pension LPP. Le versement réduit directement le revenu imposable à la source.',
      'Le simulateur compare également des scénarios avec différents horizons temporels et rendements, vous permettant de visualiser l\'effet des intérêts composés et de l\'avantage fiscal sur le long terme.',
    ],
  },
  '/tasse-e-pensione/credito-imposta': {
    en: [
      'The tax credit calculator determines the foreign tax credit (Art. 165 TUIR) applicable in the Italian tax return, avoiding double taxation on Swiss employment income.',
      'Under the 2024 New Agreement, Italy taxes new cross-border workers\' income with an EUR 10,000 franchise and recognises a credit for Swiss withholding tax paid, up to the amount of Italian tax due.',
      'The Art. 165 TUIR mechanism works by allowing Italian-resident cross-border workers to offset Swiss withholding tax against their Italian liability, preventing double taxation. The calculator shows the exact recoverable amount and distinguishes between old agreement workers with full credit and new agreement workers subject to the EUR 10,000 franchise.',
    ],
    de: [
      'Der Steuergutschrift-Rechner ermittelt die Anrechnung ausländischer Steuern (Art. 165 TUIR) für die italienische Steuererklärung und vermeidet so die Doppelbesteuerung auf Schweizer Arbeitseinkommen.',
      'Gemäss dem Neuen Abkommen 2024 besteuert Italien das Einkommen neuer Grenzgänger mit einer Franchise von EUR 10.000 und erkennt eine Gutschrift für die gezahlte Schweizer Quellensteuer bis zur Höhe der geschuldeten italienischen Steuer an.',
      'Der Mechanismus nach Art. 165 TUIR ermöglicht es in Italien ansässigen Grenzgängern, die bereits gezahlte Schweizer Quellensteuer von ihrer italienischen Steuerschuld abzuziehen und so eine Doppelbesteuerung zu vermeiden. Der Rechner zeigt den genauen erstattungsfähigen Betrag und unterscheidet zwischen Alt-Abkommen mit voller Anrechnung und Neu-Abkommen mit EUR 10.000 Franchise.',
    ],
    fr: [
      'Le calculateur de crédit d\'impôt détermine le crédit pour impôts payés à l\'étranger (Art. 165 TUIR) applicable dans la déclaration fiscale italienne, évitant la double imposition sur le revenu de travail suisse.',
      'Avec le Nouvel Accord 2024, l\'Italie impose le revenu des nouveaux frontaliers avec une franchise de 10 000 EUR et reconnaît un crédit pour l\'impôt à la source suisse payé, jusqu\'à concurrence de l\'impôt italien dû.',
      'Le mécanisme de l\'Art. 165 TUIR permet aux frontaliers résidant en Italie de déduire l\'impôt à la source suisse déjà payé de leur dette fiscale italienne, évitant ainsi la double imposition. Le calculateur distingue entre l\'ancien accord avec crédit intégral et le nouvel accord avec franchise de 10 000 EUR, et affiche le montant exact récupérable.',
    ],
  },
  '/tasse-e-pensione/crediti-imposta': {
    en: [
      'The tax credit calculator determines the foreign tax credit (Art. 165 TUIR) applicable in the Italian tax return, avoiding double taxation on Swiss employment income.',
      'Under the 2024 New Agreement, Italy taxes new cross-border workers\' income with an EUR 10,000 franchise and recognises a credit for Swiss withholding tax paid, up to the amount of Italian tax due.',
      'Three distinct credit regimes apply depending on your start date: the standard foreign tax credit for non-frontier workers, the old agreement credit for pre-2024 cross-border workers with full exemption in Italy, and the new agreement credit with the EUR 10,000 franchise. Use the comparison tool to determine which regime applies to your case.',
    ],
    de: [
      'Der Steuergutschrift-Rechner ermittelt die Anrechnung ausländischer Steuern (Art. 165 TUIR) für die italienische Steuererklärung und vermeidet so die Doppelbesteuerung auf Schweizer Arbeitseinkommen.',
      'Gemäss dem Neuen Abkommen 2024 besteuert Italien das Einkommen neuer Grenzgänger mit einer Franchise von EUR 10.000 und erkennt eine Gutschrift für die gezahlte Schweizer Quellensteuer bis zur Höhe der geschuldeten italienischen Steuer an.',
      'Drei unterschiedliche Anrechnungsregime gelten je nach Arbeitsbeginn: die allgemeine Anrechnung ausländischer Steuern für Nicht-Grenzgänger, die Alt-Abkommen-Anrechnung für Grenzgänger vor 2024 mit voller Befreiung in Italien und die Neu-Abkommen-Anrechnung mit EUR 10.000 Franchise. Nutzen Sie das Vergleichstool, um festzustellen, welches Regime für Sie gilt.',
    ],
    fr: [
      'Le calculateur de crédit d\'impôt détermine le crédit pour impôts payés à l\'étranger (Art. 165 TUIR) applicable dans la déclaration fiscale italienne, évitant la double imposition sur le revenu de travail suisse.',
      'Avec le Nouvel Accord 2024, l\'Italie impose le revenu des nouveaux frontaliers avec une franchise de 10 000 EUR et reconnaît un crédit pour l\'impôt à la source suisse payé, jusqu\'à concurrence de l\'impôt italien dû.',
      'Trois régimes de crédit distincts s\'appliquent selon votre date de début : le crédit d\'impôt étranger standard pour les non-frontaliers, le crédit de l\'ancien accord pour les frontaliers d\'avant 2024 avec exonération totale en Italie, et le crédit du nouvel accord avec franchise de 10 000 EUR. Utilisez l\'outil de comparaison pour déterminer le régime applicable.',
    ],
  },
  '/tasse-e-pensione/dichiarazione-redditi': {
    en: [
      'The income tax return guide for cross-border workers covers both Italy and Switzerland. For Italy: Modello 730 or Redditi PF, income in francs converted at the UIC rate, franchise, and foreign tax credit in sections RC, CE, CR.',
      'For Switzerland: withholding tax (Quellensteuer), rectification procedure by 31 March, supplementary ordinary taxation (TOU) above CHF 120,000, pillar 3a and LPP deductions, quasi-resident status, and filing with eTax Ticino.',
      'Step-by-step instructions walk you through each form section, from declaring Swiss income in the Italian 730 to requesting the withholding tax rectification in Canton Ticino.',
    ],
    de: [
      'Der Leitfaden zur Steuererklärung für Grenzgänger deckt sowohl Italien als auch die Schweiz ab. Für Italien: Modello 730 oder Redditi PF, Einkommen in Franken zum UIC-Kurs umgerechnet, Franchise und Anrechnung ausländischer Steuern.',
      'Für die Schweiz: Quellensteuer, Berichtigungsverfahren bis 31. März, nachträgliche ordentliche Veranlagung (NOV) über CHF 120.000, Säule-3a- und BVG-Abzüge, Quasi-Ansässigen-Status und Einreichung über eTax Ticino.',
      'Schritt-für-Schritt-Anleitungen führen Sie durch jeden Formularteil — von der Deklaration des Schweizer Einkommens im italienischen 730 bis zum Antrag auf Quellensteuerberichtigung im Kanton Tessin.',
    ],
    fr: [
      'Le guide de la déclaration de revenus pour frontaliers couvre l\'Italie et la Suisse. Pour l\'Italie : Modello 730 ou Redditi PF, revenus en francs convertis au taux UIC, franchise et crédit pour impôts étrangers dans les sections RC, CE, CR.',
      'Pour la Suisse : impôt à la source (Quellensteuer), procédure de rectification avant le 31 mars, taxation ordinaire complémentaire (TOU) au-delà de CHF 120 000, déductions pilier 3a et LPP, statut de quasi-résident et déclaration via eTax Ticino.',
      'Des instructions pas à pas vous guident à travers chaque section du formulaire, de la déclaration du revenu suisse dans le 730 italien à la demande de rectification de l\'impôt à la source au Canton du Tessin.',
    ],
  },
  '/tasse-e-pensione/quiz-fiscale': {
    en: [
      'The weekly tax quiz tests cross-border worker knowledge on taxes, deductions, permits, and regulations. Each week 5 questions are selected from the pool: Swiss and Italian taxation, AVS/LPP contributions, LAMal health insurance, and G/B work permits.',
      'Questions cover real scenarios: cantonal withholding tax rates, IRPEF franchise for new cross-border workers, pillar 3a deductions, unemployment obligations, and quasi-resident status. Scores contribute to gamification achievements.',
      'New questions are added regularly to reflect legislative changes. Each wrong answer links to the relevant guide section, turning every mistake into a focused learning opportunity.',
    ],
    de: [
      'Das wöchentliche Steuerquiz testet das Wissen des Grenzgängers über Steuern, Abzüge, Bewilligungen und Vorschriften. Jede Woche werden 5 Fragen aus dem Pool ausgewählt: Schweizer und italienische Besteuerung, AHV/BVG-Beiträge, KVG-Versicherung und Arbeitsbewilligungen G/B.',
      'Die Fragen decken reale Szenarien ab: kantonale Quellensteuersätze, IRPEF-Franchise für neue Grenzgänger, Säule-3a-Abzüge, Arbeitslosigkeitspflichten und Quasi-Ansässigen-Status. Punktzahlen tragen zu Gamification-Erfolgen bei.',
      'Neue Fragen werden regelmässig ergänzt, um Gesetzesänderungen abzubilden. Jede falsche Antwort verlinkt auf den passenden Leitfadenabschnitt und macht jeden Fehler zu einer gezielten Lernmöglichkeit.',
    ],
    fr: [
      'Le quiz fiscal hebdomadaire teste les connaissances du frontalier sur les impôts, les déductions, les permis et la réglementation. Chaque semaine, 5 questions sont sélectionnées : fiscalité suisse et italienne, cotisations AVS/LPP, assurance LAMal et permis de travail G/B.',
      'Les questions couvrent des scénarios réels : taux d\'impôt à la source cantonal, franchise IRPEF pour les nouveaux frontaliers, déductions pilier 3a, obligations chômage et statut de quasi-résident. Les scores contribuent aux succès de gamification.',
      'De nouvelles questions sont ajoutées régulièrement pour refléter les évolutions législatives. Chaque mauvaise réponse renvoie à la section du guide concernée, transformant chaque erreur en opportunité d\'apprentissage ciblée.',
    ],
  },
  '/tasse-e-pensione/simulazione-tasse-nuovi-frontalieri': {
    en: [
      'The new cross-border worker tax simulation calculates your net salary under the 2024 New Fiscal Agreement between Italy and Switzerland. If you started working in Switzerland after 17 July 2023, you are classified as a "new cross-border worker" and subject to concurrent taxation in both countries.',
      'Switzerland withholds tax at source (80% of the ordinary Canton Ticino rate for residents within 20 km of the border, 100% for those beyond), while Italy levies IRPEF on the same income with a EUR 10,000 franchise for all cross-border workers. A foreign tax credit prevents double taxation by deducting Swiss tax from Italian IRPEF.',
      'Use the free simulator to enter your gross annual salary in CHF, marital status, children, and municipality of residence. The tool applies Swiss social deductions (AVS 5.3%, unemployment 1.1%, LPP by age), Canton Ticino withholding tax, Italian IRPEF with the franchise, and the tax credit — showing your monthly net in EUR.',
    ],
    de: [
      'Die Steuersimulation fuer neue Grenzgaenger berechnet Ihr Nettogehalt nach dem Neuen Steuerabkommen 2024 zwischen Italien und der Schweiz. Wenn Sie nach dem 17. Juli 2023 in der Schweiz zu arbeiten begonnen haben, gelten Sie als "neuer Grenzgaenger" und unterliegen der konkurrierenden Besteuerung in beiden Laendern.',
      'Die Schweiz erhebt die Quellensteuer (80% des ordentlichen Tessiner Satzes fuer Einwohner innerhalb von 20 km von der Grenze, 100% darueber hinaus), waehrend Italien die IRPEF auf dasselbe Einkommen mit einer Franchise von EUR 10.000 fuer alle Grenzgaenger erhebt. Eine Steuergutschrift fuer im Ausland gezahlte Steuern verhindert die Doppelbesteuerung.',
      'Verwenden Sie den kostenlosen Simulator: Geben Sie Ihr Bruttojahresgehalt in CHF, Familienstand, Kinder und Wohngemeinde ein. Das Tool berechnet Schweizer Sozialabzuege (AHV 5,3%, ALV 1,1%, BVG nach Alter), Tessiner Quellensteuer, italienische IRPEF mit Franchise und Steuergutschrift — und zeigt Ihr monatliches Netto in EUR.',
    ],
    fr: [
      'La simulation fiscale pour les nouveaux frontaliers calcule votre salaire net selon le Nouvel Accord Fiscal 2024 entre l\'Italie et la Suisse. Si vous avez commence a travailler en Suisse apres le 17 juillet 2023, vous etes classe comme "nouveau frontalier" et soumis a la taxation concurrente dans les deux pays.',
      'La Suisse preleve l\'impot a la source (80% du taux ordinaire du Tessin pour les residents a moins de 20 km de la frontiere, 100% au-dela), tandis que l\'Italie applique l\'IRPEF sur le meme revenu avec une franchise de 10 000 EUR pour tous les frontaliers. Un credit d\'impot pour les taxes payees a l\'etranger evite la double imposition.',
      'Utilisez le simulateur gratuit : entrez votre salaire brut annuel en CHF, etat civil, enfants et commune de residence. L\'outil applique les deductions sociales suisses (AVS 5,3%, chomage 1,1%, LPP par age), l\'impot a la source du Tessin, l\'IRPEF italienne avec la franchise et le credit d\'impot — affichant votre net mensuel en EUR.',
    ],
  },
  '/tasse-e-pensione/calcola-ristorni': {
    en: [
      'The ristorni tracker monitors the financial compensations that Canton Ticino pays to Italian border municipalities to offset costs incurred for resident cross-border workers: roughly 40% of withholding tax is returned to municipalities within 20 km of the border.',
      'Under the 2024 New Agreement, the ristorni share is expected to decrease progressively as Italy assumes concurrent taxation. The most affected municipalities are those in the 20 km belt from the frontier.',
      'The tracker shows historical data by municipality and year, letting you compare how ristorni have evolved and forecast the fiscal impact of the transitional phase through 2033.',
    ],
    de: [
      'Der Ristorni-Tracker überwacht die Finanzkompensationen, die der Kanton Tessin an italienische Grenzgemeinden zahlt, um die Kosten für ansässige Grenzgänger auszugleichen: Etwa 40 % der Quellensteuer wird an Gemeinden innerhalb von 20 km von der Grenze zurückerstattet.',
      'Unter dem Neuen Abkommen 2024 wird der Ristorni-Anteil voraussichtlich schrittweise sinken, da Italien die konkurrierende Besteuerung übernimmt. Die am stärksten betroffenen Gemeinden liegen im 20-km-Gürtel an der Grenze.',
      'Der Tracker zeigt historische Daten nach Gemeinde und Jahr, sodass Sie die Entwicklung der Ristorni vergleichen und die steuerlichen Auswirkungen der Übergangsphase bis 2033 einschätzen können.',
    ],
    fr: [
      'Le tracker des ristorni surveille les compensations financières que le Canton du Tessin verse aux communes frontalières italiennes pour couvrir les coûts liés aux frontaliers résidents : environ 40 % de l\'impôt à la source est restitué aux communes situées dans un rayon de 20 km de la frontière.',
      'Avec le Nouvel Accord 2024, la part des ristorni devrait diminuer progressivement à mesure que l\'Italie assume la taxation concurrente. Les communes les plus concernées sont celles de la ceinture des 20 km.',
      'Le tracker affiche les données historiques par commune et par année, vous permettant de comparer l\'évolution des ristorni et d\'anticiper l\'impact fiscal de la phase transitoire jusqu\'en 2033.',
    ],
  },
  '/tasse-e-pensione/': {
    en: [
      'This section covers the fiscal and pension aspects of cross-border work: Swiss withholding tax, Italian IRPEF, AVS/LPP contributions, and retirement planning.',
      'Information is updated to the 2024 New Fiscal Agreement between Italy and Switzerland, and accounts for Canton Ticino specifics regarding withholding tax and transitional regimes for historical cross-border workers (pre-2024).',
      'Key tools include the pension planner for AVS/LPP retirement projections, the tax calendar with filing deadlines for both countries, the third pillar 3a simulator for tax-advantaged savings, and the tax credit calculator for optimising your Italian return. Each tool is tailored to cross-border worker regulations in force for 2026.',
    ],
    de: [
      'Dieser Bereich deckt die steuerlichen und vorsorgerechtlichen Aspekte der Grenzgängerarbeit ab: Schweizer Quellensteuer, italienische IRPEF, AHV/BVG-Beiträge und Altersvorsorgeplanung.',
      'Die Informationen sind auf das Neue Steuerabkommen 2024 zwischen Italien und der Schweiz aktualisiert und berücksichtigen Tessiner Besonderheiten bei der Quellensteuer und Übergangsregelungen für Alt-Grenzgänger (vor 2024).',
      'Wichtige Tools sind der Vorsorgerechner für AHV/BVG-Prognosen, der Steuerkalender mit Fristen für beide Länder, der Säule-3a-Simulator für steuerbegünstigtes Sparen und der Steuergutschrift-Rechner zur Optimierung der italienischen Steuererklärung. Jedes Tool ist auf die geltenden Grenzgängerregelungen für 2026 zugeschnitten.',
    ],
    fr: [
      'Cette section couvre les aspects fiscaux et de prévoyance du travail frontalier : impôt à la source suisse, IRPEF italien, cotisations AVS/LPP et planification de la retraite.',
      'Les informations sont mises à jour au Nouvel Accord fiscal 2024 entre l\'Italie et la Suisse et tiennent compte des spécificités du Tessin pour l\'impôt à la source et les régimes transitoires pour les frontaliers historiques (avant 2024).',
      'Les outils clés comprennent le planificateur de prévoyance pour les projections AVS/LPP, le calendrier fiscal avec les échéances des deux pays, le simulateur du troisième pilier 3a pour l\'épargne fiscalement avantageuse et le calculateur de crédit d\'impôt pour optimiser votre déclaration italienne. Chaque outil est adapté à la réglementation frontalière en vigueur pour 2026.',
    ],
  },

  // ───── Guide ──────────────────────────────────────────────────
  '/guida-frontaliere/guida-completa-lavoro-frontaliere-svizzera-2026': {
    en: [
      '<h2>What is a cross-border worker: definition and numbers</h2>',
      'A cross-border worker (Grenzgänger in German, frontalier in French) is a person who resides in one country and works in another, returning to their home at least weekly. In Switzerland, cross-border worker status is governed by the Agreement on the Free Movement of Persons (AFMP) between Switzerland and the European Union, in force since 1 June 2002. Cross-border workers receive the G permit, which authorises employment in Switzerland while maintaining residence abroad.',
      'In Canton Ticino, approximately 79,000 cross-border workers commute daily from Italy (BFS data, 2025). Ticino has the highest concentration of cross-border workers of any Swiss canton, representing about 30% of the cantonal workforce. The main employment sectors are manufacturing (23%), construction (12%), finance and insurance (11%), healthcare (10%), hospitality (9%), and IT (8%). The number grows by 2-3% annually, driven by the average 40-60% salary differential compared to the Italian border provinces (Como, Varese, Verbano-Cusio-Ossola).',
      '<h2>G permit: requirements, procedure and documents</h2>',
      'The G permit (cross-border worker permit) authorises an EU/EFTA citizen to work in Switzerland while maintaining residence in their country. Fundamental requirements are: EU or EFTA citizenship, residence in an Italian municipality, an employment contract with a Swiss employer, and a valid identity document. For EU citizens with permanent contracts, the G permit is valid for 5 years and automatically renewable. Processing takes 5-10 working days; work can begin with just the application receipt.',
      '<h2>2026 tax regime: old and new agreement compared</h2>',
      'The key tax distinction for cross-border workers in 2026 depends on the hiring date and municipality of residence. "Old" cross-border workers (hired before 17 July 2023, residing within 20 km of the border) pay only Swiss withholding tax at 100% of the ordinary rate. "New" cross-border workers (hired from 17 July 2023 onwards, or residing beyond 20 km) are subject to concurrent taxation: Swiss withholding tax at 80% of the ordinary rate, plus Italian IRPEF with a EUR 10,000 exemption and a tax credit for Swiss taxes paid. Source: CH-IT Agreement of 23.12.2020 (RS 0.642.045.43).',
      '<h2>Social contributions and Swiss pension system</h2>',
      'Mandatory Swiss social contributions are deducted directly from the payslip. AVS/AHV (Old-Age and Survivors\' Insurance) is 5.3% of gross salary. Unemployment insurance (AC/ALV) is 1.1% up to CHF 148,200/year. The second pillar (LPP/BVG) varies by age bracket: 7% (25-34), 10% (35-44), 15% (45-54), 18% (55-64). The third pillar (3a) allows tax-deductible voluntary contributions up to CHF 7,258/year in 2026.',
      '<h2>Health insurance: LAMal, right of option and CMB</h2>',
      'Cross-border workers have the "right of option": they can choose between Swiss mandatory health insurance (LAMal, CHF 270-560/month in Ticino) and the Italian National Health Service (SSN, essentially free). The choice must be made within 3 months of starting work and is irrevocable. Those choosing SSN often add complementary private insurance (CMB, EUR 50-150/month) for Swiss coverage.',
      '<h2>Commuting and cost of living: Italy vs Switzerland</h2>',
      'Average monthly commuting costs by car for a 30-50 km round trip are EUR 300-500, including fuel, motorway tolls, vehicle wear, and Swiss parking. The busiest border crossings are Chiasso-Como (A2/A9), Ponte Tresa, and Stabio-Gaggiolo, with peak waits of 30-60 minutes. The cost of living differential is the key economic factor: rent in Como/Varese is EUR 600-900/month vs CHF 1,200-1,800 in Lugano. Groceries are 25-35% cheaper in Italy.',
      '<h2>Tax returns: obligations in Italy and Switzerland</h2>',
      'New cross-border workers must file Italian tax returns (Modello 730 by 30 September, or Redditi PF by 30 November) declaring Swiss income and claiming the tax credit. In Switzerland, cross-border workers can request a withholding tax rectification (TDR) by 31 March of the following year for additional deductions (pillar 3a contributions, actual transport costs, continuing education).',
      '<h2>Useful resources and calculation tools</h2>',
      'Frontaliere Ticino provides free tools: a fiscal simulator for net salary calculation, health insurance comparator for 14 LAMal providers, bank account comparator, and commuting cost calculator. Official reference sources include BFS/UST (employment statistics), SECO (labour market), DFE-TI (withholding tax rates), UFSP (LAMal premiums), and the Italian Revenue Agency (tax obligations).',
    ],
    de: [
      '<h2>Was ist ein Grenzgänger: Definition und Zahlen</h2>',
      'Ein Grenzgänger (frontaliere auf Italienisch, frontalier auf Französisch) ist eine Person, die in einem Staat wohnt und in einem anderen arbeitet und mindestens wöchentlich an ihren Wohnsitz zurückkehrt. In der Schweiz wird der Grenzgängerstatus durch das Freizügigkeitsabkommen (FZA) zwischen der Schweiz und der EU geregelt, das seit dem 1. Juni 2002 in Kraft ist. Grenzgänger erhalten den Ausweis G, der die Erwerbstätigkeit in der Schweiz bei Beibehaltung des Wohnsitzes im Ausland genehmigt.',
      'Im Kanton Tessin pendeln täglich rund 79.000 Grenzgänger aus Italien (BFS-Daten, 2025). Das Tessin weist die höchste Grenzgängerkonzentration aller Schweizer Kantone auf — etwa 30 % der kantonalen Arbeitskräfte. Die wichtigsten Beschäftigungssektoren sind Industrie (23 %), Bau (12 %), Finanz- und Versicherungswesen (11 %), Gesundheit (10 %), Gastgewerbe (9 %) und IT (8 %). Die Zahl wächst jährlich um 2-3 %, getrieben durch das durchschnittliche Lohngefälle von 40-60 % gegenüber den italienischen Grenzprovinzen.',
      '<h2>Ausweis G: Voraussetzungen, Verfahren und Dokumente</h2>',
      'Der Ausweis G (Grenzgängerbewilligung) berechtigt EU/EFTA-Bürger zur Arbeit in der Schweiz bei Beibehaltung des Wohnsitzes im Heimatland. Grundvoraussetzungen: EU- oder EFTA-Staatsangehörigkeit, Wohnsitz in einer italienischen Gemeinde, Arbeitsvertrag mit Schweizer Arbeitgeber und gültiges Identitätsdokument. Für EU-Bürger mit unbefristetem Vertrag gilt der Ausweis G 5 Jahre und wird automatisch verlängert. Die Bearbeitungszeit beträgt 5-10 Arbeitstage.',
      '<h2>Steuerregime 2026: altes und neues Abkommen im Vergleich</h2>',
      'Die steuerliche Unterscheidung für Grenzgänger 2026 hängt vom Einstellungsdatum und der Wohngemeinde ab. „Alte" Grenzgänger (vor dem 17. Juli 2023 eingestellt, Wohnsitz innerhalb 20 km der Grenze) zahlen nur die Schweizer Quellensteuer zu 100 % des ordentlichen Satzes. „Neue" Grenzgänger (ab 17. Juli 2023 oder Wohnsitz über 20 km) unterliegen der konkurrierenden Besteuerung: Schweizer Quellensteuer zu 80 % plus italienische IRPEF mit EUR 10.000 Freibetrag und Steuergutschrift. Quelle: CH-IT-Abkommen vom 23.12.2020 (SR 0.642.045.43).',
      '<h2>Sozialabgaben und Schweizer Vorsorgesystem</h2>',
      'Obligatorische Schweizer Sozialabgaben werden direkt vom Lohn abgezogen. AHV/IV/EO beträgt 5,3 % des Bruttolohns. Arbeitslosenversicherung (ALV) 1,1 % bis CHF 148.200/Jahr. Die zweite Säule (BVG) variiert nach Alter: 7 % (25-34), 10 % (35-44), 15 % (45-54), 18 % (55-64). Die dritte Säule (3a) ermöglicht steuerlich abzugsfähige freiwillige Beiträge bis CHF 7.258/Jahr (2026).',
      '<h2>Krankenversicherung: KVG, Optionsrecht und CMB</h2>',
      'Grenzgänger haben das „Optionsrecht": Sie können zwischen der Schweizer obligatorischen Krankenversicherung (KVG, CHF 270-560/Monat im Tessin) und dem italienischen Nationalen Gesundheitsdienst (SSN) wählen. Die Wahl muss innerhalb von 3 Monaten nach Arbeitsbeginn getroffen werden und ist unwiderruflich. Wer SSN wählt, schliesst oft eine Zusatzversicherung ab (CMB, EUR 50-150/Monat).',
      '<h2>Pendeln und Lebenshaltungskosten: Italien vs. Schweiz</h2>',
      'Durchschnittliche monatliche Pendelkosten mit dem Auto für 30-50 km (Hin- und Rückweg) betragen EUR 300-500. Die verkehrsreichsten Grenzübergänge sind Chiasso-Como (A2/A9), Ponte Tresa und Stabio-Gaggiolo mit Spitzenwartezeiten von 30-60 Minuten. Das Lebenshaltungskostengefälle ist entscheidend: Miete in Como/Varese EUR 600-900/Monat vs. CHF 1.200-1.800 in Lugano. Lebensmittel sind in Italien 25-35 % günstiger.',
      '<h2>Steuererklärung: Pflichten in Italien und der Schweiz</h2>',
      'Neue Grenzgänger müssen eine italienische Steuererklärung abgeben (Modello 730 bis 30. September oder Redditi PF bis 30. November) mit Angabe des Schweizer Einkommens und Beantragung der Steuergutschrift. In der Schweiz können Grenzgänger bis zum 31. März des Folgejahres eine Quellensteuerkorrektur (TDR) beantragen für zusätzliche Abzüge (Säule 3a, Transportkosten, Weiterbildung).',
      '<h2>Nützliche Ressourcen und Berechnungstools</h2>',
      'Frontaliere Ticino bietet kostenlose Werkzeuge: Steuersimulator für die Nettoberechnung, Krankenkassenvergleich für 14 KVG-Anbieter, Bankkontenvergleich und Pendelkostenrechner. Offizielle Quellen: BFS/UST (Beschäftigungsstatistik), SECO (Arbeitsmarkt), DFE-TI (Quellensteuertarife), BAG (KVG-Prämien) und italienische Steuerbehörde.',
    ],
    fr: [
      '<h2>Qu\'est-ce qu\'un travailleur frontalier : définition et chiffres</h2>',
      'Un travailleur frontalier (Grenzgänger en allemand, frontaliere en italien) est une personne qui réside dans un État et travaille dans un autre, rentrant à son domicile au moins une fois par semaine. En Suisse, le statut de frontalier est régi par l\'Accord sur la Libre Circulation des Personnes (ALCP) entre la Suisse et l\'UE, en vigueur depuis le 1er juin 2002. Les frontaliers reçoivent le permis G, qui autorise l\'activité professionnelle en Suisse tout en maintenant la résidence à l\'étranger.',
      'Au Canton du Tessin, environ 79 000 frontaliers traversent quotidiennement la frontière depuis l\'Italie (données OFS, 2025). Le Tessin affiche la plus forte concentration de frontaliers de tous les cantons suisses, représentant environ 30 % de la main-d\'œuvre cantonale. Les principaux secteurs sont l\'industrie (23 %), la construction (12 %), la finance (11 %), la santé (10 %), l\'hôtellerie (9 %) et l\'informatique (8 %). Le nombre augmente de 2-3 % par an, tiré par l\'écart salarial moyen de 40-60 %.',
      '<h2>Permis G : conditions, procédure et documents</h2>',
      'Le permis G (permis frontalier) autorise un citoyen UE/AELE à travailler en Suisse tout en conservant sa résidence dans son pays. Conditions fondamentales : citoyenneté UE ou AELE, résidence dans une commune italienne, contrat de travail avec un employeur suisse et document d\'identité valide. Pour les citoyens UE en CDI, le permis G est valable 5 ans et renouvelable automatiquement. Le délai de traitement est de 5-10 jours ouvrables.',
      '<h2>Régime fiscal 2026 : ancien et nouvel accord comparés</h2>',
      'La distinction fiscale clé pour les frontaliers en 2026 dépend de la date d\'embauche et de la commune de résidence. Les « anciens » frontaliers (embauchés avant le 17 juillet 2023, résidant à moins de 20 km de la frontière) paient uniquement l\'impôt à la source suisse à 100 % du taux ordinaire. Les « nouveaux » frontaliers (embauchés à partir du 17 juillet 2023 ou résidant au-delà de 20 km) sont soumis à l\'imposition concurrente : impôt à la source suisse à 80 % plus IRPEF italienne avec franchise de 10 000 EUR et crédit d\'impôt. Source : Accord CH-IT du 23.12.2020 (RS 0.642.045.43).',
      '<h2>Cotisations sociales et système de prévoyance suisse</h2>',
      'Les cotisations sociales suisses obligatoires sont prélevées directement sur le salaire. L\'AVS/AI/APG représente 5,3 % du salaire brut. L\'assurance chômage (AC) est de 1,1 % jusqu\'à CHF 148 200/an. Le deuxième pilier (LPP) varie selon l\'âge : 7 % (25-34 ans), 10 % (35-44), 15 % (45-54), 18 % (55-64). Le troisième pilier (3a) permet des contributions volontaires fiscalement déductibles jusqu\'à CHF 7 258/an (2026).',
      '<h2>Assurance maladie : LAMal, droit d\'option et CMB</h2>',
      'Les frontaliers bénéficient du « droit d\'option » : ils peuvent choisir entre l\'assurance maladie obligatoire suisse (LAMal, CHF 270-560/mois au Tessin) et le Service National de Santé italien (SSN, essentiellement gratuit). Le choix doit être fait dans les 3 mois suivant le début du travail et est irrévocable. Ceux qui choisissent le SSN souscrivent souvent une assurance complémentaire (CMB, EUR 50-150/mois).',
      '<h2>Pendularité et coût de la vie : Italie vs Suisse</h2>',
      'Les frais de pendularité mensuels moyens en voiture pour un trajet de 30-50 km (aller-retour) sont de EUR 300-500. Les passages frontaliers les plus fréquentés sont Chiasso-Como (A2/A9), Ponte Tresa et Stabio-Gaggiolo, avec des attentes de pointe de 30-60 minutes. Le différentiel de coût de la vie est déterminant : loyer à Como/Varese EUR 600-900/mois contre CHF 1 200-1 800 à Lugano. L\'alimentation est 25-35 % moins chère en Italie.',
      '<h2>Déclaration fiscale : obligations en Italie et en Suisse</h2>',
      'Les nouveaux frontaliers doivent déposer une déclaration fiscale italienne (Modello 730 au 30 septembre ou Redditi PF au 30 novembre) déclarant le revenu suisse et demandant le crédit d\'impôt. En Suisse, les frontaliers peuvent demander une rectification de l\'impôt à la source (TDR) avant le 31 mars de l\'année suivante pour des déductions supplémentaires (pilier 3a, frais de transport, formation continue).',
      '<h2>Ressources utiles et outils de calcul</h2>',
      'Frontaliere Ticino offre des outils gratuits : simulateur fiscal pour le calcul du salaire net, comparateur d\'assurance maladie pour 14 assureurs LAMal, comparateur de comptes bancaires et calculateur de frais de pendularité. Sources officielles : OFS/UST (statistiques de l\'emploi), SECO (marché du travail), DFE-TI (barèmes d\'impôt à la source), OFSP (primes LAMal) et l\'Agence des revenus italienne.',
    ],
  },
  '/guida-frontaliere/primo-giorno-lavoro': {
    en: [
      'The first-day guide covers all practical steps for new cross-border workers: G permit collection, Swiss bank account opening, health insurance choice (LAMal or Italian NHS), AIRE registration, and first tax return.',
      'Each step includes real timelines, required documents, and links to the relevant offices (Ticino Migration Office, INPS, Italian Revenue Agency) to complete procedures without errors.',
      'The interactive checklist guides you week by week through the first 90 days, from signing your contract to full fiscal and social security stabilisation.',
    ],
    de: [
      'Der Ersttagsleitfaden deckt alle praktischen Schritte für neue Grenzgänger ab: Abholung des Ausweises G, Eröffnung eines Schweizer Bankkontos, Wahl der Krankenversicherung (KVG oder italienischer NHS), AIRE-Registrierung und erste Steuererklärung.',
      'Jeder Schritt enthält realistische Fristen, erforderliche Dokumente und Links zu den zuständigen Ämtern (Migrationsamt Tessin, INPS, italienische Steuerbehörde).',
      'Die interaktive Checkliste begleitet Sie Woche für Woche durch die ersten 90 Tage — von der Vertragsunterzeichnung bis zur vollständigen steuerlichen und sozialversicherungsrechtlichen Stabilisierung.',
    ],
    fr: [
      'Le guide du premier jour couvre toutes les étapes pratiques pour les nouveaux frontaliers : obtention du permis G, ouverture d\'un compte bancaire suisse, choix de l\'assurance maladie (LAMal ou SSN italien), inscription AIRE et première déclaration fiscale.',
      'Chaque étape inclut des délais réels, les documents requis et des liens vers les bureaux compétents (Office des migrations du Tessin, INPS, Agence des revenus italienne).',
      'La checklist interactive vous accompagne semaine après semaine pendant les 90 premiers jours, de la signature du contrat à la stabilisation fiscale et sociale complète.',
    ],
  },
  '/guida-frontaliere/permessi-di-lavoro': {
    en: [
      'The work permits comparison analyses the operational differences between G permit (cross-border, annual renewal) and B permit (residence, 5 years): taxation, access to services, right of stay, and implications for the family.',
      'The choice between G and B permit depends on distance from the border, family situation, fiscal circumstances, and expected duration of Swiss employment. This tool helps weigh the pros and cons of each scenario.',
      'The comparison also covers pension implications (AVS, LPP, unemployment insurance), family member residence rights, and the impact on both Italian and Swiss taxation.',
    ],
    de: [
      'Der Bewilligungsvergleich analysiert die betrieblichen Unterschiede zwischen Ausweis G (Grenzgänger, jährliche Verlängerung) und Ausweis B (Aufenthalt, 5 Jahre): Besteuerung, Zugang zu Dienstleistungen, Aufenthaltsrecht und Auswirkungen auf die Familie.',
      'Die Wahl zwischen Ausweis G und B hängt von der Entfernung zur Grenze, der familiären Situation, den steuerlichen Umständen und der erwarteten Dauer der Beschäftigung in der Schweiz ab.',
      'Der Vergleich umfasst auch Vorsorgeaspekte (AHV, BVG, Arbeitslosenversicherung), Aufenthaltsrechte für Familienangehörige und die Auswirkungen auf die Besteuerung in beiden Ländern.',
    ],
    fr: [
      'La comparaison des permis de travail analyse les différences opérationnelles entre le permis G (frontalier, renouvellement annuel) et le permis B (séjour, 5 ans) : fiscalité, accès aux services, droit de séjour et implications pour la famille.',
      'Le choix entre permis G et B dépend de la distance de la frontière, de la situation familiale, des circonstances fiscales et de la durée prévue de l\'emploi en Suisse.',
      'La comparaison couvre aussi les implications de prévoyance (AVS, LPP, assurance chômage), les droits de séjour des membres de la famille et l\'impact sur la fiscalité italienne et suisse.',
    ],
  },
  '/guida-frontaliere/tempi-attesa-dogana/': {
    en: [
      'Border crossing waiting times are estimated based on historical data and typical time slots: morning entry (6:30–8:30) and evening exit (17:00–18:30) are the windows with the most congestion.',
      'For each crossing, practical tips are provided on alternative schedules, secondary routes, and real-time monitoring tools (webcams, traffic apps) to reduce daily commuting times.',
      'Seasonal variations are significant: summer holiday Fridays, ski season, and Italian public holidays can increase queue times by 30–50%. Planning your departure 15 minutes earlier or later than the peak can save substantial commuting time over the year.',
    ],
    de: [
      'Die Wartezeiten an den Grenzübergängen werden basierend auf historischen Daten und typischen Zeitfenstern geschätzt: Morgeneinfahrt (6:30–8:30) und Abendausfahrt (17:00–18:30) sind die staureichsten Zeiten.',
      'Für jeden Übergang werden praktische Tipps zu alternativen Fahrzeiten, Nebenrouten und Echtzeit-Überwachungstools (Webcams, Verkehrs-Apps) gegeben, um die tägliche Pendelzeit zu reduzieren.',
      'Saisonale Schwankungen sind erheblich: Sommerferienfreitage, Skisaison und italienische Feiertage können die Wartezeiten um 30–50 % verlängern. Eine Abfahrt 15 Minuten früher oder später als der Spitzenzeitpunkt kann über das Jahr hinweg erhebliche Pendelzeit einsparen.',
    ],
    fr: [
      'Les temps d\'attente aux postes frontières sont estimés à partir de données historiques et de créneaux horaires typiques : entrée matinale (6h30–8h30) et sortie en soirée (17h00–18h30) sont les fenêtres de plus grande congestion.',
      'Pour chaque poste, des conseils pratiques sont fournis sur les horaires alternatifs, les itinéraires secondaires et les outils de surveillance en temps réel (webcams, applications trafic) pour réduire les temps de trajet quotidiens.',
      'Les variations saisonnières sont importantes : les vendredis de vacances d\'été, la saison de ski et les jours fériés italiens peuvent augmenter les temps d\'attente de 30 à 50 %. Partir 15 minutes plus tôt ou plus tard que le pic peut faire économiser un temps considérable sur l\'année.',
    ],
  },
  '/guida-frontaliere/tempi-attesa-dogana': {
    en: [
      'The border crossing map shows all crossings between Ticino and Italy with opening hours, typical traffic levels, and average waiting times by time slot.',
      'Each crossing has different characteristics: some are reserved for local residents, others handle heavy commercial traffic. Knowing the best crossing for your route can save up to 30 minutes a day.',
      'The most used crossings by commuters are Chiasso–Ponte Chiasso, Stabio–Gaggiolo, and Brogeda. Secondary crossings like Pizzamiglio and Passo San Jorio offer shorter queues but longer driving distances — the optimal choice depends on your destination in Ticino.',
    ],
    de: [
      'Die Grenzübergangskarte zeigt alle Übergänge zwischen dem Tessin und Italien mit Öffnungszeiten, typischem Verkehrsaufkommen und durchschnittlichen Wartezeiten nach Zeitfenstern.',
      'Jeder Übergang hat unterschiedliche Eigenschaften: Einige sind Anwohnern vorbehalten, andere wickeln schweren Güterverkehr ab. Den besten Übergang für die eigene Route zu kennen, kann täglich bis zu 30 Minuten sparen.',
      'Die von Pendlern am häufigsten genutzten Übergänge sind Chiasso–Ponte Chiasso, Stabio–Gaggiolo und Brogeda. Sekundäre Übergänge wie Pizzamiglio und Passo San Jorio bieten kürzere Wartezeiten, aber längere Fahrstrecken.',
    ],
    fr: [
      'La carte des postes frontières montre tous les passages entre le Tessin et l\'Italie avec les horaires d\'ouverture, les niveaux de trafic typiques et les temps d\'attente moyens par créneau horaire.',
      'Chaque passage a des caractéristiques différentes : certains sont réservés aux résidents locaux, d\'autres gèrent du trafic commercial lourd. Connaître le meilleur passage pour votre trajet peut faire gagner jusqu\'à 30 minutes par jour.',
      'Les passages les plus utilisés par les pendulaires sont Chiasso–Ponte Chiasso, Stabio–Gaggiolo et Brogeda. Les passages secondaires comme Pizzamiglio et Passo San Jorio offrent des files plus courtes mais des distances de conduite plus longues.',
    ],
  },
  '/guida-frontaliere/trasferimento-auto': {
    en: [
      'The car transfer guide covers procedures for registering an Italian vehicle in Switzerland and vice versa: customs clearance, MFK technical inspection, insurance, and timelines for re-registration.',
      'For cross-border workers using an Italian-plated vehicle, it explains the rules for driving in Switzerland: time limits, Swiss-valid insurance, fines, and special cases with company vehicles.',
      'Key topics include the temporary import rules (Form 15.30), the 60-day re-export deadline, and the documentation needed for customs clearance at the Stabio or Chiasso offices.',
    ],
    de: [
      'Der Leitfaden zum Autotransfer deckt die Verfahren zur Ummatrikulierung eines italienischen Fahrzeugs in der Schweiz und umgekehrt ab: Verzollung, MFK-Prüfung, Versicherung und Fristen für die Ummeldung.',
      'Für Grenzgänger mit italienischem Kennzeichen werden die Fahrregeln in der Schweiz erläutert: Zeitlimits, in der Schweiz gültige Versicherung, Bussen und Sonderfälle mit Geschäftsfahrzeugen.',
      'Wichtige Themen sind die Regeln zur vorübergehenden Einfuhr (Formular 15.30), die 60-Tage-Wiederausfuhrfrist und die für die Verzollung am Zollamt Stabio oder Chiasso erforderlichen Dokumente.',
    ],
    fr: [
      'Le guide de transfert auto couvre les procédures d\'immatriculation d\'un véhicule italien en Suisse et vice versa : dédouanement, contrôle technique MFK, assurance et délais de réimmatriculation.',
      'Pour les frontaliers utilisant un véhicule à plaques italiennes, il explique les règles de circulation en Suisse : limites de temps, assurance valable en Suisse, amendes et cas particuliers avec véhicules d\'entreprise.',
      'Les sujets clés incluent les règles d\'importation temporaire (formulaire 15.30), le délai de réexportation de 60 jours et les documents nécessaires au dédouanement aux bureaux de Stabio ou Chiasso.',
    ],
  },
  '/guida-frontaliere/': {
    en: [
      'The cross-border guide collects practical and up-to-date information for those who work in Ticino and live in Italy: administrative procedures, permits, required documents, and tips based on the experience of thousands of cross-border workers.',
      'Each section is designed to be consulted independently and contains direct links to official forms, relevant offices, and calculation tools to verify practical implications immediately.',
      'The guides cover the entire cross-border lifecycle: from first employment to retirement, including unemployment, car transfer, border crossings, and cross-border maternity/paternity leave.',
    ],
    de: [
      'Der Grenzgänger-Leitfaden sammelt praktische und aktuelle Informationen für alle, die im Tessin arbeiten und in Italien leben: Verwaltungsverfahren, Bewilligungen, erforderliche Dokumente und Tipps aus der Erfahrung Tausender Grenzgänger.',
      'Jeder Abschnitt ist für eigenständige Nutzung konzipiert und enthält direkte Links zu offiziellen Formularen, zuständigen Ämtern und Berechnungstools zur sofortigen Überprüfung praktischer Auswirkungen.',
      'Die Leitfäden decken den gesamten Grenzgänger-Lebenszyklus ab: vom ersten Arbeitstag bis zur Pensionierung, einschliesslich Arbeitslosigkeit, Autotransfer, Grenzübergänge und grenzüberschreitendem Mutter-/Vaterschaftsurlaub.',
    ],
    fr: [
      'Le guide frontalier rassemble des informations pratiques et actualisées pour ceux qui travaillent au Tessin et vivent en Italie : procédures administratives, permis, documents requis et conseils basés sur l\'expérience de milliers de frontaliers.',
      'Chaque section est conçue pour être consultée de manière indépendante et contient des liens directs vers les formulaires officiels, les bureaux compétents et les outils de calcul pour vérifier immédiatement les implications pratiques.',
      'Les guides couvrent l\'ensemble du cycle de vie du frontalier : du premier emploi à la retraite, en passant par le chômage, le transfert auto, les postes frontières et le congé maternité/paternité transfrontalier.',
    ],
  },

  // ───── Glossary ───────────────────────────────────────────────
  '/glossario-frontaliere/': {
    en: [
      'The glossary provides clear, contextualised definitions of technical terms every cross-border worker encounters: fiscal acronyms (AVS, LPP, LAMal, IRPEF), administrative documents (CU, 730, Lohnausweis), and legal concepts (fiscal domicile, permanent establishment).',
      'Each entry is written in accessible language and linked to the site\'s tools that use that concept, so you can go from definition to practical application in a single click.',
      'Understanding these terms is crucial for reading Swiss payslips, Italian tax declarations, and official communications from both countries. If you need to see how a concept affects your net salary, use the Tax Simulator or Payslip Calculator directly from any glossary entry.',
    ],
    de: [
      'Das Glossar bietet verständliche, kontextualisierte Definitionen der Fachbegriffe, die jeder Grenzgänger antrifft: Steuerabkürzungen (AHV, BVG, KVG, IRPEF), Verwaltungsdokumente (CU, 730, Lohnausweis) und juristische Konzepte (Steuerdomizil, Betriebsstätte).',
      'Jeder Eintrag ist in allgemeinverständlicher Sprache verfasst und mit den Tools der Website verknüpft, die das jeweilige Konzept verwenden — so gelangen Sie mit einem Klick von der Definition zur praktischen Anwendung.',
      'Das Verständnis dieser Begriffe ist entscheidend für das Lesen von Schweizer Lohnabrechnungen, italienischen Steuererklärungen und offiziellen Mitteilungen beider Länder. Nutzen Sie den Steuersimulator direkt von jedem Glossareintrag aus.',
    ],
    fr: [
      'Le glossaire fournit des définitions claires et contextualisées des termes techniques que tout frontalier rencontre : sigles fiscaux (AVS, LPP, LAMal, IRPEF), documents administratifs (CU, 730, Lohnausweis) et concepts juridiques (domicile fiscal, établissement stable).',
      'Chaque entrée est rédigée dans un langage accessible et reliée aux outils du site qui utilisent ce concept, permettant de passer de la définition à l\'application pratique en un seul clic.',
      'Comprendre ces termes est essentiel pour lire les fiches de paie suisses, les déclarations fiscales italiennes et les communications officielles des deux pays. Utilisez le simulateur fiscal directement depuis chaque entrée du glossaire.',
    ],
  },

  // ───── FAQ ────────────────────────────────────────────────────
  '/domande-frequenti-frontalieri': {
    en: [
      'The FAQ answers the most common questions from cross-border workers between Switzerland and Italy: "Do I need to file a tax return in Italy?", "How much do I pay for health insurance?", "Does the EUR 10,000 franchise apply to my case?".',
      'Each answer includes updated regulatory references and direct links to the site\'s simulators to calculate the impact on your specific situation.',
      'Questions are organised by topic — tax, pension, healthcare, administrative — and updated regularly based on legislative changes and the most recurring queries from the community.',
    ],
    de: [
      'Die FAQ beantwortet die häufigsten Fragen von Grenzgängern zwischen der Schweiz und Italien: „Muss ich in Italien eine Steuererklärung einreichen?", „Wie viel zahle ich für Krankenversicherung?", „Gilt die EUR-10.000-Franchise für meinen Fall?".',
      'Jede Antwort enthält aktuelle Gesetzesverweise und direkte Links zu den Simulatoren der Website, um die Auswirkungen auf Ihre individuelle Situation zu berechnen.',
      'Die Fragen sind nach Themen geordnet — Steuern, Vorsorge, Gesundheit, Verwaltung — und werden regelmässig auf Basis von Gesetzesänderungen und den häufigsten Anfragen der Community aktualisiert.',
    ],
    fr: [
      'La FAQ répond aux questions les plus courantes des frontaliers entre la Suisse et l\'Italie : « Dois-je faire une déclaration de revenus en Italie ? », « Combien coûte l\'assurance maladie ? », « La franchise de 10 000 EUR s\'applique-t-elle à mon cas ? ».',
      'Chaque réponse inclut des références réglementaires actualisées et des liens directs vers les simulateurs du site pour calculer l\'impact sur votre situation spécifique.',
      'Les questions sont organisées par thème — fiscal, prévoyance, santé, administratif — et mises à jour régulièrement en fonction des évolutions législatives et des interrogations les plus fréquentes de la communauté.',
    ],
  },

  // ───── Living in Ticino ───────────────────────────────────────
  '/vivere-in-ticino/operatori-telefonici': {
    en: [
      'The mobile operators comparison analyses the most affordable plans for those who live in Italy and work in Switzerland: roaming coverage, cross-border plans, call costs, and data in border areas.',
      'For cross-border workers, mobile connectivity is critical: you need coverage in both countries, no extra charge for daily roaming, and flexible data options during your commute.',
      'The comparison includes Swiss providers (Swisscom, Salt, Sunrise) and Italian ones (Iliad, ho., Vodafone), with details on cross-border add-ons, eSIM support, and coverage quality in the Ticino border area.',
    ],
    de: [
      'Der Mobilfunk-Vergleich analysiert die günstigsten Tarife für Personen, die in Italien leben und in der Schweiz arbeiten: Roaming-Abdeckung, grenzüberschreitende Tarife, Gesprächskosten und Daten im Grenzgebiet.',
      'Für Grenzgänger ist mobile Konnektivität entscheidend: Abdeckung in beiden Ländern, keine Zusatzkosten für tägliches Roaming und flexible Datenoptionen während des Pendelns.',
      'Der Vergleich umfasst Schweizer Anbieter (Swisscom, Salt, Sunrise) und italienische (Iliad, ho., Vodafone), mit Details zu grenzüberschreitenden Zusatzoptionen, eSIM-Unterstützung und Netzqualität im Tessiner Grenzgebiet.',
    ],
    fr: [
      'Le comparateur d\'opérateurs mobiles analyse les offres les plus avantageuses pour ceux qui vivent en Italie et travaillent en Suisse : couverture roaming, forfaits transfrontaliers, coûts d\'appel et données dans les zones frontalières.',
      'Pour les frontaliers, la connectivité mobile est essentielle : couverture dans les deux pays, pas de frais supplémentaires pour le roaming quotidien et options data flexibles pendant le trajet.',
      'Le comparateur inclut les opérateurs suisses (Swisscom, Salt, Sunrise) et italiens (Iliad, ho., Vodafone), avec des détails sur les options transfrontalières, le support eSIM et la qualité de couverture dans la zone frontalière tessinoise.',
    ],
  },
  '/vivere-in-ticino/spesa-e-shopping': {
    en: [
      'The grocery cost calculator compares prices of a standard basket between Swiss supermarkets (Migros, Coop, Denner) and Italian ones (Esselunga, Lidl, Eurospin), accounting for the CHF-EUR exchange rate.',
      'For many cross-border workers, shopping in Italy is a practical way to exploit the price differential: on a weekly basket of CHF 150, average savings when buying in Italy are 25–35%.',
      'The tool also highlights customs rules for goods crossing the border, VAT refund thresholds, and practical tips on which products offer the best savings when purchased on the Italian side.',
    ],
    de: [
      'Der Einkaufskostenrechner vergleicht die Preise eines Standardwarenkorbs zwischen Schweizer Supermärkten (Migros, Coop, Denner) und italienischen (Esselunga, Lidl, Eurospin) unter Berücksichtigung des CHF-EUR-Wechselkurses.',
      'Für viele Grenzgänger ist Einkaufen in Italien eine praktische Möglichkeit, das Preisgefälle zu nutzen: Bei einem Wocheneinkauf von CHF 150 beträgt die durchschnittliche Ersparnis in Italien 25–35 %.',
      'Das Tool zeigt auch Zollregeln für den Warenverkehr über die Grenze, MwSt-Erstattungsschwellen und praktische Tipps, welche Produkte auf der italienischen Seite die grössten Einsparungen bieten.',
    ],
    fr: [
      'Le calculateur du coût des courses compare les prix d\'un panier type entre les supermarchés suisses (Migros, Coop, Denner) et italiens (Esselunga, Lidl, Eurospin), en tenant compte du taux de change CHF-EUR.',
      'Pour de nombreux frontaliers, faire ses courses en Italie est un moyen concret d\'exploiter le différentiel de prix : sur un panier hebdomadaire de 150 CHF, l\'économie moyenne en Italie est de 25 à 35 %.',
      'L\'outil met aussi en évidence les règles douanières pour les marchandises traversant la frontière, les seuils de remboursement de TVA et des conseils pratiques sur les produits offrant les meilleures économies côté italien.',
    ],
  },
  '/vivere-in-ticino/costo-della-vita': {
    en: [
      'The cost of living index compares major expense categories between Switzerland (Ticino) and Italy (Lombardy/Piedmont): rent, transport, groceries, healthcare, education, and leisure.',
      'The cost-of-living differential is the key factor in choosing between a G permit (residence in Italy) and a B permit (residence in Switzerland): living in Italy can reduce fixed expenses by 30–50% compared to Ticino.',
      'Specific cost differences significantly influence the permit G versus B decision: rents in Italian border towns are typically 30–40% lower than equivalent Ticino properties, while groceries run 25–35% cheaper south of the border. These savings can offset daily commute costs and longer travel time, making an informed comparison essential before choosing your residence.',
    ],
    de: [
      'Der Lebenshaltungskostenindex vergleicht die wichtigsten Ausgabenkategorien zwischen der Schweiz (Tessin) und Italien (Lombardei/Piemont): Miete, Transport, Lebensmittel, Gesundheitswesen, Bildung und Freizeit.',
      'Das Lebenshaltungskostengefälle ist der entscheidende Faktor bei der Wahl zwischen Ausweis G (Wohnsitz in Italien) und Ausweis B (Wohnsitz in der Schweiz): Das Leben in Italien kann die Fixkosten um 30–50 % im Vergleich zum Tessin senken.',
      'Konkrete Kostenunterschiede beeinflussen die Entscheidung zwischen Ausweis G und B erheblich: Mieten in italienischen Grenzorten sind in der Regel 30–40 % niedriger als vergleichbare Objekte im Tessin, während Lebensmittel südlich der Grenze 25–35 % günstiger sind. Diese Ersparnisse können die täglichen Pendelkosten und längere Fahrzeiten ausgleichen — ein fundierter Vergleich ist daher unerlässlich.',
    ],
    fr: [
      'L\'indice du coût de la vie compare les principales catégories de dépenses entre la Suisse (Tessin) et l\'Italie (Lombardie/Piémont) : loyer, transports, alimentation, santé, éducation et loisirs.',
      'Le différentiel de coût de la vie est le facteur clé dans le choix entre un permis G (résidence en Italie) et un permis B (résidence en Suisse) : vivre en Italie peut réduire les charges fixes de 30 à 50 % par rapport au Tessin.',
      'Les écarts de coûts concrets influencent fortement le choix entre permis G et B : les loyers dans les villes frontalières italiennes sont généralement 30 à 40 % inférieurs à ceux du Tessin, tandis que les courses alimentaires coûtent 25 à 35 % de moins au sud de la frontière. Ces économies peuvent compenser les frais de trajet quotidien, rendant une comparaison approfondie indispensable.',
    ],
  },
  '/vivere-in-ticino/asili-nido': {
    en: [
      'The nursery comparator compares costs and availability of childcare facilities in Ticino and the Italian border provinces, with information on fees, schedules, waiting lists, and municipal subsidies.',
      'For cross-border families with young children, the choice of nursery is crucial: a place in Ticino can cost CHF 1,500–2,500/month, while Italian municipal rates start at EUR 300–500/month.',
      'The comparator also covers eligibility criteria, registration deadlines, and Italian bonus asilo nido (up to EUR 3,000/year) that can significantly reduce out-of-pocket childcare costs.',
    ],
    de: [
      'Der Kindertagesstätten-Vergleicher vergleicht Kosten und Verfügbarkeit von Betreuungseinrichtungen im Tessin und den italienischen Grenzprovinzen, mit Informationen zu Gebühren, Öffnungszeiten, Wartelisten und Gemeindezuschüssen.',
      'Für Grenzgängerfamilien mit Kleinkindern ist die Wahl der Kindertagesstätte entscheidend: Ein Platz im Tessin kann CHF 1.500–2.500/Monat kosten, während italienische Gemeindetarife bei EUR 300–500/Monat beginnen.',
      'Der Vergleicher zeigt auch Zulassungskriterien, Anmeldefristen und den italienischen Bonus Asilo Nido (bis zu EUR 3.000/Jahr), der die Betreuungskosten erheblich senken kann.',
    ],
    fr: [
      'Le comparateur de crèches compare les coûts et la disponibilité des structures d\'accueil au Tessin et dans les provinces frontalières italiennes, avec des informations sur les tarifs, horaires, listes d\'attente et subventions communales.',
      'Pour les familles frontalières avec de jeunes enfants, le choix de la crèche est déterminant : une place au Tessin peut coûter 1 500–2 500 CHF/mois, tandis que les tarifs communaux italiens commencent à 300–500 EUR/mois.',
      'Le comparateur présente aussi les critères d\'éligibilité, les délais d\'inscription et le bonus asilo nido italien (jusqu\'à 3 000 EUR/an) qui peut réduire considérablement les frais de garde à votre charge.',
    ],
  },
  '/vivere-in-ticino/ristrutturazioni': {
    en: [
      'The renovation calculator compares building works costs between Switzerland and Italy, factoring in Italian tax deductions (50% renovation bonus, 65% Ecobonus) and Ticino cantonal incentives.',
      'For cross-border workers who own property, Italian renovation and energy-saving deductions can be claimed on the income tax return, significantly reducing the net cost of the work.',
      'The calculator details eligible expenses, maximum deductible ceilings, and the 10-year instalment recovery schedule that applies to the Italian bonus ristrutturazione and Ecobonus schemes.',
    ],
    de: [
      'Der Renovierungsrechner vergleicht die Kosten für Bauarbeiten zwischen der Schweiz und Italien unter Berücksichtigung der italienischen Steuerabzüge (50 % Renovierungsbonus, 65 % Ecobonus) und Tessiner Kantonsincentives.',
      'Für Grenzgänger mit Immobilienbesitz können italienische Renovierungs- und Energiesparabzüge in der Steuererklärung geltend gemacht werden, was die Nettokosten der Arbeiten erheblich senkt.',
      'Der Rechner zeigt förderfähige Ausgaben, Höchstgrenzen für Abzüge und den 10-Jahres-Ratenabzug, der für den italienischen Bonus Ristrutturazione und den Ecobonus gilt.',
    ],
    fr: [
      'Le calculateur de rénovation compare les coûts de travaux entre la Suisse et l\'Italie, en tenant compte des déductions fiscales italiennes (bonus 50 % rénovation, Ecobonus 65 %) et des incitations cantonales tessinoises.',
      'Pour les frontaliers propriétaires, les déductions italiennes pour rénovation et économies d\'énergie peuvent être portées en déduction dans la déclaration de revenus, réduisant significativement le coût net des travaux.',
      'Le calculateur détaille les dépenses éligibles, les plafonds déductibles maximaux et le plan de récupération en 10 annuités applicable au bonus ristrutturazione et à l\'Ecobonus italiens.',
    ],
  },
  '/vivere-in-ticino/aziende-svizzera-italiana': {
    en: [
      'The companies directory lists the major employers in southern Switzerland (Canton Ticino), organized by sector: banking, insurance, pharmaceutical, IT, manufacturing, retail, public administration, and international organizations.',
      'For cross-border workers seeking employment, the directory provides key data on each company: sector, approximate headcount, location, and links to their careers pages for direct applications.',
      'The interactive map view pinpoints employer locations across Ticino, highlighting key economic sectors: pharmaceuticals in the Mendrisiotto, banking and finance in Lugano, and logistics along the Chiasso corridor. Canton Ticino\'s growing startup ecosystem, supported by USI and SUPSI incubators, also offers opportunities in tech and biotech for cross-border professionals.',
    ],
    de: [
      'Das Firmenverzeichnis listet die wichtigsten Arbeitgeber der Südschweiz (Kanton Tessin) nach Branche auf: Banken, Versicherungen, Pharma, IT, Industrie, Detailhandel, öffentliche Verwaltung und internationale Organisationen.',
      'Für Grenzgänger auf Jobsuche bietet das Verzeichnis Eckdaten zu jedem Unternehmen: Branche, ungefähre Mitarbeiterzahl, Standort und Links zu den Karriereseiten für Direktbewerbungen.',
      'Die interaktive Kartenansicht zeigt Arbeitgeberstandorte im gesamten Tessin und hebt die wirtschaftlichen Schwerpunkte hervor: Pharmaindustrie im Mendrisiotto, Banken und Finanzen in Lugano sowie Logistik entlang des Chiasso-Korridors. Das wachsende Startup-Ökosystem des Kantons, unterstützt durch die Inkubatoren der USI und SUPSI, bietet zudem Chancen in Tech und Biotech für Grenzgänger.',
    ],
    fr: [
      'L\'annuaire des entreprises répertorie les principaux employeurs de Suisse méridionale (Canton du Tessin) par secteur : banques, assurances, pharmaceutique, IT, industrie, commerce, administration publique et organisations internationales.',
      'Pour les frontaliers en recherche d\'emploi, l\'annuaire fournit des données clés sur chaque entreprise : secteur, effectif approximatif, localisation et liens vers les pages carrières pour des candidatures directes.',
      'La carte interactive localise les employeurs à travers le Tessin, mettant en évidence les secteurs économiques clés : industrie pharmaceutique dans le Mendrisiotto, banques et finance à Lugano, et logistique le long du corridor de Chiasso. L\'écosystème startup en croissance du canton, soutenu par les incubateurs de l\'USI et de la SUPSI, offre également des opportunités en tech et biotech pour les professionnels frontaliers.',
    ],
  },
  '/vivere-in-ticino/': {
    en: [
      'The "Living in Ticino" section covers practical aspects of daily life for those who work in the canton: housing, transport, shopping, family services, and leisure.',
      'Information is designed both for those considering a move to Switzerland and for those who stay in Italy and want to optimize daily commuting and cross-border living expenses.',
      'Practical coverage areas include housing market analysis for both sides of the border, transport options from train schedules to border crossing traffic, supermarket and shopping cost comparisons, childcare availability and fees, mobile phone plan comparisons, and home renovation cost calculators with Italian tax deduction benefits.',
    ],
    de: [
      'Der Bereich „Leben im Tessin" deckt praktische Aspekte des Alltags für im Kanton Arbeitende ab: Wohnen, Transport, Einkaufen, Familiendienste und Freizeit.',
      'Die Informationen richten sich sowohl an Personen, die einen Umzug in die Schweiz erwägen, als auch an jene, die in Italien bleiben und das tägliche Pendeln und die Lebenshaltungskosten als Grenzgänger optimieren möchten.',
      'Behandelte Praxisthemen umfassen die Wohnungsmarktanalyse beiderseits der Grenze, Transportoptionen von Zugfahrplänen bis Grenzübergangsverkehr, Supermarkt- und Einkaufskostenvergleiche, Verfügbarkeit und Kosten von Kinderbetreuung, Handytarifvergleiche sowie Renovierungskostenrechner mit italienischen Steuerabzugsmöglichkeiten.',
    ],
    fr: [
      'La section « Vivre au Tessin » couvre les aspects pratiques de la vie quotidienne pour ceux qui travaillent dans le canton : logement, transports, courses, services familiaux et loisirs.',
      'Les informations s\'adressent aussi bien à ceux qui envisagent un déménagement en Suisse qu\'à ceux qui restent en Italie et souhaitent optimiser le trajet quotidien et les dépenses de la vie transfrontalière.',
      'Les domaines pratiques couverts comprennent l\'analyse du marché immobilier des deux côtés de la frontière, les options de transport des horaires de trains au trafic frontalier, les comparaisons de coûts en supermarché, la disponibilité et les tarifs des crèches, les comparaisons de forfaits téléphoniques et les calculateurs de coûts de rénovation avec déductions fiscales italiennes.',
    ],
  },

  // ───── Statistics ─────────────────────────────────────────────
  '/statistiche/': {
    en: [
      'The statistics section presents aggregate data and trends on the cross-border phenomenon in Ticino: number of G permits by sector, average salary trends, cantonal unemployment rate, and border crossing traffic flows.',
      'Data comes from official sources (USTAT, SECO, FSO) and is updated periodically. Interactive charts allow exploration of time series and comparison of different periods.',
      'All charts are fully interactive: hover over data points for detailed values, filter by year or sector, and export visualisations for reports. Data is sourced from USTAT (Ticino cantonal statistics), SECO (State Secretariat for Economic Affairs), and the FSO (Federal Statistical Office), ensuring reliability and transparency in every figure presented.',
    ],
    de: [
      'Der Statistikbereich präsentiert aggregierte Daten und Trends zum Grenzgängerphänomen im Tessin: Anzahl der G-Bewilligungen nach Branche, durchschnittliche Gehaltsentwicklung, kantonale Arbeitslosenquote und Verkehrsströme an den Grenzübergängen.',
      'Die Daten stammen aus offiziellen Quellen (USTAT, SECO, BFS) und werden regelmässig aktualisiert. Interaktive Grafiken ermöglichen die Erkundung von Zeitreihen und den Vergleich verschiedener Perioden.',
      'Alle Diagramme sind vollständig interaktiv: Fahren Sie mit der Maus über Datenpunkte für Detailwerte, filtern Sie nach Jahr oder Branche und exportieren Sie Visualisierungen für Berichte. Die Daten stammen von USTAT (Tessiner Kantonsstatistik), SECO (Staatssekretariat für Wirtschaft) und dem BFS (Bundesamt für Statistik) — für Zuverlässigkeit und Transparenz bei jeder dargestellten Kennzahl.',
    ],
    fr: [
      'La section statistiques présente des données agrégées et des tendances sur le phénomène frontalier au Tessin : nombre de permis G par secteur, évolution des salaires moyens, taux de chômage cantonal et flux de trafic aux postes frontières.',
      'Les données proviennent de sources officielles (USTAT, SECO, OFS) et sont mises à jour périodiquement. Les graphiques interactifs permettent d\'explorer les séries temporelles et de comparer différentes périodes.',
      'Tous les graphiques sont entièrement interactifs : survolez les points de données pour les valeurs détaillées, filtrez par année ou secteur, et exportez les visualisations pour vos rapports. Les données proviennent de l\'USTAT (statistique cantonale tessinoise), du SECO (Secrétariat d\'État à l\'économie) et de l\'OFS (Office fédéral de la statistique), garantissant fiabilité et transparence pour chaque chiffre présenté.',
    ],
  },

  // ───── Homepage (all locales) ─────────────────────────────────
  '/': {
    en: [
      'Frontaliere Ticino is the reference platform for cross-border workers between Switzerland (Canton Ticino) and Italy: it offers tax simulators, service comparators, practical guides, and decision-making tools updated for 2026.',
      'On the homepage you will find a quick summary of the most relevant news for cross-border workers, the data point of the week from official sources, and fast access to all the main simulators: net salary, payslip, permit comparison, bonuses, leave, and residence.',
      'The platform is designed for mobile-first consulting during commute times: every section has a precise goal, with concise entry points and complete deep-dives on dedicated pages.',
    ],
    de: [
      'Frontaliere Ticino ist die Referenzplattform für Grenzgänger zwischen der Schweiz (Kanton Tessin) und Italien: Sie bietet Steuersimuloren, Dienstleistungsvergleiche, praktische Leitfäden und Entscheidungshilfen, aktualisiert für 2026.',
      'Auf der Startseite finden Sie eine schnelle Zusammenfassung der relevantesten Nachrichten für Grenzgänger, den Datenpunkt der Woche aus offiziellen Quellen und schnellen Zugang zu allen Hauptsimulatoren: Nettogehalt, Lohnabrechnung, Bewilligungsvergleich, Boni, Urlaub und Wohnsitz.',
      'Die Plattform ist für die mobile Nutzung während der Pendelzeiten konzipiert: Jeder Abschnitt hat ein präzises Ziel, mit kompakten Einstiegspunkten und vollständigen Vertiefungen auf den jeweiligen Unterseiten.',
    ],
    fr: [
      'Frontaliere Ticino est la plateforme de référence pour les travailleurs frontaliers entre la Suisse (Canton du Tessin) et l\'Italie : elle propose des simulateurs fiscaux, des comparateurs de services, des guides pratiques et des outils d\'aide à la décision mis à jour pour 2026.',
      'Sur la page d\'accueil, vous trouverez un résumé rapide des actualités les plus pertinentes pour les frontaliers, le chiffre de la semaine issu de sources officielles, et un accès rapide à tous les simulateurs principaux : salaire net, fiche de paie, comparaison de permis, bonus, congés et résidence.',
      'La plateforme est conçue pour une consultation mobile pendant les trajets : chaque section a un objectif précis, avec des points d\'entrée concis et des approfondissements complets sur les pages dédiées.',
    ],
  },

  // ───── Glossary entries (generic, for terms without specific editorial) ──
  // This matches individual entries like /glossario-frontaliere/lohnausweis
  // since SECTION_EDITORIAL_KEYS sorts longest-first and this is more specific
  // than /glossario-frontaliere/ which is the index page.
  // Note: NOT used — individual entries match the /glossario-frontaliere/ prefix.
  // Extended editorial for the glossary section is in the existing key above.

  // ───── Border crossing waiting times (generic, for individual crossings) ──
  // Note: Individual crossings like /guida-frontaliere/tempi-attesa-dogana/lanzo-d-intelvi-arogno
  // match /guida-frontaliere/tempi-attesa-dogana which is already defined above.

  // ───── Articles hub ──────────────────────────────────────────
  '/articoli-frontaliere/': {
    en: [
      'The cross-border worker articles section is an editorially curated hub covering the key topics that matter to those who work in Ticino and live in Italy: taxation under the New 2026 Agreement, LAMal vs Italian NHS health insurance, pension planning across two countries, and practical administrative procedures.',
      'Each article includes concrete scenarios with real numbers, links to the relevant calculators, and references to current Swiss and Italian legislation so you can immediately verify how the information applies to your situation.',
      'Articles are categorised by topic — fiscal, practical, news, pension — and updated whenever the law changes or new official data is published. The collection covers both new cross-border workers navigating the system for the first time and experienced workers optimising their financial position.',
    ],
    de: [
      'Der Grenzgänger-Artikelbereich ist ein redaktionell kuratierter Hub, der die wichtigsten Themen für Personen abdeckt, die im Tessin arbeiten und in Italien leben: Besteuerung nach dem Neuen Abkommen 2026, KVG- vs. italienisches NHS-Krankenversicherung, grenzüberschreitende Altersvorsorge und praktische Verwaltungsverfahren.',
      'Jeder Artikel enthält konkrete Szenarien mit echten Zahlen, Links zu den relevanten Rechnern und Verweise auf aktuelle Schweizer und italienische Gesetzgebung, damit Sie sofort überprüfen können, wie die Informationen auf Ihre Situation zutreffen.',
      'Artikel sind nach Thema kategorisiert — Steuer, Praktisch, Aktuell, Vorsorge — und werden aktualisiert, wenn sich Gesetze ändern oder neue offizielle Daten veröffentlicht werden.',
    ],
    fr: [
      'La section articles frontaliers est un hub éditorial couvrant les sujets clés pour ceux qui travaillent au Tessin et vivent en Italie : fiscalité selon le Nouvel Accord 2026, assurance maladie LAMal vs SSN italien, prévoyance retraite transfrontalière et procédures administratives pratiques.',
      'Chaque article inclut des scénarios concrets avec de vrais chiffres, des liens vers les calculateurs pertinents et des références à la législation suisse et italienne en vigueur pour vérifier immédiatement comment l\'information s\'applique à votre situation.',
      'Les articles sont catégorisés par thème — fiscal, pratique, actualité, retraite — et mis à jour à chaque changement législatif ou publication de nouvelles données officielles.',
    ],
  },

  // ───── Ticino public holidays ────────────────────────────────
  '/tasse-e-pensione/festivita-ticino': {
    en: [
      'Canton Ticino observes 15 public holidays per year — the 9 federal Swiss holidays plus 6 cantonal holidays specific to Ticino. For cross-border workers, these dates directly affect overtime calculations, pay for days worked on holidays (at least 1.25× rate), and whether the employer must pay for the holiday even if the worker is absent.',
      'Public holidays that fall on weekdays reduce the number of working days in that month, which can affect prorated salary calculations for workers on monthly pay, holiday entitlement accrual, and the distribution of the 13th month payment across the calendar year.',
      'Cross-border workers should also note that Italian public holidays do not automatically apply in Switzerland: if you are working in Ticino, Swiss holidays govern your schedule. However, Swiss law allows workers to take Italian national holidays as vacation days if agreed with the employer in writing.',
    ],
    de: [
      'Der Kanton Tessin feiert 15 Feiertage pro Jahr — die 9 nationalen Schweizer Feiertage plus 6 kantonale Feiertage, die speziell für das Tessin gelten. Für Grenzgänger wirken sich diese Daten direkt auf die Überstundenberechnung, die Vergütung für an Feiertagen geleistete Arbeit (mindestens 1,25-fach) und die Lohnfortzahlungspflicht aus.',
      'Feiertage, die auf Werktage fallen, reduzieren die Anzahl der Arbeitstage im jeweiligen Monat und können anteilige Gehaltsberechnungen, die Urlaubsrückstellungsrate und die Verteilung des 13. Monatslohns beeinflussen.',
      'Grenzgänger sollten auch beachten, dass italienische Feiertage in der Schweiz nicht automatisch gelten. In Ticino arbeitende Grenzgänger unterliegen dem Schweizer Feiertagskalender, können aber mit schriftlicher Arbeitgebervereinbarung italienische Nationalfeiertage als Urlaubstage nehmen.',
    ],
    fr: [
      'Le Canton du Tessin observe 15 jours fériés par an — les 9 jours fériés fédéraux suisses plus 6 jours fériés cantonaux spécifiques au Tessin. Pour les frontaliers, ces dates impactent directement le calcul des heures supplémentaires, la rémunération des jours travaillés en jours fériés (minimum 1,25×) et l\'obligation de l\'employeur de payer ces jours.',
      'Les jours fériés tombant en semaine réduisent le nombre de jours ouvrables du mois, ce qui peut affecter les calculs de salaire au prorata, l\'accumulation des droits aux congés et la répartition du 13e mois sur l\'année civile.',
      'Les frontaliers doivent aussi noter que les jours fériés italiens ne s\'appliquent pas automatiquement en Suisse : ceux qui travaillent au Tessin sont soumis au calendrier suisse, mais peuvent prendre les jours fériés italiens en congés payés sur accord écrit de l\'employeur.',
    ],
  },

  // ───── Grocery price comparison ─────────────────────────────
  '/compara-servizi/confronta-prezzi-spesa': {
    en: [
      'The grocery price comparator benchmarks a standard weekly shopping basket across Swiss supermarkets (Migros, Coop, Denner, Aldi Suisse) and Italian equivalents (Esselunga, Lidl, Eurospin, Conad), applying the current CHF-EUR exchange rate to show real cost in a single currency.',
      'The comparison covers over 50 product categories: fresh produce, dairy, meat, packaged goods, beverages, and personal care items. On average, identical branded products cost 35-55% more in Ticino than in the Italian border regions, making cross-border grocery shopping a significant monthly saving for many frontalieri families.',
      'Beyond the basket total, the tool shows which product categories offer the greatest savings in Italy (meat, cheese, wine, fresh pasta) versus products where Swiss quality or local availability makes Swiss supermarkets competitive (fresh bakery, Swiss chocolate, specialty dairy). Results update monthly as scanner price data is refreshed.',
    ],
    de: [
      'Der Lebensmittelpreisvergleich bewertet einen standardisierten Wocheneinkauf in Schweizer Supermärkten (Migros, Coop, Denner, Aldi Suisse) und italienischen Pendants (Esselunga, Lidl, Eurospin, Conad) und wendet den aktuellen CHF-EUR-Wechselkurs an.',
      'Der Vergleich umfasst über 50 Produktkategorien: Frischprodukte, Milchprodukte, Fleisch, Fertigprodukte, Getränke und Körperpflegeartikel. Im Durchschnitt kosten identische Markenprodukte im Tessin 35-55 % mehr als in den italienischen Grenzregionen.',
      'Das Tool zeigt auch, welche Kategorien in Italien am meisten sparen (Fleisch, Käse, Wein, frische Pasta) versus Produkte, bei denen Schweizer Qualität oder lokale Verfügbarkeit die Schweizer Supermärkte wettbewerbsfähig macht. Ergebnisse werden monatlich aktualisiert.',
    ],
    fr: [
      'Le comparateur de prix alimentaires compare un panier de courses hebdomadaire standard dans les supermarchés suisses (Migros, Coop, Denner, Aldi Suisse) et italiens (Esselunga, Lidl, Eurospin, Conad), en appliquant le taux de change CHF-EUR actuel.',
      'La comparaison couvre plus de 50 catégories de produits. En moyenne, les produits de marque identiques coûtent 35 à 55 % plus cher au Tessin que dans les régions frontalières italiennes, faisant des courses en Italie une économie mensuelle significative pour de nombreuses familles frontalières.',
      'L\'outil indique aussi quelles catégories offrent les plus grandes économies en Italie (viande, fromage, vin, pâtes fraîches) versus les produits où la qualité suisse ou la disponibilité locale rend les supermarchés suisses compétitifs. Les résultats sont mis à jour mensuellement.',
    ],
  },

  // ───── Mobile operator comparison ───────────────────────────
  '/compara-servizi/confronta-operatori-mobili': {
    en: [
      'The mobile operator comparator evaluates plans from Swiss operators (Swisscom, Salt, Sunrise, Yallo, Aldi Talk CH) and Italian operators (TIM, Vodafone IT, WindTre, Iliad IT) specifically for cross-border workers who need reliable coverage in both countries without excessive roaming charges.',
      'Key criteria for frontalieri: daily cross-border usage (EU roaming is included in most Italian plans under EU regulation, while Swiss operators are not EU-bound), data allowances for border zone reception gaps, calling between Swiss and Italian numbers, and international transfer costs when sending CHF earnings to an Italian bank account.',
      'The comparison is structured around three typical cross-border usage profiles: commuter (high data, daily crossing), remote-first (occasional border crossing, video calls priority), and family plan (multiple SIMs, children in Italian schools). Select your profile to see the most relevant operator ranking.',
    ],
    de: [
      'Der Mobilfunkanbieter-Vergleich bewertet Tarife von Schweizer Anbietern (Swisscom, Salt, Sunrise, Yallo) und italienischen Anbietern (TIM, Vodafone IT, WindTre, Iliad IT) speziell für Grenzgänger, die in beiden Ländern eine zuverlässige Abdeckung ohne übermässige Roaming-Kosten benötigen.',
      'Wesentliche Kriterien: tägliche grenzüberschreitende Nutzung (EU-Roaming ist in den meisten italienischen Tarifen enthalten, während Schweizer Anbieter nicht EU-gebunden sind), Datenkontingente für Empfangslücken in der Grenzzone und Anrufkosten zwischen Schweizer und italienischen Nummern.',
      'Der Vergleich ist nach drei typischen Grenzgänger-Nutzungsprofilen strukturiert: Pendler (hohe Datenmenge, tägliches Überqueren), Remote-First (gelegentliches Grenzüberschreiten, Videokonferenzen) und Familienplan (mehrere SIM-Karten). Wählen Sie Ihr Profil für das relevanteste Anbieterranking.',
    ],
    fr: [
      'Le comparateur d\'opérateurs mobiles évalue les forfaits des opérateurs suisses (Swisscom, Salt, Sunrise, Yallo) et italiens (TIM, Vodafone IT, WindTre, Iliad IT) spécifiquement pour les frontaliers ayant besoin d\'une couverture fiable dans les deux pays sans frais d\'itinérance excessifs.',
      'Critères clés : utilisation transfrontalière quotidienne (le roaming UE est inclus dans la plupart des forfaits italiens selon la réglementation UE, les opérateurs suisses n\'étant pas soumis à l\'UE), quotas de données et coûts d\'appel entre numéros suisses et italiens.',
      'La comparaison est structurée autour de trois profils d\'utilisation frontalière typiques : pendulaire (données élevées, traversée quotidienne), remote-first (traversée occasionnelle, priorité visioconférence) et forfait famille (plusieurs SIM). Sélectionnez votre profil pour le classement le plus pertinent.',
    ],
  },

  // ───── Renovation bonus calculator ──────────────────────────
  '/compara-servizi/calcola-bonus-ristrutturazione': {
    en: [
      'The renovation bonus calculator helps cross-border workers who own property in Italy estimate the net cost of home improvement works after applying Italian fiscal incentives: the 50% renovation deduction (Bonus Ristrutturazione), the 65% Ecobonus for energy efficiency upgrades, the Superbonus for qualifying thermal envelope improvements, and the 36% furniture bonus for new appliances purchased after renovation.',
      'The tool calculates the deduction spread (the bonus is recovered over 10 equal annual IRPEF deductions), the total fiscal saving over the full recovery period, and the effective net cost of the works. It accounts for the EUR 10,000 franchise applicable to new cross-border workers under the 2026 Agreement when calculating how much of the Italian tax liability can absorb the deduction.',
      'For cross-border workers, coordination between Swiss withholding tax paid and Italian IRPEF is critical: the deduction is only valuable if you have Italian tax liability to offset. The calculator shows the breakeven point and recommends whether maximising the deduction is optimal or whether alternative investments offer better after-tax returns given your specific Swiss-Italian tax position.',
    ],
    de: [
      'Der Renovierungsbonus-Rechner hilft Grenzgängern, die in Italien Immobilien besitzen, die Nettokosten von Renovierungsarbeiten nach Anwendung italienischer Steueranreize zu schätzen: 50% Renovierungsabzug, 65% Ökobonus für Energieeffizienz-Upgrades, Superbonus und 36% Möbelbonus.',
      'Das Tool berechnet die Abzugsverteilung (der Bonus wird über 10 gleiche jährliche IRPEF-Abzüge zurückgewonnen), die gesamte Steuereinsparung über die gesamte Rückgewinnungsperiode und die effektiven Nettokosten. Es berücksichtigt die EUR 10.000-Franchise für neue Grenzgänger nach dem Abkommen 2026.',
      'Für Grenzgänger ist die Koordination zwischen der in der Schweiz gezahlten Quellensteuer und der italienischen IRPEF entscheidend: Der Abzug ist nur dann wertvoll, wenn Sie eine ausreichende italienische Steuerschuld haben. Der Rechner zeigt den Breakeven-Punkt.',
    ],
    fr: [
      'Le calculateur de bonus rénovation aide les frontaliers propriétaires en Italie à estimer le coût net des travaux après application des incitations fiscales italiennes : déduction rénovation 50%, Écobonus 65% pour travaux d\'efficacité énergétique, Superbonus et bonus mobilier 36%.',
      'L\'outil calcule l\'étalement de la déduction (le bonus est récupéré en 10 tranches annuelles égales de déduction IRPEF), l\'économie fiscale totale sur la période de récupération et le coût net effectif. Il tient compte de la franchise de 10 000 EUR pour les nouveaux frontaliers selon l\'Accord 2026.',
      'Pour les frontaliers, la coordination entre l\'impôt à la source suisse payé et l\'IRPEF italienne est critique : la déduction n\'est utile que si vous avez une charge fiscale italienne suffisante. Le calculateur montre le point d\'équilibre et recommande la stratégie optimale selon votre position fiscale suisse-italienne.',
    ],
  },

  // ───── Living in Italy ───────────────────────────────────────
  '/vivere-in-ticino/vivere-in-italia': {
    en: [
      'This section covers the practical realities of living in Italy while working in Swiss Canton Ticino — the daily life of around 70,000 frontalieri who make this choice. Topics covered include Italian border regions (Como, Varese, Verbano-Cusio-Ossola, Novara provinces), commute times to the main border crossings, and the administrative consequences of Italian tax residence.',
      'Italian residence means paying IRPEF and regional/municipal surcharges on your worldwide income, maintaining AIRE registration if moving abroad, and potentially accessing Italian public services (healthcare via Italian NHS, Italian public schools for children, Italian state pension contributions from INPS). The guide maps out all these obligations and entitlements clearly.',
      'For families with children, living in Italy gives access to Italian schooling at a fraction of Swiss tuition, Italian public healthcare without LAMal premiums (for G permit workers who opt for Italian NHS), and a cost of living that is typically 30-45% lower than equivalent accommodation in Lugano or Bellinzona. The section helps you calculate the real net advantage of Italian residence versus Swiss residency with a B permit.',
    ],
    de: [
      'Dieser Bereich deckt die praktischen Realitäten des Lebens in Italien bei der Arbeit im Schweizer Kanton Tessin ab — den Alltag von rund 70.000 Grenzgängern, die diese Wahl treffen. Behandelte Themen: italienische Grenzregionen (Como, Varese, Verbano-Cusio-Ossola, Novara), Pendelzeiten und administrative Konsequenzen des italienischen Steuerwohnsitzes.',
      'Italienischer Wohnsitz bedeutet IRPEF- und Regional-/Kommunalzuschlagszahlungen auf das Welteinkommen, AIRE-Registrierung und potenziellen Zugang zu italienischen öffentlichen Diensten (NHS, Schulen, INPS-Rentenversicherung). Der Leitfaden zeigt alle Pflichten und Ansprüche klar auf.',
      'Für Familien mit Kindern bietet das Leben in Italien Zugang zu günstigerer Schulbildung und öffentlicher Gesundheitsversorgung ohne LAMal-Prämien (für G-Bewilligungsinhaber, die den italienischen NHS wählen), bei Lebenshaltungskosten, die typischerweise 30-45 % niedriger sind als im Tessin.',
    ],
    fr: [
      'Cette section couvre les réalités pratiques de la vie en Italie tout en travaillant dans le Canton suisse du Tessin — le quotidien d\'environ 70 000 frontaliers qui font ce choix. Sujets traités : régions frontalières italiennes (provinces de Côme, Varese, Verbano-Cusio-Ossola, Novare), temps de trajet et conséquences administratives de la résidence fiscale italienne.',
      'La résidence italienne implique le paiement de l\'IRPEF et des surtaxes régionales/communales sur les revenus mondiaux, l\'inscription AIRE et l\'accès potentiel aux services publics italiens (SSN, écoles publiques italiennes, cotisations retraite INPS). Le guide présente clairement toutes ces obligations et droits.',
      'Pour les familles avec enfants, vivre en Italie donne accès à une scolarité moins coûteuse, aux soins de santé publics sans primes LAMal (pour les titulaires de permis G qui optent pour le SSN italien), avec un coût de la vie généralement 30-45% inférieur à celui de Lugano ou Bellinzona.',
    ],
  },

  // ───── Border municipalities ─────────────────────────────────
  '/vivere-in-ticino/comuni-di-frontiera': {
    en: [
      'The border municipalities guide covers the Italian comuni within 20 km of the Swiss-Ticino border — the geographic threshold that determines the fiscal regime for cross-border workers under the 2026 New Agreement. Frontalieri residing in these municipalities benefit from the transitional regime where Switzerland returns approximately 40% of withholding tax to the Italian municipalities of origin.',
      'Practical information includes: distance from each comune to the nearest border crossing, commute time estimates to major Ticino employment centres (Lugano, Bellinzona, Locarno, Mendrisio), local public transport links (FerrovieNord, TILO regional rail, FlixBus routes), and rental market data showing average monthly rents versus Ticino equivalents.',
      'The guide also covers the administrative process for certifying residence in a border municipality for Swiss permit purposes, how to document the 20 km distance requirement, and what happens if you move to a comune outside the 20 km zone while keeping your Swiss job — including the fiscal implications of shifting to the new frontalieri regime with full Swiss withholding tax.',
    ],
    de: [
      'Der Leitfaden zu den Grenzgemeinden behandelt die italienischen Comuni innerhalb von 20 km von der Schweizer-Tessiner Grenze — die geografische Schwelle, die das Steuerregime für Grenzgänger nach dem Neuen Abkommen 2026 bestimmt. In diesen Gemeinden wohnhafte Grenzgänger profitieren vom Übergangsregime, bei dem die Schweiz ca. 40 % der Quellensteuer an die italienischen Herkunftsgemeinden zurückgibt.',
      'Praktische Informationen: Entfernung jeder Gemeinde zum nächsten Grenzübergang, Pendelzeitschätzungen zu wichtigen Tessiner Beschäftigungszentren (Lugano, Bellinzona, Locarno, Mendrisio), ÖPNV-Verbindungen und Mietmarktdaten.',
      'Der Leitfaden behandelt auch das administrative Verfahren zur Bescheinigung des Wohnsitzes in einer Grenzgemeinde für Schweizer Bewilligungszwecke und die steuerlichen Folgen eines Umzugs ausserhalb der 20-km-Zone.',
    ],
    fr: [
      'Le guide des communes frontalières couvre les comuni italiens dans un rayon de 20 km de la frontière suisse-tessinoise — le seuil géographique déterminant le régime fiscal pour les frontaliers selon le Nouvel Accord 2026. Les frontaliers résidant dans ces communes bénéficient du régime transitoire où la Suisse reverse environ 40% de l\'impôt à la source aux communes italiennes d\'origine.',
      'Informations pratiques : distance de chaque commune au poste frontière le plus proche, estimations des temps de trajet vers les principaux centres d\'emploi tessinois (Lugano, Bellinzone, Locarno, Mendrisio), liaisons de transport public et données du marché locatif.',
      'Le guide couvre aussi la procédure administrative pour certifier la résidence dans une commune frontalière pour les besoins du permis suisse et les implications fiscales d\'un déménagement hors de la zone de 20 km tout en conservant l\'emploi en Suisse.',
    ],
  },

  // ───── Italian-speaking Swiss schools ───────────────────────
  '/vivere-in-ticino/scuole-svizzera-italiana': {
    en: [
      'The Italian-speaking Swiss schools guide covers the education system in Canton Ticino and the bilingual border areas of Graubünden (Grigioni) for cross-border families considering schooling options in Switzerland. The Ticino system follows the Swiss model: scuola dell\'infanzia (3-6 years), scuola elementare (6-11), scuola media (11-15), and liceo/scuola professionale (15-18).',
      'For cross-border workers with children, enrolling in Ticino schools involves residency status checks — typically B permit holders can enrol children easily, while G permit holders face varying cantonal rules. The guide maps out school zones, lists the main public and private institutions, and explains the Ticino school calendar and holiday schedule.',
      'A cost comparison is included: Ticino public schools are free (with small material fees), while private schools range from CHF 15,000 to CHF 35,000 per year. Italian public schools in the border provinces offer a cheaper alternative for families living in Italy, with the guide providing commute time estimates and information on Italian-Swiss bilingual school programmes.',
    ],
    de: [
      'Der Schulführer für die italienischsprachige Schweiz deckt das Bildungssystem im Kanton Tessin und den zweisprachigen Grenzgebieten Graubündens für grenzüberschreitende Familien ab: Scuola dell\'Infanzia (3-6 Jahre), Scuola Elementare (6-11), Scuola Media (11-15) und Liceo/Scuola Professionale (15-18).',
      'Für Grenzgänger mit Kindern beinhaltet die Einschulung im Tessin Wohnsitzprüfungen — B-Bewilligungsinhaber können Kinder in der Regel problemlos anmelden, während G-Bewilligungsinhaber unterschiedlichen Kantonsregeln gegenüberstehen. Der Leitfaden listet Schulzonen, Hauptinstitutionen und erklärt den Tessiner Schulkalender.',
      'Ein Kostenvergleich ist enthalten: Öffentliche Schulen im Tessin sind kostenlos, private Schulen kosten 15.000-35.000 CHF pro Jahr. Italienische öffentliche Schulen in den Grenzprovinzen bieten eine günstigere Alternative für in Italien lebende Familien.',
    ],
    fr: [
      'Le guide des écoles de Suisse italophone couvre le système éducatif du Canton du Tessin et des zones frontalières bilingues des Grisons pour les familles transfrontalières : scuola dell\'infanzia (3-6 ans), scuola elementare (6-11), scuola media (11-15) et lycée/école professionnelle (15-18).',
      'Pour les frontaliers avec enfants, l\'inscription dans les écoles du Tessin implique des vérifications de statut de résidence — les titulaires de permis B peuvent généralement inscrire leurs enfants facilement, tandis que les titulaires de permis G font face à des règles cantonales variables.',
      'Une comparaison des coûts est incluse : les écoles publiques au Tessin sont gratuites, les écoles privées coûtent de CHF 15 000 à CHF 35 000 par an. Les écoles publiques italiennes dans les provinces frontalières offrent une alternative moins coûteuse pour les familles vivant en Italie.',
    ],
  },

  // ───── Border crossing traffic history ───────────────────────
  '/statistiche/storico-traffico-dogane': {
    en: [
      'The border crossing traffic history section presents time-series data on the volume and timing of frontalieri crossings at all major Ticino-Italy border points: Chiasso, Como-Monte Olimpino, Ponte Tresa, Stabio, Gaggiolo, Balerna, and the smaller secondary crossings. Data covers monthly vehicle counts, seasonal trends, and peak hour distributions.',
      'For cross-border workers planning their commute, the historical data reveals actionable patterns: which months have the heaviest congestion (September, October, and January when school terms restart), which crossings have improved most with recent infrastructure investments, and how total frontalieri traffic has trended since the 2020 pandemic disruption through to 2026.',
      'The dataset is sourced from the Swiss Federal Customs Administration (BAZG) and the Italian Guardia di Finanza crossing records. Charts are fully interactive — filter by crossing, time period, and traffic type (car, bus, truck) to identify the optimal commute window for your specific crossing point.',
    ],
    de: [
      'Der historische Grenzübergangsverkehr präsentiert Zeitreihendaten zum Volumen und Timing der Grenzgänger-Überquerungen an allen wichtigen Tessin-Italien-Grenzübergängen: Chiasso, Como-Monte Olimpino, Ponte Tresa, Stabio, Gaggiolo, Balerna und kleinere Nebenübergänge.',
      'Für Grenzgänger bei der Pendelplanung zeigen die historischen Daten umsetzbare Muster: welche Monate die stärkste Überlastung haben (September, Oktober, Januar bei Schuljahresbeginn), welche Übergänge sich mit Infrastrukturinvestitionen am meisten verbessert haben und wie sich der Gesamtverkehr seit 2020 entwickelt hat.',
      'Der Datensatz stammt von der Schweizerischen Eidgenössischen Zollverwaltung (BAZG) und den italienischen Guardia-di-Finanza-Grenzaufzeichnungen. Diagramme sind vollständig interaktiv: Filtern Sie nach Übergang, Zeitraum und Verkehrstyp.',
    ],
    fr: [
      'La section historique du trafic frontalier présente des données de séries temporelles sur le volume et le calendrier des passages de frontaliers à tous les principaux postes frontaliers Tessin-Italie : Chiasso, Como-Monte Olimpino, Ponte Tresa, Stabio, Gaggiolo, Balerna et les passages secondaires.',
      'Pour les frontaliers planifiant leur trajet, les données historiques révèlent des patterns exploitables : quels mois ont la congestion la plus forte (septembre, octobre, janvier lors de la rentrée scolaire), quels postes se sont le plus améliorés avec les investissements d\'infrastructure.',
      'Le jeu de données provient de l\'Administration fédérale des douanes suisses (BAZG) et des enregistrements de la Guardia di Finanza italienne. Les graphiques sont entièrement interactifs — filtrez par poste, période et type de trafic pour identifier la fenêtre de trajet optimale.',
    ],
  },

  // ───── Salary statistics comparison ─────────────────────────
  '/statistiche/confronta-stipendi': {
    en: [
      'The salary statistics section compares median and average gross wages across 24 industry sectors in Canton Ticino (CHF) versus the equivalent Italian provinces of Como, Varese, and Verbano-Cusio-Ossola (EUR), converted at current exchange rates to enable direct comparison of purchasing power.',
      'Data is sourced from the Swiss Federal Statistical Office (FSO/BFS) annual wage survey, ISTAT Italian employment statistics, and the SECO Cantonal Labour Market Monitor, providing a statistically robust picture of the cross-border salary differential by role, experience level, and contract type for 2026.',
      'The comparison is designed to support real negotiation decisions: if you are applying for a role in Ticino or planning to renegotiate, knowing the median salary for your sector and experience level in Switzerland versus Italy gives you objective data to back your position. The tool also calculates the net advantage after Swiss social contributions and cantonal withholding tax versus the Italian equivalent after IRPEF.',
    ],
    de: [
      'Die Gehaltsstatistik vergleicht Median- und Durchschnittsbruttogehälter in 24 Branchen im Kanton Tessin (CHF) mit den äquivalenten italienischen Provinzen Como, Varese und Verbano-Cusio-Ossola (EUR), umgerechnet zu aktuellen Wechselkursen für einen direkten Kaufkraftvergleich.',
      'Daten stammen aus der jährlichen BFS-Lohnerhebung, ISTAT-Beschäftigungsstatistiken und dem SECO-Kantonsarbeitsmarktmonitor — eine statistisch robuste Darstellung des grenzüberschreitenden Gehaltsgefälles nach Branche, Erfahrungsstufe und Vertragstyp für 2026.',
      'Der Vergleich unterstützt echte Verhandlungsentscheidungen: Kenntnis des Mediangehalts für Ihren Sektor und Ihre Erfahrungsstufe in der Schweiz versus Italien gibt Ihnen objektive Daten für Gehaltsverhandlungen. Das Tool berechnet auch den Nettovorteil nach Schweizer Sozialabgaben und kantonaler Quellensteuer.',
    ],
    fr: [
      'La section statistiques salariales compare les salaires bruts médians et moyens dans 24 secteurs d\'activité du Canton du Tessin (CHF) versus les provinces italiennes équivalentes de Côme, Varèse et Verbano-Cusio-Ossola (EUR), convertis au taux de change actuel pour une comparaison directe du pouvoir d\'achat.',
      'Les données proviennent de l\'enquête annuelle sur les salaires de l\'OFS, des statistiques d\'emploi ISTAT et du Moniteur du Marché du Travail Cantonal SECO — une image statistiquement robuste du différentiel salarial transfrontalier par rôle, niveau d\'expérience et type de contrat pour 2026.',
      'La comparaison est conçue pour soutenir de vraies décisions de négociation : connaître le salaire médian pour votre secteur en Suisse versus Italie vous donne des données objectives. L\'outil calcule aussi l\'avantage net après cotisations sociales suisses et impôt à la source cantonal.',
    ],
  },

  // ───── Salary landing pages (for all /calcola-stipendio/stipendio-netto-* pages) ──
  '/calcola-stipendio/stipendio-netto': {
    en: [
      'This salary simulation shows the complete tax breakdown for a cross-border worker at this specific gross income level: Swiss social deductions (AVS 5.3%, unemployment 1.1%, accident insurance, daily sickness benefits), Canton Ticino withholding tax, and Italian IRPEF after the EUR 10,000 franchise under the 2026 New Agreement.',
      'The net salary depends on several key parameters: marital status (tax table A for single, C for married), number of dependent children (each child reduces the withholding tax bracket), work percentage, and distance from the Swiss border (the 20 km rule determines whether the old or new fiscal regime applies).',
      'After viewing the simulation, use the "What If" tool to instantly see how changing one parameter (marriage, child, part-time) affects your net pay. You can also compare the result against actual cross-border living costs using the Cost of Living comparator.',
    ],
    de: [
      'Diese Gehaltssimulation zeigt die vollständige Steueraufschlüsselung für einen Grenzgänger auf dieser bestimmten Bruttoeinkommensstufe: Schweizer Sozialabzüge (AHV 5,3 %, Arbeitslosenversicherung 1,1 %, Unfallversicherung, Krankentaggeld), Tessiner Quellensteuer und italienische IRPEF nach der EUR 10.000-Freibetrag gemäss dem Neuen Abkommen 2026.',
      'Das Nettogehalt hängt von mehreren Schlüsselparametern ab: Familienstand (Steuertabelle A für Alleinstehende, C für Verheiratete), Anzahl unterhaltsberechtigter Kinder, Beschäftigungsgrad und Entfernung zur Schweizer Grenze (die 20-km-Regel bestimmt das geltende Steuerregime).',
      'Nutzen Sie nach der Simulation das „Was-wäre-wenn"-Tool, um sofort zu sehen, wie eine Parameteränderung (Heirat, Kind, Teilzeit) Ihr Nettogehalt beeinflusst.',
    ],
    fr: [
      'Cette simulation salariale montre la décomposition fiscale complète pour un frontalier à ce niveau de revenu brut spécifique : déductions sociales suisses (AVS 5,3 %, chômage 1,1 %, assurance accidents, indemnités journalières maladie), impôt à la source du Canton du Tessin et IRPEF italienne après la franchise de 10 000 EUR selon le Nouvel Accord 2026.',
      'Le salaire net dépend de plusieurs paramètres clés : état civil (barème A pour célibataire, C pour marié), nombre d\'enfants à charge, taux d\'activité et distance de la frontière suisse (la règle des 20 km détermine le régime fiscal applicable).',
      'Après la simulation, utilisez l\'outil « Et si » pour voir instantanément comment la modification d\'un paramètre (mariage, enfant, temps partiel) affecte votre salaire net.',
    ],
  },
};

/**
 * Sorted prefixes (longest first) for correct prefix-matching.
 * This ensures e.g. '/calcola-stipendio/simula-busta-paga' matches
 * before the generic '/calcola-stipendio/' fallback.
 */
export const SECTION_EDITORIAL_KEYS: string[] = Object.keys(SECTION_EDITORIAL)
  .sort((a, b) => b.length - a.length);
