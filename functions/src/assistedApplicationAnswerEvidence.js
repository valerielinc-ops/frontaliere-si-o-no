import { addressContextContract } from './lib/addressContextContract.js';
/** Shared answers keep their question and attested source. Opaque legacy values are never promoted. */
import { createHash, randomBytes } from 'node:crypto';
import { candidateAnswerFact } from './lib/candidateAnswerFacts.js';
import { candidateQuestionAnswerKey, isGeneralCandidateLanguageQuestion, ORDER_QUESTION_ANSWER_EVIDENCE_VERSION, rememberCandidateQuestionAnswers } from './assistedApplicationCandidateEdits.js';
import { validateAnswer } from './lib/answerRules.js';
import { languageCodesIn, isLanguageAbilityQuestion } from './lib/languageFacts.js';
import { retentionPurgeDueAt, talentPoolConsentActive } from './assistedApplicationRetention.js';
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';
import { portalQuestionText } from './lib/portalQuestionText.js';
import { provenOptionalOperationalPortalQuestion } from './lib/portalNativeContract.js';
import { defaultStartDate, minDateFor } from './lib/assistedApplicationQuestionConstraints.js';

export const ANSWER_EVIDENCE_VERSION = 'confirmed-question-evidence-v2';
export const ANSWER_QUESTION_SNAPSHOT_VERSION = 'candidate-question-snapshot-v2';
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const norm = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const hasAnswer = value => typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
  || typeof value === 'string' && Boolean(value.trim()) || Array.isArray(value) && value.some(item => String(item ?? '').trim());
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const serialized = value => JSON.stringify(canonical(value));
const same = (a, b) => serialized(a) === serialized(b);
const QUESTION_SNAPSHOT_FIELDS = ['id', 'question', 'why', 'applicationQuestion', 'context', 'section', 'type', 'options',
  'required', 'validation', 'minDate', 'suggested', 'source', 'autocomplete', 'addressContext'];
function displayQuestion(question) {
  return question?.source === 'portal' ? portalQuestionText(question) || question.question : question?.question;
}
function questionIsRequired(question, draft) {
  return Boolean(question?.required || question?.source === 'portal' && question.required === false
    && question.portalNativeContract && !provenOptionalOperationalPortalQuestion(question, draft));
}
function questionMinDate(question, nowMs) {
  return minDateFor({ ...question, question: displayQuestion(question) || question.question }, nowMs);
}
function questionSuggestedDate(question, nowMs) {
  return questionMinDate(question, nowMs) ? defaultStartDate(nowMs) : null;
}
function questionSnapshotMaterial(question, draft, nowMs) {
  const q = object(question);
  return Object.fromEntries(QUESTION_SNAPSHOT_FIELDS.map(field => [field,
    field === 'options' ? (Array.isArray(q.options) ? q.options : [])
      : field === 'id' ? String(q.id || '')
      : field === 'question' ? displayQuestion(q) ?? null
        : field === 'required' ? questionIsRequired(q, draft)
        : field === 'validation' ? object(q.validation)
          : field === 'minDate' ? questionMinDate(q, nowMs)
            : field === 'suggested' ? questionSuggestedDate(q, nowMs) : q[field] ?? null]));
}
export function answerQuestionSnapshotQuestion({ question, draft = {} } = {}) {
  const q = object(question);
  return { ...q, question: displayQuestion(q) || '', required: questionIsRequired(q, draft) };
}

/** Constraints and origin must remain compatible before a canonical new id can inherit a local answer. */
export function answerQuestionCompatibilityHash({ orderId, question, draft = {}, nowMs = Date.now() } = {}) {
  const q = answerQuestionSnapshotQuestion({ question, draft });
  const key = candidateQuestionAnswerKey(q);
  if (!String(orderId || '').trim() || !key || !String(q.question || '').trim()) return null;
  const fields = ['why', 'applicationQuestion', 'context', 'section', 'type', 'options', 'required', 'validation', 'source',
    'autocomplete', 'addressContext'];
  const contract = Object.fromEntries(fields.map(field => [field,
    field === 'options' ? (Array.isArray(q.options) ? q.options : [])
      : field === 'required' ? questionIsRequired(q, draft)
        : field === 'validation' ? object(q.validation) : q[field] ?? null]));
  contract.minDate = questionMinDate(q, nowMs);
  return createHash('sha256').update(serialized({ version: ANSWER_QUESTION_SNAPSHOT_VERSION,
    orderId: String(orderId), key, constraints: contract })).digest('hex');
}

/** Hash only the question contract shown to a candidate; answer values are never included. */
export function answerQuestionSnapshotHash({ orderId, question, draft = {}, nowMs = Date.now() } = {}) {
  const q = object(question);
  const id = String(q.id || '').trim();
  if (!String(orderId || '').trim() || !id || !String(q.question || '').trim()) return null;
  return createHash('sha256').update(serialized({ version: ANSWER_QUESTION_SNAPSHOT_VERSION,
    orderId: String(orderId), question: questionSnapshotMaterial(q, draft, nowMs) })).digest('hex');
}

/** Build one opaque snapshot per unique visible question id. */
export function answerQuestionSnapshotsFor({ orderId, questions = [], draft = {}, nowMs = Date.now() } = {}) {
  const counts = new Map();
  for (const question of Array.isArray(questions) ? questions : []) {
    const id = String(question?.id || '').trim();
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return Object.fromEntries((Array.isArray(questions) ? questions : []).flatMap(question => {
    const id = String(question?.id || '').trim();
    const hash = counts.get(id) === 1 ? answerQuestionSnapshotHash({ orderId, question, draft, nowMs }) : null;
    return hash ? [[id, hash]] : [];
  }));
}

/** Rebuild the candidate-confirmed local map using a canonical key for new ids and exact hashes for reused ids. */
export function orderQuestionAnswerContext({ orderId, flow = {}, draft = {}, nowMs = Date.now() } = {}) {
  const questions = Array.isArray(draft?.questions) ? draft.questions : [];
  const trusted = flow?.orderQuestionAnswersEvidenceVersion === ORDER_QUESTION_ANSWER_EVIDENCE_VERSION;
  const oldAnswers = trusted ? object(flow.questionAnswers) : {};
  const oldSnapshots = trusted ? object(flow.questionAnswerSnapshots) : {};
  const oldQuestionIds = trusted ? object(flow.questionAnswerSnapshotIds) : {};
  const oldCompatibility = trusted ? object(flow.questionAnswerCompatibility) : {};
  const flowAnswers = trusted ? object(flow.answers) : {};
  const previous = {};
  const answers = {};
  const snapshots = {};
  const snapshotIds = {};
  const compatibility = {};
  const groups = new Map();
  const snapshotQuestions = questions.map(question => answerQuestionSnapshotQuestion({ question, draft }));
  for (const question of snapshotQuestions) {
    const key = candidateQuestionAnswerKey(question);
    if (key) groups.set(key, [...(groups.get(key) || []), question]);
  }
  for (const [key, group] of groups) {
    const questionHashes = group.map(question => answerQuestionSnapshotHash({ orderId, question, draft, nowMs }));
    const hashes = [...new Set(questionHashes.filter(Boolean))];
    const compatibilityHashes = group.map(question => answerQuestionCompatibilityHash({ orderId, question, draft, nowMs }));
    const compatible = new Set(compatibilityHashes.filter(Boolean));
    const confirmedIds = Array.isArray(oldQuestionIds[key]) ? oldQuestionIds[key].filter(id => typeof id === 'string') : [];
    const reusesConfirmedId = group.some(question => confirmedIds.includes(question.id));
    const exactConfirmedSnapshot = reusesConfirmedId && oldSnapshots[key] === hashes[0];
    if (hashes.length !== 1 || questionHashes.some(hash => !hash) || compatible.size !== 1 || compatibilityHashes.some(hash => !hash)
      || !oldSnapshots[key] || !oldCompatibility[key]
      || (oldCompatibility[key] !== compatibilityHashes[0] && !exactConfirmedSnapshot)
      || reusesConfirmedId && !exactConfirmedSnapshot) continue;
    // A new id may reuse only through the same canonical semantic key. An id
    // already shown must retain its exact question text and constraints.
    snapshots[key] = oldSnapshots[key];
    snapshotIds[key] = confirmedIds;
    compatibility[key] = oldCompatibility[key];
    if (Object.hasOwn(oldAnswers, key)) previous[key] = oldAnswers[key];
    for (const question of group) if (confirmedIds.includes(question.id) && oldSnapshots[key] === hashes[0]
      && Object.hasOwn(flowAnswers, question.id)) answers[question.id] = flowAnswers[question.id];
  }
  const orderAnswers = rememberCandidateQuestionAnswers({ questions: snapshotQuestions, answers, previous, changed: answers });
  return { answers, orderAnswers, questionAnswerSnapshots: snapshots, questionAnswerSnapshotIds: snapshotIds,
    questionAnswerCompatibility: compatibility };
}

export function rememberOrderQuestionAnswerSnapshots({ orderId, questions = [], draft = {}, answers = {}, changed = {}, questionAnswers = {}, previous = {}, previousQuestionIds = {}, previousCompatibility = {}, confirmed = {}, nowMs = Date.now() } = {}) {
  const groups = new Map();
  const snapshotQuestions = (Array.isArray(questions) ? questions : []).map(question => answerQuestionSnapshotQuestion({ question, draft }));
  for (const question of snapshotQuestions) {
    const key = candidateQuestionAnswerKey(question);
    if (key) groups.set(key, [...(groups.get(key) || []), question]);
  }
  const snapshots = {};
  const snapshotIds = {};
  const compatibility = {};
  for (const [key, group] of groups) {
    const questionHashes = group.map(question => answerQuestionSnapshotHash({ orderId, question, draft, nowMs }));
    const hashes = [...new Set(questionHashes.filter(Boolean))];
    const compatibilityHashes = group.map(question => answerQuestionCompatibilityHash({ orderId, question, draft, nowMs }));
    const compatible = [...new Set(compatibilityHashes.filter(Boolean))];
    if (hashes.length !== 1 || questionHashes.some(hash => !hash) || compatible.length !== 1 || compatibilityHashes.some(hash => !hash)) continue;
    const hash = hashes[0];
    const changedGroup = group.filter(question => Object.hasOwn(changed, question.id));
    if (changedGroup.length) {
      if (changedGroup.every(question => confirmed[question.id] === hash) && hasAnswer(questionAnswers[key])) {
        snapshots[key] = hash;
        snapshotIds[key] = changedGroup.map(question => question.id);
        compatibility[key] = compatible[0];
      }
    } else if (previous[key] && hasAnswer(questionAnswers[key])) {
      snapshots[key] = previous[key];
      snapshotIds[key] = Array.isArray(previousQuestionIds[key]) ? previousQuestionIds[key] : [];
      if (previousCompatibility[key] === compatible[0]) compatibility[key] = previousCompatibility[key];
    }
  }
  return { snapshots, questionIds: snapshotIds, compatibility };
}
const PRIVACY = /\b(?:privacy|datenschutz|confidentialite|consent\w*|consens\w*|einwillig\w*|zustimm\w*|einverstanden|speicher\w*|agree|accept\w*|accett\w*|autorizz\w*|authoriz\w*|permission|marketing|newsletter|data processing|trattamento|traitement|verarbeitung|terms|conditions|condizioni)\b/;
const FACT_QUESTION = /^(?:do you (?:hold|have|possess)|have you|how many|what is your|what are your|which\b.{0,80}\bdo you (?:hold|have)|hai\b|possiedi\b|qual(?:e|i| e)\b|quanti\b|da quanti\b|verfugen sie\b|haben sie\b|besitzen sie\b|welche\b|wie viele\b|avez vous\b|possedez vous\b|quel(?:le|s|les)?\b|combien\b)/;
const LANGUAGE_QUESTION = /^(?:what is your|what are your|how would you describe your|is your|do you speak|can you speak|qual e il tuo|qual e la tua|parli|conosci|wie ist ihr|wie ist dein|wie sind ihre|welches niveau|sprechen sie|quel est votre|parlez vous)\b/;
const MOBILITY_QUESTION = /^(?:can you|are you|do you|puoi|sei|hai|konnen sie|sind sie|haben sie|pouvez vous|etes vous|avez vous)\b/;
const LEVEL = /^(?:[abc][12]|native|mother tongue|madrelingua|muttersprache|langue maternelle)$/;

function descriptor(question) {
  const q = object(question);
  const ownership = addressContextContract(q);
  if (ownership === null) return null;
  const fields = ['id', 'question', 'applicationQuestion', 'context', 'section', 'autocomplete', 'source', 'minDate'];
  if (fields.some(field => String(q[field] || '').length > 1000) || Array.isArray(q.options) && q.options.length > 100) return null;
  if (!['text', 'number', 'date', 'yes_no', 'choice', 'checkbox', 'multi_choice'].includes(q.type)
    || q.required != null && typeof q.required !== 'boolean') return null;
  return { ...Object.fromEntries(fields.map(field => [field, String(q[field] || '').trim()])),
    ...(ownership === undefined ? {} : { addressContext: ownership }),
    required: Boolean(q.required), type: String(q.type || 'text'), options: Array.isArray(q.options) ? q.options : [], validation: object(q.validation) };
}
function semantics(question, answer, nowMs = Date.now()) {
  const key = candidateQuestionAnswerKey(question);
  const label = norm(question.question);
  const text = norm([question.question, question.applicationQuestion, question.context, question.section].join(' '));
  if (addressContextContract(question)?.unknown) return null;
  if (!key || question.source === 'policy_default') return null;
  const typed = candidateAnswerFact(question, answer, { nowMs });
  if (typed) {
    const { category, unit, scope, ...fact } = typed;
    return { category, unit, scope, fact };
  }
  if (PRIVACY.test(text)) return null;
  const language = /^language_([a-z]{2})_(any|oral|written)_(proficiency|ability|threshold_[abc][12])$/.exec(key);
  if ((language || languageCodesIn(question.question).length === 1 && isLanguageAbilityQuestion(question.question)) && LANGUAGE_QUESTION.test(label)) {
    const levelAnswer = ['text', 'choice'].includes(question.type) && LEVEL.test(norm(answer));
    const portable = language?.[2] === 'any' && language?.[3] === 'proficiency' && levelAnswer && isGeneralCandidateLanguageQuestion(question.question)
      && !question.context && !question.section && !question.autocomplete && !Object.hasOwn(question, 'addressContext')
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
  if (!order || order.retentionPurgingAt != null || order.retentionPurgedAt != null || order.retentionPayloadPurgedAt != null) return false;
  const due = retentionPurgeDueAt(order);
  return talentPoolConsentActive(order) || Number.isFinite(due) && nowMs < due;
}
function provenance({ actor, order, orderId, round, nowMs }) {
  return { actor, userId: order.userId, orderId, round, confirmedAt: nowMs, retentionAt: retentionPurgeDueAt(order),
    jobId: String(order.jobId || ''), jobUrl: String(order.jobUrl || '') };
}

/** One transaction applies the same accepted keys to raw values and their evidence/clear clocks. */
export function planCandidateAnswerEvidence({ questions = [], changed = {}, confirmedQuestionSnapshots = {}, previous = {}, latestWriteAt = 0, orderId, order = {}, flow = {}, draft = {}, actor, nowMs }) {
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
    const snapshotHashes = group.map(question => answerQuestionSnapshotHash({ orderId, question, draft, nowMs }));
    const compatibilityHashes = group.map(question => answerQuestionCompatibilityHash({ orderId, question, draft, nowMs }));
    if (old?.provenance?.confirmedAt === nowMs && (same(old.answer, answer) || old.cleared && !hasAnswer(answer))) continue;
    const source = provenance({ actor, order, orderId, round, nowMs });
    const question = descriptor(raw); const policy = question && semantics(question, answer, nowMs);
    const snapshotMismatch = snapshotHashes.some((hash, index) => !hash || hash !== snapshotHashes[0]
      || confirmedQuestionSnapshots[group[index]?.id] !== hash || !compatibilityHashes[index]
      || compatibilityHashes[index] !== compatibilityHashes[0]);
    const conflict = old?.provenance?.confirmedAt === nowMs
      || group.some(q => !same(changed[q.id], answer) || !same(descriptor(q), question))
      || snapshotMismatch;
    accepted.add(key);
    delete records[key];
    if (conflict || !policy || !hasAnswer(answer) || !validateAnswer(answer, question, { todayIso: new Date(nowMs).toISOString().slice(0, 10) }).ok || policy.scope === 'job' && !order.jobUrl) {
      // Keep only the ordering clock after a clear; never retain the removed Q/A.
      records[key] = { version: ANSWER_EVIDENCE_VERSION, key, cleared: true, provenance: source };
      continue;
    }
    const record = { version: ANSWER_EVIDENCE_VERSION, key, question, answer, ...policy,
      questionSnapshotHash: snapshotHashes[0], questionCompatibilityHash: compatibilityHashes[0], provenance: source };
    records[key] = { id: `answer-${randomBytes(12).toString('hex')}`, ...record };
  }
  return { records: Object.fromEntries(Object.entries(records).slice(-80)), accepted };
}
export const rememberCandidateAnswerEvidence = input => planCandidateAnswerEvidence(input).records;

function validRecord(key, record, userId, legacy, nowMs) {
  if (!userId || !record || !/^answer-[a-f0-9]{24}$/.test(record.id || '') || record.version !== ANSWER_EVIDENCE_VERSION || record.key !== key
    || !/^[a-f0-9]{64}$/.test(record.questionSnapshotHash || '') || !/^[a-f0-9]{64}$/.test(record.questionCompatibilityHash || '')
    || !hasAnswer(record.answer)) return false;
  const { question, provenance: source } = record;
  const policy = semantics(question || {}, record.answer, nowMs);
  return Boolean(policy && same(policy, { category: record.category, unit: record.unit, scope: record.scope, ...(record.fact ? { fact: record.fact } : {}) })
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
export async function loadCandidateAnswerEvidence({ db, profileRecord = {}, userId, nowMs = Date.now(), getDocument = ref => ref.get(), questionKeys = null }) {
  const startedAt = Date.now();
  const legacy = object(profileRecord.applicationQuestionAnswers);
  const allowedKeys = Array.isArray(questionKeys) ? new Set(questionKeys.filter(Boolean)) : null;
  const candidates = Object.entries(object(profileRecord.applicationQuestionAnswerEvidence)).slice(-80)
    .filter(([key, record]) => (!allowedKeys || allowedKeys.has(key))
      && validRecord(key, record, userId, legacy, nowMs) && record.provenance.confirmedAt <= nowMs).map(([, record]) => record);
  const sources = new Map();
  await Promise.all([...new Set(candidates.map(record => record.provenance.orderId))].map(async orderId => {
    const ref = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId);
    const [order, flow, draft] = await Promise.all([getDocument(ref), getDocument(ref.collection('automation').doc('flow')), getDocument(ref.collection('ai_drafts').doc('current'))]);
    sources.set(orderId, { order: order.data(), flow: flow.data(), draft: draft.data() });
  }));
  const verified = candidates.filter(record => {
    const key = record.key;
    const source = sources.get(record.provenance.orderId); const current = source?.draft?.questions?.find(question => question.id === record.question.id);
    return source?.order?.userId === userId && retained(source.order, nowMs) && !source.flow?.retentionPurgedAt
      && Number(source.flow?.round) === record.provenance.round && Number(source.draft?.round) === record.provenance.round
      && current && same(descriptor(current), record.question) && same(source.flow?.answers?.[record.question.id], record.answer)
      && source.flow?.orderQuestionAnswersEvidenceVersion === ORDER_QUESTION_ANSWER_EVIDENCE_VERSION
      && object(source.flow?.questionAnswerSnapshots)[key] === record.questionSnapshotHash
      && object(source.flow?.questionAnswerCompatibility)[key] === record.questionCompatibilityHash
      && answerQuestionSnapshotHash({ orderId: record.provenance.orderId, question: current, draft: source.draft, nowMs }) === record.questionSnapshotHash
      && answerQuestionCompatibilityHash({ orderId: record.provenance.orderId, question: current, draft: source.draft, nowMs }) === record.questionCompatibilityHash
      && (record.scope === 'candidate' || samePosting(record.provenance, { jobId: source.order.jobId, jobUrl: source.order.jobUrl }));
  });
  return (job, { purpose = 'eligibility' } = {}) => {
    const evidence = verified.filter(record => retained(sources.get(record.provenance.orderId)?.order, nowMs + Math.max(0, Date.now() - startedAt))
      && (record.scope === 'candidate' || samePosting(record.provenance, job)) && (purpose === 'form' || record.category !== 'form_preference'))
      .sort((a, b) => a.key.localeCompare(b.key));
    return { answers: Object.fromEntries(evidence.map(record => [record.key, record.answer])), answerEvidence: evidence,
      fingerprint: createHash('sha256').update(serialized({ version: ANSWER_EVIDENCE_VERSION, evidenceIds: evidence.map(record => record.id) })).digest('hex') };
  };
}

/** Runner reads keep the raw CAS/lease snapshot untouched and project only the execution's answer context. */
export async function loadRunnerAnswerContext({ db, orderId, order, flow, draft, nowMs = Date.now(), profileRecord, getDocument = ref => ref.get() }) {
  const orderRetained = retained(order, nowMs);
  const profile = !orderRetained ? {} : profileRecord === undefined
    ? order.userId ? (await getDocument(db.collection('user_cv_profiles').doc(order.userId))).data() || {} : {}
    : profileRecord || {};
  const contextFor = orderRetained ? await loadCandidateAnswerEvidence({ db, profileRecord: profile, userId: order.userId, nowMs, getDocument,
    questionKeys: (draft?.questions || []).map(candidateQuestionAnswerKey) }) : null;
  const context = contextFor ? contextFor(order, { purpose: 'form' }) : { answers: {}, answerEvidence: [] };
  const orderContext = orderRetained ? orderQuestionAnswerContext({ orderId, flow, draft, nowMs })
    : { answers: {}, orderAnswers: {}, questionAnswerSnapshots: {}, questionAnswerSnapshotIds: {}, questionAnswerCompatibility: {} };
  return { flow: { ...flow, answers: orderContext.answers,
    questionAnswers: { ...context.answers, ...orderContext.orderAnswers } },
  orderAnswers: orderContext.orderAnswers, orderAnswerSnapshots: orderContext.questionAnswerSnapshots,
  orderAnswerSnapshotIds: orderContext.questionAnswerSnapshotIds, orderAnswerCompatibility: orderContext.questionAnswerCompatibility,
  answerEvidence: context.answerEvidence };
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
