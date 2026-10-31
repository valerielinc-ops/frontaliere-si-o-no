/** A form keeps the contracts it displayed, even while a poll fetches a newer draft. */
export interface AnswerContractSnapshot<Q extends { id: string }> {
  scope: string;
  questions: Q[];
  contracts: Record<string, string>;
}

export function captureAnswerContracts<Q extends { id: string }>(
  scope: string, questions: Q[], contracts: Record<string, string> = {},
): AnswerContractSnapshot<Q> {
  return { scope, questions: structuredClone(questions), contracts: { ...contracts } };
}

export function answerContractsChanged<Q extends { id: string }>(
  snapshot: AnswerContractSnapshot<Q>, scope: string, questions: Q[], contracts: Record<string, string> = {},
): boolean {
  if (snapshot.scope !== scope || JSON.stringify(snapshot.questions) !== JSON.stringify(questions)) return true;
  const ids = new Set([...snapshot.questions, ...questions].map(question => question.id));
  return [...ids].some(id => snapshot.contracts[id] !== contracts[id]);
}
