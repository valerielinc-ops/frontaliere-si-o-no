# Follow-up Triage Instructions

## Contratto corrente — bucket giornaliero

La forma canonica è:

```text
follow-up(daily:YYYY-MM-DD): N item — owner/repo
```

`Europe/Zurich`≠`mergedAt`; successo→watermark, retry→finestra.

PR daily `Addresses #<bucket>` + `Follow-up item: FU-...`: `Sources`/padre; `State: collecting`→`State: sealed`; no `agent:fix`/`agent:fix-queued`; `hasFalsifiableAcceptance()` demota/sigilla; errore→blocco, item/watermark.

Divergenza→rebuild. Drainer `sealed`+`open` senza PR-ID→`issue-fix`/run; PR `Addresses #<bucket>`+`Follow-up item: FU-YYYY-MM-DD-NNN`, mai `Closes #<bucket>`; reconciler→`done`.

### Ciclo del padre decomposto e PARENT-REARM

`decomposed:1` tracker: PARENT-DEQUEUE; PARENT-CLOSE dopo figlie dell’ultimo `DECOMPOSED_INTO`. Riaperta/recurrence→PARENT-REARM + `PARENT_REARM`, rimuove `decomposed:1`/`agent:triaged`/stale; `triage-sweep` App/PAT.

Marker idempotente; max 2 riarmi/issue/30g, 2/run; illeggibile→fail-closed; nuovo `DECOMPOSED_INTO`→PARENT-CLOSE.
## Gate grandchild-suppression (zero-agente, PRIMA del triage)

`post-merge-followup.yml`: OGNI PR owner, incluse fix follow-up: anti-nipoti.

`is-followup-fix-pr.mjs`: `follow-up`→skip; daily marker→**padre**; **Proceed-safe** su errori→triage.

## Scopo

Ogni 🟡 nit, ❓ domanda o voce residua `## Non implementato`→follow-up, drop esplicito o `Live-verification`; Nessun silent ignore.

## Input
- PR merged: `gh pr view $PR_NUMBER --json number,title,body,mergedAt,mergeCommit,url`
- Reviewer bot: `gh api repos/$REPO/pulls/$PR_NUMBER/reviews` (Bot + login autorizzati, inclusa `claude[bot]` storico)
- Issue collegate: `gh issue list --label follow-up --state all --search "PR #$PR_NUMBER" --json number,title,body`

## Parse rules
### Da PR body

Da `## Non implementato (ancora)`: ogni bullet `- **X** — Y` → candidate.

**Post-#8 (`AGENTS.md → Non-Negotiable #8`): `## Non implementato` NON è chiuso scope-deferito: piano APERTO.** Svuota in-task; «Nessuno»=zero; scope **tracciato**:

- `Nessuno` / sezione vuota → nessun candidate (task completo).
- Voci `blocked: <causa esterna reale>` → candidate issue (`blocked`), fino a sblocco.
- **Altra voce di scope → candidate issue** (task aperto). Skip `out of scope`/`posposto` **ABOLITO**; fuori solo hard-exclude.

**Routing = STATO LETTERALE**: `scripts/ci/followup-has-candidates.mjs` importa `bulletState()` da `scripts/lib/pr-body-sections-check.mjs`:

| stato dichiarato | candidate? | perché |
|---|---|---|
| `in questa PR` | no | è già nel diff mergiato |
| `PR concatenata #N` | no | ha già il suo tracciamento: la issue sarebbe un doppione |
| `per scelta` / `by construction` | no | è un no motivato, non un rinvio |
| `blocked: decisione del proprietario` | no | deciso da chi decide |
| `blocked: <causa tecnica>` | **sì** | lavoro sospeso su una causa esterna: va riaperto |
| **nessuno stato dichiarato** | **sì** | fail-safe: un residuo non qualificato è lavoro potenzialmente dovuto, e tacerlo è peggio che generare una traccia |

### Da reviewer bot reviews

- `🔴 Important: ...` → SKIP; merged = fixato/droppato; mai retroattivo.
- `🟡 Nit: ...` → candidate.
- `❓ q: ...` → candidate ("Verifica: <q>").
- `🟣 Pre-existing: ...` → candidate se file nel diff (`gh pr diff`).
- `## Adversarial check` bullets → candidate/voce (3 typical).

## Filtro scopo

Scope `REVIEW.md → "Scopo progetto"`; hard-exclude:

### Hard-exclude: churn non-actionable (mai aprire follow-up)

Prima del funnel, **droppa senza eccezioni** (`non-actionable-churn`) doc/igiene non funnel-critici da PR body/reviewer:

- **Doc/anchor/line-number rot**: line anchors/`file:NNN`, link PR #N stale, "de-rot comment".
- **"Document the intent / rationale"**: commenti senza cambio di comportamento.
- **Pure style/leggibilità/naming/format** non legati a un bug funnel.
- **Reviewer marca** `deferred` / `non funnel-critical` / `nit puro` ("drop senza issue").

### Hard-exclude: missing-test nit (mai aprire follow-up)

**Droppa sempre** (`missing-test-nit`) missing-test da reviewer/`## Non implementato`, anche funnel-critico (`REVIEW.md → IGNORA`):

- "Manca un test per X" / "aggiungere test coverage" / "committare il test" / "pinnare comportamento" / "test mancante ramo/path Y".
- Adversarial-check senza test, non rischio di comportamento.

BUG in test ESISTENTE — assertion, regex/guard leaky, fixture date (#1035) — NON droppare: correttezza, non coverage.

### Hard-exclude: live-verification-only item (mai aprire follow-up — batch in checklist)

**Mai mintare issue `follow-up`** (`live-verify-only`) da reviewer/`## Non implementato`/`## Test plan` se unica azione è verificare il deploy senza file editabile: `agent:fix` non può farlo.

Segnali `live-verify-only` (SOLO runtime, nessun edit):

- "verify live" / "verifica live" / "post-deploy" / "(post-merge, live)" / "(live)" / "controlla in prod" / "su prod" / "una volta deployato".
- "curl" URL produzione / "live-200" / "live curl" / HTTP status live.
- "render at NNNpx" / "renderizza a 382px" / DevTools / browser / "ispeziona nel browser" / "Playwright hydration" / CLS runtime.
- Checkbox `## Test plan` `- [ ]` `(post-merge, live)` / `(live)` / "verifica post-deploy" non spuntata (`REVIEW.md`).

**Routing, non drop:** niente issue; checklist `Live-verification`, senza fixer.

**NON `live-verify-only`** se mescola verifica + edit ("aggiungi `min-height` a `AdSlot.tsx` E poi verifica il CLS live"): candidate; solo runtime→live-only; dubbio→actionable.

**Override:** path editabile in `Original text` + `## Suggested action` (`.tsx`/`.ts`/`.mjs`/`.js`/`.yml`/`.yaml`/`.json`/`.md`/`.css`; es. `scripts/foo.mjs`, `components/Bar.tsx`, `build-plugins/baz.ts`)→**`actionable`**; `/sitemap.xml` non-token (`.xml`/`.html` esclusi).

### Hard-exclude: no-acceptance-condition — ora ANCHE un gate deterministico dopo il conio

`Suggested action` + token in backtick; `no-valid-item` non si chiude MAI: `aggregateCloseGate()`.

Gate zero-agente `scripts/ci/gate-minted-followups.mjs` + `hasFalsifiableAcceptance()` (`scripts/ci/followup-resolution-match.mjs`): invalidi→**demoti** `Live-verification`; zero→**soppressa**; corpo senza struttura→non soppresso.

**Seconda strada: `COMANDO`.** `Suggested action` + token **oppure** `- METRICA: prima=<n> atteso=<n> | COMANDO: <comando>` + referente file/script/test (`issue-decompose.yml`/`scripts/audit-canton-url-drift.mjs`):

- **Il referente non deve esistere ancora.** Test futuro valido; esistenza verificata alla chiusura.
- **Metrica già al bersaglio rifiutata.** `prima=N atteso=N` rifiutato; soglia (`atteso=<N`) ammessa.
- **Il gate non esegue il comando.** Verifica referente e forma, non il fallimento odierno.

`hasFalsifiableAcceptance()`; senza token `detectAlreadyResolved()`=`false`. Token da `Suggested action`, non raw (`suggestedActionText()` include `Original text` solo raw; `citedTokens()`, `isDistinctiveToken()`); `grep` dopo fix; main→`already-on-main`. Manifest `routes`/`bin/where-to-fix`: `identical`→sito/`sitePath`; `repo: unknown`→PR (`route-unverified`).

### Ammissione al conio: demozioni e osservazioni

Admission `mintAdmission()`/`scripts/ci/lib/followup-mint-admission.mjs`: `MINT_OBSERVATIONS`→`MINT_GATE_TALLY`; demoti nel commento.

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

Token già vero non conferma: `FU_ITEM_BORN_SATISFIED`→non `done`, bucket `born-satisfied-token`.

## Dedup

Tre livelli:
- **PR-level**: commento `## Post-merge follow-up triage` → salta PR (idempotenza).
- **Bucket-level**: `(daily key, target repository)` riusa `follow-up(daily:<key>)`; item nuovi a `collecting`.
- **Item-level**: fingerprint `target repository + target file + token/azione normalizzata`; match→`Sources`, non duplicare.
- **In-flight PR overlap**: file-specifico; `gh pr list --state open --json number,title` + `gh pr diff <n> --name-only`; target modificato→**escludi** + log "in-flight in PR #N"; dubbio→non escludere.

`scripts/ci/is-followup-fix-pr.mjs`: marker (`Addresses`+`Follow-up item`)→padre; no issue.

## Issue format

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

`Stato dichiarato nella PR` è **obbligatorio**; `nessuno` NON filtra: item al fixer.

Un solo candidate mantiene ID/stato/schema; ID non si rinumerano se demoto.

Labels: `follow-up` + UNO tra `funnel-monetization`/`funnel-seo`/`funnel-ux`; mix→più label.

## Closing comment

OBBLIGATORIO per ogni PR: `## Post-merge follow-up triage` SEMPRE, MARKER DI IDEMPOTENZA, anche a zero candidati.

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

Più bucket → una claim line per bucket, `#<id>`, repo, conteggio:

```markdown
Created/updated: daily bucket #<id-corpus> `follow-up(daily:<YYYY-MM-DD>)` (corpus) con K item:
- <item one-line>
Created/updated: daily bucket #<id-sito> `follow-up(daily:<YYYY-MM-DD>)` (sito) con J item:
- <item one-line>
```

«Verify complete follow-up triage» prova ogni `Created/updated:` e `Created/updated: 2 item.` + ``- Corpus #1957 `follow-up(daily:2026-09-28)` — …``; `#<id>`→`` `follow-up(daily:<YYYY-MM-DD>)` ``; «non persistito» >6h→**quarantena** (`quarantined_prs`).

`Live-verification`: `live-verify-only` in `- [ ]`; **nessuna issue/fixer**; Q=0 omesso.

Zero item/live-verify → `## Post-merge follow-up triage: zero outstanding items.`; solo live→`Created: 0 issue (solo live-verification batchata)`.

Tutti `Dropped`/`Skipped` da QUESTA PR → `Created/updated: 0 item.` con **0**; senza cifra è rosso (35904571443, 35933207218).

## Supersede detection → spostata su `followup-reconcile` (deterministica, zero-agente)

`followup-reconcile.yml`.

**2026-06-10 — auto-close a due tier.** `reconcile`: SOLO **doppia conferma separata nel tempo** + veti:

1. **1ª detection** (issue non ancora `maybe-resolved`) → commento advisory + label `maybe-resolved`. **Finestra di grazia**: l'umano ha fino al run successivo per obiettare (rimuovere la label, aggiungere `keep-open`/`pinned`, riaprire lo scope).
2. **2ª conferma** (la issue porta GIÀ `maybe-resolved` da un run precedente, è ANCORA risolta, ha il nostro commento-marker, è un bucket con **tutti** gli item validi `done` — oppure una legacy **single-item** —, **non** ha label keep-open/strategica, e l'evidenza è **forte**) → **auto-close** `--reason completed` + label `fu-resolved-auto`.

Veto: invalidi bloccano; `done` + `isStrongAutoCloseEvidence()`. Parziale: `Addresses #N` + `Follow-up item: FU-...`, mai `Closes #N`; **keep-open/pinned/revenue/tracker/do-not-close** = veti. `planMaybeResolvedRelease` + `<!-- FU_MAYBE_RESOLVED_RELEASED -->`; fail conserva flag, conferma azzera; `RECONCILE_NO_AUTOCLOSE=1` flag-only. Test `tests/reconcile-followups-decision.test.ts`; matcher `followup-resolution-match.mjs`, AGENTS.md #6.


## Stati dell'item, scrittori e chiusura

Body `- State:`; marker `scripts/ci/lib/followup-item-evidence.mjs` + `FU_BUCKET_VERIFY_REQUEST` da `scripts/ci/reconcile-followups.mjs`; fidati. Stati ammessi dal parser: `open`, `in-progress`, `done`, `blocked`.

| transizione | scrittore | condizione |
|---|---|---|
| conio → `blocked` | triage (`post-merge-followup.yml`) | bullet `blocked:` con causa non di codice, scritta in `Blocked on:` |
| `open`/`in-progress` → `done` | SOLO il reconciler (`scripts/ci/reconcile-followups.mjs`) | token confermato da `detectAlreadyResolved()` e non nato vero |
| `open` → `blocked` | `scripts/ci/route-already-fixed.mjs` (post-step del fixer) | `already-fixed` con terna verificata e legata all'item → `awaiting-verification`; secondo `already-fixed` senza prova → `already-fixed-unverified`; verdetto non ritentabile (`ITEM_BLOCKING_OUTCOMES`: `no-root-cause`, `blocked-admin-settings`) senza PR consegnata → motivo = esito (con PR consegnata o delivery illeggibile, solo il tentativo) |
| `blocked` → `done` | reconciler (`scripts/ci/lib/followup-blocked-recheck.mjs`) | token confermato e non nato vero (marker, o la stessa misura sul file a fine giorno del bucket) |
| `blocked` → `open` | reconciler, UNA volta per item | commit nuovo su `main` che tocca il `Target file` dopo il blocco; mai con `awaiting-verification` |
| `open`/`blocked` → `done` | reconciler (`scripts/ci/lib/followup-ci-suite-proof.mjs`), decisione del proprietario I4 del 2026-10-05 | blocco dichiarato (`Stato dichiarato nella PR`, o `Blocked on`) SOLO dalla guardia risorse locale, nessun altro blocco, item che non chiede la suite intera; suite = `COMANDO: npx vitest run <file di test>`; UNA sola PR fra le `Sources`, mergiata; la run più recente di `tests.yml` sullo sha di merge o sull'ultima head ha il job `vitest (unit + integration)` verde e ha eseguito verde ogni file della suite (report JSON di vitest, o righe per file del log); nessuna run contraddice (suite fallita, o run rossa con vitest eseguito e senza esiti leggibili). Prova mancante o ambigua → l'item resta com'è |

Nessun'altra transizione auto; persona può `open`/chiudere con prova.

`FU_ITEM_BLOCKED`: `ITEM_BLOCKED_REASONS` = `awaiting-verification`, `already-fixed-unverified`, `no-root-cause`, `blocked-admin-settings`; ultimi due=`ITEM_BLOCKING_OUTCOMES`.

| marker | scrittore | effetto |
|---|---|---|
| `FU_ITEM_ATTEMPT` | `route-already-fixed.mjs`, a ogni esito del fixer sull'item | conta i tentativi: il secondo `already-fixed` senza prova blocca |
| `FU_ITEM_EVIDENCE` | `route-already-fixed.mjs`, con `awaiting-verification` | PR, commit, run e legame (`target-file`, `source-pr`) da verificare; copre il verdetto per il drainer |
| `FU_ITEM_BLOCKED` | `route-already-fixed.mjs` | motivo del blocco; copre il verdetto per il drainer |
| `FU_ITEM_BORN_SATISFIED` | gate sul conio (`acceptance-already-true`); reconciler per i `blocked` coniati prima del marker | quel token non conferma l'item: niente `done`, bucket bloccato (`born-satisfied-token`) |
| `FU_ITEM_UNBLOCKED` | reconciler, al rientro `blocked` → `open` | rientro speso: l'item non rientra più |
| `FU_ITEM_CI_SUITE` | reconciler, prima di portare a `done` un item bloccato solo dalla guardia risorse locale (I4) | PR, sha, run e job della CI required che ha eseguito verde la suite: con `State: done` conferma l'item nel gate di chiusura al posto del token |
| `FU_BUCKET_VERIFY_REQUEST` | reconciler, una volta per insieme di item | bucket `sealed` senza item `open`/`in-progress` ma con item non confermati: chiede la verifica con la METRICA |
| `FU_MAYBE_RESOLVED_RELEASED` | reconciler (bucket con item `open`/`in-progress`) e `route-already-fixed.mjs` (restano item `open`), quando tolgono `maybe-resolved` | azzera i flag precedenti: non è un'obiezione umana |

**Regola di chiusura.** Auto-close SOLO `done` con token non nato vero o guardia locale + `FU_ITEM_CI_SUITE`, run separate (`maybe-resolved`, poi chiusura), senza veti. I4 (2026-10-05): suite verde=CI; altro→`blocked`; attesa→`METRICA`/prova.

**Corpo fuori formato.** Illeggibile→«Bucket follow-up illeggibile dal parser»; `rebuildDailyBody`/`node scripts/ci/rebuild-daily-bucket.mjs --issue <N> --repo <owner/repo>` (`--write`); rifiuto.

**Finestra di gara.** Triage/reconciler/drainer condividono `followup-daily-<repo>`; `route-already-fixed.mjs` fuori mutex conferma `maybe-resolved` rimosso.

## Routing cross-repository

Prima della issue, risolvi il repo del file, non la PR.

- `nanakokyobashi-rgb/frontaliere-articles`: `generator/**`, `generator/tests/**`, `generator/scripts/**`, `content/**`, `data/blog-articles/**`, `data/article-source-urls.json`, `data/batch-faq-progress.json`, workflow corpus e twin `scripts/create-article.mjs` per la generazione live.
- `valerielinc-ops/frontaliere-si-o-no`: tutto il resto, inclusi deploy, sync, validation e mirror che consumano il corpus.

Issue: `Target repository:` + `Target file:`; dedup/label/commenti stesso `--repo`. Nanako: `GITHUB_PAT` + `gh issue create --repo nanakokyobashi-rgb/frontaliere-articles`; mancante→blocco, non Valerie.

## Constraint

- Read-only su tutto eccetto: `gh issue create`, `gh pr comment`.
- Mai modificare label/state/title della PR.
- Mai chiudere/riaprire issue.
- Zero finding accettabile (PR LGTM puro senza Non implementato). NON inventare.
- Incerto sul filtro→issue, rationale "needs triage"; drop più costoso.
- Oltre budget→chunk seriali nello stesso bucket; limite per chunk/sessione, nessun residuo perso.
