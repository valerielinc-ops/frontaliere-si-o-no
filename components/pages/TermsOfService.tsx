import React from 'react';
import { FileText, Scale, AlertTriangle, Globe, ArrowLeft } from 'lucide-react';
import { useNavigation } from '@/services/NavigationContext';
import { PUBLIC_CONTACT_EMAIL } from '@/services/publicContact';

export const TermsOfService: React.FC = () => {
 const nav = useNavigation();
 return (
 <div className="max-w-4xl mx-auto px-4 py-8 animate-fade-in">
 {/* Back Button */}
 <button
 onClick={() => nav.navigateTo('calculator')}
 className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:text-accent transition-colors"
 >
 <ArrowLeft size={16} />
 Torna alla Home
 </button>

 {/* Header */}
 <div className="bg-surface rounded-2xl border border-edge p-5 sm:p-8 shadow-lg mb-6">
 <div className="flex items-center gap-4 mb-4">
 <div className="p-3 bg-gradient-to-br from-warning-strong to-warning-strong rounded-2xl shadow-lg">
 <FileText className="text-on-accent" size={32} />
 </div>
 <div>
 <h1 className="text-2xl sm:text-3xl font-extrabold font-display text-strong">Termini di Servizio</h1>
 <p className="text-sm text-muted mt-1">Ultimo aggiornamento: ottobre 2026</p>
 </div>
 </div>
 <p className="text-subtle leading-relaxed">
 Utilizzando la piattaforma <strong>Frontaliere Ticino</strong> (frontaliereticino.ch), accetti i seguenti termini e condizioni di utilizzo.
 </p>
 </div>

 {/* Sections */}
 <div className="space-y-6">

 {/* Section 1: Natura del servizio */}
 <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm">
 <div className="flex items-center gap-3 mb-4">
 <div className="p-2 bg-accent-subtle rounded-xl">
 <Globe className="text-link" size={24} />
 </div>
 <h2 className="text-xl font-bold font-display text-strong">1. Natura del Servizio</h2>
 </div>
 <div className="space-y-3 text-subtle">
 <p>
 Frontaliere Ticino è una piattaforma informativa gratuita rivolta ai lavoratori frontalieri nell'area Svizzera-Italia.
 Il servizio include simulatori fiscali, confronti tra servizi, guide pratiche, offerte di lavoro e contenuti editoriali.
 </p>
 <p>
 Tutti i calcoli, le simulazioni e le informazioni fornite hanno carattere <strong>puramente indicativo e informativo</strong>.
 Non costituiscono consulenza fiscale, legale o finanziaria professionale.
 </p>
 </div>
 </div>

 {/* Section 2: Esclusione di responsabilità */}
 <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm">
 <div className="flex items-center gap-3 mb-4">
 <div className="p-2 bg-warning-subtle rounded-xl">
 <AlertTriangle className="text-warning" size={24} />
 </div>
 <h2 className="text-xl font-bold font-display text-strong">2. Esclusione di Responsabilità</h2>
 </div>
 <div className="space-y-3 text-subtle">
 <div className="bg-warning-subtle p-4 rounded-xl border border-warning-border">
 <p className="font-semibold text-warning mb-1">Disclaimer</p>
 <p className="text-sm">
 I risultati delle simulazioni fiscali, i confronti tra servizi e le informazioni pubblicate sono basati su dati
 disponibili pubblicamente e su modelli semplificati. Possono variare rispetto alla situazione reale dell'utente.
 Si raccomanda di verificare sempre con un professionista abilitato (commercialista, consulente fiscale, avvocato)
 prima di prendere decisioni finanziarie o legali.
 </p>
 </div>
 <p>
 Frontaliere Ticino non è responsabile per eventuali danni diretti o indiretti derivanti dall'utilizzo
 delle informazioni o dei simulatori presenti sulla piattaforma. I dati sulle offerte di lavoro sono
 raccolti automaticamente da fonti pubbliche e potrebbero non essere aggiornati in tempo reale.
 </p>
 </div>
 </div>

 {/* Section 3: Proprietà intellettuale */}
 <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm">
 <div className="flex items-center gap-3 mb-4">
 <div className="p-2 bg-accent-subtle rounded-xl">
 <Scale className="text-accent" size={24} />
 </div>
 <h2 className="text-xl font-bold font-display text-strong">3. Proprietà Intellettuale</h2>
 </div>
 <div className="space-y-3 text-subtle">
 <p>
 I contenuti originali, il codice sorgente e il design di Frontaliere Ticino sono protetti dal diritto
 d&apos;autore: tutti i diritti riservati. Il codice è consultabile su GitHub; la pubblicazione non concede
 licenze oltre a quelle indicate nel file{' '}
 <a href="https://github.com/valerielinc-ops/frontaliere-si-o-no/blob/main/LICENSE.md" className="underline" target="_blank" rel="noopener noreferrer">LICENSE.md</a> del
 repository. Marchi, loghi e contenuti di terzi appartengono ai rispettivi titolari.
 </p>
 <p>
 Gli articoli e i contenuti editoriali sono pubblicati a scopo informativo. Il testo degli articoli può
 essere riprodotto con attribuzione e link alla fonte originale, nel rispetto delle norme sul diritto
 d&apos;autore. Le immagini seguono la sezione 3.1, e valgono le licenze indicate sulle singole pagine (per
 esempio quelle dei dataset).
 </p>
 <div id="licenza-immagini" className="pt-2">
 <h3 className="text-base font-semibold text-strong mb-1">3.1 Licenza delle immagini</h3>
 <p>
 Le immagini create da o per Frontaliere Ticino (grafiche, anteprime social, mappe e illustrazioni
 proprie) sono protette dal diritto d&apos;autore e appartengono a Frontaliere Ticino. L&apos;uso non
 autorizzato è vietato. Le immagini di terzi, come le fotografie di Wikimedia Commons e delle banche
 immagini, le locandine degli eventi, i fotogrammi delle webcam di confine e le mappe di OpenStreetMap,
 appartengono ai rispettivi autori e restano soggette alle loro licenze.
 </p>
 <p>
 Per richiedere una licenza d&apos;uso di un&apos;immagine di Frontaliere Ticino (editoriale, commerciale o
 di archivio) o per concordare un&apos;attribuzione specifica, scrivere a{' '}
 <a href="mailto:info@frontaliereticino.ch" className="underline">info@frontaliereticino.ch</a>{' '}
 indicando l&apos;URL dell&apos;immagine, l&apos;ambito d&apos;uso previsto e la durata richiesta.
 </p>
 </div>
 <div id="software-terze-parti" className="pt-2">
 <h3 className="text-base font-semibold text-strong mb-1">3.2 Software, font e modelli di terze parti</h3>
 <p>
 Il sito e il suo codice usano software, font e modelli di terzi, ciascuno con la propria licenza. Tra
 questi: il modello YOLOv8n di Ultralytics, con licenza AGPL-3.0, che conta i veicoli nei fotogrammi delle
 webcam di confine; Prebid.js, con licenza Apache-2.0, per la pubblicità; i font Inter, Space Grotesk,
 Roboto e Source Sans 3, con licenza SIL Open Font License 1.1. L&apos;elenco completo, con le note di
 copyright e i testi delle licenze, è nel file{' '}
 <a href="https://github.com/valerielinc-ops/frontaliere-si-o-no/blob/main/THIRD_PARTY_NOTICES.md" className="underline" target="_blank" rel="noopener noreferrer">THIRD_PARTY_NOTICES.md</a>{' '}
 del repository.
 </p>
 </div>
 </div>
 </div>

 {/* Section 4: Utilizzo accettabile */}
 <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm">
 <div className="flex items-center gap-3 mb-4">
 <div className="p-2 bg-success-subtle rounded-xl">
 <FileText className="text-success" size={24} />
 </div>
 <h2 className="text-xl font-bold font-display text-strong">4. Utilizzo Accettabile</h2>
 </div>
 <div className="space-y-3 text-subtle">
 <p>L'utente si impegna a:</p>
 <ul className="list-disc list-inside space-y-1 text-sm">
 <li>Utilizzare la piattaforma nel rispetto delle leggi svizzere e italiane vigenti</li>
 <li>Non tentare di compromettere la sicurezza o il funzionamento del servizio</li>
 <li>Non utilizzare sistemi automatizzati per accedere massivamente ai contenuti, salvo autorizzazione</li>
 <li>Non ripubblicare contenuti oltre quanto consentito dalla sezione 3</li>
 </ul>
 </div>
 </div>

 {/* Section 5: Comunicazioni email */}
 <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm">
 <div className="flex items-center gap-3 mb-4">
 <div className="p-2 bg-info-subtle rounded-xl">
 <FileText className="text-info" size={24} />
 </div>
 <h2 className="text-xl font-bold font-display text-strong">5. Comunicazioni email</h2>
 </div>
 <div className="space-y-3 text-subtle">
 <p>
  Registrandoti al sito, tramite email o tramite un sistema di accesso federato, accetti questi Termini e iscrivi
  il tuo indirizzo al rapporto base di comunicazioni di Frontaliere Ticino: newsletter, job alert, messaggi di servizio
  e comunicazioni promozionali di terzi. Non è richiesta
  una casella di consenso separata: la registrazione e questa informativa descrivono le comunicazioni incluse.
 </p>
 <p>
 Il canale di registrazione può fornire i criteri iniziali dell&apos;alert: una categoria e parole chiave dal jobboard,
 la ricerca effettuata, il contesto del calcolatore o della pagina visitata. Per le iscrizioni generiche l&apos;alert
 parte ampio e si perfeziona con le successive ricerche, visite e offerte consultate. Puoi gestire i canali e le
 preferenze nella pagina <a href="/comunicazioni/" className="text-accent underline">Comunicazioni</a>.
 </p>
 <p>
  Salvare un lavoro o seguire un&apos;azienda attiva inoltre il relativo canale aggiuntivo. La pubblicità di terzi non è
  un percorso di iscrizione separato: è compresa nel rapporto base e attiva in partenza. Puoi disattivarla in qualsiasi
  momento dal centro preferenze, senza disattivare newsletter o job alert.
 </p>
 </div>
 </div>

 {/* Section 6: Candidatura assistita */}
 <div id="candidatura-assistita" className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm">
 <div className="flex items-center gap-3 mb-4">
 <div className="p-2 bg-info-subtle rounded-xl">
 <Scale className="text-info" size={24} />
 </div>
 <h2 className="text-xl font-bold font-display text-strong">6. Candidatura assistita a pagamento</h2>
 </div>
 <div className="space-y-3 text-subtle">
 <p>
  <strong>6.1 Il servizio.</strong> Con un pagamento unico prepariamo e inviamo a tuo nome la candidatura per un solo
  annuncio. Lettera di presentazione, email per l&apos;azienda e risposte al modulo sono redatte con l&apos;aiuto di un
  modello di intelligenza artificiale sulla base del tuo CV e dei dati che ci fornisci, controllate da
  un&apos;operatrice e sottoposte alla tua approvazione: puoi correggerle o chiedere una nuova versione. Se non
  rispondi entro 12 ore dall&apos;email di revisione, la candidatura parte così com&apos;è, come indicato nell&apos;email.
  Non siamo un&apos;agenzia di collocamento né affiliati all&apos;azienda, e non garantiamo risposta, colloquio o assunzione.
 </p>
 <p>
  <strong>6.2 Il mandato.</strong> Con la conferma prima del caricamento del CV ci conferisci un mandato limitato a
  quell&apos;annuncio per: inviare la candidatura a tuo nome, per email o tramite il portale dell&apos;azienda; creare,
  se il portale lo richiede, un account a tuo nome con un indirizzo email dedicato alla candidatura e una password
  casuale; accettare per tuo conto le condizioni d&apos;uso, l&apos;informativa sulla protezione dei dati e le altre
  dichiarazioni che l&apos;azienda o il portale richiedono per ricevere la candidatura, solo nella misura necessaria
  all&apos;invio; ricevere sull&apos;indirizzo dedicato le risposte dell&apos;azienda e inoltrartele; inviare, se
  l&apos;azienda non risponde a una candidatura partita per email, fino a due brevi solleciti a tuo nome, che ti
  mostriamo prima. Non accettiamo mai per tuo conto consensi facoltativi (newsletter, marketing, avvisi di lavoro,
  talent pool, condivisione con altre aziende) né dichiarazioni che solo tu puoi rendere: in quei casi ti chiediamo
  di rispondere o di completare tu il passaggio. Puoi revocare il mandato fino all&apos;invio scrivendo a
  <a href={`mailto:${PUBLIC_CONTACT_EMAIL}`} className="underline">{PUBLIC_CONTACT_EMAIL}</a>.
 </p>
 <p>
  <strong>6.3 I tuoi impegni.</strong> Dichiari che il CV, i documenti e i dati che ci fornisci sono veritieri,
  aggiornati e tuoi, e che puoi comunicarli all&apos;azienda. Le risposte che solo tu puoi dare (permesso di lavoro,
  disponibilità, pretese salariali, domande del portale) le fornisci tu; del contenuto della candidatura che approvi
  rispondi tu nei confronti dell&apos;azienda.
 </p>
 <p>
  <strong>6.4 Azienda e portali.</strong> Dopo l&apos;invio, il trattamento dei tuoi dati da parte dell&apos;azienda o
  del portale è regolato dalle loro condizioni e dalla loro informativa privacy, di cui non siamo responsabili. Non
  aggiriamo controlli anti-robot, verifiche di identità o altri controlli del portale: se il portale li richiede,
  ti passiamo il collegamento e le risposte preparate perché tu completi l&apos;invio dal tuo browser.
 </p>
 <p>
  <strong>6.5 Pagamento e rimborso.</strong> Chiedi espressamente che il servizio inizi subito dopo il pagamento.
  Se l&apos;annuncio risulta chiuso prima che la candidatura sia inviata, ti rimborsiamo automaticamente l&apos;intero
  importo. Una volta inviata la candidatura il servizio è eseguito e l&apos;importo non è rimborsabile, fatti salvi
  i diritti che la legge applicabile ti riconosce come consumatore.
 </p>
 <p>
  <strong>6.6 Dati personali.</strong> Come trattiamo il CV, i dati e le email di questa candidatura (fornitori,
  conservazione di 90 giorni, diritti) è descritto nell&apos;
  <button onClick={() => nav.navigateTo('privacy')} className="text-accent hover:underline font-semibold">informativa privacy</button>,
  alla voce «Candidatura assistita a pagamento».
 </p>
 <p>
  <strong>6.7 Responsabilità.</strong> Nei limiti consentiti dalla legge, la nostra responsabilità per il servizio è
  limitata all&apos;importo pagato, salvo dolo o colpa grave.
 </p>
 </div>
 </div>

 {/* Section 7: Modifiche */}
 <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm">
 <div className="flex items-center gap-3 mb-4">
 <div className="p-2 bg-surface-raised rounded-xl">
 <FileText className="text-subtle" size={24} />
 </div>
 <h2 className="text-xl font-bold font-display text-strong">7. Modifiche ai Termini</h2>
 </div>
 <div className="space-y-3 text-subtle">
 <p>
 Ci riserviamo il diritto di modificare questi termini in qualsiasi momento. Le modifiche saranno
 pubblicate su questa pagina con la data di aggiornamento. L'uso continuato della piattaforma
 dopo la pubblicazione delle modifiche costituisce accettazione dei nuovi termini.
 </p>
 </div>
 </div>

 {/* Section 8: Contatti */}
 <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm">
 <div className="space-y-3 text-subtle">
 <h2 className="text-xl font-bold font-display text-strong">8. Contatti</h2>
 <p>
 Per domande o chiarimenti sui presenti termini di servizio, puoi contattarci tramite
 la <button onClick={() => nav.navigateTo('contact')} className="text-accent hover:underline font-semibold">pagina contatti</button> o
 la <button onClick={() => nav.navigateTo('privacy')} className="text-accent hover:underline font-semibold">pagina privacy</button>.
 </p>
 </div>
 </div>

 </div>
 </div>
 );
};
