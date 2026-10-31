/** Finite, candidate-free evidence vocabulary shared by runner and dispatcher. */
const CAPTCHA_STOPS = new Set(['captcha', 'portal_needs_candidate', 'portal_antibot', 'captcha_provider_unavailable']);
const NODE_NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT']);
const BROWSER_NETWORK_CODE = /^ERR_(?:NAME_NOT_RESOLVED|CONNECTION_(?:RESET|CLOSED|REFUSED|TIMED_OUT)|NETWORK_CHANGED|INTERNET_DISCONNECTED|TIMED_OUT)$/;

function nopechaObservation(entry, attempt) {
  const host = String(entry?.host || '').toLowerCase(); const path = String(entry?.path || '');
  const status = Number(entry?.status); const providerStatus = path === '/v1/status';
  if (!/^api\.nopecha\.com(?::443)?$/.test(host)) return null;
  const contextStatus = providerStatus && entry?.attempt == null;
  if (!contextStatus && (!Number.isSafeInteger(attempt) || attempt < 1 || entry?.attempt !== attempt)) return null;
  const solve = /^\/v1\/(?:recognition|token)\/(?:turnstile|recaptcha|hcaptcha)\/?$/.test(path);
  const known403 = status === 403 && (providerStatus || solve) && (Array.isArray(entry.errors) ? entry.errors : []).find(error =>
    [12, 16].includes(Number(error?.code)) || /^(banned\s+ip|out\s+of\s+credit)$/i.test(String(error?.message || '').trim()));
  if (!known403 && !(solve && (status === 429 || (status >= 500 && status < 600)))) return null;
  return { host: 'api.nopecha.com', path, status, ...(contextStatus ? {} : { attempt }),
    ...(known403 ? { errors: [{ code: Number(known403.code) === 16 || /out\s+of\s+credit/i.test(known403.message || '') ? 16 : 12 }] } : {}) };
}

export function captchaInfrastructureProof(reason, { diagnostics, attempt, finalClickAttempted = false } = {}) {
  if (finalClickAttempted || !CAPTCHA_STOPS.has(reason)) return null;
  for (const entry of Array.isArray(diagnostics?.responses) ? diagnostics.responses : []) {
    const observation = nopechaObservation(entry, attempt);
    if (observation) return { schema: 'portal_infrastructure_v1', phase: 'pre_submit', source: 'nopecha_response',
      class: 'captcha_provider_unavailable', observation };
  }
  return null;
}

export function navigationInfrastructureProof(error, { finalClickAttempted = false } = {}) {
  if (finalClickAttempted) return null;
  let code = error?.code || error?.cause?.code;
  if (!NODE_NETWORK_CODES.has(code)) code = /^page\.goto:\s+(?:net::)?(ERR_[A-Z_]+)/.exec(String(error?.message || ''))?.[1];
  if (!NODE_NETWORK_CODES.has(code) && !BROWSER_NETWORK_CODE.test(code || '')) {
    if (error?.name === 'TimeoutError' && /^page\.goto:/.test(error.message || '')) code = 'NAVIGATION_TIMEOUT';
    else return null;
  }
  return { schema: 'portal_infrastructure_v1', phase: 'pre_submit', source: 'browser_navigation', class: 'navigation_unavailable', code };
}

/** Reject generic model/operator text, post-click observations and invented provider fields. */
export function verifiedInfrastructureProof(proof) {
  if (proof?.schema !== 'portal_infrastructure_v1' || proof.phase !== 'pre_submit') return null;
  if (proof.source === 'nopecha_response' && proof.class === 'captcha_provider_unavailable') {
    const observation = nopechaObservation(proof.observation, proof.observation?.attempt);
    return observation ? { schema: proof.schema, phase: proof.phase, source: proof.source, class: proof.class, observation } : null;
  }
  if (proof.source === 'browser_navigation' && proof.class === 'navigation_unavailable'
    && (NODE_NETWORK_CODES.has(proof.code) || BROWSER_NETWORK_CODE.test(proof.code || '') || proof.code === 'NAVIGATION_TIMEOUT')) {
    return { schema: proof.schema, phase: proof.phase, source: proof.source, class: proof.class, code: proof.code };
  }
  return null;
}

export function infrastructureReasonForEvent(reason, proof) {
  const verified = verifiedInfrastructureProof(proof);
  if (verified?.class === 'captcha_provider_unavailable' && CAPTCHA_STOPS.has(reason)) return verified.class;
  if (verified?.class === 'navigation_unavailable' && reason === 'navigation_unavailable') return verified.class;
  return null;
}
