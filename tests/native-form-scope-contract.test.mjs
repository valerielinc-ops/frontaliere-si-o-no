import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nativeFormContract, rawNativeFormContract, rawNativeFieldFromContract,
  nativeFieldFromContract, nativePolicyField, nativePolicyContract,
} from '../functions/src/lib/nativeFormContract.js';
import { deriveNativeApplicationClaims } from '../functions/src/lib/nativeApplicationPolicy.js';
import { qualificationSources, verifyNativeFormAnswers } from '../functions/src/lib/qualificationEvidence.js';
import { typedNativeAnswerConstraint } from '../functions/src/lib/nativeAnswerConstraints.js';

// Only this private argument represents an already validated Stage source.
// The data-only decoder below does not construct or recover that authority.
const sourceAuthority = { sourceTitle: 'Engineer', urlSignature: '{"source":"https://jobs.example.invalid/apply"}',
  sourceFingerprint: '{"version":"scope-contract-private-source-fixture"}' };
function field(overrides = {}) {
  return { id: 'candidate-email', label: 'Your email', kind: 'text', inputType: 'email', name: 'email',
    context: '', section: 'Engineer', required: true, nativeMetadataComplete: true,
    nativeMetadataMissing: false, nativeContextIssuesComplete: true, nativeContextUnknown: true,
    nativeOwnedScopes: [{ kind: 'group', names: ['Personal data'], unknown: false },
      { kind: 'group', names: ['Engineer'], unknown: true }],
    nativeScopeIssues: [{ scopeIndex: 1, reason: 'outside_native_form', refsComplete: true }], nativeContextIssues: [],
    ...overrides };
}
const context = () => ({ scope: { orderId: 'scope-contract-fixture', round: 1, sourceAuthority },
  applicationIdentity: { email: 'candidate@example.invalid' }, answerEvidence: [], localAnswerEvidence: [], unverifiedContext: {} });
const proof = (native, answer = 'candidate@example.invalid') => ({ version: 'owner-native-proof-v1',
  frameUrl: 'https://jobs.example.invalid/apply', round: 1,
  fields: [{ fieldId: 'candidate-email', nativeFormContract: native, proposedAnswer: answer }], attachments: [] });

test('RAW preserves semantic uncertainty and a data-only decoder grants no ownership', () => {
  const current = field(); const before = structuredClone(current);
  const raw = rawNativeFormContract(current);
  assert.ok(raw); assert.equal(raw.ownershipUnknown, true);
  assert.deepEqual(raw.ownedScopes, current.nativeOwnedScopes);
  assert.deepEqual(raw.scopeIssues, current.nativeScopeIssues);
  assert.equal(raw.section, 'Engineer');
  assert.equal(nativeFormContract(current), null);
  assert.ok(rawNativeFieldFromContract(raw));
  assert.equal(nativeFieldFromContract(raw), null);
  assert.equal(nativePolicyContract(raw), null);
  assert.deepEqual(current, before);
  assert.ok(nativeFieldFromContract(raw, { sourceAuthority }));
  assert.deepEqual(nativeFormContract(current, { sourceAuthority }), raw);
  assert.equal(rawNativeFormContract(nativePolicyField(current, { sourceAuthority })).section, 'Engineer');
  assert.equal(nativePolicyContract(raw, { sourceAuthority }).section, '');
});

test('data-only decoding preserves actual file accept constraints', () => {
  const current = field({ id: 'file', label: 'Your CV', kind: 'file', inputType: 'file', name: 'cv',
    validation: { type: 'file', accept: '.pdf,application/pdf', multiple: false } });
  const raw = rawNativeFormContract(current);
  const decoded = rawNativeFieldFromContract(raw, { id: 'file' });
  assert.ok(decoded); assert.deepEqual(decoded.validation, current.validation);
  assert.deepEqual(rawNativeFormContract(decoded), raw);
  assert.equal(nativeFieldFromContract(raw), null);
});

test('capture failure, unresolved references, prose and a competing owner remain unknown', () => {
  for (const overrides of [
    { nativeMetadataMissing: true }, { nativeMetadataComplete: false }, { nativeContextIssuesComplete: false },
    { nativeScopeIssues: [{ scopeIndex: 1, reason: 'outside_native_form', refsComplete: false }] },
    { nativeContextIssues: [{ reason: 'unowned_shared_prose', scopeIndex: null, text: 'Reference contact only' }] },
    { nativeOwnedScopes: [field().nativeOwnedScopes[0], { kind: 'group', names: ['Engineer', 'Reference'], unknown: true }] },
    { section: 'Ｅngineer', nativeOwnedScopes: [field().nativeOwnedScopes[0], { kind: 'group', names: ['Ｅngineer'], unknown: true }] },
  ]) {
    const current = field(overrides);
    assert.equal(nativeFormContract(current, { sourceAuthority }), null);
    assert.equal(nativePolicyField(current, { sourceAuthority }), current);
  }
});

test('the interpreted structural heading supplies no SELF actor or candidate fact', () => {
  const raw = rawNativeFormContract(field());
  assert.equal(deriveNativeApplicationClaims({ proof: proof(raw), context: context(), targetVerified: true }).claims.length, 0);
  assert.equal(deriveNativeApplicationClaims({ proof: proof(raw), context: { ...context(), scope: { orderId: 'scope-contract-fixture', round: 1 } }, targetVerified: true }).status, 'unverified');
  const bare = rawNativeFormContract(field({ label: 'Email', nativeOwnedScopes: [{ kind: 'group', names: ['Engineer'], unknown: true }],
    nativeScopeIssues: [{ scopeIndex: 0, reason: 'outside_native_form', refsComplete: true }] }));
  assert.equal(deriveNativeApplicationClaims({ proof: proof(bare), context: context(), targetVerified: true }).claims.length, 1);
  const titled = rawNativeFormContract(field({ context: 'Personal data · Engineer' }));
  assert.equal(deriveNativeApplicationClaims({ proof: proof(titled), context: context(), targetVerified: true }).claims.length, 0);
  assert.equal(titled.context, 'Personal data · Engineer');
});

test('a real record-shaped full native answer uses the same scoped view without changing its RAW descriptor', () => {
  const raw = rawNativeFormContract(field({ label: 'Do you have a university degree?', kind: 'radio', inputType: 'radio',
    options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }] }));
  const claim = { fieldId: 'degree', nativeFormContract: raw, proposedAnswer: 'yes' };
  const record = { category: 'question_specific_text', scope: 'job', question: { question: raw.question,
    originalNativeContract: raw, description: 'Original server question descriptor' }, answer: true };
  const before = structuredClone(record);
  assert.equal(typedNativeAnswerConstraint(claim, record), 'unknown');
  assert.equal(typedNativeAnswerConstraint(claim, record, context().scope), 'supports');
  assert.equal(typedNativeAnswerConstraint(claim, { ...record, answer: false }, context().scope), 'contradicts');
  assert.deepEqual(record, before);
});

test('a semantic check still receives the entire RAW title, graph and quality flags', async () => {
  const raw = rawNativeFormContract(field({ label: 'Do you have a university degree?', kind: 'radio', inputType: 'radio',
    options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }] }));
  const derived = deriveNativeApplicationClaims({ proof: proof(raw, 'Yes'), context: context(), targetVerified: true });
  assert.equal(derived.status, 'ready'); assert.equal(derived.claims.length, 1);
  assert.deepEqual(derived.claims[0].nativeFormContract, raw);
  const calls = [];
  const generate = async (_system, user) => {
    const payload = JSON.parse(user); calls.push(payload);
    return payload.sourceColumns
      ? { assessments: [{ index: 0, sourceIds: [payload.sources[0][0]] }] }
      : { assessments: [{ index: 0, proofId: payload.claims[0].proof.id, verdict: 'uncertain', reason: 'ambiguous_evidence' }] };
  };
  const result = await verifyNativeFormAnswers({ claims: derived.claims,
    sources: qualificationSources({ sourceText: 'Bachelor degree in computer science.', purpose: 'native_form' }),
    scope: context().scope, generate });
  assert.equal(calls.length, 2); assert.equal(result.status, 'unverified');
  assert.deepEqual(calls[1].claims[0].nativeFormContract, raw);
  assert.ok(!JSON.stringify(calls).includes('scope-contract-private-source-fixture'));
});
