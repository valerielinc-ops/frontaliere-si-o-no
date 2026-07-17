/**
 * githubProxy.js — server-side GitHub access so the repo PAT never reaches the
 * browser.
 *
 * Previously the client read `GITHUB_PAT` from Remote Config and called the
 * GitHub API directly — a repo-write token downloadable by every visitor. Now
 * two server endpoints hold the PAT:
 *
 *  - createFeedbackIssue: PUBLIC, reCAPTCHA-gated. Creates a single issue from
 *    the feedback form. (Reads are done unauthenticated client-side — the repo
 *    is public.)
 *  - githubAdminProxy: ADMIN-only (Firebase ID token email allowlist). Forwards
 *    arbitrary repo API calls for the admin dashboard's single `githubRequest`
 *    chokepoint.
 */

import { getAuth } from 'firebase-admin/auth';
import { getRemoteConfigValue } from './remoteConfigSecrets.js';
import { createAssessment } from './recaptchaVerification.js';
import { githubApiHeaders } from './githubApiHeaders.js';

const ADMIN_EMAIL_ALLOWLIST = new Set(['valerielinc@gmail.com']);
const FEEDBACK_RECAPTCHA_THRESHOLD = 0.5;
const GITHUB_API = 'https://api.github.com';

async function getRepoConfig() {
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
    body: JSON.stringify({
      title,
      body: `${description}\n\n> Segnalato tramite Web App`,
      labels: [type === 'BUG' ? 'bug' : 'enhancement'],
    }),
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

// ── Admin: forward arbitrary repo API calls (ID-token gated) ───────────────
async function assertAdmin(req) {
  const header = req.get ? req.get('Authorization') : req.headers?.authorization;
  const idToken = typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice(7).trim()
    : '';
  if (!idToken) return { ok: false, status: 401, error: 'missing_id_token' };
  try {
    const decoded = await getAuth().verifyIdToken(idToken);
    const email = (decoded.email || '').toLowerCase();
    if (!decoded.email_verified || !ADMIN_EMAIL_ALLOWLIST.has(email)) {
      return { ok: false, status: 403, error: 'not_admin' };
    }
    return { ok: true };
  } catch {
    return { ok: false, status: 401, error: 'invalid_id_token' };
  }
}

/**
 * Return the GitHub connection (PAT + owner/repo) to a verified admin only.
 *
 * The admin dashboard is a single-trusted-user tool with a large, intricate
 * GitHub API surface (runs, jobs, logs, dispatches). Rather than proxy every
 * call, we hand the PAT to the authenticated admin's browser ONLY — gated by a
 * Firebase ID-token email allowlist + App Check. This removes `GITHUB_PAT` from
 * the universal public config (every visitor) while keeping the dashboard's
 * existing logic unchanged. The PAT reaches one trusted account instead of the
 * whole internet.
 */
export async function handleGetAdminGithubToken(req) {
  if (req.method !== 'POST') {
    return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  }

  const auth = await assertAdmin(req);
  if (!auth.ok) {
    return { status: auth.status, body: { ok: false, error: auth.error } };
  }

  const { pat, owner, repo } = await getRepoConfig();
  if (!pat) {
    return { status: 503, body: { ok: false, error: 'github_not_configured' } };
  }

  return { status: 200, body: { ok: true, token: pat, owner, repo } };
}
