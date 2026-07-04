/**
 * Editorial copy for the 10 profession landings × 4 locales (AE-3).
 *
 * Design notes
 * ------------
 * Unlike the 3-page nursingLandingsCopy (hand-written, 1.2k+ words each),
 * AE-3 ships 40 pages — writing 40 unique long-form essays is both
 * wasteful and slower to review. Instead each locale has:
 *
 *   1. A profession-specific "sections" template (SECTION_BLOCKS_<LOC>) that
 *      composes 7 H2 sections from the PROFESSION_FACTS snapshot + a few
 *      profession-specific IT strings (titoloRuolo, descrizioneMestiere,
 *      requisitiChiave). Each page renders 600-750 IT words / 420-520
 *      other locales while staying factually correct.
 *   2. Inline `[fonte: <Authority>](<url>)` citations on every regulated
 *      claim — MEBEKO/SRK for healthcare, SEFRI/SECO/L-GAV for trades,
 *      ESTI for electricians, USTRA for drivers. Sources come from
 *      PROFESSION_FACTS and data/seo/{mebeko,sefri}-equivalence.json.
 *   3. 5 FAQ entries per locale answering the top PAA questions
 *      (requisiti, stipendio, permesso, concorsi, lingue, orari, tasse).
 *
 * FAQ answers are profession-keyed so the FAQ uniqueness gate passes
 * sitewide (no collision with nursing / career / hub FAQs).
 *
 * Source authority: the helper strings below deliberately mirror the
 * phrasing used by MEBEKO, SEFRI and SECO publications so the content
 * stays verifiable by a reader who clicks through to the cited URL.
 */

import type { ProfessionLocale, ProfessionId } from './professionLandingsData';
import { PROFESSION_FACTS } from './professionLandingsData';

/**
 * Build-time "month year" freshness label in the page language (e.g. it:
 * "giugno 2026", en: "June 2026"). Replaces the previously hardcoded
 * "aprile 2026" claim so the copy can never go stale between deploys.
 */
function buildMonthYearLabel(locale: ProfessionLocale): string {
  const intlLocale = { it: 'it-CH', en: 'en-CH', de: 'de-CH', fr: 'fr-CH' }[locale];
  return new Intl.DateTimeFormat(intlLocale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Zurich',
  }).format(new Date());
}

export interface ProfessionLandingSection {
  title: string;
  paragraphs: string[];
}

export interface ProfessionLandingFaq {
  question: string;
  answer: string;
}

export interface ProfessionLandingCopy {
  title: string;
  description: string;
  h1: string;
  lede: string;
  /** Template B dense lede: numeric facts in 1 line (used above the fold). */
  denseLede: string;
  updatedLabel: string;
  breadcrumbHome: string;
  breadcrumbJobs: string;
  ctaJobs: string;
  ctaSimulator: string;
  relatedLabel: string;
  faqTitle: string;
  sectionHeadings: {
    context: string;
    recognition: string;
    ccl: string;
    salary: string;
    employers: string;
    permits: string;
    application: string;
  };
  tableHeadings: {
    employer: string;
    city: string;
    typicalRoles: string;
    salaryLabel: string;
  };
  employersTableTitle: string;
  /** Framing line under the curated employers table — clarifies it lists
   * historical sector employers, not necessarily companies hiring today. */
  employersTableNote: string;
  sourcesLabel: string;
  // ── Template B labels (mostly static per locale) ─────────────────────────
  eyebrow: string;
  statTileLiveLabel: string;
  statTileSalaryLabel: string;
  statTileFreshLabel: string;
  statSalaryValue: string;
  statFreshValue: string;
  statLiveValue: string;
  primaryCtaLabel: string;
  featuredJobsTitle: string;
  featuredJobsCtaAllLabel: string;
  featuredJobsEmpty: string;
  employerGridTitle: string;
  approfondisciHeading: string;
  formatJobPosted: (daysAgo: number) => string;
  formatJobSalary: (min: number | null, max: number | null) => string;
}

// ─────────────────────────────────────────────────────────────────
// Per-profession keyword strings (one per id, per locale).
// Used to interpolate the H1 / lede / contextual sentences.
// ─────────────────────────────────────────────────────────────────

interface ProfessionStrings {
  /** Nominative noun — "infermiere", "Krankenpfleger", "infirmier". */
  role: string;
  /** Short descriptor for the lede — "il lavoro da infermiere in Ticino". */
  descriptor: string;
  /** Short mestiere summary — 1-2 sentences about the role. */
  roleSummary: string;
  /** Key requisite / formazione string. */
  requisiti: string;
  /** Typical tasks for the employment context. */
  typicalTasks: string;
}

const IT_PROFESSION_STRINGS: Record<ProfessionId, ProfessionStrings> = {
  infermiere: {
    role: 'infermiere',
    descriptor: 'il lavoro da infermiere/a in Ticino',
    roleSummary:
      'Il ruolo di infermiere in Svizzera è strutturato attorno alla formazione Bachelor SUP (HF o universitaria), con autonomia clinica maggiore rispetto all\'Italia e un ricorso diffuso alla cartella clinica elettronica. In Ticino, l\'italiano è la lingua di lavoro.',
    requisiti:
      'Laurea triennale italiana in Infermieristica (L/SNT1), riconoscimento SRK, iscrizione all\'albo cantonale quando richiesta, conoscenza degli standard svizzeri di documentazione clinica.',
    typicalTasks:
      'Assistenza diretta al paziente, somministrazione terapie, gestione accessi venosi, documentazione cartella clinica, collaborazione interdisciplinare, supervisione di studenti e apprendisti in stage.',
  },
  operaio: {
    role: 'operaio',
    descriptor: 'il lavoro da operaio in Ticino',
    roleSummary:
      'Gli operai industriali in Ticino operano prevalentemente in tre comparti: metallurgia (lavorazione metalli, componentistica), chimica (Lonza, Siegfried, Bachem) e alimentare. Non è richiesto alcun titolo specifico.',
    requisiti:
      'Scuola dell\'obbligo + eventuale qualifica professionale IeFP. Nessun riconoscimento SEFRI necessario per l\'assunzione.',
    typicalTasks:
      'Operazioni di linea di produzione, controllo qualità, manutenzione di primo livello, logistica interna, imballaggio, attenzione alle procedure di sicurezza SUVA.',
  },
  impiegato: {
    role: 'impiegato',
    descriptor: 'il lavoro da impiegato/a amministrativo in Ticino',
    roleSummary:
      'Le posizioni da impiegato in Ticino coprono funzioni amministrative, contabili, front-office bancario, commerciale e customer-service. La formazione KV svizzera è lo standard locale, ma il diploma italiano ITC è ampiamente accettato.',
    requisiti:
      'Diploma ITC o ragioneria; lingua italiana madrelingua, tedesco o francese apprezzati; dimestichezza con strumenti informatici (Office, ERP, CRM).',
    typicalTasks:
      'Gestione pratiche, registrazioni contabili, relazione con clienti e fornitori, supporto vendita, reporting, coordinamento appuntamenti, compliance con normative bancarie / assicurative.',
  },
  ingegnere: {
    role: 'ingegnere',
    descriptor: 'il lavoro da ingegnere in Ticino',
    roleSummary:
      'Gli ingegneri in Ticino sono distribuiti fra studi tecnici (Lombardi Group, Pini Swiss), aziende manifatturiere (ABB, AGIE, Hamilton) e fintech (Tether, Lugano crypto-valley). Domanda crescente per ingegneri gestionali, elettronici e informatici.',
    requisiti:
      'Laurea magistrale in ingegneria; inglese tecnico; iscrizione REG (A per ETH/SUP, B per diploma italiano riconosciuto) consigliata per libera professione o firma di progetti edili.',
    typicalTasks:
      'Progettazione, calcolo strutturale, redazione di capitolati, direzione lavori, sviluppo software embedded o enterprise, gestione della sicurezza funzionale, coordinamento di squadre multidisciplinari.',
  },
  educatore: {
    role: 'educatore',
    descriptor: 'il lavoro da educatore sociale in Ticino',
    roleSummary:
      'Gli educatori sociali in Ticino operano in strutture residenziali per minori, comunità terapeutiche, centri diurni per disabili e servizi di prossimità. L\'offerta è contenuta ma altamente qualificata, con CCL dedicato.',
    requisiti:
      'Laurea triennale in Scienze dell\'Educazione, Servizio Sociale o Educazione Professionale; riconoscimento SEFRI; conoscenza delle normative LIPMin (protezione del minore) e LAS (aiuto sociale).',
    typicalTasks:
      'Accompagnamento educativo individualizzato, redazione di progetti educativi, coordinamento con famiglie e rete sanitaria, gestione di gruppi terapeutici, supporto al reinserimento sociale.',
  },
  autista: {
    role: 'autista',
    descriptor: 'il lavoro da autista professionale in Ticino',
    roleSummary:
      'Le principali richieste di autisti in Ticino riguardano trasporto merci (C/CE), autobus di linea (D Postbus, AutoPostale), trasporto turistico e servizio navette aeroportuali. CCL obbligatorio in tutta la Svizzera.',
    requisiti:
      'Patente italiana C/CE o D/DE, CQC italiana valida, conversione OAut entro 12 mesi dal primo impiego in Svizzera, certificato medico, nessun precedente grave per guida sotto effetto di sostanze.',
    typicalTasks:
      'Consegne quotidiane tra Italia e Svizzera, rispetto dei tempi di guida Regolamento (CE) 561/2006, uso del tachigrafo digitale, carico e scarico merci, manutenzione ordinaria del veicolo.',
  },
  muratore: {
    role: 'muratore',
    descriptor: 'il lavoro da muratore edile in Ticino',
    roleSummary:
      'L\'edilizia in Ticino è uno dei settori con maggiore presenza di frontalieri italiani. Il CNM (Contratto nazionale mantello) fissa salari minimi obbligatori in tutta la Svizzera, applicati senza deroghe.',
    requisiti:
      'Qualifica IeFP edilizia (triennale) o diploma tecnico + riconoscimento SEFRI; conoscenza delle norme SUVA su DPI e sicurezza cantiere; patentini specifici per ponteggi e macchine operatrici.',
    typicalTasks:
      'Esecuzione di opere in calcestruzzo armato, muratura portante, intonaci, posa di elementi prefabbricati, gestione del cantiere secondo standard svizzeri, controllo qualità post-getto.',
  },
  cuoco: {
    role: 'cuoco',
    descriptor: 'il lavoro da cuoco in Ticino',
    roleSummary:
      'La ristorazione ticinese comprende alberghi 4-5 stelle (Ascona, Lugano), ristoranti tradizionali, mense ospedaliere e catering aziendale. L-GAV regola salari minimi e orari in tutto il settore.',
    requisiti:
      'Qualifica IeFP alberghiera o diploma IPSSAR, conoscenza HACCP, lingua italiana (tedesco apprezzato in alberghi del Grigioni italiano), esperienza in brigata strutturata.',
    typicalTasks:
      'Preparazione dei piatti secondo il menù, rispetto della catena del freddo, gestione ordini magazzino cucina, formazione di commis e apprendisti, coordinamento con la sala.',
  },
  cameriere: {
    role: 'cameriere',
    descriptor: 'il lavoro da cameriere di sala in Ticino',
    roleSummary:
      'Il servizio di sala in Ticino è coperto dal CCL L-GAV e richiede solo formazione di base. Alta stagionalità estiva (Ascona, Locarno, Lugano) e rotazione costante con contratti flessibili.',
    requisiti:
      'Nessuna qualifica obbligatoria; conoscenza dell\'italiano e preferibilmente del tedesco; abilità comunicative, standing curato, flessibilità oraria su turni spezzati.',
    typicalTasks:
      'Accoglienza cliente, presentazione del menù, gestione ordini, servizio ai tavoli, conoscenza di vini e abbinamenti, chiusura del conto, pulizia della sala e delle attrezzature.',
  },
  elettricista: {
    role: 'elettricista',
    descriptor: 'il lavoro da elettricista installatore in Ticino',
    roleSummary:
      'L\'installazione elettrica in Ticino è una professione regolamentata ESTI. L\'accesso pieno richiede il diploma AFC e l\'autorizzazione federale per impianti sotto tensione; molti frontalieri iniziano come aiuto-montatori.',
    requisiti:
      'Qualifica IeFP elettrotecnica o perito elettrotecnico ITIS, riconoscimento SEFRI, autorizzazione ESTI per impianti sotto tensione, conoscenza della NIBT (Norme sugli impianti a bassa tensione).',
    typicalTasks:
      'Posa di canaline e cavi, realizzazione di quadri elettrici, test di isolamento, diagnostica guasti, messa in servizio di impianti domotici, compilazione della documentazione ESTI.',
  },
  psicologo: {
    role: 'psicologo',
    descriptor: 'il lavoro da psicologo in Ticino',
    roleSummary:
      'In Svizzera il titolo di psicologo è protetto dalla LPPsi e la psicoterapia richiede un perfezionamento riconosciuto più l\'autorizzazione cantonale. In Ticino i principali datori sono l\'Organizzazione Sociopsichiatrica Cantonale, le cliniche private e gli studi associati.',
    requisiti:
      'Laurea magistrale in Psicologia (LM-51), riconoscimento PsyCo (Commissione delle professioni psicologiche, UFSP); per esercitare la psicoterapia servono il titolo federale di perfezionamento e l\'autorizzazione cantonale.',
    typicalTasks:
      'Colloqui clinici, diagnostica e testistica psicologica, psicoterapia sotto supervisione, relazioni per enti e assicurazioni, lavoro in équipe multidisciplinare, progetti di prevenzione.',
  },
  fisioterapista: {
    role: 'fisioterapista',
    descriptor: 'il lavoro da fisioterapista in Ticino',
    roleSummary:
      'La fisioterapia è una professione sanitaria regolamentata dalla LPSan: il diploma italiano va riconosciuto dalla CRS prima dell\'assunzione stabile. La domanda ticinese è trainata da EOC, cliniche riabilitative e studi privati convenzionati.',
    requisiti:
      'Laurea triennale in Fisioterapia (L/SNT2), riconoscimento CRS (Croce Rossa Svizzera), autorizzazione cantonale per l\'esercizio indipendente, registrazione NAREG; il tedesco amplia le opportunità fuori Ticino.',
    typicalTasks:
      'Valutazione funzionale, terapia manuale e strumentale, riabilitazione post-operatoria e sportiva, ginnastica terapeutica di gruppo, documentazione clinica, coordinamento con medici prescrittori.',
  },
  logopedista: {
    role: 'logopedista',
    descriptor: 'il lavoro da logopedista in Ticino',
    roleSummary:
      'In Svizzera la logopedia si esercita in ambito scolastico e clinico; il riconoscimento dei diplomi esteri passa dalla CDPE/EDK. L\'italiano madrelingua è un vantaggio concreto nei servizi scolastici e nei reparti di neuroriabilitazione ticinesi.',
    requisiti:
      'Laurea in Logopedia (L/SNT2), riconoscimento CDPE/EDK del diploma estero, esperienza pediatrica apprezzata per i servizi scolastici, conoscenza dei percorsi cantonali di sostegno.',
    typicalTasks:
      'Valutazione dei disturbi del linguaggio e della deglutizione, terapia individuale a bambini e adulti, consulenza a docenti e famiglie, documentazione, collaborazione con ORL e servizi scolastici.',
  },
  farmacista: {
    role: 'farmacista',
    descriptor: 'il lavoro da farmacista in Ticino',
    roleSummary:
      'Il farmacista è una professione medica universitaria secondo la LPMed: il diploma va riconosciuto dalla MEBEKO. In Ticino si lavora in farmacia pubblica, farmacia ospedaliera EOC e industria; la responsabilità di una farmacia richiede il diploma federale riconosciuto.',
    requisiti:
      'Laurea magistrale in Farmacia o CTF, riconoscimento MEBEKO, iscrizione al registro delle professioni mediche (MedReg); per la gerenza serve inoltre l\'autorizzazione cantonale.',
    typicalTasks:
      'Validazione e dispensazione delle ricette, consulenza al paziente, preparazioni galeniche, gestione di scorte e stupefacenti, vaccinazioni in farmacia, farmacovigilanza.',
  },
  ostetrica: {
    role: 'ostetrica',
    descriptor: 'il lavoro da ostetrica in Ticino',
    roleSummary:
      'L\'ostetricia rientra nella procedura armonizzata della direttiva UE 2005/36/CE: il riconoscimento CRS è tra i più rapidi delle professioni sanitarie. In Ticino i punti nascita EOC concentrano la domanda, con reperibilità e turni notturni retribuiti secondo CCL.',
    requisiti:
      'Laurea in Ostetricia (L/SNT1), riconoscimento CRS con procedura armonizzata UE, registrazione NAREG, autorizzazione cantonale per la libera professione.',
    typicalTasks:
      'Assistenza a gravidanza, parto e puerperio, monitoraggio CTG, sostegno all\'allattamento, corsi preparto, documentazione clinica, reperibilità in sala parto.',
  },
  'assistente-dentale': {
    role: 'assistente dentale',
    descriptor: 'il lavoro da assistente dentale in Ticino',
    roleSummary:
      'La professione non è regolamentata a livello federale: gli studi ticinesi assumono anche con qualifica italiana ASO, mentre il riconoscimento SEFRI del titolo AFC resta facoltativo ma apprezzato. Le raccomandazioni salariali SSO fanno da riferimento di settore.',
    requisiti:
      'Qualifica di assistente alla poltrona (ASO) o equivalente, radioprotezione secondo le norme svizzere per le radiografie endorali, riconoscimento SEFRI facoltativo del titolo.',
    typicalTasks:
      'Assistenza alla poltrona a quattro mani, preparazione e sterilizzazione dello strumentario, radiografie endorali, gestione agenda e richiami, amministrazione e fatturazione, igiene dello studio.',
  },
  'tecnico-radiologia': {
    role: 'tecnico di radiologia medica',
    descriptor: 'il lavoro da tecnico di radiologia (TRM) in Ticino',
    roleSummary:
      'Il TRM è una professione sanitaria regolamentata: il diploma italiano va riconosciuto dalla CRS e la radioprotezione segue l\'ORaP svizzera. EOC e cliniche private ticinesi assumono su convenzionale, TAC, risonanza e radioterapia.',
    requisiti:
      'Laurea in Tecniche di Radiologia Medica per Immagini e Radioterapia (L/SNT3), riconoscimento CRS, formazione in radioprotezione secondo ORaP, registrazione NAREG.',
    typicalTasks:
      'Esami radiologici convenzionali, TAC e risonanza magnetica, trattamenti di radioterapia, gestione delle dosi e radioprotezione del paziente, controllo qualità delle apparecchiature.',
  },
  oss: {
    role: 'operatore socio sanitario',
    descriptor: 'il lavoro da OSS in Ticino',
    roleSummary:
      'L\'equivalente svizzero dell\'OSS è l\'operatore sociosanitario AFC (FaGe nella Svizzera tedesca); il riconoscimento del titolo italiano passa dalla CRS. Case per anziani, EOC e spitex ticinesi assumono con continuità, con salari regolati da CCL EOC e ROCA.',
    requisiti:
      'Qualifica OSS italiana (corso ≥1000 ore), riconoscimento CRS verso l\'AFC di operatore sociosanitario; per molte case per anziani basta il titolo italiano con esperienza documentata.',
    typicalTasks:
      'Cure di base e igiene, mobilizzazione, rilevazione dei parametri vitali, supporto nelle attività quotidiane, documentazione delle cure, collaborazione con il personale infermieristico.',
  },
  'ottico-optometrista': {
    role: 'ottico optometrista',
    descriptor: 'il lavoro da ottico e optometrista in Ticino',
    roleSummary:
      'L\'optometrista è professione sanitaria LPSan (riconoscimento CRS), mentre l\'ottico AFC passa dal riconoscimento SEFRI. In Ticino assumono le catene (Fielmann, Visilab, McOptic) e le ottiche indipendenti; la refrazione autonoma richiede il titolo di optometrista riconosciuto.',
    requisiti:
      'Diploma di ottico o laurea in Ottica e Optometria; riconoscimento CRS per l\'optometrista (LPSan) o SEFRI per l\'ottico AFC; italiano indispensabile, tedesco utile nelle catene.',
    typicalTasks:
      'Refrazione ed esame visivo, adattamento di lenti a contatto, consulenza su montature e lenti, vendita assistita, piccole riparazioni e manutenzione, gestione dell\'officina.',
  },
  contabile: {
    role: 'contabile',
    descriptor: 'il lavoro da contabile in Ticino',
    roleSummary:
      'La contabilità non è una professione regolamentata: il diploma italiano di ragioneria o la laurea in economia sono spendibili subito. Fiduciarie, multinazionali e PMI ticinesi cercano profili con IVA svizzera, salari e Swiss GAAP RPC.',
    requisiti:
      'Diploma di ragioneria o laurea in economia; conoscenza di IVA svizzera, certificato di salario e assicurazioni sociali (AVS/LPP); l\'attestato federale di specialista in finanza e contabilità è il titolo di riferimento svizzero.',
    typicalTasks:
      'Contabilità generale e clienti/fornitori, chiusure mensili e annuali, dichiarazioni IVA, gestione salari e assicurazioni sociali, riconciliazioni bancarie, reporting alla direzione.',
  },
  'assistente-sociale': {
    role: 'assistente sociale',
    descriptor: 'il lavoro da assistente sociale in Ticino',
    roleSummary:
      'Il lavoro sociale in Svizzera non è regolamentato a livello federale: il riconoscimento SEFRI del titolo SUP è facoltativo ma spesso richiesto dagli enti pubblici. In Ticino assumono servizi sociali comunali e cantonali, istituti e fondazioni del settore socio-educativo.',
    requisiti:
      'Laurea in Servizio Sociale (L-39/LM-87), riconoscimento SEFRI facoltativo del titolo SUP, conoscenza della LAS e della rete dei servizi ticinesi apprezzata.',
    typicalTasks:
      'Presa a carico di utenti e famiglie, valutazioni sociali, progetti d\'intervento, coordinamento con servizi cantonali e comunali, gestione di curatele, documentazione.',
  },
  macellaio: {
    role: 'macellaio',
    descriptor: 'il lavoro da macellaio in Ticino',
    roleSummary:
      'La grande distribuzione (Coop, Migros) e l\'industria della carne assumono macellai con costanza; il CCL per l\'industria svizzera della carne ha obbligatorietà generale e fissa i minimi salariali. Il riconoscimento SEFRI verso l\'AFC di macellaio-salumiere è facoltativo.',
    requisiti:
      'Qualifica IeFP di settore o esperienza equivalente in macelleria o industria della carne, igiene HACCP secondo la legislazione svizzera sulle derrate alimentari, riconoscimento SEFRI facoltativo.',
    typicalTasks:
      'Disosso e sezionamento, preparazione del banco, produzione di salumeria, confezionamento, rispetto della catena del freddo e HACCP, consulenza alla clientela.',
  },
  saldatore: {
    role: 'saldatore',
    descriptor: 'il lavoro da saldatore in Ticino',
    roleSummary:
      'La saldatura non richiede riconoscimenti di titolo: contano le certificazioni EN ISO 9606 in corso di validità, richieste da officine e carpenterie per ogni procedimento. I salari seguono i CCL dell\'industria MEM e della metalcostruzione.',
    requisiti:
      'Certificazioni di saldatura EN ISO 9606 valide (TIG/MIG/MAG/elettrodo), lettura del disegno tecnico, esperienza su acciaio, inox o alluminio; nessun riconoscimento obbligatorio del titolo.',
    typicalTasks:
      'Saldatura TIG/MIG/MAG su acciaio, inox e alluminio, preparazione dei giunti, controllo qualità visivo e dimensionale, manutenzione degli impianti, lavoro su commessa in officina o in cantiere.',
  },
  architetto: {
    role: 'architetto',
    descriptor: 'il lavoro da architetto in Ticino',
    roleSummary:
      'Per firmare progetti in Ticino serve l\'iscrizione all\'OTIA (o al registro REG A/B): è il passaggio chiave per i frontalieri del settore. Gli studi ticinesi e i general contractor cercano profili con esperienza di direzione lavori e norme SIA.',
    requisiti:
      'Laurea magistrale in Architettura con abilitazione, iscrizione OTIA per l\'esercizio in Ticino o registro REG, conoscenza delle norme SIA e delle procedure edilizie cantonali.',
    typicalTasks:
      'Progettazione preliminare e definitiva, domande di costruzione, direzione lavori, computi e capitolati secondo SIA, coordinamento degli specialisti, rilievi e sopralluoghi.',
  },
};

// Minimal profession strings for non-IT locales — shorter roleSummary/task
// lists keep EN/DE/FR bodies above 420 words after facts + tables are added.
const EN_PROFESSION_STRINGS: Record<ProfessionId, ProfessionStrings> = {
  infermiere: {
    role: 'nurse',
    descriptor: 'nursing work in Ticino',
    roleSummary:
      'Swiss nurses hold a Bachelor HF/SUP degree and enjoy clinical autonomy beyond what most Italian graduates experience. In Ticino the working language is Italian, and EOC plus several private clinics hire Italian graduates regularly.',
    requisiti:
      'Italian bachelor in Nursing (L/SNT1), Swiss Red Cross (SRK) recognition, cantonal register entry when requested by the canton.',
    typicalTasks:
      'Direct patient care, medication administration, IV management, electronic health record documentation, multidisciplinary handovers, supervision of trainees.',
  },
  operaio: {
    role: 'factory worker',
    descriptor: 'production-worker roles in Ticino',
    roleSummary:
      'Industrial workers in Ticino are concentrated in three sectors: metalworking, chemistry (Lonza, Siegfried) and food processing. No specific diploma is mandatory.',
    requisiti:
      'Compulsory schooling plus any IeFP vocational certificate. No SEFRI recognition required for hiring.',
    typicalTasks:
      'Production-line operations, first-level quality checks, basic maintenance, internal logistics, packaging, SUVA safety compliance.',
  },
  impiegato: {
    role: 'office clerk',
    descriptor: 'office clerk roles in Ticino',
    roleSummary:
      'Clerical positions in Ticino cover admin, bookkeeping, bank front office, customer service and sales support. The Swiss KV standard prevails but the Italian ITC diploma is widely accepted.',
    requisiti:
      'Italian ITC or ragioneria diploma; Italian mother-tongue, German/French appreciated; Office, ERP and CRM proficiency.',
    typicalTasks:
      'Administrative workflows, bookkeeping entries, client and supplier relations, sales support, reporting, compliance with banking / insurance rules.',
  },
  ingegnere: {
    role: 'engineer',
    descriptor: 'engineer roles in Ticino',
    roleSummary:
      'Engineers in Ticino split between technical design firms (Lombardi, Pini Swiss), manufacturing (ABB, AGIE, Hamilton) and fintech (Tether, Lugano crypto-valley). Demand is growing for industrial, electronics and software engineers.',
    requisiti:
      'Five-year Italian master in engineering; technical English; REG registration recommended for self-employment or civil-engineering project stamps.',
    typicalTasks:
      'Design work, structural calculations, tender drafting, site supervision, embedded or enterprise software development, functional safety management, multi-disciplinary team coordination.',
  },
  educatore: {
    role: 'social educator',
    descriptor: 'social-educator roles in Ticino',
    roleSummary:
      'Social educators in Ticino work in residential homes for minors, therapeutic communities, day centres for the disabled, and community outreach services. Demand is limited but fully covered by a dedicated collective agreement.',
    requisiti:
      'Italian bachelor in Educational Sciences, Social Work or Vocational Pedagogy; SEFRI recognition; knowledge of LIPMin and LAS cantonal regulations.',
    typicalTasks:
      'Individual educational mentoring, drafting personalized plans, liaison with families and healthcare network, group facilitation, reintegration support.',
  },
  autista: {
    role: 'driver',
    descriptor: 'professional-driver roles in Ticino',
    roleSummary:
      'Ticino demand concentrates on freight C/CE, public bus D (AutoPostale), tourism coach and airport shuttles. A sector-wide collective agreement applies across Switzerland.',
    requisiti:
      'Italian C/CE or D/DE licence, valid CQC, OAut conversion within 12 months of first Swiss employment, medical certificate, clean driving record.',
    typicalTasks:
      'Daily cross-border or domestic deliveries, compliance with Regulation (EC) 561/2006 driving hours, digital tachograph use, loading and unloading, basic vehicle upkeep.',
  },
  muratore: {
    role: 'mason',
    descriptor: 'mason roles in Ticino',
    roleSummary:
      'Construction is one of Ticino\'s largest cross-border employers. The CNM main-construction collective agreement sets binding minimum wages across Switzerland with no derogation.',
    requisiti:
      'Italian IeFP construction qualification or technical diploma plus SEFRI recognition; SUVA PPE and site-safety knowledge; certificates for scaffolding and plant operation.',
    typicalTasks:
      'Reinforced concrete works, load-bearing masonry, plastering, prefabricated element placement, Swiss-standard site management, post-pour quality checks.',
  },
  cuoco: {
    role: 'cook',
    descriptor: 'cook roles in Ticino',
    roleSummary:
      'Ticino hospitality spans 4-5-star hotels (Ascona, Lugano), traditional restaurants, hospital catering and corporate canteens. L-GAV regulates minimum wages and hours across the sector.',
    requisiti:
      'Italian IeFP hospitality qualification or IPSSAR diploma, HACCP knowledge, Italian (German welcome for Italian-Grigioni hotels), structured-brigade experience.',
    typicalTasks:
      'Menu preparation, cold-chain compliance, kitchen-stock management, mentoring of commis and apprentices, coordination with the front-of-house team.',
  },
  cameriere: {
    role: 'waiter',
    descriptor: 'waiter roles in Ticino',
    roleSummary:
      'Front-of-house service in Ticino falls under the L-GAV agreement and requires only basic training. Strong summer seasonality in Ascona, Locarno and Lugano generates constant rotation.',
    requisiti:
      'No mandatory qualification; Italian proficiency, German preferred; strong communication, professional presentation, flexibility for split shifts.',
    typicalTasks:
      'Guest reception, menu presentation, order management, table service, wine pairings, bill closing, dining-room and equipment cleaning.',
  },
  elettricista: {
    role: 'electrician',
    descriptor: 'electrician roles in Ticino',
    roleSummary:
      'Electrical installation is an ESTI-regulated profession. Full access requires an AFC diploma and federal authorisation for live-installation work; many Italian newcomers start as assistant fitters.',
    requisiti:
      'Italian IeFP electrotechnics qualification or ITIS perito elettrotecnico diploma, SEFRI recognition, ESTI authorisation for live installations, knowledge of NIBT low-voltage standards.',
    typicalTasks:
      'Cable-tray and cable laying, switchboard assembly, insulation testing, fault diagnostics, smart-home commissioning, ESTI documentation compilation.',
  },
  psicologo: {
    role: 'psychologist',
    descriptor: 'psychologist roles in Ticino',
    roleSummary:
      'The psychologist title is protected under Swiss PsyA law; psychotherapy additionally requires a recognised postgraduate title plus cantonal authorisation. Main Ticino employers: cantonal psychiatry (OSC), private clinics and group practices.',
    requisiti:
      'Master\'s degree in Psychology, PsyCo recognition (Federal Psychology Professions Commission); psychotherapy practice requires the federal postgraduate title and cantonal licence.',
    typicalTasks:
      'Clinical interviews, psychological assessment and testing, supervised psychotherapy, reports for agencies and insurers, multidisciplinary teamwork, prevention projects.',
  },
  fisioterapista: {
    role: 'physiotherapist',
    descriptor: 'physiotherapist roles in Ticino',
    roleSummary:
      'Physiotherapy is a HealthPA-regulated profession: foreign diplomas need Swiss Red Cross (SRC) recognition before permanent hiring. Demand is driven by EOC hospitals, rehab clinics and private practices.',
    requisiti:
      'Physiotherapy degree, SRC recognition, cantonal authorisation for independent practice, NAREG registration; German widens options outside Ticino.',
    typicalTasks:
      'Functional assessment, manual and instrumental therapy, post-operative and sports rehabilitation, therapeutic group exercise, clinical documentation, coordination with prescribing physicians.',
  },
  logopedista: {
    role: 'speech therapist',
    descriptor: 'speech therapist roles in Ticino',
    roleSummary:
      'Speech therapy is practised in school and clinical settings; foreign diploma recognition goes through the EDK. Native Italian is a real advantage in Ticino school services and neuro-rehabilitation wards.',
    requisiti:
      'Speech therapy degree, EDK recognition of the foreign diploma, paediatric experience valued for school services.',
    typicalTasks:
      'Assessment of language and swallowing disorders, individual therapy for children and adults, counselling for teachers and families, documentation, collaboration with ENT and school services.',
  },
  farmacista: {
    role: 'pharmacist',
    descriptor: 'pharmacist roles in Ticino',
    roleSummary:
      'Pharmacist is a university medical profession under MedPA: diplomas are recognised by MEBEKO. Work spans retail pharmacies, EOC hospital pharmacy and industry; managing a pharmacy requires the recognised federal diploma.',
    requisiti:
      'Master\'s degree in Pharmacy, MEBEKO recognition, MedReg registration; pharmacy management additionally requires cantonal authorisation.',
    typicalTasks:
      'Prescription validation and dispensing, patient counselling, galenic preparations, stock and narcotics management, pharmacy vaccinations, pharmacovigilance.',
  },
  ostetrica: {
    role: 'midwife',
    descriptor: 'midwife roles in Ticino',
    roleSummary:
      'Midwifery falls under the harmonised EU 2005/36/EC procedure: SRC recognition is among the fastest for health professions. EOC birth centres concentrate demand, with on-call duty paid per collective agreement.',
    requisiti:
      'Midwifery degree, SRC recognition via the harmonised EU procedure, NAREG registration, cantonal authorisation for independent practice.',
    typicalTasks:
      'Care through pregnancy, birth and postpartum, CTG monitoring, breastfeeding support, antenatal classes, clinical documentation, delivery-room on-call shifts.',
  },
  'assistente-dentale': {
    role: 'dental assistant',
    descriptor: 'dental assistant roles in Ticino',
    roleSummary:
      'The profession is not federally regulated: Ticino practices also hire with foreign qualifications, while optional SEFRI recognition of the AFC title is appreciated. SSO salary recommendations set the sector benchmark.',
    requisiti:
      'Dental assistant qualification, radiation protection per Swiss rules for intraoral X-rays, optional SEFRI title recognition.',
    typicalTasks:
      'Four-handed chairside assistance, instrument preparation and sterilisation, intraoral X-rays, appointment and recall management, administration and billing, practice hygiene.',
  },
  'tecnico-radiologia': {
    role: 'radiographer',
    descriptor: 'radiographer (TRM) roles in Ticino',
    roleSummary:
      'The radiographer is a regulated health profession: foreign diplomas need SRC recognition and radiation protection follows the Swiss RPO. EOC and private clinics hire across conventional imaging, CT, MRI and radiotherapy.',
    requisiti:
      'Medical radiology technology degree, SRC recognition, radiation-protection training per Swiss RPO, NAREG registration.',
    typicalTasks:
      'Conventional radiology exams, CT and MRI, radiotherapy treatments, dose management and patient radiation protection, equipment quality control.',
  },
  oss: {
    role: 'healthcare assistant',
    descriptor: 'healthcare assistant (FaGe/OSS) roles in Ticino',
    roleSummary:
      'The Swiss equivalent is the healthcare assistant AFC (FaGe): foreign title recognition goes through the SRC. Nursing homes, EOC and Spitex hire steadily, with pay set by EOC and ROCA collective agreements.',
    requisiti:
      'Healthcare assistant qualification (≥1000 hours), SRC recognition toward the Swiss AFC; many nursing homes accept the foreign title with documented experience.',
    typicalTasks:
      'Basic care and hygiene, mobilisation, vital-signs monitoring, support with daily activities, care documentation, collaboration with nursing staff.',
  },
  'ottico-optometrista': {
    role: 'optician-optometrist',
    descriptor: 'optician and optometrist roles in Ticino',
    roleSummary:
      'The optometrist is a HealthPA profession (SRC recognition), while the optician AFC goes through SEFRI. Chains (Fielmann, Visilab, McOptic) and independent shops hire; autonomous refraction requires the recognised optometrist title.',
    requisiti:
      'Optician diploma or optometry degree; SRC recognition for optometrists or SEFRI for opticians; Italian essential, German useful in chains.',
    typicalTasks:
      'Refraction and eye exams, contact-lens fitting, frame and lens consulting, assisted sales, small repairs and maintenance, workshop management.',
  },
  contabile: {
    role: 'accountant',
    descriptor: 'accountant roles in Ticino',
    roleSummary:
      'Accounting is not a regulated profession: foreign diplomas are usable immediately. Fiduciaries, multinationals and Ticino SMEs look for Swiss VAT, payroll and Swiss GAAP RPC experience.',
    requisiti:
      'Accounting diploma or economics degree; Swiss VAT, salary certificates and social insurance (AVS/LPP) knowledge; the federal specialist diploma in finance and accounting is the Swiss reference title.',
    typicalTasks:
      'General and AR/AP accounting, monthly and annual closings, VAT returns, payroll and social insurance, bank reconciliations, management reporting.',
  },
  'assistente-sociale': {
    role: 'social worker',
    descriptor: 'social worker roles in Ticino',
    roleSummary:
      'Social work is not federally regulated: optional SEFRI recognition of the UAS title is often requested by public bodies. Municipal and cantonal social services, institutes and foundations hire in Ticino.',
    requisiti:
      'Social work degree, optional SEFRI recognition of the UAS title, knowledge of the Ticino service network valued.',
    typicalTasks:
      'Case management for clients and families, social assessments, intervention plans, coordination with cantonal and municipal services, guardianships, documentation.',
  },
  macellaio: {
    role: 'butcher',
    descriptor: 'butcher roles in Ticino',
    roleSummary:
      'Large retail (Coop, Migros) and the meat industry hire butchers steadily; the Swiss meat-industry collective agreement is generally binding and sets minimum wages. SEFRI recognition toward the butcher AFC is optional.',
    requisiti:
      'Vocational qualification or equivalent butchery/meat-industry experience, HACCP hygiene per Swiss food law, optional SEFRI recognition.',
    typicalTasks:
      'Deboning and cutting, counter preparation, charcuterie production, packaging, cold-chain and HACCP compliance, customer advice.',
  },
  saldatore: {
    role: 'welder',
    descriptor: 'welder roles in Ticino',
    roleSummary:
      'Welding requires no title recognition: valid EN ISO 9606 certifications per process are what workshops and steel-construction firms ask for. Pay follows the MEM-industry and metal-construction collective agreements.',
    requisiti:
      'Valid EN ISO 9606 welding certifications (TIG/MIG/MAG/electrode), technical-drawing literacy, experience on steel, stainless or aluminium.',
    typicalTasks:
      'TIG/MIG/MAG welding on steel, stainless and aluminium, joint preparation, visual and dimensional quality control, plant maintenance, job-order work in workshop or on site.',
  },
  architetto: {
    role: 'architect',
    descriptor: 'architect roles in Ticino',
    roleSummary:
      'Signing projects in Ticino requires OTIA registration (or REG A/B): the key step for cross-border professionals. Ticino firms and general contractors seek site-management experience and SIA standards.',
    requisiti:
      'Master\'s degree in Architecture with professional qualification, OTIA registration for Ticino practice or REG registry, knowledge of SIA standards and cantonal building procedures.',
    typicalTasks:
      'Preliminary and final design, building permit applications, site management, SIA bills of quantities, specialist coordination, surveys and site visits.',
  },
};

const DE_PROFESSION_STRINGS: Record<ProfessionId, ProfessionStrings> = {
  infermiere: {
    role: 'Krankenpfleger/-pflegerin',
    descriptor: 'Pflegeberufe im Tessin',
    roleSummary:
      'Schweizer Pflegefachpersonen verfügen über einen HF- oder SUP-Bachelor und arbeiten mit deutlich mehr klinischer Autonomie als in Italien. Im Tessin ist Italienisch die Arbeitssprache; EOC und mehrere Privatkliniken stellen laufend italienische Absolventen ein.',
    requisiti:
      'Italienisches Bachelor-Diplom in Pflege (L/SNT1), SRK-Anerkennung, kantonale Registereintragung falls verlangt.',
    typicalTasks:
      'Direkte Patientenpflege, Medikamentenabgabe, Venenzugänge, elektronische Dokumentation, interdisziplinäre Übergaben, Begleitung von Praktikanten.',
  },
  operaio: {
    role: 'Industriearbeiter',
    descriptor: 'Produktions-Jobs im Tessin',
    roleSummary:
      'Industriearbeiter im Tessin konzentrieren sich auf Metallverarbeitung, Chemie (Lonza, Siegfried) und Lebensmittel. Ein spezifisches Diplom ist nicht vorgeschrieben.',
    requisiti:
      'Pflichtschulabschluss plus optionale italienische IeFP-Qualifikation. Keine SEFRI-Anerkennung nötig.',
    typicalTasks:
      'Linienarbeit, Erstqualitätsprüfung, Erstwartung, interne Logistik, Verpackung, SUVA-Sicherheitsvorschriften.',
  },
  impiegato: {
    role: 'Sachbearbeiter',
    descriptor: 'Bürotätigkeiten im Tessin',
    roleSummary:
      'Kaufmännische Stellen im Tessin decken Admin, Buchhaltung, Bankfront, Kundenservice und Verkaufsunterstützung ab. Der Schweizer KV-Standard gilt, das italienische ITC-Diplom wird breit akzeptiert.',
    requisiti:
      'Italienisches ITC- oder Ragioneria-Diplom; Italienisch Muttersprache, Deutsch/Französisch willkommen; Office/ERP/CRM-Kenntnisse.',
    typicalTasks:
      'Administrative Prozesse, Buchungen, Kunden- und Lieferantenkontakt, Verkaufssupport, Reporting, Compliance mit Bank- und Versicherungsregeln.',
  },
  ingegnere: {
    role: 'Ingenieur',
    descriptor: 'Ingenieur-Stellen im Tessin',
    roleSummary:
      'Ingenieure im Tessin verteilen sich auf Planungsbüros (Lombardi, Pini Swiss), Industrie (ABB, AGIE, Hamilton) und Fintech (Tether, Lugano Crypto-Valley). Steigende Nachfrage nach Industrie-, Elektronik- und Software-Ingenieuren.',
    requisiti:
      'Italienischer Masterabschluss in Ingenieurwissenschaften; technisches Englisch; REG-Eintrag bei Selbstständigkeit oder Bauprojekt-Unterschrift empfohlen.',
    typicalTasks:
      'Planung, Tragwerksberechnung, Ausschreibungsunterlagen, Bauleitung, Embedded- oder Enterprise-Software, Funktionssicherheit, interdisziplinäre Teamleitung.',
  },
  educatore: {
    role: 'Sozialpädagoge',
    descriptor: 'Sozialpädagogik-Stellen im Tessin',
    roleSummary:
      'Sozialpädagogen im Tessin arbeiten in Wohngruppen für Minderjährige, therapeutischen Gemeinschaften, Tagesstätten für Menschen mit Behinderung und aufsuchenden Diensten. Kleines, aber hochqualifiziertes Angebot mit eigenem GAV.',
    requisiti:
      'Italienisches Bachelor in Erziehungswissenschaften, Sozialer Arbeit oder Berufspädagogik; SEFRI-Anerkennung; Kenntnis der kantonalen LIPMin- und LAS-Normen.',
    typicalTasks:
      'Individuelle Begleitung, Erstellung von Förderplänen, Kooperation mit Familien und Gesundheitswesen, Gruppenleitung, Reintegrationsarbeit.',
  },
  autista: {
    role: 'Berufskraftfahrer',
    descriptor: 'Fahrer-Stellen im Tessin',
    roleSummary:
      'Im Tessin gefragt: Güterverkehr C/CE, Postauto D, Reisecar und Flughafen-Shuttle. Schweizweiter GAV obligatorisch.',
    requisiti:
      'Italienische Lizenz C/CE oder D/DE, gültiger CQC, OAut-Konversion innerhalb von 12 Monaten, ärztliches Zeugnis, einwandfreier Leumund.',
    typicalTasks:
      'Täglicher Transport, Einhalten der Verordnung (EG) 561/2006 Lenkzeiten, digitaler Tachograph, Be- und Entladung, Grundwartung.',
  },
  muratore: {
    role: 'Maurer',
    descriptor: 'Maurer-Stellen im Tessin',
    roleSummary:
      'Das Bauhauptgewerbe ist einer der grössten Grenzgänger-Arbeitgeber im Tessin. Der Landesmantelvertrag (LMV/CNM) schreibt schweizweit verbindliche Mindestlöhne ohne Abweichung vor.',
    requisiti:
      'Italienische IeFP-Bauqualifikation oder technisches Diplom plus SEFRI-Anerkennung; SUVA-PPE- und Baustellensicherheit; Zertifikate für Gerüste und Baumaschinen.',
    typicalTasks:
      'Stahlbetonarbeiten, tragendes Mauerwerk, Putz, Einbau von Fertigteilen, Baustellen nach Schweizer Standard, Nachbeton-Qualitätsprüfungen.',
  },
  cuoco: {
    role: 'Koch',
    descriptor: 'Koch-Stellen im Tessin',
    roleSummary:
      'Die Tessiner Gastronomie umfasst 4-5-Sterne-Hotels (Ascona, Lugano), traditionelle Restaurants, Spitalküchen und Betriebsverpflegung. L-GAV regelt Mindestlöhne und Arbeitszeiten.',
    requisiti:
      'Italienische IeFP-Hotelqualifikation oder IPSSAR-Diplom, HACCP-Kenntnisse, Italienisch (Deutsch in Grigioni-Italienisch erwünscht), Erfahrung in strukturierter Brigade.',
    typicalTasks:
      'Menü-Zubereitung, Kühlketten-Einhaltung, Lagerhaltung, Ausbildung von Commis und Lehrlingen, Koordination mit dem Service.',
  },
  cameriere: {
    role: 'Kellner',
    descriptor: 'Kellner-Stellen im Tessin',
    roleSummary:
      'Der Service im Tessin fällt unter den L-GAV und verlangt nur Grundausbildung. Starke Sommer-Saisonalität in Ascona, Locarno und Lugano.',
    requisiti:
      'Keine zwingende Qualifikation; Italienisch, Deutsch von Vorteil; Kommunikationsstärke, gepflegtes Auftreten, flexible Schichten.',
    typicalTasks:
      'Gästeempfang, Menüpräsentation, Bestellaufnahme, Service am Tisch, Weinbegleitung, Abrechnung, Reinigung von Saal und Utensilien.',
  },
  elettricista: {
    role: 'Elektroinstallateur',
    descriptor: 'Elektroinstallateur-Stellen im Tessin',
    roleSummary:
      'Die Elektroinstallation ist ein ESTI-regulierter Beruf. Vollzugang benötigt AFC-Diplom und eidgenössische Bewilligung für Arbeiten an unter Spannung stehenden Anlagen; viele italienische Einsteiger starten als Hilfsmonteure.',
    requisiti:
      'Italienische IeFP-Elektrotechnik-Qualifikation oder ITIS-Perito-Elettrotecnico-Diplom, SEFRI-Anerkennung, ESTI-Bewilligung, NIBT-Kenntnisse.',
    typicalTasks:
      'Kabelkanal- und Kabelverlegung, Schaltschrankbau, Isolationsprüfung, Fehlerdiagnose, Inbetriebnahme von Smart-Home-Anlagen, ESTI-Dokumentation.',
  },
  psicologo: {
    role: 'Psychologe',
    descriptor: 'Psychologen-Stellen im Tessin',
    roleSummary:
      'Der Psychologentitel ist durch das PsyG geschützt; Psychotherapie erfordert zusätzlich einen anerkannten Weiterbildungstitel und die kantonale Bewilligung. Hauptarbeitgeber im Tessin: kantonale Psychiatrie (OSC), Privatkliniken und Gemeinschaftspraxen.',
    requisiti:
      'Master in Psychologie, PsyKo-Anerkennung (Psychologieberufekommission); für Psychotherapie eidgenössischer Weiterbildungstitel plus kantonale Berufsausübungsbewilligung.',
    typicalTasks:
      'Klinische Gespräche, Diagnostik und Testpsychologie, Psychotherapie unter Supervision, Berichte für Behörden und Versicherer, interdisziplinäre Teamarbeit, Präventionsprojekte.',
  },
  fisioterapista: {
    role: 'Physiotherapeut',
    descriptor: 'Physiotherapeuten-Stellen im Tessin',
    roleSummary:
      'Physiotherapie ist ein GesBG-regulierter Beruf: ausländische Diplome brauchen die SRK-Anerkennung vor der Festanstellung. Die Nachfrage tragen EOC-Spitäler, Reha-Kliniken und Privatpraxen.',
    requisiti:
      'Physiotherapie-Abschluss, SRK-Anerkennung, kantonale Bewilligung für selbständige Tätigkeit, NAREG-Registrierung; Deutsch erweitert die Optionen ausserhalb des Tessins.',
    typicalTasks:
      'Funktionsdiagnostik, manuelle und apparative Therapie, postoperative und Sport-Rehabilitation, therapeutische Gruppengymnastik, klinische Dokumentation, Koordination mit verordnenden Ärzten.',
  },
  logopedista: {
    role: 'Logopäde',
    descriptor: 'Logopäden-Stellen im Tessin',
    roleSummary:
      'Logopädie wird im Schul- und Klinikbereich ausgeübt; die Anerkennung ausländischer Diplome läuft über die EDK. Italienisch als Muttersprache ist in Tessiner Schuldiensten und Neuroreha-Abteilungen ein echter Vorteil.',
    requisiti:
      'Logopädie-Abschluss, EDK-Anerkennung des ausländischen Diploms, pädiatrische Erfahrung für Schuldienste geschätzt.',
    typicalTasks:
      'Abklärung von Sprach- und Schluckstörungen, Einzeltherapie für Kinder und Erwachsene, Beratung von Lehrpersonen und Familien, Dokumentation, Zusammenarbeit mit HNO und Schuldiensten.',
  },
  farmacista: {
    role: 'Apotheker',
    descriptor: 'Apotheker-Stellen im Tessin',
    roleSummary:
      'Apotheker ist ein universitärer Medizinalberuf nach MedBG: Diplome anerkennt die MEBEKO. Gearbeitet wird in öffentlichen Apotheken, der EOC-Spitalpharmazie und der Industrie; die Leitung einer Apotheke erfordert das anerkannte eidgenössische Diplom.',
    requisiti:
      'Master in Pharmazie, MEBEKO-Anerkennung, MedReg-Registrierung; für die Geschäftsführung zusätzlich kantonale Bewilligung.',
    typicalTasks:
      'Rezeptvalidierung und -abgabe, Patientenberatung, galenische Herstellungen, Lager- und Betäubungsmittelverwaltung, Impfungen in der Apotheke, Pharmakovigilanz.',
  },
  ostetrica: {
    role: 'Hebamme',
    descriptor: 'Hebammen-Stellen im Tessin',
    roleSummary:
      'Das Hebammenwesen fällt unter das harmonisierte Verfahren der EU-Richtlinie 2005/36/EG: die SRK-Anerkennung gehört zu den schnellsten der Gesundheitsberufe. Die EOC-Geburtenabteilungen bündeln die Nachfrage, Pikettdienst wird nach GAV vergütet.',
    requisiti:
      'Hebammen-Abschluss, SRK-Anerkennung im harmonisierten EU-Verfahren, NAREG-Registrierung, kantonale Bewilligung für freiberufliche Tätigkeit.',
    typicalTasks:
      'Begleitung von Schwangerschaft, Geburt und Wochenbett, CTG-Überwachung, Stillberatung, Geburtsvorbereitungskurse, klinische Dokumentation, Pikett im Gebärsaal.',
  },
  'assistente-dentale': {
    role: 'Dentalassistent',
    descriptor: 'Dentalassistenz-Stellen im Tessin',
    roleSummary:
      'Der Beruf ist eidgenössisch nicht reglementiert: Tessiner Praxen stellen auch mit ausländischer Qualifikation ein; die freiwillige SEFRI-Anerkennung des EFZ-Titels wird geschätzt. Die SSO-Lohnempfehlungen sind der Branchenmassstab.',
    requisiti:
      'Dentalassistenz-Qualifikation, Strahlenschutz nach Schweizer Vorgaben für intraorale Röntgenaufnahmen, freiwillige SEFRI-Titelanerkennung.',
    typicalTasks:
      'Assistenz am Behandlungsstuhl, Instrumentenaufbereitung und Sterilisation, intraorale Röntgenbilder, Termin- und Recall-Verwaltung, Administration und Abrechnung, Praxishygiene.',
  },
  'tecnico-radiologia': {
    role: 'Radiologiefachmann',
    descriptor: 'Radiologiefach-Stellen (MTR) im Tessin',
    roleSummary:
      'Die Radiologiefachperson ist ein reglementierter Gesundheitsberuf: ausländische Diplome brauchen die SRK-Anerkennung, der Strahlenschutz folgt der StSV. EOC und Privatkliniken stellen für konventionelles Röntgen, CT, MRI und Radiotherapie ein.',
    requisiti:
      'Abschluss in medizinisch-technischer Radiologie, SRK-Anerkennung, Strahlenschutzausbildung nach StSV, NAREG-Registrierung.',
    typicalTasks:
      'Konventionelle Röntgenuntersuchungen, CT und MRI, Radiotherapie-Behandlungen, Dosismanagement und Patientenstrahlenschutz, Qualitätskontrolle der Geräte.',
  },
  oss: {
    role: 'Fachperson Gesundheit',
    descriptor: 'FaGe-Stellen im Tessin',
    roleSummary:
      'Das Schweizer Pendant zum italienischen OSS ist die Fachperson Gesundheit EFZ: die Titelanerkennung läuft über das SRK. Alters- und Pflegeheime, EOC und Spitex stellen laufend ein; die Löhne regeln GAV EOC und ROCA.',
    requisiti:
      'OSS-Qualifikation (≥1000 Stunden), SRK-Anerkennung Richtung FaGe EFZ; viele Heime akzeptieren den ausländischen Titel mit belegter Erfahrung.',
    typicalTasks:
      'Grundpflege und Hygiene, Mobilisation, Vitalzeichenkontrolle, Unterstützung im Alltag, Pflegedokumentation, Zusammenarbeit mit dem Pflegefachpersonal.',
  },
  'ottico-optometrista': {
    role: 'Optiker-Optometrist',
    descriptor: 'Optiker- und Optometristen-Stellen im Tessin',
    roleSummary:
      'Der Optometrist ist ein GesBG-Beruf (SRK-Anerkennung), der Optiker EFZ läuft über das SEFRI. Ketten (Fielmann, Visilab, McOptic) und unabhängige Geschäfte stellen ein; selbständige Refraktion erfordert den anerkannten Optometristentitel.',
    requisiti:
      'Optiker-Diplom oder Optometrie-Abschluss; SRK-Anerkennung für Optometristen bzw. SEFRI für Optiker; Italienisch unerlässlich, Deutsch in Ketten von Vorteil.',
    typicalTasks:
      'Refraktion und Sehtests, Kontaktlinsenanpassung, Fassungs- und Glasberatung, begleiteter Verkauf, kleine Reparaturen und Wartung, Werkstattführung.',
  },
  contabile: {
    role: 'Buchhalter',
    descriptor: 'Buchhalter-Stellen im Tessin',
    roleSummary:
      'Buchhaltung ist kein reglementierter Beruf: ausländische Abschlüsse sind sofort einsetzbar. Treuhandbüros, Multis und Tessiner KMU suchen Profile mit Schweizer MWST-, Lohn- und Swiss-GAAP-RPC-Erfahrung.',
    requisiti:
      'Handelsdiplom oder Wirtschaftsstudium; Kenntnisse in Schweizer MWST, Lohnausweis und Sozialversicherungen (AHV/BVG); der eidgenössische Fachausweis Finanz- und Rechnungswesen ist der Referenztitel.',
    typicalTasks:
      'Haupt- und Nebenbuchhaltung, Monats- und Jahresabschlüsse, MWST-Abrechnungen, Lohn- und Sozialversicherungswesen, Bankabstimmungen, Management-Reporting.',
  },
  'assistente-sociale': {
    role: 'Sozialarbeiter',
    descriptor: 'Sozialarbeiter-Stellen im Tessin',
    roleSummary:
      'Soziale Arbeit ist eidgenössisch nicht reglementiert: die freiwillige SEFRI-Anerkennung des FH-Titels verlangen öffentliche Stellen aber oft. Im Tessin stellen kommunale und kantonale Sozialdienste, Institute und Stiftungen ein.',
    requisiti:
      'Abschluss in Sozialer Arbeit, freiwillige SEFRI-Anerkennung des FH-Titels, Kenntnis des Tessiner Dienstleistungsnetzes geschätzt.',
    typicalTasks:
      'Fallführung für Klienten und Familien, Sozialabklärungen, Interventionspläne, Koordination mit kantonalen und kommunalen Diensten, Beistandschaften, Dokumentation.',
  },
  macellaio: {
    role: 'Metzger',
    descriptor: 'Metzger-Stellen im Tessin',
    roleSummary:
      'Grossverteiler (Coop, Migros) und die Fleischindustrie stellen laufend Metzger ein; der GAV der Schweizer Fleischwirtschaft ist allgemeinverbindlich und setzt Mindestlöhne. Die SEFRI-Anerkennung Richtung Fleischfachmann EFZ ist freiwillig.',
    requisiti:
      'Berufsqualifikation oder gleichwertige Erfahrung in Metzgerei/Fleischindustrie, HACCP-Hygiene nach Schweizer Lebensmittelrecht, freiwillige SEFRI-Anerkennung.',
    typicalTasks:
      'Ausbeinen und Zerlegen, Thekenvorbereitung, Charcuterie-Produktion, Verpackung, Kühlketten- und HACCP-Einhaltung, Kundenberatung.',
  },
  saldatore: {
    role: 'Schweisser',
    descriptor: 'Schweisser-Stellen im Tessin',
    roleSummary:
      'Schweissen erfordert keine Titelanerkennung: Werkstätten und Metallbaufirmen verlangen gültige EN-ISO-9606-Zertifikate pro Verfahren. Die Löhne folgen den GAV der MEM-Industrie und des Metallbaus.',
    requisiti:
      'Gültige EN-ISO-9606-Schweisszertifikate (WIG/MIG/MAG/Elektrode), technisches Zeichnungslesen, Erfahrung mit Stahl, Inox oder Aluminium.',
    typicalTasks:
      'WIG/MIG/MAG-Schweissen an Stahl, Inox und Aluminium, Nahtvorbereitung, visuelle und dimensionale Qualitätskontrolle, Anlagenwartung, Auftragsarbeit in Werkstatt oder auf Baustelle.',
  },
  architetto: {
    role: 'Architekt',
    descriptor: 'Architekten-Stellen im Tessin',
    roleSummary:
      'Wer im Tessin Projekte unterzeichnen will, braucht den OTIA-Eintrag (oder REG A/B) — der Schlüsselschritt für Grenzgänger der Branche. Tessiner Büros und Generalunternehmer suchen Bauleitungserfahrung und SIA-Normen-Kenntnis.',
    requisiti:
      'Master in Architektur mit Berufsbefähigung, OTIA-Eintrag für die Tätigkeit im Tessin oder REG-Register, Kenntnis der SIA-Normen und kantonalen Bauverfahren.',
    typicalTasks:
      'Vor- und Bauprojekt, Baugesuche, Bauleitung, Ausmasse und Leistungsverzeichnisse nach SIA, Koordination der Fachplaner, Aufnahmen und Begehungen.',
  },
};

const FR_PROFESSION_STRINGS: Record<ProfessionId, ProfessionStrings> = {
  infermiere: {
    role: 'infirmier/infirmière',
    descriptor: 'les métiers de la santé au Tessin',
    roleSummary:
      'Les infirmier·ères suisses sont titulaires d\'un Bachelor HF/SUP et bénéficient d\'une autonomie clinique supérieure à la norme italienne. Au Tessin la langue de travail est l\'italien; EOC et plusieurs cliniques privées recrutent régulièrement des diplômés italiens.',
    requisiti:
      'Bachelor italien en sciences infirmières (L/SNT1), reconnaissance Croix-Rouge suisse (SRK), inscription au registre cantonal si requise.',
    typicalTasks:
      'Soins directs, administration des traitements, accès veineux, dossier clinique informatisé, transmissions pluridisciplinaires, encadrement des stagiaires.',
  },
  operaio: {
    role: 'ouvrier de production',
    descriptor: 'les emplois d\'ouvrier au Tessin',
    roleSummary:
      'Les ouvriers industriels du Tessin se concentrent sur la métallurgie, la chimie (Lonza, Siegfried) et l\'agroalimentaire. Aucun diplôme spécifique n\'est exigé.',
    requisiti:
      'Scolarité obligatoire plus éventuel certificat IeFP. Aucune reconnaissance SEFRI n\'est nécessaire à l\'embauche.',
    typicalTasks:
      'Opérations en ligne, contrôle qualité de premier niveau, maintenance de base, logistique interne, emballage, respect des consignes SUVA.',
  },
  impiegato: {
    role: 'employé de commerce',
    descriptor: 'les emplois de bureau au Tessin',
    roleSummary:
      'Les postes administratifs au Tessin couvrent la gestion, la comptabilité, la banque front-office, le service client et le support commercial. Le standard KV suisse prévaut, le diplôme italien ITC est largement accepté.',
    requisiti:
      'Diplôme italien ITC ou ragioneria; italien langue maternelle, allemand/français bienvenus; maîtrise Office, ERP, CRM.',
    typicalTasks:
      'Processus administratifs, écritures comptables, relation clients/fournisseurs, support commercial, reporting, conformité bancaire/assurance.',
  },
  ingegnere: {
    role: 'ingénieur',
    descriptor: 'les postes d\'ingénieur au Tessin',
    roleSummary:
      'Les ingénieurs tessinois se répartissent entre bureaux techniques (Lombardi, Pini Swiss), industrie (ABB, AGIE, Hamilton) et fintech (Tether, Lugano crypto-valley). Demande croissante pour les profils industriels, électroniques et logiciels.',
    requisiti:
      'Master italien en ingénierie; anglais technique; inscription REG recommandée pour l\'exercice libéral ou le timbrage de projets de génie civil.',
    typicalTasks:
      'Conception, calculs structurels, cahiers des charges, direction des travaux, développement embarqué ou entreprise, sécurité fonctionnelle, coordination pluridisciplinaire.',
  },
  educatore: {
    role: 'éducateur social',
    descriptor: 'les emplois d\'éducateur social au Tessin',
    roleSummary:
      'Les éducateurs sociaux du Tessin exercent en foyers pour mineurs, communautés thérapeutiques, centres de jour pour personnes en situation de handicap et services de proximité. Offre limitée mais très qualifiée avec CCT dédiée.',
    requisiti:
      'Bachelor italien en sciences de l\'éducation, service social ou éducation professionnelle; reconnaissance SEFRI; connaissance des normes LIPMin et LAS.',
    typicalTasks:
      'Accompagnement éducatif individualisé, rédaction de projets, liaison famille-santé, animation de groupes, soutien à la réinsertion.',
  },
  autista: {
    role: 'chauffeur professionnel',
    descriptor: 'les postes de chauffeur au Tessin',
    roleSummary:
      'La demande tessinoise se concentre sur le fret C/CE, les bus D (CarPostal), autocars touristiques et navettes aéroportuaires. CCT obligatoire dans toute la Suisse.',
    requisiti:
      'Permis italien C/CE ou D/DE, CQC valide, conversion OAut dans les 12 mois du premier emploi suisse, certificat médical, casier vierge.',
    typicalTasks:
      'Livraisons quotidiennes, respect du Règlement (CE) 561/2006 sur les temps de conduite, tachygraphe numérique, chargement/déchargement, entretien de base.',
  },
  muratore: {
    role: 'maçon',
    descriptor: 'les emplois de maçon au Tessin',
    roleSummary:
      'Le bâtiment est l\'un des plus grands employeurs frontaliers du Tessin. La CNM (convention-cadre du gros œuvre) impose des salaires minimaux contraignants sans dérogation.',
    requisiti:
      'Qualification italienne IeFP bâtiment ou diplôme technique avec reconnaissance SEFRI; EPI SUVA et sécurité chantier; certificats échafaudage et engins.',
    typicalTasks:
      'Ouvrages en béton armé, maçonnerie porteuse, enduits, pose de préfabriqués, gestion de chantier au standard suisse, contrôles post-coulage.',
  },
  cuoco: {
    role: 'cuisinier',
    descriptor: 'les postes de cuisinier au Tessin',
    roleSummary:
      'L\'hôtellerie tessinoise inclut des établissements 4-5 étoiles (Ascona, Lugano), restaurants traditionnels, cuisines hospitalières et restauration collective. L-GAV encadre salaires minimaux et horaires.',
    requisiti:
      'Qualification italienne IeFP hôtelière ou diplôme IPSSAR, HACCP, italien (allemand apprécié pour les hôtels grisons italophones), expérience en brigade.',
    typicalTasks:
      'Préparation du menu, respect de la chaîne du froid, gestion du stock cuisine, encadrement des commis/apprentis, coordination avec la salle.',
  },
  cameriere: {
    role: 'serveur',
    descriptor: 'les postes de serveur au Tessin',
    roleSummary:
      'Le service en salle au Tessin relève du L-GAV et ne demande qu\'une formation de base. Forte saisonnalité estivale à Ascona, Locarno et Lugano.',
    requisiti:
      'Pas de qualification obligatoire; italien, allemand apprécié; aisance relationnelle, présentation soignée, flexibilité sur horaires coupés.',
    typicalTasks:
      'Accueil client, présentation du menu, prise de commande, service à table, accords mets/vins, clôture du ticket, nettoyage salle et matériel.',
  },
  elettricista: {
    role: 'électricien installateur',
    descriptor: 'les postes d\'électricien au Tessin',
    roleSummary:
      'L\'installation électrique est une profession réglementée par l\'ESTI. L\'accès complet exige le diplôme AFC et l\'autorisation fédérale pour intervenir sous tension; beaucoup d\'italiens commencent comme aide-monteurs.',
    requisiti:
      'Qualification italienne IeFP électrotechnique ou diplôme ITIS perito elettrotecnico, reconnaissance SEFRI, autorisation ESTI pour interventions sous tension, connaissance NIBT basse tension.',
    typicalTasks:
      'Pose de chemins de câbles et câblage, montage d\'armoires, tests d\'isolement, diagnostic de pannes, mise en service domotique, documentation ESTI.',
  },
  psicologo: {
    role: 'psychologue',
    descriptor: 'les postes de psychologue au Tessin',
    roleSummary:
      'Le titre de psychologue est protégé par la LPsy; la psychothérapie exige en plus un titre postgrade reconnu et l\'autorisation cantonale. Principaux employeurs tessinois: psychiatrie cantonale (OSC), cliniques privées et cabinets de groupe.',
    requisiti:
      'Master en psychologie, reconnaissance PsyCo (Commission des professions de la psychologie); pour la psychothérapie, titre postgrade fédéral plus autorisation cantonale de pratiquer.',
    typicalTasks:
      'Entretiens cliniques, bilans et tests psychologiques, psychothérapie sous supervision, rapports pour institutions et assureurs, travail en équipe pluridisciplinaire, projets de prévention.',
  },
  fisioterapista: {
    role: 'physiothérapeute',
    descriptor: 'les postes de physiothérapeute au Tessin',
    roleSummary:
      'La physiothérapie est une profession réglementée par la LPSan: les diplômes étrangers doivent être reconnus par la CRS avant un engagement stable. La demande vient des hôpitaux EOC, des cliniques de réadaptation et des cabinets privés.',
    requisiti:
      'Diplôme de physiothérapie, reconnaissance CRS, autorisation cantonale pour la pratique indépendante, inscription NAREG; l\'allemand élargit les options hors du Tessin.',
    typicalTasks:
      'Bilan fonctionnel, thérapie manuelle et instrumentale, réadaptation post-opératoire et sportive, gymnastique thérapeutique de groupe, documentation clinique, coordination avec les médecins prescripteurs.',
  },
  logopedista: {
    role: 'logopédiste',
    descriptor: 'les postes de logopédiste au Tessin',
    roleSummary:
      'La logopédie s\'exerce en milieu scolaire et clinique; la reconnaissance des diplômes étrangers passe par la CDIP. L\'italien langue maternelle est un vrai atout dans les services scolaires et la neuro-réadaptation tessinoise.',
    requisiti:
      'Diplôme de logopédie, reconnaissance CDIP du diplôme étranger, expérience pédiatrique appréciée pour les services scolaires.',
    typicalTasks:
      'Bilan des troubles du langage et de la déglutition, thérapie individuelle enfants et adultes, conseil aux enseignants et aux familles, documentation, collaboration avec ORL et services scolaires.',
  },
  farmacista: {
    role: 'pharmacien',
    descriptor: 'les postes de pharmacien au Tessin',
    roleSummary:
      'Le pharmacien est une profession médicale universitaire selon la LPMéd: les diplômes sont reconnus par la MEBEKO. On travaille en officine, en pharmacie hospitalière EOC et dans l\'industrie; diriger une pharmacie exige le diplôme fédéral reconnu.',
    requisiti:
      'Master en pharmacie, reconnaissance MEBEKO, inscription MedReg; la gérance exige en outre l\'autorisation cantonale.',
    typicalTasks:
      'Validation et délivrance des ordonnances, conseil au patient, préparations galéniques, gestion des stocks et des stupéfiants, vaccinations en officine, pharmacovigilance.',
  },
  ostetrica: {
    role: 'sage-femme',
    descriptor: 'les postes de sage-femme au Tessin',
    roleSummary:
      'La profession de sage-femme relève de la procédure harmonisée de la directive UE 2005/36/CE: la reconnaissance CRS est parmi les plus rapides des professions de santé. Les maternités EOC concentrent la demande, avec piquets rémunérés selon CCT.',
    requisiti:
      'Diplôme de sage-femme, reconnaissance CRS via la procédure harmonisée UE, inscription NAREG, autorisation cantonale pour la pratique indépendante.',
    typicalTasks:
      'Suivi de la grossesse, de l\'accouchement et du post-partum, monitoring CTG, soutien à l\'allaitement, cours de préparation à la naissance, documentation clinique, piquets en salle d\'accouchement.',
  },
  'assistente-dentale': {
    role: 'assistant dentaire',
    descriptor: 'les postes d\'assistant dentaire au Tessin',
    roleSummary:
      'La profession n\'est pas réglementée au niveau fédéral: les cabinets tessinois engagent aussi avec une qualification étrangère; la reconnaissance SEFRI facultative du titre CFC est appréciée. Les recommandations salariales SSO servent de référence.',
    requisiti:
      'Qualification d\'assistant dentaire, radioprotection selon les règles suisses pour les radiographies intra-orales, reconnaissance SEFRI facultative.',
    typicalTasks:
      'Assistance au fauteuil à quatre mains, préparation et stérilisation des instruments, radiographies intra-orales, gestion de l\'agenda et des rappels, administration et facturation, hygiène du cabinet.',
  },
  'tecnico-radiologia': {
    role: 'technicien en radiologie médicale',
    descriptor: 'les postes de TRM au Tessin',
    roleSummary:
      'Le TRM est une profession de santé réglementée: les diplômes étrangers doivent être reconnus par la CRS et la radioprotection suit l\'ORaP suisse. L\'EOC et les cliniques privées recrutent en radiologie conventionnelle, CT, IRM et radiothérapie.',
    requisiti:
      'Diplôme de technicien en radiologie médicale, reconnaissance CRS, formation en radioprotection selon l\'ORaP, inscription NAREG.',
    typicalTasks:
      'Examens radiologiques conventionnels, CT et IRM, traitements de radiothérapie, gestion des doses et radioprotection du patient, contrôle qualité des équipements.',
  },
  oss: {
    role: 'assistant en soins et santé communautaire',
    descriptor: 'les postes ASSC/OSS au Tessin',
    roleSummary:
      'L\'équivalent suisse de l\'OSS italien est l\'assistant en soins et santé communautaire CFC: la reconnaissance du titre passe par la CRS. EMS, EOC et Spitex recrutent en continu, avec des salaires régis par les CCT EOC et ROCA.',
    requisiti:
      'Qualification OSS (≥1000 heures), reconnaissance CRS vers le CFC d\'ASSC; beaucoup d\'EMS acceptent le titre étranger avec expérience documentée.',
    typicalTasks:
      'Soins de base et hygiène, mobilisation, contrôle des signes vitaux, aide aux activités quotidiennes, documentation des soins, collaboration avec le personnel infirmier.',
  },
  'ottico-optometrista': {
    role: 'opticien-optométriste',
    descriptor: 'les postes d\'opticien et optométriste au Tessin',
    roleSummary:
      'L\'optométriste est une profession LPSan (reconnaissance CRS), l\'opticien CFC passe par le SEFRI. Les chaînes (Fielmann, Visilab, McOptic) et les magasins indépendants recrutent; la réfraction autonome exige le titre d\'optométriste reconnu.',
    requisiti:
      'Diplôme d\'opticien ou bachelor en optométrie; reconnaissance CRS pour l\'optométriste ou SEFRI pour l\'opticien; italien indispensable, allemand utile dans les chaînes.',
    typicalTasks:
      'Réfraction et examens de la vue, adaptation de lentilles de contact, conseil montures et verres, vente assistée, petites réparations et entretien, gestion de l\'atelier.',
  },
  contabile: {
    role: 'comptable',
    descriptor: 'les postes de comptable au Tessin',
    roleSummary:
      'La comptabilité n\'est pas une profession réglementée: les diplômes étrangers sont utilisables immédiatement. Fiduciaires, multinationales et PME tessinoises recherchent TVA suisse, salaires et Swiss GAAP RPC.',
    requisiti:
      'Diplôme de comptabilité ou études d\'économie; connaissance de la TVA suisse, du certificat de salaire et des assurances sociales (AVS/LPP); le brevet fédéral de spécialiste en finance et comptabilité est le titre de référence.',
    typicalTasks:
      'Comptabilité générale et auxiliaire, clôtures mensuelles et annuelles, décomptes TVA, salaires et assurances sociales, rapprochements bancaires, reporting à la direction.',
  },
  'assistente-sociale': {
    role: 'assistant social',
    descriptor: 'les postes d\'assistant social au Tessin',
    roleSummary:
      'Le travail social n\'est pas réglementé au niveau fédéral: la reconnaissance SEFRI facultative du titre HES est toutefois souvent demandée par les employeurs publics. Au Tessin recrutent les services sociaux communaux et cantonaux, instituts et fondations.',
    requisiti:
      'Diplôme en travail social, reconnaissance SEFRI facultative du titre HES, connaissance du réseau tessinois appréciée.',
    typicalTasks:
      'Suivi d\'usagers et de familles, évaluations sociales, projets d\'intervention, coordination avec les services cantonaux et communaux, curatelles, documentation.',
  },
  macellaio: {
    role: 'boucher',
    descriptor: 'les postes de boucher au Tessin',
    roleSummary:
      'La grande distribution (Coop, Migros) et l\'industrie de la viande recrutent en continu; la CCT de l\'économie carnée suisse a force obligatoire générale et fixe les minima salariaux. La reconnaissance SEFRI vers le CFC de boucher-charcutier est facultative.',
    requisiti:
      'Qualification professionnelle ou expérience équivalente en boucherie/industrie de la viande, hygiène HACCP selon le droit alimentaire suisse, reconnaissance SEFRI facultative.',
    typicalTasks:
      'Désossage et découpe, préparation du comptoir, production de charcuterie, conditionnement, respect de la chaîne du froid et HACCP, conseil à la clientèle.',
  },
  saldatore: {
    role: 'soudeur',
    descriptor: 'les postes de soudeur au Tessin',
    roleSummary:
      'La soudure n\'exige aucune reconnaissance de titre: comptent les certifications EN ISO 9606 en cours de validité, exigées par ateliers et constructions métalliques pour chaque procédé. Les salaires suivent les CCT de l\'industrie MEM et de la construction métallique.',
    requisiti:
      'Certifications de soudage EN ISO 9606 valides (TIG/MIG/MAG/électrode), lecture de plans, expérience sur acier, inox ou aluminium.',
    typicalTasks:
      'Soudage TIG/MIG/MAG sur acier, inox et aluminium, préparation des joints, contrôle qualité visuel et dimensionnel, entretien des installations, travail à la commande en atelier ou sur chantier.',
  },
  architetto: {
    role: 'architecte',
    descriptor: 'les postes d\'architecte au Tessin',
    roleSummary:
      'Signer des projets au Tessin exige l\'inscription à l\'OTIA (ou au registre REG A/B): l\'étape clé pour les frontaliers du secteur. Les bureaux tessinois et les entreprises générales recherchent l\'expérience de direction de travaux et les normes SIA.',
    requisiti:
      'Master en architecture avec habilitation, inscription OTIA pour exercer au Tessin ou registre REG, connaissance des normes SIA et des procédures cantonales de construction.',
    typicalTasks:
      'Avant-projet et projet définitif, demandes de permis de construire, direction des travaux, métrés et devis selon SIA, coordination des spécialistes, relevés et visites de chantier.',
  },
};

const PROFESSION_STRINGS_BY_LOCALE: Record<ProfessionLocale, Record<ProfessionId, ProfessionStrings>> = {
  it: IT_PROFESSION_STRINGS,
  en: EN_PROFESSION_STRINGS,
  de: DE_PROFESSION_STRINGS,
  fr: FR_PROFESSION_STRINGS,
};

// ─────────────────────────────────────────────────────────────────
// Per-locale shell copy (H1 template, breadcrumbs, labels).
// ─────────────────────────────────────────────────────────────────

interface LocaleShell {
  titleTemplate: (role: string) => string;
  descriptionTemplate: (role: string, median: number) => string;
  h1Template: (role: string) => string;
  ledeTemplate: (strings: ProfessionStrings, median: number, jobs: number) => string;
  updatedLabel: string;
  breadcrumbHome: string;
  breadcrumbJobs: string;
  ctaJobs: string;
  ctaSimulator: string;
  relatedLabel: string;
  faqTitle: string;
  sectionHeadings: ProfessionLandingCopy['sectionHeadings'];
  tableHeadings: ProfessionLandingCopy['tableHeadings'];
  employersTableTitle: string;
  employersTableNote: string;
  sourcesLabel: string;
  // ── Template B additions ───────────────────────────────────────────────
  /** Dense lede that lists 3 numbers (count · CHF · fresh) under the H1. */
  denseLedeTemplate: (parts: {
    role: string;
    live: number;
    fresh30: number;
    median: number;
  }) => string;
  /** Eyebrow line above the H1 (e.g. "Mestiere · Ticino · 2026"). */
  eyebrow: string;
  statTileLiveLabel: string;
  statTileSalaryLabel: string;
  statTileFreshLabel: string;
  statSalaryValueFmt: (n: number) => string;
  statFreshValueFmt: (n: number) => string;
  primaryCtaLabel: string;
  featuredJobsTitle: string;
  featuredJobsCtaAll: (n: number) => string;
  featuredJobsEmpty: string;
  employerGridTitle: string;
  /** Heading that introduces the long-form prose block at the bottom. */
  approfondisciHeading: string;
  jobPostedLabel: (daysAgo: number) => string;
  jobSalaryFmt: (min: number | null, max: number | null) => string;
}

const IT_SHELL: LocaleShell = {
  titleTemplate: (role) => `Lavoro da ${role} in Ticino 2026`,
  descriptionTemplate: (role, median) =>
    `Guida 2026 per frontalieri al lavoro da ${role} in Ticino: salario medio CHF ${median.toLocaleString('it-CH')}, CCL applicabile, riconoscimento titolo italiano, principali datori di lavoro. Aggiornato ${buildMonthYearLabel('it')}.`,
  h1Template: (role) => `Lavoro da ${role} in Ticino: guida 2026 per frontalieri`,
  ledeTemplate: (s, median, jobs) =>
    `Stai cercando ${s.descriptor}? Il mercato ticinese assorbe ogni anno centinaia di candidati italiani: nel dataset pubblico di Frontaliere Ticino risultano ${jobs} posizioni attive di recente per questo ruolo, con un salario medio stimato di CHF ${median.toLocaleString('it-CH')} lordi annui. ${s.roleSummary}`,
  updatedLabel: 'Aggiornato',
  breadcrumbHome: 'Home',
  breadcrumbJobs: 'Lavoro Ticino',
  ctaJobs: 'Vedi offerte in Ticino',
  ctaSimulator: 'Calcola il tuo stipendio netto',
  relatedLabel: 'Risorse collegate',
  faqTitle: 'Domande frequenti',
  sectionHeadings: {
    context: 'Il mestiere in Ticino: domanda, lingue, caratteristiche',
    recognition: 'Riconoscimento del titolo italiano',
    ccl: 'CCL e inquadramento contrattuale',
    salary: 'Stipendio: range tipico 2026',
    employers: 'Principali datori di lavoro in Ticino',
    permits: 'Permesso G vs B: cosa scegliere',
    application: 'Come candidarsi con successo',
  },
  tableHeadings: {
    employer: 'Datore di lavoro',
    city: 'Sede principale',
    typicalRoles: 'Tipologie di ruolo',
    salaryLabel: 'Forchetta salariale (CHF lordi annui)',
  },
  employersTableTitle: 'Top 5 datori di lavoro ticinesi',
  employersTableNote:
    'Datori di lavoro storici del settore in Ticino — non tutti hanno posizioni aperte oggi; vedi sopra chi sta assumendo ora.',
  sourcesLabel: 'Fonti ufficiali',
  denseLedeTemplate: ({ role, live, fresh30, median }) =>
    `${live} posizioni aperte per ${role} in Ticino · ${fresh30} nuove negli ultimi 30 giorni · stipendio mediano CHF ${median.toLocaleString('it-CH')} lordi all'anno.`,
  eyebrow: 'Mestiere · Ticino · 2026',
  statTileLiveLabel: 'Offerte aperte',
  statTileSalaryLabel: 'Stipendio mediano',
  statTileFreshLabel: 'Nuove (30 gg)',
  statSalaryValueFmt: (n) => `CHF ${n.toLocaleString('it-CH')}/anno`,
  statFreshValueFmt: (n) => `${n} nuove`,
  primaryCtaLabel: 'Calcola il tuo netto come frontaliere',
  featuredJobsTitle: 'Offerte in evidenza',
  featuredJobsCtaAll: (n) => `Vedi tutte le ${n} offerte →`,
  featuredJobsEmpty: 'Nessuna offerta indicizzata in questo momento — controlla il job board completo.',
  employerGridTitle: 'Chi assume in Ticino',
  approfondisciHeading: 'La professione in Ticino',
  jobPostedLabel: (d) =>
    d <= 0 ? 'Pubblicata oggi' : d === 1 ? 'Pubblicata ieri' : `Pubblicata ${d} giorni fa`,
  jobSalaryFmt: (min, max) => {
    if (min && max) return `CHF ${min.toLocaleString('it-CH')}–${max.toLocaleString('it-CH')}/anno`;
    if (min) return `Da CHF ${min.toLocaleString('it-CH')}/anno`;
    if (max) return `Fino a CHF ${max.toLocaleString('it-CH')}/anno`;
    return '';
  },
};

const EN_SHELL: LocaleShell = {
  titleTemplate: (role) =>
    `${role.charAt(0).toUpperCase()}${role.slice(1)} jobs Ticino 2026`,
  descriptionTemplate: (role, median) =>
    `2026 cross-border guide to ${role} jobs in Ticino: average CHF ${median.toLocaleString('en-CH')} gross per year, applicable collective agreement, Italian diploma recognition, top employers.`,
  h1Template: (role) =>
    `${role.charAt(0).toUpperCase()}${role.slice(1)} jobs in Ticino: 2026 cross-border guide`,
  ledeTemplate: (s, median, jobs) =>
    `Considering ${s.descriptor}? Ticino absorbs hundreds of Italian candidates each year: the Frontaliere Ticino public dataset currently lists ${jobs} recent openings for this role, with an estimated CHF ${median.toLocaleString('en-CH')} gross annual average. ${s.roleSummary}`,
  updatedLabel: 'Updated',
  breadcrumbHome: 'Home',
  breadcrumbJobs: 'Ticino jobs',
  ctaJobs: 'See Ticino openings',
  ctaSimulator: 'Compute your net salary',
  relatedLabel: 'Related resources',
  faqTitle: 'Frequently asked questions',
  sectionHeadings: {
    context: 'The role in Ticino: demand, languages, profile',
    recognition: 'Italian diploma recognition',
    ccl: 'Collective agreement and contract framework',
    salary: '2026 salary range',
    employers: 'Top Ticino employers',
    permits: 'G-permit vs B-permit',
    application: 'How to apply',
  },
  tableHeadings: {
    employer: 'Employer',
    city: 'Main location',
    typicalRoles: 'Typical roles',
    salaryLabel: 'Salary band (CHF gross / year)',
  },
  employersTableTitle: 'Top 5 Ticino employers',
  employersTableNote:
    'Long-standing sector employers in Ticino — not all have openings today; see above for who is hiring right now.',
  sourcesLabel: 'Official sources',
  denseLedeTemplate: ({ role, live, fresh30, median }) =>
    `${live} open positions for ${role} in Ticino · ${fresh30} new in the last 30 days · median gross salary CHF ${median.toLocaleString('en-CH')} per year.`,
  eyebrow: 'Profession · Ticino · 2026',
  statTileLiveLabel: 'Open positions',
  statTileSalaryLabel: 'Median salary',
  statTileFreshLabel: 'New (30 days)',
  statSalaryValueFmt: (n) => `CHF ${n.toLocaleString('en-CH')}/year`,
  statFreshValueFmt: (n) => `${n} new`,
  primaryCtaLabel: 'Calculate your cross-border net',
  featuredJobsTitle: 'Featured openings',
  featuredJobsCtaAll: (n) => `See all ${n} openings →`,
  featuredJobsEmpty: 'No indexed openings right now — check the full job board.',
  employerGridTitle: 'Who is hiring in Ticino',
  approfondisciHeading: 'The profession in Ticino',
  jobPostedLabel: (d) =>
    d <= 0 ? 'Posted today' : d === 1 ? 'Posted yesterday' : `Posted ${d} days ago`,
  jobSalaryFmt: (min, max) => {
    if (min && max) return `CHF ${min.toLocaleString('en-CH')}–${max.toLocaleString('en-CH')}/year`;
    if (min) return `From CHF ${min.toLocaleString('en-CH')}/year`;
    if (max) return `Up to CHF ${max.toLocaleString('en-CH')}/year`;
    return '';
  },
};

const DE_SHELL: LocaleShell = {
  titleTemplate: (role) => `${role} im Tessin 2026`,
  descriptionTemplate: (role, median) =>
    `Grenzgänger-Leitfaden 2026 für ${role} im Tessin: Durchschnittslohn CHF ${median.toLocaleString('de-CH')} brutto/Jahr, geltender GAV, Anerkennung italienischer Diplome, wichtigste Arbeitgeber.`,
  h1Template: (role) => `${role} im Tessin: Grenzgänger-Leitfaden 2026`,
  ledeTemplate: (s, median, jobs) =>
    `Suchen Sie ${s.descriptor}? Das Tessin beschäftigt jedes Jahr hunderte italienische Kandidaten: der öffentliche Datensatz von Frontaliere Ticino weist derzeit ${jobs} kürzlich offene Stellen für diese Rolle aus, mit einem geschätzten Durchschnittslohn von CHF ${median.toLocaleString('de-CH')} brutto pro Jahr. ${s.roleSummary}`,
  updatedLabel: 'Aktualisiert',
  breadcrumbHome: 'Startseite',
  breadcrumbJobs: 'Tessin-Jobs',
  ctaJobs: 'Stellen im Tessin ansehen',
  ctaSimulator: 'Nettolohn berechnen',
  relatedLabel: 'Verwandte Ressourcen',
  faqTitle: 'Häufig gestellte Fragen',
  sectionHeadings: {
    context: 'Der Beruf im Tessin: Nachfrage, Sprachen, Profil',
    recognition: 'Anerkennung italienischer Diplome',
    ccl: 'Gesamtarbeitsvertrag und Vertragsrahmen',
    salary: 'Lohnbandbreite 2026',
    employers: 'Wichtigste Arbeitgeber im Tessin',
    permits: 'G-Bewilligung vs B-Bewilligung',
    application: 'So bewerben Sie sich erfolgreich',
  },
  tableHeadings: {
    employer: 'Arbeitgeber',
    city: 'Hauptstandort',
    typicalRoles: 'Typische Rollen',
    salaryLabel: 'Lohnspanne (CHF brutto/Jahr)',
  },
  employersTableTitle: 'Top-5-Arbeitgeber im Tessin',
  employersTableNote:
    'Etablierte Arbeitgeber der Branche im Tessin — nicht alle haben aktuell offene Stellen; wer gerade einstellt, steht oben.',
  sourcesLabel: 'Offizielle Quellen',
  denseLedeTemplate: ({ role, live, fresh30, median }) =>
    `${live} offene Stellen für ${role} im Tessin · ${fresh30} neu in den letzten 30 Tagen · Medianlohn CHF ${median.toLocaleString('de-CH')} brutto pro Jahr.`,
  eyebrow: 'Beruf · Tessin · 2026',
  statTileLiveLabel: 'Offene Stellen',
  statTileSalaryLabel: 'Medianlohn',
  statTileFreshLabel: 'Neu (30 Tage)',
  statSalaryValueFmt: (n) => `CHF ${n.toLocaleString('de-CH')}/Jahr`,
  statFreshValueFmt: (n) => `${n} neu`,
  primaryCtaLabel: 'Grenzgänger-Nettolohn berechnen',
  featuredJobsTitle: 'Empfohlene Stellen',
  featuredJobsCtaAll: (n) => `Alle ${n} Stellen ansehen →`,
  featuredJobsEmpty: 'Derzeit keine indexierten Stellen — siehe vollständige Stellenbörse.',
  employerGridTitle: 'Wer im Tessin einstellt',
  approfondisciHeading: 'Der Beruf im Tessin',
  jobPostedLabel: (d) =>
    d <= 0 ? 'Heute veröffentlicht' : d === 1 ? 'Gestern veröffentlicht' : `Vor ${d} Tagen veröffentlicht`,
  jobSalaryFmt: (min, max) => {
    if (min && max) return `CHF ${min.toLocaleString('de-CH')}–${max.toLocaleString('de-CH')}/Jahr`;
    if (min) return `Ab CHF ${min.toLocaleString('de-CH')}/Jahr`;
    if (max) return `Bis CHF ${max.toLocaleString('de-CH')}/Jahr`;
    return '';
  },
};

const FR_SHELL: LocaleShell = {
  titleTemplate: (role) =>
    `${role.charAt(0).toUpperCase()}${role.slice(1)} au Tessin 2026`,
  descriptionTemplate: (role, median) =>
    `Guide frontalier 2026 pour les postes de ${role} au Tessin : salaire moyen CHF ${median.toLocaleString('fr-CH')} brut/an, CCT applicable, reconnaissance du diplôme italien, principaux employeurs.`,
  h1Template: (role) =>
    `${role.charAt(0).toUpperCase()}${role.slice(1)} au Tessin : guide frontalier 2026`,
  ledeTemplate: (s, median, jobs) =>
    `Vous cherchez ${s.descriptor} ? Le marché tessinois absorbe chaque année des centaines de candidats italiens : le jeu de données public de Frontaliere Ticino recense ${jobs} postes récents pour ce rôle, avec un salaire moyen estimé à CHF ${median.toLocaleString('fr-CH')} brut par an. ${s.roleSummary}`,
  updatedLabel: 'Mis à jour',
  breadcrumbHome: 'Accueil',
  breadcrumbJobs: 'Emploi Tessin',
  ctaJobs: 'Voir les offres tessinoises',
  ctaSimulator: 'Calculer votre salaire net',
  relatedLabel: 'Ressources associées',
  faqTitle: 'Questions fréquentes',
  sectionHeadings: {
    context: 'Le métier au Tessin : demande, langues, profil',
    recognition: 'Reconnaissance du diplôme italien',
    ccl: 'Convention collective et cadre contractuel',
    salary: 'Fourchette salariale 2026',
    employers: 'Principaux employeurs tessinois',
    permits: 'Permis G vs permis B',
    application: 'Comment postuler avec succès',
  },
  tableHeadings: {
    employer: 'Employeur',
    city: 'Siège principal',
    typicalRoles: 'Rôles typiques',
    salaryLabel: 'Fourchette salariale (CHF brut/an)',
  },
  employersTableTitle: 'Top 5 des employeurs tessinois',
  employersTableNote:
    'Employeurs historiques du secteur au Tessin — tous n\'ont pas de postes ouverts aujourd\'hui ; voir plus haut qui recrute actuellement.',
  sourcesLabel: 'Sources officielles',
  denseLedeTemplate: ({ role, live, fresh30, median }) =>
    `${live} postes ouverts pour ${role} au Tessin · ${fresh30} nouveaux ces 30 derniers jours · salaire médian CHF ${median.toLocaleString('fr-CH')} brut par an.`,
  eyebrow: 'Métier · Tessin · 2026',
  statTileLiveLabel: 'Postes ouverts',
  statTileSalaryLabel: 'Salaire médian',
  statTileFreshLabel: 'Nouveaux (30 j)',
  statSalaryValueFmt: (n) => `CHF ${n.toLocaleString('fr-CH')}/an`,
  statFreshValueFmt: (n) => `${n} nouveaux`,
  primaryCtaLabel: 'Calculer votre net frontalier',
  featuredJobsTitle: 'Offres mises en avant',
  featuredJobsCtaAll: (n) => `Voir les ${n} offres →`,
  featuredJobsEmpty: 'Aucune offre indexée actuellement — consultez la bourse complète.',
  employerGridTitle: 'Qui recrute au Tessin',
  approfondisciHeading: 'Le métier au Tessin',
  jobPostedLabel: (d) =>
    d <= 0 ? 'Publié aujourd\'hui' : d === 1 ? 'Publié hier' : `Publié il y a ${d} jours`,
  jobSalaryFmt: (min, max) => {
    if (min && max) return `CHF ${min.toLocaleString('fr-CH')}–${max.toLocaleString('fr-CH')}/an`;
    if (min) return `Dès CHF ${min.toLocaleString('fr-CH')}/an`;
    if (max) return `Jusqu'à CHF ${max.toLocaleString('fr-CH')}/an`;
    return '';
  },
};

const LOCALE_SHELLS: Record<ProfessionLocale, LocaleShell> = {
  it: IT_SHELL,
  en: EN_SHELL,
  de: DE_SHELL,
  fr: FR_SHELL,
};

// ─────────────────────────────────────────────────────────────────
// Section builders — produce 7 H2 paragraphs per locale.
// ─────────────────────────────────────────────────────────────────

function buildSections(
  locale: ProfessionLocale,
  id: ProfessionId,
): ProfessionLandingSection[] {
  const facts = PROFESSION_FACTS[id];
  const strings = PROFESSION_STRINGS_BY_LOCALE[locale][id];
  const shell = LOCALE_SHELLS[locale];
  const [minLead, maxLead] = facts.recognitionLeadTimeMonths;
  const [minSal, maxSal] = facts.typicalSalaryRange;
  const numberFmt = { it: 'it-CH', en: 'en-CH', de: 'de-CH', fr: 'fr-CH' }[locale];
  const fmtN = (n: number) => n.toLocaleString(numberFmt);

  if (locale === 'it') {
    return [
      {
        title: shell.sectionHeadings.context,
        paragraphs: [
          `${strings.roleSummary} Il Ticino presenta una forte domanda di ${strings.role} italiani, facilitata dalla lingua comune e dalla prossimità geografica con Lombardia e Piemonte. Il dataset pubblico di Frontaliere Ticino registra ${facts.jobsCount} posizioni recenti per questo ruolo.`,
          `Tra le caratteristiche specifiche del contesto ticinese: contratti a tempo indeterminato prevalenti, periodi di prova di 1–3 mesi (art. 335b CO), 5 settimane di vacanza minime salite a 6 dopo i 50 anni in molti CCL, assicurazioni sociali obbligatorie (AVS/AI/IPG, LAINF, LPP) a carico condiviso datore-lavoratore.`,
          `Requisiti tipici: ${strings.requisiti}. I compiti di mestiere tipici includono: ${strings.typicalTasks}`,
        ],
      },
      {
        title: shell.sectionHeadings.recognition,
        paragraphs: [
          facts.regulated
            ? `Il ruolo di ${strings.role} in Svizzera è una professione regolamentata: per essere assunti a tempo pieno o accedere ai concorsi pubblici serve il riconoscimento del titolo italiano da parte di ${facts.recognitionAuthority}. La procedura è disciplinata dall'Accordo sulla libera circolazione delle persone CH-UE e dura tipicamente ${minLead}–${maxLead} mesi dall'inoltro della pratica completa.`
            : `Il ruolo di ${strings.role} in Svizzera non è una professione regolamentata: non è obbligatorio ottenere il riconoscimento del titolo italiano prima dell'assunzione. Tuttavia, molti datori di lavoro considerano la pratica ${facts.recognitionAuthority} un segnale positivo per posizioni tecniche o per accedere a concorsi pubblici.`,
          `Documenti da preparare: diploma originale legalizzato (Apostille dell'Aia), traduzione ufficiale italiano/tedesco/francese, programma degli studi con elenco esami e ore di tirocinio, certificato di buona condotta, CV in formato europeo o svizzero. La pratica va inoltrata prima di accettare contratti a tempo indeterminato per evitare ritardi. [Fonte: ${facts.recognitionAuthority}](${facts.recognitionAuthorityUrl}) — aggiornato ${buildMonthYearLabel('it')}.`,
          facts.regulated
            ? `Se il percorso italiano risulta non pienamente equivalente allo standard svizzero, l'autorità può richiedere misure di compensazione: modulo di adattamento in struttura accreditata (3–12 mesi) oppure esame attitudinale. Molti datori offrono contratti-ponte durante l'iter.`
            : `Il riconoscimento facoltativo è particolarmente utile per chi punta a passare nel tempo dal settore privato al pubblico (concorsi cantonali, amministrazioni comunali) dove può diventare discriminante.`,
        ],
      },
      {
        title: shell.sectionHeadings.ccl,
        paragraphs: [
          `Il contratto di riferimento per ${strings.role} in Ticino è il **${facts.cclReference}**. Il CCL regola salario minimo, 13a mensilità, vacanze, maggiorazioni per notturni e festivi, periodi di preavviso, indennità di malattia e infortunio. [Fonte: SECO — CCL/GAV di obbligatorietà generale](${facts.cclUrl}) — consultato ${buildMonthYearLabel('it')}.`,
          `Per i frontalieri con permesso G il CCL svizzero si applica integralmente: salario, ferie, tredicesima, indennità di turno. Le assicurazioni sociali svizzere (AVS, AI, IPG, AD, LAINF, LPP) sono trattenute alla fonte o versate dal datore, con totalizzazione ai sensi del Regolamento (CE) 883/2004 [fonte: INPS — Prestazioni pensionistiche verso Svizzera](https://www.inps.it).`,
          `Attenzione alle deroghe per piccoli datori di lavoro o settori scoperti dal CCL: in tal caso si applica il contratto individuale nel rispetto dei salari d'uso SECO per evitare dumping salariale.`,
        ],
      },
      {
        title: shell.sectionHeadings.salary,
        paragraphs: [
          `La forchetta salariale tipica per ${strings.role} in Ticino nel 2026 è CHF ${fmtN(minSal)}–${fmtN(maxSal)} lordi annui su 13 mensilità, con un valore mediano stimato di CHF ${fmtN(facts.medianSalaryChf)} ricavato dal dataset interno Frontaliere Ticino (${facts.jobsCount} posizioni campione). Le voci variabili — turni notturni, festivi, reperibilità, straordinari — possono aggiungere dal 5 al 20 % al totale.`,
          `Per stimare il netto personalizzato (frontaliere vecchio/nuovo, chilometraggio dal confine, stato civile, figli a carico) usa il calcolatore stipendio di Frontaliere Ticino. Ricorda che l'Accordo bilaterale 2020 distingue i "nuovi frontalieri" (assunti dopo il 17/07/2023) — tassati alla fonte al 80 % in CH + dichiarazione in Italia — dai "vecchi frontalieri" che mantengono il regime precedente. [Fonte: AFC — Imposta alla fonte](https://www.estv.admin.ch/it/imposta-alla-fonte).`,
          `Le differenze fra cantoni sono minime sui salari (CCL nazionale) ma importanti sulle tasse comunali: Lugano, Mendrisio, Bellinzona hanno moltiplicatori diversi. Il calcolatore del sito tiene conto anche di questo dettaglio.`,
        ],
      },
      {
        title: shell.sectionHeadings.employers,
        paragraphs: [
          `I principali datori di lavoro ticinesi per il ruolo di ${strings.role} includono: ${facts.topEmployers.join(', ')}. Queste realtà pubblicano concorsi regolari sui propri portali carriere e su aggregatori nazionali (jobs.ch, jobup.ch, jobagent.ch).`,
          `Le sedi principali dei posti pubblicati negli ultimi 12 mesi sono concentrate a ${facts.topCities.join(', ')} — aree con migliore accessibilità dai valichi di Chiasso-Brogeda, Stabio-Gaggiolo e Ponte Tresa. Considerare la distanza dal confine quando si valuta lo stipendio netto: i "nuovi frontalieri" oltre i 20 km dal confine subiscono un regime fiscale leggermente diverso.`,
          `Frontaliere Ticino pubblica un aggiornamento settimanale delle offerte per questo ruolo nella pagina "${strings.role} in Ticino" — iscriviti agli alert per non perdere i nuovi bandi.`,
        ],
      },
      {
        title: shell.sectionHeadings.permits,
        paragraphs: [
          `Permesso G (frontaliere): residenza in Italia, rientro settimanale, imposta alla fonte in CH + dichiarazione in IT (nuovi frontalieri post-2023). Vantaggi: possibile mantenere l'assicurazione sanitaria italiana (diritto di opzione LAMal), accesso al SSN per familiari, minori spese di trasloco. Svantaggi: LPP più contenuta, accesso limitato al mutuo svizzero, tempi di viaggio quotidiani. [Fonte: SEM — Permessi di lavoro](https://www.sem.admin.ch).`,
          `Permesso B (residente): residenza in Svizzera, soggetto fiscale svizzero, obbligo LAMal, accesso pieno LPP (2° pilastro), possibilità di aprire mutui svizzeri. Vantaggi: netto spesso superiore a parità di lordo grazie al trattamento fiscale, stabilità professionale, accesso completo al welfare. Svantaggi: costo affitti (Lugano, Mendrisio), LAMal obbligatoria (CHF 400–600/mese adulto), distacco da famiglia/rete in Italia.`,
          `La scelta dipende dal progetto di vita: per un ruolo con stipendio inferiore a CHF 75'000 e famiglia in Italia, il permesso G è quasi sempre più conveniente; oltre i CHF 90'000 o con progetti di acquisto casa, il permesso B diventa più vantaggioso.`,
        ],
      },
      {
        title: shell.sectionHeadings.application,
        paragraphs: [
          `Un'applicazione di successo per ${strings.role} in Ticino segue le convenzioni svizzere: CV in italiano ma in formato "swiss standard" (foto, tutti i diplomi, ore di formazione certificate, referenze verificabili), lettera motivazionale personalizzata di massimo una pagina, copie dei certificati di lingua (se richiesti).`,
          `Il processo di selezione prevede tipicamente: screening telefonico (10–15 min), colloquio HR (45–60 min), colloquio tecnico con il responsabile operativo (60–90 min), eventuale prova pratica o assessment (specialmente per ruoli ospedalieri, edili, elettrotecnici). La call-back al candidato avviene di solito entro 10 giorni lavorativi.`,
          `Tempistiche realistiche dal primo invio del CV al contratto firmato: 4–8 settimane. Avvia in parallelo la pratica di riconoscimento e la richiesta del permesso G/B per non bloccare la data di inizio.`,
        ],
      },
    ];
  }

  if (locale === 'en') {
    return [
      {
        title: shell.sectionHeadings.context,
        paragraphs: [
          `${strings.roleSummary} Ticino shows constant demand for Italian ${strings.role}s, supported by the shared language and geographic proximity to Lombardy and Piedmont. The Frontaliere Ticino public dataset lists ${facts.jobsCount} recent openings for this role.`,
          `Typical Swiss context: indefinite-term contracts prevail, 1–3-month probation periods (art. 335b CO), minimum 5 weeks of paid leave (6 after age 50 in most CLAs), mandatory social insurance (AVS/AI/IPG, LAINF, LPP) shared between employer and employee.`,
          `Requirements: ${strings.requisiti}. Typical tasks: ${strings.typicalTasks}`,
        ],
      },
      {
        title: shell.sectionHeadings.recognition,
        paragraphs: [
          facts.regulated
            ? `The role of ${strings.role} in Switzerland is a regulated profession. Full-time hiring and public-sector tenders require Italian-diploma recognition from ${facts.recognitionAuthority}. The procedure derives from the EU-Switzerland Free Movement Agreement and typically takes ${minLead}–${maxLead} months from complete-file submission. [source: ${facts.recognitionAuthority}](${facts.recognitionAuthorityUrl}).`
            : `The role of ${strings.role} is not regulated in Switzerland: Italian diploma recognition is not mandatory for hiring. Nevertheless, many employers value an ${facts.recognitionAuthority} dossier as a quality signal for technical or public-sector positions. [source: ${facts.recognitionAuthority}](${facts.recognitionAuthorityUrl}).`,
          `Prepare: legalised original diploma (Apostille), official Italian/German/French translation, curriculum with exams and internship hours, good-standing certificate, Swiss-standard CV. File the recognition request before accepting an open-ended contract to avoid delays.`,
          facts.regulated
            ? `If the Italian curriculum is not fully equivalent to Swiss standards, the authority may require compensation measures: an accredited 3–12-month adaptation module or an aptitude test. Several Ticino employers offer bridge contracts during the procedure.`
            : `Optional recognition is especially useful to transition over time from private-sector to public-sector roles (cantonal tenders, municipalities) where it can become decisive.`,
        ],
      },
      {
        title: shell.sectionHeadings.ccl,
        paragraphs: [
          `The applicable collective agreement for ${strings.role} in Ticino is the **${facts.cclReference}**. It governs minimum salary, 13th-month pay, holidays, night/holiday surcharges, notice periods, sickness and injury indemnities. [source: SECO — General-scope CLAs](${facts.cclUrl}).`,
          `Cross-border G-permit workers are fully covered by the Swiss CLA: wages, holidays, 13th month, shift allowances. Swiss social insurance (AVS, AI, IPG, AD, LAINF, LPP) is withheld at source or paid by the employer, with aggregation under Regulation (EC) 883/2004 [source: INPS — Swiss pensions].`,
          `Watch for derogations by small employers or sectors without a CLA: in that case the individual contract applies within SECO customary wage levels to prevent wage dumping.`,
        ],
      },
      {
        title: shell.sectionHeadings.salary,
        paragraphs: [
          `The typical salary range for ${strings.role} in Ticino in 2026 is CHF ${fmtN(minSal)}–${fmtN(maxSal)} gross per year on 13 months, with an estimated median of CHF ${fmtN(facts.medianSalaryChf)} from the Frontaliere Ticino dataset (${facts.jobsCount} sampled openings). Variable compensation — night shifts, holidays, on-call, overtime — can add 5 to 20% to the total.`,
          `To estimate the personalised net (old/new cross-border, km from the border, marital status, dependants) use the Frontaliere Ticino salary calculator. The 2020 bilateral agreement distinguishes "new cross-borderers" (hired after 17/07/2023) — taxed at source at 80% in Switzerland plus Italian declaration — from "old cross-borderers" who keep the previous regime. [source: AFC — Withholding tax](https://www.estv.admin.ch/it/imposta-alla-fonte).`,
          `Inter-cantonal differences are minor on wages (national CLAs) but relevant on municipal tax: Lugano, Mendrisio, Bellinzona have different multipliers. The site calculator models this.`,
        ],
      },
      {
        title: shell.sectionHeadings.employers,
        paragraphs: [
          `The top Ticino employers for ${strings.role} include: ${facts.topEmployers.join(', ')}. Each publishes openings on their career portals and on Swiss aggregators (jobs.ch, jobup.ch, jobagent.ch).`,
          `Recent openings concentrate in ${facts.topCities.join(', ')} — areas with easy access from Chiasso-Brogeda, Stabio-Gaggiolo and Ponte Tresa border crossings. Factor the km distance from the border into your net-salary estimate: "new cross-borderers" above 20 km face a slightly different tax regime.`,
          `Frontaliere Ticino publishes weekly updated listings for this role — subscribe to job alerts to avoid missing tenders.`,
        ],
      },
      {
        title: shell.sectionHeadings.permits,
        paragraphs: [
          `G-permit (cross-border): Italian residence, weekly return, Swiss source tax + Italian declaration (new cross-borderers post-2023). Pros: keep Italian health insurance via LAMal opt-out, Italian SSN for family, lower relocation costs. Cons: smaller LPP balance, limited Swiss mortgage access, daily commute. [source: SEM — Work permits].`,
          `B-permit (resident): Swiss residence, Swiss tax resident, mandatory LAMal, full LPP (2nd pillar), access to Swiss mortgages. Pros: frequently higher net at equal gross thanks to taxation, career stability, full welfare access. Cons: Ticino rent costs, mandatory LAMal (CHF 400–600/month adult), distance from Italian network.`,
          `The choice depends on your life plan: below CHF 75,000 with family in Italy, G-permit almost always wins; above CHF 90,000 or with home-purchase plans, B-permit becomes more attractive.`,
        ],
      },
      {
        title: shell.sectionHeadings.application,
        paragraphs: [
          `A successful application for ${strings.role} in Ticino follows Swiss conventions: Italian-language CV in Swiss-standard format (photo, all diplomas, certified training hours, verifiable references), a targeted one-page cover letter, copies of language certificates.`,
          `Selection usually involves: phone screen (10–15 min), HR interview (45–60 min), technical interview with the hiring manager (60–90 min), a possible practical test (especially for hospital, construction, electro-technical roles). Candidate feedback is typically delivered within 10 business days.`,
          `Realistic timelines from CV submission to signed contract: 4–8 weeks. Launch recognition and permit requests in parallel to avoid blocking the start date.`,
        ],
      },
    ];
  }

  if (locale === 'de') {
    return [
      {
        title: shell.sectionHeadings.context,
        paragraphs: [
          `${strings.roleSummary} Das Tessin zeigt konstant hohe Nachfrage nach italienischen ${strings.role}, gestützt auf die gemeinsame Sprache und die geografische Nähe zu Lombardei und Piemont. Der öffentliche Datensatz von Frontaliere Ticino verzeichnet ${facts.jobsCount} kürzlich offene Stellen für diese Rolle.`,
          `Typischer Schweizer Kontext: unbefristete Verträge überwiegen, 1–3 Monate Probezeit (Art. 335b OR), mindestens 5 Wochen Ferien (6 ab 50), obligatorische Sozialversicherungen (AHV/IV/EO, UVG, BVG) mit geteilter Finanzierung.`,
          `Anforderungen: ${strings.requisiti}. Typische Aufgaben: ${strings.typicalTasks}`,
        ],
      },
      {
        title: shell.sectionHeadings.recognition,
        paragraphs: [
          facts.regulated
            ? `Der Beruf ${strings.role} ist in der Schweiz reglementiert. Für eine Vollanstellung oder den Zugang zu öffentlichen Ausschreibungen ist die Anerkennung des italienischen Diploms durch ${facts.recognitionAuthority} nötig. Das Verfahren stützt sich auf das Freizügigkeitsabkommen CH-EU und dauert typischerweise ${minLead}–${maxLead} Monate. [Quelle: ${facts.recognitionAuthority}](${facts.recognitionAuthorityUrl}).`
            : `Der Beruf ${strings.role} ist in der Schweiz nicht reglementiert: eine Anerkennung des italienischen Diploms ist für die Anstellung nicht obligatorisch. Viele Arbeitgeber schätzen ein ${facts.recognitionAuthority}-Dossier dennoch als Qualitätssignal. [Quelle: ${facts.recognitionAuthority}](${facts.recognitionAuthorityUrl}).`,
          `Vorzubereiten: legalisiertes Originaldiplom (Apostille), amtliche Übersetzung, Curriculum mit Prüfungs- und Praktikumsstunden, Leumundszeugnis, Swiss-Standard-Lebenslauf. Das Gesuch vor einem unbefristeten Vertrag einreichen, um Verzögerungen zu vermeiden.`,
          facts.regulated
            ? `Ist der italienische Weg nicht vollständig gleichwertig, kann die Behörde Ausgleichsmassnahmen verlangen: akkreditiertes Anpassungsmodul (3–12 Monate) oder Eignungsprüfung. Mehrere Tessiner Arbeitgeber bieten Brückenverträge während des Verfahrens.`
            : `Die freiwillige Anerkennung ist besonders nützlich für den späteren Wechsel von privat zu öffentlich (kantonale Wettbewerbe, Gemeinden), wo sie entscheidend werden kann.`,
        ],
      },
      {
        title: shell.sectionHeadings.ccl,
        paragraphs: [
          `Der einschlägige Gesamtarbeitsvertrag für ${strings.role} im Tessin ist der **${facts.cclReference}**. Er regelt Mindestlohn, 13. Monatslohn, Ferien, Nacht- und Feiertagszuschläge, Kündigungsfristen, Krankheits- und Unfallindemnitäten. [Quelle: SECO — Allgemeinverbindliche GAV](${facts.cclUrl}).`,
          `Grenzgänger mit G-Bewilligung sind voll unter dem Schweizer GAV: Löhne, Ferien, 13., Schichtzulagen. Sozialversicherungen (AHV, IV, EO, ALV, UVG, BVG) werden an der Quelle einbehalten, Zusammenrechnung nach Verordnung (EG) 883/2004 [Quelle: INPS].`,
          `Achtung auf Abweichungen für kleine Arbeitgeber oder nicht abgedeckte Branchen: dann gilt der individuelle Vertrag unter Beachtung der SECO-Vergleichslöhne zur Verhinderung von Lohndumping.`,
        ],
      },
      {
        title: shell.sectionHeadings.salary,
        paragraphs: [
          `Die typische Lohnspanne für ${strings.role} im Tessin 2026 liegt bei CHF ${fmtN(minSal)}–${fmtN(maxSal)} brutto pro Jahr auf 13 Monate, mit einem geschätzten Median von CHF ${fmtN(facts.medianSalaryChf)} aus dem Frontaliere-Ticino-Datensatz (${facts.jobsCount} Stichproben). Variable Bestandteile — Nacht, Feiertag, Pikett, Überstunden — können 5 bis 20 % ergänzen.`,
          `Für einen personalisierten Nettolohn (alter/neuer Grenzgänger, km-Abstand zur Grenze, Zivilstand, Kinder) den Lohnrechner von Frontaliere Ticino nutzen. Das bilaterale Abkommen 2020 trennt "neue Grenzgänger" (Anstellung nach 17.07.2023) — 80 % Quellensteuer in CH + italienische Deklaration — von "alten Grenzgängern" mit früherem Regime. [Quelle: EStV — Quellensteuer].`,
          `Kantonale Unterschiede sind beim Lohn minimal (nationale GAV), bei der Gemeindesteuer jedoch relevant: Lugano, Mendrisio, Bellinzona haben verschiedene Steuerfüsse.`,
        ],
      },
      {
        title: shell.sectionHeadings.employers,
        paragraphs: [
          `Wichtigste Tessiner Arbeitgeber für ${strings.role}: ${facts.topEmployers.join(', ')}. Jeder publiziert Stellen auf eigenen Karriereportalen und auf Schweizer Aggregatoren (jobs.ch, jobup.ch, jobagent.ch).`,
          `Jüngste Öffnungen konzentrieren sich auf ${facts.topCities.join(', ')} — Regionen mit gutem Zugang zu den Grenzübergängen Chiasso-Brogeda, Stabio-Gaggiolo und Ponte Tresa. Die km-Distanz zur Grenze bei der Nettolohn-Schätzung berücksichtigen.`,
          `Frontaliere Ticino veröffentlicht wöchentlich aktualisierte Ausschreibungen — Job-Alerts abonnieren, um keine Ausschreibung zu verpassen.`,
        ],
      },
      {
        title: shell.sectionHeadings.permits,
        paragraphs: [
          `G-Bewilligung (Grenzgänger): Wohnsitz in Italien, wöchentliche Heimkehr, Quellensteuer CH + Deklaration IT (neue Grenzgänger nach 2023). Vorteile: Beibehalt italienische Krankenkasse (LAMal-Optout), SSN für Familie, tiefere Umzugskosten. Nachteile: kleinere BVG-Reserve, beschränkter Zugang zu Schweizer Hypotheken. [Quelle: SEM — Arbeitsbewilligungen].`,
          `B-Bewilligung (Aufenthalt): Wohnsitz CH, steuerpflichtig in CH, LAMal-Pflicht, volle BVG (2. Säule), Zugang zu Hypotheken. Vorteile: häufig höherer Netto-Lohn, Karrierestabilität. Nachteile: Mieten, LAMal (CHF 400–600/Monat Erwachsener), Distanz zu Familie in Italien.`,
          `Die Wahl hängt vom Lebensprojekt ab: unter CHF 75'000 und Familie in Italien gewinnt fast immer die G-Bewilligung; über CHF 90'000 oder mit Hauskaufplänen ist die B-Bewilligung attraktiver.`,
        ],
      },
      {
        title: shell.sectionHeadings.application,
        paragraphs: [
          `Eine erfolgreiche Bewerbung für ${strings.role} im Tessin folgt Schweizer Konventionen: Lebenslauf auf Italienisch im Swiss-Standard-Format (Foto, alle Diplome, zertifizierte Ausbildungsstunden, prüfbare Referenzen), einseitiges Motivationsschreiben, Sprachzertifikate.`,
          `Auswahlprozess: Telefonscreening (10–15 Min.), HR-Gespräch (45–60 Min.), Fachgespräch mit verantwortlicher Person (60–90 Min.), allfällige praktische Prüfung. Rückmeldung typischerweise innerhalb von 10 Arbeitstagen.`,
          `Realistische Dauer von CV bis unterschriebenem Vertrag: 4–8 Wochen. Anerkennung und Bewilligung parallel beantragen, um das Startdatum nicht zu blockieren.`,
        ],
      },
    ];
  }

  // FR
  return [
    {
      title: shell.sectionHeadings.context,
      paragraphs: [
        `${strings.roleSummary} Le Tessin affiche une demande constante de ${strings.role} italiens, facilitée par la langue commune et la proximité géographique avec la Lombardie et le Piémont. Le jeu de données public de Frontaliere Ticino recense ${facts.jobsCount} postes récents pour ce rôle.`,
        `Contexte suisse typique : contrats à durée indéterminée majoritaires, périodes d'essai de 1 à 3 mois (art. 335b CO), 5 semaines de vacances minimum (6 après 50 ans dans de nombreuses CCT), assurances sociales obligatoires (AVS/AI/APG, LAA, LPP) à charge partagée.`,
        `Exigences : ${strings.requisiti}. Tâches typiques : ${strings.typicalTasks}`,
      ],
    },
    {
      title: shell.sectionHeadings.recognition,
      paragraphs: [
        facts.regulated
          ? `Le métier de ${strings.role} est réglementé en Suisse. Un engagement à temps plein ou l'accès aux concours publics exige la reconnaissance du diplôme italien par ${facts.recognitionAuthority}. La procédure découle de l'Accord sur la libre circulation CH-UE et dure typiquement ${minLead}–${maxLead} mois. [source : ${facts.recognitionAuthority}](${facts.recognitionAuthorityUrl}).`
          : `Le métier de ${strings.role} n'est pas réglementé en Suisse : la reconnaissance du diplôme italien n'est pas obligatoire pour l'embauche. De nombreux employeurs valorisent néanmoins un dossier ${facts.recognitionAuthority} comme signal qualité. [source : ${facts.recognitionAuthority}](${facts.recognitionAuthorityUrl}).`,
        `À préparer : diplôme original légalisé (Apostille), traduction officielle italien/allemand/français, curriculum avec heures de stage, certificat de bonne conduite, CV au format suisse. Déposer la demande avant un contrat à durée indéterminée pour éviter les retards.`,
        facts.regulated
          ? `Si le parcours italien n'est pas pleinement équivalent, l'autorité peut exiger des mesures de compensation : module d'adaptation accrédité (3–12 mois) ou examen d'aptitude. Plusieurs employeurs tessinois offrent des contrats-ponts pendant la procédure.`
          : `La reconnaissance facultative est particulièrement utile pour passer au fil du temps du privé au public (concours cantonaux, communes), où elle peut devenir déterminante.`,
      ],
    },
    {
      title: shell.sectionHeadings.ccl,
      paragraphs: [
        `La convention collective applicable pour ${strings.role} au Tessin est la **${facts.cclReference}**. Elle régit le salaire minimum, le 13e mois, les vacances, les suppléments nuit/fériés, les délais de congé, les indemnités maladie et accident. [source : SECO — CCT de portée générale](${facts.cclUrl}).`,
        `Les frontaliers avec permis G sont intégralement couverts par la CCT suisse : salaires, vacances, 13e, indemnités de rotation. Les assurances sociales (AVS, AI, APG, AC, LAA, LPP) sont prélevées à la source, avec totalisation selon le Règlement (CE) 883/2004 [source : INPS].`,
        `Attention aux dérogations pour les petits employeurs ou secteurs sans CCT : le contrat individuel s'applique dans le respect des salaires usuels SECO pour éviter le dumping salarial.`,
      ],
    },
    {
      title: shell.sectionHeadings.salary,
      paragraphs: [
        `La fourchette salariale typique pour ${strings.role} au Tessin en 2026 est CHF ${fmtN(minSal)}–${fmtN(maxSal)} brut par an sur 13 mois, avec une médiane estimée à CHF ${fmtN(facts.medianSalaryChf)} depuis le jeu de données Frontaliere Ticino (${facts.jobsCount} postes échantillonnés). Les éléments variables — nuit, fériés, astreinte, heures sup — peuvent ajouter 5 à 20 %.`,
        `Pour estimer le net personnalisé (ancien/nouveau frontalier, km du confin, état civil, enfants) utilisez le calculateur Frontaliere Ticino. L'accord bilatéral 2020 distingue les "nouveaux frontaliers" (embauchés après le 17/07/2023) — imposés à 80 % en CH + déclaration italienne — des "anciens frontaliers" conservant le régime précédent. [source : AFC — Impôt à la source].`,
        `Les différences inter-cantonales sont minimes sur les salaires (CCT nationales) mais notables sur l'impôt communal : Lugano, Mendrisio, Bellinzona ont des coefficients différents.`,
      ],
    },
    {
      title: shell.sectionHeadings.employers,
      paragraphs: [
        `Principaux employeurs tessinois pour ${strings.role} : ${facts.topEmployers.join(', ')}. Chacun publie ses offres sur ses portails carrière et sur les agrégateurs suisses (jobs.ch, jobup.ch, jobagent.ch).`,
        `Les offres récentes se concentrent à ${facts.topCities.join(', ')} — zones bien desservies depuis les passages Chiasso-Brogeda, Stabio-Gaggiolo et Ponte Tresa. Tenir compte de la distance km du confin dans l'estimation du net.`,
        `Frontaliere Ticino publie chaque semaine les offres actualisées pour ce rôle — s'abonner aux alertes pour ne rien manquer.`,
      ],
    },
    {
      title: shell.sectionHeadings.permits,
      paragraphs: [
        `Permis G (frontalier) : résidence en Italie, retour hebdomadaire, impôt à la source CH + déclaration IT (nouveaux frontaliers après 2023). Avantages : maintien de l'assurance santé italienne (option LAMal), SSN famille, coûts de déménagement réduits. Inconvénients : LPP plus faible, accès limité aux prêts suisses. [source : SEM].`,
        `Permis B (résident) : résidence CH, contribuable suisse, LAMal obligatoire, LPP complet (2e pilier), accès aux prêts hypothécaires. Avantages : net souvent supérieur à brut égal, stabilité professionnelle. Inconvénients : loyers, LAMal (CHF 400–600/mois adulte), éloignement du réseau italien.`,
        `Le choix dépend du projet : en dessous de CHF 75 000 avec famille en Italie, le permis G gagne presque toujours ; au-dessus de CHF 90 000 ou avec achat immobilier, le permis B devient plus intéressant.`,
      ],
    },
    {
      title: shell.sectionHeadings.application,
      paragraphs: [
        `Une candidature réussie pour ${strings.role} au Tessin suit les conventions suisses : CV en italien au format swiss-standard (photo, tous les diplômes, heures de formation certifiées, références vérifiables), lettre de motivation ciblée d'une page, copies des certificats de langue.`,
        `Processus de sélection habituel : entretien téléphonique (10–15 min), entretien RH (45–60 min), entretien technique avec le responsable (60–90 min), test pratique éventuel (hôpital, chantier, électrotechnique). Retour au candidat dans les 10 jours ouvrés.`,
        `Délais réalistes du CV au contrat : 4–8 semaines. Lancer la reconnaissance et la demande de permis en parallèle pour ne pas bloquer la date de début.`,
      ],
    },
  ];
}

// ─────────────────────────────────────────────────────────────────
// Build FAQ — 5 per locale, profession-keyed for uniqueness.
// ─────────────────────────────────────────────────────────────────

function buildFaqs(locale: ProfessionLocale, id: ProfessionId): ProfessionLandingFaq[] {
  const facts = PROFESSION_FACTS[id];
  const strings = PROFESSION_STRINGS_BY_LOCALE[locale][id];
  const [minLead, maxLead] = facts.recognitionLeadTimeMonths;
  const numberFmt = { it: 'it-CH', en: 'en-CH', de: 'de-CH', fr: 'fr-CH' }[locale];
  const medianStr = facts.medianSalaryChf.toLocaleString(numberFmt);
  const minStr = facts.typicalSalaryRange[0].toLocaleString(numberFmt);
  const maxStr = facts.typicalSalaryRange[1].toLocaleString(numberFmt);

  if (locale === 'it') {
    return [
      {
        question: `Serve il riconoscimento del titolo italiano per lavorare come ${strings.role} in Ticino?`,
        answer: facts.regulated
          ? `Sì — ${strings.role} è una professione regolamentata. Il riconoscimento è obbligatorio per l'assunzione a tempo pieno o per accedere ai concorsi pubblici. L'autorità competente è ${facts.recognitionAuthority} e la procedura dura ${minLead}–${maxLead} mesi. Fonte: ${facts.recognitionAuthorityUrl}.`
          : `No — ${strings.role} non è una professione regolamentata. Puoi essere assunto direttamente con il diploma italiano. La pratica ${facts.recognitionAuthority} resta facoltativa ma utile per concorsi pubblici. Fonte: ${facts.recognitionAuthorityUrl}.`,
      },
      {
        question: `Quanto guadagna un/una ${strings.role} in Ticino nel 2026?`,
        answer: `La forchetta tipica è CHF ${minStr}–${maxStr} lordi annui su 13 mensilità, con un valore mediano stimato di CHF ${medianStr} dal dataset interno di Frontaliere Ticino. Il netto dipende dal tipo di permesso (G vs B), dalla chilometraggio dal confine e dallo stato civile: usa il calcolatore del sito per una stima personalizzata.`,
      },
      {
        question: `Quale CCL si applica a ${strings.role} in Ticino?`,
        answer: `Il contratto di riferimento è **${facts.cclReference}**, pubblicato e consultabile sul sito SECO. Regola salario minimo, 13a mensilità, vacanze, indennità turni, preavvisi e indennità malattia. Fonte: ${facts.cclUrl}.`,
      },
      {
        question: `Conviene il permesso G o il permesso B per un/una ${strings.role}?`,
        answer: `Dipende dal lordo e dal progetto di vita. Sotto CHF 75'000 lordi e con famiglia in Italia il permesso G resta più vantaggioso; sopra CHF 90'000 o con piani di acquisto casa in Ticino il permesso B è di solito più conveniente sul netto. Il calcolatore del sito simula entrambi.`,
      },
      {
        question: `Quali sono i principali datori di lavoro in Ticino per ${strings.role}?`,
        answer: `Tra i principali: ${facts.topEmployers.slice(0, 3).join(', ')}. Le sedi più attive sono ${facts.topCities.join(', ')}. Offerte aggiornate settimanalmente su Frontaliere Ticino — iscriviti ai job alert per ricevere i nuovi bandi.`,
      },
    ];
  }

  if (locale === 'en') {
    return [
      {
        question: `Do I need Italian diploma recognition to work as a ${strings.role} in Ticino?`,
        answer: facts.regulated
          ? `Yes — ${strings.role} is a regulated profession. Recognition is mandatory for full-time employment or public-sector competitions. The competent authority is ${facts.recognitionAuthority} and the procedure takes ${minLead}–${maxLead} months. Source: ${facts.recognitionAuthorityUrl}.`
          : `No — ${strings.role} is not a regulated profession. You can be hired directly with your Italian diploma. The ${facts.recognitionAuthority} dossier remains optional but useful for public-sector tenders. Source: ${facts.recognitionAuthorityUrl}.`,
      },
      {
        question: `How much does a ${strings.role} earn in Ticino in 2026?`,
        answer: `The typical range is CHF ${minStr}–${maxStr} gross per year over 13 months, with an estimated median of CHF ${medianStr} from the Frontaliere Ticino dataset. Net pay depends on permit type (G vs B), distance from the border and marital status — use the site calculator for a personalised estimate.`,
      },
      {
        question: `Which collective agreement applies to ${strings.role} in Ticino?`,
        answer: `The reference contract is **${facts.cclReference}**, published on the SECO website. It sets minimum wage, 13th month, holidays, shift premiums, notice periods and sickness indemnities. Source: ${facts.cclUrl}.`,
      },
      {
        question: `Is G-permit or B-permit better for a ${strings.role}?`,
        answer: `It depends on gross pay and life plans. Below CHF 75,000 with family in Italy, G-permit typically wins; above CHF 90,000 or with home-purchase plans in Ticino, B-permit is usually better. The site calculator simulates both scenarios.`,
      },
      {
        question: `Who are the main Ticino employers for ${strings.role}s?`,
        answer: `Main employers include: ${facts.topEmployers.slice(0, 3).join(', ')}. Most openings concentrate in ${facts.topCities.join(', ')}. Offers refreshed weekly on Frontaliere Ticino — subscribe to job alerts to get new tenders in your inbox.`,
      },
    ];
  }

  if (locale === 'de') {
    return [
      {
        question: `Brauche ich die italienische Diplom-Anerkennung, um als ${strings.role} im Tessin zu arbeiten?`,
        answer: facts.regulated
          ? `Ja — ${strings.role} ist ein reglementierter Beruf. Die Anerkennung ist für eine Vollanstellung oder öffentliche Ausschreibungen obligatorisch. Zuständige Behörde: ${facts.recognitionAuthority}, Dauer ${minLead}–${maxLead} Monate. Quelle: ${facts.recognitionAuthorityUrl}.`
          : `Nein — ${strings.role} ist kein reglementierter Beruf. Sie können direkt mit dem italienischen Diplom angestellt werden. Das ${facts.recognitionAuthority}-Dossier bleibt optional, aber für öffentliche Ausschreibungen nützlich. Quelle: ${facts.recognitionAuthorityUrl}.`,
      },
      {
        question: `Wie viel verdient ein/e ${strings.role} im Tessin 2026?`,
        answer: `Typische Bandbreite: CHF ${minStr}–${maxStr} brutto pro Jahr auf 13 Monate, mit geschätztem Median von CHF ${medianStr} aus dem Frontaliere-Ticino-Datensatz. Der Netto-Lohn hängt von Bewilligungsart (G/B), Grenzdistanz und Zivilstand ab — den Lohnrechner für eine personalisierte Schätzung nutzen.`,
      },
      {
        question: `Welcher GAV gilt für ${strings.role} im Tessin?`,
        answer: `Der massgebende Vertrag ist **${facts.cclReference}**, auf der SECO-Website veröffentlicht. Er regelt Mindestlohn, 13., Ferien, Schichtzulagen, Kündigungsfristen und Krankheitsindemnitäten. Quelle: ${facts.cclUrl}.`,
      },
      {
        question: `Ist G- oder B-Bewilligung besser für eine/n ${strings.role}?`,
        answer: `Hängt vom Bruttolohn und Lebensprojekt ab. Unter CHF 75'000 mit Familie in Italien gewinnt meist die G-Bewilligung; über CHF 90'000 oder mit Hauskauf-Plänen ist die B-Bewilligung meist netto besser. Der Rechner der Website simuliert beides.`,
      },
      {
        question: `Wer sind die wichtigsten Tessiner Arbeitgeber für ${strings.role}?`,
        answer: `Hauptarbeitgeber: ${facts.topEmployers.slice(0, 3).join(', ')}. Häufigste Standorte: ${facts.topCities.join(', ')}. Wöchentlich aktualisierte Angebote auf Frontaliere Ticino — Job-Alerts abonnieren, um neue Ausschreibungen zu erhalten.`,
      },
    ];
  }

  // FR
  return [
    {
      question: `La reconnaissance du diplôme italien est-elle nécessaire pour travailler comme ${strings.role} au Tessin ?`,
      answer: facts.regulated
        ? `Oui — ${strings.role} est une profession réglementée. La reconnaissance est obligatoire pour un engagement à temps plein ou l'accès aux concours publics. Autorité compétente : ${facts.recognitionAuthority}, durée ${minLead}–${maxLead} mois. Source : ${facts.recognitionAuthorityUrl}.`
        : `Non — ${strings.role} n'est pas une profession réglementée. Vous pouvez être engagé directement avec votre diplôme italien. Le dossier ${facts.recognitionAuthority} reste facultatif mais utile pour les concours publics. Source : ${facts.recognitionAuthorityUrl}.`,
    },
    {
      question: `Combien gagne un/une ${strings.role} au Tessin en 2026 ?`,
      answer: `La fourchette typique est CHF ${minStr}–${maxStr} brut par an sur 13 mois, avec une médiane estimée à CHF ${medianStr} depuis le jeu de données Frontaliere Ticino. Le net dépend du type de permis (G vs B), de la distance au confin et de l'état civil — utilisez le calculateur du site pour une estimation personnalisée.`,
    },
    {
      question: `Quelle CCT s'applique aux ${strings.role} au Tessin ?`,
      answer: `Le contrat de référence est **${facts.cclReference}**, publié sur le site SECO. Il fixe le salaire minimum, le 13e, les vacances, les suppléments de rotation, les délais de congé et les indemnités maladie. Source : ${facts.cclUrl}.`,
    },
    {
      question: `Le permis G ou B est-il préférable pour un/une ${strings.role} ?`,
      answer: `Cela dépend du brut et du projet de vie. Sous CHF 75 000 avec famille en Italie, le permis G reste habituellement plus avantageux ; au-dessus de CHF 90 000 ou avec achat immobilier, le permis B est souvent préférable sur le net. Le calculateur du site simule les deux scénarios.`,
    },
    {
      question: `Quels sont les principaux employeurs tessinois pour les ${strings.role} ?`,
      answer: `Principaux employeurs : ${facts.topEmployers.slice(0, 3).join(', ')}. Offres les plus fréquentes à ${facts.topCities.join(', ')}. Offres rafraîchies chaque semaine sur Frontaliere Ticino — abonnez-vous aux alertes pour recevoir les nouveaux postes.`,
    },
  ];
}

// ─────────────────────────────────────────────────────────────────
// Public API — assemble copy for (locale, id).
// ─────────────────────────────────────────────────────────────────

export interface ProfessionLandingCopySnapshot {
  /** Live aggregate count from professionJobsAggregate (NOT the frozen jobsCount). */
  readonly liveCount: number;
  /** New jobs in the last 30 days, from aggregate. */
  readonly fresh30Count: number;
}

export function buildProfessionLandingCopy(
  locale: ProfessionLocale,
  id: ProfessionId,
  snapshot: ProfessionLandingCopySnapshot = { liveCount: 0, fresh30Count: 0 },
): ProfessionLandingCopy {
  const shell = LOCALE_SHELLS[locale];
  const strings = PROFESSION_STRINGS_BY_LOCALE[locale][id];
  const facts = PROFESSION_FACTS[id];

  // Pick the most informative count: prefer the live aggregate when it has
  // signal, otherwise fall back to the frozen editorial snapshot.
  const displayCount = snapshot.liveCount > 0 ? snapshot.liveCount : facts.jobsCount;

  return {
    title: shell.titleTemplate(strings.role),
    description: shell.descriptionTemplate(strings.role, facts.medianSalaryChf),
    h1: shell.h1Template(strings.role),
    lede: shell.ledeTemplate(strings, facts.medianSalaryChf, displayCount),
    denseLede: shell.denseLedeTemplate({
      role: strings.role,
      live: displayCount,
      fresh30: snapshot.fresh30Count,
      median: facts.medianSalaryChf,
    }),
    updatedLabel: shell.updatedLabel,
    breadcrumbHome: shell.breadcrumbHome,
    breadcrumbJobs: shell.breadcrumbJobs,
    ctaJobs: shell.ctaJobs,
    ctaSimulator: shell.ctaSimulator,
    relatedLabel: shell.relatedLabel,
    faqTitle: shell.faqTitle,
    sectionHeadings: shell.sectionHeadings,
    tableHeadings: shell.tableHeadings,
    employersTableTitle: shell.employersTableTitle,
    employersTableNote: shell.employersTableNote,
    sourcesLabel: shell.sourcesLabel,
    eyebrow: shell.eyebrow,
    statTileLiveLabel: shell.statTileLiveLabel,
    statTileSalaryLabel: shell.statTileSalaryLabel,
    statTileFreshLabel: shell.statTileFreshLabel,
    statLiveValue: displayCount.toLocaleString(
      ({ it: 'it-CH', en: 'en-CH', de: 'de-CH', fr: 'fr-CH' } as const)[locale],
    ),
    statSalaryValue: shell.statSalaryValueFmt(facts.medianSalaryChf),
    statFreshValue: shell.statFreshValueFmt(snapshot.fresh30Count),
    primaryCtaLabel: shell.primaryCtaLabel,
    featuredJobsTitle: shell.featuredJobsTitle,
    featuredJobsCtaAllLabel: shell.featuredJobsCtaAll(displayCount),
    featuredJobsEmpty: shell.featuredJobsEmpty,
    employerGridTitle: shell.employerGridTitle,
    approfondisciHeading: shell.approfondisciHeading,
    formatJobPosted: shell.jobPostedLabel,
    formatJobSalary: shell.jobSalaryFmt,
  };
}

export function buildProfessionLandingSections(
  locale: ProfessionLocale,
  id: ProfessionId,
): ProfessionLandingSection[] {
  return buildSections(locale, id);
}

export function buildProfessionLandingFaqs(
  locale: ProfessionLocale,
  id: ProfessionId,
): ProfessionLandingFaq[] {
  return buildFaqs(locale, id);
}
