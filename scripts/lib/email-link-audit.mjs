/**
 * email-link-audit.mjs — re-export shim.
 *
 * Canonical implementation is functions/src/lib/emailLinkAudit.js, for the
 * same reason newsletterUrls.js and emailCascade.js live there: firebase.json's
 * `source: "functions"` deploy has no bundler, so functions/src/** can only
 * import from within functions/ — and the welcome/confirmation Cloud Functions
 * are senders too, so the audit has to be reachable from that side. The
 * inverse direction (scripts/ → functions/) has no such boundary.
 *
 * Edit functions/src/lib/emailLinkAudit.js, not this file — this file only
 * re-exports live bindings so every scripts/ caller and tests/*.test.ts import
 * path resolves the exact same module (AGENTS.md #6: one regex/constant, one
 * home, no copy-paste drift).
 */
export * from '../../functions/src/lib/emailLinkAudit.js';
