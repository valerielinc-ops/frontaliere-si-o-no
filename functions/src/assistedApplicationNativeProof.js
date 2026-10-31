/** Private server verification of native form answers; never accepts a model question as DOM authority. */
import { generateQualificationJson } from './lib/qualificationGenerate.js';
import { nativeFormAssessmentHash, NATIVE_FORM_ENTAILMENT_VERSION, verifyNativeFormAnswers } from './lib/qualificationEvidence.js';

const PROOF_BUDGET_MS = 90_000;
const unknown = failure => ({ status: 'unverified', reason: 'evidence_entailment_unverified', verification: {
  version: NATIVE_FORM_ENTAILMENT_VERSION, status: 'unverified', failure,
} });

export async function verifyNativeApplicationClaims({ claims, context, generate = generateQualificationJson, signal = null }) {
  if (!context?.sources?.evidenceCatalog || !context.scope) return unknown('proof_context_unavailable');
  const deadline = AbortSignal.timeout(PROOF_BUDGET_MS);
  const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let initialHash;
  try { initialHash = nativeFormAssessmentHash({ claims, sources: context.sources, scope: context.scope, unverifiedContext: context.unverifiedContext }); }
  catch { return unknown('invalid_input'); }
  const boundedGenerate = async (system, user, schema, options = {}) => {
    cancellation.throwIfAborted();
    let abort;
    const canceled = new Promise((_, reject) => {
      abort = () => reject(cancellation.reason);
      cancellation.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([generate(system, user, schema, { ...options, signal: cancellation }), canceled]);
    } finally { cancellation.removeEventListener('abort', abort); }
  };
  const result = await verifyNativeFormAnswers({ claims, sources: context.sources, scope: context.scope,
    unverifiedContext: context.unverifiedContext, generate: boundedGenerate });
  if (cancellation.aborted) return unknown('proof_deadline');
  try {
    const currentHash = nativeFormAssessmentHash({ claims, sources: context.sources, scope: context.scope, unverifiedContext: context.unverifiedContext });
    if (currentHash !== initialHash || (result.status === 'supported' && result.verification?.assessmentHash !== currentHash)) return unknown('input_changed');
  } catch { return unknown('input_changed'); }
  return result;
}
