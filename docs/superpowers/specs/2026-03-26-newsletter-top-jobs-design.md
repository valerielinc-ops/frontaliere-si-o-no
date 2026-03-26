# Newsletter Top Jobs — Firestore Views Ranking

**Date**: 2026-03-26
**Status**: Approved

## Problem

The newsletter section "Le offerte che non trovi su LinkedIn" currently selects jobs by recency (newest first) with no engagement signal. The "Piu cliccata" badge is hardcoded on the first job regardless of actual data. Jobs with thin descriptions or from expired listings can slip through.

## Solution

Add Firestore-based job page view tracking (same pattern as existing `article_views`), export popularity data at newsletter build time, and select the 4 most-viewed jobs with company diversity and quality filters.

## 1. Client-Side View Tracking

**Firestore collection**: `job_views`
**Document key**: job `slug`
**Fields**: `views` (number, FieldValue.increment), `lastViewed` (serverTimestamp)

**Trigger**: When a user navigates to a job detail page (`/cerca-lavoro-ticino/{slug}`), increment the counter. Debounce via `sessionStorage` key `jv_{slug}` to count max 1 view per session per job.

**Implementation location**: The job detail rendering logic in `App.tsx` (or the component that renders job pages). Use the existing Firebase instance from `services/firebase.ts`.

**New service function** in `services/jobViewsService.ts`:
- `trackJobView(slug: string)` — debounced Firestore increment
- Uses `doc(db, 'job_views', slug)` + `setDoc(..., { views: increment(1), lastViewed: serverTimestamp() }, { merge: true })`
- Gate behind `sessionStorage.getItem('jv_' + slug)` check

## 2. Build-Time Popularity Export

**New script**: `scripts/fetch-job-popularity.mjs`
**Output**: `data/job-popularity.json` — `{ [slug]: number }`
**Reads**: All documents from `job_views` collection via Firebase Admin SDK
**Auth**: Uses existing `GOOGLE_APPLICATION_CREDENTIALS` (Firebase service account)

Called in `send-newsletter.yml` workflow before newsletter generation step.

## 3. Newsletter Job Selection

Update `matchJobsForSubscriber()` in `services/newsletter-content.mjs`:

### New algorithm (when popularity data available):

1. Load `data/job-popularity.json`
2. Cross-reference with `data/jobs.json` (active jobs only)
3. **Quality filters** (applied before ranking):
   - `title` and `company` must be non-empty
   - `slug` must exist in active dataset
   - Italian description (`descriptionByLocale.it` or `description`) >= 120 characters
   - Description must not start with `<` (broken HTML) or be all-caps
4. Sort by `views` descending
5. **Company diversity**: max 1 job per `companyKey` (or `company` normalized)
6. Take top 4
7. First job gets "Piu cliccata" badge (real data now)

### Fallback (no popularity data or < 4 qualifying jobs):

Fill remaining slots with the current date-based selection (newest first), same quality filters applied.

## 4. Template Changes

In `services/newsletter-template.mjs` `renderJobs()`:
- Badge logic unchanged — first job gets the badge (but now it's the genuinely most-viewed)
- No visual changes needed

## 5. Workflow Integration

In `.github/workflows/send-newsletter.yml`, add step before newsletter generation:
```yaml
- name: Fetch job popularity data
  run: node scripts/fetch-job-popularity.mjs
```

## Files to Create/Modify

| File | Action |
|------|--------|
| `services/jobViewsService.ts` | **Create** — `trackJobView()` function |
| `scripts/fetch-job-popularity.mjs` | **Create** — Firestore export script |
| `data/job-popularity.json` | **Generated** — popularity data |
| `services/newsletter-content.mjs` | **Modify** — new selection algorithm |
| `.github/workflows/send-newsletter.yml` | **Modify** — add fetch-popularity step |
| Job detail component in `App.tsx` | **Modify** — call `trackJobView()` on mount |
