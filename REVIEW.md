# Review Instructions

## Esclusione dei test (policy del proprietario)

I file sotto `tests/` o `__tests__/`, anche annidati, e i file `*.test.*`/`*.spec.*` JavaScript/TypeScript sono esclusi da review, ricerche cross-file e finding. I test restano eseguiti in CI. Una PR solo-test riceve `## LGTM` deterministico dopo i controlli, senza chiamare un modello; una PR mista è reviewata soltanto per i file non-test.

## Scopo progetto = filtro "important"

`frontaliereticino.ch` = SEO ad funnel. NOT daily app.

Finding important SE impatta:
1. **Monetizzazione** — AdSense Auto Ads (anchor/in-page/vignette), CLS che degrada RPM, ad placeholder mancanti, layout che sopprime ads.
2. **Traffico organico** — SEO (canonical/sitemap/robots/structured data valid), indicizzabilità, content >50 words, page speed LCP/INP, structured data job pages complete.
3. **Funnel reale** — bug logici visibili che bloccano rendering o navigazione CTA.

Non passa nessuno → drop.

## Policy automazione bounded F1/F7

La policy deterministica in `scripts/ci/lib/automation-risk-policy.mjs` è
condivisa da classifier, issue-fix e auto-merge. Sulla superficie issue blocca:
`deploy-workflow-functions`, `secrets-roles-permissions`,
`billing-revenue-partner`, `published-content-seo-auto-ads` e
`outreach-communications`. Sulla superficie PR li conserva come evidenza, non
come veto umano.

Il dominio tecnico `control-plane` resta deny-by-default per la classificazione
delle issue: `.github/workflows/**`, `.github/actions/**`, `scripts/ci/**`,
classifier, policy, native gate, evaluator e `REVIEW.md` non entrano nel ciclo
issue-fix/triage automatico. Nel percorso PR→auto-merge non sono un veto umano:
il native gate valuta metadata, file-list completa, review `## LGTM`, check verdi
e HEAD esatta. Un path non riconosciuto o un issue text senza categoria/signal
noto ricevono `decision='deny'`; sulla PR un path sconosciuto è ammesso solo con
metadata e file-list tecnicamente verificabili.

Le sole eccezioni esplicite al deny per un'issue `other` sono le label metriche
read-only `job-description-locale` e `job-title-locale`; non trasformano testo
generico in un segnale noto e non prevalgono su dominio, path sconosciuto o
control-plane. Per un'issue ad alto rischio il classifier restituisce `route='none'`
e `autofix=false`; `issue-triage` rimuove le label di routing e applica
`needs-human`, mentre `risk_policy` dell'issue-fix si chiude prima di token App,
quota, claim e agent. Un errore di lettura/parsing lascia il fixer skipped. Non
esiste override nel prompt.

Per una PR il native gate valuta titolo/body/label e file-list completa:
metadata o elenco incompleti sono un deny tecnico fail-closed senza
`humanApprovalRequired`; F1/F7, control-plane e path sconosciuti non aggiungono
un veto con snapshot verificabile. `needs-human` è solo tracking/escalation:
non richiede review umana APPROVED o rimozione e non blocca merge automatico,
autorebase o dispatch. Il gate finale riacquisisce metadata/file-list e usa
`--match-head-commit` sulla HEAD verificata; la stessa guardia copre l'evaluator
legacy che conserva una mutazione `--auto` di compatibilità.

I bootstrap `enable-native-automerge.yml` e `retry-native-automerge.yml` non
usano più una guardia statica sui path del control-plane né un sentinel: scaricano
e verificano la sintassi degli helper trusted da `main`; il gate PR applica la
policy `surface='pull-request'` con i requisiti esistenti. Nessuna approvazione
umana è richiesta solo perché la PR modifica workflow, azioni, `scripts/ci/**`,
classifier o `REVIEW.md`.

Branch protection, ruoli e impostazioni amministrative non sono modificati né
verificabili da questa policy; se GitHub non consente la verifica, il gate resta
fail-closed.

## Severity

| Marker | Quando |
|---|---|
| 🔴 Important | Rompe funnel/monetizzazione/traffico. Bug che blocca rendering, regressione SEO/AdSense, structured data invalido, scope critico mancante. **Scope-feature dovuto lasciato in `## Non implementato` come deferral senza essere fatto né avere un next-step/piano-di-completamento (post-#8)** |
| 🟡 Nit | Migliora ma non blocca. Semplificazione, leggibilità, refactor anti-duplicazione, **code-smell che crea maintenance debt** (hardcoded values che invecchiano, comment grossly oversized). **Cap 3/review**; oltre → `+N similar nits` in summary |
| 🟣 Pre-existing | Bug già pre-PR. Solo se rilevante al diff |
| ❓ q | Domanda genuina quando incerto (no speculazione) |

### Disposizione 🟡 al review-time (anti-treadmill follow-up)

Ogni 🟡 nit che sollevi **deve dichiarare la propria disposizione**:

- **Nit non-funnel** (stile/leggibilità/naming/maintenance-debt senza impatto monetizzazione/traffico) → suffissa **`— deferred, non funnel-critical`**. `post-merge-followup` lo droppa senza issue (eccezione esistente in `AGENTS.md → Post-merge feedback handling`). NON diventa follow-up.
- **Nit funnel-critical E azionabile** (cambia un comportamento su monetizzazione/traffico/correttezza) → resta candidate follow-up normale. Questi sono gli UNICI 🟡 che devono mintare. Se il fix è banale e isolato, preferisci 🔴-soft "fixa in-PR prima di `## LGTM`".

## IGNORA (anche se veri)

- Security (XSS/injection/secret leak/path traversal) — out of scope
- Style/formatting/naming
- TS strictness salvo maschera bug logico
- **Test coverage — MAI un finding** (né 🟡 nit né voce `## Adversarial check`), nemmeno su path funnel-critici. "Manca un test per X", "aggiungi coverage", "committa il test citato nel PR body", "pinna questo comportamento con un test" → NON sollevare. **Eccezione:** un BUG in un test ESISTENTE — assertion sbagliata, regex/guard leaky, fixture con date assolute — è correttezza → 🔴/🟡 normale.
- **Verifica-live-only — MAI un finding actionable.** Se l'**unica azione è ispezionare il sito già deployato** senza file da editare ("verifica live / post-deploy", "curl la URL prod / live-200", "renderizza a NNNpx", "apri DevTools", "Playwright hydration", checkbox `## Test plan` `(post-merge, live)`), NON emetterlo come 🟡, `## Adversarial check` o "crea issue follow-up". Se mescola verifica-live con un'edit ("aggiungi `min-height` E poi verifica il CLS live"), solleva la parte editabile. Un BUG di rendering diagnosticabile dal diff/codice resta 🔴/🟡. Vedi `FOLLOWUP.md → Gate grandchild-suppression` e `FOLLOWUP.md → Hard-exclude: live-verification-only item`.
- Script funnel-critico senza workflow CI corrispondente (manual-only, dipende da SA/credenziali su macchina dev) → 🟡 Nit. Eccezioni motivate (one-shot ammortizzato, dev-only) restano nel `## Non implementato` con motivo esplicito.
- Refactor speculativi non legati al diff
- Cavilli architetturali se la soluzione attuale funziona

## Tier review (effort + adversarial depth)

Determina tier dai file toccati. `pr-review-loop.yml` lo passa nel prompt; il reviewer regola depth+probing in base al tier.

**Effort del modello per tier** (`tests.yml` → input `reasoning_effort` dell'action): `max` per `high` e `high-mega`, `high` per `minimal`, `incremental`, `incremental-high` e `normal`. Il valore è registrato nell'evidenza strutturata e validato dal review gate contro l'insieme chiuso `CODEX_ALLOWED_EFFORTS`.

**Il tier si decide SOLO sul CODE.** I file dati/static rigenerati — `data/**` (job JSON, snapshot, translation-cache, blog-articles), `public/**` (immagini/asset), `reports/**`, `_newsletter_variants/**`, `docs/**` — NON sono code: non escalano il tier e non vanno revieweati riga-per-riga (vedi "CODE vs DATA nel diff").

| Tier | Trigger files (CODE) | Adversarial depth |
|---|---|---|
| **high** | `tests/**`, `.github/workflows/**`, `build-plugins/**`, e gli script **funnel-critical**: crawler/parser/adapter, `backfill-*`, `migrate-*`, `assemble-*`, sitemap/canonical/slug/redirect/structured-data — tutto `scripts/**` ECCETTO i non-funnel sotto | Bug nel test/CI/build/emitter = falso senso sicurezza che si propaga su ogni merge. Probe regex/assertion/exit-code/idempotency. Lista 3 cose NON verificate prima dell'output (`## Adversarial check`). |
| **high-mega** | Stesso trigger di `high`, ma con ≥25 code file nel diff (PR batch di grande taglia: crawler multipli, migrazioni cross-file) | Stesso rigore/probing di `high` (`## Adversarial check` incluso) — solo più budget di turni (90 vs 60), non più severity: la taglia della PR non abbassa lo standard. |
| **normal** | tutto il resto, inclusi gli script NON-funnel: `scripts/{ci,dev,evals}/` (helper CI/dev) e gli audit/report read-only (`audit-*`, `analytics*`, `*-report` — verificano, non mutano l'indice) | Single-pass standard. No adversarial step obbligatorio. |
| **minimal** | PR data/docs-only (ZERO code reviewable) | Percorso corto ≤6 turni di Codex Luna (effort `high`): solo completeness-contract del body, niente REVIEW.md/cross-file/adversarial. Posta `## LGTM`. |
| **incremental** / **incremental-high** | Re-review con delta-code non-funnel (→ `incremental`) o funnel-critical (→ `incremental-high`). Codex Luna (`gpt-5.6-luna`, effort `high`) su entrambi: cambia solo il probing, non il modello. | **Token-lever**: i commit fino a `INCREMENTAL_BASE` erano già reviewati → review SOLO il delta dei file PR (`compare $INCREMENTAL_BASE...$HEAD`), non l'intero contributo. Read/grep dei file pieni consentito per il contesto. `incremental-high` mantiene il probing rigoroso + `## Adversarial check` sul delta; `incremental` è single-pass. Prima review → NON incrementale (high|normal full). Delta-code vuoto → vedi `carry-forward`. |
| **carry-forward** | Nessun file code della PR cambiato dall'ultima review (merge di main, commit vuoto, sola metadata) **e** fingerprint del contributo identico (`scripts/ci/pr-contribution-fingerprint.mjs`) | Zero modello se l'ultimo verdetto era `## LGTM`: `scripts/ci/lib/review-carry-forward.mjs` pubblica sulla HEAD esatta una review marcata `REVIEW_CARRY_FORWARD` e il review gate la riverifica da capo. Se l'ultimo verdetto non era approvante → tier `minimal` con la sezione `## Code contribution unchanged` nel bundle: si rigiudica solo il body, i 🔴 di codice si riportano identici e non si chiudono con `Fix di`. Stesso tier `minimal` quando il body viene corretto sulla stessa HEAD dopo un verdetto non approvante (`shouldAdmitBodyReReview`). Fingerprint non calcolabile o diverso → review piena. |

### CODE vs DATA nel diff

Carica il diff del solo code (Bootstrap step 3 esclude `data/** public/** reports/** _newsletter_variants/**`). I dati/static rigenerati NON sono code reviewabile:

- **Non** revieware riga-per-riga `data/jobs/*.json`, snapshot, `translation-cache`, immagini `public/**`, blog-articles generati: non sono finding.
- Valuta solo il **CODE che li genera/emette** (parser, crawler, build-plugin, writeJson).
- Serve un campione? Apri il file mirato con `Read`, non l'intero blob; `rg`/`grep` cross-file (step 5) resta sul code, mai in `data/`/`public/`.

Eccezione: un file `data/**` checked-in che è **config/fixture** (non output rigenerato) e che il diff modifica a mano → reviewalo come code.

## Completeness contract

PR body DEVE avere:

```markdown
## Implementato
- Lista cosa la PR fa.

## Non implementato (ancora)
- <scope ancora dovuto> — <stato letterale>
```

«Nessuno» al posto dei bullet = task completo (AGENTS.md #8).

| stato | significato | il task resta aperto? |
|---|---|---|
| `in questa PR` | è già nel diff che si sta mergiando | no |
| `PR concatenata #N` | tracciato altrove, col NUMERO | no (lo tiene la catena) |
| `per scelta` / `by construction` | un no motivato, non un rinvio | no |
| `blocked: decisione del proprietario` | un no di chi decide | no |
| `blocked: <causa tecnica>` | lavoro sospeso su una causa esterna | **sì** |

`per scelta` e `by construction` non sono una scappatoia con un nome nuovo: valgono **solo** se il bullet porta anche il motivo. Un bullet che dice `per scelta` e basta è un `out of scope` travestito → 🔴.

### Una sola fonte di verità sul body

Il contratto del body è validato in modo deterministico da `scripts/lib/pr-body-sections-check.mjs` (step `PR-body completeness` di `tests.yml`): sezioni, stato di ogni voce, `Motivo`/`Prossimo passo`, placeholder, `Closes`. Il suo verdetto arriva nel bundle (`## Deterministic body contract`). **Se è ✅, il body non genera 🔴 Important**: al massimo un 🟡 Nit ancorato `PR body:L<n>`. Ogni stato accettato dal contratto — incluso qualunque `blocked: <causa>` — è valido; `Prossimo passo` concreto non si ridiscute. Il review gate declassa comunque un 🔴 ancorato solo su una riga `PR body:L<n>` dentro `## Non implementato` quando il contratto è verde (`DECLASSIFIED-BODY` nel log); il claim perf senza baseline (step 7) non è una regola del contratto e resta 🔴. Una regola del body che il contratto non copre va aggiunta al contratto, non applicata a mano dal reviewer. Le regole qui sotto valgono per i punti che il contratto non vede (coerenza fra `## Implementato` e diff) e quando il verdetto non è disponibile.

### Reviewer behavior

1. **Implementato item** → critical thinking: diff lo implementa? edge case? logica boundary/null/async/ordering? modo più semplice? buco visibile? Code-smell con maintenance debt anche se non blocca il funnel → 🟡 Nit.
2. **Non implementato item** → **post-#8 `## Non implementato` = piano di completamento del task aperto, NON scope-deferito-e-chiuso** (vedi `AGENTS.md → Non-Negotiable #8`). Ogni voce è lavoro ancora dovuto e deve dichiarare stato/next-step concreto: `in questa PR` / `PR concatenata #N` / `blocked: <causa esterna reale>` oppure `per scelta` / `by construction` / `blocked: decisione del proprietario` con motivo. `out of scope`/`posposto` non sono stati validi.
   - **Un bullet che dichiara uno stato CHIUDENTE con il motivo scritto dopo lo stato NON è un finding.** Non emettere 🔴/🟡: `scripts/ci/followup-has-candidates.mjs` (`CLOSING_STATES`) e i fixer autonomi lo escludono. Motivo debole → `❓ q:`, non 🔴.
   - `per scelta` senza motivo o in contrasto col motivo è `out of scope` travestito. Scope-feature in deferral senza piano/implementazione → **🔴 Important**: il task non è chiuso finché `## Non implementato` non legge «Nessuno»; completa con `PR concatenata` o `blocked:<causa>`. PR può mergiare con sezione non vuota se ogni voce ha next-step, ma non scrivere `## LGTM` per il TASK. `blocked:` esterno lascia il task aperto; `Nessuno` lo completa.
3. **Diff fa cose non dichiarate** → 🟡 scope drift: "diff fa X non in scope. PR separata o aggiungi a Implementato."
   - **Inverso — body dichiara X ma diff non lo mostra** → 🟡 Nit: "`## Implementato` afferma X ma il diff non lo riflette — aggiornare il body." (`pr-body-contract.yml` valida gli header, non la precisione del contenuto.)
4. **Sezioni mancanti** → 🔴 process: "manca Implementato/Non implementato nel PR body. Aggiungere prima review sostanziale."
   - **Tier normal**: termina qui, no altri finding (path basso rischio, review sostanziale rimandata al re-push conforme).
   - **Tier high (vedi tabella "Tier review"): NON terminare.** Posta il 🔴 process e prosegui nello stesso pass con review sostanziale + `## Adversarial check` completi. Il 🔴 blocca solo l'auto-merge; non deferire mai il probing.
   - **`Closes #a #b` multi-issue su una riga** → 🔴 process: GitHub chiude SOLO la prima issue dopo una keyword (`Closes`/`Fixes`/`Resolves`); `Closes #a #b #c` chiude solo `#a`. Chiedi una keyword per issue, una per riga (`Closes #a` / `Closes #b`). Il gate `pr-body-contract.yml` lo flagga a ogni edit; non ripeterlo se il bot ha già commentato lo stesso 🔴.
5. **Cross-file pattern repetition** → se il diff fissa un pattern in 1 file, usa `rg`/`grep` sul pattern equivalente nel resto repo, solo CODE: `rg <pattern> scripts build-plugins components services functions server hooks tests` (o `rg <pattern> -g '!data/**' -g '!public/**' -g '!reports/**'`). Stesso anti-pattern non toccato → 🔴 in file funnel-critico (crawler/build-plugin/test gate), 🟡 altrove.
6. **Test plan compliance** → nel PR body `## Test plan`/`- [ ]`, distingui verifiche pre-merge da live. Verifica live senza edit è verifica-live-only: **NON sollevare 🟡 né chiedere issue follow-up**; batchala in `post-merge-followup` (eventualmente marca `(post-merge, live)` in `## Non implementato`). Se è verificabile pre-merge, non spuntata e non confermabile dal diff → 🟡 chiedi conferma o issue follow-up.
7. **Claim perf/optimization non validato** → PR perf/build/CI con speedup dichiarato **senza baseline pre-merge** su path high → 🔴 Important: "claim perf non validato pre-merge; mergi su speculazione. Allega misura pre/post oppure dichiara revert-risk esplicito nel `## Non implementato`." Eccezione: ottimizzazione byte-identica provata dal diff o run linkato pre/post.

### Pre-output adversarial check (tier high)

PR a tier `high` (vedi tabella "Tier review"): prima del summary, includi `## Adversarial check` con 3 cose NON verificate (regex edge case non testato, exit-code path non esplorato, file related non aperto, idempotency assumption). Surface come ❓ q dove pertinente. Ogni `❓ q:` non-funnel deve terminare con `— deferred, non funnel-critical.`; `(report-only)`, `non-funnel-critical` o `deferred` nel testo non basta. Un rischio funnel-critical va promosso a 🔴 Important. Tier normal: skip questa sezione.

**Le "cose non verificate" sono rischi di COMPORTAMENTO/correttezza, mai "manca un test".** Mai missing-coverage; surface il rischio sottostante come ❓ q (o 🔴 se funnel-critical): "non so se `parseFoo()` gestisce il null → potrebbe emettere structured-data invalido" è valido.

**Un ❓ dell'adversarial check il cui soggetto è funnel-critical NON resta sepolto qui.** Se impatta monetizzazione/traffico (SEO/redirect/structured-data/AdSense/sitemap/indicizzabilità) → 🔴 Important in `## Findings` (vedi Verification → escalation); non parcheggiarlo qui.

Tassonomia macchina: `STATE_PATTERNS` in `scripts/lib/pr-body-sections-check.mjs`; `bulletState()` gestisce gli stati chiudenti, quindi niente `agent:fix`/`needs-human` nei PR body. `needs-human` resta invece uno stato operativo F1/F7 delle issue e, sulle PR, un marker di tracking senza potere di veto; non è un claim di completezza. Omissione di `width` resta bug di rendering.

## Verification

Behavior claims richiedono `file:linea`. No speculazione. Incerto → `❓ q:`.

**Edge case probing via `❓ q:`** anche quando sei sicuro dell'implementazione: input degenere, race condition, default che diventa permanente, refresh manuale dell'autore. Surface come domanda, non assumere che l'autore l'abbia considerato.

**Escalation ❓ funnel-critical → 🔴.** Un `❓ q` resta `❓` solo se l'impatto è non-funnel o cosmetico. Se il dubbio impatta monetizzazione/traffico (gate writeJson/persistenza su dataset indicizzato, canonical/redirect/previousSlugs, structured data, sitemap, AdSense placement, indicizzabilità) → NON lasciarlo accanto a un `## LGTM`: promuovilo a 🔴 Important (blocca auto-merge) **oppure** apri una follow-up issue e linkala nel finding. "Pre-existing / out of scope" non cancella un bug funnel-critical.

## Re-review convergence

Dopo prima review:
- Sopprimi 🟡. Posta solo 🔴.
- Fix di `path:L<linea>` già applicato → conferma esplicitamente «Fix di `path:L<linea>`: ok.»
- Un riallineamento della base non chiude un 🔴 Important precedente per silenzio: se l'anchor `path:Llinea` è ancora presente, riportalo; se corretto, conferma la riga di fix prima di scendere a `Important: 0` + `## LGTM`.
- 🔴 Important senza citazione di file → non chiuderlo per silenzio: se il rilievo è risolto, conferma «Fix di `<testo normalizzato>`: ok.» usando il testo del finding senza backtick interni.
- No rilanciare nit già detti.

## Output format

Una riga/finding:
```
<file>:L<linea>: <prefix> <problema>. <fix>.
```

Prefix: `🔴 Important` / `🟡 Nit` / `🟣 Pre-existing` / `❓ q:`.

**Marker `🔴 Important` = stringa esatta, MAI bold.** Scrivi `🔴 Important`, non `🔴 **Important**` né `🔴 __Important__`. È letto dai gate (`pr-redflag-fixer.yml`, `auto-merge-eval.mjs`); tienilo piano.

**Drop:** "I noticed", "It seems", "perhaps/maybe", "You might want to", restating, "Great work but". No hedging.

**Keep:** linea esatta, simboli in backtick, fix concreto, *perché* solo se non ovvio.

## Summary body

```markdown
## Scope
<una frase: scopo PR> (tier: high|normal)

## Findings (Important: N, Nit: M)
<lista>

## Adversarial check
<solo tier high: 3 cose NON verificate, ognuna con `— deferred, non funnel-critical.` se non-funnel>
```

Zero 🔴 Important: `## LGTM` + rec. La stringa esatta `## LGTM` triggera auto-merge in `auto-merge-on-lgtm.yml`. Non scrivere `## LGTM` con 🔴 in findings/adversarial check o ❓ funnel-critical non escalato: promuovilo a 🔴 oppure apri e dichiara la follow-up issue
