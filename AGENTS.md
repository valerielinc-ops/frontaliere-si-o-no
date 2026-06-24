# Project Agent Instructions

Iniettato in ogni sessione agent. Detail durevole nei docs, carica on-demand.

## Non-Negotiables

1. Mai abbassare quality threshold/test tolerance/validation/SEO gate per passare build. Fix root cause. (NB: il moratorium SEO-landing è stato rimosso/declassato a tracking il 2026-06-24 — non è più un gate; vedi `## Static SEO Pages`.)
2. Mai downgrade error → warning per sbloccare deploy.
3. Job page structured data DEVE includere in ogni locale: `baseSalary`, `postalCode`, `streetAddress`, `title`, `description`, `datePosted`, `hiringOrganization.name`, `jobLocation`, `employmentType`. Source mancante → safe default, non rimozione check.
4. Mai accettare thin content indicizzato <50 parole.
5. Test fail → trattare test come right finché non provato contrario.
6. Changes chirurgiche: no drive-by refactor, no speculative abstraction, no formatting churn. «Chirurgico» = la *classe* del bug, NON il singolo file. Per fix di pattern (regex/replace/guard/floor/threshold/selector): prima di aprire PR, `grep` dei sibling funnel-critical (`scripts/update-*.mjs`, `build-plugins/**`, `services/seoService.ts`) per lo stesso costrutto → fixa l'intera classe nella STESSA PR, oppure giustifica OGNI sibling non toccato in `## Non implementato`. **Non costruire la grep a mano: `node scripts/ci/check-sibling-patterns.mjs` (zero-Claude) la automatizza** — estrae i costrutti distintivi (costanti `SCREAMING_SNAKE`, helper camelCase, moduli kebab) che il diff ha toccato e lista i file non toccati che li condividono → includili nel fix o giustificali. Euristico (candidati, non verdetto): conferma a mano. Pre-empt del 🔴 reviewer "stesso antipattern nel file gemello" (bucket `sibling-class-fix` ×7 in 14gg, #1348) → risparmia un ciclo review+fix (~3M token quota Max). **Stessa disciplina sul RENAME:** rinominato un simbolo/costante/funzione/dominio → `grep` del vecchio nome anche in **commenti, docblock, header di script, titolo PR/commit** nella STESSA PR (non solo nel codice eseguibile). Un commento o un titolo che descrive ancora il meccanismo vecchio = 🟡 stale ricorrente (6 PR cluster CDN #1185–1311: jsDelivr→cdn-domain, orphan-branch→Pages). Una regex/costante duplicata letteralmente in ≥2 file → estraila in UN modulo condiviso (es. `build-plugins/shared/spaBundleRx.ts`) invece di copy-paste, così il drift è impossibile by-construction.
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
- **Base worktree = `origin/main`, MAI il local `main` checkout.** Sempre `git fetch origin main` poi `git worktree add -b <branch> <path> origin/main`. Il local `main` può essere **centinaia di commit dietro** (es. visto 945) e con working tree sporco di **foreign work** (esperimenti abbandonati, `data/jobs/*.json` stale): branchare da lì = base vecchia + rischio di committare il dirty. Branchare da `origin/main` parte fresh senza toccare il local `main`.
- Mai edit/stage/stash/restore/commit/rebase/merge sul local `main` salvo richiesta esplicita user. File dirty su `main` = lavoro foreign, intoccabile — verità è `origin/main` (`git show origin/main:<file>`, non il checkout locale, anche per diagnosi). Se l'user chiede esplicito di sincronizzare un local `main` stale+dirty: `git stash push -u` (backup) → `git reset --hard origin/main`; se fallisce con `Entry '...' not uptodate` ma `git status` è clean = racy-index (~19k file) → fix canonico `rm -f .git/index && git reset --hard HEAD`. NON committare mai il dirty.
- Parallel/subagent → sempre worktree isolati, mai shared dir.
- Auto commit+push task successful. PR-as-merge-vehicle: create PR, squash merge, delete remote branch, remove worktree.
- Repo setting `delete_branch_on_merge: true` attivo (2026-05-29): GitHub **cancella in automatico il branch remoto a OGNI merge** (auto-merge workflow, `gh pr merge`, o merge via UI/API), non solo con `--delete-branch`. **MA scatta SOLO sul merge, MAI sulla chiusura-senza-merge:** una PR `CLOSED` non-merged lasciava il ref remoto orfano → ora chiuso dal trigger `pull_request: [closed]` in `worktree-branch-janitor.yml` (job `delete-closed-unmerged`) che cancella subito il head ref di una PR chiusa-non-mergiata (skip fork/protected); il cron resta rete di sicurezza (≤24h). Quindi i branch remoti NON devono più accumularsi: se ne vedi di merged/closed ancora su origin è un'anomalia da segnalare. Il branch **locale** + **worktree** restano comunque a carico dell'agent: rimuovili nello stesso turn del merge. Audit periodico: `git branch -r` deve mostrare solo `main` + PR realmente aperte.
- PR body OBBLIGATORIO con `## Implementato` (cosa fa) + `## Non implementato (ancora)` (scope NON fatto + motivo: out of scope / follow-up / blocked / posposto). Reviewer automatico legge per gating. Vedi `REVIEW.md`. **Contenuto accurato obbligatorio** (non solo header presente — `pr-body-contract.yml` valida solo la presenza): ogni bullet in `## Implementato` DEVE corrispondere a una modifica reale nel diff (`git diff origin/main` prima di `gh pr create`); `## Non implementato (ancora)` DEVE elencare scope specifici con motivo, MAI bullet vuoto (`- ` senza testo) né placeholder `TBD`/`N/A`. Un `## Implementato` che afferma "Nessun sibling da sweepare" quando il diff mostra sibling cambiati = 🟡 reviewer-finding (cluster PR #1508, bucket `pr-body-contract`, 8 occorrenze 14gg).
- Se la PR rende **moot/obsoleta** una issue aperta (es. riscrive il file che un'issue di hardening voleva ritoccare) → DEVE dichiararlo nel body: `Closes #N` (chiude davvero al merge, GitHub nativo) per le issue il cui scope è interamente coperto, oppure `Supersedes #N` (link senza chiudere) se solo parziale. `post-merge-followup.yml` segnala automaticamente con un commento `🔗 Possibile supersede` le issue `follow-up` aperte sui file toccati, ma **non chiude su euristica**: la chiusura è solo via `Closes #N` esplicito. Niente issue orfane (cfr. #934 lasciata aperta da #943).
  - **Multi-issue: UNA keyword per issue, UNA per riga.** GitHub chiude SOLO la prima issue dopo una keyword di chiusura (`Closes`/`Fixes`/`Resolves`). `Closes #a #b #c` su una riga chiude solo `#a` → `#b`/`#c` restano aperte (cfr. PR #1320: 9 issue su una riga → 8 rimaste aperte). Scrivi sempre `Closes #a` / `Closes #b` su righe separate (o ripeti la keyword inline: `Closes #a, closes #b`). Il gate deterministico `pr-body-contract.yml` (zero-Claude) flagga la riga multi-issue a ogni open/edit della PR; il reviewer ha la stessa regola in `REVIEW.md`.
- PR ready per `main` → reviewer Claude posta review e `auto-merge-on-lgtm.yml` mergia automaticamente se il review body contiene la stringa esatta `## LGTM`. L'agent NON deve mergere a mano: aspetta che `gh pr view <N> --json state` ritorni `MERGED`, poi cleanup worktree + branch locale. Gating: `## LGTM` → auto-merge; `🔴 Important` o 🔴 process "missing sections" → no `## LGTM`, no auto-merge, agent legge la review e applica fix in nuovo commit sullo stesso branch (re-review automatica). Altre CI (test/lighthouse/build) NON attese — osserva su `main` post-merge. **NIENTE merge manuale, mai.** Anche le PR che modificano `.github/workflows/pr-review-loop.yml` (l'unico file che fa driftare il reviewer: GitHub App esige il workflow byte-identico a `main` → 401 → niente `## LGTM`) ora auto-mergiano via il **drift-fallback deterministico** in `scripts/ci/auto-merge-eval.mjs`: quando manca `## LGTM` e non c'è `🔴`, ma la PR tocca un `REVIEW_WORKFLOW_DRIFT_FILES`, è di autore fidato (owner/membro/collaboratore o bot interno) e ha `pr-body-contract` verde → approva su gate deterministici (vitest + collision restano). L'agent aspetta `MERGED` come sempre. Gli altri file storicamente citati (`auto-merge-on-lgtm.yml`, `post-merge-followup.yml`, `REVIEW.md`, `FOLLOWUP.md`) NON driftano → review + `## LGTM` normali.
- **Attesa PR = watch ATTIVO nel turno, MAI stop idle (causa #1 di "agent addormentato").** Merge (`auto-merge-on-lgtm`) e review (`pr-review-loop`) sono eventi GitHub Actions/Cloudflare → **l'harness NON li traccia → non ti re-invoca da solo**. Se chiudi il turno dopo `gh pr create`/push senza watch, resti fermo finché l'utente non ti nudga = percezione di "addormentato" (PR #2000: 42min senza check; PR #1031: poller silenzioso da 30min). Regola: dopo open/update di una PR **non chiudere il turno finché non è risolta** — gira un poll BREVE ricorrente in background until-loop (`gh pr view <N> --json state,reviews` ogni ~30-60s) fino a stato terminale (`MERGED` / `## LGTM` / `🔴 Important`), e **posta una riga di status a ogni cambio** ("review IN_PROGRESS, ricontrollo tra ~3min"). Per stato esterno non tracciabile usa **ScheduleWakeup come heartbeat di fallback** (delay ~270s per restare nella cache TTL 5min, o 1200s+ se il segnale cambia lento), MAI 300s netti (worst-of-both sulla cache) né wakeup lunghi+idle senza status. Sequenza da sorvegliare: review post → `## LGTM`/🔴 → `auto-merge-on-lgtm` → `state: MERGED` → cleanup worktree+branch → verifica deploy/live. (Dettaglio in MEMORY `active_pr_watch` / `no_idle_waiting_on_external_ci`.)
- **Workflow-validation drift (reviewer non parte, anche se la PR NON tocca i workflow):** la GitHub App del reviewer esige che `.github/workflows/pr-review-loop.yml` (e gli altri workflow di review) sul branch PR siano **byte-identici** alla versione su `main`. Se `main` aggiorna uno di quei file **dopo** che hai branchato, il branch resta indietro → il job `review` fallisce in <2min con `App token exchange failed: 401 Unauthorized — Workflow validation failed. The workflow file must have identical content to the version on the default branch`, body review vuoto, nessun `## LGTM`, niente auto-merge. NON è un problema di auth (l'OIDC token è ottenuto correttamente; `anthropic_api_key: ""` nel log è falso indizio — l'auth è via `secrets.CLAUDE_CODE_OAUTH_TOKEN`) e re-run è inutile. **Fix:** `git fetch origin main && git merge origin/main` nel branch (allinea i workflow), poi push → review run fresco con validation OK. Profilassi: fai `merge origin/main` prima di aspettarti il reviewer, dato che `main` si muove veloce.
- Post-merge check/deploy fail → mai fix diretto su `main`; nuovo worktree+branch, fix root cause, nuova PR, merge, riosserva `main`.
- Pre-task-close: audit worktree/branch. PR merged → delete remote branch + remove worktree immediato. Not merged → lascia + dichiara decisione merge/abandon esplicita.
- **Leak locale di worktree/branch (osservato 2026-06-03: 7 worktree+38 branch locali, 33 orfani).** Il cleanup ancorato all'evento-merge nel turn dell'agent NON copre 3 buchi: (a) **EnterWorktree** auto-rimuove la *dir* worktree se unchanged ma **lascia il branch `worktree-agent-<id>`** orfano (0-ahead); (b) **squash-merge**: GitHub auto-cancella il remoto (`delete_branch_on_merge`) ma il branch **locale** resta e `git branch --merged` lo vede *unmerged* (lo squash riscrive) → mai potato; (c) **sessione morta/timeout**: l'agent non raggiunge mai il pre-task-close. Mitigazione: il pre-task-close audit DEVE girare **`node scripts/prune-merged-worktrees.mjs`** (dry-run) e applicare con `--apply`. Lo script: rimuove worktree il cui branch ha PR `MERGED|CLOSED` o è detached/abbandonato; cancella i branch locali `worktree-agent-*` 0-ahead e i locali la cui PR è `MERGED|CLOSED`; **report-only** (mai auto-delete) per worktree clean con commit ahead e senza PR (lavoro pre-PR potenzialmente vivo). Il **case (c) è chiuso da DUE hook** (`.claude/settings.json`): (1) **SessionEnd** gira `prune-merged-worktrees.mjs --apply --orphans-only` (cancella SOLO i `worktree-agent-*` 0-ahead senza worktree — zero gh, zero fetch, istantaneo, safe non-presidiato); (2) **SessionStart** gira il **full** `--apply` in **background** (`( … & )`, non blocca l'avvio) → cattura i leftover delle sessioni morte (branch locali con PR `MERGED|CLOSED`, worktree canonici risolti) che l'orphans-only non vede. **Consultazione ISSUE-state** (script + cron): un branch `fix/issue-N` **senza PR** ma con **issue #N CLOSED** viene cancellato anche se ORFANO (checkout shallow → no common-ancestor → ahead non calcolabile); senza questo, EC1 lo risparmiava *per sempre* (`fix/issue-1183/1189/1497` bloccati ~12g). I worktree **Codex** (fuori dagli hook Claude) e i branch con remoto cancellato restano **report-only** con flag `upstream-GONE`. NB: lo script tocca SOLO worktree in `.claude/worktrees`/`.worktrees` (ISOLATION_RE) — un worktree in path non-canonico (es. `frontaliere-wt/`, off-spec) NON viene potato: non crearne fuori dalle dir canoniche. Le anomalie **remote** (branch merged/closed ancora su origin) le spazza il cron zero-Claude `worktree-branch-janitor.yml`: tutto via gh-API (no `actions/checkout`), valida `.ahead_by` come intero (orfano senza common-ancestor → report-only, non blob d'errore), consulta issue-state sui `fix/issue-N` no-PR (EC0), age-gate `STALE_DAYS=60` sui no-PR-con-commit (inattivo ≥60g = abbandonato → delete; sotto soglia = report-only, non distrugge WIP recente), + trigger `pull_request:[closed]` per la cancellazione immediata dei close-non-merged.
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

- **Auth Claude = SOLO `CLAUDE_CODE_OAUTH_TOKEN`** (subscription Max, zero costo $) per i workflow agentici che usano Claude: `pr-review-loop`, `issue-fix`, `post-merge-followup`. **Mai aggiungere `ANTHROPIC_API_KEY`** (secret inesistente; l'`ANTHROPIC_API_KEY: ""` vuoto nei log è solo la action che sonda un secret assente, innocuo — non causa i fallimenti).
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

- **Test fixture: mai date assolute.** Test con pipeline a stale-prune temporale (es. `cleanup-jobs.mjs`, soglia 60gg) → `crawledAt`/`datePosted` **relativi a now** (`daysAgo(n)`), mai literal tipo `'2026-04-01'`. Date hardcoded = time-bomb: superata la soglia il job viene pruned-stale invece di seguire il path testato → suite rossa su **puro confine di calendario**, senza code change (outage main-red 2026-06-01, fix #1035: red quando le date crossarono i 60gg).
- **main rosso blocca a cascata.** `auto-merge-on-lgtm` fira su `## LGTM` **senza attendere vitest**, ma il vitest-red su `main` resta e **ogni branch lo eredita** finché non fa `merge origin/main` (PR mergiano red, la red non si pulisce). Priorità assoluta: tenere `main` verde; se rosso, fixare la root cause prima di ogni altro lavoro di pipeline.
- **Blocker ≠ stallo: rimuovi il blocco, non solo segnalarlo.** Se la TUA PR non auto-mergia per un gate rosso (main-red pre-esistente, test, CI), NON fermarti a «apro issue + riporto bloccato»: una PR ferma non consegna niente (vale anche per `/goal` autonomi — il goal è la modifica *live*, non una PR in limbo). Prima di dichiarare «fuori scope» DEVI: (a) **cercare un fix già esistente** (`git log`/PR/issue recenti sullo stesso sintomo — spesso un'altra PR l'ha già risolto: rifai `git merge origin/main` + ri-esegui il gate localmente); (b) **stimare il costo del fix reale indagando la pipeline**, non assumendo; (c) confermare che tocca davvero un dominio che non puoi/devi cambiare. Solo allora «fuori scope» è lecito — altrimenti procedi al fix (PR separata se è concern diverso). Errore #1831: main-red da bot-data-commit (`titleByLocale`/`slugByLocale` mancanti → `tests/job-locale-completeness.test.ts`) dichiarato fuori scope e solo segnalato (#1835) quando era GIÀ fixato a monte (#1840), bastava `merge origin/main`; e il fix vero era a portata perché `data/jobs.json` è **generato in CI** (non committato) → un floor in `normalizeParsedJobsForSlice`/proiezione lo verde senza toccare dump bot-owned. Lezione: indaga la fattibilità del fix PRIMA di concludere «out of scope».
- **Data-refresh che committa su `main` = stesso gate test di una PR (bot-direct-to-main).** Un workflow che pusha dati diretti su `main` (es. `sync-gsc-orphans`, `discover-404s` → `data/seo-404-compat-paths.json`) DEVE validare l'invariante impattato **prima del commit**, non poisonare `main` con un dump che viola un test committed-snapshot. Pattern: prune dei record invalidi pre-commit (`scripts/prune-404-compat-paths.ts` droppa i path che `resolveSearchConsoleCompatTarget` non mappa → `tests/search-console-compat.test.ts` resta verde). Senza gate, un commit `github-actions[bot]` non presidiato manda main rosso senza PR colpevole (outage 2026-06-02: ~83min drain congelato). Mai committare dump grezzo non validato; cap ragionevole sul file (anti-bloat).
- **Claim build/perf/memoria non validabile pre-merge → dichiara il trigger di revert in `## Non implementato`.** I path SSG-emit memory (`build-plugins/jobsSeoPagesPlugin.ts`, `build-plugins/shared/seoPageShell.ts`, worker pool, `POST_WALK_WORKERS`) e i claim wall-time NON sono verificabili sul `pull_request` (il `build:ci` OOM-prone gira solo post-merge su `main`). Mergiare un claim "atteso GREEN/−NNN MB" su sufficienza speculativa brucia un ciclo deploy 30-90min se regredisce (pattern #795/#802 → revert #822; reviewer REVIEW.md step 7 lo flagga ogni volta, 5 PR #1185–1311). Regola: niente claim verde fabbricato; o alleghi un run misurato (mem-curve dai `[mem]` log / wall-time da Actions), o scrivi in `## Non implementato` la riga esplicita di revert-trigger ("se il prossimo deploy OOMa o wall-time regredisce → revert"). Il reviewer accetta il claim non validato SOLO con questa dichiarazione; senza, è 🔴.

## Architecture

- React 19 + TypeScript + Vite + Tailwind.
- No React Router. Routing hand-rolled in `services/router.ts`; `App.tsx` owns navigation state.
- Canonical prod domain: `https://frontaliereticino.ch` (no `www`).
- **Trailing slash obbligatorio su OGNI nuovo link/route/URL.** Convenzione canonica del sito: `buildPath()` (`finish()` in `services/router.ts`) e `joinPath()` (`build-plugins/weeklyEmployersData.ts`) lo forzano già; canonical/sitemap/og:url lo usano; CF Worker + GitHub Pages 301-redirectano no-slash→slash. Mai hardcodare URL senza slash finale (es. in email/CF/script/`trackPageView`) — preferisci `buildPath({activeTab:...}, locale)` invece di stringhe a mano (slash by-construction). Un href/URL letterale senza slash = doppione non-canonico (301 in più). Pre-PR: grep dei nuovi `href=`/URL string nel diff → verifica lo slash.
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
- SEO landing moratorium **RIMOSSO** (owner 2026-06-24): nuove build-plugin SEO landing sono consentite. La posizione media 7-day GSC (`data/gsc-position-rolling.json`) resta **tracciata** per valutare lo status, ma è solo informativa — `scripts/check-seo-moratorium.mjs` è report-only (always exit 0) e lo step CI in `deploy.yml` è `continue-on-error`, mai bloccante. Razionale: perdere traffico SEO reale / servire 404 agli utenti (es. ~14k/giorno di pagine `ricerca-stipendio-*` indicizzate andate 404) vale più della metrica-vanity di posizione media. NON re-introdurre un gate bloccante sulla posizione senza richiesta esplicita owner.

## Accessibility And UX

- Nuova pagina richiede: SEO metadata, sitemap coverage, accessibility check, translated key in tutti 4 locali (se user-facing text).
- Contrast min: 4.5:1 normal, 3:1 large.
- Mai `text-slate-400` su bg chiari.
- Button → accessible name. Image → `width`, `height`, `alt`.
- No `dark:` color class salvo `dark:prose-invert`; usa semantic token in `index.css`.
- User-facing feature → entry in `WhatsNewModal.tsx`.

## Reference Docs

CI/CD `docs/CI-CD-PIPELINE.md` · SEO rules `docs/SEO-RULES.md` · SEO gates `docs/SEO-GATES.md` · SEO features `docs/SEO-FEATURES.md` · Crawlers `docs/CRAWLERS.md` · Cathedral plan `docs/CATHEDRAL-IMPLEMENTATION-PLAN.md` · Rollback `docs/CATHEDRAL-ROLLBACK.md` · Design `docs/DESIGN-CONTEXT.md` · Local dev `docs/LOCAL-DEV.md` · GitNexus `docs/GITNEXUS.md`
