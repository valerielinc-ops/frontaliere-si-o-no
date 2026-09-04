/**
 * githubApiHeaders.js — SINGLE SOURCE of the GitHub REST API v3 request headers.
 *
 * Lives inside functions/ so it is bundled into the deployed Cloud Functions
 * (githubProxy.js imports it). It is ALSO re-exported by
 * scripts/lib/githubApiHeaders.mjs, which is what the Node CI scripts and the
 * browser admin panel (components/pages/AdminPanel.tsx) import — one copy
 * means the `X-GitHub-Api-Version` pin can never drift between call sites
 * (AGENTS.md Non-Negotiable #6). Pure ESM, no node imports, so every runtime
 * can load it.
 */

export const GITHUB_API_VERSION = '2022-11-28';
// workflow_dispatch gained a direct run identity response in this version.
// Keep it endpoint-specific: the generic API surface above has a much wider
// consumer graph and does not need to change versions with this contract.
export const GITHUB_WORKFLOW_DISPATCH_API_VERSION = '2026-03-10';

/**
 * @param {string} token - Bearer token (PAT / App installation token / OAuth token)
 * @param {Record<string, string>} [extra] - additional headers merged in last (e.g. Content-Type, User-Agent)
 * @returns {Record<string, string>}
 */
export function githubApiHeaders(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    ...extra,
  };
}
