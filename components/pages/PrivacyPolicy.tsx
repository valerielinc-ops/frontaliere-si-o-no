import React from 'react';
import { Shield, Lock, Database, Eye, CheckCircle2, ArrowLeft, BarChart3, ExternalLink } from 'lucide-react';
import { useNavigation } from '@/services/NavigationContext';

export const PrivacyPolicy: React.FC = () => {
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
 <div className="bg-surface rounded-[6px] border border-edge p-5 sm:p-8 shadow-stripe-lg mb-6">
 <div className="flex items-center gap-4 mb-4">
 <div className="p-3 bg-accent-subtle rounded-[6px]">
 <Shield className="text-accent" size={32} />
 </div>
 <div>
 <h1 className="text-2xl sm:text-3xl font-light font-display text-heading">Privacy Policy</h1>
 <p className="text-sm text-muted mt-1">Ultimo aggiornamento: Aprile 2026</p>
 </div>
 </div>
 <p className="text-subtle leading-relaxed">
 La tua privacy è importante per noi. Questa pagina descrive come gestiamo i dati quando utilizzi
 <strong> Frontaliere Ticino</strong>.
 </p>
 </div>

 {/* Privacy Sections */}
 <div className="space-y-6">

 {/* Section 1: No Data Collection from Simulator */}
 <div className="bg-surface rounded-[6px] border border-edge p-4 sm:p-6 shadow-stripe-sm">
 <h2 className="text-xl font-medium text-heading mb-4 flex items-center gap-3">
 <Database className="text-success flex-shrink-0" size={22} />
 Raccolta e Utilizzo dei Dati
 </h2>
 <div className="space-y-3 text-subtle">
 <div className="flex items-start gap-3 bg-success-subtle p-4 rounded-[6px] border border-success-border">
 <CheckCircle2 className="text-success flex-shrink-0 mt-0.5" size={20} />
 <div>
 <p className="font-bold text-success mb-1">ZERO Raccolta Dati dal Simulatore Fiscale</p>
 <p className="text-sm">
 <strong>Non raccogliamo, non salviamo e non trasmettiamo</strong> alcun dato personale o finanziario inserito nel simulatore fiscale.
 Tutti i calcoli vengono eseguiti <strong>esclusivamente lato client</strong> (nel tuo browser).
 </p>
 </div>
 </div>
 <p>
 I dati che inserisci (reddito, situazione familiare, spese, ecc.) rimangono <strong>sul tuo dispositivo</strong>
 e non vengono mai inviati ai nostri server o a terze parti.
 </p>
 </div>
 </div>

 {/* Section 2: Analytics */}
 <div className="bg-surface rounded-[6px] border border-edge p-4 sm:p-6 shadow-stripe-sm">
 <h2 className="text-xl font-medium text-heading mb-4 flex items-center gap-3">
 <BarChart3 className="text-accent flex-shrink-0" size={22} />
 Analisi Anonima del Traffico
 </h2>
 <div className="space-y-3 text-subtle">
 <p>
 Utilizziamo strumenti di analisi per comprendere come gli utenti interagiscono con il sito
 e migliorare il servizio:
 </p>
 <div className="bg-surface-alt/50 p-4 rounded-[6px] border border-edge">
 <h3 className="font-medium text-heading mb-2">Google Analytics 4</h3>
 <p className="text-sm">
 Raccoglie statistiche aggregate: pagine visitate, tempo di permanenza, tipo di dispositivo,
 browser utilizzato. Non raccoglie indirizzi IP completi né dati personali.
 </p>
 </div>
 <div className="bg-surface-alt/50 p-4 rounded-[6px] border border-edge">
 <h3 className="font-medium text-heading mb-2">PostHog (EU Cloud)</h3>
 <p className="text-sm">
 Analisi comportamentale anonima con dati ospitati in Europa (Francoforte).
 Registra visualizzazioni di pagina e percorsi di navigazione per ottimizzare l'esperienza utente.
 Non raccoglie dati personali identificabili (PII) e non effettua profilazione individuale.
 </p>
 </div>
 <div className="bg-surface-alt/50 p-4 rounded-[6px] border border-edge">
 <h3 className="font-medium text-heading mb-2">Microsoft Clarity</h3>
 <p className="text-sm">
 Heatmap e registrazioni di sessione anonime per identificare problemi di usabilità.
 Servizio gratuito di Microsoft, non raccoglie dati personali.
 </p>
 </div>
 <p className="text-sm italic mt-2">
 Puoi disabilitare la raccolta di statistiche tramite le impostazioni del tuo browser
 o utilizzando estensioni come"uBlock Origin" o"Google Analytics Opt-out Browser Add-on".
 </p>
 </div>
 </div>

 {/* Section 3: Affiliate & Partner Links */}
 <div className="bg-surface rounded-[6px] border border-edge p-4 sm:p-6 shadow-stripe-sm">
 <h2 className="text-xl font-medium text-heading mb-4 flex items-center gap-3">
 <ExternalLink className="text-accent flex-shrink-0" size={22} />
 Link Affiliati e Partner
 </h2>
 <div className="space-y-3 text-subtle">
 <p>
 Alcune pagine contengono link a servizi di terze parti (banche, servizi finanziari, operatori telefonici)
 che includono parametri di tracciamento (UTM) per attribuire le visite al nostro sito.
 </p>
 <ul className="list-disc list-inside space-y-2 ml-4 text-sm">
 <li><strong>Cosa tracciamo</strong>: quale link è stato cliccato e da quale pagina del sito</li>
 <li><strong>Cosa NON tracciamo</strong>: la tua identità, le tue azioni sul sito del partner, eventuali acquisti o registrazioni</li>
 <li><strong>Compenso</strong>: potremmo ricevere una commissione se ti registri tramite un link affiliato</li>
 </ul>
 <p className="text-sm">
 Consigliamo solo servizi che riteniamo utili per i lavoratori frontalieri. Le raccomandazioni
 sono basate sulla nostra esperienza diretta, non su accordi commerciali.
 </p>
 </div>
 </div>

 {/* Section 4: Newsletter & Communications */}
 <div className="bg-surface rounded-[6px] border border-edge p-4 sm:p-6 shadow-stripe-sm">
 <h2 className="text-xl font-medium text-heading mb-4 flex items-center gap-3">
 <Database className="text-accent flex-shrink-0" size={22} />
 Newsletter e Comunicazioni
 </h2>
 <div className="space-y-3 text-subtle">
 <p>
 Qualora l'utente si iscriva volontariamente al servizio di newsletter, il Titolare del trattamento raccoglierà
 e conserverà l'indirizzo e-mail fornito ai sensi dell'art. 6, par. 1, lett. a) del Regolamento (UE) 2016/679 (GDPR),
 sulla base del consenso esplicito prestato dall'utente al momento dell'iscrizione.
 </p>
 <div className="bg-surface-alt/50 p-4 rounded-[6px] border border-edge">
 <h3 className="font-medium text-heading mb-2">Finalità del trattamento</h3>
 <p className="text-sm">
 L'indirizzo e-mail sarà utilizzato per le seguenti finalità: (i) invio periodico di comunicazioni informative
 relative ai servizi offerti dalla piattaforma, inclusi aggiornamenti su tassi di cambio, traffico ai valichi
 e novità normative fiscali; (ii) comunicazioni promozionali, offerte personalizzate e contenuti di marketing
 diretto relativi ai servizi della piattaforma e dei partner commerciali convenzionati, ai sensi dell'art. 130,
 commi 1 e 2, del D.Lgs. 196/2003 (Codice Privacy) e successive modifiche; (iii) profilazione di base per
 l'ottimizzazione dei contenuti inviati sulla base delle preferenze espresse dall'utente e delle interazioni
 con le comunicazioni ricevute, nel rispetto dei principi di minimizzazione e proporzionalità ex art. 5 GDPR.
 </p>
 </div>
 <div className="bg-surface-alt/50 p-4 rounded-[6px] border border-edge">
 <h3 className="font-medium text-heading mb-2">Base giuridica e conservazione</h3>
 <p className="text-sm">
 Il trattamento è fondato sul consenso dell'interessato (art. 6, par. 1, lett. a), GDPR) e, limitatamente
 al soft spam, sul legittimo interesse del Titolare (art. 6, par. 1, lett. f), GDPR), conformemente al
 Considerando 47 del Regolamento. I dati saranno conservati fino alla revoca del consenso o alla
 cancellazione dell'iscrizione. L'utente può revocare il consenso in qualsiasi momento tramite il link
 di cancellazione presente in ogni comunicazione, senza pregiudizio per la liceità del trattamento
 basato sul consenso prestato prima della revoca.
 </p>
 </div>
 <div className="bg-surface-alt/50 p-4 rounded-[6px] border border-edge">
 <h3 className="font-medium text-heading mb-2">Autenticazione Google</h3>
 <p className="text-sm">
 Qualora l'utente utilizzi l'autenticazione tramite Google Sign-In, la piattaforma potrà accedere
 all'indirizzo e-mail e al nome visualizzato associati all'account Google dell'utente, nel limite
 strettamente necessario all'espletamento delle funzionalità richieste (iscrizione newsletter,
 accesso alla community e alla dashboard personale). Tali dati sono trattati conformemente alla
 presente informativa e alla policy di Google (<a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer" className="text-accent underline">policies.google.com/privacy</a>).
 </p>
 </div>
 </div>
 </div>

 {/* Section 5: Client-Side Processing */}
 <div className="bg-surface rounded-[6px] border border-edge p-4 sm:p-6 shadow-stripe-sm">
 <h2 className="text-xl font-medium text-heading mb-4 flex items-center gap-3">
 <Lock className="text-accent flex-shrink-0" size={22} />
 Elaborazione Lato Client
 </h2>
 <div className="space-y-3 text-subtle">
 <p>
 Il simulatore è un'applicazione <strong>completamente lato client</strong>:
 </p>
 <ul className="list-disc list-inside space-y-2 ml-4">
 <li>Tutti i calcoli vengono eseguiti direttamente nel tuo browser</li>
 <li>Nessun dato viene trasmesso via Internet durante l'utilizzo</li>
 <li>Non è necessario creare account o fornire informazioni personali</li>
 <li>Puoi utilizzare il simulatore anche offline (dopo il primo caricamento)</li>
 </ul>
 </div>
 </div>

 {/* Section 6: Cookies */}
 <div className="bg-surface rounded-[6px] border border-edge p-4 sm:p-6 shadow-stripe-sm">
 <h2 className="text-xl font-medium text-heading mb-4 flex items-center gap-3">
 <Database className="text-warning flex-shrink-0" size={22} />
 Cookie e Storage Locale
 </h2>
 <div className="space-y-3 text-subtle">
 <p>Il sito utilizza tecnologie di storage locale per migliorare la tua esperienza:</p>
 <div className="bg-surface-alt/50 p-4 rounded-[6px] border border-edge">
 <h3 className="font-medium text-heading mb-2">Cookie Tecnici</h3>
 <p className="text-sm">
 Cookie essenziali per il funzionamento del sito (es. preferenze tema, stato consenso).
 </p>
 </div>
 <div className="bg-surface-alt/50 p-4 rounded-[6px] border border-edge">
 <h3 className="font-medium text-heading mb-2">Cookie Analytics</h3>
 <p className="text-sm">
 Cookie di Google Analytics, PostHog e Microsoft Clarity per statistiche anonime
 (vedi sezione"Analisi Anonima del Traffico").
 </p>
 </div>
 <div className="bg-surface-alt/50 p-4 rounded-[6px] border border-edge">
 <h3 className="font-medium text-heading mb-2">Cookie Pubblicitari</h3>
 <p className="text-sm">
 Cookie di Google AdSense per la visualizzazione di annunci.
 </p>
 </div>
 <div className="bg-surface-alt/50 p-4 rounded-[6px] border border-edge">
 <h3 className="font-medium text-heading mb-2">LocalStorage</h3>
 <p className="text-sm">
 Utilizziamo il LocalStorage del browser per salvare le tue preferenze (tema scuro/chiaro)
 e mantenere i parametri dell'ultima simulazione. Questi dati rimangono <strong>solo sul tuo dispositivo</strong>.
 </p>
 </div>
 </div>
 </div>

 {/* Section 7: Third-Party Services */}
 <div className="bg-surface rounded-[6px] border border-edge p-4 sm:p-6 shadow-stripe-sm">
 <h2 className="text-xl font-medium text-heading mb-4 flex items-center gap-3">
 <Shield className="text-accent flex-shrink-0" size={22} />
 Servizi di Terze Parti
 </h2>
 <div className="space-y-3 text-subtle">
 <p>Il sito utilizza i seguenti servizi esterni:</p>
 <ul className="list-disc list-inside space-y-2 ml-4 text-sm">
 <li><strong>Google Analytics 4</strong>: statistiche anonime sull'utilizzo del sito</li>
 <li><strong>PostHog EU</strong>: analisi comportamentale anonima (dati in Europa)</li>
 <li><strong>Microsoft Clarity</strong>: heatmap e registrazioni di sessione anonime</li>
 <li><strong>Google AdSense</strong>: annunci pubblicitari</li>
 <li><strong>Firebase</strong>: configurazione remota e autenticazione</li>
 </ul>
 <p className="text-sm italic">
 Non siamo responsabili delle pratiche di privacy di siti web di terze parti.
 Ti consigliamo di leggere le loro policy prima di fornire informazioni personali.
 </p>
 </div>
 </div>

 {/* Section 8: Data Security */}
 <div className="bg-surface rounded-[6px] border border-edge p-4 sm:p-6 shadow-stripe-sm">
 <h2 className="text-xl font-medium text-heading mb-4 flex items-center gap-3">
 <Lock className="text-accent flex-shrink-0" size={22} />
 Sicurezza
 </h2>
 <div className="space-y-3 text-subtle">
 <p>
 I dati personali e finanziari che inserisci nel simulatore non vengono mai trasmessi.
 La sicurezza di tali dati dipende dalla sicurezza del tuo dispositivo e browser.
 </p>
 <p>
 Il sito è servito tramite connessione <strong>HTTPS sicura</strong> per garantire che la comunicazione
 tra il tuo browser e i nostri server sia crittografata.
 </p>
 </div>
 </div>

 {/* Section 9: Your Rights */}
 <div className="bg-surface rounded-[6px] border border-edge p-4 sm:p-6 shadow-stripe-sm">
 <h2 className="text-xl font-medium text-heading mb-4 flex items-center gap-3">
 <CheckCircle2 className="text-accent flex-shrink-0" size={22} />
 I Tuoi Diritti (GDPR)
 </h2>
 <div className="space-y-3 text-subtle">
 <p>
 Ai sensi del <strong>Regolamento Generale sulla Protezione dei Dati (GDPR)</strong>, hai diritto a:
 </p>
 <ul className="list-disc list-inside space-y-2 ml-4">
 <li>Accedere ai tuoi dati personali</li>
 <li>Rettificare dati inesatti</li>
 <li>Cancellare i tuoi dati ("diritto all'oblio")</li>
 <li>Limitare il trattamento dei dati</li>
 <li>Opporti al trattamento</li>
 <li>Portabilità dei dati</li>
 </ul>
 <div className="bg-success-subtle p-4 rounded-[6px] border border-success-border mt-4">
 <p className="text-sm font-semibold text-success">
 Per il simulatore fiscale NON raccogliamo dati personali. Per la newsletter, puoi cancellarti
 in qualsiasi momento tramite il link presente in ogni email.
 </p>
 <p className="text-sm mt-2">
 Se hai domande sulla privacy, contattaci tramite la nostra pagina Facebook.
 </p>
 </div>
 </div>
 </div>

 {/* Section 10: Children Privacy */}
 <div className="bg-surface rounded-[6px] border border-edge p-4 sm:p-6 shadow-stripe-sm">
 <h2 className="text-xl font-medium text-heading mb-4 flex items-center gap-3">
 <Shield className="text-accent flex-shrink-0" size={22} />
 Privacy dei Minori
 </h2>
 <div className="space-y-3 text-subtle">
 <p>
 Il nostro servizio è destinato a persone maggiorenni che vogliono simulare la propria situazione fiscale
 come lavoratori frontalieri. Non raccogliamo consapevolmente dati da minori di 18 anni.
 </p>
 </div>
 </div>

 {/* Section 11: Changes */}
 <div className="bg-surface rounded-[6px] border border-edge p-4 sm:p-6 shadow-stripe-sm">
 <h2 className="text-xl font-medium text-heading mb-4 flex items-center gap-3">
 <Eye className="text-subtle flex-shrink-0" size={22} />
 Modifiche alla Privacy Policy
 </h2>
 <div className="space-y-3 text-subtle">
 <p>
 Potremmo aggiornare questa Privacy Policy occasionalmente. Ti consigliamo di rivedere periodicamente
 questa pagina per eventuali modifiche. Le modifiche saranno effettive immediatamente dopo la pubblicazione
 su questa pagina.
 </p>
 <p className="text-sm italic">
 Data ultimo aggiornamento: <strong>Aprile 2026</strong>
 </p>
 </div>
 </div>

 {/* Section 12: Contact */}
 <div className="bg-gradient-to-br from-accent-subtle to-accent-subtle rounded-[6px] border border-accent-border p-4 sm:p-6 shadow-stripe-sm">
 <h2 className="text-xl font-medium text-heading mb-4 flex items-center gap-3">
 <Shield className="text-accent flex-shrink-0" size={22} />
 Contattaci
 </h2>
 <div className="space-y-3 text-subtle">
 <p>
 Se hai domande su questa Privacy Policy o sulle nostre pratiche di privacy, puoi contattarci tramite:
 </p>
 <div className="flex items-center gap-2 mt-3">
 <a
 href="https://www.facebook.com/profile.php?id=61588174947294"
 target="_blank"
 rel="noopener noreferrer"
 className="inline-flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white font-semibold rounded-[6px] transition-colors shadow-stripe-sm"
 >
 <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
 <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
 </svg>
 Contattaci su Facebook
 </a>
 </div>
 </div>
 </div>

 </div>

 {/* Back to Home Button at Bottom */}
 <div className="mt-8 text-center">
 <button
 onClick={() => nav.navigateTo('calculator')}
 className="inline-flex items-center gap-2 px-6 py-3 bg-accent hover:bg-accent-hover text-white font-bold rounded-[6px] transition-[color,background-color,border-color,box-shadow] shadow-stripe hover:shadow-stripe-md"
 >
 <ArrowLeft size={18} />
 Torna al Simulatore
 </button>
 </div>
 </div>
 );
};
