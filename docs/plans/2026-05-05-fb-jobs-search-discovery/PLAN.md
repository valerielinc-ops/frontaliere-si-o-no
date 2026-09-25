# FB Jobs Search-Discovery Pipeline

**Date**: 2026-05-05
**Goal**: Daily cron schedules 144 FB posts (one per job listing) at 10-min intervals to populate Facebook Search surface for Swiss-Italian frontalieri queries. Page has 5 followers — feed-engagement irrelevant; objective is keyword-based discovery via FB Search.

## Phase 0 verdict (DONE)

Tested place tag feasibility on 2026-05-05.

- `/search?type=place` → deprecated for third parties (Graph API v8.0, Oct 2020)
- `/feed POST` with `place=<id>` → still parsed but requires *valid* Place ID
- Page lookup by username → requires `pages_read_engagement` + `Page Public Metadata Access` (Meta App Review only)

**Decision**: place tag dropped from scope. Geo-discovery via hashtag (`#Lugano`, `#Bellinzona`, etc.) — less powerful than place tag but still indexed by FB Search keyword.

## Architecture

**Sources publishing to FB Page (final state)**:
1. **Articles** — existing pipeline (`post-deploy-validation.yml` → `post-to-facebook.mjs`). Unchanged.
2. **Jobs daily cron** — NEW. `fb-jobs-daily-schedule.yml` runs once/day at 06:00 UTC, schedules next 24h via `scheduled_publish_time`.
3. ~~`social-schedule-fb.mjs`~~ — REMOVED (redundant with #1).

**Slot allocation** (deterministic, no runtime coordination):
- Jobs use minutes `:05 :15 :25 :35 :45 :55` → 6/hour × 24h = 144/day
- Articles use `:07 :37` (existing) → 2/hour, no collision
- Pre-flight: `GET /me/scheduled_posts?fields=scheduled_publish_time` to skip already-scheduled minutes (defensive against other orchestrators or manual posts)

**Selection rule** (mirrors `scripts/submit-google-indexing-jobs.js:242-258`):
1. Build all job URLs from `data/jobs.json` (4 locales)
2. Filter out jobs whose ID is in `data/fb-posted-jobs.json`
3. Sort by `firstSeenAt || crawledAt || postedDate` desc
4. Take top N (`FB_JOB_VOLUME` env, default 24)

**Caption format** (~280 char):
```
💼 [TITLE] · [COMPANY]
📍 [CITY]  💰 CHF [SALARY]  📋 [employmentType]

[First ~140 chars of body, truncated at sentence boundary]

#[Role] #[City] #[Sector] #frontalieri #lavoroticino
```

Hashtag rules (max 5):
- `#[RoleKeyword]` from `title` — first noun matched against role whitelist; if no match, drop role hashtag (4 hashtags total)
- `#[City]` from `location` — first word, sanitized (no spaces, no diacritics)
- `#[Sector]` from `sector` — sanitized; if missing, fallback `#Ticino`
- `#frontalieri` (always)
- `#lavoroticino` (always)

Body extraction: `descriptionByLocale.it || description`, strip HTML tags, take first 140 chars, truncate at last sentence break (`.`, `!`, `?`) or last space.

**Tracking dedup**: `data/fb-posted-jobs.json` (committed, append-only):
```json
{
  "schemaVersion": 1,
  "posted": [
    { "id": "<jobId>", "url": "<url>", "ts": "<iso>", "fbPostId": "<id>" }
  ]
}
```
Trim to last 1000 entries on write. Committed by workflow itself with `[skip ci]` to avoid re-deploy loop.

**Ramp strategy** (W1→W2→W3, controlled via `FB_JOB_VOLUME` workflow input):
- W1 (default): 24/day (1/hour) — uses minutes `:05` only
- W2: 72/day (1/20min) — uses `:05 :25 :45`
- W3: 144/day (1/10min) — full slot list

Volume → minute mapping is in the script.

Monitor FB Insights > Reach > Source: Search weekly. If reach drops or Page is shadow-banned → drop one tier, do NOT skip up.

## Agent assignments

### Agent C — Cleanup obsolete cron

**Worktree**: `fb-cleanup`
**Branch**: `chore/fb-remove-social-schedule`
**Files deleted**:
- `scripts/social-schedule-fb.mjs`
- `tests/scripts/social-schedule-fb.test.ts`
- `.github/workflows/fb-social-schedule.yml`

**Verification**:
- `grep -r "social-schedule-fb" --include="*.{ts,mjs,js,yml}" .` → only references in CHANGELOG/docs OK, otherwise zero hits in code
- No imports broken

**Commit message**: `chore(fb): remove obsolete social-schedule-fb cron`

**Tests**: skip locally (orchestrator runs full suite at end)

### Agent D — Job daily scheduling cron

**Worktree**: `fb-job-cron`
**Branch**: `feat/fb-jobs-daily-schedule`

**Files created**:
1. `scripts/schedule-fb-jobs-daily.mjs` (≈ 250-300 lines)
2. `.github/workflows/fb-jobs-daily-schedule.yml`
3. `tests/scripts/schedule-fb-jobs-daily.test.ts`
4. `data/fb-posted-jobs.json` (initial empty: `{"schemaVersion":1,"posted":[]}`)

**Script spec** (`scripts/schedule-fb-jobs-daily.mjs`):

Exports for testability:
- `pickNextSlots(volume, scheduledTimestamps, now)` → array of unix timestamps (≥ now+600s, on `:05/:15/:25/:35/:45/:55`, skip occupied)
- `selectUnpostedJobs(jobs, postedSet, limit)` → top N by recency, never-posted-first
- `buildJobCaption(job)` → string with format above
- `buildJobHashtags(job)` → string `#a #b #c #d #e`
- `loadPosted(repoRoot)` / `appendPosted(repoRoot, entries)` → JSON I/O
- `run({ env, now, fetchImpl })` → main entry

CLI: `node scripts/schedule-fb-jobs-daily.mjs`. Soft-fail (exit 0). Dry-run via `DRY_RUN=1` (logs payload, no API call).

Volume mapping (script uses these defaults):
```
volume=24  → minutes: [5]                       (1/hour)
volume=72  → minutes: [5, 25, 45]               (1/20min)
volume=144 → minutes: [5, 15, 25, 35, 45, 55]   (1/10min)
```

URL building per locale (mirror `submit-google-indexing-jobs.js:228-240`): `${SITE_URL}${prefix}${slug}/` — but for FB we use ONLY the IT locale link (`/cerca-lavoro-ticino/<slug>/`) since the audience is Italian-speaking.

Place tag: NOT used (Phase 0 verdict).

Pre-flight scheduled-posts query:
```
GET /{pageId}/scheduled_posts?fields=scheduled_publish_time&limit=200
```

**Workflow spec** (`.github/workflows/fb-jobs-daily-schedule.yml`):
```yaml
name: FB Jobs Daily Schedule (E5)
on:
  schedule:
    - cron: '0 5 * * *'  # 06:00 UTC = 07:00 CET / 08:00 CEST
  workflow_dispatch:
    inputs:
      volume:
        description: 'Posts to schedule (24/72/144)'
        required: false
        default: '24'
        type: choice
        options: ['24', '72', '144']
      dry_run:
        description: 'Skip Graph API call (preview only)'
        required: false
        default: 'false'
        type: choice
        options: ['true', 'false']

permissions:
  contents: write  # to commit fb-posted-jobs.json

jobs:
  schedule:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: 22, cache: npm }
      - name: Install dependencies
        run: npm ci

      - name: Prepare Firebase credentials
        env:
          FIREBASE_SERVICE_ACCOUNT_JSON: ${{ secrets.FIREBASE_SERVICE_ACCOUNT_JSON }}
        run: |
          echo "$FIREBASE_SERVICE_ACCOUNT_JSON" > "$RUNNER_TEMP/sa.json"
          echo "GOOGLE_APPLICATION_CREDENTIALS=$RUNNER_TEMP/sa.json" >> "$GITHUB_ENV"

      - name: Load secrets from RC
        run: node scripts/load-rc-env.mjs

      - name: Schedule FB jobs
        env:
          FB_JOB_VOLUME: ${{ github.event.inputs.volume || '24' }}
          DRY_RUN: ${{ github.event.inputs.dry_run || 'false' }}
        run: node scripts/schedule-fb-jobs-daily.mjs

      - name: Commit posted-jobs tracking
        if: success() && github.event.inputs.dry_run != 'true'
        run: |
          set -euo pipefail
          if git diff --quiet data/fb-posted-jobs.json; then
            echo "no changes"; exit 0
          fi
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add data/fb-posted-jobs.json
          git commit -m "chore(fb): track posted jobs [skip ci]"
          bash scripts/lib/git-push-with-retry.sh
```

**Test spec** (`tests/scripts/schedule-fb-jobs-daily.test.ts`):
- `pickNextSlots`: produces correct minute set for volume=24/72/144, skips occupied, all timestamps ≥ now+600
- `selectUnpostedJobs`: prioritizes never-posted, sorts by recency desc, respects limit
- `buildJobCaption`: total length ≤ 5000 (FB hard limit), format correct, body truncated at sentence
- `buildJobHashtags`: max 5 tags, no spaces inside tag, sanitization (diacritics removed)
- `loadPosted`: handles missing file, malformed JSON, returns empty set
- `run` integration: with `DRY_RUN=1` and mocked fetch, emits expected GraphAPI POST payloads

**Commit message**: `feat(fb): daily job posting cron with 24/72/144 ramp`

**Tests**: orchestrator runs at end. Agent should write tests but not execute the full suite.

## Orchestrator QA gate (BEFORE merge)

Per agent branch:
1. `git fetch origin && git checkout main && git pull --ff-only`
2. Worktree's branch: rebase onto fresh main (`git rebase main`)
3. Run full test suite: `npx vitest run` — must pass
4. Run full build: `npx vite build` — must exit 0 (without FAST_BUILD)
5. Audit gates: `npm run audit:text-html-ratio` + `npm run audit:orphan-sitemap-pages` — must pass (no regression)
6. Review diff: read all modified files, verify aligns with brief
7. Merge to main (no-ff or fast-forward)
8. Push to origin
9. Delete branch + worktree

## Post-merge verification

1. Monitor `deploy.yml` workflow run — must succeed
2. Live site spot-check: `curl -sS https://frontaliereticino.ch/sitemap-index.xml` — 200 OK
3. Verify no regression: a few existing pages still render correctly
4. **DO NOT** trigger `fb-jobs-daily-schedule.yml` manually yet — let cron fire naturally tomorrow at 06:00 UTC, monitor first run

## Risks & rollback

| Risk | Mitigation | Rollback |
|------|------------|----------|
| FB rejects POST with `scheduled_publish_time` for unverified Page | Phase 0 retest with one scheduled post via curl | Disable workflow, fall back to immediate posts (no scheduling) |
| Slot collision with article cron | Pre-flight `/scheduled_posts` query | Workflow re-runs idempotently, skips occupied slots |
| Spam classifier shadow-bans Page | Default volume=24 (1/hour) → mild | Stop workflow, wait 7d, re-enable at lower volume |
| `fb-posted-jobs.json` race with parallel orchestrators | Workflow uses `git-push-with-retry` (existing helper) | Idempotent: dedup is by job ID, duplicate writes harmless |
| Job legacy missing `firstSeenAt` | Fallback `crawledAt → postedDate → epoch` | No code change |

## Decisions taken (auto-orchestrator)

- Volume default = 24, ramp via workflow_dispatch input
- Place tag dropped (Phase 0)
- Worktree-based parallel execution for C+D
- Tests deferred to orchestrator (agents skip)
- Auto-merge if CI green (per CLAUDE.md orchestrator authorization)

---

## Status log (orchestrator updates)

- 2026-05-05 — Phase 0 done, place tag dropped, agents A+B dropped from scope.
- 2026-05-05 — PLAN.md committed.
