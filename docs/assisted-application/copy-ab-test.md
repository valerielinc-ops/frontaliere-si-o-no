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

KPI primario: `checkout_completed / assisted_application_offer_viewed` per
braccio. KPI secondari: scelta del pagamento, abbandono dopo l'apertura del
checkout, consenso, upload del CV e candidatura messa in coda. Guardrail:
scelta del percorso gratuito, errori checkout/upload, rimborsi, blocchi e tempo
operativo.

Non si dichiara un vincitore con pochi dati: prima si controlla che i quattro
bracci abbiano esposizioni comparabili e si legge il risultato insieme ai
guardrail. Il test non modifica il testo legale, non garantisce un'assunzione e
non invia dati personali a Firebase Analytics.
