/** Complete raw correction material used by both a qualification witness and its pre-send fence. */
import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export const qualificationCounterContextHash = value => createHash('sha256').update(String(JSON.stringify(canonical(value)))).digest('hex');

export function qualificationCounterContext({ order = {}, flow = {}, intake = null, answerCounterContext = [] } = {}) {
  return structuredClone({ values: flow.answers || {}, questionAnswers: flow.questionAnswers || {},
    corrections: flow.formOverrides || {}, feedback: flow.feedback || [],
    candidateNotes: order.candidateNotes || '', flowNotes: flow.candidateNotes || '', intakeNotes: intake?.emailNotes || '',
    // Source IDs/rounds bind raw origin corrections to an attested assertion;
    // they never turn a note into primary proof. Private source-order IDs are omitted.
    answerSources: answerCounterContext.filter(source => source.changedSinceConfirmation).map(source => ({
      answerIds: source.answerIds, round: source.round, confirmedHash: source.confirmedHash, currentHash: source.currentHash,
      changedSinceConfirmation: source.changedSinceConfirmation, context: source.context,
    })) });
}

/** The attested question/value is checked separately; derived answer-cache updates are not new corrections. */
export function qualificationAnswerOriginContext({ order = {}, flow = {}, intake = null } = {}) {
  return qualificationCounterContext({ order, flow: { ...flow, answers: {}, questionAnswers: {} }, intake });
}
