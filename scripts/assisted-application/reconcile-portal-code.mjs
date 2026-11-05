/** Queue certainly unsent technical holds once per published portal-engine version. */
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
import { portalCodeVersion, portalIdentityQuestionDefinitelyUnsent, portalRecoveryDefinitelyUnsent, operationalPortalRecoveryReady } from '../../functions/src/assistedApplicationPortalRecoveryPolicy.js';
import './extension/apply-control.js';
import { candidateAnswerForField, isIdentityEmailConfirmationField } from './lib/portal/plan.mjs';

const hasAnswer = value => typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
  || typeof value === 'string' && value.trim().length > 0 || Array.isArray(value) && value.some(item => String(item ?? '').trim());
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const canonicalUrl = value => { try { return new URL(String(value || '')).href; } catch { return ''; } };

function identityEmailConfirmationAnswer({ order, draft, flow, nowMs }) {
  if (flow?.state !== 'needs_candidate_action' || flow?.heldBy?.length !== 1) return null;
  const heldId = String(flow.heldBy[0] || '').replace(/^question:/, '');
  if (!heldId || flow.heldBy[0] !== `question:${heldId}`) return null;
  const matches = (Array.isArray(draft?.questions) ? draft.questions : []).filter(question => question?.id === heldId);
  if (matches.length !== 1) return null;
  const question = matches[0];
  if (question.source !== 'portal' || question.required !== true || !['text', 'email', 'email_address'].includes(question.type)) return null;
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

export async function reconcilePortalCode({ db, version, apply = false, nowMs = Date.now(), isEnabled = null }) {
  if (!portalCodeVersion(version)) throw new Error('invalid_portal_code_version');
  if (!isEnabled) {
    // The script's Admin SDK owns the app initialized by getFirestoreDb.
    // A Functions SDK installed beside it has a separate app registry.
    const template = await getRemoteConfig().getTemplate();
    const flag = parseAutomationFlag(template.parameters?.[AUTOMATION_FLAG_KEY]?.defaultValue?.value);
    isEnabled = id => flag.all || flag.orders.has(id);
  }
  const summary = { scanned: 0, eligible: 0, queued: 0, identityQuestionsQueued: 0, apply };
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
        const [orderDoc, flowDoc, draftDoc, submissionDoc] = await Promise.all([
          transaction.get(doc.ref), transaction.get(flowRef), transaction.get(doc.ref.collection('ai_drafts').doc('current')),
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
        const ownerRecoveryReady = portalRecoveryDefinitelyUnsent({ order, flow, draft, submission, version });
        if ((!ownerRecoveryReady && !identityQuestionReady) || !roundWasSent(flow) || flow.postingExpiredAt) return false;
        if (flow.heldBy[0] === 'portal:portal_needs_candidate'
          && !talentPoolConsentActive(order) && !(retentionPurgeDueAt(order) > nowMs)) return false;
        const answerContext = await loadRunnerAnswerContext({ db, orderId: doc.id, order, flow, draft, nowMs,
          profileRecord: profileDoc?.data() || {}, getDocument: ref => transaction.get(ref) });
        const trustedLocalAnswers = flow.orderQuestionAnswersEvidenceVersion === ORDER_QUESTION_ANSWER_EVIDENCE_VERSION;
        if (flow.heldBy[0] === 'portal:portal_needs_candidate' && !trustedLocalAnswers
          && hasUntrustedProfileOperationalAnswers({ profile: profileDoc?.data(), draft })
          && !hasCurrentNativePortalContract(draft)) return false;
        const verifiedQuestionAnswers = Object.fromEntries((answerContext.answerEvidence || [])
          .map(record => [record.key, record.answer]));
        // A same-order legacy answer may be used to decide whether this
        // already-saved application is internally compatible. It is not
        // candidate-wide evidence, and it is never copied into the
        // cross-order ledger automatically.
        const legacyLocalAnswers = !trustedLocalAnswers ? object(flow.answers) : {};
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
        if (flags.owner.length || flags.candidate.length || flags.documents.length) return false;
        if (receipt?.version === version && Number(receipt.round) === Number(flow.round || 1)) return false;
        if (apply) {
          if (identityQuestionReady) {
            transaction.set(flowRef, {
              answers: { ...object(flow.answers), [identityAnswer.questionId]: identityAnswer.email },
              portalRecoveryVersion: version, updatedAt: nowMs,
            }, { merge: true });
          } else {
            const heldBy = ['portal:portal_needs_candidate'];
            const recoveryOrderAnswers = flow.heldBy[0] === 'portal:portal_needs_candidate' && !trustedLocalAnswers
              ? {} : trustedLocalAnswers ? answerContext.orderAnswers
                : rememberCandidateQuestionAnswers({ questions: draft?.questions || [], answers: legacyLocalAnswers, changed: legacyLocalAnswers });
            transaction.set(flowRef, { heldBy, questionAnswers: recoveryOrderAnswers, portalAutoRetryAt: nowMs, portalAutoRetryCount: 0,
              portalRecoveryVersion: version, updatedAt: nowMs }, { merge: true });
          }
          transaction.set(doc.ref, { automationDueAt: nowMs, automationUpdatedAt: new Date(nowMs) }, { merge: true });
          transaction.set(submissionRef, { portalCodeRecovery: { version, round: Number(flow.round) || 1, queuedAt: nowMs,
            ...(identityQuestionReady ? { kind: 'identity_email_confirmation' } : {}) } }, { merge: true });
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
