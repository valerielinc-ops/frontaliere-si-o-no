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
| 🔴 Important | Rompe funnel/monetizzazione/traffico. Bug che blocca rendering, regressione SEO/AdSense, structured data invalido, scope critico mancante |
| 🟡 Nit | Migliora ma non blocca. Semplificazione, leggibilità, refactor anti-duplicazione, **code-smell che crea maintenance debt** (hardcoded values che invecchiano, comment grossly oversized, test mancanti su path funnel-critici). **Cap 3/review**; oltre → `+N similar nits` in summary |
| 🟣 Pre-existing | Bug già pre-PR. Solo se rilevante al diff |
| ❓ q | Domanda genuina quando incerto (no speculazione) |

## IGNORA (anche se veri)

- Security (XSS/injection/secret leak/path traversal) — out of scope
- Style/formatting/naming
- TS strictness salvo maschera bug logico
- Test coverage salvo path funnel-critici (qualunque script o modulo che decide cosa viene indicizzato, emit di structured data, sitemap, AdSense placement). Fix su tali path senza test → 🟡 Nit.
- Script funnel-critico senza workflow CI corrispondente (manual-only, dipende da SA/credenziali su macchina dev) → 🟡 Nit. Eccezioni motivate (one-shot ammortizzato, dev-only) restano nel `## Non implementato` con motivo esplicito.
- Refactor speculativi non legati al diff
- "Aggiungi test" generico senza target+motivo funnel
- Cavilli architetturali se la soluzione attuale funziona

## Tier review (effort + adversarial depth)

Determina tier dai file toccati. Reviewer regola depth+probing in base a tier.

| Tier | Trigger files | Adversarial depth |
|---|---|---|
| **high** | `tests/**`, `.github/workflows/**`, `scripts/**` (validators, migrators, crawlers), `build-plugins/**` | Bug nel test/CI/build = falso senso sicurezza che si propaga su ogni merge. Probe regex/assertion/exit-code/idempotency. Lista 3 cose NON verificate prima dell'output (`## Adversarial check`). |
| **normal** | tutto il resto | Single-pass standard. No adversarial step obbligatorio. |

High-tier non implica più 🔴 — implica più probing. Filtro scopo identico.

## Completeness contract

PR body DEVE avere:

```markdown
## Implementato
- Lista cosa la PR fa.

## Non implementato (ancora)
- Lista scope NON fatto + motivo (out of scope / follow-up / blocked / posposto).
```

### Reviewer behavior

1. **Implementato item** → critical thinking: diff lo implementa? edge case? logica boundary/null/async/ordering? modo più semplice? buco visibile? Code-smell con maintenance debt anche se non blocca il funnel → 🟡 Nit.
2. **Non implementato item** → filtro scopo: critico per monetizzazione/traffico? SÌ → 🔴 chiedi impl pre-merge o follow-up issue. NO → ignora.
3. **Diff fa cose non dichiarate** → 🟡 scope drift: "diff fa X non in scope. PR separata o aggiungi a Implementato."
4. **Sezioni mancanti** → 🔴 process: "manca Implementato/Non implementato nel PR body. Aggiungere prima review sostanziale."
   - **Tier normal**: termina qui, no altri finding (path basso rischio, review sostanziale rimandata al re-push conforme).
   - **Tier high (`tests/**`, `.github/workflows/**`, `scripts/**`, `build-plugins/**`): NON terminare.** Posta il 🔴 process E prosegui con la review sostanziale + `## Adversarial check` completi nello stesso pass. Motivo: il 🔴 process blocca solo l'auto-merge (`## LGTM`), non un merge manuale; se la sostanza è deferita ("re-review post-update") e l'autore mergia a mano, il probing non avviene mai e i bug si propagano. Caso reale: #814 deferì idempotency-retry-loop + `rebase --abort` autostash → mergiato a mano dopo 40s → diventati le issue #816/#817. #795/#802 fermati al solo process gate → mergiati → entrambi revertati (#822, +17% wall). Non deferire mai il probing su tier high.
5. **Cross-file pattern repetition** → quando il diff fix-a un pattern (regex, parsing idiom, assertion shape) in 1 file, `rg`/`grep` su pattern equivalente nel resto repo. Se stesso anti-pattern presente altrove non toccato → 🔴 se file funnel-critico (crawler/build-plugin/test gate), 🟡 altrove. Esempio: A3 fix regex `<link rel="canonical"...>` → cerca regex simili su HTML in altri test/crawler.
6. **Test plan compliance** → PR body con `## Test plan` o checklist `- [ ]`: ogni voce è verificabile pre-merge o richiede live? Se richiede live, ok merged-without-tick MA flag come 🟡 ricorda spunta post-merge. Se verificabile pre-merge + non spuntata + reviewer non può confermare dal diff → 🟡 chiedi conferma o issue follow-up.
7. **Claim perf/optimization non validato** → PR perf/build/CI che dichiara uno speedup o riduzione regressione (`atteso 65s → 5-10s`, `~60s sparmiati`, `177s → ~110s`) **senza misura baseline pre-merge** — solo "il profiler misura al prossimo deploy" / numeri "attesi" — su path tier high → 🔴 Important: "claim perf non validato pre-merge; mergi su speculazione. Allega misura pre/post oppure dichiara esplicito revert-risk nel `## Non implementato`." Motivo: #795 (IN_FLIGHT 4→8) e #802 (async BFS walkHtml) mergiati su claim attesi non misurati → entrambi regrediti (+17% post-walk wall) → revertati 24h dopo (#822). Parallelismo/IO-tuning su runner condiviso (4-vCPU GitHub) è il caso classico dove il claim atteso diverge dal misurato. Eccezione: ottimizzazione byte-identica banale (es. dedup-early provabile dal diff) o claim già supportato da un run linkato con numeri pre/post.

### Pre-output adversarial check (tier high)

PR a tier `high` (`tests/**`, `.github/workflows/**`, `scripts/**`, `build-plugins/**`): prima del summary finale, includi sezione `## Adversarial check` con 3 cose NON verificate (regex edge case non testato, exit-code path non esplorato, file related non aperto, idempotency assumption). Surface come ❓ q dove pertinente. Tier normal: skip questa sezione.

**Un ❓ dell'adversarial check il cui soggetto è funnel-critical NON resta sepolto qui.** Se mentre lo scrivi riconosci che, se vero, l'item impatta monetizzazione/traffico (SEO/redirect/structured-data/AdSense/sitemap/indicizzabilità) → promuovilo a 🔴 Important in `## Findings` (vedi Verification → escalation). L'adversarial check è per incertezze residue non-bloccanti, non per parcheggiare bug funnel-critical con un punto di domanda. Caso reale: #829 mise `orphanResult.merged` vs `.mergedCount` (writeJson previousSlugs morto → redirect bridge non persistito) come ❓ qui + `## LGTM` → auto-merge, zero follow-up.

## Verification

Behavior claims richiedono `file:linea`. No speculazione. Incerto → `❓ q:`.

**Edge case probing via `❓ q:`** anche quando sei sicuro dell'implementazione: input degenere, race condition, default che diventa permanente, refresh manuale dell'autore. Surface come domanda, non assumere che l'autore l'abbia considerato.

**Escalation ❓ funnel-critical → 🔴.** Un `❓ q` resta `❓` solo se l'impatto, fosse anche vero, è non-funnel o cosmetico. Se il soggetto del dubbio — pre-existing o no — impatta monetizzazione/traffico (gate writeJson/persistenza su dataset indicizzato, canonical/redirect/previousSlugs, structured data, sitemap, AdSense placement, indicizzabilità) → NON lasciarlo `❓` passivo accanto a un `## LGTM`. Promuovilo a 🔴 Important (blocca auto-merge) **oppure** apri esplicitamente una follow-up issue e linkala nel finding. Il filtro "pre-existing / out of scope" abbassa la severità del *blocco PR*, non cancella un bug funnel-critical: vale comunque 🔴 o issue. Non affidarti a `post-merge-followup` come rete: può non scattare (storicamente è rimasto fermo) e il finding evapora.

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

**Drop:** "I noticed", "It seems", "perhaps/maybe", "You might want to", restating, "Great work but". No hedging.

**Keep:** linea esatta, simboli in backtick, fix concreto, *perché* solo se non ovvio.

### Esempi

- `services/router.ts:L42: 🔴 Important: parsePath() ritorna null per /lavoro/ticino, route non hydrata. Aggiungere case prima del fallback.`
- `build-plugins/job-page.ts:L88: 🔴 Important: jobLocation omesso da JSON-LD quando city null. Google rifiuta structured data → de-index. Defaultare "Ticino"/"Switzerland".`
- `components/AdSlot.tsx:L23: 🔴 Important: container senza min-height, Auto Ads anchor → CLS 0.18 mobile. min-height: 90px.`
- `scripts/lib/bls-job-parser.mjs:L182: 🔴 Important: regex `<span class="info">` quote-strict, stesso anti-pattern fixato in `tests/seo/cathedral-previous-slug-canton.test.ts:L153` di questa PR. Crawler funnel-critico → silent zero-match su class variant. Allarga a `class=["']?[^"'>]*\binfo\b`.`
- `lib/locale.ts:L17: 🟡 Nit: switch 4 rami → map literal. -12 righe.`
- `pages/SoftLandingPage.tsx:L156: ❓ q: check staticOverlay dopo parsePath() — corretto vs feedback router_preserve_search?`
- `PR body Test plan L3: 🟡 Nit: checkbox "post-deploy gate verde" richiede live, ok merge ma flagga spunta o crea issue follow-up post-deploy.`

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
