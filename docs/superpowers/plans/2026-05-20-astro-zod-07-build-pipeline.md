# Sub-Plan 07: Build Pipeline Migration — Workflows, Cathedral Retirement, Audit Rewiring

> **For agentic workers:** This is a STUB. Expand to bite-sized TDD tasks before executing.

**Goal:** Audit and rewire 117 GitHub workflows for Astro. Retire `vite.config.ts`, the Cathedral parallelization machinery (`parallel_plugins=true` mode), FAST_BUILD/SKIP_* env vars, and the entire `build-plugins/` directory. Update `deploy.yml`, `post-deploy-validation.yml`, `post-deploy-validate-dist.yml`, `audit-dist-from-run.yml`, `tests.yml`, and the rebaseline pipelines to consume Astro's output layout. Confirm Firebase Remote Config loading (`scripts/load-rc-env.mjs`) still works under Astro. Branch protection rules verified.

**Architecture:**
- **`npm run build` end state:** runs `astro build` (only). Emits to `dist/`. No Vite plugin chain. No Cathedral parallel_plugins flag. No FAST_BUILD/SKIP_*.
- **`deploy.yml`:** assemble-jobs (unchanged) → astro build → 3 remaining dist-walking audits (text-html-ratio, content-duplicates, page-weight + bfs-depth) → upload artifact → deploy to GitHub Pages. Other workflow steps preserved verbatim where they don't touch build internals.
- **Cathedral retirement:** `parallel_plugins=true` workflow_dispatch input deleted. Cathedral-specific scripts in `scripts/` archived (NOT deleted — useful reference). Closures/closeBundle parallelization no longer exists; Astro builds are Astro-fast (typically faster than the current Vite + 16 plugins chain).
- **Audit rewiring:** the 3 remaining dist-walking audits run unchanged (they walk `dist/`, which Astro fills). The BFS-depth audit may simplify or be retired if sub-plan 04's content-index made the violation impossible. Decision in this sub-plan.
- **Rebaseline pipelines:** `text-html-ratio-baseline.json`, `content-duplicates-baseline.json`, etc. — must be re-baselined against Astro output once during this sub-plan. New baselines committed.
- **Firebase RC loader (`scripts/load-rc-env.mjs`):** currently runs before Vite build to inject runtime config. Verify Astro startup path is equivalent; likely needs to run as a `prebuild` hook (already is — via `predev`/`prebuild` scripts in package.json).
- **Branch protection:** memory note `tests.yml` is the main gate. Confirm `tests.yml` still runs after migration. Optionally add required_status_checks to gate on Astro build + tests.

**Tech Stack:** GitHub Actions, Astro CLI, existing audit scripts.

**Depends on:** Sub-plans 02-06. CI rewire can START when sub-plans 03 + 04 are >50% complete (working Astro output for diff testing).

**Estimated effort:** 1.5 weeks (7-8 engineering days).

**Ships standalone value:** ❌ No — infrastructure-only. Unblocks sub-plan 08 cutover.

---

## File structure (planned)

**Modified:**
- `.github/workflows/deploy.yml` — Astro build + simplified audit chain
- `.github/workflows/post-deploy-validation.yml` — Astro dist path
- `.github/workflows/post-deploy-validate-dist.yml` — Astro dist path
- `.github/workflows/audit-dist-from-run.yml` — Astro artifact extraction
- `.github/workflows/tests.yml` — add `astro check` step
- `.github/workflows/*.yml` (other 112) — audit each for Vite/build-plugin references
- `package.json` — `build` → `astro build`. Remove `build:fast`, `build:ci`, `build:prod`, `prepush:fast`. Update `dev` → `astro dev`. Preserve `test`, `test:e2e`, `predev`, `prebuild` (assemble-jobs).
- `data/text-html-ratio-baseline.json` — re-baselined to Astro output
- `data/page-weight-baseline.json` — re-baselined
- `data/content-duplicates-baseline.json` — re-baselined
- `data/bfs-depth-baseline.json` — re-baselined or retired
- `.claude/settings.json` — remove SKIP_* env vars (memory `project_agent_fast_build_env.md`)
- `CLAUDE.md` — update tech stack section + dev workflow section
- `docs/CI-CD-PIPELINE.md` — full rewrite

**Deleted:**
- `vite.config.ts`
- `build-plugins/` (entire directory — every plugin already replaced by sub-plans 03-06)
- `scripts/parallel-closebundle*.mjs` (if any Cathedral scripts exist; archive first)
- The `audit:*` package.json scripts already removed in sub-plan 01 are now confirmed-gone

**Created:**
- `astro.config.mjs` is mature (sub-plans 02-06 evolved it; this sub-plan locks in production config)
- `docs/superpowers/notes/2026-XX-XX-cathedral-postmortem.md` — archives the Cathedral approach + what we learned

---

## Phases

1. **Workflow inventory.** Run `grep -l "vite\|FAST_BUILD\|SKIP_\|build-plugins\|cathedral\|parallel_plugins" .github/workflows/` — list every workflow referencing legacy build infra. ~0.5 day.
2. **`deploy.yml` rewrite.** Astro build + simplified audit chain + artifact upload. Test via workflow_dispatch against a feature branch. ~1 day.
3. **Re-baseline.** Run a full Astro production build. Re-baseline the 3 remaining dist-walking audits + bfs-depth. Commit new baselines with explanatory message. ~0.5 day.
4. **BFS-depth decision.** Check if Astro routing + content index from sub-plan 04 makes BFS-depth ≤4 by construction. If yes, retire the audit (per sub-plan 01's pattern). If no, keep walking. ~0.5 day.
5. **Other workflow audits.** Each of the 117 workflows reviewed in batches of 20. Most are unaffected (cron data refreshes, no build deps). Update the ~5-10 that touch build internals. ~2 days.
6. **`tests.yml`.** Add `npx astro check` step. Confirm vitest still runs `isolate: true` (memory: mandatory). ~0.5 day.
7. **Remove env-var gymnastics.** `.claude/settings.json` no longer needs SKIP_*. `package.json` cleanup. Document the simplification. ~0.5 day.
8. **Cathedral archive.** Move Cathedral-specific scripts to `docs/superpowers/archive/cathedral/` with README explaining the prior approach. Delete from `scripts/`. ~0.5 day.
9. **Branch protection audit.** Optionally enable `required_status_checks: tests, astro-build` on `main`. Decision: enable if user wants strict gating (memory `feedback_no_ci_wait_agent_finish.md` says no — confirm). ~0.5 day.
10. **`vite.config.ts` deletion + `build-plugins/` deletion.** Single PR. Run full build via Astro to confirm zero references remain. ~0.5 day.
11. **Docs update.** Rewrite `docs/CI-CD-PIPELINE.md`. Update `CLAUDE.md` Tech Stack + Developer Workflows + FAST_BUILD trap section (now obsolete). ~1 day.

---

## Critical risks

1. **Workflow-coverage blind spot.** With 117 workflows, easy to miss a niche one (e.g., a weekly cron) that references the old build. Mitigation: phase 1's grep, plus phase 5's manual batch review, plus a CI smoke run that fires each scheduled workflow once via workflow_dispatch.
2. **Re-baseline scope.** If new baselines accept worse numbers than legacy (e.g., text-html-ratio drops because Astro emits more chrome HTML), the audits become weaker silently. Mitigation: in phase 3, REQUIRE the new baseline to be ≥ legacy on every metric; if Astro is worse, fix Astro emit first.
3. **Pre/post-deploy validation paths.** Audits walk `dist/`. If Astro emits to a different default directory (it doesn't — `dist/` is default — but verify), all audit scripts break. Phase 3 catches.
4. **Branch protection accidental tightening.** Memory `feedback_no_ci_wait_agent_finish.md`: user merges without waiting for CI. Adding required_status_checks would break that workflow. Default: do not add. Confirm before phase 9.
5. **Cathedral-style parallelism loss.** Sub-plan 04 might rely on per-plugin parallel build for speed. Astro builds are typically fast enough not to need it, but measure: if Astro build > current Cathedral parallel build, investigate before deleting.
6. **Local dev experience.** `npm run dev` switches from Vite to Astro. Different dev server, different HMR characteristics. Smoke-test mid-sub-plan; flag any DX regressions.
7. **Firebase RC load order.** `scripts/load-rc-env.mjs` currently runs as predev/prebuild. Astro's startup may or may not see the env vars at the right time. Verify by smoke-testing one runtime-config-dependent feature.
8. **Cron file ignore pattern (`local-ignore-cron.sh`).** ~600 cron files mostly under `data/jobs/by-crawler/`. The `local-ignore-cron.sh` pattern is independent of build system; verify it still functions after Astro install reshuffles the tree.

---

## Rollback

- Each phase is one PR. Reverting individual phases is safe.
- Phase 10 (delete `vite.config.ts` + `build-plugins/`) is the irreversible point. Tag `pre-vite-deletion`. Only run after phases 1-9 are clean for 7 days.
- Full rollback: revert phases 10 → 2 in reverse order. Brings legacy build back. Articles + landings (sub-plans 03/04) would still serve from Astro under coexistence merge.

---

## Open questions to resolve before expansion

1. **Astro production build time vs current Cathedral parallel build.** Measure during phase 3. If Astro is meaningfully slower (>30%), profile and address before phase 10.
2. **Cathedral artifacts kept or deleted?** Decision: archive (keep), don't delete. Useful reference for future builds, and the postmortem is worth writing.
3. **`build:fast` / `prepush:fast` user-facing scripts** are used by agent sessions (memory `project_agent_fast_build_env.md`). After migration, agent sessions just run `npm run build` (Astro is fast by default). Confirm `.claude/settings.json` updates.
4. **Required status checks.** Memory says no CI wait. Confirm we're NOT adding required_status_checks in phase 9 (default: skip phase 9 entirely).

---

## Execution handoff

(Same as sub-plan 01.)
