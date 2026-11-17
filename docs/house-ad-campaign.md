# Creatività del servizio di ricerca lavoro

La campagna riempie i singoli spazi display del sito rimasti senza annunci con
creatività del servizio Frontaliere Ticino. Sostituisce il suggerimento
promozionale flottante. Google Auto Ads, CMP, Offerwall e rewarded restano
indipendenti; nessuna creatività viene inserita negli iframe o negli `ins` Google.

## Direzione e formati

Il controllo presenta «Lavoro in Svizzera? Lo cerchiamo noi per te.» e
«Troviamo le offerte adatte al tuo mestiere e prepariamo le candidature per te.».
La CTA è «Scopri come funziona». Nei formati bassi il messaggio viene abbreviato.
Il testo è HTML nativo: le fotografie non contengono lettering rasterizzato.
Nessuna promessa di assunzione; la comunicazione evita riferimenti ad AI,
automazione e candidature “su misura”.

| Variante | Fotografia | Promessa italiana estesa |
|---|---|---|
| control | Edilizia | Lo cerchiamo noi per te. |
| time_saved | Logistica | Cercare annunci richiede tempo. Ci pensiamo noi. |
| profile_match | Produzione | Troviamo offerte adatte al tuo mestiere. |
| in_control | Manutenzione | Non sai da dove iniziare? Ti aiutiamo noi. |
| swiss_work | Elettricista | Cerchiamo offerte in Svizzera per te. |
| next_chapter | Ospitalità | Meno ricerca di annunci. Più tempo per te. |

Quattordici fotografie originali GPT Image, una verticale e una panoramica per
ciascuna delle sette famiglie (commute, edilizia, elettricista, ospitalità,
logistica, manutenzione e produzione), pesano complessivamente 891.070 byte in
WebP. Il manifest `docs/house-ad-creatives.json` conserva prompt, provenienza,
dimensioni e SHA-256. Fuori dalle pagine contestuali, le sei varianti usano
immagini predefinite diverse; `time_saved` usa la scena del pendolarismo nei
formati billboard e skyscraper. Nelle pagine lavoro l’immagine segue il settore
strutturato dell’annuncio o del filtro.
I sei layout coprono mobile banner, mobile large, rectangle, leaderboard,
billboard e skyscraper. Le tredici dimensioni di verifica sono 320×50, 320×100,
300×250, 336×280, 728×90, 970×90, 970×250, 160×600, 300×600, 253×220,
918×220, 970×1100 e 970×1790. Le riserve effettive dello slot vengono conservate, senza
forzare 220 px a 250 px; gli spazi estesi usano una fotografia verticale.
Sopra 1400 px di altezza il billboard usa una composizione verticale, con foto
sopra il messaggio. L’host riempie la riserva CSS effettiva: la sua regola
`min-height` a specificità zero conserva il reserve desktop da 1790 px.
Le quattro lingue sono italiano, inglese, tedesco e francese.

Inter, Space Grotesk e i token semantici del sito restano la sorgente visiva,
anche in tema scuro. Fotografia dei mestieri e accento del brand sono specifici
della campagna; il sistema globale `DESIGN.md` resta invariato. Un link nativo
comprende il banner, con nome accessibile localizzato, focus visibile e CTA di
almeno 44 px. Fotografie decorative con alt vuoto, dimensioni intrinseche,
decodifica asincrona e lazy loading; nessuna animazione obbligatoria.

## Erogazione

`houseAdRuntime.ts` considera esclusivamente frame proprietari espliciti,
con un nodo Google separato dall’host della creatività. Attende almeno 12 secondi
per slot e richiede no-fill/stato terminale o fallimento definitivo del relativo
SDK dopo i retry. Caricamenti e richieste ancora pendenti mantengono priorità.
Un fill tardivo rimuove immediatamente la creatività osservando lo stesso slot;
un altro annuncio pieno nella pagina non sopprime i fallback dei suoi vicini.
Senza MutationObserver il livello opzionale non parte, così non può coprire
un fill che non saprebbe osservare.

Abbonamenti senza pubblicità, documenti sensibili e pagina del servizio in ogni
lingua sono esclusi. L’aggiornamento dell’entitlement nella stessa scheda
richiama il singleton condiviso tra shell statica e React.

## Assegnazione e misurazione

L’endpoint server `getHouseAdCreativeAssignment` valuta il template Firebase
Server Remote Config; il client non riceve il template. Il 17 novembre 2026 il
template live era alla versione 11. I default locali sicuri sono `control` e
non arruolato. In produzione `house_creatives_v2` assegna sei varianti in
intervalli di pari dimensione (circa 16,7% ciascuno): `control`,
`time_saved`, `profile_match`, `in_control`, `swiss_work` e `next_chapter`.
Quindi il controllo è una delle sei varianti, non un gruppo separato del 50%.

Il test `reader_subscription_house_v1` ha assegnazione Firebase 50/50 tra
`control` e `subscription`. Il trattamento può sostituire un solo frame in un
blocco esplicitamente contiguo con almeno due frame publisher-owned; solo per
utenti anonimi senza entitlement no-ads attivo. I frame Google pieni non
vengono coperti. Entrambi i test usano un ID first-party stabile, creato dopo
`analyticsAllowed()`: resta in storage locale/sessione e non viene inviato a
GA4 o PostHog.

Nelle pagine lavoro il contesto usa soltanto etichette pubbliche strutturate
`job_detail`/`job_filter`: ruolo, luogo e settore. I valori vengono limitati e
sanificati; le ricerche libere non vengono passate alla creatività. Non si
personalizza con il nome dell’utente o con una posizione dedotta dall’IP. Se
manca un settore riconoscibile, la foto mostra il pendolarismo transfrontaliero.

Se il consenso analytics non consente la misurazione, l’assegnazione resta sul
controllo locale e non viene arruolata.

Il confronto riguarda immagine e messaggio insieme. Formato, posizione, lingua
e dispositivo restano separati nei risultati. Per evitare nuove dimensioni GA4,
`component` codifica variante/versione/arruolamento/lingua e `cta_surface`
codifica formato/posizione, riusando dimensioni già esistenti.

`house_ad_impression` richiede almeno il 50% della creatività visibile per un
secondo continuo, documento in primo piano e nessun dialog visibile sovrapposto.
Il test subscription usa anche `reader_sub_experiment_impression` e
`reader_subscription_experiment_exposure`; la scheda trattamento ha eventi
separati `reader_subscription_ad_impression` e
`reader_subscription_ad_click`. `house_ad_click` e `house_ad_landing` restano
eventi distinti. La sessione conserva
solo metadati pubblici limitati della campagna, con validità massima di 7 giorni.
Questi sono ricontrollati dal backend e copiati solo alla creazione dell’ordine;
retry e riprese del checkout conservano l’attribuzione originale.

La conversione principale è **acquisto confermato del servizio**: stato `paid`
e `paidAt` nel ledger verificato dai provider. Visite, clic, avvio del checkout
e URL di ritorno dal pagamento non sono acquisti. Rimborsi sono separati.

Readout aggregato e in sola lettura:

```sh
node scripts/analytics/house-ad-readout.mjs --days=28
```

Richiede credenziali service account e `GA4_PROPERTY_ID`. Rifiuta dati troncati,
non stampa dati personali e separa CTR osservato da ordini/pagamenti del ledger.
La finestra esclude gli ultimi due giorni per il ritardo di elaborazione GA4;
per valutare nuova telemetria dopo un deploy, uno zero nel report assestato non
prova una mancata emissione prima che la data entri nella finestra.
I blocchi della telemetria possono ridurre i denominatori GA4: non dividere
acquisti completi del ledger per clic parziali per dichiarare un CVR o un
vincitore. Il report non promuove automaticamente varianti sulla base del CTR.
Il workflow settimanale `house-creative-readout.yml` pubblica lo stesso
readout come artifact `house-ad-readout`, con un job separato attivato solo
quando il parametro pubblico della campagna esiste ed è riconosciuto.

## Pubblicazione coordinata

Il rollout attivo è descritto in
`docs/remote-config/house-ad-experiment-review.md`. Prima di modificare Remote
Config, aggiornare il template Server conservando tutte le chiavi estranee alla
campagna. Il rollback delle creatività è il controllo locale non arruolato;
loader e richieste Google restano attivi.

Le foto appartengono all’offload `images/job-search-campaign/`: staging, offload,
helper CDN e regola Cloudflare `Offloaded images -> CDN` condividono il prefisso.
Il publish R2 copia questo insieme prima degli asset eseguibili; un errore
interrompe la pubblicazione del codice e dei marker. La regola mantiene
raggiungibili anche gli URL apex emessi da runtime già live.
Prima del publish, il preflight verifica presenza, dimensione e SHA-256 di ogni
file del manifest: directory assenti, copie parziali e byte errati sono errori.
Per recuperare una pubblicazione parziale, caricare le foto del manifest con
`scripts/lib/upload-cdn-file.sh`, verificare SHA-256 e Content-Type via GET sul
CDN, applicare la regola esistente con `scripts/ensure-image-cdn-redirect.mjs`
dopo il dry-run e verificare gli stessi byte agli URL apex. Non pubblicare nuovo
HTML e non attivare il test se una fotografia manca.
