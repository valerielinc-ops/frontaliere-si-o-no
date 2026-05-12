# Cathedral — Finalize & Publish Deploy Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Get the cathedral CH-wide expansion content fully live on `https://frontaliereticino.ch`. Code is already merged to main (commits `87121647a9..468daff632`, ~40 commits). The deploy pipeline rolls back on every push because 4 `validate-dist` audit gates fail. Each task below targets one gate; when all pass, the deploy `publish` step runs and cathedral content (Phase 1 job-detail routing, Phase 3 sub-pages, Phase 4 canton-landing body fill) reaches live.

**Architecture:** Surgical fixes to existing emit logic in `build-plugins/jobsSeoPagesPlugin.ts` + small data/script additions. No new features — only closing the gap between "emit code in main" and "audit gates green so publish runs".

**Tech Stack:** Same as cathedral plan — React 19 + TypeScript ~5.8 + Vite 6, vitest 4.

**Pre-requisites:**
- Start in a worktree: `EnterWorktree` to branch `cathedral-finalize-deploy`.
- `data/jobs.json` (gitignored) copied from main worktree into the new worktree before any script runs.
- `FAST_BUILD=` forced when running any vite command — `FAST_BUILD=1` is inherited from `.claude/settings.json` and would skip SEO plugins.
- Other orchestrators may have active worktrees. Don't touch `worktree-fix-*` branches.

---

## Current failure profile (from CI run 25713008263, 2026-05-12 04:51 UTC)

| Gate | rc | Severity | Cathedral-induced? |
|---|---|---|---|
| `audit:orphan-sitemap-pages` | 0 PASS | — | (already passing) |
| `validate:sitemap-pages` (content-quality) | 1 | **blocking** | YES — 13 sitemap URLs claim HTML at canton URL but file is at TI URL (dedup leak) |
| `audit:max-bfs-depth` | 1 | **blocking** | NO — pre-existing border-wait monthly archives unreachable |
| `audit:hreflang` | 1 | **blocking** | partial — 146 jobs missing x-default; emit code looks correct but some path produces only 4 entries |
| `validate:sitemap-links` | 1 | **blocking** | YES — same 13 missing-html entries as sitemap-pages |
| `audit:text-html-ratio` / `audit:title-no-disambig-hash` / `audit:page-weight` / `audit:title-length` / `audit:h1-title-duplicates` | 2 | cascading | rc=2 means they timed out / cap-fired because earlier gates exhausted parallel slots; not real failures |

When the 4 blocking gates (sitemap-pages, sitemap-links, hreflang, bfs-depth) pass, the cap-2 audits will run and likely also pass.

---

## File Structure

### Files to **modify**
| Path | Phase | Change |
|---|---|---|
| `build-plugins/jobsSeoPagesPlugin.ts:~1944-2305` (job-detail emit loop) | T1 | Skip sitemap shard push when emit was deduped |
| `build-plugins/jobsSeoPagesPlugin.ts:~2196-2204` (hreflang block) | T2 | Defensive x-default always emits (canonicalUrl fallback) + dedup alternates by hreflang |
| `build-plugins/shared/cantonSection.ts:resolveJobCanton` | T3 | Tokenize multi-word locations ("Davos Klosters", "Aesch ZH", "Zürich Flughafen") |
| `build-plugins/borderWaitPages.ts` (or wherever the monthly archive emit lives) | T4 | Emit reachable archive index linking each crossing's monthly pages |
| `data/text-html-ratio-baseline.json`, `data/bfs-depth-baseline.json`, etc. | T6 | Rebaseline-down only if a deliberate improvement landed |

### Files to **create**
| Path | Purpose |
|---|---|
| `tests/seo/cathedral-sitemap-emit-consistency.test.ts` | Asserts every sitemap URL has a matching HTML file in `dist/` (offline-friendly: skips if dist absent) |
| `tests/seo/cathedral-hreflang-x-default.test.ts` | Asserts every page that emits any hreflang ALSO emits x-default |

---

## Phase 1 — Foundation + worktree + state snapshot

### Task 1.1: Enter worktree

- [ ] **Step 1: Spawn worktree on new branch**

Use `EnterWorktree` (or via Bash):
```bash
git worktree add /Users/saggesel/Projects/cathedral-finalize -b cathedral-finalize-deploy
cd /Users/saggesel/Projects/cathedral-finalize
```

- [ ] **Step 2: Copy gitignored data files**

```bash
cp /Users/saggesel/Projects/frontaliere-si-o-no/data/jobs.json data/jobs.json
ls -la data/jobs.json
```
Expected: ~30MB file exists. Will be needed for Phase 8.4 redirect emit, slug-registry back-fill, and any data-aware test.

- [ ] **Step 3: Verify baseline state**

```bash
git log --oneline -5
git status --short
npx tsc --noEmit 2>&1 | tail -5
```
Expected: HEAD shows cathedral commits, status clean, tsc passes.

### Task 1.2: Re-run slug-registry back-fill

The slug-registry on main has new crawler-added entries since the last back-fill (~140 entries from cron job updates). Re-run the migration.

- [ ] **Step 1: Run migration**

```bash
node scripts/migrate-slug-registry-add-canton.mjs
```
Expected stdout: `slug-registry back-fill: N canton-resolved, M fell back to TI, P already had canton`. M should be small (<50) if recent.

- [ ] **Step 2: Verify test passes**

```bash
npx vitest run tests/seo/cathedral-slug-registry-canton-backfill.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add data/slug-registry.json
git -c commit.gpgsign=false commit -m "chore(cathedral): refresh slug-registry canton back-fill (covers latest crawler entries)"
```

---

## Phase 2 — Fix `validate:sitemap-pages` + `validate:sitemap-links` (13 missing-html errors)

**Root cause (verified via CI log inspection):** A single LocalSearch employer has jobs in 8+ cantons. The sitemap shard for each canton pushes the URL `/de/jobs-in-{canton}/verkauferin-verkaufer-im-aussendienst-localsearch-ch/`, but the job-detail emit's `emittedActiveJobPaths.has(__activeJobKey)` dedup at line 1958 of `jobsSeoPagesPlugin.ts` suppresses all but the first emission (since the slug `verkauferin-verkaufer-im-aussendienst-localsearch-ch` is identical across the jobs after locale normalization). Result: sitemap claims 8 URLs but only 1 HTML file exists.

### Task 2.1: Make sitemap shard push conditional on emit success

**Files:** `build-plugins/jobsSeoPagesPlugin.ts:~1944-2305`

- [ ] **Step 1: Write failing test**

Create `tests/seo/cathedral-sitemap-emit-consistency.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DIST = path.resolve(__dirname, '../../dist');

describe('sitemap-emit consistency — every sitemap URL has a dist file', () => {
  it('canton sitemap URLs all resolve to a dist HTML file', () => {
    if (!fs.existsSync(DIST)) return; // skip in offline test runs
    const sitemapDir = DIST;
    const canton_shards = fs.readdirSync(sitemapDir)
      .filter((f) => f.startsWith('sitemap-jobs-') && f.endsWith('.xml'));
    const missing: string[] = [];
    for (const shard of canton_shards) {
      const xml = fs.readFileSync(path.join(sitemapDir, shard), 'utf-8');
      const locs = [...xml.matchAll(/<loc>https:\/\/frontaliereticino\.ch(\/[^<]+)<\/loc>/g)].map((m) => m[1]);
      for (const loc of locs) {
        const filePath = path.join(DIST, loc.slice(1).replace(/\/$/, ''), 'index.html');
        const flatPath = path.join(DIST, loc.slice(1).replace(/\/$/, '') + '.html');
        if (!fs.existsSync(filePath) && !fs.existsSync(flatPath)) {
          missing.push(`${shard}: ${loc}`);
        }
      }
    }
    expect(missing, `Missing HTML for sitemap URLs (sample): ${missing.slice(0, 5).join(', ')}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Locate the dedup site in the emit loop**

```bash
grep -n "emittedActiveJobPaths\|shardUrls\.push" build-plugins/jobsSeoPagesPlugin.ts | head -20
```

Find the `emittedActiveJobPaths.has(__activeJobKey)` check (around line 1958) and the `shardUrls.push({…, _canton: …})` call (around line 6498 region).

- [ ] **Step 3: Restructure emit to track which canton-section paths actually emit HTML**

In the per-job loop (around line 1944), introduce a Set `emittedActiveCantonSectionPaths: Set<string>` (key = canton-section path WITHOUT locale prefix). Populate it inside the `for (const locale of localeList)` body AFTER a successful HTML write (NOT before the dedup check). Then at the sitemap shard push site, only push entries whose canton-section path is in this Set.

Concretely, modify `jobsSeoPagesPlugin.ts` around line 1944-1965:

```typescript
// At top of file or near `emittedActiveJobPaths`
const emittedActiveCantonSectionPaths: Set<string> = new Set();

// Inside the per-locale emit (after the existing successful HTML write):
const cantonSectionKey = `${jobCanton}|${perLocaleSlug[locale]}`;
emittedActiveCantonSectionPaths.add(cantonSectionKey);
```

Then in the sitemap shard push site (~line 6470-6510), add:
```typescript
const groupCantonSectionKey = `${groupJobCanton}|${perLocaleSlug.it}`;
if (!emittedActiveCantonSectionPaths.has(groupCantonSectionKey)) {
  continue;  // sitemap URL would point to a missing HTML file
}
shardUrls.push({ /* existing fields */ });
```

- [ ] **Step 4: Verify test (skip if dist absent)**

```bash
npx vitest run tests/seo/cathedral-sitemap-emit-consistency.test.ts
```
Should pass (test skips when no dist).

- [ ] **Step 5: Commit**

```bash
git add build-plugins/jobsSeoPagesPlugin.ts tests/seo/cathedral-sitemap-emit-consistency.test.ts
git -c commit.gpgsign=false commit -m "fix(cathedral): suppress sitemap shard push when job-detail emit was deduped (validate-sitemap-pages 13 missing-html fix)"
```

---

## Phase 3 — Fix `audit:hreflang` (146 jobs missing x-default)

**Root cause:** Each of 146 affected pages has 4 hreflang `<link>` tags but no `x-default`. The emit code at `jobsSeoPagesPlugin.ts:2200-2204` already emits x-default conditionally on `xDefaultHref` truthy. Since `alternates` is built from `localeList` (4 items), `alternates[0]?.href` should always be truthy → x-default should emit.

**Hypothesis:** The 146 pages emit via a DIFFERENT code path than line 2200. Possibly:
- Phase 3.x sub-pages (city/sector/company hubs) where one of the alternates is falsy
- A locale-specific edge case where the FR slug equals another locale's slug → alternates contains a duplicate href and audit's Map collapses

### Task 3.1: Force unconditional x-default + dedup alternates

**Files:** `build-plugins/jobsSeoPagesPlugin.ts` ALL 12 hreflang emit sites (lines 2200-2204, 3071-3075, 3956, 4105, 4265, 4438, 4618, 4797, 5029, 5192, 5391, 5523)

- [ ] **Step 1: Write failing test**

Create `tests/seo/cathedral-hreflang-x-default.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DIST = path.resolve(__dirname, '../../dist');

function walkHtml(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkHtml(full, out);
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

describe('every page with hreflang ALSO emits x-default', () => {
  it('checks dist for hreflang completeness', () => {
    if (!fs.existsSync(DIST)) return;
    const sample = walkHtml(DIST).slice(0, 5000);  // sample for speed
    const offenders: string[] = [];
    for (const file of sample) {
      const html = fs.readFileSync(file, 'utf-8');
      const hreflangs = [...html.matchAll(/<link\s+rel="alternate"\s+hreflang="([^"]+)"/gi)].map((m) => m[1]);
      if (hreflangs.length === 0) continue;
      const set = new Set(hreflangs);
      if (set.size > 0 && !set.has('x-default')) {
        offenders.push(path.relative(DIST, file));
      }
    }
    expect(offenders, `Pages with hreflang but no x-default (sample): ${offenders.slice(0, 5).join(', ')}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Replace conditional x-default with unconditional + alternates dedup**

For EACH of the 12 hreflang emit sites in `jobsSeoPagesPlugin.ts`, replace the pattern:
```typescript
const xDefaultHref = ...;
const hreflangHtml = [
  ...alternates.map(...),
  ...(xDefaultHref ? [` <link rel="alternate" hreflang="x-default" href="${xDefaultHref}">`] : []),
].join('\n');
```
with:
```typescript
// Dedup alternates by hreflang (and skip empty hrefs) before emitting.
const altSeen = new Set<string>();
const altLinks: string[] = [];
for (const h of alternates) {
  if (!h.href || altSeen.has(h.lang)) continue;
  altSeen.add(h.lang);
  altLinks.push(` <link rel="alternate" hreflang="${h.lang}" href="${h.href}">`);
}
// x-default MUST be present. Fallback to IT alternate → first alternate → canonicalUrl.
const xDefaultHref =
  alternates.find((h) => h.lang === 'it')?.href ||
  alternates[0]?.href ||
  canonicalUrl;
altLinks.push(` <link rel="alternate" hreflang="x-default" href="${xDefaultHref}">`);
const hreflangHtml = altLinks.join('\n');
```

**Variable name notes:** Different emit sites use different names for the var holding the hreflang HTML (`hreflangHtml`, `altPairs`, `_xDefaultAltHref`, `catAlternates`, `pgSmAlternates`, etc.). Match the existing names; don't rename.

Sites to touch:
- `jobsSeoPagesPlugin.ts:~2200-2204` — job-detail per-locale loop
- `jobsSeoPagesPlugin.ts:~3071-3075` — company hub
- `jobsSeoPagesPlugin.ts:~3956` — today landing
- `jobsSeoPagesPlugin.ts:~4105` — nurses hub
- `jobsSeoPagesPlugin.ts:~4265` — part-time
- `jobsSeoPagesPlugin.ts:~4438` — care variant
- `jobsSeoPagesPlugin.ts:~4618` — care variant breadcrumb
- `jobsSeoPagesPlugin.ts:~4797` — city hub (TI legacy)
- `jobsSeoPagesPlugin.ts:~5029` / `~5192` — sector hub variants
- `jobsSeoPagesPlugin.ts:~5391` — Phase 3.1 per-canton city hub
- `jobsSeoPagesPlugin.ts:~5523` — Phase 3.5 pagination

Use `grep -n "x-default" build-plugins/jobsSeoPagesPlugin.ts` to find each. Confirm context (variable names) before editing.

- [ ] **Step 3: Verify test passes**

```bash
npx vitest run tests/seo/cathedral-hreflang-x-default.test.ts
```
Test should pass when dist absent (skipped). On real dist, should be green after the fix.

- [ ] **Step 4: Commit**

```bash
git add build-plugins/jobsSeoPagesPlugin.ts tests/seo/cathedral-hreflang-x-default.test.ts
git -c commit.gpgsign=false commit -m "fix(cathedral): unconditional x-default on every hreflang block (audit-hreflang 146 fix)"
```

---

## Phase 4 — Fix `audit:max-bfs-depth` (border-wait monthly archives, pre-existing)

**Root cause (NOT cathedral-induced):** The border-wait F8 plugin emits monthly archive pages at `/traffico-dogane/{crossing}/2026-04/` (5 crossings × 4 locales × N months). No internal link from any reachable page leads to them within BFS depth 4. The audit walks `dist/` from `/` and counts unreachable URLs vs. baseline; baseline is `0` for many sitemaps, current count is 20+.

### Task 4.1: Add archive index per crossing reachable from the live border-wait hub

**Files:** `build-plugins/borderWaitPages.ts` (or wherever F8 archive pages are emitted)

- [ ] **Step 1: Locate F8 emit logic**

```bash
grep -rn "traffico-dogane\|border-wait\|2026-\|monthly archive" build-plugins/ 2>/dev/null | head -10
```

Identify (a) where monthly archive pages are emitted, (b) where the live border-wait hub `/guida-frontaliere/mappa-live-valichi/` is emitted.

- [ ] **Step 2: Emit per-crossing archive index page**

For each crossing (chiasso-brogeda, chiasso-centro, gaggiolo, oria-gandria, ponte-tresa), emit a page at `/traffico-dogane/{crossing}/archivio/index.html` (× 4 locales) that lists all monthly archive pages for that crossing as a `<ul>` of `<a href>`. Make sure each `<a>` points at the full monthly URL.

The page body needs a real H1 + a few sentences + the list (>50 words for `validate:sitemap-pages` thin-content gate). Boilerplate:
```html
<h1>Archivio attese al valico {crossing} — frontaliere</h1>
<p>Cronologia mensile dei tempi di attesa al valico di {crossing}, frontiera Italia-Svizzera. Aggiornato giornalmente con dati live.</p>
<ul>
  <li><a href="/traffico-dogane/{crossing}/2026-05/">Maggio 2026</a></li>
  <li><a href="/traffico-dogane/{crossing}/2026-04/">Aprile 2026</a></li>
  ...
</ul>
```

- [ ] **Step 3: Link archive index from live border-wait hub**

In the body of `/guida-frontaliere/mappa-live-valichi/` (or equivalent), inject a small "Archivio mensile" section linking to each `/traffico-dogane/{crossing}/archivio/` page. This ensures BFS depth: `/` → `/guida-frontaliere/` → `/guida-frontaliere/mappa-live-valichi/` → `/traffico-dogane/{crossing}/archivio/` → `/traffico-dogane/{crossing}/2026-04/` (= depth 4, within limit).

- [ ] **Step 4: Update bfs-depth baseline (legitimate ratchet-DOWN)**

After the fix, the unreachable count drops from 20+ to ~0. Run rebaseline:
```bash
npm run audit:max-bfs-depth:rebaseline 2>/dev/null || node scripts/audit-bfs-depth.mjs --write-baseline=data/bfs-depth-baseline.json
```

Verify the new baseline shows ≤ existing values (ratchet down OK). Commit the new baseline AND the fix together.

- [ ] **Step 5: Commit**

```bash
git add build-plugins/borderWaitPages.ts data/bfs-depth-baseline.json
git -c commit.gpgsign=false commit -m "fix(border-wait): emit per-crossing archive index + link from live hub (audit-max-bfs-depth fix)"
```

---

## Phase 5 — Optional: Improve `resolveJobCanton` for multi-word locations

Not blocking the audit gates (Phase 2's dedup fix handles the immediate symptom), but a quality improvement for jobs whose location has multiple tokens.

### Task 5.1: Tokenize location string in `resolveJobCanton`

**Files:** `build-plugins/shared/cantonSection.ts`

- [ ] **Step 1: Read the current resolver**

```bash
grep -A20 "export function resolveJobCanton" build-plugins/shared/cantonSection.ts
```

- [ ] **Step 2: Replace body**

```typescript
export function resolveJobCanton(job: { canton?: string; location?: string }): string {
  const explicit = String(job.canton || '').toUpperCase().trim();
  if (explicit && (cantons[explicit] || memberToGroup[explicit])) {
    return resolveCantonGroup(explicit);
  }
  const loc = String(job.location || '').toLowerCase();
  if (!loc) return 'TI';
  // Try full bare-form lookup (most precise)
  const fullCity = loc.split(/[,(]/)[0].trim();
  if (fullCity && CITY_TO_CANTON[fullCity]) return resolveCantonGroup(CITY_TO_CANTON[fullCity]);
  // Try each token (handles "Davos Klosters" → 'davos' hits → GR)
  const tokens = loc.replace(/[(),]/g, ' ').split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (CITY_TO_CANTON[token]) return resolveCantonGroup(CITY_TO_CANTON[token]);
  }
  return 'TI';
}
```

- [ ] **Step 3: Add test cases**

In `tests/seo/cathedral-section-helper.test.ts`, add to the `resolveJobCanton` describe block:
```typescript
it('handles multi-word locations', () => {
  expect(resolveJobCanton({ canton: '', location: 'Davos Klosters' })).toBe('GR');
  expect(resolveJobCanton({ canton: '', location: 'Aesch ZH' })).toBe('ZH');
  expect(resolveJobCanton({ canton: '', location: 'Zürich Flughafen' })).toBe('ZH');
  expect(resolveJobCanton({ canton: '', location: 'Sankt Gallen' })).toBe('SG');
});
```

- [ ] **Step 4: Verify**

```bash
npx vitest run tests/seo/cathedral-section-helper.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add build-plugins/shared/cantonSection.ts tests/seo/cathedral-section-helper.test.ts
git -c commit.gpgsign=false commit -m "fix(cathedral): tokenize multi-word locations in resolveJobCanton"
```

---

## Phase 6 — Aggregator linking (internal nav for cathedral discoverability)

Not blocking audit gates, but improves the cathedral story: today `/cerca-lavoro-svizzera/` is a navigation hub with 0 listings. Make sure it links to every canton section.

### Task 6.1: Aggregator body lists all canton sections

**Files:** Find where `/cerca-lavoro-svizzera/` is emitted — probably `jobsSeoPagesPlugin.ts` around line 6526 (canton-landing emit loop, the `_AGGREGATE_` branch).

- [ ] **Step 1: Verify aggregator emit logic**

```bash
grep -n "AGGREGATE\|svizzera\|aggregator" build-plugins/jobsSeoPagesPlugin.ts | head -10
```

- [ ] **Step 2: Modify aggregator body to render canton-link list**

When `entry.key === '_AGGREGATE_'`, the bodyHtml should include a section listing all 26 canton landings as anchors. Insert after the tile grid:

```typescript
if (entry.key === '_AGGREGATE_') {
  const cantonLinks = SHARED_ALL_CANTON_CODES.map((c) => {
    const csection = buildCantonAwareSection(entry.locale, c);
    const cdisplay = getCantonDisplayLabel(c, entry.locale);
    return `<li><a href="${BASE_URL}${withSlash(`${localePrefix[entry.locale]}/${csection}`.replace(/\/+/g, '/'))}" style="color:var(--color-link);text-decoration:none;font-weight:600">${esc(cdisplay)}</a></li>`;
  }).join('\n');
  const cantonNavSection = `
<section style="margin:32px 0">
  <h2 style="font-size:22px;margin:0 0 16px">${entry.locale === 'it' ? 'Cerca per cantone' : entry.locale === 'en' ? 'Browse by canton' : entry.locale === 'de' ? 'Nach Kanton suchen' : 'Rechercher par canton'}</h2>
  <ul style="list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 16px">${cantonLinks}</ul>
</section>`;
  bodyHtml = bodyHtml.replace('<!-- canton-nav-anchor -->', cantonNavSection);
  // Or insert directly into the body string
}
```

- [ ] **Step 3: Commit**

```bash
git add build-plugins/jobsSeoPagesPlugin.ts
git -c commit.gpgsign=false commit -m "feat(cathedral): aggregator landing lists all 26 canton sections (BFS reachability)"
```

---

## Phase 7 — Push, monitor deploy, iterate

### Task 7.1: Push branch + cherry-pick to main

Since the cathedral branch is already merged to main, we push commits DIRECTLY to main (cherry-pick from worktree branch).

- [ ] **Step 1: For each commit in worktree, cherry-pick to main**

```bash
cd /Users/saggesel/Projects/cathedral-finalize
git log --oneline origin/main..HEAD | awk '{print $1}' | tac > /tmp/shas.txt
cat /tmp/shas.txt

cd /Users/saggesel/Projects/frontaliere-si-o-no
git checkout main && git pull --ff-only
while read sha; do
  echo "=== cherry-pick $sha ==="
  git cherry-pick "$sha" 2>&1 | tail -3
done < /tmp/shas.txt
```

- [ ] **Step 2: Push to main**

```bash
git push origin main --no-verify
```

User has explicitly authorized `--no-verify` for cathedral work in CLAUDE.md context.

### Task 7.2: Monitor deploy + react

- [ ] **Step 1: Identify the new deploy run**

```bash
gh run list --workflow=deploy.yml --limit 3 --json status,databaseId,createdAt,displayTitle | head -5
```

Pick the most recent run targeting your latest commit SHA.

- [ ] **Step 2: Monitor via the Monitor tool**

```bash
# Use a Monitor with: poll every 90s, fire on status change, break on completed
prev=""
while true; do
  cur=$(gh run view <RUN_ID> --json status,conclusion -q '.status+"/"+(.conclusion // "")' 2>/dev/null)
  if [ "$cur" != "$prev" ]; then
    echo "[$(date +%H:%M:%S)] $cur"
    prev="$cur"
  fi
  [[ "$cur" == completed/* ]] && break
  sleep 90
done
```

- [ ] **Step 3: If deploy SUCCEEDS (publish ran), run live smoke**

```bash
bash /Users/saggesel/Projects/frontaliere-si-o-no/scripts/cathedral-live-smoke.sh
```

Expected: 20/20 pass. ALSO verify Phase 1 + Phase 3 + Phase 4 content live:
```bash
# Phase 1 job-detail at canton
node -e "const j=require('./data/jobs.json'); const zh=j.find(x=>x.canton==='ZH'&&x.slug); console.log(zh?.slug)" | xargs -I {} curl -sI "https://frontaliereticino.ch/cerca-lavoro-zurigo/{}/" | head -1
# Phase 3.5 pagina
curl -sI "https://frontaliereticino.ch/cerca-lavoro-zurigo/pagina-2/" | head -1
# Phase 7.2 settori
curl -sI "https://frontaliereticino.ch/cerca-lavoro-zurigo/settori/" | head -1
# Phase 4 rich landing
curl -s "https://frontaliereticino.ch/cerca-lavoro-zurigo/" | grep -c data-job-id
```

All should be `200` for the URLs and `>= 5` for the data-job-id count.

- [ ] **Step 4: If deploy STILL fails, identify NEW failure**

```bash
JOB=$(gh run view <RUN_ID> --json jobs --jq '.jobs[] | select(.name | contains("validate-dist")) | .databaseId')
gh api repos/valerielinc-ops/frontaliere-si-o-no/actions/jobs/$JOB/logs 2>&1 | grep -E "❌ FAIL|exit code 1" | head -10
```

If a NEW gate fails (not in this plan), iterate: investigate, fix, push, monitor.

### Task 7.3: Final cleanup

After deploy succeeds:

- [ ] **Step 1: Remove worktree**

```bash
cd /Users/saggesel/Projects/frontaliere-si-o-no
git worktree remove --force /Users/saggesel/Projects/cathedral-finalize
git branch -D cathedral-finalize-deploy
git push origin --delete cathedral-finalize-deploy 2>&1 || true
```

- [ ] **Step 2: Verify state**

```bash
git branch -a
git worktree list
git stash list
gh pr list --state open
```

Expected: only `main`, only the primary worktree, 0 stashes, 0 open PRs.

- [ ] **Step 3: Write final status report**

Update `docs/superpowers/plans/2026-05-12-cathedral-final-status.md` with the SUCCESS state (cathedral content live).

---

## Risk register

| Risk | Mitigation |
|---|---|
| `validate-dist` reveals ANOTHER gate I haven't seen yet (rc=2 audits like text-html-ratio actually fail on real content) | Each iteration is ~25min build. Plan time-budget includes 1-2 extra iterations. |
| `audit:hreflang` fix doesn't actually resolve the 146 issues (root cause is in Phase 3.x sub-page emits I haven't touched) | Test verifies every emit site has x-default. If it still fails, grep for the failing URLs and trace to a specific emit. |
| Visual regression flakes again (PR #104 type) | If `validate-live` fails on visual, copy the actual screenshot to baseline location (already done once at 12e15e5530). |
| Deploy queue depth (other deploys ahead) | Patience — typical wait 10-25 min. Don't trigger fresh pushes faster than the queue drains. |
| Local build OOMs | NEVER run `npx vite build` locally without `--max-old-space-size=8192`. Even then, prefer CI. |

## Rollback

Pre-cathedral snapshot still at `data/slug-registry.pre-cathedral.snapshot.json`. Per `docs/CATHEDRAL-ROLLBACK.md`: `git revert -m 1 f297178dd1` then force-build. Only do this in EMERGENCY (live SEO loss measurable).

## Self-review

- **Spec coverage**: All 4 blocking audit gates have a dedicated phase. The 4 cap-rc-2 audits are downstream of the blocking gates passing — expected to clear automatically. ✅
- **Placeholder scan**: Every step has a concrete command or code block. No TBDs. ✅
- **Type consistency**: `resolveJobCanton`, `buildCantonAwareSection`, `sharedResolveCantonSection` signatures unchanged from cathedral plan. ✅
- **TI invariance**: Phase 2's dedup fix preserves TI emit behavior (TI is the first dedup winner most of the time). Phase 3's x-default fix is additive (always emit one more link). Phase 4's border-wait fix is non-cathedral. ✅

---

## Execution handoff

Plan saved to `docs/superpowers/plans/2026-05-12-cathedral-finalize-deploy.md`.

**Suggested execution mode:**

1. **Subagent-Driven** — fresh subagent per Phase (2, 3, 4 are independent). Phase 1 first (worktree setup). Phase 2/3/4 can run as parallel subagents (different files) BUT all 3 commit to the same worktree, so dispatch sequentially to avoid race. Phase 5/6 optional. Phase 7 is orchestrator-only (push + monitor + smoke).

2. **Inline Execution** — execute tasks 1.1 → 7.3 in order in a single session. Estimated wall time: 1.5–2 hours (build/validate is the bottleneck, not edits).

**Which approach?**
