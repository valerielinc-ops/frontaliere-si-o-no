import React, { useState } from 'react';
import { Shield, Clock, FileText, Users, CheckCircle2, AlertCircle, ChevronDown, ChevronUp, Briefcase, Globe, Calendar, Info, ArrowRight, Building2 } from 'lucide-react';
import { Analytics } from '@/services/analytics';

interface PermitType {
  id: 'G' | 'B' | 'C' | 'L';
  name: string;
  fullName: string;
  color: string;
  icon: string;
  duration: string;
  forWhom: string;
  description: string;
  requirements: string[];
  documents: string[];
  processingTime: string;
  cost: string;
  renewal: string;
  rights: string[];
  limitations: string[];
  familyReunion: string;
  taxImplications: string;
  tips: string[];
}

const PERMITS: PermitType[] = [
  {
    id: 'G',
    name: 'Permesso G',
    fullName: 'Permesso per Frontalieri',
    color: 'from-blue-500 to-indigo-600',
    icon: '🔵',
    duration: '5 anni (rinnovabile)',
    forWhom: 'Lavoratori che risiedono in uno stato UE/AELS e lavorano in Svizzera, tornando al domicilio almeno 1 volta a settimana',
    description: 'Il permesso G è il permesso standard per i frontalieri. Permette di lavorare in Svizzera continuando a risiedere nel paese di origine.',
    requirements: [
      'Cittadinanza UE/AELS',
      'Contratto di lavoro svizzero (o promessa di assunzione)',
      'Residenza in uno stato UE/AELS confinante (IT, FR, DE, AT)',
      'Rientro al domicilio almeno 1 volta a settimana',
      'Distanza ragionevole tra domicilio e luogo di lavoro',
    ],
    documents: [
      'Passaporto o carta d\'identità valida',
      'Contratto di lavoro svizzero',
      'Foto tessera (formato passaporto)',
      'Prova di domicilio nel paese di residenza',
      'Formulario di richiesta compilato (modulo cantonale)',
      'Attestato di assicurazione malattia (LAMal o equivalente)',
    ],
    processingTime: '2-4 settimane',
    cost: 'CHF 65 (varia per cantone)',
    renewal: 'Automatico con contratto attivo. Rinnovo ogni 5 anni. In caso di disoccupazione, validità ridotta a 6 mesi.',
    rights: [
      'Lavorare in Svizzera (dipendente)',
      'Aprire un conto bancario svizzero',
      'Accedere ai servizi sociali svizzeri (AVS, AI, LPP)',
      'Accedere all\'assicurazione disoccupazione (AD)',
      'Usare i trasporti pubblici a tariffe residenti',
    ],
    limitations: [
      'Obbligo di rientro settimanale al domicilio',
      'Non è possibile trasferire la residenza in Svizzera',
      'Non è possibile cambiare lavoro liberamente nei primi 12 mesi',
      'Non dà diritto al voto in Svizzera',
      'Attività autonoma limitata al settore dichiarato',
    ],
    familyReunion: 'Il permesso G non prevede ricongiungimento familiare in Svizzera. La famiglia resta nel paese di residenza.',
    taxImplications: 'Imposta alla fonte nel cantone di lavoro. Dal 2024, nuovo accordo: possibile doppia imposizione con credito d\'imposta per i nuovi frontalieri. Vecchi frontalieri mantengono il regime precedente (imponibilità solo in CH con ristorno ai comuni italiani).',
    tips: [
      'Chiedi sempre il Lohnausweis a fine anno al datore di lavoro',
      'Conserva tutte le ricevute di viaggio per la deducibilità',
      'Valuta attentamente se aderire alla LAMal o restare con SSN italiano',
      'Controlla la tua situazione con il Quadro RW nella dichiarazione italiana',
    ],
  },
  {
    id: 'B',
    name: 'Permesso B',
    fullName: 'Permesso di Dimora',
    color: 'from-emerald-500 to-teal-600',
    icon: '🟢',
    duration: '5 anni (rinnovabile)',
    forWhom: 'Cittadini UE/AELS che intendono risiedere in Svizzera con contratto di lavoro di almeno 12 mesi',
    description: 'Il permesso B permette di vivere e lavorare in Svizzera. Adatto a chi desidera trasferire la residenza dalla Svizzera.',
    requirements: [
      'Cittadinanza UE/AELS',
      'Contratto di lavoro svizzero di almeno 12 mesi',
      'Mezzi finanziari sufficienti (o contratto)',
      'Assicurazione malattia svizzera (LAMal obbligatoria)',
      'Alloggio adeguato in Svizzera',
    ],
    documents: [
      'Passaporto o carta d\'identità valida',
      'Contratto di lavoro (min. 12 mesi)',
      'Prova di alloggio in Svizzera',
      'Assicurazione malattia LAMal',
      'Certificato di stato civile',
      'Atto di nascita apostillato',
      'Formulario di registrazione presso il comune svizzero',
    ],
    processingTime: '2-6 settimane',
    cost: 'CHF 144 (varia per cantone)',
    renewal: 'Rinnovo ogni 5 anni se il contratto è ancora attivo. Dopo 5 anni con B, possibilità di richiedere il C.',
    rights: [
      'Vivere e lavorare in Svizzera senza restrizioni',
      'Cambiare lavoro e cantone liberamente',
      'Accesso completo ai servizi sociali svizzeri',
      'Diritto alla formazione professionale',
      'Possibilità di attività autonoma',
      'Accesso al 3° pilastro',
    ],
    limitations: [
      'Non dà diritto al voto (solo alcune votazioni comunali in certi cantoni)',
      'Legato alla condizione lavorativa (rischio non-rinnovo se disoccupato)',
      'Servizio militare/civile non obbligatorio ma possibile contributo',
      'Permesso limitato nel tempo (necessita rinnovo)',
    ],
    familyReunion: 'Sì, ricongiungimento familiare previsto per coniuge e figli sotto i 21 anni (o a carico). I familiari ricevono un permesso B.',
    taxImplications: 'Tassazione ordinaria in Svizzera (cantone + comune + confederazione). Non più soggetto a imposizione in Italia (se cancellato dall\'AIRE). Capital gain esente in CH. Attenzione alla exit tax italiana.',
    tips: [
      'Registrati all\'AIRE entro 90 giorni dal trasferimento',
      'Valuta attentamente i costi della vita in Ticino (affitto alto)',
      'Il 3° pilastro diventa molto vantaggioso con il B',
      'Mantieni la residenza per almeno 5 anni per accedere al permesso C',
    ],
  },
  {
    id: 'C',
    name: 'Permesso C',
    fullName: 'Permesso di Domicilio',
    color: 'from-amber-500 to-orange-600',
    icon: '🟠',
    duration: 'Illimitato',
    forWhom: 'Cittadini UE/AELS che hanno risieduto in Svizzera per almeno 5 anni continuativi con permesso B (10 per non-UE)',
    description: 'Il permesso C è il permesso più stabile e desiderabile. Offre quasi tutti i diritti di un cittadino svizzero, escluso il voto federale.',
    requirements: [
      'Almeno 5 anni di residenza con permesso B (UE/AELS)',
      'Nessun precedente penale rilevante',
      'Integrazione riuscita (lingua, conoscenza locale)',
      'Indipendenza finanziaria (nessun ricorso all\'aiuto sociale)',
      'Rispetto dell\'ordinamento giuridico',
    ],
    documents: [
      'Passaporto valido',
      'Attestato di residenza continuativa (5+ anni)',
      'Certificato di buona condotta (casellario giudiziale)',
      'Prova di integrazione (certificato lingua B1+)',
      'Dichiarazione fiscale aggiornata',
      'Prova di indipendenza finanziaria',
    ],
    processingTime: '1-3 mesi',
    cost: 'CHF 145-200 (varia per cantone)',
    renewal: 'Non necessario. Validità illimitata. Può essere revocato solo in casi gravi (frode, reati gravi, assenza dal paese per 6+ mesi senza preavviso).',
    rights: [
      'Residenza illimitata in Svizzera',
      'Cambio lavoro, cantone e attività senza restrizioni',
      'Accesso completo a tutti i servizi sociali',
      'Possibilità di lavoro autonomo senza restrizioni',
      'Accesso facilitato alla naturalizzazione',
      'Protezione contro l\'espulsione (quasi assoluta)',
      'Diritto di voto a livello comunale in alcuni cantoni',
    ],
    limitations: [
      'Nessun diritto di voto a livello federale',
      'Non equivale alla cittadinanza svizzera',
      'Revocabile in caso di soggiorno all\'estero prolungato (6+ mesi)',
      'Servizio militare non obbligatorio',
    ],
    familyReunion: 'Ricongiungimento familiare completo. Familiari ottengono permesso B, con possibilità di richiedere il C dopo 5 anni.',
    taxImplications: 'Tassazione ordinaria svizzera (non imposta alla fonte). Dichiarazione fiscale annuale ordinaria. Possibilità di deduzioni complete.',
    tips: [
      'Il C è il trampolino verso la cittadinanza svizzera (dopo 10 anni di residenza totale)',
      'Con il C non rischi la perdita del permesso in caso di disoccupazione',
      'Mantieni un buon profilo fiscale e sociale per conservare il C',
      'Verifica se il tuo cantone permette il voto comunale con il C',
    ],
  },
  {
    id: 'L',
    name: 'Permesso L',
    fullName: 'Permesso di Soggiorno di Breve Durata',
    color: 'from-purple-500 to-pink-600',
    icon: '🟣',
    duration: 'Max 1 anno (rinnovabile fino a 2 anni)',
    forWhom: 'Lavoratori con contratto inferiore a 12 mesi o stagionali',
    description: 'Il permesso L è per soggiorni lavorativi brevi. Tipicamente usato per contratti a tempo determinato, stage, o lavori stagionali.',
    requirements: [
      'Cittadinanza UE/AELS',
      'Contratto di lavoro di durata inferiore a 12 mesi',
      'Assicurazione malattia (LAMal o equivalente)',
      'Alloggio adeguato',
    ],
    documents: [
      'Passaporto o carta d\'identità valida',
      'Contratto di lavoro (durata < 12 mesi)',
      'Assicurazione malattia',
      'Foto tessera',
      'Formulario di richiesta',
    ],
    processingTime: '1-3 settimane',
    cost: 'CHF 65 (varia per cantone)',
    renewal: 'Rinnovabile se il contratto viene prolungato. Conversione in B possibile se il contratto supera i 12 mesi.',
    rights: [
      'Lavorare in Svizzera per la durata del contratto',
      'Accesso ai servizi sociali proporzionale',
      'Possibilità di conversione in permesso B',
    ],
    limitations: [
      'Durata massima limitata',
      'Legato strettamente al contratto specifico',
      'Ricongiungimento familiare limitato (solo se contratto > 6 mesi)',
      'Meno diritti sociali rispetto al B',
      'Non conta per l\'anzianità verso il permesso C',
    ],
    familyReunion: 'Possibile solo con contratti superiori a 6 mesi. Familiari ricevono un permesso L della stessa durata.',
    taxImplications: 'Imposta alla fonte nel cantone di lavoro. Stesse regole dei frontalieri per i nuovi lavoratori dal 2024.',
    tips: [
      'Se il contratto viene rinnovato oltre 12 mesi, chiedi la conversione in B',
      'Verifica la copertura assicurativa per tutta la durata del soggiorno',
      'Il permesso L non contribuisce ai 5 anni per il permesso C',
      'Ideale per stage, tirocini o primi approcci al mercato svizzero',
    ],
  },
];

const WorkPermitsGuide: React.FC = () => {
  const [selectedPermit, setSelectedPermit] = useState<'G' | 'B' | 'C' | 'L'>('G');
  const [expandedSection, setExpandedSection] = useState<string | null>(null);

  const permit = PERMITS.find(p => p.id === selectedPermit)!;

  const toggleSection = (section: string) => {
    setExpandedSection(expandedSection === section ? null : section);
    Analytics.trackUIInteraction('WorkPermits', 'toggle_section', `${selectedPermit}:${section}`);
  };

  const Section = ({ id, icon: Icon, title, children }: { id: string; icon: any; title: string; children: React.ReactNode }) => {
    const isOpen = expandedSection === id;
    return (
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
        <div
          role="button"
          tabIndex={0}
          onClick={() => toggleSection(id)}
          onKeyDown={(e) => e.key === 'Enter' && toggleSection(id)}
          className="flex items-center justify-between p-4 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-750 transition-colors"
        >
          <div className="flex items-center gap-3">
            <Icon size={20} className="text-slate-500" />
            <h4 className="font-bold text-slate-800 dark:text-slate-100">{title}</h4>
          </div>
          {isOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </div>
        {isOpen && (
          <div className="p-4 pt-0 animate-fade-in border-t border-slate-100 dark:border-slate-700">
            {children}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="bg-gradient-to-br from-cyan-600 via-blue-600 to-indigo-600 rounded-3xl p-8 text-white shadow-2xl">
        <div className="flex items-center gap-4 mb-4">
          <div className="p-3 bg-white/20 rounded-2xl backdrop-blur-sm">
            <Shield size={32} />
          </div>
          <div>
            <h1 className="text-3xl font-extrabold">Permessi di Lavoro in Svizzera</h1>
            <p className="text-cyan-100 mt-1">Guida completa ai permessi G, B, C e L per lavoratori UE</p>
          </div>
        </div>
      </div>

      {/* Permit Selector */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {PERMITS.map(p => (
          <button
            key={p.id}
            onClick={() => {
              setSelectedPermit(p.id);
              setExpandedSection(null);
              Analytics.trackUIInteraction('WorkPermits', 'select_permit', p.id);
            }}
            className={`p-4 rounded-2xl border-2 transition-all text-left ${
              selectedPermit === p.id
                ? `border-transparent bg-gradient-to-br ${p.color} text-white shadow-lg scale-[1.02]`
                : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:border-slate-300 dark:hover:border-slate-600'
            }`}
          >
            <div className="text-2xl mb-1">{p.icon}</div>
            <div className="font-extrabold text-lg">{p.name}</div>
            <div className={`text-xs mt-0.5 ${selectedPermit === p.id ? 'text-white/80' : 'text-slate-500'}`}>{p.fullName}</div>
            <div className={`text-[10px] mt-2 font-bold ${selectedPermit === p.id ? 'text-white/70' : 'text-slate-400'}`}>{p.duration}</div>
          </button>
        ))}
      </div>

      {/* Selected Permit Details */}
      <div className="space-y-3">
        {/* Overview */}
        <div className={`bg-gradient-to-r ${permit.color} rounded-2xl p-6 text-white`}>
          <div className="flex items-center gap-3 mb-3">
            <span className="text-4xl">{permit.icon}</span>
            <div>
              <h2 className="text-2xl font-extrabold">{permit.name} — {permit.fullName}</h2>
              <p className="text-white/80 text-sm mt-1">{permit.forWhom}</p>
            </div>
          </div>
          <p className="text-white/90 text-sm leading-relaxed">{permit.description}</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-4">
            <div className="bg-white/15 rounded-xl p-3">
              <Clock size={14} className="text-white/70 mb-1" />
              <div className="text-xs text-white/70">Durata</div>
              <div className="font-bold text-sm">{permit.duration}</div>
            </div>
            <div className="bg-white/15 rounded-xl p-3">
              <Calendar size={14} className="text-white/70 mb-1" />
              <div className="text-xs text-white/70">Tempistiche</div>
              <div className="font-bold text-sm">{permit.processingTime}</div>
            </div>
            <div className="bg-white/15 rounded-xl p-3">
              <Building2 size={14} className="text-white/70 mb-1" />
              <div className="text-xs text-white/70">Costo</div>
              <div className="font-bold text-sm">{permit.cost}</div>
            </div>
          </div>
        </div>

        {/* Sections */}
        <Section id="requirements" icon={CheckCircle2} title="Requisiti">
          <ul className="space-y-2 mt-2">
            {permit.requirements.map((req, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
                <CheckCircle2 size={16} className="text-emerald-500 flex-shrink-0 mt-0.5" />
                {req}
              </li>
            ))}
          </ul>
        </Section>

        <Section id="documents" icon={FileText} title="Documenti Necessari">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
            {permit.documents.map((doc, i) => (
              <div key={i} className="flex items-center gap-2 p-2.5 bg-slate-50 dark:bg-slate-900 rounded-lg text-sm text-slate-700 dark:text-slate-300">
                <FileText size={14} className="text-blue-500 flex-shrink-0" />
                {doc}
              </div>
            ))}
          </div>
        </Section>

        <Section id="rights" icon={Shield} title="Diritti">
          <ul className="space-y-2 mt-2">
            {permit.rights.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
                <ArrowRight size={14} className="text-emerald-500 flex-shrink-0 mt-1" />
                {r}
              </li>
            ))}
          </ul>
        </Section>

        <Section id="limitations" icon={AlertCircle} title="Limitazioni">
          <ul className="space-y-2 mt-2">
            {permit.limitations.map((l, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
                <AlertCircle size={14} className="text-amber-500 flex-shrink-0 mt-0.5" />
                {l}
              </li>
            ))}
          </ul>
        </Section>

        <Section id="family" icon={Users} title="Ricongiungimento Familiare">
          <p className="text-sm text-slate-700 dark:text-slate-300 mt-2">{permit.familyReunion}</p>
        </Section>

        <Section id="tax" icon={Building2} title="Implicazioni Fiscali">
          <p className="text-sm text-slate-700 dark:text-slate-300 mt-2">{permit.taxImplications}</p>
        </Section>

        <Section id="renewal" icon={Clock} title="Rinnovo & Conversione">
          <p className="text-sm text-slate-700 dark:text-slate-300 mt-2">{permit.renewal}</p>
        </Section>

        <Section id="tips" icon={Info} title="Consigli Pratici">
          <ul className="space-y-2 mt-2">
            {permit.tips.map((tip, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
                <span className="text-base">💡</span>
                {tip}
              </li>
            ))}
          </ul>
        </Section>
      </div>

      {/* Comparison table */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 overflow-x-auto">
        <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100 mb-4 flex items-center gap-2">
          <Globe size={20} className="text-blue-600" />
          Confronto Rapido Permessi
        </h3>
        <table className="w-full text-sm min-w-[600px]">
          <thead>
            <tr className="border-b-2 border-slate-200 dark:border-slate-700">
              <th className="text-left py-3 text-slate-500 font-bold">Caratteristica</th>
              {PERMITS.map(p => (
                <th key={p.id} className="text-center py-3 font-bold">
                  <span className="text-lg">{p.icon}</span>
                  <div className={`text-xs mt-1 ${selectedPermit === p.id ? 'text-blue-600 dark:text-blue-400' : 'text-slate-600 dark:text-slate-400'}`}>{p.name}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-slate-700 dark:text-slate-300">
            {[
              { label: 'Residenza in CH', values: ['❌', '✅', '✅', '✅'] },
              { label: 'Durata', values: ['5 anni', '5 anni', '∞', '≤1 anno'] },
              { label: 'Cambio lavoro', values: ['Limitato', '✅ Libero', '✅ Libero', '❌'] },
              { label: 'Famiglia in CH', values: ['❌', '✅', '✅', 'Limitato'] },
              { label: 'Verso permesso C', values: ['❌', '✅ (5 anni)', '—', '❌'] },
              { label: 'Lavoro autonomo', values: ['Limitato', '✅', '✅', '❌'] },
              { label: '3° pilastro', values: ['❌', '✅', '✅', '❌'] },
            ].map((row, i) => (
              <tr key={i} className="border-b border-slate-100 dark:border-slate-700">
                <td className="py-2.5 font-medium">{row.label}</td>
                {row.values.map((v, j) => (
                  <td key={j} className="text-center py-2.5">{v}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default WorkPermitsGuide;
