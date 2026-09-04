# Issue Automation Instructions

Contratto operativo per la pipeline issue-agent: `issue-triage.yml` (classify + route **deterministico, no Claude**) e `issue-fix.yml` (fix → PR). Companion locale: `/fix-issue N` (`.claude/commands/fix-issue.md`).

## Scopo

Le issue sono per lo più **auto-generate dai monitor** (post-deploy validate dist/live, crawler-health, rpm-canary, follow-up post-merge) e vanno instradate per categoria. Obiettivo (2026-07-05, owner decision "Rimuovi tutte le guardie"): risolvere autonomamente OGNI categoria — la supervisione umana resta a valle (gate `## LGTM` del reviewer PR), non a monte.

**Dedup a MONTE, non nel triage.** Chiuderli nel triage costerebbe un run per duplicato: si evitano alla sorgente. I monitor usano `scripts/lib/github-issue-creator.mjs`, che con **titolo stabile** (senza run-number) commenta 🔁 sull'issue canonica invece di aprirne una nuova; i follow-up sono **batchati in 1 issue aggregata per PR** da `post-merge-followup` (vedi `FOLLOWUP.md`). Senza duplicati il triage solo classifica+instrada: **puro bash, zero Claude, zero quota**.

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
4. **Routing** (vedi sotto): `crawler` → `agent:fix` via PAT immediato **se lo slot `issue-fix` è libero**, altrimenti in coda come tutti (#5514); ogni altra categoria → `agent:fix-queued` via PAT, issue OPEN.

Nessun dedup-close (dedup a monte, vedi "Scopo"). Misclassificazione regex → fail-safe su `other`, dal 2026-07-05 comunque auto-fix via coda. Il triage non legge più la lista delle issue aperte (input-token che cresceva col backlog).

### Routing policy

| Categoria | Azione triage |
|---|---|
| `crawler` | **Auto-route `agent:fix` immediato** (`route='fix'`), ma **uno per run di sweep e solo a slot `issue-fix` libero** (`crawlerDirectFixBudget`, #5514): l'eccedenza va in `agent:fix-queued` + `fu-prio:high`. Regen parser deterministico, basso blast-radius, coperto da `generate-company-parser.mjs`. Production-critical, non è il treadmill source. |
| `follow-up` | **Auto-route `agent:fix-queued`** (`route='queue'`, 2026-06-04) + `fu-prio:high\|low`. NON parte subito: `followup-drainer.yml` lo promuove a `agent:fix` UNO alla volta, solo a slot `issue-fix` libero (high prima). Fix della starvation (vedi "Drenare il backlog" sotto). |
| `validation-failure` | **Auto-route `agent:fix-queued`** (`route='queue'`, 2026-07-05). Spesso transiente; transiente-vs-persistente non è decidibile in modo deterministico (bash) — resta in coda, drenata come le altre, nessun commento speciale. |
| `revenue` / `tracker` | **Auto-route `agent:fix-queued`** (`route='queue'`, 2026-07-05, `fu-prio:high` default, non più opt-in manuale — vedi "Scopo"). Ordine classificazione resta PRIMA di `crawler` (anti-collisione nomi azienda). |
| `other` | **Auto-route `agent:fix-queued`** (`route='queue'`, 2026-07-05). Nessuna categoria riconosciuta ma comunque un tentativo di fix, priorità `low` salvo segnali `priority:high/urgent`. |

**Meccanismo di routing (PAT in bash)**: lo step `Classify and route` applica il label **via `GITHUB_PAT` con `gh` diretto**, non in una claude-action, e solo se OPEN. Perché:
- **PAT, non GITHUB_TOKEN**: un `labeled` da GITHUB_TOKEN non triggera `issue-fix` (anti-ricorsione) e ha sender `github-actions[bot]`, che non passa il gate `sender == valerielinc-ops`. Col PAT (owner) trigger+gate OK.
- **Guard `state == OPEN`**: anti-race; niente label su issue chiuse.
- Senza PAT (RC non caricato) → skip + warning: routing inerte, mai fixer via GITHUB_TOKEN.

### Frugalità quota (no ANTHROPIC_API_KEY)

Piena regola in AGENTS.md → "Auth automazioni & frugalità quota" (solo `CLAUDE_CODE_OAUTH_TOKEN`, quota condivisa con la sessione owner, triage zero-Claude, dedup a monte, max-turns mai tagliati — cfr. #795/#802/#838). Qui in più: no fixer su issue non-OPEN; concurrency `cancel-in-progress: false` serializza i fixer. **Residuo**: l'auto-route `follow-up` può auto-alimentarsi (fix→merge→followup→nuovo follow-up), bound da batch 1-issue/PR, **coda drenata 1-alla-volta** (`followup-drainer`), gate `## LGTM`, **terminazione autonoma** (vedi "Rescue + park"). Un fix pulito non genera nuovi follow-up → converge.

## Fix flow (`issue-fix.yml`, on `issues: labeled == agent:fix`)

Trigger: label `agent:fix` aggiunta = il consenso. La mette l'owner (manuale) o il triage — quest'ultimo solo via `GITHUB_PAT` (vedi "Meccanismo di routing"; mai via `GITHUB_TOKEN`).

**Meccanismo comune ai quattro pre-flight 0.1/0/0.5/0.75 (zero-Claude, pre-Claude)**: al trigger rimuove `agent:fix`, posta commento col marker, imposta l'output guard, salta gli step Claude (`if:`).

0.1. **Pre-flight quota backoff** — `scripts/ci/check-quota-backoff.mjs`. Gira **prima di `npm ci`** (solo builtin Node + `gh`): un run bloccato costa ~15s invece di ~4min. Gate strutturale contro il bucket dominante — finestra 7gg 2026-07-29 → 08-05: **60 delle 61 run fallite sono HTTP 429** (quota Max condivisa esaurita, `num_turns: 1`, `total_cost_usd: 0`, Claude mai eseguito), e **49, l'80%, dentro una finestra già aperta** — prevedibili, perché il payload 429 dichiara `resetsAt`. Il gate legge il beacon `<!-- QUOTA_RESETS_AT: <epoch> -->` lasciato dalla run precedente sulle issue in `agent:fix`/`agent:fix-queued` e, se la finestra è aperta, ri-accoda questa issue (`agent:fix` → `agent:fix-queued`) **senza consumare un tentativo** → `<!-- FIX_OUTCOME: rate-limited -->`, `quota_blocked=true`. PROCEED-SAFE: nessun beacon attivo, beacon malformato o errore gh → procede invariato (un gate rotto non deve mai congelare la coda). Rationale completo e catena assorbente in `scripts/ci/claude-rate-limit.mjs`.
0. **Pre-flight already-resolved** — `scripts/ci/check-issue-already-resolved.mjs`. Gate strutturale (#1647) contro il bucket `fix-outcome:already-fixed`: molte follow-up sono **done-but-open**, risolte da una PR successiva senza `Closes #N`. Trigger: un token DISTINTIVO di `## Suggested action` già presente **verbatim** nel file citato su main → `<!-- FIX_OUTCOME: already-fixed -->`, `already_resolved=true`. CONSERVATIVO (bias procedere): solo follow-up **singole** (no aggregate "N items deferred"), **non-in-flight**, con match forte; aggregate/ambiguo/nessun match → procede invariato. Matcher condiviso con `reconcile-followups.mjs` (`scripts/ci/followup-resolution-match.mjs`).
0.5. **Pre-flight workflows-scope capability guard** — `scripts/ci/check-workflows-scope.mjs`. Gate strutturale (#4227, 12×/14gg di recidiva: la regola prosa in "Abort senza PR" non bastava, costava *dopo* la diagnosi completa). Trigger, uno dei due: (a) **body-esplicito** — la issue cita `.github/workflows/**` verbatim in backtick/code-block; (b) **recurrence** — auto-file `scan-job-timeouts.mjs` (label `ci-timeout`) con **titolo esatto** coincidente a una issue PRECEDENTE già chiusa con lo stesso marker → `<!-- FIX_OUTCOME: blocked-workflows-scope -->`, `workflows_blocked=true`. CONSERVATIVO (bias procedere): nessun match → procede invariato.
0.75. **Pre-flight in-progress claim gate** — `scripts/ci/claim-issue-in-flight.mjs`. Piena rationale in AGENTS.md → "Claim mutex `agent:in-progress`" (#4788/#4793). Reclama `agent:in-progress` PRIMA di ogni lavoro — zero-Claude, pre-tier/checkout (il controllo prompt-level allo step 1 arriva dopo, cieco a lavoro non ancora aperto in PR, #4793); se già presente → `<!-- FIX_OUTCOME: overlap-skip -->`, `in_flight=true`, zero quota Max OAuth spesa. Se assente → la reclama e procede; release step simmetrico (`if: always()`) la rimuove su OGNI path terminale. PROCEED-SAFE: errore gh/API → `in_flight=false`, procede invariato.
1. **Pre-condizioni** (abort con commento se falliscono):
   - PR aperta già citante la issue → skip ("PR già in volo"). Difesa secondaria (0.75 è primaria) per il caso raro di PR già aperta senza label (es. lavoro manuale pre-esistente).
   - **Overlap-file**: estrai i path target dal body issue; se una PR aperta (`gh pr list --state open` + `gh pr diff <n> --name-only`) **già modifica** uno di quei file → skip ("file già in volo in PR #N; riaprire dopo il merge se pertinente") (rif. #934 vs #943). Issue non file-specifica → procedi.
2. Branch `fix/issue-<N>`.
3. Diagnosi **root cause** (non sintomo). `crawler` → rigenera parser / edit mirato selector+config.
4. Fix **chirurgico sulla classe del bug**, non sul singolo file — piena regola in AGENTS.md #6 (sibling-grep pre-push via `check-sibling-patterns.mjs --strict`, falso-positivo documentato per-file in `## Non implementato`, dismiss collettivo insufficiente, Post-#8 sibling reale = lavoro dovuto non chiusura). Mai abbassare gate (#1). Mai disabilitare Auto Ads (#7).
5. Commit identity canonica `Valerie Linc <valerielinc@gmail.com>`. No path home assoluti, no email personali (Privacy).
6. Push branch + `gh pr create`.
7. PR body OBBLIGATORIO `## Implementato` (con `Closes #N`) + `## Non implementato (ancora)` (REVIEW.md completeness contract). Multi-issue: vedi AGENTS.md (`Closes` una keyword/riga, mai `#a #b #c` su una riga). **MAI `Closes #N` su una follow-up AGGREGATA multi-item** (titolo/body `N item deferred`, N≥2): il fixer lavora 1 item/run e `Closes`, GitHub-native, scatta al merge bypassando il veto multi-item-auto-close di `FOLLOWUP.md` (cron `reconcile`) → COMPLETED con item dovuti (#3050→#3036). Usa invece un **progress-ref senza keyword di chiusura** (es. `Addresses item N di #M`): l'aggregata si chiude SOLO a TUTTI gli item fatti. `pr-body-contract.yml` (zero-Claude) flagga 🔴 il `Closes` su aggregata (riusa `isAggregate`), e valida la presenza degli header, non la precisione del contenuto — quella è responsabilità del fixer (#1508/#1470/#1469/#1456). **Self-check prima di `gh pr create`**: `git diff origin/main`, ogni bullet di `## Implementato` dev'essere nel diff; `## Non implementato (ancora)` elenca scope specifici (`- motivo: ...`), MAI `- ` vuoto o placeholder.
8. **Telemetria OBBLIGATORIA — ULTIMA azione del run:** posta sulla issue un commento con `<!-- FIX_OUTCOME: pr-created -->` (anche senza altri contenuti). Vale per il path happy (PR aperta) e per ogni abort: usa il codice appropriato tra `pr-created` · `blocked-workflows-scope` · `blocked-secrets` · `blocked-admin-settings` · `no-root-cause` · `overlap-skip` · `pr-already-open` · `already-fixed` · `revenue-tracker-manual`. Due codici li emettono i post-step deterministici, non l'agent: `max-turns` (subtype `error_max_turns`) e `rate-limited` (HTTP 429 — la run non e' mai partita). Senza marker → harvester classifica il run come `no-pr-unspecified`, indistinguibile da un crash silenzioso.
9. La PR fluisce in `pr-review-loop` → `## LGTM` → `auto-merge-on-lgtm`. **L'agent NON mergia a mano.**

### Tier (mirror di pr-review-loop)

| Tier | Trigger | Model / max-turns |
|---|---|---|
| high | issue tocca `crawler`/`parser`/`scripts/`/`build-plugin`/`.github/workflows/`/test gate | claude-opus-5 (`--effort medium`), 70 |
| normal | resto | claude-opus-5 (`--effort medium`), 55 |

### CODE vs DATA (no scroll dei blob — frugalità token, mirror del guard reviewer #1096)

I file rigenerati `data/**` (job JSON, snapshot, translation-cache, blog-articles), `public/**` (immagini/asset), `reports/**`, `_newsletter_variants/**` **NON sono code** da leggere riga-per-riga: scorrerli intero costa token senza segnale.

- **Root cause su output dati = fixa il CODE che li genera** (parser/crawler/build-plugin), non il blob a mano.
- Serve un campione di output? `Read` **mirato** (offset/limit) sul file, mai l'intero blob.
- `rg`/`grep` cross-file (diagnosi, pattern repetition) **scopati al code**: `rg <pattern> scripts build-plugins components services functions server hooks tests` (o `rg <pattern> -g '!data/**' -g '!public/**' -g '!reports/**'`).
- **Eccezione:** un file `data/**` checked-in che è **config/fixture** (non output rigenerato) e che il fix modifica a mano → trattalo come code.

### Abort senza PR (no fix forzato)

- Root cause non determinabile con confidenza → commento "serve indagine umana" + termina.
- **I segreti CI SONO** (decisione del proprietario del 2026-08-24, registro in VISION.md): questo run carica Remote Config prima di partire, quindi `CF_API_TOKEN`, `POSTHOG_*`, `GEMINI_API_KEY`, `GITHUB_PAT` e gli altri ~90 parametri sono in `process.env`. Un fix che richiede una credenziale va **IMPLEMENTATO**, non documentato: `blocked-secrets` non è più un verdetto strutturale, e termina con quel codice **solo se** leggi la variabile e la trovi davvero vuota — in quel caso nomina la variabile esatta, perché è un difetto della mappa `RC_TO_ENV`, non un limite di capacità.
  - **Eccezione — rotazione di credenziali.** L'autorizzazione copre l'USO di un secret esistente, non la sua ROTAZIONE: sono due cose diverse (VISION.md, decisione 2026-08-18: rotazione declinata, PAT e Gemini key restano). Un'issue che chiede di ruotare/rigenerare/revocare una credenziale non è "una variabile vuota" né "usare ciò che c'è": è un'azione fuori-banda che nessuna variabile in `process.env` può risolvere. Non implementarla: commento "rotazione di credenziali — resta una decisione umana (VISION.md)" e termina, PRIMA di tentare qualunque diff.
- **Capability-guard scope `.github/workflows/**` (turno ~1, PRIMA di implementare).** Senza `APP_TOKEN_WORKFLOWS == 'true'` (capacità LETTA dalla risposta API del conio App, #5288) il push di file workflow fallisce **sempre**: posta il diff proposto + "serve scope `workflows` / mano umana" e **TERMINA SUBITO**. Idem per repo-setting/branch-protection/admin-API (403), che restano bloccanti — il PAT c'è ma il permesso è un'altra cosa (`blocked-admin-settings`). Razionale: ~1M token/run sprecati (#983/#1009); guard in `issue-fix.yml` (#1033).
- Mai un fix speculativo pur di produrre una PR.
- **Ogni abort DEVE chiudere con `<!-- FIX_OUTCOME: <code> -->` nel commento** (codici, e conseguenza del marker mancante: step 8).

### Drenare il backlog queue-managed (`followup-drainer.yml`, automatico)

`issue-fix` ha `concurrency: { group: issue-fix, cancel-in-progress: false }`: GitHub tiene **un solo run pending** per gruppo — un trigger nuovo cancella il pending precedente **silenziosamente**, la label resta senza retry → backlog stuck (#974/#959/#960). Dal 2026-07-05 vale per OGNI categoria, **crawler inclusi** (#5392-#5395 ferme due giorni, #5514).

**Risolto da `followup-drainer.yml`** (cron ~20min + `workflow_run` dopo ogni `issue-fix` + dispatch, **zero-Claude**, `scripts/ci/followup-drainer.mjs`): ogni categoria ≠ `crawler` entra come `agent:fix-queued`; il drainer ne promuove **UNO** a `agent:fix` solo a slot libero (in-flight==0) → **mai cancellata-in-coda**. Ordine: `fu-prio:high` prima, poi più vecchia. Usa `isQueueManaged()` (`classifyIssue().route === 'queue'`, condiviso col triage) per rescue/park/age-out. **I crawler, esclusi da `isQueueManaged()`, hanno dal 2026-08-10 un rescue gemello** (`crawlerFixDecision`, #5514): run senza verdetto → ri-arma via coda con `fu-attempt:N` (tetto 3) → `fu-parked` + `needs-human`; `max-turns`/verdetti fermi → park; `rate-limited` → hold/re-queue senza consumare tentativi.

**Rescue + park (terminazione autonoma):** un `agent:fix` queue-managed orfano (run morta, nessuna PR `fix/issue-N`, `updatedAt` > 30min) → ri-accodato con `fu-attempt:N`++; a 3 → `fu-parked` (**non chiuso**, ri-tentabile). Solo a slot libero, mai su run viva. Ri-processo manuale: applica `agent:fix-queued`, non `agent:fix` diretto.

**Esiti ZERO-WORK — `rate-limited` NON consuma un tentativo.** Un tentativo si consuma quando l'agent **prova**: su HTTP 429 (`num_turns: 1`, `total_cost_usd: 0`) la issue non è mai stata letta — né verdetto fermo (→ park, come i `NON_RETRYABLE`) né run crashata a metà (→ `fu-attempt`++). Classe `ZERO_WORK` in `followup-drainer.mjs`: finestra aperta → **HOLD** (resta `agent:fix` come beacon, nessuna label toccata); finestra chiusa → **re-queue con `fu-attempt` invariato**.

Perché è un contratto: senza marker granulare il 429 (`"subtype": "success"`) cadeva sul backstop `no-pr-unspecified`, che il drainer scarta → rescue con tentativo bruciato → **3 run contro la stessa quota → `fu-parked` → age-out close**, su issue mai lette (#5008 #5004 #5001 #4974; lato PR: #5099).

**Backoff globale al DRAIN.** Con una finestra 429 aperta il collo è la quota, non lo slot. Il drainer legge il beacon `<!-- QUOTA_RESETS_AT: <epoch> -->` (scadenza **dichiarata dal server**) e **sospende le promozioni** finché non è passata (27 fallimenti su 27 il 2026-07-31).

### Stadio di decomposizione (`issue-decompose.yml`, 2026-08-21)

Le issue troppo grandi per un run non escono più dal ciclo: il drainer instrada a `agent:decompose-queued` — invece di park/`needs-human` — backlog-tracker, escalation too-large e `max-turns` al 1° colpo, e promuove UNO a `agent:decompose` per tick (slot proprio, sospeso sotto quota-backoff e fairness). Il run planner **NON implementa**: produce ≤6 sub-issue atomiche con `## Scheda` (CAUSA / FIX / METRICA+COMANDO / OSSERVATORE), label `from-decompose` + `fu-prio` ereditata, instradate in coda dal triage; >6 unità → le 5 di massimo valore + UNA issue-contenitore residua che ri-entra (ogni giro chiude ≥5). Il padre resta aperto con `decomposed:1` + `<!-- DECOMPOSED_INTO: n1 n2 -->`: lo chiude il PARENT-CLOSE del drainer a figlie tutte chiuse. Anti-ricorsione: `decomposed:1` e `from-decompose` mai ri-decomposti. Esiti: `<!-- DECOMPOSE_OUTCOME: decomposed-K | atomic-requeue | needs-human-decision | already-resolved -->`; run morta → un ri-arma (`decompose-retried`), poi `fu-parked`+`needs-human`. Il fixer, su figlia con `## Scheda`, verifica la CAUSA col COMANDO in ≤3 turni e salta la diagnosi.

## Local fixer (`/fix-issue N`)

Per issue HIGH-risk o intervento manuale su una categoria in coda (es. `revenue`/`tracker`): worktree-first, GitNexus impact, approvazione umana pre-push.

> ⚠️ `.gitignore` ignora `.claude/` (eccetto `settings.json`), quindi il file del comando `/fix-issue` **non è version-controlled**: vive solo localmente in `.claude/commands/fix-issue.md`. Spec completo in Appendice A per ricrearlo su ogni clone.

## Label

| Label | Significato | Chi la mette |
|---|---|---|
| `agent:fix` | opt-in: l'agent tenta un fix → PR | triage (`crawler` diretto, o promosso dalla coda per ogni altra categoria, **via PAT**) o owner manuale |
| `agent:in-progress` | mutex: qualcuno (fixer CI o sessione locale `/fix-issue`) sta lavorando la issue ORA — anti-doppione (#4788/#4793) | claim gate (0.75 sopra) o sessione locale (Appendice A); rilasciata a fine lavoro/abbandono da entrambi |
| `agent:triaged` | issue già processata da triage | triage (anti-loop) |
| `duplicate` | storm-duplicate, chiusa | triage |
| `job-content-quality` | un record crawlato non è un annuncio di lavoro (offerta commerciale, widget di consenso, voce di menu, placeholder di template) | `crawler-content-plausibility-audit.yml` e `scripts/report-crawler-content-error.mjs` |

## Segnalazione umana di un difetto di contenuto crawlato

Non tutte le issue nascono da un monitor. Un difetto **visto a occhio** su una
pagina live — è così che sono emersi i due casi del 2026-08-24, `hotel-international`
che pubblicava offerte di camere d'hotel e `schindler` col widget dei cookie come
titolo — entra nella stessa pipeline con un comando, senza aprire una sessione:

```bash
node scripts/report-crawler-content-error.mjs <crawler-key|url-del-job> "<cosa c'è che non va>"
node scripts/report-crawler-content-error.mjs <...> --urgent    # route immediata
node scripts/report-crawler-content-error.mjs <...> --dry-run   # stampa e basta
```

Da lì è il ciclo normale: `issue-triage` → `issue-fix` → PR → `## LGTM` → auto-merge.

**Routing, che qui è una scelta e non un caso.** Senza flag l'issue non porta
label di routing né parole di innesco nel titolo → categoria `other` →
`agent:fix-queued`, drenata da `followup-drainer` come tutto il resto.
Con `--urgent` porta `parser-broken`, che da sola basta a `classifyIssue()` per
dare categoria `crawler` → `agent:fix` immediato: è la deroga giusta quando il
contenuto sbagliato è live e chi segnala l'ha verificato di persona, e resta
opt-in perché il bypass della coda è documentato sopra come l'unica eccezione.

Il contesto completo (rilevatore, calibrazione, audit settimanale) sta in
`docs/CRAWLERS.md` → "Job-Content Plausibility".

## Contratto minimo per issue auto-generate (`## Segnali`, opt-in)

2026-08-30: il fixer perde turni quando una issue apre col solo sintomo ("X è
rosso") e nessun dato deterministico — deve ricostruirsi da sé cosa è fallito,
come riprodurlo, dove sta l'evidenza, prima ancora di iniziare la diagnosi
vera. `issue-decompose.yml` risolve lo stesso problema per le sue sub-issue
con `## Scheda` (CAUSA/FIX/METRICA/OSSERVATORE) — ma quella è un'ANALISI
Claude-authored, non riproducibile dai ~24 reporter zero-Claude (monitor/
crawler-health/audit) che aprono la stragrande maggioranza delle issue.

Per quelli c'è `signals` in `createGithubIssue()` (`scripts/lib/
github-issue-creator.mjs`, funzione `formatSignalsBlock`) — NON una diagnosi
(nessun campo CAUSA: un reporter deterministico non ha il giudizio per
formularla), solo i fatti che il reporter ha già in mano:

```js
await createGithubIssue({
  title, description, priority, labels, workflow,
  signals: {
    cosa: 'audit:foo sopra soglia',              // opzionale
    metrica: { osservato: 12, atteso: 5 },        // opzionale
    comando: 'npm run audit:foo',                 // opzionale, il comando ESATTO che riproduce
    evidenza: ['run 123', 'file.ts:42'],           // opzionale, array di riferimenti
  },
});
```

Da CLI (reporter che invocano `github-issue-creator.mjs` come subprocess):
`--signal-cosa "..." --signal-osservato N --signal-atteso N --signal-comando "..." --signal-evidenza "..."` (ripetibile).

Renderizza come `## Segnali (raccolti automaticamente)` PRIMA della
`description` libera — stesso ordine di `## Scheda` sui figli di decompose.
Ogni campo è opzionale e l'intero parametro è opt-in: un reporter che non lo
passa ha lo stesso body di sempre (25 test in `tests/format-signals-block.
test.ts` fissano il contratto, incluso il caso "nessun signals → nessun
blocco"). `issue-fix.yml` (Bootstrap) legge `## Segnali` quando presente e
salta la ri-scoperta di cosa/come-riprodurre/evidenza che altrimenti farebbe
da sé nei primi turni.

**Non retrofittato ovunque in questa sessione** — i ~24 caller di
`createGithubIssue` non condividono tutti lo stesso gap: diversi (es.
`report-validate-dist-failure.mjs`, `send-job-alerts.mjs`) hanno già body
ricchi su misura (log estratto, comando di replay, `## Suggested action`)
che `## Segnali` non migliorerebbe. Applicato qui a un caso genuinamente
sottile (`reconcile-here-usage.mjs`, prima un'unica riga senza comando di
riproduzione né evidenza) come riferimento. Gli altri caller vanno valutati
uno per uno con lo stesso criterio — "il body attuale lascia al fixer una
ricostruzione che i dati del reporter già risolvono?" — non convertiti in
blocco.

## Kill-switch

- Disattivare auto-fix di una categoria: in `issue-triage.yml` togliere la categoria dal ramo che applica `agent:fix`, oppure disabilitare il workflow da GitHub UI.
- Disattivare TUTTO l'auto-routing mantenendo classify/dedup: rimuovere il `GITHUB_PAT` da Remote Config (o azzerare la Firebase SA) → triage ripiega su `GITHUB_TOKEN` e le label `agent:fix` smettono di triggerare il fixer.
- Bloccare un singolo fix: rimuovere `agent:fix` dalla issue prima che il fixer apra la PR (concurrency serializza, c'è una finestra).
- Claim stale (release step gira `if: always()` ma un crash del runner può saltarlo): rimuovi la label a mano, poi ri-labella `agent:fix` se serve ancora.
- Pausa totale: disabilitare `issue-fix.yml` / `issue-triage.yml` (Actions → workflow → Disable).

## Auto-improvement loop (`lessons-harvester.yml`, daily)

Pattern ricorrenti rientrano nelle istruzioni → gli agent smettono di ripeterli. I doc (AGENTS.md iniettato, ISSUES.md/REVIEW.md nei prompt) **sono** il canale.

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

Lo spec completo del comando, da salvare **verbatim** in `.claude/commands/fix-issue.md` su ogni clone, sta in **`docs/FIX-ISSUE-COMMAND.md`** (tracciato, invariato). Estratto da qui per non far entrare ~3,1 KB in ogni sessione agent — stesso pattern di `docs/AGENTS-HISTORY.md` e `docs/CI-CD-PIPELINE.md`.
