/**
 * githubApiHeaders.mjs — re-export SINGLE SOURCE GitHub API request headers.
 *
 * The canonical builder lives in functions/src/githubApiHeaders.js so it can
 * be bundled into the deployed Cloud Functions (githubProxy.js imports it
 * there). This thin shim lets Node CI scripts and the browser admin panel
 * (components/pages/AdminPanel.tsx) import the same path they already use
 * for scripts/lib/* modules — all resolve to the SAME module, so the
 * `X-GitHub-Api-Version` pin can never drift between call sites (AGENTS.md
 * Non-Negotiable #6).
 */

export { GITHUB_API_VERSION, githubApiHeaders } from '../../functions/src/githubApiHeaders.js';
