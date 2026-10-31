import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { nativeScopeView, createNativeScopeTools } from '../functions/src/lib/nativeScopeInterpretation.js';

function fixture(title = 'Sales consultant') {
  const field = { context: 'Recruitment source · ' + title, section: title,
    nativeMetadataComplete: true, nativeMetadataMissing: false, nativeContextIssuesComplete: true, nativeContextUnknown: true,
    nativeOwnedScopes: [{ kind: 'group', names: ['Additional data'], unknown: false }, { kind: 'group', names: [title], unknown: true }],
    nativeScopeIssues: [{ scopeIndex: 1, reason: 'unrecognized_shared_heading', nameIndex: 0, refsComplete: true },
      { scopeIndex: 1, reason: 'outside_native_form', refsComplete: true }], nativeContextIssues: [] };
  // This argument represents only the caller-owned Stage factory output. The
  // interpreter never derives it from a field, model answer or candidate DTO.
  const sourceAuthority = { sourceTitle: title, origin: 'https://jobs.example.com', directory: '/', jobKey: null,
    sourceUrl: 'https://jobs.example.com/apply/', urlSignature: '{"sourceUrl":"https://jobs.example.com/apply/"}',
    sourceFingerprint: '{"version":"native-application-target-fixture","authority":"private-stage-fixture"}' };
  return { field, sourceAuthority };
}

test('serializes the actual factory without relying on module lexical helpers', () => {
  const item = fixture();
  const source = '(' + createNativeScopeTools.toString() + ')().nativeScopeView(field, { sourceAuthority })';
  const serialized = runInNewContext(source, { Object, structuredClone, field: item.field, sourceAuthority: item.sourceAuthority });
  assert.equal(JSON.stringify(serialized), JSON.stringify(nativeScopeView(item.field, item)));
  const denied = runInNewContext(source, { Object, structuredClone, field: item.field, sourceAuthority: undefined });
  assert.equal(denied.status, 'unknown');
});

test('interprets only the structural title while preserving every raw unknown and qualifier', () => {
  const item = fixture(); const before = structuredClone(item.field);
  const result = nativeScopeView(item.field, item);
  assert.equal(result.status, 'interpreted');
  assert.equal(result.authorityKey, item.sourceAuthority.sourceFingerprint);
  assert.deepEqual(result.view.structuralScopeIndexes, [1]);
  assert.equal(result.view.structuralTitle, item.sourceAuthority.sourceTitle);
  assert.equal(result.view.section, '');
  assert.equal(result.view.context, 'Recruitment source');
  assert.equal(result.raw.context, item.field.context);
  assert.deepEqual(result.raw.ownedScopes, item.field.nativeOwnedScopes);
  assert.deepEqual(result.view.ownedScopes, item.field.nativeOwnedScopes);
  assert.equal(result.view.ownedScopes[1].unknown, true);
  assert.deepEqual(item.field, before);
  assert.equal(Object.hasOwn(result, 'self'), false);
  result.raw.ownedScopes[1].names.push('Changed after interpretation');
  assert.deepEqual(item.field, before);
});

test('matches full NFC and whitespace only, without case folding or substring matching', () => {
  const item = fixture('Conseillère commerciale');
  item.field.nativeOwnedScopes[1].names = ['  Conseille\u0300re\u00a0commerciale  '];
  item.field.section = 'Conseille\u0300re\ncommerciale';
  assert.equal(nativeScopeView(item.field, item).status, 'interpreted');
  for (const name of ['Conseillère', 'Conseillère commerciale chez Example', 'conseillère commerciale', 'Ｃonseillère commerciale']) {
    const field = structuredClone(item.field); field.nativeOwnedScopes[1].names = [name];
    assert.equal(nativeScopeView(field, item).status, 'unknown');
  }
});

test('does not remove a title substring from the section or own context', () => {
  const item = fixture(); item.field.section = 'Sales consultant · Qualifications';
  const result = nativeScopeView(item.field, item);
  assert.equal(result.status, 'interpreted');
  assert.equal(result.view.section, item.field.section);
  assert.equal(result.view.context, 'Recruitment source');
  assert.equal(result.raw.context, item.field.context);
});

test('neutralizes only an entire canonical context fragment already explained by the private heading', () => {
  const item = fixture();
  for (const fragment of ['Sales consultant extra', 'Required Sales consultant', 'Sales consultant qualification']) {
    item.field.context = 'Your email · ' + item.sourceAuthority.sourceTitle + ' · ' + fragment;
    const result = nativeScopeView(item.field, item);
    assert.equal(result.status, 'interpreted');
    assert.equal(result.view.context, 'Your email · ' + fragment);
    assert.equal(result.raw.context, item.field.context);
  }
  item.field.context = 'Your email Sales consultant';
  assert.equal(nativeScopeView(item.field, item).view.context, item.field.context);
  item.field.context = 'Your email · sales consultant';
  assert.equal(nativeScopeView(item.field, item).view.context, item.field.context);
});

test('does not use job-title vocabulary as candidate qualification evidence', () => {
  const item = fixture('Degree and work permit specialist');
  const result = nativeScopeView(item.field, item);
  assert.equal(result.status, 'interpreted');
  assert.deepEqual(result.view.structuralScopeIndexes, [1]);
  assert.equal(Object.hasOwn(result.view, 'candidateFacts'), false);
  assert.equal(Object.hasOwn(result.view, 'self'), false);
});

test('keeps ordinary complete metadata strict without interpreting known owners', () => {
  const item = fixture();
  item.field.nativeOwnedScopes[1] = { kind: 'form', names: ['Reference contact'], unknown: false };
  item.field.nativeContextUnknown = false; item.field.nativeScopeIssues = [];
  const result = nativeScopeView(item.field);
  assert.equal(result.status, 'strict');
  assert.equal(result.authorityKey, null);
  assert.deepEqual(result.view.structuralScopeIndexes, []);
  assert.deepEqual(result.view.ownedScopes, item.field.nativeOwnedScopes);
});

const mutations = {
  no_authority: item => { delete item.sourceAuthority; },
  field_authority_is_not_private: item => { item.field.sourceAuthority = item.sourceAuthority; delete item.sourceAuthority; },
  missing_fingerprint: item => { delete item.sourceAuthority.sourceFingerprint; },
  blank_fingerprint: item => { item.sourceAuthority.sourceFingerprint = ' '; },
  oversized_fingerprint: item => { item.sourceAuthority.sourceFingerprint = 'x'.repeat(131073); },
  missing_source_binding: item => { delete item.sourceAuthority.urlSignature; },
  wrong_title: item => { item.sourceAuthority.sourceTitle = 'Another vacancy'; },
  another_owner: item => { item.field.nativeOwnedScopes[1].names = ['Reference contact']; },
  additional_qualifier: item => { item.field.nativeOwnedScopes[1].names.push('Swiss work permit required'); },
  empty_unknown_owner: item => { item.field.nativeOwnedScopes[1].names = []; },
  unknown_without_cause: item => { item.field.nativeScopeIssues = []; },
  unexplained_other_scope: item => { item.field.nativeOwnedScopes.push({ kind: 'group', names: ['Foreign owner'], unknown: true }); },
  missing_metadata: item => { item.field.nativeMetadataMissing = true; },
  absent_missing_marker: item => { delete item.field.nativeMetadataMissing; },
  incomplete_reasons: item => { item.field.nativeContextIssuesComplete = false; },
  absent_reasons_complete: item => { delete item.field.nativeContextIssuesComplete; },
  truncated_metadata: item => { item.field.nativeMetadataComplete = false; },
  absent_metadata_complete: item => { delete item.field.nativeMetadataComplete; },
  unowned_prose: item => { item.field.nativeContextIssues = [{ reason: 'unowned_shared_prose', scopeIndex: null, text: 'A qualification not attributable to this control' }]; },
  bad_reference: item => { item.field.nativeScopeIssues[0].refsComplete = false; },
  absent_reference_proof: item => { delete item.field.nativeScopeIssues[0].refsComplete; },
  wrong_reason: item => { item.field.nativeScopeIssues[0].reason = 'missing_reference'; },
  wrong_scope_index: item => { item.field.nativeScopeIssues[0].scopeIndex = 100; },
  wrong_name_index: item => { item.field.nativeScopeIssues[0].nameIndex = 100; },
  unexpected_issue_property: item => { item.field.nativeScopeIssues[0].trusted = true; },
  unexpected_scope_property: item => { item.field.nativeOwnedScopes[1].self = true; },
  inconsistent_global_flag: item => { item.field.nativeContextUnknown = false; },
  absent_global_flag: item => { delete item.field.nativeContextUnknown; },
  missing_scope_graph: item => { delete item.field.nativeOwnedScopes; },
  absent_context_issues: item => { delete item.field.nativeContextIssues; },
  missing_context: item => { delete item.field.context; },
  missing_section: item => { delete item.field.section; },
  oversized_context: item => { item.field.context = 'x'.repeat(12001); },
  oversized_owner_graph: item => { item.field.nativeOwnedScopes = Array.from({ length: 33 }, () => ({ kind: 'group', names: [], unknown: false })); },
};
for (const [name, mutate] of Object.entries(mutations)) test('keeps unknown: ' + name, () => {
  const item = fixture(); mutate(item);
  const result = nativeScopeView(item.field, item);
  assert.equal(result.status, 'unknown'); assert.equal(result.view, null); assert.equal(result.authorityKey, null);
});

test('rejects uncloneable metadata without manufacturing a raw snapshot', () => {
  const item = fixture(); item.field.context = () => 'Not JSON metadata';
  assert.deepEqual(nativeScopeView(item.field, item), { status: 'unknown', view: null, raw: null, authorityKey: null });
});
