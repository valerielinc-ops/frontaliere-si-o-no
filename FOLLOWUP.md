# Follow-up Triage Instructions

Contratto operativo per `post-merge-followup.yml`. Triage automatico post-merge: estrae lavoro residuo da PR body + reviewer comments, lo raccoglie in **una sola issue aggregata** con label `follow-up` per evitare evaporazione dello scope deferred.

## Gate grandchild-suppression (zero-Claude, PRIMA del triage)

`post-merge-followup.yml` gira su OGNI PR mergiata dall'owner — **incluse le PR che FIXANO un follow-up**. Senza guardia il loop è self-perpetuante by-construction:

> follow-up #A → fix PR → merge → reviewer lascia un 🟡 → **nuovo follow-up #B (nipote)** → fix PR → … all'infinito.

Il treadmill brucia **~470 run Claude/sett** (×~3 run l'una: triage → `issue-fix` → `pr-review-loop`) sulla quota Max OAuth **condivisa** con la sessione interattiva owner (vedi `AGENTS.md → Auth automazioni & frugalità quota`).

Lo step deterministico `scripts/ci/is-followup-fix-pr.mjs` (zero-Claude) gira **prima** dello step Claude e lo **salta interamente** (`if: steps.gchild.outputs.is_followup_fix != 'true'`) quando la PR mergiata dichiara di chiudere/superare (`Closes`/`Fixes`/`Resolves`/`Supersedes #N`) almeno una issue con label `follow-up`. Effetto: niente nipote + run Claude risparmiata. Lo scope deferred di un fix-di-follow-up, se reale, appartiene alla issue follow-up **padre** (resta aperta finché non risolta del tutto) — non va mintato un nipote. Parsing close-keyword = `closedIssueRefs()` in `scripts/ci/followup-resolution-match.mjs`, **stessa** regex di `closingMergedPr` (single source, AGENTS.md #6). **Proceed-safe** (direzione opposta al gate already-resolved): body illeggibile / ref non parsati / `gh issue view` in errore → `false` → triage gira (mai perdere un follow-up di PR organica).

## Scopo

Ogni 🟡 nit, ❓ q del reviewer bot e voce `## Non implementato` del PR body DEVE risultare in: (a) un item nella issue aggregata `follow-up` della PR, (b) drop motivato, o (c) — se è pura verifica del sito live senza file da editare — una voce nella checklist `Live-verification` batchata del commento di chiusura (nessuna issue, nessun fixer; vedi `## Filtro scopo → Hard-exclude: live-verification-only item`). Nessun silent ignore. Filtra via scopo progetto (vedi `REVIEW.md` → "Scopo progetto").

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

L'ultima riga è la ragione per cui l'advisory `bullet-without-state` del gate non va promosso a duro finché i generatori non sono a zero: finché i bullet senza stato esistono, sono la classe più numerosa, e filtrarli qui aprirebbe una finestra cieca proprio su di essa.

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

Prima del filtro funnel, **droppa senza eccezioni** gli item che sono manutenzione documentale o pura igiene del codice, indipendentemente da chi li ha sollevati (PR body o reviewer). Questi non sono funnel-critici e auto-routano a `agent:fix` (#922) bruciando quota condivisa. Caso emblematico `#896 → #907 → #1010 → PR #1011` ("de-rot line/PR anchors + document intent"): un follow-up doc che ha generato una PR dichiaratamente "puro churn documentale, nessun cambio di comportamento". Self-feed da fermare a monte.

Droppa (reason: `non-actionable-churn`) se l'item è essenzialmente uno di:

- **Doc/anchor/line-number rot**: "aggiorna line anchors", "i riferimenti `file:NNN` sono sfasati", "i link a PR #N nel commento sono stale", "de-rot comment".
- **"Document the intent / rationale"**: aggiungere commenti che spiegano codice già funzionante, senza cambio di comportamento.
- **Pure style/leggibilità/naming/format** non legati a un bug funnel.
- **Item che il reviewer stesso marca** `deferred` / `non funnel-critical` / `nit puro` (vedi `AGENTS.md → Post-merge feedback handling`, eccezione "drop senza issue").

Crea un follow-up SOLO quando l'item è **funnel-critico** (monetizzazione/traffico/correttezza) **E azionabile** (esiste un cambiamento di comportamento concreto da fare). Nel dubbio tra "non-actionable-churn" e "azionabile-funnel" pesa sul drop: una doc-nit persa costa zero al funnel, una issue churn-feed costa una run fixer sulla quota condivisa. Questa è la leva anti-burn più alta del workflow.

### Hard-exclude: missing-test nit (mai aprire follow-up)

Categoria a sé, **droppata sempre** (reason: `missing-test-nit`), prima del filtro funnel, **a prescindere dalla fonte** (reviewer 🟡/❓/adversarial OPPURE PR body `## Non implementato`) e **anche se l'item è funnel-critico**. L'owner non dà valore alla copertura test come deliverable: i test-nit sono alto-volume / basso-valore, auto-routano a `agent:fix` (#922) e bruciano quota condivisa; storicamente done-but-open (#865/#908/#854 già coperti da PR successive). Idealmente il reviewer non li emette più (`REVIEW.md → IGNORA → test coverage`), ma questa resta la cintura per i residui e per gli item dal PR body.

Droppa se l'item è essenzialmente uno di:

- "Manca un test per X" / "aggiungere test coverage" / "committare i test citati nel PR body" / "pinnare il comportamento con un test" / "test mancante sul ramo/path Y".
- Voce adversarial-check che lamenta assenza di test invece di un rischio di comportamento.

**NON droppare** (resta in scope normale): un BUG in un test ESISTENTE — assertion sbagliata, regex/guard leaky che resta verde sulla regressione, fixture con date assolute (#1035) — è correttezza, non coverage.

### Hard-exclude: live-verification-only item (mai aprire follow-up — batch in checklist)

Categoria a sé, **mai mintata come issue `follow-up`** (reason: `live-verify-only`), prima del filtro funnel, **a prescindere dalla fonte** (reviewer 🟡/❓/adversarial OPPURE PR body `## Non implementato` / `## Test plan` checkbox `- [ ]` non spuntata). Un item è `live-verify-only` quando l'**unica azione suggerita è verificare il sito già deployato** — non esiste alcun file da editare, serve un sito live + occhi umani (o uno strumento E2E manuale). Il fix di codice della PR è già mergiato ed è meccanicamente sano; "controlla che renda bene in prod" non è una issue fixabile da `agent:fix`: il fixer non ha nulla da editare → PR vuota/no-op → `pr-review-loop` spreca giri Claude. Storicamente ~40% dei sub-item follow-up (classe #1149/#959/#1129); dopo il missing-test, la seconda voce di burn più alta del workflow.

Riconosci `live-verify-only` dalle frasi-segnale nell'item (l'azione è SOLO ispezione runtime, nessuna edit di file):

- "verify live" / "verifica live" / "post-deploy" / "(post-merge, live)" / "(live)" / "controlla in prod" / "su prod" / "una volta deployato".
- "curl" la URL di produzione / "live-200" / "live curl" / controllo HTTP status sul sito live.
- "render at NNNpx" / "renderizza a 382px" / "apri DevTools" / "ispeziona nel browser" / "Playwright hydration" / verifica visuale o CLS a runtime.
- Checkbox `## Test plan` `- [ ]` esplicitamente etichettata `(post-merge, live)` / `(live)` / "verifica post-deploy" e non spuntata (il reviewer la flagga 🟡 "ricorda spunta post-merge", vedi `REVIEW.md → Test plan compliance`).

**Routing (NON drop silenzioso):** questi item NON diventano issue, ma confluiscono in **un'unica checklist batchata** nella sezione `Live-verification` del commento di chiusura sulla PR (vedi `## Closing comment`). Restano visibili all'owner per la verifica manuale post-deploy, senza far partire alcun fixer. Una sola checklist per PR, mai una issue per voce.

**NON classificare `live-verify-only`** (resta candidate normale, può diventare issue) un item che **mescola** un suffisso live-verify con un'azione reale su un file ("aggiungi `min-height` a `AdSlot.tsx` E poi verifica il CLS live"): la parte editabile è azionabile → resta in scope normale (la coda live-verify è solo conferma). Solo gli item la cui **intera** azione è ispezione runtime sono `live-verify-only`. Nel dubbio → tienilo actionable (non batcharlo): un'edit persa costa al funnel, una checklist-entry in più costa zero.

**Override deterministico (presenza di file-path = actionable):** prima di classificare `live-verify-only` sulle frasi-segnale, controlla se il testo dell'item (`Original text` + `## Suggested action`) contiene un **token che è un percorso file editabile** — un path-like che termina in `.tsx` / `.ts` / `.mjs` / `.js` / `.yml` / `.yaml` / `.json` / `.md` / `.css` (es. `scripts/foo.mjs`, `components/Bar.tsx`, `build-plugins/baz.ts`). Se sì → **classifica `actionable`** (resta candidate normale) **a prescindere** dalle frasi-segnale live-verify. Razionale: un item puramente live-verify non nomina mai un file da editare; la presenza di un path è il segnale forte che esiste un'edit concreta, e il giudizio prompt-driven sul "mescola" qui sopra rischia di batchare (= perdere) un fix funnel-critico. Override deterministico, non dipende dal giudizio dell'agente. (Eccezione naturale: un'URL di prod come `/sitemap.xml` non è un path-token editabile — `.xml`/`.html` non sono nella lista, restano live-verify.)

## Dedup

Tre livelli, in quest'ordine:
- **PR-level**: `gh issue list --label follow-up --state all --search "follow-up(#$PR_NUMBER)"` — se esiste già una issue aggregata per questa PR → **skip totale** (idempotenza re-run / backfill), log "already triaged #N". Mai una seconda issue aggregata per la stessa PR.
- **Item-level**, per ogni candidate: `gh issue list --label follow-up --state all --search "<keyword from item>"` — match titolo/sezione >70% similar → **escludi l'item** + log "duplicate of #N". Item che referenzia `#NNN` con issue/PR open → escludi l'item.
- **In-flight PR overlap** (anti self-flag): se l'item riguarda file specifici (path nel testo / `## Suggested action`), raccogli i file target ed esegui `gh pr list --state open --json number,title` + `gh pr diff <n> --name-only` sulle PR aperte. Se una PR aperta **già modifica** uno di quei file → **escludi l'item** + log "in-flight in PR #N" (un follow-up su un file che un'altra PR sta riscrivendo nasce obsoleto e fa partire il fixer su lavoro in corso; vedi `ISSUES.md → "Pre-condizioni — overlap-file"`). Nel dubbio (item non file-specifico) → non escludere.

Se dopo il dedup zero item sopravvivono → nessuna issue, summary "zero outstanding items".

## Issue format

**UNA sola issue aggregata per PR** (non N issue separate): tutti i candidate item validi diventano sezioni `### N.` della stessa issue. Motivo: con `follow-up` auto-routed a `agent:fix` (#922), N issue = N run fixer serializzate sulla quota condivisa; 1 issue aggregata = 1 dispatch fixer. È la leva di frugalità più grossa sul volume di issue auto-generate (vedi `ISSUES.md → Frugalità quota` e `AGENTS.md → Auth automazioni & frugalità quota`).

```markdown
Title: follow-up(#<PR>): <N> item deferred — <PR short title>

Body:
## Origine
- PR: #<PR_NUMBER> <PR_TITLE> (merged <mergedAt>)
- URL: <PR url>

## Item

### 1. <one-line item>
- Source: <PR body Non implementato | reviewer 🟡 nit | reviewer ❓ q | adversarial check>
- Stato dichiarato nella PR: <lo stato letterale verbatim, es. `blocked: <causa>` | nessuno>
- Original text:
  > <verbatim>
- Funnel impact: <monetizzazione | traffico | funnel | none>
- Rationale: <perché passa il filtro>
- Suggested action: <concrete next step se ovvio dal contesto; altrimenti "investigate + decide drop or impl">

### 2. <one-line item>
- Source: ...
- Stato dichiarato nella PR: ...
- Original text:
  > ...
- Funnel impact: ...
- Rationale: ...
- Suggested action: ...
```

`Stato dichiarato nella PR` è **obbligatorio su ogni item, anche quando è `nessuno`**. È il campo che permette a un agente di distinguere a macchina un residuo che aspetta una decisione umana da uno che potrebbe chiudere subito; senza, l'unico modo è rileggere la PR d'origine a mano, ed è per questo che la coda non si smaltisce. Un item che riporta `nessuno` NON va filtrato via: va aperto lo stesso e sarà il fixer a qualificarlo.

Anche con UN solo candidate item la issue mantiene la forma aggregata (un'unica sezione `### 1.`) → formato uniforme, parsabile dal fixer.

Labels: `follow-up`, più UNO tra `funnel-monetization` / `funnel-seo` / `funnel-ux` per ogni funnel-area inferita dall'unione degli item (mix di item → più funnel-* label).

## Closing comment

Dopo aver creato la issue aggregata (o droppato tutti gli item), posta UN commento sulla PR riepilogativo:

```markdown
## Post-merge follow-up triage

Created: 1 aggregated issue #<id> con N item:
- <item1 one-line>
- <item2 one-line>

Live-verification (manuale post-deploy, nessuna issue/fixer): Q item
- [ ] "<verbatim>" — <segnale: post-deploy | curl prod | render NNNpx | DevTools/Playwright>

Dropped: M item
- "<verbatim>" — <reason: out-of-scope | dup-of-#X | non-funnel | non-actionable-churn | missing-test-nit>

Skipped: P item (🔴 pre-merge or duplicate active follow-up)
```

La sezione `Live-verification` raccoglie **tutti** gli item `live-verify-only` (vedi `## Filtro scopo → Hard-exclude: live-verification-only item`): checklist `- [ ]` batchata, una sola per PR, **nessuna issue creata e nessun fixer dispatchato** — è solo un promemoria per la verifica manuale dell'owner sul sito deployato. Ometti la sezione se Q=0. Mai promuovere una voce live-verify a issue.

Se zero item sopravvivono al filtro+dedup (e nessuna voce live-verify) → posta `## Post-merge follow-up triage: zero outstanding items.` (nessuna issue creata). Se sopravvivono SOLO voci live-verify (zero issue) → posta il summary con la sola sezione `Live-verification` e la riga `Created: 0 issue (solo live-verification batchata)`.

## Supersede detection → spostata su `followup-reconcile` (deterministica, zero-Claude)

**2026-06-04:** la supersede detection è stata RIMOSSA dal prompt Claude di `post-merge-followup.yml` (il flag su file-touch bruciava turni Claude + `gh issue list --search` per-file a ogni merge, per una segnalazione raramente azionata). Copertura ora di `followup-reconcile.yml` (`scripts/ci/reconcile-followups.mjs`, cron daily, **zero-Claude**): per ogni issue `follow-up` aperta estrae i file/token citati e verifica se la fix è **presente verbatim** nel file.

**2026-06-10 — auto-close a due tier (drena la pila `maybe-resolved` senza perdere qualità).** Il vecchio "la chiusura resta umana" lasciava i `maybe-resolved` a un umano che non arrivava → coda mai convergente (driver #1 del treadmill). Ora `reconcile` chiude in autonomia, ma SOLO con **doppia conferma separata nel tempo** + più veti di sicurezza:

1. **1ª detection** (issue non ancora `maybe-resolved`) → commento advisory + label `maybe-resolved`. **Finestra di grazia**: l'umano ha fino al run successivo per obiettare (rimuovere la label, aggiungere `keep-open`/`pinned`, riaprire lo scope).
2. **2ª conferma** (la issue porta GIÀ `maybe-resolved` da un run precedente, è ANCORA risolta, ha il nostro commento-marker, è **single-item**, **non** ha label keep-open/strategica, e l'evidenza è **forte**) → **auto-close** `--reason completed` + label `fu-resolved-auto`.

Veti all'auto-close (restano flag→umano): **multi-item aggregati** (`N item`, N≥2 — un sub-item prose-only non contribuisce token, "tutti i token presenti" non prova che ogni item sia fatto) — **NB: questo veto vale solo per il path `reconcile` cron; un `Closes #N` nel body di una PR chiude #N al merge via GitHub-native bypassando il veto, perciò il fixer non deve mai mettere `Closes #<aggregata>` su un fix parziale (1 item/run), vedi `ISSUES.md` step 7 + gate `pr-body-contract.yml` (recidiva #3050 → #3036)**; label **keep-open/pinned/revenue/tracker/do-not-close**; **evidenza debole** (singolo token poco specifico tipo `meta.model`, 1 solo segno di punteggiatura — `isStrongAutoCloseEvidence` esige ≥2 token distinti OPPURE 1 token "ricco" con ≥2 segni). Rimozione della label dopo il flag = **obiezione umana** → il bot tace. La chiusura è **reversibile** (si riapre da sola se il segnale ricorre, titoli monitor dedup-stabili). Kill-switch: repo-var `RECONCILE_NO_AUTOCLOSE=1` o input `no_autoclose` → torna flag-only. Logica pura testata in `tests/reconcile-followups-decision.test.ts`; matcher condiviso con il pre-flight di `issue-fix` (`followup-resolution-match.mjs`, AGENTS.md #6).

Gap residuo accettato: un refactor che rende moot un item SENZA aggiungere i token citati non viene flaggato (reconcile cerca i token verbatim). Trade-off scelto per ridurre la spesa Claude per-merge.

## Routing cross-repository

Prima di creare una issue, il follow-up deve risolvere il repository del file che
richiede la modifica comportamentale. Il repository della PR sorgente non è
sufficiente: una PR del sito può contenere un residuo relativo al producer degli
articoli, che dopo il cutover vive nel corpus.

- `nanakokyobashi-rgb/frontaliere-articles`: `generator/**`, `generator/tests/**`,
  `generator/scripts/**`, `content/**`, `data/blog-articles/**`,
  `data/article-source-urls.json`, `data/batch-faq-progress.json` e i workflow del
  corpus che generano o pubblicano articoli. Il twin `scripts/create-article.mjs` va trattato
  come Nanako quando l'item riguarda la generazione live: il producer del sito è
  disattivato.
- `valerielinc-ops/frontaliere-si-o-no`: tutto il resto, compresi deploy, sync,
  validation e mirror che consumano il corpus.

L'issue deve contenere sempre `Target repository:` e `Target file:`. Dedup, label
e commenti devono usare lo stesso repository con `--repo`. Per un target Nanako,
usare il PAT Valerie `GITHUB_PAT` e `gh issue create --repo
nanakokyobashi-rgb/frontaliere-articles`; se il PAT manca, non creare una issue
nel repo Valerie come ripiego: segnalare il blocco sulla PR per il retry successivo.

## Constraint

- Read-only su tutto eccetto: `gh issue create`, `gh pr comment`.
- Mai modificare label/state/title della PR.
- Mai chiudere/riaprire issue.
- Zero finding accettabile (PR LGTM puro senza Non implementato). NON inventare.
- Incerto sul filtro scopo → crea issue comunque, rationale "needs triage". Drop è più costoso di una issue extra.
- Limite hard: max 10 item nella issue aggregata. Oltre → includi i primi 10 e aggiungi in coda al summary "throttled: >10 item, restanti richiedono triage manuale".
