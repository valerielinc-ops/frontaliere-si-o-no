/**
 * Editorial copy for the 3 nursing / healthcare SEO landings × 4 locales.
 *
 * Italian is primary (≥1.200 words per page, hand-written). EN/DE/FR are
 * condensed but complete (≥400 words each — no placeholder, no "coming
 * soon" copy). Every paragraph is an original summary of publicly
 * available sources:
 *   - CCL OSS 2024 (H+ Die Spitäler der Schweiz)
 *   - CCL Infermieri Ticino (EOC + privati convenzionati)
 *   - MEBEKO / SRK riconoscimento titoli
 *   - Ufficio Popolazione TI — permessi G/B
 *   - SECO — osservatorio salariale
 *
 * Figures are expressed as intervals or ranges; precise per-ruolo salary
 * ranges are intentionally conservative to avoid fabricated data, and are
 * flagged as "stima" / "range tipico" where appropriate.
 */

import type { NursingLocale, NursingLandingId } from './nursingLandingsData';

export interface NursingLandingSection {
  title: string;
  paragraphs: string[];
}

export interface NursingLandingFaq {
  question: string;
  answer: string;
}

export interface NursingLandingCopy {
  title: string;
  description: string;
  h1: string;
  lede: string;
  updatedLabel: string;
  breadcrumbHome: string;
  breadcrumbJobs: string;
  ctaJobs: string;
  ctaSimulator: string;
  relatedLabel: string;
  faqTitle: string;
  sections: NursingLandingSection[];
  faqs: NursingLandingFaq[];
}

// ─────────────────────────────────────────────────────────────────
// Template B per-locale shell (2026-05 redesign).
//
// The template B layout uses a 1-line dense lede + 3 stat tiles + a primary
// CTA above the fold, and pushes the editorial prose below an "Approfondisci"
// divider. The labels below are reused across all 3 nursing IDs for a given
// locale (only the numbers/values change per snapshot).
// ─────────────────────────────────────────────────────────────────

export interface NursingLandingShell {
  eyebrow: string;
  /** Pre-rendered dense-lede sentence template. */
  denseLedeTemplate: (parts: { live: number; fresh30: number; median: number | null }) => string;
  statTileLiveLabel: string;
  statTileSalaryLabel: string;
  statTileFreshLabel: string;
  statSalaryValueFmt: (n: number | null) => string;
  statFreshValueFmt: (n: number) => string;
  statLiveValueFmt: (n: number) => string;
  primaryCtaLabel: string;
  featuredJobsTitle: string;
  featuredJobsCtaAll: (n: number) => string;
  featuredJobsEmpty: string;
  employerGridTitle: string;
  approfondisciHeading: string;
  jobPostedLabel: (daysAgo: number) => string;
  jobSalaryFmt: (min: number | null, max: number | null) => string;
}

const IT_SHELL: NursingLandingShell = {
  eyebrow: 'Sanità · Ticino · 2026',
  denseLedeTemplate: ({ live, fresh30, median }) => {
    const livePart = `${live.toLocaleString('it-CH')} posizioni sanitarie indicizzate in Ticino`;
    const freshPart = `${fresh30} nuove negli ultimi 30 giorni`;
    const medianPart = median
      ? `stipendio mediano CHF ${median.toLocaleString('it-CH')} lordi all'anno`
      : 'CCL svizzero applicato integralmente';
    return `${livePart} · ${freshPart} · ${medianPart}.`;
  },
  statTileLiveLabel: 'Offerte aperte',
  statTileSalaryLabel: 'Stipendio mediano',
  statTileFreshLabel: 'Nuove (30 gg)',
  statSalaryValueFmt: (n) => (n ? `CHF ${n.toLocaleString('it-CH')}/anno` : 'CCL svizzero'),
  statFreshValueFmt: (n) => `${n} nuove`,
  statLiveValueFmt: (n) => n.toLocaleString('it-CH'),
  primaryCtaLabel: 'Calcola il tuo netto come frontaliere',
  featuredJobsTitle: 'Offerte in evidenza',
  featuredJobsCtaAll: (n) =>
    n > 0 ? `Vedi tutte le ${n.toLocaleString('it-CH')} offerte →` : 'Vedi tutte le offerte →',
  featuredJobsEmpty: 'Nessuna offerta sanitaria indicizzata in questo momento — controlla il job board completo.',
  employerGridTitle: 'Chi assume in Ticino',
  approfondisciHeading: 'Approfondisci',
  jobPostedLabel: (d) =>
    d <= 0 ? 'Pubblicata oggi' : d === 1 ? 'Pubblicata ieri' : `Pubblicata ${d} giorni fa`,
  jobSalaryFmt: (min, max) => {
    if (min && max) return `CHF ${min.toLocaleString('it-CH')}–${max.toLocaleString('it-CH')}/anno`;
    if (min) return `Da CHF ${min.toLocaleString('it-CH')}/anno`;
    if (max) return `Fino a CHF ${max.toLocaleString('it-CH')}/anno`;
    return '';
  },
};

const EN_SHELL: NursingLandingShell = {
  eyebrow: 'Healthcare · Ticino · 2026',
  denseLedeTemplate: ({ live, fresh30, median }) => {
    const livePart = `${live.toLocaleString('en-CH')} healthcare openings indexed in Ticino`;
    const freshPart = `${fresh30} new in the last 30 days`;
    const medianPart = median
      ? `median CHF ${median.toLocaleString('en-CH')} gross per year`
      : 'Swiss collective agreement applies in full';
    return `${livePart} · ${freshPart} · ${medianPart}.`;
  },
  statTileLiveLabel: 'Open positions',
  statTileSalaryLabel: 'Median salary',
  statTileFreshLabel: 'New (30 days)',
  statSalaryValueFmt: (n) => (n ? `CHF ${n.toLocaleString('en-CH')}/year` : 'Swiss CCL'),
  statFreshValueFmt: (n) => `${n} new`,
  statLiveValueFmt: (n) => n.toLocaleString('en-CH'),
  primaryCtaLabel: 'Calculate your cross-border net salary',
  featuredJobsTitle: 'Featured openings',
  featuredJobsCtaAll: (n) =>
    n > 0 ? `See all ${n.toLocaleString('en-CH')} openings →` : 'See all openings →',
  featuredJobsEmpty: 'No indexed healthcare openings right now — check the full job board.',
  employerGridTitle: 'Who is hiring in Ticino',
  approfondisciHeading: 'Learn more',
  jobPostedLabel: (d) =>
    d <= 0 ? 'Posted today' : d === 1 ? 'Posted yesterday' : `Posted ${d} days ago`,
  jobSalaryFmt: (min, max) => {
    if (min && max) return `CHF ${min.toLocaleString('en-CH')}–${max.toLocaleString('en-CH')}/year`;
    if (min) return `From CHF ${min.toLocaleString('en-CH')}/year`;
    if (max) return `Up to CHF ${max.toLocaleString('en-CH')}/year`;
    return '';
  },
};

const DE_SHELL: NursingLandingShell = {
  eyebrow: 'Gesundheit · Tessin · 2026',
  denseLedeTemplate: ({ live, fresh30, median }) => {
    const livePart = `${live.toLocaleString('de-CH')} Gesundheitsstellen im Tessin indexiert`;
    const freshPart = `${fresh30} neu in den letzten 30 Tagen`;
    const medianPart = median
      ? `Medianlohn CHF ${median.toLocaleString('de-CH')} brutto pro Jahr`
      : 'Schweizer GAV gilt vollständig';
    return `${livePart} · ${freshPart} · ${medianPart}.`;
  },
  statTileLiveLabel: 'Offene Stellen',
  statTileSalaryLabel: 'Medianlohn',
  statTileFreshLabel: 'Neu (30 Tage)',
  statSalaryValueFmt: (n) => (n ? `CHF ${n.toLocaleString('de-CH')}/Jahr` : 'Schweizer GAV'),
  statFreshValueFmt: (n) => `${n} neu`,
  statLiveValueFmt: (n) => n.toLocaleString('de-CH'),
  primaryCtaLabel: 'Grenzgänger-Nettolohn berechnen',
  featuredJobsTitle: 'Empfohlene Stellen',
  featuredJobsCtaAll: (n) =>
    n > 0 ? `Alle ${n.toLocaleString('de-CH')} Stellen ansehen →` : 'Alle Stellen ansehen →',
  featuredJobsEmpty: 'Derzeit keine indexierten Gesundheitsstellen — siehe vollständige Stellenbörse.',
  employerGridTitle: 'Wer im Tessin einstellt',
  approfondisciHeading: 'Mehr erfahren',
  jobPostedLabel: (d) =>
    d <= 0 ? 'Heute veröffentlicht' : d === 1 ? 'Gestern veröffentlicht' : `Vor ${d} Tagen veröffentlicht`,
  jobSalaryFmt: (min, max) => {
    if (min && max) return `CHF ${min.toLocaleString('de-CH')}–${max.toLocaleString('de-CH')}/Jahr`;
    if (min) return `Ab CHF ${min.toLocaleString('de-CH')}/Jahr`;
    if (max) return `Bis CHF ${max.toLocaleString('de-CH')}/Jahr`;
    return '';
  },
};

const FR_SHELL: NursingLandingShell = {
  eyebrow: 'Santé · Tessin · 2026',
  denseLedeTemplate: ({ live, fresh30, median }) => {
    const livePart = `${live.toLocaleString('fr-CH')} postes santé indexés au Tessin`;
    const freshPart = `${fresh30} nouveaux ces 30 derniers jours`;
    const medianPart = median
      ? `salaire médian CHF ${median.toLocaleString('fr-CH')} brut par an`
      : 'CCT suisse appliquée intégralement';
    return `${livePart} · ${freshPart} · ${medianPart}.`;
  },
  statTileLiveLabel: 'Postes ouverts',
  statTileSalaryLabel: 'Salaire médian',
  statTileFreshLabel: 'Nouveaux (30 j)',
  statSalaryValueFmt: (n) => (n ? `CHF ${n.toLocaleString('fr-CH')}/an` : 'CCT suisse'),
  statFreshValueFmt: (n) => `${n} nouveaux`,
  statLiveValueFmt: (n) => n.toLocaleString('fr-CH'),
  primaryCtaLabel: 'Calculer votre net frontalier',
  featuredJobsTitle: 'Offres mises en avant',
  featuredJobsCtaAll: (n) =>
    n > 0 ? `Voir les ${n.toLocaleString('fr-CH')} offres →` : 'Voir toutes les offres →',
  featuredJobsEmpty: 'Aucune offre santé indexée actuellement — consultez la bourse complète.',
  employerGridTitle: 'Qui recrute au Tessin',
  approfondisciHeading: 'Pour aller plus loin',
  jobPostedLabel: (d) =>
    d <= 0 ? "Publié aujourd'hui" : d === 1 ? 'Publié hier' : `Publié il y a ${d} jours`,
  jobSalaryFmt: (min, max) => {
    if (min && max) return `CHF ${min.toLocaleString('fr-CH')}–${max.toLocaleString('fr-CH')}/an`;
    if (min) return `Dès CHF ${min.toLocaleString('fr-CH')}/an`;
    if (max) return `Jusqu'à CHF ${max.toLocaleString('fr-CH')}/an`;
    return '';
  },
};

export const NURSING_LANDING_SHELLS: Record<NursingLocale, NursingLandingShell> = {
  it: IT_SHELL,
  en: EN_SHELL,
  de: DE_SHELL,
  fr: FR_SHELL,
};

/**
 * Snapshot inputs the plugin passes when rendering the page. Only counts +
 * median are needed — featured jobs are kept on the snapshot object itself.
 */
export interface NursingLandingCopySnapshot {
  liveCount: number;
  fresh30Count: number;
  medianSalaryChf: number | null;
}

/**
 * Composite copy view used by the plugin renderer. Combines the editorial
 * copy (above) with the template B shell (this block) so the plugin can
 * read every label off a single object.
 */
export interface NursingLandingComposedCopy extends NursingLandingCopy {
  shell: NursingLandingShell;
  denseLede: string;
  statLiveValue: string;
  statSalaryValue: string;
  statFreshValue: string;
  featuredJobsCtaAllLabel: string;
}

/**
 * Build the composed copy for one nursing landing × locale, with the
 * snapshot numbers already interpolated into the dense lede + stat tiles.
 */
export function buildNursingLandingCopy(
  locale: NursingLocale,
  id: NursingLandingId,
  snapshot: NursingLandingCopySnapshot = { liveCount: 0, fresh30Count: 0, medianSalaryChf: null },
): NursingLandingComposedCopy {
  const base = NURSING_LANDING_COPY[locale][id];
  const shell = NURSING_LANDING_SHELLS[locale];
  return {
    ...base,
    shell,
    denseLede: shell.denseLedeTemplate({
      live: snapshot.liveCount,
      fresh30: snapshot.fresh30Count,
      median: snapshot.medianSalaryChf,
    }),
    statLiveValue: shell.statLiveValueFmt(snapshot.liveCount),
    statSalaryValue: shell.statSalaryValueFmt(snapshot.medianSalaryChf),
    statFreshValue: shell.statFreshValueFmt(snapshot.fresh30Count),
    featuredJobsCtaAllLabel: shell.featuredJobsCtaAll(snapshot.liveCount),
  };
}

// ─────────────────────────────────────────────────────────────────
// IT — canonical (≥1.200 words per page)
// ─────────────────────────────────────────────────────────────────

const IT_NURSES: NursingLandingCopy = {
  title: 'Lavoro infermiere in Svizzera 2026: stipendi, CCL, permessi, concorsi | Frontaliere Ticino',
  description:
    'Guida completa al lavoro da infermiere in Svizzera per frontalieri e residenti: CCL applicabili, stipendio netto per esperienza, riconoscimento MEBEKO del titolo italiano, concorsi EOC, Moncucco, LIS e cliniche private. Aggiornato 2026.',
  h1: 'Lavoro infermiere in Svizzera: guida 2026 per frontalieri',
  lede: 'La Svizzera cerca infermieri e infermieri specializzati con urgenza crescente: in Ticino, il fabbisogno stimato supera le 400 nuove assunzioni all\'anno tra ospedali pubblici, cliniche private e case anziani. Questa guida spiega nel dettaglio come candidarsi da frontaliere, quali CCL si applicano, quanto si guadagna davvero e come far riconoscere il titolo italiano dal MEBEKO.',
  updatedLabel: 'Aggiornato',
  breadcrumbHome: 'Home',
  breadcrumbJobs: 'Lavoro Ticino',
  ctaJobs: 'Vedi offerte infermieri in Ticino',
  ctaSimulator: 'Calcola il tuo stipendio netto',
  relatedLabel: 'Risorse collegate',
  faqTitle: 'Domande frequenti',
  sections: [
    {
      title: 'Il contesto: infermieri introvabili in tutta la Svizzera',
      paragraphs: [
        'La carenza di infermieri è uno dei dossier più caldi della sanità svizzera: Curaviva e l\'Associazione svizzera infermiere/i (ASI-SBK) stimano che entro il 2030 serviranno oltre 70.000 nuovi professionisti della cura in tutta la Confederazione, tra diplomati HF, bachelor SUPSI e personale ausiliario. Il Cantone Ticino, per via della sua posizione di confine e della popolazione anziana sopra la media, è uno dei più colpiti: l\'Ente Ospedaliero Cantonale (EOC) pubblica continuamente bandi e molte cliniche private inseriscono incentivi al trasferimento o alla conversione del permesso.',
        'Questa domanda spinge il mercato ad aprirsi con regolarità ai candidati italiani e ai frontalieri con permesso G. Gli infermieri italiani rappresentano una quota significativa della forza lavoro ticinese — l\'Ufficio federale di statistica (UST) registra migliaia di professionisti cross-border attivi nel settore della salute — e molte realtà ticinesi hanno processi di selezione dedicati, con colloqui in italiano e accompagnamento al riconoscimento del titolo.',
      ],
    },
    {
      title: 'CCL e inquadramento: il contratto collettivo che fa la differenza',
      paragraphs: [
        'Il contratto di riferimento per gli infermieri ospedalieri in Ticino è il CCL EOC, negoziato fra l\'Ente Ospedaliero Cantonale e i sindacati (OCST, VPOD, SSP-Regione Ticino). È uno dei CCL sanitari più completi della Svizzera: regola classi salariali, progressioni biennali, indennità per turni notturni e festivi (tipicamente maggiorazioni tra il 20% e il 50%), 5 settimane di vacanza base, 6 settimane dopo i 50 anni, premio di fedeltà ogni 5 anni.',
        'Le cliniche private applicano invece il CCL Cliniche private ticinesi o contratti aziendali equivalenti. Cliniche come Moncucco (Lugano), LIS-Luganese Istituto di Sanità, Clinica Luganese Moncucco e Clinica Sant\'Anna hanno condizioni generalmente allineate all\'EOC, con qualche variabilità sulle indennità. Le case anziani e le strutture di lungodegenza applicano il CCL Case Anziani Ticino, con salari lievemente inferiori agli ospedali ma meno turni notturni e un ritmo di lavoro più prevedibile.',
        'Per chi lavora sul territorio italiano ma presta servizio in Svizzera con permesso G, il CCL svizzero si applica in toto: salario, ferie, malattia, 13a mensilità, assicurazioni sociali (AVS, AI, IPG, AD, LPP, LAINF). È una tutela molto forte rispetto ai CCNL italiani della sanità privata, che hanno minimi tabellari sensibilmente più bassi.',
      ],
    },
    {
      title: 'Stipendi infermieri in Svizzera: range per esperienza (2026)',
      paragraphs: [
        'I dati seguenti sono stime aggregate su base CCL EOC e pubblicazioni salariali dei sindacati; non sostituiscono la classe salariale specifica indicata nel contratto individuale. Gli importi sono in CHF lordi annui su 13 mensilità per un 100%.',
        'Infermiere/a SUP o DH (Diplomato HF), neoassunto, classe iniziale: circa 75.000–82.000 CHF lordi annui. Con 5 anni di esperienza si sale a 85.000–92.000 CHF. A fine carriera (oltre 20 anni), la forchetta per il ruolo di base è 100.000–110.000 CHF; specializzazioni come cure intense, anestesia, sala operatoria, oncologia aggiungono un indennità di funzione del 5–15% e portano la forchetta fine carriera a 115.000–130.000 CHF.',
        'Per OSS / OSA (vedi pagina dedicata) il range tipico è 55.000–70.000 CHF. Per capo reparto e Pflegeexperte APN, le forchette partono da 105.000 CHF e superano facilmente i 140.000 CHF in fine carriera. Notare che i netti per frontalieri dipendono fortemente dallo statuto fiscale (Vecchi vs Nuovi frontalieri, accordo 2020) e dal chilometraggio dal confine — il calcolatore stipendio del sito consente una simulazione personalizzata.',
      ],
    },
    {
      title: 'Riconoscimento del titolo italiano: la procedura MEBEKO / SRK',
      paragraphs: [
        'Per esercitare in Svizzera come infermiere/a con diploma italiano serve il riconoscimento dell\'equipollenza. L\'ente competente è la Croce Rossa Svizzera (CRS / SRK), che opera su delega della Commissione delle professioni mediche (MEBEKO) dell\'Ufficio federale della sanità pubblica (UFSP).',
        'La pratica richiede: diploma originale legalizzato, programma degli studi tradotto in italiano/tedesco/francese, ore di tirocinio certificate, certificato di buona condotta. La CRS valuta l\'equivalenza ed eventualmente chiede misure di compensazione — modulo di adattamento in struttura svizzera da 3 a 12 mesi oppure esame attitudinale — se il percorso italiano risulta non pienamente conforme alla formazione HF svizzera.',
        'Tempistiche realistiche: 4–9 mesi dall\'inoltro completo della pratica al rilascio del riconoscimento. È possibile iniziare a lavorare con contratto sotto supervisione in alcune cliniche durante la procedura, ma la gran parte dei datori pretende il riconoscimento definitivo prima dell\'assunzione a tempo indeterminato.',
      ],
    },
    {
      title: 'Permesso G vs permesso B: cosa scegliere da infermiere',
      paragraphs: [
        'La scelta fra permesso G (frontaliere, residenza in Italia, rientro settimanale) e permesso B (residente in Svizzera) incide direttamente su stipendio netto, contributi e stile di vita. Con il permesso G si paga l\'imposta alla fonte in Svizzera (accordo 2020 per i nuovi frontalieri) e si presenta la dichiarazione in Italia; con il permesso B si è residenti fiscali in Svizzera a tutti gli effetti e non c\'è doppia imposizione.',
        'Per un infermiere a 85.000 CHF lordi il netto da nuovo frontaliere con residenza a oltre 20 km dal confine è simile a quello di un residente B, ma con accesso ad altri benefici: tariffe LAMal/malattia evitate (perché il frontaliere può optare per l\'assicurazione italiana), franchigie più flessibili, deducibilità di alcune spese in Italia. Al contrario, il permesso B apre alla 2° pilastro (LPP), al contributo datoriale pieno e all\'accesso facilitato a mutui svizzeri: un infermiere senior con aspirazioni di acquisto casa a Lugano trova più vantaggi nel permesso B.',
      ],
    },
    {
      title: 'Dove candidarsi: le principali strutture ticinesi',
      paragraphs: [
        'EOC — Ente Ospedaliero Cantonale (sedi di Bellinzona, Locarno, Lugano, Mendrisio, Faido): è il principale datore di lavoro sanitario del Cantone. Pubblica bandi continui con codice concorso; le candidature si inviano tramite il portale EOC e il processo include colloquio HR + colloquio con capoclinica + prova pratica in reparto.',
        'Clinica Luganese Moncucco e Clinica Sant\'Anna (Sorengo): cliniche private di riferimento con attenzione particolare alla cura dei pazienti internazionali. Offrono contratti di durata e part-time flessibili, apprezzati da chi sta gestendo il trasferimento dall\'Italia.',
        'LIS — Luganese Istituto di Sanità e Fondazione Ticino Cuore: la prima è un polo privato che integra ricovero e ambulatorio; la seconda è un centro cardiologico di eccellenza. Entrambi cercano regolarmente infermieri specializzati (cardiologia, unità coronarica, riabilitazione).',
        'Case anziani e strutture sociosanitarie: Pro Senectute, Fondazione Opera Don Guanella, Casa San Giorgio Brissago e decine di altre RSA del Mendrisiotto e Luganese offrono posizioni con orari più compatibili con la vita familiare, molto richieste dai frontalieri.',
      ],
    },
    {
      title: 'Concorsi EOC e selezioni ricorrenti: come non perderli',
      paragraphs: [
        'EOC pubblica bandi mensili sul proprio portale carriere (eoc.ch/lavoro); le date di scadenza sono tipicamente fisse (15 o 30 del mese) e i concorsi per ruoli infermieristici sono aperti sia a candidati CH che frontalieri. Per alcune posizioni molto richieste (cure intense Civico Lugano, pronto soccorso Bellinzona), EOC organizza Assessment Day in cui i candidati sostengono colloqui + prove in una sola giornata.',
        'Per gli infermieri italiani è fondamentale preparare un CV "svizzero": lingua italiana ma formato Europass o Swissstandard, fotografia, elenco esplicito di diplomi e ore di tirocinio, referenze di precedenti colleghi. Il sito Frontaliere Ticino pubblica aggiornamenti settimanali sui bandi attivi e offre un job alert per non perdere le scadenze.',
      ],
    },
    {
      title: 'Differenze con l\'Italia: orari, gerarchia, responsabilità',
      paragraphs: [
        'Chi passa dal SSN italiano alla sanità svizzera nota subito alcune differenze strutturali: l\'orario settimanale è 40–42 ore (contro 36 in Italia), ma i turni sono gestiti con rotazioni più prevedibili e il rispetto delle pause è molto rigoroso. La gerarchia è più piatta: un infermiere SUP ha autonomia decisionale maggiore su valutazioni cliniche e gestione del paziente, in linea con la formazione Bachelor svizzera.',
        'Il rapporto con il medico è più paritario, le consegne sono strutturate e documentate; la cartella clinica elettronica è diffusa (sistema KIS, Phoenix, Clinicom). Dal punto di vista retributivo, il guadagno netto supera tipicamente del 40–70% l\'omologo italiano, specialmente per infermieri giovani. Attenzione però ai costi: assicurazione malattia LAMal (solo per B), tasse municipali, affitto in Ticino elevato rispetto alla provincia di Como o Varese.',
      ],
    },
  ],
  faqs: [
    {
      question: 'Posso lavorare da infermiera in Svizzera con il diploma italiano?',
      answer:
        'Sì, ma devi ottenere il riconoscimento dell\'equipollenza dalla Croce Rossa Svizzera (CRS). La procedura dura in media 4-9 mesi; se il percorso italiano non corrisponde pienamente al bachelor svizzero, la CRS può chiedere un modulo di adattamento (3-12 mesi in struttura) o un esame attitudinale. Molti datori ticinesi offrono contratti-ponte durante la pratica.',
    },
    {
      question: 'Quanto guadagna un infermiere in Ticino nel 2026?',
      answer:
        'In base al CCL EOC, un infermiere SUP neoassunto percepisce tra 75.000 e 82.000 CHF lordi annui (13 mensilità, 100%). Con 5 anni di esperienza si arriva a 85.000-92.000 CHF, a fine carriera a 100.000-110.000 CHF. Specializzazioni come cure intense o anestesia aggiungono un\'indennità di funzione e portano la forchetta a 115.000-130.000 CHF.',
    },
    {
      question: 'Meglio permesso G o permesso B per un infermiere italiano?',
      answer:
        'Dipende dal progetto di vita. Il permesso G mantiene la residenza in Italia, evita la LAMal svizzera ma obbliga alla dichiarazione in Italia. Il permesso B è più adatto a chi vuole comprare casa in Ticino e massimizzare il 2° pilastro LPP. Per un infermiere che pianifica di restare 5+ anni, il permesso B è quasi sempre più conveniente a parità di lordo.',
    },
    {
      question: 'Quali ospedali ticinesi assumono di più nel 2026?',
      answer:
        'L\'Ente Ospedaliero Cantonale (EOC) è il principale datore, con bandi aperti quasi ogni mese nelle sedi di Bellinzona, Locarno, Lugano Civico e Mendrisio. Seguono la Clinica Luganese Moncucco, la Clinica Sant\'Anna, il LIS e la Fondazione Ticino Cuore per le specializzazioni cardiologiche.',
    },
    {
      question: 'Posso lavorare come infermiera senza parlare tedesco?',
      answer:
        'In Ticino sì, l\'italiano è la lingua di lavoro. In Svizzera tedesca o francese l\'italiano non basta: servono almeno B2 tedesco o francese a seconda della regione. Alcune strutture ticinesi di confine (Mendrisio, Chiasso) preferiscono anche inglese o tedesco a livello base per la relazione con pazienti internazionali.',
    },
    {
      question: 'Come presento la candidatura a EOC?',
      answer:
        'Tutte le candidature passano dal portale eoc.ch/lavoro. Serve un CV in italiano in formato Swissstandard (foto, diplomi, ore tirocinio, referenze), lettera di motivazione e copia dei titoli. Il processo prevede colloquio HR + colloquio tecnico con il capoclinica; per alcune posizioni è previsto un Assessment Day con prova pratica in reparto.',
    },
    {
      question: 'Il CCL infermieri prevede indennità per i turni notturni?',
      answer:
        'Sì, il CCL EOC e i CCL delle cliniche private prevedono maggiorazioni che vanno tipicamente dal 20% al 50% del salario orario per i turni notturni, festivi e domenicali. Chi fa molte notti può incrementare il netto annuo di 6.000-10.000 CHF rispetto al salario base.',
    },
    {
      question: 'Quanto tempo impiega la procedura CRS per il riconoscimento?',
      answer:
        'Il tempo standard è 4-6 mesi se il dossier è completo alla prima presentazione. Se la CRS richiede un modulo di adattamento la procedura si allunga fino a 12-18 mesi complessivi. Si consiglia di avviare la pratica prima di iniziare le candidature, così si arriva al colloquio con il riconoscimento già rilasciato o in fase avanzata.',
    },
  ],
};

const IT_OSS: NursingLandingCopy = {
  title: 'Lavoro OSS in Svizzera 2026: stipendi, CCL OSS, corsi e concorsi | Frontaliere Ticino',
  description:
    'Guida al lavoro da OSS (operatore socio sanitario) in Svizzera per frontalieri: CCL OSS 2024, stipendio netto, riconoscimento del titolo italiano, differenze fra OSS / OSA / OS-AP, dove candidarsi in Ticino e nelle case anziani.',
  h1: 'Lavoro OSS in Svizzera: guida 2026 per operatori socio sanitari',
  lede: 'Gli OSS (operatori socio sanitari) sono la categoria sanitaria più richiesta in Svizzera dopo gli infermieri: case anziani, ospedali e servizi di cura a domicilio (SACD) in Ticino cercano continuamente personale, con ingresso possibile anche per frontalieri con diploma italiano riconosciuto. Questa guida spiega il CCL OSS applicabile, gli stipendi realistici e come far valere il proprio titolo.',
  updatedLabel: 'Aggiornato',
  breadcrumbHome: 'Home',
  breadcrumbJobs: 'Lavoro Ticino',
  ctaJobs: 'Offerte OSS in case anziani',
  ctaSimulator: 'Calcola il tuo stipendio netto',
  relatedLabel: 'Risorse collegate',
  faqTitle: 'Domande frequenti',
  sections: [
    {
      title: 'Chi è l\'OSS in Svizzera e dove lavora',
      paragraphs: [
        'In Svizzera esistono tre figure sovrapponibili all\'OSS italiano: l\'OSA (Operatore/trice socioassistenziale) con formazione AFC biennale, l\'OSS-AFC (Operatore/trice Socio Sanitario/a con attestato federale di capacità, tre anni di formazione duale) e l\'Ausiliario/a di cura con formazione breve Croce Rossa. L\'OSS italiano è tipicamente equiparato all\'OSS-AFC svizzero dopo valutazione della Croce Rossa Svizzera; chi ha soltanto un attestato di qualifica regionale italiana rientra spesso nel profilo Ausiliario e deve completare la formazione.',
        'Le strutture che assumono più OSS sono le case anziani (CAT) — Pro Senectute, Fondazione Diamante, Casa per Anziani Cigno Bianco, Casa San Giorgio Brissago, Opera Don Guanella — seguite dai servizi di cura a domicilio (SACD / ALVAD / SCuDo) e dagli ospedali EOC che impiegano OSS in supporto agli infermieri nei reparti di medicina, geriatria e riabilitazione.',
      ],
    },
    {
      title: 'CCL OSS 2024: cosa è cambiato e cosa si applica',
      paragraphs: [
        'Il CCL di riferimento per le case anziani ticinesi è il "Contratto collettivo di lavoro per il settore socio-sanitario — Case per anziani del Cantone Ticino", rinnovato nell\'ottobre 2024. Le principali novità: aumento dei minimi salariali (+2,5% medio rispetto al 2022), introduzione di un premio di funzione per OSS che coordinano piccoli team, estensione del diritto a 5 settimane di vacanza anche nei primi 5 anni, maggiorazione del 30% per turni notturni e festivi.',
        'Per le strutture OSS attive nei SACD si applica il CCL servizi a domicilio (Spitex) con minimi leggermente più bassi ma indennità di trasferta e auto aziendale. Negli ospedali EOC si applica il CCL EOC, con classi salariali dedicate per OSS-AFC e progressione biennale.',
      ],
    },
    {
      title: 'Stipendi OSS in Svizzera: range per struttura (2026)',
      paragraphs: [
        'Gli importi sono CHF lordi annui su 13 mensilità per un 100%, sono stime sui minimi CCL e possono variare di ±5% a seconda della singola struttura.',
        'OSS in casa anziani (CCL CAT Ticino 2024): neoassunto tra 55.000 e 60.000 CHF; a 5 anni 62.000-67.000 CHF; a fine carriera (oltre 20 anni) 72.000-78.000 CHF. OSS in SACD / servizi a domicilio: neoassunto 54.000-58.000 CHF, fine carriera 70.000-75.000 CHF, con integrazione trasferta chilometrica.',
        'OSS in ospedale EOC: generalmente 2.000-4.000 CHF sopra il CCL CAT, grazie al turno ospedaliero. Notare che maggiorazioni per turni notturni (30%), festivi (50%) e mancato preavviso sono pagate a parte e possono aggiungere 5.000-9.000 CHF annui a chi lavora molto sulle rotazioni.',
        'Rispetto al CCNL italiano per gli OSS (minimo tabellare circa 20.000-25.000 euro lordi), il differenziale svizzero è del +130-180% — un vantaggio importante anche dopo costi di trasferta e tasse alla fonte.',
      ],
    },
    {
      title: 'Riconoscimento titolo italiano: la via CRS',
      paragraphs: [
        'Come per gli infermieri, il riconoscimento passa dalla Croce Rossa Svizzera (CRS). Per gli OSS italiani con qualifica regionale, la CRS valuta il monte ore di teoria (tipicamente 1.000 ore minimo), il tirocinio pratico (tipicamente 1.000 ore) e la durata complessiva del percorso. Se il profilo è allineato al OSS-AFC svizzero (3 anni, circa 5.400 ore), si ottiene il riconoscimento senza misure; altrimenti si deve integrare con un modulo di adattamento di 6-12 mesi in casa anziani svizzera.',
        'Molti datori ticinesi accompagnano i candidati italiani durante la procedura: si parte con un contratto temporaneo come ausiliario di cura e, al termine della validazione CRS, si converte in contratto OSS-AFC a tempo indeterminato. È una via molto battuta e spesso più rapida rispetto all\'attesa del riconoscimento a candidatura chiusa.',
      ],
    },
    {
      title: 'Differenza fra OSS, OSA e Ausiliario di cura',
      paragraphs: [
        'La distinzione è formale e salariale: l\'OSS-AFC è il ruolo con maggior autonomia (rilevamento parametri vitali, somministrazione farmaci per via orale, medicazioni semplici), l\'OSA (Operatore/trice socioassistenziale) è più orientato alla cura della persona e al supporto nella vita quotidiana, senza atti tecnico-sanitari complessi. L\'Ausiliario è la figura base, con formazione Croce Rossa di 120 ore — utile come ingresso ma con salari 15-25% inferiori all\'OSS-AFC.',
        'Per un operatore italiano con esperienza è importante chiedere esplicitamente al datore di lavoro quale profilo verrà applicato in contratto, perché ha impatto diretto su stipendio, mansioni e progressione di carriera. La CRS rilascia il titolo, ma la scelta del ruolo contrattuale è del datore.',
      ],
    },
    {
      title: 'Dove candidarsi: case anziani e SACD ticinesi',
      paragraphs: [
        'Le 67 case anziani (CAT) del Cantone Ticino sono il bacino principale. I poli più grandi sono: Pro Senectute Ticino e Moesano (più residenze sul territorio); Fondazione Diamante (Mendrisio); Casa San Giorgio (Brissago); Casa Opera Don Guanella (Balerna); Casa per Anziani Cigno Bianco (Bellinzona). Molte pubblicano bandi sul proprio sito e sul portale dell\'Associazione case anziani del Cantone Ticino (ADiCASI).',
        'I servizi SACD / ALVAD / SCuDo operano invece sul territorio: il SACD Luganese, SACD Mendrisiotto, SACD Bellinzona e Tre Valli, SACD Locarnese. Offrono lavoro itinerante con auto aziendale e sono molto apprezzati da chi preferisce evitare i turni notturni della casa anziani. Gli ospedali EOC pubblicano bandi OSS-AFC tipicamente mensili, concentrati sui reparti di medicina interna, geriatria, riabilitazione e pediatria.',
      ],
    },
    {
      title: 'Orari, turni e condizioni di lavoro',
      paragraphs: [
        'In casa anziani l\'orario settimanale base è 42 ore su 5 giorni, con turni di 8 o 12 ore e rotazione che include sabati, domeniche e 1-2 notti al mese. Le ferie base sono 5 settimane (6 dopo i 50 anni, 7 dopo i 60). La malattia è pagata al 100% per i primi 2 anni (copertura assicurativa del datore), con estensione fino a 720 giorni in alcuni CCL.',
        'Nei SACD l\'orario è diurno nel 90% dei casi, con pochi turni notturni (solo servizi urgenti). Le pause sono protette dalla LTr (Legge sul lavoro): minimo 30 minuti ogni 7,5 ore, minimo 11 ore consecutive di riposo tra un turno e l\'altro. Gli straordinari devono essere compensati entro l\'anno successivo o pagati con maggiorazione del 25%.',
      ],
    },
    {
      title: 'Permesso G, fiscalità e valore netto per un OSS',
      paragraphs: [
        'Per un OSS frontaliere con stipendio 60.000 CHF lordi, il netto stimato con nuovo accordo 2020 e residenza oltre 20 km dal confine si aggira tra 46.000 e 50.000 CHF all\'anno, considerando ritenuta alla fonte e dichiarazione in Italia. È significativamente più alto del netto medio di un OSS italiano (~17.000-20.000 euro per 13 mensilità).',
        'La scelta del permesso B ha senso se si valuta un trasferimento stabile: in quel caso si accede alla 2° pilastro LPP e si evita la doppia dichiarazione, ma bisogna pagare l\'assicurazione malattia LAMal (5.000-6.000 CHF/anno per un adulto, a seconda del Cantone). Il nostro calcolatore stipendio simula entrambi gli scenari con i parametri del contratto specifico.',
      ],
    },
  ],
  faqs: [
    {
      question: 'Il mio attestato OSS italiano vale in Svizzera?',
      answer:
        'Non automaticamente: devi inviare un dossier alla Croce Rossa Svizzera (CRS) che valuta ore di teoria, tirocinio e programma. Se il percorso italiano è allineato all\'OSS-AFC (3 anni, ~5.400 ore) il riconoscimento è diretto; altrimenti si chiede un modulo di adattamento di 6-12 mesi.',
    },
    {
      question: 'Quanto guadagna un OSS in Ticino nel 2026?',
      answer:
        'In casa anziani, secondo il CCL CAT 2024: 55.000-60.000 CHF lordi annui per un neoassunto; 62.000-67.000 a 5 anni; 72.000-78.000 a fine carriera. In ospedale EOC si aggiungono 2.000-4.000 CHF di differenziale. Le maggiorazioni per turni notturni/festivi possono aggiungere 5.000-9.000 CHF.',
    },
    {
      question: 'Posso lavorare come OSS da frontaliere con permesso G?',
      answer:
        'Sì. Il permesso G è compatibile con qualsiasi ruolo sanitario purché il datore di lavoro sia svizzero e il lavoro sia svolto in Svizzera. Devi rientrare in Italia almeno una volta a settimana. Il CCL svizzero si applica integralmente: stipendio, ferie, malattia, AVS/AI/IPG, LPP (solo per contratti >8 ore/settimana).',
    },
    {
      question: 'Qual è la differenza fra OSS, OSA e Ausiliario di cura?',
      answer:
        'L\'OSS-AFC ha 3 anni di formazione e maggiore autonomia (parametri vitali, farmaci orali, medicazioni). L\'OSA ha 2 anni AFC ed è orientato al supporto quotidiano senza atti sanitari complessi. L\'Ausiliario CRS ha 120 ore di formazione e salari 15-25% più bassi; è spesso un punto di ingresso per chi aspetta il riconoscimento OSS-AFC.',
    },
    {
      question: 'Quali sono le case anziani che assumono di più?',
      answer:
        'Pro Senectute Ticino e Moesano, Fondazione Diamante, Casa San Giorgio Brissago, Casa Opera Don Guanella Balerna e Casa per Anziani Cigno Bianco Bellinzona pubblicano bandi quasi ogni mese. Il portale ADiCASI aggrega molte delle offerte aperte.',
    },
    {
      question: 'Posso iniziare a lavorare come Ausiliario mentre aspetto il riconoscimento OSS?',
      answer:
        'Sì, è una prassi molto diffusa: il datore fa un contratto temporaneo come Ausiliario di cura. Al termine della validazione CRS, il contratto viene aggiornato a OSS-AFC con adeguamento retroattivo della classe salariale in molte strutture.',
    },
    {
      question: 'Il CCL prevede maggiorazioni per i turni?',
      answer:
        'Sì: il CCL CAT 2024 prevede +30% per turni notturni (20-06), +50% per domenicali e festivi, straordinario con +25% o compensazione in ore. Chi accetta molte rotazioni può incrementare il netto annuo di 6.000-9.000 CHF.',
    },
    {
      question: 'È meglio SACD o casa anziani per un OSS italiano?',
      answer:
        'SACD (servizio a domicilio) è preferibile se vuoi turni diurni, auto aziendale e autonomia sul territorio. Casa anziani è meglio se preferisci ritmi più strutturati, meno trasferte e possibilità di specializzarti nella cura geriatrica. Gli stipendi base sono simili, ma la casa anziani ha più maggiorazioni per notti e festivi.',
    },
  ],
};

const IT_HEALTHCARE_TICINO: NursingLandingCopy = {
  title: 'Lavoro sanitario in Ticino 2026: ospedali, cliniche, case anziani | Frontaliere Ticino',
  description:
    'Hub del lavoro sanitario in Ticino: EOC, Clinica Luganese Moncucco, LIS, Clinica Sant\'Anna, Fondazione Ticino Cuore, case anziani. Ruoli richiesti, stipendi, CCL, riconoscimento titoli italiani, come candidarsi e concorsi ricorrenti.',
  h1: 'Lavoro sanitario in Ticino: hub 2026 degli ospedali e delle cliniche',
  lede: 'Il Canton Ticino è uno dei mercati sanitari più dinamici della Svizzera: oltre 20.000 persone lavorano nella salute fra ospedali EOC, cliniche private convenzionate, case anziani e servizi a domicilio. Questa pagina è l\'hub per chi cerca lavoro sanitario in Ticino — infermieri, OSS, medici, terapisti — e aggrega stipendi, strutture, concorsi ricorrenti e procedure di riconoscimento del titolo.',
  updatedLabel: 'Aggiornato',
  breadcrumbHome: 'Home',
  breadcrumbJobs: 'Lavoro Ticino',
  ctaJobs: 'Tutte le offerte sanitarie in Ticino',
  ctaSimulator: 'Calcola il tuo stipendio netto',
  relatedLabel: 'Risorse collegate',
  faqTitle: 'Domande frequenti',
  sections: [
    {
      title: 'La mappa del settore: chi assume in Ticino',
      paragraphs: [
        'Il sistema sanitario ticinese è organizzato intorno a quattro grandi macro-attori: l\'Ente Ospedaliero Cantonale (EOC), le cliniche private convenzionate, le case anziani e i servizi di cura a domicilio (SACD). L\'EOC gestisce 5 sedi pubbliche — Bellinzona, Locarno, Lugano Civico, Mendrisio e Faido — con circa 4.600 collaboratori; è il più grande datore di lavoro del Cantone, con contratti che seguono il CCL EOC e una governance chiara.',
        'Le cliniche private hanno peso significativo: Clinica Luganese Moncucco, Clinica Sant\'Anna Sorengo, Clinica Ars Medica Gravesano, Clinica Hildebrand Brissago, LIS Luganese Istituto di Sanità coprono chirurgia, riabilitazione, riparazione ortopedica e medicina ambulatoriale. Le case anziani (67 strutture, CCL CAT) e i SACD (ALVAD, SCuDo, SACD Luganese) coprono il lungodegenza e la cura domiciliare. Infine, la Fondazione Ticino Cuore (cardiologia, educazione sanitaria) e diversi centri terapeutici completano il quadro.',
      ],
    },
    {
      title: 'I ruoli più richiesti nel 2026',
      paragraphs: [
        'Infermieri SUP / HF: la categoria numericamente più richiesta; l\'EOC pubblica bandi continui, con accento su cure intense, pronto soccorso, oncologia e ostetricia. OSS-AFC: richiesti soprattutto in casa anziani e nei reparti ospedalieri di geriatria e riabilitazione. Medici assistenti e medici specialisti: forte carenza in medicina interna, anestesia, radiologia, medicina d\'urgenza; per gli italiani, il riconoscimento via MEBEKO consente l\'accesso al sistema FMH.',
        'Fisioterapisti, ergoterapisti, logopedisti: profili richiesti in cliniche di riabilitazione (Hildebrand, LIS) e nei SACD. Tecnici di radiologia medica (TRM), assistenti di studio medico (MPA), ostetriche/i, psicologi e psicoterapeuti: tutti ruoli con carenza segnalata dall\'Ufficio cantonale di statistica.',
        'Ruoli trasversali non sanitari: portineria, hostess sociale, cucina sanitaria, manutenzione biomedicale — spesso aperti anche a frontalieri con profili tecnici italiani.',
      ],
    },
    {
      title: 'Stipendi nel settore sanitario ticinese (2026)',
      paragraphs: [
        'Tutti gli importi sono CHF lordi annui su 13 mensilità per un 100%, basati su CCL 2024-2026 ed esperienza del mercato. Sono stime: il contratto individuale del singolo datore ha precedenza.',
        'Infermiere SUP EOC: 75.000-82.000 (start) → 100.000-110.000 (fine carriera base); OSS-AFC in casa anziani: 55.000-78.000; Fisioterapista SUP: 70.000-95.000; TRM: 80.000-105.000; Ostetrica/o EOC: 82.000-115.000; Medico assistente anno 1: 95.000-105.000; Medico caposervizio: 200.000-280.000; Medico primario di reparto: 280.000-450.000.',
        'Differenza con l\'Italia: il netto finale di un infermiere frontaliere è tipicamente +40-70%, di un fisioterapista +60-100%, di un medico ospedaliero +80-130%. Il vantaggio aumenta nei ruoli specialistici e con gli anni di anzianità.',
      ],
    },
    {
      title: 'CCL in vigore: come orientarsi',
      paragraphs: [
        'Quattro CCL principali coprono la quasi totalità del settore: CCL EOC (ospedali pubblici); CCL Cliniche private ticinesi (Moncucco, Sant\'Anna, LIS, Ars Medica, Hildebrand); CCL Case Anziani Cantone Ticino 2024 (67 strutture); CCL Servizi a domicilio Spitex Ticino (SACD). Ognuno regola salari, vacanze, turni, malattia, 13a, straordinari.',
        'In tutti i casi si applica la Legge federale sul lavoro (LTr) che stabilisce tetti massimi settimanali (50 ore assolute), pause obbligatorie, riposo giornaliero e settimanale. I CCL sanitari ticinesi hanno generalmente condizioni migliori dei minimi LTr e sono il punto di riferimento per le candidature.',
      ],
    },
    {
      title: 'I concorsi EOC e le selezioni ricorrenti',
      paragraphs: [
        'EOC pubblica bandi con scadenze tipicamente al 15 e al 30 di ogni mese. Per i ruoli infermieristici e OSS le candidature sono aperte sia a cittadini svizzeri sia a frontalieri con permesso G e residenti in Svizzera con permesso B. Gli Assessment Day sono usati per le posizioni più richieste (pronto soccorso, cure intense): i candidati sostengono nella stessa giornata colloquio HR, colloquio tecnico e prova pratica in reparto.',
        'Le cliniche private hanno processi più snelli: candidatura sul sito della clinica, primo colloquio HR, secondo colloquio col capoclinica. Tempo medio da candidatura a firma del contratto: 6-10 settimane. Le case anziani del gruppo Pro Senectute e Fondazione Diamante hanno bandi trimestrali aggregati sul sito ADiCASI.',
      ],
    },
    {
      title: 'Riconoscimento titoli italiani: percorso per ruolo',
      paragraphs: [
        'Infermieri e OSS: procedura via Croce Rossa Svizzera (CRS) come spiegato nelle pagine dedicate. Medici: riconoscimento MEBEKO con eventuale esame federale e iscrizione all\'Ordine dei medici cantonali. Fisioterapisti / ergoterapisti / logopedisti: MEBEKO o SRK a seconda del profilo, generalmente con valutazione di diploma italiano triennale SUP / universitario.',
        'TRM, ostetriche, dietisti: SRK. Farmacisti: MEBEKO con possibile esame. Psicologi e psicoterapeuti: PsyKo (Commissione psicologia) con valutazione specifica della formazione post-laurea e delle ore di psicoterapia supervisionata.',
      ],
    },
    {
      title: 'Vantaggi e sfide del lavoro sanitario in Ticino',
      paragraphs: [
        'I vantaggi principali sono: stipendi lordi e netti elevati (+40-130% rispetto all\'Italia a parità di ruolo); CCL forti con protezioni superiori alla media europea; ambiente di lavoro strutturato e investimenti in formazione continua; prossimità alla Lombardia (50-70 km da Milano, ideale per frontalieri); italiano come lingua di lavoro, nessuna barriera linguistica.',
        'Le sfide sono: costo della vita alto (affitti Lugano 1.200-1.800 CHF/mese per bilocale, prezzo alimentari sensibilmente più alto che in Italia); procedura di riconoscimento titolo 4-9 mesi; traffico alle dogane in orari di punta (Chiasso, Stabio, Ponte Tresa); tassa alla fonte e dichiarazione in Italia con Permesso G che richiedono pianificazione fiscale.',
      ],
    },
    {
      title: 'Come partire concretamente: 5 passi',
      paragraphs: [
        '1) Avviare subito la procedura CRS per il riconoscimento titolo — è il collo di bottiglia principale. 2) Preparare un CV "svizzero" in italiano (Swissstandard), con foto, diplomi, ore di tirocinio, referenze verificabili. 3) Scegliere il target: EOC se si punta alla stabilità pubblica, clinica privata per tempi più rapidi, casa anziani / SACD per ritmi più compatibili con la vita familiare.',
        '4) Candidarsi ai bandi attivi: il nostro portale aggrega le offerte EOC e delle cliniche private con aggiornamento quotidiano. 5) Pianificare fiscalità e logistica: simulare lo stipendio netto con permesso G vs B (il nostro calcolatore lo fa in 30 secondi), studiare i tempi di percorrenza dalla propria città italiana alle dogane, confrontare LAMal vs CMI e capire in quale CCL rientra il contratto proposto.',
      ],
    },
  ],
  faqs: [
    {
      question: 'Qual è la struttura sanitaria più grande del Ticino?',
      answer:
        'L\'Ente Ospedaliero Cantonale (EOC) con 5 sedi pubbliche a Bellinzona, Locarno, Lugano Civico, Mendrisio e Faido e circa 4.600 collaboratori. È il principale datore di lavoro sanitario del Cantone e pubblica bandi per infermieri, OSS, medici, tecnici di laboratorio e ruoli amministrativi tutto l\'anno.',
    },
    {
      question: 'Posso lavorare in Ticino come medico italiano?',
      answer:
        'Sì, dopo il riconoscimento MEBEKO (Commissione delle professioni mediche) e l\'iscrizione all\'Ordine dei medici cantonale. La procedura può includere un esame federale complementare se la specializzazione italiana non è pienamente allineata al sistema FMH svizzero.',
    },
    {
      question: 'Quali sono i ruoli sanitari più richiesti in Ticino nel 2026?',
      answer:
        'Infermieri SUP/HF (specie cure intense, pronto soccorso, oncologia), OSS-AFC in casa anziani e ospedali, medici assistenti in medicina interna e anestesia, fisioterapisti nei centri di riabilitazione, tecnici di radiologia medica, ostetriche/i e psicoterapeuti.',
    },
    {
      question: 'Le cliniche private pagano più dell\'EOC?',
      answer:
        'Non sempre. Le cliniche private hanno condizioni simili all\'EOC sui ruoli base, ma premiano di più le specializzazioni (chirurgia, riabilitazione). L\'EOC offre maggiore stabilità, progressioni automatiche biennali, 2° pilastro pubblico e benefit complementari (cassa malati aziendale convenzionata).',
    },
    {
      question: 'Quali sono i tempi di un concorso EOC?',
      answer:
        'Dalla pubblicazione del bando alla firma del contratto passano tipicamente 8-14 settimane: 2 settimane di apertura bando, 2 per screening CV, 4-6 per colloqui HR + tecnico + prova pratica, 1-2 per la chiamata finale e la negoziazione. Gli Assessment Day comprimono tutto in una giornata per ruoli urgenti.',
    },
    {
      question: 'Come si confronta lo stipendio sanitario ticinese con quello italiano?',
      answer:
        'A parità di ruolo e anzianità il netto svizzero è tipicamente +40-70% per infermieri e OSS, +60-100% per fisioterapisti e tecnici, +80-130% per medici ospedalieri. Il differenziale aumenta con gli anni di carriera e con le specializzazioni.',
    },
    {
      question: 'Servono corsi di tedesco o francese per lavorare in Ticino?',
      answer:
        'No, l\'italiano è la lingua di lavoro ufficiale. Un livello base di tedesco o inglese è apprezzato in alcune strutture (Clinica Hildebrand Brissago, pazienti internazionali), ma non è un requisito. Per spostarsi successivamente in Svizzera tedesca o francese servirebbe invece un B2 attivo.',
    },
    {
      question: 'Posso lavorare come frontaliero in qualsiasi struttura sanitaria ticinese?',
      answer:
        'Sì, con permesso G puoi lavorare in qualsiasi ospedale, clinica, casa anziani o SACD. L\'unico vincolo è rientrare in Italia almeno una volta a settimana. La procedura di permesso è gestita dal datore di lavoro tramite l\'Ufficio della migrazione del Cantone Ticino.',
    },
  ],
};

// ─────────────────────────────────────────────────────────────────
// EN — condensed (≥400 words per page)
// ─────────────────────────────────────────────────────────────────

const EN_NURSES: NursingLandingCopy = {
  title: 'Nursing Jobs in Switzerland 2026: Salary, CCL, Permits | Frontaliere Ticino',
  description:
    'Complete guide for cross-border nurses in Switzerland: applicable collective agreements, net salary by experience, Italian diploma recognition (SRK/MEBEKO), top employers (EOC, Moncucco, LIS, Sant\'Anna).',
  h1: 'Nursing jobs in Switzerland: 2026 cross-border guide',
  lede:
    'Switzerland has a chronic shortage of nurses: by 2030 over 70,000 new healthcare professionals will be needed. Ticino, the Italian-speaking canton, hires Italian nurses continuously — here is what you need to know about salary, permits and diploma recognition.',
  updatedLabel: 'Updated',
  breadcrumbHome: 'Home',
  breadcrumbJobs: 'Ticino jobs',
  ctaJobs: 'See nursing openings in Ticino',
  ctaSimulator: 'Calculate your net salary',
  relatedLabel: 'Related resources',
  faqTitle: 'Frequently asked questions',
  sections: [
    {
      title: 'Shortage and demand',
      paragraphs: [
        'Swiss nursing associations (SBK-ASI, Curaviva) estimate a demand of 70,000+ new professionals by 2030. Ticino alone opens over 400 hospital and elderly-care positions each year, and many accept Italian cross-border candidates with recognized diplomas.',
        'The main public employer is Ente Ospedaliero Cantonale (EOC), running 5 hospitals. Private clinics such as Moncucco, Sant\'Anna, LIS and the Fondazione Ticino Cuore complement the supply side.',
      ],
    },
    {
      title: 'Applicable collective agreements',
      paragraphs: [
        'EOC staff fall under the CCL EOC, one of the most comprehensive healthcare agreements in Switzerland: salary grid with biennial progression, 20-50% night/holiday surcharges, 5 weeks of vacation (6 after 50), seniority bonuses.',
        'Private clinics apply the CCL Cliniche private ticinesi; elderly-care homes use CCL CAT (renewed October 2024); home-care services use CCL Spitex Ticino. Cross-border G-permit workers are fully covered by whichever CCL applies.',
      ],
    },
    {
      title: 'Salary ranges in 2026 (CHF gross, 13 months)',
      paragraphs: [
        'Newly-hired SUP/HF nurse: 75,000-82,000 CHF/year. After 5 years: 85,000-92,000. End of career (20+ years): 100,000-110,000. Specialist add-ons for ICU, anaesthesia, oncology: 5-15% function bonus, pushing end-of-career up to 115,000-130,000.',
        'The cross-border net is typically 40-70% above the equivalent Italian net after Italian tax filing. Our net-salary simulator computes both G-permit and B-permit scenarios.',
      ],
    },
    {
      title: 'Diploma recognition: SRK / MEBEKO',
      paragraphs: [
        'Italian bachelor nurses apply to the Swiss Red Cross (SRK), on behalf of MEBEKO. The dossier includes legalized diploma, translated curriculum, clinical hours, good-standing certificate. Typical lead time: 4-9 months.',
        'If the curriculum is not fully aligned with Swiss HF, SRK may require a 3-12 month adaptation module or an aptitude test. Many Ticino employers offer bridge contracts during the procedure.',
      ],
    },
    {
      title: 'G vs B permit decision',
      paragraphs: [
        'G-permit (cross-border): residence in Italy, weekly return, Swiss source tax + Italian declaration (2020 agreement for new cross-borderers). B-permit: Swiss residence, full LAMal obligation, mandatory LPP, access to Swiss mortgages.',
        'For a nurse planning to stay 5+ years, B-permit is usually more tax-efficient at the same gross. The salary calculator on this site models both.',
      ],
    },
    {
      title: 'How to apply',
      paragraphs: [
        'EOC publishes monthly tenders on eoc.ch/lavoro with 15th and 30th deadlines. Private clinics maintain their own career portals with shorter cycles (6-10 weeks from application to contract).',
        'Prepare a Swiss-standard CV in Italian (photo, all diplomas, clinical hours, verifiable references), a targeted cover letter, and schedule the SRK procedure in parallel.',
      ],
    },
  ],
  faqs: [
    {
      question: 'Can I work as a nurse in Switzerland with an Italian degree?',
      answer:
        'Yes, after recognition by the Swiss Red Cross (SRK). The procedure takes 4-9 months. If the Italian curriculum is not fully aligned with the Swiss HF bachelor, an adaptation module (3-12 months) or an aptitude test may be required.',
    },
    {
      question: 'How much does a nurse earn in Ticino in 2026?',
      answer:
        'Under the CCL EOC: 75,000-82,000 CHF gross per year for a newly-hired SUP nurse (13 months, 100%). 85,000-92,000 after 5 years, up to 110,000 end of career for the base role. Specialisations (ICU, anaesthesia) add 5-15%.',
    },
    {
      question: 'Is G-permit or B-permit better for a nurse?',
      answer:
        'Depends on your life plan. G-permit keeps Italian residence, avoids LAMal but requires Italian tax filing. B-permit is Swiss resident, full LAMal/LPP, best for long-term stay and mortgage access. Our calculator simulates both.',
    },
    {
      question: 'Which Ticino hospitals hire the most?',
      answer:
        'EOC (Bellinzona, Locarno, Lugano Civico, Mendrisio, Faido) is the top employer with monthly tenders. Followed by Clinica Luganese Moncucco, Clinica Sant\'Anna, LIS and Fondazione Ticino Cuore for cardiology specialists.',
    },
    {
      question: 'Do I need German or French to work as a nurse in Ticino?',
      answer:
        'No — Italian is the working language. Basic German/English is appreciated in border clinics (Mendrisio, Chiasso) but not mandatory.',
    },
    {
      question: 'How do I apply to EOC?',
      answer:
        'Through the portal eoc.ch/lavoro. Swiss-standard CV in Italian (photo, diplomas, clinical hours, references), motivation letter, diploma copies. Process: HR interview + technical interview with head nurse; some roles include a practical test.',
    },
    {
      question: 'Does the CCL pay night-shift surcharges?',
      answer:
        'Yes: typically 20-50% over the hourly wage for night, Sunday and holiday shifts. Nurses with heavy rotation add 6,000-10,000 CHF net per year.',
    },
    {
      question: 'How long does the SRK procedure take?',
      answer:
        'Standard 4-6 months if the dossier is complete on first submission. Up to 12-18 months if an adaptation module is required. Start the procedure before applying to positions.',
    },
  ],
};

const EN_OSS: NursingLandingCopy = {
  title: 'Healthcare Assistant Jobs in Switzerland 2026: OSS-AFC Guide | Frontaliere Ticino',
  description:
    'Cross-border guide to healthcare assistant (OSS / OSS-AFC) jobs in Switzerland: 2024 collective agreement, salary, Italian diploma recognition, elderly-care homes and home-care services in Ticino.',
  h1: 'Healthcare assistant jobs in Switzerland: 2026 cross-border guide',
  lede:
    'Healthcare assistants (OSS-AFC) are the second most in-demand healthcare profession in Switzerland after nurses. Ticino elderly-care homes, home-care services and hospitals recruit continuously, including Italian candidates with recognized diplomas.',
  updatedLabel: 'Updated',
  breadcrumbHome: 'Home',
  breadcrumbJobs: 'Ticino jobs',
  ctaJobs: 'Elderly-care openings',
  ctaSimulator: 'Calculate your net salary',
  relatedLabel: 'Related resources',
  faqTitle: 'Frequently asked questions',
  sections: [
    {
      title: 'OSS roles in Switzerland',
      paragraphs: [
        'Switzerland has three roles overlapping with the Italian OSS: OSA (social-care assistant, 2-year AFC), OSS-AFC (healthcare assistant, 3-year dual training, ~5,400 hours) and Croix-Rouge auxiliary (120h Red Cross training).',
        'Italian OSS with regional certificates are usually evaluated by SRK against OSS-AFC benchmarks. If the hours match, direct recognition follows; otherwise a 6-12 month adaptation is requested.',
      ],
    },
    {
      title: 'Who hires healthcare assistants',
      paragraphs: [
        'The 67 Ticino elderly-care homes (CAT) are the main recruiters — Pro Senectute, Fondazione Diamante, Casa San Giorgio Brissago, Opera Don Guanella. Home-care services (ALVAD, SCuDo, SACD Luganese) are the second pillar. EOC hospitals employ OSS-AFC in medicine, geriatrics and rehab wards.',
      ],
    },
    {
      title: 'CCL CAT 2024: salary ranges',
      paragraphs: [
        'Newly-hired OSS in elderly-care: 55,000-60,000 CHF gross/year (13 months, 100%). 5 years: 62,000-67,000. End of career: 72,000-78,000. EOC hospital OSS-AFC: +2,000-4,000 over CAT. Night/holiday surcharges (30-50%) can add 5,000-9,000 CHF/year.',
        'Italian OSS minimum (CCNL): ~20,000-25,000 EUR gross. The Swiss premium is 130-180% at entry level — among the highest differentials for cross-border healthcare work.',
      ],
    },
    {
      title: 'Working conditions',
      paragraphs: [
        'Elderly-care weekly hours: 42, across 5 days, with 8h or 12h shifts and monthly nights. 5 weeks of vacation, sickness paid 100% for 2 years (employer insurance). Home-care services are daytime-only in 90% of cases with company car and kilometric allowance.',
        'Federal labor law (LTr) guarantees 11h minimum daily rest, 30-min break every 7.5h, and overtime compensation (+25% or time in lieu).',
      ],
    },
    {
      title: 'G-permit net salary and fiscal notes',
      paragraphs: [
        'For a G-permit OSS on 60,000 CHF gross (residence over 20km from border), the estimated net is 46,000-50,000 CHF/year after source tax and Italian declaration — vastly above the Italian equivalent.',
        'B-permit makes sense for long-term relocation: full LPP pension access, Swiss mortgage eligibility, but full LAMal cost (5,000-6,000 CHF/year).',
      ],
    },
    {
      title: 'How to apply',
      paragraphs: [
        'Italian candidates usually start with a temporary auxiliary contract while SRK validates the diploma; upon validation the contract converts to OSS-AFC with retroactive adjustments in many structures.',
        'ADiCASI aggregates most open tenders from Ticino elderly-care homes. EOC portal publishes monthly OSS-AFC tenders.',
      ],
    },
  ],
  faqs: [
    {
      question: 'Is my Italian OSS certificate valid in Switzerland?',
      answer:
        'Not automatically. The Swiss Red Cross (SRK) evaluates theory hours, internship hours and curriculum. If aligned to OSS-AFC (~5,400 hours), direct recognition; otherwise a 6-12 month adaptation module.',
    },
    {
      question: 'How much does an OSS earn in Ticino in 2026?',
      answer:
        'Under CCL CAT 2024: 55,000-60,000 CHF/year for newly-hired in elderly care, 62,000-67,000 at 5 years, 72,000-78,000 end of career. Hospital EOC adds 2,000-4,000. Night/holiday surcharges add 5,000-9,000/year.',
    },
    {
      question: 'Can I work as OSS with a G-permit?',
      answer:
        'Yes. G-permit allows any healthcare role with Swiss employers. Weekly return to Italy required. Full CCL coverage (salary, vacation, sickness, AVS/AI, LPP above 8h/week).',
    },
    {
      question: 'What is the difference between OSS, OSA and Auxiliary?',
      answer:
        'OSS-AFC: 3-year training, full clinical scope (vitals, oral meds, dressings). OSA: 2-year AFC, social-care focus without complex acts. Auxiliary: 120h Red Cross, entry-level salary 15-25% below OSS-AFC.',
    },
    {
      question: 'Which elderly-care homes hire the most?',
      answer:
        'Pro Senectute, Fondazione Diamante, Casa San Giorgio Brissago, Opera Don Guanella Balerna, Casa Cigno Bianco Bellinzona. ADiCASI portal aggregates most open positions.',
    },
    {
      question: 'Can I start as an Auxiliary while waiting for OSS recognition?',
      answer:
        'Yes, this is common practice. Upon SRK validation the contract converts to OSS-AFC, sometimes with retroactive salary adjustment.',
    },
    {
      question: 'Does CCL pay shift surcharges?',
      answer:
        'Yes: +30% for nights (20-06), +50% for Sundays and holidays, overtime +25% or compensation in time. Heavy rotation can add 6,000-9,000 CHF/year.',
    },
    {
      question: 'Elderly-care or home-care: which is better for Italian OSS?',
      answer:
        'Home-care (SACD) is preferable for daytime work, company car, territory autonomy. Elderly-care offers more structured rhythms, geriatric specialization and higher night/holiday surcharges.',
    },
  ],
};

const EN_HEALTHCARE_TICINO: NursingLandingCopy = {
  title: 'Healthcare Jobs in Ticino 2026: Hospitals, Clinics, Nursing Homes | Frontaliere Ticino',
  description:
    'Ticino healthcare jobs hub: EOC hospitals, Clinica Luganese Moncucco, LIS, Clinica Sant\'Anna, Fondazione Ticino Cuore, elderly-care homes. Roles, salaries, agreements, Italian diploma recognition.',
  h1: 'Healthcare jobs in Ticino: 2026 hospitals and clinics hub',
  lede:
    'Canton Ticino hosts one of the most dynamic healthcare markets in Switzerland: over 20,000 people work in health between EOC hospitals, private clinics, elderly-care homes and home-care services. This hub aggregates salaries, roles and recurring tenders.',
  updatedLabel: 'Updated',
  breadcrumbHome: 'Home',
  breadcrumbJobs: 'Ticino jobs',
  ctaJobs: 'All Ticino healthcare openings',
  ctaSimulator: 'Calculate your net salary',
  relatedLabel: 'Related resources',
  faqTitle: 'Frequently asked questions',
  sections: [
    {
      title: 'Sector map',
      paragraphs: [
        'Four macro-actors dominate: EOC (5 public hospitals, ~4,600 employees); private clinics (Moncucco, Sant\'Anna, LIS, Ars Medica, Hildebrand); 67 elderly-care homes under the ADiCASI network; home-care services (ALVAD, SCuDo, SACD Luganese).',
        'Foundation Ticino Cuore (cardiology) and various therapy centers complete the picture. The sector grew 8% over the last 5 years and keeps expanding.',
      ],
    },
    {
      title: 'Most-requested roles in 2026',
      paragraphs: [
        'SUP/HF nurses (ICU, ER, oncology, obstetrics), OSS-AFC in elderly-care and hospital wards, assistant physicians in internal medicine and anaesthesia, physiotherapists in rehab centers (Hildebrand, LIS), medical radiology technicians, midwives, psychotherapists.',
      ],
    },
    {
      title: 'Salary ranges in 2026 (CHF gross, 13 months)',
      paragraphs: [
        'Nurse SUP EOC: 75,000-110,000. OSS-AFC elderly-care: 55,000-78,000. Physiotherapist SUP: 70,000-95,000. Radiology technician: 80,000-105,000. Midwife EOC: 82,000-115,000. Assistant physician year 1: 95,000-105,000. Senior physician: 200,000-280,000. Chief physician: 280,000-450,000.',
        'Cross-border net vs Italy: +40-70% for nurses/OSS, +60-100% for physios/techs, +80-130% for hospital physicians.',
      ],
    },
    {
      title: 'Agreements in force',
      paragraphs: [
        'CCL EOC (public hospitals), CCL Cliniche private ticinesi, CCL CAT 2024 (elderly care), CCL Spitex Ticino (home care). All regulated by Federal Labor Law (LTr) for maximum hours, rest and overtime.',
      ],
    },
    {
      title: 'Recurring tenders',
      paragraphs: [
        'EOC tenders close on 15th and 30th of each month. Assessment Days used for urgent positions (ICU, ER). Private clinics: 6-10 weeks from application to contract. Elderly-care homes: quarterly tenders aggregated on ADiCASI.',
      ],
    },
    {
      title: 'Diploma recognition by role',
      paragraphs: [
        'Nurses and OSS via SRK (Swiss Red Cross). Physicians via MEBEKO with possible federal exam. Physiotherapists/ergotherapists/speech therapists via MEBEKO or SRK. Radiology techs, midwives, dieticians: SRK. Pharmacists: MEBEKO. Psychologists: PsyKo.',
      ],
    },
    {
      title: 'Five steps to start',
      paragraphs: [
        '1) Start SRK/MEBEKO recognition immediately. 2) Prepare a Swiss-standard CV in Italian. 3) Target EOC, private clinic, or elderly-care / SACD. 4) Apply to active tenders via our aggregated portal. 5) Simulate G vs B permit net salary on our calculator.',
      ],
    },
  ],
  faqs: [
    {
      question: 'Which is the largest healthcare employer in Ticino?',
      answer:
        'Ente Ospedaliero Cantonale (EOC), with 5 public hospitals (Bellinzona, Locarno, Lugano Civico, Mendrisio, Faido) and ~4,600 employees.',
    },
    {
      question: 'Can I work in Ticino as an Italian physician?',
      answer:
        'Yes, after MEBEKO recognition and registration with the cantonal physicians\' order. Depending on specialization alignment, a federal exam may be required.',
    },
    {
      question: 'Most-requested healthcare roles in Ticino in 2026?',
      answer:
        'SUP nurses (ICU, ER, oncology), OSS-AFC, assistant physicians, physiotherapists, radiology technicians, midwives, psychotherapists.',
    },
    {
      question: 'Do private clinics pay more than EOC?',
      answer:
        'Similar on base roles. Private clinics reward specialisations (surgery, rehab). EOC offers more stability, biennial automatic progression, better complementary benefits.',
    },
    {
      question: 'How long does an EOC tender take?',
      answer:
        'Typically 8-14 weeks from tender publication to contract signature. Assessment Days compress the process for urgent positions.',
    },
    {
      question: 'Salary comparison with Italy?',
      answer:
        'Net salary +40-70% for nurses/OSS, +60-100% for techs, +80-130% for hospital physicians at equal role and seniority.',
    },
    {
      question: 'Do I need German or French for Ticino?',
      answer:
        'No, Italian is the working language. Basic German/English appreciated in border clinics but not required.',
    },
    {
      question: 'Can I work as a cross-border in any Ticino healthcare facility?',
      answer:
        'Yes with G-permit. You must return to Italy at least once a week. Permit procedure handled by the employer via the Ticino migration office.',
    },
  ],
};

// ─────────────────────────────────────────────────────────────────
// DE — condensed (≥400 words)
// ─────────────────────────────────────────────────────────────────

const DE_NURSES: NursingLandingCopy = {
  title: 'Pflegejobs in der Schweiz 2026: Gehalt, GAV, Bewilligungen | Frontaliere Ticino',
  description:
    'Leitfaden für Grenzgänger-Pflegekräfte in der Schweiz: anwendbare GAV, Nettogehalt nach Erfahrung, SRK/MEBEKO-Anerkennung italienischer Diplome, Top-Arbeitgeber (EOC, Moncucco, LIS).',
  h1: 'Pflegejobs in der Schweiz: Leitfaden 2026 für Grenzgänger',
  lede:
    'Die Schweiz hat einen akuten Pflegekräftemangel: bis 2030 werden über 70.000 neue Fachkräfte benötigt. Das Tessin, italienischsprachig, rekrutiert regelmässig italienische Pflegekräfte. Hier die Fakten zu Gehalt, Bewilligung und Diplomanerkennung.',
  updatedLabel: 'Aktualisiert',
  breadcrumbHome: 'Home',
  breadcrumbJobs: 'Tessin-Stellen',
  ctaJobs: 'Pflegestellen im Tessin',
  ctaSimulator: 'Nettogehalt berechnen',
  relatedLabel: 'Verwandte Ressourcen',
  faqTitle: 'Häufige Fragen',
  sections: [
    {
      title: 'Fachkräftemangel und Nachfrage',
      paragraphs: [
        'Der SBK-ASI und Curaviva schätzen 70.000+ zusätzliche Pflegefachkräfte bis 2030. Das Tessin allein eröffnet jährlich über 400 Stellen in Spitälern und Altersheimen, vielfach offen für italienische Grenzgänger mit anerkanntem Diplom.',
        'Hauptarbeitgeber ist Ente Ospedaliero Cantonale (EOC) mit 5 öffentlichen Spitälern. Ergänzt durch Privatkliniken Moncucco, Sant\'Anna, LIS und die Fondazione Ticino Cuore.',
      ],
    },
    {
      title: 'Anwendbare Gesamtarbeitsverträge',
      paragraphs: [
        'EOC-Mitarbeitende unter GAV EOC mit einer der umfassendsten GAV der Schweizer Gesundheit: Lohnsystem mit zweijähriger Progression, 20-50% Nacht-/Feiertagszulagen, 5 Wochen Ferien (6 ab 50), Treueprämien.',
        'Privatkliniken: GAV Cliniche private ticinesi. Altersheime: GAV CAT (Oktober 2024 erneuert). Spitex: GAV Spitex Ticino. G-Grenzgänger sind vom jeweiligen GAV vollständig abgedeckt.',
      ],
    },
    {
      title: 'Lohnbänder 2026 (CHF brutto, 13 Monate)',
      paragraphs: [
        'Neu angestellte SUP/HF-Pflegefachperson: 75.000-82.000 CHF/Jahr. Nach 5 Jahren: 85.000-92.000. Karriereende (20+ Jahre): 100.000-110.000. Spezialisierungen IPS/Anästhesie/Onkologie: +5-15% Funktionszulage, Karriereende 115.000-130.000.',
        'Grenzgänger-Netto: +40-70% über italienischem Netto nach italienischer Steuererklärung. Unser Nettogehaltsrechner simuliert G- und B-Szenario.',
      ],
    },
    {
      title: 'Anerkennung via SRK / MEBEKO',
      paragraphs: [
        'Italienische Bachelor-Pflegefachpersonen reichen bei SRK ein (im Auftrag MEBEKO). Dossier: legalisiertes Diplom, übersetztes Curriculum, Praktikumsstunden, Leumundszeugnis. Dauer: 4-9 Monate.',
        'Bei Abweichungen zum HF-Niveau verlangt SRK ein 3-12 Monate Anpassungsmodul oder eine Eignungsprüfung. Viele Tessiner Arbeitgeber bieten Brückenverträge während des Verfahrens.',
      ],
    },
    {
      title: 'G- oder B-Bewilligung?',
      paragraphs: [
        'G-Bewilligung: Wohnsitz Italien, wöchentliche Rückkehr, Quellensteuer CH + italienische Erklärung. B-Bewilligung: Schweizer Wohnsitz, volle KVG-Pflicht, obligatorische BVG, Zugang zu Schweizer Hypotheken.',
        'Für Langzeitaufenthalt (5+ Jahre) ist B meist steuerlich vorteilhafter bei gleichem Brutto. Rechner auf unserer Seite.',
      ],
    },
    {
      title: 'Bewerbung',
      paragraphs: [
        'EOC veröffentlicht monatliche Ausschreibungen auf eoc.ch/lavoro (15. und 30.). Privatkliniken mit kürzeren Zyklen (6-10 Wochen).',
        'Swiss-Standard CV auf Italienisch (Foto, alle Diplome, Praktikumsstunden, prüfbare Referenzen), gezieltes Motivationsschreiben, SRK-Verfahren parallel starten.',
      ],
    },
  ],
  faqs: [
    {
      question: 'Kann ich als italienische Pflegefachperson in der Schweiz arbeiten?',
      answer:
        'Ja, nach Anerkennung durch SRK (4-9 Monate). Bei Curriculum-Abweichungen: Anpassungsmodul (3-12 Monate) oder Eignungsprüfung.',
    },
    {
      question: 'Wieviel verdient eine Pflegefachperson im Tessin 2026?',
      answer:
        'GAV EOC: 75.000-82.000 CHF/Jahr Einsteiger (13 Monate, 100%), 85.000-92.000 nach 5 Jahren, bis 110.000 Karriereende. Spezialisierungen +5-15%.',
    },
    {
      question: 'G oder B für Pflege?',
      answer:
        'G: Wohnsitz Italien, keine KVG, italienische Steuererklärung. B: Schweizer Wohnsitz, volle KVG/BVG, Zugang Hypothek. Für Langzeit meist B vorteilhafter.',
    },
    {
      question: 'Welche Tessiner Spitäler stellen am meisten ein?',
      answer:
        'EOC (5 Standorte), Clinica Luganese Moncucco, Clinica Sant\'Anna, LIS, Fondazione Ticino Cuore.',
    },
    {
      question: 'Brauche ich Deutsch oder Französisch?',
      answer:
        'Nein, Arbeitssprache ist Italienisch. Grundkenntnisse Deutsch/Englisch in Grenzkliniken erwünscht, aber nicht Pflicht.',
    },
    {
      question: 'Wie bewerbe ich mich bei EOC?',
      answer:
        'Über eoc.ch/lavoro. CV Swiss-Standard auf Italienisch, Diplome, Motivationsschreiben. HR-Gespräch + Fachgespräch; manche Positionen mit Praxistest.',
    },
    {
      question: 'Zahlt der GAV Nachtzuschläge?',
      answer:
        'Ja, 20-50% für Nacht-, Sonntags- und Feiertagsdienste. Intensiver Schichtrhythmus kann 6.000-10.000 CHF/Jahr zusätzlich bringen.',
    },
    {
      question: 'Wie lange dauert die SRK-Anerkennung?',
      answer:
        '4-6 Monate bei vollständigem Dossier; bis 12-18 Monate mit Anpassungsmodul. Vor Bewerbungen starten.',
    },
  ],
};

const DE_OSS: NursingLandingCopy = {
  title: 'Pflegehilfe-Jobs in der Schweiz 2026: FaGe-Leitfaden | Frontaliere Ticino',
  description:
    'Grenzgänger-Leitfaden für Pflegehilfe/FaGe-Stellen in der Schweiz: GAV CAT 2024, Gehalt, italienische Diplomanerkennung, Alters- und Spitex-Stellen im Tessin.',
  h1: 'Pflegehilfe-Jobs in der Schweiz: Leitfaden 2026',
  lede:
    'Fachangestellte Gesundheit (FaGe / OSS-AFC) sind nach Pflegefachpersonen die am meisten nachgefragte Berufsgruppe. Tessiner Altersheime, Spitex und Spitäler rekrutieren laufend, auch italienische Bewerber mit anerkanntem Diplom.',
  updatedLabel: 'Aktualisiert',
  breadcrumbHome: 'Home',
  breadcrumbJobs: 'Tessin-Stellen',
  ctaJobs: 'Altersheim-Stellen',
  ctaSimulator: 'Nettogehalt berechnen',
  relatedLabel: 'Verwandte Ressourcen',
  faqTitle: 'Häufige Fragen',
  sections: [
    {
      title: 'Rollen im Schweizer System',
      paragraphs: [
        'FaBe/OSA (EFZ 2 Jahre), FaGe/OSS-AFC (EFZ 3 Jahre, ~5.400 Stunden), Pflegehelfer/in SRK (120h Grundkurs). Italienische OSS mit regionalen Zertifikaten werden typischerweise vom SRK gegen FaGe-Kriterien geprüft.',
      ],
    },
    {
      title: 'Wer stellt ein',
      paragraphs: [
        '67 Tessiner Altersheime (CAT): Pro Senectute, Fondazione Diamante, Casa San Giorgio Brissago, Opera Don Guanella. Spitex (ALVAD, SCuDo, SACD Luganese). EOC-Spitäler in Geriatrie, Medizin und Reha.',
      ],
    },
    {
      title: 'GAV CAT 2024 Lohnbänder',
      paragraphs: [
        'Neueinsteiger FaGe: 55.000-60.000 CHF/Jahr. 5 Jahre: 62.000-67.000. Karriereende: 72.000-78.000. EOC-Spital FaGe: +2.000-4.000. Nacht-/Feiertagszulagen (30-50%) bringen 5.000-9.000 zusätzlich.',
        'Italienischer OSS-Mindestlohn: ~20-25 TEUR. Schweizer Prämium 130-180% beim Einstieg.',
      ],
    },
    {
      title: 'Arbeitsbedingungen',
      paragraphs: [
        'Altersheim: 42 Wochenstunden, 5-Tage-Woche, 8h oder 12h-Schichten, 1-2 Nächte/Monat. 5 Wochen Ferien. Krankheit 100% für 2 Jahre. Spitex: fast ausschliesslich Tagesarbeit mit Firmenauto.',
      ],
    },
    {
      title: 'Nettogehalt G-Bewilligung',
      paragraphs: [
        'FaGe mit 60.000 CHF brutto, G-Bewilligung, Wohnsitz >20km: Netto 46.000-50.000 CHF/Jahr nach Quellensteuer und italienischer Erklärung. Deutlich über italienischem Äquivalent.',
      ],
    },
    {
      title: 'Bewerbung',
      paragraphs: [
        'Italienische Kandidaten starten meist als Pflegehilfe auf Zeit während der SRK-Prüfung; nach Anerkennung Umwandlung zu FaGe mit teilweise rückwirkender Anpassung. ADiCASI aggregiert offene Stellen.',
      ],
    },
  ],
  faqs: [
    {
      question: 'Gilt mein italienisches OSS-Zertifikat in der Schweiz?',
      answer:
        'Nicht automatisch. SRK prüft Stundenzahl Theorie/Praktikum. Bei Alignment zu OSS-AFC (~5.400h): direkte Anerkennung; sonst Anpassungsmodul 6-12 Monate.',
    },
    {
      question: 'Wieviel verdient FaGe im Tessin 2026?',
      answer:
        'GAV CAT 2024: 55-60.000 CHF Einsteiger, 62-67.000 nach 5 Jahren, 72-78.000 Karriereende. EOC-Spital +2-4.000. Zulagen 5-9.000/Jahr.',
    },
    {
      question: 'Mit G-Bewilligung FaGe arbeiten möglich?',
      answer:
        'Ja. G-Bewilligung erlaubt jede Pflegestelle. Wöchentliche Rückkehr Italien. Voller GAV-Schutz (Lohn, Ferien, AHV/IV, BVG ab 8h/Woche).',
    },
    {
      question: 'Unterschied OSS, OSA, Pflegehelfer?',
      answer:
        'FaGe/OSS-AFC: 3 Jahre, voller Scope. FaBe/OSA: 2 Jahre, Sozialbetreuung. Pflegehelfer SRK: 120h, Einstieg 15-25% tiefer.',
    },
    {
      question: 'Welche Altersheime stellen am meisten ein?',
      answer:
        'Pro Senectute, Fondazione Diamante, Casa San Giorgio Brissago, Opera Don Guanella Balerna, Casa Cigno Bianco Bellinzona. ADiCASI aggregiert.',
    },
    {
      question: 'Als Pflegehelfer starten und dann FaGe werden?',
      answer:
        'Sehr üblich. Nach SRK-Anerkennung Umwandlung zu FaGe-Vertrag, teils rückwirkend.',
    },
    {
      question: 'Zahlt GAV Schichtzuschläge?',
      answer:
        '+30% Nacht, +50% Sonntag/Feiertag, Überstunden +25% oder Zeitkompensation. Intensive Rotation: +6-9.000 CHF/Jahr.',
    },
    {
      question: 'Altersheim oder Spitex?',
      answer:
        'Spitex für Tagesarbeit und Firmenauto, Altersheim für strukturierte Rhythmen und Geriatrie-Spezialisierung. Grundlöhne ähnlich, Zulagen im Altersheim höher.',
    },
  ],
};

const DE_HEALTHCARE_TICINO: NursingLandingCopy = {
  title: 'Gesundheitsjobs im Tessin 2026: Spitäler, Kliniken, Altersheime | Frontaliere Ticino',
  description:
    'Gesundheits-Jobhub Tessin: EOC, Clinica Luganese Moncucco, LIS, Clinica Sant\'Anna, Fondazione Ticino Cuore, Altersheime. Rollen, Löhne, GAV, italienische Diplomanerkennung.',
  h1: 'Gesundheitsjobs im Tessin: Hub 2026 der Spitäler und Kliniken',
  lede:
    'Das Tessin hat einen der dynamischsten Gesundheitsmärkte der Schweiz: über 20.000 Beschäftigte in EOC-Spitälern, Privatkliniken, Altersheimen und Spitex. Dieser Hub aggregiert Löhne, Rollen und wiederkehrende Ausschreibungen.',
  updatedLabel: 'Aktualisiert',
  breadcrumbHome: 'Home',
  breadcrumbJobs: 'Tessin-Stellen',
  ctaJobs: 'Alle Tessin-Gesundheitsstellen',
  ctaSimulator: 'Nettogehalt berechnen',
  relatedLabel: 'Verwandte Ressourcen',
  faqTitle: 'Häufige Fragen',
  sections: [
    {
      title: 'Sektor-Landkarte',
      paragraphs: [
        'Vier Makro-Akteure: EOC (5 öffentliche Spitäler, ~4.600 Mitarbeitende); Privatkliniken (Moncucco, Sant\'Anna, LIS, Ars Medica, Hildebrand); 67 Altersheime im ADiCASI-Netzwerk; Spitex (ALVAD, SCuDo, SACD Luganese).',
      ],
    },
    {
      title: 'Meistgesuchte Rollen 2026',
      paragraphs: [
        'SUP/HF-Pflegefachpersonen (IPS, Notfall, Onkologie), FaGe in Altersheim und Spital, Assistenzärzte Innere Medizin und Anästhesie, Physiotherapeuten, MTRA, Hebammen, Psychotherapeuten.',
      ],
    },
    {
      title: 'Lohnbänder 2026 (CHF brutto, 13 Monate)',
      paragraphs: [
        'Pflege SUP EOC: 75.000-110.000. FaGe: 55.000-78.000. Physio SUP: 70.000-95.000. MTRA: 80.000-105.000. Hebamme EOC: 82.000-115.000. Assistenzarzt Jahr 1: 95.000-105.000. Oberarzt: 200.000-280.000. Chefarzt: 280.000-450.000.',
      ],
    },
    {
      title: 'Geltende GAV',
      paragraphs: [
        'GAV EOC, GAV Cliniche private ticinesi, GAV CAT 2024, GAV Spitex Ticino — alle unter Arbeitsgesetz (ArG).',
      ],
    },
    {
      title: 'Wiederkehrende Ausschreibungen',
      paragraphs: [
        'EOC am 15. und 30. jeden Monats. Assessment Days für dringende Positionen. Privatkliniken 6-10 Wochen. Altersheime quartalsweise auf ADiCASI.',
      ],
    },
    {
      title: 'Anerkennung nach Rolle',
      paragraphs: [
        'Pflege und OSS: SRK. Ärzte: MEBEKO, evtl. Staatsexamen. Physio/Ergo/Logo: MEBEKO oder SRK. MTRA, Hebammen, Diätetik: SRK. Apotheker: MEBEKO. Psychologen: PsyKo.',
      ],
    },
    {
      title: 'Fünf Schritte zum Start',
      paragraphs: [
        '1) SRK/MEBEKO-Anerkennung sofort starten. 2) Swiss-Standard CV auf Italienisch. 3) Ziel: EOC, Privatklinik oder Altersheim/SACD. 4) Über unser Portal bewerben. 5) G vs B mit unserem Rechner simulieren.',
      ],
    },
  ],
  faqs: [
    {
      question: 'Wer ist der grösste Gesundheitsarbeitgeber im Tessin?',
      answer:
        'EOC mit 5 öffentlichen Spitälern (Bellinzona, Locarno, Lugano Civico, Mendrisio, Faido), ~4.600 Mitarbeitende.',
    },
    {
      question: 'Als italienischer Arzt im Tessin arbeiten?',
      answer:
        'Ja, nach MEBEKO-Anerkennung und Eintragung im kantonalen Ärzteregister. Je nach Spezialisierung evtl. Staatsexamen.',
    },
    {
      question: 'Meistgesuchte Rollen 2026?',
      answer:
        'Pflegefachpersonen SUP, FaGe, Assistenzärzte, Physiotherapeuten, MTRA, Hebammen, Psychotherapeuten.',
    },
    {
      question: 'Privatkliniken zahlen mehr als EOC?',
      answer:
        'Basisrollen ähnlich. Privatkliniken honorieren Spezialisierungen. EOC: mehr Stabilität, automatische Zweijahresprogression.',
    },
    {
      question: 'EOC-Ausschreibung Dauer?',
      answer:
        'Typisch 8-14 Wochen von Publikation bis Vertragsunterschrift. Assessment Days komprimieren für dringende Rollen.',
    },
    {
      question: 'Lohnvergleich mit Italien?',
      answer:
        'Netto +40-70% Pflege/OSS, +60-100% Techniker, +80-130% Spitalärzte.',
    },
    {
      question: 'Brauche ich Deutsch oder Französisch?',
      answer:
        'Nein, Arbeitssprache Italienisch. Grundkenntnisse Deutsch/Englisch in Grenzkliniken erwünscht.',
    },
    {
      question: 'Als Grenzgänger in jeder Tessiner Gesundheitseinrichtung arbeiten?',
      answer:
        'Ja mit G-Bewilligung. Wöchentliche Rückkehr Italien. Bewilligung durch Arbeitgeber beim Migrationsamt Tessin.',
    },
  ],
};

// ─────────────────────────────────────────────────────────────────
// FR — condensed (≥400 words)
// ─────────────────────────────────────────────────────────────────

const FR_NURSES: NursingLandingCopy = {
  title: 'Emplois infirmiers en Suisse 2026: salaire, CCT, permis | Frontaliere Ticino',
  description:
    'Guide pour infirmiers frontaliers en Suisse: CCT applicables, salaire net par expérience, reconnaissance CRS/MEBEKO du diplôme italien, principaux employeurs (EOC, Moncucco, LIS).',
  h1: 'Emplois infirmiers en Suisse: guide frontalier 2026',
  lede:
    'La Suisse manque cruellement d\'infirmiers: 70\u00A0000+ professionnels supplémentaires nécessaires d\'ici 2030. Le Tessin italophone recrute régulièrement des infirmiers italiens — voici salaires, permis et reconnaissance du diplôme.',
  updatedLabel: 'Mis à jour',
  breadcrumbHome: 'Accueil',
  breadcrumbJobs: 'Emplois Tessin',
  ctaJobs: 'Voir les postes infirmiers au Tessin',
  ctaSimulator: 'Calculer votre salaire net',
  relatedLabel: 'Ressources liées',
  faqTitle: 'Questions fréquentes',
  sections: [
    {
      title: 'Pénurie et demande',
      paragraphs: [
        'ASI-SBK et Curaviva estiment 70\u00A0000+ nouveaux professionnels d\'ici 2030. Le Tessin ouvre chaque année 400+ postes en hôpitaux et EMS, largement ouverts aux frontaliers italiens avec diplôme reconnu.',
        'Employeur public principal: Ente Ospedaliero Cantonale (EOC), 5 hôpitaux. Complété par Moncucco, Sant\'Anna, LIS, Fondazione Ticino Cuore.',
      ],
    },
    {
      title: 'CCT applicables',
      paragraphs: [
        'Personnel EOC sous CCT EOC — l\'une des plus complètes: grille salariale biennale, majorations nuit/férié 20-50%, 5 semaines de vacances (6 après 50 ans), primes d\'ancienneté.',
        'Cliniques privées: CCT Cliniche private ticinesi. EMS: CCT CAT (renouvelée oct 2024). Soins à domicile: CCT Spitex Ticino. Les frontaliers G bénéficient intégralement.',
      ],
    },
    {
      title: 'Fourchettes salariales 2026 (CHF brut, 13 mois)',
      paragraphs: [
        'Infirmier SUP/HF débutant: 75\u00A0000-82\u00A0000 CHF/an. Après 5 ans: 85\u00A0000-92\u00A0000. Fin de carrière (20+ ans): 100\u00A0000-110\u00A0000. Spécialisations soins intensifs/anesthésie/oncologie: +5-15% prime de fonction, fin de carrière 115\u00A0000-130\u00A0000.',
        'Net frontalier: +40-70% sur équivalent italien après déclaration en Italie. Notre simulateur compare les scénarios G et B.',
      ],
    },
    {
      title: 'Reconnaissance CRS / MEBEKO',
      paragraphs: [
        'Infirmiers italiens déposent auprès de la CRS (pour MEBEKO). Dossier: diplôme légalisé, cursus traduit, heures de stage, certificat de bonne vie et mœurs. Délai: 4-9 mois.',
        'Si le cursus italien n\'est pas aligné au niveau HF suisse: module d\'adaptation 3-12 mois ou examen d\'aptitude. Nombreux employeurs tessinois proposent des contrats-pont.',
      ],
    },
    {
      title: 'Permis G ou B?',
      paragraphs: [
        'G: résidence Italie, retour hebdomadaire, imposition à la source CH + déclaration IT. B: résidence Suisse, LAMal obligatoire, LPP obligatoire, accès crédits hypothécaires.',
        'Pour un séjour long (5+ ans), B est souvent plus avantageux fiscalement. Calculateur sur notre site.',
      ],
    },
    {
      title: 'Comment postuler',
      paragraphs: [
        'EOC publie des postes mensuels sur eoc.ch/lavoro (échéances 15 et 30). Cliniques privées: 6-10 semaines de candidature à contrat.',
        'CV Swiss-Standard en italien (photo, tous les diplômes, heures de stage, références vérifiables), lettre de motivation ciblée, démarrer la CRS en parallèle.',
      ],
    },
  ],
  faqs: [
    {
      question: 'Puis-je travailler comme infirmier italien en Suisse?',
      answer:
        'Oui, après reconnaissance CRS (4-9 mois). En cas d\'écart: module d\'adaptation (3-12 mois) ou examen d\'aptitude.',
    },
    {
      question: 'Quel salaire infirmier au Tessin en 2026?',
      answer:
        'CCT EOC: 75\u00A0000-82\u00A0000 CHF/an débutant (13 mois, 100%), 85\u00A0000-92\u00A0000 après 5 ans, jusqu\'à 110\u00A0000 fin de carrière. Spécialisations +5-15%.',
    },
    {
      question: 'Permis G ou B pour infirmier?',
      answer:
        'G: résidence IT, pas de LAMal, déclaration IT. B: résidence CH, LAMal/LPP complets, crédit hypothécaire. Pour long terme: B souvent meilleur.',
    },
    {
      question: 'Quels hôpitaux tessinois recrutent le plus?',
      answer:
        'EOC (5 sites), Clinica Luganese Moncucco, Clinica Sant\'Anna, LIS, Fondazione Ticino Cuore.',
    },
    {
      question: 'Dois-je parler allemand ou français?',
      answer:
        'Non, l\'italien est la langue de travail. Bases allemand/anglais appréciées en clinique frontalière, pas obligatoires.',
    },
    {
      question: 'Comment postuler chez EOC?',
      answer:
        'Via eoc.ch/lavoro. CV Swiss-Standard en italien, diplômes, lettre. Entretien RH + technique; test pratique pour certaines positions.',
    },
    {
      question: 'Majorations pour les gardes?',
      answer:
        'Oui, 20-50% pour nuits, dimanches et fériés. Rotation intensive peut apporter 6\u00A0000-10\u00A0000 CHF/an.',
    },
    {
      question: 'Combien de temps pour la reconnaissance CRS?',
      answer:
        '4-6 mois si dossier complet; jusqu\'à 12-18 mois avec module d\'adaptation. Démarrer avant les candidatures.',
    },
  ],
};

const FR_OSS: NursingLandingCopy = {
  title: 'Emplois aide-soignant en Suisse 2026: guide ASSC | Frontaliere Ticino',
  description:
    'Guide frontalier pour les postes d\'aide-soignant (ASSC / OSS-AFC) en Suisse: CCT CAT 2024, salaire, reconnaissance du diplôme italien, EMS et Spitex au Tessin.',
  h1: 'Emplois aide-soignant en Suisse: guide 2026',
  lede:
    'Les assistants en soins et santé communautaire (ASSC / OSS-AFC) sont le 2e profil le plus recherché après les infirmiers. EMS tessinois, Spitex et hôpitaux recrutent en continu, y compris candidats italiens avec diplôme reconnu.',
  updatedLabel: 'Mis à jour',
  breadcrumbHome: 'Accueil',
  breadcrumbJobs: 'Emplois Tessin',
  ctaJobs: 'Postes en EMS',
  ctaSimulator: 'Calculer votre salaire net',
  relatedLabel: 'Ressources liées',
  faqTitle: 'Questions fréquentes',
  sections: [
    {
      title: 'Les rôles dans le système suisse',
      paragraphs: [
        'ASE/OSA (CFC 2 ans), ASSC/OSS-AFC (CFC 3 ans, ~5\u00A0400 heures), Auxiliaire de santé CRS (120h). L\'OSS italien avec qualification régionale est généralement évalué par CRS contre ASSC.',
      ],
    },
    {
      title: 'Qui recrute',
      paragraphs: [
        '67 EMS tessinois (CAT): Pro Senectute, Fondazione Diamante, Casa San Giorgio Brissago, Opera Don Guanella. Spitex (ALVAD, SCuDo, SACD). Hôpitaux EOC en gériatrie, médecine, réadaptation.',
      ],
    },
    {
      title: 'Fourchettes salariales CCT CAT 2024',
      paragraphs: [
        'ASSC débutant EMS: 55\u00A0000-60\u00A0000 CHF/an. 5 ans: 62\u00A0000-67\u00A0000. Fin de carrière: 72\u00A0000-78\u00A0000. Hôpital EOC +2\u00A0000-4\u00A0000. Majorations nuit/férié 30-50% ajoutent 5\u00A0000-9\u00A0000/an.',
        'Minimum italien OSS: ~20-25 TEUR. Prime suisse 130-180% au démarrage.',
      ],
    },
    {
      title: 'Conditions de travail',
      paragraphs: [
        'EMS: 42h/semaine sur 5 jours, postes 8h ou 12h, 1-2 nuits/mois. 5 semaines de vacances. Maladie 100% pendant 2 ans. Spitex: principalement jour avec voiture de fonction.',
      ],
    },
    {
      title: 'Salaire net permis G',
      paragraphs: [
        'ASSC 60\u00A0000 CHF brut, G, résidence >20km: net 46\u00A0000-50\u00A0000 CHF/an après impôt à la source et déclaration italienne. Nettement au-dessus de l\'équivalent italien.',
      ],
    },
    {
      title: 'Comment postuler',
      paragraphs: [
        'Les candidats italiens démarrent souvent comme auxiliaire pendant la procédure CRS; conversion en ASSC après validation, parfois rétroactive. ADiCASI agrège les offres ouvertes.',
      ],
    },
  ],
  faqs: [
    {
      question: 'Mon certificat OSS italien est-il valable en Suisse?',
      answer:
        'Pas automatiquement. CRS évalue heures théorie/stage. Si aligné à ASSC (~5\u00A0400h): reconnaissance directe; sinon module d\'adaptation 6-12 mois.',
    },
    {
      question: 'Quel salaire ASSC au Tessin en 2026?',
      answer:
        'CCT CAT 2024: 55-60\u00A0000 CHF débutant, 62-67\u00A0000 à 5 ans, 72-78\u00A0000 fin de carrière. EOC +2-4\u00A0000. Majorations +5-9\u00A0000/an.',
    },
    {
      question: 'ASSC avec permis G possible?',
      answer:
        'Oui. Permis G compatible avec tout rôle santé. Retour hebdomadaire Italie. Protection CCT complète (salaire, vacances, AVS/AI, LPP dès 8h/semaine).',
    },
    {
      question: 'Différence OSS, OSA, auxiliaire?',
      answer:
        'ASSC/OSS-AFC: 3 ans, scope complet. ASE/OSA: 2 ans, soutien social sans actes techniques. Auxiliaire CRS: 120h, entrée 15-25% en-dessous ASSC.',
    },
    {
      question: 'Quels EMS recrutent le plus?',
      answer:
        'Pro Senectute, Fondazione Diamante, Casa San Giorgio Brissago, Opera Don Guanella, Casa Cigno Bianco. ADiCASI agrège les postes.',
    },
    {
      question: 'Démarrer auxiliaire puis devenir ASSC?',
      answer:
        'Pratique très répandue. Après validation CRS: conversion en ASSC, parfois avec effet rétroactif sur salaire.',
    },
    {
      question: 'Majorations pour gardes?',
      answer:
        '+30% nuit, +50% dimanche/férié, heures supp +25% ou compensation en temps. Rotation intensive: +6\u00A0000-9\u00A0000 CHF/an.',
    },
    {
      question: 'EMS ou Spitex?',
      answer:
        'Spitex pour travail de jour et voiture. EMS pour rythmes structurés et spécialisation gériatrique. Salaires de base similaires, majorations plus élevées en EMS.',
    },
  ],
};

const FR_HEALTHCARE_TICINO: NursingLandingCopy = {
  title: 'Emplois santé au Tessin 2026: hôpitaux, cliniques, EMS | Frontaliere Ticino',
  description:
    'Hub emplois santé Tessin: EOC, Clinica Luganese Moncucco, LIS, Clinica Sant\'Anna, Fondazione Ticino Cuore, EMS. Rôles, salaires, CCT, reconnaissance diplôme italien.',
  h1: 'Emplois santé au Tessin: hub 2026 des hôpitaux et cliniques',
  lede:
    'Le Tessin a l\'un des marchés santé les plus dynamiques de Suisse: plus de 20\u00A0000 personnes travaillent dans la santé entre hôpitaux EOC, cliniques privées, EMS et soins à domicile. Ce hub agrège salaires, rôles et concours récurrents.',
  updatedLabel: 'Mis à jour',
  breadcrumbHome: 'Accueil',
  breadcrumbJobs: 'Emplois Tessin',
  ctaJobs: 'Toutes les offres santé Tessin',
  ctaSimulator: 'Calculer votre salaire net',
  relatedLabel: 'Ressources liées',
  faqTitle: 'Questions fréquentes',
  sections: [
    {
      title: 'Carte du secteur',
      paragraphs: [
        'Quatre macro-acteurs: EOC (5 hôpitaux publics, ~4\u00A0600 collaborateurs); cliniques privées (Moncucco, Sant\'Anna, LIS, Ars Medica, Hildebrand); 67 EMS ADiCASI; soins à domicile (ALVAD, SCuDo, SACD Luganese).',
      ],
    },
    {
      title: 'Rôles les plus recherchés 2026',
      paragraphs: [
        'Infirmiers SUP/HF (soins intensifs, urgences, oncologie), ASSC en EMS et hôpital, médecins assistants en médecine interne et anesthésie, physiothérapeutes, TRM, sages-femmes, psychothérapeutes.',
      ],
    },
    {
      title: 'Fourchettes salariales 2026 (CHF brut, 13 mois)',
      paragraphs: [
        'Infirmier SUP EOC: 75\u00A0000-110\u00A0000. ASSC EMS: 55\u00A0000-78\u00A0000. Physio SUP: 70\u00A0000-95\u00A0000. TRM: 80\u00A0000-105\u00A0000. Sage-femme EOC: 82\u00A0000-115\u00A0000. Médecin assistant an 1: 95\u00A0000-105\u00A0000. Chef de service: 200\u00A0000-280\u00A0000. Médecin-chef: 280\u00A0000-450\u00A0000.',
      ],
    },
    {
      title: 'CCT en vigueur',
      paragraphs: [
        'CCT EOC, CCT Cliniche private ticinesi, CCT CAT 2024, CCT Spitex Ticino — toutes soumises à la Loi sur le travail (LTr).',
      ],
    },
    {
      title: 'Concours récurrents',
      paragraphs: [
        'EOC les 15 et 30 de chaque mois. Assessment Days pour postes urgents. Cliniques privées 6-10 semaines. EMS trimestriels sur ADiCASI.',
      ],
    },
    {
      title: 'Reconnaissance par rôle',
      paragraphs: [
        'Infirmiers et OSS: CRS. Médecins: MEBEKO + éventuel examen fédéral. Physio/ergo/logo: MEBEKO ou CRS. TRM, sages-femmes, diététiciens: CRS. Pharmaciens: MEBEKO. Psychologues: PsyKo.',
      ],
    },
    {
      title: 'Cinq étapes pour démarrer',
      paragraphs: [
        '1) Lancer la reconnaissance CRS/MEBEKO immédiatement. 2) Préparer un CV Swiss-Standard en italien. 3) Cibler EOC, clinique privée ou EMS/Spitex. 4) Postuler via notre portail. 5) Simuler G vs B avec notre calculateur.',
      ],
    },
  ],
  faqs: [
    {
      question: 'Quel est le plus grand employeur santé du Tessin?',
      answer:
        'Ente Ospedaliero Cantonale (EOC), 5 hôpitaux publics (Bellinzona, Locarno, Lugano Civico, Mendrisio, Faido), ~4\u00A0600 collaborateurs.',
    },
    {
      question: 'Puis-je travailler comme médecin italien au Tessin?',
      answer:
        'Oui, après reconnaissance MEBEKO et inscription à l\'Ordre cantonal. Selon spécialisation, examen fédéral complémentaire possible.',
    },
    {
      question: 'Rôles santé les plus recherchés au Tessin 2026?',
      answer:
        'Infirmiers SUP, ASSC, médecins assistants, physiothérapeutes, TRM, sages-femmes, psychothérapeutes.',
    },
    {
      question: 'Les cliniques privées paient plus que l\'EOC?',
      answer:
        'Rôles de base similaires. Cliniques privées récompensent les spécialisations. EOC: plus de stabilité, progression biennale automatique.',
    },
    {
      question: 'Durée concours EOC?',
      answer:
        'Typique 8-14 semaines de la publication à la signature. Assessment Days compriment pour postes urgents.',
    },
    {
      question: 'Comparaison salaire avec l\'Italie?',
      answer:
        'Net +40-70% infirmiers/OSS, +60-100% techniciens, +80-130% médecins hospitaliers à rôle et ancienneté égaux.',
    },
    {
      question: 'Dois-je parler allemand ou français?',
      answer:
        'Non, langue de travail italien. Bases allemand/anglais appréciées en clinique frontalière.',
    },
    {
      question: 'Travailler comme frontalier dans toute structure santé du Tessin?',
      answer:
        'Oui avec permis G. Retour hebdomadaire Italie. Permis géré par l\'employeur via l\'Office cantonal de la migration.',
    },
  ],
};

// ─────────────────────────────────────────────────────────────────
// Export matrix
// ─────────────────────────────────────────────────────────────────

export const NURSING_LANDING_COPY: Record<
  NursingLocale,
  Record<NursingLandingId, NursingLandingCopy>
> = {
  it: {
    nurses: IT_NURSES,
    oss: IT_OSS,
    'healthcare-ticino': IT_HEALTHCARE_TICINO,
  },
  en: {
    nurses: EN_NURSES,
    oss: EN_OSS,
    'healthcare-ticino': EN_HEALTHCARE_TICINO,
  },
  de: {
    nurses: DE_NURSES,
    oss: DE_OSS,
    'healthcare-ticino': DE_HEALTHCARE_TICINO,
  },
  fr: {
    nurses: FR_NURSES,
    oss: FR_OSS,
    'healthcare-ticino': FR_HEALTHCARE_TICINO,
  },
};
