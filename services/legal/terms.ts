import { PUBLIC_CONTACT_EMAIL } from '../publicContact';
import { legalLinks, type LegalDocument, type LegalLocale } from './types';

// Faithful localizations of the existing Italian terms. Legal policy is unchanged.
// HTML is repository-owned copy; placeholders accept only local routes and the public contact.
const DOCUMENTS: Record<LegalLocale, LegalDocument> = {
  "it": {
    "title": "Termini di Servizio",
    "description": "Termini e condizioni di utilizzo di Frontaliere Ticino.",
    "updated": "Ultimo aggiornamento: ottobre 2026",
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
            "html": "<p> <strong>6.1 Il servizio.</strong> Con un pagamento unico prepariamo e inviamo a tuo nome la candidatura per un solo annuncio. Lettera di presentazione, email per l&apos;azienda e risposte al modulo sono redatte con l&apos;aiuto di un modello di intelligenza artificiale sulla base del tuo CV e dei dati che ci fornisci, controllate da un&apos;operatrice e sottoposte alla tua approvazione: puoi correggerle o chiedere una nuova versione. Se non rispondi entro 12 ore dall&apos;email di revisione, la candidatura parte così com&apos;è, come indicato nell&apos;email. Non siamo un&apos;agenzia di collocamento né affiliati all&apos;azienda, e non garantiamo risposta, colloquio o assunzione. </p>"
          },
          {
            "html": "<p> <strong>6.2 Il mandato.</strong> Con la conferma prima del caricamento del CV ci conferisci un mandato limitato a quell&apos;annuncio per: inviare la candidatura a tuo nome, per email o tramite il portale dell&apos;azienda; creare, se il portale lo richiede, un account a tuo nome con un indirizzo email dedicato alla candidatura e una password casuale; accettare per tuo conto le condizioni d&apos;uso, l&apos;informativa sulla protezione dei dati e le altre dichiarazioni che l&apos;azienda o il portale richiedono per ricevere la candidatura, solo nella misura necessaria all&apos;invio; ricevere sull&apos;indirizzo dedicato le risposte dell&apos;azienda e inoltrartele; inviare, se l&apos;azienda non risponde a una candidatura partita per email, fino a due brevi solleciti a tuo nome, che ti mostriamo prima. Non accettiamo mai per tuo conto consensi facoltativi (newsletter, marketing, avvisi di lavoro, talent pool, condivisione con altre aziende) né dichiarazioni che solo tu puoi rendere: in quei casi ti chiediamo di rispondere o di completare tu il passaggio. Puoi revocare il mandato fino all&apos;invio scrivendo a <a href=\"mailto:{{email}}\">{{email}}</a>. </p>"
          },
          {
            "html": "<p> <strong>6.3 I tuoi impegni.</strong> Dichiari che il CV, i documenti e i dati che ci fornisci sono veritieri, aggiornati e tuoi, e che puoi comunicarli all&apos;azienda. Le risposte che solo tu puoi dare (permesso di lavoro, disponibilità, pretese salariali, domande del portale) le fornisci tu; del contenuto della candidatura che approvi rispondi tu nei confronti dell&apos;azienda. </p>"
          },
          {
            "html": "<p> <strong>6.4 Azienda e portali.</strong> Dopo l&apos;invio, il trattamento dei tuoi dati da parte dell&apos;azienda o del portale è regolato dalle loro condizioni e dalla loro informativa privacy, di cui non siamo responsabili. Non aggiriamo controlli anti-robot, verifiche di identità o altri controlli del portale: se il portale li richiede, ti passiamo il collegamento e le risposte preparate perché tu completi l&apos;invio dal tuo browser. </p>"
          },
          {
            "html": "<p> <strong>6.5 Pagamento e rimborso.</strong> Chiedi espressamente che il servizio inizi subito dopo il pagamento. Se l&apos;annuncio risulta chiuso prima che la candidatura sia inviata, ti rimborsiamo automaticamente l&apos;intero importo. Una volta inviata la candidatura il servizio è eseguito e l&apos;importo non è rimborsabile, fatti salvi i diritti che la legge applicabile ti riconosce come consumatore. </p>"
          },
          {
            "html": "<p> <strong>6.6 Dati personali.</strong> Come trattiamo il CV, i dati e le email di questa candidatura (fornitori, conservazione di 90 giorni, diritti) è descritto nell&apos; <a href=\"{{privacy}}\">informativa privacy</a>, alla voce «Candidatura assistita a pagamento». </p>"
          },
          {
            "html": "<p> <strong>6.7 Responsabilità.</strong> Nei limiti consentiti dalla legge, la nostra responsabilità per il servizio è limitata all&apos;importo pagato, salvo dolo o colpa grave. </p>"
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
    "updated": "Last updated: October 2026",
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
            "html": "<p><strong>6.1 The service.</strong> For a one-off payment, we prepare and submit an application on your behalf for one job listing. The cover letter, email to the company and form answers are drafted with the assistance of an artificial intelligence model using your CV and the information you provide, checked by an operator and submitted for your approval: you may correct them or request a new version. If you do not respond within 12 hours of the review email, the application is sent as it stands, as stated in that email. We are not an employment agency or affiliated with the company, and we do not guarantee a response, interview or hiring.</p>"
          },
          {
            "html": "<p><strong>6.2 The mandate.</strong> By confirming before uploading your CV, you grant us a mandate limited to that job listing to: submit the application on your behalf by email or through the company’s portal; create an account in your name, if the portal requires it, using an email address dedicated to the application and a random password; accept on your behalf the terms of use, data protection notice and other declarations required by the company or portal to receive the application, only to the extent necessary for submission; receive the company’s replies at the dedicated address and forward them to you; and, if the company does not respond to an application sent by email, send up to two short follow-ups on your behalf, which we show you beforehand. We never accept optional consents on your behalf (newsletters, marketing, job alerts, talent pools or sharing with other companies), nor declarations that only you can make: in those cases, we ask you to respond or complete the step yourself. You may revoke the mandate before submission by writing to <a href=\"mailto:{{email}}\">{{email}}</a>.</p>"
          },
          {
            "html": "<p><strong>6.3 Your commitments.</strong> You declare that the CV, documents and information you provide are truthful, up to date and yours, and that you may disclose them to the company. You supply answers that only you can give (work permit, availability, salary expectations and portal questions); you are responsible towards the company for the content of the application you approve.</p>"
          },
          {
            "html": "<p><strong>6.4 Companies and portals.</strong> After submission, the company’s or portal’s processing of your data is governed by their terms and privacy notice, for which we are not responsible. We do not bypass anti-bot checks, identity verification or other portal checks: if the portal requires them, we provide you with the link and prepared answers so you can complete submission in your browser.</p>"
          },
          {
            "html": "<p><strong>6.5 Payment and refunds.</strong> You expressly request that the service start immediately after payment. If the job listing closes before the application is sent, we automatically refund the full amount. Once the application has been submitted, the service has been performed and the payment is non-refundable, without prejudice to your consumer rights under applicable law.</p>"
          },
          {
            "html": "<p><strong>6.6 Personal data.</strong> How we process the CV, data and emails for this application (providers, 90-day retention and rights) is described in the <a href=\"{{privacy}}\">privacy notice</a>, under “Paid assisted job application”.</p>"
          },
          {
            "html": "<p><strong>6.7 Liability.</strong> To the extent permitted by law, our liability for the service is limited to the amount paid, except in cases of intent or gross negligence.</p>"
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
    "updated": "Letzte Aktualisierung: Oktober 2026",
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
            "html": "<p><strong>6.1 Der Dienst.</strong> Gegen eine einmalige Zahlung erstellen und versenden wir in Ihrem Namen eine Bewerbung für ein einziges Stellenangebot. Anschreiben, E-Mail an das Unternehmen und Formularantworten werden mithilfe eines KI-Modells auf Grundlage Ihres Lebenslaufs und Ihrer Angaben verfasst, von einer Mitarbeiterin geprüft und Ihnen zur Freigabe vorgelegt: Sie können Korrekturen vornehmen oder eine neue Fassung verlangen. Antworten Sie nicht innerhalb von 12 Stunden nach der Prüfungs-E-Mail, wird die Bewerbung unverändert versandt, wie in dieser E-Mail angegeben. Wir sind weder eine Arbeitsvermittlung noch mit dem Unternehmen verbunden und garantieren weder eine Antwort noch ein Vorstellungsgespräch oder eine Anstellung.</p>"
          },
          {
            "html": "<p><strong>6.2 Der Auftrag.</strong> Mit der Bestätigung vor dem Hochladen Ihres Lebenslaufs erteilen Sie uns einen auf dieses Stellenangebot beschränkten Auftrag: die Bewerbung in Ihrem Namen per E-Mail oder über das Unternehmensportal zu versenden; falls das Portal es verlangt, ein Konto in Ihrem Namen mit einer eigens für die Bewerbung eingerichteten E-Mail-Adresse und einem zufälligen Passwort anzulegen; in Ihrem Namen die Nutzungsbedingungen, Datenschutzhinweise und sonstigen Erklärungen zu akzeptieren, die das Unternehmen oder Portal für den Empfang der Bewerbung verlangt, ausschliesslich soweit dies für die Übermittlung erforderlich ist; Antworten des Unternehmens unter der zugehörigen Adresse zu empfangen und an Sie weiterzuleiten; und bei einer unbeantworteten Bewerbung per E-Mail bis zu zwei kurze Nachfragen in Ihrem Namen zu senden, die wir Ihnen vorher zeigen. Wir erteilen niemals in Ihrem Namen freiwillige Einwilligungen (Newsletter, Marketing, Stellenbenachrichtigungen, Talentpool, Weitergabe an andere Unternehmen) oder Erklärungen, die nur Sie abgeben können: In diesen Fällen bitten wir Sie, selbst zu antworten oder den Schritt abzuschliessen. Sie können den Auftrag bis zum Versand durch eine Nachricht an <a href=\"mailto:{{email}}\">{{email}}</a> widerrufen.</p>"
          },
          {
            "html": "<p><strong>6.3 Ihre Verpflichtungen.</strong> Sie erklären, dass der Lebenslauf, die Dokumente und Angaben, die Sie uns übermitteln, wahrheitsgemäss, aktuell und Ihre eigenen sind und Sie diese dem Unternehmen mitteilen dürfen. Antworten, die nur Sie geben können (Arbeitsbewilligung, Verfügbarkeit, Gehaltsvorstellungen, Portalfragen), geben Sie selbst; gegenüber dem Unternehmen sind Sie für den Inhalt der von Ihnen freigegebenen Bewerbung verantwortlich.</p>"
          },
          {
            "html": "<p><strong>6.4 Unternehmen und Portale.</strong> Nach der Übermittlung richtet sich die Verarbeitung Ihrer Daten durch das Unternehmen oder Portal nach dessen Bedingungen und Datenschutzhinweisen, für die wir nicht verantwortlich sind. Wir umgehen keine Anti-Bot-Prüfungen, Identitätsprüfungen oder sonstigen Portalkontrollen: Werden solche verlangt, übergeben wir Ihnen den Link und die vorbereiteten Antworten, damit Sie den Versand in Ihrem Browser abschliessen.</p>"
          },
          {
            "html": "<p><strong>6.5 Zahlung und Rückerstattung.</strong> Sie verlangen ausdrücklich, dass die Dienstleistung unmittelbar nach der Zahlung beginnt. Wird das Stellenangebot geschlossen, bevor die Bewerbung versandt wurde, erstatten wir automatisch den vollständigen Betrag. Nach dem Versand ist die Dienstleistung erbracht und der Betrag nicht erstattungsfähig; Ihre Verbraucherrechte nach dem anwendbaren Recht bleiben unberührt.</p>"
          },
          {
            "html": "<p><strong>6.6 Personendaten.</strong> Wie wir den Lebenslauf, die Daten und E-Mails dieser Bewerbung verarbeiten (Dienstleister, Aufbewahrung für 90 Tage, Rechte), ist in den <a href=\"{{privacy}}\">Datenschutzhinweisen</a> unter «Kostenpflichtige Bewerbungsunterstützung» beschrieben.</p>"
          },
          {
            "html": "<p><strong>6.7 Haftung.</strong> Soweit gesetzlich zulässig, ist unsere Haftung für die Dienstleistung auf den gezahlten Betrag begrenzt, ausgenommen Vorsatz oder grobe Fahrlässigkeit.</p>"
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
    "updated": "Dernière mise à jour : octobre 2026",
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
            "html": "<p><strong>6.1 Le service.</strong> Moyennant un paiement unique, nous préparons et envoyons en votre nom une candidature pour une seule offre. La lettre de motivation, l’email à l’entreprise et les réponses au formulaire sont rédigés avec l’aide d’un modèle d’intelligence artificielle à partir de votre CV et des données fournies, contrôlés par une opératrice et soumis à votre approbation : vous pouvez les corriger ou demander une nouvelle version. Sans réponse de votre part dans les 12 heures suivant l’email de révision, la candidature est envoyée telle quelle, comme indiqué dans cet email. Nous ne sommes ni une agence de placement ni affiliés à l’entreprise, et ne garantissons ni réponse, ni entretien, ni embauche.</p>"
          },
          {
            "html": "<p><strong>6.2 Le mandat.</strong> Par votre confirmation avant le téléversement du CV, vous nous confiez un mandat limité à cette offre pour : envoyer la candidature en votre nom, par email ou via le portail de l’entreprise ; créer, si le portail l’exige, un compte à votre nom avec une adresse email dédiée à la candidature et un mot de passe aléatoire ; accepter pour votre compte les conditions d’utilisation, la notice de protection des données et les autres déclarations que l’entreprise ou le portail exigent pour recevoir la candidature, uniquement dans la mesure nécessaire à l’envoi ; recevoir les réponses de l’entreprise à l’adresse dédiée et vous les transmettre ; envoyer en votre nom jusqu’à deux brefs messages de relance, présentés au préalable, si l’entreprise ne répond pas à une candidature envoyée par email. Nous n’acceptons jamais pour votre compte des consentements facultatifs (newsletters, marketing, alertes emploi, vivier de candidats, partage avec d’autres entreprises), ni des déclarations que vous seul pouvez faire : nous vous demandons alors de répondre ou d’effectuer vous-même l’étape. Vous pouvez révoquer le mandat jusqu’à l’envoi en écrivant à <a href=\"mailto:{{email}}\">{{email}}</a>.</p>"
          },
          {
            "html": "<p><strong>6.3 Vos engagements.</strong> Vous déclarez que le CV, les documents et les données fournis sont véridiques, à jour et vous appartiennent, et que vous pouvez les communiquer à l’entreprise. Vous fournissez les réponses que vous seul pouvez donner (permis de travail, disponibilité, prétentions salariales, questions du portail) ; vous êtes responsable envers l’entreprise du contenu de la candidature que vous approuvez.</p>"
          },
          {
            "html": "<p><strong>6.4 Entreprises et portails.</strong> Après l’envoi, le traitement de vos données par l’entreprise ou le portail est régi par leurs conditions et leur notice de confidentialité, dont nous ne sommes pas responsables. Nous ne contournons pas les contrôles anti-robots, les vérifications d’identité ni les autres contrôles du portail : s’ils sont requis, nous vous transmettons le lien et les réponses préparées pour que vous terminiez l’envoi dans votre navigateur.</p>"
          },
          {
            "html": "<p><strong>6.5 Paiement et remboursement.</strong> Vous demandez expressément que le service commence immédiatement après le paiement. Si l’offre est clôturée avant l’envoi de la candidature, nous remboursons automatiquement la totalité du montant. Une fois la candidature envoyée, le service est exécuté et le montant n’est pas remboursable, sous réserve des droits que la loi applicable vous reconnaît en tant que consommateur.</p>"
          },
          {
            "html": "<p><strong>6.6 Données personnelles.</strong> Le traitement du CV, des données et des emails de cette candidature (prestataires, conservation de 90 jours, droits) est décrit dans la <a href=\"{{privacy}}\">notice de confidentialité</a>, à la rubrique « Candidature assistée payante ».</p>"
          },
          {
            "html": "<p><strong>6.7 Responsabilité.</strong> Dans les limites autorisées par la loi, notre responsabilité pour le service est limitée au montant payé, sauf en cas de dol ou de faute grave.</p>"
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
