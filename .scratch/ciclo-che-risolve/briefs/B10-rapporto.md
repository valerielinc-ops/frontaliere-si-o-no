# B10 — Diagnosi della review Claude del sito

Data: 2026-09-09
Repo analizzato: `valerielinc-ops/frontaliere-si-o-no`

## Diagnosi

La causa osservata è il ref flottante `anthropics/claude-code-action@v1` usato
dal check required di `.github/workflows/tests.yml`: tra il run riuscito e
quelli falliti ha risolto due revisioni upstream diverse. L’aggiornamento
upstream ha portato l’SDK/native installer da
`0.3.263/2.1.263` a `0.3.265/2.1.265`; sul runner del sito la nuova installazione
ha dichiarato successo lasciando però assente `~/.local/bin/claude`. L’SDK ha
quindi fallito con `ENOENT` prima di poter eseguire la review.

Non è stata trovata una causa nei nuovi step locali del sito. La riparazione è
pertanto un pin del ref dell’azione alla revisione precedente già osservata
funzionare; non è un workaround che crea manualmente il binario o indebolisce
il gate.

## Prova: riuscito contro fallito

| Run | Azione risolta | Installazione | Esito |
|---|---|---|---|
| `34274258155` — PR #8047, review alle `2026-09-08T20:30:20Z` | `9c5ddab2e6d1…` | SDK `0.3.263`, native `2.1.263`; `Claude Code successfully installed`, location `~/.local/bin/claude`, nessun setup note | review eseguita e pubblicata |
| `34288936077` — PR #8050 | `0d0e0876d3ea…` | SDK `0.3.265`, native `2.1.265`; setup note: `/home/runner/.local/bin does not exist`, seguito comunque da un falso messaggio di installazione riuscita | `ReferenceError ... native binary not found ... (ENOENT)` alle `23:32:18Z`; nessuna review |

La revisione upstream `0d0e0876d3ea…` risulta pubblicata alle
`2026-09-08T20:38:21Z` con messaggio di bump a Claude Code `2.1.265` e Agent
SDK `0.3.265`, dopo la review riuscita delle `20:30:20Z`. Il log del run
fallito mostra inoltre che l’SDK usa proprio
`/home/runner/.local/bin/claude` come `pathToClaudeCodeExecutable`, cioè il
percorso che l’installer aveva appena segnalato come inesistente.

Il corpus fornisce un controllo utile: il run `34282154600` delle
`2026-09-08T21:43:25Z` ha risolto lo stesso SHA `0d0e0876d3ea…` e installato
`2.1.265` senza il setup note, poi ha eseguito la review. Quindi il difetto non
è un fallimento universale di ogni runner con `2.1.265`; è comunque il cambio
upstream assorbito dal ref mobile del sito, con un’installazione non affidabile
e un errore riproducibile nei run del sito. Il successo del corpus esclude come
causa necessaria il checkout, il modello, il flag e il token GitHub.

## Verifica delle differenze note

### Headroom

Nel sito `Wait for background Headroom install` ha registrato
`No background steps remaining to wait for`. Subito dopo, `Setup Headroom
compression proxy` è stato invocato con `skip-install: true`: il sotto-step
`Install Headroom` è risultato `skipped` e `start.sh` ha stampato
`HEADROOM-INACTIVE: headroom not installed — skipping compression (Claude runs
direct)`.

Il codice di `install.sh`, se invocato, installerebbe
`headroom-ai[proxy,code]` con `pipx` o `pip --user`, aggiungerebbe
`$HOME/.local/bin` a `GITHUB_PATH` ed esporterebbe quel path nel proprio shell.
Nel run osservato non è stato invocato. `start.sh` ha solo esportato il path nel
proprio processo; non ha scritto `GITHUB_PATH`, non ha creato `~/.local/bin` e
non ha scritto `ANTHROPIC_BASE_URL` perché Headroom non era presente. Non è la
causa dell’ENOENT.

### `--dangerously-skip-permissions`

Il log del sito mostra il flag in `claude_args`. Il log del run corpus riuscito
con lo stesso SHA upstream mostra lo stesso flag. Il flag entra negli argomenti
del processo Claude dopo la risoluzione dell’eseguibile; non spiega una directory
locale mancante.

### App token e `github_token`

Il mint del sito è riuscito e il relativo script scrive solo la capability e il
token nell’ambiente GitHub per gli step successivi; non modifica `HOME`, `PATH`,
`~/.local/bin` o il percorso dell’eseguibile. `github_token` controlla
l’autenticazione GitHub/remote dell’azione, mentre l’errore è un `ENOENT` sul
binario locale dopo l’installazione. I valori dei secret non sono stati copiati
nel rapporto né nell’output.

### Checkout della PR #8047

Il percorso mancante è sotto `/home/runner`, fuori dal checkout. La coppia
`fetch-depth: 0` + `filter: blob:none` non è stata modificata e non è una causa
compatibile con questo errore.

## Scope dei workflow sibling

Il sibling gate ha segnalato nove invocatori Claude aggiuntivi. Sono stati
ispezionati uno per uno: condividono il nome dell’azione ma appartengono a
workflow di audit, report, issue/fixer e follow-up, non al check required che ha
bloccato le PR. Il primo tentativo di pinning di tutti e dieci ha fatto fallire
la suite preesistente con `4 failed | 2033 passed`: due test cercano ancora
esplicitamente il marker `anthropics/claude-code-action@v1` e due contratti
analizzano quei workflow. Quei test non sono stati indeboliti; i nove sibling
sono stati ripristinati. Per questo incidente sono falsi positivi di scope del
sibling gate, mentre il pin del check required resta il diff minimo verificabile.

## Riparazione

In questa branch il solo invocatore required della review in
`.github/workflows/tests.yml` è stato cambiato da `@v1` al commit upstream
`9c5ddab2e6d17b83ea679153b31f1d5f023cf636`, che il run #8047 dimostra funzionare
con `2.1.263`. I nove sibling restano invariati per mantenere il loro contratto
di test e perché non sono nel percorso required osservato. Non sono stati
toccati Headroom, token, flag, checkout, assemble, gate o dati generati.

Il pin è la riparazione upstream prevista: non crea manualmente il binario e
non imposta `pathToClaudeCodeExecutable` su un percorso inventato.

## Stato PR

La PR di riparazione è stata aperta come sito PR #8052
(`fix/sito-review-enoent`). Al momento dell’aggiornamento è aperta e in attesa
dei check automatici; non è stata approvata né mergiata manualmente. L’esito
finale della PR va registrato qui dopo il ciclo automatico.
