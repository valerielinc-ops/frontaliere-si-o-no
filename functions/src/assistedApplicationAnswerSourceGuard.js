/** Private server-only source fence, evaluated in the same transaction as the irreversible send marker. */
import { createHash } from 'node:crypto';
import { canonicalQuestionJson } from './lib/applicationQuestionContract.js';
import { answerSourceRetained, currentAnswerReviewRequired } from './assistedApplicationAnswerConfirmation.js';
import { roundWasSent } from './assistedApplicationFlow.js';
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';

const selected = (source, fields) => Object.fromEntries(fields.map(field => [field, source?.[field] ?? null]));
const orderMaterial = order => selected(order, ['userId', 'jobId', 'jobUrl', 'cvStorageKey', 'cvUploadedAt', 'refundedAt', 'submissionStatus', 'submittedAt', 'retentionPurgingAt', 'retentionPurgedAt', 'talentPoolConsent', 'talentPoolConsentAt', 'talentPoolConsentWithdrawnAt']);
const flowMaterial = flow => ({ ...selected(flow, ['state', 'round', 'answers', 'questionAnswers', 'answerConfirmations', 'answerReviewRequired', 'formOverrides', 'feedback', 'retentionPurgedAt']),
  dispatch: selected(flow?.dispatch, ['mode', 'round', 'requestedAt']), roundWasSent: roundWasSent(flow) });
const draftMaterial = draft => selected(draft, ['status', 'round', 'questions', 'cvKey', 'sourceCvHash', 'channel', 'job']);
const profileMaterial = record => selected(record, ['applicationQuestionAnswers', 'applicationQuestionAnswerEvidence', 'applicationQuestionAnswersUpdatedAt']);

export function evidenceSourceChanged() {
  const error = new Error('evidence_source_changed'); error.code = 'evidence_source_changed'; return error;
}

export function createAnswerSourceGuard({ db, orderId, order, flow, draft, intake, profileRef, profileRecord, sources = [], nowMs = Date.now() }) {
  const orderRef = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId);
  const dependencies = new Map();
  const add = (ref, data, material, retention = false) => dependencies.set(ref.path, {
    ref, expected: canonicalQuestionJson(material(data)), material, retention,
  });
  // Exact source snapshots are already loaded by the evidence validator, not re-inferred from a destination child.
  for (const { ref, data } of sources) {
    const material = ref.path.endsWith('/automation/flow') ? flowMaterial : ref.path.endsWith('/ai_drafts/current') ? draftMaterial : orderMaterial;
    add(ref, data, material, material === orderMaterial);
  }
  if (profileRef) add(profileRef, profileRecord, profileMaterial);
  add(orderRef, order, orderMaterial, true);
  add(orderRef.collection('automation').doc('flow'), flow, flowMaterial);
  add(orderRef.collection('ai_drafts').doc('current'), draft, draftMaterial);
  add(orderRef.collection('automation').doc('intake'), intake, value => value ?? null);
  const expected = [...dependencies.values()].sort((a, b) => a.ref.path.localeCompare(b.ref.path));
  // At most 80 distinct evidence sources, three documents each, plus the current context and profile.
  if (expected.length > 245) throw evidenceSourceChanged();
  const startedAt = Date.now();
  return Object.freeze({
    fingerprint: createHash('sha256').update(canonicalQuestionJson(expected.map(dep => ({ path: dep.ref.path, expected: dep.expected })))).digest('hex'),
    async assertInTransaction(transaction) {
      const current = await Promise.all(expected.map(dep => transaction.get(dep.ref)));
      const now = nowMs + Math.max(0, Date.now() - startedAt);
      for (let i = 0; i < expected.length; i++) {
        const dep = expected[i]; const data = current[i].data();
        if (canonicalQuestionJson(dep.material(data)) !== dep.expected || dep.retention && !answerSourceRetained(data, now)) throw evidenceSourceChanged();
      }
      if (currentAnswerReviewRequired(flow, draft || {})) throw evidenceSourceChanged();
    },
  });
}
