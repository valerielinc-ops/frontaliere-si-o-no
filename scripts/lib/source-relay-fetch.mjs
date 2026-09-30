#!/usr/bin/env node

import { readBoundedResponseBytes } from './bounded-response-body.mjs';

export const SOURCE_RELAY_OIDC_AUDIENCE = 'frontaliere-jobs-source-relay';
export const SOURCE_RELAY_TIMEOUT_MS = 20_000;
export const SOURCE_RELAY_MAX_ATTEMPTS = 3;
export const SOURCE_RELAY_RETRY_DELAY_MS = 1_200;
export const SOURCE_RELAY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const GITHUB_OIDC_REQUEST_HOST = 'token.actions.githubusercontent.com';

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envValue(env, name) {
  const value = env?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function relayTimeoutMs(timeoutMs, env) {
  return positiveNumber(
    timeoutMs ?? envValue(env, 'JOBS_SOURCE_RELAY_TIMEOUT_MS'),
    SOURCE_RELAY_TIMEOUT_MS,
  );
}

function relayDeadline(timeoutMs) {
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  const timeoutError = new Error('source_relay_deadline_exceeded');
  timeoutError.code = 'source_relay_deadline_exceeded';
  let rejectTimeout;
  const timeoutPromise = new Promise((_, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    rejectTimeout(timeoutError);
  }, timeoutMs);

  return {
    controller,
    deadlineAt,
    timeoutError,
    timeoutPromise,
    clear() {
      clearTimeout(timer);
    },
  };
}

function assertRelayDeadline(deadline) {
  if (deadline.controller.signal.aborted || Date.now() >= deadline.deadlineAt) {
    throw deadline.timeoutError;
  }
}

function withinRelayDeadline(value, deadline) {
  assertRelayDeadline(deadline);
  return Promise.race([value, deadline.timeoutPromise]);
}

function fetchWithinRelayDeadline(fetchImpl, input, init, deadline) {
  return withinRelayDeadline(
    Promise.resolve().then(() => fetchImpl(input, {
      ...init,
      signal: deadline.controller.signal,
    })),
    deadline,
  );
}

function sleepWithinRelayDeadline(delayMs, deadline) {
  assertRelayDeadline(deadline);
  const remainingMs = Math.max(0, deadline.deadlineAt - Date.now());
  const effectiveDelayMs = Math.min(Math.max(0, Number(delayMs) || 0), remainingMs);
  if (effectiveDelayMs <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      deadline.controller.signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(deadline.timeoutError);
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, effectiveDelayMs);
    deadline.controller.signal.addEventListener('abort', onAbort, { once: true });
  });
}

function responseHeader(response, name) {
  return typeof response?.headers?.get === 'function'
    ? response.headers.get(name)
    : null;
}

function retryAfterMs(response, fallbackMs) {
  const header = responseHeader(response, 'retry-after');
  if (!header) return fallbackMs;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const dateMs = Date.parse(header);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : fallbackMs;
}

function relayErrorCode(text) {
  if (typeof text !== 'string') return '';
  try {
    const payload = JSON.parse(text);
    return typeof payload?.error === 'string' ? payload.error : '';
  } catch {
    return '';
  }
}

async function readRelayBody(response, deadline) {
  const contentLength = Number.parseInt(responseHeader(response, 'content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength > SOURCE_RELAY_MAX_RESPONSE_BYTES) {
    throw new Error('source_relay_response_too_large');
  }

  if (typeof response?.body?.getReader === 'function') {
    const bytes = await withinRelayDeadline(
      readBoundedResponseBytes(response, SOURCE_RELAY_MAX_RESPONSE_BYTES),
      deadline,
    );
    if (bytes === null) throw new Error('source_relay_response_too_large');
    return new TextDecoder().decode(bytes);
  }

  if (typeof response?.text === 'function') {
    const text = await withinRelayDeadline(
      Promise.resolve().then(() => response.text()),
      deadline,
    );
    if (typeof text !== 'string') throw new Error('source_relay_body_unreadable');
    if (Buffer.byteLength(text, 'utf8') > SOURCE_RELAY_MAX_RESPONSE_BYTES) {
      throw new Error('source_relay_response_too_large');
    }
    return text;
  }

  throw new Error('source_relay_body_unreadable');
}

async function requestGithubOidcToken({
  fetchImpl,
  env,
  audience = SOURCE_RELAY_OIDC_AUDIENCE,
  deadline,
  timeoutMs,
}) {
  const requestUrl = envValue(env, 'ACTIONS_ID_TOKEN_REQUEST_URL');
  const requestToken = envValue(env, 'ACTIONS_ID_TOKEN_REQUEST_TOKEN');
  if (!requestUrl || !requestToken) return null;

  const ownedDeadline = deadline || relayDeadline(relayTimeoutMs(timeoutMs, env));

  try {
    const tokenUrl = new URL(requestUrl);
    if (
      tokenUrl.protocol !== 'https:'
      || tokenUrl.hostname !== GITHUB_OIDC_REQUEST_HOST
      || tokenUrl.username
      || tokenUrl.password
      || tokenUrl.port
    ) throw new Error('github_oidc_request_url_not_allowed');
    tokenUrl.searchParams.set('audience', audience);
    const response = await fetchWithinRelayDeadline(fetchImpl, tokenUrl, {
      method: 'GET',
      headers: {
        Authorization: `bearer ${requestToken}`,
        Accept: 'application/json',
      },
    }, ownedDeadline);
    if (!response?.ok) throw new Error(`github_oidc_token_${response?.status || 'unavailable'}`);
    const payload = await withinRelayDeadline(
      Promise.resolve().then(() => response.json()),
      ownedDeadline,
    );
    if (typeof payload?.value !== 'string' || !payload.value) throw new Error('github_oidc_token_missing');
    return payload.value;
  } finally {
    if (!deadline) ownedDeadline.clear();
  }
}

/**
 * Fetch one allowlisted source URL through Firebase when direct egress fails.
 * An unset JOBS_SOURCE_RELAY_URL is deliberately a no-op so local runs and
 * workflows without the second-step wiring retain their existing behavior.
 * A successful relay response is returned as { status, text } after bounded
 * body consumption, not as a live Response whose body could outlive the deadline.
 */
export async function fetchSourceViaRelay(
  sourceUrl,
  {
    relayUrl,
    fetchImpl = globalThis.fetch,
    env = process.env,
    audience = SOURCE_RELAY_OIDC_AUDIENCE,
    timeoutMs,
    retryDelayMs = SOURCE_RELAY_RETRY_DELAY_MS,
  } = {},
) {
  const configuredRelayUrl = envValue(
    { JOBS_SOURCE_RELAY_URL: relayUrl ?? env?.JOBS_SOURCE_RELAY_URL },
    'JOBS_SOURCE_RELAY_URL',
  );
  if (!configuredRelayUrl) return null;

  const deadline = relayDeadline(relayTimeoutMs(timeoutMs, env));
  try {
    const endpoint = new URL(configuredRelayUrl);
    if (endpoint.protocol !== 'https:') throw new Error('relay_url_must_use_https');
    if (typeof sourceUrl !== 'string' || !sourceUrl) throw new Error('source_url_missing');

    const token = await requestGithubOidcToken({ fetchImpl, env, audience, deadline });
    if (!token) {
      console.warn('  ⚠️ Source relay configured but GitHub Actions OIDC is unavailable; keeping direct-fetch behavior.');
      return null;
    }

    endpoint.searchParams.set('url', sourceUrl);
    let response = await fetchWithinRelayDeadline(fetchImpl, endpoint, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'text/html, application/json',
      },
    }, deadline);
    let text = await readRelayBody(response, deadline);

    for (let attempt = 1; attempt < SOURCE_RELAY_MAX_ATTEMPTS && response?.status === 429; attempt += 1) {
      const errorCode = relayErrorCode(text);
      if (errorCode === 'daily_cap') return null;
      if (errorCode !== 'rate_limited') return { status: response?.status, text };
      await sleepWithinRelayDeadline(retryAfterMs(response, retryDelayMs), deadline);
      response = await fetchWithinRelayDeadline(fetchImpl, endpoint, {
        method: 'GET',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'text/html, application/json',
        },
      }, deadline);
      text = await readRelayBody(response, deadline);
    }

    if (response?.status === 429 && relayErrorCode(text) === 'daily_cap') return null;
    return { status: response?.status, text };
  } catch (error) {
    console.warn(`  ⚠️ Source relay fetch failed: ${error?.message || error}`);
    return null;
  } finally {
    deadline.clear();
  }
}

export { requestGithubOidcToken };
