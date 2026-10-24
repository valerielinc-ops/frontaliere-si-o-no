# Misura affidabile: key event GA4, traffico automatico, valore delle landing

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
| `newsletter_subscribe` | una volta per evento | iscrizione newsletter (solo `action=subscribe`) | 0 | in attesa: evento nuovo, emesso dalla PR client; lo script lo crea quando compare nei dati |
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

### Lato client (PR concatenata)

Il client riconosce già la flotta 1280x1200 (`matchesAutomationScreenSignature`
in `services/botPatterns.ts`) e la tiene fuori da AdSense e PostHog, ma GA4 non
era sotto lo stesso gate: né `gtag-init.js` delle pagine statiche né
l'inizializzazione di Firebase Analytics nella SPA consultavano
`isLikelyBot()`/`BOT_GATE_FN`. La PR client mette entrambi sotto il gate
condiviso (stesso verdetto di AdSense e PostHog, e di `isCrawlerVisitorAgent`
per i crawler dichiarati).

### Lato edge (valutato, non applicato)

Una regola Cloudflare per IP/ASN non è stata applicata, per scelta:

- la zona è sul piano che non espone `clientAsn` nelle analytics GraphQL
  (`does not have access to the field 'clientasn'`), quindi l'ASN della flotta
  non è misurabile e una regola per ASN sarebbe cieca;
- l'alternativa disponibile, la nazione, bloccherebbe o sfiderebbe anche le
  persone reali da Singapore e Cina, e la flotta esegue JavaScript (manda
  `page_view`, `ui_interaction`, `web_vitals`): un `managed_challenge` non è una
  barriera certa per un Chrome headless;
- il ruleset custom è al tetto di cinque regole (`MAX_CUSTOM_FIREWALL_RULES` in
  `scripts/cf-locale-failover-setup.mjs`), con la regola che lascia passare
  Googlebot, Bingbot e i crawler AI ammessi in `robots.txt`: aggiungerne una
  significa toccare quell'equilibrio per un segmento che non costa ricavi (la
  flotta non riceve annunci, è già sotto il bot gate di AdSense).

Il filtro più sicuro è quindi quello lato client (non manda la misura) più
quello lato report (toglie lo storico e qualunque flotta che passi il client).

### Lato report

`scripts/lib/ga4-automation-fleet.mjs` definisce le due firme e aggiunge
l'esclusione, in AND col filtro esistente, a ogni chiamata della GA4 Data API di:

- `scripts/analytics-report.mjs` (tutte le chiamate `:runReport` e
  `:batchRunReport`; Search Console, PageSpeed e Bing passano invariati), con
  la nota `excludedSegment` nel JSON;
- `scripts/conversion-funnel-report.mjs`;
- `scripts/user-value-report.mjs`;
- `scripts/landing-value-report.mjs` (sotto).

Effetto misurato su `analytics-report.mjs --ga4 --days 28` del 2026-10-24:
sessioni 208.088 → 92.242, utenti 183.095 → 71.777, bounce rate 65,3% → 28,8%. I monitor dei ricavi (`monitor-revenue-signals`,
`canary-user-value`, `monitor-deploy-skew`) filtrano già Italia+Svizzera
(`ga4-target-market.mjs`) e non ne hanno bisogno. La firma 1600x1600 è solo
lato report: per il client non c'è una regola, perché il fuso orario e la
versione di Chrome di quella flotta non sono misurati e una regola sul solo
schermo+lingua sarebbe più larga dell'evidenza.

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

## 4. PostHog: pageview

Le pageview PostHog si sono fermate il 2026-09-15/16 (14.063 il 14/09, 34 il
16/09) per una scelta esplicita, non per un guasto di init/consenso/router:
`POSTHOG_EVENT_SAMPLE_RATE = 0` in `services/posthogQuota.ts` (PR 8752,
«stop PostHog events after free quota exhaustion») scartava in `before_send`
ogni evento non esente, `$pageview` compreso, «finché il periodo non si
azzera». Il periodo si è azzerato, la costante no. Volumi misurati con HogQL:
prima dello stop ~200k eventi/giorno (6M/mese contro 1M di quota), di cui
`$pageview` ~10.5k/giorno; oggi ~2k eventi/giorno. La PR client esenta
`$pageview` dal campionamento a zero (≈ 315k/mese, sotto la quota insieme ai
~60k attuali) lasciando a zero il resto degli eventi di prodotto; PostHog resta
solo telemetria, nessun esperimento.
