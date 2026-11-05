/** Candidate/owner-safe projection of the portal application contract. */

const MAX_REQUESTS = 40;
const PROTOCOLS = new Set(['native_form', 'server_action', 'xhr_fetch', 'candidate_handoff', 'unknown']);

function text(value, max = 240) {
  return String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim().slice(0, max);
}
function location(value) {
  if (!value || typeof value !== 'object') return null;
  try {
    const url = new URL(`${String(value.origin || '')}${String(value.path || '/')}`);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return { origin: url.origin, path: url.pathname.slice(0, 300) || '/' };
  } catch {
    return null;
  }
}
function requestView(item) {
  if (!item || typeof item !== 'object') return null;
  const endpoint = location(item.endpoint);
  const method = text(item.method, 12).toUpperCase();
  const resourceType = text(item.resourceType, 20).toLowerCase();
  if (!endpoint || !/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(method)) return null;
  return {
    method,
    endpoint,
    resourceType,
    ...(PROTOCOLS.has(item.protocol) ? { protocol: item.protocol } : {}),
    ...(Number.isInteger(Number(item.status)) && Number(item.status) >= 100 && Number(item.status) <= 599 ? { status: Number(item.status) } : {}),
    ...(Number.isInteger(Number(item.count)) && Number(item.count) > 1 ? { count: Math.min(99, Number(item.count)) } : {}),
  };
}
/**
 * `includeEndpoints: false` is used by the candidate page: it exposes that
 * background traffic was checked without turning a technical inventory into
 * an unnecessary public detail.
 */
export function portalApplicationContractView(contract, { includeEndpoints = false } = {}) {
  if (!contract || typeof contract !== 'object') return null;
  const background = contract.background && typeof contract.background === 'object' ? contract.background : null;
  const submit = contract.submit && typeof contract.submit === 'object' ? contract.submit : null;
  const requests = (Array.isArray(background?.requests) ? background.requests : []).map(requestView).filter(Boolean).slice(0, MAX_REQUESTS);
  return {
    version: Number(contract.version) || 1,
    phase: ['preflight', 'submission'].includes(contract.phase) ? contract.phase : 'unknown',
    channel: text(contract.channel, 60),
    status: text(contract.status, 40) || 'unknown',
    postingMatch: text(contract.postingMatch, 20) || 'unknown',
    observedAt: Number.isFinite(Number(contract.observedAt)) ? Number(contract.observedAt) : null,
    ...(includeEndpoints && contract.handoff ? { handoff: text(contract.handoff, 80) } : {}),
    ...(contract.form && typeof contract.form === 'object' ? {
      form: {
        observed: contract.form.observed === true,
        stable: contract.form.stable === true,
        fieldCount: Math.min(200, Math.max(0, Number(contract.form.fieldCount) || 0)),
        requiredFieldCount: Math.min(200, Math.max(0, Number(contract.form.requiredFieldCount) || 0)),
        requiredFileCount: Math.min(50, Math.max(0, Number(contract.form.requiredFileCount) || 0)),
      },
    } : {}),
    ...(contract.missing && typeof contract.missing === 'object' ? {
      missing: {
        questionCount: Math.min(40, Math.max(0, Number(contract.missing.questionCount) || 0)),
        documentCount: Math.min(40, Math.max(0, Number(contract.missing.documentCount) || 0)),
        requiredQuestionCount: Math.min(40, Math.max(0, Number(contract.missing.requiredQuestionCount) || 0)),
        requiredDocumentCount: Math.min(40, Math.max(0, Number(contract.missing.requiredDocumentCount) || 0)),
      },
    } : {}),
    ...(background ? {
      background: {
        status: text(background.status, 40) || 'unknown',
        readOnly: background.readOnly === true,
        requestCount: Math.min(MAX_REQUESTS, Math.max(0, Number(background.requestCount) || 0)),
        mutatingRequestCount: Math.min(MAX_REQUESTS, Math.max(0, Number(background.mutatingRequestCount) || 0)),
        ...(includeEndpoints ? { requests } : {}),
      },
    } : {}),
    ...(submit ? {
      submit: {
        capability: PROTOCOLS.has(submit.capability) ? submit.capability : 'unknown',
        status: text(submit.status, 40) || 'unknown',
        ...(submit.outcome ? { outcome: text(submit.outcome, 40) } : {}),
      },
    } : {}),
  };
}
