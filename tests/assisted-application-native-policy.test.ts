import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { nativeFormContract } from '../functions/src/lib/nativeFormContract.js';
import { resolveNativeDocumentTransport, validateNativeDocumentTransport } from '../functions/src/lib/nativeDocumentTransport.js';
import {
  createNativeApplicationAnswerPolicy, deriveNativeApplicationClaims, fieldFromNativeProof, nativePolicyClaimAuthority,
  NATIVE_APPLICATION_MAX_FIELDS, NATIVE_APPLICATION_MAX_CLAIMS, NATIVE_APPLICATION_MAX_ATTACHMENTS, NATIVE_APPLICATION_POLICY_VERSION,
} from '../functions/src/lib/nativeApplicationPolicy.js';

const scopes = [{ kind: 'form', names: ['Application'], unknown: false }];
const field = (overrides = {}) => ({ id: 'field', label: 'Do you hold a diploma?', kind: 'text', inputType: 'text',
  nativeMetadataComplete: true, nativeOwnedScopes: scopes, ...overrides });
const entry = (value = 'Yes', overrides = {}) => ({ fieldId: 'field', nativeFormContract: nativeFormContract(field(overrides)), proposedAnswer: value });
const proof = (fields = [entry()]) => ({ version: 'owner-native-proof-v1', frameUrl: 'https://portal.example/apply/', round: 1, fields, attachments: [] });
const context = (overrides = {}) => ({ scope: { orderId: 'order-test', round: 1, sourceCvHash: 'a'.repeat(64) },
  answerEvidence: [], localAnswerEvidence: [], unverifiedContext: {},
  policyAuthority: { version: 'server-application-policy-authority-v1', orderId: 'order-test', round: 1,
    consentVersion: 'assisted-application-v2', consentedAt: Date.now() - 1000, paid: true,
    scopes: ['application_consent', 'optional_consent_refusal', 'individual_application_origin', 'operational_preference'],
    operationalPreferencesVersion: 'operational-preferences-v1' }, ...overrides });
const receipt = (nativeFormContract, answer) => ({ id: 'confirmation-' + 'b'.repeat(64), contractHash: 'c'.repeat(64),
  version: 'native-answer-confirmation-v1', category: 'local_answer', scope: 'job', answer,
  question: { originalNativeContract: nativeFormContract }, provenance: { actor: 'candidate', orderId: 'order-test', round: 1 } as Record<string, string | number> });

describe('the shared full native application policy', () => {
  it('requires the canonical server target decision rather than any client flag', () => {
    expect(deriveNativeApplicationClaims({ proof: { ...proof(), targetVerified: true }, context: context() }).failure)
      .toBe('native_target_unverified');
  });

  it('covers 257 through 300 controls without truncation and refuses 301', () => {
    expect(NATIVE_APPLICATION_MAX_FIELDS).toBe(300);
    for (const count of [257, 300, 301]) {
      const fields = Array.from({ length: count }, (_, index) => ({ ...entry('', { required: false }), fieldId: `field-${index}` }));
      const result = deriveNativeApplicationClaims({ targetVerified: true, proof: proof(fields), context: context() });
      expect(result.status).toBe(count > 300 ? 'unverified' : 'ready');
      if (count <= 300) expect(result.coverage).toHaveLength(count);
    }
  });

  it('retains all derived claims at 13 and 24 and refuses the complete overflow at 25', () => {
    expect(NATIVE_APPLICATION_MAX_CLAIMS).toBe(24);
    expect(NATIVE_APPLICATION_MAX_ATTACHMENTS).toBe(82);
    for (const count of [13, 24, 25]) {
      const fields = Array.from({ length: count }, (_, index) => ({ ...entry(), fieldId: `field-${index}` }));
      const result = deriveNativeApplicationClaims({ targetVerified: true, proof: proof(fields), context: context() });
      expect(result.status).toBe(count > 24 ? 'unverified' : 'ready');
      expect(result.claims).toHaveLength(count > 24 ? 0 : count);
      expect(result.coverage).toHaveLength(count > 24 ? 0 : count);
    }
  });
  it('derives every submitted value including a read-only or prefilled factual answer', () => {
    const nativeProof = proof([entry('Yes'), { ...entry('No', { id: 'readonly', label: 'Have you led a team?', readOnly: true }), fieldId: 'readonly' }]);
    const result = deriveNativeApplicationClaims({ targetVerified: true, proof: nativeProof, context: context() });
    expect(result.status).toBe('ready');
    expect(result.claims.map(claim => [claim.fieldId, claim.proposedAnswer])).toEqual([['field', 'Yes'], ['readonly', 'No']]);
    expect(result.coverage).toHaveLength(2);
  });

  it('does not accept client claims, incomplete owned scope or duplicate fields', () => {
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: { ...proof(), claims: [] }, context: context() }).status).toBe('unverified');
    const value = entry(); delete value.nativeFormContract.ownedScopes;
    expect(fieldFromNativeProof(value)).toBeNull();
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([entry(), entry()]), context: context() }).status).toBe('unverified');
  });

  it('uses positive applicant ownership before granting an identity exemption', () => {
    const own = entry('test@example.invalid', { label: 'Your email', inputType: 'email' });
    const foreign = entry('test@example.invalid', { label: 'Your email', inputType: 'email',
      nativeOwnedScopes: [{ kind: 'group', names: ['Reference'], unknown: false }, ...scopes] });
    const ctx = context({ applicationIdentity: { email: 'test@example.invalid' } });
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([own]), context: ctx }).claims).toEqual([]);
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([foreign]), context: ctx }).claims).toHaveLength(1);
  });

  it('binds the actual option catalog before any phone-prefix exemption', () => {
    const ctx = context({ applicationIdentity: { phone: '+41791234567' } });
    const prefix = { label: 'Your phone country code', kind: 'select', inputType: 'select',
      options: [{ label: 'Germany (+49)', value: 'DE' }] };
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([entry('Switzerland (+41)', prefix)]), context: ctx }).failure)
      .toBe('native_option_ambiguous');
    const qualified = deriveNativeApplicationClaims({ targetVerified: true, proof: proof([entry('CH', { ...prefix,
      options: [{ label: 'Switzerland (+41) and I hold a work permit', value: 'CH' }] })]), context: ctx });
    expect(qualified.claims).toHaveLength(1);
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([entry('CH', { ...prefix,
      options: [{ label: 'Switzerland (+41)', value: 'CH' }, { label: 'Germany (+49)', value: 'CH' }] })]), context: ctx }).failure)
      .toBe('native_option_ambiguous');
  });

  it('records optional empty controls separately and keeps unsupported regex unknown', () => {
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([entry('', { required: false })]), context: context() }).coverage)
      .toEqual([{ fieldId: 'field', kind: 'empty' }]);
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([entry('', { required: true })]), context: context() }).status).toBe('unverified');
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([entry('aaa!', { validation: { pattern: '(a+)+' } })]), context: context() }).failure)
      .toBe('native_pattern_unverified');
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([entry('12345', { validation: { pattern: '[0-9]{5}' } })]), context: context() }).status).toBe('ready');
  });

  it('checks a known attested No before a matching identity or local Yes exemption', () => {
    const own = entry('test@example.invalid', { label: 'Your email', inputType: 'email' });
    const ctx = context({ applicationIdentity: { email: 'test@example.invalid' }, answerEvidence: [
      { question: { originalNativeContract: own.nativeFormContract }, answer: 'other@example.invalid', provenance: { actor: 'owner' } },
    ] });
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([own]), context: ctx }).failure).toBe('native_attested_answer_conflict');
    const factual = entry('Yes');
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([factual]), context: context({
      answerEvidence: [{ question: { originalNativeContract: factual.nativeFormContract }, answer: 'No', provenance: { actor: 'candidate' } }],
      localAnswerEvidence: [receipt(factual.nativeFormContract, 'Yes')],
    }) }).failure).toBe('native_attested_refusal');
  });

  it('requires the same full contract and order/round for a local attestation', () => {
    const factual = entry('Yes');
    const confirmed = receipt(factual.nativeFormContract, 'Yes');
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([factual]), context: context({ localAnswerEvidence: [confirmed] }) }).claims).toEqual([]);
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([factual]), context: context({ localAnswerEvidence: [
      { ...confirmed, provenance: { ...confirmed.provenance, round: 2 } },
    ] }) }).claims).toHaveLength(1);
    const changed = entry('Yes', { context: 'Only for Swiss diplomas' });
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([changed]), context: context({ localAnswerEvidence: [confirmed] }) }).claims).toHaveLength(1);
  });

  it('keeps legacy partial QAs as evidence but never grants an exact full-contract shortcut', () => {
    const native = entry().nativeFormContract;
    const legacy = { question: { question: native.question, context: native.context, section: native.section, type: native.controlType,
      options: native.options, autocomplete: native.autocomplete, validation: native.validation }, answer: 'Yes', provenance: { actor: 'candidate' } };
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof(), context: context({ answerEvidence: [legacy] }) }).claims).toHaveLength(1);
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof(), context: context({ answerEvidence: [
      { ...legacy, answer: 'No' },
    ] }) }).failure).toBe('native_attested_refusal');
  });

  it('invalidates old-CV local qualification shortcuts without rejecting unrelated preferences', () => {
    const language = entry('C1', { label: 'What is your German level?' });
    const record = receipt(language.nativeFormContract, 'C1');
    record.provenance.cvHash = 'b'.repeat(64);
    const result = deriveNativeApplicationClaims({ targetVerified: true, proof: proof([language]), context: context({ localAnswerEvidence: [record] }) });
    expect(result.status).toBe('ready'); expect(result.claims).toHaveLength(1);
    expect(result.claims[0].policyAuthorityNeeded).toBeUndefined();
  });

  it('preserves conditional owned scope and rechecks a consent after new free-form notes', () => {
    const consentField = { label: 'I accept the privacy policy', kind: 'checkbox', inputType: 'checkbox', required: true,
      ownConsentText: ['I accept the privacy policy'], ownConsentQuestionLabels: ['I accept the privacy policy'], ownConsentLinks: [],
      ownConsentMetadataComplete: true, ownConsentQuestionOwned: true, ownConsentOwnerKey: JSON.stringify({ v: 1, scopes: [] }) };
    const consent = entry('Yes', consentField);
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([consent]), context: context() }).claims).toEqual([]);
    for (const authority of [null, { ...context().policyAuthority, paid: false },
      { ...context().policyAuthority, orderId: 'other-order' }, { ...context().policyAuthority, scopes: ['operational_preference'] }]) {
      const missingAuthority = deriveNativeApplicationClaims({ targetVerified: true, proof: proof([consent]), context: context({ policyAuthority: authority }) });
      expect(missingAuthority.claims[0].policyAuthorityNeeded?.purpose).toBe('application_consent');
    }
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([entry('Yes', { ...consentField,
      nativeOwnedScopes: [{ kind: 'group', names: ['I hold a university degree'], unknown: false }, ...scopes] })]), context: context() }).claims).toHaveLength(1);
    const newNotes = context({ localAnswerEvidence: [receipt(consent.nativeFormContract, 'Yes')],
      unverifiedContext: { flowNotes: 'I no longer consent to the Privacy Policy.' } });
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([consent]), context: newNotes }).claims).toHaveLength(1);
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([consent]), context: newNotes }).claims[0].policyAuthorityNeeded).toBeUndefined();
    const deferred = deriveNativeApplicationClaims({ targetVerified: true, proof: proof([consent]), context: context({
      unverifiedContext: { flowNotes: 'I no longer consent to the Privacy Policy.' },
    }) }).claims[0];
    expect(deferred.policyAuthorityNeeded).toEqual({ version: NATIVE_APPLICATION_POLICY_VERSION, purpose: 'application_consent' });
    expect(nativePolicyClaimAuthority(deferred)).toEqual(deferred.policyAuthorityNeeded);
    const factual = { ...entry('Yes'), policyAuthorityNeeded: deferred.policyAuthorityNeeded };
    expect(nativePolicyClaimAuthority(factual)).toBeNull();
    const unrelated = deriveNativeApplicationClaims({ targetVerified: true, proof: proof([consent]), context: context({
      unverifiedContext: { historicalContext: '3 months\nSwitzerland' },
    }) }).claims[0];
    expect(unrelated.policyAuthorityNeeded).toEqual(deferred.policyAuthorityNeeded);
    const sameSnapshot = receipt(consent.nativeFormContract, 'Yes');
    sameSnapshot.provenance.sourceCounterHash = 'd'.repeat(64);
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([consent]), context: context({
      localAnswerCounterHash: 'd'.repeat(64), localAnswerEvidence: [sameSnapshot], unverifiedContext: { flowNotes: 'Pre-existing noise' },
    }) }).claims).toEqual([]);
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([consent]), context: context({
      localAnswerCounterHash: 'e'.repeat(64), localAnswerEvidence: [sameSnapshot], unverifiedContext: { flowNotes: 'I no longer consent' },
    }) }).claims).toHaveLength(1);
    const identity = entry('test@example.invalid', { label: 'Your email', inputType: 'email' });
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([identity]), context: context({
      applicationIdentity: { email: 'test@example.invalid' }, unverifiedContext: { historicalContext: '3 months\nSwitzerland' },
    }) }).claims).toEqual([]);
  });

  it('requires real mandate authority for a default opt-out while retaining an explicit local No as primary', () => {
    const optional = entry('No', { label: 'I agree to receive the newsletter', kind: 'checkbox', inputType: 'checkbox', required: false,
      ownConsentText: ['I agree to receive the newsletter'], ownConsentQuestionLabels: ['I agree to receive the newsletter'], ownConsentLinks: [],
      ownConsentMetadataComplete: true, ownConsentQuestionOwned: true, ownConsentOwnerKey: JSON.stringify({ v: 1, scopes: [] }) });
    const unpaid = context({ policyAuthority: null });
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([optional]), context: unpaid }).claims[0].policyAuthorityNeeded?.purpose)
      .toBe('optional_consent_refusal');
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([optional]), context: {
      ...unpaid, localAnswerEvidence: [receipt(optional.nativeFormContract, 'No')],
    } }).claims).toEqual([]);
  });

  it('does not treat unchecked factual boxes with a hidden No as consent opt-outs', () => {
    const unchecked = entry('No', { label: 'I have a driving licence', kind: 'checkbox', inputType: 'checkbox',
      nativeUncheckedSubmission: { name: 'licence', value: 'No' } });
    const result = deriveNativeApplicationClaims({ targetVerified: true, proof: proof([unchecked]), context: context() });
    expect(result.status).toBe('ready');
    expect(result.claims[0].proposedAnswer).toBe('No');
  });

  it('holds unknown actual values even when empty or unchanged since an older proof', () => {
    const unknown = field({ nativeValueUnknown: true, value: '' });
    const policy = createNativeApplicationAnswerPolicy({ context: context() });
    expect(policy.needs(unknown, { action: 'fill', value: '' })).toBe(true);
    expect(() => policy.assertValue(unknown, { action: 'fill', value: '' })).toThrow('portal_qualification_evidence_unverified');
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([{ ...entry('', { required: false }), nativeValueUnknown: true }]), context: context() }).failure)
      .toBe('native_value_unverified');
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
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([entry('private-value', { label: 'Password', inputType: 'password' })]), context: context() }).failure)
      .toBe('credential_field_unverified');
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: { ...proof(), attachments: [{ fieldId: 'field', slot: 'cv', sha256: 'd'.repeat(64), size: 10 }] },
      context: context(), docsManifest: [{ slot: 'cv', sha256: 'd'.repeat(64), size: 10 }] }).status).toBe('unverified');
  });

  it('joins approved file bytes to one complete native control without treating a CV as a diploma', () => {
    const attachment = { fieldId: 'field', slot: 'cv', sha256: 'd'.repeat(64), size: 10 };
    const manifest = [{ slot: 'cv', sha256: attachment.sha256, size: 10, kind: 'diploma' }];
    const current = context({ documentsCurrent: true });
    const fileProof = { ...proof([entry('', { label: 'CV', kind: 'file', inputType: 'file', required: true })]), attachments: [attachment] };
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: fileProof, context: current, docsManifest: manifest }).coverage)
      .toEqual([{ ...attachment, kind: 'mechanical', exemption: 'approved_file_bytes' }]);
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: { ...fileProof,
      fields: [entry('', { label: 'Diploma', kind: 'file', inputType: 'file', required: true })] }, context: current, docsManifest: manifest }).failure)
      .toBe('native_attachment_purpose_unverified');
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: { ...fileProof,
      fields: [entry('', { label: 'CV', kind: 'file', inputType: 'file', required: true, context: 'Diploma required' })] }, context: current, docsManifest: manifest }).failure)
      .toBe('native_attachment_purpose_unverified');
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: fileProof, context: current, docsManifest: [...manifest, ...manifest] }).failure)
      .toBe('native_attachment_unverified');
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: fileProof, context: current, docsManifest: [{ ...manifest[0], sha256: 'e'.repeat(64) }] }).failure)
      .toBe('native_attachment_unverified');
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: fileProof, context: context(), docsManifest: manifest }).failure)
      .toBe('native_documents_stale');
    expect(deriveNativeApplicationClaims({ targetVerified: true, proof: proof([entry('', { label: 'Additional documents', kind: 'file', inputType: 'file', required: false })]), context: context() }).coverage)
      .toEqual([{ fieldId: 'field', kind: 'empty' }]);
  });

  it('accepts a diploma only through a freshly validated real server transport constructor', () => {
    const bytes = Buffer.from('test-uploaded-degree-bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const scope = { orderId: 'order-test', round: 1, jobId: 'job-test', sourceJobUrl: 'https://jobs.example/job/42/' };
    const target = { expectedApplyUrl: 'https://portal.example/apply/', frameUrl: 'https://portal.example/apply/', fieldId: 'field', multiple: false };
    const native = entry('', { label: 'degree certificates', kind: 'file', inputType: 'file', required: true,
      validation: { type: 'file', multiple: false } });
    const manifest = { slot: 'extra_1', documentId: 'diploma-test', fileId: 'file-test', generation: '1', sha256, size: bytes.length };
    const attachment = { fieldId: 'field', slot: manifest.slot, sha256, size: bytes.length };
    const inputs = { scope, target, nativeField: { ...native, frameUrl: target.frameUrl }, attachment: { ...attachment, ...manifest },
      documents: [{ ...manifest, assigned: true, scope, kind: 'diploma', requestedDocument: { id: manifest.documentId,
        label: 'degree certificates', kind: 'diploma', keywords: ['Diplom', 'degree certificate'] } }] };
    const constructed = resolveNativeDocumentTransport(inputs);
    expect(constructed.status).toBe('verified');
    if (!('attestation' in constructed)) throw new Error('fixture_transport_unverified');
    const verified = validateNativeDocumentTransport(constructed.attestation, inputs);
    const fullProof = { ...proof([native]), attachments: [attachment] };
    const request = { targetVerified: true, proof: fullProof, context: context({ documentsCurrent: false }), docsManifest: [manifest],
      verifiedDocumentTransports: [verified] };
    const result = deriveNativeApplicationClaims(request);
    expect(result.status).toBe('ready'); expect(result.claims).toEqual([]);
    expect(result.coverage[0].exemption).toBe('server_document_transport');
    expect(deriveNativeApplicationClaims({ ...request, verifiedDocumentTransports: [] }).failure).toBe('native_document_transport_unverified');
    expect(deriveNativeApplicationClaims({ ...request, verifiedDocumentTransports: [verified, verified] }).failure).toBe('native_document_transport_unverified');
    expect(deriveNativeApplicationClaims({ ...request, docsManifest: [{ ...manifest, generation: '2' }] }).failure).toBe('native_document_transport_unverified');
    const stale = validateNativeDocumentTransport(constructed.attestation, { ...inputs,
      documents: [{ ...inputs.documents[0], generation: '2' }] });
    expect(stale.status).toBe('unverified');
    expect(deriveNativeApplicationClaims({ ...request, verifiedDocumentTransports: [stale] }).failure).toBe('native_document_transport_unverified');
    expect(deriveNativeApplicationClaims({ ...request, proof: { ...fullProof, verifiedDocumentTransports: [verified] },
      verifiedDocumentTransports: [] }).failure).toBe('native_document_transport_unverified');
  });

  it('covers every file in an explicit native multiple set and applies the independent 82-file bound', () => {
    const scope = { orderId: 'order-test', round: 1, jobId: 'job-test', sourceJobUrl: 'https://jobs.example/job/42/' };
    const target = { expectedApplyUrl: 'https://portal.example/apply/', frameUrl: 'https://portal.example/apply/', fieldId: 'field', multiple: true };
    const native = entry('', { label: 'degree certificates', kind: 'file', inputType: 'file', required: true,
      validation: { type: 'file', multiple: true } });
    const requestedDocument = { id: 'diploma-test', label: 'degree certificates', kind: 'diploma', keywords: ['Diplom', 'degree certificate'] };
    for (const count of [2, 82, 83]) {
      const manifest = Array.from({ length: count }, (_, index) => {
        const bytes = Buffer.from(`degree-page-${index}`);
        return { slot: 'extra_1', documentId: requestedDocument.id, fileId: `file-${index}`, generation: '1',
          sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
      });
      const attachments = manifest.map(({ slot, sha256, size }) => ({ fieldId: 'field', slot, sha256, size }));
      const inputs = { scope, target, nativeField: { ...native, frameUrl: target.frameUrl }, attachment: { fieldId: 'field', files: manifest },
        documents: manifest.map(file => ({ ...file, assigned: true, scope, kind: 'diploma', requestedDocument })) };
      const constructed = resolveNativeDocumentTransport(inputs);
      expect(constructed.status).toBe('verified');
      if (!('attestation' in constructed)) throw new Error('fixture_transport_unverified');
      const verified = validateNativeDocumentTransport(constructed.attestation, inputs);
      const request = { targetVerified: true, proof: { ...proof([native]), attachments }, context: context({ documentsCurrent: false }),
        docsManifest: manifest, verifiedDocumentTransports: [verified] };
      const result = deriveNativeApplicationClaims(request);
      expect(result.status).toBe(count > 82 ? 'unverified' : 'ready');
      if (count <= 82) { expect(result.coverage).toHaveLength(1); expect(result.coverage[0].files).toHaveLength(count); }
      if (count === 2) {
        expect(deriveNativeApplicationClaims({ ...request, proof: { ...request.proof, attachments: [attachments[0]] } }).failure)
          .toBe('native_document_transport_unverified');
        expect(deriveNativeApplicationClaims({ ...request, proof: { ...request.proof, attachments: [attachments[0], attachments[0]] } }).failure)
          .toBe('native_attachment_ambiguous');
        expect(deriveNativeApplicationClaims({ ...request, proof: { ...request.proof, fields: [entry('', { label: 'degree certificates',
          kind: 'file', inputType: 'file', validation: { type: 'file', multiple: false } })] } }).failure).toBe('native_attachment_ambiguous');
        const alias = { ...manifest[0], slot: 'alias-slot' };
        expect(deriveNativeApplicationClaims({ ...request, docsManifest: [...manifest, alias], proof: { ...request.proof,
          attachments: [attachments[0], { ...attachments[0], slot: alias.slot }] } }).failure).toBe('native_document_transport_unverified');
      }
    }
  });
});
