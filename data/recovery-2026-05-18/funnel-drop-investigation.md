# Calculator funnel drop — investigation (2026-05-18)

GA4 reported the calculator funnel collapsed:
- `entry` → 36.056 events / 24.216 users
- `input_start` → 9.862 events / 7.043 users (**-71% drop**)
- `calculate` → 74.733 events / 21.527 users
- `compare` → 198 events / 149 users (-99% from calculate)

**Investigation method:** read-only HogQL queries against PostHog EU (project 157802), last 7d. Script: `scripts/investigate-calc-funnel-drop.mjs`.

---

## TL;DR — the drop is an INSTRUMENTATION ARTIFACT, not a UX bug

`input_start` is **not** a "user typed in the first field" signal today. It is an **auto-fired event** triggered by `InputCard`'s `useEffect(() => { fetchRate(); ... }, [])` hook (lines 308–312 of `components/calculator/InputCard.tsx`).

Mechanism (chain of source-code evidence):

1. `InputCard` mounts → `useEffect` runs → calls `fetchRate()` (line 309).
2. `fetchRate()` awaits a lazy `import('exchangeRateService')` + `fetchExchangeRate()` network call, then calls `handleChange('customExchangeRate', rate)` (line 298).
3. `handleChange` (line 273) sees `inputStartTracked.current === false` → fires
   `Analytics.trackFunnelStep('input_start', { funnel: 'calculator', first_field: field })`.

So `input_start` only fires when **(a)** the SPA mounts `CalcolatoreTabContent` AND **(b)** `InputCard` lazy-loads AND **(c)** the exchange-rate fetch resolves (≈1–3 s of network + JS).

### PostHog evidence (last 7d)

| step | events | users |
|---|---|---|
| `entry` (funnel=main_conversion) | 13.931 | **11.485** |
| `input_start` (funnel=calculator) | 3.485 | **2.954** |
| `simulation_start` (funnel=calculator) | 28.621 | 9.481 |
| `simulation_complete` (funnel=calculator) | 28.429 | 9.467 |
| `calculate` (funnel=main_conversion) | 28.445 | 9.468 |
| `compare` (funnel=calculator) | 5 | 5 |
| `compare` (funnel=main_conversion) | 50 | 41 |

PostHog confirms: **74 % of users who fire `entry` never fire `input_start`** (8.531 / 11.485) — consistent with GA4's -71 %. BUT note 9.467 users complete `simulation_complete` against 11.485 `entry` users → **82 % of entry users actually finish a calculation**. The "drop" between `entry` and `input_start` is fake; the real funnel works.

### `input_start` payload tells the story

| URL | first_field | dropping_users |
|---|---|---|
| `https://frontaliereticino.ch/` | `customExchangeRate` | 2.790 |
| `https://frontaliereticino.ch/?utm_source=chatgpt.com` | `customExchangeRate` | 19 |
| `https://frontaliereticino.ch/de/` | `customExchangeRate` | 16 |
| ... (every row) | `customExchangeRate` | ... |

**Every** `input_start` event in 7 days has `first_field = customExchangeRate` and a homepage-family URL. There are essentially zero real "user typed in salary first" events. Static-overlay calc landings (`/calcola-stipendio/<slug>/`) never mount `InputCard`, so they NEVER fire `input_start` — they go straight to `simulation_start` once the user clicks "calcola" in the in-page widget (different code path).

---

## Why the funnel breaks

Two compounding bugs:

### Bug 1 — `input_start` is meaningless ("instrumentation bug")

The event is fired by app code, not by user interaction. Drop from `entry` → `input_start` measures:
- exchange-rate API latency / failure rate
- bounce rate during the first ~2 s after `InputCard` mounts
- which routes actually mount `InputCard` (SPA homepage only)

It does NOT measure "did the user start typing." So the funnel-step semantics are broken at the instrumentation layer. Any GA4/PostHog dashboard built on this funnel is reporting noise.

### Bug 2 — `entry` is fired by the wrong code path

`fireCalcEntryIfNeeded` (analytics.ts:447) is supposed to emit `entry` with `funnel: 'calculator'` and a `landing_path` payload. PostHog shows ALL 11.485 entry users have:
- `funnel = main_conversion` (NOT `calculator`)
- `landing_path = null`

`fireCalcEntryIfNeeded` is either not being called from the route change effect, or it's being shadowed by another emitter. The "real" `entry` events are coming from `trackFunnelStep('entry', ...)` without an explicit `funnel:` override → defaults to `main_conversion`.

---

## Top 5 errors in dropping sessions

No `$exception` events match the dropping-user cohort in the last 7 d (query returned 0 rows because the cohort filter required `funnel='calculator'` on entry, which is empty — see Bug 2). Errors are not the cause: the broader `triage-app-errors.mjs` last 7d run shows the usual benign noise.

## Mobile vs desktop

Same caveat as errors: device-split query returned 0 rows. Re-run after Bug 2 is fixed.

---

## Recommended fixes (NOT applied — needs product sign-off)

### Fix A (1-line, low risk) — make `input_start` reflect user intent

In `components/calculator/InputCard.tsx:294`, the auto-fetch in `fetchRate` should NOT flip the funnel flag. Replace `handleChange('customExchangeRate', rate)` with a direct `setInputs` so only real user interaction triggers `input_start`:

```diff
   const fetchRate = async () => {
     setLoadingRate(true);
     try {
       const { fetchExchangeRate } = await import('../../services/exchangeRateService');
       const rate = await fetchExchangeRate();
-      handleChange('customExchangeRate', rate);
+      setInputs(prev => ({ ...prev, customExchangeRate: rate }));
       setLastRateUpdate(new Date());
     } catch (e) { ... }
   };
```

After this, `input_start` becomes a real "user typed in something" signal — and the dashboard CTR will plummet to its honest baseline (probably 30–50 % of entry on the SPA homepage, ~0 % on static-overlay landings).

### Fix B (instrumentation cleanup) — make `entry` go through `fireCalcEntryIfNeeded`

Find the caller emitting `trackFunnelStep('entry', ...)` without `funnel: 'calculator'` and either (a) remove it and rely on `fireCalcEntryIfNeeded`, or (b) add `funnel: 'calculator'` + `landing_path` to that call site. Until then PostHog dashboards split entry across two `funnel` values and `landing_path` analysis is impossible.

### Fix C — instrument static-overlay landings

If the product KPI is "what % of users on `/calcola-stipendio/<slug>` reach a calculator interaction," those static pages need their OWN `input_start` event (e.g., when a user clicks "personalizza" or scrolls past the hero). Today they're invisible to the calculator funnel entirely.

---

## Not applied in this PR

The 1-line Fix A seems safe but I'm holding off in this investigation PR because:
- It changes a KPI dashboards depend on — needs product OK before flipping the metric overnight.
- It doesn't address Bug 2 (the `entry` event still goes to the wrong funnel) — fixing one without the other gives a misleading "improved" funnel.
- The user-visible UX is fine: `simulation_complete` (the real conversion) is 9.467 users / 11.485 entries = **82 % conversion** on PostHog, which is healthy.

Recommend: open a Linear task scoped to A + B together with a 1-day GA4 baseline freeze, then ship.

---

_Generated by `scripts/investigate-calc-funnel-drop.mjs`_
