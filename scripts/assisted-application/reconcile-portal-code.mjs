/** Queue certainly unsent technical holds once per published portal-engine version. */
import { createHash } from 'node:crypto';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { currentPortalCodeVersion } from './lib/portal-code-version.mjs';
import { evaluateRedFlags, roundWasSent, transition } from '../../functions/src/assistedApplicationFlow.js';
import { loadRunnerAnswerContext } from '../../functions/src/assistedApplicationAnswerEvidence.js';
import { candidateQuestionAnswerKey, candidateWithEdits, ORDER_QUESTION_ANSWER_EVIDENCE_VERSION, rememberCandidateQuestionAnswers } from '../../functions/src/assistedApplicationCandidateEdits.js';
import { isFetchablePublicUrl } from '../../functions/src/assistedApplicationAiJob.js';
import { operationalQuestionTopic } from '../../functions/src/assistedApplicationOperationalAnswers.js';
import { AUTOMATION_FLAG_KEY, parseAutomationFlag } from '../../functions/src/assistedApplicationAutomationFlag.js';
import { retentionPurgeDueAt, talentPoolConsentActive } from '../../functions/src/assistedApplicationRetention.js';
import { getRemoteConfig } from 'firebase-admin/remote-config';
import { PORTAL_NATIVE_CONTRACT_VERSION } from '../../functions/src/lib/portalNativeContract.js';
import { portalCodeVersion, portalIdentityQuestionDefinitelyUnsent, portalQuestionHoldsDefinitelyUnsent, portalRecoveryDefinitelyUnsent,
  operationalPortalRecoveryReady } from '../../functions/src/assistedApplicationPortalRecoveryPolicy.js';
import { portalAutoRetryAttemptsRemaining, portalExhaustedRecoveryPending } from '../../functions/src/assistedApplicationPortalRetryPolicy.js';
import './extension/apply-control.js';
import { candidateAnswerForField, isIdentityEmailConfirmationField } from './lib/portal/plan.mjs';
import { portalQuestionDocumentSlotKind } from './lib/portal/portal.mjs';

const hasAnswer = value => typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
  || typeof value === 'string' && value.trim().length > 0 || Array.isArray(value) && value.some(item => String(item ?? '').trim());
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const canonicalUrl = value => { try { return new URL(String(value || '')).href; } catch { return ''; } };

/**
 * Match answers belong to this approved draft, not to the cross-order answer
 * ledger. Preserve an explicit same-order value for recovery even when the
 * trusted evidence projection intentionally omits it; the recovery policy
 * validates the exact question and value before it can schedule anything.
 */
function explicitMatchAnswers({ draft, flow }) {
  const answers = object(flow?.answers);
  return Object.fromEntries((Array.isArray(draft?.questions) ? draft.questions : [])
    .filter(question => question?.source === 'match' && typeof question.id === 'string'
      && hasAnswer(answers[question.id]))
    .map(question => [question.id, answers[question.id]]));
}

function identityEmailConfirmationAnswer({ order, draft, flow, nowMs }) {
  if (flow?.state !== 'needs_candidate_action' || flow?.heldBy?.length !== 1) return null;
  const heldId = String(flow.heldBy[0] || '').replace(/^question:/, '');
  if (!heldId || flow.heldBy[0] !== `question:${heldId}`) return null;
  const matches = (Array.isArray(draft?.questions) ? draft.questions : []).filter(question => question?.id === heldId);
  if (matches.length !== 1) return null;
  const question = matches[0];
  const questionType = String(question.type || '').trim().toLowerCase();
  if (question.source !== 'portal' || question.required !== true || !['text', 'email', 'email_address'].includes(questionType)) return null;
  const label = [question.applicationQuestion, question.question].filter(Boolean).join(' ').trim();
  const field = { id: heldId, kind: 'text', label, context: String(question.context || ''), section: String(question.section || ''),
    autocomplete: String(question.autocomplete || ''), required: true, options: [] };
  if (!isIdentityEmailConfirmationField(field)) return null;
  const candidate = candidateWithEdits({ order, draft, flow });
  const email = String(candidate.identity?.email || '').trim();
  const answer = candidateAnswerForField(candidate, field);
  if (!email || answer?.source !== 'identity' || String(answer.value || '').trim() !== email) return null;
  const resumedFlow = { ...flow, answers: { ...object(flow.answers), [heldId]: email } };
  const tick = transition(resumedFlow, { type: 'tick' }, {
    order, draft, answers: resumedFlow.answers, documents: flow.documents || {}, nowMs,
  });
  if (!tick.effects.some(effect => effect.type === 'dispatch' && effect.mode === 'submit'
    && effect.reason === 'resolved_candidate_answers')) return null;
  return { questionId: heldId, email };
}

/** The question ids of a wait made only of question holds, in their order; [] for any other hold. */
function heldQuestionIds(flow) {
  const holds = Array.isArray(flow?.heldBy) ? flow.heldBy : [];
  const ids = holds.map(held => /^question:(.+)$/s.exec(String(held || ''))?.[1] || '');
  return ids.length && ids.every(Boolean) ? ids : [];
}

// A resumed wait that comes back on the same questions in the same round is resumed again at most this many
// times, whatever the number of engine versions published in between: each comeback costs the candidate
// another «we need you» e-mail.
export const PORTAL_QUESTION_RECOVERY_MAX = 2;
const questionHoldKey = (round, ids) => createHash('sha256').update(JSON.stringify([Number(round) || 1, [...ids].sort()]))
  .digest('hex').slice(0, 32);

// The runner attaches the CV and the cover letter it has; a slot for a document the order lacks stays a request.
// An upload slot takes the letter's PDF (the runner uploads `coverLetterPdfKey`, never the bare text); only a
// text slot can take the letter's text.
const DOCUMENT_ON_FILE = {
  cv: ({ order, draft }) => Boolean(String(order?.cvStorageKey || draft?.cvKey || '').trim()),
  cover_letter: ({ draft, question }) => Boolean(String(draft?.coverLetterPdfKey || '').trim()
    || (String(question?.type || 'text').trim().toLowerCase() !== 'file' && String(draft?.coverLetter || '').trim())),
};

/**
 * The portal questions a round waits on, read again with the current code. Each one is either answered now
 * (a platform rule, the CV, the decision engine or a confirmed answer: evaluateRedFlags projects them all
 * through operationalDefaultAnswer) or the empty document slot the runner now fills with the CV or the letter
 * (portalQuestionDocumentSlotKind). Only when every held question is, and the flow's own tick would then
 * resume the submission (`resolved_candidate_answers`), the resolution is returned; any real question left
 * keeps the whole wait with the candidate (null). Slots become optional in the returned questions, with the
 * engine version that decided it.
 */
export function portalQuestionsResolvedByCode({ order, draft, flow, answerFlow = flow, version, nowMs }) {
  const ids = heldQuestionIds(flow);
  if (!ids.length || flow?.state !== 'needs_candidate_action' || Number(draft?.round) !== (Number(flow.round) || 1)) return null;
  const questions = Array.isArray(draft?.questions) ? draft.questions : [];
  const held = ids.map(id => questions.filter(question => question?.id === id));
  if (held.some(matches => matches.length !== 1 || matches[0].source !== 'portal')) return null;
  const answers = object(answerFlow?.answers);
  const documents = flow.documents || {};
  const flags = evaluateRedFlags(draft, answers, documents, answerFlow?.questionAnswers, answerFlow, order);
  if (flags.owner.length || flags.documents.length) return null;
  const slots = new Map();
  for (const [question] of held) {
    if (!flags.candidate.includes(question.id)) continue;
    const kind = portalQuestionDocumentSlotKind(question);
    if (!kind || !DOCUMENT_ON_FILE[kind]({ order, draft, question })) return null;
    slots.set(question.id, kind);
  }
  const nextQuestions = slots.size ? questions.map(question => slots.has(question.id)
    ? { ...question, required: false, portalDocumentSlot: { kind: slots.get(question.id), version } } : question) : null;
  const nextDraft = nextQuestions ? { ...draft, questions: nextQuestions } : draft;
  const tick = transition(answerFlow, { type: 'tick' }, { order, draft: nextDraft, answers, documents, nowMs });
  if (!tick.effects.some(effect => effect.type === 'dispatch' && effect.mode === 'submit'
    && effect.reason === 'resolved_candidate_answers')) return null;
  return { questionIds: ids, slots: [...slots].map(([id, kind]) => ({ id, kind })), questions: nextQuestions };
}

function hasCurrentNativePortalContract(draft) {
  const applyUrl = canonicalUrl(draft?.channel?.applyUrl || draft?.job?.applyUrl);
  return (Array.isArray(draft?.questions) ? draft.questions : []).some(question => {
    const proof = question?.portalNativeContract;
    return question?.source === 'portal' && proof?.version === PORTAL_NATIVE_CONTRACT_VERSION
      && canonicalUrl(proof.url) === applyUrl && Number(proof.round) === Number(draft?.round)
      && Number(proof.observedAt) > 0 && proof.frame === 0 && Number.isInteger(proof.form)
      && typeof proof.fieldId === 'string' && proof.fieldId.trim().length > 0;
  });
}

function hasUntrustedProfileOperationalAnswers({ profile, draft }) {
  const profileAnswers = object(profile?.applicationQuestionAnswers);
  return (Array.isArray(draft?.questions) ? draft.questions : []).some(question => {
    if (!operationalQuestionTopic(question)) return false;
    const key = candidateQuestionAnswerKey(question);
    return hasAnswer(profileAnswers[question.id]) || hasAnswer(key && profileAnswers[key]);
  });
}

function canRediscoverUnreadablePortalQuestions(flow, draft, flags) {
  if (flow?.heldBy?.length !== 1 || flow.heldBy[0] !== 'portal:question_label_unreadable'
    || !flags.candidate.length) return false;
  const portalQuestionIds = new Set((Array.isArray(draft?.questions) ? draft.questions : [])
    .filter(question => question?.source === 'portal' && question.required === true)
    .map(question => String(question.id || '').trim()).filter(Boolean));
  return flags.candidate.every(id => portalQuestionIds.has(String(id)));
}

export async function reconcilePortalCode({ db, version, apply = false, nowMs = Date.now(), isEnabled = null }) {
  if (!portalCodeVersion(version)) throw new Error('invalid_portal_code_version');
  if (!isEnabled) {
    // The script's Admin SDK owns the app initialized by getFirestoreDb.
    // A Functions SDK installed beside it has a separate app registry.
    const template = await getRemoteConfig().getTemplate();
    const flag = parseAutomationFlag(template.parameters?.[AUTOMATION_FLAG_KEY]?.defaultValue?.value);
    isEnabled = id => flag.all || flag.orders.has(id);
  }
  const summary = { scanned: 0, eligible: 0, queued: 0, identityQuestionsQueued: 0, questionHoldsQueued: 0, apply };
  let cursor;
  do {
    let query = db.collection('assisted_applications').where('automationState', 'in', ['owner_takeover', 'needs_candidate_action'])
      .orderBy('__name__').limit(100);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const doc of page.docs) {
      summary.scanned++;
      if (!(await isEnabled(doc.id))) continue;
      const eligible = await db.runTransaction(async transaction => {
        const flowRef = doc.ref.collection('automation').doc('flow');
        const submissionRef = doc.ref.collection('automation').doc('submission');
        const draftRef = doc.ref.collection('ai_drafts').doc('current');
        const [orderDoc, flowDoc, draftDoc, submissionDoc] = await Promise.all([
          transaction.get(doc.ref), transaction.get(flowRef), transaction.get(draftRef),
          transaction.get(submissionRef),
        ]);
        const order = orderDoc.data(); const flow = flowDoc.data(); const draft = draftDoc.data();
        const profileDoc = order?.userId
          ? await transaction.get(db.collection('user_cv_profiles').doc(order.userId))
          : null;
        const submission = submissionDoc.data() || {};
        const receipt = submission.portalCodeRecovery;
        const identityAnswer = identityEmailConfirmationAnswer({ order, draft, flow, nowMs });
        const identityQuestionReady = Boolean(identityAnswer && isFetchablePublicUrl(draft.channel?.applyUrl || draft.job?.applyUrl)
          && portalIdentityQuestionDefinitelyUnsent({ order, flow, draft, submission, version,
            questionId: identityAnswer.questionId, identityQuestionReady: true, approvedRound: roundWasSent(flow),
            retentionAllowed: talentPoolConsentActive(order) || retentionPurgeDueAt(order) > nowMs,
            receiptVersion: receipt?.version }));
        // Any other wait on portal questions only: the current code may answer them, or know them for the
        // document slots they are. It is decided below, once the verified answers are loaded.
        const questionHoldIds = identityQuestionReady ? [] : heldQuestionIds(flow);
        const questionHoldsReady = questionHoldIds.length > 0
          && isFetchablePublicUrl(draft?.channel?.applyUrl || draft?.job?.applyUrl) && !portalExhaustedRecoveryPending(flow)
          && portalQuestionHoldsDefinitelyUnsent({ order, flow, draft, submission, version, questionIds: questionHoldIds,
            approvedRound: roundWasSent(flow), retentionAllowed: talentPoolConsentActive(order) || retentionPurgeDueAt(order) > nowMs,
            receiptVersion: receipt?.version });
        const ownerRecoveryReady = portalRecoveryDefinitelyUnsent({ order, flow, draft, submission, version });
        if ((!ownerRecoveryReady && !identityQuestionReady && !questionHoldsReady) || !roundWasSent(flow) || flow.postingExpiredAt) return false;
        if (flow.heldBy[0] === 'portal:portal_needs_candidate'
          && !talentPoolConsentActive(order) && !(retentionPurgeDueAt(order) > nowMs)) return false;
        // A source-version change may make a previously blocked portal
        // technically recoverable. After the normal two-attempt ladder, allow
        // one repair attempt only when this application has never consumed the
        // bounded exhausted-budget repair marker. The marker is written in the
        // same transaction as the queue and prevents repeated deployments from
        // resubmitting one application indefinitely.
        // A wait on questions is not a portal retry: like the candidate's own answer, it does not spend
        // the portal budget, and its own bound is PORTAL_QUESTION_RECOVERY_MAX.
        if (!identityQuestionReady && !questionHoldsReady && !portalAutoRetryAttemptsRemaining(flow) && flow.portalExhaustedRecoveryVersion) {
          // A queued repair is already the one permitted dispatch. A later
          // source version must not erase its due time before the scheduler
          // consumes it; only an exhausted, unqueued marker is retired here.
          if (apply && portalExhaustedRecoveryPending(flow)) {
            const queuedDueAt = Number(flow.portalAutoRetryAt) || 0;
            // A legacy scheduler may have cleared only the parent due time
            // while rejecting the exhausted marker. Restore that trigger from
            // the still-pending flow, without minting a second repair.
            if (queuedDueAt > 0 && !(Number(order?.automationDueAt) > 0)) {
              transaction.set(doc.ref, { automationDueAt: queuedDueAt, automationUpdatedAt: new Date(nowMs) }, { merge: true });
            }
          } else if (apply) {
            transaction.set(flowRef, { portalRecoveryVersion: version, portalAutoRetryAt: null, updatedAt: nowMs }, { merge: true });
            transaction.set(doc.ref, { automationDueAt: null, automationUpdatedAt: new Date(nowMs) }, { merge: true });
          }
          return false;
        }
        const answerContext = await loadRunnerAnswerContext({ db, orderId: doc.id, order, flow, draft, nowMs,
          profileRecord: profileDoc?.data() || {}, getDocument: ref => transaction.get(ref) });
        if (questionHoldsReady) {
          // Only verified answers count, as in the sweep's own tick (applyAutomationEvent).
          const resolution = portalQuestionsResolvedByCode({ order, draft, flow, answerFlow: answerContext.flow, version, nowMs });
          if (!resolution) return false;
          const round = Number(flow.round) || 1;
          const key = questionHoldKey(round, resolution.questionIds);
          const prior = submission.portalQuestionRecovery;
          const attempts = prior?.key === key ? Number(prior.attempts) || 0 : 0;
          if (attempts >= PORTAL_QUESTION_RECOVERY_MAX) return false;
          if (apply) {
            if (resolution.questions) transaction.set(draftRef, { questions: resolution.questions }, { merge: true });
            // The clock's tick resumes the submission (resolved_candidate_answers) and rechecks everything.
            transaction.set(flowRef, { portalRecoveryVersion: version, updatedAt: nowMs }, { merge: true });
            transaction.set(doc.ref, { automationDueAt: nowMs, automationUpdatedAt: new Date(nowMs) }, { merge: true });
            transaction.set(submissionRef, {
              portalCodeRecovery: { version, round, queuedAt: nowMs, kind: 'portal_questions_resolved' },
              portalQuestionRecovery: { key, round, attempts: attempts + 1, version, queuedAt: nowMs },
            }, { merge: true });
            transaction.set(doc.ref.collection('events').doc(), {
              type: 'portal_question_recovery_scheduled', actor: 'system', at: nowMs, version,
              questions: resolution.questionIds.length, documentSlots: resolution.slots.map(slot => slot.kind),
            });
          }
          return 'questions';
        }
        const trustedLocalAnswers = flow.orderQuestionAnswersEvidenceVersion === ORDER_QUESTION_ANSWER_EVIDENCE_VERSION;
        if (flow.heldBy[0] === 'portal:portal_needs_candidate' && !trustedLocalAnswers
          && hasUntrustedProfileOperationalAnswers({ profile: profileDoc?.data(), draft })
          && !hasCurrentNativePortalContract(draft)) return false;
        const verifiedQuestionAnswers = Object.fromEntries((answerContext.answerEvidence || [])
          .map(record => [record.key, record.answer]));
        // A same-order answer may be used to decide whether this already-saved
        // application is internally compatible. It is not candidate-wide
        // evidence, and it is never copied into the cross-order ledger
        // automatically. Trusted flows contribute only explicit match answers;
        // untrusted legacy flows retain their existing order-local projection.
        const legacyLocalAnswers = !trustedLocalAnswers
          ? object(flow.answers)
          : explicitMatchAnswers({ draft, flow });
        const recoveryMatchAnswerIds = trustedLocalAnswers ? Object.keys(legacyLocalAnswers) : [];
        const recoveryFlow = {
          ...answerContext.flow,
          answers: { ...(answerContext.flow.answers || {}), ...legacyLocalAnswers },
          ...(flow.heldBy[0] === 'portal:portal_needs_candidate' && !trustedLocalAnswers
            ? { questionAnswers: verifiedQuestionAnswers } : {}),
        };
        if (!operationalPortalRecoveryReady({ order, flow: recoveryFlow, draft })) return false;
        const eligibilityAnswers = identityQuestionReady
          ? { ...(recoveryFlow.answers || {}), [identityAnswer.questionId]: identityAnswer.email }
          : recoveryFlow.answers || {};
        const flags = evaluateRedFlags(draft, eligibilityAnswers, flow.documents || {}, recoveryFlow.questionAnswers, recoveryFlow, order);
        const candidatePortalRediscovery = ownerRecoveryReady && canRediscoverUnreadablePortalQuestions(flow, draft, flags);
        if (flags.owner.length || flags.documents.length || (flags.candidate.length && !candidatePortalRediscovery)) return false;
        if (receipt?.version === version && Number(receipt.round) === Number(flow.round || 1)) return false;
        const exhaustedRepair = !identityQuestionReady
          && !portalAutoRetryAttemptsRemaining(flow)
          && !flow.portalExhaustedRecoveryVersion;
        if (apply) {
          if (identityQuestionReady) {
            transaction.set(flowRef, {
              answers: { ...object(recoveryFlow.answers), [identityAnswer.questionId]: identityAnswer.email },
              portalRecoveryMatchAnswerIds: recoveryMatchAnswerIds,
              portalRecoveryMatchAnswerRound: Number(flow.round) || 1,
              portalRecoveryVersion: version, updatedAt: nowMs,
            }, { merge: true });
          } else {
            const heldBy = ['portal:portal_needs_candidate'];
            const recoveryOrderAnswers = flow.heldBy[0] === 'portal:portal_needs_candidate' && !trustedLocalAnswers
              ? {} : trustedLocalAnswers ? answerContext.orderAnswers
                : rememberCandidateQuestionAnswers({ questions: draft?.questions || [], answers: legacyLocalAnswers, changed: legacyLocalAnswers });
            transaction.set(flowRef, { heldBy,
              // The trusted projection intentionally omits same-order match
              // answers. Persist only those explicit, validated answers so
              // the submit runner receives the same compatibility decision
              // that authorized this recovery; never widen legacy evidence.
              ...(trustedLocalAnswers ? { answers: { ...object(answerContext.flow?.answers), ...legacyLocalAnswers } } : {}),
              ...(trustedLocalAnswers ? { portalRecoveryMatchAnswerIds: recoveryMatchAnswerIds,
                portalRecoveryMatchAnswerRound: Number(flow.round) || 1 } : {}),
              questionAnswers: recoveryOrderAnswers, portalAutoRetryAt: nowMs,
              portalRecoveryVersion: version,
              ...(exhaustedRepair ? { portalExhaustedRecoveryVersion: version } : {}),
              updatedAt: nowMs }, { merge: true });
          }
          transaction.set(doc.ref, { automationDueAt: nowMs, automationUpdatedAt: new Date(nowMs) }, { merge: true });
          transaction.set(submissionRef, { portalCodeRecovery: { version, round: Number(flow.round) || 1, queuedAt: nowMs,
            ...(identityQuestionReady ? { kind: 'identity_email_confirmation' } : {}),
            ...(exhaustedRepair ? { kind: 'exhausted_budget_repair' } : {}) } }, { merge: true });
          transaction.set(doc.ref.collection('events').doc(), {
            type: identityQuestionReady ? 'portal_identity_email_recovery_scheduled' : 'portal_code_recovery_scheduled',
            actor: 'system', at: nowMs, version,
          });
        }
        return identityQuestionReady ? 'identity' : 'portal';
      });
      if (eligible) {
        summary.eligible++;
        if (apply) {
          summary.queued++;
          if (eligible === 'identity') summary.identityQuestionsQueued++;
          if (eligible === 'questions') summary.questionHoldsQueued++;
        }
      }
    }
    cursor = page.docs.length === 100 ? page.docs.at(-1) : null;
  } while (cursor);
  return summary;
}

if (isInvokedDirectly(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) {
    throw new Error('Usage: reconcile-portal-code.mjs [--dry-run | --apply]');
  }
  console.log(JSON.stringify(await reconcilePortalCode({ db: await getFirestoreDb(), version: currentPortalCodeVersion(), apply: args.includes('--apply') })));
}
