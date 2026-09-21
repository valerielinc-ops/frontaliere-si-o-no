# Cancellazione operatore di un indirizzo

Questo strumento è esclusivamente tecnico e manuale. Non è una funzione
Firebase, una callable, una route HTTP, una pagina SPA o un percorso avviabile
dall'utente. L'operatore deve avere già un'autorizzazione appropriata e un
service account Firebase Admin valido; le credenziali non sono nel repository.

La modalità predefinita è sempre dry-run:

    node scripts/erase-subscriber-data.mjs persona@example.test

Il comando legge l'inventario e stampa i target, ma non scrive. Per chiedere
la cancellazione serve il flag esplicito:

    node scripts/erase-subscriber-data.mjs persona@example.test --apply

Il comando termina con errore se una lettura, query, listCollections, commit o
operazione Auth fallisce. Dopo --apply esegue una nuova inventariazione e
controlla anche i path già individuati prima della cancellazione; stampa
APPLY_VERIFIED soltanto quando non risultano documenti, sottocollezioni o utente
Auth residui. Un errore dopo l'inizio della cancellazione è un fallimento
parziale, non un successo.

## Copertura contrattuale

La utility attraversa soltanto questi dati:

- newsletter_subscribers/{email}: events, campaign_deliveries, private;
- job_alert_subscribers/{email}: alerts, alert_deliveries, events;
- users/{uid}: savedJobs, per un documento il cui campo email coincide oppure
  per l'uid trovato in Firebase Auth;
- contact_submissions.email;
- consulting_orders.customerEmail;
- applications.candidateEmail;
- publishers.email.

Le query sui documenti extra sono paginated e i figli vengono cancellati in
batch da 450 operazioni, sotto il limite Firestore di 500. Una sottocollezione
non elencata, anche se annidata sotto un documento figlio, è un errore
bloccante: non viene trattata come vuota e non viene cancellata implicitamente.
Per aggiungere un nuovo store occorre prima verificare writer, campo di
identità e retention e aggiornare test e documentazione nella stessa modifica.

Non eseguire --apply durante i test locali o CI. I test usano solo fake
Firestore/Auth in memoria e non caricano credenziali di produzione.
