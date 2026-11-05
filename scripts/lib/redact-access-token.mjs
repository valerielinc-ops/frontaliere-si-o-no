/** Remove literal and query-encoded copies of a bearer token from diagnostics. */
export function redactAccessTokenText(value, token) {
  let message = String(value ?? '');
  const secret = String(token ?? '');
  if (!secret) return message;
  const queryEncoded = new URLSearchParams({ secret }).toString().slice('secret='.length);
  for (const candidate of [...new Set([secret, encodeURIComponent(secret), queryEncoded])]
    .sort((left, right) => right.length - left.length)) {
    if (candidate) message = message.split(candidate).join('[redacted]');
  }
  return message;
}
