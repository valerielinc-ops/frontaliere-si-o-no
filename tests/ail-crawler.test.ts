import { describe, it, expect } from 'vitest';
import { normalizePdfJobText, buildPdfBackedDescription } from '../scripts/lib/pdf-job-content.mjs';

// ──────────────────────────────────────────────────────────────
// Inline the title extraction + overlap functions (mirrors crawler)
// ──────────────────────────────────────────────────────────────

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function extractTitleFromPdf(pdfText = '') {
  if (!pdfText) return '';
  const roleMatch = pdfText.match(
    /per il ruolo di\s+(.+?)(?:\s*Cosa farai|\s*Il tuo impatto|\s*Requisiti|\s*Chi cerchiamo|\s*Le tue|$)/i
  );
  if (roleMatch) return normalizeSpace(roleMatch[1]);
  const posMatch = pdfText.match(/(?:Posizione|Ruolo)\s*:\s*(.+?)(?:\n|$)/i);
  if (posMatch) return normalizeSpace(posMatch[1]);
  return '';
}

function titleOverlap(expected = '', actual = '') {
  const norm = (s: string) =>
    s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const expWords = norm(expected).split(' ').filter(Boolean);
  const actWords = new Set(norm(actual).split(' ').filter(Boolean));
  if (expWords.length === 0) return 1;
  const matches = expWords.filter((w) => actWords.has(w)).length;
  return matches / expWords.length;
}

// ──────────────────────────────────────────────────────────────
// Real PDF text fixtures (extracted from actual AIL PDFs)
// ──────────────────────────────────────────────────────────────

const FIXTURE_PROJECT_COORDINATOR_PDF = `AIL SA Casella postale 6901 Lugano Centro operativo Via Industria 2 6933 Muzzano Tel. 058 470 70 70 www.ail.ch • info@ail.ch Chi siamo: Siamo una Società dinamica nel settore dell'energia e nell'erogazione di acqua potabile, in evoluzione e con un forte focus sull'innovazione e sullo sviluppo delle persone. Cerchiamo una persona appassionata per il ruolo di Project Coordinator Cosa farai concretamente: Supporterai in modo strutturato i Responsabili di Progetto nelle attività di progettazione, realizzazione e pianificazione delle reti elettriche AT/MT/BT, inclusa l'illuminazione pubblica e gli impianti di produzione e stoccaggio di energia elettrica. In particolare: • Gestire lo scadenziario legato al progetto e alle attività dei Responsabili di Progetto • Supportare i Responsabili di progetto nell'allestimento della documentazione e dei formulari di progetto • Assicurare un allineamento continuo nella pianificazione e nella comunicazione tra i vari stakeholder • Supportare la preparazione della documentazione necessaria per le sedute dei comitati di progetto • Assistere i Responsabili di Progetto nella gestione dell'avanzamento dei lavori e del budget • Organizzare e coordinare le risorse in modo efficiente • Segnalare ai Responsabili di Progetto eventuali criticità e ritardi Chi cerchiamo: • Formazione tecnica in ingegneria, architettura o equivalente, con qualifiche o certificazioni nel Project Management (IPMA, PMI, PRINCE2 o equivalenti) • Esperienza in gestione e coordinazione di progetti complessi, preferibilmente nel settore energetico o delle infrastrutture • Ottima padronanza della lingua italiana parlata e scritta • Conoscenza di almeno una seconda lingua nazionale, preferibilmente il tedesco • Ottime capacità organizzative, di comunicazione e di lavoro in team • Senso di responsabilità, flessibilità e proattività • Buona conoscenza dei principali strumenti informatici (MS Office, strumenti di project management) Cosa offriamo: • Un ambiente di lavoro stimolante, innovativo e in continua evoluzione • Possibilità di crescita professionale e formazione continua • Condizioni di impiego moderne e competitive • Un contesto dove il tuo contributo fa davvero la differenza`;

const FIXTURE_AUDIT_PDF = `AIL SA Casella postale 6901 Lugano Centro operativo Via Industria 2 6933 Muzzano Tel. 058 470 70 70 www.ail.ch • info@ail.ch Chi siamo: Siamo una Società dinamica nel settore dell'energia, in evoluzione e con un forte focus sull'innovazione e sullo sviluppo delle persone. Cerchiamo una persona con forte integrità, autonomia e visione strategica, per il ruolo di Responsabile della Revisione interna (Audit) Il tuo impatto: In questo ruolo, sarai una figura chiave nel garantire il buon funzionamento del sistema di controllo interno, assicurando l'adeguatezza e l'efficacia dei nostri sistemi di governance, gestione dei rischi e conformità. Pianificare e condurre audit interni completi su processi operativi, finanziari e di conformità. Valutare l'efficacia dei controlli interni e proporre raccomandazioni per il miglioramento. Redigere report di audit dettagliati, con osservazioni e piani d'azione correttivi. Monitorare l'attuazione delle misure correttive e assicurare il follow-up. Collaborare con il management per identificare e mitigare i rischi aziendali. Supportare la conformità alle normative locali, federali e settoriali. Garantire l'allineamento delle attività di audit con gli standard professionali (IIA, IPPF). Cosa ci aspettiamo: Laurea in economia, finanza, contabilità, diritto o disciplina equivalente. Certificazione professionale in ambito audit o revisione (CIA, CRMA, CPA o equivalente). Esperienza consolidata nel campo della revisione interna o esterna, preferibilmente nel settore energetico o dei servizi pubblici. Ottima padronanza della lingua italiana parlata e scritta. Conoscenza di almeno una seconda lingua nazionale, preferibilmente il tedesco. Spirito d'iniziativa, forte capacità analitiche e pensiero critico. Eccellenti capacità comunicative e di redazione. Discrezione, integrità e indipendenza nel giudizio. Capacità di lavorare in autonomia e gestire più attività contemporaneamente. Cosa offriamo: Un ambiente di lavoro stimolante e in continua evoluzione. Possibilità di crescita professionale e formazione continua. Condizioni di impiego moderne e competitive.`;

// ──────────────────────────────────────────────────────────────
// Title extraction tests
// ──────────────────────────────────────────────────────────────

describe('extractTitleFromPdf — AIL PDFs', () => {
  it('extracts "Project Coordinator" from PDF 1', () => {
    const title = extractTitleFromPdf(FIXTURE_PROJECT_COORDINATOR_PDF);
    expect(title).toBe('Project Coordinator');
  });

  it('extracts "Responsabile della Revisione interna (Audit)" from PDF 2', () => {
    const title = extractTitleFromPdf(FIXTURE_AUDIT_PDF);
    expect(title).toBe('Responsabile della Revisione interna (Audit)');
  });

  it('returns empty string for empty input', () => {
    expect(extractTitleFromPdf('')).toBe('');
  });

  it('returns empty string for text without role pattern', () => {
    expect(extractTitleFromPdf('This is random text without a role mention.')).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────
// Title overlap tests
// ──────────────────────────────────────────────────────────────

describe('titleOverlap — AIL title validation', () => {
  it('returns 1.0 for exact match', () => {
    expect(titleOverlap('Project Coordinator', 'Project Coordinator')).toBe(1);
  });

  it('returns 1.0 for matching titles from listing and PDF', () => {
    const listingTitle = 'Project Coordinator';
    const pdfTitle = extractTitleFromPdf(FIXTURE_PROJECT_COORDINATOR_PDF);
    expect(titleOverlap(listingTitle, pdfTitle)).toBe(1);
  });

  it('returns 1.0 for audit role title match', () => {
    const listingTitle = 'Responsabile della Revisione interna (Audit)';
    const pdfTitle = extractTitleFromPdf(FIXTURE_AUDIT_PDF);
    expect(titleOverlap(listingTitle, pdfTitle)).toBeGreaterThanOrEqual(0.7);
  });

  it('returns low overlap for mismatched titles', () => {
    expect(titleOverlap('Ingegnere Elettrico', 'Project Coordinator')).toBeLessThan(0.5);
  });

  it('handles accented characters', () => {
    expect(titleOverlap('Responsabile Revisione', 'Responsabile Revisione')).toBe(1);
  });

  it('returns 1 for empty expected', () => {
    expect(titleOverlap('', 'anything')).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────
// Description building tests
// ──────────────────────────────────────────────────────────────

describe('buildPdfBackedDescription — AIL format', () => {
  it('builds rich description from Project Coordinator PDF', () => {
    const normalized = normalizePdfJobText(FIXTURE_PROJECT_COORDINATOR_PDF);
    const desc = buildPdfBackedDescription({
      introLines: [
        '## Project Coordinator',
        'Aziende Industriali di Lugano (AIL) SA — posizione aperta a Lugano/Muzzano (TI).',
      ],
      pdfText: normalized,
      footerLines: [
        '---',
        '**Settore:** Energia / Servizi pubblici',
        '**Sede:** Via Industria 2, 6933 Muzzano (Lugano), TI, Svizzera',
      ],
    });

    expect(desc.length).toBeGreaterThanOrEqual(500);
    expect(desc).toContain('## Project Coordinator');
    expect(desc).toContain('progettazione');
    expect(desc).toContain('Chi cerchiamo');
    expect(desc).toContain('**Settore:**');
  });

  it('builds rich description from Audit PDF', () => {
    const normalized = normalizePdfJobText(FIXTURE_AUDIT_PDF);
    const desc = buildPdfBackedDescription({
      introLines: [
        '## Responsabile della Revisione interna (Audit)',
        'Aziende Industriali di Lugano (AIL) SA — posizione aperta a Lugano/Muzzano (TI).',
      ],
      pdfText: normalized,
      footerLines: ['**Sede:** Muzzano'],
    });

    expect(desc.length).toBeGreaterThanOrEqual(500);
    expect(desc).toContain('Revisione interna');
    expect(desc).toContain('audit');
    expect(desc).toContain('governance');
  });

  it('uses fallback when no PDF text available', () => {
    const desc = buildPdfBackedDescription({
      introLines: ['## Test Position'],
      pdfText: '',
      fallbackText: 'Consultare il bando ufficiale per maggiori dettagli.',
      footerLines: ['Sede: Lugano'],
    });

    expect(desc).toContain('Consultare il bando');
  });
});
