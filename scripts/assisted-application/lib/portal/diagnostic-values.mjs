/** Shared redaction and error allowlist for browser and Node diagnostics. */
const TEXT_LIMIT = 800;
export const DIAGNOSTIC_BODY_LIMIT = 64 * 1024;
export const DIAGNOSTIC_BODY_READ_LIMIT = 12;

/** Observing a slow response/frame must not hold up the application. */
export async function settleDiagnostics(tasks) {
  let timer;
  try {
    await Promise.race([
      Promise.allSettled([...tasks]),
      new Promise((resolve) => { timer = setTimeout(resolve, 2000); }),
    ]);
  } finally { clearTimeout(timer); }
}

export function hasBoundedBodyLength(raw) {
  const size = Number(raw);
  return /^[1-9]\d*$/.test(raw || '') && Number.isSafeInteger(size) && size <= DIAGNOSTIC_BODY_LIMIT;
}

export function diagnosticLocation(raw) {
  try {
    const url = new URL(raw);
    return /^https?:$/.test(url.protocol) ? { host: url.hostname, path: url.pathname.slice(0, 300) } : null;
  } catch { return null; }
}

/** No URL queries, bearer credentials, JWTs or named secrets in diagnostic text. */
export function diagnosticText(value) {
  return String(value ?? '')
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      const location = diagnosticLocation(raw);
      return location ? `${location.host}${location.path}` : '[url]';
    })
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[token]')
    .replace(/((?:password|passwd|authorization|cookie|[\w-]*token|api[_-]?key)\s*["']?\s*[:=]\s*)["']?[^\s,;"'}]+/gi, '$1[redacted]')
    .slice(0, TEXT_LIMIT);
}

/** Keep error fields, never the complete JSON response (which may contain an account). */
export function responseErrors(body, failedHttp = false) {
  const errors = [];
  const visit = (value, field = '', depth = 0) => {
    if (errors.length >= 8 || depth > 3 || value == null) return;
    if (typeof value === 'string') {
      errors.push({ message: diagnosticText(value), ...(field ? { field: diagnosticText(field) } : {}) });
    } else if (Array.isArray(value)) {
      for (const item of value.slice(0, 8)) visit(item, field, depth + 1);
    } else if (typeof value === 'object') {
      const detail = {};
      for (const key of ['code', 'errorCode', 'message', 'field', 'path']) {
        if (['string', 'number'].includes(typeof value[key])) detail[key] = diagnosticText(value[key]);
      }
      if (Object.keys(detail).length) errors.push({ ...(field ? { field: diagnosticText(field) } : {}), ...detail });
      for (const [key, item] of Object.entries(value).slice(0, 30)) {
        if (/^(error|errors|validationErrors)$/i.test(key)) visit(item, field, depth + 1);
      }
      // Validation dictionaries: { errors: { linkedin: ["Invalid URL"] } }.
      if (!Object.keys(detail).length && depth > 0) {
        for (const [key, item] of Object.entries(value).slice(0, 8)) {
          if (!/password|token|secret|cookie|authorization|api.?key/i.test(key)
            && !/^(error|errors|validationErrors)$/i.test(key)) visit(item, key, depth + 1);
        }
      }
    }
  };
  // A successful payload may itself be a token, OTP or an account's `code`.
  // Only error envelopes (or an explicit failure) are diagnostic material.
  if (failedHttp || body?.success === false || body?.ok === false || body?.errorCode != null) visit(body);
  else if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const key of ['error', 'errors', 'validationErrors']) {
      if (body[key] != null) visit(body[key], '', 1);
    }
  }
  return errors.slice(0, 8);
}
