# SalaryCompare — Mobile Layout (Opzione C2)

**Date:** 2026-03-27
**Component:** `components/comparators/SalaryCompare.tsx`
**Page:** `/statistiche/confronta-stipendi/`

---

## Problem

The sectors tab (`activeTab === 'sectors'`) renders an 8-column table that is unusable on mobile:
- Minimum table width ≈ 620px; even with `overflow-x-auto` users must scroll horizontally
- Sector name is not sticky — loses context while scrolling
- Expanded profession sub-rows suffer the same overflow problem
- The bar-chart section below has a fixed `w-28` label column that wastes space on small screens

---

## Solution

**Dual-layout pattern:** keep the desktop table entirely unchanged; add a separate mobile layout that is shown only on `< sm` breakpoints.

### Mobile layout (< sm) — new

#### Sector list

Each sector is a tappable row:
```
[ Settore name (82px fixed) ] [ CH bar + IT bar (flex) ] [ +XX% delta ] [ ▼ chevron ]
```

- CH bar: red fill, proportional to `chNetEUR / maxVal`
- IT bar: green fill, proportional to `itNet / maxVal`
- Below bars: tiny `CH €X.XXX  IT €X.XXX` amounts in monospace
- Delta: `+XX%` in emerald green
- Chevron: ▼ / ▲ toggle

Tapping the row toggles expansion using the **existing** `expandedSectors` state (no new state needed).

#### Expanded panel — 2-column profession cards

When `expandedSectors.has(sector.id)`, render a 2-column grid below the sector row:

Each profession card contains:
- Profession name (small, `text-xs`)
- Netto CH (`CHF X.XXX`, bold monospace)
- Delta % (emerald green, bold)

Cards that don't fit evenly: last card if odd count shows "+" remaining placeholder.

#### Bottom bar-chart section

Hidden on mobile (`hidden sm:block`) — redundant with inline bars in each sector row.

### Desktop layout (sm+) — unchanged

- Existing 8-column table with `overflow-x-auto`
- Existing expandable profession sub-rows
- Existing bottom bar-chart section (no changes)

---

## Implementation

### File to modify

`components/comparators/SalaryCompare.tsx` — sectors tab block only (~lines 349–562)

### Changes

1. **Wrap existing table+bars** in `<div className="hidden sm:block">…</div>`

2. **Add mobile list** in `<div className="block sm:hidden">…</div>` immediately before the desktop wrapper:
   - Outer container: `space-y-2`
   - Sector row: `flex items-center gap-2 bg-white dark:bg-slate-800 rounded-xl p-3 border border-slate-200 dark:border-slate-700 cursor-pointer`
   - Name column: `w-20 text-xs font-semibold text-slate-800 dark:text-white leading-tight flex-shrink-0`
   - Bars column: `flex-1 min-w-0 space-y-1`
   - Each bar row: `flex items-center gap-1.5` with flag (12px), track (`flex-1 h-2 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden`), fill div with dynamic width
   - Sub-amounts: `flex justify-between text-[10px] font-mono text-slate-400 mt-0.5`
   - Delta: `w-11 text-right text-sm font-bold text-emerald-600 dark:text-emerald-400 flex-shrink-0`
   - Chevron: `w-4 text-slate-400 text-xs flex-shrink-0`

3. **Expanded profession grid** (inside same `block sm:hidden` section):
   - Condition: `expandedSectors.has(sector.id)`
   - Container: `grid grid-cols-2 gap-2 px-3 pb-3`
   - Each card: `bg-slate-50 dark:bg-slate-700/50 rounded-lg p-2.5 border border-slate-100 dark:border-slate-700`
   - Profession name: `text-[11px] text-slate-600 dark:text-slate-300 mb-1.5 leading-tight`
   - CH netto: `font-mono font-bold text-xs text-slate-800 dark:text-white`
   - Delta: `text-xs font-bold text-emerald-600 dark:text-emerald-400`
   - Data: uses existing `calcNetCH`, `ch[selectedLevel]`, `it[selectedLevel]`, `exchangeRate`

---

## Accessibility

- Sector rows are `<div role="button" tabIndex={0}` with `onKeyDown` (Enter/Space) to toggle — same pattern as the rest of the component
- `aria-expanded` on the row
- Profession cards are display-only, no interactive role needed

---

## Tests

No unit tests required for this layout change (it's a pure visual reorganisation with no logic changes). The `expandedSectors` toggle logic is already tested. Visual verification via `npx vite build && npx vite preview` at 375px viewport.

---

## Out of scope

- Professions tab: already responsive (single-column cards on mobile), no changes
- Survey tab: no changes
- Desktop table: no changes
- Bar chart section: only hidden on mobile via `hidden sm:block`, no structural changes
