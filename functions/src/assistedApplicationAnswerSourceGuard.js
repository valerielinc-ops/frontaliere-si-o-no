import { timestampMillis } from './lib/assistedApplicationRetentionPolicy.js';
/** Private server-only source fence, evaluated in the same transaction as the irreversible send marker. */
import { createHash } from 'node:crypto';
import { canonicalQuestionJson, answerQuestionDescriptor } from './lib/applicationQuestionContract.js';
import { answerSourceRetained, currentAnswerReviewRequired } from './assistedApplicationAnswerConfirmation.js';
import { roundWasSent } from './assistedApplicationFlow.js';
import { qualificationCounterContext } from './lib/qualificationCounterContext.js';
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';
import { buildFillKit } from './assistedApplicationFillKit.js';
import { cvToSend } from './assistedApplicationDocxInPlace.js';
import { extraDocumentsToSend, requiredDocumentsOf } from './assistedApplicationExtraDocuments.js';

const selected = (source, fields) => Object.fromEntries(fields.map(field => [field, source?.[field] ?? null]));
const orderMaterial = order => ({ ...selected(order, ['paymentStatus', 'refundStatus', 'consentVersion', 'withdrawnAt', 'candidateNotes', 'userId', 'jobId', 'jobUrl', 'jobTitle', 'cvStorageKey', 'cvUploadedAt', 'refundedAt', 'submissionStatus', 'submittedAt', 'retentionPurgingAt', 'retentionPurgedAt', 'talentPoolConsent', 'talentPoolConsentAt', 'talentPoolConsentWithdrawnAt']), consentedAt: timestampMillis(order?.consentedAt) });
const flowMaterial = flow => ({ ...selected(flow, ['candidateNotes', 'state', 'round', 'answers', 'questionAnswers', 'answerConfirmations', 'answerReviewRequired', 'formOverrides', 'feedback', 'retentionPurgedAt']),
  dispatch: selected(flow?.dispatch, ['mode', 'round', 'requestedAt']), roundWasSent: roundWasSent(flow) });
const draftMaterial = draft => selected(draft, ['status', 'round', 'questions', 'cvKey', 'sourceCvHash', 'qualificationCvLanguageProfile', 'channel', 'job']);
const profileMaterial = record => selected(record, ['applicationQuestionAnswers', 'applicationQuestionAnswerEvidence', 'applicationQuestionAnswersUpdatedAt']);
// Finishing the origin application does not revoke an unchanged personal fact.
// Its current retention is checked separately, rather than freezing an operational anchor/status.
const sourceOrderMaterial = order => selected(order, ['userId', 'jobId', 'jobUrl', 'cvStorageKey', 'candidateNotes', 'retentionPurgingAt', 'retentionPurgedAt', 'talentPoolConsent']);

/** Hash the actual deterministic read model and attachment identities, never expiring signed URLs. */
function currentKitMaterial({ orderId, order = {}, flow = {}, draft = {} }) {
  const kit = buildFillKit({ orderId, order: order || {}, flow: flow || {}, draft: draft || {} });
  return { identity: kit.identity, profile: kit.profile, answers: kit.answers, texts: kit.texts,
    job: kit.job, language: kit.language, applyUrl: kit.applyUrl, channelType: kit.channelType,
    cv: cvToSend(draft, flow, order), letterKey: draft?.coverLetterPdfKey || null,
    requiredDocuments: requiredDocumentsOf(draft), documentContracts: draft?.requiredDocuments || [],
    documentRecords: Object.fromEntries(extraDocumentsToSend(draft, flow, orderId).map(document => [document.id, flow?.documents?.[document.id] || null])),
    extra: extraDocumentsToSend(draft, flow, orderId).map(document => ({ slot: document.slot, kind: document.kind,
      files: document.files.map(file => ({ key: file.key, detectedType: file.detectedType })) })) };
}

export function evidenceSourceChanged() {
  const error = new Error('evidence_source_changed'); error.code = 'evidence_source_changed'; return error;
}

export function createAnswerSourceGuard({ db, orderId, order, flow, draft, intake, profileRef, profileRecord, sources = [], nowMs = Date.now(), sourceOnly = false }) {
  const orderRef = sourceOnly ? null : db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId);
  const dependencies = new Map();
  const add = (ref, data, material, retention = false) => dependencies.set(ref.path, {
    ref, expected: canonicalQuestionJson(material(data)), material, retention,
  });
  // Exact source snapshots are already loaded by the evidence validator, not re-inferred from a destination child.
  for (const { ref, data } of sources) {
    const originId = ref.path.split('/')[1];
    const questionIds = new Set(Object.values(profileRecord.applicationQuestionAnswerEvidence || {})
      .filter(record => record?.provenance?.orderId === originId).map(record => record?.question?.id || record?.provenance?.questionId).filter(Boolean));
    const sourceFlowMaterial = value => ({ ...selected(value, ['round', 'formOverrides', 'feedback', 'candidateNotes', 'retentionPurgingAt', 'retentionPurgedAt']),
      answers: Object.fromEntries([...questionIds].map(id => [id, value?.answers?.[id] ?? null])),
      answerConfirmations: Object.fromEntries([...questionIds].map(id => [id, value?.answerConfirmations?.[id] ?? null])) });
    const sourceDraftMaterial = value => ({ ...selected(value, ['round', 'cvKey', 'sourceCvHash']),
      applyUrl: String(value?.channel?.applyUrl || value?.job?.applyUrl || ''),
      questions: (Array.isArray(value?.questions) ? value.questions : []).filter(question => questionIds.has(question?.id)).map(answerQuestionDescriptor).sort((a, b) => String(a?.id || '').localeCompare(String(b?.id || ''))) });
    const material = ref.path.endsWith('/automation/flow') ? sourceFlowMaterial : ref.path.endsWith('/ai_drafts/current') ? sourceDraftMaterial
      : ref.path.endsWith('/automation/intake') ? value => value ?? null : sourceOrderMaterial;
    add(ref, data, material, material === sourceOrderMaterial);
  }
  if (profileRef) add(profileRef, profileRecord, profileMaterial);
  if (!sourceOnly) {
    add(orderRef, order, orderMaterial, true);
    add(orderRef.collection('automation').doc('flow'), flow, flowMaterial);
    add(orderRef.collection('ai_drafts').doc('current'), draft, draftMaterial);
    add(orderRef.collection('automation').doc('intake'), intake, value => value ?? null);
  }
  const expected = [...dependencies.values()].sort((a, b) => a.ref.path.localeCompare(b.ref.path));
  const expectedCounterContext = sourceOnly ? null : canonicalQuestionJson(qualificationCounterContext({ order, flow, intake }));
  const expectedKitMaterial = sourceOnly ? null : canonicalQuestionJson(currentKitMaterial({ orderId, order, flow, draft }));
  // At most 80 distinct evidence sources, four documents each, plus the current context and profile.
  if (expected.length > 325) throw evidenceSourceChanged();
  const startedAt = Date.now();
  return Object.freeze({
    fingerprint: createHash('sha256').update(canonicalQuestionJson({ version: 'answer-source-frame-v2',
      dependencies: expected.map(dep => ({ path: dep.ref.path, expected: dep.expected })), counterContext: expectedCounterContext, kitMaterial: expectedKitMaterial })).digest('hex'),
    async assertInTransaction(transaction) {
      const current = await Promise.all(expected.map(dep => transaction.get(dep.ref)));
      const now = nowMs + Math.max(0, Date.now() - startedAt);
      for (let i = 0; i < expected.length; i++) {
        const dep = expected[i]; const data = current[i].data();
        if (canonicalQuestionJson(dep.material(data)) !== dep.expected || dep.retention && !answerSourceRetained(data, now)) throw evidenceSourceChanged();
      }
      if (!sourceOnly) {
        const currentData = new Map(expected.map((dep, i) => [dep.ref.path, current[i].data()]));
        const counterContext = qualificationCounterContext({ order: currentData.get(orderRef.path),
          flow: currentData.get(orderRef.collection('automation').doc('flow').path),
          intake: currentData.get(orderRef.collection('automation').doc('intake').path) });
        if (canonicalQuestionJson(counterContext) !== expectedCounterContext) throw evidenceSourceChanged();
        if (canonicalQuestionJson(currentKitMaterial({ orderId, order: currentData.get(orderRef.path),
          flow: currentData.get(orderRef.collection('automation').doc('flow').path),
          draft: currentData.get(orderRef.collection('ai_drafts').doc('current').path) })) !== expectedKitMaterial) throw evidenceSourceChanged();
        if (currentAnswerReviewRequired(flow, draft || {})) throw evidenceSourceChanged();
      }
      // Serialization itself can cross a deadline. No awaited work follows this final clock check.
      const finalNow = nowMs + Math.max(0, Date.now() - startedAt);
      for (let i = 0; i < expected.length; i++) if (expected[i].retention && !answerSourceRetained(current[i].data(), finalNow)) throw evidenceSourceChanged();
    },
  });
}

/** Proposal publication/cache admission uses fact dependencies, without a destination send authority. */
export function createCandidateAnswerSourceGuard(input) {
  return createAnswerSourceGuard({ ...input, sourceOnly: true });
}
