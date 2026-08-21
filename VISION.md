# VISION — driver di decisione del ciclo autonomo

Questo documento esiste per UNA ragione misurata: al 2026-08-21 il backlog contava
47 issue in `needs-human` — stato che nessun meccanismo riprendeva — e una parte
di quelle attese non erano decisioni vere ma decisioni GIÀ PRESE (registrate in
commenti sparsi) o questioni che un driver scritto avrebbe risolto da solo. Il
2026-08-14 era già stato misurato: 16 su 35 `needs-human` erano difetti tecnici
parcheggiati per sbaglio.

Chi lo legge: il fixer (`issue-fix.yml`), il decompositore (`issue-decompose.yml`),
lo sweep delle `needs-human` (`needs-human-sweep.yml`), il reviewer, e qualunque
sessione interattiva. Regola d'uso: **quando un driver copre la decisione, si
decide e si procede, citando il driver nel body della PR o nel commento**. Si
scala a umano SOLO ciò che la sezione «Sempre umano» riserva, o ciò che nessun
driver copre.

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
- **D3 — La pipeline si corregge in automatico, il contenuto pubblicato si
  ritira solo con decisione umana.** Un difetto sistemico di generazione si fixa
  alla fonte in autonomia; il ritiro/riscrittura di articoli già pubblicati è
  una scelta editoriale (vedi «Sempre umano»).
- **D4 — Quota Claude = risorsa condivisa e scarsa.** Ogni nuovo consumer di
  quota nasce con cap, kill-switch e telemetria. In conflitto, vince chi produce
  più valore per token: fix piccole con scheda > run esplorativi. La frugalità
  si ottiene per architettura (meno invocazioni), mai tagliando i turni sotto
  la soglia che tronca il lavoro.
- **D5 — Un'issue grande si scorpora, non si parcheggia.** Lo stadio di
  decomposizione (ISSUES.md → «Stadio di decomposizione») è il percorso di
  default per tutto ciò che non sta in un run. `needs-human` è riservato a ciò
  che «Sempre umano» elenca.
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

## Sempre umano (nessun driver può coprirlo)

- **Dati personali e LPD**: qualunque azione su dati di utenti reali
  (cancellazioni di massa, campagne di re-permission, purge di log con PII,
  cambi alle regole di consenso). Anche quando la fix tecnica è ovvia.
- **Denaro**: spese nuove, upgrade di piani, quote a pagamento, contratti.
- **Invii massivi**: qualunque email/notifica a più di un pugno di utenti reali
  fuori dagli automatismi già approvati (newsletter/alert esistenti).
- **Ritiro editoriale**: rimozione/riscrittura di contenuti già pubblicati
  quando la scelta è fra versioni legittime (es. quale duplicato ritirare).
- **Espansione di scope del prodotto**: nuovi paesi, nuovi domini, nuove
  verticali (es. estendere oltre l'Italia: #5374/#5375 — mai deciso).
- **Infrastruttura irreversibile**: cancellazioni di repo/branch protetti,
  rotazioni di credenziali (declinata il 2026-08-18: PAT e Gemini key restano),
  deploy di indici/regole su produzione Firebase.

## Decisioni del proprietario già prese (NON ri-chiedere)

| Data | Decisione | Fonte |
|---|---|---|
| 2026-07-05 | Auto-route su OGNI categoria; supervisione = gate `## LGTM`, non esclusione a monte | AGENTS.md → Issue automation |
| 2026-07-17 | Modello unificato claude-sonnet-5 per i tier del fixer (mai claude-sonnet-4-6) | issue-fix.yml → Tier |
| 2026-06-24 | Moratorium SEO landing RIMOSSO; posizione GSC solo informativa | AGENTS.md → Static SEO Pages |
| 2026-08-12 | Re-permission consensi: NON si fa, per ora | #5681 (commento 12-08) |
| 2026-08-13 | Avvisi di lavoro: cadenza a decadenza + soffitto 7 giorni; non spegnere in blocco | #5705 (commento 13-08 07:12) |
| 2026-08-14 | Le issue della famiglia job-alert si lasciano stare (incl. #5705, #5823 draft) | istruzione diretta, sessione 14-08 |
| 2026-08-13 | Publisher doppio sulla stessa coda: spento lo schedule del sito | #5794 → PR #5822 |
| 2026-08-13 | Quattro scelte LPD registrate | #5764 (commenti 13-08) |
| 2026-08-18 | Rotazione credenziali declinata (PAT e Gemini key restano) | sessione 18-08 |
| 2026-08-20 | Eccezione delimitata: i gate sul corpus RIASSEMBLATO misurano il tasso, non la perfezione storica | AGENTS.md #1 |

Prima di parcheggiare per «decisione del proprietario», cerca nei commenti:

```bash
gh api repos/<owner>/<repo>/issues/<n>/comments --paginate \
  -q '.[]|select(.body|test("Decision[ei] del proprietario|proprietario ha (deciso|scelto)|NON si fa"))|.body[0:200]'
```

## Manutenzione di questo documento

Una decisione nuova del proprietario si AGGIUNGE alla tabella nella stessa PR
che la applica (o via sweep settimanale). Una riga smentita si corregge, mai si
lascia: un registro sbagliato è peggio di nessun registro. Questo file non è nel
perimetro del compress-ratchet: resta comunque un registro, non un saggio.
