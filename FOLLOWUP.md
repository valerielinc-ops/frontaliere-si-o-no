# Follow-up Triage Instructions

Contratto per `post-merge-followup.yml`: residui di PR/review finiscono in un solo bucket giornaliero `follow-up` per repository target; quota: `AGENTS.md → Auth automazioni & frugalità quota`.

## Contratto corrente — bucket giornaliero

La forma canonica è:

```text
follow-up(daily:YYYY-MM-DD): N item — owner/repo
```

La chiave è il giorno della run riuscita in `Europe/Zurich`, mai `mergedAt`. Il watermark avanza solo con run riuscita; il retry rilegge la finestra. `## Post-merge follow-up triage` è marker di idempotenza per-PR, anche in bucket esistente.

Una PR daily con `Addresses #<bucket>` e `Follow-up item: FU-...` cerca finding nuovi: quelli coperti si aggiornano in `Sources`, quelli nuovi entrano nel bucket padre (che torna `collecting` se `sealed` e viene risigillato). Padre illeggibile → blocco sulla PR, nessun contenitore alternativo.

Ogni bucket segue `State: collecting` → `State: sealed`. Durante la raccolta non porta `agent:fix`/`agent:fix-queued`; il gate riusa `hasFalsifiableAcceptance()`, completa i chunk, demota gli item non verificabili, sigilla e aggiunge `agent:fix-queued`. Un errore lascia `collecting` senza perdere item o watermark.

Ogni item usa ID stabile `FU-YYYY-MM-DD-NNN` e contiene `State`, `Sources`, `Target repository`, `Target file`, `Original text`, `Suggested action` e `Acceptance token`. Dedup: `target repository + target file + token/azione normalizzata`; il match accorpa in `Sources`. Append concorrenti: rileggi, confronta baseline e ricostruisci su divergenza; sealing/demozione anche in commenti append-only.

Il drainer promuove bucket `sealed` con item `open` e senza PR che dichiari l'ID. `issue-fix` seleziona un item per run. PR parziale: `Addresses #<bucket>` + `Follow-up item: FU-YYYY-MM-DD-NNN`, mai `Closes #<bucket>`. Il reconciler chiude con tutti gli item validi `done` e provati; body illeggibile, stato ambiguo, acceptance assente o prova debole lasciano aperto.

## Gate grandchild-suppression (zero-Claude, PRIMA del triage)

`post-merge-followup.yml` gira su OGNI PR mergiata dall'owner — **incluse le PR che FIXANO un follow-up**. Senza guardia, ogni merge può generare follow-up.

Lo step deterministico `scripts/ci/is-followup-fix-pr.mjs` (zero-Claude) precede Claude e salta i fixer branch che puntano a `follow-up`. Una fix daily con `Addresses #<bucket>` + `Follow-up item: FU-...` cerca finding nuovi e li aggiunge al bucket **padre**, mai a nuova issue. Scope deferred resta nel padre. **Proceed-safe**: branch/body illeggibile o `gh issue view` in errore → triage normale.

## Scopo

Ogni 🟡 nit, ❓ q e voce `## Non implementato` DEVE diventare item `follow-up`, drop motivato o verifica live in `Live-verification` (nessuna issue/fixer; vedi `## Filtro scopo → Hard-exclude: live-verification-only item`). Nessun silent ignore; filtra via `REVIEW.md` → "Scopo progetto".

## Input

- PR merged: `gh pr view $PR_NUMBER --json number,title,body,mergedAt,mergeCommit,url`
- Reviewer bot reviews: `gh api repos/$REPO/pulls/$PR_NUMBER/reviews` (filtra `user.type == "Bot"` + `user.login` starts `claude`)
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

Categoria a sé, **mai mintata come issue `follow-up`** (reason: `live-verify-only`), prima del filtro funnel, **a prescindere dalla fonte** (reviewer 🟡/❓/adversarial OPPURE PR body `## Non implementato` / `## Test plan` checkbox `- [ ]` non spuntata). È `live-verify-only` quando l'**unica azione è verificare il sito già deployato**, senza file da editare: non è fixabile da `agent:fix`.

Riconosci `live-verify-only` dalle frasi-segnale nell'item (l'azione è SOLO ispezione runtime, nessuna edit di file):

- "verify live" / "verifica live" / "post-deploy" / "(post-merge, live)" / "(live)" / "controlla in prod" / "su prod" / "una volta deployato".
- "curl" la URL di produzione / "live-200" / "live curl" / controllo HTTP status sul sito live.
- "render at NNNpx" / "renderizza a 382px" / "apri DevTools" / "ispeziona nel browser" / "Playwright hydration" / verifica visuale o CLS a runtime.
- Checkbox `## Test plan` `- [ ]` esplicitamente etichettata `(post-merge, live)` / `(live)` / "verifica post-deploy" e non spuntata (il reviewer la flagga 🟡 "ricorda spunta post-merge", vedi `REVIEW.md → Test plan compliance`).

**Routing (NON drop silenzioso):** questi item NON diventano issue, ma confluiscono in **un'unica checklist batchata** `Live-verification` nel commento di chiusura (`## Closing comment`), senza fixer. Checklist per PR, mai issue per voce.

**NON classificare `live-verify-only`** un item che **mescola** verifica live e azione reale su un file ("aggiungi `min-height` a `AdSlot.tsx` E poi verifica il CLS live"): la parte editabile resta candidate normale. Solo l'intera azione di ispezione runtime è `live-verify-only`; nel dubbio → actionable.

**Override deterministico (presenza di file-path = actionable):** se `Original text` + `## Suggested action` contiene un percorso editabile `.tsx` / `.ts` / `.mjs` / `.js` / `.yml` / `.yaml` / `.json` / `.md` / `.css` (es. `scripts/foo.mjs`, `components/Bar.tsx`, `build-plugins/baz.ts`), **classifica `actionable`** a prescindere dalle frasi live-verify. `/sitemap.xml` non è path-token (`.xml`/`.html` esclusi).

### Hard-exclude: no-acceptance-condition — ora ANCHE un gate deterministico dopo il conio

La regola è: `Suggested action` deve citare fra backtick almeno un token-codice distintivo. Una `no-valid-item` non si chiude MAI: `aggregateCloseGate()` la blocca per evidenza assente.

Lo step `Gate sul conio` (`scripts/ci/gate-minted-followups.mjs`, zero-Claude) rilegge la issue e usa l'oracolo di chiusura `hasFalsifiableAcceptance()` in `scripts/ci/followup-resolution-match.mjs`. Gli item non validi vengono **demoti** e riscritti in `Live-verification`; senza item la issue viene **soppressa**. Un corpo senza struttura non viene soppresso.

Conseguenza: senza `- Suggested action:` con token-codice l'item non sopravvive. Scrivi simbolo, costante o path che un `grep` futuro troverà.

**Seconda strada: la scheda con un `COMANDO`.** L'oracolo è una **disgiunzione**: passa `Suggested action` + token distintivo **oppure** `- METRICA: prima=<n> atteso=<n> | COMANDO: <comando>` con referente file/script/test (path con `/` e un'estensione). È il campo `COMANDO` già emesso da `issue-decompose.yml` (`## Scheda`) e `scripts/audit-canton-url-drift.mjs`:

- **Il referente non deve esistere ancora.** Un test futuro è valido: l'esistenza si verifica alla chiusura.
- **Una metrica già al bersaglio viene rifiutata.** `prima=N atteso=N` è rifiutato; una soglia (`atteso=<N`) resta ammessa.
- **Il gate non esegue il comando.** Verifica referente e forma, non che oggi fallisca.

Il ramo vive in `hasFalsifiableAcceptance()`, condiviso da apertura e chiusura. Un item ammesso senza token prescritti mantiene `detectAlreadyResolved()` a `false`: la disgiunzione allarga il conio, non la chiusura.

**Il metro si applica alla tua `Suggested action`, non al bullet grezzo — e il token si DERIVA, non si aspetta.** `suggestedActionText()` sul grezzo include `Original text`, ma la chiusura lo esclude: il falso match diventa `no-valid-item`. `citedTokens()` può dare `["manifest.counts"]` sul grezzo e `[]` sull'item. Aggiungi file/simbolo/campo (`nomeFunzione()`, `oggetto.campo`, `COSTANTE >= 1`), non identificatore/path nudo: `isDistinctiveToken()` li rifiuta. Rinuncia solo se non c'è nulla da toccare.

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

`Live-verification` raccoglie **tutti** gli item `live-verify-only` (vedi `## Filtro scopo → Hard-exclude: live-verification-only item`) in una checklist `- [ ]`, una per PR: **nessuna issue e nessun fixer**. Ometti se Q=0; mai promuovere a issue.

Zero item dopo filtro+dedup e zero live-verify → `## Post-merge follow-up triage: zero outstanding items.` senza bucket. Solo live-verify → summary con `Live-verification` e `Created: 0 issue (solo live-verification batchata)`.

## Supersede detection → spostata su `followup-reconcile` (deterministica, zero-Claude)

**2026-06-04:** la supersede detection è in `followup-reconcile.yml` (`scripts/ci/reconcile-followups.mjs`, cron daily, **zero-Claude**): per ogni issue `follow-up` aperta verifica se la fix è **presente verbatim** nel file/token citato.

**2026-06-10 — auto-close a due tier.** `reconcile` chiude in autonomia, ma SOLO con **doppia conferma separata nel tempo** + veti di sicurezza:

1. **1ª detection** (issue non ancora `maybe-resolved`) → commento advisory + label `maybe-resolved`. **Finestra di grazia**: l'umano ha fino al run successivo per obiettare (rimuovere la label, aggiungere `keep-open`/`pinned`, riaprire lo scope).
2. **2ª conferma** (la issue porta GIÀ `maybe-resolved` da un run precedente, è ANCORA risolta, ha il nostro commento-marker, è un bucket con **tutti** gli item validi `done` — oppure una legacy **single-item** —, **non** ha label keep-open/strategica, e l'evidenza è **forte**) → **auto-close** `--reason completed` + label `fu-resolved-auto`.

Per un bucket il veto è item-per-item: body/ID/stato/acceptance/item/token/evidenza invalidi impediscono la chiusura. Chiudi solo con **ogni item valido** `done` e prova `isStrongAutoCloseEvidence()`. Fix parziale: `Addresses #N` + `Follow-up item: FU-...`, mai `Closes #N`. Le label **keep-open/pinned/revenue/tracker/do-not-close** sono veti umani; rimozione dopo il flag = **obiezione umana**. `RECONCILE_NO_AUTOCLOSE=1` torna flag-only. Logica in `tests/reconcile-followups-decision.test.ts`; matcher `issue-fix` in `followup-resolution-match.mjs`, AGENTS.md #6.

Gap: un refactor senza token non viene flaggato; reconcile cerca token verbatim.

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
