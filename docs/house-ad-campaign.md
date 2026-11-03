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
| time_saved | Logistica | Alla ricerca pensiamo noi. |
| profile_match | Produzione | Le offerte per il tuo mestiere. |
| in_control | Manutenzione | Ti aiutiamo noi, dall’inizio. |
| swiss_work | Elettricista | Cerchiamo le offerte per te. |
| next_chapter | Ospitalità | Meno ricerche. Ti aiutiamo noi. |

Dodici fotografie originali GPT Image, una verticale e una panoramica per
famiglia, pesano complessivamente 727.580 byte in WebP. Il manifest
`docs/house-ad-creatives.json` conserva prompt, provenienza, dimensioni e SHA-256.
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
anche in tema scuro. Fotografia dei mestieri e promessa rossa sono specifiche
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

Il parametro pubblico Firebase Remote Config `HOUSE_AD_CREATIVE_VARIANT` ha
default locale `control`. Il runtime legge soltanto l’endpoint allowlisted
`getPublicConfig`, con timeout di 3 secondi, prima della prima esposizione.
La risposta viene attivata una volta: nessun cambio di variante a banner già
visibile. Un parametro assente/errore produce controllo **non arruolato**.

- `control` o un nome della tabella: creatività fissa, non arruolata.
- `auto`: assegnazione uniforme persistente alle sei famiglie, con ID casuale
  locale dedicato e hash deterministico. Nessun identificatore PostHog.
- Analytics disattivata: controllo non arruolato e nessun evento/attribuzione.

Il confronto riguarda immagine e messaggio insieme. Formato, posizione, lingua
e dispositivo restano separati nei risultati. Per evitare nuove dimensioni GA4,
`component` codifica variante/versione/arruolamento/lingua e `cta_surface`
codifica formato/posizione, riusando dimensioni già esistenti.

`house_ad_impression` richiede almeno il 50% della creatività visibile per un
secondo continuo, documento in primo piano e nessun dialog visibile sovrapposto.
`house_ad_click` e `house_ad_landing` sono eventi distinti. La sessione conserva
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
I blocchi della telemetria possono ridurre i denominatori GA4: non dividere
acquisti completi del ledger per clic parziali per dichiarare un CVR o un
vincitore. Il report non promuove automaticamente varianti sulla base del CTR.
Il workflow settimanale `house-creative-readout.yml` pubblica lo stesso
readout come artifact `house-ad-readout`, con un job separato attivato solo
quando il parametro pubblico della campagna esiste ed è riconosciuto.

## Pubblicazione coordinata

Pubblicare prima codice/immagini del sito e backend allowlist/checkout, poi
trasportare snapshot del supporto e markup host nel corpus. Confermare gli URL
delle immagini e gli hash dei componenti pubblicati prima di attivare `auto`.
Il rollback del test è `control`; loader e richieste Google restano attivi.
Il template Remote Config conserva tutte le chiavi estranee alla campagna.

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
