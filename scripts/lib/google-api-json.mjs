/**
 * Chiamata JSON autenticata (Bearer) a un'API Google Cloud, con timeout ed
 * errore leggibile: metodo, URL senza query, status HTTP, `reason` e messaggio
 * di Google. Su 403 aggiunge `forbiddenHint`, che nomina il ruolo IAM mancante.
 *
 * Estratta da scripts/ci/provision-pagespeed-key.mjs quando
 * scripts/ci/run-plate-auctions-function.mjs ne avrebbe fatto una seconda
 * copia: una correzione (timeout, parsing dell'errore) deve valere per tutti.
 *
 * @returns {Promise<{ json: any, response: Response }>}
 */
export async function googleApiJson(fetchImpl, url, {
  token,
  method = 'GET',
  body,
  forbiddenHint = '',
  ErrorClass = Error,
  timeoutMs = 60_000,
} = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch { json = null; }
  if (!response.ok) {
    const message = json?.error?.message || text.slice(0, 300);
    const reason = json?.error?.details?.find?.((detail) => detail?.reason)?.reason;
    const hint = response.status === 403 && forbiddenHint ? ` — ${forbiddenHint}` : '';
    throw new ErrorClass(`${method} ${url.replace(/\?.*$/u, '')} → HTTP ${response.status}${reason ? ` ${reason}` : ''}: ${message}${hint}`);
  }
  return { json: json ?? {}, response };
}
