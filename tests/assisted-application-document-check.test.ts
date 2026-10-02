// services/assistedApplicationDocumentCheck.ts: the candidate's browser tells
// them when a file does not look like the document the posting asks for
// (owner decision 2026-10-02: a warning, never a block). Rolex: school
// reports and the EVA test results.
import { describe, expect, it } from 'vitest';
import { classifyDocumentText } from '../services/assistedApplicationDocumentCheck';

const REPORTS = { label: 'Bulletins des trois dernières années scolaires', kind: 'school_report', keywords: ['bulletin', 'Zeugnis', 'pagella', 'school report'] };
const EVA = { label: 'Résultats du test EVA', kind: 'aptitude_test', keywords: ['EVA', 'evatech', 'test d\'aptitudes'] };

const BULLETIN = 'République et canton de Genève — Cycle d\'orientation. Bulletin scolaire 2024-2025, 2e semestre. Français 5.0, Mathématiques 5.5, Allemand 4.5. Moyenne générale 5.0.';
const EVA_RESULT = 'evatech — Évaluation des compétences. Résultats du test d\'aptitudes EVA : logique 82 %, mathématiques 76 %, français 88 %. Profil : informatique.';
const CV = 'Curriculum vitae. Dati personali: nato a Como. Esperienza professionale: tecnico IT presso Studio Rossi, 2022-2025. Istruzione e formazione: diploma tecnico. Competenze: reti, Windows, assistenza utenti. Conoscenze linguistiche: italiano, francese.';

describe('the browser\'s check of a requested document', () => {
  it('recognises the document from the words printed on it', () => {
    expect(classifyDocumentText(BULLETIN, REPORTS)).toEqual({ verdict: 'match', matched: 'bulletin' });
    expect(classifyDocumentText(EVA_RESULT, EVA)).toEqual({ verdict: 'match', matched: 'eva' });
    // German and Italian school reports, without the posting's French words.
    expect(classifyDocumentText('Kantonsschule — Zeugnis Schuljahr 2024/25. Noten: Deutsch 5, Mathematik 5.5. Semester 2.', REPORTS).verdict).toBe('match');
    expect(classifyDocumentText('Scuola media — Pagella anno scolastico 2024/2025. Voti finali: italiano 8, matematica 9.', { ...REPORTS, keywords: [] }).verdict).toBe('match');
  });

  it('says so when the candidate picked their CV instead', () => {
    expect(classifyDocumentText(CV, EVA)).toEqual({ verdict: 'looks_like_cv', matched: '' });
    expect(classifyDocumentText(CV, REPORTS).verdict).toBe('looks_like_cv');
  });

  it('warns about a file that shows nothing of the document, and never judges a scan', () => {
    expect(classifyDocumentText('Fattura n. 1234 del 12 marzo 2025. Importo dovuto CHF 120.00. Pagamento entro 30 giorni.', EVA).verdict).toBe('mismatch');
    // A photo or a scanned PDF has no text in the browser: the candidate checks it.
    expect(classifyDocumentText('', REPORTS)).toEqual({ verdict: 'unreadable', matched: '' });
    expect(classifyDocumentText('  1  ', REPORTS).verdict).toBe('unreadable');
  });

  it('matches whole words only, never part of another word', () => {
    // «eva» inside «evaluation» or «prevalere» is not the EVA test.
    expect(classifyDocumentText('Evaluation report: the project will prevalere over the previous plan, timeline and budget attached.', { ...EVA, keywords: ['EVA'] }).verdict).toBe('mismatch');
  });
});
