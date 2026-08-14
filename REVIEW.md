# Review Instructions

Reviewer contract. Filtra finding via scopo progetto, non stile/sicurezza/naming.

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

Ogni 🟡 nit che sollevi **deve dichiarare la propria disposizione**, così `post-merge-followup` non deve indovinarla e non minta un follow-up di basso valore (~470 run/sett — vedi `FOLLOWUP.md → Gate grandchild-suppression`):

- **Nit non-funnel** (stile/leggibilità/naming/maintenance-debt senza impatto monetizzazione/traffico) → suffissa **`— deferred, non funnel-critical`**. `post-merge-followup` lo droppa senza issue (eccezione esistente in `AGENTS.md → Post-merge feedback handling`). NON diventa follow-up.
- **Nit funnel-critical E azionabile** (cambia un comportamento su monetizzazione/traffico/correttezza) → resta candidate follow-up normale. Questi sono gli UNICI 🟡 che devono mintare. Se il fix è banale e isolato, preferisci dirlo come 🔴-soft "fixa in-PR prima di `## LGTM`" invece di deferirlo (un fix in-PR = zero run treadmill; un follow-up = ~3 run).

Razionale: la disposizione esplicita sposta il triage del nit **a sinistra** (al review, gratis) non **a destra** (minting → `agent:fix` → `pr-review`). Non bloccare l'auto-merge sui nit non-funnel (quota-shift, non quota-saving). Il blocco merge resta solo su 🔴 + process.

## IGNORA (anche se veri)

- Security (XSS/injection/secret leak/path traversal) — out of scope
- Style/formatting/naming
- TS strictness salvo maschera bug logico
- **Test coverage — MAI un finding** (né 🟡 nit né voce `## Adversarial check`), nemmeno su path funnel-critici. "Manca un test per X", "aggiungi coverage", "committa il test citato nel PR body", "pinna questo comportamento con un test" → NON sollevare in alcuna forma. Zero valore per l'owner; auto-routano `agent:fix`, bruciano quota condivisa. **Eccezione (resta in scope):** un BUG in un test ESISTENTE — assertion sbagliata, regex/guard leaky che resta verde sulla regressione, fixture con date assolute — è correttezza, non coverage → 🔴/🟡 normale.
- **Verifica-live-only — MAI un finding actionable.** Un item la cui **unica azione è ispezionare il sito già deployato** (no file da editare): "verifica live / post-deploy", "curl la URL prod / live-200", "renderizza a NNNpx", "apri DevTools", "Playwright hydration", checkbox `## Test plan` etichettata `(post-merge, live)` → NON emetterlo come 🟡 nit né come voce `## Adversarial check` né come "crea issue follow-up". Non c'è codice da cambiare → auto-routerebbe `agent:fix` su una PR vuota, quota condivisa bruciata (classe #1149/#959/#1129). Il fix è già nel diff: conferma runtime è promemoria per l'owner, non deliverable d'agente. **Eccezione (resta in scope):** un item che **mescola** la verifica-live con un'edit concreta su un file ("aggiungi `min-height` E poi verifica il CLS live") → solleva la parte editabile, normale. E un BUG di rendering **diagnosticabile dal diff/codice** (non "controlla in prod" ma "questo selettore omette `width` → CLS") resta 🔴/🟡. Vedi `FOLLOWUP.md → Hard-exclude: live-verification-only item`.
- Script funnel-critico senza workflow CI corrispondente (manual-only, dipende da SA/credenziali su macchina dev) → 🟡 Nit. Eccezioni motivate (one-shot ammortizzato, dev-only) restano nel `## Non implementato` con motivo esplicito.
- Refactor speculativi non legati al diff
- Cavilli architetturali se la soluzione attuale funziona

## Tier review (effort + adversarial depth)

Determina tier dai file toccati. Reviewer regola depth+probing in base a tier. Tier auto-calcolato dal workflow (`pr-review-loop.yml`) e passato nel prompt; le righe sotto sono il razionale.

**Il tier si decide SOLO sul CODE.** I file dati/static rigenerati — `data/**` (job JSON, snapshot, translation-cache, blog-articles), `public/**` (immagini/asset), `reports/**`, `_newsletter_variants/**`, `docs/**` — NON sono code: non escalano il tier e non vanno revieweati riga-per-riga (vedi "CODE vs DATA nel diff").

| Tier | Trigger files (CODE) | Adversarial depth |
|---|---|---|
| **high** | `tests/**`, `.github/workflows/**`, `build-plugins/**`, e gli script **funnel-critical**: crawler/parser/adapter, `backfill-*`, `migrate-*`, `assemble-*`, sitemap/canonical/slug/redirect/structured-data — tutto `scripts/**` ECCETTO i non-funnel sotto | Bug nel test/CI/build/emitter = falso senso sicurezza che si propaga su ogni merge. Probe regex/assertion/exit-code/idempotency. Lista 3 cose NON verificate prima dell'output (`## Adversarial check`). |
| **high-mega** | Stesso trigger di `high`, ma con ≥25 code file nel diff (PR batch di grande taglia: crawler multipli, migrazioni cross-file) | Stesso rigore/probing di `high` (`## Adversarial check` incluso) — solo più budget di turni (90 vs 60), non più severity: la taglia della PR non abbassa lo standard. |
| **normal** | tutto il resto, inclusi gli script NON-funnel: `scripts/{ci,dev,evals}/` (helper CI/dev) e gli audit/report read-only (`audit-*`, `analytics*`, `*-report` — verificano, non mutano l'indice) | Single-pass standard. No adversarial step obbligatorio. |
| **minimal** | PR data/docs-only (ZERO code reviewable) | Percorso corto ≤6 turni (sonnet): solo completeness-contract del body, niente REVIEW.md/cross-file/adversarial. Posta `## LGTM`. |
| **incremental** / **incremental-high** | Re-review (esiste già una review Claude su un commit precedente) con delta-code non-funnel (→ `incremental`, sonnet) o funnel-critical (→ `incremental-high`, opus). | **Token-lever**: i commit fino a `INCREMENTAL_BASE` erano già reviewati → review SOLO il delta dei file PR (`compare $INCREMENTAL_BASE...$HEAD`), non l'intero contributo. Read/grep dei file pieni consentito per il contesto. `incremental-high` mantiene il probing opus + `## Adversarial check` sul delta; `incremental` è single-pass sonnet. Prima review / delta vuoto / contributo invariato → NON incrementale (rispettivamente high|normal full, oppure skip via fingerprint-guard). |

High-tier non implica più 🔴 — implica più probing. Filtro scopo identico. Il delta-scope incrementale riduce i token, NON la severity: un 🔴 nel delta resta 🔴.

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

Gli **stati letterali** ammessi sono CINQUE, e sono quelli che le macchine riconoscono — `STATE_PATTERNS` in `scripts/lib/pr-body-sections-check.mjs`, da cui `scripts/ci/followup-has-candidates.mjs` importa `bulletState()`. Elencarne solo tre qui rendeva questo doc più stretto dei gate, quindi un `per scelta` legittimo tornava come finding:

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
2. **Non implementato item** → **post-#8 `## Non implementato` = piano di completamento del task aperto, NON scope-deferito-e-chiuso** (vedi `AGENTS.md → Non-Negotiable #8`). Ogni voce è lavoro ancora dovuto. Verifica che dichiari **stato/next-step concreto** (`in questa PR` / `PR concatenata #N` / `blocked: <causa esterna reale>`), non un motivo-scappatoia (`out of scope`/`posposto`). Voce di scope-feature lasciata come deferral senza piano-di-completamento né essere fatta → **🔴 Important**: "scope dovuto non implementato né pianificato; il task non è chiuso finché `## Non implementato` non legge «Nessuno» — completa (PR concatenata) o dichiara `blocked:<causa>`." Una singola PR PUÒ mergiare con la sezione non-vuota se ogni voce porta un next-step credibile (è una catena): in quel caso non bloccare il merge, ma **non scrivere `## LGTM` per il TASK** — l'auto-merge della PR ≠ chiusura del task. `blocked:` con causa esterna reale → accettato (task resta aperto, non colpa). `Nessuno` → task completo, ok.
3. **Diff fa cose non dichiarate** → 🟡 scope drift: "diff fa X non in scope. PR separata o aggiungi a Implementato."
   - **Inverso — body dichiara X ma diff non lo mostra** (claim falso; es. cluster PR #1508) → 🟡 Nit: "`## Implementato` afferma X ma il diff non lo riflette — aggiornare il body." (`pr-body-contract.yml` valida presenza degli header, non la precisione del contenuto.)
4. **Sezioni mancanti** → 🔴 process: "manca Implementato/Non implementato nel PR body. Aggiungere prima review sostanziale."
   - **Tier normal**: termina qui, no altri finding (path basso rischio, review sostanziale rimandata al re-push conforme).
   - **Tier high (vedi tabella "Tier review"): NON terminare.** Posta il 🔴 process E prosegui con la review sostanziale + `## Adversarial check` completi nello stesso pass. Motivo: 🔴 process blocca solo l'auto-merge, non un merge manuale — se deferito il probing salta (#814→#816/#817; #795/#802→#822). Non deferire mai il probing su tier high.
   - **`Closes #a #b` multi-issue su una riga** → 🔴 process: GitHub chiude SOLO la prima issue dopo una keyword (`Closes`/`Fixes`/`Resolves`); `Closes #a #b #c` chiude solo `#a`, le altre restano aperte (cfr. PR #1320). Chiedi una keyword per issue, una per riga (`Closes #a` / `Closes #b`). Il gate `pr-body-contract.yml` lo flagga già a ogni edit (zero-Claude) — cintura nel raro caso non scatti; **non** ripeterlo se il bot ha già commentato lo stesso 🔴.
5. **Cross-file pattern repetition** → quando il diff fix-a un pattern (regex, parsing idiom, assertion shape) in 1 file, `rg`/`grep` su pattern equivalente nel resto repo. **Scopa la ricerca al CODE**: `rg <pattern> scripts build-plugins components services functions server hooks tests` (o `rg <pattern> -g '!data/**' -g '!public/**' -g '!reports/**'`) — cercare in `data/`/`public/` matcha migliaia di blob rigenerati = token sprecati. Se stesso anti-pattern presente altrove non toccato → 🔴 se file funnel-critico (crawler/build-plugin/test gate), 🟡 altrove. Esempio: A3 fix regex `<link rel="canonical"...>` → cerca regex simili su HTML in altri test/crawler.
6. **Test plan compliance** → PR body con `## Test plan` o checklist `- [ ]`: ogni voce è verificabile pre-merge o richiede live? **Se richiede live** (verifica del sito deployato, no file da editare), ok merged-without-tick: **NON sollevare 🟡 né chiedere issue follow-up** — è un item verifica-live-only (vedi `IGNORA → Verifica-live-only`), `post-merge-followup` lo batcha in una checklist promemoria senza issue/fixer. Al più etichetta la voce `(post-merge, live)` nel `## Non implementato` se non già marcata, così il triage la riconosce. **Se verificabile pre-merge** + non spuntata + reviewer non può confermare dal diff → 🟡 chiedi conferma o issue follow-up.
7. **Claim perf/optimization non validato** → PR perf/build/CI che dichiara uno speedup o riduzione regressione (`atteso 65s → 5-10s`, `~60s risparmiati`) **senza misura baseline pre-merge** (solo "il profiler misura al prossimo deploy" / numeri "attesi") su path tier high → 🔴 Important: "claim perf non validato pre-merge; mergi su speculazione. Allega misura pre/post oppure dichiara revert-risk esplicito nel `## Non implementato`." Motivo: #795/#802 mergiati su claim attesi non misurati → regrediti (+17% wall) → revertati (#822). Eccezione: ottimizzazione byte-identica provabile dal diff, o claim con run linkato pre/post.

### Pre-output adversarial check (tier high)

PR a tier `high` (vedi tabella "Tier review"): prima del summary finale, includi sezione `## Adversarial check` con 3 cose NON verificate (regex edge case non testato, exit-code path non esplorato, file related non aperto, idempotency assumption). Surface come ❓ q dove pertinente. Tier normal: skip questa sezione.

**Le "cose non verificate" sono rischi di COMPORTAMENTO/correttezza, mai "manca un test".** Non scrivere voci adversarial del tipo "questo branch non ha test" / "andrebbe pinnato con un test" (vedi IGNORA → test coverage): sono missing-coverage travestiti e violano la regola. Surface invece il rischio sottostante — *il comportamento X su input degenere potrebbe sbagliare* — come ❓ q (o 🔴 se funnel-critical). La differenza è netta: "non so se `parseFoo()` gestisce il null → potrebbe emettere structured-data invalido" = valido (rischio di comportamento); "manca un test per il ramo null di `parseFoo()`" = vietato (coverage).

**Un ❓ dell'adversarial check il cui soggetto è funnel-critical NON resta sepolto qui.** Se mentre lo scrivi riconosci che, se vero, l'item impatta monetizzazione/traffico (SEO/redirect/structured-data/AdSense/sitemap/indicizzabilità) → promuovilo a 🔴 Important in `## Findings` (vedi Verification → escalation). L'adversarial check è per incertezze residue non-bloccanti, non per parcheggiare bug funnel-critical con un punto di domanda (#829: bug redirect-bridge come ❓ invece di 🔴 → `## LGTM` + zero follow-up).

## Verification

Behavior claims richiedono `file:linea`. No speculazione. Incerto → `❓ q:`.

**Edge case probing via `❓ q:`** anche quando sei sicuro dell'implementazione: input degenere, race condition, default che diventa permanente, refresh manuale dell'autore. Surface come domanda, non assumere che l'autore l'abbia considerato.

**Escalation ❓ funnel-critical → 🔴.** Un `❓ q` resta `❓` solo se l'impatto, fosse anche vero, è non-funnel o cosmetico. Se il soggetto del dubbio — pre-existing o no — impatta monetizzazione/traffico (gate writeJson/persistenza su dataset indicizzato, canonical/redirect/previousSlugs, structured data, sitemap, AdSense placement, indicizzabilità) → NON lasciarlo `❓` passivo accanto a un `## LGTM`. Promuovilo a 🔴 Important (blocca auto-merge) **oppure** apri esplicitamente una follow-up issue e linkala nel finding. Il filtro "pre-existing / out of scope" abbassa la severità del *blocco PR*, non cancella un bug funnel-critical: vale comunque 🔴 o issue. Non affidarti a `post-merge-followup` come rete: può non scattare.

## Re-review convergence

Dopo prima review:
- Sopprimi 🟡. Posta solo 🔴.
- Fix di L<linea> già applicato → conferma `Fix di L<linea>: ok.`
- No rilanciare nit già detti.

## Output format

Una riga/finding:
```
<file>:L<linea>: <prefix> <problema>. <fix>.
```

Prefix: `🔴 Important` / `🟡 Nit` / `🟣 Pre-existing` / `❓ q:`.

**Marker `🔴 Important` = stringa esatta, MAI bold.** Scrivi `🔴 Important` (emoji + spazio + parola piana), non `🔴 **Important**` né `🔴 __Important__`. È un marker leggibile da gate deterministici (`pr-redflag-fixer.yml` per auto-fixare il 🔴, `auto-merge-eval.mjs` per bloccare il merge). Un bold rompeva il match literal, 🔴 mai indirizzato (PR #2211 round-2). Gate ora tolleranti (regex `🔴\s*\*{0,2}\s*Important`), ma tieni il formato piano: tolleranza è solo cintura.

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
<solo tier high: 3 cose NON verificate>
```

Zero 🔴 Important: chiudi con `## LGTM` + frase recap. **Critico:** la stringa esatta `## LGTM` triggera auto-merge in `auto-merge-on-lgtm.yml`. Non scrivere mai `## LGTM` se hai aperto un 🔴 in findings o adversarial check, **né se hai un ❓ funnel-critical non escalato** (vedi Verification → escalation): o lo promuovi a 🔴, o apri follow-up issue + lo dichiari, prima di poter scrivere `## LGTM`.
