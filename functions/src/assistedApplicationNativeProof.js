/** Private server verification of native form answers; never accepts a model question as DOM authority. */
import { qualificationCounterContextHash } from './lib/qualificationCounterContext.js';
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

/** A full form is verified from server-derived coverage, never a client-selected claim subset. */
export async function verifyNativeApplicationProof({ proof, context, docsManifest = [], generate = generateQualificationJson, signal = null }) {
  const deadline = AbortSignal.timeout(PROOF_BUDGET_MS);
  const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let ownedProof; let ownedContext; let ownedManifest; let initialInputHash; let ownedCatalog;
  const inputHash = () => qualificationCounterContextHash({ proof, docsManifest,
    context: { ...context, sources: undefined }, sources: context?.sources?.evidenceCatalog?.() });
  try {
    initialInputHash = inputHash();
    ownedProof = structuredClone(proof);
    ownedManifest = structuredClone(docsManifest);
    ownedCatalog = structuredClone(context.sources.evidenceCatalog());
    ownedContext = structuredClone({ ...context, sources: undefined });
    ownedContext.sources = { evidenceCatalog: () => structuredClone(ownedCatalog) };
  } catch { return unknown('invalid_input'); }
  if (!ownedProof || ownedProof.version !== 'owner-native-proof-v1' || !Array.isArray(ownedProof.fields)
    || !Array.isArray(ownedProof.attachments) || ownedProof.attachments.length > 82 || !ownedProof.fields.length
    || !Number.isSafeInteger(ownedProof.round) || ownedProof.round < 1 || ownedProof.round !== ownedContext.scope?.round
    || typeof ownedProof.frameUrl !== 'string' || !ownedProof.target || Object.hasOwn(ownedProof, 'claims')) return unknown('native_proof_shape');
  let target; let policy;
  try {
    cancellation.throwIfAborted();
    const [{ validateNativeApplicationTarget, canonicalNativeApplicationFrameUrl }, sharedPolicy] = await Promise.all([
      import('./lib/nativeApplicationTarget.js'), import('./lib/nativeApplicationPolicy.js'),
    ]);
    policy = sharedPolicy;
    const sourceUrl = ownedContext.scope?.primaryPostingUrl || ownedContext.scope?.jobUrl;
    if (typeof sourceUrl !== 'string' || !sourceUrl) return unknown('native_target_unverified');
    target = validateNativeApplicationTarget({ target: ownedProof.target,
      expected: { applyUrl: sourceUrl, sourceProtocol: ownedContext.scope?.sourceProtocol || null } });
    if (target?.owned !== true || target.binding?.frameUrl !== canonicalNativeApplicationFrameUrl(ownedProof.frameUrl)) return unknown('native_target_unverified');
  } catch { return unknown(cancellation.aborted ? 'proof_deadline' : 'native_target_unverified'); }
  let verifiedDocumentTransports = [];
  try {
    const extras = ownedProof.attachments.filter(item => !['cv', 'cover_letter'].includes(item?.slot));
    if (extras.length) {
      const { resolveNativeDocumentTransport } = await import('./lib/nativeDocumentTransport.js');
      for (const fieldId of new Set(extras.map(item => item?.fieldId))) {
        const attachments = extras.filter(item => item?.fieldId === fieldId);
        const fields = ownedProof.fields.filter(field => field?.fieldId === fieldId);
        if (fields.length !== 1) return unknown('native_attachment_unverified');
        const contract = fields[0].nativeFormContract;
        const files = [];
        for (const attachment of attachments) {
          const documents = ownedManifest.filter(item => item?.slot === attachment.slot && item.sha256 === attachment.sha256 && item.size === attachment.size);
          if (documents.length !== 1) return unknown('native_attachment_unverified');
          const document = documents[0];
          files.push({ ...attachment, documentId: document.documentId, fileId: document.fileId, generation: document.generation });
        }
        const selection = contract?.validation?.multiple === true ? { fieldId, files } : files.length === 1 ? files[0] : null;
        if (!selection) return unknown('native_attachment_unverified');
        const resolved = resolveNativeDocumentTransport({
          scope: { orderId: ownedContext.scope?.orderId, round: ownedProof.round,
            jobId: ownedContext.scope?.jobId || null, sourceJobUrl: ownedContext.scope?.jobUrl },
          target: { expectedApplyUrl: ownedContext.scope.primaryPostingUrl || ownedContext.scope.jobUrl, frameUrl: target.binding.frameUrl,
            fieldId, multiple: contract?.validation?.multiple === true },
          nativeField: { fieldId, frameUrl: target.binding.frameUrl, nativeFormContract: contract },
          attachment: selection,
          documents: ownedManifest,
        });
        if (resolved.status !== 'verified') return unknown(resolved.reason || 'native_attachment_unverified');
        verifiedDocumentTransports.push(resolved);
      }
    }
  } catch { return unknown('native_attachment_unverified'); }
  let derived;
  try {
    derived = policy.deriveNativeApplicationClaims({ proof: ownedProof, context: ownedContext,
      docsManifest: ownedManifest, verifiedDocumentTransports, targetVerified: true });
  } catch { return unknown('native_policy_unknown'); }
  if (derived?.status !== 'ready') return unknown(derived?.failure || 'native_policy_unknown');
  if (!Array.isArray(derived.claims) || derived.claims.length > policy.NATIVE_APPLICATION_MAX_CLAIMS || policy.NATIVE_APPLICATION_MAX_CLAIMS !== 24 || !Array.isArray(derived.coverage)
    || derived.coverage.length !== ownedProof.fields.length
    || new Set(derived.coverage.map(item => item.fieldId)).size !== ownedProof.fields.length) return unknown('native_coverage_unverified');
  const checks = [];
  const boundedGenerate = async (system, user, schema, options = {}) => {
    cancellation.throwIfAborted();
    let abort;
    const canceled = new Promise((_, reject) => {
      abort = () => reject(cancellation.reason);
      cancellation.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([generate(system, user, schema, { ...options, signal: cancellation }), canceled]); }
    finally { cancellation.removeEventListener('abort', abort); }
  };
  for (let offset = 0; offset < derived.claims.length; offset += 12) {
    if (cancellation.aborted) return unknown('proof_deadline');
    const result = await verifyNativeApplicationClaims({ claims: derived.claims.slice(offset, offset + 12), context: ownedContext,
      generate: boundedGenerate, signal: cancellation });
    if (result.status !== 'supported') return result;
    checks.push(...result.verification.checks);
  }
  if (cancellation.aborted) return unknown('proof_deadline');
  try { if (inputHash() !== initialInputHash) return unknown('input_changed'); }
  catch { return unknown('input_changed'); }
  return { status: 'supported', verification: { version: 'full-native-application-proof-v1', status: 'supported',
    assessmentHash: qualificationCounterContextHash({ version: 'full-native-application-proof-v1',
      policyVersion: policy.NATIVE_APPLICATION_POLICY_VERSION || 'native-application-policy-v1',
      proof: ownedProof, coverage: derived.coverage, inputHash: initialInputHash, target, verifiedDocumentTransports }),
    checks, coverage: derived.coverage } };
}
