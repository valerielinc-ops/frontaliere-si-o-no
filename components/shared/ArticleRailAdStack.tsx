/**
 * ArticleRailAdStack — full-length desktop side-rail ad chain.
 *
 * Fills the tall desktop gutter top-to-bottom with a vertical chain of ad
 * panels so the rail is *continuous* — no blank stretch below the first
 * creative (the complaint the screenshots show: one ad rides the top, the rest
 * of the gutter stays empty).
 *
 * How the gap-free fill works:
 *  - The stack measures its own rendered height (it `flex-1`-stretches to the
 *    grid row = the article column height) and asks for ~one half-page panel per
 *    ~620px of gutter, so a tall page gets more panels and a short one fewer.
 *  - Panels flow naturally (NOT `flex-1`-stretched) and butt together with a
 *    small flex gap — no panel is taller than its creative, so there's no empty
 *    slack inside a panel.
 *  - Only the first panel reserves the 600px CLS placeholder; the rest pass
 *    `reserve={false}`. Combined with GptAdSlot collapsing any slot GPT reports
 *    empty (`display:none`), unfilled panels vanish from layout instead of
 *    leaving a blank box, so the filled panels stay flush.
 *
 * The whole track only materialises at the widened (≥1400px / `xlw`) rail,
 * matching ArticleRailAd's own CSS gate.
 *
 * Renders multiple GPT slots of the same /23355151813/article-rail-{side} unit;
 * each GptAdSlot mints a unique div id, so multi-slot serving is fine. Same
 * kill-switch as ArticleRailAd (it owns the Remote Config gate).
 */

import React, { useEffect, useRef, useState } from 'react';
import ArticleRailAd from '@/components/shared/ArticleRailAd';

export interface ArticleRailAdStackProps {
  side: 'left' | 'right';
  /** Article-eligibility gate (long-enough body), wired from BlogArticles. */
  enabled?: boolean;
  /**
   * Max panels cap. BlogArticles passes a length-gated value so long-form posts
   * fill more of the gutter while short ones stay light; omitted elsewhere
   * (tools / job-board / static), where we cap at MAX_PANELS. The actual count
   * is still height-driven — this is only the ceiling.
   */
  count?: number;
}

// Approx height of one half-page rail panel (600px creative + flex gap).
const PANEL_PX = 620;
// Bound the number of same-unit requests; tall pages cap here, short pages get 1.
const MAX_PANELS = 6;

const ArticleRailAdStack: React.FC<ArticleRailAdStackProps> = ({ side, enabled = true, count }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [panels, setPanels] = useState(1);
  const maxPanels = Math.max(1, count ?? MAX_PANELS);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const h = el.getBoundingClientRect().height;
      // Match the gutter height as closely as possible: round so the chain
      // neither under-fills (blank tail) nor badly over-fills (pushes the row).
      const next = Math.max(1, Math.min(maxPanels, Math.round(h / PANEL_PX)));
      setPanels((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxPanels]);

  return (
    // `flex-1` stretches the stack to the full gutter height so the measurement
    // reflects the article column. Panels flow top-to-bottom with a tight gap.
    // Only the widened rail (`xlw`, ≥1400px) hosts the chain — the narrow xl
    // tier (1280–1399) shows no rail ads, exactly as before.
    <div ref={ref} className="hidden xlw:flex xlw:flex-col xlw:flex-1 xlw:min-h-0 gap-2">
      {Array.from({ length: panels }, (_, i) => (
        <ArticleRailAd key={i} side={side} enabled={enabled} reserve={i === 0} />
      ))}
    </div>
  );
};

export default ArticleRailAdStack;
