import React, { useState, useMemo } from 'react';
import { Heart, Shield, AlertCircle, Info, Euro, CheckCircle2, XCircle } from 'lucide-react';
import { useTranslation } from '@/services/i18n';

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

function getInsuranceProviders(t: (key: string) => string): HealthInsuranceProvider[] {
  return [
    {
      name: 'Assura',
      type: 'CH-LAMal',
      monthlyPremium: 320,
      deductible: 300,
      coverage: [t('health.assura.coverage1'), t('health.assura.coverage2'), t('health.assura.coverage3')],
      pros: [t('health.assura.pro1'), t('health.assura.pro2'), t('health.assura.pro3')],
      cons: [t('health.assura.con1'), t('health.assura.con2'), t('health.assura.con3')],
      color: 'from-blue-500 to-indigo-600',
      website: 'https://www.assura.ch',
      suitableFor: t('health.assura.suitableFor')
    },
    {
      name: 'Sanitas',
      type: 'CH-LAMal',
      monthlyPremium: 380,
      deductible: 300,
      coverage: [t('health.sanitas.coverage1'), t('health.sanitas.coverage2'), t('health.sanitas.coverage3')],
      pros: [t('health.sanitas.pro1'), t('health.sanitas.pro2'), t('health.sanitas.pro3')],
      cons: [t('health.sanitas.con1'), t('health.sanitas.con2')],
      color: 'from-cyan-500 to-blue-600',
      website: 'https://www.sanitas.com',
      suitableFor: t('health.sanitas.suitableFor')
    },
    {
      name: 'Swica',
      type: 'CH-LAMal',
      monthlyPremium: 340,
      deductible: 500,
      coverage: [t('health.swica.coverage1'), t('health.swica.coverage2'), t('health.swica.coverage3')],
      pros: [t('health.swica.pro1'), t('health.swica.pro2'), t('health.swica.pro3')],
      cons: [t('health.swica.con1'), t('health.swica.con2')],
      color: 'from-teal-500 to-cyan-600',
      website: 'https://www.swica.ch',
      suitableFor: t('health.swica.suitableFor')
    },
    {
      name: t('health.ssn.name'),
      type: 'IT-SSN',
      monthlyPremium: 0,
      deductible: 0,
      coverage: [t('health.ssn.coverage1'), t('health.ssn.coverage2'), t('health.ssn.coverage3')],
      pros: [t('health.ssn.pro1'), t('health.ssn.pro2'), t('health.ssn.pro3')],
      cons: [t('health.ssn.con1'), t('health.ssn.con2'), t('health.ssn.con3')],
      color: 'from-green-500 to-emerald-600',
      website: 'https://www.salute.gov.it',
      suitableFor: t('health.ssn.suitableFor')
    },
    {
      name: 'UniSalute',
      type: 'IT-Privata',
      monthlyPremium: 80,
      deductible: 100,
      coverage: [t('health.unisalute.coverage1'), t('health.unisalute.coverage2'), t('health.unisalute.coverage3')],
      pros: [t('health.unisalute.pro1'), t('health.unisalute.pro2'), t('health.unisalute.pro3')],
      cons: [t('health.unisalute.con1'), t('health.unisalute.con2'), t('health.unisalute.con3')],
      color: 'from-orange-500 to-amber-600',
      website: 'https://www.unisalute.it',
      suitableFor: t('health.unisalute.suitableFor')
    },
    {
      name: 'Generali Italia Salute',
      type: 'IT-Privata',
      monthlyPremium: 120,
      deductible: 0,
      coverage: [t('health.generali.coverage1'), t('health.generali.coverage2'), t('health.generali.coverage3')],
      pros: [t('health.generali.pro1'), t('health.generali.pro2'), t('health.generali.pro3')],
      cons: [t('health.generali.con1'), t('health.generali.con2'), t('health.generali.con3')],
      color: 'from-red-500 to-orange-600',
      website: 'https://www.generali.it/salute',
      suitableFor: t('health.generali.suitableFor')
    }
  ];
}

const HealthInsurance: React.FC = () => {
  const { t } = useTranslation();
  const insuranceProviders = useMemo(() => getInsuranceProviders(t), [t]);
  const [age, setAge] = useState<number>(35);
  const [canton, setCanton] = useState<string>('TI');
  const [liveInItaly, setLiveInItaly] = useState<boolean>(true);

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="bg-gradient-to-br from-rose-600 to-pink-700 rounded-2xl p-8 text-white">
        <div className="flex items-center gap-3 mb-4">
          <Heart size={32} />
          <h2 className="text-3xl font-extrabold">{t('health.title')}</h2>
        </div>
        <p className="text-rose-100 text-lg">
          {t('health.subtitle')}
        </p>
      </div>

      {/* Important Warning */}
      <div className="bg-red-50 dark:bg-red-950/30 border-l-4 border-red-500 p-4 rounded-lg">
        <div className="flex items-start gap-3">
          <AlertCircle className="text-red-600 flex-shrink-0 mt-0.5" size={20} />
          <div className="text-sm text-red-900 dark:text-red-200">
            <p className="font-bold mb-1">{t('health.warningTitle')}</p>
            <p dangerouslySetInnerHTML={{ __html: t('health.warningText') }} />
          </div>
        </div>
      </div>

      {/* User Inputs */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
        <div className="grid md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
              {t('health.age')}
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
              {t('health.workCanton')}
            </label>
            <select
              value={canton}
              onChange={(e) => setCanton(e.target.value)}
              className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"
            >
              <option value="TI">{t('health.ticino')}</option>
              <option value="GR">{t('health.grigioni')}</option>
              <option value="ZH">{t('health.zurigo')}</option>
              <option value="GE">{t('health.ginevra')}</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
              {t('health.residence')}
            </label>
            <select
              value={liveInItaly ? 'IT' : 'CH'}
              onChange={(e) => setLiveInItaly(e.target.value === 'IT')}
              className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"
            >
              <option value="IT">{t('health.italy')}</option>
              <option value="CH">{t('health.switzerland')}</option>
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
                <th className="px-4 py-3 text-left text-sm font-bold text-slate-700 dark:text-slate-300">{t('health.feature')}</th>
                <th className="px-4 py-3 text-center text-sm font-bold text-slate-700 dark:text-slate-300">{t('health.lamalCH')}</th>
                <th className="px-4 py-3 text-center text-sm font-bold text-slate-700 dark:text-slate-300">{t('health.ssnPrivata')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
              <tr>
                <td className="px-4 py-3 text-sm font-bold text-slate-800 dark:text-slate-100">{t('health.monthlyCost')}</td>
                <td className="px-4 py-3 text-center text-sm text-slate-700 dark:text-slate-300">320-400 CHF</td>
                <td className="px-4 py-3 text-center text-sm text-slate-700 dark:text-slate-300">0-150 EUR</td>
              </tr>
              <tr>
                <td className="px-4 py-3 text-sm font-bold text-slate-800 dark:text-slate-100">{t('health.annualDeductible')}</td>
                <td className="px-4 py-3 text-center text-sm text-slate-700 dark:text-slate-300">300-2500 CHF</td>
                <td className="px-4 py-3 text-center text-sm text-slate-700 dark:text-slate-300">0-200 EUR</td>
              </tr>
              <tr>
                <td className="px-4 py-3 text-sm font-bold text-slate-800 dark:text-slate-100">{t('health.careSwitzerland')}</td>
                <td className="px-4 py-3 text-center"><CheckCircle2 className="inline text-green-600" size={20} /></td>
                <td className="px-4 py-3 text-center"><XCircle className="inline text-red-600" size={20} /></td>
              </tr>
              <tr>
                <td className="px-4 py-3 text-sm font-bold text-slate-800 dark:text-slate-100">{t('health.careItaly')}</td>
                <td className="px-4 py-3 text-center text-sm text-amber-600">{t('health.partial')}</td>
                <td className="px-4 py-3 text-center"><CheckCircle2 className="inline text-green-600" size={20} /></td>
              </tr>
              <tr>
                <td className="px-4 py-3 text-sm font-bold text-slate-800 dark:text-slate-100">{t('health.waitingLists')}</td>
                <td className="px-4 py-3 text-center text-sm text-slate-700 dark:text-slate-300">{t('health.short')}</td>
                <td className="px-4 py-3 text-center text-sm text-slate-700 dark:text-slate-300">{t('health.longSSN')}</td>
              </tr>
              <tr>
                <td className="px-4 py-3 text-sm font-bold text-slate-800 dark:text-slate-100">{t('health.doctorChoice')}</td>
                <td className="px-4 py-3 text-center"><CheckCircle2 className="inline text-green-600" size={20} /></td>
                <td className="px-4 py-3 text-center text-sm text-amber-600">{t('health.limitedSSN')}</td>
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
                      {insurance.type === 'CH-LAMal' ? '🇨🇭 LAMal CH' : insurance.type === 'IT-SSN' ? `🇮🇹 ${t('health.ssnLabel')}` : `🇮🇹 ${t('health.privateLabel')}`}
                    </p>
                  </div>
                </div>

                <div className="text-right">
                  <div className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">
                    {insurance.monthlyPremium === 0 ? t('health.free') : `${insurance.monthlyPremium} ${insurance.type === 'CH-LAMal' ? 'CHF' : '€'}`}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">/mese</div>
                </div>
              </div>

              {insurance.deductible > 0 && (
                <div className="mb-3 p-2 bg-amber-50 dark:bg-amber-950/30 rounded-lg">
                  <p className="text-xs text-amber-800 dark:text-amber-300">
                    <strong>{t('health.deductible')}:</strong> {insurance.deductible} {insurance.type === 'CH-LAMal' ? 'CHF' : '€'}/{t('health.year')}
                  </p>
                </div>
              )}

              <div className="mb-4">
                <p className="text-xs font-bold text-slate-600 dark:text-slate-400 mb-2">{t('health.coverages')}:</p>
                <ul className="space-y-1">
                  {insurance.coverage.slice(0, 3).map((item, idx) => (
                    <li key={idx} className="text-xs text-slate-700 dark:text-slate-300 flex items-start gap-1">
                      <span className="text-green-600">✓</span> {item}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mb-4 p-3 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg">
                <p className="text-xs font-bold text-emerald-700 dark:text-emerald-400 mb-1">✓ {t('health.pros')}:</p>
                <ul className="space-y-1">
                  {insurance.pros.slice(0, 2).map((pro, idx) => (
                    <li key={idx} className="text-xs text-slate-700 dark:text-slate-300">• {pro}</li>
                  ))}
                </ul>
              </div>

              <div className="mb-4 p-3 bg-red-50 dark:bg-red-950/30 rounded-lg">
                <p className="text-xs font-bold text-red-700 dark:text-red-400 mb-1">✗ {t('health.cons')}:</p>
                <ul className="space-y-1">
                  {insurance.cons.slice(0, 2).map((con, idx) => (
                    <li key={idx} className="text-xs text-slate-700 dark:text-slate-300">• {con}</li>
                  ))}
                </ul>
              </div>

              <div className="pt-3 border-t border-slate-200 dark:border-slate-700">
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  <strong>{t('health.suitableFor')}:</strong> {insurance.suitableFor}
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
          {t('health.howToChoose')}
        </h3>
        
        <div className="grid md:grid-cols-2 gap-4">
          <div className="p-4 bg-white/50 dark:bg-slate-900/50 rounded-xl">
            <p className="font-bold text-blue-600 mb-2">{t('health.chooseLAMalTitle')}</p>
            <ul className="space-y-1 text-sm text-slate-700 dark:text-slate-300 list-disc ml-4">
              <li>{t('health.chooseLAMal1')}</li>
              <li>{t('health.chooseLAMal2')}</li>
              <li>{t('health.chooseLAMal3')}</li>
              <li>{t('health.chooseLAMal4')}</li>
            </ul>
          </div>

          <div className="p-4 bg-white/50 dark:bg-slate-900/50 rounded-xl">
            <p className="font-bold text-blue-600 mb-2">{t('health.chooseSSNTitle')}</p>
            <ul className="space-y-1 text-sm text-slate-700 dark:text-slate-300 list-disc ml-4">
                <li>{t('health.chooseSSN1')}</li>
              <li>{t('health.chooseSSN2')}</li>
              <li>{t('health.chooseSSN3')}</li>
              <li>{t('health.chooseSSN4')}</li>
            </ul>
          </div>
        </div>

        <div className="mt-4 p-4 bg-amber-50 dark:bg-amber-950/50 rounded-xl border border-amber-200 dark:border-amber-800">
          <p className="text-sm text-amber-900 dark:text-amber-200" dangerouslySetInnerHTML={{ __html: t('health.attentionText') }} />
        </div>
      </div>
    </div>
  );
};

export default HealthInsurance;
