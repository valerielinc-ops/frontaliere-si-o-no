// HowTo translations for structured data (HowTo schema)
// Maps Italian HowTo "name" → { en, de, fr } translations of name, description, and steps
// Used by seoService.ts and staticPagesPlugin.ts to serve locale-appropriate HowTo structured data

export interface HowToStepTranslation {
 name: string;
 text: string;
}

export interface HowToTranslation {
 name: string;
 description: string;
 steps: HowToStepTranslation[];
}

export type HowToLocaleMap = Record<string, { en: HowToTranslation; de: HowToTranslation; fr: HowToTranslation }>;

/**
 * Lookup map: Italian HowTo "name" (trimmed) -> translations in EN/DE/FR.
 * Key = exact Italian "name" field from HowTo entries in seo-pages.ts.
 */
export const HOWTO_TRANSLATIONS: HowToLocaleMap = {
 // ── HowTo 1: Calculator – net salary calculation ──
 "Come calcolare lo stipendio netto da frontaliere Svizzera-Italia": {
 en: {
 name: "How to calculate your net salary as a cross-border worker (Switzerland-Italy)",
 description: "Step-by-step guide to calculating your net salary as a cross-border worker using the free tax simulator from Frontaliere Ticino.",
 steps: [
 { name: "Enter your annual gross salary", text: "Enter your annual gross salary in CHF in the designated field." },
 { name: "Select marital status and children", text: "Choose your marital status (single, married, single parent) and number of children to determine the correct tax table (A, B, C or H)." },
 { name: "Choose old or new cross-border worker status", text: "Indicate whether you were hired before or after 17 July 2023 and whether you live within or beyond 20 km from the Swiss border." },
 { name: "Analyze the results", text: "View the breakdown of withholding tax, social contributions (AVS, AC, LAA, LPP), any Italian IRPEF, and your monthly net salary in CHF and EUR." }
 ]
 },
 de: {
 name: "So berechnen Sie Ihr Nettogehalt als Grenzgaenger (Schweiz-Italien)",
 description: "Schritt-fuer-Schritt-Anleitung zur Berechnung Ihres Nettogehalts als Grenzgaenger mit dem kostenlosen Steuersimulator von Frontaliere Ticino.",
 steps: [
 { name: "Geben Sie Ihr Jahresbruttgehalt ein", text: "Geben Sie Ihr Jahresbruttogehalt in CHF in das vorgesehene Feld ein." },
 { name: "Familienstand und Kinder waehlen", text: "Waehlen Sie Ihren Familienstand (ledig, verheiratet, alleinerziehend) und die Anzahl der Kinder, um die richtige Steuertabelle (A, B, C oder H) zu bestimmen." },
 { name: "Alten oder neuen Grenzgaengerstatus waehlen", text: "Geben Sie an, ob Sie vor oder nach dem 17. Juli 2023 eingestellt wurden und ob Sie innerhalb oder ausserhalb von 20 km von der Schweizer Grenze wohnen." },
 { name: "Ergebnisse analysieren", text: "Sehen Sie die Aufschluesselung von Quellensteuer, Sozialabgaben (AHV, ALV, UVG, BVG), eventueller italienischer IRPEF und Ihrem monatlichen Nettogehalt in CHF und EUR." }
 ]
 },
 fr: {
 name: "Comment calculer votre salaire net en tant que frontalier (Suisse-Italie)",
 description: "Guide etape par etape pour calculer votre salaire net en tant que frontalier avec le simulateur fiscal gratuit de Frontaliere Ticino.",
 steps: [
 { name: "Saisissez votre salaire brut annuel", text: "Saisissez votre salaire brut annuel en CHF dans le champ prevu." },
 { name: "Selectionnez la situation familiale et les enfants", text: "Choisissez votre situation familiale (celibataire, marie(e), parent seul) et le nombre d'enfants pour determiner le bareme d'imposition correct (A, B, C ou H)." },
 { name: "Choisissez ancien ou nouveau frontalier", text: "Indiquez si vous avez ete embauche(e) avant ou apres le 17 juillet 2023 et si vous residez a moins ou plus de 20 km de la frontiere suisse." },
 { name: "Analysez les resultats", text: "Consultez le detail de l'impot a la source, des cotisations sociales (AVS, AC, LAA, LPP), de l'eventuel IRPEF italien et de votre salaire net mensuel en CHF et EUR." }
 ]
 }
 },

 // ── HowTo 2: Transfer car from Italy to Switzerland ──
 "Come trasferire l'auto dall'Italia alla Svizzera": {
 en: {
 name: "How to transfer your car from Italy to Switzerland",
 description: "Step-by-step guide to importing and registering an Italian vehicle in Switzerland",
 steps: [
 { name: "Swiss insurance", text: "Take out liability insurance with a Swiss insurance company" },
 { name: "Customs clearance", text: "Declare the vehicle at Swiss customs using form 18.44" },
 { name: "MFK inspection", text: "Pass the Swiss technical inspection at the Traffic Office (Sezione della Circolazione)" },
 { name: "Registration", text: "Apply for Swiss cantonal license plates" },
 { name: "License conversion", text: "Convert your Italian driving license to a Swiss one within 12 months" }
 ]
 },
 de: {
 name: "So ueberfuehren Sie Ihr Auto von Italien in die Schweiz",
 description: "Schritt-fuer-Schritt-Anleitung zur Einfuhr und Zulassung eines italienischen Fahrzeugs in der Schweiz",
 steps: [
 { name: "Schweizer Versicherung", text: "Schliessen Sie eine Haftpflichtversicherung bei einer Schweizer Versicherungsgesellschaft ab" },
 { name: "Verzollung", text: "Deklarieren Sie das Fahrzeug beim Schweizer Zoll mit dem Formular 18.44" },
 { name: "MFK-Pruefung", text: "Bestehen Sie die technische Pruefung beim Strassenverkehrsamt (Sezione della Circolazione)" },
 { name: "Zulassung", text: "Beantragen Sie die kantonalen Schweizer Kontrollschilder" },
 { name: "Fuehrerschein-Umtausch", text: "Tauschen Sie Ihren italienischen Fuehrerschein innerhalb von 12 Monaten in einen Schweizer um" }
 ]
 },
 fr: {
 name: "Comment transferer votre voiture d'Italie en Suisse",
 description: "Guide etape par etape pour importer et immatriculer un vehicule italien en Suisse",
 steps: [
 { name: "Assurance suisse", text: "Souscrire une assurance RC aupres d'une compagnie suisse" },
 { name: "Dedouanement", text: "Declarer le vehicule a la douane suisse avec le formulaire 18.44" },
 { name: "Controle MFK", text: "Reussir le controle technique suisse aupres de l'Office de la circulation" },
 { name: "Immatriculation", text: "Demander les plaques d'immatriculation cantonales suisses" },
 { name: "Conversion du permis", text: "Convertir votre permis de conduire italien en permis suisse dans les 12 mois" }
 ]
 }
 },

 // ── HowTo 3: First day as a cross-border worker ──
 "Primo Giorno da Frontaliere: Guida Completa": {
 en: {
 name: "First Day as a Cross-Border Worker: Complete Guide",
 description: "Complete checklist for your first day as a cross-border worker: G permit, AIRE registration, bank, insurance, transport",
 steps: [
 { name: "Apply for the G Permit", text: "Apply for a G work permit from Canton Ticino. You need an employment contract, valid ID, and proof of residence in the border zone (within 20 km)." },
 { name: "Register with AIRE", text: "If you are moving to Switzerland, register with AIRE (Registry of Italians Residing Abroad) at the competent Italian consulate within 90 days." },
 { name: "Open a Swiss Bank Account", text: "Open a current account in Switzerland (PostFinance, Raiffeisen, UBS or Credit Suisse) to receive your salary in CHF." },
 { name: "Choose Health Insurance", text: "Choose between Swiss LAMal and Italian SSN (right of option). Compare premiums among the 14 health insurers available for Canton Ticino." },
 { name: "Organize Daily Transport", text: "Plan your commute: car, TILO train, bus, or a combination. Check border crossing wait times and calculate commuting costs." },
 { name: "Understand the Tax Regime", text: "Learn about the applicable tax regime: withholding tax in Switzerland and, for new cross-border workers (from 17/07/2023), also IRPEF in Italy with a EUR 10,000 exemption." }
 ]
 },
 de: {
 name: "Erster Tag als Grenzgaenger: Vollstaendiger Leitfaden",
 description: "Vollstaendige Checkliste fuer den ersten Tag als Grenzgaenger: G-Bewilligung, AIRE-Anmeldung, Bank, Versicherung, Transport",
 steps: [
 { name: "G-Bewilligung beantragen", text: "Beantragen Sie die G-Arbeitsbewilligung beim Kanton Tessin. Sie benoetigen einen Arbeitsvertrag, einen gueltigen Ausweis und einen Wohnsitznachweis in der Grenzzone (innerhalb von 20 km)." },
 { name: "Bei AIRE anmelden", text: "Wenn Sie in die Schweiz ziehen, melden Sie sich innerhalb von 90 Tagen beim zustaendigen italienischen Konsulat bei AIRE (Register der im Ausland lebenden Italiener) an." },
 { name: "Schweizer Bankkonto eroeffnen", text: "Eroeffnen Sie ein Girokonto in der Schweiz (PostFinance, Raiffeisen, UBS oder Credit Suisse), um Ihr Gehalt in CHF zu erhalten." },
 { name: "Krankenversicherung waehlen", text: "Waehlen Sie zwischen Schweizer KVG und italienischem SSN (Optionsrecht). Vergleichen Sie die Praemien der 14 im Kanton Tessin verfuegbaren Krankenkassen." },
 { name: "Taeglichen Transport organisieren", text: "Planen Sie Ihren Arbeitsweg: Auto, TILO-Zug, Bus oder eine Kombination. Pruefen Sie die Wartezeiten an den Grenzuebergaengen und berechnen Sie die Pendelkosten." },
 { name: "Steuerregime verstehen", text: "Informieren Sie sich ueber das geltende Steuerregime: Quellensteuer in der Schweiz und fuer neue Grenzgaenger (ab 17.07.2023) auch IRPEF in Italien mit einem Freibetrag von 10.000 EUR." }
 ]
 },
 fr: {
 name: "Premier jour en tant que frontalier : guide complet",
 description: "Checklist complete pour le premier jour en tant que frontalier : permis G, inscription AIRE, banque, assurance, transports",
 steps: [
 { name: "Demander le permis G", text: "Demandez le permis de travail G aupres du Canton du Tessin. Vous avez besoin d'un contrat de travail, d'une piece d'identite valide et d'un justificatif de domicile dans la zone frontiere (dans les 20 km)." },
 { name: "S'inscrire a l'AIRE", text: "Si vous vous installez en Suisse, inscrivez-vous a l'AIRE (Registre des Italiens residant a l'etranger) aupres du consulat italien competent dans les 90 jours." },
 { name: "Ouvrir un compte bancaire suisse", text: "Ouvrez un compte courant en Suisse (PostFinance, Raiffeisen, UBS ou Credit Suisse) pour recevoir votre salaire en CHF." },
 { name: "Choisir l'assurance maladie", text: "Choisissez entre la LAMal suisse et le SSN italien (droit d'option). Comparez les primes parmi les 14 assureurs disponibles pour le Canton du Tessin." },
 { name: "Organiser le transport quotidien", text: "Planifiez votre trajet domicile-travail : voiture, train TILO, bus ou combinaison. Verifiez les temps d'attente aux postes-frontieres et calculez les couts de pendulaire." },
 { name: "Comprendre le regime fiscal", text: "Renseignez-vous sur le regime fiscal applicable : impot a la source en Suisse et, pour les nouveaux frontaliers (a partir du 17/07/2023), egalement l'IRPEF en Italie avec une franchise de 10 000 EUR." }
 ]
 }
 },

 // ── HowTo 4: Filing tax returns as a cross-border worker ──
 "Compilare la Dichiarazione dei Redditi da Frontaliere": {
 en: {
 name: "Filing Tax Returns as a Cross-Border Worker",
 description: "Step-by-step guide to filing tax returns for cross-border workers between Switzerland and Italy: documents, deductions, deadlines and FAQ.",
 steps: [
 { name: "Overview and tax regime", text: "Understand the applicable tax regime: 2026 new agreement with EUR 10,000 exemption for new cross-border workers, or old agreement for pre-2024 cross-border workers. Check if you need to use the Modello Redditi PF." },
 { name: "Gather documents", text: "Gather all required documents: Lohnausweis (salary certificate), LPP certificate, pillar 3a certificate, medical expense receipts, transport pass, health insurance certificate, CU." },
 { name: "Calculate deductions", text: "Calculate applicable deductions: transport expenses (max CHF 3,200), meals, LPP contributions, pillar 3a (max CHF 7,258), health insurance, child expenses, donations." },
 { name: "2026 tax deadlines", text: "Meet the deadlines: salary certificate (31/01), pre-filled CU (31/03), online pre-filled return (30/04), submit 730 (30/06), submit Redditi PF (30/09), IRPEF advance (30/11)." },
 { name: "Complete and submit", text: "Complete the Modello Redditi PF with section RC for employment income, section CE for tax credit on Swiss taxes, and section RW for monitoring the Swiss bank account." }
 ]
 },
 de: {
 name: "Steuererklaerung als Grenzgaenger ausfuellen",
 description: "Schritt-fuer-Schritt-Anleitung zur Steuererklaerung fuer Grenzgaenger zwischen der Schweiz und Italien: Dokumente, Abzuege, Fristen und FAQ.",
 steps: [
 { name: "Ueberblick und Steuerregime", text: "Verstehen Sie das geltende Steuerregime: Neues Abkommen 2026 mit Freibetrag von 10.000 EUR fuer neue Grenzgaenger oder altes Abkommen fuer Grenzgaenger vor 2024. Pruefen Sie, ob Sie das Modello Redditi PF verwenden muessen." },
 { name: "Dokumente sammeln", text: "Sammeln Sie alle erforderlichen Dokumente: Lohnausweis, BVG-Bescheinigung, Saeulen-3a-Bescheinigung, Arztkosten-Belege, Transportabonnement, Krankenversicherungsbescheinigung, CU." },
 { name: "Abzuege berechnen", text: "Berechnen Sie die anwendbaren Abzuege: Transportkosten (max. CHF 3.200), Verpflegung, BVG-Beitraege, Saeule 3a (max. CHF 7.258), Krankenversicherung, Kinderkosten, Spenden." },
 { name: "Steuerfristen 2026", text: "Halten Sie die Fristen ein: Lohnausweis (31.01.), vorausgefuellte CU (31.03.), Online-Vorausfuellung (30.04.), 730 einreichen (30.06.), Redditi PF einreichen (30.09.), IRPEF-Vorauszahlung (30.11.)." },
 { name: "Ausfuellen und einreichen", text: "Fuellen Sie das Modello Redditi PF aus: Abschnitt RC fuer Arbeitseinkommen, Abschnitt CE fuer die Steuergutschrift auf Schweizer Steuern und Abschnitt RW fuer die Ueberwachung des Schweizer Bankkontos." }
 ]
 },
 fr: {
 name: "Remplir la declaration de revenus en tant que frontalier",
 description: "Guide etape par etape pour la declaration de revenus des frontaliers entre la Suisse et l'Italie : documents, deductions, delais et FAQ.",
 steps: [
 { name: "Apercu et regime fiscal", text: "Comprenez le regime fiscal applicable : nouvel accord 2026 avec franchise de 10 000 EUR pour les nouveaux frontaliers, ou ancien accord pour les frontaliers d'avant 2024. Verifiez si vous devez utiliser le Modello Redditi PF." },
 { name: "Rassembler les documents", text: "Rassemblez tous les documents necessaires : Lohnausweis (certificat de salaire), attestation LPP, attestation pilier 3a, justificatifs de frais medicaux, abonnement transports, attestation assurance maladie, CU." },
 { name: "Calculer les deductions", text: "Calculez les deductions applicables : frais de transport (max CHF 3 200), repas, cotisations LPP, pilier 3a (max CHF 7 258), assurance maladie, frais pour enfants, dons." },
 { name: "Delais fiscaux 2026", text: "Respectez les delais : certificat de salaire (31/01), CU pre-rempli (31/03), declaration pre-remplie en ligne (30/04), envoi 730 (30/06), envoi Redditi PF (30/09), acompte IRPEF (30/11)." },
 { name: "Remplir et envoyer", text: "Remplissez le Modello Redditi PF avec la section RC pour les revenus d'emploi, la section CE pour le credit d'impot sur les taxes suisses et la section RW pour la surveillance du compte bancaire suisse." }
 ]
 }
 },

 // ── HowTo 5: Italian tax return for cross-border workers ──
 "Compilare la Dichiarazione dei Redditi in Italia da Frontaliere": {
 en: {
 name: "Filing Italian Tax Returns as a Cross-Border Worker",
 description: "Guide to the Italian tax return for cross-border workers: documents, IRPEF deductions, tax credit and 2026 deadlines.",
 steps: [
 { name: "Verify tax regime", text: "2026 new agreement with EUR 10,000 exemption or old agreement. Use the Modello Redditi PF." },
 { name: "Gather documents", text: "Lohnausweis, CU, LPP certificate, medical expense receipts and transport receipts." },
 { name: "Calculate deductions", text: "Transport (max EUR 3,200), LPP contributions, pillar 3a, health insurance, children." },
 { name: "Complete and submit", text: "Section RC for income, section CE for tax credit, section RW for Swiss account. Deadline 730: 30/06, Redditi PF: 30/09." }
 ]
 },
 de: {
 name: "Italienische Steuererklaerung als Grenzgaenger ausfuellen",
 description: "Anleitung zur italienischen Steuererklaerung fuer Grenzgaenger: Dokumente, IRPEF-Abzuege, Steuergutschrift und Fristen 2026.",
 steps: [
 { name: "Steuerregime pruefen", text: "Neues Abkommen 2026 mit Freibetrag 10.000 EUR oder altes Abkommen. Verwenden Sie das Modello Redditi PF." },
 { name: "Dokumente sammeln", text: "Lohnausweis, CU, BVG-Bescheinigung, Arztkosten-Belege und Transportbelege." },
 { name: "Abzuege berechnen", text: "Transport (max. 3.200 EUR), BVG-Beitraege, Saeule 3a, Krankenversicherung, Kinder." },
 { name: "Ausfuellen und einreichen", text: "Abschnitt RC fuer Einkommen, Abschnitt CE fuer Steuergutschrift, Abschnitt RW fuer Schweizer Konto. Frist 730: 30.06., Redditi PF: 30.09." }
 ]
 },
 fr: {
 name: "Remplir la declaration de revenus italienne en tant que frontalier",
 description: "Guide pour la declaration de revenus italienne des frontaliers : documents, deductions IRPEF, credit d'impot et delais 2026.",
 steps: [
 { name: "Verifier le regime fiscal", text: "Nouvel accord 2026 avec franchise 10 000 EUR ou ancien accord. Utilisez le Modello Redditi PF." },
 { name: "Rassembler les documents", text: "Lohnausweis, CU, attestation LPP, justificatifs de frais medicaux et de transports." },
 { name: "Calculer les deductions", text: "Transport (max 3 200 EUR), cotisations LPP, pilier 3a, assurance maladie, enfants." },
 { name: "Remplir et envoyer", text: "Section RC pour les revenus, section CE pour le credit d'impot, section RW pour le compte suisse. Delai 730 : 30/06, Redditi PF : 30/09." }
 ]
 }
 },

 // ── HowTo 6: Swiss tax return for cross-border workers ──
 "Dichiarazione Fiscale in Svizzera per Frontalieri": {
 en: {
 name: "Swiss Tax Return for Cross-Border Workers",
 description: "How to file the Swiss tax return as a cross-border worker: withholding tax, TDR, rectification and deductions in Canton Ticino.",
 steps: [
 { name: "Check withholding tax", text: "Check the percentage applied by your employer based on the A/B/C/H tax table for Canton Ticino." },
 { name: "Submit the TDR", text: "Complete the TDR (Tariffa Doganale Ridotta) form for rectification: transport expenses, LPP, pillar 3a, medical expenses." },
 { name: "Cantonal deductions", text: "Deductions for transport (max CHF 3,200), meals, LPP, pillar 3a (max CHF 7,258), health insurance." },
 { name: "Submit and await refund", text: "Submit the TDR to the Tax Office. The refund is credited directly to your bank account." }
 ]
 },
 de: {
 name: "Schweizer Steuererklaerung fuer Grenzgaenger",
 description: "So fuellen Sie die Schweizer Steuererklaerung als Grenzgaenger aus: Quellensteuer, TDR, Berichtigung und Abzuege im Kanton Tessin.",
 steps: [
 { name: "Quellensteuer pruefen", text: "Pruefen Sie den vom Arbeitgeber angewandten Prozentsatz anhand der Steuertabelle A/B/C/H des Kantons Tessin." },
 { name: "TDR einreichen", text: "Fuellen Sie das TDR-Formular (Tariffa Doganale Ridotta) fuer die Berichtigung aus: Transportkosten, BVG, Saeule 3a, Arztkosten." },
 { name: "Kantonale Abzuege", text: "Abzuege fuer Transport (max. CHF 3.200), Verpflegung, BVG, Saeule 3a (max. CHF 7.258), Krankenversicherung." },
 { name: "Einreichen und Rueckerstattung abwarten", text: "Reichen Sie die TDR beim Steueramt ein. Die Rueckerstattung wird direkt auf Ihr Bankkonto gutgeschrieben." }
 ]
 },
 fr: {
 name: "Declaration fiscale en Suisse pour les frontaliers",
 description: "Comment remplir la declaration fiscale suisse en tant que frontalier : impot a la source, TDR, rectification et deductions au Canton du Tessin.",
 steps: [
 { name: "Verifier l'impot a la source", text: "Verifiez le pourcentage applique par votre employeur selon le bareme A/B/C/H du Canton du Tessin." },
 { name: "Soumettre la TDR", text: "Remplissez le formulaire TDR (Tariffa Doganale Ridotta) pour la rectification : frais de transport, LPP, pilier 3a, frais medicaux." },
 { name: "Deductions cantonales", text: "Deductions pour le transport (max CHF 3 200), repas, LPP, pilier 3a (max CHF 7 258), assurance maladie." },
 { name: "Soumettre et attendre le remboursement", text: "Soumettez la TDR a l'Office d'imposition. Le remboursement est credite directement sur votre compte bancaire." }
 ]
 }
 },

 // ── HowTo: Payslip simulator (new frontaliere 2026) ──
 "Come simulare la busta paga del nuovo frontaliere Svizzera-Italia": {
 en: {
 name: "How to simulate the payslip of a new cross-border worker (Switzerland-Italy)",
 description: "Step-by-step guide to simulating a new cross-border worker's payslip for 2026 with Ticino withholding tax, AVS/LPP deductions and CH vs IT net comparison.",
 steps: [
 { name: "Enter the annual gross salary in CHF", text: "Enter the annual gross salary in Swiss francs (CHF) as stated in the employment contract. The simulator automatically derives the monthly gross by dividing by 13 (13th month included)." },
 { name: "Provide age, marital status and children", text: "Select age (drives the LPP rate), marital status (table A single or B married) and number of dependent children. Each child reduces the withholding tax by about one percentage point." },
 { name: "Pick your residence zone (within or beyond 20 km)", text: "Indicate whether you live within 20 km of the Swiss border or beyond. Under the 2026 New Agreement, new cross-border workers within 20 km pay 80% withholding tax in Switzerland and Italian IRPEF with a €10,000 exemption, while beyond 20 km the Swiss withholding is 100%." },
 { name: "Review the Swiss social deductions", text: "Check the breakdown of mandatory contributions: AVS/AI/IPG (5.3%), AD unemployment (1.1%), AINF non-occupational accident insurance, IJM daily sickness allowance, and LPP (2nd pillar, age-bracketed rate 25-65)." },
 { name: "Visualize the withholding tax simulation", text: "See the withholding tax computed on the Ticino cantonal table A/B/C/H 2026, with percentage and CHF amount on a monthly basis." },
 { name: "Compare the Swiss net with the Italian net in euro", text: "Compare the Swiss net with the Italian net taking into account IRPEF and the tax credit: this is the amount actually left to a new cross-border worker in 2026." },
 { name: "Export the payslip to PDF", text: "Download the simulation summary as a PDF including all AVS, AD, AINF, IJM, LPP deductions and withholding tax: useful for comparing it against the real payslip issued by the employer." }
 ]
 },
 de: {
 name: "So simulieren Sie die Lohnabrechnung eines neuen Grenzgaengers (Schweiz-Italien)",
 description: "Schritt-fuer-Schritt-Anleitung zur Simulation der Lohnabrechnung eines neuen Grenzgaengers fuer 2026 mit Tessiner Quellensteuer, AHV/BVG-Abzuegen und Netto-Vergleich CH vs. IT.",
 steps: [
 { name: "Bruttojahresgehalt in CHF eingeben", text: "Geben Sie das Bruttojahresgehalt in Schweizer Franken (CHF) gemaess Arbeitsvertrag ein. Der Simulator berechnet das Monatsbrutto durch Division durch 13 (13. Monatslohn inbegriffen)." },
 { name: "Alter, Zivilstand und Kinder angeben", text: "Waehlen Sie Alter (bestimmt den BVG-Satz), Zivilstand (Tarif A ledig oder B verheiratet) und Anzahl der unterhaltsberechtigten Kinder. Jedes Kind reduziert die Quellensteuer um etwa einen Prozentpunkt." },
 { name: "Wohnzone waehlen (innerhalb oder ausserhalb 20 km)", text: "Geben Sie an, ob Sie innerhalb von 20 km zur Schweizer Grenze wohnen oder weiter entfernt. Nach dem neuen Abkommen 2026 zahlen neue Grenzgaenger innerhalb 20 km 80% Quellensteuer in der Schweiz und italienische IRPEF mit €10'000 Freibetrag, ausserhalb 20 km betraegt die Schweizer Quellensteuer 100%." },
 { name: "Schweizer Sozialabzuege pruefen", text: "Ueberpruefen Sie die Aufschluesselung der obligatorischen Beitraege: AHV/IV/EO (5,3%), ALV Arbeitslosenversicherung (1,1%), UVG Nichtberufsunfallversicherung, Krankentaggeld IJM und BVG (2. Saeule, altersgestaffelter Satz 25-65)." },
 { name: "Quellensteuer-Simulation anzeigen", text: "Sehen Sie die nach dem Tessiner Tarif A/B/C/H 2026 berechnete Quellensteuer mit Prozentsatz und CHF-Betrag auf Monatsbasis." },
 { name: "Schweizer Netto mit italienischem Netto in Euro vergleichen", text: "Vergleichen Sie das Schweizer Netto mit dem italienischen unter Beruecksichtigung von IRPEF und Steuergutschrift: das ist der Betrag, der einem neuen Grenzgaenger 2026 tatsaechlich bleibt." },
 { name: "Lohnabrechnung als PDF exportieren", text: "Laden Sie die Zusammenfassung der Simulation als PDF mit allen Abzuegen AHV, ALV, UVG, IJM, BVG und Quellensteuer herunter: nuetzlich zum Vergleich mit der echten Lohnabrechnung des Arbeitgebers." }
 ]
 },
 fr: {
 name: "Comment simuler la fiche de paie d'un nouveau frontalier (Suisse-Italie)",
 description: "Guide etape par etape pour simuler la fiche de paie d'un nouveau frontalier en 2026 avec l'impot a la source tessinois, les deductions AVS/LPP et la comparaison du net CH vs IT.",
 steps: [
 { name: "Saisissez le salaire brut annuel en CHF", text: "Saisissez le salaire brut annuel en francs suisses (CHF) tel qu'indique sur le contrat de travail. Le simulateur calcule automatiquement le brut mensuel en divisant par 13 (13e mois inclus)." },
 { name: "Indiquez age, etat civil et enfants a charge", text: "Selectionnez l'age (determine le taux LPP), l'etat civil (bareme A celibataire ou B marie) et le nombre d'enfants a charge. Chaque enfant reduit l'impot a la source d'environ un point de pourcentage." },
 { name: "Choisissez la zone de residence (jusqu'a ou au-dela de 20 km)", text: "Indiquez si vous residez a moins de 20 km de la frontiere suisse ou au-dela. Selon le Nouvel Accord 2026, les nouveaux frontaliers dans les 20 km paient 80% d'impot a la source en Suisse et l'IRPEF italien avec une franchise de 10 000 €, au-dela de 20 km la retenue suisse est de 100%." },
 { name: "Verifiez les deductions sociales suisses", text: "Consultez le detail des cotisations obligatoires : AVS/AI/APG (5,3%), AC chomage (1,1%), AANP accident non professionnel, IJM indemnites maladie et LPP (2e pilier, taux par tranche d'age 25-65)." },
 { name: "Visualisez la simulation de l'impot a la source", text: "Consultez l'impot a la source calcule selon le bareme cantonal tessinois A/B/C/H 2026, avec le pourcentage et le montant en CHF sur une base mensuelle." },
 { name: "Comparez le net suisse avec le net italien en euros", text: "Comparez le net suisse au net italien en tenant compte de l'IRPEF et du credit d'impot : c'est le montant qui reste effectivement a un nouveau frontalier en 2026." },
 { name: "Exportez la fiche de paie en PDF", text: "Telechargez le recapitulatif de la simulation en PDF avec toutes les deductions AVS, AC, AANP, IJM, LPP et l'impot a la source : utile pour la comparer a la vraie fiche de paie remise par l'employeur." }
 ]
 }
 }
};

/**
 * Look up a HowTo translation by Italian "name" text.
 * Returns undefined if no translation exists for the given HowTo name.
 */
export function getHowToTranslation(
 italianName: string,
 locale: 'en' | 'de' | 'fr'
): HowToTranslation | undefined {
 const entry = HOWTO_TRANSLATIONS[italianName];
 return entry?.[locale];
}

/**
 * Translate an entire HowTo structured data object for a given locale.
 * Mutates the clone in place. If no translation is found, it stays in Italian.
 */
export function translateHowToSchema(
 howTo: Record<string, any>,
 locale: 'en' | 'de' | 'fr'
): void {
 if (!howTo.name || typeof howTo.name !== 'string') return;
 const translation = getHowToTranslation(howTo.name, locale);
 if (!translation) return;

 howTo.name = translation.name;
 howTo.description = translation.description;

 if (!Array.isArray(howTo.step)) return;
 for (let i = 0; i < howTo.step.length; i++) {
 const step = howTo.step[i];
 if (step['@type'] !== 'HowToStep') continue;
 const translatedStep = translation.steps[i];
 if (translatedStep) {
 step.name = translatedStep.name;
 step.text = translatedStep.text;
 }
 }
}
