---
version: 1
slug: "components-pages-paidassistedapplicationspage-tsx"
primary_target: "components/pages/PaidAssistedApplicationsPage.tsx"
related_targets: []
---

# Superficie
- Scope: pagina profilo `profile_view=applications`.
- Modalità: Operate.
- Pubblico e compito: una persona che vuole capire a quale offerta si riferisce ogni candidatura assistita, il suo stato attuale e se deve intervenire.
- Prova e contenuto: dati reali dell'ordine (identità aziendale, ruolo, sede se disponibile, fonte, stato, aggiornamento, annuncio esterno e richiesta CV). Il logo si risolve con la chiave e il nome aziendale; se non esiste una corrispondenza, si usano iniziali deterministiche. I campi assenti restano assenti; nessuna cronologia o progresso inventato.
- Vincoli: mobile first, preservare flusso d’accesso, stati di caricamento/errore/vuoto, privacy della session replay e CTA esistenti; empty state senza aziende o offerte dimostrative.
- Momento memorabile: il logo e il titolo rendono subito riconoscibile ogni candidatura, mentre la fascia “prossimo passo” mostra con chiarezza quando serve agire.
- Decisioni aperte: dettagli facoltativi dell’annuncio si mostrano solo quando sono verificabili nell’ordine.

## Direction contract

THESIS: Ogni candidatura diventa un dossier leggibile: l’offerta è riconoscibile, lo stato è concreto e il prossimo passo è immediato; la pagina rifiuta l’elenco anonimo di stati.

OWN-WORLD: Fondo chiaro da archivio editoriale, gerarchia tipografica netta, loghi aziendali trattati come sigilli riconoscibili e un accento verticale viola che collega il dossier al suo stato. Ambra, blu e verde restano riservati agli stati semantici; le superfici sono compatte, con contorni precisi e pochi livelli.

STORY: “So per quale ruolo ho chiesto aiuto, che cosa è successo di recente e se tocca a me fare qualcosa.” L’utente può aprire l’annuncio originale oppure completare il caricamento CV quando richiesto.

FIRST VIEWPORT: Su mobile, titolo e breve orientamento occupano una fascia iniziale contenuta. La prima scheda reale, selezionata dando precedenza a quelle che richiedono un’azione e poi alla data di aggiornamento, mostra un logo di 56 px, ruolo, azienda, sede disponibile, fonte e pill di stato. Quando lo stato ha istruzioni verificate, la fascia cromatica “Prossimo passo” indica il caricamento CV o il controllo dell’email; negli altri stati la pagina mostra lo stato senza inventare un’azione. “Apri annuncio” resta un link secondario. Con zero candidature compare un’illustrazione originale del dossier vuoto e una CTA alle offerte, senza contenuti dimostrativi.

FORM: Schede dossier complete, assegnate come prima direzione della mano (`assigned`, posizione 1); il gesto distintivo è la fascia di prossimo passo che si adatta allo stato reale. seed:79ede9522ae80671

## Contratto dati verificato (2026-10-21)

Il pannello usa la proiezione autenticata delle candidature assistite. Il server restituisce solo identificativo ordine, ruolo, azienda e identità per il logo, sede, URL annuncio, fonte, stato, aggiornamento e indicazione di caricamento CV. `companyKey` deriva dall'identificativo aziendale disponibile (o dal nome) ed è limitata a 200 caratteri; la sede viene normalizzata e limitata a 180. L'URL viene accettato solo se HTTPS, senza credenziali e lungo al massimo 2048 caratteri. La risposta non espone chiavi dei CV, contatti della persona, note interne o payload di automazione.

La pagina mette prima le candidature in attesa di materiali o di un'azione della persona, poi ordina ogni gruppo per aggiornamento più recente. Mostra il prossimo passo solo per gli stati con istruzioni verificate; il pulsante per caricare il CV appare solo quando il server lo richiede. Il link all'annuncio appare solo se l'URL sicuro è presente.

## Allineamento al design system

La superficie riusa i token esistenti per superfici, accent viola, stati semantici, bordi, radius e focus; non introduce una nuova palette o variabili globali. I testi di badge e prossimi passi usano le varianti semanticamente più scure per raggiungere il contrasto AA, con colori più luminosi in tema scuro. L'empty state e la sua illustrazione usano token che seguono `html.dark`. `DESIGN.md` resta la fonte del sistema condiviso e non richiede modifiche per questa pagina.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
