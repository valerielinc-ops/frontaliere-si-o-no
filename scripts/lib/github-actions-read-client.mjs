export const GITHUB_ACTIONS_READ_ATTEMPTS = 3;
export const MAX_GITHUB_ACTIONS_JSON_BYTES = 1024 * 1024;
export const MAX_GITHUB_ACTIONS_BACKOFF_MS = 5_000;

export class GitHubActionsReadError extends Error {
  constructor(code, message = code, status = null) {
    super(`${code}: ${message}`);
    this.name = 'GitHubActionsReadError';
    this.code = code;
    this.status = status;
  }
}

export function isMissingExactGitHubResource(error) {
  return error instanceof GitHubActionsReadError
    && error.code === 'github_api_failed'
    && error.status === 404;
}

function retryAfterMilliseconds(response, attempt) {
  const value = response.headers.get('retry-after');
  if (value !== null) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_GITHUB_ACTIONS_BACKOFF_MS, Math.round(seconds * 1_000));
    }
    const date = Date.parse(value);
    if (Number.isFinite(date)) {
      return Math.min(MAX_GITHUB_ACTIONS_BACKOFF_MS, Math.max(0, date - Date.now()));
    }
  }
  return Math.min(MAX_GITHUB_ACTIONS_BACKOFF_MS, attempt * 1_000);
}

/**
 * The artifact `/zip` endpoint answers 302 towards blob storage, so exactly one
 * hop is followed. It must stay HTTPS and it must not carry the bearer token:
 * the storage host is outside GitHub and never sees our credentials.
 */
function redirectTarget(response) {
  const location = response.headers.get('location');
  if (typeof location !== 'string' || location.length === 0) return null;
  try {
    const url = new URL(location);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function transientResponse(response) {
  return response.status === 429
    || (response.status >= 500 && response.status <= 599)
    || (response.status === 403 && response.headers.has('retry-after'));
}

async function readBoundedResponse(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new GitHubActionsReadError('github_response_too_large');
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch { /* the cap remains authoritative */ }
        throw new GitHubActionsReadError('github_response_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createGitHubActionsReadClient({
  apiUrl,
  token,
  apiVersion = '2026-03-10',
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  timeoutMs = 30_000,
} = {}) {
  if (typeof apiUrl !== 'string' || !/^https:\/\//.test(apiUrl)
      || typeof token !== 'string' || token.length === 0
      || typeof apiVersion !== 'string' || apiVersion.length === 0
      || typeof fetchImpl !== 'function' || typeof sleep !== 'function'
      || !Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('invalid_github_actions_read_client');
  }
  const root = apiUrl.replace(/\/$/, '');

  const bytes = async (pathname, maxBytes = MAX_GITHUB_ACTIONS_JSON_BYTES) => {
    if (typeof pathname !== 'string' || !pathname.startsWith('/repos/')
        || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_GITHUB_ACTIONS_JSON_BYTES) {
      throw new TypeError('invalid_github_actions_read_request');
    }
    for (let attempt = 1; attempt <= GITHUB_ACTIONS_READ_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response = await fetchImpl(`${root}${pathname}`, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'x-github-api-version': apiVersion,
          },
        });
        if (response.status >= 300 && response.status < 400) {
          const target = redirectTarget(response);
          try { await response.body?.cancel(); } catch { /* best effort before the hop */ }
          if (target === null) {
            throw new GitHubActionsReadError(
              'github_redirect_invalid', `HTTP ${response.status}`, response.status,
            );
          }
          response = await fetchImpl(target, {
            method: 'GET',
            redirect: 'error',
            signal: controller.signal,
            headers: { accept: '*/*' },
          });
        }
        if (response.ok) return await readBoundedResponse(response, maxBytes);
        if (!transientResponse(response) || attempt === GITHUB_ACTIONS_READ_ATTEMPTS) {
          throw new GitHubActionsReadError('github_api_failed', `HTTP ${response.status}`, response.status);
        }
        try { await response.body?.cancel(); } catch { /* best effort before retry */ }
        await sleep(retryAfterMilliseconds(response, attempt));
      } catch (error) {
        if (error instanceof GitHubActionsReadError) throw error;
        if (attempt === GITHUB_ACTIONS_READ_ATTEMPTS) {
          throw new GitHubActionsReadError('github_api_failed', 'transport exhausted');
        }
        await sleep(Math.min(MAX_GITHUB_ACTIONS_BACKOFF_MS, attempt * 1_000));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new GitHubActionsReadError('github_api_failed', 'attempts exhausted');
  };

  return {
    bytes,
    json: async (pathname, maxBytes = MAX_GITHUB_ACTIONS_JSON_BYTES) => {
      const body = await bytes(pathname, maxBytes);
      try {
        return JSON.parse(new TextDecoder().decode(body));
      } catch {
        throw new GitHubActionsReadError('github_api_invalid');
      }
    },
  };
}
