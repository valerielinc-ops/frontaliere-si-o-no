# Issue Automation Instructions

Contratto operativo per la pipeline issue-agent: `issue-triage.yml` (classify + route **deterministico, no Claude**) e `issue-fix.yml` (fix → PR). Companion locale: `/fix-issue N` (`.claude/commands/fix-issue.md`).

## Scopo

Le issue di questo repo sono per lo più **auto-generate dai monitor** (post-deploy validate dist/live, crawler-health, rpm-canary, follow-up post-merge). Vanno instradate per categoria. Obiettivo (2026-07-05, owner decision "Rimuovi tutte le guardie"): risolvere autonomamente OGNI categoria — la supervisione umana resta a valle (gate `## LGTM` del reviewer PR), non a monte.

**Dedup a MONTE, non nel triage.** I duplicati non vanno chiusi dal triage (costerebbe un run per duplicato): vanno evitati alla sorgente. I monitor usano `scripts/lib/github-issue-creator.mjs` che, con **titolo stabile** (senza run-number), commenta 🔁 sull'issue canonica invece di aprirne una nuova. I follow-up sono **batchati in 1 issue aggregata per PR** da `post-merge-followup` (vedi `FOLLOWUP.md`). Duplicati eliminati a monte → triage classifica+instrada, **puro bash, zero Claude, zero quota**.

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

Nessun dedup-close (dedup a monte, vedi "Scopo"). Misclassificazione regex → fail-safe su `other`, dal 2026-07-05 comunque auto-fix via coda. Triage non legge più la lista delle issue aperte (era input-token che cresceva col backlog).

### Routing policy

| Categoria | Azione triage |
|---|---|
| `crawler` | **Auto-route `agent:fix` immediato** (`route='fix'`). Regen parser deterministico, basso blast-radius, coperto da `generate-company-parser.mjs`. Production-critical, non è il treadmill source. |
| `follow-up` | **Auto-route `agent:fix-queued`** (`route='queue'`, 2026-06-04) + `fu-prio:high\|low`. NON parte subito: `followup-drainer.yml` lo promuove a `agent:fix` UNO alla volta, solo a slot `issue-fix` libero (high prima). Fix della starvation (vedi "Drenare il backlog" sotto). |
| `validation-failure` | **Auto-route `agent:fix-queued`** (`route='queue'`, 2026-07-05). Spesso transiente; transiente-vs-persistente non è decidibile in modo deterministico (bash) — resta in coda, drenata come le altre, nessun commento speciale. |
| `revenue` / `tracker` | **Auto-route `agent:fix-queued`** (`route='queue'`, 2026-07-05, `fu-prio:high` default, non più opt-in manuale — vedi "Scopo"). Ordine classificazione resta PRIMA di `crawler` (anti-collisione nomi azienda). |
| `other` | **Auto-route `agent:fix-queued`** (`route='queue'`, 2026-07-05). Nessuna categoria riconosciuta ma comunque un tentativo di fix, priorità `low` salvo segnali `priority:high/urgent`. |

**Meccanismo di routing (PAT in bash)**: lo step `Classify and route` applica il label **via `GITHUB_PAT` con `gh` diretto**, non in una claude-action, solo se OPEN. Perché così:
- **PAT, non GITHUB_TOKEN**: un `labeled` da GITHUB_TOKEN non triggera `issue-fix` (anti-ricorsione) e ha sender `github-actions[bot]` che non passa il gate `sender == valerielinc-ops`. Col PAT (owner) trigger+gate OK.
- **Guard `state == OPEN`**: anti-race; niente label su issue chiuse.
- Senza PAT (RC non caricato) → skip + warning: routing inerte, mai fixer via GITHUB_TOKEN.

### Frugalità quota (no ANTHROPIC_API_KEY)

Piena regola in AGENTS.md → "Auth automazioni & frugalità quota" (solo `CLAUDE_CODE_OAUTH_TOKEN`, quota condivisa con la sessione owner, triage zero-Claude, dedup a monte, max-turns mai tagliati — cfr. #795/#802/#838). Specifico di questa pipeline: no fixer su issue non-OPEN; concurrency `cancel-in-progress: false` serializza i fixer. **Residuo**: l'auto-route `follow-up` può auto-alimentarsi (fix→merge→followup→nuovo follow-up). Bound da: batch 1-issue/PR, **coda drenata 1-alla-volta** (`followup-drainer`), gate `## LGTM`, **terminazione autonoma** (vedi "Rescue + park"). Un fix pulito non genera nuovi follow-up → converge.

## Fix flow (`issue-fix.yml`, on `issues: labeled == agent:fix`)

Trigger: label `agent:fix` aggiunta = il consenso. La mette l'owner (manuale) o il triage — quest'ultimo solo via `GITHUB_PAT` (vedi "Meccanismo di routing" sopra; mai via `GITHUB_TOKEN`).

**Meccanismo comune ai quattro pre-flight 0.1/0/0.5/0.75 (zero-Claude, pre-Claude)**: al trigger rimuove `agent:fix`, posta commento col marker, imposta l'output guard, salta gli step Claude (`if:`).

0.1. **Pre-flight quota backoff** — `scripts/ci/check-quota-backoff.mjs`. Gira **prima di `npm ci`** (usa solo builtin Node + `gh`), quindi un run bloccato costa ~15s invece di ~4min. Gate strutturale contro il bucket dominante misurato il 2026-08-05: sulle 61 run fallite della finestra 7gg (2026-07-29 → 08-05), **60 sono HTTP 429** — quota Max condivisa esaurita, `num_turns: 1`, `total_cost_usd: 0`, Claude mai eseguito — 1 è un 529 transiente, e **zero** sono `error_max_turns`, push falliti o timeout. Di quelle 61, **49 (80%) sono cadute dentro una finestra di rate-limit già aperta** da un fallimento precedente: prevedibili in modo deterministico, perché il payload del 429 dichiara `resetsAt`. Il gate legge il beacon `<!-- QUOTA_RESETS_AT: <epoch> -->` lasciato dalla run precedente sulle issue in `agent:fix`/`agent:fix-queued` e, se la finestra è aperta, ri-accoda questa issue (`agent:fix` → `agent:fix-queued`) **senza consumare un tentativo** → `<!-- FIX_OUTCOME: rate-limited -->`, `quota_blocked=true`. PROCEED-SAFE: nessun beacon attivo, beacon malformato o errore gh → procede invariato (un gate rotto non deve mai congelare la coda). Rationale completo e catena assorbente in `scripts/ci/claude-rate-limit.mjs`.
0. **Pre-flight already-resolved** — `scripts/ci/check-issue-already-resolved.mjs`. Gate strutturale (#1647) contro il bucket `fix-outcome:already-fixed`: molte follow-up sono **done-but-open** (risolte da una PR successiva senza `Closes #N`). Trigger: un token DISTINTIVO di `## Suggested action` già presente **verbatim** nel file citato su main → `<!-- FIX_OUTCOME: already-fixed -->`, `already_resolved=true`. CONSERVATIVO (bias procedere): solo follow-up **singole** (no aggregate "N items deferred"), **non-in-flight**, con match forte; aggregate/ambiguo/nessun match → procede invariato. Matcher condiviso con `reconcile-followups.mjs` (`scripts/ci/followup-resolution-match.mjs`).
0.5. **Pre-flight workflows-scope capability guard** — `scripts/ci/check-workflows-scope.mjs`. Gate strutturale (#4227, 12×/14gg recidiva — la regola prosa allo step "Abort senza PR" sotto non bastava, solo costo *dopo* diagnosi completa). Trigger, uno dei due: (a) **body-esplicito** — la issue cita `.github/workflows/**` verbatim in backtick/code-block; (b) **recurrence** — auto-file `scan-job-timeouts.mjs` (label `ci-timeout`) con **titolo esatto** coincidente a una issue PRECEDENTE già chiusa con lo stesso marker → `<!-- FIX_OUTCOME: blocked-workflows-scope -->`, `workflows_blocked=true`. CONSERVATIVO (bias procedere): nessun match → procede invariato.
0.75. **Pre-flight in-progress claim gate** — `scripts/ci/claim-issue-in-flight.mjs`. Piena rationale in AGENTS.md → "Claim mutex `agent:in-progress`" (#4788/#4793). Meccanica qui: reclama deterministicamente `agent:in-progress` PRIMA di ogni lavoro — zero-Claude, pre-tier/checkout (il controllo prompt-level allo step 1 sotto arriva dopo, cieco a lavoro non ancora aperto in PR, #4793); se già presente → `<!-- FIX_OUTCOME: overlap-skip -->`, `in_flight=true`, zero quota Max OAuth spesa. Se assente → la reclama e procede; release step simmetrico (`if: always()`) la rimuove su OGNI path terminale. PROCEED-SAFE: errore gh/API → `in_flight=false`, procede invariato.
1. **Pre-condizioni** (abort con commento se falliscono):
   - PR aperta già citante la issue → skip ("PR già in volo"). Difesa secondaria (0.75 è primaria) per il caso raro di PR già aperta senza label (es. lavoro manuale pre-esistente).
   - **Overlap-file**: estrai i path target dal body issue; se una PR aperta (`gh pr list --state open` + `gh pr diff <n> --name-only`) **già modifica** uno di quei file → skip ("file già in volo in PR #N; riaprire dopo il merge se pertinente"). (rif. #934 vs #943). Issue non file-specifica → procedi.
2. Branch `fix/issue-<N>`.
3. Diagnosi **root cause** (non sintomo). `crawler` → rigenera parser / edit mirato selector+config.
4. Fix **chirurgico sulla classe del bug**, non sul singolo file — piena regola in AGENTS.md #6 (sibling-grep pre-push via `check-sibling-patterns.mjs --strict`, falso-positivo documentato per-file in `## Non implementato`, dismiss collettivo insufficiente, Post-#8 sibling reale = lavoro dovuto non chiusura). Mai abbassare gate (#1). Mai disabilitare Auto Ads (#7).
5. Commit identity canonica `Valerie Linc <valerielinc@gmail.com>`. No path home assoluti, no email personali (Privacy).
6. Push branch + `gh pr create`.
7. PR body OBBLIGATORIO `## Implementato` (con `Closes #N`) + `## Non implementato (ancora)` (REVIEW.md completeness contract). Multi-issue: vedi AGENTS.md (`Closes` una keyword/riga, mai `#a #b #c` su una riga). **MAI `Closes #N` su una follow-up AGGREGATA multi-item** (titolo/body `N item deferred`, N≥2): il fixer lavora 1 item/run, un fix parziale NON chiude l'aggregata — `Closes` è GitHub-native, scatta al merge, bypassa il veto multi-item-auto-close di `FOLLOWUP.md` (cron `reconcile`), marcando COMPLETED con item dovuti (#3050→#3036). Usa invece un **progress-ref senza keyword di chiusura** (es. `Addresses item N di #M`); l'aggregata si chiude SOLO a TUTTI gli item fatti. `pr-body-contract.yml` (zero-Claude) flagga 🔴 il `Closes` su aggregata (riusa `isAggregate`). **Self-check prima di `gh pr create`**: `git diff origin/main`, verifica che ogni bullet di `## Implementato` sia nel diff; `## Non implementato (ancora)` elenca scope specifici (`- motivo: ...`), MAI `- ` vuoto o placeholder. `pr-body-contract.yml` valida presenza header, non precisione contenuto — responsabilità del fixer (#1508/#1470/#1469/#1456).
8. **Telemetria OBBLIGATORIA — ULTIMA azione del run:** posta sulla issue un commento con `<!-- FIX_OUTCOME: pr-created -->` (anche se non hai altri contenuti). Vale sia per il path happy (PR aperta) sia per ogni abort: usa il codice appropriato tra `pr-created` · `blocked-workflows-scope` · `blocked-secrets` · `blocked-admin-settings` · `no-root-cause` · `overlap-skip` · `pr-already-open` · `already-fixed` · `revenue-tracker-manual`. Due codici sono emessi dai post-step deterministici, non dall'agent: `max-turns` (subtype `error_max_turns`) e `rate-limited` (HTTP 429 — la run non e' mai partita). Senza marker → harvester classifica il run come `no-pr-unspecified`, indistinguibile da un crash silenzioso.
9. La PR fluisce in `pr-review-loop` → `## LGTM` → `auto-merge-on-lgtm`. **L'agent NON mergia a mano.**

### Tier (mirror di pr-review-loop)

| Tier | Trigger | Model / max-turns |
|---|---|---|
| high | issue tocca `crawler`/`parser`/`scripts/`/`build-plugin`/`.github/workflows/`/test gate | claude-sonnet-5, 70 |
| normal | resto | claude-sonnet-5, 55 |

### CODE vs DATA (no scroll dei blob — frugalità token, mirror del guard reviewer #1096)

I file rigenerati `data/**` (job JSON, snapshot, translation-cache, blog-articles), `public/**` (immagini/asset), `reports/**`, `_newsletter_variants/**` **NON sono code** da leggere riga-per-riga: scorrerli intero costa token senza segnale.

- **Root cause su output dati = fixa il CODE che li genera** (parser/crawler/build-plugin), non il blob a mano.
- Serve un campione di output? `Read` **mirato** (offset/limit) sul file, mai l'intero blob.
- `rg`/`grep` cross-file (diagnosi, pattern repetition) **scopati al code**: `rg <pattern> scripts build-plugins components services functions server hooks tests` (o `rg <pattern> -g '!data/**' -g '!public/**' -g '!reports/**'`).
- **Eccezione:** un file `data/**` checked-in che è **config/fixture** (non output rigenerato) e che il fix modifica a mano → trattalo come code.

### Abort senza PR (no fix forzato)

- Root cause non determinabile con confidenza → commento "serve indagine umana" + termina.
- Fix richiede credenziali/segreti non in CI → documenta + termina.
- **Capability-guard scope `.github/workflows/**` (turno ~1, PRIMA di implementare).** L'ambiente `issue-fix` ha solo `GH_TOKEN` (GitHub App, **senza scope `workflows`**) e nessun PAT → il push di file workflow fallisce **sempre**. Se il fix tocca `.github/workflows/**` → posta il diff proposto + "serve PAT scope `workflows` / mano umana" e **TERMINA SUBITO**. Idem per repo-setting/branch-protection/admin-API (es. `gh api .../branches/main/protection` → 403). Razionale: spreca ~1M token/run (#983/#1009). Guard in `issue-fix.yml` (#1033).
- Mai un fix speculativo pur di produrre una PR.
- **Ogni abort DEVE chiudere con `<!-- FIX_OUTCOME: <code> -->` nel commento** (codici: vedi step 8). Senza marker → harvester classifica il run come `no-pr-unspecified`, indistinguibile da un crash silenzioso.

### Drenare il backlog queue-managed (`followup-drainer.yml`, automatico)

`issue-fix` ha `concurrency: { group: issue-fix, cancel-in-progress: false }`: GitHub tiene **un solo run pending** per gruppo e un nuovo trigger **cancella (supersede) il pending precedente**. Re-labelare `agent:fix` in raffica su N issue → sopravvivono solo la prima (già `in_progress`) e l'ultima (pending); quelle in mezzo finiscono `cancelled` **silenziosamente** e restano `agent:fix` senza retry → backlog stuck (#974/#959/#960 droppate). Dal 2026-07-05 vale per OGNI categoria non-crawler, non solo follow-up.

**Risolto da `followup-drainer.yml`** (cron ~20min + `workflow_run` dopo ogni `issue-fix` + dispatch, **zero-Claude**, `scripts/ci/followup-drainer.mjs`): ogni categoria diversa da `crawler` entra come `agent:fix-queued` (non `agent:fix`); il drainer promuove **UNO** a `agent:fix` solo quando lo slot `issue-fix` è libero (in-flight==0) → **mai cancellata-in-coda**. Ordine: `fu-prio:high` prima, poi più vecchia. Resta la protezione anti-pile-up (vedi Guardrail). Il drainer usa `isQueueManaged()` (riusa `classifyIssue().route === 'queue'`, condiviso con `issue-triage.yml`/`triage-sweep.mjs`) per rescue/park/age-out.

**Rescue + park (terminazione autonoma, no human):** un `agent:fix` queue-managed orfano (run morta, nessuna PR `fix/issue-N`, `updatedAt` > 30min) viene ri-accodato con `fu-attempt:N`++; a `fu-attempt:3` → `fu-parked` (esce dalla coda attiva, **non chiuso**: ri-tentabile a mano). Solo a slot libero (non tocca mai run viva). Per ri-processare a mano: applica `agent:fix-queued` (il drainer fa il resto), non `agent:fix` diretto.

**Esiti ZERO-WORK — `rate-limited` NON consuma un tentativo.** Un tentativo si consuma quando l'agent **prova**, non quando la quota glielo ha impedito. Una run morta su HTTP 429 ha `num_turns: 1` e `total_cost_usd: 0`: la issue non è mai stata letta, quindi non è né un verdetto fermo (→ park immediato, come i `NON_RETRYABLE`) né una run crashata a metà lavoro (→ `fu-attempt`++). Il drainer la tiene in una terza classe (`ZERO_WORK` in `followup-drainer.mjs`): finestra ancora aperta → **HOLD** (resta `agent:fix`, fa da beacon per il backoff, nessuna label toccata); finestra chiusa → **re-queue con `fu-attempt` invariato**.

Perché è un contratto e non un dettaglio: prima di questo fix il 429 non emetteva marker granulare (il payload ha `"subtype": "success"`, quindi il post-step subtype-gated non scattava), restava solo il backstop `no-pr-unspecified` che il drainer scarta di proposito → outcome `null` → rescue con tentativo bruciato → **3 run identiche contro la stessa quota esaurita → `fu-parked` → age-out close «not planned» dopo 10 giorni**. Issue perfettamente fixabili uscivano dal loop autonomo e venivano chiuse senza che nessun agent le avesse mai lette (osservato su #5008 #5004 #5001 #4974, tutte `fu-attempt:3`). È l'equivalente lato fixer dello stato assorbente del grafo di recupero PR chiuso in #5099.

**Backoff globale al DRAIN.** Con una finestra 429 aperta il collo di bottiglia non è lo slot `issue-fix` ma la quota: promuovere produce solo un'altra run che muore al primo turno, occupando ~5 min di slot serializzato e ritardando tutta la coda. Il drainer legge il beacon `<!-- QUOTA_RESETS_AT: <epoch> -->` (scadenza **dichiarata dal server**, non un'euristica a tempo) e **sospende le promozioni** finché non è passata. Misurato sulla finestra 7gg 2026-07-29 → 08-05: 49 dei 61 fallimenti (80%) sono caduti dentro una finestra già aperta; il 2026-07-31 sono stati 27 su 27 in un giorno solo.

## Local fixer (`/fix-issue N`)

Per issue HIGH-risk o intervento manuale su una categoria in coda (es. `revenue`/`tracker`): worktree-first, GitNexus impact, approvazione umana pre-push.

> ⚠️ `.gitignore` ignora `.claude/` (eccetto `settings.json`), quindi il file del comando `/fix-issue` **non è version-controlled**: vive solo localmente in `.claude/commands/fix-issue.md`. Spec completo sotto (Appendice A) per ricrearlo su ogni clone.

## Label

| Label | Significato | Chi la mette |
|---|---|---|
| `agent:fix` | opt-in: l'agent tenta un fix → PR | triage (`crawler` diretto, o promosso dalla coda per ogni altra categoria, **via PAT**) o owner manuale |
| `agent:in-progress` | mutex: qualcuno (fixer CI o sessione locale `/fix-issue`) sta lavorando la issue ORA — anti-doppione (#4788/#4793) | claim gate (0.75 sopra) o sessione locale (Appendice A); rilasciata a fine lavoro/abbandono da entrambi |
| `agent:triaged` | issue già processata da triage | triage (anti-loop) |
| `duplicate` | storm-duplicate, chiusa | triage |

## Kill-switch

- Disattivare auto-fix di una categoria: in `issue-triage.yml` togliere la categoria dal ramo che applica `agent:fix`, oppure disabilitare il workflow da GitHub UI.
- Disattivare TUTTO l'auto-routing mantenendo classify/dedup: rimuovere il `GITHUB_PAT` da Remote Config (o azzerare la Firebase SA) → triage ripiega su `GITHUB_TOKEN` e le label `agent:fix` smettono di triggerare il fixer.
- Bloccare un singolo fix: rimuovere `agent:fix` dalla issue prima che il fixer apra la PR (concurrency serializza, c'è una finestra).
- Claim stale (release step gira `if: always()` ma un crash del runner può saltarlo): rimuovi la label a mano, poi ri-labella `agent:fix` se serve ancora.
- Pausa totale: disabilitare `issue-fix.yml` / `issue-triage.yml` (Actions → workflow → Disable).

## Auto-improvement loop (`lessons-harvester.yml`, daily)

Feedback loop: pattern ricorrenti rientrano nelle istruzioni → reviewer/fixer smettono di ripeterli. I doc (AGENTS.md iniettato ogni sessione, ISSUES.md/REVIEW.md letti nei prompt) **sono** il canale verso gli agent.

- **Telemetria (deterministica, no Claude)**: marker `<!-- FIX_OUTCOME: <code> -->` (codici: step 8). Reviewer-finding già nei review body 🔴/🟡/❓ (REVIEW.md). Store = GitHub, nessun file accumulatore.
- **Aggregazione**: `scripts/ci/harvest-agent-lessons.mjs` (zero-Claude, daily) conta su finestra 14gg, soglia ≥3: bucket reviewer-finding (regex fissa) + fix-outcome bloccati. Issue-class = volume operativo, non lezioni. Dedup vs doc-contract esistenti → solo cluster `novel`.
- **Proposta (1 turno Claude, solo se `has_novel`)**: redige aggiunte chirurgiche ai doc → apre **1 PR** `lessons/auto-harvest-*`. Nessun cluster nuovo = zero token. Una sola proposta pendente alla volta (guard su PR aperte).
- **Gate umano OBBLIGATORIO**: la PR di regole non è mai auto-mergiata (un'istruzione sbagliata degrada *tutti* gli agent). La rivede un umano. Solo `.md`, mai logica.
- **Kill-switch**: disabilita `lessons-harvester.yml` da Actions UI; oppure alza `THRESHOLD`/abbassa `WINDOW_DAYS` via `workflow_dispatch`.

## Guardrail (da AGENTS.md, vincolanti)

- Auto-route su OGNI categoria (2026-07-05, vedi "Scopo" + "Routing policy"). Supervisione = gate `## LGTM`, non esclusione a monte.
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
- **Claim mutex** (#4788/#4793 — una sessione locale e `issue-fix.yml` hanno fixato la stessa issue in parallelo, due PR competitive in conflitto al merge): `gh issue view $ARGUMENTS --json labels` (già letto al Bootstrap 2). Se compare `agent:in-progress` → un'altra sessione (locale o il fixer CI) la sta già lavorando → fermati, avvisa l'utente, NON procedere. Se assente → reclamala SUBITO, prima di ogni altro passo: `gh label create agent:in-progress --color fbca04 --description "Fixer o sessione interattiva al lavoro ORA (mutex anti-doppione)" 2>/dev/null; gh issue edit $ARGUMENTS --add-label agent:in-progress`.
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
9. **Rilascia il claim** (a lavoro concluso o se abbandoni prima): `gh issue edit $ARGUMENTS --remove-label agent:in-progress`. Mai lasciarla stale — blocca il fixer CI su questa issue finché resta.

## Constraint
- Approvazione umana del diff prima del push.
- Una issue alla volta, changes chirurgiche.
- Reviewer + `## LGTM`; mai merge a mano (salvo eccezione workflow-file AGENTS.md).
````

