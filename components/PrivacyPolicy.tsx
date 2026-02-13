import React from 'react';
import { Shield, Lock, Database, Eye, CheckCircle2, ArrowLeft } from 'lucide-react';

interface Props {
  onBack: () => void;
}

export const PrivacyPolicy: React.FC<Props> = ({ onBack }) => {
  return (
    <div className="max-w-4xl mx-auto px-4 py-8 animate-fade-in">
      {/* Back Button */}
      <button 
        onClick={onBack}
        className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 transition-colors"
      >
        <ArrowLeft size={16} />
        Torna alla Home
      </button>

      {/* Header */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-8 shadow-lg mb-6">
        <div className="flex items-center gap-4 mb-4">
          <div className="p-3 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl shadow-lg">
            <Shield className="text-white" size={32} />
          </div>
          <div>
            <h1 className="text-3xl font-extrabold text-slate-800 dark:text-slate-100">Privacy Policy</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Ultimo aggiornamento: Febbraio 2026</p>
          </div>
        </div>
        <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
          La tua privacy è importante per noi. Questa pagina descrive come gestiamo i dati quando utilizzi 
          il simulatore fiscale <strong>Frontaliere Si o No?</strong>
        </p>
      </div>

      {/* Privacy Sections */}
      <div className="space-y-6">
        
        {/* Section 1: No Data Collection */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-green-100 dark:bg-green-900/30 rounded-xl">
              <Database className="text-green-600 dark:text-green-400" size={24} />
            </div>
            <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">Raccolta e Utilizzo dei Dati</h2>
          </div>
          <div className="space-y-3 text-slate-600 dark:text-slate-400">
            <div className="flex items-start gap-3 bg-green-50 dark:bg-green-900/20 p-4 rounded-xl border border-green-200 dark:border-green-800">
              <CheckCircle2 className="text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" size={20} />
              <div>
                <p className="font-bold text-green-800 dark:text-green-300 mb-1">ZERO Raccolta Dati Personali</p>
                <p className="text-sm">
                  <strong>Non raccogliamo, non salviamo e non trasmettiamo</strong> alcun dato personale o finanziario inserito nel simulatore.
                </p>
              </div>
            </div>
            <p>
              Tutti i calcoli fiscali vengono eseguiti <strong>esclusivamente lato client</strong> (nel tuo browser). 
              I dati che inserisci (reddito, situazione familiare, spese, ecc.) rimangono <strong>sul tuo dispositivo</strong> 
              e non vengono mai inviati ai nostri server o a terze parti.
            </p>
          </div>
        </div>

        {/* Section 2: Client-Side Processing */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-xl">
              <Lock className="text-blue-600 dark:text-blue-400" size={24} />
            </div>
            <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">Elaborazione Lato Client</h2>
          </div>
          <div className="space-y-3 text-slate-600 dark:text-slate-400">
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

        {/* Section 3: Analytics */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-purple-100 dark:bg-purple-900/30 rounded-xl">
              <Eye className="text-purple-600 dark:text-purple-400" size={24} />
            </div>
            <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">Analytics e Statistiche</h2>
          </div>
          <div className="space-y-3 text-slate-600 dark:text-slate-400">
            <p>
              Utilizziamo <strong>Google Analytics 4</strong> per raccogliere statistiche anonime sull'utilizzo del sito:
            </p>
            <ul className="list-disc list-inside space-y-2 ml-4">
              <li><strong>Dati raccolti</strong>: Pagine visitate, tempo di permanenza, tipo di dispositivo, browser utilizzato</li>
              <li><strong>Dati NON raccolti</strong>: Indirizzi IP completi, dati personali, dati finanziari inseriti nel simulatore</li>
              <li><strong>Finalità</strong>: Migliorare l'esperienza utente e comprendere quali funzionalità sono più utilizzate</li>
            </ul>
            <p className="text-sm italic mt-2">
              Google Analytics utilizza cookie di terze parti. Puoi disabilitare questi cookie tramite le impostazioni del tuo browser 
              o utilizzando estensioni browser apposite (es. "Google Analytics Opt-out Browser Add-on").
            </p>
          </div>
        </div>

        {/* Section 4: Cookies */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-amber-100 dark:bg-amber-900/30 rounded-xl">
              <Database className="text-amber-600 dark:text-amber-400" size={24} />
            </div>
            <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">Cookie e Storage Locale</h2>
          </div>
          <div className="space-y-3 text-slate-600 dark:text-slate-400">
            <p>Il sito utilizza tecnologie di storage locale per migliorare la tua esperienza:</p>
            <div className="bg-slate-50 dark:bg-slate-900/50 p-4 rounded-xl border border-slate-200 dark:border-slate-700">
              <h3 className="font-bold text-slate-800 dark:text-slate-100 mb-2">LocalStorage</h3>
              <p className="text-sm">
                Utilizziamo il LocalStorage del browser per salvare le tue preferenze (tema scuro/chiaro) 
                e mantenere i parametri dell'ultima simulazione. Questi dati rimangono <strong>solo sul tuo dispositivo</strong>.
              </p>
            </div>
            <div className="bg-slate-50 dark:bg-slate-900/50 p-4 rounded-xl border border-slate-200 dark:border-slate-700">
              <h3 className="font-bold text-slate-800 dark:text-slate-100 mb-2">Cookie Tecnici</h3>
              <p className="text-sm">
                Cookie essenziali per il funzionamento del sito (es. preferenze tema). Non richiedono consenso 
                ai sensi del GDPR.
              </p>
            </div>
            <div className="bg-slate-50 dark:bg-slate-900/50 p-4 rounded-xl border border-slate-200 dark:border-slate-700">
              <h3 className="font-bold text-slate-800 dark:text-slate-100 mb-2">Cookie Analytics</h3>
              <p className="text-sm">
                Cookie di Google Analytics per statistiche anonime (vedi sezione precedente).
              </p>
            </div>
          </div>
        </div>

        {/* Section 5: Third-Party Services */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-indigo-100 dark:bg-indigo-900/30 rounded-xl">
              <Shield className="text-indigo-600 dark:text-indigo-400" size={24} />
            </div>
            <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">Servizi di Terze Parti</h2>
          </div>
          <div className="space-y-3 text-slate-600 dark:text-slate-400">
            <p>Il sito potrebbe includere collegamenti a servizi esterni:</p>
            <ul className="list-disc list-inside space-y-2 ml-4">
              <li><strong>Facebook</strong>: Link alla nostra pagina Facebook. Se clicchi sul link, sarai soggetto alla privacy policy di Facebook.</li>
              <li><strong>Google Analytics</strong>: Per statistiche anonime (come descritto sopra).</li>
            </ul>
            <p className="text-sm italic">
              Non siamo responsabili delle pratiche di privacy di siti web di terze parti. 
              Ti consigliamo di leggere le loro policy prima di fornire informazioni personali.
            </p>
          </div>
        </div>

        {/* Section 6: Data Security */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-red-100 dark:bg-red-900/30 rounded-xl">
              <Lock className="text-red-600 dark:text-red-400" size={24} />
            </div>
            <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">Sicurezza</h2>
          </div>
          <div className="space-y-3 text-slate-600 dark:text-slate-400">
            <p>
              Poiché <strong>non raccogliamo dati personali</strong>, non esistono dati da proteggere sui nostri server. 
              La sicurezza dei tuoi dati dipende dalla sicurezza del tuo dispositivo e browser.
            </p>
            <p>
              Il sito è servito tramite connessione <strong>HTTPS sicura</strong> per garantire che la comunicazione 
              tra il tuo browser e i nostri server sia crittografata.
            </p>
          </div>
        </div>

        {/* Section 7: Your Rights */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-cyan-100 dark:bg-cyan-900/30 rounded-xl">
              <CheckCircle2 className="text-cyan-600 dark:text-cyan-400" size={24} />
            </div>
            <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">I Tuoi Diritti (GDPR)</h2>
          </div>
          <div className="space-y-3 text-slate-600 dark:text-slate-400">
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
            <div className="bg-green-50 dark:bg-green-900/20 p-4 rounded-xl border border-green-200 dark:border-green-800 mt-4">
              <p className="text-sm font-semibold text-green-800 dark:text-green-300">
                ✅ Poiché NON raccogliamo dati personali, non è necessario esercitare questi diritti per il simulatore.
              </p>
              <p className="text-sm mt-2">
                Se hai domande sulla privacy, contattaci tramite la nostra pagina Facebook.
              </p>
            </div>
          </div>
        </div>

        {/* Section 8: Children Privacy */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-pink-100 dark:bg-pink-900/30 rounded-xl">
              <Shield className="text-pink-600 dark:text-pink-400" size={24} />
            </div>
            <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">Privacy dei Minori</h2>
          </div>
          <div className="space-y-3 text-slate-600 dark:text-slate-400">
            <p>
              Il nostro servizio è destinato a persone maggiorenni che vogliono simulare la propria situazione fiscale 
              come lavoratori frontalieri. Non raccogliamo consapevolmente dati da minori di 18 anni.
            </p>
          </div>
        </div>

        {/* Section 9: Changes */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-slate-100 dark:bg-slate-700 rounded-xl">
              <Eye className="text-slate-600 dark:text-slate-400" size={24} />
            </div>
            <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">Modifiche alla Privacy Policy</h2>
          </div>
          <div className="space-y-3 text-slate-600 dark:text-slate-400">
            <p>
              Potremmo aggiornare questa Privacy Policy occasionalmente. Ti consigliamo di rivedere periodicamente 
              questa pagina per eventuali modifiche. Le modifiche saranno effettive immediatamente dopo la pubblicazione 
              su questa pagina.
            </p>
            <p className="text-sm italic">
              Data ultimo aggiornamento: <strong>Febbraio 2026</strong>
            </p>
          </div>
        </div>

        {/* Section 10: Contact */}
        <div className="bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-indigo-950/30 dark:to-purple-950/30 rounded-2xl border border-indigo-200 dark:border-indigo-800 p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-indigo-500 rounded-xl">
              <Shield className="text-white" size={24} />
            </div>
            <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">Contattaci</h2>
          </div>
          <div className="space-y-3 text-slate-600 dark:text-slate-400">
            <p>
              Se hai domande su questa Privacy Policy o sulle nostre pratiche di privacy, puoi contattarci tramite:
            </p>
            <div className="flex items-center gap-2 mt-3">
              <a 
                href="https://www.facebook.com/profile.php?id=61588174947294" 
                target="_blank" 
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl transition-colors shadow-sm"
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
          onClick={onBack}
          className="inline-flex items-center gap-2 px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl transition-all shadow-lg hover:shadow-xl"
        >
          <ArrowLeft size={18} />
          Torna al Simulatore
        </button>
      </div>
    </div>
  );
};
