# Riscrittura delle descrizioni degli eventi

## Contratto dati

I crawler possono avere il testo acquisito solo durante l’elaborazione. Prima
di scrivere una slice, `scripts/lib/crawl-checkpoint.mjs`:

1. aggiunge, solo quando `EVENT_DESCRIPTION_SOURCE_EXPORT_PATH` è valorizzato,
   un record JSONL al file privato fuori dal checkout;
2. calcola `sourceDescriptionHash` su testo Unicode normalizzato;
3. rimuove `description`, `descriptionByLocale` e gli eventuali campi di
   descrizione acquisita.

`data/events-description-rewrites.json` contiene esclusivamente testi prodotti
da noi. La chiave è `id::sourceDescriptionHash`; ogni voce conserva le quattro
lingue, `model`, `promptVersion` e `rewrittenAt`. L’assembler applica una voce
solo quando id e hash coincidono e tutte le quattro lingue sono valide. Nei due
dataset assemblati aggiunge anche `descriptionRewriteValidated: true`, un
marker tecnico senza testo che consente ai renderer di distinguere una hit
esatta della cache da un eventuale record legacy: ogni descrizione priva del
marker viene ignorata e ricade sul contenuto fattuale.

Anche i preview `--dry-run` dei crawler passano dal sanitizzatore prima di
essere stampati nei log: il testo acquisito non viene scritto in una slice,
nel dataset, nella cache di traduzione o nell’output di Actions.

Le cache storiche di traduzione non possono contenere chiavi
`description::`. Il gate `npm run validate:event-descriptions` controlla le
slice, entrambe le copie del dataset, la cache delle riscritture e la cache di
traduzione prima della suite CI.

## Validazione automatica

Il prompt versionato è `event-description-rewrite-v1` e il modello vincolante è
`gpt-5.6-luna` con reasoning effort `max`. Ogni lingua deve avere 2–3 frasi,
senza markup né linguaggio promozionale. Il validatore rifiuta:

- una sequenza normalizzata di almeno otto parole consecutive condivisa con
  una qualsiasi descrizione acquisita;
- numeri non presenti nel contesto fattuale o acquisito;
- sequenze di nomi propri multi-parola non presenti nel contesto;
- date, orari o coppie importo-valuta con un valore diverso dal contesto;
- output incompleto, con numero di frasi errato o con parole promozionali.

Un rifiuto ritenta solo gli eventi non validi, fino a tre tentativi per batch;
poi l’evento resta factual-only e torna nella coda.

## Workflow e quota

`.github/workflows/event-description-rewrite.yml` gira ogni tre ore e supporta
`workflow_dispatch`; il crawl schedulato può avviarlo automaticamente dopo un
esito riuscito (i crawl manuali dry-run non propagano il fan-out). Il limite è
24 eventi per run, 8 eventi per chiamata, 50.000 caratteri di input per
chiamata, 150.000 caratteri cumulativi di input per run, 180 secondi di timeout
per chiamata e tre tentativi massimi. Il broker Codex è seriale (`concurrency=1`)
per non competere con gli altri job; i retry usano backoff di 5/10 secondi
(cappato a 60 secondi); il testo acquisito resta in un artifact
Actions a breve conservazione e non viene mai passato a una PR dati.

La metrica pubblicata nel riepilogo della run è composta da chiamate Luna,
eventi accettati per chiamata, chiamate per ora, caratteri di input/output,
rifiuti e coda residua; le chiamate/ora includono anche il backoff di retry
osservato. Il contatore token/quota del piano OAuth non è esposto dalla
CLI/broker: non viene inventato, viene indicato esplicitamente come non
osservabile.

Il passaggio tra workflow usa un artifact cifrato con la chiave già protetta
`CODEX_AUTH_JSON`: il JSONL leggibile esiste solo nel filesystem temporaneo del
runner crawler e, dopo la decifrazione, nel filesystem temporaneo del runner
Luna. L’artifact non contiene testo in chiaro e non viene mai pubblicato sul
CDN. L’export iniziale e gli eventuali record rimasti senza crawl incrementale
sono nel solo oggetto Admin-SDK
`private-event-description-sources/backlog.jsonl` del bucket Firebase; le
regole Storage negano ogni accesso client e il workflow lo legge in un file
temporaneo con permessi 0600.

La prima esecuzione locale del 2026-10-06 ha elaborato 200 candidati: 206
chiamate, 169 riscritture accettate, 31 rifiuti, 131 retry e 7 errori di
trasporto. Ha prodotto 774.536 caratteri di input e 266.521 di output in
2,6401 ore osservate (backoff incluso): 78,03 chiamate/ora e 0,82 riscritture
per chiamata. Il contatore token/quota OAuth è rimasto non osservabile.

Non esiste un interruttore sperimentale: questa è una policy di pubblicazione
deterministica, non un esperimento di prodotto, quindi non usa PostHog né
aggiunge un flag Firebase Remote Config.
