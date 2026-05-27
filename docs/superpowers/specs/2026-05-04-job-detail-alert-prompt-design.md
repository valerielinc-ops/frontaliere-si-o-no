# Job Detail Alert Prompt — Design + Implementation Plan

**Date:** 2026-05-04
**Author:** valerielinc (orchestrator-driven)
**Status:** approved, ready for implementation

## Goal

Increase repeat visits to the site by surfacing a **gentle, low-friction job-alert subscription prompt** to logged-in users when they open a single job detail. Pre-fill the alert's keyword from the job's **category** so the user can subscribe in one tap.

The mechanism reuses the existing `job_alert_subscribers` Firestore infrastructure (FRO-331, FRO-353) and the `ENABLE_JOB_ALERTS` feature flag. It augments — does not replace — the existing `JobAlertPostAuthPrompt` flow that fires on the JobBoard listing after auth.

## Non-Goals

- Redesigning `JobAlertPostAuthPrompt` (existing search-query post-auth toast on the listing). That keeps working as today.
- Adding new email frequencies or filter dimensions to `JobAlertConfig`.
- Server-side changes (security rules, Firestore indexes, ESP wiring) — all required indexes already exist.
- Cross-session/cross-device sync of the dismissal state — localStorage on the device is sufficient.

## Behavioral Spec

### Trigger conditions

The prompt is mounted in `components/community/JobBoard.tsx` (which already renders the job-detail view via `initialJobSlug`) and shows when **all** of the following are true:

1. Feature flag `ENABLE_JOB_ALERTS` is `true` (Remote Config).
2. `authUser` is non-null **and** `authUser.email` is present.
3. The current view is a **single-job detail** (a specific `JobListing` is selected — derive a boolean `isJobDetailView` based on whether `initialJobSlug` resolves to one job and the URL is the canonical detail path; any list/filter view = `false`).
4. The selected job has a non-empty resolved `category` (use `categoryTranslationKey()` already in `JobBoard.tsx` to get a localized category label; if missing → no prompt).
5. Gating (localStorage, key `jobDetailAlertPromptState`) — see schema below — passes:
   - **session check** (sessionStorage `jobDetailAlertPromptShownThisSession` !== '1'),
   - **persistent dismiss cap** (`dismissCount < 2` OR `now - lastDismissAt > 30 days`),
   - **per-category cooldown** (`now - perCategorySeenAt[category] > 7 days`).
6. The user **does not already** have an active alert whose `keywords[]` contains a normalized match of the current category (`getUserAlerts(uid)` then `findMatchingAlertForCategory`).
7. A 4-second delay timer has elapsed since the job-detail view rendered (timer cancelled on navigation away or unmount).

If any condition flips false during the 4s delay, the timer is cancelled and no prompt shows.

### localStorage state schema

Key: `jobDetailAlertPromptState` (single JSON object, namespaced to avoid collisions)

```ts
interface JobDetailAlertPromptState {
  dismissCount: number;                     // total "Non ora" presses, lifetime
  lastDismissAt: string | null;             // ISO date of last dismiss
  perCategorySeenAt: Record<string, string>; // normalized-category → ISO date when last shown
}
```

Defaults if missing/corrupt: `{ dismissCount: 0, lastDismissAt: null, perCategorySeenAt: {} }`. Robust JSON parse with try/catch.

Also: `sessionStorage['jobDetailAlertPromptShownThisSession']` set to `'1'` once shown in the current session (any state — shown, accepted, dismissed). Cleared automatically by browser when session ends.

### UI states (component `JobDetailAlertPrompt`)

A bottom-right toast (same visual family as `JobAlertPostAuthPrompt`) with these four states:

1. **idle** — title `jobAlert.jobDetailPrompt.title`, body `jobAlert.jobDetailPrompt.body` with `{category}` placeholder replaced. Two buttons: primary "Sì, attiva" (`jobAlert.jobDetailPrompt.acceptCta`), tertiary "Non ora" (`jobAlert.jobDetailPrompt.dismissCta`). Close (✕) icon top-right counts as dismiss.
2. **submitting** — buttons disabled, primary shows spinner. Triggered when user clicks "Sì, attiva".
3. **success** — title `jobAlert.jobDetailPrompt.successTitle`, body `jobAlert.jobDetailPrompt.successBody` with `{category}`. A small inline link `jobAlert.jobDetailPrompt.manageLink` navigates to the user's job-alerts management view (route the existing app already has — use the same nav target as `openJobAlert` event navigates to today). Auto-dismiss after 4 s; user may close earlier.
4. **error** — title `jobAlert.jobDetailPrompt.errorTitle`, body `jobAlert.jobDetailPrompt.errorBody`, a "Riprova" button (`jobAlert.jobDetailPrompt.retryCta`) that re-enters submitting state.

Visual: reuse the styling tokens from `JobAlertPostAuthPrompt.tsx` (`bg-surface`, `border-accent-border`, `bg-accent-strong`, `animate-slide-up`, etc.). New file, NOT a refactor of the existing component.

### 1-tap subscribe behavior

When the user clicks "Sì, attiva":

- Call `subscribeJobAlertOneTap(userId, email, category, locale)` (new helper in `services/jobAlertService.ts`).
- That helper builds a `JobAlertConfig` with:
  - `keywords: [category]` — the localized category label (e.g., `"Sanità"`).
  - `locations: []`
  - `contractTypes: []`
  - `sectors: []`
  - `frequency: 'weekly'` (less spammy default; user can change in their preferences).
  - `locale: <current locale>` (one of `'it' | 'en' | 'de' | 'fr'`).
- Calls existing `createAlert(userId, email, config)`.
- On success → `success` state, fire `jobalert_jobdetail_prompt_success` analytics event.
- On error (incl. max-3-alerts limit thrown by `createAlert`) → `error` state, fire `jobalert_jobdetail_prompt_error` with reason. The component does NOT translate the error text contextually — the generic copy is fine; users hitting the cap can manage from the dedicated alert page (link present in error state copy).

### Dismiss / accept side-effects on persistent state

Whenever the prompt closes (any reason: dismiss, accept, success auto-dismiss), we update `jobDetailAlertPromptState`:

- On any close: set `perCategorySeenAt[normalize(category)] = now`.
- On dismiss only (✕ or "Non ora"): increment `dismissCount`, set `lastDismissAt = now`.
- On accept that succeeded: do NOT increment `dismissCount`. Also clear future relevance for this category by leaving `perCategorySeenAt[category]` set (the existing-alert check in (6) will prevent re-showing anyway, but the per-category cooldown is a belt-and-braces).
- On accept that failed: count as a dismiss for `dismissCount` purposes (so a user who repeatedly hits the limit isn't badgered).

`sessionStorage['jobDetailAlertPromptShownThisSession']` is set to `'1'` the moment the prompt mounts (in `idle`).

## Architecture

### File-by-file changes

**New files:**

1. `components/community/JobDetailAlertPrompt.tsx` — toast UI component with 4 states. ~150 LOC. Lazy-loadable (use `lazyRetry` like the existing prompt).
2. `services/jobDetailAlertGating.ts` — pure utility module. Exports `loadGatingState()`, `saveGatingState()`, `shouldShowPrompt(state, now, normalizedCategory)`, `recordDismiss(state, now, normalizedCategory)`, `recordAccept(state, now, normalizedCategory)`. No React, no Firebase. ~100 LOC. Easily unit-tested.
3. `tests/components/community/JobDetailAlertPrompt.test.tsx` — UI tests (render in each state, click handlers, copy substitution).
4. `tests/services/jobDetailAlertGating.test.ts` — unit tests for gating logic (matrix of session/dismissCount/lastDismissAt/perCategorySeenAt).
5. `tests/services/jobAlertService.subscribeOneTap.test.ts` — unit test for `subscribeJobAlertOneTap` (mocks `createAlert`, asserts the config shape).

**Modified files:**

1. `services/jobAlertService.ts`:
   - Add `export function normalizeKeyword(s: string): string` — lowercase, trim, NFD-strip accents.
   - Add `export function findMatchingAlertForCategory(alerts: JobAlert[], category: string): JobAlert | null`.
   - Add `export async function subscribeJobAlertOneTap(userId: string, email: string, category: string, locale: 'it' | 'en' | 'de' | 'fr'): Promise<JobAlert>` — wraps `createAlert` with the canonical 1-tap config.
2. `components/community/JobBoard.tsx`:
   - Add `lazyRetry` import for the new prompt.
   - New `useState` block: `const [jobDetailPromptVisible, setJobDetailPromptVisible] = useState(false);` and `const [jobDetailPromptCategory, setJobDetailPromptCategory] = useState<string | null>(null);`.
   - Detect `isJobDetailView` (a single resolved job is showing). Reuse the existing logic that decides whether to render the detail vs list view — locate it (likely a `selectedJob` or `singleJobView` derivation); add a memoized boolean.
   - New `useEffect` that, when `isJobDetailView && authUser?.email && enableJobAlerts`, computes the category, calls `getUserAlerts(authUser.uid)`, runs `shouldShowPrompt(...)`, and on green sets a 4-second timer to show. Cleanup: clear timer on dependency change/unmount.
   - Render the prompt under a `Suspense` block alongside the existing `JobAlertPostAuthPrompt` block (around line 7261). Pass the category, callbacks, and current locale.
   - The prompt's `onAccept` calls `subscribeJobAlertOneTap` directly (no `openJobAlert` event detour). On success/error update local state to drive the `success`/`error` UI state.
3. `services/locales/it-core.ts`, `en-core.ts`, `de-core.ts`, `fr-core.ts`:
   - Add 8 new translation keys under the `jobAlert.jobDetailPrompt.*` namespace:
     - `title` — "Vuoi alert per {category}?"
     - `body` — "Ti scriviamo quando escono nuovi lavori in **{category}**."
     - `acceptCta` — "Sì, attiva"
     - `dismissCta` — "Non ora"
     - `successTitle` — "Alert attivato ✓"
     - `successBody` — "Ti avvisiamo quando escono nuovi {category}."
     - `manageLink` — "Gestisci alert"
     - `errorTitle` — "Errore"
     - `errorBody` — "Non sono riuscito a creare l'alert. Riprova o gestiscilo dalla pagina alert."
     - `retryCta` — "Riprova"
   (Localize for EN/DE/FR matching the tone of the existing `jobAlert.postAuthPrompt*` keys.)
4. `services/analytics.ts` (if events go through it) OR `services/Analytics` consumer:
   - Either add a dedicated `trackJobDetailAlertPrompt(stage: 'shown' | 'accept' | 'dismiss' | 'success' | 'error', category: string)` helper, OR reuse `Analytics.trackJobAlertCtaClick(source, action, keyword)` with `source = 'job_detail_prompt'`. Prefer the latter — fewer surfaces to change. Stages map: `shown → ('job_detail_prompt', 'shown', category)`, `accept → ('job_detail_prompt', 'accept', category)`, `dismiss → ('job_detail_prompt', 'dismiss', category)`, `success → ('job_detail_prompt', 'success', category)`, `error → ('job_detail_prompt', 'error', category)`.

### Data flow

```
JobBoard (job detail view)
  └─ effect: getUserAlerts + shouldShowPrompt
        └─ 4s timer
              └─ setJobDetailPromptVisible(true) + Analytics.shown
                    │
                    ▼
              <JobDetailAlertPrompt category=... onAccept onDismiss locale=... />
                    │
              click "Sì, attiva"
                    ▼
              subscribeJobAlertOneTap()
                    ├─ createAlert(...)
                    │     ├─ Firestore write
                    │     └─ throws if >= 3 active
                    └─ on success → success state, recordAccept()
                       on error  → error state, recordAccept-like dismiss
```

### Error & edge-case handling

- `getUserAlerts` throws → silently swallow, do NOT show the prompt (failing closed is preferable to badgering users on a degraded network).
- `subscribeJobAlertOneTap` throws → enter `error` state, log via existing logger only (no `console.log`). Generic copy.
- User navigates away during the 4 s delay → timer cleared in effect cleanup. No prompt.
- User logs out mid-display → `authUser` becomes null → unmount the prompt immediately.
- Locale changes mid-display → re-render with new copy (translation keys re-resolve via `useTranslation`).
- Category contains chars that break `keywords[]` Firestore query — none expected, but `normalizeKeyword` handles trimming.
- Browser disables localStorage → `loadGatingState()` returns defaults; prompt becomes session-only (which is fine, just less polite over 30 days).

## Test plan

### Unit tests

- `jobDetailAlertGating.test.ts` (new): 12+ cases covering all gating decision branches.
- `jobAlertService.normalizeKeyword.test.ts` (extend existing or new): accents, casing, whitespace.
- `jobAlertService.findMatchingAlertForCategory.test.ts` (extend existing or new): match/no-match across keywords.
- `jobAlertService.subscribeOneTap.test.ts` (new): mock `createAlert`, assert `JobAlertConfig` shape.

### Component tests

- `JobDetailAlertPrompt.test.tsx`: render each state, click handlers fire, `{category}` substitution.

### Integration (if budget)

- Render a JobBoard mock with single-job-detail mode + authenticated user + `enableJobAlerts=true` → assert the prompt appears after the timer fires (use vitest fake timers).

## Out-of-scope follow-ups (note in PR, not in this PR)

- Server-side dedup if a user creates the same category alert via two surfaces in parallel (createAlert already enforces the per-user max-3 cap).
- A/B testing the copy or delay duration — wire later via Remote Config if desired.
- Showing the prompt also on listing+filter views beyond `JobAlertPostAuthPrompt` — explicitly NOT in this scope.

## Definition of done

1. All unit + component tests pass via `npx vitest run`.
2. `npx tsc --noEmit` exits 0.
3. `npx vite build` exits 0 (CI run, not FAST_BUILD).
4. The 4 locale files all carry the new keys.
5. Feature flag `ENABLE_JOB_ALERTS` correctly gates the new flow (manual verification in dev with flag toggled).
6. No `console.log` statements introduced.
7. No `dark:` color prefixes used.
8. Accessibility: toast has `role="dialog"`, dismissable via Escape, all buttons have accessible names, contrast ≥ 4.5:1 (mirror the existing `JobAlertPostAuthPrompt` patterns).
9. Live verification on `https://frontaliereticino.ch` after deploy: log in, open a job detail, observe prompt timing and 1-tap behavior across at least 2 locales (IT + one other).

## Implementation Plan (agent execution)

The implementation will run in **a single background agent on an isolated git worktree**. The agent has freedom to skip `npx vitest run`, `npx vite build`, and the pre-push hook DURING DEVELOPMENT — but MUST run `npx tsc --noEmit` after each significant change. The orchestrator (this assistant) will run the full verification suite after the agent finishes and before merging to `main`.

### Phase order (single agent, sequential within agent)

1. **Bootstrap inspection** — agent reads relevant files (`services/jobAlertService.ts`, `components/community/JobBoard.tsx`, the existing `JobAlertPostAuthPrompt.tsx`, `services/locales/*-core.ts`) to confirm the integration point and copy patterns.
2. **`services/jobAlertService.ts`** — add `normalizeKeyword`, `findMatchingAlertForCategory`, `subscribeJobAlertOneTap`. Run `npx tsc --noEmit`.
3. **`services/jobDetailAlertGating.ts`** — create the gating utility module. Run `npx tsc --noEmit`.
4. **`components/community/JobDetailAlertPrompt.tsx`** — create the UI component with the 4 states. Run `npx tsc --noEmit`.
5. **Locale keys** — add the 9 keys to all 4 locale files. Run `npx tsc --noEmit`.
6. **Wire into `components/community/JobBoard.tsx`** — `lazyRetry` import, state, `isJobDetailView` derivation, the gating `useEffect`, the render block. Run `npx tsc --noEmit`.
7. **Tests** — write `jobDetailAlertGating.test.ts`, `JobDetailAlertPrompt.test.tsx`, `jobAlertService.subscribeOneTap.test.ts`. Run only the new tests in isolation: `npx vitest run tests/services/jobDetailAlertGating.test.ts tests/components/community/JobDetailAlertPrompt.test.tsx tests/services/jobAlertService.subscribeOneTap.test.ts`.
8. **Commit** to the worktree branch (one or two atomic commits). Do NOT push. Do NOT run pre-push hook.

### Orchestrator post-agent steps (autonomous)

1. Read worktree branch diff, do code-review-style QA pass.
2. Pull worktree branch into the main checkout (`git merge --ff-only` if possible, otherwise standard merge).
3. Run `npx vitest run` (full suite).
4. Run `npx tsc --noEmit`.
5. Run `npx vite build` (production-equivalent, with FAST_BUILD unset).
6. If green: commit any QA fixups, `git push origin main`. Pre-push hook will run; that's intended.
7. Watch the deploy workflow with `gh run watch` until green.
8. Live verification on `https://frontaliereticino.ch` using Playwright MCP: log in flow → job detail → observe prompt timing and 1-tap behavior.
9. Cleanup: drop the worktree, delete the merged feature branch, audit any stale stashes/branches and tidy.
10. Final report to user.

### Risk register

| Risk | Mitigation |
|------|------------|
| Concurrent orchestrator races on `JobBoard.tsx` | Use `git merge` (not `rebase`) so conflicts surface explicitly; resolve manually before push. |
| Pre-existing failing tests in main | Run `npx vitest run` BEFORE the agent starts; record the baseline. Treat only NEW failures as blockers. |
| Worktree merge duplicates router types (per memory) | Spot-check `services/router.ts` after merge; this PR shouldn't touch it. |
| Token cap pressure | Single background agent with isolated worktree means the orchestrator's context only grows from agent summaries, not file reads. |
| FAST_BUILD inherited from `.claude/settings.json` masks SEO plugins | Final build run uses `FAST_BUILD= npx vite build`. |
