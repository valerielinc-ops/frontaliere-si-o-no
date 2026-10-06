# scripts/lib — shared infrastructure for validators and audits

This directory contains shared modules used by `scripts/validate-*.mjs` and
`scripts/audit-*.mjs`. Validators and audits run in three different contexts
(local dev, deploy CI build step, post-deploy validation), and the helpers
here normalise the differences so a single script works in all of them.

## resolve-data-path.mjs — dataset path resolver

`scripts/validate-*.mjs` and `scripts/audit-*.mjs` that read a JSON dataset
under `data/` MUST go through this helper. Hardcoding `data/<file>.json`
breaks `post-deploy-validation.yml`: that workflow only restores the
GitHub Pages artifact, so the dataset lives at `dist/data/<file>.json` (and
`public/data/<file>.json` after the workflow's compatibility copy), but
NOT at `data/<file>.json`. CI run 25393472881 caught this with a raw
`ENOENT` stack trace, rc=1 in 0.21s. The fix landed in commit
`8e436754a0` (validate-jobs-quality) and was extracted into this helper as
a follow-up so every validator gets the same behaviour.

### Resolution priority

`resolveDataPath(filename)` and `requireDataPath(filename, ctx)` walk this
candidate list in order and return the first that exists:

| Order | Path                              | Used by                                              |
| ----- | --------------------------------- | ---------------------------------------------------- |
| 1     | `<repo>/data/<file>`              | local dev, pre-push hook, deploy.yml `build:ci` step |
| 2     | `<repo>/dist/data/<file>`         | post-deploy-validation.yml (Pages artifact restore)  |
| 3     | `<repo>/public/data/<file>`       | post-deploy-validation.yml (workflow compat copy)    |

Both functions accept an explicit `candidates` array if the default order
is wrong for a specific caller. Each entry MUST be an absolute path.

### Two flavours

- **`resolveDataPath(filename)`** — soft. Returns the resolved absolute
  path or `null`. Use when the script has a sensible no-op fallback for
  the missing-dataset case (e.g. "no jobs to validate, exit 0").
- **`requireDataPath(filename, ctx)`** — hard. Same lookup, but on miss
  prints a CI-friendly error naming every tried path + recovery hint and
  exits with code 2. Use whenever the script cannot run without the
  dataset.

### Exit-code contract

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| 0    | Validation passed.                                                   |
| 1    | Real validation regression — the dataset was present and bad.        |
| 2    | Infra/sequencing failure — dataset not reachable in any candidate.   |

Distinguishing 1 from 2 lets the GH Actions log + GitHub issue route the
incident correctly: a code-2 failure is an infrastructure problem (missing
artifact, wrong working directory, deploy mid-rollout) and the playbook is
to re-run the workflow or fix sequencing, NOT to investigate data quality.
A code-1 failure is the script's job to diagnose — the rule it tripped on
appears in stdout.

### When to use which

- New validator that reads `data/<X>.json`? → `requireDataPath('X.json',
  'validate-X')`. Always.
- Validator that has multiple optional inputs (e.g. baseline + report) and
  can run with one of them missing? → `resolveDataPath` for each, branch
  on null.
- Validator only ever invoked from `prepush` / `build:ci` (where
  `assemble-jobs-dataset.mjs` runs first and `data/` is guaranteed to be
  populated)? → still use `requireDataPath`. The cost is zero and the
  helper protects against future use from a context that doesn't pre-fill
  `data/`.

### Audited callers (post-deploy-validation.yml)

These scripts read a `data/` JSON file AND are invoked from
`post-deploy-validation.yml` where `data/` is not pre-populated. They MUST
go through the resolver:

- `scripts/validate-jobs-quality.mjs` (jobs.json)
- `scripts/validate-translation-completeness.mjs` (jobs.json)

Scripts that read `data/` JSON files committed to the repo (baselines —
`bfs-depth-baseline.json`, `text-html-ratio-baseline.json`,
`orphan-pages-baseline.json`, `spa-bundle-injection-baseline.json`) do
NOT need the resolver: the file is always at `<repo>/data/<file>` because
checkout populates it. If a baseline is ever moved to be runtime-generated
(gitignored), the corresponding audit MUST switch to the resolver.

## generated-image-engine.mjs — governed generated imagery

`packages/articles/engine/shared/generatedImageRegistry.mjs` is the provider-
independent contract mirrored to the corpus. It owns the prompt policy,
registry validation and `verifyPublishedEventImages()` gate. The mirrored Node
adapter `packages/articles/engine/shared/generatedImageEngine.mjs` is the only
provider boundary; `scripts/lib/generated-image-engine.mjs` is a site-side
compatibility re-export:

- `generateImageFromSpec(spec, options)` accepts `scope`, `subject`, `area`,
  `season` and a WebP format, then returns `{ filePath, record, prompt }`.
- The primary transport is `codex exec --enable image_generation`, using the
  Codex OAuth broker when `CODEX_AUTH_BROKER_SOCKET` is present. The broker
  copies the generated file from its private `CODEX_HOME/generated_images/`
  directory to the requested workspace output. Without the broker, the local
  CLI uses the same command and resolves the image under
  `$CODEX_HOME/generated_images/<thread-id>/`.
- The bounded fallback is Gemini `gemini-3.1-flash-image` via `GEMINI_API_KEY`.
  Secrets are loaded by Remote Config and never belong in the registry or PR.
- Every result is converted to 1200×675 WebP (≤220 KiB), marked with
  `trainedAlgorithmicMedia` plus the site credit, vision-checked and returned
  with its registry record. A record is the permission to publish the bytes.
- Provider attempts are bounded to three per asset and the event-library
  process has a hard 150-attempt budget; callers may still choose a lower
  `maxAttempts` for article, place or OG work.

The event-library CLI is:

```bash
node scripts/generate-event-image-library.mjs --limit 20
node scripts/upload-event-image-library-cdn.mjs --before-registry /tmp/previous.json
node scripts/verify-event-images.mjs
```

`--limit` is a count of new verified assets (the CLI accepts 0–150); the
workflow deliberately clamps it to 20 per run.

The first command writes local bytes to `.cache/event-image-library/` and the
versioned registry to `data/event-image-library.json`; the uploader publishes
only `images/events/library/<assetId>.webp` to R2. When `--before-registry` is
provided, unchanged records are retained only after an R2 existence check, so
a deleted object is scheduled for repair. The weekly workflow uses the same
interface with the OAuth broker and opens a data PR. The site article generator
also calls `generateImageFromSpec()` and persists its `article-hero` record;
future place/corpus generators must use the same contract rather than add a
second provider path.

The site's editorial-profile and place catalogue uses the same boundary:

```bash
npm run generate:editorial-images -- --only authors
npm run generate:editorial-images -- --only places
npm run validate:generated-images
```

The generator writes three 400×400 illustrated profile avatars, sixteen
1200×675 place views and their sixteen 480×270 thumbnails, keeping the
existing filenames and recording each byte in
`data/generated-image-registry.json`. The validator checks every file under
`public/images/authors/` and `public/images/places/` against that registry,
including the XMP/IPTC-marked WebP byte hash and dimensions. Author images are
uploaded to the existing CDN during deployment; place images and thumbnails
remain same-origin by contract.

The historical blog-cover repair lane uses the same contract with
`scope: 'article-hero'`: its verified bytes live at
`public/images/blog/<assetId>.webp`, while the matching `generated-provider`
record is written to
`packages/articles/content/image-credits/blog/`. The audit and queue scripts
are deliberately sparse-checkout friendly:

```bash
node scripts/audit/blog-cover-ledger.mjs --write data/blog-cover-ledger.json
node scripts/audit/materialize-blog-cover-ledger.mjs
node scripts/audit/generate-blog-cover-queue.mjs --limit 20
node scripts/audit/build-blog-image-credits-index.mjs
npm run validate:blog-cover-ledger
```

The queue has a hard 150-asset budget, prioritizes level-5 historical
replacements and then level-6 inferred covers by traffic/recency, and publishes
remaining work only through the scheduled data-PR workflow. Level-6 covers
remain on their article URL with an explicit `inferred`/`no-credit` entry until
generation completes. The SPA consumes the site-owned
`data/image-credits-blog.json` bridge when a section index does not yet contain
a generated article-hero record.

## published-image-policy.mjs — no unrecorded image leaves the site

`scripts/lib/published-image-policy.mjs` is the Node-side publication gate. A
third-party uploader must use `checkPublishedImageUrl(..., { requireCdn: true })`:
only CDN `/images/blog/`, `/images/events/library/` and `/images/generated/`
URLs with a valid generated-image registry record or an `imageCredits` record
whose status is `ok` pass. A CDN host or a file extension is not a licence.

The `og:image` build gate (`scripts/verify-og-images.mjs`) additionally permits
only the documented site-owned exceptions: `/og-image.png`, generated
`/og/jobs/`, `/og/seo/` and `/og/border-wait/` cards, author photos,
`/images/places/` and event catalog cards. Those exceptions are explicit in
`SITE_OWNED_OG_IMAGE_ALLOWLIST`; they are not accepted by LinkedIn uploads.
