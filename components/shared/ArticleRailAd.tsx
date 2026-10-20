/**
 * ArticleRailAd — desktop article side-rail GPT half-page ad (left or right).
 *
 * Fills the desktop whitespace gutters beside the article column (160px compact
 * article rails from 1200px and 300px rails at ≥1400px — see BlogArticles). Serves a
 * dedicated GAM ad unit (/23355151813/article-rail-{left,right}, sizes
 * 300x600 / 160x600 / 300x250 + fluid, AdSense backfill on) via GPT, so AdSense
 * Auto Ads keep serving untouched. Created programmatically by
 * scripts/gam-create-ad-units.mjs.
 *
 * Lives inside the rail's existing `sticky top-24` stack, so the half-page ad
 * rides down the gutter as the reader scrolls. Runtime kill-switch: Firebase
 * Remote Config `KILL_ARTICLE_RAIL_ADS` (kills both rails, ~1 min, no redeploy;
 * default-safe = shown). Static reading rails are visible from 1200px, using
 * 160px creatives until the 300px tier at 1400px.
 */

import React, { useEffect, useState } from 'react';
import GptAdSlot, { type GptSize } from '@/components/shared/GptAdSlot';
import { useKillSwitches } from '@/hooks/useKillSwitches';

const RAIL_AD_UNIT_PATHS = {
  left: '/23355151813/article-rail-left',
  right: '/23355151813/article-rail-right',
} as const;

// Premium vertical display sizes first, box + fluid as fallback — must match
// what the GAM ad unit allows (see scripts/gam-create-ad-units.mjs). Used on
// the wide (300px) reading-page rails (blog / job / static SEO).
const RAIL_SIZES: GptSize[] = [[300, 600], [160, 600], [300, 250], 'fluid'];
// Narrow rail (160px SPA tool-page gutter): only 160-wide creatives + fluid, so
// GAM can't serve a 300-wide creative that would overflow the 160px column into
// the content/gap at ≥1400px.
const RAIL_SIZES_NARROW: GptSize[] = [[160, 600], 'fluid'];

export interface ArticleRailAdProps {
  side: keyof typeof RAIL_AD_UNIT_PATHS;
  /** Article-eligibility gate (long-enough body), wired from BlogArticles. */
  enabled?: boolean;
  /**
   * Reserve the 600px CLS placeholder. Only the first (near-fold) panel of the
   * rail stack needs it; lower panels pass `false` so an unfilled slot collapses
   * to zero (GptAdSlot drops empty slots from layout) instead of leaving a blank
   * 600px box down the gutter.
   */
  reserve?: boolean;
  /**
   * Narrow (160px) gutter — the SPA tool-page rail. Restricts requested sizes to
   * 160-wide so no creative overflows the column. Reading-page rails (300px)
   * omit this and keep the full premium size set. `compact` applies the same
   * size restriction to the article's intermediate desktop tier.
   */
  narrow?: boolean;
  /** Article reading-page compact tier (1200–1399px). */
  compact?: boolean;
  /** Static reading-page rail, visible from 1200px with responsive sizes. */
  desktopRail?: boolean;
  /** GPT fill verdict for this panel (`true` = no fill). Bubbled up by the stack
   *  so an all-empty rail can collapse its reserved gutter. */
  onEmptyChange?: (empty: boolean) => void;
}

const ArticleRailAd: React.FC<ArticleRailAdProps> = ({ side, enabled = true, reserve = true, narrow = false, compact = false, desktopRail = false, onEmptyChange }) => {
  const { articleRailAds: killed, headerBidding: hbKilled } = useKillSwitches();
  const [desktopRailNarrow, setDesktopRailNarrow] = useState(
    () => desktopRail && typeof window !== 'undefined' && window.innerWidth < 1400,
  );

  useEffect(() => {
    if (!desktopRail) return;
    const update = () => setDesktopRailNarrow(window.innerWidth < 1400);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [desktopRail]);

  const useNarrowSizes = narrow || compact || (desktopRail && desktopRailNarrow);
  return (
    <GptAdSlot
      adUnitPath={RAIL_AD_UNIT_PATHS[side]}
      sizes={useNarrowSizes ? RAIL_SIZES_NARROW : RAIL_SIZES}
      killed={killed}
      headerBiddingKilled={hbKilled}
      enabled={enabled}
      onEmptyChange={onEmptyChange}
      minHeight={reserve ? 600 : 0}
      // One panel in the rail stack; the stack stacks several back-to-back to
      // fill the gutter top-to-bottom (separation comes from the stack's flex
      // gap, so no `mt-*` here). Static reading rails use a custom 1200px gate;
      // SPA tool rails retain the widened (≥1400px) `xlw` gate.
      className={desktopRail ? 'ft-static-rail-panel w-full text-center' : compact ? 'hidden xlc:block xlw:hidden w-full text-center' : 'hidden xlw:block w-full text-center'}
    />
  );
};

export default ArticleRailAd;
