# Issue Automation Instructions

Contratto operativo per la pipeline issue-agent: `issue-triage.yml` (classify + route **deterministico, no Claude**) e `issue-fix.yml` (fix → PR). Companion locale: `/fix-issue N` (`.claude/commands/fix-issue.md`).

## Scopo

Le issue di questo repo sono per lo più **auto-generate dai monitor** (post-deploy validate dist/live, crawler-health, rpm-canary, follow-up post-merge). Vanno instradate per categoria, non trattate da un singolo agent indistinto. Obiettivo: risolvere autonomamente le categorie deterministiche, lasciando alla mano umana solo lo strategico.

**Dedup a MONTE, non nel triage.** I duplicati non vanno chiusi dal triage (costerebbe un run per duplicato): vanno evitati alla sorgente. I monitor usano `scripts/lib/github-issue-creator.mjs` che, con **titolo stabile** (senza run-number), commenta 🔁 sull'issue canonica invece di aprirne una nuova. I follow-up sono **batchati in 1 issue aggregata per PR** da `post-merge-followup` (vedi `FOLLOWUP.md`, non N issue). Con i duplicati eliminati a monte, il triage si riduce a classificare+instradare → **puro bash, zero Claude, zero quota**.

## Categorie

| Categoria | Segnale (titolo/label) | Natura |
|---|---|---|
| `validation-failure` | "Validation Failure (dist\|live)", label `bug`+`priority:urgent` | alert post-deploy, spesso dupe/transiente |
| `crawler` | "Crawler Failure", "[crawler-health]", "[parser-health]", label `parser-broken` o `priority:high`+crawler/parser | selector drift, parser da rigenerare |
| `follow-up` | "follow-up(#NNN)", label `follow-up` | micro-task / verifica deferred |
| `revenue` | label `revenue` / `rpm-canary`, "RPM canary" | monetizzazione, strategico |
| `tracker` | "master tracker", "recovery", senza label automation | piano umano multi-step |
| `other` | nessun match | da triage manuale |

## Triage flow (`issue-triage.yml`, on `issues: opened`) — deterministico, no Claude

Step bash unico (`Classify and route`), nessuna `claude-code-action`:

1. **Classifica** via regex su titolo+label → UNA categoria (ordine conservativo: revenue/tracker prima, mai auto-fix). Vedi tabella "Categorie".
2. **`agent:triaged`** sempre (anti-loop, idempotente: gate `if: !contains(labels,'agent:triaged')`).
3. **Commento** solo per `revenue`/`tracker`/`validation-failure`/`other` (categorie che restano umane). Nessun commento sulle categorie auto-route (no rumore).
4. **Routing** (vedi sotto): `agent:fix` via PAT solo per `crawler`/`follow-up`, issue OPEN.

Nessun dedup-close: i duplicati sono evitati a monte (vedi "Scopo"). Misclassificazione regex → fail-safe su `other` (nessun auto-fix). Triage non legge più la lista delle issue aperte (era input-token che cresceva col backlog).

### Routing policy

| Categoria | Azione triage |
|---|---|
| `crawler` | **Auto-route `agent:fix` immediato** (`route='fix'`). Regen parser deterministico, basso blast-radius, coperto da `generate-company-parser.mjs`. Production-critical, non è il treadmill source. |
| `follow-up` | **Auto-route `agent:fix-queued`** (`route='queue'`, 2026-06-04) + `fu-prio:high\|low`. NON parte subito: `followup-drainer.yml` lo promuove a `agent:fix` UNO alla volta, solo a slot `issue-fix` libero (high prima). Fix della starvation (vedi "Drenare il backlog" sotto). |
| `validation-failure` | **NO auto-fix.** Spesso transiente; transiente-vs-persistente non è decidibile in modo deterministico (bash). Commento "verifica ricorrenza 🔁 prima di `agent:fix` manuale". |
| `revenue` / `tracker` | NO auto-fix MAI. Giudizio strategico → mano umana (`/fix-issue` locale o manuale). |
| `other` | NO auto-fix. Commento "needs manual triage". |

**Meccanismo di routing (PAT in bash)**: lo step `Classify and route` applica `agent:fix` **via `GITHUB_PAT` con `gh` diretto** (non in una claude-action), solo per `crawler`/`follow-up` e solo se l'issue è OPEN. Perché così:
- **PAT, non GITHUB_TOKEN**: un `labeled` da GITHUB_TOKEN non triggera `issue-fix` (anti-ricorsione) e ha sender `github-actions[bot]` che non passa il gate `sender == valerielinc-ops`. Col PAT (owner) trigger+gate OK. Pattern identico ad `auto-merge-on-lgtm.yml`.
- **Guard `state == OPEN`**: belt-and-suspenders contro race; niente `agent:fix` su issue chiuse.
- Senza PAT (RC non caricato) → skip + warning: routing inerte, mai fixer via GITHUB_TOKEN.

`revenue`/`tracker` restano opt-in manuale (mai automation cieca su revenue/funnel — AGENTS.md).

### Frugalità quota (no ANTHROPIC_API_KEY)

Tutte le automazioni Claude usano **solo `CLAUDE_CODE_OAUTH_TOKEN`** (Max sub, zero costo $) → condividono la quota della sessione interattiva owner. Burst di issue = quota esaurita. Frugalità per **architettura** (ridurre il numero di run Claude), non per taglio turni:

- **Triage = ZERO Claude**: classificazione regex in bash → eliminati ~50 run Claude/giorno (era il driver principale del session-limit).
- **Dedup a monte = meno issue → meno run a valle**: titolo stabile validation-failure (8→1 via 🔁) + batch follow-up 1-per-PR (era N) → molte meno issue aperte → molti meno trigger di `issue-fix`.
- **No fixer su issue non-OPEN**: il routing salta le issue chiuse.
- Concurrency `cancel-in-progress: false` serializza i fixer.
- **fix/review/followup restano Claude** (giudizio necessario): max-turns NON tagliati (quality gate; budget basso → `error_max_turns`, cfr. #795/#802/#838).
- **Residuo**: l'auto-route `follow-up` può auto-alimentarsi (fix→merge→followup→nuovo follow-up). Bound da: batch 1-issue/PR (meno volume), **coda drenata 1-alla-volta** (`followup-drainer`), gate `## LGTM`, e **terminazione autonoma** (`followup-drainer` parcheggia a `fu-attempt:3` → `fu-parked`, no loop infinito, no perdita). Un fix pulito non genera nuovi follow-up → converge.

## Fix flow (`issue-fix.yml`, on `issues: labeled == agent:fix`)

Trigger sull'aggiunta della label `agent:fix`. La label È il consenso. Può metterla l'owner (manuale) **o il triage** — quest'ultimo solo via `GITHUB_PAT` nello step `Apply agent:fix via PAT` (vedi "Meccanismo di routing" sopra; mai via `GITHUB_TOKEN`).

0. **Pre-flight already-resolved (zero-Claude, BEFORE the Claude step)** — `scripts/ci/check-issue-already-resolved.mjs`. Gate strutturale (#1647) contro il bucket ricorrente `fix-outcome:already-fixed`: molte follow-up sono **done-but-open** (risolte da una PR successiva senza `Closes #N`). Prima di spendere quota, se un token DISTINTIVO della regione `## Suggested action` è già presente **verbatim** nel file citato su main → short-circuit: rimuove `agent:fix`, posta commento + `<!-- FIX_OUTCOME: already-fixed -->`, emette `already_resolved=true` e gli step Claude vengono saltati (`if:`). CONSERVATIVO (bias a procedere — un false short-circuit dropperebbe un bug reale): solo follow-up **singole** (no aggregate "N items deferred"), **non-in-flight**, con match forte; aggregate/ambiguo/nessun match → procede e il fixer normale gira invariato. Matcher condiviso con `reconcile-followups.mjs` (`scripts/ci/followup-resolution-match.mjs`, single source of truth — no drift).
1. **Pre-condizioni** (abort con commento se falliscono):
   - PR aperta già citante la issue → skip ("PR già in volo").
   - **Overlap-file**: estrai i path target dal body issue; se una PR aperta (`gh pr list --state open` + `gh pr diff <n> --name-only`) **già modifica** uno di quei file → skip ("file già in volo in PR #N, evito conflitto/duplicazione; riaprire dopo il merge se pertinente"). Evita che il fixer corra su un file che un'altra PR sta riscrivendo (es. #934 vs #943). Issue non file-specifica → procedi.
   - Categoria `revenue`/`tracker` → abort con commento.
2. Branch `fix/issue-<N>`.
3. Diagnosi **root cause** (non sintomo). `crawler` → rigenera parser / edit mirato selector+config.
4. Fix **chirurgico** (AGENTS.md #6) sulla **classe** del bug, non sul singolo file. Per fix di pattern: **prima di pushare esegui `node scripts/ci/check-sibling-patterns.mjs`** (zero-Claude) — automatizza la grep dei sibling e lista i file non toccati che condividono i costrutti distintivi del diff → includili nel fix. **Post-#8: un sibling reale elencato in `## Non implementato` resta lavoro dovuto (task non chiuso → candidate follow-up tracciato), NON una chiusura**; l'unica giustificazione-che-chiude è il falso positivo (costrutto simile ma classe-di-bug diversa). Pre-empt del 🔴 reviewer "stesso antipattern nel file gemello" (bucket `sibling-class-fix`, #1348). Mai abbassare gate (#1). Mai disabilitare Auto Ads (#7).
5. Commit identity canonica `Valerie Linc <valerielinc@gmail.com>`. No path home assoluti, no email personali (Privacy).
6. Push branch + `gh pr create`.
7. PR body OBBLIGATORIO `## Implementato` (con `Closes #N`) + `## Non implementato (ancora)` (REVIEW.md completeness contract). Per chiudere PIÙ issue: una keyword per issue, una per riga (`Closes #a` / `Closes #b`) — MAI `Closes #a #b #c` su una riga (GitHub chiude solo `#a`; `pr-body-contract.yml` lo flagga). **Self-check contenuto prima di `gh pr create`**: `git diff origin/main` e verifica che ogni bullet di `## Implementato` sia visibile nel diff; `## Non implementato (ancora)` deve elencare scope specifici (`- motivo: ...`), MAI solo `- ` vuoto o placeholder. `pr-body-contract.yml` valida presenza degli header, non la precisione del contenuto — la precisione è responsabilità del fixer (cluster PR #1508/#1470/#1469/#1456, bucket `pr-body-contract`).
8. **Telemetria OBBLIGATORIA — ULTIMA azione del run:** posta sulla issue un commento con `<!-- FIX_OUTCOME: pr-created -->` (anche se non hai altri contenuti). Vale sia per il path happy (PR aperta) sia per ogni abort: usa il codice appropriato tra `pr-created` · `blocked-workflows-scope` · `blocked-secrets` · `blocked-admin-settings` · `no-root-cause` · `overlap-skip` · `pr-already-open` · `already-fixed` · `revenue-tracker-manual`. Senza marker → harvester classifica il run come `no-pr-unspecified`, indistinguibile da un crash silenzioso.
9. La PR fluisce in `pr-review-loop` → `## LGTM` → `auto-merge-on-lgtm`. **L'agent NON mergia a mano.**

### Tier (mirror di pr-review-loop)

| Tier | Trigger | Model / max-turns |
|---|---|---|
| high | issue tocca `crawler`/`parser`/`scripts/`/`build-plugin`/`.github/workflows/`/test gate | opus, 40 |
| normal | resto | sonnet, 30 |

### CODE vs DATA (no scroll dei blob — frugalità token, mirror del guard reviewer #1096)

I file rigenerati `data/**` (job JSON, snapshot, translation-cache, blog-articles), `public/**` (immagini/asset), `reports/**`, `_newsletter_variants/**` **NON sono code** da leggere riga-per-riga: scorrerli intero brucia token senza segnale (il reviewer lo evita via #1096; il fixer deve fare lo stesso).

- **Root cause su output dati = fixa il CODE che li genera** (parser/crawler/build-plugin), non editare il blob a mano né scorrere il file intero.
- Serve un campione di output? `Read` **mirato** (offset/limit) sul file, mai l'intero blob.
- `rg`/`grep` cross-file (diagnosi, pattern repetition) **scopati al code**: `rg <pattern> scripts build-plugins components services functions server hooks tests` (o `rg <pattern> -g '!data/**' -g '!public/**' -g '!reports/**'`).
- **Eccezione:** un file `data/**` checked-in che è **config/fixture** (non output rigenerato) e che il fix modifica a mano → trattalo come code.

### Abort senza PR (no fix forzato)

- Root cause non determinabile con confidenza → commento "serve indagine umana" + termina.
- Fix richiede credenziali/segreti non in CI → documenta + termina.
- **Capability-guard scope `.github/workflows/**` (valuta a turno ~1, PRIMA di implementare).** L'ambiente `issue-fix` ha solo `GH_TOKEN` (GitHub App, **senza scope `workflows`**) e nessun PAT → il push di file workflow fallisce **sempre**. Se la diagnosi mostra che il fix toccherebbe `.github/workflows/**` → posta il diff proposto + "serve PAT con scope `workflows` / mano umana" e **TERMINA SUBITO**, senza implementare. Idem per repo-setting/branch-protection/admin-API (es. `gh api .../branches/main/protection` → 403). Razionale (misurato): fare il fix e scoprire il blocco al push spreca ~1M token/run (#983 tier-high opus 23 turni 0 PR; vs #1009 early-exit 7 turni). Guard nel prompt di `issue-fix.yml` (#1033).
- Mai un fix speculativo pur di produrre una PR.
- **Ogni abort DEVE chiudere con `<!-- FIX_OUTCOME: <code> -->` nel commento** (codici abort: `no-root-cause` / `blocked-workflows-scope` / `blocked-secrets` / `blocked-admin-settings` / `overlap-skip` / `pr-already-open` / `already-fixed` / `revenue-tracker-manual`; lista completa allo step 8). Senza marker → harvester classifica il run come `no-pr-unspecified`, indistinguibile da un crash silenzioso → il pattern non è migliorabile.

### Drenare il backlog follow-up (`followup-drainer.yml`, automatico)

`issue-fix` ha `concurrency: { group: issue-fix, cancel-in-progress: false }`: GitHub tiene **un solo run pending** per gruppo e un nuovo trigger **cancella (supersede) il pending precedente**. Re-labelare `agent:fix` in raffica N follow-up → sopravvivono solo la prima (già `in_progress`) e l'ultima (pending); quelle in mezzo finiscono `cancelled` **silenziosamente** e restano `agent:fix` senza retry → backlog stuck (osservato 2026-06-04: ~20 issue; storicamente #974/#959/#960 droppate).

**Risolto da `followup-drainer.yml`** (cron ~20min + `workflow_run` dopo ogni `issue-fix` + dispatch, **zero-Claude**, `scripts/ci/followup-drainer.mjs`): i follow-up entrano come `agent:fix-queued` (non `agent:fix`); il drainer promuove **UNO** a `agent:fix` solo quando lo slot `issue-fix` è libero (in-flight==0) → la run promossa è l'unica pending → **mai cancellata-in-coda**. Ordine: `fu-prio:high` prima, poi più vecchia. Resta la protezione anti-pile-up (1 fixer alla volta = no OOM / no burst quota).

**Rescue + park (terminazione autonoma, no human):** un `agent:fix` follow-up orfano (run morta, nessuna PR `fix/issue-N`, `updatedAt` > 30min) viene ri-accodato con `fu-attempt:N`++; a `fu-attempt:3` → `fu-parked` (esce dalla coda attiva, **non chiuso**: ri-tentabile a mano). Solo a slot libero, così non tocca mai una run viva. Per ri-processare a mano un follow-up: applica `agent:fix-queued` (il drainer fa il resto) — non più `agent:fix` diretto.

## Local fixer (`/fix-issue N`)

Per le categorie strategiche (`revenue`, `tracker`) o issue HIGH-risk dove vuoi supervisione: worktree-first, GitNexus impact, approvazione umana prima del push.

> ⚠️ `.gitignore` ignora `.claude/` (eccetto `settings.json`), quindi il file del comando `/fix-issue` **non è version-controlled**: vive solo localmente in `.claude/commands/fix-issue.md`. Lo spec completo è riprodotto qui sotto (Appendice A) per ricrearlo su qualsiasi clone.

## Label

| Label | Significato | Chi la mette |
|---|---|---|
| `agent:fix` | opt-in: l'agent tenta un fix → PR | triage (`crawler`/`follow-up`, **via PAT**) o owner manuale |
| `agent:triaged` | issue già processata da triage | triage (anti-loop) |
| `duplicate` | storm-duplicate, chiusa | triage |

## Kill-switch

- Disattivare auto-fix di una categoria: in `issue-triage.yml` togliere la categoria dal ramo che applica `agent:fix`, oppure disabilitare il workflow da GitHub UI.
- Disattivare TUTTO l'auto-routing mantenendo classify/dedup: rimuovere il `GITHUB_PAT` da Remote Config (o azzerare la Firebase SA) → triage ripiega su `GITHUB_TOKEN` e le label `agent:fix` smettono di triggerare il fixer.
- Bloccare un singolo fix: rimuovere `agent:fix` dalla issue prima che il fixer apra la PR (concurrency serializza, c'è una finestra).
- Pausa totale: disabilitare `issue-fix.yml` / `issue-triage.yml` (Actions → workflow → Disable).

## Auto-improvement loop (`lessons-harvester.yml`, daily)

Chiude il feedback loop: i pattern ricorrenti rientrano nelle istruzioni → reviewer/fixer smettono di ripeterli → turnaround più basso. I doc (`AGENTS.md` iniettato ogni sessione, `ISSUES.md`/`REVIEW.md` letti nei prompt) **sono** il canale verso gli agent.

- **Telemetria (deterministica, no Claude)**: il fixer chiude ogni run col marker `<!-- FIX_OUTCOME: <code> -->` (codici elencati in "Fix flow" step 8). I reviewer-finding stanno già nei review body 🔴/🟡/❓ (REVIEW.md). Lo store è GitHub stesso (commenti/review), nessun file accumulatore.
- **Aggregazione**: `scripts/ci/harvest-agent-lessons.mjs` (zero-Claude, daily) conta su finestra 14gg, soglia ≥3: bucket reviewer-finding (tassonomia regex fissa) + fix-outcome bloccati. Le issue-class (crawler/follow-up/validation) sono **volume operativo, non lezioni** → contesto, mai driver di proposta. Dedup vs i doc-contract esistenti → tiene solo i cluster `novel`.
- **Proposta (1 turno Claude, solo se `has_novel`)**: redige aggiunte chirurgiche ai doc → apre **1 PR** `lessons/auto-harvest-*`. Nessun cluster nuovo = zero token. Una sola proposta pendente alla volta (guard su PR aperte).
- **Gate umano OBBLIGATORIO**: la PR di regole non è mai auto-mergiata (un'istruzione sbagliata degrada *tutti* gli agent). La rivede un umano. Solo `.md`, mai logica.
- **Kill-switch**: disabilita `lessons-harvester.yml` da Actions UI; oppure alza `THRESHOLD`/abbassa `WINDOW_DAYS` via `workflow_dispatch`.

## Guardrail (da AGENTS.md, vincolanti)

- Opt-in strategico: mai `agent:fix` automatico su `revenue`/`tracker`/`validation-failure`. Auto-route consentito solo su `crawler`/`follow-up`.
- Concurrency cap: un fixer/triage alla volta (no OOM, no PR concorrenti su stesso data file).
- PR sempre via reviewer + `## LGTM`; mai bypass auto-merge.
- Changes chirurgiche, root-cause, no drive-by.
- Privacy: identity canonica, no path home, no email personali.

---

## Appendice A — `.claude/commands/fix-issue.md` (local-only, non tracciato)

Salva questo contenuto in `.claude/commands/fix-issue.md` su ogni clone dove vuoi il comando `/fix-issue` (è gitignored, vedi sopra).

````markdown
---
description: Fix a GitHub issue locally with human supervision (worktree-first, GitNexus impact). For strategic/high-risk issues the CI fixer shouldn't auto-handle.
argument-hint: <issue-number>
allowed-tools: Bash(gh:*), Bash(git:*), Bash(npm:*), Bash(node:*), Read, Grep, Glob, Edit, Write
---

Fix locale supervisionato della issue **#$ARGUMENTS**.

Companion locale di `issue-fix.yml` (CI). Usalo per le categorie che la pipeline NON auto-fixa: `revenue`, `tracker`, o issue HIGH-risk dove vuoi controllo. Differenza chiave: **tu approvi prima del push**.

## Bootstrap
1. Leggi `ISSUES.md` → "Fix flow" e `AGENTS.md` (non-negotiables + Privacy + Workflow).
2. `gh issue view $ARGUMENTS --json number,title,body,labels,comments`.
3. Classifica la categoria (ISSUES.md → Categorie).

## Pre-condizioni
- PR aperta già citante `#$ARGUMENTS` → fermati (no doppione).
- Overlap-file: se una PR aperta modifica già un file target della issue (`gh pr list --state open` + `gh pr diff <n> --name-only`) → fermati (evita conflitto con lavoro in corso, es. #934 vs #943).
- Worktree-first obbligatorio: `git fetch origin main` + verifica `git rev-parse main` == `git rev-parse origin/main`; se divergono basa il worktree su `origin/main`.

## Flow
1. `git worktree add .claude/worktrees/fix-issue-$ARGUMENTS origin/main -b fix/issue-$ARGUMENTS`.
2. GitNexus impact PRIMA di editare function/class/method. HIGH/CRITICAL → fermati e avvisa.
3. Diagnosi root cause (non sintomo). `gitnexus_query` non grep cieco.
4. Fix chirurgico: no drive-by, no speculative abstraction. Mai abbassare gate, mai disabilitare Auto Ads.
5. STOP — mostra il diff e attendi approvazione umana prima di commit/push.
6. Dopo OK: `gitnexus_detect_changes()`, poi commit (identity `Valerie Linc <valerielinc@gmail.com>`, no path home, no email personali).
7. Push + `gh pr create`. Body `## Implementato` (`Closes #$ARGUMENTS`) + `## Non implementato (ancora)`.
8. PR → `pr-review-loop` → `## LGTM` → auto-merge. Attendi `MERGED`, poi rimuovi worktree + branch + ref remoto.

## Constraint
- Approvazione umana del diff prima del push.
- Una issue alla volta, changes chirurgiche.
- Reviewer + `## LGTM`; mai merge a mano (salvo eccezione workflow-file AGENTS.md).
````

