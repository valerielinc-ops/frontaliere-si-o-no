# Proposta Remote Config: house ads

Stato: **proposta da revisionare; non pubblicata**.

Ho letto il template Server Remote Config attivo il 14 novembre 2026: versione
220, nessuna condizione e nessuno dei quattro parametri house ads. Questo file
descrive soltanto le aggiunte; **non è il template completo da pubblicare**.
Il template contiene altri parametri di produzione e va aggiornato preservando
integralmente quelli esistenti.

## Assegnazione proposta

Gli ID sono UUID first-party e vengono creati soltanto dopo il consenso
analytics. Firebase riceve l'ID per l'assegnazione stabile; il browser non
sceglie la variante. Senza consenso o se Firebase non risponde, il codice resta
sul controllo locale e non mostra l'esperimento subscription.

| Parametro | Default | Valori condizionali |
| --- | --- | --- |
| `HOUSE_AD_CREATIVE_EXPERIMENT_ENABLED` | `false` | `true` per `percent('ft_house_creative_v2') <= 100` |
| `HOUSE_AD_CREATIVE_VARIANT` | `control` | Valori per le sei condizioni di assegnazione sotto |
| `HOUSE_AD_READER_SUBSCRIPTION_EXPERIMENT_ENABLED` | `false` | `true` per `percent('ft_reader_subscription_v1') <= 100` |
| `HOUSE_AD_READER_SUBSCRIPTION_VARIANT` | `control` | `control` fino al 50%; `subscription` sopra il 50% |

## Condizioni da creare

| Condizione | Espressione | Valore del parametro variante |
| --- | --- | --- |
| `house_ad_creative_all` | `percent('ft_house_creative_v2') <= 100` | Attiva `HOUSE_AD_CREATIVE_EXPERIMENT_ENABLED` |
| `house_ad_creative_time_saved` | `percent('ft_house_creative_v2') <= 10` | `time_saved` |
| `house_ad_creative_profile_match` | `percent('ft_house_creative_v2') > 10 && percent('ft_house_creative_v2') <= 20` | `profile_match` |
| `house_ad_creative_in_control` | `percent('ft_house_creative_v2') > 20 && percent('ft_house_creative_v2') <= 30` | `in_control` |
| `house_ad_creative_swiss_work` | `percent('ft_house_creative_v2') > 30 && percent('ft_house_creative_v2') <= 40` | `swiss_work` |
| `house_ad_creative_next_chapter` | `percent('ft_house_creative_v2') > 40 && percent('ft_house_creative_v2') <= 50` | `next_chapter` |
| `house_ad_creative_control` | `percent('ft_house_creative_v2') > 50` | `control` |
| `house_ad_subscription_all` | `percent('ft_reader_subscription_v1') <= 100` | Attiva `HOUSE_AD_READER_SUBSCRIPTION_EXPERIMENT_ENABLED` |
| `house_ad_subscription_control` | `percent('ft_reader_subscription_v1') <= 50` | `control` |
| `house_ad_subscription_treatment` | `percent('ft_reader_subscription_v1') > 50` | `subscription` |

Le condizioni di ciascun seed coprono il 100% senza sovrapposizioni: il test
creatività assegna il 50% al controllo e il restante 50% in cinque varianti;
il test subscription è un 50/50 indipendente.

## Regole di esposizione

- L'esperimento subscription si applica solo a utenti anonimi, con analytics
  consentito e almeno due frame di fallback publisher-owned consecutivi nello
  stesso blocco esplicito.
- Nel trattamento compare una sola creatività subscription in quel blocco; gli
  altri frame mantengono la creatività per la ricerca lavoro. Non si coprono
  unità AdSense riempite.
- Il test delle creatività lavoro misura CTR e acquisto pagato del servizio
  cerca-lavoro. Il piano lettori senza pubblicità ha eventi e acquisto Stripe
  separati: i due ricavi non vanno sommati come la stessa conversione.
- La randomizzazione avviene solo dopo il consenso analytics; gli altri lettori
  continuano a ricevere il fallback lavoro non sperimentale.
- Non dichiarare un vincitore su un campione breve: il readout mostra impression,
  clic e acquisti verificati, ma prima serve osservare il volume e definire la
  soglia di confidenza/campione per le conversioni rare.

## Pubblicazione

Prima della pubblicazione, revisionare il rollout e applicare queste quattro
chiavi al template Server Remote Config corrente senza rimuovere o modificare
gli altri parametri. La pubblicazione resta separata da questa PR.
