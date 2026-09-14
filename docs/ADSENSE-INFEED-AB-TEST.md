# Test AdSense in-feed sulle liste lavoro

## Obiettivo

Misurare se la rimozione degli annunci manuali in-feed dalle liste lavoro
migliora i ricavi per pageview senza peggiorare engagement o Core Web Vitals.
AdSense Auto Ads (anchor, vignette e in-page automatici) resta sempre attivo.

## Esperimento attivo

| ID | Controllo | Trattamento | Attivazione |
|---|---|---|---|
| `svizzera-ticino` | `/cerca-lavoro-svizzera/` | `/cerca-lavoro-ticino/` | deployment della modifica richiesta il 2026-09-01; primo giorno completo conservativo 2026-09-03 |

Il solo trattamento attivo è Ticino (`TI`). La decisione vive soltanto in
`INFEED_AD_AB_TEST_SUPPRESSED_CANTONS` dentro `services/adsenseSlots.ts`; il
controllo nazionale e tutte le altre liste mantengono la cadenza manuale
esistente. La coppia Basilea/Lucerna è una serie chiusa: non viene cancellata
né interrogata dal report attivo.

## Confine hub/sotto-URL

Il report attivo usa una sola coppia e nessun valore storico della serie chiusa
viene sommato al suo cumulativo.

- `svizzera-ticino` usa la dimensione AdSense `PAGE_URL` e confronta i due URL
  canonici completi. Le pagine come `/cerca-lavoro-ticino/infermieri/`, le
  singole offerte e qualsiasi altro sotto-URL non entrano nel campione.
- GA4, PostHog e CrUX usano sempre il pathname esatto indicato nella tabella.

## Monitoraggio

Il workflow `.github/workflows/adsense-format-ab-report.yml` gira ogni lunedì e
lancia `scripts/adsense-format-ab-report.mjs` per la coppia attiva:

```bash
node scripts/adsense-format-ab-report.mjs --experiment svizzera-ticino --save --markdown
```

Le righe del formato corrente in `data/adsense-format-ab-history.jsonl` portano
`experimentId` e `adsenseDimension`. Le due righe legacy del 25 e 31 agosto
ricevono soltanto il backfill di `experimentId: basilea-lucerna`; la riga del 7
settembre lo aveva già. Una riga priva di `experimentId` non eredita il default
e non viene conteggiata in nessun esperimento. Le finestre interamente precedenti o miste
pre/post trattamento sono mostrate come baseline ma non vengono aggiunte al
cumulativo post-trattamento.

### Obiettivo di volume

Ogni lato dell'esperimento attivo ha un obiettivo cumulativo dichiarato di
4000 pageview post-trattamento. Finché almeno un lato è sotto obiettivo, il
Markdown pubblica soltanto una riga di avanzamento (`campione X/4000 controllo
· Y/4000 trattamento — nessuna lettura`) e non presenta tabelle o delta
descrittivi. La raccolta AdSense/GA4/PostHog/CrUX e l'append allo storico
restano invariati; raggiunto il target su entrambi i lati, tornano le tabelle
complete e i guardrail.

Il report mostra:

- AdSense: impressioni, pageview, ricavi in EUR, RPM, coverage e ricavi per
  pageview;
- GA4: sessioni, durata, engagement rate, bounce rate e pageview/sessione;
- Core Web Vitals: GA4, poi PostHog, poi CrUX come fallback best-effort.

Le due pagine di ogni coppia hanno audience e RPM di partenza differenti. Il
delta settimanale è descrittivo: una decisione richiede lo storico di ciascun
lato e non un confronto diretto dopo una singola settimana.

## Arresto del trattamento

Per interrompere il trattamento si rimuove soltanto il relativo codice (`TI`)
da `INFEED_AD_AB_TEST_SUPPRESSED_CANTONS`. Non si disabilitano Auto Ads e non
si modificano la cadenza o i limiti delle altre liste.
