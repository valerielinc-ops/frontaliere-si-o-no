import {
  GITHUB_WORKFLOW_DISPATCH_API_VERSION,
  githubApiHeaders,
} from './githubApiHeaders.mjs';

export const MAX_GITHUB_WORKFLOW_DISPATCH_RESPONSE_BYTES = 1024 * 1024;
const RUN_LOOKUP_ATTEMPTS = 3;
const TRANSIENT_GET_STATUSES = new Set([404, 429]);
const WORKFLOW_FILE_RE = /^[A-Za-z0-9._-]+\.ya?ml$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RUN_STATUSES = new Set([
  'requested',
  'queued',
  'pending',
  'waiting',
  'in_progress',
  'completed',
]);
const DISPATCH_LOCKED_STATUSES = new Set([
  'dispatching',
  'requested',
  'queued',
  'pending',
  'waiting',
  'in_progress',
  'unknown',
]);

export class WorkflowDispatchError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'WorkflowDispatchError';
    this.code = code;
    this.status = details.status ?? null;
    this.runId = details.runId ?? null;
    this.htmlUrl = details.htmlUrl ?? null;
  }
}

function positiveRunId(value) {
  const normalized = String(value ?? '');
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function githubWorkflowDispatchHeaders(token, extra = {}) {
  return githubApiHeaders(token, {
    ...extra,
    'X-GitHub-Api-Version': GITHUB_WORKFLOW_DISPATCH_API_VERSION,
  });
}

export async function readBoundedJsonResponse(
  response,
  maxBytes = MAX_GITHUB_WORKFLOW_DISPATCH_RESPONSE_BYTES,
) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError('invalid_github_response_limit');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('github_response_too_large');
  if (response.body === null) return null;

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch { /* keep the size error authoritative */ }
        throw new Error('github_response_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (size === 0) return null;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('github_response_invalid_json');
  }
}

function workflowDispatchResponseBinding(body, repository) {
  const runId = positiveRunId(body?.workflow_run_id);
  if (runId === null || !REPOSITORY_RE.test(repository ?? '')
      || typeof body?.run_url !== 'string' || typeof body?.html_url !== 'string') return null;
  try {
    const apiUrl = new URL(body.run_url);
    const htmlUrl = new URL(body.html_url);
    const encodedRepository = repository.split('/').map(encodeURIComponent).join('/');
    if (apiUrl.origin !== 'https://api.github.com'
        || htmlUrl.origin !== 'https://github.com'
        || apiUrl.pathname !== `/repos/${encodedRepository}/actions/runs/${runId}`
        || htmlUrl.pathname !== `/${encodedRepository}/actions/runs/${runId}`
        || apiUrl.search || apiUrl.hash || htmlUrl.search || htmlUrl.hash) return null;
    return { runId, htmlUrl: htmlUrl.href };
  } catch {
    return null;
  }
}

export function workflowDispatchResponseRunId(body, repository) {
  return workflowDispatchResponseBinding(body, repository)?.runId ?? null;
}

export function workflowDispatchErrorIdentity(error) {
  if (!(error instanceof WorkflowDispatchError)) return { runId: null, htmlUrl: null };
  const runId = Number(positiveRunId(error.runId));
  if (!Number.isSafeInteger(runId) || runId < 1 || typeof error.htmlUrl !== 'string') {
    return { runId: null, htmlUrl: null };
  }
  return { runId, htmlUrl: error.htmlUrl };
}

export function validateWorkflowDispatchRun(run, binding) {
  const errors = [];
  if (String(run?.id ?? '') !== binding?.runId) errors.push('run_id_mismatch');
  if (run?.repository?.full_name !== binding?.repository) errors.push('repository_mismatch');
  if (run?.path !== `.github/workflows/${binding?.workflowFile}`) errors.push('workflow_path_mismatch');
  if (run?.event !== 'workflow_dispatch') errors.push('event_mismatch');
  if (run?.head_branch !== binding?.ref) errors.push('head_branch_mismatch');
  if (!Number.isInteger(run?.run_attempt) || run.run_attempt < 1) errors.push('run_attempt_invalid');
  if (!RUN_STATUSES.has(run?.status)) errors.push('run_status_invalid');
  return { valid: errors.length === 0, errors: uniqueSorted(errors) };
}

export function classifyWorkflowRunUiOutcome(state) {
  if (state?.status === 'unknown') return 'unknown';
  if (state?.runId != null && state?.status !== 'completed' && Boolean(state?.error)) return 'unknown';
  if (state?.status === 'error' || Boolean(state?.error)) return 'error';
  return 'success';
}

export function isWorkflowRunDispatchLocked(state) {
  return Boolean(state?.loading) || DISPATCH_LOCKED_STATUSES.has(state?.status);
}

export function planWorkflowSnapshotRead(state) {
  if (!isWorkflowRunDispatchLocked(state)) return { mode: 'latest', runId: null };
  const runId = positiveRunId(state?.runId);
  return runId === null ? { mode: 'skip', runId: null } : { mode: 'exact', runId };
}

/**
 * Pure refresh merge. A latest-run snapshot can never replace an in-flight or
 * ambiguous dispatch. A locked state is updated only by evidence for the exact
 * same run ID, and is unlocked only when that run is terminal.
 */
export function mergeWorkflowSnapshotState(current, snapshot) {
  if (!current) return snapshot;
  const currentRunId = positiveRunId(current.runId);
  const snapshotRunId = positiveRunId(snapshot?.runId);
  if (currentRunId === null) return isWorkflowRunDispatchLocked(current) ? current : snapshot;
  if (snapshotRunId === null) return current;
  if (BigInt(snapshotRunId) < BigInt(currentRunId)) return current;
  if (BigInt(snapshotRunId) > BigInt(currentRunId)) return snapshot;
  if (current.status === 'completed' && snapshot?.status !== 'completed') return current;
  const currentUpdatedAt = Date.parse(current.updatedAt ?? '');
  const snapshotUpdatedAt = Date.parse(snapshot?.updatedAt ?? '');
  if (Number.isFinite(currentUpdatedAt)
      && (!Number.isFinite(snapshotUpdatedAt) || snapshotUpdatedAt < currentUpdatedAt)) return current;
  if (!isWorkflowRunDispatchLocked(current)) return snapshot;
  return snapshot?.status === 'completed'
    ? snapshot
    : { ...current, ...snapshot };
}

function transientGetStatus(status) {
  return TRANSIENT_GET_STATUSES.has(status) || (status >= 500 && status <= 599);
}

/**
 * Browser-safe transport for the exact workflow_dispatch contract. It stays
 * separate from the Node-only crawler dispatcher so AdminPanel never imports
 * filesystem/process dependencies into the client bundle.
 */
export function createGitHubWorkflowDispatchRequester({
  repository,
  token,
  fetchImpl = fetch,
  timeoutMs = 30_000,
  maxResponseBytes = MAX_GITHUB_WORKFLOW_DISPATCH_RESPONSE_BYTES,
}) {
  if (!REPOSITORY_RE.test(repository ?? '') || typeof token !== 'string' || token.length === 0
      || typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1
      || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new TypeError('invalid_github_workflow_requester_configuration');
  }
  const repositoryPrefix = `/repos/${repository}/`;
  return async ({ method, path, body }) => {
    if (!['GET', 'POST'].includes(method) || typeof path !== 'string'
        || !path.startsWith(repositoryPrefix)) {
      throw new TypeError('invalid_github_workflow_request');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`https://api.github.com${path}`, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: githubWorkflowDispatchHeaders(token, {
          'Content-Type': 'application/json',
        }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: await readBoundedJsonResponse(response, maxResponseBytes),
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}

/**
 * Dispatch once and bind the exact run returned by the pinned REST contract.
 * Only the read-only exact-ID lookup is retried; no list/latest inference exists.
 */
export async function dispatchWorkflowOnce({
  repository,
  workflowFile,
  ref,
  inputs,
  request,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  if (!REPOSITORY_RE.test(repository ?? '') || !WORKFLOW_FILE_RE.test(workflowFile ?? '')
      || typeof ref !== 'string' || ref.length === 0
      || !inputs || typeof inputs !== 'object' || Array.isArray(inputs)
      || typeof request !== 'function') throw new TypeError('invalid_workflow_dispatch_configuration');

  let dispatchResponse;
  try {
    dispatchResponse = await request({
      method: 'POST',
      path: `/repos/${repository}/actions/workflows/${workflowFile}/dispatches`,
      body: { ref, inputs },
    });
  } catch {
    throw new WorkflowDispatchError('workflow_dispatch_unknown');
  }
  if (dispatchResponse?.status !== 200) {
    const status = Number.isInteger(dispatchResponse?.status) ? dispatchResponse.status : null;
    throw new WorkflowDispatchError(`workflow_dispatch_rejected_${status ?? 'unknown'}`, { status });
  }
  const dispatchBinding = workflowDispatchResponseBinding(dispatchResponse.body, repository);
  if (dispatchBinding === null) throw new WorkflowDispatchError('workflow_dispatch_invalid_200');
  const { runId, htmlUrl } = dispatchBinding;

  for (let attempt = 1; attempt <= RUN_LOOKUP_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await request({
        method: 'GET',
        path: `/repos/${repository}/actions/runs/${runId}`,
      });
    } catch {
      response = null;
    }
    if (response?.status === 200) {
      const validation = validateWorkflowDispatchRun(response.body, {
        repository, workflowFile, ref, runId,
      });
      if (!validation.valid) {
        throw new WorkflowDispatchError(
          `workflow_run_binding_invalid:${validation.errors.join(',')}`,
          { runId, htmlUrl },
        );
      }
      return { runId, run: response.body };
    }
    const canRetry = response === null || transientGetStatus(response.status);
    if (!canRetry || attempt === RUN_LOOKUP_ATTEMPTS) {
      throw new WorkflowDispatchError(
        `workflow_run_unavailable_${response?.status ?? 'transport'}`,
        { status: response?.status ?? null, runId, htmlUrl },
      );
    }
    await sleep(attempt * 250);
  }
  throw new WorkflowDispatchError('workflow_run_unavailable', { runId, htmlUrl });
}
