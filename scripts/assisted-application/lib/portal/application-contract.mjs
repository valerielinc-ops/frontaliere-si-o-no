/**
 * Bounded, candidate-safe contract for an assisted application portal.
 *
 * This is deliberately metadata-only. It records which public route and
 * background request shapes were observed, but never request bodies, headers,
 * query strings, cookies, response bodies or candidate values. The preflight
 * is read-only from the candidate's point of view; the submit observation is
 * kept separate so a later receipt cannot be confused with a preflight.
 */

export const APPLICATION_CONTRACT_VERSION = 1;
export const APPLICATION_CONTRACT_MAX_REQUESTS = 40;

const HTTP_PROTOCOLS = new Set(['https:']);
const RESOURCE_TYPES = new Set(['document', 'xhr', 'fetch', 'websocket', 'script', 'stylesheet', 'other']);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);
const PROTOCOLS = new Set(['native_form', 'server_action', 'xhr_fetch', 'candidate_handoff', 'unknown']);

function cleanText(value, limit = 240) {
  return String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim().slice(0, limit);
}
/** URL metadata without query, fragment, credentials or path tokens. */
export function safeApplicationLocation(value) {
  try {
    const url = new URL(String(value || ''));
    if (!HTTP_PROTOCOLS.has(url.protocol) || url.username || url.password) return null;
    const path = url.pathname
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu, ':id')
      .replace(/\/(?:eyJ|token|secret|session)[A-Za-z0-9._~-]{8,}/giu, '/:redacted')
      .replace(/\/\d{7,}(?=\/|$)/gu, '/:id')
      .slice(0, 300) || '/';
    return { origin: url.origin, path };
  } catch {
    return null;
  }
}
function compactLocation(value) {
  if (typeof value === 'string') return safeApplicationLocation(value);
  if (!value || typeof value !== 'object') return null;
  return safeApplicationLocation(`${String(value.origin || '')}${String(value.path || '/')}`);
}
function requestKey(item) {
  return [item.method, item.endpoint?.origin, item.endpoint?.path, item.resourceType, item.protocol || ''].join('|');
}

function protocolForRequest(item) {
  const method = String(item?.method || '').toUpperCase();
  const resourceType = String(item?.resourceType || '').toLowerCase();
  if (item?.serverAction === true) return 'server_action';
  if (method === 'POST' && resourceType === 'document') return 'native_form';
  if (['xhr', 'fetch'].includes(resourceType) && method !== 'GET') return 'xhr_fetch';
  return null;
}

function diagnosticRequestEntries(diagnostics) {
  const requests = Array.isArray(diagnostics?.requests) ? diagnostics.requests : [];
  const responses = Array.isArray(diagnostics?.responses) ? diagnostics.responses : [];
  const responseByKey = new Map();
  for (const response of responses) {
    const endpoint = safeApplicationLocation(response?.host && response?.path
      ? `https://${String(response.host).slice(0, 253)}${String(response.path).slice(0, 300)}`
      : response?.url);
    if (!endpoint) continue;
    const key = [String(response.method || '').toUpperCase(), endpoint.origin, endpoint.path, String(response.resourceType || '').toLowerCase()].join('|');
    const current = responseByKey.get(key);
    if (!current || Number(response.status) > Number(current.status || 0)) responseByKey.set(key, { status: Number(response.status) || null });
  }
  return requests.map((request) => {
    const endpoint = safeApplicationLocation(request?.host && request?.path
      ? `https://${String(request.host).slice(0, 253)}${String(request.path).slice(0, 300)}`
      : request?.url);
    if (!endpoint) return null;
    const method = String(request.method || '').toUpperCase();
    const resourceType = String(request.resourceType || '').toLowerCase();
    if (!METHODS.has(method) || !RESOURCE_TYPES.has(resourceType)) return null;
    const protocol = protocolForRequest({ ...request, method, resourceType });
    const responseKey = [method, endpoint.origin, endpoint.path, resourceType].join('|');
    return {
      method,
      endpoint,
      resourceType,
      ...(protocol ? { protocol } : {}),
      ...(responseByKey.get(responseKey)?.status ? { status: responseByKey.get(responseKey).status } : {}),
    };
  }).filter(Boolean);
}

function compactRequests(diagnostics) {
  const seen = new Map();
  for (const item of diagnosticRequestEntries(diagnostics)) {
    const key = requestKey(item);
    const current = seen.get(key);
    if (current) {
      current.count = Math.min(99, (current.count || 1) + 1);
      if (item.status && !current.status) current.status = item.status;
      continue;
    }
    seen.set(key, { ...item, count: 1 });
    if (seen.size >= APPLICATION_CONTRACT_MAX_REQUESTS) break;
  }
  return [...seen.values()];
}

function protocolFromRequests(requests, fallback = 'unknown') {
  const found = requests.map((item) => item.protocol).filter((value) => PROTOCOLS.has(value));
  if (found.includes('server_action')) return 'server_action';
  if (found.includes('xhr_fetch')) return 'xhr_fetch';
  if (found.includes('native_form')) return 'native_form';
  return PROTOCOLS.has(fallback) ? fallback : 'unknown';
}

function formSummary(snapshot) {
  const fields = Array.isArray(snapshot?.fields) ? snapshot.fields : [];
  return {
    observed: fields.length > 0,
    stable: fields.length > 0,
    fieldCount: Math.min(200, fields.length),
    requiredFieldCount: Math.min(200, fields.filter((field) => field?.required === true || field?.invalid === true).length),
    requiredFileCount: Math.min(50, fields.filter((field) => (field?.required === true || field?.invalid === true)
      && (field?.kind === 'file' || field?.inputType === 'file')).length),
  };
}
function missingSummary(questions, documents) {
  const questionList = Array.isArray(questions) ? questions : [];
  const documentList = Array.isArray(documents) ? documents : [];
  return {
    questionCount: Math.min(40, questionList.length),
    documentCount: Math.min(40, documentList.length),
    requiredQuestionCount: Math.min(40, questionList.filter((question) => question?.required !== false).length),
    requiredDocumentCount: Math.min(40, documentList.filter((document) => document?.required !== false).length),
  };
}

function compactMissing(missing) {
  if (!missing || typeof missing !== 'object') return null;
  const bounded = (value) => Math.min(40, Math.max(0, Number(value) || 0));
  return {
    questionCount: bounded(missing.questionCount),
    documentCount: bounded(missing.documentCount),
    requiredQuestionCount: bounded(missing.requiredQuestionCount),
    requiredDocumentCount: bounded(missing.requiredDocumentCount),
  };
}

function backgroundSummary(requests, { readOnly = false, observed = true } = {}) {
  const background = requests.filter((item) => ['xhr', 'fetch', 'websocket'].includes(item.resourceType));
  return {
    status: observed ? (background.some((item) => Number(item.status) >= 400) ? 'degraded' : 'observed') : 'unknown',
    readOnly,
    requestCount: Math.min(APPLICATION_CONTRACT_MAX_REQUESTS, background.length),
    requests: background.slice(0, APPLICATION_CONTRACT_MAX_REQUESTS),
    mutatingRequestCount: Math.min(APPLICATION_CONTRACT_MAX_REQUESTS,
      background.filter((item) => item.method !== 'GET' && item.method !== 'HEAD' && item.method !== 'OPTIONS').length),
  };
}

/**
 * Builds the contract emitted by the draft preflight.
 */
export function applicationContractFromPreflight({ channelType = '', applyUrl = '', sourceUrl = '', currentUrl = '',
  snapshot = null, postingMatch = 'unknown', status = 'unknown', handoff = null, questions = [], documents = [],
  diagnostics = null, submitCapability = null, observedAt = Date.now() } = {}) {
  const requests = compactRequests(diagnostics);
  const capability = submitCapability || protocolFromRequests(requests, snapshot?.fields?.length ? 'native_form' : 'unknown');
  const normalizedStatus = ['ready', 'handoff', 'blocked', 'unavailable'].includes(status) ? status : 'unknown';
  return {
    version: APPLICATION_CONTRACT_VERSION,
    phase: 'preflight',
    channel: cleanText(channelType, 60),
    applyUrl: safeApplicationLocation(applyUrl),
    sourceUrl: safeApplicationLocation(sourceUrl || applyUrl),
    currentUrl: safeApplicationLocation(currentUrl || applyUrl),
    observedAt: Number.isFinite(Number(observedAt)) ? Number(observedAt) : Date.now(),
    status: normalizedStatus,
    postingMatch: ['match', 'mismatch', 'unknown'].includes(postingMatch) ? postingMatch : 'unknown',
    ...(handoff ? { handoff: cleanText(handoff, 80) } : {}),
    form: formSummary(snapshot),
    missing: missingSummary(questions, documents),
    background: backgroundSummary(requests, { readOnly: true, observed: Boolean(diagnostics) }),
    submit: {
      capability: capability === 'unknown' && channelType === 'pastahr' ? 'candidate_handoff' : capability,
      status: 'not_started',
    },
  };
}

/** Builds the metadata-only contract observed while the runner follows the form. */
export function applicationContractFromSubmission({ channelType = '', applyUrl = '', currentUrl = '',
  diagnostics = null, outcome = null, observedAt = Date.now() } = {}) {
  const requests = compactRequests(diagnostics);
  const outcomeText = cleanText(outcome, 40);
  const confirmed = outcomeText === 'confirmed';
  return {
    version: APPLICATION_CONTRACT_VERSION,
    phase: 'submission',
    channel: cleanText(channelType, 60),
    applyUrl: safeApplicationLocation(applyUrl),
    currentUrl: safeApplicationLocation(currentUrl || applyUrl),
    observedAt: Number.isFinite(Number(observedAt)) ? Number(observedAt) : Date.now(),
    status: confirmed ? 'submitted' : 'observed',
    background: backgroundSummary(requests, { readOnly: false, observed: Boolean(diagnostics) }),
    submit: {
      capability: protocolFromRequests(requests),
      status: confirmed ? 'confirmed' : outcomeText ? outcomeText : 'unknown',
      ...(outcomeText ? { outcome: outcomeText } : {}),
    },
  };
}

/** The object safe to put on a runner event or in the draft. */
export function compactApplicationContract(contract) {
  if (!contract || typeof contract !== 'object') return null;
  const applyUrl = compactLocation(contract.applyUrl);
  const sourceUrl = compactLocation(contract.sourceUrl);
  const currentUrl = compactLocation(contract.currentUrl);
  const base = {
    version: APPLICATION_CONTRACT_VERSION,
    phase: ['preflight', 'submission'].includes(contract.phase) ? contract.phase : 'unknown',
    ...(typeof contract.channel === 'string' ? { channel: contract.channel.slice(0, 60) } : {}),
    ...(applyUrl ? { applyUrl } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(currentUrl ? { currentUrl } : {}),
    ...(Number.isFinite(Number(contract.observedAt)) ? { observedAt: Number(contract.observedAt) } : {}),
    ...(contract.status ? { status: cleanText(contract.status, 40) } : {}),
    ...(contract.postingMatch ? { postingMatch: cleanText(contract.postingMatch, 20) } : {}),
    ...(contract.handoff ? { handoff: cleanText(contract.handoff, 80) } : {}),
    ...(contract.form ? { form: {
      observed: contract.form.observed === true,
      stable: contract.form.stable === true,
      fieldCount: Math.min(200, Math.max(0, Number(contract.form.fieldCount) || 0)),
      requiredFieldCount: Math.min(200, Math.max(0, Number(contract.form.requiredFieldCount) || 0)),
      requiredFileCount: Math.min(50, Math.max(0, Number(contract.form.requiredFileCount) || 0)),
    } } : {}),
    ...(contract.missing ? { missing: compactMissing(contract.missing) } : {}),
    ...(contract.background ? {
      background: {
        status: cleanText(contract.background.status, 40) || 'unknown',
        readOnly: contract.background.readOnly === true,
        requestCount: Math.min(APPLICATION_CONTRACT_MAX_REQUESTS, Number(contract.background.requestCount) || 0),
        mutatingRequestCount: Math.min(APPLICATION_CONTRACT_MAX_REQUESTS, Number(contract.background.mutatingRequestCount) || 0),
        requests: (Array.isArray(contract.background.requests) ? contract.background.requests : []).map((item) => {
          const endpoint = safeApplicationLocation(item?.endpoint?.origin && item?.endpoint?.path
            ? `${item.endpoint.origin}${item.endpoint.path}` : '');
          const method = String(item?.method || '').toUpperCase();
          const resourceType = String(item?.resourceType || '').toLowerCase();
          if (!endpoint || !METHODS.has(method) || !RESOURCE_TYPES.has(resourceType)) return null;
          return {
            method, endpoint, resourceType,
            ...(PROTOCOLS.has(item.protocol) ? { protocol: item.protocol } : {}),
            ...(Number.isInteger(Number(item.status)) ? { status: Number(item.status) } : {}),
            ...(Number.isInteger(Number(item.count)) && Number(item.count) > 1 ? { count: Math.min(99, Number(item.count)) } : {}),
          };
        }).filter(Boolean).slice(0, APPLICATION_CONTRACT_MAX_REQUESTS),
      },
    } : {}),
    ...(contract.submit ? {
      submit: {
        capability: PROTOCOLS.has(contract.submit.capability) ? contract.submit.capability : 'unknown',
        status: cleanText(contract.submit.status, 40) || 'unknown',
        ...(contract.submit.outcome ? { outcome: cleanText(contract.submit.outcome, 40) } : {}),
      },
    } : {}),
  };
  return JSON.stringify(base).length <= 48_000 ? base : {
    ...base,
    background: base.background ? { ...base.background, requests: [] } : undefined,
  };
}

/** Merge the read-ahead contract with the contract learned during submit. */
export function mergeApplicationContracts(preflight, submission) {
  const left = compactApplicationContract(preflight);
  const right = compactApplicationContract(submission);
  if (!left) return right;
  if (!right) return left;
  return {
    ...left,
    phase: 'submission',
    observedAt: right.observedAt || left.observedAt,
    currentUrl: right.currentUrl || left.currentUrl,
    status: right.status || left.status,
    background: right.background || left.background,
    submit: right.submit || left.submit,
  };
}
