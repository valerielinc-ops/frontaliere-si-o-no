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

Distinguishing 1 from 2 lets the GH Actions log + Linear bot route the
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
