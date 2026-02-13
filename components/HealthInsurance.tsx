import React, { useState } from 'react';
import { Heart, Shield, AlertCircle, Info, Euro, CheckCircle2, XCircle } from 'lucide-react';

interface HealthInsuranceProvider {
  name: string;
  type: 'CH-LAMal' | 'IT-SSN' | 'IT-Privata';
  monthlyPremium: number;
  deductible: number; // Franchigia annuale
  coverage: string[];
  pros: string[];
  cons: string[];
  color: string;
  website?: string;
  suitableFor: string;
}

const insuranceProviders: HealthInsuranceProvider[] = [
  // Swiss LAMal
  {
    name: 'Assura',
    type: 'CH-LAMal',
    monthlyPremium: 320,
    deductible: 300,
    coverage: ['Cure base LAMal', 'Ospedale divisione comune', 'Medico generico obbligatorio'],
    pros: ['Premio tra i più bassi', 'Copertura completa LAMal', 'Valida in tutta CH'],
    cons: ['Franchigia 300 CHF/anno', 'No coperture extra', 'Costi alti per Italia'],
    color: 'from-blue-500 to-indigo-600',
    website: 'https://www.assura.ch',
    suitableFor: 'Frontaliere sani che vivono vicino al confine'
  },
  {
    name: 'Sanitas',
    type: 'CH-LAMal',
    monthlyPremium: 380,
    deductible: 300,
    coverage: ['Cure base LAMal', 'Ospedale semi-privato', 'Telemedicina inclusa'],
    pros: ['App moderna', 'Telemedicina 24/7', 'Rete medici ampia'],
    cons: ['Premio più alto', 'Molte prestazioni extra a pagamento'],
    color: 'from-cyan-500 to-blue-600',
    website: 'https://www.sanitas.com',
    suitableFor: 'Chi vuole servizi digitali avanzati'
  },
  {
    name: 'Swica',
    type: 'CH-LAMal',
    monthlyPremium: 340,
    deductible: 500,
    coverage: ['Cure base LAMal', 'Ospedale divisione comune', 'Cure preventive parziali'],
    pros: ['Buon rapporto qualità/prezzo', 'Servizio clienti in italiano', 'Franchigia 500 = premio più basso'],
    cons: ['Franchigia 500 CHF', 'Limitazioni geografiche'],
    color: 'from-teal-500 to-cyan-600',
    website: 'https://www.swica.ch',
    suitableFor: 'Frontaliere che usano poco la sanità'
  },

  // Italian SSN + Privata
  {
    name: 'SSN Italiana (esenzione LAMal)',
    type: 'IT-SSN',
    monthlyPremium: 0,
    deductible: 0,
    coverage: ['Medico di base gratuito', 'Ospedale pubblico gratuito', 'Farmaci con ticket'],
    pros: ['Gratuito', 'Nessuna franchigia', 'Valida in tutta UE'],
    cons: ['Liste attesa lunghe', 'Non valida in CH', 'Ticket su molte prestazioni'],
    color: 'from-green-500 to-emerald-600',
    website: 'https://www.salute.gov.it',
    suitableFor: 'Frontalieri che vivono in Italia e si curano solo lì'
  },
  {
    name: 'UniSalute (privata IT)',
    type: 'IT-Privata',
    monthlyPremium: 80,
    deductible: 100,
    coverage: ['Visite specialistiche', 'Esami diagnostici', 'Odontoiatria parziale'],
    pros: ['Premio basso', 'Nessuna lista attesa', 'Cliniche convenzionate'],
    cons: ['Non copre interventi gravi', 'Massimale annuale limitato', 'Non valida CH'],
    color: 'from-orange-500 to-amber-600',
    website: 'https://www.unisalute.it',
    suitableFor: 'Integrativa SSN per visite rapide'
  },
  {
    name: 'Generali Italia Salute',
    type: 'IT-Privata',
    monthlyPremium: 120,
    deductible: 0,
    coverage: ['Ricovero ospedaliero', 'Chirurgia', 'Visite ed esami senza franchigia'],
    pros: ['Copertura ampia', 'Rimborso rapido', 'Massimali alti'],
    cons: ['Premio medio-alto', 'Esclusioni per patologie pregresse', 'Non valida CH'],
    color: 'from-red-500 to-orange-600',
    website: 'https://www.generali.it/salute',
    suitableFor: 'Chi vuole copertura completa in Italia'
  }
];

const HealthInsurance: React.FC = () => {
  const [age, setAge] = useState<number>(35);
  const [canton, setCanton] = useState<string>('TI');
  const [liveInItaly, setLiveInItaly] = useState<boolean>(true);

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="bg-gradient-to-br from-rose-600 to-pink-700 rounded-2xl p-8 text-white">
        <div className="flex items-center gap-3 mb-4">
          <Heart size={32} />
          <h2 className="text-3xl font-extrabold">Assicurazioni Sanitarie per Frontalieri</h2>
        </div>
        <p className="text-rose-100 text-lg">
          Confronta LAMal svizzera vs SSN italiana + assicurazioni private
        </p>
      </div>

      {/* Important Warning */}
      <div className="bg-red-50 dark:bg-red-950/30 border-l-4 border-red-500 p-4 rounded-lg">
        <div className="flex items-start gap-3">
          <AlertCircle className="text-red-600 flex-shrink-0 mt-0.5" size={20} />
          <div className="text-sm text-red-900 dark:text-red-200">
            <p className="font-bold mb-1">⚠️ Scelta cruciale per frontalieri!</p>
            <p>
              <strong>Frontalieri possono scegliere</strong>: LAMal svizzera (obbligatoria) OPPURE esenzione + SSN italiana.
              La scelta è vincolante per 5 anni e va fatta entro 3 mesi dall'inizio lavoro. Valuta bene prima di decidere!
            </p>
          </div>
        </div>
      </div>

      {/* User Inputs */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
        <div className="grid md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
              Età
            </label>
            <input
              type="number"
              value={age}
              onChange={(e) => setAge(Number(e.target.value))}
              className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"
            />
          </div>

          <div>
            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
              Cantone di lavoro
            </label>
            <select
              value={canton}
              onChange={(e) => setCanton(e.target.value)}
              className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"
            >
              <option value="TI">Ticino</option>
              <option value="GR">Grigioni</option>
              <option value="ZH">Zurigo</option>
              <option value="GE">Ginevra</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
              Residenza
            </label>
            <select
              value={liveInItaly ? 'IT' : 'CH'}
              onChange={(e) => setLiveInItaly(e.target.value === 'IT')}
              className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"
            >
              <option value="IT">Italia</option>
              <option value="CH">Svizzera</option>
            </select>
          </div>
        </div>
      </div>

      {/* Comparison Table */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-700">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-100 dark:bg-slate-900">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-bold text-slate-700 dark:text-slate-300">Caratteristica</th>
                <th className="px-4 py-3 text-center text-sm font-bold text-slate-700 dark:text-slate-300">LAMal CH</th>
                <th className="px-4 py-3 text-center text-sm font-bold text-slate-700 dark:text-slate-300">SSN IT + Privata</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
              <tr>
                <td className="px-4 py-3 text-sm font-bold text-slate-800 dark:text-slate-100">Costo mensile</td>
                <td className="px-4 py-3 text-center text-sm text-slate-700 dark:text-slate-300">320-400 CHF</td>
                <td className="px-4 py-3 text-center text-sm text-slate-700 dark:text-slate-300">0-150 EUR</td>
              </tr>
              <tr>
                <td className="px-4 py-3 text-sm font-bold text-slate-800 dark:text-slate-100">Franchigia annuale</td>
                <td className="px-4 py-3 text-center text-sm text-slate-700 dark:text-slate-300">300-2500 CHF</td>
                <td className="px-4 py-3 text-center text-sm text-slate-700 dark:text-slate-300">0-200 EUR</td>
              </tr>
              <tr>
                <td className="px-4 py-3 text-sm font-bold text-slate-800 dark:text-slate-100">Cure in Svizzera</td>
                <td className="px-4 py-3 text-center"><CheckCircle2 className="inline text-green-600" size={20} /></td>
                <td className="px-4 py-3 text-center"><XCircle className="inline text-red-600" size={20} /></td>
              </tr>
              <tr>
                <td className="px-4 py-3 text-sm font-bold text-slate-800 dark:text-slate-100">Cure in Italia</td>
                <td className="px-4 py-3 text-center text-sm text-amber-600">Parziale</td>
                <td className="px-4 py-3 text-center"><CheckCircle2 className="inline text-green-600" size={20} /></td>
              </tr>
              <tr>
                <td className="px-4 py-3 text-sm font-bold text-slate-800 dark:text-slate-100">Liste d'attesa</td>
                <td className="px-4 py-3 text-center text-sm text-slate-700 dark:text-slate-300">Brevi</td>
                <td className="px-4 py-3 text-center text-sm text-slate-700 dark:text-slate-300">Lunghe (SSN)</td>
              </tr>
              <tr>
                <td className="px-4 py-3 text-sm font-bold text-slate-800 dark:text-slate-100">Libertà scelta medico</td>
                <td className="px-4 py-3 text-center"><CheckCircle2 className="inline text-green-600" size={20} /></td>
                <td className="px-4 py-3 text-center text-sm text-amber-600">Limitata (SSN)</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Insurance Cards */}
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
        {insuranceProviders.map((insurance) => {
          const CardWrapper = insurance.website ? 'a' : 'div';
          const cardProps = insurance.website ? {
            href: insurance.website,
            target: '_blank',
            rel: 'noopener noreferrer',
            className: `block bg-white dark:bg-slate-800 rounded-2xl border-2 p-6 hover:shadow-lg transition-all cursor-pointer border-slate-200 dark:border-slate-700 hover:border-indigo-400`
          } : {
            className: `bg-white dark:bg-slate-800 rounded-2xl border-2 p-6 hover:shadow-lg transition-all border-slate-200 dark:border-slate-700`
          };

          return (
            <CardWrapper key={insurance.name} {...cardProps}>
              <div className="flex items-start justify-between gap-4 mb-4">
                <div className="flex items-center gap-3">
                  <div className={`p-3 bg-gradient-to-br ${insurance.color} rounded-2xl text-white`}>
                    <Shield size={24} />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">{insurance.name}</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {insurance.type === 'CH-LAMal' ? '🇨🇭 LAMal CH' : insurance.type === 'IT-SSN' ? '🇮🇹 SSN' : '🇮🇹 Privata'}
                    </p>
                  </div>
                </div>

                <div className="text-right">
                  <div className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">
                    {insurance.monthlyPremium === 0 ? 'Gratis' : `${insurance.monthlyPremium} ${insurance.type === 'CH-LAMal' ? 'CHF' : '€'}`}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">/mese</div>
                </div>
              </div>

              {insurance.deductible > 0 && (
                <div className="mb-3 p-2 bg-amber-50 dark:bg-amber-950/30 rounded-lg">
                  <p className="text-xs text-amber-800 dark:text-amber-300">
                    <strong>Franchigia:</strong> {insurance.deductible} {insurance.type === 'CH-LAMal' ? 'CHF' : '€'}/anno
                  </p>
                </div>
              )}

              <div className="mb-4">
                <p className="text-xs font-bold text-slate-600 dark:text-slate-400 mb-2">Coperture:</p>
                <ul className="space-y-1">
                  {insurance.coverage.slice(0, 3).map((item, idx) => (
                    <li key={idx} className="text-xs text-slate-700 dark:text-slate-300 flex items-start gap-1">
                      <span className="text-green-600">✓</span> {item}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mb-4 p-3 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg">
                <p className="text-xs font-bold text-emerald-700 dark:text-emerald-400 mb-1">✓ Pro:</p>
                <ul className="space-y-1">
                  {insurance.pros.slice(0, 2).map((pro, idx) => (
                    <li key={idx} className="text-xs text-slate-700 dark:text-slate-300">• {pro}</li>
                  ))}
                </ul>
              </div>

              <div className="mb-4 p-3 bg-red-50 dark:bg-red-950/30 rounded-lg">
                <p className="text-xs font-bold text-red-700 dark:text-red-400 mb-1">✗ Contro:</p>
                <ul className="space-y-1">
                  {insurance.cons.slice(0, 2).map((con, idx) => (
                    <li key={idx} className="text-xs text-slate-700 dark:text-slate-300">• {con}</li>
                  ))}
                </ul>
              </div>

              <div className="pt-3 border-t border-slate-200 dark:border-slate-700">
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  <strong>Adatta per:</strong> {insurance.suitableFor}
                </p>
              </div>
            </CardWrapper>
          );
        })}
      </div>

      {/* Decision Guide */}
      <div className="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 rounded-2xl border border-blue-200 dark:border-blue-800 p-6">
        <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100 mb-4 flex items-center gap-2">
          <Info size={20} className="text-blue-600" />
          Come scegliere?
        </h3>
        
        <div className="grid md:grid-cols-2 gap-4">
          <div className="p-4 bg-white/50 dark:bg-slate-900/50 rounded-xl">
            <p className="font-bold text-blue-600 mb-2">🇨🇭 Scegli LAMal SE:</p>
            <ul className="space-y-1 text-sm text-slate-700 dark:text-slate-300 list-disc ml-4">
              <li>Vivi vicino al confine e usi ospedali CH</li>
              <li>Hai figli piccoli (pediatria CH eccellente)</li>
              <li>Vuoi cure rapide senza liste attesa</li>
              <li>Puoi permetterti 300-400 CHF/mese</li>
            </ul>
          </div>

          <div className="p-4 bg-white/50 dark:bg-slate-900/50 rounded-xl">
            <p className="font-bold text-blue-600 mb-2">🇮🇹 Scegli SSN+Privata SE:</p>
            <ul className="space-y-1 text-sm text-slate-700 dark:text-slate-300 list-disc ml-4">
                <li>Vivi lontano dal confine (&gt;30km)</li>
              <li>Hai già medico di fiducia in Italia</li>
              <li>Sei giovane e in buona salute</li>
              <li>Vuoi risparmiare 200-300€/mese</li>
            </ul>
          </div>
        </div>

        <div className="mt-4 p-4 bg-amber-50 dark:bg-amber-950/50 rounded-xl border border-amber-200 dark:border-amber-800">
          <p className="text-sm text-amber-900 dark:text-amber-200">
            <strong>⚠️ Attenzione:</strong> Con esenzione LAMal NON puoi curarti in Svizzera (tranne emergenze).
            Se vai spesso da medici CH per lavoro, meglio LAMal. Consulta un broker assicurativo prima di decidere!
          </p>
        </div>
      </div>
    </div>
  );
};

export default HealthInsurance;
