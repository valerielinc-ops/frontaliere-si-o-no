# Traffic & Subscriptions Recovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover from the May 13 inflection point that turned a +25 % traffic / +20 % session week into a −45 % subscription collapse. Restore the job-board → newsletter funnel, fix the calculator drop-off, eliminate the 3 456-event/week JS error rate, and stop further long-tail position drift.

**Architecture:** 8 independent phases, each executed in its own git worktree per CLAUDE.md `Worktree-First Rule`. Phases 1–3 can run in parallel (no shared files). Phases 4–5 depend on the investigation output of Phase 1. Phases 6–8 are independent. Every phase produces one PR opened-and-immediately-squash-merged per CLAUDE.md `Auto-merge Rule`. No phase merges with a baseline regression.

**Tech Stack:** TypeScript / React 19 SPA + Vite 6 build plugins + Firebase Firestore + PostHog (project EU 157802) + GSC API (webmasters/v3) + Tailwind CSS 4 + Vitest 4 + Playwright (build + serve dist).

**Baseline snapshot (frozen 2026-05-18, do NOT widen):**
- GSC clicks last 7 d: 5 089 (W-1 5 547, peak day 1 027 on May 11)
- GSC avg position: 8.62 (baseline Apr 6–19: 5.70)
- Firestore newsletter_subscribers last 7 d: 164 (W-1 298)
- PostHog `app_error` rate last 30 d: 3.5 % (3 456 events)
- Calculator funnel entry → input_start: −71 % drop-off
- AdSense revenue/day: 2.99 CHF (flat for 10 d)
- CLS p75 desktop: 1.016 (Google "poor" threshold: 0.25)
- CLS p75 mobile: 0.676 (improving from 0.94 ten days ago)

Every phase ends with a metric re-check against these numbers. A phase passes only if it does not regress any baseline.

---

## Phase 0 — Master tracking issue & branch hygiene

**Files:**
- Create: `data/recovery-2026-05-18/baseline.json` (tracked — `reports/` is gitignored)
- Phase 1+ output goes to `data/recovery-2026-05-18/*.json` so it lives in the repo

- [ ] **Step 1: Open Linear master issue**

Run:
```bash
gh issue create --title "Traffic & subs recovery (May 18 plan) — master tracker" \
  --body "Master tracker for docs/superpowers/plans/2026-05-18-traffic-subs-recovery.md.

Each phase = 1 PR, opened-and-immediately-squash-merged per CLAUDE.md auto-merge rule.

Baseline: 164 subs/7d (−45% WoW), GSC 5089 clicks (−8.3% WoW), position 8.62 (baseline 5.7), CLS desktop 1.016, app_error 3.5%.

Pass criteria for closing this issue:
- subs/7d ≥ 250
- GSC position ≤ 7.5
- app_error rate ≤ 1.0%
- calc funnel entry→input_start ≥ 40%
- CLS desktop ≤ 0.5

Phases:
- [ ] Phase 1 — PostHog investigation
- [ ] Phase 2 — analytics-report URL fix
- [ ] Phase 3 — Rename-drift backfill round 2
- [ ] Phase 4 — Calculator funnel input_start fix
- [ ] Phase 5 — app_error triage & reduction
- [ ] Phase 6 — CLS desktop surgery
- [ ] Phase 7 — SEO automation moratorium policy
- [ ] Phase 8 — Final verification & retro
"
```

Expected: issue URL printed. Save it as `RECOVERY_ISSUE_URL` env var for later phase commits.

- [ ] **Step 2: Snapshot baseline JSON for diff at end**

Create `data/recovery-2026-05-18/baseline.json`:
```json
{
  "captured_at": "2026-05-18",
  "gsc_clicks_7d": 5089,
  "gsc_position_avg": 8.62,
  "subs_7d": 164,
  "subs_7d_prev": 298,
  "app_error_rate_30d_pct": 3.5,
  "app_error_count_30d": 3456,
  "calc_entry_to_input_start_pct": 29,
  "cls_p75_desktop": 1.016,
  "cls_p75_mobile": 0.676,
  "adsense_revenue_per_day_chf": 2.99,
  "ga4_sessions_7d": 11439,
  "ga4_users_7d": 10535
}
```

- [ ] **Step 3: Commit Phase 0 setup on `main` directly (no worktree needed)**

```bash
git add docs/superpowers/plans/2026-05-18-traffic-subs-recovery.md data/recovery-2026-05-18/
git commit -m "docs(recovery): May 18 master plan + baseline snapshot"
git push
```

---

## Phase 1 — PostHog investigation (data gathering, no UI changes)

**Why first:** Phases 4 and 5 need real PostHog data to write the right fix. Without it we'd guess. This phase produces two JSON reports that Phases 4/5 consume.

**Worktree:**
```bash
# Use EnterWorktree tool (preferred) or:
git worktree add ../frontaliere-recovery-p1 -b recovery/p1-investigation
cd ../frontaliere-recovery-p1
```

**Files:**
- Create: `scripts/diagnose-calc-funnel.mjs`
- Create: `scripts/diagnose-app-errors.mjs`
- Create: `data/recovery-2026-05-18/calc-funnel.json` (output)
- Create: `data/recovery-2026-05-18/app-errors.json` (output)
- Create: `data/recovery-2026-05-18/calc-funnel.md` (human summary)
- Create: `data/recovery-2026-05-18/app-errors.md` (human summary)

- [ ] **Step 1: Write `scripts/diagnose-calc-funnel.mjs`**

```javascript
#!/usr/bin/env node
// Pulls PostHog events for /calcola-stipendio funnel last 7d.
// Output: data/recovery-2026-05-18/calc-funnel.{json,md}
//
// Auth pattern: requires POSTHOG_PERSONAL_API_KEY in env (loaded via load-rc-env).
// PostHog project: EU 157802.
import { writeFileSync, mkdirSync } from 'node:fs';

const PROJECT_ID = '157802';
const API_KEY = process.env.POSTHOG_PERSONAL_API_KEY;
if (!API_KEY) throw new Error('POSTHOG_PERSONAL_API_KEY missing — run eval load-rc-env first');

const HQL = (q) => fetch(`https://eu.posthog.com/api/projects/${PROJECT_ID}/query/`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: { kind: 'HogQLQuery', query: q } }),
}).then(r => r.json());

const sevenDaysAgo = "now() - INTERVAL 7 DAY";

// Q1: drop-off per session — entry without input_start
const q1 = await HQL(`
  SELECT
    countIf(event = 'funnel_step' AND properties.step = 'entry') AS entries,
    countIf(event = 'funnel_step' AND properties.step = 'input_start') AS starts,
    countIf(event = 'funnel_step' AND properties.step = 'calculate') AS calcs
  FROM events
  WHERE timestamp >= ${sevenDaysAgo}
    AND properties.$current_url ILIKE '%/calcola-stipendio%'
`);

// Q2: what was the LAST event before users left without input_start
const q2 = await HQL(`
  WITH entry_sessions AS (
    SELECT DISTINCT $session_id
    FROM events
    WHERE timestamp >= ${sevenDaysAgo}
      AND event = 'funnel_step'
      AND properties.step = 'entry'
      AND properties.$current_url ILIKE '%/calcola-stipendio%'
  ),
  start_sessions AS (
    SELECT DISTINCT $session_id
    FROM events
    WHERE timestamp >= ${sevenDaysAgo}
      AND event = 'funnel_step'
      AND properties.step = 'input_start'
      AND properties.$current_url ILIKE '%/calcola-stipendio%'
  ),
  abandoners AS (
    SELECT $session_id FROM entry_sessions
    WHERE $session_id NOT IN (SELECT $session_id FROM start_sessions)
  )
  SELECT
    event,
    properties.$current_url AS url,
    count() AS n
  FROM events
  WHERE timestamp >= ${sevenDaysAgo}
    AND $session_id IN (SELECT $session_id FROM abandoners)
  GROUP BY event, url
  ORDER BY n DESC
  LIMIT 30
`);

// Q3: scroll depth on /calcola-stipendio for abandoners
const q3 = await HQL(`
  SELECT
    quantile(0.5)(toFloat(properties.percent)) AS p50_scroll,
    quantile(0.75)(toFloat(properties.percent)) AS p75_scroll,
    quantile(0.95)(toFloat(properties.percent)) AS p95_scroll,
    count() AS n
  FROM events
  WHERE timestamp >= ${sevenDaysAgo}
    AND event = '$pageleave'
    AND properties.$current_url ILIKE '%/calcola-stipendio%'
`);

// Q4: CLS shift per device on calc page
const q4 = await HQL(`
  SELECT
    properties.$device_type AS device,
    quantile(0.75)(toFloat(properties.web_vital_value)) AS cls_p75,
    count() AS n
  FROM events
  WHERE timestamp >= ${sevenDaysAgo}
    AND event = '$web_vitals'
    AND properties.web_vital_name = 'CLS'
    AND properties.$current_url ILIKE '%/calcola-stipendio%'
  GROUP BY device
`);

// Q5: $exception events on calc page (which JS errors block input)
const q5 = await HQL(`
  SELECT
    properties.$exception_type AS type,
    properties.$exception_message AS msg,
    properties.$exception_source AS source,
    count() AS n
  FROM events
  WHERE timestamp >= ${sevenDaysAgo}
    AND event = '$exception'
    AND properties.$current_url ILIKE '%/calcola-stipendio%'
  GROUP BY type, msg, source
  ORDER BY n DESC
  LIMIT 20
`);

const out = {
  generated: new Date().toISOString(),
  window_days: 7,
  funnel_counts: q1.results?.[0] ?? q1,
  abandoner_last_events: q2.results ?? q2,
  scroll_depth: q3.results?.[0] ?? q3,
  cls_on_calc: q4.results ?? q4,
  exceptions_on_calc: q5.results ?? q5,
};

mkdirSync('data/recovery-2026-05-18', { recursive: true });
writeFileSync('data/recovery-2026-05-18/calc-funnel.json', JSON.stringify(out, null, 2));

// Markdown summary
const md = [];
md.push('# Calculator funnel diagnosis — 7d');
md.push('');
md.push('## Funnel counts');
const fc = out.funnel_counts;
md.push(`- entries: ${fc?.[0] ?? fc?.entries}`);
md.push(`- input_start: ${fc?.[1] ?? fc?.starts}`);
md.push(`- calculate: ${fc?.[2] ?? fc?.calcs}`);
md.push('');
md.push('## Top 30 events from abandoners (entry without input_start)');
md.push('| event | url | count |');
md.push('|---|---|---|');
for (const r of out.abandoner_last_events?.slice?.(0, 30) ?? []) {
  md.push(`| ${r[0]} | ${(r[1] ?? '').slice(0,80)} | ${r[2]} |`);
}
md.push('');
md.push('## CLS p75 on calc page by device');
for (const r of out.cls_on_calc ?? []) md.push(`- ${r[0]}: p75=${r[1]} (n=${r[2]})`);
md.push('');
md.push('## Top JS exceptions on calc page');
md.push('| type | message | count |');
md.push('|---|---|---|');
for (const r of out.exceptions_on_calc?.slice?.(0, 20) ?? []) {
  md.push(`| ${r[0]} | ${(r[1] ?? '').slice(0,80)} | ${r[3]} |`);
}
writeFileSync('data/recovery-2026-05-18/calc-funnel.md', md.join('\n'));
console.log('Wrote data/recovery-2026-05-18/calc-funnel.{json,md}');
```

- [ ] **Step 2: Write `scripts/diagnose-app-errors.mjs`**

```javascript
#!/usr/bin/env node
// Pulls PostHog $exception events site-wide last 30d.
// Groups by exception_message + source URL.
// Output: data/recovery-2026-05-18/app-errors.{json,md}
import { writeFileSync, mkdirSync } from 'node:fs';

const PROJECT_ID = '157802';
const API_KEY = process.env.POSTHOG_PERSONAL_API_KEY;
if (!API_KEY) throw new Error('POSTHOG_PERSONAL_API_KEY missing');

const HQL = (q) => fetch(`https://eu.posthog.com/api/projects/${PROJECT_ID}/query/`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: { kind: 'HogQLQuery', query: q } }),
}).then(r => r.json());

const q1 = await HQL(`
  SELECT
    properties.$exception_type AS type,
    properties.$exception_message AS msg,
    properties.$exception_source AS source,
    count() AS n,
    countDistinct($session_id) AS sessions,
    any(properties.$current_url) AS sample_url
  FROM events
  WHERE timestamp >= now() - INTERVAL 30 DAY
    AND event = '$exception'
  GROUP BY type, msg, source
  ORDER BY n DESC
  LIMIT 50
`);

const q2 = await HQL(`
  SELECT
    properties.$exception_message AS msg,
    properties.$current_url AS url,
    count() AS n
  FROM events
  WHERE timestamp >= now() - INTERVAL 30 DAY
    AND event = '$exception'
  GROUP BY msg, url
  ORDER BY n DESC
  LIMIT 100
`);

const q3 = await HQL(`
  SELECT
    toDate(timestamp) AS d,
    count() AS n
  FROM events
  WHERE timestamp >= now() - INTERVAL 30 DAY
    AND event = '$exception'
  GROUP BY d
  ORDER BY d
`);

const out = {
  generated: new Date().toISOString(),
  window_days: 30,
  top_exceptions: q1.results ?? q1,
  by_url: q2.results ?? q2,
  daily: q3.results ?? q3,
};
mkdirSync('data/recovery-2026-05-18', { recursive: true });
writeFileSync('data/recovery-2026-05-18/app-errors.json', JSON.stringify(out, null, 2));

const md = ['# App error diagnosis — 30d', '', '## Top 50 by frequency', '| type | message | source | count | sessions |', '|---|---|---|---|---|'];
for (const r of out.top_exceptions?.slice?.(0,50) ?? []) {
  md.push(`| ${r[0]} | ${(r[1]??'').slice(0,80)} | ${(r[2]??'').slice(0,40)} | ${r[3]} | ${r[4]} |`);
}
md.push('', '## Daily count');
for (const r of out.daily ?? []) md.push(`- ${r[0]}: ${r[1]}`);
writeFileSync('data/recovery-2026-05-18/app-errors.md', md.join('\n'));
console.log('Wrote data/recovery-2026-05-18/app-errors.{json,md}');
```

- [ ] **Step 3: Run both diagnostics**

```bash
eval "$(GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json node scripts/load-rc-env.mjs 2>/dev/null)" \
  && node scripts/diagnose-calc-funnel.mjs \
  && node scripts/diagnose-app-errors.mjs
```

Expected: two `.json` + two `.md` written under `data/recovery-2026-05-18/`. Read both `.md` files in full before proceeding to Phase 4 and Phase 5.

- [ ] **Step 4: Commit & PR**

```bash
git add scripts/diagnose-calc-funnel.mjs scripts/diagnose-app-errors.mjs data/recovery-2026-05-18/calc-funnel.* data/recovery-2026-05-18/app-errors.*
git commit -m "diag(recovery): PostHog calc-funnel + app-errors snapshots (Phase 1)"
git push -u origin recovery/p1-investigation
gh pr create --fill
PR=$(gh pr list --head recovery/p1-investigation --json number -q '.[0].number')
gh pr merge $PR --squash
git push origin --delete recovery/p1-investigation
```

Then `ExitWorktree` with `action: remove, discard_changes: true`.

---

## Phase 2 — `analytics-report.mjs` URL inspection bug

**Why:** The May 18 run reported "17/21 key pages noindex". False alarm: it inspects no-slash URLs which are bridge redirects (legitimately noindex). Fix: always inspect the trailing-slash canonical.

**Worktree:** `git worktree add ../frontaliere-recovery-p2 -b recovery/p2-analytics-url-fix`

**Files:**
- Modify: `scripts/analytics-report.mjs` (around line 3948 — the urlInspection block)
- Test: `tests/scripts/analytics-report-url-normalize.test.ts`

- [ ] **Step 1: Locate the inspection list**

```bash
grep -n "urlInspection\|inspectionUrl\|inspect:inspect" scripts/analytics-report.mjs
```

Expected: line ~3948 calls `https://searchconsole.googleapis.com/v1/urlInspection/index:inspect`. Read 30 lines above to find the URL list construction.

- [ ] **Step 2: Write failing test**

Create `tests/scripts/analytics-report-url-normalize.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { normalizeInspectionUrl } from '@/scripts/lib/url-normalize';

describe('normalizeInspectionUrl', () => {
  it('adds trailing slash to top-level paths', () => {
    expect(normalizeInspectionUrl('https://frontaliereticino.ch/cerca-lavoro-ticino'))
      .toBe('https://frontaliereticino.ch/cerca-lavoro-ticino/');
  });
  it('keeps trailing slash if present', () => {
    expect(normalizeInspectionUrl('https://frontaliereticino.ch/guida-frontaliere/'))
      .toBe('https://frontaliereticino.ch/guida-frontaliere/');
  });
  it('preserves the root', () => {
    expect(normalizeInspectionUrl('https://frontaliereticino.ch/'))
      .toBe('https://frontaliereticino.ch/');
  });
  it('does not add slash to URLs ending in a file extension', () => {
    expect(normalizeInspectionUrl('https://frontaliereticino.ch/sitemap.xml'))
      .toBe('https://frontaliereticino.ch/sitemap.xml');
  });
  it('preserves query string while normalizing path', () => {
    expect(normalizeInspectionUrl('https://frontaliereticino.ch/cerca-lavoro-ticino?q=foo'))
      .toBe('https://frontaliereticino.ch/cerca-lavoro-ticino/?q=foo');
  });
});
```

- [ ] **Step 3: Run failing test**

```bash
npx vitest run tests/scripts/analytics-report-url-normalize.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Create helper**

Create `scripts/lib/url-normalize.mjs`:
```javascript
/**
 * Normalize a frontaliere URL for GSC URL Inspection API.
 * All top-level routes are emitted with trailing slash in dist/ (and
 * the no-slash variant is a bridge with noindex,follow). Inspecting
 * the no-slash variant returns "Excluded by noindex tag" — a false
 * negative. Always inspect the canonical (trailing-slash) form.
 */
export function normalizeInspectionUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').pop();
    const hasExtension = last && /\.[a-z0-9]+$/i.test(last);
    if (!u.pathname.endsWith('/') && !hasExtension) {
      u.pathname += '/';
    }
    return u.toString();
  } catch {
    return url;
  }
}
```

Also create the `.ts` re-export so the test alias resolves:
`scripts/lib/url-normalize.ts`:
```typescript
export { normalizeInspectionUrl } from './url-normalize.mjs';
```

- [ ] **Step 5: Re-run test**

```bash
npx vitest run tests/scripts/analytics-report-url-normalize.test.ts
```

Expected: PASS all 5.

- [ ] **Step 6: Wire helper into `analytics-report.mjs`**

In `scripts/analytics-report.mjs`, around the `urlInspection/index:inspect` POST, find the line that constructs `inspectionUrl` (or builds the body). Replace it with:
```javascript
import { normalizeInspectionUrl } from './lib/url-normalize.mjs';
// ...
const inspectionUrl = normalizeInspectionUrl(rawUrl);
```

(Adjust import location to top of file; use exact variable name found in step 1.)

- [ ] **Step 7: Smoke-test the fixed script**

```bash
eval "$(GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json node scripts/load-rc-env.mjs 2>/dev/null)" \
  && GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
     node scripts/analytics-report.mjs --gsc --indexing --days 7 2>&1 | grep -A 25 "Ispezione URL"
```

Expected: the previously "🟡 Excluded by noindex" pages now show "✅ Submitted and indexed".

- [ ] **Step 8: Commit & merge**

```bash
git add scripts/analytics-report.mjs scripts/lib/url-normalize.* tests/scripts/analytics-report-url-normalize.test.ts
git commit -m "fix(analytics): inspect trailing-slash canonical URLs (no false noindex)"
git push -u origin recovery/p2-analytics-url-fix
gh pr create --fill
PR=$(gh pr list --head recovery/p2-analytics-url-fix --json number -q '.[0].number')
gh pr merge $PR --squash
git push origin --delete recovery/p2-analytics-url-fix
```

ExitWorktree.

---

## Phase 3 — Rename-drift backfill round 2

**Why:** Per-page click diff shows ≥10 job URLs that lost 50–115 clicks/week going to 0 between W-1 and W0 (Lidl Cadenazzo `-60-80-`, Aldi-Suisse `…-elf-landern…`, Denner Flims-Dorf, LIS Lugano, EOC, biblioteca cantonale). PR #161 backfilled 358 historical cases on May 13 but ≥10 fresh casualties appeared after. Either (a) the backfill missed crawlers that don't expose stable IDs, or (b) new renames have happened since May 13.

**Worktree:** `git worktree add ../frontaliere-recovery-p3 -b recovery/p3-rename-drift-round2`

**Files:**
- Read: `scripts/lib/job-match-key.mjs` (existing)
- Read: `scripts/backfill-renamed-slugs-from-history.mjs` (existing)
- Create: `scripts/audit-rename-drift-since.mjs` (new — detect new drift since a date)
- Create: `data/recovery-2026-05-18/rename-drift-round2.json`
- Modify: data files under `data/` only if drift is found (committed separately)

- [ ] **Step 1: Detect fresh drift since May 12**

Create `scripts/audit-rename-drift-since.mjs`:
```javascript
#!/usr/bin/env node
// Walk git history of data/jobs.json (or per-crawler slices in data/jobs-*.json)
// since a given date. For each job whose URL keyed by stable-id appears under
// different slugs across commits, record the rename chain.
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { extractStableJobId } from './lib/job-match-key.mjs';

const SINCE = process.argv[2] || '2026-05-12';
const repo = process.cwd();

function gitLog(file, since) {
  return execSync(`git log --since="${since}" --pretty=format:"%H %ci" -- "${file}"`, { cwd: repo, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean).map(l => l.split(' ')[0]);
}

function jobsAtCommit(file, sha) {
  try {
    const json = execSync(`git show ${sha}:${file}`, { cwd: repo, encoding: 'utf8' });
    return JSON.parse(json);
  } catch { return null; }
}

const driftBySource = {};

// Discover all crawler slices
const sliceFiles = execSync('git ls-files data/jobs*.json data/jobs/*.json', { cwd: repo, encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);

for (const file of sliceFiles) {
  const shas = gitLog(file, SINCE);
  if (shas.length < 2) continue;
  const byStableId = new Map(); // stableId -> [{sha, slug, url}]
  for (const sha of shas) {
    const arr = jobsAtCommit(file, sha);
    if (!Array.isArray(arr)) continue;
    for (const job of arr) {
      const sid = extractStableJobId(job.url);
      if (!sid) continue;
      const slug = (job.slug || job.url || '').split('/').pop();
      const entry = { sha, slug, url: job.url };
      if (!byStableId.has(sid)) byStableId.set(sid, []);
      const arrFor = byStableId.get(sid);
      if (!arrFor.find(e => e.slug === slug)) arrFor.push(entry);
    }
  }
  const drifted = [...byStableId.entries()].filter(([, entries]) => entries.length > 1);
  if (drifted.length) {
    driftBySource[file] = drifted.map(([sid, entries]) => ({ stableId: sid, slugs: entries.map(e => e.slug) }));
  }
}

mkdirSync('data/recovery-2026-05-18', { recursive: true });
writeFileSync('data/recovery-2026-05-18/rename-drift-round2.json',
  JSON.stringify({ since: SINCE, generated: new Date().toISOString(), sources: driftBySource }, null, 2));
console.log(`Found drift in ${Object.keys(driftBySource).length} crawler slices since ${SINCE}`);
for (const [file, drifts] of Object.entries(driftBySource)) {
  console.log(`  ${file}: ${drifts.length} jobs`);
}
```

- [ ] **Step 2: Run audit**

```bash
node scripts/audit-rename-drift-since.mjs 2026-05-12 2>&1 | tee /tmp/drift-audit.log
```

Expected: prints N crawler slices with drift count. Read `data/recovery-2026-05-18/rename-drift-round2.json`.

- [ ] **Step 3: Branch on findings**

**Case A — drift found (likely):** proceed to Step 4.
**Case B — no drift found:** the W0 click losses were caused by *vendor delisting* not rename-drift. Skip to Step 6 to document.

- [ ] **Step 4: Re-run existing backfill scoped to those slices**

```bash
node scripts/backfill-renamed-slugs-from-history.mjs --since 2026-05-12 --commit-summary 2>&1 | tee /tmp/drift-backfill.log
```

Expected: log lists slices updated with `previousSlugsByLocale` entries. If the existing script does not support `--since`, read its source and extend it (TDD: write a failing unit test in `tests/scripts/backfill-renamed-slugs.test.ts` that asserts only post-2026-05-12 SHAs are considered, then add the flag).

- [ ] **Step 5: Hardened-key sweep for any crawler still using URL-key**

```bash
grep -rln "jobMatchKey.*String(job.url)\|jobMatchKey:.*url.toLowerCase" scripts/*.mjs 2>/dev/null
```

For each match, replace the body with:
```javascript
jobMatchKey: (job) => extractStableJobId(job.url) || String(job.url).toLowerCase(),
```
and add `import { extractStableJobId } from './lib/job-match-key.mjs';` at the top.

- [ ] **Step 6: Commit & merge**

```bash
git add scripts/audit-rename-drift-since.mjs data/recovery-2026-05-18/rename-drift-round2.json data/
git commit -m "fix(crawlers): rename-drift round 2 — backfill + hardened jobMatchKey on remaining crawlers"
git push -u origin recovery/p3-rename-drift-round2
gh pr create --fill
PR=$(gh pr list --head recovery/p3-rename-drift-round2 --json number -q '.[0].number')
gh pr merge $PR --squash
git push origin --delete recovery/p3-rename-drift-round2
```

ExitWorktree.

- [ ] **Step 7: Re-verify W0 losers post-deploy**

24 h after merge, re-run the per-page click diff (the inline GSC script from the diagnosis session). Expected: the 10 zero-click URLs either (a) recover clicks under their new slug because the bridge page redirects, or (b) stay at 0 only if they were actual vendor delistings.

---

## Phase 4 — Calculator funnel: input_start drop fix

**Why:** 71 % drop from `entry` to `input_start` on `/calcola-stipendio`. Either CLS shifts the form off-screen, an exception blocks the first `onChange`, or the first input is below mobile fold.

**Prerequisite:** `data/recovery-2026-05-18/calc-funnel.md` exists (Phase 1 output).

**Worktree:** `git worktree add ../frontaliere-recovery-p4 -b recovery/p4-calc-funnel-input-start`

**Files (likely):**
- Modify: `components/calculator/InputCard.tsx` (line 276 fires `input_start`)
- Modify: `components/tabs/CalcolatoreTabContent.tsx` (parent layout)
- Modify: `services/analytics.ts` (line 1657, funnel_step normalization)
- Create: `tests/components/calculator/InputCard-input-start.test.tsx`
- Create: `tests/e2e/calculator-input-start.spec.ts` (Playwright)

- [ ] **Step 1: Read the Phase 1 calc-funnel report**

```bash
cat data/recovery-2026-05-18/calc-funnel.md
```

Identify which of these patterns holds (write the matching pattern letter into a sticky note at top of the worktree):

- **Pattern A — JS exception blocks first onChange:** `exceptions_on_calc` shows ≥50 events of TypeError/ReferenceError on calc page.
- **Pattern B — CLS shifts form below fold:** `cls_on_calc` desktop p75 > 0.8 or mobile p75 > 0.5.
- **Pattern C — scroll-depth proves form is off-screen:** `scroll_depth.p50_scroll < 30` for abandoners — they leave before scrolling past hero.
- **Pattern D — abandoner_last_events shows a click on `/calcola-stipendio/<something-else>`:** users are routed to a sibling page (a recent SEO landing intercepting the route).

- [ ] **Step 2: Write failing test for the input_start event firing**

Create `tests/components/calculator/InputCard-input-start.test.tsx`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InputCard } from '@/components/calculator/InputCard';
import * as Analytics from '@/services/analytics';

describe('InputCard input_start funnel event', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fires input_start funnel_step on first field interaction', () => {
    const spy = vi.spyOn(Analytics.Analytics, 'trackFunnelStep');
    render(<InputCard onSubmit={() => {}} />);
    const salary = screen.getByLabelText(/salario|stipendio.*lordo/i);
    fireEvent.change(salary, { target: { value: '6000' } });
    expect(spy).toHaveBeenCalledWith('input_start', expect.objectContaining({ funnel: 'calculator' }));
  });

  it('fires input_start only once per session', () => {
    const spy = vi.spyOn(Analytics.Analytics, 'trackFunnelStep');
    render(<InputCard onSubmit={() => {}} />);
    const salary = screen.getByLabelText(/salario|stipendio.*lordo/i);
    fireEvent.change(salary, { target: { value: '6000' } });
    fireEvent.change(salary, { target: { value: '7000' } });
    const startCalls = spy.mock.calls.filter(c => c[0] === 'input_start');
    expect(startCalls).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run test — confirm current state**

```bash
npx vitest run tests/components/calculator/InputCard-input-start.test.tsx
```

If FAIL: the firing logic is broken (highest-likelihood root cause). Continue to Step 4 in Pattern A/B/C/D branch.
If PASS: the event fires correctly — the abandonment is upstream (CLS / route / exception). Skip to the matching pattern.

- [ ] **Step 4 — Pattern-specific fix (apply only the matching pattern's fix):**

**Pattern A (JS exception):**
1. Identify the top exception from `calc-funnel.md`.
2. Read the file in `properties.$exception_source`.
3. Wrap the throwing call in a try/catch with a fallback. Example skeleton if exception is in salary parsing:
   ```typescript
   // components/calculator/InputCard.tsx
   const safeParseNumber = (raw: string): number => {
     try {
       const n = Number(raw.replace(/[^0-9.]/g, ''));
       return Number.isFinite(n) ? n : 0;
     } catch {
       return 0;
     }
   };
   ```
4. Add the matching unit test that reproduces the exact exception input, then verify the fix.

**Pattern B (CLS shift):**
1. Reserve dimensions on the form container — replace `<div className="…">` wrapping the calculator with `<div className="… min-h-[640px] md:min-h-[480px]">` to lock height.
2. For any image inside the calc hero, add explicit `width`/`height` per `index.css` enforcement rule.
3. Add Playwright assertion in `tests/e2e/calculator-input-start.spec.ts`:
   ```typescript
   import { test, expect } from '@playwright/test';
   test('calculator hero has stable height — no CLS shift', async ({ page }) => {
     await page.goto('http://localhost:4173/calcola-stipendio/');
     const card = page.locator('[data-testid="calculator-input-card"]');
     const box1 = await card.boundingBox();
     await page.waitForTimeout(2000);
     const box2 = await card.boundingBox();
     expect(Math.abs(box1!.y - box2!.y)).toBeLessThan(8);
   });
   ```
4. Add `data-testid="calculator-input-card"` to the root element of `InputCard.tsx`.

**Pattern C (below fold on mobile):**
1. Move the salary field to the very top of `InputCard.tsx`; demote any editorial intro (per CLAUDE.md rule #16 — filler below content).
2. Wrap any AI-generated intro in `<details>`:
   ```tsx
   <details className="mt-8">
     <summary className="cursor-pointer text-sm text-link">Leggi di più sul calcolo</summary>
     {intro}
   </details>
   ```
3. Playwright: assert salary input is in viewport at iPhone-13 viewport (390×844):
   ```typescript
   test('salary input is above the fold on mobile', async ({ page }) => {
     await page.setViewportSize({ width: 390, height: 844 });
     await page.goto('http://localhost:4173/calcola-stipendio/');
     const input = page.getByLabel(/salario|stipendio.*lordo/i);
     await expect(input).toBeInViewport();
   });
   ```

**Pattern D (route intercept):**
1. Read `services/router.ts`. Find any recent SEO-landing route added under `/calcola-stipendio/<slug>` between 2026-05-08 and 2026-05-18.
2. If a route matches the broad pattern and lands on a static-overlay page, verify it has a clear back-CTA to `/calcola-stipendio/` and a `data-static-overlay-source="…"` for analytics. Re-attribute the funnel: emit `funnel_step: 'entry'` from the overlay too if it counts as a calc-page entry.

- [ ] **Step 5: Re-run unit + E2E tests**

```bash
npx vitest run tests/components/calculator/InputCard-input-start.test.tsx
FAST_BUILD= npx vite build && npx serve dist -p 4173 &
SERVER_PID=$!
sleep 5
npx playwright test tests/e2e/calculator-input-start.spec.ts
kill $SERVER_PID
```

Expected: all PASS.

- [ ] **Step 6: Local Lighthouse spot-check**

```bash
npx serve dist -p 4173 &
sleep 5
npx lighthouse http://localhost:4173/calcola-stipendio/ --only-categories=performance --form-factor=desktop --output=json --output-path=/tmp/lh-calc.json --quiet
node -e "const r=require('/tmp/lh-calc.json'); console.log('CLS:', r.audits['cumulative-layout-shift'].numericValue, 'LCP:', r.audits['largest-contentful-paint'].numericValue/1000+'s')"
kill %1
```

Expected: CLS < 0.1 (target), LCP < 2.5 s.

- [ ] **Step 7: Commit & merge**

```bash
git add components/calculator/ tests/components/calculator/ tests/e2e/calculator-input-start.spec.ts
git commit -m "fix(calculator): restore input_start funnel by <pattern X> (Phase 4)"
git push -u origin recovery/p4-calc-funnel-input-start
gh pr create --fill
PR=$(gh pr list --head recovery/p4-calc-funnel-input-start --json number -q '.[0].number')
gh pr merge $PR --squash
git push origin --delete recovery/p4-calc-funnel-input-start
```

ExitWorktree.

- [ ] **Step 8: 48 h post-deploy verification**

Re-run `scripts/diagnose-calc-funnel.mjs`. Pass criterion: `input_start / entry ≥ 0.40` (was 0.29).

---

## Phase 5 — App error rate reduction

**Why:** 3.5 % of all sessions throw a `$exception` (3 456 events/30 d). Per `feedback_speed_only_no_behavior_change`, fixing these has zero behavior change for healthy sessions.

**Prerequisite:** `data/recovery-2026-05-18/app-errors.md` exists (Phase 1).

**Worktree:** `git worktree add ../frontaliere-recovery-p5 -b recovery/p5-app-errors`

**Files (likely):**
- Modify: 1–5 source files identified by the report
- Create: `tests/services/<matching>.test.ts` per fix
- Modify: `services/analytics.ts` — add `app_error` filter to suppress benign noise (per `project_posthog_exceptions_apr20` memory which already documented 95 % is noise)

- [ ] **Step 1: Read the report**

```bash
cat data/recovery-2026-05-18/app-errors.md | head -60
```

- [ ] **Step 2: Filter known-benign noise at the source**

Per memory: 95 % is cross-origin scripts, IDB close, ResizeObserver loop. Add an early-return filter in PostHog beforeSend.

Find `services/analytics.ts` PostHog init. Add a `before_send` hook:
```typescript
// services/analytics.ts — near posthog.init(...)
posthog.init(KEY, {
  // ... existing config ...
  before_send: (event) => {
    if (event?.event !== '$exception') return event;
    const msg = String(event.properties?.$exception_message ?? '');
    const src = String(event.properties?.$exception_source ?? '');
    const benign = [
      /ResizeObserver loop/i,
      /Script error\.?$/i,
      /Non-Error promise rejection/i,
      /UnknownError.*IDBDatabase/i,
      /AbortError.*signal is aborted/i,
    ];
    if (benign.some((re) => re.test(msg))) return null;
    if (src && /(googletagmanager|googlesyndication|doubleclick|gstatic)/.test(src)) return null;
    return event;
  },
});
```

- [ ] **Step 3: Write failing test for the filter**

Create `tests/services/posthog-error-filter.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { createExceptionFilter } from '@/services/posthog-error-filter';

const filter = createExceptionFilter();

describe('PostHog exception filter', () => {
  it('drops ResizeObserver loop noise', () => {
    expect(filter({ event: '$exception', properties: { $exception_message: 'ResizeObserver loop limit exceeded' } })).toBeNull();
  });
  it('drops Script error from cross-origin', () => {
    expect(filter({ event: '$exception', properties: { $exception_message: 'Script error.' } })).toBeNull();
  });
  it('drops third-party ad scripts', () => {
    expect(filter({ event: '$exception', properties: { $exception_message: 'Cannot read x', $exception_source: 'https://pagead2.googlesyndication.com/x.js' } })).toBeNull();
  });
  it('keeps our app errors', () => {
    const e = { event: '$exception', properties: { $exception_message: 'Cannot read properties of null (reading "id")', $exception_source: '/assets/index-abc.js' } };
    expect(filter(e)).toBe(e);
  });
  it('passes through non-exception events', () => {
    const e = { event: 'page_view' };
    expect(filter(e)).toBe(e);
  });
});
```

- [ ] **Step 4: Extract filter to its own module**

Create `services/posthog-error-filter.ts`:
```typescript
const BENIGN_MESSAGES = [
  /ResizeObserver loop/i,
  /Script error\.?$/i,
  /Non-Error promise rejection/i,
  /UnknownError.*IDBDatabase/i,
  /AbortError.*signal is aborted/i,
];
const THIRD_PARTY_SOURCES = /(googletagmanager|googlesyndication|doubleclick|gstatic|adservice\.google)/;

export function createExceptionFilter() {
  return function filter(event: any): any | null {
    if (event?.event !== '$exception') return event;
    const msg = String(event.properties?.$exception_message ?? '');
    const src = String(event.properties?.$exception_source ?? '');
    if (BENIGN_MESSAGES.some((re) => re.test(msg))) return null;
    if (src && THIRD_PARTY_SOURCES.test(src)) return null;
    return event;
  };
}
```

Update `services/analytics.ts` to import + use `createExceptionFilter()` in `before_send`.

- [ ] **Step 5: Run test, expect green**

```bash
npx vitest run tests/services/posthog-error-filter.test.ts
```

Expected: 5 PASS.

- [ ] **Step 6: Fix the top non-benign exception in the report**

Open the top remaining row of `app-errors.md` (the first one not matched by the benign regexes). Open the file in `$exception_source`. Identify the throwing line. Write a Vitest unit test reproducing the input that throws. Apply minimal fix. Re-run test green.

Repeat for any exception above 100 events / 30 d.

- [ ] **Step 7: Commit & merge**

```bash
git add services/posthog-error-filter.ts services/analytics.ts tests/services/
git commit -m "fix(observability): filter benign exceptions + fix top app_error roots (Phase 5)"
git push -u origin recovery/p5-app-errors
gh pr create --fill
PR=$(gh pr list --head recovery/p5-app-errors --json number -q '.[0].number')
gh pr merge $PR --squash
git push origin --delete recovery/p5-app-errors
```

ExitWorktree.

- [ ] **Step 8: 7-day post-deploy verification**

Re-run `scripts/diagnose-app-errors.mjs`. Pass criterion: total `$exception` events/7 d ≤ 200 (was 806/7 d ≈ 3 456/30 d).

---

## Phase 6 — CLS desktop surgery

**Why:** Desktop CLS p75 = 1.016, unchanged for 10 d, 4× Google "poor" threshold. Blocks AdSense bid + co-cause of calculator drop.

**Worktree:** `git worktree add ../frontaliere-recovery-p6 -b recovery/p6-cls-desktop`

**Files:**
- Modify: top 3 layout shifters identified by audit
- Create: `tests/e2e/cls-desktop-budget.spec.ts`

- [ ] **Step 1: Identify the top 3 shifters via PostHog Web Vitals**

Create temp script `scripts/_tmp_cls_top.mjs`:
```javascript
const API_KEY = process.env.POSTHOG_PERSONAL_API_KEY;
const r = await fetch('https://eu.posthog.com/api/projects/157802/query/', {
  method: 'POST',
  headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: { kind: 'HogQLQuery', query: `
    SELECT
      properties.$current_url AS url,
      quantile(0.75)(toFloat(properties.web_vital_value)) AS cls_p75,
      count() AS n
    FROM events
    WHERE timestamp >= now() - INTERVAL 7 DAY
      AND event = '$web_vitals'
      AND properties.web_vital_name = 'CLS'
      AND properties.$device_type = 'Desktop'
      AND toFloat(properties.web_vital_value) > 0.25
    GROUP BY url
    ORDER BY n DESC
    LIMIT 10
  ` } }),
}).then(x=>x.json());
console.log(JSON.stringify(r.results, null, 2));
```

```bash
eval "$(GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json node scripts/load-rc-env.mjs 2>/dev/null)" \
  && node scripts/_tmp_cls_top.mjs > data/recovery-2026-05-18/cls-top.json
rm scripts/_tmp_cls_top.mjs
```

- [ ] **Step 2: For each of the top 3 URLs, open the page in Chrome DevTools Performance Insights**

For each URL:
1. `npx serve dist -p 4173` (assumes recent build in dist/)
2. Open Chrome → DevTools → Performance Insights → Record → reload
3. Note the top "Layout Shift" entry's element selector
4. Most common roots:
   - **AdSense slot inflating after load** → reserve fixed height with `min-height: 280px`
   - **Web font swap (FOUT/FOIT)** → ensure `font-display: swap` + `size-adjust` in `index.css`
   - **Late-mounted nav/footer** → reserve `min-height` on `<header>`/`<footer>` placeholders
   - **Image without dimensions** → add `width`/`height` attributes per CLAUDE.md rule

- [ ] **Step 3: Apply reservations for each shifter**

Example for AdSense slot in `components/ads/AdSlot.tsx`:
```tsx
<ins
  className="adsbygoogle"
  style={{ display: 'block', minHeight: 280 }} // reserve height pre-fill
  data-ad-client="ca-pub-XXX"
  data-ad-slot={slotId}
  data-ad-format="auto"
  data-full-width-responsive="true"
/>
```

(Apply only to slots actually triggering CLS — do not blanket reserve.)

- [ ] **Step 4: Add a CLS-budget E2E test**

Create `tests/e2e/cls-desktop-budget.spec.ts`:
```typescript
import { test, expect } from '@playwright/test';

const CRITICAL = [
  '/',
  '/calcola-stipendio/',
  '/cerca-lavoro-ticino/',
  '/articoli-frontaliere/',
];

for (const path of CRITICAL) {
  test(`CLS budget < 0.25 desktop on ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const cls = await page.evaluate(() => new Promise<number>((resolve) => {
      let total = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as any[]) {
          if (!entry.hadRecentInput) total += entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
      setTimeout(() => resolve(total), 4000);
    }));
    await page.goto(`http://localhost:4173${path}`);
    await page.waitForLoadState('networkidle');
    expect(cls).toBeLessThan(0.25);
  });
}
```

- [ ] **Step 5: Run E2E**

```bash
FAST_BUILD= npx vite build
npx serve dist -p 4173 &
sleep 5
npx playwright test tests/e2e/cls-desktop-budget.spec.ts
kill %1
```

Expected: 4 PASS.

- [ ] **Step 6: Commit & merge**

```bash
git add components/ads/ index.css tests/e2e/cls-desktop-budget.spec.ts data/recovery-2026-05-18/cls-top.json
git commit -m "fix(cls): reserve heights on top 3 desktop shifters + E2E budget guard"
git push -u origin recovery/p6-cls-desktop
gh pr create --fill
PR=$(gh pr list --head recovery/p6-cls-desktop --json number -q '.[0].number')
gh pr merge $PR --squash
git push origin --delete recovery/p6-cls-desktop
```

ExitWorktree.

- [ ] **Step 7: 7-day post-deploy verification**

Re-run revenue-monitor. Pass criterion: `cls_p75_desktop ≤ 0.5` and `cls_p75_mobile ≤ 0.4`.

---

## Phase 7 — SEO automation moratorium

**Why:** GSC avg position drifted 5.7 → 8.62 in 4 weeks. Every new SEO landing dilutes the average. Per memory `project_monetization_gap_may8` root cause #1 (35 % weight), the long-tail dilution is the primary structural problem.

**Worktree:** `git worktree add ../frontaliere-recovery-p7 -b recovery/p7-seo-moratorium`

**Files:**
- Modify: `CLAUDE.md` (add a moratorium block)
- Create: `scripts/check-seo-moratorium.mjs` (CI gate)
- Modify: `.github/workflows/deploy.yml` (call the check)

- [ ] **Step 1: Add CLAUDE.md non-negotiable rule #19**

Append after rule #18 in `CLAUDE.md`:
```markdown
19. **SEO automation moratorium until position ≤ 7.5.** No new build-plugin-emitted SEO landings (new entries under `build-plugins/*Landing*.ts`, `*Pages.ts`, `*Hub.ts` or expansion of existing emitters to new keywords/cantons/categories) may be merged while `data/gsc-position-rolling.json` shows 7-day avg position > 7.5. Exceptions: bug fixes to existing landings, structural improvements that REDUCE page count (consolidation), redirect emitters. Rationale: long-tail dilution drove avg position 5.7 → 8.62 in 4 weeks. CI gate: `scripts/check-seo-moratorium.mjs` enforces this in `deploy.yml`.
```

- [ ] **Step 2: Write the position-rolling fetcher**

Create `scripts/refresh-gsc-position-rolling.mjs`:
```javascript
#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

async function getToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GSC_CLIENT_ID,
      client_secret: process.env.GSC_CLIENT_SECRET,
      refresh_token: process.env.GSC_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  return (await r.json()).access_token;
}
const token = await getToken();
const site = encodeURIComponent('sc-domain:frontaliereticino.ch');
const today = new Date(); const fmt = (d) => d.toISOString().slice(0,10);
const start = new Date(today); start.setDate(start.getDate()-9);
const end = new Date(today); end.setDate(end.getDate()-2);
const r = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ startDate: fmt(start), endDate: fmt(end), dimensions: ['date'], rowLimit: 7 }),
});
const data = await r.json();
const rows = data.rows || [];
const avg = rows.reduce((a,x)=>a+x.position,0)/Math.max(1,rows.length);
writeFileSync('data/gsc-position-rolling.json', JSON.stringify({
  generated: new Date().toISOString(),
  window: { start: fmt(start), end: fmt(end) },
  avg_position: avg,
  daily: rows.map(r => ({ date: r.keys[0], position: r.position, clicks: r.clicks })),
}, null, 2));
console.log(`GSC 7-day avg position: ${avg.toFixed(2)}`);
```

- [ ] **Step 3: Write the moratorium check**

Create `scripts/check-seo-moratorium.mjs`:
```javascript
#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const THRESHOLD = 7.5;
const rolling = JSON.parse(readFileSync('data/gsc-position-rolling.json', 'utf8'));
if (rolling.avg_position <= THRESHOLD) {
  console.log(`Moratorium not active: avg_position ${rolling.avg_position.toFixed(2)} ≤ ${THRESHOLD}`);
  process.exit(0);
}

// Moratorium active — check the diff for forbidden new emitters
const base = process.env.GITHUB_BASE_REF || 'main';
const diff = execSync(`git diff --name-status origin/${base}...HEAD`, { encoding: 'utf8' });
const forbidden = diff.split('\n').filter(l =>
  l.startsWith('A\t') && /build-plugins\/.+(Landing|Pages|Hub)\.ts$/.test(l.split('\t')[1])
);
if (forbidden.length) {
  console.error(`Moratorium active (avg position ${rolling.avg_position.toFixed(2)} > ${THRESHOLD}).`);
  console.error('The following new SEO-landing files are blocked:');
  for (const f of forbidden) console.error(`  ${f}`);
  console.error('See CLAUDE.md rule #19.');
  process.exit(1);
}
console.log(`Moratorium active but no new SEO landing files added — OK.`);
```

- [ ] **Step 4: Vitest unit test for the check logic**

Create `tests/scripts/check-seo-moratorium.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('check-seo-moratorium', () => {
  it('exits 0 when avg_position ≤ 7.5', () => {
    writeFileSync('data/gsc-position-rolling.json',
      JSON.stringify({ avg_position: 6.5, window: { start: 'x', end: 'y' }, daily: [] }));
    const r = spawnSync('node', ['scripts/check-seo-moratorium.mjs'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
  });
  // Note: the > 7.5 case is exercised by an integration test in CI, since it
  // depends on the actual git diff state.
});
```

- [ ] **Step 5: Wire into `deploy.yml`**

In `.github/workflows/deploy.yml`, find the job that runs gates. Add a step BEFORE the build:
```yaml
      - name: SEO moratorium check
        if: github.event_name == 'pull_request'
        env:
          GSC_CLIENT_ID:     ${{ secrets.GSC_CLIENT_ID }}
          GSC_CLIENT_SECRET: ${{ secrets.GSC_CLIENT_SECRET }}
          GSC_REFRESH_TOKEN: ${{ secrets.GSC_REFRESH_TOKEN }}
        run: |
          node scripts/refresh-gsc-position-rolling.mjs
          node scripts/check-seo-moratorium.mjs
```

- [ ] **Step 6: Commit & merge**

```bash
git add CLAUDE.md scripts/check-seo-moratorium.mjs scripts/refresh-gsc-position-rolling.mjs tests/scripts/check-seo-moratorium.test.ts .github/workflows/deploy.yml
git commit -m "policy(seo): moratorium until avg position ≤ 7.5 (CLAUDE.md #19 + CI gate)"
git push -u origin recovery/p7-seo-moratorium
gh pr create --fill
PR=$(gh pr list --head recovery/p7-seo-moratorium --json number -q '.[0].number')
gh pr merge $PR --squash
git push origin --delete recovery/p7-seo-moratorium
```

ExitWorktree.

- [ ] **Step 7: Run the workflow live**

Per CLAUDE.md rule #13, every new workflow step must run live post-merge:
```bash
gh workflow run deploy.yml --ref main
sleep 30
RUN=$(gh run list --workflow=deploy.yml --branch=main --limit=1 --json databaseId -q '.[0].databaseId')
gh run view $RUN --log | grep -A 5 "SEO moratorium check"
```

Expected: log shows current avg position printed, exit 0 (no new landings in diff).

---

## Phase 8 — Final verification & retro

**Worktree:** `git worktree add ../frontaliere-recovery-p8 -b recovery/p8-final-retro`

**Files:**
- Create: `data/recovery-2026-05-18/final.md`
- Create: `data/recovery-2026-05-18/final.json`

- [ ] **Step 1: Wait 7 days from Phase 6 merge** for metrics to stabilize.

- [ ] **Step 2: Re-snapshot all baseline metrics**

```bash
eval "$(GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json node scripts/load-rc-env.mjs 2>/dev/null)"
GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json node scripts/revenue-monitor.mjs --save --markdown
node scripts/diagnose-calc-funnel.mjs
node scripts/diagnose-app-errors.mjs
# Subscriptions trend (re-run the ad-hoc script from the diagnosis session)
```

- [ ] **Step 3: Write `data/recovery-2026-05-18/final.md`** with side-by-side baseline vs current

```markdown
# Recovery final report — <date>

| Metric | Baseline 2026-05-18 | Current | Δ | Target | Pass? |
|---|---:|---:|---:|---:|:--:|
| GSC clicks /7d | 5089 | … | … | ≥ 5500 | … |
| GSC position | 8.62 | … | … | ≤ 7.5 | … |
| Subs /7d | 164 | … | … | ≥ 250 | … |
| app_error rate | 3.5% | … | … | ≤ 1.0% | … |
| Calc entry→input_start | 29% | … | … | ≥ 40% | … |
| CLS p75 desktop | 1.016 | … | … | ≤ 0.5 | … |
| AdSense CHF/day | 2.99 | … | … | ≥ 4.50 | … |

## What worked
- …

## What didn't
- …

## Carry-forward TODOs
- …
```

- [ ] **Step 4: Close master Linear issue if all 7 metrics pass**

```bash
gh issue close $RECOVERY_ISSUE_NUMBER --comment "All 7 pass criteria met. See data/recovery-2026-05-18/final.md."
```

If ≥1 metric fails, open a follow-up issue with the specific gap (don't widen baselines per non-negotiable rule #1).

- [ ] **Step 5: Save a project memory**

```bash
# Use the auto-memory system: write a project memory at
# /Users/saggesel/.claude/projects/-Users-saggesel-Projects-frontaliere-si-o-no/memory/
# project_recovery_may18_outcome.md
# with description summarizing what worked / what didn't.
```

- [ ] **Step 6: Commit & merge**

```bash
git add data/recovery-2026-05-18/final.* docs/superpowers/plans/2026-05-18-traffic-subs-recovery.md
git commit -m "docs(recovery): final verification report (Phase 8) — <pass|partial> result"
git push -u origin recovery/p8-final-retro
gh pr create --fill
PR=$(gh pr list --head recovery/p8-final-retro --json number -q '.[0].number')
gh pr merge $PR --squash
git push origin --delete recovery/p8-final-retro
```

ExitWorktree.

---

## Phase dependency graph

```
P0 (setup) ──┬──> P1 (PostHog data) ──┬──> P4 (calc fix)
             │                         └──> P5 (app errors)
             ├──> P2 (analytics URL fix) ──────────┐
             ├──> P3 (rename drift)     ──────────┤
             ├──> P6 (CLS desktop)      ──────────┼──> P8 (verify)
             └──> P7 (SEO moratorium)   ──────────┘
```

P1, P2, P3, P6, P7 can run in parallel (5 worktrees). P4 and P5 start after P1 commits.

## Cost & risk

- **Time:** P1 ≈ 1 h. P2 ≈ 1 h. P3 ≈ 2 h (depends on drift breadth). P4 ≈ 2–4 h (depends on pattern). P5 ≈ 2 h. P6 ≈ 3 h. P7 ≈ 1 h. P8 ≈ 30 min + 7 d wait.
- **Risk:** P3 modifies `data/jobs*.json` — backfill is idempotent and existing helper has been tested (PR #161). P6 modifies layout — covered by new E2E budget test. P7 adds a CI gate — covered by unit test + live workflow run.
- **Rollback:** Each phase = 1 squash-merge on `main`. To rollback any phase: `git revert <sha> -m 1` + push.

## Non-negotiable compliance

- Rule #1 (no lowering quality thresholds): P7 only RAISES the bar.
- Rule #5 (fix root cause): every phase identifies and fixes a root cause, not a workaround.
- Rule #8 (Playwright for E2E): P4 + P6 use Playwright with build + serve dist.
- Rule #11 (gh CLI only): all phases use `gh`, never MCP GitHub.
- Rule #13 (live workflow validation): P7 step 7 enforces this.
- Worktree-First Rule: every phase has its own worktree.
- Auto-merge Rule: every phase opens-and-immediately-squash-merges.

---

**End of plan.**
