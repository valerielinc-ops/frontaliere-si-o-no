# Policy dati — portale farmacie (#6173)

Policy operativa per perimetro geografico, fonti, provenienza, freschezza,
validazione e pubblicazione della verticale farmacie/farmacie-di-turno.
Questa policy distingue l'esistenza anagrafica di una farmacia dalla sua
apertura attuale: la presenza in un elenco non dimostra che la sede sia aperta
in questo momento, di turno o disponibile per uno specifico servizio.

## Perimetro operativo

Il perimetro geografico ammesso è limitato a Ticino CH (`CH-TI`) e alle
province italiane `CO/VA/VB`:

| Codice | Area | Paese | Uso previsto |
| --- | --- | --- | --- |
| `CH-TI` | Canton Ticino | Svizzera | Anagrafica e turni quando la fonte cantonale li espone e la verifica è valida |
| `IT-CO` | Provincia di Como | Italia | Anagrafica; eventuale arricchimento pubblico verificato |
| `IT-VA` | Provincia di Varese | Italia | Anagrafica; eventuale arricchimento pubblico verificato |
| `IT-VB` | Provincia del Verbano-Cusio-Ossola | Italia | Anagrafica; eventuale arricchimento pubblico verificato |

`CO`, `VA` e `VB` sono sigle di provincia. Non sono inclusi altri territori
italiani, altre province, le parafarmacie o sedi fuori perimetro, salvo una
decisione documentata che modifichi questa policy.

Il filtro territoriale usa i campi di paese e provincia/cantone della fonte.
Un record con provincia assente, non riconciliabile o ambiguamente localizzato
non viene attribuito a `CO`, `VA` o `VB` per deduzione dal nome della città, dal
CAP o dalla prossimità al confine. Il perimetro autorizza la ricerca in queste
aree, ma non autorizza a dichiarare che ogni farmacia dell'area sia presente o
aggiornata.

Per l'anagrafica completa del Ticino la pipeline usa la lista cantonale PDF
`Lista_Farmacie.pdf`, che comprende le sedi del cantone anche nel Locarnese. Per
i turni, invece, la fonte OFCT attualmente rende compatibili le regioni
Mendrisiotto, Luganese, Bellinzonese e Biasca e Valli; il turno del Locarnese
resta non pubblicato finché non esiste un feed compatibile. Non si deduce quindi
un turno da una sede presente nell'anagrafica.

Directory, orari, turni e stato aperta/chiusa sono prodotti distinti. Una
farmacia presente nell'anagrafica italiana è una sede censita come aperta al
pubblico dalla fonte ministeriale, non una farmacia dichiarata aperta ora.

## Registro e gerarchia delle fonti

Ogni fonte usata dalla pipeline deve essere riconducibile a una giurisdizione
(`CH-TI`, `IT-CO`, `IT-VA`, `IT-VB`) e registrare almeno URL, tipo, metodo di
accesso, frequenza dichiarata, fuso orario, stato e note di verifica. Le entry
possono vivere in `data/pharmacy-sources-registry.json` e seguono gli stati
`unverified`, `active`, `blocked` e `degraded`.

Una fonte entra in `active` solo dopo una verifica documentata. Una fonte
`unverified` non abilita la pubblicazione automatica dei campi che dovrebbe
fornire.

La gerarchia è questa:

- una fonte ufficiale o un partner verificato può sostenere un dato di turno
  solo quando pubblica esplicitamente la finestra o lo stato pertinente;
- una fonte associativa o una farmacia può arricchire un record pubblico, ma
  non diventa per questo una prova implicita di "aperta ora", `24h` o turno
  verificato;
- una directory di terzi è fonte di discovery o confronto, non fonte unica per
  attestare un turno.

### Ticino (`CH-TI`)

- Fonte primaria per i turni e per l'anagrafica compatibile:
  [Ordine dei Farmacisti del Cantone Ticino — farmacie di turno](https://www.ofct.ch/farmacieturno/),
  con pagine regionali HTML server-rendered.
- Il sito OFCT dichiara `crawl-delay: 10`; il connettore deve rispettarlo e
  mantenere un User-Agent identificabile.
- Il dominio separato del Locarnese (`farmacielocarnese.ch`) non viene trattato
  come fonte equivalente finché non fornisce i campi necessari a una scheda
  completa. Un suo dato non va fuso silenziosamente con l'anagrafica OFCT.

### Italia (`IT-CO`, `IT-VA`, `IT-VB`): fonte primaria open data

La fonte primaria italiana è il dataset [Open Data — Farmacie del Ministero della Salute italiano](https://www.dati.salute.gov.it/it/dataset/farmacie/). È un export
pubblico in CSV, JSON e XML, distribuito con Italian Open Data Licence v2.0 e
con frequenza di aggiornamento dichiarata giornaliera.

Il dizionario del dataset espone, tra gli altri:

- `cod_farmacia`, identificativo univoco della farmacia/sede;
- `descrizione_farmacia`, `indirizzo`, `cap`, `comune`, `frazione`;
- `cod_provincia`, `sigla_provincia` e `provincia`;
- `data_inizio_validita` e `data_fine_validita`;
- `latitudine` e `longitudine` quando presenti;
- la tipologia della sede: ordinaria, succursale, dispensario o dispensario
  stagionale.

Il dataset è una base anagrafica e territoriale. Non è una fonte di orari di
apertura, servizi disponibili o numero di telefono: questi campi non devono
essere dichiarati disponibili perché la fonte elenca la farmacia. La data di
validità ministeriale non equivale a uno stato "aperta ora" e non abilita da
sola turni, reperibilità, servizio notturno o indicazione `24h`.

L'import italiano filtra esclusivamente `sigla_provincia ∈ {CO, VA, VB}` e
conserva l'identificativo ministeriale. Un record fuori da questo insieme non
entra nel dataset pubblico del perimetro transfrontaliero.

### Fonti secondarie e arricchimento OSM

[OpenStreetMap](https://www.openstreetmap.org/) è l'unica fonte secondaria
riutilizzata automaticamente dalla pipeline: può fornire coordinate, orari,
telefono, sito e alcuni tag di servizio quando la corrispondenza con la sede
ufficiale è univoca. Ogni campo derivato conserva URL dell'elemento OSM,
timestamp e licenza ODbL.

[Farmacia Aperta](https://farmacia-aperta.eu/) è il servizio web/app presentato
da [Federfarma Lombardia](https://www.federfarmalombardia.it/servizi/app-mobile-farmacia-aperta/).
Può essere consultato manualmente come fonte di confronto, ma non viene
scaricato, copiato o sottoposto a scraping dalla pipeline: i suoi termini di
servizio vietano la copia automatica/manuale senza autorizzazione scritta e il
servizio è limitato alla Lombardia. Un eventuale export autorizzato richiederebbe
una decisione separata e una provenienza campo per campo.

L'arricchimento è facoltativo e campo per campo:

- l'arricchimento OSM non sostituisce l'identità, la provincia o l'indirizzo
  della fonte ufficiale;
- richiede una corrispondenza verificata con l'identificativo ministeriale o,
  in sua assenza, con nome, indirizzo, CAP e provincia senza ambiguità;
- richiede URL della pagina/risorsa, timestamp di recupero e provenienza del
  singolo campo;
- non presuppone copertura uniforme: un tag OSM assente non viene riempito con
  una deduzione dalla località o da una sede vicina;
- non trasforma una fonte associativa in prova sufficiente per un turno
  `verified` quando mancano una verifica esplicita e una finestra temporale
  corrente.

Se la risorsa pubblica non è accessibile, non espone il campo, è stale, oppure
la corrispondenza non è certa, il campo secondario non viene pubblicato. Non si
usano endpoint privati, credenziali o dati non visibili pubblicamente come
fallback documentale.

## Campi disponibili e limiti dichiarati

| Campo | Fonte ministeriale italiana | OpenStreetMap | Regola pubblica |
| --- | --- | --- | --- |
| Identità e localizzazione | Sì, nei campi anagrafici e territoriali | Solo confronto/corrispondenza | Prevale la fonte primaria; record ambiguo escluso |
| Validità della sede | Sì, con date di validità | Non applicabile | Serve a valutare la presenza anagrafica, non l'apertura attuale |
| Orari | **No** | Solo se il tag è presente e tracciato | Omettere se assenti, vecchi o non riconciliati |
| Servizi | **No** | Solo tag espliciti e tracciati | Non dedurre servizi dal tipo di farmacia o dalla città |
| Telefono | **No** | Solo se il tag è presente e tracciato | Non inventare né ricavare numeri da fonti non tracciate |
| Turno / aperta ora | **No** | **No** | Mai inferire dalla presenza nel dataset o dalla mappa |

Le colonne "No" descrivono il limite operativo della fonte ministeriale, non
un'affermazione che il campo non possa mai esistere in nessuna fonte. Un campo
secondario può comparire soltanto con la sua propria fonte, timestamp e stato
di verifica.

## Timestamp e provenienza

Ogni record o dataset pubblicato deve conservare una provenienza leggibile e
riutilizzabile:

- `sourceUrl` identifica la pagina o il file da cui proviene il dato;
- `sourceType` distingue almeno fonte ufficiale e fonte associativa;
- `fetchedAt` (o `_fetchedAt` a livello dataset) è l'istante dell'ultimo
  recupero riuscito, in ISO 8601 UTC;
- `sourceUpdatedAt`, se fornito dalla fonte, è la data/ora dichiarata dalla
  fonte e resta distinta dal momento in cui noi abbiamo scaricato il file;
- `lastVerifiedAt` indica una verifica umana o di validazione, non va
  automaticamente riscritto a ogni fetch;
- `generatedAt` indica la generazione del dataset o della pagina, non
  l'aggiornamento della farmacia alla fonte.

Per un campo proveniente da OSM la provenienza deve
essere conservata a livello di campo oppure in una struttura equivalente che
non permetta di confonderla con i campi ministeriali. Se non è possibile
conservare questa distinzione, l'arricchimento non viene pubblicato.

L'interfaccia mostra fonte e ultimo recupero per i dati dinamici. Se la fonte
non comunica una propria data di aggiornamento, l'etichetta deve dire
"recuperato il" e non "aggiornato il". Un timestamp mancante non viene
sostituito con la data di build, con la data odierna o con una stima.

## SLA e freschezza

- Il dataset ministeriale dichiara un aggiornamento giornaliero; questo è un
  attributo della fonte, non una garanzia di stato in tempo reale. La pipeline
  deve registrare ogni fetch riuscito e non rinnovare il timestamp in caso di
  errore.
- I turni Ticino restano soggetti al fetch giornaliero della fonte OFCT. Un
  fetch fallito conserva l'ultimo record valido solo fino alla scadenza già
  dichiarata; non prolunga `endsAt` e non mantiene un turno come attivo oltre
  tale istante.
- OSM non introduce uno SLA sanitario o di apertura. Ogni campo
  arricchito deve avere una propria verifica di freschezza; se la freschezza o
  il timestamp non sono dimostrabili, il campo viene omesso.

La dashboard di salute deve distinguere almeno: copertura delle quattro
giurisdizioni, numero di record per giurisdizione, età dell'ultimo fetch,
errori di recupero, record fuori perimetro, collisioni di identità e campi
secondari privi di provenienza. Un'area senza record verificati è una copertura
non disponibile, non uno zero da riempire con dati stimati.

## Validazione e comportamento dei campi non verificati

I campi necessari a identificare e localizzare una sede sono bloccanti:

- per `IT-*`: identificativo ministeriale, nome, indirizzo, CAP, comune,
  `sigla_provincia` ammessa e paese `IT`;
- per `CH-TI`: identificativo, nome, indirizzo, CAP, località, cantone `Ticino`
  e paese `CH`, secondo i campi pubblicati dalla fonte cantonale.

Se uno di questi campi è mancante, invalido o ambiguo, il record non viene
pubblicato come scheda verificata. Lo slug o le coordinate non possono
sostituire un'identità mancante; non si completa la localizzazione con una
geocodifica silenziosa.

Per i campi opzionali vale questa regola:

- campo assente nella fonte: omettere il campo o mostrare "non disponibile";
- campo presente ma senza provenienza, timestamp o corrispondenza certa:
  trattarlo come `unverified` e ometterlo dalla pubblicazione fattuale;
- conflitto tra fonti: mantenere il valore in revisione (`pending_review` o
  `conflicting`) e non scegliere arbitrariamente una versione;
- dato non più fresco della soglia prevista: non presentarlo come corrente;
  conservarlo solo se chiaramente marcato storico/stale, altrimenti ometterlo.

In particolare, un campo `openingHours`, `services` o `phone` mancante dal
dataset del Ministero resta mancante. Non si inserisce un valore vuoto come se
fosse verificato, non si copia un valore da una farmacia vicina e non si deduce
"aperta", "di turno" o `24h` dall'esistenza della sede. Un valore proveniente
da OSM può essere mostrato solo con la propria
provenienza e il proprio timestamp.

## Disclaimer e pubblicazione

Ogni pagina che mostra una farmacia o un dato di turno riporta fonte e
timestamp del recupero. Le pagine distinguono esplicitamente:

- "sede presente nell'anagrafica";
- "orario/servizio/telefono pubblicato da una fonte secondaria";
- "turno o stato corrente", solo quando esiste una fonte che lo espone e la
  verifica è valida.

Il sito non promette elenco nazionale italiano, completezza delle province
oltre `CO`/`VA`/`VB`, orari, servizi, telefono, reperibilità o apertura in
tempo reale quando questi dati non sono presenti e verificati. Non dichiara
"aperta ora", "24h" o un turno comunale per inferenza.

Per un bisogno urgente l'utente deve verificare direttamente con la farmacia o
con il servizio locale competente. Il disclaimer non deve implicare che il
numero di telefono sia disponibile: per alcune sedi la fonte primaria non lo
pubblica.

Non è prevista la pubblicazione automatica di articoli, pagine evergreen,
alert o consigli sanitari a partire dalla sola anagrafica. La verticale
pubblica directory e turni solo nei limiti dei dati effettivamente verificati.
