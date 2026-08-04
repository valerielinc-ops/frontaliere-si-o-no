/**
 * keywordLandingPlan — the set of GSC keyword-landing URLs this build actually
 * emits, in EVERY locale, registered by the plugins that own them.
 *
 * The defect this closes
 * ----------------------
 * `audit:hreflang` reported 75 `missingTarget` offenders on post-deploy run
 * 30376520728: pages serving `<link rel="alternate">` for locale siblings that
 * do not exist. Example verified on production —
 * `/fr/trouver-emploi-tessin/recherche-groupe-mutuel-emploi/` serves 200 with
 * four alternates while its IT, EN and DE siblings all 301.
 *
 * The `/{section}/{ricerca|search|suche|recherche}-{slug}/` family is emitted
 * per locale from per-locale query data, so a keyword that earns a landing in
 * FR need not earn one in IT. The emitter still writes the full four-locale
 * alternate set. In a single-process build `hreflangGuard` would catch that:
 * it stats `dist/` and drops alternates whose file is absent.
 *
 * A `BUILD_LOCALE` shard cannot. An alternate for a locale the shard does not
 * emit is absent from ITS dist by design — the page lives on another shard —
 * so the guard keeps it unchecked (`hreflangGuard.ts`, and the same
 * short-circuit in `filterExistingAlternatesWith`). That is correct for a
 * sibling that exists elsewhere and blind for one that exists nowhere, and
 * nothing downstream re-checks: each shard force-pushes a tree built fresh
 * from its own `dist/` (`scripts/lib/push-section-shard.sh` rebuilds the
 * staging dir from scratch every run), so no later pass ever sees the union.
 *
 * Why a registry rather than more filesystem checks
 * ------------------------------------------------
 * Every shard loads the byte-identical source data, so every shard can answer
 * "will this URL be emitted?" for ANY locale without touching another shard's
 * disk. The owning emitters register the canonical paths they write; the
 * hreflang pass then treats an alternate pointing outside that plan as broken,
 * which is exactly the judgement the cross-shard branch had to skip.
 *
 * Fail-closed on incompleteness
 * -----------------------------
 * A partial plan is worse than none — it would call live pages broken. The
 * plan is therefore sealed on OWNER completeness (see {@link REQUIRED_OWNERS}):
 * until every owner has registered, {@link hasKeywordLandingPlan} is false and
 * every consumer behaves exactly as before.
 *
 * Memory: paths only, no HTML. Well under 100 MB of strings on the 2026-07
 * corpus, against a build that peaks near 9.8 GB.
 *
 * ── Now a re-export shim ────────────────────────────────────────────────
 *
 * The implementation moved to `packages/articles/engine/hreflangPostprocess.ts`
 * when `transformHreflang` was extracted there, but THIS file kept its own
 * `owners`/`planned` sets and its own writer. The result was two registries:
 * the emitters registered here, while `transformHreflang` read the package's —
 * which nothing ever wrote to, because the writer was not extracted with the
 * readers. `hasKeywordLandingPlan()` was therefore permanently false on the
 * path that matters and the stale-landing repair never fired in a real build.
 *
 * Re-exporting instead of re-implementing makes that unrepresentable: one set
 * of state, one writer, whichever side you import from. Direction is forced —
 * `packages/articles` cannot import build-plugins without breaking its
 * confinement test, so the package owns the state and this file follows.
 */

export {
  type KeywordLandingOwner,
  normalizeLandingPath,
  isKeywordLandingPath,
  registerKeywordLandingPaths,
  hasKeywordLandingPlan,
  isPlannedKeywordLanding,
  keywordLandingPlanSize,
  landingPathFromDistRelative,
  isStaleKeywordLanding,
  __resetKeywordLandingPlanForTests,
} from '../../packages/articles/engine/hreflangPostprocess.ts';
