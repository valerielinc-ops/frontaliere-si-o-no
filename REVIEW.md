# Review Instructions

## Esclusione dei test (policy del proprietario, 2026-09-10)

I file sotto `tests/` o `__tests__/`, anche annidati, e i file `*.test.*`/`*.spec.*` JavaScript/TypeScript sono esclusi dalla review, dalle ricerche cross-file e dai finding. Questa regola sostituisce le precedenti eccezioni sui bug nei test esistenti. I test continuano a essere eseguiti in CI. Una PR composta esclusivamente da questi file riceve `## LGTM` deterministico dopo i controlli, senza chiamare un modello. Una PR mista viene reviewata soltanto per i file non-test.

## Scopo progetto = filtro "important"

`frontaliereticino.ch` = SEO funnel ad revenue (~95% AdSense Auto Ads). NOT daily app.

Finding important SE impatta:
1. **Monetizzazione** — AdSense Auto Ads (anchor/in-page/vignette), CLS che degrada RPM, ad placeholder mancanti, layout che sopprime ads.
2. **Traffico organico** — SEO (canonical/sitemap/robots/structured data valid), indicizzabilità, content >50 words, page speed LCP/INP, structured data job pages complete.
3. **Funnel reale** — bug logici visibili che bloccano rendering o navigazione CTA.

Non passa nessuno → drop. Non importante per questo progetto.

## Severity

| Marker | Quando |
|---|---|
| 🔴 Important | Rompe funnel/monetizzazione/traffico. Bug che blocca rendering, regressione SEO/AdSense, structured data invalido, scope critico mancante. **Scope-feature dovuto lasciato in `## Non implementato` come deferral senza essere fatto né avere un next-step/piano-di-completamento (post-#8)** |
| 🟡 Nit | Migliora ma non blocca. Semplificazione, leggibilità, refactor anti-duplicazione, **code-smell che crea maintenance debt** (hardcoded values che invecchiano, comment grossly oversized). **Cap 3/review**; oltre → `+N similar nits` in summary |
| 🟣 Pre-existing | Bug già pre-PR. Solo se rilevante al diff |
| ❓ q | Domanda genuina quando incerto (no speculazione) |

### Disposizione 🟡 al review-time (anti-treadmill follow-up)

Ogni 🟡 nit che sollevi **deve dichiarare la propria disposizione**, così `post-merge-followup` non deve indovinarla né mintare un follow-up non necessario:

- **Nit non-funnel** (stile/leggibilità/naming/maintenance-debt senza impatto monetizzazione/traffico) → suffissa **`— deferred, non funnel-critical`**. `post-merge-followup` lo droppa senza issue (eccezione esistente in `AGENTS.md → Post-merge feedback handling`). NON diventa follow-up.
- **Nit funnel-critical E azionabile** (cambia un comportamento su monetizzazione/traffico/correttezza) → resta candidate follow-up normale. Questi sono gli UNICI 🟡 che devono mintare. Se il fix è banale e isolato, preferisci 🔴-soft "fixa in-PR prima di `## LGTM`".

## IGNORA (anche se veri)

- Security (XSS/injection/secret leak/path traversal) — out of scope
- Style/formatting/naming
- TS strictness salvo maschera bug logico
- **Test coverage — MAI un finding** (né 🟡 nit né voce `## Adversarial check`), nemmeno su path funnel-critici. "Manca un test per X", "aggiungi coverage", "committa il test citato nel PR body", "pinna questo comportamento con un test" → NON sollevare. **Eccezione:** un BUG in un test ESISTENTE — assertion sbagliata, regex/guard leaky, fixture con date assolute — è correttezza → 🔴/🟡 normale.
- **Verifica-live-only — MAI un finding actionable.** Se l'**unica azione è ispezionare il sito già deployato** senza file da editare ("verifica live / post-deploy", "curl la URL prod / live-200", "renderizza a NNNpx", "apri DevTools", "Playwright hydration", checkbox `## Test plan` etichettata `(post-merge, live)`), NON emetterlo come 🟡, `## Adversarial check` o "crea issue follow-up". Se mescola verifica-live con un'edit ("aggiungi `min-height` E poi verifica il CLS live"), solleva la parte editabile. Un BUG di rendering diagnosticabile dal diff/codice resta 🔴/🟡. Vedi `FOLLOWUP.md → Gate grandchild-suppression` e `FOLLOWUP.md → Hard-exclude: live-verification-only item`
- Script funnel-critico senza workflow CI corrispondente (manual-only, dipende da SA/credenziali su macchina dev) → 🟡 Nit. Eccezioni motivate (one-shot ammortizzato, dev-only) restano nel `## Non implementato` con motivo esplicito.
- Refactor speculativi non legati al diff
- Cavilli architetturali se la soluzione attuale funziona

## Tier review (effort + adversarial depth)

Determina tier dai file toccati. Il workflow (`pr-review-loop.yml`) lo calcola e lo passa nel prompt; il reviewer regola depth+probing in base al tier.

**Il tier si decide SOLO sul CODE.** I file dati/static rigenerati — `data/**` (job JSON, snapshot, translation-cache, blog-articles), `public/**` (immagini/asset), `reports/**`, `_newsletter_variants/**`, `docs/**` — NON sono code: non escalano il tier e non vanno revieweati riga-per-riga (vedi "CODE vs DATA nel diff").

| Tier | Trigger files (CODE) | Adversarial depth |
|---|---|---|
| **high** | `tests/**`, `.github/workflows/**`, `build-plugins/**`, e gli script **funnel-critical**: crawler/parser/adapter, `backfill-*`, `migrate-*`, `assemble-*`, sitemap/canonical/slug/redirect/structured-data — tutto `scripts/**` ECCETTO i non-funnel sotto | Bug nel test/CI/build/emitter = falso senso sicurezza che si propaga su ogni merge. Probe regex/assertion/exit-code/idempotency. Lista 3 cose NON verificate prima dell'output (`## Adversarial check`). |
| **high-mega** | Stesso trigger di `high`, ma con ≥25 code file nel diff (PR batch di grande taglia: crawler multipli, migrazioni cross-file) | Stesso rigore/probing di `high` (`## Adversarial check` incluso) — solo più budget di turni (90 vs 60), non più severity: la taglia della PR non abbassa lo standard. |
| **normal** | tutto il resto, inclusi gli script NON-funnel: `scripts/{ci,dev,evals}/` (helper CI/dev) e gli audit/report read-only (`audit-*`, `analytics*`, `*-report` — verificano, non mutano l'indice) | Single-pass standard. No adversarial step obbligatorio. |
| **minimal** | PR data/docs-only (ZERO code reviewable) | Percorso corto ≤6 turni (sonnet): solo completeness-contract del body, niente REVIEW.md/cross-file/adversarial. Posta `## LGTM`. |
| **incremental** / **incremental-high** | Re-review (esiste già una review Claude su un commit precedente) con delta-code non-funnel (→ `incremental`) o funnel-critical (→ `incremental-high`). Modello UNIFICATO claude-opus-5 a `--effort medium` su entrambi (owner 2026-09-03, supersede claude-sonnet-5 del 2026-07-17: mai claude-sonnet-4-6 — cambia solo il probing, non il modello). | **Token-lever**: i commit fino a `INCREMENTAL_BASE` erano già reviewati → review SOLO il delta dei file PR (`compare $INCREMENTAL_BASE...$HEAD`), non l'intero contributo. Read/grep dei file pieni consentito per il contesto. `incremental-high` mantiene il probing rigoroso + `## Adversarial check` sul delta; `incremental` è single-pass. Prima review / delta vuoto / contributo invariato → NON incrementale (rispettivamente high|normal full, oppure skip via fingerprint-guard). |

### CODE vs DATA nel diff

Carica il diff del solo code (Bootstrap step 3 esclude `data/** public/** reports/** _newsletter_variants/**`). I file dati/static rigenerati NON sono reviewabili come code:

- **Non** revieware riga-per-riga il contenuto di `data/jobs/*.json`, snapshot, `translation-cache`, immagini `public/**`, blog-articles generati. Non sono finding.
- Valuta solo se il **CODE che li genera/emette** è corretto (parser, crawler, build-plugin, writeJson).
- Serve un campione di output? Apri il file mirato con `Read`, non scorrere l'intero blob nel diff.
- `rg`/`grep` cross-file (step 5) scopati al code, mai dentro `data/`/`public/`.

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

### Reviewer behavior

1. **Implementato item** → critical thinking: diff lo implementa? edge case? logica boundary/null/async/ordering? modo più semplice? buco visibile? Code-smell con maintenance debt anche se non blocca il funnel → 🟡 Nit.
2. **Non implementato item** → **post-#8 `## Non implementato` = piano di completamento del task aperto, NON scope-deferito-e-chiuso** (vedi `AGENTS.md → Non-Negotiable #8`). Ogni voce è lavoro ancora dovuto. Verifica che dichiari **stato/next-step concreto** — uno dei sei della tabella qui sopra, non tre: `in questa PR` / `PR concatenata #N` / `blocked: <causa esterna reale>` (lavoro ancora dovuto) **oppure** `per scelta` / `by construction` / `blocked: decisione del proprietario` (voce chiusa con un motivo) — non un motivo-scappatoia (`out of scope`/`posposto`).
   - **Un bullet che dichiara uno stato CHIUDENTE con il motivo scritto dopo lo stato NON è un finding.** Non emettere 🔴/🟡: `scripts/ci/followup-has-candidates.mjs` (`CLOSING_STATES`) e i fixer autonomi lo escludono. Motivo debole → `❓ q:`, non 🔴.
   - Resta 🔴 `per scelta` senza motivo o in contrasto con il motivo: è `out of scope` travestito. Scope-feature in deferral senza piano né implementazione → **🔴 Important**: il task non è chiuso finché `## Non implementato` non legge «Nessuno»; completa con `PR concatenata` o dichiara `blocked:<causa>`. PR può mergiare con sezione non vuota se ogni voce ha next-step, ma non scrivere `## LGTM` per il TASK. `blocked:` esterno lascia il task aperto; `Nessuno` lo completa.
3. **Diff fa cose non dichiarate** → 🟡 scope drift: "diff fa X non in scope. PR separata o aggiungi a Implementato."
   - **Inverso — body dichiara X ma diff non lo mostra** (claim falso; es. cluster PR #1508) → 🟡 Nit: "`## Implementato` afferma X ma il diff non lo riflette — aggiornare il body." (`pr-body-contract.yml` valida presenza degli header, non la precisione del contenuto.)
4. **Sezioni mancanti** → 🔴 process: "manca Implementato/Non implementato nel PR body. Aggiungere prima review sostanziale."
   - **Tier normal**: termina qui, no altri finding (path basso rischio, review sostanziale rimandata al re-push conforme).
   - **Tier high (vedi tabella "Tier review"): NON terminare.** Posta il 🔴 process E prosegui con la review sostanziale + `## Adversarial check` completi nello stesso pass. Il 🔴 process blocca solo l'auto-merge; se deferito il probing salta (#814→#816/#817; #795/#802→#822). Non deferire mai il probing.
   - **`Closes #a #b` multi-issue su una riga** → 🔴 process: GitHub chiude SOLO la prima issue dopo una keyword (`Closes`/`Fixes`/`Resolves`); `Closes #a #b #c` chiude solo `#a`. Chiedi una keyword per issue, una per riga (`Closes #a` / `Closes #b`). Il gate `pr-body-contract.yml` lo flagga a ogni edit; non ripeterlo se il bot ha già commentato lo stesso 🔴.
5. **Cross-file pattern repetition** → quando il diff fix-a un pattern (regex, parsing idiom, assertion shape) in 1 file, `rg`/`grep` su pattern equivalente nel resto repo. **Scopa la ricerca al CODE**: `rg <pattern> scripts build-plugins components services functions server hooks tests` (o `rg <pattern> -g '!data/**' -g '!public/**' -g '!reports/**'`) — cercare in `data/`/`public/` matcha migliaia di blob rigenerati = token sprecati. Se stesso anti-pattern presente altrove non toccato → 🔴 se file funnel-critico (crawler/build-plugin/test gate), 🟡 altrove. Esempio: A3 fix regex `<link rel="canonical"...>` → cerca regex simili su HTML in altri test/crawler.
6. **Test plan compliance** → PR body con `## Test plan` o checklist `- [ ]`: ogni voce è verificabile pre-merge o richiede live? **Se richiede live** (verifica del sito deployato, no file da editare), ok merged-without-tick: **NON sollevare 🟡 né chiedere issue follow-up** — è un item verifica-live-only (vedi `IGNORA → Verifica-live-only`), `post-merge-followup` lo batcha in una checklist promemoria senza issue/fixer. Al più etichetta la voce `(post-merge, live)` nel `## Non implementato` se non già marcata, così il triage la riconosce. **Se verificabile pre-merge** + non spuntata + reviewer non può confermare dal diff → 🟡 chiedi conferma o issue follow-up.
7. **Claim perf/optimization non validato** → PR perf/build/CI che dichiara uno speedup o riduzione regressione (`atteso 65s → 5-10s`, `~60s risparmiati`) **senza misura baseline pre-merge** (solo "il profiler misura al prossimo deploy" / numeri "attesi") su path tier high → 🔴 Important: "claim perf non validato pre-merge; mergi su speculazione. Allega misura pre/post oppure dichiara revert-risk esplicito nel `## Non implementato`." Motivo: #795/#802 mergiati su claim attesi non misurati → regrediti (+17% wall) → revertati (#822). Eccezione: ottimizzazione byte-identica provabile dal diff, o claim con run linkato pre/post.

### Pre-output adversarial check (tier high)

PR a tier `high` (vedi tabella "Tier review"): prima del summary, includi `## Adversarial check` con 3 cose NON verificate (regex edge case non testato, exit-code path non esplorato, file related non aperto, idempotency assumption). Surface come ❓ q dove pertinente. Ogni `❓ q:` non-funnel deve terminare con `— deferred, non funnel-critical.`; `(report-only)`, `non-funnel-critical` o `deferred` nel testo non basta. Un rischio funnel-critical va promosso a 🔴 Important. Tier normal: skip questa sezione.

**Le "cose non verificate" sono rischi di COMPORTAMENTO/correttezza, mai "manca un test".** Mai missing-coverage; surface il rischio sottostante come ❓ q (o 🔴 se funnel-critical): "non so se `parseFoo()` gestisce il null → potrebbe emettere structured-data invalido" è valido.

**Un ❓ dell'adversarial check il cui soggetto è funnel-critical NON resta sepolto qui.** Se impatta monetizzazione/traffico (SEO/redirect/structured-data/AdSense/sitemap/indicizzabilità) → 🔴 Important in `## Findings` (vedi Verification → escalation); non parcheggiarlo qui (#829: redirect-bridge come ❓ → `## LGTM` + zero follow-up).

Tassonomia macchina: `STATE_PATTERNS` in `scripts/lib/pr-body-sections-check.mjs`; `bulletState()` gestisce gli stati chiudenti, quindi niente `agent:fix`/`needs-human`. Omissione di `width` resta bug di rendering.

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

**Marker `🔴 Important` = stringa esatta, MAI bold.** Scrivi `🔴 Important`, non `🔴 **Important**` né `🔴 __Important__`. È letto dai gate (`pr-redflag-fixer.yml`, `auto-merge-eval.mjs`); il formato piano evita il mancato match (PR #2211 round-2). Gate ora tolleranti (regex `🔴\s*\*{0,2}\s*Important`), ma tienilo piano.

**Drop:** "I noticed", "It seems", "perhaps/maybe", "You might want to", restating, "Great work but". No hedging.

**Keep:** linea esatta, simboli in backtick, fix concreto, *perché* solo se non ovvio.

### Esempi

- `services/router.ts:L42: 🔴 Important: parsePath() ritorna null per /lavoro/ticino, route non hydrata. Aggiungere case prima del fallback.`
- `build-plugins/job-page.ts:L88: 🔴 Important: jobLocation omesso da JSON-LD quando city null. Google rifiuta structured data → de-index. Defaultare "Ticino"/"Switzerland".`
- `components/AdSlot.tsx:L23: 🔴 Important: container senza min-height, Auto Ads anchor → CLS 0.18 mobile. min-height: 90px.`
- `scripts/lib/bls-job-parser.mjs:L182: 🔴 Important: regex `<span class="info">` quote-strict, stesso anti-pattern fixato in `tests/seo/cathedral-previous-slug-canton.test.ts:L153` di questa PR. Crawler funnel-critico → silent zero-match su class variant. Allarga a `class=["']?[^"'>]*\binfo\b`.`
- `lib/locale.ts:L17: 🟡 Nit: switch 4 rami → map literal. -12 righe.`
- `pages/SoftLandingPage.tsx:L156: ❓ q: check staticOverlay dopo parsePath() — corretto vs feedback router_preserve_search?`
- `PR body Test plan L3: checkbox "post-deploy gate verde" richiede live → NON sollevare (verifica-live-only); marca `(post-merge, live)` se serve, post-merge-followup la batcha senza issue.`

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
