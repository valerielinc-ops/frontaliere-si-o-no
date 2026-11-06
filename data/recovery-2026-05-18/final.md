# Recovery final report — 2026-05-25

P8 was run manually before the scheduled routine. Result: **partial recovery**. Do not close the master tracker yet.

Follow-up issue for remaining gaps: #544.

| Metric | Baseline 2026-05-18 | Current | Delta | Target | Pass? |
|---|---:|---:|---:|---:|:--:|
| Subs /7d | 164 | 325 | +161 | >= 250 | yes |
| GSC clicks /7d | 5089 | 5069 | -20 | >= 5500 | no |
| GSC position | 8.62 | 9.81 | +1.19 | <= 7.5 | no |
| app_error rate | 3.5% | 0.272% | -3.228 pp | <= 1.0% | yes |
| Calc entry -> input_start | 29% | 3.0% | -26.0 pp | >= 40% | no |
| CLS p75 desktop | 1.016 | 0.91 | -0.106 | <= 0.5 | no |
| AdSense CHF/day | 2.99 | 2.73 | -0.26 | >= 4.50 | no |

## What Worked

- Newsletter subscriptions recovered strongly: Firestore `newsletter_subscribers.subscribed_at` shows 325 subscriptions in the last 7 days, versus the 164 baseline and 250 target.
- `app_error` rate is below target: PostHog shows 3892 `app_error` events over 1428355 total events in 30 days, or 0.272%.
- GSC clicks are roughly stable versus the May 18 baseline, but still short of the explicit 5500 target.

## What Did Not Pass

- Search position deteriorated: GSC average position is 9.81 versus target <= 7.5.
- Calculator funnel instrumentation/behavior is still not healthy: `input_start / entry` is 5 / 169 = 3.0%, well below the 40% target.
- CLS remains above target: desktop p75 is 0.91 versus target <= 0.5. Mobile p75 is also high at 1.0.
- AdSense revenue is improved versus the older revenue-monitor baseline, but not versus this incident target: CHF 2.73/day versus CHF 4.50/day.

## Evidence

- `reports/revenue-2026-05-25.json` and `.md` were generated locally by `scripts/revenue-monitor.mjs --save --markdown`.
- `data/recovery-2026-05-18/calc-funnel.json` and `.md` were refreshed by `scripts/diagnose-calc-funnel.mjs`.
- `data/recovery-2026-05-18/app-errors.json` and `.md` were refreshed by `scripts/diagnose-app-errors.mjs`.
- `data/recovery-2026-05-18/subscription-metrics.json` stores the Firestore subscription counts used above.
- `data/recovery-2026-05-18/p8-extra-metrics.json` stores the PostHog `app_error` rate query.

## Carry-Forward TODOs

- Investigate the GSC position regression separately from clicks: clicks are near baseline, but average position is still drifting.
- Re-open the calculator funnel investigation. The current query sees 169 entries and only 5 `input_start` events while `calculate` is 219, so the entry/start instrumentation path is still inconsistent.
- Investigate CLS root cause beyond the Phase 6 fixes; p75 desktop improved versus the incident baseline but remains too high for the target.
- Revenue recovery should be tracked after CLS and ranking recover, because AdSense remains below the incident target.
