# Decisioni: CV e lettera della candidatura assistita

Decisioni prese il 3 ottobre 2026 sui punti che lo studio ([`report-cv-lettera.md`](report-cv-lettera.md), §7) lasciava aperti e sui tre interruttori Remote Config delle fasi 2, 3 e 5.
Ogni decisione riporta i fatti su cui poggia, la regola, e come si cambia. Le fonti sono in [`fonti/`](fonti/): ogni affermazione è stata riaperta da un secondo lettore che ha cercato di confutarla, e dove la verifica ha smentito la ricerca vale la verifica.
Una decisione è in vigore quando la sua PR è mergiata: quale PR e quando è scritto nel §9 del report. Qui sta la regola, non lo stato.

Due regole reggono tutte le altre:

1. **Si scrivono solo fatti.** Il CV, la lettera e l'e-mail dicono ciò che il candidato ha dichiarato. Una formula fissa è ammessa solo se è vera per chiunque la riceva. Niente previsioni («permesso da richiedere»), niente diritti («diritto al permesso»), niente firme o dati creati dal servizio.
2. **Ogni interruttore ha un default sicuro.** Senza parametro in Remote Config il comportamento è quello prudente. Gli interruttori si leggono e si impostano con `node scripts/assisted-application/rc-switches.mjs` (`status`, poi `set CHIAVE=valore`, che senza `--apply` mostra soltanto cosa cambierebbe).

| # | Punto | Decisione in una riga |
|---|---|---|
| 1 | Strada del CV | Template rigenerato. Il file Word del candidato con le righe adattate resta spento. |
| 2 | Foto | Facoltativa, caricata dal candidato. Una foto tolta non resta né nel CV che parte né nei file. |
| 3 | Dati personali e permesso | Solo fatti: nazionalità e permesso posseduto oggi, da un elenco chiuso. Mai «permesso da richiedere». |
| 4 | Formato consegnato | PDF ai datori. Al candidato restano i documenti inviati e una copia Word da tenere. |
| 5 | Allegati via e-mail | Lettera e CV in due PDF separati. Un solo PDF soltanto se lo chiede l'annuncio. Il dossier unico resta spento. |
| 6 | Layout del CV | Solo la versione in linea, a una colonna. Nessuna versione tabellare. |
| 7 | Licenza del repository | Tutti i diritti riservati sul materiale proprio; il materiale di terzi resta sotto le sue licenze. |
| 8 | Gate sui fatti | Strumenti, numeri, datori, titoli e permessi non sostenuti dal candidato bloccano. L'eco dell'annuncio segnala. |
| 9 | Dove si compone il PDF | Typst, nel runner e nelle Cloud Functions, con autoverifica periodica visibile al proprietario. |
| 10 | Firma | Nome dattiloscritto. Nessun caricamento della firma. |
| 11 | Formule della lettera | Quelle delle fonti istituzionali svizzere verificate, lingua per lingua. |
| 12 | A/B test dei template | Non ora: il volume non lo consente. |
| 13 | Interruttori Remote Config | `PDF_RENDERER` = typst, `DOSSIER_MODE` = separate, `DOCX_INPLACE` = off. |
| 14 | Orario d'invio | Nessuna finestra: una candidatura parte appena approvata. |
| 15 | Immagini di terzi negli articoli | Autore e licenza recuperati da Commons, dati strutturati corretti, credito in fondo all'articolo. |

---

## 1. Strada del CV

**Fatti.** Al 3 ottobre 2026 la produzione conta 16 ordini, 8 con un CV caricato: tutti PDF, nessun file Word (conteggio su campi tecnici, senza leggere contenuti). Il file Word «in-place» (fase 5) esiste solo per chi carica un DOC o un DOCX. Per offrirlo, il runner deve far leggere a LibreOffice un file del candidato nello stesso job che possiede le credenziali di produzione; il conteggio delle pagine vale solo rispetto ai font installati nel runner; nessuna esecuzione reale è mai stata misurata.

**Decisione.** La strada è il template rigenerato. `ASSISTED_APPLICATION_DOCX_INPLACE` resta `off`. Tre regole valgono anche a interruttore spento: i convertitori esterni che leggono un file del candidato non ricevono l'ambiente del job; il kit di compilazione del proprietario consegna lo stesso file che invierebbe il robot; il pannello mostra la scelta effettiva del candidato.

**Si riapre quando** un candidato chiede di tenere il proprio layout Word, o i CV Word diventano una quota non trascurabile. Prima di accendere: una prova reale su un ordine di test e la conversione in un contenitore senza rete.

**Come si cambia.** `node scripts/assisted-application/rc-switches.mjs set ASSISTED_APPLICATION_DOCX_INPLACE=on --apply`.

## 2. Foto

**Fatti.** Le guide svizzere la considerano consueta in tedesco e facoltativa in francese e italiano, mai obbligatoria ([`studio/convenzioni-svizzere.md`](studio/convenzioni-svizzere.md)). Una foto ritagliata da un CV può essere di un'altra persona.

**Decisione.** La foto è facoltativa e la carica solo il candidato, sulla pagina di revisione (JPG o PNG, 2 MB al massimo); non si estrae mai dal CV. Il CV adattato e la foto si salvano in un'unica scrittura protetta: una foto tolta non può restare nel CV che parte. La pagina dice «foto inclusa» solo quando il PDF la contiene davvero; un'immagine illeggibile viene rifiutata al caricamento. Il PDF che conteneva una foto tolta o sostituita viene cancellato subito; tutto il resto segue la conservazione di 90 giorni dell'ordine.

## 3. Dati personali e stato del permesso

Fonti: [`fonti/permesso-e-dati-personali.md`](fonti/permesso-e-dati-personali.md), 89 affermazioni confermate.

**Fatti.**
- Il permesso G UE/AELS si ottiene con un'attività in Svizzera e si chiede per quell'attività; non esiste per cercare lavoro (C04, C05, C36). Fino a tre mesi o 90 giorni l'anno non c'è alcun permesso: basta la notifica del datore (C21–C27).
- I cittadini UE/AELS hanno un diritto se le condizioni sono soddisfatte, ma la SEM scrive nello stesso passo che non si può dare alcuna garanzia (C29–C35). Per i cittadini di Stati terzi il permesso G è una facoltà dell'autorità, vale un anno, per la zona di frontiera del Cantone, e ogni cambio di posto va autorizzato (C44–C56).
- Le guide per il CV dicono di indicare la nazionalità e il permesso **che si possiede**; nessuna tratta chi non ne ha uno (C64–C76).
- Se un permesso G non ancora scaduto valga dopo la fine del lavoro dipende dal Cantone (San Gallo: decade; Ticino: sei mesi; Ginevra: da distruggere alla cessazione definitiva). La legge federale non lo elenca tra i motivi di decadenza.
- Alcune guide commerciali suggeriscono «Anspruch auf G/B-Bewilligung (EU-Bürger)» o «Éligible au permis G/B». La direttiva SEM esclude che si possa promettere un rilascio.

**Decisione.**
- Non si stampa né si genera mai una frase su un permesso futuro: «permesso G da richiedere», «diritto al permesso», «Bewilligung beantragt», «éligible au permis G», «nessun permesso necessario».
- Lo stato del permesso è un elenco chiuso, scelto dal candidato, mai dedotto e mai preselezionato: cittadinanza svizzera; permesso C, B o L valido oggi; permesso G con cui si lavora oggi in Svizzera; nessun permesso svizzero oggi. Senza scelta, il CV riporta ciò che dice il CV del candidato.
- Il CV stampa il permesso posseduto con il nome ufficiale per esteso, mai una lettera sola (B e C sono anche categorie di patente): «permesso di dimora (B)», «Aufenthaltsbewilligung B», «autorisation de séjour (permis B)», «residence permit B». Nulla su ciò che il permesso consente.
- Il permesso G si stampa solo accanto a una nazionalità UE/AELS: per un cittadino di uno Stato terzo è legato a un datore e a una zona, e su un CV per un nuovo datore potrebbe far credere il contrario.
- «Nessun permesso» non si stampa: nessuna frase negativa («senza permesso») e nessuna frase generata sulla residenza. L'indirizzo è già nell'intestazione.
- La nazionalità è quella dichiarata dal candidato. Se è una sola e appartiene a un elenco chiuso (UE-27, Islanda, Liechtenstein, Norvegia, Svizzera), il CV la scrive nella lingua del CV e, per UE/AELS, aggiunge la sigla ricavata dal codice: «(UE)», «(EU)», «(AELS)», «(AELE)», «(EFTA)». Il Regno Unito non è nell'elenco. Ogni altro caso si stampa come l'ha scritto il candidato, senza sigla.
- Data di nascita e nazionalità si possono aggiungere sulla pagina di revisione; nessuno è obbligato. La lettera e l'e-mail continuano a non parlare di età e nazionalità.
- Ogni correzione di un dato che il CV stampa ricostruisce il CV prima di qualunque invio.
- Lettera ed e-mail possono nominare un permesso solo se è quello posseduto; il gate sui fatti blocca un permesso non sostenuto.
- Nei portali un campo su permesso, autorizzazione al lavoro, nazionalità o cittadinanza è sempre «sensibile»: il robot sceglie un'opzione solo se corrisponde allo stato dichiarato, altrimenti la domanda va al candidato.

**Come si cambia.** L'elenco, le diciture per lingua e la tabella delle nazionalità stanno in un solo modulo condiviso da Functions, runner e pagina di revisione, con la data di aggiornamento dell'elenco UE/AELS. Prima di toccare una dicitura, riaprire la fonte (C86–C89).

## 4. Formato consegnato

**Fatti.** I datori ricevono PDF. La guida degli URC ticinesi chiede a chi cerca lavoro di conservare copia delle candidature inviate ([`fonti/dossier-in-un-pdf.md`](fonti/dossier-in-un-pdf.md), prove contrarie). Al 3 ottobre 2026 il candidato, dopo l'invio, non riceve né un file né un link; per una candidatura WhatsApp la lettera e il CV preparati non arrivano a nessuno. SDBB consiglia di tenere CV e lettera in un formato modificabile.

**Decisione.**
- Dopo l'invio, la pagina di revisione mostra «I tuoi documenti»: i file partiti (o, per WhatsApp, quelli da usare nella chat). L'e-mail «candidatura inviata» porta un pulsante a quella pagina. Nessun allegato nelle e-mail.
- Il candidato può scaricare una **copia Word da tenere** della lettera e del CV adattato. È costruita al momento dagli stessi dati del PDF, non viene salvata, non può essere scelta come CV da inviare. Non contiene la foto.
- Il link a quella pagina nell'e-mail «candidatura inviata» vale finché i file dell'ordine esistono, cioè fino alla cancellazione automatica (decisione del proprietario).
- Per un ordine con il consenso al talent pool il link vale «Fino a fine consenso»: finché dura il consenso; alla revoca o alla cancellazione smette di funzionare (decisione del proprietario, 5 ottobre 2026).
- Per una candidatura WhatsApp è il candidato a scegliere, tra «I tuoi documenti», quale CV mandare nella chat: il proprio o quello preparato (decisione del proprietario).
- Limite dichiarato: la copia Word è verificata con LibreOffice e con un lettore di DOCX, non con Microsoft Word.

**Attuazione (4 ottobre 2026).** PR #11539, elencata nel §9 del [report](report-cv-lettera.md).
- Il link scade quando è prevista la cancellazione: dalla data del rimborso o, se non c'è, dal caricamento del CV, più 90 giorni.
- Un ordine senza alcuna data da cui contare la cancellazione riceve un link di 30 giorni, non un link senza scadenza.
- Su WhatsApp il CV adattato è segnalato come «Proposto da noi»; quale CV il candidato manda non viene registrato.

**Attuazione (5 ottobre 2026).** PR #TBD, elencata nel §9 del [report](report-cv-lettera.md).
- Il link di un ordine con il consenso al talent pool porta una scadenza tecnica fissa, firmata come le altre, che significa «fino a fine consenso» (31 dicembre 9999): non introduce una durata.
- A ogni apertura il server rilegge l'ordine e risponde come a un link scaduto quando il consenso non c'è più, la cancellazione automatica è già passata, o la candidatura inviata non c'è più. Un link già emesso con una scadenza non si allunga se il consenso arriva dopo; gli altri ordini restano come sopra.
- Limite dichiarato: al 5 ottobre 2026 nessun codice scrive `talentPoolConsent`. Il consenso è un solo campo sì/no, letto dalla cancellazione automatica, e non sono modellati né il modo di darlo, né la revoca, né una durata. La regola vale da quando il talent pool esisterà; fino ad allora nessun ordine riceve questo link.

## 5. Allegati di una candidatura via e-mail

Fonti: [`fonti/dossier-in-un-pdf.md`](fonti/dossier-in-un-pdf.md), 111 affermazioni confermate; **la raccomandazione della ricerca non ha retto alla verifica**.

**Correzione dello studio.** Il §6 (fase 3) e la fase 3 implementata leggevano l'opuscolo SECO come regola «un solo PDF di 5 pagine e 2 MB per le e-mail dei qualificati». La frase dell'opuscolo riguarda i certificati da tenere pronti per una richiesta successiva, non l'unione di lettera e CV.

**Fatti.**
- I testi ufficiali per adulti tengono lettera e CV in file separati (pieghevole SECO, Basilea Città, San Gallo, Zurigo) o lasciano la scelta (Berna 1–2 PDF, Grigioni al massimo tre allegati). San Gallo: la lettera in un PDF, il CV con certificati e diplomi in un altro.
- «Un PDF» lo dicono jobs.ch, jobup.ch, Robert Half e yousty.ch, e intendono l'intero dossier con i certificati.
- SBB vuole il CV come documento a sé; Zurigo avverte che le piattaforme smistano i documenti in automatico. Un file unico che si apre con la lettera è il caso peggiore.
- Le istruzioni del Cantone Ticino (UOSP, 2025) nominano i file `CV_NomeCognome.pdf` e `Lettera_NomeCognome.pdf`, 2–3 MB in tutto, e scrivono nell'e-mail «In allegato trovate il mio curriculum vitae e la mia lettera di motivazione».
- Su una cosa le fonti concordano: seguire l'annuncio; solo PDF; pochi allegati, piccoli e con nomi chiari; certificati raggruppati, mai un file ciascuno.

**Decisione.**
- Default: lettera e CV partono come due PDF separati e nominati, come oggi. `ASSISTED_APPLICATION_DOSSIER_MODE` resta `separate`.
- Vince l'annuncio: se le sue istruzioni chiedono un unico PDF, parte un PDF unico; se chiedono file separati, restano separati anche a interruttore acceso.
- I documenti richiesti dall'annuncio (certificati, diplomi) partono raggruppati in un solo PDF quando sono due o più e si possono unire (3 MB al massimo), mai un file ciascuno.
- La frase dell'e-mail resta «in allegato il CV e la lettera», vera in ogni caso.
- Di ogni invio resta un registro: cosa è partito, in che forma e perché, con quale renderer è stata composta la lettera. La lettera partita viene salvata nella cartella dell'ordine e cancellata con l'ordine.

**Osservazioni delle fonti non trasformate in codice.** L'orario d'ufficio per l'invio (deciso: nessuna finestra, §14); evitare indirizzi generici come info@ se l'annuncio non li indica; il mittente dovrebbe essere l'indirizzo del candidato (oggi è l'alias dell'ordine, scelta del servizio).

**Come si cambia.** `node scripts/assisted-application/rc-switches.mjs set ASSISTED_APPLICATION_DOSSIER_MODE=single --apply` unisce lettera, CV e documenti per gli adulti via e-mail. Le fonti non lo sostengono come default.

## 6. Layout del CV

**Fatti.** Misure dello studio (§4) sugli stessi tre candidati: nel testo estratto, la data resta accanto al ruolo giusto in 3 casi su 3 con il layout in linea in tutti e tre gli estrattori; con la griglia «tabellare» (date a sinistra) `pdftotext` scende a 2 su 3. Il parser OpenResume riconosce le sezioni solo con i titoli in maiuscolo.

**Decisione.** Un solo layout: una colonna, date sotto il titolo del ruolo, titoli di sezione in maiuscolo, nessuna icona, font incorporato. Nessuna seconda versione tabellare: raddoppierebbe i documenti da tenere allineati per un vantaggio solo estetico.

## 7. Licenza del repository

**Fatti** (letti sul repository il 3 ottobre 2026).
- Il repository è pubblico. Il README diceva «Distribuito sotto licenza MIT» e rimandava a un file `LICENSE` che non è mai esistito; la sezione 3 dei Termini d'uso diceva che il progetto è distribuito con licenza open source su GitHub.
- Il sito indica ovunque «© Frontaliere Ticino» e, sulle immagini, «Tutti i diritti riservati». I Termini (sezione 3) permettono di riprodurre gli articoli con attribuzione e link; alcuni dati sono pubblicati con CC BY 4.0 o CC BY-NC 4.0.
- Nel repository c'è materiale di terzi: codice adattato da progetti MIT, font con licenza SIL OFL 1.1, Prebid.js e uno skill con licenza Apache-2.0, dati aperti, loghi e immagini di terzi.

**Decisione del proprietario (3 ottobre 2026).** Tutti i diritti riservati sul materiale creato da o per Frontaliere Ticino: `LICENSE.md` nella root lo dice in italiano (testo che prevale) e in inglese; README e sezione 3 dei Termini sono allineati. Restano valide le autorizzazioni già pubblicate (articoli con attribuzione e link, dataset in CC) e i diritti che GitHub dà a chi consulta un repository pubblico. Il materiale di terzi resta sotto le sue licenze, elencate in `THIRD_PARTY_NOTICES.md`, con i testi che OFL e Apache chiedono di distribuire (`public/fonts/OFL.txt`, `LICENSES/Apache-2.0.txt`).

Il modello YOLOv8n di Ultralytics, con licenza AGPL-3.0, conta i veicoli nelle webcam di confine e resta in uso (decisione del proprietario): i Termini (sezione 3.2) lo dichiarano e rimandano alle note sui terzi, che riportano licenza, sorgente e revisione del file.

**Limite.** La dichiarazione MIT è stata pubblica dal 27 maggio 2026: cosa valga per le copie prese in quel periodo è una questione legale che il nuovo testo non risolve.

## 8. Gate sui fatti

**Decisione.** Bloccano (la bozza si ferma dal proprietario): uno strumento, un numero, un datore, un titolo o un permesso che i testi del candidato non sostengono. Segnalano soltanto: una parola con la maiuscola ripresa dall'annuncio, un titolo tedesco dopo «als», le frasi fatte, la lunghezza.

**Regole precisate il 3 ottobre 2026.** Due eccezioni introdotte quel giorno per una bozza reale lasciavano passare affermazioni inventate: uno strumento nominato dall'annuncio passava se la frase conteneva un verbo «imparare» a qualunque tempo o una negazione qualsiasi («I learned Kubernetes», «ohne Probleme»), e «Java» risultava sostenuto da «JavaScript». La regola: l'eccezione vale solo per una lacuna detta onestamente (intenzione di imparare, o mancanza dichiarata) senza alcun segnale di possesso; un token «incollato» dal PDF vale solo per i livelli («B1Intermedio») o davanti a una parola di livello; le cifre di un numero di telefono non sostengono un numero della lettera. Una bozza scritta con regole più larghe che non supera il gate all'invio mostra gli avvisi al proprietario, che può confermarli e rilanciare.

## 9. Dove si compone il PDF

**Fatti.** Dal deploy del renderer Typst (2 ottobre 2026) le bozze completate hanno lettera e CV composti con Typst. Un errore di Typst non ferma il documento: ricade sul generatore di riserva, che non stampa lettere come «č» e perde il layout svizzero. Al 3 ottobre 2026 una ricaduta lascia solo una riga di log.

**Decisione.** Typst resta il renderer nel runner e nelle Cloud Functions. Una funzione pianificata lo verifica (lettera e CV sintetici, testo riletto) dopo ogni deploy e almeno una volta al giorno; l'esito è nella coda del proprietario, che vede anche, bozza per bozza, quando un documento è uscito dal generatore di riserva. La funzione in cui il proprietario modifica la lettera ha la stessa memoria di quella del candidato.

**Verifica in produzione.** La prima autoverifica nelle Cloud Functions (3 ottobre 2026, Node 22) ha composto lettera e CV con Typst e il font incorporato: esito ok.

**Come si cambia.** `node scripts/assisted-application/rc-switches.mjs set ASSISTED_APPLICATION_PDF_RENDERER=legacy --apply` riporta il generatore di riserva senza deploy.

## 10. Firma

Fonti: [`fonti/firma.md`](fonti/firma.md), 66 affermazioni confermate; la proposta di offrire il caricamento di una firma **non ha retto alla verifica**.

**Fatti.**
- Il nome dattiloscritto basta per le candidature online secondo jobs.ch, jobup.ch e la guida dell'ETH (la firma «può essere inserita scansionata o omessa del tutto»); i modelli della Città di Lugano e il modello SDBB in tedesco finiscono con il solo nome. Alcune guide, soprattutto per gli apprendistati, chiedono ancora la firma; l'Università di Basilea la elenca tra gli elementi obbligatori. Le fonti divergono, e le guide per adulti del Cantone dei Grigioni (2025), di Neuchâtel (2026) e la scheda 2025 dell'orientamento ticinese non prevedono alcun passo di firma.
- Il CV in Svizzera non si firma.
- Un'immagine della firma è un dato personale che, una volta in un PDF, non si può più ritirare e si può copiare. Il datore può conservare la lettera anche dopo un rifiuto (Incaricato federale della protezione dei dati).
- Com'è il prodotto oggi: la candidatura parte da sola dopo 12 ore senza risposta (Termini, 6.1), quindi «la firma va solo nelle lettere che approvi» non sarebbe vero; il servizio è per maggiorenni; le pagine sono registrate a campione dal session replay se non sono mascherate; servirebbero un termine di conservazione dichiarato alla raccolta e una cancellazione funzionante prima di offrire il caricamento.

**Decisione.** La lettera si chiude con nome e cognome dattiloscritti, nel carattere del testo, sotto la formula di chiusura. Il servizio non crea, non disegna e non imita mai una firma, non usa un carattere «a mano», non scrive «f.to», «gez.», «signé». Nessun caricamento della firma. Lo spazio di 16 mm sopra il nome resta, per chi stampa e firma.

**Lettere a mano e moduli firmati.** Il servizio non li produce: quando un annuncio li chiede, li fornisce il candidato.

**Si riapre solo insieme a:** niente invio automatico per una lettera con firma, termine di conservazione e cancellazione immediata dell'immagine, mascheramento nel replay, informativa aggiornata.

## 11. Formule della lettera

Fonti: [`fonti/formule-della-lettera.md`](fonti/formule-della-lettera.md), 73 affermazioni confermate su 74; la verifica ha tolto tre modifiche proposte dalla ricerca e ne ha aggiunte altre, trovate eseguendo il codice.

**Decisione, per lingua.**
- **Tedesco.** «Sehr geehrte Damen und Herren», «Sehr geehrte Frau …», «Freundliche Grüsse», senza virgola; titoli accademici non stampati. Nessuno spazio prima di «%» nei composti («80%-Pensum»).
- **Francese.** «Madame, Monsieur,»; data «Lieu, le 3 octobre 2026» e «le 1er»; oggetto con elisione («au poste d'infirmière»); chiusura come frase che riprende il saluto, ultima riga del testo: «Je vous prie de recevoir, Madame, Monsieur, mes meilleures salutations.»; «Annexe :» per un solo allegato.
- **Italiano.** Senza un nome: «Gentili signore e signori,» (Cantone Ticino 2025, Cantone Grigioni 2026; la direttiva ticinese sul linguaggio inclusivo sconsiglia la coppia con due aggettivi diversi). Con un nome: «Gentile signora …,», «Gentile signor …,». «Cordiali saluti» nel blocco della firma, a destra. «1° marzo». «Allegato:» per un solo allegato. I pronomi di cortesia a inizio testo restano maiuscoli («La ringrazio»).
- **Inglese.** Nessuna virgola dopo il saluto («Dear Ms Muster»), come nella guida di stile della Cancelleria federale, edizione 2024; «Dr» senza punto; «Kind regards».
- **Il genere** della persona di contatto viene solo da un appellativo scritto dall'annuncio, nella lingua dell'annuncio; un titolo («Dott.», «Dr.») non è un genere. Un reparto, due nomi o un nome solo danno la formula senza nome.
- **Luogo e data.** Il luogo è una località, mai una via, un CAP o un Paese; senza località resta la sola data.
- **E-mail.** Saluto e chiusura li scrive il codice, gli stessi della lettera.
- **Apprendistato.** Il tipo «apprendista» vale solo per un annuncio di formazione professionale di base; «trainee», «stage» e «tirocinio formativo» non lo sono. L'oggetto diventa «Bewerbung um die Lehrstelle als …», «Candidature pour la place d'apprentissage de …», «Candidatura per un posto di tirocinio come …».

**Non cambiato, per scelta.** Margine sinistro a 25 mm (è quello dei modelli nazionali SDBB); in francese luogo e data a destra (le fonti divergono); «Gentile signor» e non «Egregio signor» (le fonti divergono; il Cantone Ticino usa «Gentile»).

## 12. A/B test dei template

**Fatti.** 16 ordini in tutto. Lo studio (§6) chiedeva di fissare prima la regola di decisione e di misurare il tasso di risposta dei datori entro 21 giorni.

**Decisione.** Nessun esperimento ora: con questo volume un confronto non dà un risultato leggibile. Quando ci saranno abbastanza invii, l'esperimento passa da Firebase Remote Config (regola del workspace), mai da altri sistemi. Nel frattempo restano registrati, per ogni bozza, la scelta del candidato tra CV adattato e originale e il renderer.

## 13. Interruttori Remote Config

| Parametro | Valore deciso | Effetto | Altri valori |
|---|---|---|---|
| `ASSISTED_APPLICATION_PDF_RENDERER` | `typst` | Lettera e CV composti con Typst | `legacy`: generatore di riserva |
| `ASSISTED_APPLICATION_DOSSIER_MODE` | `separate` | Lettera e CV in due PDF | `single`: un PDF unico per gli adulti via e-mail |
| `ASSISTED_APPLICATION_DOCX_INPLACE` | `off` | Nessun file Word in-place | `on`: terza scelta di CV per chi carica un Word |

Un parametro assente vale come il valore deciso. I valori di questi tre parametri non sono segreti e non vengono mascherati nei log dei workflow.

## 14. Orario d'invio

**Fatti.** Una candidatura via e-mail parte appena approvata dal candidato o, senza risposta, dopo 12 ore, anche di notte o nel weekend. Le guide di Basilea Città (8–17) e dell'orientamento ticinese (8–19, giorni feriali) consigliano l'orario d'ufficio.

**Decisione del proprietario (3 ottobre 2026).** Nessuna finestra d'invio: nessun ritardo per il candidato.

## 15. Immagini di terzi negli articoli

**Fatti.** Il generatore degli articoli cerca le copertine su Wikimedia Commons e ne salva l'indirizzo, ma non l'autore né la licenza (`iiprop=url|size|mime`). Le mappe dei due repository elencano 1.504 copertine prese da Commons, di cui 1.475 in articoli pubblicati; sono immagini Creative Commons che chiedono di citare autore e licenza. I dati strutturati (`imageObjectLd`) le dichiarano tutte «© 2024–2026 Frontaliere Ticino. Tutti i diritti riservati.», e nessuna pagina mostra un credito.

**Decisione del proprietario (3 ottobre 2026).** Si recuperano autore e licenza di ogni immagine da Commons e si correggono i dati strutturati (autore, licenza, link alla pagina del file). Quando la licenza chiede un testo visibile, il credito compare in fondo all'articolo, non sotto la copertina. Il generatore salva autore e licenza delle immagini nuove. I Termini (sezione 3.1) già non rivendicano le immagini di terzi.

**Attuazione (4 ottobre 2026).** Le PR sono elencate nel §9 del [report](report-cv-lettera.md). Le scelte di dettaglio sono state proposte al proprietario il 4 ottobre e applicate in assenza di risposta:

- Copertine con persone riconoscibili (restrizione di personalità su Commons), con insegne o con funzionari (licenza GODL-India): sostituite da foto Commons senza persone, ognuna con il suo credito (25 file, 55 articoli).
- Copertine non prese da Commons (Pixabay, Pexels, generate): restano con la dicitura del sito, perché la loro provenienza non si ricostruisce dal repository.
- Una rilettura mensile di Commons, in sola lettura, apre una sola issue se un file è stato cancellato o ne sono cambiati licenza, autore o restrizioni.
- I file delle copertine sostituite restano su disco.
- Lo stesso file Commons non va su un secondo articolo finché ce n'è uno libero (il controllo è per file, non per indirizzo).
- Il credito compare anche per le immagini in pubblico dominio o CC0, come cortesia.
- Le 44 pagine degli articoli scritte a mano mostrano il credito come le altre.
- La mappa delle copertine del sito resta, perché due script legacy la leggono ancora; la storia completa è nel corpus.
