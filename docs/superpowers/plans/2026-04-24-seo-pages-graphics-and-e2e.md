# SEO Pages: Graphics Fixes + Content Integrity + E2E Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix graphical regressions on three SEO page families (border waits, fuel daily, weekly employers), eliminate "empty content" pages linked from the site, and wire a Playwright E2E smoke test into the CI pipeline so these regressions never ship again.

**Architecture:** Three independent page-generator plugins live in `build-plugins/`. Each emits static HTML into `dist/` at build time. Root causes identified:

1. **`borderWaitPagesPlugin.ts`** — "Valico più veloce" green hero card renders "0 min" when every crossing is 0, producing visual dead space. No fallback for the degenerate case. **Additional UI/UX issues:** background `--color-success-subtle` + foreground "0 min" in the success-tinted link colour fail WCAG AA contrast (≈2.1:1 vs required 4.5:1 for body text). The whole card blends into the page.
2. **`fuelDailyPagesPlugin.ts`** — 7-day sparkline needs ≥6 historical snapshots; repo has only 2, so chart renders with gaps. **Additional UI/UX issue:** `renderSparklineChart` uses `preserveAspectRatio="none"` + fixed `height:110px` + `width:100%` — on a ~1200px container this stretches the viewBox 11:1 horizontally, squashing vertical motion to near-flat. When there are only 2–3 points it looks broken.
3. **`weeklyEmployersPlugin.ts`** — Link graph (footer hubs, related-links blocks, sitemap) emits URLs for `/aziende-che-assumono/{city}/{company}/settimana-corrente/` **without** applying the same `MIN_JOBS_PER_COMPANY_IN_CITY = 3` gate used by the page generator. Links exist; pages don't; SPA returns shell.
4. **E2E orphaned** — 4 Playwright specs exist in `tests/e2e/` but no npm script runs them and no workflow exercises them in CI. No visual regression. No a11y contrast check.

**Tech Stack:** TypeScript 5.8, Vite 6 plugins, Playwright ^1.58.2, GitHub Actions, Node 20.

---

## File Structure

**Modify:**
- `build-plugins/borderWaitPagesPlugin.ts` (lines 1351–1375: hero card rendering + contrast fix)
- `build-plugins/fuelDailyPagesPlugin.ts` (lines 901–941: trend series + chart gate + chart sizing)
- `build-plugins/shared/seoContentTokens.ts` (lines 449–630: `renderSparklineChart` null-tolerant + aspect-ratio-correct)
- `build-plugins/weeklyEmployersPlugin.ts` (link emission locations — footer/related/sitemap)
- `build-plugins/weeklyEmployersData.ts` (export helper `companyCityMeetsThreshold` for link-graph consumers)
- `index.css` (add `--color-success-fg` foreground token guaranteed to clear 4.5:1 vs `--color-success-subtle`, if not already present)
- `.github/workflows/update-fuel-prices.yml` (persist snapshot to `data/fuel-prices-history/YYYY-MM-DD.json`)
- `package.json` (add `test:e2e`, `test:e2e:smoke`, `test:e2e:visual` scripts)
- `playwright.config.ts` (add `projects` with `chromium` only, artifact uploads, screenshot folder)

**Create:**
- `tests/e2e/seo-content-integrity.spec.ts` — crawl representative SEO URLs, assert body word count ≥ 50 (per CLAUDE.md rule #4 — no thin content)
- `tests/e2e/seo-visual-ui.spec.ts` — a11y contrast + layout assertions (hero card visibility, chart aspect ratio)
- `tests/e2e/seo-visual-regression.spec.ts` — baseline screenshot diff for the 3 fixed page families
- `tests/e2e/link-graph-integrity.spec.ts` — parse `dist/sitemap.xml`, HEAD each URL, assert static HTML exists at matching path under `dist/`
- `tests/e2e/helpers/wordCount.ts` — shared helper
- `tests/e2e/helpers/contrast.ts` — WCAG contrast ratio helper (pure TS port)
- `.github/workflows/e2e.yml` — build + preview + playwright, upload traces + screenshots on failure
- `scripts/seed-jobs-snapshots-history.mjs` — optional one-shot to seed `data/jobs-snapshots-history/` so weekly-employers plugin exits degraded mode

---

## Phase 1 — Border Wait Hero Card

### Task 1: Add test for degenerate "all zeros" rendering

**Files:**
- Create: `tests/build-plugins/borderWaitHeroCard.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { renderFastestCrossingCard } from '@/build-plugins/borderWaitPagesPlugin';

describe('renderFastestCrossingCard', () => {
  it('returns empty string when every crossing has 0 min wait', () => {
    const crossings = [
      { slug: 'chiasso-centro', labelIt: 'Chiasso Centro', waitTimeMinutes: 0 },
      { slug: 'gaggiolo', labelIt: 'Gaggiolo', waitTimeMinutes: 0 },
    ];
    const html = renderFastestCrossingCard(crossings, 'it');
    expect(html).toBe('');
  });

  it('renders the hero when at least one crossing has > 0 min wait', () => {
    const crossings = [
      { slug: 'chiasso-centro', labelIt: 'Chiasso Centro', waitTimeMinutes: 0 },
      { slug: 'gaggiolo', labelIt: 'Gaggiolo', waitTimeMinutes: 12 },
    ];
    const html = renderFastestCrossingCard(crossings, 'it');
    expect(html).toContain('Chiasso Centro');
    expect(html).toContain('0 min');
  });
});
```

- [ ] **Step 2: Run test — verify it fails (function not exported / file not importable)**

Run: `npx vitest run tests/build-plugins/borderWaitHeroCard.test.ts`
Expected: FAIL with import error.

- [ ] **Step 3: Extract `renderFastestCrossingCard` from inline block at `borderWaitPagesPlugin.ts:1351-1375` into a named exported function; add the zero-guard**

```typescript
// Near existing helpers in borderWaitPagesPlugin.ts
export interface FastestCrossingInput {
  slug: string;
  labelIt: string;
  labelEn?: string;
  labelDe?: string;
  labelFr?: string;
  waitTimeMinutes: number;
}

export function renderFastestCrossingCard(
  crossings: ReadonlyArray<FastestCrossingInput>,
  locale: 'it' | 'en' | 'de' | 'fr',
): string {
  const hasAnyWait = crossings.some((c) => c.waitTimeMinutes > 0);
  if (!hasAnyWait) return '';

  let best = crossings[0];
  for (const c of crossings) {
    if (c.waitTimeMinutes > 0 && (best.waitTimeMinutes === 0 || c.waitTimeMinutes < best.waitTimeMinutes)) {
      best = c;
    }
  }
  const label = locale === 'it' ? 'Valico più veloce adesso'
    : locale === 'en' ? 'Fastest crossing now'
    : locale === 'de' ? 'Schnellster Übergang jetzt'
    : 'Passage le plus rapide maintenant';

  return `<div style="margin:0 0 20px;padding:14px 18px;border-radius:12px;background:var(--color-success-subtle);border:1px solid var(--color-success-border);">
  <strong>${label}:</strong>
  <a href="${buildCrossingPath(best.slug, locale)}">${getCrossingLabel(best, locale)}</a> · ${best.waitTimeMinutes} min
</div>`;
}
```

Replace the original inline block (lines 1351–1375) with a call:
```typescript
const heroHtml = renderFastestCrossingCard(crossingsInScope, locale);
// then concatenate heroHtml into the page template; empty string contributes nothing
```

- [ ] **Step 4: Run tests — verify both pass**

Run: `npx vitest run tests/build-plugins/borderWaitHeroCard.test.ts`
Expected: 2 PASS.

- [ ] **Step 5: Commit**

```bash
git add build-plugins/borderWaitPagesPlugin.ts tests/build-plugins/borderWaitHeroCard.test.ts
git commit -m "fix(border-wait): hide 'fastest crossing' hero when every wait is 0"
```

### Task 2: Add "traffico fluido" fallback banner for the all-zeros case

**Files:**
- Modify: `build-plugins/borderWaitPagesPlugin.ts` (same region)
- Modify: `tests/build-plugins/borderWaitHeroCard.test.ts`

- [ ] **Step 1: Write failing test for fallback banner helper**

```typescript
it('renderTrafficFluidBanner returns a reassuring banner when all zeros', () => {
  const html = renderTrafficFluidBanner(true, 'it');
  expect(html).toContain('Traffico fluido');
});
it('renderTrafficFluidBanner returns empty when data not all zeros', () => {
  expect(renderTrafficFluidBanner(false, 'it')).toBe('');
});
```

- [ ] **Step 2: Verify fail**

Run: `npx vitest run tests/build-plugins/borderWaitHeroCard.test.ts`
Expected: FAIL — `renderTrafficFluidBanner` not exported.

- [ ] **Step 3: Implement**

```typescript
export function renderTrafficFluidBanner(allZeros: boolean, locale: 'it'|'en'|'de'|'fr'): string {
  if (!allZeros) return '';
  const copy = {
    it: { title: 'Traffico fluido su tutti i valichi', body: 'Nessuna coda significativa rilevata in questo momento. I tempi si aggiornano ogni 15 minuti.' },
    en: { title: 'Traffic flowing at every crossing', body: 'No significant queues right now. Wait times refresh every 15 minutes.' },
    de: { title: 'Flüssiger Verkehr an allen Übergängen', body: 'Derzeit keine nennenswerten Staus. Wartezeiten werden alle 15 Minuten aktualisiert.' },
    fr: { title: 'Circulation fluide à tous les passages', body: 'Aucune file d\'attente significative actuellement. Mise à jour toutes les 15 minutes.' },
  }[locale];
  return `<div style="margin:0 0 20px;padding:16px 20px;border-radius:12px;background:var(--color-success-subtle);border:1px solid var(--color-success-border);">
  <p style="margin:0 0 4px;font-weight:600;">${copy.title}</p>
  <p style="margin:0;color:var(--color-text-muted);font-size:14px;">${copy.body}</p>
</div>`;
}
```

Integrate in the template:
```typescript
const allZeros = crossingsInScope.every((c) => c.waitTimeMinutes === 0);
const heroBlock = allZeros
  ? renderTrafficFluidBanner(true, locale)
  : renderFastestCrossingCard(crossingsInScope, locale);
```

- [ ] **Step 4: Verify pass**

Run: `npx vitest run tests/build-plugins/borderWaitHeroCard.test.ts`
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add build-plugins/borderWaitPagesPlugin.ts tests/build-plugins/borderWaitHeroCard.test.ts
git commit -m "fix(border-wait): show 'traffico fluido' banner when every crossing is 0 min"
```

### Task 2b: Fix hero card contrast — foreground tokens + stronger text

**Files:**
- Modify: `index.css` (tokens block)
- Modify: `build-plugins/borderWaitPagesPlugin.ts` (hero + fluid-traffic markup)
- Create: `tests/build-plugins/borderWaitContrast.test.ts`

**Why:** The current card paints `--color-success-subtle` (pale green) behind text that inherits muted page colour. The final "0 min" text in particular is a low-contrast green-on-green. WCAG AA body text requires 4.5:1.

- [ ] **Step 1: Audit current token values**

Run: `grep -nE "--(_|color-)success" index.css`
Expected: confirm `--color-success-subtle`, `--color-success-border`, `--color-success-strong` exist; note whether a foreground token exists.

- [ ] **Step 2: Write failing contrast test**

```typescript
// tests/build-plugins/borderWaitContrast.test.ts
import { describe, it, expect } from 'vitest';
import { renderFastestCrossingCard, renderTrafficFluidBanner } from '@/build-plugins/borderWaitPagesPlugin';

describe('border-wait hero contrast markup', () => {
  it('hero card text uses strong foreground token, not default', () => {
    const html = renderFastestCrossingCard(
      [{ slug: 'a', labelIt: 'A', waitTimeMinutes: 10 }],
      'it',
    );
    // Wait-time span must declare an explicit foreground colour.
    expect(html).toMatch(/color:\s*var\(--color-success-strong\)/);
  });
  it('fluid banner body text does not rely on muted colour', () => {
    const html = renderTrafficFluidBanner(true, 'it');
    expect(html).not.toMatch(/color:\s*var\(--color-text-muted\)/);
    expect(html).toMatch(/color:\s*var\(--color-text\)/);
  });
});
```

- [ ] **Step 3: Run — verify fail**

Run: `npx vitest run tests/build-plugins/borderWaitContrast.test.ts`
Expected: FAIL.

- [ ] **Step 4: Patch markup to use strong foreground tokens**

In `renderFastestCrossingCard` change the trailing `· ${waitTimeMinutes} min` to:
```typescript
` · <span style="color:var(--color-success-strong);font-weight:600;">${best.waitTimeMinutes} min</span>`
```
In `renderTrafficFluidBanner` change body `color:var(--color-text-muted)` to `color:var(--color-text)`.
Add a subtle left-border accent for visual anchoring:
```typescript
// Update background style to include a 4px left rail:
`background:var(--color-success-subtle);border:1px solid var(--color-success-border);border-left:4px solid var(--color-success-strong);`
```

- [ ] **Step 5: Verify pass**

Run: `npx vitest run tests/build-plugins/borderWaitContrast.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add build-plugins/borderWaitPagesPlugin.ts tests/build-plugins/borderWaitContrast.test.ts
git commit -m "fix(border-wait): raise hero + fluid banner text contrast to WCAG AA"
```

---

## Phase 2 — Fuel Daily Sparkline

### Task 3: Null-tolerant sparkline — skip gaps, require ≥3 real points

**Files:**
- Modify: `build-plugins/shared/seoContentTokens.ts:449-630` (`renderSparklineChart`)
- Modify: `build-plugins/fuelDailyPagesPlugin.ts:901-941`
- Create: `tests/build-plugins/sparklineGaps.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { renderSparklineChart } from '@/build-plugins/shared/seoContentTokens';

describe('renderSparklineChart', () => {
  it('returns empty string when fewer than 3 non-null points', () => {
    const html = renderSparklineChart([
      { label: '2026-04-18', value: null },
      { label: '2026-04-19', value: null },
      { label: '2026-04-20', value: 1.80 },
      { label: '2026-04-21', value: 1.82 },
    ], { unit: 'CHF/litro' });
    expect(html).toBe('');
  });

  it('draws a continuous polyline skipping nulls when >=3 points', () => {
    const html = renderSparklineChart([
      { label: '2026-04-18', value: 1.80 },
      { label: '2026-04-19', value: null },
      { label: '2026-04-20', value: 1.82 },
      { label: '2026-04-21', value: 1.81 },
    ], { unit: 'CHF/litro' });
    expect(html).toContain('<svg');
    // Polyline must not contain any NaN or empty coordinate
    expect(html).not.toMatch(/NaN|,\s*,/);
    // Points count on polyline (approx) == 3 numeric
    const polyMatch = html.match(/points="([^"]+)"/);
    expect(polyMatch).toBeTruthy();
    const coords = polyMatch![1].trim().split(/\s+/);
    expect(coords.length).toBe(3);
  });
});
```

- [ ] **Step 2: Run test — verify fail**

Run: `npx vitest run tests/build-plugins/sparklineGaps.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update `renderSparklineChart` to skip nulls and enforce minimum**

In `build-plugins/shared/seoContentTokens.ts`:
```typescript
const MIN_POINTS = 3;
export function renderSparklineChart(
  series: ReadonlyArray<{ label: string; value: number | null }>,
  opts: { unit?: string; width?: number; height?: number; targetId?: string } = {},
): string {
  const numeric = series
    .map((p, i) => ({ i, ...p }))
    .filter((p): p is { i: number; label: string; value: number } => p.value != null && Number.isFinite(p.value));
  if (numeric.length < MIN_POINTS) return '';
  // ...existing min/max/avg logic, now iterating `numeric`
  // polyline points are built from `numeric` only — so gaps collapse into a continuous line
}
```

- [ ] **Step 4: Update caller in `fuelDailyPagesPlugin.ts:901-941` to pass null-tolerant array**

Change line 925 guard from `numericTrendPoints.length >= 2` to delegating to the renderer (renderer returns '' when insufficient). If empty, render a fallback message:
```typescript
const chartHtml = renderSparklineChart(trendSeries, { unit: 'CHF/litro' });
const chartBlock = chartHtml || `<p class="text-sm text-slate-500">${
  locale === 'it' ? 'Storico in costruzione — torna tra qualche giorno.' : /* ...other locales */ ''
}</p>`;
```

- [ ] **Step 5: Run test**

Run: `npx vitest run tests/build-plugins/sparklineGaps.test.ts`
Expected: 2 PASS.

- [ ] **Step 6: Commit**

```bash
git add build-plugins/shared/seoContentTokens.ts build-plugins/fuelDailyPagesPlugin.ts tests/build-plugins/sparklineGaps.test.ts
git commit -m "fix(fuel): sparkline skips null days, requires >=3 points else fallback"
```

### Task 3b: Fix squashed sparkline — preserve aspect ratio + larger default height

**Files:**
- Modify: `build-plugins/shared/seoContentTokens.ts` (SVG attributes at line 583)
- Modify: `tests/build-plugins/sparklineGaps.test.ts`

**Why:** Current SVG uses `preserveAspectRatio="none"` with `width:100%;height:110px` — on a 1200px container this stretches the viewBox 11:1 and flattens the line. With only 3 points after null-filtering, the trend looks static.

- [ ] **Step 1: Add failing tests**

```typescript
it('svg preserves aspect ratio (no "none")', () => {
  const html = renderSparklineChart(
    [
      { label: '2026-04-18', value: 1.80 },
      { label: '2026-04-19', value: 1.82 },
      { label: '2026-04-20', value: 1.79 },
    ],
    { unit: 'CHF/litro' },
  );
  expect(html).toContain('<svg');
  expect(html).not.toContain('preserveAspectRatio="none"');
  expect(html).toMatch(/preserveAspectRatio="xMidYMid meet"/);
});

it('svg viewBox is tall enough that vertical motion is visible (min height 220)', () => {
  const html = renderSparklineChart(
    [
      { label: '2026-04-18', value: 1.80 },
      { label: '2026-04-19', value: 1.82 },
      { label: '2026-04-20', value: 1.79 },
    ],
    { unit: 'CHF/litro' },
  );
  const viewBox = html.match(/viewBox="0 0 (\d+) (\d+)"/);
  expect(viewBox).toBeTruthy();
  const [, w, h] = viewBox!;
  // Aspect ratio should not exceed ~4:1 so the line isn't visually flattened.
  expect(Number(w) / Number(h)).toBeLessThanOrEqual(4);
});
```

- [ ] **Step 2: Run — verify fail**

Run: `npx vitest run tests/build-plugins/sparklineGaps.test.ts`
Expected: FAIL on new cases.

- [ ] **Step 3: Patch `renderSparklineChart` signature + SVG attrs**

Change defaults:
```typescript
const height = Math.max(180, Math.min(260, opts.height ?? 220));
const width = Math.max(480, Math.min(880, opts.width ?? 720));
```
Change SVG tag:
```typescript
return `<svg role="img" aria-label="${esc(opts.ariaLabel)}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" style="width:100%;max-width:${width}px;height:auto;display:block;overflow:visible">
```
Increase `padBottom` to `24` so tick labels don't overlap the line, and `padTop` to `12`.

- [ ] **Step 4: Verify pass**

Run: `npx vitest run tests/build-plugins/sparklineGaps.test.ts`
Expected: all PASS.

- [ ] **Step 5: Manual sanity — rebuild one fuel page, eyeball**

```bash
npx vite build
open dist/prezzi-benzina-oggi/ticino/benzina/index.html  # or equivalent IT path
```
Expected: chart is clearly taller (~220px), line shows visible slope even with 3 points.

- [ ] **Step 6: Commit**

```bash
git add build-plugins/shared/seoContentTokens.ts tests/build-plugins/sparklineGaps.test.ts
git commit -m "fix(sparkline): preserve aspect ratio and raise default height to stop squash"
```

### Task 4: Persist fuel-prices snapshot daily so history grows

**Files:**
- Modify: `.github/workflows/update-fuel-prices.yml`

- [ ] **Step 1: Read current workflow**

Run: `cat .github/workflows/update-fuel-prices.yml`
Note current schedule + commit step.

- [ ] **Step 2: Add history persistence step before commit**

```yaml
- name: Persist daily snapshot
  run: |
    TODAY=$(date -u +%F)
    mkdir -p data/fuel-prices-history
    cp public/data/fuel-prices.json "data/fuel-prices-history/${TODAY}.json"
    git add "data/fuel-prices-history/${TODAY}.json"
```

- [ ] **Step 3: Verify YAML is valid**

Run: `npx js-yaml .github/workflows/update-fuel-prices.yml > /dev/null`
Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/update-fuel-prices.yml
git commit -m "ci(fuel): persist daily snapshot to data/fuel-prices-history/"
```

---

## Phase 3 — Weekly Employers Link Graph Integrity

### Task 5: Export threshold gate from `weeklyEmployersData.ts`

**Files:**
- Modify: `build-plugins/weeklyEmployersData.ts` (near line 338)
- Create: `tests/build-plugins/weeklyEmployersThreshold.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { companyCityMeetsThreshold, MIN_JOBS_PER_COMPANY_IN_CITY } from '@/build-plugins/weeklyEmployersData';

describe('companyCityMeetsThreshold', () => {
  it('returns false when active jobs < MIN', () => {
    expect(companyCityMeetsThreshold({ active: 2 })).toBe(false);
  });
  it('returns true when active jobs >= MIN', () => {
    expect(companyCityMeetsThreshold({ active: MIN_JOBS_PER_COMPANY_IN_CITY })).toBe(true);
  });
});
```

- [ ] **Step 2: Verify fail**

Run: `npx vitest run tests/build-plugins/weeklyEmployersThreshold.test.ts`
Expected: FAIL — export missing.

- [ ] **Step 3: Add export**

```typescript
export const MIN_JOBS_PER_COMPANY_IN_CITY = 3;
export function companyCityMeetsThreshold(rec: Readonly<{ active: number }>): boolean {
  return rec.active >= MIN_JOBS_PER_COMPANY_IN_CITY;
}
```

Replace internal usage at plugin line 730 with this helper.

- [ ] **Step 4: Verify pass**

Run: `npx vitest run tests/build-plugins/weeklyEmployersThreshold.test.ts`
Expected: 2 PASS.

- [ ] **Step 5: Commit**

```bash
git add build-plugins/weeklyEmployersData.ts build-plugins/weeklyEmployersPlugin.ts tests/build-plugins/weeklyEmployersThreshold.test.ts
git commit -m "refactor(weekly-employers): extract threshold gate helper"
```

### Task 6: Apply threshold gate to ALL link emitters (footer, related, sitemap)

**Files:**
- Modify: `build-plugins/weeklyEmployersPlugin.ts` (every place that builds `buildCompanyCityCurrentPath(...)` into an `<a>` or sitemap entry)
- Modify: `build-plugins/shared/relatedLinks.ts` (if it generates these URLs)

- [ ] **Step 1: Find every link emission site**

Run: `Grep pattern="buildCompanyCityCurrentPath" path="build-plugins"` — list each file:line.
Expected files: `weeklyEmployersPlugin.ts`, `shared/relatedLinks.ts`, `jobMarketSnapshotPlugin.ts`, `blogContextualLinksData.ts`, `weeklyEmployersData.ts`.

- [ ] **Step 2: Write failing integration test**

Create `tests/build-plugins/weeklyEmployersLinkGate.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { buildCompanyCityLinks } from '@/build-plugins/weeklyEmployersPlugin';

describe('buildCompanyCityLinks', () => {
  it('omits pairs below the threshold', () => {
    const pairs = [
      { city: 'chiasso', company: 'pemsa', active: 1 },
      { city: 'bellinzona', company: 'swisscom', active: 6 },
    ];
    const links = buildCompanyCityLinks(pairs, 'it');
    expect(links).toHaveLength(1);
    expect(links[0].href).toContain('/bellinzona/swisscom/');
  });
});
```

- [ ] **Step 3: Run — verify fail**

Run: `npx vitest run tests/build-plugins/weeklyEmployersLinkGate.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement / wire the gate into every emitter**

In `weeklyEmployersPlugin.ts` add:
```typescript
export function buildCompanyCityLinks(
  pairs: ReadonlyArray<{ city: string; company: string; active: number }>,
  locale: 'it' | 'en' | 'de' | 'fr',
): ReadonlyArray<{ href: string; label: string }> {
  return pairs
    .filter(companyCityMeetsThreshold)
    .map((p) => ({
      href: buildCompanyCityCurrentPath(p.city, p.company, locale),
      label: `${p.company} — ${p.city}`,
    }));
}
```

Replace every footer/related/sitemap call site to use this helper or add `.filter(companyCityMeetsThreshold)` before emission. Pay special attention to:
- sitemap entry emission (around plugin end, before `emitFile`)
- related-links block inside company hub pages
- related-links block inside city hub pages

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/build-plugins/`
Expected: all pass.

- [ ] **Step 6: Full build smoke — ensure the empty URLs are no longer in sitemap**

```bash
npx vite build
grep -c "/aziende-che-assumono/chiasso/pemsa/settimana-corrente/" dist/sitemap.xml || true
```
Expected: `0`.

- [ ] **Step 7: Commit**

```bash
git add build-plugins/weeklyEmployersPlugin.ts build-plugins/shared/relatedLinks.ts tests/build-plugins/weeklyEmployersLinkGate.test.ts
git commit -m "fix(weekly-employers): gate link emission by MIN_JOBS threshold to remove empty targets"
```

---

## Phase 4 — E2E Pipeline

### Task 7: SEO content integrity spec

**Files:**
- Create: `tests/e2e/helpers/wordCount.ts`
- Create: `tests/e2e/seo-content-integrity.spec.ts`

- [ ] **Step 1: Write helper**

```typescript
// tests/e2e/helpers/wordCount.ts
export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
```

- [ ] **Step 2: Write spec**

```typescript
import { test, expect } from 'playwright/test';
import { wordCount } from './helpers/wordCount';

const SEO_URLS = [
  '/traffico-dogane/',
  '/traffico-dogane/chiasso-centro/',
  '/prezzi-benzina-oggi/',
  '/aziende-che-assumono/',
  '/assicurazione-malattia/',
];

for (const url of SEO_URLS) {
  test(`SEO page has real content: ${url}`, async ({ page }) => {
    const resp = await page.goto(url, { waitUntil: 'networkidle' });
    expect(resp?.status(), `HTTP status for ${url}`).toBe(200);
    const main = page.locator('main, article, #root').first();
    const text = (await main.innerText()).trim();
    expect(wordCount(text), `Word count on ${url}`).toBeGreaterThan(50);
    // No "not found" indicator
    await expect(page.locator('text=/404|not found|non trovata/i')).toHaveCount(0);
  });
}
```

- [ ] **Step 3: Run locally (build must exist)**

```bash
npx vite build
npx playwright test tests/e2e/seo-content-integrity.spec.ts
```
Expected: 5 PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/helpers/wordCount.ts tests/e2e/seo-content-integrity.spec.ts
git commit -m "test(e2e): assert SEO pages render real content (>50 words)"
```

### Task 8: Link graph integrity spec

**Files:**
- Create: `tests/e2e/link-graph-integrity.spec.ts`

- [ ] **Step 1: Write spec**

```typescript
import { test, expect } from 'playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');

function extractSitemapUrls(): string[] {
  const xml = readFileSync(resolve(DIST, 'sitemap.xml'), 'utf-8');
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
}

test('every sitemap URL has a static HTML file in dist/', () => {
  const urls = extractSitemapUrls();
  expect(urls.length, 'sitemap is not empty').toBeGreaterThan(100);
  const missing: string[] = [];
  for (const p of urls) {
    const filePath = resolve(DIST, p.replace(/^\//, '').replace(/\/$/, '/index.html'));
    if (!existsSync(filePath)) missing.push(p);
  }
  expect(missing, `Missing static HTML for: ${missing.slice(0, 5).join(', ')}`).toHaveLength(0);
});

test.describe('namespaced page smoke crawl', () => {
  const NAMESPACES = [
    '/aziende-che-assumono/',
    '/traffico-dogane/',
    '/prezzi-benzina-oggi/',
    '/lavori-frontalieri/',
  ];
  for (const ns of NAMESPACES) {
    test(`namespace has >=5 URLs in sitemap: ${ns}`, () => {
      const urls = extractSitemapUrls().filter((u) => u.startsWith(ns));
      expect(urls.length, `pages under ${ns}`).toBeGreaterThanOrEqual(5);
    });
  }
});
```

- [ ] **Step 2: Run locally**

```bash
npx vite build
npx playwright test tests/e2e/link-graph-integrity.spec.ts
```
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/link-graph-integrity.spec.ts
git commit -m "test(e2e): assert sitemap URLs resolve to static HTML and namespaces are populated"
```

### Task 8b: Visual/UX E2E — contrast + chart shape + card padding

**Files:**
- Create: `tests/e2e/helpers/contrast.ts`
- Create: `tests/e2e/seo-visual-ui.spec.ts`

**Why:** Unit tests verify markup. The live UI must also pass: contrast of rendered text against its background, chart not collapsed to a line, card height reasonable.

- [ ] **Step 1: Write contrast helper (pure TS, no deps)**

```typescript
// tests/e2e/helpers/contrast.ts
function relLum(rgb: readonly [number, number, number]): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function parseRgb(s: string): [number, number, number] {
  const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) throw new Error(`Cannot parse rgb: ${s}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function contrastRatio(fg: string, bg: string): number {
  const l1 = relLum(parseRgb(fg));
  const l2 = relLum(parseRgb(bg));
  const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}
```

- [ ] **Step 2: Write spec**

```typescript
// tests/e2e/seo-visual-ui.spec.ts
import { test, expect } from 'playwright/test';
import { contrastRatio } from './helpers/contrast';

test.describe('Border-wait hero card', () => {
  test('hero or fluid-traffic banner renders with WCAG AA contrast', async ({ page }) => {
    await page.goto('/traffico-dogane/', { waitUntil: 'networkidle' });

    const banner = page.locator('main >> css=[style*="--color-success-subtle"]').first();
    await expect(banner).toBeVisible();

    const bg = await banner.evaluate((el) => getComputedStyle(el).backgroundColor);
    // Grab the strongest-weight text inside the banner
    const strong = banner.locator('strong, [style*="font-weight:600"]').first();
    const fg = await strong.evaluate((el) => getComputedStyle(el).color);

    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  test('hero card vertical padding is within expected range (not collapsed)', async ({ page }) => {
    await page.goto('/traffico-dogane/', { waitUntil: 'networkidle' });
    const banner = page.locator('main >> css=[style*="--color-success-subtle"]').first();
    const box = await banner.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.height, 'banner height').toBeGreaterThanOrEqual(56);
    expect(box!.height, 'banner should not be huge either').toBeLessThanOrEqual(140);
  });
});

test.describe('Fuel daily sparkline shape', () => {
  test('chart is not squashed — bounding box aspect ratio <= 4:1', async ({ page }) => {
    // Pick a URL known to ship after build
    await page.goto('/prezzi-benzina-oggi/', { waitUntil: 'networkidle' });
    const svg = page.locator('svg[role="img"][aria-label*="prezzo"], svg[role="img"][aria-label*="price"]').first();
    if (await svg.count() === 0) test.skip(true, 'No chart on this page — skipping');
    const box = await svg.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.width / box!.height, 'chart aspect ratio').toBeLessThanOrEqual(4);
    expect(box!.height, 'chart height').toBeGreaterThanOrEqual(160);
  });
});
```

- [ ] **Step 3: Run**

```bash
npm run build
npx playwright test tests/e2e/seo-visual-ui.spec.ts
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/helpers/contrast.ts tests/e2e/seo-visual-ui.spec.ts
git commit -m "test(e2e): assert hero contrast AA + chart aspect ratio on fuel pages"
```

### Task 8c: Visual regression baselines for the 3 fixed page families

**Files:**
- Create: `tests/e2e/seo-visual-regression.spec.ts`
- Create: `tests/e2e/seo-visual-regression.spec.ts-snapshots/` (generated on first run)

**Why:** Pixel diff catches silent CSS regressions (colour tokens flipping, layouts breaking) that contrast/aspect assertions miss.

- [ ] **Step 1: Write spec with stable viewport + clipped shots**

```typescript
import { test, expect } from 'playwright/test';

const CASES = [
  { name: 'border-wait-root', url: '/traffico-dogane/' },
  { name: 'fuel-daily-ticino', url: '/prezzi-benzina-oggi/' },
  { name: 'weekly-employers-hub', url: '/aziende-che-assumono/' },
];

test.use({ viewport: { width: 1280, height: 800 } });

for (const c of CASES) {
  test(`visual baseline: ${c.name}`, async ({ page }) => {
    await page.goto(c.url, { waitUntil: 'networkidle' });
    // Freeze dynamic bits: scroll to top, wait for fonts
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.locator('main').first()).toHaveScreenshot(`${c.name}.png`, {
      maxDiffPixelRatio: 0.02,
      animations: 'disabled',
    });
  });
}
```

- [ ] **Step 2: Generate baselines**

```bash
npm run build
npx playwright test tests/e2e/seo-visual-regression.spec.ts --update-snapshots
```
Expected: 3 new PNGs under `tests/e2e/seo-visual-regression.spec.ts-snapshots/`.

- [ ] **Step 3: Verify re-run is green**

Run: `npx playwright test tests/e2e/seo-visual-regression.spec.ts`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/seo-visual-regression.spec.ts tests/e2e/seo-visual-regression.spec.ts-snapshots/
git commit -m "test(e2e): visual regression baselines for border-wait, fuel, weekly-employers"
```

### Task 9: Wire npm scripts + Playwright config

**Files:**
- Modify: `package.json` (scripts block)
- Modify: `playwright.config.ts`

- [ ] **Step 1: Add scripts**

```json
{
  "scripts": {
    "test:e2e": "playwright test",
    "test:e2e:smoke": "playwright test tests/e2e/seo-content-integrity.spec.ts tests/e2e/link-graph-integrity.spec.ts tests/e2e/seo-visual-ui.spec.ts",
    "test:e2e:visual": "playwright test tests/e2e/seo-visual-regression.spec.ts",
    "test:e2e:visual:update": "playwright test tests/e2e/seo-visual-regression.spec.ts --update-snapshots",
    "build:e2e": "npm run build && npm run test:e2e:smoke"
  }
}
```

- [ ] **Step 2: Update Playwright config — add reporter + projects**

```typescript
import { defineConfig, devices } from 'playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: 'http://localhost:4173',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx vite preview --port 4173',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
```

- [ ] **Step 3: Run**

```bash
npm run build
npm run test:e2e:smoke
```
Expected: all PASS, `playwright-report/` created.

- [ ] **Step 4: Commit**

```bash
git add package.json playwright.config.ts
git commit -m "chore(e2e): add test:e2e scripts, traces, HTML reporter"
```

### Task 10: GitHub Actions workflow for E2E on every PR and push to main

**Files:**
- Create: `.github/workflows/e2e.yml`

- [ ] **Step 1: Write workflow**

```yaml
name: E2E Tests
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
jobs:
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - name: Build
        run: npm run build:ci
        env:
          CI: 'true'
      - name: E2E smoke (content + link graph + visual UI)
        run: npm run test:e2e:smoke
      - name: E2E visual regression
        run: npm run test:e2e:visual
      - name: Upload Playwright report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 14
      - name: Upload visual diffs on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: visual-diffs
          path: test-results/
          retention-days: 14
```

- [ ] **Step 2: Validate YAML**

Run: `npx js-yaml .github/workflows/e2e.yml > /dev/null`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/e2e.yml
git commit -m "ci(e2e): run smoke E2E on PR + main push with trace uploads"
```

---

## Phase 5 — Verification

### Task 11: Full-suite run

- [ ] **Step 1: Type check**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 2: Full unit tests**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 3: Full build**

Run: `npx vite build`
Expected: exit 0; verify `dist/sitemap.xml` no longer contains `/chiasso/pemsa/` URL; verify `dist/aziende-che-assumono/bellinzona/swisscom/settimana-corrente/index.html` either exists OR its link is absent from sitemap.

- [ ] **Step 4: Full E2E**

Run: `npx playwright test`
Expected: all pass.

- [ ] **Step 5: Push (pre-push hook runs tests + build)**

```bash
git push
```
Expected: pass.

---

## Out of Scope (explicit)

- **TomTom data quality** — the "all zeros" is an upstream issue. Phase 1 only handles graceful rendering; a separate investigation of `scripts/update-border-wait.mjs` is a follow-up, not this plan.
- **Jobs-snapshots-history backfill** — degraded-mode behaviour stays; plan fixes the link-emission gap only. A seed script is listed under "Create" as optional but its implementation is deferred unless Task 6 reveals it's on the critical path.
- **Other SEO plugins** (health premiums, orphan landings, job market snapshot) — not covered by the reported screenshots; if the link-graph E2E surfaces issues in them, file a follow-up.
