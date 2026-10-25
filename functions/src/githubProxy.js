/**
 * githubProxy.js — server-side GitHub access so the repo PAT never reaches the
 * browser.
 *
 * - createFeedbackIssue: public, reCAPTCHA-gated issue creation.
 * - adminGithub: admin-only, explicit allowlisted GitHub calls for the admin
 *   dashboard. The PAT remains inside the function runtime.
 */

import { getRemoteConfigValue } from './remoteConfigSecrets.js';
import { createAssessment } from './recaptchaVerification.js';
import {
  GITHUB_WORKFLOW_DISPATCH_API_VERSION,
  githubApiHeaders,
} from './githubApiHeaders.js';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { assertSiteAdmin } from './adminAuth.js';
import { updateAdminAuditStatus, writeAdminAuditLog } from './adminAudit.js';

const FEEDBACK_RECAPTCHA_THRESHOLD = 0.5;
const FEEDBACK_GITHUB_TIMEOUT_MS = 20_000;
const MAX_GITHUB_LOG_BYTES = 256 * 1024;
const GITHUB_REQUEST_TIMEOUT_MS = 15_000;

// Exported: stripePublisherCore.js's dispatchPublisherSync reuses this same
// base URL instead of re-hardcoding it (single source for the GitHub REST API).
export const GITHUB_API = 'https://api.github.com';

// Exported: stripePublisherCore.js's dispatchPublisherSync reuses this PAT +
// owner/repo resolution instead of duplicating the RC-read construct.
export async function getRepoConfig() {
  const [pat, owner, repo] = await Promise.all([
    getRemoteConfigValue('GITHUB_PAT'),
    getRemoteConfigValue('GITHUB_REPO_OWNER'),
    getRemoteConfigValue('GITHUB_REPO_NAME'),
  ]);
  return {
    pat: (pat || '').trim(),
    owner: (owner || 'valerielinc-ops').trim(),
    repo: (repo || 'frontaliere-si-o-no').trim(),
  };
}

// ── Public: create a feedback issue (reCAPTCHA-gated) ──────────────────────
export async function handleCreateFeedbackIssue(req) {
  if (req.method !== 'POST') {
    return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  }

  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const description = typeof req.body?.description === 'string' ? req.body.description : '';
  const type = req.body?.type === 'BUG' ? 'BUG' : 'FEATURE';
  const token = typeof req.body?.recaptchaToken === 'string' ? req.body.recaptchaToken.trim() : '';

  if (!title || !description) {
    return { status: 400, body: { ok: false, error: 'missing_fields' } };
  }
  if (!token) {
    return { status: 400, body: { ok: false, error: 'missing_recaptcha' } };
  }

  // Verify the reCAPTCHA token server-side before spending the PAT.
  const siteKey = await getRemoteConfigValue('RECAPTCHA_SITE_KEY');
  if (siteKey) {
    const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino';
    const assessment = await createAssessment({
      token,
      expectedAction: 'FEEDBACK_SUBMIT',
      projectId,
      siteKey,
    });
    if (!assessment.valid || (assessment.score ?? 0) < FEEDBACK_RECAPTCHA_THRESHOLD) {
      return { status: 403, body: { ok: false, error: 'recaptcha_failed' } };
    }
  }

  const { pat, owner, repo } = await getRepoConfig();
  if (!pat) {
    return { status: 503, body: { ok: false, error: 'github_not_configured' } };
  }

  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    // classic "token" scheme (not Bearer) — this endpoint has used it since
    // before the Bearer-scheme call sites existed; keeping it avoids an
    // unverified auth-scheme change on a public, reCAPTCHA-gated endpoint.
    headers: githubApiHeaders(pat, { Authorization: `token ${pat}`, 'Content-Type': 'application/json' }),
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      title,
      body: `${description}\n\n> Segnalato tramite Web App`,
      labels: [type === 'BUG' ? 'bug' : 'enhancement'],
    }),
    signal: AbortSignal.timeout(FEEDBACK_GITHUB_TIMEOUT_MS),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { status: 502, body: { ok: false, error: data?.message || 'github_error' } };
  }

  return {
    status: 200,
    body: {
      ok: true,
      issue: {
        id: String(data.id),
        title: data.title,
        body: data.body,
        author: data.user?.login || 'frontaliere',
        url: data.html_url,
      },
    },
  };
}

// ── Admin: allowlisted GitHub calls (ID-token gated) ───────────────────────
function invalidGithubPath() {
  return { ok: false, status: 400, error: 'path_not_allowed' };
}

function parseGithubPath(method, path) {
  if (!['GET', 'POST'].includes(method) || typeof path !== 'string' || !path.startsWith('/') || path.includes('#')) {
    return invalidGithubPath();
  }

  let url;
  try {
    url = new URL(path, 'https://admin-github.invalid');
  } catch {
    return invalidGithubPath();
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const queryKeys = [...url.searchParams.keys()];
  const hasOnlyQueryKeys = (allowed) => queryKeys.every((key) => allowed.includes(key));
  const singleQueryValue = (key) => {
    const values = url.searchParams.getAll(key);
    return values.length <= 1 ? values[0] : null;
  };
  const validPerPage = () => !url.searchParams.has('per_page') || /^(?:[1-9]\d?|100)$/u.test(singleQueryValue('per_page') || '');
  const validPage = () => !url.searchParams.has('page') || /^(?:[1-9]|10)$/u.test(singleQueryValue('page') || '');
  const validCreated = () => !url.searchParams.has('created') || /^(?:[<>]=?)?\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z?)?$/u.test(singleQueryValue('created') || '');
  const validStatus = () => !url.searchParams.has('status') || new Set(['queued', 'in_progress', 'completed', 'requested', 'waiting', 'pending']).has(singleQueryValue('status') || '');
  const validBranch = () => !url.searchParams.has('branch') || /^[^\s#?&]{1,120}$/u.test(singleQueryValue('branch') || '');
  const workflowFile = segments[2];
  const workflowFileValid = typeof workflowFile === 'string' && /^[A-Za-z0-9._-]+\.ya?ml$/i.test(workflowFile);
  const numeric = (value) => typeof value === 'string' && /^\d+$/.test(value);

  if (
    method === 'GET'
    && segments.length === 4
    && segments[0] === 'actions'
    && segments[1] === 'workflows'
    && workflowFileValid
    && segments[3] === 'runs'
    && hasOnlyQueryKeys(['created', 'per_page', 'page', 'status', 'branch'])
    && validPerPage()
    && validPage()
    && validCreated()
    && validStatus()
    && validBranch()
  ) {
    return { ok: true, kind: 'workflow_runs', workflowFile };
  }

  if (
    method === 'GET'
    && segments.length === 2
    && segments[0] === 'actions'
    && segments[1] === 'runs'
    && hasOnlyQueryKeys(['created', 'per_page', 'page', 'status', 'branch'])
    && validPerPage()
    && validPage()
    && validCreated()
    && validStatus()
    && validBranch()
  ) {
    return { ok: true, kind: 'all_runs' };
  }

  if (method === 'GET' && segments.length === 1 && segments[0] === 'rate_limit' && !url.search) {
    return { ok: true, kind: 'rate_limit' };
  }

  if (
    method === 'GET'
    && segments.length === 3
    && segments[0] === 'actions'
    && segments[1] === 'runs'
    && numeric(segments[2])
    && !url.search
  ) {
    return { ok: true, kind: 'run', runId: segments[2] };
  }

  if (
    method === 'GET'
    && segments.length === 4
    && segments[0] === 'actions'
    && segments[1] === 'runs'
    && numeric(segments[2])
    && segments[3] === 'jobs'
    && hasOnlyQueryKeys(['per_page'])
    && validPerPage()
  ) {
    return { ok: true, kind: 'run_jobs', runId: segments[2] };
  }

  if (
    method === 'GET'
    && segments.length === 4
    && segments[0] === 'actions'
    && segments[1] === 'jobs'
    && numeric(segments[2])
    && segments[3] === 'logs'
    && !url.search
  ) {
    return { ok: true, kind: 'job_logs', jobId: segments[2] };
  }

  if (
    method === 'POST'
    && segments.length === 4
    && segments[0] === 'actions'
    && segments[1] === 'workflows'
    && workflowFileValid
    && segments[3] === 'dispatches'
    && !url.search
  ) {
    return { ok: true, kind: 'workflow_dispatch', workflowFile };
  }

  return invalidGithubPath();
}

function truncateUtf8(value, maxBytes = MAX_GITHUB_LOG_BYTES) {
  const encoded = Buffer.from(String(value || ''), 'utf8');
  return formatUtf8Tail(encoded, maxBytes, encoded.byteLength > maxBytes);
}

function formatUtf8Tail(encoded, maxBytes, truncated) {
  if (!truncated && encoded.byteLength <= maxBytes) return encoded.toString('utf8');

  const prefix = '[log troncato: mostrati gli ultimi 256 KB]\n';
  const prefixBytes = Buffer.byteLength(prefix, 'utf8');
  if (prefixBytes >= maxBytes) return Buffer.from(prefix, 'utf8').subarray(0, maxBytes).toString('utf8');

  const contentBytes = maxBytes - prefixBytes;
  let start = Math.max(0, encoded.byteLength - contentBytes);
  while (start < encoded.byteLength && (encoded[start] & 0xc0) === 0x80) start += 1;
  return `${prefix}${encoded.subarray(start).toString('utf8')}`;
}

function responseChunkView(value) {
  if (value == null) return Buffer.alloc(0);
  if (value instanceof ArrayBuffer) return Buffer.from(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return Buffer.from(String(value), 'utf8');
}

async function readResponseTextTail(response, maxBytes = MAX_GITHUB_LOG_BYTES) {
  const reader = response?.body?.getReader?.();
  if (!reader) {
    try {
      return typeof response?.text === 'function' ? await response.text() : '';
    } catch {
      return '';
    }
  }

  let tail = Buffer.alloc(0);
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Keep only the tail before the next read; the view itself is never
      // retained, so a producer can release/reuse its stream buffer.
      const chunk = responseChunkView(value);
      if (!chunk.byteLength) continue;
      totalBytes += chunk.byteLength;
      if (chunk.byteLength >= maxBytes) {
        tail = Buffer.from(chunk.subarray(chunk.byteLength - maxBytes));
        continue;
      }
      const combined = Buffer.concat([tail, chunk]);
      tail = combined.byteLength > maxBytes
        ? Buffer.from(combined.subarray(combined.byteLength - maxBytes))
        : combined;
    }
    return formatUtf8Tail(tail, maxBytes, totalBytes > maxBytes);
  } catch {
    return '';
  } finally {
    try { reader.releaseLock?.(); } catch { /* the read verdict stays authoritative */ }
  }
}

async function readResponseBody(response) {
  const text = await response.text().catch(() => '');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function githubEndpoint(path, owner, repo, kind) {
  if (kind === 'rate_limit') return `${GITHUB_API}${path}`;
  return `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`;
}

export async function handleAdminGithub(req, dependencies = {}) {
  if (req?.method !== 'POST') {
    return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  }

  const authGate = dependencies.assertSiteAdmin || assertSiteAdmin;
  const auth = await authGate(req);
  if (!auth.ok) return { status: auth.status, body: { ok: false, error: auth.error } };

  const method = String(req.body?.method || '').toUpperCase();
  const path = req.body?.path;
  const parsed = parseGithubPath(method, path);
  if (!parsed.ok) return { status: parsed.status, body: { ok: false, error: parsed.error } };

  const isDispatch = parsed.kind === 'workflow_dispatch';
  const auditDb = isDispatch ? (dependencies.db || getAdminDb()) : null;
  let dispatchAuditRef = null;
  const writeDispatchAuditIntent = async () => {
    if (!isDispatch) return null;
    const inputs = req.body?.body?.inputs || req.body?.body || {};
    dispatchAuditRef = await writeAdminAuditLog({
      db: auditDb,
      auth,
      action: 'workflow_dispatch',
      target: parsed.workflowFile,
      status: 'pending',
      details: { inputs },
      legacyFields: { inputs },
    });
    return dispatchAuditRef;
  };
  const updateDispatchAudit = async (status) => {
    if (!isDispatch) return;
    await updateAdminAuditStatus(dispatchAuditRef, status);
  };

  await writeDispatchAuditIntent();

  const { pat, owner, repo } = dependencies.repoConfig || await getRepoConfig();
  if (!pat) {
    await updateDispatchAudit(503);
    return { status: 503, body: { ok: false, error: 'github_not_configured' } };
  }

  const fetchImpl = dependencies.fetchImpl || fetch;
  const githubUrl = githubEndpoint(path, owner, repo, parsed.kind);
  const requestOptions = {
    method,
    headers: githubApiHeaders(pat, {
      'Content-Type': 'application/json',
      ...(isDispatch ? { 'X-GitHub-Api-Version': GITHUB_WORKFLOW_DISPATCH_API_VERSION } : {}),
    }),
    redirect: parsed.kind === 'job_logs' ? 'manual' : 'follow',
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
  };
  if (req.body?.body !== undefined) requestOptions.body = JSON.stringify(req.body.body);

  let upstream;
  let body;
  try {
    upstream = await fetchImpl(githubUrl, requestOptions);
    if (parsed.kind === 'job_logs') {
      if (upstream.status >= 300 && upstream.status < 400 && upstream.headers?.get('location')) {
        const logResponse = await fetchImpl(upstream.headers.get('location'), {
          method: 'GET',
          redirect: 'follow',
          signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
        });
        const logText = await readResponseTextTail(logResponse);
        return {
          status: logResponse.status,
          body: logResponse.ok
            ? { ok: true, text: truncateUtf8(logText) }
            : { ok: false, error: 'github_error', message: truncateUtf8(logText) },
        };
      }
      const logText = await readResponseTextTail(upstream);
      body = upstream.ok
        ? { ok: true, text: truncateUtf8(logText) }
        : { ok: false, error: 'github_error', message: truncateUtf8(logText) };
    } else {
      const upstreamBody = await readResponseBody(upstream);
      body = upstream.ok
        ? { ok: true, data: upstreamBody }
        : { ok: false, ...upstreamBody, error: upstreamBody?.message || 'github_error' };
    }
  } catch (error) {
    console.error('adminGithub upstream request failed', error);
    await updateDispatchAudit(502);
    return { status: 502, body: { ok: false, error: 'github_unavailable' } };
  }

  const upstreamStatus = upstream?.status || 502;
  await updateDispatchAudit(upstreamStatus);

  return { status: upstreamStatus, body };
}

export { parseGithubPath };
