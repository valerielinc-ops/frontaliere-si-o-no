# Test copy della candidatura assistita

## Obiettivo

Misurare quale messaggio porta più persone a iniziare il percorso a pagamento
da 0,99 € dopo aver aperto l'offerta **«Vuoi delegare questa candidatura?»**.
Il test cambia solo titolo e descrizione; prezzo, pulsanti, passaggi, consenso,
trasparenza e destinazione restano uguali.

## Quattro varianti

| Arm | Angolo | Ipotesi |
|---|---|---|
| `control` | delega diretta | Il messaggio oggi in produzione è il riferimento. |
| `time_saved` | tempo | Rendere esplicito il tempo risparmiato aumenta la scelta a pagamento. |
| `portal_relief` | meno lavoro sul portale | La gestione del portale è il principale attrito percepito. |
| `handled_for_you` | servizio gestito | Una promessa concreta di presa in carico chiarisce il valore. |

L'assegnazione è sticky per un identificativo anonimo del browser e, con
Remote Config impostato su `auto`, usa quattro bucket deterministici del 25%.
Il default locale è `control`; un valore armato (`control`, `time_saved`,
`portal_relief` o `handled_for_you`) forza un braccio per QA o per una pausa
controllata. Il parametro pubblico è
`ASSISTED_APPLICATION_COPY_VARIANT`.

## Misurazione

Gli eventi restano nel funnel Firebase Analytics dell'esperimento
`assisted-application-v2` e aggiungono:

- `copy_experiment_id: assisted-application-copy-v1`;
- `copy_variant`, presente dall'impressione fino al pagamento, al consenso,
  all'upload e alla coda manuale.

Per rendere la segmentazione utilizzabile nei report GA4 senza consumare altri
event-scoped custom dimensions (il limite EVENT è già esaurito), attorno a ogni
evento di candidatura assistita assegnato si impostano due user properties
low-cardinality e non personali; vengono cancellate subito dopo l'evento e
prima degli eventi fuori dal test, così non contaminano altri percorsi sullo
stesso client Analytics:

- `aa_copy_experiment` = `assisted-application-copy-v1`;
- `aa_copy_variant` = `control`, `time_saved`, `portal_relief` oppure `handled_for_you`.

Le due definizioni GA4 sono USER-scoped. Il dry-run, che è il default, è:

```bash
node scripts/experiments/assisted-application-copy-ga4.mjs
```

La registrazione è una modifica amministrativa durevole: eseguire
`--apply` solo dopo aver verificato property, scope e nomi nel dry-run. Per il
readout, dopo la registrazione:

```bash
node scripts/analytics/assisted-application-copy-readout.mjs --days 28
```

Il report usa utenti unici per evento e mostra gli eventi secondari per
braccio; esclude le stesse firme di traffico automatico degli altri readout.
I rimborsi sono avviati dall'admin e non vengono attribuiti al browser del
candidato, quindi non compaiono nel readout copy per braccio e vanno controllati
separatamente come guardrail operativo.
Il rapporto checkout completati / offerte viste è descrittivo nella stessa
finestra, non una conversione di coorte rigorosa: persone esposte prima
dell'intervallo possono completare il checkout al suo interno. Per un confronto
cumulativo usa sempre la stessa data iniziale del test e un `--until` assestato.
La registrazione non retro-etichetta gli eventi passati. Nessun nome, email,
testo della candidatura o URL viene aggiunto alle user properties.

KPI primario: utenti unici con `checkout_completed` / utenti unici con
`assisted_application_offer_viewed` per braccio (rapporto descrittivo nella
finestra, non attribuzione rigorosa per singola coorte). KPI secondari: scelta del pagamento, abbandono dopo l'apertura del
checkout, consenso, upload del CV e candidatura messa in coda. Guardrail:
scelta del percorso gratuito, errori checkout/upload, rimborsi, blocchi e tempo
operativo.

Non si dichiara un vincitore con pochi dati: prima si controlla che i quattro
bracci abbiano esposizioni comparabili e si legge il risultato insieme ai
guardrail. Il test non modifica il testo legale, non garantisce un'assunzione e
non invia dati personali a Firebase Analytics.
