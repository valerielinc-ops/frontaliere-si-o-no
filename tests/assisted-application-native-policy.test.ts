import { describe, expect, it } from 'vitest';
import { nativeFormContract } from '../functions/src/lib/nativeFormContract.js';
import {
  createNativeApplicationAnswerPolicy, deriveNativeApplicationClaims, fieldFromNativeProof,
} from '../functions/src/lib/nativeApplicationPolicy.js';

const scopes = [{ kind: 'form', names: ['Application'], unknown: false }];
const field = (overrides = {}) => ({ id: 'field', label: 'Do you hold a diploma?', kind: 'text', inputType: 'text',
  nativeMetadataComplete: true, nativeOwnedScopes: scopes, ...overrides });
const entry = (value = 'Yes', overrides = {}) => ({ fieldId: 'field', nativeFormContract: nativeFormContract(field(overrides)), proposedAnswer: value });
const proof = (fields = [entry()]) => ({ version: 'owner-native-proof-v1', frameUrl: 'https://portal.example/apply/', round: 1, fields, attachments: [] });
const context = (overrides = {}) => ({ scope: { orderId: 'order-test', round: 1, sourceCvHash: 'a'.repeat(64) },
  answerEvidence: [], localAnswerEvidence: [], unverifiedContext: {}, ...overrides });
const receipt = (nativeFormContract, answer) => ({ id: 'confirmation-' + 'b'.repeat(64), contractHash: 'c'.repeat(64),
  version: 'native-answer-confirmation-v1', category: 'local_answer', scope: 'job', answer,
  question: { originalNativeContract: nativeFormContract }, provenance: { actor: 'candidate', orderId: 'order-test', round: 1 } });

describe('the shared full native application policy', () => {
  it('derives every submitted value including a read-only or prefilled factual answer', () => {
    const nativeProof = proof([entry('Yes'), { ...entry('No', { id: 'readonly', label: 'Have you led a team?', readOnly: true }), fieldId: 'readonly' }]);
    const result = deriveNativeApplicationClaims({ proof: nativeProof, context: context() });
    expect(result.status).toBe('ready');
    expect(result.claims.map(claim => [claim.fieldId, claim.proposedAnswer])).toEqual([['field', 'Yes'], ['readonly', 'No']]);
    expect(result.coverage).toHaveLength(2);
  });

  it('does not accept client claims, incomplete owned scope or duplicate fields', () => {
    expect(deriveNativeApplicationClaims({ proof: { ...proof(), claims: [] }, context: context() }).status).toBe('unverified');
    const value = entry(); delete value.nativeFormContract.ownedScopes;
    expect(fieldFromNativeProof(value)).toBeNull();
    expect(deriveNativeApplicationClaims({ proof: proof([entry(), entry()]), context: context() }).status).toBe('unverified');
  });

  it('uses positive applicant ownership before granting an identity exemption', () => {
    const own = entry('test@example.invalid', { label: 'Your email', inputType: 'email' });
    const foreign = entry('test@example.invalid', { label: 'Your email', inputType: 'email',
      nativeOwnedScopes: [{ kind: 'group', names: ['Reference'], unknown: false }, ...scopes] });
    const ctx = context({ applicationIdentity: { email: 'test@example.invalid' } });
    expect(deriveNativeApplicationClaims({ proof: proof([own]), context: ctx }).claims).toEqual([]);
    expect(deriveNativeApplicationClaims({ proof: proof([foreign]), context: ctx }).claims).toHaveLength(1);
  });

  it('binds the actual option catalog before any phone-prefix exemption', () => {
    const ctx = context({ applicationIdentity: { phone: '+41791234567' } });
    const prefix = { label: 'Your phone country code', kind: 'select', inputType: 'select',
      options: [{ label: 'Germany (+49)', value: 'DE' }] };
    expect(deriveNativeApplicationClaims({ proof: proof([entry('Switzerland (+41)', prefix)]), context: ctx }).failure)
      .toBe('native_option_ambiguous');
    expect(deriveNativeApplicationClaims({ proof: proof([entry('CH', { ...prefix,
      options: [{ label: 'Switzerland (+41)', value: 'CH' }, { label: 'Germany (+49)', value: 'CH' }] })]), context: ctx }).failure)
      .toBe('native_option_ambiguous');
  });

  it('records optional empty controls separately and keeps unsupported regex unknown', () => {
    expect(deriveNativeApplicationClaims({ proof: proof([entry('', { required: false })]), context: context() }).coverage)
      .toEqual([{ fieldId: 'field', kind: 'empty' }]);
    expect(deriveNativeApplicationClaims({ proof: proof([entry('', { required: true })]), context: context() }).status).toBe('unverified');
    expect(deriveNativeApplicationClaims({ proof: proof([entry('aaa!', { validation: { pattern: '(a+)+' } })]), context: context() }).failure)
      .toBe('native_pattern_unverified');
    expect(deriveNativeApplicationClaims({ proof: proof([entry('12345', { validation: { pattern: '[0-9]{5}' } })]), context: context() }).status).toBe('ready');
  });

  it('checks a known attested No before a matching identity or local Yes exemption', () => {
    const own = entry('test@example.invalid', { label: 'Your email', inputType: 'email' });
    const ctx = context({ applicationIdentity: { email: 'test@example.invalid' }, answerEvidence: [
      { question: { originalNativeContract: own.nativeFormContract }, answer: 'other@example.invalid', provenance: { actor: 'owner' } },
    ] });
    expect(deriveNativeApplicationClaims({ proof: proof([own]), context: ctx }).failure).toBe('native_attested_answer_conflict');
    const factual = entry('Yes');
    expect(deriveNativeApplicationClaims({ proof: proof([factual]), context: context({
      answerEvidence: [{ question: { originalNativeContract: factual.nativeFormContract }, answer: 'No', provenance: { actor: 'candidate' } }],
      localAnswerEvidence: [receipt(factual.nativeFormContract, 'Yes')],
    }) }).failure).toBe('native_attested_answer_conflict');
  });

  it('requires the same full contract and order/round for a local attestation', () => {
    const factual = entry('Yes');
    const confirmed = receipt(factual.nativeFormContract, 'Yes');
    expect(deriveNativeApplicationClaims({ proof: proof([factual]), context: context({ localAnswerEvidence: [confirmed] }) }).claims).toEqual([]);
    expect(deriveNativeApplicationClaims({ proof: proof([factual]), context: context({ localAnswerEvidence: [
      { ...confirmed, provenance: { ...confirmed.provenance, round: 2 } },
    ] }) }).claims).toHaveLength(1);
    const changed = entry('Yes', { context: 'Only for Swiss diplomas' });
    expect(deriveNativeApplicationClaims({ proof: proof([changed]), context: context({ localAnswerEvidence: [confirmed] }) }).claims).toHaveLength(1);
  });

  it('preserves conditional owned scope and rechecks a consent after new free-form notes', () => {
    const consentField = { label: 'I accept the privacy policy', kind: 'checkbox', inputType: 'checkbox', required: true,
      ownConsentText: ['I accept the privacy policy'], ownConsentQuestionLabels: ['I accept the privacy policy'], ownConsentLinks: [],
      ownConsentMetadataComplete: true, ownConsentQuestionOwned: true, ownConsentOwnerKey: JSON.stringify({ v: 1, scopes: [] }) };
    const consent = entry('Yes', consentField);
    expect(deriveNativeApplicationClaims({ proof: proof([consent]), context: context() }).claims).toEqual([]);
    expect(deriveNativeApplicationClaims({ proof: proof([entry('Yes', { ...consentField,
      nativeOwnedScopes: [{ kind: 'group', names: ['I hold a university degree'], unknown: false }, ...scopes] })]), context: context() }).claims).toHaveLength(1);
    const newNotes = context({ localAnswerEvidence: [receipt(consent.nativeFormContract, 'Yes')],
      unverifiedContext: { flowNotes: 'I no longer consent to the Privacy Policy.' } });
    expect(deriveNativeApplicationClaims({ proof: proof([consent]), context: newNotes }).claims).toHaveLength(1);
    const identity = entry('test@example.invalid', { label: 'Your email', inputType: 'email' });
    expect(deriveNativeApplicationClaims({ proof: proof([identity]), context: context({
      applicationIdentity: { email: 'test@example.invalid' }, unverifiedContext: { historicalContext: '3 months\nSwitzerland' },
    }) }).claims).toEqual([]);
  });

  it('does not treat unchecked factual boxes with a hidden No as consent opt-outs', () => {
    const unchecked = entry('No', { label: 'I have a driving licence', kind: 'checkbox', inputType: 'checkbox',
      nativeUncheckedSubmission: { name: 'licence', value: 'No' } });
    const result = deriveNativeApplicationClaims({ proof: proof([unchecked]), context: context() });
    expect(result.status).toBe('ready');
    expect(result.claims[0].proposedAnswer).toBe('No');
  });

  it('only exempts current approved document text with literal complete rendered bytes', () => {
    const document = field({ label: 'Cover letter', kind: 'textarea', inputType: 'textarea' });
    const action = { action: 'fill', value: 'Approved complete text.' };
    const policy = createNativeApplicationAnswerPolicy({ context: context({ documentsCurrent: true,
      approvedDocumentTexts: { coverLetter: action.value } }) });
    expect(policy.needs(document, action)).toBe(false);
    expect(policy.needs(document, { ...action, value: 'Approved complete' })).toBe(true);
    expect(createNativeApplicationAnswerPolicy({ context: context({ documentsCurrent: false,
      approvedDocumentTexts: { coverLetter: action.value } }) }).needs(document, action)).toBe(true);
  });

  it('blocks credential fields and unknown attachment purpose without sending their values to a judge', () => {
    expect(deriveNativeApplicationClaims({ proof: proof([entry('private-value', { label: 'Password', inputType: 'password' })]), context: context() }).failure)
      .toBe('credential_field_unverified');
    expect(deriveNativeApplicationClaims({ proof: { ...proof(), attachments: [{ fieldId: 'field', slot: 'cv', sha256: 'd'.repeat(64), size: 10 }] },
      context: context(), docsManifest: [{ slot: 'cv', sha256: 'd'.repeat(64), size: 10 }] }).status).toBe('unverified');
  });

  it('joins approved file bytes to one complete native control without treating a CV as a diploma', () => {
    const attachment = { fieldId: 'field', slot: 'cv', sha256: 'd'.repeat(64), size: 10 };
    const manifest = [{ slot: 'cv', sha256: attachment.sha256, size: 10, kind: 'diploma' }];
    const current = context({ documentsCurrent: true });
    const fileProof = { ...proof([entry('', { label: 'CV', kind: 'file', inputType: 'file', required: true })]), attachments: [attachment] };
    expect(deriveNativeApplicationClaims({ proof: fileProof, context: current, docsManifest: manifest }).coverage)
      .toEqual([{ ...attachment, kind: 'mechanical', exemption: 'approved_file_bytes' }]);
    expect(deriveNativeApplicationClaims({ proof: { ...fileProof,
      fields: [entry('', { label: 'Diploma', kind: 'file', inputType: 'file', required: true })] }, context: current, docsManifest: manifest }).failure)
      .toBe('native_attachment_purpose_unverified');
    expect(deriveNativeApplicationClaims({ proof: { ...fileProof,
      fields: [entry('', { label: 'CV', kind: 'file', inputType: 'file', required: true, context: 'Diploma required' })] }, context: current, docsManifest: manifest }).failure)
      .toBe('native_attachment_purpose_unverified');
    expect(deriveNativeApplicationClaims({ proof: fileProof, context: current, docsManifest: [...manifest, ...manifest] }).failure)
      .toBe('native_attachment_unverified');
    expect(deriveNativeApplicationClaims({ proof: fileProof, context: current, docsManifest: [{ ...manifest[0], sha256: 'e'.repeat(64) }] }).failure)
      .toBe('native_attachment_unverified');
    expect(deriveNativeApplicationClaims({ proof: fileProof, context: context(), docsManifest: manifest }).failure)
      .toBe('native_documents_stale');
    expect(deriveNativeApplicationClaims({ proof: proof([entry('', { label: 'Additional documents', kind: 'file', inputType: 'file', required: false })]), context: context() }).coverage)
      .toEqual([{ fieldId: 'field', kind: 'empty' }]);
  });
});
