/**
 * cold-email-sequence.mjs — re-export of the SINGLE SOURCE cold-email sequence.
 *
 * The canonical builder lives in functions/src/coldEmailSequence.js so it can be
 * bundled into the deployed Cloud Functions (the web-UI sender adminSendColdEmail
 * imports it there). This thin shim keeps the historical import path working for
 * the Node scripts (generate-/send-cold-emails) and the browser admin panel
 * (components/pages/AdminPanel.tsx → email preview) — all of them resolve to the
 * SAME module instance, so the preview, the CLI send, and the web-UI send stay
 * byte-identical (AGENTS.md Non-Negotiable #6, no drift).
 */
export { PRICE, OPTOUT_EMAIL, buildSequence, bodyToHtml } from '../../functions/src/coldEmailSequence.js';
