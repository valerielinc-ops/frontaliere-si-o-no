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

Gli eventi originali restano intatti nel funnel Firebase Analytics
`assisted-application-v2`. In parallelo, gli eventi chiave della candidatura
assistita emettono nomi dedicati `aa_copy_<fase>_<variante>`: per esempio
`aa_copy_exposure_time_saved` e `aa_copy_completed_time_saved`. Il nome evento
è una dimensione GA4 standard; così ogni conversione porta la variante nella
stessa emissione, senza user properties persistenti, nuove custom dimensions o
dipendenze dall'ordine asincrono tra chiamate Analytics. Sono tracciati
esposizione, completamento checkout e gli esiti secondari elencati nel
readout. I nomi sono low-cardinality e non contengono dati personali.

Readout:

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
Il readout non retro-etichetta eventi precedenti alla nuova strumentazione. Non
vengono aggiunti nomi, email, testo della candidatura o URL a GA4.

KPI primario: utenti unici con `aa_copy_completed_<variante>` / utenti unici
con `aa_copy_exposure_<variante>` (rapporto descrittivo nella finestra, non
attribuzione rigorosa per singola coorte). KPI secondari: scelta del pagamento,
abbandono dopo l'apertura del checkout, consenso, upload del CV e candidatura
messa in coda. Guardrail:
scelta del percorso gratuito, errori checkout/upload, rimborsi, blocchi e tempo
operativo.

Non si dichiara un vincitore con pochi dati: prima si controlla che i quattro
bracci abbiano esposizioni comparabili e si legge il risultato insieme ai
guardrail. Il test non modifica il testo legale, non garantisce un'assunzione e
non invia dati personali a Firebase Analytics.
