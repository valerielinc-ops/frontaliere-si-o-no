import React, { useState } from 'react';
import { Smartphone, Wifi, Phone, MessageSquare, AlertCircle, CheckCircle2, Info, Euro, Globe } from 'lucide-react';

interface MobileOperator {
  name: string;
  logo: string;
  country: 'IT' | 'CH';
  monthlyCost: number;
  dataGB: number | string; // number or "illimitati"
  minutes: number | string;
  sms: number | string;
  roamingInSwitzerland?: {
    included: boolean;
    costPerDay?: number;
    costPerMB?: number;
    costPerMinute?: number;
    dataLimit?: number; // GB included in roaming
    notes: string;
  };
  roamingInItaly?: {
    included: boolean;
    costPerDay?: number;
    costPerMB?: number;
    costPerMinute?: number;
    dataLimit?: number;
    notes: string;
  };
  color: string;
  features: string[];
  setupCost: number;
  contractType: 'prepagato' | 'abbonamento';
  website?: string;
}

const operators: MobileOperator[] = [
  // Italian Operators
  {
    name: 'Iliad',
    logo: '🇮🇹',
    country: 'IT',
    monthlyCost: 9.99,
    dataGB: 250,
    minutes: 'illimitati',
    sms: 'illimitati',
    roamingInSwitzerland: {
      included: true,
      dataLimit: 13,
      notes: 'Roaming UE+Svizzera incluso: 13 GB, minuti/SMS illimitati (fair use)'
    },
    setupCost: 9.99,
    contractType: 'prepagato',
    color: 'from-red-500 to-orange-600',
    features: ['13 GB roaming CH incluso', 'Minuti/SMS illimitati', 'Migliore per frontalieri'],
    website: 'https://www.iliad.it'
  },
  {
    name: 'ho. Mobile',
    logo: '🟢',
    country: 'IT',
    monthlyCost: 9.99,
    dataGB: 200,
    minutes: 'illimitati',
    sms: 'illimitati',
    roamingInSwitzerland: {
      included: false,
      costPerDay: 3.00,
      notes: 'Roaming Extra UE: 3€/giorno per 500MB + 100 min. Svizzera Extra UE'
    },
    setupCost: 0,
    contractType: 'prepagato',
    color: 'from-green-500 to-emerald-600',
    features: ['Rete Vodafone', 'Nessun costo attivazione', 'Roaming CH a pagamento'],
    website: 'https://www.ho-mobile.it'
  },
  {
    name: 'Vodafone',
    logo: '🔴',
    country: 'IT',
    monthlyCost: 9.99,
    dataGB: 100,
    minutes: 'illimitati',
    sms: 200,
    roamingInSwitzerland: {
      included: false,
      costPerDay: 6.00,
      notes: 'Travel World: 6€/giorno per 1GB + min/SMS. Svizzera Extra UE'
    },
    setupCost: 0,
    contractType: 'prepagato',
    color: 'from-red-600 to-rose-700',
    features: ['Rete proprietaria', 'Travel World a pagamento', 'Costoso per frontalieri'],
    website: 'https://www.vodafone.it'
  },
  {
    name: 'TIM',
    logo: '🔵',
    country: 'IT',
    monthlyCost: 14.99,
    dataGB: 100,
    minutes: 'illimitati',
    sms: 'illimitati',
    roamingInSwitzerland: {
      included: false,
      costPerDay: 6.00,
      notes: 'TIM in Viaggio Pass: 6€/giorno per 1GB. Svizzera Extra UE'
    },
    setupCost: 25,
    contractType: 'abbonamento',
    color: 'from-blue-600 to-indigo-700',
    features: ['Rete proprietaria', 'Costi attivazione alti', 'Roaming Extra UE costoso'],
    website: 'https://www.tim.it'
  },
  {
    name: 'WindTre Call Your Country',
    logo: '🟠',
    country: 'IT',
    monthlyCost: 14.99,
    dataGB: 100,
    minutes: 'illimitati',
    sms: 200,
    roamingInSwitzerland: {
      included: true,
      dataLimit: 8,
      notes: 'Call Your Country World: roaming CH incluso con 8 GB, minuti/SMS illimitati'
    },
    setupCost: 10,
    contractType: 'abbonamento',
    color: 'from-orange-600 to-amber-700',
    features: ['8 GB roaming CH incluso', 'Minuti verso CH inclusi', 'Buona opzione frontalieri'],
    website: 'https://www.windtre.it'
  },
  {
    name: 'Very Mobile',
    logo: '🟣',
    country: 'IT',
    monthlyCost: 5.99,
    dataGB: 150,
    minutes: 'illimitati',
    sms: 'illimitati',
    roamingInSwitzerland: {
      included: false,
      costPerMB: 0.50,
      costPerMinute: 2.00,
      notes: 'Nessun roaming incluso. Svizzera Extra UE: 0.50€/MB, 2€/min'
    },
    setupCost: 5,
    contractType: 'prepagato',
    color: 'from-purple-600 to-pink-700',
    features: ['Economico in Italia', 'Rete WindTre', 'Roaming molto costoso'],
    website: 'https://www.verymobile.it'
  },
  {
    name: 'Fastweb Mobile',
    logo: '⚡',
    country: 'IT',
    monthlyCost: 7.95,
    dataGB: 150,
    minutes: 'illimitati',
    sms: 100,
    roamingInSwitzerland: {
      included: true,
      dataLimit: 11,
      notes: 'Roaming Svizzera incluso: 11 GB, minuti/SMS illimitati (fair use policy)'
    },
    setupCost: 10,
    contractType: 'prepagato',
    color: 'from-yellow-600 to-orange-700',
    features: ['11 GB roaming CH incluso', 'Rete WindTre', 'Ottimo rapporto qualità/prezzo'],
    website: 'https://www.fastweb.it/mobile'
  },

  // Swiss Operators
  {
    name: 'Swisscom',
    logo: '🇨🇭',
    country: 'CH',
    monthlyCost: 49.90,
    dataGB: 'illimitati',
    minutes: 'illimitati',
    sms: 'illimitati',
    roamingInItaly: {
      included: true,
      dataLimit: 20,
      notes: 'Roaming UE incluso: 20 GB, minuti/SMS illimitati'
    },
    setupCost: 0,
    contractType: 'abbonamento',
    color: 'from-blue-700 to-indigo-800',
    features: ['Rete migliore CH', 'Roaming UE incluso', 'Molto costoso'],
    website: 'https://www.swisscom.ch'
  },
  {
    name: 'Salt',
    logo: '🧂',
    country: 'CH',
    monthlyCost: 29.95,
    dataGB: 'illimitati',
    minutes: 'illimitati',
    sms: 'illimitati',
    roamingInItaly: {
      included: true,
      dataLimit: 10,
      notes: 'Swiss Unlimited: 10 GB roaming UE incluso'
    },
    setupCost: 49,
    contractType: 'abbonamento',
    color: 'from-pink-600 to-rose-700',
    features: ['Dati illimitati CH', '10 GB roaming UE', 'Buon rapporto qualità/prezzo'],
    website: 'https://www.salt.ch'
  },
  {
    name: 'Sunrise',
    logo: '🌅',
    country: 'CH',
    monthlyCost: 39.90,
    dataGB: 'illimitati',
    minutes: 'illimitati',
    sms: 'illimitati',
    roamingInItaly: {
      included: true,
      dataLimit: 15,
      notes: 'Roaming UE/USA: 15 GB inclusi'
    },
    setupCost: 0,
    contractType: 'abbonamento',
    color: 'from-orange-600 to-red-700',
    features: ['Dati illimitati', '15 GB roaming', 'USA incluso'],
    website: 'https://www.sunrise.ch'
  },
  {
    name: 'Yallo',
    logo: '💛',
    country: 'CH',
    monthlyCost: 19.00,
    dataGB: 25,
    minutes: 'illimitati',
    sms: 'illimitati',
    roamingInItaly: {
      included: false,
      costPerDay: 5.90,
      notes: 'Yallo abroad: 5.90 CHF/giorno per 500MB roaming UE'
    },
    setupCost: 0,
    contractType: 'prepagato',
    color: 'from-yellow-500 to-amber-600',
    features: ['Economico', 'Rete Sunrise', 'Roaming a pagamento'],
    website: 'https://www.yallo.ch'
  },
  {
    name: 'Wingo',
    logo: '🪽',
    country: 'CH',
    monthlyCost: 25.00,
    dataGB: 40,
    minutes: 'illimitati',
    sms: 'illimitati',
    roamingInItaly: {
      included: true,
      dataLimit: 10,
      notes: 'Roaming UE incluso: 10 GB al mese'
    },
    setupCost: 0,
    contractType: 'prepagato',
    color: 'from-cyan-600 to-blue-700',
    features: ['Rete Swisscom', 'Roaming UE incluso', 'Buon prezzo'],
    website: 'https://www.wingo.ch'
  },
  {
    name: 'Aldi Mobile CH',
    logo: '🛒',
    country: 'CH',
    monthlyCost: 17.95,
    dataGB: 15,
    minutes: 'illimitati',
    sms: 'illimitati',
    roamingInItaly: {
      included: false,
      costPerMB: 0.20,
      notes: 'Nessun roaming incluso. 0.20 CHF/MB in UE'
    },
    setupCost: 0,
    contractType: 'prepagato',
    color: 'from-slate-600 to-gray-700',
    features: ['Molto economico', 'Rete Swisscom', 'Roaming costoso'],
    website: 'https://www.aldi-mobile.ch'
  }
];

const MobileOperators: React.FC = () => {
  const [filterCountry, setFilterCountry] = useState<'all' | 'IT' | 'CH'>('all');
  const [sortBy, setSortBy] = useState<'price' | 'roaming'>('roaming');

  const filteredOperators = operators
    .filter(op => filterCountry === 'all' || op.country === filterCountry)
    .sort((a, b) => {
      if (sortBy === 'price') {
        return a.monthlyCost - b.monthlyCost;
      } else {
        // Sort by roaming availability
        const aHasRoaming = a.country === 'IT' ? a.roamingInSwitzerland?.included : a.roamingInItaly?.included;
        const bHasRoaming = b.country === 'IT' ? b.roamingInSwitzerland?.included : b.roamingInItaly?.included;
        if (aHasRoaming && !bHasRoaming) return -1;
        if (!aHasRoaming && bHasRoaming) return 1;
        return a.monthlyCost - b.monthlyCost;
      }
    });

  const bestForFrontierWorkers = operators.filter(op => 
    (op.country === 'IT' && op.roamingInSwitzerland?.included) ||
    (op.country === 'CH' && op.roamingInItaly?.included)
  );

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="bg-gradient-to-br from-indigo-600 to-purple-700 rounded-2xl p-8 text-white">
        <div className="flex items-center gap-3 mb-4">
          <Smartphone size={32} />
          <h2 className="text-3xl font-extrabold">Operatori Telefonici per Frontalieri</h2>
        </div>
        <p className="text-indigo-100 text-lg">
          Confronta gli operatori mobili italiani e svizzeri con i costi di roaming per chi lavora oltre confine
        </p>
      </div>

      {/* Warning Banner */}
      <div className="bg-amber-50 dark:bg-amber-950/30 border-l-4 border-amber-500 p-4 rounded-lg">
        <div className="flex items-start gap-3">
          <AlertCircle className="text-amber-600 flex-shrink-0 mt-0.5" size={20} />
          <div className="text-sm text-amber-900 dark:text-amber-200">
            <p className="font-bold mb-1">⚠️ Attenzione al Roaming!</p>
            <p>
              La Svizzera NON è nell'Unione Europea. Molti operatori italiani applicano tariffe Extra-UE molto costose.
              Verifica sempre le condizioni di roaming prima di sottoscrivere un contratto.
            </p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
        <div className="flex flex-wrap gap-4 items-center">
          <div className="flex items-center gap-2">
            <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Paese:</label>
            <div className="flex gap-2">
              <button
                onClick={() => setFilterCountry('all')}
                className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${
                  filterCountry === 'all' 
                    ? 'bg-indigo-600 text-white' 
                    : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200'
                }`}
              >
                Tutti
              </button>
              <button
                onClick={() => setFilterCountry('IT')}
                className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${
                  filterCountry === 'IT' 
                    ? 'bg-green-600 text-white' 
                    : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200'
                }`}
              >
                🇮🇹 Italia
              </button>
              <button
                onClick={() => setFilterCountry('CH')}
                className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${
                  filterCountry === 'CH' 
                    ? 'bg-red-600 text-white' 
                    : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200'
                }`}
              >
                🇨🇭 Svizzera
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Ordina per:</label>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'price' | 'roaming')}
              className="px-4 py-2 rounded-lg text-sm font-bold bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-600 cursor-pointer"
            >
              <option value="roaming">Roaming incluso</option>
              <option value="price">Prezzo</option>
            </select>
          </div>
        </div>
      </div>

      {/* Best Options Summary */}
      <div className="bg-gradient-to-br from-emerald-50 to-green-50 dark:from-emerald-950/30 dark:to-green-950/30 rounded-2xl border border-emerald-200 dark:border-emerald-800 p-6">
        <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100 mb-4 flex items-center gap-2">
          <CheckCircle2 size={20} className="text-emerald-600" />
          Migliori Opzioni per Frontalieri
        </h3>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="p-4 bg-white/50 dark:bg-slate-900/50 rounded-xl">
            <p className="font-bold text-emerald-700 dark:text-emerald-400 mb-2">🇮🇹 Operatori Italiani con Roaming CH:</p>
            <ul className="space-y-1 text-sm text-slate-700 dark:text-slate-300">
              {bestForFrontierWorkers.filter(op => op.country === 'IT').map(op => (
                <li key={op.name}>
                  <strong>{op.name}</strong> - {op.monthlyCost}€/mese - {op.roamingInSwitzerland?.dataLimit} GB roaming
                </li>
              ))}
            </ul>
          </div>
          <div className="p-4 bg-white/50 dark:bg-slate-900/50 rounded-xl">
            <p className="font-bold text-emerald-700 dark:text-emerald-400 mb-2">🇨🇭 Operatori Svizzeri con Roaming UE:</p>
            <ul className="space-y-1 text-sm text-slate-700 dark:text-slate-300">
              {bestForFrontierWorkers.filter(op => op.country === 'CH').map(op => (
                <li key={op.name}>
                  <strong>{op.name}</strong> - {op.monthlyCost} CHF/mese - {op.roamingInItaly?.dataLimit} GB roaming
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* Operators Grid */}
      <div className="grid md:grid-cols-2 gap-6">
        {filteredOperators.map((operator) => {
          const roaming = operator.country === 'IT' ? operator.roamingInSwitzerland : operator.roamingInItaly;
          const hasGoodRoaming = roaming?.included === true;
          
          const CardWrapper = operator.website ? 'a' : 'div';
          const cardProps = operator.website ? {
            href: operator.website,
            target: '_blank',
            rel: 'noopener noreferrer',
            className: `block bg-white dark:bg-slate-800 rounded-2xl border-2 p-6 hover:shadow-lg transition-all cursor-pointer ${
              hasGoodRoaming 
                ? 'border-emerald-500 ring-2 ring-emerald-500/20 hover:ring-emerald-500/40' 
                : 'border-slate-200 dark:border-slate-700 hover:border-indigo-400'
            }`
          } : {
            className: `bg-white dark:bg-slate-800 rounded-2xl border-2 p-6 hover:shadow-lg transition-all ${
              hasGoodRoaming 
                ? 'border-emerald-500 ring-2 ring-emerald-500/20' 
                : 'border-slate-200 dark:border-slate-700'
            }`
          };

          return (
            <CardWrapper key={operator.name} {...cardProps}>
              {hasGoodRoaming && (
                <div className="mb-3 inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500 text-white text-xs font-bold rounded-full">
                  <CheckCircle2 size={14} />
                  Roaming Incluso
                </div>
              )}

              <div className="flex items-start justify-between gap-4 mb-4">
                <div className="flex items-center gap-3">
                  <div className={`text-4xl p-3 bg-gradient-to-br ${operator.color} rounded-2xl`}>
                    {operator.logo}
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100">{operator.name}</h3>
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      {operator.country === 'IT' ? '🇮🇹 Italia' : '🇨🇭 Svizzera'} • {operator.contractType}
                    </p>
                  </div>
                </div>

                <div className="text-right">
                  <div className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">
                    {operator.country === 'IT' ? '€' : 'CHF'} {operator.monthlyCost.toFixed(2)}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">al mese</div>
                </div>
              </div>

              {/* Plan Details */}
              <div className="grid grid-cols-3 gap-3 mb-4">
                <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-xl text-center">
                  <Wifi className="mx-auto mb-1 text-indigo-600" size={18} />
                  <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">Dati</div>
                  <div className="text-sm font-bold text-slate-800 dark:text-slate-100">
                    {operator.dataGB === 'illimitati' ? '∞' : `${operator.dataGB} GB`}
                  </div>
                </div>

                <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-xl text-center">
                  <Phone className="mx-auto mb-1 text-emerald-600" size={18} />
                  <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">Minuti</div>
                  <div className="text-sm font-bold text-slate-800 dark:text-slate-100">
                    {operator.minutes === 'illimitati' ? '∞' : operator.minutes}
                  </div>
                </div>

                <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-xl text-center">
                  <MessageSquare className="mx-auto mb-1 text-purple-600" size={18} />
                  <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">SMS</div>
                  <div className="text-sm font-bold text-slate-800 dark:text-slate-100">
                    {operator.sms === 'illimitati' ? '∞' : operator.sms}
                  </div>
                </div>
              </div>

              {/* Roaming Details */}
              <div className={`p-4 rounded-xl mb-4 ${
                roaming?.included 
                  ? 'bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800' 
                  : 'bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800'
              }`}>
                <div className="flex items-start gap-2 mb-2">
                  <Globe className={`flex-shrink-0 ${roaming?.included ? 'text-emerald-600' : 'text-red-600'}`} size={18} />
                  <div className="flex-1">
                    <p className={`font-bold text-sm mb-1 ${roaming?.included ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}>
                      Roaming in {operator.country === 'IT' ? 'Svizzera 🇨🇭' : 'Italia 🇮🇹'}
                    </p>
                    <p className="text-xs text-slate-700 dark:text-slate-300">
                      {roaming?.notes}
                    </p>
                    {roaming?.costPerDay && (
                      <p className="text-xs font-bold text-red-600 dark:text-red-400 mt-1">
                        💰 {roaming.costPerDay.toFixed(2)} {operator.country === 'IT' ? '€' : 'CHF'}/giorno
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* Setup Cost */}
              {operator.setupCost > 0 && (
                <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-950/30 rounded-lg border border-amber-200 dark:border-amber-800">
                  <p className="text-xs text-amber-800 dark:text-amber-300">
                    <Euro className="inline" size={14} /> <strong>Costo attivazione:</strong> {operator.setupCost.toFixed(2)} {operator.country === 'IT' ? '€' : 'CHF'}
                  </p>
                </div>
              )}

              {/* Features */}
              <div className="border-t border-slate-200 dark:border-slate-700 pt-3">
                <div className="flex flex-wrap gap-2">
                  {operator.features.map((feature, idx) => (
                    <span
                      key={idx}
                      className="px-2.5 py-1 bg-slate-100 dark:bg-slate-900 text-slate-700 dark:text-slate-300 text-xs font-medium rounded-lg"
                    >
                      {feature}
                    </span>
                  ))}
                </div>
              </div>
            </CardWrapper>
          );
        })}
      </div>

      {/* Educational Section */}
      <div className="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 rounded-2xl border border-blue-200 dark:border-blue-800 p-6">
        <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100 mb-4 flex items-center gap-2">
          <Info size={20} className="text-blue-600" />
          Consigli per Frontalieri
        </h3>
        
        <div className="space-y-4 text-sm text-slate-700 dark:text-slate-300">
          <div className="p-4 bg-white/50 dark:bg-slate-900/50 rounded-xl">
            <p className="font-bold text-blue-600 mb-2">📱 Quale operatore scegliere?</p>
            <ul className="space-y-2 ml-4 list-disc">
              <li><strong>Se vivi in Italia e lavori in Svizzera:</strong> Iliad è la scelta migliore (13 GB roaming incluso a 9.99€/mese)</li>
              <li><strong>Se vivi in Svizzera e lavori in Italia:</strong> Wingo o Salt offrono il miglior rapporto qualità/prezzo</li>
              <li><strong>Evita</strong> operatori senza roaming incluso (ho., Very Mobile, Vodafone) se attraversi il confine quotidianamente</li>
            </ul>
          </div>

          <div className="p-4 bg-white/50 dark:bg-slate-900/50 rounded-xl">
            <p className="font-bold text-blue-600 mb-2">💡 Trucchi e consigli:</p>
            <ul className="space-y-2 ml-4 list-disc">
              <li><strong>Dual SIM:</strong> Molti frontalieri usano 2 SIM (una IT + una CH) per avere sempre la migliore copertura</li>
              <li><strong>WiFi Calling:</strong> Attivalo per usare la rete italiana anche in Svizzera via WiFi (gratis)</li>
              <li><strong>Controlla i GB:</strong> 13 GB roaming possono non bastare se usi molto streaming/mappe</li>
              <li><strong>Attenzione alle chiamate:</strong> Chiamare dalla Svizzera verso Italia può costare anche con roaming incluso</li>
            </ul>
          </div>

          <div className="p-4 bg-amber-50 dark:bg-amber-950/50 rounded-xl border border-amber-200 dark:border-amber-800">
            <p className="font-bold text-amber-700 dark:text-amber-400 mb-2">⚠️ Costi nascosti:</p>
            <ul className="space-y-1 ml-4 list-disc text-amber-900 dark:text-amber-200">
              <li>Roaming "incluso" spesso ha limiti di GB (fair use policy)</li>
              <li>Chiamare verso numeri CH da SIM italiana può costare 1-2€/minuto anche in roaming</li>
              <li>Alcuni operatori limitano il roaming a max 2 mesi consecutivi</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MobileOperators;
