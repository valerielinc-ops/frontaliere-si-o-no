import React from 'react';
import { Shield, Lock, Database, Eye, CheckCircle2, ArrowLeft, BarChart3, ExternalLink, Key, Globe, Scale, Clock, UserCheck, Mail } from 'lucide-react';
import { useNavigation } from '@/services/NavigationContext';

// Titolare del trattamento (#5675) — dati forniti dal proprietario: nome +
// contatto per l'esercizio dei diritti, deliberatamente NON `alerts@` (la
// casella degli invii automatici, dove finivano le richieste LPD prima di
// questa fix). Nessun indirizzo postale: scelta esplicita del proprietario,
// non un dato mancante da dedurre — vedi issue #5675 per la valutazione
// sulla copertura parziale dell'art. 19 nLPD che questo comporta.
const DATA_CONTROLLER_NAME = 'Valerie Linc';
const PRIVACY_EMAIL = 'valerie@frontaliereticino.ch';

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
      <div className="bg-surface rounded-2xl border border-edge p-5 sm:p-8 shadow-stripe-lg mb-6">
        <div className="flex items-center gap-4 mb-4">
          <div className="p-3 bg-accent-subtle rounded-2xl">
            <Shield className="text-accent" size={32} />
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-light font-display text-heading">Privacy Policy</h1>
            <p className="text-sm text-muted mt-1">Ultimo aggiornamento: 12 agosto 2026</p>
          </div>
        </div>
        <p className="text-subtle leading-relaxed">
          La tua privacy è importante per noi. Questa informativa descrive in modo trasparente quali dati trattiamo,
          per quali finalità e su quali basi giuridiche quando utilizzi
          <strong> Frontaliere Ticino</strong> (frontaliereticino.ch), e quali diritti puoi esercitare.
        </p>
        <p className="text-sm text-muted leading-relaxed mt-3">
          L'informativa è redatta per essere conforme ai principali quadri normativi applicabili a livello
          internazionale: il <strong>Regolamento (UE) 2016/679 (GDPR)</strong> e il D.Lgs. 196/2003 (Codice Privacy
          italiano), la <strong>nuova Legge federale svizzera sulla protezione dei dati (nLPD/revLPD)</strong>,
          la <strong>UK GDPR</strong>, il <strong>California Consumer Privacy Act (CCPA/CPRA)</strong> e altre
          normative locali (LGPD brasiliana, PIPEDA canadese, Legge 25 del Québec). Ove più normative siano
          applicabili, riconosciamo all'utente il livello di tutela più favorevole tra quelli previsti.
        </p>
      </div>

      {/* Privacy Sections */}
      <div className="space-y-6">

        {/* Section 0: Data Controller */}
        <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-stripe-sm">
          <h2 className="text-xl font-medium font-display text-heading mb-4 flex items-center gap-3">
            <UserCheck className="text-accent flex-shrink-0" size={22} />
            Titolare del Trattamento
          </h2>
          <div className="space-y-3 text-subtle">
            <p>
              Titolare del trattamento (data controller ai sensi dell'art. 4, n. 7, GDPR e dell'art. 5, lett. j,
              nLPD) di <strong>Frontaliere Ticino</strong> (frontaliereticino.ch), progetto informativo
              indipendente rivolto ai lavoratori frontalieri dell'area Svizzera–Italia, è <strong>{DATA_CONTROLLER_NAME}</strong>.
            </p>
            <div className="bg-surface-alt/50 p-4 rounded-2xl border border-edge">
              <h3 className="font-medium text-heading mb-2 flex items-center gap-2">
                <Mail className="text-accent flex-shrink-0" size={18} />
                Punto di contatto privacy
              </h3>
              <p className="text-sm">
                Per qualsiasi richiesta relativa al trattamento dei tuoi dati personali o all'esercizio dei tuoi
                diritti, puoi scrivere a{' '}
                <a href={`mailto:${PRIVACY_EMAIL}`} className="text-accent underline">{PRIVACY_EMAIL}</a>.
                Rispondiamo entro i termini previsti dalla normativa applicabile (di norma 30 giorni, prorogabili
                ove consentito). Puoi inoltre utilizzare la{' '}
                <button onClick={() => nav.navigateTo('contact')} className="text-accent underline font-medium">pagina contatti</button>{' '}
                o la procedura guidata di{' '}
                <button onClick={() => nav.navigateTo('data-deletion')} className="text-accent underline font-medium">cancellazione dei dati</button>.
              </p>
            </div>
            <p className="text-sm">
              Non abbiamo nominato un Responsabile della protezione dei dati (DPO), non sussistendone l'obbligo ex
              art. 37 GDPR; il punto di contatto sopra indicato resta competente per ogni questione in materia di
              protezione dei dati. I documenti correlati — i{' '}
              <button onClick={() => nav.navigateTo('terms')} className="text-accent underline font-medium">Termini di Servizio</button>{' '}
              — costituiscono parte integrante della disciplina del rapporto con l'utente.
            </p>
          </div>
        </div>

        {/* Section 1: No Data Collection Simulator */}
        <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-stripe-sm">
          <h2 className="text-xl font-medium font-display text-heading mb-4 flex items-center gap-3">
            <Database className="text-success flex-shrink-0" size={22} />
            Raccolta e Utilizzo dei Dati
          </h2>
          <div className="space-y-3 text-subtle">
            <div className="flex items-start gap-3 bg-success-subtle p-4 rounded-2xl border border-success-border">
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
        <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-stripe-sm">
          <h2 className="text-xl font-medium font-display text-heading mb-4 flex items-center gap-3">
            <BarChart3 className="text-accent flex-shrink-0" size={22} />
            Analisi Anonima del Traffico
          </h2>
          <div className="space-y-3 text-subtle">
            <p>
              Utilizziamo strumenti di analisi per comprendere come gli utenti interagiscono con il sito
              e migliorare il servizio. Questi strumenti sono attivati <strong>solo previo tuo consenso</strong>
              (art. 6, par. 1, lett. a, GDPR; art. 6 nLPD), espresso tramite il banner cookie; in assenza di
              consenso non vengono caricati. Puoi modificare o revocare il consenso in qualsiasi momento.
            </p>
            <div className="bg-surface-alt/50 p-4 rounded-2xl border border-edge">
              <h3 className="font-medium text-heading mb-2">Google Analytics 4</h3>
              <p className="text-sm">
                Raccoglie statistiche aggregate: pagine visitate, tempo di permanenza, tipo di dispositivo,
                browser utilizzato. L'anonimizzazione dell'IP è attiva per impostazione predefinita; non
                raccogliamo dati personali identificabili per finalità di analisi.
              </p>
            </div>
            <div className="bg-surface-alt/50 p-4 rounded-2xl border border-edge">
              <h3 className="font-medium text-heading mb-2">PostHog (EU Cloud)</h3>
              <p className="text-sm">
                Analisi comportamentale anonima con dati ospitati in Europa (Francoforte).
                Registra visualizzazioni di pagina e percorsi di navigazione per ottimizzare l'esperienza utente.
                Non raccoglie dati personali identificabili (PII) e non effettua profilazione individuale.
              </p>
            </div>
            <div className="bg-surface-alt/50 p-4 rounded-2xl border border-edge">
              <h3 className="font-medium text-heading mb-2">Microsoft Clarity</h3>
              <p className="text-sm">
                Heatmap e registrazioni di sessione anonime per identificare problemi di usabilità.
                Servizio gratuito di Microsoft, con mascheramento automatico dei contenuti sensibili.
              </p>
            </div>
            <p className="text-sm italic mt-2">
              Puoi disabilitare la raccolta di statistiche dal banner cookie (rifiutando la categoria
              «Analytics»), tramite le impostazioni del tuo browser o estensioni come «uBlock Origin».
            </p>
          </div>
        </div>

        {/* Section 3: Affiliate & Partner Links */}
        <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-stripe-sm">
          <h2 className="text-xl font-medium font-display text-heading mb-4 flex items-center gap-3">
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
        <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-stripe-sm">
          <h2 className="text-xl font-medium font-display text-heading mb-4 flex items-center gap-3">
            <Database className="text-accent flex-shrink-0" size={22} />
            Newsletter e Comunicazioni
          </h2>
          <div className="space-y-3 text-subtle">
            <p>
              Qualora l'utente si iscriva volontariamente al servizio di newsletter, il Titolare del trattamento raccoglierà
              e conserverà l'indirizzo e-mail fornito ai sensi dell'art. 6, par. 1, lett. a) del Regolamento (UE) 2016/679 (GDPR),
              sulla base del consenso esplicito prestato dall'utente al momento dell'iscrizione.
            </p>
            <div className="bg-surface-alt/50 p-4 rounded-2xl border border-edge">
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
            <div className="bg-surface-alt/50 p-4 rounded-2xl border border-edge">
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
            <div className="bg-surface-alt/50 p-4 rounded-2xl border border-edge">
              <h3 className="font-medium text-heading mb-2">Autenticazione Google</h3>
              <p className="text-sm">
                Qualora l'utente utilizzi l'autenticazione tramite Google Sign-In, la piattaforma potrà accedere
                all'indirizzo e-mail e al nome visualizzato associati all'account Google dell'utente, nel limite
                strettamente necessario all'espletamento delle funzionalità richieste (iscrizione newsletter,
                accesso alla community e alla dashboard personale). Tali dati sono trattati conformemente alla
                presente informativa e alla policy di Google (<a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer" className="text-accent underline">policies.google.com/privacy</a>).
              </p>
            </div>
            <div className="bg-surface-alt/50 p-4 rounded-2xl border border-edge">
              <h3 className="font-medium text-heading mb-2 flex items-center gap-2">
                <Key className="text-accent flex-shrink-0" size={18} />
                Accesso automatico dai link email (autologin)
              </h3>
              <p className="text-sm">
                I link contenuti nelle nostre email (newsletter e job alert) includono due parametri — <code>ne</code> (il
                tuo indirizzo e-mail) e <code>ac</code> (un codice di autenticazione HMAC-SHA256 legato al tuo indirizzo) —
                che ti permettono di aprire il sito già autenticato, senza dover reinserire le credenziali.
                Il codice <code>ac</code> viene scambiato con un token Firebase Auth a breve durata (1 ora) al primo
                utilizzo e non contiene dati personali oltre al legame con il tuo indirizzo.
              </p>
              <p className="text-sm mt-2">
                <strong>Rischio da conoscere.</strong> Se inoltri un'email della newsletter a terzi, o se qualcuno ha
                accesso alla cronologia del tuo browser, quella persona potrà aprire le pagine del sito già autenticata
                con il tuo profilo. L'accesso è limitato alle funzionalità utente (dashboard, preferenze, forum), non
                consente di modificare la password né di accedere ad aree amministrative.
              </p>
              <p className="text-sm mt-2">
                <strong>Come disattivarlo.</strong> Puoi disabilitare l'accesso automatico in qualsiasi momento:
                (i) dalla pagina <em>Profilo</em> se sei autenticato via Google/Facebook/LinkedIn, oppure
                (ii) dal link <em>«Gestisci preferenze»</em> presente in fondo a ogni nostra email. Dopo la
                disattivazione, i link nelle email non conterranno più il codice <code>ac</code> e dovrai effettuare
                il login manuale per accedere alle aree riservate. L'impostazione si applica sia alla newsletter
                sia ai job alert.
              </p>
            </div>
            <div className="bg-surface-alt/50 p-4 rounded-2xl border border-edge">
              <h3 className="font-medium text-heading mb-2 flex items-center gap-2">
                <Mail className="text-accent flex-shrink-0" size={18} />
                Frequenza adattiva del bollettino quotidiano
              </h3>
              <p className="text-sm">
                Il <em>Bollettino del Frontaliere</em> non viene inviato con la stessa frequenza a tutti. Per non
                riempire la casella di chi non lo legge, la frequenza di invio si adatta al singolo destinatario:
                registriamo le <strong>aperture e i clic sui link del bollettino</strong> — gli stessi eventi che i
                fornitori di posta ci comunicano già per newsletter e job alert — e da questi ricaviamo un intervallo
                fra un invio e il successivo, da un giorno a una settimana. Chi clicca torna alla frequenza
                giornaliera; dopo tre invii senza alcuna interazione l'intervallo si allunga di un passo.
              </p>
              <p className="text-sm mt-2">
                <strong>Cosa conserviamo.</strong> Sul tuo record di iscrizione: la data dell'ultimo bollettino
                inviato, l'intervallo corrente in giorni, il numero di invii consecutivi senza interazione e
                l'eventuale frequenza che hai scelto tu. Non profiliamo il contenuto dei clic oltre al fatto che sono
                avvenuti.
              </p>
              <p className="text-sm mt-2">
                <strong>Base giuridica e opposizione.</strong> Legittimo interesse a limitare la frequenza delle
                comunicazioni, con opposizione effettiva: dal link <em>«Gestisci preferenze»</em> in fondo a ogni
                bollettino puoi fissare tu la frequenza (da giornaliera a settimanale) oppure disattivare il solo
                bollettino, lasciando attivi newsletter e job alert. Una frequenza scelta da te prevale sempre
                sull'algoritmo.
              </p>
            </div>
          </div>
        </div>

        {/* Section 5: Client-side processing */}
        <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-stripe-sm">
          <h2 className="text-xl font-medium font-display text-heading mb-4 flex items-center gap-3">
            <Lock className="text-accent flex-shrink-0" size={22} />
            Elaborazione Lato Client
          </h2>
          <div className="space-y-3 text-subtle">
            <p>
              Il simulatore è un'applicazione <strong>completamente lato client</strong>:
            </p>
            <ul className="list-disc list-inside space-y-2 ml-4">
              <li>Tutti i calcoli vengono eseguiti direttamente nel tuo browser</li>
              <li>Nessun dato del simulatore viene trasmesso via Internet durante l'utilizzo</li>
              <li>Non è necessario creare account o fornire informazioni personali per usare gli strumenti</li>
              <li>Puoi utilizzare il simulatore anche offline (dopo il primo caricamento)</li>
            </ul>
          </div>
        </div>

        {/* Section 6: Cookies */}
        <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-stripe-sm">
          <h2 className="text-xl font-medium font-display text-heading mb-4 flex items-center gap-3">
            <Database className="text-warning flex-shrink-0" size={22} />
            Cookie e Storage Locale
          </h2>
          <div className="space-y-3 text-subtle">
            <p>
              Il sito utilizza cookie e tecnologie di storage locale per funzionare e per migliorare la tua
              esperienza. Al primo accesso un banner ti consente di <strong>accettare, rifiutare o personalizzare</strong>
              le categorie non essenziali (Analytics e Pubblicità); i cookie tecnici sono sempre attivi perché
              indispensabili. Le tue scelte sono memorizzate e modificabili in qualsiasi momento. Le categorie non
              essenziali sono caricate solo dopo il consenso, in conformità alla Direttiva ePrivacy 2002/58/CE e
              all'art. 122 del Codice Privacy.
            </p>
            <div className="bg-surface-alt/50 p-4 rounded-2xl border border-edge">
              <h3 className="font-medium text-heading mb-2">Cookie Tecnici</h3>
              <p className="text-sm">
                Cookie essenziali per il funzionamento del sito (es. preferenze tema, stato del consenso, sessione
                di autenticazione). Non richiedono consenso.
              </p>
            </div>
            <div className="bg-surface-alt/50 p-4 rounded-2xl border border-edge">
              <h3 className="font-medium text-heading mb-2">Cookie Analytics</h3>
              <p className="text-sm">
                Cookie di Google Analytics, PostHog e Microsoft Clarity per statistiche anonime
                (vedi sezione «Analisi Anonima del Traffico»). Soggetti a consenso.
              </p>
            </div>
            <div className="bg-surface-alt/50 p-4 rounded-2xl border border-edge">
              <h3 className="font-medium text-heading mb-2">Cookie Pubblicitari</h3>
              <p className="text-sm">
                Cookie di Google AdSense per la visualizzazione di annunci (vedi sezione «Pubblicità»).
                Soggetti a consenso; in assenza di consenso vengono mostrati, ove disponibili, annunci non
                personalizzati.
              </p>
            </div>
            <div className="bg-surface-alt/50 p-4 rounded-2xl border border-edge">
              <h3 className="font-medium text-heading mb-2">LocalStorage</h3>
              <p className="text-sm">
                Utilizziamo il LocalStorage del browser per salvare le tue preferenze (tema scuro/chiaro)
                e mantenere i parametri dell'ultima simulazione. Questi dati rimangono <strong>solo sul tuo dispositivo</strong>.
              </p>
            </div>
          </div>
        </div>

        {/* Section 7: Advertising */}
        <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-stripe-sm">
          <h2 className="text-xl font-medium font-display text-heading mb-4 flex items-center gap-3">
            <BarChart3 className="text-warning flex-shrink-0" size={22} />
            Pubblicità (Google AdSense)
          </h2>
          <div className="space-y-3 text-subtle">
            <p>
              Il sito è gratuito e si sostiene tramite la pubblicità erogata da <strong>Google AdSense</strong>.
              Google e i suoi partner possono utilizzare cookie e identificatori per mostrare annunci, anche
              personalizzati, in base alle visite a questo e ad altri siti.
            </p>
            <div className="bg-surface-alt/50 p-4 rounded-2xl border border-edge">
              <h3 className="font-medium text-heading mb-2">Consenso e personalizzazione</h3>
              <p className="text-sm">
                Per gli utenti dello Spazio Economico Europeo, del Regno Unito e della Svizzera, la
                personalizzazione degli annunci avviene solo previo consenso, raccolto tramite il banner cookie in
                conformità alla policy di Google sul consenso degli utenti UE. Se rifiuti la categoria
                «Pubblicità», potranno comunque essere mostrati annunci <strong>non personalizzati</strong>.
                Puoi gestire le preferenze pubblicitarie di Google in qualsiasi momento su{' '}
                <a href="https://adssettings.google.com" target="_blank" rel="noopener noreferrer" className="text-accent underline">adssettings.google.com</a>{' '}
                e informarti su{' '}
                <a href="https://policies.google.com/technologies/partner-sites" target="_blank" rel="noopener noreferrer" className="text-accent underline">come Google usa i dati</a>.
              </p>
            </div>
          </div>
        </div>

        {/* Section 8: Legal bases */}
        <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-stripe-sm">
          <h2 className="text-xl font-medium font-display text-heading mb-4 flex items-center gap-3">
            <Scale className="text-accent flex-shrink-0" size={22} />
            Basi Giuridiche del Trattamento
          </h2>
          <div className="space-y-3 text-subtle">
            <p>
              Trattiamo i dati personali solo se sussiste una base giuridica valida ai sensi dell'art. 6 GDPR
              e dell'art. 31 nLPD:
            </p>
            <ul className="list-disc list-inside space-y-2 ml-4 text-sm">
              <li><strong>Consenso</strong> (art. 6.1.a): cookie analytics e pubblicitari, iscrizione alla newsletter e ai job alert.</li>
              <li><strong>Esecuzione di misure precontrattuali / contratto</strong> (art. 6.1.b): gestione dell'account, della dashboard e dei servizi richiesti dall'utente.</li>
              <li><strong>Obbligo legale</strong> (art. 6.1.c): adempimenti fiscali, contabili e risposte a richieste delle autorità.</li>
              <li><strong>Legittimo interesse</strong> (art. 6.1.f): sicurezza del sito, prevenzione di abusi/frodi, statistiche aggregate e «soft spam» verso clienti, con valutazione di bilanciamento e diritto di opposizione.</li>
            </ul>
            <p className="text-sm">
              Quando la base è il consenso, puoi revocarlo in qualsiasi momento senza che ciò pregiudichi la
              liceità dei trattamenti svolti prima della revoca.
            </p>
          </div>
        </div>

        {/* Section 9: International transfers */}
        <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-stripe-sm">
          <h2 className="text-xl font-medium font-display text-heading mb-4 flex items-center gap-3">
            <Globe className="text-accent flex-shrink-0" size={22} />
            Trasferimenti Internazionali di Dati
          </h2>
          <div className="space-y-3 text-subtle">
            <p>
              Alcuni fornitori (Google, Microsoft) possono trattare dati anche al di fuori dell'Unione Europea e
              della Svizzera, in particolare negli Stati Uniti. Tali trasferimenti avvengono in presenza di
              garanzie adeguate ai sensi del Capo V del GDPR e della nLPD:
            </p>
            <ul className="list-disc list-inside space-y-2 ml-4 text-sm">
              <li>adesione al <strong>EU–U.S. Data Privacy Framework</strong> (e relativa estensione UK e Swiss–U.S.), ove applicabile;</li>
              <li><strong>Clausole Contrattuali Standard (SCC)</strong> approvate dalla Commissione Europea, integrate da misure supplementari;</li>
              <li>decisioni di adeguatezza vigenti, ove disponibili.</li>
            </ul>
            <p className="text-sm">
              Puoi richiederci informazioni sulle garanzie adottate e, ove previsto, copia delle stesse scrivendo a{' '}
              <a href={`mailto:${PRIVACY_EMAIL}`} className="text-accent underline">{PRIVACY_EMAIL}</a>.
            </p>
          </div>
        </div>

        {/* Section 10: Third-Party Services */}
        <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-stripe-sm">
          <h2 className="text-xl font-medium font-display text-heading mb-4 flex items-center gap-3">
            <Shield className="text-accent flex-shrink-0" size={22} />
            Servizi di Terze Parti
          </h2>
          <div className="space-y-3 text-subtle">
            <p>Il sito si avvale dei seguenti servizi esterni, ciascuno dotato di propria informativa privacy:</p>
            <ul className="list-disc list-inside space-y-2 ml-4 text-sm">
              <li><strong>Google</strong> (Analytics 4, AdSense, Firebase Auth/Remote Config, Sign-In): analisi, pubblicità, autenticazione e configurazione — <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer" className="text-accent underline">policies.google.com/privacy</a></li>
              <li><strong>PostHog EU</strong>: analisi comportamentale anonima (dati in Europa) — <a href="https://posthog.com/privacy" target="_blank" rel="noopener noreferrer" className="text-accent underline">posthog.com/privacy</a></li>
              <li><strong>Microsoft Clarity</strong>: heatmap e registrazioni di sessione anonime — <a href="https://privacy.microsoft.com" target="_blank" rel="noopener noreferrer" className="text-accent underline">privacy.microsoft.com</a></li>
              <li><strong>Cloudflare</strong>: rete di distribuzione (CDN), sicurezza e protezione dagli abusi</li>
            </ul>
            <p className="text-sm italic">
              Non siamo responsabili delle pratiche di privacy di siti web di terze parti.
              Ti consigliamo di leggere le loro policy prima di fornire informazioni personali.
            </p>
          </div>
        </div>

        {/* Section 11: Data retention */}
        <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-stripe-sm">
          <h2 className="text-xl font-medium font-display text-heading mb-4 flex items-center gap-3">
            <Clock className="text-accent flex-shrink-0" size={22} />
            Conservazione dei Dati
          </h2>
          <div className="space-y-3 text-subtle">
            <p>
              Conserviamo i dati personali per il tempo strettamente necessario alle finalità per cui sono raccolti,
              secondo il principio di limitazione della conservazione (art. 5.1.e GDPR):
            </p>
            <ul className="list-disc list-inside space-y-2 ml-4 text-sm">
              <li><strong>Dati del simulatore fiscale</strong>: nessuna conservazione lato server (restano solo sul tuo dispositivo).</li>
              <li><strong>Iscrizione newsletter / job alert</strong>: fino alla revoca del consenso o alla cancellazione dell'iscrizione.</li>
              <li><strong>Account e dashboard</strong>: per la durata dell'account; cancellati su richiesta o dopo prolungata inattività.</li>
              <li><strong>Dati di analisi</strong>: aggregati/anonimi conservati secondo le impostazioni di retention dei rispettivi strumenti.</li>
              <li><strong>Log di sicurezza</strong>: per il tempo necessario alla prevenzione di abusi e all'adempimento di obblighi legali.</li>
            </ul>
          </div>
        </div>

        {/* Section 12: Security */}
        <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-stripe-sm">
          <h2 className="text-xl font-medium font-display text-heading mb-4 flex items-center gap-3">
            <Lock className="text-accent flex-shrink-0" size={22} />
            Sicurezza
          </h2>
          <div className="space-y-3 text-subtle">
            <p>
              I dati personali e finanziari che inserisci nel simulatore non vengono mai trasmessi.
              La sicurezza di tali dati dipende dalla sicurezza del tuo dispositivo e browser.
            </p>
            <p>
              Adottiamo misure tecniche e organizzative adeguate (art. 32 GDPR), tra cui connessione cifrata
              <strong> HTTPS</strong>, autenticazione gestita tramite provider affidabili e accesso limitato ai
              dati. Nessun sistema è però sicuro al 100%: in caso di violazione dei dati personali che comporti un
              rischio per i tuoi diritti, provvederemo alle notifiche previste dalla normativa (artt. 33–34 GDPR;
              art. 24 nLPD).
            </p>
          </div>
        </div>

        {/* Section 13: Automated decisions */}
        <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-stripe-sm">
          <h2 className="text-xl font-medium font-display text-heading mb-4 flex items-center gap-3">
            <Eye className="text-accent flex-shrink-0" size={22} />
            Profilazione e Decisioni Automatizzate
          </h2>
          <div className="space-y-3 text-subtle">
            <p>
              Non adottiamo processi decisionali <strong>esclusivamente automatizzati</strong> che producano effetti
              giuridici o incidano in modo analogo significativo sull'utente ai sensi dell'art. 22 GDPR. Eventuale
              profilazione è limitata all'ottimizzazione dei contenuti (es. selezione dei job alert e delle
              comunicazioni più pertinenti) e non determina conseguenze legali o economiche automatiche.
            </p>
          </div>
        </div>

        {/* Section 14: Your Rights */}
        <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-stripe-sm">
          <h2 className="text-xl font-medium font-display text-heading mb-4 flex items-center gap-3">
            <CheckCircle2 className="text-accent flex-shrink-0" size={22} />
            I Tuoi Diritti
          </h2>
          <div className="space-y-3 text-subtle">
            <p>
              Ai sensi del <strong>GDPR</strong>, della <strong>nLPD svizzera</strong> e delle altre normative
              applicabili, hai diritto a:
            </p>
            <ul className="list-disc list-inside space-y-2 ml-4">
              <li>Accedere ai tuoi dati personali e ottenerne copia</li>
              <li>Rettificare dati inesatti o incompleti</li>
              <li>Cancellare i tuoi dati («diritto all'oblio»)</li>
              <li>Limitare il trattamento dei dati</li>
              <li>Opporti al trattamento, incluso il marketing diretto</li>
              <li>Ricevere e trasferire i dati (portabilità)</li>
              <li>Revocare il consenso in qualsiasi momento</li>
              <li>Non essere sottoposto a decisioni esclusivamente automatizzate</li>
            </ul>
            <div className="bg-success-subtle p-4 rounded-2xl border border-success-border mt-4">
              <p className="text-sm font-semibold text-success">
                Per il simulatore fiscale NON raccogliamo dati personali. Per newsletter, account e job alert puoi
                esercitare i tuoi diritti scrivendo a{' '}
                <a href={`mailto:${PRIVACY_EMAIL}`} className="text-accent underline">{PRIVACY_EMAIL}</a>{' '}
                o usando la{' '}
                <button onClick={() => nav.navigateTo('data-deletion')} className="text-accent underline font-semibold">procedura di cancellazione dati</button>.
                Puoi inoltre cancellarti dalla newsletter tramite il link presente in ogni email.
              </p>
              <p className="text-sm mt-2">
                <strong>Diritto di reclamo.</strong> Se ritieni che il trattamento violi la normativa, puoi
                proporre reclamo a un'autorità di controllo: in Italia il{' '}
                <a href="https://www.garanteprivacy.it" target="_blank" rel="noopener noreferrer" className="text-accent underline">Garante per la protezione dei dati personali</a>,
                in Svizzera l'<a href="https://www.edoeb.admin.ch" target="_blank" rel="noopener noreferrer" className="text-accent underline">Incaricato federale della protezione dei dati e della trasparenza (IFPDT)</a>,
                o l'autorità competente del tuo Paese di residenza.
              </p>
            </div>
          </div>
        </div>

        {/* Section 15: International / California users */}
        <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-stripe-sm">
          <h2 className="text-xl font-medium font-display text-heading mb-4 flex items-center gap-3">
            <Globe className="text-accent flex-shrink-0" size={22} />
            Utenti Internazionali e Diritti Specifici
          </h2>
          <div className="space-y-3 text-subtle">
            <div className="bg-surface-alt/50 p-4 rounded-2xl border border-edge">
              <h3 className="font-medium text-heading mb-2">California (CCPA / CPRA)</h3>
              <p className="text-sm">
                Se sei residente in California, hai diritto a sapere quali categorie di informazioni personali
                trattiamo, a richiederne cancellazione e correzione, e a non subire discriminazioni per l'esercizio
                dei tuoi diritti. <strong>Non vendiamo</strong> i tuoi dati personali in cambio di denaro. L'utilizzo
                di cookie pubblicitari potrebbe configurare una «vendita» o «condivisione» secondo il CPRA: puoi
                esercitare l'opzione <strong>«Do Not Sell or Share My Personal Information»</strong> rifiutando la
                categoria «Pubblicità» nel banner cookie e impostando i controlli su{' '}
                <a href="https://adssettings.google.com" target="_blank" rel="noopener noreferrer" className="text-accent underline">adssettings.google.com</a>.
                Onoriamo i segnali di preferenza di tipo Global Privacy Control (GPC) ove tecnicamente disponibili.
              </p>
            </div>
            <div className="bg-surface-alt/50 p-4 rounded-2xl border border-edge">
              <h3 className="font-medium text-heading mb-2">Altri Paesi</h3>
              <p className="text-sm">
                Riconosciamo agli utenti di altre giurisdizioni i diritti previsti dalle rispettive normative,
                tra cui UK GDPR (Regno Unito), LGPD (Brasile), PIPEDA (Canada), Legge 25 (Québec), Privacy Act
                (Australia) e POPIA (Sudafrica). Per esercitarli, contatta{' '}
                <a href={`mailto:${PRIVACY_EMAIL}`} className="text-accent underline">{PRIVACY_EMAIL}</a>.
              </p>
            </div>
          </div>
        </div>

        {/* Section 16: Children Privacy */}
        <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-stripe-sm">
          <h2 className="text-xl font-medium font-display text-heading mb-4 flex items-center gap-3">
            <Shield className="text-accent flex-shrink-0" size={22} />
            Privacy dei Minori
          </h2>
          <div className="space-y-3 text-subtle">
            <p>
              Il nostro servizio è destinato a persone maggiorenni che vogliono simulare la propria situazione fiscale
              come lavoratori frontalieri. Non raccogliamo consapevolmente dati da minori di 18 anni (né di 16, soglia
              minima ex art. 8 GDPR per i servizi della società dell'informazione). Se ritieni che un minore ci abbia
              fornito dati, contattaci e provvederemo alla cancellazione.
            </p>
          </div>
        </div>

        {/* Section 17: Governing law */}
        <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-stripe-sm">
          <h2 className="text-xl font-medium font-display text-heading mb-4 flex items-center gap-3">
            <Scale className="text-accent flex-shrink-0" size={22} />
            Legge Applicabile
          </h2>
          <div className="space-y-3 text-subtle">
            <p>
              La presente informativa è disciplinata dalla normativa applicabile in funzione della residenza
              dell'utente. Nulla in questo documento limita o esclude i diritti inderogabili riconosciuti
              all'utente dalla legge del proprio Paese di residenza abituale o dalle norme imperative applicabili
              (incluse GDPR, nLPD e leggi locali a tutela dei consumatori), che prevalgono su qualsiasi clausola
              eventualmente difforme.
            </p>
          </div>
        </div>

        {/* Section 18: Changes */}
        <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-stripe-sm">
          <h2 className="text-xl font-medium font-display text-heading mb-4 flex items-center gap-3">
            <Eye className="text-subtle flex-shrink-0" size={22} />
            Modifiche alla Privacy Policy
          </h2>
          <div className="space-y-3 text-subtle">
            <p>
              Potremmo aggiornare questa Privacy Policy occasionalmente. Ti consigliamo di rivedere periodicamente
              questa pagina per eventuali modifiche. Le modifiche saranno effettive immediatamente dopo la pubblicazione
              su questa pagina; in caso di modifiche sostanziali ne daremo evidenza aggiornando la data sottostante.
            </p>
            <p className="text-sm italic">
              Data ultimo aggiornamento: <strong>12 agosto 2026</strong>
            </p>
          </div>
        </div>

        {/* Section 19: Contact */}
        <div className="bg-gradient-to-br from-accent-subtle to-accent-subtle rounded-2xl border border-accent-border p-4 sm:p-6 shadow-stripe-sm">
          <h2 className="text-xl font-medium font-display text-heading mb-4 flex items-center gap-3">
            <Shield className="text-accent flex-shrink-0" size={22} />
            Contattaci
          </h2>
          <div className="space-y-3 text-subtle">
            <p>
              Se hai domande su questa Privacy Policy o sulle nostre pratiche di privacy, puoi contattarci:
            </p>
            <p className="text-sm">
              Via e-mail all'indirizzo{' '}
              <a href={`mailto:${PRIVACY_EMAIL}`} className="text-accent underline font-semibold">{PRIVACY_EMAIL}</a>,
              tramite la{' '}
              <button onClick={() => nav.navigateTo('contact')} className="text-accent underline font-semibold">pagina contatti</button>,
              oppure sulla nostra pagina Facebook:
            </p>
            <div className="flex items-center gap-2 mt-3">
              <a
                href="https://www.facebook.com/profile.php?id=61588174947294"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-on-accent font-semibold rounded-2xl transition-colors shadow-stripe-sm"
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
          className="inline-flex items-center gap-2 px-6 py-3 bg-accent hover:bg-accent-hover text-on-accent font-bold rounded-2xl transition-[color,background-color,border-color,box-shadow] shadow-stripe hover:shadow-stripe-md"
        >
          <ArrowLeft size={18} />
          Torna al Simulatore
        </button>
      </div>
    </div>
  );
};
