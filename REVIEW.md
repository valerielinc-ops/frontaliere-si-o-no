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
4. **Sezioni mancanti** → 🔴 process: "manca Implementato/Non implementato nel PR body. Aggiungere prima review sostanziale." Termina, no altri finding.
5. **Cross-file pattern repetition** → quando il diff fix-a un pattern (regex, parsing idiom, assertion shape) in 1 file, `rg`/`grep` su pattern equivalente nel resto repo. Se stesso anti-pattern presente altrove non toccato → 🔴 se file funnel-critico (crawler/build-plugin/test gate), 🟡 altrove. Esempio: A3 fix regex `<link rel="canonical"...>` → cerca regex simili su HTML in altri test/crawler.
6. **Test plan compliance** → PR body con `## Test plan` o checklist `- [ ]`: ogni voce è verificabile pre-merge o richiede live? Se richiede live, ok merged-without-tick MA flag come 🟡 ricorda spunta post-merge. Se verificabile pre-merge + non spuntata + reviewer non può confermare dal diff → 🟡 chiedi conferma o issue follow-up.

### Pre-output adversarial check (tier high)

PR a tier `high` (`tests/**`, `.github/workflows/**`, `scripts/**`, `build-plugins/**`): prima del summary finale, includi sezione `## Adversarial check` con 3 cose NON verificate (regex edge case non testato, exit-code path non esplorato, file related non aperto, idempotency assumption). Surface come ❓ q dove pertinente. Tier normal: skip questa sezione.

## Verification

Behavior claims richiedono `file:linea`. No speculazione. Incerto → `❓ q:`.

**Edge case probing via `❓ q:`** anche quando sei sicuro dell'implementazione: input degenere, race condition, default che diventa permanente, refresh manuale dell'autore. Surface come domanda, non assumere che l'autore l'abbia considerato.

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

Zero 🔴 Important: chiudi con `## LGTM` + frase recap. **Critico:** la stringa esatta `## LGTM` triggera auto-merge in `auto-merge-on-lgtm.yml`. Non scrivere mai `## LGTM` se hai aperto un 🔴 in findings o adversarial check.
