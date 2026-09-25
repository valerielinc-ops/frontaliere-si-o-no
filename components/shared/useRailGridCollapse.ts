import { useCallback, useMemo, useState, type CSSProperties } from 'react';

/**
 * Collapses the reserved 300px `xlw` (>=1400px) side-rail gutter shared by
 * JobBoard / JobOrphanView / JobExpiredView / BlogArticles down to 0 when
 * `ArticleRailAdStack` resolves an all-empty verdict (adblock / no AdSense
 * fill) on a side — same intent as the two earlier rail-collapse fixes:
 * the SPA narrow rail (App.tsx `ft-rail-grid-spa`, #2830) and the
 * staticOverlay build-time gutter (App.tsx `.ft-rail-grid`, PR #4829).
 * Issue 4830 tracked the remaining gap on these 4 "reading page" surfaces.
 *
 * Both precedents above drive the collapse with a single
 * `style.gridTemplateColumns` override — safe there because each only runs
 * ONE grid-column breakpoint. These 4 surfaces run TWO breakpoints in
 * parallel on the very same grid: `xl:max-xlw` (180px, 1280–1399px) and
 * `xlw` (300px, >=1400px). An inline `gridTemplateColumns` style wins the
 * cascade at every breakpoint unconditionally (inline style beats any
 * media-queried class), so reusing that pattern here would zero out the
 * 180px tier too, whichever viewport width is active — not what we want.
 *
 * Fix: the `xlw`-tier arbitrary value below references two CSS custom
 * properties (one per side), driven by this hook's `style`. The
 * `xl:max-xlw` tier keeps its own static `180px` literal in the caller's
 * className, untouched by this hook — so the two tiers collapse
 * independently and the 180px tier can never be clobbered.
 */
export interface RailGridCollapse {
  /** Wire to `<ArticleRailAdStack side="left" onEmptyResolved={...} />`. */
  onLeftEmptyResolved: (allEmpty: boolean) => void;
  /** Wire to `<ArticleRailAdStack side="right" onEmptyResolved={...} />`. */
  onRightEmptyResolved: (allEmpty: boolean) => void;
  /** Spread onto the `RAIL_GRID_CLASS_X` wrapper's `style` prop. */
  style: CSSProperties;
}

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
    ['--ft-rail-w-l' as string]: collapsed.left ? '0px' : `${RAIL_WIDE_PX}px`,
    ['--ft-rail-w-r' as string]: collapsed.right ? '0px' : `${RAIL_WIDE_PX}px`,
  } as CSSProperties), [collapsed.left, collapsed.right]);

  return { onLeftEmptyResolved, onRightEmptyResolved, style };
}

/**
 * Shared 2-tier rail grid wrapper class for JobBoard / JobOrphanView /
 * JobExpiredView / BlogArticles. Pair with `useRailGridCollapse`'s `style`
 * output on the same element. Single source of truth so the 7 call sites
 * across the 4 files can't drift (issue 4830, AGENTS.md sibling-pattern
 * rule).
 */
export const RAIL_GRID_CLASS_X =
  'ft-rail-grid-x xl:grid xl:max-xlw:grid-cols-[180px_1fr_180px] xl:gap-4 xlw:grid-cols-[var(--ft-rail-w-l,300px)_minmax(0,1fr)_var(--ft-rail-w-r,300px)]';

/** Shared rail `<aside>` class — pairs with `RAIL_GRID_CLASS_X`. */
export const RAIL_ASIDE_CLASS_X = 'ft-rail-aside-x hidden xl:max-xlw:block xlw:flex xlw:flex-col';
