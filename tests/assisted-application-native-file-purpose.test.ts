import { describe, expect, it } from 'vitest';
import { nativeFormContract } from '../functions/src/lib/nativeFormContract.js';
import { nativeApprovedFilePurpose, nativeDocumentInstruction, nativeFilePurposeCaption, nativeFilePurposeContract } from '../functions/src/lib/nativeFilePurpose.js';

const contract = (overrides = {}) => nativeFormContract({ id: 'upload', label: 'Diploma', kind: 'file', inputType: 'file',
  nativeMetadataComplete: true, nativeOwnedScopes: [{ kind: 'form', names: ['Application documents'], unknown: false }], ...overrides });
const instruction = 'Please click on "apply now" to submit a complete application, including CV, cover letter, references and degree certificates.';

describe('one closed native file-purpose classifier', () => {
  it('preserves existing CV and cover-letter transport purposes', () => {
    for (const text of ['CV', 'Curriculum vitae', 'Resume', 'Lebenslauf']) expect(nativeApprovedFilePurpose(text)).toBe('cv');
    for (const text of ['Cover letter', 'Motivationsschreiben', 'Lettera di motivazione', 'Lettre de motivation'])
      expect(nativeApprovedFilePurpose(text)).toBe('cover_letter');
  });

  it('recognizes the complete degree-certificate family in four locales without asserting file contents', () => {
    for (const text of ['Diploma', 'Diplom', 'Diplôme']) expect(nativeFilePurposeCaption(text)).toEqual({ family: 'diploma', constraints: {} });
    for (const text of ['degree certificates', 'Degree certificate', 'Diploma di laurea', 'Certificato di laurea', 'Hochschuldiplom', 'Diplôme universitaire'])
      expect(nativeFilePurposeCaption(text)).toEqual({ family: 'diploma', constraints: { educationalScope: 'university' } });
  });

  it('keeps generic extras, competing document families and unsupported qualifiers unknown', () => {
    for (const text of ['Certificate', 'Certificat', 'Attestato', 'Zertifikat', 'Other documents', 'Diploma / CV', 'Diploma in engineering',
      'Degree certificate with grade 5', 'CV and work permit', 'Degree certificate valid until 2030', 'Why our company?'])
      expect(nativeFilePurposeCaption(text)).toBeNull();
  });

  it('retains university constraints from the complete owned scope', () => {
    expect(nativeFilePurposeContract(contract({ context: 'degree certificates' })))
      .toEqual({ family: 'diploma', constraints: { educationalScope: 'university' } });
    expect(nativeFilePurposeContract(contract({ label: 'degree certificates' })))
      .toEqual({ family: 'diploma', constraints: { educationalScope: 'university' } });
  });

  it('does not discard conditional or foreign scope captions', () => {
    for (const names of [['Diploma in engineering'], ['CV'], ['I hold a work permit'], ['Diploma', 'I have five years of experience']]) {
      expect(nativeFilePurposeContract(contract({ nativeOwnedScopes: [{ kind: 'group', names, unknown: false }] }))).toBeNull();
    }
    expect(nativeFilePurposeContract(contract({ nativeOwnedScopes: [{ kind: 'group', names: ['Diploma'], unknown: true }] }))).toBeNull();
  });

  it('requires the same full file-control contract validator used by Node and server', () => {
    const native = contract(); delete native.ownedScopes;
    expect(nativeFilePurposeContract(native)).toBeNull();
    expect(nativeFilePurposeContract(contract({ kind: 'text', inputType: 'text' }))).toBeNull();
    expect(nativeFilePurposeContract({ question: 'Diploma', kind: 'file', controlType: 'file' })).toBeNull();
  });

  it('reads the complete shared instruction as four explicit transport purposes', () => {
    expect(nativeDocumentInstruction(instruction)).toEqual({ purposes: [
      { family: 'cv', constraints: {} }, { family: 'cover_letter', constraints: {} },
      { family: 'reference_document', constraints: {} }, { family: 'diploma', constraints: { educationalScope: 'university' } },
    ] });
    expect(nativeFilePurposeContract(contract({ context: instruction,
      nativeOwnedScopes: [{ kind: 'group', names: [instruction], unknown: false }, { kind: 'form', names: ['Application documents'], unknown: false }] })))
      .toEqual({ family: 'diploma', constraints: { educationalScope: 'university' } });
    expect(nativeFilePurposeContract(contract({ label: 'CV', context: instruction }))).toEqual({ family: 'cv', constraints: {} });
  });

  it('uses the same complete-list grammar for document captions in four locales', () => {
    for (const text of [
      'Application documents: CV, cover letter, work references and degree certificates.',
      'Documenti richiesti: CV, lettera di motivazione, referenze e diploma di laurea.',
      'Bewerbungsunterlagen: Lebenslauf, Motivationsschreiben, Arbeitszeugnisse und Hochschuldiplom.',
      'Documents de candidature: CV, lettre de motivation, certificats de travail et diplôme universitaire.',
    ]) expect(nativeDocumentInstruction(text)?.purposes).toHaveLength(4);
  });

  it('rejects every unknown qualifier rather than skipping another item of the list', () => {
    for (const text of [
      instruction.replace('degree certificates', 'degree certificates in Physics'),
      instruction.replace('degree certificates', 'degree certificates from University X'),
      instruction.replace('degree certificates', 'degree certificates not required'),
      instruction.replace('references', 'references from John Smith'),
      instruction + ' I hold a work permit.',
      'Not required: CV, cover letter and degree certificates.',
      'CV or degree certificates', 'CV / degree certificates', 'CV, Resume and degree certificates',
      'CV, , degree certificates', 'CV, and', 'CV, degree certifi…', instruction.slice(0, -9) + '...',
    ]) {
      expect(nativeDocumentInstruction(text)).toBeNull();
      expect(nativeFilePurposeContract(contract({ context: text }))).toBeNull();
    }
  });

  it('requires a specific native label, its matching list member and every owned scope', () => {
    expect(nativeFilePurposeContract(contract({ label: 'Other documents', context: instruction }))).toBeNull();
    expect(nativeFilePurposeContract(contract({ label: 'CV and degree certificates', context: instruction }))).toBeNull();
    expect(nativeFilePurposeContract(contract({ context: 'Application documents: CV and cover letter.' }))).toBeNull();
    expect(nativeFilePurposeContract(contract({ context: instruction,
      nativeOwnedScopes: [{ kind: 'group', names: ['Reference John Smith', instruction], unknown: false }] }))).toBeNull();
    expect(nativeFilePurposeContract(contract({ context: instruction, nativeContractUnavailable: true }))).toBeNull();
    expect(nativeFilePurposeContract(contract({ context: instruction,
      nativeOwnedScopes: [{ kind: 'group', names: [instruction], unknown: true }] }))).toBeNull();
  });

  it('does not reinterpret a standalone reference caption as a document or actor grant', () => {
    for (const label of ['References', 'Reference', 'Referenzen', 'Références', 'Name of reference']) {
      expect(nativeDocumentInstruction(label)).toBeNull();
      expect(nativeFilePurposeCaption(label)).toBeNull();
      expect(nativeFilePurposeContract(contract({ label, context: instruction }))).toBeNull();
    }
    expect(nativeDocumentInstruction('Documents required: CV and references.')?.purposes)
      .toEqual([{ family: 'cv', constraints: {} }, { family: 'reference_document', constraints: {} }]);
  });
});
