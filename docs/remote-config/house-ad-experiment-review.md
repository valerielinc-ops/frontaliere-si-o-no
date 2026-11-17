# Stato Remote Config e misure: house ads

Stato verificato il **17 novembre 2026**: gli esperimenti sono attivi nel
template Firebase **Server Remote Config versione 11**. Questa pagina registra
il rollout osservato; non è un template da caricare. Le modifiche future vanno
applicate al template server più recente, preservando ogni parametro estraneo
alla campagna.

## Parametri osservati

| Parametro | Default locale sicuro | Template server live |
| --- | --- | --- |
| `HOUSE_AD_CREATIVE_EXPERIMENT_ENABLED` | `false` | Default `false`; `true` nelle sei condizioni creative |
| `HOUSE_AD_CREATIVE_VARIANT` | `control` | Default `control`; varianti condizionali `control`, `time_saved`, `profile_match`, `in_control`, `swiss_work`, `next_chapter` |
| `HOUSE_AD_READER_SUBSCRIPTION_EXPERIMENT_ENABLED` | `false` | Default `true` |
| `HOUSE_AD_READER_SUBSCRIPTION_VARIANT` | `control` | Default `control`; `subscription` nel segmento di trattamento |

## Assegnazione live

Le sei condizioni creative condividono il seed `house_creatives_v2` e coprono
intervalli di pari dimensione. `control` è un braccio su sei, non un holdout del
50%; gli altri cinque bracci testano messaggi e immagini diversi.

| Condizione | Intervallo | Variante |
| --- | --- | --- |
| `house_ad_variant_control_v2` | fino a circa 16,67% | `control` |
| `house_ad_variant_time_saved_v2` | circa 16,67–33,33% | `time_saved` |
| `house_ad_variant_profile_match_v2` | circa 33,33–50% | `profile_match` |
| `house_ad_variant_in_control_v2` | circa 50–66,67% | `in_control` |
| `house_ad_variant_swiss_work_v2` | circa 66,67–83,33% | `swiss_work` |
| `house_ad_variant_next_chapter_v2` | circa 83,33–100% | `next_chapter` |

Il test `reader_subscription_house_v1` è indipendente e divide il pubblico
assegnato in `control` e `subscription` al 50/50. La condizione live si chiama
`reader_subscription_v1_treatment_50pct`; il valore predefinito copre il
controllo. La valutazione di 5.000 UUID sintetici contro il template v11 ha
prodotto 2.528 assegnazioni control e 2.472 subscription, compatibili con il
rollout previsto.

L’endpoint server `getHouseAdCreativeAssignment` usa il Server Remote Config e
non espone il template al browser. L’ID first-party viene creato solo dopo
`analyticsAllowed()`, resta in local/session storage e non viene inviato a
GA4 o PostHog. Se Firebase non risponde, i default locali mantengono la
creatività `control` non arruolata.

La scheda subscription si applica solo agli utenti anonimi senza entitlement
no-ads, se sono disponibili almeno due frame publisher-owned contigui nello
stesso blocco esplicito. Il trattamento usa un solo frame e non copre annunci
Google riempiti. La creatività lavoro usa il ruolo, il luogo e il settore
pubblici strutturati della pagina job detail/filter; non usa nome utente, IP o
testo libero di ricerca.

## Risultati assestati

Il readout GA4 e Firestore del **19 ottobre–15 novembre 2026** contiene:

- Campagna house ads: 12.532 impression, 49 clic e 48 landing; CTR complessivo
  osservato 0,39%.
- `house_creatives_v2`, solo utenti arruolati:

| Variante | Impression | Clic | CTR osservato |
| --- | ---: | ---: | ---: |
| `control` | 1.566 | 6 | 0,38% |
| `time_saved` | 1.720 | 10 | 0,58% |
| `profile_match` | 1.681 | 6 | 0,36% |
| `in_control` | 1.834 | 3 | 0,16% |
| `swiss_work` | 1.631 | 6 | 0,37% |
| `next_chapter` | 1.820 | 2 | 0,11% |
| **Totale test** | **10.252** | **33** | **0,32%** |

`time_saved` guida questo campione di clic, ma 33 clic complessivi non bastano
per dichiarare una variante vincente o inferire acquisti. Nel ledger compare un
ordine avviato attribuito a `swiss_work`, nessun acquisto pagato confermato e
nessun rimborso.

Il test subscription ha registrato 1.462 eventi di esposizione (1.402 utenti):
761 nel controllo e 701 nel trattamento. Il trattamento ha 713 impression della
scheda e zero clic; il controllo ha due clic dell’esperimento. Non risultano
abbonamenti pagati attribuiti.

## Telemetria dopo il deploy

Il nome evento `reader_subscription_experiment_impression` superava il limite
GA4. Il commit `889b55523953` del 16 novembre lo ha abbreviato in
`reader_sub_experiment_impression`. Il bundle pubblico `1794895965349` contiene
il nome breve. Il report assestato sopra termina il 15 novembre e quindi non
può includerlo; una query GA4 provvisoria per il 17 novembre ha già restituito
42 impression e 36 utenti. L’evento è attivo: la sua assenza nella finestra
precedente era dovuta alla data, non a un mancato invio.

GA4 assesta i dati con due giorni di ritardo. Per misurare un nuovo deploy usare
il readout non appena la giornata entra nella finestra assestata; eventuali
query intraday sono provvisorie.

## Esposizione e acquisti

- L’esperimento subscription richiede consenso analytics, anonimato e un blocco
  esplicito con almeno due slot fallback consecutivi.
- Le impression sono contate dopo visibilità del 50% per un secondo continuo;
  clic, landing e impression della scheda subscription restano eventi distinti.
- La conversione del servizio di ricerca lavoro è un acquisto verificato nel
  ledger (`paymentStatus=paid` e `paidAt`); rimborsi restano separati. Avvio del
  checkout, clic e visite non sono acquisti.
- L’acquisto dell’abbonamento lettori è separato e richiede `firstPaidAt` Stripe.
- Il readout aggregato resta in sola lettura e rifiuta righe GA4 troncate,
  thresholded o aggregate in `Other`.
