# Issue Automation Instructions

Contratto operativo per la pipeline issue-agent: `issue-triage.yml` (classify + route **deterministico, no Claude**) e `issue-fix.yml` (fix → PR). Companion locale: `/fix-issue N` (`.claude/commands/fix-issue.md`).

## Scopo

Le issue di questo repo sono per lo più **auto-generate dai monitor** (post-deploy validate dist/live, crawler-health, rpm-canary, follow-up post-merge). Vanno instradate per categoria, non trattate da un singolo agent indistinto. Obiettivo (2026-07-05, owner decision "Rimuovi tutte le guardie"): risolvere autonomamente OGNI categoria — la supervisione umana resta a valle (gate `## LGTM` del reviewer PR), non a monte.

**Dedup a MONTE, non nel triage.** I duplicati non vanno chiusi dal triage (costerebbe un run per duplicato): vanno evitati alla sorgente. I monitor usano `scripts/lib/github-issue-creator.mjs` che, con **titolo stabile** (senza run-number), commenta 🔁 sull'issue canonica invece di aprirne una nuova. I follow-up sono **batchati in 1 issue aggregata per PR** da `post-merge-followup` (vedi `FOLLOWUP.md`). Con i duplicati eliminati a monte, il triage si riduce a classificare+instradare → **puro bash, zero Claude, zero quota**.

## Categorie

| Categoria | Segnale (titolo/label) | Natura |
|---|---|---|
| `validation-failure` | "Validation Failure (dist\|live)", label `bug`+`priority:urgent` | alert post-deploy, spesso dupe/transiente |
| `crawler` | "Crawler Failure", "[crawler-health]", "[parser-health]", label `parser-broken` o `priority:high`+crawler/parser | selector drift, parser da rigenerare |
| `follow-up` | "follow-up(#NNN)", label `follow-up` | micro-task / verifica deferred |
| `revenue` | label `revenue` / `rpm-canary`, "RPM canary" | monetizzazione, strategico |
| `tracker` | "master tracker", "recovery", senza label automation | piano umano multi-step |
| `other` | nessun match | catch-all, natura eterogenea |

## Triage flow (`issue-triage.yml`, on `issues: opened`) — deterministico, no Claude

Step bash unico (`Classify and route`), nessuna `claude-code-action`:

1. **Classifica** via regex su titolo+label → UNA categoria (ordine conservativo: revenue/tracker prima — guardia anti-collisione nomi azienda, es. "RPM Software AG" deve restare `revenue` non `crawler`). Vedi tabella "Categorie".
2. **`agent:triaged`** sempre (anti-loop, idempotente: gate `if: !contains(labels,'agent:triaged')`).
3. **Nessun commento per-categoria** (2026-07-05): ogni categoria è auto-fix, niente più branch "resta umana" da segnalare. Label + route sono il segnale.
4. **Routing** (vedi sotto): `crawler` → `agent:fix` via PAT immediato; ogni altra categoria → `agent:fix-queued` via PAT, issue OPEN.

Nessun dedup-close: i duplicati sono evitati a monte (vedi "Scopo"). Misclassificazione regex → fail-safe su `other`, che dal 2026-07-05 è comunque auto-fix via coda. Triage non legge più la lista delle issue aperte (era input-token che cresceva col backlog).

### Routing policy

| Categoria | Azione triage |
|---|---|
| `crawler` | **Auto-route `agent:fix` immediato** (`route='fix'`). Regen parser deterministico, basso blast-radius, coperto da `generate-company-parser.mjs`. Production-critical, non è il treadmill source. |
| `follow-up` | **Auto-route `agent:fix-queued`** (`route='queue'`, 2026-06-04) + `fu-prio:high\|low`. NON parte subito: `followup-drainer.yml` lo promuove a `agent:fix` UNO alla volta, solo a slot `issue-fix` libero (high prima). Fix della starvation (vedi "Drenare il backlog" sotto). |
| `validation-failure` | **Auto-route `agent:fix-queued`** (`route='queue'`, 2026-07-05). Spesso transiente; transiente-vs-persistente non è decidibile in modo deterministico (bash) — resta in coda, drenata come le altre, nessun commento speciale. |
| `revenue` / `tracker` | **Auto-route `agent:fix-queued`** (`route='queue'`, 2026-07-05, `fu-prio:high` di default — giudizio strategico ma non più opt-in manuale, owner decision "Rimuovi tutte le guardie"). Ordine di classificazione resta PRIMA di `crawler` (guardia anti-collisione nomi azienda). |
| `other` | **Auto-route `agent:fix-queued`** (`route='queue'`, 2026-07-05). Nessuna categoria riconosciuta ma comunque un tentativo di fix, priorità `low` salvo segnali `priority:high/urgent`. |

**Meccanismo di routing (PAT in bash)**: lo step `Classify and route` applica il label **via `GITHUB_PAT` con `gh` diretto** (non in una claude-action), solo se l'issue è OPEN — `agent:fix` immediato per `crawler`, `agent:fix-queued` per ogni altra categoria. Perché così:
- **PAT, non GITHUB_TOKEN**: un `labeled` da GITHUB_TOKEN non triggera `issue-fix` (anti-ricorsione) e ha sender `github-actions[bot]` che non passa il gate `sender == valerielinc-ops`. Col PAT (owner) trigger+gate OK. Pattern identico ad `auto-merge-on-lgtm.yml`.
- **Guard `state == OPEN`**: belt-and-suspenders contro race; niente label su issue chiuse.
- Senza PAT (RC non caricato) → skip + warning: routing inerte, mai fixer via GITHUB_TOKEN.

`revenue`/`tracker` non sono più opt-in manuale: entrano in coda come ogni altra categoria (vedi "Scopo").

### Frugalità quota (no ANTHROPIC_API_KEY)

Tutte le automazioni Claude usano **solo `CLAUDE_CODE_OAUTH_TOKEN`** (Max sub, zero costo $) → condividono la quota della sessione interattiva owner. Burst di issue = quota esaurita. Frugalità per **architettura** (ridurre il numero di run Claude), non per taglio turni:

- **Triage = ZERO Claude**: classificazione regex in bash → eliminati ~50 run Claude/giorno (era il driver principale del session-limit).
- **Dedup a monte = meno issue → meno run a valle** (vedi "Scopo"): validation-failure 8→1 via 🔁 → molti meno trigger `issue-fix`.
- **No fixer su issue non-OPEN**: il routing salta le issue chiuse.
- Concurrency `cancel-in-progress: false` serializza i fixer.
- **fix/review/followup restano Claude** (giudizio necessario): max-turns NON tagliati (quality gate; budget basso → `error_max_turns`, cfr. #795/#802/#838).
- **Residuo**: l'auto-route `follow-up` può auto-alimentarsi (fix→merge→followup→nuovo follow-up). Bound da: batch 1-issue/PR (meno volume), **coda drenata 1-alla-volta** (`followup-drainer`), gate `## LGTM`, e **terminazione autonoma** (vedi "Rescue + park"). Un fix pulito non genera nuovi follow-up → converge.

## Fix flow (`issue-fix.yml`, on `issues: labeled == agent:fix`)

Trigger sull'aggiunta della label `agent:fix`. La label È il consenso. Può metterla l'owner (manuale) **o il triage** — quest'ultimo solo via `GITHUB_PAT` nello step `Apply agent:fix via PAT` (vedi "Meccanismo di routing" sopra; mai via `GITHUB_TOKEN`).

0. **Pre-flight already-resolved (zero-Claude, BEFORE the Claude step)** — `scripts/ci/check-issue-already-resolved.mjs`. Gate strutturale (#1647) contro il bucket `fix-outcome:already-fixed`: molte follow-up sono **done-but-open** (risolte da una PR successiva senza `Closes #N`). Prima di spendere quota, se un token DISTINTIVO di `## Suggested action` è già presente **verbatim** nel file citato su main → short-circuit: rimuove `agent:fix`, posta commento + `<!-- FIX_OUTCOME: already-fixed -->`, emette `already_resolved=true`, step Claude saltati (`if:`). CONSERVATIVO (bias a procedere — un false short-circuit dropperebbe un bug reale): solo follow-up **singole** (no aggregate "N items deferred"), **non-in-flight**, con match forte; aggregate/ambiguo/nessun match → procede invariato. Matcher condiviso con `reconcile-followups.mjs` (`scripts/ci/followup-resolution-match.mjs`, single source of truth).
1. **Pre-condizioni** (abort con commento se falliscono):
   - PR aperta già citante la issue → skip ("PR già in volo").
   - **Overlap-file**: estrai i path target dal body issue; se una PR aperta (`gh pr list --state open` + `gh pr diff <n> --name-only`) **già modifica** uno di quei file → skip ("file già in volo in PR #N; riaprire dopo il merge se pertinente"). (rif. #934 vs #943). Issue non file-specifica → procedi.
2. Branch `fix/issue-<N>`.
3. Diagnosi **root cause** (non sintomo). `crawler` → rigenera parser / edit mirato selector+config.
4. Fix **chirurgico** (AGENTS.md #6) sulla **classe** del bug, non sul singolo file. Per fix di pattern: **il pre-push hook `.githooks/pre-push` (attivato da `npm ci` via `prepare`) esegue `check-sibling-patterns.mjs --strict` automaticamente** — se trova candidati il push è bloccato (exit 1) e li elenca; ispezionali TUTTI prima di riprovar il push. Per ogni candidato: stesso antipattern → fix nella STESSA PR; falso positivo (costrutto lessicalmente simile ma semanticamente diverso) → documenta in `## Non implementato` con giustificazione per-file, poi `git push --no-verify` (AGENTS.md #6 — bypass consentito SOLO con doc per-file). Un dismiss collettivo ("tutti falsi positivi") senza elenco è insufficiente: il reviewer rifirerà 🔴. **Post-#8: un sibling reale elencato in `## Non implementato` resta lavoro dovuto (task non chiuso → candidate follow-up tracciato), NON una chiusura**; l'unica giustificazione-che-chiude è il falso positivo. Pre-empt del 🔴 reviewer "stesso antipattern nel file gemello" (bucket `sibling-class-fix`, #1348). Mai abbassare gate (#1). Mai disabilitare Auto Ads (#7).
5. Commit identity canonica `Valerie Linc <valerielinc@gmail.com>`. No path home assoluti, no email personali (Privacy).
6. Push branch + `gh pr create`.
7. PR body OBBLIGATORIO `## Implementato` (con `Closes #N`) + `## Non implementato (ancora)` (REVIEW.md completeness contract). Per chiudere PIÙ issue: una keyword per issue, una per riga (`Closes #a` / `Closes #b`) — MAI `Closes #a #b #c` su una riga (GitHub chiude solo `#a`; `pr-body-contract.yml` lo flagga). **MAI `Closes #N` su una follow-up AGGREGATA multi-item** (titolo/body `N item deferred`, N≥2): il fixer lavora **1 item/run** (circuit-breaker), quindi un fix parziale NON chiude l'aggregata — `Closes` è GitHub-native, scatta al merge e bypassa il veto multi-item-auto-close di `FOLLOWUP.md` (nel cron `reconcile`), marcando COMPLETED un'issue con item ancora dovuti (recidiva #3050→#3036). Usa invece un **progress-ref senza keyword di chiusura** (es. `Addresses item N di #M`); l'aggregata si chiude SOLO quando TUTTI gli item sono fatti. `pr-body-contract.yml` (zero-Claude) flagga 🔴 il `Closes` su aggregata (riusa `isAggregate`). **Self-check contenuto prima di `gh pr create`**: `git diff origin/main` e verifica che ogni bullet di `## Implementato` sia visibile nel diff; `## Non implementato (ancora)` deve elencare scope specifici (`- motivo: ...`), MAI solo `- ` vuoto o placeholder. `pr-body-contract.yml` valida presenza degli header, non la precisione del contenuto — quella è responsabilità del fixer (cluster PR #1508/#1470/#1469/#1456).
8. **Telemetria OBBLIGATORIA — ULTIMA azione del run:** posta sulla issue un commento con `<!-- FIX_OUTCOME: pr-created -->` (anche se non hai altri contenuti). Vale sia per il path happy (PR aperta) sia per ogni abort: usa il codice appropriato tra `pr-created` · `blocked-workflows-scope` · `blocked-secrets` · `blocked-admin-settings` · `no-root-cause` · `overlap-skip` · `pr-already-open` · `already-fixed` · `revenue-tracker-manual`. Senza marker → harvester classifica il run come `no-pr-unspecified`, indistinguibile da un crash silenzioso.
9. La PR fluisce in `pr-review-loop` → `## LGTM` → `auto-merge-on-lgtm`. **L'agent NON mergia a mano.**

### Tier (mirror di pr-review-loop)

| Tier | Trigger | Model / max-turns |
|---|---|---|
| high | issue tocca `crawler`/`parser`/`scripts/`/`build-plugin`/`.github/workflows/`/test gate | opus, 40 |
| normal | resto | sonnet, 30 |

### CODE vs DATA (no scroll dei blob — frugalità token, mirror del guard reviewer #1096)

I file rigenerati `data/**` (job JSON, snapshot, translation-cache, blog-articles), `public/**` (immagini/asset), `reports/**`, `_newsletter_variants/**` **NON sono code** da leggere riga-per-riga: scorrerli intero brucia token senza segnale — stesso guard del reviewer.

- **Root cause su output dati = fixa il CODE che li genera** (parser/crawler/build-plugin), non editare il blob a mano né scorrere il file intero.
- Serve un campione di output? `Read` **mirato** (offset/limit) sul file, mai l'intero blob.
- `rg`/`grep` cross-file (diagnosi, pattern repetition) **scopati al code**: `rg <pattern> scripts build-plugins components services functions server hooks tests` (o `rg <pattern> -g '!data/**' -g '!public/**' -g '!reports/**'`).
- **Eccezione:** un file `data/**` checked-in che è **config/fixture** (non output rigenerato) e che il fix modifica a mano → trattalo come code.

### Abort senza PR (no fix forzato)

- Root cause non determinabile con confidenza → commento "serve indagine umana" + termina.
- Fix richiede credenziali/segreti non in CI → documenta + termina.
- **Capability-guard scope `.github/workflows/**` (valuta a turno ~1, PRIMA di implementare).** L'ambiente `issue-fix` ha solo `GH_TOKEN` (GitHub App, **senza scope `workflows`**) e nessun PAT → il push di file workflow fallisce **sempre**. Se la diagnosi mostra che il fix toccherebbe `.github/workflows/**` → posta il diff proposto + "serve PAT con scope `workflows` / mano umana" e **TERMINA SUBITO**, senza implementare. Idem per repo-setting/branch-protection/admin-API (es. `gh api .../branches/main/protection` → 403). Razionale (misurato): fare il fix e scoprire il blocco al push spreca ~1M token/run (#983 vs #1009). Guard nel prompt di `issue-fix.yml` (#1033).
- Mai un fix speculativo pur di produrre una PR.
- **Ogni abort DEVE chiudere con `<!-- FIX_OUTCOME: <code> -->` nel commento** (codici abort: `no-root-cause` / `blocked-workflows-scope` / `blocked-secrets` / `blocked-admin-settings` / `overlap-skip` / `pr-already-open` / `already-fixed` / `revenue-tracker-manual`; lista completa allo step 8). Senza marker → harvester classifica il run come `no-pr-unspecified`, indistinguibile da un crash silenzioso.

### Drenare il backlog queue-managed (`followup-drainer.yml`, automatico)

`issue-fix` ha `concurrency: { group: issue-fix, cancel-in-progress: false }`: GitHub tiene **un solo run pending** per gruppo e un nuovo trigger **cancella (supersede) il pending precedente**. Re-labelare `agent:fix` in raffica su N issue → sopravvivono solo la prima (già `in_progress`) e l'ultima (pending); quelle in mezzo finiscono `cancelled` **silenziosamente** e restano `agent:fix` senza retry → backlog stuck (storicamente #974/#959/#960 droppate). Dal 2026-07-05 vale per OGNI categoria non-crawler, non solo follow-up.

**Risolto da `followup-drainer.yml`** (cron ~20min + `workflow_run` dopo ogni `issue-fix` + dispatch, **zero-Claude**, `scripts/ci/followup-drainer.mjs`): ogni categoria diversa da `crawler` entra come `agent:fix-queued` (non `agent:fix`); il drainer promuove **UNO** a `agent:fix` solo quando lo slot `issue-fix` è libero (in-flight==0) → la run promossa è l'unica pending → **mai cancellata-in-coda**. Ordine: `fu-prio:high` prima, poi più vecchia. Resta la protezione anti-pile-up (vedi Guardrail). Il drainer usa `isQueueManaged()` (riusa `classifyIssue().route === 'queue'`, condiviso con `issue-triage.yml`/`triage-sweep.mjs`) per il rescue/park/age-out.

**Rescue + park (terminazione autonoma, no human):** un `agent:fix` queue-managed orfano (run morta, nessuna PR `fix/issue-N`, `updatedAt` > 30min) viene ri-accodato con `fu-attempt:N`++; a `fu-attempt:3` → `fu-parked` (esce dalla coda attiva, **non chiuso**: ri-tentabile a mano). Solo a slot libero (non tocca mai run viva). Per ri-processare a mano: applica `agent:fix-queued` (il drainer fa il resto), non `agent:fix` diretto.

## Local fixer (`/fix-issue N`)

Per issue HIGH-risk, o per intervenire a mano su una categoria (es. `revenue`/`tracker`) prima che il drainer la promuova dalla coda: worktree-first, GitNexus impact, approvazione umana prima del push.

> ⚠️ `.gitignore` ignora `.claude/` (eccetto `settings.json`), quindi il file del comando `/fix-issue` **non è version-controlled**: vive solo localmente in `.claude/commands/fix-issue.md`. Lo spec completo è riprodotto qui sotto (Appendice A) per ricrearlo su qualsiasi clone.

## Label

| Label | Significato | Chi la mette |
|---|---|---|
| `agent:fix` | opt-in: l'agent tenta un fix → PR | triage (`crawler` diretto, o promosso dalla coda per ogni altra categoria, **via PAT**) o owner manuale |
| `agent:triaged` | issue già processata da triage | triage (anti-loop) |
| `duplicate` | storm-duplicate, chiusa | triage |

## Kill-switch

- Disattivare auto-fix di una categoria: in `issue-triage.yml` togliere la categoria dal ramo che applica `agent:fix`, oppure disabilitare il workflow da GitHub UI.
- Disattivare TUTTO l'auto-routing mantenendo classify/dedup: rimuovere il `GITHUB_PAT` da Remote Config (o azzerare la Firebase SA) → triage ripiega su `GITHUB_TOKEN` e le label `agent:fix` smettono di triggerare il fixer.
- Bloccare un singolo fix: rimuovere `agent:fix` dalla issue prima che il fixer apra la PR (concurrency serializza, c'è una finestra).
- Pausa totale: disabilitare `issue-fix.yml` / `issue-triage.yml` (Actions → workflow → Disable).

## Auto-improvement loop (`lessons-harvester.yml`, daily)

Chiude il feedback loop: i pattern ricorrenti rientrano nelle istruzioni → reviewer/fixer smettono di ripeterli → turnaround più basso. I doc (AGENTS.md iniettato ogni sessione, ISSUES.md/REVIEW.md letti nei prompt) **sono** il canale verso gli agent.


- **Telemetria (deterministica, no Claude)**: il fixer chiude ogni run col marker `<!-- FIX_OUTCOME: <code> -->` (codici elencati in "Fix flow" step 8). I reviewer-finding stanno già nei review body 🔴/🟡/❓ (REVIEW.md). Store = GitHub stesso, nessun file accumulatore.
- **Aggregazione**: `scripts/ci/harvest-agent-lessons.mjs` (zero-Claude, daily) conta su finestra 14gg, soglia ≥3: bucket reviewer-finding (regex fissa) + fix-outcome bloccati. Le issue-class (crawler/follow-up/validation) sono **volume operativo, non lezioni** → contesto, mai driver di proposta. Dedup vs i doc-contract esistenti → tiene solo i cluster `novel`.
- **Proposta (1 turno Claude, solo se `has_novel`)**: redige aggiunte chirurgiche ai doc → apre **1 PR** `lessons/auto-harvest-*`. Nessun cluster nuovo = zero token. Una sola proposta pendente alla volta (guard su PR aperte).
- **Gate umano OBBLIGATORIO**: la PR di regole non è mai auto-mergiata (un'istruzione sbagliata degrada *tutti* gli agent). La rivede un umano. Solo `.md`, mai logica.
- **Kill-switch**: disabilita `lessons-harvester.yml` da Actions UI; oppure alza `THRESHOLD`/abbassa `WINDOW_DAYS` via `workflow_dispatch`.

## Guardrail (da AGENTS.md, vincolanti)

- Auto-route su OGNI categoria (owner decision 2026-07-05, vedi "Scopo"): `crawler` → `agent:fix` immediato; resto (incl. `revenue`/`tracker`/`validation-failure`/`other`) → `agent:fix-queued` via `followup-drainer`. Supervisione = gate `## LGTM`, non esclusione a monte.
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

Companion locale di `issue-fix.yml` (CI). Usalo per issue HIGH-risk dove vuoi controllo, o per intervenire mano su una categoria (`revenue`, `tracker`, …) prima che il drainer la promuova dalla coda automatica. Differenza chiave: **tu approvi prima del push**.

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

