import { describe, expect, it } from 'vitest';

import {
  INSTAGRAM_CAROUSEL_BACKGROUND_EXPERIMENT_ID,
  INSTAGRAM_CAROUSEL_BACKGROUND_IDS,
  INSTAGRAM_CAROUSEL_BACKGROUND_VARIANTS,
  INSTAGRAM_CAROUSEL_SAFE_AREA,
  INSTAGRAM_CAROUSEL_SAFE_AREA_VERSION,
  assignInstagramCarouselBackground,
  instagramCarouselBackgroundLedgerFields,
  readInstagramCarouselBackgroundConfig,
} from '../scripts/lib/instagram-carousel-background.mjs';
import {
  INSTAGRAM_CAROUSEL_CARD_SIZE,
} from '../scripts/lib/social-carousel-image.mjs';
import { RC_TO_ENV } from '../scripts/load-rc-env.mjs';

describe('Instagram carousel background experiment', () => {
  it('declares four high-contrast arms and a shared safe area', () => {
    expect(INSTAGRAM_CAROUSEL_BACKGROUND_IDS).toEqual([
      'navy-gradient',
      'paper-amber',
      'mint-ink',
      'coral-night',
    ]);
    expect(INSTAGRAM_CAROUSEL_BACKGROUND_VARIANTS).toHaveLength(4);
    expect(INSTAGRAM_CAROUSEL_BACKGROUND_VARIANTS.find((variant) => variant.id === 'paper-amber')?.accentText)
      .toBe('#FFFFFF');
    expect(INSTAGRAM_CAROUSEL_SAFE_AREA).toMatchObject({
      insetX: 144,
      insetTop: 96,
      insetBottom: 72,
      contentWidth: 792,
    });
    expect(INSTAGRAM_CAROUSEL_CARD_SIZE).toBe(1080);
    expect(INSTAGRAM_CAROUSEL_SAFE_AREA_VERSION).toBe('safe-area-v2');
    for (const variant of INSTAGRAM_CAROUSEL_BACKGROUND_VARIANTS) {
      expect(variant.backgroundColor).toMatch(/^#/);
      expect(variant.backgroundImage).toContain('linear-gradient');
      expect(variant.textPrimary).toBeTruthy();
      expect(variant.textMuted).toBeTruthy();
      expect(variant.accent).toBeTruthy();
    }
  });

  it('keeps the control arm when Remote Config is absent or incomplete', () => {
    expect(readInstagramCarouselBackgroundConfig({})).toEqual({
      enabled: false,
      rolloutPercent: 0,
      variantIds: ['navy-gradient'],
    });
    expect(assignInstagramCarouselBackground({ kind: 'article', day: '2026-10-26', env: {} }).id)
      .toBe('navy-gradient');
    expect(assignInstagramCarouselBackground({
      kind: 'article',
      day: '2026-10-26',
      config: { enabled: true, rolloutPercent: 100, variantIds: ['unknown'] },
    }).id).toBe('navy-gradient');
  });

  it('assigns all four arms deterministically when the test is live', () => {
    const config = {
      enabled: true,
      rolloutPercent: 100,
      variantIds: [...INSTAGRAM_CAROUSEL_BACKGROUND_IDS],
    };
    const assignments = Array.from({ length: 400 }, (_, index) => assignInstagramCarouselBackground({
      kind: index % 2 ? 'article' : 'job',
      day: `2026-10-${String((index % 28) + 1).padStart(2, '0')}-${Math.floor(index / 28)}`,
      config,
    }));
    expect(new Set(assignments.map((variant) => variant.id))).toEqual(new Set(INSTAGRAM_CAROUSEL_BACKGROUND_IDS));
    expect(assignInstagramCarouselBackground({ kind: 'article', day: '2026-10-26', config }).id)
      .toBe(assignInstagramCarouselBackground({ kind: 'article', day: '2026-10-26', config }).id);
  });

  it('persists the visual arm and layout version for Insights joins', () => {
    expect(instagramCarouselBackgroundLedgerFields({ id: 'mint-ink' })).toEqual({
      backgroundExperimentId: INSTAGRAM_CAROUSEL_BACKGROUND_EXPERIMENT_ID,
      backgroundVariant: 'mint-ink',
      backgroundLabel: 'Menta e inchiostro',
      safeAreaVersion: 'safe-area-v2',
    });
  });

  it('maps every experiment switch through the Firebase RC bridge', () => {
    expect(RC_TO_ENV.INSTAGRAM_CAROUSEL_BACKGROUND_AB_ENABLED).toEqual([
      'INSTAGRAM_CAROUSEL_BACKGROUND_AB_ENABLED',
    ]);
    expect(RC_TO_ENV.INSTAGRAM_CAROUSEL_BACKGROUND_AB_ROLLOUT_PERCENT).toEqual([
      'INSTAGRAM_CAROUSEL_BACKGROUND_AB_ROLLOUT_PERCENT',
    ]);
    expect(RC_TO_ENV.INSTAGRAM_CAROUSEL_BACKGROUND_AB_VARIANTS).toEqual([
      'INSTAGRAM_CAROUSEL_BACKGROUND_AB_VARIANTS',
    ]);
  });
});
