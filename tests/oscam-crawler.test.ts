import { describe, it, expect, vi } from 'vitest';
import { normalizePdfJobText, buildPdfBackedDescription } from '../scripts/lib/pdf-job-content.mjs';

// ──────────────────────────────────────────────────────────────
// Real PDF text fixture: Vice-responsabile finanze
// ──────────────────────────────────────────────────────────────

const FIXTURE_VICE_PDF = `Concorso assunzione   vice - responsabile finanze a tempo pieno  La Fondazione Giuseppe Rossi gestisce un Ospedale di 56 posti letti a Castelrotto. Di questi,  26 accolgono pazienti sofferenti di patologie psichiatriche e 30 sono destinati ad un reparto  di medicina (RAMI   –   reparto acuto di minore intensità).  L'Ospedale conta inoltre un centro di primo soccorso e diversi ambulatori (cardiologia,  agopuntura, epatologia, radiologia, ergoterapia, fisioterapia, laboratorio, servizio dietetico).  In rete con l'Ospedale, gestiamo   una Casa per Anziani di 105 posti letto   a Castelrotto   e un a  seconda Casa anziani a Caslano   di 70 posti letto , unitamente ad un Centro diurno/notturno  terapeutico, che può accogliere un massimo di 20 pazienti al giorno.  L'Ospedale Malcantonese , per completare il proprio organico, è alla ricerca della posizione  di   vice - responsabile delle finanze   a tempo pieno ,   con esperienza e   con   la prospettiva   di una  promozione .  Compiti  La persona che cerchiamo si occuperà, sotto la supervisione del responsabile finanze e in  collaborazione con i responsabili di area   dei vari servizi , dei seguenti compiti:  •   gestione della contabilità generale/analitica degli istituti ;  •   gestione/ supervisione   delle diverse tipologie di fatturazione delle prestazioni ;  •   gestione /supervisione   delle contabilità creditori/ debitori e contenzioso ;  •   supervisione   della contabilità stipendi;  •   gestione /supervisione   delle statistiche sul personale,  residenti e pazienti e   quelle richieste  dalle autorità competenti ;  •   preparazione dei rendiconti periodici ,   dei bilanci , dei preventivi  e delle chiusure contabili ;  •   gestione delle relazioni con i servizi dell'Amministrazione cantonale, i partner istituzionali e  operativi.  Requisiti richiesti  -   Cittadinanza svizzera o stranieri in possesso di un permesso di lavoro  -   Attestato federale di specialista in finanza e contabilità, Bachelor, Master o licenza in  economia aziendale o titolo equipollente.  -   Buone conoscenze dei principali applicativi informatici di MS Office e contabili (se possibile  ISAWin).  -   Comprovata esperienz e lavorativa , preferibilmente nel settore sociosanitario ticinese.  -   Disponibilità a seguire corsi di aggiornamento professionale.  -   Padronanza della lingua italiana, parlata e scritta;   la conoscenza di una seconda lingua  nazionale costituisce titolo preferenziale .  -   Attitudine al lavoro indipendente e di gruppo , con forte orientamento alla collaborazione  interdisciplinare.  -   Rapidità  operativa e di apprendimento , precisione e  discrezione .  -   Capacità di  assumere responsabilità   e di risoluzione di problemi.  Data d' entrata in funzione: 1° ottobre 2026   o data da convenire  Offriamo:  -   una   struttura orientata alla progettualità e all'innovazione, con particolare attenzione alla  formazione continua.  -   uno stipendio adeguato alle attitudini (min.   78'547.00   –   max.   99'116.00 ).  Le candidature dovranno essere corredate da lettera di presentazione e motivazione, curriculum  vitae, fotocopie dei certificati di studio e di lavoro, una fotografia,   autocertificazione del  casellario giudiziale  e  autocertificazione sullo stato di salute , entrambi redatti su modulo  ufficiale reperibile sul sito   www.oscam.ch /lavoraconnoi/ .
Se si riconosce nel profilo ricercato, invii la sua candidatura presso l'Ospedale Malcantonese,  con l'indicazione "Concorso   vice - responsabile finanze " riportata sulla busta,   entro   gioved ì   2  aprile   202 6 . Le candidature che giungeranno oltre questa data non potranno essere tenute  in considerazione. Ulteriori informazioni possono essere richieste al signor Gian Paolo  Caligari, Responsabile finanze   (tel: 091 611 37 00).`;

// ──────────────────────────────────────────────────────────────
// Real PDF text fixture: Concorso generale 2026 (multi-position)
// ──────────────────────────────────────────────────────────────

const FIXTURE_GENERALE_PDF = `Concorso generale 2026
L'Ospedale e Casa Anziani Malcantonese (OSCAM), gestito dalla Fondazione Giuseppe Rossi, è un importante punto di riferimento sanitario nel Malcantone, Ticino.

Struttura:
- Ospedale con 56 posti letto a Castelrotto (26 psichiatria, 30 medicina RAMI)
- Casa Anziani di 105 posti letto a Castelrotto
- Casa Anziani di 70 posti letto a Caslano
- Centro diurno/notturno terapeutico (max 20 pazienti/giorno)
- Centro di primo soccorso e ambulatori specialistici

Posizioni aperte:
Per completare il nostro organico, cerchiamo personale qualificato nelle seguenti aree:
- Personale infermieristico (diverse specializzazioni)
- Assistenti di cura
- Operatori socio-sanitari
- Personale di cucina e ristorazione
- Personale tecnico e di manutenzione
- Personale amministrativo

Requisiti generali:
- Formazione professionale riconosciuta nel settore sanitario o sociosanitario
- Esperienza lavorativa nel settore è un vantaggio
- Buona conoscenza della lingua italiana
- Disponibilità al lavoro a turni (per il personale sanitario)
- Attitudine al lavoro di gruppo e collaborazione interdisciplinare

Offriamo:
- Ambiente lavorativo stimolante e orientato all'innovazione
- Formazione continua e sviluppo professionale
- Condizioni contrattuali secondo CCL del settore sociosanitario ticinese
- Struttura immersa nella natura del Malcantone

Candidatura:
Inviare documentazione completa a: info@oscam.ch
Ospedale Malcantonese, Via Cantonale 4, 6980 Castelrotto
Tel: 091 611 37 00`;

// ──────────────────────────────────────────────────────────────
// normalizePdfJobText tests
// ──────────────────────────────────────────────────────────────

describe('normalizePdfJobText — OSCAM PDFs', () => {
  it('normalizes vice-responsabile PDF text to ≥ 500 chars', () => {
    const result = normalizePdfJobText(FIXTURE_VICE_PDF);
    expect(result.length).toBeGreaterThanOrEqual(500);
  });

  it('preserves key sections from vice-responsabile PDF', () => {
    const result = normalizePdfJobText(FIXTURE_VICE_PDF);
    expect(result).toContain('Compiti');
    expect(result).toContain('Requisiti');
    expect(result).toContain('contabilità');
    expect(result).toContain('Offriamo');
  });

  it('normalizes generale PDF text with list items', () => {
    const result = normalizePdfJobText(FIXTURE_GENERALE_PDF);
    expect(result.length).toBeGreaterThanOrEqual(400);
    expect(result).toContain('Posizioni aperte');
    expect(result).toContain('infermieristico');
  });
});

// ──────────────────────────────────────────────────────────────
// buildPdfBackedDescription tests (OSCAM-style)
// ──────────────────────────────────────────────────────────────

describe('buildPdfBackedDescription — OSCAM format', () => {
  it('builds full description from vice-responsabile PDF', () => {
    const normalizedPdf = normalizePdfJobText(FIXTURE_VICE_PDF);
    const desc = buildPdfBackedDescription({
      introLines: [
        '## Concorso',
        'OSCAM – Ospedale e Casa Anziani Malcantonese pubblica il seguente concorso: Concorso vice-responsabile finanze al 100 %.',
      ],
      pdfText: normalizedPdf,
      footerLines: [
        '---',
        '**Settore:** Sanità pubblica / Assistenza anziani',
        '**Sede Ospedale:** Via Cantonale 4, 6980 Castelrotto (TI), Svizzera',
      ],
    });

    expect(desc.length).toBeGreaterThanOrEqual(500);
    expect(desc).toContain('## Concorso');
    expect(desc).toContain('OSCAM');
    expect(desc).toContain('contabilità');
    expect(desc).toContain('Requisiti');
    expect(desc).toContain('**Settore:**');
  });

  it('builds description with generale PDF', () => {
    const normalizedPdf = normalizePdfJobText(FIXTURE_GENERALE_PDF);
    const desc = buildPdfBackedDescription({
      introLines: [
        '## Concorso',
        'OSCAM – Ospedale e Casa Anziani Malcantonese pubblica il seguente concorso: Concorso generale 2026.',
      ],
      pdfText: normalizedPdf,
      footerLines: [
        '**Contatto:** info@oscam.ch',
      ],
    });

    expect(desc.length).toBeGreaterThanOrEqual(400);
    expect(desc).toContain('infermieristico');
    expect(desc).toContain('Candidatura');
  });

  it('uses fallback when no PDF text available', () => {
    const desc = buildPdfBackedDescription({
      introLines: ['OSCAM pubblica: Test.'],
      pdfText: '',
      fallbackText: 'Per i dettagli consultare il bando PDF.',
      footerLines: ['Contatto: info@oscam.ch'],
    });

    expect(desc).toContain('Per i dettagli consultare il bando PDF');
    expect(desc).toContain('Contatto');
  });
});

// ──────────────────────────────────────────────────────────────
// validateOscamDescription tests (inline)
// ──────────────────────────────────────────────────────────────

// Inline the validation logic for testing (mirrors the crawler's function)
function validateOscamDescription(description, pdfText = '') {
  const warnings = [];
  const descLen = (description || '').length;
  const pdfLen = (pdfText || '').length;

  if (descLen < 500 && pdfLen > 200) {
    warnings.push(`Description too short: ${descLen} chars (min 500 when PDF has ${pdfLen} chars)`);
  }

  // Count meaningful text blocks: paragraphs separated by double newlines OR sentences > 40 chars
  const blocks = (description || '').split(/\n{2,}/).filter((p) => p.trim().length > 20);
  // For OSCAM PDFs, text may come as one long paragraph with bullet points — count sentences too
  const sentences = (description || '').split(/[.!?]\s+/).filter((s) => s.trim().length > 20);
  const contentBlocks = Math.max(blocks.length, Math.floor(sentences.length / 3));
  if (contentBlocks < 3 && pdfLen > 300) {
    warnings.push(`Too few content blocks: ${contentBlocks} (need at least 3)`);
  }

  if (pdfLen > 200 && descLen / pdfLen < 0.2) {
    warnings.push(`Low PDF coverage: ${descLen}/${pdfLen} = ${(descLen / pdfLen).toFixed(2)}`);
  }

  return { ok: warnings.length === 0, warnings };
}

describe('validateOscamDescription', () => {
  it('passes for full vice-responsabile description', () => {
    const pdfText = normalizePdfJobText(FIXTURE_VICE_PDF);
    const desc = buildPdfBackedDescription({
      introLines: ['## Concorso', 'OSCAM pubblica: Vice-responsabile finanze.'],
      pdfText,
      footerLines: ['**Settore:** Sanità'],
    });
    const { ok, warnings } = validateOscamDescription(desc, pdfText);
    expect(ok).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('passes for full generale description', () => {
    const pdfText = normalizePdfJobText(FIXTURE_GENERALE_PDF);
    const desc = buildPdfBackedDescription({
      introLines: ['## Concorso', 'OSCAM pubblica: Concorso generale 2026.'],
      pdfText,
      footerLines: ['**Contatto:** info@oscam.ch'],
    });
    const { ok, warnings } = validateOscamDescription(desc, pdfText);
    expect(ok).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('fails for short description when PDF is available', () => {
    const { ok, warnings } = validateOscamDescription('Short desc.', 'A'.repeat(500));
    expect(ok).toBe(false);
    expect(warnings.some((w) => w.includes('too short'))).toBe(true);
  });

  it('fails for too few content blocks', () => {
    const { ok, warnings } = validateOscamDescription('A'.repeat(600), 'B'.repeat(500));
    expect(ok).toBe(false);
    expect(warnings.some((w) => w.includes('Too few content blocks'))).toBe(true);
  });

  it('fails for low PDF coverage ratio', () => {
    const { ok, warnings } = validateOscamDescription('Short.\n\nB.\n\nC.\n\nD.', 'X'.repeat(1000));
    expect(ok).toBe(false);
    expect(warnings.some((w) => w.includes('Low PDF coverage'))).toBe(true);
  });

  it('passes without PDF text (no guards triggered)', () => {
    const { ok } = validateOscamDescription('Any description is fine.', '');
    expect(ok).toBe(true);
  });
});
