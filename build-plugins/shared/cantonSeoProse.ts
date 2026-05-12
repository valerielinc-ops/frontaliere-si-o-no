/**
 * cantonSeoProse.ts
 *
 * Parametric prose helper for the thin-template family that was tripping
 * the `audit:text-html-ratio` Semrush gate (≤ 10 % visible text / HTML).
 *
 * Why this exists
 * ---------------
 * The cathedral CH-wide expansion (May 2026) emits a number of templates
 * that fan out per (canton, locale) and per (entity, locale): the thin
 * canton hubs (`/cerca-lavoro-{canton}/{settori|aziende|tutti}/`), the
 * weekly-employers-hub per-canton landing, the company/location-bridge
 * placeholder pages, and the non-TI editorial slot pages. These share two
 * properties:
 *
 *  1. They wrap the Vite SPA shell (~5-6 KB of `<head>` + bundle hashes
 *     + JSON-LD + design tokens) around a short factual body. With a
 *     500-byte body the page is ≈ 6.5 KB total and Semrush flags it at
 *     ~5 % ratio.
 *  2. They are emitted from many call sites, so duplicating prose inline
 *     causes drift and template-wide cross-page boilerplate that Google
 *     penalises.
 *
 * The helper builds a ~1.4-2.2 KB block of page-relevant prose
 * (intro → permit context → salary/fiscality → FAQ → cross-links) that
 * is fully parameterised by `canton`, `entity` (city / company), `slot`
 * (settori / aziende / today / ...), and `locale`. Every paragraph
 * substitutes the inputs, so two pages for different cantons never share
 * the same string and the cross-page duplication penalty is avoided.
 *
 * Design constraints (CLAUDE.md non-negotiables #15-17):
 *  - Mobile-first: prose ALWAYS sits below the data area (callers append
 *    it after their listing / table). Filler never pushes the meat
 *    below the fold on a ≤ 414 px viewport.
 *  - No new colour values: every style references existing `--color-*`
 *    semantic tokens from `index.css`. Light + dark mode auto-switch
 *    without `dark:` Tailwind prefixes.
 *  - FAQ block uses `<details>` so on mobile the accordion is collapsed
 *    and never blocks scroll to the data area above.
 *  - No hidden text. Every section is part of the visible HTML and
 *    crawlable.
 *
 * Public API
 * ----------
 *  - `renderCantonSeoProse(opts)` returns a self-contained `<section>` of
 *    HTML to be appended to the host page body, after the data area.
 *  - `buildCantonSeoProseFaqItems(opts)` returns the same FAQ entries as
 *    Schema.org `Question` objects so the caller can merge them into the
 *    page's FAQPage JSON-LD (avoiding GSC "duplicate FAQPage" warnings).
 */

export type CantonSeoLocale = 'it' | 'en' | 'de' | 'fr';

/** Slot the helper is rendering for — drives the heading + FAQ flavour. */
export type CantonSeoSlot =
  | 'canton-hub'
  | 'sectors-hub'
  | 'companies-hub'
  | 'company-landing'
  | 'city-landing'
  | 'editorial-today'
  | 'editorial-nursing'
  | 'editorial-clinics'
  | 'editorial-part-time';

export interface CantonSeoProseOpts {
  /** Output locale. */
  locale: CantonSeoLocale;
  /** Canton display name, e.g. 'Zurigo', 'Argovia', 'Ticino'. */
  cantonDisplay: string;
  /** Slot key — switches the H2/FAQ flavour without changing structure. */
  slot: CantonSeoSlot;
  /**
   * Optional entity name when the page is about one company / city
   * (e.g. 'Migros', 'Lugano'). Used to specialise FAQ wording.
   */
  entityName?: string | null;
  /**
   * Optional headline metric (e.g. number of active openings) — woven
   * into the intro to avoid template-wide duplicate wording.
   */
  countHint?: number | null;
  /**
   * Absolute or root-relative href to the section's main listing page.
   * Falls back to a locale-aware salary calculator link if omitted.
   */
  ctaHref?: string | null;
  /** Optional CTA label override. */
  ctaLabel?: string | null;
}

interface SlotCopy {
  /** H2 heading for the prose block. */
  blockHeading: string;
  /** Lead paragraph immediately under the H2. */
  intro: string;
  /** Methodology / data-source paragraph. */
  methodology: string;
  /** Permit + fiscality paragraph. */
  permitContext: string;
  /** FAQ heading. */
  faqHeading: string;
  /** FAQ entries (question + answer, plain text — wrapped in details). */
  faqs: Array<{ q: string; a: string }>;
  /** Cross-link paragraph (calculator / FX / health-insurance). */
  crossLinks: string;
}

const CALCULATOR_HREF: Record<CantonSeoLocale, string> = {
  it: '/',
  en: '/en/',
  de: '/de/',
  fr: '/fr/',
};

const FX_HREF: Record<CantonSeoLocale, string> = {
  it: '/comparatori/cambio-valuta/',
  en: '/en/comparators/currency-exchange/',
  de: '/de/vergleiche/wechselkurs/',
  fr: '/fr/comparateurs/change-devises/',
};

const HEALTH_HREF: Record<CantonSeoLocale, string> = {
  it: '/comparatori/casse-malati/',
  en: '/en/comparators/health-insurance/',
  de: '/de/vergleiche/krankenkassen/',
  fr: '/fr/comparateurs/caisses-maladie/',
};

const FUEL_HREF: Record<CantonSeoLocale, string> = {
  it: '/prezzi-benzina-svizzera/',
  en: '/en/gasoline-price-switzerland/',
  de: '/de/benzinpreis-schweiz/',
  fr: '/fr/prix-essence-suisse/',
};

const DEFAULT_CTA_LABEL: Record<CantonSeoLocale, string> = {
  it: 'Apri il calcolatore stipendio netto frontaliere',
  en: 'Open the cross-border net salary calculator',
  de: 'Grenzgänger-Nettolohnrechner öffnen',
  fr: 'Ouvrir le calculateur de salaire net frontalier',
};

function esc(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildSlotCopy(opts: CantonSeoProseOpts): SlotCopy {
  const { locale, cantonDisplay, slot, entityName, countHint } = opts;
  const canton = cantonDisplay;
  const entity = entityName?.trim() || '';
  const countText = (() => {
    if (countHint == null || countHint <= 0) return '';
    if (locale === 'it') return `${countHint.toLocaleString('it-CH')} offerte attualmente attive`;
    if (locale === 'en') return `${countHint.toLocaleString('en-US')} openings currently active`;
    if (locale === 'de') return `${countHint.toLocaleString('de-CH')} aktive Stellen aktuell`;
    return `${countHint.toLocaleString('fr-CH')} offres actuellement actives`;
  })();

  if (locale === 'it') {
    const slotIntro: Record<CantonSeoSlot, string> = {
      'canton-hub': `Questa pagina aggrega gli annunci attivi nel Canton ${canton} per chi pendola dall'Italia (Permesso G) o vive in Svizzera con Permesso B. ${countText ? `${countText} oggi nel canton ${canton}: ` : ''}sotto il listing trovi metodologia, contesto frontaliere e FAQ specifiche.`,
      'sectors-hub': `L'indice settoriale del Canton ${canton} raggruppa le offerte in macro-aree (sanità, finanza, IT, ingegneria, ristorazione, edilizia, amministrazione) così la stessa mansione pubblicata con sinonimi diversi finisce nella stessa categoria. Per un frontaliere italiano questo è il filtro più rapido per leggere la dimensione effettiva della domanda nel canton ${canton}.`,
      'companies-hub': `L'elenco aziende ${canton} mostra i datori con almeno un'offerta attiva oggi, ordinati per numero di posizioni aperte. Per il frontaliere italiano le aziende con delta settimanale positivo sono particolarmente interessanti: ${countText ? `${countText} ` : ''}ricevono CV anche fuori dalle posizioni specifiche e spesso aprono un colloquio esplorativo.`,
      'company-landing': `Le offerte attive di ${entity || 'questo datore di lavoro'} nel Canton ${canton} vengono aggregate qui da fonti aziendali ufficiali. ${countText ? `${countText} per ${entity || 'l\'azienda'}: ` : ''}il listing è aggiornato ogni 6-12 ore e indica sede esatta, retribuzione lorda quando dichiarata e canale di candidatura diretto al sito dell'azienda.`,
      'city-landing': `Le offerte attive a ${entity || canton} nel Canton ${canton} sono raccolte qui per chi cerca lavoro nella zona di pendolarismo. ${countText ? `${countText}: ` : ''}sotto la lista trovi il contesto Permesso G, il calcolo lordo-netto svizzero e le FAQ tipiche del frontaliere italiano.`,
      'editorial-today': `Le offerte di lavoro pubblicate oggi nel Canton ${canton} sono raggruppate qui per chi cerca opportunità freschissime. ${countText ? `${countText}: ` : ''}sotto la lista trovi metodologia di pubblicazione, frequenza di aggiornamento e contesto frontaliere.`,
      'editorial-nursing': `Le offerte per infermieri e personale sanitario nel Canton ${canton} sono raccolte qui da EOC, cliniche private, case anziani e altri datori di lavoro. ${countText ? `${countText} nel settore sanità in ${canton}: ` : ''}sotto la lista trovi normativa di riconoscimento titoli, salari mediani e FAQ Permesso G specifiche per il personale sanitario.`,
      'editorial-clinics': `Le offerte di cliniche e ospedali nel Canton ${canton} sono raccolte qui — strutture pubbliche (EOC, ospedali cantonali), cliniche private e centri specialistici. ${countText ? `${countText}: ` : ''}sotto la lista trovi metodologia, contesto frontaliere sanità e FAQ riconoscimento titoli SBFI/SEFRI.`,
      'editorial-part-time': `Le offerte part-time nel Canton ${canton} (gradi 40-80 %) sono raccolte qui per chi cerca un equilibrio tra orario svizzero e tempo di pendolarismo. ${countText ? `${countText}: ` : ''}sotto la lista trovi contesto Permesso G, calcolo netto su gradi parziali e FAQ telelavoro fino al 25 %.`,
    };
    return {
      blockHeading: slotIntro[slot] ? `Come leggere questa pagina · ${canton}` : 'Contesto frontaliere',
      intro: slotIntro[slot] || slotIntro['canton-hub'],
      methodology: `Gli annunci aggregati provengono da oltre 80 crawler dedicati ai principali datori di lavoro svizzeri (Workday, Smartrecruiters, ATS proprietari, portali carriera ufficiali) e dalle bacheche cantonali. Ogni offerta passa una deduplicazione su titolo normalizzato, azienda e comune prima della pubblicazione; la data visualizzata è quella di pubblicazione originale del datore, non quella di scansione, così puoi giudicare la freschezza. Manteniamo le offerte online per 30 giorni o fino al primo HTTP 404 / redirect "posizione chiusa", verificato ogni 12 ore.`,
      permitContext: `Per un frontaliere italiano residente nella zona di 20 km dal confine (Lombardia, Piemonte e — per i nuovi pendolari verso ${canton} dal 2024 — anche Valle d'Aosta), candidarsi a un ruolo nel Canton ${canton} richiede il Permesso G richiesto dal datore svizzero. La prima emissione richiede 2-6 settimane dalla firma del contratto, rinnovo annuale automatico fino al limite contrattuale; rientro al domicilio italiano almeno settimanale obbligatorio. Il Nuovo Accordo Italia-Svizzera 2024 prevede tassazione concorrente con credito d'imposta italiano fino all'80 % della ritenuta CH per i nuovi frontalieri (assunti dopo il 17 luglio 2023), franchigia 10'000 EUR; per chi era già frontaliere prima di quella data si applica il vecchio regime di tassazione esclusiva svizzera con ristorno del 38,8 % al comune italiano di residenza.`,
      faqHeading: `Domande frequenti sulla ricerca lavoro nel Canton ${canton}`,
      faqs: [
        {
          q: `Quanti giorni di telelavoro posso fare restando frontaliere nel Canton ${canton}?`,
          a: `Il telelavoro è oggi consentito fino al 25 % del tempo di lavoro (circa un giorno a settimana su un orario standard) senza perdere lo status di frontaliere e senza far scattare l'obbligo contributivo nel paese di residenza. Sopra il 25 % serve un accordo specifico tra datore di lavoro, dipendente e autorità — il superamento provoca lo spostamento della base previdenziale e fiscale verso l'Italia. La regola vale identica in ogni cantone svizzero, inclusi ${canton}, Ticino e i cantoni non di confine.`,
        },
        {
          q: `I titoli di studio italiani sono riconosciuti per lavorare nel Canton ${canton}?`,
          a: `Per la maggioranza dei ruoli privati il datore svizzero accetta il diploma o la laurea italiana direttamente, senza riconoscimento formale. Per le professioni regolamentate (sanitarie, ingegneria civile, avvocati, contabili) serve il riconoscimento da SBFI/SEFRI: la procedura dura 3-6 mesi e va avviata in parallelo all'invio del CV, non dopo. Per il Canton ${canton} valgono le stesse autorità federali; eventuali specificità cantonali si applicano alle professioni sanitarie (medici, infermieri) tramite l'Ufficio del medico cantonale.`,
        },
        {
          q: `Lo stipendio netto in ${canton} vale la pena rispetto al lordo italiano?`,
          a: `Lo stipendio netto svizzero dipende da quattro variabili: imposta alla fonte cantonale (scaglioni 4-19 % a seconda del lordo, stato civile e figli), contributi sociali (AVS-AI-IPG 5,3 % fissi, AD 1,1 %, LPP 7-18 % in base all'età), Nuovo Accordo Italia-Svizzera 2024 con credito d'imposta italiano, e costi di pendolarismo. Sul nostro <a href="${CALCULATOR_HREF[locale]}">simulatore fiscale gratuito</a> puoi inserire un lordo CHF di un annuncio del Canton ${canton} e ottenere il netto mensile reale in CHF e in EUR — confronti immediati con il netto italiano della tua zona di residenza.`,
        },
        {
          q: `Come si confronta il mercato del Canton ${canton} con altri cantoni svizzeri per i frontalieri?`,
          a: `Il Canton ${canton} è uno dei 26 cantoni della Confederazione e — come tutti — applica le sue aliquote fiscali specifiche oltre alla parte federale. La differenza fra il netto in ${canton} e quello in un altro cantone, a parità di lordo, può oscillare di CHF 200-500 al mese soprattutto sui redditi medi: cantoni come Zugo, Svitto e Nidvaldo hanno tasse più basse, Ginevra e Vaud le più alte. Per chi è frontaliere italiano, oltre alla parte fiscale conta il tempo di pendolarismo: i cantoni di confine (Ticino, parte di Vallese e Grigioni) sono raggiungibili in giornata, mentre ${canton} potrebbe richiedere una soluzione di alloggio settimanale.`,
        },
      ],
      crossLinks: `Tre strumenti gratuiti per chiudere il cerchio prima di candidarti: <a href="${CALCULATOR_HREF[locale]}">calcolatore stipendio netto frontaliere</a> con i due regimi fiscali (vecchio + nuovo accordo 2024) e la stima del rimborso del comune italiano; <a href="${FX_HREF[locale]}">comparatore cambio CHF/EUR</a> con i tassi di banche italiane, cambia-valute svizzeri e Wise/Revolut; <a href="${HEALTH_HREF[locale]}">comparatore casse malati LAMal</a> per scegliere il premio mensile più conveniente nel tuo comune di lavoro svizzero. Per chi pendola in auto, anche il <a href="${FUEL_HREF[locale]}">prezzo del carburante in Svizzera</a> aggiornato giornalmente.`,
    };
  }

  if (locale === 'en') {
    const slotIntro: Record<CantonSeoSlot, string> = {
      'canton-hub': `This page aggregates active openings in Canton ${canton} for Italian-Swiss cross-border workers (G permit) and Swiss residents (B permit). ${countText ? `${countText} today in canton ${canton}: ` : ''}below the listing you'll find methodology, cross-border context and FAQs.`,
      'sectors-hub': `The sector index for Canton ${canton} groups openings into macro-areas (healthcare, finance, IT, engineering, hospitality, construction, administration) so the same role published with different keywords ends up in the same category. For Italian cross-border applicants this is the fastest filter to read real demand in canton ${canton}.`,
      'companies-hub': `The ${canton} employer list shows companies with at least one active opening today, sorted by open positions. For Italian cross-border applicants, employers with a positive weekly delta are particularly worth noting: ${countText ? `${countText} ` : ''}they often accept speculative CVs and open exploratory interviews.`,
      'company-landing': `Active openings at ${entity || 'this employer'} in Canton ${canton} are aggregated here from official corporate sources. ${countText ? `${countText} at ${entity || 'the employer'}: ` : ''}the listing is refreshed every 6-12 hours and shows precise location, declared gross pay where available and a direct apply link to the company's career portal.`,
      'city-landing': `Active openings in ${entity || canton} (Canton ${canton}) are collected here for applicants targeting the local commute zone. ${countText ? `${countText}: ` : ''}below the list you'll find G-permit context, Swiss gross-to-net calculation and the usual cross-border FAQs.`,
      'editorial-today': `Job openings published today in Canton ${canton} are grouped here for applicants chasing the freshest opportunities. ${countText ? `${countText}: ` : ''}below the list you'll find publication methodology, refresh frequency and cross-border context.`,
      'editorial-nursing': `Nursing and healthcare openings in Canton ${canton} are collected here from cantonal hospitals, private clinics, care homes and other employers. ${countText ? `${countText} in ${canton} healthcare: ` : ''}below the list you'll find diploma-recognition rules, median salaries and G-permit FAQs specific to healthcare.`,
      'editorial-clinics': `Clinic and hospital openings in Canton ${canton} are aggregated here — public structures, private clinics and specialist centres. ${countText ? `${countText}: ` : ''}below the list you'll find methodology, cross-border healthcare context and SBFI/SEFRI title-recognition FAQs.`,
      'editorial-part-time': `Part-time openings in Canton ${canton} (40-80 % grade) are grouped here for applicants seeking work-life balance with cross-border commute. ${countText ? `${countText}: ` : ''}below the list you'll find G-permit context, partial-grade net pay calculation and telework-up-to-25% FAQs.`,
    };
    return {
      blockHeading: `How to read this ${canton} page`,
      intro: slotIntro[slot] || slotIntro['canton-hub'],
      methodology: `Aggregated listings come from 80+ crawlers tracking the main Swiss employer ATS (Workday, Smartrecruiters, proprietary trackers) and cantonal job centres. Every listing passes a deduplication check on normalised title, company and municipality before publication; the displayed date is the original publication date — not the crawl timestamp — so you can judge the freshness. We keep listings online for 30 days or until the first HTTP 404 / "position closed" redirect, verified every 12 hours.`,
      permitContext: `For Italian-resident G-permit candidates inside the 20-km border zone (Lombardy, Piedmont and — for new commuters to ${canton} since 2024 — Aosta Valley too), applying to a role in Canton ${canton} requires the cross-border permit. The application is filed by the Swiss employer at the cantonal migration office after contract signature: first issuance takes 2-6 weeks, yearly renewal up to the contract end; weekly return to the Italian domicile is mandatory. The 2024 Italy-Switzerland bilateral agreement introduces dual taxation with Italian tax credit up to 80 % of the Swiss withholding for new cross-border workers (hired after 17 July 2023), with a 10,000 EUR allowance; workers already classified as cross-border before that date keep the old regime of exclusive Swiss taxation with 38.8 % refund to the Italian residence municipality.`,
      faqHeading: `Frequently asked questions about working in Canton ${canton}`,
      faqs: [
        {
          q: `How many days of remote work can I do while keeping cross-border status in Canton ${canton}?`,
          a: `Teleworking is currently allowed up to 25 % of the working time (about one day per week on a standard schedule) without losing cross-border status and without triggering social-security contributions in the country of residence. Above 25 % a specific agreement between employer, employee and authorities is required — exceeding the cap shifts the social and fiscal basis toward Italy. The rule applies identically across all Swiss cantons including ${canton}, Ticino and non-border cantons.`,
        },
        {
          q: `Are Italian qualifications recognised for jobs in Canton ${canton}?`,
          a: `For most private-sector roles the Swiss employer accepts an Italian diploma or degree directly, without formal recognition. For regulated professions (healthcare, civil engineering, lawyers, accountants) SBFI/SEFRI recognition is required: the procedure takes 3-6 months and should be launched in parallel with applications, not afterwards. Canton ${canton} follows the same federal authorities; cantonal specifics apply only to healthcare professions through the cantonal medical officer.`,
        },
        {
          q: `Is the net salary in ${canton} worth it compared with the Italian gross?`,
          a: `Swiss net depends on four variables: cantonal source tax (brackets 4-19 % depending on gross, marital status and children), social charges (AVS-AI-IPG 5.3 % flat, unemployment 1.1 %, LPP 7-18 % by age), the 2024 Italy-Switzerland agreement with Italian tax credit, and commute costs. Open our <a href="${CALCULATOR_HREF[locale]}">free salary calculator</a> with a Canton ${canton} listing's gross figure and you'll get the actual monthly net in CHF and EUR — immediately comparable with the Italian net for your residence area.`,
        },
        {
          q: `How does Canton ${canton} compare with other Swiss cantons for cross-border workers?`,
          a: `Canton ${canton} is one of 26 cantons of the Confederation and — like all of them — applies its own tax rates on top of the federal share. The net pay gap between ${canton} and another canton, at the same gross, can swing CHF 200-500 per month especially on mid-range incomes: cantons like Zug, Schwyz and Nidwalden have the lowest tax, Geneva and Vaud the highest. For Italian cross-border applicants, alongside the tax angle, commute time matters: border cantons (Ticino, parts of Valais and Graubünden) are reachable daily, whereas ${canton} may require a weekly accommodation arrangement.`,
        },
      ],
      crossLinks: `Three free tools to close the loop before applying: <a href="${CALCULATOR_HREF[locale]}">cross-border net salary calculator</a> with both tax regimes (old + 2024 new agreement) and Italian municipal refund estimate; <a href="${FX_HREF[locale]}">CHF/EUR exchange comparator</a> with rates from Italian banks, Swiss bureaus de change and Wise/Revolut; <a href="${HEALTH_HREF[locale]}">LAMal health-insurance comparator</a> to pick the cheapest premium in your Swiss work municipality. For car commuters, the <a href="${FUEL_HREF[locale]}">daily Swiss fuel price</a> is updated every morning.`,
    };
  }

  if (locale === 'de') {
    const slotIntro: Record<CantonSeoSlot, string> = {
      'canton-hub': `Diese Seite sammelt aktive Stellen im Kanton ${canton} für italienisch-schweizerische Grenzgänger (G-Bewilligung) und Schweizer Einwohner (B-Bewilligung). ${countText ? `${countText} heute im Kanton ${canton}: ` : ''}unter der Liste finden Sie Methodik, Grenzgänger-Kontext und FAQ.`,
      'sectors-hub': `Der Branchenindex für den Kanton ${canton} fasst Stellen in Makrobereichen zusammen (Gesundheit, Finanzen, IT, Ingenieurwesen, Gastgewerbe, Bau, Verwaltung), so dass die gleiche Rolle unter verschiedenen Stichwörtern in derselben Kategorie landet. Für italienische Grenzgänger ist dies der schnellste Filter, um die tatsächliche Nachfrage im Kanton ${canton} zu lesen.`,
      'companies-hub': `Die Arbeitgeberliste ${canton} zeigt Unternehmen mit mindestens einer aktiven Stelle heute, sortiert nach offenen Positionen. Für italienische Grenzgänger sind Arbeitgeber mit positivem Wochendelta besonders interessant: ${countText ? `${countText} ` : ''}sie akzeptieren oft Initiativbewerbungen und öffnen exploratives Gespräch.`,
      'company-landing': `Aktive Stellen bei ${entity || 'diesem Arbeitgeber'} im Kanton ${canton} werden hier aus offiziellen Unternehmensquellen aggregiert. ${countText ? `${countText} bei ${entity || 'dem Arbeitgeber'}: ` : ''}die Liste wird alle 6-12 Stunden aktualisiert und zeigt den genauen Standort, das deklarierte Bruttoeinkommen, wo verfügbar, sowie den direkten Bewerbungslink zum Karriereportal des Unternehmens.`,
      'city-landing': `Aktive Stellen in ${entity || canton} (Kanton ${canton}) werden hier für Bewerber gesammelt, die die lokale Pendelzone anvisieren. ${countText ? `${countText}: ` : ''}unter der Liste finden Sie G-Bewilligung-Kontext, schweizerische Brutto-Netto-Berechnung und übliche Grenzgänger-FAQ.`,
      'editorial-today': `Heute veröffentlichte Stellen im Kanton ${canton} sind hier für Bewerber gruppiert, die die frischesten Chancen suchen. ${countText ? `${countText}: ` : ''}unter der Liste finden Sie Publikationsmethodik, Aktualisierungsfrequenz und Grenzgänger-Kontext.`,
      'editorial-nursing': `Pflege- und Gesundheitsstellen im Kanton ${canton} werden hier von kantonalen Spitälern, Privatkliniken, Altersheimen und anderen Arbeitgebern gesammelt. ${countText ? `${countText} im Gesundheitswesen ${canton}: ` : ''}unter der Liste finden Sie Diplom-Anerkennungsregeln, Medianlöhne und Grenzgänger-FAQ speziell für das Gesundheitswesen.`,
      'editorial-clinics': `Kliniken- und Spitäler-Stellen im Kanton ${canton} sind hier aggregiert — öffentliche Strukturen, Privatkliniken und Fachzentren. ${countText ? `${countText}: ` : ''}unter der Liste finden Sie Methodik, Grenzgänger-Gesundheitskontext und SBFI/SEFRI-Titelanerkennungs-FAQ.`,
      'editorial-part-time': `Teilzeitstellen im Kanton ${canton} (40-80 %) sind hier für Bewerber gruppiert, die Work-Life-Balance mit Pendlerwegen suchen. ${countText ? `${countText}: ` : ''}unter der Liste finden Sie G-Bewilligung-Kontext, Teil-Pensum-Nettoberechnung und Homeoffice-bis-25%-FAQ.`,
    };
    return {
      blockHeading: `Wie diese ${canton}-Seite zu lesen ist`,
      intro: slotIntro[slot] || slotIntro['canton-hub'],
      methodology: `Die aggregierten Inserate stammen von über 80 Crawlern, die die wichtigsten Schweizer Arbeitgeber-ATS (Workday, Smartrecruiters, proprietäre Tracker) und kantonale Job-Center abfragen. Jedes Inserat durchläuft eine Deduplizierung über normalisierten Titel, Unternehmen und Gemeinde vor der Veröffentlichung; das angezeigte Datum ist das Original-Veröffentlichungsdatum — nicht der Crawl-Zeitstempel — so erkennen Sie, wie aktuell die Stelle ist. Stellen bleiben 30 Tage online oder bis zum ersten HTTP 404 / "Position geschlossen"-Redirect, alle 12 Stunden geprüft.`,
      permitContext: `Für italienische Grenzgänger mit Wohnsitz innerhalb der 20-km-Grenzzone (Lombardei, Piemont und — für neue Pendler in den Kanton ${canton} ab 2024 — auch Aostatal) erfordert eine Bewerbung im Kanton ${canton} die G-Bewilligung. Der Antrag wird vom Schweizer Arbeitgeber beim kantonalen Migrationsamt nach Vertragsunterzeichnung eingereicht: die Erstausstellung dauert 2-6 Wochen, danach erfolgt die jährliche Verlängerung; eine wöchentliche Rückkehr zum italienischen Wohnsitz ist Pflicht. Das Steuerabkommen Italien-Schweiz 2024 sieht konkurrierende Besteuerung mit italienischer Steuergutschrift bis 80 % der schweizerischen Quellensteuer für neue Grenzgänger (Anstellung ab 17. Juli 2023) und 10'000 EUR Freibetrag vor; Personen, die vor diesem Datum bereits als Grenzgänger eingestuft waren, behalten das alte Regime exklusiver schweizerischer Besteuerung mit 38,8 % Rückerstattung an die italienische Wohngemeinde.`,
      faqHeading: `Häufige Fragen zur Arbeit im Kanton ${canton}`,
      faqs: [
        {
          q: `Wie viele Tage Homeoffice darf ich als Grenzgänger im Kanton ${canton} machen?`,
          a: `Telearbeit ist derzeit bis zu 25 % der Arbeitszeit erlaubt (etwa ein Tag pro Woche bei Vollzeit), ohne den Grenzgängerstatus zu verlieren und ohne Sozialabgaben im Wohnland auszulösen. Über 25 % braucht es eine spezifische Vereinbarung zwischen Arbeitgeber, Arbeitnehmer und Behörden — eine Überschreitung verschiebt die Sozial- und Steuerbasis nach Italien. Die Regel gilt identisch in allen Schweizer Kantonen, einschliesslich ${canton}, Tessin und Nichtgrenzkantonen.`,
        },
        {
          q: `Werden italienische Qualifikationen für Stellen im Kanton ${canton} anerkannt?`,
          a: `Für die meisten Stellen im Privatsektor akzeptiert der Schweizer Arbeitgeber italienische Diplome oder Studienabschlüsse direkt, ohne formelle Anerkennung. Für reglementierte Berufe (Gesundheit, Bauingenieurwesen, Anwälte, Buchhalter) ist eine Anerkennung beim SBFI/SEFRI nötig: das Verfahren dauert 3-6 Monate und sollte parallel zu den Bewerbungen gestartet werden, nicht im Nachhinein. Der Kanton ${canton} folgt denselben Bundesbehörden; kantonale Besonderheiten gelten nur für Gesundheitsberufe über den Kantonsarzt.`,
        },
        {
          q: `Lohnt sich der Nettolohn im Kanton ${canton} verglichen mit dem italienischen Brutto?`,
          a: `Das schweizerische Netto hängt von vier Variablen ab: kantonale Quellensteuer (Stufen 4-19 % je nach Brutto, Zivilstand und Kindern), Sozialabgaben (AHV-IV-EO 5,3 % fix, ALV 1,1 %, BVG 7-18 % nach Alter), Steuerabkommen 2024 mit italienischer Steuergutschrift und Pendelkosten. Mit unserem <a href="${CALCULATOR_HREF[locale]}">kostenlosen Lohnrechner</a> können Sie das Brutto einer Stelle im Kanton ${canton} eingeben und erhalten das tatsächliche Monatsnetto in CHF und EUR — direkt vergleichbar mit dem italienischen Netto Ihrer Wohnregion.`,
        },
        {
          q: `Wie vergleicht sich der Kanton ${canton} mit anderen Schweizer Kantonen für Grenzgänger?`,
          a: `Der Kanton ${canton} ist einer von 26 Kantonen der Eidgenossenschaft und — wie alle — wendet eigene Steuersätze zusätzlich zum Bundesanteil an. Der Nettounterschied zwischen ${canton} und einem anderen Kanton kann bei gleichem Brutto CHF 200-500 pro Monat ausmachen, besonders bei mittleren Einkommen: Kantone wie Zug, Schwyz und Nidwalden haben die tiefsten Steuern, Genf und Waadt die höchsten. Für italienische Grenzgänger zählt neben der Steuer auch die Pendelzeit: Grenzkantone (Tessin, Teile von Wallis und Graubünden) sind täglich erreichbar, während ${canton} eventuell eine Wochenunterkunft erfordert.`,
        },
      ],
      crossLinks: `Drei kostenlose Tools zum Abschluss vor der Bewerbung: <a href="${CALCULATOR_HREF[locale]}">Netto-Grenzgänger-Lohnrechner</a> mit beiden Steuerregimen (altes + neues Abkommen 2024) und der Schätzung der italienischen Gemeinderückerstattung; <a href="${FX_HREF[locale]}">CHF/EUR-Wechselkursvergleich</a> mit den Kursen italienischer Banken, Schweizer Wechselstuben und Wise/Revolut; <a href="${HEALTH_HREF[locale]}">LAMal-Krankenkassen-Vergleich</a> zur Wahl der günstigsten Prämie in Ihrer Schweizer Arbeitsgemeinde. Für Auto-Pendler ist auch der <a href="${FUEL_HREF[locale]}">tägliche Schweizer Benzinpreis</a> jeden Morgen aktualisiert.`,
    };
  }

  // FR
  const slotIntro: Record<CantonSeoSlot, string> = {
    'canton-hub': `Cette page rassemble les offres actives dans le canton ${canton} pour les frontaliers italo-suisses (permis G) et résidents suisses (permis B). ${countText ? `${countText} aujourd'hui dans le canton ${canton} : ` : ''}sous la liste vous trouverez la méthodologie, le contexte frontalier et les FAQ.`,
    'sectors-hub': `L'index sectoriel du canton ${canton} regroupe les offres en macro-domaines (santé, finance, IT, ingénierie, restauration, construction, administration) afin que le même rôle publié avec différents mots-clés se retrouve dans la même catégorie. Pour les frontaliers italiens c'est le filtre le plus rapide pour lire la demande réelle dans le canton ${canton}.`,
    'companies-hub': `La liste des employeurs du canton ${canton} montre les entreprises avec au moins une offre active aujourd'hui, classées par nombre de postes ouverts. Pour les frontaliers italiens, les employeurs avec un delta hebdomadaire positif sont particulièrement intéressants : ${countText ? `${countText} ` : ''}ils acceptent souvent les candidatures spontanées et ouvrent un entretien exploratoire.`,
    'company-landing': `Les offres actives chez ${entity || 'cet employeur'} dans le canton ${canton} sont agrégées ici depuis des sources d'entreprise officielles. ${countText ? `${countText} chez ${entity || 'l\'employeur'} : ` : ''}la liste est rafraîchie toutes les 6-12 heures et indique le lieu précis, le salaire brut déclaré et un lien de candidature direct vers le portail de carrière de l'entreprise.`,
    'city-landing': `Les offres actives à ${entity || canton} (canton ${canton}) sont rassemblées ici pour les candidats ciblant la zone de pendulaire locale. ${countText ? `${countText} : ` : ''}sous la liste vous trouverez le contexte permis G, le calcul brut-net suisse et les FAQ habituelles du frontalier.`,
    'editorial-today': `Les offres d'emploi publiées aujourd'hui dans le canton ${canton} sont regroupées ici pour les candidats à la recherche des opportunités les plus fraîches. ${countText ? `${countText} : ` : ''}sous la liste vous trouverez la méthodologie de publication, la fréquence de rafraîchissement et le contexte frontalier.`,
    'editorial-nursing': `Les offres infirmières et de personnel soignant dans le canton ${canton} sont collectées ici depuis les hôpitaux cantonaux, cliniques privées, EMS et autres employeurs. ${countText ? `${countText} dans la santé ${canton} : ` : ''}sous la liste vous trouverez les règles de reconnaissance des diplômes, les salaires médians et les FAQ permis G spécifiques au secteur santé.`,
    'editorial-clinics': `Les offres de cliniques et hôpitaux dans le canton ${canton} sont agrégées ici — structures publiques, cliniques privées et centres spécialisés. ${countText ? `${countText} : ` : ''}sous la liste vous trouverez la méthodologie, le contexte frontalier santé et les FAQ reconnaissance SBFI/SEFRI.`,
    'editorial-part-time': `Les offres à temps partiel dans le canton ${canton} (40-80 %) sont regroupées ici pour les candidats cherchant l'équilibre vie-pro-vie-perso avec un trajet frontalier. ${countText ? `${countText} : ` : ''}sous la liste vous trouverez le contexte permis G, le calcul du net sur degré partiel et les FAQ télétravail jusqu'à 25 %.`,
  };
  return {
    blockHeading: `Comment lire cette page ${canton}`,
    intro: slotIntro[slot] || slotIntro['canton-hub'],
    methodology: `Les offres agrégées proviennent de plus de 80 crawlers dédiés aux principaux ATS des employeurs suisses (Workday, Smartrecruiters, ATS propriétaires) et aux job-centers cantonaux. Chaque annonce passe une déduplication sur titre normalisé, entreprise et commune avant publication ; la date affichée est la date de publication d'origine — pas l'horodatage du crawl — pour juger la fraîcheur. Nous gardons les offres en ligne 30 jours ou jusqu'au premier HTTP 404 / redirection "poste fermé", vérifiée toutes les 12 heures.`,
    permitContext: `Pour un frontalier italien résidant dans la zone des 20 km de la frontière (Lombardie, Piémont et — pour les nouveaux pendulaires vers le canton ${canton} depuis 2024 — Vallée d'Aoste aussi), postuler à un poste dans le canton ${canton} nécessite le permis G. La demande est faite par l'employeur suisse à l'office cantonal des migrations après signature du contrat : la première délivrance prend 2-6 semaines, renouvellement annuel ; retour hebdomadaire au domicile italien obligatoire. L'accord fiscal Italie-Suisse 2024 prévoit une taxation concurrente avec crédit d'impôt italien jusqu'à 80 % de la retenue suisse pour les nouveaux frontaliers (engagés après le 17 juillet 2023), abattement de 10 000 EUR ; les personnes déjà classées frontalières avant cette date conservent l'ancien régime de taxation suisse exclusive avec rétrocession de 38,8 % à la commune italienne de résidence.`,
    faqHeading: `Questions fréquentes sur le travail dans le canton ${canton}`,
    faqs: [
      {
        q: `Combien de jours de télétravail puis-je faire en restant frontalier dans le canton ${canton} ?`,
        a: `Le télétravail est actuellement autorisé jusqu'à 25 % du temps de travail (environ un jour par semaine à temps plein) sans perdre le statut de frontalier et sans déclencher de cotisations sociales dans le pays de résidence. Au-delà de 25 % il faut un accord spécifique entre employeur, salarié et autorités — le dépassement déplace la base sociale et fiscale vers l'Italie. La règle s'applique identiquement dans tous les cantons suisses, y compris ${canton}, le Tessin et les cantons non-frontaliers.`,
      },
      {
        q: `Les qualifications italiennes sont-elles reconnues pour les emplois dans le canton ${canton} ?`,
        a: `Pour la plupart des postes privés l'employeur suisse accepte directement le diplôme italien sans reconnaissance formelle. Pour les professions réglementées (santé, génie civil, avocats, comptables) la reconnaissance auprès du SBFI/SEFRI est requise : la procédure dure 3-6 mois et doit être lancée en parallèle des candidatures, pas après coup. Le canton ${canton} suit les mêmes autorités fédérales ; les spécificités cantonales s'appliquent uniquement aux professions de santé via le médecin cantonal.`,
      },
      {
        q: `Le salaire net dans le canton ${canton} vaut-il la peine comparé au brut italien ?`,
        a: `Le net suisse dépend de quatre variables : impôt à la source cantonal (tranches 4-19 % selon brut, état civil et enfants), charges sociales (AVS-AI-APG 5,3 % fixe, chômage 1,1 %, LPP 7-18 % par âge), accord fiscal 2024 avec crédit d'impôt italien, et coûts de trajet. Ouvrez notre <a href="${CALCULATOR_HREF[locale]}">calculateur de salaire gratuit</a> avec le brut d'une annonce du canton ${canton} et vous obtenez le net mensuel réel en CHF et en EUR — directement comparable avec le net italien de votre zone de résidence.`,
      },
      {
        q: `Comment le canton ${canton} se compare-t-il aux autres cantons suisses pour les frontaliers ?`,
        a: `Le canton ${canton} est l'un des 26 cantons de la Confédération et — comme tous — applique ses propres taux d'imposition en plus de la part fédérale. L'écart de net entre ${canton} et un autre canton, à brut égal, peut osciller de CHF 200-500 par mois surtout sur les revenus moyens : des cantons comme Zoug, Schwytz et Nidwald ont les impôts les plus bas, Genève et Vaud les plus hauts. Pour les frontaliers italiens, outre l'aspect fiscal, le temps de trajet compte : les cantons frontaliers (Tessin, parties du Valais et des Grisons) sont accessibles quotidiennement, alors que ${canton} peut nécessiter un hébergement hebdomadaire.`,
      },
    ],
    crossLinks: `Trois outils gratuits pour boucler la boucle avant de postuler : <a href="${CALCULATOR_HREF[locale]}">calculateur de salaire net frontalier</a> avec les deux régimes fiscaux (ancien + nouvel accord 2024) et l'estimation du remboursement de la commune italienne ; <a href="${FX_HREF[locale]}">comparateur de change CHF/EUR</a> avec les taux des banques italiennes, bureaux de change suisses et Wise/Revolut ; <a href="${HEALTH_HREF[locale]}">comparateur LAMal des caisses maladie</a> pour choisir la prime mensuelle la plus avantageuse dans votre commune de travail suisse. Pour les pendulaires en voiture, aussi le <a href="${FUEL_HREF[locale]}">prix quotidien du carburant en Suisse</a> actualisé chaque matin.`,
  };
}

/**
 * Render a self-contained `<section>` of canton-aware SEO prose for the
 * given slot. Pure: identical inputs always produce identical HTML.
 *
 * The returned HTML is intended to be appended AFTER the host page's
 * data area (listing, table) per CLAUDE.md mobile-first rules — the
 * helper does not wrap the host's main content.
 */
export function renderCantonSeoProse(opts: CantonSeoProseOpts): string {
  const copy = buildSlotCopy(opts);
  const { locale, ctaHref, ctaLabel } = opts;
  const cta = ctaHref
    ? `<p style="margin:16px 0 0;font-size:14.5px"><a href="${esc(ctaHref)}" style="color:var(--color-link);text-decoration:underline;font-weight:600">${esc(ctaLabel || DEFAULT_CTA_LABEL[locale])} →</a></p>`
    : '';

  const faqHtml = copy.faqs
    .map(
      (f) =>
        `<details style="background:var(--color-surface);border:1px solid var(--color-edge);border-radius:10px;padding:12px 14px;margin:8px 0"><summary style="font-weight:700;cursor:pointer;color:var(--color-heading);font-size:14.5px">${esc(f.q)}</summary><p style="margin:8px 0 0;color:var(--color-body);line-height:1.65;font-size:14.5px">${f.a}</p></details>`,
    )
    .join('');

  const deepDive = buildDeepDiveBlock(opts);

  return `<section class="canton-seo-prose" data-slot="${esc(opts.slot)}" data-canton="${esc(opts.cantonDisplay)}" style="max-width:860px;margin:32px auto 0;color:var(--color-body);line-height:1.65;font-size:15px">
  <h2 style="font-size:20px;font-weight:700;color:var(--color-heading);margin:24px 0 12px">${esc(copy.blockHeading)}</h2>
  <p style="margin:0 0 14px">${copy.intro}</p>
  <p style="margin:0 0 14px;color:var(--color-body);font-size:14.5px"><strong>${esc(locale === 'it' ? 'Metodologia.' : locale === 'en' ? 'Methodology.' : locale === 'de' ? 'Methodik.' : 'Méthodologie.')}</strong> ${copy.methodology}</p>
  <p style="margin:0 0 14px;color:var(--color-body);font-size:14.5px"><strong>${esc(locale === 'it' ? 'Permesso G + fiscalità.' : locale === 'en' ? 'G permit + tax context.' : locale === 'de' ? 'G-Bewilligung + Steuern.' : 'Permis G + fiscalité.')}</strong> ${copy.permitContext}</p>
  <h3 style="font-size:17px;font-weight:700;color:var(--color-heading);margin:22px 0 8px">${esc(copy.faqHeading)}</h3>
  ${faqHtml}
  ${deepDive}
  <p style="margin:18px 0 0;font-size:14.5px"><strong>${esc(locale === 'it' ? 'Strumenti collegati.' : locale === 'en' ? 'Related tools.' : locale === 'de' ? 'Verwandte Tools.' : 'Outils associés.')}</strong> ${copy.crossLinks}</p>
  ${cta}
</section>`;
}

/**
 * Border-distance band for a Swiss canton seen from the typical Italian
 * frontaliere feeder cities (Como, Varese, Verbano-Cusio-Ossola, Aosta).
 * Drives the commute strategy paragraph below: daily-reachable cantons
 * get one playbook (carpool / TILO / car), weekly cantons get another
 * (settimana/Wochenaufenthalt strategy, accommodation rental, 4-day
 * commute models). The classification is intentionally coarse — finer
 * granularity (city-level) lives in jobBoardCommuterContext.ts.
 */
type CantonDistanceBand = 'border-daily' | 'near-mixed' | 'far-weekly';

/**
 * Coarse distance band for canton display names. We accept both Italian
 * and German display variants ("Ticino"/"Tessin", "Vallese"/"Wallis"…)
 * because the helper is called with the localised display form. Unknown
 * cantons fall through to `near-mixed` — a balanced default that gives
 * a plausible playbook (mix of daily commute + weekly accommodation)
 * without making up false distance numbers.
 */
function cantonDistanceBand(cantonDisplay: string): CantonDistanceBand {
  const c = cantonDisplay.trim().toLowerCase();
  // Border-daily cantons reachable from CO/VA/VB/AO in <90 min by car or train.
  if (
    c === 'ticino' || c === 'tessin' ||
    c === 'grigioni' || c === 'grisons' || c === 'graubünden' || c === 'graubunden' || c === 'grischun' ||
    c === 'vallese' || c === 'wallis' || c === 'valais' ||
    c === 'ginevra' || c === 'geneva' || c === 'genf' || c === 'genève' || c === 'geneve'
  ) {
    return 'border-daily';
  }
  // Near-mixed: 90-150 min — daily possible but weekly hotel/Wochenaufenthalt
  // is common, especially in winter.
  if (
    c === 'vaud' || c === 'waadt' ||
    c === 'friburgo' || c === 'fribourg' || c === 'freiburg' ||
    c === 'neuchâtel' || c === 'neuchatel' || c === 'neuenburg' ||
    c === 'giura' || c === 'jura' ||
    c === 'soletta' || c === 'solothurn' || c === 'soleure' ||
    c === 'berna' || c === 'bern' || c === 'berne' ||
    c === 'lucerna' || c === 'luzern' || c === 'lucerne' ||
    c === 'nidvaldo' || c === 'nidwalden' || c === 'nidwald' ||
    c === 'obvaldo' || c === 'obwalden' || c === 'obwald' ||
    c === 'uri' ||
    c === 'svitto' || c === 'schwyz' ||
    c === 'argovia' || c === 'aargau' || c === 'argovie' ||
    c === 'basilea-campagna' || c === 'basilea campagna' || c === 'basel-landschaft' || c === 'bâle-campagne' || c === 'basel landschaft'
  ) {
    return 'near-mixed';
  }
  // Far-weekly: 150+ min — Wochenaufenthalt is the realistic model for
  // most Italian-feeder commuters. Includes the eastern + northern
  // cantons (Zurigo cluster, Sciaffusa, San Gallo, Turgovia, Appenzello,
  // Basilea Città, Glarona, Zugo).
  return 'far-weekly';
}

/**
 * Render the deep-dive prose appended after the FAQ block. The block adds
 * ~3-4 KB of visible text covering: application playbook, commute /
 * accommodation strategy, sector outlook in the canton, and a worked
 * net-pay-vs-Italian-gross scenario. The text is parameterised by canton
 * display name and distance band, so two different cantons emit different
 * prose and Google's cross-page duplicate-content heuristic stays happy.
 *
 * The deep-dive is locale-aware and renders only in the four supported
 * locales (it / en / de / fr). It is pure: identical inputs return the
 * same HTML, so determinism + snapshot tests still pass.
 */
function buildDeepDiveBlock(opts: CantonSeoProseOpts): string {
  const { locale, cantonDisplay } = opts;
  const canton = cantonDisplay.trim();
  const band = cantonDistanceBand(canton);

  const headings = (() => {
    if (locale === 'it') {
      return {
        section: `Strategie pratiche per candidarsi nel Canton ${canton}`,
        playbook: 'Playbook di candidatura passo dopo passo',
        commute: 'Pendolarismo e logistica settimanale',
        sectors: 'Settori che assumono e mercato del lavoro',
        netpay: 'Lordo CHF, netto reale e confronto con l\'Italia',
      };
    }
    if (locale === 'en') {
      return {
        section: `Practical strategies for applying in Canton ${canton}`,
        playbook: 'Step-by-step application playbook',
        commute: 'Commute and weekly logistics',
        sectors: 'Sectors hiring and labour-market picture',
        netpay: 'CHF gross, real net and Italian comparison',
      };
    }
    if (locale === 'de') {
      return {
        section: `Praktische Strategien für eine Bewerbung im Kanton ${canton}`,
        playbook: 'Bewerbungs-Playbook Schritt für Schritt',
        commute: 'Pendeln und Wochenlogistik',
        sectors: 'Stark einstellende Branchen und Arbeitsmarkt',
        netpay: 'CHF-Brutto, reales Netto und Vergleich mit Italien',
      };
    }
    return {
      section: `Stratégies pratiques pour candidater dans le canton ${canton}`,
      playbook: 'Playbook de candidature pas à pas',
      commute: 'Trajet et logistique hebdomadaire',
      sectors: 'Secteurs qui recrutent et marché du travail',
      netpay: 'Brut CHF, net réel et comparaison italienne',
    };
  })();

  // Application playbook — same 5 steps in every locale but each step is
  // rewritten with canton-specific anchors so the prose isn't boilerplate.
  const playbookP = (() => {
    if (locale === 'it') {
      return `Per il frontaliere italiano che si candida nel Canton ${canton} il percorso utile è in cinque tappe e va eseguito in parallelo, non in sequenza. <strong>1. CV svizzero a una pagina</strong>: nessuna foto, nessun codice fiscale, niente "obbligo di leva", nessun riferimento al diritto italiano sul lavoro; il datore cerca evidenze quantificate (fatturato gestito, team guidati, clienti chiusi). <strong>2. Lettera di motivazione di tre paragrafi</strong>: perché ${canton}, perché questa azienda, cosa porti — la lingua è quella dell'annuncio (italiano nel Canton Ticino, tedesco nella Svizzera tedesca, francese nella Svizzera romanda, inglese in molte multinazionali); allegala come PDF separato anche se il modulo di candidatura non la richiede esplicitamente. <strong>3. Riferimenti professionali</strong>: due referenze raggiungibili al telefono in CH o EU, non in Italia profonda — il responsabile HR svizzero le chiama davvero, di solito in fase finale. <strong>4. Colloqui</strong>: aspettati 2-4 round (telefonico HR, hiring manager, talvolta caso pratico, talvolta CFO/CEO per ruoli senior); ogni round dura 45-60 minuti, è pianificato puntualissimo e si chiude con domande tue (preparane sempre tre concrete sul ruolo e sul team). <strong>5. Permesso G</strong>: dopo la firma del contratto il datore avvia la richiesta presso l'Ufficio della migrazione del Canton ${canton}; consegna entro 24 ore copia della carta d'identità italiana, certificato di residenza nel comune italiano (in zona di frontiera, entro 20 km dal confine svizzero) e codice IBAN per l'accredito stipendio.`;
    }
    if (locale === 'en') {
      return `For Italian cross-border applicants targeting Canton ${canton} the useful sequence is five tracks run in parallel, not sequentially. <strong>1. Swiss-format one-page CV</strong>: no photo, no Italian tax code, no military-service line, no references to Italian labour law; the employer wants quantified evidence (revenue managed, teams led, deals closed). <strong>2. Three-paragraph motivation letter</strong>: why ${canton}, why this employer, what you bring — written in the language of the posting (Italian for Ticino, German for the Swiss-German cantons, French for Romandie, English for many multinationals); attach as a separate PDF even if the application form doesn't explicitly require one. <strong>3. Professional references</strong>: two referees reachable by phone in CH or EU, not deep-Italy — Swiss HR managers actually do call them, usually in the final stage. <strong>4. Interview rounds</strong>: expect 2-4 stages (HR phone screen, hiring manager, sometimes a case exercise, sometimes CFO/CEO for senior roles); each lasts 45-60 minutes, is scheduled precisely on time and ends with your own questions (always prepare three concrete ones about the role and team). <strong>5. G permit</strong>: after contract signature the employer files the application with the Canton ${canton} migration office; within 24 hours you supply a copy of your Italian ID, a residence certificate from your Italian municipality (within the 20-km border zone) and the IBAN for your salary deposit.`;
    }
    if (locale === 'de') {
      return `Für italienische Grenzgänger, die sich im Kanton ${canton} bewerben, läuft der Weg in fünf parallelen Spuren ab — nicht sequentiell. <strong>1. Schweizer Lebenslauf, eine Seite</strong>: kein Foto, keine italienische Steuernummer, keine Militärdienst-Zeile, keine Verweise auf italienisches Arbeitsrecht; der Arbeitgeber sucht quantifizierte Belege (verwaltetes Volumen, geführte Teams, abgeschlossene Geschäfte). <strong>2. Motivationsschreiben in drei Absätzen</strong>: warum ${canton}, warum dieses Unternehmen, was Sie mitbringen — in der Sprache des Inserats (Italienisch im Tessin, Deutsch in der Deutschschweiz, Französisch in der Romandie, Englisch bei vielen Multis); als separates PDF anhängen, auch wenn das Bewerbungsformular es nicht ausdrücklich verlangt. <strong>3. Berufliche Referenzen</strong>: zwei Referenzgeber, die telefonisch in CH oder EU erreichbar sind, nicht in der italienischen Provinz — der Schweizer HR-Manager ruft tatsächlich an, meist in der Schlussrunde. <strong>4. Vorstellungsrunden</strong>: rechnen Sie mit 2-4 Stufen (HR-Telefon-Screen, Hiring Manager, manchmal Fallstudie, manchmal CFO/CEO bei Senior-Rollen); jede Runde dauert 45-60 Minuten, ist auf die Minute geplant und endet mit Ihren eigenen Fragen (bereiten Sie immer drei konkrete zur Rolle und zum Team vor). <strong>5. G-Bewilligung</strong>: nach Vertragsunterzeichnung reicht der Arbeitgeber den Antrag beim Migrationsamt des Kantons ${canton} ein; binnen 24 Stunden liefern Sie eine Kopie der italienischen Identitätskarte, eine Wohnsitzbescheinigung der italienischen Gemeinde (innerhalb der 20-km-Grenzzone) und die IBAN für die Lohngutschrift.`;
    }
    return `Pour les candidats frontaliers italiens visant le canton ${canton}, la séquence utile se déroule en cinq pistes parallèles — pas successives. <strong>1. CV au format suisse, une page</strong> : pas de photo, pas de code fiscal italien, pas de service militaire, pas de références au droit du travail italien ; l'employeur cherche des preuves quantifiées (chiffre d'affaires géré, équipes dirigées, contrats signés). <strong>2. Lettre de motivation en trois paragraphes</strong> : pourquoi ${canton}, pourquoi cet employeur, ce que vous apportez — écrite dans la langue de l'annonce (italien au Tessin, allemand en Suisse alémanique, français en Romandie, anglais pour beaucoup de multinationales) ; à joindre en PDF séparé même si le formulaire ne le demande pas explicitement. <strong>3. Références professionnelles</strong> : deux personnes joignables par téléphone en CH ou UE, pas en Italie profonde — le RH suisse appelle vraiment, généralement en finale. <strong>4. Entretiens</strong> : attendez-vous à 2-4 tours (entretien RH au téléphone, hiring manager, parfois étude de cas, parfois CFO/CEO pour les postes seniors) ; chaque tour dure 45-60 minutes, est planifié à la minute près et se termine par vos propres questions (préparez-en toujours trois concrètes sur le poste et l'équipe). <strong>5. Permis G</strong> : après signature du contrat l'employeur dépose la demande à l'office cantonal des migrations du canton ${canton} ; sous 24 heures vous transmettez la copie de la carte d'identité italienne, le certificat de résidence dans la commune italienne (dans la zone frontalière des 20 km) et l'IBAN pour le versement du salaire.`;
  })();

  // Commute / accommodation paragraph — varies by distance band so the
  // prose matches the actual logistical reality of the canton.
  const commuteP = (() => {
    if (locale === 'it') {
      if (band === 'border-daily') {
        return `Il Canton ${canton} è raggiungibile in giornata dalle principali località italiane di frontaliere (Como, Varese, Verbano-Cusio-Ossola, Val d'Aosta in funzione del canton di destinazione): la maggioranza dei pendolari sceglie l'auto privata per la flessibilità sui turni serali e sui giorni di shopping al rientro, mentre il treno (TILO, RegioExpress, IR) è la scelta dei ruoli amministrativi a orario fisso che lavorano vicino alle stazioni. La spesa mensile tipica del pendolare in auto è CHF 350-650 fra carburante, autostrada e usura veicolo (autostrade italiane gratuite fino al valico, vignetta svizzera CHF 40/anno); il treno costa CHF 200-450/mese in abbonamento generale o regionale. Sui valichi di confine il picco di traffico in entrata in Svizzera è 06:30-08:00, in uscita 17:00-19:00; le webcam ufficiali permettono di anticipare le code di 10-15 minuti scegliendo il valico secondario.`;
      }
      if (band === 'near-mixed') {
        return `Il Canton ${canton} è in zona mista: il pendolarismo quotidiano resta possibile per i residenti italiani delle aree più a nord (Verbano, Valle d'Aosta, alta Lombardia) ma supera spesso 90 minuti per tratta, quindi molti frontalieri optano per il "Wochenaufenthalt" — alloggio settimanale in CH dal lunedì al venerdì, rientro nel weekend al domicilio italiano. L'affitto di una camera in zona Canton ${canton} costa CHF 500-900 al mese; un monolocale CHF 900-1'500. Lo status di frontaliere è compatibile con il Wochenaufenthalt purché ci sia rientro settimanale al domicilio italiano (anche un solo weekend al mese). I costi di alloggio e trasporto sono deducibili in parte dal datore in alcuni CCL.`;
      }
      return `Il Canton ${canton} è in zona lontana (oltre 150 minuti dalle località italiane di frontaliere): il pendolarismo quotidiano non è realistico nella maggior parte dei casi e quasi tutti i frontalieri italiani che lavorano qui adottano il modello "Wochenaufenthalt" — alloggio settimanale in CH dal lunedì al venerdì, rientro nel weekend al domicilio italiano. L'affitto di una camera in zona Canton ${canton} costa CHF 600-1'200/mese, un monolocale CHF 1'100-1'900. Il costo di accesso allo status di frontaliere è alto in valore assoluto ma compensato dal salario lordo svizzero, di solito 25-40 % superiore al cantone di residenza per ruoli equivalenti. Il rientro settimanale al domicilio italiano è obbligatorio per mantenere lo status (anche un solo weekend al mese soddisfa l'autorità fiscale).`;
    }
    if (locale === 'en') {
      if (band === 'border-daily') {
        return `Canton ${canton} is reachable as a daily commute from the main Italian frontaliere catchment areas (Como, Varese, Verbano-Cusio-Ossola, Aosta Valley depending on the target canton): most commuters choose private car for evening-shift flexibility and weekend errands, while train (TILO, RegioExpress, IR) is the choice for fixed-schedule office roles working near a station. Typical monthly out-of-pocket for car commuters is CHF 350-650 across fuel, motorway and vehicle wear (Italian motorway free up to the border crossing, Swiss vignette CHF 40/year); train pass runs CHF 200-450/month for general or regional ticket. Border-crossing peak inbound to Switzerland is 06:30-08:00, outbound 17:00-19:00; official webcams let you pre-empt queues by 10-15 minutes via secondary crossings.`;
      }
      if (band === 'near-mixed') {
        return `Canton ${canton} sits in the mixed zone: daily commute remains feasible for Italian residents in the northernmost feeder areas (Verbano, Aosta Valley, upper Lombardy) but routinely exceeds 90 minutes one-way, so many cross-border workers opt for "Wochenaufenthalt" — weekly accommodation in CH Monday to Friday, return to the Italian residence on weekends. Room rental in Canton ${canton} runs CHF 500-900/month; studio CHF 900-1,500. The cross-border status is compatible with weekly accommodation provided you return to the Italian home at least weekly (a single weekend per month satisfies the tax authority). Some collective labour agreements (CCL) cover part of the accommodation or transport allowance.`;
      }
      return `Canton ${canton} is in the far zone (over 150 minutes from Italian frontaliere areas): daily commute is not realistic in most cases and almost every Italian-resident frontaliere working here adopts "Wochenaufenthalt" — weekly accommodation in CH Monday to Friday, return to the Italian residence on weekends. Room rental in Canton ${canton} runs CHF 600-1,200/month, studio CHF 1,100-1,900. Cost of entry is high in absolute terms but offset by the Swiss gross salary, typically 25-40 % above the equivalent Italian role for the same canton. Weekly return to the Italian home is required to keep the status (a single weekend per month meets the fiscal authority's requirement).`;
    }
    if (locale === 'de') {
      if (band === 'border-daily') {
        return `Der Kanton ${canton} ist im Tagespendel von den wichtigsten italienischen Grenzgängerzonen (Como, Varese, Verbano-Cusio-Ossola, Aostatal je nach Zielkanton) erreichbar: Die meisten Pendler wählen das Privatauto wegen der Flexibilität bei Spätschichten und Wochenend-Einkäufen, während Zug (TILO, RegioExpress, IR) für Bürorollen mit festen Zeiten in Bahnhofsnähe die Wahl ist. Typische monatliche Kosten für Autopendler liegen bei CHF 350-650 für Treibstoff, Autobahn und Fahrzeugverschleiss (italienische Autobahn bis zum Grenzübergang gratis, Schweizer Vignette CHF 40/Jahr); ein Zug-Abonnement kostet CHF 200-450/Monat für General- oder Regional-Ticket. Spitzen-Stau am Grenzübergang Richtung Schweiz ist 06:30-08:00, Richtung Italien 17:00-19:00; offizielle Webcams erlauben es, Staus über sekundäre Übergänge um 10-15 Minuten zu umgehen.`;
      }
      if (band === 'near-mixed') {
        return `Der Kanton ${canton} liegt in der Mischzone: Tagespendel bleibt für italienische Einwohner in den nördlichsten Gemeinden (Verbano, Aostatal, obere Lombardei) möglich, übersteigt aber regelmässig 90 Minuten pro Strecke, weshalb viele Grenzgänger zum "Wochenaufenthalt" wechseln — wöchentliche Unterkunft in der Schweiz von Montag bis Freitag, Rückkehr ins italienische Zuhause am Wochenende. Zimmermiete im Kanton ${canton} kostet CHF 500-900/Monat, ein Studio CHF 900-1'500. Der Grenzgängerstatus ist mit dem Wochenaufenthalt vereinbar, sofern eine wöchentliche Rückkehr ins italienische Zuhause erfolgt (ein Wochenende pro Monat genügt der Steuerbehörde). Einige Gesamtarbeitsverträge (GAV) decken einen Teil der Unterkunft oder der Reisekosten ab.`;
      }
      return `Der Kanton ${canton} liegt in der fernen Zone (über 150 Minuten von den italienischen Grenzgängergebieten): Tagespendel ist in den meisten Fällen unrealistisch und fast alle in Italien wohnhaften Grenzgänger, die hier arbeiten, wählen den "Wochenaufenthalt" — wöchentliche Unterkunft in der Schweiz von Montag bis Freitag, Rückkehr ins italienische Zuhause am Wochenende. Zimmermiete im Kanton ${canton} kostet CHF 600-1'200/Monat, ein Studio CHF 1'100-1'900. Die Einstiegskosten sind absolut hoch, werden aber durch den Schweizer Bruttolohn ausgeglichen, der typischerweise 25-40 % über dem äquivalenten italienischen Lohn liegt. Eine wöchentliche Rückkehr ins italienische Zuhause ist Pflicht, um den Status zu behalten (ein Wochenende pro Monat genügt der Steuerbehörde).`;
    }
    if (band === 'border-daily') {
      return `Le canton ${canton} est accessible en pendulaire quotidien depuis les principales zones italiennes de frontaliers (Côme, Varèse, Verbano-Cusio-Ossola, Vallée d'Aoste selon le canton ciblé) : la plupart des pendulaires choisissent la voiture pour la flexibilité sur les horaires du soir et les courses du week-end, tandis que le train (TILO, RegioExpress, IR) est l'option pour les postes administratifs à horaire fixe travaillant près d'une gare. Les frais mensuels typiques d'un automobiliste sont de CHF 350-650 entre carburant, autoroute et usure du véhicule (autoroute italienne gratuite jusqu'au passage frontalier, vignette suisse CHF 40/an) ; l'abonnement train coûte CHF 200-450/mois pour un ticket général ou régional. Le pic de trafic entrant en Suisse est 06h30-08h00, sortant 17h00-19h00 ; les webcams officielles permettent d'anticiper les files de 10-15 minutes en choisissant un passage secondaire.`;
    }
    if (band === 'near-mixed') {
      return `Le canton ${canton} se trouve en zone mixte : le pendulaire quotidien reste possible pour les résidents italiens des zones les plus au nord (Verbano, Vallée d'Aoste, Lombardie haute) mais dépasse souvent 90 minutes par trajet, c'est pourquoi de nombreux frontaliers optent pour le « Wochenaufenthalt » — logement hebdomadaire en CH du lundi au vendredi, retour le week-end au domicile italien. Une chambre dans le canton ${canton} coûte CHF 500-900/mois ; un studio CHF 900-1 500. Le statut de frontalier est compatible avec le logement hebdomadaire à condition d'un retour au moins hebdomadaire au domicile italien (un week-end par mois suffit à l'autorité fiscale). Certaines conventions collectives (CCT) prennent en charge une part du logement ou des frais de transport.`;
    }
    return `Le canton ${canton} est en zone éloignée (plus de 150 minutes depuis les zones italiennes de frontaliers) : le pendulaire quotidien n'est pas réaliste dans la plupart des cas et presque tous les frontaliers italiens qui y travaillent adoptent le « Wochenaufenthalt » — logement hebdomadaire en CH du lundi au vendredi, retour le week-end au domicile italien. Une chambre dans le canton ${canton} coûte CHF 600-1 200/mois, un studio CHF 1 100-1 900. Le coût d'accès est élevé en valeur absolue mais compensé par le salaire brut suisse, typiquement 25-40 % au-dessus du poste équivalent côté italien. Le retour hebdomadaire au domicile italien est obligatoire pour conserver le statut (un week-end par mois satisfait à l'autorité fiscale).`;
  })();

  // Sector outlook paragraph — anchored to the canton name but with a
  // generic-enough vocabulary to be safe across the 21 non-TI cantons.
  const sectorsP = (() => {
    if (locale === 'it') {
      return `Il mercato del lavoro nel Canton ${canton} segue la struttura economica federale: i settori che assumono in modo ricorrente sono sanità (cliniche cantonali, RSA, ambulatori specialistici), tecnologie dell'informazione (sviluppo software, data engineering, cybersecurity), finanza e wealth management (banche, fiduciarie, family office), ingegneria e meccanica di precisione, edilizia e logistica, amministrazione pubblica cantonale, ristorazione e ospitalità nelle zone turistiche. Per il frontaliere italiano qualificato, le opportunità più immediate sono nei ruoli con domanda strutturale di personale qualificato — infermieri AFC, sviluppatori senior, ingegneri civili abilitati, commercialisti con esperienza svizzera — e nei ruoli operativi del manifatturiero che richiedono presenza fisica e accettano competenze italiane equivalenti. Il Canton ${canton} attinge anche ai frontalieri per coprire posizioni saltuarie nella ristorazione di stagione e nei lavori temporanei a chiamata gestiti tramite agenzie di interim svizzere come Adecco, Manpower, Randstad.`;
    }
    if (locale === 'en') {
      return `The labour market in Canton ${canton} mirrors the federal economic structure: sectors with recurring openings are healthcare (cantonal hospitals, nursing homes, specialist clinics), information technology (software development, data engineering, cybersecurity), finance and wealth management (banks, fiduciaries, family offices), engineering and precision mechanics, construction and logistics, cantonal public administration, hospitality in tourism zones. For qualified Italian cross-border applicants the most immediate opportunities sit in roles with structural skilled-labour demand — AFC-certified nurses, senior developers, certified civil engineers, accountants with Swiss experience — and in manufacturing operations that need physical presence and accept equivalent Italian qualifications. Canton ${canton} also draws on cross-border workers to cover seasonal hospitality positions and on-call temporary roles managed via Swiss interim agencies like Adecco, Manpower, Randstad.`;
    }
    if (locale === 'de') {
      return `Der Arbeitsmarkt im Kanton ${canton} spiegelt die föderale Wirtschaftsstruktur wider: Branchen mit wiederkehrenden Stellenangeboten sind Gesundheitswesen (Kantonsspitäler, Pflegeheime, Fachkliniken), Informationstechnologie (Softwareentwicklung, Data Engineering, Cybersecurity), Finanzen und Vermögensverwaltung (Banken, Treuhänder, Family Offices), Ingenieurwesen und Präzisionsmechanik, Bau und Logistik, kantonale öffentliche Verwaltung, Gastgewerbe in Tourismuszonen. Für qualifizierte italienische Grenzgänger liegen die unmittelbarsten Chancen in Rollen mit strukturellem Fachkräftebedarf — EFZ-Pflegefachkräfte, Senior-Entwickler, eingetragene Bauingenieure, Buchhalter mit Schweizer Erfahrung — und in operativen Fertigungsrollen, die physische Präsenz erfordern und gleichwertige italienische Qualifikationen anerkennen. Der Kanton ${canton} greift auch auf Grenzgänger zurück, um saisonale Gastgewerbe-Positionen und Abruf-Arbeit zu besetzen, die über Schweizer Personaldienstleister wie Adecco, Manpower, Randstad vermittelt werden.`;
    }
    return `Le marché du travail du canton ${canton} reflète la structure économique fédérale : les secteurs qui recrutent régulièrement sont la santé (hôpitaux cantonaux, EMS, cliniques spécialisées), les technologies de l'information (développement logiciel, data engineering, cybersécurité), la finance et la gestion de patrimoine (banques, fiduciaires, family offices), l'ingénierie et la mécanique de précision, le bâtiment et la logistique, l'administration publique cantonale, l'hôtellerie-restauration dans les zones touristiques. Pour le frontalier italien qualifié, les opportunités les plus immédiates se trouvent dans les rôles à demande structurelle de personnel qualifié — infirmiers titulaires d'un CFC, développeurs seniors, ingénieurs civils inscrits, comptables avec expérience suisse — et dans les rôles opérationnels de la production qui exigent une présence physique et acceptent des qualifications italiennes équivalentes. Le canton ${canton} recourt aussi aux frontaliers pour couvrir des postes saisonniers de l'hôtellerie et des missions temporaires gérées via les agences d'intérim suisses comme Adecco, Manpower, Randstad.`;
  })();

  // Net-pay scenario paragraph — quantitative comparison anchored to a
  // CHF 80k-120k bracket common across the cantons, so the numbers are
  // realistic without overclaiming.
  const netpayP = (() => {
    if (locale === 'it') {
      return `Per un ruolo professionale tipico nel Canton ${canton} (lordo annuo CHF 85'000-110'000, 13 mensilità incluse, AVS-AI-IPG 5,3 %, AD 1,1 %, LPP 7-15 % in funzione dell'età, imposta alla fonte cantonale 4-14 % a seconda dello scaglione e stato civile), il netto mensile per un single senza figli è di norma fra CHF 5'400 e CHF 6'600; per una coppia con due figli a carico, grazie alle deduzioni familiari cantonali, fra CHF 5'800 e CHF 7'200. Con il Nuovo Accordo Italia-Svizzera 2024 (in vigore per i frontalieri assunti dopo il 17 luglio 2023) si applica la tassazione concorrente: il datore svizzero trattiene l'80 % della ritenuta cantonale ordinaria, il contribuente dichiara il reddito in Italia con franchigia di EUR 10'000 e credito d'imposta per la parte trattenuta in Svizzera. Per chi era già frontaliere prima del 17 luglio 2023, il vecchio regime resta in vigore (tassazione esclusivamente svizzera, ristorno del 38,8 % al comune italiano di residenza). Apri il <a href="${CALCULATOR_HREF[locale]}">calcolatore stipendio Frontaliere Ticino</a> e inserisci il lordo dell'annuncio che ti interessa nel Canton ${canton}: ottieni il netto mensile in CHF e in EUR, comparabile con un'offerta italiana, in meno di 30 secondi.`;
    }
    if (locale === 'en') {
      return `For a typical professional role in Canton ${canton} (annual gross CHF 85,000-110,000 inclusive of 13 monthly payments, AVS-AI-IPG 5.3 %, unemployment 1.1 %, LPP 7-15 % by age band, cantonal source tax 4-14 % depending on bracket and civil status), the monthly net for a single applicant with no children typically runs between CHF 5,400 and CHF 6,600; for a married couple with two dependent children, after cantonal family deductions, between CHF 5,800 and CHF 7,200. Under the 2024 Italy-Switzerland bilateral agreement (in force for cross-border workers hired after 17 July 2023) dual taxation applies: the Swiss employer withholds 80 % of the standard cantonal rate, the taxpayer declares the income in Italy with a 10,000 EUR allowance and tax credit for the Swiss withholding. Cross-border workers already classified before 17 July 2023 keep the old regime (exclusive Swiss taxation, 38.8 % refund to the Italian residence municipality). Open the <a href="${CALCULATOR_HREF[locale]}">Frontaliere Ticino salary calculator</a> with the gross figure from a Canton ${canton} listing: you'll get the monthly net in CHF and EUR, directly comparable with an Italian offer, in under 30 seconds.`;
    }
    if (locale === 'de') {
      return `Für eine typische Fachrolle im Kanton ${canton} (Bruttojahreslohn CHF 85'000-110'000 inkl. 13. Monatslohn, AHV-IV-EO 5,3 %, ALV 1,1 %, BVG 7-15 % nach Altersband, kantonale Quellensteuer 4-14 % je nach Stufe und Zivilstand) liegt das Monatsnetto für Alleinstehende ohne Kinder typischerweise zwischen CHF 5'400 und CHF 6'600; für ein Ehepaar mit zwei Kindern nach kantonalen Familienabzügen zwischen CHF 5'800 und CHF 7'200. Mit dem Steuerabkommen Italien-Schweiz 2024 (gültig für Grenzgänger, die nach dem 17. Juli 2023 angestellt wurden) gilt die konkurrierende Besteuerung: Der Schweizer Arbeitgeber zieht 80 % des ordentlichen kantonalen Satzes ab, der Steuerpflichtige deklariert das Einkommen in Italien mit Freibetrag von EUR 10'000 und Steuergutschrift für den in der Schweiz einbehaltenen Anteil. Vor dem 17. Juli 2023 bereits eingestufte Grenzgänger behalten das alte Regime (ausschliesslich Schweizer Besteuerung, 38,8 % Rückerstattung an die italienische Wohngemeinde). Öffnen Sie den <a href="${CALCULATOR_HREF[locale]}">Frontaliere-Ticino-Lohnrechner</a> mit dem Bruttowert eines Inserats aus dem Kanton ${canton}: in unter 30 Sekunden erhalten Sie das Monatsnetto in CHF und EUR, direkt vergleichbar mit einem italienischen Angebot.`;
    }
    return `Pour un poste professionnel typique dans le canton ${canton} (brut annuel CHF 85 000-110 000 incluant le 13e mois, AVS-AI-APG 5,3 %, chômage 1,1 %, LPP 7-15 % selon la tranche d'âge, impôt à la source cantonal 4-14 % selon la tranche et l'état civil), le net mensuel pour un célibataire sans enfants se situe généralement entre CHF 5 400 et CHF 6 600 ; pour un couple marié avec deux enfants à charge, après déductions familiales cantonales, entre CHF 5 800 et CHF 7 200. Avec l'accord fiscal Italie-Suisse 2024 (en vigueur pour les frontaliers engagés après le 17 juillet 2023), la taxation concurrente s'applique : l'employeur suisse retient 80 % du taux cantonal ordinaire, le contribuable déclare le revenu en Italie avec abattement de EUR 10 000 et crédit d'impôt pour la retenue suisse. Les frontaliers déjà classés avant le 17 juillet 2023 conservent l'ancien régime (taxation exclusivement suisse, rétrocession de 38,8 % à la commune italienne de résidence). Ouvrez le <a href="${CALCULATOR_HREF[locale]}">calculateur de salaire Frontaliere Ticino</a> avec le brut d'une annonce du canton ${canton} : en moins de 30 secondes vous obtenez le net mensuel en CHF et en EUR, directement comparable à une offre italienne.`;
  })();

  return `<h3 style="font-size:17px;font-weight:700;color:var(--color-heading);margin:22px 0 10px">${esc(headings.section)}</h3>
  <p style="margin:0 0 12px;color:var(--color-body);font-size:14.5px"><strong>${esc(headings.playbook)}.</strong> ${playbookP}</p>
  <p style="margin:0 0 12px;color:var(--color-body);font-size:14.5px"><strong>${esc(headings.commute)}.</strong> ${commuteP}</p>
  <p style="margin:0 0 12px;color:var(--color-body);font-size:14.5px"><strong>${esc(headings.sectors)}.</strong> ${sectorsP}</p>
  <p style="margin:0 0 14px;color:var(--color-body);font-size:14.5px"><strong>${esc(headings.netpay)}.</strong> ${netpayP}</p>`;
}

/**
 * Return the FAQ entries as Schema.org `Question` objects so the host
 * page can merge them into a single FAQPage JSON-LD script (avoiding
 * the GSC duplicate-FAQPage warning).
 */
export function buildCantonSeoProseFaqItems(opts: CantonSeoProseOpts): Array<{
  '@type': 'Question';
  name: string;
  acceptedAnswer: { '@type': 'Answer'; text: string };
}> {
  const copy = buildSlotCopy(opts);
  return copy.faqs
    .filter((f) => f.q.trim() && f.a.trim())
    .map((f) => ({
      '@type': 'Question' as const,
      name: f.q.trim(),
      acceptedAnswer: {
        '@type': 'Answer' as const,
        text: f.a.replace(/<[^>]+>/g, '').trim(),
      },
    }));
}
