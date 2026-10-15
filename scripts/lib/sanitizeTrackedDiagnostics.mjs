const SENSITIVE_QUERY_KEYS = new Set([
  'ac',
  'api_key',
  'apikey',
  'auth',
  'client_secret',
  'email',
  'key',
  'ne',
  'secret',
  'sig',
  'signature',
  'token',
  'access_token',
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const OPAQUE_SECRET_RE = /^[a-f0-9]{32,}$/i;
const REDACTED_QUERY_VALUE = 'x';

export function sanitizeTrackedDiagnosticValue(value) {
  if (typeof value === 'string') return sanitizeUrlLikeText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeTrackedDiagnosticValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeTrackedDiagnosticValue(item)])
    );
  }
  return value;
}

export function sanitizeUrlLikeText(text) {
  return text.replace(/https?:\/\/[^\s"'<>]+/g, (urlText) => sanitizeUrl(urlText));
}

function sanitizeUrl(urlText) {
  try {
    const url = new URL(urlText);
    const sensitiveKeys = [];

    for (const [key, value] of url.searchParams.entries()) {
      if (isSensitiveQueryParam(key, value)) sensitiveKeys.push(key);
    }

    for (const key of sensitiveKeys) {
      url.searchParams.set(key, REDACTED_QUERY_VALUE);
    }

    return url.toString();
  } catch {
    return urlText;
  }
}

function isSensitiveQueryParam(key, value) {
  const normalizedKey = key.toLowerCase().replace(/-/g, '_');
  return (
    SENSITIVE_QUERY_KEYS.has(normalizedKey) ||
    normalizedKey.includes('token') ||
    normalizedKey.includes('secret') ||
    normalizedKey.includes('signature') ||
    EMAIL_RE.test(value) ||
    OPAQUE_SECRET_RE.test(value)
  );
}
