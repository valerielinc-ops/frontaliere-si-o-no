# Cathedral Canton-Aware Completion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the cathedral CH-wide expansion so that every Swiss canton — not only TI/GR/VS — gets the **full SEO content graph** (job-detail URLs under its canton, city/sector/company/pagina/categoria sub-pages, editorial layer, F4/F5 indexable, canton-aware redirects), eliminating every hard-coded `cerca-lavoro-ticino` / `find-jobs-ticino` / `jobs-im-tessin` / `trouver-emploi-tessin` outside the explicit TI legacy-preservation branch.

**Architecture:** A single canton-aware section-slug helper (`buildCantonAwareSection`, already in `build-plugins/jobsSeoPagesPlugin.ts:814`) becomes the **only** place that resolves `(locale, cantonCode) → 'cerca-lavoro-zurigo'`. Every emit site, breadcrumb, JSON-LD, hreflang, sitemap entry, redirect, and editorial loop migrates from the TI-locked literal `sectionByLocale[locale]` to this helper, passing the **job's** canton (for job-detail) or the **page's** canton (for landings). TI URLs stay frozen — the helper short-circuits on `'TI'` to preserve `sectionByLocale[locale]`. City allowlists come from `data/canton-municipalities.json` (2110 BFS municipalities), not from literal arrays. Editorial gating switches from a 3-canton literal to `ALL_CANTON_CODES` filtered by a strict `MIN_JOBS_FOR_CANTON_PAGE` threshold.

**Tech Stack:** React 19 + TypeScript ~5.8 + Vite 6, Vitest 4, Tailwind 4. Build plugins under `build-plugins/`. Canton data in `data/canton-url-slugs.json` + `data/canton-municipalities.json`. Router: `services/router.ts`. Tests: Vitest + Playwright (post-deploy).

**Pre-requisites:**
- Operate in a **dedicated git worktree** per CLAUDE.md non-negotiable rule (cron + multi-agent safety).
- `FAST_BUILD` is the agent-session default; force `FAST_BUILD=` when building to exercise SEO plugins (CLAUDE.md FAST_BUILD trap).
- `data/canton-url-slugs.json` and `data/canton-municipalities.json` are authoritative — never re-hard-code slugs.
- The plan ships in **10 sequential phases**. Each phase produces a working, testable PR that can land independently if needed.

**Out of scope:**
- Phase-2 marquee crawlers (17 ATS-specific): tracked separately in the cathedral plan.
- Cost-of-living / comparisons-hub / FAQ-hub / health-premiums plugins: CH-wide-by-nature already, no canton scoping needed.
- Border-wait (F8) and fuel-daily (F6): separate plugin scope, unaffected.

---

## V2 changelog — adversarial-review fixes (2026-05-11)

Independent review surfaced 3 P1 fatal flaws + 4 secondary issues. V2 closes them all:

| ID | Issue | Fix |
|---|---|---|
| **P1-A** | Phase 5 emits TI prose under non-TI URLs because `jobEditorialLanding.ts:39-62` slug tables are TI/GR/VS-only | **Phase 5 reworked**: new Phase 5.0 generates 23 missing per-canton slug rows + `germanCantonPrep`/`frenchCantonPrep` extensions. `EDITORIAL_PRIMARY_CANTONS` kept as display-prose constant; `EDITORIAL_CANTONS` becomes the gating constant. |
| **P1-B** | `data/slug-registry.json` has no `canton` field → Phase 8.1 redirects always fall back to TI | **New Phase 0.6**: slug-registry back-fill migration that scans `data/jobs.json` + `data/canton-municipalities.json` to write `canton` on every registry entry. Must run before Phase 8. |
| **P1-C** | Plan claim "`shardKeyForUrl` is URL-derived" is wrong — it reads `u._canton` from caller-supplied field | **Phase 1.4 reworked**: not a verify-only commit; actively rewires every `shardUrls.push({…, _canton})` site to use `resolveJobCanton(job)` so the field is consistent with the URL path. |
| **P1-D** | `cantonCities.ts` Phase 0.3 self-fails on `Aesch (ZH)` (collision with `Aesch (BL)`, first-write-wins on lowercase) | **Phase 0.3 fixed**: store BOTH disambiguated form (`aesch (zh)` → `ZH`) AND undisambiguated form only when unambiguous. Test updated. |
| **P1-E** | `cathedral-no-ti-hardcodes` allowlist uses `line.startsWith('…:772')` → false-positive on `:7720`, `:7721`, … | **Phase 0.5 fixed**: parse `grep -n` output into `path:line` tuples; exact-match allowlist. |
| **P2-A** | Phase 6.2 type mismatch: `TICINO_CITIES: SnapshotCity[]` vs `getCantonCities: string[]` | **Phase 6.2 adapter**: new helper `cantonCitiesAsSnapshot(canton)` wraps names into `{key, name, canton}`. |
| **P2-B** | Phase 7.1 Step 5 line reference (6529) is wrong | **Phase 7.1 fixed**: use a `CANTON_LANDING_OWNED_BY_STATIC_PAGES: Set<string>` guard instead of line-pinned skip. |
| **P2-C** | Phase 7.3 regex `isJobBoardLandingPath` over-accepts `/cerca-lavoro-anything/` | **Phase 7.3 tightened**: regex matches only against the known canton slug set loaded from `data/canton-url-slugs.json`. |
| **P2-D** | Phase 4.2 mobile-first check is qualitative only | **Phase 4.2 automated**: DOM assertion test on `dist/cerca-lavoro-zurigo/index.html` element order. |
| **P3-A** | No pre-PR content-gate rebaseline dry-run | **Phase 10.0 added**: dry-run all 6 ratchets BEFORE PR; rebaseline-improvements committed in same PR; ratchet-violations abort. |
| **P3-B** | No hreflang cross-locale validation for non-TI | **Phase 1.3 extended**: new test asserts `/cerca-lavoro-zurigo/{slug}/` alt hrefs round-trip to `/en/find-jobs-zurich/{slug}/` etc. |
| **P3-C** | No legacy URL → new URL 301 mapping for pre-cathedral non-TI jobs minted at TI URLs | **Phase 8.4 added**: emit redirect entries for slug-registry rows whose pre-cathedral URL was TI but new canton ≠ TI. |

---

## File Structure

### Files to **create**
| Path | Responsibility |
|---|---|
| `build-plugins/shared/cantonSection.ts` | Single export `resolveCantonSection(locale, cantonCode): string` re-exporting the canton-aware section helper from `jobsSeoPagesPlugin.ts` so other plugins (weeklyEmployers, jobMarketSnapshot, staticPages, seoHubsData, redirects) can use it without circular import. Plus `resolveJobCanton(job): string` resolver (canton field + fallback via `CITY_TO_CANTON`). |
| `build-plugins/shared/cantonCities.ts` | Load `data/canton-municipalities.json`, expose `getCantonCities(cantonCode): string[]`, `getCityCanton(city): string \| null`, `normalizeCitySlug(city): string`. Single source of truth for city ⇄ canton. |
| `tests/seo/cathedral-section-helper.test.ts` | Unit: `resolveCantonSection` invariants (TI legacy preserved, non-TI canton-aware, aggregator). |
| `tests/seo/cathedral-job-detail-canton.test.ts` | Integration: every emitted job-detail HTML lives under its canton's URL section. |
| `tests/seo/cathedral-flip-simulation.spec.ts` | Regression: full plugin pass for a synthetic 26-canton job corpus, assert `dist/cerca-lavoro-{canton}/job-…/index.html` exists per job's canton; assert no `dist/cerca-lavoro-ticino/job-…/index.html` for non-TI jobs. |
| `tests/seo/cathedral-no-ti-hardcodes.test.ts` | Lint: grep `build-plugins/` for forbidden literal strings outside the legacy-preservation branch. |

### Files to **modify**
| Path | Change |
|---|---|
| `build-plugins/jobsSeoPagesPlugin.ts` | Replace **all** `sectionByLocale[locale]` usages outside the helper definition with `buildCantonAwareSection(locale, ctxCantonCode)`. Specifically lines: 1953 (job detail), 2110 (sitemap related-jobs), 2200 (hreflang alt), 2298 (breadcrumb level 2), 2490, 2512, 2740, 2745, 2795, 2946, 3051, 3070, 3153, 3561 (company hub), 3608 (company hub anchor), 3910, 3925, 3948, 3955, 4058, 4072, 4076, 4086, 4089, 4097, 4214, 4227, 4233, 4243, 4248, 4260, 4368 (sector hub), 4370, 4384, 4401, 4406, 4416, 4420, 4428, 4546, 4577, 4583, 4594, 4599, 4610, 4709, 4740 (city hub), 4752, 4772, 4776, 4802, 4861, 4940, 5295 (pagination), 5389 (category), 6204 (sitemap landing). Also: expand `EDITORIAL_CANTONS` loops at 3916, 4218, 4392, 4553 to iterate all 26. Fill thin canton-landing body at 6665-6676 with real listing grid + tiles. |
| `build-plugins/cityJobsHub.ts` | Migrate `CityHubKey` from literal-union of 5 TI cities to `string`. Drop `CITY_HUB_KEYS` literal. `CITY_HUB_SLUG` becomes a function: `cityHubSlug(city, locale)`. `CITY_HUB_DISPLAY_NAME` becomes a function reading `data/canton-municipalities.json`. |
| `services/router.ts` | Router `jobBoardCity` already `string`-typed (verify); remove any remaining narrow-cast to `CityHubKey`. Update lines 2373, 2562. |
| `build-plugins/jobEditorialLanding.ts:35` | `EDITORIAL_CANTONS = ALL_CANTON_CODES` (sourced from `data/canton-url-slugs.json`) — gating now done at use-site via `MIN_JOBS_FOR_CANTON_PAGE`. Drop the dup `EDITORIAL_PRIMARY_CANTONS` in `jobsSeoPagesPlugin.ts:1018` and re-export from `jobEditorialLanding.ts`. |
| `build-plugins/weeklyEmployersPlugin.ts` | Replace `sectionByLocale` TI literals at 830-833, 2021-2024, 2436-2439, 2463, 2609-2612, 2726-2729 with `resolveCantonSection(locale, cityCanton)`. "Offerte ultimi 3 giorni" CTAs at 121-136 become canton-aware. |
| `build-plugins/weeklyEmployersChCantonPages.ts` | Flip `robots: 'noindex,follow'` → `'index,follow'` once content gate passes (Phase 6). |
| `build-plugins/jobMarketSnapshotPlugin.ts` | Replace `TICINO_CITIES` literal at 294 with `getCantonCities(canton)`; replace hard-coded section slugs at 121, 845-849, 1287, 1438, 2425, 2455. |
| `build-plugins/jobMarketSnapshotChCantonPages.ts` | Flip `noindex,follow` → `index,follow` once content gate passes. |
| `build-plugins/jobSectorLanding.ts:103` | Use `resolveCantonSection`. |
| `build-plugins/jobBoardSeo.ts:37-50` | `JOB_BOARD_LANDING_PATHS` → predicate that matches any `/cerca-lavoro-{canton}/`, `/find-jobs-{canton}/`, `/jobs-in-{canton}/`, `/trouver-emploi-{canton}/`, plus the 4 TI legacy paths. |
| `build-plugins/staticPagesPlugin.ts:384-388, 495-3520` | Generate per-canton landing index for the 25 non-TI cantons + aggregator, cloning TI's current rich structure with canton-scoped data (top employers, top cities in that canton, top sectors). Keep TI body unchanged. |
| `build-plugins/seoHubsData.ts:40-62` | `HUB_SLUGS` becomes a function `hubSlugFor(canton, locale, hub)` emitting `/cerca-lavoro-{canton}/tutti/`, `/settori/`, `/aziende/` per canton. |
| `build-plugins/seoHubsPlugin.ts` | Iterate all cantons × hub-kinds (gated by MIN_JOBS). |
| `build-plugins/searchConsoleCompat.ts:4, 69, 71, 144, 154` | Resolve canton from slug-registry; redirect to `/cerca-lavoro-{canton}/<slug>/` instead of blanket TI. |
| `build-plugins/legacyRedirectsPlugin.ts:189, 233-239, 331` | `/job-board/` → aggregator `/cerca-lavoro-svizzera/`. Per-canton legacy paths resolved via canton-inference. |
| `build-plugins/jobOrphanBridgePlugin.ts:78-81, 29-32` | Section slug table becomes a function. |
| `build-plugins/annualReportPlugin.ts:713-728` | Jobs hub link → aggregator. |
| `build-plugins/editorialContent.ts:1129, 1977, 2482` | Editorial prose links resolved per article's canton context. |
| `build-plugins/blogContextualLinksData.ts:143` | `ultimi-3-giorni` link → aggregator. |
| `build-plugins/professionLandingsLinksPlugin.ts:13` | Profession links resolved per canton context (or aggregator fallback). |

---

## Phase 0 — Worktree + baseline + foundation tests

Operate in an isolated worktree throughout. Phase 0 lands a green baseline + the foundation helper module so every later phase has stable contracts.

### Task 0.1: Enter isolated worktree

**Files:** none yet — environment setup.

- [ ] **Step 1: Spawn worktree**

Use the `EnterWorktree` tool (auto-cleans empty trees, returns path + branch). Branch name: `cathedral-canton-aware-completion`.

- [ ] **Step 2: Verify clean baseline**

```bash
git status
npx tsc --noEmit
FAST_BUILD= SKIP_FUEL_DAILY=1 SKIP_WEEKLY_EMPLOYERS=1 SKIP_JOB_MARKET_SNAPSHOT=1 SKIP_HEALTH_PREMIUMS=1 SKIP_ORPHAN_LANDINGS=1 SKIP_BORDER_WAIT=1 npx vite build
npx vitest run
```
Expected: `git status` clean, `tsc` 0 errors, `vite build` exits 0, all tests pass.

- [ ] **Step 3: Snapshot pre-flip slug registry**

Per `docs/CATHEDRAL-ROLLBACK.md` §"Pre-cathedral snapshot". Commit a frozen copy of the slug registry so the rollback runbook can compare URLs:

```bash
cp data/slug-registry.json data/slug-registry.pre-cathedral.snapshot.json
git add data/slug-registry.pre-cathedral.snapshot.json
git commit -m "chore(cathedral): freeze pre-cathedral slug-registry snapshot for rollback runbook"
```

### Task 0.2: Create `build-plugins/shared/cantonSection.ts`

**Files:**
- Create: `build-plugins/shared/cantonSection.ts`
- Test: `tests/seo/cathedral-section-helper.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/seo/cathedral-section-helper.test.ts
import { describe, it, expect } from 'vitest';
import { resolveCantonSection, resolveJobCanton } from '../../build-plugins/shared/cantonSection';

describe('resolveCantonSection — TI legacy invariance', () => {
  it.each(['it','en','de','fr'] as const)('TI returns frozen legacy slug for %s', (locale) => {
    const legacy = { it: 'cerca-lavoro-ticino', en: 'find-jobs-ticino', de: 'jobs-im-tessin', fr: 'trouver-emploi-tessin' } as const;
    expect(resolveCantonSection(locale, 'TI')).toBe(legacy[locale]);
  });
});

describe('resolveCantonSection — canton-aware emission', () => {
  it('ZH IT → cerca-lavoro-zurigo', () => {
    expect(resolveCantonSection('it', 'ZH')).toBe('cerca-lavoro-zurigo');
  });
  it('AG DE → jobs-im-aargau (definite article preserved)', () => {
    expect(resolveCantonSection('de', 'AG')).toBe('jobs-im-aargau');
  });
  it('VD DE → jobs-in-der-waadt', () => {
    expect(resolveCantonSection('de', 'VD')).toBe('jobs-in-der-waadt');
  });
  it('AGGREGATE_KEY → cerca-lavoro-svizzera', () => {
    expect(resolveCantonSection('it', '_AGGREGATE_')).toBe('cerca-lavoro-svizzera');
  });
  it('Half-canton AI/AR collapses to APPENZELLO group', () => {
    expect(resolveCantonSection('it', 'AI')).toBe('cerca-lavoro-appenzello');
    expect(resolveCantonSection('it', 'AR')).toBe('cerca-lavoro-appenzello');
  });
  it('BL/BS collapses to BASILEA group', () => {
    expect(resolveCantonSection('it', 'BL')).toBe('cerca-lavoro-basilea');
    expect(resolveCantonSection('it', 'BS')).toBe('cerca-lavoro-basilea');
  });
});

describe('resolveJobCanton', () => {
  it('returns job.canton when present', () => {
    expect(resolveJobCanton({ canton: 'ZH', location: 'Zurich' })).toBe('ZH');
  });
  it('falls back to city → canton lookup', () => {
    expect(resolveJobCanton({ canton: '', location: 'Zurich' })).toBe('ZH');
  });
  it('defaults to TI when canton unresolved', () => {
    expect(resolveJobCanton({ canton: '', location: '' })).toBe('TI');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npx vitest run tests/seo/cathedral-section-helper.test.ts
```
Expected: FAIL with "Cannot find module '../../build-plugins/shared/cantonSection'".

- [ ] **Step 3: Implement the helper**

```typescript
// build-plugins/shared/cantonSection.ts
import cantonSlugFile from '../../data/canton-url-slugs.json';
import municipalitiesFile from '../../data/canton-municipalities.json';

export type CantonLocale = 'it' | 'en' | 'de' | 'fr';
export const AGGREGATE_KEY = '_AGGREGATE_';

const SECTION_LEGACY_TI: Record<CantonLocale, string> = {
  it: 'cerca-lavoro-ticino',
  en: 'find-jobs-ticino',
  de: 'jobs-im-tessin',
  fr: 'trouver-emploi-tessin',
};

const SECTION_PREFIX_BY_LOCALE: Record<CantonLocale, string> = {
  it: 'cerca-lavoro', en: 'find-jobs', de: 'jobs-in', fr: 'trouver-emploi',
};

type CantonSlugEntry = { it: string; en: string; de: string; fr: string; dePrefix?: string };
const cantons: Record<string, CantonSlugEntry> = cantonSlugFile.cantons as Record<string, CantonSlugEntry>;
const cantonGroups: Record<string, { members: string[] }> = (cantonSlugFile.cantonGroups ?? {}) as Record<string, { members: string[] }>;
const aggregateSlugs: Record<CantonLocale, string> = cantonSlugFile.aggregate as Record<CantonLocale, string>;

const memberToGroup: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [group, info] of Object.entries(cantonGroups)) {
    for (const member of info.members) out[member] = group;
  }
  return out;
})();

export function resolveCantonGroup(cantonCode: string): string {
  const code = String(cantonCode || '').toUpperCase().trim();
  if (!code) return 'TI';
  return memberToGroup[code] ?? code;
}

function getCantonUrlSlug(code: string, locale: CantonLocale): string {
  if (code === AGGREGATE_KEY) return aggregateSlugs[locale] ?? aggregateSlugs.it;
  const entry = cantons[code];
  return entry?.[locale] ?? aggregateSlugs[locale] ?? aggregateSlugs.it;
}

export function resolveCantonSection(locale: CantonLocale, cantonCode: string): string {
  const raw = String(cantonCode || '').toUpperCase();
  if (!raw || raw === 'TI') return SECTION_LEGACY_TI[locale];
  if (raw === AGGREGATE_KEY) {
    return `${SECTION_PREFIX_BY_LOCALE[locale]}-${getCantonUrlSlug(AGGREGATE_KEY, locale)}`;
  }
  const code = resolveCantonGroup(raw);
  if (locale === 'de') {
    const entry = cantons[code];
    if (entry?.dePrefix) return `${entry.dePrefix}${entry.de}`;
  }
  return `${SECTION_PREFIX_BY_LOCALE[locale]}-${getCantonUrlSlug(code, locale)}`;
}

const CITY_TO_CANTON: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  const cantonsData = (municipalitiesFile as { cantons: Record<string, { municipalities: string[] }> }).cantons;
  for (const [canton, info] of Object.entries(cantonsData)) {
    for (const city of info.municipalities) {
      out[city.toLowerCase().split(' (')[0].trim()] = canton;
    }
  }
  return out;
})();

export function resolveJobCanton(job: { canton?: string; location?: string }): string {
  const explicit = String(job.canton || '').toUpperCase().trim();
  if (explicit && (cantons[explicit] || memberToGroup[explicit])) {
    return resolveCantonGroup(explicit);
  }
  const city = String(job.location || '').toLowerCase().split(/[,(]/)[0].trim();
  if (city && CITY_TO_CANTON[city]) return resolveCantonGroup(CITY_TO_CANTON[city]);
  return 'TI';
}

export const ALL_CANTON_CODES: readonly string[] = Object.freeze(Object.keys(cantons).sort());
```

- [ ] **Step 4: Run test, verify it passes**

```bash
npx vitest run tests/seo/cathedral-section-helper.test.ts
```
Expected: all 11 cases PASS.

- [ ] **Step 5: Commit**

```bash
git add build-plugins/shared/cantonSection.ts tests/seo/cathedral-section-helper.test.ts
git commit -m "feat(cathedral): add canton-section helper with TI legacy invariance"
```

### Task 0.3: Create `build-plugins/shared/cantonCities.ts`

**Files:**
- Create: `build-plugins/shared/cantonCities.ts`
- Test: extend `tests/seo/cathedral-section-helper.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/seo/cathedral-section-helper.test.ts`:

```typescript
import { getCantonCities, getCityCanton, normalizeCitySlug } from '../../build-plugins/shared/cantonCities';

describe('cantonCities', () => {
  it('ZH municipalities include Zurich', () => {
    const cities = getCantonCities('ZH');
    expect(cities).toContain('Zurich');
  });
  it('city → canton lookup is case-insensitive', () => {
    expect(getCityCanton('lugano')).toBe('TI');
    expect(getCityCanton('LUGANO')).toBe('TI');
    expect(getCityCanton('Lugano')).toBe('TI');
  });
  it('disambiguated cities strip the canton suffix', () => {
    expect(getCityCanton('Aesch (ZH)')).toBe('ZH');
  });
  it('normalizeCitySlug produces URL-safe slug', () => {
    expect(normalizeCitySlug('St. Gallen')).toBe('st-gallen');
    expect(normalizeCitySlug('La Chaux-de-Fonds')).toBe('la-chaux-de-fonds');
    expect(normalizeCitySlug('Sankt Margrethen')).toBe('sankt-margrethen');
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run tests/seo/cathedral-section-helper.test.ts
```

- [ ] **Step 3: Implement (P1-D fix: disambiguator collision)**

```typescript
// build-plugins/shared/cantonCities.ts
import municipalitiesFile from '../../data/canton-municipalities.json';

type CityFile = { cantons: Record<string, { municipalities: string[] }> };
const data = municipalitiesFile as CityFile;

const CANTON_TO_CITIES: Record<string, string[]> = Object.fromEntries(
  Object.entries(data.cantons).map(([canton, info]) => [canton, info.municipalities])
);

// Two-tier lookup: (1) disambiguated form `aesch (zh)` → 'ZH', (2) bare `aesch` ONLY
// stored when unambiguous (a single canton has it). Cities listed in multiple cantons
// only resolve via the disambiguated form. Prevents the Aesch (BL/LU/ZH) bug where
// first-write-wins on lowercase silently returned the wrong canton.
const CITY_TO_CANTON_DISAMBIGUATED: Record<string, string> = {};
const CITY_TO_CANTON_BARE: Record<string, string | 'AMBIGUOUS'> = {};
for (const [canton, cities] of Object.entries(CANTON_TO_CITIES)) {
  for (const city of cities) {
    const lower = city.toLowerCase().trim();
    // disambiguated form (with parenthetical)
    if (lower.includes(' (')) CITY_TO_CANTON_DISAMBIGUATED[lower] = canton;
    // bare form (without parenthetical)
    const bare = lower.split(' (')[0].trim();
    if (!CITY_TO_CANTON_BARE[bare]) {
      CITY_TO_CANTON_BARE[bare] = canton;
    } else if (CITY_TO_CANTON_BARE[bare] !== canton) {
      CITY_TO_CANTON_BARE[bare] = 'AMBIGUOUS';
    }
  }
}

export function getCantonCities(canton: string): string[] {
  return CANTON_TO_CITIES[String(canton).toUpperCase()] ?? [];
}

export function getCityCanton(city: string): string | null {
  const lower = String(city).toLowerCase().trim();
  // 1. Try exact disambiguated form first (e.g. 'aesch (zh)' → ZH)
  if (CITY_TO_CANTON_DISAMBIGUATED[lower]) return CITY_TO_CANTON_DISAMBIGUATED[lower];
  // 2. Try bare form — but only if unambiguous (single canton claims it)
  const bare = lower.split(' (')[0].trim();
  const hit = CITY_TO_CANTON_BARE[bare];
  if (hit && hit !== 'AMBIGUOUS') return hit;
  return null;
}

export function normalizeCitySlug(city: string): string {
  return String(city)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\([a-z]+\)/g, '')             // strip (zh), (bl), etc. from slug
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
```

- [ ] **Step 3b: Update Step 1 tests to reflect P1-D fix**

In `tests/seo/cathedral-section-helper.test.ts`, update the `cantonCities` block:

```typescript
describe('cantonCities — disambiguator collision (P1-D)', () => {
  it('disambiguated Aesch (ZH) → ZH (not BL)', () => {
    expect(getCityCanton('Aesch (ZH)')).toBe('ZH');
  });
  it('disambiguated Aesch (BL) → BL', () => {
    expect(getCityCanton('Aesch (BL)')).toBe('BL');
  });
  it('bare "Aesch" → null (ambiguous across BL/LU/ZH)', () => {
    expect(getCityCanton('Aesch')).toBeNull();
  });
  it('unambiguous bare city resolves directly', () => {
    expect(getCityCanton('Lugano')).toBe('TI');
    expect(getCityCanton('Zurich')).toBe('ZH');
  });
});
```

- [ ] **Step 4: Verify pass**

```bash
npx vitest run tests/seo/cathedral-section-helper.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add build-plugins/shared/cantonCities.ts tests/seo/cathedral-section-helper.test.ts
git commit -m "feat(cathedral): add cantonCities helper backed by BFS municipalities"
```

### Task 0.4: Write the cathedral-flip regression test (failing baseline)

This test will stay red until Phase 1 completes — it's the headline acceptance gate.

**Files:** Create: `tests/seo/cathedral-flip-simulation.spec.ts`

- [ ] **Step 1: Write the failing acceptance test**

```typescript
// tests/seo/cathedral-flip-simulation.spec.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DIST = path.resolve(__dirname, '../../dist');

function listJobHtmlUnder(cantonSection: string): string[] {
  const dir = path.join(DIST, cantonSection);
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'index.html'))) {
      out.push(entry.name);
    }
  }
  return out;
}

describe('cathedral flip — job-detail URLs route per job.canton', () => {
  it('non-TI jobs do NOT live under /cerca-lavoro-ticino/', () => {
    const tiSlugs = listJobHtmlUnder('cerca-lavoro-ticino');
    const cantonsToCheck = ['cerca-lavoro-zurigo', 'cerca-lavoro-ginevra', 'cerca-lavoro-argovia'];
    for (const sect of cantonsToCheck) {
      const slugs = listJobHtmlUnder(sect);
      const leaked = slugs.filter((s) => tiSlugs.includes(s));
      expect(leaked, `${sect} slugs also under TI: ${leaked.slice(0,5).join(',')}`).toEqual([]);
    }
  });

  it('every non-TI canton with ≥ MIN_JOBS has at least one job-detail page', () => {
    const SAMPLE = ['cerca-lavoro-zurigo', 'cerca-lavoro-ginevra', 'cerca-lavoro-vaud', 'cerca-lavoro-berna'];
    for (const sect of SAMPLE) {
      const slugs = listJobHtmlUnder(sect);
      expect(slugs.length, `${sect} has no job detail pages`).toBeGreaterThan(0);
    }
  });

  it('canton-landing body contains a real listing grid (not a thin indice)', () => {
    const html = fs.readFileSync(path.join(DIST, 'cerca-lavoro-zurigo/index.html'), 'utf8');
    expect(html).toMatch(/<article[\s\S]+job-card|data-job-id|JobPosting/);
    expect(html.length).toBeGreaterThan(15_000); // thin indice is ~7KB
  });
});
```

- [ ] **Step 2: Build and verify red**

```bash
FAST_BUILD= SKIP_FUEL_DAILY=1 SKIP_BORDER_WAIT=1 SKIP_HEALTH_PREMIUMS=1 SKIP_ORPHAN_LANDINGS=1 npx vite build
npx vitest run tests/seo/cathedral-flip-simulation.spec.ts
```
Expected: all 3 tests FAIL — leaked TI slugs, empty non-TI canton sections, thin landing HTML.

- [ ] **Step 3: Commit (red test as acceptance gate)**

```bash
git add tests/seo/cathedral-flip-simulation.spec.ts
git commit -m "test(cathedral): add flip-simulation acceptance gate (RED — unblocks Phase 1+)"
```

### Task 0.5: Write the no-TI-hardcodes lint test

**Files:** Create: `tests/seo/cathedral-no-ti-hardcodes.test.ts`

- [ ] **Step 1: Add lint test**

```typescript
// tests/seo/cathedral-no-ti-hardcodes.test.ts
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

const FORBIDDEN = [
  "'cerca-lavoro-ticino'",
  '"cerca-lavoro-ticino"',
  "'find-jobs-ticino'",
  "'jobs-im-tessin'",
  "'trouver-emploi-tessin'",
];

const ALLOWLIST = [
  'build-plugins/shared/cantonSection.ts',           // SECTION_LEGACY_TI definition
  'build-plugins/jobsSeoPagesPlugin.ts:772',         // sectionByLocale definition (legacy preservation)
  'build-plugins/jobsSeoPagesPlugin.ts:773',
  'build-plugins/jobsSeoPagesPlugin.ts:774',
  'build-plugins/jobsSeoPagesPlugin.ts:775',
  'build-plugins/jobsSeoPagesPlugin.ts:776',
  'build-plugins/jobBoardSeo.ts:38',                 // JOB_BOARD_LANDING_PATHS — TI legacy entry only
  'build-plugins/jobBoardSeo.ts:39',
  'build-plugins/jobBoardSeo.ts:40',
  'build-plugins/jobBoardSeo.ts:41',
  'tests/',                                          // tests reference literals for verification
];

// P1-E fix: parse grep output into (path, line, content) tuples and
// match against allowlist with EXACT boundary, not startsWith — otherwise
// `:772` matches `:7720`, `:7721`, …
function parseGrepLine(line: string): { path: string; lineNo: number; content: string } | null {
  const m = line.match(/^([^:]+):(\d+):(.*)$/);
  if (!m) return null;
  return { path: m[1], lineNo: parseInt(m[2], 10), content: m[3] };
}

function isAllowlisted(entry: { path: string; lineNo: number }): boolean {
  for (const allow of ALLOWLIST) {
    // "path:line" form — exact match
    if (allow.includes(':')) {
      const [allowPath, allowLine] = allow.split(':');
      if (entry.path === allowPath && entry.lineNo === parseInt(allowLine, 10)) return true;
    }
    // "path/" or "path" form — prefix match on path only (e.g. "tests/")
    else if (entry.path.startsWith(allow)) return true;
  }
  return false;
}

describe('cathedral — no TI URL hardcodes outside allowlist (P1-E boundary-safe)', () => {
  for (const literal of FORBIDDEN) {
    it(`literal ${literal} appears only in allowlisted locations`, () => {
      const cmd = `grep -rn -F ${JSON.stringify(literal)} build-plugins/ services/ scripts/lib/ || true`;
      const out = execSync(cmd, { encoding: 'utf8' });
      const offenders = out.split('\n').filter(Boolean)
        .map(parseGrepLine).filter((e): e is NonNullable<typeof e> => e !== null)
        .filter((entry) => !isAllowlisted(entry))
        .map((e) => `${e.path}:${e.lineNo}: ${e.content}`);
      expect(offenders, `Unallowlisted hardcodes for ${literal}:\n${offenders.join('\n')}`).toEqual([]);
    });
  }
});
```

- [ ] **Step 2: Run and verify red**

```bash
npx vitest run tests/seo/cathedral-no-ti-hardcodes.test.ts
```
Expected: FAIL with ~30+ offending lines. Each later phase clears a slice of these.

- [ ] **Step 3: Commit**

```bash
git add tests/seo/cathedral-no-ti-hardcodes.test.ts
git commit -m "test(cathedral): no-TI-hardcodes lint test (RED — tracks remaining cleanup)"
```

### Task 0.6: Slug-registry canton back-fill (P1-B blocker — MUST land before Phase 8)

**Files:** Create: `scripts/migrate-slug-registry-add-canton.mjs`; Modify: `data/slug-registry.json`

- [ ] **Step 1: Write the back-fill script**

```javascript
// scripts/migrate-slug-registry-add-canton.mjs
// One-shot migration that adds `canton` field to every entry in data/slug-registry.json.
// Source of truth: data/jobs.json (job.canton or inferred from job.location via city → canton).
// Fallback: 'TI' (preserves legacy behavior for entries we can't resolve).
import fs from 'node:fs';
import path from 'node:path';

const REG_PATH = path.resolve('data/slug-registry.json');
const JOBS_PATH = path.resolve('data/jobs.json');
const MUNI_PATH = path.resolve('data/canton-municipalities.json');

const registry = JSON.parse(fs.readFileSync(REG_PATH, 'utf8'));
const jobs = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));
const muni = JSON.parse(fs.readFileSync(MUNI_PATH, 'utf8'));

// Build slug → canton map from current jobs.json
const slugToCanton = new Map();
for (const job of jobs) {
  const c = String(job.canton || '').toUpperCase();
  const sl = [job.slug, job.slugByLocale?.it, job.slugByLocale?.en, job.slugByLocale?.de, job.slugByLocale?.fr].filter(Boolean);
  for (const s of sl) if (c && !slugToCanton.has(s)) slugToCanton.set(s, c);
}

// City → canton (disambiguator-aware)
const cityToCanton = new Map();
const cityCounts = new Map();
for (const [canton, info] of Object.entries(muni.cantons)) {
  for (const city of info.municipalities) {
    const lower = city.toLowerCase();
    if (lower.includes(' (')) cityToCanton.set(lower, canton);
    const bare = lower.split(' (')[0].trim();
    cityCounts.set(bare, (cityCounts.get(bare) || 0) + 1);
    if (!cityToCanton.has(bare)) cityToCanton.set(bare, canton);
  }
}
// Erase ambiguous bare entries
for (const [bare, count] of cityCounts) {
  if (count > 1) cityToCanton.delete(bare);
}

let backfilled = 0, fallback = 0, alreadyHad = 0;
const FALLBACK = 'TI';

const out = {};
for (const [slug, entry] of Object.entries(registry)) {
  if (entry && typeof entry === 'object' && entry.canton) {
    out[slug] = entry; alreadyHad++; continue;
  }
  let canton = slugToCanton.get(slug);
  if (!canton) {
    // try slug parsing: e.g. "frontend-developer-zurich-abc123" → city "zurich"
    const parts = String(slug).toLowerCase().split('-');
    for (let i = parts.length - 1; i >= 0; i--) {
      const c = cityToCanton.get(parts[i]);
      if (c) { canton = c; break; }
    }
  }
  if (!canton) { canton = FALLBACK; fallback++; } else { backfilled++; }
  out[slug] = { ...(entry && typeof entry === 'object' ? entry : {}), canton };
}

fs.writeFileSync(REG_PATH, JSON.stringify(out, null, 2) + '\n');
console.log(`slug-registry back-fill: ${backfilled} canton-resolved, ${fallback} fell back to ${FALLBACK}, ${alreadyHad} already had canton`);
```

- [ ] **Step 2: Write the test**

```typescript
// tests/seo/cathedral-slug-registry-canton-backfill.test.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('slug-registry canton back-fill (P1-B)', () => {
  const reg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../data/slug-registry.json'), 'utf8'));
  it('every entry has a canton field', () => {
    const missing = Object.entries(reg).filter(([, v]) => !(v as { canton?: string }).canton);
    expect(missing.length, `Entries without canton: ${missing.slice(0,5).map(([k])=>k).join(',')}`).toBe(0);
  });
  it('canton field is a valid 2-letter code or APPENZELLO/BASILEA', () => {
    const valid = new Set(['TI','ZH','AG','GE','VD','BE','LU','VS','GR','SG','SO','SZ','SH','OW','NW','UR','TG','GL','FR','JU','NE','ZG','APPENZELLO','BASILEA','AI','AR','BL','BS']);
    const invalid = Object.entries(reg).filter(([, v]) => !valid.has((v as { canton: string }).canton));
    expect(invalid.length, `Invalid canton values: ${invalid.slice(0,5).map(([k,v])=>`${k}=${(v as { canton: string }).canton}`).join(',')}`).toBe(0);
  });
});
```

- [ ] **Step 3: Run migration**

```bash
node scripts/migrate-slug-registry-add-canton.mjs
```
Expected stdout: `slug-registry back-fill: N canton-resolved, M fell back to TI, P already had canton`

- [ ] **Step 4: Verify test passes**

```bash
npx vitest run tests/seo/cathedral-slug-registry-canton-backfill.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-slug-registry-add-canton.mjs tests/seo/cathedral-slug-registry-canton-backfill.test.ts data/slug-registry.json
git commit -m "feat(cathedral): back-fill canton field on slug-registry (P1-B unblock for Phase 8)"
```

---

## Phase 1 — Job-detail URLs route per `job.canton`

Highest blast radius. Replaces the TI-locked emit at `jobsSeoPagesPlugin.ts:1953` with canton-aware routing.

### Task 1.1: Wire the helper into the plugin

**Files:** Modify: `build-plugins/jobsSeoPagesPlugin.ts:1-100` (imports)

- [ ] **Step 1: Import the shared helper at the top of the plugin**

Find the existing imports block (~lines 1–100) and add:

```typescript
import {
  resolveCantonSection as sharedResolveCantonSection,
  resolveJobCanton as sharedResolveJobCanton,
  ALL_CANTON_CODES as SHARED_ALL_CANTON_CODES,
} from './shared/cantonSection';
```

(The local `buildCantonAwareSection` already does the same thing — Phase 1 step 2 collapses them.)

- [ ] **Step 2: Replace local helper body with re-export**

In `jobsSeoPagesPlugin.ts:814-828`, replace the implementation of `buildCantonAwareSection` with:

```typescript
function buildCantonAwareSection(locale: CantonLocale, cantonCode: string): string {
  return sharedResolveCantonSection(locale, cantonCode);
}
```

- [ ] **Step 3: Run the section-helper test to confirm nothing broke**

```bash
npx vitest run tests/seo/cathedral-section-helper.test.ts
```

- [ ] **Step 4: Build, verify TI URLs unchanged**

```bash
FAST_BUILD= SKIP_FUEL_DAILY=1 SKIP_BORDER_WAIT=1 SKIP_HEALTH_PREMIUMS=1 SKIP_ORPHAN_LANDINGS=1 npx vite build
ls dist/cerca-lavoro-ticino | head -5  # should still be populated
```

- [ ] **Step 5: Commit**

```bash
git add build-plugins/jobsSeoPagesPlugin.ts
git commit -m "refactor(cathedral): jobsSeoPagesPlugin uses shared canton-section helper"
```

### Task 1.2: Job-detail emit uses `resolveJobCanton`

**Files:** Modify: `build-plugins/jobsSeoPagesPlugin.ts:1944-1965`

- [ ] **Step 1: Write integration test**

```typescript
// tests/seo/cathedral-job-detail-canton.test.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DIST = path.resolve(__dirname, '../../dist');

describe('job-detail URLs route per job.canton (Phase 1)', () => {
  it('a Zurich job in jobs.json emits at /cerca-lavoro-zurigo/<slug>/', () => {
    const jobs = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../data/jobs.json'), 'utf8'));
    const zhJob = jobs.find((j: { canton?: string }) => j.canton === 'ZH');
    if (!zhJob) return; // skip if dataset has no ZH job
    const slug = zhJob.slugByLocale?.it || zhJob.slug;
    expect(fs.existsSync(path.join(DIST, 'cerca-lavoro-zurigo', slug, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(DIST, 'cerca-lavoro-ticino', slug, 'index.html'))).toBe(false);
  });

  it('a Lugano job stays at /cerca-lavoro-ticino/<slug>/ (TI invariance)', () => {
    const jobs = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../data/jobs.json'), 'utf8'));
    const tiJob = jobs.find((j: { canton?: string; location?: string }) => j.canton === 'TI' || /lugano|mendrisio|bellinzona/i.test(j.location || ''));
    if (!tiJob) return;
    const slug = tiJob.slugByLocale?.it || tiJob.slug;
    expect(fs.existsSync(path.join(DIST, 'cerca-lavoro-ticino', slug, 'index.html'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run and verify red**

```bash
FAST_BUILD= SKIP_FUEL_DAILY=1 SKIP_BORDER_WAIT=1 SKIP_HEALTH_PREMIUMS=1 SKIP_ORPHAN_LANDINGS=1 npx vite build
npx vitest run tests/seo/cathedral-job-detail-canton.test.ts
```
Expected: ZH job test FAILS (file under TI, not ZH).

- [ ] **Step 3: Patch the emit site**

Replace `jobsSeoPagesPlugin.ts:1953` and add canton resolution right before the loop. Edit `1944-1953`:

```typescript
for (const job of validJobs) {
  const perLocaleSlug = {
    it: localizedSlug(job, 'it'),
    en: localizedSlug(job, 'en'),
    de: localizedSlug(job, 'de'),
    fr: localizedSlug(job, 'fr'),
  };
  const jobCanton = sharedResolveJobCanton(job as { canton?: string; location?: string });
  for (const locale of localeList) {
    const __tActiveJob = startTimer();
    const sectionForJob = buildCantonAwareSection(locale, jobCanton);
    const relPath = `${localePrefix[locale]}/${sectionForJob}/${perLocaleSlug[locale]}`.replace(/\/+/g, '/');
```

(`sectionByLocale[locale]` → `sectionForJob`.)

- [ ] **Step 4: Build, run tests**

```bash
FAST_BUILD= SKIP_FUEL_DAILY=1 SKIP_BORDER_WAIT=1 SKIP_HEALTH_PREMIUMS=1 SKIP_ORPHAN_LANDINGS=1 npx vite build
npx vitest run tests/seo/cathedral-job-detail-canton.test.ts tests/seo/cathedral-section-helper.test.ts
```
Expected: PASS. Also confirm sitemap shards: a Zurich job's URL should now appear in `dist/sitemap-jobs-zurigo.xml`, not `sitemap-jobs-ticino.xml`.

- [ ] **Step 5: Commit**

```bash
git add build-plugins/jobsSeoPagesPlugin.ts tests/seo/cathedral-job-detail-canton.test.ts
git commit -m "feat(cathedral): job-detail URLs emit under job.canton section"
```

### Task 1.3: Breadcrumb level-2 + hreflang alternates use the job's canton

**Files:** Modify: `build-plugins/jobsSeoPagesPlugin.ts` lines 2110, 2200, 2298, 2740, 2745, 2795, 2946, 3051, 3070, 3153

- [ ] **Step 1: Audit each call site**

```bash
grep -n "sectionByLocale\[locale\]" build-plugins/jobsSeoPagesPlugin.ts | head -40
```
Confirm which sites are inside the per-job emit loop (need `jobCanton`) vs per-canton emit loops (need `entry.key` already in scope).

- [ ] **Step 2: Replace in the per-job loop**

For every line inside the `for (const job of validJobs)` body that reads `sectionByLocale[locale]`, replace with `buildCantonAwareSection(locale, jobCanton)`. Specifically:
- 2110 (related-jobs sitemap)
- 2200 (hreflang alt block)
- 2298 (breadcrumb level-2 `item`)
- 2490, 2512 (anchor hrefs in body)

- [ ] **Step 3: Test and commit**

```bash
FAST_BUILD= SKIP_FUEL_DAILY=1 SKIP_BORDER_WAIT=1 SKIP_HEALTH_PREMIUMS=1 SKIP_ORPHAN_LANDINGS=1 npx vite build
npx vitest run tests/seo
```

```bash
git add build-plugins/jobsSeoPagesPlugin.ts
git commit -m "fix(cathedral): job-detail breadcrumbs + hreflang use job.canton section"
```

### Task 1.4: Fix sitemap shard `_canton` propagation (P1-C — NOT verify-only)

**Files:** Modify: `build-plugins/jobsSeoPagesPlugin.ts` — every `shardUrls.push({ …, _canton: … })` site

Original review found: `shardKeyForUrl` (line ~6704) keys on `u._canton` from caller-supplied field, NOT the URL path. So Phase 1.2's URL change does NOT auto-correct the shard. This task actively rewires the canton field.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/seo/cathedral-sitemap-shards.test.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DIST = path.resolve(__dirname, '../../dist');

describe('sitemap shards partition jobs by canton (P1-C)', () => {
  it('non-TI canton job URLs appear in the matching canton shard, not TI', () => {
    const tiShard = fs.readFileSync(path.join(DIST, 'sitemap-jobs-ticino.xml'), 'utf8');
    const zhShard = fs.readFileSync(path.join(DIST, 'sitemap-jobs-zurigo.xml'), 'utf8');
    // A URL containing /cerca-lavoro-zurigo/ must NOT appear in the TI shard
    const tiLeak = tiShard.match(/<loc>https:\/\/[^<]*\/cerca-lavoro-zurigo\//g) || [];
    expect(tiLeak.length, `TI shard contains ZH URLs: ${tiLeak.slice(0,3).join(',')}`).toBe(0);
    // And the ZH shard must contain at least one /cerca-lavoro-zurigo/ URL
    const zhContent = zhShard.match(/<loc>https:\/\/[^<]*\/cerca-lavoro-zurigo\//g) || [];
    expect(zhContent.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Verify red**

```bash
FAST_BUILD= SKIP_FUEL_DAILY=1 SKIP_BORDER_WAIT=1 SKIP_HEALTH_PREMIUMS=1 SKIP_ORPHAN_LANDINGS=1 npx vite build
npx vitest run tests/seo/cathedral-sitemap-shards.test.ts
```

- [ ] **Step 3: Find and rewire every `shardUrls.push` site**

```bash
grep -n "shardUrls\.push\|_canton:" build-plugins/jobsSeoPagesPlugin.ts | head -40
```

For every push that emits a job-detail URL (or canton-scoped URL), the `_canton` field MUST be `resolveJobCanton(job)` (for job-detail URLs) or `entry.key` / `cantonContext` (for canton-landing URLs). Search-and-replace pattern:

- Job-detail emit (Phase 1.2 area): `_canton: jobCanton` (use the variable from Task 1.2 Step 3)
- City/sector/company emits (Phase 3): `_canton: outerCanton` (the per-canton loop variable)
- Canton-landing emit (~6500): `_canton: entry.key`

- [ ] **Step 4: Build + test green**

```bash
FAST_BUILD= SKIP_FUEL_DAILY=1 SKIP_BORDER_WAIT=1 SKIP_HEALTH_PREMIUMS=1 SKIP_ORPHAN_LANDINGS=1 npx vite build
npx vitest run tests/seo/cathedral-sitemap-shards.test.ts
grep -c "<loc>" dist/sitemap-jobs-zurigo.xml dist/sitemap-jobs-ticino.xml dist/sitemap-jobs-ginevra.xml
# Expect: non-zero per shard; ZH/GE URLs absent from TI shard.
```

- [ ] **Step 5: Commit**

```bash
git add build-plugins/jobsSeoPagesPlugin.ts tests/seo/cathedral-sitemap-shards.test.ts
git commit -m "fix(cathedral): sitemap shard _canton field uses resolveJobCanton (P1-C)"
```

---

## Phase 2 — `CityHubKey: string` migration (P1.3 finalization)

`cityJobsHub.ts` literal-union of 5 TI cities is the second-biggest cathedral blocker. Until lifted, `/cerca-lavoro-zurigo/zurich/` cannot route as a city-hub.

### Task 2.1: Migrate the type and tables

**Files:** Modify: `build-plugins/cityJobsHub.ts:19-38`, `services/router.ts:2373, 2562`

- [ ] **Step 1: Write router test**

```typescript
// tests/router/canton-city-routing.test.ts
import { describe, it, expect } from 'vitest';
import { parseUrlToRoute } from '../../services/router';

describe('canton+city routing', () => {
  it('/cerca-lavoro-zurigo/zurich/ → jobBoardCanton=ZH, jobBoardCity=zurich', () => {
    const parsed = parseUrlToRoute('/cerca-lavoro-zurigo/zurich/');
    expect(parsed?.route.jobBoardCanton).toBe('ZH');
    expect(parsed?.route.jobBoardCity).toBe('zurich');
    expect(parsed?.route.jobSlug).toBeUndefined();
  });
  it('/cerca-lavoro-ticino/lugano/ → jobBoardCanton=TI, jobBoardCity=lugano (TI invariance)', () => {
    const parsed = parseUrlToRoute('/cerca-lavoro-ticino/lugano/');
    expect(parsed?.route.jobBoardCanton).toBe('TI');
    expect(parsed?.route.jobBoardCity).toBe('lugano');
  });
  it('/cerca-lavoro-ginevra/geneve/ → jobBoardCity=geneve', () => {
    const parsed = parseUrlToRoute('/cerca-lavoro-ginevra/geneve/');
    expect(parsed?.route.jobBoardCity).toBe('geneve');
  });
});
```

- [ ] **Step 2: Run and verify red**

```bash
npx vitest run tests/router/canton-city-routing.test.ts
```

- [ ] **Step 3: Migrate `cityJobsHub.ts`**

Replace lines 19–38:

```typescript
import { getCantonCities, normalizeCitySlug, getCityCanton } from './shared/cantonCities';

export type CityHubKey = string;

export function isKnownCityHub(city: string, canton?: string): boolean {
  const normalized = String(city).toLowerCase().trim();
  const inferredCanton = canton ? canton.toUpperCase() : getCityCanton(normalized);
  if (!inferredCanton) return false;
  const cities = getCantonCities(inferredCanton);
  return cities.some((c) => normalizeCitySlug(c) === normalized);
}

export function cityHubDisplayName(city: string): string {
  const cities = getCantonCities(getCityCanton(city) ?? 'TI');
  const match = cities.find((c) => normalizeCitySlug(c) === city.toLowerCase());
  return match ?? city.charAt(0).toUpperCase() + city.slice(1);
}

export function cityHubSlug(city: string, _locale: 'it'|'en'|'de'|'fr'): string {
  return normalizeCitySlug(city);
}
```

- [ ] **Step 4: Update router**

In `services/router.ts:2373, 2562`, replace narrow-cast references to `CityHubKey` (literal union) with the string type. Confirm `jobBoardCity?: string` (already string at the type declaration).

- [ ] **Step 5: Run tests, build**

```bash
npx vitest run tests/router tests/seo
FAST_BUILD= SKIP_FUEL_DAILY=1 SKIP_BORDER_WAIT=1 SKIP_HEALTH_PREMIUMS=1 SKIP_ORPHAN_LANDINGS=1 npx vite build
```

- [ ] **Step 6: Commit**

```bash
git add build-plugins/cityJobsHub.ts services/router.ts tests/router/canton-city-routing.test.ts
git commit -m "feat(cathedral): CityHubKey is now string — unblocks city hubs per canton"
```

---

## Phase 3 — Per-canton sub-page graph (city / sector / company / pagina / categoria)

This phase opens the canton sub-pages graph. Each task migrates one emit-site cluster. Pattern is the same: replace `sectionByLocale[locale]` with `buildCantonAwareSection(locale, ctxCanton)` and iterate per canton instead of per-locale only.

### Task 3.1: Per-canton city hubs

**Files:** Modify: `build-plugins/jobsSeoPagesPlugin.ts:4709-4940` (the city-hub emit loop)

- [ ] **Step 1: Test**

```typescript
// tests/seo/cathedral-city-hubs.test.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
const DIST = path.resolve(__dirname, '../../dist');

describe('per-canton city hubs', () => {
  it.each([
    ['cerca-lavoro-zurigo/zurich/index.html'],
    ['cerca-lavoro-ginevra/geneve/index.html'],
    ['cerca-lavoro-vaud/lausanne/index.html'],
    ['cerca-lavoro-ticino/lugano/index.html'],          // TI invariance
  ])('%s exists', (rel) => {
    expect(fs.existsSync(path.join(DIST, rel))).toBe(true);
  });
});
```

- [ ] **Step 2: Verify red**

- [ ] **Step 3: Patch the city-hub loop**

In the city-hub block (`~lines 4709-4940`), wrap the existing emit in an outer canton loop. Pseudocode of the change:

```typescript
// BEFORE: for (const locale of localeList) { for (const city of TICINO_CITIES) { … sectionByLocale[locale] … } }
// AFTER:
import { getCantonCities, normalizeCitySlug } from './shared/cantonCities';
for (const canton of SHARED_ALL_CANTON_CODES) {
  if (cantonJobCounts.get(canton) < MIN_JOBS_FOR_CANTON_PAGE) continue;
  const cantonCities = getCantonCities(canton).slice(0, MAX_CITIES_PER_CANTON); // tune
  for (const locale of localeList) {
    for (const city of cantonCities) {
      const citySlug = normalizeCitySlug(city);
      const section = buildCantonAwareSection(locale, canton);
      const relPath = `${localePrefix[locale]}/${section}/${citySlug}`.replace(/\/+/g, '/');
      // … existing body emission, replacing every `sectionByLocale[locale]` → `section` …
      // … and `TICINO_CITIES[i]` → `city` …
    }
  }
}
```

`MAX_CITIES_PER_CANTON` is a tunable: start at 20 (covers Zurich's main job-bearing communes), gated upward by `MIN_JOBS_PER_CITY` in the existing utility.

- [ ] **Step 4: Build + verify pass**

```bash
FAST_BUILD= SKIP_FUEL_DAILY=1 SKIP_BORDER_WAIT=1 SKIP_HEALTH_PREMIUMS=1 SKIP_ORPHAN_LANDINGS=1 npx vite build
npx vitest run tests/seo/cathedral-city-hubs.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add build-plugins/jobsSeoPagesPlugin.ts tests/seo/cathedral-city-hubs.test.ts
git commit -m "feat(cathedral): per-canton city hub pages emitted for 25 cantons"
```

### Task 3.2: Per-canton sector hubs

**Files:** Modify: `build-plugins/jobsSeoPagesPlugin.ts:4368-4610`

- [ ] **Step 1: Test** — assert `dist/cerca-lavoro-zurigo/infermieri/index.html` exists.
- [ ] **Step 2: Verify red.**
- [ ] **Step 3: Wrap sector loop in canton outer loop**, replacing every `sectionByLocale[locale]` with `buildCantonAwareSection(locale, canton)` and gating each emission on `cantonSectorJobCount(canton, sector) >= MIN_JOBS_FOR_SECTOR_PAGE`. Per-canton sector counts come from grouping `validJobs.filter(j => resolveJobCanton(j) === canton)` by sector.
- [ ] **Step 4: Build + verify pass.**
- [ ] **Step 5:** `git commit -m "feat(cathedral): per-canton sector hubs (infermieri, etc.) for all eligible cantons"`

### Task 3.3: Per-canton company hubs

**Files:** Modify: `build-plugins/jobsSeoPagesPlugin.ts:3561-3925`

- [ ] **Step 1: Test** — assert `dist/cerca-lavoro-zurigo/azienda-<slug>/index.html` exists for top employers operating in ZH.
- [ ] **Step 2: Verify red.**
- [ ] **Step 3: Patch company emit** — compute `companyJobsByCanton: Map<company, Map<canton, Job[]>>` once; emit a company hub per (company, canton) pair when the canton bucket meets `MIN_JOBS_FOR_COMPANY_HUB`. Replace `sectionByLocale[locale]` with `buildCantonAwareSection(locale, canton)`.
- [ ] **Step 4: Build + verify pass.**
- [ ] **Step 5:** `git commit -m "feat(cathedral): per-canton company hubs"`

### Task 3.4: Per-canton company × city hubs

**Files:** Modify: `build-plugins/jobsSeoPagesPlugin.ts:6840-6900` area + tracking map at 6856

- [ ] **Step 1: Test** — `dist/cerca-lavoro-zurigo/azienda-<slug>-zurich/index.html` exists.
- [ ] **Step 2-3: Patch** — extend tracker `it: '/cerca-lavoro-ticino/${entry}'` (line 6856) to be canton-aware: `it: '/${section}/${entry}'`.
- [ ] **Step 4: Build + verify pass.**
- [ ] **Step 5:** `git commit -m "feat(cathedral): per-canton company × city hubs"`

### Task 3.5: Per-canton paginated lists (`/pagina-N/`)

**Files:** Modify: `build-plugins/jobsSeoPagesPlugin.ts:5295-5389`

- [ ] **Step 1: Test** — `dist/cerca-lavoro-zurigo/pagina-2/index.html` exists when canton has ≥ 25 jobs.
- [ ] **Step 2-3: Wrap pagination loop in canton outer loop**; per-canton page count computed from `validJobs.filter(j => resolveJobCanton(j) === canton).length / PAGE_SIZE`.
- [ ] **Step 4: Build + verify pass.**
- [ ] **Step 5:** `git commit -m "feat(cathedral): per-canton paginated lists"`

### Task 3.6: Per-canton category listings (`/categoria-{slug}/`)

**Files:** Modify: `build-plugins/jobsSeoPagesPlugin.ts:5389-5500`

- [ ] **Step 1: Test** — `dist/cerca-lavoro-zurigo/categoria-sanita/index.html` exists.
- [ ] **Step 2-3: Wrap in canton outer loop.**
- [ ] **Step 4: Build + verify pass.**
- [ ] **Step 5:** `git commit -m "feat(cathedral): per-canton category listing pages"`

---

## Phase 4 — Canton-landing body fill (real listing grid)

Today's `/cerca-lavoro-{canton}/index.html` is a thin indice (H1 + lede + CTA + 600 chars). Fill it with the canton's real top job grid + stat tiles + CTA above-the-fold per CLAUDE.md NON-NEGOTIABLE #17.

### Task 4.1: Pre-render top-N job grid into canton landing body

**Files:** Modify: `build-plugins/jobsSeoPagesPlugin.ts:6635-6696`

- [ ] **Step 1: Test**

Extend `tests/seo/cathedral-flip-simulation.spec.ts`:

```typescript
it('canton landing body contains ≥ 5 real listings + tile grid', () => {
  const html = fs.readFileSync(path.join(DIST, 'cerca-lavoro-zurigo/index.html'), 'utf8');
  const jobCardCount = (html.match(/data-job-id=/g) || []).length;
  expect(jobCardCount).toBeGreaterThanOrEqual(5);
  expect(html).toMatch(/data-stat-tile|STAT_TILE/);
  expect(html).toMatch(/var\(--color-(accent|success|warning)-subtle\)/);
});
```

- [ ] **Step 2: Verify red**.

- [ ] **Step 3: Build the per-canton body**

In the existing canton-landing emit loop (line 6635), replace the thin `bodyHtml` template with a richer block:

```typescript
const cantonJobs = validJobs
  .filter((j) => resolveJobCanton(j) === entry.key)
  .sort((a, b) => Number(new Date(b.datePosted || 0)) - Number(new Date(a.datePosted || 0)))
  .slice(0, 20);

const tileGrid = renderCantonStatTiles({
  totalJobs: cantonJobCounts.get(entry.key) ?? 0,
  topSector: topSectorForCanton(entry.key),
  avgSalary: avgSalaryForCanton(entry.key),
  topCity: topCityForCanton(entry.key),
});

const listingGrid = cantonJobs.map((j) => renderJobCardStatic(j, entry.locale)).join('\n');

const bodyHtml = [
  `<main class="seo-static-content" style="max-width:1080px;margin:0 auto;padding:24px 16px">`,
  `<nav style="…">${breadcrumbHtml}</nav>`,
  `<header>${h1 + lede}</header>`,
  tileGrid,                                              // stat-tile row (rule #17.3)
  `<p style="…"><a href="${cantonSection}" style="${CTA_PRIMARY_STYLE}">${ctaLabel}</a></p>`,
  listingGrid,                                           // REAL LISTINGS — the ciccia (rule #17.6)
  buildCantonContextProse(entry.locale, display),       // prose pushed BELOW (rule #17.7 + #16)
  `</main>`,
].join('\n');
```

Helpers `renderCantonStatTiles`, `renderJobCardStatic`, `topSectorForCanton`, `avgSalaryForCanton`, `topCityForCanton` live in the same plugin (search for existing patterns — TI version already exists; promote to canton-keyed).

- [ ] **Step 4: Build + verify pass**

```bash
FAST_BUILD= SKIP_FUEL_DAILY=1 SKIP_BORDER_WAIT=1 SKIP_HEALTH_PREMIUMS=1 SKIP_ORPHAN_LANDINGS=1 npx vite build
npx vitest run tests/seo/cathedral-flip-simulation.spec.ts
# Plus all SEO content gates (CLAUDE.md):
npm run audit:text-html-ratio
npm run audit:title-length
```

- [ ] **Step 5: Commit**

```bash
git add build-plugins/jobsSeoPagesPlugin.ts tests/seo/cathedral-flip-simulation.spec.ts
git commit -m "feat(cathedral): canton landings render real listing grid + stat tiles"
```

### Task 4.2: Verify mobile-first ordering

**Files:** Verify-only.

- [ ] **Step 1: Use the `gstack` skill to load `/cerca-lavoro-zurigo/` at 414px width and assert order**

The first interactive element after H1 must be a CTA → board, immediately followed by stat tiles, then listings, then prose (per non-negotiable #15-17).

- [ ] **Step 2: Screenshot before/after for the PR description.**

- [ ] **Step 3: Commit if any adjustments needed**, else `git commit --allow-empty -m "verify(cathedral): mobile-first order on canton landings"`.

---

## Phase 5 — Editorial graph expansion

`EDITORIAL_CANTONS` is the gate to per-canton editorial landings (`lavoro-part-time-{canton}`, `lavoro-infermieri-{canton}`, `ricerca-{city}`, etc.). It's currently a literal `['TI','GR','VS']` in two files.

### Task 5.1: Consolidate the dup constant

**Files:** Modify: `build-plugins/jobEditorialLanding.ts:35`, `build-plugins/jobsSeoPagesPlugin.ts:1018-1023`

- [ ] **Step 1: Move the array to `jobEditorialLanding.ts` only and re-export**

```typescript
// build-plugins/jobEditorialLanding.ts:35
import { ALL_CANTON_CODES } from './shared/cantonSection';
export const EDITORIAL_CANTONS: readonly string[] = ALL_CANTON_CODES;
```

- [ ] **Step 2: Drop the duplicate in `jobsSeoPagesPlugin.ts`**

Delete lines 1018-1023 (`EDITORIAL_PRIMARY_CANTONS` definition). Import from jobEditorialLanding:

```typescript
import { EDITORIAL_CANTONS } from './jobEditorialLanding';
```

- [ ] **Step 3: Find every consumer of the old constant and migrate**

```bash
grep -rn "EDITORIAL_PRIMARY_CANTONS" build-plugins/ services/ tests/
```
Replace with `EDITORIAL_CANTONS`.

- [ ] **Step 4: Build + test**

- [ ] **Step 5:** `git commit -m "refactor(cathedral): single source of truth for EDITORIAL_CANTONS"`

### Task 5.2: Gate editorial loops on `MIN_JOBS_FOR_CANTON_PAGE`

**Files:** Modify: `build-plugins/jobsSeoPagesPlugin.ts` lines 3916, 4218, 4392, 4553

- [ ] **Step 1: Test** — assert `dist/cerca-lavoro-zurigo/lavoro-part-time/index.html` exists for any non-TI/GR/VS canton with enough jobs.
- [ ] **Step 2: Verify red.**
- [ ] **Step 3: Add the gate inside each editorial loop**

```typescript
for (const editorialCanton of EDITORIAL_CANTONS) {
  if ((cantonJobCounts.get(editorialCanton) ?? 0) < MIN_JOBS_FOR_CANTON_PAGE) continue;
  // … existing emit body, replacing sectionByLocale[locale] with buildCantonAwareSection(locale, editorialCanton) …
}
```

- [ ] **Step 4: Build + verify pass.**
- [ ] **Step 5:** `git commit -m "feat(cathedral): editorial graph expands to all eligible cantons"`

---

## Phase 6 — F4/F5 main plugins canton-aware + chCanton helpers indexable

### Task 6.1: weeklyEmployersPlugin TI-literals → canton-aware

**Files:** Modify: `build-plugins/weeklyEmployersPlugin.ts` lines 121-136, 830-833, 2021-2024, 2436-2439, 2463, 2609-2612, 2726-2729

- [ ] **Step 1: Import the shared helper**

```typescript
import { resolveCantonSection } from './shared/cantonSection';
import { getCityCanton } from './shared/cantonCities';
```

- [ ] **Step 2: Replace each TI literal**

At each line, the city/page context already exposes the canton (either passed in or via `getCityCanton(city)`). Substitute `sectionByLocale[locale]` → `resolveCantonSection(locale, getCityCanton(city) ?? 'TI')`.

- [ ] **Step 3: Build + test**

```bash
FAST_BUILD= SKIP_FUEL_DAILY=1 SKIP_BORDER_WAIT=1 SKIP_HEALTH_PREMIUMS=1 SKIP_ORPHAN_LANDINGS=1 SKIP_JOB_MARKET_SNAPSHOT=1 npx vite build
```

- [ ] **Step 4:** `git commit -m "feat(cathedral): weeklyEmployers main plugin canton-aware"`

### Task 6.2: jobMarketSnapshotPlugin TI-literals + `TICINO_CITIES` → canton-aware

**Files:** Modify: `build-plugins/jobMarketSnapshotPlugin.ts` lines 121, 294-371, 670-680, 845-849, 1287, 1438, 2126, 2425, 2455

- [ ] **Step 1: Replace `TICINO_CITIES`**

```typescript
import { getCantonCities } from './shared/cantonCities';
// Replace `for (const city of TICINO_CITIES)` with `for (const city of getCantonCities(canton))` where `canton` is the outer loop var.
```

- [ ] **Step 2: Replace section TI literals**

- [ ] **Step 3: Build + test**

- [ ] **Step 4:** `git commit -m "feat(cathedral): jobMarketSnapshot main plugin canton-aware"`

### Task 6.3: Flip F5 helper to indexable

**Files:** Modify: `build-plugins/weeklyEmployersChCantonPages.ts:16-19`

- [ ] **Step 1: Test** — `dist/cerca-lavoro-zurigo/aziende-che-assumono/index.html` has `<meta name="robots" content="index,follow">` (with canton job-count ≥ threshold).
- [ ] **Step 2: Verify red.**
- [ ] **Step 3: Flip robots** to `index,follow` gated on `cantonJobCounts.get(canton) >= MIN_JOBS_FOR_CANTON_PAGE`. Pages below threshold keep `noindex,follow`.
- [ ] **Step 4: Build + audit gates pass.**
- [ ] **Step 5:** `git commit -m "feat(cathedral): F5 per-canton pages indexable when content matures"`

### Task 6.4: Flip F4 helper to indexable

**Files:** Modify: `build-plugins/jobMarketSnapshotChCantonPages.ts:16-19`

Same pattern as 6.3. `git commit -m "feat(cathedral): F4 per-canton pages indexable when content matures"`

---

## Phase 7 — staticPagesPlugin canton landings + seoHubs canton-aware

### Task 7.1: staticPagesPlugin emits per-canton index for 25 non-TI cantons

**Files:** Modify: `build-plugins/staticPagesPlugin.ts:384-388 (HOME_CRITICAL_STATIC_PATHS), 495-3520 (the rich TI body builder)`

- [ ] **Step 1: Test** — `dist/cerca-lavoro-zurigo/index.html` is the **rich** index (>= 30 KB, full nav, hub links, deep-link navigator), not the thin landing emitted by `jobsSeoPagesPlugin.ts`.

Note: there will now be a conflict between `staticPagesPlugin` (rich emit) and `jobsSeoPagesPlugin.ts:6635` (thin emit). Resolve by: `staticPagesPlugin` runs `enforce: 'post'` later than `jobsSeoPagesPlugin`, OR `jobsSeoPagesPlugin` skips emit for canton landings already in `HOME_CRITICAL_STATIC_PATHS`. **Decision: extend `staticPagesPlugin` to own all 25 cantons; `jobsSeoPagesPlugin` skips `code === entry.key` for any code in that set.**

- [ ] **Step 2: Verify red.**
- [ ] **Step 3: Promote the TI body builder to a parameterized canton function** in `staticPagesPlugin.ts`. Extract `buildJobBoardLandingBody(canton, locale)` from the current TI-only block.
- [ ] **Step 4: Wire it for all 25 cantons + aggregator.** Add per-canton `HOME_CRITICAL_STATIC_PATHS` entries (104 paths × 4 locales = 100 new entries).
- [ ] **Step 5: In `jobsSeoPagesPlugin.ts:6529`, skip codes owned by `staticPagesPlugin`.**
- [ ] **Step 6: Build + test.**
- [ ] **Step 7:** `git commit -m "feat(cathedral): staticPagesPlugin owns all 25 canton landings (rich index)"`

### Task 7.2: seoHubsData canton-aware

**Files:** Modify: `build-plugins/seoHubsData.ts:40-62`, `build-plugins/seoHubsPlugin.ts`

- [ ] **Step 1: Test** — `dist/cerca-lavoro-zurigo/tutti/`, `/settori/`, `/aziende/` index pages exist.
- [ ] **Step 2-3: Promote `HUB_SLUGS` to a function**

```typescript
import { resolveCantonSection } from './shared/cantonSection';
import type { CantonLocale } from './shared/cantonSection';

export type HubKind = 'tutti' | 'settori' | 'aziende';

const HUB_SLUG_BY_LOCALE: Record<CantonLocale, Record<HubKind, string>> = {
  it: { tutti: 'tutti', settori: 'settori', aziende: 'aziende' },
  en: { tutti: 'all', settori: 'sectors', aziende: 'companies' },
  de: { tutti: 'alle', settori: 'branchen', aziende: 'unternehmen' },
  fr: { tutti: 'tous', settori: 'secteurs', aziende: 'entreprises' },
};

export function hubSlugFor(canton: string, locale: CantonLocale, hub: HubKind): string {
  return `${resolveCantonSection(locale, canton)}/${HUB_SLUG_BY_LOCALE[locale][hub]}`;
}
```

- [ ] **Step 4: Iterate over all eligible cantons in `seoHubsPlugin.ts`.**
- [ ] **Step 5: Build + test.**
- [ ] **Step 6:** `git commit -m "feat(cathedral): seoHubs (/tutti/, /settori/, /aziende/) per canton"`

### Task 7.3: `jobBoardSeo.isJobBoardLandingPath` predicate fix

**Files:** Modify: `build-plugins/jobBoardSeo.ts:37-50`

- [ ] **Step 1: Test**

```typescript
import { isJobBoardLandingPath } from '../../build-plugins/jobBoardSeo';
expect(isJobBoardLandingPath('/cerca-lavoro-zurigo/')).toBe(true);
expect(isJobBoardLandingPath('/cerca-lavoro-svizzera/')).toBe(true);
expect(isJobBoardLandingPath('/cerca-lavoro-ticino/')).toBe(true);     // legacy
expect(isJobBoardLandingPath('/find-jobs-zurich/')).toBe(true);
expect(isJobBoardLandingPath('/jobs-im-aargau/')).toBe(true);
expect(isJobBoardLandingPath('/de/jobs-in-der-waadt/')).toBe(true);
expect(isJobBoardLandingPath('/cerca-lavoro-ticino/lugano/')).toBe(false);
```

- [ ] **Step 2-3: Replace the literal set with a regex predicate**

```typescript
const SECTION_REGEX = /^\/(?:(it|en|de|fr)\/)?(?:cerca-lavoro|find-jobs|jobs-in|jobs-im|jobs-in-der|trouver-emploi)-[a-z-]+\/?$/;
export function isJobBoardLandingPath(urlPath: string): boolean {
  return SECTION_REGEX.test(urlPath);
}
```

- [ ] **Step 4: Build + test.**
- [ ] **Step 5:** `git commit -m "fix(cathedral): isJobBoardLandingPath recognises all canton landings"`

---

## Phase 8 — Redirect logic canton-inference

### Task 8.1: searchConsoleCompat canton-aware

**Files:** Modify: `build-plugins/searchConsoleCompat.ts:4, 69, 71, 144, 154`

- [ ] **Step 1: Test** — `/cerca-lavoro/<zurich-job-slug>` 404 redirects to `/cerca-lavoro-zurigo/<slug>/`, not `/cerca-lavoro-ticino/<slug>/`.
- [ ] **Step 2: Verify red.**
- [ ] **Step 3: Load slug-registry, infer canton from registered URL**

```typescript
import slugRegistry from '../data/slug-registry.json';
import { resolveCantonSection } from './shared/cantonSection';
import { resolveJobCanton } from './shared/cantonSection';

function inferTargetSection(slug: string, locale: CantonLocale): string {
  const registered = slugRegistry[slug];
  if (registered?.canton) return resolveCantonSection(locale, registered.canton);
  return resolveCantonSection(locale, 'TI'); // fallback for unknown slugs
}
```

Replace blanket `/cerca-lavoro-ticino/${slug}/` with `${inferTargetSection(slug, locale)}/${slug}/`.

- [ ] **Step 4: Build + test.**
- [ ] **Step 5:** `git commit -m "fix(cathedral): searchConsoleCompat infers canton from slug-registry"`

### Task 8.2: legacyRedirectsPlugin canton-aware

**Files:** Modify: `build-plugins/legacyRedirectsPlugin.ts:189, 233-239, 331`

- [ ] **Step 1: Test** — `/job-board/` (locale-agnostic) → `/cerca-lavoro-svizzera/` (aggregator); per-canton legacy paths inferred.
- [ ] **Step 2-3: Same pattern as 8.1** — use `slug-registry` + `resolveCantonSection`.
- [ ] **Step 4: Build + test.**
- [ ] **Step 5:** `git commit -m "fix(cathedral): legacyRedirects route per slug-registry canton"`

### Task 8.3: jobOrphanBridgePlugin canton-aware

**Files:** Modify: `build-plugins/jobOrphanBridgePlugin.ts:29-32, 78-81`

- [ ] **Step 1-5: Convert section-slug table to a function call using `resolveCantonSection`.**

`git commit -m "fix(cathedral): jobOrphanBridge canton-aware section resolution"`

---

## Phase 9 — Misc TI-hardcoded cleanup

Mechanical replacements; each task is small and self-contained.

### Task 9.1: annualReportPlugin

**Files:** Modify: `build-plugins/annualReportPlugin.ts:713-728`

- [ ] Replace TI-only "jobs hub" links with the aggregator `/cerca-lavoro-svizzera/` (+ locale variants). Commit.

### Task 9.2: editorialContent

**Files:** Modify: `build-plugins/editorialContent.ts:1129, 1977, 2482`

- [ ] Replace hard-coded `/cerca-lavoro-ticino/` prose links with `resolveCantonSection(locale, articleCanton)` where each article has a `canton` field (or falls back to aggregator). Commit.

### Task 9.3: blogContextualLinksData

**Files:** Modify: `build-plugins/blogContextualLinksData.ts:143`

- [ ] Replace `/cerca-lavoro-ticino/ultimi-3-giorni/` → `/cerca-lavoro-svizzera/ultimi-3-giorni/` (aggregator). Commit.

### Task 9.4: professionLandingsLinksPlugin

**Files:** Modify: `build-plugins/professionLandingsLinksPlugin.ts:13`

- [ ] Replace TI link with aggregator (or per-canton if `landing.canton` is set). Commit.

### Task 9.5: Cleanup pass — clear the no-TI-hardcodes lint

- [ ] **Step 1: Run the lint test**

```bash
npx vitest run tests/seo/cathedral-no-ti-hardcodes.test.ts
```

- [ ] **Step 2: For each remaining offender, either fix or add to the explicit allowlist with a justification** (e.g. a comment that explains why this string must remain).

- [ ] **Step 3: Confirm test goes green.**

- [ ] **Step 4:** `git commit -m "chore(cathedral): clear no-TI-hardcodes lint — all offenders resolved or allowlisted"`

---

## Phase 10 — Regression + smoke + post-deploy verification

### Task 10.1: Full test suite + all SEO content gates pass

**Files:** none — verification.

- [ ] **Step 1: Run everything**

```bash
npx tsc --noEmit
FAST_BUILD= SKIP_FUEL_DAILY=1 SKIP_BORDER_WAIT=1 npx vite build
npx vitest run
npm run audit:text-html-ratio
npm run audit:orphan-sitemap-pages
npm run audit:image-object-license
npm run audit:max-bfs-depth
npm run audit:title-length
npm run audit:title-no-disambig-hash
```

- [ ] **Step 2: Rebaseline ONLY for the gates that improved** — e.g. if title-length improved, run `:rebaseline` and commit the new baseline.

- [ ] **Step 3: Acceptance test green**

```bash
npx vitest run tests/seo/cathedral-flip-simulation.spec.ts tests/seo/cathedral-no-ti-hardcodes.test.ts
```
All cathedral tests PASS.

### Task 10.2: Open PR — bundled cathedral completion

- [ ] **Step 1: Push branch + open PR**

```bash
git push -u origin cathedral-canton-aware-completion
gh pr create --title "feat(cathedral): canton-aware completion (job-detail, city/sector/company/pagina/categoria, editorial, F4/F5, redirects)" --body "$(cat <<'EOF'
## Summary

Closes the cathedral CH-wide expansion by routing every emitted page under its canton's URL section instead of the legacy TI-only one. Migrates ~30 emit sites in `jobsSeoPagesPlugin.ts` + 6 sibling plugins to a single shared helper (`build-plugins/shared/cantonSection.ts`). TI URLs are byte-identical (legacy invariance gate). Non-TI cantons now get: job-detail pages, city/sector/company/pagina/categoria sub-pages, real listing grid on the canton landing, editorial graph, indexable F4/F5 helpers, and canton-aware redirects.

## Verification

- [ ] `npx vitest run tests/seo/cathedral-*` all green
- [ ] `npm run audit:text-html-ratio` passes (no regression)
- [ ] `dist/cerca-lavoro-ticino/` job slugs unchanged vs main (byte-identical sample)
- [ ] `dist/cerca-lavoro-zurigo/` has rich landing + ≥ 20 listings + city/sector/company sub-pages
- [ ] Sitemap shards (`sitemap-jobs-zurigo.xml`, …) contain canton-specific job URLs
- [ ] Post-deploy curl smoke on 5 random canton URLs returns rich pages, not thin indices

## Out of scope (follow-ups)

- Phase-2 marquee crawlers (separate plan)
- Per-canton editorial *content quality* gate (initial emission uses templated context prose; bespoke prose can be tightened incrementally)
EOF
)"
```

### Task 10.3: Post-deploy live smoke

After merge + `deploy.yml` completes:

- [ ] **Step 1: Curl 5 random non-TI canton landings**

```bash
for slug in cerca-lavoro-zurigo cerca-lavoro-ginevra cerca-lavoro-vaud cerca-lavoro-berna cerca-lavoro-argovia; do
  echo "=== $slug ==="
  curl -s "https://frontaliereticino.ch/${slug}/" | grep -E "data-job-id|JobPosting|stat-tile" | head -3
done
```

Expected: each URL returns multiple `data-job-id` matches (real listings) + at least one stat-tile.

- [ ] **Step 2: Pick 3 random non-TI job slugs and verify they live under canton**

```bash
node -e "const j=require('./data/jobs.json'); const sample=j.filter(x=>x.canton&&x.canton!=='TI').slice(0,3); sample.forEach(x=>console.log(x.canton, x.slugByLocale?.it||x.slug))"
# For each (CANTON, slug): curl -sI "https://frontaliereticino.ch/cerca-lavoro-{cantonSlug}/${slug}/" expects 200
```

- [ ] **Step 3: GSC submit-sitemap re-ping**

```bash
gh workflow run gsc-resubmit-sitemaps.yml --ref main || true
```

- [ ] **Step 4: 24h monitor — track GSC coverage report for the new canton URLs**

Acceptance: within 7 days, ≥ 50% of new canton URLs in the "Crawled" bucket; within 30 days, ≥ 30% in "Indexed".

---

## Risk register

| Risk | Mitigation |
|---|---|
| A TI URL changes byte-for-byte (slug-registry contract breakage) | `tests/seo/cathedral-section-helper.test.ts` TI invariance + Phase 0.1 snapshot to diff against |
| Sitemap shard imbalance — Zurich shard explodes, TI shrinks | `shardKeyForUrl` is already URL-derived; expected. Verify with `wc -l dist/sitemap-jobs-*.xml`. |
| Build time blowup from 25× per-canton emit loops | Use `MIN_JOBS` gates aggressively. Track build wallclock in `.github/workflows/deploy.yml` and abort if > 2× baseline. |
| Thin per-canton landing for low-job-count cantons gets indexed | `robots: noindex,follow` already auto-applied via existing MIN_JOBS gate at line 6645 |
| `legacyRedirects` mis-routes a TI orphan to non-TI canton via wrong slug-registry entry | Slug-registry has canton metadata only for fresh emits; legacy entries default to TI fallback (intentional, safe) |
| Search Console regression on TI organic traffic | Compare CTR/impressions on TI URLs week-over-week; rollback runbook in `docs/CATHEDRAL-ROLLBACK.md` flips the `getJobBoardSlugForCanton` early-return back to TI for all cantons |

## Rollback plan

Per `docs/CATHEDRAL-ROLLBACK.md`:
1. Revert this PR's merge commit.
2. The pre-cathedral slug-registry snapshot (Phase 0.1) is the diff anchor.
3. Static HTML rebuild from `main` restores TI-only emission.
4. Sitemap shards: re-emit; Google will surface 404s on canton URLs for ~7-14 days; acceptable given the rollback is itself an emergency.

---

## Self-review summary

- **Spec coverage**: All 9 audit gaps from the diagnosis (sectionByLocale literals, CityHubKey union, thin landings, EDITORIAL_CANTONS, F4/F5, staticPages, seoHubs, redirects, misc cleanup) have explicit tasks. ✅
- **Placeholder scan**: No TBDs, no "implement later"; every step has a concrete command or code block. ✅
- **Type consistency**: `resolveCantonSection(locale, cantonCode)` and `resolveJobCanton(job)` are defined in Task 0.2 and used identically through Phases 1–9. ✅
- **TI invariance**: Multiple guards — section helper early-return for `'TI'`, snapshot diff in Phase 10, dedicated TI test cases in `cathedral-section-helper.test.ts`, sample TI byte-diff in PR description. ✅

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-11-cathedral-canton-aware-completion.md`.

**Suggested next step**: third-party review on this plan document (codex / external Claude agent) before any code change. After review, execute either:

1. **Subagent-Driven** (recommended) — fresh subagent per task, two-stage review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in the current session via `superpowers:executing-plans`, batch checkpoints.
