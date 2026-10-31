import { describe, expect, it } from 'vitest';
import { nativeFormContract } from '../functions/src/lib/nativeFormContract.js';
import { nativeApprovedFilePurpose, nativeFilePurposeCaption, nativeFilePurposeContract } from '../functions/src/lib/nativeFilePurpose.js';

const contract = (overrides = {}) => nativeFormContract({ id: 'upload', label: 'Diploma', kind: 'file', inputType: 'file',
  nativeMetadataComplete: true, nativeOwnedScopes: [{ kind: 'form', names: ['Application documents'], unknown: false }], ...overrides });

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
});
