/**
 * ArticleRailAd — desktop article side-rail GPT half-page ad (left or right).
 *
 * Fills the wide whitespace gutters beside the article column on large desktop
 * viewports (the rails widen to 300px at ≥1400px — see BlogArticles). Serves a
 * dedicated GAM ad unit (/23355151813/article-rail-{left,right}, sizes
 * 300x600 / 160x600 / 300x250 + fluid, AdSense backfill on) via GPT, so AdSense
 * Auto Ads keep serving untouched. Created programmatically by
 * scripts/gam-create-rail-units.mjs.
 *
 * Lives inside the rail's existing `sticky top-6` stack, so the half-page ad
 * rides down the gutter as the reader scrolls. Runtime kill-switch: Firebase
 * Remote Config `KILL_ARTICLE_RAIL_ADS` (kills both rails, ~1 min, no redeploy;
 * default-safe = shown). Visibility is also CSS-gated to ≥1400px by the caller.
 */

import React from 'react';
import GptAdSlot, { type GptSize } from '@/components/shared/GptAdSlot';
import { useKillSwitches } from '@/hooks/useKillSwitches';

const RAIL_AD_UNIT_PATHS = {
  left: '/23355151813/article-rail-left',
  right: '/23355151813/article-rail-right',
} as const;

// Premium vertical display sizes first, box + fluid as fallback — must match
// what the GAM ad unit allows (see scripts/gam-create-rail-units.mjs).
const RAIL_SIZES: GptSize[] = [[300, 600], [160, 600], [300, 250], 'fluid'];

export interface ArticleRailAdProps {
  side: keyof typeof RAIL_AD_UNIT_PATHS;
  /** Article-eligibility gate (long-enough body), wired from BlogArticles. */
  enabled?: boolean;
}

const ArticleRailAd: React.FC<ArticleRailAdProps> = ({ side, enabled = true }) => {
  const { articleRailAds: killed } = useKillSwitches();
  return (
    <GptAdSlot
      adUnitPath={RAIL_AD_UNIT_PATHS[side]}
      sizes={RAIL_SIZES}
      killed={killed}
      enabled={enabled}
      minHeight={600}
      // Not sticky itself — it sits inside the rail's `sticky top-6` stack so it
      // rides down the gutter. CSS-gated to the widened (≥1400px) rail via the
      // `xlw` breakpoint (the arbitrary `min-[1400px]:` variant lost the v4
      // cascade to `xl:`, so the rail never widened — see index.css @theme).
      className="hidden xlw:block w-full text-center mt-3"
    />
  );
};

export default ArticleRailAd;
