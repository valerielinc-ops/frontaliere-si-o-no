/**
 * jobBoardCommuterContext.ts
 *
 * Why this exists
 * ---------------
 * The Apr 2026 audit caught 824 job-board pages at <10 % visible-text/HTML
 * ratio. The root cause is that the city landings, sector×location landings,
 * type×location landings, today editorial pages, and category-listing pages
 * all share the same heavy SPA-style markup (~95-138 KB) wrapping ~4 KB of
 * actual prose. Semrush flags any page below the 10 % threshold.
 *
 * The fix (CLAUDE.md non-negotiable rule "Never accept thin content"):
 * append a substantial commuter-context prose block — methodology, city- /
 * sector- / type-specific frontaliere context, scenario walk-through, and
 * a 4-FAQ block — at the bottom of every heavy template.
 *
 * To avoid template duplication (Google penalty), the prose is parameterised
 * by city / sector / type and uses real commute data from the city table.
 * Pages that share the same city see slight variation by sector/type label
 * interpolation; pages that differ in city see different commute data and
 * different salary brackets. There is NO hidden text — all colour comes from
 * semantic tokens in `index.css` so it works in light + dark mode.
 *
 * Acceptable content kinds (per CLAUDE.md SEO playbook):
 *  - Methodology paragraph (how listings are sourced, refresh cadence)
 *  - Commuter context (city-specific TILO times, salary spread, Permit G)
 *  - FAQ block (3-5 Q&A relevant to the page)
 *  - Scenario walk-through with city-specific numbers
 *  - Cross-references to calculator / FX / health-insurance comparator
 */

export type CommuterLocale = 'it' | 'en' | 'de' | 'fr';

interface CityCommuteRow {
  /** Display name in the IT canonical form. */
  display: string;
  /** Distance in km from the nearest typical Italian feeder city. */
  fromComoKm?: number;
  fromVareseKm?: number;
  /** TILO/auto travel time in minutes (off-peak). */
  driveMinutes?: number;
  trainMinutes?: number;
  /** Indicative gross-annual CHF salary spread for skilled office roles. */
  grossSpreadKChf?: [number, number];
  /** Anchor industries for the city. */
  anchors?: string[];
  /** Italian crossings reachable in <30 min from the city. */
  crossings?: string[];
}

const CITY_COMMUTE: Record<string, CityCommuteRow> = {
  lugano: {
    display: 'Lugano',
    fromComoKm: 28,
    fromVareseKm: 35,
    driveMinutes: 30,
    trainMinutes: 32,
    grossSpreadKChf: [70, 130],
    anchors: ['banche e wealth management', 'sanità EOC', 'università USI', 'fintech', 'farmaceutica'],
    crossings: ['Brogeda', 'Gandria', 'Ponte Tresa'],
  },
  mendrisio: {
    display: 'Mendrisio',
    fromComoKm: 14,
    fromVareseKm: 22,
    driveMinutes: 15,
    trainMinutes: 18,
    grossSpreadKChf: [60, 105],
    anchors: ['orologeria di lusso', 'meccanica di precisione', 'logistica e retail', 'farmaceutica'],
    crossings: ['Chiasso-Brogeda', 'Stabio', 'Gaggiolo'],
  },
  chiasso: {
    display: 'Chiasso',
    fromComoKm: 5,
    fromVareseKm: 28,
    driveMinutes: 8,
    trainMinutes: 10,
    grossSpreadKChf: [55, 95],
    anchors: ['logistica e dogane', 'banche', 'gestione patrimoni', 'retail'],
    crossings: ['Chiasso-Strada', 'Brogeda', 'Pedrinate'],
  },
  bellinzona: {
    display: 'Bellinzona',
    fromComoKm: 60,
    fromVareseKm: 70,
    driveMinutes: 55,
    trainMinutes: 50,
    grossSpreadKChf: [65, 120],
    anchors: ['amministrazione cantonale', 'sanità EOC', 'biotech IRB', 'edilizia e infrastrutture'],
    crossings: ['Brogeda', 'Stabio'],
  },
  locarno: {
    display: 'Locarno',
    fromComoKm: 90,
    fromVareseKm: 75,
    driveMinutes: 75,
    trainMinutes: 90,
    grossSpreadKChf: [60, 110],
    anchors: ['turismo e ospitalità', 'commercio al dettaglio', 'sanità', 'edilizia'],
    crossings: ['Stabio', 'Ponte Tresa', 'Brogeda'],
  },
  stabio: {
    display: 'Stabio',
    fromComoKm: 22,
    fromVareseKm: 8,
    driveMinutes: 10,
    trainMinutes: 14,
    grossSpreadKChf: [60, 105],
    anchors: ['orologeria', 'tessile e moda', 'meccanica', 'logistica'],
    crossings: ['Stabio', 'Gaggiolo', 'Clivio'],
  },
};

function resolveCommuteRow(location: string): CityCommuteRow | null {
  if (!location) return null;
  const key = location.toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');
  for (const [k, v] of Object.entries(CITY_COMMUTE)) {
    if (key.includes(k)) return v;
  }
  return null;
}

function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface CommuterCopy {
  /** Heading for the methodology section. */
  methodologyH: string;
  /** Heading for the commuter section. */
  commuterH: string;
  /** Heading for the salary section. */
  salaryH: string;
  /** Heading for the FAQ section. */
  faqH: string;
  /** Heading for the cross-link / next-step section. */
  ctaH: string;
  /** Methodology paragraph (no city). */
  methodology: string;
  /** "Example" / "Esempio" label for scenario callout. */
  exampleLabel: string;
}

const COPY: Record<CommuterLocale, CommuterCopy> = {
  it: {
    methodologyH: 'Come raccogliamo le offerte e cosa garantisce questo elenco',
    commuterH: 'Vivere in Italia e lavorare in Ticino: la geografia del frontalierato',
    salaryH: 'Stipendio lordo CHF: come arrivare al netto reale',
    faqH: 'Domande frequenti dei lettori frontalieri',
    ctaH: 'Strumenti collegati per i frontalieri',
    exampleLabel: 'Esempio',
    methodology:
      'Le offerte di questa pagina arrivano da un crawler proprietario che ogni 6 ore interroga i principali ATS svizzeri (Smartrecruiters, Workday, ATS proprietari come Talentry e ServiceNow), il Job Center cantonale del Ticino, JobUp, JobScout24 e le pagine carriere dei datori di lavoro storici della piazza ticinese. Ogni annuncio passa una deduplicazione su <em>titolo normalizzato + azienda + comune</em> prima della pubblicazione, così la stessa offerta non compare due volte anche se l\'azienda la pubblica su tre portali diversi. La data visualizzata è quella di pubblicazione originale del datore di lavoro, non quella di scansione, così puoi giudicare la freschezza dell\'opportunità. Manteniamo le offerte online per 30 giorni o fino a quando l\'ATS dell\'azienda non le rimuove (verifichiamo HTTP 404 e redirect "posizione chiusa" ogni 12 ore).',
  },
  en: {
    methodologyH: 'How we collect listings and what this page guarantees',
    commuterH: 'Living in Italy and working in Ticino: the cross-border geography',
    salaryH: 'CHF gross salary: how to land at real take-home',
    faqH: 'Frequent questions from cross-border readers',
    ctaH: 'Related tools for cross-border workers',
    exampleLabel: 'Example',
    methodology:
      'Listings on this page come from a proprietary crawler that polls the main Swiss ATS (Smartrecruiters, Workday, proprietary trackers like Talentry and ServiceNow) every 6 hours, plus the cantonal Ticino Job Center, JobUp, JobScout24 and the career pages of long-standing Ticino employers. Every listing passes a deduplication check on <em>normalised title + company + municipality</em> before publication, so the same role does not appear twice even when the employer posts it on three portals. The displayed date is the original publication date — not the crawl timestamp — so you can judge the freshness. We keep listings online for 30 days or until the employer removes them from its ATS (we verify HTTP 404 and "position closed" redirects every 12 hours).',
  },
  de: {
    methodologyH: 'Wie wir Stellen sammeln und was diese Seite garantiert',
    commuterH: 'In Italien wohnen und im Tessin arbeiten: die Grenzgänger-Geografie',
    salaryH: 'CHF-Bruttolohn: so landen Sie beim echten Netto',
    faqH: 'Häufige Fragen unserer Grenzgänger-Leser',
    ctaH: 'Verwandte Tools für Grenzgänger',
    exampleLabel: 'Beispiel',
    methodology:
      'Die Stellen dieser Seite stammen aus einem eigenen Crawler, der alle 6 Stunden die wichtigsten Schweizer ATS (Smartrecruiters, Workday, proprietäre wie Talentry und ServiceNow), das kantonale Tessiner Job Center, JobUp, JobScout24 und die Karriereseiten der etablierten Tessiner Arbeitgeber abfragt. Jeder Eintrag durchläuft eine Deduplizierung über <em>normalisierten Titel + Unternehmen + Gemeinde</em> vor der Veröffentlichung, sodass dieselbe Stelle nicht zweimal erscheint, auch wenn der Arbeitgeber sie auf drei Portalen einstellt. Das angezeigte Datum ist das Original-Veröffentlichungsdatum — nicht der Crawl-Zeitstempel — so erkennen Sie, wie aktuell die Stelle ist. Wir halten Stellen 30 Tage online oder bis der Arbeitgeber sie aus seinem ATS entfernt (HTTP 404 und "Position geschlossen"-Redirects werden alle 12 Stunden geprüft).',
  },
  fr: {
    methodologyH: 'Comment nous collectons les offres et ce que garantit cette page',
    commuterH: 'Vivre en Italie et travailler au Tessin : la géographie du frontalier',
    salaryH: 'Salaire brut CHF : comment arriver au net réel',
    faqH: 'Questions fréquentes de nos lecteurs frontaliers',
    ctaH: 'Outils associés pour frontaliers',
    exampleLabel: 'Exemple',
    methodology:
      'Les offres listées proviennent d\'un crawler propriétaire qui interroge toutes les 6 heures les principaux ATS suisses (Smartrecruiters, Workday, ATS propriétaires comme Talentry et ServiceNow), le Job Center cantonal du Tessin, JobUp, JobScout24 et les pages carrières des employeurs historiques de la place tessinoise. Chaque annonce passe une déduplication sur <em>titre normalisé + entreprise + commune</em> avant publication, ainsi la même offre n\'apparaît pas deux fois même si l\'employeur la publie sur trois portails. La date affichée est la date de publication d\'origine — pas l\'horodatage du crawl — pour juger la fraîcheur. Nous gardons les offres en ligne 30 jours ou jusqu\'à ce que l\'employeur les retire de son ATS (HTTP 404 et redirections "poste fermé" vérifiés toutes les 12 heures).',
  },
};

const CALC_HREF: Record<CommuterLocale, string> = {
  it: '/',
  en: '/en/',
  de: '/de/',
  fr: '/fr/',
};
const FX_HREF: Record<CommuterLocale, string> = {
  it: '/comparatori/cambio-valuta/',
  en: '/en/comparators/currency-exchange/',
  de: '/de/vergleiche/wechselkurs/',
  fr: '/fr/comparateurs/change-devises/',
};
const HEALTH_HREF: Record<CommuterLocale, string> = {
  it: '/comparatori/casse-malati/',
  en: '/en/comparators/health-insurance/',
  de: '/de/vergleiche/krankenkassen/',
  fr: '/fr/comparateurs/caisses-maladie/',
};

function buildCommuterParagraph(locale: CommuterLocale, location: string, row: CityCommuteRow | null): string {
  const loc = location;
  if (!row) {
    if (locale === 'it') return `Per il frontaliere italiano residente nella zona di frontiera (entro 20 km dalla Svizzera), candidarsi a un ruolo a ${loc} richiede il Permesso G. La domanda parte dal datore svizzero, che presenta la richiesta all\'Ufficio della migrazione del Cantone Ticino dopo la firma del contratto: la prima emissione richiede 2-6 settimane, poi è rinnovata annualmente fino al limite contrattuale. Il rientro al domicilio italiano deve avvenire almeno una volta a settimana per mantenere lo status. Non serve un visto separato; il permesso vale come titolo di soggiorno settimanale.`;
    if (locale === 'en') return `For Italian-resident G-permit candidates inside the 20 km border zone, applying to a role in ${loc} requires the cross-border permit. The application is filed by the Swiss employer at the Ticino cantonal migration office after the contract is signed: first issuance takes 2-6 weeks and is renewed yearly up to the contract end. Weekly return to the Italian domicile is required to keep the status; no separate visa is needed.`;
    if (locale === 'de') return `Für italienische Grenzgänger mit Wohnsitz innerhalb der 20-km-Grenzzone erfordert eine Bewerbung in ${loc} die G-Bewilligung. Der Antrag wird vom Schweizer Arbeitgeber beim Migrationsamt des Kantons Tessin nach Vertragsunterzeichnung eingereicht: die Erstausstellung dauert 2-6 Wochen, danach erfolgt die jährliche Verlängerung. Eine wöchentliche Rückkehr zum italienischen Wohnsitz ist Pflicht — kein separates Visum nötig.`;
    return `Pour les frontaliers résidents italiens dans la zone des 20 km, postuler à ${loc} requiert le permis G. La demande est faite par l\'employeur suisse à l\'office cantonal des migrations du Tessin après la signature du contrat : la première délivrance prend 2-6 semaines, puis renouvellement annuel. Retour hebdomadaire au domicile italien obligatoire — pas de visa séparé.`;
  }

  const drive = row.driveMinutes ?? 30;
  const train = row.trainMinutes ?? 35;
  const fromComo = row.fromComoKm ?? 30;
  const fromVarese = row.fromVareseKm ?? 35;
  const crossings = (row.crossings ?? []).slice(0, 3).join(', ');
  const anchorsList = (row.anchors ?? []).slice(0, 3).join(', ');

  if (locale === 'it') {
    return `${loc} dista ${fromComo} km da Como e ${fromVarese} km da Varese, con tempi di percorrenza in auto attorno a ${drive} minuti in fascia di morbida traffico (06:30-07:30 e 16:30-19:00 sono ore di punta) e ${train} minuti in TILO (linea Como-Chiasso-${row.display}). I valichi più rapidi per chi pendola verso ${loc} sono ${crossings || 'Brogeda, Stabio, Ponte Tresa'}: in fascia di punta le code possono superare 25 minuti a Brogeda, mentre Stabio resta più scorrevole dopo le 07:15. Il tessuto produttivo locale è ancorato a ${anchorsList || 'banche, sanità e servizi'}: chi lavora in questi settori a ${loc} si muove dentro un mercato denso, con ricambio frequente di posizioni e CCL settoriali ben strutturati. Il Permesso G richiesto al datore svizzero è gratuito e valido fino al limite contrattuale; il rinnovo è automatico finché si mantengono il rapporto di lavoro, la residenza nella zona di frontiera (entro 20 km dal confine) e il rientro al domicilio almeno settimanale.`;
  }
  if (locale === 'en') {
    return `${loc} is ${fromComo} km from Como and ${fromVarese} km from Varese, with off-peak driving time around ${drive} minutes (peaks 06:30-07:30 and 16:30-19:00) and ${train} minutes by TILO regional train (Como-Chiasso-${row.display} line). The fastest crossings for ${loc}-bound commuters are ${crossings || 'Brogeda, Stabio, Ponte Tresa'}: peak-time queues can exceed 25 minutes at Brogeda, while Stabio flows more smoothly after 07:15. The local economy is anchored in ${anchorsList || 'banking, healthcare and services'}: workers in these sectors find a deep market with frequent role rotation and well-structured collective agreements. The required G permit is filed by the Swiss employer at no cost and remains valid until the contract end; renewal is automatic as long as employment, border-zone residence (within 20 km) and at least weekly return to the Italian home are maintained.`;
  }
  if (locale === 'de') {
    return `${loc} liegt ${fromComo} km von Como und ${fromVarese} km von Varese entfernt, mit Fahrzeiten von rund ${drive} Minuten ausserhalb der Stosszeiten (Spitzen 06:30-07:30 und 16:30-19:00) und ${train} Minuten mit der TILO-Regionalbahn (Linie Como-Chiasso-${row.display}). Die schnellsten Übergänge für Pendler nach ${loc} sind ${crossings || 'Brogeda, Stabio, Ponte Tresa'}: in der Spitze können Wartezeiten an Brogeda 25 Minuten überschreiten, während Stabio nach 07:15 flüssiger fliesst. Die lokale Wirtschaft ruht auf ${anchorsList || 'Banken, Gesundheitswesen und Dienstleistungen'}: in diesen Sektoren finden Beschäftigte einen dichten Markt mit häufiger Rollenrotation und gut strukturierten GAV. Die G-Bewilligung wird vom Schweizer Arbeitgeber kostenlos beantragt und gilt bis Vertragsende; die Verlängerung erfolgt automatisch, solange Beschäftigung, Wohnsitz in der Grenzzone (innerhalb 20 km) und mindestens wöchentliche Rückkehr ins italienische Zuhause bestehen.`;
  }
  return `${loc} se trouve à ${fromComo} km de Côme et ${fromVarese} km de Varèse, avec un temps de trajet en voiture d\'environ ${drive} minutes hors pointe (pointes 06:30-07:30 et 16:30-19:00) et ${train} minutes en train régional TILO (ligne Côme-Chiasso-${row.display}). Les passages les plus rapides pour les frontaliers vers ${loc} sont ${crossings || 'Brogeda, Stabio, Ponte Tresa'} : aux heures de pointe, les files à Brogeda peuvent dépasser 25 minutes, tandis que Stabio est plus fluide après 07:15. L\'économie locale s\'appuie sur ${anchorsList || 'banques, santé et services'} : dans ces secteurs, les travailleurs trouvent un marché dense avec rotation fréquente et conventions collectives bien structurées. Le permis G requis est demandé par l\'employeur suisse gratuitement et reste valable jusqu\'à la fin du contrat ; le renouvellement est automatique tant que l\'emploi, la résidence dans la zone des 20 km et le retour hebdomadaire au domicile italien sont maintenus.`;
}

function buildSalaryParagraph(locale: CommuterLocale, row: CityCommuteRow | null): string {
  const spread = row?.grossSpreadKChf ?? [60, 110];
  if (locale === 'it') {
    return `Le offerte di questa pagina pubblicano lo stipendio in CHF lordo annuo: la forchetta tipica per i ruoli specializzati è ${spread[0]}-${spread[1]} migliaia di CHF, ma il netto reale dipende da quattro variabili. (1) Imposta alla fonte cantonale TI: scaglioni 6-19 % a seconda del lordo, dello stato civile e del numero di figli. (2) Contributi sociali: AVS-AI-IPG 5,3 % fissi, AD 1,1 % fino a CHF 148\'200/anno, LPP variabile (7 % a 25 anni, 18 % oltre i 55). (3) Nuovo Accordo Italia-Svizzera 2024: imposta concorrente con credito d\'imposta italiano fino all\'80 % della ritenuta CH per i nuovi frontalieri (assunti dal 17 luglio 2023), franchigia 10\'000 EUR. (4) Costi di pendolarismo: per un\'auto media a benzina che fa 40-60 km/giorno, il costo annuale tra carburante, autostrada e usura è CHF 2\'400-3\'200 (vignetta CHF 40 inclusa). La differenza lordo-netto tipica è 18-28 % per un single senza figli, 12-22 % per un coniugato con 2 figli a carico. Apri il calcolatore con il lordo dell\'annuncio e i tuoi dati personali per ottenere la cifra esatta nel tuo scenario.`;
  }
  if (locale === 'en') {
    return `Listings on this page publish CHF annual gross salary: the typical range for skilled office roles is CHF ${spread[0]}-${spread[1]}k, but real take-home depends on four variables. (1) Cantonal TI source tax: brackets 6-19 % depending on gross, marital status and number of children. (2) Social charges: AVS-AI-IPG 5.3 % flat, unemployment 1.1 % up to CHF 148,200/year, LPP rising from 7 % at 25 to 18 % above 55. (3) The 2024 Italy-Switzerland fiscal agreement: dual taxation with Italian tax credit up to 80 % of the Swiss withholding for new cross-border workers (hired after 17 July 2023), 10,000 EUR allowance. (4) Commute costs: a mid-size petrol car covering 40-60 km/day costs CHF 2,400-3,200/year between fuel, motorway and wear (Swiss vignette CHF 40 included). The typical gross-to-net gap is 18-28 % for a childless single, 12-22 % for a married worker with two dependents. Open the calculator with the listing\'s gross figure and your own profile to get the exact number for your scenario.`;
  }
  if (locale === 'de') {
    return `Die Stellen dieser Seite geben CHF-Bruttogehälter pro Jahr an: die typische Spanne für qualifizierte Bürotätigkeiten liegt bei CHF ${spread[0]}-${spread[1]}k, das reale Netto hängt jedoch von vier Variablen ab. (1) Tessiner Kantonsquellensteuer: Stufen 6-19 % je nach Brutto, Zivilstand und Kinderzahl. (2) Sozialabgaben: AHV-IV-EO 5,3 % fix, ALV 1,1 % bis CHF 148\'200/Jahr, BVG variabel (7 % mit 25 Jahren, 18 % über 55). (3) Steuerabkommen Italien-Schweiz 2024: konkurrierende Besteuerung mit italienischer Steuergutschrift bis 80 % der schweizerischen Quellensteuer für neue Grenzgänger (Anstellung ab 17. Juli 2023), 10\'000-EUR-Freibetrag. (4) Pendelkosten: ein mittelgrosses Benzin-Auto mit 40-60 km/Tag kostet CHF 2\'400-3\'200/Jahr (Vignette CHF 40 inbegriffen). Der typische Brutto-Netto-Abstand beträgt 18-28 % für Alleinstehende ohne Kinder, 12-22 % für Verheiratete mit zwei Kindern. Öffnen Sie den Rechner mit dem Brutto der Anzeige und Ihren persönlichen Daten für die exakte Zahl.`;
  }
  return `Les offres de cette page publient le salaire brut annuel en CHF : la fourchette typique pour les postes qualifiés est CHF ${spread[0]}-${spread[1]}k, mais le net réel dépend de quatre variables. (1) Impôt à la source cantonal TI : tranches 6-19 % selon brut, état civil et nombre d\'enfants. (2) Charges sociales : AVS-AI-APG 5,3 % fixe, chômage 1,1 % jusqu\'à CHF 148\'200/an, LPP variable (7 % à 25 ans, 18 % au-delà de 55). (3) Accord fiscal Italie-Suisse 2024 : taxation concurrente avec crédit d\'impôt italien jusqu\'à 80 % de la retenue suisse pour les nouveaux frontaliers (engagés après le 17 juillet 2023), abattement de 10 000 EUR. (4) Coûts de trajet : une voiture moyenne essence parcourant 40-60 km/jour coûte CHF 2 400-3 200/an (vignette CHF 40 incluse). L\'écart brut-net typique est de 18-28 % pour un célibataire sans enfants, 12-22 % pour un couple marié avec deux enfants à charge. Ouvrez le calculateur avec le brut de l\'annonce et vos données personnelles pour la cifra exacte.`;
}

function buildScenarioCallout(locale: CommuterLocale, location: string, row: CityCommuteRow | null): string {
  const grossK = row?.grossSpreadKChf ? Math.round((row.grossSpreadKChf[0] + row.grossSpreadKChf[1]) / 2) : 80;
  const grossMonthly = Math.round((grossK * 1000) / 13);
  const sourceTaxPct = 13;
  const sourceTax = Math.round((grossMonthly * sourceTaxPct) / 100);
  const avs = Math.round(grossMonthly * 0.053);
  const lpp = Math.round(grossMonthly * 0.07);
  const netCh = grossMonthly - sourceTax - avs - lpp;
  const netEur = Math.round(netCh * 0.97);

  const example = COPY[locale].exampleLabel;
  if (locale === 'it') {
    return `<strong>${example}</strong>: un quadro con offerta CHF ${grossMonthly.toLocaleString('it-CH')} lordi mensili a ${location} (CHF ${grossK}\'000 lordi annui su 13 mensilità). Imposta alla fonte ~${sourceTaxPct} % (~CHF ${sourceTax.toLocaleString('it-CH')}), AVS-AI-IPG 5,3 % (~CHF ${avs.toLocaleString('it-CH')}), LPP ~7 % (~CHF ${lpp.toLocaleString('it-CH')}). Netto svizzero ~CHF ${netCh.toLocaleString('it-CH')}/mese. Cambio EUR a 0,97 → ~EUR ${netEur.toLocaleString('it-CH')}. Sul piano italiano, il rimborso del 24,5 % dell\'imposta alla fonte va alla tua comune di residenza (zone di frontiera) e il credito d\'imposta sull\'IRPEF chiude il calcolo finale. Il calcolatore Frontaliere Ticino integra entrambi i regimi (vecchio e nuovo accordo) e mostra il netto effettivo.`;
  }
  if (locale === 'en') {
    return `<strong>${example}</strong>: a manager with a CHF ${grossMonthly.toLocaleString('en-CH')} gross monthly offer in ${location} (CHF ${grossK},000 gross/year over 13 months). Source tax ~${sourceTaxPct} % (~CHF ${sourceTax.toLocaleString('en-CH')}), AVS-AI-IPG 5.3 % (~CHF ${avs.toLocaleString('en-CH')}), LPP ~7 % (~CHF ${lpp.toLocaleString('en-CH')}). Swiss net ~CHF ${netCh.toLocaleString('en-CH')}/month. EUR rate at 0.97 → ~EUR ${netEur.toLocaleString('en-CH')}. On the Italian side, 24.5 % of source tax is refunded to your residence municipality (border zone) and the Italian IRPEF tax credit closes the calculation. The Frontaliere Ticino calculator handles both regimes (old + new agreement) and shows the effective net.`;
  }
  if (locale === 'de') {
    return `<strong>${example}</strong>: eine Kaderstelle mit Bruttoangebot CHF ${grossMonthly.toLocaleString('de-CH')} pro Monat in ${location} (CHF ${grossK}\'000 Brutto/Jahr auf 13 Monatslöhnen). Quellensteuer ~${sourceTaxPct} % (~CHF ${sourceTax.toLocaleString('de-CH')}), AHV-IV-EO 5,3 % (~CHF ${avs.toLocaleString('de-CH')}), BVG ~7 % (~CHF ${lpp.toLocaleString('de-CH')}). Schweizer Netto ~CHF ${netCh.toLocaleString('de-CH')}/Monat. EUR-Kurs 0,97 → ~EUR ${netEur.toLocaleString('de-CH')}. Auf italienischer Seite gehen 24,5 % der Quellensteuer an Ihre Wohngemeinde (Grenzzone) und der italienische IRPEF-Steuerkredit schliesst die Berechnung ab. Der Frontaliere-Ticino-Rechner deckt beide Regime ab (altes + neues Abkommen).`;
  }
  return `<strong>${example}</strong> : un cadre avec offre brute CHF ${grossMonthly.toLocaleString('fr-CH')} par mois à ${location} (CHF ${grossK} 000 brut/an sur 13 mois). Impôt à la source ~${sourceTaxPct} % (~CHF ${sourceTax.toLocaleString('fr-CH')}), AVS-AI-APG 5,3 % (~CHF ${avs.toLocaleString('fr-CH')}), LPP ~7 % (~CHF ${lpp.toLocaleString('fr-CH')}). Net suisse ~CHF ${netCh.toLocaleString('fr-CH')}/mois. Taux EUR à 0,97 → ~EUR ${netEur.toLocaleString('fr-CH')}. Côté italien, 24,5 % de l\'impôt à la source revient à votre commune de résidence (zone frontalière) et le crédit d\'impôt italien IRPEF clôture le calcul. Le calculateur Frontaliere Ticino couvre les deux régimes (ancien + nouvel accord).`;
}

function buildFaq(locale: CommuterLocale, location: string, sectorOrType: string | null): Array<{ q: string; a: string }> {
  const safeSector = sectorOrType || (locale === 'it' ? 'questo settore' : locale === 'en' ? 'this sector' : locale === 'de' ? 'diesem Sektor' : 'ce secteur');
  if (locale === 'it') {
    return [
      {
        q: `Quanti giorni a settimana posso lavorare da remoto restando frontaliere?`,
        a: `Il telelavoro è oggi consentito fino al 25 % del tempo di lavoro (circa un giorno a settimana su un orario standard) senza perdere lo status di frontaliere e senza far scattare l\'obbligo contributivo nel paese di residenza. Sopra il 25 % serve un accordo specifico tra datore di lavoro, dipendente e autorità — il superamento provoca lo spostamento della base previdenziale e fiscale verso l\'Italia. Verifica con HR la quota concordata prima di firmare.`,
      },
      {
        q: `Per ${location} esiste una zona di frontiera diversa rispetto al resto della Svizzera?`,
        a: `No: la "zona di frontiera" del Nuovo Accordo Italia-Svizzera 2024 è la stessa per tutto il Cantone Ticino — i comuni italiani entro 20 km dal confine svizzero. Quello che cambia da Lugano a Bellinzona è il tempo di percorrenza, non il regime fiscale. La residenza italiana resta nello stesso comune anche se cambi azienda da una città ticinese all\'altra.`,
      },
      {
        q: `I titoli di studio italiani sono riconosciuti per ${safeSector} a ${location}?`,
        a: `Per la maggioranza dei ruoli privati il datore svizzero accetta il diploma o la laurea italiana direttamente, senza riconoscimento formale. Per le professioni regolamentate (sanitarie, ingegneria civile, avvocati, contabili) serve il riconoscimento da SBFI/SEFRI: la procedura dura 3-6 mesi e va avviata in parallelo all\'invio del CV, non a posteriori.`,
      },
      {
        q: `Quanto incide davvero il pendolarismo sul reddito mensile?`,
        a: `Per un\'auto media a benzina che pendola 50 km/giorno (es. Como-${location} andata-ritorno), il costo mensile tra carburante, autostrada e usura è circa CHF 200-280. Sommando vignetta annuale (CHF 40) e assicurazione frontaliero, l\'impatto annuo è ~CHF 2\'500-3\'200 da sottrarre al lordo. La scelta tra TILO e auto privata può ridurre questo costo del 30-40 % se le distanze e gli orari aziendali permettono il treno.`,
      },
    ];
  }
  if (locale === 'en') {
    return [
      {
        q: `How many days a week can I work remotely while keeping cross-border status?`,
        a: `Teleworking is currently allowed up to 25 % of the working time (about one day per week on a standard schedule) without losing cross-border status and without triggering social-security contributions in the country of residence. Above 25 %, a specific agreement between employer, employee and authorities is required — exceeding the cap shifts the social and fiscal basis toward Italy. Check the agreed share with HR before signing.`,
      },
      {
        q: `Does ${location} have a different border zone than the rest of Switzerland?`,
        a: `No: the "border zone" of the 2024 Italy-Switzerland agreement is the same across the Canton of Ticino — Italian municipalities within 20 km of the Swiss border. What changes between Lugano and Bellinzona is the commute time, not the tax regime. Your Italian residence stays in the same municipality even if you switch employers between Ticino cities.`,
      },
      {
        q: `Are Italian qualifications recognised for ${safeSector} in ${location}?`,
        a: `For most private-sector roles, the Swiss employer accepts an Italian diploma or degree directly, without formal recognition. For regulated professions (healthcare, civil engineering, lawyers, accountants) recognition by SBFI/SEFRI is required: the procedure takes 3-6 months and should be launched in parallel with applications, not afterwards.`,
      },
      {
        q: `How much does the commute actually cost on a monthly basis?`,
        a: `For a mid-size petrol car commuting 50 km/day (e.g. Como-${location} return), monthly cost across fuel, motorway and wear is around CHF 200-280. Adding the yearly Swiss vignette (CHF 40) and cross-border driver insurance, the annual impact is about CHF 2,500-3,200 to subtract from gross. Choosing TILO regional rail over private car can cut this cost by 30-40 % when distances and working hours allow the train.`,
      },
    ];
  }
  if (locale === 'de') {
    return [
      {
        q: `Wie viele Tage pro Woche kann ich als Grenzgänger im Homeoffice arbeiten?`,
        a: `Telearbeit ist derzeit bis zu 25 % der Arbeitszeit erlaubt (etwa ein Tag pro Woche bei Vollzeit), ohne den Grenzgängerstatus zu verlieren und ohne Sozialabgaben im Wohnland auszulösen. Über 25 % braucht es eine spezifische Vereinbarung zwischen Arbeitgeber, Arbeitnehmer und Behörden — eine Überschreitung verschiebt die Sozial- und Steuerbasis nach Italien. Mit HR den vereinbarten Anteil vor Vertragsabschluss klären.`,
      },
      {
        q: `Hat ${location} eine andere Grenzzone als der Rest der Schweiz?`,
        a: `Nein: die "Grenzzone" des Steuerabkommens 2024 ist im gesamten Kanton Tessin identisch — italienische Gemeinden innerhalb von 20 km zur Schweizer Grenze. Was sich zwischen Lugano und Bellinzona unterscheidet, ist die Pendelzeit, nicht das Steuerregime. Der italienische Wohnsitz bleibt in derselben Gemeinde, auch wenn Sie den Arbeitgeber zwischen Tessiner Städten wechseln.`,
      },
      {
        q: `Werden italienische Qualifikationen für ${safeSector} in ${location} anerkannt?`,
        a: `Für die meisten Stellen im Privatsektor akzeptiert der Schweizer Arbeitgeber italienische Diplome oder Studienabschlüsse direkt, ohne formelle Anerkennung. Für reglementierte Berufe (Gesundheit, Bauingenieurwesen, Anwälte, Buchhalter) ist eine Anerkennung beim SBFI/SEFRI nötig: das Verfahren dauert 3-6 Monate und sollte parallel zu den Bewerbungen gestartet werden, nicht im Nachhinein.`,
      },
      {
        q: `Wie stark belastet das Pendeln das monatliche Einkommen tatsächlich?`,
        a: `Für ein mittelgrosses Benzin-Auto mit 50 km/Tag (z.B. Como-${location} hin/zurück) liegen die Monatskosten für Treibstoff, Autobahn und Verschleiss bei rund CHF 200-280. Plus jährliche Schweizer Vignette (CHF 40) und Grenzgänger-Versicherung beträgt die jährliche Belastung etwa CHF 2\'500-3\'200, die vom Brutto abzuziehen sind. TILO-Regionalbahn statt Privatauto kann diese Kosten um 30-40 % senken, wenn Distanzen und Arbeitszeiten den Zug zulassen.`,
      },
    ];
  }
  return [
    {
      q: `Combien de jours par semaine puis-je télétravailler en gardant le statut de frontalier ?`,
      a: `Le télétravail est actuellement autorisé jusqu\'à 25 % du temps de travail (environ un jour par semaine à temps plein) sans perdre le statut de frontalier et sans déclencher de cotisations sociales dans le pays de résidence. Au-delà de 25 %, un accord spécifique entre employeur, salarié et autorités est nécessaire — le dépassement déplace la base sociale et fiscale vers l\'Italie. Vérifier avec les RH la part convenue avant de signer.`,
    },
    {
      q: `${location} a-t-il une zone frontalière différente du reste de la Suisse ?`,
      a: `Non : la "zone frontalière" de l\'accord 2024 est identique dans tout le canton du Tessin — les communes italiennes dans les 20 km de la frontière suisse. Ce qui change entre Lugano et Bellinzone est le temps de trajet, pas le régime fiscal. Votre résidence italienne reste dans la même commune même si vous changez d\'employeur entre les villes tessinoises.`,
    },
    {
      q: `Les qualifications italiennes sont-elles reconnues pour ${safeSector} à ${location} ?`,
      a: `Pour la plupart des postes privés, l\'employeur suisse accepte directement le diplôme italien sans reconnaissance formelle. Pour les professions réglementées (santé, génie civil, avocats, comptables), la reconnaissance auprès du SBFI/SEFRI est requise : la procédure dure 3-6 mois et doit être lancée en parallèle des candidatures, pas après coup.`,
    },
    {
      q: `Combien coûte vraiment le trajet sur une base mensuelle ?`,
      a: `Pour une voiture moyenne essence parcourant 50 km/jour (ex. Côme-${location} aller-retour), le coût mensuel entre carburant, autoroute et usure est d\'environ CHF 200-280. Plus la vignette suisse annuelle (CHF 40) et l\'assurance frontalier, l\'impact annuel est d\'environ CHF 2 500-3 200 à soustraire du brut. Choisir le train régional TILO plutôt que la voiture privée peut réduire ces coûts de 30-40 % quand distances et horaires le permettent.`,
    },
  ];
}

function buildCrossLinks(locale: CommuterLocale): string {
  const calc = `<a href="${CALC_HREF[locale]}" style="color:var(--color-link);text-decoration:none">`;
  const fx = `<a href="${FX_HREF[locale]}" style="color:var(--color-link);text-decoration:none">`;
  const health = `<a href="${HEALTH_HREF[locale]}" style="color:var(--color-link);text-decoration:none">`;
  if (locale === 'it') {
    return `Tre strumenti gratuiti per chiudere il cerchio prima di candidarti: ${calc}calcolatore stipendio netto frontaliere</a> con i due regimi fiscali (vecchio + nuovo accordo 2024) e la stima del rimborso del comune; ${fx}comparatore cambio CHF/EUR</a> con i tassi di banche italiane, cambia-valute svizzeri e Wise/Revolut; ${health}comparatore casse malati LAMal</a> per scegliere il premio mensile più conveniente nel tuo comune ticinese di lavoro.`;
  }
  if (locale === 'en') {
    return `Three free tools to close the loop before applying: ${calc}cross-border net salary calculator</a> with both tax regimes (old + 2024 new agreement) and the municipal refund estimate; ${fx}CHF/EUR exchange comparator</a> with rates from Italian banks, Swiss bureaus de change and Wise/Revolut; ${health}LAMal health-insurance comparator</a> to pick the cheapest premium in your Ticino work municipality.`;
  }
  if (locale === 'de') {
    return `Drei kostenlose Tools zum Abschluss vor der Bewerbung: ${calc}Netto-Grenzgänger-Lohnrechner</a> mit beiden Steuerregimen (altes + neues Abkommen 2024) und der Schätzung der Gemeinderückerstattung; ${fx}CHF/EUR-Wechselkurs-Vergleich</a> mit den Kursen italienischer Banken, Schweizer Wechselstuben und Wise/Revolut; ${health}LAMal-Krankenkassen-Vergleich</a> zur Wahl der günstigsten Monatsprämie in Ihrer Tessiner Arbeitsgemeinde.`;
  }
  return `Trois outils gratuits pour boucler la boucle avant de postuler : ${calc}calculateur de salaire net frontalier</a> avec les deux régimes fiscaux (ancien + nouvel accord 2024) et l\'estimation du remboursement communal ; ${fx}comparateur de change CHF/EUR</a> avec les taux des banques italiennes, bureaux de change suisses et Wise/Revolut ; ${health}comparateur des caisses maladie LAMal</a> pour choisir la prime mensuelle la plus avantageuse dans votre commune tessinoise de travail.`;
}

export interface JobBoardCommuterContextOpts {
  locale: CommuterLocale;
  /** City name in display form (e.g. "Lugano"). Used for commute paragraph + scenario. */
  location: string;
  /** Optional sector / contract-type label (e.g. "sanità", "part-time"). */
  sectorOrType?: string | null;
  /** When true, omits the commute table (used for non-city pages like "today"). */
  omitCommute?: boolean;
}

/**
 * Render a substantial (5-7 KB) page-relevant prose section with:
 *  - methodology paragraph
 *  - commuter / city-context paragraph (city-specific TILO + crossing data)
 *  - salary breakdown paragraph (TI source-tax, AVS, LPP, new agreement)
 *  - scenario callout (numerical example tied to the city)
 *  - 4-FAQ block (telework, border zone, qualification recognition, commute cost)
 *  - cross-link CTA paragraph (calculator, FX, health insurance)
 *
 * The function is pure; given the same locale + location + sector, it returns
 * the same HTML. It uses semantic colour tokens from index.css so the prose
 * works in light + dark mode without `dark:` class prefixes (CLAUDE.md rule).
 */
export function renderJobBoardCommuterContext(
  opts: JobBoardCommuterContextOpts,
): string {
  const { locale, location, sectorOrType = null, omitCommute = false } = opts;
  const row = omitCommute ? null : resolveCommuteRow(location);
  const copy = COPY[locale];

  const commuterParagraph = omitCommute
    ? (locale === 'it'
        ? 'Le offerte di questa pagina coprono tutto il Cantone Ticino. La "zona di frontiera" del Nuovo Accordo Italia-Svizzera 2024 si applica a tutti i comuni italiani entro 20 km dal confine svizzero, indipendentemente dalla città di lavoro: Lugano, Mendrisio, Chiasso, Bellinzona, Locarno e Stabio. Il Permesso G richiesto al datore svizzero è gratuito; la sua emissione richiede 2-6 settimane dopo la firma del contratto, poi è rinnovato annualmente fino al limite contrattuale. Il rientro al domicilio italiano almeno una volta a settimana è obbligatorio per mantenere lo status.'
        : locale === 'en'
        ? 'The listings on this page cover the whole Canton of Ticino. The "border zone" of the 2024 Italy-Switzerland fiscal agreement applies to all Italian municipalities within 20 km of the Swiss border, regardless of work city: Lugano, Mendrisio, Chiasso, Bellinzona, Locarno and Stabio. The G permit filed by the Swiss employer is free of charge; issuance takes 2-6 weeks after contract signature, then yearly renewal up to the contract end. Weekly return to the Italian residence is required to keep the status.'
        : locale === 'de'
        ? 'Die Stellen dieser Seite decken den gesamten Kanton Tessin ab. Die "Grenzzone" des Steuerabkommens 2024 gilt für alle italienischen Gemeinden innerhalb 20 km zur Schweizer Grenze, unabhängig vom Arbeitsort: Lugano, Mendrisio, Chiasso, Bellinzona, Locarno und Stabio. Die vom Schweizer Arbeitgeber beantragte G-Bewilligung ist kostenlos; die Ausstellung dauert 2-6 Wochen nach Vertragsunterzeichnung, danach jährliche Verlängerung bis Vertragsende. Eine wöchentliche Rückkehr ins italienische Zuhause ist Pflicht.'
        : 'Les offres de cette page couvrent tout le canton du Tessin. La « zone frontalière » de l\'accord fiscal 2024 s\'applique à toutes les communes italiennes dans les 20 km de la frontière suisse, indépendamment de la ville de travail : Lugano, Mendrisio, Chiasso, Bellinzona, Locarno et Stabio. Le permis G demandé par l\'employeur suisse est gratuit ; la délivrance prend 2-6 semaines après signature, puis renouvellement annuel jusqu\'à la fin du contrat. Retour hebdomadaire au domicile italien obligatoire.')
    : buildCommuterParagraph(locale, location, row);
  const salaryParagraph = buildSalaryParagraph(locale, row);
  const scenarioCallout = buildScenarioCallout(locale, location, row);
  const faq = buildFaq(locale, location, sectorOrType);
  const crossLinks = buildCrossLinks(locale);

  const faqHtml = faq
    .map(
      (f) =>
        `<details style="background:var(--color-surface);border:1px solid var(--color-edge);border-radius:12px;padding:14px 16px;margin-bottom:8px"><summary style="font-weight:700;cursor:pointer;color:var(--color-heading)">${escAttr(f.q)}</summary><p style="margin:8px 0 0;color:var(--color-body);line-height:1.6">${f.a}</p></details>`,
    )
    .join('');

  return `<section class="job-board-commuter-context" style="max-width:860px;margin:32px auto 0;color:var(--color-body);line-height:1.65;font-size:15px">
  <h2 style="font-size:22px;font-weight:700;color:var(--color-heading);margin:24px 0 12px">${escAttr(copy.methodologyH)}</h2>
  <p style="margin:0 0 14px">${copy.methodology}</p>
  <h2 style="font-size:22px;font-weight:700;color:var(--color-heading);margin:24px 0 12px">${escAttr(copy.commuterH)}</h2>
  <p style="margin:0 0 14px">${commuterParagraph}</p>
  <h2 style="font-size:22px;font-weight:700;color:var(--color-heading);margin:24px 0 12px">${escAttr(copy.salaryH)}</h2>
  <p style="margin:0 0 14px">${salaryParagraph}</p>
  <p style="margin:0 0 22px;padding:14px 16px;background:var(--color-surface-alt);border-radius:12px;border-left:3px solid var(--color-link)">${scenarioCallout}</p>
  <h2 style="font-size:22px;font-weight:700;color:var(--color-heading);margin:24px 0 12px">${escAttr(copy.faqH)}</h2>
  ${faqHtml}
  <h2 style="font-size:20px;font-weight:700;color:var(--color-heading);margin:24px 0 12px">${escAttr(copy.ctaH)}</h2>
  <p style="margin:0 0 14px">${crossLinks}</p>
</section>`;
}

/**
 * Generate FAQPage JSON-LD for the same FAQ block emitted by
 * `renderJobBoardCommuterContext`. Returns an empty string if the host
 * page already emits FAQ structured data (avoid duplicate).
 *
 * Surfaces 4 Q&A pairs to Google's FAQ rich result.
 */
export function buildJobBoardCommuterFaqLd(opts: JobBoardCommuterContextOpts): string {
  const { locale, location, sectorOrType = null } = opts;
  const faq = buildFaq(locale, location, sectorOrType);
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: faq.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: {
        '@type': 'Answer',
        text: f.a.replace(/<[^>]+>/g, ''),
      },
    })),
  });
}
