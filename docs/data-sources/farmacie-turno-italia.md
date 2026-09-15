# Turni delle farmacie italiane al confine

Questa sorgente alimenta esclusivamente il connettore core per le province
`CO` (Como), `VA` (Varese) e `VB` (Verbano-Cusio-Ossola). Il fuso di
normalizzazione è sempre `Europe/Rome`: il turno diurno viene rappresentato
dalle 08:30 locali del giorno indicato alle 08:30 del giorno successivo.

## Fonti ufficiali

Le fonti sono registrate in
[`data/pharmacy-duties-italy-sources.json`](../../data/pharmacy-duties-italy-sources.json).

- Como: [Comune di Merone — calendario delle farmacie di turno
  2026-2027](https://www.comune.merone.co.it/novita/comunicati_stampa/novita_138.html).
  La pagina comunale pubblica gli allegati ATS per i turni diurni, notturni e
  festivi della provincia di Como; il workflow risolve l'allegato `Turni base`
  tramite l'endpoint ufficiale Halley della stessa pagina.
- Varese: [Comune di Marchirolo — calendario turni
  2026-2027](https://comune.marchirolo.varese.it/Dettaglionews?IDNews=400586),
  con [PDF del calendario 24
  ore](https://comune.marchirolo.varese.it/portals/2011/SiscomArchivio/6/121368-10-Varese_calendario_turni_2026_2027_2%201.pdf).
  La pagina indica l'approvazione ATS Insubria n. 310 del 20/05/2026.
- VCO: [Determina ASL VCO n. 1755 del
  09/12/2025](https://www.aslvco.it/wp-content/uploads/2025/12/2968938.pdf?x88295=),
  che approva il calendario 2026 e i cambi turno. La tabella base è una
  successione; vengono pubblicate soltanto le righe che recano una data
  esplicita nel documento.

Il catalogo anagrafico usato per risolvere `pharmacyId` è il dataset ufficiale
del Ministero della Salute già presente in
[`data/pharmacies-italy-border.json`](../../data/pharmacies-italy-border.json).
Il catalogo non è una fonte di turni e non viene usato per dedurre una
provincia dal nome del comune, dal CAP o dalla vicinanza al confine.

## Farmacia Aperta

[Farmacia Aperta](https://farmacia-aperta.eu/) è solo un link-out informativo.
Questo connettore non scarica, copia né sottopone a scraping il servizio. Le
righe pubblicate devono provenire dai documenti ufficiali registrati sopra.

## Fail-closed e release atomica

L'importer produce `data/pharmacy-duties-italy.json` e il sidecar
`data/pharmacy-duties-italy-status.json` nello stesso ciclo. Il modulo
[`services/pharmacies/italyRelease.ts`](../../services/pharmacies/italyRelease.ts)
calcola un unico `releaseId` sui due payload; il checker ricalcola gli hash
prima di permettere la pubblicazione.

La release è non pubblicabile quando si verifica una di queste condizioni:

- la provincia della fonte manca, è fuori da `CO`, `VA`, `VB` o il documento
  contiene indicatori di più province;
- una riga non ha una data esplicita, un'identità ministeriale univoca o un
  intervallo Europe/Rome valido;
- il documento è fuori dalla finestra di validità dichiarata o il fetch supera
  la soglia di freschezza;
- una fonte non produce almeno una riga verificata, il sidecar contiene errori,
  i due snapshot hanno release diverse oppure un hash non coincide.

Una rotazione senza date, come la successione 1-15 del documento VCO, non viene
trasformata in date tramite una supposizione. In quel caso il relativo stato è
`not_published`/`partial` e il workflow non committa una nuova coppia di
artifact.

I fixture in
[`tests/fixtures/pharmacy-duties/italy/`](../../tests/fixtures/pharmacy-duties/italy/)
sono estratti testuali dei documenti ufficiali, conservati per test
deterministici senza chiamate di rete.
