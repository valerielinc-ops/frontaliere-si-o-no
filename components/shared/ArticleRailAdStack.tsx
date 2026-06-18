/**
 * ArticleRailAdStack — full-length desktop side-rail ad chain.
 *
 * Replaces the single sticky half-page ad with a vertical chain of sticky ad
 * panels that span the ENTIRE article column height, so the wide desktop gutter
 * is monetised top-to-bottom instead of going empty below the first ad (the
 * complaint the screenshots show: one creative rides the top, the rest of the
 * tall gutter stays blank).
 *
 * Each panel is an equal-height (`flex-1`) flex child that forms its OWN sticky
 * containing block: its `sticky top-6` ad rides that panel's slice of the
 * column and hands off to the next as the reader scrolls. Because every panel
 * pins inside its own box (not the whole rail), the ads never overlap — one is
 * always in view, all the way down. The whole track only materialises at the
 * widened (≥1400px / `xlw`) rail, matching ArticleRailAd's own CSS gate.
 *
 * Renders multiple GPT slots of the same /23355151813/article-rail-{side} unit;
 * each GptAdSlot mints a unique div id, so multi-slot serving is fine.
 * `collapseEmptyDivs(true)` + the per-slot IntersectionObserver mean panels that
 * never fill (or are never scrolled into view) cost nothing. Same kill-switch as
 * ArticleRailAd (it owns the Remote Config gate).
 */

import React from 'react';
import ArticleRailAd from '@/components/shared/ArticleRailAd';

export interface ArticleRailAdStackProps {
  side: 'left' | 'right';
  /** Article-eligibility gate (long-enough body), wired from BlogArticles. */
  enabled?: boolean;
  /** How many sticky ad panels to distribute down the rail (clamped ≥1). */
  count?: number;
}

const ArticleRailAdStack: React.FC<ArticleRailAdStackProps> = ({ side, enabled = true, count = 2 }) => {
  const panels = Math.max(1, count);
  return (
    // Fills the remaining gutter height below the rail's top content. Only the
    // widened rail (`xlw`, ≥1400px) hosts the half-page chain — the narrow xl
    // tier (1280–1399) shows no rail ads, exactly as before.
    <div className="hidden xlw:flex xlw:flex-col xlw:flex-1 xlw:min-h-0">
      {Array.from({ length: panels }, (_, i) => (
        // Each panel is its own sticky containing block so the ads form a
        // hand-off chain (no two pin at top-6 at once → no overlap).
        <div key={i} className="flex-1 min-h-0">
          <div className="sticky top-6">
            <ArticleRailAd side={side} enabled={enabled} />
          </div>
        </div>
      ))}
    </div>
  );
};

export default ArticleRailAdStack;
