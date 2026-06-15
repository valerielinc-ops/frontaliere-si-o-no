/**
 * newsletter-subject-assign.mjs — server-only A/B variant assignment.
 *
 * Split out of newsletter-subject-variants.mjs because it is the ONLY part that
 * needs `node:crypto`. The variants module is reachable from the SPA client
 * bundle (services/newsletterPreview.ts → services/newsletter-content.mjs →
 * getVariantStyleDirective), and a static `node:crypto` import there makes the
 * whole client build fail hard ("createHash is not exported by
 * __vite-browser-external"). Keeping the hash here — imported only by the send /
 * A/B-report scripts and the unit tests — keeps `node:crypto` out of the SPA
 * graph.
 *
 * The hash function is BYTE-IDENTICAL to the previous in-line implementation, so
 * variant assignment is unchanged: every (email, campaignId) maps to the same
 * variant as before, and the A/B report can still re-compute historical
 * variants. Do NOT swap `createHash('sha256')` for a different hash — that would
 * re-bucket every subscriber and break historical recomputation.
 */
import { createHash } from 'node:crypto';

import { SUBJECT_VARIANTS, normalizeEmail, DEFAULT_EPSILON } from './newsletter-subject-variants.mjs';

/**
 * Deterministically assign a variant id for (email, campaignId).
 * Stable for the lifetime of a campaign (so a subscriber never flip-flops across
 * the daily cron re-runs of one weekly campaign) and rotates across campaigns
 * (so the same subscriber isn't always in the same bucket).
 *
 * Without a `promotedVariant` the split is uniform (the pure A/B baseline). With
 * one, it is epsilon-greedy: a deterministic (1-epsilon) share is sent the
 * winner, the rest explores uniformly — so auto-promotion biases toward the
 * winner while still measuring every arm.
 *
 * @param {string} email
 * @param {string} campaignId
 * @param {{variants?:Array, promotedVariant?:string|null, epsilon?:number}|Array} [opts]
 *        (an array is accepted for backward compat = the variants list)
 * @returns {string} variant id
 */
export function assignSubjectVariant(email, campaignId, opts = {}) {
  const o = Array.isArray(opts) ? { variants: opts } : (opts || {});
  const { variants = SUBJECT_VARIANTS, promotedVariant = null, epsilon = DEFAULT_EPSILON } = o;
  const list = variants?.length ? variants : SUBJECT_VARIANTS;
  const key = `${normalizeEmail(email)}|${String(campaignId || '')}`;
  const digest = createHash('sha256').update(key).digest();
  // Independent digest slices: one for the uniform pick, one for the explore/
  // exploit draw — both deterministic so a subscriber is stable within a campaign.
  const uniformPick = list[digest.readUInt32BE(0) % list.length].id;

  const promoted = list.find((v) => v.id === promotedVariant);
  if (!promoted) return uniformPick; // no promotion → pure A/B split
  const draw = digest.readUInt32BE(4) / 0xffffffff; // [0,1)
  return draw >= epsilon ? promoted.id : uniformPick; // exploit vs explore
}
