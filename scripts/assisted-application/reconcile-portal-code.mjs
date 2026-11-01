/** Queue certainly unsent technical holds once per published portal-engine version. */
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { currentPortalCodeVersion } from './lib/portal-code-version.mjs';
import { evaluateRedFlags, roundWasSent } from '../../functions/src/assistedApplicationFlow.js';
import { loadRunnerAnswerContext } from '../../functions/src/assistedApplicationAnswerEvidence.js';
import { candidateQuestionAnswerKey, ORDER_QUESTION_ANSWER_EVIDENCE_VERSION, rememberCandidateQuestionAnswers } from '../../functions/src/assistedApplicationCandidateEdits.js';
import { operationalQuestionTopic } from '../../functions/src/assistedApplicationOperationalAnswers.js';
import { AUTOMATION_FLAG_KEY, parseAutomationFlag } from '../../functions/src/assistedApplicationAutomationFlag.js';
import { retentionPurgeDueAt, talentPoolConsentActive } from '../../functions/src/assistedApplicationRetention.js';
import { getRemoteConfig } from 'firebase-admin/remote-config';
import { PORTAL_NATIVE_CONTRACT_VERSION } from '../../functions/src/lib/portalNativeContract.js';
import { portalCodeVersion, portalRecoveryDefinitelyUnsent, operationalPortalRecoveryReady } from '../../functions/src/assistedApplicationPortalRecoveryPolicy.js';

const hasAnswer = value => typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
  || typeof value === 'string' && value.trim().length > 0 || Array.isArray(value) && value.some(item => String(item ?? '').trim());
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const canonicalUrl = value => { try { return new URL(String(value || '')).href; } catch { return ''; } };

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
  const summary = { scanned: 0, eligible: 0, queued: 0, apply };
  let cursor;
  do {
    let query = db.collection('assisted_applications').where('automationState', '==', 'owner_takeover').orderBy('__name__').limit(100);
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
        if (!portalRecoveryDefinitelyUnsent({ order, flow, draft, submission: submissionDoc.data(), version })
          || !roundWasSent(flow) || flow.postingExpiredAt) return false;
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
        const flags = evaluateRedFlags(draft, recoveryFlow.answers || {}, flow.documents || {}, recoveryFlow.questionAnswers);
        if (flags.owner.length || flags.candidate.length || flags.documents.length) return false;
        const receipt = submissionDoc.data()?.portalCodeRecovery;
        if (receipt?.version === version && Number(receipt.round) === Number(flow.round || 1)) return false;
        if (apply) {
          const heldBy = flow.heldBy[0] === 'portal:captcha_provider_unavailable' ? flow.heldBy : ['portal:portal_needs_candidate'];
          const recoveryOrderAnswers = flow.heldBy[0] === 'portal:portal_needs_candidate' && !trustedLocalAnswers
            ? {} : trustedLocalAnswers ? answerContext.orderAnswers
              : rememberCandidateQuestionAnswers({ questions: draft?.questions || [], answers: legacyLocalAnswers, changed: legacyLocalAnswers });
          transaction.set(flowRef, { heldBy, questionAnswers: recoveryOrderAnswers, portalAutoRetryAt: nowMs, portalAutoRetryCount: 0,
            portalRecoveryVersion: version, updatedAt: nowMs }, { merge: true });
          transaction.set(doc.ref, { automationDueAt: nowMs, automationUpdatedAt: new Date(nowMs) }, { merge: true });
          transaction.set(submissionRef, { portalCodeRecovery: { version, round: Number(flow.round) || 1, queuedAt: nowMs } }, { merge: true });
          transaction.set(doc.ref.collection('events').doc(), { type: 'portal_code_recovery_scheduled', actor: 'system', at: nowMs, version });
        }
        return true;
      });
      if (eligible) { summary.eligible++; if (apply) summary.queued++; }
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
