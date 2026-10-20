/**
 * Firebase-controlled TikTok video creative experiment.
 *
 * The queue id is the experiment unit: retries of the same daily post stay in
 * the same arm, while the `video-creative:` namespace keeps this assignment
 * independent from the native-sound experiment that uses the bare queue id.
 */
import { createHash } from 'node:crypto';

export const TIKTOK_VIDEO_CREATIVE_MODES = Object.freeze(['off', 'motion']);
export const TIKTOK_VIDEO_CREATIVE_VARIANTS = Object.freeze({
  CONTROL: 'carousel-crossfade-v1',
  TREATMENT: 'motion-graphic-v1',
});
export const DEFAULT_TIKTOK_VIDEO_CREATIVE_MODE = 'off';
export const DEFAULT_TIKTOK_VIDEO_CREATIVE_ROLLOUT_PERCENT = 0;

/**
 * Assign a queue id deterministically to the control or motion treatment.
 * Local defaults are deliberately control-only until Firebase is configured.
 */
export function resolveTikTokVideoCreativeVariant({ queueId, env = process.env } = {}) {
  const mode = String(env?.TIKTOK_VIDEO_CREATIVE_MODE || DEFAULT_TIKTOK_VIDEO_CREATIVE_MODE)
    .trim()
    .toLowerCase();
  const rollout = Number(env?.TIKTOK_VIDEO_CREATIVE_ROLLOUT_PERCENT);
  if (!queueId || mode !== 'motion' || !Number.isFinite(rollout) || rollout <= 0) {
    return TIKTOK_VIDEO_CREATIVE_VARIANTS.CONTROL;
  }
  if (rollout >= 100) return TIKTOK_VIDEO_CREATIVE_VARIANTS.TREATMENT;
  const bucket = createHash('sha256')
    .update(`video-creative:${String(queueId)}`)
    .digest()
    .readUInt32BE(0) % 100;
  return bucket < Math.floor(rollout)
    ? TIKTOK_VIDEO_CREATIVE_VARIANTS.TREATMENT
    : TIKTOK_VIDEO_CREATIVE_VARIANTS.CONTROL;
}

export function tiktokVideoCreativeLabel(variant) {
  return variant === TIKTOK_VIDEO_CREATIVE_VARIANTS.TREATMENT
    ? 'Motion graphic'
    : 'Slide con dissolvenza';
}

/** Fields copied into the durable TikTok ledger for later comparison. */
export function tiktokVideoCreativeLedgerFields(variant) {
  const safeVariant = variant === TIKTOK_VIDEO_CREATIVE_VARIANTS.TREATMENT
    ? TIKTOK_VIDEO_CREATIVE_VARIANTS.TREATMENT
    : TIKTOK_VIDEO_CREATIVE_VARIANTS.CONTROL;
  return {
    creativeBaseId: 'tiktok-video',
    creativeVariant: safeVariant,
    creativeLabel: tiktokVideoCreativeLabel(safeVariant),
    creativeFormat: 'video',
    creativeObjective: 'attention-retention',
  };
}
