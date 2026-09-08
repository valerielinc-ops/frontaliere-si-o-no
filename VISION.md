# VISION — driver di decisione del ciclo autonomo

Questo documento esiste per UNA ragione misurata: al 2026-08-21 il backlog contava
47 issue in `needs-human` — stato che nessun meccanismo riprendeva — e una parte
di quelle attese non erano decisioni vere ma decisioni GIÀ PRESE (registrate in
commenti sparsi) o questioni che un driver scritto avrebbe risolto da solo. Il
2026-08-14 era già stato misurato: 16 su 35 `needs-human` erano difetti tecnici
parcheggiati per sbaglio.

**Rimisurato il 2026-09-05, e il fenomeno non è finito: 22 issue del corpus
erano `fu-parked`/`needs-human`, e solo 4 aspettavano davvero una decisione del
proprietario.** Delle altre 18: una era già risolta da un driver scritto qui
(#531, coperta da D3 dal 2026-08-24), **due aspettavano un blocco che non
esisteva più** — #471 ferma su una PR mergiata da 18 giorni, #714 in attesa di
un probe live il cui workflow risponde 404 — cinque aspettavano misure di
produzione che nessuno stava producendo, e dieci erano difetti tecnici puri.
Il parcheggio non scade da solo: quando la condizione di sblocco svanisce,
nessun meccanismo se ne accorge. Chi scrive `blocked:` scriva anche **come si
verifica che il blocco valga ancora**.

Chi lo legge: il fixer (`issue-fix.yml`), il decompositore (`issue-decompose.yml`),
lo sweep delle `needs-human` (`needs-human-sweep.yml`), il reviewer, il growth
report, e qualunque sessione interattiva. Regola d'uso: **quando un driver copre
la decisione, si decide e si procede, citando il driver nel body della PR o nel
commento**.

Dal 2026-08-24 (istruzione diretta del proprietario) NON esiste più una lista di
categorie riservate all'umano: la sezione «Sempre umano» che stava qui, e che
per un mese ha coperto LPD, denaro, invii massivi, ritiro editoriale, scope
prodotto e infrastruttura irreversibile, è stata rimossa in blocco — vedi la
riga del 2026-08-24 nel registro sotto. `needs-human` resta per i soli blocchi
di CAPACITÀ reale (credenziale mancante, scope insufficiente, causa non
trovata): non più per categorie di decisione.

## Missione e north-star

frontaliereticino.ch è il riferimento per chi lavora (o vuole lavorare) in
Svizzera vivendo in Italia: lavoro, salari, permessi, fisco, notizie. Le metriche
che contano, in ordine: **traffico organico** (GSC click), **revenue
pubblicitaria** (Ad Manager/AdSense RPM×impression), **funnel email** (iscritti
attivi e conversioni), **qualità del dato** (job reali, contenuti accurati).
Crescono insieme o non crescono: contenuto scadente = traffico che non torna.

## Ordine di valore (a parità di altro, si lavora prima ciò che sta più in alto)

1. Produzione rotta o main rosso (blocca tutto il resto).
2. Revenue: monetizzazione mai degradata (AdSense Auto Ads MAI disabilitati —
   AGENTS.md #7; CMP/consenso funzionanti).
3. SEO organico: indicizzazione, CWV, contenuti che rankano.
4. Qualità del dato: job veri, traduzioni corrette, niente contenuto fabbricato.
5. Stabilità del ciclo autonomo (il meccanismo che ripara tutto il resto).
6. UX e feature nuove.

## Driver di decisione autonoma

- **D1 — Reversibile+misurato+osservato = procedi.** Una modifica reversibile,
  con la misura prima/dopo dichiarata e un osservatore (test/gate) che impedisce
  il ritorno del difetto, si fa in autonomia. Non si chiede il permesso per ciò
  che una PR successiva può annullare.
- **D2 — La misura si corregge, la soglia no.** Gate rosso = prima domanda «la
  misura è giusta?». Se la misura sbaglia si corregge la misura; se è giusta si
  corregge la causa. MAI alzare/abbassare soglie per far passare (AGENTS.md #1,
  con l'unica eccezione delimitata del corpus riassemblato, owner 2026-08-20).
- **D3 — La pipeline si corregge in automatico; il ritiro editoriale è una
  scelta fra versioni legittime, non più riservata.** Un difetto sistemico di
  generazione si fixa alla fonte in autonomia. Dal 2026-08-24 anche il
  ritiro/riscrittura di articoli già pubblicati si decide in autonomia — era
  l'ultima voce di «Sempre umano» (rimossa) che D3 citava: documenta il criterio
  di scelta nel body della PR, così la decisione resta verificabile a posteriori
  anche senza approvazione preventiva.
- **D4 — Quota Claude = risorsa condivisa e scarsa.** Ogni nuovo consumer di
  quota nasce con cap, kill-switch e telemetria. In conflitto, vince chi produce
  più valore per token: fix piccole con scheda > run esplorativi. La frugalità
  si ottiene per architettura (meno invocazioni), mai tagliando i turni sotto
  la soglia che tronca il lavoro.
- **D5 — Un'issue grande si scorpora, non si parcheggia.** Lo stadio di
  decomposizione (ISSUES.md → «Stadio di decomposizione») è il percorso di
  default per tutto ciò che non sta in un run — comprese le decisioni di
  prodotto/business, dal 2026-08-24. `needs-human` è riservato ai soli blocchi
  di capacità reale.

  **Un SECONDO livello di scorporo è escluso, e la ragione è misurata
  (2026-09-04).** Il drainer manda in `needs-human` le `from-decompose` che
  esauriscono il turn-budget, perché `isDecomposeEligible` esclude
  `from-decompose` e `decomposed:1`: sembra un pozzo da tappare ammettendo la
  profondità 2. Non lo è. Su 253 issue del sito con un verdetto `FIX_OUTCOME`
  aggiornate dal 2026-08-25, il tasso di `max-turns` è **41,4%** (55/133) sulle
  issue mai scorporate e **45,3%** (43/95) su quelle `from-decompose` — z=0,59,
  cioè indistinguibili; `decomposed:1` sta al 32,0% (8/25). Una sub-issue nata
  dallo scorporo muore per turn-budget quanto una issue intera, quindi la
  dimensione non è il driver: `max-turns` è il 42% di TUTTI i verdetti (106/253)
  a ogni dimensione. Chi vuole abbassare quel tasso guardi il volume dell'output
  e il prompt, non la granularità della issue.

  E il collo di bottiglia di `needs-human` non è nemmeno lo scorporo: è
  l'USCITA. Il pre-pass deterministico drena solo le famiglie che riconosce —
  misurato in produzione lo stesso giorno, `requeue=6 decompose=2 keep=41` — e
  le `keep` passano da un run Claude settimanale con cap 15. Allargare il
  riconoscimento del pre-pass costa zero quota (D4) e scala; un altro run Claude
  no. Lavoro scorporato in issue **#7280**.
- **D6 — Famiglie, non istanze.** Se la stessa fix si sta applicando alla
  N-esima istanza (allowlist che cresce, timeout alzato di nuovo, stessa entry
  ripetuta), la N-esima PR DEVE aggredire la causa di famiglia o aprire
  un'issue-contenitore che la decompone. Misurato: 9 issue `crawler-health` in
  4 giorni chiuse una a una con entry di allowlist mentre la fix strutturale
  esisteva già; 8 PR di bump-timeout in 6 giorni sulla stessa causa (Checkout).
- **D7 — Modelli LLM: free-tier prima.** La catena preferisce i provider
  gratuiti; il rung a pagamento esiste solo dove già approvato dal proprietario
  (#4495, Cloud Functions). Roster e breaker si aggiornano in autonomia.
- **D8 — Il gemello si porta nello stesso giro.** Fix su file `identical` (vedi
  `loop-sync-manifest.json` nel corpus): la fix nasce sul sito e la discesa al
  corpus è parte dello stesso task, non un follow-up opzionale. 8 issue
  «gemello non portato» aperte sono debito del ciclo, non backlog nuovo.
- **D9 — Gate SEO "nice-to-have": NON si stringe la baseline quando il dato
  migliora; il gate diventa advisory, non blocking.** Owner instruction
  2026-08-25 (registro sotto, issue #5983), **corretta lo stesso giorno**: la
  prima lettura di questa istruzione era al contrario — leggeva "rendiamo le
  baseline più ampie" come «stringi il ratchet quando l'offender count cala»,
  e ha fatto quasi partire un rebaseline che tighteniva `text-html-ratio`
  6912→2562 e `max-bfs-depth` 26398→11108. Il proprietario ha fermato
  l'esecuzione: "più ampie" significa **larghe/permissive**, l'opposto di
  stringere. Un gate di content quality che misura un'euristica opportunistica
  non richiesta da Google come requisito di indicizzazione/ranking (es.
  text-to-html ratio, profondità BFS — non uno structured-data field
  mandatory, non un errore di markup, non un 404/redirect rotto) **non va
  ottimizzato/ristretto ogni volta che il dato migliora** — quel ratchet è
  esattamente il meccanismo che rende il gate via via più severo su una metrica
  che a Google non interessa. La direzione giusta non è "quando migliora,
  stringi in autonomia": è **rendere il gate stesso advisory** (report, non
  `publish`-blocking) — lavoro scorporato in issue #6462, che è la vera resa di
  questo driver. Nel frattempo, un'issue "possible rebaseline opportunity" su
  un gate nice-to-have si chiude **senza toccare il file di baseline** (resta
  quello attuale, anche se largo), citando questo driver — mai `npm run
  audit:*:rebaseline` in autonomia solo perché il dato è migliorato. Restano a
  tolleranza zero e MAI autonomi: qualunque gate che verifica dati/markup
  effettivamente richiesti da Google (structured data mandatory,
  canonical/hreflang, status code), e qualunque REGRESSIONE (`current >
  baseline`) — quella resta sempre root-cause-first (D2, invariato).

## Sempre umano — RIMOSSA (2026-08-24)

Fino al 2026-08-24 questa sezione elencava sei categorie riservate a una
decisione esplicita del proprietario prima che il ciclo potesse agire: dati
personali/LPD, denaro, invii massivi, ritiro editoriale, espansione di scope
del prodotto, infrastruttura irreversibile. Il proprietario ha revocato la
riserva IN BLOCCO con istruzione diretta (registro sotto, riga 2026-08-24):
nessuna di queste categorie richiede più un'approvazione prima di procedere.

Resta il testo originale, perché il registro sbagliato è peggio di nessun
registro (vedi «Manutenzione»), e perché sapere COSA era gated aiuta a leggere
le PR più vecchie che lo citavano:

> Dati personali e LPD: qualunque azione su dati di utenti reali (cancellazioni
> di massa, campagne di re-permission, purge di log con PII, cambi alle regole
> di consenso). Denaro: spese nuove, upgrade di piani, quote a pagamento,
> contratti. Invii massivi: email/notifica a più di un pugno di utenti reali
> fuori dagli automatismi già approvati. Ritiro editoriale: rimozione/
> riscrittura di contenuti già pubblicati fra versioni legittime. Espansione di
> scope del prodotto: nuovi paesi, nuovi domini, nuove verticali. Infrastruttura
> irreversibile: cancellazioni di repo/branch protetti, rotazioni di
> credenziali, deploy di indici/regole su produzione Firebase.

Cosa resta invariato, perché non è mai stato parte di questa sezione:

- La **rotazione** delle credenziali resta una scelta specifica già presa
  (declinata il 2026-08-18: PAT e Gemini key restano) — non una categoria
  riservata. Una rotazione futura la valuta chi la propone sui suoi meriti,
  come qualunque altra PR, non più bloccata a monte.
- Il gate `## LGTM` del reviewer su OGNI PR resta. Rimuovere l'approvazione
  preventiva non rimuove la revisione: la scrutina lo stesso ciclo che scrutina
  tutto il resto, e un finding rosso ferma il merge come sempre.
- I vincoli tecnici non-negoziabili di AGENTS.md (mai disabilitare Auto Ads,
  mai committare path/email personali, ecc.) non sono decisioni di business:
  restano regole di igiene del codice, invariate.

## Decisioni del proprietario già prese (NON ri-chiedere)

Il registro completo, mantenuto verbatim, è in [`DECISIONS.md`](DECISIONS.md). Il workflow `issue-fix.yml` lo inietta nel prompt dell'agente prima che inizi a lavorare, entro il limite dichiarato di 12 KiB.

Prima di parcheggiare per «decisione del proprietario», cerca nei commenti:

```bash
gh api repos/<owner>/<repo>/issues/<n>/comments --paginate \
  -q '.[]|select(.body|test("Decision[ei] del proprietario|proprietario ha (deciso|scelto)|NON si fa"))|.body[0:200]'
```

## Decisioni RICHIESTE — sezione svuotata (2026-08-24)

Le 7 decisioni che stavano qui — #6280, #6173, #4854, #6227, #5926, #5928,
#5995 — sono state prese tutte lo stesso giorno; ogni riga è nel registro in
`DECISIONS.md`
con la data 2026-08-24. Non è rimasto niente in questa sezione perché non c'è
più un meccanismo che vi aggiunga voci: «Sempre umano» è rimossa, quindi la
prossima issue candidata a finire qui non esiste (vedi la sezione ritirata
sopra per cosa copriva).

Questa sezione resta come intestazione, non come promemoria vuoto: se in futuro
la lista «Sempre umano» viene reintrodotta (parzialmente o in blocco), qui è
dove tornerebbero a comparire le decisioni aperte.

## Manutenzione di questo documento

Una decisione nuova del proprietario si AGGIUNGE al registro in `DECISIONS.md` nella stessa PR
che la applica (o via sweep settimanale). Una riga smentita si corregge, mai si
lascia: un registro sbagliato è peggio di nessun registro. Questo file non è nel
perimetro del compress-ratchet: resta comunque un registro, non un saggio.
