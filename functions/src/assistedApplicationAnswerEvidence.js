import { applicationPolicyAuthority } from './lib/assistedApplicationPolicyAuthority.js';
import { answerConflictMetadata } from './lib/answerSourceConflict.js';
import { qualificationAnswerOriginContext, qualificationCounterContext, qualificationCounterContextHash } from './lib/qualificationCounterContext.js';
import { isConsentRefusal } from './lib/applicationConsent.js';
import { localAnswerEvidence, localAnswerSourceConflicts, sameAnswerMaterial, answerSourceRetained } from './assistedApplicationAnswerConfirmation.js';
import { createAnswerSourceGuard, createCandidateAnswerSourceGuard } from './assistedApplicationAnswerSourceGuard.js';
import { answerQuestionDescriptor as descriptor } from './lib/applicationQuestionContract.js';
import { isPortableCandidateLanguageQuestion } from './lib/candidateLanguageQuestion.js';
import { addressContextContract } from './lib/addressContextContract.js';
/** Shared answers keep their question and attested source. Opaque legacy values are never promoted. */
import { createHash } from 'node:crypto';
import { candidateQuestionAnswerKey, rememberCandidateQuestionAnswers } from './assistedApplicationCandidateEdits.js';
import { validateAnswer } from './lib/answerRules.js';
import { languageCodesIn, isLanguageAbilityQuestion } from './lib/languageFacts.js';
import { retentionPurgeDueAt } from './assistedApplicationRetention.js';
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
function groupCounterContexts(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = serialized([entry.orderId, entry.round, entry.confirmedHash, entry.currentHash]);
    if (!groups.has(key)) groups.set(key, { ...entry, answerIds: [] });
    groups.get(key).answerIds.push(...entry.answerIds);
  }
  return [...groups.values()].map(entry => ({ ...entry, answerIds: [...new Set(entry.answerIds)].sort() }));
}
const PRIVACY = /\b(?:privacy|datenschutz|confidentialite|consent\w*|consens\w*|einwillig\w*|zustimm\w*|einverstanden|speicher\w*|agree|accept\w*|accett\w*|autorizz\w*|authoriz\w*|permission|marketing|newsletter|data processing|trattamento|traitement|verarbeitung|terms|conditions|condizioni)\b/;
const FACT_QUESTION = /^(?:do you (?:hold|have|possess)|have you|how many|what is your|what are your|which\b.{0,80}\bdo you (?:hold|have)|hai\b|possiedi\b|qual(?:e|i| e)\b|quanti\b|da quanti\b|verfugen sie\b|haben sie\b|besitzen sie\b|welche\b|wie viele\b|avez vous\b|possedez vous\b|quel(?:le|s|les)?\b|combien\b)/;
const LANGUAGE_QUESTION = /^(?:what is your|what are your|how would you describe your|is your|do you speak|can you speak|qual e il tuo|qual e la tua|parli|conosci|wie ist ihr|wie ist dein|wie sind ihre|welches niveau|sprechen sie|quel est votre|parlez vous)\b/;
const MOBILITY_QUESTION = /^(?:can you|are you|do you|puoi|sei|hai|konnen sie|sind sie|haben sie|pouvez vous|etes vous|avez vous)\b/;
const LEVEL = /^(?:[abc][12]|native|mother tongue|madrelingua|muttersprache|langue maternelle)$/;


function semantics(question, answer) {
  const key = candidateQuestionAnswerKey(question);
  const label = norm(question.question);
  const native = question.originalNativeContract || {};
  const text = norm([question.question, question.applicationQuestion, question.context, question.section, ...(question.ownConsentText || []), ...(question.ownConsentLinks || []), native.question, native.context, native.section, ...(native.ownConsentText || []), ...(native.ownConsentLinks || [])].join(' '));
  if (addressContextContract(question)?.unknown || question.ownershipUnknown === true || question.metadataComplete === false) return null;
  if (!key || question.source === 'policy_default' || PRIVACY.test(text)) return null;
  const language = /^language_([a-z]{2})_(any|oral|written)_(proficiency|ability|threshold_[abc][12])$/.exec(key);
  if ((language || languageCodesIn(question.question).length === 1 && isLanguageAbilityQuestion(question.question)) && LANGUAGE_QUESTION.test(label)) {
    const levelAnswer = ['text', 'choice'].includes(question.type) && LEVEL.test(norm(answer));
    const portable = language?.[2] === 'any' && language?.[3] === 'proficiency' && levelAnswer && !question.why && !question.applicationOptions?.length && !question.optionMap?.length && !Object.hasOwn(question, 'originalNativeContract') && isPortableCandidateLanguageQuestion(question);
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
const retained = answerSourceRetained;
function provenance({ actor, order, orderId, round, nowMs }) {
  return { actor, userId: order.userId, orderId, round, confirmedAt: nowMs, retentionAt: retentionPurgeDueAt(order),
    jobId: String(order.jobId || ''), jobUrl: String(order.jobUrl || '') };
}

/** One transaction applies the same accepted keys to raw values and their evidence/clear clocks. */
export function planCandidateAnswerEvidence({ questions = [], changed = {}, previous = {}, latestWriteAt = 0, orderId, order = {}, flow = {}, draft = {}, actor, nowMs, limit = 80, confirmations = null }) {
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
  const retireAliases = (key, questionId, source, current = records[key], keepCurrent = true) => {
    for (const [aliasKey, alias] of Object.entries(records)) {
      const provenance = alias?.provenance;
      if (aliasKey === key || alias?.version !== ANSWER_EVIDENCE_VERSION || alias.key !== aliasKey
        || provenance?.orderId !== orderId || provenance.userId !== order.userId
        || (provenance.questionId || alias.question?.id) !== questionId
        || !Number.isFinite(provenance.confirmedAt) || provenance.confirmedAt > nowMs
        || !/^confirmation-[a-f0-9]{64}$/.test(provenance.confirmationId || '')
        || !(alias.cleared || validRecord(aliasKey, alias, order.userId, { [aliasKey]: alias.answer }, nowMs))) continue;
      const reason = current.cleared ? current.conflict?.reason || 'unconfirmed_source' : 'question_changed';
      const at = current.cleared ? nowMs : alias.conflict?.at || provenance.confirmedAt;
      const metadata = answerConflictMetadata(alias, reason, at);
      accepted.add(aliasKey); delete records[aliasKey];
      records[aliasKey] = { version: ANSWER_EVIDENCE_VERSION, key: aliasKey, cleared: true,
        provenance: { ...source }, ...(metadata ? { conflict: metadata } : {}) };
    }
    // The accepted current value is newer than its retired aliases in the one bounded selection.
    if (keepCurrent) {
      delete records[key]; records[key] = current;
      accepted.delete(key); accepted.add(key);
    }
  };
  for (const [key, group] of groups) {
    const old = records[key]; const raw = group[0]; const answer = changed[raw.id];
    const receipt = confirmations?.[raw.id];
    const source = { ...provenance({ actor, order, orderId, round, nowMs }), questionId: raw.id,
      ...(receipt ? { confirmationId: receipt.id, contractHash: receipt.contractHash, cvHash: receipt.provenance.cvHash, sourceCounterHash: receipt.provenance.sourceCounterHash } : {}) };
    // A bounded ledger may have evicted a clear clock. Never resurrect it from an older writer.
    if (!old && latestWriteAt > 0 && nowMs <= latestWriteAt || Number(old?.provenance?.confirmedAt) > nowMs) {
      // A causally current clear can still erase its older proven aliases, without replacing a newer value.
      if (receipt?.cleared && !hasAnswer(answer)) retireAliases(key, raw.id, source,
        { cleared: true, conflict: { reason: 'explicit_clear' } }, false);
      continue;
    }
    if (old?.provenance?.confirmedAt === nowMs && (same(old.answer, answer) || old.cleared && !hasAnswer(answer))) continue;
    const question = descriptor(raw); const policy = question && semantics(question, answer);
    const conflict = old?.provenance?.confirmedAt === nowMs
      || group.some(q => !same(changed[q.id], answer) || !same(descriptor(q), question));
    accepted.add(key);
    delete records[key];
    if (conflict || confirmations !== null && (!receipt || receipt.cleared) || !policy || !hasAnswer(answer) || !validateAnswer(answer, question, { todayIso: new Date(nowMs).toISOString().slice(0, 10) }).ok || policy.scope === 'job' && !order.jobUrl) {
      // Keep only the ordering clock after a clear; never retain the removed Q/A.
      const reason = conflict ? 'same_clock_conflict' : !hasAnswer(answer) ? 'explicit_clear' : 'unconfirmed_source';
      const knownOld = old?.provenance?.userId === order.userId && (old?.cleared && old.conflict
        || validRecord(key, old, order.userId, { [key]: old?.answer }, nowMs));
      const metadata = knownOld && (old.scope === 'candidate' || old.conflict?.scope === 'candidate' || samePosting(old.provenance || {}, order))
        ? answerConflictMetadata(old, reason, nowMs) : null;
      records[key] = { version: ANSWER_EVIDENCE_VERSION, key, cleared: true, provenance: source, ...(metadata ? { conflict: metadata } : {}) };
      retireAliases(key, raw.id, source);
      continue;
    }
    const record = { version: ANSWER_EVIDENCE_VERSION, key, question, answer, ...policy, provenance: source };
    records[key] = { id: `answer-${createHash('sha256').update(serialized(record)).digest('hex').slice(0, 24)}`, ...record };
    retireAliases(key, raw.id, source);
  }
  return { records: limit == null ? records : Object.fromEntries(Object.entries(records).slice(-limit)), accepted };
}
export const rememberCandidateAnswerEvidence = input => planCandidateAnswerEvidence(input).records;

function validRecord(key, record, userId, legacy, nowMs) {
  if (!userId || !record || !/^answer-[a-f0-9]{24}$/.test(record.id || '') || record.version !== ANSWER_EVIDENCE_VERSION || record.key !== key || !hasAnswer(record.answer)) return false;
  const { question, provenance: source } = record;
  const policy = semantics(question || {}, record.answer);
  return Boolean(policy && same(policy, { category: record.category, unit: record.unit, scope: record.scope })
    && candidateQuestionAnswerKey(question) === key && validateAnswer(record.answer, question, { todayIso: Number.isFinite(nowMs) ? new Date(nowMs).toISOString().slice(0, 10) : '' }).ok
    && source?.userId === userId && ['candidate', 'owner'].includes(source.actor) && source.orderId
    && /^confirmation-[a-f0-9]{64}$/.test(source.confirmationId || '') && /^[a-f0-9]{64}$/.test(source.sourceCounterHash || '')
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
  const entries = Object.entries(object(profileRecord.applicationQuestionAnswerEvidence)).slice(-80);
  const historical = entries.filter(([key, record]) => validRecord(key, record, userId, { [key]: record?.answer }, nowMs)
    && record.provenance.confirmedAt <= nowMs).map(([, record]) => record);
  const candidates = historical.filter(record => Object.hasOwn(legacy, record.key) && same(legacy[record.key], record.answer));
  const tombstones = entries.filter(([key, record]) => record?.cleared && record.version === ANSWER_EVIDENCE_VERSION && record.key === key
    && record.provenance?.userId === userId && ['candidate', 'owner'].includes(record.provenance.actor)
    && record.provenance.orderId && Number.isInteger(record.provenance.round) && record.provenance.round > 0
    && Number.isFinite(record.provenance.confirmedAt) && record.provenance.confirmedAt > 0 && record.provenance.confirmedAt <= nowMs
    && /^[a-f0-9]{64}$/.test(record.provenance.sourceCounterHash || '') && /^confirmation-[a-f0-9]{64}$/.test(record.provenance.confirmationId || '')
    && record.conflict?.key === key && ['candidate', 'job'].includes(record.conflict.scope)
    && typeof record.conflict.property === 'string' && record.conflict.property.length > 0 && record.conflict.property.length <= 600
    && ['explicit_clear', 'same_clock_conflict', 'source_round_changed', 'question_changed', 'unconfirmed_source'].includes(record.conflict.reason)
    && (record.conflict.languageCode === '' || /^[a-z]{2}$/.test(record.conflict.languageCode || ''))
    && (record.conflict.cvHash === '' || /^[a-f0-9]{64}$/.test(record.conflict.cvHash || ''))
    && Number.isFinite(record.conflict.at) && record.conflict.at > 0 && record.conflict.at <= nowMs).map(([, record]) => record);
  // Bound records are represented by validated evidence/conflicts instead. In particular,
  // their raw mirror must not survive source expiry through the unverified legacy channel.
  const boundKeys = new Set(entries.filter(([, record]) => record?.version === ANSWER_EVIDENCE_VERSION
    && record.provenance?.userId === userId && record.provenance?.orderId
    && /^confirmation-[a-f0-9]{64}$/.test(record.provenance.confirmationId || '')).map(([key]) => key));
  const rawCounterAnswers = Object.fromEntries(Object.entries(legacy).filter(([key]) => !boundKeys.has(key)));
  const sources = new Map();
  await Promise.all([...new Set([...historical, ...tombstones].map(record => record.provenance.orderId))].map(async orderId => {
    const ref = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId);
    const [order, flow, draft, intake] = await Promise.all([getDocument(ref), getDocument(ref.collection('automation').doc('flow')), getDocument(ref.collection('ai_drafts').doc('current')), getDocument(ref.collection('automation').doc('intake'))]);
    sources.set(orderId, { order: order.data(), flow: flow.data(), draft: draft.data(), intake: intake.data() || null });
  }));
  const verified = candidates.filter(record => {
    const source = sources.get(record.provenance.orderId); const current = source?.draft?.questions?.find(question => question.id === record.question.id);
    const receipt = localAnswerEvidence({ orderId: record.provenance.orderId, order: source?.order, flow: source?.flow, draft: source?.draft, intake: source?.intake, nowMs })
      .find(item => item.id === record.provenance.confirmationId);
    return receipt && sameAnswerMaterial(receipt.question, record.question) && sameAnswerMaterial(receipt.answer, record.answer)
      && receipt.contractHash === record.provenance.contractHash && receipt.provenance.cvHash === record.provenance.cvHash && receipt.provenance.sourceCounterHash === record.provenance.sourceCounterHash
      && source?.order?.userId === userId && retained(source.order, nowMs) && !source.flow?.retentionPurgedAt
      && Number(source.flow?.round) === record.provenance.round && Number(source.draft?.round) === record.provenance.round
      && current && same(descriptor(current), record.question) && same(source.flow?.answers?.[record.question.id], record.answer)
      && (record.scope === 'candidate' || samePosting(record.provenance, { jobId: source.order.jobId, jobUrl: source.order.jobUrl }));
  });
  const verifiedIds = new Set(verified.map(record => record.id));
  const conflictRecords = [...tombstones.map(record => ({ record, metadata: answerConflictMetadata(record, record.conflict.reason, record.conflict.at) })),
    ...historical.filter(record => !verifiedIds.has(record.id)).map(record => {
      const source = sources.get(record.provenance.orderId);
      const current = source?.draft?.questions?.find(question => question?.id === record.question.id);
      const reason = Number(source?.flow?.round) !== record.provenance.round || Number(source?.draft?.round) !== record.provenance.round
        ? 'source_round_changed' : !current || !same(descriptor(current), record.question) ? 'question_changed' : 'unconfirmed_source';
      return { record, metadata: answerConflictMetadata(record, reason, record.provenance.confirmedAt) };
    })];
  return (job, { purpose = 'eligibility' } = {}) => {
    const evidence = verified.filter(record => retained(sources.get(record.provenance.orderId)?.order, nowMs + Math.max(0, Date.now() - startedAt))
      && (record.scope === 'candidate' || samePosting(record.provenance, job)) && (purpose === 'form' || record.category !== 'form_preference'))
      .sort((a, b) => a.key.localeCompare(b.key));
    const superseded = metadata => evidence.some(record => {
      const current = answerConflictMetadata(record, 'unconfirmed_source', record.provenance.confirmedAt);
      return current && record.provenance.confirmedAt > metadata.at && current.property === metadata.property
        && (metadata.property !== 'language_proficiency' || current.languageCode === metadata.languageCode)
        && (metadata.property !== 'question_answer' || current.key === metadata.key);
    });
    const applicableConflicts = conflictRecords.filter(({ record, metadata }) => metadata && !superseded(metadata)
      && sources.get(record.provenance.orderId)?.order?.userId === userId
      && sources.get(record.provenance.orderId)?.flow?.retentionPurgingAt == null && sources.get(record.provenance.orderId)?.flow?.retentionPurgedAt == null
      && retained(sources.get(record.provenance.orderId)?.order, nowMs + Math.max(0, Date.now() - startedAt))
      && (metadata.scope === 'candidate' || samePosting(record.provenance, job)));
    const answerSourceConflicts = applicableConflicts
      .map(({ metadata }) => metadata).sort((a, b) => a.key.localeCompare(b.key));
    const counterSources = new Map();
    const answerCounterContext = groupCounterContexts(evidence.map(record => {
      const source = sources.get(record.provenance.orderId);
      if (!counterSources.has(record.provenance.orderId)) {
        const context = qualificationAnswerOriginContext({ order: source.order, flow: source.flow, intake: source.intake });
        counterSources.set(record.provenance.orderId, { context, currentHash: qualificationCounterContextHash(context) });
      }
      const { context, currentHash } = counterSources.get(record.provenance.orderId);
      return { answerIds: [record.id], orderId: record.provenance.orderId, round: record.provenance.round,
        confirmedHash: record.provenance.sourceCounterHash, currentHash,
        changedSinceConfirmation: currentHash !== record.provenance.sourceCounterHash, context };
    }));
    const sourceOrderIds = [...new Set([...evidence.map(record => record.provenance.orderId), ...applicableConflicts.map(({ record }) => record.provenance.orderId)])];
    const sourceGuard = createCandidateAnswerSourceGuard({ db, profileRef: userId ? db.collection('user_cv_profiles').doc(userId) : null, profileRecord,
      sources: sourceOrderIds.flatMap(orderId => {
        const source = sources.get(orderId); const ref = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(orderId);
        return [{ ref, data: source.order }, { ref: ref.collection('automation').doc('flow'), data: source.flow },
          { ref: ref.collection('ai_drafts').doc('current'), data: source.draft }, { ref: ref.collection('automation').doc('intake'), data: source.intake }];
      }), nowMs: nowMs + Math.max(0, Date.now() - startedAt) });
    return { answers: Object.fromEntries(evidence.map(record => [record.key, record.answer])), answerEvidence: evidence, answerCounterContext, answerSourceConflicts, rawCounterAnswers,
      assertInTransaction: sourceGuard.assertInTransaction, sourceFingerprint: sourceGuard.fingerprint, sourceOrderIds,
      fingerprint: serialized({ version: ANSWER_EVIDENCE_VERSION, legacy: rawCounterAnswers, evidence, answerSourceConflicts,
        counterSources: answerCounterContext.map(({ answerIds, confirmedHash, currentHash }) => ({ answerIds, confirmedHash, currentHash })) }) };
  };
}

/** Runner reads keep the raw CAS/lease snapshot untouched and project only the execution's answer context. */
export async function loadRunnerAnswerContext({ db, orderId, order, flow, draft, intake = null, nowMs = Date.now() }) {
  const startedAt = Date.now();
  const currentTime = () => nowMs + Math.max(0, Date.now() - startedAt);
  const profileRef = order.userId ? db.collection('user_cv_profiles').doc(order.userId) : null;
  const profileRecord = profileRef ? (await profileRef.get()).data() || {} : {};
  const sources = new Map();
  const getDocument = async ref => { const snapshot = await ref.get(); sources.set(ref.path, { ref, data: snapshot.data() }); return snapshot; };
  const contextFor = await loadCandidateAnswerEvidence({ db, profileRecord, userId: order.userId, nowMs: currentTime(), getDocument });
  const local = orderId ? localAnswerEvidence({ orderId, order, flow, draft, intake, nowMs: currentTime() }) : [];
  const formContext = contextFor(order, { purpose: 'form' });
  const globalConflicts = formContext.answerSourceConflicts;
  const localConflicts = orderId ? localAnswerSourceConflicts({ orderId, order, flow, draft, intake, nowMs: currentTime() }) : [];
  const answerSourceConflicts = [...globalConflicts, ...localConflicts.filter(local => !globalConflicts.some(global => global.key === local.key
    && global.property === local.property && global.cvHash === local.cvHash))];
  const localContext = qualificationAnswerOriginContext({ order, flow, intake });
  const localHash = qualificationCounterContextHash(localContext);
  const localCounterContext = local.map(record => ({ answerIds: [record.id], orderId, round: record.provenance.round,
    confirmedHash: record.provenance.sourceCounterHash, currentHash: localHash, changedSinceConfirmation: record.sourceCounterChanged, context: localContext }));
  const verifiedLocalAnswers = Object.fromEntries(local.map(record => [record.question.id, record.answer]));
  const globalEvidence = formContext.answerEvidence;
  const localQualificationEvidence = local.flatMap(record => {
    const policy = semantics(record.question, record.answer);
    if (!policy || globalEvidence.some(global => global.provenance.confirmationId === record.id)) return [];
    // The exact local receipt is sufficient on this order, even for a guest or a failed optional profile mirror.
    // This projection is never persisted in another profile/account or reused as an arbitrary native declaration.
    return [{ ...record, key: candidateQuestionAnswerKey(record.question), ...policy,
      provenance: { ...record.provenance, confirmationId: record.id, contractHash: record.contractHash } }];
  });
  // Unattested current raw values remain on the DB snapshot for CAS. Only explicit No is retained as a conservative veto.
  const refusals = Object.fromEntries(Object.entries(flow.answers || {}).filter(([, value]) => isConsentRefusal(value)));
  const safeAnswers = { ...refusals, ...verifiedLocalAnswers };
  const answerCounterContext = groupCounterContexts([...formContext.answerCounterContext, ...localCounterContext]);
  const rawCounterContext = qualificationCounterContext({ order, flow, intake, answerCounterContext });
  return { flow: { ...flow, answers: safeAnswers, questionAnswers: { ...formContext.answers,
    ...rememberCandidateQuestionAnswers({ questions: draft?.questions || [], answers: verifiedLocalAnswers }) } },
    answerEvidence: [...globalEvidence, ...localQualificationEvidence], answerSourceConflicts, localAnswerEvidence: local,
    answerCounterContext, rawCounterContext, policyAuthority: applicationPolicyAuthority({ orderId, order, flow, nowMs: currentTime() }),
    answerSourceGuard: orderId ? createAnswerSourceGuard({ db, orderId, order, flow, draft, intake, profileRef, profileRecord, sources: [...sources.values()].filter(({ ref }) => formContext.sourceOrderIds.includes(ref.path.split('/')[1])), nowMs: currentTime() }) : null };
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
