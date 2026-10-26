import { createHash } from 'node:crypto';

export const INSTAGRAM_CAROUSEL_BACKGROUND_EXPERIMENT_ID = 'instagram-carousel-background-v1';
export const INSTAGRAM_CAROUSEL_SAFE_AREA_VERSION = 'safe-area-v2';

// Instagram can crop the outer edge in discovery surfaces and in some
// previews. Keep the reading column well inside the square so the first words
// of the hook survive those crops. Typography and copy stay fixed across the
// background arms; only the surface palette changes.
export const INSTAGRAM_CAROUSEL_SAFE_AREA = Object.freeze({
  insetX: 144,
  insetTop: 96,
  insetBottom: 72,
  contentWidth: 1080 - (144 * 2),
});

const BACKGROUND_VARIANTS = [
  {
    id: 'navy-gradient',
    label: 'Blu notte · controllo',
    backgroundColor: '#0F2557',
    backgroundImage: 'linear-gradient(135deg, #0F2557 0%, #1E3D8F 100%)',
    textPrimary: '#FFFFFF',
    textMuted: '#D9E3FA',
    accent: '#FFB300',
    accentText: '#0F2557',
    statSurface: 'rgba(255,255,255,0.14)',
    footerBorder: 'rgba(255,255,255,0.26)',
  },
  {
    id: 'paper-amber',
    label: 'Carta calda',
    backgroundColor: '#FFF8E7',
    backgroundImage: 'linear-gradient(135deg, #FFF8E7 0%, #FFE9BF 100%)',
    textPrimary: '#0F2557',
    textMuted: '#415775',
    accent: '#9A3412',
    accentText: '#0F2557',
    statSurface: 'rgba(15,37,87,0.10)',
    footerBorder: 'rgba(15,37,87,0.24)',
  },
  {
    id: 'mint-ink',
    label: 'Menta e inchiostro',
    backgroundColor: '#F0FAF5',
    backgroundImage: 'linear-gradient(135deg, #F0FAF5 0%, #CFE8DD 100%)',
    textPrimary: '#123B40',
    textMuted: '#3E6262',
    accent: '#A4441E',
    accentText: '#FFFFFF',
    statSurface: 'rgba(18,59,64,0.11)',
    footerBorder: 'rgba(18,59,64,0.24)',
  },
  {
    id: 'coral-night',
    label: 'Corallo notte',
    backgroundColor: '#281827',
    backgroundImage: 'linear-gradient(135deg, #281827 0%, #7A2F3F 100%)',
    textPrimary: '#FFFFFF',
    textMuted: '#F8DCE0',
    accent: '#FFD166',
    accentText: '#281827',
    statSurface: 'rgba(255,255,255,0.14)',
    footerBorder: 'rgba(255,255,255,0.28)',
  },
].map((variant) => Object.freeze(variant));

export const INSTAGRAM_CAROUSEL_BACKGROUND_VARIANTS = Object.freeze(BACKGROUND_VARIANTS);
export const INSTAGRAM_CAROUSEL_BACKGROUND_IDS = Object.freeze(BACKGROUND_VARIANTS.map((variant) => variant.id));

const BACKGROUND_BY_ID = new Map(BACKGROUND_VARIANTS.map((variant) => [variant.id, variant]));
const CONTROL_VARIANT = BACKGROUND_VARIANTS[0];

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return null;
}

function parseBoolean(value) {
  return ['1', 'true', 'on', 'enabled'].includes(String(value ?? '').trim().toLowerCase());
}

function parsePercent(value) {
  const parsed = Number(String(value ?? '').trim());
  return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : 0;
}

function parseVariantIds(value) {
  const raw = firstText(value);
  if (!raw) return [CONTROL_VARIANT.id];
  let values;
  try {
    values = JSON.parse(raw);
  } catch {
    values = raw.split(',');
  }
  if (!Array.isArray(values)) return [CONTROL_VARIANT.id];
  const ids = [...new Set(values.map((item) => String(item ?? '').trim()).filter((id) => BACKGROUND_BY_ID.has(id)))];
  return ids.length > 0 ? ids : [CONTROL_VARIANT.id];
}

export function readInstagramCarouselBackgroundConfig(env = process.env) {
  const variantIds = parseVariantIds(env.INSTAGRAM_CAROUSEL_BACKGROUND_AB_VARIANTS);
  return {
    enabled: parseBoolean(env.INSTAGRAM_CAROUSEL_BACKGROUND_AB_ENABLED),
    rolloutPercent: parsePercent(env.INSTAGRAM_CAROUSEL_BACKGROUND_AB_ROLLOUT_PERCENT),
    variantIds,
  };
}

export function instagramCarouselBackgroundForId(id) {
  return BACKGROUND_BY_ID.get(String(id ?? '').trim()) || CONTROL_VARIANT;
}

function deterministicBucket(seed) {
  const digest = createHash('sha256').update(seed).digest('hex');
  return {
    rollout: Number.parseInt(digest.slice(0, 8), 16) % 10_000,
    arm: Number.parseInt(digest.slice(8, 16), 16),
  };
}

/**
 * Assign one background to one scheduled post. The post's kind and period
 * are the stable unit, so retries and queue replays keep the same arm.
 * Invalid or absent Remote Config always falls back to the navy control.
 */
export function assignInstagramCarouselBackground({ kind, day, env = process.env, config } = {}) {
  const resolved = config || readInstagramCarouselBackgroundConfig(env);
  const configuredIds = resolved.variantIds
    .map((id) => String(id ?? '').trim())
    .filter((id, index, ids) => BACKGROUND_BY_ID.has(id) && ids.indexOf(id) === index);
  if (!resolved.enabled || resolved.rolloutPercent <= 0 || configuredIds.length < 2) return CONTROL_VARIANT;

  const seed = `${INSTAGRAM_CAROUSEL_BACKGROUND_EXPERIMENT_ID}:${firstText(kind) || 'article'}:${firstText(day) || 'unknown'}`;
  const bucket = deterministicBucket(seed);
  if (bucket.rollout >= Math.round(resolved.rolloutPercent * 100)) return CONTROL_VARIANT;
  return instagramCarouselBackgroundForId(configuredIds[bucket.arm % configuredIds.length]);
}

export function instagramCarouselBackgroundLedgerFields(background) {
  const selected = instagramCarouselBackgroundForId(background?.id);
  return {
    backgroundExperimentId: INSTAGRAM_CAROUSEL_BACKGROUND_EXPERIMENT_ID,
    backgroundVariant: selected.id,
    backgroundLabel: selected.label,
    safeAreaVersion: INSTAGRAM_CAROUSEL_SAFE_AREA_VERSION,
  };
}
