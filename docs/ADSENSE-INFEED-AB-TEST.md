# Test AdSense in-feed sulle liste lavoro

## Obiettivo

Misurare se la rimozione degli annunci manuali in-feed dalle liste lavoro
migliora i ricavi per pageview senza peggiorare engagement o Core Web Vitals.
AdSense Auto Ads (anchor, vignette e in-page automatici) resta sempre attivo.

## Esperimenti attivi

| ID | Controllo | Trattamento | Attivazione |
|---|---|---|---|
| `basilea-lucerna` | `/cerca-lavoro-basilea/` | `/cerca-lavoro-lucerna/` | primo giorno completo 2026-08-26 |
| `svizzera-ticino` | `/cerca-lavoro-svizzera/` | `/cerca-lavoro-ticino/` | deployment della modifica richiesta il 2026-09-01; primo giorno completo conservativo 2026-09-03 |

I trattamenti sono quindi Lucerna (`LU`) e Ticino (`TI`). La decisione vive
soltanto in `INFEED_AD_AB_TEST_SUPPRESSED_CANTONS` dentro
`services/adsenseSlots.ts`; i controlli e tutte le altre liste mantengono la
cadenza manuale esistente.

## Confine hub/sotto-URL

I due esperimenti restano separati e nessun valore viene sommato fra coppie.

- `svizzera-ticino` usa la dimensione AdSense `PAGE_URL` e confronta i due URL
  canonici completi. Le pagine come `/cerca-lavoro-ticino/infermieri/`, le
  singole offerte e qualsiasi altro sotto-URL non entrano nel campione.
- `basilea-lucerna` conserva `URL_CHANNEL_NAME` per non interrompere la serie
  storica iniziata il 2026-08-25. Questi sono pattern di canale e possono
  includere sotto-URL: il report lo dichiara e non li presenta come pageview
  esatte dei soli hub.
- GA4, PostHog e CrUX usano sempre il pathname esatto indicato nella tabella.

## Monitoraggio

Il workflow `.github/workflows/adsense-format-ab-report.yml` gira ogni lunedì e
lancia `scripts/adsense-format-ab-report.mjs` una volta per coppia:

```bash
node scripts/adsense-format-ab-report.mjs --experiment basilea-lucerna --save --markdown
node scripts/adsense-format-ab-report.mjs --experiment svizzera-ticino --save --markdown
```

Ogni riga in `data/adsense-format-ab-history.jsonl` porta `experimentId` e
`adsenseDimension`. Le righe storiche prive di `experimentId` appartengono per
compatibilità a `basilea-lucerna`; il cumulativo del nuovo test parte da zero.
Le finestre interamente precedenti o miste pre/post trattamento sono mostrate
come baseline ma non vengono aggiunte al cumulativo post-trattamento.

Il report mostra:

- AdSense: impressioni, pageview, ricavi in EUR, RPM, coverage e ricavi per
  pageview;
- GA4: sessioni, durata, engagement rate, bounce rate e pageview/sessione;
- Core Web Vitals: GA4, poi PostHog, poi CrUX come fallback best-effort.

Le due pagine di ogni coppia hanno audience e RPM di partenza differenti. Il
delta settimanale è descrittivo: una decisione richiede lo storico di ciascun
lato e non un confronto diretto dopo una singola settimana.

## Arresto del trattamento

Per interrompere un trattamento si rimuove soltanto il relativo codice (`LU`
o `TI`) da `INFEED_AD_AB_TEST_SUPPRESSED_CANTONS`. Non si disabilitano Auto Ads
e non si modificano la cadenza o i limiti delle altre liste.
