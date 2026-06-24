/**
 * ArticleRailAdStack — desktop side-rail ad chain that stays in view.
 *
 * Keeps the tall desktop gutter monetised top-to-bottom WITHOUT trying to
 * physically tile the whole column (which an article can outgrow — a 12k-px post
 * left ~10k px of blank rail below the first few ads, the complaint the
 * screenshots show). Instead a small cluster of half-page panels is pinned with
 * `position: sticky`, so it rides the viewport for the entire scroll and the
 * gutter never goes blank.
 *
 * How it works:
 *  - The outer `flex-1` div claims the full gutter height (so the cluster has
 *    room to travel and layout/CLS is reserved); the inner `sticky top-6` div
 *    holds the panels and pins to the viewport top as the column scrolls.
 *  - Panel count is VIEWPORT-driven: just enough half-page panels (~620px each)
 *    to cover the visible viewport — more would sit below the fold, pinned and
 *    never seen (wasted ad requests). A short gutter caps it lower.
 *  - Only the first panel reserves the 600px CLS placeholder; the rest pass
 *    `reserve={false}`. Combined with GptAdSlot collapsing any slot GPT reports
 *    empty (`display:none`), unfilled panels vanish instead of leaving a blank
 *    box, so the filled panels stay flush.
 *
 * Sticky requires no overflow-clipping scroll ancestor: the app shell uses
 * `overflow-x: clip` (NOT `overflow: hidden`, which would make it a scroll
 * container and silently break this) — see App.tsx app-shell-col.
 *
 * The whole track only materialises at the widened (≥1400px / `xlw`) rail,
 * matching ArticleRailAd's own CSS gate.
 *
 * Renders multiple GPT slots of the same /23355151813/article-rail-{side} unit;
 * each GptAdSlot mints a unique div id, so multi-slot serving is fine. Same
 * kill-switch as ArticleRailAd (it owns the Remote Config gate).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import ArticleRailAd from '@/components/shared/ArticleRailAd';

export interface ArticleRailAdStackProps {
  side: 'left' | 'right';
  /** Article-eligibility gate (long-enough body), wired from BlogArticles. */
  enabled?: boolean;
  /**
   * Reports the rail's aggregate fill verdict so the caller can collapse the
   * reserved gutter when nothing fills. Fires `true` only once EVERY mounted
   * panel reports empty (no creative, no AdSense backfill); fires `false` as
   * soon as any panel fills. Lets the SPA grid drop the 160px track to zero on
   * an all-empty rail instead of leaving a tall blank column. Omitted on the
   * static/blog portals, which keep their build-time gutter.
   */
  onEmptyResolved?: (allEmpty: boolean) => void;
  /**
   * Max panels cap. BlogArticles passes a length-gated value so long-form posts
   * fill more of the gutter while short ones stay light; omitted elsewhere
   * (tools / job-board / static), where we cap at MAX_PANELS. The actual count
   * is still height-driven — this is only the ceiling.
   */
  count?: number;
  /**
   * Narrow (160px) gutter — the SPA tool-page rail. Forwarded to ArticleRailAd
   * so it requests only 160-wide creatives (no overflow). Reading-page rails
   * (300px) omit this.
   */
  narrow?: boolean;
}

// Approx height of one half-page rail panel (600px creative + flex gap).
const PANEL_PX = 620;
// Minimum gutter height to render any panel — below this, even one 600px
// creative would overflow or reserve an unfilled CLS slot.
const MIN_FILL_PX = 600;
// Bound the number of same-unit requests (ceiling; the real count is the lower
// of "panels that cover the viewport" and "panels the gutter holds").
const MAX_PANELS = 6;

const ArticleRailAdStack: React.FC<ArticleRailAdStackProps> = ({ side, enabled = true, count, narrow = false, onEmptyResolved }) => {
  const ref = useRef<HTMLDivElement>(null);
  // Per-panel GPT verdict, keyed by panel index (true = reported empty).
  const emptyByIndex = useRef<Map<number, boolean>>(new Map());
  // Last verdict pushed to the caller — dedupes repeat reports.
  const lastResolvedRef = useRef<boolean | null>(null);
  // Start at 0 — measurement sets the correct count after mount, avoiding a
  // premature 600px CLS reservation on pages whose gutter is below MIN_FILL_PX.
  const [panels, setPanels] = useState(0);
  const maxPanels = Math.max(1, count ?? MAX_PANELS);

  // Aggregate per-panel GPT verdicts into one rail-level verdict. Collapse
  // (`true`) only once every mounted panel has reported empty; un-collapse
  // (`false`) the moment any panel fills, so a paying creative never sits in a
  // zero-width gutter.
  const handlePanelEmpty = useCallback((index: number, isEmpty: boolean) => {
    emptyByIndex.current.set(index, isEmpty);
    let reported = 0;
    let anyFilled = false;
    for (let i = 0; i < panels; i++) {
      const v = emptyByIndex.current.get(i);
      if (v === undefined) continue;
      reported++;
      if (v === false) anyFilled = true;
    }
    let verdict: boolean | null = null;
    if (anyFilled) verdict = false;
    else if (panels > 0 && reported >= panels) verdict = true;
    if (verdict !== null && verdict !== lastResolvedRef.current) {
      lastResolvedRef.current = verdict;
      onEmptyResolved?.(verdict);
    }
  }, [panels, onEmptyResolved]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const gutter = el.getBoundingClientRect().height;
      // Below MIN_FILL_PX there is no room for even one 600px creative: skip all
      // panels so no CLS slot is reserved on ultra-short tool pages.
      if (gutter < MIN_FILL_PX) {
        setPanels((prev) => (prev === 0 ? prev : 0));
        return;
      }
      // The cluster is sticky, so it only needs enough panels to cover the
      // VIEWPORT — extra panels would sit below the fold (pinned, never seen).
      // Cap by the caller's ceiling and by what the gutter physically holds.
      const byViewport = Math.ceil(window.innerHeight / PANEL_PX);
      const byGutter = Math.round(gutter / PANEL_PX);
      const next = Math.max(1, Math.min(maxPanels, byViewport, byGutter));
      setPanels((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // Viewport height changes (window resize) don't always change the gutter el,
    // so re-measure on resize too.
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [maxPanels]);

  return (
    // Outer `flex-1` claims the full gutter height so the sticky cluster has room
    // to travel and the layout/CLS slot is reserved. Only the widened rail
    // (`xlw`, ≥1400px) hosts the chain — the narrow xl tier (1280–1399) shows no
    // rail ads, exactly as before.
    <div ref={ref} className="hidden xlw:flex xlw:flex-col xlw:flex-1 xlw:min-h-0">
      {/* Inner cluster pins to the viewport top and rides the whole scroll, so a
          tall article's gutter never goes blank below the physical ads. */}
      <div className="sticky top-6 flex flex-col gap-2">
        {Array.from({ length: panels }, (_, i) => (
          <ArticleRailAd
            key={i}
            side={side}
            enabled={enabled}
            reserve={i === 0}
            narrow={narrow}
            onEmptyChange={(isEmpty) => handlePanelEmpty(i, isEmpty)}
          />
        ))}
      </div>
    </div>
  );
};

export default ArticleRailAdStack;
