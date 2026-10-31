/** Lightweight deterministic suite: node --test tests/native-document-transport.node.mjs */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeFormContract } from '../functions/src/lib/nativeFormContract.js';
import { resolveNativeDocumentTransport as resolve, validateNativeDocumentTransport as validate } from '../functions/src/lib/nativeDocumentTransport.js';

const clone = value => structuredClone(value);
function fixture() {
  const scope = { orderId: 'order-owned', round: 2, jobId: 'job-owned', sourceJobUrl: 'https://jobs.example/job/42' };
  const target = { expectedApplyUrl: 'https://apply.example/job/42', frameUrl: 'https://apply.example/job/42/form', fieldId: 'diploma-upload', multiple: false };
  const requestedDocument = { id: 'degree_certificates', label: 'degree certificates', kind: 'diploma', required: true,
    quote: 'degree certificates', keywords: ['degree certificates', 'degree certificate', 'diploma', 'Diplom', 'Abschlusszeugnis', 'diplôme', 'certificato di laurea'] };
  const file = { documentId: requestedDocument.id, fileId: 'stable-existing-file', sha256: 'a'.repeat(64), generation: '1720000000000001', size: 43821 };
  const nativeForm = nativeFormContract({ id: target.fieldId, label: 'degree certificates', kind: 'file', inputType: 'file', required: true,
    nativeMetadataComplete: true, nativeOwnedScopes: [{ kind: 'form', names: ['Application documents'], unknown: false }], validation: { type: 'file', multiple: false } });
  return { scope, target, nativeField: { fieldId: target.fieldId, frameUrl: target.frameUrl, nativeFormContract: nativeForm },
    attachment: { fieldId: target.fieldId, slot: 'extra_0', ...file },
    documents: [{ ...file, scope: clone(scope), kind: 'diploma', slot: 'extra_0', assigned: true, requestedDocument }] };
}
const denied = input => assert.equal(resolve(input).status, 'unverified');
const edit = (input, mutation) => { const changed = clone(input); mutation(changed); return changed; };

test('existing Italian degree certificate selected for the current request gets transport only, without reupload or new confirmation', () => {
  const input = fixture(); const result = resolve(input);
  assert.equal(result.status, 'verified');
  assert.equal(result.attestation.category, 'file_transport');
  assert.equal(result.attestation.provenance.actor, 'server');
  assert.equal(result.attestation.provenance.basis, 'current_server_document_assignment');
  assert.equal(result.attestation.documentId, 'degree_certificates');
  assert.equal(result.attestation.files[0].fileId, 'stable-existing-file');
  assert.deepEqual(result.attestation.purpose, { family: 'diploma', constraints: { educationalScope: 'university' } });
  for (const forbidden of ['clientCheck', 'verdict', 'candidateConfirmed', 'qualification', 'newUpload', 'recheckProof', 'text'])
    assert.equal(Object.hasOwn(result.attestation, forbidden), false);
  assert.deepEqual(validate(result.attestation, input), result);
  assert.deepEqual(input, fixture());
});

test('four closed native diploma captions use the same purpose classifier', () => {
  for (const question of ['Degree certificate', 'Certificato di laurea', 'Hochschuldiplom', 'Diplôme universitaire']) {
    const input = fixture(); input.nativeField.nativeFormContract.question = question;
    assert.equal(resolve(input).status, 'verified', question);
  }
});

test('current assigned membership is mandatory; advisory match and positional slot confer no authority', () => {
  for (const change of [x => x.documents = [], x => delete x.documents[0].assigned,
    x => x.documents[0].assigned = false, x => x.documents.push(clone(x.documents[0])),
    x => x.documents[0].slot = 'cv', x => x.attachment.slot = 'cv', x => x.documents[0].kind = 'cv',
    x => delete x.attachment.fileId, x => delete x.documents[0].fileId]) {
    const input = edit(fixture(), change); input.attachment.clientCheck = { verdict: 'match', version: 4 };
    denied(input);
  }
  const input = fixture(); input.attachment.slot = 'extra_77'; input.documents[0].slot = 'extra_77';
  assert.equal(resolve(input).status, 'verified'); // stable ids, never extra_N, carry the identity
});

test('current bytes and scope must agree with server assignment', () => {
  for (const change of [x => x.attachment.sha256 = 'b'.repeat(64), x => x.attachment.generation = '1720000000000002',
    x => x.attachment.size++, x => x.documents[0].scope.round++, x => x.documents[0].scope.orderId = 'other',
    x => x.documents[0].scope.jobId = 'other', x => x.documents[0].scope.sourceJobUrl += '/other']) denied(edit(fixture(), change));
});

test('native target, full contract and every owned qualifier are required', () => {
  for (const change of [x => x.nativeField.fieldId = 'other', x => x.nativeField.frameUrl += '/other',
    x => x.attachment.fieldId = 'other', x => delete x.target.expectedApplyUrl,
    x => delete x.nativeField.nativeFormContract.ownedScopes,
    x => x.nativeField.nativeFormContract.question = 'Degree certificate in medicine',
    x => x.nativeField.nativeFormContract.context = 'Degree certificate with grade 5',
    x => x.nativeField.nativeFormContract.ownedScopes[0].unknown = true,
    x => x.nativeField.nativeFormContract.ownedScopes[0].names = ['CV'],
    x => x.nativeField.nativeFormContract.validation.multiple = 'false']) denied(edit(fixture(), change));
});

test('request family, full qualifiers and stable document id cannot be discarded', () => {
  for (const change of [x => x.documents[0].requestedDocument.id = 'other',
    x => x.documents[0].requestedDocument.kind = 'reference',
    x => x.documents[0].requestedDocument.label = 'Certificate',
    x => x.documents[0].requestedDocument.keywords.push('CV'),
    x => x.documents[0].requestedDocument.keywords.push('Degree in medicine'),
    x => x.documents[0].requestedDocument.quote = 'Degree certificate with grade 5']) denied(edit(fixture(), change));
  const input = fixture(); input.documents[0].requestedDocument = { id: 'degree_certificates', label: 'Diploma', kind: 'diploma' };
  denied(input); // university scope required by native control, not inferred from generic diploma
});

test('receipt becomes stale after any current job, round, native target, request, byte or generation change', () => {
  const original = fixture(); const receipt = resolve(original).attestation;
  for (const change of [x => { x.scope.jobId = 'new-job'; x.documents[0].scope.jobId = 'new-job'; },
    x => { x.scope.round++; x.documents[0].scope.round++; },
    x => x.target.expectedApplyUrl += '/other',
    x => { x.target.fieldId = 'new-field'; x.nativeField.fieldId = 'new-field'; x.attachment.fieldId = 'new-field'; },
    x => { x.target.frameUrl += '/other'; x.nativeField.frameUrl = x.target.frameUrl; },
    x => x.nativeField.nativeFormContract.required = false,
    x => x.documents[0].requestedDocument.required = false,
    x => x.documents[0].requestedDocument.quote = 'Degree certificate',
    x => { x.documents[0].sha256 = 'b'.repeat(64); x.attachment.sha256 = 'b'.repeat(64); },
    x => { x.documents[0].generation = '1720000000000002'; x.attachment.generation = '1720000000000002'; }]) {
    const changed = edit(original, change);
    assert.equal(resolve(changed).status, 'verified');
    assert.equal(validate(receipt, changed).status, 'unverified');
  }
  assert.equal(validate({ ...receipt, clientCheck: { verdict: 'match' } }, original).status, 'unverified');
});

test('multiple control accepts only an explicit unique file set for the same server request', () => {
  const input = fixture(); input.target.multiple = true; input.nativeField.nativeFormContract.validation.multiple = true;
  denied(input); // scalar is not a server/native explicit set
  const first = input.attachment; const second = { ...clone(input.documents[0]), fileId: 'stable-existing-file-2', generation: '1720000000000003', sha256: 'b'.repeat(64) };
  input.documents.push(second);
  input.attachment = { fieldId: first.fieldId, files: [first, second] };
  assert.equal(resolve(input).status, 'verified');
  assert.equal(resolve(input).attestation.files.length, 2);
  const receipt = resolve(input).attestation;
  denied(edit(input, x => x.documents[1].requestedDocument.quote = 'Degree certificate'));
  input.attachment.files.reverse(); assert.equal(validate(receipt, input).status, 'verified');
  input.attachment.files.pop(); assert.equal(validate(receipt, input).status, 'unverified');
  denied(edit(input, x => x.attachment.files.push(clone(x.attachment.files[0]))));
  denied(edit(input, x => x.target.multiple = false));
});
