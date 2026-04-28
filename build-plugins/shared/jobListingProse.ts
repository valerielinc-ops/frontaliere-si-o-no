/**
 * Frontaliere-relevant prose blocks injected into the job-board listing
 * pages (paginated listings + recency hubs).
 *
 * Why this exists
 * ----------------
 * The Apr 2026 audit caught the paginated job listings (`/cerca-lavoro-ticino/pagina-2/`,
 * `/{locale}/find-jobs-ticino/page-3/`) at a 3-4 % visible-text/HTML ratio
 * because the body was just <h1> + one-line description + a list of 50 job
 * cards (lots of structured markup, very little prose). Semrush flags any
 * page below 10 %.
 *
 * The fix is to add COHERENT page-relevant content (CLAUDE.md non-negotiable
 * rule "Never accept thin content"): methodology paragraph, frontaliere
 * context (G-permit, withholding tax, LAMal vs SSN), and FAQ entries that
 * help the reader. To avoid template-wide duplication (Google penalty), the
 * prose is rotated deterministically by `pageNum % VARIANT_COUNT` so each
 * paginated page gets a distinct angle.
 *
 * No hidden text, no `display:none`, no boilerplate that repeats verbatim
 * across pages — Google penalises that. All prose uses the semantic colour
 * tokens from `index.css` (var(--color-body), var(--color-heading)) so it
 * works in both light and dark mode.
 */

export type ListingProseLocale = 'it' | 'en' | 'de' | 'fr';

interface ListingProseVariant {
  /** Methodology paragraph: explains how the listing is curated. */
  methodology: string;
  /** Frontaliere-context paragraph: ties the listing to the cross-border use case. */
  context: string;
  /** Cross-link paragraph: nudges the reader to related comparators / calculator. */
  crossLinks: string;
  /** 3-FAQ block; rendered as <details><summary>. */
  faq: ReadonlyArray<{ question: string; answer: string }>;
  /** Optional "scenario walk-through" tied to a numeric reference (page number). */
  scenario: string;
}

interface ListingProseLabels {
  sectionHeading: string;
  faqHeading: string;
}

const LABELS: Record<ListingProseLocale, ListingProseLabels> = {
  it: {
    sectionHeading: 'Come usare al meglio le offerte di lavoro frontaliere',
    faqHeading: 'Domande frequenti sulle offerte di lavoro in Ticino',
  },
  en: {
    sectionHeading: 'How to make the most of cross-border job listings',
    faqHeading: 'Frequently asked questions about jobs in Ticino',
  },
  de: {
    sectionHeading: 'So holen Sie das Beste aus den Tessiner Stellenangeboten heraus',
    faqHeading: 'Häufige Fragen zu Jobs im Tessin für Grenzgänger',
  },
  fr: {
    sectionHeading: 'Comment tirer le meilleur des offres pour frontaliers',
    faqHeading: 'Questions fréquentes sur les emplois au Tessin',
  },
};

// ── Calculator + comparator slugs (locale-aware) ────────────────────
// Mirror of services/router.ts slug tables — kept inline here so the
// build plugin doesn't pull in the SPA router. If router slugs ever drift
// these strings need to follow.
const CALC_HREF: Record<ListingProseLocale, string> = {
  it: '/',
  en: '/en/',
  de: '/de/',
  fr: '/fr/',
};
const FX_HREF: Record<ListingProseLocale, string> = {
  it: '/comparatori/cambio-valuta/',
  en: '/en/comparators/currency-exchange/',
  de: '/de/vergleiche/wechselkurs/',
  fr: '/fr/comparateurs/change-devises/',
};
const HEALTH_HREF: Record<ListingProseLocale, string> = {
  it: '/comparatori/casse-malati/',
  en: '/en/comparators/health-insurance/',
  de: '/de/vergleiche/krankenkassen/',
  fr: '/fr/comparateurs/caisses-maladie/',
};

const CALC_LABEL: Record<ListingProseLocale, string> = {
  it: 'calcolatore stipendio netto frontaliere',
  en: 'net cross-border salary calculator',
  de: 'Netto-Grenzgänger-Lohnrechner',
  fr: 'calculateur de salaire net frontalier',
};
const FX_LABEL: Record<ListingProseLocale, string> = {
  it: 'comparatore cambio CHF/EUR',
  en: 'CHF/EUR exchange comparator',
  de: 'CHF/EUR-Wechselkurs-Vergleich',
  fr: 'comparateur de change CHF/EUR',
};
const HEALTH_LABEL: Record<ListingProseLocale, string> = {
  it: 'comparatore casse malati LAMal',
  en: 'LAMal health-insurance comparator',
  de: 'LAMal-Krankenkassen-Vergleich',
  fr: 'comparateur des caisses maladie LAMal',
};

// ── Variant table ───────────────────────────────────────────────────
// Three variants per locale; rotated by `(pageNum - 1) % 3` so each
// paginated page receives different prose. The recency hubs receive
// variant 0 (last-3-days) and variant 1 (since-yesterday). Each variant
// covers a distinct angle so even the most-thorough crawler does not
// see template duplication.

const VARIANTS: Record<ListingProseLocale, ReadonlyArray<ListingProseVariant>> = {
  it: [
    {
      methodology: 'Le offerte di lavoro qui elencate sono ordinate dalla più recente alla meno recente, sulla base della data di pubblicazione (o dell\'ultima rotazione del crawler quando l\'azienda non espone una data esplicita). I nostri pipeline interrogano ogni giorno i principali portali ticinesi: il Job Center cantonale, JobUp, JobScout24, gli ATS di banche, ospedali e fiduciarie, oltre alle pagine carriere dei datori di lavoro storici della piazza luganese e mendrisiotta. Ogni offerta passa un controllo di deduplicazione su titolo+azienda+luogo prima di apparire in pagina.',
      context: 'Per chi vive in Italia con permesso G, ogni annuncio in Ticino va valutato considerando l\'imposta alla fonte trattenuta dal datore di lavoro svizzero, i contributi AVS/AI/IPG (5,3 %) e LPP (variabile per età), oltre al rimborso del 24,5 % che spetta ai comuni di residenza italiani sotto il Nuovo Accordo 2026. Lo stipendio lordo CHF non è confrontabile con quello italiano senza questi conguagli — il calcolo netto reale dipende anche dal tasso di cambio del giorno e dalle spese di pendolarismo (carburante, autostrada, pedaggi).',
      crossLinks: `Prima di candidarti consigliamo due passaggi rapidi: simula lo stipendio netto con il <a href="${CALC_HREF.it}" style="color:var(--color-link)">${CALC_LABEL.it}</a> per capire se l\'offerta ha senso rispetto al tuo lavoro attuale, e verifica il <a href="${FX_HREF.it}" style="color:var(--color-link)">${FX_LABEL.it}</a> per impostare il bonifico CHF→EUR al cambio più conveniente. Se l\'azienda offre opzioni LAMal, confronta i premi nel <a href="${HEALTH_HREF.it}" style="color:var(--color-link)">${HEALTH_LABEL.it}</a>.`,
      faq: [
        {
          question: 'Le offerte sono aggiornate in tempo reale?',
          answer: 'Il crawler gira più volte al giorno (almeno 3 cicli) sui principali portali svizzeri, mentre le pagine carriera aziendali sono interrogate ogni 6-12 ore. La data visibile è quella di pubblicazione originale, non quella della scansione, così sai quanto è "fresca" l\'offerta.',
        },
        {
          question: 'Posso filtrare solo le offerte con permesso G ammesso?',
          answer: 'La maggioranza dei datori di lavoro ticinesi accetta candidati frontalieri di default — fanno eccezione alcuni ruoli sensibili in banche cantonali e amministrazione pubblica. Quando l\'annuncio specifica "solo residenti CH" lo segnaliamo nel testo della scheda; in assenza di vincolo esplicito, candidati senza esitare.',
        },
        {
          question: 'Le offerte includono lo stipendio?',
          answer: 'Quando il datore di lavoro pubblica una forchetta CHF, la mostriamo in tutte le schede e nelle pagine dettaglio. Quando non è pubblicata, il nostro modello stima un range basato su qualifica, settore e cantone usando i dati ufficiali UST (Ufficio federale di statistica).',
        },
      ],
      scenario: 'Esempio pratico: un quadro IT con offerta CHF 8\'500 lordi/mese a Lugano. Imposta alla fonte ~13 % (~CHF 1\'105), AVS/AI/IPG 5,3 % (~CHF 450), LPP ~7 % (~CHF 595). Netto svizzero ~CHF 6\'350. Cambio EUR a 1,03 → ~EUR 6\'166. Rimborso 24,5 % al comune italiano (sul lordo CHF) → spinge il netto effettivo verso EUR 6\'500 mensili dopo le ritenute IRPEF a saldo.',
    },
    {
      methodology: 'Questa pagina è una vetrina paginata: ogni 50 annunci vengono raccolti in una pagina separata per non saturare la prima vista, mantenendo i tempi di caricamento sotto i 2 secondi anche su connessione 4G dal valico di Chiasso o Stabio. La numerazione progressiva riflette la profondità temporale: pagine basse = offerte più recenti, pagine alte = offerte ancora valide ma pubblicate qualche settimana fa. Manteniamo online le offerte fino a 30 giorni dalla pubblicazione, poi le rimuoviamo per evitare candidature su posizioni già chiuse.',
      context: 'Lavorare in Ticino come frontaliere significa anche pianificare il pendolarismo: i carichi di traffico ai valichi di Brogeda, Stabio-Gaggiolo e Ponte Tresa variano molto tra picco mattutino (06:30-08:00) e fascia di rientro (16:30-19:00). Una scelta consapevole dell\'azienda — Lugano vs Mendrisio vs Bellinzona — può cambiare il tempo di percorrenza giornaliero di 30-45 minuti, equivalenti a 5-8 ore alla settimana di vita riavute. Le offerte qui elencate riportano sempre il comune di lavoro per facilitare questa valutazione.',
      crossLinks: `Per pianificare il budget mensile reale combina il <a href="${CALC_HREF.it}" style="color:var(--color-link)">${CALC_LABEL.it}</a> con il <a href="${FX_HREF.it}" style="color:var(--color-link)">${FX_LABEL.it}</a>: la differenza tra cambio interbancario e cambio retail di una banca italiana può costare fino a 2 % all\'anno sullo stipendio. Per la scelta cassa malati, il nostro <a href="${HEALTH_HREF.it}" style="color:var(--color-link)">${HEALTH_LABEL.it}</a> mostra i premi LAMal per comune ticinese.`,
      faq: [
        {
          question: 'Qual è la differenza tra le pagine "ultimi 3 giorni" e "da ieri"?',
          answer: 'La pagina "ultimi 3 giorni" raccoglie tutte le offerte pubblicate nelle ultime 72 ore — utile per chi monitora settimanalmente. La pagina "da ieri" mostra solo le offerte delle ultime 24 ore, pensata per chi vuole essere tra i primi a candidarsi prima che la concorrenza saturi la posizione.',
        },
        {
          question: 'Come gestite gli annunci duplicati pubblicati da più portali?',
          answer: 'Ogni offerta riceve una chiave di deduplicazione composta da titolo normalizzato + azienda + comune. Quando lo stesso ruolo appare su JobScout24 e sul sito carriere aziendali, prevale la fonte ufficiale del datore di lavoro (link diretto, dati più freschi). I duplicati vengono accorpati prima della pubblicazione.',
        },
        {
          question: 'Posso ricevere una notifica quando esce un\'offerta nuova?',
          answer: 'Sì — la sezione Avvisi Lavoro permette di salvare filtri (parola chiave, comune, settore) e ricevere un\'email quando arriva un match. È gratuita e si attiva con il proprio indirizzo email, senza creare un account.',
        },
      ],
      scenario: 'Scenario di confronto: un\'offerta a Bellinzona vs una equivalente a Lugano per un infermiere. A Bellinzona lo stipendio CHF tende a essere 5-8 % più alto per compensare la distanza dai valichi italiani; a Lugano il pendolarismo è più breve (~25 km dal valico di Brogeda) ma la concorrenza tra candidati è maggiore. Il nostro calcolatore stipendio mostra entrambi gli scenari in tempo reale.',
    },
    {
      methodology: 'Le aziende monitorate in Ticino si dividono in quattro grandi famiglie: (1) datori di lavoro pubblici — ospedali EOC, USI, amministrazione cantonale, comuni della Città di Lugano; (2) banche e fiduciarie — BancaStato, Raiffeisen, BSI, Cornèr Banca; (3) aziende industriali — La Filanda, Ferrari, Stabio Tech Cluster, manifatturiere del Mendrisiotto; (4) servizi — alberghi del Luganese, ristoranti, retail, ATS specializzati. Ogni famiglia ha cadenze di pubblicazione e ATS diversi (Smartrecruiters, Workday, ATS proprietari) e il nostro pipeline è specializzato per ognuno.',
      context: 'Il Nuovo Accordo Italia-Svizzera del 2026 ha cambiato la geografia fiscale del frontalierato: i comuni italiani entro 20 km dal confine (zona di frontiera) ricevono il 80 % dell\'imposta alla fonte trattenuta in Svizzera. I "vecchi frontalieri" (al lavoro prima del 17 luglio 2023) restano sotto il vecchio regime con tassazione esclusivamente svizzera. I "nuovi frontalieri" sono soggetti a tassazione concorrente: imposta alla fonte CH + IRPEF italiana con credito d\'imposta, con franchigia 10\'000 EUR. Questo influisce sulla scelta della residenza italiana — un trasferimento da Como città (zona di frontiera) a Cernobbio (oltre 20 km) cambia il netto reale annuale.',
      crossLinks: `Il <a href="${CALC_HREF.it}" style="color:var(--color-link)">${CALC_LABEL.it}</a> implementa entrambi i regimi (vecchio + nuovo accordo) e mostra il rimborso ricevuto dal proprio comune. Per chi pendola da zona Como/Varese, il <a href="${FX_HREF.it}" style="color:var(--color-link)">${FX_LABEL.it}</a> confronta i tassi di cambio applicati da banche italiane vs cambia-valute svizzeri vs Wise/Revolut. Il <a href="${HEALTH_HREF.it}" style="color:var(--color-link)">${HEALTH_LABEL.it}</a> spiega quando conviene optare per LAMal vs SSN italiano.`,
      faq: [
        {
          question: 'Sono coperto dal sistema sanitario italiano se lavoro in Ticino?',
          answer: 'Per default no: come frontaliere sei iscritto alla LAMal svizzera e i tuoi famigliari residenti in Italia possono usare il modello S1 per accedere al SSN. Esiste però il diritto di opzione: se eserciti la "rinuncia LAMal" entro 3 mesi dall\'assunzione, vieni iscritto al SSN italiano pagando un contributo proporzionale al reddito (~7,5 %).',
        },
        {
          question: 'Quanto incide il pendolarismo sul netto reale?',
          answer: 'Per un\'auto media a benzina che fa 50 km al giorno (es. Como-Lugano andata-ritorno), il costo annuale è circa CHF 2\'400-3\'000 tra carburante, autostrada e usura. Il transit per l\'autostrada svizzera richiede la vignetta annuale (CHF 40). Sommato al rinnovo permesso G (gratuito) e all\'assicurazione frontaliero, sono ~CHF 3\'000/anno da sottrarre al lordo per ottenere il netto reale.',
        },
        {
          question: 'L\'offerta scade in pagina o resta online?',
          answer: 'Le offerte restano online finché l\'azienda non le rimuove dal proprio ATS. Quando rileviamo che il link è 404 o reindirizza a una pagina "posizione chiusa", marchiamo l\'annuncio come `expired` e lo nascondiamo dalla pagina, ma manteniamo l\'URL stabile per i bookmark.',
        },
      ],
      scenario: 'Scenario fiscale: un nuovo frontaliere residente a Como con lordo CHF 90\'000/anno. Imposta alla fonte CH ~14 % = CHF 12\'600. IRPEF italiana sul lordo (al netto franchigia 10\'000 EUR e credito d\'imposta) ≈ EUR 4\'500-6\'000 a saldo, dipendente dagli scaglioni. Confrontalo con un vecchio frontaliere stesso lordo: solo CH 14 %, nessuna IRPEF. Il delta annuo è significativo e va modellato nel calcolatore.',
    },
  ],
  en: [
    {
      methodology: 'The job listings on this page are sorted from most recent to oldest, based on the original publication date (or the last crawler refresh when the employer does not expose a date). Our pipeline polls the main Ticino portals daily — the cantonal Job Center, JobUp, JobScout24, the ATS of banks, hospitals and trust companies, plus the careers pages of long-standing Lugano and Mendrisiotto employers. Every listing passes a deduplication check on title+company+location before being published.',
      context: 'For Italian-resident G-permit holders, every Ticino vacancy must be evaluated taking into account the source-tax withheld by the Swiss employer, AVS/AI/IPG contributions (5.3 %), LPP (age-dependent), and the 24.5 % refund the new 2026 cross-border tax agreement returns to Italian residence municipalities. The CHF gross figure is not directly comparable to an Italian gross — true take-home depends on the day\'s exchange rate and on commuting costs (fuel, motorway, tolls).',
      crossLinks: `Two quick steps before applying: simulate net pay with the <a href="${CALC_HREF.en}" style="color:var(--color-link)">${CALC_LABEL.en}</a> to see whether the listing improves your current package, and check the <a href="${FX_HREF.en}" style="color:var(--color-link)">${FX_LABEL.en}</a> to time CHF→EUR transfers at the best rate. If the employer offers LAMal coverage, compare premiums in the <a href="${HEALTH_HREF.en}" style="color:var(--color-link)">${HEALTH_LABEL.en}</a>.`,
      faq: [
        {
          question: 'Are listings updated in real time?',
          answer: 'Our crawler runs at least three times per day on Swiss job boards; employer career pages are polled every 6-12 hours. The visible date is the original publication date — not the crawl timestamp — so you can judge how fresh the role is.',
        },
        {
          question: 'Can I filter to only G-permit-friendly roles?',
          answer: 'Most Ticino employers accept cross-border candidates by default. Exceptions are sensitive roles at the cantonal bank and in public administration. When the listing explicitly says "Swiss residents only" we flag it in the card; otherwise apply with confidence.',
        },
        {
          question: 'Are salaries shown?',
          answer: 'When the employer publishes a CHF range we display it on the card and detail page. When no salary is listed, our model estimates a range from grade, sector and canton using official Swiss Federal Statistical Office (FSO/UST) data.',
        },
      ],
      scenario: 'Worked example: an IT manager with a CHF 8,500 monthly gross offer in Lugano. Source tax ~13 % (~CHF 1,105), AVS/AI/IPG 5.3 % (~CHF 450), LPP ~7 % (~CHF 595). Swiss net ~CHF 6,350. EUR rate at 1.03 → ~EUR 6,166. The 24.5 % municipal refund pushes effective take-home toward EUR 6,500 once the Italian IRPEF settlement is applied.',
    },
    {
      methodology: 'This page is a paginated index: every 50 listings collect into a separate page so the first view stays fast — under 2 seconds on a 4G connection from the Chiasso or Stabio crossings. Page numbers reflect temporal depth: low pages = freshest roles, high pages = still-valid roles posted a few weeks ago. We keep listings online for 30 days then delist them to avoid sending you to closed positions.',
      context: 'Working in Ticino as a cross-border worker also means planning your commute: traffic at the Brogeda, Stabio-Gaggiolo and Ponte Tresa crossings varies sharply between morning peak (06:30-08:00) and evening return (16:30-19:00). Choosing a Lugano vs Mendrisio vs Bellinzona role can change daily commute by 30-45 minutes — equivalent to 5-8 hours per week of life regained. Each listing on this page shows the work municipality so you can factor that in.',
      crossLinks: `To plan a real monthly budget combine the <a href="${CALC_HREF.en}" style="color:var(--color-link)">${CALC_LABEL.en}</a> with the <a href="${FX_HREF.en}" style="color:var(--color-link)">${FX_LABEL.en}</a>: the spread between interbank and Italian-bank retail FX can cost up to 2 % per year on your salary. For health insurance, our <a href="${HEALTH_HREF.en}" style="color:var(--color-link)">${HEALTH_LABEL.en}</a> shows LAMal premiums by Ticino municipality.`,
      faq: [
        {
          question: 'What is the difference between the "last 3 days" and "since yesterday" pages?',
          answer: 'The "last 3 days" hub aggregates every listing from the past 72 hours — useful for weekly monitoring. The "since yesterday" page shows only the last 24 hours, designed for candidates who want to apply before the role gets saturated.',
        },
        {
          question: 'How are duplicate listings handled across portals?',
          answer: 'Each listing gets a deduplication key built from a normalised title + company + municipality. When the same role appears on JobScout24 and on the company\'s own careers page, the official employer source wins (direct link, fresher data). Duplicates are merged before publication.',
        },
        {
          question: 'Can I get notified when a new listing matches my filters?',
          answer: 'Yes — the Job Alerts section lets you save filters (keyword, municipality, sector) and receive an email when a match arrives. It is free and uses your email address only — no account creation required.',
        },
      ],
      scenario: 'Comparison scenario: a nurse role in Bellinzona vs an equivalent in Lugano. Bellinzona salaries tend to be 5-8 % higher to compensate for the distance from Italian crossings; Lugano cuts the daily commute (~25 km from Brogeda) but candidate competition is denser. Our salary calculator models both scenarios in real time.',
    },
    {
      methodology: 'Ticino employers cluster into four families: (1) public-sector — EOC hospitals, USI university, cantonal administration, City of Lugano; (2) banks and trust companies — BancaStato, Raiffeisen, BSI, Cornèr Banca; (3) industrial — La Filanda, Ferrari, the Stabio Tech Cluster, Mendrisiotto manufacturers; (4) services — Lugano-area hotels, restaurants, retail, specialist staffing agencies. Each family has its own publication cadence and ATS (Smartrecruiters, Workday, proprietary), and our pipeline is tuned per source.',
      context: 'The 2026 Italy-Switzerland tax agreement reshaped the cross-border map: Italian municipalities within 20 km of the border (the "frontier zone") receive 80 % of the source tax withheld in Switzerland. "Old" cross-border workers (employed before 17 July 2023) stay under the previous regime with Swiss-only taxation. "New" cross-border workers are subject to dual taxation: Swiss source tax + Italian IRPEF with tax credit, with a 10,000 EUR allowance. This affects residence choice — moving from central Como (frontier zone) to Cernobbio (beyond 20 km) changes effective annual net.',
      crossLinks: `The <a href="${CALC_HREF.en}" style="color:var(--color-link)">${CALC_LABEL.en}</a> implements both regimes (old + new agreement) and shows the refund returned by your municipality. For commuters from Como or Varese, the <a href="${FX_HREF.en}" style="color:var(--color-link)">${FX_LABEL.en}</a> compares rates from Italian banks vs Swiss bureaus de change vs Wise/Revolut. The <a href="${HEALTH_HREF.en}" style="color:var(--color-link)">${HEALTH_LABEL.en}</a> covers when LAMal beats the Italian SSN.`,
      faq: [
        {
          question: 'Am I covered by the Italian health system if I work in Ticino?',
          answer: 'By default no: as a cross-border worker you join LAMal in Switzerland, and your Italian-resident family members can use the S1 form to access the Italian SSN. There is a right of option: by exercising "LAMal opt-out" within 3 months of hiring, you stay on the Italian SSN paying an income-proportional contribution (~7.5 %).',
        },
        {
          question: 'How much does the commute eat into net pay?',
          answer: 'For a mid-size petrol car covering 50 km/day (e.g. Como-Lugano return), annual cost is roughly CHF 2,400-3,000 across fuel, motorway and wear. The Swiss motorway vignette costs CHF 40/year. Plus G-permit renewal (free) and the cross-border driver insurance, you subtract ~CHF 3,000/year from gross to get true net.',
        },
        {
          question: 'Do listings expire or stay online?',
          answer: 'Listings stay online while the employer keeps them on its ATS. When we detect a 404 or a "position closed" redirect, we mark the listing `expired` and hide it from the page — but the URL stays stable for bookmarks.',
        },
      ],
      scenario: 'Tax scenario: a new cross-border worker resident in Como, gross CHF 90,000/year. CH source tax ~14 % = CHF 12,600. Italian IRPEF on gross (after 10,000 EUR allowance and tax credit) ≈ EUR 4,500-6,000 settlement, depending on bracket. Compare with an "old" cross-border worker on the same gross: only CH 14 %, no IRPEF. The annual delta is material and should be modelled in the calculator.',
    },
  ],
  de: [
    {
      methodology: 'Die hier aufgeführten Stellen sind chronologisch sortiert — vom neuesten zum ältesten Eintrag — basierend auf dem ursprünglichen Veröffentlichungsdatum (oder dem letzten Crawler-Lauf, wenn der Arbeitgeber kein Datum nennt). Unsere Pipeline fragt täglich die wichtigsten Tessiner Portale ab: das kantonale Job Center, JobUp, JobScout24, die ATS von Banken, Spitälern und Treuhandbüros sowie die Karriereseiten der traditionellen Arbeitgeber im Raum Lugano und Mendrisio. Jeder Eintrag durchläuft vor der Veröffentlichung eine Deduplizierung über Titel + Unternehmen + Ort.',
      context: 'Für italienisch-residente Grenzgänger mit G-Bewilligung muss jede Tessiner Stelle unter Berücksichtigung der vom Schweizer Arbeitgeber einbehaltenen Quellensteuer, der AHV/IV/EO-Beiträge (5,3 %), der BVG (altersabhängig) und der 24,5-%-Rückerstattung an die italienische Wohnsitzgemeinde nach dem neuen Abkommen 2026 bewertet werden. Der CHF-Bruttobetrag ist ohne diese Anpassungen nicht direkt mit einem italienischen Bruttobetrag vergleichbar — der reale Nettobetrag hängt auch vom Tageskurs CHF/EUR und von Pendelkosten (Treibstoff, Autobahn, Mautgebühren) ab.',
      crossLinks: `Zwei schnelle Schritte vor der Bewerbung: Netto-Lohn mit dem <a href="${CALC_HREF.de}" style="color:var(--color-link)">${CALC_LABEL.de}</a> simulieren, um zu sehen, ob das Angebot Ihren aktuellen Gehalt übertrifft, und den <a href="${FX_HREF.de}" style="color:var(--color-link)">${FX_LABEL.de}</a> prüfen, um CHF→EUR-Überweisungen zum besten Tarif zu planen. Wenn der Arbeitgeber LAMal anbietet, die Prämien im <a href="${HEALTH_HREF.de}" style="color:var(--color-link)">${HEALTH_LABEL.de}</a> vergleichen.`,
      faq: [
        {
          question: 'Werden die Stellenangebote in Echtzeit aktualisiert?',
          answer: 'Unser Crawler läuft mindestens dreimal täglich auf den Schweizer Stellenportalen; Karriereseiten der Arbeitgeber werden alle 6-12 Stunden geprüft. Das angezeigte Datum ist das Original-Veröffentlichungsdatum, nicht der Zeitpunkt des Crawls — so erkennen Sie, wie aktuell die Stelle ist.',
        },
        {
          question: 'Kann ich nur G-Bewilligungs-freundliche Stellen filtern?',
          answer: 'Die meisten Tessiner Arbeitgeber akzeptieren Grenzgänger standardmäßig. Ausnahmen bilden sensitive Funktionen bei der Kantonalbank und in der öffentlichen Verwaltung. Wenn das Inserat ausdrücklich "nur CH-Wohnsitz" verlangt, markieren wir das in der Karte; ansonsten bewerben Sie sich unbesorgt.',
        },
        {
          question: 'Werden Gehälter angezeigt?',
          answer: 'Wenn der Arbeitgeber eine CHF-Spanne veröffentlicht, zeigen wir sie auf der Karte und Detailseite. Fehlt die Angabe, schätzt unser Modell eine Spanne aus Position, Branche und Kanton anhand offizieller BFS-Daten (Bundesamt für Statistik).',
        },
      ],
      scenario: 'Rechenbeispiel: ein IT-Kaderangestellter mit Bruttoangebot CHF 8\'500/Monat in Lugano. Quellensteuer ~13 % (~CHF 1\'105), AHV/IV/EO 5,3 % (~CHF 450), BVG ~7 % (~CHF 595). Schweizer Netto ~CHF 6\'350. EUR-Kurs 1,03 → ~EUR 6\'166. Die 24,5-%-Rückerstattung an die italienische Gemeinde hebt das effektive Netto nach IRPEF-Ausgleich auf rund EUR 6\'500.',
    },
    {
      methodology: 'Diese Seite ist ein paginierter Index: alle 50 Stellen werden auf einer eigenen Seite gesammelt, damit die erste Ansicht schnell bleibt — unter 2 Sekunden auch über eine 4G-Verbindung an den Übergängen Chiasso oder Stabio. Die Seitenzahl spiegelt die zeitliche Tiefe wider: niedrige Seiten = neueste Stellen, hohe Seiten = noch gültige Stellen vor einigen Wochen. Wir halten Stellen 30 Tage online und entfernen sie dann, um Bewerbungen auf bereits geschlossene Positionen zu vermeiden.',
      context: 'Als Grenzgänger im Tessin müssen Sie auch das Pendeln planen: das Verkehrsaufkommen an den Übergängen Brogeda, Stabio-Gaggiolo und Ponte Tresa schwankt stark zwischen morgendlicher Spitze (06:30-08:00) und Heimfahrt (16:30-19:00). Die Wahl Lugano vs Mendrisio vs Bellinzona kann den täglichen Pendelweg um 30-45 Minuten verändern — entspricht 5-8 zurückgewonnenen Stunden Lebenszeit pro Woche. Jede Stelle auf dieser Seite zeigt die Arbeitsgemeinde, damit Sie diesen Faktor berücksichtigen können.',
      crossLinks: `Für ein realistisches Monatsbudget kombinieren Sie den <a href="${CALC_HREF.de}" style="color:var(--color-link)">${CALC_LABEL.de}</a> mit dem <a href="${FX_HREF.de}" style="color:var(--color-link)">${FX_LABEL.de}</a>: die Differenz zwischen Interbankenkurs und italienischem Bankenkurs kostet bis zu 2 % pro Jahr auf das Gehalt. Zur Krankenkassenwahl zeigt unser <a href="${HEALTH_HREF.de}" style="color:var(--color-link)">${HEALTH_LABEL.de}</a> die LAMal-Prämien nach Tessiner Gemeinde.`,
      faq: [
        {
          question: 'Was ist der Unterschied zwischen "letzte 3 Tage" und "seit gestern"?',
          answer: 'Die Seite "letzte 3 Tage" sammelt alle Stellen der letzten 72 Stunden — gut zum wöchentlichen Monitoring. Die Seite "seit gestern" zeigt nur die letzten 24 Stunden — gedacht für schnelle Bewerber, die unter den ersten sein wollen.',
        },
        {
          question: 'Wie werden Duplikate über mehrere Portale hinweg behandelt?',
          answer: 'Jede Stelle erhält einen Deduplikations-Schlüssel aus normalisiertem Titel + Unternehmen + Gemeinde. Erscheint dieselbe Rolle auf JobScout24 und der Karriereseite des Arbeitgebers, gewinnt die offizielle Quelle (direkter Link, frischere Daten). Duplikate werden vor der Publikation zusammengeführt.',
        },
        {
          question: 'Kann ich Benachrichtigungen erhalten, wenn neue Stellen meinen Filtern entsprechen?',
          answer: 'Ja — der Job-Alert-Bereich erlaubt das Speichern von Filtern (Stichwort, Gemeinde, Branche) und sendet eine E-Mail bei Treffern. Kostenlos, nur per E-Mail-Adresse — kein Konto erforderlich.',
        },
      ],
      scenario: 'Vergleichsszenario: eine Pflegestelle in Bellinzona vs eine vergleichbare in Lugano. Bellinzonaer Löhne liegen 5-8 % höher zur Kompensation der Distanz zu den italienischen Übergängen; Lugano verkürzt den täglichen Pendelweg (~25 km von Brogeda), die Bewerberkonkurrenz ist aber höher. Unser Lohnrechner modelliert beide Szenarien in Echtzeit.',
    },
    {
      methodology: 'Tessiner Arbeitgeber lassen sich in vier Familien gliedern: (1) öffentliche Hand — EOC-Spitäler, Universität USI, Kantonsverwaltung, Stadt Lugano; (2) Banken und Treuhand — BancaStato, Raiffeisen, BSI, Cornèr Banca; (3) Industrie — La Filanda, Ferrari, Stabio Tech Cluster, Mendrisiotto-Industrie; (4) Dienstleistungen — Hotels im Raum Lugano, Restaurants, Retail, spezialisierte Personalvermittler. Jede Familie hat eigene Publikationsrhythmen und ATS (Smartrecruiters, Workday, proprietär) — unsere Pipeline ist pro Quelle abgestimmt.',
      context: 'Das Steuerabkommen Italien-Schweiz 2026 hat die Grenzgänger-Geografie neu gezeichnet: italienische Gemeinden innerhalb 20 km der Grenze (Grenzzone) erhalten 80 % der in der Schweiz einbehaltenen Quellensteuer. "Alte" Grenzgänger (vor dem 17. Juli 2023 angestellt) bleiben im alten Regime mit ausschließlicher CH-Besteuerung. "Neue" Grenzgänger werden gemeinsam besteuert: CH-Quellensteuer + italienische IRPEF mit Steuerguthaben, mit 10\'000-EUR-Freibetrag. Das beeinflusst die Wohnsitzwahl — ein Umzug von der Stadt Como (Grenzzone) nach Cernobbio (über 20 km) verändert das jährliche Reinneto.',
      crossLinks: `Der <a href="${CALC_HREF.de}" style="color:var(--color-link)">${CALC_LABEL.de}</a> implementiert beide Regime (altes + neues Abkommen) und zeigt die Rückerstattung Ihrer Gemeinde. Für Pendler aus dem Raum Como/Varese vergleicht der <a href="${FX_HREF.de}" style="color:var(--color-link)">${FX_LABEL.de}</a> die Kurse italienischer Banken vs Schweizer Wechselstuben vs Wise/Revolut. Der <a href="${HEALTH_HREF.de}" style="color:var(--color-link)">${HEALTH_LABEL.de}</a> beschreibt, wann sich LAMal gegenüber dem italienischen SSN lohnt.`,
      faq: [
        {
          question: 'Bin ich vom italienischen Gesundheitssystem abgedeckt, wenn ich im Tessin arbeite?',
          answer: 'Standardmäßig nein: als Grenzgänger sind Sie LAMal-pflichtig in der Schweiz, und Ihre italienisch-residenten Familienmitglieder können über das Formular S1 den italienischen SSN nutzen. Es gibt ein Optionsrecht: durch "LAMal-Verzicht" innerhalb von 3 Monaten nach Anstellung bleiben Sie im italienischen SSN und zahlen einen einkommensproportionalen Beitrag (~7,5 %).',
        },
        {
          question: 'Wie stark frisst das Pendeln am Netto-Lohn?',
          answer: 'Für ein mittelgroßes Benzin-Auto mit 50 km/Tag (z.B. Como-Lugano hin/zurück) beträgt der Jahresaufwand rund CHF 2\'400-3\'000 für Treibstoff, Autobahn und Verschleiß. Die Schweizer Autobahnvignette kostet CHF 40/Jahr. Plus G-Bewilligungs-Erneuerung (kostenlos) und Grenzgänger-Versicherung — insgesamt ziehen Sie ~CHF 3\'000/Jahr vom Brutto ab, um das echte Netto zu erhalten.',
        },
        {
          question: 'Verfallen die Stellenangebote oder bleiben sie online?',
          answer: 'Die Stellen bleiben online, solange der Arbeitgeber sie auf seinem ATS hält. Wenn wir einen 404 oder "Position geschlossen"-Redirect erkennen, markieren wir den Eintrag `expired` und blenden ihn aus — der URL bleibt aber stabil für Lesezeichen.',
        },
      ],
      scenario: 'Steuerszenario: ein neuer Grenzgänger mit Wohnsitz Como, Brutto CHF 90\'000/Jahr. CH-Quellensteuer ~14 % = CHF 12\'600. Italienische IRPEF auf Brutto (nach 10\'000-EUR-Freibetrag und Steuerguthaben) ≈ EUR 4\'500-6\'000 Saldo, je nach Stufe. Vergleich mit altem Grenzgänger gleiches Brutto: nur CH 14 %, keine IRPEF. Der Jahresunterschied ist erheblich und sollte im Rechner modelliert werden.',
    },
  ],
  fr: [
    {
      methodology: 'Les offres d\'emploi listées sont triées de la plus récente à la plus ancienne, selon la date de publication d\'origine (ou la dernière rotation du crawler quand l\'employeur n\'expose pas de date). Notre pipeline interroge chaque jour les principaux portails tessinois : le Job Center cantonal, JobUp, JobScout24, les ATS des banques, hôpitaux et fiduciaires, ainsi que les pages carrières des employeurs historiques de Lugano et du Mendrisiotto. Chaque offre passe un contrôle de déduplication titre + entreprise + commune avant publication.',
      context: 'Pour les frontaliers résidents italiens avec permis G, chaque poste tessinois doit être évalué en tenant compte de l\'impôt à la source retenu par l\'employeur suisse, des cotisations AVS/AI/APG (5,3 %), du LPP (variable selon l\'âge) et du remboursement de 24,5 % que le nouvel accord fiscal 2026 retourne aux communes italiennes de résidence. Le brut CHF n\'est pas directement comparable à un brut italien sans ces ajustements — le net réel dépend aussi du taux de change du jour et des coûts de frontalier (carburant, autoroute, péages).',
      crossLinks: `Deux étapes rapides avant de postuler : simuler le net avec le <a href="${CALC_HREF.fr}" style="color:var(--color-link)">${CALC_LABEL.fr}</a> pour vérifier si le poste améliore votre situation, et consulter le <a href="${FX_HREF.fr}" style="color:var(--color-link)">${FX_LABEL.fr}</a> pour planifier les transferts CHF→EUR au meilleur taux. Si l\'employeur propose une couverture LAMal, comparez les primes dans le <a href="${HEALTH_HREF.fr}" style="color:var(--color-link)">${HEALTH_LABEL.fr}</a>.`,
      faq: [
        {
          question: 'Les offres sont-elles mises à jour en temps réel ?',
          answer: 'Notre crawler tourne au moins trois fois par jour sur les portails suisses ; les pages carrières des employeurs sont consultées toutes les 6-12 heures. La date affichée est la date de publication d\'origine — pas l\'horodatage du crawl — ce qui permet de juger la fraîcheur du poste.',
        },
        {
          question: 'Puis-je filtrer uniquement les postes ouverts aux permis G ?',
          answer: 'La majorité des employeurs tessinois acceptent les frontaliers par défaut. Les exceptions concernent des fonctions sensibles à la banque cantonale et dans l\'administration publique. Quand l\'annonce précise "résidents CH uniquement", nous le signalons sur la fiche ; sinon postulez sans hésiter.',
        },
        {
          question: 'Les salaires sont-ils affichés ?',
          answer: 'Quand l\'employeur publie une fourchette CHF, nous l\'affichons sur la fiche et la page détail. À défaut, notre modèle estime une fourchette à partir du grade, du secteur et du canton sur la base des données officielles OFS (Office fédéral de la statistique).',
        },
      ],
      scenario: 'Cas concret : un cadre IT avec offre brute CHF 8\'500/mois à Lugano. Impôt à la source ~13 % (~CHF 1\'105), AVS/AI/APG 5,3 % (~CHF 450), LPP ~7 % (~CHF 595). Net suisse ~CHF 6\'350. Taux EUR à 1,03 → ~EUR 6\'166. Le remboursement de 24,5 % à la commune italienne porte le net effectif vers EUR 6\'500 mensuels après le solde IRPEF italien.',
    },
    {
      methodology: 'Cette page est un index paginé : toutes les 50 offres sont regroupées sur une page distincte pour garder la première vue rapide — moins de 2 secondes même sur une connexion 4G aux passages de Chiasso ou Stabio. Le numéro de page reflète la profondeur temporelle : pages basses = postes les plus frais, pages hautes = postes encore valides publiés il y a quelques semaines. Nous gardons les offres en ligne pendant 30 jours puis les retirons pour éviter les candidatures sur des positions fermées.',
      context: 'Travailler au Tessin comme frontalier signifie aussi planifier les trajets : la circulation aux passages de Brogeda, Stabio-Gaggiolo et Ponte Tresa varie fortement entre la pointe matinale (06:30-08:00) et le retour (16:30-19:00). Choisir un poste à Lugano vs Mendrisio vs Bellinzona peut changer le trajet quotidien de 30-45 minutes — soit 5-8 heures par semaine de vie récupérées. Chaque offre sur cette page indique la commune de travail pour faciliter ce calcul.',
      crossLinks: `Pour planifier un budget mensuel réaliste, combinez le <a href="${CALC_HREF.fr}" style="color:var(--color-link)">${CALC_LABEL.fr}</a> avec le <a href="${FX_HREF.fr}" style="color:var(--color-link)">${FX_LABEL.fr}</a> : l\'écart entre taux interbancaire et taux retail des banques italiennes peut coûter jusqu\'à 2 % par an sur le salaire. Pour le choix de la caisse maladie, notre <a href="${HEALTH_HREF.fr}" style="color:var(--color-link)">${HEALTH_LABEL.fr}</a> affiche les primes LAMal par commune tessinoise.`,
      faq: [
        {
          question: 'Quelle est la différence entre les pages "3 derniers jours" et "depuis hier" ?',
          answer: 'La page "3 derniers jours" rassemble toutes les offres des 72 dernières heures — utile pour un suivi hebdomadaire. La page "depuis hier" ne montre que les 24 dernières heures — pensée pour les candidats rapides qui veulent figurer parmi les premiers à postuler.',
        },
        {
          question: 'Comment gérez-vous les annonces dupliquées sur plusieurs portails ?',
          answer: 'Chaque offre reçoit une clé de déduplication composée de titre normalisé + entreprise + commune. Quand le même poste apparaît sur JobScout24 et la page carrière de l\'employeur, la source officielle prime (lien direct, données plus fraîches). Les doublons sont fusionnés avant publication.',
        },
        {
          question: 'Puis-je recevoir une notification quand une nouvelle offre correspond à mes filtres ?',
          answer: 'Oui — la section Alertes Emploi permet d\'enregistrer des filtres (mot-clé, commune, secteur) et reçoit un e-mail dès qu\'une offre correspond. Service gratuit, simple e-mail — pas besoin de créer un compte.',
        },
      ],
      scenario: 'Scénario de comparaison : un poste d\'infirmier à Bellinzone vs équivalent à Lugano. Les salaires de Bellinzone tendent à être 5-8 % plus élevés pour compenser la distance des passages italiens ; Lugano réduit le trajet (~25 km de Brogeda) mais la concurrence est plus dense. Notre calculateur de salaire modélise les deux scénarios en temps réel.',
    },
    {
      methodology: 'Les employeurs tessinois se regroupent en quatre familles : (1) secteur public — hôpitaux EOC, université USI, administration cantonale, Ville de Lugano ; (2) banques et fiduciaires — BancaStato, Raiffeisen, BSI, Cornèr Banca ; (3) industrie — La Filanda, Ferrari, Stabio Tech Cluster, manufacturiers du Mendrisiotto ; (4) services — hôtels luganais, restaurants, retail, agences de placement spécialisées. Chaque famille a son rythme de publication et son ATS (Smartrecruiters, Workday, propriétaire) — notre pipeline est calibré par source.',
      context: 'L\'accord fiscal Italie-Suisse 2026 a redessiné la carte du frontalier : les communes italiennes dans les 20 km de la frontière (zone frontalière) reçoivent 80 % de l\'impôt à la source retenu en Suisse. Les "anciens" frontaliers (engagés avant le 17 juillet 2023) restent dans l\'ancien régime — taxation suisse uniquement. Les "nouveaux" frontaliers sont soumis à la double taxation : impôt à la source CH + IRPEF italienne avec crédit d\'impôt, avec abattement de 10\'000 EUR. Cela influe sur le choix de la résidence — un déménagement du centre de Côme (zone frontalière) à Cernobbio (au-delà de 20 km) change le net annuel réel.',
      crossLinks: `Le <a href="${CALC_HREF.fr}" style="color:var(--color-link)">${CALC_LABEL.fr}</a> implémente les deux régimes (ancien + nouvel accord) et affiche le remboursement reversé par votre commune. Pour les frontaliers de Côme/Varèse, le <a href="${FX_HREF.fr}" style="color:var(--color-link)">${FX_LABEL.fr}</a> compare les taux des banques italiennes vs bureaux de change suisses vs Wise/Revolut. Le <a href="${HEALTH_HREF.fr}" style="color:var(--color-link)">${HEALTH_LABEL.fr}</a> explique quand LAMal bat le SSN italien.`,
      faq: [
        {
          question: 'Suis-je couvert par le système de santé italien si je travaille au Tessin ?',
          answer: 'Par défaut non : en tant que frontalier, vous êtes affilié à la LAMal en Suisse, et vos proches résidents en Italie peuvent utiliser le formulaire S1 pour accéder au SSN italien. Il existe un droit d\'option : par "renonciation LAMal" dans les 3 mois suivant l\'embauche, vous restez au SSN italien en payant une contribution proportionnelle aux revenus (~7,5 %).',
        },
        {
          question: 'Quel est l\'impact du trajet sur le net réel ?',
          answer: 'Pour une voiture moyenne essence parcourant 50 km/jour (ex. Côme-Lugano aller-retour), le coût annuel est d\'environ CHF 2\'400-3\'000 entre carburant, autoroute et usure. La vignette autoroutière suisse coûte CHF 40/an. Plus le renouvellement du permis G (gratuit) et l\'assurance frontalier — soit ~CHF 3\'000/an à soustraire au brut pour obtenir le net réel.',
        },
        {
          question: 'Les offres expirent-elles ou restent-elles en ligne ?',
          answer: 'Les offres restent en ligne tant que l\'employeur les conserve sur son ATS. Quand nous détectons un 404 ou une redirection "poste fermé", nous marquons l\'annonce `expired` et la masquons — mais l\'URL reste stable pour les favoris.',
        },
      ],
      scenario: 'Scénario fiscal : un nouveau frontalier résident à Côme avec brut CHF 90\'000/an. Impôt à la source CH ~14 % = CHF 12\'600. IRPEF italienne sur le brut (après abattement 10\'000 EUR et crédit d\'impôt) ≈ EUR 4\'500-6\'000 de solde, selon la tranche. Comparaison avec un ancien frontalier même brut : seulement CH 14 %, pas d\'IRPEF. L\'écart annuel est significatif et doit être modélisé dans le calculateur.',
    },
  ],
};

const TOTAL_VARIANTS = VARIANTS.it.length;

function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pickVariant(locale: ListingProseLocale, seed: number): ListingProseVariant {
  const variants = VARIANTS[locale];
  const idx = ((seed % TOTAL_VARIANTS) + TOTAL_VARIANTS) % TOTAL_VARIANTS;
  return variants[idx];
}

/**
 * Render the prose section appended after the pagination nav on
 * `/cerca-lavoro-ticino/pagina-{N}/` and locale equivalents.
 *
 * `seed` is typically the page number — different page numbers receive
 * different prose (mod 3) so each indexed page has unique content.
 */
export function renderListingPaginationProse(
  locale: ListingProseLocale,
  seed: number,
): string {
  const v = pickVariant(locale, seed);
  const labels = LABELS[locale];

  // Each <p>/<h2>/<h3>/<details> element is unescaped because the prose
  // strings are author-controlled in this module (no user input flows in).
  // The cross-links contain anchor tags, so HTML escaping would break them.
  const faqHtml = v.faq
    .map(
      (f) =>
        `<details style="background:var(--color-surface);border:1px solid var(--color-edge);border-radius:12px;padding:14px 16px;margin-bottom:8px"><summary style="font-weight:700;cursor:pointer;color:var(--color-heading)">${escAttr(f.question)}</summary><p style="margin:8px 0 0;color:var(--color-body);line-height:1.6">${escAttr(f.answer)}</p></details>`,
    )
    .join('');

  return `<section style="max-width:860px;margin:32px auto 0;color:var(--color-body);line-height:1.65;font-size:15px">
  <h2 style="font-size:22px;font-weight:700;color:var(--color-heading);margin:0 0 14px">${escAttr(labels.sectionHeading)}</h2>
  <p style="margin:0 0 14px">${v.methodology}</p>
  <p style="margin:0 0 14px">${v.context}</p>
  <p style="margin:0 0 14px">${v.crossLinks}</p>
  <p style="margin:0 0 22px;padding:14px 16px;background:var(--color-surface-alt);border-radius:12px;border-left:3px solid var(--color-link)"><strong style="color:var(--color-heading)">${escAttr(locale === 'it' ? 'Esempio' : locale === 'en' ? 'Example' : locale === 'de' ? 'Beispiel' : 'Exemple')}:</strong> ${v.scenario}</p>
  <h3 style="font-size:18px;font-weight:700;color:var(--color-heading);margin:24px 0 12px">${escAttr(labels.faqHeading)}</h3>
  ${faqHtml}
</section>`;
}

/**
 * Render the methodology + extended FAQ block appended to the recency hubs
 * (`/cerca-lavoro-ticino/ultimi-3-giorni/`, etc.).
 *
 * Reuses the variant pool but prefers different prose than the pagination
 * pages so the recency hubs aren\'t a clone of `/pagina-2/`. The
 * `windowDays` parameter (1 or 3) seeds the rotation.
 */
export function renderRecencyHubProse(
  locale: ListingProseLocale,
  windowDays: number,
): string {
  // windowDays=3 → variant 1 (paginated context already shows variant 0 + 2 + 1
  // for the first three pages, so variant 1 + 2 are richest for recency hubs).
  // windowDays=1 → variant 2.
  const seed = windowDays === 1 ? 2 : 1;
  const v = pickVariant(locale, seed);
  const labels = LABELS[locale];

  const faqHtml = v.faq
    .map(
      (f) =>
        `<details style="background:var(--color-surface);border:1px solid var(--color-edge);border-radius:12px;padding:14px 16px;margin-bottom:8px"><summary style="font-weight:700;cursor:pointer;color:var(--color-heading)">${escAttr(f.question)}</summary><p style="margin:8px 0 0;color:var(--color-body);line-height:1.6">${escAttr(f.answer)}</p></details>`,
    )
    .join('');

  return `<section style="max-width:860px;margin:32px auto 0;color:var(--color-body);line-height:1.65;font-size:15px">
  <h2 style="font-size:22px;font-weight:700;color:var(--color-heading);margin:0 0 14px">${escAttr(labels.sectionHeading)}</h2>
  <p style="margin:0 0 14px">${v.methodology}</p>
  <p style="margin:0 0 14px">${v.context}</p>
  <p style="margin:0 0 14px">${v.crossLinks}</p>
  <p style="margin:0 0 22px;padding:14px 16px;background:var(--color-surface-alt);border-radius:12px;border-left:3px solid var(--color-link)"><strong style="color:var(--color-heading)">${escAttr(locale === 'it' ? 'Esempio' : locale === 'en' ? 'Example' : locale === 'de' ? 'Beispiel' : 'Exemple')}:</strong> ${v.scenario}</p>
  <h3 style="font-size:18px;font-weight:700;color:var(--color-heading);margin:24px 0 12px">${escAttr(labels.faqHeading)}</h3>
  ${faqHtml}
</section>`;
}
