# Review Instructions

## Esclusione dei test (policy del proprietario)

Escludi da review, ricerche cross-file e finding `tests/`, `__tests__/` e i file JavaScript/TypeScript `*.test.*`/`*.spec.*`; i test restano in CI. Una PR solo-test riceve `## LGTM` deterministico senza modello; in una PR mista reviewa solo i file non-test.

## Scopo progetto = filtro "important"

`frontaliereticino.ch` = SEO ad funnel, non daily app.

Finding important SE impatta:
1. **Monetizzazione** — AdSense Auto Ads (anchor/in-page/vignette), CLS che degrada RPM, ad placeholder mancanti, layout che sopprime ads.
2. **Traffico organico** — SEO (canonical/sitemap/robots/structured data valid), indicizzabilità, content >50 words, page speed LCP/INP, structured data job pages complete.
3. **Funnel reale** — bug logici visibili che bloccano rendering o navigazione CTA.

Se non passa questi filtri → drop.

## Policy automazione bounded F1/F7

Dal 2026-09-24 (policy `f1-f7-v4`, DECISIONS.md «Nessun veto sul ciclo
autonomo») la policy condivisa `scripts/ci/lib/automation-risk-policy.mjs` non
blocca più nessuna issue. `deploy-workflow-functions`,
`secrets-roles-permissions`, `billing-revenue-partner`,
`published-content-seo-auto-ads`, `outreach-communications`, `control-plane`
(`.github/workflows/**`, `.github/actions/**`, `scripts/ci/**`, classifier,
policy, native gate, evaluator, `REVIEW.md`), path ignoti, categorie ignote e
`needs-human` sono **evidenza**, su issue e PR: il fixer li riceve e il
reviewer li deve pesare. Solo metadata issue illeggibili fermano `risk_policy`,
che non è un veto ma un retry. Una PR che tocca quei domini richiede quindi
più attenzione in review, non un'approvazione umana.

Sulle PR il native gate richiede metadata/file-list completi, review `## LGTM`,
check verdi e HEAD esatta; dati incompleti → deny fail-closed senza
`humanApprovalRequired`. Con snapshot verificabile F1/F7, control-plane e path
ignoti non sono veto. `needs-human` è tracking e non blocca auto-merge,
autorebase o dispatch. Il gate riacquisisce i dati e applica
`--match-head-commit`, anche alla mutazione legacy `--auto`.

`enable-native-automerge.yml` e `retry-native-automerge.yml` scaricano da `main`
gli helper trusted, ne verificano la sintassi e applicano `surface='pull-request'`:
workflow, azioni, `scripts/ci/**`, classifier o `REVIEW.md` non richiedono da soli
approvazione umana. La policy non modifica branch protection, ruoli o impostazioni
amministrative; se GitHub non consente la verifica, il gate resta fail-closed.

## Severity

| Marker | Quando |
|---|---|
| 🔴 Important | Rompe funnel/monetizzazione/traffico. Bug che blocca rendering, regressione SEO/AdSense, structured data invalido, scope critico mancante. **Scope-feature dovuto lasciato in `## Non implementato` come deferral senza essere fatto né avere un next-step/piano-di-completamento (post-#8)** |
| 🟡 Nit | Migliora ma non blocca. Semplificazione, leggibilità, refactor anti-duplicazione, **code-smell che crea maintenance debt** (hardcoded values che invecchiano, comment grossly oversized). **Cap 3/review**; oltre → `+N similar nits` in summary |
| 🟣 Pre-existing | Bug già pre-PR. Solo se rilevante al diff |
| ❓ q | Domanda genuina quando incerto (no speculazione) |

### Disposizione 🟡 al review-time (anti-treadmill follow-up)

Ogni 🟡 dichiara la propria disposizione:

- **Nit non-funnel** (stile/leggibilità/naming/maintenance-debt senza impatto monetizzazione/traffico) → suffissa **`— deferred, non funnel-critical`**. `post-merge-followup` lo droppa senza issue (eccezione esistente in `AGENTS.md → Post-merge feedback handling`). NON diventa follow-up.
- **Nit funnel-critical E azionabile** (cambia un comportamento su monetizzazione/traffico/correttezza) → resta candidate follow-up normale. Questi sono gli UNICI 🟡 che devono mintare. Se il fix è banale e isolato, preferisci 🔴-soft "fixa in-PR prima di `## LGTM`".

## IGNORA (anche se veri)

- Security (XSS/injection/secret leak/path traversal) — out of scope
- Style/formatting/naming
- TS strictness salvo maschera bug logico
- **Test coverage — MAI un finding**, neppure in `## Adversarial check`: non chiedere test/coverage. Un BUG in un test ESISTENTE (assertion, regex/guard, fixture con data assoluta) è invece correttezza → 🔴/🟡.
- **Verifica-live-only — MAI un finding actionable.** Se richiede solo ispezione post-deploy senza edit (`curl`, viewport/DevTools, Playwright hydration, checkbox `## Test plan` `(post-merge, live)`), non emettere 🟡, `## Adversarial check` o follow-up. Se include un edit (es. `min-height` + verifica CLS), solleva l'edit; un bug di rendering visibile nel diff resta 🔴/🟡. Vedi `FOLLOWUP.md → Gate grandchild-suppression` e `FOLLOWUP.md → Hard-exclude: live-verification-only item`.
- Script funnel-critico senza workflow CI corrispondente (manual-only, dipende da SA/credenziali su macchina dev) → 🟡 Nit. Eccezioni motivate (one-shot ammortizzato, dev-only) restano nel `## Non implementato` con motivo esplicito.
- Refactor speculativi non legati al diff
- Cavilli architetturali se la soluzione attuale funziona

## Tier review (effort + adversarial depth)

`tests.yml` deriva il tier dai file; regola depth+probing di conseguenza.

**Effort** (`tests.yml` → `reasoning_effort`): `max` per `high`/`high-mega`; `high` per gli altri tier. L'evidenza strutturata è validata contro `CODEX_ALLOWED_EFFORTS`.

**Tier solo sul CODE.** `data/**`, `public/**`, `reports/**`, `_newsletter_variants/**` e `docs/**` non escalano né vanno reviewati riga-per-riga.

| Tier | Trigger files (CODE) | Adversarial depth |
|---|---|---|
| **high** | `tests/**`, `.github/workflows/**`, `build-plugins/**`, e gli script **funnel-critical**: crawler/parser/adapter, `backfill-*`, `migrate-*`, `assemble-*`, sitemap/canonical/slug/redirect/structured-data — tutto `scripts/**` ECCETTO i non-funnel sotto | Bug nel test/CI/build/emitter = falso senso sicurezza che si propaga su ogni merge. Probe regex/assertion/exit-code/idempotency. Lista 3 cose NON verificate prima dell'output (`## Adversarial check`). |
| **high-mega** | Trigger di `high` con ≥25 code file nel diff (PR batch: crawler multipli, migrazioni) | Rigore di `high` (`## Adversarial check` incluso), solo più turni (90 vs 60): la taglia non abbassa lo standard. |
| **normal** | tutto il resto, inclusi gli script NON-funnel: `scripts/{ci,dev,evals}/` (helper CI/dev) e gli audit/report read-only (`audit-*`, `analytics*`, `*-report` — verificano, non mutano l'indice) | Single-pass standard. No adversarial step obbligatorio. |
| **minimal** | PR data/docs-only (ZERO code reviewable) | Percorso corto ≤6 turni di Codex Luna (effort `high`): solo completeness-contract del body, niente REVIEW.md/cross-file/adversarial. Posta `## LGTM`. |
| **incremental** / **incremental-high** | Re-review con delta-code non-funnel (→ `incremental`) o funnel-critical (→ `incremental-high`). Stesso modello `gpt-5.6-luna`, effort `high`: cambia solo il probing. | **Token-lever**: i commit fino a `INCREMENTAL_BASE` erano già reviewati → review SOLO il delta dei file PR (`compare $INCREMENTAL_BASE...$HEAD`), non l'intero contributo. Read/grep dei file pieni consentito per il contesto. `incremental-high` mantiene il probing rigoroso + `## Adversarial check` sul delta; `incremental` è single-pass. Prima review → NON incrementale (high|normal full). Fingerprint identico → `carry-forward`. |
| **carry-forward** | Fingerprint del contributo identico all'ultima review (`scripts/ci/pr-contribution-fingerprint.mjs`): merge di main, anche se tocca file della PR, commit vuoto, sola metadata | Zero modello se l'ultimo verdetto era `## LGTM`: `scripts/ci/lib/review-carry-forward.mjs` pubblica sulla HEAD esatta una review marcata `REVIEW_CARRY_FORWARD` e il review gate la riverifica da capo. Se l'ultimo verdetto non era approvante → tier `minimal` con la sezione `## Code contribution unchanged` nel bundle: si rigiudica solo il body, i 🔴 `open` di codice si riportano identici e non si chiudono con `Fix di`. Stesso tier `minimal` quando il body viene corretto sulla stessa HEAD dopo un verdetto non approvante (`shouldAdmitBodyReReview`). Fingerprint non calcolabile o diverso → review piena. |

### CODE vs DATA nel diff

Carica il diff del solo code (Bootstrap step 3 esclude `data/** public/** reports/** _newsletter_variants/**`):

- Non revieware riga-per-riga `data/jobs/*.json`, snapshot, `translation-cache`, immagini `public/**` o blog generati.
- Valuta il CODE generatore (parser, crawler, build-plugin, writeJson).
- Per un campione usa `Read` sul file mirato; `rg`/`grep` resta fuori da `data/`/`public/`.

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

`scripts/lib/pr-body-sections-check.mjs` valida deterministicamente sezioni,
stati, `Motivo`/`Prossimo passo`, placeholder e `Closes` nello step
`PR-body completeness` di `tests.yml`; il bundle riporta
`## Deterministic body contract`. Se è ✅, il body non genera 🔴 Important: al
massimo 🟡 Nit su `PR body:L<n>`. Stati accettati, incluso `blocked: <causa>`, e
un `Prossimo passo` concreto non si ridiscutono. Il gate marca
`DECLASSIFIED-BODY` un 🔴 ancorato solo a `## Non implementato`; il claim perf
senza baseline dello step 7 resta 🔴. Nuove regole vanno nel contratto. Qui resta
da giudicare la coerenza tra `## Implementato` e diff o l'assenza del verdetto.

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

Tier `high`: prima del summary aggiungi `## Adversarial check` con 3 rischi di
comportamento NON verificati (regex edge case, exit-code, file related,
idempotenza), mai missing-coverage. Usa ❓ q; ogni domanda non-funnel termina
`— deferred, non funnel-critical.`. `(report-only)` o parole sparse non bastano.
Un rischio funnel-critical (SEO/redirect/structured-data/AdSense/sitemap/
indicizzabilità) va come 🔴 Important in `## Findings`. Tier normal: skip.

`STATE_PATTERNS` in `scripts/lib/pr-body-sections-check.mjs` e `bulletState()`
gestiscono gli stati chiudenti: niente `agent:fix`/`needs-human` nei PR body;
`needs-human` resta tracking F1/F7 senza veto. Omettere `width` è un bug.

## Verification

I behavior claim richiedono `file:linea`. Proba input degeneri, race, default
permanenti e refresh autore con `❓ q:`. Un dubbio su
writeJson/persistenza indicizzata, canonical/redirect/previousSlugs, structured
data, sitemap, AdSense o indicizzabilità è funnel-critical: promuovilo a 🔴
Important oppure linka una follow-up; non può convivere con `## LGTM` né sparire
come "Pre-existing / out of scope".

## Identità di un finding

Ogni 🔴 ha id stabile `(path, simbolo, classe)`, calcolato da
`scripts/ci/lib/review-findings.mjs` → `stableFindingId()` senza numero di riga:
spostare `path:Lline` non cambia il rilievo.

- `path`: primo path (`PR body` per il body).
- `simbolo`: primo identificatore in backtick non-path (`parseFoo()`, `NONCODE_RE`),
  altrimenti prosa normalizzata.
- `classe`: subito dopo il marker, es. `🔴 Important: [regression] <problema>`;
  ammesse `regression`, `correctness`, `contract`, `funnel`, `process`, `other`
  (default anche per classi ignote).

Nel `## Findings ledger (id stabile + stato)`: `open` con id/testo invariati,
`needs-verification` da verificare all'HEAD, mai rialzare i `confirmed-fixed`.

### 🔴 nuovi su righe non cambiate

Un 🔴 nuovo ancorato solo a righe immutate dall'ultima review viene declassato
come `DECLASSIFIED-UNCHANGED-LINE`. Resta bloccante solo se è una regressione
esplicita (`🔴 Important: [regression] <problema>`) o non ha anchor `:L`. Finding
già aperti, prima review e delta non calcolabile restano fuori da questa regola.

## Igiene del body della review

Il body malformato viene scartato da `reviewBodyDefects()` con
`body della review malformato`. Evita:

- `\n` letterali: emetti testo, non JSON serializzato;
- `Fix di : ok` / `` Fix di ``: ok `` senza target: usa
  `` Fix di `path:L<linea>`: ok. ``.

## Re-review convergence

Dopo prima review:
- Sopprimi 🟡. Posta solo 🔴.
- Fix di `path:L<linea>` già applicato → conferma esplicitamente «Fix di `path:L<linea>`: ok.»
- Riallineare la base non chiude un 🔴 `open`: riportalo se l'anchor resta;
  se risolto, conferma ogni path citato (anche companion) con
  `Fix di \`path:L<linea corrente>\`: ok.` prima di `Important: 0` + `## LGTM`.
- `needs-verification`: apri l'anchor all'HEAD; fix presente → `Fix di`; 🔴 solo
  con evidenza dal codice attuale.
- 🔴 senza file: se risolto, conferma «Fix di `<testo normalizzato>`: ok.» senza
  backtick interni.
- No rilanciare nit già detti.
- Se c'è `## Risposta del 🔴-fixer`: prima dei 🔴 nuovi e del riporto per anchor giudica ogni voce, anche a codice invariato. `fixed`: regge l'Accettazione, o la proposta del fixer? `disputed`: regge l'evidenza? Sì → `Fix di \`path:L<n>\`: ok` (+ `(ritirato: <motivo>)`); no → 🔴 e `Replica: <cosa manca>`, mai identico.

## Output format

Una riga/finding:
```
<file>:L<linea>: <prefix> <problema>. <fix>. Accettazione: <test|comando|input→output>.
```

Prefix: `🔴 Important` / `🟡 Nit` / `🟣 Pre-existing` / `❓ q:`.

**Marker `🔴 Important` = stringa esatta, MAI bold.** Scrivi `🔴 Important`, non `🔴 **Important**` né `🔴 __Important__`. È letto dai gate (`pr-redflag-fixer.yml`, `auto-merge-eval.mjs`); tienilo piano.

**Drop:** "I noticed", "It seems", "perhaps/maybe", "You might want to", restating, "Great work but". No hedging.

**Keep:** linea esatta, simboli in backtick, un solo fix concreto, *perché* solo se non ovvio.

## Summary body

```markdown
## Scope
<una frase: scopo PR> (tier: high|normal)

## Findings (Important: N, Nit: M)
<lista>

## Adversarial check
<solo tier high: 3 cose NON verificate, ognuna con `— deferred, non funnel-critical.` se non-funnel>
```

Zero 🔴 Important: `## LGTM` + rec; la stringa triggera `auto-merge-on-lgtm.yml`. Con 🔴 o ❓ funnel-critical, promuovi il finding o dichiara la follow-up.
