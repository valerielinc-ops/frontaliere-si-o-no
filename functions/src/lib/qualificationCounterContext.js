/** Complete raw correction material used by both a qualification witness and its pre-send fence. */
export function qualificationCounterContext({ order = {}, flow = {}, intake = null } = {}) {
  return structuredClone({ values: flow.answers || {}, questionAnswers: flow.questionAnswers || {},
    corrections: flow.formOverrides || {}, feedback: flow.feedback || [],
    candidateNotes: order.candidateNotes || '', flowNotes: flow.candidateNotes || '', intakeNotes: intake?.emailNotes || '' });
}
