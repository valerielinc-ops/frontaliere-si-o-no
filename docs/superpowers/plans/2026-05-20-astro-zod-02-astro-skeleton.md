# Sub-Plan 02: Astro Skeleton + Content Collections Bootstrap

> **For agentic workers:** This is a STUB. Expand to bite-sized TDD tasks (per superpowers:writing-plans) immediately before executing, using sub-plan 01 as the template for granularity.

**Goal:** Install Astro 6.3.x + integrations (`@astrojs/react`, `@astrojs/mdx`, `@astrojs/sitemap`, `@astrojs/i18n`, `@astrojs/tailwind`). Create `astro.config.mjs` alongside the existing `vite.config.ts` (coexistence mode for transition). Define `src/content/config.ts` declaring content collections with Zod schemas reused from sub-plan 01. Ship one pilot static page (`/privacy/`) rendered end-to-end through Astro to validate the entire pipeline. Set up parallel CI builds so deploy.yml produces BOTH Astro output + legacy Vite output during the transition, with a routing layer that picks per-URL which to serve.

**Architecture:**
- New top-level directory: `src/` (Astro convention). Contains `src/pages/`, `src/content/`, `src/components/`, `src/layouts/`.
- `astro.config.mjs` at repo root, alongside `vite.config.ts`. Output target `dist-astro/` initially (not `dist/`) to keep legacy build untouched. Cutover renames to `dist/` in sub-plan 08.
- `src/content/config.ts` defines collections: `articles`, `landings`, `static-pages`, `jobs-meta`. Each uses Zod schemas IMPORTED from `scripts/lib/schemas/index.mjs` (Zod is shared between Node-side validation and Astro content-collection validation — same source of truth).
- One pilot static page: `src/pages/privacy.astro` rendering an MD/MDX source. Verifies: MDX integration works, Tailwind utility purge works under Astro, frontmatter Zod validation works, sitemap integration emits the page, `<head>` SEO tags render correctly.
- CI parallel build: `deploy.yml` runs `npm run build` (legacy Vite, emits `dist/`) AND `npm run build:astro` (new, emits `dist-astro/`). A merge step diffs the two; pilot URL served from `dist-astro/`, everything else from `dist/`.
- DNS / CDN unchanged. The merge step writes the final `dist/` by overlaying `dist-astro/` on top of `dist/`. Roll back = revert the build:astro script + skip the merge step.

**Tech Stack:** Astro 6.3.x, @astrojs/react 4.x, @astrojs/mdx 4.x, @astrojs/sitemap 3.x, @astrojs/i18n (or manual i18n config — decide in expansion), @astrojs/tailwind 5.x, Zod (from sub-plan 01).

**Depends on:** Sub-plan 01 (Zod schemas must exist for content collection configs to reference them).

**Estimated effort:** 1 week (5 engineering days).

**Ships standalone value:** Partial. One static page works through Astro; no traffic moved. The infrastructure is the deliverable, plus the validated pilot.

---

## File structure (planned)

**Created:**
- `astro.config.mjs`
- `src/pages/privacy.astro` (pilot)
- `src/content/config.ts`
- `src/content/static-pages/privacy.it.mdx` (pilot)
- `src/content/static-pages/privacy.en.mdx`
- `src/content/static-pages/privacy.de.mdx`
- `src/content/static-pages/privacy.fr.mdx`
- `src/layouts/BaseLayout.astro` (shared shell: nav, footer, head SEO tags)
- `src/components/seo/JsonLd.astro` (renders `<script type="application/ld+json">` via `services/seo/structuredData.ts` from sub-plan 01)
- `scripts/merge-astro-into-dist.mjs` (CI merge step)
- `tsconfig.astro.json` (Astro-specific TS config; references the existing `tsconfig.json` via `extends`)

**Modified:**
- `package.json` — add Astro deps, add `build:astro`, `dev:astro` scripts. Wire `npm run build` to call both (legacy + astro + merge).
- `.github/workflows/deploy.yml` — add `build:astro` step + merge step before upload.
- `.github/workflows/tests.yml` — add `npm run test:astro` (vitest under Astro context if needed; likely a noop initially since pilot has no tests beyond the page render).
- `tailwind.config.js` — extend `content` to include `./src/**/*.{astro,mdx,ts,tsx}`.
- `.gitignore` — add `dist-astro/`.

**Not modified yet** (sub-plans 03-08 own these): `vite.config.ts`, `App.tsx`, `services/router.ts`, `build-plugins/`, `services/locales/`.

---

## Phases (each becomes ~5-15 bite-sized tasks when expanded)

1. **Astro install + minimal config.** Add deps, write minimal `astro.config.mjs` (output static, no integrations yet), run `npx astro check` to confirm install. ~1 day.
2. **Tailwind + React + MDX integrations.** Add each integration one at a time, smoke-test, commit per integration. ~1 day.
3. **Content collections config.** Write `src/content/config.ts` declaring `static-pages` collection with Zod schema (reuses `ArticleMetaSchema` shape — adapted for static pages). Add `src/content/static-pages/privacy.it.mdx` (port the current privacy page body). ~0.5 day.
4. **Pilot page route.** `src/pages/privacy.astro` consumes the collection, renders via `BaseLayout.astro`, emits canonical URL + sitemap entry + JSON-LD via `JsonLd.astro` component (which calls `webPageLd()` from sub-plan 01). ~1 day.
5. **Sitemap + head SEO parity.** `@astrojs/sitemap` config. Verify pilot's `/privacy/` appears in `sitemap-index.xml` with same `<lastmod>` / `<priority>` as the legacy emitter. ~0.5 day.
6. **CI merge step.** `scripts/merge-astro-into-dist.mjs` copies `dist-astro/privacy/` → `dist/privacy/` (overwriting legacy). Wire into `deploy.yml`. ~0.5 day.
7. **Verification harness.** Run `verify-l1-equivalence.mjs` between legacy `dist/privacy/index.html` and new `dist-astro/privacy/index.html`. Acceptable diff: only Vite-bundled JS hashes change. Body content + JSON-LD must be byte-identical. ~0.5 day.
8. **PR + monitored deploy + 24h soak.** Deploy. Watch GSC + analytics for `/privacy/` for 24h. If no regression, sub-plan 02 closes. ~0.5 day.

---

## Critical risks

1. **Tailwind class purge under Astro vs Vite.** Tailwind's `content` config might not pick up `.astro` and `.mdx` files identically. Mitigation: explicit content paths, manual smoke test of utility classes on the pilot.
2. **Astro's default `<head>` differs from current SPA shell.** `BaseLayout.astro` must include every meta tag the current `buildSeoPageHtml` emits. Risk of dropping a canonical/hreflang/og tag. Mitigation: parity test that diffs head tags between legacy and Astro output.
3. **MDX compile in CI memory.** Astro + MDX adds Node memory pressure on top of the current `--max-old-space-size=18432`. Pilot is one page — won't hit it. Sub-plan 03 (10,800 MDX files) will. Track baseline now.
4. **Coexistence merge ordering.** If a path exists in both `dist/` and `dist-astro/`, the merge MUST be deterministic. Decision: `dist-astro/` always wins for any path it emits. Pilot path is one URL; future sub-plans extend the per-path overlay.
5. **Astro's strict-mode TS may surface errors hidden by current loose config.** Use `tsconfig.astro.json` with project-references to scope Astro's strictness only to `src/`, leaving existing code untouched.

---

## Rollback

- Revert `npm run build` to only call legacy Vite (`vite build`).
- Skip the `scripts/merge-astro-into-dist.mjs` step in deploy.yml.
- Result: legacy `/privacy/` served, Astro pilot ignored.
- `dist-astro/` artifact still produced for diagnostics; not deployed.
- Zero risk to production URLs other than the pilot, and the pilot rollback is one config flag.

---

## Open questions to resolve before expansion

1. **Astro adapter:** static (`output: 'static'`) vs hybrid. Static matches current GitHub Pages posture. Lock in static.
2. **i18n config:** `@astrojs/i18n` or manual routing. The official i18n routing has caveats around default-locale URL shape (we need IT = no prefix, others = `/{lang}/...`). Decide during expansion by reading current `services/router.ts:parsePath`.
3. **Tailwind via `@astrojs/tailwind` vs raw Vite plugin.** Astro 6.x prefers the Vite Tailwind plugin path. Use that to avoid double config.
4. **Where do Astro components import React components from?** Current `components/` is at repo root. Astro convention is `src/components/`. Use `tsconfig` path alias to keep imports working without a mass-move yet.

---

## Execution handoff

(Same Subagent-Driven vs Inline question as sub-plan 01 once this is expanded to bite-sized tasks.)
