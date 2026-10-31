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

/** Every native assertion is visible; translated copy cannot hide an owned declaration. */
export function nativeAnswerDetails(question: { question?: string; applicationQuestion?: string; originalQuestionContext?: string; originalQuestionSection?: string; ownConsentText?: string[]; ownConsentLinks?: string[] }) {
  const canonical = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  const shown = canonical(question.question || '');
  const texts = [...new Set([question.applicationQuestion || '', question.originalQuestionContext || '', question.originalQuestionSection || '', ...(Array.isArray(question.ownConsentText) ? question.ownConsentText : [])]
    .map(canonical).filter(value => value && value !== shown))];
  const links = [...new Set(Array.isArray(question.ownConsentLinks) ? question.ownConsentLinks : [])].filter(value => {
    try { return new URL(value).protocol === 'https:'; } catch { return false; }
  });
  return { texts, links };
}
