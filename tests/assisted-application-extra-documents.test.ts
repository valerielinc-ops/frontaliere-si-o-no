// functions/src/assistedApplicationExtraDocuments.js: the documents a posting
// requires besides the CV and the letter (Rolex 2026-10-02: school reports,
// EVA and GRI results), as the draft reads them and the candidate gives them.
import { describe, expect, it } from 'vitest';
import {
  EXTRA_DOCUMENT_SLOTS,
  MAX_REQUIRED_DOCUMENTS,
  MAX_FILES_PER_DOCUMENT,
  documentFilesOf,
  extraDocumentFileName,
  mergeRequiredDocuments,
  extraDocumentsToSend,
  openRequiredDocuments,
  documentsView,
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
    expect(requiredDocumentsOf({ requiredDocuments: Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, label: `D${i}` })) })).toHaveLength(MAX_REQUIRED_DOCUMENTS);
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
    // Pagelle not given (no files): the EVA keeps slot 2, the GRI slot 3.
    const flow = { documents: { reports: { files: [] }, eva: { files: [{ key: key('eva.pdf'), detectedType: 'pdf', name: 'x' }] }, gri: { files: [{ key: key('gri.png'), detectedType: 'png' }] } } };
    expect(extraDocumentsToSend(draft, flow, ORDER)).toEqual([
      { id: 'eva', slot: 'extra_2', label: 'Test EVA', kind: 'aptitude_test', keywords: ['EVA'], files: [{ key: key('eva.pdf'), detectedType: 'pdf', name: 'x' }] },
      { id: 'gri', slot: 'extra_3', label: 'Test GRI', kind: 'aptitude_test', keywords: [], files: [{ key: key('gri.png'), detectedType: 'png' }] },
    ]);
    expect(extraDocumentsToSend(draft, {}, ORDER)).toEqual([]);
  });

  // Owner decision 2026-10-08: what the posting demands is uploaded, or the application waits. The «send
  // without it» of 2026-10-02 sent an application that failed at the portal's upload, or at the employer.
  it('holds a required document until a file is given: nothing else lifts it, not an older flow\'s waiver', () => {
    const draft = { requiredDocuments: [
      { id: 'reports', label: 'Pagelle', kind: 'school_report', required: true },
      { id: 'eva', label: 'Test EVA', kind: 'aptitude_test', required: true },
      { id: 'portfolio', label: 'Portfolio', kind: 'portfolio', required: false },
    ] };
    const file = { key: key('reports.pdf'), detectedType: 'pdf', name: 'reports.pdf' };
    expect(openRequiredDocuments(draft, {})).toEqual(['reports', 'eva']);
    expect(openRequiredDocuments(draft, { reports: { files: [file] } })).toEqual(['eva']);
    // A flow written before the decision still holds its waiver: read by nothing.
    expect(openRequiredDocuments(draft, { reports: { files: [file] }, eva: { files: [], waivedAt: 1 } })).toEqual(['eva']);
    expect(openRequiredDocuments(draft, { reports: { files: [file] }, eva: { files: [file] } })).toEqual([]);
    const view = documentsView(draft, { documents: { eva: { files: [], waivedAt: 1 } } });
    expect(view.map((document: any) => document.id)).toEqual(['reports', 'eva', 'portfolio']);
    expect(view.every((document: any) => !('waived' in document))).toBe(true);
  });

  it('keeps local-only scans out of server document state while requiring uploaded paper scans', () => {
    const draft = { requiredDocuments: [
      { id: 'health', label: 'Health questionnaire', required: true, delivery: 'offline', localOnly: true },
      { id: 'study', label: 'Study certificates', required: true, delivery: 'offline' },
    ] };
    const flow = { postalSubmission: { enabled: true }, documents: {
      health: { files: [{ key: key('doc-health-1.pdf'), detectedType: 'pdf' }] },
      study: { preparedAt: 1, files: [] },
    } };
    expect(requiredDocumentsOf(draft)[0]).toMatchObject({ localOnly: true, delivery: 'offline' });
    expect(documentsView(draft, flow)[0].files).toEqual([]);
    expect(openRequiredDocuments(draft, flow.documents, flow)).toEqual(['study']);

    const uploaded = { ...flow.documents, study: { files: [{ key: key('doc-study-1.pdf'), detectedType: 'pdf' }] } };
    expect(openRequiredDocuments(draft, uploaded, flow)).toEqual([]);
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

  it('merges a portal copy of a posting document and keeps portal-only uploads', () => {
    expect(mergeRequiredDocuments(
      [{ id: 'references', label: 'Arbeitszeugnisse', kind: 'reference', required: true, quote: 'Arbeitszeugnisse', keywords: ['Arbeitszeugnis'] }],
      [
        { id: 'portal_document_arbeitszeugnisse', label: 'Arbeitszeugnisse hochladen', kind: 'other', required: true, quote: 'Arbeitszeugnisse *', keywords: ['reference'] },
        { id: 'portal_document_passport', label: 'Passport copy', kind: 'other', required: true, quote: 'Passport copy *', keywords: ['passport'] },
      ],
    )).toEqual([
      { id: 'references', label: 'Arbeitszeugnisse', kind: 'reference', keywords: ['Arbeitszeugnis', 'reference'], required: true, quote: 'Arbeitszeugnisse' },
      { id: 'portal_document_passport', label: 'Passport copy', kind: 'other', keywords: ['passport'], required: true, quote: 'Passport copy *' },
    ]);
  });

  it.each([
    'Foto',
    'Photo (optional)',
    'Photos',
    'Bewerbungsfoto',
    'Passfoto',
    'Profilbild',
    'photo d’identité',
    'photographie d’identité',
    'fotografia',
  ])('recognises a required portrait slot across portal languages: %s', label => {
    const [photo] = requiredDocumentsOf({ requiredDocuments: [{ id: 'portal_photo', label, kind: 'other', required: true }] });
    expect(photo).toMatchObject({ id: 'portal_photo', kind: 'photo', required: true });
  });

  it('does not treat a photo ID as a candidate portrait', () => {
    const documents = requiredDocumentsOf({ requiredDocuments: [
      { id: 'photo_id', label: 'Photo ID', kind: 'photo', required: true },
      { id: 'identity_photo', label: 'ID photo', kind: 'other', required: true },
    ] });
    expect(documents.map(document => document.kind)).toEqual(['other', 'other']);
  });

  it('uses the dedicated photo slot and requires an image rather than an arbitrary attachment', () => {
    const draft = { requiredDocuments: [{ id: 'portal_photo', label: 'Foto*', required: true }] };
    const pdf = { key: key('doc-portal_photo-0-1234abcd.pdf'), detectedType: 'pdf' };
    const jpg = { key: key('doc-portal_photo-0-1234abcd.jpg'), detectedType: 'jpg', size: 1234 };
    expect(openRequiredDocuments(draft, { portal_photo: { files: [pdf] } })).toEqual(['portal_photo']);
    expect(openRequiredDocuments(draft, { portal_photo: { files: [jpg] } })).toEqual([]);
    expect(extraDocumentsToSend(draft, { documents: { portal_photo: { files: [jpg] } } }, ORDER)).toEqual([
      expect.objectContaining({ id: 'portal_photo', slot: 'photo', kind: 'photo', files: [jpg] }),
    ]);
    expect(EXTRA_DOCUMENT_SLOTS).toContain('photo');
  });

  it('requires an uploaded portrait to satisfy the field accept and byte limit', () => {
    const draft = { requiredDocuments: [{
      id: 'portal_photo', label: 'Foto*', required: true, accept: 'image/jpeg', maxBytes: 2048,
    }] };
    const png = { key: key('doc-portal_photo-0-1234abcd.png'), detectedType: 'png', size: 1000 };
    const unknownSizeJpg = { key: key('doc-portal_photo-1-1234abcd.jpg'), detectedType: 'jpg' };
    const acceptedJpg = { key: key('doc-portal_photo-2-1234abcd.jpg'), detectedType: 'jpg', size: 2048 };
    const oversizedJpg = { key: key('doc-portal_photo-3-1234abcd.jpg'), detectedType: 'jpg', size: 2049 };
    const sharedSlotJpg = { key: key('doc-photo-0-1234abcd.jpg'), detectedType: 'jpg', size: 1024 };

    expect(openRequiredDocuments(draft, { portal_photo: { files: [png, unknownSizeJpg, oversizedJpg] } })).toEqual(['portal_photo']);
    expect(openRequiredDocuments(draft, { portal_photo: { files: [png, acceptedJpg, oversizedJpg] } })).toEqual([]);
    expect(extraDocumentsToSend(draft, {
      documents: { portal_photo: { files: [png, unknownSizeJpg, acceptedJpg, oversizedJpg] } },
    }, ORDER)).toEqual([
      expect.objectContaining({ id: 'portal_photo', slot: 'photo', files: [acceptedJpg] }),
    ]);
    const sharedSlotFlow = { documents: {
      portal_photo: { files: [png] },
      photo: { files: [sharedSlotJpg] },
    } };
    expect(openRequiredDocuments(draft, sharedSlotFlow.documents)).toEqual([]);
    expect(extraDocumentsToSend(draft, sharedSlotFlow, ORDER)).toEqual([
      expect.objectContaining({ id: 'portal_photo', slot: 'photo', files: [sharedSlotJpg] }),
    ]);
  });

  it('uses the candidate photo already stored for the tailored CV before looking in the CV', () => {
    const draft = { requiredDocuments: [{ id: 'portal_photo', label: 'Foto', required: true, accept: 'image/jpeg' }] };
    const candidatePhoto = {
      key: key('photo-1234-abcd.jpg'), detectedType: 'jpg', size: 1200, uploadedAt: 1234,
    };
    const flow = { photo: candidatePhoto };

    expect(openRequiredDocuments(draft, {}, flow)).toEqual([]);
    expect(extraDocumentsToSend(draft, flow, ORDER)).toEqual([
      expect.objectContaining({ id: 'portal_photo', slot: 'photo', files: [expect.objectContaining({
        key: candidatePhoto.key, detectedType: 'jpg', size: candidatePhoto.size,
      })] }),
    ]);
  });

  it('does not drop a portal-only requirement after eight posting documents', () => {
    const posting = Array.from({ length: 8 }, (_, index) => ({ id: `posting_${index}`, label: `Posting document ${index}`, required: true }));
    const merged = mergeRequiredDocuments(posting, [{ id: 'portal_only', label: 'Portal-only certificate', required: true }]);
    expect(merged).toHaveLength(9);
    expect(merged).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'portal_only' })]));
  });

  it('lets the form planner and its agentic fallback name a requested document by slot', () => {
    const planDocument = (PLAN_SCHEMA as any).properties.actions.items.properties.document.enum;
    const agentDocument = (AGENT_SCHEMA as any).properties.actions.items.properties.document.enum;
    for (const values of [planDocument, agentDocument]) {
      expect(values).toEqual(expect.arrayContaining(['cv', 'cover_letter', 'none', ...EXTRA_DOCUMENT_SLOTS]));
    }
  });
});
