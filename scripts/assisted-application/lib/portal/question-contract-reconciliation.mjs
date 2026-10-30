/** Only fresh, uniquely observed native contracts may retire a legacy portal hold. */
import { createHash } from 'node:crypto';
import { hasAssistedApplicationConsent } from '../../../../functions/src/assistedApplicationConstants.js';
import { retentionPurgeDueAt, talentPoolConsentActive } from '../../../../functions/src/assistedApplicationRetention.js';
import { candidateAnswersForQuestions, candidateWithEdits } from '../../../../functions/src/assistedApplicationCandidateEdits.js';
import { roundWasSent, transition } from '../../../../functions/src/assistedApplicationFlow.js';
import { validateAnswer } from '../../../../functions/src/lib/answerRules.js';
import { isFetchablePublicUrl } from '../../../../functions/src/assistedApplicationAiJob.js';
import { portalAnswerForApplication } from './question-key.mjs';
import { portalRequirementsFromMissingRequired, preferredCvFields } from './portal.mjs';
import { operationalQuestionTopic } from '../../../../functions/src/assistedApplicationOperationalAnswers.js';
import { PORTAL_NATIVE_CONTRACT_VERSION } from '../../../../functions/src/lib/portalNativeContract.js';

export const PORTAL_CONTRACT_RECONCILIATION_VERSION = PORTAL_NATIVE_CONTRACT_VERSION;
const text = value => String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
const hasAnswer = value => text(value).length > 0;
const routingLabels = [
  /^(?:come (?:sono|sei|e|siamo|siete) venut[oaie] a conoscenza (?:di|del|della|dell|di questa|di questo|della nostra|del nostro) (?:lavoro|annuncio(?: di lavoro)?|offerta(?: di lavoro)?|posizione|azienda)|come (?:hai|ha|avete) (?:saputo di|scoperto|trovato|conosciuto) (?:questo |questa |il |la |l |la nostra )?(?:lavoro|annuncio(?: di lavoro)?|offerta(?: di lavoro)?|posizione|azienda)|fonte dell annuncio)$/,
  /^(?:how (?:did|do) (?:you|i) (?:hear|learn|find out) about (?:(?:this|the|our) (?:job|vacancy|position|role|company)|us)|(?:where|how) did you find (?:this|the|our) (?:job|vacancy|position|role)|recruitment source|referral source)$/,
  /^(?:wie (?:haben sie|hast du|bist du|sind sie) (?:von|uber|auf) (?:uns|diese stelle|die stelle|dieses stellenangebot|unser unternehmen|diese position) (?:erfahren|gehort|aufmerksam geworden)|wie (?:haben sie|hast du) (?:diese stelle|diese position|das stellenangebot|dieses stellenangebot) gefunden)$/,
  /^(?:comment (?:avez vous|as tu|ai je) (?:entendu parler de|pris connaissance de|eu connaissance de|decouvert|connu) (?:cette offre(?: d emploi)?|ce poste|cet emploi|notre entreprise|nous)|source de recrutement)$/,
];

/** Only complete operational labels may retire an anonymous-form legacy hold. */
export function relaxablePortalQuestionTopic(question) {
  const variants = [...new Set([question?.applicationQuestion, question?.question].map(text).filter(Boolean))];
  const topics = variants.map(label => {
    const normalized = label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (routingLabels.some(pattern => pattern.test(normalized))) return 'recruitment_source';
    return operationalQuestionTopic({ ...question, question: label, applicationQuestion: '' });
  });
  return topics.length && topics[0] && topics.every(topic => topic === topics[0]) ? topics[0] : null;
}
export const portalContractContextHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const portalContractSourceUrl = draft => String(draft?.channel?.applyUrl || draft?.job?.applyUrl || '').trim();
export const portalContractQuestionKey = question => text(question?.applicationQuestion).toLowerCase();

function ownerPortalQuestionHold(flow) {
  return flow?.state === 'owner_takeover' && flow.heldBy?.length === 1
    && flow.heldBy[0] === 'portal:portal_needs_candidate';
}
function contractWorkerIdle({ flow, execution = {} }, nowMs) {
  if (!flow?.executionId && !Object.keys(execution).length) return true;
  return Boolean(flow?.executionId && execution.id === flow.executionId && execution.state === 'finished'
    && !(Number(execution.lease?.expiresAt) > nowMs) && !(Number(execution.controller?.expiresAt) > nowMs));
}

export function legacyPortalContractEligible({ order, flow, draft, submission = {}, execution = {} }, nowMs) {
  const purgeAt = retentionPurgeDueAt(order);
  const round = Number(flow?.round) || 1;
  const send = submission[`r${round}`];
  return order?.paymentStatus === 'paid' && hasAssistedApplicationConsent(order)
    && !order.withdrawnAt && !order.retentionPurgedAt
    && (talentPoolConsentActive(order) || (purgeAt != null && purgeAt > nowMs))
    && !['pending', 'succeeded', 'refunded'].includes(order.refundStatus)
    && !['submitted', 'withdrawn', 'refunded'].includes(order.submissionStatus)
    && ((order.automationState === 'needs_candidate_action' && flow?.state === 'needs_candidate_action')
      || (order.automationState === 'owner_takeover' && ownerPortalQuestionHold(flow)))
    && contractWorkerIdle({ flow, execution }, nowMs)
    && !flow.postingExpiredAt && roundWasSent(flow, round)
    && Number(flow.dispatch?.round) === round
    && Number(draft?.completedAt) > 0 && Number(flow.dispatch?.requestedAt) >= Number(draft.completedAt)
    && draft?.status === 'ready' && Number(draft.round) === round && !draft.sent && !draft.sentAttempt
    && send?.state === 'failed' && send.channel === 'portal' && !send.clickedAt && Number(send.releasedAt) > 0
    && !Object.values(submission).some(record => record?.state === 'sent' || record?.state === 'sending' || record?.clickedAt)
    && isFetchablePublicUrl(portalContractSourceUrl(draft))
    && (draft.questions || []).some(question => question.source === 'portal' && question.required === true
      && (ownerPortalQuestionHold(flow) || (flow.heldBy || []).includes(`question:${question.id}`)) && relaxablePortalQuestionTopic(question)
      && !hasAnswer(candidateWithEdits({ order, draft, flow }).answers[question.id]));
}

/** Receipt identity changes with a review episode, never with each engine source hash. */
export function portalContractEpisode({ flow, draft }) {
  return portalContractContextHash([PORTAL_CONTRACT_RECONCILIATION_VERSION, flow?.round, portalContractSourceUrl(draft)]);
}

/** Build a metadata-only patch. Any incompatible preserved answer leaves the whole draft unchanged. */
export function revalidatedPortalQuestions(context, proof, nowMs, { previouslyRelaxed = [] } = {}) {
  const { order, flow, draft } = context;
  if (!proof?.complete || !proof.readOnly || !proof.stable || proof.sourceUrl !== portalContractSourceUrl(draft)
    || proof.url !== proof.sourceUrl || !Array.isArray(proof.fields)) return { changed: false, reason: 'proof_unknown' };
  const fields = proof.fields;
  const forms = [...new Set(preferredCvFields(fields).filter(field => field.frame === 0
    && Number.isInteger(field.form) && field.form >= 0).map(field => field.form))];
  if (forms.length !== 1 || !fields.some(field => field.frame === 0 && field.form === forms[0]
    && (field.inputType === 'email' || /^(?:email|name|given-name|family-name)$/.test(field.autocomplete || '')))) {
    return { changed: false, reason: 'application_form_owner_unknown' };
  }
  const answers = candidateWithEdits({ order, draft, flow }).answers;
  const held = new Set(ownerPortalQuestionHold(flow)
    ? (draft.questions || []).filter(question => question.required === true).map(question => question.id)
    : (flow.heldBy || []).map(value => String(value).replace(/^question:/, '')));
  const updated = [];
  const protectedIds = new Set(previouslyRelaxed);
  const questions = (draft.questions || []).map(question => {
    if (question?.source !== 'portal' || !held.has(question.id) || !text(question.applicationQuestion)
      || hasAnswer(answers[question.id]) || protectedIds.has(portalContractQuestionKey(question)) || !relaxablePortalQuestionTopic(question)) return question;
    const matching = fields.filter(field => text(field.label) === text(question.applicationQuestion));
    if (matching.length !== 1) return question;
    const field = matching[0];
    if (fields.filter(other => other.id === field.id).length !== 1 || field.frame !== 0
      || field.form !== forms[0] || ['context', 'section', 'autocomplete'].some(key => text(question[key])
        && text(question[key]) !== text(field[key]))
      || !['text', 'textarea', 'select', 'radio', 'checkbox', 'date'].includes(field.kind)
      || typeof field.required !== 'boolean' || field.invalid
      || (field.required === false && field.explicitlyOptional !== true)) return question;
    // Reuse the normal reduction's type, catalogue and mapping rules. The real
    // required flag is restored below; this clone only reads an optional control.
    const result = portalRequirementsFromMissingRequired([{ ...field, required: true }], [{ ...question, fieldId: field.id }]);
    if (result.unreadableFields?.length || result.questions.length !== 1 || result.documents.length) return question;
    const contract = result.questions[0];
    const next = {
      ...question,
      type: contract.type, options: contract.options, applicationOptions: contract.applicationOptions || [],
      optionMap: contract.optionMap || [], validation: contract.validation, required: field.required,
      portalNativeContract: {
        version: PORTAL_CONTRACT_RECONCILIATION_VERSION, observedAt: proof.observedAt, url: proof.url,
        fieldId: field.id, frame: field.frame, label: field.label, kind: field.kind,
        form: field.form, topic: relaxablePortalQuestionTopic(question), requiredEvidence: field.explicitlyOptional ? 'aria-required:false' : 'required',
        context: text(field.context).slice(0, 240), section: text(field.section).slice(0, 240), required: field.required,
      },
    };
    updated.push(question.id);
    return next;
  });
  if (!updated.length) return { changed: false, reason: 'no_unique_unanswered_native_contract' };
  const proposed = { ...draft, questions };
  if (Buffer.byteLength(JSON.stringify(proposed)) > 750_000) return { changed: false, reason: 'native_contract_too_large' };
  const projected = candidateAnswersForQuestions(questions, answers, flow.questionAnswers || {});
  const todayIso = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Zurich' }).format(new Date(nowMs));
  for (const question of questions) {
    const answer = projected[question.id];
    if (!hasAnswer(answer)) continue;
    if (!validateAnswer(String(answer), question, { todayIso }).ok
      || (question.source === 'portal' && !portalAnswerForApplication(question, String(answer)))) {
      return { changed: false, reason: 'preserved_answer_incompatible' };
    }
  }
  const tick = transition(flow, { type: 'tick' }, { draft: proposed, answers: flow.answers || {},
    documents: flow.documents || {}, nowMs });
  return { changed: true, questions, updated, queue: tick.effects.some(effect => effect.type === 'dispatch'
    && effect.reason === 'resolved_candidate_answers') };
}
