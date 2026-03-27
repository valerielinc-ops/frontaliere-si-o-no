# SalaryCompare — Mobile Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unreadable 8-column table with a compact mobile list (bars + expandable 2-col profession cards) on viewports narrower than `sm` (640px), keeping desktop unchanged.

**Architecture:** Dual-layout pattern inside the existing `activeTab === 'sectors'` block. Mobile layout (`block sm:hidden`) is added before the desktop content, which is wrapped in `hidden sm:block`. No new state, no new helpers — reuses `expandedSectors`, `sectorTableData`, `toggleSector`, `calcNetCH`, `calcNetIT`, `exchangeRate`, `maxVal`, `profName` already in scope.

**Tech Stack:** React 19, TypeScript 5.8, Tailwind CSS 4

---

### Task 1: Wrap desktop content and add mobile skeleton

**Files:**
- Modify: `components/comparators/SalaryCompare.tsx` ~lines 349–562

- [ ] **Step 1: Locate the sectors tab fragment**

Open `components/comparators/SalaryCompare.tsx`. Find the block starting at `{activeTab === 'sectors' && (` (~line 349). Inside the fragment `<>` there are exactly two children:
1. `<div className="bg-white dark:bg-slate-800 rounded-xl shadow overflow-hidden">` — the table
2. `<div className="bg-white dark:bg-slate-800 rounded-xl shadow p-5">` — the bar chart

- [ ] **Step 2: Wrap both desktop children and insert mobile placeholder**

Replace the entire `{activeTab === 'sectors' && (` block with:

```tsx
{activeTab === 'sectors' && (
  <>
    {/* ── Mobile layout (< sm) ── */}
    <div className="block sm:hidden space-y-2">
      {/* MOBILE_CONTENT_PLACEHOLDER */}
    </div>

    {/* ── Desktop layout (sm+) — unchanged ── */}
    <div className="hidden sm:block space-y-6">
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow overflow-hidden">
        {/* KEEP EVERYTHING HERE EXACTLY AS IT WAS — the overflow-x-auto table */}
```

Then close the desktop wrapper `</div>` after the bar chart section closing `</div>`, before the outer `</>`.

In practice: add `<div className="hidden sm:block space-y-6">` right after `<div className="block sm:hidden space-y-2">…</div>` and add a closing `</div>` at line ~562 (after the PPP note block's `</div>`).

- [ ] **Step 3: TypeScript check — must pass with zero errors**

```bash
npx tsc --noEmit
```

Expected: no errors (placeholder div is valid JSX).

---

### Task 2: Implement mobile sector rows

**Files:**
- Modify: `components/comparators/SalaryCompare.tsx` — replace `{/* MOBILE_CONTENT_PLACEHOLDER */}`

- [ ] **Step 1: Replace placeholder with sector row list**

Replace `{/* MOBILE_CONTENT_PLACEHOLDER */}` with:

```tsx
{sectorTableData.map((r) => (
  <div
    key={r.id}
    className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden"
  >
    {/* Sector row — tappable */}
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expandedSectors.has(r.id)}
      onClick={() => toggleSector(r.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleSector(r.id);
        }
      }}
      className="flex items-center gap-2 p-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors"
    >
      {/* Name */}
      <span className="w-20 text-xs font-semibold text-slate-800 dark:text-white leading-tight flex-shrink-0">
        {r.name}
      </span>

      {/* Bars + amounts */}
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] flex-shrink-0">🇨🇭</span>
          <div className="flex-1 h-2 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-red-500 rounded-full"
              style={{ width: (r.chNetEUR / maxVal) * 100 + '%' }}
            />
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] flex-shrink-0">🇮🇹</span>
          <div className="flex-1 h-2 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full"
              style={{ width: (r.itNet / maxVal) * 100 + '%' }}
            />
          </div>
        </div>
        <div className="flex justify-between text-[10px] font-mono text-slate-500 dark:text-slate-400 mt-0.5">
          <span>CH €{r.chNetEUR.toLocaleString()}</span>
          <span>IT €{r.itNet.toLocaleString()}</span>
        </div>
      </div>

      {/* Delta % */}
      <span className="w-11 text-right text-sm font-bold text-emerald-600 dark:text-emerald-400 flex-shrink-0">
        {r.deltaPercent > 0 ? '+' : ''}{r.deltaPercent}%
      </span>

      {/* Chevron */}
      <span className="w-4 text-center text-slate-500 dark:text-slate-400 text-xs flex-shrink-0">
        {expandedSectors.has(r.id) ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </span>
    </div>

    {/* PROFESSION_GRID_PLACEHOLDER */}
  </div>
))}
```

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors.

---

### Task 3: Implement expanded profession card grid

**Files:**
- Modify: `components/comparators/SalaryCompare.tsx` — replace `{/* PROFESSION_GRID_PLACEHOLDER */}`

- [ ] **Step 1: Replace placeholder with conditional profession grid**

Replace `{/* PROFESSION_GRID_PLACEHOLDER */}` with:

```tsx
{expandedSectors.has(r.id) && (
  <div className="grid grid-cols-2 gap-2 px-3 pb-3">
    {r.professions.map((p) => {
      const ch = p.ch[selectedLevel]; // [min, median, max]
      const it = p.it[selectedLevel]; // [min, median, max]
      const chNet = calcNetCH(ch[1]);
      const itNet = calcNetIT(it[1]);
      const deltaEUR = Math.round(chNet * exchangeRate) - itNet;
      const deltaPct = itNet > 0 ? Math.round((deltaEUR / itNet) * 100) : 0;
      return (
        <div
          key={p.id}
          className="bg-slate-50 dark:bg-slate-700/50 rounded-lg p-2.5 border border-slate-100 dark:border-slate-700"
        >
          <p className="text-[11px] text-slate-600 dark:text-slate-300 mb-1.5 leading-tight">
            {profName(p.id)}
          </p>
          <div className="flex items-center justify-between gap-1">
            <span className="font-mono font-bold text-xs text-slate-800 dark:text-white">
              CHF {chNet.toLocaleString()}
            </span>
            <span className="text-xs font-bold text-emerald-600 dark:text-emerald-400">
              {deltaPct > 0 ? '+' : ''}{deltaPct}%
            </span>
          </div>
        </div>
      );
    })}
  </div>
)}
```

- [ ] **Step 2: TypeScript check + build**

```bash
npx tsc --noEmit && npx vite build
```

Expected: both exit 0 with no errors.

- [ ] **Step 3: Run tests**

```bash
npx vitest run
```

Expected: same pass/fail count as before this change (9 pre-existing failures in `seo-completeness.test.ts` are known and unrelated to this change).

- [ ] **Step 4: Commit**

```bash
git add components/comparators/SalaryCompare.tsx
git commit -m "feat(mobile): compact sector list with expandable profession cards on mobile

Replace unreadable 8-column table with bars+cards layout on viewports < sm.
Desktop table unchanged. Reuses existing expandedSectors state and helpers.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

- [ ] **Step 5: Push**

```bash
git push origin main
```
