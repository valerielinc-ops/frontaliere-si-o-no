---
version: 1
slug: "components-pages-applicationconciergeadmin-tsx"
primary_target: "components/pages/ApplicationConciergeAdmin.tsx"
related_targets:
  - "components/pages/AssistedApplicationAdmin.tsx"
  - "components/pages/AssistedApplicationAutomationPanel.tsx"
  - "components/pages/AssistedApplicationCandidateEmails.tsx"
  - "components/pages/AssistedApplicationInbox.tsx"
  - "components/community/ApplicationConciergePortal.tsx"
---

# Superficie: amministrazione candidature

**Ultimo aggiornamento:** 2026-10-30

- Modalità: Operate, estensione dell’admin privato esistente.
- Pubblico e compito: il proprietario controlla chi deve agire su una candidatura, segue un utente del servizio di 30 giorni e verifica comunicazioni e prossimo passo.
- Autorità visiva: [DESIGN.md](../../DESIGN.md), sezione «Admin panel (Operate surface)»; contesto prodotto in [PRODUCT.md](../../PRODUCT.md).
- Direzione: [Contratto di direzione](#contratto-di-direzione) in questo brief. L’estensione conserva identità, tipografia, token semantici, autenticazione owner e protezione della session replay.
- Stato dell’evidenza: codice e schermate locali con fixture illustrative. Questo brief non certifica CI, merge, deploy o funzionamento del backend in produzione.

## Contratto di direzione

**Tesi.** L’operatore vede prima persona, candidatura e prossimo passo; apre i dettagli tecnici quando deve intervenire.

**Prima vista.** Due destinazioni distinguono «Candidature assistite» dal «Servizio 30 giorni». La prima apre la coda degli ordini; la seconda apre un elenco di utenti. Titolo, breve orientamento e «Aggiorna» precedono i dati. I controlli secondari restano subordinati al compito corrente.

**Gerarchia.** Il prossimo passo è espresso da un solo badge principale per ordine e da una spiegazione concreta. Email al candidato e inbox del datore rimangono visibili. Automazione, retry, rigenerazione, estensione e gestione manuale usano disclosure native con etichette leggibili.

**Forma.** Superfici chiare o scure secondo i token condivisi, separatori sottili, schede compatte, accento viola per interazioni e colori semantici accompagnati dal testo. La pagina pubblica inclusa nell’anteprima conserva la propria composizione; non diventa una nuova regola globale dell’admin.

## Navigazione e stato condivisibile

Le sezioni canoniche sono `candidature` e `servizio-candidature`, registrate in [adminSections.ts](../../components/admin/adminSections.ts) e montate da [AdminApp.tsx](../../components/admin/AdminApp.tsx). Restano nel percorso admin italiano esistente.

| Vista | Stato nella query | Contratto |
| --- | --- | --- |
| Coda singole | `azione` oppure `stato` | Un solo controllo «Mostra candidature» sceglie chi deve agire o lo stato della candidatura. La scelta di una famiglia azzera l’altra ed è ripristinata dalla query al rimontaggio o alla navigazione. |
| Stato candidato singola | `ordine` | Apre la proiezione dello stato visto dal candidato dopo che la coda contiene l’ordine corrispondente. |
| Elenco servizio | `stato`, `q` | Filtra i periodi di servizio e cerca per nome o email. Aprire un utente conserva i filtri nella query e il ritorno alla lista mantiene il contesto. |
| Dettaglio servizio | `servizio` | Identifica il periodo selezionato; gli ordini sono collegati tramite `parentServiceId`. |
| Anteprima servizio | `vista=candidato` | Mostra il portale candidato relativo al periodo selezionato; il comando di ritorno riapre la gestione. |

La lista del servizio raggruppa i periodi per utente e presenta una sola riga per gruppo. Nel gruppo visibile viene preferito un periodo attivo. Se l’utente ha più periodi, «Periodo del servizio» permette di cambiare quello in esame senza mescolare proposte e candidature di rinnovi diversi.

## Informazioni e azioni

La coda dà priorità alle candidature che richiedono attenzione. Ogni scheda mette in relazione ruolo, azienda, candidato, pagamento, mandato e CV con il prossimo passo derivato da `nextStepFor`. Le transizioni manuali e il rimborso sono raccolti in «Gestione manuale e rimborso»; la nota di audit resta obbligatoria per il blocco.

Il dettaglio del servizio mostra stato, pagamento, periodo, posizioni accettate, disponibilità del CV, consenso, località e documento, poi proposte e candidature accettate del solo periodo selezionato. Il modulo «Proponi una posizione manualmente» è una disclosure disponibile per un servizio attivo, nella vista di gestione.

«Email al candidato» mostra invio, aperture e clic con gli stati disponibili, inclusi invio incerto, errore e rimbalzo. I dati non disponibili restano distinguibili dagli zeri; il testo avvisa che le aperture sono indicative perché alcuni client le registrano automaticamente. Su mobile l’invio e la data passano sotto il nome dell’email, mantenendo leggibili i contatori.

«Inbox della candidatura» mostra l’alias quando disponibile e i riepiloghi dei messaggi ricevuti: categoria, data, oggetto, mittente, sintesi, eventuale colloquio e stato dell’inoltro. L’assenza della casella è distinta da una casella senza messaggi. La lista espone al massimo gli ultimi dieci messaggi e segnala quando raggiunge quel limite.

## Anteprima in sola lettura

«Vedi come candidato» monta il vero [ApplicationConciergePortal](../../components/community/ApplicationConciergePortal.tsx) passando il servizio già selezionato come `previewService`. Un avviso esplicito descrive la sola lettura. Un `fieldset` disabilita i controlli; la cattura degli eventi impedisce invii di form e navigazione tramite link nell’anteprima.

Il percorso di preview evita autenticazione del candidato, caricamento del suo servizio, ripresa automatica del checkout e telemetria di visualizzazione. Il portale resta riconoscibile e i titoli incorporati rispettano la gerarchia del dettaglio admin. Le verifiche del codice e della fixture non costituiscono una verifica di pagamenti o modifiche in produzione.

L’anteprima delle candidature singole rimane una proiezione dello stato restituito dal servizio admin; non va confusa con il portale completo del servizio di 30 giorni.

## Responsive, accessibilità e privacy

- Conservare densità desktop e flusso verticale leggibile a 390 px. Griglie, dati lunghi e controlli devono rientrare nella regione di contenuto; il portale incorporato usa contenitori che possono restringersi.
- Mantenere etichette testuali per stati e azioni, focus visibile, navigazione da tastiera e disclosure native. Le icone Lucide rafforzano il testo.
- Conservare i token semantici per entrambi i temi. Le schermate disponibili documentano il tema chiaro; non attestano una review visuale completa del tema scuro.
- Distinguere caricamento, errore di lettura, lista vuota e servizio non disponibile. Non sostituire dati assenti con valori inventati.
- Mantenere i dati della superficie nel perimetro owner e nelle classi/attributi di privacy della session replay. Non riportare dati personali nelle note di design o nei contenuti dimostrativi pubblici.

## Evidenza locale

Le immagini sono catture della build locale con fixture illustrative, non dati di produzione. Sono artifact locali non versionati, come `admin-direction.md`: non sono inclusi nel repository e non ne è garantita la disponibilità dopo la pulizia del worktree. Le viste mobile usano un viewport di 390 × 844 px; la coda desktop è stata catturata a 1280 px. Le altre catture desktop usano la larghezza predefinita del browser della sessione.

| Scenario | Desktop | Mobile |
| --- | --- | --- |
| Elenco utenti | `users-desktop.jpg` | `users-mobile.jpg` |
| Dettaglio utente e comunicazioni | `user-desktop.jpg` | `user-mobile.jpg` |
| Coda singole e prossimo passo | `queue-desktop.jpg` | `queue-mobile.jpg` |
| Portale candidato incorporato | `preview-desktop.jpg` | `preview-mobile.jpg` |
| Automazione aperta | — | `automation-mobile.jpg` |

La review visuale finale ha disposizione **ship**, limitatamente alla UI locale: la collisione responsive dell’anteprima è stata corretta e verificata nelle catture aggiornate. Le catture del dettaglio utente mostrano la proposta manuale richiusa. Il verdetto non attesta CI, merge, deploy o backend in produzione.

## Coerenza e drift rilevato

La superficie riusa il sistema Operate esistente e non richiede una nuova identità. Questo intervento documentale non modifica `PRODUCT.md`, `DESIGN.md` o il sidecar di sistema.

L’inventario delle sezioni in `DESIGN.md` nomina ancora soltanto «Candidature» nel gruppo Aziende; il codice aggiunge la sezione distinta `servizio-candidature`. È un drift documentale dell’inventario, registrato qui senza riscrivere il sistema globale.
