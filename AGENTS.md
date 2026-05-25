# Project Agent Instructions

This file is intentionally compact: it is injected into every agent session. Keep durable detail in docs and load it only when needed.

## Non-Negotiables

1. Never lower quality thresholds, test tolerances, validation criteria, SEO gates, or moratorium thresholds to pass a build. Fix the root cause.
2. Never downgrade errors to warnings to unblock deploys.
3. Job page structured data must always include `baseSalary`, `postalCode`, `streetAddress`, `title`, `description`, `datePosted`, `hiringOrganization.name`, `jobLocation`, and `employmentType` in every locale. Missing source data means generate safe defaults, not remove checks.
4. Never accept indexed thin content under 50 words.
5. If a test fails, treat the test as right until proven otherwise.
6. Keep changes surgical: no drive-by refactors, no speculative abstractions, no unrelated formatting churn.

## Workflow

- Worktree-first is mandatory for every task that will edit, commit, or push files: create a dedicated branch worktree before making changes. Treat the local `main` checkout as shared/read-only for status and inspection only.
- Never edit, stage, stash, restore, commit, rebase, or merge in the local `main` checkout unless the user explicitly asks for that exact operation. Existing dirty files on `main` are foreign work and must be left untouched.
- Parallel/subagent work must always use isolated worktrees; never share a working directory between agents.
- Auto commit and push successful tasks. Use PR-as-merge-vehicle when landing on `main`: create PR, squash merge, delete remote branch, then remove the worktree.
- When a PR is ready for `main`, merge it immediately and observe the post-merge `main` checks/deploy instead of waiting for PR checks first, unless branch protection blocks the merge or the user explicitly asks to hold.
- If post-merge checks/deploy fail, do not fix directly on `main`; create a fresh worktree and branch, fix the root cause, open a new PR, merge it, then observe `main` again.
- Before closing any task, audit Codex worktrees/branches. If the PR was merged, delete the remote branch and remove the local worktree immediately; if it was not merged, leave the worktree/branch in place and state the explicit merge/abandon decision needed.
- GitHub operations use `gh` CLI only.
- Never run `send-newsletter.mjs --send` locally. Use `--preview` or `--test --target-email <email>`.
- New GitHub Actions workflows must be run live on `main` after merge with `gh workflow run <workflow>.yml --ref main`.
- Use Playwright CLI or the Codex Browser for E2E. Do not rely on preview-only tools.
- When touching a function/class/method, run GitNexus impact analysis first. Before committing code changes, run GitNexus detect changes.

## Build And Test

```bash
npm run dev
npm run build
npm test
```

Agent sessions inherit `FAST_BUILD=1`; override it when validating SEO plugin output:

```bash
FAST_BUILD= npx vite build
```

Full local SEO builds can OOM. Prefer audit replay for dist-only audit verification:

```bash
gh workflow run audit-dist-from-run.yml -f deploy_run_id=<run_id> -f audits=<audit-list>
```

CI test gate: `npm ci`, `node scripts/assemble-jobs-dataset.mjs --stats`, `node scripts/migrate-all-known-job-slugs-canton-aware.mjs`, then `npm test`.

## Architecture

- React 19 + TypeScript + Vite + Tailwind.
- No React Router. Routing is hand-rolled in `services/router.ts`; `App.tsx` owns navigation state.
- Canonical production domain: `https://frontaliereticino.ch` with no `www`.
- Primary locale is Italian; EN/DE/FR are supported through chunked locale files under `services/locales/`.
- Navigation caps: 6 top-level tabs and 8 sub-tabs per category.

## Static SEO Pages

- Every static SSG page emitted by build plugins must use `build-plugins/shared/seoPageShell.ts` via `buildSeoPageHtml`.
- Static plugin contract: `apply: 'build'`, `enforce: 'post'`, emit in `closeBundle()`, pass `distDir`.
- Body styling in emitted static HTML must use Tailwind utilities only. `tailwind.config.js` content must include `./build-plugins/**/*.{js,ts}`.
- SPA/static handoff is router-driven via `staticOverlay`; do not reintroduce DOM heuristics for `main.seo-static-content`.
- Mobile first: real content must appear immediately after H1/tagline. Long intros, methodology, and FAQs go below the action/data area or in collapsed accordions.
- SEO landing order: breadcrumb, header with one-line lede <=120 chars, 3-5 stat tiles, advice banner when useful, primary CTA, data area, then long prose.
- Use existing semantic color tokens only; no new inline hex colors.
- Dedicated crawlers must merge jobs by stable id using `extractStableJobId(job.url)`, preserve previous slugs, and truncate with `truncateSlugAtWordBoundary`.
- SEO automation moratorium: no new build-plugin SEO landings while `data/gsc-position-rolling.json` 7-day average position is above 7.5, except bug fixes, net-reducing consolidation, and redirect/bridge emitters.

## Accessibility And UX

- Every new page needs SEO metadata, sitemap coverage, accessibility checks, and translated keys in all 4 locales when user-facing text is added.
- Contrast minimum: 4.5:1 normal text, 3:1 large text.
- Do not use `text-slate-400` on light backgrounds.
- Every button needs an accessible name. Every image needs `width`, `height`, and `alt`.
- Do not add `dark:` color classes except `dark:prose-invert`; use semantic tokens in `index.css`.
- User-facing features need an entry in `WhatsNewModal.tsx`.

## Reference Docs

- CI/CD: `docs/CI-CD-PIPELINE.md`
- SEO rules: `docs/SEO-RULES.md`
- SEO gates: `docs/SEO-GATES.md`
- SEO features: `docs/SEO-FEATURES.md`
- Crawlers: `docs/CRAWLERS.md`
- Cathedral plan: `docs/CATHEDRAL-IMPLEMENTATION-PLAN.md`
- Rollback: `docs/CATHEDRAL-ROLLBACK.md`
- Design: `docs/DESIGN-CONTEXT.md`
- Local dev: `docs/LOCAL-DEV.md`
- GitNexus: `docs/GITNEXUS.md`
