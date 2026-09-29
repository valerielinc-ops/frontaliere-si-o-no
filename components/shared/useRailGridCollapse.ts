import { useCallback, useMemo, useState, type CSSProperties } from 'react';

/**
 * Collapses the reserved side-rail gutter shared by JobBoard / JobOrphanView /
 * JobExpiredView down to 0 when `ArticleRailAdStack` resolves an all-empty
 * verdict (adblock / no AdSense fill) on a side — same intent as the two
 * earlier rail-collapse fixes:
 * the SPA narrow rail (App.tsx `ft-rail-grid-spa`, #2830) and the
 * staticOverlay build-time gutter (App.tsx `.ft-rail-grid`, PR #4829).
 * Issue 4830 tracked the remaining gap on the "reading page" surfaces.
 * BlogArticles shares the grid class but NOT this hook: its gutters also hold
 * the partner cards, TOC and resources, so a 0px track would push that content
 * underneath the article — its rails keep their width whatever the fill.
 *
 * The shared class has two parallel grid tiers: `xl:max-xlw` (180px,
 * 1280–1399px) and `xlw` (300px, >=1400px); BlogArticles adds a local 160px
 * tier at 1200–1279px. An inline `gridTemplateColumns` style wins the cascade
 * at every breakpoint unconditionally (inline style beats any media-queried
 * class), so reusing the old single-tier pattern here would zero out the other
 * tiers too, whichever viewport width is active — not what we want.
 *
 * Fix: each grid tier references two CSS custom properties (one per side),
 * driven by this hook's `style`. The defaults preserve the existing layout for
 * callers that do not receive an empty verdict.
 */
export interface RailGridCollapse {
  /** Wire to `<ArticleRailAdStack side="left" onEmptyResolved={...} />`. */
  onLeftEmptyResolved: (allEmpty: boolean) => void;
  /** Wire to `<ArticleRailAdStack side="right" onEmptyResolved={...} />`. */
  onRightEmptyResolved: (allEmpty: boolean) => void;
  /** Spread onto the `RAIL_GRID_CLASS_X` wrapper's `style` prop. */
  style: CSSProperties;
}

/** Reserved width of the compact article tier when a side's rail is not collapsed. */
const RAIL_COMPACT_PX = 160;
/** Reserved width of the existing `xl` tier when a side's rail is not collapsed. */
const RAIL_MEDIUM_PX = 180;
/** Reserved width of the `xlw` tier when a side's rail is not collapsed. */
const RAIL_WIDE_PX = 300;

export function useRailGridCollapse(): RailGridCollapse {
  const [collapsed, setCollapsed] = useState<{ left: boolean; right: boolean }>({ left: false, right: false });

  const onLeftEmptyResolved = useCallback((allEmpty: boolean) => {
    setCollapsed((s) => (s.left === allEmpty ? s : { ...s, left: allEmpty }));
  }, []);
  const onRightEmptyResolved = useCallback((allEmpty: boolean) => {
    setCollapsed((s) => (s.right === allEmpty ? s : { ...s, right: allEmpty }));
  }, []);

  const style = useMemo<CSSProperties>(() => ({
    ['--ft-rail-w-c-l' as string]: collapsed.left ? '0px' : `${RAIL_COMPACT_PX}px`,
    ['--ft-rail-w-c-r' as string]: collapsed.right ? '0px' : `${RAIL_COMPACT_PX}px`,
    ['--ft-rail-w-m-l' as string]: collapsed.left ? '0px' : `${RAIL_MEDIUM_PX}px`,
    ['--ft-rail-w-m-r' as string]: collapsed.right ? '0px' : `${RAIL_MEDIUM_PX}px`,
    ['--ft-rail-w-l' as string]: collapsed.left ? '0px' : `${RAIL_WIDE_PX}px`,
    ['--ft-rail-w-r' as string]: collapsed.right ? '0px' : `${RAIL_WIDE_PX}px`,
  } as CSSProperties), [collapsed.left, collapsed.right]);

  return { onLeftEmptyResolved, onRightEmptyResolved, style };
}

/**
 * Shared 3-tier rail grid wrapper class for JobBoard / JobOrphanView /
 * JobExpiredView / BlogArticles. Pair with `useRailGridCollapse`'s `style`
 * output on the same element where the gutters hold only ads (the job pages);
 * without it the CSS custom properties fall back to the reserved widths, which
 * is what BlogArticles relies on. Single source of truth so the call sites
 * across the 4 files can't drift (issue 4830, AGENTS.md sibling-pattern
 * rule).
 */
export const RAIL_GRID_CLASS_X =
  'ft-rail-grid-x xl:grid xl:max-xlw:grid-cols-[var(--ft-rail-w-m-l,180px)_minmax(0,1fr)_var(--ft-rail-w-m-r,180px)] xl:gap-4 xlw:grid-cols-[var(--ft-rail-w-l,300px)_minmax(0,1fr)_var(--ft-rail-w-r,300px)]';

/** Shared rail `<aside>` class — pairs with `RAIL_GRID_CLASS_X`. */
export const RAIL_ASIDE_CLASS_X = 'ft-rail-aside-x hidden xl:max-xlw:block xlw:flex xlw:flex-col';
