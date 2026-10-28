/**
 * Morss page egress proxy for sources that reject GitHub Actions IPs.
 *
 * Morss is already used by the Stadt Chur crawler for the same class of
 * datacenter-egress failure. The `:get=page` endpoint returns the target HTML
 * instead of converting it to an RSS feed, which keeps HTML job parsers
 * unchanged. Callers must validate the returned body against the target's
 * identity markers before consuming it.
 */

export const MORSS_PAGE_BASE = 'https://morss.it/:get=page/';

export function morssProxiedUrl(targetUrl = '') {
  const value = String(targetUrl || '').trim();
  if (!/^https?:\/\//i.test(value)) return '';
  return `${MORSS_PAGE_BASE}${value}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch target HTML through Morss with bounded retries.
 *
 * A fresh request is used for every attempt so the proxy can recover from a
 * transient upstream timeout. The response body is buffered and wrapped in a
 * new Response because the caller needs a body whose lifetime is independent
 * from the proxy request's timeout controller.
 */
export async function fetchViaMorssWithRetry(
  targetUrl,
  {
    timeoutMs = 30_000,
    attempts = 2,
    retryDelayMs = 800,
    fetchImpl = fetch,
  } = {},
) {
  const proxyUrl = morssProxiedUrl(targetUrl);
  if (!proxyUrl) return null;

  const maxAttempts = Math.max(1, Number.isFinite(attempts) ? Math.floor(attempts) : 2);
  const requestTimeoutMs = Math.max(1_000, Number(timeoutMs) || 30_000);
  const delayMs = Number.isFinite(retryDelayMs) ? Math.max(0, retryDelayMs) : 800;
  let lastReason = 'unknown Morss proxy failure';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(proxyUrl, {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        lastReason = `HTTP ${response.status}`;
      } else {
        const body = await response.text();
        if (body.trim()) {
          return new Response(body, {
            status: response.status,
            headers: {
              'content-type': response.headers.get('content-type') || 'text/html',
              'x-frontaliere-egress': 'morss',
            },
          });
        }
        lastReason = 'empty response body';
      }
    } catch (error) {
      lastReason = error?.message || String(error);
    } finally {
      clearTimeout(timer);
    }

    if (attempt < maxAttempts) await sleep(delayMs * attempt);
  }

  console.warn(`⚠️ Morss proxy exhausted for ${targetUrl} (${lastReason}).`);
  return null;
}

export async function fetchHtmlViaMorssWithRetry(targetUrl, options = {}) {
  const response = await fetchViaMorssWithRetry(targetUrl, options);
  if (!response?.ok) return null;
  return response.text();
}
