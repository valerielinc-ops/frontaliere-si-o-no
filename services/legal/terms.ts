import { PUBLIC_CONTACT_EMAIL } from '../publicContact';
import { legalLinks, type LegalDocument, type LegalLocale } from './types';

// Faithful localizations of the existing Italian terms. Legal policy is unchanged.
// HTML is repository-owned copy; placeholders accept only local routes and the public contact.
const DOCUMENTS: Record<LegalLocale, LegalDocument> = {
  "it": {
    "title": "Termini di Servizio",
    "description": "Termini e condizioni di utilizzo di Frontaliere Ticino.",
    "updated": "Ultimo aggiornamento: 11 novembre 2026",
    "introHtml": "<p>Utilizzando la piattaforma <strong>Frontaliere Ticino</strong> (frontaliereticino.ch), accetti i seguenti termini e condizioni di utilizzo.</p>",
    "sections": [
      {
        "title": "1. Natura del Servizio",
        "blocks": [
          {
            "html": "<p> Frontaliere Ticino è una piattaforma informativa gratuita rivolta ai lavoratori frontalieri nell'area Svizzera-Italia. Il servizio include simulatori fiscali, confronti tra servizi, guide pratiche, offerte di lavoro e contenuti editoriali. </p>"
          },
          {
            "html": "<p> Tutti i calcoli, le simulazioni e le informazioni fornite hanno carattere <strong>puramente indicativo e informativo</strong>. Non costituiscono consulenza fiscale, legale o finanziaria professionale. </p>"
          }
        ]
      },
      {
        "title": "2. Esclusione di Responsabilità",
        "blocks": [
          {
            "html": "<p>Disclaimer</p>"
          },
          {
            "html": "<p> I risultati delle simulazioni fiscali, i confronti tra servizi e le informazioni pubblicate sono basati su dati disponibili pubblicamente e su modelli semplificati. Possono variare rispetto alla situazione reale dell'utente. Si raccomanda di verificare sempre con un professionista abilitato (commercialista, consulente fiscale, avvocato) prima di prendere decisioni finanziarie o legali. </p>"
          },
          {
            "html": "<p> Frontaliere Ticino non è responsabile per eventuali danni diretti o indiretti derivanti dall'utilizzo delle informazioni o dei simulatori presenti sulla piattaforma. I dati sulle offerte di lavoro sono raccolti automaticamente da fonti pubbliche e potrebbero non essere aggiornati in tempo reale. </p>"
          }
        ]
      },
      {
        "title": "3. Proprietà Intellettuale",
        "blocks": [
          {
            "html": "<p> I contenuti originali, il codice sorgente e il design di Frontaliere Ticino sono protetti dal diritto d&apos;autore: tutti i diritti riservati. Il codice è consultabile su GitHub; la pubblicazione non concede licenze oltre a quelle indicate nel file <a href=\"https://github.com/valerielinc-ops/frontaliere-si-o-no/blob/main/LICENSE.md\" target=\"_blank\" rel=\"noopener noreferrer\">LICENSE.md</a> del repository. Marchi, loghi e contenuti di terzi appartengono ai rispettivi titolari. </p>"
          },
          {
            "html": "<p> Gli articoli e i contenuti editoriali sono pubblicati a scopo informativo. Il testo degli articoli può essere riprodotto con attribuzione e link alla fonte originale, nel rispetto delle norme sul diritto d&apos;autore. Le immagini seguono la sezione 3.1, e valgono le licenze indicate sulle singole pagine (per esempio quelle dei dataset). </p>"
          },
          {
            "html": "<h3 id=\"licenza-immagini\">3.1 Licenza delle immagini</h3>"
          },
          {
            "html": "<p> Le immagini create da o per Frontaliere Ticino (grafiche, anteprime social, mappe e illustrazioni proprie) sono protette dal diritto d&apos;autore e appartengono a Frontaliere Ticino. L&apos;uso non autorizzato è vietato. Le immagini di terzi, come le fotografie di Wikimedia Commons e delle banche immagini, le locandine degli eventi, i fotogrammi delle webcam di confine e le mappe di OpenStreetMap, appartengono ai rispettivi autori e restano soggette alle loro licenze. </p>"
          },
          {
            "html": "<p> Per richiedere una licenza d&apos;uso di un&apos;immagine di Frontaliere Ticino (editoriale, commerciale o di archivio) o per concordare un&apos;attribuzione specifica, scrivere a <a href=\"mailto:info@frontaliereticino.ch\">info@frontaliereticino.ch</a> indicando l&apos;URL dell&apos;immagine, l&apos;ambito d&apos;uso previsto e la durata richiesta. </p>"
          },
          {
            "html": "<h3 id=\"software-terze-parti\">3.2 Software, font e modelli di terze parti</h3>"
          },
          {
            "html": "<p> Il sito e il suo codice usano software, font e modelli di terzi, ciascuno con la propria licenza. Tra questi: il modello YOLOv8n di Ultralytics, con licenza AGPL-3.0, che conta i veicoli nei fotogrammi delle webcam di confine; Prebid.js, con licenza Apache-2.0, per la pubblicità; i font Inter, Space Grotesk, Roboto e Source Sans 3, con licenza SIL Open Font License 1.1. L&apos;elenco completo, con le note di copyright e i testi delle licenze, è nel file <a href=\"https://github.com/valerielinc-ops/frontaliere-si-o-no/blob/main/THIRD_PARTY_NOTICES.md\" target=\"_blank\" rel=\"noopener noreferrer\">THIRD_PARTY_NOTICES.md</a> del repository. </p>"
          }
        ]
      },
      {
        "title": "4. Utilizzo Accettabile",
        "blocks": [
          {
            "html": "<p>L'utente si impegna a:</p>"
          },
          {
            "html": "<ul> <li>Utilizzare la piattaforma nel rispetto delle leggi svizzere e italiane vigenti</li> <li>Non tentare di compromettere la sicurezza o il funzionamento del servizio</li> <li>Non utilizzare sistemi automatizzati per accedere massivamente ai contenuti, salvo autorizzazione</li> <li>Non ripubblicare contenuti oltre quanto consentito dalla sezione 3</li> </ul>"
          }
        ]
      },
      {
        "title": "5. Comunicazioni email",
        "blocks": [
          {
            "html": "<p> Registrandoti al sito, tramite email o tramite un sistema di accesso federato, accetti questi Termini e iscrivi il tuo indirizzo al rapporto base di comunicazioni di Frontaliere Ticino: newsletter, job alert, messaggi di servizio e comunicazioni promozionali di terzi. Non è richiesta una casella di consenso separata: la registrazione e questa informativa descrivono le comunicazioni incluse. </p>"
          },
          {
            "html": "<p> Il canale di registrazione può fornire i criteri iniziali dell&apos;alert: una categoria e parole chiave dal jobboard, la ricerca effettuata, il contesto del calcolatore o della pagina visitata. Per le iscrizioni generiche l&apos;alert parte ampio e si perfeziona con le successive ricerche, visite e offerte consultate. Puoi gestire i canali e le preferenze nella pagina <a href=\"{{communications}}\">Comunicazioni</a>. </p>"
          },
          {
            "html": "<p> Salvare un lavoro o seguire un&apos;azienda attiva inoltre il relativo canale aggiuntivo. La pubblicità di terzi non è un percorso di iscrizione separato: è compresa nel rapporto base e attiva in partenza. Puoi disattivarla in qualsiasi momento dal centro preferenze, senza disattivare newsletter o job alert. </p>"
          }
        ]
      },
      {
        "title": "6. Candidatura assistita a pagamento",
        "id": "candidatura-assistita",
        "blocks": [
          {
            "html": "<p><strong>6.1 Il servizio.</strong> Con un pagamento unico prepariamo la candidatura per un solo annuncio. Lettera di presentazione, email per l’azienda e risposte al modulo sono redatte con l’aiuto di un modello di intelligenza artificiale sulla base del tuo CV e dei dati che ci fornisci, controllate da un’operatrice e sottoposte alla tua approvazione: puoi correggerle o chiedere una nuova versione. Le richieste di documenti e le risposte si svolgono sempre nella pagina protetta della candidatura; le email servono solo ad avvisarti e a fornire il collegamento. Se il bando richiede una busta cartacea, la pagina prepara un unico PDF con il CV e le scansioni digitali richieste che fornisci. Le scansioni caricate e quelle selezionate come locali vengono unite al PDF; queste ultime restano nella memoria del browser e non vengono trasmesse ai nostri server. I PDF firmati digitalmente sono inclusi come pagine, ma la fusione non conserva la verifica della firma: se il bando richiede il file originale, aggiungilo separatamente. Il dossier riporta destinatario, indirizzo completo, scadenza, dicitura sulla busta e istruzioni di spedizione. I documenti per cui risulti esente non vengono inclusi. Ricopia a mano la lettera se richiesta, completa il termine di disponibilità e selezionane una scansione locale per inserirla nel PDF; aggiungi l’originale cartaceo se il bando lo richiede. Il sistema non crea certificati originali o moduli cartacei. La busta la prepari e la spedisci tu: non la inviamo per tuo conto. L’eventuale attesa di 12 ore riguarda soltanto gli invii elettronici; una candidatura cartacea non viene mai spedita automaticamente. Non siamo un’agenzia di collocamento né affiliati all’azienda, e non garantiamo risposta, colloquio o assunzione.</p>"
          },
          {
            "html": "<p> <strong>6.2 Il mandato.</strong> Con la conferma prima del caricamento del CV ci conferisci un mandato limitato a quell’annuncio per preparare e inviare a tuo nome la candidatura per via elettronica oppure, se il bando richiede una busta cartacea, predisporre nella pagina protetta i materiali e le indicazioni per la spedizione, che resta a tuo carico; creare, se il portale lo richiede, un account a tuo nome con un indirizzo email dedicato alla candidatura e una password casuale; accettare per tuo conto le condizioni d’uso, l’informativa sulla protezione dei dati e le altre dichiarazioni che l’azienda o il portale richiedono per ricevere la candidatura, solo nella misura necessaria all’invio; ricevere sull’indirizzo dedicato le risposte dell’azienda e inoltrartele; inviare, se l’azienda non risponde a una candidatura partita per email, fino a due brevi solleciti a tuo nome, che ti mostriamo prima. Non accettiamo mai per tuo conto consensi facoltativi (newsletter, marketing, avvisi di lavoro, talent pool, condivisione con altre aziende) né dichiarazioni che solo tu puoi rendere: in quei casi ti chiediamo di rispondere o di completare tu il passaggio. Puoi revocare il mandato prima dell’invio elettronico o della messa a disposizione dei materiali cartacei scrivendo a <a href=\"mailto:{{email}}\">{{email}}</a>. </p>"
          },
          {
            "html": "<p> <strong>6.3 I tuoi impegni.</strong> Dichiari che il CV, i documenti e i dati che ci fornisci sono veritieri, aggiornati e tuoi, e che puoi comunicarli all&apos;azienda. Le risposte che solo tu puoi dare (permesso di lavoro, disponibilità, pretese salariali, domande del portale) le fornisci tu; del contenuto della candidatura che approvi rispondi tu nei confronti dell&apos;azienda. </p>"
          },
          {
            "html": "<p> <strong>6.4 Azienda e portali.</strong> Dopo l&apos;invio, il trattamento dei tuoi dati da parte dell&apos;azienda o del portale è regolato dalle loro condizioni e dalla loro informativa privacy, di cui non siamo responsabili. Non aggiriamo controlli anti-robot, verifiche di identità o altri controlli del portale: se il portale li richiede, ti passiamo il collegamento e le risposte preparate perché tu completi l&apos;invio dal tuo browser. </p>"
          },
          {
            "html": "<p> <strong>6.5 Pagamento, avvio del servizio e rimborso.</strong> Il processo si considera avviato quando, dopo il pagamento, il conferimento del mandato e la verifica del CV, iniziamo a preparare la candidatura: è il momento in cui parte la redazione della prima bozza, che registriamo con data e ora. Per la ricerca automatizzata (6.8) il processo si considera avviato quando, dopo il pagamento, carichi il CV con il consenso richiesto e parte la ricerca delle posizioni. Prima dell’avvio puoi chiedere il rimborso dell’intero importo scrivendo a <a href=\"mailto:{{email}}\">{{email}}</a>; se il processo non può essere avviato per una causa che dipende da noi, ti rimborsiamo l’intero importo anche senza richiesta. Una volta avviato il processo, il corrispettivo non è rimborsabile in nessun caso, anche se l’annuncio viene chiuso o ritirato dal datore di lavoro, se revochi il mandato o ritiri la candidatura, o se l’azienda non risponde. Se l’annuncio viene chiuso o ritirato prima dell’invio, la candidatura viene ritirata e te lo comunichiamo. Con la conferma del mandato chiedi espressamente che il servizio inizi subito, prima della scadenza dell’eventuale termine di recesso, e prendi atto che, se la legge applicabile ti riconosce un diritto di recesso, lo perdi per i servizi digitali dall’inizio della loro esecuzione e, per gli altri servizi, una volta che sono stati interamente prestati; se recedi prima, dove la legge lo consente, sei tenuto a pagare un importo proporzionale alla parte di servizio già prestata. Il servizio è interamente prestato con l’invio elettronico della candidatura oppure con la messa a disposizione nella pagina dei materiali e delle istruzioni per l’invio cartaceo. Restano salvi i diritti inderogabili che la legge applicabile riconosce ai consumatori, compresi i rimedi se il servizio non viene prestato per una causa che dipende da noi. Per le candidature il cui mandato è stato confermato con una versione precedente di questi Termini resta valida la regola di rimborso accettata allora. </p>"
          },
          {
            "html": "<p> <strong>6.6 Dati personali.</strong> Come trattiamo il CV, i documenti caricati, i dati e le email di questa candidatura (fornitori, conservazione di 90 giorni, diritti) è descritto nell&apos; <a href=\"{{privacy}}\">informativa privacy</a>, alla voce «Candidatura assistita a pagamento». </p>"
          },
          {
            "html": "<p> <strong>6.7 Responsabilità.</strong> Nei limiti consentiti dalla legge, la nostra responsabilità per il servizio è limitata all&apos;importo pagato, salvo dolo o colpa grave. </p>"
          },
          {
            "html": "<p> <strong>6.8 Ricerca automatizzata.</strong> Il servizio da 39,99 € è un incarico una tantum senza rinnovo automatico: resta disponibile per 30 giorni dall&apos;accredito e comprende al massimo 10 posizioni accettate. Il sistema può usare il CV per cercare e ordinare le offerte pubblicate, ma ogni proposta resta soggetta alla tua scelta; il caricamento o l&apos;analisi del CV non costituiscono una promessa di candidatura o di assunzione. Per ogni posizione che accetti, il mandato comprende la preparazione e l&apos;invio elettronico a tuo nome oppure, se il bando richiede una candidatura cartacea, la messa a disposizione nella pagina protetta dei materiali e delle indicazioni per spedirli, con la busta a tuo carico; la creazione di un account se necessaria e l&apos;accettazione delle sole condizioni e informative privacy necessarie all&apos;invio elettronico. Non comprende mai consensi facoltativi né la spedizione della busta per tuo conto. Il servizio da 1,99 € resta limitato all&apos;annuncio indicato. </p>"
          }
        ]
      },
      {
        "title": "7. Modifiche ai Termini",
        "blocks": [
          {
            "html": "<p> Ci riserviamo il diritto di modificare questi termini in qualsiasi momento. Le modifiche saranno pubblicate su questa pagina con la data di aggiornamento. L'uso continuato della piattaforma dopo la pubblicazione delle modifiche costituisce accettazione dei nuovi termini. </p>"
          }
        ]
      },
      {
        "title": "8. Contatti",
        "blocks": [
          {
            "html": "<p> Per domande o chiarimenti sui presenti termini di servizio, puoi contattarci tramite la <a href=\"{{contact}}\">pagina contatti</a> o la <a href=\"{{privacy}}\">pagina privacy</a>. </p>"
          }
        ]
      }
    ]
  },
  "en": {
    "title": "Terms of Service",
    "description": "Terms and conditions for using Frontaliere Ticino.",
    "updated": "Last updated: 11 November 2026",
    "introHtml": "<p>By using the <strong>Frontaliere Ticino</strong> platform (frontaliereticino.ch), you accept the following terms and conditions of use.</p>",
    "sections": [
      {
        "title": "1. Nature of the service",
        "blocks": [
          {
            "html": "<p>Frontaliere Ticino is a free information platform for cross-border workers in the Switzerland–Italy area. The service includes tax simulators, service comparisons, practical guides, job listings and editorial content.</p>"
          },
          {
            "html": "<p>All calculations, simulations and information provided are <strong>purely indicative and informational</strong>. They do not constitute professional tax, legal or financial advice.</p>"
          }
        ]
      },
      {
        "title": "2. Disclaimer of liability",
        "blocks": [
          {
            "html": "<p>Disclaimer</p>"
          },
          {
            "html": "<p>The results of tax simulations, service comparisons and published information are based on publicly available data and simplified models. They may differ from the user’s actual circumstances. Always check with a qualified professional (accountant, tax adviser or lawyer) before making financial or legal decisions.</p>"
          },
          {
            "html": "<p>Frontaliere Ticino is not liable for any direct or indirect damage arising from the use of information or simulators on the platform. Job listing data is collected automatically from public sources and may not be updated in real time.</p>"
          }
        ]
      },
      {
        "title": "3. Intellectual property",
        "blocks": [
          {
            "html": "<p>The original content, source code and design of Frontaliere Ticino are protected by copyright: all rights reserved. The code is available to view on GitHub; publication grants no licences beyond those specified in the repository’s <a href=\"https://github.com/valerielinc-ops/frontaliere-si-o-no/blob/main/LICENSE.md\" target=\"_blank\" rel=\"noopener noreferrer\">LICENSE.md</a> file. Third-party trademarks, logos and content belong to their respective owners.</p>"
          },
          {
            "html": "<p>Articles and editorial content are published for information purposes. Article text may be reproduced with attribution and a link to the original source, subject to copyright rules. Images are governed by section 3.1, and any licences stated on individual pages (for example, dataset licences) apply.</p>"
          },
          {
            "html": "<h3 id=\"licenza-immagini\">3.1 Image licensing</h3>"
          },
          {
            "html": "<p>Images created by or for Frontaliere Ticino (its own graphics, social previews, maps and illustrations) are protected by copyright and belong to Frontaliere Ticino. Unauthorised use is prohibited. Third-party images, such as photographs from Wikimedia Commons and image libraries, event posters, border webcam frames and OpenStreetMap maps, belong to their respective authors and remain subject to their licences.</p>"
          },
          {
            "html": "<p>To request a licence to use a Frontaliere Ticino image (for editorial, commercial or archival purposes), or to agree on specific attribution, write to <a href=\"mailto:info@frontaliereticino.ch\">info@frontaliereticino.ch</a>, stating the image URL, intended use and requested duration.</p>"
          },
          {
            "html": "<h3 id=\"software-terze-parti\">3.2 Third-party software, fonts and models</h3>"
          },
          {
            "html": "<p>The site and its code use third-party software, fonts and models, each with its own licence. These include Ultralytics’ YOLOv8n model, licensed under AGPL-3.0, which counts vehicles in border webcam frames; Prebid.js, licensed under Apache-2.0, for advertising; and the Inter, Space Grotesk, Roboto and Source Sans 3 fonts, licensed under the SIL Open Font License 1.1. The complete list, copyright notices and licence texts are in the repository’s <a href=\"https://github.com/valerielinc-ops/frontaliere-si-o-no/blob/main/THIRD_PARTY_NOTICES.md\" target=\"_blank\" rel=\"noopener noreferrer\">THIRD_PARTY_NOTICES.md</a> file.</p>"
          }
        ]
      },
      {
        "title": "4. Acceptable use",
        "blocks": [
          {
            "html": "<p>The user agrees to:</p>"
          },
          {
            "html": "<ul><li>Use the platform in compliance with applicable Swiss and Italian law</li><li>Not attempt to compromise the security or operation of the service</li><li>Not use automated systems to access content in bulk without authorisation</li><li>Not republish content beyond what section 3 permits</li></ul>"
          }
        ]
      },
      {
        "title": "5. Email communications",
        "blocks": [
          {
            "html": "<p>By registering on the site, by email or through a federated sign-in system, you accept these Terms and enrol your address in Frontaliere Ticino’s basic communications relationship: newsletters, job alerts, service messages and third-party promotional communications. No separate consent checkbox is required: registration and this notice describe the communications included.</p>"
          },
          {
            "html": "<p>The registration channel may supply the initial alert criteria: a category and keywords from the job board, your search, or the context of the calculator or page visited. For general registrations, the alert starts broadly and is refined by subsequent searches, visits and job listings viewed. You can manage channels and preferences on the <a href=\"{{communications}}\">Communications</a> page.</p>"
          },
          {
            "html": "<p>Saving a job or following a company also activates the corresponding additional channel. Third-party advertising is not a separate sign-up path: it is included in the basic relationship and enabled initially. You can disable it at any time in the preference centre without disabling newsletters or job alerts.</p>"
          }
        ]
      },
      {
        "title": "6. Paid assisted job application",
        "id": "candidatura-assistita",
        "blocks": [
          {
            "html": "<p><strong>6.1 The service.</strong> For a one-off payment, we prepare an application for one job listing. The cover letter, email to the company and form answers are drafted with the assistance of an artificial intelligence model using your CV and the information you provide, checked by an operator and submitted for your approval: you may correct them or request a new version. Document requests and answers always take place on the protected application page; emails only notify you and provide its link. If the listing requires a paper application, the page prepares one PDF with your CV and the requested digital scans you provide. Uploaded scans and scans selected as local files are merged into the PDF; local files stay in your browser memory and are not transmitted to our servers. Digitally signed PDFs are included as pages, but merging does not preserve signature verification: add the original file separately if the posting requires it. The packet shows the recipient, full mailing address, deadline, envelope marking and mailing instructions. Exempt documents are excluded. If a handwritten letter is required, copy it by hand, complete your availability term and select a local scan to include it in the PDF; add the paper original if the posting requires it. The system does not create original certificates or paper forms. You prepare and mail the envelope yourself; we do not mail it on your behalf. Any 12-hour waiting period applies only to electronic submissions; a paper application is never mailed automatically. We are not an employment agency or affiliated with the company, and we do not guarantee a response, interview or hiring.</p>"
          },
          {
            "html": "<p><strong>6.2 The mandate.</strong> By confirming before uploading your CV, you grant us a mandate limited to that listing to prepare and submit the application electronically on your behalf or, if the listing requires a paper application, to make the materials and mailing instructions available on the protected page for you to send; create an account in your name, if the portal requires it, using an email address dedicated to the application and a random password; accept on your behalf the terms of use, data protection notice and other declarations required by the company or portal to receive the application, only to the extent necessary for electronic submission; receive the company’s replies at the dedicated address and forward them to you; and, if the company does not respond to an application sent by email, send up to two short follow-ups on your behalf, which we show you beforehand. We never accept optional consents on your behalf (newsletters, marketing, job alerts, talent pools or sharing with other companies), nor declarations that only you can make: in those cases, we ask you to respond or complete the step yourself. You may revoke the mandate before electronic submission or before the paper materials are made available by writing to <a href=\"mailto:{{email}}\">{{email}}</a>. </p>"
          },
          {
            "html": "<p><strong>6.3 Your commitments.</strong> You declare that the CV, documents and information you provide are truthful, up to date and yours, and that you may disclose them to the company. You supply answers that only you can give (work permit, availability, salary expectations and portal questions); you are responsible towards the company for the content of the application you approve.</p>"
          },
          {
            "html": "<p><strong>6.4 Companies and portals.</strong> After submission, the company’s or portal’s processing of your data is governed by their terms and privacy notice, for which we are not responsible. We do not bypass anti-bot checks, identity verification or other portal checks: if the portal requires them, we provide you with the link and prepared answers so you can complete submission in your browser.</p>"
          },
          {
            "html": "<p><strong>6.5 Payment, start of the service and refunds.</strong> The process starts when, after payment, the grant of the mandate and the check of your CV, we begin preparing the application: this is when drafting of the first version begins, a moment we record with its date and time. For the automated search (6.8), the process starts when, after payment, you upload your CV with the required consent and the search for positions begins. Before the process starts, you may request a refund of the full amount by writing to <a href=\"mailto:{{email}}\">{{email}}</a>; if the process cannot be started for a reason attributable to us, we refund the full amount even without a request. Once the process has started, the fee is non-refundable in all cases, including where the job listing is closed or withdrawn by the employer, where you revoke the mandate or withdraw the application, or where the company does not reply. If the job listing is closed or withdrawn before submission, the application is withdrawn and we inform you. By confirming the mandate you expressly request that the service start immediately, before any withdrawal period expires, and you acknowledge that, where applicable law grants you a right of withdrawal, you lose it for digital services once their performance has begun and, for other services, once they have been fully performed; if you withdraw earlier, where the law allows, you must pay an amount proportionate to the part of the service already provided. The service is fully performed when the application is submitted electronically or when the materials and instructions for paper submission are made available on the page. This is without prejudice to the mandatory rights that applicable law grants you as a consumer, including remedies where the service is not provided for a reason attributable to us. For applications whose mandate was confirmed under an earlier version of these Terms, the refund rule accepted at that time continues to apply. </p>"
          },
          {
            "html": "<p><strong>6.6 Personal data.</strong> How we process the CV, uploaded documents, data and emails for this application (providers, 90-day retention and rights) is described in the <a href=\"{{privacy}}\">privacy notice</a>, under “Paid assisted job application”. </p>"
          },
          {
            "html": "<p><strong>6.7 Liability.</strong> To the extent permitted by law, our liability for the service is limited to the amount paid, except in cases of intent or gross negligence.</p>"
          },
          {
            "html": "<p><strong>6.8 Automated search service.</strong> The €39.99 service is a one-off engagement with no automatic renewal: it remains available for 30 days after payment and includes up to 10 positions you accept. The system may use your CV to search and rank published listings, but every proposal remains subject to your choice; uploading or analysing the CV is not a promise of an application or employment. For every position you accept, the mandate covers preparing and submitting the application electronically in your name or, for a paper application, making the materials and mailing instructions available for you to send; creating an account if necessary; and accepting only the terms and privacy notices necessary for electronic submission. It never covers optional consents or mailing a paper envelope on your behalf. The €1.99 service remains limited to the listing identified.</p>"
          }
        ]
      },
      {
        "title": "7. Changes to these terms",
        "blocks": [
          {
            "html": "<p>We reserve the right to change these terms at any time. Changes will be published on this page with the update date. Continued use of the platform after publication of the changes constitutes acceptance of the new terms.</p>"
          }
        ]
      },
      {
        "title": "8. Contact",
        "blocks": [
          {
            "html": "<p>For questions or clarification about these terms of service, you can contact us through the <a href=\"{{contact}}\">contact page</a> or the <a href=\"{{privacy}}\">privacy page</a>.</p>"
          }
        ]
      }
    ]
  },
  "de": {
    "title": "Nutzungsbedingungen",
    "description": "Bedingungen für die Nutzung von Frontaliere Ticino.",
    "updated": "Letzte Aktualisierung: 11. November 2026",
    "introHtml": "<p>Mit der Nutzung der Plattform <strong>Frontaliere Ticino</strong> (frontaliereticino.ch) akzeptieren Sie die folgenden Nutzungsbedingungen.</p>",
    "sections": [
      {
        "title": "1. Art des Dienstes",
        "blocks": [
          {
            "html": "<p>Frontaliere Ticino ist eine kostenlose Informationsplattform für Grenzgänger im Raum Schweiz–Italien. Der Dienst umfasst Steuerrechner, Dienstleistungsvergleiche, praktische Ratgeber, Stellenangebote und redaktionelle Inhalte.</p>"
          },
          {
            "html": "<p>Sämtliche Berechnungen, Simulationen und Informationen dienen <strong>ausschliesslich der Orientierung und Information</strong>. Sie stellen keine professionelle Steuer-, Rechts- oder Finanzberatung dar.</p>"
          }
        ]
      },
      {
        "title": "2. Haftungsausschluss",
        "blocks": [
          {
            "html": "<p>Haftungshinweis</p>"
          },
          {
            "html": "<p>Die Ergebnisse der Steuersimulationen, Dienstleistungsvergleiche und veröffentlichten Informationen beruhen auf öffentlich zugänglichen Daten und vereinfachten Modellen. Sie können von der tatsächlichen Situation der Nutzer abweichen. Vor finanziellen oder rechtlichen Entscheidungen sollten Sie stets eine zugelassene Fachperson (Buchhaltungs-, Steuer- oder Rechtsfachperson) konsultieren.</p>"
          },
          {
            "html": "<p>Frontaliere Ticino haftet nicht für direkte oder indirekte Schäden aus der Nutzung der Informationen oder Rechner auf der Plattform. Die Daten zu Stellenangeboten werden automatisch aus öffentlichen Quellen erfasst und sind möglicherweise nicht in Echtzeit aktualisiert.</p>"
          }
        ]
      },
      {
        "title": "3. Geistiges Eigentum",
        "blocks": [
          {
            "html": "<p>Die Originalinhalte, der Quellcode und das Design von Frontaliere Ticino sind urheberrechtlich geschützt: Alle Rechte vorbehalten. Der Code kann auf GitHub eingesehen werden; die Veröffentlichung gewährt keine Lizenzen über diejenigen hinaus, die in der Datei <a href=\"https://github.com/valerielinc-ops/frontaliere-si-o-no/blob/main/LICENSE.md\" target=\"_blank\" rel=\"noopener noreferrer\">LICENSE.md</a> des Repository angegeben sind. Marken, Logos und Inhalte Dritter gehören ihren jeweiligen Rechteinhabern.</p>"
          },
          {
            "html": "<p>Artikel und redaktionelle Inhalte werden zu Informationszwecken veröffentlicht. Artikeltexte dürfen unter Nennung der Quelle und mit einem Link zur Originalquelle im Einklang mit dem Urheberrecht wiedergegeben werden. Für Bilder gilt Abschnitt 3.1; die auf einzelnen Seiten angegebenen Lizenzen (beispielsweise für Datensätze) bleiben massgeblich.</p>"
          },
          {
            "html": "<h3 id=\"licenza-immagini\">3.1 Bildlizenzen</h3>"
          },
          {
            "html": "<p>Bilder, die von oder für Frontaliere Ticino erstellt wurden (eigene Grafiken, Social-Media-Vorschaubilder, Karten und Illustrationen), sind urheberrechtlich geschützt und gehören Frontaliere Ticino. Eine nicht genehmigte Nutzung ist untersagt. Bilder Dritter, etwa Fotos von Wikimedia Commons und Bildagenturen, Veranstaltungsplakate, Aufnahmen von Grenzwebcams und OpenStreetMap-Karten, gehören ihren jeweiligen Urhebern und unterliegen weiterhin deren Lizenzen.</p>"
          },
          {
            "html": "<p>Für eine Nutzungslizenz für ein Bild von Frontaliere Ticino (redaktionell, kommerziell oder zur Archivierung) oder eine besondere Vereinbarung zur Quellenangabe schreiben Sie an <a href=\"mailto:info@frontaliereticino.ch\">info@frontaliereticino.ch</a>. Geben Sie die Bild-URL, den vorgesehenen Verwendungszweck und die gewünschte Dauer an.</p>"
          },
          {
            "html": "<h3 id=\"software-terze-parti\">3.2 Software, Schriftarten und Modelle Dritter</h3>"
          },
          {
            "html": "<p>Die Website und ihr Code verwenden Software, Schriftarten und Modelle Dritter, jeweils unter deren eigener Lizenz. Dazu gehören: das Modell YOLOv8n von Ultralytics unter AGPL-3.0, das Fahrzeuge in Aufnahmen von Grenzwebcams zählt; Prebid.js unter Apache-2.0 für Werbung; sowie die Schriftarten Inter, Space Grotesk, Roboto und Source Sans 3 unter der SIL Open Font License 1.1. Die vollständige Liste mit Urheberrechtshinweisen und Lizenztexten steht in der Datei <a href=\"https://github.com/valerielinc-ops/frontaliere-si-o-no/blob/main/THIRD_PARTY_NOTICES.md\" target=\"_blank\" rel=\"noopener noreferrer\">THIRD_PARTY_NOTICES.md</a> des Repository.</p>"
          }
        ]
      },
      {
        "title": "4. Zulässige Nutzung",
        "blocks": [
          {
            "html": "<p>Die Nutzer verpflichten sich:</p>"
          },
          {
            "html": "<ul><li>Die Plattform unter Einhaltung der geltenden schweizerischen und italienischen Gesetze zu nutzen</li><li>Nicht zu versuchen, die Sicherheit oder den Betrieb des Dienstes zu beeinträchtigen</li><li>Ohne Genehmigung keine automatisierten Systeme für massenhafte Inhaltszugriffe zu verwenden</li><li>Inhalte nicht über den in Abschnitt 3 erlaubten Umfang hinaus erneut zu veröffentlichen</li></ul>"
          }
        ]
      },
      {
        "title": "5. E-Mail-Kommunikation",
        "blocks": [
          {
            "html": "<p>Mit Ihrer Registrierung auf der Website per E-Mail oder über ein föderiertes Anmeldesystem akzeptieren Sie diese Bedingungen und melden Ihre Adresse für das grundlegende Kommunikationsverhältnis mit Frontaliere Ticino an: Newsletter, Stellenbenachrichtigungen, Servicemitteilungen und Werbemitteilungen Dritter. Ein separates Einwilligungskästchen ist nicht erforderlich: Die Registrierung und dieser Hinweis beschreiben die enthaltenen Mitteilungen.</p>"
          },
          {
            "html": "<p>Der Registrierungskanal kann die anfänglichen Kriterien einer Stellenbenachrichtigung liefern: eine Kategorie und Stichwörter aus der Stellenbörse, Ihre Suchanfrage, den Kontext des Rechners oder der besuchten Seite. Bei allgemeinen Registrierungen beginnt die Benachrichtigung breit und wird anhand späterer Suchanfragen, Besuche und angesehener Stellenangebote präzisiert. Kanäle und Einstellungen können Sie auf der Seite <a href=\"{{communications}}\">Mitteilungen</a> verwalten.</p>"
          },
          {
            "html": "<p>Das Speichern einer Stelle oder das Folgen eines Unternehmens aktiviert zusätzlich den entsprechenden Kanal. Werbung Dritter ist kein gesonderter Anmeldeweg: Sie gehört zum grundlegenden Verhältnis und ist anfangs aktiviert. Sie können sie jederzeit im Einstellungszentrum deaktivieren, ohne Newsletter oder Stellenbenachrichtigungen abzuschalten.</p>"
          }
        ]
      },
      {
        "title": "6. Kostenpflichtige Bewerbungsunterstützung",
        "id": "candidatura-assistita",
        "blocks": [
          {
            "html": "<p><strong>6.1 Der Dienst.</strong> Gegen eine einmalige Zahlung bereiten wir eine Bewerbung für ein einziges Stellenangebot vor. Anschreiben, E-Mail an das Unternehmen und Formularantworten werden mithilfe eines KI-Modells auf Grundlage Ihres Lebenslaufs und Ihrer Angaben verfasst, von einer Mitarbeiterin geprüft und Ihnen zur Freigabe vorgelegt: Sie können Korrekturen vornehmen oder eine neue Fassung verlangen. Anfragen zu Unterlagen und Antworten erfolgen ausschliesslich auf der geschützten Bewerbungsseite; E-Mails benachrichtigen Sie nur und enthalten den Link. Verlangt das Inserat eine Bewerbung auf Papier, erstellt die Seite ein einziges PDF mit Ihrem Lebenslauf und den angeforderten digitalen Scans, die Sie bereitstellen. Hochgeladene Scans und lokal ausgewählte Scans werden in das PDF eingefügt; lokale Dateien bleiben im Arbeitsspeicher des Browsers und werden nicht an unsere Server übertragen. Digital signierte PDFs werden als Seiten eingefügt, doch die Zusammenführung erhält die Signaturprüfung nicht: Wenn das Inserat die Originaldatei verlangt, fügen Sie sie separat bei. Das Dossier nennt Empfänger, vollständige Postadresse, Frist, Umschlagvermerk und Versandhinweise. Befreite Unterlagen werden ausgeschlossen. Schreiben Sie ein verlangtes Anschreiben von Hand, ergänzen Sie Ihre Verfügbarkeit und wählen Sie einen lokalen Scan zur Aufnahme in das PDF aus; legen Sie das Papieroriginal zusätzlich bei, wenn das Inserat es verlangt. Originalzeugnisse und Papierformulare erstellt das System nicht. Sie bereiten den Umschlag vor und senden ihn selbst; wir versenden ihn nicht in Ihrem Namen. Eine Wartefrist von 12 Stunden gilt nur für elektronische Bewerbungen; eine Papierbewerbung wird niemals automatisch versandt. Wir sind weder eine Arbeitsvermittlung noch mit dem Unternehmen verbunden und garantieren weder Antwort noch Vorstellungsgespräch oder Anstellung.</p>"
          },
          {
            "html": "<p><strong>6.2 Der Auftrag.</strong> Mit der Bestätigung vor dem Hochladen Ihres Lebenslaufs erteilen Sie uns einen auf dieses Stellenangebot beschränkten Auftrag: die Bewerbung in Ihrem Namen elektronisch vorzubereiten und zu versenden oder, falls das Inserat eine Papierbewerbung verlangt, die Unterlagen und Versandhinweise auf der geschützten Seite bereitzustellen, damit Sie den Brief selbst versenden; falls das Portal es verlangt, ein Konto in Ihrem Namen mit einer eigens für die Bewerbung eingerichteten E-Mail-Adresse und einem zufälligen Passwort anzulegen; in Ihrem Namen die Nutzungsbedingungen, Datenschutzhinweise und sonstigen Erklärungen zu akzeptieren, die das Unternehmen oder Portal für den Empfang der elektronischen Bewerbung verlangt, ausschliesslich soweit dies dafür erforderlich ist; Antworten des Unternehmens unter der zugehörigen Adresse zu empfangen und an Sie weiterzuleiten; und bei einer unbeantworteten Bewerbung per E-Mail bis zu zwei kurze Nachfragen in Ihrem Namen zu senden, die wir Ihnen vorher zeigen. Wir erteilen niemals in Ihrem Namen freiwillige Einwilligungen (Newsletter, Marketing, Stellenbenachrichtigungen, Talentpool, Weitergabe an andere Unternehmen) oder Erklärungen, die nur Sie abgeben können: In diesen Fällen bitten wir Sie, selbst zu antworten oder den Schritt abzuschliessen. Sie können den Auftrag vor der elektronischen Übermittlung oder vor der Bereitstellung der Papierunterlagen durch eine Nachricht an <a href=\"mailto:{{email}}\">{{email}}</a> widerrufen. </p>"
          },
          {
            "html": "<p><strong>6.3 Ihre Verpflichtungen.</strong> Sie erklären, dass der Lebenslauf, die Dokumente und Angaben, die Sie uns übermitteln, wahrheitsgemäss, aktuell und Ihre eigenen sind und Sie diese dem Unternehmen mitteilen dürfen. Antworten, die nur Sie geben können (Arbeitsbewilligung, Verfügbarkeit, Gehaltsvorstellungen, Portalfragen), geben Sie selbst; gegenüber dem Unternehmen sind Sie für den Inhalt der von Ihnen freigegebenen Bewerbung verantwortlich.</p>"
          },
          {
            "html": "<p><strong>6.4 Unternehmen und Portale.</strong> Nach der Übermittlung richtet sich die Verarbeitung Ihrer Daten durch das Unternehmen oder Portal nach dessen Bedingungen und Datenschutzhinweisen, für die wir nicht verantwortlich sind. Wir umgehen keine Anti-Bot-Prüfungen, Identitätsprüfungen oder sonstigen Portalkontrollen: Werden solche verlangt, übergeben wir Ihnen den Link und die vorbereiteten Antworten, damit Sie den Versand in Ihrem Browser abschliessen.</p>"
          },
          {
            "html": "<p><strong>6.5 Zahlung, Beginn der Dienstleistung und Rückerstattung.</strong> Der Prozess gilt als begonnen, sobald wir nach der Zahlung, der Erteilung des Auftrags und der Prüfung Ihres Lebenslaufs mit der Vorbereitung der Bewerbung beginnen: Das ist der Zeitpunkt, zu dem die Erstellung des ersten Entwurfs startet und den wir mit Datum und Uhrzeit erfassen. Bei der automatisierten Suche (6.8) gilt der Prozess als begonnen, sobald Sie nach der Zahlung Ihren Lebenslauf mit der verlangten Einwilligung hochladen und die Suche nach Stellen beginnt. Vor Beginn des Prozesses können Sie die Rückerstattung des vollständigen Betrags verlangen, indem Sie an <a href=\"mailto:{{email}}\">{{email}}</a> schreiben; kann der Prozess aus einem Grund, den wir zu vertreten haben, nicht begonnen werden, erstatten wir den vollständigen Betrag auch ohne Anfrage. Nach Beginn des Prozesses ist das Entgelt in keinem Fall erstattungsfähig, auch nicht, wenn das Unternehmen das Stellenangebot schliesst oder zurückzieht, wenn Sie den Auftrag widerrufen oder die Bewerbung zurückziehen oder wenn das Unternehmen nicht antwortet. Wird das Stellenangebot vor der Übermittlung geschlossen oder zurückgezogen, wird die Bewerbung zurückgezogen und wir informieren Sie darüber. Mit der Bestätigung des Auftrags verlangen Sie ausdrücklich, dass die Dienstleistung sofort beginnt, noch vor Ablauf einer allfälligen Widerrufsfrist, und nehmen zur Kenntnis, dass Sie ein Ihnen nach anwendbarem Recht zustehendes Widerrufsrecht bei digitalen Dienstleistungen mit Beginn der Ausführung und bei anderen Dienstleistungen mit ihrer vollständigen Erbringung verlieren; widerrufen Sie früher, soweit das Gesetz dies zulässt, schulden Sie einen Betrag, der dem bereits erbrachten Teil der Dienstleistung entspricht. Die Dienstleistung ist vollständig erbracht mit der elektronischen Übermittlung der Bewerbung oder sobald die Unterlagen und Hinweise für die Papierbewerbung auf der Seite bereitstehen. Zwingende Rechte, die Ihnen das anwendbare Recht als Verbraucher gewährt, bleiben vorbehalten, einschliesslich der Rechtsbehelfe, wenn die Dienstleistung aus einem von uns zu vertretenden Grund nicht erbracht wird. Für Bewerbungen, deren Auftrag unter einer früheren Fassung dieser Bedingungen bestätigt wurde, gilt weiterhin die damals akzeptierte Rückerstattungsregel. </p>"
          },
          {
            "html": "<p><strong>6.6 Personendaten.</strong> Wie wir den Lebenslauf, hochgeladene Unterlagen, Angaben und E-Mails dieser Bewerbung verarbeiten (Dienstleister, Aufbewahrung für 90 Tage, Rechte), ist in den <a href=\"{{privacy}}\">Datenschutzhinweisen</a> unter «Kostenpflichtige Bewerbungsunterstützung» beschrieben. </p>"
          },
          {
            "html": "<p><strong>6.7 Haftung.</strong> Soweit gesetzlich zulässig, ist unsere Haftung für die Dienstleistung auf den gezahlten Betrag begrenzt, ausgenommen Vorsatz oder grobe Fahrlässigkeit.</p>"
          },
          {
            "html": "<p><strong>6.8 Automatisierte Jobsuche.</strong> Der Dienst für 39,99 € ist ein einmaliger Auftrag ohne automatische Verlängerung: Er bleibt ab Zahlung 30 Tage verfügbar und umfasst bis zu 10 Stellen, die du annimmst. Das System darf deinen Lebenslauf verwenden, um veröffentlichte Stellen zu suchen und zu ordnen; jeder Vorschlag bleibt jedoch deiner Entscheidung überlassen. Das Hochladen oder die Analyse des Lebenslaufs verspricht weder eine Bewerbung noch eine Anstellung. Für jede angenommene Stelle umfasst der Auftrag die Vorbereitung und elektronische Übermittlung der Bewerbung in deinem Namen oder, wenn die Ausschreibung eine Papierbewerbung verlangt, die Bereitstellung der Unterlagen und Versandhinweise auf der geschützten Seite; den Umschlag versendest du selbst. Er umfasst auch die Erstellung eines erforderlichen Kontos und die Annahme nur der für die elektronische Übermittlung notwendigen Bedingungen und Datenschutzhinweise. Freiwillige Einwilligungen und der Versand eines Papierumschlags durch uns sind nie umfasst. Der Dienst für 1,99 € bleibt auf die angegebene Stelle beschränkt.</p>"
          }
        ]
      },
      {
        "title": "7. Änderungen der Bedingungen",
        "blocks": [
          {
            "html": "<p>Wir behalten uns das Recht vor, diese Bedingungen jederzeit zu ändern. Änderungen werden auf dieser Seite mit dem Aktualisierungsdatum veröffentlicht. Die weitere Nutzung der Plattform nach Veröffentlichung der Änderungen gilt als Zustimmung zu den neuen Bedingungen.</p>"
          }
        ]
      },
      {
        "title": "8. Kontakt",
        "blocks": [
          {
            "html": "<p>Bei Fragen oder Unklarheiten zu diesen Nutzungsbedingungen können Sie uns über die <a href=\"{{contact}}\">Kontaktseite</a> oder die <a href=\"{{privacy}}\">Datenschutzseite</a> erreichen.</p>"
          }
        ]
      }
    ]
  },
  "fr": {
    "title": "Conditions d’utilisation",
    "description": "Conditions d’utilisation de Frontaliere Ticino.",
    "updated": "Dernière mise à jour : 11 novembre 2026",
    "introHtml": "<p>En utilisant la plateforme <strong>Frontaliere Ticino</strong> (frontaliereticino.ch), vous acceptez les conditions d’utilisation suivantes.</p>",
    "sections": [
      {
        "title": "1. Nature du service",
        "blocks": [
          {
            "html": "<p>Frontaliere Ticino est une plateforme d’information gratuite destinée aux travailleurs frontaliers dans la zone Suisse–Italie. Le service comprend des simulateurs fiscaux, des comparaisons de services, des guides pratiques, des offres d’emploi et des contenus éditoriaux.</p>"
          },
          {
            "html": "<p>Tous les calculs, simulations et informations fournis sont <strong>purement indicatifs et informatifs</strong>. Ils ne constituent pas un conseil fiscal, juridique ou financier professionnel.</p>"
          }
        ]
      },
      {
        "title": "2. Exclusion de responsabilité",
        "blocks": [
          {
            "html": "<p>Avertissement</p>"
          },
          {
            "html": "<p>Les résultats des simulations fiscales, les comparaisons de services et les informations publiées reposent sur des données accessibles au public et des modèles simplifiés. Ils peuvent différer de la situation réelle de l’utilisateur. Il est recommandé de toujours vérifier auprès d’un professionnel habilité (expert-comptable, conseiller fiscal, avocat) avant de prendre une décision financière ou juridique.</p>"
          },
          {
            "html": "<p>Frontaliere Ticino n’est pas responsable des dommages directs ou indirects résultant de l’utilisation des informations ou des simulateurs de la plateforme. Les données des offres d’emploi sont collectées automatiquement auprès de sources publiques et peuvent ne pas être actualisées en temps réel.</p>"
          }
        ]
      },
      {
        "title": "3. Propriété intellectuelle",
        "blocks": [
          {
            "html": "<p>Les contenus originaux, le code source et le design de Frontaliere Ticino sont protégés par le droit d’auteur : tous droits réservés. Le code est consultable sur GitHub ; sa publication n’accorde aucune licence au-delà de celles indiquées dans le fichier <a href=\"https://github.com/valerielinc-ops/frontaliere-si-o-no/blob/main/LICENSE.md\" target=\"_blank\" rel=\"noopener noreferrer\">LICENSE.md</a> du dépôt. Les marques, logos et contenus de tiers appartiennent à leurs titulaires respectifs.</p>"
          },
          {
            "html": "<p>Les articles et contenus éditoriaux sont publiés à titre informatif. Le texte des articles peut être reproduit avec attribution et lien vers la source originale, dans le respect des règles du droit d’auteur. Les images relèvent de la section 3.1, et les licences indiquées sur les pages concernées (par exemple celles des jeux de données) s’appliquent.</p>"
          },
          {
            "html": "<h3 id=\"licenza-immagini\">3.1 Licence des images</h3>"
          },
          {
            "html": "<p>Les images créées par ou pour Frontaliere Ticino (ses propres graphismes, aperçus sociaux, cartes et illustrations) sont protégées par le droit d’auteur et appartiennent à Frontaliere Ticino. Toute utilisation non autorisée est interdite. Les images de tiers, telles que les photographies de Wikimedia Commons et des banques d’images, les affiches d’événements, les images des webcams frontalières et les cartes OpenStreetMap, appartiennent à leurs auteurs respectifs et restent soumises à leurs licences.</p>"
          },
          {
            "html": "<p>Pour demander une licence d’utilisation d’une image de Frontaliere Ticino (à des fins éditoriales, commerciales ou d’archivage), ou convenir d’une attribution particulière, écrivez à <a href=\"mailto:info@frontaliereticino.ch\">info@frontaliereticino.ch</a> en indiquant l’URL de l’image, l’utilisation envisagée et la durée souhaitée.</p>"
          },
          {
            "html": "<h3 id=\"software-terze-parti\">3.2 Logiciels, polices et modèles de tiers</h3>"
          },
          {
            "html": "<p>Le site et son code utilisent des logiciels, polices et modèles de tiers, chacun sous sa propre licence. Parmi eux : le modèle YOLOv8n d’Ultralytics, sous licence AGPL-3.0, qui compte les véhicules dans les images des webcams frontalières ; Prebid.js, sous licence Apache-2.0, pour la publicité ; les polices Inter, Space Grotesk, Roboto et Source Sans 3, sous licence SIL Open Font License 1.1. La liste complète, les mentions de copyright et les textes des licences figurent dans le fichier <a href=\"https://github.com/valerielinc-ops/frontaliere-si-o-no/blob/main/THIRD_PARTY_NOTICES.md\" target=\"_blank\" rel=\"noopener noreferrer\">THIRD_PARTY_NOTICES.md</a> du dépôt.</p>"
          }
        ]
      },
      {
        "title": "4. Utilisation acceptable",
        "blocks": [
          {
            "html": "<p>L’utilisateur s’engage à :</p>"
          },
          {
            "html": "<ul><li>Utiliser la plateforme dans le respect des lois suisses et italiennes en vigueur</li><li>Ne pas tenter de compromettre la sécurité ou le fonctionnement du service</li><li>Ne pas utiliser de systèmes automatisés pour accéder massivement aux contenus sans autorisation</li><li>Ne pas republier des contenus au-delà de ce que permet la section 3</li></ul>"
          }
        ]
      },
      {
        "title": "5. Communications par email",
        "blocks": [
          {
            "html": "<p>En vous inscrivant sur le site, par email ou via un système de connexion fédérée, vous acceptez ces Conditions et inscrivez votre adresse à la relation de base de communications de Frontaliere Ticino : newsletters, alertes emploi, messages de service et communications promotionnelles de tiers. Aucune case de consentement distincte n’est requise : l’inscription et cette information décrivent les communications incluses.</p>"
          },
          {
            "html": "<p>Le canal d’inscription peut fournir les critères initiaux de l’alerte : une catégorie et des mots-clés du portail d’emploi, la recherche effectuée, le contexte du calculateur ou de la page visitée. Pour les inscriptions générales, l’alerte est d’abord large, puis s’affine avec les recherches, visites et offres consultées. Vous pouvez gérer les canaux et préférences sur la page <a href=\"{{communications}}\">Communications</a>.</p>"
          },
          {
            "html": "<p>Enregistrer une offre ou suivre une entreprise active également le canal supplémentaire correspondant. La publicité de tiers ne fait pas l’objet d’une inscription séparée : elle est comprise dans la relation de base et activée initialement. Vous pouvez la désactiver à tout moment dans le centre de préférences sans désactiver les newsletters ni les alertes emploi.</p>"
          }
        ]
      },
      {
        "title": "6. Candidature assistée payante",
        "id": "candidatura-assistita",
        "blocks": [
          {
            "html": "<p><strong>6.1 Le service.</strong> Moyennant un paiement unique, nous préparons une candidature pour une seule offre. La lettre de motivation, l’email à l’entreprise et les réponses au formulaire sont rédigés avec l’aide d’un modèle d’intelligence artificielle à partir de votre CV et des données fournies, contrôlés par une opératrice et soumis à votre approbation : vous pouvez les corriger ou demander une nouvelle version. Les demandes de documents et les réponses passent toujours par la page sécurisée de candidature ; les emails servent uniquement à vous avertir et à fournir le lien. Si l’annonce exige un dossier papier, la page prépare un PDF unique avec votre CV et les scans numériques demandés que vous fournissez. Les scans téléversés et ceux sélectionnés comme fichiers locaux sont réunis dans le PDF ; les fichiers locaux restent dans la mémoire du navigateur et ne sont pas transmis à nos serveurs. Les PDF signés numériquement sont inclus sous forme de pages, mais la fusion ne préserve pas la vérification de la signature : joignez le fichier original séparément si l’annonce l’exige. Le dossier indique le destinataire, l’adresse postale complète, l’échéance, la mention sur l’enveloppe et les instructions d’envoi. Les documents dont vous êtes dispensé ne sont pas inclus. Si une lettre manuscrite est exigée, recopiez-la à la main, indiquez votre délai de disponibilité et sélectionnez un scan local pour l’inclure au PDF ; ajoutez aussi l’original papier si l’annonce l’exige. Le système ne crée pas les certificats originaux ni les formulaires papier. Vous préparez et envoyez vous-même l’enveloppe ; nous ne l’expédions pas en votre nom. Le délai éventuel de 12 heures concerne uniquement les envois électroniques ; une candidature papier n’est jamais envoyée automatiquement. Nous ne sommes ni une agence de placement ni affiliés à l’entreprise, et ne garantissons ni réponse, ni entretien, ni embauche.</p>"
          },
          {
            "html": "<p><strong>6.2 Le mandat.</strong> Par votre confirmation avant le téléversement du CV, vous nous confiez un mandat limité à cette offre pour préparer et envoyer la candidature par voie électronique en votre nom ou, si l’annonce exige un dossier papier, mettre à disposition sur la page sécurisée les documents et instructions afin que vous l’expédiiez vous-même ; créer, si le portail l’exige, un compte à votre nom avec une adresse email dédiée à la candidature et un mot de passe aléatoire ; accepter pour votre compte les conditions d’utilisation, la notice de protection des données et les autres déclarations que l’entreprise ou le portail exigent pour recevoir une candidature électronique, uniquement dans la mesure nécessaire à cet envoi ; recevoir les réponses de l’entreprise à l’adresse dédiée et vous les transmettre ; envoyer en votre nom jusqu’à deux brefs messages de relance, présentés au préalable, si l’entreprise ne répond pas à une candidature envoyée par email. Nous n’acceptons jamais pour votre compte des consentements facultatifs (newsletters, marketing, alertes emploi, vivier de candidats, partage avec d’autres entreprises), ni des déclarations que vous seul pouvez faire : nous vous demandons alors de répondre ou d’effectuer vous-même l’étape. Vous pouvez révoquer le mandat avant l’envoi électronique ou la mise à disposition des documents papier en écrivant à <a href=\"mailto:{{email}}\">{{email}}</a>. </p>"
          },
          {
            "html": "<p><strong>6.3 Vos engagements.</strong> Vous déclarez que le CV, les documents et les données fournis sont véridiques, à jour et vous appartiennent, et que vous pouvez les communiquer à l’entreprise. Vous fournissez les réponses que vous seul pouvez donner (permis de travail, disponibilité, prétentions salariales, questions du portail) ; vous êtes responsable envers l’entreprise du contenu de la candidature que vous approuvez.</p>"
          },
          {
            "html": "<p><strong>6.4 Entreprises et portails.</strong> Après l’envoi, le traitement de vos données par l’entreprise ou le portail est régi par leurs conditions et leur notice de confidentialité, dont nous ne sommes pas responsables. Nous ne contournons pas les contrôles anti-robots, les vérifications d’identité ni les autres contrôles du portail : s’ils sont requis, nous vous transmettons le lien et les réponses préparées pour que vous terminiez l’envoi dans votre navigateur.</p>"
          },
          {
            "html": "<p><strong>6.5 Paiement, début du service et remboursement.</strong> Le processus est considéré comme commencé lorsque, après le paiement, l’octroi du mandat et la vérification de votre CV, nous commençons à préparer la candidature : c’est le moment où débute la rédaction de la première version, que nous enregistrons avec la date et l’heure. Pour la recherche automatisée (6.8), le processus est considéré comme commencé lorsque, après le paiement, vous téléversez votre CV avec le consentement requis et que la recherche de postes débute. Avant le début du processus, vous pouvez demander le remboursement de la totalité du montant en écrivant à <a href=\"mailto:{{email}}\">{{email}}</a> ; si le processus ne peut pas commencer pour une raison qui nous est imputable, nous remboursons la totalité du montant même sans demande. Une fois le processus commencé, le prix n’est remboursable dans aucun cas, y compris lorsque l’employeur clôture ou retire l’offre, lorsque vous révoquez le mandat ou retirez la candidature, ou lorsque l’entreprise ne répond pas. Si l’offre est clôturée ou retirée avant l’envoi, la candidature est retirée et nous vous en informons. En confirmant le mandat, vous demandez expressément que le service commence immédiatement, avant l’expiration de tout délai de rétractation, et vous reconnaissez que, si la loi applicable vous accorde un droit de rétractation, vous le perdez pour les services numériques dès le début de leur exécution et, pour les autres services, une fois qu’ils ont été pleinement exécutés ; si vous vous rétractez avant, lorsque la loi le permet, vous devez payer un montant proportionnel à la partie du service déjà fournie. Le service est pleinement exécuté avec l’envoi électronique de la candidature ou la mise à disposition sur la page des documents et instructions pour l’envoi papier. Les droits impératifs que la loi applicable vous reconnaît en tant que consommateur sont réservés, y compris les recours lorsque le service n’est pas fourni pour une raison qui nous est imputable. Pour les candidatures dont le mandat a été confirmé sous une version antérieure des présentes Conditions, la règle de remboursement acceptée à ce moment continue de s’appliquer. </p>"
          },
          {
            "html": "<p><strong>6.6 Données personnelles.</strong> Le traitement du CV, des documents téléversés, des données et des emails de cette candidature (prestataires, conservation de 90 jours, droits) est décrit dans la <a href=\"{{privacy}}\">notice de confidentialité</a>, à la rubrique « Candidature assistée payante ». </p>"
          },
          {
            "html": "<p><strong>6.7 Responsabilité.</strong> Dans les limites autorisées par la loi, notre responsabilité pour le service est limitée au montant payé, sauf en cas de dol ou de faute grave.</p>"
          },
          {
            "html": "<p><strong>6.8 Recherche automatisée.</strong> Le service de 39,99 € est une prestation unique sans renouvellement automatique : il reste disponible pendant 30 jours après le paiement et comprend jusqu’à 10 postes que vous acceptez. Le système peut utiliser votre CV pour rechercher et classer les offres publiées, mais chaque proposition reste soumise à votre choix ; le téléversement ou l’analyse du CV ne promet ni candidature ni embauche. Pour chaque poste accepté, le mandat couvre la préparation et l’envoi électronique de la candidature en votre nom ou, si l’offre exige une candidature papier, la mise à disposition des documents et instructions d’envoi sur la page sécurisée ; vous envoyez vous-même l’enveloppe. Il couvre aussi la création d’un compte si nécessaire et l’acceptation des seules conditions et notices de confidentialité nécessaires à l’envoi électronique. Il ne comprend jamais les consentements facultatifs ni l’envoi de l’enveloppe par nos soins. Le service de 1,99 € reste limité à l’offre indiquée.</p>"
          }
        ]
      },
      {
        "title": "7. Modification des conditions",
        "blocks": [
          {
            "html": "<p>Nous nous réservons le droit de modifier ces conditions à tout moment. Les modifications seront publiées sur cette page avec leur date de mise à jour. La poursuite de l’utilisation de la plateforme après leur publication vaut acceptation des nouvelles conditions.</p>"
          }
        ]
      },
      {
        "title": "8. Contact",
        "blocks": [
          {
            "html": "<p>Pour toute question ou précision concernant ces conditions d’utilisation, vous pouvez nous contacter via la <a href=\"{{contact}}\">page de contact</a> ou la <a href=\"{{privacy}}\">page de confidentialité</a>.</p>"
          }
        ]
      }
    ]
  }
};

export function getTermsLegalDocument(locale: LegalLocale): LegalDocument {
  const document = DOCUMENTS[locale];
  const substitutions: Record<string, string> = { ...legalLinks(locale), email: PUBLIC_CONTACT_EMAIL };
  const resolve = (html: string) => html.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = substitutions[key];
    if (value === undefined) throw new Error(`Unknown terms link placeholder: ${key}`);
    return value;
  });
  return {
    ...document,
    introHtml: resolve(document.introHtml),
    sections: document.sections.map(section => ({
      ...section,
      blocks: section.blocks.map(block => 'html' in block ? { html: resolve(block.html) } : block),
    })),
  };
}
