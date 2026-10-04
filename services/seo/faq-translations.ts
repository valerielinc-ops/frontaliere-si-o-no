// FAQ translations for structured data (FAQPage schema)
// Maps Italian question text → { en, de, fr } translations of question + answer
// Used by seoService.ts and staticPagesPlugin.ts to serve locale-appropriate FAQ structured data

export interface FaqTranslation {
 q: string;
 a: string;
}

export type FaqLocaleMap = Record<string, { en: FaqTranslation; de: FaqTranslation; fr: FaqTranslation }>;

/**
 * Lookup map: Italian question (trimmed) → translations in EN/DE/FR.
 * Key = exact Italian "name" field from FAQPage mainEntity entries.
 */
export const FAQ_TRANSLATIONS: FaqLocaleMap = {
 // ── Q1: Guide — General frontaliere ──
 "Cos'è un frontaliere e chi può diventarlo?": {
 en: {
 q: "What is a cross-border worker and who can become one?",
 a: "The G permit concerns working in Switzerland with a main residence abroad and return at least weekly. The treaty tax definition is separate: it requires a border-zone municipality, work in the specified region and return home in principle daily. Holding the permit alone does not determine tax status. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Was ist ein Grenzgänger und wer kann einer werden?",
 a: "Die G-Bewilligung betrifft Arbeit in der Schweiz bei Hauptwohnsitz im Ausland und mindestens wöchentlicher Rückkehr. Die steuerliche Abkommensdefinition ist davon getrennt: erforderlich sind eine Grenzgemeinde, Arbeit in der vorgesehenen Region und grundsätzlich tägliche Heimkehr. Der Ausweis allein bestimmt den Steuerstatus nicht. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Qu'est-ce qu'un frontalier et qui peut le devenir ?",
 a: "Le permis G concerne le travail en Suisse avec résidence principale à l’étranger et retour au moins hebdomadaire. La définition fiscale de l’accord est distincte: commune dans la zone frontalière, activité dans la région prévue et retour en principe quotidien. Le permis seul ne détermine pas le statut fiscal. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 // ── Q2: Advantages ──
 "Quali sono i vantaggi di lavorare come frontaliere in Svizzera?": {
 en: {
 q: "What are the advantages of working as a cross-border commuter in Switzerland?",
 a: "Main advantages: salaries 2–3 times higher than in Italy (median CHF 6,500/month in Ticino), robust pension contributions (AVS + LPP + pillar 3a), excellent LAMal healthcare, and the option to live in Italy with lower living costs."
 },
 de: {
 q: "Welche Vorteile hat die Arbeit als Grenzgänger in der Schweiz?",
 a: "Hauptvorteile: Löhne 2–3-mal höher als in Italien (Median CHF 6.500/Monat im Tessin), solide Vorsorgebeiträge (AHV + BVG + Säule 3a), ausgezeichnete KVG-Krankenversicherung und die Möglichkeit, in Italien mit niedrigeren Lebenshaltungskosten zu wohnen."
 },
 fr: {
 q: "Quels sont les avantages de travailler comme frontalier en Suisse ?",
 a: "Avantages principaux : salaires 2 à 3 fois plus élevés qu'en Italie (médiane CHF 6 500/mois au Tessin), cotisations de prévoyance solides (AVS + LPP + pilier 3a), excellente assurance maladie LAMal, et possibilité de vivre en Italie avec un coût de la vie inférieur."
 }
 },

 // ── Q3: Customs ──
 "Come funziona la dogana svizzera per i frontalieri?": {
 en: {
 q: "How does Swiss customs work for cross-border workers?",
 a: "Cross-border workers pass through customs with their G permit. Waiting times vary: 5–15 minutes during normal hours, up to 45–60 minutes during rush hours (7:00–8:30 and 17:00–18:30). Main crossings: Chiasso, Ponte Chiasso, Brogeda, Gaggiolo and Stabio."
 },
 de: {
 q: "Wie funktioniert der Schweizer Zoll für Grenzgänger?",
 a: "Grenzgänger passieren den Zoll mit der G-Bewilligung. Wartezeiten variieren: 5–15 Minuten zu normalen Zeiten, bis 45–60 Minuten zur Hauptverkehrszeit (7:00–8:30 und 17:00–18:30). Wichtigste Übergänge: Chiasso, Ponte Chiasso, Brogeda, Gaggiolo und Stabio."
 },
 fr: {
 q: "Comment fonctionne la douane suisse pour les frontaliers ?",
 a: "Les frontaliers passent la douane avec leur permis G. Les temps d'attente varient : 5 à 15 minutes en heures normales, jusqu'à 45–60 minutes aux heures de pointe (7h00–8h30 et 17h00–18h30). Principaux postes : Chiasso, Ponte Chiasso, Brogeda, Gaggiolo et Stabio."
 }
 },

 // ── Q4: Average salary ──
 "Quanto guadagna in media un frontaliere in Ticino?": {
 en: {
 q: "How much does a cross-border worker earn on average in Ticino?",
 a: "Median gross salary in Canton Ticino is around CHF 5,600/month for cross-border workers (USS data). Skilled positions (IT, engineering, finance) exceed CHF 7,000–9,000/month. Net after withholding tax and social contributions is about 75–82% of gross."
 },
 de: {
 q: "Wie viel verdient ein Grenzgänger im Tessin durchschnittlich?",
 a: "Der Bruttomedianlohn im Kanton Tessin beträgt für Grenzgänger rund CHF 5.600/Monat (USS-Daten). Qualifizierte Positionen (IT, Ingenieurwesen, Finanzen) übersteigen CHF 7.000–9.000/Monat. Der Nettolohn nach Quellensteuer und Sozialabgaben beträgt ca. 75–82 % des Bruttolohns."
 },
 fr: {
 q: "Combien gagne en moyenne un frontalier au Tessin ?",
 a: "Le salaire brut médian au Tessin est d'environ CHF 5 600/mois pour les frontaliers (données USS). Les postes qualifiés (informatique, ingénierie, finance) dépassent CHF 7 000–9 000/mois. Le net après impôt à la source et cotisations sociales est d'environ 75 à 82 % du brut."
 }
 },

 // ── Q5: Unemployment ──
 "Il frontaliere ha diritto alla disoccupazione se perde il lavoro?": {
 en: {
 q: "Is a cross-border worker entitled to unemployment benefits if they lose their job?",
 a: "Yes, the G-permit cross-border worker who loses their job receives Italian unemployment benefits (NASpI), not Swiss ones. EU Regulation 883/2004 provides that cross-border workers in total unemployment are the responsibility of the country of residence."
 },
 de: {
 q: "Hat ein Grenzgänger Anspruch auf Arbeitslosengeld, wenn er seine Stelle verliert?",
 a: "Ja, der Grenzgänger mit G-Bewilligung, der seine Arbeit verliert, erhält italienisches Arbeitslosengeld (NASpI), nicht schweizerisches. Die EU-Verordnung 883/2004 sieht vor, dass Grenzgänger bei Vollarbeitslosigkeit vom Wohnsitzstaat betreut werden."
 },
 fr: {
 q: "Un frontalier a-t-il droit au chômage s'il perd son emploi ?",
 a: "Oui, le frontalier titulaire d'un permis G qui perd son emploi perçoit l'allocation chômage italienne (NASpI), et non suisse. Le règlement UE 883/2004 prévoit que les travailleurs frontaliers en chômage complet relèvent du pays de résidence."
 }
 },

 // ── Q6: 2026 taxation ──
 "Come funziona la tassazione dei frontalieri nel 2026?": {
 en: {
 q: "How does the taxation of cross-border workers work in 2026?",
 a: "Since 2024, new tax cross-border workers qualifying under the agreement pay 80% of ordinary Swiss withholding tax and Italian tax with credit for Swiss tax. They meet the tax definition but do not qualify under Article 9 through eligible employment between 31 December 2018 and 17 July 2023. The Italian €10,000 allowance separately requires the conditions of Italian law. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Wie funktioniert die Besteuerung der Grenzgänger im Jahr 2026?",
 a: "Seit 2024 zahlen neue steuerliche Grenzgänger im Sinne des Abkommens 80% der ordentlichen Schweizer Quellensteuer und italienische Steuer mit Anrechnung der Schweizer Steuer. Sie erfüllen die steuerliche Definition, profitieren jedoch nicht aufgrund qualifizierender Beschäftigung zwischen dem 31. Dezember 2018 und dem 17. Juli 2023 von Artikel 9. Der italienische Freibetrag von 10.000 € setzt gesondert die italienischen gesetzlichen Bedingungen voraus. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Comment fonctionne l'imposition des frontaliers en 2026 ?",
 a: "Depuis 2024, les nouveaux frontaliers fiscaux admis par l’accord paient 80% de l’impôt suisse à la source ordinaire et l’impôt italien avec crédit pour l’impôt suisse. Ils répondent à la définition fiscale sans bénéficier de l’article 9 grâce à une activité admissible entre le 31 décembre 2018 et le 17 juillet 2023. La franchise italienne de 10.000 € exige séparément les conditions de la loi italienne. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 // ── Q7: Swiss tax rates ──
 "Quanto paga di tasse un frontaliere in Svizzera?": {
 en: {
 q: "How much tax does a cross-border worker pay in Switzerland?",
 a: "Ticino withholding tax rates range from about 3% to 18% of gross salary, depending on marital status, number of children, and income bracket. The applicable table is A (single), B (married single earner), C (married dual earner), or H (single parent). The rate is applied monthly by the employer."
 },
 de: {
 q: "Wie viel Steuern zahlt ein Grenzgänger in der Schweiz?",
 a: "Die Quellensteuersätze im Tessin reichen von ca. 3 % bis 18 % des Bruttolohns, abhängig von Familienstand, Kinderzahl und Einkommensstufe. Die Tariftabelle ist A (ledig), B (verheiratet, Alleinverdiener), C (verheiratet, Doppelverdiener) oder H (Alleinerziehend). Der Satz wird monatlich vom Arbeitgeber abgezogen."
 },
 fr: {
 q: "Combien d'impôts paie un frontalier en Suisse ?",
 a: "Les taux d'imposition à la source au Tessin vont d'environ 3 % à 18 % du salaire brut, selon l'état civil, le nombre d'enfants et la tranche de revenu. Le barème applicable est A (célibataire), B (marié, seul revenu), C (marié, double revenu) ou H (famille monoparentale). Le taux est prélevé mensuellement par l'employeur."
 }
 },

 // ── Q8: IRPEF obligation ──
 "Il frontaliere deve pagare l'IRPEF in Italia?": {
 en: {
 q: "Does a cross-border worker have to pay IRPEF in Italy?",
 a: "IRPEF is calculated on the Swiss income converted to EUR minus the €10,000 exemption, using the progressive brackets (23%, 33%, 43%). A tax credit is applied for the Swiss withholding tax paid to avoid double taxation. The regional and municipal surtaxes are also due."
 },
 de: {
 q: "Muss ein Grenzgänger in Italien IRPEF zahlen?",
 a: "Die IRPEF wird auf das in EUR umgerechnete Schweizer Einkommen abzüglich des Freibetrags von 10.000 € berechnet, unter Anwendung der Progressionsstufen (23 %, 33 %, 43 %). Für die in der Schweiz gezahlte Quellensteuer wird eine Steuergutschrift gewährt, um Doppelbesteuerung zu vermeiden. Regionale und kommunale Zuschläge fallen ebenfalls an."
 },
 fr: {
 q: "Le frontalier doit-il payer l'IRPEF en Italie ?",
 a: "L'IRPEF est calculée sur le revenu suisse converti en EUR moins la franchise de 10 000 €, selon les tranches progressives (23 %, 33 %, 43 %). Un crédit d'impôt est accordé pour l'impôt à la source suisse payé afin d'éviter la double imposition. Les surtaxes régionales et communales s'appliquent également."
 }
 },

 // ── Q9: Pillar 3a overview ──
 "Cos'è il terzo pilastro 3a e conviene al frontaliere?": {
 en: {
 q: "What is pillar 3a and is it beneficial for a cross-border worker?",
 a: "Pillar 3a is restricted individual pension provision. Its suitability depends on eligibility, costs, restrictions and tax treatment, not a guaranteed refund. ESTV FAQ 5.3 excludes subsequent ordinary assessment (TOU) for fiscal frontier workers covered by the Italy–Switzerland agreement. Other categories must check eligibility and procedure with the tax authority. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Was ist die Säule 3a und lohnt sie sich für Grenzgänger?",
 a: "Die Säule 3a ist gebundene individuelle Vorsorge. Ihr Nutzen hängt von Zugang, Kosten, Bindungen und Besteuerung ab, nicht von einer garantierten Rückerstattung. Laut ESTV-FAQ 5.3 ist die nachträgliche ordentliche Veranlagung für steuerliche Grenzgänger des Abkommens Italien–Schweiz ausgeschlossen. Andere Kategorien müssen Voraussetzungen und Verfahren bei der Steuerbehörde prüfen. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Qu'est-ce que le pilier 3a et est-il avantageux pour un frontalier ?",
 a: "Le 3a est une prévoyance individuelle liée. Son intérêt dépend de l’accès, des frais, des contraintes et du traitement fiscal, sans remboursement garanti. La FAQ 5.3 de l’AFC exclut la taxation ordinaire ultérieure pour les frontaliers fiscaux de l’accord Italie–Suisse. Les autres catégories doivent vérifier les conditions et la procédure auprès de l’autorité fiscale. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 // ── Q10: AVS pension calculation ──
 "Come si calcola la pensione AVS per un frontaliere?": {
 en: {
 q: "How is the AVS pension calculated for a cross-border worker?",
 a: "The AVS pension is based on contribution years and average career income. A full pension (44 years of contributions) ranges from CHF 1,225 to CHF 2,450/month (2026). Missing years reduce the pension by 1/44 per gap year. Swiss and Italian contribution periods can be totalized under the bilateral agreement. According to Andrea Fiorini, pension planning consultant: 'Even a few years of AVS contributions generate pension rights thanks to totalization with INPS periods'."
 },
 de: {
 q: "Wie wird die AHV-Rente für einen Grenzgänger berechnet?",
 a: "Die AHV-Rente basiert auf Beitragsjahren und dem durchschnittlichen Karriereeinkommen. Eine Vollrente (44 Beitragsjahre) liegt zwischen CHF 1.225 und CHF 2.450/Monat (2026). Fehlende Jahre reduzieren die Rente um 1/44 pro Lückenjahr. Schweizerische und italienische Beitragszeiten können gemäss dem bilateralen Abkommen zusammengerechnet werden. Wie Andrea Fiorini, Vorsorgeberater, erklärt: «Selbst wenige Jahre AHV-Beiträge begründen dank der Zusammenrechnung mit INPS-Zeiten einen Rentenanspruch»."
 },
 fr: {
 q: "Comment la rente AVS est-elle calculée pour un frontalier ?",
 a: "La rente AVS est basée sur les années de cotisation et le revenu moyen de carrière. Une rente complète (44 ans de cotisations) varie de CHF 1 225 à CHF 2 450/mois (2026). Les années manquantes réduisent la rente de 1/44 par année lacunaire. Les périodes de cotisation suisses et italiennes peuvent être totalisées en vertu de l'accord bilatéral. Comme l'explique Andrea Fiorini, conseiller en prévoyance: «Même quelques années de cotisations AVS génèrent un droit à la retraite grâce à la totalisation avec les périodes INPS»."
 }
 },

 // ── Q11: LPP withdrawal ──
 "Posso riscuotere il secondo pilastro LPP quando lascio la Svizzera?": {
 en: {
 q: "Can I withdraw my 2nd pillar (LPP) when I leave Switzerland?",
 a: "If you permanently leave Switzerland for an EU country, you can withdraw the extra-mandatory portion of the 2nd pillar. The mandatory portion is frozen in a vested benefits account (conto di libero passaggio) until the legal retirement age. If you leave for a non-EU country, the entire capital can be withdrawn. According to Andrea Fiorini, pension planning consultant: 'Before withdrawal, it is essential to evaluate the taxation in the canton where the pension fund is domiciled, as rates vary significantly'."
 },
 de: {
 q: "Kann ich die 2. Säule (BVG) abheben, wenn ich die Schweiz verlasse?",
 a: "Bei dauerhaftem Wegzug in ein EU-Land können Sie den überobligatorischen Teil der 2. Säule beziehen. Der obligatorische Teil wird auf einem Freizügigkeitskonto eingefroren, bis das gesetzliche Rentenalter erreicht ist. Bei Wegzug in ein Nicht-EU-Land kann das gesamte Kapital bezogen werden. Wie Andrea Fiorini, Vorsorgeberater, erklärt: «Vor dem Bezug ist es wichtig, die Besteuerung im Sitzkanton der Pensionskasse zu prüfen, da die Sätze erheblich variieren»."
 },
 fr: {
 q: "Puis-je retirer mon 2e pilier (LPP) en quittant la Suisse ?",
 a: "Si vous quittez définitivement la Suisse pour un pays de l'UE, vous pouvez retirer la part surobligatoire du 2e pilier. La part obligatoire est gelée sur un compte de libre passage jusqu'à l'âge légal de la retraite. En cas de départ vers un pays hors UE, la totalité du capital peut être retirée. Comme l'explique Andrea Fiorini, conseiller en prévoyance: «Avant le retrait, il est essentiel d'évaluer la fiscalité dans le canton de domicile de la caisse de pension, car les taux varient considérablement»."
 }
 },

 // ── Q12: Contribution totalization ──
 "Come funziona la totalizzazione dei contributi Svizzera-Italia?": {
 en: {
 q: "How does the totalization of contributions between Switzerland and Italy work?",
 a: "Under the EU bilateral agreement, contribution periods in Switzerland (AVS) and Italy (INPS) are summed to reach the minimum thresholds. Each country pays a partial pension proportional to the years contributed there. The request is made to the country of residence (INPS for Italian residents)."
 },
 de: {
 q: "Wie funktioniert die Zusammenrechnung der Beiträge zwischen der Schweiz und Italien?",
 a: "Gemäss dem bilateralen EU-Abkommen werden Beitragszeiten in der Schweiz (AHV) und in Italien (INPS) addiert, um die Mindestanforderungen zu erfüllen. Jedes Land zahlt eine Teilrente proportional zu den dort geleisteten Beitragsjahren. Der Antrag wird im Wohnsitzstaat gestellt (INPS für Einwohner Italiens)."
 },
 fr: {
 q: "Comment fonctionne la totalisation des cotisations entre la Suisse et l'Italie ?",
 a: "En vertu de l'accord bilatéral UE, les périodes de cotisation en Suisse (AVS) et en Italie (INPS) sont additionnées pour atteindre les seuils minimaux. Chaque pays verse une pension partielle proportionnelle aux années cotisées. La demande est faite auprès du pays de résidence (INPS pour les résidents italiens)."
 }
 },

 // ── Q13: Retirement age ──
 "A che età va in pensione un frontaliere svizzero?": {
 en: {
 q: "At what age does a Swiss cross-border worker retire?",
 a: "The Swiss legal retirement age is 65 for men and 64 for women (gradually rising to 65 from 2025). In Italy the retirement age is 67. A cross-border worker can draw pensions at different ages from each country based on the respective contribution periods."
 },
 de: {
 q: "Wann geht ein Schweizer Grenzgänger in Rente?",
 a: "Das gesetzliche Rentenalter in der Schweiz beträgt 65 für Männer und 64 für Frauen (schrittweise Anhebung auf 65 ab 2025). In Italien liegt das Rentenalter bei 67. Ein Grenzgänger kann zu unterschiedlichen Zeitpunkten Renten aus jedem Land beziehen, basierend auf den jeweiligen Beitragszeiten."
 },
 fr: {
 q: "À quel âge un frontalier suisse part-il à la retraite ?",
 a: "L'âge légal de la retraite en Suisse est de 65 ans pour les hommes et 64 ans pour les femmes (augmentation progressive à 65 ans dès 2025). En Italie, l'âge de la retraite est de 67 ans. Un frontalier peut percevoir des rentes à des âges différents de chaque pays selon les périodes de cotisation respectives."
 }
 },

 // ── Q14: Employer LPP contributions ──
 "Quanto contribuisce il datore di lavoro svizzero alla pensione LPP?": {
 en: {
 q: "How much does the Swiss employer contribute to the LPP pension?",
 a: "The employer must contribute at least as much as the employee. The contribution rates increase with age: 7% (25–34), 10% (35–44), 15% (45–54), 18% (55–65) of the coordinated salary. Many employers contribute more through extra-mandatory plans."
 },
 de: {
 q: "Wie viel trägt der Schweizer Arbeitgeber zur BVG-Pension bei?",
 a: "Der Arbeitgeber muss mindestens gleich viel beitragen wie der Arbeitnehmer. Die Beitragssätze steigen mit dem Alter: 7 % (25–34), 10 % (35–44), 15 % (45–54), 18 % (55–65) des koordinierten Lohns. Viele Arbeitgeber leisten über überobligatorische Pläne höhere Beiträge."
 },
 fr: {
 q: "Quelle est la contribution de l'employeur suisse à la pension LPP ?",
 a: "L'employeur doit cotiser au moins autant que l'employé. Les taux de cotisation augmentent avec l'âge : 7 % (25–34 ans), 10 % (35–44 ans), 15 % (45–54 ans), 18 % (55–65 ans) du salaire coordonné. Beaucoup d'employeurs cotisent davantage via des plans surobligatoires."
 }
 },

 // ── Q15: Italian tax return deadline ──
 "Quando scade la dichiarazione dei redditi per frontalieri in Italia?": {
 en: {
 q: "When is the tax return deadline for cross-border workers in Italy?",
 a: "Model 730 (if applicable) by 30 September 2026. Modello Redditi PF (ex Unico) by 30 November 2026. First IRPEF instalment (40%) by 30 June 2026. Second instalment (60%) by 30 November 2026. Balance from the previous year's return by 30 June 2026."
 },
 de: {
 q: "Wann ist die Abgabefrist der Steuererklärung für Grenzgänger in Italien?",
 a: "Modell 730 (falls zutreffend) bis 30. September 2026. Modello Redditi PF (ex Unico) bis 30. November 2026. Erste IRPEF-Rate (40 %) bis 30. Juni 2026. Zweite Rate (60 %) bis 30. November 2026. Saldo aus der Vorjahreserklärung bis 30. Juni 2026."
 },
 fr: {
 q: "Quelle est la date limite de la déclaration fiscale pour les frontaliers en Italie ?",
 a: "Modèle 730 (le cas échéant) avant le 30 septembre 2026. Modello Redditi PF (ex Unico) avant le 30 novembre 2026. Premier acompte IRPEF (40 %) avant le 30 juin 2026. Deuxième acompte (60 %) avant le 30 novembre 2026. Solde de la déclaration précédente avant le 30 juin 2026."
 }
 },

 // ── Q16: TDR rectification deadline ──
 "Entro quando va richiesta la rettifica TDR in Svizzera?": {
 en: {
 q: "By when must the TDR rectification be requested in Switzerland?",
 a: "The TDR rectification is submitted to the Cantonal Tax Office before 31 March of the year following the tax year. You need: salary statement, LAMal receipts, pillar 3a contributions, transport costs, and medical expenses. The form can be downloaded from the tax authority website or submitted electronically."
 },
 de: {
 q: "Bis wann muss die TDR-Berichtigung in der Schweiz beantragt werden?",
 a: "Die TDR-Berichtigung wird bis zum 31. März des Folgejahres beim kantonalen Steueramt eingereicht. Benötigt werden: Lohnausweis, KVG-Belege, Säule-3a-Beiträge, Transportkosten und Arztkosten. Das Formular kann von der Website der Steuerbehörde heruntergeladen oder elektronisch eingereicht werden."
 },
 fr: {
 q: "Avant quand faut-il demander la rectification TDR en Suisse ?",
 a: "La rectification TDR est soumise à l'Office cantonal des impôts avant le 31 mars de l'année suivant l'année fiscale. Documents nécessaires : certificat de salaire, quittances LAMal, cotisations pilier 3a, frais de transport et frais médicaux. Le formulaire peut être téléchargé du site de l'autorité fiscale ou soumis électroniquement."
 }
 },

 // ── Q17: Salary certificate issuance ──
 "Quando viene emesso il certificato di salario svizzero?": {
 en: {
 q: "When is the Swiss salary certificate issued?",
 a: "The salary certificate (Lohnausweis) is the official document issued by the Swiss employer that details gross salary, social contributions, withholding tax, and benefits in kind. It serves for the TDR rectification in Switzerland and the Italian tax return (Modello Redditi PF)."
 },
 de: {
 q: "Wann wird der Schweizer Lohnausweis ausgestellt?",
 a: "Der Lohnausweis ist das offizielle Dokument des Schweizer Arbeitgebers, das Bruttolohn, Sozialabzüge, Quellensteuer und Naturalleistungen aufführt. Er dient für die TDR-Berichtigung in der Schweiz und die italienische Steuererklärung (Modello Redditi PF)."
 },
 fr: {
 q: "Quand le certificat de salaire suisse est-il émis ?",
 a: "Le certificat de salaire (Lohnausweis) est le document officiel émis par l'employeur suisse détaillant le salaire brut, les cotisations sociales, l'impôt à la source et les avantages en nature. Il sert pour la rectification TDR en Suisse et la déclaration fiscale italienne (Modello Redditi PF)."
 }
 },

 // ── Q18: Tax tables ──
 "Qual e la differenza tra tabella A, B, C e H?": {
 en: {
 q: "What is the difference between withholding tax tables A, B, C, and H?",
 a: "Table A: single without children. Table B: married with single-earner household. Table C: married with dual-earner household. Table H: single parent (widowed, divorced, separated or unmarried with dependants). Each table has different rates reflecting the personal situation."
 },
 de: {
 q: "Was ist der Unterschied zwischen den Quellensteuertarifen A, B, C und H?",
 a: "Tarif A: ledig ohne Kinder. Tarif B: verheiratet, Alleinverdiener-Haushalt. Tarif C: verheiratet, Doppelverdiener-Haushalt. Tarif H: Alleinerziehende (verwitwet, geschieden, getrennt oder unverheiratet mit Unterhaltsberechtigten). Jeder Tarif hat unterschiedliche Sätze entsprechend der persönlichen Situation."
 },
 fr: {
 q: "Quelle est la différence entre les barèmes d'impôt à la source A, B, C et H ?",
 a: "Barème A : célibataire sans enfants. Barème B : marié, ménage à revenu unique. Barème C : marié, ménage à double revenu. Barème H : famille monoparentale (veuf, divorcé, séparé ou non marié avec personnes à charge). Chaque barème a des taux différents reflétant la situation personnelle."
 }
 },

 // ── Q19: IRPEF instalments ──
 "Quali sono le scadenze per il versamento dell'acconto IRPEF?": {
 en: {
 q: "What are the deadlines for paying IRPEF instalments?",
 a: "The first IRPEF instalment (40%) is due by 30 June 2026. The second instalment (60%) is due by 30 November 2026. For amounts below €257.52, the instalment is paid in a single payment in November."
 },
 de: {
 q: "Welche Fristen gelten für die IRPEF-Vorauszahlungen?",
 a: "Die erste IRPEF-Vorauszahlung (40 %) ist bis zum 30. Juni 2026 fällig. Die zweite Rate (60 %) ist bis zum 30. November 2026 fällig. Bei Beträgen unter 257,52 € wird die Vorauszahlung als Einmalzahlung im November geleistet."
 },
 fr: {
 q: "Quelles sont les échéances de versement des acomptes IRPEF ?",
 a: "Le premier acompte IRPEF (40 %) est dû avant le 30 juin 2026. Le deuxième acompte (60 %) est dû avant le 30 novembre 2026. Pour les montants inférieurs à 257,52 €, l'acompte est versé en un seul paiement en novembre."
 }
 },

 // ── Q20: Permit G requirements ──
 "Quali sono i requisiti per ottenere il permesso G frontaliere?": {
 en: {
 q: "What are the requirements to obtain a cross-border G permit?",
 a: "The EU/EFTA G permit covers residents of the EU/EFTA working in Switzerland who return to their foreign home at least weekly. Border zones for this permit have been abolished; the fiscal 20 km condition is separate. https://www.sem.admin.ch/sem/it/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html"
 },
 de: {
 q: "Welche Voraussetzungen gelten für die Grenzgängerbewilligung G?",
 a: "Die G-Bewilligung EU/EFTA betrifft Personen mit Wohnsitz in der EU/EFTA, die in der Schweiz arbeiten und mindestens wöchentlich heimkehren. Grenzzonen für diese Bewilligung sind aufgehoben; die steuerliche 20-km-Regel ist davon getrennt. https://www.sem.admin.ch/sem/it/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html"
 },
 fr: {
 q: "Quelles sont les conditions pour obtenir un permis G frontalier ?",
 a: "Le permis G UE/AELE concerne les résidents de l’UE/AELE travaillant en Suisse et rentrant au domicile étranger au moins chaque semaine. Les zones frontalières pour ce permis sont abolies ; la condition fiscale des 20 km est distincte. https://www.sem.admin.ch/sem/it/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html"
 }
 },

 // ── Q21: Permit G duration ──
 "Quanto dura il permesso G e come si rinnova?": {
 en: {
 q: "How long does the G permit last and how is it renewed?",
 a: "For EU/EFTA citizens, G permits last five years for permanent contracts or contracts exceeding one year; shorter contracts have matching validity. Work up to three months per calendar year follows the notification procedure. Renewal requires the cantonal procedure and continued eligibility. https://www.sem.admin.ch/sem/it/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html"
 },
 de: {
 q: "Wie lange gilt die G-Bewilligung und wie wird sie verlängert?",
 a: "Für EU/EFTA-Angehörige gilt G fünf Jahre bei unbefristeten Verträgen oder Verträgen über einem Jahr; bei kürzeren Verträgen entspricht die Gültigkeit der Vertragsdauer. Für Arbeit bis drei Monate pro Kalenderjahr gilt das Meldeverfahren. Die Verlängerung erfordert das kantonale Verfahren und weiterhin erfüllte Voraussetzungen. https://www.sem.admin.ch/sem/it/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html"
 },
 fr: {
 q: "Quelle est la durée du permis G et comment le renouveler ?",
 a: "Pour les citoyens UE/AELE, le permis G vaut cinq ans avec un contrat indéterminé ou supérieur à un an ; pour un contrat plus court, sa validité suit le contrat. Les activités jusqu’à trois mois par année civile relèvent de la notification. Le renouvellement suit la procédure cantonale et exige le maintien des conditions. https://www.sem.admin.ch/sem/it/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html"
 }
 },

 // ── Q22: G vs B permit ──
 "Qual è la differenza tra permesso G e permesso B?": {
 en: {
 q: "What is the difference between the G permit and the B permit?",
 a: "G permits concern residence abroad and at least weekly return; B permits concern residence in Switzerland. The permit alone does not determine taxation: G holders may qualify as old fiscal frontier workers, new ones or fall outside the agreement. Compare actual residence, income and household costs rather than using a universal salary threshold. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Was ist der Unterschied zwischen G- und B-Bewilligung?",
 a: "Die G-Bewilligung betrifft Wohnsitz im Ausland mit mindestens wöchentlicher Rückkehr, die B-Bewilligung den Aufenthalt in der Schweiz. Die Bewilligung allein bestimmt die Steuern nicht: Bei G sind alte und neue steuerliche Grenzgänger sowie Personen ausserhalb des Abkommens zu unterscheiden. Massgeblich sind tatsächlicher Wohnsitz, Einkommen und Haushaltskosten, keine pauschale Lohngrenze. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Quelle est la différence entre le permis G et le permis B ?",
 a: "Le permis G implique un domicile à l’étranger et un retour au moins hebdomadaire ; le B concerne le séjour en Suisse. Le permis seul ne détermine pas les impôts : les titulaires G peuvent relever des anciens frontaliers fiscaux, des nouveaux ou être hors accord. Comparer résidence effective, revenu et frais du ménage sans seuil salarial universel. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 // ── Q23: Job change with G permit ──
 "Un frontaliere con permesso G può cambiare lavoro liberamente?": {
 en: {
 q: "Can a cross-border worker with a G permit change jobs freely?",
 a: "Yes, with a G permit an EU citizen can change employer freely. However, the new employer must report the hire to the Migration Office, which will update the permit."
 },
 de: {
 q: "Kann ein Grenzgänger mit G-Bewilligung frei den Arbeitgeber wechseln?",
 a: "Ja, mit einer G-Bewilligung kann ein EU-Bürger den Arbeitgeber frei wechseln. Der neue Arbeitgeber muss jedoch die Anstellung dem Migrationsamt melden, das die Bewilligung aktualisiert."
 },
 fr: {
 q: "Un frontalier avec un permis G peut-il changer d'emploi librement ?",
 a: "Oui, avec un permis G, un citoyen de l'UE peut changer d'employeur librement. Le nouvel employeur doit cependant signaler l'embauche à l'Office de la migration, qui mettra à jour le permis."
 }
 },

 // ── Q24: G permit cost ──
 "Quanto costa il permesso G frontaliere?": {
 en: {
 q: "How much does the cross-border G permit cost?",
 a: "In Ticino, EU/EFTA G permit issuance and renewal cost CHF 75 for adults and CHF 40 for minors. Job changes, other procedures and other nationalities have different fees; consult the SPOP schedule. https://www4.ti.ch/di/spop/stranieri/richiesta-nuovo-g/"
 },
 de: {
 q: "Wie viel kostet die Grenzgängerbewilligung G?",
 a: "Im Tessin kosten Ausstellung und Verlängerung der G-Bewilligung EU/EFTA CHF 75 für Erwachsene und CHF 40 für Minderjährige. Arbeitgeberwechsel, andere Verfahren und andere Staatsangehörigkeiten haben eigene Tarife; siehe SPOP. https://www4.ti.ch/di/spop/stranieri/richiesta-nuovo-g/"
 },
 fr: {
 q: "Combien coûte le permis G frontalier ?",
 a: "Au Tessin, délivrance et renouvellement du permis G UE/AELE coûtent CHF 75 pour un adulte et CHF 40 pour un mineur. Changements d’emploi, autres démarches et autres nationalités ont des tarifs distincts ; consulter le SPOP. https://www4.ti.ch/di/spop/stranieri/richiesta-nuovo-g/"
 }
 },

 // ── Q25: Pillar 3a 2026 max ──
 "Qual è il limite massimo di versamento nel pilastro 3a nel 2026?": {
 en: {
 q: "What is the maximum pillar 3a contribution in 2026?",
 a: "The contribution cap depends on second-pillar affiliation: check the FOSI 2026 limits with your provider. A contribution limit does not guarantee a tax benefit. ESTV FAQ 5.3 excludes subsequent ordinary assessment (TOU) for fiscal frontier workers covered by the Italy–Switzerland agreement. Other categories must check eligibility and procedure with the tax authority. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Wie hoch ist der maximale Einzahlungsbetrag in die Säule 3a im Jahr 2026?",
 a: "Der Höchstbetrag hängt vom Anschluss an die zweite Säule ab: Die BSV-Grenzen für 2026 mit der Vorsorgeeinrichtung prüfen. Ein Einzahlungslimit garantiert keinen Steuervorteil. Laut ESTV-FAQ 5.3 ist die nachträgliche ordentliche Veranlagung für steuerliche Grenzgänger des Abkommens Italien–Schweiz ausgeschlossen. Andere Kategorien müssen Voraussetzungen und Verfahren bei der Steuerbehörde prüfen. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Quel est le montant maximal de versement au pilier 3a en 2026 ?",
 a: "Le plafond dépend de l’affiliation au deuxième pilier : vérifier les limites OFAS 2026 avec l’institution. Un plafond de versement ne garantit pas d’avantage fiscal. La FAQ 5.3 de l’AFC exclut la taxation ordinaire ultérieure pour les frontaliers fiscaux de l’accord Italie–Suisse. Les autres catégories doivent vérifier les conditions et la procédure auprès de l’autorité fiscale. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 // ── Q26: G permit 3a eligibility ──
 "Un frontaliere con permesso G può aprire un pilastro 3a?": {
 en: {
 q: "Can a cross-border worker with a G permit open a pillar 3a account?",
 a: "Check access to pillar 3a with the pension provider based on employment and social-insurance status. Opening an account does not establish tax deductibility. ESTV FAQ 5.3 excludes subsequent ordinary assessment (TOU) for fiscal frontier workers covered by the Italy–Switzerland agreement. Other categories must check eligibility and procedure with the tax authority. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Kann ein Grenzgänger mit G-Bewilligung ein Säule-3a-Konto eröffnen?",
 a: "Den Zugang zur Säule 3a anhand von Erwerbstätigkeit und Sozialversicherung mit der Vorsorgeeinrichtung prüfen. Eine Kontoeröffnung begründet keinen Steuerabzug. Laut ESTV-FAQ 5.3 ist die nachträgliche ordentliche Veranlagung für steuerliche Grenzgänger des Abkommens Italien–Schweiz ausgeschlossen. Andere Kategorien müssen Voraussetzungen und Verfahren bei der Steuerbehörde prüfen. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Un frontalier avec un permis G peut-il ouvrir un pilier 3a ?",
 a: "Vérifier l’accès au 3a avec l’institution selon l’activité et l’assurance sociale. Ouvrir un compte ne donne pas automatiquement droit à une déduction fiscale. La FAQ 5.3 de l’AFC exclut la taxation ordinaire ultérieure pour les frontaliers fiscaux de l’accord Italie–Suisse. Les autres catégories doivent vérifier les conditions et la procédure auprès de l’autorité fiscale. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 // ── Q27: 3a vs 3b ──
 "Qual è la differenza tra pilastro 3a e 3b?": {
 en: {
 q: "What is the difference between pillar 3a and 3b?",
 a: "Pillar 3a is restricted provision; 3b is unrestricted provision. Compare restrictions, costs and product terms; a 3a tax deduction is not automatic for every frontier worker. ESTV FAQ 5.3 excludes subsequent ordinary assessment (TOU) for fiscal frontier workers covered by the Italy–Switzerland agreement. Other categories must check eligibility and procedure with the tax authority. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Was ist der Unterschied zwischen Säule 3a und 3b?",
 a: "Die Säule 3a ist gebundene, die Säule 3b freie Vorsorge. Bindungen, Kosten und Produktbedingungen vergleichen; ein 3a-Steuerabzug gilt nicht automatisch für alle Grenzgänger. Laut ESTV-FAQ 5.3 ist die nachträgliche ordentliche Veranlagung für steuerliche Grenzgänger des Abkommens Italien–Schweiz ausgeschlossen. Andere Kategorien müssen Voraussetzungen und Verfahren bei der Steuerbehörde prüfen. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Quelle est la différence entre le pilier 3a et le 3b ?",
 a: "Le 3a est une prévoyance liée, le 3b une prévoyance libre. Comparer contraintes, frais et conditions ; la déduction du 3a n’est pas automatique pour chaque frontalier. La FAQ 5.3 de l’AFC exclut la taxation ordinaire ultérieure pour les frontaliers fiscaux de l’accord Italie–Suisse. Les autres catégories doivent vérifier les conditions et la procédure auprès de l’autorité fiscale. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 // ── Q28: 3a tax savings ──
 "Quanto si risparmia di tasse con il pilastro 3a?": {
 en: {
 q: "How much tax can you save with pillar 3a?",
 a: "There is no automatic or universal tax saving. Before estimating one, establish whether contributions are deductible under your tax regime. ESTV FAQ 5.3 excludes subsequent ordinary assessment (TOU) for fiscal frontier workers covered by the Italy–Switzerland agreement. Other categories must check eligibility and procedure with the tax authority. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Wie viel Steuern spart man mit der Säule 3a?",
 a: "Es gibt keine automatische oder allgemeingültige Steuerersparnis. Vor einer Schätzung ist zu prüfen, ob Beiträge im eigenen Steuerregime abzugsfähig sind. Laut ESTV-FAQ 5.3 ist die nachträgliche ordentliche Veranlagung für steuerliche Grenzgänger des Abkommens Italien–Schweiz ausgeschlossen. Andere Kategorien müssen Voraussetzungen und Verfahren bei der Steuerbehörde prüfen. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Combien économise-t-on d'impôts avec le pilier 3a ?",
 a: "Il n’existe pas d’économie fiscale automatique ou universelle. Il faut d’abord vérifier si les versements sont déductibles dans son régime fiscal. La FAQ 5.3 de l’AFC exclut la taxation ordinaire ultérieure pour les frontaliers fiscaux de l’accord Italie–Suisse. Les autres catégories doivent vérifier les conditions et la procédure auprès de l’autorité fiscale. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 // ── Q29: 3a withdrawal taxation ──
 "Come viene tassato il prelievo del pilastro 3a?": {
 en: {
 q: "How is pillar 3a withdrawal taxed?",
 a: "At withdrawal, a reduced separate tax is levied, generally between 5% and 10% of the capital in Canton Ticino. For cross-border workers who have left Switzerland, a withholding tax on capital applies with the possibility of refund under the double taxation agreement."
 },
 de: {
 q: "Wie wird der Bezug der Säule 3a besteuert?",
 a: "Beim Bezug fällt eine reduzierte Sondersteuer an, in der Regel zwischen 5 % und 10 % des Kapitals im Kanton Tessin. Für Grenzgänger, die die Schweiz verlassen haben, gilt eine Quellensteuer auf das Kapital mit Rückerstattungsmöglichkeit gemäss dem Doppelbesteuerungsabkommen."
 },
 fr: {
 q: "Comment le retrait du pilier 3a est-il imposé ?",
 a: "Au retrait, un impôt séparé réduit est prélevé, généralement entre 5 % et 10 % du capital au Tessin. Pour les frontaliers ayant quitté la Suisse, un impôt à la source sur le capital s'applique avec possibilité de remboursement en vertu de la convention contre la double imposition."
 }
 },

 // ── Q30: Grocery savings in Italy ──
 "Quanto si risparmia facendo la spesa in Italia?": {
 en: {
 q: "How much can you save by shopping for groceries in Italy?",
 a: "On average, a typical grocery basket costs 35–42% less in Italy than in Switzerland. The biggest savings are on meat, dairy, and household products. The Chiasso-Como area offers the best value considering proximity to the border."
 },
 de: {
 q: "Wie viel spart man beim Einkaufen in Italien?",
 a: "Im Durchschnitt kostet ein typischer Warenkorb in Italien 35–42 % weniger als in der Schweiz. Die grössten Einsparungen gibt es bei Fleisch, Milchprodukten und Haushaltswaren. Das Gebiet Chiasso-Como bietet das beste Preis-Leistungs-Verhältnis in Grenznähe."
 },
 fr: {
 q: "Combien économise-t-on en faisant les courses en Italie ?",
 a: "En moyenne, un panier de courses typique coûte 35 à 42 % de moins en Italie qu'en Suisse. Les économies les plus importantes portent sur la viande, les produits laitiers et les produits ménagers. La zone Chiasso-Côme offre le meilleur rapport qualité-prix compte tenu de la proximité de la frontière."
 }
 },

 // ── Q31: Customs limits ──
 "Quali sono i limiti doganali per la spesa in Italia?": {
 en: {
 q: "What are the customs limits for shopping in Italy?",
 a: "The customs duty-free limit is CHF 300 per person per day. Above this threshold, duties and Swiss VAT (8.1%) apply. Meat and dairy have specific quantity limits: max 1 kg of meat, 1 kg of butter. Alcohol is subject to separate limits."
 },
 de: {
 q: "Was sind die Zollfreigrenzen beim Einkauf in Italien?",
 a: "Die Zollfreigrenze beträgt CHF 300 pro Person und Tag. Über diesem Betrag fallen Zölle und Schweizer Mehrwertsteuer (8,1 %) an. Fleisch und Milchprodukte haben spezifische Mengenlimits: max. 1 kg Fleisch, 1 kg Butter. Alkohol unterliegt separaten Grenzen."
 },
 fr: {
 q: "Quelles sont les limites douanières pour les achats en Italie ?",
 a: "La franchise douanière est de CHF 300 par personne et par jour. Au-delà, les droits de douane et la TVA suisse (8,1 %) s'appliquent. La viande et les produits laitiers ont des limites spécifiques : max. 1 kg de viande, 1 kg de beurre. L'alcool est soumis à des limites séparées."
 }
 },

 // ── Q32: Cheapest supermarket ──
 "Qual è il supermercato più economico vicino al confine?": {
 en: {
 q: "Which is the cheapest supermarket near the border?",
 a: "Eurospin and Lidl Italy generally offer the lowest prices for private-label products. For branded goods, Esselunga and Carrefour often have competitive promotions. On the Swiss side, Aldi and Denner are the most affordable options."
 },
 de: {
 q: "Welcher Supermarkt in Grenznähe ist am günstigsten?",
 a: "Eurospin und Lidl Italien bieten generell die niedrigsten Preise für Eigenmarken. Für Markenprodukte haben Esselunga und Carrefour oft wettbewerbsfähige Angebote. Auf Schweizer Seite sind Aldi und Denner die günstigsten Optionen."
 },
 fr: {
 q: "Quel est le supermarché le moins cher près de la frontière ?",
 a: "Eurospin et Lidl Italie offrent généralement les prix les plus bas pour les marques de distributeur. Pour les produits de marque, Esselunga et Carrefour ont souvent des promotions compétitives. Côté suisse, Aldi et Denner sont les options les plus abordables."
 }
 },

 // ── Q33: Fuel prices ──
 "Conviene fare benzina in Italia o in Svizzera?": {
 en: {
 q: "Is it cheaper to fill up in Italy or Switzerland?",
 a: "Fuel prices are very similar between Italy and Switzerland (around €1.75/L vs CHF 1.85/L). Considering the exchange rate, the difference is minimal. It's best to fill up wherever you happen to be, without making detours."
 },
 de: {
 q: "Lohnt es sich, in Italien oder der Schweiz zu tanken?",
 a: "Der Benzinpreis ist in Italien und der Schweiz sehr ähnlich (ca. 1,75 €/L vs. CHF 1,85/L). Unter Berücksichtigung des Wechselkurses ist der Unterschied minimal. Am besten tankt man dort, wo man sich gerade befindet, ohne Umwege zu machen."
 },
 fr: {
 q: "Est-il plus avantageux de faire le plein en Italie ou en Suisse ?",
 a: "Le prix de l'essence est très similaire entre l'Italie et la Suisse (environ 1,75 €/L contre CHF 1,85/L). En tenant compte du taux de change, la différence est minimale. Il vaut mieux faire le plein là où l'on se trouve, sans faire de détour."
 }
 },

 // ── Q34: Swiss shopping advantages ──
 "Quali prodotti conviene comprare in Svizzera?": {
 en: {
 q: "Which products are cheaper to buy in Switzerland?",
 a: "Electronics, technical clothing, and some pharmaceutical products can be more affordable in Switzerland thanks to lower VAT (8.1% vs 22% in Italy). Nespresso and Swiss chocolate also cost less when purchased directly in Switzerland."
 },
 de: {
 q: "Welche Produkte kauft man besser in der Schweiz?",
 a: "Elektronik, technische Bekleidung und einige pharmazeutische Produkte können in der Schweiz dank der niedrigeren Mehrwertsteuer (8,1 % vs. 22 % in Italien) günstiger sein. Auch Nespresso und Schweizer Schokolade kosten beim Direktkauf in der Schweiz weniger."
 },
 fr: {
 q: "Quels produits convient-il d'acheter en Suisse ?",
 a: "L'électronique, les vêtements techniques et certains produits pharmaceutiques peuvent être moins chers en Suisse grâce à une TVA plus basse (8,1 % contre 22 % en Italie). Le Nespresso et le chocolat suisse coûtent aussi moins cher achetés directement en Suisse."
 }
 },

 // ── Q35: Unemployment for frontalieri ──
 "Un frontaliere licenziato in Svizzera prende la disoccupazione in Italia o in Svizzera?": {
 en: {
 q: "Does a cross-border worker laid off in Switzerland receive unemployment in Italy or Switzerland?",
 a: "A G-permit cross-border worker who loses their job in Switzerland receives unemployment benefits in Italy (NASpI), not in Switzerland. EU Regulation 883/2004 provides that cross-border workers in total unemployment are the responsibility of the country of residence. According to Prof. Roberto Bentivoglio, Professor of Labor Law at USI: 'The cross-border worker must immediately request the PD U1 form in Switzerland to avoid losing the right to NASpI'."
 },
 de: {
 q: "Erhält ein in der Schweiz entlassener Grenzgänger Arbeitslosengeld in Italien oder der Schweiz?",
 a: "Ein Grenzgänger mit G-Bewilligung, der in der Schweiz seine Arbeit verliert, erhält Arbeitslosengeld in Italien (NASpI), nicht in der Schweiz. Die EU-Verordnung 883/2004 sieht vor, dass Grenzgänger bei Vollarbeitslosigkeit vom Wohnsitzstaat betreut werden. Wie Prof. Roberto Bentivoglio, Professor für Arbeitsrecht an der USI, erklärt: «Der Grenzgänger muss das Formular PD U1 sofort in der Schweiz beantragen, um den NASpI-Anspruch nicht zu verlieren»."
 },
 fr: {
 q: "Un frontalier licencié en Suisse perçoit-il le chômage en Italie ou en Suisse ?",
 a: "Un frontalier titulaire d'un permis G qui perd son emploi en Suisse perçoit les allocations chômage en Italie (NASpI), et non en Suisse. Le règlement UE 883/2004 prévoit que les travailleurs frontaliers en chômage complet relèvent du pays de résidence. Comme l'explique le Prof. Roberto Bentivoglio, professeur de droit du travail à l'USI: «Le frontalier doit immédiatement demander le formulaire PD U1 en Suisse pour ne pas perdre son droit à la NASpI»."
 }
 },

 // ── Q36: PD U1 form ──
 "Cos'è il formulario PD U1 e come si ottiene?": {
 en: {
 q: "What is the PD U1 form and how do you obtain it?",
 a: "The PD U1 is the European form certifying insurance and contribution periods in Switzerland. It is requested from the Swiss unemployment fund (e.g., URC Bellinzona) and is needed to open the NASpI claim in Italy. Without the PD U1, INPS cannot totalize Swiss contributions."
 },
 de: {
 q: "Was ist das Formular PD U1 und wie erhält man es?",
 a: "Das PD U1 ist das europäische Formular, das die Versicherungs- und Beitragszeiten in der Schweiz bescheinigt. Es wird bei der Schweizer Arbeitslosenkasse (z. B. RAV Bellinzona) beantragt und ist nötig, um in Italien den NASpI-Antrag zu stellen. Ohne PD U1 kann das INPS die Schweizer Beiträge nicht zusammenrechnen."
 },
 fr: {
 q: "Qu'est-ce que le formulaire PD U1 et comment l'obtenir ?",
 a: "Le PD U1 est le formulaire européen certifiant les périodes d'assurance et de cotisation en Suisse. Il se demande auprès de la caisse de chômage suisse (p. ex. ORP Bellinzone) et est nécessaire pour ouvrir la demande NASpI en Italie. Sans le PD U1, l'INPS ne peut pas totaliser les cotisations suisses."
 }
 },

 // ── Q37: NASpI amount ──
 "Quanto prende di NASpI un frontaliere?": {
 en: {
 q: "How much NASpI does a cross-border worker receive?",
 a: "NASpI equals 75% of the average monthly salary up to €1,425.21, plus 25% of the excess. It reduces by 3% per month from the 6th month (8th for over-55s). The Swiss salary is converted to EUR at the official INPS rate. The 2026 maximum is approximately €1,550/month."
 },
 de: {
 q: "Wie viel NASpI erhält ein Grenzgänger?",
 a: "Die NASpI beträgt 75 % des durchschnittlichen Monatslohns bis 1.425,21 €, plus 25 % des darüber liegenden Teils. Sie verringert sich ab dem 6. Monat (8. bei über 55-Jährigen) um 3 % pro Monat. Der Schweizer Lohn wird zum offiziellen INPS-Kurs in EUR umgerechnet. Das Maximum 2026 beträgt ca. 1.550 €/Monat."
 },
 fr: {
 q: "Combien de NASpI perçoit un frontalier ?",
 a: "La NASpI est égale à 75 % du salaire mensuel moyen jusqu'à 1 425,21 €, plus 25 % de la partie excédentaire. Elle diminue de 3 % par mois à partir du 6e mois (8e pour les plus de 55 ans). Le salaire suisse est converti en EUR au taux officiel de l'INPS. Le maximum 2026 est d'environ 1 550 €/mois."
 }
 },

 // ── Q38: NASpI duration ──
 "Per quanti mesi si prende la NASpI dopo lavoro in Svizzera?": {
 en: {
 q: "For how many months can you receive NASpI after working in Switzerland?",
 a: "NASpI duration equals half the contribution weeks in the last 4 years. With 4 full years of work in Switzerland, you can get up to 24 months of NASpI. Swiss contributions are totalized through the PD U1 form."
 },
 de: {
 q: "Für wie viele Monate erhält man NASpI nach Arbeit in der Schweiz?",
 a: "Die NASpI-Dauer entspricht der Hälfte der Beitragswochen der letzten 4 Jahre. Bei 4 vollen Arbeitsjahren in der Schweiz erhält man bis zu 24 Monate NASpI. Die Schweizer Beiträge werden über das PD-U1-Formular zusammengerechnet."
 },
 fr: {
 q: "Pendant combien de mois peut-on percevoir la NASpI après avoir travaillé en Suisse ?",
 a: "La durée de la NASpI est égale à la moitié des semaines de cotisation des 4 dernières années. Avec 4 années complètes de travail en Suisse, on peut obtenir jusqu'à 24 mois de NASpI. Les cotisations suisses sont totalisées via le formulaire PD U1."
 }
 },

 // ── Q39: NASpI + part-time ──
 "Il frontaliere in NASpI può lavorare part-time in Italia?": {
 en: {
 q: "Can a cross-border worker on NASpI work part-time in Italy?",
 a: "Yes, it is possible to combine NASpI with part-time work if the annual income does not exceed €8,500. The NASpI amount is reduced by 80% of the employment income. You must notify INPS within 30 days of starting the activity."
 },
 de: {
 q: "Kann ein Grenzgänger mit NASpI in Italien Teilzeit arbeiten?",
 a: "Ja, NASpI kann mit Teilzeitarbeit kombiniert werden, wenn das Jahreseinkommen 8.500 € nicht übersteigt. Der NASpI-Betrag wird um 80 % des Arbeitseinkommens gekürzt. Der Beginn der Tätigkeit muss dem INPS innerhalb von 30 Tagen gemeldet werden."
 },
 fr: {
 q: "Un frontalier en NASpI peut-il travailler à temps partiel en Italie ?",
 a: "Oui, il est possible de cumuler la NASpI avec un travail à temps partiel si le revenu annuel ne dépasse pas 8 500 €. Le montant de la NASpI est réduit de 80 % du revenu d'emploi. Il faut informer l'INPS dans les 30 jours suivant le début de l'activité."
 }
 },

 // ── Q40: Car customs clearance ──
 "Quanto costa sdoganare un'auto in Svizzera?": {
 en: {
 q: "How much does it cost to clear a car through Swiss customs?",
 a: "Customs clearance costs include: duty (CHF 12–15 per 100 kg of vehicle weight), Swiss VAT (8.1% on the vehicle value including duty), and the clearance form fee (CHF 20). For a 1,500 kg car worth CHF 20,000, the total cost is approximately CHF 1,800–2,000."
 },
 de: {
 q: "Wie viel kostet die Verzollung eines Autos in der Schweiz?",
 a: "Die Verzollungskosten umfassen: Zoll (CHF 12–15 pro 100 kg Fahrzeuggewicht), Schweizer Mehrwertsteuer (8,1 % auf den Fahrzeugwert inkl. Zoll) und die Verzollungsgebühr (CHF 20). Für ein 1.500 kg schweres Auto im Wert von CHF 20.000 betragen die Gesamtkosten ca. CHF 1.800–2.000."
 },
 fr: {
 q: "Combien coûte le dédouanement d'une voiture en Suisse ?",
 a: "Les coûts de dédouanement comprennent : les droits de douane (CHF 12 à 15 pour 100 kg de poids du véhicule), la TVA suisse (8,1 % sur la valeur du véhicule incluant les droits) et les frais du formulaire de dédouanement (CHF 20). Pour une voiture de 1 500 kg valant CHF 20 000, le coût total est d'environ CHF 1 800 à 2 000."
 }
 },

 // ── Q41: Driving with Italian license ──
 "Un frontaliere con permesso G può guidare con la patente italiana in Svizzera?": {
 en: {
 q: "Can a cross-border worker with a G permit drive with an Italian license in Switzerland?",
 a: "Yes, a G-permit cross-border worker can drive with their Italian license in Switzerland without time limits, as long as they maintain residence in Italy. Only those who transfer residence to Switzerland (B permit) must convert their license within 12 months."
 },
 de: {
 q: "Kann ein Grenzgänger mit G-Bewilligung mit dem italienischen Führerschein in der Schweiz fahren?",
 a: "Ja, ein Grenzgänger mit G-Bewilligung kann ohne zeitliche Begrenzung mit dem italienischen Führerschein in der Schweiz fahren, solange der Wohnsitz in Italien beibehalten wird. Nur wer den Wohnsitz in die Schweiz verlegt (B-Bewilligung), muss den Führerschein innerhalb von 12 Monaten umschreiben."
 },
 fr: {
 q: "Un frontalier avec un permis G peut-il conduire avec le permis de conduire italien en Suisse ?",
 a: "Oui, un frontalier titulaire d'un permis G peut conduire avec son permis italien en Suisse sans limite de temps, à condition de maintenir sa résidence en Italie. Seuls ceux qui transfèrent leur résidence en Suisse (permis B) doivent convertir leur permis dans les 12 mois."
 }
 },

 // ── Q42: Italian-plated car in Switzerland ──
 "Posso guidare un'auto con targa italiana in Svizzera per andare al lavoro?": {
 en: {
 q: "Can I drive a car with Italian plates in Switzerland for commuting?",
 a: "Yes, a cross-border worker residing in Italy can use an Italian-plated car for the home-to-work commute in Switzerland. There is no need to clear the vehicle through customs. However, the car must have insurance valid in Switzerland (green card)."
 },
 de: {
 q: "Kann ich ein Auto mit italienischem Kennzeichen in der Schweiz zum Pendeln nutzen?",
 a: "Ja, ein in Italien wohnhafter Grenzgänger darf ein Auto mit italienischem Kennzeichen für den Arbeitsweg in der Schweiz nutzen. Das Fahrzeug muss nicht verzollt werden. Das Auto muss jedoch eine in der Schweiz gültige Versicherung haben (Grüne Karte)."
 },
 fr: {
 q: "Puis-je conduire une voiture immatriculée en Italie en Suisse pour aller au travail ?",
 a: "Oui, un frontalier résidant en Italie peut utiliser une voiture immatriculée en Italie pour le trajet domicile-travail en Suisse. Il n'est pas nécessaire de dédouaner le véhicule. La voiture doit toutefois avoir une assurance RC valable en Suisse (carte verte)."
 }
 },

 // ── Q43: MFK inspection ──
 "Cos'è il collaudo MFK e quanto costa?": {
 en: {
 q: "What is the MFK inspection and how much does it cost?",
 a: "The MFK (Motorfahrzeugkontrolle) is the mandatory Swiss vehicle inspection, equivalent to the Italian MOT. It costs approximately CHF 50–80. It checks brakes, lights, emissions, tyres, and general safety. For cars imported from Italy, compliance with Swiss standards is also verified."
 },
 de: {
 q: "Was ist die MFK-Prüfung und was kostet sie?",
 a: "Die MFK (Motorfahrzeugkontrolle) ist die obligatorische Schweizer Fahrzeugprüfung. Sie kostet ca. CHF 50–80. Geprüft werden Bremsen, Beleuchtung, Emissionen, Reifen und allgemeine Sicherheit. Bei aus Italien importierten Fahrzeugen wird auch die Konformität mit den Schweizer Normen überprüft."
 },
 fr: {
 q: "Qu'est-ce que le contrôle technique MFK et combien coûte-t-il ?",
 a: "Le MFK (Motorfahrzeugkontrolle) est le contrôle technique obligatoire suisse, équivalent du contrôle technique italien. Il coûte environ CHF 50 à 80. Il vérifie les freins, l'éclairage, les émissions, les pneus et la sécurité générale. Pour les voitures importées d'Italie, la conformité aux normes suisses est aussi vérifiée."
 }
 },

 // ── Q44: Car insurance comparison ──
 "Quanto costa l'assicurazione auto in Svizzera rispetto all'Italia?": {
 en: {
 q: "How much does car insurance cost in Switzerland compared to Italy?",
 a: "Swiss liability insurance costs on average CHF 800–1,500/year, similar or slightly more expensive than Italy. The Italian bonus-malus record is not recognized, so you often start from an intermediate class. The cheapest insurers in Ticino are generally Smile.direct and Vaudoise."
 },
 de: {
 q: "Was kostet die Autoversicherung in der Schweiz im Vergleich zu Italien?",
 a: "Die Schweizer Haftpflichtversicherung kostet durchschnittlich CHF 800–1.500/Jahr, ähnlich oder etwas teurer als in Italien. Das italienische Bonus-Malus-System wird nicht anerkannt, daher startet man oft in einer mittleren Klasse. Die günstigsten Versicherer im Tessin sind in der Regel Smile.direct und Vaudoise."
 },
 fr: {
 q: "Combien coûte l'assurance automobile en Suisse par rapport à l'Italie ?",
 a: "L'assurance RC suisse coûte en moyenne CHF 800 à 1 500/an, similaire ou légèrement plus chère qu'en Italie. Le bonus-malus italien n'est pas reconnu, on commence donc souvent dans une classe intermédiaire. Les assureurs les moins chers au Tessin sont généralement Smile.direct et Vaudoise."
 }
 },

 // ── Q45: G vs B convenience ──
 "Conviene di più il permesso G o il permesso B in Svizzera?": {
 en: {
 q: "Is a G permit or B permit more convenient in Switzerland?",
 a: "It depends on salary and family situation. With a salary above CHF 80,000, the B permit (resident) is often more convenient because Swiss rates are lower than Italian IRPEF. With a salary below CHF 60,000, the G permit can be advantageous thanks to the lower cost of living in Italy."
 },
 de: {
 q: "Ist die G- oder die B-Bewilligung in der Schweiz vorteilhafter?",
 a: "Das hängt vom Lohn und der familiären Situation ab. Bei einem Lohn über CHF 80.000 ist die B-Bewilligung (Aufenthalt) oft vorteilhafter, da die Schweizer Steuersätze niedriger sind als die italienische IRPEF. Bei einem Lohn unter CHF 60.000 kann die G-Bewilligung dank der niedrigeren Lebenshaltungskosten in Italien günstiger sein."
 },
 fr: {
 q: "Quel est le plus avantageux : le permis G ou le permis B en Suisse ?",
 a: "Cela dépend du salaire et de la situation familiale. Avec un salaire supérieur à CHF 80 000, le permis B (séjour) est souvent plus avantageux car les taux suisses sont inférieurs à l'IRPEF italienne. Avec un salaire inférieur à CHF 60 000, le permis G peut être avantageux grâce au coût de la vie plus bas en Italie."
 }
 },

 // ── Q46: Double taxation ──
 "Un frontaliere con permesso G paga le tasse in Italia e in Svizzera?": {
 en: {
 q: "Does a G-permit cross-border worker pay taxes in both Italy and Switzerland?",
 a: "A G permit alone does not determine tax treatment. New cross-border workers qualifying under the agreement pay 80% of ordinary Swiss withholding tax and Italian tax with credit for Swiss tax. For old workers qualifying under Article 9, the covered salary remains taxable only in Switzerland: 2033 ends interstate compensation, not this treatment. Other income and filing obligations must be considered separately. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Zahlt ein Grenzgänger mit G-Bewilligung Steuern in Italien und der Schweiz?",
 a: "Die G-Bewilligung allein bestimmt das Steuerregime nicht. Neue Grenzgänger im Sinne des Abkommens zahlen 80% der ordentlichen Schweizer Quellensteuer und italienische Steuer mit Anrechnung der Schweizer Steuer. Bei alten Grenzgängern nach Artikel 9 bleibt der erfasste Lohn ausschliesslich in der Schweiz steuerpflichtig: 2033 endet der zwischenstaatliche Ausgleich, nicht diese Behandlung. Andere Einkünfte und Erklärungspflichten sind gesondert zu prüfen. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Un frontalier avec un permis G paie-t-il des impôts en Italie et en Suisse ?",
 a: "Le permis G ne détermine pas seul le régime fiscal. Les nouveaux frontaliers admis par l’accord paient 80% de l’impôt suisse à la source ordinaire et l’impôt italien avec crédit pour l’impôt suisse. Pour les anciens admissibles selon l’article 9, le salaire concerné reste imposable uniquement en Suisse : 2033 met fin à la compensation entre États, non à ce traitement. Les autres revenus et obligations déclaratives sont à examiner séparément. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 // ── Q47: Rent savings ──
 "Quanto si risparmia sull'affitto vivendo in Italia con permesso G?": {
 en: {
 q: "How much can you save on rent by living in Italy with a G permit?",
 a: "An apartment in Como or Varese costs around €600–900/month, compared to CHF 1,200–1,800/month for an equivalent in Lugano or Bellinzona. The rent saving is about €500–800/month, partially offset by transport costs (fuel, motorway, travel time)."
 },
 de: {
 q: "Wie viel spart man bei der Miete, wenn man mit G-Bewilligung in Italien lebt?",
 a: "Eine Wohnung in Como oder Varese kostet ca. 600–900 €/Monat, verglichen mit CHF 1.200–1.800/Monat für eine vergleichbare Wohnung in Lugano oder Bellinzona. Die Mietersparnis beträgt ca. 500–800 €/Monat, teilweise kompensiert durch Transportkosten (Benzin, Autobahn, Fahrzeit)."
 },
 fr: {
 q: "Combien économise-t-on sur le loyer en vivant en Italie avec un permis G ?",
 a: "Un appartement à Côme ou Varèse coûte environ 600 à 900 €/mois, contre CHF 1 200 à 1 800/mois pour un équivalent à Lugano ou Bellinzone. L'économie sur le loyer est d'environ 500 à 800 €/mois, partiellement compensée par les frais de transport (essence, autoroute, temps de trajet)."
 }
 },

 // ── Q48: Switching permits ──
 "Posso passare da permesso G a permesso B e viceversa?": {
 en: {
 q: "Can I switch from a G permit to a B permit and vice versa?",
 a: "Yes. To switch from G to B, simply transfer your residence to Switzerland and apply for a B permit. For the reverse, deregister from the Swiss municipality and re-establish residence in Italy. Caution: the switch has significant tax consequences (the transition year is taxed pro rata)."
 },
 de: {
 q: "Kann ich von einer G- auf eine B-Bewilligung wechseln und umgekehrt?",
 a: "Ja. Für den Wechsel von G zu B verlegen Sie den Wohnsitz in die Schweiz und beantragen eine B-Bewilligung. Umgekehrt melden Sie sich bei der Schweizer Gemeinde ab und begründen den Wohnsitz in Italien neu. Achtung: Der Wechsel hat erhebliche steuerliche Konsequenzen (das Übergangsjahr wird pro rata besteuert)."
 },
 fr: {
 q: "Puis-je passer du permis G au permis B et vice versa ?",
 a: "Oui. Pour passer du G au B, transférez votre résidence en Suisse et demandez un permis B. Pour l'inverse, désinscrivez-vous de la commune suisse et rétablissez votre résidence en Italie. Attention : le changement a des conséquences fiscales importantes (l'année de transition est imposée au prorata)."
 }
 },

 // ── Q49: B permit pension ──
 "Il permesso B dà diritto alla pensione svizzera piena?": {
 en: {
 q: "Does the B permit entitle to a full Swiss pension?",
 a: "Both permits (G and B) entitle to AVS and LPP contributions. The difference is that with a B permit you can make additional voluntary AVS contributions and have full access to the Swiss pension system. A full AVS pension requires 44 years of contributions regardless of permit type."
 },
 de: {
 q: "Berechtigt die B-Bewilligung zu einer vollen Schweizer Rente?",
 a: "Beide Bewilligungen (G und B) berechtigen zu AHV- und BVG-Beiträgen. Der Unterschied: Mit der B-Bewilligung können zusätzliche freiwillige AHV-Beiträge geleistet werden und man hat vollen Zugang zum Schweizer Vorsorgesystem. Eine volle AHV-Rente erfordert 44 Beitragsjahre, unabhängig vom Bewilligungstyp."
 },
 fr: {
 q: "Le permis B donne-t-il droit à une rente suisse complète ?",
 a: "Les deux permis (G et B) donnent droit aux cotisations AVS et LPP. La différence est qu'avec le permis B, on peut verser des cotisations AVS volontaires supplémentaires et avoir un accès complet au système de prévoyance suisse. Une rente AVS complète nécessite 44 ans de cotisations, quel que soit le type de permis."
 }
 },

 // ── Q50: First day documents ──
 "Quali documenti servono per il primo giorno di lavoro in Svizzera?": {
 en: {
 q: "What documents are needed for the first day of work in Switzerland?",
 a: "For the first day you need: valid ID card or passport, G permit (or receipt of application), signed employment contract, Swiss bank details (IBAN), health insurance certificate (LAMal or SSN), and Italian tax code."
 },
 de: {
 q: "Welche Dokumente braucht man am ersten Arbeitstag in der Schweiz?",
 a: "Am ersten Tag brauchen Sie: gültigen Personalausweis oder Reisepass, G-Bewilligung (oder Empfangsbestätigung des Antrags), unterschriebenen Arbeitsvertrag, Schweizer Bankverbindung (IBAN), Krankenversicherungsnachweis (KVG oder SSN) und die italienische Steuernummer."
 },
 fr: {
 q: "Quels documents faut-il pour le premier jour de travail en Suisse ?",
 a: "Pour le premier jour, il faut : une carte d'identité ou un passeport valide, le permis G (ou le récépissé de la demande), le contrat de travail signé, les coordonnées bancaires suisses (IBAN), l'attestation d'assurance maladie (LAMal ou SSN) et le code fiscal italien."
 }
 },

 // ── Q51: G permit processing time ──
 "Quanto tempo ci vuole per ottenere il permesso G?": {
 en: {
 q: "How long does it take to obtain a G permit?",
 a: "For EU citizens, the G permit is issued within 5–10 working days from the employer's application. You can begin working with the application receipt. The physical permit (card format) arrives by post in 2–4 weeks."
 },
 de: {
 q: "Wie lange dauert es, eine G-Bewilligung zu erhalten?",
 a: "Für EU-Bürger wird die G-Bewilligung innerhalb von 5–10 Arbeitstagen nach dem Antrag des Arbeitgebers ausgestellt. Man kann bereits mit der Empfangsbestätigung zu arbeiten beginnen. Die physische Bewilligung (Kartenformat) kommt per Post in 2–4 Wochen."
 },
 fr: {
 q: "Combien de temps faut-il pour obtenir un permis G ?",
 a: "Pour les citoyens de l'UE, le permis G est délivré sous 5 à 10 jours ouvrables à partir de la demande de l'employeur. On peut commencer à travailler avec le récépissé de la demande. Le permis physique (format carte) arrive par courrier sous 2 à 4 semaines."
 }
 },

 // ── Q52: Swiss bank account ──
 "Devo aprire un conto bancario svizzero per lo stipendio?": {
 en: {
 q: "Do I need to open a Swiss bank account for my salary?",
 a: "Yes, most Swiss employers require a Swiss account for the CHF salary payment. Banks most used by cross-border workers are PostFinance (economical, ~CHF 5/month), Raiffeisen, and cantonal banks. You need your G permit, employment contract, and ID."
 },
 de: {
 q: "Muss ich ein Schweizer Bankkonto für den Lohn eröffnen?",
 a: "Ja, die meisten Schweizer Arbeitgeber verlangen ein Schweizer Konto für die Lohnzahlung in CHF. Banken, die von Grenzgängern am häufigsten genutzt werden, sind PostFinance (günstig, ~CHF 5/Monat), Raiffeisen und Kantonalbanken. Man braucht G-Bewilligung, Arbeitsvertrag und Ausweis."
 },
 fr: {
 q: "Dois-je ouvrir un compte bancaire suisse pour mon salaire ?",
 a: "Oui, la plupart des employeurs suisses exigent un compte suisse pour le versement du salaire en CHF. Les banques les plus utilisées par les frontaliers sont PostFinance (économique, ~CHF 5/mois), Raiffeisen et les banques cantonales. Il faut le permis G, le contrat de travail et une pièce d'identité."
 }
 },

 // ── Q53: LAMal vs SSN ──
 "Meglio scegliere LAMal svizzera o SSN italiano come assicurazione?": {
 en: {
 q: "Is it better to choose Swiss LAMal or Italian SSN as health insurance?",
 a: "It depends on the personal situation. LAMal costs around CHF 400–600/month but covers care in Switzerland without long waits. The Italian SSN is free (or nearly so) but does not cover emergency care in Switzerland. The right of option must be exercised within 3 months of starting work and the choice cannot be changed freely; any new entitlement must be checked with the canton of employment."
 },
 de: {
 q: "Ist es besser, die Schweizer KVG oder den italienischen SSN als Krankenversicherung zu wählen?",
 a: "Das hängt von der persönlichen Situation ab. Die KVG kostet ca. CHF 400–600/Monat, deckt aber Behandlungen in der Schweiz ohne lange Wartezeiten. Der italienische SSN ist kostenlos (oder fast), deckt aber keine Notfallbehandlungen in der Schweiz. Das Optionsrecht muss innerhalb von 3 Monaten nach Arbeitsbeginn ausgeübt werden und die Wahl kann nicht frei geändert werden; neue Umstände sind mit dem Arbeitskanton zu prüfen."
 },
 fr: {
 q: "Vaut-il mieux choisir la LAMal suisse ou le SSN italien comme assurance maladie ?",
 a: "Cela dépend de la situation personnelle. La LAMal coûte environ CHF 400 à 600/mois mais couvre les soins en Suisse sans longues attentes. Le SSN italien est gratuit (ou presque) mais ne couvre pas les soins urgents en Suisse. Le droit d'option doit être exercé dans les 3 mois suivant le début de l'emploi et le choix ne peut pas être modifié librement ; les nouveaux événements sont à vérifier auprès du canton de travail."
 }
 },

 // ── Q54: AIRE registration ──
 "Il frontaliere deve iscriversi all'AIRE?": {
 en: {
 q: "Does a cross-border worker need to register with AIRE?",
 a: "No, a cross-border worker with a G permit who maintains residence in Italy does not need to register with AIRE. Registration is mandatory only for those who transfer residence to Switzerland (B permit). The cross-border worker remains fiscally resident in Italy."
 },
 de: {
 q: "Muss sich ein Grenzgänger beim AIRE anmelden?",
 a: "Nein, ein Grenzgänger mit G-Bewilligung, der seinen Wohnsitz in Italien beibehält, muss sich nicht beim AIRE anmelden. Die Anmeldung ist nur bei Wohnsitzverlegung in die Schweiz (B-Bewilligung) obligatorisch. Der Grenzgänger bleibt steuerlich in Italien ansässig."
 },
 fr: {
 q: "Un frontalier doit-il s'inscrire à l'AIRE ?",
 a: "Non, un frontalier titulaire d'un permis G qui maintient sa résidence en Italie n'a pas besoin de s'inscrire à l'AIRE. L'inscription n'est obligatoire que pour ceux qui transfèrent leur résidence en Suisse (permis B). Le frontalier reste résident fiscal en Italie."
 }
 },

 // ── Q55: Tax credit mechanism ──
 "Come funziona il credito d'imposta per frontalieri?": {
 en: {
 q: "How does the tax credit for cross-border workers work?",
 a: "The tax credit avoids double taxation: taxes paid in Switzerland (withholding tax) are deducted from Italian IRPEF in Section CE of the tax return. The credit is limited to the Italian tax share corresponding to the foreign income. According to Elena Colombo, international tax accountant: 'It is essential to keep the Swiss salary certificate (Lohnausweis) as proof of the withholding tax paid'."
 },
 de: {
 q: "Wie funktioniert die Steuergutschrift für Grenzgänger?",
 a: "Die Steuergutschrift vermeidet Doppelbesteuerung: In der Schweiz gezahlte Steuern (Quellensteuer) werden im Abschnitt CE der Steuererklärung von der italienischen IRPEF abgezogen. Die Gutschrift ist auf den italienischen Steueranteil begrenzt, der dem ausländischen Einkommen entspricht. Wie Elena Colombo, auf internationale Steuern spezialisierte Steuerberaterin, erklärt: «Es ist unerlässlich, den Schweizer Lohnausweis als Nachweis der bezahlten Quellensteuer aufzubewahren»."
 },
 fr: {
 q: "Comment fonctionne le crédit d'impôt pour les frontaliers ?",
 a: "Le crédit d'impôt évite la double imposition : les impôts payés en Suisse (impôt à la source) sont déduits de l'IRPEF italienne dans la section CE de la déclaration fiscale. Le crédit est limité à la part d'impôt italien correspondant au revenu étranger. Comme l'explique Elena Colombo, comptable spécialisée en fiscalité internationale: «Il est essentiel de conserver le certificat de salaire suisse (Lohnausweis) comme preuve de l'impôt à la source payé»."
 }
 },

 // ── Q56: Tax credit old vs new ──
 "Qual è la differenza tra credito d'imposta per vecchi e nuovi frontalieri?": {
 en: {
 q: "What is the difference in tax credit between old and new cross-border workers?",
 a: "An eligible old worker owes no Italian IRPEF on Swiss salary covered by Article 9, so no credit is used for that income. This does not remove possible Italian obligations for other income or asset reporting. A new tax cross-border worker declares the income in Italy and can credit Swiss tax within the applicable credit limits; 80% refers to ordinary Swiss withholding tax, not a general cap on the Italian credit. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Was ist der Unterschied bei der Steuergutschrift zwischen Alt- und Neugrenzgängern?",
 a: "Ein qualifizierter alter Grenzgänger schuldet auf den Schweizer Lohn nach Artikel 9 keine italienische IRPEF und benötigt dafür keine Steueranrechnung. Mögliche italienische Pflichten für andere Einkünfte oder Vermögensmeldungen bleiben gesondert zu prüfen. Ein neuer steuerlicher Grenzgänger erklärt den Lohn in Italien und kann Schweizer Steuer im zulässigen Umfang anrechnen. Die 80% beziehen sich auf die ordentliche Schweizer Quellensteuer, nicht auf eine allgemeine Grenze der italienischen Anrechnung. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Quelle est la différence de crédit d'impôt entre anciens et nouveaux frontaliers ?",
 a: "Un ancien frontalier admissible ne doit pas d’IRPEF italien sur le salaire suisse couvert par l’article 9 et n’utilise donc pas de crédit pour ce revenu. Cela ne supprime pas les éventuelles obligations italiennes pour d’autres revenus ou déclarations de patrimoine. Le nouveau frontalier fiscal déclare le revenu en Italie et peut imputer l’impôt suisse dans les limites du crédit applicable ; les 80% concernent l’impôt suisse à la source ordinaire, non un plafond général du crédit italien. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 // ── Q57: Quadro CE ──
 "In quale quadro della dichiarazione si indica il credito d'imposta?": {
 en: {
 q: "In which section of the tax return is the tax credit declared?",
 a: "The tax credit for taxes paid abroad is declared in Section CE (Quadro CE) of the Modello Redditi PF (Individual Income Tax Return). You report the income produced abroad and the definitive foreign tax paid."
 },
 de: {
 q: "In welchem Abschnitt der Steuererklärung wird die Steuergutschrift angegeben?",
 a: "Die Steuergutschrift für im Ausland gezahlte Steuern wird im Abschnitt CE (Quadro CE) des Modello Redditi PF (Einkommensteuererklärung) angegeben. Man gibt das im Ausland erzielte Einkommen und die gezahlte ausländische Definitivsteuer an."
 },
 fr: {
 q: "Dans quelle section de la déclaration fiscale le crédit d'impôt est-il indiqué ?",
 a: "Le crédit d'impôt pour les impôts payés à l'étranger est déclaré dans la Section CE (Quadro CE) du Modello Redditi PF (déclaration d'impôt sur le revenu). On y indique le revenu produit à l'étranger et l'impôt étranger définitif payé."
 }
 },

 // ── Q58: Tax credit cap ──
 "Il credito d'imposta può superare l'IRPEF dovuta?": {
 en: {
 q: "Can the tax credit exceed the IRPEF due?",
 a: "No, the tax credit cannot exceed the IRPEF share proportional to the foreign income. If the Swiss tax is higher than the IRPEF share, the difference is not refundable but can be carried forward in the next 8 tax returns."
 },
 de: {
 q: "Kann die Steuergutschrift die geschuldete IRPEF übersteigen?",
 a: "Nein, die Steuergutschrift kann den proportionalen IRPEF-Anteil auf das ausländische Einkommen nicht übersteigen. Ist die Schweizer Steuer höher als der IRPEF-Anteil, wird die Differenz nicht erstattet, kann aber in den nächsten 8 Steuererklärungen vorgetragen werden."
 },
 fr: {
 q: "Le crédit d'impôt peut-il dépasser l'IRPEF due ?",
 a: "Non, le crédit d'impôt ne peut pas dépasser la part d'IRPEF proportionnelle au revenu étranger. Si l'impôt suisse est supérieur à la part d'IRPEF, la différence n'est pas remboursable mais peut être reportée dans les 8 déclarations suivantes."
 }
 },

 // ── Q59: CHF→EUR conversion for tax ──
 "Devo convertire l'imposta svizzera da CHF a EUR?": {
 en: {
 q: "Do I need to convert the Swiss tax from CHF to EUR?",
 a: "Yes, the withholding tax paid in CHF must be converted to EUR using the annual average exchange rate published by the Agenzia delle Entrate. For 2025 the indicative average rate is approximately 0.94 EUR per CHF."
 },
 de: {
 q: "Muss ich die Schweizer Steuer von CHF in EUR umrechnen?",
 a: "Ja, die in CHF gezahlte Quellensteuer muss zum Jahresdurchschnittskurs, der von der Agenzia delle Entrate veröffentlicht wird, in EUR umgerechnet werden. Für 2025 liegt der indikative Durchschnittskurs bei ca. 0,94 EUR pro CHF."
 },
 fr: {
 q: "Dois-je convertir l'impôt suisse de CHF en EUR ?",
 a: "Oui, l'impôt à la source payé en CHF doit être converti en EUR en utilisant le taux de change moyen annuel publié par l'Agenzia delle Entrate. Pour 2025, le taux moyen indicatif est d'environ 0,94 EUR pour 1 CHF."
 }
 },

 // ── Q60: G vs B permit (duplicate variant) ──
 "Che differenza c'è tra permesso G e permesso B per un frontaliere?": {
 en: {
 q: "What is the difference between a G permit and a B permit for a cross-border worker?",
 a: "The G permit is for workers who reside in an EU/EFTA country and work in Switzerland, returning home at least once a week. The B permit is for those who move to live in Switzerland. With the G permit, taxes are paid via withholding at source in Switzerland and declared in Italy; with the B permit, one is fiscally resident in Switzerland."
 },
 de: {
 q: "Was ist der Unterschied zwischen G- und B-Bewilligung für einen Grenzgänger?",
 a: "Die G-Bewilligung ist für Arbeitnehmer, die in einem EU/EFTA-Land wohnen und in der Schweiz arbeiten und mindestens wöchentlich heimkehren. Die B-Bewilligung ist für Personen, die in die Schweiz ziehen. Mit der G-Bewilligung werden Steuern per Quellensteuer in der Schweiz erhoben und in Italien deklariert; mit der B-Bewilligung ist man steuerlich in der Schweiz ansässig."
 },
 fr: {
 q: "Quelle est la différence entre un permis G et un permis B pour un frontalier ?",
 a: "Le permis G est destiné aux travailleurs résidant dans un pays UE/AELE et travaillant en Suisse, avec retour au domicile au moins une fois par semaine. Le permis B est pour ceux qui s'installent en Suisse. Avec le permis G, les impôts sont prélevés à la source en Suisse et déclarés en Italie ; avec le permis B, on est résident fiscal en Suisse."
 }
 },

 // ── Q61: New agreement 2026 ──
 "Come funziona il nuovo accordo fiscale frontalieri 2026?": {
 en: {
 q: "How does the 2026 cross-border tax agreement work?",
 a: "For new fiscal cross-border workers, Switzerland applies 80% of its ordinary withholding rate; Italy taxes the income with a credit for Swiss tax. The 80% is not a revenue split between the two countries. Old cross-border workers who qualify under Article 9 retain exclusive Swiss taxation of the covered salary. Their regime does not automatically end in 2033 or 2034: 2033 is the final tax year of Swiss compensation payments to Italy. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Wie funktioniert das neue Grenzgänger-Steuerabkommen 2026?",
 a: "Für neue steuerliche Grenzgänger wendet die Schweiz 80% des ordentlichen Quellensteuertarifs an; Italien besteuert das Einkommen mit Anrechnung der Schweizer Steuer. Die 80% sind keine Aufteilung der Einnahmen zwischen den Staaten. Alte Grenzgänger, die Artikel 9 erfüllen, behalten die ausschliessliche Schweizer Besteuerung des erfassten Lohns. Das Regime endet nicht automatisch 2033 oder 2034; 2033 ist das letzte Steuerjahr der Ausgleichszahlungen an Italien. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Comment fonctionne le nouvel accord fiscal frontaliers 2026 ?",
 a: "Pour les nouveaux frontaliers fiscaux, la Suisse applique 80% du taux ordinaire de retenue; l’Italie impose le revenu en accordant un crédit pour l’impôt suisse. Les 80% ne sont pas un partage des recettes entre les États. Les anciens frontaliers remplissant les conditions de l’article 9 conservent l’imposition exclusivement suisse du salaire concerné. Ce régime ne prend pas automatiquement fin en 2033 ou 2034; 2033 est la dernière année fiscale des compensations versées à l’Italie. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 // ── Q62: Tax obligation in Italy ──
 "Devo pagare le tasse in Italia se lavoro in Svizzera come frontaliere?": {
 en: {
 q: "Do I have to pay taxes in Italy if I work in Switzerland as a cross-border worker?",
 a: "Yes, if you are a new cross-border worker (from 2024), you must declare your income in Italy too. There is a €10,000 exemption: below this threshold you don't pay additional IRPEF. Above it, Italian tax is calculated with a credit for what was already paid in Switzerland."
 },
 de: {
 q: "Muss ich in Italien Steuern zahlen, wenn ich als Grenzgänger in der Schweiz arbeite?",
 a: "Ja, als neuer Grenzgänger (ab 2024) müssen Sie das Einkommen auch in Italien deklarieren. Es gibt einen Freibetrag von 10.000 €: darunter zahlen Sie keine zusätzliche IRPEF. Darüber wird die italienische Steuer unter Anrechnung der bereits in der Schweiz gezahlten Steuer berechnet."
 },
 fr: {
 q: "Dois-je payer des impôts en Italie si je travaille en Suisse comme frontalier ?",
 a: "Oui, si vous êtes un nouveau frontalier (à partir de 2024), vous devez aussi déclarer vos revenus en Italie. Il existe une franchise de 10 000 € : en dessous, vous ne payez pas d'IRPEF supplémentaire. Au-delà, l'impôt italien est calculé avec un crédit pour ce qui a déjà été payé en Suisse."
 }
 },

 // ── Q63: LAMal ──
 "Cos'è la LAMal e come funziona per i frontalieri?": {
 en: {
 q: "What is LAMal and how does it work for cross-border workers?",
 a: "LAMal is the mandatory Swiss health insurance. Cross-border workers can choose between LAMal (Swiss coverage) and the Italian SSN. For residents of Italy, standard insurance and the ordinary deductible apply; HMO, Telmed and optional deductibles are unavailable. The choice must be made within 3 months of starting work. According to Laura Mantovani, LAMal insurance broker: 'For those with family in Italy, the SSN is often more cost-effective, while LAMal offers faster access to care in Switzerland'."
 },
 de: {
 q: "Was ist die KVG und wie funktioniert sie für Grenzgänger?",
 a: "Die KVG (LAMal) ist die obligatorische Schweizer Krankenversicherung. Grenzgänger können zwischen KVG (Schweizer Deckung) und dem italienischen SSN wählen. Bei Wohnsitz in Italien gelten Standardversicherung und ordentliche Franchise; HMO, Telmed und Wahlfranchisen sind nicht verfügbar. Die Wahl muss innerhalb von 3 Monaten nach Arbeitsbeginn getroffen werden. Wie Laura Mantovani, KVG-Versicherungsmaklerin, erklärt: «Für Familien in Italien ist der SSN oft günstiger, während die KVG einen schnelleren Zugang zur Versorgung in der Schweiz bietet»."
 },
 fr: {
 q: "Qu'est-ce que la LAMal et comment fonctionne-t-elle pour les frontaliers ?",
 a: "La LAMal est l'assurance maladie obligatoire suisse. Les frontaliers peuvent choisir entre la LAMal (couverture suisse) et le SSN italien. Pour les résidents en Italie, le modèle standard et la franchise ordinaire s’appliquent ; HMO, Telmed et franchises à option ne sont pas disponibles. Le choix doit être fait dans les 3 mois suivant le début de l'emploi. Comme l'explique Laura Mantovani, courtière en assurance LAMal: «Pour ceux qui ont une famille en Italie, le SSN est souvent plus avantageux, tandis que la LAMal offre un accès plus rapide aux soins en Suisse»."
 }
 },

 // ── Q64: Pension composition ──
 "Come si calcola la pensione di un frontaliere svizzero?": {
 en: {
 q: "How is a Swiss cross-border worker's pension calculated?",
 a: "The pension consists of three pillars: AVS (1st pillar, state pension), LPP (2nd pillar, occupational pension), and Pillar 3a (voluntary savings with tax benefits). AVS and LPP contributions are deducted from the payslip. At retirement you can claim the annuity or the capital of the 2nd pillar."
 },
 de: {
 q: "Wie wird die Rente eines Schweizer Grenzgängers berechnet?",
 a: "Die Rente besteht aus drei Säulen: AHV (1. Säule, Staatsrente), BVG (2. Säule, berufliche Vorsorge) und Säule 3a (freiwilliges Sparen mit Steuervorteilen). AHV- und BVG-Beiträge werden vom Lohn abgezogen. Bei der Pensionierung kann man die Rente oder das Kapital der 2. Säule beziehen."
 },
 fr: {
 q: "Comment calcule-t-on la pension d'un frontalier suisse ?",
 a: "La pension se compose de trois piliers : AVS (1er pilier, pension d'État), LPP (2e pilier, prévoyance professionnelle) et pilier 3a (épargne volontaire avec avantages fiscaux). Les cotisations AVS et LPP sont déduites du salaire. À la retraite, on peut demander la rente ou le capital du 2e pilier."
 }
 },

 // ── Q65: TFR equivalent ──
 "Perdo il TFR lavorando in Svizzera?": {
 en: {
 q: "Do I lose the TFR (severance pay) by working in Switzerland?",
 a: "No, in Switzerland the TFR does not exist. Instead, there is the 2nd pillar (LPP/BVG), a mandatory occupational pension mechanism."
 },
 de: {
 q: "Verliere ich die Abfindung (TFR), wenn ich in der Schweiz arbeite?",
 a: "Nein, in der Schweiz gibt es den TFR nicht. An seiner Stelle steht die 2. Säule (BVG), ein obligatorischer beruflicher Vorsorgemechanismus."
 },
 fr: {
 q: "Est-ce que je perds le TFR (indemnité de fin de contrat) en travaillant en Suisse ?",
 a: "Non, en Suisse le TFR n'existe pas. À sa place, il y a le 2e pilier (LPP/BVG), un mécanisme de prévoyance professionnelle obligatoire."
 }
 },

 // ── Q66: 2nd pillar withdrawal on return ──
 "Posso recuperare il 2° pilastro se torno in Italia?": {
 en: {
 q: "Can I recover the 2nd pillar if I return to Italy?",
 a: "Yes. Upon permanently leaving Switzerland, you can request the liquidation of the mandatory portion of the 2nd pillar."
 },
 de: {
 q: "Kann ich die 2. Säule zurückerhalten, wenn ich nach Italien zurückkehre?",
 a: "Ja. Beim endgültigen Verlassen der Schweiz kann man die Auszahlung des obligatorischen Teils der 2. Säule beantragen."
 },
 fr: {
 q: "Puis-je récupérer le 2e pilier si je retourne en Italie ?",
 a: "Oui. En quittant définitivement la Suisse, on peut demander la liquidation de la part obligatoire du 2e pilier."
 }
 },

 // ── Q67: 2nd pillar vs TFR ──
 "Il 2° pilastro svizzero è più conveniente del TFR italiano?": {
 en: {
 q: "Is the Swiss 2nd pillar more convenient than the Italian TFR?",
 a: "It depends on salary, age, and career duration. For medium-high salaries and long careers in Switzerland, the 2nd pillar accumulates higher amounts than the Italian TFR."
 },
 de: {
 q: "Ist die Schweizer 2. Säule vorteilhafter als der italienische TFR?",
 a: "Das hängt vom Lohn, Alter und der Karrieredauer ab. Bei mittleren bis hohen Löhnen und langer Karriere in der Schweiz akkumuliert die 2. Säule höhere Beträge als der italienische TFR."
 },
 fr: {
 q: "Le 2e pilier suisse est-il plus avantageux que le TFR italien ?",
 a: "Cela dépend du salaire, de l'âge et de la durée de carrière. Pour des salaires moyens-élevés et de longues carrières en Suisse, le 2e pilier accumule des montants supérieurs au TFR italien."
 }
 },

 // ── Q68: B vs G (short variant) ──
 "Qual è la differenza tra Permesso B e Permesso G?": {
 en: {
 q: "What is the difference between a B permit and a G permit?",
 a: "The B permit is for those who reside in Switzerland; the G permit is for cross-border workers who live in Italy and work in Switzerland, returning home at least once a week."
 },
 de: {
 q: "Was ist der Unterschied zwischen B- und G-Bewilligung?",
 a: "Die B-Bewilligung ist für Personen mit Wohnsitz in der Schweiz; die G-Bewilligung ist für Grenzgänger, die in Italien leben und in der Schweiz arbeiten und mindestens einmal pro Woche heimkehren."
 },
 fr: {
 q: "Quelle est la différence entre le permis B et le permis G ?",
 a: "Le permis B est pour ceux qui résident en Suisse ; le permis G est pour les frontaliers qui vivent en Italie et travaillent en Suisse, en rentrant chez eux au moins une fois par semaine."
 }
 },

 // ── Q69: B vs G tax comparison ──
 "Conviene di più il Permesso B o G per le tasse?": {
 en: {
 q: "Which is more tax-efficient: the B permit or the G permit?",
 a: "It depends on salary, family situation, and municipality of residence. For high salaries, the B permit may offer lower rates thanks to ordinary taxation."
 },
 de: {
 q: "Was ist steuerlich günstiger: die B- oder die G-Bewilligung?",
 a: "Das hängt vom Lohn, der familiären Situation und der Wohngemeinde ab. Bei hohen Löhnen kann die B-Bewilligung dank ordentlicher Besteuerung niedrigere Steuersätze bieten."
 },
 fr: {
 q: "Quel est le plus avantageux fiscalement : le permis B ou le G ?",
 a: "Cela dépend du salaire, de la situation familiale et de la commune de résidence. Pour les hauts salaires, le permis B peut offrir des taux plus bas grâce à l'imposition ordinaire."
 }
 },

 // ── Q70: Italian declaration obligation ──
 "Devo dichiarare il reddito svizzero in Italia?": {
 en: {
 q: "Do I have to declare Swiss income in Italy?",
 a: "Yes, all foreign income must be declared in Section RW and in Section RC/RL of the tax return."
 },
 de: {
 q: "Muss ich Schweizer Einkommen in Italien deklarieren?",
 a: "Ja, alle ausländischen Einkünfte müssen im Abschnitt RW und im Abschnitt RC/RL der Steuererklärung deklariert werden."
 },
 fr: {
 q: "Dois-je déclarer le revenu suisse en Italie ?",
 a: "Oui, tous les revenus étrangers doivent être déclarés dans la section RW et dans la section RC/RL de la déclaration fiscale."
 }
 },

 // ── Q71: 730 vs Redditi PF (short) ──
 "Posso usare il 730 o devo fare il Modello Redditi PF?": {
 en: {
 q: "Can I use the 730 form or do I need the Modello Redditi PF?",
 a: "The absence of an Italian withholding agent does not by itself exclude form 730: a 730 without a withholding agent exists. The choice between 730 and Redditi PF depends on the income to declare and the requirements in that year’s instructions. Check your circumstances and the treatment of Swiss income before choosing. https://infoprecompilata.agenziaentrate.gov.it/portale/invia"
 },
 de: {
 q: "Kann ich das Formular 730 verwenden oder brauche ich das Modello Redditi PF?",
 a: "Allein das Fehlen eines italienischen Steuersubstituten schliesst das Formular 730 nicht aus: Es gibt ein 730 ohne Steuersubstitut. Die Wahl zwischen 730 und Redditi PF hängt von den Einkünften und den Voraussetzungen der Jahresanleitung ab. Prüfen Sie Ihre Situation und die Behandlung des Schweizer Einkommens vor der Auswahl. https://infoprecompilata.agenziaentrate.gov.it/portale/invia"
 },
 fr: {
 q: "Puis-je utiliser le formulaire 730 ou dois-je remplir le Modello Redditi PF ?",
 a: "La seule absence d’un substitut fiscal italien n’exclut pas le formulaire 730 : le 730 sans substitut existe. Le choix entre 730 et Redditi PF dépend des revenus à déclarer et des conditions des instructions de l’année. Vérifiez votre situation et le traitement du revenu suisse avant de choisir. https://infoprecompilata.agenziaentrate.gov.it/portale/invia"
 }
 },

 // ── Q72: Tax credit (short) ──
 "Come funziona il credito d'imposta per le tasse pagate in Svizzera?": {
 en: {
 q: "How does the tax credit for taxes paid in Switzerland work?",
 a: "The withholding tax paid in Switzerland is deducted from the Italian IRPEF, avoiding double taxation."
 },
 de: {
 q: "Wie funktioniert die Steuergutschrift für in der Schweiz gezahlte Steuern?",
 a: "Die in der Schweiz gezahlte Quellensteuer wird von der italienischen IRPEF abgezogen und vermeidet so eine Doppelbesteuerung."
 },
 fr: {
 q: "Comment fonctionne le crédit d'impôt pour les impôts payés en Suisse ?",
 a: "L'impôt à la source payé en Suisse est déduit de l'IRPEF italienne, évitant ainsi la double imposition."
 }
 },

 // ── Q73: €10,000 exemption (short) ──
 "Cos'è la franchigia di €10.000?": {
 en: {
 q: "What is the €10,000 exemption?",
 a: "Under the new 2026 agreement, the first €10,000 of income is exempt from Italian IRPEF for new cross-border workers."
 },
 de: {
 q: "Was ist der Freibetrag von 10.000 €?",
 a: "Nach dem neuen Abkommen 2026 sind die ersten 10.000 € Einkommen für neue Grenzgänger von der italienischen IRPEF befreit."
 },
 fr: {
 q: "Qu'est-ce que la franchise de 10 000 € ?",
 a: "Selon le nouvel accord 2026, les premiers 10 000 € de revenu sont exonérés de l'IRPEF italienne pour les nouveaux frontaliers."
 }
 },

 // ── Q74: Swiss bank account declaration ──
 "Devo dichiarare il conto bancario svizzero?": {
 en: {
 q: "Do I have to declare the Swiss bank account?",
 a: "Yes, the Swiss account must be declared in Section RW for tax monitoring purposes. You do not pay IVAFE on bank accounts."
 },
 de: {
 q: "Muss ich das Schweizer Bankkonto deklarieren?",
 a: "Ja, das Schweizer Konto muss im Abschnitt RW zur steuerlichen Überwachung deklariert werden. Auf Bankkonten zahlt man keine IVAFE."
 },
 fr: {
 q: "Dois-je déclarer le compte bancaire suisse ?",
 a: "Oui, le compte suisse doit être déclaré dans la section RW pour le suivi fiscal. Vous ne payez pas l'IVAFE sur les comptes bancaires."
 }
 },

 // ── Q75: 730 vs Redditi (detailed) ──
 "Il frontaliere deve fare il 730 o il Modello Redditi PF?": {
 en: {
 q: "Should a cross-border worker file the 730 or the Modello Redditi PF?",
 a: "The absence of an Italian withholding agent does not by itself exclude form 730: a 730 without a withholding agent exists. The choice between 730 and Redditi PF depends on the income to declare and the requirements in that year’s instructions. Check your circumstances and the treatment of Swiss income before choosing. https://infoprecompilata.agenziaentrate.gov.it/portale/invia"
 },
 de: {
 q: "Muss der Grenzgänger das 730 oder das Modello Redditi PF abgeben?",
 a: "Allein das Fehlen eines italienischen Steuersubstituten schliesst das Formular 730 nicht aus: Es gibt ein 730 ohne Steuersubstitut. Die Wahl zwischen 730 und Redditi PF hängt von den Einkünften und den Voraussetzungen der Jahresanleitung ab. Prüfen Sie Ihre Situation und die Behandlung des Schweizer Einkommens vor der Auswahl. https://infoprecompilata.agenziaentrate.gov.it/portale/invia"
 },
 fr: {
 q: "Le frontalier doit-il remplir le 730 ou le Modello Redditi PF ?",
 a: "La seule absence d’un substitut fiscal italien n’exclut pas le formulaire 730 : le 730 sans substitut existe. Le choix entre 730 et Redditi PF dépend des revenus à déclarer et des conditions des instructions de l’année. Vérifiez votre situation et le traitement du revenu suisse avant de choisir. https://infoprecompilata.agenziaentrate.gov.it/portale/invia"
 }
 },

 // ── Q76: €10,000 exemption (detailed) ──
 "Cos'è la franchigia di €10.000 per i nuovi frontalieri?": {
 en: {
 q: "What is the €10,000 exemption for new cross-border workers?",
 a: "Italian law excludes the first €10,000 a year of qualifying employment income earned abroad in border areas or neighbouring countries, continuously and as the exclusive object of the employment relationship, by Italian residents. Eligibility does not depend solely on hire date or the 20 km municipality zone. Salary covered by Article 9 for old workers instead benefits from the regime’s Italian exemption. https://documenti.camera.it/leg19/dossier/testi/FI0093.htm"
 },
 de: {
 q: "Was ist der Freibetrag von 10.000 € für neue Grenzgänger?",
 a: "Das italienische Recht nimmt jährlich die ersten 10.000 € qualifizierender Einkünfte italienischer Einwohner aus kontinuierlicher unselbständiger Arbeit im Ausland in Grenzgebieten oder Nachbarstaaten aus der Bemessungsgrundlage aus, sofern diese ausschliesslicher Gegenstand des Arbeitsverhältnisses ist. Nicht allein Einstellungsdatum oder 20-km-Gemeindezone entscheiden. Für den Lohn alter Grenzgänger nach Artikel 9 gilt dagegen die italienische Befreiung dieses Regimes. https://documenti.camera.it/leg19/dossier/testi/FI0093.htm"
 },
 fr: {
 q: "Qu'est-ce que la franchise de 10 000 € pour les nouveaux frontaliers ?",
 a: "La loi italienne exclut de l’assiette les premiers 10.000 € annuels des revenus admissibles de travail salarié exercé à l’étranger, dans les zones frontalières ou les pays limitrophes, de façon continue et comme objet exclusif du rapport de travail, par des résidents italiens. Ni la seule date d’embauche ni la zone des communes à 20 km ne déterminent ce droit. Le salaire des anciens couvert par l’article 9 bénéficie plutôt de l’exonération italienne de ce régime. https://documenti.camera.it/leg19/dossier/testi/FI0093.htm"
 }
 },

 // ── Q77: Quadro RW Swiss account ──
 "Come si compila il quadro RW per il conto svizzero?": {
 en: {
 q: "How do you fill out Section RW for the Swiss bank account?",
 a: "In Section RW, declare the Swiss bank account indicating: code 1 (deposits), country code 071 (Switzerland), maximum value reached during the year, and balance at 31/12. If the average balance exceeds €5,000, IVAFE of €34.20/year applies."
 },
 de: {
 q: "Wie füllt man Abschnitt RW für das Schweizer Bankkonto aus?",
 a: "Im Abschnitt RW wird das Schweizer Bankkonto angegeben mit: Code 1 (Einlagen), Ländercode 071 (Schweiz), im Jahr erreichter Höchstwert und Saldo per 31.12. Übersteigt der Durchschnittssaldo 5.000 €, fällt IVAFE von 34,20 €/Jahr an."
 },
 fr: {
 q: "Comment remplir la section RW pour le compte suisse ?",
 a: "Dans la section RW, on déclare le compte bancaire suisse en indiquant : code 1 (dépôts), code pays 071 (Suisse), valeur maximale atteinte dans l'année et solde au 31/12. Si le solde moyen dépasse 5 000 €, l'IVAFE de 34,20 €/an s'applique."
 }
 },

 // ── Q78: Quadro CE tax credit ──
 "Come funziona il credito d'imposta nel quadro CE?": {
 en: {
 q: "How does the tax credit work in Section CE?",
 a: "In Section CE, you declare the Swiss withholding tax paid, converted to EUR at the annual average exchange rate. The tax credit reduces the IRPEF due, up to the limit: it can never exceed the Italian IRPEF calculated on the foreign income. According to Elena Colombo, international tax accountant: 'Any excess credit can be carried forward to the next eight tax returns'."
 },
 de: {
 q: "Wie funktioniert die Steuergutschrift im Abschnitt CE?",
 a: "Im Abschnitt CE wird die gezahlte Schweizer Quellensteuer angegeben, zum Jahresdurchschnittskurs in EUR umgerechnet. Die Steuergutschrift reduziert die geschuldete IRPEF bis zur Obergrenze: Sie kann nie die auf das ausländische Einkommen berechnete italienische IRPEF übersteigen. Wie Elena Colombo, auf internationale Steuern spezialisierte Steuerberaterin, erklärt: «Ein allfälliger Überschuss der Steuergutschrift kann in die nächsten acht Steuererklärungen vorgetragen werden»."
 },
 fr: {
 q: "Comment fonctionne le crédit d'impôt dans la section CE ?",
 a: "Dans la section CE, on déclare l'impôt à la source suisse payé, converti en EUR au taux de change moyen annuel. Le crédit d'impôt réduit l'IRPEF due, dans la limite : il ne peut jamais dépasser l'IRPEF italienne calculée sur le revenu étranger. Comme l'explique Elena Colombo, comptable spécialisée en fiscalité internationale: «L'éventuel excédent du crédit peut être reporté sur les huit déclarations suivantes»."
 }
 },

 // ── Q79: Exchange rate for salary conversion ──
 "Quale tasso di cambio uso per convertire lo stipendio CHF in EUR?": {
 en: {
 q: "Which exchange rate should I use to convert CHF salary to EUR?",
 a: "Use the annual average exchange rate published by the Agenzia delle Entrate (notice issued in January of the following year). For 2025, the rate is published in January 2026. Do not use the exchange rate on the day of payment."
 },
 de: {
 q: "Welchen Wechselkurs verwende ich zur Umrechnung des CHF-Lohns in EUR?",
 a: "Man verwendet den Jahresdurchschnittskurs, der von der Agenzia delle Entrate veröffentlicht wird (Bekanntmachung im Januar des Folgejahres). Für 2025 wird der Kurs im Januar 2026 veröffentlicht. Nicht den Wechselkurs am Zahltag verwenden."
 },
 fr: {
 q: "Quel taux de change utiliser pour convertir le salaire CHF en EUR ?",
 a: "Utilisez le taux de change moyen annuel publié par l'Agenzia delle Entrate (avis publié en janvier de l'année suivante). Pour 2025, le taux est publié en janvier 2026. N'utilisez pas le taux de change du jour de paiement."
 }
 },

 // ── Q80: TDR explanation ──
 "Cos'è la TDR per frontalieri svizzeri?": {
 en: {
 q: "What is the TDR for Swiss cross-border workers?",
 a: "Do not confuse correction of an incorrect withholding with ordinary assessment allowing additional deductions. Ask the canton which procedure applies to your case. ESTV FAQ 5.3 excludes subsequent ordinary assessment (TOU) for fiscal frontier workers covered by the Italy–Switzerland agreement. Other categories must check eligibility and procedure with the tax authority. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Was ist die TDR für Schweizer Grenzgänger?",
 a: "Die Korrektur einer falschen Quellensteuer darf nicht mit einer ordentlichen Veranlagung für zusätzliche Abzüge verwechselt werden. Das anwendbare Verfahren beim Kanton klären. Laut ESTV-FAQ 5.3 ist die nachträgliche ordentliche Veranlagung für steuerliche Grenzgänger des Abkommens Italien–Schweiz ausgeschlossen. Andere Kategorien müssen Voraussetzungen und Verfahren bei der Steuerbehörde prüfen. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Qu'est-ce que le TDR pour les frontaliers suisses ?",
 a: "Ne pas confondre correction d’une retenue erronée et taxation ordinaire permettant d’autres déductions. Demander au canton quelle procédure s’applique. La FAQ 5.3 de l’AFC exclut la taxation ordinaire ultérieure pour les frontaliers fiscaux de l’accord Italie–Suisse. Les autres catégories doivent vérifier les conditions et la procédure auprès de l’autorité fiscale. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 // ── Q81: TDR deadline ──
 "Entro quando si presenta la TDR?": {
 en: {
 q: "By when must the TDR be submitted?",
 a: "Check the deadline for the applicable procedure with the cantonal authority: correcting withholding is not the same as requesting TOU. ESTV FAQ 5.3 excludes subsequent ordinary assessment (TOU) for fiscal frontier workers covered by the Italy–Switzerland agreement. Other categories must check eligibility and procedure with the tax authority. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Bis wann muss die TDR eingereicht werden?",
 a: "Die Frist des tatsächlich anwendbaren Verfahrens bei der kantonalen Behörde prüfen: Eine Quellensteuerkorrektur ist kein Antrag auf nachträgliche ordentliche Veranlagung. Laut ESTV-FAQ 5.3 ist die nachträgliche ordentliche Veranlagung für steuerliche Grenzgänger des Abkommens Italien–Schweiz ausgeschlossen. Andere Kategorien müssen Voraussetzungen und Verfahren bei der Steuerbehörde prüfen. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Avant quand faut-il soumettre le TDR ?",
 a: "Vérifier auprès du canton le délai de la procédure applicable : corriger une retenue ne revient pas à demander une taxation ordinaire ultérieure. La FAQ 5.3 de l’AFC exclut la taxation ordinaire ultérieure pour les frontaliers fiscaux de l’accord Italie–Suisse. Les autres catégories doivent vérifier les conditions et la procédure auprès de l’autorité fiscale. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 // ── Q82: TDR deductions ──
 "Quali deduzioni posso richiedere con la TDR?": {
 en: {
 q: "Which deductions can I claim through the TDR?",
 a: "There is no list of additional deductions applying to every frontier worker. Distinguish Italian filing, Swiss tax status and correction of withholding errors. ESTV FAQ 5.3 excludes subsequent ordinary assessment (TOU) for fiscal frontier workers covered by the Italy–Switzerland agreement. Other categories must check eligibility and procedure with the tax authority. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Welche Abzüge kann ich mit der TDR geltend machen?",
 a: "Es gibt keine für alle Grenzgänger geltende Liste zusätzlicher Abzüge. Italienische Steuererklärung, Schweizer Steuerstatus und Korrektur von Quellensteuerfehlern sind zu unterscheiden. Laut ESTV-FAQ 5.3 ist die nachträgliche ordentliche Veranlagung für steuerliche Grenzgänger des Abkommens Italien–Schweiz ausgeschlossen. Andere Kategorien müssen Voraussetzungen und Verfahren bei der Steuerbehörde prüfen. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Quelles déductions peut-on demander via le TDR ?",
 a: "Aucune liste de déductions supplémentaires ne vaut pour tous les frontaliers. Distinguer déclaration italienne, statut fiscal suisse et correction des erreurs de retenue. La FAQ 5.3 de l’AFC exclut la taxation ordinaire ultérieure pour les frontaliers fiscaux de l’accord Italie–Suisse. Les autres catégories doivent vérifier les conditions et la procédure auprès de l’autorité fiscale. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 // ── Q83: TDR refund calculation ──
 "Come viene calcolato il rimborso della rettifica?": {
 en: {
 q: "How is the TDR rectification refund calculated?",
 a: "The Tax Office recalculates the withholding tax including the declared deductions. The difference between the tax withheld by the employer and the recalculated tax is refunded directly to the bank account, generally within 3–6 months."
 },
 de: {
 q: "Wie wird die TDR-Berichtigungsrückerstattung berechnet?",
 a: "Das Steueramt berechnet die Quellensteuer inkl. der deklarierten Abzüge neu. Die Differenz zwischen der vom Arbeitgeber einbehaltenen Steuer und der neuberechneten Steuer wird direkt auf das Bankkonto überwiesen, in der Regel innerhalb von 3–6 Monaten."
 },
 fr: {
 q: "Comment le remboursement de la rectification est-il calculé ?",
 a: "L'Office des impôts recalcule l'impôt à la source en incluant les déductions déclarées. La différence entre l'impôt retenu par l'employeur et l'impôt recalculé est remboursée directement sur le compte bancaire, généralement sous 3 à 6 mois."
 }
 },

 // ── Q84: Ordinary declaration for G permit ──
 "Il frontaliere con permesso G deve fare la dichiarazione ordinaria in Svizzera?": {
 en: {
 q: "Does a G-permit cross-border worker need to file an ordinary declaration in Switzerland?",
 a: "The G permit alone does not determine tax procedure. ESTV FAQ 5.3 excludes subsequent ordinary assessment for fiscal frontier workers under the Italy–Switzerland agreement; income above CHF 120,000 does not automatically trigger it. Other categories should check their obligations with the canton. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Muss ein Grenzgänger mit G-Bewilligung eine ordentliche Steuererklärung in der Schweiz abgeben?",
 a: "Die G-Bewilligung allein bestimmt das Steuerverfahren nicht. ESTV-FAQ 5.3 schliesst die nachträgliche ordentliche Veranlagung für steuerliche Grenzgänger des Abkommens Italien–Schweiz aus; ein Einkommen über CHF 120.000 löst sie nicht automatisch aus. Andere Kategorien müssen ihre Pflichten beim Kanton prüfen. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Un frontalier avec permis G doit-il faire une déclaration ordinaire en Suisse ?",
 a: "Le permis G seul ne détermine pas la procédure fiscale. La FAQ 5.3 de l’AFC exclut la taxation ordinaire ultérieure pour les frontaliers fiscaux de l’accord Italie–Suisse ; un revenu supérieur à CHF 120.000 ne la déclenche pas automatiquement. Pour les autres catégories, vérifier les obligations auprès du canton. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 // ── Q85: Average salaries in Ticino ──
 "Quali sono gli stipendi medi in Ticino nel 2026?": {
 en: {
 q: "What are the average salaries in Ticino in 2026?",
 a: "Median salary in Ticino ranges from CHF 48,000–55,000 for entry-level retail/catering positions to CHF 125,000–200,000+ for senior roles in finance, pharma, and IT."
 },
 de: {
 q: "Wie hoch sind die Durchschnittslöhne im Tessin 2026?",
 a: "Der Medianlohn im Tessin reicht von CHF 48.000–55.000 für Einstiegspositionen im Handel/Gastronomie bis CHF 125.000–200.000+ für Seniorpositionen in Finanzen, Pharma und IT."
 },
 fr: {
 q: "Quels sont les salaires moyens au Tessin en 2026 ?",
 a: "Le salaire médian au Tessin va de CHF 48 000 à 55 000 pour les postes d'entrée dans le commerce/restauration à CHF 125 000 à 200 000+ pour les postes seniors en finance, pharma et informatique."
 }
 },

 // ── Q86: IT worker salary ──
 "Quanto guadagna un informatico frontaliere in Svizzera?": {
 en: {
 q: "How much does a cross-border IT worker earn in Switzerland?",
 a: "A cross-border Software Developer in Ticino earns on average CHF 72,000 gross as a junior, CHF 95,000 as mid-level, and CHF 125,000+ as a senior."
 },
 de: {
 q: "Wie viel verdient ein Informatik-Grenzgänger in der Schweiz?",
 a: "Ein Grenzgänger-Softwareentwickler im Tessin verdient im Durchschnitt brutto CHF 72.000 als Junior, CHF 95.000 als Mid-Level und CHF 125.000+ als Senior."
 },
 fr: {
 q: "Combien gagne un informaticien frontalier en Suisse ?",
 a: "Un développeur logiciel frontalier au Tessin gagne en moyenne CHF 72 000 brut comme junior, CHF 95 000 comme intermédiaire et CHF 125 000+ comme senior."
 }
 },

 // ── Q87: Economic convenience ──
 "Conviene fare il frontaliere dal punto di vista economico?": {
 en: {
 q: "Is being a cross-border worker financially worthwhile?",
 a: "In most sectors, cross-border workers earn 100% to 200% more than in Italy, even considering transport costs. With PPP adjustment, the advantage reduces to 30–80%."
 },
 de: {
 q: "Lohnt es sich finanziell, Grenzgänger zu sein?",
 a: "In den meisten Branchen verdienen Grenzgänger 100 % bis 200 % mehr als in Italien, selbst unter Berücksichtigung der Transportkosten. Mit Kaufkraftbereinigung reduziert sich der Vorteil auf 30–80 %."
 },
 fr: {
 q: "Est-ce financièrement avantageux d'être frontalier ?",
 a: "Dans la plupart des secteurs, les frontaliers gagnent 100 à 200 % de plus qu'en Italie, même en tenant compte des frais de transport. En parité de pouvoir d'achat, l'avantage se réduit à 30–80 %."
 }
 },

 // ── Q88: Tax mechanism for G permit ──
 "Come vengono tassati gli stipendi dei frontalieri?": {
 en: {
 q: "How are cross-border workers' salaries taxed?",
 a: "G-permit cross-border workers pay withholding tax in Ticino (3–18%) plus Swiss social contributions. Under the New Agreement 2026, 80% of taxes remain in Switzerland."
 },
 de: {
 q: "Wie werden die Löhne der Grenzgänger besteuert?",
 a: "Grenzgänger mit G-Bewilligung zahlen Quellensteuer im Tessin (3–18 %) plus Schweizer Sozialabgaben. Gemäss dem neuen Abkommen 2026 verbleiben 80 % der Steuern in der Schweiz."
 },
 fr: {
 q: "Comment les salaires des frontaliers sont-ils imposés ?",
 a: "Les frontaliers avec permis G paient l'impôt à la source au Tessin (3 à 18 %) plus les cotisations sociales suisses. Selon le nouvel accord 2026, 80 % des impôts restent en Suisse."
 }
 },

 // ── Q89: Highest paying sectors ──
 "Quali settori pagano di più in Ticino?": {
 en: {
 q: "Which sectors pay the most in Ticino?",
 a: "The highest-paying sectors are: Finance (senior median CHF 145,000), Consulting (CHF 150,000), Pharma (CHF 135,000), and IT (CHF 125,000)."
 },
 de: {
 q: "Welche Branchen zahlen im Tessin am meisten?",
 a: "Die bestbezahlten Branchen sind: Finanzen (Senior-Median CHF 145.000), Beratung (CHF 150.000), Pharma (CHF 135.000) und IT (CHF 125.000)."
 },
 fr: {
 q: "Quels secteurs paient le plus au Tessin ?",
 a: "Les secteurs les mieux rémunérés sont : Finance (médiane senior CHF 145 000), Conseil (CHF 150 000), Pharma (CHF 135 000) et Informatique (CHF 125 000)."
 }
 },

 // ── Q90: Most in-demand roles ──
 "Come vengono calcolati i ruoli piu richiesti in Ticino?": {
 en: {
 q: "How are the most in-demand roles in Ticino calculated?",
 a: "The page uses the volume of active and published job listings on the Frontaliere Ticino job board to show the most dynamic roles, companies, and locations."
 },
 de: {
 q: "Wie werden die am meisten nachgefragten Rollen im Tessin berechnet?",
 a: "Die Seite nutzt das Volumen der aktiven und veröffentlichten Stellenanzeigen auf dem Job Board Frontaliere Ticino, um die dynamischsten Rollen, Unternehmen und Standorte darzustellen."
 },
 fr: {
 q: "Comment les rôles les plus demandés au Tessin sont-ils calculés ?",
 a: "La page utilise le volume d'offres d'emploi actives et publiées sur le job board Frontaliere Ticino pour montrer les rôles, entreprises et localités les plus dynamiques."
 }
 },

 // ── Q91: Gross vs net salaries ──
 "Gli stipendi mostrati sono netti o lordi?": {
 en: {
 q: "Are the salaries shown net or gross?",
 a: "The observatory uses the annual gross salary ranges from job listings and calculates observed averages and medians for companies, locations, and roles."
 },
 de: {
 q: "Sind die angezeigten Löhne netto oder brutto?",
 a: "Das Observatorium nutzt die Brutto-Jahresgehaltsangaben aus den Stellenanzeigen und berechnet beobachtete Durchschnitte und Mediane für Unternehmen, Standorte und Rollen."
 },
 fr: {
 q: "Les salaires affichés sont-ils nets ou bruts ?",
 a: "L'observatoire utilise les fourchettes salariales annuelles brutes des offres d'emploi et calcule les moyennes et médianes observées par entreprise, localité et rôle."
 }
 },

 // ── Q92: Observatory update frequency ──
 "Con quale frequenza viene aggiornato l osservatorio?": {
 en: {
 q: "How often is the observatory updated?",
 a: "The observatory is updated daily when the job board is regenerated with new listings, removals, and updates."
 },
 de: {
 q: "Wie oft wird das Observatorium aktualisiert?",
 a: "Das Observatorium wird täglich aktualisiert, wenn das Job Board mit neuen Anzeigen, Löschungen und Aktualisierungen regeneriert wird."
 },
 fr: {
 q: "À quelle fréquence l'observatoire est-il mis à jour ?",
 a: "L'observatoire est mis à jour quotidiennement lorsque le job board est régénéré avec les nouvelles annonces, suppressions et mises à jour."
 }
 },

 // ── Q93: Fiscal rebates (ristorni) ──
 "Cosa sono i ristorni fiscali per frontalieri?": {
 en: {
 q: "What are fiscal rebates (ristorni) for cross-border workers?",
 a: "Fiscal rebates are compensations that Switzerland pays to Italy, equal to 40% of the withholding tax deducted from cross-border workers. These funds are distributed to the Italian municipalities where the workers reside to finance local services."
 },
 de: {
 q: "Was sind die steuerlichen Rückvergütungen (Ristorni) für Grenzgänger?",
 a: "Steuerliche Rückvergütungen sind Ausgleichszahlungen, die die Schweiz an Italien leistet, in Höhe von 40 % der Quellensteuer, die Grenzgängern abgezogen wird. Diese Mittel werden an die italienischen Wohnsitzgemeinden der Grenzgänger verteilt, um lokale Dienstleistungen zu finanzieren."
 },
 fr: {
 q: "Que sont les rétrocessions fiscales (ristorni) pour les frontaliers ?",
 a: "Les rétrocessions fiscales sont des compensations que la Suisse verse à l'Italie, égales à 40 % de l'impôt à la source prélevé aux frontaliers. Ces fonds sont distribués aux communes italiennes de résidence des travailleurs pour financer les services locaux."
 }
 },

 // ── Q94: Who receives ristorni ──
 "Chi riceve i ristorni fiscali?": {
 en: {
 q: "Who receives the fiscal rebates?",
 a: "The rebates are paid to Italian municipalities located within 20 km of the Swiss border. The main beneficiary municipalities are in the provinces of Como, Varese, Verbano-Cusio-Ossola, and Sondrio."
 },
 de: {
 q: "Wer erhält die steuerlichen Rückvergütungen?",
 a: "Die Rückvergütungen werden an italienische Gemeinden innerhalb von 20 km zur Schweizer Grenze ausgezahlt. Die wichtigsten Empfängergemeinden liegen in den Provinzen Como, Varese, Verbano-Cusio-Ossola und Sondrio."
 },
 fr: {
 q: "Qui reçoit les rétrocessions fiscales ?",
 a: "Les rétrocessions sont versées aux communes italiennes situées dans un rayon de 20 km de la frontière suisse. Les principales communes bénéficiaires se trouvent dans les provinces de Côme, Varèse, Verbano-Cusio-Ossola et Sondrio."
 }
 },

 // ── Q95: Ristorni amounts ──
 "Quanto vale un ristorno fisale per comune?": {
 en: {
 q: "How much is a fiscal rebate worth per municipality?",
 a: "The amount varies greatly: municipalities with many cross-border workers like Lavena Ponte Tresa, Porlezza, or Ponte Chiasso receive hundreds of thousands of euros, while smaller municipalities receive lower amounts. The annual total exceeds €90 million."
 },
 de: {
 q: "Wie viel ist eine steuerliche Rückvergütung pro Gemeinde wert?",
 a: "Der Betrag variiert stark: Gemeinden mit vielen Grenzgängern wie Lavena Ponte Tresa, Porlezza oder Ponte Chiasso erhalten Hunderttausende Euro, während kleinere Gemeinden geringere Beträge erhalten. Die Jahressumme übersteigt 90 Millionen Euro."
 },
 fr: {
 q: "Combien vaut une rétrocession fiscale par commune ?",
 a: "Le montant varie considérablement : les communes avec de nombreux frontaliers comme Lavena Ponte Tresa, Porlezza ou Ponte Chiasso reçoivent des centaines de milliers d'euros, tandis que les plus petites communes reçoivent des montants inférieurs. Le total annuel dépasse 90 millions d'euros."
 }
 },

 // ── Q96: Ristorni under new agreement ──
 "I ristorni continueranno con il nuovo accordo 2026?": {
 en: {
 q: "Will rebates continue under the new 2026 agreement?",
 a: "For new fiscal cross-border workers, Switzerland applies 80% of its ordinary withholding rate; Italy taxes the income with a credit for Swiss tax. The 80% is not a revenue split between the two countries. Old cross-border workers who qualify under Article 9 retain exclusive Swiss taxation of the covered salary. Their regime does not automatically end in 2033 or 2034: 2033 is the final tax year of Swiss compensation payments to Italy. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Werden die Rückvergütungen mit dem neuen Abkommen 2026 fortgesetzt?",
 a: "Für neue steuerliche Grenzgänger wendet die Schweiz 80% des ordentlichen Quellensteuertarifs an; Italien besteuert das Einkommen mit Anrechnung der Schweizer Steuer. Die 80% sind keine Aufteilung der Einnahmen zwischen den Staaten. Alte Grenzgänger, die Artikel 9 erfüllen, behalten die ausschliessliche Schweizer Besteuerung des erfassten Lohns. Das Regime endet nicht automatisch 2033 oder 2034; 2033 ist das letzte Steuerjahr der Ausgleichszahlungen an Italien. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Les rétrocessions continueront-elles avec le nouvel accord 2026 ?",
 a: "Pour les nouveaux frontaliers fiscaux, la Suisse applique 80% du taux ordinaire de retenue; l’Italie impose le revenu en accordant un crédit pour l’impôt suisse. Les 80% ne sont pas un partage des recettes entre les États. Les anciens frontaliers remplissant les conditions de l’article 9 conservent l’imposition exclusivement suisse du salaire concerné. Ce régime ne prend pas automatiquement fin en 2033 ou 2034; 2033 est la dernière année fiscale des compensations versées à l’Italie. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 // ── Q97: Check ristorni per municipality ──
 "Come posso sapere quanto riceve il mio comune dai ristorni?": {
 en: {
 q: "How can I find out how much my municipality receives from rebates?",
 a: "Our page shows the historical rebate data for each Italian border municipality. Data is updated annually based on official communications between the two states."
 },
 de: {
 q: "Wie kann ich erfahren, wie viel meine Gemeinde aus den Rückvergütungen erhält?",
 a: "Unsere Seite zeigt die historischen Rückvergütungsdaten für jede italienische Grenzgemeinde. Die Daten werden jährlich anhand der offiziellen Mitteilungen zwischen den beiden Staaten aktualisiert."
 },
 fr: {
 q: "Comment puis-je savoir combien ma commune reçoit des rétrocessions ?",
 a: "Notre page affiche les données historiques des rétrocessions pour chaque commune italienne frontalière. Les données sont mises à jour annuellement sur la base des communications officielles entre les deux États."
 }
 },

 // ── Q98: NASpI application deadline ──
 "Entro quando va presentata la domanda NASpI per un ex frontaliere?": {
 en: {
 q: "By when must the NASpI application be submitted for a former cross-border worker?",
 a: "The application must be submitted to INPS within 68 days of the end of the employment relationship. The sooner the application is submitted, the sooner the benefit starts."
 },
 de: {
 q: "Bis wann muss der NASpI-Antrag für einen ehemaligen Grenzgänger eingereicht werden?",
 a: "Der Antrag muss innerhalb von 68 Tagen nach Beendigung des Arbeitsverhältnisses beim INPS eingereicht werden. Je früher der Antrag gestellt wird, desto früher beginnt die Leistung."
 },
 fr: {
 q: "Avant quand faut-il déposer la demande NASpI pour un ancien frontalier ?",
 a: "La demande doit être déposée auprès de l'INPS dans les 68 jours suivant la fin du contrat de travail. Plus la demande est soumise tôt, plus la prestation commence rapidement."
 }
 },

 // ── Q99: Documents for ex-frontaliere ──
 "Quali documenti servono di solito a un ex frontaliere?": {
 en: {
 q: "What documents does a former cross-border worker usually need?",
 a: "Typically needed: identity document, IBAN, termination letter, payslips, employment contract, and documents useful for reconstructing the contribution history between Switzerland and Italy."
 },
 de: {
 q: "Welche Dokumente benötigt ein ehemaliger Grenzgänger in der Regel?",
 a: "In der Regel benötigt werden: Ausweisdokument, IBAN, Kündigungsschreiben, Lohnabrechnungen, Arbeitsvertrag und Dokumente zur Rekonstruktion der Beitragszeit zwischen der Schweiz und Italien."
 },
 fr: {
 q: "Quels documents faut-il habituellement pour un ancien frontalier ?",
 a: "Généralement nécessaires : pièce d'identité, IBAN, lettre de cessation, bulletins de salaire, contrat de travail et documents utiles pour reconstituer l'historique de cotisation entre la Suisse et l'Italie."
 }
 },

 // ── Q100: NASpI vs Swiss unemployment ──
 "La NASpI e uguale alla disoccupazione svizzera?": {
 en: {
 q: "Is NASpI the same as Swiss unemployment?",
 a: "No. NASpI is an Italian benefit with different rules, amounts, and duration from Swiss unemployment insurance. For former cross-border workers, the transition from one system to the other significantly changes the expected monthly amount."
 },
 de: {
 q: "Ist die NASpI dasselbe wie die Schweizer Arbeitslosenversicherung?",
 a: "Nein. Die NASpI ist eine italienische Leistung mit anderen Regeln, Beträgen und Dauer als die Schweizer Arbeitslosenversicherung. Für ehemalige Grenzgänger ändert der Wechsel von einem System zum anderen den erwarteten monatlichen Betrag erheblich."
 },
 fr: {
 q: "La NASpI est-elle identique au chômage suisse ?",
 a: "Non. La NASpI est une prestation italienne avec des règles, des montants et une durée différents de l'assurance chômage suisse. Pour les anciens frontaliers, le passage d'un système à l'autre modifie considérablement le montant mensuel attendu."
 }
 },

 // ── Q101: Pension calculation (general) ──
 "Come si calcola la pensione di un frontaliere?": {
 en: {
 q: "How is a cross-border worker's pension calculated?",
 a: "A cross-border worker's pension has 3 components: Swiss AVS (1st pillar, max CHF 2,520/month with 44 years of contributions), LPP (2nd pillar, depends on accumulated contributions), and Italian INPS (for years worked in Italy). The Swiss and Italian contribution periods can be totalized."
 },
 de: {
 q: "Wie wird die Rente eines Grenzgängers berechnet?",
 a: "Die Rente eines Grenzgängers hat 3 Komponenten: Schweizer AHV (1. Säule, max. CHF 2.520/Monat bei 44 Beitragsjahren), BVG (2. Säule, abhängig von den angesammelten Beiträgen) und italienische INPS (für in Italien gearbeitete Jahre). Die Schweizer und italienischen Beitragszeiten können zusammengerechnet werden."
 },
 fr: {
 q: "Comment est calculée la retraite d'un frontalier ?",
 a: "La retraite d'un frontalier comporte 3 composantes : l'AVS suisse (1er pilier, max CHF 2 520/mois avec 44 ans de cotisations), la LPP (2e pilier, selon les cotisations accumulées) et l'INPS italienne (pour les années travaillées en Italie). Les périodes de cotisation suisses et italiennes peuvent être totalisées."
 }
 },

 // ── Q102: Failure to declare Swiss income ──
 "Cosa succede se non dichiaro il reddito svizzero in Italia?": {
 en: {
 q: "What happens if I don't declare my Swiss income in Italy?",
 a: "Failure to declare foreign income carries penalties of 120% to 240% of the tax owed, plus default interest. For RW form violations (Swiss account monitoring), the penalty ranges from 3% to 15% of the undeclared amounts. Voluntary compliance reduces penalties significantly."
 },
 de: {
 q: "Was passiert, wenn ich das Schweizer Einkommen in Italien nicht deklariere?",
 a: "Die Nichtdeklaration ausländischer Einkünfte wird mit Strafen von 120 % bis 240 % der geschuldeten Steuer belegt, zuzüglich Verzugszinsen. Bei Verstössen gegen das RW-Formular (Überwachung des Schweizer Kontos) beträgt die Strafe 3 % bis 15 % der nicht deklarierten Beträge. Freiwillige Offenlegung reduziert die Strafen erheblich."
 },
 fr: {
 q: "Que se passe-t-il si je ne déclare pas mes revenus suisses en Italie ?",
 a: "Le défaut de déclaration des revenus étrangers entraîne des pénalités de 120 % à 240 % de l'impôt dû, plus intérêts de retard. Pour les violations du formulaire RW (surveillance du compte suisse), la sanction va de 3 % à 15 % des montants non déclarés. La régularisation spontanée réduit considérablement les pénalités."
 }
 },

 // ── Q103: Tax table vs municipality ──
 "La tabella dipende dal Comune italiano di residenza?": {
 en: {
 q: "Does the tax table depend on the Italian municipality of residence?",
 a: "No. The Swiss withholding tax table depends mainly on marital status and number of children. The Italian municipality matters for Italian taxation, not for the Ticino withholding tax class."
 },
 de: {
 q: "Hängt die Steuertabelle von der italienischen Wohngemeinde ab?",
 a: "Nein. Die Schweizer Quellensteuertabelle hängt hauptsächlich vom Zivilstand und der Kinderzahl ab. Die italienische Gemeinde ist für die italienische Besteuerung relevant, nicht für die Tessiner Quellensteuerklasse."
 },
 fr: {
 q: "Le barème dépend-il de la commune italienne de résidence ?",
 a: "Non. Le barème de l'impôt à la source suisse dépend principalement de l'état civil et du nombre d'enfants. La commune italienne compte pour la fiscalité italienne, pas pour la classe d'impôt à la source tessinoise."
 }
 },

 // ── Q104: Payslip vs simulator discrepancy ──
 "Perche la percentuale in busta paga puo differire dal simulatore?": {
 en: {
 q: "Why can the tax percentage on the payslip differ from the simulator?",
 a: "The most common causes are: wrong tax table applied, children not registered, 13th salary effects, bonuses, pay period differences, or discrepancies between the annual gross and the monthly gross used by payroll."
 },
 de: {
 q: "Warum kann der Steuerprozentsatz auf der Lohnabrechnung vom Simulator abweichen?",
 a: "Die häufigsten Ursachen sind: falsche Steuertabelle angewendet, Kinder nicht registriert, 13. Monatsgehaltseffekte, Boni, Unterschiede in der Lohnperiode oder Abweichungen zwischen dem Jahresbrutto und dem vom Payroll verwendeten Monatsbrutto."
 },
 fr: {
 q: "Pourquoi le pourcentage d'impôt sur la fiche de paie peut-il différer du simulateur ?",
 a: "Les causes les plus fréquentes sont : mauvais barème appliqué, enfants non enregistrés, effets du 13e salaire, bonus, différences de période de paie ou écarts entre le brut annuel et le brut mensuel utilisé par le service paie."
 }
 },

 // ── Landing page FAQ: SALARY_LANDING_FAQ_SCHEMA (seo-landing.ts) ──────
 "Come si calcola lo stipendio netto di un frontaliere in Ticino?": {
 en: {
 q: "How is a cross-border worker's net salary calculated in Ticino?",
 a: "The net salary depends on Swiss social contributions (AVS/AI/IPG, AC, LPP) and withholding tax in Ticino, plus IRPEF and tax credit in Italy (2026 new agreement)."
 },
 de: {
 q: "Wie wird das Nettogehalt eines Grenzgängers im Tessin berechnet?",
 a: "Das Nettogehalt hängt von den Schweizer Sozialabgaben (AHV/IV/EO, ALV, BVG) und der Quellensteuer im Tessin ab, sowie von der IRPEF und der Steueranrechnung in Italien (neues Abkommen 2026)."
 },
 fr: {
 q: "Comment calcule-t-on le salaire net d'un frontalier au Tessin ?",
 a: "Le salaire net dépend des cotisations sociales suisses (AVS/AI/APG, AC, LPP) et de l'impôt à la source au Tessin, ainsi que de l'IRPEF et du crédit d'impôt en Italie (nouvel accord 2026)."
 }
 },
 "Che differenza c'è tra vecchio e nuovo frontaliere (accordo 2026)?": {
 en: {
 q: "What is the difference between old and new cross-border workers (2026 agreement)?",
 a: "An old worker qualifying under Article 9 worked as a tax cross-border worker in Ticino, Graubünden or Valais between 31 December 2018 and 17 July 2023: the covered salary is taxed exclusively in Switzerland. New tax cross-border workers pay 80% of ordinary Swiss withholding tax and Italian tax with credit for Swiss tax. An eligible municipality of residence and, in principle, daily return also matter, not just the latest contract date. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Was ist der Unterschied zwischen alten und neuen Grenzgängern (Abkommen 2026)?",
 a: "Ein alter Grenzgänger nach Artikel 9 war zwischen dem 31. Dezember 2018 und dem 17. Juli 2023 als steuerlicher Grenzgänger im Tessin, in Graubünden oder im Wallis tätig: Der erfasste Lohn wird ausschliesslich in der Schweiz besteuert. Neue steuerliche Grenzgänger zahlen 80% der ordentlichen Schweizer Quellensteuer und italienische Steuer unter Anrechnung der Schweizer Steuer. Auch die zugelassene Wohngemeinde und grundsätzlich tägliche Rückkehr zählen, nicht nur das letzte Vertragsdatum. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Quelle est la différence entre ancien et nouveau frontalier (accord 2026) ?",
 a: "Un ancien frontalier admissible selon l’article 9 a travaillé comme frontalier fiscal au Tessin, dans les Grisons ou en Valais entre le 31 décembre 2018 et le 17 juillet 2023 : le salaire concerné est imposé exclusivement en Suisse. Les nouveaux frontaliers fiscaux paient 80% de l’impôt suisse à la source ordinaire et l’impôt italien avec crédit pour l’impôt suisse. La commune de résidence admise et le retour en principe quotidien comptent aussi, pas seulement la date du dernier contrat. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },
 "Il numero di figli influisce sul netto?": {
 en: {
 q: "Does the number of children affect the net salary?",
 a: "Yes: it can affect deductions/rates and the withholding tax bracket, as well as family allowances and tax deductions."
 },
 de: {
 q: "Beeinflusst die Anzahl der Kinder das Nettogehalt?",
 a: "Ja: Sie kann sich auf Abzüge/Steuersätze und die Quellensteuertabelle auswirken, ebenso auf Familienzulagen und Steuerabzüge."
 },
 fr: {
 q: "Le nombre d'enfants influence-t-il le salaire net ?",
 a: "Oui : il peut influencer les déductions/taux et le barème d'impôt à la source, ainsi que les allocations familiales et les déductions fiscales."
 }
 },
 "Quali parametri contano di più nella simulazione?": {
 en: {
 q: "Which parameters matter most in the simulation?",
 a: "Annual income, marital status, children, distance/residence (within/over 20 km), cross-border worker type, age (LPP) and CHF/EUR exchange rate."
 },
 de: {
 q: "Welche Parameter sind bei der Simulation am wichtigsten?",
 a: "Jahreseinkommen, Familienstand, Kinder, Entfernung/Wohnsitz (innerhalb/über 20 km), Grenzgängertyp, Alter (BVG) und CHF/EUR-Wechselkurs."
 },
 fr: {
 q: "Quels paramètres comptent le plus dans la simulation ?",
 a: "Revenu annuel, état civil, enfants, distance/résidence (dans/au-delà de 20 km), type de frontalier, âge (LPP) et taux de change CHF/EUR."
 }
 },
 "Il simulatore considera il cambio CHF/EUR?": {
 en: {
 q: "Does the simulator consider the CHF/EUR exchange rate?",
 a: "Yes: you can use the automatic rate or set a custom exchange rate to estimate taxes and net salary also in EUR."
 },
 de: {
 q: "Berücksichtigt der Simulator den CHF/EUR-Wechselkurs?",
 a: "Ja: Sie können den automatischen Kurs verwenden oder einen individuellen Wechselkurs einstellen, um Steuern und Nettogehalt auch in EUR zu berechnen."
 },
 fr: {
 q: "Le simulateur tient-il compte du taux de change CHF/EUR ?",
 a: "Oui : vous pouvez utiliser le taux automatique ou définir un taux de change personnalisé pour estimer les impôts et le salaire net aussi en EUR."
 }
 },
 "I risultati sono una consulenza fiscale?": {
 en: {
 q: "Are the results professional tax advice?",
 a: "No: it is an informational estimate based on known parameters and tables. For complex cases, it is advisable to verify with a professional."
 },
 de: {
 q: "Sind die Ergebnisse eine Steuerberatung?",
 a: "Nein: Es handelt sich um eine informative Schätzung auf der Grundlage bekannter Parameter und Tabellen. Bei komplexen Fällen empfiehlt sich die Überprüfung durch einen Fachmann."
 },
 fr: {
 q: "Les résultats constituent-ils un conseil fiscal ?",
 a: "Non : il s'agit d'une estimation informative basée sur des paramètres et des barèmes connus. Pour les cas complexes, il est conseillé de vérifier avec un professionnel."
 }
 },

 // ── Landing page FAQ: nuovi frontalieri oltre 20 km (seo-landing.ts) ──
 "Chi rientra tra i nuovi frontalieri oltre 20 km?": {
 en: {
 q: "Who qualifies as a new cross-border worker beyond 20 km?",
 a: "This applies to anyone who started a cross-border employment relationship from 17 July 2023 onwards and resides in an Italian municipality more than 20 km from the Swiss border."
 },
 de: {
 q: "Wer zählt zu den neuen Grenzgängern über 20 km?",
 a: "Dies betrifft alle, die ab dem 17. Juli 2023 ein Grenzgänger-Arbeitsverhältnis begonnen haben und in einer italienischen Gemeinde wohnen, die mehr als 20 km von der Schweizer Grenze entfernt ist."
 },
 fr: {
 q: "Qui fait partie des nouveaux frontaliers au-delà de 20 km ?",
 a: "Cela concerne toute personne ayant commencé une relation de travail transfrontalière à partir du 17 juillet 2023 et résidant dans une commune italienne à plus de 20 km de la frontière suisse."
 }
 },
 "Cosa cambia rispetto a chi vive entro 20 km?": {
 en: {
 q: "What changes compared to those living within 20 km?",
 a: "For new cross-border workers beyond 20 km, the tax is fully withheld in Switzerland, while within 20 km Switzerland withholds 80% and Italy taxes the income with a credit for taxes already paid."
 },
 de: {
 q: "Was ändert sich im Vergleich zu denjenigen, die innerhalb von 20 km wohnen?",
 a: "Bei neuen Grenzgängern über 20 km wird die Steuer vollständig in der Schweiz einbehalten, während innerhalb von 20 km die Schweiz 80 % einbehält und Italien das Einkommen mit Anrechnung der bereits gezahlten Steuern besteuert."
 },
 fr: {
 q: "Qu'est-ce qui change par rapport à ceux qui habitent dans les 20 km ?",
 a: "Pour les nouveaux frontaliers au-delà de 20 km, l'impôt est intégralement retenu en Suisse, tandis qu'en deçà de 20 km la Suisse retient 80 % et l'Italie impose le revenu avec un crédit pour les impôts déjà payés."
 }
 },
 "Questa pagina sostituisce la consulenza fiscale?": {
 en: {
 q: "Does this page replace professional tax advice?",
 a: "No. The page helps understand scenarios and orders of magnitude, but for specific cases it is advisable to verify with a tax professional specializing in cross-border workers."
 },
 de: {
 q: "Ersetzt diese Seite die steuerliche Beratung?",
 a: "Nein. Die Seite hilft, Szenarien und Größenordnungen zu verstehen, aber bei besonderen Fällen empfiehlt sich eine Überprüfung durch einen auf Grenzgänger spezialisierten Steuerfachmann."
 },
 fr: {
 q: "Cette page remplace-t-elle le conseil fiscal ?",
 a: "Non. La page aide à comprendre les scénarios et les ordres de grandeur, mais pour les cas particuliers il est conseillé de vérifier avec un professionnel fiscal spécialisé dans les frontaliers."
 }
 },

 // ── Calculator (homepage) FAQs ──
 "Come funziona la simulazione tasse per nuovi frontalieri?": {
 en: {
 q: "How does the tax simulation work for new cross-border workers?",
 a: "The simulator calculates net pay from annual gross salary in CHF. It applies Swiss deductions (AVS 5.3%, AC 1.1%, LPP by age), Ticino withholding tax using 2026 tables, and then Italian IRPEF with the €10,000 exemption under the new agreement. The result shows a comparison between Swiss residence (Permit B) and commuting from Italy (Permit G)."
 },
 de: {
 q: "Wie funktioniert die Steuersimulation für neue Grenzgänger?",
 a: "Der Simulator berechnet den Nettolohn ausgehend vom jährlichen Bruttolohn in CHF. Er wendet die Schweizer Abzüge (AHV 5,3 %, ALV 1,1 %, BVG nach Alter), die Tessiner Quellensteuer mit den Tabellen 2026 und dann die italienische IRPEF mit dem Freibetrag von 10.000 € gemäss dem neuen Abkommen an. Das Ergebnis zeigt einen Vergleich zwischen Wohnsitz in der Schweiz (Bewilligung B) und Pendeln aus Italien (Bewilligung G)."
 },
 fr: {
 q: "Comment fonctionne la simulation fiscale pour les nouveaux frontaliers ?",
 a: "Le simulateur calcule le salaire net à partir du brut annuel en CHF. Il applique les déductions suisses (AVS 5,3 %, AC 1,1 %, LPP selon l'âge), l'impôt à la source tessinois avec les barèmes 2026, puis l'IRPEF italienne avec la franchise de 10 000 € prévue par le nouvel accord. Le résultat montre une comparaison entre la résidence en Suisse (permis B) et le pendulaire depuis l'Italie (permis G)."
 }
 },
 "Cosa cambia con il nuovo accordo frontalieri 2026?": {
 en: {
 q: "What changes with the new cross-border workers agreement in 2026?",
 a: "For new fiscal cross-border workers, Switzerland applies 80% of its ordinary withholding rate; Italy taxes the income with a credit for Swiss tax. The 80% is not a revenue split between the two countries. Old cross-border workers who qualify under Article 9 retain exclusive Swiss taxation of the covered salary. Their regime does not automatically end in 2033 or 2034: 2033 is the final tax year of Swiss compensation payments to Italy. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Was ändert sich mit dem neuen Grenzgängerabkommen 2026?",
 a: "Für neue steuerliche Grenzgänger wendet die Schweiz 80% des ordentlichen Quellensteuertarifs an; Italien besteuert das Einkommen mit Anrechnung der Schweizer Steuer. Die 80% sind keine Aufteilung der Einnahmen zwischen den Staaten. Alte Grenzgänger, die Artikel 9 erfüllen, behalten die ausschliessliche Schweizer Besteuerung des erfassten Lohns. Das Regime endet nicht automatisch 2033 oder 2034; 2033 ist das letzte Steuerjahr der Ausgleichszahlungen an Italien. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Qu'est-ce qui change avec le nouvel accord frontaliers 2026 ?",
 a: "Pour les nouveaux frontaliers fiscaux, la Suisse applique 80% du taux ordinaire de retenue; l’Italie impose le revenu en accordant un crédit pour l’impôt suisse. Les 80% ne sont pas un partage des recettes entre les États. Les anciens frontaliers remplissant les conditions de l’article 9 conservent l’imposition exclusivement suisse du salaire concerné. Ce régime ne prend pas automatiquement fin en 2033 ou 2034; 2033 est la dernière année fiscale des compensations versées à l’Italie. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },
 "Come si calcolano le tasse dei frontalieri oltre 20 km dal confine?": {
 en: {
 q: "How are taxes calculated for cross-border workers living more than 20 km from the border?",
 a: "Cross-border workers residing more than 20 km from the Swiss border pay full withholding tax in Switzerland and full IRPEF in Italy (without the €10,000 exemption). The tax credit for Swiss taxes paid is deducted from IRPEF. The simulator automatically calculates the difference based on the municipality of residence."
 },
 de: {
 q: "Wie werden die Steuern für Grenzgänger berechnet, die mehr als 20 km von der Grenze entfernt wohnen?",
 a: "Grenzgänger mit Wohnsitz mehr als 20 km von der Schweizer Grenze zahlen die volle Quellensteuer in der Schweiz und die volle IRPEF in Italien (ohne den Freibetrag von 10.000 €). Die Steuergutschrift für die in der Schweiz gezahlten Steuern wird von der IRPEF abgezogen. Der Simulator berechnet den Unterschied automatisch anhand der Wohngemeinde."
 },
 fr: {
 q: "Comment sont calculés les impôts des frontaliers résidant à plus de 20 km de la frontière ?",
 a: "Les frontaliers résidant à plus de 20 km de la frontière suisse paient l'impôt à la source intégral en Suisse et l'IRPEF complète en Italie (sans franchise de 10 000 €). Le crédit d'impôt pour les impôts suisses payés est déduit de l'IRPEF. Le simulateur calcule automatiquement la différence en fonction de la commune de résidence."
 }
 },
 "Quanto costa la simulazione tasse frontalieri?": {
 en: {
 q: "How much does the cross-border worker tax simulation cost?",
 a: "The simulation is completely free. No registration required. Enter your gross salary, marital status, number of children, and municipality of residence to get a detailed net calculation in seconds."
 },
 de: {
 q: "Was kostet die Steuersimulation für Grenzgänger?",
 a: "Die Simulation ist völlig kostenlos. Keine Registrierung erforderlich. Geben Sie Bruttolohn, Familienstand, Kinderzahl und Wohngemeinde ein, um in wenigen Sekunden eine detaillierte Nettoberechnung zu erhalten."
 },
 fr: {
 q: "Combien coûte la simulation fiscale pour frontaliers ?",
 a: "La simulation est entièrement gratuite. Aucune inscription requise. Saisissez votre salaire brut, état civil, nombre d'enfants et commune de résidence pour obtenir un calcul détaillé du net en quelques secondes."
 }
 },

 // ── Comparatori FAQs ──
 "Quali servizi possono confrontare i frontalieri su questo sito?": {
 en: {
 q: "What services can cross-border workers compare on this site?",
 a: "You can compare: CHF/EUR exchange rates (6 providers), mobile operators with Italy roaming, LAMal health insurance (14 health funds), Swiss and Italian banks, cross-border grocery prices, cost of living CH vs IT, and job offers in Ticino."
 },
 de: {
 q: "Welche Dienste können Grenzgänger auf dieser Seite vergleichen?",
 a: "Sie können vergleichen: CHF/EUR-Wechselkurse (6 Anbieter), Mobilfunkanbieter mit Italien-Roaming, LAMal-Krankenversicherungen (14 Krankenkassen), Schweizer und italienische Banken, grenzüberschreitende Lebensmittelpreise, Lebenshaltungskosten CH vs. IT und Stellenangebote im Tessin."
 },
 fr: {
 q: "Quels services les frontaliers peuvent-ils comparer sur ce site ?",
 a: "Vous pouvez comparer : taux de change CHF/EUR (6 fournisseurs), opérateurs mobiles avec roaming en Italie, assurances maladie LAMal (14 caisses), banques suisses et italiennes, prix des courses transfrontalières, coût de la vie CH vs IT, et offres d'emploi au Tessin."
 }
 },
 "Quanto si risparmia confrontando i servizi per frontalieri?": {
 en: {
 q: "How much can you save by comparing services for cross-border workers?",
 a: "Savings vary: on currency exchange up to CHF 150/month with Wise/Revolut vs traditional banks, on mobile plans up to CHF 30/month with low-cost operators, on health insurance up to CHF 200/month by choosing the right health fund."
 },
 de: {
 q: "Wie viel spart man durch den Vergleich von Diensten für Grenzgänger?",
 a: "Die Ersparnis variiert: beim Geldwechsel bis CHF 150/Monat mit Wise/Revolut im Vergleich zu traditionellen Banken, bei Mobilfunktarifen bis CHF 30/Monat mit Billiganbietern, bei der Krankenversicherung bis CHF 200/Monat durch die Wahl der richtigen Krankenkasse."
 },
 fr: {
 q: "Combien économise-t-on en comparant les services pour frontaliers ?",
 a: "Les économies varient : sur le change jusqu'à CHF 150/mois avec Wise/Revolut par rapport aux banques traditionnelles, sur la téléphonie jusqu'à CHF 30/mois avec les opérateurs low-cost, sur l'assurance maladie jusqu'à CHF 200/mois en choisissant la bonne caisse."
 }
 },
 "I comparatori sono gratuiti?": {
 en: {
 q: "Are the comparison tools free?",
 a: "Yes, all comparison tools and calculators on Frontaliere Ticino are completely free, with no registration required. The site also works offline as a Progressive Web App."
 },
 de: {
 q: "Sind die Vergleichsrechner kostenlos?",
 a: "Ja, alle Vergleichsrechner und Tools auf Frontaliere Ticino sind völlig kostenlos und ohne Registrierung nutzbar. Die Seite funktioniert auch offline als Progressive Web App."
 },
 fr: {
 q: "Les comparateurs sont-ils gratuits ?",
 a: "Oui, tous les comparateurs et outils de Frontaliere Ticino sont entièrement gratuits, sans inscription requise. Le site fonctionne également hors ligne en tant que Progressive Web App."
 }
 },
 "Come vengono aggiornati i dati dei comparatori?": {
 en: {
 q: "How is the comparator data updated?",
 a: "Exchange rates are updated in real time via API. Insurance premiums and service costs are updated monthly or when rates change. Job offers are updated daily from company websites."
 },
 de: {
 q: "Wie werden die Vergleichsdaten aktualisiert?",
 a: "Wechselkurse werden in Echtzeit über APIs aktualisiert. Versicherungsprämien und Servicekosten werden monatlich oder bei Tarifänderungen aktualisiert. Stellenangebote werden täglich von den Unternehmenswebseiten aktualisiert."
 },
 fr: {
 q: "Comment les données des comparateurs sont-elles mises à jour ?",
 a: "Les taux de change sont mis à jour en temps réel via API. Les primes d'assurance et les coûts des services sont mis à jour mensuellement ou lors de changements tarifaires. Les offres d'emploi sont mises à jour quotidiennement depuis les sites des entreprises."
 }
 },

 // ── Exchange (Cambio Valuta) FAQs ──
 "Qual è il miglior servizio per cambiare franchi svizzeri in euro?": {
 en: {
 q: "What is the best service to exchange Swiss francs to euros?",
 a: "Wise and Revolut generally offer the most favourable rates with fees between 0.3% and 0.5%. Traditional banks (UBS, PostFinance) apply higher spreads, often 1–3%."
 },
 de: {
 q: "Welcher ist der beste Dienst, um Schweizer Franken in Euro zu wechseln?",
 a: "Wise und Revolut bieten in der Regel die günstigsten Kurse mit Gebühren zwischen 0,3 % und 0,5 %. Traditionelle Banken (UBS, PostFinance) wenden höhere Spreads an, oft 1–3 %."
 },
 fr: {
 q: "Quel est le meilleur service pour changer des francs suisses en euros ?",
 a: "Wise et Revolut offrent généralement les taux les plus avantageux avec des frais entre 0,3 % et 0,5 %. Les banques traditionnelles (UBS, PostFinance) appliquent des spreads plus élevés, souvent de 1 à 3 %."
 }
 },
 "Quanto costa trasferire CHF in EUR con Wise?": {
 en: {
 q: "How much does it cost to transfer CHF to EUR with Wise?",
 a: "Wise charges a transparent fee of 0.3–0.6% on the mid-market exchange rate. For a CHF 5,000 transfer, the typical cost is around CHF 15–30."
 },
 de: {
 q: "Was kostet eine Überweisung von CHF in EUR mit Wise?",
 a: "Wise berechnet eine transparente Gebühr von 0,3–0,6 % auf den Devisenmittelkurs. Bei einer Überweisung von CHF 5.000 betragen die typischen Kosten etwa CHF 15–30."
 },
 fr: {
 q: "Combien coûte un transfert de CHF en EUR avec Wise ?",
 a: "Wise applique des frais transparents de 0,3 à 0,6 % sur le taux moyen du marché. Pour un transfert de CHF 5 000, le coût typique est d'environ CHF 15 à 30."
 }
 },
 "Conviene cambiare lo stipendio frontaliere in banca o con servizi online?": {
 en: {
 q: "Is it better to exchange a cross-border worker's salary at a bank or with online services?",
 a: "Online services like Wise and Revolut are generally more cost-effective. On a monthly salary of CHF 5,000, the saving compared to a traditional bank can be CHF 50–150 per month."
 },
 de: {
 q: "Lohnt es sich, das Grenzgängergehalt bei der Bank oder mit Online-Diensten zu wechseln?",
 a: "Online-Dienste wie Wise und Revolut sind in der Regel günstiger. Bei einem Monatsgehalt von CHF 5.000 kann die Ersparnis gegenüber einer traditionellen Bank CHF 50–150 pro Monat betragen."
 },
 fr: {
 q: "Vaut-il mieux changer le salaire de frontalier en banque ou avec des services en ligne ?",
 a: "Les services en ligne comme Wise et Revolut sont généralement plus avantageux. Sur un salaire mensuel de CHF 5 000, l'économie par rapport à une banque traditionnelle peut atteindre CHF 50 à 150 par mois."
 }
 },
 "Quando è il momento migliore per cambiare CHF in EUR?": {
 en: {
 q: "When is the best time to exchange CHF to EUR?",
 a: "The CHF/EUR rate fluctuates daily. It is best to monitor the rate and exchange when the franc is strong (below 0.93 EUR). Avoid exchanging on weekends when spreads are wider."
 },
 de: {
 q: "Wann ist der beste Zeitpunkt, um CHF in EUR zu wechseln?",
 a: "Der CHF/EUR-Kurs schwankt täglich. Am besten den Kurs beobachten und wechseln, wenn der Franken stark ist (unter 0,93 EUR). Wechsel am Wochenende vermeiden, da die Spreads dann grösser sind."
 },
 fr: {
 q: "Quel est le meilleur moment pour changer des CHF en EUR ?",
 a: "Le taux CHF/EUR fluctue quotidiennement. Il est préférable de surveiller le taux et de changer lorsque le franc est fort (en dessous de 0,93 EUR). Évitez les changes le week-end lorsque les spreads sont plus larges."
 }
 },

 // ── Mobile operators FAQs ──
 "Quale operatore mobile svizzero ha il roaming illimitato in Italia?": {
 en: {
 q: "Which Swiss mobile operator offers unlimited roaming in Italy?",
 a: "Swisscom, Salt, and Sunrise include European roaming (Italy included) in their premium plans. Yallo and Wingo offer plans with EU roaming from CHF 19.95/month. Always check the specific conditions."
 },
 de: {
 q: "Welcher Schweizer Mobilfunkanbieter bietet unbegrenztes Roaming in Italien?",
 a: "Swisscom, Salt und Sunrise bieten in ihren Premium-Tarifen europäisches Roaming (inkl. Italien) an. Yallo und Wingo bieten Tarife mit EU-Roaming ab CHF 19.95/Monat. Prüfen Sie stets die genauen Bedingungen."
 },
 fr: {
 q: "Quel opérateur mobile suisse offre le roaming illimité en Italie ?",
 a: "Swisscom, Salt et Sunrise incluent le roaming européen (Italie comprise) dans leurs forfaits premium. Yallo et Wingo proposent des forfaits avec roaming UE dès CHF 19.95/mois. Vérifiez toujours les conditions spécifiques."
 }
 },
 "Quale operatore italiano include il roaming in Svizzera per frontalieri?": {
 en: {
 q: "Which Italian operator includes Switzerland roaming for cross-border workers?",
 a: "Since September 2025, Vodafone Italy (32 GB CH included in the Start plan at €9.95), Fastweb Mobile (32 GB CH at €9.95) and ho. Mobile (Roam-Like-Home CH from 8 September 2025) apply national conditions in Switzerland too. Spusu Oltreconfine includes 10 GB dedicated CH data plus 2000 minutes to CH numbers at €9.98/month."
 },
 de: {
 q: "Welcher italienische Mobilfunkanbieter beinhaltet das Schweiz-Roaming für Grenzgänger?",
 a: "Seit September 2025 wenden Vodafone Italien (32 GB CH im Start-Tarif für 9,95 €), Fastweb Mobile (32 GB CH für 9,95 €) und ho. Mobile (Roam-Like-Home CH ab 8. September 2025) auch in der Schweiz die nationalen Bedingungen an. Spusu Oltreconfine bietet 10 GB dedizierte CH-Daten plus 2000 Minuten zu CH-Nummern für 9,98 €/Monat."
 },
 fr: {
 q: "Quel opérateur italien inclut le roaming en Suisse pour les frontaliers ?",
 a: "Depuis septembre 2025, Vodafone Italie (32 Go CH inclus dans le forfait Start à 9,95 €), Fastweb Mobile (32 Go CH à 9,95 €) et ho. Mobile (Roam-Like-Home CH dès le 8 septembre 2025) appliquent aussi les conditions nationales en Suisse. Spusu Oltreconfine inclut 10 Go dédiés CH et 2000 minutes vers les numéros CH à 9,98 €/mois."
 }
 },
 "Quanto costa un abbonamento mobile in Svizzera per frontalieri?": {
 en: {
 q: "How much does a mobile plan cost in Switzerland for cross-border workers?",
 a: "Plans start from CHF 9.95/month (Aldi Mobile) up to CHF 65/month (Swisscom premium). For cross-border workers, a good plan with Italy roaming costs around CHF 25–40/month."
 },
 de: {
 q: "Was kostet ein Mobilfunkabo in der Schweiz für Grenzgänger?",
 a: "Die Tarife beginnen bei CHF 9.95/Monat (Aldi Mobile) und reichen bis CHF 65/Monat (Swisscom Premium). Für Grenzgänger kostet ein guter Tarif mit Italien-Roaming etwa CHF 25–40/Monat."
 },
 fr: {
 q: "Combien coûte un abonnement mobile en Suisse pour les frontaliers ?",
 a: "Les forfaits vont de CHF 9.95/mois (Aldi Mobile) à CHF 65/mois (Swisscom premium). Pour les frontaliers, un bon forfait avec roaming Italie coûte environ CHF 25 à 40/mois."
 }
 },
 "Posso usare una SIM italiana in Svizzera come frontaliere?": {
 en: {
 q: "Can I use an Italian SIM card in Switzerland as a cross-border worker?",
 a: "Yes, but EU roaming has usage limits. After 4 months of predominantly using it abroad, the operator may apply surcharges. For daily use in Switzerland, a Swiss operator is more convenient."
 },
 de: {
 q: "Kann ich als Grenzgänger eine italienische SIM-Karte in der Schweiz nutzen?",
 a: "Ja, aber EU-Roaming hat Nutzungslimits. Nach 4 Monaten überwiegender Nutzung im Ausland kann der Anbieter Zuschläge berechnen. Für den täglichen Gebrauch in der Schweiz ist ein Schweizer Anbieter empfehlenswerter."
 },
 fr: {
 q: "Puis-je utiliser une SIM italienne en Suisse en tant que frontalier ?",
 a: "Oui, mais le roaming UE a des limites d'utilisation. Après 4 mois d'utilisation principalement à l'étranger, l'opérateur peut appliquer des surcharges. Pour un usage quotidien en Suisse, un opérateur suisse est plus avantageux."
 }
 },
 "Qual è il piano mobile più economico con roaming per frontalieri?": {
 en: {
 q: "What is the cheapest mobile plan with roaming for cross-border workers?",
 a: "Yallo and Wingo offer the cheapest plans with Italy roaming included, starting from CHF 19.95/month with unlimited calls in Switzerland and roaming data."
 },
 de: {
 q: "Welcher Mobilfunktarif mit Roaming ist für Grenzgänger am günstigsten?",
 a: "Yallo und Wingo bieten die günstigsten Tarife mit Italien-Roaming ab CHF 19.95/Monat, inklusive unbegrenzter Anrufe in der Schweiz und Roaming-Daten."
 },
 fr: {
 q: "Quel est le forfait mobile le moins cher avec roaming pour les frontaliers ?",
 a: "Yallo et Wingo proposent les forfaits les moins chers avec roaming Italie inclus, à partir de CHF 19.95/mois avec appels illimités en Suisse et données en roaming."
 }
 },

 // ── Health insurance (LAMal) FAQs ──
 "I frontalieri devono avere l'assicurazione sanitaria svizzera?": {
 en: {
 q: "Do cross-border workers need Swiss health insurance?",
 a: "Yes, cross-border workers are required to take out LAMal health insurance in Switzerland within 3 months of starting work. Alternatively, they may exercise the right of option to remain covered by the Italian national health service (SSN)."
 },
 de: {
 q: "Müssen Grenzgänger eine Schweizer Krankenversicherung haben?",
 a: "Ja, Grenzgänger sind verpflichtet, innerhalb von 3 Monaten nach Arbeitsbeginn eine KVG-Krankenversicherung in der Schweiz abzuschliessen. Alternativ können sie das Optionsrecht ausüben und beim italienischen Gesundheitsdienst (SSN) versichert bleiben."
 },
 fr: {
 q: "Les frontaliers doivent-ils avoir une assurance maladie suisse ?",
 a: "Oui, les frontaliers sont tenus de souscrire une assurance maladie LAMal en Suisse dans les 3 mois suivant le début du travail. Ils peuvent sinon exercer le droit d'option pour rester couverts par le service national de santé italien (SSN)."
 }
 },
 "Quanto costa l'assicurazione LAMal per un frontaliere in Ticino?": {
 en: {
 q: "How much does LAMal health insurance cost for a cross-border worker in Ticino?",
 a: "Cross-border workers resident in Italy pay country-of-residence LAMal premiums, not premiums for their Swiss canton of employment. The official FOPH 2026 Italy table lists 14 insurers with separate age and accident-cover rates. For adults aged 26+ without accident cover, monthly premiums range from CHF 279 to CHF 487.20; the ordinary deductible is CHF 300 (CHF 0 for children). Optional deductibles and HMO/Telmed models are unavailable. Source: https://www.priminfo.admin.ch/downloads/praemien_eu_2026.pdf"
 },
 de: {
 q: "Was kostet die KVG-Krankenversicherung für einen Grenzgänger im Tessin?",
 a: "Für Grenzgänger mit Wohnsitz in Italien gelten die KVG-Prämien des Wohnsitzlands, nicht des Schweizer Arbeitskantons. Die offizielle BAG-Tabelle 2026 für Italien nennt 14 Versicherer mit getrennten Prämien nach Alter und Unfalldeckung. Für Erwachsene ab 26 ohne Unfalldeckung liegen die Monatsprämien zwischen CHF 279 und CHF 487.20; die ordentliche Franchise beträgt CHF 300 (CHF 0 für Kinder). Wahlfranchisen und HMO/Telmed-Modelle sind nicht verfügbar. Quelle: https://www.priminfo.admin.ch/downloads/praemien_eu_2026.pdf"
 },
 fr: {
 q: "Combien coûte l'assurance maladie LAMal pour un frontalier au Tessin ?",
 a: "Les frontaliers résidant en Italie paient les primes LAMal du pays de domicile, et non celles du canton de travail suisse. Le tableau officiel OFSP 2026 pour l’Italie comprend 14 assureurs et distingue âge et couverture accidents. Pour les adultes dès 26 ans sans couverture accidents, les primes mensuelles vont de CHF 279 à CHF 487.20 ; la franchise ordinaire est CHF 300 (CHF 0 pour enfants). Les franchises à option et modèles HMO/Telmed ne sont pas disponibles. Source : https://www.priminfo.admin.ch/downloads/praemien_eu_2026.pdf"
 }
 },
 "Qual è la cassa malati più economica per frontalieri?": {
 en: {
 q: "Which health fund is the cheapest for cross-border workers?",
 a: "Cross-border workers resident in Italy pay country-of-residence LAMal premiums, not premiums for their Swiss canton of employment. The official FOPH 2026 Italy table lists 14 insurers with separate age and accident-cover rates. For adults aged 26+ without accident cover, monthly premiums range from CHF 279 to CHF 487.20; the ordinary deductible is CHF 300 (CHF 0 for children). Optional deductibles and HMO/Telmed models are unavailable. Source: https://www.priminfo.admin.ch/downloads/praemien_eu_2026.pdf"
 },
 de: {
 q: "Welche Krankenkasse ist für Grenzgänger am günstigsten?",
 a: "Für Grenzgänger mit Wohnsitz in Italien gelten die KVG-Prämien des Wohnsitzlands, nicht des Schweizer Arbeitskantons. Die offizielle BAG-Tabelle 2026 für Italien nennt 14 Versicherer mit getrennten Prämien nach Alter und Unfalldeckung. Für Erwachsene ab 26 ohne Unfalldeckung liegen die Monatsprämien zwischen CHF 279 und CHF 487.20; die ordentliche Franchise beträgt CHF 300 (CHF 0 für Kinder). Wahlfranchisen und HMO/Telmed-Modelle sind nicht verfügbar. Quelle: https://www.priminfo.admin.ch/downloads/praemien_eu_2026.pdf"
 },
 fr: {
 q: "Quelle caisse maladie est la moins chère pour les frontaliers ?",
 a: "Les frontaliers résidant en Italie paient les primes LAMal du pays de domicile, et non celles du canton de travail suisse. Le tableau officiel OFSP 2026 pour l’Italie comprend 14 assureurs et distingue âge et couverture accidents. Pour les adultes dès 26 ans sans couverture accidents, les primes mensuelles vont de CHF 279 à CHF 487.20 ; la franchise ordinaire est CHF 300 (CHF 0 pour enfants). Les franchises à option et modèles HMO/Telmed ne sont pas disponibles. Source : https://www.priminfo.admin.ch/downloads/praemien_eu_2026.pdf"
 }
 },
 "Cos'è il diritto di opzione per l'assicurazione sanitaria dei frontalieri?": {
 en: {
 q: "What is the right of option for cross-border workers' health insurance?",
 a: "Eligible EU citizens resident in Italy may formally request exemption from LAMal from the competent authority in their canton of employment within three months of starting work. Italian SSN enrolment alone does not exercise this right. The choice cannot be changed freely. For someone previously insured under LAMal, the birth of a child may allow a new option within three months, depending on the family situation: check with the canton and Italian ASL first. Source: FOPH, https://www.bag.admin.ch/it/assicurazione-malattie-lavoratori-frontalieri-in-svizzera"
 },
 de: {
 q: "Was ist das Optionsrecht bei der Krankenversicherung für Grenzgänger?",
 a: "Berechtigte EU-Staatsangehörige mit Wohnsitz in Italien können beim zuständigen Arbeitskanton innerhalb von drei Monaten nach Arbeitsbeginn die Befreiung von der KVG beantragen. Eine SSN-Anmeldung allein genügt nicht. Die Wahl kann nicht frei geändert werden. Bei bisheriger KVG-Versicherung kann die Geburt eines Kindes je nach Familiensituation eine erneute Ausübung innerhalb von drei Monaten ermöglichen: vorher mit dem Kanton und der italienischen ASL klären. Quelle: BAG, https://www.bag.admin.ch/it/assicurazione-malattie-lavoratori-frontalieri-in-svizzera"
 },
 fr: {
 q: "Qu'est-ce que le droit d'option pour l'assurance maladie des frontaliers ?",
 a: "Les citoyens UE résidant en Italie qui disposent du droit d’option peuvent demander formellement une exemption de la LAMal à l’autorité du canton de travail dans les trois mois suivant le début de l’activité. L’inscription au SSN seule ne suffit pas. Le choix ne peut pas être modifié librement. Pour une personne précédemment assurée LAMal, la naissance d’un enfant peut permettre un nouvel exercice dans les trois mois, selon la situation familiale : vérifier auparavant avec le canton et l’ASL italienne. Source : OFSP, https://www.bag.admin.ch/it/assicurazione-malattie-lavoratori-frontalieri-in-svizzera"
 }
 },
 "Cosa copre l'assicurazione LAMal per frontalieri?": {
 en: {
 q: "What does LAMal health insurance cover for cross-border workers?",
 a: "LAMal covers medical, hospital, and pharmaceutical care in Switzerland. For treatment in Italy, the European Health Insurance Card (EHIC) is required. For residents of Italy, the ordinary deductible is CHF300 for adults/young adults and CHF0 for children; optional deductibles are unavailable."
 },
 de: {
 q: "Was deckt die KVG-Krankenversicherung für Grenzgänger ab?",
 a: "Die KVG deckt ärztliche, stationäre und pharmazeutische Leistungen in der Schweiz ab. Für Behandlungen in Italien wird die Europäische Krankenversicherungskarte (EKVK) benötigt. Bei Wohnsitz in Italien beträgt die ordentliche Franchise CHF300 für Erwachsene/junge Erwachsene und CHF0 für Kinder; Wahlfranchisen sind nicht verfügbar."
 },
 fr: {
 q: "Que couvre l'assurance maladie LAMal pour les frontaliers ?",
 a: "La LAMal couvre les soins médicaux, hospitaliers et pharmaceutiques en Suisse. Pour les soins en Italie, la carte européenne d'assurance maladie (CEAM) est nécessaire. Pour les résidents en Italie, la franchise ordinaire est CHF300 pour adultes/jeunes adultes et CHF0 pour enfants ; les franchises à option ne sont pas disponibles."
 }
 },

 // ── Border crossings FAQs ──
 "Quali sono gli orari di apertura dei valichi di frontiera Svizzera-Italia?": {
 en: {
 q: "What are the opening hours of the Switzerland-Italy border crossings?",
 a: "Brogeda Autostrada (Chiasso) is staffed Monday to Sunday, 24 hours a day, for tourist traffic. Commercial clearance and other offices have separate schedules in the FOCBS directory; a general 06:00–22:00 timetable cannot be applied to all smaller crossings. https://dst.bazg.admin.ch/dst/print?id=386&lang=4"
 },
 de: {
 q: "Wie sind die Öffnungszeiten der Grenzübergänge Schweiz-Italien?",
 a: "Brogeda Autostrada (Chiasso) ist für den Reiseverkehr von Montag bis Sonntag rund um die Uhr besetzt. Für die Warenabfertigung und andere Dienststellen gelten separate Zeiten im BAZG-Verzeichnis; 06–22 Uhr ist keine allgemeine Öffnungszeit kleinerer Übergänge. https://dst.bazg.admin.ch/dst/print?id=386&lang=4"
 },
 fr: {
 q: "Quels sont les horaires d'ouverture des postes frontière Suisse-Italie ?",
 a: "Brogeda Autostrada (Chiasso) est occupé du lundi au dimanche, 24 heures sur 24, pour le trafic touristique. Le dédouanement commercial et les autres offices ont des horaires distincts dans le répertoire OFDF; 6–22 heures ne constitue pas un horaire général pour les petits passages. https://dst.bazg.admin.ch/dst/print?id=386&lang=4"
 }
 },
 "Qual è il valico meno trafficato tra Svizzera e Italia?": {
 en: {
 q: "Which is the least congested border crossing between Switzerland and Italy?",
 a: "No crossing is always the least busy. Compare current observations in your direction with the extra travel time needed to reach an alternative and check customs-service hours."
 },
 de: {
 q: "Welcher Grenzübergang zwischen der Schweiz und Italien ist am wenigsten befahren?",
 a: "Kein Übergang hat immer am wenigsten Verkehr. Vergleichen Sie aktuelle Werte in Ihrer Richtung mit der zusätzlichen Anfahrt zur Alternative und prüfen Sie die Dienstzeiten."
 },
 fr: {
 q: "Quel est le poste frontière le moins fréquenté entre la Suisse et l'Italie ?",
 a: "Aucun passage n’est toujours le moins fréquenté. Comparez les observations récentes dans votre sens avec le détour nécessaire et vérifiez les horaires du service douanier."
 }
 },
 "A che ora c'è più traffico alla dogana di Chiasso?": {
 en: {
 q: "What time is there the most traffic at the Chiasso customs?",
 a: "Rush hours are 7:00–8:30 (entering Switzerland) and 17:00–18:30 (returning to Italy). Monday and Friday are the busiest days."
 },
 de: {
 q: "Wann ist der Verkehr am Zoll von Chiasso am stärksten?",
 a: "Die Stosszeiten sind 7:00–8:30 Uhr (Einreise in die Schweiz) und 17:00–18:30 Uhr (Rückkehr nach Italien). Montag und Freitag sind die verkehrsreichsten Tage."
 },
 fr: {
 q: "À quelle heure y a-t-il le plus de trafic à la douane de Chiasso ?",
 a: "Les heures de pointe sont 7h00–8h30 (entrée en Suisse) et 17h00–18h30 (retour en Italie). Le lundi et le vendredi sont les jours les plus chargés."
 }
 },
 "Come evitare le code alla frontiera Svizzera-Italia?": {
 en: {
 q: "How can you avoid queues at the Switzerland-Italy border?",
 a: "Check traffic and hours before leaving, compare alternatives and consider rail where suitable. Travelling by train does not exclude possible customs checks and is not a guarantee of no inspections."
 },
 de: {
 q: "Wie kann man Warteschlangen an der Grenze Schweiz-Italien vermeiden?",
 a: "Prüfen Sie vor der Abfahrt Verkehr und Öffnungszeiten, vergleichen Sie Alternativen und ziehen Sie die Bahn in Betracht. Eine Zugfahrt schliesst mögliche Zollkontrollen nicht aus."
 },
 fr: {
 q: "Comment éviter les files d'attente à la frontière Suisse-Italie ?",
 a: "Vérifiez le trafic et les horaires avant le départ, comparez les itinéraires et envisagez le train. Le voyage ferroviaire n’exclut pas d’éventuels contrôles douaniers."
 }
 },

 // ── Holidays FAQs ──
 "Quanti giorni festivi ci sono in Canton Ticino nel 2026?": {
 en: {
 q: "How many public holidays are there in Canton Ticino in 2026?",
 a: "Canton Ticino has 15 official public holidays in 2026, including federal holidays (New Year, 1st August) and cantonal ones (St Joseph, Corpus Christi, Saints Peter and Paul, Assumption, All Saints, Immaculate Conception)."
 },
 de: {
 q: "Wie viele Feiertage gibt es im Kanton Tessin im Jahr 2026?",
 a: "Der Kanton Tessin hat 2026 15 offizielle Feiertage, darunter Bundesfeiertage (Neujahr, 1. August) und kantonale Feiertage (Josefstag, Fronleichnam, Peter und Paul, Mariä Himmelfahrt, Allerheiligen, Mariä Empfängnis)."
 },
 fr: {
 q: "Combien de jours fériés y a-t-il au Tessin en 2026 ?",
 a: "Le Tessin compte 15 jours fériés officiels en 2026, incluant les fêtes fédérales (Nouvel An, 1er août) et cantonales (Saint-Joseph, Fête-Dieu, Saints Pierre et Paul, Assomption, Toussaint, Immaculée Conception)."
 }
 },
 "Le festività italiane valgono anche per chi lavora in Svizzera?": {
 en: {
 q: "Do Italian public holidays also apply to those working in Switzerland?",
 a: "No, cross-border workers follow the Swiss/Ticino holiday calendar. Italian holidays (April 25th, June 2nd, patron saint's day) are not recognised in Switzerland. Cross-border workers must take annual leave for those days."
 },
 de: {
 q: "Gelten italienische Feiertage auch für Personen, die in der Schweiz arbeiten?",
 a: "Nein, Grenzgänger folgen dem Schweizer bzw. Tessiner Feiertagskalender. Italienische Feiertage (25. April, 2. Juni, Patronatsfest) werden in der Schweiz nicht anerkannt. Grenzgänger müssen für diese Tage Ferien beziehen."
 },
 fr: {
 q: "Les jours fériés italiens s'appliquent-ils aussi à ceux qui travaillent en Suisse ?",
 a: "Non, les frontaliers suivent le calendrier des jours fériés suisse/tessinois. Les jours fériés italiens (25 avril, 2 juin, saint patron) ne sont pas reconnus en Suisse. Les frontaliers doivent prendre des congés pour ces jours."
 }
 },
 // ── B.1 Festività Ticino 2026 expanded FAQ ──
 "Il 1° agosto 2026 è festivo in Ticino?": {
 en: {
 q: "Is August 1st 2026 a public holiday in Ticino?",
 a: "Yes, August 1st 2026 is the Swiss National Day, a federal public holiday nationwide including Ticino. In 2026 it falls on a Saturday, so workers who do not work on Saturdays do not receive a compensatory day off under the Swiss Code of Obligations: most Ticino collective labour agreements (CCL) do not provide compensation."
 },
 de: {
 q: "Ist der 1. August 2026 ein Feiertag im Tessin?",
 a: "Ja, der 1. August 2026 ist der Schweizer Nationalfeiertag und ein nationaler Bundesfeiertag, auch im Tessin. 2026 fällt er auf einen Samstag: Wer nicht samstags arbeitet, erhält laut Schweizer Obligationenrecht keinen Ausgleichstag — die meisten Tessiner GAV sehen keine Kompensation vor."
 },
 fr: {
 q: "Le 1er août 2026 est-il férié au Tessin ?",
 a: "Oui, le 1er août 2026 est la Fête nationale suisse, un jour férié fédéral dans tout le pays, Tessin inclus. En 2026 il tombe un samedi : les travailleurs qui ne travaillent pas le samedi ne bénéficient pas d'un jour de récupération selon le Code des obligations suisse ; la plupart des CCT tessinoises ne prévoient pas de compensation."
 }
 },
 "Cosa succede se un festivo cade di sabato o domenica in Svizzera?": {
 en: {
 q: "What happens if a public holiday falls on a Saturday or Sunday in Switzerland?",
 a: "In Switzerland, unlike Italy, if a public holiday falls on a Saturday or Sunday it is NOT recovered: the worker simply loses the benefit of the free day. In 2026 this applies to two important Ticino holidays: August 1st (Saturday) and August 15th — Assumption (Saturday). Only some sector CCLs provide a recovery day."
 },
 de: {
 q: "Was passiert, wenn ein Feiertag in der Schweiz auf einen Samstag oder Sonntag fällt?",
 a: "Anders als in Italien werden Feiertage in der Schweiz NICHT nachgeholt, wenn sie auf einen Samstag oder Sonntag fallen: Der freie Tag geht schlicht verloren. 2026 betrifft das zwei wichtige Tessiner Feiertage: den 1. August (Samstag) und den 15. August — Mariä Himmelfahrt (Samstag). Nur einige Branchen-GAV sehen einen Nachholtag vor."
 },
 fr: {
 q: "Que se passe-t-il si un jour férié tombe un samedi ou un dimanche en Suisse ?",
 a: "Contrairement à l'Italie, en Suisse un jour férié qui tombe un samedi ou un dimanche n'est PAS récupéré : le travailleur perd simplement le bénéfice du jour de congé. En 2026 cela concerne deux jours fériés tessinois importants : le 1er août (samedi) et le 15 août — Assomption (samedi). Seules certaines CCT sectorielles prévoient un jour de récupération."
 }
 },
 "Quali festività sono riconosciute in Ticino ma NON nel resto della Svizzera?": {
 en: {
 q: "Which public holidays are recognised in Ticino but NOT in the rest of Switzerland?",
 a: "Ticino, being a historically Catholic canton, recognises 7 additional cantonal holidays compared to Protestant cantons: Epiphany (Jan 6), St Joseph (Mar 19), Corpus Christi, Saints Peter and Paul (Jun 29), Assumption (Aug 15), All Saints (Nov 1), and Immaculate Conception (Dec 8). This means a cross-border worker in Ticino has on average 3 to 5 more paid holidays than someone working in Zurich or Basel."
 },
 de: {
 q: "Welche Feiertage sind im Tessin anerkannt, im Rest der Schweiz jedoch NICHT?",
 a: "Das Tessin — als historisch katholischer Kanton — anerkennt 7 zusätzliche kantonale Feiertage gegenüber den protestantischen Kantonen: Dreikönigstag (6.1.), Josefstag (19.3.), Fronleichnam, Peter und Paul (29.6.), Mariä Himmelfahrt (15.8.), Allerheiligen (1.11.) und Mariä Empfängnis (8.12.). Ein Grenzgänger im Tessin hat im Durchschnitt 3 bis 5 bezahlte Feiertage mehr als jemand in Zürich oder Basel."
 },
 fr: {
 q: "Quels jours fériés sont reconnus au Tessin mais PAS dans le reste de la Suisse ?",
 a: "Le Tessin, canton historiquement catholique, reconnaît 7 jours fériés cantonaux supplémentaires par rapport aux cantons protestants : Épiphanie (6/1), Saint-Joseph (19/3), Fête-Dieu, Saints Pierre et Paul (29/6), Assomption (15/8), Toussaint (1/11) et Immaculée Conception (8/12). Un frontalier au Tessin bénéficie en moyenne de 3 à 5 jours fériés payés de plus qu'à Zurich ou Bâle."
 }
 },
 "Le festività italiane (25 aprile, 2 giugno) valgono per il frontaliere?": {
 en: {
 q: "Do Italian public holidays (April 25th, June 2nd) apply to cross-border workers?",
 a: "No. Cross-border workers follow the Swiss/Ticino holiday calendar because the employment relationship is governed by Swiss labour law (lex loci laboris). Italian holidays (April 25th Liberation, June 2nd Republic Day, local patron saint, December 8th, etc.) are not recognised as non-working days by the Swiss employer: to stay home, the cross-border worker must use ordinary annual leave."
 },
 de: {
 q: "Gelten italienische Feiertage (25. April, 2. Juni) für Grenzgänger?",
 a: "Nein. Grenzgänger richten sich nach dem Schweizer bzw. Tessiner Feiertagskalender, weil das Arbeitsverhältnis dem Schweizer Arbeitsrecht unterliegt (lex loci laboris). Italienische Feiertage (25. April Befreiungstag, 2. Juni Tag der Republik, Patronatsfest, 8. Dezember etc.) gelten beim Schweizer Arbeitgeber nicht als arbeitsfreie Tage: Wer zu Hause bleiben möchte, muss reguläre Ferien nehmen."
 },
 fr: {
 q: "Les jours fériés italiens (25 avril, 2 juin) s'appliquent-ils au frontalier ?",
 a: "Non. Le frontalier suit le calendrier des jours fériés suisse/tessinois car la relation de travail est régie par le droit suisse (lex loci laboris). Les jours fériés italiens (25 avril Libération, 2 juin Fête de la République, saint patron, 8 décembre, etc.) ne sont pas reconnus comme jours non ouvrés par l'employeur suisse : pour rester à la maison, le frontalier doit prendre un jour de congé ordinaire."
 }
 },
 "Come viene pagato il frontaliere nei giorni festivi in Ticino?": {
 en: {
 q: "How is a cross-border worker paid on public holidays in Ticino?",
 a: "The Swiss Code of Obligations and the Labour Act require the Swiss employer to pay for public holidays falling on a working day even if the employee is absent. Hourly-paid workers (Stundenlohn) receive their regular pay and monthly-paid workers receive their full salary. If the cross-border worker works on a public holiday, most Ticino CCLs provide a 50% surcharge or a compensatory day off; some sectors (healthcare, hospitality, transport) go up to 100%."
 },
 de: {
 q: "Wie wird ein Grenzgänger im Tessin an Feiertagen bezahlt?",
 a: "Obligationenrecht und Arbeitsgesetz verpflichten den Schweizer Arbeitgeber, Feiertage, die auf einen Arbeitstag fallen, auch bei Abwesenheit des Arbeitnehmers zu bezahlen. Im Stundenlohn Beschäftigte erhalten den üblichen Lohn, Monatslohnempfänger den vollen Lohn. Wer an einem Feiertag arbeitet, erhält in den meisten Tessiner GAV einen Zuschlag von 50 % oder einen Kompensationstag; manche Branchen (Gesundheit, Gastgewerbe, Transport) zahlen bis zu 100 %."
 },
 fr: {
 q: "Comment le frontalier est-il payé les jours fériés au Tessin ?",
 a: "Le Code des obligations et la Loi sur le travail imposent à l'employeur suisse de payer les jours fériés tombant sur un jour ouvrable même en cas d'absence du salarié. Les salariés payés à l'heure (Stundenlohn) reçoivent leur paie habituelle, ceux au mois leur salaire complet. Si le frontalier travaille un jour férié, la plupart des CCT tessinoises prévoient une majoration de 50 % ou un jour de récupération ; certains secteurs (santé, hôtellerie, transports) vont jusqu'à 100 %."
 }
 },
 "Quanti giorni di ferie ha un frontaliere in Svizzera?": {
 en: {
 q: "How many vacation days does a cross-border worker have in Switzerland?",
 a: "By Swiss law, the minimum is 4 weeks (20 working days) per year for adults and 5 weeks for workers under 20. Many collective labour agreements (CCL) provide 5 weeks after a certain seniority."
 },
 de: {
 q: "Wie viele Ferientage hat ein Grenzgänger in der Schweiz?",
 a: "Das Schweizer Gesetz sieht mindestens 4 Wochen (20 Arbeitstage) pro Jahr für Erwachsene und 5 Wochen für Arbeitnehmer unter 20 Jahren vor. Viele Gesamtarbeitsverträge (GAV) sehen nach einer gewissen Betriebszugehörigkeit 5 Wochen vor."
 },
 fr: {
 q: "Combien de jours de vacances a un frontalier en Suisse ?",
 a: "Selon la loi suisse, le minimum est de 4 semaines (20 jours ouvrables) par an pour les adultes et 5 semaines pour les travailleurs de moins de 20 ans. De nombreuses conventions collectives (CCT) prévoient 5 semaines après une certaine ancienneté."
 }
 },
 "Quali sono i ponti migliori per frontalieri nel 2026?": {
 en: {
 q: "What are the best long weekends for cross-border workers in 2026?",
 a: "The most convenient long weekends in 2026 are Easter (Good Friday + Easter Monday), Ascension (Thursday, one bridge day needed), and Corpus Christi (Thursday, one bridge day needed). Check our interactive calendar."
 },
 de: {
 q: "Welche Brückentage sind 2026 für Grenzgänger am günstigsten?",
 a: "Die günstigsten Brückentage 2026 sind Ostern (Karfreitag + Ostermontag), Auffahrt (Donnerstag, ein Brückentag nötig) und Fronleichnam (Donnerstag, ein Brückentag nötig). Schauen Sie in unseren interaktiven Kalender."
 },
 fr: {
 q: "Quels sont les meilleurs ponts pour les frontaliers en 2026 ?",
 a: "Les ponts les plus avantageux en 2026 sont Pâques (Vendredi saint + lundi de Pâques), l'Ascension (jeudi, un jour de pont nécessaire) et la Fête-Dieu (jeudi, un jour de pont nécessaire). Consultez notre calendrier interactif."
 }
 },

 // ── Job board FAQs ──
 "Come trovare offerte di lavoro in Ticino per frontalieri?": {
 en: {
 q: "How can I find job offers in Ticino for cross-border workers?",
 a: "On Frontaliere Ticino you can browse offers updated daily from over 100 Ticino-based companies. Filter by sector (banking, tech, pharma, healthcare), location (Lugano, Mendrisio, Bellinzona), and contract type. Each offer includes a salary estimate and a direct link to apply."
 },
 de: {
 q: "Wie finde ich Stellenangebote im Tessin für Grenzgänger?",
 a: "Auf Frontaliere Ticino finden Sie täglich aktualisierte Angebote von über 100 Tessiner Unternehmen. Filtern Sie nach Branche (Banken, Tech, Pharma, Gesundheit), Standort (Lugano, Mendrisio, Bellinzona) und Vertragsart. Jedes Angebot enthält eine Gehaltsschätzung und einen direkten Link zur Bewerbung."
 },
 fr: {
 q: "Comment trouver des offres d'emploi au Tessin pour les frontaliers ?",
 a: "Sur Frontaliere Ticino, vous pouvez consulter des offres mises à jour quotidiennement provenant de plus de 100 entreprises tessinoises. Filtrez par secteur (banque, tech, pharma, santé), lieu (Lugano, Mendrisio, Bellinzona) et type de contrat. Chaque offre inclut une estimation salariale et un lien direct pour postuler."
 }
 },
 "Quali sono i settori con più offerte di lavoro in Ticino?": {
 en: {
 q: "Which sectors have the most job offers in Ticino?",
 a: "The sectors with the most offers for cross-border workers in Ticino are: pharma and life sciences, financial and banking services, technology and IT, healthcare and hospitals, logistics and transport, industry and manufacturing. Pharmaceutical companies in the Mendrisiotto area offer the best-paid positions."
 },
 de: {
 q: "In welchen Branchen gibt es im Tessin die meisten Stellenangebote?",
 a: "Die Branchen mit den meisten Angeboten für Grenzgänger im Tessin sind: Pharma und Life Sciences, Finanz- und Bankdienstleistungen, Technologie und IT, Gesundheitswesen und Spitäler, Logistik und Transport, Industrie und Fertigung. Pharmaunternehmen im Mendrisiotto bieten die bestbezahlten Stellen."
 },
 fr: {
 q: "Quels secteurs ont le plus d'offres d'emploi au Tessin ?",
 a: "Les secteurs avec le plus d'offres pour les frontaliers au Tessin sont : pharma et sciences de la vie, services financiers et bancaires, technologie et IT, santé et hôpitaux, logistique et transport, industrie et manufacture. Les entreprises pharmaceutiques du Mendrisiotto offrent les postes les mieux rémunérés."
 }
 },
 "Serve il permesso G per lavorare in Ticino come frontaliere?": {
 en: {
 q: "Do you need a G permit to work in Ticino as a cross-border worker?",
 a: "The G permit concerns working in Switzerland with a main residence abroad and return at least weekly. The treaty tax definition is separate: it requires a border-zone municipality, work in the specified region and return home in principle daily. Holding the permit alone does not determine tax status. https://www4.ti.ch/di/spop/stranieri/richiesta-nuovo-g/"
 },
 de: {
 q: "Braucht man eine G-Bewilligung, um als Grenzgänger im Tessin zu arbeiten?",
 a: "Die G-Bewilligung betrifft Arbeit in der Schweiz bei Hauptwohnsitz im Ausland und mindestens wöchentlicher Rückkehr. Die steuerliche Abkommensdefinition ist davon getrennt: erforderlich sind eine Grenzgemeinde, Arbeit in der vorgesehenen Region und grundsätzlich tägliche Heimkehr. Der Ausweis allein bestimmt den Steuerstatus nicht. https://www4.ti.ch/di/spop/stranieri/richiesta-nuovo-g/"
 },
 fr: {
 q: "Faut-il un permis G pour travailler au Tessin comme frontalier ?",
 a: "Le permis G concerne le travail en Suisse avec résidence principale à l’étranger et retour au moins hebdomadaire. La définition fiscale de l’accord est distincte: commune dans la zone frontalière, activité dans la région prévue et retour en principe quotidien. Le permis seul ne détermine pas le statut fiscal. https://www4.ti.ch/di/spop/stranieri/richiesta-nuovo-g/"
 }
 },
 "Quanto guadagna un frontaliere in Ticino?": {
 en: {
 q: "How much does a cross-border worker earn in Ticino?",
 a: "Average salary for a cross-border worker in Ticino varies by sector: pharma CHF 85,000–120,000/year, finance CHF 80,000–110,000, IT CHF 75,000–100,000, healthcare CHF 65,000–90,000, retail CHF 55,000–70,000. Use our free tax simulator to calculate net pay after Swiss and Italian taxes."
 },
 de: {
 q: "Wie viel verdient ein Grenzgänger im Tessin?",
 a: "Das Durchschnittsgehalt eines Grenzgängers im Tessin variiert nach Branche: Pharma CHF 85.000–120.000/Jahr, Finanzen CHF 80.000–110.000, IT CHF 75.000–100.000, Gesundheit CHF 65.000–90.000, Handel CHF 55.000–70.000. Nutzen Sie unseren kostenlosen Steuerrechner, um den Nettolohn nach Schweizer und italienischen Steuern zu berechnen."
 },
 fr: {
 q: "Combien gagne un frontalier au Tessin ?",
 a: "Le salaire moyen d'un frontalier au Tessin varie selon le secteur : pharma CHF 85 000–120 000/an, finance CHF 80 000–110 000, IT CHF 75 000–100 000, santé CHF 65 000–90 000, commerce CHF 55 000–70 000. Utilisez notre simulateur fiscal gratuit pour calculer le net après impôts suisses et italiens."
 }
 },

 // ── Calculator tools FAQs ──
 "Come funziona il calcolatore stipendio per frontalieri?": {
 en: {
 q: "How does the salary calculator for cross-border workers work?",
 a: "Enter your annual gross salary in CHF, marital status, number of children, municipality of residence, and type of cross-border worker (new or old). The simulator automatically calculates Swiss contributions (AVS, LPP, AC), Ticino withholding tax, Italian IRPEF with exemption, and shows the monthly net in CHF and EUR."
 },
 de: {
 q: "Wie funktioniert der Lohnrechner für Grenzgänger?",
 a: "Geben Sie Ihren jährlichen Bruttolohn in CHF, Familienstand, Kinderzahl, Wohngemeinde und den Grenzgängertyp (neu oder alt) ein. Der Simulator berechnet automatisch die Schweizer Beiträge (AHV, BVG, ALV), die Tessiner Quellensteuer, die italienische IRPEF mit Freibetrag und zeigt den monatlichen Nettolohn in CHF und EUR."
 },
 fr: {
 q: "Comment fonctionne le calculateur de salaire pour les frontaliers ?",
 a: "Saisissez votre salaire brut annuel en CHF, état civil, nombre d'enfants, commune de résidence et type de frontalier (nouveau ou ancien). Le simulateur calcule automatiquement les cotisations suisses (AVS, LPP, AC), l'impôt à la source tessinois, l'IRPEF italienne avec franchise, et affiche le net mensuel en CHF et EUR."
 }
 },
 "Il calcolatore è aggiornato al 2026?": {
 en: {
 q: "Is the calculator updated for 2026?",
 a: "Yes, the calculator uses 2026 rates: Ticino withholding tax tables, IRPEF brackets, AVS contributions at 5.3%, LPP by age group, and the real-time CHF/EUR exchange rate. The new tax agreement (€10,000 exemption for new cross-border workers) is fully integrated."
 },
 de: {
 q: "Ist der Rechner auf dem Stand von 2026?",
 a: "Ja, der Rechner verwendet die Sätze 2026: Tessiner Quellensteuertabellen, IRPEF-Stufen, AHV-Beiträge von 5,3 %, BVG nach Altersgruppe und den Echtzeit-Wechselkurs CHF/EUR. Das neue Steuerabkommen (Freibetrag 10.000 € für neue Grenzgänger) ist vollständig integriert."
 },
 fr: {
 q: "Le calculateur est-il mis à jour pour 2026 ?",
 a: "Oui, le calculateur utilise les taux 2026 : barèmes d'imposition à la source du Tessin, tranches IRPEF, cotisations AVS à 5,3 %, LPP par groupe d'âge et le taux de change CHF/EUR en temps réel. Le nouvel accord fiscal (franchise de 10 000 € pour les nouveaux frontaliers) est pleinement intégré."
 }
 },
 "Qual è la differenza tra gli strumenti disponibili?": {
 en: {
 q: "What is the difference between the available tools?",
 a: "The main simulator calculates net from gross. 'RAL Comparison' compares CH and IT salaries. 'Pay Slip' simulates a full pay slip. 'What-If' shows the impact of alternative scenarios (children, change of residence, promotion). 'Permit G vs B' compares costs and benefits between commuting and residence."
 },
 de: {
 q: "Was ist der Unterschied zwischen den verfügbaren Tools?",
 a: "Der Hauptsimulator berechnet den Nettolohn aus dem Brutto. 'RAL-Vergleich' vergleicht CH- und IT-Gehälter. 'Lohnabrechnung' simuliert eine vollständige Lohnabrechnung. 'What-If' zeigt die Auswirkungen alternativer Szenarien (Kinder, Wohnortwechsel, Beförderung). 'Bewilligung G vs. B' vergleicht Kosten und Vorteile zwischen Pendeln und Wohnsitz."
 },
 fr: {
 q: "Quelle est la différence entre les outils disponibles ?",
 a: "Le simulateur principal calcule le net à partir du brut. 'Comparaison RAL' compare les salaires CH et IT. 'Fiche de paie' simule une fiche de paie complète. 'What-If' montre l'impact de scénarios alternatifs (enfants, changement de résidence, promotion). 'Permis G vs B' compare les coûts et avantages entre le pendulaire et la résidence."
 }
 },
 "Il simulatore funziona anche per i vecchi frontalieri?": {
 en: {
 q: "Does the simulator also work for old cross-border workers?",
 a: "Yes. Selecting the old-worker regime applies Swiss tax without Italian IRPEF on salary covered by Article 9. Check eligibility first; the two tax regimes are not freely interchangeable options. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Funktioniert der Simulator auch für Altgrenzgänger?",
 a: "Ja. Bei Auswahl des alten Regimes berechnet der Simulator die Schweizer Steuer ohne italienische IRPEF auf den von Artikel 9 erfassten Lohn. Prüfen Sie zuerst die Voraussetzungen; die Regime sind nicht frei wählbar. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Le simulateur fonctionne-t-il aussi pour les anciens frontaliers ?",
 a: "Oui. En sélectionnant l’ancien régime, le simulateur applique l’impôt suisse sans IRPEF italienne sur le salaire couvert par l’article 9. Vérifiez les conditions; les régimes fiscaux ne sont pas librement interchangeables. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 // ── What-If simulator FAQs ──
 "Come funziona il simulatore What-If per frontalieri?": {
 en: {
 q: "How does the What-If simulator for cross-border workers work?",
 a: "Enter your current scenario (salary, marital status, children, residence) and then modify one or more variables to see in real time how your net pay changes. For example: what happens if a child arrives? If you change residence? If your salary increases by 10%?"
 },
 de: {
 q: "Wie funktioniert der What-If-Simulator für Grenzgänger?",
 a: "Geben Sie Ihr aktuelles Szenario ein (Gehalt, Familienstand, Kinder, Wohnsitz) und ändern Sie dann eine oder mehrere Variablen, um in Echtzeit zu sehen, wie sich Ihr Nettolohn verändert. Zum Beispiel: Was passiert bei einem Kind? Bei Wohnortwechsel? Bei 10 % Gehaltserhöhung?"
 },
 fr: {
 q: "Comment fonctionne le simulateur What-If pour les frontaliers ?",
 a: "Saisissez votre scénario actuel (salaire, état civil, enfants, résidence) puis modifiez une ou plusieurs variables pour voir en temps réel comment votre net évolue. Par exemple : que se passe-t-il si un enfant arrive ? Si vous changez de résidence ? Si votre salaire augmente de 10 % ?"
 }
 },
 "Quali scenari posso simulare?": {
 en: {
 q: "What scenarios can I simulate?",
 a: "You can simulate: birth of a child (impact on deductions and allowances), change of marital status (marriage/divorce), salary increase or decrease, change of residential area (within/beyond 20 km from the border), switch from old to new cross-border worker status, and CHF/EUR exchange rate variation."
 },
 de: {
 q: "Welche Szenarien kann ich simulieren?",
 a: "Sie können simulieren: Geburt eines Kindes (Auswirkung auf Abzüge und Zulagen), Änderung des Familienstands (Heirat/Scheidung), Gehaltserhöhung oder -senkung, Wechsel des Wohngebiets (innerhalb/ausserhalb von 20 km zur Grenze), Wechsel vom Alt- zum Neugrenzgänger und Veränderung des CHF/EUR-Wechselkurses."
 },
 fr: {
 q: "Quels scénarios puis-je simuler ?",
 a: "Vous pouvez simuler : naissance d'un enfant (impact sur les déductions et allocations), changement d'état civil (mariage/divorce), augmentation ou diminution du salaire, changement de zone de résidence (dans/au-delà de 20 km de la frontière), passage d'ancien à nouveau frontalier, et variation du taux de change CHF/EUR."
 }
 },
 "La simulazione What-If è affidabile?": {
 en: {
 q: "Is the What-If simulation reliable?",
 a: "The simulation uses the same tax tables as the main calculator: Ticino withholding tax rates 2026, IRPEF brackets, AVS/LPP/AC contributions. Results are indicative estimates, not professional tax advice."
 },
 de: {
 q: "Ist die What-If-Simulation zuverlässig?",
 a: "Die Simulation verwendet dieselben Steuertabellen wie der Hauptrechner: Tessiner Quellensteuersätze 2026, IRPEF-Stufen, AHV/BVG/ALV-Beiträge. Die Ergebnisse sind orientierende Schätzungen, keine professionelle Steuerberatung."
 },
 fr: {
 q: "La simulation What-If est-elle fiable ?",
 a: "La simulation utilise les mêmes barèmes fiscaux que le calculateur principal : taux d'imposition à la source du Tessin 2026, tranches IRPEF, cotisations AVS/LPP/AC. Les résultats sont des estimations indicatives, pas un conseil fiscal professionnel."
 }
 },

 // ── Homepage FAQ (11 questions) ──────────────────────────────────────

 "Qual è la differenza tra vecchio e nuovo frontaliere?": {
 en: {
 q: "What is the difference between old and new cross-border workers?",
 a: "An old worker qualifying under Article 9 worked as a tax cross-border worker in Ticino, Graubünden or Valais between 31 December 2018 and 17 July 2023: the covered salary is taxed exclusively in Switzerland. New tax cross-border workers pay 80% of ordinary Swiss withholding tax and Italian tax with credit for Swiss tax. An eligible municipality of residence and, in principle, daily return also matter, not just the latest contract date. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Was ist der Unterschied zwischen alten und neuen Grenzgängern?",
 a: "Ein alter Grenzgänger nach Artikel 9 war zwischen dem 31. Dezember 2018 und dem 17. Juli 2023 als steuerlicher Grenzgänger im Tessin, in Graubünden oder im Wallis tätig: Der erfasste Lohn wird ausschliesslich in der Schweiz besteuert. Neue steuerliche Grenzgänger zahlen 80% der ordentlichen Schweizer Quellensteuer und italienische Steuer unter Anrechnung der Schweizer Steuer. Auch die zugelassene Wohngemeinde und grundsätzlich tägliche Rückkehr zählen, nicht nur das letzte Vertragsdatum. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Quelle est la différence entre ancien et nouveau frontalier ?",
 a: "Un ancien frontalier admissible selon l’article 9 a travaillé comme frontalier fiscal au Tessin, dans les Grisons ou en Valais entre le 31 décembre 2018 et le 17 juillet 2023 : le salaire concerné est imposé exclusivement en Suisse. Les nouveaux frontaliers fiscaux paient 80% de l’impôt suisse à la source ordinaire et l’impôt italien avec crédit pour l’impôt suisse. La commune de résidence admise et le retour en principe quotidien comptent aussi, pas seulement la date du dernier contrat. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 "Conviene lavorare come vecchio o nuovo frontaliere nel 2026?": {
 en: {
 q: "Is it better to work as an old or new cross-border worker in 2026?",
 a: "It depends on salary, marital status, children, and municipality of residence. The old regime is generally more advantageous for medium-high salaries (>CHF 60,000). The new regime can be more beneficial with lower salaries thanks to the EUR 10,000 exemption. Use the free simulator on frontaliereticino.ch to calculate your specific case."
 },
 de: {
 q: "Lohnt es sich 2026 eher als alter oder neuer Grenzgänger zu arbeiten?",
 a: "Das hängt von Gehalt, Familienstand, Kindern und Wohngemeinde ab. Das alte Regime ist bei mittleren bis hohen Löhnen (>CHF 60.000) generell vorteilhafter. Das neue Regime kann bei niedrigeren Löhnen dank des Freibetrags von 10.000 EUR günstiger sein. Nutzen Sie den kostenlosen Simulator auf frontaliereticino.ch."
 },
 fr: {
 q: "Est-il plus avantageux de travailler comme ancien ou nouveau frontalier en 2026 ?",
 a: "Cela dépend du salaire, de la situation familiale, des enfants et de la commune de résidence. L'ancien régime est généralement plus avantageux pour les salaires moyens-élevés (>CHF 60 000). Le nouveau régime peut être plus intéressant avec des salaires plus bas grâce à la franchise de 10 000 EUR. Utilisez le simulateur gratuit sur frontaliereticino.ch."
 }
 },

 "Come si calcola l'imposta alla fonte in Canton Ticino nel 2026?": {
 en: {
 q: "How is the withholding tax calculated in Canton Ticino in 2026?",
 a: "The withholding tax in Ticino is calculated on the gross annual salary with progressive rates: 0% below CHF 18,000, from 4% to 24% for higher incomes, varying by marital status (tables A single, B married single-income, C married dual-income, H single parent) and number of children. Each child reduces the rate by about 1-2 percentage points."
 },
 de: {
 q: "Wie wird die Quellensteuer im Kanton Tessin 2026 berechnet?",
 a: "Die Quellensteuer im Tessin wird auf dem Bruttojahresgehalt mit progressiven Sätzen berechnet: 0 % unter CHF 18.000, von 4 % bis 24 % für höhere Einkommen, je nach Familienstand (Tabelle A ledig, B verheiratet Alleinverdiener, C verheiratet Doppelverdiener, H alleinerziehend) und Kinderzahl. Jedes Kind reduziert den Satz um ca. 1-2 Prozentpunkte."
 },
 fr: {
 q: "Comment est calculé l'impôt à la source au Tessin en 2026 ?",
 a: "L'impôt à la source au Tessin est calculé sur le salaire brut annuel avec des taux progressifs : 0 % en dessous de CHF 18 000, de 4 % à 24 % pour les revenus supérieurs, selon la situation familiale (barème A célibataire, B marié revenu unique, C marié double revenu, H parent isolé) et le nombre d'enfants. Chaque enfant réduit le taux d'environ 1 à 2 points."
 }
 },

 "Quanto guadagna netto un frontaliere con CHF 80.000 lordi nel 2026?": {
 en: {
 q: "How much does a cross-border worker earn net on CHF 80,000 gross in 2026?",
 a: "A single cross-border worker without children earning CHF 80,000 gross/year earns about CHF 4,900-5,100/month net under the old agreement (withholding tax only), or about CHF 4,400-4,600/month net under the new agreement (reduced withholding tax + Italian IRPEF with EUR 10,000 exemption and tax credit). Swiss social contributions (AVS 5.3%, AC 1.1%, LAA, LPP) are deducted from gross."
 },
 de: {
 q: "Wie viel verdient ein Grenzgänger netto bei CHF 80.000 brutto 2026?",
 a: "Ein lediger Grenzgänger ohne Kinder mit CHF 80.000 brutto/Jahr verdient ca. CHF 4.900-5.100/Monat netto nach dem alten Abkommen (nur Quellensteuer), oder ca. CHF 4.400-4.600/Monat netto nach dem neuen Abkommen (reduzierte Quellensteuer + italienische IRPEF mit Freibetrag 10.000 EUR und Steuergutschrift). Schweizer Sozialabgaben (AHV 5,3 %, ALV 1,1 %, UVG, BVG) werden vom Bruttolohn abgezogen."
 },
 fr: {
 q: "Combien gagne net un frontalier avec CHF 80 000 bruts en 2026 ?",
 a: "Un frontalier célibataire sans enfants gagnant CHF 80 000 bruts/an touche environ CHF 4 900-5 100/mois nets avec l'ancien accord (impôt à la source uniquement), ou environ CHF 4 400-4 600/mois nets avec le nouvel accord (impôt à la source réduit + IRPEF italienne avec franchise de 10 000 EUR et crédit d'impôt). Les cotisations sociales suisses (AVS 5,3 %, AC 1,1 %, LAA, LPP) sont déduites du brut."
 }
 },

 "Quanto costa l'assicurazione sanitaria LAMal per frontalieri?": {
 en: {
 q: "How much does LAMal health insurance cost for cross-border workers?",
 a: "Cross-border workers resident in Italy pay country-of-residence LAMal premiums, not premiums for their Swiss canton of employment. The official FOPH 2026 Italy table lists 14 insurers with separate age and accident-cover rates. For adults aged 26+ without accident cover, monthly premiums range from CHF 279 to CHF 487.20; the ordinary deductible is CHF 300 (CHF 0 for children). Optional deductibles and HMO/Telmed models are unavailable. Source: https://www.priminfo.admin.ch/downloads/praemien_eu_2026.pdf"
 },
 de: {
 q: "Was kostet die KVG-Krankenversicherung für Grenzgänger?",
 a: "Für Grenzgänger mit Wohnsitz in Italien gelten die KVG-Prämien des Wohnsitzlands, nicht des Schweizer Arbeitskantons. Die offizielle BAG-Tabelle 2026 für Italien nennt 14 Versicherer mit getrennten Prämien nach Alter und Unfalldeckung. Für Erwachsene ab 26 ohne Unfalldeckung liegen die Monatsprämien zwischen CHF 279 und CHF 487.20; die ordentliche Franchise beträgt CHF 300 (CHF 0 für Kinder). Wahlfranchisen und HMO/Telmed-Modelle sind nicht verfügbar. Quelle: https://www.priminfo.admin.ch/downloads/praemien_eu_2026.pdf"
 },
 fr: {
 q: "Combien coûte l'assurance maladie LAMal pour les frontaliers ?",
 a: "Les frontaliers résidant en Italie paient les primes LAMal du pays de domicile, et non celles du canton de travail suisse. Le tableau officiel OFSP 2026 pour l’Italie comprend 14 assureurs et distingue âge et couverture accidents. Pour les adultes dès 26 ans sans couverture accidents, les primes mensuelles vont de CHF 279 à CHF 487.20 ; la franchise ordinaire est CHF 300 (CHF 0 pour enfants). Les franchises à option et modèles HMO/Telmed ne sont pas disponibles. Source : https://www.priminfo.admin.ch/downloads/praemien_eu_2026.pdf"
 }
 },

 "Come funziona la pensione per i frontalieri svizzeri?": {
 en: {
 q: "How does the pension system work for Swiss cross-border workers?",
 a: "The system distinguishes state AVS, occupational LPP and voluntary individual pensions. Check eligibility and benefits with the relevant institutions. The third pillar does not give every frontier worker an automatic deduction. ESTV FAQ 5.3 excludes subsequent ordinary assessment (TOU) for fiscal frontier workers covered by the Italy–Switzerland agreement. Other categories must check eligibility and procedure with the tax authority. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Wie funktioniert das Rentensystem für Schweizer Grenzgänger?",
 a: "Das System unterscheidet staatliche AHV, berufliche BVG- und freiwillige individuelle Vorsorge. Ansprüche und Leistungen bei den zuständigen Stellen prüfen. Die dritte Säule bewirkt keinen automatischen Abzug für alle Grenzgänger. Laut ESTV-FAQ 5.3 ist die nachträgliche ordentliche Veranlagung für steuerliche Grenzgänger des Abkommens Italien–Schweiz ausgeschlossen. Andere Kategorien müssen Voraussetzungen und Verfahren bei der Steuerbehörde prüfen. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Comment fonctionne le système de retraite pour les frontaliers suisses ?",
 a: "Le système distingue AVS étatique, LPP professionnelle et prévoyance individuelle volontaire. Vérifier droits et prestations auprès des organismes compétents. Le troisième pilier ne donne pas de déduction automatique à tous les frontaliers. La FAQ 5.3 de l’AFC exclut la taxation ordinaire ultérieure pour les frontaliers fiscaux de l’accord Italie–Suisse. Les autres catégories doivent vérifier les conditions et la procédure auprès de l’autorité fiscale. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 "Qual è il modo migliore per cambiare CHF in EUR?": {
 en: {
 q: "What is the best way to exchange CHF to EUR?",
 a: "Wise (formerly TransferWise) and Revolut offer the best rates with a 0.25-0.5% markup on the interbank rate. Traditional banks (UBS, PostFinance) charge 2-3% markup. For a cross-border worker exchanging CHF 5,000/month, Wise saves about CHF 100-150/month compared to a traditional bank, i.e. CHF 1,200-1,800/year."
 },
 de: {
 q: "Was ist der beste Weg, CHF in EUR umzutauschen?",
 a: "Wise (ehemals TransferWise) und Revolut bieten die besten Kurse mit einem Aufschlag von 0,25-0,5 % auf den Interbankenkurs. Traditionelle Banken (UBS, PostFinance) berechnen 2-3 % Aufschlag. Ein Grenzgänger, der monatlich CHF 5.000 wechselt, spart mit Wise ca. CHF 100-150/Monat gegenüber einer traditionellen Bank, also CHF 1.200-1.800/Jahr."
 },
 fr: {
 q: "Quel est le meilleur moyen de changer des CHF en EUR ?",
 a: "Wise (ex TransferWise) et Revolut offrent les meilleurs taux avec une marge de 0,25-0,5 % sur le taux interbancaire. Les banques traditionnelles (UBS, PostFinance) appliquent une marge de 2-3 %. Pour un frontalier changeant CHF 5 000/mois, Wise économise environ CHF 100-150/mois par rapport à une banque traditionnelle, soit CHF 1 200-1 800/an."
 }
 },

 "I frontalieri devono fare la dichiarazione dei redditi in Italia?": {
 en: {
 q: "Do cross-border workers have to file a tax return in Italy?",
 a: "New tax cross-border workers have Swiss salary taxable also in Italy, with credit for Swiss taxes. Old workers qualifying under Article 9 are exempt on the covered salary but may have Italian obligations for other income or asset reporting. Status depends on tax requirements and qualifying employment between 31 December 2018 and 17 July 2023, not merely the latest hire date. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Müssen Grenzgänger eine Steuererklärung in Italien abgeben?",
 a: "Bei neuen steuerlichen Grenzgängern ist der Schweizer Lohn auch in Italien steuerpflichtig, mit Anrechnung der Schweizer Steuer. Alte Grenzgänger nach Artikel 9 sind auf den erfassten Lohn befreit; für andere Einkünfte oder Vermögensmeldungen können italienische Pflichten bestehen. Entscheidend sind die steuerlichen Voraussetzungen und qualifizierende Beschäftigung zwischen dem 31. Dezember 2018 und dem 17. Juli 2023, nicht allein die letzte Einstellung. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Les frontaliers doivent-ils faire une déclaration de revenus en Italie ?",
 a: "Le salaire suisse des nouveaux frontaliers fiscaux est également imposable en Italie, avec crédit pour l’impôt suisse. Les anciens admissibles selon l’article 9 sont exonérés sur le salaire couvert, mais peuvent avoir des obligations italiennes pour d’autres revenus ou déclarations de patrimoine. Le statut dépend des conditions fiscales et de l’activité admissible entre le 31 décembre 2018 et le 17 juillet 2023, pas seulement de la dernière embauche. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 "Quanti frontalieri lavorano in Canton Ticino?": {
 en: {
 q: "How many cross-border workers work in Canton Ticino?",
 a: "About 79,000 cross-border workers commute daily from Italy to Canton Ticino (BFS 2025 data). Ticino is the Swiss canton with the highest concentration of cross-border workers, representing about 30% of the cantonal workforce. The number grows by 2-3% annually. Main sectors are manufacturing, construction, finance, healthcare, hospitality, and IT."
 },
 de: {
 q: "Wie viele Grenzgänger arbeiten im Kanton Tessin?",
 a: "Rund 79.000 Grenzgänger pendeln täglich von Italien in den Kanton Tessin (BFS-Daten 2025). Das Tessin ist der Schweizer Kanton mit der höchsten Grenzgängerkonzentration, die etwa 30 % der kantonalen Arbeitskräfte ausmachen. Die Zahl wächst jährlich um 2-3 %. Hauptsektoren sind Fertigung, Bau, Finanzen, Gesundheitswesen, Gastgewerbe und IT."
 },
 fr: {
 q: "Combien de frontaliers travaillent au Canton du Tessin ?",
 a: "Environ 79 000 travailleurs frontaliers font la navette quotidiennement de l'Italie au Canton du Tessin (données OFS 2025). Le Tessin est le canton suisse avec la plus forte concentration de frontaliers, représentant environ 30 % de la main-d'oeuvre cantonale. Le nombre augmente de 2-3 % par an. Les principaux secteurs sont l'industrie, la construction, la finance, la santé, l'hôtellerie et l'informatique."
 }
 },

 "Cosa sono i ristorni fiscali?": {
 en: {
 q: "What are fiscal rebates (ristorni)?",
 a: "Article 9 provides compensation to Italy of 40% of tax revenue from old cross-border workers through tax year 2033, without gradually reducing that percentage. Switzerland retains the revenue thereafter. This does not automatically change old workers to concurrent taxation. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Was sind Steuerrückvergütungen (Ristorni)?",
 a: "Artikel 9 sieht bis zum Steuerjahr 2033 einen Ausgleich an Italien von 40% des Steueraufkommens alter Grenzgänger vor, ohne schrittweise Senkung des Prozentsatzes. Danach behält die Schweiz die Einnahmen. Das bewirkt keinen automatischen Wechsel alter Grenzgänger zur konkurrierenden Besteuerung. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Que sont les rétrocessions fiscales (ristorni) ?",
 a: "L’article 9 prévoit jusqu’à l’année fiscale 2033 une compensation à l’Italie de 40% des recettes des anciens frontaliers, sans réduction progressive du pourcentage. Ensuite la Suisse conserve les recettes. Cela ne fait pas automatiquement passer les anciens frontaliers à l’imposition concurrente. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 // ── Simulazione tasse nuovi frontalieri page (4 missing) ─────────────

 "Come vengono tassati i nuovi frontalieri dal 2024?": {
 en: {
 q: "How are new cross-border workers taxed from 2024?",
 a: "Since 2024, new tax cross-border workers qualifying under the agreement pay 80% of ordinary Swiss withholding tax and Italian tax with credit for Swiss tax. They meet the tax definition but do not qualify under Article 9 through eligible employment between 31 December 2018 and 17 July 2023. The Italian €10,000 allowance separately requires the conditions of Italian law. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Wie werden neue Grenzgänger ab 2024 besteuert?",
 a: "Seit 2024 zahlen neue steuerliche Grenzgänger im Sinne des Abkommens 80% der ordentlichen Schweizer Quellensteuer und italienische Steuer mit Anrechnung der Schweizer Steuer. Sie erfüllen die steuerliche Definition, profitieren jedoch nicht aufgrund qualifizierender Beschäftigung zwischen dem 31. Dezember 2018 und dem 17. Juli 2023 von Artikel 9. Der italienische Freibetrag von 10.000 € setzt gesondert die italienischen gesetzlichen Bedingungen voraus. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Comment les nouveaux frontaliers sont-ils imposés à partir de 2024 ?",
 a: "Depuis 2024, les nouveaux frontaliers fiscaux admis par l’accord paient 80% de l’impôt suisse à la source ordinaire et l’impôt italien avec crédit pour l’impôt suisse. Ils répondent à la définition fiscale sans bénéficier de l’article 9 grâce à une activité admissible entre le 31 décembre 2018 et le 17 juillet 2023. La franchise italienne de 10.000 € exige séparément les conditions de la loi italienne. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 "Come funziona il credito d'imposta per evitare la doppia tassazione?": {
 en: {
 q: "How does the tax credit work to avoid double taxation?",
 a: "The tax credit allows new cross-border workers to deduct Swiss taxes paid from Italian IRPEF, avoiding double taxation. The credit is limited to the lesser of Swiss tax paid and Italian tax due on the same income. It is claimed in the Italian tax return."
 },
 de: {
 q: "Wie funktioniert die Steuergutschrift zur Vermeidung der Doppelbesteuerung?",
 a: "Die Steuergutschrift ermöglicht neuen Grenzgängern, gezahlte Schweizer Steuern von der italienischen IRPEF abzuziehen und so eine Doppelbesteuerung zu vermeiden. Die Gutschrift ist auf den niedrigeren Betrag aus Schweizer Steuer und italienischer Steuer auf dasselbe Einkommen begrenzt. Sie wird in der italienischen Steuererklärung geltend gemacht."
 },
 fr: {
 q: "Comment fonctionne le crédit d'impôt pour éviter la double imposition ?",
 a: "Le crédit d'impôt permet aux nouveaux frontaliers de déduire les impôts suisses payés de l'IRPEF italienne, évitant ainsi la double imposition. Le crédit est limité au montant le plus faible entre l'impôt suisse payé et l'impôt italien dû sur le même revenu. Il est demandé dans la déclaration de revenus italienne."
 }
 },

 "Come calcolo lo stipendio netto come nuovo frontaliere?": {
 en: {
 q: "How do I calculate my net salary as a new cross-border worker?",
 a: "Use the free simulator on frontaliereticino.ch: enter gross salary, marital status, children, and municipality of residence. The tool calculates Swiss withholding tax, social contributions (AVS, AC, LPP), Italian IRPEF with EUR 10,000 exemption, and tax credit to show your exact net salary."
 },
 de: {
 q: "Wie berechne ich mein Nettogehalt als neuer Grenzgänger?",
 a: "Nutzen Sie den kostenlosen Simulator auf frontaliereticino.ch: Geben Sie Bruttogehalt, Familienstand, Kinder und Wohngemeinde ein. Das Tool berechnet Schweizer Quellensteuer, Sozialabgaben (AHV, ALV, BVG), italienische IRPEF mit Freibetrag 10.000 EUR und Steuergutschrift, um Ihr genaues Nettogehalt zu zeigen."
 },
 fr: {
 q: "Comment calculer mon salaire net en tant que nouveau frontalier ?",
 a: "Utilisez le simulateur gratuit sur frontaliereticino.ch : entrez le salaire brut, la situation familiale, les enfants et la commune de résidence. L'outil calcule l'impôt à la source suisse, les cotisations sociales (AVS, AC, LPP), l'IRPEF italienne avec franchise de 10 000 EUR et le crédit d'impôt pour afficher votre salaire net exact."
 }
 },

 // ── Diesel price article FAQs ──
 "Quanto costa il diesel in Svizzera nel 2026?": {
 en: {
 q: "How much does diesel cost in Switzerland in 2026?",
 a: "The average diesel price in Switzerland in 2026 is around CHF 2.10 per liter. Prices range from CHF 1.95 to CHF 2.25 depending on the region and fuel station. In Ticino, prices tend to be slightly lower than in German-speaking Switzerland due to proximity to Italian fuel stations."
 },
 de: {
 q: "Was kostet Diesel in der Schweiz im Jahr 2026?",
 a: "Der durchschnittliche Dieselpreis in der Schweiz liegt 2026 bei rund CHF 2,10 pro Liter. Die Preise schwanken je nach Region und Tankstelle zwischen CHF 1,95 und CHF 2,25. Im Tessin sind die Preise tendenziell etwas niedriger als in der Deutschschweiz, da die italienischen Tankstellen in der Nähe sind."
 },
 fr: {
 q: "Combien coûte le diesel en Suisse en 2026 ?",
 a: "Le prix moyen du diesel en Suisse en 2026 est d'environ CHF 2,10 par litre. Les prix varient de CHF 1,95 à CHF 2,25 selon la région et la station-service. Au Tessin, les prix sont généralement légèrement inférieurs à ceux de la Suisse alémanique grâce à la proximité des stations-service italiennes."
 }
 },

 "Il diesel costa di più in Svizzera o in Italia?": {
 en: {
 q: "Is diesel more expensive in Switzerland or Italy?",
 a: "In 2026, diesel costs around CHF 2.10/liter in Switzerland (approx. EUR 2.20) compared to EUR 1.65-1.75/liter in Italy. However, the gap has narrowed after Italian excise tax cuts. Cross-border workers filling up in Italy can save around EUR 15-20 per 50-liter tank."
 },
 de: {
 q: "Ist Diesel in der Schweiz oder in Italien teurer?",
 a: "2026 kostet Diesel in der Schweiz rund CHF 2,10/Liter (ca. EUR 2,20) im Vergleich zu EUR 1,65-1,75/Liter in Italien. Der Preisunterschied hat sich jedoch nach der Senkung der italienischen Verbrauchssteuern verringert. Grenzgänger, die in Italien tanken, können bei einer 50-Liter-Tankfüllung rund EUR 15-20 sparen."
 },
 fr: {
 q: "Le diesel est-il plus cher en Suisse ou en Italie ?",
 a: "En 2026, le diesel coûte environ CHF 2,10/litre en Suisse (environ EUR 2,20) contre EUR 1,65-1,75/litre en Italie. Toutefois, l'écart s'est réduit après la baisse des accises italiennes. Les frontaliers faisant le plein en Italie peuvent économiser environ EUR 15-20 par plein de 50 litres."
 }
 },

 "Perché il prezzo del diesel è aumentato in Svizzera?": {
 en: {
 q: "Why has the diesel price increased in Switzerland?",
 a: "The diesel price increase in Switzerland in 2026 is due to several factors: the international oil crisis, rising global demand, the strengthening of the US dollar against the Swiss franc, and the increase in mandatory CO2 emission surcharges introduced by the climate law."
 },
 de: {
 q: "Warum ist der Dieselpreis in der Schweiz gestiegen?",
 a: "Der Anstieg des Dieselpreises in der Schweiz 2026 ist auf mehrere Faktoren zurückzuführen: die internationale Ölkrise, die steigende globale Nachfrage, die Stärkung des US-Dollars gegenüber dem Schweizer Franken und die Erhöhung der obligatorischen CO₂-Emissionszuschläge durch das Klimagesetz."
 },
 fr: {
 q: "Pourquoi le prix du diesel a-t-il augmenté en Suisse ?",
 a: "La hausse du prix du diesel en Suisse en 2026 s'explique par plusieurs facteurs : la crise pétrolière internationale, la hausse de la demande mondiale, le renforcement du dollar face au franc suisse et l'augmentation des surtaxes obligatoires sur les émissions de CO₂ introduites par la loi sur le climat."
 }
 },

 "Come risparmiare sul diesel facendo il frontaliere?": {
 en: {
 q: "How can cross-border workers save on diesel?",
 a: "Cross-border workers can save on diesel by filling up in Italy before crossing the border, using price comparison apps like Prezzi Benzina, choosing self-service stations, and accumulating loyalty points. Annual savings can exceed EUR 500 for those driving 40+ km per day."
 },
 de: {
 q: "Wie können Grenzgänger beim Diesel sparen?",
 a: "Grenzgänger können beim Diesel sparen, indem sie in Italien tanken, bevor sie die Grenze überqueren, Preisvergleichs-Apps wie Prezzi Benzina nutzen, Selbstbedienungstankstellen wählen und Treuepunkte sammeln. Die jährliche Ersparnis kann bei über 40 km täglicher Fahrstrecke mehr als EUR 500 betragen."
 },
 fr: {
 q: "Comment les frontaliers peuvent-ils économiser sur le diesel ?",
 a: "Les frontaliers peuvent économiser sur le diesel en faisant le plein en Italie avant de traverser la frontière, en utilisant des applications de comparaison de prix comme Prezzi Benzina, en choisissant les stations en libre-service et en accumulant des points de fidélité. L'économie annuelle peut dépasser EUR 500 pour ceux qui parcourent plus de 40 km par jour."
 }
 },

 // ── Ticino fuel price article FAQs ──
 "Quali sono i distributori più economici in Ticino nel 2026?": {
 en: {
 q: "Which are the cheapest fuel stations in Ticino in 2026?",
 a: "The cheapest fuel stations in Ticino in 2026 are generally self-service ones away from main motorway exits, particularly in Mendrisiotto and Bellinzonese. The live SP95 price ranking published by TCS helps you spot the most convenient stations of the day; differences can exceed CHF 0.15/liter between the most expensive and cheapest station."
 },
 de: {
 q: "Welches sind die günstigsten Tankstellen im Tessin 2026?",
 a: "Die günstigsten Tankstellen im Tessin sind 2026 in der Regel die Selbstbedienungstankstellen abseits der Hauptautobahnausfahrten, vor allem im Mendrisiotto und Bellinzonese. Das von TCS veröffentlichte Live-Ranking der SP95-Preise zeigt die günstigsten Stationen des Tages; zwischen der teuersten und der günstigsten Tankstelle können mehr als CHF 0,15/Liter Unterschied liegen."
 },
 fr: {
 q: "Quelles sont les stations-service les moins chères au Tessin en 2026 ?",
 a: "Les stations-service les moins chères au Tessin en 2026 sont généralement les stations en libre-service éloignées des grandes sorties d'autoroute, en particulier dans le Mendrisiotto et le Bellinzonese. Le classement en direct des prix SP95 publié par TCS permet d'identifier les stations les plus avantageuses du jour ; l'écart entre la station la plus chère et la moins chère peut dépasser CHF 0,15/litre."
 }
 },

 "Di quanto sono aumentati i prezzi dei carburanti in Ticino nel 2026?": {
 en: {
 q: "By how much have fuel prices risen in Ticino in 2026?",
 a: "In 2026, fuel prices in Ticino have risen by about +19 millesimi per liter for petrol and +46 millesimi per liter for diesel compared with the start of the year, according to TCS and Adnkronos aggregated data. The increase is in line with the Swiss national average and is driven by crude-oil volatility and the adjustment of CO₂ surcharges."
 },
 de: {
 q: "Um wie viel sind die Kraftstoffpreise im Tessin 2026 gestiegen?",
 a: "2026 sind die Kraftstoffpreise im Tessin im Vergleich zum Jahresbeginn um rund +19 Rappen pro Liter bei Benzin und +46 Rappen pro Liter bei Diesel gestiegen, so die Zahlen von TCS und Adnkronos. Der Anstieg liegt im nationalen Schweizer Durchschnitt und ist auf die Volatilität der Rohölpreise und die Anpassung der CO₂-Zuschläge zurückzuführen."
 },
 fr: {
 q: "De combien les prix des carburants ont-ils augmenté au Tessin en 2026 ?",
 a: "En 2026, les prix des carburants au Tessin ont augmenté d'environ +19 millièmes par litre pour l'essence et +46 millièmes par litre pour le diesel par rapport au début de l'année, selon les données TCS et Adnkronos. La hausse est conforme à la moyenne nationale suisse et s'explique par la volatilité du brut et l'ajustement des surtaxes CO₂."
 }
 },

 "Conviene ancora fare benzina in Italia per i frontalieri?": {
 en: {
 q: "Is it still worth refuelling in Italy for cross-border workers?",
 a: "In 2026, filling up in Italy is still worthwhile for most cross-border workers: the price differential is around CHF 0.30-0.50 per liter versus Switzerland after CHF/EUR conversion. On a 50-liter tank the gross saving is CHF 15-25, but you must factor in the time and fuel cost of the detour; for anyone living within 5 km of the border it is almost always advantageous."
 },
 de: {
 q: "Lohnt sich das Tanken in Italien für Grenzgänger 2026 noch?",
 a: "2026 lohnt sich das Tanken in Italien für die meisten Grenzgänger weiterhin: Der Preisunterschied beträgt nach CHF/EUR-Umrechnung rund CHF 0,30-0,50 pro Liter gegenüber der Schweiz. Bei einer Tankfüllung von 50 Litern beträgt die Bruttoersparnis CHF 15-25, doch müssen Zeit- und Kraftstoffkosten für den Umweg einkalkuliert werden; wer weniger als 5 km von der Grenze entfernt wohnt, profitiert fast immer."
 },
 fr: {
 q: "Est-il toujours intéressant de faire le plein en Italie pour les frontaliers ?",
 a: "En 2026, faire le plein en Italie reste intéressant pour la plupart des frontaliers : l'écart de prix est d'environ CHF 0,30-0,50 par litre par rapport à la Suisse après conversion CHF/EUR. Sur un plein de 50 litres, l'économie brute est de CHF 15-25, mais il faut tenir compte du temps et du carburant du détour ; pour quiconque habite à moins de 5 km de la frontière, c'est presque toujours avantageux."
 }
 },

 "Quanto costa un pieno di diesel in Ticino oggi?": {
 en: {
 q: "How much does a diesel tank cost in Ticino today?",
 a: "A 50-liter diesel tank in Ticino in 2026 costs on average about CHF 105, at a mean price of CHF 2.10/liter. At the cheapest self-service stations the figure can drop to around CHF 98-100 for the same tank. The live price table in this article shows the most convenient Swiss fuel stations, updated in real time."
 },
 de: {
 q: "Was kostet eine Tankfüllung Diesel im Tessin heute?",
 a: "Eine Tankfüllung mit 50 Litern Diesel kostet im Tessin 2026 durchschnittlich rund CHF 105 bei einem mittleren Preis von CHF 2,10/Liter. An den günstigsten Selbstbedienungstankstellen sinkt der Betrag für dieselbe Tankfüllung auf rund CHF 98-100. Die Live-Preistabelle in diesem Artikel zeigt die günstigsten Schweizer Tankstellen in Echtzeit."
 },
 fr: {
 q: "Combien coûte un plein de diesel au Tessin aujourd'hui ?",
 a: "Un plein de diesel de 50 litres au Tessin en 2026 coûte en moyenne environ CHF 105, au prix moyen de CHF 2,10/litre. Dans les stations en libre-service les moins chères, il est possible de descendre à environ CHF 98-100 pour le même plein. Le tableau des prix en direct dans cet article affiche les stations-service suisses les plus avantageuses, mises à jour en temps réel."
 }
 },

 // ── Payslip simulator FAQ (new frontaliere 2026) ──
 "Che cos'è il Nuovo Accordo frontalieri 2026?": {
 en: {
 q: "What is the 2026 New Cross-Border Worker Agreement?",
 a: "It is the Italy–Switzerland tax agreement that entered into force on 17 July 2023 and applies from 1 January 2024, not a new agreement signed in 2026. It distinguishes old workers qualifying under Article 9, whose covered salary is taxed only in Switzerland, from new tax cross-border workers: the latter pay 80% of ordinary Swiss withholding tax and Italian tax with a credit. The hire date alone does not determine status. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Was ist das neue Grenzgaengerabkommen 2026?",
 a: "Gemeint ist das Steuerabkommen Italien–Schweiz, das am 17. Juli 2023 in Kraft trat und seit dem 1. Januar 2024 angewendet wird, kein 2026 neu abgeschlossenes Abkommen. Es unterscheidet alte Grenzgänger nach Artikel 9, deren erfasster Lohn nur in der Schweiz besteuert wird, von neuen steuerlichen Grenzgängern: Diese zahlen 80% der ordentlichen Schweizer Quellensteuer und italienische Steuer mit Anrechnung. Das Einstellungsdatum allein bestimmt den Status nicht. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Qu'est-ce que le Nouvel Accord frontaliers 2026 ?",
 a: "Il s’agit de l’accord fiscal Italie–Suisse entré en vigueur le 17 juillet 2023 et applicable depuis le 1er janvier 2024, non d’un nouvel accord signé en 2026. Il distingue les anciens frontaliers admissibles selon l’article 9, dont le salaire concerné est imposé uniquement en Suisse, des nouveaux frontaliers fiscaux : ces derniers paient 80% de l’impôt suisse à la source ordinaire et l’impôt italien avec crédit. La date d’embauche ne détermine pas seule le statut. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 "Quando si è considerati 'nuovo frontaliere'?": {
 en: {
 q: "When are you considered a 'new cross-border worker'?",
 a: "A new fiscal cross-border worker meets the treaty definition but does not qualify under Article 9. Old status depends on qualifying employment in Ticino, Graubünden or Valais between 31 December 2018 and 17 July 2023, not just when the contract was signed. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Wann gilt man als 'neuer Grenzgaenger'?",
 a: "Neue steuerliche Grenzgänger erfüllen die Abkommensdefinition, fallen aber nicht unter Artikel 9. Für den alten Status zählt eine qualifizierte Tätigkeit im Tessin, in Graubünden oder im Wallis zwischen dem 31. Dezember 2018 und dem 17. Juli 2023, nicht allein das Vertragsdatum. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Quand est-on considere comme 'nouveau frontalier' ?",
 a: "Un nouveau frontalier fiscal remplit la définition de l’accord sans relever de l’article 9. L’ancien statut dépend d’une activité qualifiée au Tessin, dans les Grisons ou en Valais entre le 31 décembre 2018 et le 17 juillet 2023, non de la seule date du contrat. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 "Come si calcola l'imposta alla fonte in Ticino nel 2026?": {
 en: {
 q: "How is the withholding tax calculated in Ticino in 2026?",
 a: "The Ticino withholding tax is applied by the employer using the cantonal schedule: A (single, no children), B (married, single-earner), C (married, dual-earner) and H (single-parent family). The rate depends on monthly gross income and ranges from about 2% (CHF 3,000/month) to 16% (above CHF 15,000/month). Each dependent child reduces the rate by about one percentage point."
 },
 de: {
 q: "Wie wird die Quellensteuer im Tessin 2026 berechnet?",
 a: "Die Tessiner Quellensteuer wird vom Arbeitgeber nach dem kantonalen Tarif angewendet: A (ledig, ohne Kinder), B (verheiratet, Einzelverdiener), C (verheiratet, Doppelverdiener) und H (Alleinerziehende). Der Satz haengt vom monatlichen Bruttoeinkommen ab und reicht von ca. 2% (CHF 3'000/Monat) bis 16% (ueber CHF 15'000/Monat). Jedes Kind reduziert den Satz um etwa einen Prozentpunkt."
 },
 fr: {
 q: "Comment l'impot a la source est-il calcule au Tessin en 2026 ?",
 a: "L'impot a la source tessinois est applique par l'employeur selon le bareme cantonal : A (celibataire, sans enfants), B (marie, revenu unique), C (marie, double revenu) et H (famille monoparentale). Le taux depend du revenu mensuel brut et varie d'environ 2% (CHF 3 000/mois) a 16% (au-dela de CHF 15 000/mois). Chaque enfant a charge reduit le taux d'environ un point de pourcentage."
 }
 },

 "Cosa cambia se vivo oltre 20 km dal confine svizzero?": {
 en: {
 q: "What changes if I live beyond 20 km from the Swiss border?",
 a: "Living outside the official 20 km municipality list falls outside the frontier tax agreement’s definition, but does not exclude an EU/EFTA G permit. Italy’s EUR 10,000 allowance has separate conditions for continuous, exclusive employment abroad in border areas or neighbouring countries; distance alone does not exclude it. https://documenti.camera.it/leg19/dossier/testi/FI0093.htm"
 },
 de: {
 q: "Was aendert sich, wenn ich weiter als 20 km von der Schweizer Grenze wohne?",
 a: "Wohnsitz ausserhalb der offiziellen 20-km-Gemeindeliste fällt nicht unter die steuerliche Grenzgängerdefinition, schliesst aber G EU/EFTA nicht aus. Der italienische Freibetrag von EUR 10.000 hat eigene Voraussetzungen für kontinuierliche, ausschliessliche Beschäftigung im Ausland in Grenzgebieten oder Nachbarstaaten; die Entfernung allein schliesst ihn nicht aus. https://documenti.camera.it/leg19/dossier/testi/FI0093.htm"
 },
 fr: {
 q: "Qu'est-ce qui change si j'habite au-dela de 20 km de la frontiere suisse ?",
 a: "Résider hors de la liste officielle des communes des 20 km exclut la définition fiscale de l’accord, mais pas le permis G UE/AELE. La franchise italienne de 10 000 EUR a ses propres conditions pour un emploi continu et exclusif à l’étranger en zone frontalière ou pays limitrophe ; la seule distance ne l’exclut pas. https://documenti.camera.it/leg19/dossier/testi/FI0093.htm"
 }
 },

 "I contributi AVS e LPP sono deducibili in Italia?": {
 en: {
 q: "Are AVS and LPP contributions deductible in Italy?",
 a: "Yes. Mandatory Swiss social security contributions AVS/AI/IPG (5.3%) and LPP (2nd pillar) withheld in Switzerland are deductible from the IRPEF taxable income of new cross-border workers when they file their Italian tax return, effectively lowering the Italian taxable base. Keep the annual Swiss salary certificate (Lohnausweis) for your accountant."
 },
 de: {
 q: "Sind AHV- und BVG-Beitraege in Italien abzugsfaehig?",
 a: "Ja. Die obligatorischen Schweizer Sozialversicherungsbeitraege AHV/IV/EO (5,3%) und BVG (2. Saeule), die in der Schweiz einbehalten werden, sind vom IRPEF-steuerpflichtigen Einkommen neuer Grenzgaenger in der italienischen Steuererklaerung abzugsfaehig und senken damit die italienische Bemessungsgrundlage. Bewahren Sie den jaehrlichen Schweizer Lohnausweis fuer Ihren Steuerberater auf."
 },
 fr: {
 q: "Les cotisations AVS et LPP sont-elles deductibles en Italie ?",
 a: "Oui. Les cotisations suisses obligatoires AVS/AI/APG (5,3%) et LPP (2e pilier) retenues en Suisse sont deductibles du revenu imposable IRPEF des nouveaux frontaliers dans la declaration fiscale italienne, ce qui reduit la base imposable italienne. Conservez le certificat de salaire annuel suisse (Lohnausweis) pour votre comptable."
 }
 },

 "Posso usare il simulatore anche se ho il Permesso B?": {
 en: {
 q: "Can I use the simulator even with a B permit?",
 a: "Yes. The payslip simulator computes social deductions (AVS, AD, AINF, IJM, LPP) and Ticino withholding tax: these are the same items on the payslip of a B-permit resident working in Ticino. However, with a B permit the special cross-border tax regime (Italian tax credit) does not apply: the CHF net is your actual net. For a G vs B tax comparison, use the dedicated comparator."
 },
 de: {
 q: "Kann ich den Simulator auch mit B-Ausweis nutzen?",
 a: "Ja. Der Lohnabrechnungs-Simulator berechnet die Sozialabzuege (AHV, ALV, UVG, IJM, BVG) und die Tessiner Quellensteuer: Dies sind die gleichen Positionen wie auf der Lohnabrechnung eines B-Ausweis-Inhabers, der im Tessin arbeitet. Mit B-Ausweis gilt jedoch nicht das Sonderregime fuer Grenzgaenger (italienische Steuergutschrift): Das CHF-Netto ist Ihr tatsaechliches Netto. Fuer einen G-vs-B-Vergleich verwenden Sie den speziellen Rechner."
 },
 fr: {
 q: "Puis-je utiliser le simulateur meme avec un permis B ?",
 a: "Oui. Le simulateur de fiche de paie calcule les deductions sociales (AVS, AC, AANP, IJM, LPP) et l'impot a la source tessinois : ce sont les memes rubriques qu'on trouve sur la fiche de paie d'un titulaire de permis B travaillant au Tessin. Toutefois, avec un permis B le regime fiscal special du frontalier (credit d'impot italien) ne s'applique pas : le net CHF est votre vrai net. Pour une comparaison fiscale G vs B, utilisez le comparateur dedie."
 }
 },

 "L'imposta alla fonte è definitiva o posso recuperare qualcosa con la TDR?": {
 en: {
 q: "Is the withholding tax final or can I recover part of it via the TDR?",
 a: "Do not confuse correction of an incorrect withholding with ordinary assessment allowing additional deductions. Ask the canton which procedure applies to your case. ESTV FAQ 5.3 excludes subsequent ordinary assessment (TOU) for fiscal frontier workers covered by the Italy–Switzerland agreement. Other categories must check eligibility and procedure with the tax authority. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Ist die Quellensteuer endgueltig oder kann ich ueber die TDR etwas zurueckholen?",
 a: "Die Korrektur einer falschen Quellensteuer darf nicht mit einer ordentlichen Veranlagung für zusätzliche Abzüge verwechselt werden. Das anwendbare Verfahren beim Kanton klären. Laut ESTV-FAQ 5.3 ist die nachträgliche ordentliche Veranlagung für steuerliche Grenzgänger des Abkommens Italien–Schweiz ausgeschlossen. Andere Kategorien müssen Voraussetzungen und Verfahren bei der Steuerbehörde prüfen. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "L'impot a la source est-il definitif ou puis-je recuperer une partie via la TDR ?",
 a: "Ne pas confondre correction d’une retenue erronée et taxation ordinaire permettant d’autres déductions. Demander au canton quelle procédure s’applique. La FAQ 5.3 de l’AFC exclut la taxation ordinaire ultérieure pour les frontaliers fiscaux de l’accord Italie–Suisse. Les autres catégories doivent vérifier les conditions et la procédure auprès de l’autorité fiscale. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 "Il simulatore include la tredicesima e gli assegni familiari?": {
 en: {
 q: "Does the simulator include the 13th month and family allowances?",
 a: "The annual gross salary entered already includes the 13th month (divided by 13 to get the monthly gross). Cantonal family allowances (approximately CHF 200-300 per month per child in Ticino) are not included in the simulation because they are not subject to social deductions and withholding tax: add them to the net computed."
 },
 de: {
 q: "Beinhaltet der Simulator den 13. Monatslohn und die Familienzulagen?",
 a: "Das eingegebene Bruttojahresgehalt enthaelt bereits den 13. Monatslohn (durch 13 geteilt, um das Monatsbrutto zu erhalten). Die kantonalen Familienzulagen (ca. CHF 200-300 pro Monat und Kind im Tessin) sind in der Simulation nicht enthalten, da sie nicht den Sozialabzuegen und der Quellensteuer unterliegen: Addieren Sie sie zum berechneten Netto."
 },
 fr: {
 q: "Le simulateur inclut-il le 13e mois et les allocations familiales ?",
 a: "Le salaire brut annuel saisi inclut deja le 13e mois (divise par 13 pour obtenir le brut mensuel). Les allocations familiales cantonales (environ CHF 200-300 par mois et par enfant au Tessin) ne sont pas incluses dans la simulation car elles ne sont pas soumises aux cotisations sociales ni a l'impot a la source : ajoutez-les au net calcule."
 }
 },
 // ── New coverage: seo-pages.ts (tax/cost/stats/jobs/13th/maternity/comparison) ──
 "Come si calcolano le tasse per i nuovi frontalieri 2026?": {
 en: {
 q: "How are taxes calculated for new cross-border workers in 2026?",
 a: "The calculation follows three steps: first, Swiss social contributions are deducted (AVS 5.3%, unemployment insurance 1.1%, BVG based on age), then the cantonal withholding tax is applied at 80% of the ordinary rate under table A/B/C/H, finally Italian IRPEF is calculated on the EUR-converted income minus the €10,000 exemption, with a tax credit for taxes already paid in Switzerland."
 },
 de: {
 q: "Wie werden die Steuern fuer neue Grenzgaenger 2026 berechnet?",
 a: "Die Berechnung erfolgt in drei Schritten: zuerst werden die Schweizer Sozialabgaben abgezogen (AHV 5,3 %, ALV 1,1 %, BVG je nach Alter), dann wird die kantonale Quellensteuer zu 80 % des ordentlichen Tarifs nach Tabelle A/B/C/H angewandt, zum Schluss wird die italienische IRPEF auf das in EUR umgerechnete Einkommen abzueglich des Freibetrags von 10.000 EUR berechnet, unter Anrechnung der in der Schweiz bereits gezahlten Steuern."
 },
 fr: {
 q: "Comment sont calculees les impots pour les nouveaux frontaliers en 2026 ?",
 a: "Le calcul suit trois etapes : d'abord les cotisations sociales suisses sont deduites (AVS 5,3 %, AC 1,1 %, LPP selon l'age), puis l'impot a la source cantonal est applique a 80 % du taux ordinaire selon le bareme A/B/C/H, enfin l'IRPEF italien est calcule sur le revenu converti en EUR diminue de la franchise de 10 000 EUR, avec un credit d'impot pour les impots deja payes en Suisse."
 }
 },

 "Qual è la franchigia per nuovi frontalieri?": {
 en: {
 q: "What is the exemption amount for new cross-border workers?",
 a: "Italian law excludes the first €10,000 a year of qualifying employment income earned abroad in border areas or neighbouring countries, continuously and as the exclusive object of the employment relationship, by Italian residents. Eligibility does not depend solely on hire date or the 20 km municipality zone. Salary covered by Article 9 for old workers instead benefits from the regime’s Italian exemption. https://documenti.camera.it/leg19/dossier/testi/FI0093.htm"
 },
 de: {
 q: "Wie hoch ist der Freibetrag fuer neue Grenzgaenger?",
 a: "Das italienische Recht nimmt jährlich die ersten 10.000 € qualifizierender Einkünfte italienischer Einwohner aus kontinuierlicher unselbständiger Arbeit im Ausland in Grenzgebieten oder Nachbarstaaten aus der Bemessungsgrundlage aus, sofern diese ausschliesslicher Gegenstand des Arbeitsverhältnisses ist. Nicht allein Einstellungsdatum oder 20-km-Gemeindezone entscheiden. Für den Lohn alter Grenzgänger nach Artikel 9 gilt dagegen die italienische Befreiung dieses Regimes. https://documenti.camera.it/leg19/dossier/testi/FI0093.htm"
 },
 fr: {
 q: "Quelle est la franchise pour les nouveaux frontaliers ?",
 a: "La loi italienne exclut de l’assiette les premiers 10.000 € annuels des revenus admissibles de travail salarié exercé à l’étranger, dans les zones frontalières ou les pays limitrophes, de façon continue et comme objet exclusif du rapport de travail, par des résidents italiens. Ni la seule date d’embauche ni la zone des communes à 20 km ne déterminent ce droit. Le salaire des anciens couvert par l’article 9 bénéficie plutôt de l’exonération italienne de ce régime. https://documenti.camera.it/leg19/dossier/testi/FI0093.htm"
 }
 },

 "Differenza tra vecchi e nuovi frontalieri per le tasse?": {
 en: {
 q: "What is the tax difference between old and new cross-border workers?",
 a: "For eligible old workers under Article 9, the covered salary is taxable only in Switzerland. For new tax cross-border workers, Switzerland levies 80% of ordinary withholding tax and Italy taxes the income with credit for Swiss tax. Qualifying employment between 31 December 2018 and 17 July 2023, residence and return requirements distinguish status: calculate the net difference for the individual case. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Was ist der steuerliche Unterschied zwischen alten und neuen Grenzgaengern?",
 a: "Bei qualifizierten alten Grenzgängern nach Artikel 9 ist der erfasste Lohn nur in der Schweiz steuerpflichtig. Bei neuen steuerlichen Grenzgängern erhebt die Schweiz 80% der ordentlichen Quellensteuer; Italien besteuert mit Anrechnung. Qualifizierende Beschäftigung zwischen dem 31. Dezember 2018 und dem 17. Juli 2023, Wohnsitz und Rückkehr bestimmen den Status. Die Nettodifferenz ist individuell zu berechnen. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Quelle est la difference fiscale entre anciens et nouveaux frontaliers ?",
 a: "Pour les anciens admissibles selon l’article 9, le salaire couvert est imposable uniquement en Suisse. Pour les nouveaux frontaliers fiscaux, la Suisse prélève 80% de l’impôt à la source ordinaire et l’Italie impose avec crédit de l’impôt suisse. L’activité admissible entre le 31 décembre 2018 et le 17 juillet 2023, la résidence et le retour déterminent le statut : la différence nette se calcule individuellement. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 "Conviene vivere in Svizzera o in Italia come frontaliere?": {
 en: {
 q: "Is it better to live in Switzerland or Italy as a cross-border worker?",
 a: "It depends on priorities: living in Switzerland (B permit) means no commuting, Swiss services and no double taxation, but living costs 40–60% higher. Living in Italy (G permit) cuts fixed costs by 30–45%, preserves access to the Italian SSN healthcare and Italian public schools, but adds 1–2 hours of daily commuting and the fiscal complexity of the 2026 New Agreement."
 },
 de: {
 q: "Lohnt es sich, als Grenzgaenger in der Schweiz oder in Italien zu wohnen?",
 a: "Das haengt von den Prioritaeten ab: Wohnen in der Schweiz (Bewilligung B) bedeutet kein Pendeln, Schweizer Dienstleistungen und keine Doppelbesteuerung, jedoch 40–60 % hoehere Lebenshaltungskosten. Wohnen in Italien (Bewilligung G) senkt die Fixkosten um 30–45 %, erhaelt den Zugang zum italienischen Gesundheitssystem SSN und zu oeffentlichen Schulen in Italien, bringt aber 1–2 Stunden taegliches Pendeln und die steuerliche Komplexitaet des Neuen Abkommens 2026 mit sich."
 },
 fr: {
 q: "Vaut-il mieux vivre en Suisse ou en Italie comme frontalier ?",
 a: "Cela depend des priorites : vivre en Suisse (permis B) evite les trajets, offre les services suisses et evite la double imposition, mais le cout de la vie est 40–60 % plus eleve. Vivre en Italie (permis G) reduit les couts fixes de 30–45 %, conserve l'acces au SSN italien et aux ecoles publiques italiennes, mais ajoute 1–2 heures de trajet quotidien et la complexite fiscale du Nouvel Accord 2026."
 }
 },

 "Quali sono i migliori comuni italiani per frontalieri?": {
 en: {
 q: "Which are the best Italian municipalities for cross-border workers?",
 a: "The most popular municipalities are those within 20 km of the Swiss border in the provinces of Como, Varese and Verbano-Cusio-Ossola. Towns such as Cantu, Olgiate Comasco, Luino, Lavena Ponte Tresa and Ponte Tresa offer good transport links, affordable costs and family services. The ranking varies based on the border crossing used and the workplace in Ticino."
 },
 de: {
 q: "Welche sind die besten italienischen Gemeinden fuer Grenzgaenger?",
 a: "Die beliebtesten Gemeinden liegen innerhalb von 20 km zur Schweizer Grenze in den Provinzen Como, Varese und Verbano-Cusio-Ossola. Orte wie Cantu, Olgiate Comasco, Luino, Lavena Ponte Tresa und Ponte Tresa bieten gute Verkehrsanbindungen, moderate Kosten und Familienangebote. Das Ranking variiert je nach Grenzuebergang und Arbeitsort im Tessin."
 },
 fr: {
 q: "Quelles sont les meilleures communes italiennes pour les frontaliers ?",
 a: "Les communes les plus choisies se trouvent dans un rayon de 20 km de la frontiere suisse, dans les provinces de Come, Varese et Verbano-Cusio-Ossola. Des villes comme Cantu, Olgiate Comasco, Luino, Lavena Ponte Tresa et Ponte Tresa offrent de bonnes liaisons, des couts maitrises et des services pour les familles. Le classement varie selon le poste-frontiere utilise et le lieu de travail au Tessin."
 }
 },

 "Quanto costa il pendolarismo da frontaliere?": {
 en: {
 q: "How much does cross-border commuting cost?",
 a: "The average commuting cost ranges from CHF 200–400/month by car (fuel + motorway + parking) to CHF 100–250/month by public transport (TILO/FerrovieNord season pass). Average travel time is 45–90 minutes each way, with peaks during rush hour at the main crossings (Chiasso, Stabio, Gaggiolo)."
 },
 de: {
 q: "Wie viel kostet das Pendeln als Grenzgaenger?",
 a: "Die durchschnittlichen Pendelkosten liegen zwischen CHF 200–400/Monat mit dem Auto (Benzin + Autobahn + Parkplatz) und CHF 100–250/Monat mit oeffentlichen Verkehrsmitteln (TILO/FerrovieNord-Abo). Die durchschnittliche Fahrzeit betraegt 45–90 Minuten pro Weg, mit Spitzen in den Stosszeiten an den Hauptgrenzuebergaengen (Chiasso, Stabio, Gaggiolo)."
 },
 fr: {
 q: "Combien coute le trajet domicile-travail pour un frontalier ?",
 a: "Le cout moyen des trajets varie de CHF 200–400/mois en voiture (carburant + autoroute + parking) a CHF 100–250/mois en transports publics (abonnement TILO/FerrovieNord). La duree moyenne du trajet est de 45–90 minutes par sens, avec des pics aux heures de pointe aux principaux postes-frontieres (Chiasso, Stabio, Gaggiolo)."
 }
 },

 "Come funziona l'assicurazione sanitaria per i frontalieri?": {
 en: {
 q: "How does health insurance work for cross-border workers?",
 a: "Cross-border workers with a G permit have the right of option: they can choose Swiss LAMal (premiums from CHF 300–500/month) or the Italian SSN (much lower INPS contributions). The choice must be made within 3 months of starting work and cannot be changed freely; any new entitlement must be checked with the canton of employment. The SSN is cheaper but only covers Italy; LAMal covers the whole of Switzerland."
 },
 de: {
 q: "Wie funktioniert die Krankenversicherung fuer Grenzgaenger?",
 a: "Grenzgaenger mit Bewilligung G haben das Optionsrecht: sie koennen zwischen der Schweizer KVG (LAMal) waehlen (Praemien ab CHF 300–500/Monat) oder dem italienischen SSN (deutlich niedrigere INPS-Beitraege). Die Wahl muss innerhalb von 3 Monaten nach Arbeitsaufnahme erfolgen und kann nicht frei geändert werden; neue Umstände sind mit dem Arbeitskanton zu prüfen. Der SSN ist guenstiger, deckt aber nur Italien ab; die LAMal deckt die gesamte Schweiz ab."
 },
 fr: {
 q: "Comment fonctionne l'assurance maladie pour les frontaliers ?",
 a: "Les frontaliers avec permis G disposent du droit d'option : ils peuvent choisir la LAMal suisse (primes de CHF 300–500/mois) ou le SSN italien (cotisations INPS bien inferieures). Le choix doit etre fait dans les 3 mois suivant le debut du travail et ne peut pas être modifié librement ; les nouveaux événements sont à vérifier auprès du canton de travail. Le SSN est moins cher mais ne couvre que l'Italie ; la LAMal couvre toute la Suisse."
 }
 },

 "Quanti frontalieri lavorano in Canton Ticino nel 2026?": {
 en: {
 q: "How many cross-border workers work in Canton Ticino in 2026?",
 a: "About 79,000 cross-border workers commute daily from Italy to Canton Ticino (BFS 2025 data). Ticino is the canton with the highest concentration of cross-border workers, around 30% of the cantonal workforce."
 },
 de: {
 q: "Wie viele Grenzgaenger arbeiten 2026 im Kanton Tessin?",
 a: "Rund 79.000 Grenzgaenger pendeln taeglich aus Italien in den Kanton Tessin (Daten BFS 2025). Das Tessin ist der Kanton mit der hoechsten Grenzgaengerdichte, rund 30 % der kantonalen Erwerbsbevoelkerung."
 },
 fr: {
 q: "Combien de frontaliers travaillent dans le canton du Tessin en 2026 ?",
 a: "Environ 79 000 travailleurs frontaliers font quotidiennement la navette depuis l'Italie vers le canton du Tessin (donnees OFS 2025). Le Tessin est le canton avec la plus forte concentration de frontaliers, environ 30 % de la main-d'oeuvre cantonale."
 }
 },

 "Quali settori offrono più lavoro in Ticino?": {
 en: {
 q: "Which sectors offer the most jobs in Ticino?",
 a: "The sectors with the most active openings on the job board are: IT and software development, mechanical and electrical engineering, healthcare and pharma, finance and banking, and construction. IT has seen the biggest growth over the past 12 months."
 },
 de: {
 q: "Welche Branchen bieten im Tessin die meisten Stellen?",
 a: "Die Branchen mit den meisten aktiven Stellen im Job-Board sind: IT und Softwareentwicklung, Maschinen- und Elektrotechnik, Gesundheitswesen und Pharma, Finanz und Banking sowie Baugewerbe. Die IT-Branche verzeichnete in den letzten 12 Monaten das groesste Wachstum."
 },
 fr: {
 q: "Quels secteurs offrent le plus d'emplois au Tessin ?",
 a: "Les secteurs avec le plus d'offres actives sur la plateforme sont : IT et developpement logiciel, ingenierie mecanique et electrotechnique, sante et pharma, finance et banque, et construction. Le secteur IT a connu la plus forte croissance au cours des 12 derniers mois."
 }
 },

 "Come vengono calcolate le statistiche degli stipendi?": {
 en: {
 q: "How are the salary statistics calculated?",
 a: "Salary statistics combine official BFS data (Swiss Earnings Structure Survey) with salary ranges published in job board listings. Medians and ranges are calculated by sector, role and seniority level."
 },
 de: {
 q: "Wie werden die Lohnstatistiken berechnet?",
 a: "Die Lohnstatistiken kombinieren offizielle BFS-Daten (Schweizerische Lohnstrukturerhebung) mit Lohnspannen aus den Stellenanzeigen des Job-Boards. Mediane und Spannbreiten werden nach Branche, Funktion und Erfahrungsstufe berechnet."
 },
 fr: {
 q: "Comment les statistiques salariales sont-elles calculees ?",
 a: "Les statistiques salariales combinent les donnees officielles de l'OFS (Enquete suisse sur la structure des salaires) avec les fourchettes publiees dans les annonces de la plateforme. Les medianes et fourchettes sont calculees par secteur, fonction et niveau d'experience."
 }
 },

 "Con quale frequenza vengono aggiornati i dati?": {
 en: {
 q: "How often is the data updated?",
 a: "The job-board observatory is updated twice a day with new listings. BFS data on cross-border workers is updated quarterly. Fuel prices are updated hourly. The SECO unemployment rate is updated monthly."
 },
 de: {
 q: "Wie oft werden die Daten aktualisiert?",
 a: "Das Job-Board-Observatorium wird zweimal taeglich mit neuen Stellen aktualisiert. Die BFS-Daten zu Grenzgaengern werden vierteljaehrlich aktualisiert. Die Treibstoffpreise werden stuendlich aktualisiert. Die Arbeitslosenquote des SECO wird monatlich aktualisiert."
 },
 fr: {
 q: "A quelle frequence les donnees sont-elles mises a jour ?",
 a: "L'observatoire de la plateforme emploi est mis a jour deux fois par jour avec les nouvelles offres. Les donnees OFS sur les frontaliers sont mises a jour trimestriellement. Les prix des carburants sont mis a jour toutes les heures. Le taux de chomage du SECO est mis a jour mensuellement."
 }
 },

 "Quanto costa vivere in Svizzera rispetto all'Italia?": {
 en: {
 q: "How much does it cost to live in Switzerland compared to Italy?",
 a: "The cost of living in Switzerland is on average 40–60% higher than in Italy. Rent, groceries and LAMal health insurance show the biggest gaps. A two-room flat in Lugano costs around CHF 1,400–1,800/month versus €500–800 in Como."
 },
 de: {
 q: "Was kostet das Leben in der Schweiz im Vergleich zu Italien?",
 a: "Die Lebenshaltungskosten in der Schweiz sind im Schnitt 40–60 % hoeher als in Italien. Mieten, Lebensmittel und Krankenversicherung (LAMal) weisen die groessten Unterschiede auf. Eine Zweizimmerwohnung in Lugano kostet rund CHF 1.400–1.800/Monat, in Como 500–800 EUR."
 },
 fr: {
 q: "Quel est le cout de la vie en Suisse par rapport a l'Italie ?",
 a: "Le cout de la vie en Suisse est en moyenne 40–60 % plus eleve qu'en Italie. Les loyers, l'alimentation et l'assurance maladie (LAMal) presentent les ecarts les plus importants. Un deux-pieces a Lugano coute environ CHF 1 400–1 800/mois contre 500–800 EUR a Come."
 }
 },

 "Conviene vivere in Italia e lavorare in Svizzera?": {
 en: {
 q: "Is it worth living in Italy and working in Switzerland?",
 a: "For many cross-border workers yes: the Swiss salary combined with the Italian cost of living allows a higher net saving, especially on rent and groceries. However, you should factor in transport costs, travel time and the applicable tax regime."
 },
 de: {
 q: "Lohnt es sich, in Italien zu wohnen und in der Schweiz zu arbeiten?",
 a: "Fuer viele Grenzgaenger ja: Der Schweizer Lohn in Verbindung mit den italienischen Lebenshaltungskosten ermoeglicht eine hoehere Nettoersparnis, insbesondere bei Miete und Lebensmitteln. Zu beruecksichtigen sind jedoch Transportkosten, Fahrzeiten und das geltende Steuerregime."
 },
 fr: {
 q: "Vaut-il la peine de vivre en Italie et de travailler en Suisse ?",
 a: "Pour beaucoup de frontaliers, oui : le salaire suisse combine au cout de la vie italien permet une epargne nette plus elevee, en particulier sur le loyer et les courses. Il faut cependant considerer les frais de transport, le temps de trajet et le regime fiscal applicable."
 }
 },

 "Quali sono le città più economiche vicino al confine svizzero?": {
 en: {
 q: "Which are the cheapest cities near the Swiss border?",
 a: "Among Italian border towns, Varese and parts of the Como province offer moderate costs with good links to Ticino. On the Swiss side, Mendrisio and Chiasso are slightly cheaper than Lugano."
 },
 de: {
 q: "Welches sind die guenstigsten Staedte in Grenznaehe zur Schweiz?",
 a: "Auf italienischer Seite bieten Varese und Teile der Provinz Como moderate Kosten bei guter Anbindung ans Tessin. Auf Schweizer Seite sind Mendrisio und Chiasso etwas guenstiger als Lugano."
 },
 fr: {
 q: "Quelles sont les villes les plus abordables pres de la frontiere suisse ?",
 a: "Cote italien, Varese et les zones de la province de Come offrent des couts contenus avec de bonnes liaisons vers le Tessin. Cote suisse, Mendrisio et Chiasso sont legerement moins chers que Lugano."
 }
 },

 "Qual è la differenza tra RAL italiana e salario lordo svizzero?": {
 en: {
 q: "What is the difference between the Italian RAL and the Swiss gross salary?",
 a: "The Italian RAL (Retribuzione Annua Lorda) is the total gross before taxes and employee social contributions. The Swiss equivalent is the annual gross salary (Bruttolohn), but the composition differs: INPS (9.19% employee) and IRPEF are replaced by AVS (5.3%), unemployment insurance (1.1%), BVG (variable by age) and withholding tax. At an equivalent RAL of CHF 80,000, the Swiss net is typically 25–35% higher."
 },
 de: {
 q: "Was ist der Unterschied zwischen italienischem RAL und Schweizer Bruttolohn?",
 a: "Der italienische RAL (Retribuzione Annua Lorda) ist der Gesamtbrutto vor Steuern und Arbeitnehmer-Sozialbeitraegen. In der Schweiz entspricht dies dem jaehrlichen Bruttolohn, die Zusammensetzung ist jedoch anders: INPS (9,19 % Arbeitnehmer) und IRPEF werden durch AHV (5,3 %), ALV (1,1 %), BVG (altersabhaengig) und Quellensteuer ersetzt. Bei vergleichbarem RAL von CHF 80.000 ist der Schweizer Nettolohn typischerweise 25–35 % hoeher."
 },
 fr: {
 q: "Quelle est la difference entre le RAL italien et le salaire brut suisse ?",
 a: "Le RAL italien (Retribuzione Annua Lorda) est le brut total avant impots et cotisations sociales salarie. En Suisse, l'equivalent est le salaire brut annuel (Bruttolohn), mais la composition differe : l'INPS (9,19 % salarie) et l'IRPEF sont remplaces par l'AVS (5,3 %), l'AC (1,1 %), la LPP (variable selon l'age) et l'impot a la source. A RAL equivalent de CHF 80 000, le net suisse est typiquement 25–35 % plus eleve."
 }
 },

 "Come si confronta il netto tra Italia e Svizzera?": {
 en: {
 q: "How do you compare net pay between Italy and Switzerland?",
 a: "A proper comparison considers: 1) RAL in local currency (EUR in Italy, CHF in Switzerland), 2) mandatory social contributions, 3) taxes (IRPEF + regional surcharges in Italy, withholding tax in Switzerland), 4) cost of living. A cross-border worker with CHF 70,000 gross/year has about CHF 4,600/month net; the same professional in Milan with a €45,000 RAL earns about €2,300/month net. The actual gap also depends on rent, transport and insurance."
 },
 de: {
 q: "Wie vergleicht man den Nettolohn zwischen Italien und der Schweiz?",
 a: "Ein korrekter Vergleich beruecksichtigt: 1) RAL in Landeswaehrung (EUR in Italien, CHF in der Schweiz), 2) obligatorische Sozialbeitraege, 3) Steuern (IRPEF + Regional- und Gemeindeaufschlaege in Italien, Quellensteuer in der Schweiz), 4) Lebenshaltungskosten. Ein Grenzgaenger mit CHF 70.000 brutto/Jahr hat rund CHF 4.600/Monat netto; derselbe Berufstaetige in Mailand mit 45.000 EUR RAL hat rund 2.300 EUR/Monat netto. Die tatsaechliche Differenz haengt auch von Miete, Transport und Versicherung ab."
 },
 fr: {
 q: "Comment comparer le net entre l'Italie et la Suisse ?",
 a: "Une comparaison correcte prend en compte : 1) le RAL en monnaie locale (EUR en Italie, CHF en Suisse), 2) les cotisations sociales obligatoires, 3) les impots (IRPEF + additionnelles en Italie, impot a la source en Suisse), 4) le cout de la vie. Un frontalier avec CHF 70 000 brut/an a environ CHF 4 600/mois net ; le meme professionnel a Milan avec 45 000 EUR de RAL a environ 2 300 EUR/mois net. L'ecart reel depend aussi du loyer, du transport et de l'assurance."
 }
 },

 "Per un nuovo frontaliere, il confronto cambia?": {
 en: {
 q: "Does the comparison change for a new cross-border worker?",
 a: "Yes. Comparing Italian and Swiss pay requires Italian tax with credit for Swiss taxes as well as contributions and Swiss tax. A new tax cross-border worker pays 80% of ordinary Swiss withholding tax. Allowances, deductions, exchange rates and commuting costs affect net pay: status alone does not imply a fixed percentage advantage. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Aendert sich der Vergleich fuer einen neuen Grenzgaenger?",
 a: "Ja. Beim Vergleich italienischer und Schweizer Löhne sind neben Beiträgen und Schweizer Steuer auch italienische Steuer und Anrechnung der Schweizer Steuer einzubeziehen. Ein neuer steuerlicher Grenzgänger zahlt 80% der ordentlichen Schweizer Quellensteuer. Freibeträge, Abzüge, Wechselkurs und Pendelkosten beeinflussen das Netto: Aus dem Status allein folgt kein fester prozentualer Vorteil. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "La comparaison change-t-elle pour un nouveau frontalier ?",
 a: "Oui. Comparer les salaires italiens et suisses exige de tenir compte de l’impôt italien avec crédit pour l’impôt suisse, en plus des cotisations et de l’impôt suisse. Un nouveau frontalier fiscal paie 80% de l’impôt suisse à la source ordinaire. Franchise, déductions, change et trajets influencent le net : le seul statut ne garantit pas un avantage en pourcentage fixe. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 "Il 13° stipendio è incluso nella RAL?": {
 en: {
 q: "Is the 13th-month salary included in the RAL?",
 a: "In Italy yes: the RAL typically includes the 13th month (and the 14th where the national collective agreement provides for it). In Switzerland the 13th month is not required by law but is usually contractual: the contract may state 12 months plus a 13th (total package) or an explicit 13 months. Always check the contract and the sector CLA: the difference between 12 and 13 months is worth about CHF 5,000–7,000/year."
 },
 de: {
 q: "Ist der 13. Monatslohn im RAL enthalten?",
 a: "In Italien ja: Der RAL umfasst in der Regel den 13. Monatslohn (und den 14., wo der Kollektivvertrag ihn vorsieht). In der Schweiz ist der 13. Monatslohn gesetzlich nicht vorgeschrieben, aber in der Regel vertraglich geregelt: Der Vertrag kann 12 Monate plus 13. (Gesamtpaket) oder explizit 13 Monate nennen. Immer Vertrag und Branchen-GAV pruefen: Der Unterschied zwischen 12 und 13 Monatsloehnen betraegt rund CHF 5.000–7.000/Jahr."
 },
 fr: {
 q: "Le 13e salaire est-il inclus dans le RAL ?",
 a: "En Italie, oui : le RAL inclut generalement la 13e (et la 14e lorsque la convention collective la prevoit). En Suisse, le 13e mois n'est pas obligatoire par la loi mais est generalement contractuel : le contrat peut indiquer 12 mois plus un 13e (package global) ou explicitement 13 mois. Toujours verifier le contrat et la CCT sectorielle : la difference entre 12 et 13 mois represente environ CHF 5 000–7 000/an."
 }
 },

 "Come incide il comune di residenza italiana sul confronto?": {
 en: {
 q: "How does the Italian municipality of residence affect the comparison?",
 a: "For new cross-border workers, the Italian municipality of residence determines the municipal IRPEF surcharge (0–0.9%) and indirectly other local taxes (IMU, TARI, TASI). A cross-border worker resident in Como (0.8% surcharge) pays hundreds of euros more than a resident in a municipality where the surcharge has been zeroed out by tax rebates. The simulator includes data for the main border municipalities for an accurate comparison."
 },
 de: {
 q: "Wie wirkt sich die italienische Wohnsitzgemeinde auf den Vergleich aus?",
 a: "Fuer neue Grenzgaenger bestimmt die italienische Wohnsitzgemeinde den kommunalen IRPEF-Zuschlag (0–0,9 %) und indirekt weitere lokale Abgaben (IMU, TARI, TASI). Ein Grenzgaenger mit Wohnsitz in Como (Zuschlag 0,8 %) zahlt Hunderte Euro mehr als ein Einwohner einer Gemeinde mit dank Steuerrueckverguetungen auf null gesetztem Zuschlag. Der Simulator enthaelt Daten zu den wichtigsten Grenzgemeinden fuer einen praezisen Vergleich."
 },
 fr: {
 q: "Comment la commune italienne de residence influence-t-elle la comparaison ?",
 a: "Pour les nouveaux frontaliers, la commune italienne de residence determine l'additionnelle communale IRPEF (0–0,9 %) et indirectement d'autres taxes locales (IMU, TARI, TASI). Un frontalier resident a Come (additionnelle 0,8 %) paie des centaines d'euros de plus qu'un resident d'une commune dont l'additionnelle est ramenee a zero grace aux ristournes fiscales. Le simulateur inclut les donnees des principales communes frontalieres pour une comparaison precise."
 }
 },

 "Come si usa il confronto RAL per una trattativa salariale?": {
 en: {
 q: "How do you use the RAL comparison in a salary negotiation?",
 a: "Simulate the monthly net in euros with your current gross and the one proposed by the Swiss employer. Add the extra costs of cross-border work: LAMal or SSN, commuting, fuel, time spent commuting. Ask for a Swiss RAL increase that covers at least 120% of the differential (safety margin). A precise comparison prevents emotional decisions: many people think they earn double, but the actual net advantage is often 30–60%."
 },
 de: {
 q: "Wie verwendet man den RAL-Vergleich in einer Gehaltsverhandlung?",
 a: "Simulieren Sie den monatlichen Nettolohn in Euro mit Ihrem aktuellen Brutto und dem vom Schweizer Arbeitgeber vorgeschlagenen. Addieren Sie die Zusatzkosten des Grenzgaengerdaseins: LAMal oder SSN, Pendlerkosten, Benzin, Pendelzeit. Fordern Sie eine Schweizer RAL-Erhoehung, die mindestens 120 % der Differenz abdeckt (Sicherheitsmarge). Ein praeziser Vergleich verhindert emotionale Entscheidungen: viele glauben, das Doppelte zu verdienen, doch der reale Nettovorteil liegt oft bei 30–60 %."
 },
 fr: {
 q: "Comment utiliser la comparaison RAL dans une negociation salariale ?",
 a: "Simulez le net mensuel en euros avec votre brut actuel et celui propose par l'employeur suisse. Ajoutez les couts supplementaires du frontalierat : LAMal ou SSN, transport domicile-travail, carburant, temps de trajet. Demandez une augmentation du RAL suisse couvrant au moins 120 % du differentiel (marge de securite). Une comparaison precise evite les decisions emotionnelles : beaucoup pensent gagner le double, mais l'avantage net reel est souvent de 30–60 %."
 }
 },

 "Quale congedo maternità spetta a una frontaliera in Svizzera?": {
 en: {
 q: "What maternity leave is a female cross-border worker entitled to in Switzerland?",
 a: "A female cross-border worker with a Swiss contract is entitled to federal APG (loss-of-earnings allowance): 14 weeks of maternity leave at 80% of salary (max CHF 220/day, about CHF 6,600/month). It starts on the day of childbirth. Some Ticino collective agreements improve coverage to 100% of the first few weeks. The leave can only be extended via an unpaid company agreement."
 },
 de: {
 q: "Welchen Mutterschaftsurlaub hat eine Grenzgaengerin in der Schweiz?",
 a: "Die Grenzgaengerin mit Schweizer Arbeitsvertrag hat Anspruch auf die bundesrechtliche EO (Erwerbsersatzordnung): 14 Wochen Mutterschaftsurlaub zu 80 % des Lohnes (max. CHF 220/Tag, rund CHF 6.600/Monat). Beginn am Tag der Geburt. Einige Tessiner GAV verbessern die Deckung auf 100 % in den ersten Wochen. Eine Verlaengerung ist nur per unbezahltem Betriebsvereinbarung moeglich."
 },
 fr: {
 q: "A quel conge maternite une frontaliere a-t-elle droit en Suisse ?",
 a: "La frontaliere avec contrat suisse a droit a l'APG federale (allocation pour perte de gain) : 14 semaines de maternite a 80 % du salaire (max CHF 220/jour, environ CHF 6 600/mois). Debut au jour de l'accouchement. Certaines CCT tessinoises ameliorent la couverture a 100 % pour les premieres semaines. Le conge ne peut etre prolonge que via un accord d'entreprise non remunere."
 }
 },

 "La frontaliera riceve anche qualcosa dall'INPS italiano?": {
 en: {
 q: "Does the female cross-border worker also receive anything from the Italian INPS?",
 a: "No for compulsory maternity leave: the lex loci laboris applies, so the Swiss system is used. Italian INPS only intervenes if the cross-border worker is unemployed (at birth) or at the end of the Swiss leave during the optional parental leave period. Some mothers may combine mixed allowances if they also work part-time in Italy: a patronato check is required."
 },
 de: {
 q: "Erhaelt die Grenzgaengerin auch etwas von der italienischen INPS?",
 a: "Nein, nicht fuer den obligatorischen Mutterschaftsurlaub: Es gilt die lex loci laboris, daher kommt das Schweizer System zur Anwendung. Die italienische INPS tritt nur ein, wenn die Grenzgaengerin zum Zeitpunkt der Geburt arbeitslos ist oder nach Ende des Schweizer Urlaubs waehrend der fakultativen Elternzeit. Einige Muetter koennen Mischleistungen kumulieren, wenn sie auch in Italien Teilzeit arbeiten: eine Pruefung durch ein Patronat ist noetig."
 },
 fr: {
 q: "La frontaliere recoit-elle aussi quelque chose de l'INPS italien ?",
 a: "Non pour le conge maternite obligatoire : c'est la lex loci laboris qui s'applique, donc le systeme suisse est utilise. L'INPS italien intervient uniquement si la frontaliere est au chomage (au moment de l'accouchement) ou apres le conge suisse pendant la periode de conge parental facultatif. Certaines meres peuvent cumuler des indemnites mixtes si elles travaillent aussi a temps partiel en Italie : verification avec un patronato indispensable."
 }
 },

 "Quanto dura il congedo di paternità in Svizzera per frontalieri?": {
 en: {
 q: "How long is paternity leave in Switzerland for cross-border workers?",
 a: "Since 2021, a cross-border father has been entitled to 2 weeks (10 working days) of paternity leave at 80% of salary through federal APG, to be taken within 6 months of birth. The leave is much shorter than the Italian version (10 Swiss days vs. 10 Italian days plus 6 months of optional parental leave at 30%). Some collective agreements improve it to 3–4 weeks."
 },
 de: {
 q: "Wie lange dauert der Vaterschaftsurlaub fuer Grenzgaenger in der Schweiz?",
 a: "Seit 2021 hat der Grenzgaenger-Vater Anspruch auf 2 Wochen (10 Arbeitstage) Vaterschaftsurlaub zu 80 % des Lohnes ueber die bundesrechtliche EO, zu beziehen innerhalb von 6 Monaten nach der Geburt. Der Urlaub ist deutlich kuerzer als der italienische (10 Tage Schweiz gegenueber 10 Tage Italien + fakultativem 6-monatigem Elternurlaub zu 30 %). Einige GAV verbessern ihn auf 3–4 Wochen."
 },
 fr: {
 q: "Quelle est la duree du conge paternite en Suisse pour les frontaliers ?",
 a: "Depuis 2021, le pere frontalier a droit a 2 semaines (10 jours ouvres) de conge paternite a 80 % du salaire via l'APG federale, a prendre dans les 6 mois suivant la naissance. Le conge est beaucoup plus court que celui italien (10 jours suisses contre 10 jours italiens + conge parental facultatif de 6 mois a 30 %). Certaines CCT l'ameliorent a 3–4 semaines."
 }
 },

 "Posso estendere il congedo con la normativa italiana?": {
 en: {
 q: "Can I extend the leave under Italian rules?",
 a: "Italian parental leave (up to 10 months combinable between parents, 30% INPS allowance for the first 6 months, optional) does not apply to cross-border workers because of the lex loci laboris. However, some Swiss companies grant unpaid company parental leave of up to 12 months. The choice between returning to work and extending leave is an individual economic decision."
 },
 de: {
 q: "Kann ich den Urlaub nach italienischem Recht verlaengern?",
 a: "Die italienische Elternzeit (bis 10 Monate zwischen den Eltern aufteilbar, INPS-Leistung von 30 % fuer die ersten 6 Monate, fakultativ) gilt fuer Grenzgaenger nicht, da die lex loci laboris Anwendung findet. Einige Schweizer Unternehmen gewaehren jedoch bis zu 12 Monate unbezahlten betrieblichen Elternurlaub. Die Entscheidung zwischen Rueckkehr und Verlaengerung ist eine individuelle wirtschaftliche Frage."
 },
 fr: {
 q: "Puis-je prolonger le conge en vertu de la reglementation italienne ?",
 a: "Le conge parental italien (jusqu'a 10 mois cumulables entre parents, indemnite INPS a 30 % les 6 premiers mois, facultatif) ne s'applique pas aux frontaliers en raison de la lex loci laboris. Certaines entreprises suisses accordent toutefois un conge parental d'entreprise non remunere jusqu'a 12 mois. Le choix entre la reprise du travail et la prolongation en conge sans solde est une decision economique personnelle."
 }
 },

 "Come si calcola l'indennità IPG per la maternità?": {
 en: {
 q: "How is the APG maternity allowance calculated?",
 a: "Swiss APG is 80% of the average AVS salary over the months preceding childbirth, capped at CHF 220/day (max CHF 6,600/month gross). The calculation considers all AVS contributions of the previous 12 months divided by the number of days worked. The allowance is subject to withholding tax like an ordinary salary. No BVG contributions are paid on the allowance (the 2nd pillar is suspended for that period)."
 },
 de: {
 q: "Wie wird die EO-Mutterschaftsentschaedigung berechnet?",
 a: "Die Schweizer EO entspricht 80 % des durchschnittlichen AHV-Lohnes der Monate vor der Geburt, hoechstens CHF 220/Tag (max. CHF 6.600/Monat brutto). Der Berechnung liegen alle AHV-Beitraege der letzten 12 Monate geteilt durch die Anzahl der gearbeiteten Tage zugrunde. Die Entschaedigung unterliegt wie der ordentliche Lohn der Quellensteuer. Auf der Entschaedigung werden keine BVG-Beitraege erhoben (Unterbruch der 2. Saeule fuer diesen Zeitraum)."
 },
 fr: {
 q: "Comment l'APG maternite est-elle calculee ?",
 a: "L'APG suisse est de 80 % du salaire AVS moyen des mois precedant l'accouchement, plafonnee a CHF 220/jour (max CHF 6 600/mois brut). Le calcul prend en compte toutes les cotisations AVS des 12 derniers mois divisees par le nombre de jours travailles. L'indemnite est soumise a l'impot a la source comme un salaire ordinaire. Aucune cotisation LPP n'est percue sur l'indemnite (le 2e pilier est interrompu pour cette periode)."
 }
 },

 "Perdo il posto di lavoro se prendo il congedo maternità svizzero?": {
 en: {
 q: "Do I lose my job if I take Swiss maternity leave?",
 a: "No. The Swiss Code of Obligations (art. 336c) forbids dismissal during pregnancy and for the 16 weeks following childbirth. A dismissal notified in this period is null and void. The employment relationship and contract continue normally. On return, the employer must offer tasks compatible with the previous role. Protection is similar to but not identical to the Italian one."
 },
 de: {
 q: "Verliere ich meine Stelle, wenn ich den Schweizer Mutterschaftsurlaub nehme?",
 a: "Nein. Das Schweizer Obligationenrecht (Art. 336c OR) verbietet die Kuendigung waehrend der Schwangerschaft und in den 16 Wochen nach der Geburt. Eine in diesem Zeitraum ausgesprochene Kuendigung ist nichtig. Arbeitsverhaeltnis und Vertrag laufen normal weiter. Bei der Rueckkehr muss der Arbeitgeber Aufgaben anbieten, die mit der vorherigen Funktion kompatibel sind. Der Schutz ist aehnlich, aber nicht identisch mit dem italienischen."
 },
 fr: {
 q: "Est-ce que je perds mon emploi si je prends le conge maternite suisse ?",
 a: "Non. Le Code des obligations suisse (art. 336c) interdit le licenciement pendant la grossesse et les 16 semaines suivant l'accouchement. Un licenciement notifie pendant cette periode est nul. La relation de travail et le contrat se poursuivent normalement. Au retour, l'employeur doit proposer des taches compatibles avec le poste precedent. La protection est similaire mais non identique a celle prevue en Italie."
 }
 },

 "Quante offerte di lavoro ci sono in Ticino?": {
 en: {
 q: "How many job offers are there in Ticino?",
 a: "The current number of active Ticino job offers is shown on the page and updated from the job catalogue. Positions cover Lugano, Mendrisio, Bellinzona, Locarno and Chiasso, with ads in all major sectors: pharma, finance, IT, healthcare, logistics and industry."
 },
 de: {
 q: "Wie viele Stellenangebote gibt es im Tessin?",
 a: "Die aktuelle Zahl aktiver Tessiner Stellenangebote steht auf der Seite und wird aus dem Stellenkatalog aktualisiert. Die Stellen betreffen Lugano, Mendrisio, Bellinzona, Locarno und Chiasso und decken alle Hauptbranchen ab: Pharma, Finanzen, IT, Gesundheitswesen, Logistik und Industrie."
 },
 fr: {
 q: "Combien d'offres d'emploi y a-t-il au Tessin ?",
 a: "Le nombre actuel d’offres actives au Tessin figure sur la page et est actualisé depuis le catalogue d’annonces. Les postes couvrent Lugano, Mendrisio, Bellinzona, Locarno et Chiasso, dans tous les secteurs principaux : pharma, finance, IT, sante, logistique et industrie."
 }
 },

 "Quali sono le offerte di lavoro più richieste in Ticino nel 2026?": {
 en: {
 q: "Which are the most sought-after jobs in Ticino in 2026?",
 a: "In 2026, the most sought-after profiles in Ticino are: software developers and IT specialists, nurses and social-health workers (OSS), pharmaceutical laboratory technicians, accountants and financial analysts, and mechanical engineers. Pharma and life science positions offer the highest pay, followed by finance and tech."
 },
 de: {
 q: "Welche Stellen sind 2026 im Tessin am gefragtesten?",
 a: "2026 sind im Tessin die gefragtesten Profile: Softwareentwickler und IT-Spezialisten, Pflegefachpersonen und Sozialpflege (OSS), Labortechniker in der Pharmaindustrie, Buchhalter und Finanzanalysten sowie Maschinenbauingenieure. Stellen in Pharma und Life Sciences bieten die hoechsten Gehaelter, gefolgt von Finanzen und Technologie."
 },
 fr: {
 q: "Quels sont les emplois les plus demandes au Tessin en 2026 ?",
 a: "En 2026, les profils les plus recherches au Tessin sont : developpeurs logiciels et specialistes IT, infirmiers et operateurs socio-sanitaires (OSS), techniciens de laboratoire pharmaceutique, comptables et analystes financiers, et ingenieurs mecaniques. Les postes dans la pharma et les sciences de la vie offrent les meilleures remunerations, suivis de la finance et de la tech."
 }
 },

 "Come candidarsi per offerte di lavoro in Ticino come frontaliere?": {
 en: {
 q: "How do you apply for jobs in Ticino as a cross-border worker?",
 a: "Search the listings by filtering on sector, location or contract type. Each ad includes a direct link to the official application page on the company's website. No account is needed: select the offer, click 'Apply' and you are redirected to the company HR page. Your employer will then initiate the G-permit procedure."
 },
 de: {
 q: "Wie bewirbt man sich als Grenzgaenger auf Stellen im Tessin?",
 a: "Durchsuchen Sie die Anzeigen nach Branche, Ort oder Vertragsart. Jede Anzeige enthaelt einen direkten Link zur offiziellen Bewerbung auf der Unternehmenswebsite. Ein Account ist nicht noetig: Anzeige auswaehlen, auf 'Bewerben' klicken und Sie werden auf die HR-Seite des Unternehmens weitergeleitet. Der Arbeitgeber startet dann das Verfahren fuer die G-Bewilligung."
 },
 fr: {
 q: "Comment postuler a des offres d'emploi au Tessin en tant que frontalier ?",
 a: "Cherchez parmi les offres en filtrant par secteur, lieu ou type de contrat. Chaque annonce comprend un lien direct vers la candidature officielle sur le site de l'entreprise. Aucun compte n'est requis : selectionnez l'offre, cliquez sur 'Postuler' et vous etes redirige vers la page RH de l'entreprise. Votre employeur lancera ensuite la demande de permis G."
 }
 },

 "Ci sono posti vacanti in Ticino per italiani?": {
 en: {
 q: "Are there job vacancies in Ticino for Italian citizens?",
 a: "Yes, there are hundreds of job vacancies in Ticino accessible to Italian citizens thanks to the G permit for cross-border workers. Sectors with the most openings: pharma (Mendrisiotto), finance (Lugano), IT and healthcare. Frontaliere Ticino publishes vacancies daily from over 100 Ticino companies with a direct link to applications."
 },
 de: {
 q: "Gibt es im Tessin offene Stellen fuer Italiener?",
 a: "Ja, im Tessin gibt es Hunderte offener Stellen, die italienischen Staatsbuergern dank der G-Bewilligung fuer Grenzgaenger zugaenglich sind. Branchen mit den meisten Stellen: Pharma (Mendrisiotto), Finanzen (Lugano), IT und Gesundheitswesen. Frontaliere Ticino veroeffentlicht taeglich Stellen von ueber 100 Tessiner Unternehmen mit direktem Bewerbungslink."
 },
 fr: {
 q: "Y a-t-il des postes vacants au Tessin pour les Italiens ?",
 a: "Oui, le Tessin compte des centaines de postes vacants accessibles aux citoyens italiens grace au permis G pour frontaliers. Secteurs avec le plus d'offres : pharma (Mendrisiotto), finance (Lugano), IT et sante. Frontaliere Ticino publie quotidiennement les postes de plus de 100 entreprises tessinoises avec un lien direct vers la candidature."
 }
 },

 "Dove cercare lavoro a Lugano?": {
 en: {
 q: "Where can I search for jobs in Lugano?",
 a: "Lugano is the economic hub of Ticino with the highest concentration of openings. Major employers in Lugano include banks (BSI, BancaStato, EFG), IT firms, law firms and consulting companies. On Frontaliere Ticino you can filter offers by location Lugano and apply directly on the company website."
 },
 de: {
 q: "Wo findet man Stellen in Lugano?",
 a: "Lugano ist das Wirtschaftszentrum des Tessins mit der hoechsten Stellenkonzentration. Wichtige Arbeitgeber in Lugano sind Banken (BSI, BancaStato, EFG), IT-Firmen, Anwaltskanzleien und Beratungsunternehmen. Auf Frontaliere Ticino koennen Sie Stellenangebote nach Standort Lugano filtern und sich direkt auf der Unternehmenswebsite bewerben."
 },
 fr: {
 q: "Ou chercher un emploi a Lugano ?",
 a: "Lugano est le pole economique du Tessin avec la plus forte concentration d'offres. Les principaux employeurs a Lugano incluent des banques (BSI, BancaStato, EFG), des societes IT, des cabinets d'avocats et des societes de conseil. Sur Frontaliere Ticino, vous pouvez filtrer les offres par localite Lugano et postuler directement sur le site de l'entreprise."
 }
 },

 "Come trovare offerte di lavoro in Svizzera per italiani?": {
 en: {
 q: "How can Italians find jobs in Switzerland?",
 a: "Canton Ticino is the main destination for Italians looking for jobs in Switzerland, thanks to the Italian language and geographical proximity. Frontaliere Ticino displays current Ticino job offers and their updated count on the page. You can search by sector, location and contract type. Every ad includes an estimated salary and a direct application link."
 },
 de: {
 q: "Wie finden Italiener Stellen in der Schweiz?",
 a: "Der Kanton Tessin ist das wichtigste Ziel fuer Italiener, die Arbeit in der Schweiz suchen, dank italienischer Sprache und geografischer Naehe. Frontaliere Ticino zeigt aktuelle Tessiner Stellenangebote und ihre aktualisierte Anzahl auf der Seite. Du kannst nach Branche, Standort und Vertragsart suchen. Jede Anzeige enthaelt ein geschaetztes Gehalt und einen direkten Bewerbungslink."
 },
 fr: {
 q: "Comment les Italiens peuvent-ils trouver du travail en Suisse ?",
 a: "Le canton du Tessin est la destination principale pour les Italiens qui cherchent un emploi en Suisse, grace a la langue italienne et a la proximite geographique. Frontaliere Ticino affiche les offres tessinoises actuelles et leur nombre actualisé sur la page. Vous pouvez rechercher par secteur, lieu et type de contrat. Chaque annonce inclut un salaire estime et un lien direct pour postuler."
 }
 },

 "La tredicesima è obbligatoria per i frontalieri in Svizzera?": {
 en: {
 q: "Is the 13th month mandatory for cross-border workers in Switzerland?",
 a: "The 13th month is not required by Swiss law, but it is widely included in collective labour agreements (CLA) and individual contracts in Canton Ticino. Many sectors provide for it contractually: banks, insurance, public administration and many industrial companies. Always check your contract: if provided, it is usually paid in December together with the monthly salary or as a separate instalment."
 },
 de: {
 q: "Ist der 13. Monatslohn fuer Grenzgaenger in der Schweiz obligatorisch?",
 a: "Der 13. Monatslohn ist in der Schweiz gesetzlich nicht vorgeschrieben, aber in Gesamtarbeitsvertraegen (GAV) und Einzelarbeitsvertraegen im Kanton Tessin weit verbreitet. Viele Branchen sehen ihn vertraglich vor: Banken, Versicherungen, oeffentliche Verwaltung und zahlreiche Industrieunternehmen. Pruefen Sie immer Ihren Vertrag: wenn vorgesehen, wird er typischerweise im Dezember zusammen mit dem Monatslohn oder als separate Auszahlung ausbezahlt."
 },
 fr: {
 q: "Le 13e salaire est-il obligatoire pour les frontaliers en Suisse ?",
 a: "Le 13e mois n'est pas obligatoire par la loi en Suisse, mais il est largement diffuse dans les conventions collectives (CCT) et les contrats individuels du canton du Tessin. De nombreux secteurs le prevoient contractuellement : banques, assurances, administration publique et beaucoup d'entreprises industrielles. Verifiez toujours votre contrat : s'il est prevu, il est generalement verse en decembre avec le salaire mensuel ou comme mensualite separee."
 }
 },

 "Come si calcola la tredicesima del frontaliere assunto a metà anno?": {
 en: {
 q: "How is the 13th salary calculated for a cross-border worker hired mid-year?",
 a: "The 13th is pro-rated on the months actually worked in the year: monthly gross divided by 12, multiplied by the months of service. A cross-border worker hired on 1 June with CHF 6,000 gross/month receives 7/12 of a month as 13th, i.e. CHF 3,500 gross. The 13th is also subject to withholding tax, AVS/AI/APG (5.3%), unemployment insurance (1.1%) and BVG if above the BVG contribution threshold."
 },
 de: {
 q: "Wie wird der 13. Monatslohn bei Einstellung mitten im Jahr berechnet?",
 a: "Der 13. wird pro rata auf die tatsaechlich im Jahr gearbeiteten Monate berechnet: Monatsbrutto geteilt durch 12, multipliziert mit der Anzahl Dienstmonate. Ein am 1. Juni eingestellter Grenzgaenger mit CHF 6.000 brutto/Monat erhaelt 7/12 eines Monatslohns als 13., also CHF 3.500 brutto. Der 13. unterliegt ebenfalls der Quellensteuer, AHV/IV/EO (5,3 %), ALV (1,1 %) und BVG, sofern ueber der BVG-Eintrittsschwelle."
 },
 fr: {
 q: "Comment calcule-t-on le 13e salaire d'un frontalier embauche en cours d'annee ?",
 a: "Le 13e est calcule au prorata des mois effectivement travailles dans l'annee : salaire brut mensuel divise par 12, multiplie par les mois de service. Un frontalier embauche le 1er juin a CHF 6 000 brut/mois recoit 7/12 d'un mois comme 13e, soit CHF 3 500 bruts. Le 13e est aussi soumis a l'impot a la source, a l'AVS/AI/APG (5,3 %), a l'AC (1,1 %) et a la LPP s'il est au-dessus du seuil de cotisation LPP."
 }
 },

 "Esiste la quattordicesima per i frontalieri in Ticino?": {
 en: {
 q: "Is there a 14th-month salary for cross-border workers in Ticino?",
 a: "The 14th month is rare in Switzerland but exists in some sectors and companies as a performance bonus or as a contractual extra instalment. More common is a discretionary bonus by the employer, linked to company or individual results, which may equal an extra monthly salary. Unlike Italy where 14th and bonuses are widespread, Swiss bonuses are volatile and not guaranteed, so they should not be counted as fixed income in payslip calculations."
 },
 de: {
 q: "Gibt es fuer Grenzgaenger im Tessin einen 14. Monatslohn?",
 a: "Der 14. Monatslohn ist in der Schweiz selten, existiert jedoch in einigen Branchen und Unternehmen als Leistungsbonus oder als vertragliche Zusatzzahlung. Verbreiteter ist ein diskretionaerer Bonus des Arbeitgebers, geknuepft an Unternehmens- oder Einzelergebnisse, der einem zusaetzlichen Monatslohn entsprechen kann. Im Gegensatz zu Italien, wo 14. und Praemien verbreitet sind, sind Boni in der Schweiz volatil und nicht garantiert; sie sollten daher nicht als Fixeinkommen in die Lohnberechnung einfliessen."
 },
 fr: {
 q: "Existe-t-il un 14e salaire pour les frontaliers au Tessin ?",
 a: "Le 14e mois est rare en Suisse mais existe dans certains secteurs et entreprises comme bonus de performance ou comme mensualite contractuelle. Plus frequent est le bonus discretionnaire de l'employeur, lie aux resultats de l'entreprise ou individuels, qui peut equivaloir a un mois supplementaire. Contrairement a l'Italie ou 14e et primes sont repandues, les bonus suisses sont volatils et non garantis : ils ne doivent donc pas etre consideres comme un revenu fixe dans le calcul de la fiche de paie."
 }
 },

 "La tredicesima svizzera va dichiarata in Italia dal nuovo frontaliere?": {
 en: {
 q: "Does the Swiss 13th month need to be declared in Italy by a new cross-border worker?",
 a: "Yes: the 13th month is an integral part of employment income and must be included in the total annual amount declared in the Redditi PF form (RC section). For new cross-border workers under the concurrent regime, it is part of taxable IRPEF income, net of the €10,000 exemption and the tax credit for taxes paid in Switzerland. The Lohnausweis issued by the employer already reports the full annual amount including 13th and bonuses."
 },
 de: {
 q: "Muss der Schweizer 13. Monatslohn vom neuen Grenzgaenger in Italien deklariert werden?",
 a: "Ja: der 13. Monatslohn ist integraler Bestandteil des Einkommens aus unselbstaendiger Taetigkeit und muss im jaehrlichen Gesamtbetrag im Modell Redditi PF (Quadro RC) angegeben werden. Fuer neue Grenzgaenger im konkurrierenden Regime faellt er unter das IRPEF-pflichtige Einkommen, abzueglich des Freibetrags von 10.000 EUR und der Steuergutschrift fuer die in der Schweiz gezahlten Steuern. Der vom Arbeitgeber ausgestellte Lohnausweis weist bereits den Jahresgesamtbetrag inkl. 13. und Boni aus."
 },
 fr: {
 q: "Le 13e suisse doit-il etre declare en Italie par le nouveau frontalier ?",
 a: "Oui : le 13e fait partie integrante du revenu du travail salarie et doit etre inclus dans le montant annuel total declare au Modele Redditi PF (cadre RC). Pour les nouveaux frontaliers sous le regime concurrent, il entre dans le revenu imposable IRPEF, deduction faite de la franchise de 10 000 EUR et du credit d'impot pour les impots payes en Suisse. Le Lohnausweis emis par l'employeur indique deja le montant annuel total y compris le 13e et les bonus."
 }
 },

 "Quali sono i requisiti per lavorare come frontaliere in Svizzera nel 2026?": {
 en: {
 q: "What are the requirements to work as a cross-border worker in Switzerland in 2026?",
 a: "To work as a cross-border worker in Switzerland you need: EU/EFTA citizenship, residence in an Italian municipality (preferably within 20 km of the border for the transitional regime), an employment contract with a Swiss employer, and the G permit issued by the canton. The G permit is valid for 5 years for open-ended contracts and is issued within 5–10 working days of the application."
 },
 de: {
 q: "Welche Voraussetzungen gelten 2026 fuer die Arbeit als Grenzgaenger in der Schweiz?",
 a: "Um als Grenzgaenger in der Schweiz zu arbeiten, sind erforderlich: Staatsangehoerigkeit EU/EFTA, Wohnsitz in einer italienischen Gemeinde (vorzugsweise innerhalb von 20 km zur Grenze fuer das Uebergangsregime), ein Arbeitsvertrag mit einem Schweizer Arbeitgeber und die G-Bewilligung des Kantons. Die G-Bewilligung ist bei unbefristeten Vertraegen 5 Jahre gueltig und wird innerhalb von 5–10 Arbeitstagen nach Antragstellung ausgestellt."
 },
 fr: {
 q: "Quelles sont les conditions pour travailler comme frontalier en Suisse en 2026 ?",
 a: "Pour travailler comme frontalier en Suisse, il faut : la citoyennete UE/AELE, la residence dans une commune italienne (de preference dans un rayon de 20 km de la frontiere pour le regime transitoire), un contrat de travail avec un employeur suisse, et le permis G delivre par le canton. Le permis G est valable 5 ans pour les contrats a duree indeterminee et est delivre dans un delai de 5 a 10 jours ouvres apres la demande."
 }
 },

 "Come funziona la tassazione dei frontalieri con il nuovo accordo 2026?": {
 en: {
 q: "How does cross-border worker taxation work under the 2026 New Agreement?",
 a: "For new fiscal cross-border workers, Switzerland applies 80% of its ordinary withholding rate; Italy taxes the income with a credit for Swiss tax. The 80% is not a revenue split between the two countries. Old cross-border workers who qualify under Article 9 retain exclusive Swiss taxation of the covered salary. Their regime does not automatically end in 2033 or 2034: 2033 is the final tax year of Swiss compensation payments to Italy. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Wie funktioniert die Besteuerung der Grenzgaenger nach dem Neuen Abkommen 2026?",
 a: "Für neue steuerliche Grenzgänger wendet die Schweiz 80% des ordentlichen Quellensteuertarifs an; Italien besteuert das Einkommen mit Anrechnung der Schweizer Steuer. Die 80% sind keine Aufteilung der Einnahmen zwischen den Staaten. Alte Grenzgänger, die Artikel 9 erfüllen, behalten die ausschliessliche Schweizer Besteuerung des erfassten Lohns. Das Regime endet nicht automatisch 2033 oder 2034; 2033 ist das letzte Steuerjahr der Ausgleichszahlungen an Italien. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Comment fonctionne l'imposition des frontaliers selon le Nouvel Accord 2026 ?",
 a: "Pour les nouveaux frontaliers fiscaux, la Suisse applique 80% du taux ordinaire de retenue; l’Italie impose le revenu en accordant un crédit pour l’impôt suisse. Les 80% ne sont pas un partage des recettes entre les États. Les anciens frontaliers remplissant les conditions de l’article 9 conservent l’imposition exclusivement suisse du salaire concerné. Ce régime ne prend pas automatiquement fin en 2033 ou 2034; 2033 est la dernière année fiscale des compensations versées à l’Italie. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 "Quanto costa l'assicurazione sanitaria LAMal per i frontalieri?": {
 en: {
 q: "How much does LAMal health insurance cost for cross-border workers?",
 a: "Cross-border workers resident in Italy pay country-of-residence LAMal premiums, not premiums for their Swiss canton of employment. The official FOPH 2026 Italy table lists 14 insurers with separate age and accident-cover rates. For adults aged 26+ without accident cover, monthly premiums range from CHF 279 to CHF 487.20; the ordinary deductible is CHF 300 (CHF 0 for children). Optional deductibles and HMO/Telmed models are unavailable. Source: https://www.priminfo.admin.ch/downloads/praemien_eu_2026.pdf"
 },
 de: {
 q: "Wie viel kostet die LAMal-Krankenversicherung fuer Grenzgaenger?",
 a: "Für Grenzgänger mit Wohnsitz in Italien gelten die KVG-Prämien des Wohnsitzlands, nicht des Schweizer Arbeitskantons. Die offizielle BAG-Tabelle 2026 für Italien nennt 14 Versicherer mit getrennten Prämien nach Alter und Unfalldeckung. Für Erwachsene ab 26 ohne Unfalldeckung liegen die Monatsprämien zwischen CHF 279 und CHF 487.20; die ordentliche Franchise beträgt CHF 300 (CHF 0 für Kinder). Wahlfranchisen und HMO/Telmed-Modelle sind nicht verfügbar. Quelle: https://www.priminfo.admin.ch/downloads/praemien_eu_2026.pdf"
 },
 fr: {
 q: "Combien coute l'assurance maladie LAMal pour les frontaliers ?",
 a: "Les frontaliers résidant en Italie paient les primes LAMal du pays de domicile, et non celles du canton de travail suisse. Le tableau officiel OFSP 2026 pour l’Italie comprend 14 assureurs et distingue âge et couverture accidents. Pour les adultes dès 26 ans sans couverture accidents, les primes mensuelles vont de CHF 279 à CHF 487.20 ; la franchise ordinaire est CHF 300 (CHF 0 pour enfants). Les franchises à option et modèles HMO/Telmed ne sont pas disponibles. Source : https://www.priminfo.admin.ch/downloads/praemien_eu_2026.pdf"
 }
 },

 "Quanti frontalieri lavorano in Canton Ticino e quanto guadagnano?": {
 en: {
 q: "How many cross-border workers work in Canton Ticino and how much do they earn?",
 a: "About 79,000 cross-border workers commute daily from Italy to Canton Ticino (BFS 2025), roughly 30% of the cantonal workforce. The median gross salary in Ticino is about CHF 5,200/month (CHF 62,400/year). The main sectors are manufacturing, construction, finance, healthcare, hospitality and IT. The number grows by 2–3% per year."
 },
 de: {
 q: "Wie viele Grenzgaenger arbeiten im Kanton Tessin und wie viel verdienen sie?",
 a: "Rund 79.000 Grenzgaenger pendeln taeglich aus Italien in den Kanton Tessin (BFS 2025), rund 30 % der kantonalen Erwerbsbevoelkerung. Der Medianbruttolohn im Tessin liegt bei rund CHF 5.200/Monat (CHF 62.400/Jahr). Hauptbranchen sind Industrie, Bauwesen, Finanzen, Gesundheitswesen, Gastgewerbe und IT. Die Zahl waechst jaehrlich um 2–3 %."
 },
 fr: {
 q: "Combien de frontaliers travaillent dans le canton du Tessin et combien gagnent-ils ?",
 a: "Environ 79 000 frontaliers font la navette quotidienne depuis l'Italie vers le canton du Tessin (OFS 2025), soit environ 30 % de la main-d'oeuvre cantonale. Le salaire brut median au Tessin est d'environ CHF 5 200/mois (CHF 62 400/an). Les principaux secteurs sont l'industrie, la construction, la finance, la sante, l'hotellerie-restauration et l'IT. Le nombre croit de 2–3 % par an."
 }
 },

 // ── Blog: Mortgages ──
 "Posso ottenere un mutuo in Italia con stipendio svizzero?": {
 en: {
 q: "Can I get a mortgage in Italy with a Swiss salary?",
 a: "Yes, several Italian banks accept Swiss income for mortgages. Among the most active: Intesa Sanpaolo, Credit Agricole Italia and BancaStato (for properties in the border zone). Additional documentation is needed such as the salary certificate and the Swiss employer's statement."
 },
 de: {
 q: "Kann ich mit einem Schweizer Lohn eine Hypothek in Italien erhalten?",
 a: "Ja, mehrere italienische Banken akzeptieren Schweizer Einkommen fuer Hypotheken. Zu den aktivsten gehoeren Intesa Sanpaolo, Credit Agricole Italia und BancaStato (fuer Immobilien in der Grenzzone). Zusaetzliche Unterlagen sind noetig, wie Lohnausweis und Arbeitgeberbescheinigung des Schweizer Arbeitgebers."
 },
 fr: {
 q: "Puis-je obtenir un pret hypothecaire en Italie avec un salaire suisse ?",
 a: "Oui, plusieurs banques italiennes acceptent les revenus suisses pour les prets hypothecaires. Parmi les plus actives : Intesa Sanpaolo, Credit Agricole Italia et BancaStato (pour les biens en zone frontaliere). Une documentation supplementaire est necessaire, comme le certificat de salaire et l'attestation de l'employeur suisse."
 }
 },

 "Quali documenti servono per un mutuo da frontaliere?": {
 en: {
 q: "Which documents are needed for a cross-border worker's mortgage?",
 a: "In addition to the standard documents (ID card, tax code, cadastral extract), cross-border workers must submit: Swiss salary certificate, work permit (G or B), last 3 payslips, AVS extract and Italian tax return."
 },
 de: {
 q: "Welche Unterlagen sind fuer eine Grenzgaenger-Hypothek noetig?",
 a: "Zusaetzlich zu den Standardunterlagen (Personalausweis, Steuernummer, Grundbuchauszug) muessen Grenzgaenger folgende Dokumente einreichen: Schweizer Lohnausweis, Arbeitsbewilligung (G oder B), die letzten 3 Lohnabrechnungen, AHV-Auszug und italienische Steuererklaerung."
 },
 fr: {
 q: "Quels documents sont necessaires pour un pret hypothecaire de frontalier ?",
 a: "En plus des documents standards (carte d'identite, code fiscal, extrait cadastral), les frontaliers doivent presenter : certificat de salaire suisse, permis de travail (G ou B), les 3 dernieres fiches de paie, extrait AVS et declaration de revenus italienne."
 }
 },

 "Conviene fare il mutuo in CHF o in EUR?": {
 en: {
 q: "Is it better to take out a mortgage in CHF or EUR?",
 a: "It depends on the currency of your income. If you earn in CHF, a CHF mortgage eliminates exchange-rate risk, but Italian banks almost always issue mortgages in EUR. Some Swiss banks (e.g. BancaStato) offer CHF mortgages for properties in the Italian border zone."
 },
 de: {
 q: "Ist eine Hypothek in CHF oder in EUR guenstiger?",
 a: "Das haengt von der Waehrung Ihres Einkommens ab. Wer in CHF verdient, eliminiert mit einer CHF-Hypothek das Waehrungsrisiko, italienische Banken vergeben Hypotheken jedoch fast ausschliesslich in EUR. Einige Schweizer Banken (z.B. BancaStato) bieten CHF-Hypotheken fuer Immobilien in der italienischen Grenzzone an."
 },
 fr: {
 q: "Vaut-il mieux contracter un pret hypothecaire en CHF ou en EUR ?",
 a: "Cela depend de la monnaie de votre revenu. Si vous percevez des CHF, un pret en CHF elimine le risque de change, mais les banques italiennes accordent presque exclusivement des prets en EUR. Certaines banques suisses (p. ex. BancaStato) offrent des prets en CHF pour les biens en zone frontaliere italienne."
 }
 },

 // ── Blog: G permit, LAMal/SSN, Ticino job market, etc. ──
 "Quali sono i principali vantaggi del permesso G?": {
 en: {
 q: "What are the main advantages of the G permit?",
 a: "The G permit allows you to work in Switzerland while keeping residence in Italy: favourable taxation for old cross-border workers (withholding tax only), Swiss AVS/BVG contributions, the same employment rights as residents, and the possibility of daily return."
 },
 de: {
 q: "Welches sind die wichtigsten Vorteile der G-Bewilligung?",
 a: "Die G-Bewilligung ermoeglicht die Arbeit in der Schweiz bei Beibehaltung des Wohnsitzes in Italien: vorteilhafte Besteuerung fuer alte Grenzgaenger (nur Quellensteuer), Schweizer AHV-/BVG-Beitraege, dieselben Arbeitsrechte wie Ansaessige und taegliche Rueckkehrmoeglichkeit."
 },
 fr: {
 q: "Quels sont les principaux avantages du permis G ?",
 a: "Le permis G permet de travailler en Suisse tout en conservant la residence en Italie : fiscalite avantageuse pour les anciens frontaliers (impot a la source uniquement), cotisations suisses AVS/LPP, memes droits du travail que les residents, et possibilite de retour quotidien."
 }
 },

 "I nuovi frontalieri pagano le tasse due volte?": {
 en: {
 q: "Do new cross-border workers pay tax twice?",
 a: "New tax frontier workers under the agreement are taxable in both countries. Italy provides a credit for Swiss tax according to the applicable rules; this does not guarantee that no Italian balance is due. The regime requires checking the agreement conditions, not just the latest hiring date. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 de: {
 q: "Zahlen neue Grenzgaenger doppelt Steuern?",
 a: "Neue steuerliche Grenzgänger des Abkommens sind in beiden Staaten steuerpflichtig. Italien rechnet die Schweizer Steuer nach den geltenden Regeln an; ein italienischer Restbetrag ist damit nicht ausgeschlossen. Die Abkommensbedingungen sind zu prüfen, nicht nur das letzte Anstellungsdatum. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 },
 fr: {
 q: "Les nouveaux frontaliers paient-ils deux fois l'impot ?",
 a: "Les nouveaux frontaliers fiscaux de l’accord sont imposables dans les deux États. L’Italie accorde un crédit pour l’impôt suisse selon les règles applicables ; un solde italien peut rester dû. Il faut vérifier les conditions de l’accord, pas seulement la dernière date d’embauche. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
 }
 },

 "Posso passare da permesso G a permesso B?": {
 en: {
 q: "Can I switch from a G permit to a B permit?",
 a: "Yes, you can move your residence to Switzerland and switch to the B permit at any time, provided you find accommodation in Switzerland and notify the competent authorities of the change."
 },
 de: {
 q: "Kann ich von der G-Bewilligung zur B-Bewilligung wechseln?",
 a: "Ja, der Wohnsitz kann jederzeit in die Schweiz verlegt und auf die B-Bewilligung umgestellt werden, sofern in der Schweiz eine Unterkunft gefunden und der Wechsel den zustaendigen Behoerden gemeldet wird."
 },
 fr: {
 q: "Puis-je passer du permis G au permis B ?",
 a: "Oui, il est possible de transferer la residence en Suisse et de passer au permis B a tout moment, a condition de trouver un logement en Suisse et de communiquer le changement aux autorites competentes."
 }
 },

 "Qual è la differenza tra LAMal e SSN per un frontaliere?": {
 en: {
 q: "What is the difference between LAMal and the Italian SSN for a cross-border worker?",
 a: "LAMal premiums depend on residence, age and accident cover. The official 2026 Italy table gives CHF 279–487.20/month for adults aged 26+ without accident cover, with a CHF 300 deductible. The specific SSN contribution for eligible Article 9 cross-border workers is distinct from voluntary SSN enrolment: 3–6% of net Swiss salary, within EUR 30–200 per month worked, subject to regional implementation and applicable conditions. Eligible residents in Italy must formally request exemption from the competent canton within three months to exercise their right of option."
 },
 de: {
 q: "Was ist der Unterschied zwischen LAMal und SSN fuer einen Grenzgaenger?",
 a: "LAMal-Praemien richten sich nach Wohnsitzland, Alter und Unfalldeckung. Die offizielle Italien-Tabelle 2026 nennt CHF 279–487.20 monatlich fuer Erwachsene ab 26 Jahren ohne Unfalldeckung bei CHF 300 Franchise. Der besondere SSN-Beitrag fuer berechtigte Grenzgaenger nach Artikel 9 ist von der freiwilligen SSN-Einschreibung zu unterscheiden: 3–6 % des Schweizer Nettolohns, begrenzt auf EUR 30–200 je gearbeitetem Monat, unter den geltenden Voraussetzungen und gemaess regionaler Umsetzung. Berechtigte Personen mit Wohnsitz in Italien muessen die Befreiung innerhalb von drei Monaten formell beim zustaendigen Kanton beantragen."
 },
 fr: {
 q: "Quelle est la difference entre la LAMal et le SSN pour un frontalier ?",
 a: "Les primes LAMal dependent du pays de residence, de l age et de la couverture accident. Le tableau officiel Italie 2026 indique CHF 279–487.20 par mois pour les adultes de 26 ans et plus sans accident, avec une franchise de CHF 300. La contribution SSN specifique des frontaliers eligibles selon l article 9 est distincte de l inscription volontaire : 3–6 % du salaire suisse net, limitee a EUR 30–200 par mois travaille, sous les conditions applicables et selon la mise en oeuvre regionale. Les residents italiens eligibles doivent demander formellement une exemption au canton competent dans les trois mois."
 }
 },

 "Quanto costa la LAMal per un frontaliere in Ticino?": {
 en: {
 q: "How much does LAMal cost for a cross-border worker in Ticino?",
 a: "Cross-border workers resident in Italy pay country-of-residence LAMal premiums, not premiums for their Swiss canton of employment. The official FOPH 2026 Italy table lists 14 insurers with separate age and accident-cover rates. For adults aged 26+ without accident cover, monthly premiums range from CHF 279 to CHF 487.20; the ordinary deductible is CHF 300 (CHF 0 for children). Optional deductibles and HMO/Telmed models are unavailable. Source: https://www.priminfo.admin.ch/downloads/praemien_eu_2026.pdf"
 },
 de: {
 q: "Wie viel kostet die LAMal fuer einen Grenzgaenger im Tessin?",
 a: "Für Grenzgänger mit Wohnsitz in Italien gelten die KVG-Prämien des Wohnsitzlands, nicht des Schweizer Arbeitskantons. Die offizielle BAG-Tabelle 2026 für Italien nennt 14 Versicherer mit getrennten Prämien nach Alter und Unfalldeckung. Für Erwachsene ab 26 ohne Unfalldeckung liegen die Monatsprämien zwischen CHF 279 und CHF 487.20; die ordentliche Franchise beträgt CHF 300 (CHF 0 für Kinder). Wahlfranchisen und HMO/Telmed-Modelle sind nicht verfügbar. Quelle: https://www.priminfo.admin.ch/downloads/praemien_eu_2026.pdf"
 },
 fr: {
 q: "Combien coute la LAMal pour un frontalier au Tessin ?",
 a: "Les frontaliers résidant en Italie paient les primes LAMal du pays de domicile, et non celles du canton de travail suisse. Le tableau officiel OFSP 2026 pour l’Italie comprend 14 assureurs et distingue âge et couverture accidents. Pour les adultes dès 26 ans sans couverture accidents, les primes mensuelles vont de CHF 279 à CHF 487.20 ; la franchise ordinaire est CHF 300 (CHF 0 pour enfants). Les franchises à option et modèles HMO/Telmed ne sont pas disponibles. Source : https://www.priminfo.admin.ch/downloads/praemien_eu_2026.pdf"
 }
 },

 "Posso curarmi in Svizzera con il SSN italiano?": {
 en: {
 q: "Can I get medical care in Switzerland with the Italian SSN?",
 a: "With the Italian SSN and the TEAM/EHIC card you are covered for emergencies throughout the EU and Switzerland, but planned care in Switzerland is not covered. For non-urgent care you need LAMal or a private insurance."
 },
 de: {
 q: "Kann ich mich mit dem italienischen SSN in der Schweiz behandeln lassen?",
 a: "Mit dem italienischen SSN und der TEAM-/EHIC-Karte sind Sie in der gesamten EU und Schweiz fuer Notfaelle abgedeckt, doch geplante Behandlungen in der Schweiz sind nicht gedeckt. Fuer nicht dringende Behandlungen ist eine LAMal oder eine Privatversicherung noetig."
 },
 fr: {
 q: "Puis-je me faire soigner en Suisse avec le SSN italien ?",
 a: "Avec le SSN italien et la carte TEAM/EHIC vous etes couvert pour les urgences dans toute l'UE et en Suisse, mais les soins programmes en Suisse ne sont pas couverts. Pour les soins non urgents, il faut la LAMal ou une assurance privee."
 }
 },

 "Quando conviene scegliere la LAMal rispetto al SSN?": {
 en: {
 q: "When is it better to choose LAMal over the SSN?",
 a: "LAMal is worthwhile for singles with income above CHF 5,000/month, for those who need frequent care in Switzerland, and for those who want direct access to Swiss specialists without long waiting times."
 },
 de: {
 q: "Wann lohnt sich die LAMal gegenueber dem SSN?",
 a: "Die LAMal lohnt sich fuer Alleinstehende mit einem Einkommen ueber CHF 5.000/Monat, fuer Personen, die haeufig medizinische Versorgung in der Schweiz benoetigen, und fuer jene, die einen direkten Zugang zu Schweizer Spezialisten ohne lange Wartezeiten wuenschen."
 },
 fr: {
 q: "Quand vaut-il la peine de choisir la LAMal plutot que le SSN ?",
 a: "La LAMal est avantageuse pour les celibataires avec un revenu superieur a CHF 5 000/mois, pour ceux qui ont besoin de soins frequents en Suisse, et pour ceux qui veulent un acces direct aux specialistes suisses sans longues attentes."
 }
 },

 "Il diritto di opzione LAMal/SSN è irreversibile?": {
 en: {
 q: "Is the LAMal/SSN right of option irreversible?",
 a: "Eligible EU citizens resident in Italy may formally request exemption from LAMal from the competent authority in their canton of employment within three months of starting work. Italian SSN enrolment alone does not exercise this right. The choice cannot be changed freely. For someone previously insured under LAMal, the birth of a child may allow a new option within three months, depending on the family situation: check with the canton and Italian ASL first. Source: FOPH, https://www.bag.admin.ch/it/assicurazione-malattie-lavoratori-frontalieri-in-svizzera"
 },
 de: {
 q: "Ist das Optionsrecht LAMal/SSN unwiderruflich?",
 a: "Berechtigte EU-Staatsangehörige mit Wohnsitz in Italien können beim zuständigen Arbeitskanton innerhalb von drei Monaten nach Arbeitsbeginn die Befreiung von der KVG beantragen. Eine SSN-Anmeldung allein genügt nicht. Die Wahl kann nicht frei geändert werden. Bei bisheriger KVG-Versicherung kann die Geburt eines Kindes je nach Familiensituation eine erneute Ausübung innerhalb von drei Monaten ermöglichen: vorher mit dem Kanton und der italienischen ASL klären. Quelle: BAG, https://www.bag.admin.ch/it/assicurazione-malattie-lavoratori-frontalieri-in-svizzera"
 },
 fr: {
 q: "Le droit d'option LAMal/SSN est-il irreversible ?",
 a: "Les citoyens UE résidant en Italie qui disposent du droit d’option peuvent demander formellement une exemption de la LAMal à l’autorité du canton de travail dans les trois mois suivant le début de l’activité. L’inscription au SSN seule ne suffit pas. Le choix ne peut pas être modifié librement. Pour une personne précédemment assurée LAMal, la naissance d’un enfant peut permettre un nouvel exercice dans les trois mois, selon la situation familiale : vérifier auparavant avec le canton et l’ASL italienne. Source : OFSP, https://www.bag.admin.ch/it/assicurazione-malattie-lavoratori-frontalieri-in-svizzera"
 }
 },

 "Quali sono i portali migliori per cercare lavoro in Ticino?": {
 en: {
 q: "Which are the best portals to look for jobs in Ticino?",
 a: "The main portals are job.ticino.ch (cantonal), jobs.ch and jobup.ch (national), LinkedIn, and the Frontaliere Ticino job board with over 4,000 offers. Temp agencies such as Adecco, Manpower and Randstad have branches in Lugano and Mendrisio."
 },
 de: {
 q: "Welches sind die besten Portale fuer die Stellensuche im Tessin?",
 a: "Die wichtigsten Portale sind job.ticino.ch (kantonal), jobs.ch und jobup.ch (national), LinkedIn und das Job-Board von Frontaliere Ticino mit ueber 4.000 Angeboten. Personalvermittlungen wie Adecco, Manpower und Randstad haben Niederlassungen in Lugano und Mendrisio."
 },
 fr: {
 q: "Quels sont les meilleurs portails pour chercher un emploi au Tessin ?",
 a: "Les principaux portails sont job.ticino.ch (cantonal), jobs.ch et jobup.ch (nationaux), LinkedIn et la plateforme emploi de Frontaliere Ticino avec plus de 4 000 offres. Les agences de travail temporaire comme Adecco, Manpower et Randstad ont des bureaux a Lugano et Mendrisio."
 }
 },

 "Qual è lo stipendio medio in Ticino per un frontaliere?": {
 en: {
 q: "What is the average salary in Ticino for a cross-border worker?",
 a: "The median salary in Canton Ticino is about CHF 5,400/month (BFS, 2024). It varies by sector: finance CHF 7,000–9,000, IT CHF 6,500–8,500, pharma CHF 6,000–8,000, retail CHF 5,000–6,500, hospitality CHF 4,500–5,500."
 },
 de: {
 q: "Wie hoch ist der durchschnittliche Lohn eines Grenzgaengers im Tessin?",
 a: "Der Medianlohn im Kanton Tessin betraegt rund CHF 5.400/Monat (BFS, 2024). Er variiert nach Branche: Finanzen CHF 7.000–9.000, IT CHF 6.500–8.500, Pharma CHF 6.000–8.000, Handel CHF 5.000–6.500, Gastgewerbe CHF 4.500–5.500."
 },
 fr: {
 q: "Quel est le salaire moyen au Tessin pour un frontalier ?",
 a: "Le salaire median au Tessin est d'environ CHF 5 400/mois (OFS, 2024). Il varie selon le secteur : finance CHF 7 000–9 000, IT CHF 6 500–8 500, pharma CHF 6 000–8 000, commerce CHF 5 000–6 500, hotellerie-restauration CHF 4 500–5 500."
 }
 },

 "Il CV svizzero è diverso da quello italiano?": {
 en: {
 q: "Is the Swiss CV different from the Italian one?",
 a: "Yes: the Swiss CV includes a photo, is 2–3 pages long, requires verifiable references, uses reverse-chronological format and includes work certificates (Arbeitszeugnis). A cover letter is almost always required."
 },
 de: {
 q: "Unterscheidet sich der Schweizer Lebenslauf vom italienischen?",
 a: "Ja: Der Schweizer Lebenslauf enthaelt ein Foto, ist 2–3 Seiten lang, erfordert ueberpruefbare Referenzen, folgt dem antichronologischen Format und enthaelt Arbeitszeugnisse. Ein Motivationsschreiben ist fast immer erforderlich."
 },
 fr: {
 q: "Le CV suisse est-il different du CV italien ?",
 a: "Oui : le CV suisse inclut une photo, fait 2 a 3 pages, demande des references verifiables, suit le format chronologique inverse et inclut les certificats de travail (Arbeitszeugnis). Une lettre de motivation est presque toujours requise."
 }
 },

 "Quali settori assumono di più frontalieri in Ticino?": {
 en: {
 q: "Which sectors hire the most cross-border workers in Ticino?",
 a: "The sectors with the highest demand are: financial and banking services, pharma and biotech, IT and software, engineering and manufacturing, retail, and healthcare. Lugano, Mendrisio and Chiasso concentrate most of the opportunities."
 },
 de: {
 q: "Welche Branchen stellen im Tessin die meisten Grenzgaenger ein?",
 a: "Die Branchen mit der groessten Nachfrage sind: Finanz- und Bankdienstleistungen, Pharma und Biotech, IT und Software, Ingenieurwesen und Industrie, Einzelhandel und Gesundheitswesen. Lugano, Mendrisio und Chiasso vereinen den Grossteil der Stellen."
 },
 fr: {
 q: "Quels secteurs embauchent le plus de frontaliers au Tessin ?",
 a: "Les secteurs a plus forte demande sont : services financiers et bancaires, pharma et biotech, IT et logiciels, ingenierie et industrie, commerce de detail et sante. Lugano, Mendrisio et Chiasso concentrent la majorite des opportunites."
 }
 },

 "Serve parlare tedesco per lavorare in Ticino?": {
 en: {
 q: "Do you need to speak German to work in Ticino?",
 a: "No, Ticino is Italian-speaking. Italian is the main language. However, knowing English and/or German is a competitive advantage, especially in finance, pharma and international companies."
 },
 de: {
 q: "Muss man Deutsch sprechen, um im Tessin zu arbeiten?",
 a: "Nein, das Tessin ist italienischsprachig. Italienisch ist die Hauptsprache. Kenntnisse in Englisch und/oder Deutsch sind jedoch ein Wettbewerbsvorteil, insbesondere in Finanzen, Pharma und internationalen Unternehmen."
 },
 fr: {
 q: "Faut-il parler allemand pour travailler au Tessin ?",
 a: "Non, le Tessin est italophone. L'italien est la langue principale. Connaitre l'anglais et/ou l'allemand reste cependant un atout competitif, en particulier dans la finance, la pharma et les entreprises internationales."
 }
 },

 "Come si diventa frontaliere in Svizzera?": {
 en: {
 q: "How do you become a cross-border worker in Switzerland?",
 a: "You need: a Swiss employment contract, residence in a municipality within 20 km of the border, the G permit issued by the cantonal migration office, and AVS/BVG registration. The process takes about 2–4 weeks from contract signature."
 },
 de: {
 q: "Wie wird man Grenzgaenger in der Schweiz?",
 a: "Benoetigt werden: ein Schweizer Arbeitsvertrag, Wohnsitz in einer Gemeinde innerhalb von 20 km zur Grenze, die G-Bewilligung des kantonalen Migrationsamtes sowie die Anmeldung bei AHV/BVG. Der Prozess dauert nach Vertragsunterzeichnung ca. 2–4 Wochen."
 },
 fr: {
 q: "Comment devient-on frontalier en Suisse ?",
 a: "Il faut : un contrat de travail suisse, la residence dans une commune situee dans un rayon de 20 km de la frontiere, le permis G delivre par le service cantonal de la migration et l'affiliation AVS/LPP. La procedure prend environ 2 a 4 semaines apres la signature du contrat."
 }
 },

 "Quali documenti servono per il permesso G?": {
 en: {
 q: "Which documents are needed for the G permit?",
 a: "For an application in Ticino, follow the SPOP procedure and prepare the requested documents, including an identity-document copy certified as instructed by the canton. Apply before starting work. The fiscal 20 km rule is not a general EU/EFTA G-permit condition. Adult EU/EFTA issuance and renewal cost CHF 75; other categories and procedures have different fees. https://www4.ti.ch/di/spop/stranieri/richiesta-nuovo-g/"
 },
 de: {
 q: "Welche Unterlagen sind fuer die G-Bewilligung erforderlich?",
 a: "Für den Antrag im Tessin folgen Sie dem SPOP-Verfahren und bereiten die verlangten Unterlagen samt beglaubigter Ausweiskopie nach kantonalen Vorgaben vor. Beantragen Sie die Bewilligung vor Arbeitsbeginn. Die steuerliche 20-km-Regel ist keine allgemeine Voraussetzung der G-Bewilligung EU/EFTA. Erteilung und Verlängerung kosten für volljährige EU/EFTA-Angehörige CHF 75; andere Kategorien und Verfahren haben andere Gebühren. https://www4.ti.ch/di/spop/stranieri/richiesta-nuovo-g/"
 },
 fr: {
 q: "Quels documents sont necessaires pour le permis G ?",
 a: "Pour une demande au Tessin, suivez la procédure SPOP et préparez les documents requis, dont la copie de la pièce d’identité certifiée selon les instructions cantonales. Déposez la demande avant de commencer l’activité. La règle fiscale des 20 km n’est pas une condition générale du permis G UE/AELE. Délivrance et renouvellement pour majeurs UE/AELE: CHF 75; les autres catégories et démarches ont d’autres tarifs. https://www4.ti.ch/di/spop/stranieri/richiesta-nuovo-g/"
 }
 },

 "Quanto guadagna in media un frontaliere?": {
 en: {
 q: "How much does a cross-border worker earn on average?",
 a: "The median salary in Canton Ticino is about CHF 5,400/month gross (BFS 2024). After social deductions (AVS 5.3%, unemployment 1.1%, LAA, BVG) and withholding tax (8–15%), the net is about CHF 3,800–4,500 for a single person."
 },
 de: {
 q: "Wie viel verdient ein Grenzgaenger durchschnittlich?",
 a: "Der Medianlohn im Kanton Tessin liegt bei rund CHF 5.400/Monat brutto (BFS 2024). Nach Sozialabgaben (AHV 5,3 %, ALV 1,1 %, UVG, BVG) und Quellensteuer (8–15 %) betraegt der Nettolohn fuer Alleinstehende rund CHF 3.800–4.500."
 },
 fr: {
 q: "Combien gagne en moyenne un frontalier ?",
 a: "Le salaire median au Tessin est d'environ CHF 5 400/mois brut (OFS 2024). Apres deductions sociales (AVS 5,3 %, AC 1,1 %, LAA, LPP) et impot a la source (8 a 15 %), le net se situe autour de CHF 3 800–4 500 pour un celibataire."
 }
 },

 "Quali tasse paga un frontaliere nel 2026?": {
 en: {
 q: "Which taxes does a cross-border worker pay in 2026?",
 a: "Old cross-border workers (pre-17/07/2023) pay only Swiss withholding tax (8–15%). New cross-border workers pay Swiss withholding tax plus Italian IRPEF with a €10,000 exemption and a tax credit to avoid double taxation."
 },
 de: {
 q: "Welche Steuern zahlt ein Grenzgaenger 2026?",
 a: "Alte Grenzgaenger (vor dem 17.07.2023) zahlen nur die Schweizer Quellensteuer (8–15 %). Neue Grenzgaenger zahlen die Schweizer Quellensteuer zusammen mit der italienischen IRPEF, mit einem Freibetrag von 10.000 EUR und einer Steuergutschrift zur Vermeidung der Doppelbesteuerung."
 },
 fr: {
 q: "Quelles impots un frontalier paie-t-il en 2026 ?",
 a: "Les anciens frontaliers (avant le 17/07/2023) paient uniquement l'impot a la source suisse (8 a 15 %). Les nouveaux frontaliers paient l'impot a la source suisse plus l'IRPEF italien avec une franchise de 10 000 EUR et un credit d'impot pour eviter la double imposition."
 }
 },

 "Quanto costa vivere da frontaliere tra Italia e Svizzera?": {
 en: {
 q: "How much does it cost to live as a cross-border worker between Italy and Switzerland?",
 a: "Budget for housing, commuting, health cover and taxes using your actual situation. For LAMal, use the official annual table for your country of residence, age and accident cover. SSN costs depend on the applicable scheme: the specific Article 9 contribution for eligible cross-border workers is 3–6% of net Swiss salary, within EUR 30–200 per month worked, subject to regional implementation and applicable conditions. This is distinct from voluntary SSN enrolment; no single percentage applies to every cross-border worker."
 },
 de: {
 q: "Was kostet es, als Grenzgaenger zwischen Italien und der Schweiz zu leben?",
 a: "Beruecksichtigen Sie Wohnen, Pendeln, Krankenversicherung und Steuern anhand Ihrer konkreten Situation. Fuer LAMal gilt die offizielle Jahrestabelle nach Wohnsitzland, Alter und Unfalldeckung. SSN-Kosten haengen vom anwendbaren System ab: Der besondere Beitrag nach Artikel 9 betraegt fuer berechtigte Grenzgaenger 3–6 % des Schweizer Nettolohns, begrenzt auf EUR 30–200 je gearbeitetem Monat, unter den geltenden Voraussetzungen und gemaess regionaler Umsetzung. Er ist von der freiwilligen SSN-Einschreibung zu unterscheiden; es gibt keinen einheitlichen Satz fuer alle Grenzgaenger."
 },
 fr: {
 q: "Combien coute la vie de frontalier entre l'Italie et la Suisse ?",
 a: "Calculez logement, trajets, assurance maladie et impots selon votre situation reelle. Pour la LAMal, utilisez le tableau annuel officiel selon le pays de residence, l age et la couverture accident. Les couts SSN dependent du regime applicable : la contribution specifique de l article 9 pour les frontaliers eligibles est de 3–6 % du salaire suisse net, limitee a EUR 30–200 par mois travaille, sous les conditions applicables et selon la mise en oeuvre regionale. Elle est distincte de l inscription volontaire au SSN ; aucun taux unique ne concerne tous les frontaliers."
 }
 },

 // ── Currency exchange FAQ (confronti/exchange landing) ──
 "Qual è lo spread medio per cambiare franchi svizzeri in euro?": {
 en: { q: "What is the average spread for exchanging Swiss francs to euros?", a: "Bank spreads are typically 2–3% above the mid-market rate. Fintech apps like Wise and Revolut offer spreads of 0.3–0.5%, saving roughly 2% on every CHF→EUR conversion." },
 de: { q: "Wie hoch ist der durchschnittliche Spread beim Umtausch von Schweizer Franken in Euro?", a: "Die Spreads der Banken liegen in der Regel 2–3 % ueber dem Interbankenkurs. Fintech-Apps wie Wise und Revolut bieten Spreads von 0,3–0,5 % und sparen so rund 2 % bei jedem Umtausch CHF→EUR." },
 fr: { q: "Quel est le spread moyen pour changer des francs suisses en euros ?", a: "Les spreads bancaires sont generalement de 2 a 3 % au-dessus du cours interbancaire. Les applications fintech comme Wise et Revolut proposent des spreads de 0,3 a 0,5 %, ce qui permet d'economiser environ 2 % a chaque conversion CHF→EUR." }
 },
 "Quanto si risparmia usando Revolut Premium o Wise Borderless?": {
 en: { q: "How much do you save with Revolut Premium or Wise Borderless?", a: "On a CHF 6,500 monthly salary converted to EUR, a bank spread of 2% costs around CHF 130/month. Revolut Premium or Wise Borderless reduce that to about CHF 25/month, saving CHF 1,200+ per year." },
 de: { q: "Wie viel spart man mit Revolut Premium oder Wise Borderless?", a: "Bei einem Monatslohn von CHF 6.500, der in EUR umgetauscht wird, kostet ein Bankspread von 2 % rund CHF 130/Monat. Revolut Premium oder Wise Borderless senken diese Kosten auf etwa CHF 25/Monat und sparen mehr als CHF 1.200 pro Jahr." },
 fr: { q: "Combien economise-t-on avec Revolut Premium ou Wise Borderless ?", a: "Sur un salaire mensuel de CHF 6 500 converti en EUR, un spread bancaire de 2 % coute environ CHF 130/mois. Revolut Premium ou Wise Borderless reduisent ce cout a environ CHF 25/mois, soit plus de CHF 1 200 d'economies par an." }
 },
 "Le commissioni di cambio sono detraibili dalle tasse italiane?": {
 en: { q: "Are currency exchange fees tax-deductible in Italy?", a: "For private individuals, exchange fees are not deductible. Self-employed cross-border workers can deduct them as professional expenses if clearly linked to business activity and documented via invoices or bank statements." },
 de: { q: "Sind Wechselkursgebuehren in Italien steuerlich absetzbar?", a: "Fuer Privatpersonen sind Wechselkursgebuehren nicht abzugsfaehig. Selbststaendige Grenzgaenger koennen sie als Berufskosten abziehen, sofern sie eindeutig mit der Taetigkeit verbunden und durch Rechnungen oder Kontoauszuege belegt sind." },
 fr: { q: "Les frais de change sont-ils deductibles des impots italiens ?", a: "Pour les particuliers, les frais de change ne sont pas deductibles. Les frontaliers independants peuvent les deduire comme frais professionnels s'ils sont clairement lies a l'activite et documentes par des factures ou des releves bancaires." }
 },

 // ── Nursery / childcare (vita/nursery landing) ──
 "Quanto costa un asilo nido in Ticino rispetto all'Italia?": {
 en: { q: "How much does a nursery in Ticino cost compared with Italy?", a: "Public Ticino nurseries charge on a sliding scale (CHF 20–130/day based on household income). Italian nurseries cost €400–900/month. For many cross-border families a public Italian nursery remains cheaper once subsidies are applied." },
 de: { q: "Wie viel kostet eine Kinderkrippe im Tessin im Vergleich zu Italien?", a: "Oeffentliche Krippen im Tessin rechnen nach einem einkommensabhaengigen Tarif ab (CHF 20–130/Tag). Italienische Kinderkrippen kosten 400–900 EUR/Monat. Fuer viele Grenzgaenger-Familien bleibt die oeffentliche italienische Krippe nach Foerderungen guenstiger." },
 fr: { q: "Combien coute une creche au Tessin par rapport a l'Italie ?", a: "Les creches publiques tessinoises appliquent un tarif progressif (CHF 20 a 130/jour selon le revenu du menage). Les creches italiennes coutent 400 a 900 EUR/mois. Pour de nombreuses familles frontalieres, la creche publique italienne reste moins chere apres subventions." }
 },
 "Le famiglie di frontalieri hanno diritto a sussidi in Ticino?": {
 en: { q: "Are cross-border families entitled to subsidies in Ticino?", a: "Only B-permit residents qualify for full Ticino subsidies. G-permit cross-border workers do not receive cantonal childcare subsidies but may access Italian benefits (bonus nido INPS up to €3,000/year)." },
 de: { q: "Haben Grenzgaenger-Familien Anspruch auf Zuschuesse im Tessin?", a: "Nur Inhaber der B-Bewilligung haben Anspruch auf volle Tessiner Zuschuesse. Grenzgaenger mit G-Bewilligung erhalten keine kantonalen Kinderbetreuungszuschuesse, koennen aber italienische Leistungen nutzen (Bonus nido INPS bis zu 3.000 EUR/Jahr)." },
 fr: { q: "Les familles de frontaliers ont-elles droit a des subventions au Tessin ?", a: "Seuls les residents avec permis B ont droit aux subventions tessinoises completes. Les frontaliers avec permis G ne percoivent pas de subventions cantonales pour la garde d'enfants, mais peuvent acceder aux aides italiennes (bonus nido INPS jusqu'a 3 000 EUR/an)." }
 },
 "Posso detrarre fiscalmente le spese del nido in Italia?": {
 en: { q: "Can I deduct nursery expenses on my Italian tax return?", a: "Yes, nursery expenses are deductible from Italian IRPEF at 19% up to €632/year per child, plus the INPS bonus nido of up to €3,000/year based on ISEE (household income)." },
 de: { q: "Kann ich Kinderkrippenkosten in Italien steuerlich absetzen?", a: "Ja, Kinderkrippenkosten sind von der italienischen IRPEF zu 19 % bis zu 632 EUR/Jahr pro Kind absetzbar, zusaetzlich zum INPS-Bonus nido von bis zu 3.000 EUR/Jahr je nach ISEE (Haushaltseinkommen)." },
 fr: { q: "Puis-je deduire les frais de creche de mes impots italiens ?", a: "Oui, les frais de creche sont deductibles de l'IRPEF italien a 19 % jusqu'a 632 EUR/an par enfant, en plus du bonus nido INPS pouvant atteindre 3 000 EUR/an selon l'ISEE (revenu du menage)." }
 },
 "Come si entra in un nido comunale ticinese?": {
 en: { q: "How do you enrol a child in a municipal Ticino nursery?", a: "Each Ticino municipality keeps its own waiting list. You apply online or at the social services desk between January and March for the following school year, providing residence certificate, last tax return and employment contracts for both parents." },
 de: { q: "Wie meldet man ein Kind in einer kommunalen Tessiner Krippe an?", a: "Jede Tessiner Gemeinde fuehrt ihre eigene Warteliste. Die Anmeldung erfolgt online oder am Schalter der Sozialdienste zwischen Januar und Maerz fuer das folgende Schuljahr, mit Wohnsitzbescheinigung, letzter Steuererklaerung und Arbeitsvertraegen beider Elternteile." },
 fr: { q: "Comment inscrire un enfant dans une creche municipale tessinoise ?", a: "Chaque commune tessinoise tient sa propre liste d'attente. L'inscription se fait en ligne ou au guichet des services sociaux entre janvier et mars pour l'annee scolaire suivante, avec l'attestation de residence, la derniere declaration d'impots et les contrats de travail des deux parents." }
 },
 "Conviene mandare il bambino al nido in Italia o in Ticino?": {
 en: { q: "Is it better to send the child to a nursery in Italy or Ticino?", a: "If both parents cross the border, a Ticino nursery reduces the daily commute with the child. If only one works across the border, an Italian nursery is usually cheaper after subsidies and closer to home." },
 de: { q: "Besser Kind in die Krippe in Italien oder im Tessin?", a: "Wenn beide Elternteile pendeln, reduziert eine Tessiner Krippe das taegliche Pendeln mit dem Kind. Wenn nur einer pendelt, ist eine italienische Krippe nach Zuschuessen in der Regel guenstiger und wohnortnaeher." },
 fr: { q: "Vaut-il mieux mettre l'enfant en creche en Italie ou au Tessin ?", a: "Si les deux parents sont frontaliers, la creche au Tessin reduit les trajets quotidiens avec l'enfant. Si un seul parent est frontalier, la creche en Italie est generalement moins chere apres subventions et plus proche du domicile." }
 },

 // ── Blog index FAQ ──
 "Ogni quanto vengono aggiornati gli articoli per frontalieri?": {
 en: { q: "How often are the articles for cross-border workers updated?", a: "Editorial articles are reviewed monthly; tax and permit guides are refreshed when regulations change. Every article shows a 'dateModified' label so you can tell when content was last updated." },
 de: { q: "Wie oft werden die Grenzgaenger-Artikel aktualisiert?", a: "Redaktionelle Artikel werden monatlich ueberprueft; Steuer- und Bewilligungs-Guides werden bei Gesetzesaenderungen aktualisiert. Jeder Artikel zeigt ein 'dateModified'-Datum an, damit Sie den letzten Aktualisierungsstand erkennen." },
 fr: { q: "A quelle frequence les articles pour frontaliers sont-ils mis a jour ?", a: "Les articles editoriaux sont revus chaque mois ; les guides fiscaux et permis sont mis a jour lorsque les regles changent. Chaque article affiche une date 'dateModified' pour savoir quand le contenu a ete mis a jour." }
 },
 "Gli articoli coprono anche le novità del nuovo accordo fiscale 2024?": {
 en: { q: "Do the articles also cover updates on the new 2024 tax agreement?", a: "Yes: concurrent taxation, eligible municipalities, old-worker status, compensation payments and telework. Tax treatment for home telework up to 25% is distinct from the annual allowance of 45 failures to return home for professional reasons: those are not a remote-work day quota. https://www.bsv.admin.ch/it/newnsb/KIyFJwwqspqaOcHDaT7u0 https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 de: { q: "Behandeln die Artikel auch die Neuerungen des Steuerabkommens 2024?", a: "Ja: konkurrierende Besteuerung, zugelassene Gemeinden, Status alter Grenzgänger, Ausgleichszahlungen und Telearbeit. Die steuerliche Regelung für bis zu 25% Telearbeit zu Hause unterscheidet sich von 45 beruflich bedingten Nichtrückkehrtagen pro Jahr: Diese sind kein Homeoffice-Tagekontingent. https://www.bsv.admin.ch/it/newnsb/KIyFJwwqspqaOcHDaT7u0 https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 fr: { q: "Les articles couvrent-ils aussi les nouveautes du nouvel accord fiscal 2024 ?", a: "Oui : imposition concurrente, communes admises, statut des anciens frontaliers, compensations et télétravail. Le régime fiscal du télétravail à domicile jusqu’à 25% est distinct des 45 non-retours annuels pour raisons professionnelles : ceux-ci ne constituent pas un quota de jours de télétravail. https://www.bsv.admin.ch/it/newnsb/KIyFJwwqspqaOcHDaT7u0 https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" }
 },
 "Posso usare gli articoli per confrontare Permesso G e Permesso B?": {
 en: { q: "Can I use the articles to compare G permit and B permit?", a: "Yes, the 'Permits' guide and the 'G vs B' comparator break down tax, healthcare, pension and residency implications of each permit with side-by-side examples." },
 de: { q: "Kann ich die Artikel nutzen, um G- und B-Bewilligung zu vergleichen?", a: "Ja, der Bewilligungs-Guide und der Vergleich 'G vs B' erlaeutern die Auswirkungen auf Steuern, Krankenversicherung, Vorsorge und Wohnsitz fuer jede Bewilligung mit Beispielen im direkten Vergleich." },
 fr: { q: "Puis-je utiliser les articles pour comparer le permis G et le permis B ?", a: "Oui, le guide 'Permis' et le comparateur 'G vs B' detaillent les consequences fiscales, sanitaires, de prevoyance et de residence de chaque permis avec des exemples mis en parallele." }
 },
 "Dove trovo le statistiche aggiornate su stipendi e mercato del lavoro frontaliero?": {
 en: { q: "Where can I find up-to-date statistics on salaries and the cross-border job market?", a: "The 'Statistiche' section gathers Ticino salary observatory data, unemployment, customs traffic and weekly job-market snapshots, all refreshed automatically from official Swiss and Italian sources." },
 de: { q: "Wo finde ich aktuelle Statistiken zu Loehnen und Grenzgaenger-Arbeitsmarkt?", a: "Die Rubrik 'Statistiche' buendelt Daten des Tessiner Lohnobservatoriums, Arbeitslosigkeit, Grenzverkehr und woechentliche Arbeitsmarkt-Snapshots, automatisch aktualisiert aus offiziellen Schweizer und italienischen Quellen." },
 fr: { q: "Ou trouver les statistiques a jour sur les salaires et le marche du travail frontalier ?", a: "La section 'Statistiche' regroupe les donnees de l'observatoire des salaires tessinois, le chomage, le trafic douanier et des snapshots hebdomadaires du marche de l'emploi, mis a jour automatiquement a partir de sources officielles suisses et italiennes." }
 },
 "Gli articoli sostituiscono una consulenza professionale?": {
 en: { q: "Do the articles replace professional advice?", a: "No. The articles are editorial and educational content. For specific tax, legal or pension questions always consult a certified accountant, tax lawyer or pension adviser specialised in cross-border work." },
 de: { q: "Ersetzen die Artikel eine professionelle Beratung?", a: "Nein. Die Artikel sind redaktionelle und informative Inhalte. Bei konkreten Steuer-, Rechts- oder Vorsorgefragen wenden Sie sich stets an eine zertifizierte Steuerberatung, einen Fachanwalt oder einen auf Grenzgaenger spezialisierten Vorsorgeberater." },
 fr: { q: "Les articles remplacent-ils un conseil professionnel ?", a: "Non. Les articles sont des contenus editoriaux et pedagogiques. Pour des questions fiscales, juridiques ou de prevoyance specifiques, consultez toujours un expert-comptable certifie, un avocat fiscaliste ou un conseiller de prevoyance specialise en travail frontalier." }
 },

 // ── Tassazione hub FAQ ──
 "Qual è la differenza fiscale tra vecchi e nuovi frontalieri nel 2026?": {
 en: { q: "What is the tax difference between old and new cross-border workers in 2026?", a: "For new fiscal cross-border workers, Switzerland applies 80% of its ordinary withholding rate; Italy taxes the income with a credit for Swiss tax. The 80% is not a revenue split between the two countries. Old cross-border workers who qualify under Article 9 retain exclusive Swiss taxation of the covered salary. Their regime does not automatically end in 2033 or 2034: 2033 is the final tax year of Swiss compensation payments to Italy. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 de: { q: "Worin besteht der steuerliche Unterschied zwischen alten und neuen Grenzgaengern 2026?", a: "Für neue steuerliche Grenzgänger wendet die Schweiz 80% des ordentlichen Quellensteuertarifs an; Italien besteuert das Einkommen mit Anrechnung der Schweizer Steuer. Die 80% sind keine Aufteilung der Einnahmen zwischen den Staaten. Alte Grenzgänger, die Artikel 9 erfüllen, behalten die ausschliessliche Schweizer Besteuerung des erfassten Lohns. Das Regime endet nicht automatisch 2033 oder 2034; 2033 ist das letzte Steuerjahr der Ausgleichszahlungen an Italien. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 fr: { q: "Quelle est la difference fiscale entre anciens et nouveaux frontaliers en 2026 ?", a: "Pour les nouveaux frontaliers fiscaux, la Suisse applique 80% du taux ordinaire de retenue; l’Italie impose le revenu en accordant un crédit pour l’impôt suisse. Les 80% ne sont pas un partage des recettes entre les États. Les anciens frontaliers remplissant les conditions de l’article 9 conservent l’imposition exclusivement suisse du salaire concerné. Ce régime ne prend pas automatiquement fin en 2033 ou 2034; 2033 est la dernière année fiscale des compensations versées à l’Italie. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" }
 },
 "Come si evita la doppia imposizione fiscale Italia-Svizzera?": {
 en: { q: "How do you avoid Italy-Switzerland double taxation?", a: "New cross-border workers declare Swiss income in the Italian return and apply a tax credit equal to the Swiss withholding tax already paid (capped at the IRPEF due on the same income). Old cross-border workers are exempt because they pay only in Switzerland." },
 de: { q: "Wie vermeidet man die Doppelbesteuerung Italien-Schweiz?", a: "Neue Grenzgaenger geben das Schweizer Einkommen in der italienischen Steuererklaerung an und nehmen eine Steuergutschrift in Hoehe der bereits gezahlten Schweizer Quellensteuer in Anspruch (begrenzt auf die IRPEF auf das gleiche Einkommen). Alte Grenzgaenger sind befreit, da sie nur in der Schweiz zahlen." },
 fr: { q: "Comment eviter la double imposition Italie-Suisse ?", a: "Les nouveaux frontaliers declarent le revenu suisse dans la declaration italienne et appliquent un credit d'impot egal a l'impot a la source suisse deja paye (plafonne a l'IRPEF due sur le meme revenu). Les anciens frontaliers en sont exoneres car ils ne paient qu'en Suisse." }
 },
 "Quali sono le aliquote dell'imposta alla fonte in Canton Ticino nel 2026?": {
 en: { q: "What are the 2026 withholding tax rates in Canton Ticino?", a: "Ticino withholding tax rates are progressive, from 0% up to about 15% on gross salary, adjusted for civil status and dependent children. Detailed brackets are published annually in the Tariffa IF." },
 de: { q: "Wie hoch sind die Quellensteuersaetze im Kanton Tessin 2026?", a: "Die Tessiner Quellensteuersaetze sind progressiv und reichen von 0 % bis rund 15 % des Bruttolohns, angepasst an Zivilstand und unterhaltsberechtigte Kinder. Die Tarifstufen werden jaehrlich in der Tariffa IF veroeffentlicht." },
 fr: { q: "Quels sont les taux de l'impot a la source au Canton Tessin en 2026 ?", a: "Les taux de l'impot a la source tessinois sont progressifs, de 0 % jusqu'a environ 15 % du salaire brut, ajustes selon l'etat civil et les enfants a charge. Les tranches detaillees sont publiees chaque annee dans la Tariffa IF." }
 },
 "Quale permesso conviene: G o B per motivi fiscali?": {
 en: { q: "Which permit is better for tax reasons: G or B?", a: "G permits concern residence abroad and at least weekly return; B permits concern residence in Switzerland. The permit alone does not determine taxation: G holders may qualify as old fiscal frontier workers, new ones or fall outside the agreement. Compare actual residence, income and household costs rather than using a universal salary threshold. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 de: { q: "Welche Bewilligung ist steuerlich besser: G oder B?", a: "Die G-Bewilligung betrifft Wohnsitz im Ausland mit mindestens wöchentlicher Rückkehr, die B-Bewilligung den Aufenthalt in der Schweiz. Die Bewilligung allein bestimmt die Steuern nicht: Bei G sind alte und neue steuerliche Grenzgänger sowie Personen ausserhalb des Abkommens zu unterscheiden. Massgeblich sind tatsächlicher Wohnsitz, Einkommen und Haushaltskosten, keine pauschale Lohngrenze. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 fr: { q: "Quel permis est le plus avantageux fiscalement : G ou B ?", a: "Le permis G implique un domicile à l’étranger et un retour au moins hebdomadaire ; le B concerne le séjour en Suisse. Le permis seul ne détermine pas les impôts : les titulaires G peuvent relever des anciens frontaliers fiscaux, des nouveaux ou être hors accord. Comparer résidence effective, revenu et frais du ménage sans seuil salarial universel. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" }
 },
 "Quali deduzioni fiscali possono richiedere i frontalieri?": {
 en: { q: "Which tax deductions can cross-border workers claim?", a: "There is no list of additional deductions applying to every frontier worker. Distinguish Italian filing, Swiss tax status and correction of withholding errors. ESTV FAQ 5.3 excludes subsequent ordinary assessment (TOU) for fiscal frontier workers covered by the Italy–Switzerland agreement. Other categories must check eligibility and procedure with the tax authority. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 de: { q: "Welche Abzuege koennen Grenzgaenger geltend machen?", a: "Es gibt keine für alle Grenzgänger geltende Liste zusätzlicher Abzüge. Italienische Steuererklärung, Schweizer Steuerstatus und Korrektur von Quellensteuerfehlern sind zu unterscheiden. Laut ESTV-FAQ 5.3 ist die nachträgliche ordentliche Veranlagung für steuerliche Grenzgänger des Abkommens Italien–Schweiz ausgeschlossen. Andere Kategorien müssen Voraussetzungen und Verfahren bei der Steuerbehörde prüfen. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 fr: { q: "Quelles deductions fiscales les frontaliers peuvent-ils demander ?", a: "Aucune liste de déductions supplémentaires ne vaut pour tous les frontaliers. Distinguer déclaration italienne, statut fiscal suisse et correction des erreurs de retenue. La FAQ 5.3 de l’AFC exclut la taxation ordinaire ultérieure pour les frontaliers fiscaux de l’accord Italie–Suisse. Les autres catégories doivent vérifier les conditions et la procédure auprès de l’autorité fiscale. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" }
 },
 "Come si calcola il credito d'imposta per le tasse pagate in Svizzera?": {
 en: { q: "How is the tax credit for taxes paid in Switzerland calculated?", a: "The credit equals the Swiss withholding tax paid, capped at the Italian IRPEF due on the same income. It is reported in Box CE of the Redditi PF form (or Box G of the 730) using the Swiss Lohnausweis to document withholdings." },
 de: { q: "Wie berechnet sich die Anrechnung der in der Schweiz gezahlten Steuer?", a: "Die Gutschrift entspricht der gezahlten Schweizer Quellensteuer, begrenzt auf die italienische IRPEF auf dasselbe Einkommen. Sie wird im Feld CE des Formulars Redditi PF (oder Feld G des 730) anhand des Schweizer Lohnausweises als Nachweis des Quellensteuerabzugs angegeben." },
 fr: { q: "Comment calcule-t-on le credit d'impot pour les impots payes en Suisse ?", a: "Le credit egale l'impot a la source suisse paye, plafonne a l'IRPEF italien du sur le meme revenu. Il se declare dans le cadre CE du formulaire Redditi PF (ou cadre G du 730) en utilisant le Lohnausweis suisse pour justifier les retenues." }
 },
 "Quali sono i casi particolari: telelavoro, lavoro in più cantoni, pensionati?": {
 en: { q: "What are the special cases: teleworking, work in multiple cantons, pensioners?", a: "Teleworking: the Italy-Switzerland protocol allows up to 25% remote work without losing cross-border status. Multiple cantons: tax is split pro-rata by actual working days. Pensioners: Swiss AVS pensions are taxed in Italy except for the 5% Swiss exemption for old cross-border workers." },
 de: { q: "Was sind die Sonderfaelle: Homeoffice, Arbeit in mehreren Kantonen, Rentner?", a: "Homeoffice: das Protokoll Italien-Schweiz erlaubt bis zu 25 % Fernarbeit, ohne den Grenzgaenger-Status zu verlieren. Mehrere Kantone: die Steuer wird pro rata nach den tatsaechlichen Arbeitstagen aufgeteilt. Rentner: Schweizer AHV-Renten werden in Italien besteuert, ausser den 5 % Schweizer Freibetrag fuer alte Grenzgaenger." },
 fr: { q: "Quels sont les cas particuliers : teletravail, travail dans plusieurs cantons, retraites ?", a: "Teletravail : le protocole Italie-Suisse autorise jusqu'a 25 % de teletravail sans perdre le statut de frontalier. Plusieurs cantons : l'impot est reparti au prorata des jours effectivement travailles. Retraites : les rentes AVS suisses sont imposees en Italie, sauf la franchise suisse de 5 % pour les anciens frontaliers." }
 },
 "Quali sono gli errori fiscali più comuni dei frontalieri?": {
 en: { q: "What are the most common tax mistakes made by cross-border workers?", a: "Confusing permit and tax status, automatically applying allowances or deductions and assuming a Swiss refund can produce incorrect calculations. Check obligations in each country and retain salary and tax certificates. ESTV FAQ 5.3 excludes subsequent ordinary assessment (TOU) for fiscal frontier workers covered by the Italy–Switzerland agreement. Other categories must check eligibility and procedure with the tax authority. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 de: { q: "Was sind die haeufigsten Steuerfehler der Grenzgaenger?", a: "Bewilligung und Steuerstatus zu verwechseln, Freibeträge automatisch anzusetzen oder eine Schweizer Rückerstattung vorauszusetzen kann zu Fehlern führen. Pflichten in beiden Ländern prüfen und Lohn- sowie Steuerbelege aufbewahren. Laut ESTV-FAQ 5.3 ist die nachträgliche ordentliche Veranlagung für steuerliche Grenzgänger des Abkommens Italien–Schweiz ausgeschlossen. Andere Kategorien müssen Voraussetzungen und Verfahren bei der Steuerbehörde prüfen. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 fr: { q: "Quelles sont les erreurs fiscales les plus frequentes des frontaliers ?", a: "Confondre permis et statut fiscal, appliquer automatiquement franchises ou déductions et présumer un remboursement suisse peut fausser le calcul. Vérifier les obligations dans les deux pays et conserver certificats de salaire et attestations fiscales. La FAQ 5.3 de l’AFC exclut la taxation ordinaire ultérieure pour les frontaliers fiscaux de l’accord Italie–Suisse. Les autres catégories doivent vérifier les conditions et la procédure auprès de l’autorité fiscale. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" }
 },
 "Come si compila la dichiarazione dei redditi per frontalieri nel 2026?": {
 en: { q: "How do you fill in the 2026 tax return as a cross-border worker?", a: "Start with the salary certificate and Swiss tax statements, then check tax status, taxable income, allowance and tax credit against the year’s Italian instructions. Do not assume every frontier worker needs a TOU receipt. ESTV FAQ 5.3 excludes subsequent ordinary assessment (TOU) for fiscal frontier workers covered by the Italy–Switzerland agreement. Other categories must check eligibility and procedure with the tax authority. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 de: { q: "Wie fuellt man als Grenzgaenger die Steuererklaerung 2026 aus?", a: "Ausgehend von Lohnausweis und Schweizer Steuerbelegen Steuerstatus, Bemessungsgrundlage, Freibetrag und Anrechnung nach den italienischen Jahresvorgaben prüfen. Ein TOU-Beleg ist nicht für jeden Grenzgänger vorauszusetzen. Laut ESTV-FAQ 5.3 ist die nachträgliche ordentliche Veranlagung für steuerliche Grenzgänger des Abkommens Italien–Schweiz ausgeschlossen. Andere Kategorien müssen Voraussetzungen und Verfahren bei der Steuerbehörde prüfen. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 fr: { q: "Comment remplir la declaration d'impots frontalier en 2026 ?", a: "Partir du certificat de salaire et des attestations fiscales suisses, puis vérifier régime, revenu imposable, franchise et crédit selon les instructions italiennes de l’année. Un justificatif de taxation ordinaire ultérieure n’est pas requis pour tout frontalier. La FAQ 5.3 de l’AFC exclut la taxation ordinaire ultérieure pour les frontaliers fiscaux de l’accord Italie–Suisse. Les autres catégories doivent vérifier les conditions et la procédure auprès de l’autorité fiscale. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" }
 },
 "Come funziona il regime dei vecchi frontalieri?": {
 en: { q: "How does the old cross-border worker regime work?", a: "Old cross-border workers who qualify under Article 9 retain exclusive Swiss taxation of the covered salary. Their regime does not automatically end in 2033 or 2034: 2033 is the final tax year of Swiss compensation payments to Italy. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 de: { q: "Wie funktioniert das Steuerregime alter Grenzgänger?", a: "Alte Grenzgänger, die Artikel 9 erfüllen, behalten die ausschliessliche Schweizer Besteuerung des erfassten Lohns. Das Regime endet nicht automatisch 2033 oder 2034; 2033 ist das letzte Steuerjahr der Ausgleichszahlungen an Italien. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 fr: { q: "Comment fonctionne le régime des anciens frontaliers ?", a: "Les anciens frontaliers remplissant les conditions de l’article 9 conservent l’imposition exclusivement suisse du salaire concerné. Ce régime ne prend pas automatiquement fin en 2033 ou 2034; 2033 est la dernière année fiscale des compensations versées à l’Italie. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" }
 },
 "Cosa cambia con il Nuovo Accordo del 17 luglio 2023?": {
 en: { q: "What changes with the New Agreement of 17 July 2023?", a: "The agreement entered into force on 17 July 2023 and applies from 1 January 2024. New tax frontier workers pay 80% of ordinary Swiss withholding and Italian tax with credit for Swiss tax. Qualifying old workers retain exclusive Swiss taxation of the covered salary under Article 9. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 de: { q: "Was aendert sich mit dem Neuen Abkommen vom 17. Juli 2023?", a: "Das Abkommen trat am 17. Juli 2023 in Kraft und gilt seit 1. Januar 2024. Neue steuerliche Grenzgänger zahlen 80% der ordentlichen Schweizer Quellensteuer sowie italienische Steuer mit Anrechnung der Schweizer Steuer. Qualifizierte alte Grenzgänger behalten nach Artikel 9 die ausschliessliche Schweizer Besteuerung des erfassten Lohns. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 fr: { q: "Qu'est-ce qui change avec le Nouvel Accord du 17 juillet 2023 ?", a: "L’accord est entré en vigueur le 17 juillet 2023 et s’applique depuis le 1er janvier 2024. Les nouveaux frontaliers fiscaux paient 80% de l’impôt suisse à la source ordinaire et l’impôt italien avec crédit pour l’impôt suisse. Les anciens frontaliers admissibles conservent l’imposition exclusivement suisse du salaire concerné selon l’article 9. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" }
 },

 // ── Tassa salute landing FAQ ──
 "Cos'è la tassa salute per i frontalieri?": {
 en: { q: "What is the cross-border health contribution?", a: "The Italian SSN contribution is established by Law 213/2023, Article 1(237–239), and the decree of 14 November 2025. It covers the statutory categories, including existing cross-border workers under Article 9 who opted for Italian healthcare, and dependent family members. It is not a Swiss tax limited to new workers." },
 de: { q: "Was ist die Gesundheitsabgabe fuer Grenzgaenger?", a: "Der italienische SSN-Beitrag beruht auf Gesetz 213/2023, Artikel 1 Absätze 237–239, und dem Dekret vom 14. November 2025. Er betrifft die gesetzlich erfassten Gruppen, darunter bisherige Grenzgänger nach Artikel 9 mit Wahl der italienischen Gesundheitsversorgung sowie unterhaltsberechtigte Familienangehörige. Er ist keine Schweizer Steuer nur für neue Grenzgänger." },
 fr: { q: "Qu'est-ce que la contribution sante pour frontaliers ?", a: "La contribution au SSN italien repose sur la loi 213/2023, article 1, alinéas 237–239, et le décret du 14 novembre 2025. Elle concerne les catégories légales, dont les anciens frontaliers de l'article 9 ayant opté pour la couverture italienne, et les membres de famille à charge. Ce n'est pas un impôt suisse réservé aux nouveaux frontaliers." }
 },
 "Quanto è la tassa salute frontalieri nel 2026?": {
 en: { q: "How much is the 2026 cross-border health contribution?", a: "The statutory range is 3–6% of Swiss net salary, with a progressive family contribution and limits of EUR 30–200 per month worked, which may double for omitted payment or reporting. The competent region or autonomous province sets the annual contribution: check its implementing measure for the 2026 amount and deadline rather than automatically applying 6%." },
 de: { q: "Wie hoch ist die Gesundheitsabgabe der Grenzgaenger 2026?", a: "Der gesetzliche Rahmen beträgt 3–6% des Schweizer Nettolohns, mit einem progressiven Familienbeitrag und Grenzen von 30–200 Euro je gearbeitetem Monat; bei unterlassener Zahlung oder Meldung können diese verdoppelt werden. Die zuständige Region oder autonome Provinz legt den Jahresbeitrag fest. Für Betrag und Frist 2026 ist deren Umsetzungsvorschrift zu prüfen; 6% gelten nicht automatisch." },
 fr: { q: "Combien s'eleve la contribution sante des frontaliers en 2026 ?", a: "La fourchette légale est de 3–6% du salaire net suisse, avec une contribution familiale progressive et des limites de 30–200 euros par mois travaillé, pouvant doubler en cas de défaut de paiement ou de déclaration. La région ou province autonome compétente fixe la contribution annuelle. Pour le montant et l'échéance 2026, consultez sa décision d'application plutôt que d'appliquer automatiquement 6%." }
 },
 "I vecchi frontalieri devono pagare la tassa salute?": {
 en: { q: "Do old cross-border workers have to pay the health contribution?", a: "Existing cross-border workers are not excluded: the law expressly refers to Article 9(1) workers who exercised the SSN option. Healthcare coverage, individual circumstances and territorial measures must be checked; a G permit or hiring date alone is insufficient." },
 de: { q: "Muessen alte Grenzgaenger die Gesundheitsabgabe zahlen?", a: "Bisherige Grenzgänger sind nicht generell befreit: Das Gesetz nennt ausdrücklich Grenzgänger nach Artikel 9 Absatz 1, die das Optionsrecht zugunsten des SSN ausgeübt haben. Versicherung, persönliche Voraussetzungen und regionale Vorschriften sind zu prüfen; G-Bewilligung oder Einstellungsdatum allein reichen nicht." },
 fr: { q: "Les anciens frontaliers doivent-ils payer la contribution sante ?", a: "Les anciens frontaliers ne sont pas exclus: la loi vise expressément ceux de l'article 9, paragraphe 1, ayant exercé l'option pour le SSN. Il faut vérifier la couverture, la situation personnelle et les décisions territoriales; le permis G ou la date d'embauche ne suffisent pas." }
 },
 "Chi incassa materialmente la tassa salute frontalieri?": {
 en: { q: "Who actually collects the cross-border health contribution?", a: "The decree of 14 November 2025 provides for annual payments by the persons concerned directly to the region or Autonomous Province of Bolzano through the payment channels under Article 5 of Italy's Digital Administration Code. It does not provide for Swiss payroll withholding or transfers via the Swiss Confederation." },
 de: { q: "Wer erhebt die Grenzgaenger-Gesundheitsabgabe tatsaechlich?", a: "Das Dekret vom 14. November 2025 sieht jährliche Zahlungen der Betroffenen direkt an die Region oder Autonome Provinz Bozen über die Zahlungswege nach Artikel 5 des italienischen Kodex der digitalen Verwaltung vor. Es sieht weder einen Schweizer Lohnabzug noch eine Überweisung durch den Bund vor." },
 fr: { q: "Qui percoit effectivement la contribution sante frontaliers ?", a: "Le décret du 14 novembre 2025 prévoit un paiement annuel des intéressés directement à la région ou à la Province autonome de Bolzano, par les moyens de paiement de l'article 5 du Code italien de l'administration numérique. Il ne prévoit ni retenue sur salaire suisse ni transfert par la Confédération." }
 },
 "La tassa salute è detraibile in dichiarazione dei redditi?": {
 en: { q: "Is the health contribution tax-deductible?", a: "Do not automatically claim it as a credit for Swiss taxes: this contribution funds Italian healthcare. Check the tax instructions applicable to your circumstances with a tax adviser and retain the payment receipt and the competent authority's notice." },
 de: { q: "Kann die Gesundheitsabgabe in der Steuererklaerung abgezogen werden?", a: "Der Beitrag darf nicht automatisch als Schweizer Steuer angerechnet werden: Er finanziert die italienische Gesundheitsversorgung. Prüfen Sie die für Ihren Fall geltenden Steueranweisungen mit einer Fachperson und bewahren Sie Zahlungsbeleg und Mitteilung der zuständigen Behörde auf." },
 fr: { q: "La contribution sante est-elle deductible de la declaration d'impots ?", a: "Ne la déclarez pas automatiquement comme crédit pour impôts suisses: cette contribution finance les soins italiens. Vérifiez les instructions fiscales adaptées à votre situation avec un conseiller et conservez le reçu ainsi que l'avis de l'autorité compétente." }
 },
 "Tassa salute e LAMal sono la stessa cosa?": {
 en: { q: "Is the health contribution the same as LAMal?", a: "No. LAMal concerns Swiss health insurance; the Italian contribution depends on statutory categories and conditions. Not every new cross-border worker automatically owes both: the right of option and individual healthcare status must be checked." },
 de: { q: "Sind die Gesundheitsabgabe und die KVG dasselbe?", a: "Nein. KVG/LAMal betrifft die Schweizer Krankenversicherung; der italienische Beitrag richtet sich nach gesetzlichen Personengruppen und Voraussetzungen. Neue Grenzgänger schulden nicht automatisch beides: Optionsrecht und individuelle Versicherungssituation sind zu prüfen." },
 fr: { q: "La contribution sante et la LAMal sont-elles la meme chose ?", a: "Non. La LAMal concerne l'assurance maladie suisse; la contribution italienne dépend des catégories et conditions légales. Chaque nouveau frontalier ne doit pas automatiquement payer les deux: le droit d'option et la couverture individuelle doivent être vérifiés." }
 },

 // ── LAMal landing FAQ ──
 "Cos'è la LAMal e come si applica ai frontalieri?": {
 en: { q: "What is LAMal and how does it apply to cross-border workers?", a: "LAMal is the Swiss compulsory health insurance. G permit cross-border workers can opt for LAMal or the Italian SSN (right-of-option form to file within 90 days of starting work); B permit residents must join LAMal." },
 de: { q: "Was ist die KVG und wie gilt sie fuer Grenzgaenger?", a: "Die KVG (LAMal) ist die obligatorische Schweizer Krankenversicherung. Grenzgaenger mit G-Bewilligung koennen zwischen KVG und italienischem SSN waehlen (Optionsformular innerhalb von 90 Tagen ab Arbeitsbeginn); B-Bewilligungsinhaber muessen sich bei der KVG versichern." },
 fr: { q: "Qu'est-ce que la LAMal et comment s'applique-t-elle aux frontaliers ?", a: "La LAMal est l'assurance maladie obligatoire suisse. Les frontaliers avec permis G peuvent opter pour la LAMal ou le SSN italien (formulaire de droit d'option a deposer dans les 90 jours suivant la prise d'emploi) ; les residents avec permis B doivent adherer a la LAMal." }
 },
 "Quanto costa la LAMal a un frontaliere nel 2026?": {
 en: { q: "How much does LAMal cost a cross-border worker in 2026?", a: "Cross-border workers resident in Italy pay country-of-residence LAMal premiums, not premiums for their Swiss canton of employment. The official FOPH 2026 Italy table lists 14 insurers with separate age and accident-cover rates. For adults aged 26+ without accident cover, monthly premiums range from CHF 279 to CHF 487.20; the ordinary deductible is CHF 300 (CHF 0 for children). Optional deductibles and HMO/Telmed models are unavailable. Source: https://www.priminfo.admin.ch/downloads/praemien_eu_2026.pdf" },
 de: { q: "Was kostet die KVG einen Grenzgaenger 2026?", a: "Für Grenzgänger mit Wohnsitz in Italien gelten die KVG-Prämien des Wohnsitzlands, nicht des Schweizer Arbeitskantons. Die offizielle BAG-Tabelle 2026 für Italien nennt 14 Versicherer mit getrennten Prämien nach Alter und Unfalldeckung. Für Erwachsene ab 26 ohne Unfalldeckung liegen die Monatsprämien zwischen CHF 279 und CHF 487.20; die ordentliche Franchise beträgt CHF 300 (CHF 0 für Kinder). Wahlfranchisen und HMO/Telmed-Modelle sind nicht verfügbar. Quelle: https://www.priminfo.admin.ch/downloads/praemien_eu_2026.pdf" },
 fr: { q: "Combien coute la LAMal a un frontalier en 2026 ?", a: "Les frontaliers résidant en Italie paient les primes LAMal du pays de domicile, et non celles du canton de travail suisse. Le tableau officiel OFSP 2026 pour l’Italie comprend 14 assureurs et distingue âge et couverture accidents. Pour les adultes dès 26 ans sans couverture accidents, les primes mensuelles vont de CHF 279 à CHF 487.20 ; la franchise ordinaire est CHF 300 (CHF 0 pour enfants). Les franchises à option et modèles HMO/Telmed ne sont pas disponibles. Source : https://www.priminfo.admin.ch/downloads/praemien_eu_2026.pdf" }
 },
 "Meglio scegliere LAMal o SSN italiano come frontaliere?": {
 en: { q: "Should a cross-border worker choose LAMal or the Italian SSN?", a: "LAMal covers care in Switzerland and in Italy via agreements, with greater flexibility but monthly premiums of CHF 280-480. SSN is free but covers only Italy; Swiss emergencies are covered with the European card. Many cross-border workers choose LAMal for convenient Ticino access." },
 de: { q: "Ist es besser, als Grenzgaenger KVG oder italienischen SSN zu waehlen?", a: "Die KVG deckt die Versorgung in der Schweiz und in Italien ueber Abkommen ab, mit mehr Flexibilitaet, jedoch mit Monatspraemien von CHF 280-480. Der SSN ist kostenlos, deckt aber nur Italien ab; Schweizer Notfaelle werden mit der Europaeischen Karte gedeckt. Viele Grenzgaenger waehlen die KVG fuer den bequemen Zugang im Tessin." },
 fr: { q: "Vaut-il mieux choisir la LAMal ou le SSN italien comme frontalier ?", a: "La LAMal couvre les soins en Suisse et en Italie via des accords, avec plus de souplesse, mais des primes mensuelles de CHF 280 a 480. Le SSN est gratuit mais couvre uniquement l'Italie ; les urgences suisses sont prises en charge avec la carte europeenne. Beaucoup de frontaliers choisissent la LAMal pour un acces pratique au Tessin." }
 },
 "Si può cambiare cassa malati dopo aver scelto la LAMal?": {
 en: { q: "Can you change health fund after opting for LAMal?", a: "Yes. Health fund changes take effect on 1 January or 1 July, with notice by 30 November (or 31 March for July). Basic LAMal coverage is identical across funds, so you only compare premiums." },
 de: { q: "Kann man nach der Wahl der KVG die Krankenkasse wechseln?", a: "Ja. Kassenwechsel werden zum 1. Januar oder 1. Juli wirksam, mit Kuendigung bis zum 30. November (bzw. 31. Maerz fuer den 1. Juli). Die KVG-Grundleistungen sind bei allen Kassen identisch; verglichen werden nur die Praemien." },
 fr: { q: "Peut-on changer de caisse maladie apres avoir choisi la LAMal ?", a: "Oui. Les changements de caisse prennent effet au 1er janvier ou 1er juillet, moyennant un preavis au 30 novembre (ou au 31 mars pour le 1er juillet). La couverture LAMal de base est identique d'une caisse a l'autre ; seules les primes se comparent." }
 },
 "I familiari del frontaliere sono coperti dalla LAMal?": {
 en: { q: "Are family members of a cross-border worker covered by LAMal?", a: "Yes. A G-permit cross-border worker can extend LAMal to their spouse and minor children without gainful activity, each with their own premium (approx. CHF 200-400 for the spouse, CHF 120-200 per child). Alternatively, family members can stay on the Italian SSN." },
 de: { q: "Sind Familienangehoerige des Grenzgaengers in der KVG versichert?", a: "Ja. Ein Grenzgaenger mit G-Bewilligung kann die KVG auf den nicht erwerbstaetigen Ehepartner und minderjaehrige Kinder ausdehnen, jeweils mit eigener Praemie (ca. CHF 200-400 fuer den Ehepartner, CHF 120-200 pro Kind). Alternativ bleiben die Angehoerigen im italienischen SSN." },
 fr: { q: "Les proches du frontalier sont-ils couverts par la LAMal ?", a: "Oui. Un frontalier avec permis G peut etendre la LAMal a son conjoint sans activite lucrative et aux enfants mineurs, avec une prime propre (environ CHF 200-400 pour le conjoint, CHF 120-200 par enfant). Les proches peuvent aussi rester au SSN italien." }
 },
 "La LAMal è detraibile dalle tasse italiane?": {
 en: { q: "Is LAMal tax-deductible in Italy?", a: "LAMal premiums are deductible in Italy up to €1,291 per year (Law 296/2006 ceiling for health insurance). The portion above is a cost but does not reduce IRPEF. Keep the annual premium statement from your health fund as proof." },
 de: { q: "Ist die KVG in Italien steuerlich absetzbar?", a: "Die KVG-Praemien sind in Italien bis 1.291 EUR pro Jahr abzugsfaehig (Hoechstbetrag fuer Krankenversicherungen gemaess Gesetz 296/2006). Der darueber hinausgehende Teil ist ein Kostenfaktor, reduziert aber die IRPEF nicht. Die jaehrliche Praemienbescheinigung der Krankenkasse ist als Nachweis aufzubewahren." },
 fr: { q: "La LAMal est-elle deductible des impots italiens ?", a: "Les primes LAMal sont deductibles en Italie jusqu'a 1 291 EUR par an (plafond de la loi 296/2006 pour l'assurance maladie). La part au-dela est un cout qui ne reduit pas l'IRPEF. Conservez l'attestation annuelle de primes fournie par la caisse." }
 },

 // ── Fox Town outlet FAQ ──
 "Quali sono gli orari di Fox Town Mendrisio nel 2026?": {
 en: { q: "What are Fox Town Mendrisio's 2026 opening hours?", a: "Fox Town Outlet Mendrisio is open 11:00-19:00 every day including Sundays and public holidays. On 25 December, 1 January and a few Swiss holidays the outlet is closed: check the official fox-town.com website before visiting." },
 de: { q: "Welche Oeffnungszeiten hat Fox Town Mendrisio 2026?", a: "Das Fox Town Outlet Mendrisio hat taeglich von 11:00 bis 19:00 Uhr geoeffnet, auch sonntags und an Feiertagen. Am 25. Dezember, 1. Januar und an einigen Schweizer Feiertagen ist das Outlet geschlossen: Pruefen Sie vor Ihrem Besuch fox-town.com." },
 fr: { q: "Quels sont les horaires de Fox Town Mendrisio en 2026 ?", a: "L'outlet Fox Town Mendrisio est ouvert de 11h00 a 19h00 tous les jours, dimanche et jours feries compris. Le 25 decembre, le 1er janvier et quelques feries suisses, l'outlet est ferme : consultez fox-town.com avant votre visite." }
 },
 "Quanti marchi ci sono a Fox Town e che sconti si trovano?": {
 en: { q: "How many brands are at Fox Town and what discounts can you find?", a: "Fox Town hosts about 160 brands (Gucci, Prada, Armani, Nike, Levi's, Tod's and many more). Typical discounts run 30-70% off the full price, rising to 80% during seasonal sales." },
 de: { q: "Wie viele Marken gibt es bei Fox Town und welche Rabatte sind moeglich?", a: "Fox Town beherbergt rund 160 Marken (Gucci, Prada, Armani, Nike, Levi's, Tod's und viele mehr). Ueblich sind Rabatte von 30-70 % auf den Listenpreis, bis zu 80 % waehrend des saisonalen Sales." },
 fr: { q: "Combien de marques compte Fox Town et quelles reductions y trouve-t-on ?", a: "Fox Town rassemble environ 160 marques (Gucci, Prada, Armani, Nike, Levi's, Tod's et bien d'autres). Les remises varient de 30 a 70 % sur le prix catalogue, jusqu'a 80 % pendant les soldes saisonniers." }
 },
 "Come arrivare a Fox Town Mendrisio dall'Italia?": {
 en: { q: "How do you reach Fox Town Mendrisio from Italy?", a: "By car: A9 motorway to Chiasso-Brogeda, then A2 to the Mendrisio exit (5 min from the border). By train: direct from Como S. Giovanni to Mendrisio (25 min) + 10-min walk. Free parking with 1,600 spaces on site." },
 de: { q: "Wie erreicht man Fox Town Mendrisio von Italien aus?", a: "Mit dem Auto: Autobahn A9 bis Chiasso-Brogeda, dann A2 bis zur Ausfahrt Mendrisio (5 Min. von der Grenze). Mit dem Zug: Direktverbindung ab Como S. Giovanni nach Mendrisio (25 Min.) + 10 Min. zu Fuss. Kostenlose Parkplaetze mit 1.600 Stellplaetzen vor Ort." },
 fr: { q: "Comment se rendre a Fox Town Mendrisio depuis l'Italie ?", a: "En voiture : autoroute A9 jusqu'a Chiasso-Brogeda, puis A2 jusqu'a la sortie Mendrisio (5 min de la frontiere). En train : liaison directe Como S. Giovanni-Mendrisio (25 min) + 10 min a pied. Parking gratuit de 1 600 places sur place." }
 },
 "Serve la carta di credito o si paga in euro a Fox Town?": {
 en: { q: "Do you need a credit card or can you pay in euros at Fox Town?", a: "You can pay in euros, Swiss francs or by card (Visa, Mastercard, American Express). The exchange rate applied is less favourable than the interbank rate, so for large purchases prefer a card with no conversion fees (Revolut, Wise)." },
 de: { q: "Braucht man bei Fox Town eine Kreditkarte oder zahlt man in Euro?", a: "Sie koennen in Euro, Schweizer Franken oder per Karte (Visa, Mastercard, American Express) zahlen. Der angewandte Wechselkurs liegt unter dem Interbankenkurs; bei groesseren Einkaeufen ist eine Karte ohne Fremdwaehrungsgebuehr (Revolut, Wise) vorzuziehen." },
 fr: { q: "Faut-il une carte de credit ou peut-on payer en euros a Fox Town ?", a: "Vous pouvez payer en euros, en francs suisses ou par carte (Visa, Mastercard, American Express). Le taux de change applique est moins favorable que l'interbancaire ; pour les gros achats, privilegiez une carte sans frais de conversion (Revolut, Wise)." }
 },
 "I frontalieri hanno sconti particolari a Fox Town?": {
 en: { q: "Do cross-border workers get special discounts at Fox Town?", a: "Fox Town does not offer a specific cross-border worker programme, but you can request VAT refund (Global Blue / Planet Tax Free) on purchases of CHF 300+, getting back about 7.7% of the price when re-entering Italy." },
 de: { q: "Gibt es fuer Grenzgaenger besondere Rabatte bei Fox Town?", a: "Fox Town bietet kein spezifisches Grenzgaenger-Programm, aber Sie koennen ab Einkaeufen von CHF 300 die MwSt-Rueckerstattung (Global Blue / Planet Tax Free) beantragen und erhalten rund 7,7 % des Preises beim Grenzuebertritt nach Italien zurueck." },
 fr: { q: "Les frontaliers beneficient-ils de remises specifiques chez Fox Town ?", a: "Fox Town n'offre pas de programme specifique aux frontaliers, mais vous pouvez demander le remboursement de la TVA (Global Blue / Planet Tax Free) sur les achats a partir de CHF 300, soit environ 7,7 % du prix au passage de la frontiere italienne." }
 },

 // ── Sprint 4 F4-E1 — PAA additions on 6 existing pages ──
 "Quanto guadagna un frontaliere in Svizzera al mese?": {
 en: { q: "How much does a cross-border worker earn per month in Switzerland?", a: "A cross-border worker in Canton Ticino earns a gross median of CHF 5,600 per month (USS data), equivalent to around CHF 4,300–4,600 net after withholding tax and AVS/LPP/AC contributions. Skilled profiles (IT, engineering, pharma, finance) reach CHF 7,000–9,000 gross, while trades and retail settle around CHF 4,200–4,800. Use the free simulator on frontaliereticino.ch to estimate the exact net by marital status, children and municipality." },
 de: { q: "Wie viel verdient ein Grenzgaenger pro Monat in der Schweiz?", a: "Ein Grenzgaenger im Kanton Tessin verdient im Median brutto CHF 5'600 pro Monat (USS-Daten), netto rund CHF 4'300–4'600 nach Quellensteuer und AHV/BVG/ALV-Beitraegen. Qualifizierte Profile (IT, Ingenieurwesen, Pharma, Finanzen) erreichen CHF 7'000–9'000 brutto, Handwerk und Detailhandel liegen bei CHF 4'200–4'800. Nutzen Sie den Gratissimulator auf frontaliereticino.ch fuer eine genaue Netto-Schaetzung nach Zivilstand, Kindern und Gemeinde." },
 fr: { q: "Combien gagne un frontalier par mois en Suisse ?", a: "Un frontalier au Tessin gagne en moyenne CHF 5 600 bruts par mois (mediane USS), soit environ CHF 4 300–4 600 nets apres impot a la source et cotisations AVS/LPP/AC. Les profils qualifies (IT, ingenierie, pharma, finance) atteignent CHF 7 000–9 000 bruts, tandis que les metiers manuels et le commerce se situent autour de CHF 4 200–4 800. Utilisez le simulateur gratuit sur frontaliereticino.ch pour estimer le net exact selon l'etat civil, les enfants et la commune." }
 },
 "Quali sono le differenze tra permesso G e permesso B?": {
 en: { q: "What are the differences between G permit and B permit?", a: "G permits concern residence abroad and at least weekly return; B permits concern residence in Switzerland. The permit alone does not determine taxation: G holders may qualify as old fiscal frontier workers, new ones or fall outside the agreement. Compare actual residence, income and household costs rather than using a universal salary threshold. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 de: { q: "Was sind die Unterschiede zwischen G-Bewilligung und B-Bewilligung?", a: "Die G-Bewilligung betrifft Wohnsitz im Ausland mit mindestens wöchentlicher Rückkehr, die B-Bewilligung den Aufenthalt in der Schweiz. Die Bewilligung allein bestimmt die Steuern nicht: Bei G sind alte und neue steuerliche Grenzgänger sowie Personen ausserhalb des Abkommens zu unterscheiden. Massgeblich sind tatsächlicher Wohnsitz, Einkommen und Haushaltskosten, keine pauschale Lohngrenze. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 fr: { q: "Quelles sont les differences entre permis G et permis B ?", a: "Le permis G implique un domicile à l’étranger et un retour au moins hebdomadaire ; le B concerne le séjour en Suisse. Le permis seul ne détermine pas les impôts : les titulaires G peuvent relever des anciens frontaliers fiscaux, des nouveaux ou être hors accord. Comparer résidence effective, revenu et frais du ménage sans seuil salarial universel. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" }
 },
 "Dove trovare lavoro da frontaliere in Ticino?": {
 en: { q: "Where to find a cross-border job in Ticino?", a: "Main sources for cross-border job openings are the federal JobRoom portal, cantonal job boards (lavoro.swiss), private sites like jobs.ch, jobup.ch and indeed.ch, staffing agencies (Adecco, Manpower, Randstad, Kelly), and the dedicated cross-border job board on frontaliereticino.ch/cerca-lavoro-ticino with around 6,000 listings refreshed daily from Ticino-specific crawls." },
 de: { q: "Wo findet man einen Grenzgaenger-Job im Tessin?", a: "Wichtigste Quellen fuer Grenzgaenger-Stellen sind das Bundesportal JobRoom, kantonale Jobboersen (lavoro.swiss), private Anbieter wie jobs.ch, jobup.ch und indeed.ch, Personalvermittler (Adecco, Manpower, Randstad, Kelly) sowie die Grenzgaenger-Jobboerse auf frontaliereticino.ch/cerca-lavoro-ticino mit rund 6'000 taeglich aktualisierten Inseraten aus Tessin-spezifischen Crawls." },
 fr: { q: "Ou trouver un emploi de frontalier au Tessin ?", a: "Les principales sources d'offres pour frontaliers sont le portail federal JobRoom, les bourses cantonales (lavoro.swiss), des sites prives comme jobs.ch, jobup.ch et indeed.ch, les agences d'interim (Adecco, Manpower, Randstad, Kelly), ainsi que la bourse dediee sur frontaliereticino.ch/cerca-lavoro-ticino avec environ 6 000 annonces mises a jour quotidiennement depuis des crawls specifiques au Tessin." }
 },
 "Come diventare frontaliere in Svizzera passo per passo?": {
 en: { q: "How to become a cross-border worker in Switzerland step by step?", a: "To become a cross-border worker you need: (1) EU/EFTA citizenship and residence in an Italian municipality within 20 km of the Swiss border; (2) an employment contract with a Swiss employer; (3) application for the G permit at the migration office of the work canton, attaching contract and ID. After about 30 days you receive the G permit, valid for 5 years and renewable. Before day one: open a Swiss bank account, choose between LAMal and SSN within 3 months, and register with AIRE if you change residence." },
 de: { q: "Wie wird man Schritt fuer Schritt Grenzgaenger in der Schweiz?", a: "Um Grenzgaenger zu werden benoetigen Sie: (1) EU/EFTA-Staatsbuergerschaft und Wohnsitz in einer italienischen Gemeinde innerhalb von 20 km zur Schweizer Grenze; (2) einen Arbeitsvertrag mit einem Schweizer Arbeitgeber; (3) Antrag auf die G-Bewilligung beim Migrationsamt des Arbeitskantons unter Beilage von Vertrag und Ausweis. Nach rund 30 Tagen erhalten Sie die G-Bewilligung, gueltig 5 Jahre und verlaengerbar. Vor dem ersten Arbeitstag: Schweizer Bankkonto eroeffnen, innerhalb von 3 Monaten zwischen KVG und SSN waehlen, bei Wohnsitzwechsel AIRE-Eintragung vornehmen." },
 fr: { q: "Comment devenir frontalier en Suisse etape par etape ?", a: "Pour devenir frontalier il faut : (1) la citoyennete UE/EFTA et une residence dans une commune italienne situee dans un rayon de 20 km de la frontiere suisse ; (2) un contrat de travail avec un employeur suisse ; (3) une demande de permis G aupres de l'office des migrations du canton de travail, avec contrat et piece d'identite. Apres environ 30 jours vous recevez le permis G, valable 5 ans et renouvelable. Avant le premier jour : ouvrir un compte bancaire suisse, choisir entre LAMal et SSN dans les 3 mois, et s'inscrire a l'AIRE en cas de changement de residence." }
 },
 "Chi è il frontaliere secondo la legge svizzera?": {
 en: { q: "Who is a cross-border worker according to Swiss law?", a: "The G permit concerns working in Switzerland with a main residence abroad and return at least weekly. The treaty tax definition is separate: it requires a border-zone municipality, work in the specified region and return home in principle daily. Holding the permit alone does not determine tax status. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 de: { q: "Wer gilt nach Schweizer Recht als Grenzgaenger?", a: "Die G-Bewilligung betrifft Arbeit in der Schweiz bei Hauptwohnsitz im Ausland und mindestens wöchentlicher Rückkehr. Die steuerliche Abkommensdefinition ist davon getrennt: erforderlich sind eine Grenzgemeinde, Arbeit in der vorgesehenen Region und grundsätzlich tägliche Heimkehr. Der Ausweis allein bestimmt den Steuerstatus nicht. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 fr: { q: "Qui est frontalier selon le droit suisse ?", a: "Le permis G concerne le travail en Suisse avec résidence principale à l’étranger et retour au moins hebdomadaire. La définition fiscale de l’accord est distincte: commune dans la zone frontalière, activité dans la région prévue et retour en principe quotidien. Le permis seul ne détermine pas le statut fiscal. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" }
 },
 "Conviene davvero fare il frontaliere nel 2026?": {
 en: { q: "Is it really worth being a cross-border worker in 2026?", a: "For most profiles yes: with a Swiss gross salary of CHF 60,000 the monthly net is around EUR 3,200–3,500, roughly EUR 800–1,200 higher than the Italian equivalent. The advantage depends on marital status, number of children, municipality of residence (local IRPEF surcharges), distance from the border and transport costs. Use our 'What-If' simulator to compare your specific case against your current Italian income before deciding." },
 de: { q: "Lohnt es sich wirklich, 2026 Grenzgaenger zu werden?", a: "Fuer die meisten Profile ja: bei einem CH-Bruttolohn von CHF 60'000 betraegt das monatliche Netto rund EUR 3'200–3'500, etwa EUR 800–1'200 mehr als das italienische Aequivalent. Der Vorteil haengt von Zivilstand, Kinderzahl, Wohnsitzgemeinde (lokale IRPEF-Zuschlaege), Grenzentfernung und Transportkosten ab. Nutzen Sie unseren 'What-If'-Simulator, um Ihren Fall vor einer Entscheidung mit dem aktuellen italienischen Einkommen zu vergleichen." },
 fr: { q: "Est-il vraiment interessant d'etre frontalier en 2026 ?", a: "Pour la plupart des profils oui : avec un salaire brut suisse de CHF 60 000, le net mensuel tourne autour de 3 200–3 500 EUR, soit 800–1 200 EUR de plus que l'equivalent italien. L'avantage depend de l'etat civil, du nombre d'enfants, de la commune de residence (additionnels IRPEF), de la distance a la frontiere et des couts de transport. Utilisez notre simulateur 'What-If' pour comparer votre cas specifique a votre revenu italien actuel avant de decider." }
 },
 "Quanto si risparmia vivendo in Italia e lavorando in Svizzera?": {
 en: { q: "How much do you save by living in Italy and working in Switzerland?", a: "A cross-border worker on a median salary (CHF 5,600 gross) residing in Varese or Como saves on average EUR 1,500–2,200 per month compared with a Swiss resident earning the same gross, thanks to rent about 60% lower, SSN replacing LAMal (if opted), and groceries about 30% cheaper. Subtracting EUR 250–400 per month of transport (car plus fuel or TILO commuter pass), the real net saving is EUR 1,100–1,800 per month." },
 de: { q: "Wie viel spart man, wenn man in Italien wohnt und in der Schweiz arbeitet?", a: "Ein Grenzgaenger mit Medianlohn (CHF 5'600 brutto) und Wohnsitz in Varese oder Como spart im Vergleich zu einem Schweizer Einwohner mit gleichem Brutto im Schnitt EUR 1'500–2'200 pro Monat, dank rund 60 % tieferer Miete, SSN statt KVG (bei Optionsausuebung) und rund 30 % guenstigerem Lebensmitteleinkauf. Nach Abzug von EUR 250–400 pro Monat fuer den Pendelverkehr (Auto und Treibstoff oder TILO-Abo) betraegt die reale Nettoeinsparung EUR 1'100–1'800 pro Monat." },
 fr: { q: "Combien economise-t-on en vivant en Italie et en travaillant en Suisse ?", a: "Un frontalier au salaire median (CHF 5 600 bruts) residant a Varese ou Come economise en moyenne 1 500–2 200 EUR par mois par rapport a un resident suisse touchant le meme brut, grace a un loyer environ 60 % inferieur, au SSN remplacant la LAMal (en cas d'option) et a une alimentation environ 30 % moins chere. En deduisant 250–400 EUR par mois de transport (voiture + carburant ou abonnement TILO), l'economie nette reelle est de 1 100–1 800 EUR par mois." }
 },
 "Come confrontare due offerte di lavoro CH con stipendi diversi?": {
 en: { q: "How to compare two Swiss job offers with different salaries?", a: "Don't just compare the gross: use the 'CH-IT Gross Comparison' simulator with both gross figures, the same marital/family status and residence municipality. Then compare monthly net in EUR, the 13th salary (mandatory in CH), LPP contributions (7–18% by age), employer LAMal subsidy (if any), and benefits (canteen, meal vouchers, company car). A CHF 500 gross gap can shrink to only EUR 250–300 net." },
 de: { q: "Wie vergleicht man zwei Schweizer Stellenangebote mit unterschiedlichen Loehnen?", a: "Vergleichen Sie nicht nur den Bruttolohn: nutzen Sie den Simulator 'RAL-Vergleich CH-IT' mit beiden Bruttobetraegen, gleichem Zivilstand/Kinderzahl und gleicher Wohngemeinde. Vergleichen Sie dann monatliches Netto in EUR, 13. Monatslohn (in CH obligatorisch), BVG-Beitraege (7–18 % je nach Alter), Arbeitgeberzuschuss zur KVG (falls vorhanden) und Benefits (Kantine, Verpflegungsgutscheine, Geschaeftswagen). Eine Bruttodifferenz von CHF 500 kann auf nur EUR 250–300 netto schrumpfen." },
 fr: { q: "Comment comparer deux offres d'emploi suisses aux salaires differents ?", a: "Ne comparez pas uniquement le brut : utilisez le simulateur 'Comparaison RAL CH-IT' avec les deux bruts, le meme etat civil/nombre d'enfants et la meme commune de residence. Comparez ensuite le net mensuel en EUR, le 13e salaire (obligatoire en CH), les cotisations LPP (7–18 % selon l'age), la participation LAMal de l'employeur (si prevue) et les avantages (cantine, cheques-repas, vehicule de fonction). Un ecart de CHF 500 bruts peut se reduire a seulement 250–300 EUR nets." }
 },
 "Frontaliere: quanto paga di tasse totali tra Svizzera e Italia?": {
 en: { q: "Cross-border worker: how much tax do they pay in total between Switzerland and Italy?", a: "There is no universal total tax percentage: fiscal status, income and household circumstances matter. New fiscal frontier workers pay 80% of Switzerland’s ordinary withholding rate and Italian tax with credit for Swiss tax. Eligible old workers under Article 9 retain exclusive Swiss taxation of the covered salary. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 de: { q: "Grenzgaenger: wie viel Steuern zahlt man insgesamt zwischen Schweiz und Italien?", a: "Es gibt keinen allgemeinen Gesamtsteuersatz: Steuerstatus, Einkommen und Familienverhältnisse zählen. Neue steuerliche Grenzgänger zahlen 80% des ordentlichen Schweizer Quellensteuertarifs sowie italienische Steuer mit Anrechnung. Berechtigte alte Grenzgänger nach Artikel 9 behalten die ausschliessliche Schweizer Besteuerung des betroffenen Lohns. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 fr: { q: "Frontalier : quel est le total d'impots paye entre Suisse et Italie ?", a: "Il n’existe pas de taux total universel : statut fiscal, revenu et situation familiale comptent. Les nouveaux frontaliers fiscaux paient 80% du taux suisse ordinaire et l’impôt italien avec crédit de l’impôt suisse. Les anciens admissibles à l’article 9 conservent l’imposition exclusivement suisse du salaire concerné. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" }
 },
 "Come si compila il modello 730 da frontaliere?": {
 en: { q: "How do you fill in the 730 tax form as a cross-border worker?", a: "The new cross-border worker declares the Swiss salary in section C (employment income) converted to EUR at the BNS annual average rate, fills line RC6 for deductible AVS contributions, applies the EUR 10,000 allowance at line C14, and enters the withholding tax paid at line CR10 for the foreign tax credit. You need the Swiss salary certificate (Lohnausweis) issued by the employer by January. The 730 deadline is 30 September." },
 de: { q: "Wie fuellt ein Grenzgaenger die Steuererklaerung Modello 730 aus?", a: "Der neue Grenzgaenger deklariert das CH-Einkommen im Abschnitt C (Einkommen aus unselbststaendiger Erwerbstaetigkeit) zum jaehrlichen SNB-Durchschnittskurs in EUR, traegt in Zeile RC6 die abziehbaren AHV-Beitraege ein, wendet in Zeile C14 den Freibetrag von EUR 10'000 an und gibt die gezahlte Quellensteuer in Zeile CR10 fuer die Anrechnung der auslaendischen Steuer an. Noetig ist der Schweizer Lohnausweis, den der Arbeitgeber bis Januar ausstellt. Frist 730: 30. September." },
 fr: { q: "Comment remplir le modele 730 en tant que frontalier ?", a: "Le nouveau frontalier declare le revenu suisse au cadre C (revenus d'activite salariee) converti en EUR au taux moyen annuel BNS, remplit la ligne RC6 pour les cotisations AVS deductibles, applique la franchise de 10 000 EUR a la ligne C14 et indique l'impot a la source paye a la ligne CR10 pour le credit d'impot etranger. Il faut le certificat de salaire suisse (Lohnausweis) delivre par l'employeur avant janvier. Echeance 730 : 30 septembre." }
 },
 "Quali sanzioni rischia il frontaliere che omette la dichiarazione del reddito svizzero?": {
 en: { q: "What penalties does a cross-border worker face for omitting the declaration of Swiss income?", a: "For a new cross-border worker, failing to declare Swiss income is tax evasion: the automatic CRS information exchange between CH and IT since 2018 makes discovery almost certain. Penalties: 120–240% of unpaid IRPEF, plus statutory interest (about 3% per year), plus mandatory voluntary disclosure. Above EUR 50,000 of evaded income criminal charges also apply (D.lgs 74/2000). An old cross-border worker is exempt from IRPEF but must still file form RW if holding Swiss accounts." },
 de: { q: "Welche Sanktionen drohen dem Grenzgaenger bei nicht erklaertem Schweizer Einkommen?", a: "Fuer einen neuen Grenzgaenger ist das Nichtdeklarieren des CH-Einkommens Steuerhinterziehung: der automatische CRS-Informationsaustausch zwischen CH und IT seit 2018 macht eine Entdeckung nahezu sicher. Sanktionen: 120–240 % der nicht gezahlten IRPEF, gesetzliche Zinsen (rund 3 % pro Jahr) und obligatorische Selbstanzeige. Ab EUR 50'000 entgangenem Einkommen greift zudem Strafanzeige (D.lgs 74/2000). Ein alter Grenzgaenger ist von der IRPEF befreit, muss aber das Formular RW einreichen, wenn er Schweizer Konten haelt." },
 fr: { q: "Quelles sanctions risque le frontalier qui omet de declarer son revenu suisse ?", a: "Pour un nouveau frontalier, l'omission de declarer le revenu suisse est une fraude fiscale : depuis 2018, l'echange automatique CRS entre la CH et l'IT rend la decouverte quasi certaine. Sanctions : 120–240 % de l'IRPEF non paye, plus interets legaux (environ 3 % par an) et regularisation obligatoire. Au-dela de 50 000 EUR de revenu evade s'ajoute une denonciation penale (D.lgs 74/2000). Un ancien frontalier est exonere d'IRPEF mais doit tout de meme remplir le cadre RW s'il detient des comptes suisses." }
 },
 "Quanto costa vivere a Lugano da frontaliere nel 2026?": {
 en: { q: "How much does it cost to live in Lugano as a cross-border worker in 2026?", a: "Living in Lugano as a resident costs on average CHF 4,500–5,500 per month for a single person: two-room flat CHF 1,400–1,800, LAMal CHF 380–500, groceries CHF 600–800, transport CHF 75 (Tessin-abo), utilities CHF 180–250, leisure CHF 400–600. A cross-border worker residing in Como or Varese and commuting to Lugano pays about 40–50% less thanks to Italian rent and groceries, plus CHF 80–150 per month of commuting (TILO train or car plus motorway toll)." },
 de: { q: "Wie viel kostet es 2026, als Grenzgaenger in Lugano zu leben?", a: "Als Einwohner in Lugano kostet das Leben im Schnitt CHF 4'500–5'500 pro Monat fuer einen Single: 2-Zimmer-Wohnung CHF 1'400–1'800, KVG CHF 380–500, Lebensmittel CHF 600–800, Verkehr CHF 75 (Tessin-Abo), Nebenkosten CHF 180–250, Freizeit CHF 400–600. Ein Grenzgaenger mit Wohnsitz in Como oder Varese, der nach Lugano pendelt, zahlt dank italienischer Miete und Lebensmittel rund 40–50 % weniger, plus CHF 80–150 pro Monat Pendelkosten (TILO-Zug oder Auto plus Autobahngebuehr)." },
 fr: { q: "Combien coute de vivre a Lugano comme frontalier en 2026 ?", a: "Vivre a Lugano comme resident coute en moyenne CHF 4 500–5 500 par mois pour un celibataire : deux-pieces CHF 1 400–1 800, LAMal CHF 380–500, alimentation CHF 600–800, transports CHF 75 (Tessin-abo), charges CHF 180–250, loisirs CHF 400–600. Un frontalier residant a Come ou Varese et travaillant a Lugano paie environ 40–50 % de moins grace au loyer et a l'alimentation italiens, plus CHF 80–150 par mois de trajets (train TILO ou voiture plus peage autoroutier)." }
 },
 "Quanto costa un affitto a Chiasso o Mendrisio?": {
 en: { q: "How much does rent cost in Chiasso or Mendrisio?", a: "In Mendrisio a 50–60 m² two-room flat costs CHF 1,100–1,500 per month (plus CHF 150–220 of utilities Nebenkosten), in Chiasso CHF 1,050–1,400. Three-room flats of 75–85 m² go up to CHF 1,400–1,900 (Mendrisio) and CHF 1,300–1,750 (Chiasso). Typically required: 3-month bank deposit, employer reference and Betreibungsregister extract. They are 25–35% cheaper than Lugano for the same typology." },
 de: { q: "Was kostet eine Miete in Chiasso oder Mendrisio?", a: "In Mendrisio kostet eine 2-Zimmer-Wohnung von 50–60 m² CHF 1'100–1'500 pro Monat (plus CHF 150–220 Nebenkosten), in Chiasso CHF 1'050–1'400. 3-Zimmer-Wohnungen von 75–85 m² steigen auf CHF 1'400–1'900 (Mendrisio) und CHF 1'300–1'750 (Chiasso). Ueblich verlangt: Mietkaution von drei Monatsmieten auf Sperrkonto, Arbeitgeberreferenz und Auszug aus dem Betreibungsregister. Sie sind 25–35 % guenstiger als Lugano bei gleicher Typologie." },
 fr: { q: "Combien coute un loyer a Chiasso ou Mendrisio ?", a: "A Mendrisio, un deux-pieces de 50–60 m² coute CHF 1 100–1 500 par mois (plus CHF 150–220 de charges Nebenkosten), a Chiasso CHF 1 050–1 400. Les trois-pieces de 75–85 m² montent a CHF 1 400–1 900 (Mendrisio) et CHF 1 300–1 750 (Chiasso). On demande en general : une garantie bancaire de 3 mois, une reference de l'employeur et un extrait du Betreibungsregister. Ils sont 25–35 % moins chers que Lugano pour la meme typologie." }
 },
 "Quanto si spende mediamente per la spesa alimentare in Ticino?": {
 en: { q: "How much is spent on average on groceries in Ticino?", a: "A single Ticino resident spends CHF 400–550 per month on groceries (Migros/Coop), a couple CHF 650–850, a family of four CHF 950–1,250. Discount chains Aldi and Lidl cut the bill by 20–30%. A cross-border worker who shops in Italy (Como, Varese) saves 30–40%: a weekly shop of EUR 150 in IT equals CHF 210–240 in Lugano. Watch out for the customs allowance of CHF 150 per person per day." },
 de: { q: "Wie viel gibt man durchschnittlich fuer Lebensmittel im Tessin aus?", a: "Ein Tessiner Single gibt monatlich CHF 400–550 fuer Lebensmittel aus (Migros/Coop), ein Paar CHF 650–850, eine vierkoepfige Familie CHF 950–1'250. Discounter wie Aldi und Lidl senken die Rechnung um 20–30 %. Ein Grenzgaenger, der in Italien (Como, Varese) einkauft, spart 30–40 %: ein Wocheneinkauf fuer EUR 150 in IT entspricht CHF 210–240 in Lugano. Achtung auf den Zollfreibetrag von CHF 150 pro Person und Tag." },
 fr: { q: "Quel budget moyen pour les courses alimentaires au Tessin ?", a: "Un Tessinois celibataire depense CHF 400–550 par mois en courses (Migros/Coop), un couple CHF 650–850, une famille de quatre CHF 950–1 250. Les discounters Aldi et Lidl reduisent la facture de 20–30 %. Un frontalier qui fait ses courses en Italie (Come, Varese) economise 30–40 % : un panier hebdomadaire de 150 EUR en IT correspond a CHF 210–240 a Lugano. Attention a la franchise douaniere de CHF 150 par personne et par jour." }
 },
 "La LAMal è davvero obbligatoria per tutti i frontalieri?": {
 en: { q: "Is LAMal really mandatory for all cross-border workers?", a: "Eligible EU citizens resident in Italy may formally request exemption from LAMal from the competent authority in their canton of employment within three months of starting work. Italian SSN enrolment alone does not exercise this right. The choice cannot be changed freely. For someone previously insured under LAMal, the birth of a child may allow a new option within three months, depending on the family situation: check with the canton and Italian ASL first. Source: FOPH, https://www.bag.admin.ch/it/assicurazione-malattie-lavoratori-frontalieri-in-svizzera" },
 de: { q: "Ist die KVG wirklich fuer alle Grenzgaenger obligatorisch?", a: "Berechtigte EU-Staatsangehörige mit Wohnsitz in Italien können beim zuständigen Arbeitskanton innerhalb von drei Monaten nach Arbeitsbeginn die Befreiung von der KVG beantragen. Eine SSN-Anmeldung allein genügt nicht. Die Wahl kann nicht frei geändert werden. Bei bisheriger KVG-Versicherung kann die Geburt eines Kindes je nach Familiensituation eine erneute Ausübung innerhalb von drei Monaten ermöglichen: vorher mit dem Kanton und der italienischen ASL klären. Quelle: BAG, https://www.bag.admin.ch/it/assicurazione-malattie-lavoratori-frontalieri-in-svizzera" },
 fr: { q: "La LAMal est-elle vraiment obligatoire pour tous les frontaliers ?", a: "Les citoyens UE résidant en Italie qui disposent du droit d’option peuvent demander formellement une exemption de la LAMal à l’autorité du canton de travail dans les trois mois suivant le début de l’activité. L’inscription au SSN seule ne suffit pas. Le choix ne peut pas être modifié librement. Pour une personne précédemment assurée LAMal, la naissance d’un enfant peut permettre un nouvel exercice dans les trois mois, selon la situation familiale : vérifier auparavant avec le canton et l’ASL italienne. Source : OFSP, https://www.bag.admin.ch/it/assicurazione-malattie-lavoratori-frontalieri-in-svizzera" }
 },
 "Come cambiare cassa malati frontaliere senza penali?": {
 en: { q: "How to change cross-border health insurer without penalties?", a: "The basic LAMal policy can be cancelled twice a year: by 30 November with effect 1 January (franchise change or insurer change), or by 31 March with effect 1 July (only if the premium increases). The notice must be sent by registered letter with return receipt to the old insurer, and you must already have signed with the new one: even a one-day gap is sanctioned. Supplementary insurances can be cancelled freely with three months' notice by 31 December." },
 de: { q: "Wie wechselt man als Grenzgaenger die Krankenkasse ohne Strafe?", a: "Die KVG-Grundversicherung kann zweimal im Jahr gekuendigt werden: bis 30. November mit Wirkung 1. Januar (Franchiseanpassung oder Kassenwechsel) oder bis 31. Maerz mit Wirkung 1. Juli (nur bei Praemienerhoehung). Die Kuendigung geht per Einschreiben mit Rueckschein an die bisherige Kasse, und mit der neuen Kasse muss bereits unterschrieben sein: auch eine Luecke von einem Tag wird sanktioniert. Zusatzversicherungen koennen mit dreimonatiger Frist auf den 31. Dezember frei gekuendigt werden." },
 fr: { q: "Comment changer d'assurance maladie frontaliere sans penalites ?", a: "La resiliation de l'assurance de base LAMal est possible deux fois par an : avant le 30 novembre avec effet au 1er janvier (changement de franchise ou de caisse) ou avant le 31 mars avec effet au 1er juillet (uniquement en cas de hausse de prime). La resiliation s'envoie en recommandee avec accuse de reception a l'ancienne caisse, et la nouvelle doit deja etre signee : meme un jour sans couverture est sanctionne. Les assurances complementaires se resilient librement avec un preavis de 3 mois au 31 decembre." }
 },
 "LAMal o SSN: cosa conviene per la famiglia del frontaliere?": {
 en: { q: "LAMal or SSN: which is better for the cross-border worker's family?", a: "For families with children the Italian SSN is almost always the better choice: the right of option covers spouse and dependent children at no extra premium, whereas with LAMal each family member pays their own premium (CHF 270–560 per month for adults, CHF 100–150 for children). Typical yearly saving for a family of four: CHF 8,000–12,000. The downside is that treatments in Switzerland under SSN require the EHIC and upfront payment (then reimbursed), while LAMal lets you access CH hospitals directly. Use the LAMal vs SSN comparator to estimate your case." },
 de: { q: "KVG oder SSN: was lohnt sich fuer die Familie eines Grenzgaengers?", a: "Fuer Familien mit Kindern ist der italienische SSN fast immer vorteilhafter: das Optionsrecht deckt Ehepartner und unterhaltsberechtigte Kinder ohne Zusatzpraemie, waehrend bei der KVG jedes Familienmitglied eine eigene Praemie zahlt (CHF 270–560 pro Monat fuer Erwachsene, CHF 100–150 fuer Kinder). Typische Jahresersparnis fuer eine vierkoepfige Familie: CHF 8'000–12'000. Nachteil: Behandlungen in der Schweiz mit SSN erfordern die Europaeische Krankenversicherungskarte (EKVK) und Vorauszahlung mit spaeterer Rueckerstattung, waehrend die KVG direkten Zugang zu CH-Spitaelern ermoeglicht. Nutzen Sie den KVG-vs-SSN-Vergleich zur Schaetzung." },
 fr: { q: "LAMal ou SSN : que choisir pour la famille du frontalier ?", a: "Pour les familles avec enfants, le SSN italien est presque toujours le plus avantageux : le droit d'option couvre le conjoint et les enfants a charge sans prime supplementaire, alors qu'avec la LAMal chaque membre paie sa propre prime (CHF 270–560 par mois pour les adultes, CHF 100–150 pour les enfants). Economie annuelle typique pour une famille de quatre : CHF 8 000–12 000. L'inconvenient est que les soins en Suisse avec le SSN necessitent la CEAM et un paiement d'avance (rembourse ensuite), tandis que la LAMal donne acces direct aux hopitaux CH. Utilisez le comparateur LAMal vs SSN pour estimer votre cas." }
 },

 // ── Sprint 2 pillar-page FAQ translations (filled in by Sprint 4 follow-up) ──
 "Quanto pagano di tasse i frontalieri in Svizzera nel 2026?": {
 en: { q: "How much tax do cross-border workers pay in Switzerland in 2026?", a: "Tax depends on the cantonal tariff, income and family circumstances. New tax cross-border workers pay 80% of ordinary Swiss withholding tax alongside Italian tax with credit. Old workers qualifying under Article 9 remain taxed only in Switzerland on the covered salary. Use the year’s tariff and documented status rather than a general average percentage. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 de: { q: "Wie viel Steuern zahlen Grenzgaenger 2026 in der Schweiz?", a: "Die Steuer hängt vom kantonalen Tarif, Einkommen und Familienverhältnissen ab. Neue steuerliche Grenzgänger zahlen 80% der ordentlichen Schweizer Quellensteuer neben italienischer Steuer mit Anrechnung. Alte Grenzgänger nach Artikel 9 bleiben auf den erfassten Lohn allein in der Schweiz steuerpflichtig. Massgeblich sind der Jahrestarif und der belegte Status, kein pauschaler Durchschnittssatz. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 fr: { q: "Combien d'impots paient les frontaliers en Suisse en 2026 ?", a: "L’impôt dépend du barème cantonal, du revenu et de la situation familiale. Les nouveaux frontaliers fiscaux paient 80% de l’impôt suisse à la source ordinaire, avec imposition italienne et crédit. Les anciens admissibles selon l’article 9 restent imposés seulement en Suisse sur le salaire concerné. Utilisez le barème de l’année et le statut documenté, non un pourcentage moyen général. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" }
 },
 "Qual è la differenza fra nuovi e vecchi frontalieri?": {
 en: { q: "What's the difference between new and old cross-border workers?", a: "For new fiscal cross-border workers, Switzerland applies 80% of its ordinary withholding rate; Italy taxes the income with a credit for Swiss tax. The 80% is not a revenue split between the two countries. Old cross-border workers who qualify under Article 9 retain exclusive Swiss taxation of the covered salary. Their regime does not automatically end in 2033 or 2034: 2033 is the final tax year of Swiss compensation payments to Italy. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 de: { q: "Was ist der Unterschied zwischen neuen und alten Grenzgaengern?", a: "Für neue steuerliche Grenzgänger wendet die Schweiz 80% des ordentlichen Quellensteuertarifs an; Italien besteuert das Einkommen mit Anrechnung der Schweizer Steuer. Die 80% sind keine Aufteilung der Einnahmen zwischen den Staaten. Alte Grenzgänger, die Artikel 9 erfüllen, behalten die ausschliessliche Schweizer Besteuerung des erfassten Lohns. Das Regime endet nicht automatisch 2033 oder 2034; 2033 ist das letzte Steuerjahr der Ausgleichszahlungen an Italien. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 fr: { q: "Quelle difference entre nouveaux et anciens frontaliers ?", a: "Pour les nouveaux frontaliers fiscaux, la Suisse applique 80% du taux ordinaire de retenue; l’Italie impose le revenu en accordant un crédit pour l’impôt suisse. Les 80% ne sont pas un partage des recettes entre les États. Les anciens frontaliers remplissant les conditions de l’article 9 conservent l’imposition exclusivement suisse du salaire concerné. Ce régime ne prend pas automatiquement fin en 2033 ou 2034; 2033 est la dernière année fiscale des compensations versées à l’Italie. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" }
 },
 "Cos'è il credito d'imposta per frontalieri?": {
 en: { q: "What is the foreign tax credit for cross-border workers?", a: "The foreign tax credit allows a new cross-border worker to deduct from Italian IRPEF the withholding tax already paid in Switzerland. It is claimed in section CE of the 730 / Redditi form, attaching the Swiss withholding certificate (art. 15 Italy-Switzerland tax treaty). It prevents double taxation on the same income." },
 de: { q: "Was ist die Anrechnung der auslaendischen Steuer fuer Grenzgaenger?", a: "Die Anrechnung der auslaendischen Steuer erlaubt es dem neuen Grenzgaenger, die in der Schweiz bereits bezahlte Quellensteuer von der italienischen IRPEF abzuziehen. Sie wird im Abschnitt CE des Modells 730/Redditi geltend gemacht unter Beilage der Schweizer Quellensteuerbescheinigung (Art. 15 Doppelbesteuerungsabkommen Italien-Schweiz) und vermeidet eine Doppelbesteuerung desselben Einkommens." },
 fr: { q: "Qu'est-ce que le credit d'impot etranger pour les frontaliers ?", a: "Le credit d'impot etranger permet au nouveau frontalier de deduire de l'IRPEF italienne l'impot a la source deja verse en Suisse. Il se declare au cadre CE du 730 / Redditi avec l'attestation suisse (art. 15 de la convention fiscale Italie-Suisse). Il evite la double imposition sur le meme revenu." }
 },
 "Le tasse svizzere sono più basse di quelle italiane?": {
 en: { q: "Are Swiss taxes lower than Italian ones?", a: "Yes, on average Swiss rates are lower especially on middle-to-upper incomes. A CHF 80,000 gross yields about CHF 65,000 net in Ticino (around 18% total deduction), while an equivalent euro gross in Italy would face 35–38% IRPEF plus INPS contributions. The tax advantage is the main reason for becoming a cross-border worker." },
 de: { q: "Sind die Schweizer Steuern niedriger als die italienischen?", a: "Ja, im Durchschnitt sind die Schweizer Saetze niedriger, besonders bei mittleren bis hohen Einkommen. CHF 80'000 brutto ergeben im Tessin rund CHF 65'000 netto (rund 18 % Gesamtbelastung), waehrend ein gleichwertiger Euro-Brutto in Italien 35–38 % IRPEF plus INPS-Beitraegen unterliegt. Der Steuervorteil ist der Hauptgrund, Grenzgaenger zu werden." },
 fr: { q: "Les impots suisses sont-ils plus bas que les impots italiens ?", a: "Oui, en moyenne les taux suisses sont plus bas, surtout sur les revenus moyens et eleves. CHF 80 000 bruts donnent environ CHF 65 000 nets au Tessin (environ 18 % de prelevement total), alors qu'un brut equivalent en euros en Italie subirait 35–38 % d'IRPEF plus INPS. L'avantage fiscal est la principale raison de devenir frontalier." }
 },
 "Come si calcola l'imposta alla fonte in Ticino?": {
 en: { q: "How is Ticino withholding tax calculated?", a: "Ticino withholding tax is a monthly deduction applied by the Swiss employer under tables A/B/C/H: A for singles without children, B for singles with children, C for married couples, H for single parents. The rate is progressive and depends on monthly gross income, religious affiliation and number of dependent children." },
 de: { q: "Wie wird die Quellensteuer im Tessin berechnet?", a: "Die Quellensteuer im Tessin ist ein monatlicher Abzug des Schweizer Arbeitgebers gemaess den Tarifen A/B/C/H: A fuer Alleinstehende ohne Kinder, B fuer Alleinstehende mit Kindern, C fuer Verheiratete, H fuer Alleinerziehende. Der Satz ist progressiv und haengt vom monatlichen Bruttolohn, der Konfession und der Zahl der unterhaltsberechtigten Kinder ab." },
 fr: { q: "Comment se calcule l'impot a la source au Tessin ?", a: "L'impot a la source au Tessin est une retenue mensuelle effectuee par l'employeur suisse selon les bareme A/B/C/H : A pour les celibataires sans enfants, B pour les celibataires avec enfants, C pour les couples maries, H pour les familles monoparentales. Le taux est progressif et depend du revenu brut mensuel, de la confession religieuse et du nombre d'enfants a charge." }
 },
 "Quali settori assumono di più a Lugano?": {
 en: { q: "Which sectors hire most in Lugano?", a: "In Lugano the most active sectors are: banking and finance (UBS, Credit Suisse, BancaStato, EFG), public and private healthcare (Ente Ospedaliero Cantonale, Clinica Moncucco, Clinica Sant'Anna), logistics and transport (Rhenus, DHL, Planzer), luxury retail (via Nassa), ICT, and international accounting and law firms." },
 de: { q: "Welche Branchen stellen in Lugano am meisten ein?", a: "In Lugano sind die aktivsten Branchen: Banken und Finanzen (UBS, Credit Suisse, BancaStato, EFG), oeffentliche und private Gesundheitsversorgung (Ente Ospedaliero Cantonale, Clinica Moncucco, Clinica Sant'Anna), Logistik und Transport (Rhenus, DHL, Planzer), Luxusdetailhandel (Via Nassa), ICT sowie internationale Treuhand- und Anwaltskanzleien." },
 fr: { q: "Quels secteurs recrutent le plus a Lugano ?", a: "A Lugano, les secteurs les plus actifs sont : banque et finance (UBS, Credit Suisse, BancaStato, EFG), sante publique et privee (Ente Ospedaliero Cantonale, Clinica Moncucco, Clinica Sant'Anna), logistique et transport (Rhenus, DHL, Planzer), commerce de luxe (via Nassa), ICT, et cabinets internationaux de comptabilite et d'avocats." }
 },
 "Qual è lo stipendio medio a Lugano per un frontaliere?": {
 en: { q: "What is the average salary in Lugano for a cross-border worker?", a: "Average gross salary in Lugano varies by sector: junior bank clerk CHF 70,000–80,000, ward nurse CHF 75,000–90,000, software engineer CHF 90,000–110,000, accountant CHF 80,000–100,000, logistics operator CHF 55,000–65,000. Net for a new cross-border worker (after Swiss withholding and Italian IRPEF adjustment) is about 78–84% of gross." },
 de: { q: "Wie hoch ist der Durchschnittslohn in Lugano fuer einen Grenzgaenger?", a: "Der durchschnittliche Bruttolohn in Lugano variiert je nach Branche: Junior-Bankangestellte CHF 70'000–80'000, Station-Pflegefachperson CHF 75'000–90'000, Software-Ingenieur CHF 90'000–110'000, Treuhaender CHF 80'000–100'000, Logistikmitarbeiter CHF 55'000–65'000. Das Netto fuer einen neuen Grenzgaenger (nach Quellensteuer und italienischem IRPEF-Ausgleich) betraegt rund 78–84 % des Bruttolohns." },
 fr: { q: "Quel est le salaire moyen a Lugano pour un frontalier ?", a: "Le salaire brut moyen a Lugano varie selon le secteur : employe de banque junior CHF 70 000–80 000, infirmier en service CHF 75 000–90 000, ingenieur logiciel CHF 90 000–110 000, comptable CHF 80 000–100 000, operateur logistique CHF 55 000–65 000. Le net pour un nouveau frontalier (apres impot a la source et ajustement IRPEF italien) represente environ 78–84 % du brut." }
 },
 "Come arrivare a Lugano da Como o Varese?": {
 en: { q: "How to reach Lugano from Como or Varese?", a: "From Como: car via A9 motorway plus A2 Swiss motorway (about 45–60 minutes outside rush hour) or TILO train Como-Chiasso-Lugano (30 minutes + crossing time). From Varese: TILO S40 train Varese-Stabio-Lugano (45 minutes) or car via A8/SS344 through the Gaggiolo crossing. Daily return ticket around CHF 20–28; monthly Tessin-abo CHF 75 for unlimited cantonal travel." },
 de: { q: "Wie erreicht man Lugano von Como oder Varese aus?", a: "Von Como: Auto ueber die A9-Autobahn und die A2 in der Schweiz (etwa 45–60 Minuten ausserhalb der Stosszeiten) oder TILO-Zug Como–Chiasso–Lugano (30 Minuten plus Grenzzeit). Von Varese: TILO S40 Varese–Stabio–Lugano (45 Minuten) oder Auto via A8/SS344 ueber den Grenzuebergang Gaggiolo. Tagesrueckfahrkarte rund CHF 20–28; Tessin-Abo CHF 75 monatlich fuer unbegrenztes Reisen im Kanton." },
 fr: { q: "Comment rejoindre Lugano depuis Come ou Varese ?", a: "Depuis Come : voiture par l'A9 puis l'A2 suisse (45–60 minutes hors heures de pointe) ou train TILO Come–Chiasso–Lugano (30 minutes plus temps de passage). Depuis Varese : train TILO S40 Varese–Stabio–Lugano (45 minutes) ou voiture via A8/SS344 par le poste de Gaggiolo. Aller-retour journalier environ CHF 20–28 ; Tessin-abo mensuel CHF 75 pour les deplacements cantonaux illimites." }
 },
 "Servono il permesso G e la patente italiana per lavorare a Lugano?": {
 en: { q: "Do you need a G permit and Italian driving licence to work in Lugano?", a: "Yes, the G permit is mandatory for every Italian resident working in Lugano as a cross-border commuter. The Italian driving licence remains valid in Switzerland for cross-border commuting; no Swiss licence exchange is needed as long as you retain fiscal residence in Italy. Swiss residents (permit B) must swap the licence within 12 months." },
 de: { q: "Braucht man fuer die Arbeit in Lugano die G-Bewilligung und den italienischen Fuehrerausweis?", a: "Ja, die G-Bewilligung ist fuer jede in Italien wohnhafte Person obligatorisch, die als Grenzgaengerin oder Grenzgaenger in Lugano arbeitet. Der italienische Fuehrerausweis bleibt in der Schweiz fuer die Grenzgaengertaetigkeit gueltig; ein Umtausch ist nicht noetig, solange der steuerliche Wohnsitz in Italien bleibt. Inhaber einer B-Bewilligung muessen den Fuehrerausweis innert 12 Monaten umtauschen." },
 fr: { q: "Faut-il le permis G et le permis de conduire italien pour travailler a Lugano ?", a: "Oui, le permis G est obligatoire pour toute personne residant en Italie qui travaille a Lugano comme frontalier. Le permis de conduire italien reste valable en Suisse pour la pratique frontaliere ; aucun echange n'est necessaire tant que la residence fiscale reste en Italie. Les titulaires d'un permis B doivent echanger le permis de conduire dans les 12 mois." }
 },
 "Quante aziende assumono a Lugano ogni settimana?": {
 en: { q: "How many companies hire in Lugano each week?", a: "According to the weekly job-market snapshot on frontaliereticino.ch, around 250–350 distinct Lugano-based employers post at least one new vacancy per week, with 900–1,400 total active openings across all sectors. Values fluctuate with the season — September and January are peak months; August and December the slowest." },
 de: { q: "Wie viele Unternehmen stellen in Lugano pro Woche ein?", a: "Laut der woechentlichen Arbeitsmarkt-Auswertung auf frontaliereticino.ch veroeffentlichen rund 250–350 verschiedene in Lugano ansaessige Arbeitgeber pro Woche mindestens eine neue Stelle, mit insgesamt 900–1'400 offenen Positionen ueber alle Branchen. Die Werte schwanken saisonal — September und Januar sind Spitzenmonate, August und Dezember die ruhigsten." },
 fr: { q: "Combien d'entreprises recrutent a Lugano chaque semaine ?", a: "Selon le bilan hebdomadaire du marche de l'emploi sur frontaliereticino.ch, environ 250–350 employeurs distincts bases a Lugano publient au moins une nouvelle offre par semaine, pour un total de 900–1 400 postes ouverts tous secteurs confondus. Les valeurs varient selon la saison : septembre et janvier sont les mois forts, aout et decembre les plus calmes." }
 },
 "Cosa cambia con la nuova legge frontalieri 2026?": {
 en: { q: "What changes with the new 2026 cross-border-workers law?", a: "For new fiscal cross-border workers, Switzerland applies 80% of its ordinary withholding rate; Italy taxes the income with a credit for Swiss tax. The 80% is not a revenue split between the two countries. Old cross-border workers who qualify under Article 9 retain exclusive Swiss taxation of the covered salary. Their regime does not automatically end in 2033 or 2034: 2033 is the final tax year of Swiss compensation payments to Italy. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 de: { q: "Was aendert sich mit dem neuen Grenzgaengergesetz 2026?", a: "Für neue steuerliche Grenzgänger wendet die Schweiz 80% des ordentlichen Quellensteuertarifs an; Italien besteuert das Einkommen mit Anrechnung der Schweizer Steuer. Die 80% sind keine Aufteilung der Einnahmen zwischen den Staaten. Alte Grenzgänger, die Artikel 9 erfüllen, behalten die ausschliessliche Schweizer Besteuerung des erfassten Lohns. Das Regime endet nicht automatisch 2033 oder 2034; 2033 ist das letzte Steuerjahr der Ausgleichszahlungen an Italien. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 fr: { q: "Qu'est-ce qui change avec la nouvelle loi frontaliers 2026 ?", a: "Pour les nouveaux frontaliers fiscaux, la Suisse applique 80% du taux ordinaire de retenue; l’Italie impose le revenu en accordant un crédit pour l’impôt suisse. Les 80% ne sont pas un partage des recettes entre les États. Les anciens frontaliers remplissant les conditions de l’article 9 conservent l’imposition exclusivement suisse du salaire concerné. Ce régime ne prend pas automatiquement fin en 2033 ou 2034; 2033 est la dernière année fiscale des compensations versées à l’Italie. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" }
 },
 "Chi è considerato nuovo frontaliere secondo il Nuovo Accordo?": {
 en: { q: "Who counts as a new cross-border worker under the New Agreement?", a: "A new fiscal frontier worker meets the agreement’s definition but does not qualify under Article 9 through eligible work during 31 December 2018–17 July 2023. The definition requires residence in a municipality on the official 20 km list, work in Ticino, Graubünden or Valais and return home in principle daily. Changing employer alone does not determine the regime. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 de: { q: "Wer gilt nach dem neuen Abkommen als neuer Grenzgaenger?", a: "Neue steuerliche Grenzgänger erfüllen die Definition des Abkommens, aber nicht die Voraussetzungen von Artikel 9 durch eine entsprechende Tätigkeit zwischen 31. Dezember 2018 und 17. Juli 2023. Erforderlich sind Wohnsitz in einer Gemeinde der offiziellen 20-km-Liste, Arbeit im Tessin, in Graubünden oder im Wallis und grundsätzlich tägliche Heimkehr. Der Arbeitgeberwechsel allein bestimmt das Regime nicht. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 fr: { q: "Qui est considere comme nouveau frontalier selon le nouvel accord ?", a: "Un nouveau frontalier fiscal répond à la définition de l’accord sans bénéficier de l’article 9 grâce à une activité admissible entre le 31 décembre 2018 et le 17 juillet 2023. Il faut résider dans une commune de la liste officielle des 20 km, travailler au Tessin, dans les Grisons ou en Valais et rentrer en principe chaque jour. Le seul changement d’employeur ne détermine pas le régime. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" }
 },
 "La franchigia di €10.000 è cumulabile con altre deduzioni?": {
 en: { q: "Is the EUR 10,000 allowance cumulative with other deductions?", a: "Yes, the EUR 10,000 allowance on Swiss income for new cross-border workers is cumulative with standard Italian IRPEF deductions (medical expenses, mortgage interest, restructuring bonuses) and with the foreign tax credit. However, it does not reduce INPS contributions owed in Italy and is not deductible from regional or municipal IRPEF surcharges." },
 de: { q: "Ist der Freibetrag von EUR 10'000 mit anderen Abzuegen kumulierbar?", a: "Ja, der Freibetrag von EUR 10'000 auf das Schweizer Einkommen fuer neue Grenzgaenger ist mit den ueblichen italienischen IRPEF-Abzuegen (Gesundheitskosten, Hypothekarzinsen, Sanierungsbonus) und der Anrechnung der auslaendischen Steuer kumulierbar. Er mindert jedoch nicht die INPS-Beitraege in Italien und ist nicht von den regionalen oder kommunalen IRPEF-Zuschlaegen abziehbar." },
 fr: { q: "La franchise de 10 000 EUR est-elle cumulable avec d'autres deductions ?", a: "Oui, la franchise de 10 000 EUR sur le revenu suisse pour les nouveaux frontaliers est cumulable avec les deductions IRPEF italiennes classiques (frais medicaux, interets hypothecaires, bonus renovation) et avec le credit d'impot etranger. Elle ne reduit toutefois pas les cotisations INPS dues en Italie et n'est pas deductible des additionnels regionaux ou communaux a l'IRPEF." }
 },
 "Quanto pagherò in più rispetto al vecchio regime?": {
 en: { q: "How much more will I pay compared to the old regime?", a: "For a new cross-border worker earning CHF 70,000 gross, the extra tax vs the old regime is typically EUR 1,500–3,000 per year (2–4% of gross). The gap narrows for low incomes thanks to the EUR 10,000 allowance and widens for high Italian municipal IRPEF rates. Use the simulator 'simulazione-tasse-nuovi-frontalieri' on frontaliereticino.ch for an individual figure." },
 de: { q: "Wie viel mehr zahle ich gegenueber dem alten Regime?", a: "Fuer einen neuen Grenzgaenger mit CHF 70'000 brutto liegt die Zusatzsteuer gegenueber dem alten Regime typischerweise bei EUR 1'500–3'000 pro Jahr (2–4 % des Bruttolohns). Bei tiefen Einkommen verringert sich die Differenz dank des Freibetrags von EUR 10'000, bei hohen kommunalen IRPEF-Zuschlaegen vergroessert sie sich. Nutzen Sie den Simulator 'simulazione-tasse-nuovi-frontalieri' auf frontaliereticino.ch fuer einen individuellen Wert." },
 fr: { q: "Combien paierai-je de plus par rapport a l'ancien regime ?", a: "Pour un nouveau frontalier avec CHF 70 000 bruts, le supplement d'impot par rapport a l'ancien regime est typiquement de 1 500–3 000 EUR par an (2–4 % du brut). L'ecart se reduit pour les bas revenus grace a la franchise de 10 000 EUR et s'elargit en cas de fort additionnel IRPEF communal. Utilisez le simulateur 'simulazione-tasse-nuovi-frontalieri' sur frontaliereticino.ch pour une estimation personnalisee." }
 },
 "Cosa succede ai vecchi frontalieri dopo il 2033?": {
 en: { q: "What happens to old cross-border workers after 2033?", a: "Old cross-border workers who qualify under Article 9 retain exclusive Swiss taxation of the covered salary. Their regime does not automatically end in 2033 or 2034: 2033 is the final tax year of Swiss compensation payments to Italy. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 de: { q: "Was passiert mit alten Grenzgaengern nach 2033?", a: "Alte Grenzgänger, die Artikel 9 erfüllen, behalten die ausschliessliche Schweizer Besteuerung des erfassten Lohns. Das Regime endet nicht automatisch 2033 oder 2034; 2033 ist das letzte Steuerjahr der Ausgleichszahlungen an Italien. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 fr: { q: "Qu'advient-il des anciens frontaliers apres 2033 ?", a: "Les anciens frontaliers remplissant les conditions de l’article 9 conservent l’imposition exclusivement suisse du salaire concerné. Ce régime ne prend pas automatiquement fin en 2033 ou 2034; 2033 est la dernière année fiscale des compensations versées à l’Italie. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" }
 },
 "Cos'è un OSS e come si chiama in Svizzera?": {
 en: { q: "What is an OSS and what's it called in Switzerland?", a: "The Italian OSS (Operatore Socio-Sanitario) corresponds in Switzerland to the Assistente di cura / Fachfrau Gesundheit EBA / Assistant en soins CFC, a 2-year federal certificate qualification. Duties and perimeter are similar (basic care, hygiene, mobility support), but Swiss pathways add mandatory topics on Swiss medication protocols and elderly-care standards." },
 de: { q: "Was ist ein OSS und wie heisst er in der Schweiz?", a: "Der italienische OSS (Operatore Socio-Sanitario) entspricht in der Schweiz dem Assistent in Pflege und Betreuung / Fachfrau Gesundheit EBA, einem zweijaehrigen eidgenoessischen Berufsattest. Aufgaben und Perimeter sind aehnlich (Grundpflege, Hygiene, Mobilisation), doch die Schweizer Ausbildung beinhaltet zusaetzlich Schweizer Medikamentenprotokolle und Pflegeheimstandards." },
 fr: { q: "Qu'est-ce qu'un OSS et comment s'appelle-t-il en Suisse ?", a: "L'OSS italien (Operatore Socio-Sanitario) correspond en Suisse a l'assistant en soins et accompagnement / Assistant en soins et sante communautaire AFP, une formation federale de 2 ans avec attestation. Les taches sont similaires (soins de base, hygiene, aide a la mobilite), mais le cursus suisse ajoute des modules obligatoires sur les protocoles medicamenteux et les standards des EMS suisses." }
 },
 "Qual è lo stipendio di un OSS in Svizzera?": {
 en: { q: "What is the salary of an OSS in Switzerland?", a: "Swiss care assistants (equivalent to Italian OSS) earn a median CHF 4,500–5,300 gross per month in Ticino, CHF 5,000–5,800 in German-speaking cantons, with 13th salary and overtime surcharges. Experience, night shifts (up to +25% allowance), and weekend duty can push the annual gross to CHF 65,000–75,000 — two to three times the Italian OSS salary." },
 de: { q: "Wie hoch ist der Lohn eines OSS in der Schweiz?", a: "Schweizer Pflegeassistenten (entsprechend dem italienischen OSS) verdienen im Tessin im Median CHF 4'500–5'300 brutto pro Monat, in der Deutschschweiz CHF 5'000–5'800, mit 13. Monatslohn und Ueberzeitzuschlaegen. Erfahrung, Nachtdienst (Zulage bis +25 %) und Wochenenddienst koennen das Jahresbrutto auf CHF 65'000–75'000 heben — das Zwei- bis Dreifache des italienischen OSS-Lohns." },
 fr: { q: "Quel est le salaire d'un OSS en Suisse ?", a: "Les assistants en soins suisses (equivalent de l'OSS italien) gagnent au Tessin une mediane de CHF 4 500–5 300 bruts par mois, en Suisse alemanique CHF 5 000–5 800, avec 13e salaire et suppletifs d'heures supplementaires. L'experience, les gardes de nuit (prime jusqu'a +25 %) et les services de week-end peuvent porter le brut annuel a CHF 65 000–75 000, soit deux a trois fois le salaire de l'OSS italien." }
 },
 "Come si fa riconoscere il titolo OSS italiano in Svizzera?": {
 en: { q: "How do you get an Italian OSS qualification recognised in Switzerland?", a: "You apply to the Swiss Red Cross (SRK/CRS) for recognition of the Italian OSS diploma. The process requires a certified translation of the diploma, hours of training, internship logs, and proof of work experience. SRK usually issues an equivalence to the 'Assistente di cura SRK' level within 4–6 months; additional bridging modules may be required." },
 de: { q: "Wie laesst man den italienischen OSS-Abschluss in der Schweiz anerkennen?", a: "Die Anerkennung des italienischen OSS-Diploms erfolgt beim Schweizerischen Roten Kreuz (SRK). Benoetigt werden beglaubigte Uebersetzung des Diploms, Stundenbilanz der Ausbildung, Praktikumsnachweise und Arbeitsnachweise. Das SRK stellt in der Regel innerhalb von 4–6 Monaten eine Gleichwertigkeit auf Stufe 'Pflegehelferin SRK' aus; zusaetzliche Anschlussmodule koennen verlangt werden." },
 fr: { q: "Comment faire reconnaitre le titre OSS italien en Suisse ?", a: "La reconnaissance du diplome italien OSS se demande a la Croix-Rouge suisse (CRS). Il faut fournir une traduction certifiee du diplome, le decompte des heures de formation, les attestations de stages et les certificats de travail. La CRS delivre generalement une equivalence au niveau 'Assistant en soins CRS' en 4–6 mois ; des modules complementaires peuvent etre exiges." }
 },
 "Quali strutture assumono OSS italiani in Ticino?": {
 en: { q: "Which facilities hire Italian OSS in Ticino?", a: "In Ticino Italian OSS are hired by the Ente Ospedaliero Cantonale (EOC) hospitals (Lugano, Bellinzona, Locarno, Mendrisio), private clinics (Clinica Moncucco, Clinica Sant'Anna, Clinica Luganese), residential care homes (Casa Anziani ATTE, Casa Serena, San Rocco), and spitex home-care cooperatives. Most positions require Swiss Red Cross equivalence and basic German or French for inter-cantonal flexibility." },
 de: { q: "Welche Einrichtungen stellen italienische OSS im Tessin ein?", a: "Im Tessin stellen italienische OSS vor allem die Spitaeler des Ente Ospedaliero Cantonale (EOC) ein (Lugano, Bellinzona, Locarno, Mendrisio), private Kliniken (Clinica Moncucco, Clinica Sant'Anna, Clinica Luganese), Alters- und Pflegeheime (Casa Anziani ATTE, Casa Serena, San Rocco) sowie Spitex-Genossenschaften. Die meisten Stellen verlangen eine SRK-Gleichwertigkeit und Grundkenntnisse in Deutsch oder Franzoesisch fuer kantonsuebergreifende Flexibilitaet." },
 fr: { q: "Quelles structures embauchent des OSS italiens au Tessin ?", a: "Au Tessin, les OSS italiens sont embauches par les hopitaux de l'Ente Ospedaliero Cantonale (EOC) (Lugano, Bellinzona, Locarno, Mendrisio), les cliniques privees (Clinica Moncucco, Clinica Sant'Anna, Clinica Luganese), les EMS (Casa Anziani ATTE, Casa Serena, San Rocco) et les cooperatives d'aide a domicile spitex. La plupart des postes requierent l'equivalence CRS et des notions d'allemand ou de francais pour la mobilite intercantonale." }
 },
 "Conviene fare l'OSS in Svizzera invece che in Italia?": {
 en: { q: "Is it worth working as an OSS in Switzerland rather than Italy?", a: "Financially yes: Swiss care assistants earn 2–3 times the Italian OSS salary, with regulated overtime, 13th salary and better hour-and-shift protections. The trade-off is recognition time (4–6 months via the Swiss Red Cross) and the need for basic German or French. Cross-border commuting with SSN coverage makes the net benefit particularly strong for residents of Como, Varese and Verbano." },
 de: { q: "Lohnt es sich, in der Schweiz statt in Italien als OSS zu arbeiten?", a: "Finanziell ja: Schweizer Pflegeassistenten verdienen das Zwei- bis Dreifache des italienischen OSS-Lohns, mit geregelter Ueberzeit, 13. Monatslohn und besserem Arbeitszeitschutz. Nachteile sind die Anerkennungsdauer (4–6 Monate ueber das SRK) und Grundkenntnisse in Deutsch oder Franzoesisch. Das Grenzgaengermodell mit SSN-Versicherung macht den Nettovorteil besonders hoch fuer Wohnsitze in Como, Varese und Verbano." },
 fr: { q: "Vaut-il la peine de travailler comme OSS en Suisse plutot qu'en Italie ?", a: "Financierement oui : les assistants en soins suisses gagnent 2 a 3 fois le salaire de l'OSS italien, avec des heures supplementaires encadrees, un 13e salaire et une meilleure protection du temps de travail. Les contreparties sont la duree de reconnaissance (4–6 mois via la CRS) et la necessite d'allemand ou de francais de base. Le modele frontalier avec couverture SSN rend l'avantage net particulierement fort pour les residents de Come, Varese et Verbano." }
 },
 "Di quanto sono più alti gli stipendi in Svizzera rispetto all'Italia?": {
 en: { q: "How much higher are salaries in Switzerland compared with Italy?", a: "On average Swiss salaries are 2–3 times Italian ones in PPP terms. For qualified profiles (engineering, IT, finance, healthcare) the gap is 2.5–3.5x; for manual or retail roles 1.8–2.2x. Net of Ticino cost of living and cross-border tax adjustment, the real purchasing-power advantage is about 40–60% for a cross-border worker living in Italy and working in Switzerland." },
 de: { q: "Wie viel hoeher sind die Loehne in der Schweiz im Vergleich zu Italien?", a: "Im Durchschnitt sind Schweizer Loehne 2- bis 3-mal hoeher als italienische (in Kaufkraftparitaet). Bei qualifizierten Profilen (Ingenieurwesen, IT, Finanzen, Gesundheitswesen) betraegt der Abstand das 2,5- bis 3,5-fache; bei Handwerks- oder Detailhandelsstellen das 1,8- bis 2,2-fache. Nach Abzug der Tessiner Lebenshaltungskosten und der steuerlichen Anpassung fuer Grenzgaenger betraegt der reale Kaufkraftvorteil rund 40–60 %." },
 fr: { q: "De combien les salaires suisses sont-ils superieurs aux salaires italiens ?", a: "En moyenne, les salaires suisses sont 2 a 3 fois plus eleves que les salaires italiens en parite de pouvoir d'achat. Pour les profils qualifies (ingenierie, IT, finance, sante), l'ecart atteint 2,5 a 3,5 fois ; pour les emplois manuels ou du commerce, 1,8 a 2,2 fois. Net du cout de la vie tessinois et de l'ajustement fiscal frontalier, l'avantage reel en pouvoir d'achat est d'environ 40–60 %." }
 },
 "Il costo della vita a Lugano è più alto di Milano?": {
 en: { q: "Is the cost of living in Lugano higher than in Milan?", a: "Yes, Lugano is roughly 40–55% more expensive than Milan for a comparable basket: rent +60% (two-room flat CHF 1,500 vs EUR 900), groceries +30%, dining out +40%, healthcare +70% (LAMal). Public transport is cheaper in Lugano thanks to the Tessin-abo (CHF 75 cantonal vs EUR 39 Milan ATM). The gap is the main reason cross-border workers keep residence in Italy." },
 de: { q: "Sind die Lebenshaltungskosten in Lugano hoeher als in Mailand?", a: "Ja, Lugano ist bei einem vergleichbaren Warenkorb rund 40–55 % teurer als Mailand: Miete +60 % (2-Zimmer-Wohnung CHF 1'500 gegen EUR 900), Lebensmittel +30 %, Restaurantbesuche +40 %, Gesundheitskosten +70 % (KVG). Der oeffentliche Verkehr ist in Lugano dank Tessin-Abo (CHF 75 kantonal gegenueber EUR 39 ATM Mailand) guenstiger. Dieser Abstand ist der Hauptgrund, warum Grenzgaenger ihren Wohnsitz in Italien behalten." },
 fr: { q: "Le cout de la vie a Lugano est-il plus eleve qu'a Milan ?", a: "Oui, Lugano est environ 40–55 % plus cher que Milan pour un panier comparable : loyer +60 % (2-pieces CHF 1 500 contre 900 EUR), alimentation +30 %, restaurant +40 %, sante +70 % (LAMal). Les transports publics y sont meilleur marche grace au Tessin-abo (CHF 75 cantonal contre 39 EUR ATM Milan). Cet ecart est la principale raison pour laquelle les frontaliers conservent leur residence en Italie." }
 },
 "Quali settori hanno il differenziale più ampio?": {
 en: { q: "Which sectors have the widest salary differential?", a: "The widest gross differentials between Swiss and Italian salaries are in pharmaceuticals and healthcare (+180–220%), banking and finance (+160–200%), software engineering (+170–210%), and specialised industrial manufacturing (+150–180%). Retail, hospitality and domestic work show smaller gaps (+80–110%). Qualified manual trades with CH apprenticeship (electrician, heating technician) reach +150–180%." },
 de: { q: "Welche Branchen haben das groesste Lohngefaelle?", a: "Die groessten Brutto-Lohndifferenzen zwischen Schweiz und Italien bestehen in Pharma und Gesundheitswesen (+180–220 %), Banken und Finanzen (+160–200 %), Software-Engineering (+170–210 %) und spezialisierter Industriefertigung (+150–180 %). Detailhandel, Gastgewerbe und Hausdienstleistungen zeigen kleinere Abstaende (+80–110 %). Qualifizierte handwerkliche Berufe mit Schweizer Lehrabschluss (Elektriker, Heizungstechniker) erreichen +150–180 %." },
 fr: { q: "Quels secteurs presentent le plus grand ecart salarial ?", a: "Les plus grands ecarts de salaires bruts entre la Suisse et l'Italie concernent la pharma et la sante (+180–220 %), la banque et la finance (+160–200 %), l'ingenierie logicielle (+170–210 %) et l'industrie specialisee (+150–180 %). Le commerce de detail, l'hotellerie-restauration et les services domestiques montrent des ecarts plus reduits (+80–110 %). Les metiers manuels qualifies avec CFC suisse (electricien, installateur de chauffage) atteignent +150–180 %." }
 },
 "Vale sempre la pena fare il frontaliere?": {
 en: { q: "Is it always worth becoming a cross-border worker?", a: "Not always. It pays off mostly for medium-to-qualified profiles living within 30 km of the border and willing to commute 30–90 minutes per direction. It rarely pays off for those living 80+ km away, with school-age children requiring daily logistics, or with low-paid Italian jobs that in Switzerland fall below the cost-of-living threshold. Use the frontaliereticino.ch simulators to run your personal scenario." },
 de: { q: "Lohnt es sich immer, Grenzgaenger zu werden?", a: "Nicht immer. Es lohnt sich vor allem fuer mittlere und qualifizierte Profile mit Wohnsitz innerhalb von 30 km zur Grenze, die 30–90 Minuten pro Richtung pendeln koennen. Es lohnt sich selten bei einem Wohnsitz jenseits von 80 km, bei schulpflichtigen Kindern mit taeglicher Logistik oder bei niedrig entlohnten italienischen Berufen, die in der Schweiz unter der Lebenshaltungsschwelle liegen. Nutzen Sie die Simulatoren auf frontaliereticino.ch fuer Ihr persoenliches Szenario." },
 fr: { q: "Vaut-il toujours la peine de devenir frontalier ?", a: "Pas toujours. C'est avantageux surtout pour les profils moyens a qualifies residant dans les 30 km de la frontiere et acceptant de faire la navette 30–90 minutes par sens. C'est rarement rentable pour une residence a plus de 80 km, des enfants scolarises necessitant une logistique quotidienne, ou des metiers italiens peu remuneres qui en Suisse ne couvriraient pas le cout de la vie. Utilisez les simulateurs sur frontaliereticino.ch pour votre scenario personnel." }
 },
 "Le tasse in Svizzera cancellano il vantaggio stipendiale?": {
 en: { q: "Do Swiss taxes cancel the salary advantage?", a: "The net advantage depends on pay, contributions, taxes, insurance, exchange rates and commuting costs. New fiscal cross-border workers must include Italian tax with credit for Swiss tax. Qualifying old workers retain Swiss-only taxation on Article 9 salary without an automatic switch in 2034. Use the calculator with your own inputs. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 de: { q: "Gleichen die Schweizer Steuern den Lohnvorteil aus?", a: "Der Nettovorteil hängt von Lohn, Beiträgen, Steuern, Versicherung, Wechselkurs und Pendelkosten ab. Neue steuerliche Grenzgänger müssen die italienische Steuer mit Anrechnung der Schweizer Steuer einbeziehen. Qualifizierte alte Grenzgänger behalten die ausschliessliche Schweizer Besteuerung des Artikels-9-Lohns ohne automatischen Wechsel 2034. Rechnen Sie mit Ihren eigenen Daten. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 fr: { q: "Les impots suisses annulent-ils l'avantage salarial ?", a: "L’avantage net dépend du salaire, des cotisations, des impôts, de l’assurance, du change et des trajets. Les nouveaux frontaliers fiscaux doivent inclure l’impôt italien avec crédit de l’impôt suisse. Les anciens qualifiés conservent l’imposition suisse exclusive du salaire de l’article 9, sans basculement automatique en 2034. Utilisez vos données dans le simulateur. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" }
 },

 // ── Sprint 4-E2: 14 PAA FAQ additions on Sprint 2 pillar pages ──
 "Devo presentare la dichiarazione dei redditi in Italia da frontaliere?": {
 en: { q: "Do I have to file an Italian tax return as a cross-border worker?", a: "Qualifying old cross-border workers do not pay Italian IRPEF on Swiss salary covered by Article 9; other income and reporting duties require separate assessment. New fiscal cross-border workers also declare income in Italy with credit for Swiss tax. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 de: { q: "Muss ich als Grenzgaenger eine italienische Steuererklaerung einreichen?", a: "Qualifizierte alte Grenzgänger zahlen keine italienische IRPEF auf den von Artikel 9 erfassten Schweizer Lohn. Andere Einkünfte und Meldepflichten sind separat zu prüfen. Neue steuerliche Grenzgänger deklarieren das Einkommen auch in Italien mit Anrechnung der Schweizer Steuer. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 fr: { q: "Dois-je remplir une declaration italienne en tant que frontalier ?", a: "Les anciens frontaliers qualifiés ne paient pas d’IRPEF italienne sur le salaire suisse couvert par l’article 9; les autres revenus et obligations déclaratives doivent être examinés séparément. Les nouveaux frontaliers fiscaux déclarent aussi le revenu en Italie avec crédit pour l’impôt suisse. ESTV: https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" }
 },
 "Cosa succede se cambio datore di lavoro in Svizzera nel 2026?": {
 en: { q: "What happens if I change Swiss employer in 2026?", a: "Changing employer does not automatically end old cross-border-worker treatment. Eligibility depends on fiscal frontier employment during 31 December 2018–17 July 2023 and the applicable conditions. Give the new employer the documentation needed to apply the correct tax tariff. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 de: { q: "Was passiert beim Arbeitgeberwechsel in der Schweiz 2026?", a: "Ein Arbeitgeberwechsel beendet das alte Grenzgängerregime nicht automatisch. Entscheidend sind eine steuerliche Grenzgängertätigkeit zwischen 31. Dezember 2018 und 17. Juli 2023 sowie die geltenden Voraussetzungen. Dem neuen Arbeitgeber die Nachweise für den richtigen Steuertarif vorlegen. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 fr: { q: "Que se passe-t-il si je change d'employeur suisse en 2026 ?", a: "Changer d’employeur ne met pas automatiquement fin au régime des anciens frontaliers. Il faut examiner l’activité comme frontalier fiscal entre le 31 décembre 2018 et le 17 juillet 2023 et les conditions applicables. Transmettre au nouvel employeur les justificatifs du tarif fiscal correct. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" }
 },
 "Come si recupera l'imposta alla fonte pagata in eccesso in Ticino?": {
 en: { q: "How do you reclaim overpaid Ticino withholding tax?", a: "A withholding error is different from subsequent ordinary assessment (TOU). ESTV FAQ 5.3 excludes TOU for fiscal frontier workers under the Italy–Switzerland agreement; earning over CHF 120,000 does not automatically grant access. For an incorrect deduction, check payroll with the employer and the correction procedure and deadlines with the cantonal tax authority. No fixed refund is guaranteed. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 de: { q: "Wie fordert man zu viel gezahlte Tessiner Quellensteuer zurueck?", a: "Ein Quellensteuerfehler ist von der nachträglichen ordentlichen Veranlagung (NOV) zu unterscheiden. ESTV-FAQ 5.3 schliesst die NOV für steuerliche Grenzgänger nach dem Abkommen Italien–Schweiz aus; mehr als CHF 120.000 Lohn eröffnet den Zugang nicht automatisch. Fehler mit dem Arbeitgeber prüfen und Verfahren sowie Fristen bei der kantonalen Steuerbehörde klären. Es gibt keinen garantierten Erstattungsbetrag. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 fr: { q: "Comment recuperer l'impot a la source trop percu au Tessin ?", a: "Une erreur de retenue est distincte de la taxation ordinaire ultérieure (TOU). La FAQ 5.3 de l’AFC exclut la TOU pour les frontaliers fiscaux de l’accord Italie–Suisse ; dépasser CHF 120.000 ne donne pas automatiquement accès à cette procédure. Vérifier le décompte avec l’employeur et la procédure de correction et ses délais avec l’autorité cantonale. Aucun remboursement forfaitaire n’est garanti. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" }
 },
 "Quali sono le migliori zone di Lugano dove lavorare da frontaliere?": {
 en: { q: "Which are the best Lugano areas to work in as a cross-border worker?", a: "The city centre (Piazza Riforma, Via Nassa, Besso) concentrates banks and professional firms, well served by TiLo trains and Park&Ride. Cornaredo-Trevano hosts private clinics, SUPSI and ICT companies; Pregassona and Viganello are ideal for public healthcare (EOC Civico). The Manno-Bioggio industrial belt is a logistics and manufacturing hub with large on-site parking, but less well connected to the Chiasso crossings." },
 de: { q: "Welches sind die besten Stadtteile Luganos fuer Grenzgaenger?", a: "Das Zentrum (Piazza Riforma, Via Nassa, Besso) konzentriert Banken und Fachbueros, gut erreichbar mit TiLo und Park&Ride. Cornaredo-Trevano beherbergt Privatkliniken, SUPSI und ICT; Pregassona und Viganello sind ideal fuer die oeffentliche Gesundheitsversorgung (EOC Civico). Die Industriezone Manno-Bioggio ist ein Logistik- und Fertigungszentrum mit grossem Firmenparkplatz, aber schlechter an die Uebergaenge Chiasso angebunden." },
 fr: { q: "Quels sont les meilleurs quartiers de Lugano pour travailler en frontalier ?", a: "Le centre-ville (Piazza Riforma, Via Nassa, Besso) concentre banques et etudes professionnelles, bien desservi par TiLo et Park&Ride. Cornaredo-Trevano accueille cliniques privees, SUPSI et ICT ; Pregassona et Viganello sont ideaux pour la sante publique (EOC Civico). La zone industrielle de Manno-Bioggio est un pole logistique et manufacturier avec grand parking d'entreprise, mais moins bien reliee aux postes-frontieres de Chiasso." }
 },
 "Serve il tedesco o il francese per lavorare a Lugano?": {
 en: { q: "Do you need German or French to work in Lugano?", a: "No. In Lugano Italian is the official language of Canton Ticino and covers over 90% of vacancies open to cross-border workers. English is required in international finance, ICT and some pharma multinationals. German is a plus for federal banks (UBS, ZKB) and for careers towards German-speaking Switzerland; French is rarely required in Lugano except for federal roles and pan-Swiss insurers." },
 de: { q: "Braucht man Deutsch oder Franzoesisch, um in Lugano zu arbeiten?", a: "Nein. In Lugano ist Italienisch Amtssprache des Kantons Tessin und deckt ueber 90 % der offenen Stellen fuer Grenzgaenger ab. Englisch ist in der internationalen Finanzwirtschaft, der ICT und einigen Pharma-Multis gefragt. Deutsch ist ein Vorteil fuer Bundesbanken (UBS, ZKB) und fuer Karrieren in Richtung Deutschschweiz; Franzoesisch wird in Lugano ausser in Bundesstellen und schweizweiten Versicherungen selten verlangt." },
 fr: { q: "Faut-il l'allemand ou le francais pour travailler a Lugano ?", a: "Non. A Lugano, l'italien est la langue officielle du canton du Tessin et couvre plus de 90 % des postes ouverts aux frontaliers. L'anglais est requis dans la finance internationale, l'ICT et certaines multinationales pharmaceutiques. L'allemand est un plus pour les banques federales (UBS, ZKB) et pour s'orienter vers la Suisse alemanique ; le francais est rarement demande a Lugano sauf pour les postes federaux et les assureurs pan-suisses." }
 },
 "Si può lavorare in smart working a Lugano come frontaliere?": {
 en: { q: "Can you work remotely from Lugano as a cross-border worker?", a: "Yes, but with limits. The Italy-Switzerland agreement of 23 December 2023 allows up to 25% of remote work from Italy without jeopardising cross-border-worker tax status. Beyond 25% you lose the status, with consequences on withholding tax, ristorni and fiscal residence. Swiss employers in Lugano typically offer one remote day per week, which stays well within the 25% threshold." },
 de: { q: "Kann man als Grenzgaenger in Lugano im Homeoffice arbeiten?", a: "Ja, aber mit Einschraenkungen. Das Abkommen Italien-Schweiz vom 23. Dezember 2023 erlaubt bis zu 25 % Homeoffice aus Italien, ohne den Grenzgaengerstatus zu gefaehrden. Ueber 25 % verliert man den Status mit Folgen fuer Quellensteuer, Ristorni und steuerlichen Wohnsitz. Schweizer Arbeitgeber in Lugano bieten typischerweise einen Homeoffice-Tag pro Woche an, was deutlich unterhalb der 25-%-Schwelle liegt." },
 fr: { q: "Peut-on teletravailler a Lugano en tant que frontalier ?", a: "Oui, mais avec des limites. L'accord Italie-Suisse du 23 decembre 2023 autorise jusqu'a 25 % de teletravail depuis l'Italie sans compromettre le statut de frontalier. Au-dela de 25 %, on perd le statut, avec consequences sur l'impot a la source, les ristournes et la residence fiscale. Les employeurs suisses a Lugano offrent generalement un jour de teletravail par semaine, bien en deca du seuil de 25 %." }
 },
 "La nuova legge si applica anche a chi lavora fuori Ticino?": {
 en: { q: "Does the new law apply to workers outside Ticino too?", a: "Yes. The 2020 New Agreement applies to Italian cross-border workers in every border canton (Ticino, Grisons, Valais). Those working in Grisons or Valais under the new regime face identical rules: Swiss withholding tax, Italian IRPEF with the EUR 10,000 allowance, foreign tax credit. Ticino remains the canton with the largest Italian cross-border-worker population (over 74,000 in 2025), followed by Basel-Stadt and Geneva for French-speakers." },
 de: { q: "Gilt das neue Gesetz auch ausserhalb des Tessins?", a: "Ja. Das neue Abkommen 2020 gilt fuer italienische Grenzgaenger in allen Grenzkantonen (Tessin, Graubuenden, Wallis). Wer als neuer Grenzgaenger in Graubuenden oder im Wallis arbeitet, unterliegt denselben Regeln: Schweizer Quellensteuer, italienische IRPEF mit Freibetrag von EUR 10'000, Anrechnung der auslaendischen Steuer. Das Tessin bleibt der Kanton mit den meisten italienischen Grenzgaengern (ueber 74'000 im Jahr 2025), gefolgt von Basel-Stadt und Genf fuer Franzoesischsprachige." },
 fr: { q: "La nouvelle loi s'applique-t-elle aussi hors du Tessin ?", a: "Oui. Le nouvel accord de 2020 s'applique aux frontaliers italiens dans tous les cantons frontaliers (Tessin, Grisons, Valais). Ceux qui travaillent aux Grisons ou en Valais sous le nouveau regime suivent les memes regles : impot a la source suisse, IRPEF italienne avec franchise de 10 000 EUR, credit d'impot etranger. Le Tessin reste le canton avec le plus grand nombre de frontaliers italiens (plus de 74 000 en 2025), suivi de Bale-Ville et Geneve pour les francophones." }
 },
 "Cambia qualcosa per la tredicesima e i bonus dei nuovi frontalieri?": {
 en: { q: "Does anything change for 13th-month and bonuses of new cross-border workers?", a: "No. The 13th month and performance bonuses are taxed like the rest of gross Swiss income: withholding tax at payment and included in the Italian IRPEF base for new cross-border workers. The EUR 10,000 allowance applies to the total annual income (salary + 13th + bonuses) and cannot be split by line item. In the 730/Redditi return you report the total annual gross received." },
 de: { q: "Aendert sich etwas beim 13. Monatslohn und den Boni der neuen Grenzgaenger?", a: "Nein. Der 13. Monatslohn und Leistungsboni werden wie der uebrige Schweizer Bruttolohn besteuert: Quellensteuer bei der Auszahlung und Einbezug in die italienische IRPEF-Basis fuer neue Grenzgaenger. Der Freibetrag von EUR 10'000 gilt fuer das jaehrliche Gesamteinkommen (Lohn + 13. + Bonus) und kann nicht auf Einzelposten aufgeteilt werden. In der Steuererklaerung 730/Redditi meldet man den gesamten jaehrlichen Bruttobetrag." },
 fr: { q: "Les 13e et les bonus des nouveaux frontaliers changent-ils ?", a: "Non. Le 13e mois et les primes de resultat sont imposes comme le reste du revenu brut suisse : impot a la source au moment du versement et inclusion dans la base IRPEF italienne pour les nouveaux frontaliers. La franchise de 10 000 EUR s'applique au revenu annuel total (salaire + 13e + primes) et ne peut pas etre fractionnee par rubrique. Dans la declaration 730/Redditi on declare le total brut annuel percu." }
 },
 "I contributi LPP del 2° pilastro sono deducibili in Italia?": {
 en: { q: "Are 2nd-pillar LPP contributions deductible in Italy?", a: "Distinguish mandatory LPP contributions from voluntary buy-ins and 3a payments. Check current Italian instructions using the salary certificate; a Swiss deduction does not establish Italian deductibility. ESTV FAQ 5.3 excludes subsequent ordinary assessment (TOU) for fiscal frontier workers covered by the Italy–Switzerland agreement. Other categories must check eligibility and procedure with the tax authority. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 de: { q: "Sind die Beitraege der 2. Saeule BVG in Italien abziehbar?", a: "Obligatorische BVG-Beiträge, freiwillige Einkäufe und 3a-Einzahlungen unterscheiden. Die italienische Behandlung anhand aktueller Vorgaben und Lohnausweis prüfen; ein Schweizer Abzug begründet keinen italienischen Abzug. Laut ESTV-FAQ 5.3 ist die nachträgliche ordentliche Veranlagung für steuerliche Grenzgänger des Abkommens Italien–Schweiz ausgeschlossen. Andere Kategorien müssen Voraussetzungen und Verfahren bei der Steuerbehörde prüfen. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 fr: { q: "Les cotisations LPP du 2e pilier sont-elles deductibles en Italie ?", a: "Distinguer cotisations LPP obligatoires, rachats volontaires et versements 3a. Vérifier les règles italiennes actuelles avec le certificat de salaire ; une déduction suisse ne prouve pas une déduction italienne. La FAQ 5.3 de l’AFC exclut la taxation ordinaire ultérieure pour les frontaliers fiscaux de l’accord Italie–Suisse. Les autres catégories doivent vérifier les conditions et la procédure auprès de l’autorité fiscale. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" }
 },
 "Quanto dura la formazione ASSC in Svizzera e si può fare da frontaliere?": {
 en: { q: "How long is ASSC training in Switzerland and can cross-border workers enrol?", a: "The ASSC AFC (healthcare social worker) lasts 3 years and is delivered dual-track: 2-3 days per week of practice in a Ticino healthcare facility and 1-2 days in a vocational school (CPS Lugano, CSIA Mendrisio). Cross-border workers can enrol if they find an apprenticeship with a Ticino employer: apprentice salary starts at CHF 900-1,200 per month in year 1 and reaches CHF 1,600-1,900 in year 3. The final diploma is federally recognised across Switzerland." },
 de: { q: "Wie lange dauert die FaGe-Ausbildung in der Schweiz und koennen Grenzgaenger teilnehmen?", a: "Die EFZ FaGe (Fachfrau/Fachmann Gesundheit) dauert 3 Jahre und wird dual angeboten: 2-3 Praxistage pro Woche in einer Tessiner Gesundheitseinrichtung und 1-2 Schultage an einer Berufsschule (CPS Lugano, CSIA Mendrisio). Grenzgaenger koennen sich einschreiben, wenn sie eine Lehrstelle bei einem Tessiner Arbeitgeber finden: der Lehrlingslohn beginnt im 1. Jahr bei CHF 900-1'200 monatlich und erreicht im 3. Jahr CHF 1'600-1'900. Das Abschlussdiplom ist bundesweit anerkannt." },
 fr: { q: "Combien dure la formation ASSC en Suisse et les frontaliers peuvent-ils s'inscrire ?", a: "L'ASSC CFC (Assistant en soins et sante communautaire) dure 3 ans et se deroule en format dual : 2-3 jours par semaine de pratique dans un etablissement de sante tessinois et 1-2 jours en ecole professionnelle (CPS Lugano, CSIA Mendrisio). Les frontaliers peuvent s'inscrire s'ils trouvent un apprentissage avec un employeur tessinois : le salaire d'apprenti part de CHF 900-1 200 par mois en 1re annee et atteint CHF 1 600-1 900 en 3e annee. Le diplome final est reconnu au niveau federal." }
 },
 "Quali sono le differenze tra OSS, ASSC e infermiere in Ticino?": {
 en: { q: "What are the differences between OSS, ASSC and nurse in Ticino?", a: "The ASSC (healthcare social worker, equivalent to the Italian OSS) has a 3-year AFC training and provides basic care, hygiene, mobility support and medication administration under supervision. The SSS nurse (Specialised Higher School, 3 years post-AFC) or SUP-Bachelor (3 university years) has clinical autonomy, plans care, manages complex cases. Salary ladder: ASSC CHF 55-70k; SSS nurse CHF 72-85k; SUP nurse CHF 78-95k." },
 de: { q: "Was sind die Unterschiede zwischen OSS, FaGe und Pflegefachperson im Tessin?", a: "Die FaGe (entsprechend dem italienischen OSS) hat eine 3-jaehrige EFZ-Ausbildung und uebernimmt Grundpflege, Hygiene, Mobilisation und Medikamentenabgabe unter Aufsicht. Die HF-Pflegefachperson (Hoehere Fachschule, 3 Jahre nach EFZ) oder FH-Bachelor (3 Jahre Hochschule) hat klinische Autonomie, plant die Pflege und fuehrt komplexe Faelle. Lohnleiter: FaGe CHF 55-70k; HF-Pflege CHF 72-85k; FH-Pflege CHF 78-95k." },
 fr: { q: "Quelles differences entre OSS, ASSC et infirmier au Tessin ?", a: "L'ASSC (equivalent de l'OSS italien) suit une formation CFC de 3 ans et fournit les soins de base, l'hygiene, l'aide a la mobilite et l'administration des medicaments sous supervision. L'infirmier ES (Ecole superieure, 3 ans post-CFC) ou HES-Bachelor (3 ans universitaires) dispose d'une autonomie clinique, planifie les soins et gere les cas complexes. Echelle salariale : ASSC CHF 55-70k ; infirmier ES CHF 72-85k ; infirmier HES CHF 78-95k." }
 },
 "Quali turni lavorano gli OSS in Ticino e come sono retribuiti?": {
 en: { q: "Which shifts do OSS work in Ticino and how are they paid?", a: "ASSC/OSS in Ticino hospitals work 8 to 8.5-hour shifts over three cycles: morning (6:30-15:00), afternoon (13:30-22:00) and night (21:30-7:00). The Ticino Healthcare CLA grants +25% for night shifts, +50% for Sundays/public holidays, +15% for on-call duty. An ASSC with three night shifts per week earns an extra CHF 400-700 per month. The CLA also guarantees at least 11 hours' rest between shifts and two free weekends per month." },
 de: { q: "Welche Schichten leisten die FaGe im Tessin und wie werden sie bezahlt?", a: "FaGe/OSS in Tessiner Spitaelern arbeiten 8 bis 8,5 Stunden in drei Zyklen: Frueh (6.30-15.00), Spaet (13.30-22.00) und Nacht (21.30-7.00). Der Tessiner GAV Gesundheitswesen gewaehrt +25 % fuer Nachtdienst, +50 % fuer Sonn- und Feiertage, +15 % fuer Pikettdienst. Eine FaGe mit drei Nachtschichten pro Woche verdient CHF 400-700 zusaetzlich pro Monat. Der GAV garantiert zudem mindestens 11 Stunden Ruhezeit zwischen Schichten und zwei freie Wochenenden pro Monat." },
 fr: { q: "Quels horaires font les OSS au Tessin et comment sont-ils payes ?", a: "Les ASSC/OSS dans les hopitaux tessinois effectuent des horaires de 8 a 8,5 heures sur trois cycles : matin (6 h 30-15 h), apres-midi (13 h 30-22 h) et nuit (21 h 30-7 h). La CCT Sante Tessin accorde +25 % pour le service de nuit, +50 % pour les dimanches et jours feries, +15 % pour le service de piquet. Une ASSC avec trois nuits par semaine gagne CHF 400-700 supplementaires par mois. La CCT garantit aussi au moins 11 heures de repos entre les postes et deux week-ends libres par mois." }
 },
 "Quanto vale il potere d'acquisto reale dei salari svizzeri?": {
 en: { q: "What is the real purchasing power of Swiss salaries?", a: "Adjusted for cost of living, a Swiss gross of CHF 80,000 for a cross-border worker resident in Italy delivers a real purchasing power of roughly EUR 55,000-58,000 in Italian terms, i.e. about 1.7-1.8x an Italian gross of EUR 34,000. For a Ticino resident (B permit) the gap drops to 1.3-1.4x due to rents (CHF 1,600-2,200 for a 3-room flat in Lugano) and mandatory LAMal. The advantage peaks for workers who keep Italian residence." },
 de: { q: "Wie hoch ist die reale Kaufkraft der Schweizer Loehne?", a: "Unter Beruecksichtigung der Lebenshaltungskosten entspricht ein Schweizer Brutto von CHF 80'000 fuer einen in Italien wohnhaften Grenzgaenger einer realen Kaufkraft von rund EUR 55'000-58'000 in italienischen Preisen, also etwa dem 1,7- bis 1,8-fachen eines italienischen Bruttos von EUR 34'000. Fuer einen Tessin-Residenten (B-Bewilligung) sinkt die Differenz auf 1,3-1,4x wegen Mieten (CHF 1'600-2'200 fuer eine 3-Zimmer-Wohnung in Lugano) und obligatorischer KVG. Der Vorteil ist am hoechsten bei italienischem Wohnsitz." },
 fr: { q: "Quelle est la puissance d'achat reelle des salaires suisses ?", a: "Corrige du cout de la vie, un brut suisse de CHF 80 000 pour un frontalier residant en Italie equivaut a un pouvoir d'achat reel d'environ 55 000-58 000 EUR en valeur italienne, soit environ 1,7-1,8x un brut italien de 34 000 EUR. Pour un resident tessinois (permis B), l'ecart descend a 1,3-1,4x en raison des loyers (CHF 1 600-2 200 pour un 3-pieces a Lugano) et de la LAMal obligatoire. L'avantage est maximal pour ceux qui conservent la residence italienne." }
 },
 "In quali ruoli non conviene diventare frontaliere?": {
 en: { q: "For which roles is it not worth becoming a cross-border worker?", a: "The cross-border model pays off less for: entry-level hospitality and non-specialised retail roles (waiter, sales assistant, cashier), where the gross differential is +40-60% and is eroded by commuting costs (CHF 200-400/month fuel, car wear, insurance). Short-term temporary assignments (<6 months) also rarely pay off given G-permit activation, LAMal and the loss of Italian NASpI. Fully remote or senior Italian roles above EUR 55k gross can only marginally benefit from a Swiss role if combined with a high sector differential." },
 de: { q: "Fuer welche Taetigkeiten lohnt sich der Grenzgaengerstatus nicht?", a: "Weniger lohnend ist das Grenzgaengermodell bei: Einstiegsjobs in Gastronomie und nicht spezialisiertem Detailhandel (Kellnerin, Verkaufsberater, Kassiererin), wo der Lohnunterschied von +40-60 % durch Pendlerkosten (CHF 200-400/Monat Treibstoff, Autoverschleiss, Versicherung) aufgezehrt wird. Auch kurzzeitige Temporaereinsaetze (<6 Monate) lohnen sich selten wegen G-Bewilligung, KVG und Verlust der italienischen NASpI. Vollstaendig remote arbeitende oder italienische Senior-Rollen ueber EUR 55k brutto profitieren in der Schweiz nur marginal, sofern kein hoher Branchenunterschied besteht." },
 fr: { q: "Dans quels roles le frontalier n'est-il pas avantageux ?", a: "Le frontalierat est moins avantageux pour : les emplois d'entree dans la restauration et le commerce non specialise (serveur, vendeur, caissier), ou l'ecart brut de +40-60 % est absorbe par les frais de trajet (CHF 200-400/mois d'essence, usure de la voiture, assurance). Les missions temporaires courtes (<6 mois) sont rarement rentables a cause du permis G, de la LAMal et de la perte de la NASpI italienne. Les postes full-remote ou seniors italiens au-dessus de 55k EUR bruts ne profitent que marginalement d'un emploi suisse, sauf ecart sectoriel eleve." }
 },

 // ── AE-6 border-map ──
 "Quanti valichi di confine ci sono tra Ticino e Italia?": {
 en: { q: "How many border crossings are there between Ticino and Italy?", a: "Ticino has nine main road crossings to Italy: Chiasso-Brogeda A2 (motorway, the busiest), Chiasso Centro (Ponte Chiasso, SS35), Chiasso-Strada (Brogeda alternative), Gaggiolo/Cantello-Stabio (SS344), Ponte Tresa (SS233), Bizzarone-Novazzano, Luino-Fornasette, Zenna-Dirinella (Lake Maggiore) and Maslianico-Roggiana. All are open 24/7, with morning peak 06:00-09:00 and evening peak 16:30-19:30." },
 de: { q: "Wie viele Grenzuebergaenge gibt es zwischen dem Tessin und Italien?", a: "Das Tessin hat neun Hauptstrassenuebergaenge nach Italien: Chiasso-Brogeda A2 (Autobahn, der groesste), Chiasso Centro (Ponte Chiasso, SS35), Chiasso-Strada (Ausweichroute zu Brogeda), Gaggiolo/Cantello-Stabio (SS344), Ponte Tresa (SS233), Bizzarone-Novazzano, Luino-Fornasette, Zenna-Dirinella (Lago Maggiore) und Maslianico-Roggiana. Alle sind 24 Stunden geoeffnet, mit Morgenspitze 06.00-09.00 und Abendspitze 16.30-19.30." },
 fr: { q: "Combien de postes-frontieres y a-t-il entre le Tessin et l'Italie ?", a: "Le Tessin compte neuf passages routiers principaux vers l'Italie : Chiasso-Brogeda A2 (autoroute, le plus frequente), Chiasso Centro (Ponte Chiasso, SS35), Chiasso-Strada (alternative a Brogeda), Gaggiolo/Cantello-Stabio (SS344), Ponte Tresa (SS233), Bizzarone-Novazzano, Luino-Fornasette, Zenna-Dirinella (lac Majeur) et Maslianico-Roggiana. Tous sont ouverts 24 h/24, avec une heure de pointe le matin 06h00-09h00 et le soir 16h30-19h30." }
 },

 "Qual è la fascia di 20 km per il nuovo accordo frontalieri?": {
 en: { q: "What is the 20 km zone under the new cross-border agreement?", a: "The requirement concerns the municipality of tax residence included in the official list agreed by both countries, not the distance of an individual home from the border. Residence in the zone alone is insufficient: employment in Ticino, Graubünden or Valais and, in principle, daily return are also required. Old versus new status additionally depends on qualifying employment during 31 December 2018–17 July 2023. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 de: { q: "Was ist die 20-km-Grenzzone im neuen Grenzgaengerabkommen?", a: "Massgeblich ist die steuerliche Wohngemeinde auf der von beiden Staaten vereinbarten amtlichen Liste, nicht die Entfernung des einzelnen Hauses zur Grenze. Der Wohnsitz in der Zone allein genügt nicht: Erforderlich sind auch eine Tätigkeit im Tessin, in Graubünden oder im Wallis und grundsätzlich tägliche Rückkehr. Der alte oder neue Status hängt zusätzlich von qualifizierender Beschäftigung zwischen dem 31. Dezember 2018 und dem 17. Juli 2023 ab. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" },
 fr: { q: "Qu'est-ce que la zone des 20 km du nouvel accord frontalier ?", a: "Le critère concerne la commune de résidence fiscale figurant dans la liste officielle convenue par les deux États, non la distance de chaque maison à la frontière. La résidence dans la zone ne suffit pas : il faut aussi travailler au Tessin, dans les Grisons ou en Valais et rentrer en principe chaque jour. Le statut ancien ou nouveau dépend également d’une activité admissible entre le 31 décembre 2018 et le 17 juillet 2023. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf" }
 },

 "Quali valichi hanno meno coda al mattino?": {
 en: { q: "Which border crossings have the shortest morning queues?", a: "The crossings with the lowest average morning wait times are Zenna-Dirinella (2-5 min, Locarnese), Ponte Tresa (5-15 min, western Lugano), Luino-Fornasette (4-10 min, Malcantone) and Bizzarone-Novazzano (4-10 min, Mendrisiotto). Brogeda A2 and Chiasso Centro remain the most congested with 15-30 minutes of queue during peak hours. Check live times on the embedded BAZG/USTRA webcams in each crossing page." },
 de: { q: "Welche Uebergaenge haben am Morgen am wenigsten Stau?", a: "Die Uebergaenge mit den kuerzesten durchschnittlichen Wartezeiten am Morgen sind Zenna-Dirinella (2-5 Min., Locarnese), Ponte Tresa (5-15 Min., westliches Luganese), Luino-Fornasette (4-10 Min., Malcantone) und Bizzarone-Novazzano (4-10 Min., Mendrisiotto). Brogeda A2 und Chiasso Centro bleiben mit 15-30 Minuten Wartezeit zu Spitzenzeiten am staerksten belastet. Aktuelle Zeiten siehe die eingebundenen BAZG/USTRA-Webcams auf den jeweiligen Grenzseiten." },
 fr: { q: "Quels passages ont le moins d'attente le matin ?", a: "Les passages avec les temps d'attente moyens les plus courts le matin sont Zenna-Dirinella (2-5 min, Locarnese), Ponte Tresa (5-15 min, ouest du Luganese), Luino-Fornasette (4-10 min, Malcantone) et Bizzarone-Novazzano (4-10 min, Mendrisiotto). Brogeda A2 et Chiasso Centro restent les plus charges avec 15-30 minutes de file aux heures de pointe. Consultez les temps en direct via les webcams BAZG/USTRA integrees dans chaque fiche de passage." }
 },

 "Come funzionano le addizionali IRPEF nei comuni di frontiera?": {
 en: { q: "How do IRPEF surtaxes work in border municipalities?", a: "Italian municipalities within the 20 km zone apply a municipal IRPEF surtax ranging from 0% (towns that zero it out thanks to Swiss fiscal ristorni) up to 0.9%. Municipalities with zero surtax thanks to ristorni: Maslianico, Bizzarone, Ronago, Cermenate. Municipalities with the maximum surtax: Como city (0.8%), Varese city (0.8%). For a cross-border worker earning CHF 80,000 the gap between 0% and 0.8% surtax is about EUR 570 more IRPEF per year. The choice of residence therefore has a measurable net impact." },
 de: { q: "Wie funktionieren die IRPEF-Zuschlaege in Grenzgemeinden?", a: "Italienische Gemeinden innerhalb der 20-km-Zone erheben einen kommunalen IRPEF-Zuschlag zwischen 0 % (Gemeinden, die ihn dank der Schweizer Ristorni auf null setzen) und 0,9 %. Gemeinden ohne Zuschlag dank Ristorni: Maslianico, Bizzarone, Ronago, Cermenate. Gemeinden mit maximalem Zuschlag: Stadt Como (0,8 %), Stadt Varese (0,8 %). Fuer einen Grenzgaenger mit CHF 80'000 Einkommen betraegt die Differenz zwischen 0 % und 0,8 % rund EUR 570 mehr IRPEF pro Jahr. Die Wohnsitzwahl hat damit eine messbare Nettoauswirkung." },
 fr: { q: "Comment fonctionnent les surtaxes IRPEF dans les communes frontalieres ?", a: "Les communes italiennes dans la zone des 20 km appliquent une surtaxe IRPEF communale allant de 0 % (communes qui l'annulent grace aux ristourns fiscaux suisses) a 0,9 %. Communes a surtaxe nulle grace aux ristourns : Maslianico, Bizzarone, Ronago, Cermenate. Communes a surtaxe maximale : ville de Come (0,8 %), ville de Varese (0,8 %). Pour un frontalier gagnant CHF 80 000, l'ecart entre 0 % et 0,8 % represente environ 570 EUR d'IRPEF supplementaires par an. Le choix du lieu de residence a donc un impact net mesurable." }
 },

 "Le webcam dei valichi sono in diretta?": {
 en: { q: "Are the border-crossing webcams live?", a: "Yes: the map embeds live feeds from BAZG (Federal Office for Customs and Border Security) and USTRA (Federal Roads Office) for the Chiasso-Brogeda and Gaggiolo motorway crossings. Feeds refresh every 60-120 seconds. For minor crossings without an official webcam we publish average waiting times computed from the last 12 weeks of BAZG historical data for each time slot." },
 de: { q: "Sind die Webcams an den Grenzuebergaengen live?", a: "Ja: Die Karte bindet Live-Feeds des BAZG (Bundesamt fuer Zoll und Grenzsicherheit) und der ASTRA fuer die Autobahnuebergaenge Chiasso-Brogeda und Gaggiolo ein. Die Feeds werden alle 60-120 Sekunden aktualisiert. Fuer kleinere Uebergaenge ohne offizielle Webcam veroeffentlichen wir die durchschnittlichen Wartezeiten, die aus den BAZG-Historiedaten der letzten 12 Wochen pro Tageszeit berechnet werden." },
 fr: { q: "Les webcams des postes-frontieres sont-elles en direct ?", a: "Oui : la carte integre les flux en direct du BAZG (Office federal de la douane et de la securite des frontieres) et de l'OFROU pour les passages autoroutiers Chiasso-Brogeda et Gaggiolo. Les flux se rafraichissent toutes les 60-120 secondes. Pour les passages mineurs sans webcam officielle, nous publions les temps d'attente moyens calcules a partir des donnees historiques BAZG des 12 dernieres semaines pour chaque creneau horaire." }
 },

 // ── AE-1 striking-distance: unemployment ("svizzera disoccupazione") ──────
 "Se ho lavorato in Svizzera, risulto disoccupato in Italia?": {
 en: { q: "If I worked in Switzerland, am I registered as unemployed in Italy?", a: "Yes: a cross-border worker residing in Italy who worked in Switzerland and loses their job is registered as unemployed in Italy under EU Regulation 883/2004. The unemployment benefit is claimed from INPS (NASpI) within 68 days of termination, submitting the European PD U1 form issued by the Swiss fund (URC or Caisse de Chomage) certifying insurance periods in Switzerland. Registration with the Italian Centro per l'Impiego is mandatory within 15 days. Swiss unemployment (AD/ALV) is not payable because the competent country is the one of residence: provinces of Como, Varese, Lecco, Sondrio and VCO for Ticino fiscal cross-border workers." },
 de: { q: "Wenn ich in der Schweiz gearbeitet habe, gelte ich in Italien als arbeitslos?", a: "Ja: Ein in Italien wohnhafter Grenzgaenger, der in der Schweiz gearbeitet hat und seine Stelle verliert, gilt nach EU-Verordnung 883/2004 als in Italien arbeitslos. Die Arbeitslosenentschaedigung wird beim INPS (NASpI) innerhalb von 68 Tagen nach der Entlassung beantragt; beizulegen ist das europaeische Formular PD U1 der zustaendigen Schweizer Kasse (URC oder Arbeitslosenkasse), das die Versicherungszeiten in der Schweiz bescheinigt. Die Anmeldung beim italienischen Centro per l'Impiego ist innerhalb von 15 Tagen obligatorisch. Die Schweizer Arbeitslosenversicherung (AD/ALV) ist nicht zustaendig, weil das Wohnsitzland die Leistungen traegt: Provinzen Como, Varese, Lecco, Sondrio und VCO fuer steuerliche Tessiner Grenzgaenger." },
 fr: { q: "Si j'ai travaille en Suisse, suis-je considere comme chomeur en Italie ?", a: "Oui : un frontalier residant en Italie qui a travaille en Suisse et perd son emploi est considere comme chomeur en Italie en vertu du Reglement UE 883/2004. L'indemnite de chomage est demandee a l'INPS (NASpI) dans les 68 jours suivant le licenciement, en joignant le formulaire europeen PD U1 delivre par la caisse suisse (URC ou Caisse de Chomage) qui certifie les periodes d'assurance en Suisse. L'inscription au Centro per l'Impiego italien est obligatoire dans les 15 jours. Le chomage suisse (AD/ALV) n'est pas du car le pays competent est celui de residence : provinces de Come, Varese, Lecco, Sondrio et VCO pour les frontaliers fiscaux tessinois." }
 },

 "Disoccupazione Svizzera per frontalieri: importi e durata 2026?": {
 en: { q: "Swiss unemployment benefits for cross-border workers: amounts and duration in 2026?", a: "In 2026, Swiss unemployment for totally unemployed cross-border workers is paid in Italy as NASpI: 75% of the average monthly salary up to EUR 1,425.21 plus 25% of the excess, capped at about EUR 1,550 gross per month. Duration equals half the contribution weeks in the last 4 years (up to 24 months with PD U1). A cross-border worker in partial unemployment (e.g. short-time work agreed with the Swiss employer) receives instead the Swiss AD/ALV benefit at 70-80% of the salary, capped at CHF 12,350/month for up to 18 months (source: SECO, art. 8 AVIG/LADI). Italian tax residence does not change the duration." },
 de: { q: "Arbeitslosigkeit Schweiz fuer Grenzgaenger: Betraege und Dauer 2026?", a: "2026 wird die Schweizer Arbeitslosigkeit fuer voll arbeitslose Grenzgaenger in Italien als NASpI ausgezahlt: 75 % des mittleren Monatslohns bis 1 425,21 EUR plus 25 % des uebersteigenden Betrags, Obergrenze rund 1 550 EUR brutto pro Monat. Die Dauer entspricht der Haelfte der Beitragswochen der letzten 4 Jahre (bis zu 24 Monate mit PD U1). Bei Kurzarbeit (Kurzarbeitsentschaedigung mit dem Schweizer Arbeitgeber) erhaelt der Grenzgaenger stattdessen die Schweizer AD/ALV-Leistung mit 70-80 % des Lohns, Obergrenze CHF 12'350/Monat fuer bis zu 18 Monate (Quelle: SECO, Art. 8 AVIG). Der italienische Steuerwohnsitz aendert die Dauer nicht." },
 fr: { q: "Chomage suisse pour frontaliers : montants et duree en 2026 ?", a: "En 2026, le chomage suisse pour les frontaliers totalement au chomage est verse en Italie sous forme de NASpI : 75 % du salaire mensuel moyen jusqu'a 1 425,21 EUR plus 25 % de la part excedentaire, plafond mensuel d'environ 1 550 EUR bruts. La duree correspond a la moitie des semaines de cotisation des 4 dernieres annees (jusqu'a 24 mois avec PD U1). En chomage partiel (reduction d'horaire negociee avec l'employeur suisse), le frontalier percoit au contraire l'indemnite suisse AD/ALV a 70-80 % du salaire, plafond CHF 12 350/mois pour 18 mois au maximum (source : SECO, art. 8 LACI). La residence fiscale italienne ne modifie pas la duree." }
 },

 "Quali documenti servono per la disoccupazione frontalieri Svizzera-Italia?": {
 en: { q: "Which documents do I need for Switzerland-Italy cross-border unemployment?", a: "To open unemployment after working in Switzerland you need: 1) dated termination letter from the Swiss employer; 2) annual salary certificate (Lohnausweis) for the last 12 months; 3) PD U1 form issued by the competent Swiss unemployment fund (URC Ticino: Bellinzona, Lugano, Locarno, Mendrisio); 4) valid or expired G permit; 5) ID document; 6) Italian IBAN; 7) Italian tax code (codice fiscale). The NASpI application is filed online via the INPS portal or through a patronato (CAF, ACLI, INCA). Average time to first payment: 45-60 days." },
 de: { q: "Welche Dokumente brauche ich fuer die Arbeitslosigkeit Schweiz-Italien?", a: "Um die Arbeitslosigkeit nach einer Beschaeftigung in der Schweiz zu eroeffnen benoetigen Sie: 1) datiertes Kuendigungsschreiben des Schweizer Arbeitgebers; 2) Lohnausweis der letzten 12 Monate; 3) Formular PD U1 der zustaendigen Schweizer Arbeitslosenkasse (URC Tessin: Bellinzona, Lugano, Locarno, Mendrisio); 4) gueltige oder abgelaufene G-Bewilligung; 5) Ausweisdokument; 6) italienische IBAN; 7) italienische Steuernummer (codice fiscale). Der NASpI-Antrag wird online ueber das INPS-Portal oder ueber ein Patronato (CAF, ACLI, INCA) eingereicht. Durchschnittliche Zeit bis zur ersten Auszahlung: 45-60 Tage." },
 fr: { q: "Quels documents faut-il pour le chomage frontalier Suisse-Italie ?", a: "Pour ouvrir le chomage apres un emploi en Suisse il faut : 1) lettre de licenciement datee de l'employeur suisse ; 2) certificat de salaire annuel (Lohnausweis) des 12 derniers mois ; 3) formulaire PD U1 delivre par la caisse de chomage suisse competente (URC Tessin : Bellinzone, Lugano, Locarno, Mendrisio) ; 4) permis G en cours de validite ou expire ; 5) piece d'identite ; 6) IBAN italien ; 7) numero fiscal italien (codice fiscale). La demande NASpI se fait en ligne via le portail INPS ou par un patronato (CAF, ACLI, INCA). Delai moyen avant le premier versement : 45-60 jours." }
 },

 // ── AE-1 striking-distance: border-map ("mappa confine italia svizzera") ──
 "Dove trovo una mappa del confine Italia-Svizzera aggiornata 2026?": {
 en: { q: "Where can I find an updated 2026 Italy-Switzerland border map?", a: "The 2026 Italy-Switzerland border map on frontaliereticino.ch is refreshed weekly: it embeds the 9 authorised crossings of Canton Ticino (Chiasso-Brogeda A2, Chiasso Centro, Chiasso Strada, Gaggiolo-Stabio, Ponte Tresa, Bizzarone-Novazzano, Luino-Fornasette, Zenna-Dirinella, Maslianico-Roggiana) with exact geo coordinates, average wait times per time slot and live BAZG/USTRA webcams. It also covers the belt of 146 Italian municipalities within 20 km as the crow flies — the requirement for fiscal cross-border status under the New Italy-Switzerland Agreement of 17 July 2023." },
 de: { q: "Wo finde ich eine aktuelle Grenzkarte Italien-Schweiz 2026?", a: "Die Grenzkarte Italien-Schweiz 2026 auf frontaliereticino.ch wird woechentlich aktualisiert: sie enthaelt die 9 zugelassenen Uebergaenge des Kantons Tessin (Chiasso-Brogeda A2, Chiasso Centro, Chiasso Strada, Gaggiolo-Stabio, Ponte Tresa, Bizzarone-Novazzano, Luino-Fornasette, Zenna-Dirinella, Maslianico-Roggiana) mit exakten Geokoordinaten, Durchschnittswartezeiten pro Zeitfenster und Live-Webcams von BAZG/ASTRA. Abgedeckt ist auch der Guertel der 146 italienischen Gemeinden innerhalb von 20 km Luftlinie — Voraussetzung fuer den Status als steuerlicher Grenzgaenger nach dem neuen Abkommen Italien-Schweiz vom 17. Juli 2023." },
 fr: { q: "Ou trouver une carte de la frontiere Italie-Suisse mise a jour 2026 ?", a: "La carte de la frontiere Italie-Suisse 2026 de frontaliereticino.ch est mise a jour chaque semaine : elle integre les 9 passages autorises du Canton du Tessin (Chiasso-Brogeda A2, Chiasso Centro, Chiasso Strada, Gaggiolo-Stabio, Ponte Tresa, Bizzarone-Novazzano, Luino-Fornasette, Zenna-Dirinella, Maslianico-Roggiana) avec coordonnees geographiques exactes, temps d'attente moyens par creneau horaire et webcams en direct BAZG/OFROU. Elle couvre aussi la ceinture des 146 communes italiennes situees dans un rayon de 20 km a vol d'oiseau — condition du statut de frontalier fiscal selon le nouvel accord Italie-Suisse du 17 juillet 2023." }
 },

 "Quali sono i valichi della mappa confine tra Lugano e l'Italia?": {
 en: { q: "Which crossings on the border map are nearest to Lugano?", a: "Between Lugano (the main Ticino urban centre) and the Italian border, the map displays 5 main crossings ordered by distance: Ponte Tresa (15 km, Malcantone), Gaggiolo-Stabio (18 km, northern Mendrisiotto), Bizzarone-Novazzano (20 km, Mendrisiotto), Chiasso Strada/Chiasso Centro (25 km, southern Mendrisiotto) and Brogeda A2 motorway (27 km). Best times from downtown Lugano: 25-35 minutes via the A2 motorway toward Como, 20-25 minutes toward Varese via Ponte Tresa outside peak hours. Chiasso-Brogeda remains the busiest border crossing in Europe, with more than 70,000 cross-border workers every day." },
 de: { q: "Welche Uebergaenge der Grenzkarte liegen am naechsten bei Lugano?", a: "Zwischen Lugano (dem wichtigsten staedtischen Zentrum des Tessins) und der italienischen Grenze zeigt die Karte 5 Hauptuebergaenge nach Entfernung: Ponte Tresa (15 km, Malcantone), Gaggiolo-Stabio (18 km, noerdliches Mendrisiotto), Bizzarone-Novazzano (20 km, Mendrisiotto), Chiasso Strada/Chiasso Centro (25 km, suedliches Mendrisiotto), Brogeda A2-Autobahn (27 km). Optimale Fahrzeiten ab Stadtmitte Lugano: 25-35 Min. ueber die A2 Richtung Como, 20-25 Min. Richtung Varese ueber Ponte Tresa ausserhalb der Spitzenzeiten. Chiasso-Brogeda bleibt mit ueber 70'000 Grenzgaengern pro Tag der am staerksten frequentierte Grenzuebergang Europas." },
 fr: { q: "Quels passages de la carte sont les plus proches de Lugano ?", a: "Entre Lugano (principal centre urbain du Tessin) et la frontiere italienne, la carte affiche 5 passages principaux par ordre de distance : Ponte Tresa (15 km, Malcantone), Gaggiolo-Stabio (18 km, nord du Mendrisiotto), Bizzarone-Novazzano (20 km, Mendrisiotto), Chiasso Strada/Chiasso Centro (25 km, sud du Mendrisiotto), Brogeda A2 autoroute (27 km). Temps optimaux depuis le centre de Lugano : 25-35 min via l'autoroute A2 vers Come, 20-25 min vers Varese via Ponte Tresa hors heures de pointe. Chiasso-Brogeda reste le poste-frontiere le plus frequente d'Europe avec plus de 70 000 frontaliers par jour." }
 },

 "La mappa confine Svizzera-Italia mostra anche le dogane secondarie?": {
 en: { q: "Does the Switzerland-Italy border map also list secondary customs points?", a: "Yes. Our Switzerland-Italy border map distinguishes the 4 main 24/7 crossings (Chiasso-Brogeda A2, Chiasso Strada, Gaggiolo, Ponte Tresa) from the 5 secondary customs points with reduced hours (Bizzarone-Novazzano 06:00-23:00, Luino-Fornasette 06:00-21:00, Zenna-Dirinella 06:00-22:00, Maslianico-Roggiana 05:00-23:00, Chiasso Centro 05:00-01:00). For every crossing we show the hours, current status (open/closed/queue), permitted goods type and restrictions (e.g. Pizzamiglio/Maslianico does not allow trucks over 3.5 t). Official FOCBS/BAZG data, refreshed monthly." },
 de: { q: "Zeigt die Grenzkarte Schweiz-Italien auch die Nebenzollstellen?", a: "Ja. Unsere Grenzkarte Schweiz-Italien unterscheidet die 4 rund um die Uhr geoeffneten Hauptuebergaenge (Chiasso-Brogeda A2, Chiasso Strada, Gaggiolo, Ponte Tresa) von den 5 Nebenzollstellen mit reduzierten Oeffnungszeiten (Bizzarone-Novazzano 06:00-23:00, Luino-Fornasette 06:00-21:00, Zenna-Dirinella 06:00-22:00, Maslianico-Roggiana 05:00-23:00, Chiasso Centro 05:00-01:00). Fuer jeden Uebergang werden Oeffnungszeiten, aktueller Status (offen/geschlossen/Stau), zugelassene Waren und Einschraenkungen angegeben (z. B. Pizzamiglio/Maslianico keine LKW > 3,5 t). Offizielle BAZG-Daten, monatlich aktualisiert." },
 fr: { q: "La carte de la frontiere Suisse-Italie affiche-t-elle aussi les douanes secondaires ?", a: "Oui. Notre carte de la frontiere Suisse-Italie distingue les 4 passages principaux ouverts 24/7 (Chiasso-Brogeda A2, Chiasso Strada, Gaggiolo, Ponte Tresa) des 5 postes-douane secondaires aux horaires reduits (Bizzarone-Novazzano 06:00-23:00, Luino-Fornasette 06:00-21:00, Zenna-Dirinella 06:00-22:00, Maslianico-Roggiana 05:00-23:00, Chiasso Centro 05:00-01:00). Pour chaque passage sont indiques les horaires, l'etat actuel (ouvert/ferme/file), le type de marchandises autorisees et les restrictions (p. ex. Pizzamiglio/Maslianico pas de camions > 3,5 t). Donnees officielles OFDF/BAZG, mises a jour chaque mois." }
 },

 // ── AE-1 striking-distance: cost-of-living ("costo vita svizzera vs italia") ─
 "Costo vita Svizzera vs Italia 2026: confronto Lugano-Como per un single?": {
 en: { q: "Cost of living Switzerland vs Italy 2026: Lugano vs Como for a single person?", a: "2026 Switzerland vs Italy cost-of-living comparison for a single person: a Lugano resident spends CHF 4,500-5,500/month (1-bedroom flat CHF 1,400-1,800, LAMal CHF 380-500, groceries at Migros CHF 600-800, Tessin-abo transit CHF 75, utilities CHF 180-250, leisure CHF 400-600); a Como resident spends EUR 2,100-2,700/month (1-bedroom flat EUR 500-800, free SSN healthcare, groceries EUR 350-500, EUR 35 transit pass, utilities EUR 120-180, leisure EUR 250-400). A Ticino cross-border worker residing in Como pays Italian costs but earns the Swiss salary: saves 40-50% compared to a Lugano resident, net of commuting costs (TILO train CHF 80-150/month). Sources: [UST/BFS — Consumer price index](https://www.bfs.admin.ch/bfs/en/home/statistics/prices/consumer-price-index.html), [ISTAT — Como territorial statistics](https://www.istat.it/en/archivio/statistiche+territoriali)." },
 de: { q: "Lebenshaltungskosten Schweiz vs Italien 2026: Vergleich Lugano-Como fuer Singles?", a: "Vergleich 2026 der Lebenshaltungskosten Schweiz vs Italien fuer einen Single: ein in Lugano Wohnender gibt CHF 4'500-5'500/Monat aus (2-Zimmer-Wohnung CHF 1'400-1'800, Krankenkasse CHF 380-500, Migros-Einkauf CHF 600-800, Tessin-Abo CHF 75, Nebenkosten CHF 180-250, Freizeit CHF 400-600); ein in Como Wohnender 2'100-2'700 EUR/Monat (Wohnung 500-800 EUR, SSN-Gesundheitswesen kostenlos, Einkauf 350-500 EUR, Nahverkehrsabo 35 EUR, Nebenkosten 120-180 EUR, Freizeit 250-400 EUR). Ein Tessiner Grenzgaenger, der in Como wohnt, zahlt italienische Kosten, erhaelt aber den Schweizer Lohn: spart 40-50 % gegenueber einem Luganer, abzueglich Pendelkosten (TILO CHF 80-150/Monat). Quellen: [BFS — Landesindex der Konsumentenpreise](https://www.bfs.admin.ch/bfs/de/home/statistiken/preise/landesindex-konsumentenpreise.html), [ISTAT — Gebietsstatistik Como](https://www.istat.it/en/archivio/statistiche+territoriali)." },
 fr: { q: "Cout de la vie Suisse vs Italie 2026 : comparaison Lugano-Come pour un celibataire ?", a: "Comparaison 2026 du cout de la vie Suisse vs Italie pour un celibataire : un resident a Lugano depense CHF 4 500-5 500/mois (deux pieces CHF 1 400-1 800, LAMal CHF 380-500, courses Migros CHF 600-800, abonnement Tessin CHF 75, charges CHF 180-250, loisirs CHF 400-600) ; un resident a Come 2 100-2 700 EUR/mois (deux pieces 500-800 EUR, SSN gratuit, courses 350-500 EUR, abonnement transports 35 EUR, charges 120-180 EUR, loisirs 250-400 EUR). Un frontalier tessinois residant a Come paie les couts italiens mais percoit le salaire suisse : il economise 40-50 % par rapport a un resident luganais, net des couts de pendularisation (TILO CHF 80-150/mois). Sources : [OFS — Indice des prix a la consommation](https://www.bfs.admin.ch/bfs/fr/home/statistiques/prix/indice-prix-consommation.html), [ISTAT — Statistiques territoriales de Come](https://www.istat.it/en/archivio/statistiche+territoriali)." }
 },

 "Costo vita Lugano vs Como: quanto costa davvero un frontaliere?": {
 en: { q: "Lugano vs Como cost of living: what does a cross-border worker actually pay?", a: "The Lugano vs Como cost of living for a cross-border worker commuting to Lugano and residing in Como sits at EUR 2,300-2,900/month net in 2026: 1-bedroom Como rent EUR 500-800, utilities EUR 120-180, groceries EUR 350-500 (possible 20% reduction by buying half in Switzerland within the CHF 150/day customs allowance), free SSN + optional supplementary insurance EUR 25-60/month, TILO S10 Como-Lugano commuter pass CHF 80-110/month, leisure EUR 250-400. At the same quality of life, the same profile in Lugano costs CHF 4,500-5,500 (+95-110%). Net saving for a cross-border worker: CHF 1,800-2,200/month. The gap narrows with children (free Italian public school vs Ticino nursery fees), pets (IT vet 30-50% cheaper) and elderly care. Source: [USTAT — Canton Ticino price observatory](https://www3.ti.ch/DFE/DR/USTAT/index.php?fuseaction=temi.dati&proID=28)." },
 de: { q: "Lebenshaltungskosten Lugano vs Como: Was zahlt ein Grenzgaenger wirklich?", a: "Die Lebenshaltungskosten Lugano vs Como fuer einen Grenzgaenger, der in Lugano arbeitet und in Como wohnt, liegen 2026 netto bei 2'300-2'900 EUR/Monat: Miete 2-Zimmer Como 500-800 EUR, Nebenkosten 120-180 EUR, Einkaufe 350-500 EUR (moegliche Ersparnis von 20 % durch Einkauf in der Schweiz innerhalb der Zollfreigrenze CHF 150/Tag), SSN-Gesundheitswesen kostenlos + optionale Zusatzversicherung 25-60 EUR/Monat, TILO S10 Como-Lugano Pendlerabo CHF 80-110/Monat, Freizeit 250-400 EUR. Bei gleicher Lebensqualitaet kostet dasselbe Profil in Lugano CHF 4'500-5'500 (+95-110 %). Netto-Ersparnis fuer den Grenzgaenger: CHF 1'800-2'200/Monat. Der Abstand wird kleiner bei Kindern (kostenlose italienische oeffentliche Schule vs Tessiner Kindergartengebuehren), Haustieren (IT-Tierarzt 30-50 % guenstiger) und Altenpflege. Quelle: [USTAT — Preisbeobachtung Kanton Tessin](https://www3.ti.ch/DFE/DR/USTAT/index.php?fuseaction=temi.dati&proID=28)." },
 fr: { q: "Cout de la vie Lugano vs Come : combien paye vraiment un frontalier ?", a: "Le cout de la vie Lugano vs Come pour un frontalier qui travaille a Lugano et reside a Come s'etablit a 2 300-2 900 EUR/mois nets en 2026 : loyer d'un deux pieces a Come 500-800 EUR, charges 120-180 EUR, courses 350-500 EUR (economie possible de 20 % en achetant la moitie en Suisse dans la limite de franchise douaniere CHF 150/jour), SSN gratuit + complementaire facultative 25-60 EUR/mois, abonnement TILO S10 Come-Lugano CHF 80-110/mois, loisirs 250-400 EUR. A qualite de vie egale le meme profil a Lugano coute CHF 4 500-5 500 (+95-110 %). Economie nette pour le frontalier : CHF 1 800-2 200/mois. L'ecart diminue avec les enfants (ecole publique italienne gratuite vs frais de creche au Tessin), les animaux (veterinaire IT 30-50 % moins cher) et la dependance. Source : [USTAT — Observatoire des prix du Canton du Tessin](https://www3.ti.ch/DFE/DR/USTAT/index.php?fuseaction=temi.dati&proID=28)." }
 },

 "Perché il costo vita in Svizzera è più alto di quello in Italia?": {
 en: { q: "Why is the cost of living in Switzerland higher than in Italy?", a: "The Swiss cost of living is higher than Italy's due to 5 structural factors quantified by FSO and ISTAT: (1) average wages 2.1x Italy (CHF 6,788 median 2024 vs EUR 2,369 gross median Istat 2024), which push up all labour-intensive services (restaurants, crafts, private healthcare); (2) regulated rents but indexed on the SNB reference rate (rent stress 25-30% on median incomes); (3) compulsory LAMal insurance fully paid by the insured (CHF 380-500/month in Lugano vs free Italian SSN); (4) VAT 8.1% (2024) vs Italy's 22%: the gap only halves through to consumers because Swiss margins remain higher (prices 50-70% above IT); (5) productivity and quality of life (infrastructure, transit punctuality, safety) rewarded by the labour market. The cross-border worker lives across the two systems and optimises the gap: that is why their economic advantage is the highest in Europe. Source: [FSO — Swiss CPI 2026](https://www.bfs.admin.ch/bfs/en/home/statistics/prices/consumer-price-index.html), [ISTAT — Italian CPI 2026](https://www.istat.it/en/archivio/statistiche+territoriali)." },
 de: { q: "Warum sind die Lebenshaltungskosten in der Schweiz hoeher als in Italien?", a: "Die Lebenshaltungskosten in der Schweiz sind hoeher als in Italien aus 5 strukturellen Gruenden, die BFS und ISTAT beziffern: (1) Durchschnittsloehne das 2,1-fache Italiens (Medianlohn CHF 6'788 2024 vs 2'369 EUR brutto Istat 2024), was alle arbeitsintensiven Dienstleistungen (Gastronomie, Handwerk, Privatmedizin) verteuert; (2) regulierte Mieten, aber am SNB-Referenzzinssatz indexiert (Mietbelastung 25-30 % auf mittleren Einkommen); (3) obligatorische Krankenversicherung ganz vom Versicherten bezahlt (CHF 380-500/Monat in Lugano vs kostenloses italienisches SSN); (4) MWST 8,1 % (2024) gegen 22 % in Italien: die Differenz wirkt nur zur Haelfte auf die Konsumenten, weil die Schweizer Margen hoeher bleiben (50-70 % ueber IT-Preisen); (5) Produktivitaet und Lebensqualitaet (Infrastruktur, Puenktlichkeit, Sicherheit) durch den Arbeitsmarkt honoriert. Der Grenzgaenger lebt zwischen den beiden Systemen und optimiert den Abstand: deshalb ist sein wirtschaftlicher Vorteil der hoechste Europas. Quellen: [BFS — Landesindex der Konsumentenpreise 2026](https://www.bfs.admin.ch/bfs/de/home/statistiken/preise/landesindex-konsumentenpreise.html), [ISTAT — Italienischer VPI 2026](https://www.istat.it/en/archivio/statistiche+territoriali)." },
 fr: { q: "Pourquoi le cout de la vie en Suisse est-il plus eleve qu'en Italie ?", a: "Le cout de la vie en Suisse est plus eleve qu'en Italie pour 5 facteurs structurels chiffres par l'OFS et l'ISTAT : (1) salaires moyens 2,1 fois ceux de l'Italie (CHF 6 788 mediane 2024 vs 2 369 EUR brut median Istat 2024), ce qui pousse a la hausse tous les services a forte intensite de main-d'oeuvre (restauration, artisanat, sante privee) ; (2) loyers reglementes mais indexes sur le taux de reference BNS (taux d'effort locatif 25-30 % sur les revenus medians) ; (3) LAMal obligatoire entierement a la charge de l'assure (CHF 380-500/mois a Lugano vs SSN italien gratuit) ; (4) TVA 8,1 % (2024) contre 22 % en Italie : l'ecart ne se transmet qu'a moitie aux consommateurs car les marges suisses restent plus elevees (prix 50-70 % au-dessus de l'Italie) ; (5) productivite et qualite de vie (infrastructures, ponctualite des transports, securite) recompensees par le marche du travail. Le frontalier vit entre les deux systemes et optimise l'ecart : c'est pourquoi son avantage economique est le plus eleve d'Europe. Sources : [OFS — IPC suisse 2026](https://www.bfs.admin.ch/bfs/fr/home/statistiques/prix/indice-prix-consommation.html), [ISTAT — IPC italien 2026](https://www.istat.it/en/archivio/statistiche+territoriali)." }
 },

 // ── AE-1 striking-distance: companies ("nomi ditte in svizzera che assumono") ─
 "Quali sono i nomi delle ditte in Svizzera che assumono frontalieri?": {
 en: { q: "Which are the main Swiss companies that hire cross-border workers?", a: "In 2026 the main Italian-speaking Swiss companies hiring cross-border workers are concentrated in 5 sectors: banking-finance (UBS, BancaStato, Raiffeisen Svizzera italiana, EFG), pharmaceutical/biotech (Helsinn in Lugano, IBSA in Lamone, Cosmo Pharmaceuticals in Lainate-Mendrisio, Cerbios-Pharma in Barbengo), medtech industry (Medacta International in Castel San Pietro, Daetwyler), ICT and services (PostFinance, SUPSI, Swisscom business, Rhenus logistics in Stabio), luxury retail (VF International in Stabio, Gucci Logistics in Cadempino). For the full official list of authorised cross-border employers see [SECO — Authorised staffing agencies](https://www.sem.admin.ch/sem/en/home/themen/arbeit/berufsvermittlung-und-personalverleih/zugelassene_personalverleiher.html)." },
 de: { q: "Welche Schweizer Firmen stellen im Tessin Grenzgaenger ein?", a: "2026 sind die wichtigsten italophonen Schweizer Firmen, die Grenzgaenger einstellen, in 5 Sektoren konzentriert: Banken/Finanzen (UBS, BancaStato, Raiffeisen Svizzera italiana, EFG), Pharma/Biotech (Helsinn in Lugano, IBSA in Lamone, Cosmo Pharmaceuticals in Lainate-Mendrisio, Cerbios-Pharma in Barbengo), Medizintechnik (Medacta International in Castel San Pietro, Daetwyler), ICT und Dienstleistungen (PostFinance, SUPSI, Swisscom Business, Rhenus Logistik in Stabio), Luxus-Retail (VF International in Stabio, Gucci Logistik in Cadempino). Die vollstaendige offizielle Liste der fuer Grenzgaenger zugelassenen Arbeitgeber findet sich auf [SECO — Zugelassene Personalverleiher](https://www.sem.admin.ch/sem/de/home/themen/arbeit/berufsvermittlung-und-personalverleih/zugelassene_personalverleiher.html)." },
 fr: { q: "Quelles sont les entreprises suisses qui embauchent des frontaliers ?", a: "En 2026 les principales entreprises suisses italophones qui embauchent des frontaliers sont concentrees dans 5 secteurs : banque-finance (UBS, BancaStato, Raiffeisen Svizzera italiana, EFG), pharmaceutique/biotech (Helsinn a Lugano, IBSA a Lamone, Cosmo Pharmaceuticals a Lainate-Mendrisio, Cerbios-Pharma a Barbengo), medtech (Medacta International a Castel San Pietro, Daetwyler), ICT et services (PostFinance, SUPSI, Swisscom Business, Rhenus logistique a Stabio), retail de luxe (VF International a Stabio, Gucci Logistique a Cadempino). La liste officielle complete des employeurs autorises a engager des frontaliers figure sur [SECO — Agences de placement autorisees](https://www.sem.admin.ch/sem/fr/home/themen/arbeit/berufsvermittlung-und-personalverleih/zugelassene_personalverleiher.html)." }
 },

 "Aziende in Canton Ticino: quante sono e dove cercarle nel 2026?": {
 en: { q: "How many companies are based in Canton Ticino and where can I find them in 2026?", a: "About 36,700 active companies are registered in Canton Ticino (source: [USTAT — 2024 company census](https://www3.ti.ch/DFE/DR/USTAT/index.php?fuseaction=temi.dati&proID=28)), of which more than 5,300 have at least 10 employees. 52% are based in the Lugano district, 22% in the Mendrisiotto, 11% in Luganese-Malcantone and 15% in Bellinzonese-Locarnese. Where to find them: Register of Commerce (zefix.ch) for official data, Orell-Fuessli for balance sheets, Moneyhouse for corporate networks, SUPSI Alumni for direct contacts. Corporate job openings are aggregated on JobUp, JobScout24 and our [Frontaliere Ticino — Job Board](/cerca-lavoro-ticino). Italian cross-border workers (over 74,000 according to UST) make up nearly 30% of the Ticino workforce." },
 de: { q: "Wie viele Firmen gibt es im Kanton Tessin und wo findet man sie 2026?", a: "Im Kanton Tessin sind rund 36'700 aktive Unternehmen registriert (Quelle: [USTAT — Unternehmenszaehlung 2024](https://www3.ti.ch/DFE/DR/USTAT/index.php?fuseaction=temi.dati&proID=28)), davon ueber 5'300 mit mindestens 10 Mitarbeitenden. 52 % sind im Bezirk Lugano ansaessig, 22 % im Mendrisiotto, 11 % im Luganese-Malcantone und 15 % im Bellinzonese-Locarnese. Wo suchen: Handelsregister (zefix.ch) fuer offizielle Daten, Orell Fuessli fuer Bilanzen, Moneyhouse fuer Firmennetzwerke, SUPSI Alumni fuer Direktkontakte. Stellenangebote der Unternehmen laufen auf JobUp, JobScout24 und auf unserem [Frontaliere Ticino — Job Board](/cerca-lavoro-ticino). Die italienischen Grenzgaenger (ueber 74'000 laut BFS) stellen fast 30 % der Tessiner Erwerbsbevoelkerung." },
 fr: { q: "Entreprises au Canton du Tessin : combien sont-elles et ou les chercher en 2026 ?", a: "Environ 36 700 entreprises actives sont enregistrees au Canton du Tessin (source : [USTAT — Recensement des entreprises 2024](https://www3.ti.ch/DFE/DR/USTAT/index.php?fuseaction=temi.dati&proID=28)), dont plus de 5 300 comptent au moins 10 salaries. 52 % sont dans le district de Lugano, 22 % dans le Mendrisiotto, 11 % dans le Luganese-Malcantone et 15 % dans le Bellinzonese-Locarnese. Ou les chercher : Registre du commerce (zefix.ch) pour les donnees officielles, Orell Fuessli pour les bilans, Moneyhouse pour les reseaux d'entreprises, SUPSI Alumni pour les contacts directs. Les offres d'emploi des entreprises sont agregees sur JobUp, JobScout24 et sur notre [Frontaliere Ticino — Job Board](/cerca-lavoro-ticino). Les frontaliers italiens (plus de 74 000 selon l'OFS) representent pres de 30 % de la population active tessinoise." }
 },

 "Come candidarsi alle aziende svizzero-italiane che assumono frontalieri?": {
 en: { q: "How to apply to Italian-Swiss companies hiring cross-border workers?", a: "To apply effectively to Italian-Swiss companies in 2026 you need 4 documents: CV in Europass or Swiss format (1-2 pages, ID photo, detailed education EFZ/matura, languages with CEFR level), motivation letter tailored to the company, copy of the valid G permit (or declaration of application), Italian criminal-record extract translated. Main channels: corporate career pages (UBS Careers, Medacta Careers, Helsinn Careers), LinkedIn filtered on 'Canton Ticino', JobUp/JobScout24, SECO-authorised temp agencies (Adecco, Manpower, Randstad, Kelly Services). For healthcare workers (OSS/nurses) applications go through MEBEKO diploma recognition. Average selection time: 3-6 weeks. Source: [SECO — Labour market guidance](https://www.sem.admin.ch/sem/en/home/themen/arbeit.html)." },
 de: { q: "Wie bewerbe ich mich bei Tessiner Firmen, die Grenzgaenger einstellen?", a: "Fuer eine erfolgreiche Bewerbung bei italophonen Schweizer Firmen 2026 braucht es 4 Dokumente: Lebenslauf im Europass- oder Schweizer Format (1-2 Seiten, Passfoto, detaillierter Bildungsweg EFZ/Matura, Sprachen nach GER), auf die Firma zugeschnittenes Motivationsschreiben, Kopie der gueltigen G-Bewilligung (oder Gesuch-Erklaerung), uebersetzter italienischer Strafregisterauszug. Hauptkanaele: Corporate Karriereseiten (UBS Careers, Medacta Careers, Helsinn Careers), LinkedIn mit Filter 'Canton Ticino', JobUp/JobScout24, SECO-zugelassene Personalverleiher (Adecco, Manpower, Randstad, Kelly Services). Fuer Pflegekraefte (ASSC/Pflegefachpersonen) laeuft die Bewerbung ueber die MEBEKO-Diplomanerkennung. Mittlere Selektionszeit: 3-6 Wochen. Quelle: [SECO — Orientierung Arbeitsmarkt](https://www.sem.admin.ch/sem/de/home/themen/arbeit.html)." },
 fr: { q: "Comment postuler aux entreprises italo-suisses qui embauchent des frontaliers ?", a: "Pour postuler efficacement aux entreprises italo-suisses en 2026 il faut 4 documents : CV au format Europass ou suisse (1-2 pages, photo d'identite, parcours detaille EFZ/maturite, langues avec niveau CECR), lettre de motivation personnalisee pour l'entreprise, copie du permis G en cours de validite (ou declaration de demande), extrait du casier judiciaire italien traduit. Canaux principaux : pages carrieres des entreprises (UBS Careers, Medacta Careers, Helsinn Careers), LinkedIn filtre sur 'Canton Ticino', JobUp/JobScout24, agences de placement autorisees par le SECO (Adecco, Manpower, Randstad, Kelly Services). Pour les professions de la sante (ASSC/infirmiers) la candidature passe par la reconnaissance de diplome MEBEKO. Delai moyen de selection : 3-6 semaines. Source : [SECO — Orientation marche du travail](https://www.sem.admin.ch/sem/fr/home/themen/arbeit.html)." }
 },

 // ── AE-1 striking-distance: border ("traffico dogana chiasso") ────────────
 "Traffico dogana Chiasso Brogeda: quanto si attende in media oggi?": {
 en: { q: "Chiasso-Brogeda customs traffic: what is the average wait today?", a: "Today’s wait depends on time, direction and current events. Check the border-traffic page and its observation timestamp: an expired observation does not describe the current queue. A historical average is not a live measurement." },
 de: { q: "Verkehr Zoll Chiasso-Brogeda: Wie lang ist die Wartezeit heute im Schnitt?", a: "Die heutige Wartezeit hängt von Uhrzeit, Richtung und aktuellen Ereignissen ab. Prüfen Sie auf der Verkehrsseite den Beobachtungszeitpunkt; ein abgelaufener Wert beschreibt nicht die aktuelle Schlange. Ein historischer Mittelwert ersetzt keine aktuelle Messung." },
 fr: { q: "Trafic douane Chiasso-Brogeda : quelle est l'attente moyenne aujourd'hui ?", a: "L’attente dépend de l’heure, du sens et des événements en cours. Consultez la page trafic et l’heure de l’observation: une donnée expirée ne décrit pas la file actuelle. Une moyenne historique ne remplace pas une mesure récente." }
 },

 "Brogeda vs Ponte Chiasso vs Chiasso Strada: quale conviene nel 2026?": {
 en: { q: "Brogeda vs Ponte Chiasso vs Chiasso Strada: which is best in 2026?", a: "Compare the complete route, traffic conditions and vehicle type. Brogeda Autostrada in Chiasso is staffed around the clock for tourist traffic. Check the FOCBS directory for other offices and commercial-clearance hours; no fixed time saving can be guaranteed. https://dst.bazg.admin.ch/dst/print?id=386&lang=4" },
 de: { q: "Brogeda vs Ponte Chiasso vs Chiasso Strada: Welcher Uebergang lohnt sich 2026?", a: "Vergleichen Sie die gesamte Strecke, die Verkehrslage und den Fahrzeugtyp. Brogeda Autostrada in Chiasso ist für den Reiseverkehr rund um die Uhr besetzt. Prüfen Sie andere Dienststellen und gewerbliche Abfertigungszeiten im BAZG-Verzeichnis; eine feste Zeitersparnis lässt sich nicht garantieren. https://dst.bazg.admin.ch/dst/print?id=386&lang=4" },
 fr: { q: "Brogeda vs Ponte Chiasso vs Chiasso Strada : lequel choisir en 2026 ?", a: "Comparez le trajet complet, le trafic et le type de véhicule. Brogeda Autostrada à Chiasso est occupé 24h/24 pour le trafic touristique. Consultez le répertoire OFDF pour les autres offices et le dédouanement commercial; aucun gain fixe en minutes ne peut être garanti. https://dst.bazg.admin.ch/dst/print?id=386&lang=4" }
 },

 "Come vedo il traffico dogana Chiasso in tempo reale?": {
 en: { q: "How can I see Chiasso customs traffic in real time?", a: "Open the border-traffic page and check the source, direction and observation time. Traffic-flow estimates and webcams are different measurements; verify how current each is. FOCBS office hours describe available services, not the length of the queue." },
 de: { q: "Wie sehe ich den Zollverkehr Chiasso in Echtzeit?", a: "Öffnen Sie die Grenzverkehrsseite und prüfen Sie Quelle, Richtung und Beobachtungszeit. Verkehrsschätzungen und Webcams sind unterschiedliche Messungen; prüfen Sie jeweils die Aktualität. BAZG-Öffnungszeiten beschreiben Dienste, nicht die Staulänge." },
 fr: { q: "Comment voir le trafic douane Chiasso en temps reel ?", a: "Ouvrez la page trafic et vérifiez la source, le sens et l’heure d’observation. Les estimations de flux et les webcams sont des mesures différentes; vérifiez leur fraîcheur. Les horaires OFDF décrivent les services, non la longueur de la file." }
 },

 // ── AE-1 striking-distance: holidays ("festivi in ticino") ─────────────────
 "Qual è la festa del Canton Ticino più sentita?": {
 en: { q: "What is the most celebrated public holiday in Canton Ticino?", a: "The most celebrated public holiday in Canton Ticino is 1 August (Swiss National Day) with bonfires on the hills of Lugano, Mendrisio, Chiasso and Bellinzona, followed by Ferragosto (Assumption, 15 August) with processions in the Catholic villages of Mendrisiotto and Malcantone. Historically Saint Joseph (19 March) is a patronal feast in several Ticino municipalities. Canton Ticino has no single 'cantonal' holiday like Jura: its festive identity blends the Swiss federal calendar with Italian-speaking Catholic traditions." },
 de: { q: "Welcher Feiertag wird im Kanton Tessin am intensivsten gefeiert?", a: "Der am intensivsten gefeierte Feiertag im Kanton Tessin ist der 1. August (Schweizer Bundesfeier) mit Hoehenfeuern ueber Lugano, Mendrisio, Chiasso und Bellinzona, gefolgt von Ferragosto (Maria Himmelfahrt, 15. August) mit Prozessionen in den katholischen Doerfern des Mendrisiotto und des Malcantone. Historisch ist auch der Josefstag (19. Maerz) Patronatsfest in mehreren Tessiner Gemeinden. Das Tessin kennt keinen einzigen 'Kantonsfeiertag' wie der Jura: seine festliche Identitaet verbindet Bundeskalender und italophone katholische Traditionen." },
 fr: { q: "Quelle est la fete la plus celebree au Canton du Tessin ?", a: "La fete la plus celebree au Canton du Tessin est le 1er aout (Fete nationale suisse) avec feux de joie sur les hauteurs de Lugano, Mendrisio, Chiasso et Bellinzone, suivie du Ferragosto (Assomption, 15 aout) avec processions dans les villages catholiques du Mendrisiotto et du Malcantone. Historiquement la Saint-Joseph (19 mars) est fete patronale dans plusieurs communes tessinoises. Le Tessin n'a pas de fete 'cantonale' unique comme le Jura : son identite festive combine calendrier federal suisse et traditions catholiques italophones." }
 },

 "Quali sono i prossimi festivi in Ticino 2026?": {
 en: { q: "Which are the upcoming public holidays in Ticino 2026?", a: "The upcoming public holidays in Ticino in 2026 — from mid-year onwards — are: Saints Peter and Paul (Monday 29 June), Swiss National Day (Saturday 1 August), Assumption (Saturday 15 August), All Saints' Day (Sunday 1 November), Immaculate Conception (Tuesday 8 December), Christmas (Friday 25 December) and Saint Stephen (Saturday 26 December). Three of these fall on the weekend and do not generate a recovery day at Ticino companies without an improved collective agreement (CCL)." },
 de: { q: "Welche Feiertage stehen im Tessin 2026 noch an?", a: "Die kommenden Feiertage im Tessin 2026 — ab Jahresmitte — sind: Peter und Paul (Montag, 29. Juni), Bundesfeier (Samstag, 1. August), Maria Himmelfahrt (Samstag, 15. August), Allerheiligen (Sonntag, 1. November), Maria Empfaengnis (Dienstag, 8. Dezember), Weihnachten (Freitag, 25. Dezember) und Stephanstag (Samstag, 26. Dezember). Drei davon fallen auf das Wochenende und ergeben ohne verbesserten GAV keinen Ersatzruhetag in Tessiner Unternehmen." },
 fr: { q: "Quels sont les prochains jours feries au Tessin en 2026 ?", a: "Les prochains jours feries au Tessin en 2026 — a partir de la mi-annee — sont : Saints Pierre et Paul (lundi 29 juin), Fete nationale suisse (samedi 1er aout), Assomption (samedi 15 aout), Toussaint (dimanche 1er novembre), Immaculee Conception (mardi 8 decembre), Noel (vendredi 25 decembre) et Saint-Etienne (samedi 26 decembre). Trois de ces jours tombent le week-end et ne donnent droit a aucune journee de recuperation dans les entreprises tessinoises sans CCT ameliore." }
 },

 "I festivi in Ticino sono uguali a quelli della Svizzera italiana?": {
 en: { q: "Are public holidays in Ticino the same as in Italian-speaking Switzerland?", a: "Yes: Canton Ticino and the Italian-speaking valleys of Canton Graubuenden (Mesolcina, Calanca, Bregaglia, Poschiavo) share the same Catholic holiday calendar, including Epiphany, Saint Joseph, Corpus Christi, Assumption, All Saints' Day and Immaculate Conception. The difference appears compared with Protestant cantons (Zurich, Bern, Basel-City) where these feasts are not official public holidays. A cross-border worker moving from Lugano to Zurich loses on average 5-7 public holidays per year." },
 de: { q: "Sind die Feiertage im Tessin identisch mit jenen der italienischen Schweiz?", a: "Ja: Der Kanton Tessin und die italophonen Taeler Graubuendens (Mesolcina, Calanca, Bregaglia, Puschlav) teilen denselben katholischen Feiertagskalender mit Dreikoenigen, Josefstag, Fronleichnam, Maria Himmelfahrt, Allerheiligen und Maria Empfaengnis. Der Unterschied zeigt sich gegenueber den reformierten Kantonen (Zuerich, Bern, Basel-Stadt), wo diese Tage keine offiziellen Feiertage sind. Ein Grenzgaenger, der von Lugano nach Zuerich wechselt, verliert im Schnitt 5-7 Feiertage pro Jahr." },
 fr: { q: "Les jours feries au Tessin sont-ils identiques a ceux de la Suisse italophone ?", a: "Oui : le Canton du Tessin et les vallees italophones du canton des Grisons (Mesolcina, Calanca, Bregaglia, Poschiavo) partagent le meme calendrier des fetes catholiques, avec Epiphanie, Saint-Joseph, Fete-Dieu, Assomption, Toussaint et Immaculee Conception. La difference apparait par rapport aux cantons protestants (Zurich, Berne, Bale-Ville) ou ces dates ne sont pas des jours feries officiels. Un frontalier qui passe de Lugano a Zurich perd en moyenne 5-7 jours feries par an." }
 },

 // ── DE-native aliases for holidaysDe FAQPage entries ────────────────────
 // The /de/steuern-und-vorsorge/tessin-feiertage page declares its FAQPage
 // schema with German question strings directly. The faq-coverage test
 // regex extracts every "Question.name" field blind to language, so those
 // DE strings need FAQ_TRANSLATIONS entries too. We alias each DE question
 // to the same {en, de, fr} translations as its Italian counterpart above.
 "Wie viele Feiertage gibt es im Kanton Tessin im Jahr 2026?": {
 en: { q: "How many public holidays are there in Canton Ticino in 2026?", a: "Canton Ticino has 15 official public holidays in 2026, including federal holidays (New Year, 1st August) and cantonal ones (St Joseph, Corpus Christi, Saints Peter and Paul, Assumption, All Saints, Immaculate Conception)." },
 de: { q: "Wie viele Feiertage gibt es im Kanton Tessin im Jahr 2026?", a: "Der Kanton Tessin hat 2026 15 offizielle Feiertage, darunter Bundesfeiertage (Neujahr, 1. August) und kantonale Feiertage (Josefstag, Fronleichnam, Peter und Paul, Mariä Himmelfahrt, Allerheiligen, Mariä Empfängnis)." },
 fr: { q: "Combien de jours fériés y a-t-il au Tessin en 2026 ?", a: "Le Tessin compte 15 jours fériés officiels en 2026, incluant les fêtes fédérales (Nouvel An, 1er août) et cantonales (Saint-Joseph, Fête-Dieu, Saints Pierre et Paul, Assomption, Toussaint, Immaculée Conception)." }
 },
 "Ist der 1. August 2026 ein Feiertag im Tessin?": {
 en: { q: "Is August 1st 2026 a public holiday in Ticino?", a: "Yes, August 1st 2026 is the Swiss National Day, a federal public holiday nationwide including Ticino. In 2026 it falls on a Saturday, so workers who do not work on Saturdays do not receive a compensatory day off under the Swiss Code of Obligations: most Ticino collective labour agreements (CCL) do not provide compensation." },
 de: { q: "Ist der 1. August 2026 ein Feiertag im Tessin?", a: "Ja, der 1. August 2026 ist der Schweizer Nationalfeiertag und ein nationaler Bundesfeiertag, auch im Tessin. 2026 fällt er auf einen Samstag: Wer nicht samstags arbeitet, erhält laut Schweizer Obligationenrecht keinen Ausgleichstag — die meisten Tessiner GAV sehen keine Kompensation vor." },
 fr: { q: "Le 1er août 2026 est-il férié au Tessin ?", a: "Oui, le 1er août 2026 est la Fête nationale suisse, un jour férié fédéral dans tout le pays, Tessin inclus. En 2026 il tombe un samedi : les travailleurs qui ne travaillent pas le samedi ne bénéficient pas d'un jour de récupération selon le Code des obligations suisse ; la plupart des CCT tessinoises ne prévoient pas de compensation." }
 },
 "Was passiert, wenn ein Feiertag in der Schweiz auf einen Samstag oder Sonntag fällt?": {
 en: { q: "What happens if a public holiday falls on a Saturday or Sunday in Switzerland?", a: "In Switzerland, unlike Italy, if a public holiday falls on a Saturday or Sunday it is NOT recovered: the worker simply loses the benefit of the free day. In 2026 this applies to two important Ticino holidays: August 1st (Saturday) and August 15th — Assumption (Saturday). Only some sector CCLs provide a recovery day." },
 de: { q: "Was passiert, wenn ein Feiertag in der Schweiz auf einen Samstag oder Sonntag fällt?", a: "Anders als in Italien werden Feiertage in der Schweiz NICHT nachgeholt, wenn sie auf einen Samstag oder Sonntag fallen: Der freie Tag geht schlicht verloren. 2026 betrifft das zwei wichtige Tessiner Feiertage: den 1. August (Samstag) und den 15. August — Mariä Himmelfahrt (Samstag). Nur einige Branchen-GAV sehen einen Nachholtag vor." },
 fr: { q: "Que se passe-t-il si un jour férié tombe un samedi ou un dimanche en Suisse ?", a: "Contrairement à l'Italie, en Suisse un jour férié qui tombe un samedi ou un dimanche n'est PAS récupéré : le travailleur perd simplement le bénéfice du jour de congé. En 2026 cela concerne deux jours fériés tessinois importants : le 1er août (samedi) et le 15 août — Assomption (samedi). Seules certaines CCT sectorielles prévoient un jour de récupération." }
 },
 "Welche Feiertage werden im Tessin anerkannt, im Rest der Schweiz aber NICHT?": {
 en: { q: "Which public holidays are recognised in Ticino but NOT in the rest of Switzerland?", a: "Ticino, being a historically Catholic canton, recognises 7 additional cantonal holidays compared to Protestant cantons: Epiphany (Jan 6), St Joseph (Mar 19), Corpus Christi, Saints Peter and Paul (Jun 29), Assumption (Aug 15), All Saints (Nov 1), and Immaculate Conception (Dec 8). This means a cross-border worker in Ticino has on average 3 to 5 more paid holidays than someone working in Zurich or Basel." },
 de: { q: "Welche Feiertage sind im Tessin anerkannt, im Rest der Schweiz jedoch NICHT?", a: "Das Tessin — als historisch katholischer Kanton — anerkennt 7 zusätzliche kantonale Feiertage gegenüber den protestantischen Kantonen: Dreikönigstag (6.1.), Josefstag (19.3.), Fronleichnam, Peter und Paul (29.6.), Mariä Himmelfahrt (15.8.), Allerheiligen (1.11.) und Mariä Empfängnis (8.12.). Ein Grenzgänger im Tessin hat im Durchschnitt 3 bis 5 bezahlte Feiertage mehr als jemand in Zürich oder Basel." },
 fr: { q: "Quels jours fériés sont reconnus au Tessin mais PAS dans le reste de la Suisse ?", a: "Le Tessin, canton historiquement catholique, reconnaît 7 jours fériés cantonaux supplémentaires par rapport aux cantons protestants : Épiphanie (6/1), Saint-Joseph (19/3), Fête-Dieu, Saints Pierre et Paul (29/6), Assomption (15/8), Toussaint (1/11) et Immaculée Conception (8/12). Un frontalier au Tessin bénéficie en moyenne de 3 à 5 jours fériés payés de plus qu'à Zurich ou Bâle." }
 },
 "Gelten italienische Feiertage (25. April, 2. Juni) auch für Grenzgänger?": {
 en: { q: "Do Italian public holidays (April 25th, June 2nd) apply to cross-border workers?", a: "No. Cross-border workers follow the Swiss/Ticino holiday calendar because the employment relationship is governed by Swiss labour law (lex loci laboris). Italian holidays (April 25th Liberation, June 2nd Republic Day, local patron saint, December 8th, etc.) are not recognised as non-working days by the Swiss employer: to stay home, the cross-border worker must use ordinary annual leave." },
 de: { q: "Gelten italienische Feiertage (25. April, 2. Juni) für Grenzgänger?", a: "Nein. Grenzgänger richten sich nach dem Schweizer bzw. Tessiner Feiertagskalender, weil das Arbeitsverhältnis dem Schweizer Arbeitsrecht unterliegt (lex loci laboris). Italienische Feiertage (25. April Befreiungstag, 2. Juni Tag der Republik, Patronatsfest, 8. Dezember etc.) gelten beim Schweizer Arbeitgeber nicht als arbeitsfreie Tage: Wer zu Hause bleiben möchte, muss reguläre Ferien nehmen." },
 fr: { q: "Les jours fériés italiens (25 avril, 2 juin) s'appliquent-ils au frontalier ?", a: "Non. Le frontalier suit le calendrier des jours fériés suisse/tessinois car la relation de travail est régie par le droit suisse (lex loci laboris). Les jours fériés italiens (25 avril Libération, 2 juin Fête de la République, saint patron, 8 décembre, etc.) ne sont pas reconnus comme jours non ouvrés par l'employeur suisse : pour rester à la maison, le frontalier doit prendre un jour de congé ordinaire." }
 },
 "Wie wird ein Grenzgänger im Tessin an Feiertagen bezahlt?": {
 en: { q: "How is a cross-border worker paid on public holidays in Ticino?", a: "The Swiss Code of Obligations and the Labour Act require the Swiss employer to pay for public holidays falling on a working day even if the employee is absent. Hourly-paid workers (Stundenlohn) receive their regular pay and monthly-paid workers receive their full salary. If the cross-border worker works on a public holiday, most Ticino CCLs provide a 50% surcharge or a compensatory day off; some sectors (healthcare, hospitality, transport) go up to 100%." },
 de: { q: "Wie wird ein Grenzgänger im Tessin an Feiertagen bezahlt?", a: "Obligationenrecht und Arbeitsgesetz verpflichten den Schweizer Arbeitgeber, Feiertage, die auf einen Arbeitstag fallen, auch bei Abwesenheit des Arbeitnehmers zu bezahlen. Im Stundenlohn Beschäftigte erhalten den üblichen Lohn, Monatslohnempfänger den vollen Lohn. Wer an einem Feiertag arbeitet, erhält in den meisten Tessiner GAV einen Zuschlag von 50 % oder einen Kompensationstag; manche Branchen (Gesundheit, Gastgewerbe, Transport) zahlen bis zu 100 %." },
 fr: { q: "Comment le frontalier est-il payé les jours fériés au Tessin ?", a: "Le Code des obligations et la Loi sur le travail imposent à l'employeur suisse de payer les jours fériés tombant sur un jour ouvrable même en cas d'absence du salarié. Les salariés payés à l'heure (Stundenlohn) reçoivent leur paie habituelle, ceux au mois leur salaire complet. Si le frontalier travaille un jour férié, la plupart des CCT tessinoises prévoient une majoration de 50 % ou un jour de récupération ; certains secteurs (santé, hôtellerie, transports) vont jusqu'à 100 %." }
 },
 "Was sind die besten Brückentage für Grenzgänger 2026?": {
 en: { q: "What are the best long weekends for cross-border workers in 2026?", a: "The most convenient long weekends in 2026 are Easter (Good Friday + Easter Monday), Ascension (Thursday, one bridge day needed), and Corpus Christi (Thursday, one bridge day needed). Check our interactive calendar." },
 de: { q: "Welche Brückentage sind 2026 für Grenzgänger am günstigsten?", a: "Die günstigsten Brückentage 2026 sind Ostern (Karfreitag + Ostermontag), Auffahrt (Donnerstag, ein Brückentag nötig) und Fronleichnam (Donnerstag, ein Brückentag nötig). Schauen Sie in unseren interaktiven Kalender." },
 fr: { q: "Quels sont les meilleurs ponts pour les frontaliers en 2026 ?", a: "Les ponts les plus avantageux en 2026 sont Pâques (Vendredi saint + lundi de Pâques), l'Ascension (jeudi, un jour de pont nécessaire) et la Fête-Dieu (jeudi, un jour de pont nécessaire). Consultez notre calendrier interactif." }
 },
 "Wie viele Ferientage hat ein Grenzgänger in der Schweiz?": {
 en: { q: "How many vacation days does a cross-border worker have in Switzerland?", a: "By Swiss law, the minimum is 4 weeks (20 working days) per year for adults and 5 weeks for workers under 20. Many collective labour agreements (CCL) provide 5 weeks after a certain seniority." },
 de: { q: "Wie viele Ferientage hat ein Grenzgänger in der Schweiz?", a: "Das Schweizer Gesetz sieht mindestens 4 Wochen (20 Arbeitstage) pro Jahr für Erwachsene und 5 Wochen für Arbeitnehmer unter 20 Jahren vor. Viele Gesamtarbeitsverträge (GAV) sehen nach einer gewissen Betriebszugehörigkeit 5 Wochen vor." },
 fr: { q: "Combien de jours de vacances a un frontalier en Suisse ?", a: "Selon la loi suisse, le minimum est de 4 semaines (20 jours ouvrables) par an pour les adultes et 5 semaines pour les travailleurs de moins de 20 ans. De nombreuses conventions collectives (CCT) prévoient 5 semaines après une certaine ancienneté." }
 },
 "Welcher ist der bedeutendste Feiertag im Kanton Tessin?": {
 en: { q: "What is the most celebrated public holiday in Canton Ticino?", a: "The most celebrated public holiday in Canton Ticino is 1 August (Swiss National Day) with bonfires on the hills of Lugano, Mendrisio, Chiasso and Bellinzona, followed by Ferragosto (Assumption, 15 August) with processions in the Catholic villages of Mendrisiotto and Malcantone. Historically Saint Joseph (19 March) is a patronal feast in several Ticino municipalities. Canton Ticino has no single 'cantonal' holiday like Jura: its festive identity blends the Swiss federal calendar with Italian-speaking Catholic traditions." },
 de: { q: "Welcher Feiertag wird im Kanton Tessin am intensivsten gefeiert?", a: "Der am intensivsten gefeierte Feiertag im Kanton Tessin ist der 1. August (Schweizer Bundesfeier) mit Hoehenfeuern ueber Lugano, Mendrisio, Chiasso und Bellinzona, gefolgt von Ferragosto (Maria Himmelfahrt, 15. August) mit Prozessionen in den katholischen Doerfern des Mendrisiotto und des Malcantone. Historisch ist auch der Josefstag (19. Maerz) Patronatsfest in mehreren Tessiner Gemeinden. Das Tessin kennt keinen einzigen 'Kantonsfeiertag' wie der Jura: seine festliche Identitaet verbindet Bundeskalender und italophone katholische Traditionen." },
 fr: { q: "Quelle est la fete la plus celebree au Canton du Tessin ?", a: "La fete la plus celebree au Canton du Tessin est le 1er aout (Fete nationale suisse) avec feux de joie sur les hauteurs de Lugano, Mendrisio, Chiasso et Bellinzone, suivie du Ferragosto (Assomption, 15 aout) avec processions dans les villages catholiques du Mendrisiotto et du Malcantone. Historiquement la Saint-Joseph (19 mars) est fete patronale dans plusieurs communes tessinoises. Le Tessin n'a pas de fete 'cantonale' unique comme le Jura : son identite festive combine calendrier federal suisse et traditions catholiques italophones." }
 },
 "Welche sind die nächsten Feiertage im Tessin 2026?": {
 en: { q: "Which are the upcoming public holidays in Ticino 2026?", a: "The upcoming public holidays in Ticino in 2026 — from mid-year onwards — are: Saints Peter and Paul (Monday 29 June), Swiss National Day (Saturday 1 August), Assumption (Saturday 15 August), All Saints' Day (Sunday 1 November), Immaculate Conception (Tuesday 8 December), Christmas (Friday 25 December) and Saint Stephen (Saturday 26 December). Three of these fall on the weekend and do not generate a recovery day at Ticino companies without an improved collective agreement (CCL)." },
 de: { q: "Welche Feiertage stehen im Tessin 2026 noch an?", a: "Die kommenden Feiertage im Tessin 2026 — ab Jahresmitte — sind: Peter und Paul (Montag, 29. Juni), Bundesfeier (Samstag, 1. August), Maria Himmelfahrt (Samstag, 15. August), Allerheiligen (Sonntag, 1. November), Maria Empfaengnis (Dienstag, 8. Dezember), Weihnachten (Freitag, 25. Dezember) und Stephanstag (Samstag, 26. Dezember). Drei davon fallen auf das Wochenende und ergeben ohne verbesserten GAV keinen Ersatzruhetag in Tessiner Unternehmen." },
 fr: { q: "Quels sont les prochains jours feries au Tessin en 2026 ?", a: "Les prochains jours feries au Tessin en 2026 — a partir de la mi-annee — sont : Saints Pierre et Paul (lundi 29 juin), Fete nationale suisse (samedi 1er aout), Assomption (samedi 15 aout), Toussaint (dimanche 1er novembre), Immaculee Conception (mardi 8 decembre), Noel (vendredi 25 decembre) et Saint-Etienne (samedi 26 decembre). Trois de ces jours tombent le week-end et ne donnent droit a aucune journee de recuperation dans les entreprises tessinoises sans CCT ameliore." }
 },
 "Sind die Feiertage im Tessin gleich wie in der italienischen Schweiz?": {
 en: { q: "Are public holidays in Ticino the same as in Italian-speaking Switzerland?", a: "Yes: Canton Ticino and the Italian-speaking valleys of Canton Graubuenden (Mesolcina, Calanca, Bregaglia, Poschiavo) share the same Catholic holiday calendar, including Epiphany, Saint Joseph, Corpus Christi, Assumption, All Saints' Day and Immaculate Conception. The difference appears compared with Protestant cantons (Zurich, Bern, Basel-City) where these feasts are not official public holidays. A cross-border worker moving from Lugano to Zurich loses on average 5-7 public holidays per year." },
 de: { q: "Sind die Feiertage im Tessin identisch mit jenen der italienischen Schweiz?", a: "Ja: Der Kanton Tessin und die italophonen Taeler Graubuendens (Mesolcina, Calanca, Bregaglia, Puschlav) teilen denselben katholischen Feiertagskalender mit Dreikoenigen, Josefstag, Fronleichnam, Maria Himmelfahrt, Allerheiligen und Maria Empfaengnis. Der Unterschied zeigt sich gegenueber den reformierten Kantonen (Zuerich, Bern, Basel-Stadt), wo diese Tage keine offiziellen Feiertage sind. Ein Grenzgaenger, der von Lugano nach Zuerich wechselt, verliert im Schnitt 5-7 Feiertage pro Jahr." },
 fr: { q: "Les jours feries au Tessin sont-ils identiques a ceux de la Suisse italophone ?", a: "Oui : le Canton du Tessin et les vallees italophones du canton des Grisons (Mesolcina, Calanca, Bregaglia, Poschiavo) partagent le meme calendrier des fetes catholiques, avec Epiphanie, Saint-Joseph, Fete-Dieu, Assomption, Toussaint et Immaculee Conception. La difference apparait par rapport aux cantons protestants (Zurich, Berne, Bale-Ville) ou ces dates ne sont pas des jours feries officiels. Un frontalier qui passe de Lugano a Zurich perd en moyenne 5-7 jours feries par an." }
 },

 // ── Ticino school calendar 2026-2027 (DECS) — seo-pages.ts #955 follow-up ──
 "Quando inizia la scuola in Ticino nel 2026?": {
 en: { q: "When does school start in Ticino in 2026?", a: "For the 2026-2027 school year, classes in all schools of Canton Ticino start on Monday 31 August 2026, according to the official DECS calendar. Some vocational schools with specific calendars are an exception." },
 de: { q: "Wann beginnt die Schule im Tessin 2026?", a: "Für das Schuljahr 2026-2027 beginnt der Unterricht in allen Schulen des Kantons Tessin am Montag, 31. August 2026, gemäss dem offiziellen DECS-Kalender. Einige Berufsschulen mit eigenen Kalendern bilden eine Ausnahme." },
 fr: { q: "Quand commence l'école au Tessin en 2026 ?", a: "Pour l'année scolaire 2026-2027, les cours dans toutes les écoles du Canton du Tessin débutent le lundi 31 août 2026, selon le calendrier officiel du DECS. Certaines écoles professionnelles avec des calendriers spécifiques font exception." }
 },
 "Quando finisce la scuola in Ticino nel 2027?": {
 en: { q: "When does school end in Ticino in 2027?", a: "The 2026-2027 school year ends on Wednesday 16 June 2027 for all compulsory schools in Canton Ticino. The summer holidays therefore begin on Thursday 17 June 2027." },
 de: { q: "Wann endet die Schule im Tessin 2027?", a: "Das Schuljahr 2026-2027 endet am Mittwoch, 16. Juni 2027 für alle obligatorischen Schulen des Kantons Tessin. Die Sommerferien beginnen somit am Donnerstag, 17. Juni 2027." },
 fr: { q: "Quand se termine l'école au Tessin en 2027 ?", a: "L'année scolaire 2026-2027 se termine le mercredi 16 juin 2027 pour toutes les écoles obligatoires du Canton du Tessin. Les vacances d'été commencent donc le jeudi 17 juin 2027." }
 },
 "Quali sono le vacanze di Carnevale in Ticino nel 2027?": {
 en: { q: "What are the Carnival holidays in Ticino in 2027?", a: "The 2027 Carnival holidays in Ticino run from Saturday 6 February to Sunday 14 February 2027 (one week), according to the DECS calendar." },
 de: { q: "Wann sind die Fasnachtsferien im Tessin 2027?", a: "Die Fasnachtsferien 2027 im Tessin dauern von Samstag, 6. Februar bis Sonntag, 14. Februar 2027 (eine Woche), gemäss dem DECS-Kalender." },
 fr: { q: "Quelles sont les vacances de Carnaval au Tessin en 2027 ?", a: "Les vacances de Carnaval 2027 au Tessin vont du samedi 6 février au dimanche 14 février 2027 (une semaine), selon le calendrier du DECS." }
 },
 "Quando sono le vacanze di Pasqua 2027 per le scuole ticinesi?": {
 en: { q: "When are the 2027 Easter holidays for Ticino schools?", a: "The 2027 Easter holidays in Canton Ticino schools run from Friday 26 March to Sunday 4 April 2027. Easter Sunday falls on 28 March 2027." },
 de: { q: "Wann sind die Osterferien 2027 für die Tessiner Schulen?", a: "Die Osterferien 2027 in den Schulen des Kantons Tessin dauern von Freitag, 26. März bis Sonntag, 4. April 2027. Der Ostersonntag fällt auf den 28. März 2027." },
 fr: { q: "Quand ont lieu les vacances de Pâques 2027 pour les écoles tessinoises ?", a: "Les vacances de Pâques 2027 dans les écoles du Canton du Tessin vont du vendredi 26 mars au dimanche 4 avril 2027. Le dimanche de Pâques tombe le 28 mars 2027." }
 },
 "Quando sono le vacanze di Natale e autunnali in Ticino 2026-2027?": {
 en: { q: "When are the Christmas and autumn holidays in Ticino 2026-2027?", a: "The autumn holidays run from Saturday 31 October to Sunday 8 November 2026; the Christmas holidays from Thursday 24 December 2026 to Wednesday 6 January 2027. All dates are set by the DECS of Canton Ticino." },
 de: { q: "Wann sind die Weihnachts- und Herbstferien im Tessin 2026-2027?", a: "Die Herbstferien dauern von Samstag, 31. Oktober bis Sonntag, 8. November 2026; die Weihnachtsferien von Donnerstag, 24. Dezember 2026 bis Mittwoch, 6. Januar 2027. Alle Daten werden vom DECS des Kantons Tessin festgelegt." },
 fr: { q: "Quand ont lieu les vacances de Noël et d'automne au Tessin 2026-2027 ?", a: "Les vacances d'automne vont du samedi 31 octobre au dimanche 8 novembre 2026 ; les vacances de Noël du jeudi 24 décembre 2026 au mercredi 6 janvier 2027. Toutes les dates sont fixées par le DECS du Canton du Tessin." }
 },
 "Il calendario scolastico ticinese è uguale a quello italiano?": {
 en: { q: "Is the Ticino school calendar the same as the Italian one?", a: "No. Italian border schools (Como, Varese, Valtellina) follow a different calendar, with a mid-September start, longer summer holidays and no autumn break. Cross-border parents with children in both systems must cross-reference the dates to find common holiday windows." },
 de: { q: "Ist der Tessiner Schulkalender gleich wie der italienische?", a: "Nein. Die italienischen Grenzschulen (Como, Varese, Valtellina) folgen einem anderen Kalender, mit Beginn Mitte September, längeren Sommerferien und ohne Herbstferien. Grenzgänger-Eltern mit Kindern in beiden Systemen müssen die Daten abgleichen, um gemeinsame Ferienfenster zu finden." },
 fr: { q: "Le calendrier scolaire tessinois est-il identique à l'italien ?", a: "Non. Les écoles italiennes frontalières (Côme, Varèse, Valteline) suivent un calendrier différent, avec une rentrée à la mi-septembre, des vacances d'été plus longues et aucune vacance d'automne. Les parents frontaliers ayant des enfants dans les deux systèmes doivent croiser les dates pour trouver des fenêtres de vacances communes." }
 },

 // ── Frontaliere Readiness Wizard ──
 "Come faccio a sapere se sono pronto a diventare frontaliere?": {
 en: { q: "How do I know if I'm ready to become a cross-border worker?", a: "Answer the wizard's 7 questions about border distance, G permit, job situation, family, sector, language and financial preparation: you'll get a readiness score and a personalized plan with the concrete steps to follow." },
 de: { q: "Woher weiss ich, ob ich bereit bin, Grenzgänger zu werden?", a: "Beantworte die 7 Fragen des Wizards zu Grenznähe, G-Bewilligung, Jobsituation, Familie, Branche, Sprache und finanzieller Vorbereitung: Du erhältst einen Bereitschafts-Score und einen personalisierten Plan mit den konkreten nächsten Schritten." },
 fr: { q: "Comment savoir si je suis prêt à devenir frontalier ?", a: "Répondez aux 7 questions du wizard sur la distance de la frontière, le permis G, la situation professionnelle, la famille, le secteur, la langue et la préparation financière : vous obtiendrez un score de préparation et un plan personnalisé avec les étapes concrètes à suivre." }
 },
 "Quali sono i primi passi per lavorare in Svizzera come frontaliere?": {
 en: { q: "What are the first steps to work in Switzerland as a cross-border worker?", a: "Typically: check your permit type (B or G), find a job in Switzerland, calculate your net salary, open a CHF account, choose health insurance and plan your commute through the border crossings. The wizard orders these steps based on your situation." },
 de: { q: "Was sind die ersten Schritte, um als Grenzgänger in der Schweiz zu arbeiten?", a: "In der Regel: Bewilligungstyp prüfen (B oder G), einen Job in der Schweiz finden, den Nettolohn berechnen, ein CHF-Konto eröffnen, die Krankenversicherung wählen und den Arbeitsweg über die Grenzübergänge planen. Der Wizard ordnet diese Schritte nach deiner Situation." },
 fr: { q: "Quelles sont les premières étapes pour travailler en Suisse comme frontalier ?", a: "En général : vérifier le type de permis (B ou G), trouver un emploi en Suisse, calculer le salaire net, ouvrir un compte en CHF, choisir l'assurance maladie et organiser le trajet par les postes-frontière. Le wizard ordonne ces étapes selon votre situation." }
 },

 // ── Weekly tax quiz (quiz-fiscale) ──
 "Come funziona il quiz fiscale settimanale per frontalieri?": {
 en: { q: "How does the weekly tax quiz for cross-border workers work?", a: "Each week the quiz selects 5 multiple-choice questions from a pool covering Swiss and Italian taxation, AVS/LPP contributions, LAMal health insurance and G/B work permits. Every answer includes a detailed explanation of the underlying mechanism, so the quiz works both as an assessment and a learning tool." },
 de: { q: "Wie funktioniert das wöchentliche Steuerquiz für Grenzgänger?", a: "Jede Woche wählt das Quiz 5 Multiple-Choice-Fragen aus einem Pool zu Schweizer und italienischer Besteuerung, AHV/BVG-Beiträgen, KVG-Krankenversicherung und Arbeitsbewilligungen G/B. Jede Antwort enthält eine detaillierte Erklärung des Mechanismus, sodass das Quiz sowohl als Test als auch als Lernwerkzeug dient." },
 fr: { q: "Comment fonctionne le quiz fiscal hebdomadaire pour frontaliers ?", a: "Chaque semaine, le quiz sélectionne 5 questions à choix multiple parmi un ensemble portant sur la fiscalité suisse et italienne, les cotisations AVS/LPP, l'assurance maladie LAMal et les permis de travail G/B. Chaque réponse inclut une explication détaillée du mécanisme, si bien que le quiz sert à la fois d'évaluation et d'outil d'apprentissage." }
 },
 "Qual è l'aliquota AVS a carico del lavoratore frontaliere in Svizzera?": {
 en: { q: "What is the AVS/AHV contribution rate charged to a cross-border worker in Switzerland?", a: "The AVS (1st pillar) rate charged to the employee is 5.3% of gross salary. The employer pays an identical amount, for a combined contribution of 10.6%." },
 de: { q: "Wie hoch ist der AHV-Beitragssatz zulasten des Grenzgängers in der Schweiz?", a: "Der AHV-Beitragssatz (1. Säule) zulasten des Arbeitnehmers beträgt 5,3% des Bruttolohns. Der Arbeitgeber zahlt denselben Betrag, insgesamt also 10,6%." },
 fr: { q: "Quel est le taux de cotisation AVS à la charge du frontalier en Suisse ?", a: "Le taux AVS (1er pilier) à la charge du salarié est de 5,3% du salaire brut. L'employeur verse un montant identique, pour une cotisation totale de 10,6%." }
 },
 "Quanti pilastri ha il sistema previdenziale svizzero e cosa coprono?": {
 en: { q: "How many pillars does the Swiss pension system have and what do they cover?", a: "The Swiss system rests on 3 pillars: AVS/AI (1st pillar, mandatory state pension), LPP (2nd pillar, occupational pension through the employer) and voluntary individual savings (3rd pillar, 3a/3b)." },
 de: { q: "Wie viele Säulen hat das Schweizer Vorsorgesystem und was decken sie ab?", a: "Das Schweizer System basiert auf 3 Säulen: AHV/IV (1. Säule, obligatorische staatliche Vorsorge), BVG (2. Säule, berufliche Vorsorge über den Arbeitgeber) und freiwilliges individuelles Sparen (3. Säule, 3a/3b)." },
 fr: { q: "Combien de piliers compte le système de prévoyance suisse et que couvrent-ils ?", a: "Le système suisse repose sur 3 piliers : AVS/AI (1er pilier, prévoyance étatique obligatoire), LPP (2e pilier, prévoyance professionnelle via l'employeur) et épargne individuelle volontaire (3e pilier, 3a/3b)." }
 },
 "I frontalieri possono scegliere tra LAMal svizzera e SSN italiano?": {
 en: { q: "Can cross-border workers choose between Swiss LAMal and the Italian national health service?", a: "Yes: within 3 months of starting employment, cross-border workers exercise the right of option between Swiss LAMal health insurance and the Italian national health service (SSN). The choice cannot be changed freely; the canton of employment must assess whether a new right of option applies." },
 de: { q: "Können Grenzgänger zwischen der Schweizer KVG und dem italienischen Gesundheitsdienst wählen?", a: "Ja: Innerhalb von 3 Monaten nach Arbeitsbeginn üben Grenzgänger das Optionsrecht zwischen der Schweizer Krankenversicherung KVG und dem italienischen staatlichen Gesundheitsdienst (SSN) aus. Die Wahl kann nicht frei geändert werden; der Arbeitskanton prüft einen erneuten Anspruch auf das Optionsrecht." },
 fr: { q: "Les frontaliers peuvent-ils choisir entre la LAMal suisse et le service de santé national italien ?", a: "Oui : dans les 3 mois suivant le début de l'emploi, les frontaliers exercent le droit d'option entre l'assurance maladie suisse LAMal et le service de santé national italien (SSN). Le choix ne peut pas être modifié librement ; le canton de travail vérifie les conditions d’un nouvel exercice." }
 },
 "Ogni quanto va rinnovato il permesso G per frontalieri?": {
 en: { q: "How often must the G permit for cross-border workers be renewed?", a: "A G permit for EU/EFTA nationals normally lasts five years for an indefinite contract or one exceeding a year; shorter contracts have a corresponding validity. Check the expiry date and follow the canton’s renewal procedure: continuing employment does not remove the need for the required formalities. https://www.sem.admin.ch/sem/it/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html" },
 de: { q: "Wie oft muss die G-Bewilligung für Grenzgänger erneuert werden?", a: "Die G-Bewilligung für EU/EFTA-Angehörige gilt bei unbefristeten oder überjährigen Verträgen normalerweise fünf Jahre; bei kürzeren Verträgen entspricht die Gültigkeit der Vertragsdauer. Beachten Sie das Ablaufdatum und das kantonale Verlängerungsverfahren: Ein fortbestehendes Arbeitsverhältnis ersetzt die erforderlichen Formalitäten nicht. https://www.sem.admin.ch/sem/it/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html" },
 fr: { q: "À quelle fréquence le permis G pour frontaliers doit-il être renouvelé ?", a: "Le permis G UE/AELE est normalement valable cinq ans pour un contrat indéterminé ou supérieur à un an ; les contrats plus courts ont une validité correspondante. Vérifiez l’échéance et suivez la procédure cantonale de renouvellement : la poursuite de l’emploi ne dispense pas des formalités requises. https://www.sem.admin.ch/sem/it/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html" }
 },

  "Qual è la differenza tra imposta alla fonte e IRPEF per un frontaliere?": {
    "en": {
      "q": "What is the difference between withholding tax and IRPEF for a cross-border worker?",
      "a": "Swiss withholding tax is deducted from salary by the employer; IRPEF is Italian income tax. New tax cross-border workers are subject to both, with an Italian credit for Swiss tax. Eligible old workers instead have salary covered by Article 9 taxed exclusively in Switzerland. The latest contract date alone does not distinguish the regimes. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
    },
    "de": {
      "q": "Was unterscheidet Quellensteuer und IRPEF bei Grenzgängern?",
      "a": "Die Schweizer Quellensteuer wird vom Arbeitgeber vom Lohn einbehalten; IRPEF ist die italienische Einkommensteuer. Neue steuerliche Grenzgänger unterliegen beiden, mit italienischer Anrechnung der Schweizer Steuer. Bei qualifizierten alten Grenzgängern wird der Lohn nach Artikel 9 dagegen ausschliesslich in der Schweiz besteuert. Das letzte Vertragsdatum allein unterscheidet die Regime nicht. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
    },
    "fr": {
      "q": "Quelle est la différence entre impôt à la source et IRPEF pour un frontalier ?",
      "a": "L’impôt suisse à la source est retenu sur le salaire par l’employeur ; l’IRPEF est l’impôt italien sur le revenu. Les nouveaux frontaliers fiscaux sont soumis aux deux, avec crédit italien pour l’impôt suisse. Pour les anciens admissibles, le salaire couvert par l’article 9 est imposé exclusivement en Suisse. La date du dernier contrat ne suffit pas à distinguer les régimes. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
    }
  },
  "Le tabelle dell'imposta alla fonte cambiano ogni anno?": {
    "en": {
      "q": "Do withholding tax tables change every year?",
      "a": "Use the cantonal tariff applicable to your circumstances for each tax year. New tax cross-border workers pay 80% of ordinary withholding tax: a reduction of 20%, not 80%. Check that the payslip uses the tariff appropriate to your status and family circumstances. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
    },
    "de": {
      "q": "Ändern sich die Quellensteuertabellen jedes Jahr?",
      "a": "Für jedes Steuerjahr ist der zur eigenen Situation passende kantonale Tarif massgeblich. Neue steuerliche Grenzgänger zahlen 80% der ordentlichen Quellensteuer: eine Reduktion um 20%, nicht um 80%. Auf der Lohnabrechnung den Tarif für Status und Familienverhältnisse prüfen. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
    },
    "fr": {
      "q": "Les barèmes de l’impôt à la source changent-ils chaque année ?",
      "a": "Pour chaque année fiscale, consultez le barème cantonal applicable à votre situation. Les nouveaux frontaliers fiscaux paient 80% de l’impôt à la source ordinaire : une réduction de 20%, non de 80%. Vérifiez le barème de la fiche de salaire selon le statut et la situation familiale. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
    }
  },
  "Cos'è l'IRPEF e perché riguarda anche i frontalieri?": {
    "en": {
      "q": "What is IRPEF and why does it also concern cross-border workers?",
      "a": "IRPEF is Italian personal income tax. It applies to Swiss salary earned by new tax cross-border workers because the agreement provides for Italian taxation with credit for Swiss tax. Salary covered by Article 9 for eligible old workers remains subject only to Swiss taxation. A hire date alone does not establish the regime. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
    },
    "de": {
      "q": "Was ist IRPEF und warum betrifft sie auch Grenzgänger?",
      "a": "IRPEF ist die italienische Einkommensteuer. Sie betrifft den Schweizer Lohn neuer steuerlicher Grenzgänger, weil das Abkommen italienische Besteuerung mit Anrechnung der Schweizer Steuer vorsieht. Der Lohn qualifizierter alter Grenzgänger nach Artikel 9 bleibt allein in der Schweiz steuerpflichtig. Ein Einstellungsdatum allein bestimmt das Regime nicht. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
    },
    "fr": {
      "q": "Qu’est-ce que l’IRPEF et pourquoi concerne-t-il aussi les frontaliers ?",
      "a": "L’IRPEF est l’impôt italien sur le revenu des personnes physiques. Il concerne le salaire suisse des nouveaux frontaliers fiscaux, car l’accord prévoit une imposition italienne avec crédit pour l’impôt suisse. Le salaire des anciens admissibles selon l’article 9 reste imposé seulement en Suisse. Une date d’embauche ne suffit pas à déterminer le régime. https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"
    }
  }

};

/**
 * Look up a FAQ translation by Italian question text.
 * Returns undefined if no translation exists for the given question.
 */
export function getFaqTranslation(
 italianQuestion: string,
 locale: 'en' | 'de' | 'fr'
): FaqTranslation | undefined {
 const entry = FAQ_TRANSLATIONS[italianQuestion];
 return entry?.[locale];
}

/**
 * Translate an entire FAQPage structured data object for a given locale.
 * Mutates the clone in place. If no translation is found for a Q&A pair, it stays in Italian.
 */
export function translateFaqPage(
 faqPage: Record<string, any>,
 locale: 'en' | 'de' | 'fr'
): void {
 if (!Array.isArray(faqPage.mainEntity)) return;
 for (const item of faqPage.mainEntity) {
 if (item['@type'] !== 'Question' || !item.name) continue;
 const translation = getFaqTranslation(item.name, locale);
 if (translation) {
 item.name = translation.q;
 if (item.acceptedAnswer?.text) {
 item.acceptedAnswer.text = translation.a;
 }
 }
 }
}
