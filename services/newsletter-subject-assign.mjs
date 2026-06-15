/**
 * newsletter-subject-assign.mjs — server-only A/B variant assignment.
 *
 * Split out of newsletter-subject-variants.mjs because it is the ONLY part that
 * needs `node:crypto`. The variants module is reachable from the client bundle
 * (services/newsletterPreview.ts → services/newsletter-content.mjs → it), and a
 * static `node:crypto` import there makes the SPA build fail hard ("createHash
 * is not exported by __vite-browser-external"). Keeping the hash here — imported
 * only by scripts/send-newsletter.mjs and scripts/newsletter-ab-report.mjs —
 * keeps `node:crypto` out of the SPA graph.
 *
 * The hash function is BYTE-IDENTICAL to the previous in-line implementation, so
 * variant assignment is unchanged: every (email, campaignId) maps to the same
 * variant as before, and the A/B report can still re-compute historical
 * variants. Do NOT swap `createHash('sha256')` for a different hash — that would
 * re-bucket every subscriber and break historical recomputation.
 */
import { createHash } from 'node:crypto';

import { SUBJECT_VARIANTS, normalizeEmail } from './newsletter-subject-variants.mjs';

/**
 * Deterministically assign a variant id for (email, campaignId).
 * Stable for the lifetime of a campaign (so a subscriber never flip-flops across
 * the daily cron re-runs of one weekly campaign) and rotates across campaigns
 * (so the same subscriber isn't always in the same bucket).
 *
 * @param {string} email
 * @param {string} campaignId
 * @param {Array}  [variants=SUBJECT_VARIANTS]
 * @returns {string} variant id
 */
export function assignSubjectVariant(email, campaignId, variants = SUBJECT_VARIANTS) {
  const list = variants?.length ? variants : SUBJECT_VARIANTS;
  const key = `${normalizeEmail(email)}|${String(campaignId || '')}`;
  const digest = createHash('sha256').update(key).digest();
  // Use a 4-byte unsigned int for a clean modulo with no first-byte skew.
  const n = digest.readUInt32BE(0);
  return list[n % list.length].id;
}
