# Compila candidatura

Estensione Chrome della coda delle candidature assistite. Quando il portale di
un datore rifiuta l'invio del robot (per esempio il reCAPTCHA invisibile di
JOIN), Valerie invia la candidatura dal proprio browser: l'estensione apre il
portale, compila ogni passaggio con i dati che il robot aveva già preparato,
allega CV e lettera, va avanti da sola e si ferma sulla pagina finale con il
pulsante d'invio evidenziato. **L'invio lo premi tu**: è quel clic che rende la
candidatura tua e non di un robot, ed è ciò che il controllo anti-robot del
portale chiede. Appena il portale conferma, l'ordine viene segnato come
inviato nella coda e il cliente riceve l'email di conferma.

## Installazione (una volta)

1. Dal checkout del sito, sul Mac: `scripts/assisted-application/extension-sync.sh install`.
   Copia l'estensione in `~/Library/Application Support/Frontaliere/compila-candidatura`
   (un'altra cartella come argomento, se la preferisci) e la tiene allineata a
   `main` ogni 15 minuti con un launch agent (`ch.frontaliere.compila-candidatura-sync`,
   log in `~/Library/Logs/frontaliere/compila-candidatura-sync.log`). Non in
   Documenti, Scrivania o Download: macOS non lascia scrivere lì un launch agent.
2. Apri `chrome://extensions` e accendi **Modalità sviluppatore** (in alto a
   destra). Deve restare accesa: senza, Chrome spegne l'estensione quando si aggiorna.
3. Premi **Carica estensione non pacchettizzata**; nella finestra premi
   ⇧⌘G, incolla `~/Library/Application Support/Frontaliere/compila-candidatura`
   e scegli quella cartella.
4. Ricarica la coda delle candidature: il pulsante **Compila con l'estensione**
   compare sugli ordini che il robot ti ha passato.

## Aggiornamenti

Non serve premere **Ricarica**. Dopo un merge su `main`, entro 15 minuti il
launch agent copia i file nuovi nella cartella. Entro un minuto l'estensione se
ne accorge e si ricarica da sola, ma mai mentre sta compilando un ordine: aspetta
che il portale abbia confermato, oppure due ore se la compilazione è stata
lasciata a metà. La coda già aperta riceve il collegamento nuovo senza
ricaricare la pagina.

## Uso

1. In coda, sull'ordine in «presa in carico», premi **Compila con l'estensione**.
2. Si apre il portale in una nuova scheda: l'estensione compila e va avanti da
   sola (in basso a destra vedi a che punto è; **Ferma** la interrompe).
3. Sulla pagina finale premi il pulsante evidenziato. Se il portale mostra un
   CAPTCHA visibile, risolvilo tu. Se poi chiede di verificare l'indirizzo
   email (JOIN), non serve fare nulla: la coda prende il link arrivato
   sull'alias dell'ordine e l'estensione lo apre in una nuova scheda.
4. Alla conferma del portale l'ordine passa a «inviata» da solo. Se qualcosa
   non torna, in coda c'è sempre **Segna come inviata**.

Se l'annuncio apre il modulo in una nuova scheda (Coop: «Jetzt bewerben» porta
a SAP SuccessFactors), l'estensione segue quella scheda e continua lì; ignora
«Später bewerben», che salva l'annuncio e non avvia la candidatura. Sui portali
con account (SuccessFactors) la password non la scrive l'estensione: se il
robot ha già creato l'account sull'alias, in coda, sotto «Account sui
portali», **Mostra password** te la dà; altrimenti registralo tu sull'alias
dell'ordine, l'estensione compila gli altri campi. Sul modulo SuccessFactors apre i menu
«Bitte auswählen» e sceglie l'opzione quando è caricata, e scrive la data di
nascita nel suo campo calendario; le sezioni chiuse («Alle Abschnitte
einblenden») e il CV («Lebenslauf hochladen») restano a te.

## Cosa non fa

- Non preme mai il pulsante d'invio e non risolve CAPTCHA.
- Non inventa risposte: usa solo il «kit di compilazione» dell'ordine
  (`functions/src/assistedApplicationFillKit.js`). Se manca una risposta si
  ferma e la elenca nel riquadro.
- Non salva nulla su disco: il kit resta nella memoria della sessione del
  browser e sparisce alla chiusura.
