# Cathedral Rollback Runbook

> Companion to [docs/CATHEDRAL-IMPLEMENTATION-PLAN.md](CATHEDRAL-IMPLEMENTATION-PLAN.md). Use when the CH-wide cathedral expansion (2026-05-10) needs to be partially or fully reverted.

## When to use

Trigger a rollback if any of the following occur after merge:

- **Deploy regression**: live site returns 500/404 on previously indexed canton URLs (e.g. `/cerca-lavoro-ticino/{slug}` 404s).
- **Slug-registry corruption**: `data/slug-registry.json` lost entries, duplicate fingerprints, or a reclassification broke frozen URLs (E9 contract violated).
- **Build OOM**: `vite build` runs out of memory on per-canton sharding or sitemap-index generation, blocking deploys.
- **SPA hydration failure**: per-canton lazy fetch (`fetchJobsForCanton`) breaks JobBoard for the default referrer-aware landing.
- **Sitemap regression**: Search Console reports drop in indexed jobs > 10 % within 48 h of merge.
- **Canton-quorum gate misfire**: jobs reclassified into wrong canton at scale (Liechtenstein leaks, off-by-one BFS, country-code bypass).

## Pre-merge safety net

Before merging `feat/cathedral-ch-wide`:

| Artifact | Value |
|---|---|
| Safety tag | `pre-cathedral-2026-05-10` |
| HEAD baseline | `58eb418c49` |
| Slug-registry snapshot | `data/slug-registry.pre-cathedral.snapshot.json` (committed alongside the tag) |

### Slug-registry snapshot procedure (mandatory pre-merge)

```bash
# Take snapshot from main BEFORE merging the cathedral PR
git checkout main
cp data/slug-registry.json data/slug-registry.pre-cathedral.snapshot.json
git add data/slug-registry.pre-cathedral.snapshot.json
git commit -m "chore: snapshot slug-registry pre-cathedral"
git tag pre-cathedral-2026-05-10
git push origin main pre-cathedral-2026-05-10
```

The snapshot file MUST be committed to `main` so the rollback path works without external artifact retrieval. Per outside-voice fix [8].

---

## Rollback steps

### Step (a) — Code revert

**Preferred path (clean revert via PR):**

```bash
git checkout main
git pull
git revert -m 1 <merge-commit-sha>
git push origin main
```

**Emergency path (when revert conflicts or speed is critical):**

```bash
git checkout main
git reset --hard pre-cathedral-2026-05-10
git push --force-with-lease origin main
```

> Force-push to `main` is a NON-NEGOTIABLE rule violation in normal operation — only acceptable here under explicit "emergency rollback" authorization. Notify the team channel before pushing.

### Step (b) — Slug-registry restore (if registry pollution)

If the cathedral run polluted `data/slug-registry.json` (reclassifications wrote unexpected mappings, fingerprint collisions, etc.):

```bash
# Option 1: from the in-repo snapshot (preferred)
cp data/slug-registry.pre-cathedral.snapshot.json data/slug-registry.json
git add data/slug-registry.json
git commit -m "rollback: restore pre-cathedral slug-registry"
git push

# Option 2: from a CI artifact, if the snapshot was archived to the cathedral PR run
gh run download <run-id> -n slug-registry-snapshot -D /tmp/snapshot
cp /tmp/snapshot/slug-registry.json data/slug-registry.json
git add data/slug-registry.json
git commit -m "rollback: restore pre-cathedral slug-registry from artifact"
git push
```

### Step (c) — Sitemap regeneration

After the registry is restored, regenerate sitemaps so indexed URLs match the restored registry:

```bash
npm run build:ci   # full build, includes sitemap generation
# or, if sitemap-only fast path exists:
node scripts/regenerate-sitemaps.mjs
```

Verify `dist/sitemap-index.xml` and per-canton shards match the pre-cathedral set (only `sitemap-jobs-ti.xml`, `sitemap-jobs-gr.xml`, `sitemap-jobs-vs.xml` if reverting fully; or the subset still shipping if partial rollback).

### Step (d) — Deploy

```bash
gh workflow run deploy.yml --ref main
gh run watch
```

Wait for `conclusion: success`. Then proceed to validation.

---

## Post-rollback validation

### Smoke test legacy TI URLs

Sample 5 high-traffic legacy Ticino job URLs and confirm 200 + correct canonical:

```bash
for slug in <slug1> <slug2> <slug3> <slug4> <slug5>; do
  curl -sI "https://frontaliereticino.ch/cerca-lavoro-ticino/$slug" | head -1
done
```

All five MUST return `HTTP/2 200`. If any return 404, the registry restore was incomplete — re-run step (b).

### Additional checks

- **GSC**: confirm no spike in 404 errors within 24 h of rollback.
- **Sitemap-index**: `curl https://frontaliereticino.ch/sitemap-index.xml` returns 200 and references only the expected per-canton shards.
- **JobBoard SPA**: `/cerca-lavoro-ticino/` loads, paginates, no console errors.
- **Slug-registry integrity**: `node scripts/validate-slug-registry.mjs` exits 0.

---

## Partial rollback options

If the cathedral is mostly working but one canton or one ATS client is broken, prefer surgical reverts over full rollback:

- **Single ATS client failure** → revert just `scripts/lib/ats-clients/{name}.mjs` and restart the affected crawlers.
- **Single canton misclassification** → tighten `canton-quorum-gate.mjs` thresholds, re-run dry-run flip (`scripts/dry-run-target-cantons-flip.mjs`), apply targeted slug-registry fixes.
- **Sitemap shard corruption only** → regenerate just sitemaps, no registry touch.

Full rollback (steps a–d) is reserved for systemic failures.
