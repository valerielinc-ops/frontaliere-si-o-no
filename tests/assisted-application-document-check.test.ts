// services/assistedApplicationDocumentCheck.ts: the candidate's browser tells
// them when a file does not look like the document the posting asks for
// (owner decision 2026-10-02: a warning, never a block). Rolex: school
// reports and the EVA test results.
import { describe, expect, it, vi } from 'vitest';
import { checkDocumentFile, classifyDocumentText, DOCUMENT_CHECK_VERSION, readDocumentText } from '../services/assistedApplicationDocumentCheck';
import { sanitizeClientCheck } from '../functions/src/assistedApplicationExtraDocuments.js';


vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: vi.fn() }));

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

  it.each([
    'Università degli Studi. Si conferisce il titolo di dottore in informatica. Laurea conseguita con votazione finale.',
    'Ministero dell’istruzione. Diploma di maturità scientifica conseguito al termine dell’esame di Stato.',
    'Universität. Abschlusszeugnis über den erfolgreich abgeschlossenen Studiengang Informatik.',
    'Université. Diplôme de licence délivré après validation des examens du cursus informatique.',
    'University registrar. Bachelor of Science awarded upon successful completion of all examinations.',
  ])('recognises a qualification in another language: %s', text => {
    expect(classifyDocumentText(text, { label: 'degree certificates', kind: 'diploma', keywords: ['degree certificates'] }).verdict).toBe('match');
  });

  it.each([
    'Si certifica che il candidato ha superato, con voti 100 su 110, l’esame di laurea in ingegneria informatica.',
    `Si certifica che il candidato ha superato in data ${new Intl.DateTimeFormat('it-IT').format(new Date())} con voti 100/110 l’esame di laurea in ingegneria informatica.`,
    'Modello amministrativo 42. Si certifica che il candidato ha superato l’esame di laurea in ingegneria informatica.',
    'Si attesta che la candidata ha superato l’esame di laurea in ingegneria informatica.',
    'SI CERTIFICA CHE IL CANDIDATO HA SUPERATO, CON VOTAZIONE 100/110, L’ESAME DI LAUREA IN INFORMATICA.',
  ])('recognises completed degree exams certified without a degree title: %s', text => {
    expect(classifyDocumentText(text, { label: 'degree certificates', kind: 'diploma', keywords: ['degree certificates'] }))
      .toEqual({ verdict: 'match', matched: 'esame di laurea' });
  });

  it.each([
    'Non si certifica che il candidato ha superato l’esame di laurea in ingegneria informatica.',
    'Mai si attesta che il candidato ha superato l’esame di laurea in ingegneria informatica.',
    'Fattura per servizio di traduzione. Testo richiesto dal cliente: «Si certifica che il candidato ha superato l’esame di laurea in ingegneria informatica».',
    'Template: si certifica che il candidato ha superato l’esame di laurea in ingegneria informatica.',
    'Fac simile di certificato: si certifica che il candidato ha superato l’esame di laurea in ingegneria informatica.',
    'Lettera di referenza. Si certifica che il candidato ha superato l’esame di laurea in ingegneria informatica.',
    'Si certifica che il candidato non ha superato l’esame di laurea in ingegneria informatica.',
    'Si certifica che il candidato non ha ancora superato l’esame di laurea in ingegneria informatica.',
    'Si certifica che il candidato deve sostenere l’esame di laurea in ingegneria informatica.',
    'Il candidato ha superato un esame di formazione. Certificato di residenza per uso amministrativo.',
  ])('requires a certified completed degree exam: %s', text => {
    expect(classifyDocumentText(text, { label: 'degree certificates', kind: 'diploma', keywords: ['degree certificates'] }).verdict).toBe('mismatch');
  });

  it('keeps CV warnings ahead of certified degree exam wording and scopes it to diplomas', () => {
    const certificate = 'Si certifica che il candidato ha superato, con voti 100 su 110, l’esame di laurea in ingegneria informatica.';
    expect(classifyDocumentText(CV + certificate, { label: 'degree certificates', kind: 'diploma', keywords: ['degree certificates'] }).verdict).toBe('looks_like_cv');
    expect(classifyDocumentText(certificate, { label: 'Arbeitszeugnisse', kind: 'reference', keywords: ['Arbeitszeugnisse'] }).verdict).toBe('mismatch');
  });

  it('recognises an Italian work reference requested in German and keeps unrelated documents and CVs distinct', () => {
    expect(classifyDocumentText('Certificato di lavoro. Si attesta il rapporto di impiego e si descrivono le mansioni svolte.', { label: 'Arbeitszeugnisse', kind: 'reference', keywords: ['Arbeitszeugnisse'] }).verdict).toBe('match');
    const degree = { label: 'degree certificates', kind: 'diploma', keywords: ['degree certificates'] };
    expect(classifyDocumentText(CV + ' Diploma di laurea in informatica.', degree).verdict).toBe('looks_like_cv');
    expect(classifyDocumentText('Comune. Certificato di residenza relativo alla persona iscritta in anagrafe, per uso amministrativo.', degree).verdict).toBe('mismatch');
    expect(classifyDocumentText('Fattura per un master di formazione. Importo dovuto e modalità di pagamento, scadenza trenta giorni.', degree).verdict).toBe('mismatch');
  });

  it.each([false, true])('releases the PDF reader after a browser recheck, including parsing errors: %s', async broken => {
    const pdfjs = await import('pdfjs-dist');
    const destroy = vi.fn(async () => {});
    const pdf = { numPages: 1, destroy, getPage: async () => ({ getTextContent: async () => {
      if (broken) throw new Error('unreadable PDF');
      return { items: [{ str: 'Si certifica che il candidato ha superato l’esame di laurea in ingegneria informatica.' }] };
    } }) };
    vi.mocked(pdfjs.getDocument).mockReturnValue({ promise: Promise.resolve(pdf) } as any);
    const text = await readDocumentText({ name: 'degree.pdf', type: 'application/pdf', arrayBuffer: async () => new ArrayBuffer(0) } as File);
    expect(text).toBe(broken ? '' : 'Si certifica che il candidato ha superato l’esame di laurea in ingegneria informatica.');
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('versions new browser checks and preserves their version without storing extracted text', async () => {
    const check = await checkDocumentFile({ name: 'scan.png', type: 'image/png' } as File, REPORTS);
    expect(check).toEqual({ verdict: 'unreadable', matched: '', version: DOCUMENT_CHECK_VERSION });
    expect(sanitizeClientCheck({ ...check, extractedText: 'private content' })).toEqual(check);
    expect(sanitizeClientCheck({ verdict: 'mismatch', matched: '' })).toEqual({ verdict: 'mismatch', matched: '' });
    expect(sanitizeClientCheck({ ...check, version: Infinity })).not.toHaveProperty('version');
  });
});
