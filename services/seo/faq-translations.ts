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
      a: "A cross-border worker (frontaliere) lives in one country (Italy) and works in another (Switzerland), returning home at least weekly. Requirements: EU citizenship, residence within 20 km of the border, and a Swiss employment contract. You obtain a G permit."
    },
    de: {
      q: "Was ist ein Grenzgänger und wer kann einer werden?",
      a: "Ein Grenzgänger wohnt in einem Land (Italien) und arbeitet in einem anderen (Schweiz) und kehrt mindestens wöchentlich nach Hause zurück. Voraussetzungen: EU-Staatsbürgerschaft, Wohnsitz innerhalb von 20 km zur Grenze und ein Schweizer Arbeitsvertrag. Man erhält eine G-Bewilligung."
    },
    fr: {
      q: "Qu'est-ce qu'un frontalier et qui peut le devenir ?",
      a: "Un frontalier est un travailleur qui réside dans un pays (Italie) et travaille dans un autre (Suisse), en rentrant chez lui au moins une fois par semaine. Conditions : citoyenneté UE, résidence dans un rayon de 20 km de la frontière et un contrat de travail suisse. On obtient un permis G."
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
      a: "From 2024, new cross-border workers (hired after 17 July 2023) pay withholding tax in Switzerland up to 80% of the total due. The remaining income must also be declared in Italy, with a €10,000 exemption. Old cross-border workers continue under the previous regime."
    },
    de: {
      q: "Wie funktioniert die Besteuerung der Grenzgänger im Jahr 2026?",
      a: "Ab 2024 zahlen neue Grenzgänger (eingestellt nach dem 17. Juli 2023) Quellensteuer in der Schweiz bis zu 80 % der Gesamtschuld. Das restliche Einkommen muss auch in Italien deklariert werden, mit einem Freibetrag von 10.000 €. Altgrenzgänger unterliegen weiterhin dem bisherigen Regime."
    },
    fr: {
      q: "Comment fonctionne l'imposition des frontaliers en 2026 ?",
      a: "À partir de 2024, les nouveaux frontaliers (embauchés après le 17 juillet 2023) paient l'impôt à la source en Suisse jusqu'à 80 % du total dû. Le revenu restant doit aussi être déclaré en Italie, avec une franchise de 10 000 €. Les anciens frontaliers poursuivent sous l'ancien régime."
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
      a: "IRPEF is calculated on the Swiss income converted to EUR minus the €10,000 exemption, using the progressive brackets (23%, 35%, 43%). A tax credit is applied for the Swiss withholding tax paid to avoid double taxation. The regional and municipal surtaxes are also due."
    },
    de: {
      q: "Muss ein Grenzgänger in Italien IRPEF zahlen?",
      a: "Die IRPEF wird auf das in EUR umgerechnete Schweizer Einkommen abzüglich des Freibetrags von 10.000 € berechnet, unter Anwendung der Progressionsstufen (23 %, 35 %, 43 %). Für die in der Schweiz gezahlte Quellensteuer wird eine Steuergutschrift gewährt, um Doppelbesteuerung zu vermeiden. Regionale und kommunale Zuschläge fallen ebenfalls an."
    },
    fr: {
      q: "Le frontalier doit-il payer l'IRPEF en Italie ?",
      a: "L'IRPEF est calculée sur le revenu suisse converti en EUR moins la franchise de 10 000 €, selon les tranches progressives (23 %, 35 %, 43 %). Un crédit d'impôt est accordé pour l'impôt à la source suisse payé afin d'éviter la double imposition. Les surtaxes régionales et communales s'appliquent également."
    }
  },

  // ── Q9: Pillar 3a overview ──
  "Cos'è il terzo pilastro 3a e conviene al frontaliere?": {
    en: {
      q: "What is pillar 3a and is it beneficial for a cross-border worker?",
      a: "Pillar 3a is the Swiss voluntary private pension scheme. Cross-border workers with a G permit and LPP affiliation can contribute up to CHF 7,258 per year (2026) and deduct it from withholding tax via the TDR procedure. Contributions grow tax-free until withdrawal at retirement."
    },
    de: {
      q: "Was ist die Säule 3a und lohnt sie sich für Grenzgänger?",
      a: "Die Säule 3a ist die freiwillige private Vorsorge in der Schweiz. Grenzgänger mit G-Bewilligung und BVG-Anschluss können bis zu CHF 7.258 pro Jahr (2026) einzahlen und über das TDR-Verfahren von der Quellensteuer abziehen. Die Beiträge wachsen steuerfrei bis zum Bezug bei Pensionierung."
    },
    fr: {
      q: "Qu'est-ce que le pilier 3a et est-il avantageux pour un frontalier ?",
      a: "Le pilier 3a est le régime de prévoyance privée volontaire suisse. Les frontaliers avec un permis G et une affiliation LPP peuvent cotiser jusqu'à CHF 7 258 par an (2026) et déduire cette somme de l'impôt à la source via la procédure TDR. Les cotisations croissent en franchise d'impôt jusqu'au retrait à la retraite."
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
      a: "For a G permit you need: an employment contract with a Swiss employer, residence within 20 km of the border (or in concordat municipalities), EU/EFTA citizenship, and weekly return to your country of residence. The application is submitted by the employer to the Cantonal Migration Office. According to Prof. Roberto Bentivoglio, Professor of Labor Law at USI: 'The 20 km requirement is measured as the crow flies from the border, not by road distance'."
    },
    de: {
      q: "Welche Voraussetzungen gelten für die Grenzgängerbewilligung G?",
      a: "Für eine G-Bewilligung benötigen Sie: einen Arbeitsvertrag mit einem Schweizer Arbeitgeber, Wohnsitz innerhalb von 20 km zur Grenze (oder in Konkordatsgemeinden), EU/EFTA-Staatsbürgerschaft und wöchentliche Rückkehr in den Wohnsitzstaat. Der Antrag wird vom Arbeitgeber beim kantonalen Migrationsamt eingereicht. Wie Prof. Roberto Bentivoglio, Professor für Arbeitsrecht an der USI, erklärt: «Die 20-km-Anforderung wird in Luftlinie von der Grenze gemessen, nicht als Strassenentfernung»."
    },
    fr: {
      q: "Quelles sont les conditions pour obtenir un permis G frontalier ?",
      a: "Pour un permis G, il faut : un contrat de travail avec un employeur suisse, résidence dans un rayon de 20 km de la frontière (ou dans les communes concordataires), citoyenneté UE/AELE et retour hebdomadaire au pays de résidence. La demande est déposée par l'employeur auprès de l'Office cantonal de la migration. Comme l'explique le Prof. Roberto Bentivoglio, professeur de droit du travail à l'USI: «L'exigence des 20 km se mesure à vol d'oiseau depuis la frontière, pas en distance routière»."
    }
  },

  // ── Q21: Permit G duration ──
  "Quanto dura il permesso G e come si rinnova?": {
    en: {
      q: "How long does the G permit last and how is it renewed?",
      a: "The G permit lasts 5 years if the contract is permanent, or the duration of the contract if fixed-term. Renewal is automatic upon the employer's request, provided the employment relationship is still in place."
    },
    de: {
      q: "Wie lange gilt die G-Bewilligung und wie wird sie verlängert?",
      a: "Die G-Bewilligung gilt 5 Jahre bei unbefristetem Vertrag oder für die Vertragsdauer bei befristeten Verträgen. Die Verlängerung erfolgt automatisch auf Antrag des Arbeitgebers, sofern das Arbeitsverhältnis noch besteht."
    },
    fr: {
      q: "Quelle est la durée du permis G et comment le renouveler ?",
      a: "Le permis G a une durée de 5 ans pour un contrat à durée indéterminée, ou égale à la durée du contrat s'il est à durée déterminée. Le renouvellement est automatique sur demande de l'employeur, à condition que la relation de travail soit toujours en cours."
    }
  },

  // ── Q22: G vs B permit ──
  "Qual è la differenza tra permesso G e permesso B?": {
    en: {
      q: "What is the difference between the G permit and the B permit?",
      a: "The G permit (cross-border) requires residence in Italy with weekly return; you are taxed at source in Switzerland and declare in Italy. The B permit (residence) requires living in Switzerland; you are taxed through ordinary Swiss declaration and do not pay IRPEF in Italy. According to Prof. Roberto Bentivoglio, Professor of Labor Law at USI: 'The choice of permit has fiscal, social security, and family implications that should be evaluated as a whole'."
    },
    de: {
      q: "Was ist der Unterschied zwischen G- und B-Bewilligung?",
      a: "Die G-Bewilligung (Grenzgänger) erfordert Wohnsitz in Italien mit wöchentlicher Rückkehr; man wird in der Schweiz quellenbesteuert und deklariert in Italien. Die B-Bewilligung (Aufenthalt) erfordert Wohnsitz in der Schweiz; man wird ordentlich besteuert und zahlt keine IRPEF in Italien. Wie Prof. Roberto Bentivoglio, Professor für Arbeitsrecht an der USI, erklärt: «Die Wahl der Bewilligung hat steuerliche, sozialversicherungsrechtliche und familiäre Auswirkungen, die gesamthaft bewertet werden sollten»."
    },
    fr: {
      q: "Quelle est la différence entre le permis G et le permis B ?",
      a: "Le permis G (frontalier) exige la résidence en Italie avec retour hebdomadaire ; on est imposé à la source en Suisse et on déclare en Italie. Le permis B (séjour) exige la résidence en Suisse ; on est imposé par déclaration ordinaire suisse et on ne paie pas l'IRPEF en Italie. Comme l'explique le Prof. Roberto Bentivoglio, professeur de droit du travail à l'USI: «Le choix du permis a des implications fiscales, de prévoyance sociale et familiales qui doivent être évaluées dans leur ensemble»."
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
      a: "The G permit costs approximately CHF 65–85 for issuance (varies by canton). Renewal costs about CHF 40–55. Generally the employer advances the costs and deducts them from the payslip."
    },
    de: {
      q: "Wie viel kostet die Grenzgängerbewilligung G?",
      a: "Die G-Bewilligung kostet für die Ausstellung ca. CHF 65–85 (je nach Kanton). Die Verlängerung kostet ca. CHF 40–55. In der Regel legt der Arbeitgeber die Kosten vor und zieht sie vom Lohn ab."
    },
    fr: {
      q: "Combien coûte le permis G frontalier ?",
      a: "Le permis G coûte environ CHF 65 à 85 pour la délivrance (varie selon le canton). Le renouvellement coûte environ CHF 40 à 55. Généralement, l'employeur avance les frais et les déduit du bulletin de salaire."
    }
  },

  // ── Q25: Pillar 3a 2026 max ──
  "Qual è il limite massimo di versamento nel pilastro 3a nel 2026?": {
    en: {
      q: "What is the maximum pillar 3a contribution in 2026?",
      a: "For employees affiliated to a LPP pension fund, the limit is CHF 7,258 per year (2026). For those without a 2nd pillar, the limit rises to 20% of net income, up to a maximum of CHF 36,288. According to Andrea Fiorini, pension planning consultant: 'Contributing the maximum allowed every year is one of the most effective tax optimization strategies for cross-border workers'."
    },
    de: {
      q: "Wie hoch ist der maximale Einzahlungsbetrag in die Säule 3a im Jahr 2026?",
      a: "Für Arbeitnehmer mit BVG-Anschluss beträgt das Limit CHF 7.258 pro Jahr (2026). Für Personen ohne 2. Säule steigt das Limit auf 20 % des Nettoeinkommens, maximal CHF 36.288. Wie Andrea Fiorini, Vorsorgeberater, erklärt: «Den maximal zulässigen Betrag jedes Jahr einzuzahlen ist eine der effektivsten Strategien zur Steueroptimierung für Grenzgänger»."
    },
    fr: {
      q: "Quel est le montant maximal de versement au pilier 3a en 2026 ?",
      a: "Pour les salariés affiliés à une caisse de pension LPP, la limite est de CHF 7 258 par an (2026). Pour ceux qui n'ont pas de 2e pilier, la limite monte à 20 % du revenu net, jusqu'à un maximum de CHF 36 288. Comme l'explique Andrea Fiorini, conseiller en prévoyance: «Verser le montant maximum autorisé chaque année est l'une des stratégies d'optimisation fiscale les plus efficaces pour les frontaliers»."
    }
  },

  // ── Q26: G permit 3a eligibility ──
  "Un frontaliere con permesso G può aprire un pilastro 3a?": {
    en: {
      q: "Can a cross-border worker with a G permit open a pillar 3a account?",
      a: "Yes, cross-border workers with a G permit who work in Switzerland and pay withholding tax can open a 3a account and deduct contributions from their withholding tax through the TDR rectification."
    },
    de: {
      q: "Kann ein Grenzgänger mit G-Bewilligung ein Säule-3a-Konto eröffnen?",
      a: "Ja, Grenzgänger mit G-Bewilligung, die in der Schweiz arbeiten und quellenbesteuert werden, können ein 3a-Konto eröffnen und die Beiträge über die TDR-Berichtigung von der Quellensteuer abziehen."
    },
    fr: {
      q: "Un frontalier avec un permis G peut-il ouvrir un pilier 3a ?",
      a: "Oui, les frontaliers titulaires d'un permis G travaillant en Suisse et payant l'impôt à la source peuvent ouvrir un compte 3a et déduire les cotisations de l'impôt à la source via la rectification TDR."
    }
  },

  // ── Q27: 3a vs 3b ──
  "Qual è la differenza tra pilastro 3a e 3b?": {
    en: {
      q: "What is the difference between pillar 3a and 3b?",
      a: "Pillar 3a is tied (withdrawal only 5 years before retirement, home purchase, or leaving Switzerland) but tax-deductible. Pillar 3b is free (no withdrawal restrictions) but offers no direct tax benefits. Pillar 3a is better for immediate tax savings."
    },
    de: {
      q: "Was ist der Unterschied zwischen Säule 3a und 3b?",
      a: "Die Säule 3a ist gebunden (Bezug nur 5 Jahre vor der Pensionierung, Hauskauf oder Wegzug aus der Schweiz), aber steuerlich absetzbar. Die Säule 3b ist frei (keine Bezugsbeschränkungen), bietet aber keine direkten Steuervorteile. Die Säule 3a eignet sich besser für sofortige Steuerersparnisse."
    },
    fr: {
      q: "Quelle est la différence entre le pilier 3a et le 3b ?",
      a: "Le pilier 3a est lié (retrait uniquement 5 ans avant la retraite, achat immobilier ou départ de Suisse) mais déductible fiscalement. Le pilier 3b est libre (aucune restriction de retrait) mais sans avantages fiscaux directs. Le pilier 3a est préférable pour l'économie fiscale immédiate."
    }
  },

  // ── Q28: 3a tax savings ──
  "Quanto si risparmia di tasse con il pilastro 3a?": {
    en: {
      q: "How much tax can you save with pillar 3a?",
      a: "In Canton Ticino, a full contribution of CHF 7,258 reduces withholding tax by approximately CHF 1,000–2,200 depending on the marginal rate. For a cross-border worker with a 12–15% rate, the saving is approximately CHF 870–1,090."
    },
    de: {
      q: "Wie viel Steuern spart man mit der Säule 3a?",
      a: "Im Kanton Tessin reduziert eine volle Einzahlung von CHF 7.258 die Quellensteuer um ca. CHF 1.000–2.200, je nach Grenzsteuersatz. Bei einem Grenzgänger mit einem Steuersatz von 12–15 % beträgt die Ersparnis ca. CHF 870–1.090."
    },
    fr: {
      q: "Combien économise-t-on d'impôts avec le pilier 3a ?",
      a: "Au Tessin, un versement complet de CHF 7 258 réduit l'impôt à la source d'environ CHF 1 000 à 2 200 selon le taux marginal. Pour un frontalier avec un taux de 12 à 15 %, l'économie est d'environ CHF 870 à 1 090."
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
      a: "New cross-border workers (hired from 17/07/2023) pay withholding tax in Switzerland (80%) AND IRPEF in Italy (with €10,000 exemption and tax credit for Swiss taxes). Old cross-border workers pay only in Switzerland until the transitional period expires. According to Marco Bernasconi, cross-border tax attorney: 'The tax credit is the key mechanism to prevent effective double taxation on new cross-border workers'."
    },
    de: {
      q: "Zahlt ein Grenzgänger mit G-Bewilligung Steuern in Italien und der Schweiz?",
      a: "Neue Grenzgänger (ab 17.07.2023 eingestellt) zahlen Quellensteuer in der Schweiz (80 %) UND IRPEF in Italien (mit 10.000 € Freibetrag und Steuergutschrift für Schweizer Steuern). Altgrenzgänger zahlen nur in der Schweiz bis zum Ablauf der Übergangszeit. Wie RA Marco Bernasconi, Steueranwalt für Grenzgänger, erklärt: «Die Steuergutschrift ist der Schlüsselmechanismus, um eine effektive Doppelbesteuerung der neuen Grenzgänger zu verhindern»."
    },
    fr: {
      q: "Un frontalier avec un permis G paie-t-il des impôts en Italie et en Suisse ?",
      a: "Les nouveaux frontaliers (embauchés à partir du 17/07/2023) paient l'impôt à la source en Suisse (80 %) ET l'IRPEF en Italie (avec une franchise de 10 000 € et un crédit d'impôt pour les impôts suisses). Les anciens frontaliers paient uniquement en Suisse jusqu'à l'expiration de la période transitoire. Comme l'explique Me Marco Bernasconi, avocat fiscaliste transfrontalier: «Le crédit d'impôt est le mécanisme clé pour éviter la double imposition effective des nouveaux frontaliers»."
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
      a: "It depends on the personal situation. LAMal costs around CHF 400–600/month but covers care in Switzerland without long waits. The Italian SSN is free (or nearly so) but does not cover emergency care in Switzerland. The right of option must be exercised within 3 months of starting work and the choice is irrevocable."
    },
    de: {
      q: "Ist es besser, die Schweizer KVG oder den italienischen SSN als Krankenversicherung zu wählen?",
      a: "Das hängt von der persönlichen Situation ab. Die KVG kostet ca. CHF 400–600/Monat, deckt aber Behandlungen in der Schweiz ohne lange Wartezeiten. Der italienische SSN ist kostenlos (oder fast), deckt aber keine Notfallbehandlungen in der Schweiz. Das Optionsrecht muss innerhalb von 3 Monaten nach Arbeitsbeginn ausgeübt werden und die Wahl ist unwiderruflich."
    },
    fr: {
      q: "Vaut-il mieux choisir la LAMal suisse ou le SSN italien comme assurance maladie ?",
      a: "Cela dépend de la situation personnelle. La LAMal coûte environ CHF 400 à 600/mois mais couvre les soins en Suisse sans longues attentes. Le SSN italien est gratuit (ou presque) mais ne couvre pas les soins urgents en Suisse. Le droit d'option doit être exercé dans les 3 mois suivant le début de l'emploi et le choix est irrévocable."
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
      a: "Old cross-border workers (before July 2023) pay only in Switzerland and do not declare in Italy, so they don't use the tax credit. New cross-border workers pay 80% of taxes in Switzerland and declare in Italy with a €10,000 exemption, using the tax credit for Swiss tax paid."
    },
    de: {
      q: "Was ist der Unterschied bei der Steuergutschrift zwischen Alt- und Neugrenzgängern?",
      a: "Altgrenzgänger (vor Juli 2023) zahlen nur in der Schweiz und deklarieren nicht in Italien, nutzen also keine Steuergutschrift. Neugrenzgänger zahlen 80 % der Steuern in der Schweiz und deklarieren in Italien mit einem Freibetrag von 10.000 €, wobei sie die Steuergutschrift für die Schweizer Steuern nutzen."
    },
    fr: {
      q: "Quelle est la différence de crédit d'impôt entre anciens et nouveaux frontaliers ?",
      a: "Les anciens frontaliers (avant juillet 2023) ne paient qu'en Suisse et ne déclarent pas en Italie, ils n'utilisent donc pas le crédit d'impôt. Les nouveaux frontaliers paient 80 % des impôts en Suisse et déclarent en Italie avec une franchise de 10 000 €, en utilisant le crédit d'impôt pour l'impôt suisse payé."
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
      a: "From 2024, new cross-border workers (hired after 17 July 2023) pay withholding tax in Switzerland up to 80% of the total, and must also declare income in Italy with a €10,000 exemption. Old cross-border workers (pre-2024) continue under the previous regime until 2033. According to Marco Bernasconi, cross-border tax attorney: 'The transitional period until 2033 ensures that no existing cross-border worker faces a sudden tax increase'."
    },
    de: {
      q: "Wie funktioniert das neue Grenzgänger-Steuerabkommen 2026?",
      a: "Ab 2024 zahlen neue Grenzgänger (eingestellt nach dem 17. Juli 2023) Quellensteuer in der Schweiz bis zu 80 % der Gesamtschuld und müssen das Einkommen auch in Italien deklarieren, mit einem Freibetrag von 10.000 €. Altgrenzgänger (vor 2024) unterliegen bis 2033 dem bisherigen Regime. Wie RA Marco Bernasconi, Steueranwalt für Grenzgänger, erklärt: «Die Übergangszeit bis 2033 stellt sicher, dass kein bestehender Grenzgänger eine plötzliche Steuererhöhung erleidet»."
    },
    fr: {
      q: "Comment fonctionne le nouvel accord fiscal frontaliers 2026 ?",
      a: "À partir de 2024, les nouveaux frontaliers (embauchés après le 17 juillet 2023) paient l'impôt à la source en Suisse jusqu'à 80 % du total et doivent aussi déclarer leur revenu en Italie avec une franchise de 10 000 €. Les anciens frontaliers (avant 2024) restent sous l'ancien régime jusqu'en 2033. Comme l'explique Me Marco Bernasconi, avocat fiscaliste transfrontalier: «La période transitoire jusqu'en 2033 garantit qu'aucun ancien frontalier ne subisse une augmentation fiscale brutale»."
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
      a: "LAMal is the mandatory Swiss health insurance. Cross-border workers can choose between LAMal (Swiss coverage) and the Italian SSN. With LAMal you access the Swiss healthcare system with deductibles and insurance models (basic, HMO, telmed). The choice must be made within 3 months of starting work. According to Laura Mantovani, LAMal insurance broker: 'For those with family in Italy, the SSN is often more cost-effective, while LAMal offers faster access to care in Switzerland'."
    },
    de: {
      q: "Was ist die KVG und wie funktioniert sie für Grenzgänger?",
      a: "Die KVG (LAMal) ist die obligatorische Schweizer Krankenversicherung. Grenzgänger können zwischen KVG (Schweizer Deckung) und dem italienischen SSN wählen. Mit der KVG hat man Zugang zum Schweizer Gesundheitssystem mit Franchisen und Versicherungsmodellen (Standard, HMO, Telmed). Die Wahl muss innerhalb von 3 Monaten nach Arbeitsbeginn getroffen werden. Wie Laura Mantovani, KVG-Versicherungsmaklerin, erklärt: «Für Familien in Italien ist der SSN oft günstiger, während die KVG einen schnelleren Zugang zur Versorgung in der Schweiz bietet»."
    },
    fr: {
      q: "Qu'est-ce que la LAMal et comment fonctionne-t-elle pour les frontaliers ?",
      a: "La LAMal est l'assurance maladie obligatoire suisse. Les frontaliers peuvent choisir entre la LAMal (couverture suisse) et le SSN italien. Avec la LAMal, on accède au système de santé suisse avec des franchises et des modèles d'assurance (base, HMO, télémédecine). Le choix doit être fait dans les 3 mois suivant le début de l'emploi. Comme l'explique Laura Mantovani, courtière en assurance LAMal: «Pour ceux qui ont une famille en Italie, le SSN est souvent plus avantageux, tandis que la LAMal offre un accès plus rapide aux soins en Suisse»."
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
      a: "Cross-border workers with foreign income must use the Modello Redditi PF (formerly Unico). The 730 form is not sufficient."
    },
    de: {
      q: "Kann ich das Formular 730 verwenden oder brauche ich das Modello Redditi PF?",
      a: "Grenzgänger mit ausländischem Einkommen müssen das Modello Redditi PF (ehemals Unico) verwenden. Das Formular 730 reicht nicht aus."
    },
    fr: {
      q: "Puis-je utiliser le formulaire 730 ou dois-je remplir le Modello Redditi PF ?",
      a: "Les frontaliers avec des revenus étrangers doivent utiliser le Modello Redditi PF (anciennement Unico). Le formulaire 730 ne suffit pas."
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
      a: "A cross-border worker with only Swiss employment income must use the Modello Redditi PF (formerly Unico), since the 730 is reserved for workers with an Italian withholding agent. The 730 can only be used if you also have Italian income with a CU. According to Elena Colombo, international tax accountant: 'The most common mistake is filing the 730 without an Italian withholding agent, which invalidates the declaration'."
    },
    de: {
      q: "Muss der Grenzgänger das 730 oder das Modello Redditi PF abgeben?",
      a: "Ein Grenzgänger mit ausschliesslich Schweizer Einkommen aus unselbständiger Arbeit muss das Modello Redditi PF (ehemals Unico) verwenden, da das 730 für Arbeitnehmer mit italienischem Steuersubstitut reserviert ist. Das 730 kann nur verwendet werden, wenn auch italienisches Einkommen mit CU vorliegt. Wie Elena Colombo, auf internationale Steuern spezialisierte Steuerberaterin, erklärt: «Der häufigste Fehler ist die Abgabe des 730 ohne italienischen Steuersubstituten, was die Erklärung ungültig macht»."
    },
    fr: {
      q: "Le frontalier doit-il remplir le 730 ou le Modello Redditi PF ?",
      a: "Un frontalier avec uniquement un revenu suisse salarié doit utiliser le Modello Redditi PF (anciennement Unico), car le 730 est réservé aux travailleurs ayant un substitut fiscal italien. Le 730 ne peut être utilisé que si l'on a aussi un revenu italien avec CU. Comme l'explique Elena Colombo, comptable spécialisée en fiscalité internationale: «L'erreur la plus courante est d'utiliser le 730 sans substitut fiscal italien, ce qui invalide la déclaration»."
    }
  },

  // ── Q76: €10,000 exemption (detailed) ──
  "Cos'è la franchigia di €10.000 per i nuovi frontalieri?": {
    en: {
      q: "What is the €10,000 exemption for new cross-border workers?",
      a: "Under the new 2026 tax agreement, cross-border workers hired from 17 July 2023 benefit from a €10,000 exemption: the first €10,000 of income converted to euros is not taxed in Italy. IRPEF is paid only on the amount exceeding the exemption. According to Elena Colombo, international tax accountant: 'The exemption is applied automatically in the tax return and represents a tangible benefit for all new cross-border workers'."
    },
    de: {
      q: "Was ist der Freibetrag von 10.000 € für neue Grenzgänger?",
      a: "Nach dem neuen Steuerabkommen 2026 profitieren Grenzgänger, die ab dem 17. Juli 2023 eingestellt wurden, von einem Freibetrag von 10.000 €: Die ersten 10.000 € des in Euro umgerechneten Einkommens werden in Italien nicht besteuert. Die IRPEF wird nur auf den übersteigenden Betrag erhoben. Wie Elena Colombo, auf internationale Steuern spezialisierte Steuerberaterin, erklärt: «Der Freibetrag wird automatisch in der Steuererklärung angewendet und stellt einen konkreten Vorteil für alle neuen Grenzgänger dar»."
    },
    fr: {
      q: "Qu'est-ce que la franchise de 10 000 € pour les nouveaux frontaliers ?",
      a: "Selon le nouvel accord fiscal 2026, les frontaliers embauchés à partir du 17 juillet 2023 bénéficient d'une franchise de 10 000 € : les premiers 10 000 € de revenu converti en euros ne sont pas imposés en Italie. L'IRPEF n'est due que sur la partie excédentaire. Comme l'explique Elena Colombo, comptable spécialisée en fiscalité internationale: «La franchise s'applique automatiquement dans la déclaration de revenus et représente un avantage concret pour tous les nouveaux frontaliers»."
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
      a: "The TDR (Tariffa con Deduzione per Rettifica — Rate with Deduction for Rectification) is the procedure that allows cross-border workers taxed at source in Switzerland to request tax rectification and obtain additional deductions such as transport, LPP, pillar 3a, and medical expenses."
    },
    de: {
      q: "Was ist die TDR für Schweizer Grenzgänger?",
      a: "Die TDR (Tariffa con Deduzione per Rettifica — Tarif mit Berichtigungsabzug) ist das Verfahren, das quellenbesteuerten Grenzgängern in der Schweiz ermöglicht, eine Steuerberichtigung zu beantragen und zusätzliche Abzüge wie Transport, BVG, Säule 3a und Arztkosten geltend zu machen."
    },
    fr: {
      q: "Qu'est-ce que le TDR pour les frontaliers suisses ?",
      a: "Le TDR (Tariffa con Deduzione per Rettifica — Barème avec déduction pour rectification) est la procédure permettant aux frontaliers imposés à la source en Suisse de demander une rectification fiscale et d'obtenir des déductions supplémentaires comme le transport, la LPP, le pilier 3a et les frais médicaux."
    }
  },

  // ── Q81: TDR deadline ──
  "Entro quando si presenta la TDR?": {
    en: {
      q: "By when must the TDR be submitted?",
      a: "The TDR rectification request must be submitted by 31 March of the year following the tax year. For example, for 2025 income the deadline is 31 March 2026. After this date, rectification is no longer possible."
    },
    de: {
      q: "Bis wann muss die TDR eingereicht werden?",
      a: "Der TDR-Berichtigungsantrag muss bis zum 31. März des auf das Steuerjahr folgenden Jahres eingereicht werden. Zum Beispiel ist für das Einkommen 2025 die Frist der 31. März 2026. Nach diesem Datum ist eine Berichtigung nicht mehr möglich."
    },
    fr: {
      q: "Avant quand faut-il soumettre le TDR ?",
      a: "La demande de rectification TDR doit être soumise avant le 31 mars de l'année suivant l'année fiscale. Par exemple, pour les revenus 2025, la date limite est le 31 mars 2026. Passé cette date, la rectification n'est plus possible."
    }
  },

  // ── Q82: TDR deductions ──
  "Quali deduzioni posso richiedere con la TDR?": {
    en: {
      q: "Which deductions can I claim through the TDR?",
      a: "Main deductions include: transport costs (max CHF 3,200), meals away from home, LPP buy-back contributions, pillar 3a contributions (max CHF 7,258 for employees), health insurance premiums, uncovered medical expenses, debt interest, and donations."
    },
    de: {
      q: "Welche Abzüge kann ich mit der TDR geltend machen?",
      a: "Die wichtigsten Abzüge sind: Transportkosten (max. CHF 3.200), Verpflegung ausser Haus, BVG-Einkaufsbeiträge, Säule-3a-Beiträge (max. CHF 7.258 für Arbeitnehmer), Krankenkassenprämien, nicht gedeckte Arztkosten, Schuldzinsen und Spenden."
    },
    fr: {
      q: "Quelles déductions peut-on demander via le TDR ?",
      a: "Les principales déductions comprennent : frais de transport (max. CHF 3 200), repas hors domicile, cotisations de rachat LPP, cotisations pilier 3a (max. CHF 7 258 pour les salariés), primes d'assurance maladie, frais médicaux non couverts, intérêts débiteurs et donations."
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
      a: "No, a G-permit cross-border worker is taxed at source and does not need to file an ordinary Swiss tax return. They can, however, request the TDR rectification for deductions. The ordinary declaration is mandatory only if gross income exceeds CHF 120,000."
    },
    de: {
      q: "Muss ein Grenzgänger mit G-Bewilligung eine ordentliche Steuererklärung in der Schweiz abgeben?",
      a: "Nein, ein Grenzgänger mit G-Bewilligung wird quellenbesteuert und muss keine ordentliche Schweizer Steuererklärung abgeben. Er kann jedoch eine TDR-Berichtigung für Abzüge beantragen. Die ordentliche Steuererklärung ist nur bei einem Bruttoeinkommen über CHF 120.000 obligatorisch."
    },
    fr: {
      q: "Un frontalier avec permis G doit-il faire une déclaration ordinaire en Suisse ?",
      a: "Non, un frontalier avec permis G est imposé à la source et n'a pas besoin de déposer une déclaration fiscale ordinaire suisse. Il peut cependant demander la rectification TDR pour obtenir des déductions. La déclaration ordinaire n'est obligatoire que si le revenu brut dépasse CHF 120 000."
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
      a: "Yes, but with a gradual reduction. Under the new agreement, Switzerland will retain 80% of the tax (instead of the current 61.5%). Italy will compensate municipalities with its own funds during the transitional period until 2033. According to Marco Bernasconi, cross-border tax attorney: 'Border municipalities will need to adapt their budgets to the gradual reduction of Swiss rebates'."
    },
    de: {
      q: "Werden die Rückvergütungen mit dem neuen Abkommen 2026 fortgesetzt?",
      a: "Ja, aber mit einer schrittweisen Reduzierung. Nach dem neuen Abkommen behält die Schweiz 80 % der Steuer (statt bisher 61,5 %). Italien wird die Gemeinden während der Übergangszeit bis 2033 mit eigenen Mitteln entschädigen. Wie RA Marco Bernasconi, Steueranwalt für Grenzgänger, erklärt: «Die Grenzgemeinden werden ihre Haushalte an die schrittweise Reduzierung der Schweizer Rückvergütungen anpassen müssen»."
    },
    fr: {
      q: "Les rétrocessions continueront-elles avec le nouvel accord 2026 ?",
      a: "Oui, mais avec une réduction progressive. Selon le nouvel accord, la Suisse retiendra 80 % de l'impôt (au lieu de 61,5 % actuellement). L'Italie compensera les communes avec ses propres fonds pendant la période transitoire jusqu'en 2033. Comme l'explique Me Marco Bernasconi, avocat fiscaliste transfrontalier: «Les communes frontalières devront adapter leurs budgets à la réduction progressive des rétrocessions suisses»."
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
      a: "New cross-border workers (hired after 17/07/2023) have mixed taxation with an exemption and tax credit; old cross-border workers remain under the historical regime with different rules."
    },
    de: {
      q: "Was ist der Unterschied zwischen alten und neuen Grenzgängern (Abkommen 2026)?",
      a: "Neue Grenzgänger (ab 17.07.2023 eingestellt) haben eine gemischte Besteuerung mit Freibetrag und Steueranrechnung; alte Grenzgänger bleiben im historischen Regime mit anderen Regeln."
    },
    fr: {
      q: "Quelle est la différence entre ancien et nouveau frontalier (accord 2026) ?",
      a: "Les nouveaux frontaliers (embauchés après le 17/07/2023) ont une imposition mixte avec franchise et crédit d'impôt ; les anciens frontaliers restent sous le régime historique avec des règles différentes."
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
      a: "From 2024, new cross-border workers pay taxes both in Switzerland (withholding tax) and in Italy (IRPEF with a €10,000 exemption). Old cross-border workers (hired before 17/07/2023) continue under the exclusive Swiss taxation regime until 2033. The simulator handles both scenarios automatically."
    },
    de: {
      q: "Was ändert sich mit dem neuen Grenzgängerabkommen 2026?",
      a: "Ab 2024 zahlen neue Grenzgänger Steuern sowohl in der Schweiz (Quellensteuer) als auch in Italien (IRPEF mit einem Freibetrag von 10.000 €). Altgrenzgänger (eingestellt vor dem 17.07.2023) unterliegen weiterhin der ausschliesslichen Schweizer Besteuerung bis 2033. Der Simulator verarbeitet beide Szenarien automatisch."
    },
    fr: {
      q: "Qu'est-ce qui change avec le nouvel accord frontaliers 2026 ?",
      a: "À partir de 2024, les nouveaux frontaliers paient des impôts à la fois en Suisse (impôt à la source) et en Italie (IRPEF avec une franchise de 10 000 €). Les anciens frontaliers (embauchés avant le 17/07/2023) continuent sous le régime d'imposition exclusivement suisse jusqu'en 2033. Le simulateur gère automatiquement les deux scénarios."
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
      a: "Monthly premiums in Canton Ticino range from around CHF 200 (Assura/Agrisano with Telmed model and CHF 2,500 deductible) to around CHF 600 (standard model with a low deductible)."
    },
    de: {
      q: "Was kostet die KVG-Krankenversicherung für einen Grenzgänger im Tessin?",
      a: "Die monatlichen Prämien im Kanton Tessin reichen von ca. CHF 200 (Assura/Agrisano mit Telmed-Modell und Franchise CHF 2.500) bis ca. CHF 600 (Standardmodell mit niedriger Franchise)."
    },
    fr: {
      q: "Combien coûte l'assurance maladie LAMal pour un frontalier au Tessin ?",
      a: "Les primes mensuelles au Tessin vont d'environ CHF 200 (Assura/Agrisano avec modèle Telmed et franchise CHF 2 500) à environ CHF 600 (modèle standard avec franchise basse)."
    }
  },
  "Qual è la cassa malati più economica per frontalieri?": {
    en: {
      q: "Which health fund is the cheapest for cross-border workers?",
      a: "Assura and Agrisano generally offer the lowest premiums in Canton Ticino. With the Telmed model and CHF 2,500 deductible, premiums start from around CHF 200/month for adults."
    },
    de: {
      q: "Welche Krankenkasse ist für Grenzgänger am günstigsten?",
      a: "Assura und Agrisano bieten im Kanton Tessin in der Regel die tiefsten Prämien. Mit dem Telmed-Modell und einer Franchise von CHF 2.500 beginnen die Prämien bei etwa CHF 200/Monat für Erwachsene."
    },
    fr: {
      q: "Quelle caisse maladie est la moins chère pour les frontaliers ?",
      a: "Assura et Agrisano offrent généralement les primes les plus basses au Tessin. Avec le modèle Telmed et une franchise de CHF 2 500, les primes commencent à environ CHF 200/mois pour les adultes."
    }
  },
  "Cos'è il diritto di opzione per l'assicurazione sanitaria dei frontalieri?": {
    en: {
      q: "What is the right of option for cross-border workers' health insurance?",
      a: "The right of option allows cross-border workers to choose between Swiss LAMal and the Italian national health service (SSN) within 3 months of starting work. The choice is irrevocable for the entire duration of the employment relationship. According to Laura Mantovani, LAMal insurance broker: 'The choice between LAMal and SSN must be carefully weighed because it cannot be changed once made'."
    },
    de: {
      q: "Was ist das Optionsrecht bei der Krankenversicherung für Grenzgänger?",
      a: "Das Optionsrecht erlaubt Grenzgängern, innerhalb von 3 Monaten nach Arbeitsbeginn zwischen der Schweizer KVG und dem italienischen Gesundheitsdienst (SSN) zu wählen. Die Wahl ist für die gesamte Dauer des Arbeitsverhältnisses unwiderruflich. Wie Laura Mantovani, KVG-Versicherungsmaklerin, erklärt: «Die Wahl zwischen KVG und SSN muss sorgfältig abgewogen werden, da sie einmal getroffen nicht mehr geändert werden kann»."
    },
    fr: {
      q: "Qu'est-ce que le droit d'option pour l'assurance maladie des frontaliers ?",
      a: "Le droit d'option permet aux frontaliers de choisir entre la LAMal suisse et le service national de santé italien (SSN) dans les 3 mois suivant le début du travail. Le choix est irrévocable pour toute la durée du rapport de travail. Comme l'explique Laura Mantovani, courtière en assurance LAMal: «Le choix entre LAMal et SSN doit être soigneusement pesé car il ne peut plus être modifié une fois effectué»."
    }
  },
  "Cosa copre l'assicurazione LAMal per frontalieri?": {
    en: {
      q: "What does LAMal health insurance cover for cross-border workers?",
      a: "LAMal covers medical, hospital, and pharmaceutical care in Switzerland. For treatment in Italy, the European Health Insurance Card (EHIC) is required. The annual deductible ranges from CHF 300 to CHF 2,500."
    },
    de: {
      q: "Was deckt die KVG-Krankenversicherung für Grenzgänger ab?",
      a: "Die KVG deckt ärztliche, stationäre und pharmazeutische Leistungen in der Schweiz ab. Für Behandlungen in Italien wird die Europäische Krankenversicherungskarte (EKVK) benötigt. Die jährliche Franchise reicht von CHF 300 bis CHF 2.500."
    },
    fr: {
      q: "Que couvre l'assurance maladie LAMal pour les frontaliers ?",
      a: "La LAMal couvre les soins médicaux, hospitaliers et pharmaceutiques en Suisse. Pour les soins en Italie, la carte européenne d'assurance maladie (CEAM) est nécessaire. La franchise annuelle va de CHF 300 à CHF 2 500."
    }
  },

  // ── Border crossings FAQs ──
  "Quali sono gli orari di apertura dei valichi di frontiera Svizzera-Italia?": {
    en: {
      q: "What are the opening hours of the Switzerland-Italy border crossings?",
      a: "The main crossings (Chiasso motorway, Ponte Tresa) are open 24/7. Minor crossings (Gaggiolo, Stabio, Brogeda) have reduced hours, generally from 6:00 to 22:00."
    },
    de: {
      q: "Wie sind die Öffnungszeiten der Grenzübergänge Schweiz-Italien?",
      a: "Die Hauptübergänge (Autobahnzoll Chiasso, Ponte Tresa) sind rund um die Uhr geöffnet. Kleinere Übergänge (Gaggiolo, Stabio, Brogeda) haben eingeschränkte Öffnungszeiten, in der Regel von 6:00 bis 22:00 Uhr."
    },
    fr: {
      q: "Quels sont les horaires d'ouverture des postes frontière Suisse-Italie ?",
      a: "Les postes principaux (autoroute de Chiasso, Ponte Tresa) sont ouverts 24h/24. Les postes secondaires (Gaggiolo, Stabio, Brogeda) ont des horaires réduits, généralement de 6h00 à 22h00."
    }
  },
  "Qual è il valico meno trafficato tra Svizzera e Italia?": {
    en: {
      q: "Which is the least congested border crossing between Switzerland and Italy?",
      a: "Stabio and Gaggiolo are generally the least congested crossings. On weekdays, waiting times are often under 5 minutes compared to 15–30 minutes at Chiasso during rush hours."
    },
    de: {
      q: "Welcher Grenzübergang zwischen der Schweiz und Italien ist am wenigsten befahren?",
      a: "Stabio und Gaggiolo sind in der Regel die am wenigsten befahrenen Übergänge. An Werktagen betragen die Wartezeiten oft weniger als 5 Minuten, verglichen mit 15–30 Minuten in Chiasso zu Stosszeiten."
    },
    fr: {
      q: "Quel est le poste frontière le moins fréquenté entre la Suisse et l'Italie ?",
      a: "Stabio et Gaggiolo sont généralement les postes les moins fréquentés. En semaine, les temps d'attente sont souvent inférieurs à 5 minutes contre 15 à 30 minutes à Chiasso aux heures de pointe."
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
      a: "Use alternative crossings (Stabio, Gaggiolo), leave before 7:00 or after 8:30. Avoid Monday mornings and Friday evenings. Alternatively, take the train: no customs checks."
    },
    de: {
      q: "Wie kann man Warteschlangen an der Grenze Schweiz-Italien vermeiden?",
      a: "Nutzen Sie alternative Übergänge (Stabio, Gaggiolo), fahren Sie vor 7:00 oder nach 8:30 Uhr los. Meiden Sie Montagmorgen und Freitagabend. Alternativ den Zug nehmen: keine Zollkontrolle."
    },
    fr: {
      q: "Comment éviter les files d'attente à la frontière Suisse-Italie ?",
      a: "Utilisez des postes alternatifs (Stabio, Gaggiolo), partez avant 7h00 ou après 8h30. Évitez le lundi matin et le vendredi soir. Autre option : le train, sans contrôle douanier."
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
      a: "Yes, to work in Ticino as a cross-border worker you need a G permit (Grenzgängerbewilligung). The Swiss employer initiates the process. The permit is renewable every 5 years and requires daily return to the country of residence (Italy). Since 2023, under the new agreement, residents beyond 20 km from the border can also obtain a G permit."
    },
    de: {
      q: "Braucht man eine G-Bewilligung, um als Grenzgänger im Tessin zu arbeiten?",
      a: "Ja, um als Grenzgänger im Tessin zu arbeiten, benötigen Sie eine G-Bewilligung (Grenzgängerbewilligung). Der Schweizer Arbeitgeber leitet das Verfahren ein. Die Bewilligung ist alle 5 Jahre erneuerbar und erfordert die tägliche Rückkehr ins Wohnsitzland (Italien). Seit 2023 können auch Personen mit Wohnsitz über 20 km von der Grenze eine G-Bewilligung erhalten."
    },
    fr: {
      q: "Faut-il un permis G pour travailler au Tessin comme frontalier ?",
      a: "Oui, pour travailler au Tessin en tant que frontalier, il faut un permis G (Grenzgängerbewilligung). L'employeur suisse initie la démarche. Le permis est renouvelable tous les 5 ans et exige le retour quotidien dans le pays de résidence (Italie). Depuis 2023, avec le nouvel accord, les résidents à plus de 20 km de la frontière peuvent également obtenir un permis G."
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
      a: "Yes. By selecting 'old cross-border worker' the simulator applies the transitional tax regime: exclusive taxation in Switzerland (no Italian IRPEF) until 2033. Old cross-border workers are those hired before 17 July 2023 residing within 20 km of the border."
    },
    de: {
      q: "Funktioniert der Simulator auch für Altgrenzgänger?",
      a: "Ja. Durch Auswahl von 'Altgrenzgänger' wendet der Simulator das Übergangssteuerregime an: ausschliessliche Besteuerung in der Schweiz (keine italienische IRPEF) bis 2033. Altgrenzgänger sind Personen, die vor dem 17. Juli 2023 eingestellt wurden und innerhalb von 20 km zur Grenze wohnen."
    },
    fr: {
      q: "Le simulateur fonctionne-t-il aussi pour les anciens frontaliers ?",
      a: "Oui. En sélectionnant 'ancien frontalier', le simulateur applique le régime fiscal transitoire : imposition exclusive en Suisse (pas d'IRPEF italienne) jusqu'en 2033. Les anciens frontaliers sont ceux embauchés avant le 17 juillet 2023 résidant dans un rayon de 20 km de la frontière."
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
      a: "The old cross-border worker (hired before 17 July 2023 in municipalities within 20 km of the border) pays only Swiss withholding tax. The new cross-border worker pays both the reduced Swiss withholding tax (80%) and Italian IRPEF, with a tax credit and a EUR 10,000 exemption. According to Marco Bernasconi, cross-border tax attorney: 'This distinction is fundamental because it determines the entire tax regime applicable to the worker for the duration of the employment relationship'."
    },
    de: {
      q: "Was ist der Unterschied zwischen alten und neuen Grenzgängern?",
      a: "Der alte Grenzgänger (vor dem 17. Juli 2023 in Gemeinden bis 20 km zur Grenze eingestellt) zahlt nur die Schweizer Quellensteuer. Der neue Grenzgänger zahlt sowohl die reduzierte Schweizer Quellensteuer (80 %) als auch die italienische IRPEF, mit Steuergutschrift und Freibetrag von 10.000 EUR. Wie RA Marco Bernasconi, Steueranwalt für Grenzgänger, erklärt: «Diese Unterscheidung ist grundlegend, da sie das gesamte steuerliche Regime bestimmt, das für den Arbeitnehmer während der gesamten Dauer des Arbeitsverhältnisses gilt»."
    },
    fr: {
      q: "Quelle est la différence entre ancien et nouveau frontalier ?",
      a: "L'ancien frontalier (engagé avant le 17 juillet 2023 dans les communes à moins de 20 km de la frontière) ne paie que l'impôt à la source suisse. Le nouveau frontalier paie à la fois l'impôt à la source suisse réduit (80 %) et l'IRPEF italienne, avec un crédit d'impôt et une franchise de 10 000 EUR. Comme l'explique Me Marco Bernasconi, avocat fiscaliste transfrontalier: «Cette distinction est fondamentale car elle détermine l'ensemble du régime fiscal applicable au travailleur pendant toute la durée du rapport de travail»."
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
      a: "LAMal premiums for cross-border workers in Canton Ticino range from CHF 270 to CHF 560/month depending on the insurer, model (Standard, Telmed, HMO) and deductible (CHF 300-2,500). The cheapest options are Assura and Agrisano with Telmed model and CHF 2,500 deductible, at around CHF 270-300/month. The comparator on frontaliereticino.ch compares 14 insurers across 7 cantons. According to Laura Mantovani, LAMal insurance broker: 'Comparing at least 3-4 quotes before choosing can save over CHF 2,000 per year'."
    },
    de: {
      q: "Was kostet die KVG-Krankenversicherung für Grenzgänger?",
      a: "Die KVG-Prämien für Grenzgänger im Kanton Tessin liegen zwischen CHF 270 und CHF 560/Monat je nach Versicherer, Modell (Standard, Telmed, HMO) und Franchise (CHF 300-2.500). Die günstigsten Optionen sind Assura und Agrisano mit Telmed-Modell und CHF 2.500 Franchise, ab ca. CHF 270-300/Monat. Der Vergleichsrechner auf frontaliereticino.ch vergleicht 14 Versicherer in 7 Kantonen. Wie Laura Mantovani, KVG-Versicherungsmaklerin, erklärt: «Mindestens 3-4 Angebote zu vergleichen kann über CHF 2.000 pro Jahr einsparen»."
    },
    fr: {
      q: "Combien coûte l'assurance maladie LAMal pour les frontaliers ?",
      a: "Les primes LAMal pour frontaliers au Tessin varient de CHF 270 à CHF 560/mois selon l'assureur, le modèle (Standard, Telmed, HMO) et la franchise (CHF 300-2 500). Les options les moins chères sont Assura et Agrisano avec modèle Telmed et franchise CHF 2 500, à environ CHF 270-300/mois. Le comparateur sur frontaliereticino.ch compare 14 assureurs dans 7 cantons. Comme l'explique Laura Mantovani, courtière en assurance LAMal: «Comparer au moins 3-4 offres avant de choisir peut faire économiser plus de CHF 2 000 par an»."
    }
  },

  "Come funziona la pensione per i frontalieri svizzeri?": {
    en: {
      q: "How does the pension system work for Swiss cross-border workers?",
      a: "Cross-border workers contribute to 3 pillars: 1st pillar AVS (state pension, 5.3% contribution, max CHF 2,450/month pension), 2nd pillar LPP (company pension fund, 7-18% contribution by age), and can contribute to the 3rd pillar 3a (max CHF 7,258/year in 2026, tax-deductible). On returning to Italy, LPP capital can be withdrawn as a lump sum. According to Andrea Fiorini, pension planning consultant: 'Planning the coordination between the three Swiss pillars and Italian INPS is crucial to maximize overall retirement income'."
    },
    de: {
      q: "Wie funktioniert das Rentensystem für Schweizer Grenzgänger?",
      a: "Grenzgänger zahlen in 3 Säulen ein: 1. Säule AHV (Staatsrente, 5,3 % Beitrag, max. CHF 2.450/Monat Rente), 2. Säule BVG (betriebliche Pensionskasse, 7-18 % Beitrag nach Alter), und können in die 3. Säule 3a einzahlen (max. CHF 7.258/Jahr 2026, steuerlich absetzbar). Bei Rückkehr nach Italien kann das BVG-Kapital als Einmalzahlung bezogen werden. Wie Andrea Fiorini, Vorsorgeberater, erklärt: «Die Koordination zwischen den drei Schweizer Säulen und der italienischen INPS zu planen ist entscheidend, um die gesamte Rentenleistung zu maximieren»."
    },
    fr: {
      q: "Comment fonctionne le système de retraite pour les frontaliers suisses ?",
      a: "Les frontaliers cotisent à 3 piliers : 1er pilier AVS (retraite d'État, cotisation 5,3 %, rente max CHF 2 450/mois), 2e pilier LPP (caisse de pension d'entreprise, cotisation 7-18 % selon l'âge), et peuvent cotiser au 3e pilier 3a (max CHF 7 258/an en 2026, déductible fiscalement). Au retour en Italie, le capital LPP peut être retiré en capital. Comme l'explique Andrea Fiorini, conseiller en prévoyance: «Planifier la coordination entre les trois piliers suisses et l'INPS italienne est crucial pour maximiser le revenu global de retraite»."
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
      a: "New cross-border workers (hired from 17 July 2023) must file an Italian tax return (Form 730 or PF Income Model) to declare Swiss income and claim the tax credit for taxes paid in Switzerland. Old cross-border workers (hired before July 2023, within 20 km) are generally exempt for Swiss employment income."
    },
    de: {
      q: "Müssen Grenzgänger eine Steuererklärung in Italien abgeben?",
      a: "Neue Grenzgänger (ab 17. Juli 2023 eingestellt) müssen eine italienische Steuererklärung (Modell 730 oder PF-Einkommensmodell) abgeben, um das Schweizer Einkommen zu deklarieren und die Steuergutschrift für in der Schweiz gezahlte Steuern zu beantragen. Alte Grenzgänger (vor Juli 2023 eingestellt, bis 20 km) sind für das Schweizer Arbeitseinkommen grundsätzlich befreit."
    },
    fr: {
      q: "Les frontaliers doivent-ils faire une déclaration de revenus en Italie ?",
      a: "Les nouveaux frontaliers (engagés à partir du 17 juillet 2023) doivent obligatoirement déposer une déclaration de revenus italienne (Modèle 730 ou Modèle Revenus PF) pour déclarer le revenu suisse et demander le crédit d'impôt pour les impôts payés en Suisse. Les anciens frontaliers (engagés avant juillet 2023, à moins de 20 km) sont généralement exonérés pour le revenu d'emploi suisse."
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
      a: "Ristorni are fiscal compensations that Switzerland pays to Italian border municipalities. Under the old agreement, Switzerland returns 40% of the withholding tax collected from old cross-border workers to their municipalities of residence. Ristorni are being gradually eliminated during the 2024-2033 transition period, as new cross-border workers pay taxes directly in Italy."
    },
    de: {
      q: "Was sind Steuerrückvergütungen (Ristorni)?",
      a: "Ristorni sind steuerliche Ausgleichszahlungen, die die Schweiz an italienische Grenzgemeinden leistet. Nach dem alten Abkommen gibt die Schweiz 40 % der von alten Grenzgängern erhobenen Quellensteuer an deren Wohngemeinden zurück. Ristorni werden während der Übergangszeit 2024-2033 schrittweise abgeschafft, da neue Grenzgänger Steuern direkt in Italien zahlen."
    },
    fr: {
      q: "Que sont les rétrocessions fiscales (ristorni) ?",
      a: "Les ristorni sont des compensations fiscales que la Suisse verse aux communes frontalières italiennes. Avec l'ancien accord, la Suisse restitue 40 % de l'impôt à la source perçu sur les anciens frontaliers à leurs communes de résidence. Les ristorni sont progressivement supprimés pendant la période transitoire 2024-2033, car les nouveaux frontaliers paient les impôts directement en Italie."
    }
  },

  // ── Simulazione tasse nuovi frontalieri page (4 missing) ─────────────

  "Come vengono tassati i nuovi frontalieri dal 2024?": {
    en: {
      q: "How are new cross-border workers taxed from 2024?",
      a: "From 2024, new cross-border workers (hired from 17 July 2023) are subject to dual taxation: Swiss withholding tax at source (80% stays in Switzerland) and Italian IRPEF with a EUR 10,000 exemption and tax credit for Swiss taxes paid. The Italian tax return is mandatory."
    },
    de: {
      q: "Wie werden neue Grenzgänger ab 2024 besteuert?",
      a: "Ab 2024 unterliegen neue Grenzgänger (ab 17. Juli 2023 eingestellt) einer Doppelbesteuerung: Schweizer Quellensteuer (80 % verbleiben in der Schweiz) und italienische IRPEF mit Freibetrag von 10.000 EUR und Steuergutschrift für gezahlte Schweizer Steuern. Die italienische Steuererklärung ist obligatorisch."
    },
    fr: {
      q: "Comment les nouveaux frontaliers sont-ils imposés à partir de 2024 ?",
      a: "À partir de 2024, les nouveaux frontaliers (engagés dès le 17 juillet 2023) sont soumis à une double imposition : impôt à la source suisse (80 % reste en Suisse) et IRPEF italienne avec franchise de 10 000 EUR et crédit d'impôt pour les impôts suisses payés. La déclaration fiscale italienne est obligatoire."
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
