// Page-level structured data translations for CollectionPage, ItemList, WebPage,
// AboutPage and ContactPage schemas rendered on localized pages.
//
// Each translator mirrors the pattern established by ./howto-translations and
// ./faq-translations: lookup by Italian "name" -> { en, de, fr } translation,
// mutate the clone in place, silent fallback if no translation exists.
//
// Used by the ./schema-translators dispatcher (which in turn is called from
// services/seoService.ts and build-plugins/staticPagesPlugin.ts).

type Lang = 'en' | 'de' | 'fr';

interface BasicSchemaTranslation {
 name: string;
 description?: string;
}

type BasicLocaleMap = Record<string, { en: BasicSchemaTranslation; de: BasicSchemaTranslation; fr: BasicSchemaTranslation }>;

interface ItemListTranslation {
 name: string;
 description?: string;
 /** Translations of `itemListElement[].name` keyed by Italian child name. */
 children?: Record<string, { en: string; de: string; fr: string }>;
}

type ItemListLocaleMap = Record<string, { en: ItemListTranslation; de: ItemListTranslation; fr: ItemListTranslation }>;

// ───────────────────────────────────────────────────────────────────────────
// CollectionPage translations
// ───────────────────────────────────────────────────────────────────────────

export const COLLECTION_PAGE_TRANSLATIONS: BasicLocaleMap = {
 "Comparatori Servizi Frontalieri": {
 en: { name: "Cross-Border Worker Service Comparators", description: "Comparison tools for essential services for cross-border workers" },
 de: { name: "Vergleichstools fuer Grenzgaengerdienste", description: "Vergleichstools fuer wesentliche Dienstleistungen fuer Grenzgaenger" },
 fr: { name: "Comparateurs de services pour frontaliers", description: "Outils de comparaison des services essentiels pour les frontaliers" }
 },
 "Calcolatore Stipendio Frontaliere": {
 en: { name: "Cross-Border Worker Salary Calculator", description: "Collection of calculation tools for cross-border workers Switzerland-Italy" },
 de: { name: "Grenzgaenger-Gehaltsrechner", description: "Sammlung von Berechnungstools fuer Grenzgaenger Schweiz-Italien" },
 fr: { name: "Calculateur de salaire frontalier", description: "Collection d'outils de calcul pour les frontaliers Suisse-Italie" }
 },
 "Guida Frontaliere Svizzera-Italia": {
 en: { name: "Cross-Border Worker Guide Switzerland-Italy", description: "Complete guide for cross-border workers between Switzerland and Italy" },
 de: { name: "Grenzgaenger-Leitfaden Schweiz-Italien", description: "Umfassender Leitfaden fuer Grenzgaenger zwischen der Schweiz und Italien" },
 fr: { name: "Guide du frontalier Suisse-Italie", description: "Guide complet pour les frontaliers entre la Suisse et l'Italie" }
 },
 "Fisco e Previdenza Frontalieri": {
 en: { name: "Cross-Border Worker Tax and Pension", description: "Tools and guides on tax and pensions for cross-border workers Switzerland-Italy" },
 de: { name: "Steuern und Vorsorge fuer Grenzgaenger", description: "Tools und Leitfaeden zu Steuern und Vorsorge fuer Grenzgaenger Schweiz-Italien" },
 fr: { name: "Fiscalite et prevoyance pour frontaliers", description: "Outils et guides sur la fiscalite et la prevoyance pour frontaliers Suisse-Italie" }
 },
 "Vita in Ticino per Frontalieri": {
 en: { name: "Life in Ticino for Cross-Border Workers", description: "Guides and tools on daily life in Ticino for cross-border workers" },
 de: { name: "Leben im Tessin fuer Grenzgaenger", description: "Leitfaeden und Tools zum Alltag im Tessin fuer Grenzgaenger" },
 fr: { name: "Vivre au Tessin pour les frontaliers", description: "Guides et outils sur la vie quotidienne au Tessin pour les frontaliers" }
 },
 "Aziende che Assumono in Ticino": {
 en: { name: "Companies Hiring in Ticino", description: "Main companies hiring cross-border workers in Canton Ticino: technology, finance, pharmaceutical, industry and services" },
 de: { name: "Unternehmen, die im Tessin einstellen", description: "Wichtigste Unternehmen, die Grenzgaenger im Kanton Tessin einstellen: Technologie, Finanzen, Pharmazie, Industrie und Dienstleistungen" },
 fr: { name: "Entreprises qui recrutent au Tessin", description: "Principales entreprises qui recrutent des frontaliers au Canton Tessin: technologie, finance, pharmaceutique, industrie et services" }
 },
 "Offerte di Lavoro in Ticino": {
 en: { name: "Job Offers in Ticino", description: "Job board with over 1500 up-to-date offers for cross-border workers in Ticino. Positions in various sectors: technology, finance, pharmaceutical, healthcare, industry." },
 de: { name: "Stellenangebote im Tessin", description: "Stellenboerse mit ueber 1500 aktuellen Angeboten fuer Grenzgaenger im Tessin. Positionen in verschiedenen Branchen: Technologie, Finanzen, Pharmazie, Gesundheitswesen, Industrie." },
 fr: { name: "Offres d'emploi au Tessin", description: "Plateforme de recrutement avec plus de 1500 offres a jour pour les frontaliers au Tessin. Postes dans divers secteurs: technologie, finance, pharmaceutique, sante, industrie." }
 },
 "Dialetto Ticinese — Espressioni e Proverbi": {
 en: { name: "Ticinese Dialect — Expressions and Proverbs", description: "Collection of 64 expressions, proverbs and words from the Ticinese dialect for cross-border workers" },
 de: { name: "Tessiner Dialekt — Ausdruecke und Sprichwoerter", description: "Sammlung von 64 Ausdruecken, Sprichwoertern und Woertern aus dem Tessiner Dialekt fuer Grenzgaenger" },
 fr: { name: "Dialecte tessinois — Expressions et proverbes", description: "Collection de 64 expressions, proverbes et mots du dialecte tessinois pour les frontaliers" }
 },
 "Mappa del Sito — Frontaliere Ticino": {
 en: { name: "Sitemap — Frontaliere Ticino", description: "Complete index of all tools, calculators, guides and resources for cross-border workers Switzerland-Italy." },
 de: { name: "Sitemap — Frontaliere Ticino", description: "Vollstaendiges Verzeichnis aller Tools, Rechner, Leitfaeden und Ressourcen fuer Grenzgaenger Schweiz-Italien." },
 fr: { name: "Plan du site — Frontaliere Ticino", description: "Index complet de tous les outils, calculateurs, guides et ressources pour frontaliers Suisse-Italie." }
 },
 "Servizi Partner per Frontalieri": {
 en: { name: "Partner Services for Cross-Border Workers", description: "Collection of professional services selected for cross-border workers" },
 de: { name: "Partnerdienstleistungen fuer Grenzgaenger", description: "Auswahl professioneller Dienstleistungen fuer Grenzgaenger" },
 fr: { name: "Services partenaires pour frontaliers", description: "Selection de services professionnels pour les frontaliers" }
 },
 "Articoli per Frontalieri": {
 en: { name: "Articles for Cross-Border Workers", description: "Collection of practical articles and guides for cross-border workers Switzerland-Italy" },
 de: { name: "Artikel fuer Grenzgaenger", description: "Sammlung praktischer Artikel und Leitfaeden fuer Grenzgaenger Schweiz-Italien" },
 fr: { name: "Articles pour frontaliers", description: "Collection d'articles et guides pratiques pour frontaliers Suisse-Italie" }
 },
 "Sindacati per Frontalieri in Svizzera": {
 en: { name: "Unions for Cross-Border Workers in Switzerland", description: "Guide to the main Swiss unions for cross-border workers: UNIA, Syndicom, SEV, OCST. Costs, services and Ticino contacts." },
 de: { name: "Gewerkschaften fuer Grenzgaenger in der Schweiz", description: "Leitfaden zu den wichtigsten Schweizer Gewerkschaften fuer Grenzgaenger: UNIA, Syndicom, SEV, OCST. Kosten, Leistungen und Tessiner Kontakte." },
 fr: { name: "Syndicats pour les frontaliers en Suisse", description: "Guide des principaux syndicats suisses pour les frontaliers: UNIA, Syndicom, SEV, OCST. Couts, services et contacts au Tessin." }
 }
};

// ───────────────────────────────────────────────────────────────────────────
// ItemList translations (with nested child element translations)
// ───────────────────────────────────────────────────────────────────────────

export const ITEM_LIST_TRANSLATIONS: ItemListLocaleMap = {
 "Strumenti di confronto frontalieri": {
 en: {
 name: "Cross-border worker comparison tools",
 children: {
 "Cambio Valuta CHF/EUR": { en: "CHF/EUR Currency Exchange", de: "CHF/EUR Waehrungstausch", fr: "Change CHF/EUR" },
 "Operatori Mobili": { en: "Mobile Operators", de: "Mobilfunkanbieter", fr: "Operateurs mobiles" },
 "Assicurazioni Sanitarie LAMal": { en: "LAMal Health Insurance", de: "LAMal Krankenversicherungen", fr: "Assurance maladie LAMal" },
 "Confronto Banche CH-IT": { en: "CH-IT Bank Comparison", de: "Bankenvergleich CH-IT", fr: "Comparaison banques CH-IT" },
 "Spesa Transfrontaliera": { en: "Cross-Border Shopping", de: "Grenzueberschreitender Einkauf", fr: "Courses transfrontalieres" },
 "Costo della Vita": { en: "Cost of Living", de: "Lebenshaltungskosten", fr: "Cout de la vie" },
 "Confronto Offerte Lavoro": { en: "Job Offer Comparison", de: "Vergleich von Stellenangeboten", fr: "Comparaison d'offres d'emploi" },
 "Bonus Ristrutturazione": { en: "Renovation Bonus", de: "Renovierungsbonus", fr: "Bonus de renovation" }
 }
 },
 de: { name: "Vergleichstools fuer Grenzgaenger", children: {} },
 fr: { name: "Outils de comparaison pour frontaliers", children: {} }
 },
 "Strumenti di calcolo frontalieri": {
 en: {
 name: "Cross-border worker calculation tools",
 children: {
 "Confronto RAL CH-IT": { en: "CH-IT Gross Salary Comparison", de: "Bruttolohnvergleich CH-IT", fr: "Comparaison salaire brut CH-IT" },
 "Simula Busta Paga": { en: "Pay Slip Simulator", de: "Lohnabrechnung simulieren", fr: "Simulateur de fiche de paie" },
 "Stima Bonus": { en: "Bonus Estimate", de: "Bonus-Schaetzung", fr: "Estimation du bonus" },
 "Congedo Parentale": { en: "Parental Leave", de: "Elternurlaub", fr: "Conge parental" },
 "Permesso G vs B": { en: "G Permit vs B Permit", de: "G-Bewilligung vs B-Bewilligung", fr: "Permis G vs B" },
 "What-If Simulator": { en: "What-If Simulator", de: "Was-waere-wenn-Simulator", fr: "Simulateur Que se passerait-il" },
 "Cambio Residenza": { en: "Residence Change", de: "Wohnsitzwechsel", fr: "Changement de residence" },
 "Quanto Guadagneresti": { en: "How Much Would You Earn", de: "Wie viel wuerden Sie verdienen", fr: "Combien gagneriez-vous" }
 }
 },
 de: { name: "Berechnungstools fuer Grenzgaenger", children: {} },
 fr: { name: "Outils de calcul pour frontaliers", children: {} }
 },
 "Guide per frontalieri": {
 en: {
 name: "Cross-border worker guides",
 children: {
 "Permessi di Lavoro G e B": { en: "G and B Work Permits", de: "Arbeitsbewilligungen G und B", fr: "Permis de travail G et B" },
 "Tempi Attesa Dogana": { en: "Customs Waiting Times", de: "Wartezeiten am Zoll", fr: "Temps d'attente a la douane" },
 "Primo Giorno di Lavoro": { en: "First Day at Work", de: "Erster Arbeitstag", fr: "Premier jour de travail" },
 "Trasferire Auto in Svizzera": { en: "Transferring Your Car to Switzerland", de: "Auto in die Schweiz ueberfuehren", fr: "Transferer votre voiture en Suisse" },
 "Disoccupazione Transfrontaliera": { en: "Cross-Border Unemployment", de: "Grenzueberschreitende Arbeitslosigkeit", fr: "Chomage transfrontalier" },
 "Mappa Comuni di Frontiera": { en: "Border Municipalities Map", de: "Karte der Grenzgemeinden", fr: "Carte des communes frontalieres" },
 "Costo Auto Pendolare": { en: "Commuter Car Cost", de: "Kosten fuer Pendlerauto", fr: "Cout de la voiture pour navetteurs" }
 }
 },
 de: { name: "Leitfaeden fuer Grenzgaenger", children: {} },
 fr: { name: "Guides pour frontaliers", children: {} }
 },
 "Strumenti fiscali e previdenziali": {
 en: {
 name: "Tax and pension tools",
 children: {
 "Dichiarazione Redditi": { en: "Income Tax Return", de: "Steuererklaerung", fr: "Declaration de revenus" },
 "Ristorni Fiscali": { en: "Tax Refunds (Ristorni)", de: "Steuerrueckerstattungen (Ristorni)", fr: "Retrocessions fiscales (ristorni)" },
 "Calendario Scadenze": { en: "Tax Deadlines Calendar", de: "Steuertermine-Kalender", fr: "Calendrier des echeances fiscales" },
 "Pianificatore Pensione AVS/LPP": { en: "AVS/LPP Pension Planner", de: "AHV/BVG-Rentenplaner", fr: "Planificateur de retraite AVS/LPP" },
 "Simulatore Terzo Pilastro 3a": { en: "Pillar 3a Simulator", de: "Saeule-3a-Simulator", fr: "Simulateur troisieme pilier 3a" },
 "Quiz Fiscale": { en: "Tax Quiz", de: "Steuerquiz", fr: "Quiz fiscal" },
 "Festività Ticino": { en: "Ticino Public Holidays", de: "Tessiner Feiertage", fr: "Jours feries du Tessin" },
 "Credito d'Imposta": { en: "Tax Credit", de: "Steuergutschrift", fr: "Credit d'impot" }
 }
 },
 de: { name: "Steuer- und Vorsorgetools", children: {} },
 fr: { name: "Outils fiscaux et de prevoyance", children: {} }
 },
 "Strumenti collegati imposta alla fonte Ticino 2026": {
 en: {
 name: "Related tools for Ticino withholding tax 2026",
 children: {
 "Simulatore netto frontalieri": { en: "Cross-border worker net salary simulator", de: "Netto-Simulator fuer Grenzgaenger", fr: "Simulateur net pour frontaliers" },
 "Simula busta paga": { en: "Pay slip simulator", de: "Lohnabrechnung simulieren", fr: "Simulateur de fiche de paie" },
 "Credito d'imposta": { en: "Tax credit", de: "Steuergutschrift", fr: "Credit d'impot" },
 "Dichiarazione fiscale svizzera": { en: "Swiss tax return", de: "Schweizer Steuererklaerung", fr: "Declaration fiscale suisse" }
 }
 },
 de: { name: "Verbundene Tools zur Quellensteuer Tessin 2026", children: {} },
 fr: { name: "Outils lies a l'impot a la source Tessin 2026", children: {} }
 },
 "Guide vita in Ticino": {
 en: {
 name: "Life in Ticino guides",
 children: {
 "Trasporti Frontalieri": { en: "Cross-Border Worker Transport", de: "Verkehr fuer Grenzgaenger", fr: "Transports pour frontaliers" },
 "Vivere in Svizzera": { en: "Living in Switzerland", de: "Leben in der Schweiz", fr: "Vivre en Suisse" },
 "Vivere in Italia": { en: "Living in Italy", de: "Leben in Italien", fr: "Vivre en Italie" },
 "Aziende Svizzera Italiana": { en: "Italian-Swiss Companies", de: "Italienischsprachige Schweizer Unternehmen", fr: "Entreprises de Suisse italienne" },
 "Scuole Svizzera Italiana": { en: "Italian-Swiss Schools", de: "Italienischsprachige Schweizer Schulen", fr: "Ecoles de Suisse italienne" },
 "Attrazioni Ticino": { en: "Ticino Attractions", de: "Tessiner Attraktionen", fr: "Attractions du Tessin" },
 "Confronta Asili Nido": { en: "Compare Nurseries", de: "Kitas vergleichen", fr: "Comparer les creches" },
 "Comuni di Frontiera": { en: "Border Municipalities", de: "Grenzgemeinden", fr: "Communes frontalieres" }
 }
 },
 de: { name: "Leitfaeden zum Leben im Tessin", children: {} },
 fr: { name: "Guides sur la vie au Tessin", children: {} }
 },
 "Aziende principali in Ticino": {
 en: { name: "Main companies in Ticino" },
 de: { name: "Hauptunternehmen im Tessin" },
 fr: { name: "Principales entreprises du Tessin" }
 },
 "Comuni Italiani di Frontiera": {
 en: { name: "Italian Border Municipalities", description: "List of Italian municipalities in the border zone with Switzerland" },
 de: { name: "Italienische Grenzgemeinden", description: "Liste der italienischen Gemeinden im Grenzgebiet zur Schweiz" },
 fr: { name: "Communes frontalieres italiennes", description: "Liste des communes italiennes dans la zone frontaliere avec la Suisse" }
 },
 "Scuole in Ticino per Frontalieri": {
 en: { name: "Schools in Ticino for Cross-Border Workers", description: "Complete list of schools in Canton Ticino: nurseries, kindergartens, primary, middle and secondary schools" },
 de: { name: "Schulen im Tessin fuer Grenzgaenger", description: "Vollstaendige Liste der Schulen im Kanton Tessin: Kitas, Kindergaerten, Primar-, Sekundar- und Mittelschulen" },
 fr: { name: "Ecoles au Tessin pour frontaliers", description: "Liste complete des ecoles du Canton Tessin: creches, ecoles enfantines, primaires, moyennes et secondaires" }
 },
 "Servizi Dashboard Mattutino": {
 en: {
 name: "Morning Dashboard Services",
 children: {
 "Meteo in tempo reale Lugano e Como": { en: "Real-time weather Lugano and Como", de: "Echtzeitwetter Lugano und Como", fr: "Meteo en temps reel Lugano et Como" },
 "Traffico valichi di frontiera": { en: "Border crossing traffic", de: "Grenzuebergangsverkehr", fr: "Trafic aux postes frontieres" },
 "Tasso di cambio CHF-EUR": { en: "CHF-EUR exchange rate", de: "CHF-EUR-Wechselkurs", fr: "Taux de change CHF-EUR" }
 }
 },
 de: { name: "Dienste des Morgen-Dashboards", children: {} },
 fr: { name: "Services du tableau de bord du matin", children: {} }
 },
 "Offerte di Lavoro in Canton Ticino": {
 en: {
 name: "Job offers in Canton Ticino",
 description: "Up-to-date list of job offers in Canton Ticino for Italian cross-border workers",
 children: {
 "Lavoro Lugano": { en: "Jobs in Lugano", de: "Jobs in Lugano", fr: "Emplois a Lugano" },
 "Lavoro Mendrisio": { en: "Jobs in Mendrisio", de: "Jobs in Mendrisio", fr: "Emplois a Mendrisio" },
 "Lavoro Bellinzona": { en: "Jobs in Bellinzona", de: "Jobs in Bellinzona", fr: "Emplois a Bellinzona" },
 "Lavoro Locarno": { en: "Jobs in Locarno", de: "Jobs in Locarno", fr: "Emplois a Locarno" },
 "Lavoro Chiasso": { en: "Jobs in Chiasso", de: "Jobs in Chiasso", fr: "Emplois a Chiasso" }
 }
 },
 de: { name: "Stellenangebote im Kanton Tessin", description: "Aktuelle Liste von Stellenangeboten im Kanton Tessin fuer italienische Grenzgaenger", children: {} },
 fr: { name: "Offres d'emploi au Canton Tessin", description: "Liste a jour des offres d'emploi au Canton Tessin pour les frontaliers italiens", children: {} }
 },
 "Asili Nido nel Canton Ticino": {
 en: { name: "Nurseries in Canton Ticino", description: "List of nurseries in Canton Ticino with costs, schedules and availability" },
 de: { name: "Kitas im Kanton Tessin", description: "Liste der Kitas im Kanton Tessin mit Kosten, Oeffnungszeiten und Verfuegbarkeit" },
 fr: { name: "Creches au Canton Tessin", description: "Liste des creches au Canton Tessin avec couts, horaires et disponibilite" }
 },
 "Articoli Frontaliere": {
 en: { name: "Cross-Border Worker Articles" },
 de: { name: "Grenzgaenger-Artikel" },
 fr: { name: "Articles pour frontaliers" }
 }
};

// ───────────────────────────────────────────────────────────────────────────
// WebPage translations
// ───────────────────────────────────────────────────────────────────────────

export const WEB_PAGE_TRANSLATIONS: BasicLocaleMap = {
 "Aliquote imposta alla fonte Ticino 2026": {
 en: { name: "Ticino Withholding Tax Rates 2026", description: "Practical guide to tables A, B, C and H of Ticino for cross-border workers with tax rate examples, FAQ and links to fiscal simulators." },
 de: { name: "Quellensteuertarife Tessin 2026", description: "Praktischer Leitfaden zu den Tarifen A, B, C und H des Tessins fuer Grenzgaenger mit Tarifbeispielen, FAQ und Links zu Steuersimulatoren." },
 fr: { name: "Taux d'impot a la source Tessin 2026", description: "Guide pratique aux baremes A, B, C et H du Tessin pour frontaliers avec exemples, FAQ et liens vers les simulateurs fiscaux." }
 },
 "Statistiche frontalieri e osservatorio lavoro Ticino 2026": {
 en: { name: "Cross-Border Worker Statistics and Ticino Job Observatory 2026", description: "Statistical data on cross-border workers and Ticino job board observatory with companies, locations and offer trends" },
 de: { name: "Grenzgaengerstatistiken und Tessiner Arbeitsmarktbeobachtung 2026", description: "Statistische Daten zu Grenzgaengern und Beobachtungsstelle der Tessiner Stellenboerse mit Unternehmen, Standorten und Stellentrends" },
 fr: { name: "Statistiques des frontaliers et observatoire du travail Tessin 2026", description: "Donnees statistiques sur les frontaliers et observatoire de la plateforme d'emploi du Tessin avec entreprises, localites et tendances des offres" }
 },
 "Aiutaci a Migliorare - Segnalazioni e Suggerimenti": {
 en: { name: "Help Us Improve - Reports and Suggestions", description: "Report bugs and suggest features for the Switzerland-Italy cross-border worker tax simulator on GitHub" },
 de: { name: "Helfen Sie uns, besser zu werden - Meldungen und Vorschlaege", description: "Melden Sie Fehler und schlagen Sie Funktionen fuer den Grenzgaenger-Steuersimulator Schweiz-Italien auf GitHub vor" },
 fr: { name: "Aidez-nous a nous ameliorer - Signalements et suggestions", description: "Signalez des bugs et suggerez des fonctionnalites pour le simulateur fiscal frontaliers Suisse-Italie sur GitHub" }
 },
 "Newsletter Frontalieri": {
 en: { name: "Cross-Border Worker Newsletter", description: "Weekly newsletter for cross-border workers with CHF/EUR exchange rate, border traffic and tax news" },
 de: { name: "Grenzgaenger-Newsletter", description: "Woechentlicher Newsletter fuer Grenzgaenger mit CHF/EUR-Wechselkurs, Grenzverkehr und Steuernachrichten" },
 fr: { name: "Newsletter frontaliers", description: "Newsletter hebdomadaire pour les frontaliers avec taux de change CHF/EUR, trafic aux frontieres et actualites fiscales" }
 },
 "Previsioni Meteo Lugano e Como per Frontalieri": {
 en: { name: "Weather Forecast Lugano and Como for Cross-Border Workers", description: "Real-time weather forecasts for Lugano (CH) and Como (IT): temperature, humidity, wind, sunrise and sunset" },
 de: { name: "Wettervorhersage Lugano und Como fuer Grenzgaenger", description: "Echtzeit-Wettervorhersagen fuer Lugano (CH) und Como (IT): Temperatur, Luftfeuchtigkeit, Wind, Sonnenauf- und -untergang" },
 fr: { name: "Previsions meteo Lugano et Como pour frontaliers", description: "Previsions meteo en temps reel pour Lugano (CH) et Como (IT): temperature, humidite, vent, lever et coucher du soleil" }
 },
 "Community Frontalieri": {
 en: { name: "Cross-Border Worker Community", description: "Cross-border worker community forum: questions and answers on taxes, permits, insurance" },
 de: { name: "Grenzgaenger-Community", description: "Community-Forum fuer Grenzgaenger: Fragen und Antworten zu Steuern, Bewilligungen, Versicherungen" },
 fr: { name: "Communaute des frontaliers", description: "Forum de la communaute des frontaliers: questions et reponses sur taxes, permis, assurances" }
 },
 "Digest Settimanale Frontaliere": {
 en: { name: "Cross-Border Worker Weekly Digest", description: "Weekly digest with essential information for cross-border workers: exchange rate, articles, tools and job offers." },
 de: { name: "Woechentliche Grenzgaenger-Zusammenfassung", description: "Woechentliche Zusammenfassung mit wesentlichen Informationen fuer Grenzgaenger: Wechselkurs, Artikel, Tools und Stellenangebote." },
 fr: { name: "Digest hebdomadaire frontalier", description: "Digest hebdomadaire avec informations essentielles pour les frontaliers: taux de change, articles, outils et offres d'emploi." }
 },
 "Strumento della Settimana per Frontalieri": {
 en: { name: "Tool of the Week for Cross-Border Workers", description: "Every week a different tool for cross-border workers: salary calculators, insurance comparators, pension simulators and more." },
 de: { name: "Tool der Woche fuer Grenzgaenger", description: "Jede Woche ein anderes Tool fuer Grenzgaenger: Gehaltsrechner, Versicherungsvergleiche, Rentensimulatoren und mehr." },
 fr: { name: "Outil de la semaine pour frontaliers", description: "Chaque semaine un outil different pour les frontaliers: calculateurs de salaire, comparateurs d'assurance, simulateurs de retraite et plus." }
 },
 "Gamification Frontaliere": {
 en: { name: "Cross-Border Worker Gamification", description: "Gamification system with levels, goals and XP points for cross-border workers" },
 de: { name: "Grenzgaenger-Gamification", description: "Gamification-System mit Leveln, Zielen und XP-Punkten fuer Grenzgaenger" },
 fr: { name: "Gamification pour frontaliers", description: "Systeme de gamification avec niveaux, objectifs et points XP pour frontaliers" }
 },
 "Privacy Policy": {
 en: { name: "Privacy Policy", description: "Privacy policy of Frontaliere Ticino" },
 de: { name: "Datenschutzerklaerung", description: "Datenschutzerklaerung von Frontaliere Ticino" },
 fr: { name: "Politique de confidentialite", description: "Politique de confidentialite de Frontaliere Ticino" }
 },
 "Termini di Servizio": {
 en: { name: "Terms of Service", description: "Terms and conditions of use of Frontaliere Ticino" },
 de: { name: "Nutzungsbedingungen", description: "Nutzungsbedingungen von Frontaliere Ticino" },
 fr: { name: "Conditions d'utilisation", description: "Conditions generales d'utilisation de Frontaliere Ticino" }
 },
 "Benvenuto Frontaliere": {
 en: { name: "Welcome Cross-Border Worker", description: "Welcome page for new subscribers to the Frontaliere Ticino newsletter" },
 de: { name: "Willkommen Grenzgaenger", description: "Willkommensseite fuer neue Abonnenten des Frontaliere Ticino Newsletters" },
 fr: { name: "Bienvenue frontalier", description: "Page de bienvenue pour les nouveaux abonnes a la newsletter de Frontaliere Ticino" }
 },
 "Eliminazione Dati Personali": {
 en: { name: "Personal Data Deletion", description: "Procedure to request deletion of personal data" },
 de: { name: "Loeschung personenbezogener Daten", description: "Verfahren zur Beantragung der Loeschung personenbezogener Daten" },
 fr: { name: "Suppression des donnees personnelles", description: "Procedure pour demander la suppression des donnees personnelles" }
 },
 "Stato dei Servizi API": {
 en: { name: "API Services Status", description: "Real-time status of the API services used by Frontaliere Ticino" },
 de: { name: "Status der API-Dienste", description: "Echtzeitstatus der von Frontaliere Ticino verwendeten API-Dienste" },
 fr: { name: "Statut des services API", description: "Statut en temps reel des services API utilises par Frontaliere Ticino" }
 },
 "Privacy Policy — Frontaliere Ticino": {
 en: { name: "Privacy Policy — Frontaliere Ticino", description: "Privacy policy of Frontaliere Ticino" },
 de: { name: "Datenschutzerklaerung — Frontaliere Ticino", description: "Datenschutzerklaerung von Frontaliere Ticino" },
 fr: { name: "Politique de confidentialite — Frontaliere Ticino", description: "Politique de confidentialite de Frontaliere Ticino" }
 }
};

// ───────────────────────────────────────────────────────────────────────────
// AboutPage translations
// ───────────────────────────────────────────────────────────────────────────

export const ABOUT_PAGE_TRANSLATIONS: BasicLocaleMap = {
 "Chi Siamo — Frontaliere Ticino": {
 en: { name: "About Us — Frontaliere Ticino", description: "Information platform for Italian cross-border workers in Switzerland" },
 de: { name: "Ueber uns — Frontaliere Ticino", description: "Informationsplattform fuer italienische Grenzgaenger in der Schweiz" },
 fr: { name: "A propos — Frontaliere Ticino", description: "Plateforme d'information pour les frontaliers italiens en Suisse" }
 },
 "About Us — Frontaliere Ticino": {
 en: { name: "About Us — Frontaliere Ticino", description: "Frontaliere Ticino is the leading platform for Italian cross-border workers in Switzerland" },
 de: { name: "Ueber uns — Frontaliere Ticino", description: "Frontaliere Ticino ist die fuehrende Plattform fuer italienische Grenzgaenger in der Schweiz" },
 fr: { name: "A propos — Frontaliere Ticino", description: "Frontaliere Ticino est la plateforme de reference pour les frontaliers italiens en Suisse" }
 }
};

// ───────────────────────────────────────────────────────────────────────────
// ContactPage translations
// ───────────────────────────────────────────────────────────────────────────

export const CONTACT_PAGE_TRANSLATIONS: BasicLocaleMap = {
 "Contatti Frontaliere Ticino": {
 en: { name: "Contact Frontaliere Ticino", description: "Contact page for Frontaliere Ticino service" },
 de: { name: "Kontakt Frontaliere Ticino", description: "Kontaktseite fuer den Frontaliere Ticino Service" },
 fr: { name: "Contact Frontaliere Ticino", description: "Page de contact pour le service Frontaliere Ticino" }
 },
 "Contact Frontaliere Ticino": {
 en: { name: "Contact Frontaliere Ticino", description: "Contact page for Frontaliere Ticino cross-border workers platform" },
 de: { name: "Kontakt Frontaliere Ticino", description: "Kontaktseite der Frontaliere Ticino Grenzgaenger-Plattform" },
 fr: { name: "Contact Frontaliere Ticino", description: "Page de contact de la plateforme Frontaliere Ticino pour les frontaliers" }
 }
};

// ───────────────────────────────────────────────────────────────────────────
// Translators
// ───────────────────────────────────────────────────────────────────────────

function applyBasic(
 obj: Record<string, any>,
 table: BasicLocaleMap,
 locale: Lang
): void {
 if (!obj || typeof obj.name !== 'string') return;
 const entry = table[obj.name];
 const translation = entry?.[locale];
 if (!translation) return;
 obj.name = translation.name;
 if (translation.description !== undefined && typeof obj.description === 'string') {
 obj.description = translation.description;
 }
 if (typeof obj.inLanguage === 'string') obj.inLanguage = locale;
}

/**
 * Translate a CollectionPage JSON-LD object in place.
 * Silent fallback: if no translation is found, the object is left in Italian.
 */
export function translateCollectionPage(obj: Record<string, any>, locale: Lang): void {
 applyBasic(obj, COLLECTION_PAGE_TRANSLATIONS, locale);
 // Some CollectionPages embed an ItemList via `mainEntity` — translate it too.
 if (obj && obj.mainEntity && typeof obj.mainEntity === 'object' && obj.mainEntity['@type'] === 'ItemList') {
 translateItemList(obj.mainEntity, locale);
 }
}

/**
 * Translate a WebPage JSON-LD object in place.
 */
export function translateWebPage(obj: Record<string, any>, locale: Lang): void {
 applyBasic(obj, WEB_PAGE_TRANSLATIONS, locale);
}

/**
 * Translate an AboutPage JSON-LD object in place.
 */
export function translateAboutPage(obj: Record<string, any>, locale: Lang): void {
 applyBasic(obj, ABOUT_PAGE_TRANSLATIONS, locale);
}

/**
 * Translate a ContactPage JSON-LD object in place.
 */
export function translateContactPage(obj: Record<string, any>, locale: Lang): void {
 applyBasic(obj, CONTACT_PAGE_TRANSLATIONS, locale);
}

/**
 * Translate an ItemList JSON-LD object in place, including any child
 * `itemListElement[].name` entries that have a dedicated translation.
 *
 * - Never touches ListItems whose `.name` lives on a nested `.item`
 * (e.g. Organizations, Cities, EducationalOrganizations) — those are
 * proper nouns and must stay intact.
 * - ItemLists without a top-level `name` (anonymous lists embedded in
 * CollectionPages) still get their children translated if we can match
 * the list by shape via parent dispatch; standalone anonymous lists fall
 * back silently.
 */
export function translateItemList(obj: Record<string, any>, locale: Lang): void {
 if (!obj) return;
 const italianName = typeof obj.name === 'string' ? obj.name : undefined;
 const entry = italianName ? ITEM_LIST_TRANSLATIONS[italianName] : undefined;
 const translation = entry?.[locale];

 if (translation) {
 obj.name = translation.name;
 if (translation.description !== undefined && typeof obj.description === 'string') {
 obj.description = translation.description;
 }
 }
 if (typeof obj.inLanguage === 'string') obj.inLanguage = locale;

 if (!Array.isArray(obj.itemListElement)) return;

 // Pick the English child map as the source of child keys (canonical).
 const childMapEn = entry?.en.children;
 if (!childMapEn) return;

 for (const element of obj.itemListElement) {
 if (!element || typeof element !== 'object') continue;
 // Skip elements whose name lives inside a nested `.item` (proper nouns).
 if (element.item && typeof element.item === 'object' && typeof element.item.name === 'string') continue;
 if (typeof element.name !== 'string') continue;
 const childTranslations = childMapEn[element.name];
 if (childTranslations) {
 element.name = childTranslations[locale];
 }
 }
}
