/**
 * Firebase-controlled TikTok video creative experiment.
 *
 * The queue id is the experiment unit: retries of the same daily post stay in
 * the same arm, while the `video-creative:` namespace keeps this assignment
 * independent from the native-sound experiment that uses the bare queue id.
 */
import { createHash } from 'node:crypto';

export const TIKTOK_VIDEO_CREATIVE_MODES = Object.freeze(['off', 'motion', 'experiment']);
export const TIKTOK_VIDEO_CREATIVE_VARIANTS = Object.freeze({
  CONTROL: 'carousel-crossfade-v1',
  TREATMENT: 'motion-graphic-v1',
  HOOK: 'hook-3-slides-v1',
  SPOTLIGHT: 'single-stat-v1',
});
export const DEFAULT_TIKTOK_VIDEO_CREATIVE_MODE = 'off';
export const DEFAULT_TIKTOK_VIDEO_CREATIVE_ROLLOUT_PERCENT = 0;
export const DEFAULT_TIKTOK_VIDEO_CREATIVE_NEW_FORMAT_ROLLOUT_PERCENT = 0;

function hashBucket(queueId, namespace) {
  return createHash('sha256')
    .update(`${namespace}:${String(queueId)}`)
    .digest()
    .readUInt32BE(0) % 100;
}

function percent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, Math.floor(parsed)));
}

/**
 * Assign a queue id deterministically to a creative arm. `motion` preserves
 * the original two-arm experiment. `experiment` keeps the configured rollout
 * as the non-control share and takes a second configured share of that pool
 * for the two new formats, split evenly by a separate hash namespace.
 * Local defaults are deliberately control-only until Firebase is configured.
 */
export function resolveTikTokVideoCreativeVariant({ queueId, env = process.env } = {}) {
  const mode = String(env?.TIKTOK_VIDEO_CREATIVE_MODE || DEFAULT_TIKTOK_VIDEO_CREATIVE_MODE)
    .trim()
    .toLowerCase();
  const rollout = percent(env?.TIKTOK_VIDEO_CREATIVE_ROLLOUT_PERCENT);
  if (!queueId || !['motion', 'experiment'].includes(mode) || rollout <= 0) {
    return TIKTOK_VIDEO_CREATIVE_VARIANTS.CONTROL;
  }
  const bucket = hashBucket(queueId, 'video-creative');
  if (bucket >= rollout) return TIKTOK_VIDEO_CREATIVE_VARIANTS.CONTROL;
  if (mode === 'motion') return TIKTOK_VIDEO_CREATIVE_VARIANTS.TREATMENT;

  const newFormatShare = percent(env?.TIKTOK_VIDEO_CREATIVE_NEW_FORMAT_ROLLOUT_PERCENT);
  const newFormatCutoff = Math.floor((rollout * newFormatShare) / 100);
  if (bucket >= newFormatCutoff) return TIKTOK_VIDEO_CREATIVE_VARIANTS.TREATMENT;

  return hashBucket(queueId, 'video-creative-new') % 2 === 0
    ? TIKTOK_VIDEO_CREATIVE_VARIANTS.HOOK
    : TIKTOK_VIDEO_CREATIVE_VARIANTS.SPOTLIGHT;
}

export function tiktokVideoCreativeLabel(variant) {
  if (variant === TIKTOK_VIDEO_CREATIVE_VARIANTS.TREATMENT) return 'Motion graphic';
  if (variant === TIKTOK_VIDEO_CREATIVE_VARIANTS.HOOK) return 'Hook rapido a 3 slide';
  if (variant === TIKTOK_VIDEO_CREATIVE_VARIANTS.SPOTLIGHT) return 'Una statistica in primo piano';
  return 'Slide con dissolvenza';
}

/** Fields copied into the durable TikTok ledger for later comparison. */
export function tiktokVideoCreativeLedgerFields(variant) {
  const safeVariant = Object.values(TIKTOK_VIDEO_CREATIVE_VARIANTS).includes(variant)
    ? variant
    : TIKTOK_VIDEO_CREATIVE_VARIANTS.CONTROL;
  return {
    creativeBaseId: 'tiktok-video',
    creativeVariant: safeVariant,
    creativeLabel: tiktokVideoCreativeLabel(safeVariant),
    creativeFormat: 'video',
    creativeObjective: 'attention-retention',
  };
}
