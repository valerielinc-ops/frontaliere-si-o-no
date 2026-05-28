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
| 🟡 Nit | Migliora ma non blocca. Semplificazione, leggibilità, refactor anti-duplicazione, **magic number/hardcoded date in script long-lived** (resiste a re-run fra anni?), **comment YAML/script >5 righe per dettaglio minore**, **test mancante per path funnel-critico** (vedi sotto). **Cap 3/review**; oltre → `+N similar nits` in summary |
| 🟣 Pre-existing | Bug già pre-PR. Solo se rilevante al diff |
| ❓ q | Domanda genuina quando incerto (no speculazione) |

## IGNORA (anche se veri)

- Security (XSS/injection/secret leak/path traversal) — out of scope
- Style/formatting/naming
- TS strictness salvo maschera bug logico
- Test coverage salvo **path funnel-critici** (landing, structured data, sitemap, **traffic-evidence filter / thinning / grace-window / url-first-seen, crawler dedup, canonical resolver, robots emitter**). Fix funnel-critici → 🟡 Nit "manca vitest" se assente.
- Refactor speculativi non legati al diff
- "Aggiungi test" generico senza target+motivo funnel
- Cavilli architetturali se la soluzione attuale funziona

## Completeness contract

PR body DEVE avere:

```markdown
## Implementato
- Lista cosa la PR fa.

## Non implementato (ancora)
- Lista scope NON fatto + motivo (out of scope / follow-up / blocked / posposto).
```

### Reviewer behavior

1. **Implementato item** → critical thinking: diff lo implementa? edge case? logica boundary/null/async/ordering? modo più semplice? buco visibile? **Code-smell anche se non funnel-blocker**: magic number hardcoded, data fissa, comment YAML monstre, mancanza vitest su path funnel-critico → 🟡 Nit.
2. **Non implementato item** → filtro scopo: critico per monetizzazione/traffico? SÌ → 🔴 chiedi impl pre-merge o follow-up issue. NO → ignora.
3. **Diff fa cose non dichiarate** → 🟡 scope drift: "diff fa X non in scope. PR separata o aggiungi a Implementato."
4. **Sezioni mancanti** → 🔴 process: "manca Implementato/Non implementato nel PR body. Aggiungere prima review sostanziale." Termina, no altri finding.

## Verification

Behavior claims richiedono `file:linea`. No speculazione. Incerto → `❓ q:`.

**Edge case probing via `❓ q:`** anche quando sei sicuro dell'implementazione: file cancellato manualmente per refresh totale, race condition tra job paralleli, input degenere (file vuoto/corrotto), default che diventa permanente. Surface come domanda, non assumere che l'autore l'abbia considerato.

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
- `lib/locale.ts:L17: 🟡 Nit: switch 4 rami → map literal. -12 righe.`
- `scripts/refresh-url-first-seen.mjs:L43: 🟡 Nit: DEFAULT_INITIAL_SEED_DATE='2026-04-01' hardcoded. Sostituire con today-90days dinamico; resiste a rigenerazione file fra anni.`
- `scripts/refresh-url-first-seen.mjs: 🟡 Nit: nessun vitest su path funnel-critico (grace-window decisione thinning). Aggiungere tests/scripts/refreshUrlFirstSeen.test.ts (~15 righe): initial-seed → stampDate==seed, incremental → today, !existing guard preserva monotonicity.`
- `.github/workflows/deploy.yml:L835-841: 🟡 Nit: comment 8 righe spiega 1 flag. Riduci a 2 righe — incident history vive in git blame.`
- `pages/SoftLandingPage.tsx:L156: ❓ q: check staticOverlay dopo parsePath() — corretto vs feedback router_preserve_search?`
- `scripts/refresh-url-first-seen.mjs:L138: ❓ q: admin cancella file manualmente per refresh → INITIAL-SEED ri-stampa 2026-04-01 per tutti. Intenzionale o serve guard "no re-INITIAL-SEED se file esisteva di recente in git"?`

## Summary body

```markdown
## Scope
<una frase: scopo PR>

## Findings (Important: N, Nit: M)
<lista>
```

Zero 🔴 Important: chiudi con `## LGTM` + frase recap.
