import { describe, expect, it, vi } from 'vitest';
import { nativeFormContract } from '../functions/src/lib/nativeFormContract.js';
import { nativePolicyAuthoritySource } from '../functions/src/lib/nativePolicyAuthority.js';
import { createNativeApplicationAnswerPolicy, nativePolicyClaimAuthority } from '../functions/src/lib/nativeApplicationPolicy.js';
import { qualificationSources, verifyNativeFormAnswers } from '../functions/src/lib/qualificationEvidence.js';

function fixture() {
  const authority = { version: 'server-application-policy-authority-v1', orderId: 'policy-fixture', round: 1,
    consentVersion: 'assisted-application-v2', consentedAt: Date.now() - 1000, paid: true,
    scopes: ['application_consent', 'optional_consent_refusal', 'operational_preference', 'individual_application_origin'],
    operationalPreferencesVersion: 'operational-preferences-v1' };
  const field = { id: 'agency', label: 'Are you applying through an agency?', kind: 'radio', inputType: 'radio', name: 'agency', required: true,
    nativeMetadataComplete: true, nativeOwnedScopes: [{ kind: 'form', names: ['Application'], unknown: false }],
    options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }] };
  const scope = { orderId: authority.orderId, round: 1 };
  const unverifiedContext = { historicalContext: '3 months\nSwitzerland' };
  const policy = createNativeApplicationAnswerPolicy({ context: { scope, policyAuthority: authority, unverifiedContext }, candidate: { identity: {} } });
  const claim = policy.claim(field, { action: 'fill', value: 'No' }, 'No');
  const sources = qualificationSources({ policyAuthority: authority, purpose: 'native_form' });
  const generate = vi.fn(async (_system: string, user: string) => {
    const data = JSON.parse(user);
    return data.sourceColumns ? { assessments: [{ index: 0, sourceIds: [data.sources.find((row: any[]) => row[1] === 'policy')[0]] }] }
      : { assessments: [{ index: 0, proofId: data.claims[0].proof.id, verdict: 'supported', reason: 'explicit_fact' }] };
  });
  return { authority, field, claim, sources, generate, scope, unverifiedContext };
}

describe('private native policy authority, never qualification evidence', () => {
  it('uses a real bound mandate for an independently checked policy answer despite unrelated history', async () => {
    const f = fixture();
    expect(f.claim.policyAuthorityNeeded).toEqual(nativePolicyClaimAuthority(f.claim));
    expect((await verifyNativeFormAnswers({ ...f, claims: [f.claim] })).status).toBe('supported');
    expect(f.generate).toHaveBeenCalledTimes(2);
    const judged = JSON.parse(f.generate.mock.calls[1][1]);
    expect(judged.claims[0].proof.quotes[0]).toMatchObject({ kind: 'policy_authority', policyRecord: { consentVersion: 'assisted-application-v2', paid: true } });
    expect(judged.claims[0].proof.quotes[0]).not.toHaveProperty('policyBinding');
    expect(JSON.stringify(f.generate.mock.calls)).not.toContain(f.authority.orderId);
    expect(qualificationSources({ policyAuthority: f.authority }).evidenceCatalog().some(source => source.kind === 'policy_authority')).toBe(false);
  });

  it.each(['order', 'round', 'qualification'])('rejects a policy source for %s before any provider call', async change => {
    const f = fixture();
    const scope = { ...f.scope, ...(change === 'order' ? { orderId: 'other-order' } : change === 'round' ? { round: 2 } : {}) };
    const claim = change === 'qualification' ? { ...f.claim,
      nativeFormContract: { ...nativeFormContract(f.field), question: 'Do you hold a university degree?' }, proposedAnswer: 'Yes' } : f.claim;
    expect((await verifyNativeFormAnswers({ ...f, scope, claims: [claim] })).status).toBe('unverified');
    expect(f.generate).not.toHaveBeenCalled();
  });

  it('preserves a contrary raw instruction as counter-evidence and fails closed when the blind verifier cannot resolve it', async () => {
    const f = fixture();
    const real = f.generate.getMockImplementation()!;
    f.generate.mockImplementation(async (...args) => {
      const raw = await real(...args);
      if (!JSON.parse(args[1]).sourceColumns) raw.assessments[0] = { ...raw.assessments[0], verdict: 'uncertain', reason: 'contradiction' };
      return raw;
    });
    const result = await verifyNativeFormAnswers({ ...f, claims: [f.claim], unverifiedContext: { candidateNotes: 'Do not apply through any agency' } });
    expect(result.status).toBe('unverified');
    expect(JSON.parse(f.generate.mock.calls[1][1]).unverifiedContext.candidateNotes).toBe('Do not apply through any agency');
  });

  it.each(['paid', 'consentVersion', 'consentedAt', 'scopes'])('does not construct authority with invalid %s', key => {
    const f = fixture();
    expect(nativePolicyAuthoritySource({ ...f.authority, [key]: key === 'paid' ? false : key === 'consentedAt' ? NaN : key === 'scopes' ? ['qualification'] : 'unknown-version' })).toBeNull();
  });
});


describe('changed local consent origin stays a primary candidate answer', () => {
  it('rechecks unrelated changed-origin notes with the original receipt and preserves a structured current No veto', async () => {
    const f = fixture();
    const field = { id: 'consent', label: 'I accept the privacy policy', kind: 'checkbox', inputType: 'checkbox', required: true,
      nativeMetadataComplete: true, nativeOwnedScopes: [{ kind: 'form', names: ['Application'], unknown: false }],
      ownConsentText: ['I accept the privacy policy'], ownConsentQuestionLabels: ['I accept the privacy policy'], ownConsentLinks: [],
      ownConsentMetadataComplete: true, ownConsentQuestionOwned: true, ownConsentOwnerKey: JSON.stringify({ v: 1, scopes: [] }) };
    const native = nativeFormContract(field);
    const receipt = { id: 'confirmation-' + 'a'.repeat(64), contractHash: 'b'.repeat(64), version: 'native-answer-confirmation-v1', category: 'local_answer', scope: 'job', unit: 'boolean',
      question: { originalNativeContract: native }, answer: true, provenance: { actor: 'candidate', orderId: f.scope.orderId, round: 1 } };
    const unverifiedContext = { flowNotes: 'Phone number updated.', answerSources: [{ answerIds: [receipt.id], changedSinceConfirmation: true, context: { flowNotes: 'Phone number updated.' } }] };
    const context = { scope: f.scope, policyAuthority: f.authority, localAnswerEvidence: [receipt], unverifiedContext };
    const policy = createNativeApplicationAnswerPolicy({ context });
    const claim = policy.claim(field, { action: 'check' }, 'Yes');
    expect(claim.policyAuthorityNeeded).toBeUndefined();
    const generate = vi.fn(async (_system: string, user: string) => {
      const data = JSON.parse(user);
      return data.sourceColumns ? { assessments: [{ index: 0, sourceIds: [data.sources.find((row: any[]) => row[1] === 'qa')[0]] }] }
        : { assessments: [{ index: 0, proofId: data.claims[0].proof.id, verdict: 'supported', reason: 'explicit_fact' }] };
    });
    const sources = qualificationSources({ localAnswerEvidence: [receipt], policyAuthority: f.authority, purpose: 'native_form' });
    expect((await verifyNativeFormAnswers({ claims: [claim], sources, scope: f.scope, unverifiedContext, generate })).status).toBe('supported');
    expect(JSON.parse(generate.mock.calls[1][1]).claims[0].proof.quotes[0]).toMatchObject({ kind: 'candidate_answer', answerRecord: { id: receipt.id, answer: true } });
    const refusal = createNativeApplicationAnswerPolicy({ context: { ...context, unverifiedContext: { ...unverifiedContext, values: { [receipt.id]: false } } } });
    expect(() => refusal.claim(field, { action: 'check' }, 'Yes')).toThrowError(expect.objectContaining({ reason: 'counter_context_unresolved' }));
  });
});
