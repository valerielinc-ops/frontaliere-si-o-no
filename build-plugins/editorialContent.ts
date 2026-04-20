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
 it: [
 'Il simulatore di busta paga ricostruisce voce per voce lo stipendio netto del frontaliere partendo dal lordo annuo in franchi svizzeri. Le deduzioni sociali obbligatorie — AVS/AI/IPG al 5,3 %, assicurazione contro la disoccupazione AC all\'1,1 %, infortuni non professionali LAA e indennità giornaliera di malattia IJM — vengono sottratte prima del calcolo dell\'imposta alla fonte cantonale, seguendo esattamente la sequenza di una busta paga reale svizzera.',
 'L\'imposta alla fonte viene calcolata secondo le tabelle A/B/C/H del Canton Ticino aggiornate al 2026, che tengono conto di stato civile, numero di figli a carico e appartenenza religiosa. La tabella A si applica ai celibi senza figli, la B ai celibi con figli, la C ai coniugati e la H ai nuclei monoparentali. Il risultato viene convertito in euro al tasso di cambio selezionato per quantificare il potere d\'acquisto reale in Italia.',
 'Dopo la simulazione è possibile confrontare il netto ottenuto con i costi effettivi della vita da frontaliere: trasporto quotidiano attraverso il confine, premio della cassa malati LAMal, pranzi in zona lavorativa, parcheggio presso i valichi e assicurazione auto con targhe svizzere. Questo confronto permette di stimare il risparmio mensile effettivo rispetto a un impiego equivalente in Italia.',
 'Una busta paga svizzera (Lohnabrechnung) riporta voci che i lavoratori italiani possono trovare poco familiari: AVS/AI/IPG al 5,3 % copre previdenza vecchiaia, invalidità e indennità per perdita di guadagno; AC all\'1,1 % è l\'assicurazione contro la disoccupazione; LAA copre gli infortuni non professionali; IJM fornisce le indennità giornaliere di malattia; e il LPP è il contributo pensionistico obbligatorio del secondo pilastro, che varia per fascia d\'età dal 7 % (25–34 anni) fino al 18 % (55–64 anni).',
 'Comprendere la differenza tra lordo e netto in Svizzera rispetto all\'Italia è fondamentale per una corretta pianificazione finanziaria. In Svizzera le deduzioni sociali totalizzano il 12–16 % del lordo a seconda dell\'età, mentre in Italia i contributi INPS raggiungono il 9,19 % per i dipendenti, con aliquote IRPEF più elevate. Il sistema svizzero accumula più capitale previdenziale tramite il LPP obbligatorio: uno stipendio netto inferiore costruisce in realtà più risparmio pensionistico di un ruolo equivalente in Italia.',
 ],
 en: [
 'The payslip simulator reconstructs your net salary step by step starting from the gross annual amount in Swiss francs: AVS/AI/IPG (5.3%), unemployment insurance (1.1%), non-occupational accident insurance, and daily sickness benefits are deducted before calculating the withholding tax.',
 'Withholding tax is computed using the Canton Ticino A/B/C/H tax tables, updated for 2026, accounting for marital status, number of children, and religious affiliation. The result is then converted to euros at the selected exchange rate to show real purchasing power in Italy.',
 'After the simulation you can compare the net result against actual cross-border living costs: transport, LAMal health insurance, lunches, parking, and car insurance with Swiss plates — giving you a realistic estimate of monthly savings.',
 'A Swiss payslip (Lohnabrechnung) typically lists several deductions that Italian workers may find unfamiliar: AVS/AI/APG at 5.3% covers old-age, disability, and maternity insurance; AC at 1.1% is unemployment insurance; NBU covers non-occupational accident insurance; KTG provides daily sickness benefits; and LPP is the mandatory occupational pension contribution that varies by age bracket (7% at age 25–34 rising to 18% at age 55–64).',
 'Understanding the difference between gross and net salary in Switzerland versus Italy is crucial for accurate financial planning. In Switzerland, social deductions total roughly 12–16% of gross pay depending on age, while in Italy INPS contributions reach 9.19% for employees plus higher IRPEF rates. The Swiss system front-loads pension savings via mandatory LPP, meaning a lower net salary actually builds more retirement capital than an equivalent Italian role — a factor often overlooked during salary negotiations.',
 ],
 de: [
 'Der Lohnabrechnungssimulator berechnet Ihr Nettogehalt Schritt für Schritt ab dem Bruttojahresbetrag in Schweizer Franken: AHV/IV/EO (5,3 %), Arbeitslosenversicherung (1,1 %), Nichtberufsunfallversicherung und Krankentaggeld werden vor der Quellensteuer abgezogen.',
 'Die Quellensteuer wird anhand der Tessiner Steuertabellen A/B/C/H berechnet, aktualisiert für 2026, unter Berücksichtigung von Familienstand, Kinderzahl und Konfession. Das Ergebnis wird zum gewählten Wechselkurs in Euro umgerechnet, um die reale Kaufkraft in Italien zu zeigen.',
 'Nach der Simulation können Sie das Nettoergebnis mit den tatsächlichen Grenzgänger-Lebenshaltungskosten vergleichen: Transport, LAMal-Versicherung, Mittagessen, Parkplatz und Autoversicherung mit Schweizer Kennzeichen.',
 'Eine Schweizer Lohnabrechnung listet typischerweise mehrere Abzüge auf, die italienischen Arbeitnehmern unbekannt sein können: AHV/IV/EO mit 5,3 % deckt Alters-, Invaliditäts- und Mutterschaftsversicherung; ALV mit 1,1 % ist die Arbeitslosenversicherung; NBU die Nichtberufsunfallversicherung; KTG das Krankentaggeld; und BVG der obligatorische Pensionskassenbeitrag, der je nach Alter variiert (7 % bei 25–34 Jahren bis 18 % bei 55–64 Jahren).',
 'Das Verständnis des Unterschieds zwischen Brutto- und Nettogehalt in der Schweiz versus Italien ist entscheidend für die Finanzplanung. In der Schweiz betragen die Sozialabzüge je nach Alter insgesamt 12–16 % des Bruttogehalts, während in Italien die INPS-Beiträge 9,19 % für Arbeitnehmer plus höhere IRPEF-Sätze erreichen. Das Schweizer System baut über die obligatorische BVG mehr Vorsorgekapital auf als eine gleichwertige italienische Stelle — ein bei Gehaltsverhandlungen oft übersehener Faktor.',
 ],
 fr: [
 'Le simulateur de fiche de paie reconstitue votre salaire net étape par étape à partir du brut annuel en francs suisses : AVS/AI/APG (5,3 %), assurance chômage (1,1 %), assurance accidents non professionnels et indemnités journalières de maladie sont déduits avant le calcul de l\'impôt à la source.',
 'L\'impôt à la source est calculé selon les barèmes A/B/C/H du Canton du Tessin, mis à jour pour 2026, en tenant compte de l\'état civil, du nombre d\'enfants et de l\'appartenance religieuse. Le résultat est converti en euros au taux de change sélectionné pour montrer le pouvoir d\'achat réel en Italie.',
 'Après la simulation, vous pouvez comparer le résultat net aux coûts réels de la vie transfrontalière : transport, assurance LAMal, repas, parking et assurance auto avec plaques suisses.',
 'Une fiche de paie suisse (Lohnabrechnung) liste typiquement plusieurs déductions peu familières aux travailleurs italiens : AVS/AI/APG à 5,3 % couvre l\'assurance vieillesse, invalidité et maternité ; AC à 1,1 % est l\'assurance chômage ; AANP couvre les accidents non professionnels ; IJM fournit les indemnités journalières maladie ; et la LPP est la cotisation de prévoyance obligatoire qui varie selon l\'âge (7 % de 25 à 34 ans jusqu\'à 18 % de 55 à 64 ans).',
 'Comprendre la différence entre salaire brut et net en Suisse versus en Italie est crucial pour une planification financière précise. En Suisse, les déductions sociales totalisent environ 12–16 % du brut selon l\'âge, tandis qu\'en Italie les cotisations INPS atteignent 9,19 % pour les salariés plus des taux IRPEF plus élevés. Le système suisse accumule davantage de capital retraite via la LPP obligatoire, ce qui signifie qu\'un salaire net inférieur construit en réalité plus de prévoyance — un facteur souvent négligé lors des négociations salariales.',
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
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source: <a href="https://www.estv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Federal Tax Administration (FTA)</a></p>',
 ],
 de: [
 'Das Gehaltsberechnungstool verwendet die Steuer- und Sozialversicherungsparameter 2026 für die Schweiz und Italien und wendet die Regeln des Neuen Steuerabkommens über die Besteuerung von Grenzgängern an, das 2024 in Kraft trat.',
 'Die Ergebnisse berücksichtigen Tessiner Besonderheiten: Quellensteuersätze, Klassifizierungstabellen A/B/C/H, Kinderabzüge und automatische CHF-EUR-Umrechnung zu Marktkursen.',
 'Für eine zuverlässige Schätzung geben Sie Ihr Bruttojahresgehalt in Schweizer Franken ein: Das System wendet automatisch AHV/IV/EO-, ALV-, UVG-, KTG- und BVG-Beiträge nach Altersgruppen des Bundesgesetzes an.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Quelle: <a href="https://www.estv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Eidgenössische Steuerverwaltung (ESTV)</a></p>',
 ],
 fr: [
 'L\'outil de calcul de salaire utilise les paramètres fiscaux et de sécurité sociale 2026 pour la Suisse et l\'Italie, en appliquant les règles du Nouvel Accord fiscal sur l\'imposition des frontaliers entré en vigueur en 2024.',
 'Les résultats tiennent compte des spécificités du Tessin : taux d\'impôt à la source, barèmes A/B/C/H, déductions par enfant et conversion automatique CHF-EUR aux taux du marché.',
 'Pour une estimation fiable, saisissez votre salaire brut annuel en francs suisses : le système applique automatiquement les cotisations AVS/AI/APG, AC, LAA, IJM et LPP selon les tranches d\'âge prévues par la loi fédérale.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source : <a href="https://www.estv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Administration fédérale des contributions (AFC)</a></p>',
 ],
 },

 // ───── Comparators ────────────────────────────────────────────
 '/compara-servizi/cambio-franco-euro': {
 en: [
 'The CHF-EUR currency converter uses real-time exchange rates from TwelveData, with Firestore caching for speed and reliability even during traffic peaks.',
 'Beyond instant conversion, interactive charts show the Swiss franc to euro exchange rate history over the last 12 months, useful for identifying the best time to convert your salary.',
 'For cross-border workers, the exchange rate is a decisive factor: a 1% variation on a salary of 6,000 CHF corresponds to roughly 55–60 EUR per month. Monitoring the rate helps plan conversions and reduce bank fees.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source: <a href="https://www.snb.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Swiss National Bank (SNB)</a></p>',
 ],
 de: [
 'Der CHF-EUR-Währungsrechner nutzt Echtzeit-Wechselkurse von TwelveData mit Firestore-Caching für Geschwindigkeit und Zuverlässigkeit auch bei hohem Zugriff.',
 'Neben der Sofortumrechnung zeigen interaktive Grafiken den Verlauf des Schweizer Franken zum Euro über die letzten 12 Monate — nützlich, um den besten Zeitpunkt für die Gehaltsumrechnung zu finden.',
 'Für Grenzgänger ist der Wechselkurs entscheidend: Eine Schwankung von 1 % bei einem Gehalt von 6.000 CHF entspricht etwa 55–60 EUR pro Monat. Die Kursüberwachung hilft, Umrechnungen zu planen und Bankgebühren zu senken.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Quelle: <a href="https://www.snb.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Schweizerische Nationalbank (SNB)</a></p>',
 ],
 fr: [
 'Le convertisseur CHF-EUR utilise les taux de change en temps réel de TwelveData, avec mise en cache Firestore pour la rapidité et la fiabilité même lors des pics de trafic.',
 'Au-delà de la conversion instantanée, des graphiques interactifs montrent l\'historique du taux de change franc suisse / euro sur les 12 derniers mois, utile pour identifier le meilleur moment pour convertir votre salaire.',
 'Pour les frontaliers, le taux de change est un facteur déterminant : une variation de 1 % sur un salaire de 6 000 CHF correspond à environ 55–60 EUR par mois. Surveiller le taux aide à planifier les conversions et réduire les frais bancaires.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source : <a href="https://www.snb.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Banque nationale suisse (BNS)</a></p>',
 ],
 },
 '/compara-servizi/confronta-casse-malati': {
 en: [
 'The LAMal health insurance comparator compares monthly premiums from 14 recognized Swiss insurers (FOPH), calculated by canton, insurance model, deductible, age group, and accident coverage.',
 'Cross-border workers with a G permit can choose between Swiss LAMal and the Italian national health service: the choice is irrevocable for the duration of employment. This tool helps compare costs before deciding.',
 'Premiums are calculated using the formula: base × (1 − model discount) × (1 + deductible factor) × age multiplier × (1 + accident coverage). Data covers cantons TI, GR, VS, ZH, GE, BE, and LU.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source: <a href="https://www.bag.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Federal Office of Public Health (FOPH)</a></p>',
 ],
 de: [
 'Der KVG-Krankenkassenvergleicher vergleicht monatliche Prämien von 14 anerkannten Schweizer Versicherern (BAG), berechnet nach Kanton, Versicherungsmodell, Franchise, Altersgruppe und Unfalldeckung.',
 'Grenzgänger mit Ausweis G können zwischen der Schweizer KVG und dem italienischen nationalen Gesundheitsdienst wählen: Die Wahl ist für die gesamte Beschäftigungsdauer unwiderruflich. Dieses Tool hilft, die Kosten vor der Entscheidung zu vergleichen.',
 'Die Prämien werden berechnet mit: Basis × (1 − Modellrabatt) × (1 + Franchisefaktor) × Altersmultiplikator × (1 + Unfalldeckung). Die Daten umfassen die Kantone TI, GR, VS, ZH, GE, BE und LU.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Quelle: <a href="https://www.bag.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Bundesamt für Gesundheit (BAG)</a></p>',
 ],
 fr: [
 'Le comparateur d\'assurance maladie LAMal compare les primes mensuelles de 14 assureurs suisses reconnus (OFSP), calculées par canton, modèle d\'assurance, franchise, tranche d\'âge et couverture accidents.',
 'Les frontaliers avec un permis G peuvent choisir entre la LAMal suisse et le service national de santé italien : le choix est irrévocable pour toute la durée de l\'emploi. Cet outil aide à comparer les coûts avant de décider.',
 'Les primes sont calculées selon la formule : base × (1 − rabais modèle) × (1 + facteur franchise) × multiplicateur âge × (1 + couverture accidents). Les données couvrent les cantons TI, GR, VS, ZH, GE, BE et LU.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source : <a href="https://www.bag.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Office fédéral de la santé publique (OFSP)</a></p>',
 ],
 },
 '/compara-servizi/confronta-banche': {
 en: [
 'The bank comparison analyses the main Swiss and Italian banks used by cross-border workers, comparing exchange commissions, account fees, debit/credit cards, and cross-border transfer services.',
 'For cross-border workers, the choice of bank directly affects net pay: CHF→EUR exchange commissions can range from 0.3% to 2.5% depending on the institution and the transfer method used.',
 'The tool also compares multi-currency accounts, SEPA transfer fees, and mobile banking features — key factors when managing income in CHF and expenses in EUR on a daily basis.',
 'Online banks and fintech platforms such as Revolut, Wise, and Neon offer cross-border workers competitive exchange rates — often 0.3–0.5% — compared to traditional Swiss banks that may charge 1–2%. However, traditional banks provide in-branch services useful for mortgage applications, salary certificates, and LPP pension account management that digital-only banks cannot match.',
 'A common pitfall for frontalieri is accepting the default exchange rate on salary payment day. Many employers convert CHF salaries to EUR automatically using their house bank\'s rate, which can be 1–1.5% worse than the interbank rate. Setting up a CHF-denominated account and converting manually on favourable days can save EUR 500–1,200 annually on a typical cross-border salary.',
 ],
 de: [
 'Der Bankenvergleich analysiert die wichtigsten Schweizer und italienischen Banken für Grenzgänger und vergleicht Wechselkurskommissionen, Kontogebühren, Debit-/Kreditkarten und grenzüberschreitende Überweisungsdienste.',
 'Für Grenzgänger wirkt sich die Bankwahl direkt auf das Nettogehalt aus: CHF→EUR-Wechselkurskommissionen können je nach Institut und Überweisungsmethode zwischen 0,3 % und 2,5 % variieren.',
 'Das Tool vergleicht auch Multiwährungskonten, SEPA-Überweisungsgebühren und Mobile-Banking-Funktionen — entscheidende Faktoren bei der täglichen Verwaltung von CHF-Einkommen und EUR-Ausgaben.',
 'Online-Banken und Fintech-Plattformen wie Revolut, Wise und Neon bieten Grenzgängern günstige Wechselkurse — oft 0,3–0,5 % — im Vergleich zu traditionellen Schweizer Banken mit 1–2 %. Traditionelle Banken bieten jedoch Schalterdienstleistungen für Hypothekenanträge, Lohnausweise und BVG-Kontoverwaltung, die reine Digitalbanken nicht leisten können.',
 'Eine häufige Falle für Grenzgänger ist die Akzeptanz des Standard-Wechselkurses am Gehaltszahlungstag. Viele Arbeitgeber konvertieren CHF-Gehälter automatisch zum Hausbankenkurs, der 1–1,5 % schlechter als der Interbankenkurs sein kann. Ein CHF-Konto einzurichten und manuell an günstigen Tagen umzutauschen, kann jährlich EUR 500–1.200 einsparen.',
 ],
 fr: [
 'La comparaison bancaire analyse les principales banques suisses et italiennes utilisées par les frontaliers, en comparant les commissions de change, les frais de compte, les cartes de débit/crédit et les services de virement transfrontalier.',
 'Pour les frontaliers, le choix de la banque affecte directement le salaire net : les commissions de change CHF→EUR peuvent varier de 0,3 % à 2,5 % selon l\'établissement et la méthode de transfert utilisée.',
 'L\'outil compare également les comptes multidevises, les frais de virement SEPA et les fonctionnalités de banque mobile — des critères essentiels pour gérer au quotidien des revenus en CHF et des dépenses en EUR.',
 'Les banques en ligne et les plateformes fintech comme Revolut, Wise et Neon offrent aux frontaliers des taux de change compétitifs — souvent 0,3–0,5 % — contre 1–2 % dans les banques suisses traditionnelles. Toutefois, les banques traditionnelles fournissent des services en agence indispensables pour les demandes de prêt hypothécaire, les attestations de salaire et la gestion des comptes LPP.',
 'Un piège fréquent pour les frontaliers est d\'accepter le taux de change par défaut le jour du versement du salaire. Beaucoup d\'employeurs convertissent automatiquement les salaires CHF en EUR au taux de leur banque maison, souvent 1–1,5 % moins favorable que le taux interbancaire. Ouvrir un compte en CHF et convertir manuellement les jours favorables peut économiser EUR 500–1 200 par an.',
 ],
 },
 '/compara-servizi/confronta-offerte-lavoro': {
 en: [
 'The Swiss jobs section gathers job postings published on official company sources across Cantons Ticino, Graubünden and Valais, with data normalization to facilitate comparison between role, location, contract type, and match with your professional profile.',
 'For each position, useful metadata is maintained: publication date, company, location, requirements, and direct link to apply on the employer\'s original website.',
 'Listings are filtered for target cantons (TI, GR, VS) and updated daily by dedicated crawlers that monitor the HR portals of over 100 companies, public entities, and multinationals based in the region.',
 ],
 de: [
 'Die Stellensuche in der Schweiz sammelt Stellenangebote von offiziellen Unternehmensquellen in den Kantonen Tessin, Graubünden und Wallis mit Datennormalisierung zum einfachen Vergleich von Rolle, Standort, Vertragsart und Übereinstimmung mit Ihrem Berufsprofil.',
 'Für jede Stelle werden nützliche Metadaten gepflegt: Veröffentlichungsdatum, Unternehmen, Standort, Anforderungen und Direktlink zur Bewerbung auf der Originalwebsite des Arbeitgebers.',
 'Die Angebote werden für die Zielkantone (TI, GR, VS) gefiltert und täglich von dedizierten Crawlern aktualisiert, die die HR-Portale von über 100 Unternehmen, öffentlichen Einrichtungen und Konzernen in der Region überwachen.',
 ],
 fr: [
 'La section emploi en Suisse recueille les offres d\'emploi publiées sur les sources officielles des entreprises dans les cantons du Tessin, des Grisons et du Valais, avec normalisation des données pour faciliter la comparaison entre poste, lieu, type de contrat et adéquation avec votre profil professionnel.',
 'Pour chaque poste, des métadonnées utiles sont conservées : date de publication, entreprise, localité, exigences et lien direct pour postuler sur le site original de l\'employeur.',
 'Les offres sont filtrées pour les cantons cibles (TI, GR, VS) et mises à jour quotidiennement par des crawlers dédiés qui surveillent les portails RH de plus de 100 entreprises dans la région.',
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
 it: [
 'Il confronto del costo vita svizzera vs italia e lo strumento piu importante per chi deve scegliere tra permesso G (residenza in Italia, pendolare) e permesso B (residenza in Svizzera). Vivere in Italia puo ridurre le spese fisse del 30-50% rispetto al Ticino, ma bisogna considerare i costi di trasporto e il <a href="https://frontaliereticino.ch/guida-frontaliere/tempi-attesa-dogana/">tempo perso alla dogana</a>.',
 'Il confronto copre affitti, spesa alimentare, trasporti, sanita e istruzione tra citta di frontiera come Lugano, Mendrisio, Como e Varese. Usa il nostro <a href="https://frontaliereticino.ch/calcola-stipendio/">calcolatore stipendio netto</a> per calcolare il tuo budget mensile effettivo come frontaliere.',
 'I <a href="https://frontaliereticino.ch/tasse-e-pensione/festivita-ticino/">giorni festivi in Ticino</a> influenzano anche il costo della vita: durante i ponti e le festivita i prezzi di trasporto e ristorazione possono aumentare significativamente nelle zone di frontiera.',
 ],
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
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source: <a href="https://www.bfs.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Federal Statistical Office (FSO)</a></p>',
 ],
 de: [
 'Dieser Bereich vergleicht Dienstleistungen, Kosten und Bedingungen, die für Personen relevant sind, die in der Schweiz arbeiten und in Italien leben, mit aktuellen Daten und interaktiven Tools.',
 'Jeder Vergleicher verwendet reale Daten und überprüfbare Quellen für zuverlässige Ergebnisse. Die Parameter können an Ihre spezifische Grenzgänger-Situation angepasst werden.',
 'Der Bereich umfasst acht spezialisierte Vergleichstools — von Währungsumrechnung und Krankenversicherung bis hin zu Lebenshaltungskosten und Kinderbetreuung — alle mit monatlich aktualisierten Daten. Nutzen Sie die einzelnen Tools oder die Übersicht, um die für Ihre Grenzgänger-Situation relevantesten Vergleiche zu finden.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Quelle: <a href="https://www.bfs.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Bundesamt für Statistik (BFS)</a></p>',
 ],
 fr: [
 'Cette section compare les services, coûts et conditions pertinents pour ceux qui travaillent en Suisse et vivent en Italie, avec des données actualisées et des outils interactifs pour des décisions éclairées.',
 'Chaque comparateur utilise des données réelles et des sources vérifiables pour garantir des résultats fiables. Les paramètres sont personnalisables selon votre situation spécifique de frontalier.',
 'La section comprend huit outils de comparaison dédiés — du change de devises à l\'assurance maladie, en passant par le coût de la vie et les crèches — tous alimentés par des données mises à jour mensuellement. Parcourez chaque outil ou utilisez la vue d\'ensemble pour identifier les comparaisons les plus pertinentes pour votre situation frontalière.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source : <a href="https://www.bfs.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Office fédéral de la statistique (OFS)</a></p>',
 ],
 },

 // ───── Taxes & Pension ────────────────────────────────────────
 '/tasse-e-pensione/calcola-previdenza': {
 en: [
 'The pension simulator estimates retirement benefits by combining the first pillar AVS (maximum 2024 pension: CHF 2,450/month), second pillar LPP (contribution credits from 7% to 18% based on age), and the optional third pillar 3a.',
 'For cross-border workers, the Swiss pension is paid even after permanently returning to Italy. AVS contributions accrued in Switzerland are combined with Italian INPS contributions thanks to the bilateral social security convention.',
 'The simulator also shows the impact of different strategies: voluntary third pillar 3a contributions, LPP buy-ins, and the effect of the conversion rate on the final pension, with projections at 5, 10, and 20 years.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source: <a href="https://www.bsv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Federal Social Insurance Office (FSIO)</a></p>',
 ],
 de: [
 'Der Vorsorgesimulator schätzt die Rentenleistungen durch Kombination der ersten Säule AHV (maximale Rente 2024: CHF 2.450/Monat), der zweiten Säule BVG (Gutschriften von 7 % bis 18 % je nach Alter) und der freiwilligen dritten Säule 3a.',
 'Für Grenzgänger wird die Schweizer Rente auch nach der endgültigen Rückkehr nach Italien gezahlt. In der Schweiz angesammelte AHV-Beiträge werden dank des bilateralen Sozialversicherungsabkommens mit italienischen INPS-Beiträgen kombiniert.',
 'Der Simulator zeigt auch die Auswirkung verschiedener Strategien: freiwillige Säule-3a-Einzahlungen, BVG-Einkäufe und den Effekt des Umwandlungssatzes auf die Endrente, mit Prognosen auf 5, 10 und 20 Jahre.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Quelle: <a href="https://www.bsv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Bundesamt für Sozialversicherungen (BSV)</a></p>',
 ],
 fr: [
 'Le simulateur de prévoyance estime les prestations de retraite en combinant le premier pilier AVS (rente maximale 2024 : CHF 2 450/mois), le deuxième pilier LPP (bonifications de 7 % à 18 % selon l\'âge) et le troisième pilier 3a facultatif.',
 'Pour les frontaliers, la pension suisse est versée même après le retour définitif en Italie. Les cotisations AVS accumulées en Suisse s\'ajoutent aux cotisations INPS italiennes grâce à la convention bilatérale de sécurité sociale.',
 'Le simulateur montre également l\'impact de différentes stratégies : versements volontaires au pilier 3a, rachats LPP et effet du taux de conversion sur la rente finale, avec des projections à 5, 10 et 20 ans.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source : <a href="https://www.bsv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Office fédéral des assurances sociales (OFAS)</a></p>',
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
 'Pillar 3a contributions offer substantial tax deduction benefits for cross-border workers: the maximum CHF 7,258 deductible in 2026 directly reduces the taxable base for cantonal withholding tax. For a Ticino-based frontaliere earning CHF 80,000, this deduction can save approximately CHF 1,200–1,800 in annual withholding tax depending on marital status and number of children — an immediate return on the contribution.',
 'Cross-border workers must choose between bank-based 3a accounts and insurance-based 3a policies. Bank 3a offers flexibility — contributions can vary each year, and you can hold up to five accounts to stagger withdrawals. Insurance 3a provides guaranteed returns and risk coverage but locks you into fixed annual premiums. For frontalieri who may relocate or change employment status, the bank option is generally recommended due to its greater liquidity and lower penalties for early modification.',
 ],
 de: [
 'Der Säule-3a-Simulator berechnet das angesammelte Kapital und die zukünftige Rente basierend auf jährlichen Einzahlungen, Laufzeit, erwarteter Rendite und Kapitalbezugssteuer — und zeigt den steuerlichen Vorteil gegenüber nicht begünstigten Anlagen.',
 'Im Jahr 2026 beträgt der maximale Abzug für die Säule 3a CHF 7.258 für Arbeitnehmer mit BVG-Anschluss. Die Einzahlung reduziert direkt das quellensteuerbare Einkommen.',
 'Der Simulator vergleicht auch Szenarien mit unterschiedlichen Zeithorizonten und Renditen, sodass Sie den Effekt von Zinseszins und Steuervorteil über die Langfristigkeit hinweg visualisieren können.',
 'Säule-3a-Beiträge bieten Grenzgängern erhebliche Steuerabzugsvorteile: Die maximal abzugsfähigen CHF 7.258 im Jahr 2026 reduzieren direkt die Bemessungsgrundlage für die kantonale Quellensteuer. Für einen im Tessin tätigen Grenzgänger mit einem Einkommen von CHF 80.000 kann dieser Abzug je nach Familienstand und Kinderzahl jährlich CHF 1.200–1.800 an Quellensteuer einsparen — eine sofortige Rendite auf den Beitrag.',
 'Grenzgänger müssen zwischen bankbasierten 3a-Konten und versicherungsbasierten 3a-Policen wählen. Bank-3a bietet Flexibilität — Beiträge können jährlich variieren, und bis zu fünf Konten ermöglichen gestaffelte Bezüge. Versicherungs-3a bietet garantierte Renditen und Risikodeckung, bindet aber an feste Jahresprämien. Für Grenzgänger, die möglicherweise umziehen oder den Beschäftigungsstatus wechseln, wird die Bankoption aufgrund höherer Liquidität und geringerer Strafgebühren bei vorzeitiger Änderung empfohlen.',
 ],
 fr: [
 'Le simulateur du troisième pilier 3a calcule le capital accumulé et la rente future en fonction des versements annuels, de la durée, du rendement attendu et de l\'impôt de retrait, montrant l\'avantage fiscal par rapport aux investissements non privilégiés.',
 'En 2026, le maximum déductible pour le pilier 3a est de CHF 7 258 pour les travailleurs affiliés à une caisse de pension LPP. Le versement réduit directement le revenu imposable à la source.',
 'Le simulateur compare également des scénarios avec différents horizons temporels et rendements, vous permettant de visualiser l\'effet des intérêts composés et de l\'avantage fiscal sur le long terme.',
 'Les versements au pilier 3a offrent des avantages fiscaux considérables aux frontaliers : les CHF 7 258 déductibles en 2026 réduisent directement la base imposable pour l\'impôt à la source cantonal. Pour un frontalier au Tessin gagnant CHF 80 000, cette déduction peut économiser environ CHF 1 200–1 800 d\'impôt à la source annuel selon l\'état civil et le nombre d\'enfants — un rendement immédiat sur le versement.',
 'Les frontaliers doivent choisir entre les comptes 3a bancaires et les polices 3a d\'assurance. Le 3a bancaire offre de la flexibilité — les versements peuvent varier chaque année, et on peut détenir jusqu\'à cinq comptes pour échelonner les retraits. Le 3a assurance garantit des rendements et une couverture risque mais impose des primes annuelles fixes. Pour les frontaliers susceptibles de déménager ou de changer de statut professionnel, l\'option bancaire est généralement recommandée pour sa liquidité supérieure et ses pénalités moindres en cas de modification anticipée.',
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
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source: <a href="https://www.estv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Federal Tax Administration (FTA)</a> · <a href="https://www.bsv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">FSIO</a></p>',
 ],
 de: [
 'Dieser Bereich deckt die steuerlichen und vorsorgerechtlichen Aspekte der Grenzgängerarbeit ab: Schweizer Quellensteuer, italienische IRPEF, AHV/BVG-Beiträge und Altersvorsorgeplanung.',
 'Die Informationen sind auf das Neue Steuerabkommen 2024 zwischen Italien und der Schweiz aktualisiert und berücksichtigen Tessiner Besonderheiten bei der Quellensteuer und Übergangsregelungen für Alt-Grenzgänger (vor 2024).',
 'Wichtige Tools sind der Vorsorgerechner für AHV/BVG-Prognosen, der Steuerkalender mit Fristen für beide Länder, der Säule-3a-Simulator für steuerbegünstigtes Sparen und der Steuergutschrift-Rechner zur Optimierung der italienischen Steuererklärung. Jedes Tool ist auf die geltenden Grenzgängerregelungen für 2026 zugeschnitten.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Quelle: <a href="https://www.estv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Eidgenössische Steuerverwaltung (ESTV)</a> · <a href="https://www.bsv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">BSV</a></p>',
 ],
 fr: [
 'Cette section couvre les aspects fiscaux et de prévoyance du travail frontalier : impôt à la source suisse, IRPEF italien, cotisations AVS/LPP et planification de la retraite.',
 'Les informations sont mises à jour au Nouvel Accord fiscal 2024 entre l\'Italie et la Suisse et tiennent compte des spécificités du Tessin pour l\'impôt à la source et les régimes transitoires pour les frontaliers historiques (avant 2024).',
 'Les outils clés comprennent le planificateur de prévoyance pour les projections AVS/LPP, le calendrier fiscal avec les échéances des deux pays, le simulateur du troisième pilier 3a pour l\'épargne fiscalement avantageuse et le calculateur de crédit d\'impôt pour optimiser votre déclaration italienne. Chaque outil est adapté à la réglementation frontalière en vigueur pour 2026.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source : <a href="https://www.estv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Administration fédérale des contributions (AFC)</a> · <a href="https://www.bsv.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">OFAS</a></p>',
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
 it: [
 'I valichi di frontiera tra Ticino e Italia sono il collo di bottiglia quotidiano per oltre 70.000 frontalieri. La <a href="https://frontaliereticino.ch/guida-frontaliere/tempi-attesa-dogana/chiasso-centro/">dogana di Chiasso Centro</a> e il <a href="https://frontaliereticino.ch/guida-frontaliere/tempi-attesa-dogana/chiasso-brogeda/">valico di Brogeda</a> gestiscono il volume maggiore di traffico, con code che nelle ore di punta (7:00-8:30 e 17:00-18:30) possono superare i 30 minuti.',
 'Per ridurre i tempi di attesa, i frontalieri esperti utilizzano valichi secondari come <a href="https://frontaliereticino.ch/guida-frontaliere/tempi-attesa-dogana/stabio/">Stabio</a>, <a href="https://frontaliereticino.ch/guida-frontaliere/tempi-attesa-dogana/gaggiolo/">Gaggiolo</a> o <a href="https://frontaliereticino.ch/guida-frontaliere/tempi-attesa-dogana/ponte-tresa/">Ponte Tresa</a>, che offrono tempi nettamente inferiori ma con orari di apertura limitati (generalmente 6:00-22:00).',
 'Le variazioni stagionali sono rilevanti: i venerdi estivi, la stagione sciistica e le <a href="https://frontaliereticino.ch/tasse-e-pensione/festivita-ticino/">festivita ticinesi</a> possono aumentare le code del 30-50%. Consulta la nostra mappa interattiva per verificare il traffico in tempo reale e scegliere il percorso migliore.',
 ],
 en: [
 'The border crossing map shows all crossings between Ticino and Italy with opening hours, typical traffic levels, and average waiting times by time slot.',
 'Each crossing has different characteristics: some are reserved for local residents, others handle heavy commercial traffic. Knowing the best crossing for your route can save up to 30 minutes a day.',
 'The most used crossings by commuters are Chiasso–Ponte Chiasso, Stabio–Gaggiolo, and Brogeda. Secondary crossings like Pizzamiglio and Passo San Jorio offer shorter queues but longer driving distances — the optimal choice depends on your destination in Ticino.',
 'Experienced frontalieri recommend departing before 6:45 AM or after 8:30 AM to avoid the worst morning congestion at major crossings. Similarly, the evening return window between 17:00 and 18:30 sees peak queues — leaving work 15 minutes earlier or later can cut wait times by half. Flexible working arrangements negotiated with your employer are the most effective long-term strategy.',
 'Alternative crossings offer significant time savings for workers heading to specific parts of Ticino. Gandria and Oria serve eastern Lake Lugano, while Ponte Tresa is ideal for the Malcantone region. The Dirinella crossing near Lavena suits workers in western Ticino. Each secondary crossing has limited opening hours — typically 6:00–22:00 — so verifying schedules before planning your commute is essential.',
 ],
 de: [
 'Die Grenzübergangskarte zeigt alle Übergänge zwischen dem Tessin und Italien mit Öffnungszeiten, typischem Verkehrsaufkommen und durchschnittlichen Wartezeiten nach Zeitfenstern.',
 'Jeder Übergang hat unterschiedliche Eigenschaften: Einige sind Anwohnern vorbehalten, andere wickeln schweren Güterverkehr ab. Den besten Übergang für die eigene Route zu kennen, kann täglich bis zu 30 Minuten sparen.',
 'Die von Pendlern am häufigsten genutzten Übergänge sind Chiasso–Ponte Chiasso, Stabio–Gaggiolo und Brogeda. Sekundäre Übergänge wie Pizzamiglio und Passo San Jorio bieten kürzere Wartezeiten, aber längere Fahrstrecken.',
 'Erfahrene Grenzgänger empfehlen, vor 6:45 Uhr oder nach 8:30 Uhr abzufahren, um die schlimmsten Morgenstaus an den Hauptübergängen zu vermeiden. Ebenso treten abends zwischen 17:00 und 18:30 Uhr Spitzenwarteschlangen auf — 15 Minuten früher oder später abzufahren kann die Wartezeit halbieren. Flexible Arbeitszeiten mit dem Arbeitgeber zu vereinbaren, ist die wirksamste Langzeitstrategie.',
 'Alternative Übergänge bieten erhebliche Zeitersparnisse für Arbeitnehmer in bestimmten Tessiner Regionen. Gandria und Oria bedienen den östlichen Luganersee, Ponte Tresa ist ideal für das Malcantone. Der Dirinella-Übergang bei Lavena eignet sich für das Westtessin. Jeder Nebenübergang hat begrenzte Öffnungszeiten — typisch 6:00–22:00 — daher ist die Überprüfung des Fahrplans vor der Routenplanung unerlässlich.',
 ],
 fr: [
 'La carte des postes frontières montre tous les passages entre le Tessin et l\'Italie avec les horaires d\'ouverture, les niveaux de trafic typiques et les temps d\'attente moyens par créneau horaire.',
 'Chaque passage a des caractéristiques différentes : certains sont réservés aux résidents locaux, d\'autres gèrent du trafic commercial lourd. Connaître le meilleur passage pour votre trajet peut faire gagner jusqu\'à 30 minutes par jour.',
 'Les passages les plus utilisés par les pendulaires sont Chiasso–Ponte Chiasso, Stabio–Gaggiolo et Brogeda. Les passages secondaires comme Pizzamiglio et Passo San Jorio offrent des files plus courtes mais des distances de conduite plus longues.',
 'Les frontaliers expérimentés recommandent de partir avant 6h45 ou après 8h30 pour éviter la pire congestion matinale aux passages principaux. De même, le créneau de retour entre 17h00 et 18h30 connaît les pires files — partir 15 minutes plus tôt ou plus tard peut réduire l\'attente de moitié. Les horaires flexibles négociés avec l\'employeur restent la stratégie la plus efficace à long terme.',
 'Les passages alternatifs offrent des gains de temps significatifs selon la destination au Tessin. Gandria et Oria desservent l\'est du lac de Lugano, Ponte Tresa est idéal pour la région du Malcantone. Le passage de Dirinella près de Lavena convient au Tessin occidental. Chaque passage secondaire a des horaires limités — typiquement 6h00–22h00 — il est donc essentiel de vérifier les horaires avant de planifier son trajet.',
 ],
 },
 // ───── Chiasso Centro / Brogeda (striking distance target) ──
 '/guida-frontaliere/tempi-attesa-dogana/chiasso-centro': {
 it: [
 'Il traffico alla dogana di <strong>Chiasso Centro</strong> e al valico di <strong>Brogeda</strong> rappresenta il principale punto di attesa per i frontalieri che lavorano in Ticino: insieme gestiscono oltre il 40% del flusso quotidiano verso la Svizzera, con picchi di 25-40 minuti di coda nelle ore di punta del mattino (7:00-9:00) e della sera (17:00-19:00).',
 'La <strong>differenza tra Chiasso Centro e Brogeda</strong> è sostanziale: Chiasso Centro è il valico urbano tradizionale, usato prevalentemente dal traffico locale e dai pedoni, mentre Brogeda è il grande valico autostradale che gestisce il traffico pesante e i flussi di lunga percorrenza dall\'autostrada A9. In orario di punta, Brogeda tende a essere più scorrevole rispetto a Chiasso Centro proprio per la maggiore capacità delle corsie autostradali, ma è più esposto a rallentamenti nei giorni di controlli doganali commerciali intensificati.',
 '<strong>Come evitare la coda alla dogana di Chiasso</strong>: i frontalieri esperti utilizzano tre strategie. Primo, anticipare la partenza di 20-30 minuti rispetto al picco (arrivo prima delle 6:45 o dopo le 8:30). Secondo, valutare i valichi alternativi come <a href="https://frontaliereticino.ch/guida-frontaliere/tempi-attesa-dogana/ponte-chiasso/">Ponte Chiasso</a> (pedonale e veicoli leggeri), <a href="https://frontaliereticino.ch/guida-frontaliere/tempi-attesa-dogana/novazzano/">Novazzano</a>, <a href="https://frontaliereticino.ch/guida-frontaliere/tempi-attesa-dogana/gaggiolo/">Gaggiolo</a> o <a href="https://frontaliereticino.ch/guida-frontaliere/tempi-attesa-dogana/stabio/">Stabio</a>, che nelle stesse fasce orarie spesso presentano attese inferiori ai 10 minuti. Terzo, monitorare il traffico in tempo reale tramite le webcam ufficiali dell\'Amministrazione federale delle dogane (AFD) e app come <em>Google Maps</em> o <em>Waze</em> prima di uscire di casa.',
 'Gli <strong>orari di apertura</strong> di Chiasso Centro e Brogeda sono 24 ore su 24 per i valichi principali, ma alcune corsie dedicate (es. pendolari, frontalieri con tessera) possono avere orari ridotti. I controlli possono essere intensificati a campione o in occasione di eventi speciali (vertici internazionali, operazioni antifrode) — in questi casi le code possono facilmente raddoppiare. I venerdì estivi, l\'inizio e la fine della stagione sciistica e i ponti festivi italiani sono i giorni peggiori dell\'anno per chi attraversa a Chiasso.',
 ],
 en: [
 'Traffic at the <strong>Chiasso Centro</strong> customs and <strong>Brogeda</strong> crossing is the main bottleneck for cross-border workers commuting into Ticino: together they handle over 40% of the daily inflow to Switzerland, with peaks of 25–40 minutes during morning (7:00–9:00) and evening (17:00–19:00) rush hours.',
 'The difference between Chiasso Centro and Brogeda is substantial: Chiasso Centro is the traditional urban crossing used mostly by local traffic and pedestrians, while Brogeda is the large motorway crossing on the A9, handling heavy freight and long-distance traffic. During rush hour Brogeda is often smoother thanks to its wider motorway lanes, but is more exposed to slowdowns on days with intensified commercial customs checks.',
 'To avoid queues at Chiasso, experienced frontalieri use three strategies: depart 20–30 minutes before the peak (arrive before 6:45 or after 8:30), use alternative crossings such as Ponte Chiasso, Novazzano, Gaggiolo or Stabio (which typically show under 10 minutes of wait in the same windows), and monitor real-time traffic via official customs webcams and navigation apps before leaving.',
 'Opening hours at Chiasso Centro and Brogeda are 24/7 for the main lanes, but dedicated lanes (commuters, cross-border badge holders) may have shorter hours. Random or event-triggered checks (international summits, anti-fraud operations) can easily double queue times. Summer Fridays, the start and end of ski season, and Italian long-weekend holidays are the worst days of the year for Chiasso.',
 ],
 de: [
 'Der Verkehr am Zoll <strong>Chiasso Centro</strong> und am Grenzübergang <strong>Brogeda</strong> ist der wichtigste Wartepunkt für Grenzgänger, die im Tessin arbeiten: Zusammen bewältigen sie über 40 % des täglichen Einreisestroms in die Schweiz, mit Spitzenwerten von 25–40 Minuten zu den Hauptzeiten (morgens 7:00–9:00 und abends 17:00–19:00).',
 'Der Unterschied zwischen Chiasso Centro und Brogeda ist erheblich: Chiasso Centro ist der traditionelle städtische Übergang, überwiegend für lokalen Verkehr und Fussgänger, während Brogeda der grosse Autobahnübergang an der A9 ist und Schwerverkehr sowie Fernverkehr abwickelt. In der Hauptverkehrszeit ist Brogeda dank der breiteren Autobahnspuren oft flüssiger, aber anfälliger für Verzögerungen bei verstärkten kommerziellen Zollkontrollen.',
 'Um Staus in Chiasso zu vermeiden, nutzen erfahrene Grenzgänger drei Strategien: 20–30 Minuten vor dem Spitzenzeitpunkt abfahren (vor 6:45 oder nach 8:30 ankommen), alternative Übergänge wie Ponte Chiasso, Novazzano, Gaggiolo oder Stabio wählen (meist unter 10 Minuten Wartezeit), und den Echtzeit-Verkehr über offizielle Zoll-Webcams und Navigations-Apps vor der Abfahrt überwachen.',
 'Die Öffnungszeiten von Chiasso Centro und Brogeda sind 24/7 für die Hauptspuren, aber Sonderspuren (Pendler, Grenzgänger-Ausweis) können kürzere Zeiten haben. Stichprobenkontrollen oder veranstaltungsbedingte Kontrollen (internationale Gipfel, Anti-Betrugs-Operationen) können die Wartezeit leicht verdoppeln. Sommerfreitage, Saisonbeginn und -ende des Skisports sowie italienische Brückentage sind die schlimmsten Tage des Jahres für Chiasso.',
 ],
 fr: [
 'Le trafic au poste-frontière de <strong>Chiasso Centro</strong> et à <strong>Brogeda</strong> est le principal point d\'attente des frontaliers qui travaillent au Tessin : ensemble ils gèrent plus de 40 % du flux quotidien vers la Suisse, avec des pics de 25–40 minutes aux heures de pointe (7h00–9h00 le matin et 17h00–19h00 le soir).',
 'La différence entre Chiasso Centro et Brogeda est notable : Chiasso Centro est le passage urbain traditionnel, principalement utilisé par le trafic local et les piétons, tandis que Brogeda est le grand passage autoroutier sur l\'A9, qui gère le trafic poids lourd et la longue distance. En heure de pointe, Brogeda est souvent plus fluide grâce aux voies plus larges, mais plus exposé aux ralentissements les jours de contrôles douaniers commerciaux renforcés.',
 'Pour éviter la file à Chiasso, les frontaliers expérimentés utilisent trois stratégies : partir 20–30 minutes avant le pic (arriver avant 6h45 ou après 8h30), emprunter les passages alternatifs comme Ponte Chiasso, Novazzano, Gaggiolo ou Stabio (généralement moins de 10 minutes d\'attente), et surveiller le trafic en temps réel via les webcams officielles de la douane et les applications de navigation avant de partir.',
 'Les horaires d\'ouverture de Chiasso Centro et Brogeda sont 24h/24 pour les voies principales, mais les voies dédiées (pendulaires, titulaires de carte frontalière) peuvent avoir des horaires réduits. Les contrôles aléatoires ou liés à des événements (sommets internationaux, opérations anti-fraude) peuvent facilement doubler les temps d\'attente. Les vendredis d\'été, le début et la fin de la saison de ski et les ponts italiens sont les pires jours de l\'année à Chiasso.',
 ],
 },

 '/guida-frontaliere/trasferimento-auto': {
 en: [
 'The car transfer guide covers procedures for registering an Italian vehicle in Switzerland and vice versa: customs clearance, MFK technical inspection, insurance, and timelines for re-registration.',
 'For cross-border workers using an Italian-plated vehicle, it explains the rules for driving in Switzerland: time limits, Swiss-valid insurance, fines, and special cases with company vehicles.',
 'Key topics include the temporary import rules (Form 15.30), the 60-day re-export deadline, and the documentation needed for customs clearance at the Stabio or Chiasso offices.',
 'Transferring a vehicle between countries involves significant costs: Swiss customs duties (4% of the vehicle\'s value), VAT (8.1%), the MFK technical inspection fee (CHF 100–250), new Swiss registration (CHF 50–120), and mandatory Swiss-valid insurance. Italian de-registration fees and PRA charges also apply. In total, transferring an average car from Italy to Switzerland costs CHF 2,500–5,000 depending on the vehicle\'s declared value.',
 'The documentation process typically takes 4–8 weeks from start to finish. Required documents include the original Italian registration certificate (carta di circolazione), proof of ownership, a valid EU roadworthiness certificate (revisione), customs Form 18.44 for definitive import, and proof of Swiss residence or employment. Starting the process early and booking the MFK inspection in advance is critical, as waiting times at Ticino inspection centres can exceed three weeks.',
 ],
 de: [
 'Der Leitfaden zum Autotransfer deckt die Verfahren zur Ummatrikulierung eines italienischen Fahrzeugs in der Schweiz und umgekehrt ab: Verzollung, MFK-Prüfung, Versicherung und Fristen für die Ummeldung.',
 'Für Grenzgänger mit italienischem Kennzeichen werden die Fahrregeln in der Schweiz erläutert: Zeitlimits, in der Schweiz gültige Versicherung, Bussen und Sonderfälle mit Geschäftsfahrzeugen.',
 'Wichtige Themen sind die Regeln zur vorübergehenden Einfuhr (Formular 15.30), die 60-Tage-Wiederausfuhrfrist und die für die Verzollung am Zollamt Stabio oder Chiasso erforderlichen Dokumente.',
 'Der Fahrzeugtransfer zwischen den Ländern verursacht erhebliche Kosten: Schweizer Zollgebühren (4 % des Fahrzeugwerts), MwSt. (8,1 %), MFK-Prüfungsgebühr (CHF 100–250), Schweizer Neuanmeldung (CHF 50–120) und eine obligatorische, in der Schweiz gültige Versicherung. Zusätzlich fallen italienische Abmeldegebühren und PRA-Kosten an. Insgesamt kostet der Transfer eines durchschnittlichen Autos CHF 2.500–5.000.',
 'Das Dokumentationsverfahren dauert üblicherweise 4–8 Wochen. Erforderliche Unterlagen sind die italienische Zulassungsbescheinigung (Carta di Circolazione), Eigentumsnachweis, ein gültiges EU-Prüfzeugnis (Revisione), Zollformular 18.44 für die definitive Einfuhr sowie Nachweis des Schweizer Wohnsitzes oder der Beschäftigung. Eine frühzeitige Planung und rechtzeitige Buchung der MFK-Prüfung ist entscheidend, da die Wartezeiten an Tessiner Prüfstellen drei Wochen übersteigen können.',
 ],
 fr: [
 'Le guide de transfert auto couvre les procédures d\'immatriculation d\'un véhicule italien en Suisse et vice versa : dédouanement, contrôle technique MFK, assurance et délais de réimmatriculation.',
 'Pour les frontaliers utilisant un véhicule à plaques italiennes, il explique les règles de circulation en Suisse : limites de temps, assurance valable en Suisse, amendes et cas particuliers avec véhicules d\'entreprise.',
 'Les sujets clés incluent les règles d\'importation temporaire (formulaire 15.30), le délai de réexportation de 60 jours et les documents nécessaires au dédouanement aux bureaux de Stabio ou Chiasso.',
 'Le transfert d\'un véhicule entre les deux pays implique des coûts importants : droits de douane suisses (4 % de la valeur du véhicule), TVA (8,1 %), frais du contrôle technique MFK (CHF 100–250), nouvelle immatriculation suisse (CHF 50–120) et assurance obligatoire valable en Suisse. Des frais de radiation italiens et des charges PRA s\'ajoutent. Au total, le transfert d\'une voiture moyenne coûte CHF 2 500–5 000.',
 'La procédure documentaire prend généralement 4 à 8 semaines. Les documents requis comprennent le certificat d\'immatriculation italien original (carta di circolazione), la preuve de propriété, un contrôle technique EU valide (revisione), le formulaire douanier 18.44 pour l\'importation définitive et la preuve de résidence ou d\'emploi en Suisse. Commencer tôt et réserver le contrôle MFK à l\'avance est crucial, car les délais d\'attente au Tessin peuvent dépasser trois semaines.',
 ],
 },
 '/guida-frontaliere/': {
 en: [
 'The cross-border guide collects practical and up-to-date information for those who work in Ticino and live in Italy: administrative procedures, permits, required documents, and tips based on the experience of thousands of cross-border workers.',
 'Each section is designed to be consulted independently and contains direct links to official forms, relevant offices, and calculation tools to verify practical implications immediately.',
 'The guides cover the entire cross-border lifecycle: from first employment to retirement, including unemployment, car transfer, border crossings, and cross-border maternity/paternity leave.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source: <a href="https://www.seco.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">SECO - State Secretariat for Economic Affairs</a></p>',
 ],
 de: [
 'Der Grenzgänger-Leitfaden sammelt praktische und aktuelle Informationen für alle, die im Tessin arbeiten und in Italien leben: Verwaltungsverfahren, Bewilligungen, erforderliche Dokumente und Tipps aus der Erfahrung Tausender Grenzgänger.',
 'Jeder Abschnitt ist für eigenständige Nutzung konzipiert und enthält direkte Links zu offiziellen Formularen, zuständigen Ämtern und Berechnungstools zur sofortigen Überprüfung praktischer Auswirkungen.',
 'Die Leitfäden decken den gesamten Grenzgänger-Lebenszyklus ab: vom ersten Arbeitstag bis zur Pensionierung, einschliesslich Arbeitslosigkeit, Autotransfer, Grenzübergänge und grenzüberschreitendem Mutter-/Vaterschaftsurlaub.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Quelle: <a href="https://www.seco.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">SECO - Staatssekretariat für Wirtschaft</a></p>',
 ],
 fr: [
 'Le guide frontalier rassemble des informations pratiques et actualisées pour ceux qui travaillent au Tessin et vivent en Italie : procédures administratives, permis, documents requis et conseils basés sur l\'expérience de milliers de frontaliers.',
 'Chaque section est conçue pour être consultée de manière indépendante et contient des liens directs vers les formulaires officiels, les bureaux compétents et les outils de calcul pour vérifier immédiatement les implications pratiques.',
 'Les guides couvrent l\'ensemble du cycle de vie du frontalier : du premier emploi à la retraite, en passant par le chômage, le transfert auto, les postes frontières et le congé maternité/paternité transfrontalier.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source : <a href="https://www.seco.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">SECO - Secrétariat d\'État à l\'économie</a></p>',
 ],
 },

 // ───── Glossary ───────────────────────────────────────────────
 '/glossario-frontaliere/': {
 it: [
 'Il glossario fornisce definizioni chiare e contestualizzate dei termini tecnici che ogni frontaliere incontra quotidianamente: sigle fiscali (AVS, LPP, LAMal, IRPEF, INPS), documenti amministrativi (CU, Modello 730, Lohnausweis, Formulario U1) e concetti giuridici (domicilio fiscale, stabile organizzazione, quasi-residente, tassazione concorrente).',
 'Ogni voce è scritta con linguaggio accessibile e collegata agli strumenti del sito che utilizzano quel concetto. Ad esempio, dalla definizione di "imposta alla fonte" puoi accedere direttamente al simulatore di busta paga, e dalla voce "LPP" al calcolatore previdenziale. Questo approccio trasforma il glossario da semplice dizionario a punto di navigazione operativo.',
 'Comprendere questi termini è essenziale per leggere correttamente la busta paga svizzera, la dichiarazione dei redditi italiana, le comunicazioni ufficiali della Divisione delle contribuzioni ticinese e le lettere dell\'Agenzia delle Entrate. La terminologia bilingue (italiano-tedesco e italiano-francese) aiuta anche nelle comunicazioni dirette con le autorità svizzere.',
 'Il glossario copre anche le differenze terminologiche tra i sistemi svizzero e italiano: ad esempio, "contributi sociali" in Italia corrisponde a "Sozialabzüge" in Svizzera; "certificazione unica" (CU) è l\'equivalente italiano del "Lohnausweis" svizzero; e "pensione di vecchiaia INPS" ha il suo corrispettivo nel primo pilastro AVS/AHV svizzero. Queste corrispondenze evitano confusione nei documenti transfrontalieri.',
 'Le voci vengono aggiornate regolarmente in base alle novità legislative, alle modifiche dei regolamenti cantonali e alle domande più frequenti della community di frontalieri. Ogni termine include riferimenti alle fonti normative ufficiali (leggi federali, accordi bilaterali, circolari dell\'AFC) per consentire un approfondimento autonomo.',
 ],
 en: [
 'The glossary provides clear, contextualised definitions of technical terms every cross-border worker encounters: fiscal acronyms (AVS, LPP, LAMal, IRPEF, INPS), administrative documents (CU, Modello 730, Lohnausweis, U1 Form), and legal concepts (fiscal domicile, permanent establishment, quasi-resident, concurrent taxation).',
 'Each entry is written in accessible language and linked to the site\'s tools that use that concept. For example, from the definition of "withholding tax" you can access the payslip simulator directly, and from the "LPP" entry the pension calculator. This approach transforms the glossary from a simple dictionary into a practical navigation hub.',
 'Understanding these terms is crucial for reading Swiss payslips, Italian tax declarations, official communications from the Ticino tax division, and letters from the Italian Revenue Agency. Bilingual terminology (Italian-German and Italian-French) also helps with direct communications to Swiss authorities.',
 'The glossary also covers terminological differences between the Swiss and Italian systems: for example, "contributi sociali" in Italy corresponds to "Sozialabzüge" in Switzerland; "certificazione unica" (CU) is the Italian equivalent of the Swiss "Lohnausweis"; and "pensione di vecchiaia INPS" has its counterpart in the Swiss first-pillar AVS/AHV. These correspondences prevent confusion in cross-border documents.',
 'Entries are regularly updated based on legislative changes, cantonal regulation amendments, and the most frequent questions from the cross-border worker community. Each term includes references to official regulatory sources (federal laws, bilateral agreements, AFC circulars) to enable independent further research.',
 ],
 de: [
 'Das Glossar bietet verständliche, kontextualisierte Definitionen der Fachbegriffe, die jeder Grenzgänger antrifft: Steuerabkürzungen (AHV, BVG, KVG, IRPEF, INPS), Verwaltungsdokumente (CU, Modello 730, Lohnausweis, Formular U1) und juristische Konzepte (Steuerdomizil, Betriebsstätte, Quasi-Ansässigkeit, konkurrierende Besteuerung).',
 'Jeder Eintrag ist in allgemeinverständlicher Sprache verfasst und mit den Tools der Website verknüpft, die das jeweilige Konzept verwenden. Von der Definition „Quellensteuer" gelangen Sie direkt zum Lohnabrechnungssimulator, vom Eintrag „BVG" zum Vorsorgerechner. Dieser Ansatz verwandelt das Glossar von einem einfachen Wörterbuch in einen praktischen Navigationsknotenpunkt.',
 'Das Verständnis dieser Begriffe ist entscheidend für das Lesen von Schweizer Lohnabrechnungen, italienischen Steuererklärungen, offiziellen Mitteilungen der Tessiner Steuerverwaltung und Schreiben der italienischen Steuerbehörde. Die zweisprachige Terminologie (Italienisch-Deutsch und Italienisch-Französisch) hilft auch bei der direkten Kommunikation mit Schweizer Behörden.',
 'Das Glossar deckt auch terminologische Unterschiede zwischen dem schweizerischen und italienischen System ab: „contributi sociali" in Italien entspricht „Sozialabzüge" in der Schweiz; „certificazione unica" (CU) ist das italienische Äquivalent zum Schweizer „Lohnausweis"; und die „pensione di vecchiaia INPS" hat ihre Entsprechung in der ersten Säule AHV/AVS. Diese Zuordnungen vermeiden Verwirrung bei grenzüberschreitenden Dokumenten.',
 'Die Einträge werden regelmässig aktualisiert basierend auf Gesetzesänderungen, kantonalen Verordnungsanpassungen und den häufigsten Fragen der Grenzgänger-Community. Jeder Begriff enthält Verweise auf offizielle Rechtsquellen (Bundesgesetze, bilaterale Abkommen, ESTV-Rundschreiben) für eigenständige Vertiefung.',
 ],
 fr: [
 'Le glossaire fournit des définitions claires et contextualisées des termes techniques que tout frontalier rencontre : sigles fiscaux (AVS, LPP, LAMal, IRPEF, INPS), documents administratifs (CU, Modello 730, Lohnausweis, formulaire U1) et concepts juridiques (domicile fiscal, établissement stable, quasi-résident, taxation concurrente).',
 'Chaque entrée est rédigée dans un langage accessible et reliée aux outils du site qui utilisent ce concept. Par exemple, depuis la définition d\'« impôt à la source », vous accédez directement au simulateur de fiche de paie, et depuis l\'entrée « LPP » au calculateur de prévoyance. Cette approche transforme le glossaire d\'un simple dictionnaire en un hub de navigation pratique.',
 'Comprendre ces termes est essentiel pour lire les fiches de paie suisses, les déclarations fiscales italiennes, les communications officielles de la division des contributions tessinoise et les courriers de l\'administration fiscale italienne. La terminologie bilingue (italien-allemand et italien-français) aide aussi pour la communication directe avec les autorités suisses.',
 'Le glossaire couvre aussi les différences terminologiques entre les systèmes suisse et italien : par exemple, « contributi sociali » en Italie correspond à « Sozialabzüge » en Suisse ; « certificazione unica » (CU) est l\'équivalent italien du « Lohnausweis » suisse ; et la « pensione di vecchiaia INPS » a son correspondant dans le 1er pilier AVS/AHV. Ces correspondances évitent la confusion dans les documents transfrontaliers.',
 'Les entrées sont régulièrement mises à jour en fonction des évolutions législatives, des modifications réglementaires cantonales et des questions les plus fréquentes de la communauté frontalière. Chaque terme inclut des références aux sources normatives officielles (lois fédérales, accords bilatéraux, circulaires AFC) pour permettre un approfondissement autonome.',
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
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source: <a href="https://www.bfs.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Federal Statistical Office (FSO)</a></p>',
 ],
 de: [
 'Der Bereich „Leben im Tessin" deckt praktische Aspekte des Alltags für im Kanton Arbeitende ab: Wohnen, Transport, Einkaufen, Familiendienste und Freizeit.',
 'Die Informationen richten sich sowohl an Personen, die einen Umzug in die Schweiz erwägen, als auch an jene, die in Italien bleiben und das tägliche Pendeln und die Lebenshaltungskosten als Grenzgänger optimieren möchten.',
 'Behandelte Praxisthemen umfassen die Wohnungsmarktanalyse beiderseits der Grenze, Transportoptionen von Zugfahrplänen bis Grenzübergangsverkehr, Supermarkt- und Einkaufskostenvergleiche, Verfügbarkeit und Kosten von Kinderbetreuung, Handytarifvergleiche sowie Renovierungskostenrechner mit italienischen Steuerabzugsmöglichkeiten.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Quelle: <a href="https://www.bfs.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Bundesamt für Statistik (BFS)</a></p>',
 ],
 fr: [
 'La section « Vivre au Tessin » couvre les aspects pratiques de la vie quotidienne pour ceux qui travaillent dans le canton : logement, transports, courses, services familiaux et loisirs.',
 'Les informations s\'adressent aussi bien à ceux qui envisagent un déménagement en Suisse qu\'à ceux qui restent en Italie et souhaitent optimiser le trajet quotidien et les dépenses de la vie transfrontalière.',
 'Les domaines pratiques couverts comprennent l\'analyse du marché immobilier des deux côtés de la frontière, les options de transport des horaires de trains au trafic frontalier, les comparaisons de coûts en supermarché, la disponibilité et les tarifs des crèches, les comparaisons de forfaits téléphoniques et les calculateurs de coûts de rénovation avec déductions fiscales italiennes.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source : <a href="https://www.bfs.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Office fédéral de la statistique (OFS)</a></p>',
 ],
 },

 // ───── Statistics ─────────────────────────────────────────────
 '/statistiche/': {
 en: [
 'The statistics section presents aggregate data and trends on the cross-border phenomenon in Ticino: number of G permits by sector, average salary trends, cantonal unemployment rate, and border crossing traffic flows.',
 'Data comes from official sources (USTAT, SECO, FSO) and is updated periodically. Interactive charts allow exploration of time series and comparison of different periods.',
 'All charts are fully interactive: hover over data points for detailed values, filter by year or sector, and export visualisations for reports. Data is sourced from USTAT (Ticino cantonal statistics), SECO (State Secretariat for Economic Affairs), and the FSO (Federal Statistical Office), ensuring reliability and transparency in every figure presented.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source: <a href="https://www.bfs.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Federal Statistical Office (FSO)</a> · <a href="https://www.seco.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">SECO</a></p>',
 ],
 de: [
 'Der Statistikbereich präsentiert aggregierte Daten und Trends zum Grenzgängerphänomen im Tessin: Anzahl der G-Bewilligungen nach Branche, durchschnittliche Gehaltsentwicklung, kantonale Arbeitslosenquote und Verkehrsströme an den Grenzübergängen.',
 'Die Daten stammen aus offiziellen Quellen (USTAT, SECO, BFS) und werden regelmässig aktualisiert. Interaktive Grafiken ermöglichen die Erkundung von Zeitreihen und den Vergleich verschiedener Perioden.',
 'Alle Diagramme sind vollständig interaktiv: Fahren Sie mit der Maus über Datenpunkte für Detailwerte, filtern Sie nach Jahr oder Branche und exportieren Sie Visualisierungen für Berichte. Die Daten stammen von USTAT (Tessiner Kantonsstatistik), SECO (Staatssekretariat für Wirtschaft) und dem BFS (Bundesamt für Statistik) — für Zuverlässigkeit und Transparenz bei jeder dargestellten Kennzahl.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Quelle: <a href="https://www.bfs.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Bundesamt für Statistik (BFS)</a> · <a href="https://www.seco.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">SECO</a></p>',
 ],
 fr: [
 'La section statistiques présente des données agrégées et des tendances sur le phénomène frontalier au Tessin : nombre de permis G par secteur, évolution des salaires moyens, taux de chômage cantonal et flux de trafic aux postes frontières.',
 'Les données proviennent de sources officielles (USTAT, SECO, OFS) et sont mises à jour périodiquement. Les graphiques interactifs permettent d\'explorer les séries temporelles et de comparer différentes périodes.',
 'Tous les graphiques sont entièrement interactifs : survolez les points de données pour les valeurs détaillées, filtrez par année ou secteur, et exportez les visualisations pour vos rapports. Les données proviennent de l\'USTAT (statistique cantonale tessinoise), du SECO (Secrétariat d\'État à l\'économie) et de l\'OFS (Office fédéral de la statistique), garantissant fiabilité et transparence pour chaque chiffre présenté.',
 '<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Source : <a href="https://www.bfs.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">Office fédéral de la statistique (OFS)</a> · <a href="https://www.seco.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">SECO</a></p>',
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

 // ───── Ticinese dialect (striking distance target) ──────────
 '/dialetto-ticinese': {
 it: [
 'Il <strong>dialetto ticinese</strong> appartiene al gruppo lombardo-alpino occidentale ed è parlato in Canton Ticino, nelle valli italofone dei Grigioni (Mesolcina, Calanca, Val Bregaglia, Val Poschiavo) e in alcune zone dell\'Insubria italiana. Pur condividendo radici con il lombardo milanese e comasco, presenta peculiarità fonetiche e lessicali proprie legate alla storia linguistica della Svizzera italiana.',
 '<strong>Le 10 espressioni più usate al lavoro in Ticino</strong>: 1) "Ciao, cume la va?" (saluto informale tra colleghi); 2) "A gh\'è un casòtt" (c\'è un caos, usato in cantiere e in ufficio); 3) "Dà una man" (dare una mano, aiutare); 4) "Mangià on toch" (fare la pausa pranzo veloce); 5) "Fà fadiga" (faticare su un progetto); 6) "Tirà via" (portare a termine un compito); 7) "Vegn chì" (vieni qui, usato per chiamare un collega); 8) "L\'è mia cüra mia" (non è compito mio); 9) "Bon fin setimana" (buon fine settimana); 10) "Stà trancuill" (stai tranquillo, rassicurante).',
 '<strong>Parole in dialetto ticinese</strong> più frequenti nella vita quotidiana del frontaliere: <em>pèn</em> (pane), <em>aqua</em> (acqua), <em>cafè</em> (caffè), <em>scià</em> (qui), <em>là</em> (lì), <em>gatt</em> (gatto), <em>cà</em> (casa), <em>strada</em> (strada), <em>auto</em> (auto), <em>trenin</em> (treno), <em>pizz</em> (un po\'), <em>miga</em> (non/mica), <em>boccia</em> (bottiglia), <em>scerpa</em> (sciarpa), <em>pizzigà</em> (pizzicare). Molte parole sono comprensibili a chi parla lombardo lombardo o milanese, ma con pronuncia e accenti che rivelano l\'origine svizzero-italiana di chi le usa.',
 '<strong>Differenze tra dialetto ticinese e italiano standard</strong>: il ticinese conserva la <em>u</em> lombarda (pronunciata come la "u" francese), elide le vocali finali ("andà" invece di "andare"), raddoppia consonanti ("tucc" per "tutti"), e integra germanismi storici come <em>umbrèla</em> (ombrello, dal tedesco) o calchi francesi risalenti al periodo napoleonico. L\'italiano standard si è diffuso in Ticino solo nell\'Ottocento con l\'alfabetizzazione, mentre il dialetto è rimasto la lingua quotidiana nelle valli fino al Novecento.',
 'Per i <a href="https://frontaliereticino.ch/job-board/">frontalieri che lavorano in Ticino</a>, imparare qualche espressione dialettale facilita l\'integrazione con i colleghi svizzeri, soprattutto nei settori dell\'edilizia, dell\'ospitalità e dell\'artigianato dove il dialetto è ancora vivo. Nei contesti professionali formali (banche, uffici pubblici, sanità) prevale l\'italiano standard, ma il dialetto resta un indicatore di familiarità culturale e viene spesso apprezzato come segno di rispetto per la cultura locale.',
 ],
 en: [
 'The Ticinese dialect belongs to the Western Lombard-Alpine group and is spoken in Canton Ticino, the Italian-speaking valleys of Grisons (Mesolcina, Calanca, Bregaglia, Poschiavo), and parts of Italian Insubria. While sharing roots with Milanese and Comasque Lombard, it has distinctive phonetic and lexical features tied to the linguistic history of Italian-speaking Switzerland.',
 'Understanding basic Ticinese phrases helps cross-border workers integrate with Swiss colleagues, especially in construction, hospitality, and trades where dialect is still widely spoken. Common expressions include "cume la va?" (how are you?), "dà una man" (give a hand), and "bon fin setimana" (have a good weekend). Each phrase carries cultural weight beyond its literal meaning.',
 'Ticinese preserves the Lombard "u" (pronounced like French "u"), drops final vowels (andà instead of andare), doubles consonants (tucc for tutti), and retains historical Germanisms from centuries of Swiss influence. Standard Italian only spread in Ticino during the 19th century with universal literacy; dialect remained the everyday language in valleys well into the 20th century.',
 'In formal professional contexts (banking, public administration, healthcare) standard Italian prevails, but dialect serves as a marker of cultural familiarity. Cross-border workers who pick up dialect expressions are often welcomed as a sign of respect for local culture — a useful soft skill when building long-term relationships with Ticino colleagues and employers.',
 ],
 de: [
 'Der Tessiner Dialekt gehört zur westlichen lombardisch-alpinen Sprachgruppe und wird im Kanton Tessin, in den italienischsprachigen Tälern Graubündens (Misox, Calancatal, Bergell, Puschlav) und in Teilen der italienischen Insubrien gesprochen. Er teilt Wurzeln mit dem Mailänder und Comasker Lombardisch, weist aber eigene phonetische und lexikalische Merkmale auf, die mit der Sprachgeschichte der italienischsprachigen Schweiz verbunden sind.',
 'Grundlegende Tessiner Ausdrücke zu beherrschen hilft Grenzgängern, sich mit Schweizer Kollegen zu verständigen, besonders im Bauwesen, Gastgewerbe und Handwerk, wo der Dialekt lebendig geblieben ist. Häufige Redewendungen sind "cume la va?" (wie geht\'s?), "dà una man" (eine Hand geben, helfen) und "bon fin setimana" (schönes Wochenende). Jede Wendung trägt kulturelle Bedeutung über den wörtlichen Sinn hinaus.',
 'Der Tessinerdialekt bewahrt das lombardische "u" (ausgesprochen wie das französische "u"), lässt Endvokale weg, verdoppelt Konsonanten und integriert historische Germanismen aus Jahrhunderten Schweizer Einflusses. Standarditalienisch verbreitete sich im Tessin erst im 19. Jahrhundert; der Dialekt blieb bis weit ins 20. Jahrhundert Alltagssprache in den Tälern.',
 'In formalen beruflichen Kontexten (Banken, Verwaltung, Gesundheitswesen) herrscht Standarditalienisch vor, aber der Dialekt dient als Zeichen kultureller Vertrautheit. Grenzgänger, die Dialektausdrücke aufschnappen, werden oft als Zeichen des Respekts für die lokale Kultur willkommen geheissen — eine nützliche Soft Skill für langfristige Beziehungen zu Tessiner Kollegen und Arbeitgebern.',
 ],
 fr: [
 'Le dialecte tessinois appartient au groupe lombard-alpin occidental et est parlé dans le canton du Tessin, les vallées italophones des Grisons (Mésolcine, Calanca, Bregaglia, Poschiavo) et certaines parties de l\'Insubrie italienne. Il partage ses racines avec le lombard milanais et comasque, mais présente des traits phonétiques et lexicaux distincts liés à l\'histoire linguistique de la Suisse italienne.',
 'Connaître quelques expressions tessinoises aide les frontaliers à s\'intégrer avec les collègues suisses, surtout dans la construction, l\'hôtellerie et l\'artisanat où le dialecte reste vivant. Expressions courantes : "cume la va?" (comment ça va ?), "dà una man" (donner un coup de main), "bon fin setimana" (bon week-end). Chaque formule porte une valeur culturelle au-delà du sens littéral.',
 'Le tessinois préserve le "u" lombard (prononcé comme le "u" français), supprime les voyelles finales, redouble les consonnes et conserve des germanismes historiques issus des siècles d\'influence suisse. L\'italien standard ne s\'est répandu au Tessin qu\'au XIXe siècle ; le dialecte est resté la langue quotidienne dans les vallées jusqu\'au XXe siècle.',
 'Dans les contextes professionnels formels (banques, administration, santé) l\'italien standard prévaut, mais le dialecte est un marqueur de familiarité culturelle. Les frontaliers qui adoptent des expressions dialectales sont souvent accueillis comme un signe de respect pour la culture locale — une compétence sociale utile pour tisser des relations durables avec collègues et employeurs tessinois.',
 ],
 },

 // ───── Ticino public holidays ────────────────────────────────
 '/tasse-e-pensione/festivita-ticino': {
 en: [
 'Canton Ticino observes 15 public holidays per year — the 9 federal Swiss holidays plus 6 cantonal holidays specific to Ticino. For cross-border workers, these dates directly affect overtime calculations, pay for days worked on holidays (at least 1.25× rate), and whether the employer must pay for the holiday even if the worker is absent.',
 'Public holidays that fall on weekdays reduce the number of working days in that month, which can affect prorated salary calculations for workers on monthly pay, holiday entitlement accrual, and the distribution of the 13th month payment across the calendar year.',
 'Cross-border workers should also note that Italian public holidays do not automatically apply in Switzerland: if you are working in Ticino, Swiss holidays govern your schedule. However, Swiss law allows workers to take Italian national holidays as vacation days if agreed with the employer in writing.',
 'For hourly-paid cross-border workers (Stundenlohn), public holidays have a direct financial impact: hours not worked on a holiday are generally compensated at the regular rate if the holiday falls on a normal working day. Monthly-paid workers receive their full salary regardless, but overtime worked on holidays must be paid at a minimum 125% rate under the Swiss Code of Obligations, and many CCL agreements in Ticino stipulate 150% or even 200%.',
 'Planning around the Swiss and Italian holiday calendars is essential for frontalieri families with children in Italian schools. Italian schools observe approximately 12 additional closure days not aligned with Swiss holidays, including Carnevale, patron saint days, and regional holidays. Conversely, Swiss holidays like Jeûne fédéral (third Sunday of September) and Ascension Thursday are regular school days in Italy, requiring careful coordination of childcare arrangements.',
 ],
 de: [
 'Der Kanton Tessin feiert 15 Feiertage pro Jahr — die 9 nationalen Schweizer Feiertage plus 6 kantonale Feiertage, die speziell für das Tessin gelten. Für Grenzgänger wirken sich diese Daten direkt auf die Überstundenberechnung, die Vergütung für an Feiertagen geleistete Arbeit (mindestens 1,25-fach) und die Lohnfortzahlungspflicht aus.',
 'Feiertage, die auf Werktage fallen, reduzieren die Anzahl der Arbeitstage im jeweiligen Monat und können anteilige Gehaltsberechnungen, die Urlaubsrückstellungsrate und die Verteilung des 13. Monatslohns beeinflussen.',
 'Grenzgänger sollten auch beachten, dass italienische Feiertage in der Schweiz nicht automatisch gelten. In Ticino arbeitende Grenzgänger unterliegen dem Schweizer Feiertagskalender, können aber mit schriftlicher Arbeitgebervereinbarung italienische Nationalfeiertage als Urlaubstage nehmen.',
 'Für im Stundenlohn bezahlte Grenzgänger haben Feiertage eine direkte finanzielle Auswirkung: An Feiertagen nicht geleistete Stunden werden zum regulären Satz vergütet, wenn der Feiertag auf einen normalen Arbeitstag fällt. Monatslohnempfänger erhalten ihr volles Gehalt, aber an Feiertagen geleistete Überstunden müssen gemäss Schweizer OR mindestens zu 125 % vergütet werden — viele GAV im Tessin sehen 150 % oder sogar 200 % vor.',
 'Die Planung rund um die Schweizer und italienischen Feiertagskalender ist für Grenzgängerfamilien mit Kindern in italienischen Schulen unerlässlich. Italienische Schulen haben etwa 12 zusätzliche Schliesstage, die nicht mit Schweizer Feiertagen übereinstimmen — darunter Karneval, Schutzpatrontage und regionale Feiertage. Umgekehrt sind Schweizer Feiertage wie der Eidgenössische Bettag und Auffahrt in Italien reguläre Schultage, was eine sorgfältige Koordination der Kinderbetreuung erfordert.',
 ],
 fr: [
 'Le Canton du Tessin observe 15 jours fériés par an — les 9 jours fériés fédéraux suisses plus 6 jours fériés cantonaux spécifiques au Tessin. Pour les frontaliers, ces dates impactent directement le calcul des heures supplémentaires, la rémunération des jours travaillés en jours fériés (minimum 1,25×) et l\'obligation de l\'employeur de payer ces jours.',
 'Les jours fériés tombant en semaine réduisent le nombre de jours ouvrables du mois, ce qui peut affecter les calculs de salaire au prorata, l\'accumulation des droits aux congés et la répartition du 13e mois sur l\'année civile.',
 'Les frontaliers doivent aussi noter que les jours fériés italiens ne s\'appliquent pas automatiquement en Suisse : ceux qui travaillent au Tessin sont soumis au calendrier suisse, mais peuvent prendre les jours fériés italiens en congés payés sur accord écrit de l\'employeur.',
 'Pour les frontaliers payés à l\'heure (Stundenlohn), les jours fériés ont un impact financier direct : les heures non travaillées un jour férié sont compensées au taux normal si le jour tombe sur un jour ouvrable habituel. Les salariés mensuels perçoivent leur salaire complet, mais les heures supplémentaires effectuées un jour férié doivent être payées au minimum à 125 % selon le Code des obligations suisse — de nombreuses CCT au Tessin prévoient 150 % voire 200 %.',
 'La planification autour des calendriers de jours fériés suisses et italiens est essentielle pour les familles frontalières avec des enfants scolarisés en Italie. Les écoles italiennes observent environ 12 jours de fermeture supplémentaires non alignés avec les fériés suisses — dont le Carnaval, les fêtes patronales et les fériés régionaux. Inversement, les fériés suisses comme le Jeûne fédéral et l\'Ascension sont des jours d\'école normaux en Italie, nécessitant une coordination soigneuse de la garde d\'enfants.',
 ],
 },

 // ───── Grocery price comparison ─────────────────────────────
 '/compara-servizi/confronta-prezzi-spesa': {
 en: [
 'The grocery price comparator benchmarks a standard weekly shopping basket across Swiss supermarkets (Migros, Coop, Denner, Aldi Suisse) and Italian equivalents (Esselunga, Lidl, Eurospin, Conad), applying the current CHF-EUR exchange rate to show real cost in a single currency.',
 'The comparison covers over 50 product categories: fresh produce, dairy, meat, packaged goods, beverages, and personal care items. On average, identical branded products cost 35-55% more in Ticino than in the Italian border regions, making cross-border grocery shopping a significant monthly saving for many frontalieri families.',
 'Beyond the basket total, the tool shows which product categories offer the greatest savings in Italy (meat, cheese, wine, fresh pasta) versus products where Swiss quality or local availability makes Swiss supermarkets competitive (fresh bakery, Swiss chocolate, specialty dairy). Results update monthly as scanner price data is refreshed.',
 'For cross-border families doing weekly shopping in Italy, the tool calculates annual savings including the time cost of the detour: at an average of 20 minutes extra driving per trip, the break-even point is reached when the basket savings exceed approximately EUR 15 per trip, which is typical for families of 3 or more.',
 'The comparison also includes non-food categories where cross-border price differences are significant: cleaning products (40-60% cheaper in Italy), over-the-counter medications (30-50% cheaper), and clothing/shoes (20-40% cheaper during Italian sales seasons in January and July).',
 ],
 de: [
 'Der Lebensmittelpreisvergleich bewertet einen standardisierten Wocheneinkauf in Schweizer Supermärkten (Migros, Coop, Denner, Aldi Suisse) und italienischen Pendants (Esselunga, Lidl, Eurospin, Conad) und wendet den aktuellen CHF-EUR-Wechselkurs an.',
 'Der Vergleich umfasst über 50 Produktkategorien: Frischprodukte, Milchprodukte, Fleisch, Fertigprodukte, Getränke und Körperpflegeartikel. Im Durchschnitt kosten identische Markenprodukte im Tessin 35-55 % mehr als in den italienischen Grenzregionen.',
 'Das Tool zeigt auch, welche Kategorien in Italien am meisten sparen (Fleisch, Käse, Wein, frische Pasta) versus Produkte, bei denen Schweizer Qualität oder lokale Verfügbarkeit die Schweizer Supermärkte wettbewerbsfähig macht. Ergebnisse werden monatlich aktualisiert.',
 'Für Grenzgänger-Familien, die wöchentlich in Italien einkaufen, berechnet das Tool die jährlichen Einsparungen einschliesslich der Zeitkosten des Umwegs: Bei durchschnittlich 20 Minuten zusätzlicher Fahrzeit pro Einkauf liegt die Gewinnschwelle bei ca. EUR 15 pro Einkauf, was für Familien ab 3 Personen typisch ist.',
 'Der Vergleich umfasst auch Non-Food-Kategorien mit signifikanten grenzüberschreitenden Preisunterschieden: Reinigungsprodukte (40-60 % günstiger in Italien), rezeptfreie Medikamente (30-50 % günstiger) und Kleidung/Schuhe (20-40 % günstiger während der italienischen Schlussverkäufe im Januar und Juli).',
 ],
 fr: [
 'Le comparateur de prix alimentaires compare un panier de courses hebdomadaire standard dans les supermarchés suisses (Migros, Coop, Denner, Aldi Suisse) et italiens (Esselunga, Lidl, Eurospin, Conad), en appliquant le taux de change CHF-EUR actuel.',
 'La comparaison couvre plus de 50 catégories de produits. En moyenne, les produits de marque identiques coûtent 35 à 55 % plus cher au Tessin que dans les régions frontalières italiennes, faisant des courses en Italie une économie mensuelle significative pour de nombreuses familles frontalières.',
 'L\'outil indique aussi quelles catégories offrent les plus grandes économies en Italie (viande, fromage, vin, pâtes fraîches) versus les produits où la qualité suisse ou la disponibilité locale rend les supermarchés suisses compétitifs. Les résultats sont mis à jour mensuellement.',
 'Pour les familles frontalières faisant leurs courses hebdomadaires en Italie, l\'outil calcule les économies annuelles incluant le coût en temps du détour : avec environ 20 minutes de conduite supplémentaire par trajet, le seuil de rentabilité est atteint quand les économies dépassent EUR 15 par course.',
 'La comparaison inclut aussi les catégories non-alimentaires où les différences de prix transfrontalières sont significatives : produits d\'entretien (40-60 % moins chers en Italie), médicaments sans ordonnance (30-50 % moins chers) et vêtements/chaussures (20-40 % moins chers pendant les soldes italiennes en janvier et juillet).',
 ],
 },

 // ───── Mobile operator comparison ───────────────────────────
 '/compara-servizi/confronta-operatori-mobili': {
 en: [
 'The mobile operator comparator evaluates plans from Swiss operators (Swisscom, Salt, Sunrise, Yallo, Aldi Talk CH) and Italian operators (TIM, Vodafone IT, WindTre, Iliad IT) specifically for cross-border workers who need reliable coverage in both countries without excessive roaming charges.',
 'Key criteria for frontalieri: daily cross-border usage (EU roaming is included in most Italian plans under EU regulation, while Swiss operators are not EU-bound), data allowances for border zone reception gaps, calling between Swiss and Italian numbers, and international transfer costs when sending CHF earnings to an Italian bank account.',
 'The comparison is structured around three typical cross-border usage profiles: commuter (high data, daily crossing), remote-first (occasional border crossing, video calls priority), and family plan (multiple SIMs, children in Italian schools). Select your profile to see the most relevant operator ranking.',
 'A key consideration for frontalieri is the dual-SIM strategy: using an Italian SIM for data-heavy usage at home and an eSIM from a Swiss operator for work calls and local Swiss services. The tool calculates the combined monthly cost of this approach versus a single international plan, showing that dual-SIM typically saves EUR 15-25 per month.',
 'Network coverage quality varies significantly in the border zone: some areas between Chiasso and Como experience frequent handovers between Swiss and Italian cell towers, causing dropped calls and data interruptions. The comparison includes real-world coverage quality scores for the specific border corridors most used by frontalieri commuters.',
 ],
 de: [
 'Der Mobilfunkanbieter-Vergleich bewertet Tarife von Schweizer Anbietern (Swisscom, Salt, Sunrise, Yallo) und italienischen Anbietern (TIM, Vodafone IT, WindTre, Iliad IT) speziell für Grenzgänger, die in beiden Ländern eine zuverlässige Abdeckung ohne übermässige Roaming-Kosten benötigen.',
 'Wesentliche Kriterien: tägliche grenzüberschreitende Nutzung (EU-Roaming ist in den meisten italienischen Tarifen enthalten, während Schweizer Anbieter nicht EU-gebunden sind), Datenkontingente für Empfangslücken in der Grenzzone und Anrufkosten zwischen Schweizer und italienischen Nummern.',
 'Der Vergleich ist nach drei typischen Grenzgänger-Nutzungsprofilen strukturiert: Pendler (hohe Datenmenge, tägliches Überqueren), Remote-First (gelegentliches Grenzüberschreiten, Videokonferenzen) und Familienplan (mehrere SIM-Karten). Wählen Sie Ihr Profil für das relevanteste Anbieterranking.',
 'Eine wichtige Überlegung für Grenzgänger ist die Dual-SIM-Strategie: eine italienische SIM für datenintensive Nutzung zu Hause und eine eSIM eines Schweizer Anbieters für Arbeitsanrufe. Das Tool berechnet die kombinierten monatlichen Kosten und zeigt, dass Dual-SIM typischerweise EUR 15-25 pro Monat spart.',
 'Die Netzabdeckungsqualität variiert erheblich in der Grenzzone: Einige Gebiete zwischen Chiasso und Como erleben häufige Wechsel zwischen Schweizer und italienischen Mobilfunkmasten. Der Vergleich enthält reale Abdeckungsqualitätsbewertungen für die von Grenzgänger-Pendlern am häufigsten genutzten Grenzkorridore.',
 ],
 fr: [
 'Le comparateur d\'opérateurs mobiles évalue les forfaits des opérateurs suisses (Swisscom, Salt, Sunrise, Yallo) et italiens (TIM, Vodafone IT, WindTre, Iliad IT) spécifiquement pour les frontaliers ayant besoin d\'une couverture fiable dans les deux pays sans frais d\'itinérance excessifs.',
 'Critères clés : utilisation transfrontalière quotidienne (le roaming UE est inclus dans la plupart des forfaits italiens selon la réglementation UE, les opérateurs suisses n\'étant pas soumis à l\'UE), quotas de données et coûts d\'appel entre numéros suisses et italiens.',
 'La comparaison est structurée autour de trois profils d\'utilisation frontalière typiques : pendulaire (données élevées, traversée quotidienne), remote-first (traversée occasionnelle, priorité visioconférence) et forfait famille (plusieurs SIM). Sélectionnez votre profil pour le classement le plus pertinent.',
 'Une considération clé pour les frontaliers est la stratégie double SIM : utiliser une SIM italienne pour l\'usage intensif de données à domicile et une eSIM d\'un opérateur suisse pour les appels professionnels. L\'outil calcule le coût mensuel combiné, montrant que le double SIM économise typiquement EUR 15-25 par mois.',
 'La qualité de couverture réseau varie significativement dans la zone frontalière : certaines zones entre Chiasso et Côme subissent des basculements fréquents entre antennes suisses et italiennes. La comparaison inclut des scores de qualité de couverture réels pour les corridors frontaliers les plus empruntés.',
 ],
 },

 // ───── Renovation bonus calculator ──────────────────────────
 '/compara-servizi/calcola-bonus-ristrutturazione': {
 en: [
 'The renovation bonus calculator helps cross-border workers who own property in Italy estimate the net cost of home improvement works after applying Italian fiscal incentives: the 50% renovation deduction (Bonus Ristrutturazione), the 65% Ecobonus for energy efficiency upgrades, the Superbonus for qualifying thermal envelope improvements, and the 36% furniture bonus for new appliances purchased after renovation.',
 'The tool calculates the deduction spread (the bonus is recovered over 10 equal annual IRPEF deductions), the total fiscal saving over the full recovery period, and the effective net cost of the works. It accounts for the EUR 10,000 franchise applicable to new cross-border workers under the 2026 Agreement when calculating how much of the Italian tax liability can absorb the deduction.',
 'For cross-border workers, coordination between Swiss withholding tax paid and Italian IRPEF is critical: the deduction is only valuable if you have Italian tax liability to offset. The calculator shows the breakeven point and recommends whether maximising the deduction is optimal or whether alternative investments offer better after-tax returns given your specific Swiss-Italian tax position.',
 'Eligibility for the Bonus Ristrutturazione 2026 requires the property to be located in Italy and used as a primary or secondary residence. Qualifying works include structural renovations, seismic upgrades, bathroom and kitchen refurbishment, electrical and plumbing overhauls, and energy efficiency improvements. The maximum deductible expenditure is EUR 96,000 per property unit, yielding a maximum 50% deduction of EUR 48,000 spread over 10 years. Cross-border workers must retain all invoices showing traceable bank payments (bonifico parlante).',
 'Cross-border workers claim renovation deductions through their Italian tax return (Modello 730 or Redditi PF), specifically in Section III-A for building renovation expenses. The deduction offsets IRPEF liability — but under the 2026 New Agreement, new frontalieri benefit from only a partial Italian tax base due to the EUR 10,000 franchise, which may limit the deductible amount. Workers should verify their projected Italian tax liability before committing to large renovation expenditures to ensure the full deduction can be absorbed over the 10-year recovery period.',
 ],
 de: [
 'Der Renovierungsbonus-Rechner hilft Grenzgängern, die in Italien Immobilien besitzen, die Nettokosten von Renovierungsarbeiten nach Anwendung italienischer Steueranreize zu schätzen: 50% Renovierungsabzug, 65% Ökobonus für Energieeffizienz-Upgrades, Superbonus und 36% Möbelbonus.',
 'Das Tool berechnet die Abzugsverteilung (der Bonus wird über 10 gleiche jährliche IRPEF-Abzüge zurückgewonnen), die gesamte Steuereinsparung über die gesamte Rückgewinnungsperiode und die effektiven Nettokosten. Es berücksichtigt die EUR 10.000-Franchise für neue Grenzgänger nach dem Abkommen 2026.',
 'Für Grenzgänger ist die Koordination zwischen der in der Schweiz gezahlten Quellensteuer und der italienischen IRPEF entscheidend: Der Abzug ist nur dann wertvoll, wenn Sie eine ausreichende italienische Steuerschuld haben. Der Rechner zeigt den Breakeven-Punkt.',
 'Die Anspruchsberechtigung für den Bonus Ristrutturazione 2026 erfordert, dass die Immobilie in Italien liegt und als Haupt- oder Zweitwohnsitz genutzt wird. Förderfähige Arbeiten umfassen Strukturrenovierungen, Erdbebenertüchtigung, Bad- und Küchenrenovierung, Elektro- und Sanitärsanierung sowie Energieeffizienzverbesserungen. Der maximale abzugsfähige Aufwand beträgt EUR 96.000 pro Wohneinheit — maximal EUR 48.000 Abzug verteilt auf 10 Jahre. Grenzgänger müssen alle Rechnungen mit nachverfolgbaren Banküberweisungen (Bonifico Parlante) aufbewahren.',
 'Grenzgänger beanspruchen Renovierungsabzüge über ihre italienische Steuererklärung (Modello 730 oder Redditi PF), speziell in Abschnitt III-A für Gebäuderenovierungskosten. Der Abzug mindert die IRPEF-Schuld — doch unter dem Neuen Abkommen 2026 profitieren neue Grenzgänger nur von einer teilweisen italienischen Bemessungsgrundlage aufgrund der EUR-10.000-Franchise, was den abzugsfähigen Betrag einschränken kann. Arbeitnehmer sollten ihre voraussichtliche italienische Steuerschuld prüfen, bevor sie grössere Renovierungsausgaben tätigen.',
 ],
 fr: [
 'Le calculateur de bonus rénovation aide les frontaliers propriétaires en Italie à estimer le coût net des travaux après application des incitations fiscales italiennes : déduction rénovation 50%, Écobonus 65% pour travaux d\'efficacité énergétique, Superbonus et bonus mobilier 36%.',
 'L\'outil calcule l\'étalement de la déduction (le bonus est récupéré en 10 tranches annuelles égales de déduction IRPEF), l\'économie fiscale totale sur la période de récupération et le coût net effectif. Il tient compte de la franchise de 10 000 EUR pour les nouveaux frontaliers selon l\'Accord 2026.',
 'Pour les frontaliers, la coordination entre l\'impôt à la source suisse payé et l\'IRPEF italienne est critique : la déduction n\'est utile que si vous avez une charge fiscale italienne suffisante. Le calculateur montre le point d\'équilibre et recommande la stratégie optimale selon votre position fiscale suisse-italienne.',
 'L\'éligibilité au Bonus Ristrutturazione 2026 exige que le bien soit situé en Italie et utilisé comme résidence principale ou secondaire. Les travaux éligibles comprennent les rénovations structurelles, la mise aux normes antisismiques, la réfection de salle de bains et cuisine, la rénovation électrique et sanitaire, et les améliorations énergétiques. Le plafond de dépenses déductibles est de 96 000 EUR par unité immobilière — soit une déduction maximale de 48 000 EUR étalée sur 10 ans. Les frontaliers doivent conserver toutes les factures avec virements bancaires traçables (bonifico parlante).',
 'Les frontaliers déclarent les déductions rénovation via leur déclaration italienne (Modello 730 ou Redditi PF), spécifiquement dans la Section III-A pour les frais de rénovation immobilière. La déduction réduit l\'IRPEF due — mais sous le Nouvel Accord 2026, les nouveaux frontaliers ne bénéficient que d\'une base imposable italienne partielle en raison de la franchise de 10 000 EUR, ce qui peut limiter le montant déductible. Il est recommandé de vérifier sa charge fiscale italienne prévisionnelle avant d\'engager de grosses dépenses de rénovation.',
 ],
 },

 // ───── Living in Italy ───────────────────────────────────────
 '/vivere-in-ticino/vivere-in-italia': {
 en: [
 'This section covers the practical realities of living in Italy while working in Swiss Canton Ticino — the daily life of around 70,000 frontalieri who make this choice. Topics covered include Italian border regions (Como, Varese, Verbano-Cusio-Ossola, Novara provinces), commute times to the main border crossings, and the administrative consequences of Italian tax residence.',
 'Italian residence means paying IRPEF and regional/municipal surcharges on your worldwide income, maintaining AIRE registration if moving abroad, and potentially accessing Italian public services (healthcare via Italian NHS, Italian public schools for children, Italian state pension contributions from INPS). The guide maps out all these obligations and entitlements clearly.',
 'For families with children, living in Italy gives access to Italian schooling at a fraction of Swiss tuition, Italian public healthcare without LAMal premiums (for G permit workers who opt for Italian NHS), and a cost of living that is typically 30-45% lower than equivalent accommodation in Lugano or Bellinzona. The section helps you calculate the real net advantage of Italian residence versus Swiss residency with a B permit.',
 'The section includes a detailed municipality comparison tool: enter your workplace in Ticino and the guide suggests optimal Italian comuni based on commute time, rental costs, school quality, local services, and proximity to supermarkets, pharmacies, and public transport connections to the border crossings.',
 'Tax planning for Italian-resident frontalieri requires understanding the interaction between Swiss withholding tax and Italian IRPEF: the guide walks through the annual tax return process step by step, including how to claim the foreign tax credit (Art. 165 TUIR), deduct commuting expenses, and report Swiss social security contributions on your 730/Redditi PF form.',
 ],
 de: [
 'Dieser Bereich deckt die praktischen Realitäten des Lebens in Italien bei der Arbeit im Schweizer Kanton Tessin ab — den Alltag von rund 70.000 Grenzgängern, die diese Wahl treffen. Behandelte Themen: italienische Grenzregionen (Como, Varese, Verbano-Cusio-Ossola, Novara), Pendelzeiten und administrative Konsequenzen des italienischen Steuerwohnsitzes.',
 'Italienischer Wohnsitz bedeutet IRPEF- und Regional-/Kommunalzuschlagszahlungen auf das Welteinkommen, AIRE-Registrierung und potenziellen Zugang zu italienischen öffentlichen Diensten (NHS, Schulen, INPS-Rentenversicherung). Der Leitfaden zeigt alle Pflichten und Ansprüche klar auf.',
 'Für Familien mit Kindern bietet das Leben in Italien Zugang zu günstigerer Schulbildung und öffentlicher Gesundheitsversorgung ohne LAMal-Prämien (für G-Bewilligungsinhaber, die den italienischen NHS wählen), bei Lebenshaltungskosten, die typischerweise 30-45 % niedriger sind als im Tessin.',
 'Der Bereich enthält ein detailliertes Gemeindevergleichstool: Geben Sie Ihren Arbeitsort im Tessin ein und der Leitfaden schlägt optimale italienische Comuni basierend auf Pendelzeit, Mietkosten, Schulqualität, lokalen Dienstleistungen und Nähe zu Grenzübergängen vor.',
 'Die Steuerplanung für in Italien wohnhafte Grenzgänger erfordert das Verständnis der Wechselwirkung zwischen Schweizer Quellensteuer und italienischer IRPEF: Der Leitfaden führt Schritt für Schritt durch die jährliche Steuererklärung, einschliesslich der Beantragung der ausländischen Steuergutschrift (Art. 165 TUIR) und der Geltendmachung von Pendelkosten.',
 ],
 fr: [
 'Cette section couvre les réalités pratiques de la vie en Italie tout en travaillant dans le Canton suisse du Tessin — le quotidien d\'environ 70 000 frontaliers qui font ce choix. Sujets traités : régions frontalières italiennes (provinces de Côme, Varese, Verbano-Cusio-Ossola, Novare), temps de trajet et conséquences administratives de la résidence fiscale italienne.',
 'La résidence italienne implique le paiement de l\'IRPEF et des surtaxes régionales/communales sur les revenus mondiaux, l\'inscription AIRE et l\'accès potentiel aux services publics italiens (SSN, écoles publiques italiennes, cotisations retraite INPS). Le guide présente clairement toutes ces obligations et droits.',
 'Pour les familles avec enfants, vivre en Italie donne accès à une scolarité moins coûteuse, aux soins de santé publics sans primes LAMal (pour les titulaires de permis G qui optent pour le SSN italien), avec un coût de la vie généralement 30-45% inférieur à celui de Lugano ou Bellinzona.',
 'La section comprend un outil de comparaison détaillé des communes : entrez votre lieu de travail au Tessin et le guide suggère les comuni italiens optimaux basés sur le temps de trajet, les coûts locatifs, la qualité des écoles et la proximité des postes frontières.',
 'La planification fiscale pour les frontaliers résidant en Italie nécessite de comprendre l\'interaction entre l\'impôt à la source suisse et l\'IRPEF italienne : le guide détaille étape par étape le processus de déclaration fiscale annuelle, y compris la demande du crédit d\'impôt étranger (Art. 165 TUIR) et la déduction des frais de déplacement.',
 ],
 },

 // ───── Border municipalities ─────────────────────────────────
 '/vivere-in-ticino/comuni-di-frontiera': {
 en: [
 'The border municipalities guide covers the Italian comuni within 20 km of the Swiss-Ticino border — the geographic threshold that determines the fiscal regime for cross-border workers under the 2026 New Agreement. Frontalieri residing in these municipalities benefit from the transitional regime where Switzerland returns approximately 40% of withholding tax to the Italian municipalities of origin.',
 'Practical information includes: distance from each comune to the nearest border crossing, commute time estimates to major Ticino employment centres (Lugano, Bellinzona, Locarno, Mendrisio), local public transport links (FerrovieNord, TILO regional rail, FlixBus routes), and rental market data showing average monthly rents versus Ticino equivalents.',
 'The guide also covers the administrative process for certifying residence in a border municipality for Swiss permit purposes, how to document the 20 km distance requirement, and what happens if you move to a comune outside the 20 km zone while keeping your Swiss job — including the fiscal implications of shifting to the new frontalieri regime with full Swiss withholding tax.',
 'The guide ranks border municipalities by overall frontalieri suitability score, combining factors like commute time to Lugano/Bellinzona, average rent per square meter, local service availability (medical, schooling, shopping), and public transport frequency. Top-ranked municipalities include Cantù, Olgiate Comasco, and Luino for different commute corridors.',
 'For families considering relocation from one border municipality to another, the comparison tool shows the fiscal impact of moving: different Italian comuni have varying addizionale comunale rates (0.4-0.8%), and moving beyond the 20 km zone triggers a shift to the new frontalieri tax regime with significantly higher Italian taxation.',
 ],
 de: [
 'Der Leitfaden zu den Grenzgemeinden behandelt die italienischen Comuni innerhalb von 20 km von der Schweizer-Tessiner Grenze — die geografische Schwelle, die das Steuerregime für Grenzgänger nach dem Neuen Abkommen 2026 bestimmt. In diesen Gemeinden wohnhafte Grenzgänger profitieren vom Übergangsregime, bei dem die Schweiz ca. 40 % der Quellensteuer an die italienischen Herkunftsgemeinden zurückgibt.',
 'Praktische Informationen: Entfernung jeder Gemeinde zum nächsten Grenzübergang, Pendelzeitschätzungen zu wichtigen Tessiner Beschäftigungszentren (Lugano, Bellinzona, Locarno, Mendrisio), ÖPNV-Verbindungen und Mietmarktdaten.',
 'Der Leitfaden behandelt auch das administrative Verfahren zur Bescheinigung des Wohnsitzes in einer Grenzgemeinde für Schweizer Bewilligungszwecke und die steuerlichen Folgen eines Umzugs ausserhalb der 20-km-Zone.',
 'Der Leitfaden bewertet Grenzgemeinden nach einem Gesamteignungsscore für Grenzgänger, der Pendelzeit nach Lugano/Bellinzona, durchschnittliche Miete pro Quadratmeter, lokale Dienstleistungsverfügbarkeit und ÖV-Frequenz kombiniert. Bestbewertete Gemeinden sind u.a. Cantù, Olgiate Comasco und Luino für verschiedene Pendelkorridore.',
 'Für Familien, die einen Umzug zwischen Grenzgemeinden erwägen, zeigt das Vergleichstool die steuerlichen Auswirkungen: verschiedene italienische Comuni haben unterschiedliche Addizionale-Comunale-Sätze (0,4-0,8 %), und ein Umzug jenseits der 20-km-Zone löst den Wechsel zum neuen Grenzgänger-Steuerregime mit deutlich höherer italienischer Besteuerung aus.',
 ],
 fr: [
 'Le guide des communes frontalières couvre les comuni italiens dans un rayon de 20 km de la frontière suisse-tessinoise — le seuil géographique déterminant le régime fiscal pour les frontaliers selon le Nouvel Accord 2026. Les frontaliers résidant dans ces communes bénéficient du régime transitoire où la Suisse reverse environ 40% de l\'impôt à la source aux communes italiennes d\'origine.',
 'Informations pratiques : distance de chaque commune au poste frontière le plus proche, estimations des temps de trajet vers les principaux centres d\'emploi tessinois (Lugano, Bellinzone, Locarno, Mendrisio), liaisons de transport public et données du marché locatif.',
 'Le guide couvre aussi la procédure administrative pour certifier la résidence dans une commune frontalière pour les besoins du permis suisse et les implications fiscales d\'un déménagement hors de la zone de 20 km tout en conservant l\'emploi en Suisse.',
 'Le guide classe les communes frontalières par score global d\'adéquation pour les frontaliers, combinant temps de trajet vers Lugano/Bellinzone, loyer moyen au mètre carré, disponibilité des services locaux et fréquence des transports publics. Les communes les mieux classées incluent Cantù, Olgiate Comasco et Luino selon les corridors.',
 'Pour les familles envisageant un déménagement entre communes frontalières, l\'outil de comparaison montre l\'impact fiscal : les différents comuni italiens ont des taux d\'addizionale comunale variables (0,4-0,8 %), et un déménagement au-delà de la zone de 20 km déclenche le passage au nouveau régime frontalier avec une imposition italienne nettement plus élevée.',
 ],
 },

 // ───── Italian-speaking Swiss schools ───────────────────────
 '/vivere-in-ticino/scuole-svizzera-italiana': {
 en: [
 'The Italian-speaking Swiss schools guide covers the education system in Canton Ticino and the bilingual border areas of Graubünden (Grigioni) for cross-border families considering schooling options in Switzerland. The Ticino system follows the Swiss model: scuola dell\'infanzia (3-6 years), scuola elementare (6-11), scuola media (11-15), and liceo/scuola professionale (15-18).',
 'For cross-border workers with children, enrolling in Ticino schools involves residency status checks — typically B permit holders can enrol children easily, while G permit holders face varying cantonal rules. The guide maps out school zones, lists the main public and private institutions, and explains the Ticino school calendar and holiday schedule.',
 'A cost comparison is included: Ticino public schools are free (with small material fees), while private schools range from CHF 15,000 to CHF 35,000 per year. Italian public schools in the border provinces offer a cheaper alternative for families living in Italy, with the guide providing commute time estimates and information on Italian-Swiss bilingual school programmes.',
 'For secondary education, the guide covers the unique Ticino "scuola media" system (ages 11-15), which has no direct equivalent in the Italian system, and explains the transition pathways to liceo, scuola professionale, or apprenticeship (formazione duale) — a distinctly Swiss option that combines school with practical training at a company.',
 'Language considerations are important: while instruction is in Italian (making the transition easier for Italian-resident children), Swiss-German is a mandatory second language from scuola media onwards. The guide lists schools with strong language support programmes and explains the cantonal integration support for newly arrived children of frontalieri.',
 ],
 de: [
 'Der Schulführer für die italienischsprachige Schweiz deckt das Bildungssystem im Kanton Tessin und den zweisprachigen Grenzgebieten Graubündens für grenzüberschreitende Familien ab: Scuola dell\'Infanzia (3-6 Jahre), Scuola Elementare (6-11), Scuola Media (11-15) und Liceo/Scuola Professionale (15-18).',
 'Für Grenzgänger mit Kindern beinhaltet die Einschulung im Tessin Wohnsitzprüfungen — B-Bewilligungsinhaber können Kinder in der Regel problemlos anmelden, während G-Bewilligungsinhaber unterschiedlichen Kantonsregeln gegenüberstehen. Der Leitfaden listet Schulzonen, Hauptinstitutionen und erklärt den Tessiner Schulkalender.',
 'Ein Kostenvergleich ist enthalten: Öffentliche Schulen im Tessin sind kostenlos, private Schulen kosten 15.000-35.000 CHF pro Jahr. Italienische öffentliche Schulen in den Grenzprovinzen bieten eine günstigere Alternative für in Italien lebende Familien.',
 'Für die Sekundarstufe behandelt der Leitfaden das einzigartige Tessiner Scuola-Media-System (11-15 Jahre), das kein direktes Äquivalent im italienischen System hat, und erklärt die Übergangswege zum Liceo, zur Scuola Professionale oder zur Berufslehre (formazione duale) — eine typisch schweizerische Option.',
 'Sprachliche Aspekte sind wichtig: Obwohl der Unterricht auf Italienisch erfolgt (was den Übergang für in Italien lebende Kinder erleichtert), ist Deutsch ab der Scuola Media obligatorische Zweitsprache. Der Leitfaden listet Schulen mit starken Sprachförderprogrammen und erklärt die kantonale Integrationsunterstützung.',
 ],
 fr: [
 'Le guide des écoles de Suisse italophone couvre le système éducatif du Canton du Tessin et des zones frontalières bilingues des Grisons pour les familles transfrontalières : scuola dell\'infanzia (3-6 ans), scuola elementare (6-11), scuola media (11-15) et lycée/école professionnelle (15-18).',
 'Pour les frontaliers avec enfants, l\'inscription dans les écoles du Tessin implique des vérifications de statut de résidence — les titulaires de permis B peuvent généralement inscrire leurs enfants facilement, tandis que les titulaires de permis G font face à des règles cantonales variables.',
 'Une comparaison des coûts est incluse : les écoles publiques au Tessin sont gratuites, les écoles privées coûtent de CHF 15 000 à CHF 35 000 par an. Les écoles publiques italiennes dans les provinces frontalières offrent une alternative moins coûteuse pour les familles vivant en Italie.',
 'Pour l\'enseignement secondaire, le guide couvre le système unique tessinois de la "scuola media" (11-15 ans), sans équivalent direct dans le système italien, et explique les voies de transition vers le lycée, l\'école professionnelle ou l\'apprentissage (formazione duale) — une option typiquement suisse.',
 'Les considérations linguistiques sont importantes : bien que l\'enseignement soit en italien (facilitant la transition pour les enfants résidant en Italie), l\'allemand est obligatoire comme deuxième langue dès la scuola media. Le guide liste les écoles avec de solides programmes de soutien linguistique et d\'intégration cantonale.',
 ],
 },

 // ───── Border crossing traffic history ───────────────────────
 '/statistiche/storico-traffico-dogane': {
 en: [
 'The border crossing traffic history section presents time-series data on the volume and timing of frontalieri crossings at all major Ticino-Italy border points: Chiasso, Como-Monte Olimpino, Ponte Tresa, Stabio, Gaggiolo, Balerna, and the smaller secondary crossings. Data covers monthly vehicle counts, seasonal trends, and peak hour distributions.',
 'For cross-border workers planning their commute, the historical data reveals actionable patterns: which months have the heaviest congestion (September, October, and January when school terms restart), which crossings have improved most with recent infrastructure investments, and how total frontalieri traffic has trended since the 2020 pandemic disruption through to 2026.',
 'The dataset is sourced from the Swiss Federal Customs Administration (BAZG) and the Italian Guardia di Finanza crossing records. Charts are fully interactive — filter by crossing, time period, and traffic type (car, bus, truck) to identify the optimal commute window for your specific crossing point.',
 'The analysis includes year-over-year growth rates showing that frontalieri traffic at Ticino border crossings has increased by an average of 2.3% annually since 2021, driven by economic recovery and new employment in the Lugano financial and biotech sectors. The Stabio crossing saw the largest capacity increase (+15%) following the 2024 lane expansion project.',
 'For commuters considering alternative transport modes, the section compares border crossing times by car, TILO regional train, and bus. Rail crossings at Chiasso station and the Mendrisio-Varese line offer predictable 5-minute border transit times versus 15-45 minutes by car during peak hours.',
 ],
 de: [
 'Der historische Grenzübergangsverkehr präsentiert Zeitreihendaten zum Volumen und Timing der Grenzgänger-Überquerungen an allen wichtigen Tessin-Italien-Grenzübergängen: Chiasso, Como-Monte Olimpino, Ponte Tresa, Stabio, Gaggiolo, Balerna und kleinere Nebenübergänge.',
 'Für Grenzgänger bei der Pendelplanung zeigen die historischen Daten umsetzbare Muster: welche Monate die stärkste Überlastung haben (September, Oktober, Januar bei Schuljahresbeginn), welche Übergänge sich mit Infrastrukturinvestitionen am meisten verbessert haben und wie sich der Gesamtverkehr seit 2020 entwickelt hat.',
 'Der Datensatz stammt von der Schweizerischen Eidgenössischen Zollverwaltung (BAZG) und den italienischen Guardia-di-Finanza-Grenzaufzeichnungen. Diagramme sind vollständig interaktiv: Filtern Sie nach Übergang, Zeitraum und Verkehrstyp.',
 'Die Analyse umfasst Jahresvergleichswachstumsraten, die zeigen, dass der Grenzgängerverkehr an den Tessiner Grenzübergängen seit 2021 jährlich um durchschnittlich 2,3 % gestiegen ist, getrieben durch wirtschaftliche Erholung und neue Beschäftigung im Luganer Finanz- und Biotechsektor. Der Übergang Stabio verzeichnete den grössten Kapazitätszuwachs (+15 %) nach der Spurerweiterung 2024.',
 'Für Pendler, die alternative Verkehrsmittel in Betracht ziehen, vergleicht der Bereich die Grenzübergangszeiten mit Auto, TILO-Regionalzug und Bus. Bahnübergänge am Bahnhof Chiasso und der Linie Mendrisio-Varese bieten vorhersagbare 5-Minuten-Grenzübergangszeiten gegenüber 15-45 Minuten mit dem Auto in Spitzenzeiten.',
 ],
 fr: [
 'La section historique du trafic frontalier présente des données de séries temporelles sur le volume et le calendrier des passages de frontaliers à tous les principaux postes frontaliers Tessin-Italie : Chiasso, Como-Monte Olimpino, Ponte Tresa, Stabio, Gaggiolo, Balerna et les passages secondaires.',
 'Pour les frontaliers planifiant leur trajet, les données historiques révèlent des patterns exploitables : quels mois ont la congestion la plus forte (septembre, octobre, janvier lors de la rentrée scolaire), quels postes se sont le plus améliorés avec les investissements d\'infrastructure.',
 'Le jeu de données provient de l\'Administration fédérale des douanes suisses (BAZG) et des enregistrements de la Guardia di Finanza italienne. Les graphiques sont entièrement interactifs — filtrez par poste, période et type de trafic pour identifier la fenêtre de trajet optimale.',
 'L\'analyse inclut les taux de croissance annuels montrant que le trafic frontalier aux postes tessinois a augmenté en moyenne de 2,3 % par an depuis 2021, porté par la reprise économique et les nouveaux emplois dans les secteurs financier et biotech de Lugano. Le poste de Stabio a connu la plus grande augmentation de capacité (+15 %) après l\'élargissement de voies en 2024.',
 'Pour les pendulaires envisageant des modes de transport alternatifs, la section compare les temps de passage aux frontières en voiture, train régional TILO et bus. Les passages ferroviaires à la gare de Chiasso et la ligne Mendrisio-Varese offrent des temps de transit prévisibles de 5 minutes contre 15-45 minutes en voiture aux heures de pointe.',
 ],
 },

 // ───── Salary statistics comparison ─────────────────────────
 '/statistiche/confronta-stipendi': {
 en: [
 'The salary statistics section compares median and average gross wages across 24 industry sectors in Canton Ticino (CHF) versus the equivalent Italian provinces of Como, Varese, and Verbano-Cusio-Ossola (EUR), converted at current exchange rates to enable direct comparison of purchasing power.',
 'Data is sourced from the Swiss Federal Statistical Office (FSO/BFS) annual wage survey, ISTAT Italian employment statistics, and the SECO Cantonal Labour Market Monitor, providing a statistically robust picture of the cross-border salary differential by role, experience level, and contract type for 2026.',
 'The comparison is designed to support real negotiation decisions: if you are applying for a role in Ticino or planning to renegotiate, knowing the median salary for your sector and experience level in Switzerland versus Italy gives you objective data to back your position. The tool also calculates the net advantage after Swiss social contributions and cantonal withholding tax versus the Italian equivalent after IRPEF.',
 'Salary differences between Ticino and other Swiss cantons are significant: median wages in Ticino are typically 15–20% lower than in Zurich, Basel, or Geneva. However, Ticino remains attractive for Italian cross-border workers because even lower Swiss salaries translate into higher purchasing power in Italy after CHF-EUR conversion. The comparison helps evaluate whether a role in Ticino offers better net value than a higher-paid position in a more expensive Swiss canton.',
 'When interpreting gross-to-net conversion, cross-border workers must account for withholding tax rates that vary substantially by personal circumstances. A single worker (Table A) earning CHF 70,000 in Ticino pays approximately 8–10% withholding tax, while a married worker with two children (Table C2) at the same salary pays only 2–4%. These differences can shift the net advantage by several hundred francs per month, making personal profile data essential for accurate salary comparison.',
 ],
 de: [
 'Die Gehaltsstatistik vergleicht Median- und Durchschnittsbruttogehälter in 24 Branchen im Kanton Tessin (CHF) mit den äquivalenten italienischen Provinzen Como, Varese und Verbano-Cusio-Ossola (EUR), umgerechnet zu aktuellen Wechselkursen für einen direkten Kaufkraftvergleich.',
 'Daten stammen aus der jährlichen BFS-Lohnerhebung, ISTAT-Beschäftigungsstatistiken und dem SECO-Kantonsarbeitsmarktmonitor — eine statistisch robuste Darstellung des grenzüberschreitenden Gehaltsgefälles nach Branche, Erfahrungsstufe und Vertragstyp für 2026.',
 'Der Vergleich unterstützt echte Verhandlungsentscheidungen: Kenntnis des Mediangehalts für Ihren Sektor und Ihre Erfahrungsstufe in der Schweiz versus Italien gibt Ihnen objektive Daten für Gehaltsverhandlungen. Das Tool berechnet auch den Nettovorteil nach Schweizer Sozialabgaben und kantonaler Quellensteuer.',
 'Gehaltsunterschiede zwischen dem Tessin und anderen Schweizer Kantonen sind erheblich: Die Medianlöhne im Tessin liegen typischerweise 15–20 % unter denen in Zürich, Basel oder Genf. Dennoch bleibt das Tessin für italienische Grenzgänger attraktiv, da selbst niedrigere Schweizer Gehälter nach CHF-EUR-Umrechnung eine höhere Kaufkraft in Italien bieten. Der Vergleich hilft einzuschätzen, ob eine Tessiner Stelle einen besseren Nettowert bietet als eine höher bezahlte Position in einem teureren Kanton.',
 'Bei der Interpretation der Brutto-Netto-Umrechnung müssen Grenzgänger die Quellensteuersätze berücksichtigen, die je nach persönlichen Umständen erheblich variieren. Ein lediger Arbeitnehmer (Tabelle A) mit CHF 70.000 zahlt im Tessin etwa 8–10 % Quellensteuer, während ein Verheirateter mit zwei Kindern (Tabelle C2) beim gleichen Gehalt nur 2–4 % zahlt. Diese Unterschiede können den Nettovorteil um mehrere hundert Franken monatlich verschieben.',
 ],
 fr: [
 'La section statistiques salariales compare les salaires bruts médians et moyens dans 24 secteurs d\'activité du Canton du Tessin (CHF) versus les provinces italiennes équivalentes de Côme, Varèse et Verbano-Cusio-Ossola (EUR), convertis au taux de change actuel pour une comparaison directe du pouvoir d\'achat.',
 'Les données proviennent de l\'enquête annuelle sur les salaires de l\'OFS, des statistiques d\'emploi ISTAT et du Moniteur du Marché du Travail Cantonal SECO — une image statistiquement robuste du différentiel salarial transfrontalier par rôle, niveau d\'expérience et type de contrat pour 2026.',
 'La comparaison est conçue pour soutenir de vraies décisions de négociation : connaître le salaire médian pour votre secteur en Suisse versus Italie vous donne des données objectives. L\'outil calcule aussi l\'avantage net après cotisations sociales suisses et impôt à la source cantonal.',
 'Les écarts salariaux entre le Tessin et d\'autres cantons suisses sont significatifs : les salaires médians au Tessin sont typiquement 15–20 % inférieurs à ceux de Zurich, Bâle ou Genève. Pourtant, le Tessin reste attractif pour les frontaliers italiens car même les salaires suisses inférieurs offrent un pouvoir d\'achat supérieur en Italie après conversion CHF-EUR. La comparaison aide à évaluer si un poste au Tessin offre une meilleure valeur nette qu\'un poste mieux rémunéré dans un canton plus cher.',
 'Pour interpréter la conversion brut-net, les frontaliers doivent tenir compte des taux d\'imposition à la source qui varient considérablement selon la situation personnelle. Un travailleur célibataire (barème A) gagnant CHF 70 000 au Tessin paie environ 8–10 % d\'impôt à la source, tandis qu\'un marié avec deux enfants (barème C2) au même salaire ne paie que 2–4 %. Ces différences peuvent décaler l\'avantage net de plusieurs centaines de francs par mois.',
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

 // ───── Calculator: new cross-border workers beyond 20 km ────
 '/calcola-stipendio/nuovi-frontalieri-oltre-20-km': {
 it: [
 'Il <strong>calcolo delle tasse per i frontalieri oltre 20 km</strong> dal confine segue regole diverse rispetto ai frontalieri "storici" o a chi risiede entro 20 km dalla frontiera: si applica il regime della <strong>tassazione concorrente</strong> previsto dal Nuovo Accordo del 17 luglio 2023 tra Italia e Svizzera, in vigore dal 2024.',
 '<strong>Come funziona la tassazione concorrente</strong>: per i nuovi frontalieri residenti in un comune italiano oltre i 20 km dalla frontiera, la Svizzera trattiene il 100% dell\'imposta alla fonte secondo le tabelle del Canton Ticino (niente split 80/20). Poi l\'Italia tassa nuovamente lo stesso reddito secondo l\'IRPEF ordinaria, riconoscendo un credito d\'imposta pari a quanto già pagato in Svizzera per evitare la doppia imposizione. In pratica il frontaliere paga la maggiore tra l\'imposta svizzera e quella italiana.',
 '<strong>Differenza con i vecchi frontalieri (ante 17 luglio 2023)</strong>: i frontalieri "storici" mantengono il regime di tassazione esclusivamente svizzera con rimborso parziale (40% ai comuni italiani di frontiera) fino al pensionamento, indipendentemente dalla distanza dal confine. I nuovi frontalieri oltre 20 km non beneficiano di questo regime e devono presentare la dichiarazione dei redditi italiana ogni anno includendo il reddito svizzero.',
 '<strong>Esempio pratico</strong>: un nuovo frontaliere residente a Como (entro 20 km) con RAL CHF 70.000 e imposta alla fonte TI di circa CHF 8.500 paga in Italia soltanto sull\'80% del reddito imponibile, con credito per l\'imposta svizzera. Lo stesso frontaliere residente a Milano (oltre 20 km) paga prima il 100% dell\'imposta svizzera, poi in Italia ricalcola l\'IRPEF sul 100% del reddito convertito in euro, scalando il credito estero: il carico fiscale finale può risultare superiore di 2.000-4.000 EUR l\'anno, a parità di stipendio lordo.',
 'Il simulatore integra le tabelle A/B/C/H del Canton Ticino 2026, la conversione CHF-EUR al cambio del giorno, l\'<a href="https://frontaliereticino.ch/calcola-stipendio/">IRPEF italiana con addizionali regionali e comunali</a>, e tiene conto di carichi di famiglia, contributi INPS e deduzioni italiane applicabili ai frontalieri. Al termine ricevi un confronto tra il netto disponibile come residente entro 20 km e oltre 20 km, così da valutare con dati reali la scelta della residenza prima dell\'assunzione in Svizzera.',
 ],
 en: [
 'This page is for cross-border workers who started employment in Switzerland after 17 July 2023 and reside in an Italian municipality more than 20 km from the border. Under these conditions, Swiss withholding tax is retained at 100% of the Canton Ticino rate, without the 80%/20% split that applies to workers within the 20 km zone.',
 'The hub compares practical scenarios at three income levels, placing the beyond-20 km case side by side with an identical profile within 20 km. This lets you immediately see whether the real difference lies in monthly net pay, the Italian tax settlement, or the operational simplicity of your annual tax filing.',
 'Related tools are linked directly: net salary simulator, 2025 vs 2026 comparison, income tax return guide, and the 2026 Canton Ticino withholding tax rate tables. The goal is to turn an abstract fiscal rule into a concrete decision about your personal situation.',
 ],
 de: [
 'Diese Seite richtet sich an Grenzgänger, die ihre Beschäftigung in der Schweiz nach dem 17. Juli 2023 aufgenommen haben und in einer italienischen Gemeinde wohnen, die mehr als 20 km von der Grenze entfernt liegt. Unter diesen Bedingungen wird die Schweizer Quellensteuer zu 100 % des Tessiner Satzes einbehalten, ohne die 80/20-Aufteilung, die für Arbeitnehmer innerhalb der 20-km-Zone gilt.',
 'Der Hub vergleicht praxisnahe Szenarien auf drei Einkommensstufen und stellt den Fall jenseits von 20 km einem identischen Profil innerhalb von 20 km gegenüber. So sehen Sie sofort, ob der Unterschied im monatlichen Netto, in der italienischen Steuerabrechnung oder in der operativen Einfachheit der Steuererklärung liegt.',
 'Verknüpfte Tools: Nettosimulator, Vergleich 2025 vs. 2026, Leitfaden zur Steuererklärung und Tessiner Quellensteuertabellen 2026. Ziel ist es, eine abstrakte Steuerregel in eine konkrete Entscheidung für Ihre persönliche Situation zu übersetzen.',
 ],
 fr: [
 'Cette page s\'adresse aux frontaliers ayant commencé leur emploi en Suisse après le 17 juillet 2023 et résidant dans une commune italienne à plus de 20 km de la frontière. Dans ces conditions, l\'impôt à la source suisse est retenu à 100 % du taux tessinois, sans la répartition 80/20 applicable aux travailleurs dans la zone des 20 km.',
 'Le hub compare des scénarios pratiques à trois niveaux de revenus, plaçant le cas au-delà de 20 km en regard d\'un profil identique en deçà de 20 km. Vous voyez immédiatement si la différence réelle porte sur le net mensuel, le solde fiscal en Italie ou la simplicité opérationnelle de la déclaration de revenus.',
 'Les outils associés sont directement liés : simulateur de salaire net, comparaison 2025 vs 2026, guide de la déclaration de revenus et barèmes de l\'impôt à la source du Tessin 2026. L\'objectif est de transformer une règle fiscale abstraite en une décision concrète concernant votre situation personnelle.',
 ],
 },

 // ───── Calculator: RAL vs net salary comparison ─────────────
 '/calcola-stipendio/confronta-retribuzione-ral': {
 en: [
 'The RAL vs net salary comparator converts a gross annual salary (RAL) stated in a Swiss job offer into the actual monthly net pay a cross-border worker receives after all Swiss deductions: AVS/AHV (5.3%), unemployment insurance (1.1%), non-occupational accident insurance, daily sickness benefits, LPP pension, and cantonal withholding tax.',
 'This tool is especially useful during salary negotiations: a RAL of CHF 80,000 can translate into very different monthly net amounts depending on marital status, number of children, canton, and age bracket for LPP contributions. Knowing the expected net before signing lets you make realistic comparisons with equivalent Italian salaries.',
 'The result includes CHF-EUR conversion at the current exchange rate and a side-by-side comparison with the net salary of an equivalent role in Lombardy or Piedmont, factoring in Italian IRPEF, INPS contributions, and regional surcharges, so you can concretely assess the economic advantage of working in Switzerland.',
 'Comparing RAL figures alone between Swiss and Italian offers is insufficient because the two countries have fundamentally different social security systems. Swiss employers contribute additionally to LPP pension (typically 50% employer share), accident insurance, and family allowances on top of the stated RAL. In Italy, employer-side INPS contributions are roughly 30% of gross salary but invisible on the payslip. A thorough comparison must factor in these hidden contributions to assess total compensation accurately.',
 'Total compensation in Switzerland often includes benefits that significantly increase the effective package beyond the headline RAL: the mandatory 13th month salary (standard in most Ticino sectors), employer LPP pension contributions worth 5–9% of salary, Swiss family allowances (CHF 200–300 per child per month), and in some cases meal vouchers or transport subsidies. When comparing a CHF 75,000 Swiss RAL to a EUR 40,000 Italian RAL, the true gap can be 40–60% wider than the gross numbers suggest.',
 ],
 de: [
 'Der RAL-Netto-Vergleicher rechnet ein in einem Schweizer Stellenangebot genanntes Bruttojahresgehalt (RAL) in das tatsächliche monatliche Nettogehalt eines Grenzgängers um, nach allen Schweizer Abzügen: AHV/IV/EO (5,3 %), Arbeitslosenversicherung (1,1 %), Nichtberufsunfallversicherung, Krankentaggeld, BVG-Beiträge und kantonale Quellensteuer.',
 'Dieses Tool ist besonders nützlich bei Gehaltsverhandlungen: Eine RAL von CHF 80.000 kann je nach Familienstand, Kinderzahl, Kanton und Altersgruppe für die BVG-Beiträge zu sehr unterschiedlichen monatlichen Nettobeträgen führen. Das erwartete Netto vor Vertragsunterzeichnung zu kennen, ermöglicht realistische Vergleiche mit italienischen Gehältern.',
 'Das Ergebnis enthält die CHF-EUR-Umrechnung zum aktuellen Wechselkurs und einen direkten Vergleich mit dem Nettogehalt einer gleichwertigen Stelle in der Lombardei oder im Piemont unter Berücksichtigung der italienischen IRPEF, INPS-Beiträge und Regionalzuschläge.',
 'Ein reiner RAL-Vergleich zwischen Schweizer und italienischen Angeboten reicht nicht aus, da beide Länder grundlegend verschiedene Sozialsysteme haben. Schweizer Arbeitgeber zahlen zusätzlich BVG-Beiträge (typisch 50 % Arbeitgeberanteil), Unfallversicherung und Familienzulagen über die angegebene RAL hinaus. In Italien betragen die arbeitgeberseitigen INPS-Beiträge ca. 30 % des Bruttolohns, sind aber auf der Lohnabrechnung unsichtbar. Ein gründlicher Vergleich muss diese versteckten Beiträge einbeziehen.',
 'Die Gesamtvergütung in der Schweiz umfasst oft Leistungen, die das effektive Paket über die Headline-RAL hinaus deutlich erhöhen: der obligatorische 13. Monatslohn (Standard in den meisten Tessiner Branchen), BVG-Arbeitgeberbeiträge von 5–9 % des Gehalts, Schweizer Familienzulagen (CHF 200–300 pro Kind und Monat) und teils Essensgutscheine oder Transportzuschüsse. Beim Vergleich einer Schweizer RAL von CHF 75.000 mit einer italienischen RAL von EUR 40.000 kann die tatsächliche Lücke 40–60 % grösser sein als die Bruttozahlen vermuten lassen.',
 ],
 fr: [
 'Le comparateur RAL vs net convertit un salaire brut annuel (RAL) mentionné dans une offre d\'emploi suisse en salaire net mensuel réel perçu par un frontalier après toutes les déductions suisses : AVS/AI/APG (5,3 %), assurance chômage (1,1 %), assurance accidents non professionnels, indemnités journalières maladie, LPP et impôt à la source cantonal.',
 'Cet outil est particulièrement utile lors des négociations salariales : une RAL de CHF 80 000 peut donner des nets mensuels très différents selon l\'état civil, le nombre d\'enfants, le canton et la tranche d\'âge pour la LPP. Connaître le net attendu avant de signer permet des comparaisons réalistes avec les salaires italiens.',
 'Le résultat inclut la conversion CHF-EUR au taux de change actuel et une comparaison directe avec le salaire net d\'un poste équivalent en Lombardie ou au Piémont, tenant compte de l\'IRPEF italienne, des cotisations INPS et des surtaxes régionales.',
 'Comparer les RAL seules entre offres suisses et italiennes est insuffisant car les deux pays ont des systèmes de sécurité sociale fondamentalement différents. Les employeurs suisses cotisent en plus à la LPP (typiquement 50 % part employeur), à l\'assurance accidents et aux allocations familiales au-delà de la RAL affichée. En Italie, les cotisations patronales INPS représentent environ 30 % du brut mais sont invisibles sur la fiche de paie. Une comparaison rigoureuse doit intégrer ces cotisations cachées.',
 'La rémunération totale en Suisse inclut souvent des avantages qui augmentent significativement le package au-delà de la RAL affichée : le 13e mois obligatoire (standard dans la plupart des secteurs tessinois), les cotisations LPP employeur de 5–9 % du salaire, les allocations familiales suisses (CHF 200–300 par enfant par mois) et parfois des chèques repas ou des indemnités de transport. En comparant une RAL suisse de CHF 75 000 à une RAL italienne de EUR 40 000, l\'écart réel peut être 40–60 % plus large que ne le suggèrent les chiffres bruts.',
 ],
 },

 // ───── Calculator: cross-border worker bonus estimate ───────
 '/calcola-stipendio/stima-bonus-frontaliere': {
 it: [
 'Lo stimatore dei bonus frontalieri calcola le prestazioni aggiuntive previste dalla legislazione italiana e svizzera per le famiglie dei lavoratori transfrontalieri. Include gli assegni familiari svizzeri (Familienzulagen), le deduzioni per figli dall\'imposta alla fonte cantonale e l\'Assegno Unico e Universale italiano (AUU) introdotto nel 2022 dall\'INPS.',
 'Per i frontalieri, il diritto ai bonus dipende dal paese di residenza e dalla tipologia di prestazione. Gli assegni familiari svizzeri vengono erogati dal datore di lavoro svizzero indipendentemente dalla residenza italiana del lavoratore: in Ticino ammontano a CHF 200 per figlio al mese (fino a 16 anni) e CHF 250 per figli in formazione (fino a 25 anni).',
 'L\'Assegno Unico Universale italiano è subordinato alla presentazione dell\'ISEE ed è erogato dall\'INPS su domanda separata. Per i frontalieri residenti in Italia con figli a carico, l\'AUU può integrare significativamente il reddito familiare: l\'importo base nel 2026 varia da 57 a 199,40 EUR al mese per figlio minorenne, in funzione della fascia ISEE del nucleo.',
 'La tredicesima mensilità è obbligatoria in Svizzera nei settori coperti da contratto collettivo di lavoro (CCL). In Ticino, la maggior parte dei settori — industria, costruzioni, commercio, ospitalità — prevede la tredicesima, che equivale a un dodicesimo del salario annuo lordo. Alcune aziende offrono anche gratifiche discrezionali o bonus legati ai risultati, soggetti alle stesse deduzioni sociali dello stipendio ordinario.',
 'Lo stimatore mostra il valore combinato mensile e annuale di tutti i bonus e le deduzioni applicabili al nucleo familiare. Il calcolo integra le prestazioni svizzere e italiane per determinare il reddito disponibile reale della famiglia frontaliera, aiutando a ottimizzare la posizione fiscale tra i due paesi e a valutare l\'impatto economico della composizione familiare sulla busta paga.',
 ],
 en: [
 'The cross-border worker bonus estimator calculates the additional benefits available under Italian and Swiss law: family allowances (assegni familiari), child deductions from withholding tax, and Italian bonus figli under the Assegno Unico e Universale (AUU) programme introduced in 2022.',
 'For frontalieri, bonus eligibility depends on the country of residence and the type of benefit: Swiss family allowances are paid by the Swiss employer regardless of Italian residence, while Italian AUU is means-tested using ISEE and requires a separate INPS application.',
 'In Canton Ticino, Swiss family allowances amount to CHF 200 per child per month (up to age 16) and CHF 250 for children in education (up to age 25). These allowances are not subject to withholding tax and are paid on top of net salary, representing a significant supplement for families with multiple children.',
 'The 13th month salary (tredicesima) is mandatory in Switzerland for sectors covered by a collective labour agreement (CCL/GAV). In Ticino, most industries — manufacturing, construction, retail, hospitality — include the 13th month. Some employers also offer discretionary bonuses or performance-linked gratifiche, subject to the same social deductions as regular salary.',
 'The estimator shows the combined monthly and annual value of all applicable bonuses and deductions, helping families optimise their fiscal position across both countries. By integrating Swiss allowances, Italian AUU, child-related tax deductions, and the 13th month, the tool provides a comprehensive view of total family income for cross-border households.',
 ],
 de: [
 'Der Grenzgänger-Bonus-Rechner berechnet die zusätzlichen Leistungen nach italienischem und schweizerischem Recht: Familienzulagen, Kinderabzüge bei der Quellensteuer und den italienischen Bonus Figli im Rahmen des Programms Assegno Unico e Universale (AUU), das 2022 eingeführt wurde.',
 'Für Grenzgänger hängt der Bonusanspruch vom Wohnsitzland und der Art der Leistung ab: Schweizer Familienzulagen werden unabhängig vom italienischen Wohnsitz vom Schweizer Arbeitgeber gezahlt, während der italienische AUU einkommensabhängig (ISEE) ist und einen separaten INPS-Antrag erfordert.',
 'Im Kanton Tessin betragen die Schweizer Familienzulagen CHF 200 pro Kind und Monat (bis 16 Jahre) und CHF 250 für Kinder in Ausbildung (bis 25 Jahre). Diese Zulagen unterliegen nicht der Quellensteuer und werden zusätzlich zum Nettogehalt ausgezahlt — eine erhebliche Ergänzung für Familien mit mehreren Kindern.',
 'Der 13. Monatslohn ist in der Schweiz in Branchen mit Gesamtarbeitsvertrag (GAV) obligatorisch. Im Tessin umfasst dies die meisten Sektoren — Industrie, Bau, Handel, Gastgewerbe. Einige Arbeitgeber bieten zusätzlich Ermessensboni oder leistungsgebundene Gratifikationen an, die denselben Sozialabzügen wie das reguläre Gehalt unterliegen.',
 'Der Rechner zeigt den kombinierten monatlichen und jährlichen Wert aller anwendbaren Boni und Abzüge. Durch die Integration von Schweizer Zulagen, italienischem AUU, kindbezogenen Steuerabzügen und dem 13. Monatslohn bietet das Tool einen umfassenden Überblick über das Gesamtfamilieneinkommen grenzüberschreitender Haushalte.',
 ],
 fr: [
 'L\'estimateur de bonus frontalier calcule les prestations supplémentaires disponibles en droit italien et suisse : allocations familiales, déductions pour enfants de l\'impôt à la source et le bonus figli italien dans le cadre du programme Assegno Unico e Universale (AUU) introduit en 2022.',
 'Pour les frontaliers, l\'éligibilité aux bonus dépend du pays de résidence et du type de prestation : les allocations familiales suisses sont versées par l\'employeur suisse indépendamment de la résidence italienne, tandis que l\'AUU italien est soumis à conditions de ressources (ISEE) et nécessite une demande INPS séparée.',
 'Au Canton du Tessin, les allocations familiales suisses s\'élèvent à CHF 200 par enfant et par mois (jusqu\'à 16 ans) et CHF 250 pour les enfants en formation (jusqu\'à 25 ans). Ces allocations ne sont pas soumises à l\'impôt à la source et s\'ajoutent au salaire net — un complément significatif pour les familles avec plusieurs enfants.',
 'Le 13e mois est obligatoire en Suisse dans les secteurs couverts par une convention collective de travail (CCT). Au Tessin, la plupart des secteurs — industrie, construction, commerce, hôtellerie — incluent le 13e mois. Certains employeurs proposent également des gratifications discrétionnaires ou des bonus liés aux résultats, soumis aux mêmes déductions sociales que le salaire ordinaire.',
 'L\'estimateur affiche la valeur mensuelle et annuelle combinée de tous les bonus et déductions applicables. En intégrant les allocations suisses, l\'AUU italien, les déductions fiscales pour enfants et le 13e mois, l\'outil fournit une vue complète du revenu familial total pour les ménages frontaliers.',
 ],
 },

 // ───── Calculator: parental leave check ─────────────────────
 '/calcola-stipendio/verifica-congedo-parentale': {
 it: [
 'Il verificatore del congedo parentale aiuta i frontalieri a comprendere i propri diritti secondo la legislazione svizzera e italiana. La Svizzera prevede 14 settimane di congedo maternità retribuite all\'80 % del salario attraverso l\'assicurazione per perdita di guadagno (IPG/EO), e 2 settimane di congedo paternità introdotto nel 2021 con le stesse condizioni economiche.',
 'L\'Italia offre protezioni aggiuntive: 5 mesi di congedo maternità obbligatorio retribuito dall\'INPS all\'80 % e un congedo parentale facoltativo fino a 11 mesi complessivi per nucleo familiare. Per il congedo facoltativo, l\'indennità è pari al 30 % della retribuzione per un massimo di 6 mesi, con un mese aggiuntivo all\'80 % introdotto dalla Legge di Bilancio 2024.',
 'Per i lavoratori frontalieri, il coordinamento tra i sistemi previdenziali svizzero e italiano determina quale paese eroga la prestazione. Se si è impiegati in Svizzera e residenti in Italia, l\'IPG svizzera copre il periodo obbligatorio di maternità e paternità. Il congedo parentale facoltativo italiano può essere richiesto all\'INPS in base alle regole di coordinamento bilaterale.',
 'Lo strumento calcola l\'impatto finanziario di ogni opzione di congedo sulla busta paga svizzera e sulla dichiarazione dei redditi italiana. Durante il congedo maternità svizzero, l\'indennità IPG è soggetta ai contributi AVS/AI/IPG ma è esente dall\'imposta alla fonte. Al rientro, il salario riprende integralmente senza alcuna penalizzazione contrattuale.',
 'Il verificatore chiarisce le scadenze da rispettare: la comunicazione al datore di lavoro svizzero deve avvenire almeno 3 mesi prima del parto, la domanda IPG va presentata entro 5 anni, e la richiesta di congedo parentale italiano all\'INPS richiede il modello SR23 compilato con i dati del rapporto di lavoro estero. La documentazione necessaria include il certificato di nascita, il contratto di lavoro e la conferma del datore di lavoro svizzero.',
 ],
 en: [
 'The parental leave checker helps cross-border workers understand their entitlements under both Swiss and Italian law. Switzerland provides 14 weeks of maternity leave at 80% salary (APG/EO insurance) and 2 weeks of paternity leave introduced in 2021 under the same conditions.',
 'Italy offers additional protections: 5 months of mandatory maternity leave paid by INPS at 80%, and optional parental leave of up to 11 months per family. For optional leave, the benefit is 30% of salary for up to 6 months, with an additional month at 80% introduced by the 2024 Budget Law.',
 'For cross-border workers, the coordination between Swiss and Italian social security systems determines which country pays the benefit. If employed in Switzerland and residing in Italy, Swiss APG covers the mandatory maternity and paternity period, while additional Italian parental leave may be available through INPS under bilateral coordination rules.',
 'The tool calculates the financial impact of each leave option on your Swiss payslip and Italian tax return. During Swiss maternity leave, APG benefits are subject to AVS/AI/APG contributions but exempt from withholding tax. Upon return, salary resumes in full with no contractual penalty.',
 'The checker clarifies deadlines: notification to the Swiss employer must be at least 3 months before the expected delivery date, the APG claim must be filed within 5 years, and the Italian parental leave application to INPS requires form SR23 with details of the foreign employment. Required documentation includes the birth certificate, employment contract, and confirmation from the Swiss employer.',
 ],
 de: [
 'Der Elternurlaub-Checker hilft Grenzgängern, ihre Ansprüche nach schweizerischem und italienischem Recht zu verstehen. Die Schweiz gewährt 14 Wochen Mutterschaftsurlaub bei 80 % Lohn (EO-Versicherung) und 2 Wochen Vaterschaftsurlaub, eingeführt 2021 unter denselben Bedingungen.',
 'Italien bietet zusätzlichen Schutz: 5 Monate obligatorischen Mutterschaftsurlaub (INPS, 80 %) und fakultativen Elternurlaub bis zu 11 Monate pro Familie. Für den fakultativen Urlaub beträgt die Entschädigung 30 % des Gehalts für maximal 6 Monate, mit einem zusätzlichen Monat bei 80 % gemäss dem Haushaltsgesetz 2024.',
 'Für Grenzgänger bestimmt die Koordination zwischen den schweizerischen und italienischen Sozialversicherungssystemen, welches Land die Leistung zahlt. Bei Beschäftigung in der Schweiz und Wohnsitz in Italien deckt die Schweizer EO die Pflichtzeit ab, während zusätzlicher italienischer Elternurlaub über INPS im Rahmen bilateraler Koordinationsregeln verfügbar sein kann.',
 'Das Tool berechnet die finanziellen Auswirkungen jeder Urlaubsoption auf die Schweizer Lohnabrechnung und die italienische Steuererklärung. Während des Schweizer Mutterschaftsurlaubs unterliegt die EO-Entschädigung den AHV/IV/EO-Beiträgen, ist aber von der Quellensteuer befreit. Bei Rückkehr wird das Gehalt vollständig ohne vertragliche Einbussen wieder aufgenommen.',
 'Der Checker klärt die einzuhaltenden Fristen: Mitteilung an den Schweizer Arbeitgeber mindestens 3 Monate vor der Geburt, EO-Antrag innerhalb von 5 Jahren, und italienischer Elternurlaubsantrag bei INPS mit Formular SR23 und Details des ausländischen Arbeitsverhältnisses. Erforderliche Unterlagen umfassen Geburtsurkunde, Arbeitsvertrag und Bestätigung des Schweizer Arbeitgebers.',
 ],
 fr: [
 'Le vérificateur de congé parental aide les frontaliers à comprendre leurs droits selon le droit suisse et italien. La Suisse accorde 14 semaines de congé maternité à 80 % du salaire (assurance APG/allocations perte de gain) et 2 semaines de congé paternité introduit en 2021 aux mêmes conditions.',
 'L\'Italie offre des protections supplémentaires : 5 mois de congé maternité obligatoire payé par l\'INPS à 80 %, et un congé parental facultatif jusqu\'à 11 mois par famille. Pour le congé facultatif, l\'indemnité est de 30 % du salaire pour 6 mois maximum, avec un mois supplémentaire à 80 % introduit par la loi de finances 2024.',
 'Pour les frontaliers, la coordination entre les systèmes de sécurité sociale suisse et italien détermine quel pays verse la prestation. En cas d\'emploi en Suisse et de résidence en Italie, l\'APG suisse couvre la période obligatoire de maternité et paternité, tandis que le congé parental italien supplémentaire peut être disponible via l\'INPS selon les règles de coordination bilatérale.',
 'L\'outil calcule l\'impact financier de chaque option de congé sur votre fiche de paie suisse et votre déclaration fiscale italienne. Pendant le congé maternité suisse, les indemnités APG sont soumises aux cotisations AVS/AI/APG mais exonérées de l\'impôt à la source. Au retour, le salaire reprend intégralement sans pénalité contractuelle.',
 'Le vérificateur précise les délais à respecter : notification à l\'employeur suisse au moins 3 mois avant l\'accouchement, demande APG à déposer dans les 5 ans, et demande de congé parental italien auprès de l\'INPS via le formulaire SR23 avec les détails de l\'emploi étranger. Les documents requis comprennent l\'acte de naissance, le contrat de travail et la confirmation de l\'employeur suisse.',
 ],
 },

 // ───── Calculator: residence change simulation ──────────────
 '/calcola-stipendio/simula-cambio-residenza': {
 it: [
 'Il simulatore di cambio residenza modella l\'impatto finanziario di un trasferimento tra comuni italiani oppure dall\'Italia alla Svizzera, con passaggio dal permesso G al permesso B. Per ogni scenario ricalcola lo stipendio netto, la tassazione complessiva, le addizionali comunali e regionali, e gli obblighi contributivi in entrambi i paesi.',
 'Le variabili chiave includono la soglia dei 20 km dalla frontiera svizzera, che determina il regime fiscale applicabile (vecchio vs nuovo frontaliere). I comuni entro 20 km beneficiano della ripartizione 80/20 dell\'imposta alla fonte per i nuovi frontalieri, mentre quelli oltre 20 km subiscono la tassazione integrale in Svizzera più l\'IRPEF italiana senza riduzione.',
 'Le addizionali IRPEF comunali e regionali variano significativamente tra le province italiane di confine. Ad esempio, l\'addizionale regionale lombarda può raggiungere l\'1,73 % per i redditi più elevati, mentre il Piemonte applica aliquote fino all\'1,62 %. Le addizionali comunali aggiungono un ulteriore 0,1–0,8 % a seconda del Comune di residenza.',
 'Il simulatore integra anche il differenziale del costo della vita tra residenza italiana e svizzera. Gli affitti in Ticino sono 2-3 volte superiori rispetto alle province di Como e Varese, la spesa alimentare costa il 35-50 % in più, e l\'assicurazione malattia LAMal come residente svizzero ha premi più elevati rispetto all\'opzione LAMal frontaliere.',
 'Lo strumento risponde alla domanda cruciale: trasferirsi più vicino o più lontano dal confine, oppure traslocare direttamente in Svizzera, genera un guadagno finanziario netto dopo aver contabilizzato affitto, tasse, costi di pendolarismo, assistenza sanitaria e spese quotidiane? Il confronto viene mostrato su base mensile e annuale con il dettaglio di ogni voce di costo.',
 ],
 en: [
 'The residence change simulator models the financial impact of moving between Italian municipalities or from Italy to Switzerland (switching from G permit to B permit). It recalculates net salary, taxation, municipal surcharges, and social contribution obligations under each scenario.',
 'Key variables include the 20 km border zone threshold (determining old vs new frontaliere tax regime), Italian municipal and regional IRPEF surcharges (which vary significantly between provinces), and the full cost-of-living differential between Italian and Swiss residence.',
 'Italian IRPEF surcharges vary substantially across border provinces. For example, the Lombardy regional surcharge can reach 1.73% for higher incomes, while Piedmont applies rates up to 1.62%. Municipal surcharges add an additional 0.1–0.8% depending on the specific commune.',
 'The simulator also factors in the cost-of-living differential between Italian and Swiss residence. Rents in Ticino are 2-3 times higher than in the provinces of Como and Varese, grocery costs are 35-50% more expensive, and LAMal health insurance as a Swiss resident carries higher premiums than the frontalier LAMal option.',
 'The simulator helps you answer the critical question: does moving closer to or further from the border, or relocating to Switzerland entirely, result in a net financial gain after accounting for rent, taxes, commute costs, healthcare, and daily expenses? The comparison is shown on a monthly and annual basis with a detailed breakdown of each cost item.',
 ],
 de: [
 'Der Wohnsitzwechsel-Simulator modelliert die finanziellen Auswirkungen eines Umzugs zwischen italienischen Gemeinden oder von Italien in die Schweiz (Wechsel von Ausweis G zu Ausweis B). Er berechnet Nettogehalt, Besteuerung, Gemeindezuschläge und Sozialversicherungspflichten für jedes Szenario neu.',
 'Schlüsselvariablen umfassen die 20-km-Grenzzone (Alt- vs. Neu-Grenzgänger-Steuerregime), italienische Gemeinde- und Regional-IRPEF-Zuschläge (die zwischen Provinzen erheblich variieren) und das Lebenshaltungskostengefälle zwischen italienischem und schweizerischem Wohnsitz.',
 'Die italienischen IRPEF-Zuschläge unterscheiden sich erheblich zwischen den Grenzprovinzen. Der regionale Zuschlag der Lombardei kann bei höheren Einkommen 1,73 % erreichen, während das Piemont Sätze bis 1,62 % anwendet. Gemeindezuschläge addieren je nach Wohnort weitere 0,1–0,8 %.',
 'Der Simulator berücksichtigt auch das Lebenshaltungskostengefälle: Mieten im Tessin sind 2-3 Mal höher als in den Provinzen Como und Varese, Lebensmittel kosten 35-50 % mehr, und die KVG-Prämie als Schweizer Einwohner ist höher als die Grenzgänger-Option.',
 'Der Simulator beantwortet die entscheidende Frage: Führt ein Umzug näher an die oder weiter weg von der Grenze — oder der vollständige Umzug in die Schweiz — nach Berücksichtigung von Miete, Steuern, Pendelkosten, Gesundheitsversorgung und Alltagsausgaben zu einem finanziellen Nettovorteil?',
 ],
 fr: [
 'Le simulateur de changement de résidence modélise l\'impact financier d\'un déménagement entre communes italiennes ou d\'Italie vers la Suisse (passage du permis G au permis B). Il recalcule le salaire net, la fiscalité, les surtaxes communales et les obligations de cotisation sociale pour chaque scénario.',
 'Les variables clés incluent le seuil de la zone frontalière de 20 km (régime fiscal ancien vs nouveau), les surtaxes IRPEF communales et régionales italiennes (qui varient significativement entre provinces) et le différentiel complet du coût de la vie entre résidence italienne et suisse.',
 'Les surtaxes IRPEF italiennes varient considérablement entre les provinces frontalières. Par exemple, la surtaxe régionale lombarde peut atteindre 1,73 % pour les revenus élevés, tandis que le Piémont applique des taux allant jusqu\'à 1,62 %. Les surtaxes communales ajoutent 0,1–0,8 % selon la commune.',
 'Le simulateur intègre aussi le différentiel du coût de la vie : les loyers au Tessin sont 2-3 fois plus élevés que dans les provinces de Côme et Varèse, les courses alimentaires coûtent 35-50 % de plus, et les primes LAMal en tant que résident suisse sont plus élevées que l\'option LAMal frontalier.',
 'Le simulateur répond à la question cruciale : un déménagement plus proche ou plus loin de la frontière — ou une relocalisation complète en Suisse — aboutit-il à un gain financier net après prise en compte du loyer, des impôts, des frais de trajet, des soins de santé et des dépenses quotidiennes ?',
 ],
 },

 // ───── Calculator: what would you earn in Switzerland ────────
 '/calcola-stipendio/quanto-guadagneresti-in-svizzera': {
 it: [
 'Questo strumento stima quanto guadagneresti se accettassi un ruolo equivalente al tuo attuale impiego italiano nel Canton Ticino svizzero. Utilizza dati salariali settoriali dell\'Ufficio federale di statistica (UST/BFS) e applica l\'intera catena di deduzioni svizzere: AVS/AI/IPG, assicurazione contro la disoccupazione, infortuni non professionali, LPP e imposta alla fonte cantonale ticinese.',
 'La stima tiene conto del contesto transfrontaliero: se pendolaresti dall\'Italia, si applica il regime fiscale del permesso G con imposta alla fonte; se ti trasferissi in Svizzera, si applica la tassazione ordinaria del permesso B. Entrambi gli scenari vengono mostrati affiancati per un confronto diretto e immediato.',
 'I dati di riferimento provengono dalla rilevazione strutturale dei salari (RLSS) dell\'UST, che copre oltre 35.000 aziende svizzere. Per il Canton Ticino, le retribuzioni mediane per settore sono inferiori del 10-15 % rispetto alla media nazionale svizzera, ma restano significativamente superiori a quelle lombarde e piemontesi.',
 'Il convertitore integrato trasforma il risultato in euro al tasso di cambio corrente, permettendo un confronto diretto con la retribuzione attuale in Italia. A parità di ruolo, il differenziale lordo tra Ticino e Lombardia oscilla mediamente tra il 40 % e il 60 %, ma il differenziale netto si riduce significativamente dopo deduzioni, imposta alla fonte e costi di pendolarismo.',
 'Utilizza questo strumento prima di colloqui di lavoro o trattative salariali per stabilire un\'aspettativa realistica del netto svizzero nel tuo settore e al tuo livello di esperienza. Il risultato include il dettaglio di ogni deduzione e la conversione in euro, così da negoziare con cognizione di causa.',
 ],
 en: [
 'This tool estimates what your current Italian salary would translate to if you took an equivalent role in Swiss Canton Ticino. It uses sector-specific salary data from the Federal Statistical Office (BFS) and applies the full Swiss deduction chain: AVS/AHV, unemployment, accident insurance, LPP pension, and Canton Ticino withholding tax.',
 'The estimate accounts for the cross-border context: if you would commute from Italy, the G permit withholding tax regime applies; if you would relocate to Switzerland, the B permit ordinary taxation applies. Both scenarios are shown side by side for immediate comparison.',
 'Reference data comes from the Swiss Earnings Structure Survey (SESS) by the BFS, covering over 35,000 Swiss companies. For Canton Ticino, median salaries by sector are 10-15% below the Swiss national average but remain significantly higher than those in Lombardy and Piedmont.',
 'The built-in converter translates the result into euros at the current exchange rate for direct comparison with your Italian compensation. For equivalent roles, the gross differential between Ticino and Lombardy averages 40-60%, but the net differential narrows considerably after deductions, withholding tax, and commuting costs.',
 'Use this tool before job interviews or salary negotiations to establish a realistic expectation of Swiss net pay in your sector and at your experience level. The result includes a breakdown of every deduction, converted to euros for direct comparison.',
 ],
 de: [
 'Dieses Tool schätzt, was Ihr aktuelles italienisches Gehalt bedeuten würde, wenn Sie eine gleichwertige Stelle im Schweizer Kanton Tessin annehmen würden. Es verwendet branchenspezifische Gehaltsdaten des Bundesamts für Statistik (BFS) und wendet die vollständige Schweizer Abzugskette an: AHV/IV/EO, Arbeitslosenversicherung, Unfallversicherung, BVG und Tessiner Quellensteuer.',
 'Die Schätzung berücksichtigt den Grenzgängerkontext: Bei Pendeln aus Italien gilt das Quellensteuerregime des Ausweises G; bei Umzug in die Schweiz die ordentliche Besteuerung des Ausweises B. Beide Szenarien werden nebeneinander für einen direkten Vergleich dargestellt.',
 'Die Referenzdaten stammen aus der Schweizerischen Lohnstrukturerhebung (LSE) des BFS mit über 35.000 Schweizer Unternehmen. Im Kanton Tessin liegen die Medianlöhne nach Branche 10-15 % unter dem Schweizer Durchschnitt, aber deutlich über den Werten in der Lombardei und im Piemont.',
 'Der integrierte Umrechner übersetzt das Ergebnis zum aktuellen Wechselkurs in Euro für einen direkten Vergleich mit der italienischen Vergütung. Bei gleichwertigen Stellen beträgt das Bruttodifferenzial zwischen Tessin und Lombardei durchschnittlich 40-60 %, das Nettodifferenzial verringert sich nach Abzügen, Quellensteuer und Pendelkosten deutlich.',
 'Nutzen Sie dieses Tool vor Vorstellungsgesprächen oder Gehaltsverhandlungen, um eine realistische Erwartung an das Schweizer Nettogehalt in Ihrem Sektor zu ermitteln. Das Ergebnis enthält eine Aufschlüsselung jedes Abzugs, umgerechnet in Euro zum direkten Vergleich.',
 ],
 fr: [
 'Cet outil estime ce que votre salaire italien actuel représenterait si vous acceptiez un poste équivalent dans le Canton du Tessin. Il utilise des données salariales sectorielles de l\'Office fédéral de la statistique (OFS) et applique la chaîne complète de déductions suisses : AVS/AI/APG, chômage, assurance accidents, LPP et impôt à la source tessinois.',
 'L\'estimation tient compte du contexte frontalier : en cas de pendularité depuis l\'Italie, le régime d\'impôt à la source du permis G s\'applique ; en cas de relocalisation en Suisse, la taxation ordinaire du permis B s\'applique. Les deux scénarios sont présentés côte à côte pour une comparaison immédiate.',
 'Les données de référence proviennent de l\'Enquête suisse sur la structure des salaires (ESS) de l\'OFS, couvrant plus de 35 000 entreprises suisses. Au Canton du Tessin, les salaires médians par secteur sont inférieurs de 10-15 % à la moyenne nationale suisse mais restent nettement supérieurs à ceux de Lombardie et du Piémont.',
 'Le convertisseur intégré traduit le résultat en euros au taux de change actuel pour une comparaison directe avec votre rémunération italienne. Pour des postes équivalents, le différentiel brut entre le Tessin et la Lombardie oscille entre 40 et 60 %, mais le différentiel net se réduit considérablement après déductions, impôt à la source et frais de trajet.',
 'Utilisez cet outil avant les entretiens ou négociations salariales pour établir une attente réaliste du salaire net suisse dans votre secteur. Le résultat détaille chaque déduction, converti en euros pour une comparaison directe.',
 ],
 },

 // ───── Calculator: 2025 vs 2026 net salary comparison ───────
 '/calcola-stipendio/confronto-netto-2025-2026': {
 it: [
 'Il confronto netto 2025 vs 2026 mostra come la fase transitoria del Nuovo Accordo Fiscale tra Italia e Svizzera influisce sulla busta paga dei frontalieri. Con l\'assunzione progressiva della tassazione concorrente da parte dell\'Italia, la quota di imposta alla fonte trattenuta dalla Svizzera cambia, modificando il calcolo del netto per i lavoratori transfrontalieri.',
 'Il confronto copre sia lo scenario dei residenti entro 20 km dal confine sia quello dei residenti oltre 20 km, evidenziando le variazioni specifiche di aliquota e franchigia che differiscono tra le due zone. Per i nuovi frontalieri entro 20 km, la Svizzera trattiene l\'80 % dell\'imposta alla fonte; per quelli oltre 20 km, il 100 %.',
 'Ogni scenario mostra le differenze nette mese per mese, così da pianificare il budget familiare con precisione. La variazione annuale tra 2025 e 2026 dipende principalmente dall\'aggiornamento delle tabelle cantonali dell\'imposta alla fonte e dall\'eventuale variazione delle aliquote IRPEF e delle addizionali regionali e comunali italiane.',
 'Per i vecchi frontalieri (assunti prima del 17 luglio 2023 e residenti entro 20 km), il regime resta invariato: tassazione esclusiva in Svizzera senza obbligo IRPEF. Il confronto mostra comunque le differenze dovute all\'aggiornamento delle tabelle cantonali 2026 e alle eventuali variazioni dei contributi sociali obbligatori.',
 'Utilizza questo strumento per capire se il tuo netto aumenterà o diminuirà nel 2026 e di quanto, così da adeguare proattivamente la pianificazione finanziaria, i versamenti al terzo pilastro e la strategia di dichiarazione dei redditi.',
 ],
 en: [
 'The 2025 vs 2026 net salary comparison shows how the transitional phase of the New Fiscal Agreement between Switzerland and Italy affects your take-home pay. As Italy progressively assumes concurrent taxation, the withholding tax share retained by Switzerland changes, altering the net calculation for cross-border workers.',
 'The comparison covers both the within-20 km and beyond-20 km scenarios, highlighting the specific rate changes and franchise adjustments that differ between the two zones. For new frontalieri within 20 km, Switzerland retains 80% of withholding tax; beyond 20 km, the full 100%.',
 'Each scenario shows month-by-month net differences to help you plan household budgets precisely. The annual variation between 2025 and 2026 depends mainly on updates to the cantonal withholding tax tables and any changes to Italian IRPEF rates and regional/municipal surcharges.',
 'For old frontalieri (hired before 17 July 2023, residing within 20 km), the regime remains unchanged: exclusive taxation in Switzerland with no IRPEF obligation. The comparison still shows differences due to updated 2026 cantonal tables and any changes to mandatory social contributions.',
 'Use this tool to understand whether your net salary will increase or decrease in 2026 and by how much, so you can proactively adjust financial planning, third-pillar contributions, and tax return strategy.',
 ],
 de: [
 'Der Nettovergleich 2025 vs. 2026 zeigt, wie die Übergangsphase des Neuen Steuerabkommens zwischen der Schweiz und Italien Ihr Nettogehalt beeinflusst. Da Italien schrittweise die konkurrierende Besteuerung übernimmt, ändert sich der von der Schweiz einbehaltene Quellensteueranteil.',
 'Der Vergleich deckt sowohl Szenarien innerhalb als auch jenseits der 20-km-Zone ab und hebt die spezifischen Satzänderungen und Franchise-Anpassungen hervor. Für neue Grenzgänger innerhalb von 20 km behält die Schweiz 80 % der Quellensteuer ein; jenseits von 20 km die vollen 100 %.',
 'Jedes Szenario zeigt monatliche Nettodifferenzen zur präzisen Haushaltsplanung. Die jährliche Veränderung zwischen 2025 und 2026 hängt hauptsächlich von Aktualisierungen der kantonalen Quellensteuertabellen und etwaigen Änderungen der italienischen IRPEF-Sätze ab.',
 'Für alte Grenzgänger (vor dem 17. Juli 2023 angestellt, innerhalb von 20 km wohnhaft) bleibt das Regime unverändert: ausschliessliche Besteuerung in der Schweiz ohne IRPEF-Pflicht. Der Vergleich zeigt dennoch Unterschiede durch aktualisierte kantonale Tabellen 2026.',
 'Nutzen Sie dieses Tool, um zu verstehen, ob Ihr Nettogehalt 2026 steigt oder sinkt und um wie viel — damit Sie Finanzplanung, Dritte-Säule-Einzahlungen und Steuerstrategie proaktiv anpassen können.',
 ],
 fr: [
 'La comparaison du salaire net 2025 vs 2026 montre comment la phase transitoire du Nouvel Accord Fiscal entre la Suisse et l\'Italie affecte votre salaire net. À mesure que l\'Italie assume progressivement la taxation concurrente, la part d\'impôt à la source retenue par la Suisse change.',
 'La comparaison couvre les scénarios en deçà et au-delà de 20 km, mettant en évidence les changements de taux et ajustements de franchise spécifiques. Pour les nouveaux frontaliers dans les 20 km, la Suisse retient 80 % de l\'impôt à la source ; au-delà de 20 km, 100 %.',
 'Chaque scénario montre les différences nettes mois par mois pour une planification budgétaire précise. La variation annuelle entre 2025 et 2026 dépend principalement des mises à jour des barèmes cantonaux et d\'éventuelles modifications des taux IRPEF italiens.',
 'Pour les anciens frontaliers (embauchés avant le 17 juillet 2023, résidant dans les 20 km), le régime reste inchangé : taxation exclusive en Suisse sans obligation IRPEF. La comparaison montre néanmoins les différences dues aux barèmes cantonaux 2026 actualisés.',
 'Utilisez cet outil pour comprendre si votre salaire net augmentera ou diminuera en 2026 et de combien, afin d\'ajuster proactivement planification financière, versements au 3e pilier et stratégie fiscale.',
 ],
 },

 // ───── Calculator: G permit vs B permit comparison ──────────
 '/calcola-stipendio/confronto-permesso-g-vs-b': {
 it: [
 'Il confronto permesso G vs permesso B calcola l\'impatto finanziario complessivo della scelta tra il pendolarismo dall\'Italia (permesso G, residenza in Italia) e il trasferimento in Svizzera (permesso B). L\'analisi va oltre il semplice stipendio netto e include affitto, premi assicurativi sanitari, costi di pendolarismo, tasse comunali italiane e tassazione ordinaria svizzera.',
 'Per i titolari di permesso G, il calcolo include l\'imposta alla fonte svizzera, l\'IRPEF italiana con franchigia di 10.000 EUR per i nuovi frontalieri, il costo della vita nei comuni italiani di confine e le spese di pendolarismo quotidiano (carburante, autostrada, parcheggio, o abbonamento TILO). Il vantaggio principale è il costo della vita inferiore in Italia.',
 'Per il permesso B, il calcolo include la tassazione ordinaria svizzera (che prevede la dichiarazione dei redditi con deduzioni personali), affitti svizzeri significativamente più alti, premi LAMal da residente, ma elimina il tempo di pendolarismo e le attese alla frontiera. In Ticino, un monolocale a Lugano costa CHF 1.000–1.400 al mese, contro EUR 400–600 a Como o Varese.',
 'Lo strumento modella scenari a diversi livelli di stipendio e configurazioni familiari, evidenziando il punto di pareggio salariale a partire dal quale il trasferimento in Svizzera diventa finanziariamente vantaggioso. Per un single, il break-even si situa tipicamente tra CHF 80.000 e 100.000 lordi; per le famiglie, sale significativamente.',
 'Il confronto include anche fattori qualitativi quantificabili: il tempo di pendolarismo risparmiato con il permesso B (1-2 ore al giorno), il costo opportunità delle ore perse in coda alla dogana, e l\'accesso ai servizi pubblici svizzeri (scuole, sanità, trasporti). Questi elementi possono incidere sulla decisione tanto quanto il puro calcolo economico.',
 ],
 en: [
 'The G permit vs B permit comparison calculates the total financial impact of choosing cross-border commuter status (permit G, residence in Italy) versus Swiss residence (permit B). The analysis goes beyond net salary to include rent, healthcare premiums, commute costs, Italian municipal taxes, and Swiss ordinary taxation.',
 'For permit G workers, the calculation includes Swiss withholding tax, Italian IRPEF with the EUR 10,000 franchise for new frontalieri, cost of living in Italian border towns, and daily commute expenses (fuel, motorway tolls, parking, or TILO rail pass). The main advantage is the lower cost of living in Italy.',
 'For permit B, the calculation includes Swiss ordinary taxation (with a tax return allowing personal deductions), significantly higher Swiss rents, resident LAMal premiums, but eliminates commuting time and border crossing delays. In Ticino, a studio apartment in Lugano costs CHF 1,000–1,400 per month, versus EUR 400–600 in Como or Varese.',
 'The tool models scenarios at different salary levels and family configurations, highlighting the break-even salary at which moving to Switzerland becomes financially advantageous despite higher living costs. For a single person, the break-even typically falls between CHF 80,000 and 100,000 gross; for families, it rises significantly.',
 'The comparison also includes quantifiable quality-of-life factors: commuting time saved with permit B (1-2 hours per day), the opportunity cost of hours lost in border queues, and access to Swiss public services (schools, healthcare, transport). These elements can influence the decision as much as the pure financial calculation.',
 ],
 de: [
 'Der Vergleich Ausweis G vs. Ausweis B berechnet die gesamten finanziellen Auswirkungen der Wahl zwischen Grenzgängerstatus (Ausweis G, Wohnsitz in Italien) und Schweizer Wohnsitz (Ausweis B). Die Analyse geht über das Nettogehalt hinaus und berücksichtigt Miete, Krankenkassenprämien, Pendelkosten, italienische Gemeindesteuern und Schweizer ordentliche Besteuerung.',
 'Für Ausweis-G-Arbeitnehmer umfasst die Berechnung Quellensteuer, italienische IRPEF mit EUR-10.000-Franchise für neue Grenzgänger, Lebenshaltungskosten in italienischen Grenzorten und tägliche Pendelkosten (Treibstoff, Autobahn, Parkplatz oder TILO-Abo). Der Hauptvorteil sind die niedrigeren Lebenshaltungskosten in Italien.',
 'Für Ausweis B umfasst die Berechnung die ordentliche Schweizer Besteuerung (mit Steuererklärung und persönlichen Abzügen), deutlich höhere Schweizer Mieten, KVG-Prämien als Einwohner, eliminiert aber Pendelzeit und Grenzwarteschlangen. Im Tessin kostet eine Einzimmerwohnung in Lugano CHF 1.000–1.400 pro Monat gegenüber EUR 400–600 in Como oder Varese.',
 'Das Tool modelliert Szenarien bei verschiedenen Gehaltsstufen und Familienkonstellationen und zeigt das Breakeven-Gehalt, ab dem der Umzug in die Schweiz trotz höherer Lebenshaltungskosten finanziell vorteilhaft wird. Für Alleinstehende liegt der Breakeven typischerweise zwischen CHF 80.000 und 100.000 brutto; für Familien deutlich höher.',
 'Der Vergleich berücksichtigt auch quantifizierbare Lebensqualitätsfaktoren: eingesparte Pendelzeit mit Ausweis B (1-2 Stunden täglich), Opportunitätskosten der im Grenzstau verlorenen Stunden und Zugang zu Schweizer öffentlichen Dienstleistungen. Diese Faktoren können die Entscheidung ebenso beeinflussen wie die rein finanzielle Berechnung.',
 ],
 fr: [
 'La comparaison permis G vs permis B calcule l\'impact financier total du choix entre le statut de frontalier (permis G, résidence en Italie) et la résidence suisse (permis B). L\'analyse va au-delà du salaire net pour inclure le loyer, les primes d\'assurance maladie, les frais de trajet, les impôts communaux italiens et la taxation ordinaire suisse.',
 'Pour les titulaires du permis G, le calcul inclut l\'impôt à la source suisse, l\'IRPEF italienne avec franchise de 10 000 EUR pour les nouveaux frontaliers, le coût de la vie dans les villes frontalières italiennes et les frais de trajet quotidiens (carburant, autoroute, parking ou abonnement TILO). L\'avantage principal est le coût de la vie inférieur en Italie.',
 'Pour le permis B, le calcul inclut la taxation ordinaire suisse (avec déclaration d\'impôt permettant des déductions personnelles), des loyers suisses nettement plus élevés, des primes LAMal de résident, mais élimine le temps de trajet et les attentes à la frontière. Au Tessin, un studio à Lugano coûte CHF 1 000–1 400 par mois, contre EUR 400–600 à Côme ou Varèse.',
 'L\'outil modélise des scénarios à différents niveaux de salaire et configurations familiales, indiquant le salaire d\'équilibre à partir duquel le déménagement en Suisse devient financièrement avantageux. Pour une personne seule, le seuil se situe typiquement entre CHF 80 000 et 100 000 bruts ; pour les familles, il augmente significativement.',
 'La comparaison inclut aussi des facteurs de qualité de vie quantifiables : temps de trajet économisé avec le permis B (1-2 heures par jour), coût d\'opportunité des heures perdues aux files frontalières et accès aux services publics suisses. Ces éléments peuvent influencer la décision autant que le calcul purement financier.',
 ],
 },

 // ───── Guide: cross-border unemployment ─────────────────────
 '/guida-frontaliere/disoccupazione-transfrontaliera': {
 en: [
 'Cross-border unemployment insurance is a complex area where Swiss and Italian regulations intersect. If you lose your job in Switzerland, unemployment benefits are generally paid by Italy (your country of residence), not Switzerland. However, the benefit amount is calculated based on Italian rules and your Italian contribution history, not your Swiss salary.',
 'There is a critical exception: if you had at least 12 months of Swiss employment, you can request Switzerland to transfer your contribution record to Italian INPS via the U1 form (formerly E301). This allows INPS to factor your Swiss employment period into the Italian NASPI unemployment benefit calculation.',
 'The guide covers the step-by-step procedure: obtaining the U1 attestation from the Swiss cantonal employment office (Ufficio del lavoro), filing the NASPI application with INPS within 68 days of job loss, and understanding the benefit duration and amount based on your combined Swiss-Italian contribution history.',
 ],
 de: [
 'Die grenzüberschreitende Arbeitslosenversicherung ist ein komplexer Bereich, in dem schweizerische und italienische Regelungen aufeinandertreffen. Bei Arbeitsplatzverlust in der Schweiz werden Arbeitslosenleistungen grundsätzlich von Italien (dem Wohnsitzland) gezahlt, nicht von der Schweiz. Die Höhe richtet sich nach italienischen Regeln und Ihrer italienischen Beitragsgeschichte.',
 'Es gibt eine wichtige Ausnahme: Bei mindestens 12 Monaten Schweizer Beschäftigung können Sie die Übertragung Ihrer Beitragszeiten an die italienische INPS über das Formular U1 (ehemals E301) beantragen. Dies ermöglicht der INPS, Ihre Schweizer Beschäftigungszeit in die Berechnung des italienischen NASPI einzubeziehen.',
 'Der Leitfaden behandelt das Verfahren Schritt für Schritt: Beschaffung der U1-Bescheinigung vom kantonalen Arbeitsamt, NASPI-Antrag bei der INPS innerhalb von 68 Tagen nach Arbeitsplatzverlust und Verständnis der Leistungsdauer basierend auf der kombinierten Beitragsgeschichte.',
 ],
 fr: [
 'L\'assurance chômage transfrontalière est un domaine complexe où les réglementations suisse et italienne s\'entrecroisent. En cas de perte d\'emploi en Suisse, les prestations de chômage sont généralement versées par l\'Italie (pays de résidence), pas par la Suisse. Le montant est calculé selon les règles italiennes et votre historique de cotisations italiennes.',
 'Il existe une exception critique : avec au moins 12 mois d\'emploi en Suisse, vous pouvez demander le transfert de vos périodes de cotisation à l\'INPS italienne via le formulaire U1 (anciennement E301). Cela permet à l\'INPS d\'intégrer votre période d\'emploi suisse dans le calcul de la NASPI italienne.',
 'Le guide couvre la procédure étape par étape : obtention de l\'attestation U1 auprès de l\'office cantonal de l\'emploi suisse, dépôt de la demande NASPI auprès de l\'INPS dans les 68 jours suivant la perte d\'emploi, et compréhension de la durée et du montant des prestations.',
 ],
 },

 // ───── Guide: G vs B permit comparison ──────────────────────
 '/guida-frontaliere/confronta-permesso-g-vs-b': {
 en: [
 'This guide compares the practical differences between the G permit (cross-border worker, residence in Italy) and the B permit (residence in Switzerland). Key distinctions include taxation method, healthcare access, pension accrual, family member rights, and implications for daily life quality.',
 'The G permit requires returning to Italy at least weekly and limits access to Swiss social services, but allows the cost-of-living advantage of Italian residence. The B permit grants full Swiss residency with ordinary taxation, access to Swiss healthcare and education, but at significantly higher living costs.',
 'Decision factors covered: salary threshold where B permit becomes advantageous, family configuration impact, commute time savings, children\'s education options, and the long-term pension implications of each permit type under the bilateral social security agreement.',
 ],
 de: [
 'Dieser Leitfaden vergleicht die praktischen Unterschiede zwischen dem Ausweis G (Grenzgänger, Wohnsitz in Italien) und dem Ausweis B (Wohnsitz in der Schweiz). Hauptunterschiede: Besteuerungsmethode, Zugang zur Gesundheitsversorgung, Vorsorgeaufbau, Rechte der Familienangehörigen und Auswirkungen auf die Lebensqualität.',
 'Der Ausweis G erfordert die wöchentliche Rückkehr nach Italien und schränkt den Zugang zu Schweizer Sozialdiensten ein, ermöglicht aber den Lebenshaltungskostenvorteil des italienischen Wohnsitzes. Der Ausweis B gewährt vollständigen Schweizer Wohnsitz mit ordentlicher Besteuerung, aber zu erheblich höheren Lebenshaltungskosten.',
 'Behandelte Entscheidungsfaktoren: Gehaltsschwelle, ab der Ausweis B vorteilhaft wird, Einfluss der Familienkonstellation, eingesparte Pendelzeit, Bildungsoptionen für Kinder und langfristige Vorsorgeauswirkungen jedes Bewilligungstyps.',
 ],
 fr: [
 'Ce guide compare les différences pratiques entre le permis G (frontalier, résidence en Italie) et le permis B (résidence en Suisse). Les distinctions clés incluent la méthode de taxation, l\'accès aux soins de santé, l\'accumulation de la prévoyance, les droits des membres de la famille et les implications sur la qualité de vie.',
 'Le permis G exige un retour en Italie au moins hebdomadaire et limite l\'accès aux services sociaux suisses, mais permet l\'avantage du coût de la vie italien. Le permis B accorde la pleine résidence suisse avec taxation ordinaire, mais à des coûts de vie nettement plus élevés.',
 'Facteurs de décision couverts : seuil salarial où le permis B devient avantageux, impact de la configuration familiale, économies de temps de trajet, options éducatives pour les enfants et implications de prévoyance à long terme de chaque type de permis.',
 ],
 },

 // ───── Guide: border map ────────────────────────────────────
 '/guida-frontaliere/mappa-confine': {
 en: [
 'The interactive border map shows the complete Swiss-Italian frontier in the Ticino region, marking all border crossings, customs offices, and key infrastructure. The map highlights the 20 km zone from the border — the threshold that determines which fiscal regime applies to cross-border workers under the 2026 New Agreement.',
 'Each crossing is annotated with opening hours, traffic type (pedestrian, vehicle, commercial), and links to real-time webcam feeds where available. The map also shows major transport corridors: the A2 motorway (Chiasso-Gotthard), regional rail lines (TILO), and bus routes connecting Italian border towns to Ticino employment centres.',
 'For workers choosing a residence municipality, the map provides distance measurements to the nearest border crossing and commute time estimates to Lugano, Bellinzona, Locarno, and Mendrisio — essential data for the G permit vs B permit decision.',
 ],
 de: [
 'Die interaktive Grenzkarte zeigt die komplette schweizerisch-italienische Grenze in der Tessiner Region mit allen Grenzübergängen, Zollämtern und wichtiger Infrastruktur. Die Karte hebt die 20-km-Zone von der Grenze hervor — der Schwellenwert, der das Steuerregime für Grenzgänger nach dem Neuen Abkommen 2026 bestimmt.',
 'Jeder Übergang ist mit Öffnungszeiten, Verkehrstyp (Fussgänger, Fahrzeug, Gewerbe) und Links zu Echtzeit-Webcams annotiert. Die Karte zeigt auch die Hauptverkehrskorridore: Autobahn A2 (Chiasso-Gotthard), Regionalbahnlinien (TILO) und Busverbindungen zwischen italienischen Grenzorten und Tessiner Beschäftigungszentren.',
 'Für Arbeitnehmer bei der Wohnsitzwahl bietet die Karte Entfernungsmessungen zum nächsten Grenzübergang und Pendlerzeitschätzungen nach Lugano, Bellinzona, Locarno und Mendrisio — wesentliche Daten für die Entscheidung zwischen Ausweis G und B.',
 ],
 fr: [
 'La carte interactive de la frontière montre l\'intégralité de la frontière suisse-italienne dans la région du Tessin, marquant tous les postes frontières, bureaux de douane et infrastructures clés. La carte met en évidence la zone des 20 km — le seuil déterminant le régime fiscal des frontaliers selon le Nouvel Accord 2026.',
 'Chaque poste est annoté avec les horaires d\'ouverture, le type de trafic (piéton, véhicule, commercial) et des liens vers les webcams en temps réel disponibles. La carte montre aussi les corridors de transport principaux : autoroute A2 (Chiasso-Gothard), lignes ferroviaires régionales (TILO) et bus reliant les villes frontalières italiennes aux centres d\'emploi tessinois.',
 'Pour les travailleurs choisissant une commune de résidence, la carte fournit les distances au poste frontière le plus proche et les estimations de temps de trajet vers Lugano, Bellinzone, Locarno et Mendrisio — des données essentielles pour la décision permis G vs B.',
 ],
 },

 // ───── Tax: Italian tax return ──────────────────────────────
 '/tasse-e-pensione/dichiarazione-redditi-italia': {
 en: [
 'The Italian tax return guide for cross-border workers covers the Modello 730 and Redditi PF filings required for those who work in Switzerland and are tax residents in Italy. Swiss employment income must be declared in section RC, converted from CHF to EUR using the official UIC exchange rate for the fiscal year.',
 'Under the 2024 New Agreement, new cross-border workers benefit from a EUR 10,000 franchise on Swiss employment income for IRPEF calculation. The foreign tax credit (Art. 165 TUIR) for Swiss withholding tax already paid is claimed in section CE/CR, preventing double taxation.',
 'The guide walks through each form section with examples: how to fill in the CU (Certificazione Unica) data from your Swiss employer, where to enter additional deductions (mortgage interest, medical expenses, renovation bonuses), and the deadlines — 30 September for the 730, 30 November for the Redditi PF.',
 ],
 de: [
 'Der Leitfaden zur italienischen Steuererklärung für Grenzgänger behandelt die Formulare Modello 730 und Redditi PF, die für Personen erforderlich sind, die in der Schweiz arbeiten und in Italien steuerlich ansässig sind. Das Schweizer Arbeitseinkommen muss in Abschnitt RC angegeben werden, umgerechnet von CHF in EUR zum offiziellen UIC-Wechselkurs.',
 'Nach dem Neuen Abkommen 2024 profitieren neue Grenzgänger von einer Franchise von EUR 10.000 auf das Schweizer Arbeitseinkommen für die IRPEF-Berechnung. Die Steuergutschrift (Art. 165 TUIR) für bereits gezahlte Schweizer Quellensteuer wird in Abschnitt CE/CR geltend gemacht.',
 'Der Leitfaden führt mit Beispielen durch jeden Formularteil: Eingabe der CU-Daten (Certificazione Unica) des Schweizer Arbeitgebers, zusätzliche Abzüge (Hypothekenzinsen, Arztkosten, Renovierungsbonus) und Fristen — 30. September für den 730, 30. November für den Redditi PF.',
 ],
 fr: [
 'Le guide de la déclaration fiscale italienne pour frontaliers couvre les formulaires Modello 730 et Redditi PF requis pour les personnes travaillant en Suisse et fiscalement résidentes en Italie. Le revenu d\'emploi suisse doit être déclaré dans la section RC, converti de CHF en EUR au taux de change officiel UIC.',
 'Selon le Nouvel Accord 2024, les nouveaux frontaliers bénéficient d\'une franchise de 10 000 EUR sur le revenu d\'emploi suisse pour le calcul de l\'IRPEF. Le crédit d\'impôt étranger (Art. 165 TUIR) pour l\'impôt à la source suisse déjà payé est demandé dans la section CE/CR.',
 'Le guide accompagne chaque section du formulaire avec des exemples : renseignement des données CU (Certificazione Unica) de l\'employeur suisse, déductions supplémentaires (intérêts hypothécaires, frais médicaux, bonus rénovation) et échéances — 30 septembre pour le 730, 30 novembre pour le Redditi PF.',
 ],
 },

 // ───── Tax: Swiss tax return ────────────────────────────────
 '/tasse-e-pensione/dichiarazione-redditi-svizzera': {
 en: [
 'The Swiss tax return guide covers the withholding tax rectification procedure (Tarifkorrektur/TDR) available to cross-border workers in Canton Ticino. By filing before 31 March of the following year, you can claim additional deductions not automatically included in withholding tax: pillar 3a contributions, actual transport costs, continuing education, and childcare expenses.',
 'For cross-border workers earning above CHF 120,000, supplementary ordinary taxation (TOU) is mandatory. The guide explains how to file via eTax Ticino, what supporting documents are required, and how the quasi-resident status can provide access to the same deductions available to Swiss residents.',
 'Key deadlines and procedures: filing the TDR application with the Ufficio delle Imposte (DFE), gathering Swiss and Italian documentation, and understanding how the Swiss tax rectification interacts with your Italian IRPEF return and the foreign tax credit mechanism.',
 ],
 de: [
 'Der Leitfaden zur Schweizer Steuererklärung behandelt das Quellensteuerberichtigungsverfahren (Tarifkorrektur/TDR) für Grenzgänger im Kanton Tessin. Durch Einreichung bis 31. März des Folgejahres können zusätzliche Abzüge geltend gemacht werden: Säule-3a-Beiträge, tatsächliche Transportkosten, Weiterbildung und Kinderbetreuungskosten.',
 'Für Grenzgänger mit einem Einkommen über CHF 120.000 ist die nachträgliche ordentliche Veranlagung (NOV) obligatorisch. Der Leitfaden erklärt die Einreichung über eTax Ticino, erforderliche Belege und wie der Quasi-Ansässigen-Status Zugang zu denselben Abzügen wie Schweizer Einwohner gewährt.',
 'Wichtige Fristen und Verfahren: TDR-Antrag beim Steueramt (DFE), Beschaffung schweizerischer und italienischer Dokumentation sowie das Zusammenspiel der Schweizer Steuerberichtigung mit der italienischen IRPEF-Erklärung und der Steuergutschrift.',
 ],
 fr: [
 'Le guide de la déclaration fiscale suisse couvre la procédure de rectification de l\'impôt à la source (correction du barème/TDR) disponible pour les frontaliers du Canton du Tessin. En déposant avant le 31 mars de l\'année suivante, vous pouvez réclamer des déductions supplémentaires : contributions pilier 3a, frais de transport effectifs, formation continue et frais de garde d\'enfants.',
 'Pour les frontaliers gagnant plus de CHF 120 000, la taxation ordinaire complémentaire (TOU) est obligatoire. Le guide explique comment déposer via eTax Ticino, les documents justificatifs requis et comment le statut de quasi-résident donne accès aux mêmes déductions que les résidents suisses.',
 'Échéances et procédures clés : dépôt de la demande TDR auprès de l\'office des impôts (DFE), rassemblement de la documentation suisse et italienne, et compréhension de l\'interaction entre la rectification suisse et la déclaration IRPEF italienne.',
 ],
 },

 // ───── Tax: 2026 withholding tax rates ──────────────────────
 '/tasse-e-pensione/aliquote-imposta-alla-fonte-ticino-2026': {
 it: [
 'Le tabelle dell\'imposta alla fonte del Canton Ticino per il 2026 mostrano le aliquote esatte applicate agli stipendi dei frontalieri, suddivise per tabella fiscale (A per celibi, B per celibi con figli, C per coniugati, H per genitori soli), fascia di reddito, numero di figli a carico e appartenenza religiosa. Le aliquote partono dallo 0 % per redditi inferiori a CHF 18.000 e possono arrivare fino al 24 % per i redditi più elevati.',
 'Per i nuovi frontalieri soggetti al Nuovo Accordo 2024, l\'aliquota viene ridotta all\'80 % del tasso ordinario per i residenti entro 20 km dal confine svizzero. I lavoratori residenti oltre 20 km pagano il 100 % dell\'aliquota ordinaria. Questa distinzione è fondamentale perché determina la base di calcolo dell\'imposta svizzera e, di conseguenza, l\'importo del credito d\'imposta disponibile nella dichiarazione dei redditi italiana.',
 'Ogni figlio a carico riduce l\'aliquota dell\'imposta alla fonte di circa 1-2 punti percentuali. Ad esempio, un frontaliere sposato con due figli (tabella C2) paga un\'aliquota effettiva significativamente inferiore rispetto a un celibe senza figli (tabella A0) a parità di reddito. Questa differenza può tradursi in diverse centinaia di franchi al mese per redditi medi di CHF 70.000-90.000.',
 'La confessione religiosa incide sull\'imposta alla fonte: i contribuenti cattolici o protestanti pagano un supplemento di circa 0,5-1 punto percentuale destinato all\'imposta ecclesiastica cantonale. Chi non appartiene a nessuna confessione riconosciuta può richiedere l\'applicazione dell\'aliquota senza supplemento religioso.',
 'Conoscere la propria aliquota esatta è essenziale per le trattative salariali e la pianificazione finanziaria. Le tabelle possono essere incrociate con il simulatore di busta paga per verificare la corretta deduzione. In caso di errore nella tabella applicata, è possibile richiedere una rettifica entro il 31 marzo dell\'anno successivo presso la Divisione delle contribuzioni del Canton Ticino.',
 ],
 en: [
 'The 2026 Canton Ticino withholding tax rate tables show the exact percentages applied to cross-border worker salaries, broken down by tax table (A for single, B for single with children, C for married, H for single parent), income bracket, number of children, and religious affiliation. Rates start at 0% for incomes below CHF 18,000 and can reach up to 24% for the highest earners.',
 'For new cross-border workers under the 2024 New Agreement, the withholding rate is reduced to 80% of the ordinary table rate for residents within 20 km of the border. Workers beyond 20 km pay the full 100% rate. This distinction is crucial as it determines the Swiss tax base and consequently the tax credit available in the Italian tax return.',
 'Each dependent child reduces the withholding tax rate by approximately 1-2 percentage points. For example, a married worker with two children (table C2) pays a significantly lower effective rate than a single worker without children (table A0) at the same income level. This difference can amount to several hundred francs per month for median incomes of CHF 70,000-90,000.',
 'Religious affiliation affects the withholding tax: Catholic or Protestant taxpayers pay a surcharge of approximately 0.5-1 percentage point for cantonal church tax. Those who do not belong to a recognised denomination can request the rate without the religious surcharge by notifying their employer or the cantonal tax office.',
 'Understanding your exact withholding rate is essential for salary negotiations and financial planning. The tables can be cross-referenced with the payslip simulator to verify that your employer is applying the correct deduction. If the wrong table is applied, a correction can be requested by 31 March of the following year at the Canton Ticino tax division.',
 ],
 de: [
 'Die Quellensteuertabellen 2026 des Kantons Tessin zeigen die genauen Prozentsätze für Grenzgängergehälter, aufgeschlüsselt nach Steuertabelle (A für Alleinstehende, B für Alleinstehende mit Kindern, C für Verheiratete, H für Alleinerziehende), Einkommensstufe, Kinderzahl und Konfession. Die Sätze beginnen bei 0 % für Einkommen unter CHF 18.000 und können bis zu 24 % erreichen.',
 'Für neue Grenzgänger nach dem Neuen Abkommen 2024 wird der Quellensteuersatz auf 80 % des ordentlichen Tabellensatzes für Einwohner innerhalb von 20 km der Grenze reduziert. Arbeitnehmer jenseits von 20 km zahlen den vollen 100-%-Satz. Diese Unterscheidung bestimmt die Schweizer Steuerbasis und die in der italienischen Steuererklärung verfügbare Steuergutschrift.',
 'Jedes unterhaltsberechtigte Kind reduziert den Quellensteuersatz um etwa 1-2 Prozentpunkte. Beispielsweise zahlt ein verheirateter Arbeitnehmer mit zwei Kindern (Tabelle C2) einen deutlich niedrigeren Effektivsatz als ein Alleinstehender ohne Kinder (Tabelle A0) bei gleichem Einkommen. Dieser Unterschied kann bei Medianeinkommen mehrere hundert Franken pro Monat ausmachen.',
 'Die Konfession beeinflusst die Quellensteuer: Katholische oder reformierte Steuerpflichtige zahlen einen Zuschlag von etwa 0,5-1 Prozentpunkt für die kantonale Kirchensteuer. Wer keiner anerkannten Konfession angehört, kann den Satz ohne Kirchensteuerzuschlag beantragen.',
 'Die Kenntnis des genauen Quellensteuersatzes ist wesentlich für Gehaltsverhandlungen und Finanzplanung. Die Tabellen können mit dem Lohnabrechnungssimulator abgeglichen werden. Bei falscher Tabelle kann eine Berichtigung bis zum 31. März des Folgejahres bei der Steuerverwaltung des Kantons Tessin beantragt werden.',
 ],
 fr: [
 'Les barèmes 2026 de l\'impôt à la source du Canton du Tessin montrent les pourcentages exacts appliqués aux salaires des frontaliers, ventilés par barème (A pour célibataire, B pour célibataire avec enfants, C pour marié, H pour famille monoparentale), tranche de revenu, nombre d\'enfants et appartenance religieuse. Les taux démarrent à 0 % pour les revenus inférieurs à CHF 18 000 et peuvent atteindre 24 %.',
 'Pour les nouveaux frontaliers selon le Nouvel Accord 2024, le taux de retenue est réduit à 80 % du taux ordinaire pour les résidents dans un rayon de 20 km de la frontière. Les travailleurs au-delà de 20 km paient le taux plein de 100 %. Cette distinction est cruciale car elle détermine la base d\'imposition suisse et le crédit d\'impôt disponible dans la déclaration italienne.',
 'Chaque enfant à charge réduit le taux d\'impôt à la source d\'environ 1-2 points de pourcentage. Par exemple, un travailleur marié avec deux enfants (barème C2) paie un taux effectif nettement inférieur à celui d\'un célibataire sans enfant (barème A0) au même niveau de revenu.',
 'L\'appartenance religieuse affecte l\'impôt à la source : les contribuables catholiques ou protestants paient un supplément d\'environ 0,5-1 point de pourcentage pour l\'impôt ecclésiastique cantonal. Les personnes n\'appartenant à aucune confession reconnue peuvent demander le taux sans supplément religieux.',
 'Connaître votre taux exact de retenue est essentiel pour les négociations salariales et la planification financière. Les barèmes peuvent être croisés avec le simulateur de fiche de paie pour vérifier la déduction correcte. En cas de barème erroné, une rectification peut être demandée avant le 31 mars de l\'année suivante.',
 ],
 },

 // ───── Tax: ristorni tracking ───────────────────────────────
 '/tasse-e-pensione/ristorni-fiscali': {
 en: [
 'Ristorni are the fiscal compensations that Canton Ticino pays to Italian border municipalities to offset the costs of hosting cross-border worker residents. Under the original 1974 agreement, approximately 40% of withholding tax collected from cross-border workers was returned to Italian municipalities within 20 km of the border.',
 'The 2024 New Agreement changes the ristorni framework: as Italy introduces concurrent taxation on new cross-border workers, the share of tax revenue flowing back to Italian municipalities will progressively decrease through the transitional period ending in 2033.',
 'This page tracks ristorni payments by municipality and year, showing historical trends and projected future changes. For cross-border workers, ristorni indirectly affect your community: municipalities receiving significant ristorni can maintain lower local tax rates and better public services.',
 ],
 de: [
 'Ristorni sind die Finanzkompensationen, die der Kanton Tessin an italienische Grenzgemeinden zahlt, um die Kosten der ansässigen Grenzgänger auszugleichen. Nach dem ursprünglichen Abkommen von 1974 wurden etwa 40 % der von Grenzgängern erhobenen Quellensteuer an italienische Gemeinden innerhalb von 20 km zurückerstattet.',
 'Das Neue Abkommen 2024 ändert den Ristorni-Rahmen: Mit der Einführung der konkurrierenden Besteuerung neuer Grenzgänger durch Italien wird der Anteil der an italienische Gemeinden zurückfliessenden Steuereinnahmen bis zum Ende der Übergangsphase 2033 schrittweise sinken.',
 'Diese Seite verfolgt Ristorni-Zahlungen nach Gemeinde und Jahr mit historischen Trends und prognostizierten Änderungen. Ristorni betreffen Ihre Gemeinde indirekt: Gemeinden mit hohen Ristorni können niedrigere lokale Steuersätze und bessere öffentliche Dienstleistungen aufrechterhalten.',
 ],
 fr: [
 'Les ristorni sont les compensations fiscales que le Canton du Tessin verse aux communes frontalières italiennes pour compenser les coûts liés aux frontaliers résidents. Selon l\'accord original de 1974, environ 40 % de l\'impôt à la source prélevé sur les frontaliers était restitué aux communes italiennes dans un rayon de 20 km.',
 'Le Nouvel Accord 2024 modifie le cadre des ristorni : avec l\'introduction de la taxation concurrente des nouveaux frontaliers par l\'Italie, la part des recettes fiscales retournant aux communes italiennes diminuera progressivement pendant la période transitoire jusqu\'en 2033.',
 'Cette page suit les versements de ristorni par commune et par année, montrant les tendances historiques et les changements futurs projetés. Les ristorni affectent indirectement votre communauté : les communes recevant des ristorni importants peuvent maintenir des taux d\'imposition locaux plus bas et de meilleurs services publics.',
 ],
 },

 // ───── Vita: nursery comparison ─────────────────────────────
 '/vivere-in-ticino/confronta-asili-nido': {
 en: [
 'The nursery comparison tool provides a detailed side-by-side analysis of childcare options in Swiss Canton Ticino and the Italian border provinces (Como, Varese, VCO). It compares monthly fees, opening hours, inclusion criteria, and available subsidies on both sides of the border.',
 'In Ticino, nursery costs range from CHF 1,500 to CHF 2,500 per month depending on the municipality and income bracket, with cantonal subsidies available for lower incomes. In Italy, municipal nurseries charge EUR 300-600 per month, and the national Bonus Asilo Nido provides up to EUR 3,000/year for eligible families.',
 'For cross-border families, the choice between Italian and Swiss childcare involves trade-offs: Italian nurseries are cheaper but may require Italian work schedule flexibility, while Ticino nurseries are closer to the workplace but significantly more expensive.',
 ],
 de: [
 'Das Kita-Vergleichstool bietet eine detaillierte Gegenüberstellung von Kinderbetreuungsoptionen im Schweizer Kanton Tessin und den italienischen Grenzprovinzen (Como, Varese, VCO). Es vergleicht Monatsgebühren, Öffnungszeiten, Aufnahmekriterien und verfügbare Zuschüsse beiderseits der Grenze.',
 'Im Tessin liegen die Kita-Kosten bei CHF 1.500 bis CHF 2.500 pro Monat je nach Gemeinde und Einkommensstufe, mit kantonalen Subventionen für tiefere Einkommen. In Italien berechnen kommunale Kitas EUR 300-600 pro Monat, und der nationale Bonus Asilo Nido gewährt bis zu EUR 3.000/Jahr für berechtigte Familien.',
 'Für Grenzgängerfamilien beinhaltet die Wahl zwischen italienischer und Schweizer Kinderbetreuung Abwägungen: Italienische Kitas sind günstiger, erfordern aber möglicherweise Flexibilität bei italienischen Arbeitszeiten, während Tessiner Kitas näher am Arbeitsplatz, aber deutlich teurer sind.',
 ],
 fr: [
 'L\'outil de comparaison des crèches fournit une analyse détaillée côte à côte des options de garde d\'enfants au Canton du Tessin et dans les provinces frontalières italiennes (Côme, Varèse, VCO). Il compare les tarifs mensuels, les horaires d\'ouverture, les critères d\'admission et les subventions disponibles des deux côtés de la frontière.',
 'Au Tessin, les frais de crèche vont de CHF 1 500 à CHF 2 500 par mois selon la commune et la tranche de revenus, avec des subventions cantonales pour les revenus plus modestes. En Italie, les crèches municipales facturent 300-600 EUR/mois, et le Bonus Asilo Nido national fournit jusqu\'à 3 000 EUR/an pour les familles éligibles.',
 'Pour les familles frontalières, le choix entre garde italienne et suisse implique des compromis : les crèches italiennes sont moins chères mais peuvent nécessiter une flexibilité d\'horaires italiens, tandis que les crèches tessinoises sont plus proches du lieu de travail mais nettement plus coûteuses.',
 ],
 },

 // ───── Vita: attractions in Italian-speaking Switzerland ────
 '/vivere-in-ticino/attrazioni-svizzera-italiana': {
 en: [
 'Italian-speaking Switzerland offers a unique blend of Swiss efficiency and Mediterranean lifestyle. Canton Ticino and the Grigioni Italiane feature lakeside towns (Lugano, Locarno, Ascona), UNESCO heritage sites (Bellinzona castles, Monte San Giorgio), and world-class cultural events (Locarno Film Festival, Lugano Estival Jazz).',
 'For cross-border workers, understanding Ticino\'s cultural and leisure landscape helps with the residence decision: proximity to the Lake Lugano shores, hiking trails in the Valle Verzasca, and vibrant restaurant culture are quality-of-life factors that complement the financial analysis of permit G vs B.',
 'The guide covers seasonal highlights, family-friendly activities, public transport accessibility from Italian border towns, and practical tips for making the most of evenings and weekends in Ticino without a Swiss residence permit.',
 ],
 de: [
 'Die italienischsprachige Schweiz bietet eine einzigartige Mischung aus Schweizer Effizienz und mediterranem Lebensgefühl. Der Kanton Tessin und das Grigioni Italiano bieten Seestädte (Lugano, Locarno, Ascona), UNESCO-Welterbestätten (Burgen von Bellinzona, Monte San Giorgio) und erstklassige Kulturveranstaltungen (Filmfestival Locarno, Estival Jazz Lugano).',
 'Für Grenzgänger hilft das Verständnis der Tessiner Kultur- und Freizeitlandschaft bei der Wohnsitzentscheidung: Nähe zum Luganersee, Wanderwege im Val Verzasca und die lebendige Restaurantkultur sind Lebensqualitätsfaktoren, die die finanzielle Analyse von Ausweis G vs. B ergänzen.',
 'Der Leitfaden behandelt saisonale Highlights, familienfreundliche Aktivitäten, ÖV-Erreichbarkeit von italienischen Grenzorten und praktische Tipps für Abende und Wochenenden im Tessin ohne Schweizer Aufenthaltsbewilligung.',
 ],
 fr: [
 'La Suisse italophone offre un mélange unique d\'efficacité suisse et de style de vie méditerranéen. Le Canton du Tessin et les Grisons italiens proposent des villes lacustres (Lugano, Locarno, Ascona), des sites UNESCO (châteaux de Bellinzone, Monte San Giorgio) et des événements culturels de premier plan (Festival du Film de Locarno, Estival Jazz Lugano).',
 'Pour les frontaliers, comprendre le paysage culturel et de loisirs tessinois aide à la décision de résidence : la proximité du lac de Lugano, les sentiers de randonnée du Val Verzasca et la culture gastronomique animée sont des facteurs de qualité de vie qui complètent l\'analyse financière du permis G vs B.',
 'Le guide couvre les temps forts saisonniers, les activités familiales, l\'accessibilité en transports publics depuis les villes frontalières italiennes et des conseils pratiques pour profiter des soirées et week-ends au Tessin sans permis de résidence suisse.',
 ],
 },

 // ───── Vita: cross-border transport ─────────────────────────
 '/vivere-in-ticino/trasporti-frontalieri': {
 en: [
 'The cross-border transport guide covers all commuting options between Italy and Swiss Canton Ticino: car via major border crossings, TILO regional trains (Lombardy-Ticino integration), FlixBus and regional bus services, car-sharing platforms, and cycling routes for border-adjacent municipalities.',
 'For daily commuters, the cost comparison is critical: a monthly TILO Arcobaleno pass costs CHF 150-280 depending on zones, while driving costs EUR 300-500/month including fuel, tolls, parking, and vehicle wear. The guide breaks down each option with realistic monthly costs.',
 'Time-saving strategies include staggered departure times (avoiding the 7:00-8:00 peak at Chiasso), alternative border crossings for different Ticino destinations, and the combination of Italian park-and-ride facilities with Swiss regional transit for the final leg.',
 ],
 de: [
 'Der Grenzgänger-Transportführer deckt alle Pendleroptionen zwischen Italien und dem Schweizer Kanton Tessin ab: Auto über die Hauptgrenzübergänge, TILO-Regionalzüge (Lombardei-Tessin-Integration), FlixBus und regionale Busdienste, Fahrgemeinschaftsplattformen und Fahrradrouten für grenznahe Gemeinden.',
 'Für tägliche Pendler ist der Kostenvergleich entscheidend: Ein TILO-Arcobaleno-Monatsabonnement kostet CHF 150-280 je nach Zone, während Autofahren EUR 300-500/Monat kostet inkl. Kraftstoff, Maut, Parkplatz und Fahrzeugverschleiss. Der Leitfaden schlüsselt jede Option mit realistischen Monatskosten auf.',
 'Zeitspartipps umfassen gestaffelte Abfahrtszeiten (Vermeidung der Spitze 7:00-8:00 bei Chiasso), alternative Grenzübergänge für verschiedene Tessiner Ziele und die Kombination italienischer Park-and-Ride-Anlagen mit dem Schweizer Regionalverkehr.',
 ],
 fr: [
 'Le guide des transports transfrontaliers couvre toutes les options de pendularité entre l\'Italie et le Canton du Tessin : voiture via les principaux postes frontières, trains régionaux TILO (intégration Lombardie-Tessin), FlixBus et services de bus régionaux, plateformes de covoiturage et itinéraires cyclables pour les communes proches de la frontière.',
 'Pour les pendulaires quotidiens, la comparaison des coûts est critique : un abonnement mensuel TILO Arcobaleno coûte CHF 150-280 selon les zones, tandis que la voiture coûte EUR 300-500/mois incluant carburant, péages, parking et usure du véhicule.',
 'Les stratégies de gain de temps incluent des départs décalés (éviter le pic 7h00-8h00 à Chiasso), des postes frontières alternatifs selon la destination au Tessin, et la combinaison de parkings relais italiens avec le transport régional suisse pour le dernier tronçon.',
 ],
 },

 // ───── Statistics: best border municipalities ───────────────
 '/statistiche/migliori-comuni-frontiera': {
 en: [
 'The best border municipalities ranking evaluates Italian comuni within 20 km of the Swiss-Ticino border across multiple criteria relevant to cross-border workers: commute time to major Ticino employers, rental costs, municipal tax rates (addizionale comunale IRPEF), public transport connections, school quality, and access to services.',
 'The ranking uses a composite livability score that weights financial factors (rent, taxes, commute cost) alongside quality-of-life indicators (green spaces, services density, crime rates). Each municipality is profiled with population data, distance to the nearest border crossing, and average property prices.',
 'For cross-border workers choosing where to live in Italy, this ranking provides objective data to complement personal preferences. Filter by province (Como, Varese, VCO), distance from border, or specific criteria to find the municipality that best matches your priorities.',
 ],
 de: [
 'Das Ranking der besten Grenzgemeinden bewertet italienische Comuni innerhalb von 20 km der schweizerisch-tessinischen Grenze nach mehreren Kriterien: Pendelzeit zu den grössten Tessiner Arbeitgebern, Mietkosten, kommunale Steuersätze (Addizionale Comunale IRPEF), ÖV-Anbindung, Schulqualität und Zugang zu Dienstleistungen.',
 'Das Ranking verwendet einen zusammengesetzten Lebensqualitätswert, der finanzielle Faktoren (Miete, Steuern, Pendelkosten) mit Lebensqualitätsindikatoren (Grünflächen, Dienstleistungsdichte, Kriminalitätsraten) gewichtet. Jede Gemeinde wird mit Bevölkerungsdaten, Entfernung zum nächsten Grenzübergang und durchschnittlichen Immobilienpreisen profiliert.',
 'Für Grenzgänger bei der Wohnsitzwahl in Italien bietet dieses Ranking objektive Daten. Filtern Sie nach Provinz (Como, Varese, VCO), Grenzentfernung oder spezifischen Kriterien, um die Gemeinde zu finden, die am besten zu Ihren Prioritäten passt.',
 ],
 fr: [
 'Le classement des meilleures communes frontalières évalue les comuni italiens dans un rayon de 20 km de la frontière suisse-tessinoise selon plusieurs critères : temps de trajet vers les principaux employeurs tessinois, coûts de location, taux d\'imposition communaux (addizionale comunale IRPEF), liaisons de transport public, qualité scolaire et accès aux services.',
 'Le classement utilise un score de qualité de vie composite pondérant les facteurs financiers (loyer, impôts, coûts de trajet) et les indicateurs de qualité de vie (espaces verts, densité de services, taux de criminalité). Chaque commune est profilée avec données démographiques, distance au poste frontière le plus proche et prix immobiliers moyens.',
 'Pour les frontaliers choisissant où vivre en Italie, ce classement fournit des données objectives. Filtrez par province (Côme, Varèse, VCO), distance de la frontière ou critères spécifiques pour trouver la commune correspondant le mieux à vos priorités.',
 ],
 },

 // ───── Statistics: Ticino salary observatory ────────────────
 '/statistiche/osservatorio-stipendi-lavori-ticino': {
 en: [
 'The Ticino salary observatory tracks median and average wages by sector, role, and experience level across Canton Ticino, using data from the Swiss Federal Statistical Office (BFS) wage survey and employer-reported figures. The observatory covers 24 industry sectors, from banking and pharmaceuticals to construction and hospitality.',
 'For cross-border workers, the observatory provides essential benchmarking data for salary negotiations: knowing the median salary for your sector and seniority level in Ticino helps you assess whether an offer is competitive. The data includes gross salary ranges, 25th and 75th percentile brackets, and year-over-year trends.',
 'Interactive charts let you filter by sector, job category (management, professional, technical, operative), and compare Ticino salaries against Swiss national averages and Italian equivalents in the border provinces.',
 ],
 de: [
 'Das Tessiner Gehalts-Observatorium verfolgt Median- und Durchschnittsgehälter nach Branche, Rolle und Erfahrungsstufe im Kanton Tessin, basierend auf der BFS-Lohnerhebung und Arbeitgeberdaten. Das Observatorium deckt 24 Branchen ab, von Banken und Pharma bis Bau und Gastgewerbe.',
 'Für Grenzgänger liefert das Observatorium wesentliche Benchmarking-Daten für Gehaltsverhandlungen: Die Kenntnis des Mediangehalts für Ihren Sektor und Ihre Erfahrungsstufe im Tessin hilft zu beurteilen, ob ein Angebot wettbewerbsfähig ist. Die Daten umfassen Bruttolohnspannen, 25. und 75. Perzentil sowie Jahresvergleiche.',
 'Interaktive Diagramme ermöglichen Filterung nach Branche, Berufskategorie (Management, Fachkräfte, Technik, Operativ) und Vergleich mit dem Schweizer Landesdurchschnitt und italienischen Äquivalenten in den Grenzprovinzen.',
 ],
 fr: [
 'L\'observatoire des salaires tessinois suit les salaires médians et moyens par secteur, poste et niveau d\'expérience au Canton du Tessin, à partir de l\'enquête salariale de l\'OFS et des données d\'employeurs. L\'observatoire couvre 24 secteurs, de la banque et pharmacie à la construction et l\'hôtellerie.',
 'Pour les frontaliers, l\'observatoire fournit des données de benchmarking essentielles pour les négociations salariales : connaître le salaire médian pour votre secteur et niveau d\'ancienneté au Tessin permet d\'évaluer la compétitivité d\'une offre. Les données incluent les fourchettes de salaires bruts et les tendances annuelles.',
 'Les graphiques interactifs permettent de filtrer par secteur, catégorie professionnelle (management, spécialistes, technique, opératif) et de comparer les salaires tessinois avec les moyennes nationales suisses et les équivalents italiens dans les provinces frontalières.',
 ],
 },

 // ───── Statistics: Swiss unemployment ───────────────────────
 '/statistiche/disoccupazione-svizzera': {
 en: [
 'The Swiss unemployment statistics page tracks cantonal and national unemployment rates using SECO data, with a focus on Canton Ticino and its implications for cross-border workers. Ticino historically has one of the highest unemployment rates among Swiss cantons, typically 1-2 percentage points above the national average.',
 'For cross-border workers, Swiss unemployment figures signal labour market conditions: sectors with rising unemployment may indicate slower hiring, while low unemployment sectors present stronger negotiating positions. The data is broken down by sector, nationality, age group, and duration of unemployment.',
 'The page also covers the relationship between frontaliere employment and Swiss unemployment — a politically sensitive topic in Ticino. Charts show the correlation between cross-border worker numbers and cantonal unemployment over time, providing factual context for public debate.',
 ],
 de: [
 'Die Schweizer Arbeitslosenstatistik verfolgt kantonale und nationale Arbeitslosenquoten anhand von SECO-Daten, mit Fokus auf den Kanton Tessin und dessen Auswirkungen für Grenzgänger. Das Tessin hat historisch eine der höchsten Arbeitslosenquoten unter den Schweizer Kantonen, typischerweise 1-2 Prozentpunkte über dem nationalen Durchschnitt.',
 'Für Grenzgänger signalisieren Schweizer Arbeitslosenzahlen die Arbeitsmarktlage: Sektoren mit steigender Arbeitslosigkeit können langsamere Einstellungen anzeigen, während Sektoren mit niedriger Arbeitslosigkeit stärkere Verhandlungspositionen bieten. Die Daten sind nach Branche, Nationalität, Altersgruppe und Dauer aufgeschlüsselt.',
 'Die Seite beleuchtet auch die Beziehung zwischen Grenzgängerbeschäftigung und Schweizer Arbeitslosigkeit — ein politisch heikles Thema im Tessin. Grafiken zeigen die Korrelation zwischen Grenzgängerzahlen und kantonaler Arbeitslosigkeit über die Zeit.',
 ],
 fr: [
 'La page des statistiques du chômage suisse suit les taux de chômage cantonaux et nationaux à partir des données SECO, avec un focus sur le Canton du Tessin et ses implications pour les frontaliers. Le Tessin a historiquement l\'un des taux de chômage les plus élevés parmi les cantons suisses, typiquement 1-2 points au-dessus de la moyenne nationale.',
 'Pour les frontaliers, les chiffres du chômage suisse signalent les conditions du marché du travail : les secteurs avec un chômage en hausse peuvent indiquer un ralentissement des embauches, tandis que les secteurs à faible chômage offrent de meilleures positions de négociation.',
 'La page couvre aussi la relation entre l\'emploi frontalier et le chômage suisse — un sujet politiquement sensible au Tessin. Les graphiques montrent la corrélation entre le nombre de frontaliers et le chômage cantonal au fil du temps, fournissant un contexte factuel au débat public.',
 ],
 },

 // ───── Statistics: mortgage comparison ──────────────────────
 '/statistiche/confronto-mutui': {
 en: [
 'The mortgage comparison page analyses interest rates and conditions for home loans in Switzerland and Italy, relevant for cross-border workers who own or plan to buy property on either side of the border. Swiss mortgage rates (typically 1.5-3% for fixed rate) are compared with Italian rates (typically 2.5-4.5%).',
 'For cross-border workers, the mortgage decision involves currency considerations: a Swiss mortgage on an Italian property exposes you to CHF-EUR exchange rate risk, while an Italian mortgage may offer higher rates but eliminates currency mismatch. The comparison shows total interest paid over 15, 20, and 25-year terms under different rate scenarios.',
 'The tool also covers Swiss cantonal lending rules (typically 20% down payment, 33% income-to-debt ratio), Italian banking requirements for non-residents, and the impact of declaring Swiss income on Italian mortgage eligibility.',
 ],
 de: [
 'Die Hypothekenvergleichsseite analysiert Zinssätze und Konditionen für Wohnkredite in der Schweiz und Italien, relevant für Grenzgänger, die Immobilien auf beiden Seiten der Grenze besitzen oder erwerben möchten. Schweizer Hypothekenzinsen (typisch 1,5-3 % für Festzins) werden mit italienischen Zinsen (typisch 2,5-4,5 %) verglichen.',
 'Für Grenzgänger beinhaltet die Hypothekenentscheidung Währungsüberlegungen: Eine Schweizer Hypothek auf eine italienische Immobilie setzt Sie dem CHF-EUR-Wechselkursrisiko aus, während eine italienische Hypothek höhere Zinsen, aber kein Währungsrisiko birgt.',
 'Das Tool behandelt auch Schweizer kantonale Kreditregeln (typisch 20 % Eigenkapital, 33 % Einkommens-Schulden-Verhältnis), italienische Bankanforderungen für Nicht-Ansässige und die Auswirkungen der Deklaration von Schweizer Einkommen auf die italienische Hypothekenwürdigkeit.',
 ],
 fr: [
 'La page de comparaison des hypothèques analyse les taux d\'intérêt et conditions des prêts immobiliers en Suisse et en Italie, pertinents pour les frontaliers possédant ou prévoyant d\'acheter un bien de part et d\'autre de la frontière. Les taux hypothécaires suisses (typiquement 1,5-3 % à taux fixe) sont comparés aux taux italiens (typiquement 2,5-4,5 %).',
 'Pour les frontaliers, la décision hypothécaire implique des considérations de change : une hypothèque suisse sur un bien italien expose au risque de change CHF-EUR, tandis qu\'une hypothèque italienne offre des taux plus élevés mais élimine le décalage monétaire.',
 'L\'outil couvre aussi les règles de prêt cantonales suisses (typiquement 20 % d\'apport, ratio revenus-dettes de 33 %), les exigences bancaires italiennes pour les non-résidents et l\'impact de la déclaration de revenus suisses sur l\'éligibilité hypothécaire italienne.',
 ],
 },

 // ───── Statistics: border fuel prices ───────────────────────
 '/statistiche/prezzi-benzina-confine': {
 en: [
 'The border fuel price tracker monitors petrol and diesel prices at service stations on both sides of the Swiss-Italian border, updated hourly from official sources. The price differential between Swiss and Italian fuel is a significant daily cost factor for cross-border commuters.',
 'On average, fuel in Italy is 15-25% cheaper than in Ticino, but the gap fluctuates with international oil prices, national excise taxes, and seasonal demand. The tracker shows current prices at stations near major border crossings (Chiasso, Stabio, Ponte Tresa), helping you decide where to fill up each day.',
 'Annual savings from consistently fuelling in Italy can reach EUR 800-1,200 for a daily 50 km round trip commute. The tool also factors in the time cost of detouring to Italian stations and Swiss customs rules on fuel quantity limits when crossing the border.',
 ],
 de: [
 'Der Benzinpreis-Tracker an der Grenze überwacht Benzin- und Dieselpreise an Tankstellen beiderseits der schweizerisch-italienischen Grenze, stündlich aktualisiert aus offiziellen Quellen. Das Preisgefälle zwischen Schweizer und italienischem Kraftstoff ist ein erheblicher täglicher Kostenfaktor für Grenzpendler.',
 'Im Durchschnitt ist Kraftstoff in Italien 15-25 % günstiger als im Tessin, aber die Differenz schwankt mit internationalen Ölpreisen, nationalen Verbrauchssteuern und saisonaler Nachfrage. Der Tracker zeigt aktuelle Preise an Tankstellen nahe den Hauptgrenzübergängen (Chiasso, Stabio, Ponte Tresa).',
 'Die jährlichen Einsparungen durch konsequentes Tanken in Italien können EUR 800-1.200 für einen täglichen 50-km-Rundweg-Pendel erreichen. Das Tool berücksichtigt auch den Zeitaufwand für Umwege und Schweizer Zollregeln zur Kraftstoffmengenbeschränkung beim Grenzübertritt.',
 ],
 fr: [
 'Le tracker des prix du carburant à la frontière surveille les prix de l\'essence et du diesel aux stations-service des deux côtés de la frontière suisse-italienne, mis à jour toutes les heures à partir de sources officielles. L\'écart de prix entre le carburant suisse et italien est un facteur de coût quotidien significatif pour les pendulaires.',
 'En moyenne, le carburant en Italie est 15-25 % moins cher qu\'au Tessin, mais l\'écart fluctue avec les prix internationaux du pétrole, les accises nationales et la demande saisonnière. Le tracker affiche les prix actuels aux stations proches des principaux postes frontières (Chiasso, Stabio, Ponte Tresa).',
 'Les économies annuelles en faisant le plein systématiquement en Italie peuvent atteindre 800-1 200 EUR pour un trajet quotidien de 50 km aller-retour. L\'outil prend aussi en compte le coût en temps du détour et les règles douanières suisses sur les limites de quantité de carburant.',
 ],
 },

 // ───── Statistics: health insurance premiums by municipality ─
 '/statistiche/premi-malattia-comuni': {
 en: [
 'The health insurance premium map shows LAMal (mandatory Swiss health insurance) monthly premiums by municipality and insurer in Canton Ticino and surrounding cantons. Premiums vary significantly: from CHF 270 in the cheapest combination to over CHF 560 in the most expensive, depending on insurer, model (standard, HMO, telmed), deductible, and accident coverage inclusion.',
 'For cross-border workers who opt for Swiss LAMal instead of the Italian National Health Service, premium comparison is essential. The choice is irrevocable for the entire duration of employment, making it one of the most consequential financial decisions a new frontaliere faces in the first 90 days.',
 'The tool also shows the premium evolution over the last 5 years and forecasts for the coming year, helping you anticipate annual cost increases. Filter by canton, insurer, and coverage model to find the optimal combination for your health profile and budget.',
 ],
 de: [
 'Die Krankenkassenprämien-Karte zeigt monatliche KVG-Prämien (obligatorische Schweizer Krankenversicherung) nach Gemeinde und Versicherer im Kanton Tessin und umliegenden Kantonen. Die Prämien variieren erheblich: von CHF 270 in der günstigsten Kombination bis über CHF 560 in der teuersten, je nach Versicherer, Modell (Standard, HMO, Telmed), Franchise und Unfalldeckung.',
 'Für Grenzgänger, die sich für die Schweizer KVG statt den italienischen Nationalen Gesundheitsdienst entscheiden, ist der Prämienvergleich entscheidend. Die Wahl ist für die gesamte Beschäftigungsdauer unwiderruflich — eine der folgenreichsten Finanzentscheidungen in den ersten 90 Tagen.',
 'Das Tool zeigt auch die Prämienentwicklung der letzten 5 Jahre und Prognosen für das kommende Jahr. Filtern Sie nach Kanton, Versicherer und Deckungsmodell, um die optimale Kombination für Ihr Gesundheitsprofil und Budget zu finden.',
 ],
 fr: [
 'La carte des primes d\'assurance maladie montre les primes mensuelles LAMal (assurance maladie obligatoire suisse) par commune et assureur au Canton du Tessin et cantons environnants. Les primes varient considérablement : de CHF 270 dans la combinaison la moins chère à plus de CHF 560 dans la plus onéreuse, selon l\'assureur, le modèle (standard, HMO, télémédecine), la franchise et la couverture accidents.',
 'Pour les frontaliers qui optent pour la LAMal suisse plutôt que le Service National de Santé italien, la comparaison des primes est essentielle. Le choix est irrévocable pour toute la durée de l\'emploi — l\'une des décisions financières les plus lourdes de conséquences dans les 90 premiers jours.',
 'L\'outil montre aussi l\'évolution des primes sur les 5 dernières années et les prévisions pour l\'année à venir. Filtrez par canton, assureur et modèle de couverture pour trouver la combinaison optimale pour votre profil de santé et budget.',
 ],
 },

 // ───── Job board ────────────────────────────────────────────
 '/cerca-lavoro-ticino': {
 en: [
 'The Ticino job board aggregates positions from over 100 employers in Canton Ticino, including multinational corporations, public institutions (USI, SUPSI, EOC), banking and insurance groups, pharmaceutical companies, and IT firms. Listings are sourced directly from company HR portals and updated daily by dedicated crawlers.',
 'Each listing includes normalised data: job title, company, location, contract type, publication date, and a direct link to apply on the employer\'s original website. Jobs are translated into all four supported languages (Italian, English, German, French) to help non-Italian-speaking candidates discover opportunities.',
 'Use the search and filter tools to narrow results by sector, location, contract type, or company. For cross-border workers, the board is designed to complement salary comparison tools — after finding a role, use the net salary simulator to estimate take-home pay under both the G permit and B permit tax regimes.',
 'The most in-demand sectors in Ticino for cross-border workers include pharmaceuticals and life sciences (with major employers in the Lugano and Mendrisio area), banking and financial services (particularly in Lugano\'s financial district), engineering and manufacturing (along the Chiasso–Mendrisio industrial corridor), IT and software development, and hospitality/tourism around Lake Lugano and the Locarno area. These sectors offer median salaries ranging from CHF 55,000 to CHF 95,000 depending on experience and specialisation.',
 'Preparing a Swiss-format CV and cover letter is essential for job applications in Ticino. Swiss employers expect a reverse-chronological CV with a professional photo, exact employment dates (month/year), and references listed with contact details. Cover letters should be concise (one page), addressed to the hiring manager by name, and written in Italian for Ticino roles. Including your Swiss work permit status (G permit) and availability date demonstrates familiarity with cross-border employment conventions.',
 ],
 de: [
 'Die Tessiner Stellenbörse aggregiert Positionen von über 100 Arbeitgebern im Kanton Tessin, darunter multinationale Konzerne, öffentliche Institutionen (USI, SUPSI, EOC), Banken- und Versicherungsgruppen, Pharmaunternehmen und IT-Firmen. Die Angebote stammen direkt von den HR-Portalen der Unternehmen und werden täglich aktualisiert.',
 'Jedes Inserat enthält normalisierte Daten: Stellenbezeichnung, Unternehmen, Standort, Vertragsart, Veröffentlichungsdatum und einen Direktlink zur Bewerbung auf der Originalwebsite des Arbeitgebers. Stellen werden in alle vier unterstützten Sprachen übersetzt.',
 'Nutzen Sie die Such- und Filtertools, um Ergebnisse nach Branche, Standort, Vertragsart oder Unternehmen einzugrenzen. Für Grenzgänger ist die Börse als Ergänzung zu den Gehaltsvergleichstools konzipiert — nach dem Finden einer Stelle können Sie den Nettosimulator nutzen.',
 'Die am meisten nachgefragten Branchen im Tessin für Grenzgänger umfassen Pharma und Life Sciences (mit grossen Arbeitgebern im Raum Lugano und Mendrisio), Bank- und Finanzdienstleistungen (besonders im Finanzdistrikt Lugano), Ingenieurwesen und Fertigung (entlang des Industriekorridors Chiasso–Mendrisio), IT und Softwareentwicklung sowie Gastronomie und Tourismus rund um den Luganersee und den Raum Locarno. Diese Branchen bieten Mediangehälter von CHF 55.000 bis CHF 95.000.',
 'Die Erstellung eines Lebenslaufs und Bewerbungsschreibens im Schweizer Format ist für Bewerbungen im Tessin unerlässlich. Schweizer Arbeitgeber erwarten einen umgekehrt chronologischen Lebenslauf mit Passfoto, exakten Anstellungsdaten (Monat/Jahr) und Referenzen mit Kontaktdaten. Anschreiben sollten einseitig sein, den Personalverantwortlichen namentlich ansprechen und für Tessiner Stellen auf Italienisch verfasst sein. Die Angabe des Arbeitsbewilligungsstatus (Ausweis G) und Verfügbarkeitsdatums zeigt Vertrautheit mit den Grenzgänger-Konventionen.',
 ],
 fr: [
 'Le tableau d\'emploi tessinois agrège les postes de plus de 100 employeurs du Canton du Tessin, incluant des multinationales, des institutions publiques (USI, SUPSI, EOC), des groupes bancaires et d\'assurance, des entreprises pharmaceutiques et des sociétés IT. Les offres proviennent directement des portails RH des entreprises et sont mises à jour quotidiennement.',
 'Chaque offre inclut des données normalisées : intitulé du poste, entreprise, lieu, type de contrat, date de publication et lien direct pour postuler sur le site original de l\'employeur. Les postes sont traduits dans les quatre langues supportées.',
 'Utilisez les outils de recherche et de filtrage pour affiner les résultats par secteur, lieu, type de contrat ou entreprise. Pour les frontaliers, le tableau est conçu pour compléter les outils de comparaison salariale — après avoir trouvé un poste, utilisez le simulateur de salaire net.',
 'Les secteurs les plus recherchés au Tessin pour les frontaliers comprennent la pharma et les sciences de la vie (avec de grands employeurs dans la zone Lugano-Mendrisio), les services bancaires et financiers (notamment le quartier financier de Lugano), l\'ingénierie et la manufacture (le long du corridor industriel Chiasso–Mendrisio), l\'IT et le développement logiciel, ainsi que l\'hôtellerie et le tourisme autour du lac de Lugano et de Locarno. Ces secteurs offrent des salaires médians de CHF 55 000 à CHF 95 000.',
 'Préparer un CV et une lettre de motivation au format suisse est essentiel pour postuler au Tessin. Les employeurs suisses attendent un CV antichronologique avec photo professionnelle, dates d\'emploi exactes (mois/année) et références avec coordonnées. La lettre de motivation doit être concise (une page), adressée au responsable du recrutement par son nom, et rédigée en italien pour les postes tessinois. Indiquer son statut de permis de travail (permis G) et sa date de disponibilité démontre une connaissance des conventions d\'emploi transfrontalier.',
 ],
 },

 // ───── Swiss employment contracts guide ─────────────────────
 '/contratti-lavoro-svizzera': {
 en: [
 'The Swiss employment contracts guide explains the main contract types used in Canton Ticino: unlimited-term (CDI), fixed-term (CDD), temporary (staffing/interinale), and on-call contracts. For cross-border workers, understanding contract type is essential because it affects G permit duration, unemployment benefit eligibility, and notice period obligations.',
 'Swiss employment law provides strong protections compared to Italian norms: minimum notice periods scale from 1 month in the first year to 3 months after 9 years, the 13th month salary is standard practice (though not legally mandatory in all sectors), and trial periods are limited to 1-3 months.',
 'The guide also covers collective labour agreements (CCL/GAV) that apply in major Ticino sectors, minimum wage provisions (CHF 19.75/hour in 2026), overtime compensation rules, and the documentation you should verify before signing a Swiss employment contract.',
 ],
 de: [
 'Der Leitfaden zu Schweizer Arbeitsverträgen erklärt die Hauptvertragsarten im Kanton Tessin: unbefristet (CDI), befristet (CDD), temporär (Personalverleih/Interinale) und Arbeit auf Abruf. Für Grenzgänger ist das Verständnis der Vertragsart wesentlich, da sie Ausweis-G-Dauer, Arbeitslosengeldanspruch und Kündigungsfristen beeinflusst.',
 'Das Schweizer Arbeitsrecht bietet im Vergleich zu italienischen Normen starke Schutzrechte: Mindestkündigungsfristen skalieren von 1 Monat im ersten Jahr auf 3 Monate nach 9 Jahren, der 13. Monatslohn ist gängige Praxis, und Probezeiten sind auf 1-3 Monate begrenzt.',
 'Der Leitfaden behandelt auch Gesamtarbeitsverträge (GAV), die in wichtigen Tessiner Branchen gelten, Mindestlohnbestimmungen (CHF 19,75/Stunde 2026), Überstundenregelungen und die Dokumentation, die Sie vor Unterzeichnung eines Schweizer Arbeitsvertrags prüfen sollten.',
 ],
 fr: [
 'Le guide des contrats de travail suisses explique les principaux types de contrats utilisés au Canton du Tessin : durée indéterminée (CDI), durée déterminée (CDD), temporaire (intérim) et sur appel. Pour les frontaliers, comprendre le type de contrat est essentiel car il affecte la durée du permis G, l\'éligibilité aux allocations chômage et les obligations de préavis.',
 'Le droit du travail suisse offre des protections solides par rapport aux normes italiennes : les préavis minimaux vont de 1 mois la première année à 3 mois après 9 ans, le 13e mois est la pratique standard, et les périodes d\'essai sont limitées à 1-3 mois.',
 'Le guide couvre aussi les conventions collectives de travail (CCT) applicables dans les grands secteurs tessinois, les dispositions sur le salaire minimum (CHF 19,75/heure en 2026), les règles de compensation des heures supplémentaires et les documents à vérifier avant de signer un contrat suisse.',
 ],
 },

 // ───── TFR/severance for cross-border workers ───────────────
 '/tfr-liquidazione-frontaliere': {
 en: [
 'The TFR (Trattamento di Fine Rapporto) and severance guide clarifies what happens at the end of a Swiss employment relationship for cross-border workers. Unlike Italian law where TFR accrues automatically, Swiss law does not provide an equivalent: there is no end-of-service payment in Switzerland. However, the second pillar (LPP/BVG) serves a similar function.',
 'When leaving Swiss employment, cross-border workers can withdraw their LPP pension capital as a lump sum (if leaving Switzerland permanently) or transfer it to a vested benefits account (Freizügigkeitskonto). The withdrawal is subject to Swiss capital withdrawal tax, which varies by canton — in Ticino, typically 5-8% depending on the amount.',
 'The guide covers the step-by-step process: notifying your pension fund, choosing between lump sum and transfer, tax implications in both Switzerland and Italy, and the interaction with Italian TFR if you had previous Italian employment. For workers returning to Italy, declaring the Swiss pension withdrawal on Italian tax returns is mandatory.',
 ],
 de: [
 'Der Leitfaden zu TFR (Trattamento di Fine Rapporto) und Abfindung klärt, was bei Beendigung eines Schweizer Arbeitsverhältnisses für Grenzgänger passiert. Anders als im italienischen Recht, wo TFR automatisch anfällt, gibt es im Schweizer Recht kein Äquivalent. Die zweite Säule (BVG) übernimmt jedoch eine ähnliche Funktion.',
 'Beim Austritt aus einer Schweizer Beschäftigung können Grenzgänger ihr BVG-Vorsorgekapital als Einmalbetrag beziehen (bei endgültigem Verlassen der Schweiz) oder auf ein Freizügigkeitskonto übertragen. Der Bezug unterliegt der Schweizer Kapitalabzugssteuer, die im Tessin typischerweise 5-8 % beträgt.',
 'Der Leitfaden behandelt den Ablauf: Benachrichtigung der Pensionskasse, Wahl zwischen Kapitalbezug und Übertragung, steuerliche Auswirkungen in beiden Ländern und das Zusammenspiel mit dem italienischen TFR bei früherer italienischer Beschäftigung.',
 ],
 fr: [
 'Le guide du TFR (Trattamento di Fine Rapporto) et des indemnités de départ clarifie ce qui se passe à la fin d\'une relation de travail suisse pour les frontaliers. Contrairement au droit italien où le TFR s\'accumule automatiquement, le droit suisse ne prévoit pas d\'équivalent. Cependant, le deuxième pilier (LPP) remplit une fonction similaire.',
 'En quittant un emploi suisse, les frontaliers peuvent retirer leur capital de prévoyance LPP en une fois (en cas de départ définitif de Suisse) ou le transférer sur un compte de libre passage. Le retrait est soumis à l\'impôt suisse sur le retrait en capital, qui au Tessin est typiquement de 5-8 %.',
 'Le guide couvre le processus étape par étape : notification de la caisse de pension, choix entre retrait en capital et transfert, implications fiscales dans les deux pays et interaction avec le TFR italien en cas d\'emploi antérieur en Italie.',
 ],
 },

 // ───── G vs B permit quiz ───────────────────────────────────
 '/quiz-permesso-b-o-g': {
 en: [
 'The G vs B permit quiz helps you determine which Swiss work permit is best suited to your situation through a series of practical questions about your employment, family configuration, commute preferences, and financial priorities. The quiz is not a legal determination — it provides a personalised recommendation based on common cross-border worker profiles.',
 'Questions cover key decision factors: gross salary level (the breakeven point where B permit becomes financially advantageous is typically around CHF 90,000-110,000 for a family), children\'s ages and schooling preferences, daily commute tolerance, and long-term residency plans.',
 'After completing the quiz, you receive a personalised analysis linking to the relevant calculators: net salary under each permit type, cost of living comparison, healthcare premium comparison, and the residence change simulator to model the financial impact of switching permits.',
 ],
 de: [
 'Das G-vs-B-Ausweis-Quiz hilft Ihnen, anhand praktischer Fragen zu Beschäftigung, Familienkonstellation, Pendlerpräferenzen und finanziellen Prioritäten zu bestimmen, welche Schweizer Arbeitsbewilligung am besten zu Ihrer Situation passt.',
 'Die Fragen decken zentrale Entscheidungsfaktoren ab: Bruttogehaltsstufe (der Breakeven-Punkt, ab dem Ausweis B finanziell vorteilhaft wird, liegt typischerweise bei CHF 90.000-110.000 für eine Familie), Alter der Kinder und Schulpräferenzen, tägliche Pendeltoleranz und langfristige Aufenthaltspläne.',
 'Nach Abschluss des Quiz erhalten Sie eine personalisierte Analyse mit Links zu den relevanten Rechnern: Nettogehalt je Bewilligungstyp, Lebenshaltungskostenvergleich, Krankenkassenprämienvergleich und der Wohnsitzwechsel-Simulator.',
 ],
 fr: [
 'Le quiz permis G vs B vous aide à déterminer quel permis de travail suisse convient le mieux à votre situation à travers une série de questions pratiques sur votre emploi, votre configuration familiale, vos préférences de trajet et vos priorités financières.',
 'Les questions couvrent les facteurs de décision clés : niveau de salaire brut (le point d\'équilibre où le permis B devient financièrement avantageux se situe typiquement autour de CHF 90 000-110 000 pour une famille), âge des enfants, tolérance au trajet quotidien et projets de résidence à long terme.',
 'Après le quiz, vous recevez une analyse personnalisée avec liens vers les calculateurs pertinents : salaire net par type de permis, comparaison du coût de la vie, comparaison des primes d\'assurance maladie et simulateur de changement de résidence.',
 ],
 },

 // ───── 13th month salary calculator ─────────────────────────
 '/calcolo-tredicesima-frontaliere': {
 en: [
 'The 13th month salary calculator determines how the "tredicesima" (13th month payment) works for cross-border workers in Switzerland. In Swiss employment, the 13th month salary is a contractual provision rather than a legal obligation, but it is standard practice in most Ticino sectors and covered by collective labour agreements (CCL/GAV).',
 'The calculator shows how the 13th month is distributed: typically paid in December as a full monthly gross salary, subject to the same social deductions (AVS, unemployment, LPP) and withholding tax as regular monthly pay. This means the net 13th month may be lower than expected if your marginal tax bracket is higher.',
 'For Italian tax purposes, the 13th month is part of your total Swiss employment income and must be included in the annual IRPEF calculation. The guide clarifies the timing: Swiss CU documentation reflects 13 monthly payments, while Italian tax rules require annualised income reporting.',
 ],
 de: [
 'Der Rechner für den 13. Monatslohn erklärt, wie die „Tredicesima" (13. Monatsgehalt) für Grenzgänger in der Schweiz funktioniert. Im Schweizer Arbeitsrecht ist der 13. Monatslohn eine vertragliche Vereinbarung, aber in den meisten Tessiner Branchen Standardpraxis und durch Gesamtarbeitsverträge (GAV) abgedeckt.',
 'Der Rechner zeigt die Verteilung: typischerweise im Dezember als volles Bruttomonatsgehalt ausgezahlt, mit denselben Sozialabzügen (AHV, ALV, BVG) und Quellensteuer wie das reguläre Monatsgehalt. Das Netto des 13. Monatslohns kann daher niedriger als erwartet ausfallen.',
 'Für die italienische Steuer ist der 13. Monatslohn Teil des gesamten Schweizer Arbeitseinkommens und muss in die IRPEF-Jahresberechnung einbezogen werden. Die Schweizer CU-Dokumentation weist 13 Monatsgehälter aus, während italienische Steuerregeln eine annualisierte Einkommensmeldung erfordern.',
 ],
 fr: [
 'Le calculateur du 13e mois explique comment la « tredicesima » (13e mois de salaire) fonctionne pour les frontaliers en Suisse. En droit du travail suisse, le 13e mois est une disposition contractuelle plutôt qu\'une obligation légale, mais c\'est la pratique standard dans la plupart des secteurs tessinois, couverte par les conventions collectives (CCT/GAV).',
 'Le calculateur montre la distribution : typiquement versé en décembre comme un salaire mensuel brut complet, soumis aux mêmes déductions sociales (AVS, chômage, LPP) et impôt à la source que le salaire mensuel régulier. Le net du 13e mois peut donc être inférieur aux attentes.',
 'Pour l\'impôt italien, le 13e mois fait partie du revenu total d\'emploi suisse et doit être inclus dans le calcul annuel de l\'IRPEF. La documentation CU suisse reflète 13 mensualités, tandis que les règles fiscales italiennes exigent une déclaration de revenu annualisé.',
 ],
 },

 // ───── About us ─────────────────────────────────────────────
 '/chi-siamo': {
 en: [
 'Frontaliere Ticino is an independent information platform for cross-border workers between Switzerland (Canton Ticino) and Italy. The platform provides free calculators, comparison tools, practical guides, and job listings — all maintained with data from official Swiss and Italian sources.',
 'The project started from the direct experience of cross-border workers who found it difficult to navigate the complex fiscal, administrative, and practical landscape of working in one country and living in another. Every tool is designed to answer real questions with verifiable data.',
 'Content is updated continuously to reflect legislative changes, new tax rates, and evolving bilateral agreements. The platform operates independently of any financial institution, insurance provider, or employer, ensuring unbiased information for all users.',
 ],
 de: [
 'Frontaliere Ticino ist eine unabhängige Informationsplattform für Grenzgänger zwischen der Schweiz (Kanton Tessin) und Italien. Die Plattform bietet kostenlose Rechner, Vergleichstools, praktische Leitfäden und Stellenangebote — alle mit Daten aus offiziellen schweizerischen und italienischen Quellen gepflegt.',
 'Das Projekt entstand aus der direkten Erfahrung von Grenzgängern, die es schwierig fanden, die komplexe steuerliche, administrative und praktische Landschaft der Arbeit in einem Land bei Wohnsitz in einem anderen zu navigieren. Jedes Tool beantwortet echte Fragen mit überprüfbaren Daten.',
 'Inhalte werden kontinuierlich aktualisiert, um Gesetzesänderungen, neue Steuersätze und sich weiterentwickelnde bilaterale Abkommen widerzuspiegeln. Die Plattform arbeitet unabhängig von Finanzinstituten, Versicherungsanbietern oder Arbeitgebern.',
 ],
 fr: [
 'Frontaliere Ticino est une plateforme d\'information indépendante pour les travailleurs frontaliers entre la Suisse (Canton du Tessin) et l\'Italie. La plateforme offre des calculateurs gratuits, des outils de comparaison, des guides pratiques et des offres d\'emploi — le tout alimenté par des données de sources officielles suisses et italiennes.',
 'Le projet est né de l\'expérience directe de frontaliers qui trouvaient difficile de naviguer dans le paysage fiscal, administratif et pratique complexe du travail dans un pays avec résidence dans un autre. Chaque outil répond à de vraies questions avec des données vérifiables.',
 'Le contenu est mis à jour en continu pour refléter les changements législatifs, les nouveaux taux d\'imposition et l\'évolution des accords bilatéraux. La plateforme fonctionne indépendamment de toute institution financière, assureur ou employeur.',
 ],
 },

 // ───── Contact ─────────────────────────────────────────────
 '/contattaci': {
 en: [
 'Frontaliere Ticino is available for questions about taxation, pensions, work permits, and daily life for cross-border workers between Switzerland and Italy. The team responds to practical queries about platform tools, calculator error reports, and suggestions for new features.',
 'Responses are provided within 48 business hours. For complex tax questions (tax returns, tax credits, 2026 new cross-border worker regime), we recommend the dedicated consulting service with professionals specialising in cross-border taxation between Switzerland and Italy.',
 'The platform operates independently of banks, insurance companies, and employers: all information provided is impartial and based on official Swiss and Italian sources (FTA, Italian Revenue Agency, SECO, INPS).',
 ],
 de: [
 'Frontaliere Ticino steht für Fragen zu Besteuerung, Vorsorge, Arbeitsbewilligungen und Alltagsleben für Grenzgänger zwischen der Schweiz und Italien zur Verfügung. Das Team beantwortet praktische Anfragen zu den Plattform-Tools, meldet Rechenfehler und nimmt Vorschläge für neue Funktionen entgegen.',
 'Antworten werden innerhalb von 48 Arbeitsstunden bereitgestellt. Für komplexe Steuerfragen (Steuererklärung, Steuergutschriften, Regelung für neue Grenzgänger 2026) empfehlen wir den dedizierten Beratungsservice mit Fachleuten für grenzüberschreitende Besteuerung.',
 'Die Plattform arbeitet unabhängig von Banken, Versicherungen und Arbeitgebern: Alle bereitgestellten Informationen sind unparteiisch und basieren auf offiziellen Schweizer und italienischen Quellen (ESTV, Agenzia delle Entrate, SECO, INPS).',
 ],
 fr: [
 'Frontaliere Ticino est disponible pour les questions sur la fiscalité, la prévoyance, les permis de travail et la vie quotidienne des travailleurs frontaliers entre la Suisse et l\'Italie. L\'équipe répond aux questions pratiques sur les outils de la plateforme, signalements d\'erreurs et suggestions de nouvelles fonctionnalités.',
 'Les réponses sont fournies dans les 48 heures ouvrables. Pour les questions fiscales complexes (déclaration de revenus, crédits d\'impôt, régime des nouveaux frontaliers 2026), nous recommandons le service de consultation dédié avec des professionnels spécialisés en fiscalité transfrontalière.',
 'La plateforme fonctionne indépendamment des banques, assurances et employeurs : toutes les informations fournies sont impartiales et basées sur des sources officielles suisses et italiennes (AFC, Agenzia delle Entrate, SECO, INPS).',
 ],
 },

 // ───── Consulting ─────────────────────────────────────────────
 '/consulenza': {
 en: [
 'The tax consulting service is designed for cross-border workers who need personalised assistance with taxation, pensions, and fiscal optimisation in the Swiss-Italian cross-border context. Consultants specialise in the regulations of both countries and are up to date on the 2026 New Tax Agreement.',
 'Key areas include: Italian tax returns for Swiss income, choosing the tax regime (old vs new cross-border workers), calculating and applying the €10,000 exemption, optimising foreign tax credits (Art. 165 TUIR), AVS/LPP/pillar 3a pension planning, and choosing between LAMal and NHS.',
 'Each consultation starts from an analysis of your individual situation — marital status, distance from the border, years of employment in Switzerland, gross income — to identify the most advantageous tax strategy.',
 ],
 de: [
 'Der Steuerberatungsservice richtet sich an Grenzgänger, die persönliche Unterstützung bei Besteuerung, Vorsorge und steuerlicher Optimierung im schweizerisch-italienischen Grenzgängerkontext benötigen. Die Berater sind auf die Regelungen beider Länder spezialisiert und auf dem aktuellen Stand des Neuen Steuerabkommens 2026.',
 'Die Hauptbereiche umfassen: italienische Steuererklärung für Schweizer Einkommen, Wahl des Steuerregimes (alte vs. neue Grenzgänger), Berechnung und Anwendung des Freibetrags von €10.000, Optimierung der Steuergutschriften für im Ausland gezahlte Steuern (Art. 165 TUIR), AHV/BVG/Säule-3a-Vorsorgeplanung.',
 'Jede Beratung beginnt mit einer Analyse der individuellen Situation — Familienstand, Entfernung zur Grenze, Beschäftigungsjahre in der Schweiz, Bruttoeinkommen — um die vorteilhafteste Steuerstrategie zu identifizieren.',
 ],
 fr: [
 'Le service de consultation fiscale s\'adresse aux travailleurs frontaliers ayant besoin d\'une assistance personnalisée en matière de fiscalité, prévoyance et optimisation fiscale dans le contexte transfrontalier Suisse-Italie. Les consultants sont spécialisés dans les réglementations des deux pays et à jour sur le Nouvel Accord Fiscal 2026.',
 'Les domaines principaux incluent : déclaration de revenus italienne pour les revenus suisses, choix du régime fiscal (anciens vs nouveaux frontaliers), calcul et application de la franchise de 10 000 €, optimisation des crédits d\'impôt pour impôts payés à l\'étranger (Art. 165 TUIR), planification AVS/LPP/3e pilier.',
 'Chaque consultation part de l\'analyse de la situation individuelle — état civil, distance de la frontière, années d\'emploi en Suisse, revenu brut — pour identifier la stratégie fiscale la plus avantageuse.',
 ],
 },

 // ───── Privacy ─────────────────────────────────────────────
 '/privacy': {
 en: [
 'Frontaliere Ticino processes user personal data in compliance with the General Data Protection Regulation (GDPR, EU Regulation 2016/679) and the Swiss Federal Act on Data Protection (nFADP 2023). The platform does not require mandatory registration: all calculators and comparators can be used without providing personal data.',
 'Data collected (email addresses for job alerts, browsing data via Google Analytics 4) is used exclusively for operating the services requested by the user and for aggregate analysis of platform usage. Data is never shared with third parties for marketing purposes.',
 'Tax and pension simulations run entirely in the user\'s browser: the data entered into calculators (salary, marital status, number of children) is never transmitted to servers. This architecture ensures maximum confidentiality of personal financial information.',
 ],
 de: [
 'Frontaliere Ticino verarbeitet personenbezogene Daten der Nutzer in Übereinstimmung mit der Datenschutz-Grundverordnung (DSGVO, EU-Verordnung 2016/679) und dem Schweizer Bundesgesetz über den Datenschutz (nDSG 2023). Die Plattform erfordert keine obligatorische Registrierung: Alle Rechner und Vergleicher können ohne Angabe persönlicher Daten genutzt werden.',
 'Erhobene Daten (E-Mail-Adressen für Jobbenachrichtigungen, Browsing-Daten über Google Analytics 4) werden ausschließlich für den Betrieb der vom Nutzer angeforderten Dienste und für die aggregierte Analyse der Plattformnutzung verwendet. Daten werden niemals für Marketingzwecke an Dritte weitergegeben.',
 'Steuer- und Vorsorgesimulationen laufen vollständig im Browser des Nutzers: Die in die Rechner eingegebenen Daten (Gehalt, Familienstand, Kinderzahl) werden niemals an Server übertragen. Diese Architektur gewährleistet maximale Vertraulichkeit persönlicher Finanzinformationen.',
 ],
 fr: [
 'Frontaliere Ticino traite les données personnelles des utilisateurs conformément au Règlement Général sur la Protection des Données (RGPD, Règlement UE 2016/679) et à la Loi fédérale suisse sur la protection des données (nLPD 2023). La plateforme ne requiert aucune inscription obligatoire : tous les calculateurs et comparateurs sont utilisables sans fournir de données personnelles.',
 'Les données éventuellement collectées (adresse e-mail pour les alertes emploi, données de navigation via Google Analytics 4) sont utilisées exclusivement pour le fonctionnement des services demandés par l\'utilisateur et pour l\'analyse agrégée de l\'utilisation de la plateforme. Aucune donnée n\'est cédée à des tiers à des fins marketing.',
 'Les simulations fiscales et de prévoyance s\'exécutent entièrement dans le navigateur de l\'utilisateur : les données saisies dans les calculateurs (salaire, état civil, nombre d\'enfants) ne sont jamais transmises aux serveurs. Cette architecture garantit la confidentialité maximale des informations financières personnelles.',
 ],
 },

 // ───── API Status ─────────────────────────────────────────────
 '/stato-api': {
 en: [
 'This page shows the real-time operational status of all external services used by the Frontaliere Ticino platform: CHF/EUR exchange rate (TwelveData API), border crossing traffic (Google Maps API), reCAPTCHA for form protection, and Firebase for storage and configurations.',
 'The platform is designed to work even when one or more external services are temporarily unavailable: exchange rates have a local cache with fallback to the most recent data, border traffic uses estimates based on historical data, and calculators run entirely in the browser without depending on remote servers.',
 'The history of outages and average availability of each service are visible on this page, along with average API latency and data update frequency.',
 ],
 de: [
 'Diese Seite zeigt den Echtzeit-Betriebsstatus aller von der Plattform Frontaliere Ticino genutzten externen Dienste: CHF/EUR-Wechselkurs (TwelveData API), Grenzverkehr (Google Maps API), reCAPTCHA für Formularschutz und Firebase für Speicherung und Konfigurationen.',
 'Die Plattform ist so konzipiert, dass sie auch bei vorübergehender Nichtverfügbarkeit eines oder mehrerer externer Dienste funktioniert: Wechselkurse haben einen lokalen Cache mit Fallback auf die neuesten Daten, und die Rechner laufen vollständig im Browser ohne Abhängigkeit von Remote-Servern.',
 'Die Historie der Ausfälle und die durchschnittliche Verfügbarkeit jedes Dienstes sind auf dieser Seite sichtbar, zusammen mit der durchschnittlichen API-Latenz und der Datenaktualisierungsfrequenz.',
 ],
 fr: [
 'Cette page affiche l\'état opérationnel en temps réel de tous les services externes utilisés par la plateforme Frontaliere Ticino : taux de change CHF/EUR (TwelveData API), trafic aux postes frontière (Google Maps API), reCAPTCHA pour la protection des formulaires et Firebase pour le stockage et les configurations.',
 'La plateforme est conçue pour fonctionner même lorsqu\'un ou plusieurs services externes sont temporairement indisponibles : les taux de change disposent d\'un cache local avec repli sur les données les plus récentes, et les calculateurs fonctionnent entièrement dans le navigateur sans dépendre de serveurs distants.',
 'L\'historique des interruptions et la disponibilité moyenne de chaque service sont visibles sur cette page, ainsi que la latence moyenne des API et la fréquence de mise à jour des données.',
 ],
 },

 // ───── Blog index ─────────────────────────────────────────────
 '/articoli-frontaliere': {
 en: [
 '<strong>Cross-Border Articles</strong> is the editorial hub of Frontaliere Ticino with over 700 in-depth articles for cross-border workers between Italy and Switzerland. Content covers taxation (2026 New Agreement, IRPEF, withholding tax), pensions (AVS, LPP, pillar 3a), practical guides (permits, banking, customs), and legislative updates.',
 'The articles section is built as an editorial hub: each piece dives deep into an operational topic and links to tools or guides so readers can move quickly from news to numerical simulation. Topics range from the 2026 New Agreement taxation rules to practical guides on opening a Swiss bank account.',
 'Main categories: Tax (cross-border taxation, withholding tax, IRPEF), Practical (permits, customs, transport, banking), News (Swiss and Italian legislative updates), Pension (AVS, LPP, pillar 3a). Articles are updated whenever significant regulatory changes occur.',
 'The article library covers a broad range of categories tailored to cross-border worker needs: fiscal deep-dives on the 2026 New Agreement and withholding tax tables, practical guides for opening Swiss bank accounts and transferring vehicles, pension planning articles comparing AVS projections with Italian INPS, job market analyses for Ticino\'s key sectors, and lifestyle content on housing, schools, and healthcare. A search and category filter system helps readers find relevant content quickly.',
 'Every article follows a rigorous editorial approach: content is verified against official sources including Swiss Federal Council publications, Canton Ticino tax authority (Divisione delle contribuzioni) circulars, Italian Agenzia delle Entrate guidelines, and bilateral agreement texts. Articles referencing 2026 regulations are reviewed and updated whenever new implementing provisions are published, ensuring readers always access current and actionable information rather than outdated guidance.',
 ],
 de: [
 '<strong>Grenzgänger-Artikel</strong> ist der redaktionelle Hub von Frontaliere Ticino mit über 700 Vertiefungsartikeln für Grenzgänger zwischen Italien und der Schweiz. Die Inhalte decken Besteuerung (Neues Abkommen 2026, IRPEF, Quellensteuer), Vorsorge (AHV, BVG, Säule 3a), praktische Leitfäden (Bewilligungen, Bank, Zoll) und Gesetzesänderungen ab.',
 'Die Artikelsektion ist als redaktioneller Hub aufgebaut: Jeder Beitrag vertieft ein operatives Thema und verlinkt auf Tools oder Leitfäden, sodass Leser schnell von der Nachricht zur numerischen Simulation gelangen.',
 'Hauptkategorien: Steuer (Grenzgängerbesteuerung, Quellensteuer, IRPEF), Praktisch (Bewilligungen, Zoll, Transport, Bank), Neuigkeiten (Schweizer und italienische Gesetzesänderungen), Vorsorge (AHV, BVG, Säule 3a). Artikel werden bei jeder bedeutenden Rechtsänderung aktualisiert.',
 'Die Artikelbibliothek deckt ein breites Spektrum an Kategorien ab, die auf Grenzgänger-Bedürfnisse zugeschnitten sind: steuerliche Vertiefungen zum Neuen Abkommen 2026 und den Quellensteuertabellen, praktische Leitfäden zur Eröffnung von Schweizer Bankkonten und zum Fahrzeugtransfer, Vorsorge-Artikel mit Vergleichen der AHV-Projektionen und der italienischen INPS, Arbeitsmarktanalysen für die Tessiner Schlüsselbranchen sowie Lifestyle-Inhalte zu Wohnen, Schulen und Gesundheitsversorgung.',
 'Jeder Artikel folgt einem rigorosen redaktionellen Ansatz: Die Inhalte werden anhand offizieller Quellen verifiziert — darunter Publikationen des Schweizer Bundesrats, Rundschreiben der Tessiner Steuerverwaltung (Divisione delle contribuzioni), Leitlinien der italienischen Agenzia delle Entrate und Abkommenstexte. Artikel mit Bezug auf 2026er-Regelungen werden bei jeder neuen Durchführungsbestimmung überprüft und aktualisiert, um stets aktuelle und umsetzbare Informationen zu gewährleisten.',
 ],
 fr: [
 '<strong>Articles Frontalier</strong> est le hub éditorial de Frontaliere Ticino avec plus de 700 articles approfondis pour les travailleurs frontaliers entre l\'Italie et la Suisse. Les contenus couvrent la fiscalité (Nouvel Accord 2026, IRPEF, impôt à la source), la prévoyance (AVS, LPP, 3e pilier), des guides pratiques (permis, banque, douane) et les mises à jour législatives.',
 'La section articles est conçue comme un hub éditorial : chaque contenu approfondit un thème opérationnel et renvoie aux outils ou guides pour passer rapidement de l\'information à la simulation chiffrée.',
 'Catégories principales : Fiscal (fiscalité frontalière, impôt à la source, IRPEF), Pratique (permis, douane, transport, banque), Actualités (mises à jour législatives suisses et italiennes), Prévoyance (AVS, LPP, 3e pilier). Les articles sont mis à jour à chaque modification réglementaire significative.',
 'La bibliothèque d\'articles couvre un large éventail de catégories adaptées aux besoins des frontaliers : analyses fiscales approfondies du Nouvel Accord 2026 et des barèmes d\'imposition à la source, guides pratiques pour l\'ouverture de comptes bancaires suisses et le transfert de véhicules, articles de planification retraite comparant les projections AVS avec l\'INPS italienne, analyses du marché de l\'emploi pour les secteurs clés du Tessin, et contenus lifestyle sur le logement, les écoles et la santé.',
 'Chaque article suit une approche éditoriale rigoureuse : les contenus sont vérifiés auprès de sources officielles incluant les publications du Conseil fédéral suisse, les circulaires de l\'administration fiscale tessinoise (Divisione delle contribuzioni), les directives de l\'Agenzia delle Entrate italienne et les textes des accords bilatéraux. Les articles référençant les réglementations 2026 sont révisés et mis à jour à chaque nouvelle disposition d\'application, garantissant des informations toujours actuelles et exploitables.',
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
