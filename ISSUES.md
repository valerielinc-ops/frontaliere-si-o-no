# Issue Automation Instructions

Contratto: `issue-triage.yml` (route **deterministico, senza agente**) e `issue-fix.yml` (fix → PR). Companion: `/fix-issue N` (`.claude/commands/fix-issue.md`).

## Scopo

Le issue sono **auto-generate dai monitor** e vanno classificate e sottoposte alla risk policy. Automazione solo con categoria, path e rischio verificabili; F1/F7, control-plane e segnali ignoti sono deny-by-default sulle issue. Le PR aperte seguono required check e review gate.

**Dedup a MONTE, non nel triage.** `scripts/lib/github-issue-creator.mjs` usa **titolo stabile** e commenta 🔁 sull'issue canonica. `post-merge-followup`/`FOLLOWUP.md` usa un bucket giornaliero `Europe/Zurich` per repository target; sito e corpus separati. Triage: **shell deterministico + helper Node (`scripts/lib/classify-issue.mjs`), senza agente e senza quota**.

### Bucket giornaliero follow-up

Il bucket usa titolo `follow-up(daily:YYYY-MM-DD): N item — owner/repo`, campi `State: collecting|sealed`, `Daily key`, `Target repository` e ID `FU-YYYY-MM-DD-NNN`. Il gate demota item senza acceptance prima di `agent:fix`/`agent:fix-queued`; il drainer promuove item `open` da `sealed` senza PR che dichiari l'ID; `issue-fix` usa `Addresses #N` e `Follow-up item: FU-...`. Il reconciler chiude con validi `done`; watermark, retry e `## Post-merge follow-up triage` restano fail-safe.

## Categorie

| Categoria | Segnale (titolo/label) | Natura |
|---|---|---|
| `validation-failure` | "Validation Failure (dist\|live)", label `bug`+`priority:urgent` | alert post-deploy, spesso dupe/transiente |
| `crawler` | "Crawler Failure", "[crawler-health]", "[parser-health]", label `parser-broken` o `priority:high`+crawler/parser | selector drift, parser da rigenerare |
| `follow-up` | "follow-up(daily:YYYY-MM-DD)", label `follow-up` | bucket giornaliero di micro-task |
| `revenue` | label `revenue` / `rpm-canary`, "RPM canary" | monetizzazione, strategico |
| `tracker` | "master tracker", "recovery", senza label automation | piano umano multi-step |
| `other` | nessun match | catch-all, natura eterogenea |

## Triage flow (`issue-triage.yml`, on `issues: opened`) — deterministico, senza agente

Step shell (`Classify and route`) con helper Node testabile, nessuna action di modello:

1. **Classifica** via regex su titolo+label → UNA categoria (revenue/tracker prima, per evitare collisioni di nomi azienda). Vedi tabella "Categorie".
2. **Valuta la risk policy** con `scripts/ci/lib/automation-risk-policy.mjs`: su issue surface F1/F7, control-plane, path sconosciuti, metadata non verificabili e issue non note bloccano il routing; la decisione è fail-closed.
3. **`agent:triaged`** sempre (anti-loop, idempotente: gate `if: !contains(labels,'agent:triaged')`). Una decisione bloccata rimuove eventuali label di routing stale e aggiunge `needs-human` con `GITHUB_TOKEN`.
4. **Routing consentito** (vedi sotto): `crawler` → `agent:fix` via App/PAT immediato **se lo slot `issue-fix` è libero**, altrimenti in coda; le altre categorie ordinarie → `agent:fix-queued` via App/PAT, solo su issue OPEN.

Nessun dedup-close. Una misclassificazione regex degrada a `other`, ma `other` non abilita automaticamente il fixer: senza una label ordinaria nota o altra categoria verificabile la policy nega. Il triage non legge la lista delle issue aperte.

### Routing policy

| Categoria | Azione triage |
|---|---|
| `crawler` | **Auto-route `agent:fix` immediato** (`route='fix'`) solo se la risk policy consente l’issue; uno per run di sweep e solo a slot `issue-fix` libero (`crawlerDirectFixBudget`, #5514), con eccedenza in `agent:fix-queued` + `fu-prio:high`. |
| `follow-up` | **Auto-route `agent:fix-queued`** (`route='queue'`) se non bloccato dalla policy, con `fu-prio:high\|low`. `followup-drainer.yml` promuove fino a 7 issue diverse a `agent:fix` quando gli slot sono liberi; ogni issue mantiene il proprio run/concurrency lane. |
| `validation-failure` | **Auto-route `agent:fix-queued`** (`route='queue'`) solo dopo la risk policy; resta in coda perché il carattere transiente non è decidibile dal triage deterministico. |
| `tracker` | `agent:fix-queued` solo se la policy trova una issue ordinaria verificabile; un riferimento a control-plane, path ignoto o dominio F1/F7 va a `needs-human`. |
| `revenue` | Normalmente **deny sull’issue surface**: i segnali revenue/RPM ricadono nel dominio F1/F7 `billing-revenue-partner`, quindi niente `agent:fix`/`agent:fix-queued`; serve gestione umana separata. |
| `other` | **Nessun auto-route per default**: passa solo con segnali ordinari espliciti (oggi `job-description-locale` o `job-title-locale`) e path/rischio verificabili; l’unknown resta `route='none'`. |

**Pin fuori dal ciclo (`keep-open`, `agent:no-age-out`).** Una issue con una label riceve `route='none'` + `autofix=false` ed è esclusa da triage/drainer. `pinned`/`do-not-close` NON pinnano. `needs-human` è veto sull’issue surface; rimozione e nuovo routing restano espliciti. `agent:fix` **manuale** non bypassa la risk policy F1/F7/control-plane.

**Meccanismo di routing (App/PAT in bash)**: `Classify and route` applica il label via installation token App (`APP_TOKEN`), con fallback `GITHUB_PAT` da Remote Config, solo se OPEN.
- **App/PAT, non GITHUB_TOKEN**: `GITHUB_TOKEN` non triggera `issue-fix`; `github-actions[bot]` non passa `sender == valerielinc-ops`. Resta per `agent:triaged` e `needs-human`.
- **Guard `state == OPEN`**: niente label su issue chiuse.
- Senza App/PAT (credenziali o RC non disponibili) → skip + warning; mai fixer via GITHUB_TOKEN.

### Frugalità quota (no ANTHROPIC_API_KEY)

Regola in AGENTS.md → "Auth automazioni & frugalità quota": fixer con `CODEX_AUTH_JSON`/broker Codex Luna Max; il wrapper locale non implica Claude/Anthropic. Triage deterministico; max-turns non tagliati, niente fixer su non-OPEN, `cancel-in-progress: false`, pool bounded. `follow-up`: bucket giornaliero/repo, un item alla volta, required `tests.yml` con `## LGTM`/review approvante e native auto-merge.

## Fix flow (`issue-fix.yml`, on `issues: labeled == agent:fix`)

Trigger: aggiungere `agent:fix` è il consenso. La mette l'owner o il triage, quest'ultimo via App/PAT (mai via `GITHUB_TOKEN`). Prima del job fixer, `risk_policy` riclassifica issue/path e può rimuovere il routing con `needs-human`.

**Meccanismo comune ai quattro pre-flight 0.1/0/0.5/0.75 (deterministico, pre-agent)**: rimuove `agent:fix`, posta il marker, imposta l'output guard e salta il lane Codex (`if:`).

0.1. **Pre-flight quota backoff** — `scripts/ci/check-quota-backoff.mjs`. Gira **prima di `npm ci`** (solo builtin Node + `gh`). Legge il beacon `<!-- QUOTA_RESETS_AT: <epoch> -->` lasciato da una run precedente su `agent:fix`/`agent:fix-queued`; con finestra aperta ri-accoda (`agent:fix` → `agent:fix-queued`) **senza consumare un tentativo** → `<!-- FIX_OUTCOME: rate-limited -->`, `quota_blocked=true`. PROCEED-SAFE: beacon assente/malformato o errore gh → procede invariato.
0. **Pre-flight already-resolved** — `scripts/ci/check-issue-already-resolved.mjs`. Gate contro `fix-outcome:already-fixed`: triggera se un token DISTINTIVO di `## Suggested action` già presente **verbatim** nel file citato su main → `<!-- FIX_OUTCOME: already-fixed -->`, `already_resolved=true`. CONSERVATIVO: solo follow-up **singole** non in-flight con match forte; aggregate legacy e bucket `follow-up(daily:YYYY-MM-DD)` restano al reconciler/fixer item-per-item; aggregate/ambiguo/nessun match procedono invariati. Matcher condiviso con `reconcile-followups.mjs` (`scripts/ci/followup-resolution-match.mjs`).
0.5. **Pre-flight workflows-scope capability guard** — `scripts/ci/check-workflows-scope.mjs`. Trigger, uno dei due: (a) **body-esplicito** — la issue cita `.github/workflows/**` verbatim in backtick/code-block; (b) **recurrence** — auto-file `scan-job-timeouts.mjs` (label `ci-timeout`) con **titolo esatto** coincidente a una issue PRECEDENTE già chiusa con lo stesso marker → `<!-- FIX_OUTCOME: blocked-workflows-scope -->`, `workflows_blocked=true`. CONSERVATIVO: nessun match → procede invariato.
0.75. **Pre-flight in-progress claim gate** — `scripts/ci/claim-issue-in-flight.mjs`. Dopo risk policy e preflight di quota/capability, reclama `agent:in-progress` prima di tier/Codex; se già presente → `<!-- FIX_OUTCOME: overlap-skip -->`, `in_flight=true`, zero quota Max. Con `agent:remote`/`agent:local`, il fixer remoto rilascia entrambi solo se `claim_acquired=true` dimostra la proprietà. Se assente → procede; release simmetrico (`if: always()`) su ogni path terminale. FAIL-CLOSED: errore gh/API/parse → `in_flight=true`, `claim_acquired=false`, nessun fixer e nessun release.
1. **Pre-condizioni** (abort con commento se falliscono):
   - PR aperta già citante la issue → skip ("PR già in volo"). Difesa secondaria (0.75 è primaria) per il caso raro di PR già aperta senza label (es. lavoro manuale pre-esistente).
   - **Overlap-file**: estrai i path target dal body issue; se una PR aperta (`gh pr list --state open` + `gh pr diff <n> --name-only`) **già modifica** uno di quei file → skip ("file già in volo in PR #N; riaprire dopo il merge se pertinente"). Issue non file-specifica → procedi.
2. Branch `fix/issue-<N>`.
3. Diagnosi **root cause** (non sintomo). `crawler` → rigenera parser / edit mirato selector+config.
4. Fix **chirurgico sulla classe del bug**, non sul singolo file — regola in AGENTS.md #6 (sibling-grep pre-push via `check-sibling-patterns.mjs --strict`, falso-positivo documentato per-file in `## Non implementato`). Mai abbassare gate (#1). Mai disabilitare Auto Ads (#7).
5. Commit identity canonica `Valerie Linc <valerielinc@gmail.com>`. No path home assoluti, no email personali (Privacy).
6. Push branch + `gh pr create`.
7. PR body OBBLIGATORIO `## Implementato` + `## Non implementato (ancora)` (REVIEW.md completeness contract). Una fix PR di bucket deve contenere `Addresses #N` e `Follow-up item: FU-YYYY-MM-DD-NNN`; **MAI `Closes #N`** finché resta anche un item valido aperto. Il fixer lavora un item/run; il reconciler chiude solo con tutti gli item validi provati fatti; per le legacy multi-item usare un **progress-ref senza keyword di chiusura**. `pr-body-contract.yml` valida header e riferimenti, non la precisione del contenuto. **Self-check prima di `gh pr create`**: `git diff origin/main`, ogni bullet di `## Implementato` dev'essere nel diff; `## Non implementato (ancora)` elenca scope specifici (`- motivo: ...`), MAI `- ` vuoto o placeholder.
8. **Telemetria OBBLIGATORIA — ULTIMA azione del run:** commento sulla issue con `<!-- FIX_OUTCOME: pr-created -->` per happy path e abort, usando i codici `pr-created` · `blocked-workflows-scope` · `blocked-secrets` · `blocked-admin-settings` · `no-root-cause` · `overlap-skip` · `pr-already-open` · `already-fixed` · `revenue-tracker-manual`; post-step emette anche `max-turns` (`error_max_turns`) e `rate-limited` (HTTP 429). Senza marker → `no-pr-unspecified`.
9. La PR passa required `tests.yml` (`vitest (unit + integration)`), review Codex approvante sulla stessa HEAD, eventuale autorebase bounded e native auto-merge. **L'agent NON mergia a mano**: GitHub merge dopo required check; `needs-human` è tracking, non veto. Dopo creazione/aggiornamento usa dalla root `bin/gh-frontaliere events subscribe --repo valerielinc-ops/frontaliere-si-o-no --resource pull_request --number <N> --wait-for merged,failed --agent-id <id>` e un solo `events listen`, poi verifica prima del cleanup.

### Tier (mirror del required job `tests.yml`)

| Tier | Trigger | Model / max-turns |
|---|---|---|
| high | issue tocca `crawler`/`parser`/`scripts/`/`build-plugin`/`.github/workflows/`/test gate | Codex Luna Max (`gpt-5.6-luna`, effort `max`), 70 |
| normal | resto | Codex Luna Max (`gpt-5.6-luna`, effort `max`), 55 |

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

`issue-fix` usa `concurrency: { group: issue-fix-${issue.number || run_id}, cancel-in-progress: false }`: la concorrenza è per issue; un trigger nuovo può sostituire solo il pending della stessa issue e lasciare la label da ri-armare dal drainer. Vale per le route consentite, **crawler inclusi**; il pool resta bounded.

`followup-drainer.yml` (`scripts/ci/followup-drainer.mjs`, cron + dispatch, **zero-agente**) gestisce categorie ≠ `crawler` come `agent:fix-queued`, promuove fino a **7 issue diverse** a `agent:fix` a slot liberi, ordina `fu-prio:high` e usa `isQueueManaged()` (`classifyIssue().route === 'queue'`). **I crawler hanno `crawlerFixDecision`**: run senza verdetto → `fu-attempt:N` → `fu-parked` + `needs-human`; `max-turns`/verdetti fermi → park; `rate-limited` → hold/re-queue senza tentativi.

**Rescue + park:** un `agent:fix` queue-managed orfano (run morta, nessuna PR `fix/issue-N`, `updatedAt` > 30min) → `fu-attempt:N`++; a 3 → `fu-parked` (**non chiuso**, ri-tentabile). Solo a slot libero; ri-processo con `agent:fix-queued`, non `agent:fix` diretto.

**Esiti ZERO-WORK — `rate-limited` NON consuma un tentativo.** Su HTTP 429 (`num_turns: 1`, `total_cost_usd: 0`) la issue non è letta: `ZERO_WORK` in `followup-drainer.mjs` → finestra aperta: **HOLD** (resta `agent:fix`); chiusa: **re-queue con `fu-attempt` invariato**.

**Backoff globale al DRAIN.** Con finestra 429 aperta legge `<!-- QUOTA_RESETS_AT: <epoch> -->` (scadenza **dichiarata dal server**) e **sospende le promozioni**.

### Stadio di decomposizione (`issue-decompose.yml`, 2026-08-21)

Le issue grandi restano nel ciclo: `agent:decompose-queued` → UNO `agent:decompose` per tick, sotto quota-backoff/fairness. Il planner **NON implementa**: produce ≤6 sub-issue con `## Scheda` (CAUSA / FIX / METRICA+COMANDO / OSSERVATORE), label `from-decompose` + `fu-prio`; >6 → 5 + UNA contenitore. Il padre usa `decomposed:1` + `<!-- DECOMPOSED_INTO: n1 n2 -->` e PARENT-CLOSE lo chiude a figlie chiuse; `decomposed:1`/`from-decompose` impediscono ricorsione. Esiti: `<!-- DECOMPOSE_OUTCOME: decomposed-K | atomic-requeue | needs-human-decision | already-resolved -->`; run morta → `decompose-retried`, poi `fu-parked`+`needs-human`. Il fixer verifica CAUSA col COMANDO in ≤3 turni.

## Local fixer (`/fix-issue N`)

Per issue HIGH-risk o intervento manuale in coda: worktree-first, approvazione umana pre-push.

> ⚠️ `.gitignore` ignora `.claude/` (eccetto `settings.json`): `/fix-issue` vive localmente in `.claude/commands/fix-issue.md`; spec in Appendice A.

## Label

| Label | Significato | Chi la mette |
|---|---|---|
| `agent:fix` | opt-in: l'agent tenta un fix → PR | triage (`crawler` diretto, o promosso dalla coda per le categorie consentite, **via App/PAT**) o owner manuale soggetto alla risk policy |
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

`issue-triage` → `issue-fix` → PR → required `tests.yml` → review Codex approvante → native auto-merge GitHub.

Senza flag → `other` e routing soggetto alla policy; senza segnale verificabile → `route='none'`. Con `--urgent` aggiunge `parser-broken` → `crawler` → `agent:fix` immediato se consentito; il bypass resta opt-in.



## Contratto minimo per issue auto-generate (`## Segnali`, opt-in)

Un body col solo sintomo non dà cosa/come-riprodurre/evidenza. `issue-decompose.yml` usa `## Scheda`; i reporter zero-agente usano `signals` opt-in.

`signals` in `createGithubIssue()` (`scripts/lib/github-issue-creator.mjs`, `formatSignalsBlock`) NON è diagnosi: contiene i fatti già raccolti dal reporter.

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

Renderizza `## Segnali (raccolti automaticamente)` prima di `description`; è opt-in, senza `signals` il body resta invariato, e `issue-fix.yml` salta la ri-scoperta.

Caller ricchi (es. `report-validate-dist-failure.mjs`, `send-job-alerts.mjs`) non richiedono `## Segnali`; eccezione: `reconcile-here-usage.mjs`.

## Kill-switch

- Disattivare auto-fix di una categoria: in `issue-triage.yml` togliere la categoria dal ramo che applica `agent:fix`, oppure disabilitare il workflow da GitHub UI.
- Disattivare TUTTO l'auto-routing: rendere indisponibili sia il token App di routing sia `GITHUB_PAT` in Remote Config → il triage resta deterministico ma non applica label che triggerano il fixer (mai ripiegare su `GITHUB_TOKEN`).
- Bloccare un fix: rimuovere `agent:fix` prima che il fixer apra la PR.
- Claim stale: rimuovi la label a mano, poi ri-labella `agent:fix` se serve.
- Pausa totale: disabilitare `issue-fix.yml` / `issue-triage.yml` (Actions → workflow → Disable).

## Auto-improvement loop (`lessons-harvester.yml`, daily)

Pattern ricorrenti rientrano.

- **Telemetria (deterministica, senza agente)**: marker `<!-- FIX_OUTCOME: <code> -->` (codici: step 8) e reviewer-finding 🔴/🟡/❓ nei review body. Store = GitHub.
- **Aggregazione**: `scripts/ci/harvest-agent-lessons.mjs` (deterministica, daily), finestra 14gg, soglia ≥3; dopo dedup dei doc tiene solo cluster `novel`.
- **Proposta (1 turno Codex Luna Max, solo se `has_novel`)**: aggiunte chirurgiche → **1 PR** `lessons/auto-harvest-*`; una sola proposta pendente.
- **Gate umano OBBLIGATORIO**: PR di regole mai auto-mergiata; review umana. Solo `.md`, mai logica.
- **Kill-switch**: disabilita `lessons-harvester.yml` da Actions UI; oppure alza `THRESHOLD`/abbassa `WINDOW_DAYS` via `workflow_dispatch`.

## Guardrail (da AGENTS.md, vincolanti)

- Routing preceduto dalla policy F1/F7/control-plane/path: deny-by-default sull’issue surface; le categorie consentite seguono il direct/queue bounded descritto sopra.
- Concurrency bounded: claim per issue, `cancel-in-progress: false` e pool drainer limitato (no OOM, no PR concorrenti sullo stesso lavoro).
- PR sempre via required `tests.yml` + review Codex approvante; mai bypass del native auto-merge GitHub.
- Changes chirurgiche, root-cause, no drive-by.
- Privacy: identity canonica, no path home, no email personali.

---

## Appendice A — `.claude/commands/fix-issue.md` (local-only, non tracciato)

Lo spec completo, da salvare **verbatim** in `.claude/commands/fix-issue.md`, sta in **`docs/FIX-ISSUE-COMMAND.md`**. Riferimenti storici: `docs/AGENTS-HISTORY.md`, `docs/CI-CD-PIPELINE.md`.
