# Issue Automation Instructions

Contratto: `issue-triage.yml` (route **deterministico, no Claude**) e `issue-fix.yml` (fix → PR). Companion: `/fix-issue N` (`.claude/commands/fix-issue.md`).

## Scopo

Le issue sono **auto-generate dai monitor** e vanno instradate per categoria. Obiettivo (owner decision "Rimuovi tutte le guardie"): risolvere OGNI categoria col gate `## LGTM`.

**Dedup a MONTE, non nel triage.** `scripts/lib/github-issue-creator.mjs` usa **titolo stabile** e commenta 🔁 sull'issue canonica. `post-merge-followup`/`FOLLOWUP.md` usa un bucket giornaliero in `Europe/Zurich` per repository target (`follow-up(daily:YYYY-MM-DD)`); sito e corpus separati. Triage: **puro bash, zero Claude, zero quota**.

### Bucket giornaliero follow-up

Il bucket usa titolo `follow-up(daily:YYYY-MM-DD): N item — owner/repo`, campi `State: collecting|sealed`, `Daily key`, `Target repository` e ID `FU-YYYY-MM-DD-NNN`. Il gate demota item senza acceptance e sigilla prima di `agent:fix`/`agent:fix-queued`. Il drainer promuove item `open` da `sealed`, senza PR che dichiari l'ID; `issue-fix` usa `Addresses #N` e `Follow-up item: FU-...`. Il reconciler chiude con validi `done`; watermark, retry e `## Post-merge follow-up triage` restano fail-safe.

## Categorie

| Categoria | Segnale (titolo/label) | Natura |
|---|---|---|
| `validation-failure` | "Validation Failure (dist\|live)", label `bug`+`priority:urgent` | alert post-deploy, spesso dupe/transiente |
| `crawler` | "Crawler Failure", "[crawler-health]", "[parser-health]", label `parser-broken` o `priority:high`+crawler/parser | selector drift, parser da rigenerare |
| `follow-up` | "follow-up(daily:YYYY-MM-DD)", label `follow-up` | bucket giornaliero di micro-task |
| `revenue` | label `revenue` / `rpm-canary`, "RPM canary" | monetizzazione, strategico |
| `tracker` | "master tracker", "recovery", senza label automation | piano umano multi-step |
| `other` | nessun match | catch-all, natura eterogenea |

## Triage flow (`issue-triage.yml`, on `issues: opened`) — deterministico, no Claude

Step bash unico (`Classify and route`), nessuna `claude-code-action`:

1. **Classifica** via regex su titolo+label → UNA categoria (ordine conservativo: revenue/tracker prima — guardia anti-collisione nomi azienda, es. "RPM Software AG" deve restare `revenue` non `crawler`). Vedi tabella "Categorie".
2. **`agent:triaged`** sempre (anti-loop, idempotente: gate `if: !contains(labels,'agent:triaged')`).
3. **Nessun commento per-categoria** (2026-07-05): ogni categoria è auto-fix, niente più branch "resta umana" da segnalare. Label + route sono il segnale.
4. **Routing** (vedi sotto): `crawler` → `agent:fix` via PAT immediato **se lo slot `issue-fix` è libero**, altrimenti in coda come tutti (#5514); ogni altra categoria → `agent:fix-queued` via PAT, issue OPEN.

Nessun dedup-close. Misclassificazione regex → fail-safe su `other`, comunque auto-fix via coda. Il triage non legge la lista delle issue aperte.

### Routing policy

| Categoria | Azione triage |
|---|---|
| `crawler` | **Auto-route `agent:fix` immediato** (`route='fix'`), ma **uno per run di sweep e solo a slot `issue-fix` libero** (`crawlerDirectFixBudget`, #5514): l'eccedenza va in `agent:fix-queued` + `fu-prio:high`. Regen parser deterministico, basso blast-radius, coperto da `generate-company-parser.mjs`. Production-critical, non è il treadmill source. |
| `follow-up` | **Auto-route `agent:fix-queued`** (`route='queue'`, 2026-06-04) + `fu-prio:high\|low`. NON parte subito: `followup-drainer.yml` lo promuove a `agent:fix` UNO alla volta, solo a slot `issue-fix` libero (high prima). Fix della starvation (vedi "Drenare il backlog" sotto). |
| `validation-failure` | **Auto-route `agent:fix-queued`** (`route='queue'`, 2026-07-05). Spesso transiente; transiente-vs-persistente non è decidibile in modo deterministico (bash) — resta in coda, drenata come le altre, nessun commento speciale. |
| `revenue` / `tracker` | **Auto-route `agent:fix-queued`** (`route='queue'`, 2026-07-05, `fu-prio:high` default, non più opt-in manuale — vedi "Scopo"). Ordine classificazione resta PRIMA di `crawler` (anti-collisione nomi azienda). |
| `other` | **Auto-route `agent:fix-queued`** (`route='queue'`, 2026-07-05). Nessuna categoria riconosciuta ma comunque un tentativo di fix, priorità `low` salvo segnali `priority:high/urgent`. |

**Pin fuori dal ciclo (`keep-open`, `agent:no-age-out`, #7648).** Una issue con una label vive FUORI dal repository: `classifyIssue` assegna `route='none'` + `autofix=false`; triage e drainer la escludono. `pinned`/`do-not-close` NON pinnano; `revenue`/`tracker` restano instradate. `agent:fix` **manuale** resta override.

**Meccanismo di routing (PAT in bash)**: `Classify and route` applica il label **via `GITHUB_PAT` con `gh` diretto**, solo se OPEN.
- **PAT, non GITHUB_TOKEN**: `GITHUB_TOKEN` non triggera `issue-fix`; `github-actions[bot]` non passa `sender == valerielinc-ops`.
- **Guard `state == OPEN`**: niente label su issue chiuse.
- Senza PAT (RC non caricato) → skip + warning; mai fixer via GITHUB_TOKEN.

### Frugalità quota (no ANTHROPIC_API_KEY)

Regola in AGENTS.md → "Auth automazioni & frugalità quota": solo `CLAUDE_CODE_OAUTH_TOKEN`, triage zero-Claude, max-turns non tagliati. No fixer su non-OPEN; `cancel-in-progress: false` serializza. `follow-up`: bucket giornaliero/repo, coda un item alla volta, gate `## LGTM`.

## Fix flow (`issue-fix.yml`, on `issues: labeled == agent:fix`)

Trigger: aggiungere `agent:fix` è il consenso. La mette l'owner o il triage, quest'ultimo solo via `GITHUB_PAT` (mai via `GITHUB_TOKEN`).

**Meccanismo comune ai quattro pre-flight 0.1/0/0.5/0.75 (zero-Claude, pre-Claude)**: rimuove `agent:fix`, posta il marker, imposta l'output guard e salta gli step Claude (`if:`).

0.1. **Pre-flight quota backoff** — `scripts/ci/check-quota-backoff.mjs`. Gira **prima di `npm ci`** (solo builtin Node + `gh`): un run bloccato costa ~15s invece di ~4min. Gate strutturale contro il bucket dominante — finestra 7gg 2026-07-29 → 08-05: **60 delle 61 run fallite sono HTTP 429** (quota Max condivisa esaurita, `num_turns: 1`, `total_cost_usd: 0`, Claude mai eseguito), e **49, l'80%, dentro una finestra già aperta** — prevedibili, perché il payload 429 dichiara `resetsAt`. Il gate legge il beacon `<!-- QUOTA_RESETS_AT: <epoch> -->` lasciato dalla run precedente sulle issue in `agent:fix`/`agent:fix-queued` e, se la finestra è aperta, ri-accoda questa issue (`agent:fix` → `agent:fix-queued`) **senza consumare un tentativo** → `<!-- FIX_OUTCOME: rate-limited -->`, `quota_blocked=true`. PROCEED-SAFE: nessun beacon attivo, beacon malformato o errore gh → procede invariato (un gate rotto non deve mai congelare la coda). Rationale completo e catena assorbente in `scripts/ci/claude-rate-limit.mjs`.
0. **Pre-flight already-resolved** — `scripts/ci/check-issue-already-resolved.mjs`. Gate strutturale (#1647) contro il bucket `fix-outcome:already-fixed`: molte follow-up sono **done-but-open**, risolte da una PR successiva senza `Closes #N`. Trigger: un token DISTINTIVO di `## Suggested action` già presente **verbatim** nel file citato su main → `<!-- FIX_OUTCOME: already-fixed -->`, `already_resolved=true`. CONSERVATIVO (bias procedere): follow-up **singole** non-in-flight con match forte; aggregate legacy e bucket `follow-up(daily:YYYY-MM-DD)` vengono lasciati al reconciler/fixer item-per-item, mentre aggregate/ambiguo/nessun match procedono invariati. Matcher condiviso con `reconcile-followups.mjs` (`scripts/ci/followup-resolution-match.mjs`).
0.5. **Pre-flight workflows-scope capability guard** — `scripts/ci/check-workflows-scope.mjs`. Gate strutturale (#4227, 12×/14gg di recidiva: la regola prosa in "Abort senza PR" non bastava, costava *dopo* la diagnosi completa). Trigger, uno dei due: (a) **body-esplicito** — la issue cita `.github/workflows/**` verbatim in backtick/code-block; (b) **recurrence** — auto-file `scan-job-timeouts.mjs` (label `ci-timeout`) con **titolo esatto** coincidente a una issue PRECEDENTE già chiusa con lo stesso marker → `<!-- FIX_OUTCOME: blocked-workflows-scope -->`, `workflows_blocked=true`. CONSERVATIVO (bias procedere): nessun match → procede invariato.
0.75. **Pre-flight in-progress claim gate** — `scripts/ci/claim-issue-in-flight.mjs`. Piena rationale in AGENTS.md → "Claim mutex `agent:in-progress`" (#4788/#4793). Reclama `agent:in-progress` PRIMA di ogni lavoro — zero-Claude, pre-tier/checkout (il controllo prompt-level allo step 1 arriva dopo, cieco a lavoro non ancora aperto in PR, #4793); se già presente → `<!-- FIX_OUTCOME: overlap-skip -->`, `in_flight=true`, zero quota Max OAuth spesa. Il claim porta anche `agent:remote` o `agent:local`: il fixer remoto rilascia solo il proprio owner. Se assente → la reclama e procede; release step simmetrico (`if: always()`) la rimuove su OGNI path terminale solo dopo aver verificato che l'acquisizione appartenga a questo run. FAIL-CLOSED: errore gh/API/parse → `in_flight=true`, `claim_acquired=false`, nessun fixer e nessun release.
1. **Pre-condizioni** (abort con commento se falliscono):
   - PR aperta già citante la issue → skip ("PR già in volo"). Difesa secondaria (0.75 è primaria) per il caso raro di PR già aperta senza label (es. lavoro manuale pre-esistente).
   - **Overlap-file**: estrai i path target dal body issue; se una PR aperta (`gh pr list --state open` + `gh pr diff <n> --name-only`) **già modifica** uno di quei file → skip ("file già in volo in PR #N; riaprire dopo il merge se pertinente") (rif. #934 vs #943). Issue non file-specifica → procedi.
2. Branch `fix/issue-<N>`.
3. Diagnosi **root cause** (non sintomo). `crawler` → rigenera parser / edit mirato selector+config.
4. Fix **chirurgico sulla classe del bug**, non sul singolo file — piena regola in AGENTS.md #6 (sibling-grep pre-push via `check-sibling-patterns.mjs --strict`, falso-positivo documentato per-file in `## Non implementato`, dismiss collettivo insufficiente, Post-#8 sibling reale = lavoro dovuto non chiusura). Mai abbassare gate (#1). Mai disabilitare Auto Ads (#7).
5. Commit identity canonica `Valerie Linc <valerielinc@gmail.com>`. No path home assoluti, no email personali (Privacy).
6. Push branch + `gh pr create`.
7. PR body OBBLIGATORIO `## Implementato` + `## Non implementato (ancora)` (REVIEW.md completeness contract). Una fix PR di un bucket giornaliero deve contenere `Addresses #N` e `Follow-up item: FU-YYYY-MM-DD-NNN`; **MAI `Closes #N`** finché resta anche un item valido aperto. Il fixer lavora un item/run e il reconciler chiude il bucket solo quando tutti gli item validi sono provati fatti. Per le follow-up legacy multi-item vale lo stesso veto: usare un **progress-ref senza keyword di chiusura**. `pr-body-contract.yml` (zero-Claude) valida header e riferimenti, non la precisione del contenuto — quella è responsabilità del fixer (#1508/#1470/#1469/#1456). **Self-check prima di `gh pr create`**: `git diff origin/main`, ogni bullet di `## Implementato` dev'essere nel diff; `## Non implementato (ancora)` elenca scope specifici (`- motivo: ...`), MAI `- ` vuoto o placeholder.
8. **Telemetria OBBLIGATORIA — ULTIMA azione del run:** posta sulla issue un commento con `<!-- FIX_OUTCOME: pr-created -->` (anche senza altri contenuti). Vale per il path happy (PR aperta) e per ogni abort: usa il codice appropriato tra `pr-created` · `blocked-workflows-scope` · `blocked-secrets` · `blocked-admin-settings` · `no-root-cause` · `overlap-skip` · `pr-already-open` · `already-fixed` · `revenue-tracker-manual`. Due codici li emettono i post-step deterministici, non l'agent: `max-turns` (subtype `error_max_turns`) e `rate-limited` (HTTP 429 — la run non e' mai partita). Senza marker → harvester classifica il run come `no-pr-unspecified`, indistinguibile da un crash silenzioso.
9. La PR fluisce in `pr-review-loop` → `## LGTM` → `auto-merge-on-lgtm`. **L'agent NON mergia a mano.**

### Tier (mirror di pr-review-loop)

| Tier | Trigger | Model / max-turns |
|---|---|---|
| high | issue tocca `crawler`/`parser`/`scripts/`/`build-plugin`/`.github/workflows/`/test gate | claude-opus-5 (`--effort medium`), 70 |
| normal | resto | claude-opus-5 (`--effort medium`), 55 |

### CODE vs DATA (no scroll dei blob — frugalità token, mirror del guard reviewer #1096)

I file rigenerati `data/**` (job JSON, snapshot, translation-cache, blog-articles), `public/**` (immagini/asset), `reports/**`, `_newsletter_variants/**` **NON sono code** da leggere riga-per-riga.

- **Root cause su output dati = fixa il CODE che li genera** (parser/crawler/build-plugin), non il blob a mano.
- Serve un campione? `Read` **mirato** (offset/limit), mai l'intero blob.
- `rg`/`grep` cross-file **scopati al code**: `rg <pattern> scripts build-plugins components services functions server hooks tests` (o `rg <pattern> -g '!data/**' -g '!public/**' -g '!reports/**'`).
- **Eccezione:** un file `data/**` checked-in che è **config/fixture** (non output rigenerato) e che il fix modifica a mano → trattalo come code.

### Abort senza PR (no fix forzato)

- Root cause non determinabile con confidenza → commento "serve indagine umana" + termina.
- **I segreti CI SONO**: Remote Config carica `CF_API_TOKEN`, `POSTHOG_*`, `GEMINI_API_KEY`, `GITHUB_PAT` e gli altri parametri in `process.env`. Implementa i fix che li richiedono; `blocked-secrets` vale **solo** per variabile davvero vuota, nominando la variabile (`RC_TO_ENV`).
  - **Eccezione — rotazione di credenziali.** L'autorizzazione copre l'USO, non la ROTAZIONE (`DECISIONS.md`). Richieste di ruotare/rigenerare/revocare restano umane: commento "rotazione di credenziali — resta una decisione umana (DECISIONS.md)" e termina PRIMA del diff.
- **Capability-guard scope `.github/workflows/**` (turno ~1, PRIMA di implementare).** Senza `APP_TOKEN_WORKFLOWS == 'true'` il push workflow fallisce **sempre**: posta il diff + "serve scope `workflows` / mano umana" e **TERMINA SUBITO**. Repo-setting/branch-protection/admin-API (403) → `blocked-admin-settings`.
- Mai un fix speculativo pur di produrre una PR.
- **Ogni abort DEVE chiudere con `<!-- FIX_OUTCOME: <code> -->` nel commento** (codici, e conseguenza del marker mancante: step 8).

### Drenare il backlog queue-managed (`followup-drainer.yml`, automatico)

`issue-fix` ha `concurrency: { group: issue-fix, cancel-in-progress: false }`: un trigger nuovo cancella il solo pending senza retry e lascia la label. Vale per OGNI categoria, **crawler inclusi**.

**Risolto da `followup-drainer.yml`** (cron + dispatch, **zero-Claude**, `scripts/ci/followup-drainer.mjs`): categorie ≠ `crawler` → `agent:fix-queued`; promuove **UNO** a `agent:fix` a slot libero, ordina `fu-prio:high` prima e usa `isQueueManaged()` (`classifyIssue().route === 'queue'`). **I crawler hanno `crawlerFixDecision`**: run senza verdetto → `fu-attempt:N` → `fu-parked` + `needs-human`; `max-turns`/verdetti fermi → park; `rate-limited` → hold/re-queue senza consumare tentativi.

**Rescue + park (terminazione autonoma):** un `agent:fix` queue-managed orfano (run morta, nessuna PR `fix/issue-N`, `updatedAt` > 30min) → `fu-attempt:N`++; a 3 → `fu-parked` (**non chiuso**, ri-tentabile). Solo a slot libero. Ri-processo: `agent:fix-queued`, non `agent:fix` diretto.

**Esiti ZERO-WORK — `rate-limited` NON consuma un tentativo.** Su HTTP 429 (`num_turns: 1`, `total_cost_usd: 0`) la issue non è letta. `ZERO_WORK` in `followup-drainer.mjs`: finestra aperta → **HOLD** (resta `agent:fix`); chiusa → **re-queue con `fu-attempt` invariato**.

**Backoff globale al DRAIN.** Con finestra 429 aperta il drainer legge `<!-- QUOTA_RESETS_AT: <epoch> -->` (scadenza **dichiarata dal server**) e **sospende le promozioni**.

### Stadio di decomposizione (`issue-decompose.yml`, 2026-08-21)

Le issue grandi restano nel ciclo: `agent:decompose-queued` → UNO `agent:decompose` per tick, sotto quota-backoff/fairness. Il planner **NON implementa**: produce ≤6 sub-issue con `## Scheda` (CAUSA / FIX / METRICA+COMANDO / OSSERVATORE), label `from-decompose` + `fu-prio`; >6 → 5 + UNA contenitore. Il padre usa `decomposed:1` + `<!-- DECOMPOSED_INTO: n1 n2 -->`; PARENT-CLOSE lo chiude a figlie chiuse. `decomposed:1`/`from-decompose` impediscono ricorsione. Esiti: `<!-- DECOMPOSE_OUTCOME: decomposed-K | atomic-requeue | needs-human-decision | already-resolved -->`; run morta → `decompose-retried`, poi `fu-parked`+`needs-human`. Il fixer verifica la CAUSA col COMANDO in ≤3 turni.

## Local fixer (`/fix-issue N`)

Per issue HIGH-risk o intervento manuale in coda: worktree-first, approvazione umana pre-push.

> ⚠️ `.gitignore` ignora `.claude/` (eccetto `settings.json`): `/fix-issue` vive localmente in `.claude/commands/fix-issue.md`; spec in Appendice A.

## Label

| Label | Significato | Chi la mette |
|---|---|---|
| `agent:fix` | opt-in: l'agent tenta un fix → PR | triage (`crawler` diretto, o promosso dalla coda per ogni altra categoria, **via PAT**) o owner manuale |
| `agent:in-progress` | mutex: qualcuno (fixer CI o sessione locale `/fix-issue`) sta lavorando la issue ORA — anti-doppione (#4788/#4793) | claim gate (0.75 sopra) o sessione locale (Appendice A); rilasciata a fine lavoro/abbandono da entrambi |
| `agent:triaged` | issue già processata da triage | triage (anti-loop) |
| `duplicate` | storm-duplicate, chiusa | triage |
| `job-content-quality` | un record crawlato non è un annuncio di lavoro (offerta commerciale, widget di consenso, voce di menu, placeholder di template) | `crawler-content-plausibility-audit.yml` e `scripts/report-crawler-content-error.mjs` |

## Segnalazione umana di un difetto di contenuto crawlato

Un difetto **visto a occhio** su una pagina live entra nella stessa pipeline con un comando, senza aprire una sessione:

```bash
node scripts/report-crawler-content-error.mjs <crawler-key|url-del-job> "<cosa c'è che non va>"
node scripts/report-crawler-content-error.mjs <...> --urgent    # route immediata
node scripts/report-crawler-content-error.mjs <...> --dry-run   # stampa e basta
```

`issue-triage` → `issue-fix` → PR → `## LGTM` → auto-merge.

Senza flag → categoria `other` → `agent:fix-queued`, drenata da `followup-drainer`. Con `--urgent` aggiunge `parser-broken` → categoria `crawler` → `agent:fix` immediato; il bypass della coda resta opt-in.

Contesto: `docs/CRAWLERS.md` → "Job-Content Plausibility".

## Contratto minimo per issue auto-generate (`## Segnali`, opt-in)

Un body col solo sintomo non dà cosa/come-riprodurre/evidenza. `issue-decompose.yml` usa `## Scheda`; i reporter zero-Claude usano `signals` opt-in.

`signals` in `createGithubIssue()` (`scripts/lib/github-issue-creator.mjs`, funzione `formatSignalsBlock`) NON è diagnosi: contiene i fatti del reporter:

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

Renderizza `## Segnali (raccolti automaticamente)` prima della `description`; è opt-in e senza `signals` il body resta invariato. `issue-fix.yml` legge il blocco e salta la ri-scoperta.

Caller ricchi (es. `report-validate-dist-failure.mjs`, `send-job-alerts.mjs`) non richiedono `## Segnali`; caso sottile: `reconcile-here-usage.mjs`.

## Kill-switch

- Disattivare auto-fix di una categoria: in `issue-triage.yml` togliere la categoria dal ramo che applica `agent:fix`, oppure disabilitare il workflow da GitHub UI.
- Disattivare TUTTO l'auto-routing: rimuovere `GITHUB_PAT` da Remote Config → triage ripiega su `GITHUB_TOKEN` e `agent:fix` non triggera il fixer.
- Bloccare un fix: rimuovere `agent:fix` prima che il fixer apra la PR.
- Claim stale: rimuovi la label a mano, poi ri-labella `agent:fix` se serve.
- Pausa totale: disabilitare `issue-fix.yml` / `issue-triage.yml` (Actions → workflow → Disable).

## Auto-improvement loop (`lessons-harvester.yml`, daily)

Pattern ricorrenti rientrano.

- **Telemetria (deterministica, no Claude)**: marker `<!-- FIX_OUTCOME: <code> -->` (codici: step 8) e reviewer-finding 🔴/🟡/❓ nei review body. Store = GitHub.
- **Aggregazione**: `scripts/ci/harvest-agent-lessons.mjs` (zero-Claude, daily), finestra 14gg, soglia ≥3; dopo dedup dei doc tiene solo cluster `novel`.
- **Proposta (1 turno Claude, solo se `has_novel`)**: aggiunte chirurgiche → **1 PR** `lessons/auto-harvest-*`; una sola proposta pendente.
- **Gate umano OBBLIGATORIO**: PR di regole mai auto-mergiata; review umana. Solo `.md`, mai logica.
- **Kill-switch**: disabilita `lessons-harvester.yml` da Actions UI; oppure alza `THRESHOLD`/abbassa `WINDOW_DAYS` via `workflow_dispatch`.

## Guardrail (da AGENTS.md, vincolanti)

- Auto-route su OGNI categoria (2026-07-05, vedi "Scopo" + "Routing policy"). Supervisione = gate `## LGTM`.
- Concurrency cap: un fixer/triage alla volta (no OOM, no PR concorrenti su stesso data file).
- PR sempre via reviewer + `## LGTM`; mai bypass auto-merge.
- Changes chirurgiche, root-cause, no drive-by.
- Privacy: identity canonica, no path home, no email personali.

---

## Appendice A — `.claude/commands/fix-issue.md` (local-only, non tracciato)

Lo spec completo, da salvare **verbatim** in `.claude/commands/fix-issue.md`, sta in **`docs/FIX-ISSUE-COMMAND.md`**. Riferimenti storici: `docs/AGENTS-HISTORY.md`, `docs/CI-CD-PIPELINE.md`.
