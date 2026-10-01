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

1. Apri `chrome://extensions` e accendi **Modalità sviluppatore** (in alto a destra).
2. Premi **Carica estensione non pacchettizzata** e scegli questa cartella
   (`scripts/assisted-application/extension` nel checkout del sito).
3. Ricarica la coda delle candidature: il pulsante **Compila con l'estensione**
   compare sugli ordini che il robot ti ha passato.

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

## Cosa non fa

- Non preme mai il pulsante d'invio e non risolve CAPTCHA.
- Non inventa risposte: usa solo il «kit di compilazione» dell'ordine
  (`functions/src/assistedApplicationFillKit.js`). Se manca una risposta si
  ferma e la elenca nel riquadro.
- Non salva nulla su disco: il kit resta nella memoria della sessione del
  browser e sparisce alla chiusura.
