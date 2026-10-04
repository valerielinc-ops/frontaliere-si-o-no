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
  healthUnavailable: string;
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
  title: 'Confronti Svizzera-Italia per frontalieri 2026',
  description:
    'Confronti dettagliati Svizzera vs Italia per frontalieri: stipendi per settore, tassazione, LAMal vs SSN, contributi sociali, costo della vita. Dati 2026 con fonti ufficiali.',
  h1: 'Confronti Svizzera vs Italia per frontalieri (2026)',
  heroTitle: 'Confronti Svizzera vs Italia',
  heroSubtitle:
    'Tabelle dense con dati 2026 su stipendi, tasse, LAMal, contributi e costo della vita — una sola pagina, tutte le fonti ufficiali.',
  updatedLabel: 'Aggiornato',
  tldrTitle: 'In sintesi',
  tldrParagraphs: [
    `Un confronto tra Svizzera e Italia richiede salario, imposte, contributi, sanità, costi di viaggio e condizioni personali. Nessun importo lordo o distanza dal confine dimostra da solo quale offerta sia più conveniente.`,
    `Il campione salariale deriva dagli annunci ticinesi ammissibili. Un confronto italiano senza osservazioni equivalenti e un prelievo fiscale senza parametri individuali restano non disponibili. Consulta separatamente le fonti e le condizioni di ogni tabella.`,
    `Usa i dati disponibili come punto di partenza per uno scenario personale riproducibile. Conserva anno, numerosità e limiti del campione quando citi una tabella.`,
  ],
  disclaimer: `Il panel non contiene osservazioni italiane comparabili: mediana italiana e rapporto IT/CH non sono disponibili. Verificare condizioni contrattuali e requisiti individuali nelle fonti competenti.`,

  tSalaryCaption: `Tabella 1 — Salari annui dichiarati nel panel ticinese e disponibilità del confronto italiano`,
  tSalaryColSector: 'Settore',
  tSalaryColObservations: 'Offerte (n)',
  tSalaryColCh: 'Mediana CH (CHF)',
  tSalaryColIt: `Mediana IT (non disponibile)`,
  tSalaryColRatio: 'Ratio IT/CH',
  tSalaryFooter: `Fonte: panel degli annunci ticinesi del 2026, condiviso con il CSV del report annuale. Solo range dichiarati, CHF e periodo annuale espliciti; almeno dieci osservazioni per settore. Le colonne italiane e il rapporto restano indisponibili senza un panel comparabile. Nessun cambio o rapporto di settore viene presunto.`,

  tTaxCaption: `Tabella 2 — Scenari da simulare: prelievo fiscale non calcolato in questa tabella`,
  tTaxColScenario: 'Scenario',
  tTaxColChTotal: 'Prelievo CH (imposta alla fonte)',
  tTaxColItTotal: 'Prelievo IT (IRPEF + addizionali, franchigia €10.000)',
  tTaxColNetDelta: 'Delta netto',
  tTaxFooter: `Le percentuali non sono disponibili senza un calcolo con parametri individuali. Consulta il simulatore e le [FAQ ufficiali AFC](https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf).`,
  tTaxScenarios: [
    { label: 'Single, CHF 70.000 lordi, residenza Como', chPct: 'N/D', itPct: 'N/D', delta: 'N/D' },
    { label: 'Sposato con 2 figli, CHF 95.000 lordi, residenza Varese', chPct: 'N/D', itPct: 'N/D', delta: 'N/D' },
    { label: 'Single, CHF 120.000 lordi, residenza Milano', chPct: 'N/D', itPct: 'N/D', delta: 'N/D' },
  ],

  tHealthCaption: "Tabella 3 — Premi LAMal per residenti in Svizzera: mediana delle osservazioni cantonali",
  tHealthColCanton: 'Cantone (CH)',
  tHealthColMonthly: 'Premio mensile mediano (CHF)',
  tHealthColAnnual: 'Costo annuo (CHF)',
  tHealthFooter:
    "Fonte: [UFSP/Priminfo](https://www.priminfo.admin.ch/). Calcolo della mediana delle tariffe osservate per assicuratore e regione: adulti da 26 anni, modello standard, franchigia CHF 300, senza infortuni. Importi arrotondati; non è una media ponderata per assicurati né un preventivo personale.",
  tHealthContext:
    "Per chi risiede in Italia valgono i premi UE del Paese di domicilio, non questa tabella cantonale. Il diritto di opzione SSN richiede, per gli aventi diritto, domanda formale al Cantone di lavoro entro tre mesi. Il contributo sanitario delle categorie previste dalla legge 213/2023 è distinto dai premi LAMal e dall’iscrizione volontaria SSN: 3–6% del salario netto svizzero, minimo 30 e massimo 200 EUR per mese lavorato, versati alla Regione secondo i provvedimenti applicabili. Verificare requisiti, aliquota e scadenze. [Decreto 14 novembre 2025](https://www.gazzettaufficiale.it/eli/id/2025/12/18/25A06706/sg).",

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

  salaryIntro: `La tabella descrive la mediana dei punti medi dei range salariali ammissibili. Non misura i salari effettivamente versati e non converte importi mensili usando tredicesime presunte. Il confronto con l’Italia richiede osservazioni equivalenti per ruolo, esperienza e orario, assenti nel panel.`,
  taxIntro: `L’accordo del 2020 è applicabile dal 2024. I nuovi frontalieri fiscali pagano l’80% dell’imposta alla fonte svizzera ordinaria e l’imposta italiana con credito. Il regime transitorio richiede attività fiscale qualificata nel periodo 31 dicembre 2018–17 luglio 2023; non basta la data di assunzione. La qualifica richiede residenza in un comune dell’elenco ufficiale dei 20 km, lavoro in TI/GR/VS e rientro in linea di principio quotidiano. [FAQ AFC](https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf).`,
  healthIntro:
    "La tabella confronta soltanto osservazioni disponibili per residenti in Svizzera. I cantoni senza almeno tre osservazioni standard verificabili non ricevono un prezzo sostitutivo. Il premio personale dipende da assicuratore e regione: per il domicilio italiano usare il comparatore con residenza Italia.",
  healthUnavailable: "Dati cantonali verificabili non disponibili per questo anno. Consulta Priminfo; nessun premio viene stimato in sostituzione.",
  benefitsIntro:
    "La Tabella 4 confronta le prestazioni sociali. I contributi AVS non vengono trasferiti all’INPS: ciascuno Stato determina e paga la propria pensione. Per il 2° pilastro occorre distinguere le prestazioni al pensionamento dal prelievo anticipato per partenza prima del pensionamento.",
  costIntro:
    'La Tabella 5 confronta un paniere realistico di spesa Lugano vs Varese/Como. Il frontaliere che mantiene la residenza italiana e fa pendolarismo combina il vantaggio (salario CH) con il costo contenuto (spesa + affitto IT): è questa l\'equazione che rende il pendolarismo economicamente conveniente per molti ruoli qualificati.',

  faqTitle: 'Domande frequenti sul confronto Svizzera vs Italia',
  faqs: [
    {
      question: 'Conviene sempre lavorare in Svizzera rispetto all\'Italia?',
      answer: `Non esiste una soglia universale di convenienza: confronta offerte effettive, imposte, contributi, costi di viaggio e tempo personale. Il solo campione salariale non dimostra il vantaggio individuale.`,
    },
    {
      question: `Perché il confronto salariale italiano non è disponibile?`,
      answer: `Manca un panel italiano comparabile per ruolo, esperienza e orario. Per questo non pubblichiamo una mediana italiana o un rapporto stimato da costanti.`,
    },
    {
      question: 'La LAMal è davvero obbligatoria per tutti i frontalieri?',
      answer:
        'Sì, per i nuovi frontalieri (assunti dopo il 17 luglio 2023) la LAMal è obbligatoria salvo richiesta documentata di esenzione e adesione al SSN italiano (opzione diritto). Per i vecchi frontalieri con opzione SSN attiva prima della data di entrata in vigore la scelta resta valida. L\'UFSP pubblica la lista degli assicuratori LAMal autorizzati per frontalieri su priminfo.admin.ch ([fonte: UFSP](https://www.bag.admin.ch/)).',
    },
    {
      question: 'Il 2° pilastro (LPP) è recuperabile in Italia?',
      answer:
        "Il rientro in Italia prima del pensionamento non rende automaticamente prelevabile tutto il 2° pilastro. In caso di assicurazione obbligatoria italiana per vecchiaia, invalidità e superstiti, la parte LPP obbligatoria resta vincolata in Svizzera. La parte sovraobbligatoria segue regole distinte: la cassa pensione verifica le condizioni del pagamento. Non è un divieto generale delle prestazioni al pensionamento. [Fonte: AVS/AI, Lasciare la Svizzera](https://www.ahv-iv.ch/p/880.i).",
    },
    {
      question: 'Come si calcola il prelievo fiscale totale del nuovo frontaliere 2026?',
      answer: `Individua lo status fiscale e applica la tariffa alla fonte svizzera al profilo familiare e reddituale. Per i nuovi frontalieri qualificati calcola poi IRPEF e addizionali italiane considerando deduzioni e franchigia se spettanti, e sottrai il credito applicabile per l’imposta svizzera. Considera anche contributi e costi personali prima di confrontare il netto. Usa il simulatore con tutti i parametri del tuo caso.`,
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
    `Comparing Switzerland and Italy requires pay, tax, contributions, healthcare, commuting costs and personal circumstances. No gross amount or distance from the border alone establishes which offer is preferable.`,
    `The salary sample uses eligible Ticino listings. An Italian comparison without equivalent observations and a tax burden without individual inputs remain unavailable. Check the sources and conditions of each table separately.`,
    `Use available observations as a starting point for a reproducible personal scenario. Preserve the year, sample size and limitations when citing a table.`,
  ],
  disclaimer: `The panel contains no comparable Italian observations: the Italian median and IT/CH ratio are unavailable. Verify contractual terms and individual eligibility with the relevant sources.`,

  tSalaryCaption: `Table 1 — Reported annual salaries in the Ticino panel and Italian comparison availability`,
  tSalaryColSector: 'Sector',
  tSalaryColObservations: 'Listings (n)',
  tSalaryColCh: 'Median CH (CHF)',
  tSalaryColIt: `IT median (unavailable)`,
  tSalaryColRatio: 'Ratio IT/CH',
  tSalaryFooter: `Source: 2026 Ticino listings, shared with the annual report CSV. Only reported ranges with explicit CHF currency and annual period; at least ten observations per sector. Italian values and ratios remain unavailable without a comparable panel. No exchange rate or sector ratio is assumed.`,

  tTaxCaption: `Table 2 — Scenarios to simulate: tax burden not calculated in this table`,
  tTaxColScenario: 'Scenario',
  tTaxColChTotal: 'CH withholding tax',
  tTaxColItTotal: 'IT (IRPEF + regional/municipal surcharges, €10,000 allowance)',
  tTaxColNetDelta: 'Net delta',
  tTaxFooter: `Percentages are unavailable without an individual calculation. Consult the calculator and [official FTA FAQs](https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf).`,
  tTaxScenarios: [
    { label: 'Single, CHF 70,000 gross, residence Como', chPct: 'N/D', itPct: 'N/D', delta: 'N/D' },
    { label: 'Married with 2 children, CHF 95,000 gross, Varese', chPct: 'N/D', itPct: 'N/D', delta: 'N/D' },
    { label: 'Single, CHF 120,000 gross, Milan', chPct: 'N/D', itPct: 'N/D', delta: 'N/D' },
  ],

  tHealthCaption: "Table 3 — LAMal for Swiss residents: median of observed canton premiums",
  tHealthColCanton: 'Canton (CH)',
  tHealthColMonthly: 'Median monthly premium (CHF)',
  tHealthColAnnual: 'Annual cost (CHF)',
  tHealthFooter:
    "Source: [FOPH/Priminfo](https://www.priminfo.admin.ch/). Median of observed insurer/region tariffs: adults aged 26+, standard model, CHF 300 deductible, without accident cover. Rounded amounts; neither an insured-population weighted average nor a personal quote.",
  tHealthContext:
    "Italian residents use country-of-residence EU premiums, not this canton table. Eligible workers opting for the SSN must formally request exemption from their canton of employment within three months. The health contribution for the categories covered by Law 213/2023 differs from LAMal premiums and voluntary SSN registration: 3–6% of net Swiss salary, EUR 30–200 per worked month, paid to the Region under applicable measures. Check eligibility, rate and deadlines. [Decree of 14 November 2025](https://www.gazzettaufficiale.it/eli/id/2025/12/18/25A06706/sg).",

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

  salaryIntro: `The table shows the median of eligible salary-range midpoints. It does not measure salaries actually paid or convert monthly amounts using assumed thirteenth payments. Comparing Italy requires equivalent observations by role, experience and hours, which this panel does not provide.`,
  taxIntro: `The 2020 agreement applies from 2024. New qualifying cross-border workers pay 80% of ordinary Swiss withholding tax and Italian tax with a credit. Transitional status requires qualifying fiscal employment during 31 December 2018–17 July 2023, not merely an employment start date. Qualification requires residence in an official 20 km municipality, work in TI/GR/VS and return home in principle daily. [FTA FAQs](https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf).`,
  healthIntro:
    "The table compares available observations for Swiss residents only. Cantons without at least three verifiable standard-premium observations receive no substitute price. Personal premiums depend on insurer and region; residents of Italy should select Italy in the comparator.",
  healthUnavailable: "Verifiable canton data is unavailable for this year. Consult Priminfo; no substitute premium is estimated.",
  benefitsIntro:
    "Table 4 compares social benefits. OASI contributions are not transferred to INPS: each country determines and pays its own pension. For occupational pensions, distinguish retirement benefits from an early cash withdrawal on departure before retirement.",
  costIntro:
    'Table 5 compares a realistic consumer basket Lugano vs Varese/Como. A cross-border worker keeping Italian residence combines CH salary with IT cost of living — the arithmetic that makes commuting economically worthwhile for many qualified roles.',

  faqTitle: 'Frequently asked questions — CH vs IT comparison',
  faqs: [
    {
      question: 'Is working in Switzerland always better than Italy?',
      answer: `There is no universal break-even threshold: compare actual offers, tax, contributions, travel costs and personal time. This salary sample alone cannot establish individual benefits.`,
    },
    {
      question: `Why is the Italian salary comparison unavailable?`,
      answer: `There is no Italian panel matched by role, experience and hours. We therefore publish neither an Italian median nor a ratio estimated from constants.`,
    },
    {
      question: 'Is LAMal really mandatory for every cross-border worker?',
      answer:
        'Yes, for new cross-border workers (hired after July 17, 2023) LAMal is mandatory unless a specific opt-out for the Italian NHS is filed. Old cross-border workers retain their SSN opt-out if active before the reform. UFSP publishes the list of authorised insurers on priminfo.admin.ch ([source: UFSP](https://www.bag.admin.ch/)).',
    },
    {
      question: 'Can I recover my 2nd-pillar (LPP) in Italy?',
      answer:
        "Returning to Italy before retirement does not automatically make the entire occupational pension withdrawable. If compulsory Italian old-age, disability and survivors insurance applies, the mandatory pension portion remains vested in Switzerland. The extra-mandatory portion follows separate rules: the pension fund checks the payment conditions. This is not a general restriction on normal retirement benefits. [Source: OASI/DI, Leaving Switzerland](https://www.ahv-iv.ch/p/880.i).",
    },
    {
      question: 'How do I compute the total tax burden of a 2026 new cross-border worker?',
      answer: `Identify fiscal status and apply the Swiss withholding tariff for the income and family profile. For qualifying new cross-border workers, then calculate Italian IRPEF and local surcharges, allowing applicable deductions and allowances, and subtract the permitted Swiss-tax credit. Include contributions and personal costs before comparing net income. Use the calculator with all individual inputs.`,
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
    `Ein Vergleich Schweiz–Italien verlangt Lohn, Steuern, Beiträge, Gesundheits- und Pendelkosten sowie persönliche Umstände. Weder ein Bruttobetrag noch die Grenzentfernung allein beweist, welches Angebot vorteilhafter ist.`,
    `Die Lohnstichprobe beruht auf zulässigen Tessiner Anzeigen. Italienvergleiche ohne gleichwertige Beobachtungen und Steuerlasten ohne persönliche Angaben bleiben nicht verfügbar. Prüfen Sie Quellen und Bedingungen jeder Tabelle getrennt.`,
    `Nutzen Sie vorhandene Beobachtungen als Ausgangspunkt eines nachvollziehbaren persönlichen Szenarios. Nennen Sie Jahr, Stichprobengrösse und Grenzen beim Zitieren.`,
  ],
  disclaimer: `Das Panel enthält keine vergleichbaren italienischen Beobachtungen: italienischer Median und Verhältnis IT/CH sind nicht verfügbar. Prüfen Sie Vertragsbedingungen und persönliche Voraussetzungen bei den zuständigen Quellen.`,

  tSalaryCaption: `Tabelle 1 — Deklarierte Jahreslöhne im Tessiner Panel und Verfügbarkeit italienischer Vergleichswerte`,
  tSalaryColSector: 'Branche',
  tSalaryColObservations: 'Inserate (n)',
  tSalaryColCh: 'Median CH (CHF)',
  tSalaryColIt: `IT-Median (nicht verfügbar)`,
  tSalaryColRatio: 'Verhältnis IT/CH',
  tSalaryFooter: `Quelle: Tessiner Anzeigen aus 2026, entsprechend dem CSV des Jahresberichts. Nur deklarierte Spannen mit ausdrücklicher CHF-Währung und Jahresperiode; mindestens zehn Beobachtungen je Branche. Italienische Werte und Verhältnisse fehlen ohne vergleichbares Panel. Kein Wechselkurs oder Branchenverhältnis wird unterstellt.`,

  tTaxCaption: `Tabelle 2 — Zu simulierende Szenarien: Steuerlast hier nicht berechnet`,
  tTaxColScenario: 'Szenario',
  tTaxColChTotal: 'CH Quellensteuer',
  tTaxColItTotal: 'IT (IRPEF + Zuschläge, €10.000 Freibetrag)',
  tTaxColNetDelta: 'Nettoveränderung',
  tTaxFooter: `Ohne individuelle Berechnung sind Prozentsätze nicht verfügbar. Nutzen Sie Rechner und [offizielle ESTV-FAQ](https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf).`,
  tTaxScenarios: [
    { label: 'Alleinstehend, CHF 70.000 brutto, Wohnsitz Como', chPct: 'N/D', itPct: 'N/D', delta: 'N/D' },
    { label: 'Verheiratet, 2 Kinder, CHF 95.000 brutto, Varese', chPct: 'N/D', itPct: 'N/D', delta: 'N/D' },
    { label: 'Alleinstehend, CHF 120.000 brutto, Mailand', chPct: 'N/D', itPct: 'N/D', delta: 'N/D' },
  ],

  tHealthCaption: "Tabelle 3 — KVG für Schweizer Wohnsitz: Median beobachteter Kantonsprämien",
  tHealthColCanton: 'Kanton (CH)',
  tHealthColMonthly: 'Medianprämie/Monat (CHF)',
  tHealthColAnnual: 'Jahreskosten (CHF)',
  tHealthFooter:
    "Quelle: [BAG/Priminfo](https://www.priminfo.admin.ch/). Median beobachteter Versicherer-/Regionstarife: Erwachsene ab 26, Standardmodell, Franchise CHF 300, ohne Unfall. Gerundete Beträge; kein nach Versicherten gewichteter Durchschnitt und keine persönliche Offerte.",
  tHealthContext:
    "Bei Wohnsitz in Italien gelten EU-Prämien des Wohnsitzlands, nicht diese Kantonstabelle. Berechtigte müssen die SSN-Option binnen drei Monaten formell beim Arbeitskanton beantragen. Der Gesundheitsbeitrag für Kategorien nach Gesetz 213/2023 ist von KVG-Prämien und freiwilliger SSN-Einschreibung zu unterscheiden: 3–6% des Schweizer Nettolohns, 30–200 EUR je gearbeitetem Monat, gemäss regionalen Bestimmungen an die Region bezahlt. Voraussetzungen, Satz und Fristen prüfen. [Dekret vom 14. November 2025](https://www.gazzettaufficiale.it/eli/id/2025/12/18/25A06706/sg).",

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

  salaryIntro: `Die Tabelle zeigt den Median der zulässigen Spannenmittelpunkte. Sie misst keine ausbezahlten Löhne und rechnet Monatsbeträge nicht mit vermuteten dreizehnten Zahlungen um. Ein Italienvergleich benötigt gleichwertige Beobachtungen zu Funktion, Erfahrung und Arbeitszeit, die im Panel fehlen.`,
  taxIntro: `Das Abkommen von 2020 gilt seit 2024. Neue steuerlich qualifizierte Grenzgänger zahlen 80% der ordentlichen Schweizer Quellensteuer und italienische Steuer mit Anrechnung. Der Übergangsstatus verlangt qualifizierte Tätigkeit zwischen 31. Dezember 2018 und 17. Juli 2023, nicht nur ein Einstellungsdatum. Erforderlich sind Wohnsitz in einer Gemeinde der offiziellen 20-km-Liste, Arbeit in TI/GR/VS und grundsätzlich tägliche Rückkehr. [ESTV-FAQ](https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf).`,
  healthIntro:
    "Die Tabelle vergleicht nur verfügbare Beobachtungen für Personen mit Schweizer Wohnsitz. Für Kantone mit weniger als drei überprüfbaren Standardprämien wird kein Ersatzpreis angezeigt. Persönliche Prämien hängen von Versicherer und Region ab; bei Wohnsitz Italien im Vergleich Italien auswählen.",
  healthUnavailable: "Für dieses Jahr sind keine überprüfbaren Kantonsdaten verfügbar. Priminfo konsultieren; es werden keine Ersatzprämien geschätzt.",
  benefitsIntro:
    "Tabelle 4 vergleicht Sozialleistungen. AHV-Beiträge werden nicht an die INPS übertragen: Jeder Staat bestimmt und zahlt seine eigene Rente. Bei der beruflichen Vorsorge sind Altersleistungen von einer vorzeitigen Barauszahlung wegen Wegzugs vor der Pensionierung zu unterscheiden.",
  costIntro:
    'Tabelle 5 vergleicht einen realistischen Warenkorb Lugano vs Varese/Como. Ein Grenzgänger mit italienischem Wohnsitz kombiniert den CH-Lohn mit den italienischen Lebenshaltungskosten — das ist die ökonomische Grundlage für viele qualifizierte Rollen.',

  faqTitle: 'Häufige Fragen — CH vs IT Vergleich',
  faqs: [
    {
      question: 'Lohnt sich Arbeit in der Schweiz immer gegenüber Italien?',
      answer: `Es gibt keine allgemeine Vorteilsschwelle: Vergleichen Sie konkrete Angebote, Steuern, Beiträge, Reisekosten und Zeit. Die Lohnstichprobe allein belegt keinen persönlichen Vorteil.`,
    },
    {
      question: `Warum ist der italienische Lohnvergleich nicht verfügbar?`,
      answer: `Es fehlt ein nach Funktion, Erfahrung und Arbeitszeit vergleichbares italienisches Panel. Deshalb veröffentlichen wir weder italienischen Median noch aus Konstanten geschätztes Verhältnis.`,
    },
    {
      question: 'Ist KVG wirklich für jeden Grenzgänger obligatorisch?',
      answer:
        'Für neue Grenzgänger ab 17.07.2023 ja — ausser eine dokumentierte SSN-Option wurde eingereicht. Alte Grenzgänger behalten ihre SSN-Option. BAG publiziert die Liste der zugelassenen Versicherer auf priminfo.admin.ch.',
    },
    {
      question: 'Kann ich mein BVG-Guthaben nach Italien mitnehmen?',
      answer:
        "Die Rückkehr nach Italien vor der Pensionierung ermöglicht nicht automatisch den Bezug des gesamten BVG-Guthabens. Bei obligatorischer Versicherung für Alter, Invalidität und Hinterlassene in Italien bleibt der obligatorische Anteil in der Schweiz gebunden. Für den überobligatorischen Anteil gelten andere Regeln; die Pensionskasse prüft die Auszahlungsvoraussetzungen. Das ist kein allgemeines Verbot regulärer Altersleistungen. [Quelle: AHV/IV, Die Schweiz verlassen](https://www.ahv-iv.ch/p/880.i).",
    },
    {
      question: 'Wie berechne ich die Gesamtsteuerlast eines neuen Grenzgängers 2026?',
      answer: `Bestimmen Sie den steuerlichen Status und wenden Sie den Schweizer Quellensteuertarif auf Einkommen und Familienprofil an. Bei qualifizierten neuen Grenzgängern berechnen Sie danach italienische IRPEF und Zuschläge mit anwendbaren Abzügen und Freibeträgen sowie der zulässigen Anrechnung der Schweizer Steuer. Berücksichtigen Sie Beiträge und persönliche Kosten vor dem Nettovergleich. Nutzen Sie den Rechner mit allen individuellen Angaben.`,
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
    `Comparer la Suisse et l’Italie exige salaire, impôts, cotisations, santé, trajet et situation personnelle. Aucun montant brut ni distance à la frontière ne démontre seul quelle offre est préférable.`,
    `L’échantillon salarial utilise les annonces tessinoises admissibles. Une comparaison italienne sans observations équivalentes et une fiscalité sans paramètres individuels restent indisponibles. Vérifiez séparément les sources et conditions de chaque tableau.`,
    `Utilisez les observations disponibles comme point de départ d’un scénario personnel reproductible. Conservez année, effectifs et limites lorsque vous citez un tableau.`,
  ],
  disclaimer: `Le panel ne contient pas d’observations italiennes comparables : médiane italienne et ratio IT/CH sont indisponibles. Vérifiez les conditions contractuelles et personnelles auprès des sources compétentes.`,

  tSalaryCaption: `Tableau 1 — Salaires annuels déclarés du panel tessinois et disponibilité de la comparaison italienne`,
  tSalaryColSector: 'Secteur',
  tSalaryColObservations: 'Annonces (n)',
  tSalaryColCh: 'Médiane CH (CHF)',
  tSalaryColIt: `Médiane IT (indisponible)`,
  tSalaryColRatio: 'Ratio IT/CH',
  tSalaryFooter: `Source : annonces tessinoises de 2026, identiques au panel du CSV annuel. Uniquement des fourchettes déclarées en CHF et à période annuelle explicites ; au moins dix observations par secteur. Valeurs italiennes et ratios restent indisponibles sans panel comparable. Aucun change ou ratio sectoriel n’est supposé.`,

  tTaxCaption: `Tableau 2 — Scénarios à simuler : fiscalité non calculée dans ce tableau`,
  tTaxColScenario: 'Scénario',
  tTaxColChTotal: 'Impôt à la source CH',
  tTaxColItTotal: 'IT (IRPEF + surtaxes, franchise €10.000)',
  tTaxColNetDelta: 'Delta net',
  tTaxFooter: `Les pourcentages sont indisponibles sans calcul individuel. Consultez le simulateur et les [FAQ officielles AFC](https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf).`,
  tTaxScenarios: [
    { label: 'Célibataire, CHF 70.000 brut, résidence Côme', chPct: 'N/D', itPct: 'N/D', delta: 'N/D' },
    { label: 'Marié 2 enfants, CHF 95.000 brut, Varese', chPct: 'N/D', itPct: 'N/D', delta: 'N/D' },
    { label: 'Célibataire, CHF 120.000 brut, Milan', chPct: 'N/D', itPct: 'N/D', delta: 'N/D' },
  ],

  tHealthCaption: "Tableau 3 — LAMal pour résidents suisses : médiane des primes cantonales observées",
  tHealthColCanton: 'Canton (CH)',
  tHealthColMonthly: 'Prime mensuelle médiane (CHF)',
  tHealthColAnnual: 'Coût annuel (CHF)',
  tHealthFooter:
    "Source : [OFSP/Priminfo](https://www.priminfo.admin.ch/). Médiane des tarifs observés par assureur et région : adultes dès 26 ans, modèle standard, franchise CHF 300, sans accidents. Montants arrondis ; ni moyenne pondérée par assurés ni devis personnel.",
  tHealthContext:
    "Les résidents italiens utilisent les primes UE du pays de domicile, et non ce tableau cantonal. Les ayants droit choisissant le SSN doivent demander formellement une exemption au canton de travail dans les trois mois. La contribution des catégories visées par la loi 213/2023 se distingue des primes LAMal et de l’inscription volontaire au SSN : 3–6% du salaire suisse net, 30–200 EUR par mois travaillé, versés à la Région selon les mesures applicables. Vérifier conditions, taux et délais. [Décret du 14 novembre 2025](https://www.gazzettaufficiale.it/eli/id/2025/12/18/25A06706/sg).",

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

  salaryIntro: `Le tableau présente la médiane des milieux des fourchettes admissibles. Il ne mesure pas les salaires versés et ne convertit pas les montants mensuels avec un treizième versement supposé. Comparer l’Italie exige des observations équivalentes par rôle, expérience et horaire, absentes du panel.`,
  taxIntro: `L’accord de 2020 s’applique depuis 2024. Les nouveaux frontaliers fiscaux paient 80% de l’impôt à la source suisse ordinaire et l’impôt italien avec crédit. Le régime transitoire exige une activité fiscale qualifiée entre le 31 décembre 2018 et le 17 juillet 2023, pas seulement une date d’embauche. La qualification exige résidence dans une commune de la liste officielle des 20 km, emploi en TI/GR/VS et retour en principe quotidien. [FAQ AFC](https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf).`,
  healthIntro:
    "Le tableau compare uniquement les observations disponibles pour les résidents suisses. Aucun prix de remplacement n’est attribué aux cantons comptant moins de trois observations standard vérifiables. La prime personnelle dépend de l’assureur et de la région ; les résidents italiens doivent sélectionner Italie dans le comparateur.",
  healthUnavailable: "Les données cantonales vérifiables sont indisponibles pour cette année. Consulter Priminfo ; aucune prime de remplacement n’est estimée.",
  benefitsIntro:
    "Le Tableau 4 compare les prestations sociales. Les cotisations AVS ne sont pas transférées à l’INPS : chaque État détermine et verse sa propre pension. Pour le 2e pilier, il faut distinguer les prestations de retraite du retrait anticipé en espèces lié au départ avant la retraite.",
  costIntro:
    'Le Tableau 5 compare un panier réaliste Lugano vs Varese/Côme. Le frontalier qui garde sa résidence italienne combine le salaire CH avec le coût de la vie IT — l\'arithmétique qui rend la navette économiquement rentable pour de nombreux rôles qualifiés.',

  faqTitle: 'FAQ — comparaison CH vs IT',
  faqs: [
    {
      question: 'Travailler en Suisse est-il toujours plus avantageux qu\'en Italie ?',
      answer: `Il n’existe pas de seuil universel de rentabilité : comparez offres réelles, impôts, cotisations, frais de trajet et temps personnel. Le seul échantillon salarial ne démontre pas un avantage individuel.`,
    },
    {
      question: `Pourquoi la comparaison salariale italienne est-elle indisponible ?`,
      answer: `Il manque un panel italien comparable par rôle, expérience et horaire. Nous ne publions donc ni médiane italienne ni ratio estimé à partir de constantes.`,
    },
    {
      question: 'LAMal est-elle vraiment obligatoire pour chaque frontalier ?',
      answer:
        'Pour les nouveaux frontaliers (embauchés après le 17/07/2023) oui, sauf option documentée SSN italien. Les anciens frontaliers conservent leur option SSN. OFSP publie la liste des assureurs autorisés sur priminfo.admin.ch.',
    },
    {
      question: 'Puis-je récupérer ma LPP en Italie ?',
      answer:
        "Le retour en Italie avant la retraite ne permet pas automatiquement de retirer tout le 2e pilier. En cas d’assurance obligatoire en Italie pour la vieillesse, l’invalidité et les survivants, la part LPP obligatoire reste liée en Suisse. La part surobligatoire suit des règles distinctes : la caisse de pension vérifie les conditions du paiement. Ce n’est pas une interdiction générale des prestations normales de retraite. [Source : AVS/AI, Quitter la Suisse](https://www.ahv-iv.ch/p/880.i).",
    },
    {
      question: 'Comment calculer la pression totale d\'un nouveau frontalier 2026 ?',
      answer: `Déterminez le statut fiscal et appliquez le barème suisse à la source au revenu et au profil familial. Pour les nouveaux frontaliers qualifiés, calculez ensuite IRPEF et surtaxes italiennes avec déductions et franchise applicables, puis soustrayez le crédit autorisé pour l’impôt suisse. Intégrez cotisations et frais personnels avant de comparer le net. Utilisez le simulateur avec tous les paramètres individuels.`,
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
