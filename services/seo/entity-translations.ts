// Entity translations for schema.org structured data.
//
// Covers @type: WebApplication, Organization, Review, ClaimReview, Dataset
// as emitted by services/seo/seo-pages.ts.
//
// Each translator function mutates the passed object in place, silent-falls
// back on missing keys (leaving Italian source untouched) and sets
// `inLanguage` when it is already present on the object.
//
// Brand names NEVER translate: "Frontaliere Ticino", "Wise", "Revolut",
// "UBS", "PostFinance", "Raiffeisen", "N26", etc. Swiss domain terms like
// "Ticino", "LAMal", "AVS", "LPP", "AHV", "BVG", "IRPEF", "Permesso G/B"
// follow idiomatic per-locale conventions (e.g. LAMal → KVG in DE,
// AVS → AHV in DE, LPP → BVG in DE).
//
// Registered in services/seo/schema-translators.ts.
//
// NOTE: Strings intentionally avoid accented characters where the source
// avoids them (Swiss-German umlaut rendering under ASCII-safe build).

export type SupportedLocale = 'en' | 'de' | 'fr';

interface LocalizedText {
 name?: string;
 description?: string;
}

type LocaleBundle<T> = { en: T; de: T; fr: T };

// ─── WebApplication lookup ─────────────────────────────────────────────
// Key = Italian `name`. Translates name + description.

export const WEB_APPLICATION_TRANSLATIONS: Record<string, LocaleBundle<LocalizedText>> = {
 "Simulatore Fiscale Frontalieri": {
 en: {
 name: "Cross-Border Worker Tax Simulator",
 description: "Accurate tax calculation for cross-border workers between Switzerland and Italy under the 2026 New Agreement"
 },
 de: {
 name: "Steuersimulator fuer Grenzgaenger",
 description: "Praezise Steuerberechnung fuer Grenzgaenger zwischen Schweiz und Italien gemaess dem Neuen Abkommen 2026"
 },
 fr: {
 name: "Simulateur fiscal pour frontaliers",
 description: "Calcul precis des impots pour frontaliers entre Suisse et Italie selon le Nouvel Accord 2026"
 }
 },
 "Simulatore Stipendio Frontaliere": {
 en: {
 name: "Cross-Border Worker Salary Simulator",
 description: "Simulator for the net salary of Swiss-Italian cross-border workers"
 },
 de: {
 name: "Lohnsimulator fuer Grenzgaenger",
 description: "Simulator fuer den Nettolohn von Grenzgaengern zwischen Schweiz und Italien"
 },
 fr: {
 name: "Simulateur de salaire pour frontaliers",
 description: "Simulateur du salaire net pour frontaliers Suisse-Italie"
 }
 },
 "Simulazione Tasse Nuovi Frontalieri 2026": {
 en: {
 name: "New Cross-Border Workers Tax Simulation 2026",
 description: "Free simulator for calculating taxes for new cross-border workers under the new Italy-Switzerland tax agreement: withholding tax, IRPEF with EUR 10,000 exemption, tax credit."
 },
 de: {
 name: "Steuersimulation fuer neue Grenzgaenger 2026",
 description: "Kostenloser Simulator zur Berechnung der Steuern fuer neue Grenzgaenger gemaess dem neuen Steuerabkommen Italien-Schweiz: Quellensteuer, IRPEF mit Freibetrag von 10.000 EUR, Steuergutschrift."
 },
 fr: {
 name: "Simulation fiscale pour nouveaux frontaliers 2026",
 description: "Simulateur gratuit pour le calcul des impots des nouveaux frontaliers selon le nouvel accord fiscal Italie-Suisse : impot a la source, IRPEF avec franchise de 10 000 EUR, credit d'impot."
 }
 },
 "Comparatore Cambio CHF/EUR": {
 en: {
 name: "CHF/EUR Exchange Rate Comparator",
 description: "Real-time CHF/EUR exchange rate comparison across 6 providers: Wise, Revolut, PostFinance, UBS, Raiffeisen, N26"
 },
 de: {
 name: "Wechselkursvergleich CHF/EUR",
 description: "Echtzeitvergleich der CHF/EUR-Wechselkurse bei 6 Anbietern: Wise, Revolut, PostFinance, UBS, Raiffeisen, N26"
 },
 fr: {
 name: "Comparateur de taux de change CHF/EUR",
 description: "Comparaison en temps reel des taux de change CHF/EUR entre 6 fournisseurs : Wise, Revolut, PostFinance, UBS, Raiffeisen, N26"
 }
 },
 "Confronto Operatori Mobili per Frontalieri": {
 en: {
 name: "Mobile Carrier Comparison for Cross-Border Workers",
 description: "Monthly cost comparison of 6 Swiss mobile carriers with unlimited roaming in Italy"
 },
 de: {
 name: "Mobilfunkanbieter-Vergleich fuer Grenzgaenger",
 description: "Vergleich der monatlichen Kosten von 6 Schweizer Mobilfunkanbietern mit unbegrenztem Roaming in Italien"
 },
 fr: {
 name: "Comparaison des operateurs mobiles pour frontaliers",
 description: "Comparaison des couts mensuels de 6 operateurs mobiles suisses avec roaming illimite en Italie"
 }
 },
 "Comparatore Assicurazioni Sanitarie LAMal": {
 en: {
 name: "LAMal Health Insurance Comparator",
 description: "Compare LAMal health insurance premiums across 14 Swiss insurers in 7 cantons"
 },
 de: {
 name: "KVG-Krankenversicherungsvergleich",
 description: "Vergleichen Sie die KVG-Krankenversicherungspraemien von 14 Schweizer Versicherern in 7 Kantonen"
 },
 fr: {
 name: "Comparateur d'assurance maladie LAMal",
 description: "Comparez les primes d'assurance maladie LAMal de 14 assureurs suisses dans 7 cantons"
 }
 },
 "Pianificatore Pensione Frontalieri": {
 en: {
 name: "Cross-Border Worker Pension Planner",
 description: "Tool to calculate and plan the pension of cross-border workers between Switzerland and Italy"
 },
 de: {
 name: "Rentenplaner fuer Grenzgaenger",
 description: "Werkzeug zur Berechnung und Planung der Rente von Grenzgaengern zwischen Schweiz und Italien"
 },
 fr: {
 name: "Planificateur de retraite pour frontaliers",
 description: "Outil pour calculer et planifier la retraite des frontaliers entre Suisse et Italie"
 }
 },
 "Simulatore What-If Frontalieri": {
 en: {
 name: "What-If Simulator for Cross-Border Workers",
 description: "Fiscal scenario simulator for cross-border workers: how taxes change with a child, a different salary, or marital status"
 },
 de: {
 name: "What-If-Simulator fuer Grenzgaenger",
 description: "Simulator steuerlicher Szenarien fuer Grenzgaenger: wie sich die Steuern bei einem Kind, einem anderen Gehalt oder einem anderen Zivilstand aendern"
 },
 fr: {
 name: "Simulateur What-If pour frontaliers",
 description: "Simulateur de scenarios fiscaux pour frontaliers : comment les impots changent avec un enfant, un salaire different ou un etat civil different"
 }
 },
 "Simulatore 3° Pilastro Svizzera": {
 en: {
 name: "Swiss 3rd Pillar Simulator",
 description: "Calculate tax savings and growth of the Swiss 3rd pillar (3a and 3b) with long-term projection"
 },
 de: {
 name: "Schweizer Saeule-3-Simulator",
 description: "Berechnen Sie Steuerersparnisse und Wachstum der Schweizer 3. Saeule (3a und 3b) mit Langzeitprojektion"
 },
 fr: {
 name: "Simulateur du 3e pilier suisse",
 description: "Calculez les economies d'impot et la croissance du 3e pilier suisse (3a et 3b) avec projection a long terme"
 }
 },
 "Confronto Prezzi Supermercato Svizzera-Italia": {
 en: {
 name: "Switzerland-Italy Supermarket Price Comparison",
 description: "Interactive map of 40+ border supermarkets with price comparison of 25 products and a cost-of-living index by area"
 },
 de: {
 name: "Supermarkt-Preisvergleich Schweiz-Italien",
 description: "Interaktive Karte von 40+ Grenzsupermaerkten mit Preisvergleich fuer 25 Produkte und Preisindex pro Gebiet"
 },
 fr: {
 name: "Comparaison des prix de supermarche Suisse-Italie",
 description: "Carte interactive de plus de 40 supermarches frontaliers avec comparaison des prix de 25 produits et indice de cout par zone"
 }
 },
 "Confronto Costo della Vita Svizzera-Italia": {
 en: {
 name: "Switzerland-Italy Cost of Living Comparison",
 description: "Interactive comparison of the cost of living between Swiss and Italian border cities"
 },
 de: {
 name: "Lebenshaltungskosten-Vergleich Schweiz-Italien",
 description: "Interaktiver Vergleich der Lebenshaltungskosten zwischen Schweizer und italienischen Grenzstaedten"
 },
 fr: {
 name: "Comparaison du cout de la vie Suisse-Italie",
 description: "Comparaison interactive du cout de la vie entre villes frontalieres suisses et italiennes"
 }
 },
 "Mappa Comuni di Frontiera Italia-Svizzera": {
 en: {
 name: "Italy-Switzerland Border Towns Map",
 description: "Interactive map of Italian border towns with distances to crossings and useful information"
 },
 de: {
 name: "Karte der Grenzgemeinden Italien-Schweiz",
 description: "Interaktive Karte der italienischen Grenzgemeinden mit Entfernungen zu den Grenzuebergaengen und nuetzlichen Informationen"
 },
 fr: {
 name: "Carte des communes frontalieres Italie-Suisse",
 description: "Carte interactive des communes italiennes frontalieres avec distances aux passages et informations utiles"
 }
 },
 "Calcolatore RAL Netta Italia vs Svizzera": {
 en: {
 name: "Italy vs Switzerland Net Gross Salary Calculator",
 description: "Compare net salary at equal gross pay between Italy and Switzerland: IRPEF, INPS, withholding tax, Swiss social contributions"
 },
 de: {
 name: "Rechner Brutto-Netto Italien vs Schweiz",
 description: "Vergleichen Sie das Nettogehalt bei gleichem Bruttobetrag zwischen Italien und der Schweiz: IRPEF, INPS, Quellensteuer, Schweizer Sozialbeitraege"
 },
 fr: {
 name: "Calculateur salaire brut-net Italie vs Suisse",
 description: "Comparez le salaire net a brut egal entre Italie et Suisse : IRPEF, INPS, impot a la source, cotisations sociales suisses"
 }
 },
 "Calcolatore Congedo Genitoriale Frontalieri": {
 en: {
 name: "Cross-Border Worker Parental Leave Calculator",
 description: "Calculate maternity and paternity leave for cross-border workers: Swiss IPG vs Italian INPS, amounts and documents"
 },
 de: {
 name: "Elternzeit-Rechner fuer Grenzgaenger",
 description: "Berechnen Sie Mutterschafts- und Vaterschaftsurlaub fuer Grenzgaenger: Schweizer EO vs italienische INPS, Betraege und Unterlagen"
 },
 fr: {
 name: "Calculateur de conge parental pour frontaliers",
 description: "Calculez le conge maternite et paternite pour frontaliers : APG suisse vs INPS italien, montants et documents"
 }
 },
 "Buongiorno Frontaliere - Dashboard Mattutino": {
 en: {
 name: "Good Morning Cross-Border Worker - Morning Dashboard",
 description: "Morning dashboard for cross-border workers with weather, border crossing traffic and live CHF-EUR exchange rate"
 },
 de: {
 name: "Guten Morgen Grenzgaenger - Morgen-Dashboard",
 description: "Morgen-Dashboard fuer Grenzgaenger mit Wetter, Grenzverkehr und Live-Wechselkurs CHF-EUR"
 },
 fr: {
 name: "Bonjour Frontalier - Tableau de bord matinal",
 description: "Tableau de bord matinal pour frontaliers avec meteo, trafic aux passages et taux de change CHF-EUR en direct"
 }
 },
 "Simulatore Busta Paga Svizzera": {
 en: {
 name: "Swiss Payslip Simulator",
 description: "Simulate the Swiss payslip with AVS, AC, LAA, LPP deductions and withholding tax for cross-border workers"
 },
 de: {
 name: "Schweizer Lohnabrechnungs-Simulator",
 description: "Simulieren Sie die Schweizer Lohnabrechnung mit Abzuegen fuer AHV, ALV, UVG, BVG und Quellensteuer fuer Grenzgaenger"
 },
 fr: {
 name: "Simulateur de fiche de paie suisse",
 description: "Simulez la fiche de paie suisse avec les deductions AVS, AC, LAA, LPP et l'impot a la source pour les frontaliers"
 }
 },
 "Confronto Permesso G vs B": {
 en: {
 name: "G Permit vs B Permit Comparison",
 description: "Tax comparison between the G permit (cross-border worker) and the B permit (resident): taxes, contributions, costs"
 },
 de: {
 name: "Vergleich G-Bewilligung vs B-Bewilligung",
 description: "Steuerlicher Vergleich zwischen G-Bewilligung (Grenzgaenger) und B-Bewilligung (Aufenthalter): Steuern, Beitraege, Kosten"
 },
 fr: {
 name: "Comparaison Permis G vs Permis B",
 description: "Comparaison fiscale entre le permis G (frontalier) et le permis B (resident) : impots, cotisations, couts"
 }
 },
 "Calcolatore Credito d'Imposta Frontalieri": {
 en: {
 name: "Cross-Border Worker Tax Credit Calculator",
 description: "Calculate the tax credit to avoid double taxation Switzerland-Italy for cross-border workers"
 },
 de: {
 name: "Steuergutschrift-Rechner fuer Grenzgaenger",
 description: "Berechnen Sie die Steuergutschrift zur Vermeidung der Doppelbesteuerung Schweiz-Italien fuer Grenzgaenger"
 },
 fr: {
 name: "Calculateur de credit d'impot pour frontaliers",
 description: "Calculez le credit d'impot pour eviter la double imposition Suisse-Italie pour les frontaliers"
 }
 },
 "Calcolatore TFR vs LPP per Frontalieri": {
 en: {
 name: "TFR vs LPP Calculator for Cross-Border Workers",
 description: "Italian TFR vs Swiss 2nd pillar (LPP/BVG) simulator for cross-border workers. Comparison over N years of contributions."
 },
 de: {
 name: "TFR vs BVG-Rechner fuer Grenzgaenger",
 description: "Simulator italienische TFR vs Schweizer 2. Saeule (BVG) fuer Grenzgaenger. Vergleich ueber N Beitragsjahre."
 },
 fr: {
 name: "Calculateur TFR vs LPP pour frontaliers",
 description: "Simulateur TFR italien vs 2e pilier suisse (LPP) pour frontaliers. Comparaison sur N annees de cotisations."
 }
 },
 "Quiz Permesso B o G per Frontalieri": {
 en: {
 name: "B or G Permit Quiz for Cross-Border Workers",
 description: "Interactive quiz to choose between the B permit (residence) and the G permit (cross-border) in Switzerland. 8 personalised questions."
 },
 de: {
 name: "Quiz B- oder G-Bewilligung fuer Grenzgaenger",
 description: "Interaktives Quiz zur Auswahl zwischen B-Bewilligung (Aufenthalt) und G-Bewilligung (Grenzgaenger) in der Schweiz. 8 personalisierte Fragen."
 },
 fr: {
 name: "Quiz Permis B ou G pour frontaliers",
 description: "Quiz interactif pour choisir entre le permis B (residence) et le permis G (frontalier) en Suisse. 8 questions personnalisees."
 }
 },
 "Calcolatore Tredicesima per Frontalieri": {
 en: {
 name: "13th Salary Calculator for Cross-Border Workers",
 description: "Calculate the 13th and 14th month pay for cross-border workers. Compare the Swiss 13th salary vs the Italian 13th month with pro-rata."
 },
 de: {
 name: "13.-Monatslohn-Rechner fuer Grenzgaenger",
 description: "Berechnen Sie den 13. und 14. Monatslohn fuer Grenzgaenger. Vergleich Schweizer 13. Monatslohn vs italienische tredicesima mit Pro-rata."
 },
 fr: {
 name: "Calculateur 13e salaire pour frontaliers",
 description: "Calculez le 13e et le 14e mois pour frontaliers. Comparez le 13e salaire suisse vs la tredicesima italienne au prorata."
 }
 },
 "Confronto Asili Nido Ticino-Italia": {
 en: {
 name: "Ticino-Italy Nursery Comparison",
 description: "Comparison of nursery costs and availability between Canton Ticino and Italy for cross-border worker families"
 },
 de: {
 name: "Kita-Vergleich Tessin-Italien",
 description: "Vergleich von Kita-Kosten und Verfuegbarkeit zwischen Kanton Tessin und Italien fuer Grenzgaenger-Familien"
 },
 fr: {
 name: "Comparaison creches Tessin-Italie",
 description: "Comparaison des couts et de la disponibilite des creches entre le Canton du Tessin et l'Italie pour les familles de frontaliers"
 }
 },
 "Simulatore Confronto Mutui Italia vs Svizzera": {
 en: {
 name: "Italy vs Switzerland Mortgage Comparison Simulator",
 description: "Interactive simulator to compare Italian mortgages and Swiss mortgages: monthly payment, total interest, tax advantages, Tragbarkeit"
 },
 de: {
 name: "Hypothekenvergleich-Simulator Italien vs Schweiz",
 description: "Interaktiver Simulator zum Vergleich italienischer Hypotheken und Schweizer Hypotheken: Monatsrate, Gesamtzinsen, Steuervorteile, Tragbarkeit"
 },
 fr: {
 name: "Simulateur de comparaison hypothecaire Italie vs Suisse",
 description: "Simulateur interactif pour comparer les prets immobiliers italiens et les hypotheques suisses : mensualite, interets totaux, avantages fiscaux, Tragbarkeit"
 }
 },
 "Calcolatore Bonus Frontalieri": {
 en: {
 name: "Cross-Border Worker Bonus Calculator",
 description: "Calculate the taxation of bonuses and the 13th month for cross-border workers"
 },
 de: {
 name: "Bonus-Rechner fuer Grenzgaenger",
 description: "Berechnen Sie die Besteuerung von Boni und 13. Monatslohn fuer Grenzgaenger"
 },
 fr: {
 name: "Calculateur de bonus pour frontaliers",
 description: "Calculez la taxation des bonus et du 13e mois pour les frontaliers"
 }
 },
 "Calcolatore Bonus Ristrutturazione": {
 en: {
 name: "Home Renovation Bonus Calculator",
 description: "Calculate the deductions for home renovation available for cross-border workers resident in Italy"
 },
 de: {
 name: "Renovationsbonus-Rechner",
 description: "Berechnen Sie die Abzuege fuer Hausrenovationen, die Grenzgaengern mit Wohnsitz in Italien zur Verfuegung stehen"
 },
 fr: {
 name: "Calculateur de bonus renovation",
 description: "Calculez les deductions pour la renovation de la maison disponibles pour les frontaliers residant en Italie"
 }
 }
};

// ─── Organization lookup ───────────────────────────────────────────────
// "Frontaliere Ticino" is a brand: name stays. Translate description +
// knowsAbout (array of topic labels) + areaServed.name.

interface OrganizationTranslation {
 description?: string;
 slogan?: string;
 knowsAbout?: string[];
}

export const ORGANIZATION_TRANSLATIONS: Record<string, LocaleBundle<OrganizationTranslation>> = {
 "Frontaliere Ticino": {
 en: {
 description: "The most comprehensive resource for cross-border workers between Italy and Switzerland: tax simulator, pension, health insurance, currency exchange and practical guides.",
 knowsAbout: [
 "Cross-border worker taxation Switzerland-Italy",
 "New 2026 tax agreement",
 "Social security AVS/LPP",
 "Health insurance LAMal/CMB",
 "G permit and B permit",
 "Ticino labour market"
 ]
 },
 de: {
 description: "Die umfassendste Ressource fuer Grenzgaenger zwischen Italien und der Schweiz: Steuersimulator, Rente, Krankenversicherung, Waehrungsumtausch und praktische Leitfaeden.",
 knowsAbout: [
 "Besteuerung Grenzgaenger Schweiz-Italien",
 "Neues Steuerabkommen 2026",
 "Sozialversicherung AHV/BVG",
 "Krankenversicherung KVG",
 "G-Bewilligung und B-Bewilligung",
 "Arbeitsmarkt Tessin"
 ]
 },
 fr: {
 description: "La ressource la plus complete pour les frontaliers entre Italie et Suisse : simulateur fiscal, retraite, assurance maladie, change de devises et guides pratiques.",
 knowsAbout: [
 "Fiscalite frontaliers Suisse-Italie",
 "Nouvel accord fiscal 2026",
 "Prevoyance sociale AVS/LPP",
 "Assurance maladie LAMal",
 "Permis G et permis B",
 "Marche du travail Tessin"
 ]
 }
 },
 "Opinione comune": {
 en: { description: "Common belief" },
 de: { description: "Allgemeine Meinung" },
 fr: { description: "Opinion commune" }
 },
 "SECO — Segreteria di Stato dell'economia": {
 en: { description: "SECO — State Secretariat for Economic Affairs" },
 de: { description: "SECO — Staatssekretariat fuer Wirtschaft" },
 fr: { description: "SECO — Secretariat d'Etat a l'economie" }
 }
};

// Country name translation map (used by Organization.areaServed).
const COUNTRY_NAME_TRANSLATIONS: Record<string, LocaleBundle<string>> = {
 "Switzerland": { en: "Switzerland", de: "Schweiz", fr: "Suisse" },
 "Italy": { en: "Italy", de: "Italien", fr: "Italie" }
};

// ─── Review.reviewBody lookup ──────────────────────────────────────────

export const REVIEW_BODY_TRANSLATIONS: Record<string, LocaleBundle<string>> = {
 "Finalmente un calcolatore preciso per frontalieri! Ho verificato con la mia busta paga e il risultato era quasi identico. Utilissimo per chi deve decidere tra Permesso B e G.": {
 en: "Finally an accurate calculator for cross-border workers! I checked it against my payslip and the result was almost identical. Very useful for anyone deciding between the B and G permits.",
 de: "Endlich ein praeziser Rechner fuer Grenzgaenger! Ich habe ihn mit meiner Lohnabrechnung verglichen und das Ergebnis war fast identisch. Sehr nuetzlich, wenn man sich zwischen B- und G-Bewilligung entscheiden muss.",
 fr: "Enfin un calculateur precis pour frontaliers ! J'ai verifie avec ma fiche de paie et le resultat etait presque identique. Tres utile pour ceux qui doivent choisir entre le permis B et le permis G."
 },
 "Ho usato il confronto Permesso G vs B per decidere se trasferirmi a Lugano o continuare a pendolare da Como. I numeri mi hanno aiutato a fare una scelta consapevole.": {
 en: "I used the G vs B permit comparison to decide whether to move to Lugano or keep commuting from Como. The numbers helped me make an informed choice.",
 de: "Ich habe den Vergleich G- vs B-Bewilligung genutzt, um zu entscheiden, ob ich nach Lugano ziehe oder weiter von Como pendle. Die Zahlen haben mir geholfen, eine fundierte Wahl zu treffen.",
 fr: "J'ai utilise la comparaison permis G vs B pour decider si demenager a Lugano ou continuer a faire la navette depuis Come. Les chiffres m'ont aide a faire un choix eclaire."
 },
 "Il pianificatore pensione AVS/LPP è molto utile per capire quanto accumulerò lavorando in Svizzera. Manca solo la simulazione del terzo pilastro integrata, ma nel complesso ottimo.": {
 en: "The AVS/LPP pension planner is very useful to understand how much I will accumulate working in Switzerland. Only the integrated third-pillar simulation is missing, but overall excellent.",
 de: "Der AHV/BVG-Rentenplaner ist sehr nuetzlich, um zu verstehen, wie viel ich bei der Arbeit in der Schweiz ansparen werde. Nur die integrierte Simulation der 3. Saeule fehlt, aber insgesamt ausgezeichnet.",
 fr: "Le planificateur de retraite AVS/LPP est tres utile pour comprendre ce que j'accumulerai en travaillant en Suisse. Seule la simulation integree du 3e pilier manque, mais dans l'ensemble excellent."
 },
 "Il confronto LAMal vs SSN mi ha fatto risparmiare quasi 200 CHF al mese scegliendo l'assicurazione giusta. Strumento indispensabile per ogni frontaliere.": {
 en: "The LAMal vs SSN comparison saved me nearly CHF 200 per month by choosing the right insurance. An indispensable tool for every cross-border worker.",
 de: "Der Vergleich KVG vs SSN hat mir fast CHF 200 im Monat gespart, indem ich die richtige Versicherung gewaehlt habe. Ein unverzichtbares Werkzeug fuer jeden Grenzgaenger.",
 fr: "La comparaison LAMal vs SSN m'a fait economiser pres de 200 CHF par mois en choisissant la bonne assurance. Outil indispensable pour chaque frontalier."
 },
 "Lo uso ogni giorno per controllare il cambio CHF/EUR e calcolare il netto in euro. Pratico e veloce, ormai è il mio punto di riferimento per le finanze da frontaliere.": {
 en: "I use it every day to check the CHF/EUR exchange rate and calculate net pay in euros. Quick and practical, it has become my reference for cross-border finances.",
 de: "Ich nutze es jeden Tag, um den CHF/EUR-Wechselkurs zu pruefen und den Nettolohn in Euro zu berechnen. Praktisch und schnell, mittlerweile mein Referenzpunkt fuer Grenzgaenger-Finanzen.",
 fr: "Je l'utilise tous les jours pour verifier le taux de change CHF/EUR et calculer le net en euros. Pratique et rapide, c'est desormais ma reference pour les finances de frontalier."
 }
};

// ─── ClaimReview lookup ────────────────────────────────────────────────

export const CLAIM_REVIEWED_TRANSLATIONS: Record<string, LocaleBundle<string>> = {
 "I frontalieri pagano le tasse due volte, sia in Svizzera che in Italia": {
 en: "Cross-border workers pay taxes twice, both in Switzerland and in Italy",
 de: "Grenzgaenger zahlen zweimal Steuern, sowohl in der Schweiz als auch in Italien",
 fr: "Les frontaliers paient les impots deux fois, en Suisse et en Italie"
 },
 "Con il nuovo accordo 2026 i frontalieri pagano più tasse": {
 en: "Under the new 2026 agreement, cross-border workers pay more taxes",
 de: "Mit dem neuen Abkommen 2026 zahlen Grenzgaenger mehr Steuern",
 fr: "Avec le nouvel accord 2026, les frontaliers paient plus d'impots"
 },
 "Il Permesso G costa meno del Permesso B": {
 en: "The G permit costs less than the B permit",
 de: "Die G-Bewilligung kostet weniger als die B-Bewilligung",
 fr: "Le permis G coute moins que le permis B"
 },
 "I frontalieri non hanno diritto alla pensione svizzera": {
 en: "Cross-border workers are not entitled to the Swiss pension",
 de: "Grenzgaenger haben keinen Anspruch auf die Schweizer Rente",
 fr: "Les frontaliers n'ont pas droit a la retraite suisse"
 },
 "La franchigia di 10.000€ è per tutti i frontalieri": {
 en: "The EUR 10,000 exemption applies to all cross-border workers",
 de: "Der Freibetrag von 10.000 EUR gilt fuer alle Grenzgaenger",
 fr: "La franchise de 10 000 EUR s'applique a tous les frontaliers"
 }
};

// Rating alternateName (verdict label).
export const CLAIM_RATING_ALTERNATE_NAME_TRANSLATIONS: Record<string, LocaleBundle<string>> = {
 "Parzialmente falso": { en: "Partly false", de: "Teilweise falsch", fr: "Partiellement faux" },
 "Dipende": { en: "It depends", de: "Kommt darauf an", fr: "Cela depend" },
 "Generalmente vero": { en: "Generally true", de: "Allgemein wahr", fr: "Generalement vrai" },
 "Falso": { en: "False", de: "Falsch", fr: "Faux" },
 "Vero": { en: "True", de: "Wahr", fr: "Vrai" }
};

// ─── Dataset lookup ────────────────────────────────────────────────────

interface DatasetTranslation {
 name?: string;
 description?: string;
 keywords?: string;
}

export const DATASET_TRANSLATIONS: Record<string, LocaleBundle<DatasetTranslation>> = {
 "Statistiche frontalieri e osservatorio offerte lavoro Ticino 2026": {
 en: {
 name: "Cross-Border Worker Statistics and Ticino Job Offers Observatory 2026",
 description: "Statistical data on Swiss-Italian cross-border workers and the Ticino job board observatory: number of G permits, active companies, locations, job offer trends and BFS 2026 statistics."
 },
 de: {
 name: "Grenzgaenger-Statistiken und Tessiner Stellenangebots-Observatorium 2026",
 description: "Statistische Daten zu Schweizer-italienischen Grenzgaengern und das Observatorium des Tessiner Job Boards: Anzahl G-Bewilligungen, aktive Unternehmen, Orte, Trends bei Stellenangeboten und BFS-Statistiken 2026."
 },
 fr: {
 name: "Statistiques frontaliers et observatoire des offres d'emploi Tessin 2026",
 description: "Donnees statistiques sur les frontaliers suisses-italiens et observatoire du job board Tessin : nombre de permis G, entreprises actives, localites, tendances des offres et statistiques BFS 2026."
 }
 },
 "Confronto Stipendi Frontalieri Svizzera-Italia 2026": {
 en: {
 name: "Cross-Border Worker Salary Comparison Switzerland-Italy 2026",
 description: "Salary database with 60 professions across 15 sectors: min-median-max range for junior, mid and senior levels. Swiss (CHF) and Italian (EUR) data for cross-border workers."
 },
 de: {
 name: "Gehaltsvergleich Grenzgaenger Schweiz-Italien 2026",
 description: "Gehaltsdatenbank mit 60 Berufen in 15 Sektoren: Min-Median-Max-Bereich fuer Junior-, Mid- und Senior-Stufen. Schweizer (CHF) und italienische (EUR) Daten fuer Grenzgaenger."
 },
 fr: {
 name: "Comparaison salariale frontaliers Suisse-Italie 2026",
 description: "Base de donnees salariale avec 60 professions dans 15 secteurs : fourchette min-mediane-max pour les niveaux junior, mid et senior. Donnees Suisse (CHF) et Italie (EUR) pour les frontaliers."
 }
 },
 "Osservatorio stipendi e lavori in Ticino": {
 en: {
 name: "Ticino Salaries and Jobs Observatory",
 description: "Daily observatory of the Frontaliere Ticino job board with posting trends, active companies, most dynamic locations and salary ranges observed in the offers."
 },
 de: {
 name: "Observatorium Loehne und Stellen im Tessin",
 description: "Taegliches Observatorium des Frontaliere Ticino Job Boards mit Ausschreibungstrends, aktiven Unternehmen, dynamischsten Orten und in den Angeboten beobachteten Gehaltsbereichen."
 },
 fr: {
 name: "Observatoire des salaires et emplois au Tessin",
 description: "Observatoire quotidien du job board Frontaliere Ticino avec les tendances des annonces, entreprises actives, localites les plus dynamiques et fourchettes salariales observees dans les offres."
 }
 },
 "Classifica Migliori Comuni di Frontiera 2026": {
 en: {
 name: "Best Border Towns Ranking 2026",
 description: "Ranking of the best Italian border towns for quality of life, services and distance from the crossing"
 },
 de: {
 name: "Rangliste der besten Grenzgemeinden 2026",
 description: "Rangliste der besten italienischen Grenzgemeinden nach Lebensqualitaet, Dienstleistungen und Entfernung vom Grenzuebergang"
 },
 fr: {
 name: "Classement des meilleures communes frontalieres 2026",
 description: "Classement des meilleures communes italiennes frontalieres pour la qualite de vie, les services et la distance du passage"
 }
 },
 "Storico Traffico Dogane Svizzera-Italia": {
 en: {
 name: "Switzerland-Italy Customs Traffic History",
 description: "Historical traffic data at border crossings between Switzerland and Italy with trends and comparisons"
 },
 de: {
 name: "Verkehrshistorie Schweizer-italienischer Zoll",
 description: "Historische Verkehrsdaten an den Grenzuebergaengen zwischen Schweiz und Italien mit Trends und Vergleichen"
 },
 fr: {
 name: "Historique du trafic aux douanes Suisse-Italie",
 description: "Donnees historiques du trafic aux passages frontaliers entre Suisse et Italie avec tendances et comparaisons"
 }
 },
 "Tasso di Disoccupazione Svizzera": {
 en: {
 name: "Swiss Unemployment Rate",
 description: "Monthly time series of the registered unemployment rate in Switzerland (SECO) from 2016"
 },
 de: {
 name: "Arbeitslosenquote Schweiz",
 description: "Monatliche Zeitreihe der registrierten Arbeitslosenquote in der Schweiz (SECO) ab 2016"
 },
 fr: {
 name: "Taux de chomage suisse",
 description: "Serie chronologique mensuelle du taux de chomage enregistre en Suisse (SECO) depuis 2016"
 }
 },
 "Prezzi benzina al confine Italia-Svizzera": {
 en: {
 name: "Gasoline prices at the Italy-Switzerland border",
 description: "Comparative dataset of gasoline prices between Italian border towns and Swiss petrol stations in the border area."
 },
 de: {
 name: "Benzinpreise an der Grenze Italien-Schweiz",
 description: "Vergleichender Datensatz der Benzinpreise zwischen italienischen Grenzgemeinden und Schweizer Tankstellen im Grenzgebiet."
 },
 fr: {
 name: "Prix de l'essence a la frontiere Italie-Suisse",
 description: "Jeu de donnees comparatif des prix de l'essence entre communes italiennes frontalieres et stations-service suisses de la zone frontaliere."
 }
 },
 "Premi cassa malati per comune svizzero": {
 en: {
 name: "Health insurance premiums by Swiss municipality",
 description: "Dataset of LAMal premiums by Swiss municipality and canton, with historical evolution and comparison across age brackets."
 },
 de: {
 name: "Krankenkassenpraemien pro Schweizer Gemeinde",
 description: "Datensatz der KVG-Praemien pro Schweizer Gemeinde und Kanton, mit historischer Entwicklung und Vergleich nach Altersgruppen."
 },
 fr: {
 name: "Primes d'assurance maladie par commune suisse",
 description: "Jeu de donnees des primes LAMal par commune et canton suisse, avec evolution historique et comparaison par tranche d'age."
 }
 },
 "Ristorni Fiscali Frontalieri per Comune": {
 en: {
 name: "Cross-Border Worker Tax Rebates by Municipality",
 description: "Statistics on tax rebates paid to Italian border municipalities"
 },
 de: {
 name: "Grenzgaenger-Steuerrueckverguetungen pro Gemeinde",
 description: "Statistiken ueber Steuerrueckverguetungen an italienische Grenzgemeinden"
 },
 fr: {
 name: "Retrocessions fiscales frontaliers par commune",
 description: "Statistiques sur les retrocessions fiscales versees aux communes italiennes frontalieres"
 }
 }
};

// ─── Helpers ───────────────────────────────────────────────────────────

function setInLanguageIfPresent(
 obj: Record<string, any>,
 locale: SupportedLocale
): void {
 if (typeof obj.inLanguage === 'string' && obj.inLanguage.length > 0) {
 obj.inLanguage = locale;
 }
}

function translateCountryNamesInPlace(
 areaServed: unknown,
 locale: SupportedLocale
): void {
 if (!Array.isArray(areaServed)) return;
 for (const area of areaServed) {
 if (!area || typeof area !== 'object') continue;
 const rec = area as Record<string, any>;
 if (rec['@type'] !== 'Country') continue;
 const name = typeof rec.name === 'string' ? rec.name : undefined;
 if (!name) continue;
 const mapped = COUNTRY_NAME_TRANSLATIONS[name];
 if (mapped) rec.name = mapped[locale];
 }
}

// ─── Translator functions ──────────────────────────────────────────────

/**
 * Translate a WebApplication schema object in place.
 * Fields: name, description. Leaves applicationCategory/operatingSystem
 * alone (they are typically schema.org enums or brand-neutral strings).
 */
export function translateWebApplication(
 obj: Record<string, any>,
 locale: SupportedLocale
): void {
 const italianName = typeof obj.name === 'string' ? obj.name : undefined;
 if (italianName) {
 const entry = WEB_APPLICATION_TRANSLATIONS[italianName];
 const tr = entry?.[locale];
 if (tr?.name) obj.name = tr.name;
 if (tr?.description && typeof obj.description === 'string') {
 obj.description = tr.description;
 }
 }
 setInLanguageIfPresent(obj, locale);
}

/**
 * Translate an Organization schema object in place.
 * The brand name ("Frontaliere Ticino", "UBS", etc.) stays, but description,
 * slogan, knowsAbout, and areaServed.name are translated.
 * Also handles the generic "Opinione comune" placeholder used for
 * ClaimReview attribution.
 */
export function translateOrganization(
 obj: Record<string, any>,
 locale: SupportedLocale
): void {
 const name = typeof obj.name === 'string' ? obj.name : undefined;
 if (name) {
 const entry = ORGANIZATION_TRANSLATIONS[name];
 const tr = entry?.[locale];
 if (tr) {
 // Only "Opinione comune" mutates the name itself (it's a label, not a brand).
 if (name === "Opinione comune" && tr.description) {
 obj.name = tr.description;
 } else if (tr.description && typeof obj.description === 'string') {
 obj.description = tr.description;
 }
 if (tr.slogan && typeof obj.slogan === 'string') obj.slogan = tr.slogan;
 if (tr.knowsAbout && Array.isArray(obj.knowsAbout)) {
 obj.knowsAbout = tr.knowsAbout;
 }
 }
 // SECO creator — translate its "name" field even though the acronym stays.
 if (name === "SECO — Segreteria di Stato dell'economia" && tr?.description) {
 obj.name = tr.description;
 }
 }
 translateCountryNamesInPlace(obj.areaServed, locale);
 setInLanguageIfPresent(obj, locale);
}

/**
 * Translate a Review schema object in place.
 * Fields: reviewBody (keyed by Italian source), name (if present).
 * Also recurses into itemReviewed when itemReviewed["@type"] has a
 * registered translator (delegation deliberately avoided to keep the
 * dispatcher as the single source of truth — callers should flatten first).
 */
export function translateReview(
 obj: Record<string, any>,
 locale: SupportedLocale
): void {
 const body = typeof obj.reviewBody === 'string' ? obj.reviewBody : undefined;
 if (body) {
 const tr = REVIEW_BODY_TRANSLATIONS[body]?.[locale];
 if (tr) obj.reviewBody = tr;
 }
 // Translate nested itemReviewed (typically a WebApplication).
 if (obj.itemReviewed && typeof obj.itemReviewed === 'object' && !Array.isArray(obj.itemReviewed)) {
 const nested = obj.itemReviewed as Record<string, any>;
 if (nested['@type'] === 'WebApplication') {
 translateWebApplication(nested, locale);
 }
 }
 setInLanguageIfPresent(obj, locale);
}

/**
 * Translate a ClaimReview schema object in place.
 * Fields: claimReviewed, reviewBody (if present), reviewRating.alternateName,
 * nested itemReviewed.author (e.g. "Opinione comune" → localised).
 */
export function translateClaimReview(
 obj: Record<string, any>,
 locale: SupportedLocale
): void {
 const claim = typeof obj.claimReviewed === 'string' ? obj.claimReviewed : undefined;
 if (claim) {
 const tr = CLAIM_REVIEWED_TRANSLATIONS[claim]?.[locale];
 if (tr) obj.claimReviewed = tr;
 }
 if (typeof obj.reviewBody === 'string') {
 const trBody = REVIEW_BODY_TRANSLATIONS[obj.reviewBody]?.[locale];
 if (trBody) obj.reviewBody = trBody;
 }
 // reviewRating.alternateName (verdict label).
 if (obj.reviewRating && typeof obj.reviewRating === 'object' && !Array.isArray(obj.reviewRating)) {
 const rating = obj.reviewRating as Record<string, any>;
 if (typeof rating.alternateName === 'string') {
 const trVerdict = CLAIM_RATING_ALTERNATE_NAME_TRANSLATIONS[rating.alternateName]?.[locale];
 if (trVerdict) rating.alternateName = trVerdict;
 }
 }
 // itemReviewed is typically { "@type": "Claim", "author": { "@type": "Organization", "name": "Opinione comune" } }.
 if (obj.itemReviewed && typeof obj.itemReviewed === 'object' && !Array.isArray(obj.itemReviewed)) {
 const item = obj.itemReviewed as Record<string, any>;
 if (item.author && typeof item.author === 'object' && !Array.isArray(item.author)) {
 translateOrganization(item.author as Record<string, any>, locale);
 }
 }
 setInLanguageIfPresent(obj, locale);
}

/**
 * Translate a Dataset schema object in place.
 * Fields: name, description, keywords. Also recurses into creator
 * (Organization).
 */
export function translateDataset(
 obj: Record<string, any>,
 locale: SupportedLocale
): void {
 const name = typeof obj.name === 'string' ? obj.name : undefined;
 if (name) {
 const entry = DATASET_TRANSLATIONS[name];
 const tr = entry?.[locale];
 if (tr?.name) obj.name = tr.name;
 if (tr?.description && typeof obj.description === 'string') {
 obj.description = tr.description;
 }
 if (tr?.keywords && typeof obj.keywords === 'string') {
 obj.keywords = tr.keywords;
 }
 }
 // Translate nested creator (Organization).
 if (obj.creator && typeof obj.creator === 'object' && !Array.isArray(obj.creator)) {
 const creator = obj.creator as Record<string, any>;
 if (creator['@type'] === 'Organization') {
 translateOrganization(creator, locale);
 }
 }
 setInLanguageIfPresent(obj, locale);
}
