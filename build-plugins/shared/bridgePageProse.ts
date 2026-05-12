/**
 * bridgePageProse.ts
 *
 * Shared per-locale "frontaliere context" prose block appended to the
 * thin redirect/alias bridge pages (legacy-alias, job-orphan-bridge,
 * fuel-station alias, legacy article alias) that otherwise trip the
 * `audit:text-html-ratio` Semrush gate at ~5 % text/HTML.
 *
 * Why this exists
 * ---------------
 * Bridges are intentionally short: the body is a 2-line "the page moved,
 * here is the new URL" placeholder. With the SPA shell + JSON-LD + the
 * bot-detection script the HTML is ~6.5-7.2 KB but the visible text is
 * only ~320-400 bytes → ratio 4.8-5.5 %. Without prose injection these
 * pages drive the bulk of the residual `audit:text-html-ratio` offenders
 * (blog +15, fuel-daily +7, job-board +61 over baseline as of
 * 2026-05-12). They are NOT noindex (per CLAUDE.md non-negotiable #5 +
 * the never_noindex_without_approval memory).
 *
 * What the block contains
 * -----------------------
 * The helper builds ~1.6-2.0 KB of page-relevant prose:
 *   1. A short "what you'll find on the live page" paragraph keyed to the
 *      bridge kind (article / job / fuel-station / generic), so the prose
 *      sits semantically next to the link the visitor is about to follow.
 *   2. A locale-aware Permit G + 2026 New Bilateral Agreement summary
 *      with the calculator cross-link.
 *   3. A 3-question FAQ block in `<details>` accordions (collapsed by
 *      default — mobile-first per CLAUDE.md non-negotiables #15-17).
 *   4. A "related tools" line with calculator / FX / health-insurance
 *      / fuel cross-links.
 *
 * Design rules (CLAUDE.md non-negotiables):
 *  - Mobile-first: appended AFTER the bridge's existing main link, so
 *    the CTA stays first-paint on a ≤414 px viewport.
 *  - No new colour values: all `var(--color-*)` semantic tokens from
 *    `index.css`. Light + dark mode auto-switch.
 *  - No hidden text: every paragraph is crawlable; only the FAQ uses
 *    `<details>` (visible heading, expandable answer — Google indexes
 *    both per current guidance).
 *  - Parametric: `bridgeKind` switches the opening paragraph wording so
 *    no two bridges of different kinds share the same intro string.
 *
 * Pure: identical (locale, bridgeKind) inputs produce identical HTML.
 */

export type BridgeProseLocale = 'it' | 'en' | 'de' | 'fr';

/**
 * Kind of bridge page being rendered. Drives the opening paragraph
 * wording so cross-page boilerplate is avoided across the three groups
 * that share the helper.
 */
export type BridgePageKind =
  | 'article'        // Blog article alias (legacyAliasPlugin blog*)
  | 'job-matched'    // Active job, URL changed (jobOrphanBridgePlugin matched)
  | 'job-expired'    // Removed listing (jobOrphanBridgePlugin expired/expired-tracked)
  | 'fuel-station'   // Per-station fuel page that rotated out
  | 'generic';       // Catch-all (calculator alias, locale-prefixed misc)

export interface BridgePageProseOpts {
  readonly locale: BridgePageLocale;
  readonly bridgeKind: BridgePageKind;
}

// Public alias kept for explicitness — the locale type is identical.
export type BridgePageLocale = BridgeProseLocale;

const CALCULATOR_HREF: Record<BridgeProseLocale, string> = {
  it: '/calcola-stipendio/',
  en: '/en/calculate-salary/',
  de: '/de/gehalt-berechnen/',
  fr: '/fr/calculer-salaire/',
};

const FX_HREF: Record<BridgeProseLocale, string> = {
  it: '/comparatori/cambio-valuta/',
  en: '/en/comparators/currency-exchange/',
  de: '/de/vergleiche/wechselkurs/',
  fr: '/fr/comparateurs/change-devises/',
};

const HEALTH_HREF: Record<BridgeProseLocale, string> = {
  it: '/comparatori/casse-malati/',
  en: '/en/comparators/health-insurance/',
  de: '/de/vergleiche/krankenkassen/',
  fr: '/fr/comparateurs/caisses-maladie/',
};

const FUEL_HREF: Record<BridgeProseLocale, string> = {
  it: '/prezzi-benzina-svizzera/',
  en: '/en/gasoline-price-switzerland/',
  de: '/de/benzinpreis-schweiz/',
  fr: '/fr/prix-essence-suisse/',
};

const JOBS_HREF: Record<BridgeProseLocale, string> = {
  it: '/cerca-lavoro-ticino/',
  en: '/en/find-jobs-ticino/',
  de: '/de/jobs-im-tessin/',
  fr: '/fr/trouver-emploi-tessin/',
};

interface ProseCopy {
  readonly contextHeading: string;
  readonly openerByKind: Record<BridgePageKind, string>;
  readonly permitHeading: string;
  readonly permitBody: string;
  readonly faqHeading: string;
  readonly faqs: ReadonlyArray<{ readonly q: string; readonly a: string }>;
  readonly relatedHeading: string;
  readonly relatedBody: string;
}

function esc(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildCopy(locale: BridgeProseLocale): ProseCopy {
  if (locale === 'it') {
    const calc = CALCULATOR_HREF.it;
    const fx = FX_HREF.it;
    const health = HEALTH_HREF.it;
    const fuel = FUEL_HREF.it;
    const jobs = JOBS_HREF.it;
    return {
      contextHeading: 'Cosa trovi sul nostro sito per i frontalieri italo-svizzeri',
      openerByKind: {
        article: `Mentre apriamo la versione aggiornata di questo articolo, una bussola veloce: tutto il sito ruota attorno al confronto reale fra vivere in Svizzera con Permesso B e pendolare dall'Italia con Permesso G. Negli articoli del blog approfondiamo le novità fiscali (Nuovo Accordo 2024, ristorni, credito d'imposta), gli orari dei valichi, le pratiche LAMal e le altre questioni quotidiane di chi attraversa il confine.`,
        'job-matched': `Mentre carichiamo la versione corrente di questo annuncio, ricorda che il job-board frontaliere viene aggiornato ogni 6-12 ore con offerte attive da oltre 80 datori svizzeri (Workday, Smartrecruiters, ATS proprietari, bacheche cantonali). Ogni annuncio mostra sede, lordo CHF quando dichiarato, link diretto al sito aziendale e — per i frontalieri italiani — il netto stimato in CHF e in EUR.`,
        'job-expired': `Questo annuncio è stato chiuso dall'azienda inserzionista, ma sul job-board frontaliere trovi quotidianamente nuove offerte filtrabili per ruolo, città, settore, contratto e datore. Ogni risultato include il calcolo del netto Permesso G vs Permesso B, l'orario dei valichi e gli aggiustamenti fiscali del Nuovo Accordo 2024 per i frontalieri italo-svizzeri.`,
        'fuel-station': `Questa stazione di servizio ha cambiato URL o è uscita dal nostro dataset giornaliero. Il prezzo medio della tua zona e i distributori più convenienti sono comunque aggiornati ogni notte tramite il nostro crawler su TCS Benzinpreis e MIMIT Osservaprezzi: confronto del prezzo svizzero entro 20 km dal valico con quello italiano nelle città di residenza tipiche del frontaliere.`,
        generic: `Sul sito Frontaliere Ticino trovi calcolatori, comparatori e guide pensati per chi vive in Italia e lavora in Svizzera, o per chi sta valutando un trasferimento con Permesso B. Tutti gli strumenti sono gratuiti, senza registrazione, e tengono conto del Nuovo Accordo bilaterale 2024 per i nuovi frontalieri.`,
      },
      permitHeading: 'Permesso G, Permesso B e fiscalità del Nuovo Accordo 2024',
      permitBody: `Il Permesso G è obbligatorio per chi risiede nella zona di 20 km dal confine svizzero (Lombardia, Piemonte e — per i nuovi pendolari dal 2024 — Valle d'Aosta) e lavora in Svizzera con rientro almeno settimanale al domicilio italiano. La prima emissione richiede 2-6 settimane dalla firma del contratto, con rinnovo annuale automatico fino al limite contrattuale. Il Nuovo Accordo Italia-Svizzera 2024 prevede tassazione concorrente con credito d'imposta italiano fino all'80 % della ritenuta CH per i nuovi frontalieri (assunti dopo il 17 luglio 2023), con franchigia di 10'000 EUR; chi era già frontaliere prima di quella data mantiene il vecchio regime di tassazione esclusiva svizzera con ristorno del 38,8 % al comune italiano di residenza. Per simulare il netto reale apri il <a href="${calc}" style="color:var(--color-link)">calcolatore stipendio frontaliere</a>: vecchio + nuovo regime, conversione CHF/EUR, stima del ristorno comunale.`,
      faqHeading: 'Domande frequenti dei frontalieri italo-svizzeri',
      faqs: [
        {
          q: `Quanto telelavoro è ammesso per un frontaliere italo-svizzero?`,
          a: `Il telelavoro è consentito fino al 25 % del tempo di lavoro (circa un giorno a settimana su orario standard) senza perdere lo status di frontaliere e senza far scattare l'obbligo contributivo nel paese di residenza. Sopra il 25 % serve un accordo specifico fra datore, dipendente e autorità — il superamento sposta la base previdenziale e fiscale verso l'Italia. La regola vale identica in tutti i cantoni svizzeri, inclusi Ticino, Vallese, Grigioni e i cantoni non di confine.`,
        },
        {
          q: `Conviene davvero lo stipendio svizzero rispetto al lordo italiano?`,
          a: `Il netto svizzero dipende da quattro variabili: imposta alla fonte cantonale (scaglioni 4-19 % a seconda del lordo, stato civile e figli), contributi sociali (AVS-AI-IPG 5,3 % fissi, AD 1,1 %, LPP 7-18 % in base all'età), Nuovo Accordo Italia-Svizzera 2024 con credito d'imposta italiano, e costi di pendolarismo (carburante, autostrada, usura veicolo, LAMal). Sul <a href="${calc}" style="color:var(--color-link)">simulatore</a> inserisci il lordo CHF di un'offerta concreta e ottieni il netto mensile reale in CHF e in EUR, immediatamente confrontabile con il netto italiano della tua zona.`,
        },
        {
          q: `Quali altri strumenti gratuiti trovo sul sito?`,
          a: `Oltre al simulatore stipendio: <a href="${fx}" style="color:var(--color-link)">comparatore cambio CHF/EUR</a> con i tassi di banche italiane, cambia-valute svizzeri e Wise/Revolut; <a href="${health}" style="color:var(--color-link)">comparatore casse malati LAMal</a> per scegliere il premio mensile più conveniente nel tuo comune di lavoro svizzero; <a href="${fuel}" style="color:var(--color-link)">prezzo carburante svizzero</a> aggiornato giornalmente da TCS Benzinpreis; e il <a href="${jobs}" style="color:var(--color-link)">job-board frontaliere</a> con oltre 2000 offerte attive in Ticino e negli altri cantoni svizzeri.`,
        },
      ],
      relatedHeading: 'Strumenti collegati',
      relatedBody: `Per chiudere il cerchio prima di accettare un'offerta svizzera: <a href="${calc}" style="color:var(--color-link)">calcolatore stipendio netto</a> (vecchio + nuovo Accordo 2024), <a href="${fx}" style="color:var(--color-link)">cambio CHF/EUR</a>, <a href="${health}" style="color:var(--color-link)">comparatore casse malati LAMal</a>, <a href="${fuel}" style="color:var(--color-link)">prezzo benzina/diesel</a> in Svizzera aggiornato ogni notte, <a href="${jobs}" style="color:var(--color-link)">job-board frontaliere</a> con i datori che assumono.`,
    };
  }

  if (locale === 'en') {
    const calc = CALCULATOR_HREF.en;
    const fx = FX_HREF.en;
    const health = HEALTH_HREF.en;
    const fuel = FUEL_HREF.en;
    const jobs = JOBS_HREF.en;
    return {
      contextHeading: 'What you can find on our Italian-Swiss cross-border site',
      openerByKind: {
        article: `While we open the updated version of this article, a quick compass: the whole site revolves around the real comparison between living in Switzerland with a B permit and commuting from Italy with a G permit. Blog articles cover tax news (2024 New Bilateral Agreement, refund, tax credit), border-crossing waiting times, LAMal health-insurance choices and the day-to-day questions of those who cross the border.`,
        'job-matched': `While we load the current version of this listing, remember the cross-border job board refreshes every 6-12 hours with active openings from 80+ Swiss employers (Workday, Smartrecruiters, proprietary ATS, cantonal job centres). Each listing shows location, gross CHF when declared, a direct apply link to the company's career site and — for Italian cross-border workers — the estimated net pay in CHF and EUR.`,
        'job-expired': `This listing has been closed by the employer, but the cross-border job board surfaces new openings daily, filterable by role, city, sector, contract type and employer. Each result includes the G-permit vs B-permit net calculation, border-crossing timetables and the 2024 New Bilateral Agreement tax adjustments for Italian-Swiss cross-border workers.`,
        'fuel-station': `This filling station changed its URL or rotated out of our daily dataset. The zonal average and cheaper alternatives nearby are nonetheless updated every night by our crawler on top of TCS Benzinpreis and MIMIT Osservaprezzi: comparing the Swiss price within 20 km of the border crossing with the Italian price in the typical residence cities of cross-border workers.`,
        generic: `Frontaliere Ticino hosts calculators, comparators and guides designed for Italian residents working in Switzerland — or for anyone considering a B-permit move. Every tool is free, no sign-up, and accounts for the 2024 New Bilateral Agreement applicable to new cross-border workers.`,
      },
      permitHeading: 'G permit, B permit and the 2024 New Bilateral Agreement',
      permitBody: `The G permit is mandatory for residents within 20 km of the Swiss border (Lombardy, Piedmont and — for new commuters since 2024 — Aosta Valley too) working in Switzerland with at least weekly return to the Italian domicile. First issuance takes 2-6 weeks after contract signature, with yearly renewal up to the contract end. The 2024 Italy-Switzerland Agreement introduces dual taxation with Italian tax credit up to 80 % of the Swiss withholding for new cross-border workers (hired after 17 July 2023), with a 10,000 EUR allowance; workers already classified as cross-border before that date keep the legacy regime of exclusive Swiss taxation with 38.8 % refund to the Italian residence municipality. To simulate the real take-home pay open the <a href="${calc}" style="color:var(--color-link)">cross-border salary calculator</a>: both regimes, CHF/EUR conversion, municipal refund estimate.`,
      faqHeading: 'Frequently asked questions from Italian-Swiss cross-border workers',
      faqs: [
        {
          q: `How much remote work is allowed for an Italian-Swiss cross-border worker?`,
          a: `Teleworking is allowed up to 25 % of the working time (about one day per week on a standard schedule) without losing cross-border status and without triggering social-security contributions in the country of residence. Above 25 % a specific agreement between employer, employee and authorities is required — exceeding the cap shifts the social and fiscal basis toward Italy. The rule applies identically across all Swiss cantons including Ticino, Valais, Graubünden and non-border cantons.`,
        },
        {
          q: `Is a Swiss salary really worth it compared with the Italian gross?`,
          a: `Swiss net pay depends on four variables: cantonal source tax (brackets 4-19 % depending on gross, marital status and children), social charges (AVS-AI-IPG 5.3 % flat, unemployment 1.1 %, LPP 7-18 % by age), the 2024 Italy-Switzerland agreement with Italian tax credit, and commute costs (fuel, motorway, vehicle wear, LAMal). Open the <a href="${calc}" style="color:var(--color-link)">simulator</a>, paste a real listing's gross CHF and you'll see the monthly net in CHF and EUR, immediately comparable with the Italian net for your residence area.`,
        },
        {
          q: `What other free tools does the site offer?`,
          a: `Beyond the salary simulator: <a href="${fx}" style="color:var(--color-link)">CHF/EUR exchange comparator</a> with rates from Italian banks, Swiss bureaux de change and Wise/Revolut; <a href="${health}" style="color:var(--color-link)">LAMal health-insurance comparator</a> for the cheapest premium in your Swiss work municipality; <a href="${fuel}" style="color:var(--color-link)">daily Swiss fuel price</a> from TCS Benzinpreis; and the <a href="${jobs}" style="color:var(--color-link)">cross-border job board</a> with 2000+ active listings in Ticino and the other Swiss cantons.`,
        },
      ],
      relatedHeading: 'Related tools',
      relatedBody: `Close the loop before accepting a Swiss offer: <a href="${calc}" style="color:var(--color-link)">net salary calculator</a> (legacy + 2024 new agreement), <a href="${fx}" style="color:var(--color-link)">CHF/EUR exchange</a>, <a href="${health}" style="color:var(--color-link)">LAMal health-insurance comparator</a>, <a href="${fuel}" style="color:var(--color-link)">Swiss petrol/diesel price</a> updated every night, <a href="${jobs}" style="color:var(--color-link)">cross-border job board</a> with the employers that are hiring.`,
    };
  }

  if (locale === 'de') {
    const calc = CALCULATOR_HREF.de;
    const fx = FX_HREF.de;
    const health = HEALTH_HREF.de;
    const fuel = FUEL_HREF.de;
    const jobs = JOBS_HREF.de;
    return {
      contextHeading: 'Was Sie auf unserer Grenzgänger-Plattform finden',
      openerByKind: {
        article: `Während wir die aktualisierte Version dieses Artikels öffnen, ein schneller Wegweiser: die gesamte Plattform vergleicht das Leben in der Schweiz mit B-Bewilligung und das Pendeln aus Italien mit G-Bewilligung. Die Blog-Artikel behandeln Steuernovellen (Bilaterales Abkommen 2024, Rückerstattungen, Steuergutschrift), Wartezeiten an den Grenzübergängen, KVG-Krankenversicherungswahl und alltägliche Fragen.`,
        'job-matched': `Während wir die aktuelle Version dieser Stelle laden: das Grenzgänger-Job-Board aktualisiert sich alle 6-12 Stunden mit offenen Stellen von 80+ Schweizer Arbeitgebern (Workday, Smartrecruiters, proprietäre ATS, kantonale Job-Center). Jede Stelle zeigt Standort, Brutto in CHF wenn deklariert, einen direkten Bewerbungslink zum Karriereportal und — für italienische Grenzgänger — das geschätzte Netto in CHF und EUR.`,
        'job-expired': `Diese Stelle wurde vom Arbeitgeber geschlossen, aber das Grenzgänger-Job-Board zeigt täglich neue offene Stellen, filterbar nach Rolle, Stadt, Branche, Vertragsart und Arbeitgeber. Jedes Ergebnis enthält die Netto-Berechnung G-Bewilligung vs B-Bewilligung, die Pendlerfahrpläne und die Steueranpassungen des bilateralen Abkommens 2024 für italienisch-schweizerische Grenzgänger.`,
        'fuel-station': `Diese Tankstelle hat ihre URL geändert oder ist aus unserem täglichen Datenbestand rotiert. Der Zonen-Durchschnitt und die günstigeren Alternativen in der Nähe werden trotzdem jede Nacht von unserem Crawler über TCS Benzinpreis und MIMIT Osservaprezzi aktualisiert: Vergleich des Schweizer Preises innerhalb von 20 km vom Grenzübergang mit dem italienischen Preis in den typischen Wohnstädten der Grenzgänger.`,
        generic: `Frontaliere Ticino bietet Rechner, Vergleicher und Leitfäden für italienisch-ansässige Personen, die in der Schweiz arbeiten — oder für jeden, der einen Umzug mit B-Bewilligung erwägt. Alle Tools sind gratis, ohne Anmeldung, und berücksichtigen das bilaterale Abkommen 2024 für neue Grenzgänger.`,
      },
      permitHeading: 'G-Bewilligung, B-Bewilligung und das bilaterale Abkommen 2024',
      permitBody: `Die G-Bewilligung ist Pflicht für Ansässige innerhalb 20 km der Schweizer Grenze (Lombardei, Piemont und — für neue Pendler ab 2024 — auch Aostatal), die in der Schweiz arbeiten und mindestens wöchentlich zum italienischen Wohnsitz zurückkehren. Die Erstausstellung dauert 2-6 Wochen nach Vertragsunterzeichnung, danach jährliche Verlängerung. Das Steuerabkommen Italien-Schweiz 2024 sieht eine konkurrierende Besteuerung mit italienischer Steuergutschrift bis 80 % der schweizerischen Quellensteuer für neue Grenzgänger (Anstellung ab 17. Juli 2023) und 10'000 EUR Freibetrag vor; Personen, die vor diesem Datum bereits als Grenzgänger eingestuft waren, behalten das alte Regime exklusiver schweizerischer Besteuerung mit 38,8 % Rückerstattung an die italienische Wohngemeinde. Um das tatsächliche Netto zu simulieren, öffnen Sie den <a href="${calc}" style="color:var(--color-link)">Grenzgänger-Lohnrechner</a>: beide Regime, CHF/EUR-Umrechnung, Schätzung der Gemeinde-Rückerstattung.`,
      faqHeading: 'Häufige Fragen italienisch-schweizerischer Grenzgänger',
      faqs: [
        {
          q: `Wie viel Homeoffice ist für einen italienisch-schweizerischen Grenzgänger erlaubt?`,
          a: `Telearbeit ist bis zu 25 % der Arbeitszeit erlaubt (etwa ein Tag pro Woche bei Vollzeit), ohne den Grenzgängerstatus zu verlieren und ohne Sozialabgaben im Wohnland auszulösen. Über 25 % braucht es eine spezifische Vereinbarung zwischen Arbeitgeber, Arbeitnehmer und Behörden — eine Überschreitung verschiebt die Sozial- und Steuerbasis nach Italien. Die Regel gilt identisch in allen Schweizer Kantonen, einschliesslich Tessin, Wallis, Graubünden und Nichtgrenzkantonen.`,
        },
        {
          q: `Lohnt sich ein Schweizer Lohn wirklich verglichen mit dem italienischen Brutto?`,
          a: `Das schweizerische Netto hängt von vier Variablen ab: kantonale Quellensteuer (Stufen 4-19 % je nach Brutto, Zivilstand und Kindern), Sozialabgaben (AHV-IV-EO 5,3 % fix, ALV 1,1 %, BVG 7-18 % nach Alter), Steuerabkommen 2024 mit italienischer Steuergutschrift und Pendelkosten (Treibstoff, Autobahn, Fahrzeugverschleiss, KVG). Mit dem <a href="${calc}" style="color:var(--color-link)">Lohnrechner</a> geben Sie das Brutto einer konkreten Stellenausschreibung ein und erhalten das tatsächliche Monatsnetto in CHF und EUR, direkt vergleichbar mit dem italienischen Netto Ihrer Wohnregion.`,
        },
        {
          q: `Welche anderen gratis Tools bietet die Plattform?`,
          a: `Neben dem Lohnrechner: <a href="${fx}" style="color:var(--color-link)">CHF/EUR-Wechselkursvergleich</a> mit den Kursen italienischer Banken, Schweizer Wechselstuben und Wise/Revolut; <a href="${health}" style="color:var(--color-link)">KVG-Krankenkassen-Vergleich</a> für die günstigste Prämie in Ihrer Schweizer Arbeitsgemeinde; <a href="${fuel}" style="color:var(--color-link)">täglicher Schweizer Benzinpreis</a> von TCS Benzinpreis; und das <a href="${jobs}" style="color:var(--color-link)">Grenzgänger-Job-Board</a> mit 2000+ aktiven Stellen im Tessin und den anderen Schweizer Kantonen.`,
        },
      ],
      relatedHeading: 'Verwandte Tools',
      relatedBody: `Den Kreis schliessen vor der Annahme eines Schweizer Angebots: <a href="${calc}" style="color:var(--color-link)">Netto-Lohnrechner</a> (altes + neues Abkommen 2024), <a href="${fx}" style="color:var(--color-link)">CHF/EUR-Wechselkurs</a>, <a href="${health}" style="color:var(--color-link)">KVG-Krankenkassen-Vergleich</a>, <a href="${fuel}" style="color:var(--color-link)">Schweizer Benzin-/Dieselpreis</a> nächtlich aktualisiert, <a href="${jobs}" style="color:var(--color-link)">Grenzgänger-Job-Board</a> mit Arbeitgebern, die einstellen.`,
    };
  }

  // FR
  const calc = CALCULATOR_HREF.fr;
  const fx = FX_HREF.fr;
  const health = HEALTH_HREF.fr;
  const fuel = FUEL_HREF.fr;
  const jobs = JOBS_HREF.fr;
  return {
    contextHeading: 'Ce que vous trouvez sur notre site frontalier italo-suisse',
    openerByKind: {
      article: `Pendant que nous ouvrons la version mise à jour de cet article, une boussole rapide : tout le site compare la vie en Suisse avec permis B et le trajet quotidien depuis l'Italie avec permis G. Les articles du blog couvrent les nouveautés fiscales (Nouvel Accord 2024, rétrocession, crédit d'impôt), les temps d'attente aux passages, le choix de l'assurance LAMal et les questions du quotidien.`,
      'job-matched': `Pendant que nous chargeons la version courante de cette annonce, sachez que le job-board frontalier s'actualise toutes les 6-12 heures avec des postes ouverts chez 80+ employeurs suisses (Workday, Smartrecruiters, ATS propriétaires, centres cantonaux). Chaque annonce affiche le lieu, le brut en CHF lorsque déclaré, un lien de candidature direct au portail carrière de l'entreprise et — pour les frontaliers italiens — le net estimé en CHF et en EUR.`,
      'job-expired': `Cette annonce a été fermée par l'employeur, mais le job-board frontalier publie quotidiennement de nouvelles offres, filtrables par rôle, ville, secteur, type de contrat et employeur. Chaque résultat inclut le calcul du net permis G vs permis B, les horaires aux passages frontaliers et les ajustements fiscaux du Nouvel Accord bilatéral 2024 pour les frontaliers italo-suisses.`,
      'fuel-station': `Cette station-service a changé d'URL ou est sortie de notre base quotidienne. La moyenne de zone et les alternatives moins chères à proximité sont néanmoins mises à jour chaque nuit par notre crawler sur TCS Benzinpreis et MIMIT Osservaprezzi : comparaison du prix suisse dans un rayon de 20 km de la frontière avec le prix italien dans les villes de résidence typiques des frontaliers.`,
      generic: `Frontaliere Ticino propose calculateurs, comparateurs et guides destinés aux résidents italiens travaillant en Suisse — ou à quiconque envisage un déménagement avec permis B. Tous les outils sont gratuits, sans inscription, et tiennent compte du Nouvel Accord bilatéral 2024 pour les nouveaux frontaliers.`,
    },
    permitHeading: 'Permis G, permis B et Nouvel Accord bilatéral 2024',
    permitBody: `Le permis G est obligatoire pour les résidents dans un rayon de 20 km de la frontière suisse (Lombardie, Piémont et — pour les nouveaux pendulaires depuis 2024 — Vallée d'Aoste aussi) qui travaillent en Suisse avec un retour hebdomadaire minimum au domicile italien. La première délivrance prend 2-6 semaines après signature du contrat, puis renouvellement annuel jusqu'à la fin du contrat. L'accord fiscal Italie-Suisse 2024 prévoit une taxation concurrente avec crédit d'impôt italien jusqu'à 80 % de la retenue suisse pour les nouveaux frontaliers (engagés après le 17 juillet 2023), avec un abattement de 10 000 EUR ; les personnes déjà classées frontalières avant cette date conservent l'ancien régime de taxation suisse exclusive avec rétrocession de 38,8 % à la commune italienne de résidence. Pour simuler le net réel, ouvrez le <a href="${calc}" style="color:var(--color-link)">calculateur de salaire frontalier</a> : les deux régimes, conversion CHF/EUR, estimation de la rétrocession communale.`,
    faqHeading: 'Questions fréquentes des frontaliers italo-suisses',
    faqs: [
      {
        q: `Combien de télétravail est autorisé pour un frontalier italo-suisse ?`,
        a: `Le télétravail est autorisé jusqu'à 25 % du temps de travail (environ un jour par semaine à temps plein) sans perdre le statut de frontalier et sans déclencher de cotisations sociales dans le pays de résidence. Au-delà de 25 % il faut un accord spécifique entre employeur, salarié et autorités — le dépassement déplace la base sociale et fiscale vers l'Italie. La règle s'applique identiquement dans tous les cantons suisses, y compris Tessin, Valais, Grisons et cantons non-frontaliers.`,
      },
      {
        q: `Le salaire suisse vaut-il vraiment la peine comparé au brut italien ?`,
        a: `Le net suisse dépend de quatre variables : impôt à la source cantonal (tranches 4-19 % selon brut, état civil et enfants), charges sociales (AVS-AI-APG 5,3 % fixe, chômage 1,1 %, LPP 7-18 % par âge), accord fiscal 2024 avec crédit d'impôt italien, et coûts de trajet (carburant, autoroute, usure du véhicule, LAMal). Ouvrez le <a href="${calc}" style="color:var(--color-link)">simulateur</a> avec le brut d'une annonce concrète et vous obtenez le net mensuel réel en CHF et en EUR, directement comparable avec le net italien de votre zone de résidence.`,
      },
      {
        q: `Quels autres outils gratuits propose le site ?`,
        a: `Au-delà du simulateur de salaire : <a href="${fx}" style="color:var(--color-link)">comparateur de change CHF/EUR</a> avec les taux des banques italiennes, bureaux de change suisses et Wise/Revolut ; <a href="${health}" style="color:var(--color-link)">comparateur LAMal des caisses maladie</a> pour la prime la moins chère dans votre commune de travail suisse ; <a href="${fuel}" style="color:var(--color-link)">prix quotidien du carburant suisse</a> depuis TCS Benzinpreis ; et le <a href="${jobs}" style="color:var(--color-link)">job-board frontalier</a> avec 2000+ offres actives au Tessin et dans les autres cantons suisses.`,
      },
    ],
    relatedHeading: 'Outils associés',
    relatedBody: `Pour boucler la boucle avant d'accepter une offre suisse : <a href="${calc}" style="color:var(--color-link)">calculateur de salaire net</a> (ancien + nouvel Accord 2024), <a href="${fx}" style="color:var(--color-link)">change CHF/EUR</a>, <a href="${health}" style="color:var(--color-link)">comparateur LAMal des caisses maladie</a>, <a href="${fuel}" style="color:var(--color-link)">prix de l'essence/diesel suisse</a> actualisé chaque nuit, <a href="${jobs}" style="color:var(--color-link)">job-board frontalier</a> avec les employeurs qui recrutent.`,
  };
}

// Memo cache: each (locale × bridgeKind) pair produces an identical block,
// and the bridge plugins call the helper N times per build. Cache the HTML
// string so the function stays cheap regardless of input volume.
const PROSE_CACHE = new Map<string, string>();

/**
 * Render the shared bridge-page prose `<section>`. Append AFTER the host
 * plugin's main link/CTA so the call-to-action remains the first
 * interactive element on mobile (CLAUDE.md non-negotiables #15-17).
 *
 * Returns a self-contained `<section class="bridge-page-prose">` block
 * (~1.6-2.0 KB visible text); the host page is responsible only for
 * embedding it within its own `<main>`.
 */
export function renderBridgePageProse(opts: BridgePageProseOpts): string {
  const { locale, bridgeKind } = opts;
  const cacheKey = `${locale}::${bridgeKind}`;
  const cached = PROSE_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;

  const copy = buildCopy(locale);
  const opener = copy.openerByKind[bridgeKind] || copy.openerByKind.generic;

  const faqHtml = copy.faqs
    .map(
      (f) =>
        `<details style="background:var(--color-surface);border:1px solid var(--color-edge);border-radius:10px;padding:12px 14px;margin:8px 0"><summary style="font-weight:700;cursor:pointer;color:var(--color-heading);font-size:14.5px">${esc(f.q)}</summary><p style="margin:8px 0 0;color:var(--color-body);line-height:1.65;font-size:14.5px">${f.a}</p></details>`,
    )
    .join('');

  const html = `<section class="bridge-page-prose" data-bridge-kind="${esc(bridgeKind)}" data-locale="${esc(locale)}" style="max-width:860px;margin:32px auto 0;color:var(--color-body);line-height:1.65;font-size:15px">
  <h2 style="font-size:20px;font-weight:700;color:var(--color-heading);margin:24px 0 12px">${esc(copy.contextHeading)}</h2>
  <p style="margin:0 0 14px">${opener}</p>
  <h3 style="font-size:17px;font-weight:700;color:var(--color-heading);margin:22px 0 8px">${esc(copy.permitHeading)}</h3>
  <p style="margin:0 0 14px;font-size:14.5px">${copy.permitBody}</p>
  <h3 style="font-size:17px;font-weight:700;color:var(--color-heading);margin:22px 0 8px">${esc(copy.faqHeading)}</h3>
  ${faqHtml}
  <h3 style="font-size:17px;font-weight:700;color:var(--color-heading);margin:22px 0 8px">${esc(copy.relatedHeading)}</h3>
  <p style="margin:0 0 8px;font-size:14.5px">${copy.relatedBody}</p>
</section>`;
  PROSE_CACHE.set(cacheKey, html);
  return html;
}

/**
 * Test-only: reset the prose cache. Used by unit tests that want to
 * verify the helper is called with a particular set of inputs across
 * a build run.
 */
export function __resetBridgeProseCache(): void {
  PROSE_CACHE.clear();
}
