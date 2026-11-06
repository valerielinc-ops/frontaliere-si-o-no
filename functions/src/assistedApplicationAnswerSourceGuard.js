import { createHash } from 'node:crypto';
import { answerCvFingerprint, answerCvIdentity, answerEvidenceFingerprint, ANSWER_CONFIRMATION_VERSION } from './assistedApplicationAnswerConfirmation.js';
import { answerQuestionSnapshotHash, loadRunnerAnswerContext } from './assistedApplicationAnswerEvidence.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function targetFingerprint({ orderId, order = {}, flow = {}, draft = {}, nowMs = Date.now() } = {}) {
  const questions = (Array.isArray(draft.questions) ? draft.questions : []).map(question => ({
    id: String(question?.id || ''),
    snapshot: answerQuestionSnapshotHash({ orderId, question, draft, nowMs }),
  })).sort((a, b) => a.id.localeCompare(b.id));
  return digest({ version: ANSWER_CONFIRMATION_VERSION, orderId: String(orderId || ''), userId: String(order.userId || ''),
    jobId: String(order.jobId || ''), jobUrl: String(order.jobUrl || ''), round: Number(flow.round || 1),
    cvIdentity: answerCvIdentity(order), draftCvKey: String(draft.cvKey || ''),
    cvFingerprint: answerCvFingerprint({ order, draft }), questions,
    localAnswerState: digest({ answers: object(flow.answers), questionAnswers: object(flow.questionAnswers),
      questionAnswerSnapshots: object(flow.questionAnswerSnapshots), questionAnswerSnapshotIds: object(flow.questionAnswerSnapshotIds),
      questionAnswerCompatibility: object(flow.questionAnswerCompatibility),
      questionAnswerConfirmationHashes: object(flow.questionAnswerConfirmationHashes), questionAnswerSources: object(flow.questionAnswerSources),
      orderQuestionAnswersEvidenceVersion: flow.orderQuestionAnswersEvidenceVersion || null }),
  });
}

/** Captures only digests; answer values and question text never enter the durable submit guard. */
export function createAnswerSourceGuard({ orderId, order = {}, flow = {}, draft = {}, answerEvidence = [], nowMs = Date.now() } = {}) {
  return {
    version: ANSWER_CONFIRMATION_VERSION,
    targetFingerprint: targetFingerprint({ orderId, order, flow, draft, nowMs }),
    evidenceFingerprint: answerEvidenceFingerprint(answerEvidence),
  };
}

/** Re-read the target and every evidence source in the submission transaction before an irreversible action. */
export async function answerSourceGuardMatches({ db, transaction, guard, orderId, order = {}, flow = {}, draft = {}, nowMs = Date.now() } = {}) {
  if (!guard) return true;
  if (guard.version !== ANSWER_CONFIRMATION_VERSION
    || !/^[a-f0-9]{64}$/.test(guard.targetFingerprint || '')
    || !/^[a-f0-9]{64}$/.test(guard.evidenceFingerprint || '')
    || targetFingerprint({ orderId, order, flow, draft, nowMs }) !== guard.targetFingerprint) return false;
  const context = await loadRunnerAnswerContext({ db, orderId, order, flow, draft, nowMs,
    getDocument: ref => transaction.get(ref) });
  return answerEvidenceFingerprint(context.answerEvidence) === guard.evidenceFingerprint;
}
