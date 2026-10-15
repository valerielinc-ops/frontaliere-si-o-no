# Sub-Plan 08: Cutover, Legacy Decommission, SEO Regression Monitoring

> **For agentic workers:** This is a STUB. Expand to bite-sized TDD tasks before executing.

**Goal:** Final cutover from coexistence mode (Astro + legacy Vite running in parallel) to Astro-only. Remove every remaining legacy artifact: `App.tsx` (already removed in sub-plan 05), `services/router.ts` (already removed), legacy `services/locales/` (already removed in sub-plan 06), `data/blog-articles-data.ts` (already removed in sub-plan 03). Disable the coexistence merge step in CI; Astro `dist/` is the deploy artifact directly. Open a 14-day SEO regression monitoring window with rollback artifact pinned. Confirm GSC indexing, click volume, position, and crawl health all hold within ±5% of pre-cutover baseline. If any metric breaches, execute rollback per pinned artifact. If all green at day 14, delete rollback artifact and close the migration.

**Architecture:**
- **Coexistence merge retirement.** `scripts/merge-astro-into-dist.mjs` (sub-plan 02) deleted. `deploy.yml` reads `dist/` directly from Astro build.
- **Final legacy sweep.** Any leftover files: `vite.config.ts` (deleted in sub-plan 07), `build-plugins/` (deleted in sub-plan 07), partial `services/*.ts` orphans. Inventory + delete.
- **Monitoring dashboard.** Daily snapshot from existing tooling:
  - `scripts/refresh-gsc-position-rolling.mjs` (already runs daily — capture pre-cutover baseline + 14-day post-cutover deltas)
  - `scripts/check-seo-moratorium.mjs` (confirm position avg stays ≤ pre-cutover)
  - `scripts/analytics-report.mjs` (memory `reference_analytics_scripts.md` — daily click/CTR/RPM deltas)
  - PostHog dashboards: funnel completion, calculator entry events (regression guard from memory `project_recovery_may18.md`)
  - AdSense per-channel revenue (memory `project_adsense_url_channels_apr28.md` — 8 URL channels track per-feature impact)
- **Rollback artifact.** Tag `pre-astro-cutover` on `main` immediately before the cutover merge. Pre-built legacy artifact uploaded to a long-lived GH release (`v-pre-astro-cutover`). If rollback needed: redeploy this artifact directly to GH Pages, skipping any rebuild. Recovery time: ~5 minutes.
- **Close-out documentation.** Final `docs/superpowers/notes/2026-XX-XX-astro-migration-complete.md` summarizing what shipped, what changed in user-facing behavior (ideally nothing), final metrics, lessons.

**Tech Stack:** Existing CI/CD, existing monitoring scripts.

**Depends on:** Sub-plans 01-07 (all). This is the terminator.

**Estimated effort:** 1 engineering week + 14-day passive monitoring window (no active engineering during monitoring unless rollback).

**Ships standalone value:** ❌ No — closes the migration; user-visible behavior unchanged from end of sub-plan 07.

---

## File structure (planned)

**Modified:**
- `.github/workflows/deploy.yml` — remove merge step, simplify to: assemble → astro build → audits → upload → deploy
- `package.json` — final cleanup of legacy script aliases if any remain
- `CLAUDE.md` — update "Project Overview" + "Tech Stack" + "Developer Workflows" + remove FAST_BUILD trap section + remove cathedral references + remove coexistence references; add "Astro" section
- `docs/CATHEDRAL-IMPLEMENTATION-PLAN.md` — mark archived with redirect to postmortem (sub-plan 07)
- `docs/CATHEDRAL-ROLLBACK.md` — same
- `docs/SEO-RULES.md`, `docs/SEO-GATES.md`, `docs/SEO-FEATURES.md` — verify still accurate; update references to retired plugins

**Created:**
- `docs/superpowers/notes/2026-XX-XX-astro-migration-complete.md`
- `docs/superpowers/notes/2026-XX-XX-astro-rollback-runbook.md` (kept even if not used)

**Deleted (in cleanup commits):**
- `scripts/merge-astro-into-dist.mjs`
- Any remaining `services/*` files that became unused during sub-plans 03-07 (audit via `npx ts-prune` or `knip`)
- Any `dist-astro/` references in `.gitignore` and scripts (cleanup)
- Pre-built legacy artifacts after the 14-day monitoring window passes clean

---

## Phases

1. **Pre-cutover baseline snapshot.** Capture: GSC 7-day average position, indexed page count, daily clicks/impressions per top-100 query, PostHog calc-funnel completion rate, AdSense per-channel RPM, Core Web Vitals (LCP/CLS/INP per template). Write to `data/migration-pre-cutover-baseline.json`. ~0.5 day.
2. **Rollback artifact preparation.** Tag `pre-astro-cutover`. Build legacy `dist/` one last time (via the still-existing legacy build infra at this point — actually it was deleted in sub-plan 07, so build from the tag in a fresh worktree). Upload as a GH release asset. Document one-button rollback procedure in `docs/superpowers/notes/2026-XX-XX-astro-rollback-runbook.md`. ~1 day.
3. **Cutover commit.** Remove merge step from `deploy.yml`. Astro `dist/` deploys directly. PR-as-merge-vehicle. Watch first post-cutover deploy run. ~0.5 day.
4. **Day-0 verification.** Within 1 hour of deploy: spot-check 20 representative URLs (homepage, top articles, salary landings, job pages, orphan landings) via `curl` (static HTML) + Playwright (hydrated DOM). Per memory `feedback_diagnose_static_and_hydrated.md`: always verify both. Zero regressions allowed. ~0.5 day.
5. **Day-1 to Day-3 close-watch.** Daily checks (script-driven). PostHog calc-funnel must hold within -5%. GSC crawl errors must stay near zero. ~daily 30 min.
6. **Day-4 to Day-14 passive monitoring.** Same daily script. Alert thresholds: position drop > 0.5 absolute, clicks drop > 10% week-over-week, indexed page count drop > 2%. Any alert triggers manual investigation + potentially rollback. ~daily 15 min.
7. **Final legacy sweep.** Run `npx knip` / `npx ts-prune`. Delete confirmed-dead code. Any false positives go in an allowlist with rationale. ~1 day. (May happen any time after Day 7 clean.)
8. **Day-14 close-out.** If all metrics green: delete rollback artifact, delete `pre-astro-cutover` tag (or convert to permanent annotated tag for history), write close-out doc, update CLAUDE.md to reflect Astro as the standard. ~0.5 day.

---

## Critical risks

1. **GSC ranking dip during indexing transition.** Even with byte-equivalent HTML, Google's crawler may treat the migration as a significant change and re-evaluate ranking. Risk window: 7-21 days. Mitigation: pre-cutover baseline captured; rollback ready; SEO moratorium (CLAUDE.md rule #19) already favors caution.
2. **Render parity drift in long tail.** L2 equivalence was tested on samples in sub-plans 03-04. Long-tail URLs (low-traffic but indexed) may have un-tested edge cases. Mitigation: post-deploy `audit-dist-from-run` validation catches structural issues; manual spot-check on day 0 catches major visual.
3. **CDN caching of stale legacy assets.** If GH Pages cached the legacy bundle paths, transitional 404s on hashed JS files. Mitigation: Astro emits fresh hashes; old asset 404s resolve when crawlers re-fetch HTML.
4. **PostHog funnel regression mistaken for migration.** If calc-funnel drops post-cutover, distinguish: instrumentation bug (memory `project_recovery_may18.md` precedent), real user-experience regression, or measurement noise. Triage protocol: replay PostHog session recording before assuming bug.
5. **AdSense policy re-eval.** Some publishers report ad-revenue dips after framework migrations as AdSense crawler re-evaluates. Mitigation: AdSense per-channel data (memory `project_adsense_url_channels_apr28.md`) lets us isolate which feature drops, if any.
6. **Rollback artifact stale.** Built at pre-cutover; doesn't include any data refreshes that happened during the migration. Acceptable for a 1-2 day emergency rollback; not acceptable as a long-term fallback (which is why we delete it at Day 14).

---

## Rollback

**Trigger conditions** (any one):
- GSC indexed-page count drops > 2% over 24h
- GSC 7-day position avg increases > 0.5 (per moratorium gate)
- PostHog calc-funnel completion drops > 10% over 24h with no clear measurement bug
- Day-1 spot-check fails on any high-traffic URL (homepage, calcolatore, top 10 articles)
- AdSense RPM drops > 25% over 24h with no clear ad-policy issue

**Rollback procedure** (~5 minutes):
1. Trigger GH Pages deploy from the pre-built legacy artifact (manual workflow_dispatch).
2. Verify pinned legacy URL list resolves via `curl`.
3. Pause subsequent Astro deploys: set a workflow concurrency lock or temporarily disable `deploy.yml`.
4. Open incident note. Investigate root cause without time pressure (legacy is back).
5. Decide: hotfix Astro + re-cutover, or extended rollback.

---

## Open questions to resolve before expansion

1. **Rollback artifact freshness.** Can we re-build legacy on demand from the tag, or must we keep a pre-built artifact? Decision: keep pre-built (faster recovery), refresh weekly during monitoring window if needed.
2. **Monitoring automation.** Should daily checks be a cron workflow that posts to Slack/Discord, or a manual ritual? Decision: cron workflow with escalation thresholds.
3. **Day-14 cutoff strictness.** If on Day-12 a metric trends concerning but not breaching threshold, extend monitoring? Decision: yes — extend by 7 days at PM discretion, document in incident log.
4. **Tag policy.** Keep `pre-astro-cutover` as a permanent annotated tag for history, or delete it once safe? Decision: keep permanently — costs nothing, valuable for archaeology.

---

## Execution handoff

(Same as sub-plan 01. This sub-plan is mostly passive monitoring — Inline Execution likely a better fit than Subagent-Driven, since there's not much code to write.)
