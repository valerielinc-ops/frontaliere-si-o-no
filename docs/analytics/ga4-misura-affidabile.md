# Misura affidabile: key event GA4 e valore delle landing

Stato al 2026-10-24. Proprietà GA4 `properties/524485296` (stream web
`G-LGJ9LE360F`). Tutte le cifre sono della GA4 Data API, finestra 28 giorni
settled salvo dove indicato, e si rimisurano con i comandi riportati.

## 1. Key event

Fino al 2026-10-24 l'unico key event della proprietà era `purchase`, che il sito
non emette: ogni «tasso di key event» di GA4 leggeva zero. La lista voluta vive
nel codice, in `scripts/ga4-key-events.mjs` (`KEY_EVENT_SPECS`), e lo script la
applica:

```bash
GOOGLE_APPLICATION_CREDENTIALS=~/.config/frontaliere/sa-frontaliere-ticino.json \
  node scripts/ga4-key-events.mjs            # piano, non cambia niente
  node scripts/ga4-key-events.mjs --apply    # crea solo i mancanti già presenti nei dati
```

Contratto: crea un key event solo se l'evento ha `eventCount > 0` negli ultimi
28 giorni, non cancella e non modifica nulla (un `countingMethod` diverso viene
segnalato come `counting_mismatch`).

| Evento | Conteggio | Valore | Eventi 28 gg | Stato |
|---|---|---|---:|---|
| `job_apply_handoff` | una volta per evento | candidatura: redirect al sito/ATS del datore (`trackJobApplyHandoff`) | 1.794 | creato 2026-10-24 |
| `simulation_complete` | una volta per sessione | uso del calcolatore (`trackCalculation`); si ripete a ogni ricalcolo, quindi conta la sessione | 37.942 | creato 2026-10-24 |
| `job_alert_created` | una volta per evento | iscrizione agli avvisi di lavoro (`trackJobAlertCreated`) | 277 | creato 2026-10-24 |
| `newsletter_subscribe` | una volta per evento | iscrizione newsletter (solo `action=subscribe`) | 0 | in attesa: l'evento non esiste ancora; lo script crea il key event quando compare nei dati |
| `login` | una volta per sessione | login riuscito (evento GA4 raccomandato, su `auth_success` del gate annunci) | 0 | in attesa, come sopra |
| `purchase` | una volta per evento | preesistente, mai emesso | 0 | lasciato com'è |

Non marcati, per scelta (motivo anche in `KEY_EVENT_EXCLUSIONS`):

- `generate_lead`: porta `value` = stipendio lordo in CHF. Come key event GA4
  lo sommerebbe come valore di conversione (decine di migliaia di «CHF» per
  sessione). Il valore che rappresenta è già coperto da `simulation_complete`.
- `job_apply`: è il click su «candidati» prima del gate; nello stesso percorso
  precede `job_apply_handoff`, marcarli entrambi conterebbe due volte la stessa
  candidatura.
- `newsletter`: evento multi-azione (`subscribe` 1.852, `confirm` 156,
  `subscribe_attempt` 41, `error` 20): sostituito da `newsletter_subscribe`.
- `job_auth_funnel`: multi-step, `gate_view` è il 92% degli eventi: sostituito
  da `login`.
- `google_jobs_apply` non è un evento ma una sorgente
  (`utm_source=google_jobs_apply`, medium `organic`, 4.288 sessioni, canale
  Organic Search): entra nel report del valore delle landing.

## 2. Traffico automatico

### Cosa c'è nei dati

| Segmento | Sessioni 28 gg | Engagement | Key event | Note |
|---|---:|---:|---:|---|
| 1280x1200 · Windows · Chrome · English, Singapore | 105.999 | 6% | 0 | raffica 2026-09-26 → 10-01 (72k il 28/09), poi ferma |
| 1600x1600 · Windows · Chrome · Chinese, Cina | 10.946 | 6% | 0 | continua, 140-690 sessioni al giorno |
| stessa firma 1280x1200 da altri paesi | 33 | — | 0 | nessuna da Italia o Svizzera |

Il primo segmento è l'80% del canale Direct (133k) e metà della proprietà:
senza escluderlo, sessioni, engagement e ogni tasso per sessione sono per metà
bot. Comando di verifica: il report `screenResolution × country × browser ×
language` con filtro `sessionDefaultChannelGroup = Direct`.

### Esclusione nei report

`scripts/lib/ga4-automation-fleet.mjs` definisce le due firme e aggiunge
l'esclusione, in AND col filtro esistente, al body di una chiamata della GA4
Data API (`withAutomationFleetExclusion`) o alle opzioni di un `fetch`
(`withAutomationFleetExclusionForFetch`, che riscrive solo `:runReport` e
`:batchRunReport`). Oggi la usa `scripts/landing-value-report.mjs`. Il gate lato
client e l'esclusione negli altri report hanno un proprietario separato.

## 3. Valore delle landing per template

`scripts/landing-value-report.mjs` rende riproducibile il confronto «una landing
annuncio vale N articoli». Gira ogni lunedì nel workflow `Weekly Analytics
Report` (`.github/workflows/analytics.yml`, step *Measure landing value by
template*), scrive `reports/landing-value-by-template.json` nell'artifact e la
tabella nel summary del run.

```bash
GOOGLE_APPLICATION_CREDENTIALS=~/.config/frontaliere/sa-frontaliere-ticino.json \
  node scripts/landing-value-report.mjs [--days 28] [--channel organic|all] [--apply-value <n>] [--json] [--out <file>]
```

Modello: `valore/sessione = ricavo ads/sessione + candidature/sessione × valore
candidatura`. Il ricavo è `totalAdRevenue` (AdSense collegato) attribuito alla
landing della sessione; la candidatura è `job_apply_handoff`; il valore di una
candidatura è, per default, il ricavo medio di un clic ads nella stessa
finestra (ipotesi prudente, sovrascrivibile). Popolazione: `hostName =
frontaliereticino.ch`, canale Organic Search, flotte escluse. Template da
`classifyAnalyticsPath()`; l'indice 1× è `article_detail`.

Prima lettura (2026-09-25 → 2026-10-22, valuta EUR, valore candidatura 0,118):

| Template | Sessioni | Candidature/100 | Clic ads/100 | Valore/sess | Indice |
|---|---:|---:|---:|---:|---:|
| jobs_sector (professione) | 2.470 | 4,09 | 22,75 | 0,0278 | 8,9× |
| jobs_company (azienda) | 672 | 2,53 | 15,33 | 0,0192 | 6,2× |
| jobs_index | 1.082 | 2,87 | 12,94 | 0,0173 | 5,5× |
| job_detail (annuncio) | 12.940 | 3,82 | 8,60 | 0,0168 | 5,4× |
| jobs_search | 5.036 | 1,99 | 11,64 | 0,0124 | 4,0× |
| generic_page | 8.907 | 0,68 | 6,37 | 0,0087 | 2,8× |
| article_detail | 4.546 | 0,04 | 2,31 | 0,0031 | 1× |

`generic_page` raccoglie landing che il classificatore non riconosce
(`/lavoro-ticino-*`, `/concorsi-pubblici-*`, articoli della sezione svizzera):
il JSON riporta per ogni template le cinque landing principali (`topLandings`).
