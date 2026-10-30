/** Shared answers keep their question and attested source. Opaque legacy values are never promoted. */
import { createHash } from 'node:crypto';
import { candidateQuestionAnswerKey, isGeneralCandidateLanguageQuestion, rememberCandidateQuestionAnswers } from './assistedApplicationCandidateEdits.js';
import { validateAnswer } from './lib/answerRules.js';
import { languageCodesIn, isLanguageAbilityQuestion } from './lib/languageFacts.js';
import { retentionPurgeDueAt, talentPoolConsentActive } from './assistedApplicationRetention.js';
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';

export const ANSWER_EVIDENCE_VERSION = 'confirmed-question-evidence-v1';
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const norm = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const hasAnswer = value => typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
  || typeof value === 'string' && Boolean(value.trim()) || Array.isArray(value) && value.some(item => String(item ?? '').trim());
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const serialized = value => JSON.stringify(canonical(value));
const same = (a, b) => serialized(a) === serialized(b);
const PRIVACY = /\b(?:privacy|datenschutz|confidentialite|consent\w*|consens\w*|einwillig\w*|zustimm\w*|einverstanden|speicher\w*|agree|accept\w*|accett\w*|autorizz\w*|authoriz\w*|permission|marketing|newsletter|data processing|trattamento|traitement|verarbeitung|terms|conditions|condizioni)\b/;
const FACT_QUESTION = /^(?:do you (?:hold|have|possess)|have you|how many|what is your|what are your|which\b.{0,80}\bdo you (?:hold|have)|hai\b|possiedi\b|qual(?:e|i| e)\b|quanti\b|da quanti\b|verfugen sie\b|haben sie\b|besitzen sie\b|welche\b|wie viele\b|avez vous\b|possedez vous\b|quel(?:le|s|les)?\b|combien\b)/;
const LANGUAGE_QUESTION = /^(?:what is your|what are your|how would you describe your|is your|do you speak|can you speak|qual e il tuo|qual e la tua|parli|conosci|wie ist ihr|wie ist dein|wie sind ihre|welches niveau|sprechen sie|quel est votre|parlez vous)\b/;
const MOBILITY_QUESTION = /^(?:can you|are you|do you|puoi|sei|hai|konnen sie|sind sie|haben sie|pouvez vous|etes vous|avez vous)\b/;
const LEVEL = /^(?:[abc][12]|native|mother tongue|madrelingua|muttersprache|langue maternelle)$/;

function descriptor(question) {
  const q = object(question);
  const fields = ['id', 'question', 'applicationQuestion', 'context', 'section', 'autocomplete', 'source', 'minDate'];
  if (fields.some(field => String(q[field] || '').length > 1000) || Array.isArray(q.options) && q.options.length > 100) return null;
  if (!['text', 'number', 'date', 'yes_no', 'choice', 'checkbox', 'multi_choice'].includes(q.type)
    || q.required != null && typeof q.required !== 'boolean') return null;
  return { ...Object.fromEntries(fields.map(field => [field, String(q[field] || '').trim()])),
    required: Boolean(q.required), type: String(q.type || 'text'), options: Array.isArray(q.options) ? q.options : [], validation: object(q.validation) };
}
function semantics(question, answer) {
  const key = candidateQuestionAnswerKey(question);
  const label = norm(question.question);
  const text = norm([question.question, question.applicationQuestion, question.context, question.section].join(' '));
  if (!key || question.source === 'policy_default' || PRIVACY.test(text)) return null;
  const language = /^language_([a-z]{2})_(any|oral|written)_(proficiency|ability|threshold_[abc][12])$/.exec(key);
  if ((language || languageCodesIn(question.question).length === 1 && isLanguageAbilityQuestion(question.question)) && LANGUAGE_QUESTION.test(label)) {
    const levelAnswer = ['text', 'choice'].includes(question.type) && LEVEL.test(norm(answer));
    const portable = language?.[2] === 'any' && language?.[3] === 'proficiency' && levelAnswer && isGeneralCandidateLanguageQuestion(question.question)
      && !question.context && !question.section && !question.autocomplete
      && (!question.applicationQuestion || norm(question.applicationQuestion) === label);
    const unit = levelAnswer ? 'CEFR_or_stated_level' : ['yes_no', 'checkbox'].includes(question.type) ? 'boolean'
      : question.type === 'number' ? 'question_specific_number' : 'question_specific_text';
    return { category: 'language', unit, scope: portable ? 'candidate' : 'job' };
  }
  const unit = ['yes_no', 'checkbox'].includes(question.type) ? 'boolean' : question.type === 'date' ? 'date'
    : question.type === 'number' ? 'question_specific_number' : 'question_specific_text';
  if (FACT_QUESTION.test(label)) {
    if (/\b(?:certif\w*|diplom\w*|degree|abschluss\w*|ausbildung\w*|laurea\w*|qualific\w*)\b/.test(text)) return { category: 'qualification', unit, scope: 'job' };
    if (/\b(?:experienc\w*|esperienz\w*|erfahrung\w*)\b/.test(text)) return { category: 'experience', unit, scope: 'job' };
    if (/\b(?:permesso\w*|work permit|bewilligung\w*|permis de travail)\b/.test(text)) return { category: 'work_authorization', unit, scope: 'job' };
    if (/\b(?:salary|salar\w*|gehalt|lohn|preavvis\w*|notice period|kundigungsfrist|preavis|availability|disponibil\w*|start date|workload|pensum)\b/.test(text)) return { category: 'form_preference', unit, scope: 'job' };
  }
  if (MOBILITY_QUESTION.test(label) && /\b(?:residen\w*|relocat\w*|trasfer\w*|wohnsitz|umzug|domicil\w*|demenag\w*)\b/.test(text)) return { category: 'mobility', unit, scope: 'job' };
  return null;
}
function retained(order, nowMs) {
  if (!order || order.retentionPurgedAt != null) return false;
  const due = retentionPurgeDueAt(order);
  return talentPoolConsentActive(order) || Number.isFinite(due) && nowMs < due;
}
function provenance({ actor, order, orderId, round, nowMs }) {
  return { actor, userId: order.userId, orderId, round, confirmedAt: nowMs, retentionAt: retentionPurgeDueAt(order),
    jobId: String(order.jobId || ''), jobUrl: String(order.jobUrl || '') };
}

/** One transaction applies the same accepted keys to raw values and their evidence/clear clocks. */
export function planCandidateAnswerEvidence({ questions = [], changed = {}, previous = {}, latestWriteAt = 0, orderId, order = {}, flow = {}, draft = {}, actor, nowMs }) {
  const records = { ...object(previous) };
  const accepted = new Set();
  const round = Number(flow.round || 1);
  const attested = ['candidate', 'owner'].includes(actor) && order.userId && orderId && Number.isInteger(round) && round > 0
    && Number(draft.round) === round && Number.isFinite(nowMs) && nowMs > 0 && retained(order, nowMs);
  if (!attested) return { records, accepted };
  const groups = new Map();
  for (const question of Array.isArray(questions) ? questions : []) {
    if (!question?.id || !Object.hasOwn(changed, question.id)) continue;
    const key = candidateQuestionAnswerKey(question);
    if (key) groups.set(key, [...(groups.get(key) || []), question]);
  }
  for (const [key, group] of groups) {
    const old = records[key];
    // A bounded ledger may have evicted a clear clock. Never resurrect it from an older writer.
    if (!old && latestWriteAt > 0 && nowMs <= latestWriteAt) continue;
    if (Number(old?.provenance?.confirmedAt) > nowMs) continue;
    const raw = group[0]; const answer = changed[raw.id];
    if (old?.provenance?.confirmedAt === nowMs && (same(old.answer, answer) || old.cleared && !hasAnswer(answer))) continue;
    const source = provenance({ actor, order, orderId, round, nowMs });
    const question = descriptor(raw); const policy = question && semantics(question, answer);
    const conflict = old?.provenance?.confirmedAt === nowMs
      || group.some(q => !same(changed[q.id], answer) || !same(descriptor(q), question));
    accepted.add(key);
    delete records[key];
    if (conflict || !policy || !hasAnswer(answer) || !validateAnswer(answer, question, { todayIso: new Date(nowMs).toISOString().slice(0, 10) }).ok || policy.scope === 'job' && !order.jobUrl) {
      // Keep only the ordering clock after a clear; never retain the removed Q/A.
      records[key] = { version: ANSWER_EVIDENCE_VERSION, key, cleared: true, provenance: source };
      continue;
    }
    const record = { version: ANSWER_EVIDENCE_VERSION, key, question, answer, ...policy, provenance: source };
    records[key] = { id: `answer-${createHash('sha256').update(serialized(record)).digest('hex').slice(0, 24)}`, ...record };
  }
  return { records: Object.fromEntries(Object.entries(records).slice(-80)), accepted };
}
export const rememberCandidateAnswerEvidence = input => planCandidateAnswerEvidence(input).records;

function validRecord(key, record, userId, legacy, nowMs) {
  if (!userId || !record || !/^answer-[a-f0-9]{24}$/.test(record.id || '') || record.version !== ANSWER_EVIDENCE_VERSION || record.key !== key || !hasAnswer(record.answer)) return false;
  const { question, provenance: source } = record;
  const policy = semantics(question || {}, record.answer);
  return Boolean(policy && same(policy, { category: record.category, unit: record.unit, scope: record.scope })
    && candidateQuestionAnswerKey(question) === key && validateAnswer(record.answer, question, { todayIso: Number.isFinite(nowMs) ? new Date(nowMs).toISOString().slice(0, 10) : '' }).ok
    && source?.userId === userId && ['candidate', 'owner'].includes(source.actor) && source.orderId
    && Number.isInteger(source.round) && source.round > 0 && Number.isFinite(source.confirmedAt) && source.confirmedAt > 0
    && Object.hasOwn(legacy, key) && same(legacy[key], record.answer));
}
const samePosting = (source, target) => {
  const url = String(target.url || target.jobUrl || target.applyUrl || target.canonicalUrl || ''); const id = String(target.id || target.jobId || '');
  return Boolean(source.jobUrl && url && source.jobUrl === url && (!source.jobId || !id || source.jobId === id));
};

/** The optional getter participates in the orchestrator's existing Firestore transaction. */
export async function loadCandidateAnswerEvidence({ db, profileRecord = {}, userId, nowMs = Date.now(), getDocument = ref => ref.get() }) {
  const startedAt = Date.now();
  const legacy = object(profileRecord.applicationQuestionAnswers);
  const candidates = Object.entries(object(profileRecord.applicationQuestionAnswerEvidence)).slice(-80)
    .filter(([key, record]) => validRecord(key, record, userId, legacy, nowMs) && record.provenance.confirmedAt <= nowMs).map(([, record]) => record);
  const sources = new Map();
  await Promise.all([...new Set(candidates.map(record => record.provenance.orderId))].map(async orderId => {
    const ref = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId);
    const [order, flow, draft] = await Promise.all([getDocument(ref), getDocument(ref.collection('automation').doc('flow')), getDocument(ref.collection('ai_drafts').doc('current'))]);
    sources.set(orderId, { order: order.data(), flow: flow.data(), draft: draft.data() });
  }));
  const verified = candidates.filter(record => {
    const source = sources.get(record.provenance.orderId); const current = source?.draft?.questions?.find(question => question.id === record.question.id);
    return source?.order?.userId === userId && retained(source.order, nowMs) && !source.flow?.retentionPurgedAt
      && Number(source.flow?.round) === record.provenance.round && Number(source.draft?.round) === record.provenance.round
      && current && same(descriptor(current), record.question) && same(source.flow?.answers?.[record.question.id], record.answer)
      && (record.scope === 'candidate' || samePosting(record.provenance, { jobId: source.order.jobId, jobUrl: source.order.jobUrl }));
  });
  return (job, { purpose = 'eligibility' } = {}) => {
    const evidence = verified.filter(record => retained(sources.get(record.provenance.orderId)?.order, nowMs + Math.max(0, Date.now() - startedAt))
      && (record.scope === 'candidate' || samePosting(record.provenance, job)) && (purpose === 'form' || record.category !== 'form_preference'))
      .sort((a, b) => a.key.localeCompare(b.key));
    return { answers: Object.fromEntries(evidence.map(record => [record.key, record.answer])), answerEvidence: evidence,
      fingerprint: serialized({ version: ANSWER_EVIDENCE_VERSION, legacy, evidence }) };
  };
}

/** Runner reads keep the raw CAS/lease snapshot untouched and project only the execution's answer context. */
export async function loadRunnerAnswerContext({ db, order, flow, draft, nowMs = Date.now() }) {
  const profileRecord = order.userId ? (await db.collection('user_cv_profiles').doc(order.userId).get()).data() || {} : {};
  const contextFor = await loadCandidateAnswerEvidence({ db, profileRecord, userId: order.userId, nowMs });
  return { flow: { ...flow, questionAnswers: { ...contextFor(order, { purpose: 'form' }).answers,
    ...rememberCandidateQuestionAnswers({ questions: draft?.questions || [], answers: flow?.answers || {} }) } },
  answerEvidence: contextFor(order).answerEvidence };
}

/** A source purge removes only records/clocks still owned by that order, never newer confirmations. */
export async function purgeCandidateAnswerEvidence({ db, userId, orderId, nowMs = Date.now() }) {
  if (!userId || !orderId) return;
  const ref = db.collection('user_cv_profiles').doc(userId);
  await db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return;
    const records = { ...object(snapshot.data().applicationQuestionAnswerEvidence) };
    const answers = { ...object(snapshot.data().applicationQuestionAnswers) };
    for (const [key, record] of Object.entries(records)) {
      if (record?.provenance?.orderId !== orderId) continue;
      delete records[key]; delete answers[key];
    }
    tx.set(ref, { applicationQuestionAnswerEvidence: records, applicationQuestionAnswers: answers,
      applicationQuestionAnswersUpdatedAt: Math.max(Number(snapshot.data().applicationQuestionAnswersUpdatedAt) || 0, nowMs) },
    { mergeFields: ['applicationQuestionAnswerEvidence', 'applicationQuestionAnswers', 'applicationQuestionAnswersUpdatedAt'] });
  });
}
