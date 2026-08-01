# Article generator migration — main-side preparation (issue #4974 item 3)

> Prepared from main only. This session has no access to `nanakokyobashi-rgb/frontaliere-articles`
> ("nanako") — everything nanako-side (what it should look like, its own tests, its own
> workflows) is out of scope and flagged under "Open questions". Everything here is
> mechanically checkable against the commit this was written from
> (`92cb79d1`, branch `claude/firebase-rc-connection-iigglr`).

## 0. Corrections to the issue text

The issue's "64 files / 16 scripts" figure is stale and the six-producer framing needs
qualification. Concretely, checked against the real code:

1. **`scripts/rerender-article-corpus.mjs` is not a corpus producer.** It never writes to
   `packages/articles/`, never runs `git commit`/`git push`, and its workflow has no `contents:
   write` permission (`contents: read`). It reads the already-registered corpus (via the
   `services/locales/*` symlinks into `packages/articles/content/`), calls the SAME
   `renderArticlePages()` the site's `vite build` and `publish-article-fast.mjs` use, and pushes
   rendered HTML to four locale-shard repos (`SHARD_ARTICOLI*_DEPLOY_KEY` secrets) that are
   separate from both main and nanako. It is a **site rendering/publishing** workflow that
   happens to consume the corpus, not a generator. See §2/§4/§5.
2. **`crawl-events.yml` is not an article-generation workflow either.** Its job is crawling
   `data/events.json` from tio.ch/guidle/myswitzerland/geneve.ch — a site data pipeline with no
   corpus involvement for 5 of its 6 steps. `generate-events-digest-article.mjs` is one
   soft-failing step (`|| echo "::warning::..."`) inside it that refreshes a single evergreen
   article's body. Moving "the workflow" is not well-formed; only that one step's script moves.
3. **A live write conflict exists today, independent of this migration**:
   `scripts/lib/evergreen-article-refresh.mjs`'s `bumpSitemapLastmod()` (called from
   `generate-events-digest-article.mjs` and `generate-border-wait-ranking-article.mjs` — see
   grep below) still directly edits `public/sitemap-blog.xml` on every digest refresh. But
   `create-article.mjs`'s own `modifySitemap()` is a documented no-op *specifically* because
   `sitemap-blog.xml` is nanako-owned and pulled by `scripts/pull-articles-api.mjs`, whose own
   header comment says a second writer would be clobbered or refused by the pull's shrink guard.
   The digest scripts never got the same memo. This is pre-existing, not introduced by the move,
   but the move is the forcing function to fix it (§3).
4. File-closure counts (§1) are real, not "64/16": between 61 and 103 files per producer,
   176 unique files across all six, only 22 of which already live under `packages/articles/`.

## 1. Transitive file closure (mechanical)

Method: a throwaway script (not committed — see the end of this doc) starting from each
producer's entry file, following `import`/`export...from`/dynamic `import()`/`require()`
statically (regex-based, not a real parser — misses conditional `require` behind computed
strings, but none of the 6 entry points use those for their own lib tree; verified by
diffing against a manual read of each file's import block). Symlinks are resolved with
`fs.realpathSync` so a file reached only via a `services/locales/*.ts → packages/articles/...`
symlink is correctly counted as already-in-package. `readFileSync`/`execSync` literal-path call
sites are flagged separately and checked by hand (git-blob/constant tracing), because dynamic
paths (`resolve(SOME_CONST + ...)`) aren't resolvable by regex alone.

| Producer script | Total files in closure | Already in `packages/articles/` | Outside (needs disposition) |
|---|---:|---:|---:|
| `scripts/create-article.mjs` | 61 | 1 | 60 |
| `scripts/generate-events-digest-article.mjs` | 67 | 1 | 66 |
| `scripts/generate-border-wait-ranking-article.mjs` | 67 | 1 | 66 |
| `scripts/publish-journalist-article.mjs` | 64 | 1 | 63 |
| `scripts/batch-add-faq-to-articles.mjs` | 9 | 0 | 9 |
| `scripts/rerender-article-corpus.mjs` | 103 | 22 | 81 |
| **Union (unique files, all 6)** | **176** | **22** | **154** |

The "1" for the first four is `build-plugins/shared/articleSectionCore.mjs`, a symlink to
`packages/articles/engine/shared/articleSectionCore.mjs`. `batch-add-faq-to-articles.mjs`
reaches zero in-package files by static import — it touches the corpus only through the
runtime path `services/locales/${SECTION_BODY_DIR}` (a template string, invisible to static
import scanning; confirmed by reading the file directly, see §2).

Four of the first five share ~60 files almost identically because
`generate-events-digest-article.mjs`, `generate-border-wait-ranking-article.mjs`, and
`publish-journalist-article.mjs` all `import { registerArticleFiles, ... } from
'./create-article.mjs'` and therefore drag in its entire `scripts/lib/**` tree (AI routing,
discovery/topic-selection, translation, fact-checking — ~45 files under `scripts/lib/`).
`rerender-article-corpus.mjs` is the outlier: it reaches into `build-plugins/**` (the site's
Vite SSG pipeline: `ogPagesPlugin.ts`, `htmlTemplate.ts`, `hreflangPostprocessPlugin.ts`, etc.)
and all 36 `services/locales/{de,en,fr,it}-*.ts` UI-string files (the site's i18n catalog, not
article content) — evidence for the correction in §0.1.

## 2. Per-file disposition (group b: the 154 files outside `packages/articles/`)

Legend: **MOVE** = physically relocate to nanako, no trace stays in main except a thin caller.
**COPY** = a near-duplicate must exist in both repos (accept the duplication, or the tooling
they support is genuinely shared and small). **REWIRE** = the current file read must become an
API call / environment input instead, because the file legitimately encodes site knowledge the
generator needs but does not own. **STAYS** = belongs to main; the generator side either loses
the capability or gets it through a REWIRE.

### `scripts/lib/**` — the shared generation engine (create-article + 3 dependents)

All ~45 files under `scripts/lib/{ai-models,article-*,discovery/**,scoring/**,topic-sources/**,
evidence/**,scheduler/**}` etc.: **MOVE**. These are pure content-generation machinery (LLM
routing, dedup/scoring, topic discovery, translation, fact-checking) with no site-rendering
dependency. `scripts/create-article.mjs`, `scripts/generate-events-digest-article.mjs`,
`scripts/generate-border-wait-ranking-article.mjs`, `scripts/publish-journalist-article.mjs`,
`scripts/batch-add-faq-to-articles.mjs`, `scripts/fix-faq-locales.mjs`,
`scripts/generate-journalist-image-catalog.mjs`: **MOVE** (the six producers themselves plus
the two helper scripts one of them shells out to / is paired with).

Exceptions inside that tree:
- `scripts/lib/resolve-git-add-path.mjs` — resolves a repo-relative path through a symlink to
  its real on-disk path for `git add`. Only exists because main's corpus paths are symlinks into
  `packages/articles/`. **STAYS main-shaped, but nanako needs its own equivalent** — once the
  generator commits directly into nanako's tree there are no symlinks to resolve, so this
  becomes dead code there, not a port target. Not REWIRE, not MOVE: **retire on the nanako
  side**, note it explicitly so nobody ports it out of habit.
- `scripts/lib/ensure-chromium.mjs` — installs/locates a Playwright Chromium binary for
  evidence-page screenshotting. **MOVE** — content concern, but flag: nanako's CI runner needs
  its own Playwright cache strategy; this file doesn't carry that infra with it.

### Data files read by the generator

| Path | Disposition | Why |
|---|---|---|
| `data/border-wait-averages.json` | **COPY** (or REWIRE to an API) | Consumed by 4 of the 6 producers to write border-wait context into article bodies, but it's *produced* by `traffic-scheduler.yml` (a site feature, live border-wait chart) from data that only exists in main. Cheapest: nanako's generator fetches it fresh each run from `https://frontaliereticino.ch/data/border-wait-averages.json` (it's already served from `public/`) instead of reading a repo file — that's a REWIRE, not a COPY, and avoids a second stale copy. Recommendation: REWIRE. |
| `data/borderCrossings.ts` | **COPY** | Static reference data (border crossing names/coords/slugs), not site-generated. Small, changes rarely. Duplicating it is cheaper than an API round-trip for every article-gen run; two copies drifting is a low-probability, low-blast-radius risk given how static it is. |
| `data/municipalities.ts` | **COPY** | Same reasoning as `borderCrossings.ts` — static reference data. |
| `data/canton-url-slugs.json` | **COPY** | Static slug map, same category. |
| `data/news-sitemap-whitelist.ts` (222 lines) | **REWIRE** | This is the Google News topic-whitelist gate — it decides `sitemap-news.xml` eligibility, and `sitemap-news.xml` is explicitly staying in main (§3). The generator (now in nanako) needs the gate's verdict at generation time (it affects `data.newsEligible` used to skip a Google-News-only image or slot), but the sitemap itself must not be written from nanako. Recommendation: expose the whitelist decision as a small pure function/JSON nanako can vendor (or call), while `public/sitemap-news.xml` continues to be written only by whatever ends up owning it in main (§3) — do not let nanako write to that file directly. |
| `data/article-source-quotas.json`, `data/article-source-urls.json`, `data/swiss-article-source-quotas.json`, `data/swiss-article-source-urls.json` | **MOVE** | Per-source discovery quota/dedup state, written and read only by the generator's own discovery pipeline (`scripts/lib/scheduler/quotaController.mjs`, `article-topic-selector.mjs`). Nothing in main reads these. |
| `data/topic-candidates-consumed.json` (`CONSUMED_TRACKER_PATH`) | **MOVE** | Same category — generator-internal dedup state. |
| `data/blog-images-used.json` | **MOVE** | Generator-internal state (recent-image rotation to avoid visual repetition). |
| `data/batch-faq-progress.json`, `data/batch-faq-progress-ch.json` | **MOVE** | `batch-add-faq-to-articles.mjs`'s own resume-checkpoint file. |
| `data/canton-municipalities.json`, `data/authors.ts` | **STAYS** | Only reached via `rerender-article-corpus.mjs`'s closure, which itself STAYS (site rendering, §2 rerender section below) — not generator dependencies. |

### `build-plugins/**` (81 files, all reached only via `rerender-article-corpus.mjs`)

**All STAYS.** This is the site's Vite SSG plugin pipeline — HTML templating, hreflang
post-processing, contextual-links injection, chunk/asset-hash handling, ad-slot markup, critical
CSS. None of it is article *generation*; it is article *rendering into the site's own HTML
shape*, which is inescapably a main-repo concern because the shape is the site's. This is the
concrete evidence for §0.1: `rerender-article-corpus.mjs` and its whole 81-file outside-closure
STAY in main, in full, unmodified by this migration. It reads corpus content that already lives
in `packages/articles/` (via the same symlinks the rest of the site uses) — nothing here needs
REWIRE, because after the move that read path is exactly "read the corpus mirror main already
has", not a new dependency. The one thing that changes it depends on: **whether main keeps a
full-text copy of the corpus at all** — see §6 open question 1, because if main becomes a
JSON/sitemap-only consumer of nanako (per `pull-articles-api.mjs`'s stated architecture), this
whole workflow loses its input and needs its own resolution, out of scope for "the generator
move" but a real blocking dependency on it.

### `services/**` (11 files outside the package, mostly via `rerender-article-corpus.mjs`)

| Path | Disposition | Why |
|---|---|---|
| `services/borderCrossingSlug.ts` | **COPY** | Small pure slug-formatting helper, used by 4 of the 6 generator scripts to build canonical URLs. Static logic, no site dependency — cheap to duplicate. |
| `services/borderWaitFormat.ts` | **COPY** | Same category, used by `generate-border-wait-ranking-article.mjs` to format wait-time text. |
| `services/adsenseSlots.ts`, `services/benignErrorPatterns.ts`, `services/blogBodyLoader.ts`, `services/botPatterns.ts`, `services/cantonList.ts`, `services/i18n.ts`, `services/posthog-error-filter.ts`, `services/resilientImport.ts`, `services/routeSlugs.data.ts`, `services/seo/imageObjectLd.ts`, `services/seo/organizationLd.ts` | **STAYS** | All reached only through `rerender-article-corpus.mjs` → `build-plugins/**` → the site's rendering/analytics/ad machinery. Not generator dependencies. |
| `services/locales/{de,en,fr,it}-{calculator,comparatori,core,fisco,guide,seo-links,stats,vita,critical}.ts` (36 files) | **STAYS** | The site's UI-string i18n catalog (button labels, nav, calculators), reached only via the rendering pipeline. Confirms §0.1: this is not article content. |

### `data/blog-images-used.json`'s writer path and generated hero images

`public/images/blog/<id>.webp` (and the `.source.<ext>` temp file during generation) — the
actual hero-image binary a run produces — is **STAYS main / nanako writes, main pulls**. See §3;
it is functionally a corpus asset even though it's under `public/`, and it's the one write in
`gitAddAll()` where "COPY the file itself" doesn't apply (images aren't the code-level kind of
duplication this table is about) — treat it as part of the corpus payload, not a separate
disposition.

## 3. The out-of-corpus writes in `gitAddAll()` (`scripts/create-article.mjs:8708-8755`)

| Write | What happens after the move |
|---|---|
| `public/sitemap-news.xml` | **STAYS in main, generator loses direct write access.** This is the hard one. It's a Google News surface with a 48h freshness window (enforced separately by `scripts/cleanup-news-sitemap.mjs`, run as a pre-generation step in `generate-article.yml` — "Cleanup stale news sitemap entries") and a topic-whitelist gate (`data/news-sitemap-whitelist.ts`). `modifySitemap()` (the *regular* blog sitemap) is already a documented no-op today because the equivalent surface, `sitemap-blog.xml`, moved to nanako-owned + pulled — `sitemap-news.xml` explicitly did NOT follow because "it is a Google News surface with its own whitelist gate, still owned here" (create-article.mjs:8633-8634, current code). Two real options: (a) nanako emits its own `sitemap-news.xml` candidate entries (with eligibility computed from a vendored/REWIRED copy of the whitelist, §2) and `pull-articles-api.mjs` learns to pull+merge it with the 48h prune applied on the main side after pulling, same shrink-guard discipline the other pulls already have; or (b) main keeps a tiny standalone "register this article for Google News" step (an API endpoint nanako calls back into, or a scheduled main-side job that reads nanako's just-published feed and decides itself). (a) keeps main dumb (a pure consumer, matching the architecture doc's stated intent); (b) keeps the whitelist/48h logic in the same place it already fails safely today. **Recommendation: (a)**, because keeping two independent codepaths that both decide Google News eligibility (nanako's generation-time skip + a hypothetical main-side re-decision) is exactly the "two producers, last writer wins" failure `modifySitemap()`'s own comment already warns about for the regular sitemap — one authority (nanako, using the vendored whitelist) computing eligibility once, at generation time, then a mechanical main-side pull+prune, matches the pattern already proven safe for `sitemap-blog.xml`. |
| `public/sitemap.xml` | **STAYS in main, generator stops writing it.** This is `updateSitemapIndexLastmod()` bumping the *index* file's `<lastmod>` for whichever child sitemap changed. Once `sitemap-news.xml` is pull+prune-updated by a main-side script (recommendation above) rather than the generator itself, that script bumps the index too — same actor, same commit, no new coupling. |
| `data/article-source-quotas.json`, `data/article-source-urls.json` (+ swiss variants) | **MOVE**, generator writes them in nanako. Nothing in main reads them (verified: no `grep` hit outside `scripts/create-article.mjs`/`scripts/lib/scheduler/quotaController.mjs`). |
| `data/topic-candidates-consumed.json` | **MOVE**, same reasoning. |
| generated hero image (`public/images/blog/<id>.webp`) | **Nanako writes it under `packages/articles`-equivalent content, main pulls it.** `pull-articles-api.mjs` does not currently fetch images (only sitemaps/RSS/ticker JSON into `public/`) — this is a **gap the migration must close**, not an existing capability. Recommendation: extend `pull-articles-api.mjs`'s artifact list with an image manifest (URL list keyed by article id) the nanako publisher emits alongside its JSON, same fetch-then-atomic-write discipline the script already uses for the rest. |

## 4. Workflow inventory

| Workflow | Secrets | Repo vars | Composite actions | Site-specific steps that must NOT be carried over |
|---|---|---|---|---|
| `generate-article.yml` (1005 lines total; producer call sites at lines 339/341 as the issue states — confirmed current) | `APP_ID`, `APP_PRIVATE_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `GITHUB_PAT`, `GITHUB_TOKEN` | `ARTICLE_LOCAL_FALLBACK`, `ARTICLE_LOCAL_MODEL`, `ARTICLE_RUNNER`, `DISCOVERY_QUOTA_OVERRIDE` | `./.github/actions/setup-omniroute`, `./.github/actions/setup-claude-haiku-fallback` | `npm run test:articles` (line 483 — runs `tests/article-seo-fallback.test.ts`, `tests/static-pages-blog-skip.test.ts`, `tests/article-duplicate-detection.test.ts`, `tests/article-tax-content-guard.test.ts`, `tests/related-articles.test.ts`, `tests/whats-new.test.tsx` — these are SITE tests, some of which (`related-articles`, `whats-new`) assert on rendering, not generation); "Cleanup stale news sitemap entries" (`cleanup-news-sitemap.mjs` — operates on `public/sitemap-news.xml`, a main file, §3); **"Validate seo-pages.ts syntax" (line 509, `node scripts/ci/check-seo-pages-syntax.mjs`) is now dead weight, not just site-specific: `create-article.mjs`'s own code (lines 8458-8469) documents that it stopped writing `services/seo/seo-pages.ts` entirely once #4983/#4997 made the count/list derived at emit time — this step validates a file the generator no longer touches. Drop it in the same commit that removes this workflow, don't port it.**; "Trigger deploy workflow" (`trigger-deploy.sh`); "Trigger fast-publish workflow" (dispatches `fast-publish-article.yml`, a main-only site workflow); **"Trigger corpus mirror" (dispatches `mirror-articles-corpus.yml` with a PAT — this step is deleted, not carried over, the moment the generator itself moves, since there's no longer anything in main to mirror)**; the self-trigger dispatch chain (mints/re-mints an App token to call `workflow_dispatch` on itself, alternating `frontaliere`/`svizzera` sections — this loop moves to nanako in spirit but needs its own App/PAT identity there, not main's `APP_ID`/`APP_PRIVATE_KEY`). |
| `crawl-events.yml` | `GITHUB_TOKEN` | none | none | Everything except the one soft-fail step. `crawl-tio-agenda.mjs`, `crawl-guidle-events.mjs`, `crawl-myswitzerland-events.mjs`, `crawl-ge-agenda.mjs`, `assemble-events-dataset.mjs`, the `tests/events-pipeline.test.ts` gate, and the `data/events.json`/`data/events/by-source/*` commit are a **site data pipeline, not article generation** — none of it moves (§0.2). Only `node scripts/generate-events-digest-article.mjs || echo "::warning::..."` (one step) and its target files (`services/locales/blog-body/*/eventi-weekend-ticino.ts`, part of `git-add-resolved.mjs`'s explicit file list at the "Commit dataset" step) are in scope, and even those are entangled with `public/sitemap-blog.xml` being committed in the SAME step (line 186) — see §0.3's write-conflict finding; this must be untangled before the script moves, not after. |
| `generate-border-wait-ranking-weekly.yml` | `GITHUB_TOKEN` | none | none | None beyond the script itself — this workflow is clean: checkout, install, run script, vitest gate (`tests/border-wait-ranking.test.ts`, `tests/border-wait-ranking-content.test.ts`, `tests/blog-body-typescript-syntax.test.ts` — the first two are content-shape tests that could plausibly move with the generator; the third (`blog-body-typescript-syntax`) is a generic corpus-file syntax gate, ambiguous — see §6), commit, trigger deploy. It also writes `public/data/border-wait-ranking.json`, the live chart's data file — **STAYS main** (or REWIRE: nanako computes the ranking, main's pull script picks up the JSON), it is not article content, it feeds `InlineBorderWaitRanking`, a site component. |
| `publish-journalist-articles.yml` | `CLAUDE_CODE_OAUTH_TOKEN`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `GITHUB_TOKEN` | none | `./.github/actions/setup-omniroute`, `./.github/actions/setup-claude-haiku-fallback` | Reads Firestore `journalist_articles` (`FIREBASE_SERVICE_ACCOUNT_JSON`) — this is main's journalist-dashboard backing store, a site feature; the queued→published state transition and the dashboard itself stay in main regardless of where the actual file-writing runs. "Check live internal links" (`check-journalist-article-links.mjs` — checks links against the LIVE site, must run post-deploy, i.e. after nanako→main pull, not as part of generation). "Validate seo-pages.ts syntax" (line 88 — same dead-weight finding as `generate-article.yml` above: `seo-pages.ts` is no longer written by the generator this workflow shares code with; drop, don't port). "Trigger fast-publish workflow(s)" (dispatches `fast-publish-article.yml` per published id — main-only). Firestore write-then-git-commit ordering is the source of the documented 2026-07-16 orphan incident (4 articles published in Firestore, never committed) — moving the commit target from "this repo" to "an API call into nanako" reproduces the same failure class with a network hop instead of a git push, and needs the same resolver-on-conflict discipline nanako-side. |
| `batch-faq-articles.yml` | `APP_ID`, `APP_PRIVATE_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `GITHUB_TOKEN` | none | `./.github/actions/setup-omniroute`, `./.github/actions/setup-claude-haiku-fallback` | "Prepare Firebase credentials" / "Load RC secrets" (`load-rc-env.mjs` pulls `GH_MODELS_PAT` and provider keys from Firebase Remote Config — this is main's config surface; nanako needs either its own RC project or a copied subset of keys, an explicit secret-provisioning decision, not automatic); "Mint App token" (`APP_ID`/`APP_PRIVATE_KEY`, main's GitHub App installation — scoped to `valerielinc-ops/frontaliere-si-o-no`, will not have push rights to nanako without a separate installation or the `GITHUB_PAT`/`GITHUB_PAT_NANAKO` Remote Config param already established in the "Established facts"); "Fix FAQ locales" step calls `scripts/fix-faq-locales.mjs`, which was NOT one of the six named producers in the issue but is a corpus writer in its own right (writes `services/locales/blog-body/**`) — **MOVE with the batch-FAQ script**, flag as a 7th producer the issue undercounted. |
| `rerender-article-corpus.yml` | `FIREBASE_SERVICE_ACCOUNT_JSON`, `GITHUB_TOKEN`, `SHARD_ARTICOLIFRONTALIERE_{IT,EN,DE,FR}_DEPLOY_KEY`, `SHARD_ARTICOLISVIZZERA_{IT,EN,DE,FR}_DEPLOY_KEY` | none | none | **The entire workflow.** `contents: read` only, no commit, no push to main or nanako — it renders and pushes straight to 4+4 locale-shard repos. Not a corpus producer (§0.1); nothing here is in scope for the move. Its `push:` trigger paths (`build-plugins/ogPagesPlugin.ts` etc.) and its dependency on `services/locales/**` full-text body files are the concrete evidence for open question 1 in §6. |

## 5. Ordered cutover plan

Each step assumes it runs from a session with nanako write access, after this document. Each
has an explicit rollback.

1. **Resolve open question 1 (§6) first — main's post-move corpus-storage shape.** Everything
   below assumes main keeps *some* full-text mirror (today's `packages/articles/` tree, kept
   in sync some way) rather than shrinking to JSON/sitemap-only, because `rerender-article-corpus.mjs`
   (§2/§4) needs full body text and nothing in this migration proposes changing that. If the
   real target is JSON-only, this plan's step ordering is still valid but step 6 changes
   substantially (rebuild `rerender-article-corpus.mjs`'s input path, out of scope here).
   *Rollback: none needed, this is a decision gate, not a code change.*

2. **Stand up the moved code in nanako without cutting main over.** Copy `scripts/lib/**`
   (MOVE set, §2), the six producer scripts + `fix-faq-locales.mjs`, and the six workflows
   (rewritten to write into nanako's own tree, with nanako's own secrets — provision
   `ARTICLES_APP_ID`/`ARTICLES_APP_PRIVATE_KEY` or reuse `GITHUB_PAT_NANAKO`, nanako's own
   Remote Config subset or copied static secrets, nanako's own `test:articles`-equivalent
   subset built from `article-seo-fallback`/`article-duplicate-detection`/`article-tax-content-guard`
   which are content tests, not `related-articles`/`whats-new` which are rendering tests and
   stay behind). Leave main's copies running in parallel, untouched. *Rollback: delete the
   nanako-side workflows/branch; zero main-side risk, nothing was touched yet.*

3. **Wire the REWIRE set (§2)**: `data/border-wait-averages.json` fetched over HTTP from the
   live site instead of read from a repo file; `data/news-sitemap-whitelist.ts`'s eligibility
   logic vendored into nanako (as code, not a live call — it changes rarely and a live
   dependency on main from nanako's generation path would invert the intended one-way
   architecture). Validate against a frozen snapshot of real `create-article.mjs` output
   (generate N articles both ways, diff). *Rollback: no main-side change yet.*

4. **Dry-run nanako's generator with `workflow_dispatch`, writes disabled** (`--dry-run` /
   equivalent), comparing its emitted body/meta/SEO files byte-for-byte against what main's
   current generator would have produced for the same synthetic input. *Rollback: n/a, no
   writes.*

5. **Extend `pull-articles-api.mjs` for the two gaps this migration creates**: the hero-image
   manifest (§3) and, per the §3 recommendation, a pull+prune path for `sitemap-news.xml`
   candidate entries nanako now computes. Ship and verify this BEFORE cutting the generator
   over — main must be able to receive what nanako will produce before nanako starts producing
   it for real. *Rollback: revert the `pull-articles-api.mjs` change; main's existing pulls
   (sitemaps/RSS/ticker) are unaffected since this only adds artifacts.*

6. **Cut over one workflow at a time, in ascending blast-radius order**, disabling the main-side
   cron and enabling the nanako-side one for each, watching one full cycle before the next:
   1. `batch-faq-articles.yml` (lowest write-frequency site coupling — no dashboard, no Firestore)
   2. `generate-border-wait-ranking-weekly.yml` (weekly, single evergreen article, easy to eyeball)
   3. `crawl-events.yml`'s digest step only — extract `generate-events-digest-article.mjs`'s
      call out of `crawl-events.yml` into its own small main-side dispatch-to-nanako step (or a
      nanako-side cron that reads main's `data/events.json` over HTTP — REWIRE, since events
      data itself stays in main); do NOT move the rest of `crawl-events.yml` (§0.2/§4)
   4. `publish-journalist-articles.yml` (Firestore-coupled — highest incident risk, per the
      2026-07-16 orphan precedent; needs the same publish-then-confirm discipline nanako-side)
   5. `generate-article.yml` (highest volume, self-trigger loop — cut over last, and drop its
      "Trigger corpus mirror" step in the SAME commit that disables the main-side cron, not
      before: leaving the mirror dispatch in place with nothing left to mirror is harmless, but
      removing it one step early, while main's generator is still the last writer, would let
      nanako's published surface go stale silently — exactly the failure `mirror-articles-corpus.yml`'s
      own header comment warns about)

   *Rollback per sub-step: re-enable the main-side cron, disable the nanako-side one. Both
   sides' code stays in the repo (nothing deleted until step 8), so this is a config flip, not a
   revert.*

7. **Verify all six producers have actually stopped writing the corpus in main** — do not assert
   this, check it: `git log --since="<cutover date>" -- packages/articles/ services/locales/blog-body
   services/locales/blog-body-ch data/blog-articles-data.ts data/swiss-articles-data.ts` on main
   should show zero commits authored by any of the six workflows' bot identities
   (`github-actions[bot]` commits with the six workflows' distinctive commit-message prefixes —
   `📅`/`🛂`/`📰`/`❓`/the generate-article commit format) after the last one's cutover date. If
   anything still lands, that producer isn't actually off yet — go back to step 6 for it.

8. **Delete `mirror-articles-corpus.yml` only after step 7 is clean for a full week** (covers
   the slowest cron, `batch-faq-articles.yml`'s daily + weekly border-wait, with margin) **and**
   `pull-articles-api.mjs`'s pulls (including the two new artifact types from step 5) have been
   green for the same window — i.e., main is demonstrably living off nanako's published surface,
   not off its own last-mirrored snapshot. *Rollback: `mirror-articles-corpus.yml` is a git
   revert away; nothing else depends on its absence, so restoring it costs nothing if step 7's
   verification turns out to have missed a producer.*

9. **Remove the moved files from main** (`scripts/lib/**` MOVE set, the six-plus-one producer
   scripts, the COPY-vs-duplicate files once nanako's copies are proven independently correct,
   `packages/articles/engine/**`'s generator-only exports if any — verify none of `siteShell.ts`/
   `ogPagesPlugin.ts`/etc. import anything generator-side first). *Rollback: `git revert`; this
   step is pure deletion, the highest-confidence step to reverse cleanly since nothing else in
   main references these paths once step 7/8 confirm the producers are silent.*

## 6. Open questions main alone cannot answer

1. **What does main keep of the corpus after the move?** Today's architecture doc
   (`mirror-articles-corpus.yml`'s own comment) says nanako "republishes it as JSON + sitemaps
   that this site consumes" and `pull-articles-api.mjs`'s header says main is "a CONSUMER: it
   fetches those artifacts over HTTP... instead of generating them from an in-tree copy of the
   corpus." But `rerender-article-corpus.mjs` (§2/§4) needs full per-locale body *text*, not
   JSON summaries, and nothing in `pull-articles-api.mjs` fetches that. Either main keeps
   `packages/articles/content/blog-body/**` synced by SOME mechanism (a mirror in the other
   direction, ironically), or `rerender-article-corpus.mjs`'s whole reason for existing (SSG
   rendering off nanako's source) needs to be redesigned as part of — or explicitly deferred
   past — this migration. This session cannot see nanako's intended shape to answer it.
2. **Does nanako have (or will it get) an equivalent CI gate to `npm run test:articles`?**
   Those tests currently run against main's `services/locales/**`/`vitest` setup. Porting the
   3 content-focused ones (`article-seo-fallback`, `article-duplicate-detection`,
   `article-tax-content-guard`) needs nanako's own vitest config and fixtures; whether that
   exists or needs building from scratch is unknown from here.
3. **Secret/identity provisioning for nanako's six workflows** — a real GitHub App installation
   scoped to nanako (mirroring `APP_ID`/`APP_PRIVATE_KEY`), or reuse of the `GITHUB_PAT_NANAKO`
   Remote Config param already referenced in the established facts; which Remote Config project
   nanako's `load-rc-env.mjs`-equivalent points at; whether `CLAUDE_CODE_OAUTH_TOKEN` (a Max-plan
   subscription token) can/should be shared across both repos' Actions or needs its own grant.
   None of this is visible or decidable from main.
4. **`data/news-sitemap-whitelist.ts`'s vendoring plan (§2, §3)** — is nanako willing to own a
   second copy of Google News eligibility logic that must be kept in sync with main's by hand,
   or does the team want a real shared-package answer (e.g. publish it as a tiny versioned npm
   package both repos install)? This is a product/ops call, not something the file contents
   settle.
5. **Whether `scripts/fix-faq-locales.mjs` (§4, the 7th undercounted producer) was meant to be
   in scope for #4974 item 3 at all**, since it wasn't named in the issue's six. Flagging it here
   is necessary (it writes the corpus and would silently keep writing into main's now-stale copy
   if forgotten) but deciding its priority relative to the six named ones needs the issue owner.
6. **`tests/blog-body-typescript-syntax.test.ts`'s home** — it's a generic "does every corpus
   `.ts` body file parse" gate, run by both `crawl-events.yml` and
   `generate-border-wait-ranking-weekly.yml`. It could reasonably move with the corpus (nanako
   should not accept unparseable body files either) or stay in main as a defense-in-depth check
   on whatever `pull-articles-api.mjs`/a future full-text sync brings in. Depends on the answer
   to question 1.

---

*Methodology note: the transitive-closure counts in §1 came from a throwaway Node script doing
regex-based import/require resolution with symlink-aware `realpath`, run once per producer entry
point, plus manual verification of every `readFileSync`/`execSync` call site with a non-literal
argument (traced back to its constant definition by hand). The script was not added to the repo
and no tooling from this exercise was committed.*
