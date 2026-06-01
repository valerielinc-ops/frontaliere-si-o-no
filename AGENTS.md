# Project Agent Instructions

Iniettato in ogni sessione agent. Detail durevole nei docs, carica on-demand.

## Non-Negotiables

1. Mai abbassare quality threshold/test tolerance/validation/SEO gate/moratorium per passare build. Fix root cause.
2. Mai downgrade error → warning per sbloccare deploy.
3. Job page structured data DEVE includere in ogni locale: `baseSalary`, `postalCode`, `streetAddress`, `title`, `description`, `datePosted`, `hiringOrganization.name`, `jobLocation`, `employmentType`. Source mancante → safe default, non rimozione check.
4. Mai accettare thin content indicizzato <50 parole.
5. Test fail → trattare test come right finché non provato contrario.
6. Changes chirurgiche: no drive-by refactor, no speculative abstraction, no formatting churn.
7. Mai disabilitare AdSense Auto Ads (anchor/in-page/vignette). Mai globale, per-route, loader gating, `enable_page_level_ads:false`, meta opt-out. ~95% revenue. CLS/layout fix da Auto Ads → reserve space (`min-height`/`aspect-ratio`/`contain: layout`), pre-declared `<ins>` placeholder fixed dim, image/font width-height fix. MAI sopprimere ad system.

## Privacy

- Git identity canonica: `Valerie Linc <valerielinc@gmail.com>`. Mai altre identità.
- Pre-commit PII scan vs `.git/info/pii-blocklist.txt` (untracked, per-clone). Mancante → prompt user.
  - Scan: `git diff --cached | grep -niE -f .git/info/pii-blocklist.txt` + same per commit-msg file.
  - Match → abort + chiedi sanitize.
- Strip `Co-authored-by:` con email non canonica.
- Mai committare absolute home `/Users/<anyone>/...`. Usa relative, `$HOME`, `~`, `git rev-parse --show-toplevel`, env.
- Mai hard-code personal email in code/config/data. Usa env (`process.env.*`) o canonical.
- Stringa in diff dubbia → chiedi user.

## Workflow

- Worktree-first obbligatorio per task che edita/committa/pusha. Local `main` checkout = shared/read-only (status/inspection).
- **Base worktree = `origin/main`, MAI il local `main` checkout.** Sempre `git fetch origin main` poi `git worktree add -b <branch> <path> origin/main`. Il local `main` può essere **centinaia di commit dietro** (es. visto 945) e con working tree sporco di **foreign work** (esperimenti abbandonati di agent precedenti su `deploy.yml`, output crawler `data/jobs/*.json` stale): branchare da lì = base vecchia + rischio di trascinare/committare il dirty. Branchare da `origin/main` parte fresh senza toccare il local `main`.
- Mai edit/stage/stash/restore/commit/rebase/merge sul local `main` salvo richiesta esplicita user. File dirty su `main` = lavoro foreign, intoccabile — verità è `origin/main` (`git show origin/main:<file>`, non il checkout locale, anche per diagnosi). Se l'user chiede esplicito di sincronizzare un local `main` stale+dirty: `git stash push -u` (backup) → `git reset --hard origin/main`; se fallisce con `Entry '...' not uptodate` ma `git status` è clean = racy-index (repo ~19k file) → fix canonico `rm -f .git/index && git reset --hard HEAD`. NON committare mai il dirty.
- Parallel/subagent → sempre worktree isolati, mai shared dir.
- Auto commit+push task successful. PR-as-merge-vehicle: create PR, squash merge, delete remote branch, remove worktree.
- Repo setting `delete_branch_on_merge: true` attivo (2026-05-29): GitHub **cancella in automatico il branch remoto a OGNI merge** (auto-merge workflow, `gh pr merge`, o merge via UI/API), non solo quando il merge passa da `--delete-branch`. Quindi i branch remoti NON devono più accumularsi: se ne vedi di merged ancora su origin è un'anomalia da segnalare. Il branch **locale** + **worktree** restano comunque a carico dell'agent: rimuovili nello stesso turn del merge. Audit periodico: `git branch -r` deve mostrare solo `main` + PR realmente aperte.
- PR body OBBLIGATORIO con `## Implementato` (cosa fa) + `## Non implementato (ancora)` (scope NON fatto + motivo: out of scope / follow-up / blocked / posposto). Reviewer automatico legge per gating. Vedi `REVIEW.md`.
- Se la PR rende **moot/obsoleta** una issue aperta (es. riscrive il file che un'issue di hardening voleva ritoccare) → DEVE dichiararlo nel body: `Closes #N` (chiude davvero al merge, GitHub nativo) per le issue il cui scope è interamente coperto, oppure `Supersedes #N` (link senza chiudere) se solo parziale. `post-merge-followup.yml` segnala automaticamente con un commento `🔗 Possibile supersede` le issue `follow-up` aperte sui file toccati, ma **non chiude su euristica**: la chiusura è solo via `Closes #N` esplicito. Niente issue orfane (cfr. #934 lasciata aperta da #943).
- PR ready per `main` → reviewer Claude posta review e il workflow `auto-merge-on-lgtm.yml` mergia automaticamente se review body contiene la stringa esatta `## LGTM`. L'agent NON deve mergere a mano: aspetta che `gh pr view <N> --json state` ritorni `MERGED`, poi cleanup worktree + branch locale. Gating: `## LGTM` → auto-merge; `🔴 Important` o 🔴 process "missing sections" → no `## LGTM`, no auto-merge, agent legge la review e applica fix in nuovo commit sullo stesso branch (re-review automatica). Altre CI (test/lighthouse/build) NON attese — osserva su `main` post-merge. **Eccezione:** PR che modifica `.github/workflows/pr-review-loop.yml`, `.github/workflows/auto-merge-on-lgtm.yml`, `.github/workflows/post-merge-followup.yml`, `REVIEW.md` o `FOLLOWUP.md` → workflow-validation failure GitHub App, reviewer non posta, auto-merge non scatta → merge manuale via `gh pr merge --squash --delete-branch`; verifica su prossima PR organica.
- **Workflow-validation drift (reviewer non parte, anche se la PR NON tocca i workflow):** la GitHub App del reviewer esige che `.github/workflows/pr-review-loop.yml` (e gli altri workflow di review) sul branch PR siano **byte-identici** alla versione su `main`. Se `main` aggiorna uno di quei file **dopo** che hai branchato, il branch resta indietro → il job `review` fallisce in <2min con `App token exchange failed: 401 Unauthorized — Workflow validation failed. The workflow file must have identical content to the version on the default branch`, body review vuoto, nessun `## LGTM`, niente auto-merge. NON è un problema di auth (l'OIDC token viene ottenuto correttamente) e re-run è inutile. `anthropic_api_key: ""` nel log è un falso indizio: l'auth è via `secrets.CLAUDE_CODE_OAUTH_TOKEN`. **Fix:** `git fetch origin main && git merge origin/main` nel branch (allinea i workflow), poi push → review run fresco con validation OK. Profilassi: fai `merge origin/main` prima di aspettarti il reviewer, dato che `main` si muove veloce.
- Post-merge check/deploy fail → mai fix diretto su `main`; nuovo worktree+branch, fix root cause, nuova PR, merge, riosserva `main`.
- Pre-task-close: audit worktree/branch. PR merged → delete remote branch + remove worktree immediato. Not merged → lascia + dichiara decisione merge/abandon esplicita.
- GitHub operations: `gh` CLI only.
- Mai `send-newsletter.mjs --send` locale. Usa `--preview` o `--test --target-email <email>`.
- Nuovi GitHub Actions workflow → run live su `main` post-merge: `gh workflow run <workflow>.yml --ref main`.
- E2E: Playwright CLI o Codex Browser. No preview-only tools.
- Playwright MCP (`browser_*`): artifact (screenshot/network dump) SOLO in `$CLAUDE_JOB_DIR/tmp` o worktree root — MAI `/tmp` (fuori allowed-roots → "File access denied") né `file://` (protocol blocked, servi via http). Prima di `browser_click`/`browser_evaluate` su pagina dinamica → `browser_snapshot` fresco (ref vecchi → "Ref eXXX not found"). MCP gira `--isolated` (profilo in-memory) → niente lock "Browser already in use" tra job paralleli.
- Touch function/class/method → GitNexus impact analysis prima. Pre-commit → GitNexus detect changes. **In worktree** passa esplicito `repo:"frontaliere-si-o-no"` a `detect_changes`/`impact`/`context`: l'index è keyed sul nome del repo principale, l'auto-detect manda il path del worktree → `Repository "...wt..." not found. Available: frontaliere-si-o-no`.
- Mai full build locale; trigger/validate via GitHub Actions.

## Post-merge feedback handling

- Reviewer bot posta 🔴/🟡/❓ in review body. **Mai silent ignore di 🟡/❓.** Workflow `post-merge-followup.yml` triagia automaticamente post-merge: legge PR body `## Non implementato` + reviewer 🟡/❓/adversarial-check, applica filtro scopo (`REVIEW.md`), crea issue `follow-up` + summary commento sulla PR. Contratto in `FOLLOWUP.md`.
- 🔴 Important blocca merge (auto-merge richiede `## LGTM`). Se compare 🔴 → fix in nuovo commit sullo stesso branch, re-review automatica.
- Agent inizio task DEVE controllare `gh issue list --label follow-up --state open` se tocca area correlata. Issue follow-up esistente per scope corrente → linkare nel PR body (`## Implementato` chiude issue con `Closes #N`) o aggiornare l'issue con rationale.
- Test plan PR body con `- [ ]` non spuntate post-merge → spunta dopo verifica live, oppure converti in issue follow-up. Reviewer flagga come 🟡 quelle non verificabili pre-merge (vedi `REVIEW.md → "Test plan compliance"`).
- Eccezione drop senza issue: nit puro stilistico-deferibile (non funnel) → reply inline sulla PR review thread con motivo "deferred — non funnel-critical". `post-merge-followup.yml` lo include automaticamente nella sezione "Dropped" del summary.

## Auth automazioni & frugalità quota

- **Auth Claude = SOLO `CLAUDE_CODE_OAUTH_TOKEN`** (subscription Max, zero costo $) per i workflow agentici che usano Claude: `pr-review-loop`, `issue-fix`, `post-merge-followup`. **Mai aggiungere `ANTHROPIC_API_KEY`** (secret inesistente; l'`ANTHROPIC_API_KEY: ""` vuoto nei log è solo la action che sonda un secret assente, innocuo — non è la causa dei fallimenti).
- **Quota condivisa**: l'OAuth token attinge alla STESSA quota Max della sessione interattiva owner. Burst di run CI → session limit esaurito anche per l'uso interattivo. Frugalità = ridurre il **numero di invocazioni Claude** → si ottiene per **architettura**, non tagliando turni.
- Leve frugalità attive:
  - **`issue-triage` = ZERO Claude** (classificazione regex in bash) → eliminati ~50 run Claude/giorno, il driver principale del session-limit.
  - **Dedup a monte**: titolo stabile per validation-failure (`github-issue-creator.mjs` commenta 🔁 sull'issue canonica, 8→1) + follow-up batchati in 1 issue aggregata/PR (#925, era N) → meno issue → meno trigger `issue-fix`.
  - Concurrency serializzata (`cancel-in-progress: false`); routing salta le issue non-OPEN.
  - **Mai** abbassare max-turns di `pr-review-loop`/`issue-fix`/`post-merge-followup`: turni bassi troncano prima degli step obbligatori → `error_max_turns` (PR #838). Lever su turni = claim non misurato (#795/#802 revertati).

## Issue automation (loop autonomo)

- Pipeline: monitor → issue → `issue-triage` (classify+route **deterministico, no Claude**; applica `agent:fix` via `GITHUB_PAT` da RC) → `issue-fix` (fix→PR) → `pr-review-loop` (`## LGTM`) → `auto-merge-on-lgtm` (merge via PAT) → deploy → `post-merge-followup` (batch 1 issue/PR). Contratto completo in `ISSUES.md` / `FOLLOWUP.md`.
- **Auto-route consentito**: `crawler`, `follow-up`. **Mai** `revenue`/`tracker`/`validation-failure` (strategico o transiente → label manuale o `/fix-issue`).
- **Dedup a MONTE, non nel triage**: i monitor non devono aprire issue duplicate. Usa `scripts/lib/github-issue-creator.mjs` con **titolo stabile** (no run-number/timestamp nei primi 60 char) → dedupa e commenta sull'issue canonica. I follow-up: 1 issue aggregata/PR (`post-merge-followup` / `FOLLOWUP.md`, #925).
- **Handoff triage→fix richiede PAT**: una label `agent:fix` via `GITHUB_TOKEN` NON triggera `issue-fix` (anti-ricorsione GitHub) e ha sender `github-actions[bot]` che non passa il gate. Stesso vincolo del cascade merge→deploy (#844/#880). I workflow che devono triggerarne altri caricano `GITHUB_PAT` via `scripts/load-rc-env.mjs` (serve Firebase SA).

## Build And Test

```bash
npm run dev
npm run build
npm test
```

Agent sessions ereditano `FAST_BUILD=1`; override per validare SEO plugin output:

```bash
FAST_BUILD= npx vite build
```

Full local SEO builds OOM. Usa remote CI o audit replay; no full local SEO build salvo richiesta esplicita user. Audit replay dist-only:

```bash
gh workflow run audit-dist-from-run.yml -f deploy_run_id=<run_id> -f audits=<audit-list>
```

CI test gate: `npm ci`, `node scripts/assemble-jobs-dataset.mjs --stats`, `node scripts/migrate-all-known-job-slugs-canton-aware.mjs`, `npm test`.

- **Test fixture: mai date assolute.** Test con pipeline a stale-prune temporale (es. `cleanup-jobs.mjs`, soglia 60gg) → `crawledAt`/`datePosted` **relativi a now** (`daysAgo(n)`), mai literal tipo `'2026-04-01'`. Date hardcoded = time-bomb: superata la soglia il job viene pruned-stale invece di seguire il path testato → suite rossa su **puro confine di calendario**, senza code change (outage main-red 2026-06-01, fix #1035: green 05-30 → red 06-01 quando le date crossarono i 60gg).
- **main rosso blocca a cascata.** `auto-merge-on-lgtm` fira su `## LGTM` **senza attendere vitest**, ma il vitest-red su `main` resta e **ogni branch lo eredita** finché non fa `merge origin/main`. Quindi un main rosso ferma di fatto il drain (PR mergiano red, la red non si pulisce). Priorità assoluta: tenere `main` verde; se rosso, fixare la root cause prima di ogni altro lavoro di pipeline.

## Architecture

- React 19 + TypeScript + Vite + Tailwind.
- No React Router. Routing hand-rolled in `services/router.ts`; `App.tsx` owns navigation state.
- Canonical prod domain: `https://frontaliereticino.ch` (no `www`).
- Primary locale Italian; EN/DE/FR via chunked locale files in `services/locales/`.
- Nav caps: 6 top-level tabs, 8 sub-tabs/category.

## Static SEO Pages

- Static SSG page emit via build plugin DEVE usare `build-plugins/shared/seoPageShell.ts` → `buildSeoPageHtml`.
- Static plugin contract: `apply: 'build'`, `enforce: 'post'`, emit in `closeBundle()`, pass `distDir`.
- Body styling HTML statico: Tailwind utilities only. `tailwind.config.js` content DEVE includere `./build-plugins/**/*.{js,ts}`.
- SPA/static handoff = router-driven via `staticOverlay`; mai reintrodurre DOM heuristic per `main.seo-static-content`.
- Mobile-first: real content subito dopo H1/tagline. Long intro/methodology/FAQ sotto action/data area o in accordion collassati.
- SEO landing order: breadcrumb, header con one-line lede ≤120 chars, 3-5 stat tile, advice banner se utile, primary CTA, data area, prose lunga.
- Solo semantic color token esistenti; no inline hex.
- Crawler dedicati: merge job by stable id `extractStableJobId(job.url)`, preserva previous slug, truncate via `truncateSlugAtWordBoundary`.
- SEO automation moratorium: no nuove build-plugin SEO landing finché `data/gsc-position-rolling.json` 7-day avg position >7.5. Eccezioni: bug fix, net-reducing consolidation, redirect/bridge emitter.

## Accessibility And UX

- Nuova pagina richiede: SEO metadata, sitemap coverage, accessibility check, translated key in tutti 4 locali (se user-facing text).
- Contrast min: 4.5:1 normal, 3:1 large.
- Mai `text-slate-400` su bg chiari.
- Button → accessible name. Image → `width`, `height`, `alt`.
- No `dark:` color class salvo `dark:prose-invert`; usa semantic token in `index.css`.
- User-facing feature → entry in `WhatsNewModal.tsx`.

## Reference Docs

CI/CD `docs/CI-CD-PIPELINE.md` · SEO rules `docs/SEO-RULES.md` · SEO gates `docs/SEO-GATES.md` · SEO features `docs/SEO-FEATURES.md` · Crawlers `docs/CRAWLERS.md` · Cathedral plan `docs/CATHEDRAL-IMPLEMENTATION-PLAN.md` · Rollback `docs/CATHEDRAL-ROLLBACK.md` · Design `docs/DESIGN-CONTEXT.md` · Local dev `docs/LOCAL-DEV.md` · GitNexus `docs/GITNEXUS.md`

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **frontaliere-si-o-no** (32055 symbols, 69220 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/frontaliere-si-o-no/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/frontaliere-si-o-no/context` | Codebase overview, check index freshness |
| `gitnexus://repo/frontaliere-si-o-no/clusters` | All functional areas |
| `gitnexus://repo/frontaliere-si-o-no/processes` | All execution flows |
| `gitnexus://repo/frontaliere-si-o-no/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
