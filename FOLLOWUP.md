# Follow-up Triage Instructions

Contratto per `post-merge-followup.yml`: residui di PR/review finiscono in un solo bucket giornaliero `follow-up` per repository target.

## Contratto corrente — bucket giornaliero

La forma canonica è:

```text
follow-up(daily:YYYY-MM-DD): N item — owner/repo
```

Chiave = giorno della run riuscita in `Europe/Zurich`, mai `mergedAt`. Solo il successo avanza il watermark; il retry rilegge la finestra. `## Post-merge follow-up triage` è il marker idempotente per-PR, anche in bucket esistente.

Una PR daily con `Addresses #<bucket>` e `Follow-up item: FU-...` cerca finding nuovi: aggiorna `Sources` per i coperti e aggiunge gli altri al padre, riaprendo `collecting` e risigillando. Padre illeggibile → blocco sulla PR, nessun contenitore alternativo.

Ogni bucket va da `State: collecting` a `State: sealed`. In raccolta non porta `agent:fix`/`agent:fix-queued`; il gate completa i chunk, usa `hasFalsifiableAcceptance()`, demota gli item non verificabili, sigilla e aggiunge `agent:fix-queued`. Un errore lascia `collecting`, item e watermark intatti.

Ogni item ha ID stabile `FU-YYYY-MM-DD-NNN` e campi `State`, `Sources`, `Target repository`, `Target file`, `Original text`, `Suggested action`, `Acceptance token`. Dedup su `target repository + target file + token/azione normalizzata`; match → accorpa `Sources`. Append concorrenti: rileggi e ricostruisci se la baseline diverge; sealing/demozione anche in commenti append-only.

Il drainer promuove bucket `sealed` con item `open` senza PR che ne dichiari l'ID; `issue-fix` ne seleziona uno per run. PR parziale: `Addresses #<bucket>` + `Follow-up item: FU-YYYY-MM-DD-NNN`, mai `Closes #<bucket>`. Il reconciler chiude solo con tutti gli item validi `done` e provati; body/stato/acceptance/prova non affidabili lasciano aperto (§ Stati dell'item, scrittori e chiusura).

## Gate grandchild-suppression (zero-agente, PRIMA del triage)

`post-merge-followup.yml` gira su OGNI PR mergiata dall'owner, **incluse le fix di follow-up**: senza guardia ogni merge può generarne altri.

Lo step zero-agente `scripts/ci/is-followup-fix-pr.mjs` precede Codex e salta i fixer branch diretti a `follow-up`. Una fix daily con `Addresses #<bucket>` + `Follow-up item: FU-...` aggiunge finding nuovi al **padre**, mai a nuova issue; scope deferred resta lì. **Proceed-safe**: branch/body illeggibile o errore `gh issue view` → triage normale.

## Scopo

Ogni 🟡 nit, ❓ q e voce `## Non implementato` DEVE diventare item `follow-up`, drop motivato o verifica live in `Live-verification` (nessuna issue/fixer; vedi `## Filtro scopo → Hard-exclude: live-verification-only item`). Nessun silent ignore; filtra via `REVIEW.md` → "Scopo progetto".

## Input

- PR merged: `gh pr view $PR_NUMBER --json number,title,body,mergedAt,mergeCommit,url`
- Reviewer bot reviews: `gh api repos/$REPO/pulls/$PR_NUMBER/reviews` (filtra `user.type == "Bot"` + login `github-actions[bot]`, `frontaliere-automation[bot]` o `claude[bot]` storico)
- Issue esistenti collegate: `gh issue list --label follow-up --state all --search "PR #$PR_NUMBER" --json number,title,body`

## Parse rules

### Da PR body

Estrai sezione `## Non implementato (ancora)`. Ogni bullet `- **X** — Y` → candidate item.

**Post-#8 (`AGENTS.md → Non-Negotiable #8`): `## Non implementato` NON è scope-deferito-e-chiuso, è il piano di completamento di un task ancora APERTO.** Idealmente l'agente lo svuota in-task (PR concatenate) e questa sezione legge «Nessuno» → zero candidate. Quando invece resta scope dovuto, va **tracciato a completamento**, non droppato:

- `Nessuno` / sezione vuota → nessun candidate (task completo).
- Voci `blocked: <causa esterna reale>` → candidate issue (label `blocked`), tracciate fino a sblocco.
- **Ogni altra voce di scope dovuto → candidate issue** (il task non è chiuso finché non è fatta). Il vecchio skip su motivo `out of scope` / `posposto` è **ABOLITO**: non sono più scappatoie di chiusura. Restano fuori solo le categorie hard-exclude qui sotto (churn non-actionable / missing-test / live-verify-only), che non sono scope-feature.

**Il routing lo decide lo STATO LETTERALE del bullet**, ed è già codificato — `scripts/ci/followup-has-candidates.mjs` importa `bulletState()` da `scripts/lib/pr-body-sections-check.mjs`, che è la sola definizione della tassonomia. Questo elenco la descrive, non la duplica:

| stato dichiarato | candidate? | perché |
|---|---|---|
| `in questa PR` | no | è già nel diff mergiato |
| `PR concatenata #N` | no | ha già il suo tracciamento: la issue sarebbe un doppione |
| `per scelta` / `by construction` | no | è un no motivato, non un rinvio |
| `blocked: decisione del proprietario` | no | deciso da chi decide |
| `blocked: <causa tecnica>` | **sì** | lavoro sospeso su una causa esterna: va riaperto |
| **nessuno stato dichiarato** | **sì** | fail-safe: un residuo non qualificato è lavoro potenzialmente dovuto, e tacerlo è peggio che generare una traccia |

### Da reviewer bot reviews

Parse il body markdown della review più recente. Per ogni riga:

- `🔴 Important: ...` → SKIP. 🔴 blocca merge, se la PR è merged significa che è stato fixato in-PR o droppato consapevolmente. Non creare follow-up per 🔴 retroattivi.
- `🟡 Nit: ...` → candidate issue.
- `❓ q: ...` → candidate issue (rephrase come "Verifica: <q>").
- `🟣 Pre-existing: ...` → candidate issue solo se file ancora presente nel diff (`gh pr diff`).
- `## Adversarial check` bullets → candidate issue per ogni voce (3 typical).

## Filtro scopo

Applica `REVIEW.md → "Scopo progetto"`. Item passa SE impatta monetizzazione / traffico organico / funnel reale. Altrimenti drop con rationale loggato nel commento di chiusura sulla PR.

### Hard-exclude: churn non-actionable (mai aprire follow-up)

Prima del filtro funnel, **droppa senza eccezioni** gli item di manutenzione documentale o pura igiene del codice, da PR body o reviewer: non sono funnel-critici.

Droppa (reason: `non-actionable-churn`) se l'item è essenzialmente uno di:

- **Doc/anchor/line-number rot**: "aggiorna line anchors", "i riferimenti `file:NNN` sono sfasati", "i link a PR #N nel commento sono stale", "de-rot comment".
- **"Document the intent / rationale"**: aggiungere commenti che spiegano codice già funzionante, senza cambio di comportamento.
- **Pure style/leggibilità/naming/format** non legati a un bug funnel.
- **Item che il reviewer stesso marca** `deferred` / `non funnel-critical` / `nit puro` (vedi `AGENTS.md → Post-merge feedback handling`, eccezione "drop senza issue").

### Hard-exclude: missing-test nit (mai aprire follow-up)

Categoria a sé, **droppata sempre** (reason: `missing-test-nit`), prima del filtro funnel, da reviewer o PR body `## Non implementato`, **anche se funnel-critica**. Il reviewer non dovrebbe emetterla (`REVIEW.md → IGNORA → test coverage`), ma la regola vale per i residui.

Droppa se l'item è essenzialmente uno di:

- "Manca un test per X" / "aggiungere test coverage" / "committare i test citati nel PR body" / "pinnare il comportamento con un test" / "test mancante sul ramo/path Y".
- Voce adversarial-check che lamenta assenza di test invece di un rischio di comportamento.

**NON droppare** (resta in scope normale): un BUG in un test ESISTENTE — assertion sbagliata, regex/guard leaky che resta verde sulla regressione, fixture con date assolute (#1035) — è correttezza, non coverage.

### Hard-exclude: live-verification-only item (mai aprire follow-up — batch in checklist)

Categoria **mai mintata come issue `follow-up`** (reason: `live-verify-only`), prima del filtro funnel, da ogni fonte (reviewer 🟡/❓/adversarial o PR body `## Non implementato`/`## Test plan` `- [ ]`). Vale quando l'**unica azione è verificare il sito deployato**, senza file da editare: `agent:fix` non può farlo.

Segnali `live-verify-only` (SOLO ispezione runtime, nessun edit):

- "verify live" / "verifica live" / "post-deploy" / "(post-merge, live)" / "(live)" / "controlla in prod" / "su prod" / "una volta deployato".
- "curl" la URL di produzione / "live-200" / "live curl" / controllo HTTP status sul sito live.
- "render at NNNpx" / "renderizza a 382px" / "apri DevTools" / "ispeziona nel browser" / "Playwright hydration" / verifica visuale o CLS a runtime.
- Checkbox `## Test plan` `- [ ]` esplicitamente etichettata `(post-merge, live)` / `(live)` / "verifica post-deploy" e non spuntata (il reviewer la flagga 🟡 "ricorda spunta post-merge", vedi `REVIEW.md → Test plan compliance`).

**Routing, non drop silenzioso:** niente issue; un'unica checklist `Live-verification` per PR nel `## Closing comment`, senza fixer.

**NON `live-verify-only`** se mescola verifica e file editabile ("aggiungi `min-height` a `AdSlot.tsx` E poi verifica il CLS live"): resta candidate. Solo ispezione runtime → live-only; dubbio → actionable.

**Override deterministico:** un path editabile in `Original text` + `## Suggested action` (`.tsx`/`.ts`/`.mjs`/`.js`/`.yml`/`.yaml`/`.json`/`.md`/`.css`, es. `scripts/foo.mjs`, `components/Bar.tsx`, `build-plugins/baz.ts`) rende **`actionable`** nonostante frasi live. `/sitemap.xml` non è path-token (`.xml`/`.html` esclusi).

### Hard-exclude: no-acceptance-condition — ora ANCHE un gate deterministico dopo il conio

`Suggested action` deve citare in backtick un token-codice distintivo. `no-valid-item` non si chiude MAI: `aggregateCloseGate()` la blocca per evidenza assente.

`Gate sul conio` (`scripts/ci/gate-minted-followups.mjs`, zero-agente) rilegge la issue e usa `hasFalsifiableAcceptance()` da `scripts/ci/followup-resolution-match.mjs`. Item invalidi → **demoti** in `Live-verification`; zero item → issue **soppressa**. Corpo senza struttura → non soppresso.

Conseguenza: senza `- Suggested action:` con token-codice l'item non sopravvive. Scrivi simbolo, costante o path che un `grep` futuro troverà.

**Seconda strada: scheda con `COMANDO`.** L'oracolo accetta `Suggested action` + token **oppure** `- METRICA: prima=<n> atteso=<n> | COMANDO: <comando>` con referente file/script/test (path con `/` ed estensione). È il `COMANDO` di `issue-decompose.yml` (`## Scheda`) e `scripts/audit-canton-url-drift.mjs`:

- **Il referente non deve esistere ancora.** Un test futuro è valido: l'esistenza si verifica alla chiusura.
- **Una metrica già al bersaglio viene rifiutata.** `prima=N atteso=N` è rifiutato; una soglia (`atteso=<N`) resta ammessa.
- **Il gate non esegue il comando.** Verifica referente e forma, non che oggi fallisca.

Il ramo è in `hasFalsifiableAcceptance()`, condiviso da apertura/chiusura. Item ammesso senza token mantiene `detectAlreadyResolved()` a `false`: allarga il conio, non la chiusura.

**Il metro vale sulla tua `Suggested action`, non sul grezzo; il token si DERIVA.** `suggestedActionText()` grezzo include `Original text`, la chiusura no: falso match → `no-valid-item`. `citedTokens()` può dare `["manifest.counts"]` sul grezzo e `[]` sull'item. Aggiungi file/simbolo/campo (`nomeFunzione()`, `oggetto.campo`, `COSTANTE >= 1`), non identificatore/path nudo rifiutato da `isDistinctiveToken()`. Rinuncia solo senza nulla da toccare.

**Token assente oggi.** Il token derivato è ciò che un `grep` troverà DOPO la fix e NON trova oggi nel `Target file`. Se il residuo è già vero su `main`, niente item: motivo `already-on-main` nel commento di triage. **Instradamento dal manifest di mirror** (`routes` del bundle, regola di `bin/where-to-fix`): un file `identical` si conia nel sito col suo `sitePath`; `repo: unknown` → repository della PR con la nota `route-unverified`.

### Ammissione al conio: demozioni e osservazioni

Il gate sul conio passa ogni item a `mintAdmission()` (`scripts/ci/lib/followup-mint-admission.mjs`). I codici sono i valori di `MINT_OBSERVATIONS`, contati nella riga `MINT_GATE_TALLY`. Un item demoto esce dal corpo e resta, integrale, nel commento sulla PR sorgente.

| codice | effetto | quando |
|---|---|---|
| `closed-state-bullet` | demozione | l'`Original text` è un bullet già chiuso secondo `nonCandidateVerdict()` (`per scelta`, `in questa PR`, «falso positivo»…); non legge file |
| `target-file-missing` | demozione | il `Target file` non esiste nel repository del bucket, neanche col nome che gli dà il manifest |
| `target-in-twin` | annota la demozione | il manifest lo assegna al gemello: il commento nomina repo e path, nessuno spostamento automatico |
| `target-rewritten` | ammesso, campo riscritto | esiste qui con un altro nome (`identical` → `sitePath`, `engine/` ↔ `packages/articles/engine/`) |
| `target-identical-in-corpus` | ammesso, contato | bucket del corpus con `Target file` `identical`: si corregge nel sito |
| `acceptance-already-true` | ammesso + `FU_ITEM_BORN_SATISFIED` | token già vero al conio (stesso oracolo della chiusura); misura, non demozione: `DEMOTE_BORN_SATISFIED = false` |
| `token-is-declaration` | ammesso, contato | token `nome()` con `nome` solo dichiarato nel file: diventa vero quando una fix lo chiama |
| `admission-unknown` | ammesso, contato | manifest o lettura non disponibili: mai una demozione |

**Un token già vero al conio non conferma l'item:** con `FU_ITEM_BORN_SATISFIED` non diventa `done` e blocca il bucket (`born-satisfied-token`).

## Dedup

Tre livelli, in quest'ordine:
- **PR-level**: se i commenti contengono `## Post-merge follow-up triage`, salta la PR (idempotenza re-run/backfill).
- **Bucket-level**: calcola `(daily key, target repository)` e riusa `follow-up(daily:<key>)`; aggiungi solo item nuovi a `collecting`, senza creare un secondo bucket per la stessa finestra.
- **Item-level**: fingerprint `target repository + target file + token/azione normalizzata`; match → accorpa in `Sources`, non duplicare.
- **In-flight PR overlap**: per item file-specifici usa `gh pr list --state open --json number,title` + `gh pr diff <n> --name-only`; se una PR aperta modifica il target → **escludi l'item** + log "in-flight in PR #N" (vedi `ISSUES.md → "Pre-condizioni — overlap-file"`). Nel dubbio → non escludere.

Il gate `is-followup-fix-pr.mjs` sopprime i nipoti. Con i marker (`Addresses` + `Follow-up item`) una fix daily può cercare finding nuovi, da deduplicare e aggiungere al bucket padre; non crea una nuova issue.

Se dopo il dedup zero item sopravvivono → nessuna issue, summary "zero outstanding items".

## Issue format

**Un solo bucket per giorno e repository target**: non una issue per PR/item. Sito e corpus restano separati; il bucket accetta append da più PR e il fixer lavora un item alla volta.

```markdown
Title: follow-up(daily:<YYYY-MM-DD>): <N> item — <owner/repo>

Body:
## Batch
- Daily key: <YYYY-MM-DD> (Europe/Zurich)
- State: collecting | sealed
- Target repository: <owner/repo>

## Item

### FU-<YYYY-MM-DD>-001 — <one-line item>
- State: open | in-progress | done | blocked
- Sources: PR #<PR_NUMBER>; reviewer 🟡 nit
- Stato dichiarato nella PR: <lo stato letterale verbatim, es. `blocked: <causa>` | nessuno>
- Target file: `path/to/file.mjs`
- Original text:
  > <verbatim>
- Funnel area: <monetizzazione | traffico | UX>
- Suggested action: <next step concreto>
- Acceptance token: `<token-codice-distintivo>`

### FU-<YYYY-MM-DD>-002 — <one-line item>
- State: open
- Sources: PR #<PR_NUMBER>
- Stato dichiarato nella PR: ...
- Target file: `path/to/other.mjs`
- Original text:
  > ...
- Rationale: ...
- Suggested action: ...
- Acceptance token: `otherGuard()`
```

`Stato dichiarato nella PR` è **obbligatorio su ogni item, anche quando è `nessuno`**. Un item `nessuno` NON va filtrato: va aperto e qualificato dal fixer.

Anche con un solo candidate item il bucket mantiene ID, stato e schema completo. Gli ID non vengono rinumerati quando un item viene demoto.

Labels: `follow-up` + UNO tra `funnel-monetization` / `funnel-seo` / `funnel-ux` per funnel-area; mix → più funnel-* label.

## Closing comment

Dopo append o drop, posta UN commento riepilogativo sulla PR; è sempre per-PR:

```markdown
## Post-merge follow-up triage

Created/updated: daily bucket #<id> `follow-up(daily:<YYYY-MM-DD>)` con N item:
- <item1 one-line>
- <item2 one-line>

Live-verification (manuale post-deploy, nessuna issue/fixer): Q item
- [ ] "<verbatim>" — <segnale: post-deploy | curl prod | render NNNpx | DevTools/Playwright>

Dropped: M item
- "<verbatim>" — <reason: out-of-scope | dup-of-#X | non-funnel | non-actionable-churn | missing-test-nit>

Skipped: P item (🔴 pre-merge or duplicate active follow-up)
```

Item finiti in **più bucket** (per esempio uno nel corpus e uno nel sito, vedi `## Routing cross-repository`) → UNA riga di claim per bucket, ciascuna con il proprio `#<id>`, repository e conteggio:

```markdown
Created/updated: daily bucket #<id-corpus> `follow-up(daily:<YYYY-MM-DD>)` (corpus) con K item:
- <item one-line>
Created/updated: daily bucket #<id-sito> `follow-up(daily:<YYYY-MM-DD>)` (sito) con J item:
- <item one-line>
```

«Verify complete follow-up triage» unisce tutte le righe `Created/updated:` e prova OGNI bucket citato. Legge anche la forma che il triage scrive spontaneamente, conteggio in testa e un bucket per bullet (`Created/updated: 2 item.` seguito da ``- Corpus #1957 `follow-up(daily:2026-09-28)` — …``, marker di #10015): nei bullet subito sotto la riga di claim un `#<id>` vale come bucket solo se è seguito dal tag `` `follow-up(daily:<YYYY-MM-DD>)` `` sulla stessa riga. Il repository dichiarato è informativo: il numero viene cercato in entrambi i repo. La prosa dopo la lista (bucket storici, sealed) non è claim. Un marker con verdetto definitivo «non persistito» da oltre 6 ore esce dal batch come **quarantena** visibile (warning, summary, output `quarantined_prs`, issue «Post-merge follow-up: marker di triage in quarantena»), invece di tornare a ogni run.

`Live-verification` raccoglie **tutti** gli item `live-verify-only` (vedi `## Filtro scopo → Hard-exclude: live-verification-only item`) in una checklist `- [ ]`, una per PR: **nessuna issue e nessun fixer**. Ometti se Q=0; mai promuovere a issue.

Zero item dopo filtro+dedup e zero live-verify → `## Post-merge follow-up triage: zero outstanding items.` senza bucket. Solo live-verify → summary con `Live-verification` e `Created: 0 issue (solo live-verification batchata)`.

Tutti `Dropped`/`Skipped` (zero item da QUESTA PR, anche con bucket esistente) → claim `Created/updated: 0 item.` con **0 in cifre**. «Verify complete follow-up triage» legge il numero: prosa senza cifra rende rossa la run (35904571443, 35933207218).

## Supersede detection → spostata su `followup-reconcile` (deterministica, zero-agente)

**2026-06-04:** la supersede detection è in `followup-reconcile.yml` (`scripts/ci/reconcile-followups.mjs`, cron daily, **zero-agente**): per ogni issue `follow-up` aperta verifica se la fix è **presente verbatim** nel file/token citato.

**2026-06-10 — auto-close a due tier.** `reconcile` chiude in autonomia, ma SOLO con **doppia conferma separata nel tempo** + veti di sicurezza:

1. **1ª detection** (issue non ancora `maybe-resolved`) → commento advisory + label `maybe-resolved`. **Finestra di grazia**: l'umano ha fino al run successivo per obiettare (rimuovere la label, aggiungere `keep-open`/`pinned`, riaprire lo scope).
2. **2ª conferma** (la issue porta GIÀ `maybe-resolved` da un run precedente, è ANCORA risolta, ha il nostro commento-marker, è un bucket con **tutti** gli item validi `done` — oppure una legacy **single-item** —, **non** ha label keep-open/strategica, e l'evidenza è **forte**) → **auto-close** `--reason completed` + label `fu-resolved-auto`.

Per un bucket il veto è item-per-item: body/ID/stato/acceptance/item/token/evidenza invalidi impediscono la chiusura. Chiudi solo con **ogni item valido** `done` e prova `isStrongAutoCloseEvidence()`. Fix parziale: `Addresses #N` + `Follow-up item: FU-...`, mai `Closes #N`. Le label **keep-open/pinned/revenue/tracker/do-not-close** sono veti umani; rimozione dopo il flag = **obiezione umana**. `RECONCILE_NO_AUTOCLOSE=1` torna flag-only. Logica in `tests/reconcile-followups-decision.test.ts`; matcher `issue-fix` in `followup-resolution-match.mjs`, AGENTS.md #6.

Gap: un refactor senza token non viene flaggato; reconcile cerca token verbatim.

## Stati dell'item, scrittori e chiusura

Lo stato vive nel corpo (`- State:` dell'item), la prova nei commenti come marker: i letterali escono solo da `scripts/ci/lib/followup-item-evidence.mjs` (più `FU_BUCKET_VERIFY_REQUEST` da `scripts/ci/reconcile-followups.mjs`) e contano solo da autori fidati. Stati ammessi dal parser: `open`, `in-progress`, `done`, `blocked`. Ogni transizione automatica ha uno scrittore deterministico:

| transizione | scrittore | condizione |
|---|---|---|
| conio → `blocked` | triage (`post-merge-followup.yml`) | bullet `blocked:` con causa non di codice, scritta in `Blocked on:` |
| `open`/`in-progress` → `done` | SOLO il reconciler (`scripts/ci/reconcile-followups.mjs`) | token confermato da `detectAlreadyResolved()` e non nato vero |
| `open` → `blocked` | `scripts/ci/route-already-fixed.mjs` (post-step del fixer) | `already-fixed` con terna verificata e legata all'item → `awaiting-verification`; secondo `already-fixed` senza prova → `already-fixed-unverified`; verdetto non ritentabile (`ITEM_BLOCKING_OUTCOMES`: `no-root-cause`, `blocked-admin-settings`) senza PR consegnata → motivo = esito (con PR consegnata o delivery illeggibile, solo il tentativo) |
| `blocked` → `done` | reconciler (`scripts/ci/lib/followup-blocked-recheck.mjs`) | token confermato e non nato vero (marker, o la stessa misura sul file a fine giorno del bucket) |
| `blocked` → `open` | reconciler, UNA volta per item | commit nuovo su `main` che tocca il `Target file` dopo il blocco; mai con `awaiting-verification` |

Nessun'altra transizione è automatica: nessuno scrittore automatico porta un item a `in-progress` e il gate sul conio non tocca gli item `done`. Una persona può riportare un item a `open` o chiuderlo con evidenza.

`FU_ITEM_BLOCKED` porta un motivo dell'insieme chiuso `ITEM_BLOCKED_REASONS`: `awaiting-verification`, `already-fixed-unverified`, `no-root-cause`, `blocked-admin-settings`. Gli ultimi due sono i verdetti non ritentabili del fixer (`ITEM_BLOCKING_OUTCOMES` in `route-already-fixed.mjs`), scritti a grana item: il bucket resta in coda per l'item successivo.

| marker | scrittore | effetto |
|---|---|---|
| `FU_ITEM_ATTEMPT` | `route-already-fixed.mjs`, a ogni esito del fixer sull'item | conta i tentativi: il secondo `already-fixed` senza prova blocca |
| `FU_ITEM_EVIDENCE` | `route-already-fixed.mjs`, con `awaiting-verification` | PR, commit, run e legame (`target-file`, `source-pr`) da verificare; copre il verdetto per il drainer |
| `FU_ITEM_BLOCKED` | `route-already-fixed.mjs` | motivo del blocco; copre il verdetto per il drainer |
| `FU_ITEM_BORN_SATISFIED` | gate sul conio (`acceptance-already-true`); reconciler per i `blocked` coniati prima del marker | quel token non conferma l'item: niente `done`, bucket bloccato (`born-satisfied-token`) |
| `FU_ITEM_UNBLOCKED` | reconciler, al rientro `blocked` → `open` | rientro speso: l'item non rientra più |
| `FU_BUCKET_VERIFY_REQUEST` | reconciler, una volta per insieme di item | bucket `sealed` senza item `open`/`in-progress` ma con item non confermati: chiede la verifica con la METRICA |

**Regola di chiusura.** Un bucket si chiude da solo SOLO quando ogni item è `done` confermato da un token non nato vero, con le due conferme in run separate (`maybe-resolved`, poi chiusura) e senza veti. Un verdetto `already-fixed`, una PR mergiata, un commit o una run verde NON chiudono: annotano l'item (poi `blocked`). Un item in attesa di verifica lo chiude una persona con evidenza, misurando la `METRICA` della scheda quando esiste.

**Finestra di gara.** Triage, reconciler e drainer condividono il mutex `followup-daily-<repo>`. `route-already-fixed.mjs` gira nel job del fixer, fuori dal mutex: rilegge titolo e corpo subito prima di scrivere e rinuncia se sono cambiati (un aggiornamento perso costa una run, non un corpo rotto).

## Routing cross-repository

Prima di creare una issue, risolvi il repository del file da modificare: il repo della PR sorgente non basta dopo il cutover del producer.

- `nanakokyobashi-rgb/frontaliere-articles`: `generator/**`, `generator/tests/**`, `generator/scripts/**`, `content/**`, `data/blog-articles/**`, `data/article-source-urls.json`, `data/batch-faq-progress.json`, workflow corpus e twin `scripts/create-article.mjs` per la generazione live.
- `valerielinc-ops/frontaliere-si-o-no`: tutto il resto, inclusi deploy, sync, validation e mirror che consumano il corpus.

L'issue deve contenere `Target repository:` e `Target file:`; dedup, label e commenti usano lo stesso `--repo`. Per Nanako usa `GITHUB_PAT` e `gh issue create --repo nanakokyobashi-rgb/frontaliere-articles`; se manca, segnala il blocco sulla PR e non usare il repo Valerie come ripiego.

## Constraint

- Read-only su tutto eccetto: `gh issue create`, `gh pr comment`.
- Mai modificare label/state/title della PR.
- Mai chiudere/riaprire issue.
- Zero finding accettabile (PR LGTM puro senza Non implementato). NON inventare.
- Incerto sul filtro scopo → crea issue comunque, rationale "needs triage". Drop è più costoso di una issue extra.
- Nessun limite che tronchi gli item nel bucket. Se il batch supera il budget della
  sessione, usa chunk seriali e continua ad aggiungere allo stesso bucket; il limite
  vale soltanto per il chunk/sessione e non può perdere i residui.
