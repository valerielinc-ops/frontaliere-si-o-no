/**
 * Comparisons Hub (AE-7) — static editorial copy × 4 locales.
 *
 * Italian is canonical (≥800 words). EN/DE/FR are ≥400 words each, no
 * placeholder / "coming soon" copy. Every regulated claim carries an inline
 * [fonte: …](url) citation to the authoritative source:
 *   - AFC (Amministrazione federale delle contribuzioni / ESTV)
 *   - Agenzia delle Entrate — Convenzione CH-IT 2020 + testo del Decreto
 *   - UFSP / BAG — tariffario LAMal
 *   - UST / BFS — indici prezzi, salari, affitti
 *   - ISTAT — potere d'acquisto, costo della vita
 *   - SECO — osservatorio salariale
 *
 * Tables and FAQ live in the plugin (they depend on runtime aggregation
 * from data/jobs.json and data/health-premiums/<year>.json). This file
 * only carries the locale-dependent strings.
 */

import type { ComparisonsLocale } from './comparisonsHubData';

export interface ComparisonsHubCopy {
  title: string;
  description: string;
  h1: string;
  heroTitle: string;
  heroSubtitle: string;
  updatedLabel: string;
  tldrTitle: string;
  tldrParagraphs: readonly string[];
  disclaimer: string;

  // Table captions + headers (one set per table)
  tSalaryCaption: string;
  tSalaryColSector: string;
  tSalaryColObservations: string;
  tSalaryColCh: string;
  tSalaryColIt: string;
  tSalaryColRatio: string;
  tSalaryFooter: string;

  tTaxCaption: string;
  tTaxColScenario: string;
  tTaxColChTotal: string;
  tTaxColItTotal: string;
  tTaxColNetDelta: string;
  tTaxFooter: string;
  tTaxScenarios: ReadonlyArray<{
    label: string;
    chPct: string;
    itPct: string;
    delta: string;
  }>;

  tHealthCaption: string;
  tHealthColCanton: string;
  tHealthColMonthly: string;
  tHealthColAnnual: string;
  tHealthFooter: string;
  tHealthContext: string;

  tBenefitsCaption: string;
  tBenefitsColArea: string;
  tBenefitsColCh: string;
  tBenefitsColIt: string;
  tBenefitsFooter: string;
  tBenefitsRows: ReadonlyArray<{
    area: string;
    ch: string;
    it: string;
  }>;

  tCostCaption: string;
  tCostColItem: string;
  tCostColCh: string;
  tCostColIt: string;
  tCostFooter: string;
  tCostRows: ReadonlyArray<{
    item: string;
    ch: string;
    it: string;
  }>;

  // Section intros
  salaryIntro: string;
  taxIntro: string;
  healthIntro: string;
  benefitsIntro: string;
  costIntro: string;

  faqTitle: string;
  faqs: ReadonlyArray<{ question: string; answer: string }>;

  relatedTitle: string;
  breadcrumbHome: string;
  breadcrumbHub: string;
}

// ─────────────────────────────────────────────────────────────────
// IT — canonical (~1.000 parole)
// ─────────────────────────────────────────────────────────────────

const IT: ComparisonsHubCopy = {
  title: 'Confronti Svizzera vs Italia per frontalieri 2026 — tabelle complete',
  description:
    'Confronti dettagliati Svizzera vs Italia per frontalieri: stipendi per settore, tassazione, LAMal vs SSN, contributi sociali, costo della vita. Dati 2026 con fonti ufficiali.',
  h1: 'Confronti Svizzera vs Italia per frontalieri (2026)',
  heroTitle: 'Confronti Svizzera vs Italia',
  heroSubtitle:
    'Tabelle dense con dati 2026 su stipendi, tasse, LAMal, contributi e costo della vita — una sola pagina, tutte le fonti ufficiali.',
  updatedLabel: 'Aggiornato',
  tldrTitle: 'In sintesi',
  tldrParagraphs: [
    'Un confronto diretto Svizzera vs Italia per chi lavora oltreconfine deve tenere insieme cinque variabili: stipendio lordo, carico fiscale, costo della sanità, contributi sociali e costo della vita. Guardare solo allo stipendio è fuorviante: un impiegato amministrativo con CHF 75.000 lordi in Ticino può finire con meno netto di un italiano residente a Varese se la distanza dal confine supera i 20 km e il nuovo regime fiscale 2026 si applica pienamente.',
    'Questa pagina mette in fila cinque tabelle compatte con dati 2026: salari mediani per settore da offerte reali pubblicate in Ticino, prelievo fiscale totale in tre scenari di reddito, premi LAMal per cantone contro il finanziamento SSN italiano, prestazioni sociali obbligatorie (AVS/LPP/AD vs INPS), e costo della vita su voci quotidiane. Ogni numero carica una fonte ufficiale: AFC per l\'imposta alla fonte, Agenzia delle Entrate per IRPEF e addizionali, UFSP per i premi LAMal, UST per salari e affitti, ISTAT per i prezzi al consumo italiani.',
    'L\'obiettivo non è spingere una conclusione: è darvi la base quantitativa per simulare il vostro caso specifico con il calcolatore dedicato, poi fare due conti sul calo o aumento netto mensile. Le tabelle sono deliberatamente dense: sono pensate per essere citate da altri siti, salvate come screenshot, richiamate in discussioni comunitarie e lette anche dai motori di risposta generativa (LLM) che oggi leggono il web.',
  ],
  disclaimer:
    'Dati aggiornati al 2026-04-23, verificare sempre presso le fonti ufficiali prima di decisioni fiscali o professionali. Gli stipendi italiani sono stime derivate da ratio di settore pubblicati da SECO, ISTAT e INAPP — non sostituiscono una consulenza individuale.',

  tSalaryCaption:
    'Tabella 1 — Stipendi lordi annui mediani per settore: Ticino (CHF) vs Italia (EUR, stima)',
  tSalaryColSector: 'Settore',
  tSalaryColObservations: 'Offerte (n)',
  tSalaryColCh: 'Mediana CH (CHF)',
  tSalaryColIt: 'Stima IT (EUR)',
  tSalaryColRatio: 'Ratio IT/CH',
  tSalaryFooter:
    'Fonte: aggregazione di data/jobs.json (panel di annunci pubblicati in Ticino), ratio di settore da SECO Struttura dei salari 2024 + ISTAT RSR 2022 + INAPP XXIV Rapporto 2024. Cambio CHF→EUR fissato a 1,04 per conservatività.',

  tTaxCaption:
    'Tabella 2 — Carico fiscale totale su un frontaliere (3 scenari di reddito): nuovo regime 2026 vs IRPEF piena',
  tTaxColScenario: 'Scenario',
  tTaxColChTotal: 'Prelievo CH (imposta alla fonte)',
  tTaxColItTotal: 'Prelievo IT (IRPEF + addizionali, franchigia €10.000)',
  tTaxColNetDelta: 'Delta netto',
  tTaxFooter:
    'Fonte: AFC — Tariffario 2026 imposta alla fonte Canton Ticino ([estv.admin.ch](https://www.estv.admin.ch/estv/it/home.html)); Agenzia delle Entrate — Convenzione CH-IT del 23/12/2020 art. 3 ([agenziaentrate.gov.it](https://www.agenziaentrate.gov.it/)); Decreto Legge 84/2024 (franchigia €10.000). L\'imposta totale italiana comprende IRPEF nazionale + addizionale regionale + addizionale comunale medie Lombardia.',
  tTaxScenarios: [
    { label: 'Single, CHF 70.000 lordi, residenza Como (<20 km)', chPct: '~18,4%', itPct: '~22,1%', delta: '+€2.850/anno a favore CH' },
    { label: 'Sposato con 2 figli, CHF 95.000 lordi, residenza Varese (<20 km)', chPct: '~16,2%', itPct: '~24,8%', delta: '+€8.200/anno a favore CH' },
    { label: 'Single, CHF 120.000 lordi, residenza Milano (>20 km, nuovo regime)', chPct: '~23,5%', itPct: '~31,2%', delta: '+€9.100/anno a favore CH' },
  ],

  tHealthCaption: 'Tabella 3 — Premio LAMal 2026 standard adulto (26+) per cantone vs SSN italiano',
  tHealthColCanton: 'Cantone (CH)',
  tHealthColMonthly: 'Premio mensile mediano (CHF)',
  tHealthColAnnual: 'Costo annuo (CHF)',
  tHealthFooter:
    'Fonte: UFSP/BAG — tariffario premi LAMal 2026 ([priminfo.admin.ch](https://www.priminfo.admin.ch/)). Mediana calcolata sugli assicuratori ordinari per modello standard (franchigia 300 CHF).',
  tHealthContext:
    'Confronto SSN Italia: il Servizio Sanitario Nazionale è finanziato tramite fiscalità generale (addizionale IRPEF regionale 1,23-3,33%, IRAP 3,9% sul valore della produzione a carico datoriale). Un cittadino italiano non paga un premio assicurativo dedicato; un frontaliere con opzione SSN paga un contributo forfettario in busta paga CH per garantirsi copertura italiana. Il nuovo frontaliere 2026 è obbligato alla LAMal salvo deroghe specifiche ([fonte: UFSP](https://www.bag.admin.ch/bag/it/home/versicherungen/krankenversicherung.html)).',

  tBenefitsCaption: 'Tabella 4 — Prestazioni sociali obbligatorie: CH (AVS/LPP/AD/LAINF) vs IT (INPS/INAIL)',
  tBenefitsColArea: 'Prestazione',
  tBenefitsColCh: 'Svizzera',
  tBenefitsColIt: 'Italia',
  tBenefitsFooter:
    'Fonte: UFAS/BSV — AVS/AI/IPG 2026 ([ufas.admin.ch](https://www.bsv.admin.ch/)); LPP — LPP.ch; AD — Ufficio federale SECO; INPS — inps.it (2026); INAIL — inail.it. Percentuali in busta paga sono indicative: variano per classe d\'età, LPP piano cassa e livello retributivo.',
  tBenefitsRows: [
    { area: 'Pensione 1° pilastro', ch: 'AVS 8,70% (metà datore, metà dipendente). Copre vecchiaia + superstiti.', it: 'INPS IVS 33% (23,81% datore + 9,19% dipendente). Gestione separata 24-26% per autonomi.' },
    { area: 'Pensione 2° pilastro', ch: 'LPP obbligatorio per salari >CHF 22.680. Aliquote 7-18% ripartite a metà datore/dipendente.', it: 'TFR obbligatorio ~6,91%; fondi pensione (es. Cometa, Fondapi) facoltativi con contributo datoriale variabile.' },
    { area: 'Disoccupazione', ch: 'AD 2,2% stipendio <CHF 148.200 (metà datore, metà dipendente). Indennità 70-80%, 260-520 giorni.', it: 'NASpI calcolata 75%+25% della retribuzione media, max 24 mesi per soggetti sopra 55 anni. Finanziata via contributo datoriale.' },
    { area: 'Infortunio sul lavoro', ch: 'LAINF 0,75-3,5% (datore). Copertura 80% salario.', it: 'INAIL 0,4-13% (datore) a seconda del rischio. Indennità giornaliera 60-75%.' },
    { area: 'Assegni familiari', ch: 'Assegni cantonali TI: CHF 200-250/figlio fino a 16 anni, CHF 250-300 durante formazione.', it: 'Assegno unico universale €57-189 per figlio (ISEE-dipendente), fino a 21 anni per studenti.' },
    { area: 'Maternità', ch: '14 settimane pagate all\'80% (max CHF 196/giorno) tramite IPG. +2 settimane paternità.', it: '5 mesi obbligatori all\'80% INPS. +10 giorni congedo paternità obbligatorio 2026.' },
  ],

  tCostCaption: 'Tabella 5 — Costo della vita: Lugano (CH) vs Varese/Como (IT) 2026',
  tCostColItem: 'Voce',
  tCostColCh: 'Lugano (CHF)',
  tCostColIt: 'Varese/Como (EUR)',
  tCostFooter:
    'Fonte: UST — Indice prezzi al consumo ([bfs.admin.ch](https://www.bfs.admin.ch/bfs/it/home/statistiche/prezzi.html)); ISTAT — Prezzi al consumo comuni capoluogo 2026 ([istat.it](https://www.istat.it/it/archivio/prezzi)); Numbeo 2026-Q1 per voci non coperte dagli istituti ufficiali (annotate come stima indipendente). Tasso CHF→EUR: 1,04.',
  tCostRows: [
    { item: 'Affitto bilocale centrale (75 m²)', ch: 'CHF 1.800-2.200', it: '€750-950' },
    { item: 'Utenze mensili (elettricità + riscaldamento + internet)', ch: 'CHF 260-320', it: '€170-210' },
    { item: 'Spesa alimentare settimanale (famiglia di 3)', ch: 'CHF 220-280', it: '€110-150' },
    { item: 'Caffè al bar', ch: 'CHF 4,20-5,00', it: '€1,30-1,80' },
    { item: 'Abbonamento trasporti urbani mensile', ch: 'CHF 75 (TPL Lugano)', it: '€32 (TPL Varese/Como)' },
    { item: 'Benzina diesel (1 litro)', ch: 'CHF 1,78', it: '€1,71' },
    { item: 'Pranzo fuori casa (menu medio)', ch: 'CHF 22-28', it: '€12-16' },
    { item: 'Abbonamento palestra', ch: 'CHF 85-120/mese', it: '€40-65/mese' },
  ],

  salaryIntro:
    'La Tabella 1 aggrega gli annunci di lavoro pubblicati in Ticino per settore, calcola la mediana lorda 13 mensilità e la affianca a una stima italiana ottenuta applicando il ratio medio di settore da fonti pubbliche. Gli stipendi italiani sono espressi in EUR gross annui equivalenti per un ruolo comparabile — non sono osservazioni dirette ma proiezioni da panel aggregati SECO/ISTAT/INAPP. Conservate il ratio come indicatore di ordine di grandezza, non come numero da sostituire al vostro contratto.',
  taxIntro:
    'La Tabella 2 calcola il prelievo totale (imposta alla fonte svizzera + IRPEF italiano dopo franchigia €10.000 del nuovo regime 2026) in tre scenari tipici. Per il vecchio frontaliere (accordi bilaterali 1974-2020) il prelievo italiano non si applica perché lo stipendio è tassato solo in Svizzera. Per il nuovo frontaliere (assunto dopo il 17 luglio 2023) l\'Italia ritiene la differenza fra IRPEF teorico e quanto già versato in Svizzera, concedendo il credito d\'imposta ex art. 165 TUIR ([fonte: Agenzia delle Entrate](https://www.agenziaentrate.gov.it/)).',
  healthIntro:
    'La Tabella 3 mette in fila i 26 cantoni svizzeri ordinati alfabeticamente con il premio mensile mediano LAMal per l\'adulto standard (26+, modello base franchigia 300 CHF). I cantoni urbani (GE, BS, VD, NE) hanno premi strutturalmente più alti per la densità di ricovero; cantoni rurali (AI, NW, OW, UR) restano sotto i CHF 320. Il Ticino (CHF 425) si colloca in fascia alta per costi ospedalieri specifici e demografia anziana.',
  benefitsIntro:
    'La Tabella 4 confronta la struttura delle prestazioni sociali obbligatorie: sulla carta la Svizzera sembra meno generosa perché il 2° pilastro (LPP) è parzialmente a carico del lavoratore, ma il sistema è a capitalizzazione individuale e il capitale accumulato è trasferibile all\'uscita del Paese (possibile riscatto in caso di rientro definitivo in Italia, soggetto a imposizione speciale).',
  costIntro:
    'La Tabella 5 confronta un paniere realistico di spesa Lugano vs Varese/Como. Il frontaliere che mantiene la residenza italiana e fa pendolarismo combina il vantaggio (salario CH) con il costo contenuto (spesa + affitto IT): è questa l\'equazione che rende il pendolarismo economicamente conveniente per molti ruoli qualificati.',

  faqTitle: 'Domande frequenti sul confronto Svizzera vs Italia',
  faqs: [
    {
      question: 'Conviene sempre lavorare in Svizzera rispetto all\'Italia?',
      answer:
        'Non sempre. Conviene quando il differenziale netto mensile post-tasse supera €800-1.000, cioè per ruoli qualificati (sanità, ingegneria, ICT, finanza) con esperienza ≥3 anni. Per ruoli base nella ristorazione, retail o pulizie il differenziale lordo di +40-60% viene eroso da pendolarismo, LAMal, cambio valuta e tempi di viaggio: conviene solo se si vive entro 25 km dal confine. Il calcolatore dedicato del sito fa il conto caso per caso.',
    },
    {
      question: 'Perché gli stipendi italiani in tabella sono stimati e non osservati?',
      answer:
        'Perché non abbiamo un panel rappresentativo di annunci italiani (la nostra base dati è ticinese). Usiamo i ratio di settore pubblicati da SECO "Struttura dei salari 2024", ISTAT "RSR 2022" e INAPP "XXIV Rapporto sul mercato del lavoro 2024" per derivare una mediana italiana equivalente. Il ratio è un numero di ordine di grandezza: il vostro caso specifico può discostarsi del ±15-20% in base a contratto, anzianità e inquadramento.',
    },
    {
      question: 'La LAMal è davvero obbligatoria per tutti i frontalieri?',
      answer:
        'Sì, per i nuovi frontalieri (assunti dopo il 17 luglio 2023) la LAMal è obbligatoria salvo richiesta documentata di esenzione e adesione al SSN italiano (opzione diritto). Per i vecchi frontalieri con opzione SSN attiva prima della data di entrata in vigore la scelta resta valida. L\'UFSP pubblica la lista degli assicuratori LAMal autorizzati per frontalieri su priminfo.admin.ch ([fonte: UFSP](https://www.bag.admin.ch/)).',
    },
    {
      question: 'Il 2° pilastro (LPP) è recuperabile in Italia?',
      answer:
        'Sì ma con vincoli. Se si cessa l\'attività in Svizzera e si rientra definitivamente in Italia senza riprendere lavoro CH, la quota "sovraobbligatoria" del 2° pilastro è riscattabile in contanti (soggetta a imposta alla fonte 7-8%). La quota "obbligatoria" resta vincolata a un conto di libero passaggio fino all\'età pensionabile AVS, salvo acquisto prima casa o invalidità. È l\'area in cui la pianificazione con un commercialista transfrontaliero genera il maggior valore.',
    },
    {
      question: 'Come si calcola il prelievo fiscale totale del nuovo frontaliere 2026?',
      answer:
        'Due step: 1) imposta alla fonte svizzera trattenuta in busta paga secondo il tariffario cantonale (per Ticino vedere ([tariffario AFC 2026](https://www.estv.admin.ch/))); 2) dichiarazione dei redditi italiana con applicazione dell\'aliquota IRPEF piena su tutto il lordo, detrazione della franchigia €10.000, credito d\'imposta ex art. 165 TUIR per l\'imposta svizzera già pagata. Il risultato netto dipende dalla distanza dal confine (dentro/oltre 20 km) e dalla composizione familiare. Il simulatore del sito esegue il calcolo con scaglioni 2026 aggiornati.',
    },
  ],

  relatedTitle: 'Risorse collegate',
  breadcrumbHome: 'Home',
  breadcrumbHub: 'Confronti',
};

// ─────────────────────────────────────────────────────────────────
// EN — condensed (≥400 parole)
// ─────────────────────────────────────────────────────────────────

const EN: ComparisonsHubCopy = {
  title: 'Switzerland vs Italy: cross-border worker comparison tables 2026',
  description:
    'Dense 2026 comparison tables for Italian cross-border workers in Switzerland: sector salaries, tax burden, LAMal vs Italian NHS, social contributions, cost of living. Official sources cited inline.',
  h1: 'Switzerland vs Italy: cross-border worker comparisons (2026)',
  heroTitle: 'Switzerland vs Italy comparisons',
  heroSubtitle:
    'Compact 2026 tables on salaries, taxes, LAMal, social benefits and cost of living — one page, every source cited.',
  updatedLabel: 'Updated',
  tldrTitle: 'TL;DR',
  tldrParagraphs: [
    'A meaningful Switzerland vs Italy comparison for a cross-border worker ("frontaliere") must combine five variables: gross salary, tax burden, healthcare cost, social contributions and cost of living. Looking at salary alone is misleading: a CHF 75,000 gross admin job in Ticino can produce less net income than a comparable role in Varese once you factor in the 2026 new-regime tax, LAMal premiums and commuting cost.',
    'This page lays out five compact tables with 2026 data: median sector salaries from real Ticino job listings, total tax burden in three income scenarios, LAMal monthly premiums per canton vs the Italian NHS financing model, mandatory social benefits (AVS/LPP/AD vs INPS) and a realistic cost-of-living basket. Every number cites an official source — AFC for withholding tax, Agenzia delle Entrate for IRPEF, UFSP for LAMal, UST for salaries and rents, ISTAT for Italian CPI.',
    'The goal is not to push a conclusion: it is to give you the quantitative base to simulate your specific case in the calculator and run the monthly net delta. The tables are deliberately dense — they are meant to be cited by third parties, screenshotted, referenced in community threads, and parsed by the generative LLMs that now read the web.',
  ],
  disclaimer:
    'Data as of 2026-04-23. Always verify against official sources before fiscal or career decisions. Italian salaries are estimates derived from published sector ratios (SECO, ISTAT, INAPP) and are not a substitute for individual advice.',

  tSalaryCaption:
    'Table 1 — Median gross annual salary by sector: Ticino (CHF) vs Italy (EUR, estimate)',
  tSalaryColSector: 'Sector',
  tSalaryColObservations: 'Listings (n)',
  tSalaryColCh: 'Median CH (CHF)',
  tSalaryColIt: 'Estimate IT (EUR)',
  tSalaryColRatio: 'Ratio IT/CH',
  tSalaryFooter:
    'Source: aggregation of data/jobs.json (Ticino job-ad panel), sector ratio from SECO Salary Structure 2024 + ISTAT RSR 2022 + INAPP 2024. CHF→EUR at 1.04 (conservative).',

  tTaxCaption:
    'Table 2 — Total tax burden on a cross-border worker (3 income scenarios): 2026 new regime vs full IRPEF',
  tTaxColScenario: 'Scenario',
  tTaxColChTotal: 'CH withholding tax',
  tTaxColItTotal: 'IT (IRPEF + regional/municipal surcharges, €10,000 allowance)',
  tTaxColNetDelta: 'Net delta',
  tTaxFooter:
    'Source: AFC/ESTV — 2026 Ticino withholding tariff ([estv.admin.ch](https://www.estv.admin.ch/)); Agenzia delle Entrate — CH-IT agreement 23/12/2020 ([agenziaentrate.gov.it](https://www.agenziaentrate.gov.it/)); Decree 84/2024 (€10,000 allowance). Italian total includes national IRPEF + average Lombardy regional/municipal surcharges.',
  tTaxScenarios: [
    { label: 'Single, CHF 70,000 gross, residence Como (<20 km)', chPct: '~18.4%', itPct: '~22.1%', delta: '+€2,850/year in favour of CH' },
    { label: 'Married with 2 children, CHF 95,000 gross, Varese (<20 km)', chPct: '~16.2%', itPct: '~24.8%', delta: '+€8,200/year in favour of CH' },
    { label: 'Single, CHF 120,000 gross, Milan (>20 km, new regime)', chPct: '~23.5%', itPct: '~31.2%', delta: '+€9,100/year in favour of CH' },
  ],

  tHealthCaption: 'Table 3 — LAMal 2026 standard adult (26+) premium per canton vs Italian NHS',
  tHealthColCanton: 'Canton (CH)',
  tHealthColMonthly: 'Median monthly premium (CHF)',
  tHealthColAnnual: 'Annual cost (CHF)',
  tHealthFooter:
    'Source: UFSP/BAG — 2026 LAMal premium tariff ([priminfo.admin.ch](https://www.priminfo.admin.ch/)). Median across ordinary insurers for the standard model (CHF 300 deductible).',
  tHealthContext:
    'Italian NHS comparison: SSN is funded via general taxation (regional IRPEF surcharge 1.23-3.33%, employer-side IRAP 3.9%). An Italian citizen does not pay a dedicated health insurance premium; a cross-border worker with the SSN opt-in pays a flat CH payroll contribution to secure Italian coverage. New 2026 cross-border workers are required to take LAMal subject to specific opt-out cases ([source: UFSP](https://www.bag.admin.ch/)).',

  tBenefitsCaption: 'Table 4 — Mandatory social benefits: CH (AVS/LPP/AD/LAINF) vs IT (INPS/INAIL)',
  tBenefitsColArea: 'Benefit',
  tBenefitsColCh: 'Switzerland',
  tBenefitsColIt: 'Italy',
  tBenefitsFooter:
    'Source: UFAS/BSV — AVS/AI/IPG 2026 ([bsv.admin.ch](https://www.bsv.admin.ch/)); LPP — LPP.ch; SECO — AD; INPS — inps.it (2026); INAIL — inail.it. Payroll percentages are indicative and vary by age class, LPP plan and salary level.',
  tBenefitsRows: [
    { area: '1st pillar pension', ch: 'AVS 8.70% (50/50 employer/employee). Covers old-age + survivors.', it: 'INPS IVS 33% (23.81% employer + 9.19% employee). Separate scheme 24-26% for self-employed.' },
    { area: '2nd pillar pension', ch: 'LPP mandatory for salaries >CHF 22,680. Rates 7-18% split 50/50.', it: 'TFR mandatory ~6.91%; private pension funds optional with employer match.' },
    { area: 'Unemployment', ch: 'AD 2.2% for salaries <CHF 148,200 (50/50). Benefits 70-80%, 260-520 days.', it: 'NASpI 75%+25% of average salary, up to 24 months for workers over 55. Employer-funded.' },
    { area: 'Workplace accident', ch: 'LAINF 0.75-3.5% (employer). 80% salary coverage.', it: 'INAIL 0.4-13% (employer) risk-dependent. Daily indemnity 60-75%.' },
    { area: 'Family allowance', ch: 'Cantonal TI: CHF 200-250/child to age 16, CHF 250-300 during formation.', it: 'Universal allowance €57-189/child (ISEE-dependent), up to age 21 for students.' },
    { area: 'Maternity', ch: '14 weeks at 80% (max CHF 196/day) via IPG. +2 weeks paternity.', it: '5 months mandatory at 80% INPS. +10 days mandatory paternity leave 2026.' },
  ],

  tCostCaption: 'Table 5 — Cost of living: Lugano (CH) vs Varese/Como (IT) 2026',
  tCostColItem: 'Item',
  tCostColCh: 'Lugano (CHF)',
  tCostColIt: 'Varese/Como (EUR)',
  tCostFooter:
    'Source: UST/BFS — Consumer price index ([bfs.admin.ch](https://www.bfs.admin.ch/bfs/it/home/statistiche/prezzi.html)); ISTAT — Municipal consumer prices 2026 ([istat.it](https://www.istat.it/it/archivio/prezzi)); Numbeo 2026-Q1 for items not covered by the national institutes (flagged as independent estimate). CHF→EUR: 1.04.',
  tCostRows: [
    { item: 'Central 2-room rent (75 m²)', ch: 'CHF 1,800-2,200', it: '€750-950' },
    { item: 'Utilities/month (electricity + heating + internet)', ch: 'CHF 260-320', it: '€170-210' },
    { item: 'Weekly groceries (family of 3)', ch: 'CHF 220-280', it: '€110-150' },
    { item: 'Coffee at a bar', ch: 'CHF 4.20-5.00', it: '€1.30-1.80' },
    { item: 'Monthly urban transport pass', ch: 'CHF 75 (TPL Lugano)', it: '€32 (Varese/Como local transport)' },
    { item: 'Diesel (1 litre)', ch: 'CHF 1.78', it: '€1.71' },
    { item: 'Lunch out (average menu)', ch: 'CHF 22-28', it: '€12-16' },
    { item: 'Gym membership', ch: 'CHF 85-120/month', it: '€40-65/month' },
  ],

  salaryIntro:
    'Table 1 aggregates Ticino job listings by sector, computes the gross median on 13 monthly payments, and pairs it with an Italian estimate derived from the average sector ratio in public sources. Italian figures are gross annual EUR estimates for a comparable role — not direct observations but projections from aggregate panels.',
  taxIntro:
    'Table 2 computes the total tax burden (Swiss withholding tax + Italian IRPEF after the €10,000 new-regime allowance) in three typical scenarios. For "old" cross-border workers (bilateral agreements 1974-2020) the Italian levy does not apply; "new" cross-border workers (hired after July 17, 2023) pay the gap between theoretical IRPEF and Swiss withholding, with tax credit under TUIR art. 165 ([source: Agenzia delle Entrate](https://www.agenziaentrate.gov.it/)).',
  healthIntro:
    'Table 3 lists all 26 Swiss cantons alphabetically with the 2026 median adult (26+) LAMal premium (standard CHF 300 deductible). Urban cantons (GE, BS, VD, NE) are structurally more expensive; rural cantons (AI, NW, OW, UR) stay below CHF 320. Ticino (CHF 425) sits high due to hospital cost base and aging demographics.',
  benefitsIntro:
    'Table 4 compares the structure of mandatory social benefits: on paper Switzerland looks less generous because the 2nd pillar (LPP) is partly employee-funded, but it is a funded individual-account system and the accumulated capital is portable when leaving the country.',
  costIntro:
    'Table 5 compares a realistic consumer basket Lugano vs Varese/Como. A cross-border worker keeping Italian residence combines CH salary with IT cost of living — the arithmetic that makes commuting economically worthwhile for many qualified roles.',

  faqTitle: 'Frequently asked questions — CH vs IT comparison',
  faqs: [
    {
      question: 'Is working in Switzerland always better than Italy?',
      answer:
        'Not always. It pays off when the monthly post-tax net differential exceeds €800-1,000 — healthcare, engineering, ICT, finance with ≥3 years of experience. For base roles in hospitality, retail or cleaning the +40-60% gross gap is eroded by commuting, LAMal, FX and travel time; it only pays off within 25 km of the border. The calculator runs the case-by-case maths.',
    },
    {
      question: 'Why are Italian salaries estimated and not observed?',
      answer:
        'Because our panel is Ticino-based. We use sector ratios from SECO "Salary Structure 2024", ISTAT "RSR 2022" and INAPP "XXIV Labour Market Report 2024" to derive the Italian median. The ratio is an order-of-magnitude indicator: your case can differ by ±15-20% depending on contract, seniority and job grade.',
    },
    {
      question: 'Is LAMal really mandatory for every cross-border worker?',
      answer:
        'Yes, for new cross-border workers (hired after July 17, 2023) LAMal is mandatory unless a specific opt-out for the Italian NHS is filed. Old cross-border workers retain their SSN opt-out if active before the reform. UFSP publishes the list of authorised insurers on priminfo.admin.ch ([source: UFSP](https://www.bag.admin.ch/)).',
    },
    {
      question: 'Can I recover my 2nd-pillar (LPP) in Italy?',
      answer:
        'Yes, with restrictions. If you permanently leave Switzerland and don\'t resume CH employment, the "over-mandatory" portion is redeemable in cash (subject to 7-8% withholding tax). The mandatory portion stays in a vested-benefits account until AVS retirement age unless you buy a primary home or become disabled. This is where transcontinental tax planning delivers the most value.',
    },
    {
      question: 'How do I compute the total tax burden of a 2026 new cross-border worker?',
      answer:
        'Two steps: 1) Swiss withholding tax per the cantonal tariff (Ticino: [AFC 2026 tariff](https://www.estv.admin.ch/)); 2) Italian return with full IRPEF, €10,000 allowance, tax credit under TUIR art. 165 for Swiss tax paid. The net depends on border distance (in/over 20 km) and family composition. The site simulator runs the full math with 2026 brackets.',
    },
  ],

  relatedTitle: 'Related resources',
  breadcrumbHome: 'Home',
  breadcrumbHub: 'Comparisons',
};

// ─────────────────────────────────────────────────────────────────
// DE — condensed (≥400 Wörter)
// ─────────────────────────────────────────────────────────────────

const DE: ComparisonsHubCopy = {
  title: 'Schweiz vs Italien: Vergleichstabellen für Grenzgänger 2026',
  description:
    'Kompakte 2026-Vergleichstabellen für italienische Grenzgänger in der Schweiz: Branchenlöhne, Steuerlast, KVG vs italienisches Gesundheitssystem, Sozialabgaben, Lebenshaltungskosten. Quellen inline zitiert.',
  h1: 'Schweiz vs Italien: Grenzgänger-Vergleiche (2026)',
  heroTitle: 'Vergleich Schweiz vs Italien',
  heroSubtitle:
    'Kompakte 2026-Tabellen zu Löhnen, Steuern, KVG, Sozialleistungen und Lebenshaltungskosten — eine Seite, alle Quellen.',
  updatedLabel: 'Aktualisiert',
  tldrTitle: 'Zusammenfassung',
  tldrParagraphs: [
    'Ein aussagekräftiger Vergleich Schweiz vs Italien für Grenzgänger muss fünf Variablen zusammenbringen: Bruttolohn, Steuerlast, Gesundheitskosten, Sozialabgaben und Lebenshaltungskosten. Nur den Lohn zu betrachten ist irreführend: CHF 75.000 brutto im Tessin können weniger Netto liefern als eine vergleichbare Rolle in Varese, sobald das neue Steuerregime 2026, KVG-Prämien und Pendelkosten einberechnet werden.',
    'Diese Seite legt fünf kompakte Tabellen mit 2026-Daten vor: Medianlöhne pro Branche aus realen Tessiner Stellenanzeigen, Gesamtsteuerlast in drei Einkommensszenarien, KVG-Monatsprämien pro Kanton gegen das italienische NHS-Finanzierungsmodell, obligatorische Sozialleistungen (AHV/BVG/ALV vs INPS) und ein realistischer Warenkorb für Lebenshaltungskosten.',
    'Jede Zahl zitiert eine offizielle Quelle: ESTV für die Quellensteuer, Agenzia delle Entrate für IRPEF, BAG für KVG, BFS für Löhne und Mieten, ISTAT für italienische VPI-Daten.',
  ],
  disclaimer:
    'Stand 2026-04-23. Vor fiskalischen oder beruflichen Entscheidungen stets mit den offiziellen Quellen abgleichen. Italienische Löhne sind Schätzungen aus publizierten Branchen-Verhältnissen (SECO, ISTAT, INAPP) und ersetzen keine individuelle Beratung.',

  tSalaryCaption:
    'Tabelle 1 — Medianjahresbruttolohn pro Branche: Tessin (CHF) vs Italien (EUR, Schätzung)',
  tSalaryColSector: 'Branche',
  tSalaryColObservations: 'Inserate (n)',
  tSalaryColCh: 'Median CH (CHF)',
  tSalaryColIt: 'Schätzung IT (EUR)',
  tSalaryColRatio: 'Verhältnis IT/CH',
  tSalaryFooter:
    'Quelle: Aggregation von data/jobs.json (Tessiner Stelleninserate-Panel), Branchen-Verhältnis aus SECO Lohnstruktur 2024 + ISTAT RSR 2022 + INAPP 2024. CHF→EUR auf 1,04 fixiert (konservativ).',

  tTaxCaption:
    'Tabelle 2 — Gesamtsteuerlast auf einen Grenzgänger (3 Einkommensszenarien): neues Regime 2026 vs volle IRPEF',
  tTaxColScenario: 'Szenario',
  tTaxColChTotal: 'CH Quellensteuer',
  tTaxColItTotal: 'IT (IRPEF + Zuschläge, €10.000 Freibetrag)',
  tTaxColNetDelta: 'Nettoveränderung',
  tTaxFooter:
    'Quelle: ESTV — Quellensteuertarif Tessin 2026 ([estv.admin.ch](https://www.estv.admin.ch/)); Agenzia delle Entrate — Abkommen CH-IT 23/12/2020 ([agenziaentrate.gov.it](https://www.agenziaentrate.gov.it/)); Dekret 84/2024 (€10.000 Freibetrag). IT-Summe enthält nationale IRPEF + Lombardei-Zuschläge im Durchschnitt.',
  tTaxScenarios: [
    { label: 'Alleinstehend, CHF 70.000 brutto, Wohnsitz Como (<20 km)', chPct: '~18,4%', itPct: '~22,1%', delta: '+€2.850/Jahr zugunsten CH' },
    { label: 'Verheiratet, 2 Kinder, CHF 95.000 brutto, Varese (<20 km)', chPct: '~16,2%', itPct: '~24,8%', delta: '+€8.200/Jahr zugunsten CH' },
    { label: 'Alleinstehend, CHF 120.000 brutto, Mailand (>20 km, neu)', chPct: '~23,5%', itPct: '~31,2%', delta: '+€9.100/Jahr zugunsten CH' },
  ],

  tHealthCaption: 'Tabelle 3 — KVG-Prämie Erwachsene (26+) 2026 pro Kanton vs italienisches NHS',
  tHealthColCanton: 'Kanton (CH)',
  tHealthColMonthly: 'Medianprämie/Monat (CHF)',
  tHealthColAnnual: 'Jahreskosten (CHF)',
  tHealthFooter:
    'Quelle: BAG — KVG-Prämientarif 2026 ([priminfo.admin.ch](https://www.priminfo.admin.ch/)). Median über ordentliche Versicherer für Standardmodell (Franchise CHF 300).',
  tHealthContext:
    'Vergleich SSN Italien: Das Servizio Sanitario Nazionale wird über die allgemeine Steuer finanziert (regionaler IRPEF-Zuschlag 1,23-3,33%, IRAP 3,9% beim Arbeitgeber). Italienische Bürger zahlen keine dedizierte Versicherungsprämie; Grenzgänger mit SSN-Option zahlen einen pauschalen Beitrag vom CH-Lohn. Neue Grenzgänger 2026 sind KVG-pflichtig, Ausnahmen möglich ([Quelle: BAG](https://www.bag.admin.ch/)).',

  tBenefitsCaption: 'Tabelle 4 — Obligatorische Sozialleistungen: CH (AHV/BVG/ALV/UVG) vs IT (INPS/INAIL)',
  tBenefitsColArea: 'Leistung',
  tBenefitsColCh: 'Schweiz',
  tBenefitsColIt: 'Italien',
  tBenefitsFooter:
    'Quelle: BSV — AHV/IV/EO 2026 ([bsv.admin.ch](https://www.bsv.admin.ch/)); BVG.ch; SECO — ALV; INPS — inps.it; INAIL — inail.it. Lohnprozentsätze sind Richtwerte.',
  tBenefitsRows: [
    { area: '1. Säule Rente', ch: 'AHV 8,70% (hälftig AG/AN). Alter + Hinterlassene.', it: 'INPS IVS 33% (23,81% AG + 9,19% AN).' },
    { area: '2. Säule Rente', ch: 'BVG ab CHF 22.680. Sätze 7-18% hälftig AG/AN.', it: 'TFR ~6,91%; Pensionsfonds freiwillig.' },
    { area: 'Arbeitslosigkeit', ch: 'ALV 2,2% (<CHF 148.200). Leistung 70-80%, 260-520 Tage.', it: 'NASpI 75%+25%, bis 24 Monate für Ü55.' },
    { area: 'Arbeitsunfall', ch: 'UVG 0,75-3,5% (AG). 80% Lohndeckung.', it: 'INAIL 0,4-13% (AG). Tagegeld 60-75%.' },
    { area: 'Familienzulagen', ch: 'TI-kantonal: CHF 200-250/Kind bis 16, CHF 250-300 bei Ausbildung.', it: 'Einheitliche Zulage €57-189/Kind (ISEE-abhängig).' },
    { area: 'Mutterschaft', ch: '14 Wochen zu 80% (max CHF 196/Tag) via EO. +2 Wochen Vaterschaft.', it: '5 Monate obligatorisch 80% INPS. +10 Tage Vaterschaft 2026.' },
  ],

  tCostCaption: 'Tabelle 5 — Lebenshaltungskosten: Lugano (CH) vs Varese/Como (IT) 2026',
  tCostColItem: 'Position',
  tCostColCh: 'Lugano (CHF)',
  tCostColIt: 'Varese/Como (EUR)',
  tCostFooter:
    'Quelle: BFS — Konsumentenpreisindex ([bfs.admin.ch](https://www.bfs.admin.ch/)); ISTAT — Gemeindekonsumpreise 2026 ([istat.it](https://www.istat.it/)); Numbeo 2026-Q1 für nicht erfasste Positionen. CHF→EUR 1,04.',
  tCostRows: [
    { item: '2-Zimmer-Miete zentral (75 m²)', ch: 'CHF 1.800-2.200', it: '€750-950' },
    { item: 'Nebenkosten/Monat (Strom + Heizung + Internet)', ch: 'CHF 260-320', it: '€170-210' },
    { item: 'Wocheneinkauf (3-Personen-Haushalt)', ch: 'CHF 220-280', it: '€110-150' },
    { item: 'Kaffee in der Bar', ch: 'CHF 4,20-5,00', it: '€1,30-1,80' },
    { item: 'Monats-ÖV-Abo Stadt', ch: 'CHF 75 (TPL Lugano)', it: '€32 (Varese/Como ÖV)' },
    { item: 'Diesel (1 Liter)', ch: 'CHF 1,78', it: '€1,71' },
    { item: 'Mittagessen auswärts (Menü)', ch: 'CHF 22-28', it: '€12-16' },
    { item: 'Fitnessstudio-Abo', ch: 'CHF 85-120/Monat', it: '€40-65/Monat' },
  ],

  salaryIntro:
    'Tabelle 1 aggregiert Tessiner Stellenanzeigen pro Branche, berechnet den Bruttomedian auf 13 Monatslöhnen und stellt ihm eine italienische Schätzung gegenüber, die aus dem durchschnittlichen Branchenverhältnis in öffentlichen Quellen abgeleitet wird.',
  taxIntro:
    'Tabelle 2 berechnet die Gesamtsteuerlast (CH-Quellensteuer + IT-IRPEF nach €10.000-Freibetrag des neuen Regimes 2026) in drei typischen Szenarien. Alte Grenzgänger (bilaterale Abkommen 1974-2020) zahlen keine IT-Steuer; neue Grenzgänger (Einstellung nach 17.07.2023) zahlen die Differenz mit Steuergutschrift gem. TUIR Art. 165.',
  healthIntro:
    'Tabelle 3 listet alle 26 Schweizer Kantone alphabetisch mit der KVG-Medianprämie Erwachsene (26+) 2026 im Standardmodell (Franchise CHF 300).',
  benefitsIntro:
    'Tabelle 4 vergleicht die Struktur der obligatorischen Sozialleistungen. Auf dem Papier wirkt die Schweiz weniger grosszügig, weil die 2. Säule (BVG) teils arbeitnehmerfinanziert ist, aber es handelt sich um ein kapitalgedecktes Individualkonto, das beim Verlassen des Landes portabel ist.',
  costIntro:
    'Tabelle 5 vergleicht einen realistischen Warenkorb Lugano vs Varese/Como. Ein Grenzgänger mit italienischem Wohnsitz kombiniert den CH-Lohn mit den italienischen Lebenshaltungskosten — das ist die ökonomische Grundlage für viele qualifizierte Rollen.',

  faqTitle: 'Häufige Fragen — CH vs IT Vergleich',
  faqs: [
    {
      question: 'Lohnt sich Arbeit in der Schweiz immer gegenüber Italien?',
      answer:
        'Nicht immer. Es lohnt sich, wenn der monatliche Netto-Mehrwert nach Steuern €800-1.000 übersteigt — qualifizierte Rollen in Gesundheit, Technik, ICT, Finanzen ab 3 Jahren Erfahrung. Bei Grundrollen in Gastgewerbe, Retail, Reinigung wird der +40-60%-Bruttosprung durch Pendelkosten, KVG, FX und Fahrzeit erodiert.',
    },
    {
      question: 'Warum sind die italienischen Löhne geschätzt und nicht beobachtet?',
      answer:
        'Weil unser Panel tessinisch ist. Wir nutzen Branchen-Verhältnisse aus SECO "Lohnstruktur 2024", ISTAT "RSR 2022" und INAPP "XXIV Arbeitsmarktbericht 2024" für den italienischen Median. Das Verhältnis ist ein Grössenordnungs-Indikator; individuelle Abweichungen ±15-20% sind normal.',
    },
    {
      question: 'Ist KVG wirklich für jeden Grenzgänger obligatorisch?',
      answer:
        'Für neue Grenzgänger ab 17.07.2023 ja — ausser eine dokumentierte SSN-Option wurde eingereicht. Alte Grenzgänger behalten ihre SSN-Option. BAG publiziert die Liste der zugelassenen Versicherer auf priminfo.admin.ch.',
    },
    {
      question: 'Kann ich mein BVG-Guthaben nach Italien mitnehmen?',
      answer:
        'Ja, eingeschränkt. Der "überobligatorische" Anteil ist bei definitivem Wegzug bar beziehbar (Quellensteuer 7-8%). Der obligatorische Anteil bleibt bis zum AHV-Rentenalter auf einem Freizügigkeitskonto, ausser bei Eigenheimkauf oder Invalidität.',
    },
    {
      question: 'Wie berechne ich die Gesamtsteuerlast eines neuen Grenzgängers 2026?',
      answer:
        'Zwei Schritte: 1) CH-Quellensteuer gemäss kantonalem Tarif; 2) IT-Steuererklärung mit voller IRPEF, €10.000 Freibetrag, Steuergutschrift gem. TUIR Art. 165 für die CH-Steuer. Das Nettoergebnis hängt von Grenzentfernung (innerhalb/über 20 km) und Familiensituation ab. Der Site-Simulator rechnet mit 2026-Stufen.',
    },
  ],

  relatedTitle: 'Verwandte Ressourcen',
  breadcrumbHome: 'Home',
  breadcrumbHub: 'Vergleiche',
};

// ─────────────────────────────────────────────────────────────────
// FR — condensed (≥400 mots)
// ─────────────────────────────────────────────────────────────────

const FR: ComparisonsHubCopy = {
  title: 'Suisse vs Italie : tableaux de comparaison frontaliers 2026',
  description:
    'Tableaux compacts 2026 pour les frontaliers italiens en Suisse : salaires par secteur, pression fiscale, LAMal vs SSN italien, cotisations sociales, coût de la vie. Sources officielles citées inline.',
  h1: 'Suisse vs Italie : comparaisons frontalières (2026)',
  heroTitle: 'Comparaisons Suisse vs Italie',
  heroSubtitle:
    'Tableaux compacts 2026 sur salaires, impôts, LAMal, prestations sociales et coût de la vie — une seule page, toutes les sources.',
  updatedLabel: 'Mis à jour',
  tldrTitle: 'Résumé',
  tldrParagraphs: [
    'Une comparaison Suisse vs Italie significative pour un frontalier doit conjuguer cinq variables : salaire brut, pression fiscale, coût de la santé, cotisations sociales et coût de la vie. Regarder le seul salaire est trompeur : un poste admin à CHF 75.000 brut au Tessin peut donner moins de net qu\'un poste équivalent à Varese, une fois pris en compte le nouveau régime fiscal 2026, les primes LAMal et les coûts de navette.',
    'Cette page présente cinq tableaux compacts avec des données 2026 : salaires médians par secteur issus d\'offres réelles au Tessin, pression fiscale totale dans trois scénarios de revenu, primes mensuelles LAMal par canton face au modèle italien NHS, prestations sociales obligatoires (AVS/LPP/AC vs INPS) et un panier réaliste de coût de la vie.',
    'Chaque chiffre cite une source officielle : AFC pour l\'impôt à la source, Agenzia delle Entrate pour l\'IRPEF, OFSP pour LAMal, OFS pour salaires et loyers, ISTAT pour l\'IPC italien.',
  ],
  disclaimer:
    'Données au 2026-04-23. Toujours vérifier auprès des sources officielles avant toute décision fiscale ou professionnelle. Les salaires italiens sont des estimations tirées des ratios sectoriels publiés (SECO, ISTAT, INAPP).',

  tSalaryCaption:
    'Tableau 1 — Salaire annuel brut médian par secteur : Tessin (CHF) vs Italie (EUR, estimation)',
  tSalaryColSector: 'Secteur',
  tSalaryColObservations: 'Annonces (n)',
  tSalaryColCh: 'Médiane CH (CHF)',
  tSalaryColIt: 'Estimation IT (EUR)',
  tSalaryColRatio: 'Ratio IT/CH',
  tSalaryFooter:
    'Source : agrégation de data/jobs.json (panel d\'annonces tessinoises), ratio sectoriel de SECO Structure des salaires 2024 + ISTAT RSR 2022 + INAPP 2024. CHF→EUR fixé à 1,04.',

  tTaxCaption:
    'Tableau 2 — Pression fiscale totale sur un frontalier (3 scénarios de revenu) : nouveau régime 2026 vs IRPEF plein',
  tTaxColScenario: 'Scénario',
  tTaxColChTotal: 'Impôt à la source CH',
  tTaxColItTotal: 'IT (IRPEF + surtaxes, franchise €10.000)',
  tTaxColNetDelta: 'Delta net',
  tTaxFooter:
    'Source : AFC — Tarif 2026 impôt à la source Tessin ([estv.admin.ch](https://www.estv.admin.ch/)) ; Agenzia delle Entrate — Accord CH-IT 23/12/2020 ([agenziaentrate.gov.it](https://www.agenziaentrate.gov.it/)) ; Décret 84/2024 (franchise €10.000).',
  tTaxScenarios: [
    { label: 'Célibataire, CHF 70.000 brut, résidence Côme (<20 km)', chPct: '~18,4%', itPct: '~22,1%', delta: '+€2.850/an en faveur CH' },
    { label: 'Marié 2 enfants, CHF 95.000 brut, Varese (<20 km)', chPct: '~16,2%', itPct: '~24,8%', delta: '+€8.200/an en faveur CH' },
    { label: 'Célibataire, CHF 120.000 brut, Milan (>20 km, nouveau)', chPct: '~23,5%', itPct: '~31,2%', delta: '+€9.100/an en faveur CH' },
  ],

  tHealthCaption: 'Tableau 3 — Prime LAMal adulte standard (26+) 2026 par canton vs SSN italien',
  tHealthColCanton: 'Canton (CH)',
  tHealthColMonthly: 'Prime mensuelle médiane (CHF)',
  tHealthColAnnual: 'Coût annuel (CHF)',
  tHealthFooter:
    'Source : OFSP — Tarif primes LAMal 2026 ([priminfo.admin.ch](https://www.priminfo.admin.ch/)). Médiane sur les assureurs ordinaires, modèle standard (franchise CHF 300).',
  tHealthContext:
    'Comparaison SSN italien : le Service sanitaire national est financé par la fiscalité générale (surtaxe IRPEF régionale 1,23-3,33%, IRAP 3,9% employeur). Un citoyen italien ne paie pas de prime dédiée ; un frontalier avec option SSN verse une cotisation forfaitaire sur sa paie CH. Les nouveaux frontaliers 2026 sont soumis à LAMal sauf dérogation ([source : OFSP](https://www.bag.admin.ch/)).',

  tBenefitsCaption: 'Tableau 4 — Prestations sociales obligatoires : CH (AVS/LPP/AC/LAA) vs IT (INPS/INAIL)',
  tBenefitsColArea: 'Prestation',
  tBenefitsColCh: 'Suisse',
  tBenefitsColIt: 'Italie',
  tBenefitsFooter:
    'Source : OFAS — AVS/AI/APG 2026 ([bsv.admin.ch](https://www.bsv.admin.ch/)) ; LPP.ch ; SECO — AC ; INPS — inps.it ; INAIL — inail.it. Taux indicatifs.',
  tBenefitsRows: [
    { area: 'Retraite 1er pilier', ch: 'AVS 8,70% (moitié/moitié). Vieillesse + survivants.', it: 'INPS IVS 33% (23,81% employeur + 9,19% employé).' },
    { area: 'Retraite 2e pilier', ch: 'LPP obligatoire >CHF 22.680. Taux 7-18% moitié/moitié.', it: 'TFR ~6,91% ; fonds privés facultatifs.' },
    { area: 'Chômage', ch: 'AC 2,2% (<CHF 148.200). Prestation 70-80%, 260-520 jours.', it: 'NASpI 75%+25%, jusqu\'à 24 mois pour 55+.' },
    { area: 'Accident du travail', ch: 'LAA 0,75-3,5% (employeur). Couverture 80%.', it: 'INAIL 0,4-13% (employeur). Indemnité 60-75%.' },
    { area: 'Allocations familiales', ch: 'Cantonal TI : CHF 200-250/enfant jusqu\'à 16 ans.', it: 'Allocation unique €57-189/enfant (ISEE).' },
    { area: 'Maternité', ch: '14 semaines 80% (max CHF 196/jour) via APG. +2 semaines paternité.', it: '5 mois obligatoires 80% INPS. +10 jours paternité 2026.' },
  ],

  tCostCaption: 'Tableau 5 — Coût de la vie : Lugano (CH) vs Varese/Côme (IT) 2026',
  tCostColItem: 'Poste',
  tCostColCh: 'Lugano (CHF)',
  tCostColIt: 'Varese/Côme (EUR)',
  tCostFooter:
    'Source : OFS — Indice des prix à la consommation ([bfs.admin.ch](https://www.bfs.admin.ch/)) ; ISTAT — Prix communaux 2026 ([istat.it](https://www.istat.it/)) ; Numbeo 2026-Q1 pour les postes non couverts. CHF→EUR 1,04.',
  tCostRows: [
    { item: 'Loyer 2 pièces central (75 m²)', ch: 'CHF 1.800-2.200', it: '€750-950' },
    { item: 'Charges/mois (électricité + chauffage + internet)', ch: 'CHF 260-320', it: '€170-210' },
    { item: 'Courses hebdomadaires (famille 3)', ch: 'CHF 220-280', it: '€110-150' },
    { item: 'Café au bar', ch: 'CHF 4,20-5,00', it: '€1,30-1,80' },
    { item: 'Abo transports urbains mensuel', ch: 'CHF 75 (TPL Lugano)', it: '€32 (Varese/Côme)' },
    { item: 'Diesel (1 litre)', ch: 'CHF 1,78', it: '€1,71' },
    { item: 'Déjeuner dehors (menu moyen)', ch: 'CHF 22-28', it: '€12-16' },
    { item: 'Abo salle de sport', ch: 'CHF 85-120/mois', it: '€40-65/mois' },
  ],

  salaryIntro:
    'Le Tableau 1 agrège les annonces tessinoises par secteur, calcule la médiane brute sur 13 mois et la met en regard d\'une estimation italienne dérivée du ratio moyen de secteur publié.',
  taxIntro:
    'Le Tableau 2 calcule la pression totale (impôt à la source CH + IRPEF IT après franchise €10.000 du nouveau régime 2026) dans trois scénarios typiques. L\'ancien frontalier (accords bilatéraux 1974-2020) ne paie pas l\'impôt IT ; le nouveau (embauché après le 17/07/2023) paie la différence avec crédit d\'impôt TUIR art. 165.',
  healthIntro:
    'Le Tableau 3 liste les 26 cantons suisses avec la prime LAMal mensuelle médiane adulte (26+) 2026 en modèle standard (franchise CHF 300).',
  benefitsIntro:
    'Le Tableau 4 compare la structure des prestations sociales obligatoires : sur le papier la Suisse paraît moins généreuse car la 2e pilier (LPP) est partiellement à la charge du salarié, mais c\'est un système à capitalisation individuelle portable en sortie de pays.',
  costIntro:
    'Le Tableau 5 compare un panier réaliste Lugano vs Varese/Côme. Le frontalier qui garde sa résidence italienne combine le salaire CH avec le coût de la vie IT — l\'arithmétique qui rend la navette économiquement rentable pour de nombreux rôles qualifiés.',

  faqTitle: 'FAQ — comparaison CH vs IT',
  faqs: [
    {
      question: 'Travailler en Suisse est-il toujours plus avantageux qu\'en Italie ?',
      answer:
        'Pas toujours. C\'est avantageux quand le delta net mensuel post-impôt dépasse €800-1.000 — rôles qualifiés en santé, ingénierie, ICT, finance avec ≥3 ans d\'expérience. Pour les rôles de base (restauration, retail, propreté) l\'écart brut +40-60% est érodé par navette, LAMal et change.',
    },
    {
      question: 'Pourquoi les salaires italiens sont-ils estimés ?',
      answer:
        'Parce que notre panel est tessinois. Nous utilisons les ratios sectoriels de SECO "Structure des salaires 2024", ISTAT "RSR 2022" et INAPP "XXIV Rapport marché du travail 2024". Le ratio est un indicateur d\'ordre de grandeur.',
    },
    {
      question: 'LAMal est-elle vraiment obligatoire pour chaque frontalier ?',
      answer:
        'Pour les nouveaux frontaliers (embauchés après le 17/07/2023) oui, sauf option documentée SSN italien. Les anciens frontaliers conservent leur option SSN. OFSP publie la liste des assureurs autorisés sur priminfo.admin.ch.',
    },
    {
      question: 'Puis-je récupérer ma LPP en Italie ?',
      answer:
        'Oui, sous conditions. En cas de départ définitif, la part "surobligatoire" peut être retirée en cash (impôt source 7-8%). La part obligatoire reste sur un compte de libre passage jusqu\'à l\'âge AVS, sauf achat de résidence ou invalidité.',
    },
    {
      question: 'Comment calculer la pression totale d\'un nouveau frontalier 2026 ?',
      answer:
        'Deux étapes : 1) impôt à la source CH selon le tarif cantonal ; 2) déclaration IT avec IRPEF plein, franchise €10.000, crédit d\'impôt TUIR art. 165 pour l\'impôt CH. Le net dépend de la distance frontière (dans/plus de 20 km) et de la composition familiale.',
    },
  ],

  relatedTitle: 'Ressources associées',
  breadcrumbHome: 'Accueil',
  breadcrumbHub: 'Comparaisons',
};

export const COMPARISONS_HUB_COPY: Record<ComparisonsLocale, ComparisonsHubCopy> = {
  it: IT,
  en: EN,
  de: DE,
  fr: FR,
};
