/**
 * Editorial copy for the 4 career quick-win landings × 4 locales (AE-2).
 *
 * Italian is primary and hand-written (≥800 words each). EN/DE/FR are
 * condensed but complete (≥400 words each — no placeholder copy). Every
 * regulated claim cites the primary source inline:
 *   - Concorsi: concorsi.ti.ch + www4.ti.ch/index.php?id=147427
 *   - Agenzie SECO: vzavg1.admin.ch AVG directory
 *   - Frontalieri CCL / accordo fiscale: AFC / SECO / Ufficio Popolazione TI
 *   - Stage: UST — Ufficio federale di statistica per i numeri salariali
 *     dove applicabile.
 *
 * The copy NEVER claims the SECO agency list is exhaustive — it ships
 * with a disclaimer + link to the SECO register. Similarly the concorsi
 * list is a snapshot with "aggiornato il" timestamp and a pointer to the
 * canonical listing on www4.ti.ch.
 */

import type { CareerLocale, CareerLandingId } from './careerLandingsData';

export interface CareerLandingSection {
  title: string;
  paragraphs: string[];
}

export interface CareerLandingFaq {
  question: string;
  answer: string;
}

export interface CareerLandingCopy {
  title: string;
  description: string;
  h1: string;
  /** Long-form intro paragraph — pushed below the divider under template B. */
  lede: string;
  updatedLabel: string;
  breadcrumbHome: string;
  breadcrumbJobs: string;
  ctaJobs: string;
  ctaSimulator: string;
  relatedLabel: string;
  faqTitle: string;
  sourcesLabel: string;
  /** Inline bullet list of authoritative sources, rendered under the copy. */
  sources: Array<{ label: string; href: string }>;
  sections: CareerLandingSection[];
  faqs: CareerLandingFaq[];
}

/**
 * Template B labels — shared across all 4 career landings in a given locale.
 * Per-id divergence (e.g. "Concorsi aperti" vs "Agenzie SECO") is handled by
 * the `buildCareerTemplateBCopy` helper that splices a per-id label set on
 * top of the locale shell.
 */
export interface CareerTemplateBShell {
  eyebrow: string;
  updatedLabel: string;
  approfondisciHeading: string;
  featuredJobsTitle: string;
  featuredJobsEmpty: string;
  /** Builds the "see all N openings" CTA when featured.length > 0. */
  featuredJobsCtaAll: (n: number) => string;
  employerGridTitle: string;
  jobPostedLabel: (daysAgo: number) => string;
  jobSalaryFmt: (min: number | null, max: number | null) => string;
  /** "Nessuna offerta indicizzata" — used when featured + jobs are 0. */
  noSalaryLabel: string;
}

/**
 * Per-id template-B copy. `denseLede` is the 1-line tagline (≤120 chars),
 * `statTile*` are the 3 stat-tile triplets the renderer feeds into
 * `renderStatGrid`. `primaryCtaLabel` + `primaryCtaHref` describe the killer
 * CTA above the fold; the renderer wraps them in `CTA_PRIMARY_STYLE`.
 *
 * Tiles are `null` when the underlying data is not meaningful for the id
 * (e.g. stage doesn't ship an employer grid; agenzie doesn't ship featured
 * jobs; contratti doesn't ship either).
 */
export interface CareerTemplateBCopy {
  /** Per-id eyebrow (overrides shell when set, defaults to shell). */
  eyebrow: string;
  /** ≤120-char tagline shown directly under the H1. */
  denseLede: string;
  /** 3 stat tiles — labels are static copy, values come from the snapshot. */
  statTile1: { label: string; valueFromCount: (count: number) => string; tone: 'success' | 'accent' | 'warning' | 'danger' | 'neutral' };
  statTile2: { label: string; value: string | ((snapshot: { medianSalary: number | null; liveCount: number }) => string); tone: 'success' | 'accent' | 'warning' | 'danger' | 'neutral' };
  statTile3: { label: string; valueFromFresh: (fresh: number) => string; tone: 'success' | 'accent' | 'warning' | 'danger' | 'neutral' };
  /** Primary CTA copy — links to the calculator or job-board. */
  primaryCtaLabel: string;
  /** Path-relative href for the primary CTA. */
  primaryCtaHref: string;
  /** When false the renderer skips the featured-jobs section entirely. */
  showFeaturedJobs: boolean;
  /** When false the renderer skips the employer grid; some pages show curated copy instead. */
  showEmployerGrid: boolean;
  /** Optional editorial replacement when the employer grid is suppressed (stage / contratti). */
  employerGridReplacement?: string;
  /** Section title for the featured jobs (defaults to shell). */
  featuredJobsTitle?: string;
  /**
   * Optional one-line subtitle rendered under the featured-jobs section title.
   * Used for honesty disclaimers on pages where the listed roles are proxies
   * (e.g. agenzie-lavoro-lugano shows Lugano-area staffing-typical roles, not
   * jobs actually hosted by SECO agencies — the subtitle says so). Not
   * rendered when empty.
   */
  featuredJobsSubtitle?: string;
  /** Section title for the employer grid (defaults to shell). */
  employerGridTitle?: string;
}

// ─────────────────────────────────────────────────────────────────
// IT — canonical (≥800 words per page)
// ─────────────────────────────────────────────────────────────────

const IT_AGENZIE: CareerLandingCopy = {
  title: 'Agenzie del lavoro a Lugano: guida SECO 2026',
  description:
    'Guida alle agenzie del lavoro (collocamento e prestito di personale) attive a Lugano nel 2026: come verificare l\'autorizzazione SECO, cosa controllare nel contratto interinale, diritti del frontaliere con permesso G e differenze con le agenzie italiane.',
  h1: 'Agenzie del lavoro a Lugano: guida 2026 per frontalieri',
  lede: 'A Lugano operano decine di agenzie di collocamento e di prestito di personale, tutte soggette al controllo SECO. Questa guida spiega come riconoscere un\'agenzia autorizzata, cosa deve contenere il contratto che firmi come frontaliere con permesso G, quali sono le principali agenzie attive in città e dove cercare l\'elenco ufficiale aggiornato.',
  updatedLabel: 'Aggiornato',
  breadcrumbHome: 'Home',
  breadcrumbJobs: 'Lavoro Ticino',
  ctaJobs: 'Vedi offerte di lavoro a Lugano',
  ctaSimulator: 'Calcola il tuo stipendio netto',
  relatedLabel: 'Risorse collegate',
  faqTitle: 'Domande frequenti',
  sourcesLabel: 'Fonti',
  sources: [
    {
      label:
        'Registro SECO AVG — agenzie di collocamento e prestito di personale autorizzate',
      href: 'https://www.vzavg1.admin.ch/vzavg-verzeichnis-frontend',
    },
    {
      label: 'SECO — Collocamento privato e prestito di personale',
      href: 'https://www.seco.admin.ch/seco/it/home/Arbeit/Personenfreizugigkeit_Arbeitsbeziehungen/Private_Arbeitsvermittlung_und_Personalverleih.html',
    },
    {
      label:
        'Legge federale sul collocamento (LC) — Confederazione Svizzera',
      href: 'https://www.fedlex.admin.ch/eli/cc/1991/392_392_392/it',
    },
  ],
  sections: [
    {
      title: 'Come riconoscere un\'agenzia autorizzata SECO',
      paragraphs: [
        'In Svizzera il mercato del lavoro interinale è regolato dalla Legge federale sul collocamento (LC) del 6 ottobre 1989 e dalla relativa ordinanza (OC). Ogni agenzia che voglia fare collocamento (match fra candidato e datore di lavoro finale) o prestito di personale (l\'agenzia è il datore di lavoro del lavoratore, che viene "prestato" a un\'azienda utilizzatrice) deve avere un\'autorizzazione cantonale e — per operare oltre i confini del cantone o con candidati esteri — anche un\'autorizzazione federale SECO.',
        'La SECO mantiene un registro elettronico pubblico di tutte le imprese autorizzate. L\'accesso è libero: si cerca per nome, città o cantone sul portale AVG-Verzeichnis. Se il nome dell\'agenzia che ti contatta non compare nel registro, è un campanello d\'allarme forte — potrebbe trattarsi di un\'attività non autorizzata. Verificare prima di firmare è il primo passo di tutela per qualsiasi frontaliere con permesso G.',
        'Come frontaliere hai il diritto di chiedere all\'agenzia la copia del numero di autorizzazione SECO (sotto forma di decisione amministrativa) e la conferma che l\'attività coperta sia effettivamente collocamento o prestito di personale. Questo è particolarmente importante se l\'agenzia ti chiede di firmare un contratto interinale: in quel caso è l\'agenzia a essere il tuo datore di lavoro svizzero e a dover applicare il CCL Personalverleih (CCL NAM-FU) nazionale.',
      ],
    },
    {
      title: 'Le principali agenzie attive a Lugano',
      paragraphs: [
        'A Lugano e nel Sottoceneri operano numerose agenzie autorizzate. Fra i nomi più noti che hanno sede o filiale in città ci sono Adecco, Manpower, Randstad, Kelly Services, Interiman, Sintex, Axxon Services e Trenkwalder. Tutti questi brand sono presenti nel registro SECO AVG e applicano il CCL Personalverleih per il prestito di personale.',
        'L\'elenco non è esaustivo: oltre ai grandi gruppi internazionali esistono decine di agenzie locali specializzate (sanitario, edilizia, IT, hospitality). Per ottenere la lista completa e sempre aggiornata delle agenzie autorizzate a operare nel Cantone Ticino, la fonte ufficiale è il registro SECO AVG, filtrabile per cantone (TI) e comune. Consigliamo di confrontare sempre due o tre agenzie prima di accettare una missione: le percentuali applicate al salario orario e le condizioni di fine missione possono variare sensibilmente.',
        'Per i profili sanitari (infermieri, OSS) e industriali (tornitori, elettricisti, operai specializzati) la domanda è particolarmente elevata e le agenzie spesso offrono bonus di ingaggio, copertura spese trasporto e accompagnamento al riconoscimento del titolo. Il suggerimento operativo è: registrarsi contemporaneamente presso più agenzie per massimizzare le opportunità di matching.',
      ],
    },
    {
      title: 'Che cosa deve contenere il contratto interinale',
      paragraphs: [
        'Un contratto di prestito di personale in Svizzera deve specificare: salario orario lordo, supplementi per straordinari e notturni, indennità per ferie (almeno 8,33% per chi ha diritto a 4 settimane), tredicesima (proporzionale al tempo lavorato), oneri sociali trattenuti (AVS/AI/IPG 5,3%, AD 1,1%, LPP variabile, LAINF non-professionale), durata minima garantita della missione se prevista.',
        'Per i frontalieri con permesso G il contratto deve esplicitare l\'applicazione dell\'imposta alla fonte e la ritenuta del contributo di compensazione (per i nuovi frontalieri, disciplinato dall\'accordo fiscale Italia-Svizzera del 23 dicembre 2020 entrato in vigore nel 2024). L\'agenzia è tenuta a consegnare ogni mese il cedolino salariale dettagliato e, a fine anno, la certificazione per la dichiarazione italiana.',
        'È legittimo chiedere all\'agenzia copia del CCL applicabile (tipicamente il CCL Personalverleih). Se l\'agenzia rifiuta o è evasiva, è un segnale di scarsa trasparenza: la firma di un contratto in Svizzera non è mai una formalità e prima di firmare vanno letti tutti gli articoli, inclusi quelli su tempo di preavviso, trattamento in caso di malattia e fine missione.',
      ],
    },
    {
      title: 'Permesso G e agenzia interinale: cosa cambia',
      paragraphs: [
        'Un frontaliere italiano che lavora tramite agenzia interinale in Ticino ha esattamente gli stessi diritti contrattuali di un residente svizzero: stesso CCL, stesso salario orario minimo per professione, stessi supplementi. La differenza è fiscale e assicurativa.',
        'Dal lato fiscale, il salario è soggetto a imposta alla fonte svizzera; per i nuovi frontalieri (assunti dal 2024 ai sensi del nuovo accordo), si paga circa l\'80% dell\'imposta in Svizzera e il residuo in Italia. Dal lato assicurativo, la LAMal (malattia) può essere opzionata in Italia (diritto di opzione frontalieri); la LAINF (infortuni) è obbligatoria sul lavoro svizzero; il 2° pilastro (LPP) scatta sopra il salario minimo annuo di legge (22.680 CHF nel 2026 per l\'anno civile base).',
        'Il calcolatore stipendio del sito permette di simulare il netto per missioni interinali di durata variabile, integrando tasse, contributi e assicurazioni. Per missioni brevi (< 3 mesi) bisogna fare attenzione agli effetti di soglia sull\'LPP e sulle indennità ferie: molte agenzie applicano lo schema "pay-as-you-go" che include le ferie nel lordo orario — l\'effetto sul netto mensile va considerato a parte.',
      ],
    },
    {
      title: 'Errori comuni da evitare',
      paragraphs: [
        'Primo errore: accettare la prima offerta senza confrontarla. In Ticino, per lo stesso profilo (es. operaio specializzato), lo spread fra la migliore e la peggiore agenzia può arrivare al 10-15% del salario orario. Dedicare mezza giornata al confronto vale spesso migliaia di franchi l\'anno.',
        'Secondo errore: firmare contratti con agenzie non autorizzate, attratti da promesse salariali fuori mercato. Oltre al rischio legale (contratto nullo, salari non versati), c\'è il rischio pratico di non avere copertura LAINF in caso di infortunio — una tegola enorme per un frontaliere senza assicurazione italiana equivalente.',
        'Terzo errore: accettare "sotto banco" parti di salario in nero per "ottimizzare" le tasse. È illegale sia per il datore sia per il lavoratore; le autorità cantonali fanno controlli incrociati sui cedolini e l\'imposta alla fonte viene ricalcolata d\'ufficio. Il costo di una rettifica è molto superiore al presunto risparmio.',
      ],
    },
  ],
  faqs: [
    {
      question:
        'Dove trovo l\'elenco ufficiale delle agenzie del lavoro autorizzate a Lugano?',
      answer:
        'Nel registro SECO AVG pubblico (vzavg1.admin.ch/vzavg-verzeichnis-frontend), filtrando per cantone TI e Comune Lugano. È l\'unica fonte autoritativa: include sia collocamento sia prestito di personale, con il tipo di autorizzazione e lo stato (attiva / sospesa / revocata).',
    },
    {
      question:
        'Posso iscrivermi a più agenzie contemporaneamente come frontaliere?',
      answer:
        'Sì. Non c\'è esclusiva e molti frontalieri si registrano in 3-5 agenzie per massimizzare le opportunità. Attenzione però a evitare candidature doppie presso la stessa azienda utilizzatrice: alcune agenzie prevedono clausole di "lock-in" di 3-6 mesi su un cliente finale.',
    },
    {
      question: 'L\'agenzia può trattenermi parte dello stipendio come commissione?',
      answer:
        'No. La Legge federale sul collocamento vieta espressamente al lavoratore di pagare commissioni all\'agenzia; i costi del servizio sono a carico dell\'azienda utilizzatrice. Se un\'agenzia ti chiede di pagare per ottenere un posto, è illegale.',
    },
  ],
};

const IT_CONCORSI: CareerLandingCopy = {
  title: 'Concorsi pubblici aperti in Ticino 2026',
  description:
    'Concorsi pubblici aperti in Canton Ticino nel 2026: infermieri OSC, amministrativi, medici assistenti, aiuto cucina, stage cantonali. Elenco aggiornato dalla fonte ufficiale concorsi.ti.ch, requisiti per frontalieri e procedura di candidatura.',
  h1: 'Concorsi pubblici aperti in Ticino: guida 2026',
  lede: 'L\'Amministrazione cantonale ticinese pubblica ogni anno centinaia di concorsi per profili amministrativi, sanitari, scolastici e tecnici. Questa guida raccoglie i concorsi attualmente aperti al 2026, con scadenze, enti coinvolti e link alla scheda ufficiale. Valida anche per frontalieri italiani — molte posizioni sono aperte a candidati con permesso G.',
  updatedLabel: 'Aggiornato',
  breadcrumbHome: 'Home',
  breadcrumbJobs: 'Lavoro Ticino',
  ctaJobs: 'Vedi tutte le offerte lavoro in Ticino',
  ctaSimulator: 'Calcola il tuo stipendio',
  relatedLabel: 'Risorse collegate',
  faqTitle: 'Domande frequenti',
  sourcesLabel: 'Fonti',
  sources: [
    {
      label:
        'Amministrazione cantonale — Concorsi generali (www4.ti.ch/index.php?id=147427)',
      href: 'https://www4.ti.ch/index.php?id=147427',
    },
    {
      label: 'Portale concorsi.ti.ch — schede di dettaglio dei bandi',
      href: "https://www.concorsi.ti.ch/offerte-d'impieghi.html",
    },
    {
      label:
        'Sezione risorse umane — come candidarsi (www4.ti.ch/index.php?id=131450)',
      href: 'https://www4.ti.ch/index.php?id=131450',
    },
  ],
  sections: [
    {
      title: 'Come funziona un concorso pubblico cantonale',
      paragraphs: [
        'Il Cantone Ticino bandisce concorsi pubblici per ogni posizione vacante nell\'Amministrazione cantonale (dipartimenti, sezioni, uffici), nell\'Organizzazione sociopsichiatrica cantonale (OSC), nell\'Ente Ospedaliero Cantonale (EOC) e nei servizi collegati. La procedura è standard: il bando viene pubblicato sul portale concorsi.ti.ch con un numero di riferimento (es. "23/26"), una scadenza di candidatura (tipicamente 3-6 settimane dopo la pubblicazione), requisiti, grado di occupazione e classe salariale.',
        'La candidatura si inoltra online tramite il portale della Sezione risorse umane (www4.ti.ch/index.php?id=131450). I documenti richiesti sono lettera motivazionale, CV dettagliato, diplomi e certificati di lavoro. Per i profili sanitari serve anche il riconoscimento MEBEKO/SRK del titolo italiano, quando applicabile. Seguono colloquio, eventuali test attitudinali e graduatoria finale.',
      ],
    },
    {
      title: 'I concorsi attualmente aperti (snapshot ufficiale)',
      paragraphs: [
        'Al momento dell\'ultimo aggiornamento da concorsi.ti.ch, sono aperti in particolare: il concorso 23/26 per Medico capo clinica in psichiatria all\'OSC di Mendrisio (scadenza 31.12.2026), il concorso 25/26 per Infermieri/e con specialità in salute mentale OSC Mendrisio (scadenza 31.10.2026), il concorso 26/26 per Personale ai servizi generali OSC Mendrisio (scadenza 31.10.2026), il concorso 30/26 per Medici assistenti OSC Mendrisio (scadenza 31.12.2026).',
        'Sempre attivi il concorso 02/26 per Aiuto cucina all\'Ufficio della refezione e dei trasporti scolastici (DECS, Bellinzona, scadenza 31.12.2026) e il bando 04/26 per candidature spontanee a stage universitari e post-universitari nell\'Amministrazione cantonale (scadenza 31.12.2026). Il concorso 180/25 per Collaboratori amministrativi, addetti accoglienza, tassatori e simili chiude il 30.10.2026.',
        'L\'elenco è uno snapshot: la pagina ufficiale www4.ti.ch/index.php?id=147427 è l\'unica fonte sempre aggiornata. Consigliamo di impostare un\'allerta mensile sul sito per non perdere nuovi bandi.',
      ],
    },
    {
      title: 'Requisiti e idoneità per i frontalieri italiani',
      paragraphs: [
        'La maggior parte dei concorsi cantonali è aperta anche a candidati stranieri in possesso dei requisiti formali (diploma equipollente, permesso di lavoro, padronanza della lingua italiana). Per alcune posizioni specifiche (es. procuratori, magistrati, alcune funzioni di polizia) è richiesta la cittadinanza svizzera; la maggior parte dei ruoli amministrativi, sanitari e tecnici è invece accessibile.',
        'Per un frontaliere italiano con permesso G la procedura è identica a quella di un residente: candidatura online, partecipazione al concorso, eventuale assunzione. Se si viene selezionati, l\'Ufficio Popolazione e Ufficio Migrazione del Cantone gestiscono l\'iter per il permesso di lavoro in parallelo. I requisiti di residenza (es. "residenza nel comprensorio ticinese") sono rari nei concorsi cantonali e di norma non si applicano ai frontalieri.',
        'Attenzione ai requisiti linguistici: i concorsi cantonali ticinesi sono in italiano e richiedono padronanza scritta e orale. Alcuni bandi specifici (es. funzioni di confine, dogana, unità sanitarie bilingui) possono chiedere anche il tedesco o il francese a livello B2-C1.',
      ],
    },
    {
      title: 'Stipendi nell\'Amministrazione cantonale ticinese',
      paragraphs: [
        'L\'Amministrazione cantonale applica la Legge sullo stipendio degli impiegati dello Stato: 25 classi salariali, ognuna con 20 scatti biennali. Per un amministrativo in classe 5 il range lordo annuo (13 mensilità, 100%) parte da circa 65.000 CHF e arriva oltre i 95.000 CHF a fine carriera. Per profili sanitari specializzati (es. medici OSC, infermieri diplomati SUP) si applicano classi superiori (dalla 9 alla 15), con range 85.000-140.000 CHF lordi.',
        'Il calcolatore del sito permette di simulare il netto partendo dalla classe e scatto indicati nel bando. Per frontalieri, il netto effettivo dipende anche dal chilometraggio dal confine (rilevante per il calcolo IRPEF residuo in Italia ai sensi del nuovo accordo 2020).',
      ],
    },
    {
      title: 'Come prepararsi al concorso: tempi e strategia',
      paragraphs: [
        'La procedura concorsuale richiede pazienza: fra pubblicazione, scadenza, valutazione dei dossier, colloquio e graduatoria passano in media 3-5 mesi. Per un frontaliere con lavoro in corso, l\'impatto operativo è limitato (solo i colloqui richiedono una giornata in Ticino), ma la preparazione del dossier è impegnativa.',
        'Suggerimenti pratici: (1) leggere attentamente il bando — i requisiti obbligatori e preferenziali sono sempre distinti; (2) costruire un CV cronologico con dettaglio delle mansioni, non solo dei ruoli; (3) allegare i diplomi con traduzione e, dove richiesto, il riconoscimento MEBEKO/SRK; (4) inviare la candidatura con 2-3 giorni di margine rispetto alla scadenza per evitare problemi tecnici.',
      ],
    },
  ],
  faqs: [
    {
      question:
        'I concorsi pubblici ticinesi sono aperti ai frontalieri italiani?',
      answer:
        'Sì, nella grande maggioranza. Solo alcune funzioni specifiche (magistratura, alcune forze di polizia) richiedono la cittadinanza svizzera. Per tutto il resto (amministrativo, sanitario, tecnico, scolastico) il candidato con permesso G è ammesso a parità di condizioni dei residenti.',
    },
    {
      question: 'Dove trovo l\'elenco aggiornato dei concorsi aperti?',
      answer:
        'La fonte ufficiale è www4.ti.ch/index.php?id=147427 per i concorsi generali dell\'Amministrazione cantonale, mentre concorsi.ti.ch contiene le schede di dettaglio. Consigliamo di controllare entrambi i siti ogni 2-4 settimane.',
    },
    {
      question: 'Quanto dura un processo concorsuale dalla candidatura all\'assunzione?',
      answer:
        'Mediamente 3-5 mesi. Alcuni bandi accelerati (es. infermieri OSC con carenza urgente) possono chiudersi in 6-8 settimane; concorsi dirigenziali richiedono invece 4-6 mesi fra valutazione, colloqui multipli e decisione del Consiglio di Stato.',
    },
  ],
};

const IT_STAGE: CareerLandingCopy = {
  title: 'Stage a Lugano 2026: guida per frontalieri',
  description:
    'Come trovare uno stage a Lugano: aziende svizzere aperte a tirocinanti italiani, indennità di stage (stipendio) tipiche in Canton Ticino, aspetti contrattuali e fiscali per frontalieri con permesso G, procedura ufficiale cantonale.',
  h1: 'Stage a Lugano: guida 2026 per frontalieri e studenti italiani',
  lede: 'Uno stage in Svizzera è spesso il primo passo verso un contratto a tempo indeterminato. A Lugano, banche, studi legali, società di revisione, aziende tech e amministrazione cantonale offrono stage strutturati con indennità significative. Questa guida spiega come candidarsi, quanto si guadagna, quali sono gli obblighi fiscali per un frontaliere e dove trovare le offerte aperte.',
  updatedLabel: 'Aggiornato',
  breadcrumbHome: 'Home',
  breadcrumbJobs: 'Lavoro Ticino',
  ctaJobs: 'Vedi offerte di stage a Lugano',
  ctaSimulator: 'Simula il netto dallo stage',
  relatedLabel: 'Risorse collegate',
  faqTitle: 'Domande frequenti',
  sourcesLabel: 'Fonti',
  sources: [
    {
      label:
        'Amministrazione cantonale — stage universitari e post-universitari (bando 04/26)',
      href: "https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4063",
    },
    {
      label:
        'SECO — Personalfachmann / stagisti e tirocinanti (regolamento)',
      href: 'https://www.seco.admin.ch/seco/it/home/Arbeit.html',
    },
    {
      label: 'UST — Statistica degli stipendi e indennità di stage',
      href: 'https://www.bfs.admin.ch/bfs/it/home/statistiche/lavoro-reddito.html',
    },
  ],
  sections: [
    {
      title: 'Quanto si guadagna in stage a Lugano',
      paragraphs: [
        'L\'indennità media per uno stage a Lugano varia molto per settore. In banca e in società di revisione (Big Four, studi fiduciari) un praticante post-laurea percepisce tipicamente 3.500-5.000 CHF lordi al mese per 100%; in ambito IT e consulenza IT i range sono simili. Negli studi legali e notarili il range è più basso (2.500-4.000 CHF) ma il percorso post-praticato verso l\'abilitazione è strutturato.',
        'Nell\'Amministrazione cantonale lo stage post-universitario è remunerato secondo la griglia cantonale (bando 04/26) — l\'importo specifico viene comunicato al momento della chiamata. Nel settore industriale e meccanico i tirocini pre-universitari rientrano invece nel sistema svizzero di formazione professionale (apprendistato), con salari regolati dai CCL di settore.',
        'Attenzione: uno stage non coperto da indennità (gratuito) è legalmente permesso in Svizzera solo se rientra in un curriculum formativo obbligatorio (università, scuola superiore). Fuori da quel perimetro, lo stage va retribuito come lavoro dipendente — se non lo è, configura lavoro nero e va segnalato.',
      ],
    },
    {
      title: 'Permesso G e stage: i passaggi obbligatori',
      paragraphs: [
        'Un frontaliere italiano che fa stage a Lugano con permesso G (residenza in Italia, rientro almeno settimanale) segue la stessa procedura di un dipendente. Il datore di lavoro annuncia il rapporto all\'Ufficio Migrazione; il permesso G ha validità 5 anni rinnovabile. L\'imposta alla fonte si applica sullo stipendio di stage secondo le tabelle cantonali.',
        'Durante lo stage sono dovuti contributi AVS/AI/IPG (5,3%), AD (1,1%), LAINF non-professionale (trattenuta del datore). Il 2° pilastro (LPP) scatta solo sopra la soglia minima annuale (22.680 CHF nel 2026): molti stage di durata inferiore a 6 mesi o con indennità modeste restano sotto soglia e non accedono alla LPP, ma è il datore a definire la policy.',
      ],
    },
    {
      title: 'Dove trovare stage aperti a Lugano',
      paragraphs: [
        'Oltre al bando cantonale 04/26 (candidature spontanee, scadenza 31.12.2026), le fonti principali sono i portali aziendali delle banche attive in Ticino (UBS, Julius Baer, BSI), delle società fiduciarie (Deloitte, PwC, EY, KPMG), delle aziende tech (Centro Svizzero di Calcolo Scientifico, Dadi & Associates, software house della Regione Insubria). Anche SUPSI e USI pubblicano regolarmente offerte di stage integrate nei loro corsi.',
        'Per i frontalieri italiani con esperienza industriale, il network locale conta: molte PMI manifatturiere ticinesi (componentistica, meccanica di precisione, orologeria) offrono stage semi-strutturati non sempre pubblicati online. Candidature spontanee + partecipazione a career day universitari (USI, SUPSI, Università dell\'Insubria) sono strade complementari.',
      ],
    },
    {
      title: 'Dopo lo stage: chances di assunzione',
      paragraphs: [
        'Statisticamente, in Ticino, oltre la metà degli stage in ambito bancario e di revisione sfocia in un\'offerta di assunzione. Per le PMI industriali la percentuale è più bassa (30-40%) ma in entrambi i casi la qualità della prestazione durante lo stage è il fattore determinante.',
        'Per un frontaliere italiano, il passaggio stage → contratto indeterminato richiede attenzione al cambio di statuto fiscale: la tassazione passa dall\'essere integralmente alla fonte (per stage brevi) alla disciplina completa dei nuovi frontalieri (20% residuale in Italia). Il simulatore del sito aiuta a stimare il netto prima di firmare.',
      ],
    },
    {
      title: 'Come preparare la candidatura a uno stage a Lugano',
      paragraphs: [
        'La selezione per i programmi di stage strutturati delle banche ticinesi e delle Big Four avviene in media con 3-4 mesi di anticipo rispetto alla data di inizio: per uno stage estivo (giugno-agosto) le finestre di candidatura si aprono a gennaio-febbraio. Per la Kantonsverwaltung il bando 04/26 è sempre aperto durante tutto l\'anno con valutazione continuativa.',
        'Documenti richiesti tipici: lettera motivazionale breve (massimo una pagina, redatta in italiano per studi / PA e in inglese per banche internazionali), CV con sezione "Formazione" in evidenza, trascrizioni dei voti universitari, un certificato di lingua (CAE, BEC, TOEIC o equivalente) se disponibile, lettere di referenza di professori universitari. Per profili quantitativi (finance, tech) è buona norma allegare un portfolio GitHub o un paper di tesi.',
        'Preparazione al colloquio: aspettarsi case study quantitativi in banca e consulenza, technical interview in tech, colloqui motivazionali più generali in PA e studi legali. La domanda chiave per ogni frontaliere italiano è "perché proprio il Ticino" — avere una risposta concreta (radici familiari, carriera svizzera di lungo termine, progetto specifico) fa la differenza.',
      ],
    },
  ],
  faqs: [
    {
      question: 'Quanto dura uno stage tipico a Lugano?',
      answer:
        '3-6 mesi nei settori bancario, fiduciario e IT. Stage nell\'Amministrazione cantonale e nelle università possono arrivare a 12 mesi. Per stage accademici (tesi, ricerca) la durata è quella del progetto.',
    },
    {
      question: 'Posso fare stage in Svizzera come studente italiano non laureato?',
      answer:
        'Sì, se lo stage rientra nel tuo piano di studi italiano (tirocinio curricolare) o se l\'azienda ticinese ti assume con contratto di stage remunerato. In entrambi i casi serve il permesso G.',
    },
    {
      question: 'Lo stage a Lugano è tassato in Italia o in Svizzera?',
      answer:
        'L\'indennità di stage segue le regole dei frontalieri: imposta alla fonte in Svizzera e, per i nuovi frontalieri, una quota residuale in Italia. Per stage inferiori a 3 mesi alcune regole specifiche possono applicarsi — verificare con il commercialista.',
    },
  ],
};

const IT_CONTRATTI: CareerLandingCopy = {
  title: 'Contratti lavoro frontalieri 2026: guida CCL',
  description:
    'Guida completa ai contratti di lavoro per frontalieri italiani in Ticino: CCL applicabili per settore, imposta alla fonte e nuovo accordo fiscale Italia-Svizzera, diritti su ferie, malattia, tredicesima e LPP, clausole da controllare prima di firmare.',
  h1: 'Contratti di lavoro per frontalieri: guida 2026 al CCL e all\'accordo fiscale',
  lede: 'Firmare un contratto di lavoro svizzero come frontaliere italiano richiede di conoscere il CCL di riferimento, le regole fiscali (nuovo accordo 2020 in vigore dal 2024), i diritti su ferie, malattia, tredicesima e LPP. Questa guida riepiloga che cosa è obbligatorio per legge, che cosa è CCL e che cosa è negoziabile individualmente.',
  updatedLabel: 'Aggiornato',
  breadcrumbHome: 'Home',
  breadcrumbJobs: 'Lavoro Ticino',
  ctaJobs: 'Offerte di lavoro per frontalieri',
  ctaSimulator: 'Calcola il netto con il nuovo accordo',
  relatedLabel: 'Risorse collegate',
  faqTitle: 'Domande frequenti',
  sourcesLabel: 'Fonti',
  sources: [
    {
      label:
        'Accordo Italia-Svizzera sui frontalieri del 23 dicembre 2020 (AFC)',
      href: 'https://www.estv.admin.ch/estv/it/home.html',
    },
    {
      label:
        'Codice delle obbligazioni (CO) — Titolo decimo: Contratto di lavoro',
      href: 'https://www.fedlex.admin.ch/eli/cc/27/317_321_377/it',
    },
    {
      label:
        'SECO — Condizioni di lavoro e CCL',
      href: 'https://www.seco.admin.ch/seco/it/home/Arbeit.html',
    },
    {
      label:
        'Ufficio Popolazione Ticino — Permesso G per frontalieri',
      href: 'https://www4.ti.ch/di/sp/',
    },
  ],
  sections: [
    {
      title: 'Il CCL: cosa significa e perché è così importante',
      paragraphs: [
        'In Svizzera il Contratto Collettivo di Lavoro (CCL) è un accordo fra associazioni di categoria e sindacati che fissa le condizioni minime per un intero settore (edilizia, alberghiero, pulizie, metalmeccanico, sanità, prestito di personale). Una volta dichiarato di "obbligatorietà generale" (AOG), il CCL si applica a tutti i lavoratori del settore, anche a quelli non iscritti al sindacato — e include pienamente i frontalieri.',
        'Per un frontaliere italiano, conoscere il CCL del proprio settore è cruciale: il CCL definisce il salario minimo orario/mensile, le ore settimanali, i supplementi per straordinari, la durata del preavviso, le ferie minime, le indennità per lavoro notturno e festivo. Il contratto individuale può essere più favorevole del CCL, ma mai meno favorevole. In caso di dubbio, il testo del CCL prevale.',
        'I principali CCL applicabili ai frontalieri in Ticino sono: CCL Personalverleih (prestito di personale), CCL Edilizia Principale Ticino, CCL Alberghiero-Ristorazione Svizzera, CCL MEM (metalmeccanico), CCL EOC (ospedaliero pubblico), CCL Cliniche Private Ticinesi, CCL Case Anziani Ticino. Per settori senza CCL obbligatorio si applica direttamente il Codice delle obbligazioni (CO).',
      ],
    },
    {
      title: 'Il nuovo accordo fiscale Italia-Svizzera dal 2024',
      paragraphs: [
        'L\'accordo fiscale del 23 dicembre 2020, entrato in vigore il 17 luglio 2023 e operativo dal 1° gennaio 2024, distingue fra "vecchi frontalieri" (già impiegati al 17 luglio 2023 o residenti nei 20 km dal confine al momento della firma) e "nuovi frontalieri". I vecchi mantengono la tassazione esclusiva in Svizzera (100% imposta alla fonte, nessuna doppia imposizione); i nuovi pagano l\'80% dell\'imposta in Svizzera (imposta alla fonte piena come prima) e poi fanno la dichiarazione italiana dove si calcola l\'IRPEF residua con credito d\'imposta sul 100% del pagato in Svizzera.',
        'Il telaio di calcolo è complesso: per un nuovo frontaliere con stipendio lordo 80.000 CHF, l\'imposta alla fonte svizzera può essere circa 8.000 CHF (variabile per cantone e situazione familiare); l\'IRPEF italiana sul reddito lordo è circa 22.000 EUR; con credito d\'imposta svizzero, il frontaliere versa residuo circa 14.000 EUR in Italia. La pressione fiscale totale può variare del 5-12% fra vecchio e nuovo regime.',
        'Il calcolatore del sito tiene conto di questo meccanismo per i nuovi frontalieri, integrando cambio CHF/EUR, tabelle cantonali, contributi sociali, spese forfettarie e credito d\'imposta. È essenziale simulare prima di firmare un nuovo contratto: la differenza fra nuovo e vecchio regime può incidere decisamente sulla convenienza dell\'offerta.',
      ],
    },
    {
      title: 'Clausole contrattuali da controllare prima di firmare',
      paragraphs: [
        'Prima di firmare un contratto svizzero, controlla: (1) salario lordo annuo o orario + numero di mensilità (12 o 13); (2) grado di occupazione (100%, 80%, ecc.) e se è flessibile; (3) tempo di prova (massimo 3 mesi per legge, tipicamente 1-3) e preavviso in prova (7 giorni); (4) preavviso ordinario (minimo legale 1 mese nel primo anno, 2 nel secondo, 3 dal settimo anno in poi; molti CCL fissano 3 mesi già dal primo anno); (5) ferie minime (4 settimane per legge, 5 per molti CCL, 6 dopo i 50 anni in diversi settori).',
        '(6) Tredicesima: il CO non la impone, ma la maggior parte dei CCL svizzeri sì; verifica che sia prevista. (7) Ore settimanali: massimo legale 45 o 50 ore (dipende dal settore); molti CCL fissano 40-42. (8) Supplementi per straordinari, notturni, festivi: variano per CCL. (9) Malattia: il CO prevede un minimo legale scalare, ma quasi tutti i CCL obbligano il datore a stipulare un\'assicurazione collettiva perdita di guadagno (PGM) al 80-90% del salario per 720-730 giorni.',
        '(10) 2° pilastro (LPP): obbligatorio sopra 22.680 CHF lordi annui; controllare che il datore trattenga e versi la quota del dipendente. (11) Non-concorrenza post-contrattuale: se presente, deve essere geograficamente e temporalmente circoscritta; clausole troppo larghe sono nulle. (12) Clausole di rimborso formazione (es. restituire corsi se si lascia entro 2 anni): leggere con attenzione, possono costare decine di migliaia di franchi.',
      ],
    },
    {
      title: 'Diritti specifici dei frontalieri',
      paragraphs: [
        'Oltre ai diritti del CCL, il frontaliere italiano ha alcune tutele specifiche: diritto di opzione LAMal (l\'obbligo di assicurazione sanitaria svizzera può essere sostituito dall\'iscrizione al SSN italiano, usando il modulo S1); tassazione della retribuzione di fine rapporto con regole specifiche (trattamento del 2° pilastro al momento del ritiro); accesso al Fondo Nazionale Assicurazione Disoccupazione svizzero (DI) anche per i frontalieri che lavorano in Svizzera.',
        'In caso di licenziamento, il frontaliere italiano richiede l\'indennità di disoccupazione in Italia (NASpI) secondo il principio del paese di residenza, ma il calcolo si basa sugli ultimi salari svizzeri. Il trasferimento dei contributi richiede il modulo U1/U2. È una procedura spesso complessa: in caso di dubbio, contattare i sindacati OCST o UNIA (hanno sedi ticinesi ed esperienza specifica sul segmento frontalieri).',
      ],
    },
    {
      title: 'Errori frequenti nella negoziazione',
      paragraphs: [
        'Primo errore: valutare solo il lordo senza simulare il netto. Per un nuovo frontaliere lo spread lordo-netto è significativamente più ampio che per un vecchio frontaliere. Stesso lordo, netto sensibilmente diverso.',
        'Secondo errore: accettare clausole di non-concorrenza eccessive. In Svizzera la giurisprudenza tutela il lavoratore quando la clausola è sproporzionata (es. divieto oltre i 12 mesi, oltre il settore, oltre il raggio di 100 km dal posto); firmare però senza negoziare lascia un\'ipoteca.',
        'Terzo errore: ignorare la componente 2° pilastro. Per un frontaliere con 15-20 anni di carriera svizzera, il capitale LPP al momento del ritiro può superare i 200.000 CHF; trascurarlo nella valutazione dell\'offerta significa sottostimare il compenso totale del 10-15%.',
      ],
    },
  ],
  faqs: [
    {
      question:
        'Sono un nuovo frontaliere: posso scegliere di essere tassato solo in Svizzera?',
      answer:
        'No. Il regime dei "vecchi frontalieri" (tassazione esclusiva in Svizzera) è chiuso ai neo-assunti dal 17 luglio 2023 — salvo che tu abbia già lavorato da frontaliere prima di quella data senza soluzione di continuità. Per i nuovi si applica il 20% residuale in Italia con credito d\'imposta.',
    },
    {
      question:
        'Il mio contratto svizzero non menziona il CCL: come faccio a sapere se ne ho uno?',
      answer:
        'I CCL di obbligatorietà generale si applicano d\'ufficio anche se il contratto non li cita. Verifica sulla pagina SECO "CCL dichiarati di obbligatorietà generale" per cantone e settore. In caso di dubbio, contatta OCST o UNIA — la consulenza base è gratuita per iscritti.',
    },
    {
      question:
        'Se mi licenziano ho diritto alla NASpI italiana anche se lavoravo in Svizzera?',
      answer:
        'Sì. Come frontaliere residente in Italia con lavoro in Svizzera, in caso di disoccupazione la prestazione è erogata dall\'INPS sulla base degli ultimi salari svizzeri convertiti. Serve il modulo U1 dell\'autorità cantonale per certificare i periodi contributivi.',
    },
  ],
};

const IT_COPY: Record<CareerLandingId, CareerLandingCopy> = {
  'agenzie-lavoro-lugano': IT_AGENZIE,
  'concorsi-pubblici-lugano': IT_CONCORSI,
  'stage-lugano': IT_STAGE,
  'contratti-lavoro-frontalieri': IT_CONTRATTI,
};

// ─────────────────────────────────────────────────────────────────
// EN / DE / FR — condensed ≥400-word variants
// Each covers the same IT structure: context, who is concerned, key data,
// sources cited. No placeholder / "coming soon" strings.
// ─────────────────────────────────────────────────────────────────

function condenseFor(
  locale: 'en' | 'de' | 'fr',
  id: CareerLandingId,
): CareerLandingCopy {
  const base = IT_COPY[id];
  const L = LOCALE_STRINGS[locale];

  // Title / description are fully localised per-landing below.
  const meta = META_BY_LOCALE_AND_ID[locale][id];

  // Build 4 condensed sections per page, each with 2 paragraphs, which
  // clears 400 words comfortably when combined with the lede (~50w).
  const sections = CONDENSED_SECTIONS[locale][id];
  const faqs = CONDENSED_FAQS[locale][id];

  return {
    title: meta.title,
    description: meta.description,
    h1: meta.h1,
    lede: meta.lede,
    updatedLabel: L.updatedLabel,
    breadcrumbHome: L.breadcrumbHome,
    breadcrumbJobs: L.breadcrumbJobs,
    ctaJobs: L.ctaJobs,
    ctaSimulator: L.ctaSimulator,
    relatedLabel: L.relatedLabel,
    faqTitle: L.faqTitle,
    sourcesLabel: L.sourcesLabel,
    sources: base.sources, // citations are source URLs — keep the same links
    sections,
    faqs,
  };
}

const LOCALE_STRINGS = {
  en: {
    updatedLabel: 'Updated',
    breadcrumbHome: 'Home',
    breadcrumbJobs: 'Ticino jobs',
    ctaJobs: 'See all Ticino job openings',
    ctaSimulator: 'Calculate your net salary',
    relatedLabel: 'Related resources',
    faqTitle: 'Frequently asked questions',
    sourcesLabel: 'Sources',
  },
  de: {
    updatedLabel: 'Aktualisiert',
    breadcrumbHome: 'Startseite',
    breadcrumbJobs: 'Tessin-Jobs',
    ctaJobs: 'Alle Tessin-Stellenangebote',
    ctaSimulator: 'Nettolohn berechnen',
    relatedLabel: 'Verwandte Ressourcen',
    faqTitle: 'Häufige Fragen',
    sourcesLabel: 'Quellen',
  },
  fr: {
    updatedLabel: 'Mis à jour',
    breadcrumbHome: 'Accueil',
    breadcrumbJobs: 'Emplois Tessin',
    ctaJobs: 'Voir toutes les offres au Tessin',
    ctaSimulator: 'Calculer votre salaire net',
    relatedLabel: 'Ressources liées',
    faqTitle: 'Questions fréquentes',
    sourcesLabel: 'Sources',
  },
} as const;

const META_BY_LOCALE_AND_ID: Record<
  'en' | 'de' | 'fr',
  Record<
    CareerLandingId,
    { title: string; description: string; h1: string; lede: string }
  >
> = {
  en: {
    'agenzie-lavoro-lugano': {
      title: 'Staffing agencies in Lugano: 2026 SECO guide',
      description:
        'Guide to staffing and placement agencies operating in Lugano: how to verify SECO authorisation, what to check in a temporary-work contract, rights for Italian cross-border workers with permit G, and the official SECO registry.',
      h1: 'Staffing agencies in Lugano: a 2026 cross-border worker guide',
      lede: 'Dozens of staffing and placement agencies operate in Lugano, all supervised by SECO. This guide explains how to recognise an authorised agency, what a temporary-work contract must state for an Italian cross-border worker on permit G, which are the main brands with a Lugano branch, and where to find the official, always-up-to-date SECO list.',
    },
    'concorsi-pubblici-lugano': {
      title: 'Public-sector jobs in Ticino 2026: guide',
      description:
        'Open public-sector positions in Canton Ticino 2026: nurses, administrative staff, assistant doctors, kitchen helpers, university interns. Official source: concorsi.ti.ch. Requirements, application procedure and fit for Italian cross-border workers.',
      h1: 'Open public-sector jobs in Ticino: 2026 guide',
      lede: 'The Ticino cantonal administration publishes hundreds of competitions per year for administrative, healthcare, school and technical roles. This guide lists the currently open ones, with deadlines, hiring bodies and application links. Most roles are open to Italian cross-border workers with permit G.',
    },
    'stage-lugano': {
      title: 'Internships in Lugano: 2026 guide',
      description:
        'How to find an internship in Lugano: Swiss employers open to Italian trainees, typical stipends in Canton Ticino, contract and tax aspects for cross-border workers with permit G, and the official cantonal procedure.',
      h1: 'Internships in Lugano: a 2026 guide for Italian students',
      lede: 'A Swiss internship often is the first step to a permanent contract. In Lugano banks, law firms, audit firms, tech companies and the cantonal administration offer structured internships with meaningful stipends. This guide explains how to apply, how much you earn, the tax aspects for cross-border workers and where to find open offers.',
    },
    'contratti-lavoro-frontalieri': {
      title: 'Cross-border contracts 2026: CCL & tax guide',
      description:
        'Complete guide to cross-border employment contracts in Ticino: collective agreements per sector, source tax and the new Italy-Switzerland 2020 treaty, rights on vacation, sick leave, 13th salary and LPP, contract clauses to check before signing.',
      h1: 'Cross-border employment contracts: 2026 guide to collective agreements and the tax treaty',
      lede: 'Signing a Swiss employment contract as an Italian cross-border worker means understanding the relevant collective agreement (CCL), the tax rules under the new 2020 treaty in force since 2024, and your rights on vacation, sick leave, 13th salary and pension. This guide summarises what is mandatory by law, what is set by CCL and what is individually negotiable.',
    },
  },
  de: {
    'agenzie-lavoro-lugano': {
      title: 'Personalvermittlung Lugano: SECO 2026',
      description:
        'Leitfaden zu Personalverleih- und Vermittlungsfirmen in Lugano 2026: SECO-Autorisierung prüfen, Temporärvertrag-Checkliste, Rechte italienischer Grenzgänger mit G-Bewilligung, offizielles SECO-Verzeichnis.',
      h1: 'Personalvermittler in Lugano: Grenzgänger-Leitfaden 2026',
      lede: 'Dutzende Personalverleih- und Vermittlungsfirmen sind in Lugano tätig, alle SECO-beaufsichtigt. Dieser Leitfaden erklärt, wie man eine autorisierte Firma erkennt, was ein Temporärvertrag für italienische Grenzgänger enthalten muss, welche grossen Marken eine Lugano-Filiale haben und wo die offizielle, immer aktuelle SECO-Liste zu finden ist.',
    },
    'concorsi-pubblici-lugano': {
      title: 'Öffentliche Stellen Tessin 2026: Leitfaden',
      description:
        'Offene öffentliche Stellen im Kanton Tessin 2026: Pflege, Verwaltung, Assistenzärzte, Küchenhilfe, Hochschulpraktika. Offizielle Quelle: concorsi.ti.ch. Anforderungen, Bewerbungsablauf, Eignung italienischer Grenzgänger.',
      h1: 'Offene öffentliche Stellen im Tessin: Leitfaden 2026',
      lede: 'Die Tessiner Kantonsverwaltung schreibt jedes Jahr Hunderte von Concorsi aus: Verwaltung, Pflege, Schule, Technik. Dieser Leitfaden listet die aktuell offenen Stellen mit Fristen, Vergabestellen und Bewerbungslinks. Die meisten Rollen sind auch für italienische Grenzgänger mit G-Bewilligung zugänglich.',
    },
    'stage-lugano': {
      title: 'Praktikum in Lugano 2026: Leitfaden',
      description:
        'Wie man ein Praktikum in Lugano findet: Schweizer Unternehmen für italienische Praktikanten, übliche Vergütungen in Tessin, Vertrag- und Steueraspekte für Grenzgänger mit G-Bewilligung, kantonaler Bewerbungsablauf.',
      h1: 'Praktikum in Lugano: Leitfaden 2026 für italienische Studierende',
      lede: 'Ein Praktikum in der Schweiz ist oft der erste Schritt zu einer Festanstellung. In Lugano bieten Banken, Anwaltskanzleien, Treuhand- und IT-Firmen sowie die Kantonsverwaltung strukturierte Praktika mit spürbarer Vergütung. Dieser Leitfaden zeigt, wie man sich bewirbt, wie viel man verdient, die Steueraspekte für Grenzgänger und wo offene Stellen zu finden sind.',
    },
    'contratti-lavoro-frontalieri': {
      title: 'Grenzgänger-Verträge 2026: GAV & Steuern',
      description:
        'Vollständiger Leitfaden zu Arbeitsverträgen italienischer Grenzgänger im Tessin: GAV pro Sektor, Quellensteuer und neues Italien-Schweiz-Abkommen 2020, Rechte auf Ferien, Krankheit, 13. Monatslohn und BVG, zu prüfende Klauseln.',
      h1: 'Grenzgänger-Arbeitsverträge: Leitfaden 2026 zu GAV und Steuerabkommen',
      lede: 'Einen Schweizer Arbeitsvertrag als italienischer Grenzgänger zu unterzeichnen heisst, den geltenden Gesamtarbeitsvertrag (GAV), die Besteuerung nach dem neuen Abkommen von 2020 und die Rechte auf Ferien, Krankheit, 13. Monatslohn und BVG zu kennen. Dieser Leitfaden fasst zusammen, was gesetzlich zwingend ist, was GAV-geregelt ist und was individuell verhandelbar bleibt.',
    },
  },
  fr: {
    'agenzie-lavoro-lugano': {
      title: "Agences d'intérim Lugano 2026: liste SECO",
      description:
        "Guide des agences de placement et d'intérim actives à Lugano en 2026: vérifier l'autorisation SECO, contrôler un contrat temporaire, droits des frontaliers italiens avec permis G, registre officiel SECO.",
      h1: "Agences d'intérim à Lugano: guide 2026 pour frontaliers",
      lede: "Des dizaines d'agences de placement et d'intérim opèrent à Lugano, toutes sous supervision SECO. Ce guide explique comment reconnaître une agence autorisée, ce qu'un contrat temporaire doit contenir pour un frontalier italien avec permis G, quelles sont les principales marques présentes à Lugano et où trouver la liste officielle SECO toujours à jour.",
    },
    'concorsi-pubblici-lugano': {
      title: 'Concours publics Tessin 2026: guide',
      description:
        "Postes publics ouverts au Canton Tessin 2026: infirmiers, administratifs, médecins assistants, aide-cuisine, stages universitaires. Source officielle: concorsi.ti.ch. Conditions et procédure pour frontaliers italiens.",
      h1: 'Concours publics ouverts au Tessin: guide 2026',
      lede: "L'administration cantonale tessinoise publie chaque année des centaines de concorsi: administratif, soins, école, technique. Ce guide liste les concours actuellement ouverts, avec échéances, autorités recruteuses et liens de candidature. La plupart des postes sont accessibles aux frontaliers italiens avec permis G.",
    },
    'stage-lugano': {
      title: 'Stages à Lugano 2026: guide frontaliers',
      description:
        "Comment trouver un stage à Lugano: entreprises suisses ouvertes aux stagiaires italiens, indemnités typiques au Tessin, aspects contractuels et fiscaux pour frontaliers avec permis G, procédure cantonale officielle.",
      h1: 'Stages à Lugano: guide 2026 pour étudiants italiens frontaliers',
      lede: "Un stage en Suisse est souvent le premier pas vers un contrat permanent. À Lugano, banques, études d'avocats, fiduciaires, sociétés tech et administration cantonale proposent des stages structurés avec indemnités significatives. Ce guide explique comment postuler, combien on gagne, les aspects fiscaux pour frontaliers et où trouver les offres ouvertes.",
    },
    'contratti-lavoro-frontalieri': {
      title: 'Contrats travail frontaliers 2026: guide CCT',
      description:
        "Guide complet aux contrats de travail pour frontaliers italiens au Tessin: CCT par secteur, impôt à la source et nouvel accord Italie-Suisse 2020, droits aux vacances, maladie, 13e salaire et LPP, clauses à vérifier.",
      h1: 'Contrats de travail frontaliers: guide 2026 aux CCT et à l\'accord fiscal',
      lede: "Signer un contrat de travail suisse comme frontalier italien implique de connaître la convention collective (CCT) du secteur, les règles fiscales du nouvel accord 2020 entré en vigueur en 2024, et vos droits aux vacances, maladie, 13e et LPP. Ce guide résume ce qui est obligatoire par la loi, ce qui est fixé par la CCT et ce qui reste négociable.",
    },
  },
};

// Condensed 4-section bodies per locale × id. Each section ≈60-80 words.
const CONDENSED_SECTIONS: Record<
  'en' | 'de' | 'fr',
  Record<CareerLandingId, CareerLandingSection[]>
> = {
  en: {
    'agenzie-lavoro-lugano': [
      {
        title: 'How to verify SECO authorisation',
        paragraphs: [
          'Every staffing and placement agency in Switzerland needs a cantonal licence and, to operate across cantons or with foreign candidates, a federal SECO authorisation under the 1989 Employment Service Act. The SECO maintains a public electronic register covering over 7,200 companies. If the agency contacting you is not in that register, it is a red flag — refuse to sign.',
          'As a cross-border worker you have the right to ask for the authorisation reference and a copy of the applicable collective agreement (typically the national CCL Personalverleih). A transparent agency will provide both within 24 hours.',
        ],
      },
      {
        title: 'Main agencies with a Lugano branch',
        paragraphs: [
          'International groups active in Lugano include Adecco, Manpower, Randstad, Kelly Services, Interiman and Trenkwalder. Regional agencies like Sintex and Axxon Services also hold SECO authorisation. Specialisations vary: healthcare, industrial, IT, hospitality, accounting.',
          'The list here is not exhaustive: the complete, authoritative list is the SECO AVG register, filterable by canton (TI) and city. We recommend registering with 2-3 agencies simultaneously to maximise matching opportunities, while avoiding duplicate applications to the same end employer.',
        ],
      },
      {
        title: 'What a temporary-work contract must state',
        paragraphs: [
          'A Swiss temporary-work contract must specify: gross hourly wage, overtime and night premiums, vacation allowance (minimum 8.33% for 4 weeks), 13th salary pro rata, social contributions deducted (AVS/AI/IPG 5.3%, AD 1.1%, LPP above threshold, LAINF non-professional), minimum guaranteed mission duration when applicable.',
          'For permit G cross-border workers the contract must state how the source tax and the compensation charge are applied — under the new Italy-Switzerland tax treaty of 23 December 2020, in force since 2024.',
        ],
      },
      {
        title: 'Common mistakes to avoid',
        paragraphs: [
          'Three mistakes are repeated constantly: accepting the first offer without comparing; signing with a non-authorised agency lured by above-market promises (contract is null, LAINF coverage absent); accepting off-the-books salary components for “tax optimisation” (illegal, cantonal authorities cross-check payslips).',
          'Dedicate half a day to comparing two or three agencies before accepting: the spread on identical profiles can reach 10-15% of the hourly wage.',
        ],
      },
    ],
    'concorsi-pubblici-lugano': [
      {
        title: 'How a cantonal competition works',
        paragraphs: [
          'Every vacancy in the Ticino cantonal administration, OSC (mental-health organisation), EOC (public hospital) and linked services is filled through a public competition (concorso). The bid is published on concorsi.ti.ch with a reference (e.g. "23/26"), a closing date 3-6 weeks after publication, requirements, workload percentage and salary class.',
          'Applications go online through the HR portal. Required documents: cover letter, detailed CV, diplomas, work references. Healthcare roles additionally require MEBEKO/SRK recognition of the Italian diploma when relevant.',
        ],
      },
      {
        title: 'Currently open competitions (official snapshot)',
        paragraphs: [
          'At the last sync with concorsi.ti.ch the main open bids are: chief clinical psychiatrist at OSC Mendrisio (ref 23/26, deadline 31.12.2026), mental-health nurses at OSC Mendrisio (ref 25/26, 31.10.2026), general-service staff at OSC Mendrisio (ref 26/26, 31.10.2026), assistant doctors at OSC Mendrisio (ref 30/26, 31.12.2026).',
          'Permanent-open bids: kitchen helper at the school catering office (ref 02/26, 31.12.2026), spontaneous internship applications (ref 04/26, 31.12.2026), administrative collaborators and reception staff (ref 180/25, 30.10.2026). Always verify at www4.ti.ch/index.php?id=147427 — it is the only always-current source.',
        ],
      },
      {
        title: 'Eligibility for Italian cross-border workers',
        paragraphs: [
          'Most cantonal competitions are open to foreign candidates meeting the formal criteria (equivalent diploma, valid work permit, Italian language proficiency). Only a few specific roles (magistrates, some police functions) require Swiss citizenship.',
          'For an Italian permit G holder the procedure is identical to a resident: online application, assessment, possible hiring. The Cantonal Migration Office handles the work permit in parallel. Residence-area requirements are rare and usually do not apply to cross-border workers.',
        ],
      },
      {
        title: 'Salaries in the cantonal administration',
        paragraphs: [
          'The cantonal administration applies a 25-class salary law, each class with 20 biennial increments. Administrative staff in class 5 earn between ~65,000 and ~95,000 CHF gross per year (13 months, 100%). Specialised healthcare roles (doctors, SUP nurses) sit in classes 9-15, earning 85,000-140,000 CHF.',
          'Net for cross-border workers depends on distance from the border and the new-treaty status. Our salary calculator simulates the outcome from the class + increment stated in the bid.',
        ],
      },
    ],
    'stage-lugano': [
      {
        title: 'How much you earn on a Lugano internship',
        paragraphs: [
          'Internship stipends in Lugano vary widely by sector. Post-graduate trainees in banking, Big Four audit, tax advisory and IT consulting typically earn 3,500-5,000 CHF gross per month at 100%. Law firms and notaries sit lower (2,500-4,000 CHF) but offer a structured path to the bar exam.',
          'The cantonal administration runs a spontaneous-internship programme (bid 04/26, deadline 31.12.2026) with remuneration set by the cantonal grid. Unpaid internships are legal in Switzerland only inside a mandatory curriculum — otherwise they must be paid as regular employment.',
        ],
      },
      {
        title: 'Permit G and internships: the steps',
        paragraphs: [
          'An Italian cross-border intern with permit G follows the same procedure as an employee: the employer registers the relationship with the Migration Office, the permit is issued, the source tax applies to the stipend based on the cantonal scales.',
          'Social contributions (AVS/AI/IPG 5.3%, AD 1.1%, LAINF non-professional) are withheld. The second pillar (LPP) kicks in only above the 22,680 CHF annual threshold — short internships usually stay below.',
        ],
      },
      {
        title: 'Where to find open internships',
        paragraphs: [
          "Beyond the cantonal bid 04/26, the main sources are the career portals of banks operating in Ticino (UBS, Julius Baer, BSI), audit firms (Deloitte, PwC, EY, KPMG), tech employers (Swiss National Supercomputing Centre, regional software houses) and the USI + SUPSI universities, which publish internship offers embedded in their courses.",
          'For industrial profiles, many Ticinese SMEs in precision mechanics, watchmaking and components offer semi-structured internships rarely published online — spontaneous applications and university career days are the right channels.',
        ],
      },
      {
        title: 'After the internship: hiring odds',
        paragraphs: [
          'Statistically, more than half of banking and audit internships in Ticino lead to a permanent offer. Industrial SMEs convert at 30-40%. In all cases the quality of performance during the internship is the deciding factor.',
          'For Italian cross-border workers, the internship-to-permanent transition involves a tax-status change: the calculation moves from pure source tax to the full new-treaty regime. Simulate the net before signing.',
        ],
      },
    ],
    'contratti-lavoro-frontalieri': [
      {
        title: 'Collective agreements (CCL): what they are',
        paragraphs: [
          'A Swiss Collective Labour Agreement (CCL) is signed by sector associations and unions. Once declared generally binding it applies to every employee in the sector — including Italian cross-border workers — setting minimum hourly wage, weekly hours, overtime premiums, notice period, minimum vacation and so on.',
          'Main CCLs for Ticino cross-border workers: CCL Personalverleih, CCL Main Construction Ticino, CCL Hospitality Switzerland, CCL MEM, CCL EOC, CCL Private Clinics Ticino, CCL Elderly-Care Ticino. For sectors without a CCL, the Code of Obligations applies directly.',
        ],
      },
      {
        title: 'The new Italy-Switzerland tax treaty from 2024',
        paragraphs: [
          'The treaty of 23 December 2020 entered into force on 17 July 2023 and is operational since 1 January 2024. "Old" cross-border workers (employed by that date) keep exclusive taxation in Switzerland. "New" ones pay roughly 80% of the tax in Switzerland at source and the residual in Italy through an ordinary return, with a tax credit for what was paid in Switzerland.',
          'The total pressure can differ by 5-12% between old and new regime. Always simulate the net before signing a new contract — our calculator covers both regimes, the CHF/EUR rate and the distance-from-border effect.',
        ],
      },
      {
        title: 'Contract clauses to check before signing',
        paragraphs: [
          'Key clauses: gross salary and number of monthly payments (12 or 13), workload, probation (max 3 months), notice period (legal minimum scales; many CCLs set 3 months from year one), minimum vacation (4 weeks by law, often 5 by CCL), 13th salary (not legal but CCL standard), weekly hours, overtime and night premiums, sick-leave insurance (most CCLs mandate PGM coverage at 80-90% for up to 730 days), second-pillar contributions.',
          'Also: non-compete post-contract clauses (must be narrow to be valid), training-reimbursement clauses (can cost tens of thousands of francs if you leave early).',
        ],
      },
      {
        title: 'Cross-border-specific rights',
        paragraphs: [
          'Extra protections for cross-border workers: LAMal opt-out (replace Swiss health insurance with the Italian SSN via the S1 form); access to Italian unemployment benefits (NASpI) in case of layoff, calculated on Swiss salaries using the U1 form; tax-optimal treatment of the second-pillar payout at retirement.',
          'In case of dispute, contact OCST or UNIA unions — both have Ticino offices with specific cross-border expertise and free basic consultations for members.',
        ],
      },
    ],
  },
  de: {
    'agenzie-lavoro-lugano': [
      {
        title: 'SECO-Autorisierung prüfen',
        paragraphs: [
          'Jede Personalverleih- oder Vermittlungsfirma in der Schweiz benötigt eine kantonale Bewilligung und — für kantonsübergreifende oder Auslandskandidaten-Aktivitäten — zusätzlich eine eidgenössische SECO-Bewilligung gemäss dem Arbeitsvermittlungsgesetz von 1989. Die SECO führt ein öffentliches elektronisches Verzeichnis mit über 7.200 Unternehmen. Fehlt die Agentur, die Sie kontaktiert, im Verzeichnis, ist das ein klares Warnzeichen.',
          'Als Grenzgänger dürfen Sie die Bewilligungsnummer und eine Kopie des geltenden GAV (meist GAV Personalverleih) verlangen. Eine transparente Agentur liefert beides innerhalb von 24 Stunden.',
        ],
      },
      {
        title: 'Wichtige Agenturen mit Lugano-Filiale',
        paragraphs: [
          'International aktiv in Lugano: Adecco, Manpower, Randstad, Kelly Services, Interiman und Trenkwalder. Regional: Sintex und Axxon Services besitzen ebenfalls SECO-Bewilligung. Die Spezialisierungen reichen von Pflege bis IT, Industrie und Hotellerie.',
          'Die Liste ist nicht erschöpfend. Das SECO AVG-Register bleibt die einzige vollständige Quelle, filterbar nach Kanton (TI) und Gemeinde. Wir empfehlen, sich bei 2-3 Agenturen gleichzeitig einzutragen, um die Matching-Chancen zu maximieren.',
        ],
      },
      {
        title: 'Temporärvertrag: Pflichtinhalt',
        paragraphs: [
          'Ein Schweizer Temporärvertrag muss enthalten: Bruttostundenlohn, Überstunden- und Nachtzulagen, Ferienentschädigung (mindestens 8,33% bei 4 Wochen), 13. Monatslohn pro rata, Sozialabzüge (AHV/IV/EO 5,3%, ALV 1,1%, BVG über Schwelle, UVG nicht-berufliche Unfälle) und bei garantierter Dauer die Mindestdauer des Einsatzes.',
          'Für Grenzgänger mit G-Bewilligung ist die Quellensteuer und das Ausgleichsabgabensystem anzugeben — gemäss dem neuen Italien-Schweiz-Steuerabkommen vom 23.12.2020, in Kraft seit 2024.',
        ],
      },
      {
        title: 'Häufige Fehler',
        paragraphs: [
          'Drei Fehler sind verbreitet: das erste Angebot ohne Vergleich annehmen; mit einer nicht-autorisierten Firma unterschreiben, gelockt durch überhöhte Versprechen (Vertrag nichtig, UVG-Schutz fehlt); Schwarzgeld-Anteile akzeptieren („Steueroptimierung"). All diese Szenarien gefährden Grenzgänger zusätzlich.',
          'Eine halbe Tag Vergleich zwischen 2-3 Agenturen lohnt sich: die Spanne beim gleichen Profil kann 10-15% des Stundenlohns ausmachen. Achten Sie auch auf die Feinheiten: der Bruttostundenlohn wird oft mit einem Ferienanteil und mit einem 13. Monatslohn pro rata angegeben — prüfen Sie, welche Bestandteile bereits enthalten sind, um keinen Netto-Überraschungen aufzusitzen.',
          'Zusätzlicher Tipp für Italiener mit G-Bewilligung: bewahren Sie jeden Lohnausweis und jede Vertragsänderung auf. Die Schweizer Steuerbehörde rechnet die Quellensteuer periodisch nach, und die italienische Steuererklärung der neuen Grenzgänger verlangt den vollständigen Nachweis der Schweizer Einkünfte.',
        ],
      },
    ],
    'concorsi-pubblici-lugano': [
      {
        title: 'Ablauf eines kantonalen Concorso',
        paragraphs: [
          'Jede Vakanz in der Tessiner Kantonsverwaltung, bei OSC, EOC und verbundenen Diensten wird über ein öffentliches Ausschreibungsverfahren besetzt. Die Ausschreibung erscheint auf concorsi.ti.ch mit Referenz, Bewerbungsfrist (meist 3-6 Wochen), Anforderungen, Pensum und Lohnklasse.',
          'Bewerbung läuft online via HR-Portal. Einzureichen: Motivationsschreiben, ausführlicher Lebenslauf, Diplome, Arbeitszeugnisse. Für Pflegeberufe zusätzlich MEBEKO/SRK-Anerkennung des italienischen Diploms.',
          'Nach Abschluss der Frist folgt die Dossier-Bewertung (2-4 Wochen), dann ein oder zwei Gesprächsrunden und die Entscheidung des Staatsrats für Führungspositionen. Bei Dringlichkeit (Pflege, Notfalldienste) können Concorsi beschleunigt sein.',
        ],
      },
      {
        title: 'Aktuell offene Concorsi (offizielle Momentaufnahme)',
        paragraphs: [
          'Zum letzten Sync mit concorsi.ti.ch sind die wichtigsten offenen Ausschreibungen: Chefarzt/-ärztin Psychiatrie OSC Mendrisio (Ref 23/26, Frist 31.12.2026), psychiatrische Pflegefachpersonen OSC (Ref 25/26, 31.10.2026), Servicepersonal OSC (Ref 26/26, 31.10.2026), Assistenzärzte OSC (Ref 30/26, 31.12.2026).',
          'Dauerhaft offen: Küchenhilfe DECS Bellinzona (Ref 02/26, 31.12.2026), Spontanbewerbungen für Hochschulpraktika (Ref 04/26, 31.12.2026), Verwaltungsmitarbeitende und Empfangspersonal (Ref 180/25, 30.10.2026). Immer auch direkt auf www4.ti.ch/index.php?id=147427 prüfen — dort ist der aktuelle Stand.',
        ],
      },
      {
        title: 'Eignung italienischer Grenzgänger',
        paragraphs: [
          'Die meisten kantonalen Concorsi stehen ausländischen Kandidaten offen, sofern formale Voraussetzungen erfüllt sind (äquivalentes Diplom, gültige Arbeitsbewilligung, italienische Sprachkenntnisse). Nur wenige Rollen (Magistratur, gewisse Polizeifunktionen) verlangen das Schweizer Bürgerrecht.',
          'Für einen G-Bewilligungsinhaber läuft das Verfahren identisch zu einem Schweizer Einwohner. Die kantonale Migrationsbehörde bearbeitet die Bewilligung parallel. Wohnortsanforderungen sind selten und gelten meist nicht für Grenzgänger.',
        ],
      },
      {
        title: 'Gehälter in der Kantonsverwaltung',
        paragraphs: [
          'Die Kantonsverwaltung wendet ein 25-Klassen-Lohnsystem an, mit je 20 Zweijahresstufen. Verwaltungsangestellte in Klasse 5 verdienen brutto ca. 65.000 bis 95.000 CHF pro Jahr (13 Monate, 100%). Spezialisierte Pflegeberufe (Ärzte, HF-Pflege) liegen in Klassen 9-15 mit 85.000-140.000 CHF.',
          'Der Netto-Wert für Grenzgänger hängt zusätzlich vom Wohnort ab (Distanz zur Grenze) und vom neuen Steuerregime. Unser Lohnrechner simuliert das Netto ausgehend von Klasse und Stufe des Concorso.',
          'Zu beachten ist, dass die Kantonsverwaltung für einige strategische Funktionen auch Einstiegsprämien und Weiterbildungsbudgets bietet. Diese Elemente werden nie im Bruttolohn erwähnt, sondern separat im Anstellungsschreiben nach Auswahl — wer den Vergleich mit privaten Angeboten macht, sollte also beide Ebenen lesen.',
        ],
      },
    ],
    'stage-lugano': [
      {
        title: 'Wie viel man in einem Lugano-Praktikum verdient',
        paragraphs: [
          'Die Praktikumsvergütung in Lugano variiert stark nach Sektor. Nachwuchskräfte in Banken, Big-Four-Prüfung, Steuerberatung und IT-Consulting verdienen typischerweise 3.500-5.000 CHF brutto pro Monat bei 100%. Anwaltskanzleien und Notariate liegen tiefer (2.500-4.000 CHF), bieten aber einen strukturierten Weg zur Zulassung.',
          'Die Kantonsverwaltung führt ein Programm für Spontanbewerbungen (Ref 04/26, Frist 31.12.2026) mit Vergütung nach Kantonsraster. Unbezahlte Praktika sind in der Schweiz nur innerhalb eines obligatorischen Curriculums zulässig — ausserhalb müssen sie als reguläre Anstellung entlöhnt werden.',
        ],
      },
      {
        title: 'G-Bewilligung und Praktikum: der Ablauf',
        paragraphs: [
          'Ein italienischer Grenzgänger-Praktikant mit G-Bewilligung folgt demselben Ablauf wie ein Angestellter: der Arbeitgeber meldet das Verhältnis der Migrationsbehörde, die Bewilligung wird ausgestellt, die Quellensteuer wird auf die Vergütung nach kantonalen Tabellen erhoben.',
          'Sozialbeiträge (AHV/IV/EO 5,3%, ALV 1,1%, UVG nicht-beruflich) werden abgezogen. Die BVG-Pflicht beginnt erst über der Schwelle von 22.680 CHF Jahreslohn — kurze Praktika bleiben meist darunter.',
        ],
      },
      {
        title: 'Wo offene Praktika zu finden sind',
        paragraphs: [
          'Neben der Kantonsausschreibung 04/26 sind die Hauptquellen die Karriereportale der in Tessin tätigen Banken (UBS, Julius Baer, BSI), der Prüfgesellschaften (Deloitte, PwC, EY, KPMG), der Tech-Arbeitgeber (Centro Svizzero di Calcolo Scientifico, regionale Software-Häuser) sowie die Universitäten USI und SUPSI, die Praktikumsangebote in ihre Studiengänge einbinden.',
          'Für industrielle Profile bieten viele Tessiner KMU in Feinmechanik, Uhrmacherei und Komponentenfertigung halb-strukturierte Praktika, die selten online publiziert sind — Spontanbewerbungen und Karrieretage der Universitäten sind die passenden Kanäle.',
        ],
      },
      {
        title: 'Nach dem Praktikum: Anstellungschancen',
        paragraphs: [
          'Statistisch mündet in Tessin mehr als die Hälfte der Bank- und Prüf-Praktika in ein unbefristetes Angebot. Industrielle KMU konvertieren zu 30-40%. Die Leistung während des Praktikums ist in allen Fällen der entscheidende Faktor.',
          'Für italienische Grenzgänger bedeutet der Übergang Praktikum → Festanstellung einen Wechsel im Steuerstatus: von reiner Quellensteuer hin zum vollen neuen Abkommensregime. Netto vor Unterschrift simulieren.',
        ],
      },
    ],
    'contratti-lavoro-frontalieri': [
      {
        title: 'GAV: was sie sind',
        paragraphs: [
          'Ein Schweizer Gesamtarbeitsvertrag (GAV) wird zwischen Branchenverbänden und Gewerkschaften geschlossen. Nach Allgemeinverbindlich-Erklärung gilt er für alle Angestellten des Sektors — inklusive italienische Grenzgänger. Er legt Mindest-Stundenlohn, Wochenstunden, Überstundenzulagen, Kündigungsfrist, Ferienminimum fest.',
          'Wichtige GAV für Tessiner Grenzgänger: GAV Personalverleih, GAV Hauptbau Tessin, L-GAV Hotellerie, GAV MEM, GAV EOC, GAV Privatkliniken Tessin, GAV Alters- und Pflegeheime Tessin. In Sektoren ohne GAV gilt das Obligationenrecht direkt.',
        ],
      },
      {
        title: 'Das neue Steuerabkommen ab 2024',
        paragraphs: [
          'Das Abkommen vom 23.12.2020 trat am 17.07.2023 in Kraft und ist seit 01.01.2024 operativ. „Alte" Grenzgänger behalten die ausschliessliche Besteuerung in der Schweiz. „Neue" zahlen rund 80% an der Quelle in der Schweiz und den Rest in Italien über eine ordentliche Steuererklärung mit Anrechnung.',
          'Die Gesamtbelastung kann zwischen alt und neu 5-12% differieren. Vor Unterschrift eines neuen Vertrags immer Netto simulieren — unser Rechner deckt beide Regime, den CHF/EUR-Kurs und den Distanz-Effekt ab.',
        ],
      },
      {
        title: 'Zu prüfende Vertragsklauseln',
        paragraphs: [
          'Wichtige Klauseln: Bruttolohn und Anzahl Monatslöhne (12 oder 13), Pensum, Probezeit (max. 3 Monate), Kündigungsfrist, Ferienminimum, 13. Monatslohn, Wochenstunden, Überstunden- und Nachtzuschläge, Krankentaggeld-Versicherung (die meisten GAV verlangen 80-90% für bis zu 730 Tage), BVG-Beiträge.',
          'Ebenfalls: nachvertragliche Konkurrenzklauseln (müssen eng gefasst sein), Rückzahlungsklauseln für Weiterbildung (können im Austrittsfall zehntausende Franken kosten).',
        ],
      },
      {
        title: 'Grenzgänger-spezifische Rechte',
        paragraphs: [
          'Zusätzliche Rechte: LAMal-Optionsrecht (Ersatz durch italienische SSN via S1-Formular); Zugang zur italienischen Arbeitslosenversicherung (NASpI) im Entlassungsfall, berechnet auf Schweizer Löhnen über das U1-Formular; steueroptimale Behandlung der BVG-Auszahlung im Ruhestand.',
          'Bei Streitigkeiten an OCST oder UNIA wenden — beide haben Tessiner Geschäftsstellen mit spezifischer Grenzgänger-Erfahrung und gratis Basisberatung für Mitglieder.',
        ],
      },
    ],
  },
  fr: {
    'agenzie-lavoro-lugano': [
      {
        title: "Vérifier l'autorisation SECO",
        paragraphs: [
          "Chaque agence de placement ou d'intérim en Suisse a besoin d'une autorisation cantonale et — pour opérer au-delà des frontières cantonales ou avec des candidats étrangers — d'une autorisation fédérale SECO au titre de la loi sur le service de l'emploi de 1989. Le SECO tient un registre électronique public avec plus de 7.200 entreprises. Si l'agence qui vous contacte n'y figure pas, refusez de signer.",
          "En tant que frontalier vous avez le droit d'exiger le numéro d'autorisation et une copie de la convention collective applicable (généralement la CCT Location de services). Une agence transparente fournit les deux en 24 heures.",
        ],
      },
      {
        title: 'Principales agences avec agence à Lugano',
        paragraphs: [
          "Groupes internationaux actifs à Lugano: Adecco, Manpower, Randstad, Kelly Services, Interiman, Trenkwalder. Régional: Sintex et Axxon Services sont aussi SECO-autorisés. Les spécialisations couvrent la santé, l'IT, l'industrie, l'hôtellerie.",
          "La liste n'est pas exhaustive. Le registre SECO AVG reste la seule source complète, filtrable par canton (TI) et commune. Nous recommandons de s'inscrire simultanément auprès de 2-3 agences pour maximiser les opportunités de matching.",
        ],
      },
      {
        title: 'Contrat temporaire: contenu obligatoire',
        paragraphs: [
          "Un contrat temporaire suisse doit préciser: salaire horaire brut, suppléments d'heures supplémentaires et de nuit, indemnité de vacances (au minimum 8,33% pour 4 semaines), 13e salaire au prorata, cotisations sociales (AVS/AI/APG 5,3%, AC 1,1%, LPP au-dessus du seuil, LAA non professionnelle), durée minimum garantie de la mission si applicable.",
          "Pour un frontalier avec permis G, le contrat doit indiquer l'application de l'impôt à la source et du prélèvement compensatoire — selon le nouvel accord fiscal Italie-Suisse du 23.12.2020, en vigueur depuis 2024.",
        ],
      },
      {
        title: 'Erreurs courantes',
        paragraphs: [
          "Trois erreurs sont fréquentes: accepter la première offre sans comparer; signer avec une agence non autorisée attirée par des promesses excessives (contrat nul, LAA absente); accepter des parts de salaire au noir pour « optimisation » (illégal, contrôles croisés des autorités cantonales).",
          "Dédier une demi-journée à comparer 2-3 agences en vaut la peine: l'écart sur le même profil peut atteindre 10-15% du salaire horaire.",
        ],
      },
    ],
    'concorsi-pubblici-lugano': [
      {
        title: "Fonctionnement d'un concours cantonal",
        paragraphs: [
          "Chaque poste vacant à l'administration cantonale tessinoise, à l'OSC (santé mentale), à l'EOC (hôpital public) ou dans les services liés est pourvu via un concours public. Le concours est publié sur concorsi.ti.ch avec référence, délai de candidature (3-6 semaines), exigences, pourcentage et classe salariale.",
          "Candidature en ligne via le portail RH. Documents à joindre: lettre de motivation, CV détaillé, diplômes, certificats de travail. Pour les rôles de santé: reconnaissance MEBEKO/SRK du diplôme italien si applicable.",
        ],
      },
      {
        title: 'Concorsi actuellement ouverts (instantané officiel)',
        paragraphs: [
          "Au dernier sync avec concorsi.ti.ch, les principaux concours ouverts sont: médecin-chef clinique psychiatrie OSC Mendrisio (réf 23/26, délai 31.12.2026), infirmiers en santé mentale OSC (réf 25/26, 31.10.2026), personnel des services généraux OSC (réf 26/26, 31.10.2026), médecins assistants OSC (réf 30/26, 31.12.2026).",
          "En permanence: aide-cuisine DECS Bellinzona (réf 02/26, 31.12.2026), candidatures spontanées pour stages universitaires (réf 04/26, 31.12.2026), collaborateurs administratifs et agents d'accueil (réf 180/25, 30.10.2026). Toujours vérifier sur www4.ti.ch/index.php?id=147427 — source unique toujours à jour.",
        ],
      },
      {
        title: 'Éligibilité des frontaliers italiens',
        paragraphs: [
          "La majorité des concours cantonaux sont ouverts aux candidats étrangers remplissant les conditions formelles (diplôme équivalent, permis de travail valide, italien). Seuls quelques rôles spécifiques (magistrature, certaines fonctions de police) exigent la nationalité suisse.",
          "Pour un titulaire de permis G la procédure est identique à celle d'un résident. L'Office cantonal de la migration traite l'autorisation en parallèle. Les exigences de domicile sont rares et ne s'appliquent généralement pas aux frontaliers.",
        ],
      },
      {
        title: "Salaires à l'administration cantonale",
        paragraphs: [
          "L'administration cantonale applique une loi salariale à 25 classes, chacune avec 20 échelons bisannuels. Un administratif en classe 5 gagne entre ~65.000 et ~95.000 CHF bruts par an (13 mensualités, 100%). Rôles soignants spécialisés (médecins, infirmiers SUP): classes 9-15, 85.000-140.000 CHF.",
          "Le net pour un frontalier dépend en outre de la distance à la frontière et du régime fiscal. Notre calculateur simule le net à partir de la classe et de l'échelon indiqués dans l'avis de concours.",
        ],
      },
    ],
    'stage-lugano': [
      {
        title: 'Combien on gagne en stage à Lugano',
        paragraphs: [
          "Les indemnités de stage à Lugano varient fortement selon le secteur. Un stagiaire post-universitaire en banque, audit Big Four, fiscalité ou conseil IT gagne typiquement 3.500-5.000 CHF bruts/mois à 100%. Les études d'avocats et études notariales sont un cran plus bas (2.500-4.000 CHF) mais offrent un parcours structuré vers le brevet.",
          "L'administration cantonale gère un programme de candidatures spontanées (réf 04/26, délai 31.12.2026) avec rémunération selon la grille cantonale. Les stages non rémunérés ne sont légaux en Suisse que dans un cursus obligatoire — sinon ils doivent être rémunérés comme un emploi.",
        ],
      },
      {
        title: 'Permis G et stage: le parcours',
        paragraphs: [
          "Un stagiaire frontalier italien avec permis G suit la même procédure qu'un salarié: l'employeur annonce la relation à l'Office de la migration, l'autorisation est délivrée, l'impôt à la source s'applique selon les barèmes cantonaux.",
          "Les cotisations sociales (AVS/AI/APG 5,3%, AC 1,1%, LAA non pro) sont retenues. Le 2e pilier (LPP) s'active au-dessus du seuil de 22.680 CHF annuels — les stages courts restent généralement en dessous.",
        ],
      },
      {
        title: "Où trouver les stages ouverts",
        paragraphs: [
          "Au-delà du concours cantonal 04/26, les sources principales sont les portails carrière des banques actives au Tessin (UBS, Julius Baer, BSI), des cabinets d'audit (Deloitte, PwC, EY, KPMG), des employeurs tech (Centre Suisse de Calcul Scientifique, software houses régionales) et des universités USI et SUPSI, qui publient des stages intégrés aux cursus.",
          "Pour les profils industriels, de nombreuses PME tessinoises en mécanique de précision, horlogerie et composants offrent des stages semi-structurés rarement publiés en ligne — candidatures spontanées et journées carrières universitaires sont les bons canaux.",
        ],
      },
      {
        title: "Après le stage: chances d'embauche",
        paragraphs: [
          "Statistiquement plus de la moitié des stages en banque et en audit au Tessin débouchent sur une offre permanente. Les PME industrielles convertissent à 30-40%. La qualité de la prestation pendant le stage est le facteur décisif.",
          "Pour un frontalier italien, le passage stage → CDI implique un changement de statut fiscal: du simple impôt à la source au régime complet du nouvel accord. Simulez le net avant de signer.",
        ],
      },
    ],
    'contratti-lavoro-frontalieri': [
      {
        title: "Conventions collectives (CCT): de quoi il s'agit",
        paragraphs: [
          "Une Convention Collective de Travail (CCT) suisse est signée entre associations sectorielles et syndicats. Déclarée de force obligatoire, elle s'applique à tous les salariés du secteur — y compris les frontaliers italiens — et fixe le salaire horaire minimum, la durée hebdomadaire, les suppléments, le préavis, les vacances minimum.",
          "Principales CCT pour frontaliers au Tessin: CCT Location de services, CCT Gros-œuvre Tessin, CCT Hôtellerie-Restauration Suisse, CCT MEM, CCT EOC, CCT Cliniques privées Tessin, CCT Maisons de retraite Tessin. Dans les secteurs sans CCT, le Code des obligations s'applique directement.",
        ],
      },
      {
        title: "Nouvel accord fiscal Italie-Suisse depuis 2024",
        paragraphs: [
          "L'accord du 23.12.2020 est entré en vigueur le 17.07.2023 et opérationnel depuis le 01.01.2024. Les « anciens » frontaliers conservent la taxation exclusive en Suisse. Les « nouveaux » paient environ 80% à la source en Suisse et le reste en Italie via déclaration ordinaire avec crédit d'impôt sur le total suisse.",
          "La pression totale peut différer de 5-12% entre anciens et nouveaux. Avant toute signature simulez le net — notre calculateur couvre les deux régimes, le cours CHF/EUR et l'effet de distance à la frontière.",
        ],
      },
      {
        title: "Clauses contractuelles à contrôler",
        paragraphs: [
          "Clauses clés: salaire brut et nombre de mensualités (12 ou 13), taux d'activité, période d'essai (max 3 mois), préavis, vacances minimum (4 semaines légales, souvent 5 par CCT), 13e salaire, heures hebdomadaires, suppléments heures supplémentaires / nuit, assurance perte de gain maladie (la plupart des CCT imposent 80-90% pendant 730 jours), cotisations 2e pilier.",
          "Également: clauses de non-concurrence post-contractuelle (doivent être étroites), clauses de remboursement de formation (peuvent coûter des dizaines de milliers de francs en cas de départ précoce).",
        ],
      },
      {
        title: 'Droits spécifiques aux frontaliers',
        paragraphs: [
          "Protections supplémentaires: droit d'option LAMal (remplacer l'assurance suisse par le SSN italien via le formulaire S1); accès à l'assurance-chômage italienne (NASpI) en cas de licenciement, calculée sur les salaires suisses via le formulaire U1; traitement fiscal optimisé du retrait LPP à la retraite.",
          "En cas de litige, contacter les syndicats OCST ou UNIA — tous deux ont des bureaux au Tessin avec une expertise spécifique frontalière et un conseil de base gratuit pour les membres.",
        ],
      },
    ],
  },
};

// Condensed FAQs per locale × id (3 Q&A each, ≈60-80 words total).
const CONDENSED_FAQS: Record<
  'en' | 'de' | 'fr',
  Record<CareerLandingId, CareerLandingFaq[]>
> = {
  en: {
    'agenzie-lavoro-lugano': [
      {
        question:
          'Where do I find the official list of SECO-authorised staffing agencies in Lugano?',
        answer:
          'Use the SECO AVG public register at vzavg1.admin.ch/vzavg-verzeichnis-frontend, filter by canton TI and city Lugano. It is the only authoritative source.',
      },
      {
        question: 'Can I register with several staffing agencies at once?',
        answer:
          'Yes. There is no exclusivity and many cross-border workers register with 3-5 agencies to maximise opportunities. Avoid duplicate applications to the same end client — some agencies apply lock-in clauses.',
      },
      {
        question: 'Can the agency keep a share of my salary as commission?',
        answer:
          'No. The Federal Employment Service Act bars the worker from paying commissions; agency fees are paid by the end employer. Any agency asking for money from the candidate is operating illegally.',
      },
    ],
    'concorsi-pubblici-lugano': [
      {
        question: 'Are Ticino public-sector competitions open to Italian cross-border workers?',
        answer:
          'Yes, for the large majority of roles. Only specific functions (magistracy, some police) require Swiss citizenship. Administrative, healthcare, school and technical roles are open to permit G holders.',
      },
      {
        question: 'Where is the always-up-to-date list of open competitions?',
        answer:
          'www4.ti.ch/index.php?id=147427 for cantonal administration and concorsi.ti.ch for the detail pages. Check both every 2-4 weeks.',
      },
      {
        question: 'How long does the application-to-hiring process take?',
        answer:
          'Average 3-5 months. Urgent healthcare roles (e.g. OSC nurses) can close in 6-8 weeks; managerial roles can take 4-6 months.',
      },
    ],
    'stage-lugano': [
      {
        question: 'How long does a typical Lugano internship last?',
        answer:
          '3-6 months in banking, audit and IT; up to 12 months in the cantonal administration and universities. Academic internships follow the project timeline.',
      },
      {
        question: 'Can I intern in Switzerland as an Italian undergraduate?',
        answer:
          'Yes, either as a mandatory curricular traineeship or under a paid internship contract with a Ticino employer. Both require permit G.',
      },
      {
        question: 'Is my Lugano internship stipend taxed in Italy or Switzerland?',
        answer:
          'Under the new treaty the source tax applies in Switzerland plus a residual share in Italy for new cross-border workers. Short internships may follow specific rules — check with a cross-border tax advisor.',
      },
    ],
    'contratti-lavoro-frontalieri': [
      {
        question:
          "I'm a new cross-border worker: can I opt for exclusive Swiss taxation?",
        answer:
          'No. The old-regime (exclusive Swiss taxation) is closed to hires after 17 July 2023, unless you had continuous cross-border work before that date. New workers pay roughly 80% in Switzerland and the residual in Italy with tax credit.',
      },
      {
        question: 'My Swiss contract does not mention a CCL — do I have one?',
        answer:
          'Generally-binding CCLs apply ex officio even if the contract does not cite them. Check the SECO page on generally-binding CCLs per canton and sector. OCST and UNIA offer free basic consultations for members.',
      },
      {
        question: 'If I am laid off, do I qualify for Italian NASpI on Swiss salaries?',
        answer:
          "Yes. As a resident in Italy with Swiss employment, NASpI is paid by INPS based on converted Swiss salaries. The cantonal U1 form certifies contribution periods.",
      },
    ],
  },
  de: {
    'agenzie-lavoro-lugano': [
      {
        question:
          'Wo finde ich das offizielle Verzeichnis SECO-autorisierter Agenturen in Lugano?',
        answer:
          'Im öffentlichen SECO AVG-Register unter vzavg1.admin.ch/vzavg-verzeichnis-frontend, gefiltert nach Kanton TI und Gemeinde Lugano. Einzige massgebliche Quelle.',
      },
      {
        question: 'Darf ich mich bei mehreren Agenturen gleichzeitig eintragen?',
        answer:
          'Ja. Keine Exklusivität — viele Grenzgänger tragen sich bei 3-5 Agenturen ein. Doppelbewerbungen beim gleichen Endkunden sollten vermieden werden.',
      },
      {
        question: 'Darf die Agentur einen Teil meines Lohns als Provision einbehalten?',
        answer:
          'Nein. Das Arbeitsvermittlungsgesetz verbietet dem Arbeitnehmer Provisionen; die Vermittlungsgebühren trägt das Endunternehmen. Wer vom Kandidaten Geld verlangt, handelt illegal.',
      },
    ],
    'concorsi-pubblici-lugano': [
      {
        question:
          'Sind Tessiner Concorsi für italienische Grenzgänger zugänglich?',
        answer:
          'Ja, für die meisten Rollen. Nur einzelne Funktionen (Magistratur, bestimmte Polizeirollen) verlangen Schweizer Bürgerrecht. Verwaltung, Pflege, Schule, Technik sind für G-Bewilligungsinhaber offen.',
      },
      {
        question: 'Wo finde ich die stets aktuelle Liste offener Concorsi?',
        answer:
          'www4.ti.ch/index.php?id=147427 für die kantonale Verwaltung und concorsi.ti.ch für die Detailseiten. Alle 2-4 Wochen prüfen.',
      },
      {
        question: 'Wie lange dauert der Prozess von Bewerbung bis Anstellung?',
        answer:
          'Im Schnitt 3-5 Monate. Dringende Pflegestellen (z.B. OSC) schliessen in 6-8 Wochen; Führungsrollen dauern 4-6 Monate.',
      },
    ],
    'stage-lugano': [
      {
        question: 'Wie lange dauert ein typisches Praktikum in Lugano?',
        answer:
          '3-6 Monate in Bank, Prüfung und IT; bis zu 12 Monate in der Kantonsverwaltung und an Universitäten. Akademische Praktika folgen dem Projektzeitplan.',
      },
      {
        question: 'Darf ich als italienischer Student ein Praktikum in der Schweiz machen?',
        answer:
          'Ja, entweder als obligatorisches Curriculum-Praktikum oder als bezahltes Praktikum bei einem Tessiner Arbeitgeber. Beide Varianten brauchen die G-Bewilligung.',
      },
      {
        question: 'Wird mein Praktikum-Lohn in Italien oder in der Schweiz besteuert?',
        answer:
          'Unter dem neuen Abkommen gilt Quellensteuer in der Schweiz plus ein italienischer Restbetrag für neue Grenzgänger. Kurze Praktika können Sonderregeln haben — bei einem Grenzgänger-Steuerberater klären.',
      },
    ],
    'contratti-lavoro-frontalieri': [
      {
        question:
          'Ich bin neuer Grenzgänger: kann ich ausschliessliche Schweizer Besteuerung wählen?',
        answer:
          'Nein. Das Alt-Regime (ausschliessliche Schweizer Besteuerung) ist für Neuanstellungen nach dem 17.07.2023 geschlossen. Neue zahlen rund 80% in der Schweiz und den Rest in Italien mit Anrechnung.',
      },
      {
        question: 'Mein Schweizer Vertrag erwähnt keinen GAV — gilt trotzdem einer?',
        answer:
          'Allgemeinverbindliche GAV gelten von Amtes wegen. Prüfen Sie auf der SECO-Seite „allgemeinverbindlich erklärte GAV" nach Kanton und Sektor. OCST und UNIA bieten kostenlose Basis-Beratung für Mitglieder.',
      },
      {
        question: 'Habe ich im Entlassungsfall Anspruch auf italienisches NASpI trotz Schweizer Anstellung?',
        answer:
          'Ja. Als in Italien wohnhafter Grenzgänger wird NASpI von der INPS auf Basis umgerechneter Schweizer Löhne gezahlt. Das kantonale U1-Formular bestätigt die Beitragszeiten.',
      },
    ],
  },
  fr: {
    'agenzie-lavoro-lugano': [
      {
        question:
          "Où trouver le registre officiel des agences SECO autorisées à Lugano ?",
        answer:
          "Dans le registre public SECO AVG sur vzavg1.admin.ch/vzavg-verzeichnis-frontend, filtré par canton TI et commune Lugano. Source unique faisant foi.",
      },
      {
        question: "Puis-je m'inscrire simultanément auprès de plusieurs agences ?",
        answer:
          "Oui. Aucune exclusivité — de nombreux frontaliers s'inscrivent auprès de 3-5 agences. Évitez les candidatures en double chez le même client final.",
      },
      {
        question: "L'agence peut-elle prélever une commission sur mon salaire ?",
        answer:
          "Non. La loi fédérale sur le service de l'emploi interdit au travailleur de payer des commissions; les frais de placement sont à la charge de l'entreprise utilisatrice.",
      },
    ],
    'concorsi-pubblici-lugano': [
      {
        question: 'Les concours tessinois sont-ils ouverts aux frontaliers italiens ?',
        answer:
          "Oui pour la grande majorité des rôles. Seules certaines fonctions (magistrature, certaines fonctions de police) exigent la nationalité suisse. Administration, santé, école et technique sont ouverts aux permis G.",
      },
      {
        question: 'Où trouver la liste toujours à jour des concours ouverts ?',
        answer:
          "www4.ti.ch/index.php?id=147427 pour l'administration cantonale et concorsi.ti.ch pour les fiches détaillées. Contrôler toutes les 2-4 semaines.",
      },
      {
        question: "Combien de temps dure le processus candidature → embauche ?",
        answer:
          "3-5 mois en moyenne. Les rôles urgents de santé (infirmiers OSC) se ferment en 6-8 semaines; les postes de direction prennent 4-6 mois.",
      },
    ],
    'stage-lugano': [
      {
        question: 'Combien de temps dure un stage typique à Lugano ?',
        answer:
          "3-6 mois en banque, audit et IT; jusqu'à 12 mois à l'administration cantonale et dans les universités. Les stages académiques suivent le calendrier du projet.",
      },
      {
        question: 'Puis-je faire un stage en Suisse comme étudiant italien non diplômé ?',
        answer:
          "Oui, soit comme stage curriculaire obligatoire de votre cursus italien, soit comme contrat de stage rémunéré chez un employeur tessinois. Les deux nécessitent le permis G.",
      },
      {
        question: 'Mon indemnité de stage est-elle taxée en Italie ou en Suisse ?',
        answer:
          "Sous le nouvel accord: impôt à la source en Suisse plus un résiduel en Italie pour les nouveaux frontaliers. Les stages courts peuvent suivre des règles spécifiques — vérifier avec un conseiller fiscal frontalier.",
      },
    ],
    'contratti-lavoro-frontalieri': [
      {
        question:
          "Je suis nouveau frontalier: puis-je opter pour la taxation exclusive en Suisse ?",
        answer:
          "Non. Le régime « ancien » est fermé aux embauches après le 17.07.2023, sauf continuité avec un emploi frontalier antérieur. Les nouveaux paient ~80% en Suisse et le reste en Italie avec crédit d'impôt.",
      },
      {
        question: "Mon contrat suisse ne mentionne pas de CCT — en ai-je une ?",
        answer:
          "Les CCT de force obligatoire s'appliquent d'office même sans citation au contrat. Vérifiez sur la page SECO « CCT étendues » par canton et secteur. OCST et UNIA proposent un conseil de base gratuit aux membres.",
      },
      {
        question: "En cas de licenciement, ai-je droit à la NASpI italienne sur salaires suisses ?",
        answer:
          "Oui. Comme résident italien travaillant en Suisse, l'INPS verse la NASpI sur la base des salaires suisses convertis. Le formulaire cantonal U1 atteste les périodes de cotisation.",
      },
    ],
  },
};

// ─────────────────────────────────────────────────────────────────
// Exported map: locale × id → CareerLandingCopy
// ─────────────────────────────────────────────────────────────────

export const CAREER_LANDING_COPY: Record<
  CareerLocale,
  Record<CareerLandingId, CareerLandingCopy>
> = {
  it: IT_COPY,
  en: {
    'agenzie-lavoro-lugano': condenseFor('en', 'agenzie-lavoro-lugano'),
    'concorsi-pubblici-lugano': condenseFor('en', 'concorsi-pubblici-lugano'),
    'stage-lugano': condenseFor('en', 'stage-lugano'),
    'contratti-lavoro-frontalieri': condenseFor('en', 'contratti-lavoro-frontalieri'),
  },
  de: {
    'agenzie-lavoro-lugano': condenseFor('de', 'agenzie-lavoro-lugano'),
    'concorsi-pubblici-lugano': condenseFor('de', 'concorsi-pubblici-lugano'),
    'stage-lugano': condenseFor('de', 'stage-lugano'),
    'contratti-lavoro-frontalieri': condenseFor('de', 'contratti-lavoro-frontalieri'),
  },
  fr: {
    'agenzie-lavoro-lugano': condenseFor('fr', 'agenzie-lavoro-lugano'),
    'concorsi-pubblici-lugano': condenseFor('fr', 'concorsi-pubblici-lugano'),
    'stage-lugano': condenseFor('fr', 'stage-lugano'),
    'contratti-lavoro-frontalieri': condenseFor('fr', 'contratti-lavoro-frontalieri'),
  },
};

// ─────────────────────────────────────────────────────────────────
// Template B — per-locale shell + per-id copy.
// ─────────────────────────────────────────────────────────────────

const TEMPLATE_B_SHELL: Record<CareerLocale, CareerTemplateBShell> = {
  it: {
    eyebrow: 'Lavoro · Lugano · 2026',
    updatedLabel: 'Aggiornato',
    approfondisciHeading: 'Approfondisci',
    featuredJobsTitle: 'Offerte in evidenza',
    featuredJobsEmpty:
      'Nessuna offerta indicizzata in questo momento — controlla il job board completo.',
    featuredJobsCtaAll: (n) => `Vedi tutte le ${n} offerte →`,
    employerGridTitle: 'Chi assume',
    jobPostedLabel: (d) =>
      d <= 0 ? 'Pubblicata oggi' : d === 1 ? 'Pubblicata ieri' : `Pubblicata ${d} giorni fa`,
    jobSalaryFmt: (min, max) => {
      if (min && max) return `CHF ${min.toLocaleString('it-CH')}–${max.toLocaleString('it-CH')}/anno`;
      if (min) return `Da CHF ${min.toLocaleString('it-CH')}/anno`;
      if (max) return `Fino a CHF ${max.toLocaleString('it-CH')}/anno`;
      return '';
    },
    noSalaryLabel: 'salario non dichiarato',
  },
  en: {
    eyebrow: 'Jobs · Lugano · 2026',
    updatedLabel: 'Updated',
    approfondisciHeading: 'Read more',
    featuredJobsTitle: 'Featured openings',
    featuredJobsEmpty: 'No indexed openings right now — check the full job board.',
    featuredJobsCtaAll: (n) => `See all ${n} openings →`,
    employerGridTitle: 'Who is hiring',
    jobPostedLabel: (d) =>
      d <= 0 ? 'Posted today' : d === 1 ? 'Posted yesterday' : `Posted ${d} days ago`,
    jobSalaryFmt: (min, max) => {
      if (min && max) return `CHF ${min.toLocaleString('en-CH')}–${max.toLocaleString('en-CH')}/year`;
      if (min) return `From CHF ${min.toLocaleString('en-CH')}/year`;
      if (max) return `Up to CHF ${max.toLocaleString('en-CH')}/year`;
      return '';
    },
    noSalaryLabel: 'salary not disclosed',
  },
  de: {
    eyebrow: 'Jobs · Lugano · 2026',
    updatedLabel: 'Aktualisiert',
    approfondisciHeading: 'Mehr erfahren',
    featuredJobsTitle: 'Empfohlene Stellen',
    featuredJobsEmpty: 'Derzeit keine indexierten Stellen — siehe vollständige Stellenbörse.',
    featuredJobsCtaAll: (n) => `Alle ${n} Stellen ansehen →`,
    employerGridTitle: 'Wer einstellt',
    jobPostedLabel: (d) =>
      d <= 0 ? 'Heute veröffentlicht' : d === 1 ? 'Gestern veröffentlicht' : `Vor ${d} Tagen veröffentlicht`,
    jobSalaryFmt: (min, max) => {
      if (min && max) return `CHF ${min.toLocaleString('de-CH')}–${max.toLocaleString('de-CH')}/Jahr`;
      if (min) return `Ab CHF ${min.toLocaleString('de-CH')}/Jahr`;
      if (max) return `Bis CHF ${max.toLocaleString('de-CH')}/Jahr`;
      return '';
    },
    noSalaryLabel: 'Lohn nicht angegeben',
  },
  fr: {
    eyebrow: 'Emploi · Lugano · 2026',
    updatedLabel: 'Mis à jour',
    approfondisciHeading: 'Pour aller plus loin',
    featuredJobsTitle: 'Offres mises en avant',
    featuredJobsEmpty: 'Aucune offre indexée actuellement — consultez la bourse complète.',
    featuredJobsCtaAll: (n) => `Voir les ${n} offres →`,
    employerGridTitle: 'Qui recrute',
    jobPostedLabel: (d) =>
      d <= 0 ? "Publié aujourd'hui" : d === 1 ? 'Publié hier' : `Publié il y a ${d} jours`,
    jobSalaryFmt: (min, max) => {
      if (min && max) return `CHF ${min.toLocaleString('fr-CH')}–${max.toLocaleString('fr-CH')}/an`;
      if (min) return `Dès CHF ${min.toLocaleString('fr-CH')}/an`;
      if (max) return `Jusqu'à CHF ${max.toLocaleString('fr-CH')}/an`;
      return '';
    },
    noSalaryLabel: 'salaire non communiqué',
  },
};

// Salary-calculator URL per locale (template-B primary CTA target — pages
// without a calculator hook (agenzie) fall back to the job-board).
const CALCULATOR_URL: Record<CareerLocale, string> = {
  it: '/calcola-stipendio/',
  en: '/en/calculate-salary/',
  de: '/de/gehalt-berechnen/',
  fr: '/fr/calculer-salaire/',
};

const JOB_BOARD_URL: Record<CareerLocale, string> = {
  it: '/cerca-lavoro-ticino/',
  en: '/en/find-jobs-ticino/',
  de: '/de/jobs-im-tessin/',
  fr: '/fr/trouver-emploi-tessin/',
};

function fmtIntLocale(n: number, locale: CareerLocale): string {
  const tag = { it: 'it-CH', en: 'en-CH', de: 'de-CH', fr: 'fr-CH' }[locale];
  return n.toLocaleString(tag);
}

function fmtChfLocale(n: number, locale: CareerLocale): string {
  return `CHF ${fmtIntLocale(n, locale)}`;
}

// ── Per-id × per-locale dense lede ───────────────────────────────────────────

interface DenseLedeInputs {
  liveCount: number;
  fresh30Count: number;
  medianSalary: number | null;
  agencyCount: number;
  concorsiCount: number;
}

const DENSE_LEDE: Record<CareerLandingId, Record<CareerLocale, (i: DenseLedeInputs) => string>> = {
  'agenzie-lavoro-lugano': {
    it: (i) =>
      `${i.agencyCount} agenzie SECO autorizzate a Lugano · interinale coperto da CCL · permesso G full rights.`,
    en: (i) =>
      `${i.agencyCount} SECO-licensed staffing agencies in Lugano · CLA-covered interim work · full G-permit rights.`,
    de: (i) =>
      `${i.agencyCount} SECO-bewilligte Personalvermittler in Lugano · GAV-geregelte Temporärarbeit · volle G-Bewilligungs-Rechte.`,
    fr: (i) =>
      `${i.agencyCount} agences agréées SECO à Lugano · intérim couvert par CCT · droits complets du permis G.`,
  },
  'concorsi-pubblici-lugano': {
    it: (i) =>
      `${i.concorsiCount} concorsi pubblici aperti in Ticino · ${i.fresh30Count} nuove offerte pubbliche negli ultimi 30 giorni · stipendi cantonali su tabella ufficiale.`,
    en: (i) =>
      `${i.concorsiCount} open public-sector competitions in Ticino · ${i.fresh30Count} new public jobs in the last 30 days · cantonal pay scale.`,
    de: (i) =>
      `${i.concorsiCount} offene öffentliche Wettbewerbe im Tessin · ${i.fresh30Count} neue öffentliche Stellen in 30 Tagen · kantonaler Lohnraster.`,
    fr: (i) =>
      `${i.concorsiCount} concours publics ouverts au Tessin · ${i.fresh30Count} nouveaux postes publics ces 30 derniers jours · grille salariale cantonale.`,
  },
  'stage-lugano': {
    it: (i) =>
      `${i.liveCount} stage attivi a Lugano · ${i.fresh30Count} nuovi negli ultimi 30 giorni · CCL e copertura LAINF garantite anche per stagisti frontalieri.`,
    en: (i) =>
      `${i.liveCount} active internships in Lugano · ${i.fresh30Count} new in the last 30 days · CLA and accident insurance covered for cross-border interns.`,
    de: (i) =>
      `${i.liveCount} aktive Praktika in Lugano · ${i.fresh30Count} neu in 30 Tagen · GAV und UVG-Deckung auch für Grenzgänger-Praktikanten.`,
    fr: (i) =>
      `${i.liveCount} stages actifs à Lugano · ${i.fresh30Count} nouveaux ces 30 derniers jours · CCT et LAA garanties pour les stagiaires frontaliers.`,
  },
  'contratti-lavoro-frontalieri': {
    it: (i) =>
      `${fmtIntLocale(i.liveCount, 'it')} offerte aperte in Svizzera per permesso G · ${i.fresh30Count} nuove in 30 giorni · stipendio mediano CHF ${i.medianSalary ? fmtIntLocale(i.medianSalary, 'it') : '—'}/anno.`,
    en: (i) =>
      `${fmtIntLocale(i.liveCount, 'en')} G-permit openings across Switzerland · ${i.fresh30Count} new in 30 days · median gross salary CHF ${i.medianSalary ? fmtIntLocale(i.medianSalary, 'en') : '—'}/year.`,
    de: (i) =>
      `${fmtIntLocale(i.liveCount, 'de')} offene Stellen für G-Bewilligung in der Schweiz · ${i.fresh30Count} neu in 30 Tagen · Medianlohn CHF ${i.medianSalary ? fmtIntLocale(i.medianSalary, 'de') : '—'}/Jahr.`,
    fr: (i) =>
      `${fmtIntLocale(i.liveCount, 'fr')} offres ouvertes en Suisse pour permis G · ${i.fresh30Count} nouveaux en 30 jours · salaire médian CHF ${i.medianSalary ? fmtIntLocale(i.medianSalary, 'fr') : '—'}/an.`,
  },
};

// ── Per-id × per-locale stat-tile + CTA copy ────────────────────────────────

interface CareerStatLabels {
  tile1Label: string;
  tile2Label: string;
  tile3Label: string;
  primaryCtaLabel: string;
  employerGridTitle?: string;
  featuredJobsTitle?: string;
  featuredJobsSubtitle?: string;
  employerGridReplacement?: string;
}

const STAT_LABELS: Record<CareerLandingId, Record<CareerLocale, CareerStatLabels>> = {
  'agenzie-lavoro-lugano': {
    it: {
      tile1Label: 'Agenzie SECO a Lugano',
      tile2Label: 'Autorizzazione SECO',
      tile3Label: 'Diritto frontalieri',
      primaryCtaLabel: 'Calcola il netto da interinale',
      employerGridTitle: 'Agenzie SECO autorizzate a Lugano',
      featuredJobsTitle: 'Posizioni tipiche reclutate dalle agenzie a Lugano',
      featuredJobsSubtitle:
        "Esempi di ruoli per cui le agenzie SECO di Lugano reclutano. Per candidarti, contatta direttamente l'agenzia.",
    },
    en: {
      tile1Label: 'SECO agencies in Lugano',
      tile2Label: 'SECO licence required',
      tile3Label: 'Cross-border rights',
      primaryCtaLabel: 'Calculate net interim salary',
      employerGridTitle: 'SECO-licensed staffing agencies in Lugano',
      featuredJobsTitle: 'Roles typically placed by staffing agencies in Lugano',
      featuredJobsSubtitle:
        'Examples of roles SECO-licensed staffing agencies in Lugano recruit for. To apply, contact the agency directly.',
    },
    de: {
      tile1Label: 'SECO-Agenturen in Lugano',
      tile2Label: 'SECO-Bewilligung Pflicht',
      tile3Label: 'Grenzgänger-Rechte',
      primaryCtaLabel: 'Temporär-Nettolohn berechnen',
      employerGridTitle: 'SECO-bewilligte Personalvermittler in Lugano',
      featuredJobsTitle: 'Typische Stellen von Vermittlungsagenturen in Lugano',
      featuredJobsSubtitle:
        'Beispiele für Rollen, die SECO-bewilligte Agenturen in Lugano besetzen. Zur Bewerbung wenden Sie sich direkt an die Agentur.',
    },
    fr: {
      tile1Label: 'Agences SECO à Lugano',
      tile2Label: 'Autorisation SECO',
      tile3Label: 'Droits frontaliers',
      primaryCtaLabel: 'Calculer le net en intérim',
      employerGridTitle: 'Agences agréées SECO à Lugano',
      featuredJobsTitle: 'Postes typiquement placés par les agences à Lugano',
      featuredJobsSubtitle:
        'Exemples de postes pour lesquels les agences SECO de Lugano recrutent. Pour postuler, contactez directement l’agence.',
    },
  },
  'concorsi-pubblici-lugano': {
    it: {
      tile1Label: 'Concorsi aperti (TI)',
      tile2Label: 'Offerte settore pubblico',
      tile3Label: 'Nuovi negli ultimi 30 gg',
      primaryCtaLabel: 'Calcola il netto cantonale',
      employerGridTitle: 'Principali enti pubblici che assumono',
      featuredJobsTitle: 'Offerte settore pubblico Lugano',
    },
    en: {
      tile1Label: 'Open competitions (TI)',
      tile2Label: 'Public-sector openings',
      tile3Label: 'New in last 30 days',
      primaryCtaLabel: 'Calculate cantonal net salary',
      employerGridTitle: 'Main public employers',
      featuredJobsTitle: 'Public-sector openings — Lugano',
    },
    de: {
      tile1Label: 'Offene Wettbewerbe (TI)',
      tile2Label: 'Stellen öffentl. Sektor',
      tile3Label: 'Neu in 30 Tagen',
      primaryCtaLabel: 'Kantonalen Nettolohn berechnen',
      employerGridTitle: 'Wichtigste öffentliche Arbeitgeber',
      featuredJobsTitle: 'Öffentliche Stellen — Lugano',
    },
    fr: {
      tile1Label: 'Concours ouverts (TI)',
      tile2Label: 'Offres secteur public',
      tile3Label: 'Nouveaux en 30 j',
      primaryCtaLabel: 'Calculer le net cantonal',
      employerGridTitle: 'Principaux employeurs publics',
      featuredJobsTitle: 'Offres secteur public — Lugano',
    },
  },
  'stage-lugano': {
    it: {
      tile1Label: 'Stage attivi a Lugano',
      tile2Label: 'Indennità mediana',
      tile3Label: 'Nuovi negli ultimi 30 gg',
      primaryCtaLabel: 'Calcola netto da stagista frontaliere',
      featuredJobsTitle: 'Stage in evidenza a Lugano',
      employerGridReplacement:
        'I principali sbocchi per stage a Lugano sono USI, SUPSI, EOC, Tether/Lugano crypto-valley, gruppo BancaStato e fondazioni cantonali. Lo stage frontaliere richiede permesso G ridotto (durata pari al contratto) ed è coperto dal CCL del settore di riferimento.',
    },
    en: {
      tile1Label: 'Active internships in Lugano',
      tile2Label: 'Median allowance',
      tile3Label: 'New in last 30 days',
      primaryCtaLabel: 'Calculate cross-border intern net pay',
      featuredJobsTitle: 'Featured internships — Lugano',
      employerGridReplacement:
        'Main destinations for internships in Lugano: USI, SUPSI, EOC, Tether / Lugano crypto-valley, BancaStato group and cantonal foundations. Cross-border internships use a short-term G-permit (term-matched) and are covered by the sector CLA.',
    },
    de: {
      tile1Label: 'Aktive Praktika in Lugano',
      tile2Label: 'Median-Entschädigung',
      tile3Label: 'Neu in 30 Tagen',
      primaryCtaLabel: 'Grenzgänger-Praktikum-Nettolohn berechnen',
      featuredJobsTitle: 'Empfohlene Praktika — Lugano',
      employerGridReplacement:
        'Hauptanbieter für Praktika in Lugano: USI, SUPSI, EOC, Tether / Lugano crypto-valley, BancaStato-Gruppe und kantonale Stiftungen. Grenzgänger-Praktika nutzen eine kurze G-Bewilligung (vertragslänge-gebunden) und sind durch den Sektor-GAV gedeckt.',
    },
    fr: {
      tile1Label: 'Stages actifs à Lugano',
      tile2Label: 'Indemnité médiane',
      tile3Label: 'Nouveaux en 30 j',
      primaryCtaLabel: 'Calculer net stagiaire frontalier',
      featuredJobsTitle: 'Stages mis en avant — Lugano',
      employerGridReplacement:
        'Principaux débouchés pour les stages à Lugano : USI, SUPSI, EOC, Tether / Lugano crypto-valley, groupe BancaStato et fondations cantonales. Le stage frontalier utilise un permis G court (durée du contrat) et est couvert par la CCT sectorielle.',
    },
  },
  'contratti-lavoro-frontalieri': {
    it: {
      tile1Label: 'Offerte CH per permesso G',
      tile2Label: 'Stipendio mediano',
      tile3Label: 'Nuove negli ultimi 30 gg',
      primaryCtaLabel: 'Simula il tuo netto frontaliere',
      employerGridReplacement:
        'Il contratto del frontaliere ricalca il diritto svizzero: CCL applicabile per settore, periodo di prova 1-3 mesi (art. 335b CO), 5 settimane di vacanza minime (6 dopo i 50 anni), assicurazioni sociali svizzere (AVS/AI/IPG, LAINF, LPP) trattenute alla fonte. Per l\'imposizione vale l\'Accordo 2020 (nuovi frontalieri ≥ 17/07/2023: 80 % imposta CH + dichiarazione IT).',
    },
    en: {
      tile1Label: 'Swiss openings (G-permit)',
      tile2Label: 'Median salary',
      tile3Label: 'New in last 30 days',
      primaryCtaLabel: 'Simulate your cross-border net',
      employerGridReplacement:
        'A cross-border employment contract follows Swiss law: sector CLA applies, 1-3 month probation (art. 335b CO), minimum 5 weeks of paid leave (6 after age 50), Swiss social insurance (AVS/AI/IPG, LAINF, LPP) withheld at source. Taxation follows the 2020 bilateral accord (new cross-borderers ≥ 17/07/2023: 80 % CH source tax + Italian declaration).',
    },
    de: {
      tile1Label: 'CH-Stellen (G-Bewilligung)',
      tile2Label: 'Medianlohn',
      tile3Label: 'Neu in 30 Tagen',
      primaryCtaLabel: 'Grenzgänger-Nettolohn simulieren',
      employerGridReplacement:
        'Der Grenzgänger-Vertrag folgt dem Schweizer Recht: GAV nach Branche, Probezeit 1-3 Monate (Art. 335b OR), mindestens 5 Wochen Ferien (6 ab 50), Schweizer Sozialversicherungen (AHV/IV/EO, UVG, BVG) an der Quelle einbehalten. Besteuerung nach Abkommen 2020 (neue Grenzgänger ≥ 17.07.2023: 80 % CH-Quellensteuer + italienische Deklaration).',
    },
    fr: {
      tile1Label: 'Offres CH (permis G)',
      tile2Label: 'Salaire médian',
      tile3Label: 'Nouveaux en 30 j',
      primaryCtaLabel: 'Simuler votre net frontalier',
      employerGridReplacement:
        'Le contrat frontalier suit le droit suisse : CCT sectorielle, période d\'essai 1-3 mois (art. 335b CO), 5 semaines de vacances minimum (6 après 50 ans), assurances sociales suisses (AVS/AI/APG, LAA, LPP) prélevées à la source. Fiscalité selon l\'accord 2020 (nouveaux frontaliers ≥ 17/07/2023 : 80 % impôt source CH + déclaration italienne).',
    },
  },
};

// ── Public API: build per-(locale, id) template B copy ──────────────────────

export interface CareerTemplateBSnapshotInputs {
  /** Live count from aggregateCareerLandings (jobs or curated registry). */
  liveCount: number;
  /** Jobs first-seen/posted in the last 30 days. */
  fresh30Count: number;
  /** Median annual gross CHF salary — null when the topic doesn't ship one. */
  medianSalary: number | null;
  /** Curated counts that override `liveCount` for the headline tile. */
  agencyCount: number;
  concorsiCount: number;
}

export function buildCareerTemplateBCopy(
  locale: CareerLocale,
  id: CareerLandingId,
  snapshot: CareerTemplateBSnapshotInputs,
): CareerTemplateBCopy {
  const shell = TEMPLATE_B_SHELL[locale];
  const labels = STAT_LABELS[id][locale];
  const denseLede = DENSE_LEDE[id][locale](snapshot);

  // Per-id stat-tile composition: each id binds the 3 tiles to the snapshot
  // fields that make sense for the topic.
  if (id === 'agenzie-lavoro-lugano') {
    return {
      eyebrow: shell.eyebrow,
      denseLede,
      statTile1: {
        label: labels.tile1Label,
        valueFromCount: (c) => fmtIntLocale(c, locale),
        tone: 'accent',
      },
      statTile2: {
        label: labels.tile2Label,
        value: { it: 'Obbligatoria', en: 'Mandatory', de: 'Pflicht', fr: 'Obligatoire' }[locale],
        tone: 'warning',
      },
      statTile3: {
        label: labels.tile3Label,
        valueFromFresh: () =>
          ({ it: 'CCL pieno', en: 'Full CLA', de: 'Voller GAV', fr: 'CCT complète' }[locale]),
        tone: 'success',
      },
      primaryCtaLabel: labels.primaryCtaLabel,
      primaryCtaHref: CALCULATOR_URL[locale],
      // Featured cards source: Lugano-area staffing-typical roles (proxy —
      // see buildStaffingSnapshot). Reframed honestly via per-id title +
      // subtitle so visitors aren't misled that these jobs are hosted by the
      // agencies themselves.
      showFeaturedJobs: true,
      showEmployerGrid: true,
      featuredJobsTitle: labels.featuredJobsTitle,
      featuredJobsSubtitle: labels.featuredJobsSubtitle,
      employerGridTitle: labels.employerGridTitle,
    };
  }

  if (id === 'concorsi-pubblici-lugano') {
    return {
      eyebrow: shell.eyebrow,
      denseLede,
      statTile1: {
        label: labels.tile1Label,
        valueFromCount: (c) => fmtIntLocale(c, locale),
        tone: 'accent',
      },
      statTile2: {
        label: labels.tile2Label,
        value: (snap) => fmtIntLocale(snap.liveCount, locale),
        tone: 'success',
      },
      statTile3: {
        label: labels.tile3Label,
        valueFromFresh: (f) => `+${fmtIntLocale(f, locale)}`,
        tone: 'warning',
      },
      primaryCtaLabel: labels.primaryCtaLabel,
      primaryCtaHref: CALCULATOR_URL[locale],
      showFeaturedJobs: true,
      showEmployerGrid: true,
      featuredJobsTitle: labels.featuredJobsTitle,
      employerGridTitle: labels.employerGridTitle,
    };
  }

  if (id === 'stage-lugano') {
    const indemnitaLabel: Record<CareerLocale, string> = {
      it: 'Stage non pagato / variabile',
      en: 'Unpaid / variable',
      de: 'Unbezahlt / variabel',
      fr: 'Non rémunéré / variable',
    };
    return {
      eyebrow: shell.eyebrow,
      denseLede,
      statTile1: {
        label: labels.tile1Label,
        valueFromCount: (c) => fmtIntLocale(c, locale),
        tone: 'accent',
      },
      statTile2: {
        label: labels.tile2Label,
        value: (snap) =>
          snap.medianSalary && snap.medianSalary > 0
            ? `${fmtChfLocale(snap.medianSalary, locale)}/${{ it: 'anno', en: 'year', de: 'Jahr', fr: 'an' }[locale]}`
            : indemnitaLabel[locale],
        tone: 'warning',
      },
      statTile3: {
        label: labels.tile3Label,
        valueFromFresh: (f) => `+${fmtIntLocale(f, locale)}`,
        tone: 'success',
      },
      primaryCtaLabel: labels.primaryCtaLabel,
      primaryCtaHref: CALCULATOR_URL[locale],
      showFeaturedJobs: true,
      showEmployerGrid: false,
      employerGridReplacement: labels.employerGridReplacement,
      featuredJobsTitle: labels.featuredJobsTitle,
    };
  }

  // contratti-lavoro-frontalieri (editorial)
  return {
    eyebrow: shell.eyebrow,
    denseLede,
    statTile1: {
      label: labels.tile1Label,
      valueFromCount: (c) => fmtIntLocale(c, locale),
      tone: 'accent',
    },
    statTile2: {
      label: labels.tile2Label,
      value: (snap) =>
        snap.medianSalary && snap.medianSalary > 0
          ? `${fmtChfLocale(snap.medianSalary, locale)}/${{ it: 'anno', en: 'year', de: 'Jahr', fr: 'an' }[locale]}`
          : '—',
      tone: 'success',
    },
    statTile3: {
      label: labels.tile3Label,
      valueFromFresh: (f) => `+${fmtIntLocale(f, locale)}`,
      tone: 'warning',
    },
    primaryCtaLabel: labels.primaryCtaLabel,
    primaryCtaHref: CALCULATOR_URL[locale],
    showFeaturedJobs: false,
    showEmployerGrid: false,
    employerGridReplacement: labels.employerGridReplacement,
  };
}

export function getCareerTemplateBShell(locale: CareerLocale): CareerTemplateBShell {
  return TEMPLATE_B_SHELL[locale];
}

export function getCareerJobBoardUrl(locale: CareerLocale): string {
  return JOB_BOARD_URL[locale];
}

export function getCareerCalculatorUrl(locale: CareerLocale): string {
  return CALCULATOR_URL[locale];
}
