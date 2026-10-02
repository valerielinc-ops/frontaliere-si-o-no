// functions/src/assistedApplicationExtraDocuments.js: the documents a posting
// requires besides the CV and the letter (Rolex 2026-10-02: school reports,
// EVA and GRI results), as the draft reads them and the candidate gives them.
import { describe, expect, it } from 'vitest';
import {
  EXTRA_DOCUMENT_SLOTS,
  MAX_FILES_PER_DOCUMENT,
  documentFilesOf,
  extraDocumentFileName,
  extraDocumentsToSend,
  requiredDocumentsFromRequirements,
  requiredDocumentsOf,
} from '../functions/src/assistedApplicationExtraDocuments.js';
import { sanitizeRequirements, verifyQuotes } from '../functions/src/assistedApplicationAiDraftCore.js';
import { REQUIREMENTS_SCHEMA } from '../functions/src/assistedApplicationAiPrompts.js';
import { PLAN_SCHEMA } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { AGENT_SCHEMA } from '../scripts/assisted-application/lib/portal/agent.mjs';

const ORDER = 'order_DOCS1';
const key = (name: string) => `assisted-application-uploads/${ORDER}/${name}`;

describe('requested documents', () => {
  it('cleans what the draft read: known kinds, unique ids, bounded lists', () => {
    const docs = requiredDocumentsOf({
      requiredDocuments: [
        { id: 'School Reports!', label: '  Bulletins   des trois dernières années ', kind: 'school_report', keywords: ['bulletin', '', 'notes'], required: true, quote: 'Vos bulletins' },
        { id: 'school_reports', label: 'duplicate', kind: 'school_report' },
        { id: 'eva', label: 'Test EVA', kind: 'not-a-kind', required: false },
        { id: '', label: 'no id' },
        { id: 'no_label', label: '' },
      ],
    });
    expect(docs).toEqual([
      { id: 'school_reports', label: 'Bulletins des trois dernières années', kind: 'school_report', keywords: ['bulletin', 'notes'], required: true, quote: 'Vos bulletins' },
      { id: 'eva', label: 'Test EVA', kind: 'other', keywords: [], required: false, quote: '' },
    ]);
    expect(requiredDocumentsOf({})).toEqual([]);
    expect(requiredDocumentsOf({ requiredDocuments: Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, label: `D${i}` })) })).toHaveLength(EXTRA_DOCUMENT_SLOTS.length);
  });

  it('keeps only files in the order\'s folder, of a known type, at most five', () => {
    const flow = { documents: { reports: { files: [
      { key: key('a.pdf'), detectedType: 'pdf' },
      { key: 'assisted-application-uploads/other/a.pdf', detectedType: 'pdf' },
      { key: key('../x.pdf'), detectedType: 'pdf' },
      { key: key('b.exe'), detectedType: 'exe' },
      ...Array.from({ length: 8 }, (_, i) => ({ key: key(`c${i}.png`), detectedType: 'png' })),
    ] } } };
    const files = documentFilesOf(flow, ORDER, 'reports');
    expect(files).toHaveLength(MAX_FILES_PER_DOCUMENT);
    expect(files[0].key).toBe(key('a.pdf'));
    expect(files.every((file: any) => file.key.startsWith(`assisted-application-uploads/${ORDER}/`) && !file.key.includes('..'))).toBe(true);
  });

  it('sends the documents the candidate gave, each on its stable slot', () => {
    const draft = { requiredDocuments: [
      { id: 'reports', label: 'Pagelle', kind: 'school_report' },
      { id: 'eva', label: 'Test EVA', kind: 'aptitude_test', keywords: ['EVA'] },
      { id: 'gri', label: 'Test GRI', kind: 'aptitude_test' },
    ] };
    // Pagelle waived (no files): the EVA keeps slot 2, the GRI slot 3.
    const flow = { documents: { reports: { files: [], waivedAt: 1 }, eva: { files: [{ key: key('eva.pdf'), detectedType: 'pdf', name: 'x' }] }, gri: { files: [{ key: key('gri.png'), detectedType: 'png' }] } } };
    expect(extraDocumentsToSend(draft, flow, ORDER)).toEqual([
      { id: 'eva', slot: 'extra_2', label: 'Test EVA', kind: 'aptitude_test', keywords: ['EVA'], files: [{ key: key('eva.pdf'), detectedType: 'pdf', name: 'x' }] },
      { id: 'gri', slot: 'extra_3', label: 'Test GRI', kind: 'aptitude_test', keywords: [], files: [{ key: key('gri.png'), detectedType: 'png' }] },
    ]);
    expect(extraDocumentsToSend(draft, {}, ORDER)).toEqual([]);
  });

  it('names files after the document and the candidate', () => {
    expect(extraDocumentFileName({ label: 'Résultats du test EVA', name: 'Maria Rossi', type: 'pdf' })).toBe('Resultats_du_test_EVA_Maria_Rossi.pdf');
    expect(extraDocumentFileName({ label: 'Pagelle', index: 1, count: 3, name: 'Maria Rossi', type: 'jpg' })).toBe('Pagelle_2_Maria_Rossi.jpg');
    expect(extraDocumentFileName({ label: 'X', name: 'M', type: 'exe' })).toBe('X_M.pdf');
  });

  // The requirements pass reads them from the posting (functions/src/assistedApplicationAiPrompts.js).
  it('keeps only documents the posting really asks for, with a stable id from their wording', () => {
    const posting = 'Votre dossier devra contenir : Un curriculum vitae, Une lettre de motivation, Vos bulletins des trois dernières années scolaires, Vos résultats au test EVA.';
    const requirements = verifyQuotes(sanitizeRequirements({
      requirements: [],
      requestedDocuments: [
        { document: 'Bulletins des trois dernières années scolaires', kind: 'school_report', required: true, quote: 'Vos bulletins des trois dernières années scolaires', keywords: ['bulletin', 'Zeugnis', 'pagella'] },
        { document: 'Résultats du test EVA', kind: 'aptitude_test', required: true, quote: 'Vos résultats au test EVA', keywords: ['EVA', 'evatech'] },
        // Invented by the model: no such words in the posting.
        { document: 'Casier judiciaire', kind: 'identity', required: true, quote: 'Un extrait du casier judiciaire', keywords: [] },
        { document: 'No quote', kind: 'other', required: true, quote: '', keywords: [] },
      ],
    }), posting);
    expect(requirements.requestedDocuments.map((item: any) => item.document)).toEqual(['Bulletins des trois dernières années scolaires', 'Résultats du test EVA']);
    const documents = requiredDocumentsFromRequirements(requirements);
    expect(documents).toEqual([
      { id: 'bulletins_des_trois_dernieres_annees_sco', label: 'Bulletins des trois dernières années scolaires', kind: 'school_report', keywords: ['bulletin', 'Zeugnis', 'pagella'], required: true, quote: 'Vos bulletins des trois dernières années scolaires' },
      { id: 'resultats_du_test_eva', label: 'Résultats du test EVA', kind: 'aptitude_test', keywords: ['EVA', 'evatech'], required: true, quote: 'Vos résultats au test EVA' },
    ]);
    // Requirements read before this existed (no requestedDocuments): nothing is asked.
    expect(requiredDocumentsFromRequirements({ requirements: [] })).toEqual([]);
    expect(Object.keys((REQUIREMENTS_SCHEMA as any).properties)).toContain('requestedDocuments');
  });

  it('lets the form planner and its agentic fallback name a requested document by slot', () => {
    const planDocument = (PLAN_SCHEMA as any).properties.actions.items.properties.document.enum;
    const agentDocument = (AGENT_SCHEMA as any).properties.actions.items.properties.document.enum;
    for (const values of [planDocument, agentDocument]) {
      expect(values).toEqual(expect.arrayContaining(['cv', 'cover_letter', 'none', ...EXTRA_DOCUMENT_SLOTS]));
    }
  });
});
