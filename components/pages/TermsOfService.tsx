import React from 'react';
import { FileText, Scale, AlertTriangle, Globe, ArrowLeft } from 'lucide-react';
import { useNavigation } from '@/services/NavigationContext';

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
 <div className="p-3 bg-gradient-to-br from-amber-500 to-orange-600 rounded-2xl shadow-lg">
 <FileText className="text-white" size={32} />
 </div>
 <div>
 <h1 className="text-2xl sm:text-3xl font-extrabold text-strong">Termini di Servizio</h1>
 <p className="text-sm text-muted mt-1">Ultimo aggiornamento: Marzo 2026</p>
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
 <h2 className="text-xl font-bold text-strong">1. Natura del Servizio</h2>
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
 <h2 className="text-xl font-bold text-strong">2. Esclusione di Responsabilità</h2>
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
 <h2 className="text-xl font-bold text-strong">3. Proprietà Intellettuale</h2>
 </div>
 <div className="space-y-3 text-subtle">
 <p>
 I contenuti originali, il codice sorgente, il design e i marchi presenti su Frontaliere Ticino sono di proprietà
 dei rispettivi titolari. Il progetto è distribuito con licenza open source su GitHub.
 </p>
 <p>
 Gli articoli e i contenuti editoriali sono pubblicati a scopo informativo. La riproduzione è consentita con
 attribuzione e link alla fonte originale, nel rispetto delle normative vigenti sul diritto d'autore.
 </p>
 </div>
 </div>

 {/* Section 4: Utilizzo accettabile */}
 <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm">
 <div className="flex items-center gap-3 mb-4">
 <div className="p-2 bg-success-subtle rounded-xl">
 <FileText className="text-success" size={24} />
 </div>
 <h2 className="text-xl font-bold text-strong">4. Utilizzo Accettabile</h2>
 </div>
 <div className="space-y-3 text-subtle">
 <p>L'utente si impegna a:</p>
 <ul className="list-disc list-inside space-y-1 text-sm">
 <li>Utilizzare la piattaforma nel rispetto delle leggi svizzere e italiane vigenti</li>
 <li>Non tentare di compromettere la sicurezza o il funzionamento del servizio</li>
 <li>Non utilizzare sistemi automatizzati per accedere massivamente ai contenuti, salvo autorizzazione</li>
 <li>Non ripubblicare contenuti senza attribuzione</li>
 </ul>
 </div>
 </div>

 {/* Section 5: Modifiche */}
 <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm">
 <div className="flex items-center gap-3 mb-4">
 <div className="p-2 bg-surface-raised rounded-xl">
 <FileText className="text-subtle" size={24} />
 </div>
 <h2 className="text-xl font-bold text-strong">5. Modifiche ai Termini</h2>
 </div>
 <div className="space-y-3 text-subtle">
 <p>
 Ci riserviamo il diritto di modificare questi termini in qualsiasi momento. Le modifiche saranno
 pubblicate su questa pagina con la data di aggiornamento. L'uso continuato della piattaforma
 dopo la pubblicazione delle modifiche costituisce accettazione dei nuovi termini.
 </p>
 </div>
 </div>

 {/* Section 6: Contatti */}
 <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm">
 <div className="space-y-3 text-subtle">
 <h2 className="text-xl font-bold text-strong">6. Contatti</h2>
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
